"use strict";

const assert = require("node:assert");
const EventEmitter = require("node:events");
const Module = require("node:module");
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
  it("updates its background color when native theme changes", () => {
    let createdWindow = null;

    class FakeBrowserWindow {
      constructor(opts) {
        this.opts = opts;
        this.backgroundColors = [opts.backgroundColor];
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
      once() {}
      on() {}
      setBackgroundColor(color) { this.backgroundColors.push(color); }
    }

    const nativeTheme = new EventEmitter();
    nativeTheme.shouldUseDarkColors = false;
    const initDashboard = loadDashboardWithElectron({
      BrowserWindow: FakeBrowserWindow,
      nativeTheme,
    });

    const dashboard = initDashboard({
      getPetWindowBounds: () => ({ x: 100, y: 100, width: 120, height: 120 }),
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
      getSessionSnapshot: () => ({ sessions: [], groups: [] }),
      getI18n: () => ({ lang: "en", translations: {} }),
    });

    dashboard.showDashboard();
    assert.strictEqual(createdWindow.opts.backgroundColor, "#f5f5f7");

    nativeTheme.shouldUseDarkColors = true;
    nativeTheme.emit("updated");

    assert.deepStrictEqual(createdWindow.backgroundColors, ["#f5f5f7", "#1c1c1f"]);
  });
});
