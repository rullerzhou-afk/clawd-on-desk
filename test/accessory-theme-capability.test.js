"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
const { buildThemeMetadata } = require("../src/theme-metadata");
const {
  collectRequiredAssetFiles,
  projectThemeVisualUsages,
} = require("../src/theme-schema");

const ROOT = path.join(__dirname, "..");
const THEMES_DIR = path.join(ROOT, "themes");

themeLoader.init(path.join(ROOT, "src"));

function readRawTheme(themeId) {
  return JSON.parse(
    fs.readFileSync(path.join(THEMES_DIR, themeId, "theme.json"), "utf8")
  );
}

function capabilityPair(themeId) {
  const raw = readRawTheme(themeId);
  const themeDir = path.join(THEMES_DIR, themeId);
  const metadata = buildThemeMetadata(themeId, raw, true, themeDir);
  const normalized = themeLoader.loadTheme(themeId, { strict: true });
  return { raw, metadata, normalized };
}

function assertDeclaredTargetsExist(themeId, raw) {
  const files = raw.customization.accessories.files || {};
  for (const [file, descriptor] of Object.entries(files)) {
    const targetId = descriptor.followTarget && descriptor.followTarget.id;
    if (!targetId) continue;
    const localPath = path.join(THEMES_DIR, themeId, "assets", file);
    const assetPath = fs.existsSync(localPath)
      ? localPath
      : path.join(ROOT, "assets", "svg", file);
    const source = fs.readFileSync(assetPath, "utf8");
    assert.ok(
      source.includes(`id="${targetId}"`) || source.includes(`id='${targetId}'`),
      `${themeId}/${file} should contain the exact follow target ${targetId}`
    );
  }
}

describe("built-in accessory capability contracts", () => {
  it("keeps raw metadata and normalized runtime capability aligned", () => {
    for (const [themeId, expected] of [
      ["clawd", true],
      ["cloudling", true],
      ["calico", false],
    ]) {
      const { metadata, normalized } = capabilityPair(themeId);
      assert.strictEqual(metadata.capabilities.accessories, expected, `${themeId} metadata`);
      assert.strictEqual(normalized._capabilities.accessories, expected, `${themeId} runtime`);
      assert.strictEqual(
        metadata.capabilities.accessories,
        normalized._capabilities.accessories,
        `${themeId} raw/normalized parity`
      );
    }
  });

  it("projects every Clawd visual usage and verifies its exact dynamic targets", () => {
    const { raw, normalized } = capabilityPair("clawd");
    const usages = projectThemeVisualUsages(raw);
    const files = collectRequiredAssetFiles(raw);

    assert.strictEqual(usages.length, 49);
    assert.strictEqual(files.length, 36);
    assert.strictEqual(normalized._capabilities.accessories, true);
    assertDeclaredTargetsExist("clawd", raw);

    for (const hidden of [
      "clawd-error.svg",
      "clawd-collapse-sleep.svg",
      "clawd-wake.svg",
      "clawd-mini-enter-sleep.svg",
      "clawd-mini-sleep.svg",
    ]) {
      assert.strictEqual(raw.customization.accessories.files[hidden].visibility, "hidden");
      assert.ok(usages.some((usage) => usage.file === hidden), `${hidden} should be reachable`);
    }

    const buildingTier = raw.workingTiers.find(({ minSessions }) => minSessions === 3);
    assert.deepStrictEqual(buildingTier, {
      minSessions: 3,
      file: "clawd-working-building.svg",
    });
    const buildingAccessory =
      raw.customization.accessories.files[buildingTier.file];
    assert.deepStrictEqual(
      buildingAccessory.staticFrame,
      { cx: 7.5, baseY: 1, width: 16 },
      "the 3+ session accessory should sit on top of the built-in safety helmet"
    );
    assert.strictEqual(buildingAccessory.followTarget.id, "accessory-anchor");
    assert.deepStrictEqual(
      buildingAccessory.followTarget.frame,
      buildingAccessory.staticFrame
    );
    for (const tier of raw.workingTiers) {
      assert.notStrictEqual(
        raw.customization.accessories.files[tier.file].visibility,
        "hidden",
        `${tier.minSessions}-session working accessories should remain visible`
      );
    }
    assert.deepStrictEqual(raw.fileHitBoxes["clawd-working-typing.svg"], {
      x: -2, y: -7, w: 20, h: 24,
    });
    assert.strictEqual(
      raw.fileHitBoxes["clawd-headphones-groove.svg"],
      undefined,
      "the 2-session base hitbox must not reserve empty accessory space"
    );
    assert.deepStrictEqual(raw.fileHitBoxes["clawd-working-building.svg"], {
      x: -1, y: -2, w: 17, h: 19,
    });

    const sleeping = raw.customization.accessories.files["clawd-sleeping.svg"];
    assert.deepStrictEqual(sleeping.staticFrame, { cx: 7.5, baseY: 10, width: 16 });
    assert.strictEqual(sleeping.followTarget.id, "torso-sploot");
    assert.deepStrictEqual(sleeping.followTarget.frame, sleeping.staticFrame);
  });

  it("anchors Clawd idle accessories inside the breathing transform", () => {
    const raw = readRawTheme("clawd");
    const idleDescriptor =
      raw.customization.accessories.files["clawd-idle-follow.svg"];
    assert.strictEqual(idleDescriptor.followTarget.id, "torso");

    const source = fs.readFileSync(
      path.join(ROOT, "assets", "svg", "clawd-idle-follow.svg"),
      "utf8"
    );
    assert.match(
      source,
      /<g class="breathe-anim">[\s\S]*?<rect id="torso"/,
      "the exact target must inherit the visible body's breathing transform"
    );
  });

  it("projects all Cloudling usages including DND and verifies exact dynamic targets", () => {
    const { raw, normalized } = capabilityPair("cloudling");
    const usages = projectThemeVisualUsages(raw);
    const files = collectRequiredAssetFiles(raw);

    assert.strictEqual(usages.length, 41);
    assert.strictEqual(files.length, 29);
    assert.strictEqual(normalized._capabilities.accessories, true);
    assert.ok(files.includes("cloudling-idle-to-sleeping.svg"));
    assert.ok(
      usages.some((usage) => (
        usage.file === "cloudling-idle-to-sleeping.svg"
        && usage.source === "timings.dndSleepTransitionSvg"
      ))
    );
    assertDeclaredTargetsExist("cloudling", raw);

    for (const hidden of [
      "cloudling-idle-to-sleeping.svg",
      "cloudling-dozing-to-sleeping.svg",
      "cloudling-sleeping.svg",
      "cloudling-sleeping-static.png",
      "cloudling-sleeping-to-idle.svg",
      "cloudling-mini-enter-sleep.svg",
      "cloudling-mini-sleep.svg",
    ]) {
      assert.strictEqual(raw.customization.accessories.files[hidden].visibility, "hidden");
      assert.ok(usages.some((usage) => usage.file === hidden), `${hidden} should be reachable`);
    }
  });
});
