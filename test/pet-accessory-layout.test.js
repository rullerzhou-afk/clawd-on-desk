"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  computeStaticAccessoryLayout,
  computeDynamicAccessoryLayout,
  transformedBounds,
  layoutsEqual,
} = require("../src/pet-accessory-layout");

const ACCESSORY = { aspect: 2, widthScale: 1, offsetY: 0 };

describe("pet accessory layout", () => {
  it("maps a static frame through xMidYMid meet letterboxing", () => {
    const layout = computeStaticAccessoryLayout({
      mediaBox: { x: 10, y: 20, width: 200, height: 100 },
      viewBox: { x: 0, y: 0, width: 100, height: 100 },
      frame: { cx: 50, baseY: 40, width: 20 },
      accessory: ACCESSORY,
      stageSize: { width: 220, height: 140 },
    });

    assert.deepStrictEqual(layout.matrix, {
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: 100,
      f: 50,
    });
    assert.strictEqual(layout.width, 20);
    assert.strictEqual(layout.height, 10);
    assert.deepStrictEqual(layout.bounds, { x: 100, y: 50, width: 20, height: 10 });
  });

  it("applies catalog width and baseline offsets before static projection", () => {
    const layout = computeStaticAccessoryLayout({
      mediaBox: { x: 0, y: 0, width: 200, height: 100 },
      viewBox: { x: -50, y: -25, width: 100, height: 50 },
      frame: { cx: 0, baseY: 0, width: 20 },
      accessory: { aspect: 1, widthScale: 1.5, offsetY: 2 },
      stageSize: { width: 200, height: 100 },
    });

    assert.strictEqual(layout.width, 30);
    assert.strictEqual(layout.height, 30);
    assert.deepStrictEqual(layout.matrix, {
      a: 2,
      b: 0,
      c: 0,
      d: 2,
      e: 70,
      f: -6,
    });
  });

  it("projects target-local frames through the full affine CTM and media offset", () => {
    const layout = computeDynamicAccessoryLayout({
      mediaOffset: { x: 10, y: 20 },
      matrix: { a: 2, b: 0.5, c: -0.25, d: 3, e: 4, f: 5 },
      frame: { cx: 8, baseY: 6, width: 4 },
      accessory: ACCESSORY,
      stageSize: { width: 220, height: 220 },
    });

    assert.deepStrictEqual(layout.matrix, {
      a: 2,
      b: 0.5,
      c: -0.25,
      d: 3,
      e: 25,
      f: 40,
    });
    assert.deepStrictEqual(
      transformedBounds(layout.matrix, layout.width, layout.height),
      layout.bounds
    );
  });

  it("normalizes an internal x-reflection around the projected rect without moving it", () => {
    const input = {
      mediaOffset: { x: 10, y: 20 },
      matrix: { a: -2, b: 0.5, c: 0.25, d: 3, e: 80, f: 5 },
      frame: { cx: 8, baseY: 6, width: 4 },
      accessory: ACCESSORY,
      stageSize: { width: 220, height: 220 },
    };
    const reflected = computeDynamicAccessoryLayout(input);
    const normalized = computeDynamicAccessoryLayout({ ...input, normalizeReflection: "x" });

    assert.ok(reflected.matrix.a * reflected.matrix.d - reflected.matrix.b * reflected.matrix.c < 0);
    assert.ok(normalized.matrix.a * normalized.matrix.d - normalized.matrix.b * normalized.matrix.c > 0);
    assert.deepStrictEqual(normalized.bounds, reflected.bounds);
    assert.deepStrictEqual(
      {
        x: normalized.bounds.x + normalized.bounds.width / 2,
        y: normalized.bounds.y + normalized.bounds.height / 2,
      },
      {
        x: reflected.bounds.x + reflected.bounds.width / 2,
        y: reflected.bounds.y + reflected.bounds.height / 2,
      }
    );
  });

  it("rejects invalid, unbounded, or implausibly off-stage layouts", () => {
    const base = {
      mediaBox: { x: 0, y: 0, width: 200, height: 200 },
      viewBox: { x: 0, y: 0, width: 100, height: 100 },
      frame: { cx: 50, baseY: 40, width: 20 },
      accessory: ACCESSORY,
      stageSize: { width: 200, height: 200 },
    };

    assert.strictEqual(computeStaticAccessoryLayout({ ...base, frame: { ...base.frame, width: Infinity } }), null);
    assert.strictEqual(computeStaticAccessoryLayout({ ...base, accessory: { ...ACCESSORY, aspect: 0 } }), null);
    assert.strictEqual(computeStaticAccessoryLayout({ ...base, mediaBox: { ...base.mediaBox, width: 0 } }), null);
    assert.strictEqual(computeDynamicAccessoryLayout({
      mediaOffset: { x: 0, y: 0 },
      matrix: { a: 1000, b: 0, c: 0, d: 1000, e: 0, f: 0 },
      frame: base.frame,
      accessory: ACCESSORY,
      stageSize: base.stageSize,
    }), null);
    assert.strictEqual(computeDynamicAccessoryLayout({
      mediaOffset: { x: 0, y: 0 },
      matrix: { a: 0, b: 0, c: 0, d: 0, e: 20, f: 20 },
      frame: base.frame,
      accessory: ACCESSORY,
      stageSize: base.stageSize,
    }), null);
  });

  it("compares only finite layout geometry with an epsilon", () => {
    const a = {
      width: 10,
      height: 5,
      matrix: { a: 1, b: 0, c: 0, d: 1, e: 2, f: 3 },
    };
    const b = {
      width: 10.00001,
      height: 5,
      matrix: { a: 1, b: 0, c: 0, d: 1, e: 2.00001, f: 3 },
    };
    assert.strictEqual(layoutsEqual(a, b), true);
    assert.strictEqual(layoutsEqual(a, { ...b, matrix: { ...b.matrix, e: 2.1 } }), false);
    assert.strictEqual(layoutsEqual(a, null), false);
  });
});
