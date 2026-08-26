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
      getBounds() {
        return { ...realBounds };
      },
      setBounds(next) {
        realBounds.x = next.x;
        realBounds.y = next.y;
        realBounds.width = next.width;
        realBounds.height = next.height;
      },
      isDestroyed() {
        return false;
      },
    },
    getPetWindowBounds() {
      return { ...bounds };
    },
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
    syncHitWin() {
      syncLog.push("syncHitWin");
    },
    repositionSessionHud() {
      syncLog.push("repositionSessionHud");
    },
    repositionAnchoredSurfaces() {
      syncLog.push("repositionAnchoredSurfaces");
    },
    repositionBubbles() {
      syncLog.push("repositionBubbles");
    },
    bubbleFollowPet: false,
    pendingPermissions: [],
    getNearestWorkArea() {
      return { x: 0, y: 0, width: 1920, height: 1080 };
    },
    clampToScreenVisual(x, y, w, h) {
      return { x, y, width: w, height: h };
    },
    getMiniMode() {
      return false;
    },
    getCurrentState() {
      return currentState;
    },
    setCurrentState(s) {
      currentState = s;
    },
    dragLocked: false,
    miniTransitioning: false,
    applyState(state) {
      stateLog.push({ type: "applyState", state });
      currentState = state;
    },
    setState(state, svgOverride, options) {
      stateLog.push({ type: "setState", state, svgOverride, options });
      currentState = state;
    },
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
    mock.method(
      Math,
      "random",
      () => randomValues[randomIndex++ % randomValues.length],
    );
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

  it("holds for visible permission bubbles and restarts with the full 8s delay", () => {
    let bubbleVisible = true;
    const ctx = makeCtx({
      hasVisiblePermissionBubbles: () => bubbleVisible,
    });
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(12000);
    assert.strictEqual(ctx._stateLog.length, 0);

    bubbleVisible = false;
    roam.tick();
    mock.timers.tick(7999);
    assert.strictEqual(ctx._stateLog.length, 0);
    mock.timers.tick(1);
    assert.ok(ctx._stateLog.some((event) => event.type === "applyState" && event.state === "roam"));
  });

  it("cancels an active walk on the next frame when a permission bubble appears", () => {
    let bubbleVisible = false;
    const ctx = makeCtx({
      hasVisiblePermissionBubbles: () => bubbleVisible,
    });
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.tick();
    mock.timers.tick(8000);
    assert.strictEqual(ctx.getCurrentState(), "roam");

    bubbleVisible = true;
    mock.timers.tick(16);
    assert.strictEqual(ctx.getCurrentState(), "idle");
  });

  it("permission hold overrides drag's consumed 4s phase and restores 8s", () => {
    let bubbleVisible = false;
    const ctx = makeCtx({
      hasVisiblePermissionBubbles: () => bubbleVisible,
    });
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.tick(); // consume the first phase by arming it

    ctx.dragLocked = true;
    bubbleVisible = true;
    roam.tick();
    bubbleVisible = false;
    roam.tick();
    ctx.dragLocked = false;
    roam.tick();

    mock.timers.tick(4000);
    assert.strictEqual(ctx._stateLog.length, 0, "must not preserve the 4s phase");
    mock.timers.tick(3999);
    assert.strictEqual(ctx._stateLog.length, 0);
    mock.timers.tick(1);
    assert.ok(ctx._stateLog.some((event) => event.type === "applyState" && event.state === "roam"));
  });

  it("does not schedule the first roam while drag is already locked and preserves the 8s phase", () => {
    const ctx = makeCtx({ dragLocked: true });
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(9000);

    assert.equal(
      ctx._stateLog.length,
      0,
      "drag lock must block the roam state",
    );
    assert.equal(
      ctx._appliedBounds.length,
      0,
      "drag lock must block all roam position writes",
    );

    ctx.dragLocked = false;
    roam.tick();
    mock.timers.tick(7999);
    assert.equal(
      ctx._stateLog.length,
      0,
      "an unconsumed first roam must still wait 8s",
    );

    mock.timers.tick(1);
    assert.ok(
      ctx._stateLog.some(
        (event) => event.type === "applyState" && event.state === "roam",
      ),
      "first roam should start after the full 8s delay once drag unlocks",
    );
  });

  it("does not re-arm a consumed roam timer during a static drag and resumes on the 4s phase", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick(); // schedules the first 8s timer and consumes firstRoam
    ctx.dragLocked = true;
    roam.cancelRoam(); // mirrors the synchronous drag-lock handler

    // The real main loop keeps ticking during a static hold because no drag
    // reaction has paused cursor polling. Old code re-armed a 4s timer here.
    for (let elapsed = 0; elapsed < 6000; elapsed += 1000) {
      roam.tick();
      mock.timers.tick(1000);
    }

    assert.equal(ctx._stateLog.length, 0, "static drag must not re-enter roam");
    assert.equal(
      ctx._appliedBounds.length,
      0,
      "static drag must not write pet bounds",
    );

    ctx.dragLocked = false;
    roam.tick();
    mock.timers.tick(3999);
    assert.equal(
      ctx._stateLog.length,
      0,
      "consumed roam phase should wait 4s after unlock",
    );

    mock.timers.tick(1);
    assert.ok(
      ctx._stateLog.some(
        (event) => event.type === "applyState" && event.state === "roam",
      ),
      "consumed roam phase should resume after 4s, not reset to 8s",
    );
  });

  it("preserves the existing 4s cadence when plain mouse movement cancels a pending roam", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick(); // schedules the first 8s timer and consumes firstRoam
    mock.timers.tick(3000);
    roam.cancelRoam(); // mirrors tick.js when normal cursor movement is observed
    roam.tick(); // tick.js re-enters roam.tick() in the same main-loop pass

    assert.equal(
      ctx._stateLog.length,
      0,
      "plain mouse movement must not broadcast an idle state",
    );
    assert.equal(
      ctx._appliedBounds.length,
      0,
      "plain mouse movement must clear the pending roam timer",
    );

    mock.timers.tick(3999);
    assert.equal(
      ctx._stateLog.length,
      0,
      "the existing between-roam cadence must still wait 4s after movement",
    );

    mock.timers.tick(1);
    assert.ok(
      ctx._stateLog.some(
        (event) => event.type === "applyState" && event.state === "roam",
      ),
      "plain mouse movement should preserve the established 4s cadence",
    );
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
    assert.ok(
      ctx._realBounds.x !== 400 || ctx._realBounds.y !== 300,
      "pet should have started moving after 8s idle delay + 1 frame",
    );
  });

  it("subsequent roams use ROAM_BETWEEN_DELAY_MS (4s)", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    // First roam
    roam.tick();
    mock.timers.tick(8000); // ROAM_IDLE_DELAY_MS
    // Advance time frame-by-frame until animation completes
    for (let i = 0; i < 2000; i++) {
      // 2000 frames * 16ms = 32s (covers up to ~2560px at 80px/s)
      mock.timers.tick(16);
      if (
        ctx._stateLog.some((e) => e.type === "setState" && e.state === "idle")
      )
        break;
    }

    const posAfterFirst = { x: ctx._realBounds.x, y: ctx._realBounds.y };

    // At 3s — should not have started yet
    mock.timers.tick(3000);
    assert.equal(
      ctx._realBounds.x,
      posAfterFirst.x,
      "should not move at 3s between roams",
    );

    // At 4s — second roam pause timer fires
    mock.timers.tick(1000);
    mock.timers.tick(20); // one frame
    assert.ok(
      ctx._realBounds.x !== posAfterFirst.x ||
        ctx._realBounds.y !== posAfterFirst.y,
      "pet should start second wander at 4s between-delay",
    );
  });

  it("cancels roam immediately when state changes from idle to working", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000); // trigger first roam
    mock.timers.tick(20); // one frame of animation

    // Simulate state change to working mid-animation
    ctx.setCurrentState("working");

    // Advance one animation frame — step should detect non-idle and stop
    mock.timers.tick(16);
    const posWhenCancelled = { x: ctx._realBounds.x, y: ctx._realBounds.y };

    // Advance more — position should not change further
    mock.timers.tick(500);
    assert.equal(
      ctx._realBounds.x,
      posWhenCancelled.x,
      "pet should stop moving after state changes to working",
    );
    assert.equal(
      ctx._realBounds.y,
      posWhenCancelled.y,
      "pet should stop moving after state changes to working",
    );
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
    assert.equal(
      ctx._realBounds.x,
      posBeforeCancel.x,
      "pet should stop after cancelRoam",
    );
    const idleRestore = ctx._stateLog.find(
      (event) => event.type === "setState" && event.state === "idle",
    );
    assert.deepStrictEqual(
      idleRestore && idleRestore.options,
      { bypassMinDisplay: true },
      "cancelling active roam must bypass a user-defined roam min-display hold",
    );
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

    assert.equal(
      ctx._realBounds.x,
      400,
      "should not move during mini transition",
    );
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

    const hitWinCalls = ctx._syncLog.filter((e) => e === "syncHitWin").length;
    const anchoredCalls = ctx._syncLog.filter(
      (e) => e === "repositionAnchoredSurfaces",
    ).length;
    assert.ok(
      hitWinCalls >= 3,
      `syncHitWin should be called each frame, got ${hitWinCalls}`,
    );
    assert.ok(
      anchoredCalls >= 3,
      `repositionAnchoredSurfaces should be called each frame, got ${anchoredCalls}`,
    );
  });

  it("switches to roam visual state when animation starts", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000); // pause timer fires, animateTo starts

    // animateTo should have called applyState("roam") before the first step
    const applyStateCalls = ctx._stateLog.filter(
      (e) => e.type === "applyState" && e.state === "roam",
    );
    assert.ok(
      applyStateCalls.length >= 1,
      "should call applyState('roam') when animation starts",
    );
  });

  it("returns to idle via setState when animation completes normally", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000); // trigger first roam

    // Advance time frame-by-frame until animation completes
    // (mock.timers.tick may not update Date.now() correctly for nested setTimeouts)
    for (let i = 0; i < 2000; i++) {
      // 2000 frames * 16ms = 32s (covers up to ~2560px at 80px/s) // 700 frames * 16ms = 11.2s
      mock.timers.tick(16);
      if (
        ctx._stateLog.some((e) => e.type === "setState" && e.state === "idle")
      )
        break;
    }

    // After animation completes, setState("idle") should have been called
    const setStateIdleCalls = ctx._stateLog.filter(
      (e) => e.type === "setState" && e.state === "idle",
    );
    assert.ok(
      setStateIdleCalls.length >= 1,
      "should call setState('idle') when animation completes",
    );
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
    const setStateIdleCalls = ctx._stateLog.filter(
      (e) => e.type === "setState" && e.state === "idle",
    );
    assert.equal(
      setStateIdleCalls.length,
      0,
      "should not call setState('idle') when cancelled by external state change",
    );
  });

  it("resets firstRoam when state changes away from idle/roam (via tick)", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000); // first roam starts
    // Advance time frame-by-frame until animation completes
    for (let i = 0; i < 2000; i++) {
      // 2000 frames * 16ms = 32s (covers up to ~2560px at 80px/s)
      mock.timers.tick(16);
      if (
        ctx._stateLog.some((e) => e.type === "setState" && e.state === "idle")
      )
        break;
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
    assert.ok(
      ctx._realBounds.x !== posAt4s.x || ctx._realBounds.y !== posAt4s.y,
      "should start roaming 8s after returning to idle from working",
    );
  });

  it("resets firstRoam when state changes away from idle/roam (via step)", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000); // first roam starts
    mock.timers.tick(20); // one frame

    // State changes to working mid-animation — step() detects and resets firstRoam
    ctx.setCurrentState("working");
    mock.timers.tick(16); // step runs, detects non-idle, sets firstRoam=true

    // State goes back to idle
    ctx.setCurrentState("idle");
    roam.tick();

    // At 4s — should NOT have started (needs 8s)
    const posBeforeWait = { x: ctx._realBounds.x, y: ctx._realBounds.y };
    mock.timers.tick(4000);
    assert.equal(
      ctx._realBounds.x,
      posBeforeWait.x,
      "should wait 8s after returning from working mid-roam",
    );

    // At 8s — should start
    mock.timers.tick(4000);
    mock.timers.tick(20);
    assert.ok(
      ctx._realBounds.x !== posBeforeWait.x ||
        ctx._realBounds.y !== posBeforeWait.y,
      "should start roaming 8s after returning to idle",
    );
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
    assert.equal(
      ctx._realBounds.x,
      posBeforeDisable.x,
      "pet should stop after setEnabled(false)",
    );
    assert.equal(
      ctx.getCurrentState(),
      "idle",
      "pet should return to idle after disabling free roam mid-animation",
    );
    assert.ok(
      ctx._stateLog.some((e) => e.type === "setState" && e.state === "idle"),
      "disable should restore the visual state from roam to idle",
    );
    assert.equal(roam.enabled, false);
  });

  it("setEnabled(true) resets firstRoam for fresh start", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000); // first roam starts
    // Advance frame-by-frame until animation completes
    for (let i = 0; i < 2000; i++) {
      // 2000 frames * 16ms = 32s (covers up to ~2560px at 80px/s)
      mock.timers.tick(16);
      if (
        ctx._stateLog.some((e) => e.type === "setState" && e.state === "idle")
      )
        break;
    }

    // Disable and re-enable
    roam.setEnabled(false);
    roam.setEnabled(true);

    roam.tick();

    // At 4s — should NOT have started (fresh enable uses 8s delay)
    const posBeforeWait = { x: ctx._realBounds.x, y: ctx._realBounds.y };
    mock.timers.tick(4000);
    assert.equal(
      ctx._realBounds.x,
      posBeforeWait.x,
      "should wait 8s after fresh enable",
    );

    // At 8s — should start
    mock.timers.tick(4000);
    mock.timers.tick(20);
    assert.ok(
      ctx._realBounds.x !== posBeforeWait.x ||
        ctx._realBounds.y !== posBeforeWait.y,
      "should start roaming 8s after fresh enable",
    );
  });

  it("picks targets within work-area margins", () => {
    const smallBounds = { x: 200, y: 200, width: 120, height: 120 };
    const smallRealBounds = { x: 200, y: 200, width: 120, height: 120 };
    const ctx = makeCtx({
      getPetWindowBounds() {
        return { ...smallBounds };
      },
      getNearestWorkArea() {
        return { x: 100, y: 100, width: 400, height: 300 };
      },
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
    for (let i = 0; i < 2000; i++) {
      // 2000 frames * 16ms = 32s (covers up to ~2560px at 80px/s)
      mock.timers.tick(16);
      if (
        ctx._stateLog.some((e) => e.type === "setState" && e.state === "idle")
      )
        break;
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
    assert.equal(
      ctx._realBounds.x,
      posWhenMini.x,
      "pet should stop moving when mini mode activates during roam",
    );
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
      getPetWindowBounds() {
        return { ...bounds };
      },
      getNearestWorkArea() {
        return { x: 0, y: 0, width: 1000, height: 1000 };
      },
    });
    ctx.win.getBounds = () => ({ ...realBounds });
    ctx.win.setBounds = (next) => {
      realBounds.x = next.x;
      realBounds.y = next.y;
      realBounds.width = next.width;
      realBounds.height = next.height;
    };
    ctx.applyPetWindowBounds = (next) => {
      bounds.x = next.x;
      bounds.y = next.y;
      realBounds.x = next.x;
      realBounds.y = next.y;
      realBounds.width = next.width;
      realBounds.height = next.height;
    };

    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.tick();
    mock.timers.tick(8000);
    for (let i = 0; i < 2000; i++) {
      mock.timers.tick(16);
      if (
        ctx._stateLog.some((e) => e.type === "setState" && e.state === "idle")
      )
        break;
    }

    // Fallback ties between all four equidistant corners; the impl keeps the
    // first, (150,150). The pet must have actually moved there — not stalled at
    // its start (the old null-return bug).
    assert.ok(
      Math.abs(realBounds.x - 150) < 5 && Math.abs(realBounds.y - 150) < 5,
      `expected move to farthest corner (150,150), got (${realBounds.x},${realBounds.y})`,
    );
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
      if (
        ctx._stateLog.some((e) => e.type === "setState" && e.state === "idle")
      )
        break;
    }

    const widths = new Set(ctx._appliedBounds.map((b) => b.width));
    const heights = new Set(ctx._appliedBounds.map((b) => b.height));
    assert.ok(
      ctx._appliedBounds.length > 10,
      `walk should span many frames, got ${ctx._appliedBounds.length}`,
    );
    assert.equal(
      widths.size,
      1,
      `width must stay constant across the walk, saw [${[...widths].join(", ")}]`,
    );
    assert.equal(
      heights.size,
      1,
      `height must stay constant across the walk, saw [${[...heights].join(", ")}]`,
    );
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

    assert.ok(
      ctx._appliedBounds.length >= 2,
      "walk should have written frames",
    );
    for (const b of ctx._appliedBounds) {
      assert.equal(
        b.width,
        100,
        "frozen keep-size width must win over start bounds",
      );
      assert.equal(
        b.height,
        100,
        "frozen keep-size height must win over start bounds",
      );
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

    assert.ok(
      ctx._appliedBounds.length >= 2,
      "walk should have written frames",
    );
    for (const b of ctx._appliedBounds) {
      assert.equal(b.width, 120, "falls back to the size read at walk start");
      assert.equal(b.height, 120, "falls back to the size read at walk start");
    }
  });

  it("sends heading=false (face right) when the walk moves rightward", () => {
    // Default mocked random (0.9) picks a target right of the start (400,300).
    const headings = [];
    const ctx = makeCtx({
      setRoamHeading(left) {
        headings.push(left);
      },
    });
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000);

    assert.deepEqual(
      headings,
      [false],
      "rightward walk must face right (no mirror)",
    );
  });

  it("sends heading=true (mirror) when the walk moves leftward", () => {
    // random=0.05 → target (349,193), left of the start (400,300), dist ≈ 118.
    mock.method(Math, "random", () => 0.05);
    const headings = [];
    const ctx = makeCtx({
      setRoamHeading(left) {
        headings.push(left);
      },
    });
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000);

    assert.deepEqual(
      headings,
      [true],
      "leftward walk must mirror the roam visual",
    );
  });

  it("keeps the previous heading on a purely vertical walk", () => {
    // Clamp forces finalX back to the start X → dx === 0 → no heading update.
    const headings = [];
    const ctx = makeCtx({
      setRoamHeading(left) {
        headings.push(left);
      },
      clampToScreenVisual(x, y, w, h) {
        return { x: 400, y, width: w, height: h };
      },
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
    mock.method(
      Math,
      "random",
      () => randomValues[randomIndex++ % randomValues.length],
    );
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
    mock.timers.tick(160); // a few frames in
    const midWalk = { x: ctx._realBounds.x, y: ctx._realBounds.y };
    assert.ok(
      midWalk.x !== 400 || midWalk.y !== 300,
      "walk should be underway",
    );

    editing = true;
    mock.timers.tick(64); // next frame hits the gate

    assert.ok(
      ctx._stateLog.some((e) => e.type === "setState" && e.state === "idle"),
      "gate with no incoming state must restore idle instead of freezing the walk pose",
    );
    const stopped = { x: ctx._realBounds.x, y: ctx._realBounds.y };
    mock.timers.tick(320);
    assert.deepEqual(
      { x: ctx._realBounds.x, y: ctx._realBounds.y },
      stopped,
      "no further movement after the editing gate cancels the walk",
    );
  });
});

describe("roam axis-constrained mode (#686)", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
  });

  afterEach(() => {
    mock.timers.reset();
    mock.reset();
  });

  it("constrains a horizontal move to the X axis (Y unchanged)", () => {
    // Math.random() = 0.5 → firstAxis = "vertical", but 0.5 makes tryAxis
    // pick horizontal first (Math.random() < 0.5 is false → firstAxis="vertical").
    // Use 0.0 so firstAxis = "horizontal", and targetX = xMin + floor(0 * range) = xMin = 288.
    // Wait — 0.0 < 0.5 is true → firstAxis = "horizontal".
    // targetX = 288 + floor(0 * (1488-288)) = 288, dx = |288-400| = 112 >= 100 → returns (288, 300).
    mock.method(Math, "random", () => 0.0);
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(20);

    // Y must be unchanged, X must have moved
    assert.equal(
      ctx._realBounds.y,
      300,
      "horizontal constrained move must keep Y unchanged",
    );
    assert.notEqual(
      ctx._realBounds.x,
      400,
      "horizontal constrained move must change X",
    );
  });

  it("constrains a vertical move to the Y axis (X unchanged)", () => {
    // Math.random() = 0.99 → firstAxis = "vertical" (0.99 >= 0.5).
    // tryAxis("vertical"): targetY = 162 + floor(0.99 * (756-162)) = 162 + 588 = 750.
    // dy = |750-300| = 450 >= 100 → returns (400, 750).
    mock.method(Math, "random", () => 0.99);
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(20);

    assert.equal(
      ctx._realBounds.x,
      400,
      "vertical constrained move must keep X unchanged",
    );
    assert.notEqual(
      ctx._realBounds.y,
      300,
      "vertical constrained move must change Y",
    );
  });

  it("tries the other axis when the first pick is too close", () => {
    // Pet starts at (400, 300) on a 1920×1080 work area.
    // xMin=288, xMax=1488, yMin=162, yMax=756.
    // Math.random() = 0.0 → firstAxis = "horizontal".
    // tryAxis("horizontal"): targetX = 288, dx = |288-400| = 112 >= 100 → succeeds.
    // To force a too-close horizontal pick, place the pet at xMin so any
    // random X in [xMin, xMax) is at least 0 away and at most xMax-xMin.
    // Instead: use a tiny work area so horizontal range < ROAM_MIN_DIST.
    //
    // Work area 200×200, pet 120×120, margin = round(200*0.15) = 30.
    // xMin = 30, xMax = 200-120-30 = 50. range = 20 < 100 → horizontal returns null.
    // yMin = 30, yMax = 50, range = 20 < 100 → vertical also returns null.
    // That would return null entirely. So use a wider work area:
    // Work area 600×600, pet 120×120, margin = 90.
    // xMin = 90, xMax = 600-120-90 = 390. range = 300 >= 100.
    // Pet at (200, 200). Math.random() = 0.0 → firstAxis = "horizontal".
    // targetX = 90, dx = |90-200| = 110 >= 100 → succeeds.
    // To force horizontal fail: pet at x=90 (xMin), random=0 → targetX=90, dx=0.
    // Then fall through to vertical: random=0 → targetY = yMin, dy = |yMin - 200|.
    // yMin=90, dy = |90-200| = 110 >= 100 → returns (90, 90). But wait —
    // tryAxis uses the same Math.random sequence. We need to control
    // the sequence of random calls.
    //
    // Sequence with random=0.0 always:
    //   1. firstAxis pick: random() = 0.0 → "horizontal"
    //   2. tryAxis("horizontal"): range=300 >= 100. Loop i=0: targetX = 90 + floor(0*300) = 90. dx = |90-90| = 0 < 100.
    //      i=1..7: same, all targetX=90, dx=0. Fallback: farX = xMax=390 (|390-90|=300 >= |90-90|=0). Returns (390, 200).
    // Hmm, the fallback will succeed. Let's make the pet at xMax instead.
    // Pet at (390, 200). Fallback: farX = xMin=90 (|90-390|=300 vs |390-390|=0). Returns (90, 200). Still succeeds.
    // To make horizontal truly fail, both xMin and xMax must be within 100px.
    // Work area 250×1000, pet 120×120, margin_x = round(250*0.15) = 38.
    // xMin = 38, xMax = 250-120-38 = 92. Pet x=50 keeps every
    // horizontal candidate and both edges within 100px, so that axis fails.
    // yMin = round(1000*0.15) = 150. yMax = 1000-120-150 = 730. range = 580 >= 100.
    // Pet at (50, 200). random=0.0 → firstAxis="horizontal" → null.
    // tryAxis("vertical"): targetY = 150 + floor(0*580) = 150. dy = |150-200| = 50 < 100.
    //   i=1..7: same. Fallback: farY = yMin=150 (|150-200|=50) vs yMax=730 (|730-200|=530). farY=730. dy=530>=100. Returns (50, 730).
    // So X stays at 50, Y moves to 730. This tests cross-axis fallback.
    mock.method(Math, "random", () => 0.0);
    const bounds = { x: 50, y: 200, width: 120, height: 120 };
    const realBounds = { ...bounds };
    const ctx = makeCtx({
      getPetWindowBounds() {
        return { ...bounds };
      },
      getNearestWorkArea() {
        return { x: 0, y: 0, width: 250, height: 1000 };
      },
    });
    ctx.win.getBounds = () => ({ ...realBounds });
    ctx.win.setBounds = (next) => {
      realBounds.x = next.x;
      realBounds.y = next.y;
      realBounds.width = next.width;
      realBounds.height = next.height;
    };
    ctx.applyPetWindowBounds = (next) => {
      bounds.x = next.x;
      bounds.y = next.y;
      bounds.width = next.width;
      bounds.height = next.height;
      realBounds.x = next.x;
      realBounds.y = next.y;
      realBounds.width = next.width;
      realBounds.height = next.height;
    };

    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(20);

    // Horizontal candidates and the farthest edge were all too close.
    // Vertical fallback should have been used: X unchanged, Y changed.
    assert.equal(
      realBounds.x,
      50,
      "cross-axis fallback: X must be unchanged when horizontal axis is too narrow",
    );
    assert.notEqual(
      realBounds.y,
      200,
      "cross-axis fallback: Y must change when vertical axis is used as fallback",
    );
  });

  it("uses a narrow axis when the start lies far outside its target band", () => {
    // xMin=38, xMax=92 (only 54px wide), but the pet starts at x=200.
    // A target inside that narrow band is still more than 100px away, so the
    // horizontal axis is valid and must not be rejected based on band width.
    mock.method(Math, "random", () => 0.0);
    const ctx = makeCtx({
      getNearestWorkArea() {
        return { x: 0, y: 0, width: 250, height: 1000 };
      },
    });
    Object.assign(ctx._bounds, { x: 200, y: 200, width: 120, height: 120 });
    Object.assign(ctx._realBounds, ctx._bounds);

    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(20);

    assert.notEqual(ctx._realBounds.x, 200, "the narrow horizontal band should remain usable");
    assert.equal(ctx._realBounds.y, 200, "a valid horizontal move must keep Y unchanged");
  });

  it("uses a narrow vertical axis when the start lies far outside its target band", () => {
    // yMin=38, yMax=92 (only 54px tall), but the pet starts at y=200.
    // The narrow-band rule must be symmetric for vertical movement.
    mock.method(Math, "random", () => 0.99);
    const ctx = makeCtx({
      getNearestWorkArea() {
        return { x: 0, y: 0, width: 1000, height: 250 };
      },
    });
    Object.assign(ctx._bounds, { x: 200, y: 200, width: 120, height: 120 });
    Object.assign(ctx._realBounds, ctx._bounds);

    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(20);

    assert.equal(ctx._realBounds.x, 200, "a valid vertical move must keep X unchanged");
    assert.notEqual(ctx._realBounds.y, 200, "the narrow vertical band should remain usable");
  });

  it("uses the valid axis when the other axis has no target interval", () => {
    // The 150px-tall work area cannot fit the pet inside the vertical inner
    // band (yMin=23, yMax=7), while the horizontal band remains valid.
    // Constrained mode only needs one moving axis, so invalid vertical geometry
    // must not make the whole picker return null before trying horizontal.
    // Pick the invalid vertical axis first; the picker must then fall back to
    // the valid horizontal axis instead of returning null.
    mock.method(Math, "random", () => 0.99);
    const ctx = makeCtx({
      getNearestWorkArea() {
        return { x: 0, y: 0, width: 1000, height: 150 };
      },
    });
    Object.assign(ctx._bounds, { x: 300, y: 0, width: 120, height: 120 });
    Object.assign(ctx._realBounds, ctx._bounds);

    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(20);

    assert.notEqual(ctx._realBounds.x, 300, "the valid horizontal axis should still move");
    assert.equal(ctx._realBounds.y, 0, "the invalid vertical geometry must not alter Y");
  });

  it("uses the valid vertical axis when horizontal has no target interval", () => {
    // Pick the invalid horizontal axis first; the picker must then fall back to
    // the valid vertical axis instead of returning null.
    mock.method(Math, "random", () => 0.0);
    const ctx = makeCtx({
      getNearestWorkArea() {
        return { x: 0, y: 0, width: 150, height: 1000 };
      },
    });
    Object.assign(ctx._bounds, { x: 0, y: 300, width: 120, height: 120 });
    Object.assign(ctx._realBounds, ctx._bounds);

    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(20);

    assert.equal(ctx._realBounds.x, 0, "the invalid horizontal geometry must not alter X");
    assert.notEqual(ctx._realBounds.y, 300, "the valid vertical axis should still move");
  });

  it("returns null when neither axis has room for a valid target", () => {
    // Work area too small in both axes: 200×200, pet 120×120, margin=30.
    // xMin=30, xMax=50, range=20 < 100. yMin=30, yMax=50, range=20 < 100.
    // Both axes return null → pickRandomTarget returns null → no roam.
    mock.method(Math, "random", () => 0.5);
    const bounds = { x: 35, y: 35, width: 120, height: 120 };
    const realBounds = { ...bounds };
    const ctx = makeCtx({
      getPetWindowBounds() {
        return { ...bounds };
      },
      getNearestWorkArea() {
        return { x: 0, y: 0, width: 200, height: 200 };
      },
    });
    ctx.win.getBounds = () => ({ ...realBounds });
    ctx.win.setBounds = (next) => {
      realBounds.x = next.x;
      realBounds.y = next.y;
      realBounds.width = next.width;
      realBounds.height = next.height;
    };
    ctx.applyPetWindowBounds = (next) => {
      bounds.x = next.x;
      bounds.y = next.y;
      bounds.width = next.width;
      bounds.height = next.height;
      realBounds.x = next.x;
      realBounds.y = next.y;
      realBounds.width = next.width;
      realBounds.height = next.height;
    };

    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(500);

    // No movement at all — both axes too narrow
    assert.equal(realBounds.x, 35, "no movement when neither axis has room");
    assert.equal(realBounds.y, 35, "no movement when neither axis has room");
    assert.ok(
      !ctx._stateLog.some((e) => e.type === "applyState" && e.state === "roam"),
      "no roam state when neither axis has room",
    );
  });

  it("preserves the stationary coordinate when starting outside inner margins", () => {
    // Pet at Y=0 (above yMin=162 on 1080 work area). Horizontal move must
    // keep Y=0, not clamp it into the margin band.
    // Math.random() = 0.0 → firstAxis = "horizontal".
    // targetX = 288, dx = |288-400| = 112 >= 100 → returns (288, 0).
    mock.method(Math, "random", () => 0.0);
    const bounds = { x: 400, y: 0, width: 120, height: 120 };
    const realBounds = { ...bounds };
    const ctx = makeCtx({
      getPetWindowBounds() {
        return { ...bounds };
      },
    });
    ctx.win.getBounds = () => ({ ...realBounds });
    ctx.win.setBounds = (next) => {
      realBounds.x = next.x;
      realBounds.y = next.y;
      realBounds.width = next.width;
      realBounds.height = next.height;
    };
    ctx.applyPetWindowBounds = (next) => {
      bounds.x = next.x;
      bounds.y = next.y;
      bounds.width = next.width;
      bounds.height = next.height;
      realBounds.x = next.x;
      realBounds.y = next.y;
      realBounds.width = next.width;
      realBounds.height = next.height;
    };

    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(20);

    assert.equal(
      realBounds.y,
      0,
      "stationary coordinate must be unchanged when starting outside margins",
    );
  });

  it("preserves the stationary coordinate with a non-zero work-area origin", () => {
    // Work area starts at (100, 100). Pet at (500, 50) — Y is above yMin.
    // xMin = 100 + round(1920*0.15) = 100 + 288 = 388.
    // xMax = 100 + 1920 - 120 - 288 = 1612.
    // yMin = 100 + round(1080*0.15) = 100 + 162 = 262.
    // yMax = 100 + 1080 - 120 - 162 = 898.
    // Math.random() = 0.0 → firstAxis = "horizontal".
    // targetX = 388, dx = |388-500| = 112 >= 100 → returns (388, 50).
    mock.method(Math, "random", () => 0.0);
    const bounds = { x: 500, y: 50, width: 120, height: 120 };
    const realBounds = { ...bounds };
    const ctx = makeCtx({
      getPetWindowBounds() {
        return { ...bounds };
      },
      getNearestWorkArea() {
        return { x: 100, y: 100, width: 1920, height: 1080 };
      },
    });
    ctx.win.getBounds = () => ({ ...realBounds });
    ctx.win.setBounds = (next) => {
      realBounds.x = next.x;
      realBounds.y = next.y;
      realBounds.width = next.width;
      realBounds.height = next.height;
    };
    ctx.applyPetWindowBounds = (next) => {
      bounds.x = next.x;
      bounds.y = next.y;
      bounds.width = next.width;
      bounds.height = next.height;
      realBounds.x = next.x;
      realBounds.y = next.y;
      realBounds.width = next.width;
      realBounds.height = next.height;
    };

    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(20);

    assert.equal(
      realBounds.y,
      50,
      "stationary Y must be unchanged with non-zero work-area origin",
    );
  });

  it("preserves the stationary coordinate through the final screen clamp (horizontal)", () => {
    // Review pass 2 regression: pet starts at (400, -100) — above the
    // rest-clamp region — and picks a horizontal target. clampToScreenVisual()
    // corrects the stationary Y up to 0, which would otherwise reintroduce a
    // diagonal walk. The final clamp must be axis-aware: every applied frame
    // keeps Y equal to the walk start (-100).
    // Math.random() = 0.0 → firstAxis = "horizontal".
    // targetX = 288, dx = |288-400| = 112 >= 100 → returns (288, -100, horizontal).
    mock.method(Math, "random", () => 0.0);
    const bounds = { x: 400, y: -100, width: 120, height: 120 };
    const realBounds = { ...bounds };
    const appliedBounds = [];
    const ctx = makeCtx({
      getPetWindowBounds() {
        return { ...bounds };
      },
      clampToScreenVisual(x, y, w, h) {
        // Rest-clamp ceiling forces Y to 0 — the stationary-coordinate
        // correction the axis invariant must not let through.
        return { x, y: 0, width: w, height: h };
      },
    });
    ctx.win.getBounds = () => ({ ...realBounds });
    ctx.win.setBounds = (next) => {
      realBounds.x = next.x;
      realBounds.y = next.y;
      realBounds.width = next.width;
      realBounds.height = next.height;
    };
    ctx.applyPetWindowBounds = (next) => {
      appliedBounds.push({ ...next });
      bounds.x = next.x;
      bounds.y = next.y;
      bounds.width = next.width;
      bounds.height = next.height;
      realBounds.x = next.x;
      realBounds.y = next.y;
      realBounds.width = next.width;
      realBounds.height = next.height;
    };
    ctx._appliedBounds = appliedBounds;

    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(500); // several animation frames

    assert.ok(
      appliedBounds.length > 0,
      "walk should have produced applied frames",
    );
    // Every applied frame keeps the stationary Y at the walk start (-100);
    // the clamp's Y=0 correction must not survive the axis-aware restore.
    for (const b of appliedBounds) {
      assert.strictEqual(
        b.y,
        -100,
        "stationary Y must equal the walk start through the final clamp in every frame",
      );
      assert.notStrictEqual(
        b.y,
        0,
        "clamp's Y=0 correction must not leak into any applied frame",
      );
    }
    // The moving axis must actually move, and exactly one coordinate matches
    // the walk start (Y matches, X does not).
    assert.ok(
      appliedBounds.some((b) => b.x !== 400),
      "moving X must differ from the walk start in at least one frame",
    );
    for (const b of appliedBounds.filter((b) => b.x !== 400)) {
      assert.strictEqual(b.y, -100, "moved frame keeps Y at the walk start");
      assert.notStrictEqual(b.x, 400, "moved frame's X differs from the walk start");
    }
  });

  it("preserves the stationary coordinate through the final screen clamp (vertical)", () => {
    // Symmetric to the horizontal case: pet starts at X=-100 (left of the
    // rest-clamp region), picks a vertical target. clampToScreenVisual()
    // corrects the stationary X to 0. The final clamp must keep X at -100.
    // Math.random() = 0.99 → firstAxis = "vertical".
    // targetY = 162 + floor(0.99 * 594) = 750, dy = 450 >= 100 → returns (-100, 750, vertical).
    mock.method(Math, "random", () => 0.99);
    const bounds = { x: -100, y: 300, width: 120, height: 120 };
    const realBounds = { ...bounds };
    const appliedBounds = [];
    const ctx = makeCtx({
      getPetWindowBounds() {
        return { ...bounds };
      },
      clampToScreenVisual(x, y, w, h) {
        return { x: 0, y, width: w, height: h };
      },
    });
    ctx.win.getBounds = () => ({ ...realBounds });
    ctx.win.setBounds = (next) => {
      realBounds.x = next.x;
      realBounds.y = next.y;
      realBounds.width = next.width;
      realBounds.height = next.height;
    };
    ctx.applyPetWindowBounds = (next) => {
      appliedBounds.push({ ...next });
      bounds.x = next.x;
      bounds.y = next.y;
      bounds.width = next.width;
      bounds.height = next.height;
      realBounds.x = next.x;
      realBounds.y = next.y;
      realBounds.width = next.width;
      realBounds.height = next.height;
    };
    ctx._appliedBounds = appliedBounds;

    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(500);

    assert.ok(appliedBounds.length > 0, "walk should have produced applied frames");
    for (const b of appliedBounds) {
      assert.strictEqual(
        b.x,
        -100,
        "stationary X must equal the walk start through the final clamp in every frame",
      );
      assert.notStrictEqual(
        b.x,
        0,
        "clamp's X=0 correction must not leak into any applied frame",
      );
    }
    assert.ok(
      appliedBounds.some((b) => b.y !== 300),
      "moving Y must differ from the walk start in at least one frame",
    );
  });

  it("leaves the unconstrained roam untouched when the clamp changes both coordinates", () => {
    // Guard: the axis-aware restore must only apply to axis-tagged walks.
    // A free-direction roam (constrainAxis off) must still accept the clamp's
    // corrections on both axes — no stationary coordinate is forced.
    // Math.random() = 0.9 → 2D picker: targetX=1368, targetY=696 (both move).
    mock.method(Math, "random", () => 0.9);
    const ctx = makeCtx({
      clampToScreenVisual(x, y, w, h) {
        return { x: x + 10, y: y + 10, width: w, height: h };
      },
    });
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    // constrainAxis stays false (default)

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(500);

    // The clamp shifted both coordinates; the unconstrained walk must honor
    // that shift (no axis restore forced Y back to the start).
    assert.ok(
      ctx._appliedBounds.length > 0,
      "unconstrained walk should have produced applied frames",
    );
    assert.ok(
      ctx._appliedBounds.some((b) => b.y !== 300),
      "unconstrained walk must let the clamp move Y off the start",
    );
    assert.ok(
      ctx._appliedBounds.some((b) => b.x !== 400),
      "unconstrained walk must let the clamp move X off the start",
    );
  });

  it("enabling constrainAxis during an active roam cancels and replans", () => {
    // Start an unconstrained roam, then enable constrainAxis mid-walk.
    // The current diagonal walk should be cancelled immediately.
    const randomValues = [0.9, 0.9, 0.9, 0.1];
    let randomIndex = 0;
    mock.method(
      Math,
      "random",
      () => randomValues[randomIndex++ % randomValues.length],
    );
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);

    roam.tick();
    mock.timers.tick(8000); // roam starts (unconstrained)
    mock.timers.tick(160); // a few frames in
    const posMidWalk = { x: ctx._realBounds.x, y: ctx._realBounds.y };
    assert.ok(
      posMidWalk.x !== 400 || posMidWalk.y !== 300,
      "walk should be underway before enabling constrain",
    );

    // Enable constrain axis — should cancel the current walk
    roam.setConstrainAxis(true);

    // Pet should stop (walk cancelled)
    const posAfterCancel = { x: ctx._realBounds.x, y: ctx._realBounds.y };
    mock.timers.tick(500);
    assert.equal(
      ctx._realBounds.x,
      posAfterCancel.x,
      "pet should stop after enabling constrainAxis mid-walk",
    );
    assert.equal(
      ctx._realBounds.y,
      posAfterCancel.y,
      "pet should stop after enabling constrainAxis mid-walk",
    );

    // A new roam should be scheduled (firstRoam=true → 8s delay)
    mock.timers.tick(8000);
    mock.timers.tick(20);

    // The new walk should be axis-constrained (either X or Y unchanged from
    // the position where the previous walk was cancelled)
    assert.ok(
      ctx._realBounds.x === posAfterCancel.x ||
        ctx._realBounds.y === posAfterCancel.y,
      "new walk after enabling constrain should be axis-aligned",
    );
  });

  it("roamConstrainAxis: false retains the existing free-direction behavior", () => {
    // With constrainAxis disabled, the roam should be able to move diagonally
    // (both X and Y change in the same walk).
    // Math.random() = 0.9 → targetX = 288 + floor(0.9 * 1200) = 288 + 1080 = 1368.
    // targetY = 162 + floor(0.9 * 594) = 162 + 534 = 696. Both differ from start (400, 300).
    mock.method(Math, "random", () => 0.9);
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    // constrainAxis defaults to false — don't enable it

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(20);

    assert.notEqual(
      ctx._realBounds.x,
      400,
      "free-direction roam should change X",
    );
    assert.notEqual(
      ctx._realBounds.y,
      300,
      "free-direction roam should change Y",
    );
    // The key assertion: both changed → diagonal (not axis-constrained)
    assert.ok(
      ctx._realBounds.x !== 400 && ctx._realBounds.y !== 300,
      "free-direction roam should move diagonally (both axes change)",
    );
  });

  it("setConstrainAxis is a no-op when value does not change", () => {
    const ctx = makeCtx();
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);

    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(20);
    const posBefore = { x: ctx._realBounds.x, y: ctx._realBounds.y };

    // Set to true again — should not cancel/replan
    roam.setConstrainAxis(true);
    mock.timers.tick(100);

    assert.equal(
      ctx._realBounds.x,
      posBefore.x,
      "setting the same value should not disrupt the current roam",
    );
  });
});

describe("roam fence (#810)", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
  });

  afterEach(() => {
    mock.timers.reset();
    mock.reset();
  });

  // Default work area 1920×1080, pet 120×120 → margin band x∈[288,1512],
  // y∈[162,798]. Fence fractions .4–.6 → fence pixels x∈[768,1152],
  // y∈[432,648]; window-containment intervals x∈[768,1032], y∈[432,528].
  const FENCE = { active: true, left: 0.4, top: 0.4, right: 0.6, bottom: 0.6 };
  const FULL = { active: true, left: 0, top: 0, right: 1, bottom: 1 };
  const INACTIVE = { active: false, left: 0, top: 0, right: 1, bottom: 1 };

  function fenceCtx(fenceState, overrides = {}) {
    const ctx = makeCtx(overrides);
    if (fenceState !== undefined) {
      ctx.roamFence = {
        get: () => fenceState,
        refresh: () => {},
      };
    }
    return ctx;
  }

  function placePet(ctx, x, y) {
    ctx._bounds.x = x;
    ctx._bounds.y = y;
    ctx._realBounds.x = x;
    ctx._realBounds.y = y;
  }

  function runOneWalk(ctx, roam) {
    roam.tick();
    mock.timers.tick(8000);
    for (let i = 0; i < 4000; i += 1) {
      mock.timers.tick(16);
      if (
        ctx._stateLog.some((e) => e.type === "setState" && e.state === "idle")
      )
        break;
    }
  }

  function assertWithinFencePixels(rect, fencePx, label) {
    assert.ok(
      rect.x >= fencePx.left &&
        rect.x + rect.width <= fencePx.right &&
        rect.y >= fencePx.top &&
        rect.y + rect.height <= fencePx.bottom,
      `${label}: (${rect.x},${rect.y},${rect.width}×${rect.height}) escapes fence [${fencePx.left}..${fencePx.right}]×[${fencePx.top}..${fencePx.bottom}]`,
    );
  }

  const FENCE_PX = { left: 768, top: 432, right: 1152, bottom: 648 };

  // ── Parent-behavior pins: no fence, disabled, full-range ──

  it("no fence file: small work areas still produce no target (parent pin)", () => {
    // Reviewer repro: 400×300 work area, 250×170 pet at (60,45) — farthest
    // candidate is 50px away, under ROAM_MIN_DIST. The parent returns no
    // target; the adaptive threshold must NOT engage without a fence.
    mock.method(Math, "random", () => 0.9);
    const ctx = makeCtx({
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 400, height: 300 }),
    });
    ctx._bounds.width = 250;
    ctx._bounds.height = 170;
    ctx._realBounds.width = 250;
    ctx._realBounds.height = 170;
    placePet(ctx, 60, 45);
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(8000);
    assert.equal(ctx._appliedBounds.length, 0, "no walk may start");
    assert.ok(
      !ctx._stateLog.some((e) => e.state === "roam"),
      "pet never enters roam state",
    );
  });

  it("disabled fence keeps parent behavior on small work areas", () => {
    mock.method(Math, "random", () => 0.9);
    const ctx = fenceCtx(INACTIVE, {
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 400, height: 300 }),
    });
    ctx._bounds.width = 250;
    ctx._bounds.height = 170;
    ctx._realBounds.width = 250;
    ctx._realBounds.height = 170;
    placePet(ctx, 60, 45);
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(8000);
    assert.equal(ctx._appliedBounds.length, 0, "no walk may start");
  });

  it("full-range fence keeps parent behavior on small work areas", () => {
    mock.method(Math, "random", () => 0.9);
    const ctx = fenceCtx(FULL, {
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 400, height: 300 }),
    });
    ctx._bounds.width = 250;
    ctx._bounds.height = 170;
    ctx._realBounds.width = 250;
    ctx._realBounds.height = 170;
    placePet(ctx, 60, 45);
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(8000);
    assert.equal(ctx._appliedBounds.length, 0, "no walk may start");
  });

  it("full-range fence does not revive an impossible parent margin band", () => {
    // 200x200 work area, 150x150 pet: the historical 15% band is [30,20]
    // on both axes and therefore has no target. Round-4 edge fallback must
    // not mistake that parent condition for a conflict with a full-range
    // fence and enable the adaptive fenced hop.
    mock.method(Math, "random", () => 0.9);
    const pixelEquivalentFull = {
      active: true,
      left: 0.001,
      top: 0.001,
      right: 0.999,
      bottom: 0.999,
    };
    for (const fenceState of [undefined, FULL, pixelEquivalentFull]) {
      const ctx = fenceCtx(fenceState, {
        getNearestWorkArea: () => ({ x: 0, y: 0, width: 200, height: 200 }),
      });
      ctx._bounds.width = 150;
      ctx._bounds.height = 150;
      ctx._realBounds.width = 150;
      ctx._realBounds.height = 150;
      placePet(ctx, 25, 25);
      const roam = roamModule(ctx);
      roam.setEnabled(true);
      roam.tick();
      mock.timers.tick(8000);
      mock.timers.tick(8000);
      assert.equal(
        ctx._appliedBounds.length,
        0,
        fenceState
          ? "pixel-full fence must preserve parent hold"
          : "parent holds",
      );
    }
  });

  it("full-range fence recovers an outside large cross-display pet", () => {
    // A keep-size pet carried from a larger display can occupy >70% of a
    // smaller work area, making both historical 15% margin intervals
    // impossible. Contained pets must keep the parent hold above, but an
    // outside pet still needs the documented one-walk fence recovery. The
    // near-full fractions round to the exact same realized pixel rectangle.
    mock.method(Math, "random", () => 0.9);
    const pixelEquivalentFull = {
      active: true,
      left: 0.0001,
      top: 0.0001,
      right: 0.9999,
      bottom: 0.9999,
    };
    for (const fenceState of [FULL, pixelEquivalentFull]) {
      for (const constrainAxis of [false, true]) {
        const ctx = fenceCtx(fenceState, {
          getNearestWorkArea: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
        });
        ctx._bounds.width = 750;
        ctx._bounds.height = 750;
        ctx._realBounds.width = 750;
        ctx._realBounds.height = 750;
        placePet(ctx, -20, 25); // X outside; Y already contained in [0,50]
        const roam = roamModule(ctx);
        roam.setEnabled(true);
        roam.setConstrainAxis(constrainAxis);
        runOneWalk(ctx, roam);
        assert.ok(
          ctx._appliedBounds.length > 0,
          `outside pixel-full fence must recover (axis=${constrainAxis})`,
        );
        const last = ctx._appliedBounds[ctx._appliedBounds.length - 1];
        assertWithinFencePixels(
          last,
          { left: 0, top: 0, right: 1000, bottom: 800 },
          `recovered window (axis=${constrainAxis})`,
        );
        if (constrainAxis) {
          for (const b of ctx._appliedBounds) {
            assert.equal(b.y, 25, "axis recovery keeps Y fixed on every frame");
          }
        }
        roam.setEnabled(false);
      }
    }
  });

  it("inactive fence picks the same target as no loader at all", () => {
    mock.method(Math, "random", () => 0.9);
    const runs = [];
    for (const fenceState of [undefined, INACTIVE]) {
      const ctx = fenceCtx(fenceState);
      const roam = roamModule(ctx);
      roam.setEnabled(true);
      runOneWalk(ctx, roam);
      assert.ok(ctx._appliedBounds.length > 0, "walk should run");
      runs.push(ctx._appliedBounds[ctx._appliedBounds.length - 1]);
      roam.setEnabled(false);
    }
    assert.deepEqual(runs[0], runs[1], "fence-inactive must equal no-fence");
  });

  // ── Fence-active behavior, free-direction mode ──

  it("confines free-direction targets to the fence rectangle", () => {
    mock.method(Math, "random", () => 0.9);
    const ctx = fenceCtx(FENCE);
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    runOneWalk(ctx, roam);
    assert.ok(ctx._appliedBounds.length > 0, "walk should run");
    const last = ctx._appliedBounds[ctx._appliedBounds.length - 1];
    assert.deepEqual(
      { x: last.x, y: last.y },
      { x: 1005, y: 518 },
      "deterministic fenced target",
    );
    assertWithinFencePixels(last, FENCE_PX, "final window");
  });

  it("scales the minimum hop down only when the fence shrinks the interval", () => {
    // Fence x∈[.45,.58], y∈[.45,.58] → candidate ranges 130×20px. Every
    // candidate is <100px from a start inside the fence, so the parent
    // threshold would reject all of them — the fence-scaled threshold must
    // accept one instead of freezing the pet.
    mock.method(Math, "random", () => 0.9);
    const ctx = fenceCtx({
      active: true,
      left: 0.45,
      top: 0.45,
      right: 0.58,
      bottom: 0.58,
    });
    placePet(ctx, 930, 496);
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    runOneWalk(ctx, roam);
    assert.ok(
      ctx._appliedBounds.length > 0,
      "small fence must still produce short walks",
    );
    const last = ctx._appliedBounds[ctx._appliedBounds.length - 1];
    assertWithinFencePixels(
      last,
      { left: 864, top: 486, right: 1114, bottom: 626 },
      "final window",
    );
  });

  it("plans with the effective animation size so the real window stays fenced", () => {
    // Reviewer repro: 1000×1000 work area, fence .4–.6 (400..600px), picker
    // bounds 100×100 but effective animation size 200×200. Planning with the
    // 100px bounds would allow x≈499 → window to ~699, outside the fence.
    // Planning with the frozen 200px size leaves exactly one target: (400,400).
    mock.method(Math, "random", () => 0.9);
    const ctx = fenceCtx(FENCE, {
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 1000, height: 1000 }),
      getEffectiveCurrentPixelSize: () => ({ width: 200, height: 200 }),
    });
    ctx._bounds.width = 100;
    ctx._bounds.height = 100;
    ctx._realBounds.width = 100;
    ctx._realBounds.height = 100;
    placePet(ctx, 100, 100);
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    runOneWalk(ctx, roam);
    assert.ok(ctx._appliedBounds.length > 0, "exact-fit walk should run");
    for (const b of ctx._appliedBounds) {
      assert.equal(b.width, 200, "every frame uses the frozen effective size");
      assert.equal(b.height, 200);
    }
    const last = ctx._appliedBounds[ctx._appliedBounds.length - 1];
    assert.deepEqual({ x: last.x, y: last.y }, { x: 400, y: 400 });
    assertWithinFencePixels(
      last,
      { left: 400, top: 400, right: 600, bottom: 600 },
      "final window",
    );
  });

  it("handles negative work-area origins", () => {
    mock.method(Math, "random", () => 0.9);
    const ctx = fenceCtx(FENCE, {
      getNearestWorkArea: () => ({
        x: -1920,
        y: 0,
        width: 1920,
        height: 1080,
      }),
    });
    placePet(ctx, -1000, 300);
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    runOneWalk(ctx, roam);
    assert.ok(ctx._appliedBounds.length > 0, "walk should run");
    const last = ctx._appliedBounds[ctx._appliedBounds.length - 1];
    assert.deepEqual({ x: last.x, y: last.y }, { x: -915, y: 518 });
    assertWithinFencePixels(
      last,
      { left: -1152, top: 432, right: -768, bottom: 648 },
      "final window",
    );
  });

  it("skips the round when screen clamping would push the window out of the fence", () => {
    mock.method(Math, "random", () => 0.9);
    const ctx = fenceCtx(FENCE, {
      clampToScreenVisual: (x, y, w, h) => ({ x: 1200, y, width: w, height: h }),
    });
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(1000);
    assert.equal(
      ctx._appliedBounds.length,
      0,
      "a clamp-escaped target must not start a walk",
    );
    assert.ok(
      !ctx._stateLog.some((e) => e.state === "roam"),
      "pet never enters roam state on a skipped round",
    );
  });

  // ── Fence × axis-constrained roam (#686) ──

  it("axis mode, start inside fence: walks one axis and every frame stays fenced", () => {
    mock.method(Math, "random", () => 0.3); // → horizontal preferred
    const ctx = fenceCtx(FENCE);
    placePet(ctx, 800, 450);
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);
    runOneWalk(ctx, roam);
    assert.ok(ctx._appliedBounds.length > 0, "walk should run");
    for (const b of ctx._appliedBounds) {
      assert.equal(b.y, 450, "stationary Y must hold on every applied frame");
      assertWithinFencePixels(b, FENCE_PX, "every applied frame");
    }
    const last = ctx._appliedBounds[ctx._appliedBounds.length - 1];
    assert.equal(last.x, 1032, "deterministic fenced edge target");
  });

  it("axis mode, X outside fence: X must be the moving axis", () => {
    mock.method(Math, "random", () => 0.3);
    const ctx = fenceCtx(FENCE);
    placePet(ctx, 200, 450); // X outside [768,1032], Y inside [432,528]
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);
    runOneWalk(ctx, roam);
    assert.ok(ctx._appliedBounds.length > 0, "walk should run");
    for (const b of ctx._appliedBounds) {
      assert.equal(b.y, 450, "Y is stationary on every applied frame");
    }
    const last = ctx._appliedBounds[ctx._appliedBounds.length - 1];
    assert.equal(last.x, 847, "walk pulls X back inside the fence");
    assertWithinFencePixels(last, FENCE_PX, "final window");
  });

  it("axis mode, Y outside fence: Y must be the moving axis", () => {
    mock.method(Math, "random", () => 0.3);
    const ctx = fenceCtx(FENCE);
    placePet(ctx, 800, 100); // Y outside, X inside
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);
    runOneWalk(ctx, roam);
    assert.ok(ctx._appliedBounds.length > 0, "walk should run");
    for (const b of ctx._appliedBounds) {
      assert.equal(b.x, 800, "X is stationary on every applied frame");
    }
    const last = ctx._appliedBounds[ctx._appliedBounds.length - 1];
    assert.equal(last.y, 460, "walk pulls Y back inside the fence");
    assertWithinFencePixels(last, FENCE_PX, "final window");
  });

  it("axis mode, both coordinates outside: staged two-round recovery (#810 r4)", () => {
    // Round-4 review: both-outside used to return no target forever — a
    // permanent freeze. Staged recovery fixes X first (partial containment:
    // moving axis only), then the next round sees only Y outside and
    // finishes. Every frame of both stages changes exactly one coordinate.
    mock.method(Math, "random", () => 0.3);
    const ctx = fenceCtx(FENCE);
    placePet(ctx, 200, 100); // both outside [768,1032]×[432,528]
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);
    roam.tick();
    mock.timers.tick(8000);
    // ── stage 1: X recovers, Y frozen ──
    for (let i = 0; i < 2000; i += 1) {
      mock.timers.tick(16);
      if (
        ctx._stateLog.filter((e) => e.type === "setState" && e.state === "idle")
          .length >= 1
      )
        break;
    }
    const stage1 = ctx._appliedBounds.slice();
    assert.ok(stage1.length > 0, "stage 1 walk must run");
    for (const b of stage1) {
      assert.equal(b.y, 100, "stage 1 holds Y on every frame");
    }
    const s1last = stage1[stage1.length - 1];
    assert.equal(s1last.x, 847, "stage 1 pulls X inside the fence");
    // ── stage 2: Y recovers, X frozen ──
    roam.tick();
    mock.timers.tick(4000);
    for (let i = 0; i < 2000; i += 1) {
      mock.timers.tick(16);
      if (
        ctx._stateLog.filter((e) => e.type === "setState" && e.state === "idle")
          .length >= 2
      )
        break;
    }
    const stage2 = ctx._appliedBounds.slice(stage1.length);
    assert.ok(stage2.length > 0, "stage 2 walk must run");
    for (const b of stage2) {
      assert.equal(b.x, 847, "stage 2 holds X on every frame");
    }
    const last = stage2[stage2.length - 1];
    assertWithinFencePixels(last, FENCE_PX, "final window after both stages");
  });

  it("axis mode: small fences use the scaled per-axis minimum hop", () => {
    // Exact-fit corridor: fence width exactly the pet (x range collapses to a
    // point), height leaves y∈[432,506]. Max reachable hop from (768,450) is
    // 56px — the fixed 100px minimum would never produce an axis target.
    mock.method(Math, "random", () => 0.3);
    const ctx = fenceCtx({
      active: true,
      left: 0.4,
      top: 0.4,
      right: 0.4625,
      bottom: 0.58,
    });
    placePet(ctx, 768, 450);
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);
    runOneWalk(ctx, roam);
    assert.ok(
      ctx._appliedBounds.length > 0,
      "corridor fence must still produce axis walks",
    );
    for (const b of ctx._appliedBounds) {
      assert.equal(b.x, 768, "X is stationary in the exact-fit corridor");
    }
    const last = ctx._appliedBounds[ctx._appliedBounds.length - 1];
    assert.equal(last.y, 506, "deterministic corridor edge target");
  });

  // ── Live update wiring ──

  it("kicks an async fence refresh when scheduling, and picks with the refreshed state", () => {
    mock.method(Math, "random", () => 0.9);
    let refreshes = 0;
    let state = { ...INACTIVE };
    const ctx = makeCtx();
    ctx.roamFence = {
      get: () => state,
      refresh: () => {
        refreshes += 1;
        state = FENCE; // simulates the file edit landing before the pause ends
      },
    };
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    runOneWalk(ctx, roam);
    assert.ok(refreshes >= 1, "scheduling must kick a fence refresh");
    assert.ok(ctx._appliedBounds.length > 0, "walk should run");
    const last = ctx._appliedBounds[ctx._appliedBounds.length - 1];
    assertWithinFencePixels(last, FENCE_PX, "final window");
  });
});

describe("roam fence round-2 review (#810)", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
  });

  afterEach(() => {
    mock.timers.reset();
    mock.reset();
  });

  function fenceCtx2(fenceState, overrides = {}) {
    const ctx = makeCtx(overrides);
    if (fenceState !== undefined) {
      ctx.roamFence = { get: () => fenceState, refresh: () => {} };
    }
    return ctx;
  }

  function place(ctx, x, y) {
    ctx._bounds.x = x;
    ctx._bounds.y = y;
    ctx._realBounds.x = x;
    ctx._realBounds.y = y;
  }

  function runOne(ctx, roam) {
    roam.tick();
    mock.timers.tick(8000);
    for (let i = 0; i < 4000; i += 1) {
      mock.timers.tick(16);
      if (
        ctx._stateLog.some((e) => e.type === "setState" && e.state === "idle")
      )
        break;
    }
  }

  it("keeps an active fence that does not shrink the target band (start outside)", () => {
    // Reviewer repro: .1–.9 fence on 1920×1080 encloses the whole margin band
    // (fenceShrinks=false), but the pet starts at x=0 — outside the fence's
    // 192px left edge. Axis mode must therefore force horizontal and pull the
    // pet back inside instead of walking vertically along x=0. random=0.9
    // PREFERS the vertical axis, so a horizontal walk here proves the fence
    // forced the recovery (with the old fenceRect=null bug this test walks
    // vertically and fails).
    mock.method(Math, "random", () => 0.9);
    const ctx = fenceCtx2({
      active: true,
      left: 0.1,
      top: 0.1,
      right: 0.9,
      bottom: 0.9,
    });
    place(ctx, 0, 300);
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);
    runOne(ctx, roam);
    assert.ok(ctx._appliedBounds.length > 0, "walk should run");
    for (const b of ctx._appliedBounds) {
      assert.equal(b.y, 300, "the outside coordinate (X) must be the mover");
    }
    const last = ctx._appliedBounds[ctx._appliedBounds.length - 1];
    assert.equal(last.x, 1389, "deterministic in-band target");
    assert.ok(
      last.x >= 192 && last.x + last.width <= 1728,
      "final window inside the fence",
    );
  });

  it("non-shrinking fence keeps the parent fixed minimum hop", () => {
    // Same enclosing fence, start inside: intervals equal the parent band,
    // so the adaptive threshold must NOT engage — a candidate 50px away is
    // still rejected exactly like the parent would.
    mock.method(Math, "random", () => 0.3);
    const ctx = fenceCtx2({
      active: true,
      left: 0.1,
      top: 0.1,
      right: 0.9,
      bottom: 0.9,
    });
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    runOne(ctx, roam);
    assert.ok(ctx._appliedBounds.length > 0, "normal roam still runs");
    const last = ctx._appliedBounds[ctx._appliedBounds.length - 1];
    const dx = last.x - 400;
    const dy = last.y - 300;
    assert.ok(
      Math.sqrt(dx * dx + dy * dy) >= 100,
      "target must respect the historical 100px minimum hop",
    );
  });

  it("no fence: picker geometry stays bounds-based when effective size differs", () => {
    // Reviewer repro: 400×300 work area, live bounds 100×100 but effective
    // size 200×200, axis mode. The parent picks with live bounds (band
    // x∈[60,240]) and only animates with the effective size — planning with
    // 200px would find no target and freeze the pet.
    mock.method(Math, "random", () => 0.3); // → horizontal
    const ctx = makeCtx({
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 400, height: 300 }),
      getEffectiveCurrentPixelSize: () => ({ width: 200, height: 200 }),
    });
    ctx._bounds.width = 100;
    ctx._bounds.height = 100;
    ctx._realBounds.width = 100;
    ctx._realBounds.height = 100;
    place(ctx, 100, 100);
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);
    runOne(ctx, roam);
    assert.ok(
      ctx._appliedBounds.length > 0,
      "parent-compatible picker must still find a target",
    );
    for (const b of ctx._appliedBounds) {
      assert.equal(b.y, 100, "horizontal walk holds Y");
      assert.equal(b.width, 200, "animation uses the effective size");
    }
    const last = ctx._appliedBounds[ctx._appliedBounds.length - 1];
    assert.equal(last.x, 240, "deterministic parent-band edge target");
  });

  it("no fence: a failed target search does not resolve the effective-size getter", () => {
    mock.method(Math, "random", () => 0.5);
    let effectiveSizeReads = 0;
    const ctx = makeCtx({
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 200, height: 200 }),
      getEffectiveCurrentPixelSize: () => {
        effectiveSizeReads += 1;
        return { width: 120, height: 120 };
      },
    });
    place(ctx, 35, 35);
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);
    roam.tick();
    mock.timers.tick(8000);

    assert.equal(ctx._appliedBounds.length, 0, "historical picker finds no target");
    assert.equal(effectiveSizeReads, 0, "a skipped round must not lazy-seed keep-size state");
  });

  it("a fence that alters only X does not relax the minimum hop on Y", () => {
    mock.method(Math, "random", () => 0.9); // prefer vertical
    const ctx = fenceCtx2({
      active: true,
      left: 0.15,
      top: 0,
      right: 0.8,
      bottom: 1,
    }, {
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 400, height: 300 }),
    });
    Object.assign(ctx._bounds, { x: 60, y: 45, width: 250, height: 170 });
    Object.assign(ctx._realBounds, ctx._bounds);
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);
    roam.tick();
    mock.timers.tick(8000);

    assert.equal(
      ctx._appliedBounds.length,
      0,
      "the full-range Y axis keeps the parent's 100px minimum instead of accepting a 40px hop",
    );
  });

  it("holds the round while the fence status is UNKNOWN (loader returns null)", () => {
    mock.method(Math, "random", () => 0.9);
    const ctx = fenceCtx2(null);
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(8000);
    assert.equal(
      ctx._appliedBounds.length,
      0,
      "an unconfirmed fence must not fail open to full-area roaming",
    );
    assert.ok(
      !ctx._stateLog.some((e) => e.state === "roam"),
      "pet never enters roam state",
    );
  });

  it("resumes normally once the loader confirms a state", () => {
    mock.method(Math, "random", () => 0.9);
    let state = null;
    const ctx = makeCtx();
    ctx.roamFence = {
      get: () => state,
      refresh: () => {
        state = { active: false, left: 0, top: 0, right: 1, bottom: 1 };
      },
    };
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    runOne(ctx, roam);
    assert.ok(
      ctx._appliedBounds.length > 0,
      "confirmed no-fence state roams like the parent",
    );
  });
});

describe("roam fence round-3 review (#810)", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
  });

  afterEach(() => {
    mock.timers.reset();
    mock.reset();
  });

  it("recovers from 1px outside an exact-fit corridor (forced move ignores min hop)", () => {
    // Reviewer repro: exact-fit X fence [768,888] (corridor exactly the pet's
    // width, X range collapses to the single point 768), start (767,450) —
    // 1px outside. The only legal recovery is X+1; the ordinary 24/100px
    // minimum would reject it forever and strand the pet outside.
    mock.method(Math, "random", () => 0.9);
    const ctx = makeCtx();
    ctx.roamFence = {
      get: () => ({
        active: true,
        left: 0.4,
        top: 0.4,
        right: 0.4625,
        bottom: 0.58,
      }),
      refresh: () => {},
    };
    ctx._bounds.x = 767;
    ctx._bounds.y = 450;
    ctx._realBounds.x = 767;
    ctx._realBounds.y = 450;
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.setConstrainAxis(true);
    roam.tick();
    mock.timers.tick(8000);
    for (let i = 0; i < 400; i += 1) {
      mock.timers.tick(16);
      if (
        ctx._stateLog.some((e) => e.type === "setState" && e.state === "idle")
      )
        break;
    }
    assert.ok(
      ctx._appliedBounds.length > 0,
      "the 1px recovery walk must actually run",
    );
    for (const b of ctx._appliedBounds) {
      assert.equal(b.y, 450, "recovery is horizontal only");
    }
    const last = ctx._appliedBounds[ctx._appliedBounds.length - 1];
    assert.equal(last.x, 768, "pet ends exactly inside the corridor");
  });

  it("free-direction mode also recovers from 1px outside a fully collapsed fence", () => {
    // Same stranding class without axis constraint: both candidate intervals
    // collapse to the single point (768,432) and the pet starts 1px outside.
    // The adaptive minimum (24px floor) would reject the only legal target
    // forever; a containment-recovery round accepts any non-zero step.
    mock.method(Math, "random", () => 0.9);
    const ctx = makeCtx();
    ctx.roamFence = {
      get: () => ({
        active: true,
        left: 0.4,
        top: 0.4,
        right: 0.4625,
        bottom: 0.5111,
      }),
      refresh: () => {},
    };
    ctx._bounds.x = 767;
    ctx._bounds.y = 432;
    ctx._realBounds.x = 767;
    ctx._realBounds.y = 432;
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.tick();
    mock.timers.tick(8000);
    for (let i = 0; i < 400; i += 1) {
      mock.timers.tick(16);
      if (
        ctx._stateLog.some((e) => e.type === "setState" && e.state === "idle")
      )
        break;
    }
    assert.ok(ctx._appliedBounds.length > 0, "recovery walk must run");
    const last = ctx._appliedBounds[ctx._appliedBounds.length - 1];
    assert.deepEqual(
      { x: last.x, y: last.y },
      { x: 768, y: 432 },
      "pet ends exactly inside the collapsed fence",
    );
  });
});

describe("roam fence round-4 review (#810): edge fences", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
  });

  afterEach(() => {
    mock.timers.reset();
    mock.reset();
  });

  function edgeCtx(fenceState) {
    const ctx = makeCtx();
    ctx.roamFence = { get: () => fenceState, refresh: () => {} };
    return ctx;
  }

  function run(ctx, roam) {
    roam.tick();
    mock.timers.tick(8000);
    for (let i = 0; i < 4000; i += 1) {
      mock.timers.tick(16);
      if (
        ctx._stateLog.some((e) => e.type === "setState" && e.state === "idle")
      )
        break;
    }
  }

  function within(rect, f, label) {
    assert.ok(
      rect.x >= f.left &&
        rect.x + rect.width <= f.right &&
        rect.y >= f.top &&
        rect.y + rect.height <= f.bottom,
      `${label}: (${rect.x},${rect.y}) escapes [${f.left}..${f.right}]×[${f.top}..${f.bottom}]`,
    );
  }

  // Right-edge strip: x∈[.9,1] → pixels [1728,1920], containment [1728,1800].
  // Entirely outside the historical margin band (x ≤ 1512) — reviewer repro
  // for the permanent no-roam zone. Fence must take precedence.
  const RIGHT_STRIP = { active: true, left: 0.9, top: 0.4, right: 1, bottom: 0.6 };
  const RIGHT_PX = { left: 1728, top: 432, right: 1920, bottom: 648 };

  it("right-edge strip, start inside: roams within the strip", () => {
    mock.method(Math, "random", () => 0.9);
    const ctx = edgeCtx(RIGHT_STRIP);
    ctx._bounds.x = 1750;
    ctx._bounds.y = 450;
    ctx._realBounds.x = 1750;
    ctx._realBounds.y = 450;
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    run(ctx, roam);
    assert.ok(ctx._appliedBounds.length > 0, "edge strip must not be a dead zone");
    for (const b of ctx._appliedBounds) {
      within(b, RIGHT_PX, "every applied frame");
    }
    const last = ctx._appliedBounds[ctx._appliedBounds.length - 1];
    assert.deepEqual({ x: last.x, y: last.y }, { x: 1792, y: 518 });
  });

  it("right-edge strip, start outside: walks in and stays contained at the end", () => {
    mock.method(Math, "random", () => 0.9);
    const ctx = edgeCtx(RIGHT_STRIP); // default start (400,300), far outside
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    run(ctx, roam);
    assert.ok(ctx._appliedBounds.length > 0, "recovery into the strip must run");
    const last = ctx._appliedBounds[ctx._appliedBounds.length - 1];
    within(last, RIGHT_PX, "final window");
  });

  it("dock-adjacent bottom strip works despite the margin band", () => {
    // y∈[.87,1] → pixels [940,1080], containment [940,960] — tall enough for
    // the pet but wholly below the margin band (y ≤ 798).
    mock.method(Math, "random", () => 0.9);
    const strip = { active: true, left: 0.3, top: 0.87, right: 0.7, bottom: 1 };
    const ctx = edgeCtx(strip);
    ctx._bounds.x = 600;
    ctx._bounds.y = 945;
    ctx._realBounds.x = 600;
    ctx._realBounds.y = 945;
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    run(ctx, roam);
    assert.ok(ctx._appliedBounds.length > 0, "dock strip must not be a dead zone");
    const f = { left: 576, top: 940, right: 1344, bottom: 1080 };
    for (const b of ctx._appliedBounds) {
      within(b, f, "every applied frame");
    }
  });

  it("a fence smaller than the pet holds roam entirely (documented behavior)", () => {
    mock.method(Math, "random", () => 0.9);
    const ctx = edgeCtx({ active: true, left: 0.9, top: 0.4, right: 0.94, bottom: 0.6 });
    const roam = roamModule(ctx);
    roam.setEnabled(true);
    roam.tick();
    mock.timers.tick(8000);
    mock.timers.tick(8000);
    assert.equal(
      ctx._appliedBounds.length,
      0,
      "no valid position exists — roam holds until the fence is fixed",
    );
  });
});
