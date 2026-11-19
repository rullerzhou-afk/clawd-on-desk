"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createSettingsAnimationOverridesMain = require("../src/settings-animation-overrides-main");

const animationOverrideTest = createSettingsAnimationOverridesMain.__test;
const tempDirs = [];

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-theme-appearance-anim-"));
  tempDirs.push(root);
  const lightDir = path.join(root, "assets");
  const darkDir = path.join(root, "assets-dark");
  fs.mkdirSync(lightDir, { recursive: true });
  fs.mkdirSync(darkDir, { recursive: true });
  fs.writeFileSync(path.join(lightDir, "idle.svg"), "<svg viewBox=\"0 0 100 100\"></svg>", "utf8");
  fs.writeFileSync(path.join(lightDir, "shared.png"), "png", "utf8");
  fs.writeFileSync(path.join(darkDir, "idle.svg"), "<svg viewBox=\"0 0 100 100\"></svg>", "utf8");
  fs.writeFileSync(path.join(darkDir, "shared.png"), "png", "utf8");
  fs.writeFileSync(path.join(darkDir, "dark-only.svg"), "<svg viewBox=\"0 0 100 100\"></svg>", "utf8");
  return { root, lightDir, darkDir };
}

function createTheme(fixture) {
  return {
    _id: "night",
    _builtin: false,
    _themeDir: fixture.root,
    _assetsSourceDir: fixture.darkDir,
    _assetsDir: fixture.darkDir,
    _capabilities: {},
    _baseTransitions: {},
    _bindingBase: { states: {}, workingTiers: [], jugglingTiers: [], displayHintMap: {} },
    states: { idle: ["idle.svg"] },
    transitions: {},
    timings: { autoReturn: {} },
    sounds: {},
    trustedRuntime: { scriptedSvgFiles: [], scriptedSvgCycleMs: {} },
    rendering: { svgChannel: "auto" },
  };
}

function createRuntime(fixture, theme) {
  return createSettingsAnimationOverridesMain({
    app: { isPackaged: false, getVersion: () => "1.2.3" },
    BrowserWindow: { fromWebContents: () => null },
    dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) },
    shell: { openPath: async () => "" },
    fs,
    path,
    themeLoader: {
      _resolveAssetPath: (targetTheme, filename) => {
        if (!targetTheme) return null;
        const source = targetTheme._assetsSourceDir || path.join(targetTheme._themeDir, "assets");
        return path.join(source, path.basename(filename));
      },
      getAssetPath: (filename) => path.join(fixture.darkDir, path.basename(filename)),
      getThemeMetadata: (themeId) => ({ name: `Theme ${themeId}` }),
    },
    animationCycle: { probeAssetCycle: () => ({ ms: null, status: "unavailable", source: null }) },
    settingsController: { getSnapshot: () => ({ themeOverrides: {} }), applyCommand: async () => ({ status: "ok" }) },
    getActiveTheme: () => theme,
    getSettingsWindow: () => null,
    getLang: () => "en",
    getThemeReloadInProgress: () => false,
    getStateRuntime: () => ({
      applyState: () => {},
      getCurrentState: () => "idle",
      getDisplayRevision: () => 0,
      isSettingsPreviewVisual: () => false,
      resolveDisplayState: () => "idle",
      getSvgOverride: (state) => `${state}.svg`,
    }),
    sendToRenderer: () => {},
  });
}

describe("issue #1323: theme appearance in animation overrides", () => {
  it("issue #1323: the override picker only lists names from the light assets directory", () => {
    const fixture = makeFixture();
    const theme = createTheme(fixture);
    const runtime = createRuntime(fixture, theme);
    try {
      const names = runtime.listAnimationOverrideAssets(theme).map((asset) => asset.name);
      assert.ok(names.includes("idle.svg"));
      assert.ok(names.includes("shared.png"));
      assert.ok(!names.includes("dark-only.svg"));
    } finally {
      runtime.cleanup();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("issue #1323: same-name assets in the two appearances get separate poster keys", () => {
    const fixture = makeFixture();
    try {
      const theme = createTheme(fixture);
      const lightPath = path.join(fixture.lightDir, "shared.png");
      const darkPath = path.join(fixture.darkDir, "shared.png");
      const stamp = new Date("2025-01-01T00:00:00Z");
      fs.utimesSync(lightPath, stamp, stamp);
      fs.utimesSync(darkPath, stamp, stamp);

      const light = animationOverrideTest.buildAnimationPreviewPosterDescriptor(
        "shared.png",
        theme,
        lightPath
      );
      const dark = animationOverrideTest.buildAnimationPreviewPosterDescriptor(
        "shared.png",
        theme,
        darkPath
      );

      assert.ok(light && dark, "both descriptors must be built");
      assert.strictEqual(light.size, dark.size);
      assert.strictEqual(light.mtime, dark.mtime);
      assert.notStrictEqual(light.cacheKey, dark.cacheKey);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
