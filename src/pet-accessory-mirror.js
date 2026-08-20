"use strict";

// Which way the accessory ends up facing. The renderer composes two nested
// mirrors; the main process needs the same answer for the native hit window
// but receives it over IPC rather than recomputing it, so this rule has
// exactly one implementation and one place to test:
//
//   #pet-facing-stage          .mini-left            -> mirrors everything
//     #pet-asset-direction-stage  per-state flip     -> mirrors everything below
//       #pet-media-layer / #pet-accessory-layer
//
// Both stages wrap the accessory layer, so the accessory reads mirrored
// exactly when the two stages disagree.
(function exposePetAccessoryMirror(root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else if (root) {
    root.petAccessoryMirror = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createPetAccessoryMirror() {
  /**
   * The asset-direction stage's flip. Note what is NOT here: any dependency on
   * mini mode being active. Free roam mirrors on walk heading alone, and the
   * menu walk-in mirrors while mini mode is still switching on — the two cases
   * a `miniMode && ...` predicate silently gets wrong.
   */
  function shouldFlipAssetDirection(state, context = {}) {
    // Free roam: the dedicated roam visual is drawn facing right; mirror it
    // while the walk heads left. Themes whose roam asset faces left invert it.
    if (state === "roam") {
      return !!context.hasRoamVisual && (!!context.roamHeadingLeft !== !!context.roamFlipAssets);
    }
    // Only mini-family visuals mirror with flipAssets. mini-mode-change can
    // land while a transitional visual (idle, drag reaction) is still on
    // screen — those keep their orientation until the mini swap happens.
    if (typeof state !== "string" || !state.startsWith("mini-")) return false;
    return !!context.miniFlipAssets
      && (!!context.inMiniMode || (!!context.miniPreEntryMode && state === "mini-crabwalk"));
  }

  /** Net facing of the accessory: the two stages composed. */
  function isAccessoryMirrored(state, context = {}) {
    return !!context.miniLeftFlip !== shouldFlipAssetDirection(state, context);
  }

  return {
    shouldFlipAssetDirection,
    isAccessoryMirrored,
  };
});
