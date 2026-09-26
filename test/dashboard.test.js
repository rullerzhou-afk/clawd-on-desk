"use strict";

const assert = require("node:assert");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { describe, it } = require("node:test");

const DASHBOARD_MODULE_PATH = require.resolve("../src/dashboard");

function loadDashboardWithElectron(fakeElectron, originFocus) {
  delete require.cache[DASHBOARD_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return fakeElectron;
    if (originFocus && request === "./dashboard-quick-mode" && parent.filename === DASHBOARD_MODULE_PATH) {
      const actual = originalLoad.apply(this, arguments);
      return {
        ...actual,
        createDashboardQuickMode: (ctx) => actual.createDashboardQuickMode({ ...ctx, originFocus }),
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/dashboard");
  } finally {
    Module._load = originalLoad;
  }
}

describe("dashboard window", () => {
  function createWindowHarness(options = {}) {
    let createdWindow = null;
    const nativeTheme = new EventEmitter();
    nativeTheme.shouldUseDarkColors = false;
    const timers = [];

    const platform = options.platform || "darwin";
    let createdView = null;

    // Fake WebContents for the one Dashboard page. Everything page-shaped
    // lives here, never on a window, so a migration that reaches for
    // `window.webContents` fails loudly instead of silently no-opping.
    class FakeWebContents {
      constructor() {
        this.destroyed = false;
        this.sent = [];
        this.onceCallbacks = new Map();
        this.onCallbacks = new Map();
        this.loadedFiles = [];
        this.closeCount = 0;
        this.insertedCss = [];
        this.focusCount = 0;
      }
      isDestroyed() { return this.destroyed; }
      send(channel, payload) { this.sent.push({ channel, payload }); }
      focus() { this.focusCount += 1; }
      insertCSS(css) { this.insertedCss.push(css); return Promise.resolve("key"); }
      setZoomFactor() {}
      loadFile(filePath) { this.loadedFiles.push(filePath); return Promise.resolve(); }
      close() { this.closeCount += 1; }
      once(eventName, callback) { this.onceCallbacks.set(eventName, callback); }
      on(eventName, callback) {
        const list = this.onCallbacks.get(eventName) || [];
        list.push(callback);
        this.onCallbacks.set(eventName, list);
      }
      emitOnce(eventName) {
        const callback = this.onceCallbacks.get(eventName);
        if (callback) callback();
      }
      emit(eventName, ...args) {
        for (const callback of this.onCallbacks.get(eventName) || []) callback(...args);
      }
    }

    class FakeWebContentsView {
      constructor(opts) {
        this.opts = opts;
        this.webContents = new FakeWebContents();
        this.boundsCalls = [];
        createdView = this;
      }
      setBounds(bounds) { this.boundsCalls.push({ ...bounds }); }
    }

    // Shared native-window behaviour. BaseWindow deliberately exposes NO
    // `webContents`, NO `loadFile()` and never emits `ready-to-show`; the
    // BrowserWindow subclass below adds exactly those three.
    class FakeBaseWindow {
      constructor(opts) {
        // Models native frame quantization: the WM may hand back a slightly
        // different rectangle than the one requested.
        const offset = options.constructorBoundsOffset || {};
        this.opts = opts;
        this.bounds = {
          x: opts.x + (offset.x || 0),
          y: opts.y + (offset.y || 0),
          width: opts.width + (offset.width || 0),
          height: opts.height + (offset.height || 0),
        };
        this.destroyed = false;
        this.maximized = false;
        this.fullScreen = false;
        this.visible = false;
        this.focused = false;
        this.shownCount = 0;
        this.hiddenCount = 0;
        this.opacity = 1;
        this.opacityCalls = [];
        this.ignoreMouseCalls = [];
        this.backgroundColors = [opts.backgroundColor];
        this.parentWindows = [];
        this.setBoundsCalls = [];
        this.setMinimumSizeCalls = [];
        this.onceCallbacks = new Map();
        this.onCallbacks = new Map();
        this.normalBounds = null;
        this.addedViews = [];
        this.removedViews = [];
        this.focusCount = 0;
        const self = this;
        this.contentView = {
          addChildView(view) {
            self.addedViews.push(view);
            // Re-parenting really can make the receiving window the native
            // foreground, which emits focus from inside our own transfer.
            if (options.emitFocusOnAttach) self.emit("focus");
          },
          removeChildView(view) { self.removedViews.push(view); },
        };
        createdWindow = this;
      }
      isDestroyed() { return this.destroyed; }
      isMinimized() { return false; }
      isMaximized() { return this.maximized; }
      isFullScreen() { return this.fullScreen; }
      isVisible() { return this.visible; }
      isFocused() { return this.focused; }
      restore() {}
      show() { this.visible = true; this.shownCount += 1; }
      hide() { this.visible = false; this.hiddenCount += 1; }
      focus() { this.focused = true; this.focusCount += 1; }
      destroy() { this.destroyed = true; }
      getOpacity() { return this.opacity; }
      setOpacity(value) { this.opacity = value; this.opacityCalls.push(value); }
      setIgnoreMouseEvents(value) { this.ignoreMouseCalls.push(value); }
      getContentSize() { return [this.bounds.width, this.bounds.height]; }
      setMenuBarVisibility() {}
      setTitle() {}
      once(eventName, callback) { this.onceCallbacks.set(eventName, callback); }
      on(eventName, callback) {
        const list = this.onCallbacks.get(eventName) || [];
        list.push(callback);
        this.onCallbacks.set(eventName, list);
      }
      emit(eventName, ...args) {
        for (const callback of this.onCallbacks.get(eventName) || []) callback(...args);
      }
      getBounds() { return { ...this.bounds }; }
      getNormalBounds() { return { ...(this.normalBounds || this.bounds) }; }
      setBackgroundColor(color) { this.backgroundColors.push(color); }
      setMinimumSize(width, height) { this.setMinimumSizeCalls.push({ width, height }); }
      setBounds(bounds) {
        const previous = { ...this.bounds };
        const offset = options.setBoundsOffset || {};
        this.bounds = {
          x: bounds.x + (offset.x || 0),
          y: bounds.y + (offset.y || 0),
          width: bounds.width + (offset.width || 0),
          height: bounds.height + (offset.height || 0),
        };
        this.setBoundsCalls.push({ ...bounds });
        if (options.emitSetBoundsEvents) {
          if (previous.x !== this.bounds.x || previous.y !== this.bounds.y) this.emit("move");
          if (previous.width !== this.bounds.width || previous.height !== this.bounds.height) this.emit("resize");
        }
      }
      setParentWindow(parentWindow) {
        this.parentWindows.push(parentWindow);
      }
      // Drives whichever first-paint signal this platform really uses.
      emitReadyToShow() {
        if (this.webContents) {
          this.webContents.emitOnce("did-finish-load");
          return;
        }
        if (createdView) createdView.webContents.emitOnce("did-finish-load");
      }
    }

    // Linux only. The extra members are exactly what BaseWindow lacks.
    class FakeBrowserWindow extends FakeBaseWindow {
      constructor(opts) {
        super(opts);
        this.webContents = new FakeWebContents();
      }
      loadFile(filePath) { this.webContents.loadFile(filePath); }
      emitReadyToShow() {
        const callback = this.onceCallbacks.get("ready-to-show");
        if (callback) callback();
      }
    }

    const fakeElectron = {
      BaseWindow: FakeBaseWindow,
      BrowserWindow: FakeBrowserWindow,
      WebContentsView: FakeWebContentsView,
      nativeTheme,
    };
    const initDashboard = loadDashboardWithElectron(fakeElectron, options.originFocus);
    const dashboard = initDashboard({
      platform,
      electron: fakeElectron,
      getPetWindowBounds: options.getPetWindowBounds
        || (() => ({ x: 100, y: 100, width: 120, height: 120 })),
      getNearestWorkArea: options.getNearestWorkArea || (() => ({ x: 0, y: 0, width: 1280, height: 800 })),
      getSettingsWindow: options.getSettingsWindow,
      getSavedBounds: options.getSavedBounds,
      onSaveBounds: options.onSaveBounds,
      getTextScale: options.getTextScale,
      isAppQuitting: options.isAppQuitting,
      setTimeout: options.setTimeout || ((callback, delay) => {
        timers.push({ callback, delay, cleared: false });
        return timers.length;
      }),
      clearTimeout: options.clearTimeout || ((id) => {
        const timer = timers[id - 1];
        if (timer) timer.cleared = true;
      }),
      getSessionSnapshot: () => ({ sessions: [], groups: [] }),
      getI18n: () => ({ lang: "en", translations: {} }),
    });

    return {
      dashboard,
      nativeTheme,
      timers,
      getCreatedWindow: () => createdWindow,
      getCreatedView: () => createdView,
      getPageContents: () => (createdView ? createdView.webContents : createdWindow.webContents),
    };
  }

  it("updates its background color when native theme changes", () => {
    const { dashboard, nativeTheme, getCreatedWindow } = createWindowHarness();

    dashboard.showDashboard();
    const createdWindow = getCreatedWindow();
    assert.strictEqual(createdWindow.opts.backgroundColor, "#f5f5f7");

    nativeTheme.shouldUseDarkColors = true;
    nativeTheme.emit("updated");

    assert.deepStrictEqual(createdWindow.backgroundColors, ["#f5f5f7", "#1c1c1f"]);
  });

  it("centers the dashboard on the pet work area by default", () => {
    const { dashboard, getCreatedWindow } = createWindowHarness();

    dashboard.showDashboard();

    assert.deepStrictEqual(getCreatedWindow().bounds, {
      x: 400,
      y: 100,
      width: 480,
      height: 600,
    });
    assert.strictEqual(getCreatedWindow().opts.parent, undefined);
    assert.strictEqual(getCreatedWindow().opts.modal, undefined);
  });

  it("anchors dashboard windows opened from settings to the settings window bounds", () => {
    const settingsWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 560 }),
    };
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSettingsWindow: () => settingsWindow,
    });

    dashboard.showDashboard({ source: "settings" });

    assert.deepStrictEqual(getCreatedWindow().bounds, {
      x: 260,
      y: 50,
      width: 480,
      height: 560,
    });
    assert.strictEqual(getCreatedWindow().opts.parent, undefined);
    assert.strictEqual(getCreatedWindow().opts.modal, undefined);
    assert.deepStrictEqual(getCreatedWindow().parentWindows, []);
  });

  it("clamps settings-anchored dashboard bounds to the work area", () => {
    const settingsWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      getBounds: () => ({ x: 900, y: 500, width: 500, height: 700 }),
    };
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSettingsWindow: () => settingsWindow,
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 1000, height: 600 }),
    });

    dashboard.showDashboard({ source: "settings" });

    assert.deepStrictEqual(getCreatedWindow().bounds, {
      x: 520,
      y: 0,
      width: 480,
      height: 600,
    });
  });

  it("falls back to pet work area centering when the settings window is unavailable", () => {
    const settingsWindow = {
      isDestroyed: () => true,
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 560 }),
    };
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSettingsWindow: () => settingsWindow,
    });

    dashboard.showDashboard({ source: "settings" });

    assert.deepStrictEqual(getCreatedWindow().bounds, {
      x: 400,
      y: 100,
      width: 480,
      height: 600,
    });
    assert.strictEqual(getCreatedWindow().opts.parent, undefined);
  });

  it("repositions an existing dashboard when reopened from settings", () => {
    const settingsWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 560 }),
    };
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSettingsWindow: () => settingsWindow,
    });

    dashboard.showDashboard();
    dashboard.showDashboard({ source: "settings" });

    assert.deepStrictEqual(getCreatedWindow().setBoundsCalls, [{
      x: 260,
      y: 50,
      width: 480,
      height: 560,
    }]);
    assert.deepStrictEqual(getCreatedWindow().parentWindows, []);
  });

  it("re-syncs settings anchored bounds before and after showing the dashboard", () => {
    let settingsBounds = { x: 100, y: 50, width: 800, height: 560 };
    const settingsWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      getBounds: () => settingsBounds,
    };
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      getSettingsWindow: () => settingsWindow,
    });

    dashboard.showDashboard({ source: "settings" });
    settingsBounds = { x: 100, y: 50, width: 800, height: 540 };
    getCreatedWindow().emitReadyToShow();
    settingsBounds = { x: 100, y: 50, width: 800, height: 520 };
    for (const timer of timers) timer.callback();

    assert.deepStrictEqual(getCreatedWindow().setBoundsCalls, [
      { x: 260, y: 50, width: 480, height: 540 },
      { x: 260, y: 50, width: 480, height: 520 },
      { x: 260, y: 50, width: 480, height: 520 },
    ]);
    assert.deepStrictEqual(timers.map((timer) => timer.delay), [0, 80]);
  });

  it("restores saved dashboard bounds instead of pet centering", () => {
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSavedBounds: () => ({ x: 40, y: 60, width: 500, height: 520 }),
    });

    dashboard.showDashboard();

    assert.deepStrictEqual(getCreatedWindow().bounds, {
      x: 40,
      y: 60,
      width: 500,
      height: 520,
    });
  });

  it("clamps restored bounds to the work area and scaled minimum", () => {
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSavedBounds: () => ({ x: 2000, y: 700, width: 200, height: 300 }),
    });

    dashboard.showDashboard();

    assert.deepStrictEqual(getCreatedWindow().bounds, {
      x: 960,
      y: 400,
      width: 320,
      height: 400,
    });
  });

  it("applies the saved display's scaled minimum when restoring bounds", () => {
    const scaleBounds = [];
    const workAreaQueries = [];
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSavedBounds: () => ({ x: 2100, y: 80, width: 480, height: 600 }),
      getNearestWorkArea: (cx, cy) => {
        workAreaQueries.push({ cx, cy });
        return cx >= 2000
          ? { x: 2000, y: 0, width: 1280, height: 800 }
          : { x: 0, y: 0, width: 1280, height: 800 };
      },
      // The saved rect lives on a 1.6-scale display; the pet (no bounds
      // argument) does not.
      getTextScale: (bounds) => {
        scaleBounds.push(bounds);
        return bounds && bounds.x >= 2000 ? 1.6 : 1;
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();

    assert.deepStrictEqual(scaleBounds[0], { x: 2100, y: 80, width: 480, height: 600 });
    assert.deepStrictEqual(workAreaQueries[0], { cx: 2340, cy: 380 });
    assert.deepStrictEqual(win.bounds, {
      x: 2100,
      y: 80,
      width: 512,
      height: 640,
    });
    assert.strictEqual(win.opts.minWidth, 512);
    assert.strictEqual(win.opts.minHeight, 640);
  });

  it("a tiny work area caps both restored bounds and window minimums", () => {
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSavedBounds: () => ({ x: 1000, y: 800, width: 900, height: 700 }),
      getNearestWorkArea: () => ({ x: 50, y: 60, width: 500, height: 400 }),
      getTextScale: () => 1.6,
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();

    assert.deepStrictEqual(win.bounds, { x: 50, y: 60, width: 500, height: 400 });
    assert.strictEqual(win.opts.minWidth, 500);
    assert.strictEqual(win.opts.minHeight, 400);
  });

  it("falls back to a sane work area when the display reports a degenerate one", () => {
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSavedBounds: () => ({ x: 40, y: 60, width: 500, height: 520 }),
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    });

    dashboard.showDashboard();

    assert.deepStrictEqual(getCreatedWindow().bounds, {
      x: 40,
      y: 60,
      width: 500,
      height: 520,
    });
  });

  it("tolerates a throwing pet-bounds lookup", () => {
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getPetWindowBounds: () => { throw new Error("display teardown"); },
    });

    dashboard.showDashboard();

    assert.deepStrictEqual(getCreatedWindow().bounds, {
      x: 400,
      y: 100,
      width: 480,
      height: 600,
    });
  });

  it("clears the pending move text-scale timer on closed", () => {
    const { dashboard, getCreatedWindow, timers } = createWindowHarness();

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.emit("move");
    const scaleTimer = timers.filter((t) => t.delay === 350).at(-1);
    assert.strictEqual(scaleTimer.cleared, false);

    win.emit("close");
    win.emit("closed");
    assert.strictEqual(scaleTimer.cleared, true);
  });

  it("re-resolves text scale after a maximized window moves without persisting transient bounds", () => {
    let scale = 1;
    const saved = [];
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      getTextScale: () => scale,
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.normalBounds = { ...win.bounds };
    win.maximized = true;
    win.bounds = { x: 1280, y: 0, width: 1280, height: 800 };
    scale = 1.6;
    win.emit("move");

    const scaleTimer = timers.filter((timer) => !timer.cleared && timer.delay === 350).at(-1);
    assert.ok(scaleTimer);
    assert.strictEqual(timers.filter((timer) => !timer.cleared && timer.delay === 500).length, 0);
    scaleTimer.callback();
    assert.deepStrictEqual(win.setMinimumSizeCalls.at(-1), { width: 512, height: 640 });
    assert.deepStrictEqual(saved, []);
  });

  it("does not persist fullscreen move or resize events when current and normal bounds match", () => {
    const saved = [];
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.fullScreen = true;
    win.bounds = { x: 0, y: 0, width: 1280, height: 800 };
    win.normalBounds = { ...win.bounds };
    win.emit("move");
    win.emit("resize");

    assert.strictEqual(timers.filter((timer) => !timer.cleared && timer.delay === 500).length, 0);
    assert.deepStrictEqual(saved, []);
  });

  it("uses persisted bounds when the dashboard window is recreated", () => {
    let persisted = null;
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSavedBounds: () => persisted,
      onSaveBounds: (bounds) => {
        persisted = bounds;
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const first = getCreatedWindow();
    first.normalBounds = { x: 420, y: 230, width: 640, height: 500 };
    first.emit("close");
    first.emit("closed");

    dashboard.showDashboard();
    const reopened = getCreatedWindow();
    assert.notStrictEqual(reopened, first);
    assert.deepStrictEqual(reopened.bounds, { x: 420, y: 230, width: 640, height: 500 });
  });

  it("ignores invalid saved bounds and falls back to pet centering", () => {
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSavedBounds: () => ({ x: NaN, y: 0, width: 480, height: 600 }),
    });

    dashboard.showDashboard();

    assert.deepStrictEqual(getCreatedWindow().bounds, {
      x: 400,
      y: 100,
      width: 480,
      height: 600,
    });
  });

  it("keeps settings-anchored placement even when saved bounds exist", () => {
    const settingsWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 560 }),
    };
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSettingsWindow: () => settingsWindow,
      getSavedBounds: () => ({ x: 10, y: 20, width: 500, height: 500 }),
    });

    dashboard.showDashboard({ source: "settings" });

    assert.deepStrictEqual(getCreatedWindow().bounds, {
      x: 260,
      y: 50,
      width: 480,
      height: 560,
    });
  });

  it("persists moved and resized normal bounds with a shared debounce", () => {
    const saved = [];
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.bounds = { x: 300, y: 200, width: 640, height: 700 };
    win.emit("move");
    win.emit("resize");

    const saveTimers = timers.filter((timer) => timer.delay === 500);
    assert.strictEqual(saveTimers.length, 2);
    assert.strictEqual(saveTimers[0].cleared, true);
    assert.strictEqual(saveTimers[1].cleared, false);
    assert.deepStrictEqual(saved, []);

    saveTimers[1].callback();
    assert.deepStrictEqual(saved, [
      { x: 300, y: 200, width: 640, height: 700 },
    ]);

    // A duplicate native event after the same geometry must not rewrite prefs.
    win.emit("resize");
    timers.filter((timer) => timer.delay === 500).at(-1).callback();
    assert.strictEqual(saved.length, 1);
  });

  it("keeps Linux on the ordinary BrowserWindow with no quick host or borrow", () => {
    const { dashboard, getCreatedWindow, getCreatedView } = createWindowHarness({
      platform: "linux",
      getSessionSnapshot: () => ({
        sessions: [{ id: "s1", canFocus: true, displayTitle: "S1" }],
        groups: [{ host: "local", ids: ["s1"] }],
      }),
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();

    // The ordinary Dashboard is unchanged: a real BrowserWindow whose page is
    // its own webContents, shown by ready-to-show.
    assert.strictEqual(getCreatedView(), null);
    assert.ok(win.webContents, "Linux keeps the BrowserWindow page");
    assert.strictEqual(dashboard.getWebContents(), win.webContents);
    win.emitReadyToShow();
    assert.strictEqual(win.visible, true);

    // The keyboard mode is not offered and nothing native is touched.
    assert.strictEqual(dashboard.quick.isSupported(), false);
    assert.deepStrictEqual(dashboard.quick.show(), { status: "unsupported" });
    assert.strictEqual(dashboard.quick.getQuickWindow(), null);
    assert.strictEqual(dashboard.quick.isActive(), false);
    assert.deepStrictEqual(win.opacityCalls, []);
    assert.deepStrictEqual(win.ignoreMouseCalls, []);
    assert.strictEqual(dashboard.getActiveHost(), win);

    // Ordinary management still works end to end.
    assert.strictEqual(dashboard.promoteToOrdinaryWindow(), win);
    dashboard.broadcastSessionSnapshot({ sessions: [], groups: [] });
    const channels = win.webContents.sent.map((message) => message.channel);
    assert.ok(channels.includes("dashboard:session-snapshot"));
    assert.ok(
      !channels.some((channel) => channel.startsWith("dashboard:quick-")),
      "no keyboard-mode traffic is emitted on Linux"
    );
  });

  it("does not write user geometry while the page is borrowed", () => {
    const saved = [];
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
      getSessionSnapshot: () => ({
        sessions: [{ id: "s1", canFocus: true, displayTitle: "S1" }],
        groups: [{ host: "local", ids: ["s1"] }],
      }),
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.visible = true;
    win.focused = false;

    const started = dashboard.quick.show();
    dashboard.quick.enter({ revision: started.revision, busy: false });
    dashboard.quick.ready({ revision: started.revision });
    assert.strictEqual(dashboard.quick.isShown(), true);

    // The parked ordinary host is empty and opacity 0; anything the WM does to
    // it during the borrow is not the user's chosen geometry.
    const before = timers.filter((timer) => timer.delay === 500).length;
    win.bounds = { x: 900, y: 900, width: 320, height: 400 };
    win.emit("move");
    win.emit("resize");
    assert.strictEqual(
      timers.filter((timer) => timer.delay === 500).length,
      before,
      "no persistence was even scheduled"
    );
    assert.deepStrictEqual(saved, []);
  });

  it("returns the page and restores opacity when the ordinary host is reopened", () => {
    const { dashboard, getCreatedWindow } = createWindowHarness({
      getSessionSnapshot: () => ({
        sessions: [{ id: "s1", canFocus: true, displayTitle: "S1" }],
        groups: [{ host: "local", ids: ["s1"] }],
      }),
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.visible = true;
    win.focused = false;

    const started = dashboard.quick.show();
    dashboard.quick.enter({ revision: started.revision, busy: false });
    dashboard.quick.ready({ revision: started.revision });
    assert.deepStrictEqual(win.opacityCalls, [0]);

    dashboard.showDashboard();

    assert.deepStrictEqual(win.opacityCalls, [0, 1]);
    assert.deepStrictEqual(win.ignoreMouseCalls, [true, false]);
    assert.strictEqual(dashboard.quick.isActive(), false);
    assert.strictEqual(win.hiddenCount, 0, "the ordinary host was never hidden");
  });

  // The keyboard mode returns the page when the ordinary window is really
  // reactivated, but the reclaimed window holding native focus does not make
  // the page focused: document.hasFocus() stays false until the owned
  // WebContents is told, which was observed on a real Electron build.
  function borrowedHarness(extra = {}) {
    const harness = createWindowHarness({
      getSessionSnapshot: () => ({
        sessions: [{ id: "s1", canFocus: true, displayTitle: "S1" }],
        groups: [{ host: "local", ids: ["s1"] }],
      }),
      ...extra,
    });
    harness.dashboard.showDashboard();
    const normal = harness.getCreatedWindow();
    normal.visible = true;
    normal.focused = false;
    const started = harness.dashboard.quick.show();
    harness.dashboard.quick.enter({ revision: started.revision, busy: false });
    harness.dashboard.quick.ready({ revision: started.revision, busy: false });
    return { ...harness, normal, quickWindow: harness.getCreatedWindow(), started };
  }

  it("gives the page keyboard focus when the ordinary host is natively reactivated", () => {
    const { dashboard, normal, getPageContents } = borrowedHarness();
    const pageBefore = getPageContents().focusCount;
    const windowBefore = normal.focusCount;

    normal.focused = true;
    normal.emit("focus");

    assert.strictEqual(dashboard.quick.isActive(), false, "the borrow ended first");
    assert.strictEqual(
      getPageContents().focusCount,
      pageBefore + 1,
      "the returned page must be explicitly focused, exactly once"
    );
    assert.strictEqual(
      normal.focusCount,
      windowBefore,
      "the window already has focus and must not be re-focused recursively"
    );
  });

  it("a focus event emitted by our own re-parent does not re-enter the handler", () => {
    // The return trip re-parents the view into the ordinary window, which can
    // itself emit focus. That event is ours, not the user's.
    const { normal, getPageContents } = borrowedHarness({ emitFocusOnAttach: true });
    const pageBefore = getPageContents().focusCount;

    normal.focused = true;
    normal.emit("focus");

    assert.strictEqual(
      getPageContents().focusCount,
      pageBefore + 1,
      "the nested transfer focus must not trigger a second restore"
    );
  });

  // The measured native ordering: the quick host blurs first, which already
  // ends the round and returns the view, and the ordinary focus arrives with
  // nothing left to end. Gating the page focus on "did this end a borrow"
  // silently skipped it, leaving the window with the keyboard and the page
  // without it.
  it("focuses the page when ordinary focus follows the quick host's blur", () => {
    const { dashboard, normal, quickWindow, getPageContents } = borrowedHarness();

    quickWindow.emit("blur");
    assert.strictEqual(dashboard.quick.isActive(), false, "the blur already ended the round");
    assert.strictEqual(dashboard.quick.isShown(), false);
    assert.deepStrictEqual(normal.opacityCalls, [0, 1], "and already restored the host");
    const pageBefore = getPageContents().focusCount;
    const windowBefore = normal.focusCount;

    normal.focused = true;
    normal.emit("focus");

    assert.strictEqual(
      getPageContents().focusCount,
      pageBefore + 1,
      "the returned page must still be given the keyboard"
    );
    assert.strictEqual(normal.focusCount, windowBefore, "no recursive window focus");
    assert.strictEqual(dashboard.quick.isActive(), false);
  });

  it("focuses the page when ordinary focus arrives before the quick host blurs", () => {
    const { dashboard, normal, quickWindow, getPageContents } = borrowedHarness();
    const pageBefore = getPageContents().focusCount;

    normal.focused = true;
    normal.emit("focus");

    assert.strictEqual(dashboard.quick.isActive(), false, "this event ended the borrow");
    assert.deepStrictEqual(normal.opacityCalls, [0, 1]);
    assert.strictEqual(getPageContents().focusCount, pageBefore + 1);

    // The quick host's blur arrives afterwards and must be a no-op.
    quickWindow.emit("blur");
    assert.strictEqual(getPageContents().focusCount, pageBefore + 1);
  });

  // Windows F1: GetForegroundWindow/GUI focus root can name the ordinary host
  // while Electron isFocused() is still false and no later focus event comes.
  // These are independent inputs, not a fake in which native and Electron focus
  // are assumed to be the same bit. The real Dashboard owner wires the repair.
  function nativeReturnHarness(extra = {}) {
    let foreground = null;
    const h = borrowedHarness({
      platform: "win32",
      originFocus: {
        capture: () => null,
        restore: () => false,
        holdsForeground: (win) => win === foreground,
      },
      ...extra,
    });
    return { ...h, setForeground: (win) => { foreground = win; } };
  }

  it("gives the returned page keyboard when Windows chose its host without Electron focus", () => {
    const h = nativeReturnHarness();
    const before = h.getPageContents().focusCount;
    const windowBefore = h.normal.focusCount;
    h.setForeground(h.normal);
    assert.strictEqual(h.normal.isFocused(), false);

    // No ordinary focus event is fabricated after this native blur.
    h.quickWindow.emit("blur");

    assert.strictEqual(h.dashboard.quick.isShown(), false);
    assert.strictEqual(h.getPageContents().focusCount, before + 1);
    assert.strictEqual(h.normal.focusCount, windowBefore, "only the page, never the window");
  });

  it("covers ordinary focus arriving first with the same native/Electron disagreement", () => {
    const h = nativeReturnHarness();
    const before = h.getPageContents().focusCount;
    h.setForeground(h.normal);
    h.normal.emit("focus");
    h.quickWindow.emit("blur");
    assert.strictEqual(h.getPageContents().focusCount, before + 1);
    assert.strictEqual(h.dashboard.quick.isActive(), false);
  });

  it("repairs Windows page focus even when a busy refusal left only the borrowed editor", () => {
    const h = nativeReturnHarness();
    const refused = h.dashboard.quick.show();
    h.dashboard.quick.enter({ revision: refused.revision, busy: true });
    const before = h.getPageContents().focusCount;
    h.setForeground(h.normal);
    h.quickWindow.emit("blur");
    assert.strictEqual(h.getPageContents().focusCount, before + 1);
    assert.strictEqual(h.dashboard.quick.isShown(), false);
  });

  it("rechecks the chosen foreground after hide and never takes an external window's keys", () => {
    const h = nativeReturnHarness();
    const before = h.getPageContents().focusCount;
    h.setForeground(h.normal);
    const hide = h.quickWindow.hide.bind(h.quickWindow);
    h.quickWindow.hide = () => { hide(); h.setForeground({ name: "external" }); };
    h.quickWindow.emit("blur");
    assert.strictEqual(h.getPageContents().focusCount, before);
  });

  it("does not repair the returned page when hidden, minimized, crashed, destroyed or quitting", () => {
    for (const mode of ["hidden", "minimized", "crashed", "destroyed", "quitting"]) {
      let quitting = false;
      const h = nativeReturnHarness({ isAppQuitting: () => quitting });
      const page = h.getPageContents();
      const before = page.focusCount;
      h.setForeground(h.normal);
      if (mode === "hidden") h.normal.visible = false;
      if (mode === "minimized") h.normal.isMinimized = () => true;
      if (mode === "crashed") page.isCrashed = () => true;
      if (mode === "destroyed") page.destroyed = true;
      if (mode === "quitting") quitting = true;
      h.quickWindow.emit("blur");
      assert.strictEqual(page.focusCount, before, mode);
    }
  });

  it("does not introduce a native-return focus action on macOS", () => {
    const h = nativeReturnHarness({ platform: "darwin" });
    const before = h.getPageContents().focusCount;
    h.setForeground(h.normal);
    h.quickWindow.emit("blur");
    assert.strictEqual(h.getPageContents().focusCount, before);
  });

  it("does not focus an unattached page if the view's return fails", () => {
    const h = nativeReturnHarness();
    const before = h.getPageContents().focusCount;
    h.setForeground(h.normal);
    h.normal.contentView.addChildView = () => { throw new Error("native reattach failed"); };
    h.quickWindow.emit("blur");
    assert.strictEqual(h.getPageContents().focusCount, before);
    assert.strictEqual(h.dashboard.quick.isActive(), false);
  });

  it("fails closed if the native foreground probe is unavailable or throws", () => {
    for (const holdsForeground of [undefined, () => false, () => { throw new Error("native probe failed"); }]) {
      const h = nativeReturnHarness({ originFocus: {
        capture: () => null, restore: () => false, holdsForeground,
      } });
      const before = h.getPageContents().focusCount;
      h.quickWindow.emit("blur");
      assert.strictEqual(h.getPageContents().focusCount, before);
    }
  });

  it("gives the page the keyboard when a plain ordinary window is focused", () => {
    // No round at all. A real ordinary host owning its page must be able to
    // focus it — BrowserWindow does this implicitly, the BaseWindow + view
    // host has to do it explicitly.
    const { dashboard, getCreatedWindow, getPageContents } = createWindowHarness();
    dashboard.showDashboard();
    const normal = getCreatedWindow();
    const before = getPageContents().focusCount;

    normal.focused = true;
    normal.emit("focus");

    assert.strictEqual(getPageContents().focusCount, before + 1);
    assert.strictEqual(dashboard.quick.isActive(), false, "nothing was wrongly started");
  });

  it("an in-place round keeps the keyboard without being ended", () => {
    const { dashboard, getCreatedWindow, getPageContents } = createWindowHarness({
      getSessionSnapshot: () => ({
        sessions: [{ id: "s1", canFocus: true, displayTitle: "S1" }],
        groups: [{ host: "local", ids: ["s1"] }],
      }),
    });
    dashboard.showDashboard();
    const normal = getCreatedWindow();
    normal.visible = true;
    normal.focused = true;

    const started = dashboard.quick.show();
    dashboard.quick.enter({ revision: started.revision, busy: false });
    assert.strictEqual(dashboard.quick.ready({ revision: started.revision }).inPlace, true);
    const before = getPageContents().focusCount;

    normal.emit("focus");

    assert.strictEqual(dashboard.quick.isActive(), true, "an in-place round survives");
    assert.strictEqual(
      getPageContents().focusCount,
      before + 1,
      "and its page still gets the keyboard"
    );
  });


  it("resolves the borrowed page scale against the quick host it moved to", () => {
    const scales = [];
    const { quickWindow } = borrowedHarness({
      getTextScale: (bounds) => {
        scales.push(bounds ? { ...bounds } : null);
        return bounds && bounds.x > 700 ? 1.5 : 1;
      },
    });

    scales.length = 0;
    quickWindow.bounds = { ...quickWindow.bounds, x: 900 };
    quickWindow.emit("move");

    assert.ok(
      scales.some((bounds) => bounds && bounds.x === 900),
      "a quick host move must re-resolve the page scale on its own display"
    );
  });

  it("a settings scale refresh during a borrow uses the quick host display", () => {
    const scales = [];
    const { dashboard, quickWindow, normal } = borrowedHarness({
      getTextScale: (bounds) => {
        scales.push(bounds ? { ...bounds } : null);
        return bounds && bounds.x > 700 ? 1.5 : 1;
      },
    });

    quickWindow.bounds = { ...quickWindow.bounds, x: 900 };
    normal.bounds = { ...normal.bounds, x: 10 };
    scales.length = 0;
    dashboard.applyTextScaleToWindow();

    assert.ok(
      scales.some((bounds) => bounds && bounds.x === 900),
      "the borrowed page must not be re-zoomed to the parked window's display"
    );
    // The window metrics stay tied to the ordinary window.
    assert.strictEqual(quickWindow.setMinimumSizeCalls.length, 0);
    assert.strictEqual(quickWindow.setBoundsCalls.length, 1, "only the initial placement");
  });

  it("returning from a borrow restores the ordinary display scale", () => {
    const scales = [];
    const { dashboard, quickWindow, normal, started } = borrowedHarness({
      getTextScale: (bounds) => {
        scales.push(bounds ? { ...bounds } : null);
        return bounds && bounds.x > 700 ? 1.5 : 1;
      },
    });

    quickWindow.bounds = { ...quickWindow.bounds, x: 900 };
    normal.bounds = { ...normal.bounds, x: 10 };
    scales.length = 0;

    dashboard.quick.dismissFromRenderer({ revision: started.revision });

    assert.ok(
      scales.some((bounds) => bounds && bounds.x === 10),
      "the page goes back to the ordinary host's display scale"
    );
  });

  it("flushes pending geometry on close and skips untouched windows", () => {
    const saved = [];
    const { dashboard, getCreatedWindow } = createWindowHarness({
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.emit("close");
    assert.deepStrictEqual(saved, []);

    win.bounds = { x: 5, y: 6, width: 700, height: 500 };
    win.emit("move");
    win.emit("close");
    assert.deepStrictEqual(saved, [
      { x: 5, y: 6, width: 700, height: 500 },
    ]);
  });

  it("saves normal bounds, not the maximized rectangle", () => {
    const saved = [];
    const { dashboard, getCreatedWindow } = createWindowHarness({
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.normalBounds = { x: 15, y: 25, width: 600, height: 500 };
    win.bounds = { x: 0, y: 0, width: 1280, height: 800 };
    win.emit("close");

    assert.deepStrictEqual(saved, [
      { x: 15, y: 25, width: 600, height: 500 },
    ]);
  });

  it("does not persist the programmatic settings re-anchor", () => {
    const saved = [];
    const settingsWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 560 }),
    };
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      getSettingsWindow: () => settingsWindow,
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    });

    dashboard.showDashboard({ source: "settings" });
    const win = getCreatedWindow();
    win.emitReadyToShow();
    // Electron reports programmatic setBounds through the same move event.
    win.emit("move");
    for (const timer of timers.filter((t) => !t.cleared && t.delay === 500)) {
      timer.callback();
    }
    assert.deepStrictEqual(saved, []);

    // A real user drag afterwards still persists.
    win.bounds = { x: 900, y: 300, width: 520, height: 560 };
    win.emit("move");
    timers.filter((t) => !t.cleared && t.delay === 500).at(-1).callback();
    assert.deepStrictEqual(saved, [
      { x: 900, y: 300, width: 520, height: 560 },
    ]);
  });

  it("saves a still-debounced user move before the settings re-anchor drops it", () => {
    let persisted = { x: 40, y: 60, width: 520, height: 520 };
    const settingsWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 560 }),
    };
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      getSettingsWindow: () => settingsWindow,
      getSavedBounds: () => persisted,
      onSaveBounds: (bounds) => {
        persisted = bounds;
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    const moved = { x: 700, y: 180, width: 520, height: 560 };
    win.bounds = { ...moved };
    win.emit("move");

    // Re-opening from Settings before the 500ms debounce fires.
    dashboard.showDashboard({ source: "settings" });
    assert.deepStrictEqual(persisted, moved);

    // The anchor itself still must not be persisted.
    assert.deepStrictEqual(win.bounds, { x: 260, y: 50, width: 480, height: 560 });
    win.emit("move");
    for (const timer of timers.filter((t) => !t.cleared && t.delay === 500)) {
      timer.callback();
    }
    assert.deepStrictEqual(persisted, moved);

    win.emit("close");
    win.emit("closed");
    dashboard.showDashboard();
    assert.deepStrictEqual(getCreatedWindow().bounds, moved);
  });

  it("does not persist anchor growth to the scaled minimum on a short display", () => {
    const saved = [];
    const settingsWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 560 }),
    };
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      getSettingsWindow: () => settingsWindow,
      // Work area height (600) sits below the scaled minimum height (640 at
      // 1.6), so the anchored placement is clamped short and the text-scale
      // pass grows the window right after placement.
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 1280, height: 600 }),
      getTextScale: () => 1.6,
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    });

    dashboard.showDashboard({ source: "settings" });
    const win = getCreatedWindow();
    win.emitReadyToShow();
    assert.strictEqual(win.bounds.height, 640);
    win.emit("resize");
    for (const timer of timers.filter((t) => !t.cleared && t.delay === 500)) {
      timer.callback();
    }
    assert.deepStrictEqual(saved, []);

    // A real user drag afterwards still persists.
    win.bounds = { x: 200, y: 20, width: 900, height: 640 };
    win.emit("move");
    timers.filter((t) => !t.cleared && t.delay === 500).at(-1).callback();
    assert.deepStrictEqual(saved, [
      { x: 200, y: 20, width: 900, height: 640 },
    ]);
  });

  it("does not persist programmatic text-scale growth as user geometry", () => {
    let scale = 1;
    const saved = [];
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      emitSetBoundsEvents: true,
      getTextScale: () => scale,
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    scale = 1.6;
    dashboard.applyTextScaleToWindow();

    assert.deepStrictEqual(win.bounds, { x: 400, y: 100, width: 512, height: 640 });
    // Some WMs deliver the setBounds events after the call returns. Matching
    // late events are still programmatic geometry: a move may re-resolve the
    // display's text scale, but neither event may arm bounds persistence.
    win.emit("resize");
    win.emit("move");
    assert.strictEqual(timers.filter((t) => !t.cleared && t.delay === 500).length, 0);
    const scaleTimer = timers.filter((t) => !t.cleared && t.delay === 350).at(-1);
    assert.ok(scaleTimer);
    scaleTimer.callback();
    for (const timer of timers.filter((t) => !t.cleared && t.delay === 500)) timer.callback();
    assert.deepStrictEqual(saved, []);

    const userBounds = { x: 240, y: 180, width: 760, height: 680 };
    win.bounds = { ...userBounds };
    win.emit("resize");
    timers.filter((t) => !t.cleared && t.delay === 500).at(-1).callback();
    assert.deepStrictEqual(saved, [userBounds]);
  });

  it("flushes pending user geometry before text-scale growth rebases the window", () => {
    let scale = 1;
    const saved = [];
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      emitSetBoundsEvents: true,
      getTextScale: () => scale,
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    const moved = { x: 2100, y: 80, width: 480, height: 600 };
    win.bounds = { ...moved };
    win.emit("move");
    scale = 1.6;
    timers.filter((t) => !t.cleared && t.delay === 350).at(-1).callback();

    assert.deepStrictEqual(saved, [moved]);
    assert.deepStrictEqual(win.bounds, { ...moved, width: 512, height: 640 });
    for (const timer of timers.filter((t) => !t.cleared && t.delay === 500)) timer.callback();
    assert.deepStrictEqual(saved, [moved]);
  });

  async function assertFailedPreScaleFlushRetries({ asyncFailure, moved }) {
    let scale = 1;
    let persisted = { x: 40, y: 60, width: 480, height: 600 };
    const attempts = [];
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      emitSetBoundsEvents: true,
      getSavedBounds: () => persisted,
      getTextScale: () => scale,
      onSaveBounds: (bounds) => {
        attempts.push(bounds);
        const response = attempts.length === 1
          ? { status: "error", message: asyncFailure ? "disk full" : "read only" }
          : { status: "ok" };
        if (attempts.length > 1) persisted = bounds;
        if (asyncFailure) return Promise.resolve(response);
        return response;
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.bounds = { ...moved };
    win.emit("move");
    scale = 1.6;
    timers.filter((t) => !t.cleared && t.delay === 350).at(-1).callback();
    if (asyncFailure) {
      await Promise.resolve();
      await Promise.resolve();
    }

    win.emit("close");
    if (asyncFailure) {
      await Promise.resolve();
      await Promise.resolve();
    }
    assert.deepStrictEqual(attempts, [moved, moved]);
    win.emit("closed");
    dashboard.showDashboard();
    assert.deepStrictEqual(getCreatedWindow().bounds, {
      ...moved,
      width: Math.max(moved.width, 512),
      height: Math.max(moved.height, 640),
    });
  }

  it("retries a synchronously failed pre-scale flush after growth", async () => {
    await assertFailedPreScaleFlushRetries({
      asyncFailure: false,
      moved: { x: 600, y: 100, width: 480, height: 600 },
    });
  });

  it("retries an asynchronously failed pre-scale flush after growth", async () => {
    await assertFailedPreScaleFlushRetries({
      asyncFailure: true,
      moved: { x: 600, y: 100, width: 480, height: 600 },
    });
  });

  it("retries a synchronously failed pre-scale flush without growth", async () => {
    await assertFailedPreScaleFlushRetries({
      asyncFailure: false,
      moved: { x: 300, y: 100, width: 800, height: 650 },
    });
  });

  it("retries an asynchronously failed pre-scale flush without growth", async () => {
    await assertFailedPreScaleFlushRetries({
      asyncFailure: true,
      moved: { x: 300, y: 100, width: 800, height: 650 },
    });
  });

  async function assertOlderAsyncCompletionPreservesNewerDebt(firstResponse) {
    let settleFirstSave;
    const attempts = [];
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      onSaveBounds: (bounds) => {
        attempts.push(bounds);
        if (attempts.length === 1) {
          return new Promise((resolve) => {
            settleFirstSave = () => resolve(firstResponse);
          });
        }
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    const olderBounds = { x: 560, y: 100, width: 520, height: 620 };
    const newerBounds = { x: 760, y: 180, width: 620, height: 680 };
    win.bounds = { ...olderBounds };
    win.emit("move");
    timers.filter((timer) => !timer.cleared && timer.delay === 500).at(-1).callback();

    win.bounds = { ...newerBounds };
    win.emit("move");
    // Model a later programmatic operation rebasing the native rectangle before
    // the older asynchronous write completes. The newer user debt must survive.
    dashboard.applyTextScaleToWindow({ flushPendingUserBounds: false });
    settleFirstSave();
    await Promise.resolve();
    await Promise.resolve();

    win.emit("close");
    assert.deepStrictEqual(attempts, [olderBounds, newerBounds]);
  }

  it("does not let an older asynchronous success clear newer user geometry", async () => {
    await assertOlderAsyncCompletionPreservesNewerDebt({ status: "ok" });
  });

  it("does not let an older asynchronous failure revive older user geometry", async () => {
    await assertOlderAsyncCompletionPreservesNewerDebt({ status: "error", message: "disk full" });
  });

  it("keeps failed user geometry retryable across dashboard window recreation", () => {
    const persisted = { x: 40, y: 60, width: 480, height: 600 };
    const moved = { x: 700, y: 220, width: 620, height: 660 };
    const attempts = [];
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      getSavedBounds: () => persisted,
      onSaveBounds: (bounds) => {
        attempts.push(bounds);
        return attempts.length < 3
          ? { status: "error", message: "read only" }
          : { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const first = getCreatedWindow();
    first.bounds = { ...moved };
    first.emit("move");
    timers.filter((timer) => !timer.cleared && timer.delay === 500).at(-1).callback();
    first.emit("close");
    first.emit("closed");

    dashboard.showDashboard();
    const second = getCreatedWindow();
    assert.deepStrictEqual(second.bounds, persisted);
    second.emit("close");
    assert.deepStrictEqual(attempts, [moved, moved, moved]);
  });

  it("keeps failed user geometry through settings re-anchor and transient window cycles", () => {
    for (const exposeMaximizedFlag of [true, false]) {
      let persisted = { x: 40, y: 60, width: 520, height: 520 };
      const attempts = [];
      const settingsWindow = {
        isDestroyed: () => false,
        isMinimized: () => false,
        getBounds: () => ({ x: 100, y: 50, width: 800, height: 560 }),
      };
      const { dashboard, getCreatedWindow } = createWindowHarness({
        getSettingsWindow: () => settingsWindow,
        getSavedBounds: () => persisted,
        onSaveBounds: (bounds) => {
          attempts.push(bounds);
          if (attempts.length === 1) return { status: "error", message: "read only" };
          persisted = bounds;
          return { status: "ok" };
        },
      });

      dashboard.showDashboard();
      const win = getCreatedWindow();
      const moved = { x: 700, y: 180, width: 520, height: 560 };
      win.bounds = { ...moved };
      win.emit("move");
      dashboard.showDashboard({ source: "settings" });
      assert.deepStrictEqual(win.bounds, { x: 260, y: 50, width: 480, height: 560 });

      win.normalBounds = { ...win.bounds };
      win.maximized = exposeMaximizedFlag;
      win.bounds = { x: 0, y: 0, width: 1280, height: 800 };
      win.emit("resize");
      win.emit("move");
      win.maximized = false;
      win.bounds = { ...win.normalBounds };
      win.emit("resize");
      win.emit("move");

      win.emit("close");
      assert.deepStrictEqual(attempts, [moved, moved]);
      win.emit("closed");
      dashboard.showDashboard();
      assert.deepStrictEqual(getCreatedWindow().bounds, moved);
    }
  });

  it("keeps a failed synchronous persistence retryable", () => {
    const attempts = [];
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      onSaveBounds: (bounds) => {
        attempts.push(bounds);
        return attempts.length === 1
          ? { status: "error", message: "read only" }
          : { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.bounds = { x: 310, y: 220, width: 880, height: 620 };
    win.emit("resize");
    timers.filter((t) => t.delay === 500).at(-1).callback();
    win.emit("resize");
    timers.filter((t) => t.delay === 500).at(-1).callback();

    assert.strictEqual(attempts.length, 2);
  });

  it("keeps a failed asynchronous persistence retryable", async () => {
    const attempts = [];
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      onSaveBounds: (bounds) => {
        attempts.push(bounds);
        return Promise.resolve(attempts.length === 1
          ? { status: "error", message: "disk full" }
          : { status: "ok" });
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.bounds = { x: 310, y: 220, width: 880, height: 620 };
    win.emit("resize");
    timers.filter((t) => t.delay === 500).at(-1).callback();
    await Promise.resolve();
    await Promise.resolve();
    win.emit("resize");
    timers.filter((t) => t.delay === 500).at(-1).callback();

    assert.strictEqual(attempts.length, 2);
  });

  it("destroyed windows and closed cleanup cannot fire a pending bounds save", () => {
    const saved = [];
    const { dashboard, getCreatedWindow, timers } = createWindowHarness({
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.bounds = { x: 310, y: 220, width: 880, height: 620 };
    win.emit("resize");
    const pendingSave = timers.filter((t) => t.delay === 500).at(-1);
    win.destroyed = true;
    win.emit("closed");

    assert.strictEqual(pendingSave.cleared, true);
    pendingSave.callback();
    assert.deepStrictEqual(saved, []);
  });

  it("normal-bounds lookup falls back to current bounds when unavailable", () => {
    const saved = [];
    const { dashboard, getCreatedWindow } = createWindowHarness({
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.bounds = { x: 330, y: 240, width: 860, height: 610 };
    win.getNormalBounds = () => { throw new Error("unsupported"); };
    win.emit("close");

    assert.deepStrictEqual(saved, [
      { x: 330, y: 240, width: 860, height: 610 },
    ]);
  });

  it("rounds fractional native bounds before handing them to persistence", () => {
    const saved = [];
    const { dashboard, getCreatedWindow } = createWindowHarness({
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    win.bounds = { x: 10.6, y: -20.6, width: 801.7, height: 559.8 };
    win.emit("close");

    assert.deepStrictEqual(saved, [
      { x: 11, y: -21, width: 802, height: 560 },
    ]);
  });

  it("saved bounds override native constructor frame drift", () => {
    const savedBounds = { x: 40, y: 60, width: 500, height: 520 };
    const { dashboard, getCreatedWindow } = createWindowHarness({
      constructorBoundsOffset: { width: 2 },
      getSavedBounds: () => savedBounds,
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();

    assert.deepStrictEqual(win.bounds, savedBounds);
    assert.deepStrictEqual(win.setBoundsCalls, [savedBounds]);
  });

  it("an untouched window does not persist native frame quantization on close", () => {
    const saved = [];
    const savedBounds = { x: 40, y: 60, width: 500, height: 520 };
    const { dashboard, getCreatedWindow } = createWindowHarness({
      constructorBoundsOffset: { width: 2 },
      // Simulate a WM that cannot adopt the requested outer width exactly
      // even when the runtime follows up with setBounds().
      setBoundsOffset: { width: 1 },
      getSavedBounds: () => savedBounds,
      onSaveBounds: (bounds) => {
        saved.push(bounds);
        return { status: "ok" };
      },
    });

    dashboard.showDashboard();
    const win = getCreatedWindow();
    assert.deepStrictEqual(win.getBounds(), { ...savedBounds, width: 501 });

    win.emit("close");
    assert.deepStrictEqual(saved, []);
  });

  it("exposes a Clawd-only hide action instead of a terminal close action", () => {
    const rendererSource = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8");
    const preloadSource = fs.readFileSync(path.join(__dirname, "..", "src", "preload-dashboard.js"), "utf8");

    assert.match(rendererSource, /dashboardHideSessionTitle/);
    assert.match(rendererSource, /hideSession\(session\.id\)/);
    assert.match(rendererSource, /session\.canFocus !== true/);
    assert.match(rendererSource, /dashboardOpenCodexSession/);
    assert.doesNotMatch(rendererSource, /session\.platform === "webui"/);
    assert.match(preloadSource, /dashboard:hide-session/);
  });

  it("wires Dashboard persistence to the Dashboard bounds key in main", () => {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    const start = mainSource.indexOf('const _dashboard = require("./dashboard")({');
    const end = mainSource.indexOf("\n});", start);
    assert.ok(start >= 0 && end > start, "Dashboard runtime wiring block must exist");
    const wiring = mainSource.slice(start, end);

    assert.match(
      wiring,
      /getSavedBounds:\s*\(\)\s*=>\s*_settingsController\.get\("dashboardWindowBounds"\)/,
    );
    assert.match(
      wiring,
      /onSaveBounds:\s*\(bounds\)\s*=>\s*_settingsController\.applyUpdate\("dashboardWindowBounds", bounds\)/,
    );
    assert.doesNotMatch(wiring, /settingsWindowBounds/);
  });

  it("wires account quota (including Dashboard-only Spark) into the dashboard header", () => {
    const rendererSource = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8");
    const htmlSource = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard.html"), "utf8");
    const preloadSource = fs.readFileSync(path.join(__dirname, "..", "src", "preload-dashboard.js"), "utf8");

    assert.match(htmlSource, /id="quotaSummary" class="quota-summary" hidden/);
    // Quota renders from the session-independent per-source store
    // (snapshot.accountQuota), grouped local + one row per remote host —
    // never from per-session fields.
    assert.match(rendererSource, /renderQuotaSummary\(snapshot\)/);
    assert.match(rendererSource, /snapshot\.accountQuota/);
    assert.doesNotMatch(rendererSource, /resolveQuotaForDisplay/);
    assert.match(rendererSource, /buildQuotaSourceHeader/);
    // Wall-clock expiry: a bucket whose resetAt passed must not keep showing
    // the pre-reset high between snapshots.
    assert.match(rendererSource, /isExpiredBucket/);
    // Quiet sources are labeled instead of presenting old numbers as live.
    assert.match(rendererSource, /QUOTA_STALE_AFTER_MS/);
    // Codex can change which rate-limit windows it exposes. The Dashboard
    // must use reporter metadata rather than the legacy slot label.
    assert.match(rendererSource, /formatQuotaWindowLabel/);
    assert.match(rendererSource, /bucket && bucket\.windowMinutes/);
    assert.match(rendererSource, /source\.codexSparkQuota/);
    assert.match(rendererSource, /refreshKimiQuotaFromDashboard/);
    assert.match(rendererSource, /quota-refresh-button/);
    assert.match(preloadSource, /dashboard:refresh-kimi-quota/);
    for (const key of [
      "dashboardQuotaSectionAntigravity",
      "dashboardQuotaGroupGemini",
      "dashboardQuotaGroupThirdParty",
      "dashboardQuotaSectionClaudeCode",
      "dashboardQuotaSectionCodex",
      "dashboardQuotaSectionCodexSpark",
      "dashboardQuotaSourceLocal",
      "dashboardQuotaAsOf",
      "dashboardQuotaFiveHour",
      "dashboardQuotaWeekly",
      "dashboardQuotaResetIn",
      "dashboardQuotaResetOn",
      "dashboardQuotaResetHoursMinutes",
      "dashboardQuotaResetMinutes",
    ]) {
      assert.match(rendererSource, new RegExp(key));
    }
  });

  it("memoizes the quota summary rebuild instead of rebuilding on every 1s render tick", () => {
    const rendererSource = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8");

    assert.match(rendererSource, /computeQuotaSummarySignature\(accountQuota\)/);
    assert.match(rendererSource, /if \(signature === lastQuotaSummarySignature\) return;/);
    assert.match(rendererSource, /resetDateFormatterLang !== lang/);
  });

  it("does not replace an open session automation picker on the one-second render tick", () => {
    const rendererSource = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8");
    const dashboardHtml = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard.html"), "utf8");

    assert.match(rendererSource, /function hasOpenSessionAutomationPicker\(\)/);
    assert.match(rendererSource, /element\.classList\.contains\("open"\)/);
    assert.match(rendererSource, /disposeSessionAutomationPickers\(\);/);
    assert.match(
      rendererSource,
      /\(activeEdit \|\| hasOpenSessionAutomationPicker\(\)\) && !options\.force/
    );
    assert.match(dashboardHtml, /style-src 'self' 'unsafe-inline'/);
    assert.match(dashboardHtml, /<link rel="stylesheet" href="language-picker\.css">/);
    assert.match(dashboardHtml, /<script src="\.\/language-picker\.js"><\/script>/);
  });
});
