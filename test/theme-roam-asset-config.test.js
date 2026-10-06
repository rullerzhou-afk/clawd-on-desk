"use strict";

// Static config checks for the builtin themes' roam bindings.
//
// Guards the offset-reuse trap behind #569's calico roam fix: a file that is
// referenced by BOTH a top-level state and a miniMode state renders through
// two different layout pipelines (mini mode uses the raw pixel branch, the
// main window uses the normalized layout branch), and both branches add the
// same objectScale.fileOffsets entry verbatim. A pixel offset calibrated for
// the mini window is wrong in the main window, so shared files must not carry
// one — give the non-mini binding its own file (see calico-roam-crabwalk.apng).

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const THEMES_DIR = path.join(__dirname, "..", "themes");
const SHARED_SVG_DIR = path.join(__dirname, "..", "assets", "svg");

function loadBuiltinThemes() {
  return fs.readdirSync(THEMES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const jsonPath = path.join(THEMES_DIR, entry.name, "theme.json");
      if (!fs.existsSync(jsonPath)) return null;
      return {
        id: entry.name,
        dir: path.join(THEMES_DIR, entry.name),
        cfg: JSON.parse(fs.readFileSync(jsonPath, "utf8")),
      };
    })
    .filter(Boolean);
}

function stateFiles(states) {
  const files = new Set();
  for (const [key, entry] of Object.entries(states || {})) {
    if (key.startsWith("_")) continue;
    const list = Array.isArray(entry) ? entry : (entry && entry.files) || [];
    for (const file of list) files.add(file);
  }
  return files;
}

describe("builtin theme roam asset config", () => {
  const themes = loadBuiltinThemes();

  it("roam bindings point at files that exist", () => {
    for (const { id, dir, cfg } of themes) {
      const roam = cfg.states && cfg.states.roam;
      if (!Array.isArray(roam)) continue;
      for (const file of roam) {
        const inTheme = fs.existsSync(path.join(dir, "assets", file));
        const inShared = fs.existsSync(path.join(SHARED_SVG_DIR, file));
        assert.ok(inTheme || inShared, `${id}: states.roam file "${file}" not found in theme assets or shared assets/svg`);
      }
    }
  });

  it("files shared between top-level and mini states carry no per-file pixel offset", () => {
    for (const { id, cfg } of themes) {
      const topLevel = stateFiles(cfg.states);
      const mini = stateFiles(cfg.miniMode && cfg.miniMode.states);
      const offsets = (cfg.objectScale && cfg.objectScale.fileOffsets) || {};

      for (const file of topLevel) {
        if (!mini.has(file)) continue;
        const fo = offsets[file];
        const hasOffset = fo && ((fo.x || 0) !== 0 || (fo.y || 0) !== 0);
        assert.ok(
          !hasOffset,
          `${id}: "${file}" is used by both a top-level state and a mini state but has a nonzero fileOffsets entry `
          + `(${JSON.stringify(fo)}) — the two layout pipelines interpret it differently; bind a dedicated copy instead`
        );
      }
    }
  });
});
