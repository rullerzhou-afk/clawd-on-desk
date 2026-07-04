"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const createThemeContext = require("../src/theme-context");

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-theme-context-"));
  const assetsSvgDir = path.join(root, "assets", "svg");
  const assetsSoundsDir = path.join(root, "assets", "sounds");
  fs.mkdirSync(assetsSvgDir, { recursive: true });
  fs.mkdirSync(assetsSoundsDir, { recursive: true });
  return {
    root,
    assetsSvgDir,
    assetsSoundsDir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function makeTheme(overrides = {}) {
  return {
    _id: "theme-a",
    _builtin: false,
    _themeDir: "",
    _assetsDir: "",
    _assetsFileUrl: "",
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    fileViewBoxes: {},
    layout: null,
    eyeTracking: { enabled: false, states: [] },
    miniMode: { supported: false, states: {}, viewBox: null, glyphFlips: {}, flipAssets: false },
    reactions: {},
    states: { idle: ["idle.svg"] },
    rendering: { svgChannel: "auto" },
    objectScale: { widthRatio: 1, heightRatio: 1, offsetX: 0, offsetY: 0 },
    transitions: {},
    sounds: {},
    ...overrides,
  };
}

function writeFile(filePath, content = "x") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

test("explicit contexts resolve independent external asset paths without active-theme state", () => {
  const fixture = makeRoot();
  try {
    const themeADir = path.join(fixture.root, "themes", "a");
    const themeBDir = path.join(fixture.root, "themes", "b");
    const cacheA = path.join(fixture.root, "cache", "a");
    const cacheB = path.join(fixture.root, "cache", "b");
    writeFile(path.join(cacheA, "idle.svg"));
    writeFile(path.join(cacheB, "idle.svg"));
    writeFile(path.join(themeADir, "assets", "idle.apng"));
    writeFile(path.join(themeBDir, "assets", "idle.apng"));

    const themeA = makeTheme({
      _id: "a",
      _themeDir: themeADir,
      _assetsDir: cacheA,
      _assetsFileUrl: pathToFileURL(cacheA).href,
    });
    const themeB = makeTheme({
      _id: "b",
      _themeDir: themeBDir,
      _assetsDir: cacheB,
      _assetsFileUrl: pathToFileURL(cacheB).href,
    });

    const ctxA = createThemeContext(themeA, fixture);
    const ctxB = createThemeContext(themeB, fixture);

    assert.strictEqual(ctxA.resolveAssetPath("idle.svg"), path.join(cacheA, "idle.svg"));
    assert.strictEqual(ctxB.resolveAssetPath("idle.svg"), path.join(cacheB, "idle.svg"));
    assert.strictEqual(ctxA.resolveAssetPath("idle.apng"), path.join(themeADir, "assets", "idle.apng"));
    assert.strictEqual(ctxB.resolveAssetPath("idle.apng"), path.join(themeBDir, "assets", "idle.apng"));
    assert.strictEqual(ctxA.getRendererAssetsPath(), pathToFileURL(cacheA).href);
    assert.strictEqual(ctxB.getRendererAssetsPath(), pathToFileURL(cacheB).href);
    assert.strictEqual(ctxA.getRendererSourceAssetsPath(), pathToFileURL(path.join(themeADir, "assets")).href);
    assert.strictEqual(ctxB.getRendererSourceAssetsPath(), pathToFileURL(path.join(themeBDir, "assets")).href);
  } finally {
    fixture.cleanup();
  }
});

test("null theme contexts return loader-compatible defaults", () => {
  const fixture = makeRoot();
  try {
    const ctx = createThemeContext(null, fixture);

    assert.strictEqual(ctx.resolveAssetPath("idle.svg"), path.join(fixture.assetsSvgDir, "idle.svg"));
    assert.strictEqual(ctx.getRendererAssetsPath(), "../assets/svg");
    assert.strictEqual(ctx.getRendererSourceAssetsPath(), null);
    assert.strictEqual(ctx.getRendererConfig(), null);
    assert.strictEqual(ctx.getHitRendererConfig(), null);
    assert.strictEqual(ctx.getSoundUrl("complete"), null);
    assert.strictEqual(ctx.getPreviewSoundUrl(), null);
  } finally {
    fixture.cleanup();
  }
});

test("built-in contexts prefer theme-local assets and expose relative renderer paths", () => {
  const fixture = makeRoot();
  try {
    const themeDir = path.join(fixture.root, "themes", "calico");
    writeFile(path.join(themeDir, "assets", "idle.apng"));
    writeFile(path.join(fixture.assetsSvgDir, "idle.svg"));

    const theme = makeTheme({
      _id: "calico",
      _builtin: true,
      _themeDir: themeDir,
      states: { idle: ["idle.apng"] },
      sounds: { complete: "complete.mp3" },
    });
    const ctx = createThemeContext(theme, fixture);

    assert.strictEqual(ctx.resolveAssetPath("idle.apng"), path.join(themeDir, "assets", "idle.apng"));
    assert.strictEqual(ctx.resolveAssetPath("idle.svg"), path.join(fixture.assetsSvgDir, "idle.svg"));
    assert.strictEqual(ctx.getRendererAssetsPath(), "../themes/calico/assets");
    assert.strictEqual(ctx.getRendererSourceAssetsPath(), "../themes/calico/assets");
    assert.strictEqual(ctx.getRendererConfig().assetsPath, "../themes/calico/assets");
    assert.strictEqual(ctx.getHitRendererConfig().idleFollowSvg, "idle.apng");
  } finally {
    fixture.cleanup();
  }
});

test("external renderer asset path keeps the legacy default when file URL is absent", () => {
  const fixture = makeRoot();
  try {
    const theme = makeTheme({
      _id: "partial",
      _themeDir: path.join(fixture.root, "themes", "partial"),
      _assetsDir: path.join(fixture.root, "cache", "partial"),
      _assetsFileUrl: null,
    });
    const ctx = createThemeContext(theme, fixture);

    assert.strictEqual(ctx.getRendererAssetsPath(), "../assets/svg");
  } finally {
    fixture.cleanup();
  }
});

test("file URL conversion errors still propagate from source asset URLs", () => {
  const fixture = makeRoot();
  try {
    const theme = makeTheme({
      _id: "external",
      _themeDir: path.join(fixture.root, "themes", "external"),
      _assetsDir: path.join(fixture.root, "cache", "external"),
      _assetsFileUrl: pathToFileURL(path.join(fixture.root, "cache", "external")).href,
    });
    const ctx = createThemeContext(theme, {
      ...fixture,
      pathToFileURL: () => {
        throw new Error("bad file url");
      },
    });

    assert.throws(() => ctx.getRendererSourceAssetsPath(), /bad file url/);
  } finally {
    fixture.cleanup();
  }
});

test("sound URLs prefer overrides and external themes fall back to built-in sounds", () => {
  const fixture = makeRoot();
  try {
    const themeDir = path.join(fixture.root, "themes", "external");
    const overrideDir = path.join(fixture.root, "overrides");
    const overridePath = path.join(overrideDir, "confirm.wav");
    writeFile(overridePath);
    writeFile(path.join(fixture.assetsSoundsDir, "complete.mp3"));

    const theme = makeTheme({
      _id: "external",
      _themeDir: themeDir,
      sounds: {
        confirm: "confirm.mp3",
        complete: "complete.mp3",
      },
      _soundOverrideFiles: {
        confirm: overridePath,
      },
    });
    const ctx = createThemeContext(theme, fixture);

    assert.strictEqual(ctx.getSoundUrl("confirm"), pathToFileURL(overridePath).href);
    assert.strictEqual(ctx.getSoundUrl("complete"), pathToFileURL(path.join(fixture.assetsSoundsDir, "complete.mp3")).href);
    assert.strictEqual(ctx.getPreviewSoundUrl(), pathToFileURL(overridePath).href);
    assert.strictEqual(ctx.getSoundUrl("missing"), null);
  } finally {
    fixture.cleanup();
  }
});

test("renderer config exposes trusted scripted files only for built-in themes", () => {
  const fixture = makeRoot();
  try {
    const builtIn = makeTheme({
      _id: "builtin",
      _builtin: true,
      _themeDir: path.join(fixture.root, "themes", "builtin"),
      trustedRuntime: { scriptedSvgFiles: ["scripted.svg"] },
    });
    const external = makeTheme({
      _id: "external",
      _builtin: false,
      _themeDir: path.join(fixture.root, "themes", "external"),
      _assetsDir: path.join(fixture.root, "cache", "external"),
      _assetsFileUrl: pathToFileURL(path.join(fixture.root, "cache", "external")).href,
      trustedRuntime: { scriptedSvgFiles: ["forged.svg"] },
    });

    assert.deepStrictEqual(
      createThemeContext(builtIn, fixture).getRendererConfig().trustedScriptedSvgFiles,
      ["scripted.svg"]
    );
    assert.deepStrictEqual(
      createThemeContext(external, fixture).getRendererConfig().trustedScriptedSvgFiles,
      []
    );
  } finally {
    fixture.cleanup();
  }
});

test("getRendererConfig reports hasRoamVisual only for a dedicated roam binding", () => {
  const fixture = makeRoot();
  try {
    // No roam binding at all — nothing dedicated.
    const ctxNone = createThemeContext(makeTheme(), fixture);
    assert.strictEqual(ctxNone.getRendererConfig().hasRoamVisual, false);

    // Synthetic fallback shape (the visual resolver injects roam = [idle[0]])
    // — still not a dedicated visual, renderer keeps its roam-walk bob.
    const ctxSynthetic = createThemeContext(makeTheme({
      states: { idle: ["idle.svg"], roam: ["idle.svg"] },
    }), fixture);
    assert.strictEqual(ctxSynthetic.getRendererConfig().hasRoamVisual, false);

    // Dedicated roam visual — renderer drops the bob and enables heading flips.
    const ctxDedicated = createThemeContext(makeTheme({
      states: { idle: ["idle.svg"], roam: ["crabwalk.svg"] },
    }), fixture);
    assert.strictEqual(ctxDedicated.getRendererConfig().hasRoamVisual, true);

    // Multi-entry bindings are author intent, not the resolver's synthetic
    // single-entry fallback — dedicated regardless of entry order or an idle
    // file appearing among them (the resolver picks randomly from the array).
    const ctxMultiTail = createThemeContext(makeTheme({
      states: { idle: ["idle.svg"], roam: ["idle.svg", "walk.svg"] },
    }), fixture);
    assert.strictEqual(ctxMultiTail.getRendererConfig().hasRoamVisual, true);

    const ctxMultiHead = createThemeContext(makeTheme({
      states: { idle: ["idle.svg"], roam: ["walk.svg", "idle.svg"] },
    }), fixture);
    assert.strictEqual(ctxMultiHead.getRendererConfig().hasRoamVisual, true);
  } finally {
    fixture.cleanup();
  }
});
