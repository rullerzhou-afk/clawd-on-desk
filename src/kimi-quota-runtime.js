"use strict";

// Manual-only Kimi quota owner. Network admission and response commit both
// re-read canonical settings; no hook, app lifecycle, Dashboard visibility or
// timer may call refresh(). A future periodic mode requires an upstream policy
// approval and is intentionally absent from this module.

const fs = require("fs");
const os = require("os");
const path = require("path");

const { isAgentEnabled } = require("./agent-gate");
const { normalizeKimiQuotaResponse, KimiQuotaSchemaError } = require("./kimi-quota-normalizer");
const { atomicWriteJson, isCredentialId } = require("./kimi-quota-credential-store");

const RUNTIME_VERSION = 1;
const DEFAULT_RUNTIME_PATH = path.join(os.homedir(), ".clawd", "kimi-quota-runtime.json");

function emptyBinding() {
  return {
    version: RUNTIME_VERSION,
    lastQuotaCredentialId: null,
    lastQuotaCapturedAt: null,
  };
}

function sanitizeBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== RUNTIME_VERSION) {
    return emptyBinding();
  }
  return {
    version: RUNTIME_VERSION,
    lastQuotaCredentialId: isCredentialId(value.lastQuotaCredentialId)
      ? value.lastQuotaCredentialId
      : null,
    lastQuotaCapturedAt: Number.isFinite(value.lastQuotaCapturedAt)
      ? value.lastQuotaCapturedAt
      : null,
  };
}

function createBindingStore(options = {}) {
  const fsImpl = options.fs || fs;
  const recordPath = options.recordPath || DEFAULT_RUNTIME_PATH;
  const randomBytes = options.randomBytes;

  function read() {
    try {
      return sanitizeBinding(JSON.parse(fsImpl.readFileSync(recordPath, "utf8")));
    } catch {
      return emptyBinding();
    }
  }

  function write(value) {
    const record = sanitizeBinding({ version: RUNTIME_VERSION, ...value });
    atomicWriteJson(recordPath, record, { fs: fsImpl, randomBytes });
    return record;
  }

  return { read, write, recordPath };
}

function publicFailure(result) {
  const kind = result && typeof result.kind === "string" ? result.kind : "unknown-error";
  const out = { status: "error", reason: kind };
  if (Number.isFinite(result && result.statusCode)) out.statusCode = result.statusCode;
  if (result && result.retryAfter && Number.isFinite(result.retryAfter.retryAt)) {
    out.retryAt = result.retryAfter.retryAt;
  }
  return out;
}

function createKimiQuotaRuntime(options = {}) {
  const credentialStore = options.credentialStore;
  const client = options.client;
  const bindingStore = options.bindingStore || createBindingStore(options.bindingStoreOptions);
  const getSettingsSnapshot = options.getSettingsSnapshot;
  const setCollectionEnabled = options.setCollectionEnabled;
  const commitLocalKimiQuota = options.commitLocalKimiQuota;
  const clearLocalKimiQuota = options.clearLocalKimiQuota;
  const now = typeof options.now === "function" ? options.now : Date.now;

  for (const [name, value] of Object.entries({
    credentialStore,
    client,
    getSettingsSnapshot,
    setCollectionEnabled,
    commitLocalKimiQuota,
    clearLocalKimiQuota,
  })) {
    if (!value || (name !== "credentialStore" && name !== "client" && typeof value !== "function")) {
      throw new TypeError(`createKimiQuotaRuntime requires ${name}`);
    }
  }

  let generation = 0;
  let activeController = null;
  let transient = { state: "idle", reason: null, lastAttemptAt: null };
  let operation = Promise.resolve();

  function settingsGate() {
    const snapshot = getSettingsSnapshot() || {};
    if (snapshot.kimiQuotaCollectionEnabled !== true) {
      return { ok: false, reason: "collection-disabled", snapshot };
    }
    if (!isAgentEnabled(snapshot, "kimi-cli")) {
      return { ok: false, reason: "agent-disabled", snapshot };
    }
    return { ok: true, snapshot };
  }

  function invalidateRequests() {
    generation += 1;
    if (activeController) {
      try { activeController.abort(); } catch {}
      activeController = null;
    }
    return generation;
  }

  function queue(task) {
    const run = () => task();
    const next = operation.then(run, run);
    operation = next.catch(() => {});
    return next;
  }

  function inspectCredential() {
    try {
      return credentialStore.inspect();
    } catch {
      return { configured: true, decryptable: false, reason: "credential-unreadable" };
    }
  }

  function getStatus() {
    const gate = settingsGate();
    const credential = inspectCredential();
    const binding = bindingStore.read();
    let state = transient.state;
    if (!credential.configured) state = "unconfigured";
    else if (!credential.decryptable) state = credential.reason || "credential-unreadable";
    else if (gate.reason === "collection-disabled") state = "configured-disabled";
    else if (gate.reason === "agent-disabled") state = "agent-disabled";
    else if (state === "idle") state = "ready";
    return {
      status: "ok",
      mode: "manual-only",
      configured: credential.configured === true,
      decryptable: credential.decryptable === true,
      collectionEnabled: gate.snapshot && gate.snapshot.kimiQuotaCollectionEnabled === true,
      agentEnabled: isAgentEnabled(gate.snapshot, "kimi-cli"),
      state,
      reason: transient.reason,
      lastAttemptAt: transient.lastAttemptAt,
      lastQuotaCapturedAt: binding.lastQuotaCapturedAt,
    };
  }

  function writeUnbound() {
    return bindingStore.write(emptyBinding());
  }

  function clearQuotaAndBinding() {
    const cleared = clearLocalKimiQuota();
    if (!cleared || cleared.persisted !== true) {
      transient = { ...transient, state: "persistence-error", reason: "quota-clear-failed" };
      return { status: "error", reason: "quota-persistence-failed" };
    }
    try {
      writeUnbound();
    } catch {
      transient = { ...transient, state: "persistence-error", reason: "binding-clear-failed" };
      return { status: "error", reason: "runtime-persistence-failed" };
    }
    return { status: "ok" };
  }

  function normalizeSuccess(result, capturedAt) {
    if (!result || result.kind !== "success") return publicFailure(result);
    try {
      return {
        status: "ok",
        quota: normalizeKimiQuotaResponse(result.value, { capturedAt }),
      };
    } catch (error) {
      if (error instanceof KimiQuotaSchemaError) {
        return { status: "error", reason: "malformed-response" };
      }
      return { status: "error", reason: "normalization-failed" };
    }
  }

  function responseFence(expectedGeneration, credentialId) {
    if (expectedGeneration !== generation) return { ok: false, reason: "superseded" };
    const gate = settingsGate();
    if (!gate.ok) return gate;
    let current;
    try { current = credentialStore.load(); } catch { return { ok: false, reason: "credential-unreadable" }; }
    if (!current || current.credentialId !== credentialId) {
      return { ok: false, reason: "credential-changed" };
    }
    return { ok: true };
  }

  function commitBoundQuota(quota, credentialId, expectedGeneration, capturedAt) {
    const fence = responseFence(expectedGeneration, credentialId);
    if (!fence.ok) return { status: "error", reason: fence.reason };
    const committed = commitLocalKimiQuota(quota);
    if (!committed || committed.accepted !== true || committed.persisted !== true) {
      clearLocalKimiQuota();
      transient = { ...transient, state: "persistence-error", reason: "quota-write-failed" };
      return { status: "error", reason: "quota-persistence-failed" };
    }
    try {
      bindingStore.write({
        version: RUNTIME_VERSION,
        lastQuotaCredentialId: credentialId,
        lastQuotaCapturedAt: capturedAt,
      });
    } catch {
      // An unbound durable quota must never survive a restart and impersonate
      // whichever key happens to be configured then.
      clearLocalKimiQuota();
      transient = { ...transient, state: "persistence-error", reason: "binding-write-failed" };
      return { status: "error", reason: "runtime-persistence-failed" };
    }
    transient = { state: "fresh", reason: null, lastAttemptAt: capturedAt };
    return { status: "ok", refreshed: true, capturedAt };
  }

  async function fetchAndNormalize(apiKey, signal) {
    const response = await client.fetchUsage(apiKey, { signal });
    const capturedAt = now();
    return { capturedAt, normalized: normalizeSuccess(response, capturedAt) };
  }

  function initialize() {
    return queue(async () => {
      invalidateRequests();
      const gate = settingsGate();
      const credential = inspectCredential();
      const binding = bindingStore.read();
      const mismatched = binding.lastQuotaCredentialId !== null
        && (!credential.configured
          || !credential.decryptable
          || binding.lastQuotaCredentialId !== credential.credentialId);
      if (!gate.ok || mismatched || (binding.lastQuotaCredentialId === null && credential.configured)) {
        const cleared = clearQuotaAndBinding();
        if (cleared.status !== "ok") return cleared;
      }
      transient = { state: "idle", reason: null, lastAttemptAt: null };
      return getStatus();
    });
  }

  // The shared manual-refresh path, always inside queue(). Both refresh() and
  // reconnect() land here, so every network admission re-reads the durable
  // gates (collection opt-in, agent enabled, credential present).
  async function refreshLocked() {
    const gate = settingsGate();
    if (!gate.ok) return { status: "error", reason: gate.reason };
    let credential;
    try { credential = credentialStore.load(); } catch { return { status: "error", reason: "credential-unreadable" }; }
    if (!credential) return { status: "error", reason: "credential-missing" };
    const expectedGeneration = invalidateRequests();
    const controller = new AbortController();
    activeController = controller;
    transient = { state: "refreshing", reason: null, lastAttemptAt: now() };
    const { capturedAt, normalized } = await fetchAndNormalize(credential.apiKey, controller.signal);
    if (activeController === controller) activeController = null;
    if (normalized.status !== "ok") {
      transient = { state: normalized.reason, reason: normalized.reason, lastAttemptAt: capturedAt };
      return normalized;
    }
    return commitBoundQuota(normalized.quota, credential.credentialId, expectedGeneration, capturedAt);
  }

  function refresh() {
    return queue(refreshLocked);
  }

  // Reconnect a "configured-disabled" connection with the stored credential:
  // enable collection, then immediately refresh. An explicit user action —
  // the same manual-only class as Connect/Replace/Refresh — and the key never
  // leaves the main process.
  function reconnect() {
    return queue(async () => {
      let credential;
      try { credential = credentialStore.load(); } catch { return { status: "error", reason: "credential-unreadable" }; }
      if (!credential) return { status: "error", reason: "credential-missing" };
      let enabledResult;
      try { enabledResult = await setCollectionEnabled(true); }
      catch { enabledResult = { status: "error" }; }
      if (!enabledResult || enabledResult.status !== "ok") {
        return { status: "error", reason: "enable-failed" };
      }
      // Mirror connect()'s post-enable behavior: a closed gate (e.g. the Kimi
      // agent itself is disabled) is a configured, recoverable state, not an
      // error — the status line says what is missing.
      const gate = settingsGate();
      if (!gate.ok) {
        transient = { state: gate.reason, reason: gate.reason, lastAttemptAt: transient.lastAttemptAt };
        return { status: "ok", configured: true, refreshed: false, reason: gate.reason };
      }
      return refreshLocked();
    });
  }

  function connect(apiKey) {
    return queue(async () => {
      const candidateController = new AbortController();
      const { capturedAt, normalized } = await fetchAndNormalize(apiKey, candidateController.signal);
      if (normalized.status !== "ok") {
        transient = { state: normalized.reason, reason: normalized.reason, lastAttemptAt: capturedAt };
        return normalized;
      }

      // Candidate validation happens before the old generation is invalidated.
      // A bad replacement therefore leaves both the old key and its quota live.
      const expectedGeneration = invalidateRequests();
      let saved;
      try {
        saved = credentialStore.save(apiKey);
      } catch (error) {
        transient = {
          state: error && error.code === "KIMI_QUOTA_STORAGE_UNAVAILABLE"
            ? "secure-storage-unavailable"
            : "credential-save-failed",
          reason: "credential-save-failed",
          lastAttemptAt: capturedAt,
        };
        return { status: "error", reason: transient.state };
      }
      const cleared = clearQuotaAndBinding();
      if (cleared.status !== "ok") return cleared;

      let enabledResult;
      try { enabledResult = await setCollectionEnabled(true); }
      catch { enabledResult = { status: "error" }; }
      if (!enabledResult || enabledResult.status !== "ok") {
        transient = { state: "configured-disabled", reason: "enable-failed", lastAttemptAt: capturedAt };
        return { status: "error", reason: "enable-failed", configured: true };
      }

      const gate = settingsGate();
      if (!gate.ok) {
        transient = { state: gate.reason, reason: gate.reason, lastAttemptAt: capturedAt };
        return { status: "ok", configured: true, refreshed: false, reason: gate.reason };
      }
      const committed = commitBoundQuota(
        normalized.quota,
        saved.credentialId,
        expectedGeneration,
        capturedAt
      );
      return committed.status === "ok"
        ? { ...committed, configured: true, replaced: saved.replaced }
        : committed;
    });
  }

  function disconnect() {
    return queue(async () => {
      invalidateRequests();
      let disabled;
      try { disabled = await setCollectionEnabled(false); }
      catch { disabled = { status: "error" }; }
      if (!disabled || disabled.status !== "ok") return { status: "error", reason: "disable-failed" };
      const cleared = clearQuotaAndBinding();
      if (cleared.status !== "ok") return cleared;
      transient = { state: "configured-disabled", reason: null, lastAttemptAt: transient.lastAttemptAt };
      return { status: "ok", configured: inspectCredential().configured === true };
    });
  }

  function forget() {
    return queue(async () => {
      const snapshot = getSettingsSnapshot() || {};
      if (snapshot.kimiQuotaCollectionEnabled === true) {
        return { status: "error", reason: "disconnect-required" };
      }
      invalidateRequests();
      const cleared = clearQuotaAndBinding();
      if (cleared.status !== "ok") return cleared;
      try {
        credentialStore.forget();
      } catch {
        return { status: "error", reason: "credential-delete-failed" };
      }
      transient = { state: "unconfigured", reason: null, lastAttemptAt: null };
      return { status: "ok", configured: false, remoteRevocationRequired: true };
    });
  }

  function onCollectionPreferenceChanged(enabled) {
    if (enabled === true) return Promise.resolve(getStatus());
    return queue(async () => {
      invalidateRequests();
      const cleared = clearQuotaAndBinding();
      if (cleared.status !== "ok") return cleared;
      transient = { state: inspectCredential().configured ? "configured-disabled" : "unconfigured", reason: null, lastAttemptAt: transient.lastAttemptAt };
      return getStatus();
    });
  }

  return {
    connect,
    disconnect,
    forget,
    getStatus,
    initialize,
    invalidateRequests,
    onCollectionPreferenceChanged,
    reconnect,
    refresh,
  };
}

module.exports = {
  DEFAULT_RUNTIME_PATH,
  RUNTIME_VERSION,
  createBindingStore,
  createKimiQuotaRuntime,
  emptyBinding,
  sanitizeBinding,
};
