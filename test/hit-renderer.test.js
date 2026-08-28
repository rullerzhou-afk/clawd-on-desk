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
        petelecoAimStart: () => apiCalls.push(["petelecoAimStart"]),
        petelecoAimMove: () => apiCalls.push(["petelecoAimMove"]),
        petelecoAimEnd: () => apiCalls.push(["petelecoAimEnd"]),
        petelecoAimCancel: () => apiCalls.push(["petelecoAimCancel"]),
        startDragReaction: (direction) => apiCalls.push(["startDragReaction", direction]),
        endDragReaction: () => apiCalls.push(["endDragReaction"]),
        playClickReaction: (svg, d) => apiCalls.push(["playClickReaction", svg, d]),
        onStateSync: (cb) => { apiHandlers.stateSync = cb; },
        onCancelReaction: (cb) => { apiHandlers.cancelReaction = cb; },
        // Drop bridge (#459): fake files carry .path; "" mimics webUtils
        // returning nothing for non-filesystem Files.
        getPathForFile: (file) => (file && file.path) || "",
        dropPaths: (paths) => apiCalls.push(["dropPaths", paths]),
        onDropAccepted: (cb) => { apiHandlers.dropAccepted = cb; },
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

  function pointerdown({
    button = 0, pointerId = 1, clientX = 100, clientY = 100,
    ctrlKey = false, altKey = false, metaKey = false,
  } = {}) {
    const cb = area.listeners.get("pointerdown");
    if (cb) cb({ button, pointerId, clientX, clientY, ctrlKey, altKey, metaKey });
  }

  function areaEvent(name, payload) {
    const cb = area.listeners.get(name);
    if (cb) cb(payload);
  }

  function pointermove({ clientX = 100, clientY = 100 } = {}) {
    fakeDocument._dispatch("pointermove", { clientX, clientY });
  }

  function fireTimer(predicate) {
    const t = timers.find((x) => !x.cleared && predicate(x));
    if (!t) return false;
    t.cleared = true;
    t.cb();
    return true;
  }

  return {
    apiCalls, apiHandlers, pointerdown, pointermove, pointerup, areaEvent,
    fireTimer, timers, area, context,
  };
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

  it("updates the drag reaction when horizontal direction changes", () => {
    const h = createHarness();
    h.pointerdown({ clientX: 100, clientY: 100 });
    h.pointermove({ clientX: 90, clientY: 100 });
    h.pointermove({ clientX: 80, clientY: 100 });
    h.pointermove({ clientX: 95, clientY: 100 });

    assert.deepStrictEqual(
      h.apiCalls.filter((call) => call[0] === "startDragReaction"),
      [
        ["startDragReaction", "left"],
        ["startDragReaction", "right"],
      ]
    );
  });

  for (const [terminalEvent, finishDrag] of [
    ["pointerup", (h) => h.pointerup({ clientX: 90 })],
    ["pointercancel", (h) => h.area.listeners.get("pointercancel")()],
    ["lostpointercapture", (h) => h.area.listeners.get("lostpointercapture")()],
  ]) {
    it(`ends an actual drag on ${terminalEvent} after a late cancel cleared the local reaction flag`, () => {
      const h = createHarness();
      h.pointerdown({ clientX: 100, clientY: 100 });
      h.pointermove({ clientX: 90, clientY: 100 });

      h.apiHandlers.cancelReaction();
      finishDrag(h);

      assert.deepStrictEqual(
        h.apiCalls.filter((call) => call[0] === "endDragReaction"),
        [["endDragReaction"]]
      );
    });
  }

  it("does not send a drag-reaction end for a click below the drag threshold", () => {
    const h = createHarness();
    h.pointerdown({ clientX: 100, clientY: 100 });
    h.pointerup({ clientX: 100 });

    assert.deepStrictEqual(
      h.apiCalls.filter((call) => call[0] === "endDragReaction"),
      []
    );
  });
});

describe("hit-renderer OS file drop (#459)", () => {
  function makeDragEvent({ types = ["Files"], files = [] } = {}) {
    return {
      prevented: false,
      preventDefault() { this.prevented = true; },
      dataTransfer: { types, files, dropEffect: "" },
    };
  }

  it("macOS registers no drop machinery at all: no listeners, no affordance, no accept handler", () => {
    const h = createHarness({ isMac: true });
    assert.strictEqual(h.area.listeners.get("dragover"), undefined);
    assert.strictEqual(h.area.listeners.get("drop"), undefined);
    assert.strictEqual(h.apiHandlers.dropAccepted, undefined);
  });

  it("dragover with files shows the copy affordance outside mini mode", () => {
    const h = createHarness();
    const evt = makeDragEvent();
    h.area.listeners.get("dragover")(evt);
    assert.strictEqual(evt.prevented, true);
    assert.strictEqual(evt.dataTransfer.dropEffect, "copy");
  });

  it("dragover gives no affordance in mini mode or for non-file drags", () => {
    const mini = createHarness({ sendState: { currentState: "idle", miniMode: true, dndEnabled: false } });
    const miniEvt = makeDragEvent();
    mini.area.listeners.get("dragover")(miniEvt);
    assert.strictEqual(miniEvt.prevented, false);
    assert.strictEqual(miniEvt.dataTransfer.dropEffect, "");

    const h = createHarness();
    const textEvt = makeDragEvent({ types: ["text/plain"] });
    h.area.listeners.get("dragover")(textEvt);
    assert.strictEqual(textEvt.prevented, false);
  });

  it("drop resolves paths through the preload bridge, filtering non-filesystem Files", () => {
    const h = createHarness();
    const evt = makeDragEvent({ files: [{ path: "" }, { path: "/proj/dir" }, { path: "/other" }] });
    h.area.listeners.get("drop")(evt);
    assert.strictEqual(evt.prevented, true);
    // Array.from: the paths array is born in the vm realm — copy it into the
    // host realm so deepStrictEqual's prototype check passes.
    const dropCalls = h.apiCalls
      .filter((c) => c[0] === "dropPaths")
      .map((c) => [c[0], Array.from(c[1])]);
    assert.deepStrictEqual(dropCalls, [["dropPaths", ["/proj/dir", "/other"]]]);
  });

  it("drop sends nothing when every File lacks a filesystem path", () => {
    const h = createHarness();
    const evt = makeDragEvent({ files: [{ path: "" }] });
    h.area.listeners.get("drop")(evt);
    assert.deepStrictEqual(h.apiCalls.filter((c) => c[0] === "dropPaths"), []);
  });

  it("drop is inert in mini mode even if the event slips through", () => {
    const h = createHarness({ sendState: { currentState: "idle", miniMode: true, dndEnabled: false } });
    const evt = makeDragEvent({ files: [{ path: "/proj" }] });
    h.area.listeners.get("drop")(evt);
    assert.deepStrictEqual(h.apiCalls.filter((c) => c[0] === "dropPaths"), []);
  });

  it("accepted drop plays the double reaction through the local isReacting gate", () => {
    const h = createHarness();
    h.apiHandlers.dropAccepted();
    assert.deepStrictEqual(
      h.apiCalls.filter((c) => c[0] === "playClickReaction"),
      [["playClickReaction", "flail.svg", 3500]]
    );
    // While reacting, a second accept must not stack another animation.
    h.apiHandlers.dropAccepted();
    assert.strictEqual(h.apiCalls.filter((c) => c[0] === "playClickReaction").length, 1);
  });

  it("accepted drop falls back to the click poke for double-less themes (Calico)", () => {
    const h = createHarness();
    h.apiHandlers.themeConfig({ reactions: {
      clickLeft: { file: "left.svg", duration: 2500 },
      clickRight: { file: "right.svg", duration: 2500 },
      drag: { file: "drag.svg" },
    } });
    h.apiHandlers.dropAccepted();
    const plays = h.apiCalls.filter((c) => c[0] === "playClickReaction");
    assert.strictEqual(plays.length, 1);
    assert.ok(["left.svg", "right.svg"].includes(plays[0][1]), plays[0][1]);
    assert.strictEqual(plays[0][2], 2500);
  });

  it("accepted drop stays silent for drag-only themes (Cloudling) or a busy pet", () => {
    const noReact = createHarness();
    noReact.apiHandlers.themeConfig({ reactions: { drag: { file: "drag.svg" } } });
    noReact.apiHandlers.dropAccepted();
    assert.deepStrictEqual(noReact.apiCalls.filter((c) => c[0] === "playClickReaction"), []);

    const busy = createHarness({ sendState: { currentState: "working", miniMode: false, dndEnabled: false } });
    busy.apiHandlers.dropAccepted();
    assert.deepStrictEqual(busy.apiCalls.filter((c) => c[0] === "playClickReaction"), []);
  });
});

describe("hit-renderer peteleco gesture", () => {
  function armPeteleco(harness) {
    harness.apiHandlers.stateSync({ petelecoEnabled: true });
  }

  function names(harness) {
    return harness.apiCalls.map((c) => c[0]);
  }

  it("stays out of the way while the feature is off: Ctrl+drag is a plain drag", () => {
    const h = createHarness({ isMac: false });
    h.pointerdown({ ctrlKey: true });
    h.pointermove({ clientX: 160 });
    h.fireTimer((t) => t.ms === 16);

    assert.ok(names(h).includes("dragMove"), "the pet must still follow the cursor");
    assert.ok(!names(h).includes("petelecoAimStart"));
  });

  it("Ctrl+drag aims instead of dragging: the pet must not move", () => {
    const h = createHarness({ isMac: false });
    armPeteleco(h);
    h.pointerdown({ ctrlKey: true });

    assert.deepStrictEqual(h.apiCalls, [["dragLock", true], ["petelecoAimStart"]]);
    assert.ok(h.area.classList._set.has("aiming"));
    assert.ok(!h.area.classList._set.has("dragging"));

    h.pointermove({ clientX: 160 });
    h.fireTimer((t) => t.ms === 16);

    assert.ok(names(h).includes("petelecoAimMove"));
    assert.ok(!names(h).includes("dragMove"), "aiming must never move the pet");
    // The drag reaction depicts being dragged; nothing is being dragged here.
    assert.ok(!names(h).includes("startDragReaction"));
  });

  it("release fires the shot before the drag lock is handed back, and never runs drag-end", () => {
    const h = createHarness({ isMac: false });
    armPeteleco(h);
    h.pointerdown({ ctrlKey: true });
    h.pointermove({ clientX: 200 });
    h.fireTimer((t) => t.ms === 16);
    h.pointerup({ ctrlKey: true, clientX: 200 });

    const order = names(h);
    const end = order.indexOf("petelecoAimEnd");
    const unlock = order.lastIndexOf("dragLock");
    assert.ok(end !== -1, "the shot must be fired");
    // The runtime must see the gesture end while it still owns the pet's
    // position — peteleco.js's launch hands that inherited lock off itself.
    assert.ok(end < unlock, "aim-end must reach main before the drag lock is released");
    assert.strictEqual(h.apiCalls[unlock][1], false);
    assert.ok(!order.includes("dragEnd"), "drag-end would re-clamp and fight the flick");
    assert.ok(!order.includes("showDashboard"));
    assert.ok(!h.area.classList._set.has("aiming"));
  });

  it("a modifier click that never moved is still a Ctrl+click: Dashboard opens", () => {
    const h = createHarness({ isMac: false });
    armPeteleco(h);
    h.pointerdown({ ctrlKey: true });
    h.pointerup({ ctrlKey: true });

    const order = names(h);
    assert.ok(order.includes("petelecoAimCancel"), "no pull means no shot");
    assert.ok(!order.includes("petelecoAimEnd"));
    assert.ok(order.includes("showDashboard"));
  });

  it("a pull under the threshold does not fire a shot", () => {
    const h = createHarness({ isMac: false });
    armPeteleco(h);
    h.pointerdown({ ctrlKey: true, clientX: 100 });
    h.pointermove({ clientX: 102 });
    h.pointerup({ ctrlKey: true, clientX: 102 });

    assert.ok(names(h).includes("petelecoAimCancel"));
    assert.ok(!names(h).includes("petelecoAimEnd"));
  });

  it("on macOS the modifier is Option, because Ctrl+click is the OS right-click", () => {
    const h = createHarness({ isMac: true });
    armPeteleco(h);

    h.pointerdown({ ctrlKey: true });
    assert.ok(!names(h).includes("petelecoAimStart"), "Ctrl must not aim on mac");
    h.areaEvent("pointercancel");

    const alt = createHarness({ isMac: true });
    armPeteleco(alt);
    alt.pointerdown({ altKey: true });
    assert.ok(names(alt).includes("petelecoAimStart"));
  });

  it("Alt+drag does NOT aim off macOS, so the Ctrl gesture stays the only one", () => {
    const h = createHarness({ isMac: false });
    armPeteleco(h);
    h.pointerdown({ altKey: true });
    assert.ok(!names(h).includes("petelecoAimStart"));
  });

  it("losing the pointer or the window mid-aim cancels instead of firing", () => {
    const cancelled = createHarness({ isMac: false });
    armPeteleco(cancelled);
    cancelled.pointerdown({ ctrlKey: true });
    cancelled.pointermove({ clientX: 200 });
    cancelled.areaEvent("pointercancel");

    assert.ok(names(cancelled).includes("petelecoAimCancel"));
    assert.ok(!names(cancelled).includes("petelecoAimEnd"));
    assert.ok(!cancelled.area.classList._set.has("aiming"));

    const lost = createHarness({ isMac: false });
    armPeteleco(lost);
    lost.pointerdown({ ctrlKey: true });
    lost.pointermove({ clientX: 200 });
    lost.areaEvent("lostpointercapture");
    assert.ok(names(lost).includes("petelecoAimCancel"));
  });

  it("switching the feature off mid-aim tears the gesture down", () => {
    const h = createHarness({ isMac: false });
    armPeteleco(h);
    h.pointerdown({ ctrlKey: true });
    h.pointermove({ clientX: 200 });
    h.apiHandlers.stateSync({ petelecoEnabled: false });

    assert.ok(names(h).includes("petelecoAimCancel"));
    assert.ok(!h.area.classList._set.has("aiming"));
  });

  it("mini mode ignores the gesture entirely", () => {
    const h = createHarness({ isMac: false });
    h.apiHandlers.stateSync({ petelecoEnabled: true, miniMode: true });
    h.pointerdown({ ctrlKey: true });
    assert.ok(!names(h).includes("petelecoAimStart"));
    assert.ok(!names(h).includes("dragLock"));
  });

  it("no context menu pops over an open projection", () => {
    const h = createHarness({ isMac: false });
    armPeteleco(h);
    h.pointerdown({ ctrlKey: true });
    h.pointermove({ clientX: 200 });
    h.context.document._dispatch("contextmenu", { preventDefault() {} });
    assert.ok(!names(h).includes("showContextMenu"));

    h.areaEvent("pointercancel");
    h.context.document._dispatch("contextmenu", { preventDefault() {} });
    assert.ok(names(h).includes("showContextMenu"), "the menu still works outside a gesture");
  });
});
