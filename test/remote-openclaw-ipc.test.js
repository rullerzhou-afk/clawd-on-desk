"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { registerRemoteOpenclawIpc, signatureOf } = require("../src/remote-openclaw-ipc");

function createFakeCredentialStore(initialSecret) {
  let secret = initialSecret;
  const calls = [];
  return {
    calls,
    load() {
      calls.push("load");
      return secret ? { secret, credentialId: "id-1" } : null;
    },
    inspect() {
      return secret
        ? { configured: true, decryptable: true, credentialId: "id-1", updatedAt: 1 }
        : { configured: false, decryptable: false };
    },
    save(next) {
      calls.push("save");
      secret = String(next);
      return { credentialId: "id-2", replaced: true, updatedAt: 2 };
    },
    forget() {
      calls.push("forget");
      secret = "";
      return true;
    },
  };
}

function createHarness(initialConfig, options = {}) {
  let config = initialConfig;
  const handlers = new Map();
  const broadcasts = [];
  const created = [];
  const ipcMain = {
    handle: (channel, listener) => handlers.set(channel, listener),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const settingsController = {
    get: (key) => (key === "remoteOpenclaw" ? config : undefined),
  };
  const window = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (channel, payload) => broadcasts.push([channel, payload]) },
  };
  const BrowserWindow = { getAllWindows: () => [window] };
  const credentialStore = options.credentialStore === null
    ? null
    : (options.credentialStore || createFakeCredentialStore("pw"));
  const createRuntime = (runtimeOptions) => {
    const runtime = {
      options: runtimeOptions,
      started: false,
      stopped: false,
      start() { this.started = true; },
      stop() { this.stopped = true; },
    };
    created.push(runtime);
    return runtime;
  };
  const ipc = registerRemoteOpenclawIpc({
    ipcMain,
    settingsController,
    BrowserWindow,
    createRuntime,
    credentialStore,
    getHookServerPort: () => 23333,
    version: "1.2.0",
  });
  return {
    ipc,
    handlers,
    broadcasts,
    created,
    credentialStore,
    setConfig(next) { config = next; },
  };
}

const ENABLED = { enabled: true, url: "openclaw.example.com", authMode: "password", agentFilter: "" };

test("a disabled block starts nothing and reports stopped", () => {
  const h = createHarness({ enabled: false });
  h.ipc.sync();
  assert.equal(h.created.length, 0);
  assert.equal(h.ipc.getStatus().phase, "stopped");
});

test("an enabled block with a stored credential starts exactly one runtime", () => {
  const h = createHarness(ENABLED);
  h.ipc.sync();
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].started, true);
  assert.equal(h.created[0].options.url, "wss://openclaw.example.com/");
  assert.equal(h.created[0].options.password, "pw");
  assert.equal(h.created[0].options.token, "");
  assert.deepEqual(h.created[0].options.http, { ports: [23333] });
});

test("token mode presents the stored secret as a token, not a password", () => {
  const h = createHarness({ ...ENABLED, authMode: "token" });
  h.ipc.sync();
  assert.equal(h.created[0].options.token, "pw");
  assert.equal(h.created[0].options.password, "");
});

test("an enabled block with no stored credential is an error, not a connection attempt", () => {
  const h = createHarness(ENABLED, { credentialStore: createFakeCredentialStore("") });
  h.ipc.sync();
  assert.equal(h.created.length, 0);
  assert.equal(h.ipc.getStatus().phase, "error");
  assert.match(h.ipc.getStatus().detail, /missing password/);
});

test("a credential store that cannot decrypt is an error, not a crash", () => {
  const broken = {
    load() { throw new Error("keychain unavailable"); },
    inspect() { return { configured: true, decryptable: false }; },
  };
  const h = createHarness(ENABLED, { credentialStore: broken });
  assert.doesNotThrow(() => h.ipc.sync());
  assert.equal(h.created.length, 0);
  assert.equal(h.ipc.getStatus().phase, "error");
});

test("an enabled block with no url is an error, not a connection attempt", () => {
  const h = createHarness({ ...ENABLED, url: "" });
  h.ipc.sync();
  assert.equal(h.created.length, 0);
  assert.equal(h.ipc.getStatus().phase, "error");
  assert.match(h.ipc.getStatus().detail, /missing gateway url/);
});

test("re-syncing an unchanged config keeps the socket alive", () => {
  const h = createHarness(ENABLED);
  h.ipc.sync();
  h.ipc.sync();
  h.ipc.sync();
  assert.equal(h.created.length, 1, "settings-changed fires for every field of every tab");
  assert.equal(h.created[0].stopped, false);
});

test("changing the url tears the old connection down and opens a new one", () => {
  const h = createHarness(ENABLED);
  h.ipc.sync();
  h.setConfig({ ...ENABLED, url: "other.example.com" });
  h.ipc.sync();
  assert.equal(h.created.length, 2);
  assert.equal(h.created[0].stopped, true);
  assert.equal(h.created[1].options.url, "wss://other.example.com/");
});

test("disabling stops the runtime", () => {
  const h = createHarness(ENABLED);
  h.ipc.sync();
  h.setConfig({ ...ENABLED, enabled: false });
  h.ipc.sync();
  assert.equal(h.created[0].stopped, true);
  assert.equal(h.ipc.getStatus().phase, "stopped");
});

test("the agent filter matches either an agent id or a session id", () => {
  const h = createHarness({ ...ENABLED, agentFilter: "agent-7" });
  h.ipc.sync();
  assert.deepEqual(h.created[0].options.sessionFilter, { agentId: "agent-7", sessionId: "agent-7" });

  const unfiltered = createHarness(ENABLED);
  unfiltered.ipc.sync();
  assert.equal(unfiltered.created[0].options.sessionFilter, null, "no filter means follow everything");
});

test("status is pushed to renderer windows", async () => {
  const h = createHarness(ENABLED);
  h.ipc.sync();
  const state = await h.handlers.get("remoteOpenclaw:status")();
  assert.equal(state.status, "ok");
  assert.equal(typeof state.state.phase, "string");
});

test("connect re-reads prefs and disconnect parks the socket without clearing enabled", async () => {
  const h = createHarness(ENABLED);
  h.ipc.sync();
  const afterDisconnect = await h.handlers.get("remoteOpenclaw:disconnect")();
  assert.equal(afterDisconnect.status, "ok");
  assert.equal(h.created[0].stopped, true);

  const afterConnect = await h.handlers.get("remoteOpenclaw:connect")();
  assert.equal(afterConnect.status, "ok");
  assert.equal(h.created.length, 2);
  assert.equal(h.created[1].started, true);
});

// ── Credential ──
//
// The gateway credential must never reach a renderer. It has its own IPC, and
// the answers carry only an opaque flag / id — never the secret.

test("credential status reports configured without exposing the secret", async () => {
  const h = createHarness(ENABLED);
  const result = await h.handlers.get("remoteOpenclaw:credential-status")();
  assert.equal(result.status, "ok");
  assert.equal(result.configured, true);
  assert.equal(JSON.stringify(result).includes("pw"), false, "the secret must not cross the IPC");
});

test("setting a credential reconnects so the next handshake presents it", async () => {
  const h = createHarness(ENABLED);
  h.ipc.sync();
  const result = await h.handlers.get("remoteOpenclaw:set-credential")(null, "new-secret");
  assert.equal(result.status, "ok");
  assert.equal(h.created.length, 2, "the socket must be re-established");
  assert.equal(h.created[1].options.password, "new-secret");
});

test("clearing a credential stops the connection", async () => {
  const h = createHarness(ENABLED);
  h.ipc.sync();
  const result = await h.handlers.get("remoteOpenclaw:clear-credential")();
  assert.equal(result.status, "ok");
  assert.equal(h.created[0].stopped, true);
  assert.equal(h.ipc.getStatus().phase, "error");
});

test("a failing credential save is reported, not thrown", async () => {
  const failing = {
    load: () => null,
    inspect: () => ({ configured: false }),
    save() { throw new Error("no keychain"); },
  };
  const h = createHarness(ENABLED, { credentialStore: failing });
  const result = await h.handlers.get("remoteOpenclaw:set-credential")(null, "x");
  assert.equal(result.status, "error");
  assert.match(result.message, /no keychain/);
});

test("without a credential store the handlers degrade instead of throwing", async () => {
  const h = createHarness(ENABLED, { credentialStore: null });
  const status = await h.handlers.get("remoteOpenclaw:credential-status")();
  assert.deepEqual(status, { status: "ok", configured: false, available: false });
  const saved = await h.handlers.get("remoteOpenclaw:set-credential")(null, "x");
  assert.equal(saved.status, "error");
});

test("dispose stops the runtime and removes every handler", () => {
  const h = createHarness(ENABLED);
  h.ipc.sync();
  h.ipc.dispose();
  assert.equal(h.created[0].stopped, true);
  assert.equal(h.handlers.size, 0);
});

test("broadcast failures do not escape the runtime", () => {
  const h = createHarness(ENABLED);
  // A window destroyed between the getAllWindows call and the send.
  h.ipc.sync();
  assert.doesNotThrow(() => h.ipc.sync());
});

// The credential is not part of the signature: it lives outside prefs, so its
// change is signalled explicitly by set/clear-credential instead.
test("signatureOf distinguishes the fields that require a reconnect", () => {
  const base = signatureOf(ENABLED);
  assert.equal(base, signatureOf({ ...ENABLED }));
  assert.notEqual(base, signatureOf({ ...ENABLED, enabled: false }));
  assert.notEqual(base, signatureOf({ ...ENABLED, url: "other.example.com" }));
  assert.notEqual(base, signatureOf({ ...ENABLED, authMode: "token" }));
  assert.notEqual(base, signatureOf({ ...ENABLED, agentFilter: "agent-7" }));
});
