const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const createSettingsWindowRuntime = require("../src/settings-window");

class FakeBrowserWindow {
  static instances = [];

  constructor(options) {
    this.options = options;
    this.destroyed = false;
    this.minimized = false;
    this.calls = [];
    this.events = new Map();
    this.onceEvents = new Map();
    FakeBrowserWindow.instances.push(this);
  }

  isDestroyed() {
    return this.destroyed;
  }

  isMinimized() {
    return this.minimized;
  }

  restore() {
    this.calls.push("restore");
    this.minimized = false;
  }

  show() {
    this.calls.push("show");
  }

  moveTop() {
    this.calls.push("moveTop");
  }

  focus() {
    this.calls.push("focus");
  }

  setAlwaysOnTop(value, level) {
    this.calls.push(["setAlwaysOnTop", value, level]);
    this.alwaysOnTop = value;
    this.alwaysOnTopLevel = level;
  }

  setAppDetails(details) {
    this.calls.push("setAppDetails");
    this.appDetails = details;
  }

  setMenuBarVisibility(value) {
    this.calls.push(["setMenuBarVisibility", value]);
    this.menuBarVisible = value;
  }

  loadFile(filePath) {
    this.calls.push(["loadFile", filePath]);
    this.loadedFile = filePath;
  }

  once(eventName, listener) {
    this.onceEvents.set(eventName, listener);
  }

  on(eventName, listener) {
    this.events.set(eventName, listener);
  }

  emit(eventName) {
    const onceListener = this.onceEvents.get(eventName);
    if (onceListener) {
      this.onceEvents.delete(eventName);
      onceListener();
    }
    const listener = this.events.get(eventName);
    if (listener) listener();
  }
}

function createFakeApp({ ready = true, packaged = false } = {}) {
  const listeners = new Map();
  return {
    app: {
      isPackaged: packaged,
      isReady: () => ready,
      getAppPath: () => "C:\\app",
      once(eventName, listener) {
        listeners.set(eventName, listener);
      },
    },
    listeners,
  };
}

function createFakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
  };
}

function findPendingTimer(timers, delay) {
  return timers.find((timer) => timer.delay === delay && !timer.cleared);
}

function createRuntime(options = {}) {
  FakeBrowserWindow.instances = [];
  const { app, listeners } = createFakeApp(options.app);
  const fakeTimers = createFakeTimers();
  const fs = {
    existsSync(filePath) {
      return /assets[\\/](icons[\\/]256x256\.png|icon\.ico)$/.test(filePath);
    },
  };
  const runtime = createSettingsWindowRuntime({
    app,
    BrowserWindow: FakeBrowserWindow,
    fs,
    isWin: true,
    nativeTheme: { shouldUseDarkColors: !!options.dark },
    path: path.win32,
    platform: "win32",
    resourcesPath: "C:\\resources",
    execPath: "C:\\electron\\electron.exe",
    appDir: "C:\\app",
    settingsHtmlPath: "C:\\app\\src\\settings.html",
    preloadPath: "C:\\app\\src\\preload-settings.js",
    setTimeout: fakeTimers.setTimeout,
    clearTimeout: fakeTimers.clearTimeout,
    ...options.runtime,
  });
  return { runtime, listeners, timers: fakeTimers.timers };
}

test("settings window runtime creates the Settings BrowserWindow with taskbar identity", () => {
  const events = [];
  let runtime;
  let timers;
  ({ runtime, timers } = createRuntime({
    dark: true,
    runtime: {
      onBeforeCreate: () => events.push("before-create"),
      onBeforeClosed: () => events.push("before-closed"),
      onAfterClosed: () => events.push(runtime.getWindow() === null ? "after-closed-null" : "after-closed-live"),
    },
  }));

  runtime.open();
  assert.strictEqual(FakeBrowserWindow.instances.length, 1);
  const win = FakeBrowserWindow.instances[0];

  assert.strictEqual(runtime.getWindow(), win);
  assert.strictEqual(win.options.title, "Clawd Settings");
  assert.strictEqual(win.options.x, 240);
  assert.strictEqual(win.options.y, 120);
  assert.strictEqual(win.options.width, 800);
  assert.strictEqual(win.options.height, 560);
  assert.strictEqual(win.options.backgroundColor, "#1c1c1f");
  assert.strictEqual(win.options.webPreferences.preload, "C:\\app\\src\\preload-settings.js");
  assert.strictEqual(win.options.webPreferences.nodeIntegration, false);
  assert.strictEqual(win.options.webPreferences.contextIsolation, true);
  assert.match(win.options.icon, /assets[\\/]icons[\\/]256x256\.png$/);
  assert.strictEqual(win.menuBarVisible, false);
  assert.strictEqual(win.loadedFile, "C:\\app\\src\\settings.html");
  assert.match(win.appDetails.appIconPath, /assets[\\/]icon\.ico$/);
  assert.ok(win.appDetails.relaunchCommand.includes("--open-settings-window"));
  assert.deepStrictEqual(events, ["before-create"]);

  win.emit("ready-to-show");
  assert.deepStrictEqual(win.calls.slice(-4), [
    "show",
    ["setAlwaysOnTop", true, undefined],
    "moveTop",
    "focus",
  ]);
  assert.strictEqual(findPendingTimer(timers, 2000), undefined);

  const lowerTimer = findPendingTimer(timers, 200);
  assert.ok(lowerTimer);
  lowerTimer.callback();
  assert.deepStrictEqual(win.calls.at(-1), ["setAlwaysOnTop", false, undefined]);

  win.emit("closed");
  assert.deepStrictEqual(events, ["before-create", "before-closed", "after-closed-null"]);
  assert.strictEqual(runtime.getWindow(), null);
});

test("settings window runtime reuses an existing non-destroyed Settings window", () => {
  const { runtime, timers } = createRuntime();
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  win.emit("ready-to-show");
  findPendingTimer(timers, 200).callback();
  win.calls = [];
  win.minimized = true;

  runtime.open();

  assert.strictEqual(FakeBrowserWindow.instances.length, 1);
  assert.deepStrictEqual(win.calls, [
    "restore",
    "show",
    ["setAlwaysOnTop", true, undefined],
    "moveTop",
    "focus",
  ]);
});

test("settings window runtime defers opening until Electron is ready", () => {
  const { runtime, listeners } = createRuntime({ app: { ready: false } });

  runtime.openWhenReady();

  assert.strictEqual(FakeBrowserWindow.instances.length, 0);
  assert.strictEqual(typeof listeners.get("ready"), "function");

  listeners.get("ready")();

  assert.strictEqual(FakeBrowserWindow.instances.length, 1);
});

test("settings window runtime places the first Settings window on the pet display", () => {
  let nearestArgs = null;
  const { runtime } = createRuntime({
    runtime: {
      getPetWindowBounds: () => ({ x: 1700, y: 100, width: 280, height: 280 }),
      getNearestWorkArea: (cx, cy) => {
        nearestArgs = { cx, cy };
        return { x: 1280, y: 40, width: 1600, height: 900 };
      },
    },
  });

  runtime.open();
  const win = FakeBrowserWindow.instances[0];

  assert.deepStrictEqual(nearestArgs, { cx: 1840, cy: 240 });
  assert.strictEqual(win.options.x, 1680);
  assert.strictEqual(win.options.y, 210);
  assert.strictEqual(win.options.width, 800);
  assert.strictEqual(win.options.height, 560);
});

test("settings window runtime shows from timeout if ready-to-show never fires", () => {
  const { runtime, timers } = createRuntime();

  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  const readyFallbackTimer = findPendingTimer(timers, 2000);
  assert.ok(readyFallbackTimer);

  readyFallbackTimer.callback();
  assert.deepStrictEqual(win.calls.slice(-4), [
    "show",
    ["setAlwaysOnTop", true, undefined],
    "moveTop",
    "focus",
  ]);

  win.calls = [];
  win.emit("ready-to-show");
  assert.deepStrictEqual(win.calls, []);
});

test("settings window runtime does not show twice if reopened before ready", () => {
  const { runtime, timers } = createRuntime();

  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  runtime.open();

  assert.deepStrictEqual(win.calls.slice(-4), [
    "show",
    ["setAlwaysOnTop", true, undefined],
    "moveTop",
    "focus",
  ]);
  assert.strictEqual(findPendingTimer(timers, 2000), undefined);

  win.calls = [];
  win.emit("ready-to-show");
  assert.deepStrictEqual(win.calls, []);
});

test("settings window runtime skips temporary front lift outside Windows", () => {
  const { runtime } = createRuntime({
    runtime: {
      isWin: false,
      platform: "linux",
    },
  });

  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  win.emit("ready-to-show");

  assert.deepStrictEqual(win.calls.slice(-3), ["show", "moveTop", "focus"]);
  assert.strictEqual(win.calls.some((call) => Array.isArray(call) && call[0] === "setAlwaysOnTop"), false);
});
