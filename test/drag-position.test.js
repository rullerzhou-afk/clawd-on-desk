const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createDragSnapshot,
  computeAnchoredDragBounds,
  computeFinalDragBounds,
  needsFinalClampAdjustment,
  materializeVirtualBounds,
} = require("../src/drag-position");
const { computeLooseClamp } = require("../src/work-area");

const wa = (x, y, w, h) => ({ x, y, width: w, height: h });
const display = (x, y, w, h) => ({ workArea: wa(x, y, w, h) });

describe("anchored drag positioning", () => {
  it("keeps the original cursor-to-window offset across repeated moves", () => {
    const snapshot = createDragSnapshot(
      { x: 100, y: 100 },
      { x: 500, y: 500, width: 200, height: 200 },
      { width: 200, height: 200 }
    );

    const cursorPath = [
      { x: 150, y: 125 },
      { x: 100, y: 100 },
      { x: 60, y: 155 },
      { x: 100, y: 100 },
    ];

    const positions = cursorPath.map((cursor) => computeAnchoredDragBounds(snapshot, cursor));

    assert.deepStrictEqual(positions[0], { x: 550, y: 525, width: 200, height: 200 });
    assert.deepStrictEqual(positions[1], { x: 500, y: 500, width: 200, height: 200 });
    assert.deepStrictEqual(positions[2], { x: 460, y: 555, width: 200, height: 200 });
    assert.deepStrictEqual(positions[3], { x: 500, y: 500, width: 200, height: 200 });
  });

  it("uses loose display-union clamping during drag so cross-screen movement is not pulled back", () => {
    const displays = [display(0, 0, 1920, 1080), display(1920, 0, 1920, 1080)];
    const snapshot = createDragSnapshot(
      { x: 1900, y: 500 },
      { x: 1800, y: 400, width: 200, height: 200 },
      { width: 200, height: 200 }
    );

    const result = computeAnchoredDragBounds(snapshot, { x: 2200, y: 520 }, (x, y, w, h) =>
      computeLooseClamp(displays, null, x, y, w, h)
    );

    assert.deepStrictEqual(result, { x: 2100, y: 420, width: 200, height: 200 });
  });

  it("applies the final clamp after drag ends", () => {
    const result = computeFinalDragBounds(
      { x: 3900, y: 100, width: 200, height: 200 },
      { width: 200, height: 200 },
      () => ({ x: 3640, y: 100 })
    );

    assert.deepStrictEqual(result, { x: 3640, y: 100, width: 200, height: 200 });
  });

  it("detects when the final clamp would move the saved position", () => {
    assert.strictEqual(
      needsFinalClampAdjustment(
        { x: 3900, y: 100, width: 200, height: 200 },
        { width: 200, height: 200 },
        () => ({ x: 3640, y: 100 })
      ),
      true
    );

    assert.strictEqual(
      needsFinalClampAdjustment(
        { x: 120, y: 160, width: 200, height: 200 },
        { width: 200, height: 200 },
        (x, y) => ({ x, y })
      ),
      false
    );
  });
});

describe("materializeVirtualBounds", () => {
  // --- Existing Y-axis behavior. Untouched by the leftBound/rightBound
  // extension: the third argument is optional and defaults to both bounds
  // null, so these keep exercising exactly the pre-existing code path
  // (the expected objects just also carry the new viewportOffsetX: 0 key).
  it("keeps in-bounds virtual coordinates unchanged", () => {
    const result = materializeVirtualBounds(
      { x: 100, y: 120, width: 200, height: 200 },
      wa(0, 0, 1920, 1080)
    );

    assert.deepStrictEqual(result, {
      bounds: { x: 100, y: 120, width: 200, height: 200 },
      viewportOffsetX: 0,
      viewportOffsetY: 0,
    });
  });

  it("materializes negative virtual y to the workArea top and returns viewport offset", () => {
    const result = materializeVirtualBounds(
      { x: 100, y: -74, width: 200, height: 200 },
      wa(0, 0, 1920, 1080)
    );

    assert.deepStrictEqual(result, {
      bounds: { x: 100, y: 0, width: 200, height: 200 },
      viewportOffsetX: 0,
      viewportOffsetY: 74,
    });
  });

  it("falls back to raw virtual bounds when no workArea exists", () => {
    const result = materializeVirtualBounds(
      { x: 50, y: -20, width: 100, height: 100 },
      null
    );

    assert.deepStrictEqual(result, {
      bounds: { x: 50, y: -20, width: 100, height: 100 },
      viewportOffsetX: 0,
      viewportOffsetY: 0,
    });
  });

  // --- §6.1 new X-axis edge-clamp test matrix (plan-issue-690 Phase 1).

  it("keeps the original X when both leftBound and rightBound are null", () => {
    const result = materializeVirtualBounds(
      { x: 1768, y: 100, width: 203, height: 209 },
      wa(0, 0, 1920, 1080),
      { leftBound: null, rightBound: null }
    );

    assert.equal(result.bounds.x, 1768);
    assert.equal(result.viewportOffsetX, 0);
  });

  it("clamps a right-side logical overflow to a safe physical X with a positive offset", () => {
    // #690 fixture: logical mini X=1816 wants to sit 99px past the safe
    // physical edge (rightBound=1920, width=203 → safe X=1717).
    const result = materializeVirtualBounds(
      { x: 1816, y: 100, width: 203, height: 209 },
      wa(0, 0, 1920, 1080),
      { rightBound: 1920 }
    );

    assert.equal(result.bounds.x, 1717);
    assert.equal(result.viewportOffsetX, 99);
  });

  it("clamps a left-side logical overflow to a safe physical X with a negative offset", () => {
    const result = materializeVirtualBounds(
      { x: -99, y: 100, width: 203, height: 209 },
      wa(0, 0, 1920, 1080),
      { leftBound: 0 }
    );

    assert.equal(result.bounds.x, 0);
    assert.equal(result.viewportOffsetX, -99);
  });

  it("returns a zero offset once the logical position is back on-screen", () => {
    const result = materializeVirtualBounds(
      { x: 800, y: 100, width: 203, height: 209 },
      wa(0, 0, 1920, 1080),
      { leftBound: 0, rightBound: 1920 }
    );

    assert.equal(result.bounds.x, 800);
    assert.equal(result.viewportOffsetX, 0);
  });

  it("uses the caller-supplied bound exactly, without guessing display bounds (side dock)", () => {
    // A side dock means the workArea boundary the caller passes in differs
    // from the display's raw physical bounds edge (which this function
    // never sees). The clamp must land exactly on the supplied bound.
    const dockRightBound = 1890; // e.g. a 30px dock trims the workArea edge
    const result = materializeVirtualBounds(
      { x: 1850, y: 100, width: 203, height: 209 },
      wa(0, 0, 1920, 1080),
      { rightBound: dockRightBound }
    );

    assert.equal(result.bounds.x, dockRightBound - 203);
    assert.equal(result.viewportOffsetX, 1850 - (dockRightBound - 203));
  });

  it("clamps each side independently — only the bound that is a number applies", () => {
    // leftBound set, rightBound null: left overflow gets clamped, but a
    // simultaneous "right overflow" (window wider than the workArea) is
    // left completely alone because rightBound opted out.
    const result = materializeVirtualBounds(
      { x: -50, y: 100, width: 2000, height: 209 },
      wa(0, 0, 1920, 1080),
      { leftBound: 0, rightBound: null }
    );

    assert.equal(result.bounds.x, 0, "left side is clamped");
    assert.equal(result.viewportOffsetX, -50, "left clamp produces the offset");
    // Sanity: with rightBound null, the right edge (x + width) is allowed
    // to sit past the workArea — nothing in this function pulls it back.
    assert.equal(result.bounds.x + result.bounds.width, 2000);
  });

  // --- Unsatisfiable two-sided constraints. The documented contract when
  // leftBound > rightBound - width (crossed bounds, or a window wider than
  // the feasible interval) is: the left bound wins. rightBound is applied
  // first and leftBound last, so physical X lands exactly on leftBound and
  // the right edge overflows. Deterministic and finite — never NaN, never
  // a left/right flip.

  it("lets the left bound win when the two bounds cross", () => {
    const result = materializeVirtualBounds(
      { x: 60, y: 100, width: 20, height: 20 },
      wa(0, 0, 1920, 1080),
      { leftBound: 100, rightBound: 50 }
    );

    assert.equal(result.bounds.x, 100);
    assert.equal(result.viewportOffsetX, -40);
  });

  it("lands on the left bound when the window is wider than the bounded interval", () => {
    const result = materializeVirtualBounds(
      { x: 100, y: 100, width: 2000, height: 209 },
      wa(0, 0, 1920, 1080),
      { leftBound: 0, rightBound: 1920 }
    );

    assert.equal(result.bounds.x, 0);
    assert.equal(result.viewportOffsetX, 100);
    assert.equal(
      result.bounds.x + result.bounds.width, 2000,
      "right edge is allowed to overflow past rightBound in the unsatisfiable case"
    );
  });

  it("stays finite when both sides overflow at once", () => {
    const result = materializeVirtualBounds(
      { x: -50, y: 100, width: 2000, height: 209 },
      wa(0, 0, 1920, 1080),
      { leftBound: 0, rightBound: 1920 }
    );

    assert.equal(result.bounds.x, 0, "left bound wins");
    assert.equal(result.viewportOffsetX, -50);
    assert.equal(Number.isFinite(result.bounds.x), true);
    assert.equal(Number.isFinite(result.viewportOffsetX), true);
  });
});
