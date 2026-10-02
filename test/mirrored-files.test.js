"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  hasDedicatedRoamVisual,
  getRightSideMirrorFiles,
  isVisualMirrored,
  resolveMirroredFile,
} = require("../src/mirrored-files");

const theme = {
  states: { idle: ["idle.apng"], roam: ["roam.apng"] },
  miniMode: { states: {} },
  mirroredFiles: { "mini-happy.apng": "mini-happy-left.apng", "roam.apng": "roam-left.apng" },
};

describe("getRightSideMirrorFiles", () => {
  it("keeps follow-idle and its variant out of the mirror pool", () => {
    const withFollow = {
      states: { idle: ["idle.svg"] },
      mirroredFiles: { "idle.svg": "idle-left.svg", "bubble.svg": "bubble-left.svg" },
      idleAnimations: [
        { file: "idle.svg", duration: 5000, mirrorOnRightSide: true },
        { file: "bubble.svg", duration: 5000, mirrorOnRightSide: true },
      ],
    };
    assert.deepStrictEqual(getRightSideMirrorFiles(withFollow), ["bubble.svg", "bubble-left.svg"]);
    assert.strictEqual(isVisualMirrored(withFollow, "idle", { file: "idle.svg", petOnRightSide: true }), false);
    assert.strictEqual(isVisualMirrored(withFollow, "idle", { file: "idle-left.svg", petOnRightSide: true }), false);
    assert.strictEqual(isVisualMirrored(withFollow, "idle", { file: "bubble.svg", petOnRightSide: true }), true);
  });

  it("ignores an opt-in entry whose mirrored variant is follow-idle", () => {
    const withFollowVariant = {
      states: { idle: ["idle.svg"] },
      mirroredFiles: { "bubble.svg": "idle.svg" },
      idleAnimations: [{ file: "bubble.svg", duration: 5000, mirrorOnRightSide: true }],
    };
    assert.deepStrictEqual(getRightSideMirrorFiles(withFollowVariant), []);
    assert.strictEqual(isVisualMirrored(withFollowVariant, "idle", { file: "bubble.svg", petOnRightSide: true }), false);
  });

  it("lists opted-in idle animations plus their pre-mirrored variants", () => {
    const withVariants = {
      mirroredFiles: { "bubble.apng": "bubble-left.apng" },
      idleAnimations: [
        { file: "look.apng", duration: 5000 },
        { file: "bubble.apng", duration: 5000, mirrorOnRightSide: true },
        { file: "sparks.apng", duration: 5000, mirrorOnRightSide: true },
        null,
      ],
    };
    assert.deepStrictEqual(getRightSideMirrorFiles(withVariants), ["bubble.apng", "bubble-left.apng", "sparks.apng"]);
    assert.deepStrictEqual(getRightSideMirrorFiles({}), []);
    assert.deepStrictEqual(getRightSideMirrorFiles(null), []);
  });
});

describe("isVisualMirrored", () => {
  it("mirrors mini visuals only against the left edge", () => {
    assert.strictEqual(isVisualMirrored(theme, "mini-happy", { miniMode: true, miniEdge: "left" }), true);
    assert.strictEqual(isVisualMirrored(theme, "mini-happy", { miniMode: true, miniEdge: "right" }), false);
    assert.strictEqual(isVisualMirrored(theme, "idle", { miniMode: false, miniEdge: "left" }), false);
    assert.strictEqual(isVisualMirrored(theme, "mini-happy"), false);
  });

  it("mirrors an opted-in idle animation only on the right half of the display", () => {
    const bubbleTheme = {
      ...theme,
      idleAnimations: [
        { file: "look.apng", duration: 5000 },
        { file: "bubble.apng", duration: 5000, mirrorOnRightSide: true },
      ],
    };
    assert.strictEqual(isVisualMirrored(bubbleTheme, "idle", { file: "bubble.apng", petOnRightSide: true }), true);
    assert.strictEqual(isVisualMirrored(bubbleTheme, "idle", { file: "bubble.apng", petOnRightSide: false }), false);
    assert.strictEqual(isVisualMirrored(bubbleTheme, "idle", { file: "look.apng", petOnRightSide: true }), false);
  });

  it("mirrors the pre-entry crabwalk toward the left edge before mini mode starts", () => {
    assert.strictEqual(isVisualMirrored(theme, "mini-crabwalk", { miniMode: false, miniEdge: "left" }), true);
    assert.strictEqual(isVisualMirrored(theme, "mini-crabwalk", { miniMode: false, miniEdge: "right" }), false);
  });

  it("mirrors a dedicated roam visual while the walk heads left", () => {
    assert.strictEqual(isVisualMirrored(theme, "roam", { roamHeadingLeft: true }), true);
    assert.strictEqual(isVisualMirrored(theme, "roam", { roamHeadingLeft: false }), false);
    // art drawn facing left mirrors on the rightward walk instead
    assert.strictEqual(isVisualMirrored({ ...theme, roamFlipAssets: true }, "roam", { roamHeadingLeft: false }), true);
    // the synthetic idle fallback is never mirrored (it gets the walking bob)
    const synthetic = { states: { idle: ["idle.apng"], roam: ["idle.apng"] } };
    assert.strictEqual(isVisualMirrored(synthetic, "roam", { roamHeadingLeft: true }), false);
  });

  it("follows miniMode.flipAssets for mini art drawn for the left edge", () => {
    const leftDrawn = { ...theme, miniMode: { flipAssets: true } };
    assert.strictEqual(isVisualMirrored(leftDrawn, "mini-happy", { miniMode: true, miniEdge: "left" }), false);
    assert.strictEqual(isVisualMirrored(leftDrawn, "mini-happy", { miniMode: true, miniEdge: "right" }), true);
  });
});

describe("resolveMirroredFile", () => {
  it("swaps in the variant only while the visual is mirrored", () => {
    assert.strictEqual(resolveMirroredFile(theme, "mini-happy.apng", true), "mini-happy-left.apng");
    assert.strictEqual(resolveMirroredFile(theme, "roam.apng", true), "roam-left.apng");
    assert.strictEqual(resolveMirroredFile(theme, "mini-happy.apng", false), "mini-happy.apng");
  });

  it("leaves files without a variant, and themes without the map, untouched", () => {
    assert.strictEqual(resolveMirroredFile(theme, "mini-idle.apng", true), "mini-idle.apng");
    assert.strictEqual(resolveMirroredFile({}, "mini-happy.apng", true), "mini-happy.apng");
    assert.strictEqual(resolveMirroredFile(null, "mini-happy.apng", true), "mini-happy.apng");
    assert.strictEqual(resolveMirroredFile(theme, null, true), null);
  });

  it("ignores inherited keys and non-string variants", () => {
    const inherited = { mirroredFiles: Object.create({ "a.apng": "a-left.apng" }) };
    assert.strictEqual(resolveMirroredFile(inherited, "a.apng", true), "a.apng");
    assert.strictEqual(resolveMirroredFile(theme, "toString", true), "toString");
    assert.strictEqual(resolveMirroredFile({ mirroredFiles: { "a.apng": 5 } }, "a.apng", true), "a.apng");
    assert.strictEqual(resolveMirroredFile({ mirroredFiles: { "a.apng": "" } }, "a.apng", true), "a.apng");
  });
});

describe("hasDedicatedRoamVisual", () => {
  it("treats only a non-idle roam binding as dedicated", () => {
    assert.strictEqual(hasDedicatedRoamVisual(theme), true);
    assert.strictEqual(hasDedicatedRoamVisual({ states: { idle: ["i.apng"], roam: ["i.apng"] } }), false);
    assert.strictEqual(hasDedicatedRoamVisual({ states: { idle: ["i.apng"] } }), false);
    assert.strictEqual(hasDedicatedRoamVisual({ states: { idle: ["i.apng"], roam: ["i.apng", "w.apng"] } }), true);
    assert.strictEqual(hasDedicatedRoamVisual(null), false);
  });
});
