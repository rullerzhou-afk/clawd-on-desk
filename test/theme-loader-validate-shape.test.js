const { describe, it, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
const { collectRequiredAssetFiles } = require("../src/theme-schema");
const { checkThemeHealth } = require("../src/doctor-detectors/theme-health");

const tempDirs = [];
const REQUIRED_FILES = [
  "idle.svg",
  "yawning.svg",
  "dozing.svg",
  "collapsing.svg",
  "thinking.svg",
  "working.svg",
  "sleeping.svg",
  "waking.svg",
];

function validThemeJson(overrides = {}) {
  return {
    schemaVersion: 1,
    name: "Test",
    version: "1.0.0",
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    states: {
      idle: ["idle.svg"],
      yawning: ["yawning.svg"],
      dozing: ["dozing.svg"],
      collapsing: ["collapsing.svg"],
      thinking: ["thinking.svg"],
      working: ["working.svg"],
      sleeping: ["sleeping.svg"],
      waking: ["waking.svg"],
    },
    ...overrides,
  };
}

function makeFixture({ builtinThemes = [], userThemes = [], centralAssets = REQUIRED_FILES } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-theme-shape-"));
  tempDirs.push(tmp);
  const appDir = path.join(tmp, "src");
  const userData = path.join(tmp, "userData");
  fs.mkdirSync(path.join(tmp, "themes"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "assets", "svg"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "assets", "sounds"), { recursive: true });
  fs.mkdirSync(path.join(userData, "themes"), { recursive: true });
  fs.mkdirSync(appDir, { recursive: true });
  for (const file of centralAssets) {
    fs.writeFileSync(path.join(tmp, "assets", "svg", file), "<svg/>", "utf8");
  }

  function writeTheme(baseRoot, theme) {
    const themeDir = path.join(baseRoot, theme.id);
    fs.mkdirSync(themeDir, { recursive: true });
    fs.writeFileSync(path.join(themeDir, "theme.json"), JSON.stringify(theme.json), "utf8");
    if (theme.assets) {
      const assetsDir = path.join(themeDir, "assets");
      fs.mkdirSync(assetsDir, { recursive: true });
      for (const [file, content] of Object.entries(theme.assets)) {
        fs.writeFileSync(path.join(assetsDir, file), content, "utf8");
      }
    }
  }

  for (const theme of builtinThemes) writeTheme(path.join(tmp, "themes"), theme);
  for (const theme of userThemes) writeTheme(path.join(userData, "themes"), theme);
  themeLoader.init(appDir, userData);
  return { tmp, appDir, userData };
}

function assetMap(files = REQUIRED_FILES) {
  return Object.fromEntries(files.map((file) => [file, "<svg/>"]));
}

afterEach(() => {
  mock.restoreAll();
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("validateThemeShape", () => {
  it("drops missing selectable-only assets without failing load or shape validation", () => {
    makeFixture({
      builtinThemes: [{ id: "clawd", json: validThemeJson({ name: "Clawd" }) }],
      userThemes: [{
        id: "selectable",
        json: validThemeJson({ idleVisualOptions: [
          { file: "pool.apng" }, { file: "missing.apng" }, { file: 12 }, {},
        ] }),
        assets: { ...assetMap(), "pool.apng": "image" },
      }],
    });
    const warning = mock.method(console, "warn", () => {});
    assert.strictEqual(themeLoader.validateThemeShape("selectable").ok, true);
    const theme = themeLoader.loadTheme("selectable", { strict: true });
    assert.deepStrictEqual(theme.idleVisualOptions, [{ file: "pool.apng" }]);
    assert.ok(collectRequiredAssetFiles(theme).includes("pool.apng"));
    assert.ok(!collectRequiredAssetFiles(theme).includes("missing.apng"));
    assert.ok(warning.mock.calls.some((call) => /missing asset missing\.apng/.test(call.arguments[0])));
    assert.ok(warning.mock.calls.some((call) => /file must be a safe basename/.test(call.arguments[0])));
  });

  it("loads a variant's replacement selectable-only options", () => {
    makeFixture({
      builtinThemes: [{ id: "clawd", json: validThemeJson({ name: "Clawd" }) }],
      userThemes: [{
        id: "variant-options",
        json: validThemeJson({
          idleVisualOptions: [{ file: "base.apng" }],
          variants: { lounge: { idleVisualOptions: [{ file: "lounge.apng" }] } },
        }),
        assets: { ...assetMap(), "base.apng": "base", "lounge.apng": "lounge" },
      }],
    });
    const base = themeLoader.loadTheme("variant-options", { strict: true });
    const lounge = themeLoader.loadTheme("variant-options", { strict: true, variant: "lounge" });
    assert.deepStrictEqual(base.idleVisualOptions, [{ file: "base.apng" }]);
    assert.deepStrictEqual(lounge.idleVisualOptions, [{ file: "lounge.apng" }]);
    assert.strictEqual(themeLoader.validateThemeShape("variant-options", { variant: "lounge" }).ok, true);
  });


  it("validates a built-in theme using central clawd assets without activating a theme", () => {
    makeFixture({
      builtinThemes: [
        { id: "clawd", json: validThemeJson({ name: "Clawd" }) },
        { id: "other", json: validThemeJson({ name: "Other" }) },
      ],
    });
    const loaded = themeLoader.loadTheme("clawd", { strict: true });

    const result = themeLoader.validateThemeShape("other");

    assert.strictEqual(result.ok, true);
    assert.strictEqual(loaded._id, "clawd");
    assert.strictEqual(themeLoader.getActiveTheme(), null);
  });

  it("validates external theme assets from source without creating theme cache", () => {
    const fixture = makeFixture({
      builtinThemes: [{ id: "clawd", json: validThemeJson({ name: "Clawd" }) }],
      userThemes: [{
        id: "user-theme",
        json: validThemeJson({ name: "User Theme" }),
        assets: assetMap(),
      }],
    });
    const cacheDir = path.join(fixture.userData, "theme-cache");

    const result = themeLoader.validateThemeShape("user-theme");

    assert.strictEqual(result.ok, true);
    assert.strictEqual(fs.existsSync(cacheDir), false);
  });

  it("reports missing assets introduced by a variant", () => {
    makeFixture({
      builtinThemes: [{
        id: "clawd",
        json: validThemeJson({
          name: "Clawd",
          variants: {
            broken: {
              workingTiers: [{ minSessions: 2, file: "missing.svg" }],
            },
          },
        }),
      }],
    });

    const result = themeLoader.validateThemeShape("clawd", { variant: "broken" });

    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("missing.svg")));
  });

  it("reports override-introduced missing assets", () => {
    makeFixture({
      builtinThemes: [{ id: "clawd", json: validThemeJson({ name: "Clawd" }) }],
    });

    const result = themeLoader.validateThemeShape("clawd", {
      overrides: { states: { idle: { file: "missing-override.svg" } } },
    });

    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("missing-override.svg")));
  });
});

describe("checkThemeHealth", () => {
  it("wraps validateThemeShape into a doctor check", () => {
    const result = checkThemeHealth({
      prefs: { theme: "clawd" },
      validateThemeShape: () => ({ ok: true, errors: [], resolvedVariant: "default" }),
    });

    assert.strictEqual(result.status, "pass");
    assert.strictEqual(result.level, null);
  });

  it("warns when validateThemeShape fails", () => {
    const result = checkThemeHealth({
      prefs: { theme: "bad" },
      validateThemeShape: () => ({ ok: false, errors: ["missing asset"] }),
    });

    assert.strictEqual(result.status, "fail");
    assert.strictEqual(result.level, "warning");
    assert.match(result.detail, /missing asset/);
    assert.strictEqual(result.fixAction, undefined);
    assert.match(result.textHint, /Settings -> Theme/);
  });
});
