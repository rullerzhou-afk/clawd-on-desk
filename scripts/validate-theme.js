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
const themeLoader = require("../src/theme-loader");
const themeSchema = require("../src/theme-schema");
const { VARIANT_ALLOWED_KEYS } = require("../src/theme-variants");

// ── Colors (ANSI) ──
const R = "\x1b[31m";  // red
const G = "\x1b[32m";  // green
const Y = "\x1b[33m";  // yellow
const C = "\x1b[36m";  // cyan
const D = "\x1b[0m";   // reset

const PASS = `${G}\u2713${D}`;
const FAIL = `${R}\u2717${D}`;
const WARN = `${Y}!${D}`;
const {
  REQUIRED_STATES,
  FULL_SLEEP_REQUIRED_STATES,
  MINI_REQUIRED_STATES,
  VISUAL_FALLBACK_STATES,
  isPlainObject,
  hasNonEmptyArray,
  getStateFiles,
  hasStateFiles,
  hasStateBinding,
  normalizeStateBindings,
  hasReactionBindings,
  deriveIdleMode,
  deriveSleepMode,
} = themeLoader;

// ── Main ──

// Parse args: <theme-dir> [--assets <dir>]
const args = process.argv.slice(2);
let themeDir = null;
let assetsOverride = null;

function printUsage() {
  console.error(`Usage: node ${path.basename(process.argv[1])} <theme-directory> [--assets <assets-dir>]`);
  console.error(`Example: node scripts/validate-theme.js themes/template`);
  console.error(`         node scripts/validate-theme.js themes/clawd --assets assets/svg`);
}

// Anything the parser does not understand is refused rather than ignored. The old
// loop silently dropped unknown flags, surplus positional arguments, and a
// value-less `--assets`, so a mistyped command ran against the DEFAULT paths and
// then reported the theme as valid -- the tool answering a question nobody asked.
//
// Refusing unknown options costs the one thing the permissive loop got for free: a
// path that genuinely begins with "-". `--` ends option parsing for that case, so
// no invocation that worked before is unreachable now.
let optionsEnded = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (!optionsEnded && arg === "--") {
    optionsEnded = true;
  } else if (!optionsEnded && arg === "--assets") {
    if (assetsOverride !== null) {
      console.error(`${FAIL} --assets given more than once`);
      printUsage();
      process.exit(1);
    }
    const value = args[i + 1];
    // Only absent or empty counts as "no path given". A value that merely looks
    // like a flag is still passed to the filesystem, which is the thing that
    // actually knows whether it is a usable directory.
    if (value === undefined || value === "") {
      console.error(`${FAIL} --assets requires a directory argument`);
      printUsage();
      process.exit(1);
    }
    assetsOverride = value;
    i++;
  } else if (!optionsEnded && arg.startsWith("-") && arg !== "-") {
    console.error(`${FAIL} Unknown option: ${arg}`);
    console.error(`  (if that is a real path, pass it after --)`);
    printUsage();
    process.exit(1);
  } else if (themeDir === null) {
    themeDir = arg;
  } else {
    console.error(`${FAIL} Unexpected extra argument: ${arg}`);
    printUsage();
    process.exit(1);
  }
}
// Falsy, not just null: `validate-theme.js "$SOME_UNSET_VAR"` passes an empty
// string, which path.resolve() turns into the current directory -- so without
// this the script would go and validate whatever the caller happened to be in.
if (!themeDir) {
  console.error(`${FAIL} No theme directory given`);
  printUsage();
  process.exit(1);
}

const resolvedDir = path.resolve(themeDir);
const jsonPath = path.join(resolvedDir, "theme.json");

// An explicit --assets override that does not resolve to a usable directory is a
// mistake in the command, not a property of the theme -- so the message has to say
// which one it is. Pointing --assets at a file used to produce a 27-error report
// about the theme, sending the author hunting for theme bugs that do not exist.
// The default `<theme>/assets` being absent is deliberately NOT handled here: that
// one really is a property of the theme, and stays a normal validation error below.
if (assetsOverride !== null) {
  const overrideDir = path.resolve(assetsOverride);
  let overrideStat;
  try {
    overrideStat = fs.statSync(overrideDir);
  } catch (e) {
    // Only ENOENT means "not there". ENOTDIR, ELOOP, EACCES and friends are all
    // different problems and must not be flattened into one claim.
    const why = e.code === "ENOENT" ? "not found" : `cannot be accessed (${e.code})`;
    console.error(`${FAIL} --assets directory ${why}: ${overrideDir}`);
    process.exit(1);
  }
  if (!overrideStat.isDirectory()) {
    console.error(`${FAIL} --assets path is not a directory: ${overrideDir}`);
    process.exit(1);
  }
}

if (!fs.existsSync(jsonPath)) {
  console.error(`${FAIL} theme.json not found at: ${jsonPath}`);
  process.exit(1);
}

let raw;
try {
  const content = fs.readFileSync(jsonPath, "utf8");
  raw = JSON.parse(content);
} catch (e) {
  // The try block covers readFileSync as well as JSON.parse, so this must not
  // claim "parse" for what may have been a read failure (e.g. EISDIR).
  console.error(`${FAIL} Failed to read or parse theme.json: ${e.message}`);
  process.exit(1);
}

// theme.json has to be a JSON object for the checks below to walk it. `null` crashes
// property access with an uncaught TypeError (a stack trace instead of a message),
// and a number/string/boolean produces meaningless FAIL lines that read like real
// findings about a theme that was never there. An array is deliberately let through:
// nothing below it crashes, and its total absence of fields is a genuine "theme has
// errors" outcome rather than a broken command.
if (!isPlainObject(raw) && !Array.isArray(raw)) {
  console.error(`${FAIL} theme.json must contain a JSON object (got: ${raw === null ? "null" : typeof raw})`);
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

function svgHasClass(content, className) {
  if (typeof content !== "string" || typeof className !== "string" || !className) return false;
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const classAttrRe = new RegExp(`class=["'][^"']*\\b${escaped}\\b[^"']*["']`);
  return classAttrRe.test(content);
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
const sleepMode = deriveSleepMode(raw);
const normalizedStates = normalizeStateBindings(raw.states);
const accessorySchemaErrors = themeSchema.validateTheme(raw)
  .filter((message) => message.includes("customization.accessories"));
// `false`/`null` is the documented opt-out, not a misconfiguration.
if (raw.customization && raw.customization.accessories) {
  if (accessorySchemaErrors.length === 0) {
    // Schema-valid is not the same as usable: a coverage gap (a visual with no
    // descriptor to fall back on) raises no schema error but still turns the
    // capability off, and Settings then hides the wardrobe with no explanation.
    // Saying "valid" and stopping there is how an author ships a theme whose
    // accessories silently never appear.
    if (themeSchema.deriveAccessoryCapability(raw)) {
      console.log(`  ${PASS} customization.accessories attachment geometry is schema-valid`);
    } else {
      console.log(
        `  ${WARN} customization.accessories is schema-valid but does not cover every visual, `
        + "so accessories stay disabled for this theme and the wardrobe is hidden"
      );
      warnings++;
    }
  } else {
    for (const message of accessorySchemaErrors) {
      console.log(`  ${FAIL} ${message}`);
      errors++;
    }
  }
}

if (check(!!raw.states, "states object exists")) {
  for (const s of REQUIRED_STATES) {
    check(
      hasStateFiles(raw.states[s]),
      `states.${s} has at least one file`
    );
  }
  check(
    hasStateBinding(raw.states && raw.states.sleeping),
    "states.sleeping has files or fallbackTo"
  );
}

check(
  raw.sleepSequence === undefined
    || (isPlainObject(raw.sleepSequence) && (raw.sleepSequence.mode === "full" || raw.sleepSequence.mode === "direct")),
  `sleepSequence.mode is "full" or "direct" (resolved: ${sleepMode})`
);

if (sleepMode === "full") {
  for (const s of FULL_SLEEP_REQUIRED_STATES) {
    check(
      hasStateFiles(raw.states && raw.states[s]),
      `sleepSequence.mode=full requires states.${s} with real files`
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
      const stateFiles = getStateFiles(raw.states[stateName]);
      const files = stateFiles.length > 0
        ? stateFiles
        : (raw.miniMode && raw.miniMode.states && raw.miniMode.states[stateName]);
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
    for (const [key, entry] of Object.entries(raw.states)) {
      if (key.startsWith("_")) continue; // skip _comment
      getStateFiles(entry).forEach((f) => files.add(f));
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
      if (react.fileLeft) files.add(react.fileLeft);
      if (react.fileRight) files.add(react.fileRight);
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
  const trackingLayers = isPlainObject(raw.eyeTracking.trackingLayers) ? raw.eyeTracking.trackingLayers : null;

  // Check each eye tracking SVG
  const eyeStates = raw.eyeTracking.states || [];
  for (const stateName of eyeStates) {
    const stateFiles = getStateFiles(raw.states && raw.states[stateName]);
    const files = stateFiles.length > 0
      ? stateFiles
      : (raw.miniMode && raw.miniMode.states && raw.miniMode.states[stateName]) || [];
    for (const file of files) {
      if (!file.endsWith(".svg")) continue;
      const svgPath = path.join(assetsDir, file);
      if (!fs.existsSync(svgPath)) continue;

      try {
        const content = fs.readFileSync(svgPath, "utf8");
        if (trackingLayers) {
          let matchedAnyLayer = false;
          for (const [layerName, layerCfg] of Object.entries(trackingLayers)) {
            const layerIds = Array.isArray(layerCfg && layerCfg.ids) ? layerCfg.ids : [];
            const layerClasses = Array.isArray(layerCfg && layerCfg.classes) ? layerCfg.classes : [];
            if (layerIds.length === 0 && layerClasses.length === 0) {
              warn(false, `${file}: trackingLayers.${layerName} has no ids/classes`);
              continue;
            }
            let layerMatched = false;
            for (const id of layerIds) {
              if (content.includes(`id="${id}"`)) layerMatched = true;
              else warn(false, `${file}: missing trackingLayers.${layerName}.ids entry "${id}"`);
            }
            for (const className of layerClasses) {
              if (svgHasClass(content, className)) layerMatched = true;
              else warn(false, `${file}: missing trackingLayers.${layerName}.classes entry "${className}"`);
            }
            if (layerMatched) matchedAnyLayer = true;
          }
          check(matchedAnyLayer, `${file}: trackingLayers matched at least one configured element/class`);
        } else {
          // Eyes ID is required for legacy eye tracking to work
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
if (isPlainObject(raw.miniMode) && raw.miniMode.supported !== false) {
  for (const s of MINI_REQUIRED_STATES) {
    check(
      raw.miniMode.states && Array.isArray(raw.miniMode.states[s]) && raw.miniMode.states[s].length > 0,
      `miniMode.supported=true requires miniMode.states.${s}`
    );
  }
}

console.log(`\n${C}[Fallback]${D}`);
const fallbackEntries = Object.entries(normalizedStates).filter(([, entry]) => !!entry.fallbackTo);
if (fallbackEntries.length === 0) {
  console.log(`  ${PASS} no states.<x>.fallbackTo entries declared`);
} else {
  for (const [stateKey, entry] of fallbackEntries) {
    check(
      VISUAL_FALLBACK_STATES.has(stateKey),
      `states.${stateKey}.fallbackTo is only allowed on error/attention/notification/sweeping/carrying/sleeping`
    );
    check(
      Object.prototype.hasOwnProperty.call(normalizedStates, entry.fallbackTo),
      `states.${stateKey}.fallbackTo target "${entry.fallbackTo}" exists`
    );
    const visited = new Set([stateKey]);
    let hops = 0;
    let cursor = stateKey;
    let cycle = false;
    let missingTarget = false;
    while (true) {
      const current = normalizedStates[cursor];
      if (!current || !current.fallbackTo) break;
      const target = current.fallbackTo;
      hops++;
      if (hops > 3) break;
      if (visited.has(target)) {
        cycle = true;
        break;
      }
      if (!Object.prototype.hasOwnProperty.call(normalizedStates, target)) {
        missingTarget = true;
        break;
      }
      visited.add(target);
      cursor = target;
    }
    check(!cycle, `states.${stateKey}.fallbackTo chain is acyclic`);
    check(!missingTarget, `states.${stateKey}.fallbackTo chain targets existing states`);
    check(hops <= 3, `states.${stateKey}.fallbackTo resolves within 3 hop(s)`);
    const terminal = normalizedStates[cursor];
    check(
      !!terminal && hasStateFiles(terminal),
      `states.${stateKey}.fallbackTo chain terminates in real files`
    );
  }
}
check(
  Object.keys(normalizedStates).some((stateKey) => hasStateFiles(normalizedStates[stateKey])),
  "theme declares at least one state with real files"
);

// ── 5. Variants (Phase 3b-swap) ──
// Spec lives in docs/plans/plan-settings-panel-3b-swap.md §6.4 "Validator Spec".
// Rules 1, 2, 3, 4, 6, 7, 8 implemented here. Rule 5 (SVG eye-tracking on
// variant-introduced assets) is folded into rule 3's asset scan below.
// Reserved fields a variant cannot declare. `name` / `description` are
// intentionally absent — inside a variant they are that variant's LABEL, not
// an attempt to override the theme's root display name.
const VARIANT_RESERVED_KEYS = new Set([
  "schemaVersion", "version", "viewBox", "layout",
  "eyeTracking", "states", "reactions", "miniMode", "sounds",
]);
const VARIANT_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_VARIANT_ID_LEN = 32;

function collectVariantAssetFiles(variantSpec) {
  const files = new Set();
  if (!variantSpec || typeof variantSpec !== "object") return files;
  if (typeof variantSpec.preview === "string") files.add(variantSpec.preview);
  for (const field of ["workingTiers", "jugglingTiers", "idleAnimations"]) {
    if (Array.isArray(variantSpec[field])) {
      for (const entry of variantSpec[field]) {
        if (entry && typeof entry.file === "string") files.add(entry.file);
      }
    }
  }
  for (const field of ["wideHitboxFiles", "sleepingHitboxFiles"]) {
    if (Array.isArray(variantSpec[field])) {
      for (const f of variantSpec[field]) if (typeof f === "string") files.add(f);
    }
  }
  if (variantSpec.displayHintMap && typeof variantSpec.displayHintMap === "object") {
    // Per §6.4 rule 3 note: keys are hook tokens, NOT local assets.
    // Only values map to files on disk.
    for (const v of Object.values(variantSpec.displayHintMap)) {
      if (typeof v === "string") files.add(v);
    }
  }
  return files;
}

// Build the union of every asset name referenced in the *base* theme fields
// that the allow-list governs — used for rule 4 "new asset must have objectScale entry".
function collectBaseAssetFiles(base) {
  const files = new Set();
  for (const field of ["workingTiers", "jugglingTiers", "idleAnimations"]) {
    if (Array.isArray(base[field])) {
      for (const entry of base[field]) {
        if (entry && typeof entry.file === "string") files.add(entry.file);
      }
    }
  }
  if (base.states) {
    for (const entry of Object.values(base.states)) {
      for (const f of getStateFiles(entry)) files.add(f);
    }
  }
  if (base.miniMode && base.miniMode.states) {
    for (const arr of Object.values(base.miniMode.states)) {
      if (Array.isArray(arr)) for (const f of arr) files.add(f);
    }
  }
  if (base.displayHintMap) {
    for (const v of Object.values(base.displayHintMap)) {
      if (typeof v === "string") files.add(v);
    }
  }
  return files;
}

if (raw.variants !== undefined) {
  console.log(`\n${C}[Variants]${D}`);

  // Rule 6: variantsSchemaVersion
  if (raw.variantsSchemaVersion !== 0) {
    warn(false, `variantsSchemaVersion = 0 expected (got: ${raw.variantsSchemaVersion})`);
  }

  if (!raw.variants || typeof raw.variants !== "object" || Array.isArray(raw.variants)) {
    check(false, "variants must be a plain object");
  } else {
    const baseAssets = collectBaseAssetFiles(raw);
    const baseHasFileScales = raw.objectScale
      && (raw.objectScale.fileScales || raw.objectScale.fileOffsets);
    const baseDisplayHintMap = raw.displayHintMap || {};
    const eyeTrackingOn = !!(raw.eyeTracking && raw.eyeTracking.enabled);
    const eyesId = (raw.eyeTracking && raw.eyeTracking.ids && raw.eyeTracking.ids.eyes) || "eyes-js";

    for (const [variantId, variantSpec] of Object.entries(raw.variants)) {
      console.log(`\n  ${C}[Variant: ${variantId}]${D}`);

      // Rule 2: variant id syntax
      if (!VARIANT_ID_RE.test(variantId) || variantId.length > MAX_VARIANT_ID_LEN) {
        check(false, `variant id "${variantId}" must match [a-z0-9][a-z0-9_-]* (≤${MAX_VARIANT_ID_LEN} chars)`);
        continue;
      }

      if (!variantSpec || typeof variantSpec !== "object" || Array.isArray(variantSpec)) {
        check(false, `variant "${variantId}" must be a plain object`);
        continue;
      }

      // Rule 1 + Rule 8: field allow-list + reserved keys
      for (const key of Object.keys(variantSpec)) {
        if (VARIANT_RESERVED_KEYS.has(key)) {
          check(false, `variant "${variantId}" cannot override reserved field "${key}" (publish a new theme instead)`);
        } else if (!VARIANT_ALLOWED_KEYS.has(key)) {
          check(false, `variant "${variantId}" declares unknown field "${key}" (not in allow-list)`);
        }
      }

      // Rule 3: asset existence (format-agnostic: svg/apng/gif)
      const variantAssets = collectVariantAssetFiles(variantSpec);
      if (assetsDirExists) {
        for (const file of variantAssets) {
          const basename = path.basename(file);
          const filePath = path.join(assetsDir, basename);
          if (!fs.existsSync(filePath)) {
            check(false, `variant "${variantId}" references missing asset: ${file}`);
          }
          // Rule 5 (folded in): if eye tracking is enabled and this is an SVG
          // introduced by the variant (not in base assets), check eyes-js.
          // Mild check: warn, not fail — most variant SVGs don't land in
          // eye-tracked states, but we can't tell without resolving the tier
          // → state mapping, which would duplicate state.js logic.
          if (eyeTrackingOn && basename.endsWith(".svg") && !baseAssets.has(basename) && fs.existsSync(filePath)) {
            try {
              const content = fs.readFileSync(filePath, "utf8");
              if (!content.includes(`id="${eyesId}"`)) {
                warn(false, `variant "${variantId}" asset "${basename}": missing id="${eyesId}" (harmless if never rendered in an eye-tracked state)`);
              }
            } catch (e) {
              warn(false, `variant "${variantId}": failed to read "${basename}" for eye-tracking check: ${e.message}`);
            }
          }
        }
      }

      // Rule 4: objectScale sync — only enforced when base theme declares
      // per-file scales/offsets (= author uses this convention).
      if (baseHasFileScales) {
        const baseScales = (raw.objectScale && raw.objectScale.fileScales) || {};
        const variantScales = (variantSpec.objectScale && variantSpec.objectScale.fileScales) || {};
        for (const file of variantAssets) {
          const basename = path.basename(file);
          if (baseAssets.has(basename)) continue;  // existing asset — base's entry (or absence) is fine
          if (!baseScales[basename] && !variantScales[basename]) {
            check(false, `variant "${variantId}" introduces "${basename}" but neither base nor variant declares objectScale.fileScales entry`);
          }
        }
      }

      // Rule 7: displayHintMap override warning
      if (variantSpec.workingTiers && !variantSpec.displayHintMap) {
        const newTierFiles = new Set();
        for (const entry of variantSpec.workingTiers) {
          if (entry && typeof entry.file === "string") newTierFiles.add(path.basename(entry.file));
        }
        const hintOverlap = [];
        for (const [hintKey, hintValue] of Object.entries(baseDisplayHintMap)) {
          // If the base map pins a working-tier file, and variant changed that slot,
          // base map will override the tier selection at runtime.
          if (newTierFiles.has(path.basename(hintValue)) || newTierFiles.has(path.basename(hintKey))) {
            hintOverlap.push(hintKey);
          }
        }
        if (hintOverlap.length > 0) {
          warn(false, `variant "${variantId}": workingTiers override without displayHintMap — base hints [${hintOverlap.join(", ")}] may shadow tier selection`);
        }
      }

      console.log(`    ${PASS} variant "${variantId}" structurally valid (${variantAssets.size} asset ref${variantAssets.size === 1 ? "" : "s"})`);
    }
  }
}

console.log(`\n${C}[Capabilities]${D}`);
const capabilities = {
  eyeTracking: !!(
    isPlainObject(raw.eyeTracking)
    && raw.eyeTracking.enabled
    && hasNonEmptyArray(raw.eyeTracking.states)
  ),
  miniMode: !!(isPlainObject(raw.miniMode) && raw.miniMode.supported !== false),
  idleAnimations: hasNonEmptyArray(raw.idleAnimations),
  reactions: hasReactionBindings(raw.reactions),
  workingTiers: hasNonEmptyArray(raw.workingTiers),
  jugglingTiers: hasNonEmptyArray(raw.jugglingTiers),
  idleMode: deriveIdleMode(raw),
  sleepMode,
};
for (const [key, value] of Object.entries(capabilities)) {
  console.log(`  ${PASS} ${key}: ${value}`);
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
