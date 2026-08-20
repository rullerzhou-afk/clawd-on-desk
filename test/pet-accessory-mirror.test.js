"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  shouldFlipAssetDirection,
  isAccessoryMirrored,
} = require("../src/pet-accessory-mirror");

const CLAWD = Object.freeze({
  hasRoamVisual: true,   // states.roam is a dedicated visual, not idle[0]
  roamFlipAssets: false, // roam art is drawn facing right
  miniFlipAssets: false,
});

test("free roam mirrors on walk heading alone, with mini mode off", () => {
  // Regression: geometry used to gate mirroring on miniMode, and roam is
  // mutually exclusive with mini mode (src/roam.js), so a left-heading walk
  // drew a mirrored pet against an unmirrored hit box for the whole trip.
  const walkingLeft = { ...CLAWD, roamHeadingLeft: true, inMiniMode: false, miniPreEntryMode: false };
  const walkingRight = { ...CLAWD, roamHeadingLeft: false, inMiniMode: false, miniPreEntryMode: false };

  assert.equal(shouldFlipAssetDirection("roam", walkingLeft), true);
  assert.equal(shouldFlipAssetDirection("roam", walkingRight), false);
  assert.equal(isAccessoryMirrored("roam", walkingLeft), true);
  assert.equal(isAccessoryMirrored("roam", walkingRight), false);
});

test("a theme whose roam art faces left inverts the roam mirror", () => {
  const base = { hasRoamVisual: true, roamFlipAssets: true, miniFlipAssets: false };
  assert.equal(shouldFlipAssetDirection("roam", { ...base, roamHeadingLeft: true }), false);
  assert.equal(shouldFlipAssetDirection("roam", { ...base, roamHeadingLeft: false }), true);
});

test("a theme without a dedicated roam visual never mirrors while roaming", () => {
  const noRoamVisual = { hasRoamVisual: false, roamFlipAssets: false, roamHeadingLeft: true };
  assert.equal(shouldFlipAssetDirection("roam", noRoamVisual), false);
});

test("the menu walk-in mirrors before mini mode finishes switching on", () => {
  // Regression: enterMiniViaMenu sends mini-mode-change(preEntry) and walks for
  // seconds before the miniMode flag flips, so a miniMode-gated predicate had
  // the hit box on the wrong side for the entire walk.
  const preEntry = {
    miniFlipAssets: true,
    inMiniMode: false,
    miniPreEntryMode: true,
    hasRoamVisual: true,
    roamFlipAssets: false,
  };
  assert.equal(shouldFlipAssetDirection("mini-crabwalk", preEntry), true);
  // Only the walk-in visual gets the pre-entry treatment.
  assert.equal(shouldFlipAssetDirection("mini-idle", preEntry), false);
});

test("mini-family visuals mirror once mini mode is active, others never do", () => {
  const active = { miniFlipAssets: true, inMiniMode: true, miniPreEntryMode: false };
  assert.equal(shouldFlipAssetDirection("mini-idle", active), true);
  assert.equal(shouldFlipAssetDirection("mini-peek", active), true);
  // mini-mode-change can land while a transitional visual is still on screen.
  assert.equal(shouldFlipAssetDirection("idle", active), false);
  assert.equal(shouldFlipAssetDirection("working", active), false);
  assert.equal(shouldFlipAssetDirection(null, active), false);
  assert.equal(shouldFlipAssetDirection(undefined, active), false);

  const notFlipTheme = { ...active, miniFlipAssets: false };
  assert.equal(shouldFlipAssetDirection("mini-idle", notFlipTheme), false);
});

test("the two stages compose: the accessory mirrors when they disagree", () => {
  const active = { miniFlipAssets: true, inMiniMode: true, miniPreEntryMode: false };

  // edge-left stage only
  assert.equal(isAccessoryMirrored("idle", { ...active, miniLeftFlip: true }), true);
  // asset-direction stage only
  assert.equal(isAccessoryMirrored("mini-idle", { ...active, miniLeftFlip: false }), true);
  // both -> cancel out
  assert.equal(isAccessoryMirrored("mini-idle", { ...active, miniLeftFlip: true }), false);
  // neither
  assert.equal(isAccessoryMirrored("idle", { ...active, miniLeftFlip: false }), false);
});

test("an absent context never throws and reads as upright", () => {
  assert.equal(shouldFlipAssetDirection("mini-idle"), false);
  assert.equal(isAccessoryMirrored("mini-idle"), false);
  assert.equal(isAccessoryMirrored("roam", {}), false);
});
