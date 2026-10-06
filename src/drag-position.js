"use strict";

function copyPoint(point) {
  return { x: point.x, y: point.y };
}

function copySize(size) {
  return { width: size.width, height: size.height };
}

function createDragSnapshot(cursor, bounds, size) {
  if (!cursor || !bounds || !size) return null;
  return {
    cursor: copyPoint(cursor),
    bounds: { x: bounds.x, y: bounds.y },
    size: copySize(size),
  };
}

function computeAnchoredDragBounds(snapshot, cursor, clampPosition) {
  if (!snapshot || !cursor) return null;
  const { width, height } = snapshot.size;
  const targetX = snapshot.bounds.x + (cursor.x - snapshot.cursor.x);
  const targetY = snapshot.bounds.y + (cursor.y - snapshot.cursor.y);
  const pos = clampPosition
    ? clampPosition(targetX, targetY, width, height)
    : { x: targetX, y: targetY };
  return { x: pos.x, y: pos.y, width, height };
}

function computeFinalDragBounds(bounds, size, clampPosition) {
  if (!bounds || !size || !clampPosition) return null;
  const pos = clampPosition(bounds.x, bounds.y, size.width, size.height);
  return { x: pos.x, y: pos.y, width: size.width, height: size.height };
}

function needsFinalClampAdjustment(bounds, size, clampPosition) {
  const clamped = computeFinalDragBounds(bounds, size, clampPosition);
  return !!(
    clamped &&
    (clamped.x !== bounds.x || clamped.y !== bounds.y)
  );
}

// materializeVirtualBounds(virtualBounds, workArea, { leftBound, rightBound })
//   => { bounds, viewportOffsetX, viewportOffsetY }
//
// Turns a logical (possibly off-screen) window rect into a safe physical
// rect plus the viewport offsets a renderer/hit-window need to keep the
// visual position matching the logical one.
//
// Y semantics are unchanged from before this was extended: the physical Y
// is clamped to the workArea top only, and `viewportOffsetY` is always a
// non-negative "top lift" (`physicalY - logicalY`).
//
// X is new and signed: `viewportOffsetX = logicalX - physicalX`. `leftBound`
// / `rightBound` are `null` by default, meaning "don't clamp that side" —
// existing callers that don't pass the third argument get X back unchanged
// and `viewportOffsetX: 0`, i.e. zero behavior change. When given, each
// bound is used exactly as passed (no display lookup happens in here); the
// two sides are clamped independently of one another.
//
// When the two-sided constraint is unsatisfiable — crossed bounds
// (leftBound > rightBound) or a window wider than the feasible interval
// (rightBound - leftBound < width) — the LEFT bound wins by design:
// rightBound is applied first, leftBound last, so physical X lands exactly
// on leftBound and the right edge overflows past rightBound. The result
// stays finite and deterministic; callers must not rely on the right edge
// being contained in that case.
function materializeVirtualBounds(virtualBounds, workArea, { leftBound = null, rightBound = null } = {}) {
  if (!virtualBounds) return null;
  const minY = workArea && Number.isFinite(workArea.y) ? workArea.y : -Infinity;
  const realY = Math.max(virtualBounds.y, minY);

  let realX = virtualBounds.x;
  if (Number.isFinite(rightBound)) {
    realX = Math.min(realX, rightBound - virtualBounds.width);
  }
  if (Number.isFinite(leftBound)) {
    realX = Math.max(realX, leftBound);
  }

  return {
    bounds: {
      x: realX,
      y: realY,
      width: virtualBounds.width,
      height: virtualBounds.height,
    },
    viewportOffsetX: virtualBounds.x - realX,
    viewportOffsetY: Math.max(0, realY - virtualBounds.y),
  };
}

module.exports = {
  createDragSnapshot,
  computeAnchoredDragBounds,
  computeFinalDragBounds,
  needsFinalClampAdjustment,
  materializeVirtualBounds,
};
