"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createKimiQuotaRuntime, emptyBinding } = require("../src/kimi-quota-runtime");

const ID_A = "123e4567-e89b-42d3-a456-426614174000";
const ID_B = "123e4567-e89b-42d3-a456-426614174001";

function response(remaining = "90") {
  return {
    kind: "success",
    value: {
      usage: { remaining, limit: "100", resetTime: "2026-08-21T01:20:19.901916Z" },
      limits: [{
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { remaining, limit: "100", resetTime: "2026-08-14T16:20:19.901916Z" },
      }],
    },
  };
}

function harness(options = {}) {
  let settings = {
    kimiQuotaCollectionEnabled: options.enabled === true,
    agents: { "kimi-cli": { enabled: options.agentEnabled !== false } },
  };
  let credential = options.credential || null;
  let binding = options.binding || emptyBinding();
  const commits = [];
  let clears = 0;
  let nextId = credential && credential.credentialId === ID_A ? ID_B : ID_A;
  const credentialStore = {
    inspectMetadata: () => credential
      ? { configured: true, credentialId: credential.credentialId }
      : { configured: false },
    inspect: () => credential
      ? { configured: true, decryptable: true, credentialId: credential.credentialId }
      : { configured: false, decryptable: false },
    load: () => credential && { ...credential },
    save: (apiKey) => {
      const replaced = Boolean(credential);
      credential = { apiKey, credentialId: nextId };
      return { credentialId: nextId, replaced };
    },
    forget: () => { const had = Boolean(credential); credential = null; return had; },
  };
  const bindingStore = {
    read: () => ({ ...binding }),
    write: (value) => {
      if (options.bindingWriteFails) throw new Error("disk full");
      binding = { ...value };
      return binding;
    },
  };
  const client = options.client || { fetchUsage: async () => response() };
  const runtime = createKimiQuotaRuntime({
    credentialStore,
    bindingStore,
    client,
    getSettingsSnapshot: () => settings,
    setCollectionEnabled: async (enabled) => {
      if (options.enableFails) return { status: "error" };
      settings = { ...settings, kimiQuotaCollectionEnabled: enabled };
      return { status: "ok" };
    },
    commitLocalKimiQuota: (quota) => {
      commits.push(quota);
      return options.commitFails
        ? { accepted: true, persisted: false }
        : { accepted: true, persisted: true };
    },
    clearLocalKimiQuota: () => {
      clears += 1;
      return { cleared: true, persisted: options.clearFails !== true };
    },
    now: () => 1_786_708_953_953,
  });
  return {
    runtime,
    commits,
    get clears() { return clears; },
    get credential() { return credential; },
    get binding() { return binding; },
    setSettings(next) { settings = { ...settings, ...next }; },
  };
}

test("explicit Connect validates, encrypts, enables, commits and binds quota", async () => {
  const h = harness();
  const result = await h.runtime.connect("sk-new");
  assert.equal(result.status, "ok");
  assert.equal(result.refreshed, true);
  assert.equal(h.credential.apiKey, "sk-new");
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0].kimiFiveHour.usedPercent, 10);
  assert.equal(h.binding.lastQuotaCredentialId, ID_A);
  assert.equal(h.runtime.getStatus().collectionEnabled, true);
});

test("a rejected replacement leaves the old key and quota binding untouched", async () => {
  const h = harness({
    enabled: true,
    credential: { apiKey: "sk-old", credentialId: ID_A },
    binding: { version: 1, lastQuotaCredentialId: ID_A, lastQuotaCapturedAt: 100 },
    client: { fetchUsage: async () => ({ kind: "usage-credential-rejected", statusCode: 401 }) },
  });
  const result = await h.runtime.connect("sk-bad");
  assert.equal(result.status, "error");
  assert.equal(result.reason, "usage-credential-rejected");
  assert.equal(h.credential.apiKey, "sk-old");
  assert.equal(h.clears, 0);
  assert.equal(h.binding.lastQuotaCredentialId, ID_A);
});

test("startup clears persisted quota when credentialId does not match", async () => {
  const h = harness({
    enabled: true,
    credential: { apiKey: "sk-new", credentialId: ID_B },
    binding: { version: 1, lastQuotaCredentialId: ID_A, lastQuotaCapturedAt: 100 },
  });
  const result = await h.runtime.initialize();
  assert.equal(result.status, "ok");
  assert.equal(h.clears, 1);
  assert.equal(h.binding.lastQuotaCredentialId, null);
  assert.equal(h.commits.length, 0);
});

test("startup reconciles by opaque credential identity without decrypting the key", async () => {
  let decryptInspections = 0;
  let binding = { version: 1, lastQuotaCredentialId: ID_A, lastQuotaCapturedAt: 100 };
  const runtime = createKimiQuotaRuntime({
    credentialStore: {
      inspectMetadata: () => ({ configured: true, credentialId: ID_A }),
      inspect: () => {
        decryptInspections += 1;
        return { configured: true, decryptable: true, credentialId: ID_A };
      },
    },
    bindingStore: {
      read: () => ({ ...binding }),
      write: (value) => { binding = { ...value }; return binding; },
    },
    client: { fetchUsage: async () => response() },
    getSettingsSnapshot: () => ({
      kimiQuotaCollectionEnabled: true,
      agents: { "kimi-cli": { enabled: true } },
    }),
    setCollectionEnabled: async () => ({ status: "ok" }),
    commitLocalKimiQuota: () => ({ accepted: true, persisted: true }),
    clearLocalKimiQuota: () => ({ cleared: true, persisted: true }),
  });

  const result = await runtime.initialize();
  assert.deepEqual(result, { status: "ok", initialized: true });
  assert.equal(decryptInspections, 0);
  assert.equal(binding.lastQuotaCredentialId, ID_A);
});

test("response commit rechecks the canonical enabled gate", async () => {
  let resolveFetch;
  const h = harness({
    enabled: true,
    credential: { apiKey: "sk-old", credentialId: ID_A },
    binding: { version: 1, lastQuotaCredentialId: ID_A, lastQuotaCapturedAt: 100 },
    client: { fetchUsage: () => new Promise((resolve) => { resolveFetch = resolve; }) },
  });
  const pending = h.runtime.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  h.setSettings({ kimiQuotaCollectionEnabled: false });
  resolveFetch(response());
  const result = await pending;
  assert.equal(result.status, "error");
  assert.equal(result.reason, "collection-disabled");
  assert.equal(h.commits.length, 0);
});

test("binding persistence failure clears the just-written quota", async () => {
  const h = harness({
    enabled: true,
    credential: { apiKey: "sk-old", credentialId: ID_A },
    bindingWriteFails: true,
  });
  const result = await h.runtime.refresh();
  assert.equal(result.status, "error");
  assert.equal(result.reason, "runtime-persistence-failed");
  assert.equal(h.commits.length, 1);
  assert.equal(h.clears, 1);
});

test("Disconnect durably disables and clears quota but preserves the key", async () => {
  const h = harness({
    enabled: true,
    credential: { apiKey: "sk-old", credentialId: ID_A },
    binding: { version: 1, lastQuotaCredentialId: ID_A, lastQuotaCapturedAt: 100 },
  });
  const result = await h.runtime.disconnect();
  assert.equal(result.status, "ok");
  assert.equal(h.credential.apiKey, "sk-old");
  assert.equal(h.binding.lastQuotaCredentialId, null);
  assert.equal(h.runtime.getStatus().collectionEnabled, false);
});

test("Forget is rejected while enabled and never claims to revoke remotely", async () => {
  const h = harness({ enabled: true, credential: { apiKey: "sk-old", credentialId: ID_A } });
  assert.deepEqual(await h.runtime.forget(), { status: "error", reason: "disconnect-required" });
  await h.runtime.disconnect();
  const forgotten = await h.runtime.forget();
  assert.equal(forgotten.status, "ok");
  assert.equal(forgotten.remoteRevocationRequired, true);
  assert.equal(h.credential, null);
});

test("Reconnect re-enables collection with the stored key and refreshes", async () => {
  const h = harness({
    enabled: false,
    credential: { apiKey: "sk-stored", credentialId: ID_A },
  });
  const result = await h.runtime.reconnect();
  assert.equal(result.status, "ok");
  assert.equal(result.refreshed, true);
  assert.equal(h.runtime.getStatus().collectionEnabled, true);
  assert.equal(h.commits.length, 1);
  assert.equal(h.binding.lastQuotaCredentialId, ID_A);
});

test("Reconnect reports a recoverable configured state when the agent is disabled", async () => {
  const h = harness({
    enabled: false,
    agentEnabled: false,
    credential: { apiKey: "sk-stored", credentialId: ID_A },
  });
  const result = await h.runtime.reconnect();
  assert.equal(result.status, "ok");
  assert.equal(result.refreshed, false);
  assert.equal(result.reason, "agent-disabled");
  assert.equal(h.runtime.getStatus().collectionEnabled, true);
  assert.equal(h.commits.length, 0);
});

test("Reconnect without a stored credential fails closed and never enables collection", async () => {
  const h = harness({ enabled: false });
  const result = await h.runtime.reconnect();
  assert.equal(result.status, "error");
  assert.equal(result.reason, "credential-missing");
  assert.equal(h.runtime.getStatus().collectionEnabled, false);
  assert.equal(h.commits.length, 0);
});

test("Reconnect leaves collection disabled when the enable commit fails", async () => {
  const h = harness({
    enabled: false,
    enableFails: true,
    credential: { apiKey: "sk-stored", credentialId: ID_A },
  });
  const result = await h.runtime.reconnect();
  assert.equal(result.status, "error");
  assert.equal(result.reason, "enable-failed");
  assert.equal(h.runtime.getStatus().collectionEnabled, false);
  assert.equal(h.commits.length, 0);
});
