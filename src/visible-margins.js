"use strict";

const hitGeometry = require("./hit-geometry");

function getThemeMarginBox(theme) {
  if (!theme || !theme.layout) return null;
  return theme.layout.marginBox || theme.layout.contentBox || null;
}

function computeThemeAnchorRect(theme, bounds, options = {}) {
  if (!theme || !bounds) return null;
  const box = options.box || theme.updateBubbleAnchorBox || getThemeMarginBox(theme);
  if (!box) return null;

  const file = options.file
    || (theme.states && Array.isArray(theme.states.idle) ? theme.states.idle[0] : null);
  if (!file) return null;

  const state = options.state || "idle";
  return hitGeometry.getContentRectScreen(theme, bounds, state, file, { box });
}

function collectThemeEnvelopeFiles(theme) {
  if (!theme) return [];
  if (Array.isArray(theme._marginEnvelopeFiles)) return theme._marginEnvelopeFiles;

  const files = new Set();
  const addFile = (file) => {
    if (typeof file !== "string" || !file || file.startsWith("mini-")) return;
    files.add(file);
  };
  const addEntry = (entry) => {
    if (!entry) return;
    if (typeof entry === "string") {
      addFile(entry);
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach(addEntry);
      return;
    }
    if (typeof entry === "object") {
      addFile(entry.file);
      if (Array.isArray(entry.files)) entry.files.forEach(addFile);
    }
  };

  for (const [state, entry] of Object.entries(theme.states || {})) {
    if (state.startsWith("mini-")) continue;
    addEntry(entry);
  }
  (theme.workingTiers || []).forEach(addEntry);
  (theme.jugglingTiers || []).forEach(addEntry);
  (theme.idleAnimations || []).forEach(addEntry);
  Object.values(theme.reactions || {}).forEach(addEntry);

  theme._marginEnvelopeFiles = [...files];
  return theme._marginEnvelopeFiles;
}

function computeStableVisibleContentMargins(theme, bounds, options = {}) {
  if (!theme || !bounds) return { top: 0, bottom: 0 };
  const box = options.box || getThemeMarginBox(theme);
  if (!box) return { top: 0, bottom: 0 };

  let top = Infinity;
  let bottom = Infinity;
  const files = options.files || collectThemeEnvelopeFiles(theme);
  for (const file of files) {
    const content = hitGeometry.getContentRectScreen(theme, bounds, null, file, { box });
    if (!content) continue;
    top = Math.min(top, Math.max(0, Math.round(content.top - bounds.y)));
    bottom = Math.min(bottom, Math.max(0, Math.round(bounds.y + bounds.height - content.bottom)));
  }

  return {
    top: Number.isFinite(top) ? top : 0,
    bottom: Number.isFinite(bottom) ? bottom : 0,
  };
}

function normalizeMargin(value) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

// ON 贴边溢出量 —— 按 Peter PR#125 hitRect 基准反算窗口高度比例（测试 280px 下 top=169/bottom=14）
const EDGE_PIN_TOP_RATIO = 0.6;
const EDGE_PIN_BOTTOM_RATIO = 0.25;
// OFF 仍保留 top rubber-band，但顶点不应把窗口主体藏到只剩半截。
const OFF_RUBBER_BAND_TOP_CAP_RATIO = 0.5;

function normalizeBottomInset(value) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

function getCappedEdgePinBottom(heightPx, bottomInset) {
  const desiredBottom = Math.round(heightPx * EDGE_PIN_BOTTOM_RATIO);
  const cappedInset = normalizeBottomInset(bottomInset);
  return cappedInset == null ? desiredBottom : Math.min(desiredBottom, cappedInset);
}

function getCappedOffRubberBandTop(topMargin, heightPx, rubberBandY) {
  const topCap = Math.max(topMargin, Math.round(heightPx * OFF_RUBBER_BAND_TOP_CAP_RATIO));
  return Math.min(topMargin + rubberBandY, topCap);
}

function getLooseDragMargins({ width, height, visibleMargins, allowEdgePinning, bottomInset } = {}) {
  const marginX = Number.isFinite(width) ? Math.round(width * 0.25) : 0;
  const rubberBandY = Number.isFinite(height) ? Math.round(height * 0.25) : 0;
  const margins = visibleMargins || {};
  const topMargin = normalizeMargin(margins.top);
  const heightPx = Number.isFinite(height) ? Math.round(height) : 0;

  if (allowEdgePinning) {
    // ON: drag 与 rest 等量（无橡皮筋回弹）
    return {
      marginX,
      marginTop: Math.round(heightPx * EDGE_PIN_TOP_RATIO),
      marginBottom: getCappedEdgePinBottom(heightPx, bottomInset),
    };
  }

  // OFF: 保留 0.25h 橡皮筋，但顶点不再额外吞掉超过半个窗口的可见区域。
  return {
    marginX,
    marginTop: getCappedOffRubberBandTop(topMargin, heightPx, rubberBandY),
    // Bottom drag always uses the pure 0.25h rubber band when OFF.
    marginBottom: rubberBandY,
  };
}

function getRestClampMargins({ height, visibleMargins, allowEdgePinning, bottomInset } = {}) {
  const margins = visibleMargins || {};
  const topMargin = normalizeMargin(margins.top);
  const bottomMargin = normalizeMargin(margins.bottom);
  const heightPx = Number.isFinite(height) ? Math.round(height) : 0;

  if (allowEdgePinning) {
    return {
      top: Math.round(heightPx * EDGE_PIN_TOP_RATIO),
      bottom: getCappedEdgePinBottom(heightPx, bottomInset),
    };
  }

  return { top: topMargin, bottom: bottomMargin };
}

module.exports = {
  getThemeMarginBox,
  computeThemeAnchorRect,
  collectThemeEnvelopeFiles,
  computeStableVisibleContentMargins,
  getLooseDragMargins,
  getRestClampMargins,
};
