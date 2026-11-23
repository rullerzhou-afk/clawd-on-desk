"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("main wires balance settings, durable state and power lifecycle without starting Electron", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const calls = [];
  const subscriptions = new Map();
  const app = new EventEmitter();
  const powerMonitor = new EventEmitter();
  const settings = { deepseekBalanceCollectionEnabled: true };
  let dependencies;
  const runtime = Object.fromEntries(["onSettingsChanged", "dispose", "suspend", "resume"]
    .map((name) => [name, () => calls.push(name)]));
  runtime.initialize = async () => calls.push("initialize");
  const credentialStore = {};
  const client = {};
  const safeStorage = {};
  const context = vm.createContext({ app, powerMonitor, safeStorage, console,
    createDeepseekBalanceCredentialStore: (options) => {
      assert.equal(options.safeStorage, safeStorage); return credentialStore;
    },
    createDeepseekBalanceClient: () => client,
    createDeepseekBalanceRuntime: (options) => { dependencies = options; return runtime; },
    _settingsController: {
      getSnapshot: () => settings,
      subscribeKey: (key, fn) => subscriptions.set(key, fn),
      applyCommand: (command, payload) => calls.push([command, payload.enabled]),
    },
    broadcastDeepseekBalanceStatus: () => calls.push("status"),
    _state: { commitLocalDeepseekQuota: (value) => calls.push(["commit", value]),
      clearLocalDeepseekQuota: () => calls.push("clear") },
  });
  const start = source.indexOf("const _deepseekBalanceRuntime =");
  const end = source.indexOf("const _kimiQuotaCredentialStore", start);
  vm.runInContext(source.slice(start, end), context);
  assert.equal(dependencies.credentialStore, credentialStore);
  assert.equal(dependencies.client, client);
  assert.equal(dependencies.getSettingsSnapshot(), settings);
  dependencies.onStatusChanged();
  dependencies.setCollectionEnabled(false);
  dependencies.commitLocalDeepseekQuota("quota");
  dependencies.clearLocalDeepseekQuota();
  subscriptions.get("deepseekBalanceCollectionEnabled")();
  subscriptions.get("agents")();
  const initStart = source.indexOf("    void _deepseekBalanceRuntime.initialize()");
  const initEnd = source.indexOf("    notifyPrefsAuthorityFailure();", initStart);
  vm.runInContext(source.slice(initStart, initEnd), context);
  powerMonitor.emit("suspend"); powerMonitor.emit("resume"); app.emit("before-quit");
  assert.deepEqual(calls, ["status", ["setDeepseekBalanceCollectionEnabled", false], ["commit", "quota"], "clear",
    "onSettingsChanged", "onSettingsChanged", "initialize", "suspend", "resume", "dispose"]);
});


test("main publishes balance status only to a live Settings window and deduplicates content", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  let settingsWindow = null;
  let reads = 0;
  let status = { status: "ok", state: "fresh", configured: true };
  const pushes = [];
  const context = vm.createContext({
    getSettingsWindow: () => settingsWindow,
    _deepseekBalanceRuntime: { getStatus: () => { reads++; return { ...status }; } },
    broadcastSettingsWindow: (channel, payload) => pushes.push({ channel, payload }),
  });
  const start = source.indexOf("let lastDeepseekBalanceStatusWindow");
  const end = source.indexOf("function getThemeSoundPreloadUrls", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext("broadcastDeepseekBalanceStatus()", context);
  assert.equal(reads, 0);
  const makeWindow = () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false } });
  settingsWindow = makeWindow();
  vm.runInContext("broadcastDeepseekBalanceStatus(); broadcastDeepseekBalanceStatus()", context);
  assert.equal(pushes.length, 1);
  status = { ...status, state: "credential-rejected" };
  vm.runInContext("broadcastDeepseekBalanceStatus()", context);
  assert.equal(pushes.length, 2);
  assert.equal(pushes[1].payload.state, "credential-rejected");
  assert.equal(pushes[1].channel, "settings:deepseek-balance-status-changed");
  settingsWindow = makeWindow();
  vm.runInContext("broadcastDeepseekBalanceStatus()", context);
  assert.equal(pushes.length, 3);
  settingsWindow = { isDestroyed: () => true };
  vm.runInContext("broadcastDeepseekBalanceStatus()", context);
  assert.equal(pushes.length, 3);
});
