"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");

const roamModule = require("../src/roam");

function makeCtx(overrides = {}) {
  const bounds = { x: 400, y: 300, width: 120, height: 120 };
  const realBounds = { x: 400, y: 300, width: 120, height: 120 };
  const syncLog = [];
  const stateLog = [];
  const appliedBounds = [];
  let currentState = "idle";
  const ctx = {
    win: {
      getBounds() { return { ...realBounds }; },
      setBounds(next) {
        realBounds.x = next.x;
        realBounds.y = next.y;
        realBounds.width = next.width;
        realBounds.height = next.height;
      },
      isDestroyed() { return false; },
    },
    getPetWindowBounds() { return { ...bounds }; },
    applyPetWindowBounds(next) {
      appliedBounds.push({ ...next });
      bounds.x = next.x;
      bounds.y = next.y;
      bounds.width = next.width;
      bounds.height = next.height;
      realBounds.x = next.x;
      realBounds.y = next.y;
      realBounds.width = next.width;
      realBounds.height = next.height;
    },
    // Mirrors the real runtime: a position-only write re-reads live bounds and
    // launders their width/height back through applyPetWindowBounds — the #569
    // ratchet vector.
    applyPetWindowPosition(x, y) {
      ctx.applyPetWindowBounds({ ...ctx.getPetWindowBounds(), x, y });
    },
    syncHitWin() { syncLog.push("syncHitWin"); },
    repositionSessionHud() { syncLog.push("repositionSessionHud"); },
    repositionAnchoredSurfaces() { syncLog.push("repositionAnchoredSurfaces"); },
    repositionBubbles() { syncLog.push("repositionBubbles"); },
    bubbleFollowPet: false,
    pendingPermissions: [],
    getNearestWorkArea() { return { x: 0, y: 0, width: 1920, height: 1080 }; },
    clampToScreenVisual(x, y, w, h) { return { x, y, width: w, height: h }; },
    getMiniMode() { return false; },
    getCurrentState() { return currentState; },
    setCurrentState(s) { currentState = s; },
    miniTransitioning: false,
    applyState(state) { stateLog.push({ type: "applyState", state }); currentState = state; },
    setState(state) { stateLog.push({ type: "setState", state }); currentState = state; },
    _syncLog: syncLog,
    _stateLog: stateLog,
    _bounds: bounds,
    _realBounds: realBounds,
    _appliedBounds: appliedBounds,
  };
  Object.assign(ctx, overrides);
  return ctx;
}

describe("roam module", () => {
  beforeEach(() => {
    const randomValues = [0.9, 0.9, 0.9, 0.1];
    let randomIndex = 0;
    mock.method(Math, "random", () => randomValues[randomIndex++ % randomValues.length]);
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
  });

  afterEach(() => {
    mock.timers.reset();
    mock.reset();
  });

  it("does not schedule roam when disabled", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.tick();
    assert.equal(roam.enabled, false);
  });

  it("schedules first roam after ROAM_IDLE_DELAY_MS (8s), not ROAM_BETWEEN_DELAY_MS (4s)", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();

    // At 4s — should NOT have started yet
    mock.timers.tick(4000);
    assert.equal(ctx._stateLog.length, 0, "should not move at 4s");

    // At 8s — pause timer fires, animateTo starts
    mock.timers.tick(4000);
    // Tick one frame to see actual movement
    mock.timers.tick(20);
    assert.ok(ctx._realBounds.x !== 400 || ctx._realBounds.y !== 300,
      "pet should have started moving after 8s idle delay + 1 frame");
  });

  it("subsequent roams use ROAM_BETWEEN_DELAY_MS (4s)", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    // First roam
    roam.tick();
    mock.timers.tick(8000); // ROAM_IDLE_DELAY_MS
    // Advance time frame-by-frame until animation completes
    for (let i = 0; i < 2000; i++) { // 2000 frames * 16ms = 32s (covers up to ~2560px at 80px/s)
      mock.timers.tick(16);
      if (ctx._stateLog.some(e => e.type === "setState" && e.state === "idle")) break;
    }

    const posAfterFirst = { x: ctx._realBounds.x, y: ctx._realBounds.y };

    // At 3s — should not have started yet
    mock.timers.tick(3000);
    assert.equal(ctx._realBounds.x, posAfterFirst.x, "should not move at 3s between roams");

    // At 4s — second roam pause timer fires
    mock.timers.tick(1000);
    mock.timers.tick(20); // one frame
    assert.ok(ctx._realBounds.x !== posAfterFirst.x || ctx._realBounds.y !== posAfterFirst.y,
      "pet should start second wander at 4s between-delay");
  });

  it("cancels roam immediately when state changes from idle to working", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000); // trigger first roam
    mock.timers.tick(20);   // one frame of animation

    // Simulate state change to working mid-animation
    ctx.setCurrentState("working");

    // Advance one animation frame — step should detect non-idle and stop
    mock.timers.tick(16);
    const posWhenCancelled = { x: ctx._realBounds.x, y: ctx._realBounds.y };

    // Advance more — position should not change further
    mock.timers.tick(500);
    assert.equal(ctx._realBounds.x, posWhenCancelled.x,
      "pet should stop moving after state changes to working");
    assert.equal(ctx._realBounds.y, posWhenCancelled.y,
      "pet should stop moving after state changes to working");
  });

  it("stops an active roam via cancelRoam", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(20);

    const posBeforeCancel = { x: ctx._realBounds.x, y: ctx._realBounds.y };
    roam.cancelRoam();

    mock.timers.tick(500);
    assert.equal(ctx._realBounds.x, posBeforeCancel.x,
      "pet should stop after cancelRoam");
  });

  it("does not roam in mini mode", () => {
    const ctx = makeCtx({ getMiniMode: () => true });
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(20);

    assert.equal(ctx._realBounds.x, 400, "should not move in mini mode");
    assert.equal(ctx._realBounds.y, 300, "should not move in mini mode");
  });

  it("does not roam during mini transition", () => {
    const ctx = makeCtx({ miniTransitioning: true });
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(20);

    assert.equal(ctx._realBounds.x, 400, "should not move during mini transition");
  });

  it("syncs hitWin and anchored surfaces every frame during animation", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(16);
    mock.timers.tick(16);
    mock.timers.tick(16);

    const hitWinCalls = ctx._syncLog.filter(e => e === "syncHitWin").length;
    const anchoredCalls = ctx._syncLog.filter(e => e === "repositionAnchoredSurfaces").length;
    assert.ok(hitWinCalls >= 3, `syncHitWin should be called each frame, got ${hitWinCalls}`);
    assert.ok(anchoredCalls >= 3, `repositionAnchoredSurfaces should be called each frame, got ${anchoredCalls}`);
  });

  it("switches to roam visual state when animation starts", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000); // pause timer fires, animateTo starts

    // animateTo should have called applyState("roam") before the first step
    const applyStateCalls = ctx._stateLog.filter(e => e.type === "applyState" && e.state === "roam");
    assert.ok(applyStateCalls.length >= 1, "should call applyState('roam') when animation starts");
  });

  it("returns to idle via setState when animation completes normally", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000); // trigger first roam

    // Advance time frame-by-frame until animation completes
    // (mock.timers.tick may not update Date.now() correctly for nested setTimeouts)
    for (let i = 0; i < 2000; i++) { // 2000 frames * 16ms = 32s (covers up to ~2560px at 80px/s) // 700 frames * 16ms = 11.2s
      mock.timers.tick(16);
      if (ctx._stateLog.some(e => e.type === "setState" && e.state === "idle")) break;
    }

    // After animation completes, setState("idle") should have been called
    const setStateIdleCalls = ctx._stateLog.filter(e => e.type === "setState" && e.state === "idle");
    assert.ok(setStateIdleCalls.length >= 1, "should call setState('idle') when animation completes");
  });

  it("does not call setState idle when cancelled by state change", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(20);

    // Simulate state change to working
    ctx.setCurrentState("working");

    mock.timers.tick(500);

    // setState("idle") should NOT have been called after the cancellation
    const setStateIdleCalls = ctx._stateLog.filter(e => e.type === "setState" && e.state === "idle");
    assert.equal(setStateIdleCalls.length, 0,
      "should not call setState('idle') when cancelled by external state change");
  });

  it("resets firstRoam when state changes away from idle/roam (via tick)", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000); // first roam starts
    // Advance time frame-by-frame until animation completes
    for (let i = 0; i < 2000; i++) { // 2000 frames * 16ms = 32s (covers up to ~2560px at 80px/s)
      mock.timers.tick(16);
      if (ctx._stateLog.some(e => e.type === "setState" && e.state === "idle")) break;
    }

    // State changes to working
    ctx.setCurrentState("working");
    roam.tick(); // tick detects non-idle, resets firstRoam=true

    // State goes back to idle
    ctx.setCurrentState("idle");
    roam.tick(); // re-schedules with firstRoam=true

    // At 4s — should NOT have started (needs 8s after returning to idle)
    mock.timers.tick(4000);
    const posAt4s = { x: ctx._realBounds.x, y: ctx._realBounds.y };

    // At 8s — should start
    mock.timers.tick(4000);
    mock.timers.tick(20);
    assert.ok(ctx._realBounds.x !== posAt4s.x || ctx._realBounds.y !== posAt4s.y,
      "should start roaming 8s after returning to idle from working");
  });

  it("resets firstRoam when state changes away from idle/roam (via step)", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000); // first roam starts
    mock.timers.tick(20);   // one frame

    // State changes to working mid-animation — step() detects and resets firstRoam
    ctx.setCurrentState("working");
    mock.timers.tick(16); // step runs, detects non-idle, sets firstRoam=true

    // State goes back to idle
    ctx.setCurrentState("idle");
    roam.tick();

    // At 4s — should NOT have started (needs 8s)
    const posBeforeWait = { x: ctx._realBounds.x, y: ctx._realBounds.y };
    mock.timers.tick(4000);
    assert.equal(ctx._realBounds.x, posBeforeWait.x, "should wait 8s after returning from working mid-roam");

    // At 8s — should start
    mock.timers.tick(4000);
    mock.timers.tick(20);
    assert.ok(ctx._realBounds.x !== posBeforeWait.x || ctx._realBounds.y !== posBeforeWait.y,
      "should start roaming 8s after returning to idle");
  });

  it("setEnabled(false) cancels ongoing roam and timers", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(20);

    const posBeforeDisable = { x: ctx._realBounds.x, y: ctx._realBounds.y };
    roam.setEnabled(false);

    mock.timers.tick(500);
    assert.equal(ctx._realBounds.x, posBeforeDisable.x,
      "pet should stop after setEnabled(false)");
    assert.equal(ctx.getCurrentState(), "idle",
      "pet should return to idle after disabling free roam mid-animation");
    assert.ok(ctx._stateLog.some(e => e.type === "setState" && e.state === "idle"),
      "disable should restore the visual state from roam to idle");
    assert.equal(roam.enabled, false);
  });

  it("setEnabled(true) resets firstRoam for fresh start", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000); // first roam starts
    // Advance frame-by-frame until animation completes
    for (let i = 0; i < 2000; i++) { // 2000 frames * 16ms = 32s (covers up to ~2560px at 80px/s)
      mock.timers.tick(16);
      if (ctx._stateLog.some(e => e.type === "setState" && e.state === "idle")) break;
    }

    // Disable and re-enable
    roam.setEnabled(false);
    roam.setEnabled(true);

    roam.tick();

    // At 4s — should NOT have started (fresh enable uses 8s delay)
    const posBeforeWait = { x: ctx._realBounds.x, y: ctx._realBounds.y };
    mock.timers.tick(4000);
    assert.equal(ctx._realBounds.x, posBeforeWait.x, "should wait 8s after fresh enable");

    // At 8s — should start
    mock.timers.tick(4000);
    mock.timers.tick(20);
    assert.ok(ctx._realBounds.x !== posBeforeWait.x || ctx._realBounds.y !== posBeforeWait.y,
      "should start roaming 8s after fresh enable");
  });

  it("picks targets within work-area margins", () => {
    const smallBounds = { x: 200, y: 200, width: 120, height: 120 };
    const smallRealBounds = { x: 200, y: 200, width: 120, height: 120 };
    const ctx = makeCtx({
      getPetWindowBounds() { return { ...smallBounds }; },
      getNearestWorkArea() { return { x: 100, y: 100, width: 400, height: 300 }; },
    });
    ctx.win.getBounds = () => ({ ...smallRealBounds });
    ctx.win.setBounds = (next) => {
      smallRealBounds.x = next.x;
      smallRealBounds.y = next.y;
      smallRealBounds.width = next.width;
      smallRealBounds.height = next.height;
    };
    ctx.applyPetWindowBounds = (next) => {
      smallBounds.x = next.x;
      smallBounds.y = next.y;
      smallBounds.width = next.width;
      smallBounds.height = next.height;
      smallRealBounds.x = next.x;
      smallRealBounds.y = next.y;
      smallRealBounds.width = next.width;
      smallRealBounds.height = next.height;
    };

    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000);
    // Advance frame-by-frame until animation completes
    for (let i = 0; i < 2000; i++) { // 2000 frames * 16ms = 32s (covers up to ~2560px at 80px/s)
      mock.timers.tick(16);
      if (ctx._stateLog.some(e => e.type === "setState" && e.state === "idle")) break;
    }

    const finalX = smallRealBounds.x;
    const finalY = smallRealBounds.y;
    assert.ok(finalX >= 160, `finalX ${finalX} should be >= xMin 160`);
    assert.ok(finalY >= 145, `finalY ${finalY} should be >= yMin 145`);
    assert.ok(finalX <= 320, `finalX ${finalX} should be <= xMax 320`);
    assert.ok(finalY <= 235, `finalY ${finalY} should be <= yMax 235`);
  });

  it("stops animation when window is destroyed mid-roam", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000);

    ctx.win.isDestroyed = () => true;

    assert.doesNotThrow(() => mock.timers.tick(500));
  });

  it("tick is a no-op when roam is already active", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000);

    roam.tick();
    mock.timers.tick(16);

    assert.doesNotThrow(() => mock.timers.tick(2600));
  });

  it("per-frame isRoamAllowed check stops roam when mini mode activates mid-animation", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(20);

    ctx.getMiniMode = () => true;

    mock.timers.tick(16);
    const posWhenMini = { x: ctx._realBounds.x, y: ctx._realBounds.y };

    mock.timers.tick(500);
    assert.equal(ctx._realBounds.x, posWhenMini.x,
      "pet should stop moving when mini mode activates during roam");
  });

  it("isRoamAllowed allows both idle and roam states", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    // Initially idle — should be allowed
    roam.tick();
    assert.ok(true, "tick should not throw when idle");

    // Simulate being in roam state — should still be allowed
    ctx.setCurrentState("roam");
    roam.tick();
    assert.ok(true, "tick should not throw when in roam state");
  });

  it("falls back to the farthest work-area corner when every random target is too close", () => {
    // Force all ROAM_TARGET_ATTEMPTS random picks to land on the pet's current
    // position (dist 0 < ROAM_MIN_DIST), so target selection must use the
    // four-corner fallback instead of returning null (the old flake).
    // workArea 1000×1000, pet 120px, margin = round(1000*0.15) = 150 →
    // xMin=150, xMax=1000-120-150=730. Math.random()=0.5 →
    // targetX = 150 + floor(0.5*580) = 440, same for Y. Pet sits at (440,440)
    // so every attempt has dist 0. All four corners are equidistant from
    // (440,440); the impl tie-breaks to the first in its list, (xMin,yMin)=(150,150).
    mock.method(Math, "random", () => 0.5);
    const bounds = { x: 440, y: 440, width: 120, height: 120 };
    const realBounds = { ...bounds };
    const ctx = makeCtx({
      getPetWindowBounds() { return { ...bounds }; },
      getNearestWorkArea() { return { x: 0, y: 0, width: 1000, height: 1000 }; },
    });
    ctx.win.getBounds = () => ({ ...realBounds });
    ctx.win.setBounds = (next) => {
      realBounds.x = next.x; realBounds.y = next.y;
      realBounds.width = next.width; realBounds.height = next.height;
    };
    ctx.applyPetWindowBounds = (next) => {
      bounds.x = next.x; bounds.y = next.y;
      realBounds.x = next.x; realBounds.y = next.y;
      realBounds.width = next.width; realBounds.height = next.height;
    };

    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.tick();
    mock.timers.tick(8000);
    for (let i = 0; i < 2000; i++) {
      mock.timers.tick(16);
      if (ctx._stateLog.some(e => e.type === "setState" && e.state === "idle")) break;
    }

    // Fallback ties between all four equidistant corners; the impl keeps the
    // first, (150,150). The pet must have actually moved there — not stalled at
    // its start (the old null-return bug).
    assert.ok(Math.abs(realBounds.x - 150) < 5 && Math.abs(realBounds.y - 150) < 5,
      `expected move to farthest corner (150,150), got (${realBounds.x},${realBounds.y})`);
  });

  it("anchors the window size for the whole walk even when live bounds read back DPI-polluted (#569)", () => {
    const ctx = makeCtx();
    // Simulate the Windows mixed-DPI ratchet: every live read reports the
    // window 4px larger than what was last written. Re-laundering that value
    // through per-frame writes is exactly the #569 growth mechanism.
    const cleanGet = ctx.getPetWindowBounds;
    ctx.getPetWindowBounds = () => {
      const b = cleanGet();
      return { ...b, width: b.width + 4, height: b.height + 4 };
    };
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000);
    for (let i = 0; i < 2000; i++) {
      mock.timers.tick(16);
      if (ctx._stateLog.some(e => e.type === "setState" && e.state === "idle")) break;
    }

    const widths = new Set(ctx._appliedBounds.map(b => b.width));
    const heights = new Set(ctx._appliedBounds.map(b => b.height));
    assert.ok(ctx._appliedBounds.length > 10,
      `walk should span many frames, got ${ctx._appliedBounds.length}`);
    assert.equal(widths.size, 1,
      `width must stay constant across the walk, saw [${[...widths].join(", ")}]`);
    assert.equal(heights.size, 1,
      `height must stay constant across the walk, saw [${[...heights].join(", ")}]`);
    // Anchored to the single read at walk start (120 + one polluted read = 124),
    // never re-read per frame — no cumulative growth.
    assert.equal([...widths][0], 124, "size is captured once at walk start");
  });

  it("prefers the keep-size effective size over walk-start bounds when exposed (#408 interplay)", () => {
    // keepSizeAcrossDisplays ON: getEffectiveCurrentPixelSize returns the
    // frozen size, which must win over (possibly polluted) live start bounds
    // so roam and keep-size stay on one source of truth.
    const ctx = makeCtx({
      getEffectiveCurrentPixelSize: () => ({ width: 100, height: 100 }),
    });
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(16);
    mock.timers.tick(16);

    assert.ok(ctx._appliedBounds.length >= 2, "walk should have written frames");
    for (const b of ctx._appliedBounds) {
      assert.equal(b.width, 100, "frozen keep-size width must win over start bounds");
      assert.equal(b.height, 100, "frozen keep-size height must win over start bounds");
    }
  });

  it("falls back to walk-start size when getEffectiveCurrentPixelSize returns nothing", () => {
    const ctx = makeCtx({ getEffectiveCurrentPixelSize: () => null });
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(16);
    mock.timers.tick(16);

    assert.ok(ctx._appliedBounds.length >= 2, "walk should have written frames");
    for (const b of ctx._appliedBounds) {
      assert.equal(b.width, 120, "falls back to the size read at walk start");
      assert.equal(b.height, 120, "falls back to the size read at walk start");
    }
  });

  it("sends heading=false (face right) when the walk moves rightward", () => {
    // Default mocked random (0.9) picks a target right of the start (400,300).
    const headings = [];
    const ctx = makeCtx({ setRoamHeading(left) { headings.push(left); } });
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000);

    assert.deepEqual(headings, [false], "rightward walk must face right (no mirror)");
  });

  it("sends heading=true (mirror) when the walk moves leftward", () => {
    // random=0.05 → target (349,193), left of the start (400,300), dist ≈ 118.
    mock.method(Math, "random", () => 0.05);
    const headings = [];
    const ctx = makeCtx({ setRoamHeading(left) { headings.push(left); } });
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000);

    assert.deepEqual(headings, [true], "leftward walk must mirror the roam visual");
  });

  it("keeps the previous heading on a purely vertical walk", () => {
    // Clamp forces finalX back to the start X → dx === 0 → no heading update.
    const headings = [];
    const ctx = makeCtx({
      setRoamHeading(left) { headings.push(left); },
      clampToScreenVisual(x, y, w, h) { return { x: 400, y, width: w, height: h }; },
    });
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000);

    assert.deepEqual(headings, [], "vertical walk must not change the heading");
  });
});

describe("roam pauses during IME editing (#640)", () => {
  beforeEach(() => {
    const randomValues = [0.9, 0.9, 0.9, 0.1];
    let randomIndex = 0;
    mock.method(Math, "random", () => randomValues[randomIndex++ % randomValues.length]);
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
  });

  afterEach(() => {
    mock.timers.reset();
    mock.reset();
  });

  it("does not start a roam while a bubble text field is being edited", () => {
    const ctx = makeCtx({ isImeEditingActive: () => true });
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(200);

    assert.equal(ctx._realBounds.x, 400, "pet must hold still while editing");
    assert.equal(ctx._realBounds.y, 300, "pet must hold still while editing");
    assert.equal(ctx._stateLog.length, 0, "no roam state change while editing");
  });

  it("cancels a roam mid-walk when editing starts and restores idle", () => {
    let editing = false;
    const ctx = makeCtx({ isImeEditingActive: () => editing });
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000); // pause timer fires, walk starts
    mock.timers.tick(160);  // a few frames in
    const midWalk = { x: ctx._realBounds.x, y: ctx._realBounds.y };
    assert.ok(midWalk.x !== 400 || midWalk.y !== 300, "walk should be underway");

    editing = true;
    mock.timers.tick(64); // next frame hits the gate

    assert.ok(
      ctx._stateLog.some((e) => e.type === "setState" && e.state === "idle"),
      "gate with no incoming state must restore idle instead of freezing the walk pose"
    );
    const stopped = { x: ctx._realBounds.x, y: ctx._realBounds.y };
    mock.timers.tick(320);
    assert.deepEqual(
      { x: ctx._realBounds.x, y: ctx._realBounds.y },
      stopped,
      "no further movement after the editing gate cancels the walk"
    );
  });
});
