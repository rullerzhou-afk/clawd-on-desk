"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const HIT_RENDERER = path.join(__dirname, "..", "src", "hit-renderer.js");
const SOURCE = fs.readFileSync(HIT_RENDERER, "utf8").replace(/\r\n/g, "\n");

class FakeArea {
  constructor() {
    this.style = {};
    this.classList = {
      _set: new Set(),
      add: (c) => this.classList._set.add(c),
      remove: (c) => this.classList._set.delete(c),
    };
    this.offsetWidth = 200;
    this.listeners = new Map();
  }
  addEventListener(event, cb) { this.listeners.set(event, cb); }
  setPointerCapture() {}
}

function createHarness({ isMac = false, sendState = {} } = {}) {
  const apiCalls = [];
  const apiHandlers = {};
  const area = new FakeArea();

  const fakeDocument = {
    getElementById(id) { return id === "hit-area" ? area : null; },
    addEventListener(event, cb) {
      if (!fakeDocument._listeners) fakeDocument._listeners = new Map();
      fakeDocument._listeners.set(event, cb);
    },
    _dispatch(event, payload) {
      const cb = fakeDocument._listeners && fakeDocument._listeners.get(event);
      if (cb) cb(payload);
    },
  };

  const timers = [];
  let timerId = 0;
  const context = {
    document: fakeDocument,
    window: {
      hitPlatform: { isMac, platform: isMac ? "darwin" : "win32" },
      hitThemeConfig: { reactions: {
        double: { file: "flail.svg", duration: 3500 },
        annoyed: { file: "annoyed.svg", duration: 3500 },
        clickLeft: { file: "left.svg", duration: 2500 },
        clickRight: { file: "right.svg", duration: 2500 },
      } },
      hitAPI: {
        onThemeConfig: (cb) => { apiHandlers.themeConfig = cb; },
        dragLock: (v) => apiCalls.push(["dragLock", v]),
        dragMove: () => apiCalls.push(["dragMove"]),
        dragEnd: () => apiCalls.push(["dragEnd"]),
        showContextMenu: () => apiCalls.push(["showContextMenu"]),
        focusTerminal: () => apiCalls.push(["focusTerminal"]),
        exitMiniMode: () => apiCalls.push(["exitMiniMode"]),
        showDashboard: () => apiCalls.push(["showDashboard"]),
        revealSessionHud: () => apiCalls.push(["revealSessionHud"]),
        startDragReaction: () => apiCalls.push(["startDragReaction"]),
        endDragReaction: () => apiCalls.push(["endDragReaction"]),
        playClickReaction: (svg, d) => apiCalls.push(["playClickReaction", svg, d]),
        onStateSync: (cb) => { apiHandlers.stateSync = cb; },
        onCancelReaction: (cb) => { apiHandlers.cancelReaction = cb; },
      },
      addEventListener: () => {},
    },
    setTimeout: (cb, ms) => {
      const t = { id: ++timerId, cb, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    requestAnimationFrame: (cb) => context.setTimeout(cb, 16),
    cancelAnimationFrame: (t) => context.clearTimeout(t),
    console: { warn() {} },
  };
  context.globalThis = context;

  vm.runInNewContext(SOURCE, context);

  // Apply initial state if provided
  if (apiHandlers.stateSync && Object.keys(sendState).length) {
    apiHandlers.stateSync(sendState);
  } else if (apiHandlers.stateSync) {
    // Default: idle, non-mini, non-DND
    apiHandlers.stateSync({ currentState: "idle", miniMode: false, dndEnabled: false });
  }

  function pointerup({ button = 0, ctrlKey = false, metaKey = false, clientX = 100 } = {}) {
    fakeDocument._dispatch("pointerup", { button, ctrlKey, metaKey, clientX });
  }

  function fireTimer(predicate) {
    const t = timers.find((x) => !x.cleared && predicate(x));
    if (!t) return false;
    t.cleared = true;
    t.cb();
    return true;
  }

  return { apiCalls, apiHandlers, pointerup, fireTimer, timers, area, context };
}

describe("hit-renderer input layer", () => {
  it("plain single click reveals HUD, does NOT call focusTerminal", () => {
    const h = createHarness();
    h.pointerup({});
    const names = h.apiCalls.map((c) => c[0]);
    assert.ok(names.includes("revealSessionHud"), "should call revealSessionHud");
    assert.ok(!names.includes("focusTerminal"), "must not call focusTerminal");
  });

  it("Ctrl+click on non-mac opens Dashboard, does NOT call reveal", () => {
    const h = createHarness({ isMac: false });
    h.pointerup({ ctrlKey: true });
    const names = h.apiCalls.map((c) => c[0]);
    assert.ok(names.includes("showDashboard"), "should open Dashboard");
    assert.ok(!names.includes("revealSessionHud"), "must not reveal HUD on Ctrl+click");
  });

  it("Cmd+click on mac opens Dashboard", () => {
    const h = createHarness({ isMac: true });
    h.pointerup({ metaKey: true });
    const names = h.apiCalls.map((c) => c[0]);
    assert.ok(names.includes("showDashboard"));
    assert.ok(!names.includes("revealSessionHud"));
  });

  it("Ctrl+click on mac does NOT open Dashboard and does NOT reveal (system right-click)", () => {
    const h = createHarness({ isMac: true });
    h.pointerup({ ctrlKey: true });
    const names = h.apiCalls.map((c) => c[0]);
    assert.ok(!names.includes("showDashboard"), "mac Ctrl+click must not trigger Dashboard");
    assert.ok(!names.includes("revealSessionHud"), "mac Ctrl+click must not reveal HUD");
  });

  it("miniMode + plain click calls exitMiniMode (not reveal)", () => {
    const h = createHarness();
    h.apiHandlers.stateSync({ miniMode: true });
    h.pointerup({});
    const names = h.apiCalls.map((c) => c[0]);
    assert.ok(names.includes("exitMiniMode"), "miniMode plain click should exit mini");
    assert.ok(!names.includes("revealSessionHud"), "miniMode plain click should not reveal HUD");
  });

  it("miniMode + Ctrl+click goes to Dashboard, does NOT exit mini (preserves pre-v5 behavior)", () => {
    const h = createHarness({ isMac: false });
    h.apiHandlers.stateSync({ miniMode: true });
    h.pointerup({ ctrlKey: true });
    const names = h.apiCalls.map((c) => c[0]);
    assert.ok(names.includes("showDashboard"), "Ctrl+click in mini should still open Dashboard");
    assert.ok(!names.includes("exitMiniMode"), "Ctrl+click in mini must NOT exit mini");
  });

  it("does not trigger reveal in working state but still reveals HUD on click (gating is for reactions only)", () => {
    const h = createHarness();
    h.apiHandlers.stateSync({ currentState: "working" });
    h.pointerup({});
    const names = h.apiCalls.map((c) => c[0]);
    // v5 change: reveal HUD even in non-idle states (so user can peek progress)
    assert.ok(names.includes("revealSessionHud"));
    assert.ok(!names.includes("focusTerminal"));
  });

  it("DND + double click does NOT play reaction (canPlayReactionNow fresh-read)", () => {
    const h = createHarness();
    h.apiHandlers.stateSync({ dndEnabled: true });
    h.pointerup({});
    h.pointerup({});
    // Fire the reaction timer
    h.fireTimer((t) => t.ms === 400);
    const names = h.apiCalls.map((c) => c[0]);
    assert.ok(!names.includes("playClickReaction"), "DND must gate reaction playback");
  });

  it("Ctrl+click resets click accumulator (no stale double-click)", () => {
    const h = createHarness({ isMac: false });
    h.pointerup({});            // plain click 1 — accumulates
    h.pointerup({ ctrlKey: true }); // Ctrl+click should reset
    h.pointerup({});            // plain click 2 — must be a fresh first click
    // Fire the reset timer (single-click path schedules 400ms reset)
    h.fireTimer((t) => t.ms === 400);
    const names = h.apiCalls.map((c) => c[0]);
    // No double-click reaction should fire from "1 + reset + 1"
    assert.ok(!names.includes("playClickReaction"),
      "Ctrl+click between plain clicks should not produce a double-click reaction");
  });

  it("cancel-reaction clears reactionTimer + accumulator", () => {
    const h = createHarness();
    h.pointerup({});
    h.pointerup({});  // clickCount=2, sets reactionTimer
    h.apiHandlers.cancelReaction();
    // Subsequent timer fire should be no-op (cleared)
    const before = h.apiCalls.length;
    h.fireTimer((t) => t.ms === 400);
    assert.strictEqual(h.apiCalls.length, before,
      "after cancelReaction, no new reaction should fire");
  });
});
