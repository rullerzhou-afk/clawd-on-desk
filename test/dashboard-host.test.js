"use strict";

// The platform host wrapper. The point of these tests is that a wrong-API
// migration fails loudly: the BaseWindow fake deliberately offers none of
// `webContents`, `loadFile()` or `ready-to-show`, because the real BaseWindow
// offers none of them either.

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createDashboardHost, usesWebContentsView } = require("../src/dashboard-host");

class FakeBaseWindow {
  constructor(opts) {
    this.opts = opts;
    this.destroyed = false;
    this.handlers = new Map();
    this.addedViews = [];
    this.removedViews = [];
    this.contentSize = [480, 600];
    const self = this;
    this.contentView = {
      addChildView(view) { self.addedViews.push(view); },
      removeChildView(view) { self.removedViews.push(view); },
    };
  }
  isDestroyed() { return this.destroyed; }
  getContentSize() { return this.contentSize; }
  on(event, handler) { this.handlers.set(event, handler); }
  once(event, handler) { this.handlers.set(`once:${event}`, handler); }
  emit(event) {
    const handler = this.handlers.get(event);
    if (handler) handler();
  }
}

class FakeWebContents {
  constructor() {
    this.destroyed = false;
    this.loaded = [];
    this.closeCount = 0;
    this.handlers = new Map();
  }
  isDestroyed() { return this.destroyed; }
  loadFile(file) { this.loaded.push(file); return Promise.resolve(); }
  close() { this.closeCount += 1; }
  once(event, handler) { this.handlers.set(event, handler); }
  on(event, handler) { this.handlers.set(event, handler); }
  emit(event) {
    const handler = this.handlers.get(event);
    if (handler) handler();
  }
}

class FakeWebContentsView {
  constructor(opts) {
    this.opts = opts;
    this.webContents = new FakeWebContents();
    this.boundsCalls = [];
  }
  setBounds(bounds) { this.boundsCalls.push({ ...bounds }); }
}

class FakeBrowserWindow extends FakeBaseWindow {
  constructor(opts) {
    super(opts);
    this.webContents = new FakeWebContents();
    this.readyToShow = null;
  }
  loadFile(file) { this.webContents.loadFile(file); }
  once(event, handler) {
    if (event === "ready-to-show") this.readyToShow = handler;
    super.once(event, handler);
  }
}

const electron = {
  BaseWindow: FakeBaseWindow,
  BrowserWindow: FakeBrowserWindow,
  WebContentsView: FakeWebContentsView,
};

const windowOptions = {
  x: 0,
  y: 0,
  width: 480,
  height: 600,
  webPreferences: { preload: "/tmp/preload.js", contextIsolation: true },
};

test("only darwin and win32 use the WebContentsView host", () => {
  assert.equal(usesWebContentsView("darwin"), true);
  assert.equal(usesWebContentsView("win32"), true);
  assert.equal(usesWebContentsView("linux"), false);
});

test("darwin builds BaseWindow + WebContentsView and keeps webPreferences on the view", () => {
  const host = createDashboardHost({ platform: "darwin", electron, windowOptions });

  assert.equal(host.usesView, true);
  assert.ok(host.window instanceof FakeBaseWindow);
  assert.equal(host.window.webContents, undefined, "BaseWindow must not expose webContents");
  assert.equal(typeof host.window.loadFile, "undefined", "BaseWindow has no loadFile");
  assert.equal(host.window.opts.webPreferences, undefined, "webPreferences belong to the view");
  assert.deepEqual(host.view.opts, { webPreferences: windowOptions.webPreferences });
  assert.equal(host.webContents, host.view.webContents);
  assert.deepEqual(host.window.addedViews, [host.view]);
});

test("the view is laid out to the window content size on creation and on resize", () => {
  const host = createDashboardHost({ platform: "darwin", electron, windowOptions });
  assert.deepEqual(host.view.boundsCalls, [{ x: 0, y: 0, width: 480, height: 600 }]);

  host.window.contentSize = [640, 700];
  host.window.emit("resize");
  assert.deepEqual(host.view.boundsCalls.at(-1), { x: 0, y: 0, width: 640, height: 700 });
});

test("an ordinary-host resize does not re-lay out a borrowed page", () => {
  const host = createDashboardHost({ platform: "darwin", electron, windowOptions });
  const quickWindow = new FakeBaseWindow({ ...windowOptions });
  quickWindow.contentSize = [360, 420];

  host.setHostedWindow(quickWindow);
  assert.deepEqual(host.view.boundsCalls.at(-1), { x: 0, y: 0, width: 360, height: 420 });
  assert.equal(host.getHostedWindow(), quickWindow);

  // The ordinary window is parked and empty; its resize must not shrink the
  // page that is currently living in the quick host.
  const before = host.view.boundsCalls.length;
  host.window.contentSize = [1280, 900];
  host.window.emit("resize");
  assert.equal(host.view.boundsCalls.length, before, "no layout while borrowed");

  // syncViewBounds always follows whoever actually holds the view.
  host.syncViewBounds();
  assert.deepEqual(host.view.boundsCalls.at(-1), { x: 0, y: 0, width: 360, height: 420 });

  host.setHostedWindow(host.window);
  assert.deepEqual(host.view.boundsCalls.at(-1), { x: 0, y: 0, width: 1280, height: 900 });
});

test("first paint on the view host comes from the real WebContents load", () => {
  const host = createDashboardHost({ platform: "darwin", electron, windowOptions });
  let painted = 0;
  host.onceFirstPaint(() => { painted += 1; });

  // `ready-to-show` never fires on a BaseWindow; only the load event may show it.
  host.window.emit("ready-to-show");
  assert.equal(painted, 0);

  host.webContents.emit("did-finish-load");
  assert.equal(painted, 1);
});

test("loadFile and page teardown go through the view's WebContents", () => {
  const host = createDashboardHost({ platform: "darwin", electron, windowOptions });
  host.loadFile("/tmp/dashboard.html");
  assert.deepEqual(host.webContents.loaded, ["/tmp/dashboard.html"]);

  host.closeWebContents();
  assert.equal(host.webContents.closeCount, 1);

  host.webContents.destroyed = true;
  host.closeWebContents();
  assert.equal(host.webContents.closeCount, 1, "a destroyed WebContents is not closed twice");
});

test("linux keeps the ordinary BrowserWindow and its ready-to-show", () => {
  const host = createDashboardHost({ platform: "linux", electron, windowOptions });

  assert.equal(host.usesView, false);
  assert.equal(host.view, null);
  assert.ok(host.window instanceof FakeBrowserWindow);
  assert.equal(host.window.opts.webPreferences, windowOptions.webPreferences);
  assert.equal(host.webContents, host.window.webContents);

  let painted = 0;
  host.onceFirstPaint(() => { painted += 1; });
  host.window.readyToShow();
  assert.equal(painted, 1);

  host.loadFile("/tmp/dashboard.html");
  assert.deepEqual(host.window.webContents.loaded, ["/tmp/dashboard.html"]);

  // Nothing to re-parent or release on Linux.
  host.syncViewBounds();
  host.closeWebContents();
  assert.equal(host.window.webContents.closeCount, 0);
});
