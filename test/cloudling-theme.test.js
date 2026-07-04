"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
const hitGeometry = require("../src/hit-geometry");

themeLoader.init(path.join(__dirname, "..", "src"));

const CLOUDLING_ASSETS = [
  "cloudling-attention.svg",
  "cloudling-building.svg",
  "cloudling-carrying.svg",
  "cloudling-conducting.svg",
  "cloudling-dozing-to-sleeping.svg",
  "cloudling-dozing.svg",
  "cloudling-error.svg",
  "cloudling-idle-reading.svg",
  "cloudling-idle-to-dozing.svg",
  "cloudling-idle-to-sleeping.svg",
  "cloudling-idle.svg",
  "cloudling-juggling.svg",
  "cloudling-mini-alert.svg",
  "cloudling-mini-crabwalk.svg",
  "cloudling-mini-enter-roll-in.svg",
  "cloudling-mini-enter-sleep.svg",
  "cloudling-mini-happy.svg",
  "cloudling-mini-idle.svg",
  "cloudling-mini-peek.svg",
  "cloudling-mini-sleep.svg",
  "cloudling-mini-typing.svg",
  "cloudling-notification.svg",
  "cloudling-react-drag.svg",
  "cloudling-sleeping-to-idle.svg",
  "cloudling-sleeping-static.png",
  "cloudling-sleeping.svg",
  "cloudling-sweeping.svg",
  "cloudling-thinking.svg",
  "cloudling-typing.svg",
];

const CLOUDLING_SCRIPTED_FILES = CLOUDLING_ASSETS.filter((file) => file.endsWith(".svg") && file !== "cloudling-react-drag.svg");

describe("built-in Cloudling theme", () => {
  it("loads as schema v1 with trusted scripted SVG files scoped to the built-in theme", () => {
    const theme = themeLoader.loadTheme("cloudling", { strict: true });
    const rendererConfig = themeLoader.createThemeContext(theme).getRendererConfig();

    assert.strictEqual(theme.schemaVersion, 1);
    assert.strictEqual(theme._builtin, true);
    assert.deepStrictEqual(theme.trustedRuntime.scriptedSvgFiles, CLOUDLING_SCRIPTED_FILES);
    assert.strictEqual(Object.keys(theme.trustedRuntime.scriptedSvgCycleMs || {}).length, CLOUDLING_SCRIPTED_FILES.length);
    assert.strictEqual(theme.trustedRuntime.scriptedSvgCycleMs["cloudling-building.svg"], 5400);
    assert.strictEqual(theme.trustedRuntime.scriptedSvgCycleMs["cloudling-sweeping.svg"], 4550);
    assert.strictEqual(theme.trustedRuntime.scriptedSvgCycleMs["cloudling-react-drag.svg"], undefined);
    assert.deepStrictEqual(rendererConfig.trustedScriptedSvgFiles, CLOUDLING_SCRIPTED_FILES);
    assert.deepStrictEqual(rendererConfig.rendering.lowPowerStaticImageOverrides, {
      sleeping: {
        from: "cloudling-sleeping.svg",
        to: "cloudling-sleeping-static.png",
      },
    });
    assert.strictEqual(theme.miniMode.states["mini-crabwalk"][0], "cloudling-mini-crabwalk.svg");
    assert.strictEqual(theme.trustedRuntime.scriptedSvgFiles.includes("cloudling-react-drag.svg"), false);

    for (const file of CLOUDLING_ASSETS) {
      assert.ok(
        fs.existsSync(path.join(__dirname, "..", "themes", "cloudling", "assets", file)),
        `${file} should exist in the Cloudling asset folder`
      );
    }
  });

  it("maps the full Cloudling Phase 2 state set", () => {
    const theme = themeLoader.loadTheme("cloudling", { strict: true });

    assert.deepStrictEqual(theme.states.idle, ["cloudling-idle.svg"]);
    assert.deepStrictEqual(theme.states.thinking, ["cloudling-thinking.svg"]);
    assert.deepStrictEqual(theme.states.working, ["cloudling-typing.svg"]);
    assert.deepStrictEqual(theme.states.juggling, ["cloudling-juggling.svg"]);
    assert.deepStrictEqual(theme.states.attention, ["cloudling-attention.svg"]);
    assert.deepStrictEqual(theme.states.notification, ["cloudling-notification.svg"]);
    assert.deepStrictEqual(theme.states.error, ["cloudling-error.svg"]);
    assert.deepStrictEqual(theme.states.sweeping, ["cloudling-sweeping.svg"]);
    assert.deepStrictEqual(theme.states.carrying, ["cloudling-carrying.svg"]);
    assert.deepStrictEqual(theme.states.sleeping, ["cloudling-sleeping.svg"]);
    assert.deepStrictEqual(theme.states.yawning, ["cloudling-idle-to-dozing.svg"]);
    assert.deepStrictEqual(theme.states.dozing, ["cloudling-dozing.svg"]);
    assert.deepStrictEqual(theme.states.collapsing, ["cloudling-dozing-to-sleeping.svg"]);
    assert.deepStrictEqual(theme.states.waking, ["cloudling-sleeping-to-idle.svg"]);
    assert.strictEqual(theme.sleepSequence.mode, "full");
    assert.strictEqual(theme.timings.dndSleepTransitionSvg, "cloudling-idle-to-sleeping.svg");
    assert.strictEqual(theme.timings.dndSleepTransitionDuration, 4850);
    assert.strictEqual(theme.timings.minDisplay.attention, 3660);
    assert.strictEqual(theme.timings.autoReturn.attention, 3660);
    assert.strictEqual(theme.timings.minDisplay.carrying, 4500);
    assert.strictEqual(theme.timings.autoReturn.carrying, 4500);

    assert.deepStrictEqual(theme.workingTiers.map((tier) => tier.file), [
      "cloudling-building.svg",
      "cloudling-juggling.svg",
      "cloudling-typing.svg",
    ]);
    assert.deepStrictEqual(theme.jugglingTiers.map((tier) => tier.file), [
      "cloudling-conducting.svg",
      "cloudling-juggling.svg",
    ]);
    assert.deepStrictEqual(theme.idleAnimations, [
      { file: "cloudling-idle-reading.svg", duration: 14000 },
    ]);
    assert.deepStrictEqual(theme.miniMode.states["mini-working"], ["cloudling-mini-typing.svg"]);
    assert.deepStrictEqual(theme.reactions.drag, { file: "cloudling-react-drag.svg" });
    assert.strictEqual(theme.updateVisuals.checking, "cloudling-thinking.svg");
  });

  it("resolves Cloudling viewBoxes for normal, mini, and mini-crabwalk files", () => {
    const theme = themeLoader.loadTheme("cloudling", { strict: true });

    assert.deepStrictEqual(
      hitGeometry.resolveViewBox(theme, "working", "cloudling-building.svg"),
      { x: -32, y: -24, width: 88, height: 72 }
    );
    assert.deepStrictEqual(
      hitGeometry.resolveViewBox(theme, "mini-idle", "cloudling-mini-idle.svg"),
      { x: -12, y: -12, width: 48, height: 48 }
    );
    assert.deepStrictEqual(
      hitGeometry.resolveViewBox(theme, "mini-crabwalk", "cloudling-mini-crabwalk.svg"),
      { x: -32, y: -24, width: 88, height: 72 }
    );
  });

  it("uses object-channel for built-in scripted files without granting that to external-like themes", () => {
    const theme = themeLoader.loadTheme("cloudling", { strict: true });
    const externalLikeTheme = { ...theme, _builtin: false };

    assert.strictEqual(
      hitGeometry.usesObjectChannel(theme, "working", "cloudling-building.svg"),
      true
    );
    assert.strictEqual(
      hitGeometry.usesObjectChannel(externalLikeTheme, "working", "cloudling-building.svg"),
      false
    );
    assert.strictEqual(
      hitGeometry.usesObjectChannel(theme, "drag", "cloudling-react-drag.svg"),
      false
    );
  });

  it("treats Cloudling mini-crabwalk as a normal-layout pre-entry asset", () => {
    const theme = themeLoader.loadTheme("cloudling", { strict: true });
    const bounds = { x: 0, y: 0, width: 200, height: 200 };

    assert.strictEqual(hitGeometry.usesNormalizedLayout(
      theme,
      "mini-crabwalk",
      "cloudling-mini-crabwalk.svg"
    ), true);
    assert.strictEqual(hitGeometry.usesNormalizedLayout(
      theme,
      "mini-idle",
      "cloudling-mini-idle.svg"
    ), false);

    const crabwalk = hitGeometry.getAssetRectScreen(
      theme,
      bounds,
      "mini-crabwalk",
      "cloudling-mini-crabwalk.svg"
    );

    assert.ok(crabwalk.w > bounds.width, "mini-crabwalk should use normal normalized layout");
  });

  it("exposes temporary pointer bridge shims in the prototype idle assets", () => {
    for (const file of ["cloudling-idle.svg", "cloudling-mini-idle.svg"]) {
      const assetPath = path.join(__dirname, "..", "themes", "cloudling", "assets", file);
      const sourcePath = path.join(__dirname, "..", "assets", "source", "cloudling-pointer-bridge", file);
      const asset = fs.readFileSync(assetPath, "utf8");
      const source = fs.readFileSync(sourcePath, "utf8");

      assert.ok(asset.includes("window.__cloudlingSetPointer = payload =>"), `${file} should expose the bridge API`);
      assert.ok(source.includes("window.__cloudlingSetPointer = payload =>"), `${file} source copy should mirror the bridge API`);
    }
  });

  it("lets low-power idle mode stop Cloudling idle RAF loops", () => {
    const checks = [
      {
        file: "cloudling-idle.svg",
        source: path.join("assets", "source", "cloudling-pointer-bridge", "cloudling-idle.svg"),
      },
      {
        file: "cloudling-mini-idle.svg",
        source: path.join("assets", "source", "cloudling-pointer-bridge", "cloudling-mini-idle.svg"),
      },
      {
        file: "cloudling-dozing.svg",
        source: path.join("assets", "source", "cloudling-low-power", "cloudling-dozing.svg"),
      },
    ];

    for (const { file, source } of checks) {
      const asset = fs.readFileSync(path.join(__dirname, "..", "themes", "cloudling", "assets", file), "utf8");
      const sourceCopy = fs.readFileSync(path.join(__dirname, "..", source), "utf8");

      for (const content of [asset, sourceCopy]) {
        assert.ok(content.includes("window.__clawdSetLowPowerPaused = paused =>"), `${file} should expose a low-power pause API`);
        assert.ok(content.includes("cancelAnimationFrame(rafId)"), `${file} should cancel its RAF while paused`);
        assert.ok(content.includes("function scheduleLoop()"), `${file} should restart RAF explicitly on resume`);
      }
    }
  });

  it("uses a visible normal idle eye-follow range for bridge validation", () => {
    const asset = fs.readFileSync(
      path.join(__dirname, "..", "themes", "cloudling", "assets", "cloudling-idle.svg"),
      "utf8"
    );
    const source = fs.readFileSync(
      path.join(__dirname, "..", "assets", "source", "cloudling-pointer-bridge", "cloudling-idle.svg"),
      "utf8"
    );

    assert.ok(asset.includes("EYE_MAX: 1.20"), "normal idle should use the tuned bridge-validation eye range");
    assert.ok(asset.includes("EYE_TRACK_TIME: 0.06"), "normal idle should smooth bridged eye movement");
    assert.ok(asset.includes("const eyeScale = curDistScale"), "normal idle should scale eyes with distance-driven body scale");
    assert.ok(source.includes("EYE_MAX: 1.20"), "source copy should mirror the tuned eye range");
    assert.ok(source.includes("EYE_TRACK_TIME: 0.06"), "source copy should mirror the eye smoothing");
    assert.ok(source.includes("const eyeScale = curDistScale"), "source copy should mirror the distance-driven eye scale");
  });

  it("uses tuned mini idle eye-follow and distance scaling for bridge validation", () => {
    const asset = fs.readFileSync(
      path.join(__dirname, "..", "themes", "cloudling", "assets", "cloudling-mini-idle.svg"),
      "utf8"
    );
    const source = fs.readFileSync(
      path.join(__dirname, "..", "assets", "source", "cloudling-pointer-bridge", "cloudling-mini-idle.svg"),
      "utf8"
    );

    assert.ok(asset.includes("eyeMax: 2.05"), "mini idle should use the tuned horizontal eye range");
    assert.ok(asset.includes("yClamp: 0.85"), "mini idle should allow a wider vertical eye range");
    assert.ok(asset.includes("distMaxScale: 1.15"), "mini idle should match normal idle distance scaling");
    assert.ok(asset.includes("eyeTrack: 0.06"), "mini idle should smooth bridged eye movement");
    assert.ok(asset.includes("const eyeScale = currentDistScale"), "mini idle should scale eyes with distance-driven body scale");
    assert.ok(source.includes("eyeMax: 2.05"), "source copy should mirror the tuned horizontal eye range");
    assert.ok(source.includes("yClamp: 0.85"), "source copy should mirror the wider vertical eye range");
    assert.ok(source.includes("distMaxScale: 1.15"), "source copy should mirror normal idle distance scaling");
    assert.ok(source.includes("eyeTrack: 0.06"), "source copy should mirror the eye smoothing");
    assert.ok(source.includes("const eyeScale = currentDistScale"), "source copy should mirror the distance-driven eye scale");
  });

  it("lets mini sleep pre-mirror Zzz glyphs for left-edge mini mode", () => {
    const asset = fs.readFileSync(
      path.join(__dirname, "..", "themes", "cloudling", "assets", "cloudling-mini-sleep.svg"),
      "utf8"
    );

    assert.ok(asset.includes("window.__clawdSetGlyphFlipCompensation = enabled =>"));
    assert.ok(asset.includes("const x0 = glyphFlipCompensation ? w / 2 : -w / 2;"));
  });
});
