"use strict";

const { describe, it, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
const createThemeContext = require("../src/theme-context");
const { resolveExternalAssetsDir } = require("../src/theme-assets-cache");

const REQUIRED_STATES = [
  "idle",
  "yawning",
  "dozing",
  "collapsing",
  "thinking",
  "working",
  "sleeping",
  "waking",
];

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';

const tempDirs = [];

afterEach(() => {
  mock.restoreAll();
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-theme-appearance-"));
  tempDirs.push(tmp);
  const appDir = path.join(tmp, "src");
  const userData = path.join(tmp, "userData");
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, "assets", "svg"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "assets", "sounds"), { recursive: true });
  fs.mkdirSync(path.join(userData, "themes"), { recursive: true });
  themeLoader.init(appDir, userData);
  return { tmp, appDir, userData, themesDir: path.join(userData, "themes") };
}

function validThemeJson(overrides = {}) {
  return {
    schemaVersion: 1,
    name: "Night",
    version: "1.0.0",
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    states: Object.fromEntries(REQUIRED_STATES.map((state) => [state, [`${state}.svg`]])),
    ...overrides,
  };
}

function mirroredAssets(overrides = {}) {
  const files = {};
  for (const state of REQUIRED_STATES) files[`${state}.svg`] = SVG;
  return { ...files, ...overrides };
}

function writeFiles(dir, files) {
  for (const [filename, content] of Object.entries(files)) {
    const absPath = path.join(dir, filename);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf8");
  }
}

function writeTheme(themesDir, id, { json, assets, darkAssets, darkName = "assets-dark" }) {
  const themeDir = path.join(themesDir, id);
  fs.mkdirSync(themeDir, { recursive: true });
  fs.writeFileSync(path.join(themeDir, "theme.json"), JSON.stringify(json), "utf8");
  writeFiles(path.join(themeDir, "assets"), assets || {});
  if (darkAssets) writeFiles(path.join(themeDir, darkName), darkAssets);
  return themeDir;
}

function darkThemeJson(assetsDir = "assets-dark") {
  return validThemeJson({ appearance: { dark: { assetsDir } } });
}

describe("issue #1323: loader dark appearance", () => {
  it("issue #1323: loads the dark source directory when dark is requested and complete", () => {
    const fixture = makeFixture();
    const themeDir = writeTheme(fixture.themesDir, "night", {
      json: darkThemeJson(),
      assets: mirroredAssets(),
      darkAssets: mirroredAssets(),
    });

    const dark = themeLoader.loadTheme("night", { appearance: "dark", strict: true });
    assert.strictEqual(dark._appearance, "dark");
    assert.strictEqual(dark._assetsSourceDir, path.join(themeDir, "assets-dark"));
    assert.strictEqual(
      dark._assetsDir,
      path.join(fixture.userData, "theme-cache", "night", "assets-dark")
    );
    assert.strictEqual(dark._capabilities.darkAppearance, true);

    const light = themeLoader.loadTheme("night", { appearance: "light", strict: true });
    assert.strictEqual(light._appearance, "light");
    assert.strictEqual(light._assetsSourceDir, path.join(themeDir, "assets"));
    assert.strictEqual(light._assetsDir, path.join(fixture.userData, "theme-cache", "night", "assets"));
  });

  it("issue #1323: an incomplete or unsafe dark directory falls back to light with one warning", async (t) => {
    const cases = [
      {
        name: "missing mirrored file",
        setup(themeDir) {
          fs.rmSync(path.join(themeDir, "assets-dark", "sleeping.svg"), { force: true });
        },
      },
      { name: "path traversal", assetsDir: "../escaped" },
      { name: "case-insensitive assets name", assetsDir: "Assets" },
      { name: "missing directory", assetsDir: "assets-missing" },
      {
        name: "symbolic link",
        setup(themeDir) {
          const realDir = path.join(themeDir, "assets-real");
          fs.renameSync(path.join(themeDir, "assets-dark"), realDir);
          const link = path.join(themeDir, "assets-dark");
          try {
            fs.symlinkSync(realDir, link, "dir");
          } catch (err) {
            if (err.code === "EPERM" || err.code === "EACCES") return "skip";
            throw err;
          }
          return null;
        },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const fixture = makeFixture();
      const id = `night-${index}`;
      const themeDir = writeTheme(fixture.themesDir, id, {
        json: darkThemeJson(testCase.assetsDir),
        assets: mirroredAssets(),
        darkAssets: mirroredAssets(),
      });
      const setupResult = testCase.setup ? testCase.setup(themeDir) : null;
      if (setupResult === "skip") {
        t.diagnostic(`skipped ${testCase.name}: platform refused the symlink`);
        continue;
      }

      const warn = mock.method(console, "warn", () => {});
      let theme;
      assert.doesNotThrow(() => {
        theme = themeLoader.loadTheme(id, { appearance: "dark", strict: true });
      }, testCase.name);

      assert.strictEqual(theme._appearance, "light", testCase.name);
      assert.strictEqual(theme._capabilities.darkAppearance, false, testCase.name);
      assert.strictEqual(theme._assetsSourceDir, path.join(themeDir, "assets"), testCase.name);
      const warnings = warn.mock.calls
        .map((call) => call.arguments.join(" "))
        .filter((message) => message.includes(id) && message.includes("dark appearance unavailable"));
      assert.strictEqual(warnings.length, 1, `${testCase.name}: ${warnings.join(" | ")}`);
      warn.mock.restore();
    }
  });

  it("issue #1323: a dark SVG that references a missing raster falls back to light", () => {
    const fixture = makeFixture();
    const themeDir = writeTheme(fixture.themesDir, "night", {
      json: darkThemeJson(),
      assets: mirroredAssets(),
      darkAssets: mirroredAssets({
        "idle.svg": '<svg xmlns="http://www.w3.org/2000/svg"><image href="missing.png"/></svg>',
      }),
    });

    const warn = mock.method(console, "warn", () => {});
    let theme;
    assert.doesNotThrow(() => {
      theme = themeLoader.loadTheme("night", { appearance: "dark", strict: true });
    });
    assert.strictEqual(theme._appearance, "light");
    assert.strictEqual(theme._capabilities.darkAppearance, false);
    assert.strictEqual(theme._assetsSourceDir, path.join(themeDir, "assets"));
    const messages = warn.mock.calls.map((call) => call.arguments.join(" "));
    assert.ok(messages.some((message) => message.includes("dark appearance unavailable")));
  });

  it("issue #1323: a non-strict dark load with a missing raster also falls back to light", () => {
    const fixture = makeFixture();
    const themeDir = writeTheme(fixture.themesDir, "night", {
      json: darkThemeJson(),
      assets: mirroredAssets(),
      darkAssets: mirroredAssets({
        "idle.svg": '<svg xmlns="http://www.w3.org/2000/svg"><image href="missing.png"/></svg>',
      }),
    });

    const warn = mock.method(console, "warn", () => {});
    const theme = themeLoader.loadTheme("night", { appearance: "dark", strict: false });

    assert.strictEqual(theme._appearance, "light");
    assert.strictEqual(theme._capabilities.darkAppearance, false);
    assert.strictEqual(theme._assetsSourceDir, path.join(themeDir, "assets"));
    assert.ok(warn.mock.calls.some((call) => call.arguments.join(" ").includes("missing raster")));
  });

  it("issue #1323: falling back to light re-filters dark-only idle visual options", () => {
    const fixture = makeFixture();
    const json = darkThemeJson();
    json.idleVisualOptions = [{ file: "dark-only.svg" }];
    const themeDir = writeTheme(fixture.themesDir, "night", {
      json,
      assets: mirroredAssets(),
      darkAssets: mirroredAssets({
        "dark-only.svg": SVG,
        "idle.svg": '<svg xmlns="http://www.w3.org/2000/svg"><image href="missing.png"/></svg>',
      }),
    });

    const warn = mock.method(console, "warn", () => {});
    const theme = themeLoader.loadTheme("night", { appearance: "dark", strict: false });
    const light = themeLoader.loadTheme("night", { appearance: "light", strict: false });

    assert.strictEqual(theme._appearance, "light");
    assert.deepStrictEqual(theme.idleVisualOptions, light.idleVisualOptions);
    assert.ok(!theme.idleVisualOptions.some((entry) => entry.file === "dark-only.svg"));
    assert.strictEqual(theme._assetsSourceDir, path.join(themeDir, "assets"));
    assert.ok(warn.mock.callCount() > 0);
  });

  it("issue #1323: an intermediate symlink that escapes the dark directory is rejected", (t) => {
    const fixture = makeFixture();
    const outsideDir = path.join(fixture.tmp, "outside-dark");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "art.svg"), SVG, "utf8");
    const themeDir = writeTheme(fixture.themesDir, "night", {
      json: darkThemeJson(),
      assets: mirroredAssets({ "extra/art.svg": SVG }),
      darkAssets: mirroredAssets(),
    });
    try {
      fs.symlinkSync(outsideDir, path.join(themeDir, "assets-dark", "extra"), "dir");
    } catch (err) {
      if (err.code === "EPERM" || err.code === "EACCES") {
        t.skip(`platform refused the symlink: ${err.code}`);
        return;
      }
      throw err;
    }

    const warn = mock.method(console, "warn", () => {});
    const theme = themeLoader.loadTheme("night", { appearance: "dark", strict: true });
    assert.strictEqual(theme._appearance, "light");
    assert.strictEqual(theme._capabilities.darkAppearance, false);
    assert.ok(warn.mock.calls.some((call) => call.arguments.join(" ").includes("escapes")));
  });

  it("issue #1323: removeThemeCacheDir only removes a direct child of the cache root", () => {
    const fixture = makeFixture();
    const cacheRoot = path.join(fixture.userData, "theme-cache");
    fs.mkdirSync(path.join(cacheRoot, "safe"), { recursive: true });
    fs.mkdirSync(path.join(cacheRoot, "a", "b"), { recursive: true });
    fs.mkdirSync(path.join(fixture.userData, "outside-cache"), { recursive: true });

    assert.strictEqual(themeLoader.removeThemeCacheDir("safe"), true);
    assert.ok(!fs.existsSync(path.join(cacheRoot, "safe")));
    assert.strictEqual(themeLoader.removeThemeCacheDir("../outside-cache"), false);
    assert.ok(fs.existsSync(path.join(fixture.userData, "outside-cache")));
    assert.strictEqual(themeLoader.removeThemeCacheDir("a/b"), false);
    assert.ok(fs.existsSync(path.join(cacheRoot, "a", "b")));
  });

  it("issue #1323: keeps the light cache layout and builds the dark cache separately", () => {
    const fixture = makeFixture();
    const themeDir = writeTheme(fixture.themesDir, "night", {
      json: darkThemeJson(),
      assets: mirroredAssets(),
      darkAssets: mirroredAssets(),
    });
    const cacheRoot = path.join(fixture.userData, "theme-cache", "night");

    assert.strictEqual(
      resolveExternalAssetsDir("night", themeDir, { themeCacheDir: path.join(fixture.userData, "theme-cache") }),
      path.join(cacheRoot, "assets"),
      "the default cache subdirectory must stay assets"
    );
    themeLoader.loadTheme("night", { appearance: "light", strict: true });
    assert.ok(fs.existsSync(path.join(cacheRoot, "assets", "idle.svg")));
    assert.ok(fs.existsSync(path.join(cacheRoot, ".cache-meta.json")));
    const lightSvg = fs.statSync(path.join(cacheRoot, "assets", "idle.svg"), { bigint: true });
    const lightMeta = fs.statSync(path.join(cacheRoot, ".cache-meta.json"), { bigint: true });

    themeLoader.loadTheme("night", { appearance: "dark", strict: true });
    assert.ok(fs.existsSync(path.join(cacheRoot, "assets-dark", "idle.svg")));
    assert.ok(fs.existsSync(path.join(cacheRoot, ".cache-meta-assets-dark.json")));

    themeLoader.loadTheme("night", { appearance: "light", strict: true });
    const lightSvgAgain = fs.statSync(path.join(cacheRoot, "assets", "idle.svg"), { bigint: true });
    const lightMetaAgain = fs.statSync(path.join(cacheRoot, ".cache-meta.json"), { bigint: true });
    assert.strictEqual(lightSvgAgain.mtimeNs, lightSvg.mtimeNs, "light SVG cache must not be rewritten");
    assert.strictEqual(lightMetaAgain.mtimeNs, lightMeta.mtimeNs, "light meta cache must not be rewritten");
    assert.ok(themeDir);
  });

  it("issue #1323: a declared-but-missing dark directory differs from a plain theme only by a warning", () => {
    const fixture = makeFixture();
    const themeDir = writeTheme(fixture.themesDir, "night", {
      json: validThemeJson(),
      assets: mirroredAssets(),
    });

    const plain = themeLoader.loadTheme("night", { strict: true });
    const plainCapabilities = { ...plain._capabilities };
    delete plainCapabilities.darkAppearance;

    const warn = mock.method(console, "warn", () => {});
    fs.writeFileSync(path.join(themeDir, "theme.json"), JSON.stringify(darkThemeJson()), "utf8");
    const declared = themeLoader.loadTheme("night", { strict: true });

    assert.deepStrictEqual(declared.states, plain.states);
    assert.strictEqual(declared._appearance, "light");
    assert.strictEqual(declared._assetsDir, plain._assetsDir);
    assert.strictEqual(declared._assetsSourceDir, plain._assetsSourceDir);
    const declaredCapabilities = { ...declared._capabilities };
    delete declaredCapabilities.darkAppearance;
    assert.deepStrictEqual(declaredCapabilities, plainCapabilities);
    assert.strictEqual(declared._capabilities.darkAppearance, false);
    assert.strictEqual(
      warn.mock.calls.filter((call) => call.arguments.join(" ").includes("night")).length,
      1
    );
  });

  it("issue #1323: context resolves SVG, raster and renderer source paths from the dark source", () => {
    const fixture = makeFixture();
    const themeDir = writeTheme(fixture.themesDir, "night", {
      json: darkThemeJson(),
      assets: mirroredAssets({ "idle.apng": "light" }),
      darkAssets: mirroredAssets({ "idle.apng": "dark" }),
    });
    const theme = themeLoader.loadTheme("night", { appearance: "dark", strict: true });
    const context = createThemeContext(theme, {
      assetsSvgDir: path.join(fixture.tmp, "assets", "svg"),
      assetsSoundsDir: path.join(fixture.tmp, "assets", "sounds"),
    });

    assert.strictEqual(context.resolveAssetPath("idle.svg"), path.join(theme._assetsDir, "idle.svg"));
    assert.strictEqual(context.resolveAssetPath("idle.apng"), path.join(themeDir, "assets-dark", "idle.apng"));
    assert.strictEqual(
      context.getRendererSourceAssetsPath(),
      require("node:url").pathToFileURL(path.join(themeDir, "assets-dark")).href
    );
  });

  it("issue #1323: metadata reports dark availability without logging", () => {
    const fixture = makeFixture();
    writeTheme(fixture.themesDir, "night", {
      json: darkThemeJson(),
      assets: mirroredAssets(),
      darkAssets: mirroredAssets(),
    });
    writeTheme(fixture.themesDir, "broken", {
      json: darkThemeJson(),
      assets: mirroredAssets(),
      darkAssets: { "idle.svg": SVG },
    });

    const warn = mock.method(console, "warn", () => {});
    const night = themeLoader.getThemeMetadata("night");
    const broken = themeLoader.getThemeMetadata("broken");
    const listed = themeLoader.listThemesWithMetadata();

    assert.strictEqual(night.capabilities.darkAppearance, true);
    assert.strictEqual(broken.capabilities.darkAppearance, false);
    assert.strictEqual(
      listed.find((entry) => entry.id === "night").capabilities.darkAppearance,
      true
    );
    assert.strictEqual(
      listed.find((entry) => entry.id === "broken").capabilities.darkAppearance,
      false
    );
    assert.strictEqual(warn.mock.callCount(), 0);
  });
});
