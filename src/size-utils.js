"use strict";

const PORTRAIT_BOOST = 1.6;
const PORTRAIT_MAX_WIDTH_RATIO = 0.6;

function getProportionalBasePx(workArea) {
  if (!workArea) return 0;
  const width = Number(workArea.width) || 0;
  const height = Number(workArea.height) || 0;
  return Math.max(width, height);
}

function getProportionalPixelSize(ratio, workArea) {
  const safeRatio = Number.isFinite(ratio) ? ratio : 10;
  const width = Number(workArea?.width) || 0;
  const height = Number(workArea?.height) || 0;
  const basePx = getProportionalBasePx(workArea);
  let px = Math.round(basePx * safeRatio / 100);

  if (height > width && width > 0) {
    const boostedPx = Math.round(px * PORTRAIT_BOOST);
    const maxPortraitPx = Math.round(width * PORTRAIT_MAX_WIDTH_RATIO);
    px = Math.min(boostedPx, maxPortraitPx);
  }

  return { width: px, height: px };
}

function getLaunchSizingWorkArea(prefs, fallbackWorkArea, findNearestWorkArea) {
  if (!prefs || typeof findNearestWorkArea !== "function") return fallbackWorkArea;

  const candidates = [
    prefs.positionSaved ? { x: prefs.x, y: prefs.y } : null,
    prefs.miniMode ? { x: prefs.preMiniX, y: prefs.preMiniY } : null,
  ].filter(Boolean);

  for (const point of candidates) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    return findNearestWorkArea(point.x + 1, point.y + 1) || fallbackWorkArea;
  }

  return fallbackWorkArea;
}

module.exports = {
  getLaunchSizingWorkArea,
  getProportionalBasePx,
  getProportionalPixelSize,
};
