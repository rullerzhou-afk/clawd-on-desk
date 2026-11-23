"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const prefs = require("../src/prefs");
const {
  updateRegistry,
  buildThemeScopedPrefsCommit,
} = require("../src/settings-actions");

describe("issue #1323: theme appearance preferences", () => {
  it("issue #1323: normalization drops unsafe ids and unknown appearances", () => {
    const snapshot = prefs.validate({
      themeAppearance: {
        night: "dark",
        clawd: "light",
        "../escape": "dark",
        auto: "auto",
        missing: 1,
      },
    });
    assert.deepStrictEqual(snapshot.themeAppearance, { night: "dark", clawd: "light" });
    assert.deepStrictEqual(prefs.validate({}).themeAppearance, {});
  });

  it("issue #1323: the settings validator accepts only safe ids mapped to light or dark", () => {
    const deps = { snapshot: prefs.getDefaults() };
    assert.strictEqual(updateRegistry.themeAppearance({}, deps).status, "ok");
    assert.strictEqual(
      updateRegistry.themeAppearance({ night: "dark", clawd: "light" }, deps).status,
      "ok"
    );
    assert.strictEqual(updateRegistry.themeAppearance("dark", deps).status, "error");
    assert.strictEqual(updateRegistry.themeAppearance({ night: "auto" }, deps).status, "error");
    assert.strictEqual(updateRegistry.themeAppearance({ "../escape": "dark" }, deps).status, "error");
  });

  it("issue #1323: removing a theme drops its appearance preference", () => {
    const commit = buildThemeScopedPrefsCommit("night", {
      themeAppearance: { night: "dark", clawd: "light" },
    });
    assert.deepStrictEqual(commit.themeAppearance, { clawd: "light" });
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(commit.themeAppearance, "night"),
      false
    );
  });

  it("issue #1323: Codex Pet cleanup clears the appearance preference too", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "codex-pet-main.js"), "utf8");
    const start = source.indexOf("async function clearThemeScopedPreferences");
    assert.ok(start >= 0, "clearThemeScopedPreferences must exist");
    const body = source.slice(start, start + 600);
    assert.match(body, /"themeAppearance"/);
  });
});
