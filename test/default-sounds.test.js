"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const createThemeContext = require("../src/theme-context");
const themeLoader = require("../src/theme-loader");

const ROOT = path.join(__dirname, "..");
const SOUNDS_DIR = path.join(ROOT, "assets", "sounds");

themeLoader.init(path.join(ROOT, "src"));

test("bundled completion and confirmation sounds have distinct audio payloads", () => {
  const complete = fs.readFileSync(path.join(SOUNDS_DIR, "complete.mp3"));
  const confirm = fs.readFileSync(path.join(SOUNDS_DIR, "confirm.mp3"));

  assert.ok(complete.length > 0);
  assert.ok(confirm.length > 0);
  assert.notDeepStrictEqual(confirm, complete);
});

test("built-in themes resolve completion and confirmation to distinct bundled files", () => {
  for (const themeId of ["clawd", "calico", "cloudling"]) {
    const theme = themeLoader.loadTheme(themeId, { strict: true });
    const context = createThemeContext(theme, { assetsSoundsDir: SOUNDS_DIR });
    const completeUrl = context.getSoundUrl("complete");
    const confirmUrl = context.getSoundUrl("confirm");

    assert.ok(completeUrl, `${themeId} should resolve a completion sound`);
    assert.ok(confirmUrl, `${themeId} should resolve a confirmation sound`);
    assert.strictEqual(fileURLToPath(completeUrl), path.join(SOUNDS_DIR, "complete.mp3"));
    assert.strictEqual(fileURLToPath(confirmUrl), path.join(SOUNDS_DIR, "confirm.mp3"));
    assert.notStrictEqual(confirmUrl, completeUrl);
  }
});
