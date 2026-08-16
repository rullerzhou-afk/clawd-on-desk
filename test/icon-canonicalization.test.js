"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { minimatch } = require("minimatch");

const ROOT = path.join(__dirname, "..");
const CANONICAL_ICON = path.join(ROOT, "assets", "icon.png");
const RETIRED_TRAY_ICON = path.join(ROOT, "assets", "tray-icon.png");
const PACKAGED_ICON_ASSETS = [
  "assets/icon.png",
  "assets/tray-iconTemplate.png",
  "assets/tray-iconTemplate@2x.png",
  "assets/tray-icon-flash.png",
];
const LOCALIZED_READMES = [
  "README.md",
  "README.zh-CN.md",
  "README.zh-TW.md",
  "README.ko-KR.md",
  "README.ja-JP.md",
  "README.es.md",
];

test("ordinary tray and README callers use the canonical application icon", () => {
  assert.ok(fs.existsSync(CANONICAL_ICON), "assets/icon.png must remain the canonical icon");
  assert.strictEqual(
    fs.existsSync(RETIRED_TRAY_ICON),
    false,
    "the byte-identical assets/tray-icon.png copy must stay retired",
  );

  for (const relativePath of ["src/main.js", "src/menu.js"]) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
    assert.match(
      source,
      /iconPath: path\.join\(__dirname, "\.\.\/assets\/icon\.png"\)/,
      `${relativePath} should load the canonical icon for Windows/Linux trays`,
    );
    assert.doesNotMatch(
      source,
      /assets\/tray-icon\.png/,
      `${relativePath} must not restore the retired ordinary tray icon`,
    );
  }

  for (const relativePath of LOCALIZED_READMES) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
    assert.match(source, /<img src="assets\/icon\.png" width="128" alt="Clawd">/);
    assert.doesNotMatch(source, /assets\/tray-icon\.png/);
  }
});

test("canonical and tray-specific icons remain packaged", () => {
  for (const relativePath of PACKAGED_ICON_ASSETS) {
    assert.ok(fs.existsSync(path.join(ROOT, relativePath)), `${relativePath} must remain`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const relativePath of PACKAGED_ICON_ASSETS) {
    assert.ok(
      pkg.build.files.some((pattern) => minimatch(relativePath, pattern)),
      `${relativePath} must remain matched by build.files`,
    );
  }
});

test("asset policy owns only the canonical ordinary application icon", () => {
  const policy = JSON.parse(
    fs.readFileSync(path.join(ROOT, "tools", "repository-asset-policy.json"), "utf8"),
  );
  const entries = Array.isArray(policy.entries) ? policy.entries : [];
  const canonical = entries.find((entry) => entry.path === "assets/icon.png");

  assert.ok(canonical, "asset policy must retain the canonical icon entry");
  assert.strictEqual(canonical.owner, "build-release");
  assert.strictEqual(canonical.packaged, true);
  assert.strictEqual(
    entries.some((entry) => entry.path === "assets/tray-icon.png"),
    false,
    "asset policy must not retain a stale entry for the retired duplicate",
  );
});
