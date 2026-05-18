"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");
const CLAWD_THEME_PATH = path.join(REPO_ROOT, "themes", "clawd", "theme.json");
const CLAWD_SVG_DIR = path.join(REPO_ROOT, "assets", "svg");

function addSvgFile(out, file) {
  if (typeof file === "string" && file.endsWith(".svg")) out.add(file);
}

function addStateEntry(out, entry) {
  if (Array.isArray(entry)) {
    for (const file of entry) addSvgFile(out, file);
    return;
  }
  if (entry && typeof entry === "object" && Array.isArray(entry.files)) {
    for (const file of entry.files) addSvgFile(out, file);
  }
}

function collectClawdRuntimeSvgFiles(theme) {
  const files = new Set();

  for (const entry of Object.values(theme.states || {})) addStateEntry(files, entry);
  for (const entry of Object.values((theme.miniMode && theme.miniMode.states) || {})) {
    addStateEntry(files, entry);
  }
  for (const groupName of ["workingTiers", "jugglingTiers", "idleAnimations"]) {
    for (const entry of theme[groupName] || []) addSvgFile(files, entry && entry.file);
  }
  for (const entry of Object.values(theme.reactions || {})) {
    addSvgFile(files, entry && entry.file);
    for (const file of (entry && entry.files) || []) addSvgFile(files, file);
  }
  for (const file of Object.values(theme.displayHintMap || {})) addSvgFile(files, file);
  addSvgFile(files, theme.updateVisuals && theme.updateVisuals.checking);

  return [...files].sort();
}

function readRootSvgTag(file) {
  const content = fs.readFileSync(file, "utf8");
  const root = content.match(/<svg\b[^>]*>/i);
  return root ? root[0] : null;
}

describe("Clawd SVG rendering", () => {
  it("keeps runtime Clawd SVG roots in geometric rendering mode", () => {
    const theme = JSON.parse(fs.readFileSync(CLAWD_THEME_PATH, "utf8"));
    const files = collectClawdRuntimeSvgFiles(theme);

    assert.strictEqual(files.length, 35);
    assert.ok(!files.includes("clawd-about-hero.svg"));
    assert.ok(!files.some((file) => file.includes("/") || file.includes("\\")));

    for (const file of files) {
      const filePath = path.join(CLAWD_SVG_DIR, file);
      const root = readRootSvgTag(filePath);
      assert.ok(root, `${file} should have a root <svg> tag`);
      assert.match(
        root,
        /\bshape-rendering\s*=\s*["']geometricPrecision["']/i,
        `${file} should use geometricPrecision at the root SVG`
      );
    }
  });
});
