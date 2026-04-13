"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  getLaunchSizingWorkArea,
  getProportionalBasePx,
  getProportionalPixelSize,
} = require("../src/size-utils");

describe("size utils", () => {
  it("uses display width on landscape screens", () => {
    assert.strictEqual(getProportionalBasePx({ width: 2560, height: 1440 }), 2560);
    assert.deepStrictEqual(
      getProportionalPixelSize(10, { width: 2560, height: 1440 }),
      { width: 256, height: 256 },
    );
  });

  it("uses display height on portrait screens before boost", () => {
    assert.strictEqual(getProportionalBasePx({ width: 1440, height: 2560 }), 2560);
  });

  it("boosts portrait screens so the pet stays readable", () => {
    assert.deepStrictEqual(
      getProportionalPixelSize(10, { width: 1080, height: 1920 }),
      { width: 307, height: 307 },
    );
    assert.deepStrictEqual(
      getProportionalPixelSize(15, { width: 834, height: 1194 }),
      { width: 286, height: 286 },
    );
  });

  it("caps portrait growth before it gets absurdly wide", () => {
    assert.deepStrictEqual(
      getProportionalPixelSize(50, { width: 834, height: 1194 }),
      { width: 500, height: 500 },
    );
  });

  it("picks the saved display before the first window size is computed", () => {
    const calls = [];
    const portrait = { x: 2560, y: 123, width: 834, height: 1194 };
    const fallback = { x: 0, y: 0, width: 2560, height: 1410 };
    const picked = getLaunchSizingWorkArea(
      { positionSaved: true, x: 2820, y: 760, miniMode: false },
      fallback,
      (x, y) => {
        calls.push([x, y]);
        return portrait;
      },
    );
    assert.deepStrictEqual(calls, [[2821, 761]]);
    assert.deepStrictEqual(picked, portrait);
    assert.deepStrictEqual(getProportionalPixelSize(15, picked), { width: 286, height: 286 });
  });
});
