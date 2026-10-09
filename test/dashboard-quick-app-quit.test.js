"use strict";

// WIN-R3: a real application quit must not be vetoed by the quick host.
//
// The quick host is a borrow surface, so its own `close` handler cancels the
// close and returns the page instead of destroying the Dashboard. Electron
// closes every window BEFORE `will-quit`, so tearing the quick host down only
// in `will-quit` deadlocks the quit: the close is refused, the window survives,
// `will-quit` never runs and the process stays alive (measured on Windows with
// a hidden quick BaseWindow left behind after a menu Quit).
//
// These tests drive the documented Electron quit ordering
// (`before-quit` → close every window → `will-quit`) against the real
// dashboard.js / dashboard-quick-mode.js. The lifecycle events the teardown is
// attached to are read out of main.js rather than assumed, so this is a test of
// the shipped wiring order and not of a hand-picked one.

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");

const DASHBOARD_MODULE_PATH = require.resolve("../src/dashboard");
const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

// Which app lifecycle events main.js really hangs the quick-host teardown on.
// Reading them instead of hard-coding them keeps the simulated quit honest: if
// the teardown only runs too late, this harness reproduces exactly that.
function quickDisposeQuitEvents() {
  const pattern = /app\.on\("([a-z-]+)",\s*\(\)\s*=>\s*_dashboard\.quick\.dispose\(\)\)/g;
  const events = [];
  let match = pattern.exec(MAIN_SOURCE);
  while (match) {
    events.push(match[1]);
    match = pattern.exec(MAIN_SOURCE);
  }
  return events;
}

function loadDashboardWithElectron(fakeElectron, originFocus) {
  delete require.cache[DASHBOARD_MODULE_PATH];
  delete require.cache[require.resolve("../src/dashboard-quick-mode")];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === "electron") return fakeElectron;
    if (request === "./quick-select-origin-focus" && originFocus) return () => originFocus;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/dashboard");
  } finally {
    Module._load = originalLoad;
  }
}

function harness(options = {}) {
  const windows = [];
  const nativeTheme = new EventEmitter();
  nativeTheme.shouldUseDarkColors = false;
  let createdView = null;
  let quitting = false;

  class FakeWebContents {
    constructor() {
      this.destroyed = false;
      this.crashed = false;
      this.sent = [];
      this.onceCallbacks = new Map();
      this.onCallbacks = new Map();
      this.closeCount = 0;
      this.focusCount = 0;
    }
    isDestroyed() { return this.destroyed; }
    isCrashed() { return this.crashed; }
    send(channel, payload) { this.sent.push({ channel, payload }); }
    focus() { this.focusCount += 1; }
    insertCSS() { return Promise.resolve("key"); }
    setZoomFactor() {}
    loadFile() { return Promise.resolve(); }
    close() {
      this.closeCount += 1;
      this.destroyed = true;
      for (const win of windows) {
        win.contentView.children = win.contentView.children.filter(view => view.webContents !== this);
      }
      this.emit("destroyed");
    }
    once(name, callback) { this.onceCallbacks.set(name, callback); }
    on(name, callback) {
      const list = this.onCallbacks.get(name) || [];
      list.push(callback);
      this.onCallbacks.set(name, list);
    }
    emitOnce(name) {
      const callback = this.onceCallbacks.get(name);
      if (callback) callback();
    }
    emit(name, ...args) {
      for (const callback of this.onCallbacks.get(name) || []) callback(...args);
    }
  }

  class FakeWebContentsView {
    constructor(opts) {
      this.opts = opts;
      this.webContents = new FakeWebContents();
      createdView = this;
    }
    setBounds() {}
  }

  class FakeBaseWindow {
    constructor(opts) {
      this.opts = opts;
      this.bounds = {
        x: opts.x || 0,
        y: opts.y || 0,
        width: opts.width || 480,
        height: opts.height || 600,
      };
      this.destroyed = false;
      this.visible = false;
      this.focused = false;
      this.opacity = 1;
      this.opacityCalls = [];
      this.ignoreMouseCalls = [];
      this.hiddenCount = 0;
      this.closePrevented = 0;
      this.closeEvents = 0;
      this.destroyCount = 0;
      this.addedViews = [];
      this.removedViews = [];
      this.rejectedViews = [];
      this.rejectAdds = false;
      this.onCallbacks = new Map();
      this.onceCallbacks = new Map();
      const self = this;
      this.contentView = {
        children: [],
        addChildView(view) {
          if (view.webContents.isDestroyed() || self.rejectAdds) {
            self.rejectedViews.push(view);
            throw Error("view cannot be attached");
          }
          self.addedViews.push(view);
          for (const win of windows) win.contentView.children = win.contentView.children.filter(child => child !== view);
          this.children.push(view);
        },
        removeChildView(view) {
          self.removedViews.push(view);
          this.children = this.children.filter(child => child !== view);
        },
      };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    isVisible() { return this.visible; }
    isFocused() { return this.focused; }
    restore() {}
    show() { this.visible = true; }
    hide() { this.visible = false; this.hiddenCount += 1; }
    focus() { this.focused = true; }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.destroyCount += 1;
      // Electron's destroy() force-closes: no `close`, only `closed`.
      this.emit("closed");
    }
    getOpacity() { return this.opacity; }
    setOpacity(value) { this.opacity = value; this.opacityCalls.push(value); }
    setIgnoreMouseEvents(value) { this.ignoreMouseCalls.push(value); }
    getContentSize() { return [this.bounds.width, this.bounds.height]; }
    getBounds() { return { ...this.bounds }; }
    getNormalBounds() { return { ...this.bounds }; }
    setBounds(bounds) { this.bounds = { ...bounds }; }
    setBackgroundColor() {}
    setMenuBarVisibility() {}
    setMinimumSize() {}
    on(name, callback) {
      const list = this.onCallbacks.get(name) || [];
      list.push(callback);
      this.onCallbacks.set(name, list);
    }
    once(name, callback) { this.onceCallbacks.set(name, callback); }
    emit(name, ...args) {
      for (const callback of this.onCallbacks.get(name) || []) callback(...args);
    }
    // What the window manager does when the app asks every window to close.
    requestClose() {
      if (this.destroyed) return true;
      this.closeEvents += 1;
      let prevented = false;
      this.emit("close", { preventDefault() { prevented = true; } });
      if (prevented) {
        this.closePrevented += 1;
        return false;
      }
      this.destroy();
      return true;
    }
    emitReadyToShow() {
      if (createdView) createdView.webContents.emitOnce("did-finish-load");
    }
  }

  const fakeElectron = {
    BaseWindow: FakeBaseWindow,
    WebContentsView: FakeWebContentsView,
    BrowserWindow: FakeBaseWindow,
    nativeTheme,
  };

  const initDashboard = loadDashboardWithElectron(fakeElectron, options.originFocus);
  const dashboard = initDashboard({
    platform: options.platform || "darwin",
    electron: fakeElectron,
    isAppQuitting: () => quitting,
    getPetWindowBounds: () => ({ x: 100, y: 100, width: 120, height: 120 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    getSessionSnapshot: () => ({
      sessions: [{ id: "s1", canFocus: true, displayTitle: "S1" }],
      groups: [{ host: "local", ids: ["s1"] }],
    }),
    getI18n: () => ({ lang: "en", translations: {} }),
    setTimeout: () => 0,
    clearTimeout: () => {},
  });

  const app = new EventEmitter();
  // The wiring main.js actually ships, taken from its source.
  for (const event of quickDisposeQuitEvents()) {
    app.on(event, () => dashboard.quick.dispose());
  }

  // Electron's documented sequence: `before-quit`, then every window is asked
  // to close, and `will-quit`/exit only follow once they are all gone.
  function quitApp() {
    quitting = true;
    app.emit("before-quit");
    let closedAll = true;
    for (const win of [...windows]) {
      if (win.destroyed) continue;
      if (!win.requestClose()) closedAll = false;
    }
    if (closedAll) app.emit("will-quit");
    return closedAll;
  }

  return {
    dashboard,
    windows,
    quitApp,
    setQuitting: (value) => { quitting = value; },
    page: () => createdView.webContents,
    ordinary: () => windows[0] || null,
    quickWindow: () => dashboard.quick.getQuickWindow(),
    openDashboard() {
      dashboard.showDashboard();
      windows[0].emitReadyToShow();
      windows[0].visible = true;
      windows[0].focused = false;
      return windows[0];
    },
    borrow() {
      const started = dashboard.quick.show();
      dashboard.quick.enter({ revision: started.revision, busy: false });
      dashboard.quick.ready({ revision: started.revision, busy: false });
      return started;
    },
  };
}

test("a menu Quit tears the hidden quick host down instead of being blocked by it", () => {
  const h = harness();
  h.openDashboard();
  const started = h.borrow();
  // The user cancelled: the host is hidden but still alive, which is the state
  // the Windows evidence quit from.
  h.dashboard.quick.dismissFromRenderer({ revision: started.revision });
  const quick = h.quickWindow();
  assert.ok(quick, "the quick host exists");
  assert.equal(quick.isVisible(), false, "and is hidden");

  const quitted = h.quitApp();

  assert.equal(quitted, true, "every window closed, so the quit can finish");
  assert.equal(quick.closePrevented, 0, "the quick host never vetoed the quit");
  assert.equal(quick.isDestroyed(), true);
  assert.equal(h.ordinary().isDestroyed(), true);
  assert.equal(h.page().closeCount, 1, "the single WebContents is closed once");
});

test("a quit with no quick host ever created still closes cleanly", () => {
  const h = harness();
  h.openDashboard();

  const quitted = h.quitApp();

  assert.equal(quitted, true);
  assert.equal(h.quickWindow(), null, "nothing was created just to be disposed");
  assert.equal(h.windows.length, 1);
  assert.equal(h.page().closeCount, 1);
});

test("a quit during a live borrow returns the page and un-parks before closing", () => {
  const h = harness();
  const ordinary = h.openDashboard();
  h.borrow();
  assert.equal(h.dashboard.quick.isShown(), true);
  assert.deepEqual(ordinary.opacityCalls, [0], "parked while borrowed");

  const quitted = h.quitApp();

  assert.equal(quitted, true);
  assert.deepEqual(ordinary.opacityCalls, [0, 1], "restored to its captured value");
  assert.deepEqual(ordinary.ignoreMouseCalls, [true, false]);
  assert.equal(ordinary.addedViews.length >= 2, true, "the page came back first");
  assert.equal(h.dashboard.quick.isActive(), false);
  assert.equal(h.page().closeCount, 1);
});

test("destroying the borrowed page retires the empty Windows shell through the real owner wiring", () => {
  let nativeForeground = null;
  const h = harness({ platform: "win32", originFocus: {
    capture: () => "minimized-source",
    restore: () => false,
    holdsForeground: win => win === nativeForeground,
  } });
  h.borrow();
  const shell = h.quickWindow();
  const ordinary = h.ordinary();
  const page = h.page();
  nativeForeground = shell;
  const focusedBefore = page.focusCount;
  page.close(); // real dashboard destroyed listener, not a direct quick-mode call
  assert.equal(page.isDestroyed(), true);
  assert.equal(ordinary.rejectedViews.length, 2, "both native reattach and rollback rejected the dead view");
  assert.deepEqual(shell.contentView.children, []);
  assert.deepEqual(ordinary.contentView.children, []);
  assert.equal(shell.destroyCount, 1, "pageReturned=false must not strand a proven-dead page's empty shell");
  assert.equal(h.quickWindow(), null);
  assert.equal(ordinary.isVisible(), false);
  assert.equal(page.focusCount, focusedBefore, "there is no page left to focus");
  page.emit("destroyed");
  assert.equal(shell.destroyCount, 1, "a repeated destruction notification is harmless");
  assert.equal(h.quitApp(), true);
  assert.equal(page.closeCount, 1, "normal quit does not close the dead page again");
});

test("a crashed but live page cannot bypass a failed return through the real owner wiring", () => {
  let nativeForeground = null;
  const h = harness({ platform: "win32", originFocus: {
    capture: () => "minimized-source",
    restore: () => false,
    holdsForeground: win => win === nativeForeground,
  } });
  h.borrow();
  const shell = h.quickWindow();
  const page = h.page();
  nativeForeground = shell;
  h.ordinary().rejectAdds = true;
  page.crashed = true;
  const focusedBefore = page.focusCount;
  page.emit("render-process-gone");
  assert.equal(page.isDestroyed(), false);
  assert.equal(h.ordinary().rejectedViews.length, 2);
  assert.deepEqual(shell.contentView.children, []);
  assert.equal(shell.destroyCount, 0, "crashed is not destroyed; the live page still needs a safe return");
  assert.equal(h.quickWindow(), shell);
  assert.equal(page.focusCount, focusedBefore);
  assert.equal(h.quitApp(), true);
});

test("a crashed but live page that returned safely still allows empty-shell retirement", () => {
  let nativeForeground = null;
  const h = harness({ platform: "win32", originFocus: {
    capture: () => "minimized-source",
    restore: () => false,
    holdsForeground: win => win === nativeForeground,
  } });
  h.borrow();
  const shell = h.quickWindow();
  const page = h.page();
  nativeForeground = shell;
  page.crashed = true;
  const focusedBefore = page.focusCount;
  page.emit("render-process-gone");
  assert.equal(page.isDestroyed(), false);
  assert.equal(page.isCrashed(), true);
  assert.equal(h.ordinary().rejectedViews.length, 0);
  assert.equal(h.ordinary().contentView.children[0].webContents, page);
  assert.deepEqual(shell.contentView.children, []);
  assert.equal(shell.destroyCount, 1, "a successful return does not need the new death-proof exception");
  assert.equal(h.quickWindow(), null);
  assert.equal(page.focusCount, focusedBefore, "the crashed page is not focused");
  assert.equal(h.quitApp(), true);
});

test("closing the ordinary owner during a borrow cannot poison later empty-shell retirement", () => {
  // The source stays unavailable; model only the native ownership needed for
  // retirement. This test exercises the real dashboard and host teardown.
  const h = harness({ platform: "win32", originFocus: {
    capture: () => "minimized-source",
    restore: () => false,
    holdsForeground: () => true,
  } });
  const ordinary = h.openDashboard();
  h.borrow();
  const shell = h.quickWindow();
  const oldPage = h.page();
  assert.equal(shell.contentView.children.length, 1);
  assert.equal(ordinary.requestClose(), true);
  assert.equal(oldPage.isDestroyed(), true);
  assert.equal(oldPage.closeCount, 1);
  assert.equal(shell.destroyCount, 1, "closing the Dashboard owner also disposes its obsolete shell");
  assert.equal(h.quickWindow(), null);

  const next = h.borrow();
  const nextShell = h.quickWindow();
  assert.notEqual(nextShell, shell);
  assert.notEqual(h.page(), oldPage, "only a closed Dashboard needs a new page");
  assert.equal(nextShell.contentView.children.length, 1, "no stale view accompanies the new page");
  const newOrdinary = h.dashboard.quick.getActiveHost() === nextShell
    ? h.windows.find(win => win !== nextShell && !win.isDestroyed()) : null;
  assert.ok(newOrdinary);
  assert.equal(newOrdinary.isVisible(), false, "re-created ordinary host stays hidden");
  h.dashboard.quick.dismissFromRenderer({ revision: next.revision });
  assert.equal(nextShell.destroyCount, 1);
  assert.equal(h.quickWindow(), null);
  assert.equal(h.page().isDestroyed(), false, "the current page was returned, not destroyed");
  assert.equal(h.page().closeCount, 0);
  assert.equal(newOrdinary.contentView.children.length, 1);
  assert.equal(h.quitApp(), true, "quit still works after the retirement");
  assert.equal(h.page().closeCount, 1);
});

test("a quit after busy refusal closes the still-borrowed editor without a numeric round", () => {
  const h = harness();
  const ordinary = h.openDashboard();
  h.borrow();
  const refused = h.dashboard.quick.show();
  h.dashboard.quick.enter({ revision: refused.revision, busy: true });
  assert.equal(h.dashboard.quick.isShown(), true);
  assert.equal(h.dashboard.quick.isActive(), false);
  assert.equal(h.quitApp(), true);
  assert.deepEqual(ordinary.opacityCalls, [0, 1]);
  assert.deepEqual(ordinary.ignoreMouseCalls, [true, false]);
  assert.equal(h.page().closeCount, 1);
});

test("a quit during an in-place round closes without creating a quick host", () => {
  const h = harness();
  const ordinary = h.openDashboard();
  ordinary.focused = true;
  const started = h.dashboard.quick.show();
  h.dashboard.quick.enter({ revision: started.revision, busy: false });
  assert.equal(h.dashboard.quick.ready({ revision: started.revision }).inPlace, true);

  const quitted = h.quitApp();

  assert.equal(quitted, true);
  assert.equal(h.quickWindow(), null);
  assert.equal(h.dashboard.quick.isActive(), false);
  assert.equal(h.page().closeCount, 1);
});

test("repeating the quit sequence is idempotent", () => {
  const h = harness();
  h.openDashboard();
  const started = h.borrow();
  h.dashboard.quick.dismissFromRenderer({ revision: started.revision });
  const quick = h.quickWindow();

  assert.equal(h.quitApp(), true);
  assert.equal(h.quitApp(), true, "a second quit pass throws nothing");

  assert.equal(quick.destroyCount, 1);
  assert.equal(h.ordinary().destroyCount, 1);
  assert.equal(h.page().closeCount, 1, "the WebContents is still closed exactly once");
});

test("a user closing the quick host only cancels the round", () => {
  const h = harness();
  const ordinary = h.openDashboard();
  h.borrow();
  const quick = h.quickWindow();

  // Not quitting: the close is refused and the page goes home.
  const closed = quick.requestClose();

  assert.equal(closed, false, "the borrow surface is not destroyed by its X");
  assert.equal(quick.closePrevented, 1);
  assert.equal(h.dashboard.quick.isActive(), false, "but the round ended");
  assert.equal(ordinary.isDestroyed(), false, "the Dashboard itself survives");
  assert.deepEqual(ordinary.opacityCalls, [0, 1]);
  assert.equal(h.page().closeCount, 0, "the page is returned, never closed");
});

test("a close that arrives while the app is quitting is never vetoed", () => {
  const h = harness();
  const ordinary = h.openDashboard();
  h.borrow();
  const quick = h.quickWindow();

  // The window manager asks the quick host to close during a quit that has not
  // reached this owner's own teardown yet.
  h.setQuitting(true);
  const closed = quick.requestClose();

  assert.equal(closed, true);
  assert.equal(quick.closePrevented, 0);
  assert.equal(h.dashboard.quick.isActive(), false);
  assert.deepEqual(ordinary.opacityCalls, [0, 1], "the page still came home first");
  assert.equal(h.page().closeCount, 0, "closing the borrow surface never closes the page");
});

test("main.js tears the quick host down on before-quit, not only on will-quit", () => {
  const source = MAIN_SOURCE;

  assert.match(
    source,
    /app\.on\("before-quit",\s*\(\)\s*=>\s*_dashboard\.quick\.dispose\(\)\)/,
    "Electron closes windows before will-quit, so the teardown has to run there"
  );
  assert.match(
    source,
    /app\.on\("will-quit",\s*\(\)\s*=>\s*_dashboard\.quick\.dispose\(\)\)/,
    "the will-quit call stays as an idempotent backstop"
  );
  assert.match(
    source,
    /isAppQuitting:\s*\(\)\s*=>\s*isQuitting/,
    "the quick host's close handler needs to know a quit is in progress"
  );
});
