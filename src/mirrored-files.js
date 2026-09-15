"use strict";

const { isAccessoryMirrored } = require("./pet-accessory-mirror");

// Clawd draws some visuals mirrored: every mini visual against the left screen
// edge (#pet-facing-stage) and a dedicated roam visual while the walk heads
// left (#pet-asset-direction-stage); pet-accessory-mirror.js owns that rule.
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

function isVisualMirrored(theme, state, { miniMode = false, miniEdge = "right", roamHeadingLeft = false } = {}) {
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
  });
}

function resolveMirroredFile(theme, file, mirrored) {
  if (!mirrored || typeof file !== "string" || !file) return file;
  const files = theme && theme.mirroredFiles;
  if (!files || typeof files !== "object") return file;
  const variant = Object.prototype.hasOwnProperty.call(files, file) ? files[file] : null;
  return typeof variant === "string" && variant ? variant : file;
}

module.exports = { hasDedicatedRoamVisual, isVisualMirrored, resolveMirroredFile };
