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

module.exports = {
  createDragSnapshot,
  computeAnchoredDragBounds,
  computeFinalDragBounds,
};
