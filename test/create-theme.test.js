"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createTheme = require("../scripts/create-theme");

const cleanupDirs = [];

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-create-theme-"));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupDirs.length) {
    fs.rmSync(cleanupDirs.pop(), { recursive: true, force: true });
  }
});

describe("create-theme defaults", () => {
  it("resolves the platform-specific user themes directory", () => {
    assert.strictEqual(
      createTheme.getDefaultThemesRoot("win32", { APPDATA: "C:\\Users\\Ruller\\AppData\\Roaming" }, "C:\\Users\\Ruller"),
      path.win32.join("C:\\Users\\Ruller\\AppData\\Roaming", "clawd-on-desk", "themes")
    );
    assert.strictEqual(
      createTheme.getDefaultThemesRoot("darwin", {}, "/Users/ruller"),
      "/Users/ruller/Library/Application Support/clawd-on-desk/themes"
    );
    assert.strictEqual(
      createTheme.getDefaultThemesRoot("linux", { XDG_CONFIG_HOME: "/tmp/config-home" }, "/home/ruller"),
      "/tmp/config-home/clawd-on-desk/themes"
    );
  });

  it("slugifies theme ids into filesystem-safe names", () => {
    assert.strictEqual(createTheme.slugifyThemeId("Pixel Cat!"), "pixel-cat");
    assert.strictEqual(createTheme.slugifyThemeId("   "), "my-theme");
  });
});

describe("create-theme scaffold", () => {
  it("copies the template and patches theme metadata", () => {
    const themesRoot = makeTmpDir();
    const result = createTheme.createThemeScaffold({
      themeId: "Pixel Cat",
      name: "Pixel Cat",
      author: "Ruller",
      themesRoot,
    });

    assert.strictEqual(result.themeId, "pixel-cat");
    assert.ok(fs.existsSync(path.join(result.targetDir, "theme.json")));
    assert.ok(fs.existsSync(path.join(result.targetDir, "assets", "idle-follow.svg")));

    const themeJson = fs.readFileSync(path.join(result.targetDir, "theme.json"), "utf8");
    assert.match(themeJson, /"name": "Pixel Cat"/);
    assert.match(themeJson, /"author": "Ruller"/);
    assert.doesNotMatch(themeJson, /"license"\s*:/);
  });

  it("auto-picks a fresh my-theme-N id when no theme id is provided", () => {
    const themesRoot = makeTmpDir();
    fs.mkdirSync(path.join(themesRoot, "my-theme"), { recursive: true });

    const result = createTheme.createThemeScaffold({
      themesRoot,
      env: { USERNAME: "Codex" },
    });

    assert.strictEqual(result.themeId, "my-theme-2");
    assert.strictEqual(result.author, "Codex");
    assert.ok(fs.existsSync(path.join(result.targetDir, "theme.json")));
  });

  it("rejects explicit theme ids that already exist", () => {
    const themesRoot = makeTmpDir();
    fs.mkdirSync(path.join(themesRoot, "pixel-cat"), { recursive: true });

    assert.throws(
      () => createTheme.createThemeScaffold({ themeId: "pixel-cat", themesRoot }),
      /already exists/
    );
  });
});
