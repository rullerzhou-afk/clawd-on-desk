"use strict";

function isUsableWorkArea(workArea) {
  return !!(
    workArea
    && Number.isFinite(workArea.x)
    && Number.isFinite(workArea.y)
    && Number.isFinite(workArea.width)
    && workArea.width > 0
    && Number.isFinite(workArea.height)
    && workArea.height > 0
  );
}

function resolveBubbleWorkArea(options = {}) {
  const followPet = options.followPet === true;
  if (!followPet && typeof options.getPrimaryWorkArea === "function") {
    try {
      const primary = options.getPrimaryWorkArea();
      if (isUsableWorkArea(primary)) return primary;
    } catch {}
  }

  if (typeof options.getNearestWorkArea === "function") {
    try {
      const bounds = options.petBounds || {};
      const cx = bounds.x + bounds.width / 2;
      const cy = bounds.y + bounds.height / 2;
      const nearest = options.getNearestWorkArea(cx, cy);
      if (isUsableWorkArea(nearest)) return nearest;
    } catch {}
  }

  return options.syntheticWorkArea;
}

module.exports = {
  isUsableWorkArea,
  resolveBubbleWorkArea,
};
