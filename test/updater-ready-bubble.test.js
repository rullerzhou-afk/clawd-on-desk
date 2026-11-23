"use strict";

const { it } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Exercise the real updater and bubble together without opening native windows
// or downloading/installing anything. Only the Electron window surface is fake.
class BubbleWindow {
  static instances = [];
  static fromWebContents(contents) {
    return this.instances.find(win => win.webContents === contents) || null;
  }
  constructor() {
    this.destroyed = false;
    this.visible = false;
    this.events = new Map();
    this.sent = [];
    this.webContents = {
      isLoading: () => false,
      isDestroyed: () => false,
      once() {},
      send: (channel, payload) => this.sent.push({ channel, payload }),
      setZoomFactor() {},
    };
    BubbleWindow.instances.push(this);
  }
  loadFile() {}
  on(event, listener) { this.events.set(event, listener); }
  setAlwaysOnTop() {}
  setSkipTaskbar() {}
  setBounds() {}
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.events.get("closed")?.(); }
}

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  BubbleWindow.instances = [];
  const paths = [require.resolve("../src/update-bubble"), require.resolve("../src/updater")];
  const previousLoad = Module._load;
  let initBubble, initUpdater;
  Module._load = function(request) {
    if (request === "electron") return { BrowserWindow: BubbleWindow };
    return previousLoad.apply(this, arguments);
  };
  try {
    for (const entry of paths) delete require.cache[entry];
    initBubble = require("../src/update-bubble");
    initUpdater = require("../src/updater");
  } finally { Module._load = previousLoad; }
  const bubble = initBubble({
    win: { isDestroyed: () => false }, bubbleFollowPet: false, petHidden: false,
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 9_000 }),
    getPetWindowBounds: () => ({ x: 20, y: 20, width: 120, height: 120 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getPendingPermissions: () => [], guardAlwaysOnTop() {},
  });
  const calls = { network: 0, checks: 0, downloads: 0, installs: 0 };
  const handlers = new Map();
  const updater = initUpdater({
    showUpdateBubble: payload => bubble.showUpdateBubble(payload),
    hideUpdateBubble: () => bubble.hideUpdateBubble(),
    rebuildAllMenus() {}, updateLog() {}, setUpdateVisualState() {}, applyState() {},
    resolveDisplayState: () => "idle", t: key => key,
  }, {
    app: { isPackaged: true, getVersion: () => "1.4.0" }, platform: "win32", arch: "x64",
    httpsGetImpl() { calls.network++; throw Error("unexpected release lookup"); },
    autoUpdaterFactory: () => ({
      on(event, callback) { handlers.set(event, callback); },
      async checkForUpdates() { calls.checks++; throw Error("unexpected update check"); },
      downloadUpdate() { calls.downloads++; throw Error("unexpected repeat download"); },
      quitAndInstall() { calls.installs++; },
    }),
  });
  updater.setupAutoUpdater();
  t.after(() => { bubble.cleanup(); for (const entry of paths) delete require.cache[entry]; });
  return { updater, bubble, calls, downloaded: () => handlers.get("update-downloaded")({ version: "1.5.0" }) };
}

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const shownPayload = window => window.sent.filter(x => x.channel === "update-bubble-show").at(-1)?.payload;

it("a real timed-out ready bubble reopens its install choice without downloading again", async t => {
  const h = fixture(t);
  const completion = h.downloaded();
  await flush();
  assert.equal(h.updater.getUpdateCheckSnapshot().state, "ready");
  assert.equal(shownPayload(h.bubble.getBubbleWindow()).mode, "ready");
  t.mock.timers.tick(9_000);
  await completion;
  t.mock.timers.tick(250);
  assert.equal(h.bubble.getBubbleWindow().isVisible(), false, "honor the configured bubble timeout");
  assert.deepEqual(h.updater.getUpdateCheckSnapshot(), { state: "ready", version: "1.5.0" });
  assert.equal(h.updater.getUpdateMenuLabel(), "Update Ready");

  const reopen = h.updater.checkForUpdates(true);
  await flush();
  const window = h.bubble.getBubbleWindow();
  assert.equal(window.isVisible(), true);
  assert.equal(shownPayload(window).mode, "ready");
  h.bubble.handleUpdateBubbleAction({ sender: window.webContents }, "primary");
  await reopen;
  await flush();
  assert.deepEqual(h.calls, { network: 0, checks: 0, downloads: 0, installs: 1 });
});

it("replacing a pending ready bubble for menu installation cannot let its old callback hide the new bubble", async t => {
  const h = fixture(t);
  const completion = h.downloaded();
  await flush();
  await h.updater.getUpdateMenuItem().click();
  await completion;
  await flush();
  t.mock.timers.tick(250);
  const window = h.bubble.getBubbleWindow();
  assert.equal(shownPayload(window).mode, "downloading");
  assert.equal(window.isVisible(), true, "the superseded ready promise must not hide installation progress");
  assert.notEqual(h.updater.getUpdateCheckSnapshot().state, "idle");
  await h.updater.getUpdateMenuItem().click();
  assert.deepEqual(h.calls, { network: 0, checks: 0, downloads: 0, installs: 1 });
});
