#!/usr/bin/env node
"use strict";

/**
 * validate-theme.js — CLI tool to validate a Clawd theme before distribution.
 *
 * Usage:
 *   node scripts/validate-theme.js <theme-dir>
 *   node scripts/validate-theme.js themes/template
 *   node scripts/validate-theme.js ~/AppData/Roaming/clawd-on-desk/themes/my-theme
 *
 * Checks:
 *   1. theme.json schema (required fields, types, schemaVersion)
 *   2. Asset file existence (all files referenced in states/reactions/tiers)
 *   3. Eye tracking SVG structure (required IDs in SVG files)
 *   4. viewBox consistency
 */

const fs = require("fs");
const path = require("path");

// ── Colors (ANSI) ──
const R = "\x1b[31m";  // red
const G = "\x1b[32m";  // green
const Y = "\x1b[33m";  // yellow
const C = "\x1b[36m";  // cyan
const D = "\x1b[0m";   // reset

const PASS = `${G}\u2713${D}`;
const FAIL = `${R}\u2717${D}`;
const WARN = `${Y}!${D}`;

// ── Main ──

// Parse args: <theme-dir> [--assets <dir>]
const args = process.argv.slice(2);
let themeDir = null;
let assetsOverride = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--assets" && args[i + 1]) {
    assetsOverride = args[++i];
  } else if (!themeDir) {
    themeDir = args[i];
  }
}
if (!themeDir) {
  console.error(`Usage: node ${path.basename(process.argv[1])} <theme-directory> [--assets <assets-dir>]`);
  console.error(`Example: node scripts/validate-theme.js themes/template`);
  console.error(`         node scripts/validate-theme.js themes/clawd --assets assets/svg`);
  process.exit(1);
}

const resolvedDir = path.resolve(themeDir);
const jsonPath = path.join(resolvedDir, "theme.json");

if (!fs.existsSync(jsonPath)) {
  console.error(`${FAIL} theme.json not found at: ${jsonPath}`);
  process.exit(1);
}

let raw;
try {
  const content = fs.readFileSync(jsonPath, "utf8");
  raw = JSON.parse(content);
} catch (e) {
  console.error(`${FAIL} Failed to parse theme.json: ${e.message}`);
  process.exit(1);
}

console.log(`\n${C}Validating theme:${D} ${resolvedDir}\n`);

let errors = 0;
let warnings = 0;

// ── 1. Schema validation ──
console.log(`${C}[Schema]${D}`);

function check(condition, msg) {
  if (condition) {
    console.log(`  ${PASS} ${msg}`);
  } else {
    console.log(`  ${FAIL} ${msg}`);
    errors++;
  }
  return condition;
}

function warn(condition, msg) {
  if (!condition) {
    console.log(`  ${WARN} ${msg}`);
    warnings++;
  }
}

check(raw.schemaVersion === 1, `schemaVersion = 1 (got: ${raw.schemaVersion})`);
check(!!raw.name, `name is set (got: "${raw.name || ""}")`);
check(!!raw.version, `version is set (got: "${raw.version || ""}")`);
warn(!!raw.author, `author is recommended (got: "${raw.author || ""}")`);
warn(!!raw.description, `description is recommended`);

const vb = raw.viewBox;
if (check(vb && vb.x != null && vb.y != null && vb.width != null && vb.height != null,
    "viewBox has x, y, width, height")) {
  check(vb.width > 0, `viewBox.width > 0 (got: ${vb.width})`);
  check(vb.height > 0, `viewBox.height > 0 (got: ${vb.height})`);
}

const REQUIRED_STATES = ["idle", "working", "thinking", "sleeping", "waking"];

if (check(!!raw.states, "states object exists")) {
  for (const s of REQUIRED_STATES) {
    check(
      raw.states[s] && Array.isArray(raw.states[s]) && raw.states[s].length > 0,
      `states.${s} is a non-empty array`
    );
  }
}

// Eye tracking validation
if (raw.eyeTracking && raw.eyeTracking.enabled) {
  console.log(`\n${C}[Eye Tracking]${D}`);
  check(
    Array.isArray(raw.eyeTracking.states) && raw.eyeTracking.states.length > 0,
    "eyeTracking.states is a non-empty array"
  );
  // All eye tracking states must reference .svg files
  if (raw.states && raw.eyeTracking.states) {
    for (const stateName of raw.eyeTracking.states) {
      const files = raw.states[stateName] ||
                    (raw.miniMode && raw.miniMode.states && raw.miniMode.states[stateName]);
      if (files) {
        for (const f of files) {
          check(f.endsWith(".svg"),
            `eyeTracking state "${stateName}" file "${f}" is .svg`);
        }
      } else {
        warn(false, `eyeTracking state "${stateName}" is not defined in states`);
      }
    }
  }
}

// ── 2. Asset file existence ──
console.log(`\n${C}[Assets]${D}`);

const assetsDir = assetsOverride ? path.resolve(assetsOverride) : path.join(resolvedDir, "assets");
const assetsDirExists = fs.existsSync(assetsDir);
check(assetsDirExists, `assets/ directory exists`);

/** Collect all referenced asset filenames */
function collectFiles() {
  const files = new Set();
  // States
  if (raw.states) {
    for (const [key, arr] of Object.entries(raw.states)) {
      if (key.startsWith("_")) continue; // skip _comment
      if (Array.isArray(arr)) arr.forEach(f => files.add(f));
    }
  }
  // Mini mode states
  if (raw.miniMode && raw.miniMode.states) {
    for (const [key, arr] of Object.entries(raw.miniMode.states)) {
      if (key.startsWith("_")) continue;
      if (Array.isArray(arr)) arr.forEach(f => files.add(f));
    }
  }
  // Working tiers
  if (raw.workingTiers) {
    for (const tier of raw.workingTiers) {
      if (tier.file) files.add(tier.file);
    }
  }
  // Juggling tiers
  if (raw.jugglingTiers) {
    for (const tier of raw.jugglingTiers) {
      if (tier.file) files.add(tier.file);
    }
  }
  // Idle animations
  if (raw.idleAnimations) {
    for (const anim of raw.idleAnimations) {
      if (anim.file) files.add(anim.file);
    }
  }
  // Reactions
  if (raw.reactions) {
    for (const [key, react] of Object.entries(raw.reactions)) {
      if (key.startsWith("_")) continue;
      if (react.file) files.add(react.file);
      if (react.files) react.files.forEach(f => files.add(f));
    }
  }
  // Display hint map values
  if (raw.displayHintMap) {
    for (const f of Object.values(raw.displayHintMap)) {
      if (f) files.add(f);
    }
  }
  return files;
}

const referencedFiles = collectFiles();
let missingCount = 0;
let presentCount = 0;

if (assetsDirExists) {
  for (const file of [...referencedFiles].sort()) {
    const filePath = path.join(assetsDir, file);
    if (fs.existsSync(filePath)) {
      presentCount++;
    } else {
      console.log(`  ${FAIL} Missing asset: ${file}`);
      missingCount++;
      errors++;
    }
  }
  if (missingCount === 0) {
    console.log(`  ${PASS} All ${presentCount} referenced assets exist`);
  } else {
    console.log(`  ${FAIL} ${missingCount}/${referencedFiles.size} assets missing`);
  }

  // Check for orphan files (in assets/ but not referenced)
  try {
    const actualFiles = fs.readdirSync(assetsDir).filter(f => {
      try { return fs.statSync(path.join(assetsDir, f)).isFile(); } catch { return false; }
    });
    const orphans = actualFiles.filter(f => !referencedFiles.has(f));
    if (orphans.length > 0) {
      console.log(`  ${WARN} ${orphans.length} unreferenced file(s) in assets/: ${orphans.join(", ")}`);
      warnings++;
    }
  } catch {}
}

// ── 3. SVG structure check (eye tracking IDs) ──
if (raw.eyeTracking && raw.eyeTracking.enabled && assetsDirExists) {
  console.log(`\n${C}[SVG Structure]${D}`);
  const ids = raw.eyeTracking.ids || { eyes: "eyes-js", body: "body-js", shadow: "shadow-js" };
  const eyesId = ids.eyes;
  const optionalIds = [ids.body, ids.shadow].filter(Boolean);

  // Check each eye tracking SVG
  const eyeStates = raw.eyeTracking.states || [];
  for (const stateName of eyeStates) {
    const files = raw.states && raw.states[stateName] ||
                  (raw.miniMode && raw.miniMode.states && raw.miniMode.states[stateName]) || [];
    for (const file of files) {
      if (!file.endsWith(".svg")) continue;
      const svgPath = path.join(assetsDir, file);
      if (!fs.existsSync(svgPath)) continue;

      try {
        const content = fs.readFileSync(svgPath, "utf8");
        // Eyes ID is required for eye tracking to work
        const hasEyes = content.includes(`id="${eyesId}"`);
        // Doze states may use dozeEyes instead
        const dozeId = ids.dozeEyes;
        const hasDoze = dozeId && content.includes(`id="${dozeId}"`);
        if (hasEyes) {
          console.log(`  ${PASS} ${file}: contains id="${eyesId}"`);
        } else if (hasDoze) {
          console.log(`  ${PASS} ${file}: contains id="${dozeId}" (doze eyes)`);
        } else {
          check(false, `${file}: missing id="${eyesId}" (required for eye tracking)`);
        }
        // Body and shadow are optional (renderer null-checks them)
        for (const id of optionalIds) {
          if (!content.includes(`id="${id}"`)) {
            warn(false, `${file}: missing id="${id}" (optional, enables body lean/shadow stretch)`);
          }
        }
      } catch (e) {
        console.log(`  ${FAIL} Failed to read ${file}: ${e.message}`);
        errors++;
      }
    }
  }
}

// ── 4. Additional checks ──
console.log(`\n${C}[Additional]${D}`);

// hitBoxes
if (raw.hitBoxes) {
  const def = raw.hitBoxes.default;
  check(
    def && def.x != null && def.y != null && def.w != null && def.h != null,
    "hitBoxes.default has x, y, w, h"
  );
} else {
  warn(false, "hitBoxes not specified (will use defaults)");
}

// workingTiers sort order
if (raw.workingTiers && raw.workingTiers.length > 1) {
  const sorted = [...raw.workingTiers].sort((a, b) => b.minSessions - a.minSessions);
  const isCorrect = raw.workingTiers.every((t, i) => t.minSessions === sorted[i].minSessions);
  if (!isCorrect) {
    warn(false, "workingTiers: recommend ordering by minSessions descending (auto-sorted at runtime)");
  }
}

// Mini mode
if (raw.miniMode && raw.miniMode.supported) {
  const miniStates = ["mini-idle", "mini-enter", "mini-peek", "mini-sleep"];
  for (const s of miniStates) {
    if (!raw.miniMode.states || !raw.miniMode.states[s]) {
      warn(false, `miniMode.supported=true but missing miniMode.states.${s}`);
    }
  }
}

// ── Summary ──
console.log(`\n${"─".repeat(40)}`);
if (errors === 0 && warnings === 0) {
  console.log(`${G}All checks passed!${D} Theme "${raw.name}" is ready.\n`);
} else if (errors === 0) {
  console.log(`${G}Passed${D} with ${Y}${warnings} warning(s)${D}. Theme "${raw.name}" is usable.\n`);
} else {
  console.log(`${R}${errors} error(s)${D}${warnings > 0 ? `, ${Y}${warnings} warning(s)${D}` : ""}. Fix errors before distributing.\n`);
}

process.exit(errors > 0 ? 1 : 0);
