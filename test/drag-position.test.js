const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createDragSnapshot,
  computeAnchoredDragBounds,
  computeFinalDragBounds,
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
});
