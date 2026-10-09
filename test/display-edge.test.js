"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { resolveHorizontalEdgeContext } = require("../src/display-edge");

const bounds = (x, y, w, h) => ({ x, y, width: w, height: h });

// Single display: D1 [0,800) x [0,600).
const SINGLE = [
  { bounds: bounds(0, 0, 800, 600), workArea: bounds(0, 0, 800, 600) },
];

// Two displays tiled side by side: D1 [0,800) and D2 [800,1600), same height.
const SIDE_BY_SIDE = [
  { bounds: bounds(0, 0, 800, 600), workArea: bounds(0, 0, 800, 600) },
  { bounds: bounds(800, 0, 800, 600), workArea: bounds(800, 0, 800, 600) },
];

const THREE_SIDE_BY_SIDE = [
  { bounds: bounds(0, 0, 800, 600), workArea: bounds(0, 0, 800, 600) },
  { bounds: bounds(800, 0, 800, 600), workArea: bounds(800, 0, 800, 600) },
  { bounds: bounds(1600, 0, 800, 600), workArea: bounds(1600, 0, 800, 600) },
];

describe("resolveHorizontalEdgeContext", () => {
  it("treats both edges of a single display as outer", () => {
    const wa = SINGLE[0].workArea;
    const ctx = resolveHorizontalEdgeContext({ displays: SINGLE, workArea: wa, yMid: 300 });

    assert.equal(ctx.left.isOuterWorkAreaEdge, true);
    assert.equal(ctx.left.hasAdjacentDisplay, false);
    assert.equal(ctx.left.workAreaBoundary, 0);
    assert.equal(ctx.left.physicalBoundary, 0);

    assert.equal(ctx.right.isOuterWorkAreaEdge, true);
    assert.equal(ctx.right.hasAdjacentDisplay, false);
    assert.equal(ctx.right.workAreaBoundary, 800);
    assert.equal(ctx.right.physicalBoundary, 800);
  });

  it("treats the shared edge between two horizontally adjacent, y-overlapping displays as an internal seam", () => {
    const wa = SIDE_BY_SIDE[0].workArea; // pet lives on D1
    const ctx = resolveHorizontalEdgeContext({ displays: SIDE_BY_SIDE, workArea: wa, yMid: 300 });

    assert.equal(ctx.right.hasAdjacentDisplay, true, "D1's right edge touches D2");
    assert.equal(ctx.right.isOuterWorkAreaEdge, false);
    assert.equal(ctx.right.physicalBoundary, 800);

    assert.equal(ctx.left.hasAdjacentDisplay, false, "nothing to D1's left");
    assert.equal(ctx.left.isOuterWorkAreaEdge, true);
  });

  it("still counts as an internal seam when the neighbour is vertically offset but still covers the pet's yMid", () => {
    const displays = [
      { bounds: bounds(0, 0, 800, 600), workArea: bounds(0, 0, 800, 600) },
      // D2 shifted down 150px — still overlaps D1's vertical band at yMid≈240.
      { bounds: bounds(800, 150, 800, 600), workArea: bounds(800, 150, 800, 600) },
    ];
    const wa = displays[0].workArea;
    const ctx = resolveHorizontalEdgeContext({ displays, workArea: wa, yMid: 240 });

    assert.equal(ctx.right.hasAdjacentDisplay, true);
    assert.equal(ctx.right.isOuterWorkAreaEdge, false);
  });

  it("treats the edge as outer when the neighbour does not cover the pet's yMid", () => {
    const displays = [
      { bounds: bounds(0, 0, 800, 600), workArea: bounds(0, 0, 800, 600) },
      // Neighbour starts below the pet's vertical band entirely.
      { bounds: bounds(800, 700, 800, 600), workArea: bounds(800, 700, 800, 600) },
    ];
    const wa = displays[0].workArea;
    const ctx = resolveHorizontalEdgeContext({ displays, workArea: wa, yMid: 300 });

    assert.equal(ctx.right.hasAdjacentDisplay, false);
    assert.equal(ctx.right.isOuterWorkAreaEdge, true);
  });

  it("supports a display with negative coordinates to the left of the origin", () => {
    // D1 sits to the left of the origin: [-800,0). D2 is the primary [0,800).
    const displays = [
      { bounds: bounds(-800, 0, 800, 600), workArea: bounds(-800, 0, 800, 600) },
      { bounds: bounds(0, 0, 800, 600), workArea: bounds(0, 0, 800, 600) },
    ];
    const wa = displays[1].workArea; // pet lives on D2
    const ctx = resolveHorizontalEdgeContext({ displays, workArea: wa, yMid: 300 });

    assert.equal(ctx.left.hasAdjacentDisplay, true, "D2's left edge touches D1 at x=0");
    assert.equal(ctx.left.isOuterWorkAreaEdge, false);
    assert.equal(ctx.left.physicalBoundary, 0);

    assert.equal(ctx.right.hasAdjacentDisplay, false);
    assert.equal(ctx.right.isOuterWorkAreaEdge, true);
    assert.equal(ctx.right.physicalBoundary, 800);
  });

  it("treats both edges of the middle display in a three-monitor row as seams", () => {
    const wa = THREE_SIDE_BY_SIDE[1].workArea; // pet on the middle display
    const ctx = resolveHorizontalEdgeContext({ displays: THREE_SIDE_BY_SIDE, workArea: wa, yMid: 300 });

    assert.equal(ctx.left.hasAdjacentDisplay, true);
    assert.equal(ctx.left.isOuterWorkAreaEdge, false);
    assert.equal(ctx.left.physicalBoundary, 800);

    assert.equal(ctx.right.hasAdjacentDisplay, true);
    assert.equal(ctx.right.isOuterWorkAreaEdge, false);
    assert.equal(ctx.right.physicalBoundary, 1600);
  });

  it("keeps a dock-inset edge a seam when a display still touches beyond it", () => {
    // D1's workArea is narrower than its bounds (a right-side dock/panel).
    // D2's workArea is also inset on its left. The two displays' physical
    // bounds still touch at x=800, so this stays an internal seam: the pet
    // can still cross to D2 and mini's seam clip still applies. The dock only
    // changes *where* a clamp would land (workAreaBoundary=770), never
    // whether the edge is outer — reporting both flags true would enable
    // horizontal virtualization and the seam clip at the same time.
    const displays = [
      { bounds: bounds(0, 0, 800, 600), workArea: bounds(0, 0, 770, 560) },
      { bounds: bounds(800, 0, 800, 600), workArea: bounds(830, 0, 770, 560) },
    ];
    const wa = displays[0].workArea;
    const ctx = resolveHorizontalEdgeContext({ displays, workArea: wa, yMid: 280 });

    assert.equal(ctx.right.workAreaBoundary, 770);
    assert.equal(ctx.right.physicalBoundary, 800);
    assert.equal(ctx.right.hasAdjacentDisplay, true, "physical bounds still touch");
    assert.equal(ctx.right.isOuterWorkAreaEdge, false, "a dock does not change the topology");
  });

  it("reports a dock-inset outer edge with the workArea boundary, not the display bounds edge", () => {
    // Single display with a right-side dock: nothing beyond it, so this edge
    // IS outer — and a clamp must land at the dock edge (770), not at the
    // physical display edge (800). This is how plan rule 1 actually takes
    // effect: through workAreaBoundary's value, not through the outer flag.
    const displays = [
      { bounds: bounds(0, 0, 800, 600), workArea: bounds(0, 0, 770, 560) },
    ];
    const ctx = resolveHorizontalEdgeContext({
      displays, workArea: displays[0].workArea, yMid: 280,
    });

    assert.equal(ctx.right.isOuterWorkAreaEdge, true);
    assert.equal(ctx.right.hasAdjacentDisplay, false);
    assert.equal(ctx.right.workAreaBoundary, 770);
    assert.equal(ctx.right.physicalBoundary, 800);
  });

  it("stays conservative when yMid is missing or not finite", () => {
    // Every non-finite-number shape, not just "argument omitted": explicit
    // NaN, both infinities, and a numeric string (Number.isFinite does not
    // coerce) must all fail conservative.
    const unusable = [undefined, null, NaN, Infinity, -Infinity, "300"];
    for (const yMid of unusable) {
      const ctx = resolveHorizontalEdgeContext({
        displays: SIDE_BY_SIDE, workArea: SIDE_BY_SIDE[0].workArea, yMid,
      });

      assert.equal(ctx.right.hasAdjacentDisplay, false,
        `yMid=${String(yMid)} matches seamBoundary()'s existing behavior`);
      assert.equal(ctx.right.isOuterWorkAreaEdge, false,
        `yMid=${String(yMid)} must not enable virtualization`);
      assert.equal(ctx.left.isOuterWorkAreaEdge, false, `yMid=${String(yMid)}`);
    }
  });

  it("treats the yMid band as a closed interval at the neighbour's top and bottom edges", () => {
    // overlapsVerticalBand() compares with >= / <= — a pet centre sitting
    // exactly on the neighbour's bounds.y or bounds.y + height still counts
    // as covered; one pixel past either edge does not.
    const displays = [
      { bounds: bounds(0, 0, 800, 600), workArea: bounds(0, 0, 800, 600) },
      { bounds: bounds(800, 150, 800, 300), workArea: bounds(800, 150, 800, 300) },
    ];
    const wa = displays[0].workArea;
    const at = (yMid) => resolveHorizontalEdgeContext({ displays, workArea: wa, yMid });

    assert.equal(at(150).right.hasAdjacentDisplay, true, "exactly at the neighbour's top edge");
    assert.equal(at(450).right.hasAdjacentDisplay, true, "exactly at the neighbour's bottom edge (150+300)");
    assert.equal(at(149).right.hasAdjacentDisplay, false, "one px above the band");
    assert.equal(at(451).right.hasAdjacentDisplay, false, "one px below the band");
  });

  it("honours the 4px seam tolerance boundary exactly", () => {
    const withGap = (gap) => resolveHorizontalEdgeContext({
      displays: [
        { bounds: bounds(0, 0, 800, 600), workArea: bounds(0, 0, 800, 600) },
        { bounds: bounds(800 + gap, 0, 800, 600), workArea: bounds(800 + gap, 0, 800, 600) },
      ],
      workArea: bounds(0, 0, 800, 600),
      yMid: 300,
    });

    assert.equal(withGap(4).right.hasAdjacentDisplay, true, "gap == tolerance is still a seam");
    assert.equal(withGap(4).right.isOuterWorkAreaEdge, false);
    assert.equal(withGap(5).right.hasAdjacentDisplay, false, "gap just past tolerance is not");
    assert.equal(withGap(5).right.isOuterWorkAreaEdge, true);
  });

  it("does not depend on the order of the display list", () => {
    const reversed = [...SIDE_BY_SIDE].reverse();
    const ctx = resolveHorizontalEdgeContext({
      displays: reversed, workArea: SIDE_BY_SIDE[0].workArea, yMid: 300,
    });

    assert.equal(ctx.right.hasAdjacentDisplay, true);
    assert.equal(ctx.right.isOuterWorkAreaEdge, false);
    assert.equal(ctx.left.hasAdjacentDisplay, false);
    assert.equal(ctx.left.isOuterWorkAreaEdge, true);
  });

  it("falls back to the caller's workArea when no display contains its centre", () => {
    // findLocalDisplay() misses → localBounds falls back to the workArea
    // itself, so the two boundaries collapse on both sides…
    const orphanWa = bounds(2000, 0, 800, 600);
    const alone = resolveHorizontalEdgeContext({
      displays: SINGLE, workArea: orphanWa, yMid: 300,
    });

    assert.equal(alone.left.physicalBoundary, alone.left.workAreaBoundary);
    assert.equal(alone.right.physicalBoundary, alone.right.workAreaBoundary);
    assert.equal(alone.right.isOuterWorkAreaEdge, true, "nothing touches the orphan workArea");

    // …and with local === null every display takes part in the adjacency
    // check, so a display that happens to touch the orphan workArea's edge
    // still registers as a seam.
    const touching = resolveHorizontalEdgeContext({
      displays: [
        { bounds: bounds(2800, 0, 800, 600), workArea: bounds(2800, 0, 800, 600) },
      ],
      workArea: orphanWa,
      yMid: 300,
    });

    assert.equal(touching.right.hasAdjacentDisplay, true);
    assert.equal(touching.right.isOuterWorkAreaEdge, false);
  });

  it("does not count a physical gap between displays as a seam", () => {
    const displays = [
      { bounds: bounds(0, 0, 800, 600), workArea: bounds(0, 0, 800, 600) },
      // 50px gap between D1's right edge (800) and D2's left edge (850).
      { bounds: bounds(850, 0, 800, 600), workArea: bounds(850, 0, 800, 600) },
    ];
    const wa = displays[0].workArea;
    const ctx = resolveHorizontalEdgeContext({ displays, workArea: wa, yMid: 300 });

    assert.equal(ctx.right.hasAdjacentDisplay, false);
    assert.equal(ctx.right.isOuterWorkAreaEdge, true);
  });

  it("falls back to a single-display topology without NaN when the display list is empty or damaged", () => {
    const wa = bounds(0, 0, 800, 600);

    const empty = resolveHorizontalEdgeContext({ displays: [], workArea: wa, yMid: 300 });
    assert.equal(Number.isFinite(empty.left.workAreaBoundary), true);
    assert.equal(Number.isFinite(empty.left.physicalBoundary), true);
    assert.equal(empty.left.hasAdjacentDisplay, false);
    assert.equal(empty.left.isOuterWorkAreaEdge, true);
    assert.equal(empty.right.isOuterWorkAreaEdge, true);
    // The synthetic display is built from the workArea itself, so the two
    // boundaries must collapse — no dock, no neighbour.
    assert.equal(empty.left.physicalBoundary, empty.left.workAreaBoundary);
    assert.equal(empty.right.physicalBoundary, empty.right.workAreaBoundary);

    const damaged = resolveHorizontalEdgeContext({
      displays: [
        { bounds: bounds(0, 0, NaN, 600), workArea: bounds(0, 0, 800, 600) },
        { bounds: null, workArea: bounds(800, 0, 800, 600) },
        undefined,
      ],
      workArea: wa,
      yMid: 300,
    });
    assert.equal(Number.isFinite(damaged.left.workAreaBoundary), true);
    assert.equal(Number.isFinite(damaged.left.physicalBoundary), true);
    assert.equal(Number.isFinite(damaged.right.workAreaBoundary), true);
    assert.equal(Number.isFinite(damaged.right.physicalBoundary), true);
    assert.equal(damaged.left.isOuterWorkAreaEdge, true);
    assert.equal(damaged.right.isOuterWorkAreaEdge, true);
    assert.equal(damaged.left.physicalBoundary, damaged.left.workAreaBoundary);
    assert.equal(damaged.right.physicalBoundary, damaged.right.workAreaBoundary);
  });

  it("returns both sides' conclusions from a single call", () => {
    const wa = SIDE_BY_SIDE[0].workArea; // left display of a two-display row
    const ctx = resolveHorizontalEdgeContext({ displays: SIDE_BY_SIDE, workArea: wa, yMid: 300 });

    assert.ok(ctx.left && ctx.right, "both sides present in one result");
    assert.equal(ctx.left.isOuterWorkAreaEdge, true, "nothing to the left of the left display");
    assert.equal(ctx.right.hasAdjacentDisplay, true, "D2 sits right next to it");
  });
});
