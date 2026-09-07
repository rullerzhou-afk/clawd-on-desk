"use strict";

const test = require("node:test");
const assert = require("node:assert");

const createShortcutRuntime = require("../src/shortcut-runtime");

class FakeIpcMain {
  constructor() {
    this.handlers = new Map();
  }

  handle(channel, listener) {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel) {
    this.handlers.delete(channel);
  }

  invoke(channel, ...args) {
    const listener = this.handlers.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC handler ${channel}`);
    return listener({}, ...args);
  }
}

class FakeWebContents {
  constructor() {
    this.destroyed = false;
    this.listeners = new Map();
    this.sent = [];
  }

  isDestroyed() {
    return this.destroyed;
  }

  on(channel, listener) {
    this.listeners.set(channel, listener);
  }

  removeListener(channel, listener) {
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
  }

  send(channel, payload) {
    this.sent.push([channel, payload]);
  }

  emitBeforeInput(input) {
    const listener = this.listeners.get("before-input-event");
    assert.strictEqual(typeof listener, "function", "missing before-input-event listener");
    let prevented = false;
    listener({ preventDefault: () => { prevented = true; } }, input);
    return prevented;
  }
}

class FakeSettingsWindow {
  constructor() {
    this.destroyed = false;
    this.webContents = new FakeWebContents();
  }

  isDestroyed() {
    return this.destroyed;
  }
}

function createGlobalShortcut(options = {}) {
  const registered = new Map();
  const calls = [];
  return {
    calls,
    registered,
    register(accelerator, handler) {
      calls.push(["register", accelerator]);
      if (options.throwRegister && options.throwRegister(accelerator)) {
        throw new Error("register boom");
      }
      if (options.failRegister && options.failRegister(accelerator)) return false;
      registered.set(accelerator, handler);
      return true;
    },
    unregister(accelerator) {
      calls.push(["unregister", accelerator]);
      registered.delete(accelerator);
    },
    isRegistered(accelerator) {
      calls.push(["isRegistered", accelerator]);
      return registered.has(accelerator);
    },
  };
}

function createRuntime(options = {}) {
  const ipcMain = new FakeIpcMain();
  const settingsWindow = options.settingsWindow === undefined
    ? new FakeSettingsWindow()
    : options.settingsWindow;
  const snapshot = options.snapshot || {
    shortcuts: { togglePet: "CommandOrControl+Shift+Alt+C" },
  };
  const globalShortcut = options.globalShortcut || createGlobalShortcut();
  const togglePetCalls = [];
  const runtime = createShortcutRuntime({
    ipcMain,
    globalShortcut,
    settingsController: {
      getSnapshot: () => snapshot,
    },
    getSettingsWindow: () => settingsWindow,
    shortcutHandlers: {
      togglePet: () => togglePetCalls.push("togglePet"),
      quickSelectSession: () => {},
    },
  });
  return { globalShortcut, ipcMain, runtime, settingsWindow, togglePetCalls };
}

test("shortcut runtime owns settings shortcut IPC channels and disposes them", async () => {
  const { globalShortcut, ipcMain, runtime, settingsWindow } = createRuntime();

  assert.ok(ipcMain.handlers.has("settings:getShortcutFailures"));
  assert.ok(ipcMain.handlers.has("settings:enterShortcutRecording"));
  assert.ok(ipcMain.handlers.has("settings:exitShortcutRecording"));
  assert.deepStrictEqual(await ipcMain.invoke("settings:getShortcutFailures"), {});

  globalShortcut.registered.set("CommandOrControl+Shift+Alt+C", () => {});
  assert.deepStrictEqual(
    await ipcMain.invoke("settings:enterShortcutRecording", "togglePet"),
    { status: "ok" }
  );
  assert.deepStrictEqual(globalShortcut.calls.slice(-2), [
    ["isRegistered", "CommandOrControl+Shift+Alt+C"],
    ["unregister", "CommandOrControl+Shift+Alt+C"],
  ]);

  const prevented = settingsWindow.webContents.emitBeforeInput({
    type: "keyDown",
    key: "K",
    code: "KeyK",
    alt: true,
    control: true,
    meta: false,
    shift: true,
  });
  assert.strictEqual(prevented, true);
  assert.deepStrictEqual(settingsWindow.webContents.sent, [[
    "shortcut-record-key",
    {
      actionId: "togglePet",
      key: "K",
      code: "KeyK",
      altKey: true,
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
    },
  ]]);

  assert.deepStrictEqual(await ipcMain.invoke("settings:exitShortcutRecording"), { status: "ok" });
  assert.deepStrictEqual(globalShortcut.calls.slice(-1), [
    ["register", "CommandOrControl+Shift+Alt+C"],
  ]);
  assert.strictEqual(settingsWindow.webContents.listeners.has("before-input-event"), false);

  runtime.dispose();
  assert.strictEqual(ipcMain.handlers.size, 0);
});

test("shortcut runtime broadcasts persistent registration failures and clears them", () => {
  const globalShortcut = createGlobalShortcut({
    failRegister: (accelerator) => accelerator === "CommandOrControl+Shift+Alt+C",
  });
  const { runtime, settingsWindow } = createRuntime({ globalShortcut });

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    runtime.registerPersistentShortcutsFromSettings();
  } finally {
    console.warn = originalWarn;
  }

  assert.deepStrictEqual(runtime.getFailures(), { togglePet: "system conflict" });
  assert.deepStrictEqual(warnings, [
    "Clawd: failed to register shortcut togglePet: CommandOrControl+Shift+Alt+C",
  ]);
  assert.deepStrictEqual(settingsWindow.webContents.sent, [[
    "shortcut-failures-changed",
    { togglePet: "system conflict" },
  ]]);

  globalShortcut.calls.length = 0;
  globalShortcut.register = (accelerator, handler) => {
    globalShortcut.calls.push(["register", accelerator]);
    globalShortcut.registered.set(accelerator, handler);
    return true;
  };
  runtime.registerPersistentShortcutsFromSettings();

  assert.deepStrictEqual(runtime.getFailures(), {});
  assert.deepStrictEqual(settingsWindow.webContents.sent.slice(-1), [[
    "shortcut-failures-changed",
    {},
  ]]);
});

test("shortcut runtime restores a persisted macOS Control accelerator on startup", () => {
  const { runtime, globalShortcut } = createRuntime({
    snapshot: { shortcuts: { togglePet: "Control+Shift+1" } },
  });

  runtime.registerPersistentShortcutsFromSettings();

  assert.deepStrictEqual(globalShortcut.calls, [
    ["register", "Control+Shift+1"],
  ]);
  assert.ok(globalShortcut.registered.has("Control+Shift+1"));
});

test("shortcut runtime deduplicates failure broadcasts and ignores empty clears", () => {
  const { runtime, settingsWindow } = createRuntime();

  runtime.clearFailure("togglePet");
  assert.deepStrictEqual(settingsWindow.webContents.sent, []);

  runtime.reportFailure("togglePet", "system conflict");
  runtime.reportFailure("togglePet", "system conflict");

  assert.deepStrictEqual(runtime.getFailures(), { togglePet: "system conflict" });
  assert.deepStrictEqual(settingsWindow.webContents.sent, [[
    "shortcut-failures-changed",
    { togglePet: "system conflict" },
  ]]);
});

test("shortcut runtime treats thrown globalShortcut registration as a system conflict", () => {
  const globalShortcut = createGlobalShortcut({
    throwRegister: (accelerator) => accelerator === "CommandOrControl+Shift+Alt+C",
  });
  const { runtime, settingsWindow } = createRuntime({ globalShortcut });

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    runtime.registerPersistentShortcutsFromSettings();
  } finally {
    console.warn = originalWarn;
  }

  assert.deepStrictEqual(runtime.getFailures(), { togglePet: "system conflict" });
  assert.deepStrictEqual(settingsWindow.webContents.sent, [[
    "shortcut-failures-changed",
    { togglePet: "system conflict" },
  ]]);
});

test("shortcut runtime clears stale failures when a persistent shortcut has no accelerator", () => {
  const { runtime, settingsWindow, globalShortcut } = createRuntime({
    snapshot: { shortcuts: { togglePet: null } },
  });

  runtime.reportFailure("togglePet", "system conflict");
  runtime.registerPersistentShortcutsFromSettings();

  assert.deepStrictEqual(runtime.getFailures(), {});
  assert.deepStrictEqual(globalShortcut.calls, []);
  assert.deepStrictEqual(settingsWindow.webContents.sent, [
    ["shortcut-failures-changed", { togglePet: "system conflict" }],
    ["shortcut-failures-changed", {}],
  ]);
});

test("shortcut runtime does not restore an accelerator when recording had no temp unregister", async () => {
  const { globalShortcut, ipcMain } = createRuntime();

  assert.deepStrictEqual(
    await ipcMain.invoke("settings:enterShortcutRecording", "togglePet"),
    { status: "ok" }
  );
  assert.deepStrictEqual(globalShortcut.calls, [
    ["isRegistered", "CommandOrControl+Shift+Alt+C"],
  ]);

  assert.deepStrictEqual(await ipcMain.invoke("settings:exitShortcutRecording"), { status: "ok" });
  assert.deepStrictEqual(globalShortcut.calls, [
    ["isRegistered", "CommandOrControl+Shift+Alt+C"],
  ]);
});

test("shortcut recording temporarily unregisters and restores every persistent shortcut", async () => {
  const toggle = "CommandOrControl+Shift+Alt+C";
  const quickSelect = "CommandOrControl+Shift+J";
  const { globalShortcut, ipcMain } = createRuntime({
    snapshot: {
      shortcuts: {
        togglePet: toggle,
        quickSelectSession: quickSelect,
      },
    },
  });
  globalShortcut.registered.set(toggle, () => {});
  globalShortcut.registered.set(quickSelect, () => {});

  assert.deepStrictEqual(
    await ipcMain.invoke("settings:enterShortcutRecording", "permissionAllow"),
    { status: "ok" }
  );
  assert.deepStrictEqual(globalShortcut.calls, [
    ["isRegistered", toggle],
    ["unregister", toggle],
    ["isRegistered", quickSelect],
    ["unregister", quickSelect],
  ]);

  assert.deepStrictEqual(await ipcMain.invoke("settings:exitShortcutRecording"), { status: "ok" });
  assert.deepStrictEqual(globalShortcut.calls.slice(-2), [
    ["register", toggle],
    ["register", quickSelect],
  ]);
});

test("shortcut runtime preserves validation and unavailable-window errors", async () => {
  const { ipcMain } = createRuntime({ settingsWindow: null });

  assert.deepStrictEqual(await ipcMain.invoke("settings:enterShortcutRecording", "missing"), {
    status: "error",
    message: "unknown shortcut action",
  });
  assert.deepStrictEqual(await ipcMain.invoke("settings:enterShortcutRecording", "togglePet"), {
    status: "error",
    message: "settings window unavailable",
  });
});
