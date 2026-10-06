"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const { it } = require("node:test");
const createRoam = require("../src/roam");
const { getProportionalPixelSize } = require("../src/size-utils");
const { createSettingsSizePreviewSession } = require("../src/settings-size-preview-session");

const menuPath = require.resolve("../src/menu");
const originalLoad = Module._load;
let createMenu;
try {
  Module._load = function loadWithFakeElectron(request, parent, isMain) {
    if (request === "electron") return {
      app: { quit() {}, setActivationPolicy() {}, dock: { show() {}, hide() {} } },
      BrowserWindow: function BrowserWindow() {},
      Menu: { buildFromTemplate: (template) => ({ template }) },
      Tray: function Tray() {},
      nativeImage: { createFromPath: () => ({ resize() { return this; }, setTemplateImage() {} }) },
      screen: { getAllDisplays: () => [], getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[menuPath];
  createMenu = require(menuPath);
} finally {
  Module._load = originalLoad;
}

function createClock() {
  let now = 0;
  let id = 0;
  const timers = new Map();
  return {
    get now() { return now; },
    setTimeout(callback, delay) {
      const next = ++id;
      timers.set(next, { callback, at: now + delay });
      return next;
    },
    clearTimeout(timerId) { timers.delete(timerId); },
    advance(ms) {
      const until = now + ms;
      while (true) {
        let due = null;
        for (const [timerId, timer] of timers) {
          if (timer.at <= until && (!due || timer.at < due.timer.at)) due = { timerId, timer };
        }
        if (!due) break;
        timers.delete(due.timerId);
        now = due.timer.at;
        due.timer.callback();
      }
      now = until;
    },
  };
}

async function withHarness(initial, run) {
  const clock = createClock();
  const saved = {
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    now: Date.now,
    random: Math.random,
  };
  global.setTimeout = clock.setTimeout.bind(clock);
  global.clearTimeout = clock.clearTimeout.bind(clock);
  Date.now = () => clock.now;
  Math.random = () => 0.9;
  try {
    const workArea = { x: 0, y: 0, width: 1710, height: 991 };
    const bounds = { x: 260, y: 380, width: initial.width || 359, height: initial.width || 359 };
    const writes = [];
    const persisted = [];
    let state = "idle";
    let previewActive = false;
    let currentSize = initial.size || "P:21";
    let frozen = initial.frozen || { width: bounds.width, height: bounds.height };
    const pixelFor = (key) => getProportionalPixelSize(Number(key.slice(2)), workArea);
    const ctx = {
      win: { isDestroyed: () => false, getBounds: () => ({ ...bounds }) },
      sessions: new Map(),
      get currentSize() { return currentSize; },
      set currentSize(key) {
        if (key === currentSize) return; // settings controller's same-value noop
        currentSize = key;
        frozen = null; // main's size mirror setter
      },
      resetKeepSizeFrozen: () => { frozen = null; },
      doNotDisturb: false, lang: "en", showTray: true, showDock: true,
      openAtLogin: false, bubbleFollowPet: false, hideBubbles: false,
      soundMuted: false, menuOpen: false, tray: null, contextMenuOwner: null,
      contextMenu: null, isQuitting: false, pendingPermissions: [],
      dragLocked: false, miniTransitioning: false,
      getMiniMode: () => false, getMiniTransitioning: () => false,
      getActiveThemeCapabilities: () => ({ miniMode: true }),
      openSettingsWindow() {}, togglePetVisibility() {}, enableDoNotDisturb() {},
      disableDoNotDisturb() {}, miniHandleResize: () => false,
      getPetWindowBounds: () => ({ ...bounds }),
      applyPetWindowBounds(next) {
        Object.assign(bounds, next);
        writes.push({ at: clock.now, bounds: { ...bounds }, state });
      },
      getCurrentPixelSize: () => pixelFor(currentSize),
      getPixelSizeFor: pixelFor,
      getEffectiveCurrentPixelSize: () => frozen || (frozen = pixelFor(currentSize)),
      isProportionalMode: () => true,
      repositionBubbles() {}, syncHitWin() {}, repositionAnchoredSurfaces() {},
      flushRuntimeStateToPrefs: () => persisted.push({
        size: currentSize,
        frozen: { ...ctx.getEffectiveCurrentPixelSize() },
      }),
      reapplyMacVisibility() {}, clampToScreenVisual: (x, y) => ({ x, y }),
      getNearestWorkArea: () => workArea,
      getCurrentState: () => state,
      applyState: (value) => { state = value; },
      setState: (value) => { state = value; },
      isSizePreviewActive: () => previewActive,
    };
    const roam = createRoam(ctx);
    ctx.cancelRoam = () => roam.cancelRoam();
    const menu = createMenu(ctx);
    const session = createSettingsSizePreviewSession({
      beginProtection: async () => { previewActive = true; },
      endProtection: async () => { previewActive = false; },
      applyPreview: async (key) => menu.resizeWindow(key, { mode: "preview" }),
      commitFinal: async (key) => { menu.resizeWindow(key); return { status: "ok" }; },
    });
    roam.setEnabled(true);
    await run({ clock, ctx, roam, menu, session, bounds, writes, persisted,
      get state() { return state; },
      get frozen() { return frozen; },
    });
  } finally {
    global.setTimeout = saved.setTimeout;
    global.clearTimeout = saved.clearTimeout;
    Date.now = saved.now;
    Math.random = saved.random;
  }
}

it("holds a preview size when an active walk reaches its next frame", async () => {
  await withHarness({}, async (h) => {
    h.roam.tick();
    h.clock.advance(8000);
    assert.equal(h.state, "roam");
    await h.session.begin();
    h.clock.advance(16); // preview gate cancels the active walk before its next write
    await h.session.preview("P:30");
    const width = h.bounds.width;
    const writes = h.writes.length;
    h.clock.advance(100);
    assert.equal(h.state, "idle");
    assert.equal(width, 513);
    assert.equal(h.bounds.width, width);
    assert.equal(h.writes.length, writes);
  });
});

it("keeps a pending walk from starting while preview protection is active", async () => {
  await withHarness({}, async (h) => {
    h.roam.tick();
    await h.session.begin();
    h.clock.advance(8000); // pending timer sees the preview gate
    assert.equal(h.state, "idle");
    assert.equal(h.writes.length, 0);
    await h.session.preview("P:30");
    h.clock.advance(4000);
    assert.equal(h.bounds.width, 513);
    assert.equal(h.writes.length, 1);
  });
});

it("resumes the first roam delay when an abandoned preview is cleaned up", async () => {
  await withHarness({}, async (h) => {
    h.roam.tick();
    await h.session.begin(); // the renderer never sends its matching end
    h.clock.advance(8000);
    assert.equal(h.state, "idle");
    assert.equal(h.writes.length, 0);
    h.roam.tick(); // normal background tick resets the first-walk delay while held

    await h.session.cleanup();
    h.roam.tick();
    h.clock.advance(7999);
    assert.equal(h.state, "idle");
    h.clock.advance(1);
    assert.equal(h.state, "roam");
    assert.ok(h.writes.length > 0);
  });
});

it("resumes roaming with the committed size after preview ends", async () => {
  await withHarness({}, async (h) => {
    h.roam.tick();
    await h.session.preview("P:30");
    await h.session.end("P:30");
    assert.equal(h.bounds.width, 513);
    h.roam.tick();
    h.clock.advance(8000);
    assert.equal(h.state, "roam");
    assert.equal(h.writes.at(-1).bounds.width, 513);
  });
});

it("preserves a direct commit made during an active walk without preview", async () => {
  await withHarness({}, async (h) => {
    h.roam.tick();
    h.clock.advance(8000);
    assert.equal(h.state, "roam");
    h.menu.resizeWindow("P:30");
    const writes = h.writes.length;
    h.clock.advance(100);
    assert.equal(h.state, "idle");
    assert.equal(h.bounds.width, 513);
    assert.equal(h.writes.length, writes);
  });
});

it("re-seeds another display's frozen size on a same-value commit", async () => {
  await withHarness({ size: "P:10.5", width: 361,
    frozen: { width: 361, height: 361 } }, async (h) => {
    await h.session.preview("P:11");
    await h.session.preview("P:10.5");
    await h.session.end("P:10.5");
    assert.equal(h.bounds.width, 180);
    assert.deepEqual(h.frozen, { width: 180, height: 180 });
    assert.deepEqual(h.persisted.at(-1).frozen, { width: 180, height: 180 });
    h.roam.tick();
    h.clock.advance(8000);
    assert.equal(h.writes.at(-1).bounds.width, 180);
  });
});
