"use strict";
const { computeUpdateBubbleBounds } = require("./update-bubble");
function intersects(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width
    && a.y < b.y + b.height && b.y < a.y + a.height;
}
function computeSessionResultBounds(options) {
  const { workArea, scale = 1, desiredHeight = 520, avoidRects = [] } = options;
  if (!workArea) return null;
  const width = Math.round(340 * scale);
  if (width > workArea.width) return null;
  const maxHeight = Math.min(desiredHeight, 520);
  for (const cssHeight of [...new Set([maxHeight, Math.min(maxHeight, 350), Math.min(maxHeight, 200)])]) {
    const height = Math.ceil(cssHeight * scale);
    const bounds = computeUpdateBubbleBounds({
      ...options, width, height, edgeMargin: Math.round(10 * scale),
      gap: Math.round(10 * scale), reservedHeight: 0,
    });
    if (bounds && bounds.x >= workArea.x && bounds.y >= workArea.y
      && bounds.x + width <= workArea.x + workArea.width
      && bounds.y + height <= workArea.y + workArea.height
      && !avoidRects.some(rect => intersects(bounds, rect))) return bounds;
  }
  return null;
}
module.exports = { computeSessionResultBounds };
