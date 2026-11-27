"use strict";

// Exercises src/gravity.js against a fake window context.
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

function advanceFrames(t, count) {
  for (let frame = 0; frame < count; frame++) t.mock.timers.tick(16);
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
