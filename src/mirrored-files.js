"use strict";

const { isAccessoryMirrored } = require("./pet-accessory-mirror");

// Clawd draws some visuals mirrored: every mini visual against the left screen
// edge (#pet-facing-stage), a dedicated roam visual while the walk heads left
// and an opted-in idle animation while the pet sits on the right half of its
// display (#pet-asset-direction-stage); pet-accessory-mirror.js owns that rule.
// Raster art with legible glyphs (a scroll, a talisman, code symbols) reads
// backwards once mirrored, so a theme can map such a file to a variant whose
// glyphs are pre-mirrored; the runtime mirror turns them the right way round:
//
//   "mirroredFiles": { "mini-happy.apng": "mini-happy-left.apng" }
//
// main swaps the file while it builds the visual request, so the renderer, the
// settlement ACK and the committed visual all agree on what is on screen.

// Same test as the renderer config (theme-context.js): the visual resolver
// injects exactly states.roam = [idle[0]] as a synthetic fallback, and only a
// dedicated roam visual is mirrored while walking left.
function hasDedicatedRoamVisual(theme) {
  const states = theme && theme.states;
  return !!(states && Array.isArray(states.roam)
    && states.roam.length > 0
    && !(states.roam.length === 1 && Array.isArray(states.idle) && states.roam[0] === states.idle[0]));
}

function getRightSideMirrorFiles(theme) {
  const entries = theme && Array.isArray(theme.idleAnimations) ? theme.idleAnimations : [];
  const followFile = theme && theme.states && Array.isArray(theme.states.idle) ? theme.states.idle[0] : null;
  const files = [];
  for (const entry of entries) {
    if (!entry || entry.mirrorOnRightSide !== true || typeof entry.file !== "string") continue;
    const variant = resolveMirroredFile(theme, entry.file, true);
    // The follow sprite keeps screen-space eye tracking, even when a theme
    // also lists it in the random pool or uses it as a mirrored variant.
    if (entry.file === followFile || variant === followFile) continue;
    files.push(entry.file);
    // The renderer only sees the file actually on screen, which may be the
    // pre-mirrored variant.
    if (variant !== entry.file) files.push(variant);
  }
  return files;
}

function isVisualMirrored(theme, state, {
  miniMode = false,
  miniEdge = "right",
  roamHeadingLeft = false,
  file = null,
  petOnRightSide = false,
} = {}) {
  // The pre-entry walk toward the edge already carries that edge's mirror.
  const preEntryCrabwalk = !miniMode && state === "mini-crabwalk";
  return isAccessoryMirrored(state, {
    miniLeftFlip: (miniMode || preEntryCrabwalk) && miniEdge === "left",
    hasRoamVisual: hasDedicatedRoamVisual(theme),
    roamHeadingLeft,
    roamFlipAssets: !!(theme && theme.roamFlipAssets),
    miniFlipAssets: !!(theme && theme.miniMode && theme.miniMode.flipAssets),
    inMiniMode: miniMode,
    miniPreEntryMode: preEntryCrabwalk,
    file,
    petOnRightSide,
    rightSideMirrorFiles: getRightSideMirrorFiles(theme),
  });
}

function resolveMirroredFile(theme, file, mirrored) {
  if (!mirrored || typeof file !== "string" || !file) return file;
  const files = theme && theme.mirroredFiles;
  if (!files || typeof files !== "object") return file;
  const variant = Object.prototype.hasOwnProperty.call(files, file) ? files[file] : null;
  return typeof variant === "string" && variant ? variant : file;
}

module.exports = { hasDedicatedRoamVisual, getRightSideMirrorFiles, isVisualMirrored, resolveMirroredFile };
