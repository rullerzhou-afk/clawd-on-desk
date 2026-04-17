"use strict";

const hitGeometry = require("./hit-geometry");

function getThemeMarginBox(theme) {
  if (!theme || !theme.layout) return null;
  return theme.layout.marginBox || theme.layout.contentBox || null;
}

function computeRectMargins(bounds, rect) {
  if (!bounds || !rect) return { top: 0, bottom: 0 };
  return {
    top: Math.max(0, Math.round(rect.top - bounds.y)),
    bottom: Math.max(0, Math.round(bounds.y + bounds.height - rect.bottom)),
  };
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
    const margins = computeRectMargins(bounds, content);
    top = Math.min(top, margins.top);
    bottom = Math.min(bottom, margins.bottom);
  }

  return {
    top: Number.isFinite(top) ? top : 0,
    bottom: Number.isFinite(bottom) ? bottom : 0,
  };
}

module.exports = {
  computeRectMargins,
  getThemeMarginBox,
  collectThemeEnvelopeFiles,
  computeStableVisibleContentMargins,
};
