"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");

const initGravity = require("../src/gravity");
const { getFootRestInset } = require("../src/visible-margins");

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 };
const PET = { width: 120, height: 120 };
// Window y that puts the visual feet exactly on the work-area floor.
const FLOOR_Y = WORK_AREA.y + WORK_AREA.height - PET.height + getFootRestInset(PET.height);

function makeCtx(overrides = {}) {
  const bounds = { x: 400, y: 300, width: PET.width, height: PET.height };
  const appliedBounds = [];
  const rendererLog = [];
  const standingLog = [];
  let flushes = 0;
  const ctx = {
    win: { isDestroyed: () => false },
    getPetWindowBounds() { return { ...bounds }; },
    applyPetWindowBounds(next) {
      appliedBounds.push({ ...next });
      bounds.x = next.x;
      bounds.y = next.y;
      bounds.width = next.width;
      bounds.height = next.height;
    },
    getEffectiveCurrentPixelSize: () => ({ ...PET }),
    getNearestWorkArea: () => ({ ...WORK_AREA }),
    getMiniMode: () => false,
    miniTransitioning: false,
    isDragLocked: () => ctx._dragLocked,
    _dragLocked: false,
    syncHitWin() {},
    repositionAnchoredSurfaces() {},
    repositionBubbles() {},
    reassertWinTopmost() {},
    flushRuntimeStateToPrefs() { flushes += 1; },
    sendToRenderer(channel, payload) { rendererLog.push([channel, payload]); },
    getLedges: () => ctx._ledges,
    _ledges: [],
    setStandingLedge(ledge) { standingLog.push(ledge); },
    isImeEditingActive: () => false,
    _bounds: bounds,
    _appliedBounds: appliedBounds,
    _rendererLog: rendererLog,
    _standingLog: standingLog,
    get _flushes() { return flushes; },
  };
  Object.assign(ctx, overrides);
  return ctx;
}

// Advance mocked time in sim-frame steps until the fall settles (or the
// iteration budget proves it never does).
function runSim(gravity, maxFrames = 600) {
  for (let i = 0; i < maxFrames && gravity.falling; i += 1) {
    mock.timers.tick(16);
  }
  return !gravity.falling;
}

describe("gravity module", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
  });

  afterEach(() => {
    mock.timers.reset();
    mock.reset();
  });

  it("a mid-air release falls and settles with the feet on the floor", () => {
    const ctx = makeCtx();
    const gravity = initGravity(ctx);
    assert.strictEqual(gravity.onDragEnd(), true, "fall starts");
    assert.strictEqual(gravity.falling, true);
    assert.ok(runSim(gravity), "sim settles");
    assert.strictEqual(ctx._bounds.y, FLOOR_Y);
    assert.strictEqual(ctx._flushes, 1, "gravity flushes prefs once on settle");
    assert.strictEqual(ctx._standingLog[ctx._standingLog.length - 1], null);
  });

  it("a release with the feet already on the floor is a no-op", () => {
    const ctx = makeCtx();
    ctx._bounds.y = FLOOR_Y;
    const gravity = initGravity(ctx);
    assert.strictEqual(gravity.onDragEnd(), false);
    assert.strictEqual(gravity.falling, false);
    assert.strictEqual(ctx._appliedBounds.length, 0);
  });

  it("a thrown pet keeps the gesture's horizontal velocity", () => {
    const ctx = makeCtx();
    const gravity = initGravity(ctx);
    // Rightward drag: ~625 px/s sampled over four move events.
    for (const x of [100, 110, 120, 130]) {
      ctx._bounds.x = x;
      gravity.onDragMove();
      mock.timers.tick(16);
    }
    assert.strictEqual(gravity.onDragEnd(), true);
    assert.ok(runSim(gravity), "sim settles");
    assert.ok(ctx._bounds.x > 400, `drifted right of the release (x=${ctx._bounds.x})`);
    assert.strictEqual(ctx._bounds.y, FLOOR_Y);
  });

  it("a parked pointer (stale samples) drops straight down instead of throwing", () => {
    const ctx = makeCtx();
    const gravity = initGravity(ctx);
    for (const x of [100, 110, 120, 130]) {
      ctx._bounds.x = x;
      gravity.onDragMove();
      mock.timers.tick(16);
    }
    mock.timers.tick(200); // hold still past THROW_STALE_MS
    assert.strictEqual(gravity.onDragEnd(), true);
    assert.ok(runSim(gravity), "sim settles");
    assert.ok(Math.abs(ctx._bounds.x - 130) <= 2, `fell straight (x=${ctx._bounds.x})`);
  });

  it("swept landing settles on a window ledge and adopts it", () => {
    const ledge = { id: 7, pid: 42, x: 300, x2: 900, y: 800 };
    const ctx = makeCtx({ _ledges: [ledge] });
    const gravity = initGravity(ctx);
    assert.strictEqual(gravity.onDragEnd(), true);
    assert.ok(runSim(gravity), "sim settles");
    assert.strictEqual(ctx._bounds.y, ledge.y - PET.height + getFootRestInset(PET.height));
    const standing = ctx._standingLog[ctx._standingLog.length - 1];
    assert.ok(standing && standing.id === 7, "settled standing on the ledge");
  });

  it("falls past a ledge without enough horizontal footing", () => {
    // Ledge ends well left of the pet: overlap below MIN_LEDGE_OVERLAP.
    const ledge = { id: 7, pid: 42, x: 0, x2: 430, y: 800 };
    const ctx = makeCtx({ _ledges: [ledge] });
    const gravity = initGravity(ctx);
    assert.strictEqual(gravity.onDragEnd(), true);
    assert.ok(runSim(gravity), "sim settles");
    assert.strictEqual(ctx._bounds.y, FLOOR_Y, "landed on the floor, not the ledge");
  });

  it("a new drag-lock catches the pet mid-air and cancels the sim", () => {
    const ctx = makeCtx();
    const gravity = initGravity(ctx);
    assert.strictEqual(gravity.onDragEnd(), true);
    mock.timers.tick(16 * 3);
    const framesSoFar = ctx._appliedBounds.length;
    assert.ok(framesSoFar > 0, "sim was moving the window");
    ctx._dragLocked = true;
    mock.timers.tick(16 * 5);
    assert.strictEqual(gravity.falling, false);
    assert.strictEqual(ctx._appliedBounds.length, framesSoFar, "no writes after the catch");
  });

  it("dropIfAirborne: floor is a no-op, mid-air falls, a flush ledge is adopted", () => {
    const ledge = { id: 3, pid: 9, x: 300, x2: 900, y: 800 };
    const ctx = makeCtx({ _ledges: [ledge] });
    const gravity = initGravity(ctx);

    ctx._bounds.y = FLOOR_Y;
    assert.strictEqual(gravity.dropIfAirborne(), false, "grounded pet stays put");

    // Feet exactly on the ledge: adopt the perch instead of falling through.
    ctx._bounds.y = ledge.y - PET.height + getFootRestInset(PET.height);
    assert.strictEqual(gravity.dropIfAirborne(), false);
    const standing = ctx._standingLog[ctx._standingLog.length - 1];
    assert.ok(standing && standing.id === 3, "adopted the ledge");

    ctx._bounds.y = 300;
    assert.strictEqual(gravity.dropIfAirborne(), true, "hovering pet falls");
    assert.ok(runSim(gravity), "sim settles");
  });

  it("setEnabled(false) cancels an in-flight fall and blocks new ones", () => {
    const ctx = makeCtx();
    const gravity = initGravity(ctx);
    assert.strictEqual(gravity.onDragEnd(), true);
    gravity.setEnabled(false);
    assert.strictEqual(gravity.falling, false);
    assert.strictEqual(gravity.onDragEnd(), false);
    assert.strictEqual(gravity.dropIfAirborne(), false);
  });
});
