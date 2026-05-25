"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const CLAWD_THEME_PATH = path.join(REPO_ROOT, "themes", "clawd", "theme.json");
const CLAWD_SVG_DIR = path.join(REPO_ROOT, "assets", "svg");
const MINI_ENTER_STATES = ["mini-enter", "mini-enter-sleep"];

function readRootSvgTag(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const root = content.match(/<svg\b[^>]*>/i);
  return root ? root[0] : null;
}

function miniStateSvg(theme, state) {
  const files = theme && theme.miniMode && theme.miniMode.states && theme.miniMode.states[state];
  assert.ok(Array.isArray(files), `Clawd ${state} should map to a file list`);
  assert.strictEqual(files.length, 1, `Clawd ${state} should map to one SVG file`);
  assert.match(files[0], /\.svg$/i, `Clawd ${state} should use an SVG asset`);
  assert.ok(!files[0].includes("/") && !files[0].includes("\\"), `${state} asset should stay in assets/svg`);
  return files[0];
}

describe("Clawd mini enter SVG rendering", () => {
  it("does not force crisp root rendering on rotated mini enter assets", () => {
    const theme = JSON.parse(fs.readFileSync(CLAWD_THEME_PATH, "utf8"));

    for (const state of MINI_ENTER_STATES) {
      const file = miniStateSvg(theme, state);
      const root = readRootSvgTag(path.join(CLAWD_SVG_DIR, file));

      assert.ok(root, `${file} should have a root <svg> tag`);
      assert.doesNotMatch(
        root,
        /\bshape-rendering\s*=\s*["']crispEdges["']/i,
        `${file} should not force crispEdges at the root SVG`
      );
    }
  });
});
