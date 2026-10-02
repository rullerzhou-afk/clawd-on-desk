"use strict";

// #509: single source of truth for the user-selectable default idle visual.
// The pet's logical idle state is untouched — these helpers only decide which
// sprite is shown while resting. An unset/invalid choice resolves to null so
// every caller falls back to its own existing behavior.

function listIdleVisualOptions(theme) {
  if (!theme || typeof theme !== "object") return [];
  const idleFiles = theme.states && Array.isArray(theme.states.idle) ? theme.states.idle : [];
  const poolFiles = Array.isArray(theme.idleAnimations)
    ? theme.idleAnimations.map((entry) => entry && entry.file)
    : [];
  const selectableFiles = Array.isArray(theme.idleVisualOptions)
    ? theme.idleVisualOptions.map((entry) => entry && entry.file)
    : [];
  const options = [];
  const seen = new Set();
  for (const file of [...idleFiles, ...poolFiles, ...selectableFiles]) {
    if (typeof file !== "string" || !file || seen.has(file)) continue;
    seen.add(file);
    options.push({ file, isThemeDefault: file === idleFiles[0] });
  }
  return options;
}

function resolveIdleVisualChoice(theme, idleVisualMap) {
  if (!theme || typeof theme !== "object") return null;
  if (!idleVisualMap || typeof idleVisualMap !== "object") return null;
  const themeId = theme._id;
  if (typeof themeId !== "string" || !themeId) return null;
  if (!Object.prototype.hasOwnProperty.call(idleVisualMap, themeId)) return null;
  const file = idleVisualMap[themeId];
  if (typeof file !== "string" || !file) return null;
  const match = listIdleVisualOptions(theme).find((option) => option.file === file);
  // A stored theme default counts as unset so follow-sprite semantics
  // (eye tracking, untouched idle pool) apply exactly as with no pref.
  if (!match || match.isThemeDefault) return null;
  return file;
}

function humanizeIdleVisualLabel(file, themeId) {
  if (typeof file !== "string" || !file) return "";
  let base = file.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
  if (typeof themeId === "string" && themeId) {
    const prefix = `${themeId.toLowerCase()}-`;
    if (base.toLowerCase().startsWith(prefix)) base = base.slice(prefix.length);
  }
  return base
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

module.exports = {
  listIdleVisualOptions,
  resolveIdleVisualChoice,
  humanizeIdleVisualLabel,
};
