"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  PETELECO_INTENSITY_MIN,
  PETELECO_INTENSITY_MAX,
  PETELECO_INTENSITY_DEFAULT,
  PETELECO_MIN_PULL_PX,
  PETELECO_MIN_REACH_PX,
  PETELECO_MAX_REACH_PX,
  PETELECO_MIN_DURATION_MS,
  PETELECO_MAX_DURATION_MS,
  clampPetelecoIntensity,
  petelecoReachPx,
  computePull,
  computeAim,
  petelecoDurationMs,
  petelecoEase,
  petelecoBoundsAt,
} = require("../src/peteleco-geometry");

const BOUNDS = { x: 500, y: 400, width: 100, height: 100 };
const ORIGIN = { x: 550, y: 450 };

describe("peteleco intensity", () => {
  it("clamps into range and rounds to an integer", () => {
    assert.strictEqual(clampPetelecoIntensity(0), PETELECO_INTENSITY_MIN);
    assert.strictEqual(clampPetelecoIntensity(1000), PETELECO_INTENSITY_MAX);
    assert.strictEqual(clampPetelecoIntensity(42.4), 42);
  });

  it("falls back to the default for unusable values rather than to zero", () => {
    // A 0 here would silently disable every shot; the feature must degrade to
    // "normal strength", not to "nothing happens".
    for (const bad of [undefined, null, NaN, "loud", {}]) {
      assert.strictEqual(clampPetelecoIntensity(bad), PETELECO_INTENSITY_DEFAULT);
    }
  });

  it("maps intensity onto the reach band, monotonically", () => {
    assert.strictEqual(petelecoReachPx(PETELECO_INTENSITY_MIN), PETELECO_MIN_REACH_PX);
    assert.strictEqual(petelecoReachPx(PETELECO_INTENSITY_MAX), PETELECO_MAX_REACH_PX);
    let previous = -Infinity;
    for (let i = PETELECO_INTENSITY_MIN; i <= PETELECO_INTENSITY_MAX; i += 1) {
      const reach = petelecoReachPx(i);
      assert.ok(reach >= previous, `reach must not decrease at intensity ${i}`);
      previous = reach;
    }
  });
});

describe("computePull", () => {
  it("returns the cursor displacement and its length", () => {
    const pull = computePull({ x: 0, y: 0 }, { x: 30, y: 40 });
    assert.deepStrictEqual(pull, { dx: 30, dy: 40, distance: 50 });
  });

  it("rejects missing or non-finite points", () => {
    assert.strictEqual(computePull(null, { x: 1, y: 1 }), null);
    assert.strictEqual(computePull({ x: 0, y: 0 }, { x: NaN, y: 0 }), null);
  });
});

describe("computeAim", () => {
  it("aims at the OPPOSITE side of the pull", () => {
    // Cursor pulled right and down → the pet must be sent left and up.
    const shot = computeAim({
      origin: ORIGIN,
      cursor: { x: ORIGIN.x + 60, y: ORIGIN.y + 60 },
      bounds: BOUNDS,
      intensity: 100,
    });
    assert.ok(shot);
    assert.ok(shot.direction.x < 0 && shot.direction.y < 0);
    assert.ok(shot.to.x < shot.from.x && shot.to.y < shot.from.y);
  });

  it("stays silent until the pull passes the click threshold", () => {
    const below = computeAim({
      origin: ORIGIN,
      cursor: { x: ORIGIN.x + PETELECO_MIN_PULL_PX - 1, y: ORIGIN.y },
      bounds: BOUNDS,
    });
    assert.strictEqual(below, null);

    const above = computeAim({
      origin: ORIGIN,
      cursor: { x: ORIGIN.x + PETELECO_MIN_PULL_PX + 20, y: ORIGIN.y },
      bounds: BOUNDS,
    });
    assert.ok(above);
  });

  it("caps travel at the intensity's reach no matter how far the cursor goes", () => {
    const reach = petelecoReachPx(20);
    const shot = computeAim({
      origin: ORIGIN,
      cursor: { x: ORIGIN.x + 4000, y: ORIGIN.y },
      bounds: BOUNDS,
      intensity: 20,
    });
    assert.ok(shot);
    assert.strictEqual(shot.reach, reach);
    assert.strictEqual(shot.distance, reach);
    assert.strictEqual(shot.power, 1);
    // The uncapped ask is reported so callers can tell "at full power" from
    // "asked for far more than full power".
    assert.ok(shot.requested > shot.distance);
  });

  it("a higher intensity throws strictly further for the same pull", () => {
    const pull = { x: ORIGIN.x + 300, y: ORIGIN.y };
    const weak = computeAim({ origin: ORIGIN, cursor: pull, bounds: BOUNDS, intensity: 10 });
    const strong = computeAim({ origin: ORIGIN, cursor: pull, bounds: BOUNDS, intensity: 90 });
    assert.ok(weak.distance < strong.distance);
  });

  it("reports the landing spot AFTER the caller's clamp, so the projection cannot overpromise", () => {
    // Clamp that refuses to let the pet go left of x=480 — a 20px wall right
    // next to the pet.
    const clampPosition = (x, y, w, h) => ({ x: Math.max(480, x), y });
    const shot = computeAim({
      origin: ORIGIN,
      cursor: { x: ORIGIN.x + 400, y: ORIGIN.y },
      bounds: BOUNDS,
      intensity: 100,
      clampPosition,
    });
    assert.ok(shot);
    assert.strictEqual(shot.target.x, 480);
    // from/to are pet CENTERS, and the drawn line must end where the pet ends.
    assert.strictEqual(shot.to.x, 480 + BOUNDS.width / 2);
    assert.strictEqual(shot.distance, 20);
    assert.ok(shot.power < 0.1);
  });

  it("returns null when the clamp swallows the whole shot", () => {
    const shot = computeAim({
      origin: ORIGIN,
      cursor: { x: ORIGIN.x + 400, y: ORIGIN.y },
      bounds: BOUNDS,
      intensity: 100,
      clampPosition: () => ({ x: BOUNDS.x, y: BOUNDS.y }),
    });
    assert.strictEqual(shot, null);
  });

  it("rejects degenerate bounds", () => {
    const cursor = { x: ORIGIN.x + 100, y: ORIGIN.y };
    assert.strictEqual(computeAim({ origin: ORIGIN, cursor, bounds: null }), null);
    assert.strictEqual(
      computeAim({ origin: ORIGIN, cursor, bounds: { x: 0, y: 0, width: 0, height: 10 } }),
      null
    );
    assert.strictEqual(
      computeAim({ origin: ORIGIN, cursor, bounds: { x: NaN, y: 0, width: 10, height: 10 } }),
      null
    );
  });

  it("draws from the supplied visual center, translated by the shot", () => {
    // The sprite is not centered in its window (clawd's art sits ~16% of the
    // window height below the window's own middle), so the drawn line hangs off
    // the avatar's center — and BOTH ends do, or every projection would come
    // out tilted by the art's offset inside its rectangle.
    const center = { x: 550, y: 482 };
    const shot = computeAim({
      origin: ORIGIN,
      cursor: { x: ORIGIN.x + 100, y: ORIGIN.y },
      bounds: BOUNDS,
      center,
      intensity: 100,
    });
    assert.deepStrictEqual(shot.from, center);
    const movedX = shot.target.x - BOUNDS.x;
    const movedY = shot.target.y - BOUNDS.y;
    assert.deepStrictEqual(shot.to, { x: center.x + movedX, y: center.y + movedY });
    // The anchor is a drawing concern only: where the WINDOW lands is untouched.
    const withoutCenter = computeAim({
      origin: ORIGIN,
      cursor: { x: ORIGIN.x + 100, y: ORIGIN.y },
      bounds: BOUNDS,
      intensity: 100,
    });
    assert.deepStrictEqual(shot.target, withoutCenter.target);
  });

  it("falls back to the window center when no visual center is available", () => {
    const expected = {
      x: BOUNDS.x + BOUNDS.width / 2,
      y: BOUNDS.y + BOUNDS.height / 2,
    };
    for (const center of [null, undefined, { x: NaN, y: 1 }, {}]) {
      const shot = computeAim({
        origin: ORIGIN,
        cursor: { x: ORIGIN.x + 100, y: ORIGIN.y },
        bounds: BOUNDS,
        center,
        intensity: 100,
      });
      assert.deepStrictEqual(shot.from, expected);
    }
  });

  it("keeps the launch rect's size so the animation can anchor to it", () => {
    const shot = computeAim({
      origin: ORIGIN,
      cursor: { x: ORIGIN.x + 100, y: ORIGIN.y },
      bounds: BOUNDS,
      intensity: 50,
    });
    assert.strictEqual(shot.target.width, BOUNDS.width);
    assert.strictEqual(shot.target.height, BOUNDS.height);
  });
});

describe("peteleco animation curve", () => {
  it("keeps the duration inside its envelope", () => {
    assert.strictEqual(petelecoDurationMs(0), PETELECO_MIN_DURATION_MS);
    assert.strictEqual(petelecoDurationMs(-5), PETELECO_MIN_DURATION_MS);
    assert.strictEqual(petelecoDurationMs(1), PETELECO_MIN_DURATION_MS);
    assert.strictEqual(petelecoDurationMs(1e9), PETELECO_MAX_DURATION_MS);
    const mid = petelecoDurationMs(400);
    assert.ok(mid > PETELECO_MIN_DURATION_MS && mid < PETELECO_MAX_DURATION_MS);
  });

  it("is slow enough to watch: a full-reach shot takes most of a second", () => {
    // The first cut flew at 1.4 px/ms and read as a teleport. This pins the
    // slower envelope rather than the exact speed constant.
    const fullReach = petelecoReachPx(PETELECO_INTENSITY_MAX);
    const duration = petelecoDurationMs(fullReach);
    assert.ok(duration > 600, `a max-power shot should be unhurried, got ${duration}ms`);
    assert.ok(duration <= PETELECO_MAX_DURATION_MS);
    // Even a nudge is long enough to be seen as motion.
    assert.ok(petelecoDurationMs(petelecoReachPx(PETELECO_INTENSITY_MIN)) >= 260);
  });

  it("eases out: fast at launch, slow at landing", () => {
    assert.strictEqual(petelecoEase(0), 0);
    assert.strictEqual(petelecoEase(1), 1);
    assert.strictEqual(petelecoEase(-1), 0);
    assert.strictEqual(petelecoEase(2), 1);
    // More than half the distance is covered in the first half of the time.
    assert.ok(petelecoEase(0.5) > 0.5);
    const firstStep = petelecoEase(0.1) - petelecoEase(0);
    const lastStep = petelecoEase(1) - petelecoEase(0.9);
    assert.ok(firstStep > lastStep);
    // The tail is the "fade-out" of the motion: the last tenth of the time must
    // cover a nearly imperceptible slice of the distance, so the pet settles
    // instead of stopping. Ease-out cubic (the first cut) lands at ~0.1%… of a
    // percent short of this; quartic clears it comfortably.
    assert.ok(lastStep < 0.002, `the landing must be gentle, got ${lastStep}`);
    assert.ok(petelecoEase(0.5) > 0.9, "most of the travel happens up front");
  });

  it("interpolates bounds from the launch rect to the target", () => {
    const start = { x: 0, y: 0, width: 80, height: 80 };
    const target = { x: 200, y: 100, width: 80, height: 80 };
    assert.deepStrictEqual(petelecoBoundsAt(start, target, 0), { x: 0, y: 0, width: 80, height: 80 });
    assert.deepStrictEqual(petelecoBoundsAt(start, target, 1), { x: 200, y: 100, width: 80, height: 80 });
    const mid = petelecoBoundsAt(start, target, 0.5);
    assert.ok(mid.x > 100 && mid.x < 200);
    // #569: the animated rect carries the LAUNCH size, never a re-read.
    assert.strictEqual(mid.width, 80);
    assert.strictEqual(mid.height, 80);
  });
});
