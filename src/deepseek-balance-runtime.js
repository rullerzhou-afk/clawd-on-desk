"use strict";

// Own the opt-in, local DeepSeek prepaid-balance poller and its credential-bound
// fuel gauge. The official balance endpoint supports periodic reads; Kimi's
// experimental usage endpoint remains manual-only under its separate policy.
// initialize/onSettingsChanged admit polling, suspend/resume follow system
// power, and dispose stops requests and timers at application exit.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { isAgentEnabled } = require("./agent-gate");
const { atomicWriteJson, isCredentialId } = require("./quota-credential-store");
const { normalizeDeepseekBalanceResponse, buildBalanceQuota } = require("./deepseek-balance-normalizer");

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_RUNTIME_PATH = path.join(os.homedir(), ".clawd", "deepseek-balance-runtime.json");
const FAILURE_KINDS = new Set([
  "credential-rejected", "payment-required", "rate-limited", "server-error", "timeout", "network-error",
  "malformed-response", "http-error", "response-too-large", "invalid-credential-input", "aborted",
]);

function sanitizeRecord(value) {
  if (!value || value.version !== 1 || !isCredentialId(value.credentialId)) return null;
  const record = {
    version: 1,
    credentialId: value.credentialId,
  };
  const hasBalance = ["CNY", "USD"].includes(value.currency)
    && Number.isFinite(value.baseline) && value.baseline >= 0
    && Number.isFinite(value.lastAmount) && value.lastAmount >= 0
    && Number.isFinite(value.capturedAt);
  if (hasBalance) {
    Object.assign(record, {
      currency: value.currency,
      baseline: Number(value.baseline.toFixed(2)),
      lastAmount: Number(value.lastAmount.toFixed(2)),
      capturedAt: value.capturedAt,
    });
  }
  // The first check can be a 401, before there is any fuel-gauge baseline.
  // Keep that credential's rejection even when no balance has been captured.
  if (value.rejected === true) record.rejected = true;
  return hasBalance || record.rejected === true ? record : null;
}

function createRuntimeStore(options = {}) {
  const fsImpl = options.fs || fs;
  const recordPath = options.recordPath || DEFAULT_RUNTIME_PATH;

  function read() {
    try {
      return sanitizeRecord(JSON.parse(fsImpl.readFileSync(recordPath, "utf8")));
    } catch {
      return null;
    }
  }

  function write(value) {
    const record = sanitizeRecord(value);
    if (!record) {
      try {
        fsImpl.unlinkSync(recordPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      return null;
    }
    atomicWriteJson(recordPath, record, {
      fs: fsImpl,
      randomBytes: options.randomBytes,
    });
    return record;
  }

  return {
    recordPath,
    read,
    write,
  };
}

function createDeepseekBalanceRuntime(options = {}) {
  const {
    credentialStore,
    client,
    getSettingsSnapshot,
    setCollectionEnabled,
    commitLocalDeepseekQuota,
    clearLocalDeepseekQuota,
  } = options;
  const runtimeStore = options.runtimeStore || createRuntimeStore(options.runtimeStoreOptions);
  const now = options.now || Date.now;
  const schedule = options.setTimeout || setTimeout;
  const cancel = options.clearTimeout || clearTimeout;
  let generation = 0;
  let timer = null;
  let active = null;
  let running = false;
  let suspended = false;
  let disposed = false;
  let rejectedCredentialId = null;
  let restartPending = false;
  let transient = {
    state: "idle",
    reason: null,
    lastAttemptAt: null,
  };

  function settingsGate() {
    const snapshot = getSettingsSnapshot() || {};
    if (snapshot.deepseekBalanceCollectionEnabled !== true) return "collection-disabled";
    if (!isAgentEnabled(snapshot, "deepseek-harness")) return "agent-disabled";
    return null;
  }

  function inspect(metadataOnly = false) {
    try {
      return metadataOnly ? credentialStore.inspectMetadata() : credentialStore.inspect();
    } catch {
      return {
        configured: true,
        decryptable: false,
        reason: "credential-unreadable",
      };
    }
  }

  function isCredentialRejected() {
    return rejectedCredentialId !== null && rejectedCredentialId === inspect(true).credentialId;
  }

  function getStatus() {
    const credential = inspect();
    const snapshot = getSettingsSnapshot() || {};
    const credentialRejected = isCredentialRejected();
    let state = transient.state;
    if (state === "credential-rejected" && !credentialRejected) state = "idle";
    if (!credential.configured) state = "unconfigured";
    else if (!credential.decryptable) state = credential.reason || "credential-unreadable";
    else if (snapshot.deepseekBalanceCollectionEnabled !== true) state = "configured-disabled";
    else if (!isAgentEnabled(snapshot, "deepseek-harness")) state = "agent-disabled";
    else if (credentialRejected) state = "credential-rejected";
    else if (suspended) state = "paused";
    else if (state === "idle") state = "ready";
    return {
      status: "ok",
      mode: "periodic",
      configured: credential.configured === true,
      decryptable: credential.decryptable === true,
      collectionEnabled: snapshot.deepseekBalanceCollectionEnabled === true,
      agentEnabled: isAgentEnabled(snapshot, "deepseek-harness"),
      state,
      reason: transient.reason,
      lastAttemptAt: transient.lastAttemptAt,
      lastQuotaCapturedAt: runtimeStore.read()?.capturedAt ?? null,
    };
  }

  function notifyStatusChanged() {
    // The main-process consumer checks for a live Settings window before
    // calling getStatus, so background work cannot prompt a hidden vault read.
    if (typeof options.onStatusChanged === "function") {
      try {
        options.onStatusChanged();
      } catch {}
    }
  }

  function setTransient(value) {
    transient = value;
    notifyStatusChanged();
  }

  function failure(reason) {
    setTransient({
      ...transient,
      state: reason,
      reason,
    });
    return {
      status: "error",
      reason,
    };
  }

  function stop() {
    running = false;
    restartPending = false;
    generation++;
    if (timer !== null) cancel(timer);
    timer = null;
    // Keep the slot occupied until settlement even if a transport ignores
    // abort. The generation fences its result; the slot prevents overlap.
    active?.controller.abort();
  }

  function clearQuota() {
    const cleared = clearLocalDeepseekQuota();
    return cleared?.persisted === true ? { status: "ok" } : failure("quota-persistence-failed");
  }

  function resetRecord() {
    try {
      runtimeStore.write(null);
      return { status: "ok" };
    } catch {
      return failure("runtime-persistence-failed");
    }
  }

  function clearRejection() {
    const record = runtimeStore.read();
    if (record?.rejected === true) {
      const { rejected: _rejected, ...binding } = record;
      try {
        runtimeStore.write(sanitizeRecord(binding));
      } catch {
        return failure("runtime-persistence-failed");
      }
    }
    rejectedCredentialId = null;
    return { status: "ok" };
  }

  function rejectCredential(credentialId) {
    rejectedCredentialId = credentialId;
    stop();
    const previous = runtimeStore.read();
    const record = previous?.credentialId === credentialId ? previous : {
      version: 1,
      credentialId,
    };
    try {
      runtimeStore.write({
        ...record,
        rejected: true,
      });
    } catch {
      return failure("runtime-persistence-failed");
    }
    return failure("credential-rejected");
  }

  function armTimer() {
    if (!running || timer !== null) return;
    timer = schedule(() => {
      timer = null;
      void refresh();
      armTimer();
    }, POLL_INTERVAL_MS);
  }

  function responseIsCurrent(token, credentialId) {
    if (token !== generation || disposed || suspended || settingsGate()) return false;
    // Another process or a manual file replacement can change credentials
    // without passing through this owner's generation fence.
    return inspect(true).credentialId === credentialId;
  }

  async function fetchAndCommit(credential, controller, token) {
    setTransient({
      state: "refreshing",
      reason: null,
      lastAttemptAt: now(),
    });
    let result;
    try {
      result = await client.fetchBalance(credential.apiKey, { signal: controller.signal });
    } catch {
      result = { kind: "network-error" };
    }
    if (!responseIsCurrent(token, credential.credentialId)) {
      return {
        status: "error",
        reason: "superseded",
      };
    }
    if (result?.kind !== "success") {
      if (result?.kind === "credential-rejected") return rejectCredential(credential.credentialId);
      return failure(FAILURE_KINDS.has(result?.kind) ? result.kind : "network-error");
    }
    let balance;
    try {
      balance = normalizeDeepseekBalanceResponse(result.value);
    } catch {
      return failure("malformed-response");
    }
    const capturedAt = now();
    const { quota, record } = buildBalanceQuota(balance, runtimeStore.read(), credential.credentialId, capturedAt);
    const committed = commitLocalDeepseekQuota(quota);
    if (!committed?.accepted || committed.persisted !== true) {
      clearQuota();
      return failure("quota-persistence-failed");
    }
    try {
      runtimeStore.write(record);
    } catch {
      // A successful account-store write is not bound to this credential
      // until its journal reaches disk. Remove it on journal failure.
      clearQuota();
      return failure("runtime-persistence-failed");
    }
    setTransient({
      state: "fresh",
      reason: null,
      lastAttemptAt: capturedAt,
    });
    return {
      status: "ok",
      refreshed: true,
      capturedAt,
    };
  }

  function refresh() {
    if (disposed || suspended) {
      return Promise.resolve({
        status: "error",
        reason: "paused",
      });
    }
    const gate = settingsGate();
    if (gate) {
      stop();
      clearQuota();
      notifyStatusChanged();
      return Promise.resolve({
        status: "error",
        reason: gate,
      });
    }
    const metadata = inspect(true);
    const record = runtimeStore.read();
    if (record?.credentialId === metadata.credentialId && record?.rejected === true) {
      rejectedCredentialId = metadata.credentialId;
    }
    if (isCredentialRejected()) {
      stop();
      return Promise.resolve(failure("credential-rejected"));
    }
    if (active) {
      return Promise.resolve({
        status: "ok",
        refreshed: false,
        reason: "in-flight",
      });
    }
    let credential;
    try {
      credential = credentialStore.load();
    } catch {
      return Promise.resolve(failure("credential-unreadable"));
    }
    if (!credential) {
      stop();
      clearQuota();
      return Promise.resolve(failure("credential-missing"));
    }
    const controller = new AbortController();
    const token = generation;
    const request = {
      controller,
      generation: token,
    };
    active = request;
    request.promise = fetchAndCommit(credential, controller, token).finally(() => {
      if (active === request) active = null;
      if (restartPending && running) {
        restartPending = false;
        void refresh();
      }
    });
    return request.promise;
  }

  function start() {
    if (running || disposed || suspended || isCredentialRejected()) return;
    running = true;
    armTimer();
    if (active) restartPending = true;
    else void refresh();
  }

  function onSettingsChanged() {
    if (disposed) return { status: "ok" };
    if (settingsGate() || !inspect(true).configured) {
      stop();
      const result = clearQuota();
      notifyStatusChanged();
      return result;
    }
    start();
    notifyStatusChanged();
    return { status: "ok" };
  }

  async function initialize() {
    stop();
    const credential = inspect(true);
    const record = runtimeStore.read();
    const sameCredential = !!record && record.credentialId === credential.credentialId;
    rejectedCredentialId = sameCredential && record.rejected === true ? credential.credentialId : null;
    // A crash after saving a new credential but before clearing the old
    // journal must not attribute the old account's balance to the new key.
    if (!sameCredential) {
      const cleared = clearQuota();
      if (cleared.status !== "ok") return cleared;
      // A never-configured installation has no journal to clear or create.
      if (record) {
        const reset = resetRecord();
        if (reset.status !== "ok") return reset;
      }
    }
    if (isCredentialRejected()) {
      setTransient({
        state: "credential-rejected",
        reason: "credential-rejected",
        lastAttemptAt: null,
      });
    }
    return onSettingsChanged();
  }

  async function enableAndStart(token) {
    let result;
    try {
      result = await setCollectionEnabled(true);
    } catch {}
    if (disposed || (token !== generation
        && getSettingsSnapshot()?.deepseekBalanceCollectionEnabled !== true)) {
      return {
        status: "error",
        reason: "superseded",
      };
    }
    if (result?.status !== "ok") return failure("enable-failed");
    if (settingsGate()) {
      notifyStatusChanged();
      return {
        status: "ok",
        refreshed: false,
        reason: settingsGate(),
      };
    }
    start();
    // Lifecycle stops remain synchronous while explicit Settings actions wait
    // for their own first check. A new card can also read or receive its state.
    const firstCheck = active?.generation === generation ? active.promise : null;
    return firstCheck || {
      status: "ok",
      configured: true,
      refreshed: false,
    };
  }

  async function connect(apiKey) {
    if (disposed) {
      return {
        status: "error",
        reason: "paused",
      };
    }
    const wasRunning = running;
    stop();
    try {
      credentialStore.save(apiKey);
    } catch (error) {
      if (wasRunning) start();
      return failure(error?.code === "DEEPSEEK_BALANCE_STORAGE_UNAVAILABLE"
        ? "secure-storage-unavailable" : "credential-save-failed");
    }
    const cleared = clearQuota();
    if (cleared.status !== "ok") return cleared;
    const reset = resetRecord();
    if (reset.status !== "ok") return reset;
    rejectedCredentialId = null;
    setTransient({
      state: "idle",
      reason: null,
      lastAttemptAt: null,
    });
    return enableAndStart(generation);
  }

  async function reconnect() {
    if (disposed) {
      return {
        status: "error",
        reason: "paused",
      };
    }
    if (!inspect(true).configured) return failure("credential-missing");
    stop();
    const result = clearRejection();
    if (result.status !== "ok") return result;
    return enableAndStart(generation);
  }

  async function disconnect() {
    stop();
    const token = generation;
    let result;
    try {
      result = await setCollectionEnabled(false);
    } catch {}
    if (token !== generation && getSettingsSnapshot()?.deepseekBalanceCollectionEnabled === true) {
      return {
        status: "error",
        reason: "superseded",
      };
    }
    if (result?.status !== "ok") return failure("disable-failed");
    const cleared = clearQuota();
    notifyStatusChanged();
    return cleared;
  }

  async function forget() {
    if (getSettingsSnapshot()?.deepseekBalanceCollectionEnabled === true) {
      return {
        status: "error",
        reason: "disconnect-required",
      };
    }
    stop();
    const cleared = clearQuota();
    if (cleared.status !== "ok") return cleared;
    const reset = resetRecord();
    if (reset.status !== "ok") return reset;
    try {
      credentialStore.forget();
    } catch {
      return failure("credential-delete-failed");
    }
    rejectedCredentialId = null;
    setTransient({
      state: "idle",
      reason: null,
      lastAttemptAt: null,
    });
    return {
      status: "ok",
      configured: false,
      remoteRevocationRequired: true,
    };
  }

  function suspend() {
    suspended = true;
    stop();
    notifyStatusChanged();
  }

  function resume() {
    suspended = false;
    return onSettingsChanged();
  }

  function dispose() {
    disposed = true;
    stop();
    notifyStatusChanged();
  }

  return {
    initialize,
    connect,
    reconnect,
    disconnect,
    forget,
    refresh,
    getStatus,
    onSettingsChanged,
    suspend,
    resume,
    dispose,
  };
}

module.exports = {
  DEFAULT_RUNTIME_PATH,
  POLL_INTERVAL_MS,
  createRuntimeStore,
  createDeepseekBalanceRuntime,
  sanitizeRecord,
};
