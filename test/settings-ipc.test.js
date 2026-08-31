"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");

const { registerSettingsIpc } = require("../src/settings-ipc");
const {
  listPetTintOptions,
  listPetAccessoryOptions,
  listPetMouthAccessoryOptions,
} = require("../src/pet-customization-catalog");
const prefs = require("../src/prefs");
const { createSettingsController } = require("../src/settings-controller");
const { commandRegistry } = require("../src/settings-actions");

class FakeIpcMain {
  constructor() {
    this.handlers = new Map();
    this.listeners = new Map();
    this.invokeEvent = { sender: "sender-web-contents", senderFrame: null };
  }

  handle(channel, listener) {
    this.handlers.set(channel, listener);
  }

  on(channel, listener) {
    this.listeners.set(channel, listener);
  }

  removeHandler(channel) {
    this.handlers.delete(channel);
  }

  removeListener(channel, listener) {
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
  }

  invoke(channel, ...args) {
    const listener = this.handlers.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC handler ${channel}`);
    return listener(this.invokeEvent, ...args);
  }

  send(channel, ...args) {
    const listener = this.listeners.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC listener ${channel}`);
    return listener({ sender: "sender-web-contents" }, ...args);
  }
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-settings-ipc-"));
}

function createDeferred() {
  const deferred = {};
  deferred.promise = new Promise((resolve, reject) => {
    deferred.resolve = resolve;
    deferred.reject = reject;
  });
  return deferred;
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || "");
    const method = entry.method == null ? 0 : entry.method;
    const flags = entry.flags == null ? 0x0800 : entry.flags;
    const compressed = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const declaredUncompressedSize = entry.uncompressedSize == null ? raw.length : entry.uncompressedSize;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredUncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredUncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralOffset = offset;
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, eocd]);
}

function createHarness(overrides = {}) {
  const calls = [];
  const ipcMain = new FakeIpcMain();
  const settingsMainFrame = {
    url: pathToFileURL(path.join(__dirname, "..", "src", "settings.html")).href,
  };
  const settingsWebContents = new EventEmitter();
  settingsWebContents.mainFrame = settingsMainFrame;
  const settingsWindow = {
    id: "settings-window",
    webContents: settingsWebContents,
    isDestroyed: () => false,
  };
  ipcMain.invokeEvent = {
    sender: settingsWebContents,
    senderFrame: settingsMainFrame,
  };
  const activeTheme = overrides.activeTheme || {
    _id: "clawd",
    sounds: { complete: "complete.mp3" },
  };
  const settingsController = overrides.settingsController || {
    getSnapshot: () => ({ lang: "en" }),
    applyUpdate: (key, value) => {
      calls.push(["applyUpdate", key, value]);
      return { status: "ok", key, value };
    },
    applyCommand: async (action, payload) => {
      calls.push(["applyCommand", action, payload]);
      return { status: "ok" };
    },
  };
  const themeLoader = overrides.themeLoader || {
    getPreviewSoundUrl: () => "file:///preview.mp3",
    getSoundOverridesDir: () => null,
    getSoundUrl: () => null,
    listThemesWithMetadata: () => [],
    getThemeMetadata: (themeId) => ({ name: themeId }),
    ensureUserThemesDir: () => path.join(os.tmpdir(), "clawd-user-themes"),
  };
  const codexPetMain = overrides.codexPetMain || {
    decorateThemeMetadata: (theme) => theme,
    refreshFromSettings: () => ({ status: "ok", refreshed: true }),
    openCodexPetsDir: () => ({ status: "ok", opened: true }),
    importCodexPetZip: (event) => ({ status: "ok", sender: event.sender }),
    removeCodexPet: (themeId) => ({ status: "ok", removed: themeId }),
  };
  const dialog = overrides.dialog || {
    showOpenDialog: async () => ({ canceled: true }),
    showMessageBox: async () => ({ response: 1 }),
  };
  const shell = overrides.shell || {
    openPath: async () => "",
    openExternal: async (url) => calls.push(["openExternal", url]),
  };
  const settingsSizePreviewSession = overrides.settingsSizePreviewSession || {
    begin: () => {
      calls.push(["sizeBegin"]);
      return { status: "ok", phase: "begin" };
    },
    preview: async (value) => {
      calls.push(["sizePreview", value]);
      return { status: "ok" };
    },
    end: (value) => {
      calls.push(["sizeEnd", value]);
      return { status: "ok", phase: "end", value };
    },
  };
  const roamFenceSettings = overrides.roamFenceSettings || {
    getStatus: async () => ({ status: "ok", active: false, fence: null }),
    saveFence: async (fence) => ({ status: "ok", active: true, fence }),
    clearFence: async () => ({ status: "ok", active: false, fence: null }),
  };
  const roamFencePicker = overrides.roamFencePicker || {
    selectArea: async () => ({ status: "cancel" }),
  };
  const runtime = registerSettingsIpc({
    ipcMain,
    app: { getVersion: () => "1.2.3" },
    BrowserWindow: {
      fromWebContents: (sender) => ({ id: "parent", sender }),
    },
    dialog,
    shell,
    fs: overrides.fs || fs,
    path: overrides.path || path,
    settingsController,
    recapRuntime: overrides.recapRuntime,
    themeLoader,
    codexPetMain,
    getSettingsWindow: () => settingsWindow,
    getActiveTheme: () => activeTheme,
    getLang: overrides.getLang || (() => "en"),
    roamFenceSettings,
    roamFencePicker,
    settingsSizePreviewSession,
    isValidSizePreviewKey: (value) => /^P:\d+$/.test(value),
    sendToRenderer: (...args) => calls.push(["sendToRenderer", ...args]),
    getDoNotDisturb: overrides.getDoNotDisturb || (() => false),
    getSoundMuted: overrides.getSoundMuted || (() => false),
    getSoundVolume: overrides.getSoundVolume || (() => 0.4),
    getAllAgents: overrides.getAllAgents || (() => []),
    getHookServerPort: overrides.getHookServerPort,
    getRecentHookEvents: overrides.getRecentHookEvents,
    getQuotaSourceCount: overrides.getQuotaSourceCount,
    kimiQuotaRuntime: overrides.kimiQuotaRuntime,
    detectAgentInstallations: overrides.detectAgentInstallations,
    checkForUpdates: overrides.checkForUpdates || ((manual) => {
      calls.push(["checkForUpdates", manual]);
      return { state: "up-to-date", version: "1.2.3" };
    }),
    getUpdateCheckSnapshot: overrides.getUpdateCheckSnapshot || (() => ({ state: "idle" })),
    clearUpdateError: overrides.clearUpdateError || (() => ({ state: "idle" })),
    copyUpdateError: overrides.copyUpdateError || ((text) => {
      calls.push(["copyUpdateError", text]);
      return { status: "ok" };
    }),
    showTutorial: overrides.showTutorial || (() => {
      calls.push(["showTutorial"]);
      return { status: "ok" };
    }),
    aboutHeroSvgPath: overrides.aboutHeroSvgPath || path.join(__dirname, "missing-about-hero.svg"),
    getLanWsServer: overrides.getLanWsServer || (() => null),
    now: overrides.now || (() => 12345),
    saveFeishuApproverByEmail: overrides.saveFeishuApproverByEmail || (async ({ email, signal }) => {
      calls.push(["saveFeishuApproverByEmail", email, signal]);
      return { status: "ok" };
    }),
  });
  return { ipcMain, runtime, calls, activeTheme, settingsWindow };
}

test("Kimi quota IPC is trusted-window-only and bypasses generic settings commands", async () => {
  const runtimeCalls = [];
  const kimiQuotaRuntime = {
    getStatus: () => ({ status: "ok", configured: false, mode: "manual-only" }),
    connect: async (apiKey) => { runtimeCalls.push(["connect", apiKey]); return { status: "ok" }; },
    refresh: async () => { runtimeCalls.push(["refresh"]); return { status: "ok" }; },
    reconnect: async () => { runtimeCalls.push(["reconnect"]); return { status: "ok" }; },
    disconnect: async () => { runtimeCalls.push(["disconnect"]); return { status: "ok" }; },
    forget: async () => { runtimeCalls.push(["forget"]); return { status: "ok" }; },
  };
  const harness = createHarness({ kimiQuotaRuntime });
  assert.deepStrictEqual(await harness.ipcMain.invoke("settings:kimi-quota-status"), {
    status: "ok",
    configured: false,
    mode: "manual-only",
  });
  assert.deepStrictEqual(
    await harness.ipcMain.invoke("settings:kimi-quota-connect", { apiKey: "sk-secret" }),
    { status: "ok" }
  );
  await harness.ipcMain.invoke("settings:kimi-quota-refresh");
  await harness.ipcMain.invoke("settings:kimi-quota-reconnect");
  await harness.ipcMain.invoke("settings:kimi-quota-disconnect");
  await harness.ipcMain.invoke("settings:kimi-quota-forget");
  assert.deepStrictEqual(runtimeCalls, [
    ["connect", "sk-secret"],
    ["refresh"],
    ["reconnect"],
    ["disconnect"],
    ["forget"],
  ]);
  assert.equal(harness.calls.some((call) => JSON.stringify(call).includes("sk-secret")), false);

  harness.ipcMain.invokeEvent = { sender: {}, senderFrame: null };
  assert.deepStrictEqual(
    await harness.ipcMain.invoke("settings:kimi-quota-connect", { apiKey: "sk-secret" }),
    { status: "error", message: "untrusted settings sender" }
  );
  assert.deepStrictEqual(
    await harness.ipcMain.invoke("settings:kimi-quota-reconnect"),
    { status: "error", message: "untrusted settings sender" }
  );
  assert.equal(runtimeCalls.length, 5);
});

test("settings IPC registers owned channels and leaves animation override channels to their module", () => {
  const { ipcMain, runtime } = createHarness();

  assert.ok(ipcMain.handlers.has("settings:get-snapshot"));
  assert.ok(ipcMain.handlers.has("settings:recap-query"));
  assert.ok(ipcMain.handlers.has("settings:recap-clear"));
  assert.ok(ipcMain.handlers.has("settings:get-quota-source-count"));
  assert.ok(ipcMain.handlers.has("settings:get-pet-tint-options"));
  assert.ok(ipcMain.handlers.has("settings:get-pet-accessory-options"));
  assert.ok(ipcMain.handlers.has("settings:get-pet-mouth-accessory-options"));
  assert.ok(ipcMain.handlers.has("settings:get-roam-fence"));
  assert.ok(ipcMain.handlers.has("settings:select-roam-fence"));
  assert.ok(ipcMain.handlers.has("settings:clear-roam-fence"));
  assert.ok(ipcMain.handlers.has("settings:pick-sound-file"));
  assert.ok(ipcMain.handlers.has("settings:list-themes"));
  assert.ok(ipcMain.handlers.has("settings:detect-agent-installations"));
  assert.ok(ipcMain.handlers.has("settings:show-tutorial"));
  assert.ok(ipcMain.handlers.has("settings:clear-update-error"));
  assert.ok(ipcMain.handlers.has("settings:open-user-themes-dir"));
  assert.ok(ipcMain.handlers.has("settings:import-user-theme-zip"));
  assert.ok(ipcMain.handlers.has("settings:refresh-codex-pets"));
  assert.ok(!ipcMain.listeners.has("settings:open-dashboard"));
  assert.ok(!ipcMain.handlers.has("settings:getShortcutFailures"));
  assert.ok(!ipcMain.handlers.has("settings:enterShortcutRecording"));
  assert.ok(!ipcMain.handlers.has("settings:exitShortcutRecording"));
  assert.ok(!ipcMain.handlers.has("settings:get-animation-overrides-data"));
  assert.ok(!ipcMain.handlers.has("settings:open-theme-assets-dir"));
  assert.ok(!ipcMain.handlers.has("settings:preview-animation-override"));
  assert.ok(!ipcMain.handlers.has("settings:preview-reaction"));
  assert.ok(!ipcMain.handlers.has("settings:export-animation-overrides"));
  assert.ok(!ipcMain.handlers.has("settings:import-animation-overrides"));

  runtime.dispose();

  assert.strictEqual(ipcMain.handlers.size, 0);
  assert.strictEqual(ipcMain.listeners.size, 0);
});

test("recap IPC exposes only bounded queries and explicit clear to the trusted Settings window", async () => {
  const calls = [];
  const harness = createHarness({
    recapRuntime: {
      query(period) {
        calls.push(["query", period]);
        return { status: "ready", period, days: [] };
      },
      clear() {
        calls.push(["clear"]);
        return true;
      },
    },
  });
  assert.deepStrictEqual(await harness.ipcMain.invoke("settings:recap-query", "year"), {
    status: "ready",
    period: "year",
    days: [],
  });
  assert.deepStrictEqual(await harness.ipcMain.invoke("settings:recap-query", "arbitrary"), {
    status: "error",
    reason: "invalid-period",
  });
  assert.deepStrictEqual(await harness.ipcMain.invoke("settings:recap-clear"), { status: "ok" });
  assert.deepStrictEqual(calls, [["query", "year"], ["clear"]]);

  harness.ipcMain.invokeEvent = { sender: {}, senderFrame: null };
  assert.deepStrictEqual(await harness.ipcMain.invoke("settings:recap-query", "today"), {
    status: "error",
    message: "untrusted settings sender",
  });
  assert.deepStrictEqual(await harness.ipcMain.invoke("settings:recap-clear"), {
    status: "error",
    message: "untrusted settings sender",
  });
  assert.equal(calls.length, 2);
});

test("settings IPC reads, selects, and clears the shared roam fence", async () => {
  const calls = [];
  const initial = {
    status: "ok",
    active: true,
    fence: { left: 0.1, top: 0.2, right: 0.8, bottom: 0.9 },
  };
  const selected = { left: 0.25, top: 0.3, right: 0.75, bottom: 0.85 };
  const harness = createHarness({
    getLang: () => "zh",
    roamFenceSettings: {
      getStatus: async () => { calls.push(["get"]); return initial; },
      saveFence: async (fence) => { calls.push(["save", fence]); return { status: "ok", active: true, fence }; },
      clearFence: async () => { calls.push(["clear"]); return { status: "ok", active: false, fence: null }; },
    },
    roamFencePicker: {
      selectArea: async (payload) => { calls.push(["pick", payload]); return { status: "ok", fence: selected }; },
    },
  });

  assert.deepStrictEqual(await harness.ipcMain.invoke("settings:get-roam-fence"), initial);
  assert.deepStrictEqual(await harness.ipcMain.invoke("settings:select-roam-fence"), {
    status: "ok", active: true, fence: selected,
  });
  assert.deepStrictEqual(await harness.ipcMain.invoke("settings:clear-roam-fence"), {
    status: "ok", active: false, fence: null,
  });
  assert.deepStrictEqual(calls, [
    ["get"],
    ["pick", { lang: "zh" }],
    ["save", selected],
    ["clear"],
  ]);
});

test("roam fence IPC rejects external senders, subframes, and a navigated Settings frame", async () => {
  const calls = [];
  const harness = createHarness({
    roamFenceSettings: {
      getStatus: async () => { calls.push("get"); return { status: "ok" }; },
      saveFence: async () => { calls.push("save"); return { status: "ok" }; },
      clearFence: async () => { calls.push("clear"); return { status: "ok" }; },
    },
    roamFencePicker: {
      selectArea: async () => { calls.push("pick"); return { status: "cancel" }; },
    },
  });
  const contents = harness.settingsWindow.webContents;
  const frame = contents.mainFrame;
  const channels = [
    "settings:get-roam-fence",
    "settings:select-roam-fence",
    "settings:clear-roam-fence",
  ];

  for (const event of [
    { sender: {}, senderFrame: null },
    { sender: contents, senderFrame: { url: frame.url } },
  ]) {
    harness.ipcMain.invokeEvent = event;
    for (const channel of channels) {
      assert.deepStrictEqual(await harness.ipcMain.invoke(channel), {
        status: "error",
        message: "untrusted settings sender",
      });
    }
  }

  const localUrl = frame.url;
  frame.url = "https://example.invalid/";
  harness.ipcMain.invokeEvent = { sender: contents, senderFrame: frame };
  for (const channel of channels) {
    assert.deepStrictEqual(await harness.ipcMain.invoke(channel), {
      status: "error",
      message: "untrusted settings sender",
    });
  }
  frame.url = localUrl;
  assert.deepStrictEqual(calls, [], "untrusted callers must have no picker or file side effects");
  harness.runtime.dispose();
});

test("Feishu email save bypasses the controller and exposes only one final IPC result", async () => {
  const controllerCalls = [];
  const operationCalls = [];
  const settingsController = {
    getSnapshot: () => ({ lang: "en" }),
    applyUpdate: () => ({ status: "ok" }),
    applyCommand: async (...args) => {
      controllerCalls.push(args);
      return { status: "ok" };
    },
  };
  const harness = createHarness({
    settingsController,
    saveFeishuApproverByEmail: async (payload) => {
      operationCalls.push(payload);
      return {
        status: "ok",
        approverId: "ou_must_not_cross_ipc",
        message: "raw detail must not cross ipc",
      };
    },
  });

  const trustedEvent = harness.ipcMain.invokeEvent;
  const invokeSave = () => harness.ipcMain.invoke("settings:command", {
    action: "feishuApproval.saveApproverByEmail",
    payload: { email: "foreign@example.com" },
  });
  for (const invokeEvent of [
    { sender: {}, senderFrame: null },
    { sender: trustedEvent.sender, senderFrame: { url: trustedEvent.senderFrame.url } },
  ]) {
    harness.ipcMain.invokeEvent = invokeEvent;
    assert.deepStrictEqual(await invokeSave(), {
      status: "error",
      message: "untrusted settings sender",
    });
  }
  const trustedUrl = trustedEvent.senderFrame.url;
  trustedEvent.senderFrame.url = "https://example.invalid/";
  harness.ipcMain.invokeEvent = trustedEvent;
  assert.deepStrictEqual(await invokeSave(), {
    status: "error",
    message: "untrusted settings sender",
  });
  trustedEvent.senderFrame.url = trustedUrl;
  assert.equal(operationCalls.length, 0);
  harness.ipcMain.invokeEvent = trustedEvent;

  const result = await harness.ipcMain.invoke("settings:command", {
    action: "feishuApproval.saveApproverByEmail",
    payload: {
      email: "person@example.com",
      platform: "lark",
      appSecret: "renderer-secret",
      approverId: "ou_forged",
    },
  });

  assert.deepStrictEqual(result, { status: "ok" });
  assert.equal(controllerCalls.length, 0);
  assert.equal(operationCalls.length, 1);
  assert.deepStrictEqual(Object.keys(operationCalls[0]).sort(), ["email", "signal"]);
  assert.equal(operationCalls[0].email, "person@example.com");
  assert.equal(operationCalls[0].signal instanceof AbortSignal, true);
  assert.equal(harness.settingsWindow.webContents.listenerCount("destroyed"), 0);
  assert.equal(harness.settingsWindow.webContents.listenerCount("render-process-gone"), 0);
  harness.runtime.dispose();
});

test("Feishu email lookup B immediately supersedes A without controller serialization", async () => {
  const operations = [];
  const harness = createHarness({
    saveFeishuApproverByEmail: ({ email, signal }) => {
      const deferred = createDeferred();
      operations.push({ email, signal, deferred });
      return deferred.promise;
    },
  });

  const first = harness.ipcMain.invoke("settings:command", {
    action: "feishuApproval.saveApproverByEmail",
    payload: { email: "a@example.com" },
  });
  await Promise.resolve();
  const second = harness.ipcMain.invoke("settings:command", {
    action: "feishuApproval.saveApproverByEmail",
    payload: { email: "b@example.com" },
  });
  await Promise.resolve();

  assert.deepStrictEqual(operations.map((item) => item.email), ["a@example.com", "b@example.com"]);
  assert.equal(operations[0].signal.aborted, true);
  assert.equal(operations[1].signal.aborted, false);

  operations[1].deferred.resolve({ status: "ok" });
  assert.deepStrictEqual(await second, { status: "ok" });
  operations[0].deferred.resolve({ status: "ok", approverId: "ou_late" });
  assert.deepStrictEqual(await first, { status: "error", code: "lookup-superseded" });
  harness.runtime.dispose();
});

test("Feishu email lookup A stays superseded when it settles before B", async () => {
  const operations = [];
  const harness = createHarness({
    saveFeishuApproverByEmail: ({ email, signal }) => {
      const deferred = createDeferred();
      operations.push({ email, signal, deferred });
      return deferred.promise;
    },
  });
  const first = harness.ipcMain.invoke("settings:command", {
    action: "feishuApproval.saveApproverByEmail",
    payload: { email: "a@example.com" },
  });
  await Promise.resolve();
  const second = harness.ipcMain.invoke("settings:command", {
    action: "feishuApproval.saveApproverByEmail",
    payload: { email: "b@example.com" },
  });
  await Promise.resolve();

  operations[0].deferred.resolve({ status: "ok", approverId: "ou_a_late" });
  assert.deepStrictEqual(await first, { status: "error", code: "lookup-superseded" });
  assert.equal(operations[1].signal.aborted, false);
  operations[1].deferred.resolve({ status: "ok" });
  assert.deepStrictEqual(await second, { status: "ok" });
  harness.runtime.dispose();
});

test("Feishu lookup cancel is sender-bound and resolves the pending save as cancelled", async () => {
  let capturedSignal;
  const harness = createHarness({
    saveFeishuApproverByEmail: ({ signal }) => {
      capturedSignal = signal;
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ status: "ok", approverId: "ou_late" }), { once: true });
      });
    },
  });
  const pending = harness.ipcMain.invoke("settings:command", {
    action: "feishuApproval.saveApproverByEmail",
    payload: { email: "person@example.com" },
  });
  await Promise.resolve();

  const contents = harness.settingsWindow.webContents;
  const frame = contents.mainFrame;
  harness.ipcMain.invokeEvent = { sender: {}, senderFrame: null };
  assert.deepStrictEqual(await harness.ipcMain.invoke("settings:command", {
    action: "feishuApproval.cancelApproverLookup",
  }), { status: "error", message: "untrusted settings sender" });
  assert.equal(capturedSignal.aborted, false);

  harness.ipcMain.invokeEvent = { sender: contents, senderFrame: frame };
  assert.deepStrictEqual(await harness.ipcMain.invoke("settings:command", {
    action: "feishuApproval.cancelApproverLookup",
  }), { status: "ok" });
  assert.equal(capturedSignal.aborted, true);
  assert.deepStrictEqual(await pending, { status: "error", code: "lookup-cancelled" });
  harness.runtime.dispose();
});

test("Feishu lookup follows Settings WebContents and IPC disposal lifecycle", async () => {
  for (const terminal of ["destroyed", "render-process-gone", "dispose"]) {
    let capturedSignal;
    const harness = createHarness({
      saveFeishuApproverByEmail: ({ signal }) => {
        capturedSignal = signal;
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ status: "ok" }), { once: true });
        });
      },
    });
    const pending = harness.ipcMain.invoke("settings:command", {
      action: "feishuApproval.saveApproverByEmail",
      payload: { email: `${terminal}@example.com` },
    });
    await Promise.resolve();

    if (terminal === "dispose") harness.runtime.dispose();
    else harness.settingsWindow.webContents.emit(terminal, {}, { reason: "synthetic" });

    assert.equal(capturedSignal.aborted, true, terminal);
    assert.deepStrictEqual(await pending, { status: "error", code: "lookup-cancelled" }, terminal);
    assert.equal(harness.settingsWindow.webContents.listenerCount("destroyed"), 0, terminal);
    assert.equal(harness.settingsWindow.webContents.listenerCount("render-process-gone"), 0, terminal);
    harness.runtime.dispose();
    harness.runtime.dispose();
  }
});

test("settings IPC does not write when roam area selection is canceled", async () => {
  let saveCalls = 0;
  const harness = createHarness({
    roamFenceSettings: {
      getStatus: async () => ({ status: "ok", active: false, fence: null }),
      saveFence: async () => { saveCalls += 1; return { status: "ok" }; },
      clearFence: async () => ({ status: "ok", active: false, fence: null }),
    },
    roamFencePicker: { selectArea: async () => ({ status: "cancel" }) },
  });
  assert.deepStrictEqual(await harness.ipcMain.invoke("settings:select-roam-fence"), { status: "cancel" });
  assert.strictEqual(saveCalls, 0);
});

test("settings IPC preserves picker error codes and does not write an impossible area", async () => {
  let saveCalls = 0;
  const tooLarge = {
    status: "error",
    code: "pet-too-large",
    message: "the pet is larger than this display's work area",
  };
  const harness = createHarness({
    roamFenceSettings: {
      getStatus: async () => ({ status: "ok", active: false, fence: null }),
      saveFence: async () => { saveCalls += 1; return { status: "ok" }; },
      clearFence: async () => ({ status: "ok", active: false, fence: null }),
    },
    roamFencePicker: { selectArea: async () => tooLarge },
  });
  assert.deepStrictEqual(await harness.ipcMain.invoke("settings:select-roam-fence"), tooLarge);
  assert.strictEqual(saveCalls, 0);
});

test("settings IPC reports quota source count and fails closed when the provider throws", async () => {
  const ok = createHarness({ getQuotaSourceCount: () => 3 });
  assert.strictEqual(await ok.ipcMain.invoke("settings:get-quota-source-count"), 3);
  ok.runtime.dispose();

  const broken = createHarness({
    getQuotaSourceCount: () => {
      throw new Error("quota store unavailable");
    },
  });
  assert.strictEqual(await broken.ipcMain.invoke("settings:get-quota-source-count"), 0);
  broken.runtime.dispose();
});

test("settings:list-themes uses active runtime capabilities over raw metadata", async () => {
  const { ipcMain } = createHarness({
    activeTheme: {
      _id: "clawd",
      _capabilities: { petTint: true, accessories: false },
      sounds: {},
    },
    themeLoader: {
      getPreviewSoundUrl: () => null,
      getSoundOverridesDir: () => null,
      getSoundUrl: () => null,
      listThemesWithMetadata: () => [{
        id: "clawd",
        capabilities: { petTint: true, accessories: true, reactions: true },
      }],
      getThemeMetadata: () => null,
      ensureUserThemesDir: () => null,
    },
  });

  assert.deepStrictEqual(await ipcMain.invoke("settings:list-themes"), [{
    id: "clawd",
    active: true,
    capabilities: { petTint: true, accessories: false, reactions: true },
  }]);
});

test("settings IPC opens the tutorial from Settings", async () => {
  const { ipcMain, runtime, calls } = createHarness();

  const result = await ipcMain.invoke("settings:show-tutorial");

  assert.deepStrictEqual(result, { status: "ok" });
  assert.deepStrictEqual(calls, [["showTutorial"]]);
  runtime.dispose();
});

test("mobile connection info reports starting until the LAN bridge has a port", async () => {
  const token = "0123456789abcdef0123456789abcdef";
  const { ipcMain, runtime } = createHarness({
    getLanWsServer: () => ({
      getPort: () => null,
      getToken: () => token,
    }),
  });

  const result = await ipcMain.invoke("settings:mobile-connection-info");

  assert.deepStrictEqual(result, {
    status: "starting",
    message: "LAN bridge is starting",
  });
  runtime.dispose();
});

test("mobile connection info returns a ready pair URL only when port and token are available", async () => {
  const token = "0123456789abcdef0123456789abcdef";
  const { ipcMain, runtime } = createHarness({
    getLanWsServer: () => ({
      getPort: () => 23334,
      getToken: () => token,
    }),
  });

  const result = await ipcMain.invoke("settings:mobile-connection-info");

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.port, 23334);
  assert.strictEqual(result.token, token);
  assert.ok(result.pairUrl.includes("port=23334"));
  assert.ok(result.pairUrl.includes(`token=${token}`));
  assert.ok(!result.pairUrl.includes("port=null"));
  runtime.dispose();
});

test("settings IPC delegates controller and size preview handlers", async () => {
  const { ipcMain, calls } = createHarness();

  assert.deepStrictEqual(await ipcMain.invoke("settings:get-snapshot"), { lang: "en" });
  assert.deepStrictEqual(
    await ipcMain.invoke("settings:get-pet-tint-options"),
    listPetTintOptions()
  );
  assert.deepStrictEqual(
    await ipcMain.invoke("settings:get-pet-accessory-options"),
    listPetAccessoryOptions()
  );
  assert.deepStrictEqual(
    await ipcMain.invoke("settings:get-pet-mouth-accessory-options"),
    listPetMouthAccessoryOptions()
  );
  assert.deepStrictEqual(
    await ipcMain.invoke("settings:update", null),
    { status: "error", message: "settings:update payload must be { key, value }" }
  );
  assert.deepStrictEqual(await ipcMain.invoke("settings:update", { key: "size", value: "P:20" }), {
    status: "ok",
    key: "size",
    value: "P:20",
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:update", { key: "tgMigration", value: { transport: "native" } }), {
    status: "error",
    message: "tgMigration is internal; use telegramMigration.dispatch",
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:update", { key: "permissionAutomationMode", value: "auto-tools" }), {
    status: "error",
    message: "permission automation is gated; use the setPermissionAutomationMode command",
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:update", { key: "autoApproveAllPermissions", value: true }), {
    status: "error",
    message: "permission automation is gated; use the setPermissionAutomationMode command",
  });
  for (const key of [
    "permissionAutomationAutoToolsWarningDismissed",
    "permissionAutomationUnattendedWarningDismissed",
  ]) {
    assert.deepStrictEqual(await ipcMain.invoke("settings:update", { key, value: true }), {
      status: "error",
      message: "permission automation is gated; use the setPermissionAutomationMode command",
    });
  }
  assert.deepStrictEqual(await ipcMain.invoke("settings:command", { action: "resizePet", payload: "P:30" }), {
    status: "ok",
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:command", {
    action: "feishuApproval.saveManualApprover",
    payload: { idType: "union_id", approverId: "union-saved" },
  }), { status: "ok" });
  for (const action of [
    "feishuApproval.commitResolvedApprover",
    "remoteSsh.applyInstallationIdentity",
    "remoteSsh.beginIdentityRotation",
    "remoteSsh.updateIdentityStep",
    "remoteSsh.commitIdentityRotation",
    "remoteSsh.forceRevoke",
    "remoteSsh.markDeployed",
    "remoteSsh.markRemoteNode",
  ]) {
    assert.deepStrictEqual(
      await ipcMain.invoke("settings:command", { action, payload: { forged: true } }),
      { status: "error", message: `settings command "${action}" is internal` }
    );
  }
  assert.deepStrictEqual(await ipcMain.invoke("settings:begin-size-preview"), {
    status: "ok",
    phase: "begin",
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:preview-size", "bad"), {
    status: "error",
    message: 'invalid preview size "bad"',
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:preview-size", "P:35"), { status: "ok" });
  assert.deepStrictEqual(await ipcMain.invoke("settings:end-size-preview", "P:35"), {
    status: "ok",
    phase: "end",
    value: "P:35",
  });

  assert.deepStrictEqual(calls, [
    ["applyUpdate", "size", "P:20"],
    ["applyCommand", "resizePet", "P:30"],
    ["applyCommand", "feishuApproval.saveManualApprover", { idType: "union_id", approverId: "union-saved" }],
    ["sizeBegin"],
    ["sizePreview", "P:35"],
    ["sizeEnd", "P:35"],
  ]);
});

test("settings:update cannot bypass the Feishu command-only boundary", async () => {
  const controller = createSettingsController({
    loadResult: { snapshot: prefs.getDefaults(), locked: false },
    commands: commandRegistry,
  });
  const { ipcMain, runtime } = createHarness({ settingsController: controller });
  const staleObject = { ...controller.get("feishuApproval") };

  assert.deepStrictEqual(
    await controller.applyCommand("feishuApproval.updateConfig", { connectionTimeoutSeconds: 30 }),
    { status: "ok", message: undefined },
  );
  const result = await ipcMain.invoke("settings:update", {
    key: "feishuApproval",
    value: staleObject,
  });

  assert.equal(result.status, "error");
  assert.match(result.message, /command-only/);
  assert.equal(controller.get("feishuApproval").connectionTimeoutSeconds, 30);
  runtime.dispose();
});

test("settings IPC delegates Codex Pet theme channels and decorates metadata", async () => {
  const codexCalls = [];
  const { ipcMain, settingsWindow } = createHarness({
    activeTheme: { _id: "imported-pet", sounds: {} },
    themeLoader: {
      getPreviewSoundUrl: () => null,
      getSoundOverridesDir: () => null,
      getSoundUrl: () => null,
      listThemesWithMetadata: () => [
        { id: "clawd", name: "Clawd" },
        { id: "imported-pet", name: "Imported Pet" },
      ],
      getThemeMetadata: () => null,
    },
    codexPetMain: {
      decorateThemeMetadata: (theme) => ({
        ...theme,
        managedCodexPet: theme.id === "imported-pet",
      }),
      refreshFromSettings: () => {
        codexCalls.push("refresh");
        return { status: "ok", refreshed: true };
      },
      openCodexPetsDir: () => {
        codexCalls.push("open-dir");
        return { status: "ok", opened: true };
      },
      importCodexPetZip: (event) => {
        codexCalls.push(["import", event.sender]);
        return { status: "ok", imported: true };
      },
      removeCodexPet: (themeId) => {
        codexCalls.push(["remove", themeId]);
        return { status: "ok", removed: themeId };
      },
    },
  });

  assert.deepStrictEqual(await ipcMain.invoke("settings:list-themes"), [
    { id: "clawd", name: "Clawd", active: false, managedCodexPet: false },
    { id: "imported-pet", name: "Imported Pet", active: true, managedCodexPet: true },
  ]);
  assert.deepStrictEqual(await ipcMain.invoke("settings:refresh-codex-pets"), {
    status: "ok",
    refreshed: true,
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:open-codex-pets-dir"), {
    status: "ok",
    opened: true,
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:import-codex-pet-zip"), {
    status: "ok",
    imported: true,
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:remove-codex-pet", "imported-pet"), {
    status: "ok",
    removed: "imported-pet",
  });
  assert.deepStrictEqual(codexCalls, [
    "refresh",
    "open-dir",
    ["import", settingsWindow.webContents],
    ["remove", "imported-pet"],
  ]);
});

test("settings IPC opens the user themes directory", async () => {
  const openCalls = [];
  const { ipcMain } = createHarness({
    themeLoader: {
      getPreviewSoundUrl: () => null,
      getSoundOverridesDir: () => null,
      getSoundUrl: () => null,
      listThemesWithMetadata: () => [],
      getThemeMetadata: () => null,
      ensureUserThemesDir: () => "C:\\Users\\Example\\AppData\\Roaming\\Clawd\\themes",
    },
    shell: {
      openPath: async (dir) => {
        openCalls.push(dir);
        return "";
      },
      openExternal: async () => {},
    },
  });

  assert.deepStrictEqual(await ipcMain.invoke("settings:open-user-themes-dir"), {
    status: "ok",
    path: "C:\\Users\\Example\\AppData\\Roaming\\Clawd\\themes",
  });
  assert.deepStrictEqual(openCalls, ["C:\\Users\\Example\\AppData\\Roaming\\Clawd\\themes"]);
});

test("settings IPC imports Clawd user theme zip packages", async () => {
  const root = makeTempDir();
  try {
    const userThemesDir = path.join(root, "user-themes");
    const zipPath = path.join(root, "pixel-cat.zip");
    const themeJson = {
      schemaVersion: 1,
      name: "Pixel Cat",
      version: "1.0.0",
      sleepSequence: { mode: "direct" },
      viewBox: { x: 0, y: 0, width: 16, height: 16 },
      states: {
        idle: ["idle.svg"],
        working: ["working.gif"],
        thinking: ["thinking.png"],
        sleeping: { fallbackTo: "idle" },
      },
    };
    fs.writeFileSync(zipPath, makeZip([
      { name: "pixel-cat/theme.json", data: JSON.stringify(themeJson), method: 8 },
      { name: "pixel-cat/assets/idle.svg", data: "<svg></svg>", method: 8 },
      { name: "pixel-cat/assets/working.gif", data: "gif", method: 8 },
      { name: "pixel-cat/assets/thinking.png", data: "png", method: 8 },
    ]));

    let dialogParent = null;
    let dialogOptions = null;
    const { ipcMain, settingsWindow } = createHarness({
      dialog: {
        showOpenDialog: async (parent, options) => {
          dialogParent = parent;
          dialogOptions = options;
          return { canceled: false, filePaths: [zipPath] };
        },
        showMessageBox: async () => ({ response: 1 }),
      },
      themeLoader: {
        getPreviewSoundUrl: () => null,
        getSoundOverridesDir: () => null,
        getSoundUrl: () => null,
        listThemesWithMetadata: () => [],
        getThemeMetadata: () => null,
        ensureUserThemesDir: () => userThemesDir,
      },
    });

    assert.deepStrictEqual(await ipcMain.invoke("settings:import-user-theme-zip"), {
      status: "ok",
      themeId: "pixel-cat",
      name: "Pixel Cat",
      path: path.join(userThemesDir, "pixel-cat"),
    });
    assert.deepStrictEqual(dialogParent, { id: "parent", sender: settingsWindow.webContents });
    assert.deepStrictEqual(dialogOptions.properties, ["openFile"]);
    assert.deepStrictEqual(dialogOptions.filters, [{ name: "Clawd theme zip", extensions: ["zip"] }]);
    assert.strictEqual(
      fs.readFileSync(path.join(userThemesDir, "pixel-cat", "theme.json"), "utf8"),
      JSON.stringify(themeJson)
    );
    assert.strictEqual(
      fs.readFileSync(path.join(userThemesDir, "pixel-cat", "assets", "working.gif"), "utf8"),
      "gif"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("settings IPC copies sound overrides, removes stale siblings, and invalidates renderer cache", async () => {
  const root = makeTempDir();
  try {
    const overridesDir = path.join(root, "overrides");
    const sourcePath = path.join(root, "picked.wav");
    fs.mkdirSync(overridesDir, { recursive: true });
    fs.writeFileSync(sourcePath, "new audio", "utf8");
    fs.writeFileSync(path.join(overridesDir, "complete.mp3"), "old audio", "utf8");

    let dialogOptions = null;
    const { ipcMain, calls, activeTheme } = createHarness({
      dialog: {
        showOpenDialog: async (_parent, options) => {
          dialogOptions = options;
          return { canceled: false, filePaths: [sourcePath] };
        },
        showMessageBox: async () => ({ response: 1 }),
      },
      themeLoader: {
        getPreviewSoundUrl: () => null,
        getSoundOverridesDir: () => overridesDir,
        getSoundUrl: (soundName) => `file:///${soundName}.wav`,
        listThemesWithMetadata: () => [],
        getThemeMetadata: () => null,
      },
    });

    assert.deepStrictEqual(await ipcMain.invoke("settings:pick-sound-file", { soundName: "../nope" }), {
      status: "error",
      message: 'pickSoundFile.soundName "../nope" contains invalid characters',
    });
    assert.deepStrictEqual(await ipcMain.invoke("settings:pick-sound-file", { soundName: "complete" }), {
      status: "ok",
      file: "complete.wav",
    });

    assert.deepStrictEqual(dialogOptions.properties, ["openFile"]);
    assert.deepStrictEqual(dialogOptions.filters[0].extensions.sort(), [
      "aac",
      "flac",
      "m4a",
      "mp3",
      "ogg",
      "wav",
    ]);
    assert.strictEqual(fs.readFileSync(path.join(overridesDir, "complete.wav"), "utf8"), "new audio");
    assert.strictEqual(fs.existsSync(path.join(overridesDir, "complete.mp3")), false);
    assert.strictEqual(activeTheme._soundOverrideFiles.complete, path.join(overridesDir, "complete.wav"));
    assert.deepStrictEqual(calls, [
      ["applyCommand", "setSoundOverride", {
        themeId: "clawd",
        soundName: "complete",
        file: "complete.wav",
        originalName: "picked.wav",
      }],
      ["sendToRenderer", "invalidate-sound-cache", "file:///complete.wav"],
      ["sendToRenderer", "preload-sounds", { urls: ["file:///complete.wav"] }],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("settings IPC previews sound only when not muted or in DND", async () => {
  const { ipcMain, calls } = createHarness({
    themeLoader: {
      getPreviewSoundUrl: () => null,
      getSoundOverridesDir: () => null,
      getSoundUrl: (soundName) => `file:///${soundName}.mp3?base=1`,
      listThemesWithMetadata: () => [],
      getThemeMetadata: () => null,
    },
    now: () => 987,
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:preview-sound", { soundName: "complete" }), {
    status: "ok",
  });
  assert.deepStrictEqual(calls, [
    ["sendToRenderer", "play-sound", { url: "file:///complete.mp3?base=1&_t=987", volume: 0.4 }],
  ]);

  const muted = createHarness({ getSoundMuted: () => true });
  assert.deepStrictEqual(await muted.ipcMain.invoke("settings:preview-sound", { soundName: "complete" }), {
    status: "skipped",
    reason: "muted",
  });

  const dnd = createHarness({ getDoNotDisturb: () => true });
  assert.deepStrictEqual(await dnd.ipcMain.invoke("settings:preview-sound", { soundName: "complete" }), {
    status: "skipped",
    reason: "dnd",
  });
});

test("settings IPC serves agent/about/update/external and remove-theme dialog helpers", async () => {
  const root = makeTempDir();
  try {
    const heroSvgPath = path.join(root, "hero.svg");
    fs.writeFileSync(heroSvgPath, "<svg id=\"hero\"></svg>", "utf8");
    let messageBoxParent = null;
    let messageBoxOptions = null;
    const { ipcMain, calls, settingsWindow } = createHarness({
      aboutHeroSvgPath: heroSvgPath,
      getLang: () => "en",
      dialog: {
        showOpenDialog: async () => ({ canceled: true }),
        showMessageBox: async (parent, options) => {
          messageBoxParent = parent;
          messageBoxOptions = options;
          return { response: 0 };
        },
      },
      themeLoader: {
        getPreviewSoundUrl: () => "file:///preview.mp3",
        getSoundOverridesDir: () => null,
        getSoundUrl: () => null,
        listThemesWithMetadata: () => [],
        getThemeMetadata: (themeId) => ({ name: `Theme ${themeId}` }),
      },
      getAllAgents: () => [
        { id: "codex", name: "Codex", eventSource: "hook", capabilities: { permission: true } },
        { id: "claude-code", name: "Claude Code", eventSource: "hook", capabilities: {} },
        { id: "qwen-code", name: "Qwen Code", eventSource: "hook", capabilities: {} },
      ],
      getHookServerPort: () => 23335,
      getRecentHookEvents: ({ agentId }) => [{
        timestamp: 12345,
        agentId,
        eventType: "PreToolUse",
        route: "state",
        outcome: "accepted",
      }],
      settingsController: {
        getSnapshot: () => ({
          lang: "en",
          customApplications: [{
            id: "custom-nova-ai-0123456789ab",
            name: "Nova AI",
            sourcePath: "C:\\NovaAI",
            executablePath: "C:\\NovaAI\\NovaAI.exe",
            processName: "NovaAI.exe",
            category: "code",
          }],
        }),
        applyUpdate: () => ({ status: "ok" }),
        applyCommand: async () => ({ status: "ok" }),
      },
    });

    assert.strictEqual(await ipcMain.invoke("settings:get-preview-sound-url"), "file:///preview.mp3");
    assert.deepStrictEqual(await ipcMain.invoke("settings:list-agents"), [
      // #895: cleanupSuggestionExempt is derived from prefs' complete default-
      // integration list. Both defaults must ship true, while a non-default
      // agent must ship an explicit false before the renderer may propose
      // removing its hooks. This three-way contract kills all-true, all-false,
      // and Codex-only producer mutations.
      {
        id: "codex",
        name: "Codex",
        eventSource: "hook",
        capabilities: { permission: true },
        cleanupSuggestionExempt: true,
      },
      {
        id: "claude-code",
        name: "Claude Code",
        eventSource: "hook",
        capabilities: {},
        cleanupSuggestionExempt: true,
      },
      {
        id: "qwen-code",
        name: "Qwen Code",
        eventSource: "hook",
        capabilities: {},
        cleanupSuggestionExempt: false,
      },
      {
        id: "custom-nova-ai-0123456789ab",
        name: "Nova AI",
        category: "code",
        eventSource: "custom-http",
        custom: true,
        sourcePath: "C:\\NovaAI",
        executablePath: "C:\\NovaAI\\NovaAI.exe",
        processName: "NovaAI.exe",
        stateEndpoint: "http://127.0.0.1:23335/state",
        lastStateEvent: { timestamp: 12345, eventType: "PreToolUse" },
        capabilities: {
          httpHook: true,
          permissionApproval: false,
          interactiveBubble: false,
          notificationHook: true,
          sessionEnd: true,
          subagent: false,
          managedIntegration: false,
        },
      },
    ]);
    assert.deepStrictEqual(await ipcMain.invoke("settings:get-about-info"), {
      version: "1.2.3",
      repoUrl: "https://github.com/rullerzhou-afk/clawd-on-desk",
      license: "AGPL-3.0",
      copyright: "\u00a9 2026 Ruller_Lulu",
      authorName: "Ruller_Lulu / \u9e7f\u9e7f",
      authorUrl: "https://github.com/rullerzhou-afk",
      heroSvgContent: "<svg id=\"hero\"></svg>",
      pendingUpdateVersion: "",
      autoUpdateCheck: true,
      updateCheckSnapshot: { state: "idle" },
    });
    assert.deepStrictEqual(await ipcMain.invoke("settings:confirm-remove-theme", "user-theme"), {
      confirmed: true,
    });
    assert.deepStrictEqual(messageBoxParent, { id: "parent", sender: settingsWindow.webContents });
    assert.strictEqual(messageBoxOptions.message, 'Delete theme "Theme user-theme"?');
    assert.deepStrictEqual(await ipcMain.invoke("settings:check-for-updates"), {
      state: "up-to-date",
      version: "1.2.3",
    });
    assert.deepStrictEqual(await ipcMain.invoke("settings:clear-update-error"), { state: "idle" });
    assert.deepStrictEqual(await ipcMain.invoke("settings:copy-update-error", "safe report"), { status: "ok" });
    assert.deepStrictEqual(await ipcMain.invoke("settings:open-external", "file:///tmp"), {
      status: "error",
      message: "Invalid URL",
    });
    assert.deepStrictEqual(await ipcMain.invoke("settings:open-external", "https://example.test"), {
      status: "ok",
    });
    assert.deepStrictEqual(calls, [
      ["checkForUpdates", true],
      ["copyUpdateError", "safe report"],
      ["openExternal", "https://example.test"],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("settings IPC picks executable files and installation folders for discovery", async () => {
  const selections = ["C:\\Tools\\agent.exe", "C:\\Tools\\Agent"];
  const optionsSeen = [];
  const { ipcMain } = createHarness({
    dialog: {
      showOpenDialog: async (_parent, options) => {
        optionsSeen.push(options);
        return { canceled: false, filePaths: [selections[optionsSeen.length - 1]] };
      },
      showMessageBox: async () => ({ response: 1 }),
    },
  });

  assert.deepStrictEqual(await ipcMain.invoke("settings:pick-agent-discovery-path", { kind: "file" }), {
    status: "ok",
    path: selections[0],
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:pick-agent-discovery-path", { kind: "directory" }), {
    status: "ok",
    path: selections[1],
  });
  assert.deepStrictEqual(optionsSeen.map((options) => options.properties), [["openFile"], ["openDirectory"]]);
  assert.deepStrictEqual(await ipcMain.invoke("settings:pick-agent-discovery-path", { kind: "anything" }), {
    status: "error",
    message: "pickAgentDiscoveryPath.kind must be file or directory",
  });
});

test("settings IPC exposes read-only agent installation detection", async () => {
  let sawFs = false;
  let sawPath = false;
  const { ipcMain, runtime } = createHarness({
    now: () => 777,
    detectAgentInstallations: (options) => {
      sawFs = !!options.fs;
      sawPath = !!options.path;
      return {
        checkedAt: options.now(),
        agents: [{ agentId: "qwen-code", detectedInstalled: true }],
        skippedAgentIds: ["claude-code"],
      };
    },
  });

  assert.deepStrictEqual(await ipcMain.invoke("settings:detect-agent-installations"), {
    checkedAt: 777,
    agents: [{ agentId: "qwen-code", detectedInstalled: true }],
    skippedAgentIds: ["claude-code"],
  });
  assert.strictEqual(sawFs, true);
  assert.strictEqual(sawPath, true);

  runtime.dispose();
});

// #895 T11d: asserted through the real detector against a throwaway home, so it
// pins the behaviour the Settings page depends on rather than which option keys
// happen to be passed. Codex must reach the Agents tab; Claude must not, because
// Clawd's own sync creates ~/.claude and its presence proves nothing. Settings
// previously withheld both, and the catalog then labelled the ones it had never
// examined as "not detected locally".
test("settings IPC scan examines Codex locally and still withholds Claude", async () => {
  const { detectAgentInstallations: realDetect } = require("../src/agent-installation-detector");
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-ipc-detect-"));
  fs.mkdirSync(path.join(homeDir, ".codex"));
  const { ipcMain, runtime } = createHarness({
    detectAgentInstallations: (options) => realDetect({ ...options, homeDir, platform: "darwin", env: {} }),
  });

  try {
    const report = await ipcMain.invoke("settings:detect-agent-installations");
    const ids = report.agents.map((entry) => entry.agentId);

    assert.ok(ids.includes("codex"), "Codex must be examined by the Settings scan");
    assert.ok(!ids.includes("claude-code"), "Claude stays withheld");
    assert.deepStrictEqual(report.skippedAgentIds, ["claude-code"]);

    const codex = report.agents.find((entry) => entry.agentId === "codex");
    assert.strictEqual(codex.detectedInstalled, true);
    assert.strictEqual(codex.reason, "parent-dir");
  } finally {
    runtime.dispose();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
