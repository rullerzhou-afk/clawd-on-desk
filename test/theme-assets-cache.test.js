"use strict";

const { describe, it, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  resolveExternalAssetsDir,
  externalAssetsSourceDir,
  isPathInsideDir,
} = require("../src/theme-assets-cache");

const tempDirs = [];

afterEach(() => {
  mock.restoreAll();
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeFixture(themeId, assets = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-theme-cache-"));
  tempDirs.push(tmp);
  const themeDir = path.join(tmp, "themes", themeId);
  const assetsDir = path.join(themeDir, "assets");
  const themeCacheDir = path.join(tmp, "theme-cache");
  fs.mkdirSync(assetsDir, { recursive: true });
  for (const [filename, content] of Object.entries(assets)) {
    const absPath = path.join(assetsDir, filename);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf8");
  }
  return { tmp, themeId, themeDir, assetsDir, themeCacheDir };
}

function readCacheMeta(themeCacheDir, themeId) {
  return JSON.parse(fs.readFileSync(path.join(themeCacheDir, themeId, ".cache-meta.json"), "utf8"));
}

describe("theme-assets-cache path helpers", () => {
  it("returns source assets directly when no cache root is configured", () => {
    const fixture = makeFixture("no-cache", {});

    assert.strictEqual(
      resolveExternalAssetsDir(fixture.themeId, fixture.themeDir),
      externalAssetsSourceDir(fixture.themeDir)
    );
  });

  it("detects paths outside the intended directory", () => {
    const fixture = makeFixture("paths", {});

    assert.strictEqual(isPathInsideDir(fixture.assetsDir, path.join(fixture.assetsDir, "idle.svg")), true);
    assert.strictEqual(isPathInsideDir(fixture.assetsDir, path.join(fixture.tmp, "outside.svg")), false);
  });
});

describe("theme-assets-cache SVG and raster sync", () => {
  it("sanitizes SVGs and copies safe relative raster dependencies beside cached SVGs", () => {
    const fixture = makeFixture("safe-raster-ref", {
      "spritesheet.webp": "fake-webp",
      "nested/sheet.png": "fake-png",
      "idle.svg": [
        "<svg xmlns=\"http://www.w3.org/2000/svg\">",
        "  <script>alert(1)</script>",
        "  <style>.bg { fill: url(#local); background: url('./nested/sheet.png'); }</style>",
        "  <image href=\"spritesheet.webp?cache=1#frame\"/>",
        "</svg>",
      ].join(""),
    });

    const cacheDir = resolveExternalAssetsDir(fixture.themeId, fixture.themeDir, {
      themeCacheDir: fixture.themeCacheDir,
      strict: true,
    });
    const sanitized = fs.readFileSync(path.join(cacheDir, "idle.svg"), "utf8");
    const cacheMeta = readCacheMeta(fixture.themeCacheDir, fixture.themeId);

    assert.ok(sanitized.includes("<image"), "safe local image element should survive sanitization");
    assert.ok(!sanitized.includes("<script"));
    assert.strictEqual(fs.readFileSync(path.join(cacheDir, "spritesheet.webp"), "utf8"), "fake-webp");
    assert.strictEqual(fs.readFileSync(path.join(cacheDir, "nested", "sheet.png"), "utf8"), "fake-png");
    assert.strictEqual(cacheMeta.version, 4);
    assert.ok(cacheMeta.svgs["idle.svg"]);
    assert.ok(cacheMeta.rasters["spritesheet.webp"]);
    assert.ok(cacheMeta.rasters["nested/sheet.png"]);
    assert.ok(!cacheMeta.rasters["#frame"]);
  });

  it("rewrites SVGs cached under the v2 meta, which lost the XML declaration's closing ?", () => {
    const fixture = makeFixture("v2-cache", {
      "idle.svg": '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>',
    });
    const stat = fs.statSync(path.join(fixture.assetsDir, "idle.svg"));
    const cacheDir = path.join(fixture.themeCacheDir, fixture.themeId, "assets");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "idle.svg"), '<?xml version="1.0" encoding="UTF-8">\n<svg/>', "utf8");
    fs.writeFileSync(path.join(fixture.themeCacheDir, fixture.themeId, ".cache-meta.json"), JSON.stringify({
      version: 2,
      svgs: { "idle.svg": { mtime: stat.mtimeMs, size: stat.size } },
      rasters: {},
    }), "utf8");

    resolveExternalAssetsDir(fixture.themeId, fixture.themeDir, { themeCacheDir: fixture.themeCacheDir });

    assert.ok(fs.readFileSync(path.join(cacheDir, "idle.svg"), "utf8").startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.strictEqual(readCacheMeta(fixture.themeCacheDir, fixture.themeId).version, 4);
  });

  it("invalidates v3 SVG caches so processing instructions are removed", () => {
    const fixture = makeFixture("v3-cache", {
      "idle.svg": [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<?xml-stylesheet href="https://bad.example/theme.css"?>',
        '<svg xmlns="http://www.w3.org/2000/svg"/>',
      ].join("\n"),
    });
    const stat = fs.statSync(path.join(fixture.assetsDir, "idle.svg"));
    const cacheDir = path.join(fixture.themeCacheDir, fixture.themeId, "assets");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, "idle.svg"),
      '<?xml version="1.0" encoding="UTF-8"?>\n<?xml-stylesheet href="https://bad.example/theme.css"?>\n<svg/>',
      "utf8"
    );
    fs.writeFileSync(path.join(fixture.themeCacheDir, fixture.themeId, ".cache-meta.json"), JSON.stringify({
      version: 3,
      svgs: { "idle.svg": { mtime: stat.mtimeMs, size: stat.size } },
      rasters: {},
    }), "utf8");

    resolveExternalAssetsDir(fixture.themeId, fixture.themeDir, { themeCacheDir: fixture.themeCacheDir });

    const sanitized = fs.readFileSync(path.join(cacheDir, "idle.svg"), "utf8");
    assert.ok(!sanitized.includes("xml-stylesheet"), sanitized);
    assert.ok(!sanitized.includes("bad.example"), sanitized);
    assert.strictEqual(readCacheMeta(fixture.themeCacheDir, fixture.themeId).version, 4);
  });

  it("rejects missing SVG raster dependencies in strict mode", () => {
    const fixture = makeFixture("missing-raster-ref", {
      "idle.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"><image href=\"missing.webp\"/></svg>",
    });
    const warn = mock.method(console, "warn", () => {});

    assert.throws(
      () => resolveExternalAssetsDir(fixture.themeId, fixture.themeDir, {
        themeCacheDir: fixture.themeCacheDir,
        strict: true,
      }),
      /missing raster dependencies: missing\.webp/
    );
    assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes("Missing raster dependency")));
  });

  it("repairs missing cached rasters and invalidates stale source metadata", () => {
    const fixture = makeFixture("repair-raster-ref", {
      "spritesheet.webp": "old-webp",
      "idle.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"><image href=\"spritesheet.webp\"/></svg>",
    });
    const cacheDir = resolveExternalAssetsDir(fixture.themeId, fixture.themeDir, {
      themeCacheDir: fixture.themeCacheDir,
      strict: true,
    });
    const cachedWebp = path.join(cacheDir, "spritesheet.webp");
    const sourceWebp = path.join(fixture.assetsDir, "spritesheet.webp");

    assert.strictEqual(fs.readFileSync(cachedWebp, "utf8"), "old-webp");
    fs.rmSync(cachedWebp, { force: true });
    resolveExternalAssetsDir(fixture.themeId, fixture.themeDir, {
      themeCacheDir: fixture.themeCacheDir,
      strict: true,
    });
    assert.strictEqual(fs.readFileSync(cachedWebp, "utf8"), "old-webp");

    fs.writeFileSync(sourceWebp, "new-webp-content", "utf8");
    resolveExternalAssetsDir(fixture.themeId, fixture.themeDir, {
      themeCacheDir: fixture.themeCacheDir,
      strict: true,
    });
    assert.strictEqual(fs.readFileSync(cachedWebp, "utf8"), "new-webp-content");
  });

  it("removes orphaned cached rasters after SVG references change", () => {
    const fixture = makeFixture("orphan-raster-ref", {
      "a.webp": "raster-a",
      "b.webp": "raster-b",
      "idle.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"><image href=\"a.webp\"/></svg>",
    });
    const cacheDir = resolveExternalAssetsDir(fixture.themeId, fixture.themeDir, {
      themeCacheDir: fixture.themeCacheDir,
      strict: true,
    });
    const cachedA = path.join(cacheDir, "a.webp");
    const cachedB = path.join(cacheDir, "b.webp");

    assert.strictEqual(fs.readFileSync(cachedA, "utf8"), "raster-a");
    fs.writeFileSync(
      path.join(fixture.assetsDir, "idle.svg"),
      "<svg xmlns=\"http://www.w3.org/2000/svg\"><image href=\"b.webp\"/></svg>",
      "utf8"
    );
    resolveExternalAssetsDir(fixture.themeId, fixture.themeDir, {
      themeCacheDir: fixture.themeCacheDir,
      strict: true,
    });
    const cacheMeta = readCacheMeta(fixture.themeCacheDir, fixture.themeId);

    assert.strictEqual(fs.existsSync(cachedA), false);
    assert.strictEqual(fs.readFileSync(cachedB, "utf8"), "raster-b");
    assert.ok(!cacheMeta.rasters["a.webp"]);
    assert.ok(cacheMeta.rasters["b.webp"]);
  });

  it("migrates legacy flat cache metadata and refreshes cached SVGs", () => {
    const fixture = makeFixture("legacy-cache-ref", {
      "spritesheet.webp": "legacy-webp",
      "idle.svg": [
        "<svg xmlns=\"http://www.w3.org/2000/svg\">",
        "  <script>alert(1)</script>",
        "  <image href=\"spritesheet.webp\"/>",
        "</svg>",
      ].join(""),
    });
    const cacheRoot = path.join(fixture.themeCacheDir, fixture.themeId);
    const cacheAssetsDir = path.join(cacheRoot, "assets");
    fs.mkdirSync(cacheAssetsDir, { recursive: true });
    fs.writeFileSync(path.join(cacheAssetsDir, "idle.svg"), "<svg><script>stale()</script></svg>", "utf8");
    const sourceStat = fs.statSync(path.join(fixture.assetsDir, "idle.svg"));
    fs.writeFileSync(
      path.join(cacheRoot, ".cache-meta.json"),
      JSON.stringify({ "idle.svg": { mtime: sourceStat.mtimeMs, size: sourceStat.size } }),
      "utf8"
    );

    resolveExternalAssetsDir(fixture.themeId, fixture.themeDir, {
      themeCacheDir: fixture.themeCacheDir,
      strict: true,
    });
    const sanitized = fs.readFileSync(path.join(cacheAssetsDir, "idle.svg"), "utf8");
    const cacheMeta = readCacheMeta(fixture.themeCacheDir, fixture.themeId);

    assert.strictEqual(cacheMeta.version, 4);
    assert.ok(cacheMeta.svgs["idle.svg"]);
    assert.ok(cacheMeta.rasters["spritesheet.webp"]);
    assert.ok(sanitized.includes("<image"));
    assert.ok(!sanitized.includes("<script"));
    assert.ok(!sanitized.includes("stale()"));
  });
});
