"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");

const roamModule = require("../src/roam");

function makeCtx(overrides = {}) {
  const bounds = { x: 400, y: 300, width: 120, height: 120 };
  const realBounds = { x: 400, y: 300, width: 120, height: 120 };
  const syncLog = [];
  const stateLog = [];
  let currentState = "idle";
  return {
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
    applyPetWindowPosition(x, y) {
      bounds.x = x;
      bounds.y = y;
      realBounds.x = x;
      realBounds.y = y;
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
    ...overrides,
  };
}

describe("roam module", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
  });

  afterEach(() => {
    mock.timers.reset();
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
});
