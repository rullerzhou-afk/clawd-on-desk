"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
const themeMetadata = require("../src/theme-metadata");

const SRC_DIR = path.join(__dirname, "..", "src");
const REQUIRED_STATES = ["idle", "yawning", "dozing", "collapsing", "thinking", "working", "sleeping", "waking"];

function validThemeJson() {
  return {
    schemaVersion: 1,
    name: "Theme",
    version: "1.0.0",
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    states: Object.fromEntries(REQUIRED_STATES.map((state) => [state, [`${state}.svg`]])),
  };
}

let tmp;
let userThemesDir;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dotted-"));
  const appDir = path.join(tmp, "src");
  fs.mkdirSync(appDir, { recursive: true });
  userThemesDir = path.join(tmp, "userData", "themes");
  for (const id of ["normal", ".staging", ".backup"]) {
    const themeDir = path.join(userThemesDir, id);
    fs.mkdirSync(path.join(themeDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(themeDir, "theme.json"), JSON.stringify(validThemeJson()), "utf8");
    for (const state of REQUIRED_STATES) {
      fs.writeFileSync(path.join(themeDir, "assets", `${state}.svg`), "<svg/>", "utf8");
    }
  }
  themeLoader.init(appDir, path.join(tmp, "userData"));
});

afterEach(() => {
  themeLoader.init(SRC_DIR, null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("dotted theme directories are never themes", () => {
  it("omits dotted direct children from discoverThemes", () => {
    const ids = themeLoader.discoverThemes().map((theme) => theme.id);
    assert.ok(ids.includes("normal"));
    assert.ok(!ids.includes(".staging"));
    assert.ok(!ids.includes(".backup"));
  });

  it("refuses to read or validate a dotted theme by id", () => {
    assert.strictEqual(themeLoader.validateThemeShape("normal").ok, true);
    assert.strictEqual(themeLoader.validateThemeShape(".staging").ok, false);
    assert.strictEqual(themeLoader.getThemeMetadata(".staging"), null);
  });

  it("omits dotted direct children from metadata scans", () => {
    const ids = themeLoader.listThemesWithMetadata().map((theme) => theme.id);
    assert.ok(ids.includes("normal"));
    assert.ok(!ids.some((id) => id.startsWith(".")));

    const direct = themeMetadata.listThemesWithMetadata({ userThemesDir, assetsSvgDir: null });
    assert.deepStrictEqual(direct.map((theme) => theme.id), ["normal"]);
  });

  it("uses one shared direct-child predicate", () => {
    assert.strictEqual(themeLoader.isScannableThemeDirName("normal"), true);
    assert.strictEqual(themeLoader.isScannableThemeDirName(".staging"), false);
    assert.strictEqual(themeMetadata.isScannableThemeDirName(".staging"), false);
    assert.strictEqual(themeMetadata.isScannableThemeDirName(""), false);
  });
});
