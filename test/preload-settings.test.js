"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PRELOAD_SETTINGS = path.join(__dirname, "..", "src", "preload-settings.js");

function loadPreload() {
  const ipcHandlers = new Map();
  const exposed = new Map();
  const invokes = [];
  const ipcRenderer = {
    invoke: (...args) => {
      invokes.push(args);
      return Promise.resolve({ status: "ok" });
    },
    send: () => {},
    on(channel, handler) {
      ipcHandlers.set(channel, handler);
    },
    removeListener: () => {},
  };
  const contextBridge = {
    exposeInMainWorld(name, value) {
      exposed.set(name, value);
    },
  };
  const context = {
    console,
    process: { argv: [] },
    require(name) {
      if (name === "electron") return { contextBridge, ipcRenderer };
      throw new Error(`Unexpected preload dependency: ${name}`);
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(PRELOAD_SETTINGS, "utf8"), context, {
    filename: PRELOAD_SETTINGS,
  });
  return { exposed, ipcHandlers, invokes };
}

test("settings preload exposes device listing and revocation IPC", async () => {
  const { exposed, invokes } = loadPreload();
  const api = exposed.get("settingsAPI");
  await api.getMobileDevices();
  await api.revokeMobileDevice("d_0123456789abcdef");
  await api.revokeMobileLegacy();
  assert.deepEqual(invokes, [
    ["settings:mobile-devices"],
    ["settings:revoke-mobile-device", "d_0123456789abcdef"],
    ["settings:revoke-mobile-legacy"],
  ]);
});

test("settings preload keeps every Feishu approver operation on the generic command IPC", async () => {
  const { exposed, invokes } = loadPreload();
  const settingsAPI = exposed.get("settingsAPI");
  for (const [action, payload] of [
    ["feishuApproval.saveApproverByEmail", { email: "person@example.com" }],
    ["feishuApproval.cancelApproverLookup", undefined],
    ["feishuApproval.saveManualApprover", { idType: "open_id", approverId: "ou_manual" }],
  ]) {
    assert.deepEqual(await settingsAPI.command(action, payload), { status: "ok" });
  }
  assert.deepEqual(JSON.parse(JSON.stringify(invokes)), [
    ["settings:command", { action: "feishuApproval.saveApproverByEmail", payload: { email: "person@example.com" } }],
    ["settings:command", { action: "feishuApproval.cancelApproverLookup" }],
    ["settings:command", { action: "feishuApproval.saveManualApprover", payload: { idType: "open_id", approverId: "ou_manual" } }],
  ]);
  assert.equal(typeof settingsAPI.feishuApprovalSaveApproverByEmail, "undefined");
});

test("settings preload exposes the three roam area operations", async () => {
  const { exposed, invokes } = loadPreload();
  const settingsAPI = exposed.get("settingsAPI");
  await settingsAPI.getRoamFence();
  await settingsAPI.selectRoamFence();
  await settingsAPI.clearRoamFence();
  assert.deepStrictEqual(invokes, [
    ["settings:get-roam-fence"],
    ["settings:select-roam-fence"],
    ["settings:clear-roam-fence"],
  ]);
});

test("settings preload queries the current size context on its dedicated IPC channel", async () => {
  const { exposed, invokes } = loadPreload();
  await exposed.get("settingsAPI").getSizeContext();
  assert.deepStrictEqual(invokes, [["settings:get-size-context"]]);
});

test("settings preload forwards size context changes and unsubscribes each listener exactly", () => {
  const { exposed, ipcHandlers } = loadPreload();
  const settingsAPI = exposed.get("settingsAPI");
  const forward = ipcHandlers.get("settings:size-context-changed");
  assert.equal(typeof forward, "function");

  const received = [];
  const unsubscribeA = settingsAPI.onSizeContextChanged(() => received.push("a"));
  const unsubscribeB = settingsAPI.onSizeContextChanged(() => received.push("b"));
  assert.equal(typeof unsubscribeA, "function");
  assert.equal(typeof unsubscribeB, "function");
  const invalidUnsubscribe = settingsAPI.onSizeContextChanged(null);
  assert.equal(typeof invalidUnsubscribe, "function");
  assert.doesNotThrow(() => invalidUnsubscribe());

  forward({});
  assert.deepStrictEqual(received, ["a", "b"]);
  unsubscribeA();
  forward({});
  assert.deepStrictEqual(received, ["a", "b", "b"]);
  unsubscribeB();
  forward({});
  assert.deepStrictEqual(received, ["a", "b", "b"]);
});

test("settings preload exposes dedicated Kimi quota operations", async () => {
  const { exposed, invokes } = loadPreload();
  const settingsAPI = exposed.get("settingsAPI");
  await settingsAPI.getKimiQuotaStatus();
  await settingsAPI.connectKimiQuota("sk-secret");
  await settingsAPI.refreshKimiQuota();
  await settingsAPI.reconnectKimiQuota();
  await settingsAPI.disconnectKimiQuota();
  await settingsAPI.forgetKimiQuotaCredential();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(invokes)), [
    ["settings:kimi-quota-status"],
    ["settings:kimi-quota-connect", { apiKey: "sk-secret" }],
    ["settings:kimi-quota-refresh"],
    ["settings:kimi-quota-reconnect"],
    ["settings:kimi-quota-disconnect"],
    ["settings:kimi-quota-forget"],
  ]);
});

test("settings preload forwards Telegram status revisions and unsubscribe is exact", () => {
  const { exposed, ipcHandlers } = loadPreload();
  const settingsAPI = exposed.get("settingsAPI");
  const forward = ipcHandlers.get("remoteApproval:status-changed");
  const received = [];
  const payload = { channel: "telegram", revision: 7 };

  assert.equal(typeof settingsAPI.onRemoteApprovalStatusChanged, "function");
  assert.equal(typeof forward, "function");

  const unsubscribe = settingsAPI.onRemoteApprovalStatusChanged((value) => {
    received.push(value);
  });
  assert.equal(typeof unsubscribe, "function");

  forward({}, payload);
  assert.equal(received.length, 1);
  assert.equal(received[0], payload, "the channel-scoped payload must pass through unchanged");

  unsubscribe();
  forward({}, { channel: "telegram", revision: 8 });
  assert.equal(received.length, 1, "unsubscribe must remove only the registered callback");
});


test("settings preload forwards quota provider changes and uses the existing command channel", async () => {
  const { exposed, ipcHandlers, invokes } = loadPreload();
  const api = exposed.get("settingsAPI");
  const received = [];
  const unsubscribe = api.onQuotaRingProvidersChanged(providers => received.push(providers));
  const providers = [{ key: "kimiQuota", shown: false, coinCount: 1, shownCoinCount: 0 }];
  ipcHandlers.get("settings:quota-ring-providers-changed")({}, providers);
  assert.deepEqual(received, [providers]);
  unsubscribe();
  ipcHandlers.get("settings:quota-ring-providers-changed")({}, []);
  assert.deepEqual(received, [providers]);
  const payload = { key: "kimiQuota", shown: true, currentShownProviders: [] };
  await api.command("setQuotaRingProviderShown", payload);
  assert.deepEqual(JSON.parse(JSON.stringify(invokes)), [["settings:command", { action: "setQuotaRingProviderShown", payload }]]);
});


test("DeepSeek key actions use dedicated IPC without reading credentials back", async () => {
  const { exposed, invokes } = loadPreload();
  const api = exposed.get("settingsAPI");
  await api.connectDeepseekBalance("sk-private");
  await api.getDeepseekBalanceStatus();
  await api.reconnectDeepseekBalance();
  await api.disconnectDeepseekBalance();
  await api.forgetDeepseekBalanceCredential();
  assert.deepEqual(JSON.parse(JSON.stringify(invokes)), [
    ["settings:deepseek-balance-connect", { apiKey: "sk-private" }],
    ["settings:deepseek-balance-status"], ["settings:deepseek-balance-reconnect"],
    ["settings:deepseek-balance-disconnect"], ["settings:deepseek-balance-forget"],
  ]);
});


test("settings preload forwards sanitized DeepSeek status until unsubscribed", () => {
  const { exposed, ipcHandlers } = loadPreload();
  const api = exposed.get("settingsAPI");
  const received = [];
  const unsubscribe = api.onDeepseekBalanceStatusChanged((status) => received.push(status));
  const status = { status: "ok", state: "credential-rejected", configured: true };
  ipcHandlers.get("settings:deepseek-balance-status-changed")({}, status);
  assert.deepEqual(received, [status]);
  unsubscribe();
  ipcHandlers.get("settings:deepseek-balance-status-changed")({}, { ...status, state: "fresh" });
  assert.deepEqual(received, [status]);
});
