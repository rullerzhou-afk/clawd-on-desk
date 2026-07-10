"use strict";

// Portrait displays tend to be physically narrower, so the pet at ratio% of the long edge
// still reads as small. 1.6× lifts it back to a visually comparable size, while the 0.6
// cap on width prevents a tall narrow screen from being swallowed by the pet.
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

function getSavedPixelSize(prefs) {
  const width = Number(prefs && prefs.savedPixelWidth);
  const height = Number(prefs && prefs.savedPixelHeight);
  if (!Number.isFinite(width) || width <= 0) return null;
  if (!Number.isFinite(height) || height <= 0) return null;
  return { width: Math.round(width), height: Math.round(height) };
}

function getLaunchPixelSize(prefs, fallbackSize) {
  if (!prefs || !fallbackSize) return fallbackSize;
  if (!prefs.keepSizeAcrossDisplays) return fallbackSize;
  if (typeof prefs.size !== "string" || !prefs.size.startsWith("P:")) return fallbackSize;
  const saved = getSavedPixelSize(prefs);
  if (!saved) return fallbackSize;
  // #408: a saved keep-size larger than the display it was REALIZED on can only
  // be corrupted prefs (the DPI round-trip growth where setBounds(getBounds())
  // ratchets the size up each sleep/wake). Compare against the origin display's
  // work area, NOT the current launch display — a legit keep-size set on a
  // large display may exceed a smaller launch display, and keeping it is the
  // whole point of "keep size across displays".
  //
  // #408 round-2: prefer the dedicated savedPixelWorkArea (frozen-origin). Fall
  // back to positionDisplay.workArea only for legacy prefs that predate the
  // dedicated field — that snapshot tracks the LAST-FLUSH display, which after
  // a "Send to display" diverges from the frozen origin. Once those legacy
  // prefs flush again with the new field, this fallback stops mattering.
  // Without any origin info, skip the clamp rather than risk healing a valid
  // size.
  const originWa = getLaunchOriginWorkArea(prefs);
  if (originWa) {
    const maxW = Number(originWa.width);
    const maxH = Number(originWa.height);
    if (Number.isFinite(maxW) && maxW > 0 && saved.width > maxW) return fallbackSize;
    if (Number.isFinite(maxH) && maxH > 0 && saved.height > maxH) return fallbackSize;
  }
  return saved;
}

function getLaunchOriginWorkArea(prefs) {
  if (!prefs) return null;
  if (prefs.savedPixelWorkArea && typeof prefs.savedPixelWorkArea === "object") {
    return prefs.savedPixelWorkArea;
  }
  return (prefs.positionDisplay && prefs.positionDisplay.workArea) || null;
}

module.exports = {
  getLaunchPixelSize,
  getLaunchSizingWorkArea,
  getProportionalBasePx,
  getProportionalPixelSize,
  getSavedPixelSize,
};
