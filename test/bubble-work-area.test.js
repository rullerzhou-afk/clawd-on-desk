"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { resolveBubbleWorkArea } = require("../src/bubble-work-area");

const PET_BOUNDS = { x: 2100, y: 100, width: 120, height: 120 };
const NEAREST = { x: 1920, y: 0, width: 1920, height: 1040 };
const SYNTHETIC = { x: 0, y: 0, width: 1920, height: 1080 };

describe("bubble work-area fallback", () => {
  it("uses the pet display in follow mode even when the primary display is usable", () => {
    const primary = { x: 0, y: 0, width: 1920, height: 1040 };
    assert.strictEqual(resolveBubbleWorkArea({
      followPet: true,
      petBounds: PET_BOUNDS,
      getPrimaryWorkArea: () => primary,
      getNearestWorkArea: (x, y) => {
        assert.strictEqual(x, 2160);
        assert.strictEqual(y, 160);
        return NEAREST;
      },
      syntheticWorkArea: SYNTHETIC,
    }), NEAREST);
  });

  it("falls back to the pet display when the primary provider fails or is unusable", () => {
    for (const getPrimaryWorkArea of [
      () => { throw new Error("topology race"); },
      () => ({ x: 0, y: 0, width: 0, height: 1080 }),
    ]) {
      assert.strictEqual(resolveBubbleWorkArea({
        followPet: false,
        petBounds: PET_BOUNDS,
        getPrimaryWorkArea,
        getNearestWorkArea: () => NEAREST,
        syntheticWorkArea: SYNTHETIC,
      }), NEAREST);
    }
  });

  it("uses the synthetic work area when primary and nearest providers both fail", () => {
    assert.strictEqual(resolveBubbleWorkArea({
      followPet: false,
      petBounds: PET_BOUNDS,
      getPrimaryWorkArea: () => { throw new Error("primary unavailable"); },
      getNearestWorkArea: () => { throw new Error("displays unavailable"); },
      syntheticWorkArea: SYNTHETIC,
    }), SYNTHETIC);
  });
});
