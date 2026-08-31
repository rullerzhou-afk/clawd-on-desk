const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const createSettingsWindowRuntime = require("../src/settings-window");

class FakeBrowserWindow {
  static instances = [];
  static constructorBoundsOffset = null;
  static setBoundsOffset = null;

  constructor(options) {
    const offset = FakeBrowserWindow.constructorBoundsOffset || {};
    this.options = options;
    this.bounds = {
      x: options.x + (offset.x || 0),
      y: options.y + (offset.y || 0),
      width: options.width + (offset.width || 0),
      height: options.height + (offset.height || 0),
    };
    this.normalBounds = { ...this.bounds };
    this.destroyed = false;
    this.minimized = false;
    this.calls = [];
    this.events = new Map();
    this.onceEvents = new Map();
    // Minimal webContents so the production-critical did-finish-load title
    // reapply callback (settings-window.js) is exercisable. insertCSS is
    // intentionally absent — applyZoomToWindow bails safely without it.
    this.webContents = {
      isDestroyed: () => false,
      onceCallbacks: new Map(),
      once: (event, cb) => this.webContents.onceCallbacks.set(event, cb),
      send: (channel, payload) => this.calls.push(["send", channel, payload]),
    };
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

  setTitle(value) {
    this.calls.push(["setTitle", value]);
    this.title = value;
  }

  getBounds() {
    return { ...this.bounds };
  }

  getNormalBounds() {
    return { ...this.normalBounds };
  }

  setBounds(bounds) {
    this.calls.push(["setBounds", bounds]);
    const offset = FakeBrowserWindow.setBoundsOffset || {};
    this.bounds = {
      x: bounds.x + (offset.x || 0),
      y: bounds.y + (offset.y || 0),
      width: bounds.width + (offset.width || 0),
      height: bounds.height + (offset.height || 0),
    };
    this.normalBounds = { ...this.bounds };
  }

  setMinimumSize(width, height) {
    this.calls.push(["setMinimumSize", width, height]);
    this.minimumSize = { width, height };
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

  emitWebContents(eventName) {
    const cb = this.webContents.onceCallbacks.get(eventName);
    if (cb) {
      this.webContents.onceCallbacks.delete(eventName);
      cb();
    }
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
  FakeBrowserWindow.constructorBoundsOffset = options.constructorBoundsOffset || null;
  FakeBrowserWindow.setBoundsOffset = options.setBoundsOffset || null;
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
  assert.deepStrictEqual(win.options.webPreferences.additionalArguments, [
    "--discord-default-app-id-present=0",
  ]);
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

test("settings window uses and refreshes the localized title", () => {
  let title = "Clawd 设置";
  const { runtime } = createRuntime({ runtime: { getTitle: () => title } });

  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  assert.strictEqual(win.options.title, "Clawd 设置");

  title = "Clawd 設定";
  runtime.applyTitleToWindow();
  assert.strictEqual(win.title, "Clawd 設定");
});

test("did-finish-load reapplies the localized title after the HTML <title> loads", () => {
  // The HTML page ships a fixed English <title>, which Electron applies once
  // the document loads. The did-finish-load callback must reapply the localized
  // native title so the title bar never reverts to English mid-session.
  let title = "Clawd 设置";
  const { runtime } = createRuntime({ runtime: { getTitle: () => title } });

  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  assert.strictEqual(win.options.title, "Clawd 设置");

  // Simulate the page finishing load with a new localized title in effect.
  win.calls = [];
  title = "Clawd 設定";
  win.emitWebContents("did-finish-load");

  assert.deepStrictEqual(
    win.calls.at(-1),
    ["setTitle", "Clawd 設定"],
    "localized title reapplied after did-finish-load",
  );
});

test("settings window injects the Discord default-App-ID flag into the sandboxed preload", () => {
  // The flag can't be require()'d in a sandboxed preload, so it must ride
  // additionalArguments. A missing/drifted injection here blanked the entire
  // Settings window once — this guards both the presence and the "1"/"0" value.
  const present = createRuntime({ runtime: { discordDefaultAppIdPresent: true } });
  present.runtime.open();
  assert.deepStrictEqual(
    FakeBrowserWindow.instances[0].options.webPreferences.additionalArguments,
    ["--discord-default-app-id-present=1"],
  );

  const absent = createRuntime({ runtime: { discordDefaultAppIdPresent: false } });
  absent.runtime.open();
  assert.deepStrictEqual(
    FakeBrowserWindow.instances[0].options.webPreferences.additionalArguments,
    ["--discord-default-app-id-present=0"],
  );
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

test("settings window holds a requested recap tab until the new renderer is ready", () => {
  const { runtime } = createRuntime();
  runtime.open({ tab: "recap" });
  const win = FakeBrowserWindow.instances[0];
  assert.equal(win.calls.some((call) => Array.isArray(call) && call[0] === "send"), false);

  win.emitWebContents("did-finish-load");
  assert.deepStrictEqual(win.calls.find((call) => Array.isArray(call) && call[0] === "send"), [
    "send",
    "settings:select-tab",
    "recap",
  ]);
});

test("settings window coalesces live recap changes after the renderer is ready", () => {
  const { runtime, timers } = createRuntime();
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  assert.equal(runtime.notifyRecapChanged(), false);
  assert.equal(timers.some((timer) => timer.delay === 500 && !timer.cleared), false);
  win.emitWebContents("did-finish-load");
  win.calls = [];

  assert.equal(runtime.notifyRecapChanged(), true);
  assert.equal(runtime.notifyRecapChanged(), false);
  const refreshTimers = timers.filter((timer) => timer.delay === 500 && !timer.cleared);
  assert.equal(refreshTimers.length, 1);
  assert.equal(win.calls.length, 0);

  refreshTimers[0].callback();
  assert.deepStrictEqual(win.calls, [["send", "settings:recap-changed", undefined]]);
});

test("settings window deep-link survives a reopen before load and reaches a minimized live window", () => {
  const { runtime, timers } = createRuntime();
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  runtime.open({ tab: "recap" });
  assert.equal(win.calls.some((call) => Array.isArray(call) && call[0] === "send"), false);
  win.emitWebContents("did-finish-load");
  assert.deepStrictEqual(win.calls.find((call) => Array.isArray(call) && call[0] === "send"), [
    "send",
    "settings:select-tab",
    "recap",
  ]);

  win.emit("ready-to-show");
  const lift = findPendingTimer(timers, 200);
  if (lift) lift.callback();
  win.calls = [];
  win.minimized = true;
  runtime.open({ tab: "recap" });
  assert.deepStrictEqual(win.calls, [
    ["send", "settings:select-tab", "recap"],
    "restore",
    "show",
    ["setAlwaysOnTop", true, undefined],
    "moveTop",
    "focus",
  ]);
});

test("ordinary or invalid Settings opens never send a forced tab", () => {
  const { runtime } = createRuntime();
  runtime.open({ tab: "not-a-real-tab" });
  const win = FakeBrowserWindow.instances[0];
  win.emitWebContents("did-finish-load");
  runtime.open();
  assert.equal(win.calls.some((call) => Array.isArray(call) && call[0] === "send"), false);
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

test("settings window runtime restores saved bounds on the saved display", () => {
  let nearestArgs = null;
  let petBoundsReads = 0;
  const scaleBounds = [];
  const saved = { x: 1480, y: 90, width: 900, height: 650 };
  const { runtime } = createRuntime({
    runtime: {
      getSavedBounds: () => saved,
      getPetWindowBounds: () => {
        petBoundsReads += 1;
        return { x: 10, y: 10, width: 100, height: 100 };
      },
      getNearestWorkArea: (cx, cy) => {
        nearestArgs = { cx, cy };
        return { x: 1280, y: 40, width: 1600, height: 900 };
      },
      getTextScale: (bounds) => {
        scaleBounds.push(bounds);
        return 1;
      },
    },
  });

  runtime.open();
  const win = FakeBrowserWindow.instances[0];

  assert.deepStrictEqual(nearestArgs, { cx: 1930, cy: 415 });
  assert.strictEqual(petBoundsReads, 0);
  assert.deepStrictEqual(
    { x: win.options.x, y: win.options.y, width: win.options.width, height: win.options.height },
    saved,
  );
  assert.deepStrictEqual(scaleBounds, [saved, saved]);
});

test("saved outer bounds override native constructor frame drift", () => {
  const saved = { x: 120, y: 90, width: 960, height: 720 };
  const { runtime } = createRuntime({
    constructorBoundsOffset: { width: 2 },
    runtime: {
      getSavedBounds: () => saved,
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
    },
  });

  runtime.open();
  const win = FakeBrowserWindow.instances[0];

  assert.deepStrictEqual(win.getBounds(), saved);
  assert.deepStrictEqual(
    win.calls.find((call) => Array.isArray(call) && call[0] === "setBounds"),
    ["setBounds", saved],
  );
});

test("an untouched window does not persist native frame quantization on close", () => {
  const saved = { x: 120, y: 90, width: 960, height: 720 };
  const writes = [];
  const { runtime } = createRuntime({
    constructorBoundsOffset: { width: 2 },
    // Simulate a WM that cannot adopt the requested outer width exactly even
    // when the runtime follows up with setBounds().
    setBoundsOffset: { width: 1 },
    runtime: {
      getSavedBounds: () => saved,
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
      onSaveBounds: (bounds) => {
        writes.push(bounds);
        return { status: "ok" };
      },
    },
  });

  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  assert.deepStrictEqual(win.getNormalBounds(), { ...saved, width: 961 });

  win.emit("close");
  assert.deepStrictEqual(writes, []);
});

test("saved Settings bounds are clamped to a live work area and current scaled minimum", () => {
  const { runtime } = createRuntime({
    runtime: {
      getSavedBounds: () => ({ x: 2800, y: 900, width: 600, height: 400 }),
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 1200, height: 700 }),
      getTextScale: () => 1.25,
    },
  });

  runtime.open();
  const win = FakeBrowserWindow.instances[0];

  assert.deepStrictEqual(
    { x: win.options.x, y: win.options.y, width: win.options.width, height: win.options.height },
    { x: 400, y: 100, width: 800, height: 600 },
  );
  assert.strictEqual(win.options.minWidth, 800);
  assert.strictEqual(win.options.minHeight, 600);
});

test("saved Settings bounds clamp correctly on a negative-origin display", () => {
  const { runtime } = createRuntime({
    runtime: {
      getSavedBounds: () => ({ x: -2600, y: -180, width: 900, height: 650 }),
      getNearestWorkArea: () => ({ x: -1920, y: 0, width: 1920, height: 1040 }),
      getTextScale: () => 1,
    },
  });

  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  assert.deepStrictEqual(
    { x: win.options.x, y: win.options.y, width: win.options.width, height: win.options.height },
    { x: -1920, y: 0, width: 900, height: 650 },
  );
});

test("a tiny work area caps both restored bounds and BrowserWindow minimums", () => {
  const { runtime } = createRuntime({
    runtime: {
      getSavedBounds: () => ({ x: 1000, y: 800, width: 900, height: 700 }),
      getNearestWorkArea: () => ({ x: 50, y: 60, width: 500, height: 400 }),
      getTextScale: () => 1.6,
    },
  });

  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  assert.deepStrictEqual(
    { x: win.options.x, y: win.options.y, width: win.options.width, height: win.options.height },
    { x: 50, y: 60, width: 500, height: 400 },
  );
  assert.strictEqual(win.options.minWidth, 500);
  assert.strictEqual(win.options.minHeight, 400);
});

test("invalid saved Settings bounds fall back to pet-display centering", () => {
  const { runtime } = createRuntime({
    runtime: {
      getSavedBounds: () => ({ x: "bad", y: 0, width: 900, height: 650 }),
      getPetWindowBounds: () => ({ x: 1700, y: 100, width: 280, height: 280 }),
      getNearestWorkArea: () => ({ x: 1280, y: 40, width: 1600, height: 900 }),
    },
  });

  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  assert.deepStrictEqual(
    { x: win.options.x, y: win.options.y, width: win.options.width, height: win.options.height },
    { x: 1680, y: 210, width: 800, height: 560 },
  );
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

test("settings window move re-applies text scale and pokes the slider context (debounced)", () => {
  const { runtime, timers } = createRuntime();

  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  const sends = [];
  win.webContents = {
    isDestroyed: () => false,
    send: (channel) => sends.push(channel),
  };

  // Two quick moves: the first debounce timer is superseded, nothing fires
  // until the surviving timer runs.
  win.emit("move");
  win.emit("move");
  const moveTimers = timers.filter((timer) => timer.delay === 350);
  assert.strictEqual(moveTimers.length, 2);
  assert.strictEqual(moveTimers[0].cleared, true);
  assert.strictEqual(moveTimers[1].cleared, false);
  assert.deepStrictEqual(sends, []);

  moveTimers[1].callback();
  assert.deepStrictEqual(sends, ["settings:text-scale-context-changed"]);
});

test("settings window move and resize persist normal bounds with a shared debounce", () => {
  const saved = [];
  const { runtime, timers } = createRuntime({
    runtime: {
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    },
  });

  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  win.normalBounds = { x: 310, y: 220, width: 880, height: 620 };
  win.emit("move");
  win.emit("resize");

  const saveTimers = timers.filter((timer) => timer.delay === 500);
  assert.strictEqual(saveTimers.length, 2);
  assert.strictEqual(saveTimers[0].cleared, true);
  assert.strictEqual(saveTimers[1].cleared, false);
  assert.deepStrictEqual(saved, []);

  saveTimers[1].callback();
  assert.deepStrictEqual(saved, [
    { x: 310, y: 220, width: 880, height: 620 },
  ]);

  // A duplicate native event after the same geometry must not rewrite prefs.
  win.emit("resize");
  timers.filter((timer) => timer.delay === 500).at(-1).callback();
  assert.strictEqual(saved.length, 1);
});

test("persisted Settings bounds are used when the window is recreated", () => {
  let persisted = null;
  const { runtime } = createRuntime({
    runtime: {
      getSavedBounds: () => persisted,
      onSaveBounds: (bounds) => {
        persisted = bounds;
        return { status: "ok" };
      },
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
    },
  });

  runtime.open();
  const first = FakeBrowserWindow.instances[0];
  first.normalBounds = { x: 420, y: 230, width: 940, height: 700 };
  first.emit("close");
  first.emit("closed");

  runtime.open();
  const reopened = FakeBrowserWindow.instances[1];
  assert.deepStrictEqual(
    { x: reopened.options.x, y: reopened.options.y, width: reopened.options.width, height: reopened.options.height },
    persisted,
  );
});

test("settings window close flushes pending geometry and saves normal, not maximized, bounds", () => {
  const saved = [];
  const { runtime, timers } = createRuntime({
    runtime: {
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    },
  });

  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  win.bounds = { x: 0, y: 0, width: 1920, height: 1040 };
  win.normalBounds = { x: 260, y: 180, width: 920, height: 680 };
  win.emit("resize");
  const pendingSave = findPendingTimer(timers, 500);
  assert.ok(pendingSave);

  win.emit("close");
  assert.strictEqual(pendingSave.cleared, true);
  assert.deepStrictEqual(saved, [
    { x: 260, y: 180, width: 920, height: 680 },
  ]);

  win.emit("closed");
  assert.strictEqual(runtime.getWindow(), null);
});

test("a synchronous persistence error remains retryable", () => {
  const attempts = [];
  const { runtime, timers } = createRuntime({
    runtime: {
      onSaveBounds: (bounds) => {
        attempts.push(bounds);
        return attempts.length === 1
          ? { status: "error", message: "read only" }
          : { status: "ok" };
      },
    },
  });

  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  win.normalBounds = { x: 310, y: 220, width: 880, height: 620 };
  win.emit("resize");
  timers.filter((timer) => timer.delay === 500).at(-1).callback();
  win.emit("resize");
  timers.filter((timer) => timer.delay === 500).at(-1).callback();

  assert.strictEqual(attempts.length, 2);
});

test("an asynchronous persistence error remains retryable", async () => {
  const attempts = [];
  const { runtime, timers } = createRuntime({
    runtime: {
      onSaveBounds: (bounds) => {
        attempts.push(bounds);
        return Promise.resolve(attempts.length === 1
          ? { status: "error", message: "disk full" }
          : { status: "ok" });
      },
    },
  });

  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  win.normalBounds = { x: 310, y: 220, width: 880, height: 620 };
  win.emit("resize");
  timers.filter((timer) => timer.delay === 500).at(-1).callback();
  await Promise.resolve();
  await Promise.resolve();
  win.emit("resize");
  timers.filter((timer) => timer.delay === 500).at(-1).callback();

  assert.strictEqual(attempts.length, 2);
});

test("destroyed windows and closed cleanup cannot fire a pending bounds save", () => {
  const writes = [];
  const { runtime, timers } = createRuntime({
    runtime: {
      onSaveBounds: (bounds) => {
        writes.push(bounds);
        return { status: "ok" };
      },
    },
  });

  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  win.normalBounds = { x: 310, y: 220, width: 880, height: 620 };
  win.emit("resize");
  const pendingSave = timers.filter((timer) => timer.delay === 500).at(-1);
  win.destroyed = true;
  win.emit("closed");

  assert.strictEqual(pendingSave.cleared, true);
  pendingSave.callback();
  assert.deepStrictEqual(writes, []);
});

test("normal-bounds lookup falls back to current bounds when unavailable", () => {
  const writes = [];
  const { runtime } = createRuntime({
    runtime: {
      onSaveBounds: (bounds) => {
        writes.push(bounds);
        return { status: "ok" };
      },
    },
  });

  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  win.bounds = { x: 330, y: 240, width: 860, height: 610 };
  win.getNormalBounds = () => { throw new Error("unsupported"); };
  win.emit("close");

  assert.deepStrictEqual(writes, [{ x: 330, y: 240, width: 860, height: 610 }]);
});

test("applyTextScaleToWindow pokes the slider context even when zoom injection is unavailable", () => {
  const { runtime } = createRuntime();

  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  const sends = [];
  // No insertCSS: applyZoomToWindow bails, but the context poke (which the
  // cross-display slider sync depends on) must still go out.
  win.webContents = { send: (channel) => sends.push(channel) };

  runtime.applyTextScaleToWindow();
  assert.deepStrictEqual(sends, ["settings:text-scale-context-changed"]);
});
