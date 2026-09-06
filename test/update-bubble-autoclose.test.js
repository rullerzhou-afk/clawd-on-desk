"use strict";

const assert = require("node:assert");
const Module = require("node:module");
const { describe, it, afterEach, mock } = require("node:test");
const createFloatingWindowRuntime = require("../src/floating-window-runtime");

const UPDATE_BUBBLE_MODULE_PATH = require.resolve("../src/update-bubble");

class FakeBrowserWindow {
  static instances = [];
  static startLoading = false;

  static fromWebContents(contents) {
    return FakeBrowserWindow.instances.find((win) => win.webContents === contents) || null;
  }

  constructor(options) {
    this.options = options;
    this.destroyed = false;
    this.visible = false;
    this.bounds = null;
    this.listeners = new Map();
    this.sent = [];
    this.insertedCss = [];
    const onceListeners = new Map();
    this.webContents = {
      _loading: FakeBrowserWindow.startLoading,
      isDestroyed: () => false,
      isLoading: () => this.webContents._loading,
      once: (event, handler) => {
        const listeners = onceListeners.get(event) || [];
        listeners.push(handler);
        onceListeners.set(event, listeners);
      },
      emit: (event, ...args) => {
        const listeners = onceListeners.get(event) || [];
        onceListeners.delete(event);
        for (const listener of listeners) listener(...args);
      },
      send: (channel, payload) => this.sent.push({ channel, payload }),
      setZoomFactor: (value) => { this.zoomFactor = value; },
      insertCSS: (value) => {
        this.insertedCss.push(value);
        return Promise.resolve(`css-${this.insertedCss.length}`);
      },
    };
    FakeBrowserWindow.instances.push(this);
  }

  loadFile() {}
  finishLoad() {
    this.webContents._loading = false;
    this.webContents.emit("did-finish-load");
  }
  on(event, handler) { this.listeners.set(event, handler); }
  setAlwaysOnTop() {}
  setBounds(bounds) { this.bounds = bounds; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  destroy() {
    this.destroyed = true;
    const handler = this.listeners.get("closed");
    if (typeof handler === "function") handler();
  }
}

function loadUpdateBubbleWithElectron(fakeElectron) {
  delete require.cache[UPDATE_BUBBLE_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/update-bubble");
  } finally {
    Module._load = originalLoad;
  }
}

function createHarness() {
  FakeBrowserWindow.instances = [];
  let updateAutoCloseMs = 9_000;
  let petHidden = false;
  const orbitRepositions = [];
  const clipboardWrites = [];
  const initUpdateBubble = loadUpdateBubbleWithElectron({ BrowserWindow: FakeBrowserWindow });
  const ctx = {
    win: { isDestroyed: () => false },
    bubbleFollowPet: false,
    get petHidden() { return petHidden; },
    getBubblePolicy(kind) {
      if (kind === "update") return { enabled: updateAutoCloseMs > 0, autoCloseMs: updateAutoCloseMs };
      return { enabled: true, autoCloseMs: 0 };
    },
    getPendingPermissions: () => [],
    getPetWindowBounds: () => ({ x: 20, y: 20, width: 120, height: 120 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getUpdateBubbleAnchorRect: () => null,
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
    repositionSessionHud: () => orbitRepositions.push("reposition"),
    clipboard: {
      writeText(value) { clipboardWrites.push(value); },
    },
  };
  const api = initUpdateBubble(ctx);
  return {
    api,
    orbitRepositions,
    clipboardWrites,
    setUpdateAutoCloseMs(value) {
      updateAutoCloseMs = value;
    },
    setPetHidden(value) {
      petHidden = !!value;
    },
  };
}

describe("update bubble auto-close refresh", () => {
  afterEach(() => {
    mock.timers.reset();
    FakeBrowserWindow.instances = [];
    FakeBrowserWindow.startLoading = false;
    delete require.cache[UPDATE_BUBBLE_MODULE_PATH];
  });

  it("recomputes the remaining lifetime for a visible update bubble", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const harness = createHarness();

    await harness.api.showUpdateBubble({
      mode: "up-to-date",
      title: "Up to date",
      message: "Already on the latest version.",
      requireAction: false,
      defaultAction: "dismiss",
    });

    mock.timers.tick(4_000);
    harness.setUpdateAutoCloseMs(3_000);
    harness.api.refreshAutoCloseForPolicy();
    mock.timers.tick(250);

    assert.strictEqual(harness.api.getBubbleWindow().isVisible(), false);
  });

  it("does not let a positive policy refresh start timing before renderer readiness", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    FakeBrowserWindow.startLoading = true;
    const harness = createHarness();
    const pending = harness.api.showUpdateBubble({
      mode: "update-available",
      title: "Update available",
      requireAction: true,
      defaultAction: "dismiss",
    });
    const bubble = harness.api.getBubbleWindow();
    let settled = false;
    pending.then(() => { settled = true; });

    harness.setUpdateAutoCloseMs(7_000);
    assert.strictEqual(harness.api.refreshAutoCloseForPolicy(), true);
    mock.timers.tick(30_000);
    await Promise.resolve();
    assert.equal(settled, false, "loading time must not count as visible time after a policy refresh");
    assert.strictEqual(bubble.isVisible(), false);

    bubble.finishLoad();
    assert.strictEqual(bubble.isVisible(), true);
    mock.timers.tick(6_999);
    assert.equal(settled, false);
    mock.timers.tick(1);
    assert.deepStrictEqual(await pending, { action: "dismiss", source: "autoClose" });
  });

  it("uses the fixed target work area for initial size, zoom, and final bounds", async () => {
    const targetWorkArea = { x: -1600, y: 200, width: 1600, height: 900 };
    const targetCalls = [];
    const scaleCalls = [];
    const initUpdateBubble = loadUpdateBubbleWithElectron({ BrowserWindow: FakeBrowserWindow });
    const api = initUpdateBubble({
      win: { isDestroyed: () => false },
      bubbleFollowPet: false,
      bubbleFixedCorner: "bottom-right",
      petHidden: false,
      getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
      getPetWindowBounds: () => ({ x: 20, y: 20, width: 120, height: 120 }),
      getBubbleWorkArea: (followPet) => {
        targetCalls.push(followPet);
        return targetWorkArea;
      },
      getTextScale: (workArea) => {
        scaleCalls.push(workArea);
        return 1.5;
      },
      getUpdateBubbleAnchorRect: () => null,
      getHitRectScreen: () => null,
      getPermissionBubbleBounds: () => [],
      getSessionHudBounds: () => [],
      guardAlwaysOnTop: () => {},
      reapplyMacVisibility: () => {},
      repositionQuotaRing: () => {},
      clipboard: { writeText: () => {} },
    });

    await api.showUpdateBubble({
      mode: "up-to-date",
      title: "Up to date",
      message: "Already current.",
      requireAction: false,
      defaultAction: "dismiss",
    });

    const bubble = api.getBubbleWindow();
    assert.strictEqual(bubble.options.width, 510);
    assert.strictEqual(bubble.zoomFactor, 1);
    assert.match(bubble.insertedCss.at(-1), /zoom: 1\.5/);
    assert.deepStrictEqual(bubble.bounds, { x: -522, y: 863, width: 510, height: 225 });
    assert.ok(targetCalls.every((followPet) => followPet === false));
    assert.ok(scaleCalls.every((workArea) => workArea === targetWorkArea));
    api.cleanup();
  });

  it("can show against an explicitly visible target before the petHidden getter commits", async () => {
    const initUpdateBubble = loadUpdateBubbleWithElectron({ BrowserWindow: FakeBrowserWindow });
    const api = initUpdateBubble({
      win: { isDestroyed: () => false },
      bubbleFollowPet: false,
      petHidden: true,
      getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
      getPetWindowBounds: () => ({ x: 20, y: 20, width: 120, height: 120 }),
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
      getUpdateBubbleAnchorRect: () => null,
      getHitRectScreen: () => null,
      getPermissionBubbleBounds: () => [],
      getSessionHudBounds: () => [],
      guardAlwaysOnTop: () => {},
      reapplyMacVisibility: () => {},
      repositionQuotaRing: () => {},
      clipboard: { writeText: () => {} },
    });

    await api.showUpdateBubble({
      mode: "up-to-date",
      title: "Up to date",
      message: "Already current.",
      requireAction: false,
      defaultAction: "dismiss",
    });
    const bubble = api.getBubbleWindow();
    assert.strictEqual(bubble.isVisible(), false);

    api.syncVisibility(false);
    assert.strictEqual(bubble.isVisible(), true,
      "the explicit target state must win over the still-stale petHidden getter");
    api.cleanup();
  });

  it("wires permission and HUD bounds into fixed update bubble repositioning", async () => {
    const workArea = { x: 0, y: 0, width: 1200, height: 800 };
    const initUpdateBubble = loadUpdateBubbleWithElectron({ BrowserWindow: FakeBrowserWindow });
    const api = initUpdateBubble({
      win: { isDestroyed: () => false },
      bubbleFollowPet: false,
      bubbleFixedCorner: "bottom-right",
      petHidden: false,
      getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
      getPetWindowBounds: () => ({ x: 20, y: 20, width: 120, height: 120 }),
      getBubbleWorkArea: () => workArea,
      getTextScale: () => 1,
      getUpdateBubbleAnchorRect: () => null,
      getHitRectScreen: () => null,
      getPermissionBubbleBounds: () => [{ x: 852, y: 642, width: 340, height: 150 }],
      getSessionHudBounds: () => [{ x: 852, y: 560, width: 340, height: 60 }],
      guardAlwaysOnTop: () => {},
      reapplyMacVisibility: () => {},
      repositionQuotaRing: () => {},
      clipboard: { writeText: () => {} },
    });

    await api.showUpdateBubble({
      mode: "up-to-date",
      title: "Up to date",
      message: "Already current.",
      requireAction: false,
      defaultAction: "dismiss",
    });

    assert.deepStrictEqual(api.getBubbleWindow().bounds, {
      x: 852,
      y: 404,
      width: 340,
      height: 150,
    });
    api.cleanup();
  });

  it("uses remaining lifetime instead of restarting the full update-bubble countdown", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const harness = createHarness();

    await harness.api.showUpdateBubble({
      mode: "up-to-date",
      title: "Up to date",
      message: "Already on the latest version.",
      requireAction: false,
      defaultAction: "dismiss",
    });

    mock.timers.tick(4_000);
    harness.setUpdateAutoCloseMs(7_000);
    harness.api.refreshAutoCloseForPolicy();

    const bubble = harness.api.getBubbleWindow();
    assert.strictEqual(bubble.isVisible(), true);

    mock.timers.tick(2_999);
    assert.strictEqual(bubble.isVisible(), true);

    mock.timers.tick(1);
    assert.strictEqual(bubble.isVisible(), true);

    mock.timers.tick(250);
    assert.strictEqual(bubble.isVisible(), false);
  });

  it("pauses and restores an actionable update bubble across fullscreen auto-hide", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const harness = createHarness();
    const pending = harness.api.showUpdateBubble({
      mode: "update-available",
      title: "Update available",
      message: "Restart to install.",
      requireAction: true,
      defaultAction: "dismiss",
    });
    const bubble = harness.api.getBubbleWindow();
    let settled = false;
    pending.then(() => { settled = true; });

    mock.timers.tick(4_000);
    harness.api.suspendForFullscreen();
    assert.strictEqual(bubble.isVisible(), false);
    assert.ok(!bubble.sent.some((message) => message.channel === "update-bubble-hide"),
      "fullscreen is a suspension, not a dismissal animation");

    mock.timers.tick(30_000);
    await Promise.resolve();
    assert.equal(settled, false, "hidden fullscreen time must not consume the action timeout");

    harness.api.resumeFromFullscreen();
    assert.strictEqual(bubble.isVisible(), true);
    assert.equal(bubble.sent.at(-1).channel, "update-bubble-show");
    mock.timers.tick(4_999);
    assert.equal(settled, false);
    mock.timers.tick(1);
    assert.deepStrictEqual(await pending, { action: "dismiss", source: "autoClose" });
    mock.timers.tick(250);
    assert.strictEqual(bubble.isVisible(), false);
  });

  it("keeps a fullscreen-suspended action pending while manual Hide remains active", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const harness = createHarness();
    harness.setPetHidden(true);
    harness.api.suspendForFullscreen();
    const pending = harness.api.showUpdateBubble({
      mode: "update-available",
      title: "Update available",
      requireAction: true,
      defaultAction: "dismiss",
    });
    const bubble = harness.api.getBubbleWindow();
    let settled = false;
    pending.then(() => { settled = true; });

    harness.api.resumeFromFullscreen();
    assert.strictEqual(bubble.isVisible(), false);
    mock.timers.tick(30_000);
    await Promise.resolve();
    assert.equal(settled, false, "manual-hidden time must not consume or strand the action timeout");

    harness.setPetHidden(false);
    harness.api.syncVisibility(false);
    assert.strictEqual(bubble.isVisible(), true);
    mock.timers.tick(8_999);
    assert.equal(settled, false);
    mock.timers.tick(1);
    assert.deepStrictEqual(await pending, { action: "dismiss", source: "autoClose" });
  });

  it("preserves an actionable update through the production stale-Hide surface chain", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const harness = createHarness();
    const floating = createFloatingWindowRuntime({
      getPendingPermissions: () => [],
      suspendUpdateBubbleForPet: () => harness.api.suspendForPetHidden(),
      syncUpdateBubbleVisibility: (hidden) => harness.api.syncVisibility(hidden),
    });
    const pending = harness.api.showUpdateBubble({
      mode: "update-available",
      title: "Update available",
      requireAction: true,
      defaultAction: "dismiss",
    });
    const bubble = harness.api.getBubbleWindow();
    let settled = false;
    pending.then(() => { settled = true; });

    mock.timers.tick(4_000);
    harness.api.suspendForFullscreen();
    harness.setPetHidden(true);
    floating.hideFloatingSurfacesForPet();
    harness.api.resumeFromFullscreen();
    mock.timers.tick(30_000);
    await Promise.resolve();
    assert.equal(settled, false);
    assert.strictEqual(bubble.isVisible(), false);

    harness.setPetHidden(false);
    floating.showFloatingSurfacesForPet();
    assert.strictEqual(bubble.isVisible(), true);
    mock.timers.tick(4_999);
    assert.equal(settled, false);
    mock.timers.tick(1);
    assert.deepStrictEqual(await pending, { action: "dismiss", source: "autoClose" });
  });

  it("does not start the timer when loading finishes after fullscreen exit under manual Hide", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    FakeBrowserWindow.startLoading = true;
    const harness = createHarness();
    harness.setPetHidden(true);
    harness.api.suspendForFullscreen();
    const pending = harness.api.showUpdateBubble({
      mode: "update-available",
      title: "Update available",
      requireAction: true,
      defaultAction: "dismiss",
    });
    const bubble = harness.api.getBubbleWindow();
    let settled = false;
    pending.then(() => { settled = true; });

    harness.api.resumeFromFullscreen();
    bubble.finishLoad();
    assert.strictEqual(bubble.isVisible(), false);
    mock.timers.tick(30_000);
    await Promise.resolve();
    assert.equal(settled, false, "a late load must not consume timeout while manual Hide still owns visibility");

    harness.setPetHidden(false);
    harness.api.syncVisibility(false);
    assert.strictEqual(bubble.isVisible(), true);
    mock.timers.tick(9_000);
    assert.deepStrictEqual(await pending, { action: "dismiss", source: "autoClose" });
  });

  it("waits for renderer readiness before restoring and timing a fullscreen bubble", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    FakeBrowserWindow.startLoading = true;
    const harness = createHarness();
    harness.api.suspendForFullscreen();
    const pending = harness.api.showUpdateBubble({
      mode: "update-available",
      title: "Update available",
      requireAction: true,
      defaultAction: "dismiss",
    });
    const bubble = harness.api.getBubbleWindow();
    let settled = false;
    pending.then(() => { settled = true; });

    harness.api.resumeFromFullscreen();
    assert.strictEqual(bubble.isVisible(), false, "a loading renderer must not expose an empty window");
    mock.timers.tick(30_000);
    await Promise.resolve();
    assert.equal(settled, false, "loading time must not consume the action budget");

    bubble.finishLoad();
    assert.strictEqual(bubble.isVisible(), true);
    mock.timers.tick(8_999);
    assert.equal(settled, false);
    mock.timers.tick(1);
    assert.deepStrictEqual(await pending, { action: "dismiss", source: "autoClose" });
  });

  it("settles instead of hanging when fullscreen suspension lands at the deadline", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const harness = createHarness();
    const pending = harness.api.showUpdateBubble({
      mode: "update-available",
      title: "Update available",
      requireAction: true,
      defaultAction: "dismiss",
    });
    const bubble = harness.api.getBubbleWindow();

    // Move the clock without dispatching the queued timeout, reproducing the
    // race where the fullscreen edge is processed at the same deadline.
    mock.timers.setTime(109_000);
    harness.api.suspendForFullscreen();
    assert.deepStrictEqual(await pending, { action: "dismiss", source: "autoClose" });
    assert.strictEqual(bubble.isVisible(), false);

    harness.api.resumeFromFullscreen();
    harness.api.syncVisibility(false);
    assert.strictEqual(bubble.isVisible(), false, "an expired presentation must not resurrect");
  });

  it("expires immediately when a suspended policy shrinks below visible elapsed time", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const harness = createHarness();
    await harness.api.showUpdateBubble({
      mode: "up-to-date",
      title: "Up to date",
      requireAction: false,
      defaultAction: "dismiss",
    });
    const bubble = harness.api.getBubbleWindow();

    mock.timers.tick(4_000);
    harness.api.suspendForFullscreen();
    harness.setUpdateAutoCloseMs(3_000);
    assert.strictEqual(harness.api.refreshAutoCloseForPolicy(), false);
    harness.api.resumeFromFullscreen();
    harness.api.syncVisibility(false);
    assert.strictEqual(bubble.isVisible(), false);
  });

  it("uses newTotal minus elapsed visible time when policy changes during fullscreen", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const harness = createHarness();
    await harness.api.showUpdateBubble({
      mode: "up-to-date",
      title: "Up to date",
      requireAction: false,
      defaultAction: "dismiss",
    });
    const bubble = harness.api.getBubbleWindow();

    mock.timers.tick(4_000);
    harness.api.suspendForFullscreen();
    harness.setUpdateAutoCloseMs(7_000);
    assert.strictEqual(harness.api.refreshAutoCloseForPolicy(), true);
    harness.api.resumeFromFullscreen();
    mock.timers.tick(2_999);
    assert.strictEqual(bubble.isVisible(), true);
    mock.timers.tick(1);
    mock.timers.tick(250);
    assert.strictEqual(bubble.isVisible(), false,
      "four visible seconds under a seven-second policy leave three seconds");
  });

  it("extends a suspended countdown from elapsed time when the policy grows", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const harness = createHarness();
    await harness.api.showUpdateBubble({
      mode: "up-to-date",
      title: "Up to date",
      requireAction: false,
      defaultAction: "dismiss",
    });
    const bubble = harness.api.getBubbleWindow();

    mock.timers.tick(4_000);
    harness.api.suspendForFullscreen();
    harness.setUpdateAutoCloseMs(12_000);
    harness.api.refreshAutoCloseForPolicy();
    harness.api.resumeFromFullscreen();
    mock.timers.tick(7_999);
    assert.strictEqual(bubble.isVisible(), true);
    mock.timers.tick(1);
    mock.timers.tick(250);
    assert.strictEqual(bubble.isVisible(), false,
      "four visible seconds under a twelve-second policy leave eight seconds");
  });

  it("keeps an update first shown during fullscreen hidden until resume", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const harness = createHarness();
    harness.api.suspendForFullscreen();
    await harness.api.showUpdateBubble({
      mode: "up-to-date",
      title: "Up to date",
      requireAction: false,
      defaultAction: "dismiss",
    });
    const bubble = harness.api.getBubbleWindow();
    assert.strictEqual(bubble.isVisible(), false);

    mock.timers.tick(30_000);
    harness.api.resumeFromFullscreen();
    assert.strictEqual(bubble.isVisible(), true);
    mock.timers.tick(8_999);
    assert.strictEqual(bubble.isVisible(), true);
    mock.timers.tick(1);
    mock.timers.tick(250);
    assert.strictEqual(bubble.isVisible(), false);
  });

  it("restores a bubble whose renderer finishes loading during fullscreen", async () => {
    FakeBrowserWindow.startLoading = true;
    const harness = createHarness();
    await harness.api.showUpdateBubble({
      mode: "up-to-date",
      title: "Up to date",
      requireAction: false,
      defaultAction: "dismiss",
    });
    const bubble = harness.api.getBubbleWindow();

    harness.api.suspendForFullscreen();
    bubble.finishLoad();
    assert.strictEqual(bubble.isVisible(), false);

    harness.api.resumeFromFullscreen();
    assert.strictEqual(bubble.isVisible(), true);
    assert.equal(bubble.sent.at(-1).channel, "update-bubble-show");
    harness.api.cleanup();
  });

  it("repositions Orbit when the update bubble shows, resizes, and finishes hiding", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const harness = createHarness();

    await harness.api.showUpdateBubble({
      mode: "up-to-date",
      title: "Up to date",
      requireAction: false,
      defaultAction: "dismiss",
    });
    const bubble = harness.api.getBubbleWindow();
    assert.strictEqual(harness.orbitRepositions.length, 1, "show should add update bounds to Orbit avoidance");

    harness.api.handleUpdateBubbleHeight({ sender: bubble.webContents }, 220);
    assert.strictEqual(harness.orbitRepositions.length, 2, "measured height should reflow Orbit");

    harness.api.hideUpdateBubble();
    assert.strictEqual(harness.orbitRepositions.length, 2, "Orbit must keep avoiding the fade-out window");
    mock.timers.tick(250);
    assert.strictEqual(harness.orbitRepositions.length, 3, "hidden window should release Orbit avoidance");
  });

  it("copies error details without closing or resolving the update bubble", async () => {
    const harness = createHarness();
    const pending = harness.api.showUpdateBubble({
      mode: "error",
      title: "Update failed",
      message: "Network unavailable",
      copyText: "NETWORK_OFFLINE\nredacted detail",
      copyFeedback: { copied: "Copied", failed: "Copy failed" },
      requireAction: true,
      defaultAction: "dismiss",
    });
    const bubble = harness.api.getBubbleWindow();
    let settled = false;
    pending.then(() => { settled = true; });

    harness.api.handleUpdateBubbleAction({ sender: bubble.webContents }, "copy-error");
    await Promise.resolve();

    assert.deepStrictEqual(harness.clipboardWrites, ["NETWORK_OFFLINE\nredacted detail"]);
    assert.equal(settled, false);
    assert.equal(bubble.isVisible(), true);
    assert.deepStrictEqual(bubble.sent.at(-1), {
      channel: "update-bubble-copy-result",
      payload: { status: "ok", label: "Copied" },
    });

    harness.api.handleUpdateBubbleAction({ sender: bubble.webContents }, "dismiss");
    assert.deepStrictEqual(await pending, { action: "dismiss", source: "user" });
  });
});
