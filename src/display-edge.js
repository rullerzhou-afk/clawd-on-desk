"use strict";

// src/display-edge.js — shared horizontal display-edge topology resolver.
//
// Both src/mini.js's internal-seam clip (`seamBoundary()`) and the Linux
// edge-virtualization materializer (`materializeVirtualBounds()` in
// src/drag-position.js, wired up in a later phase) need the same answer to
// "is this edge an internal seam shared with a neighbouring display, or an
// outer workArea edge with nothing beyond it?". Keeping two independent
// approximations of that question is how you get "mini thinks it's an
// internal seam but the materializer thinks it's an outer edge" bugs — see
// docs/plans/plan-issue-690-gnome-mini-edge-snap.md §4.1.
//
// Pure module: no `require("electron")`, no reads of global state. Every
// input (display list, workArea, vertical band) is passed in by the caller
// so this can run in tests without a screen.

// Absorbs OS-side rounding when comparing display edges. Carried over from
// the tolerance src/mini.js's `seamBoundary()` already used.
const SEAM_TOLERANCE_PX = 4;

function isFiniteRect(rect) {
  return !!rect
    && Number.isFinite(rect.x)
    && Number.isFinite(rect.y)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height);
}

function isUsableDisplay(display) {
  return !!display
    && isFiniteRect(display.bounds)
    && isFiniteRect(display.workArea)
    && display.bounds.width > 0
    && display.bounds.height > 0
    && display.workArea.width > 0
    && display.workArea.height > 0;
}

function overlapsVerticalBand(bounds, yMid) {
  if (!Number.isFinite(yMid)) return false;
  return yMid >= bounds.y && yMid <= bounds.y + bounds.height;
}

// The "local" display is whichever one's workArea contains the centre of
// the caller's workArea. Mirrors src/mini.js's previous inline lookup.
function findLocalDisplay(displays, workArea) {
  const cx = workArea.x + workArea.width / 2;
  const cy = workArea.y + workArea.height / 2;
  return displays.find((d) =>
    cx >= d.workArea.x && cx <= d.workArea.x + d.workArea.width &&
    cy >= d.workArea.y && cy <= d.workArea.y + d.workArea.height
  ) || null;
}

function resolveSide(edge, workArea, localBounds, displays, local, yMid) {
  const workAreaBoundary = edge === "right"
    ? workArea.x + workArea.width
    : workArea.x;
  const physicalBoundary = edge === "right"
    ? localBounds.x + localBounds.width
    : localBounds.x;

  const yMidUsable = Number.isFinite(yMid);
  const hasAdjacentDisplay = yMidUsable && displays.some((d) => {
    if (d === local || !overlapsVerticalBand(d.bounds, yMid)) return false;
    const neighbourEdge = edge === "right" ? d.bounds.x : d.bounds.x + d.bounds.width;
    return Math.abs(neighbourEdge - physicalBoundary) <= SEAM_TOLERANCE_PX;
  });

  // "Outer" is a pure topology question: is there another display to go to
  // past this edge? A side dock does NOT change that answer — its effect
  // shows up in `workAreaBoundary` (which is where a clamp lands), not in
  // whether we clamp at all. Folding the dock into this flag would make a
  // multi-display seam with a dock report `isOuterWorkAreaEdge` and
  // `hasAdjacentDisplay` both true, turning on horizontal virtualization and
  // mini's seam clip simultaneously — exactly the disagreement this module
  // exists to prevent, and a violation of the plan's invariant I3.
  //
  // With no usable yMid we can't judge the topology, so fail conservative:
  // no virtualization (pre-fix behavior) rather than moving a window
  // off-screen on a guess. `hasAdjacentDisplay` stays false in that case too,
  // which preserves seamBoundary()'s pre-existing "no clip" behavior.
  const isOuterWorkAreaEdge = yMidUsable && !hasAdjacentDisplay;

  return { workAreaBoundary, physicalBoundary, hasAdjacentDisplay, isOuterWorkAreaEdge };
}

// resolveHorizontalEdgeContext({ displays, workArea, yMid })
//   => { left: {...}, right: {...} }
//
// Resolves both horizontal edges in one call — deliberately does not take
// an `edge` argument. The two sides can have different answers (three
// monitors side by side: the middle one is a seam on both sides; two
// monitors side by side: the left one is outer on its left, a seam on its
// right) and a caller writing a window doesn't necessarily know in advance
// which side it might overflow toward.
function resolveHorizontalEdgeContext({ displays, workArea, yMid } = {}) {
  const wa = isFiniteRect(workArea) ? workArea : { x: 0, y: 0, width: 0, height: 0 };
  const usableDisplays = Array.isArray(displays) ? displays.filter(isUsableDisplay) : [];

  // Rule 4: empty/damaged display list — fall back to a single synthetic
  // display built from the caller's own workArea so we never produce NaN.
  // bounds === workArea here: with no real display metadata we can't tell
  // physical bounds from workArea, so both edges collapse to the same
  // boundary (no dock, no neighbour).
  const displaysForLookup = usableDisplays.length > 0
    ? usableDisplays
    : [{ bounds: wa, workArea: wa }];

  const local = findLocalDisplay(displaysForLookup, wa);
  const localBounds = local ? local.bounds : wa;

  return {
    left: resolveSide("left", wa, localBounds, displaysForLookup, local, yMid),
    right: resolveSide("right", wa, localBounds, displaysForLookup, local, yMid),
  };
}

module.exports = {
  resolveHorizontalEdgeContext,
};
