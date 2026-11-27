"use strict";

// Exercises src/gravity.js against a fake window context.
const test = require("node:test");
const assert = require("node:assert");
const initGravity = require("../src/gravity");
const { measureReleaseVelocity, getThrowVelocity, advanceThrow, getSpinTurnMs, getSpinRotation } = initGravity;

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1032 };
const BOTTOM_MARGIN = 10;
const PET = 200;
const FLOOR_Y = WORK_AREA.height - PET + BOTTOM_MARGIN;
const SIDE = Math.round(PET * 0.25);
const MAX_X = WORK_AREA.x + WORK_AREA.width - PET + SIDE;

function makeCtx(y, x = 500) {
  let current = { x, y, width: PET, height: PET };
  const ctx = {
    win: { isDestroyed: () => false },
    dragLocked: false,
    miniTransitioning: false,
    miniMode: false,
    getMiniMode: () => ctx.miniMode,
    getPetWindowBounds: () => ({ ...current }),
    applyPetWindowBounds: (b) => {
      ctx.applied.push({ ...b, t: Date.now() });
      current = { ...b };
    },
    cursor: { x, y },
    moveTo: (nx, ny) => {
      current = { ...current, x: nx, y: ny };
      ctx.cursor = { x: nx, y: ny };
    },
    getEffectiveCurrentPixelSize: () => ({ width: PET, height: PET }),
    getNearestWorkArea: () => WORK_AREA,
    // Same shape as the real rest clamp: 25% side overhang, visible margin at the bottom.
    clampToScreenVisual: (cx, cy, w, h, opts) => {
      ctx.clampOptions = opts;
      const wa = opts.workArea;
      const side = Math.round(w * 0.25);
      return {
        x: Math.max(wa.x - side, Math.min(cx, wa.x + wa.width - w + side)),
        y: Math.max(wa.y, Math.min(cy, wa.y + wa.height - h + BOTTOM_MARGIN)),
      };
    },
    syncHitWin: () => { ctx.hitSyncs += 1; },
    repositionAnchoredSurfaces: () => {},
    releaseReconcileProtection: () => { ctx.releases += 1; },
    applied: [],
    rotations: [],
    rotationTimes: [],
    hitSyncs: 0,
    releases: 0,
  };
  return ctx;
}

// Gravity is off by default (the `gravity` pref), so the tests turn it on.
function makeGravity(ctx, options = {}) {
  return initGravity(ctx, {
    enabled: true,
    getCursorPoint: () => ctx.cursor,
    setRotation: (degrees) => {
      ctx.rotations.push(degrees);
      ctx.rotationTimes.push(Date.now());
    },
    ...options,
  });
}

// The throw tests run on a fake clock (setTimeout and Date mocked, gravity
// reading Date.now), so drag speeds and flight frames are exact.
function useClock(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
}

function makeClockedGravity(ctx) {
  return makeGravity(ctx, { now: () => Date.now() });
}

function fallFrom(y) {
  const ctx = makeCtx(y);
  const gravity = makeGravity(ctx);
  return new Promise((resolve) => {
    const started = gravity.startFall((landed, info) => resolve({ started, landed, info, ctx }));
    if (!started) resolve({ started, ctx });
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lastY = (ctx) => ctx.applied[ctx.applied.length - 1].y;
const lastX = (ctx) => ctx.applied[ctx.applied.length - 1].x;

function advanceFrames(t, count) {
  for (let frame = 0; frame < count; frame++) t.mock.timers.tick(16);
}

// On the clock: one (dx, dy) step every 16 ms, like Clawd's drag-move events.
function drag(t, ctx, gravity, dx, dy, steps = 6) {
  gravity.beginDrag();
  let { x, y } = ctx.getPetWindowBounds();
  for (let i = 0; i < steps; i++) {
    x += dx;
    y += dy;
    ctx.moveTo(x, y);
    gravity.recordDragSample();
    t.mock.timers.tick(16);
  }
}

// On the clock: releases and runs the frames until the landing (10 s at most).
function releaseAndLand(t, gravity) {
  let end = null;
  const started = gravity.release((landed, info) => { end = { landed, info }; });
  for (let ms = 0; started && !end && ms < 10000; ms += 16) t.mock.timers.tick(16);
  return { started, ...end };
}

test("falls with acceleration to the floor and reports the landing once", async () => {
  const ctx = makeCtx(100);
  const gravity = makeGravity(ctx);
  const ends = [];
  const landing = await new Promise((resolve) => {
    assert.strictEqual(gravity.startFall((value, info) => { ends.push(value); resolve(info); }), true);
    assert.strictEqual(gravity.isFalling(), true);
  });
  assert.deepStrictEqual(ends, [true]);
  assert.strictEqual(landing.intensity, 1, "732 px fall: full squash");
  assert.strictEqual(gravity.isFalling(), false);
  const ys = ctx.applied.map((b) => b.y);
  assert.strictEqual(ys[ys.length - 1], FLOOR_Y);
  assert.ok(ctx.applied.every((b) => b.x === 500 && b.width === PET && b.height === PET));
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] >= ys[i - 1], "never goes up");
  const firstStep = ys[1] - ys[0];
  const lastStep = ys[ys.length - 2] - ys[ys.length - 3];
  assert.ok(lastStep > firstStep * 3, `accelerates (first step ${firstStep}, last ${lastStep})`);
  assert.strictEqual(ctx.hitSyncs, ctx.applied.length);
  assert.strictEqual(ctx.releases, 1);
  assert.deepStrictEqual(ctx.rotations, [], "a straight fall does not spin");
});

test("squash scales with the drop height: light at 100 px, none at 30 px", async () => {
  const low = await fallFrom(FLOOR_Y - 100);
  assert.strictEqual(low.landed, true);
  assert.ok(low.info.intensity > 0.1 && low.info.intensity < 0.4, `100 px gave ${low.info.intensity}`);
  const tiny = await fallFrom(FLOOR_Y - 30);
  assert.strictEqual(tiny.landed, true);
  assert.strictEqual(tiny.info.intensity, 0);
});

test("uses the work area of the display where it was dropped and the user's edge pinning", () => {
  const ctx = makeCtx(100);
  const gravity = makeGravity(ctx);
  gravity.startFall(() => {});
  gravity.cancel();
  assert.strictEqual(ctx.clampOptions.workArea, WORK_AREA);
  // No override: the rest clamp applies "Allow pinning to screen edges" itself.
  assert.ok(!("allowEdgePinning" in ctx.clampOptions), "the floor follows the edge pinning setting");
});

test("edge pinning can land below the work area bottom", async () => {
  const workAreaBottom = WORK_AREA.y + WORK_AREA.height;
  const physicalFloorY = workAreaBottom + 30;
  const ctx = makeCtx(workAreaBottom - 30);
  ctx.clampToScreenVisual = (x, y) => ({ x, y: Math.min(y, physicalFloorY) });
  const gravity = makeGravity(ctx);

  const landed = await new Promise((resolve) => {
    assert.strictEqual(gravity.startFall(resolve), true);
  });

  assert.strictEqual(landed, true);
  assert.strictEqual(lastY(ctx), physicalFloorY);
});

test("already on the floor: does not fall", () => {
  const ctx = makeCtx(FLOOR_Y - 1);
  const gravity = makeGravity(ctx);
  assert.strictEqual(gravity.startFall(() => assert.fail("should not be called")), false);
  assert.strictEqual(gravity.isFalling(), false);
  assert.strictEqual(ctx.applied.length, 0);
});

test("caught mid-air: stops where it is and reports no landing", async () => {
  const ctx = makeCtx(100);
  const gravity = makeGravity(ctx);
  const ends = [];
  gravity.startFall((value, info) => ends.push(value, info));
  await wait(120);
  ctx.dragLocked = true;
  await wait(60);
  assert.deepStrictEqual(ends, [false, null]);
  const moves = ctx.applied.length;
  assert.ok(lastY(ctx) < FLOOR_Y, "stayed in the air");
  await wait(60);
  assert.strictEqual(ctx.applied.length, moves, "does not move after being caught");
});

test("size preview stops a fall before it can write the frozen size again", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const ctx = makeCtx(100);
  let previewActive = false;
  ctx.isSizePreviewActive = () => previewActive;
  const gravity = initGravity(ctx, { enabled: true, now: Date.now });
  const ends = [];
  assert.strictEqual(gravity.startFall((landed, info) => ends.push([landed, info])), true);
  t.mock.timers.tick(16);
  assert.strictEqual(ctx.applied.length, 1);

  previewActive = true;
  t.mock.timers.tick(16);
  assert.deepStrictEqual(ends, [[false, null]]);
  assert.strictEqual(gravity.isFalling(), false);
  assert.strictEqual(ctx.applied.length, 1);
  t.mock.timers.tick(64);
  assert.strictEqual(ctx.applied.length, 1);
});

test("suspend stops writing and resumeSuspended falls from the paused position", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const ctx = makeCtx(100);
  const gravity = initGravity(ctx, { enabled: true, now: Date.now });
  const ends = [];
  gravity.setFallEndHandler((landed) => ends.push(landed));
  assert.strictEqual(gravity.startFall(), true);
  advanceFrames(t, 8);
  const moves = ctx.applied.length;
  const pausedY = lastY(ctx);
  assert.ok(pausedY > 100 && pausedY < FLOOR_Y);

  gravity.suspend();
  gravity.suspend();
  assert.strictEqual(gravity.isFalling(), false);
  assert.deepStrictEqual(ends, [false]);
  t.mock.timers.tick(400);
  assert.strictEqual(ctx.applied.length, moves);

  assert.strictEqual(gravity.resumeSuspended(), true);
  t.mock.timers.tick(16);
  assert.strictEqual(ctx.applied.length, moves + 1);
  assert.strictEqual(lastY(ctx), pausedY);
  advanceFrames(t, 60);
  assert.strictEqual(lastY(ctx), FLOOR_Y);
  assert.deepStrictEqual(ends, [false, true]);
});

test("a new fall clears a suspended fall without interrupting the new one", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const ctx = makeCtx(100);
  const gravity = initGravity(ctx, { enabled: true, now: Date.now });
  const newEnds = [];
  assert.strictEqual(gravity.startFall(), true);
  gravity.suspend();
  assert.strictEqual(gravity.startFall((landed) => newEnds.push(landed)), true);

  assert.strictEqual(gravity.resumeSuspended(), false);
  assert.deepStrictEqual(newEnds, []);
  advanceFrames(t, 60);
  assert.strictEqual(lastY(ctx), FLOOR_Y);
  assert.deepStrictEqual(newEnds, [true]);
});

test("a press catches a suspended fall and releasing it starts a new fall", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const ctx = makeCtx(100);
  const gravity = initGravity(ctx, { enabled: true, now: Date.now });
  assert.strictEqual(gravity.startFall(), true);
  gravity.suspend();

  ctx.dragLocked = true;
  gravity.beginDrag();
  assert.strictEqual(gravity.resumeSuspended(), false);
  t.mock.timers.tick(400);
  assert.strictEqual(ctx.applied.length, 0);

  ctx.dragLocked = false;
  assert.strictEqual(gravity.endPress(), true);
  assert.strictEqual(gravity.isFalling(), true);
  assert.strictEqual(gravity.resumeSuspended(), false);
  advanceFrames(t, 60);
  assert.strictEqual(lastY(ctx), FLOOR_Y);
});

test("cancel clears a suspended fall and leaves the pet in place", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const ctx = makeCtx(100);
  const gravity = initGravity(ctx, { enabled: true, now: Date.now });
  assert.strictEqual(gravity.startFall(), true);
  t.mock.timers.tick(16);
  const moves = ctx.applied.length;
  gravity.suspend();

  gravity.cancel();
  assert.strictEqual(gravity.resumeSuspended(), false);
  t.mock.timers.tick(400);
  assert.strictEqual(ctx.applied.length, moves);
});

test("suspend does not schedule a resume when the pet is not falling", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const ctx = makeCtx(100);
  const gravity = initGravity(ctx, { enabled: true, now: Date.now });

  gravity.suspend();
  assert.strictEqual(gravity.resumeSuspended(), false);
  t.mock.timers.tick(400);
  assert.strictEqual(ctx.applied.length, 0);
});

test("mini mode: does not fall", () => {
  const ctx = makeCtx(100);
  ctx.miniMode = true;
  const gravity = makeGravity(ctx);
  assert.strictEqual(gravity.startFall(() => {}), false);
});

test("off by default: it does not fall", () => {
  const ctx = makeCtx(100);
  const gravity = initGravity(ctx);
  assert.strictEqual(gravity.isEnabled(), false);
  assert.strictEqual(gravity.startFall(() => assert.fail("should not fall")), false);
  assert.strictEqual(ctx.applied.length, 0);
});

test("turned off: it does not fall", () => {
  const ctx = makeCtx(100);
  const gravity = makeGravity(ctx);
  gravity.setEnabled(false);
  assert.strictEqual(gravity.isEnabled(), false);
  assert.strictEqual(gravity.startFall(() => assert.fail("should not fall")), false);
  assert.strictEqual(ctx.applied.length, 0);
});

test("turning off mid-fall stops it where it is; turning back on with the pet in the air makes it fall", async () => {
  const ctx = makeCtx(100);
  const gravity = makeGravity(ctx);
  const ends = [];
  gravity.setFallEndHandler((landed) => ends.push(landed));
  gravity.startFall();
  await wait(150);
  gravity.setEnabled(false);
  assert.deepStrictEqual(ends, [false]);
  const stoppedAt = lastY(ctx);
  assert.ok(stoppedAt < FLOOR_Y, "stopped in the air");
  await wait(60);
  assert.strictEqual(lastY(ctx), stoppedAt);
  const landed = new Promise((resolve) => gravity.setFallEndHandler((value) => resolve(value)));
  gravity.setEnabled(true);
  assert.strictEqual(gravity.isFalling(), true, "turned back on and already falling");
  assert.strictEqual(await landed, true);
  assert.strictEqual(lastY(ctx), FLOOR_Y);
});

test("a new placement takes over a running fall: the pet falls from the new spot", async () => {
  const ctx = makeCtx(100, 500);
  const gravity = makeGravity(ctx);
  const firstEnds = [];
  gravity.startFall((landed) => firstEnds.push(landed));
  await wait(100);
  // Send to Display: the pet is centered on the other display mid-fall.
  ctx.applyPetWindowBounds({ x: 1200, y: 50, width: PET, height: PET });
  const placedAt = ctx.applied.length;
  const landed = new Promise((resolve) => {
    assert.strictEqual(gravity.startFall((value) => resolve(value)), true);
  });
  assert.deepStrictEqual(firstEnds, [false], "the old fall ends at once");
  assert.strictEqual(await landed, true);
  const after = ctx.applied.slice(placedAt);
  assert.ok(after.length > 0);
  assert.ok(after.every((b) => b.x === 1200), "never pulled back to the old path");
  assert.strictEqual(lastY(ctx), FLOOR_Y);
});

test("a click on a falling pet: caught at the press, it falls again when the press ends", async () => {
  const ctx = makeCtx(100);
  const gravity = makeGravity(ctx);
  gravity.startFall();
  await wait(100);
  gravity.beginDrag();
  assert.strictEqual(gravity.isFalling(), false, "caught at the press");
  const caughtAt = lastY(ctx);
  assert.ok(caughtAt < FLOOR_Y);
  // No drag-end follows a click; the end of the press lets it fall.
  const landed = new Promise((resolve) => gravity.setFallEndHandler((value) => resolve(value)));
  assert.strictEqual(gravity.endPress(), true);
  assert.strictEqual(await landed, true);
  assert.strictEqual(lastY(ctx), FLOOR_Y);
});

test("a press on a pet that was not falling leaves it where it is", () => {
  const ctx = makeCtx(100);
  const gravity = makeGravity(ctx);
  gravity.beginDrag();
  assert.strictEqual(gravity.endPress(), false);
  assert.strictEqual(gravity.isFalling(), false);
  assert.strictEqual(ctx.applied.length, 0);
});

const s = (x, y, t) => ({ x, y, t });
// Six samples 16 ms apart, `px` apart horizontally; the release comes 5 ms after the last one.
const line = (px) => [0, 1, 2, 3, 4, 5].map((i) => s(i * px, 0, i * 16));

test("measurement: the fastest stretch of the last 120 ms; VS Code's 80 ms grace", () => {
  assert.strictEqual(Math.round(measureReleaseVelocity(line(32), 85).speed), 2000);
  // A flick at 3000 px/s that slows to ~300 px/s before the release: the peak counts, not the average.
  const flick = [s(0, 0, 0), s(48, 0, 16), s(96, 0, 32), s(144, 0, 48), s(149, 0, 64), s(154, 0, 80), s(159, 0, 96)];
  assert.strictEqual(Math.round(measureReleaseVelocity(flick, 100).speed), 3000);
  assert.strictEqual(measureReleaseVelocity(line(32), 80 + 81), null, "mouse still for more than 80 ms before the release");
  assert.strictEqual(measureReleaseVelocity([s(0, 0, 0)], 5), null, "a single sample");
  // An old peak, outside the 120 ms window, does not count.
  const old = [s(0, 0, 0), s(200, 0, 16), s(201, 0, 150), s(202, 0, 166), s(203, 0, 182)];
  assert.ok(measureReleaseVelocity(old, 185).speed < 200);
});

test("soft cap: no throw below 650 px/s; above it, 3200 × tanh(v/3200)", () => {
  const at = (px) => getThrowVelocity(line(px), 85);
  assert.strictEqual(at(8), null, "500 px/s");
  const v1000 = at(16).x;
  const v2000 = at(32).x;
  const v4000 = at(64).x;
  const v10000 = at(160).x;
  assert.ok(Math.abs(v1000 - 968.7) < 1, `1000 px/s → ${v1000}`);
  assert.ok(Math.abs(v2000 - 1774.7) < 1, `2000 px/s → ${v2000}`);
  assert.ok(Math.abs(v4000 - 2714.5) < 1, `4000 px/s → ${v4000}`);
  assert.ok(v10000 > 3150 && v10000 < 3200, `10000 px/s stays below 3200 (${v10000})`);
  assert.ok(v2000 > v1000 * 1.7 && v4000 > v2000 * 1.4, "still varies with the mouse speed");
  const diagonal = getThrowVelocity([0, 1, 2, 3, 4, 5].map((i) => s(i * 16, -i * 16, i * 16)), 85);
  assert.ok(Math.abs(diagonal.x + diagonal.y) < 1e-9, "keeps the direction of the gesture");
});

test("flight step: stops at the wall and reports it; the ceiling returns 20% of the speed", () => {
  const walls = { minX: 0, maxX: 100, minY: 0 };
  const wall = advanceThrow({ x: 90, y: 50, vx: 1000, vy: 0 }, 32, walls);
  assert.strictEqual(wall.wall, "right");
  assert.strictEqual(wall.x, 100);
  assert.strictEqual(wall.vx, 1000, "the loop reverses it, after the pause at the wall");
  assert.ok(Math.abs(wall.y - 50.14) < 0.01, `drops only for the time it takes to reach the wall (${wall.y})`);
  const ceiling = advanceThrow({ x: 50, y: 5, vx: 0, vy: -1000 }, 32, walls);
  assert.strictEqual(ceiling.y, 0);
  assert.ok(Math.abs(ceiling.vy - 182.08) < 0.01, `ceiling: ${ceiling.vy}`);
  const free = advanceThrow({ x: 50, y: 50, vx: -500, vy: 0 }, 16, walls);
  assert.strictEqual(free.wall, null);
});

test("throw to the right: hits the wall, comes back slowly and lands", (t) => {
  useClock(t);
  const ctx = makeCtx(300, MAX_X - 470);
  const gravity = makeClockedGravity(ctx);
  drag(t, ctx, gravity, 40, 0);
  const result = releaseAndLand(t, gravity);
  assert.strictEqual(result.started, true);
  assert.strictEqual(result.landed, true);
  const frames = ctx.applied;
  const xs = frames.map((b) => b.x);
  const hit = xs.indexOf(MAX_X);
  assert.ok(hit >= 2, `reached the right wall (${MAX_X}) after flying; the max was ${Math.max(...xs)}`);
  assert.ok(xs.every((x) => x <= MAX_X), "does not go through the wall");
  const back = frames.slice(hit + 1).filter((f) => f.x < MAX_X);
  assert.ok(back.length >= 3, "came back from the wall");
  const speedIn = (frames[hit - 1].x - frames[hit - 2].x) / (frames[hit - 1].t - frames[hit - 2].t);
  const speedBack = (back[0].x - back[2].x) / (back[2].t - back[0].t);
  const ratio = speedBack / speedIn;
  assert.ok(ratio > 0.1 && ratio < 0.35, `comes back with ~20% of the speed (${ratio.toFixed(2)})`);
  assert.strictEqual(lastY(ctx), FLOOR_Y);
  assert.ok(result.info.intensity > 0);
  assert.ok(ctx.rotations.includes(90), "turned 90° to face the right wall");
  const afterWall = ctx.rotations.slice(ctx.rotations.indexOf(90));
  assert.ok(afterWall.every((r) => r >= 0 && r <= 90), "after the wall it only straightens up");
  assert.strictEqual(ctx.rotations[ctx.rotations.length - 1], 0, "landed upright");
});

test("edge pinning can put the walls and the top outside the work area", (t) => {
  useClock(t);
  // Pinned rest clamp wider than the work area by more than the pet size,
  // as with a side Dock and a small pet.
  const OVERHANG = 500;
  const TOP = -300;
  const pinned = (ctx) => {
    ctx.clampToScreenVisual = (x, y, w) => ({
      x: Math.max(WORK_AREA.x - OVERHANG, Math.min(x, WORK_AREA.x + WORK_AREA.width - w + OVERHANG)),
      y: Math.max(TOP, Math.min(y, FLOOR_Y)),
    });
    return ctx;
  };

  const side = pinned(makeCtx(300, 1500));
  const sideGravity = makeClockedGravity(side);
  drag(t, side, sideGravity, 40, 0);
  assert.strictEqual(releaseAndLand(t, sideGravity).landed, true);
  const maxX = WORK_AREA.width - PET + OVERHANG;
  assert.strictEqual(Math.max(...side.applied.map((b) => b.x)), maxX, "reached the pinned right wall");

  const up = pinned(makeCtx(400, 900));
  const upGravity = makeClockedGravity(up);
  drag(t, up, upGravity, 0, -50);
  assert.strictEqual(releaseAndLand(t, upGravity).landed, true);
  assert.strictEqual(Math.min(...up.applied.map((b) => b.y)), TOP, "reached the pinned top");
});

test("throw up from the floor: takes off and lands back", (t) => {
  useClock(t);
  // The drag ends right at the floor, still moving up.
  const ctx = makeCtx(FLOOR_Y + 240, 900);
  const gravity = makeClockedGravity(ctx);
  drag(t, ctx, gravity, 0, -40);
  assert.strictEqual(ctx.getPetWindowBounds().y, FLOOR_Y);
  const result = releaseAndLand(t, gravity);
  assert.strictEqual(result.started, true, "a plain drop from here would not start");
  assert.strictEqual(result.landed, true);
  assert.ok(Math.min(...ctx.applied.map((b) => b.y)) < FLOOR_Y - 300, "rose well above the floor");
  assert.strictEqual(lastY(ctx), FLOOR_Y);
});

test("spin pace by angle: straight up is the slowest, sideways the fastest", () => {
  assert.strictEqual(getSpinTurnMs({ x: 0, y: -2000 }), 1100);
  assert.strictEqual(getSpinTurnMs({ x: 2000, y: 0 }), 600);
  const diagonal = getSpinTurnMs({ x: 1500, y: -1500 });
  assert.ok(Math.abs(diagonal - 746) < 1, `45°: ${diagonal} ms`);
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  assert.ok(near(getSpinTurnMs({ x: -1500, y: -1500 }), diagonal), "to the left, the same pace");
  assert.ok(near(getSpinTurnMs({ x: 1500, y: 1500 }), diagonal), "downward too");
  assert.ok(near(getSpinTurnMs({ x: 300, y: -300 }), diagonal), "the throw strength does not change the pace");
  const steep = getSpinTurnMs({ x: 500, y: -2000 });
  assert.ok(steep < 1100 && steep > diagonal, `nearly straight (14°): ${steep} ms`);
});

test("one turn: fastest at the start, slowing down until upright", () => {
  assert.strictEqual(getSpinRotation(1, 0), 0);
  assert.ok(Math.abs(getSpinRotation(1, 0.5) - 254.56) < 0.01, "half the time, 71% of the turn");
  assert.ok(getSpinRotation(1, 0.9) > 355, "the last 10% of the time is only ~4°");
  assert.strictEqual(getSpinRotation(1, 1), 360);
  assert.strictEqual(getSpinRotation(1, 2), 360, "never goes past one turn");
  assert.ok(Math.abs(getSpinRotation(-1, 0.5) + 254.56) < 0.01, "to the left it spins the other way");
});

// Every angle that went back to 0 on landing had finished the turn (≥ 340°) or was nearly upright.
function assertNoSnap(rotations) {
  rotations.forEach((r, i) => {
    if (r !== 0 || i === 0) return;
    const before = Math.abs(rotations[i - 1]);
    assert.ok(before >= 340 || before <= 25, `went back to 0 mid-turn (from ${rotations[i - 1]}°)`);
  });
}

// From the release until past half a turn (180°), in ms.
function halfTurnMs(t, ctx, gravity) {
  const releasedAt = Date.now();
  assert.strictEqual(releaseAndLand(t, gravity).landed, true);
  const i = ctx.rotations.findIndex((r) => Math.abs(r) >= 180);
  assert.ok(i >= 0, "went past half a turn");
  return ctx.rotationTimes[i] - releasedAt;
}

test("straight up spins slower than at 45°", (t) => {
  useClock(t);
  const up = makeCtx(800, 900);
  const upGravity = makeClockedGravity(up);
  drag(t, up, upGravity, 0, -40);
  const upMs = halfTurnMs(t, up, upGravity);
  assert.ok(Math.max(...up.rotations) >= 340, "straight up also does the full turn");

  const diagonal = makeCtx(800, 300);
  const diagonalGravity = makeClockedGravity(diagonal);
  drag(t, diagonal, diagonalGravity, 30, -30);
  const diagonalMs = halfTurnMs(t, diagonal, diagonalGravity);
  assert.ok(upMs > diagonalMs * 1.25, `half turn: straight up ${upMs} ms, 45° ${diagonalMs} ms`);
});

test("throw up and sideways: a single turn, landing upright", (t) => {
  useClock(t);
  const ctx = makeCtx(700, 300);
  const gravity = makeClockedGravity(ctx);
  drag(t, ctx, gravity, 30, -40);
  const result = releaseAndLand(t, gravity);
  assert.strictEqual(result.landed, true);
  const maxSpin = Math.max(...ctx.rotations);
  assert.ok(maxSpin >= 300 && maxSpin <= 360, `one turn (${maxSpin}°)`);
  assert.ok(ctx.rotations.every((r) => r >= 0), "in one direction only");
  assert.strictEqual(ctx.rotations[ctx.rotations.length - 1], 0, "landed upright");
  assertNoSnap(ctx.rotations);
});

test("a straight sideways throw also does one turn, in the direction of the gesture", (t) => {
  useClock(t);
  const ctx = makeCtx(300, 1700);
  const gravity = makeClockedGravity(ctx);
  drag(t, ctx, gravity, -40, 0);
  assert.strictEqual(releaseAndLand(t, gravity).landed, true);
  const minSpin = Math.min(...ctx.rotations);
  assert.ok(minSpin <= -300 && minSpin >= -360, `one turn to the left (${minSpin}°)`);
  assert.strictEqual(ctx.rotations[ctx.rotations.length - 1], 0);
  assertNoSnap(ctx.rotations);
});

test("short flight: no spin near the floor; a medium flight finishes the turn by the landing", (t) => {
  useClock(t);
  const low = makeCtx(FLOOR_Y - 150);
  const lowGravity = makeClockedGravity(low);
  drag(t, low, lowGravity, 40, 0);
  assert.strictEqual(releaseAndLand(t, lowGravity).landed, true);
  assert.deepStrictEqual(low.rotations, [], "0.33 s flight: the turn would take under 450 ms");

  const mid = makeCtx(FLOOR_Y - 300);
  const midGravity = makeClockedGravity(mid);
  drag(t, mid, midGravity, 40, 0);
  assert.strictEqual(releaseAndLand(t, midGravity).landed, true);
  assert.ok(Math.max(...mid.rotations) >= 340, "did the full turn");
  assertNoSnap(mid.rotations);
});

test("caught mid-air while spinning: back upright at once", (t) => {
  useClock(t);
  const ctx = makeCtx(700, 300);
  const gravity = makeClockedGravity(ctx);
  drag(t, ctx, gravity, 30, -40);
  gravity.release(() => {});
  advanceFrames(t, 8);
  assert.ok(ctx.rotations.some((r) => r !== 0), "was spinning");
  ctx.dragLocked = true;
  advanceFrames(t, 2);
  assert.strictEqual(gravity.isFalling(), false);
  assert.strictEqual(ctx.rotations[ctx.rotations.length - 1], 0);
});

test("a throw paused by a display change resumes upright, as a plain drop", (t) => {
  useClock(t);
  const ctx = makeCtx(700, 300);
  const gravity = makeClockedGravity(ctx);
  drag(t, ctx, gravity, 30, -40);
  gravity.release(() => {});
  advanceFrames(t, 8);
  assert.ok(ctx.rotations.some((r) => r !== 0), "was spinning");
  gravity.suspend();
  assert.strictEqual(ctx.rotations[ctx.rotations.length - 1], 0, "upright while paused");
  const spins = ctx.rotations.length;
  const pausedAt = ctx.applied.length;
  const pausedX = lastX(ctx);
  const ends = [];
  gravity.setFallEndHandler((landed) => ends.push(landed));
  assert.strictEqual(gravity.resumeSuspended(), true);
  advanceFrames(t, 120);
  assert.deepStrictEqual(ends, [true]);
  assert.ok(ctx.applied.slice(pausedAt).every((b) => b.x === pausedX), "falls straight down");
  assert.strictEqual(ctx.rotations.length, spins, "no spin after the pause");
  assert.strictEqual(lastY(ctx), FLOOR_Y);
});

test("a drag that catches a falling pet throws it: the drag-end throw takes over the press fall", (t) => {
  useClock(t);
  const ctx = makeCtx(100, 300);
  const gravity = makeClockedGravity(ctx);
  const firstEnds = [];
  gravity.startFall((landed) => firstEnds.push(landed));
  advanceFrames(t, 6);
  drag(t, ctx, gravity, 40, 0);
  assert.deepStrictEqual(firstEnds, [false], "caught by the drag");
  // drag-lock(false) comes before drag-end: the press fall starts, then the throw takes over.
  const pressEnds = [];
  gravity.setFallEndHandler((landed) => pressEnds.push(landed));
  assert.strictEqual(gravity.endPress(), true);
  const releasedX = ctx.getPetWindowBounds().x;
  const result = releaseAndLand(t, gravity);
  assert.strictEqual(result.started, true);
  assert.deepStrictEqual(pressEnds, [false], "the press fall ended at once");
  assert.strictEqual(result.landed, true);
  assert.ok(Math.max(...ctx.applied.map((b) => b.x)) > releasedX + 300, "flew sideways");
  assert.strictEqual(lastY(ctx), FLOOR_Y);
});

test("a new press drops the samples of a drag that got no release", (t) => {
  useClock(t);
  const ctx = makeCtx(300);
  const gravity = makeClockedGravity(ctx);
  drag(t, ctx, gravity, 40, 0);
  gravity.beginDrag();
  t.mock.timers.tick(16);
  const pressedX = ctx.getPetWindowBounds().x;
  assert.strictEqual(releaseAndLand(t, gravity).landed, true);
  assert.ok(ctx.applied.every((b) => b.x === pressedX), "falls straight down, no throw");
});

test("gravity off: a drag does not read the cursor", () => {
  let reads = 0;
  const ctx = makeCtx(100);
  const gravity = initGravity(ctx, { getCursorPoint: () => { reads += 1; return { x: 0, y: 0 }; } });
  gravity.beginDrag();
  gravity.recordDragSample();
  gravity.recordDragSample();
  assert.strictEqual(gravity.release(() => assert.fail("should not fall")), false);
  assert.strictEqual(reads, 0);
});

test("slow release or a still mouse: it just falls, with no throw", (t) => {
  useClock(t);
  const slow = makeCtx(300);
  const slowGravity = makeClockedGravity(slow);
  drag(t, slow, slowGravity, 4, 0);
  const startX = slow.getPetWindowBounds().x;
  assert.strictEqual(releaseAndLand(t, slowGravity).landed, true);
  assert.ok(slow.applied.every((b) => b.x === startX), "slow: falls straight down");

  const parked = makeCtx(300);
  const parkedGravity = makeClockedGravity(parked);
  drag(t, parked, parkedGravity, 40, 0);
  t.mock.timers.tick(120);
  const parkedX = parked.getPetWindowBounds().x;
  assert.strictEqual(releaseAndLand(t, parkedGravity).landed, true);
  assert.ok(parked.applied.every((b) => b.x === parkedX), "stopped before the release: falls straight down");
});
