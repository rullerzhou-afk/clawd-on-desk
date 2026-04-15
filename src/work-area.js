// src/work-area.js — Pure work-area math, kept testable in isolation.
//
// Electron's screen.getAllDisplays() can briefly return [] during display
// topology changes (monitor plug/unplug, lock/unlock, RDP switch, startup
// race). Reading displays[0].workArea on an empty array crashes the main
// process — see issue #93. These helpers add a two-tier fallback so the
// caller always gets a usable workArea object.

// Last-resort synthetic work area when both the displays array and the
// primary-display query are unavailable. Sized for a typical 1080p screen
// so setBounds() calls stay valid until the display topology stabilizes.
const SYNTHETIC_WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 };

function findNearestWorkArea(displays, primaryWa, cx, cy) {
  if (!Array.isArray(displays) || displays.length === 0) {
    return primaryWa || SYNTHETIC_WORK_AREA;
  }
  let nearest = displays[0].workArea;
  let minDist = Infinity;
  for (const d of displays) {
    const wa = d.workArea;
    const dx = Math.max(wa.x - cx, 0, cx - (wa.x + wa.width));
    const dy = Math.max(wa.y - cy, 0, cy - (wa.y + wa.height));
    const dist = dx * dx + dy * dy;
    if (dist < minDist) { minDist = dist; nearest = wa; }
  }
  return nearest;
}

function computeLooseClamp(displays, primaryWa, x, y, w, h, options = {}) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  if (Array.isArray(displays)) {
    for (const d of displays) {
      const wa = d.workArea;
      if (wa.x < minX) minX = wa.x;
      if (wa.y < minY) minY = wa.y;
      if (wa.x + wa.width > maxX) maxX = wa.x + wa.width;
      if (wa.y + wa.height > maxY) maxY = wa.y + wa.height;
    }
  }
  // Empty displays → fall back to primary, then synthetic. Without this
  // guard, minX/maxX stay at Infinity/-Infinity and the Math.max/min below
  // produce NaN, which makes setBounds() throw or land off-screen.
  if (minX === Infinity) {
    const wa = primaryWa || SYNTHETIC_WORK_AREA;
    minX = wa.x;
    minY = wa.y;
    maxX = wa.x + wa.width;
    maxY = wa.y + wa.height;
  }
  const marginX = options.marginX != null ? options.marginX : Math.round(w * 0.25);
  const marginTop = options.marginTop != null ? options.marginTop : Math.round(h * 0.25);
  const marginBottom = options.marginBottom != null ? options.marginBottom : Math.round(h * 0.25);
  return {
    x: Math.max(minX - marginX, Math.min(x, maxX - w + marginX)),
    y: Math.max(minY - marginTop, Math.min(y, maxY - h + marginBottom)),
  };
}

module.exports = {
  findNearestWorkArea,
  computeLooseClamp,
  SYNTHETIC_WORK_AREA,
};
