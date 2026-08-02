"use strict";

const assert = require("node:assert");
const Module = require("node:module");
const { describe, it, afterEach, mock } = require("node:test");

const UPDATE_BUBBLE_MODULE_PATH = require.resolve("../src/update-bubble");

class FakeBrowserWindow {
  static instances = [];

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
    this.webContents = {
      _loading: false,
      isDestroyed: () => false,
      isLoading: () => false,
      once: () => {},
      send: (channel, payload) => this.sent.push({ channel, payload }),
    };
    FakeBrowserWindow.instances.push(this);
  }

  loadFile() {}
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
  const orbitRepositions = [];
  const clipboardWrites = [];
  const initUpdateBubble = loadUpdateBubbleWithElectron({ BrowserWindow: FakeBrowserWindow });
  const api = initUpdateBubble({
    win: { isDestroyed: () => false },
    bubbleFollowPet: false,
    petHidden: false,
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
  });
  return {
    api,
    orbitRepositions,
    clipboardWrites,
    setUpdateAutoCloseMs(value) {
      updateAutoCloseMs = value;
    },
  };
}

describe("update bubble auto-close refresh", () => {
  afterEach(() => {
    mock.timers.reset();
    FakeBrowserWindow.instances = [];
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
