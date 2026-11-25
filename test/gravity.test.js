"use strict";

// Exercises src/gravity.js against a fake context (real time, a few seconds).
const test = require("node:test");
const assert = require("node:assert");
const initGravity = require("../src/gravity");

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1032 };
const BOTTOM_MARGIN = 10;
const PET = 200;
const FLOOR_Y = WORK_AREA.height - PET + BOTTOM_MARGIN;

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
      ctx.applied.push({ ...b, t: performance.now() });
      current = { ...b };
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
    hitSyncs: 0,
    releases: 0,
  };
  return ctx;
}

// Gravity is off by default (the `gravity` pref), so the tests turn it on.
function makeGravity(ctx) {
  return initGravity(ctx, { enabled: true });
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
