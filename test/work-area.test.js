// Tests for src/work-area.js — pure work-area math with empty-display
// fallback. Regression coverage for issue #93: main process crashed when
// screen.getAllDisplays() briefly returned [] during display topology
// changes (monitor plug/unplug, lock/unlock, RDP switch).

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  findNearestWorkArea,
  computeLooseClamp,
  SYNTHETIC_WORK_AREA,
} = require("../src/work-area");

const wa = (x, y, w, h) => ({ x, y, width: w, height: h });
const display = (x, y, w, h) => ({ workArea: wa(x, y, w, h) });

describe("findNearestWorkArea", () => {
  it("returns the only display's workArea when there is one display", () => {
    const result = findNearestWorkArea([display(0, 0, 1920, 1080)], null, 100, 100);
    assert.deepStrictEqual(result, wa(0, 0, 1920, 1080));
  });

  it("picks the left display when cursor is over it", () => {
    const displays = [display(0, 0, 1920, 1080), display(1920, 0, 1920, 1080)];
    const result = findNearestWorkArea(displays, null, 500, 500);
    assert.deepStrictEqual(result, wa(0, 0, 1920, 1080));
  });

  it("picks the right display when cursor is over it", () => {
    const displays = [display(0, 0, 1920, 1080), display(1920, 0, 1920, 1080)];
    const result = findNearestWorkArea(displays, null, 2500, 500);
    assert.deepStrictEqual(result, wa(1920, 0, 1920, 1080));
  });

  // ── issue #93 regression cases ──

  it("falls back to primary workArea when displays array is empty", () => {
    const primary = wa(0, 0, 2560, 1440);
    const result = findNearestWorkArea([], primary, 0, 0);
    assert.deepStrictEqual(result, primary);
  });

  it("falls back to synthetic workArea when both displays and primary are unavailable", () => {
    const result = findNearestWorkArea([], null, 0, 0);
    assert.deepStrictEqual(result, SYNTHETIC_WORK_AREA);
  });

  it("treats null/undefined displays as empty and falls through", () => {
    assert.deepStrictEqual(findNearestWorkArea(null, null, 0, 0), SYNTHETIC_WORK_AREA);
    assert.deepStrictEqual(findNearestWorkArea(undefined, null, 0, 0), SYNTHETIC_WORK_AREA);
  });

  it("never throws on empty displays — does not read displays[0]", () => {
    assert.doesNotThrow(() => findNearestWorkArea([], null, 0, 0));
    assert.doesNotThrow(() => findNearestWorkArea(null, null, 0, 0));
  });
});

describe("computeLooseClamp", () => {
  it("clamps to a single display when window is well inside it", () => {
    const result = computeLooseClamp([display(0, 0, 1920, 1080)], null, 100, 100, 200, 200);
    assert.strictEqual(result.x, 100);
    assert.strictEqual(result.y, 100);
  });

  it("clamps a far-off window back near the right edge of the union", () => {
    const displays = [display(0, 0, 1920, 1080), display(1920, 0, 1920, 1080)];
    // window 100x100 at 5000,5000. union maxX=3840, margin=25
    // x = max(-25, min(5000, 3840-100+25)) = max(-25, 3765) = 3765
    const result = computeLooseClamp(displays, null, 5000, 5000, 100, 100);
    assert.strictEqual(result.x, 3765);
  });

  it("allows partial off-screen by 25% margin (left side)", () => {
    const displays = [display(0, 0, 1920, 1080)];
    // margin = 50, x can go as low as -50
    const result = computeLooseClamp(displays, null, -100, 100, 200, 200);
    assert.strictEqual(result.x, -50);
  });

  it("accepts an explicit top margin for windows with invisible padding", () => {
    const displays = [display(0, 0, 1920, 1080)];
    const result = computeLooseClamp(displays, null, 100, -120, 200, 200, {
      marginTop: 110,
    });
    assert.strictEqual(result.y, -110);
  });

  // ── issue #93 regression cases ──

  it("falls back to primary when displays is empty", () => {
    const primary = wa(0, 0, 1920, 1080);
    const result = computeLooseClamp([], primary, 100, 100, 200, 200);
    assert.strictEqual(result.x, 100);
    assert.strictEqual(result.y, 100);
    assert.ok(Number.isFinite(result.x));
    assert.ok(Number.isFinite(result.y));
  });

  it("falls back to synthetic when both displays and primary are unavailable", () => {
    const result = computeLooseClamp([], null, 100, 100, 200, 200);
    assert.ok(Number.isFinite(result.x));
    assert.ok(Number.isFinite(result.y));
  });

  it("never returns NaN or Infinity even when displays is null", () => {
    const result = computeLooseClamp(null, null, 100, 100, 200, 200);
    assert.ok(Number.isFinite(result.x), `expected finite x, got ${result.x}`);
    assert.ok(Number.isFinite(result.y), `expected finite y, got ${result.y}`);
  });

  it("never throws on empty displays", () => {
    assert.doesNotThrow(() => computeLooseClamp([], null, 0, 0, 100, 100));
    assert.doesNotThrow(() => computeLooseClamp(null, null, 0, 0, 100, 100));
  });
});
