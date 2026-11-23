"use strict";

// Exercises src/gravity.js against a fake context (real time, a few seconds).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const initGravity = require("../src/gravity");
const { i18n, SUPPORTED_LANGS, createTranslator } = require("../src/i18n");

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

// Gravity is off by default, so the tests start from a saved "on" switch;
// null leaves no file, as on a first run.
function tempFloorFile(saved = { version: 1, enabled: true, floors: {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-gravity-test-"));
  const file = path.join(dir, "gravity-floor.json");
  if (saved) fs.writeFileSync(file, JSON.stringify(saved));
  return file;
}

function makeGravity(ctx, floorFile = tempFloorFile()) {
  return initGravity(ctx, {
    floorFile,
    getDisplayKey: () => "test-display",
  });
}

function fallFrom(y, floorFile) {
  const ctx = makeCtx(y);
  const gravity = makeGravity(ctx, floorFile);
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

test("Shift on release saves the height above the taskbar, and the shelf survives a restart", async () => {
  const floorFile = tempFloorFile();
  const shelfY = FLOOR_Y - 300;
  const setter = makeGravity(makeCtx(shelfY), floorFile);
  assert.strictEqual(setter.setFloorHere(), true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(floorFile, "utf8")).floors, {
    "test-display": { heightAboveTaskbar: 300 },
  });
  const above = await fallFrom(shelfY - 300, floorFile);
  assert.strictEqual(above.landed, true);
  assert.strictEqual(lastY(above.ctx), shelfY, "from above it lands on the shelf");
});

test("below the shelf it falls to the taskbar; on top of it, it does not fall", async () => {
  const floorFile = tempFloorFile();
  const shelfY = FLOOR_Y - 300;
  makeGravity(makeCtx(shelfY), floorFile).setFloorHere();
  const below = await fallFrom(shelfY + 100, floorFile);
  assert.strictEqual(below.landed, true);
  assert.strictEqual(lastY(below.ctx), FLOOR_Y);
  const onShelf = await fallFrom(shelfY + 1, floorFile);
  assert.strictEqual(onShelf.started, false);
});

test("Shift on release at the taskbar clears the shelf", () => {
  const floorFile = tempFloorFile();
  makeGravity(makeCtx(FLOOR_Y - 300), floorFile).setFloorHere();
  const gravity = makeGravity(makeCtx(FLOOR_Y), floorFile);
  assert.strictEqual(gravity.hasCustomFloor(), true);
  gravity.setFloorHere();
  assert.strictEqual(gravity.hasCustomFloor(), false);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(floorFile, "utf8")).floors, {});
});

test("the reset-floor menu item clears the shelf and the pet on it falls", async () => {
  const floorFile = tempFloorFile();
  const shelfY = FLOOR_Y - 300;
  const ctx = makeCtx(shelfY);
  const gravity = makeGravity(ctx, floorFile);
  gravity.setFloorHere();
  const reset = (g) => g.buildMenuItem().submenu.find((i) => i.label === i18n.en.gravityResetFloor);
  assert.strictEqual(reset(gravity).enabled, true);
  const landed = new Promise((resolve) => gravity.setFallEndHandler((value) => resolve(value)));
  reset(gravity).click();
  assert.strictEqual(await landed, true);
  assert.strictEqual(lastY(ctx), FLOOR_Y);
  assert.strictEqual(reset(gravity).enabled, false);
});

test("the menu is translated into every supported language, English by default", () => {
  const labels = (item) => [item.label, ...item.submenu.filter((i) => i.type !== "separator").map((i) => i.label)];
  const keys = ["gravity", "gravityFallWhenReleased", "gravitySetFloorHint", "gravityResetFloor"];
  assert.deepStrictEqual(labels(makeGravity(makeCtx(100)).buildMenuItem()), keys.map((key) => i18n.en[key]));
  for (const lang of SUPPORTED_LANGS) {
    const gravity = initGravity(makeCtx(100), {
      floorFile: tempFloorFile(),
      getDisplayKey: () => "test-display",
      t: createTranslator(() => lang),
    });
    assert.deepStrictEqual(labels(gravity.buildMenuItem()), keys.map((key) => i18n[lang][key]), lang);
  }
});

const toggle = (g) => g.buildMenuItem().submenu.find((i) => i.label === i18n.en.gravityFallWhenReleased);

test("off by default: with no saved switch it neither falls nor marks a floor", () => {
  const floorFile = tempFloorFile(null);
  const ctx = makeCtx(100);
  const gravity = makeGravity(ctx, floorFile);
  assert.strictEqual(gravity.isEnabled(), false);
  assert.strictEqual(toggle(gravity).checked, false);
  assert.strictEqual(gravity.startFall(() => assert.fail("should not fall")), false);
  assert.strictEqual(gravity.setFloorHere(), false);
  assert.strictEqual(ctx.applied.length, 0);
  assert.strictEqual(fs.existsSync(floorFile), false, "nothing is saved until it is turned on");
});

test("turned off from the menu: no fall and no floor marking, and it stays off after a restart", () => {
  const floorFile = tempFloorFile();
  const ctx = makeCtx(100);
  const gravity = makeGravity(ctx, floorFile);
  assert.strictEqual(toggle(gravity).checked, true, "starts on");
  toggle(gravity).click();
  assert.strictEqual(gravity.isEnabled(), false);
  assert.strictEqual(toggle(gravity).checked, false);
  assert.strictEqual(gravity.startFall(() => assert.fail("should not fall")), false);
  assert.strictEqual(gravity.setFloorHere(), false);
  assert.strictEqual(JSON.parse(fs.readFileSync(floorFile, "utf8")).enabled, false);
  const restarted = makeGravity(makeCtx(100), floorFile);
  assert.strictEqual(restarted.isEnabled(), false);
  assert.strictEqual(restarted.startFall(() => {}), false);
});

test("turning off mid-fall stops it where it is; turning back on with the pet in the air makes it fall", async () => {
  const floorFile = tempFloorFile();
  const ctx = makeCtx(100);
  const gravity = makeGravity(ctx, floorFile);
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
