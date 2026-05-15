"use strict";

const assert = require("node:assert");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { describe, it } = require("node:test");

const DASHBOARD_MODULE_PATH = require.resolve("../src/dashboard");

function loadDashboardWithElectron(fakeElectron) {
  delete require.cache[DASHBOARD_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return fakeElectron;
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

    class FakeBrowserWindow {
      constructor(opts) {
        this.opts = opts;
        this.bounds = {
          x: opts.x,
          y: opts.y,
          width: opts.width,
          height: opts.height,
        };
        this.backgroundColors = [opts.backgroundColor];
        this.parentWindows = [];
        this.setBoundsCalls = [];
        this.onceCallbacks = new Map();
        this.webContents = {
          isDestroyed: () => false,
          once: () => {},
          send: () => {},
        };
        createdWindow = this;
      }
      isDestroyed() { return false; }
      isMinimized() { return false; }
      restore() {}
      show() {}
      focus() {}
      setMenuBarVisibility() {}
      loadFile() {}
      once(eventName, callback) { this.onceCallbacks.set(eventName, callback); }
      on() {}
      setBackgroundColor(color) { this.backgroundColors.push(color); }
      setBounds(bounds) {
        this.bounds = { ...bounds };
        this.setBoundsCalls.push({ ...bounds });
      }
      setParentWindow(parentWindow) {
        this.parentWindows.push(parentWindow);
      }
      emitReadyToShow() {
        const callback = this.onceCallbacks.get("ready-to-show");
        if (callback) callback();
      }
    }

    const initDashboard = loadDashboardWithElectron({
      BrowserWindow: FakeBrowserWindow,
      nativeTheme,
    });
    const dashboard = initDashboard({
      getPetWindowBounds: () => ({ x: 100, y: 100, width: 120, height: 120 }),
      getNearestWorkArea: options.getNearestWorkArea || (() => ({ x: 0, y: 0, width: 1280, height: 800 })),
      getSettingsWindow: options.getSettingsWindow,
      setTimeout: options.setTimeout || ((callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
      }),
      getSessionSnapshot: () => ({ sessions: [], groups: [] }),
      getI18n: () => ({ lang: "en", translations: {} }),
    });

    return {
      dashboard,
      nativeTheme,
      timers,
      getCreatedWindow: () => createdWindow,
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
});
