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
