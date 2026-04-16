"use strict";

// ── Preferences (pure data layer) ──
//
// This module is the canonical schema definition + load/save/migrate/validate
// for `clawd-prefs.json`. It has zero dependencies on Electron, the store, the
// controller, or anything stateful — it deals in plain snapshots.
//
// `load(prefsPath)`  — read file, migrate to current version, validate, return snapshot
// `save(prefsPath, snapshot)` — validate (lightly) + write JSON
// `getDefaults()` — fresh defaults snapshot (every call returns a new object — never share refs)
// `validate(snapshot)` — coerces an arbitrary object into a valid snapshot, dropping bad fields
// `migrate(raw)` — applies version-to-version migrations, returns the upgraded raw snapshot
//
// Bad-file handling: read failure → backup as `clawd-prefs.json.bak` → return defaults.
// Future-version handling: read succeeds but version > current → warn + refuse to overwrite
//   (caller still gets a valid snapshot, but `save()` becomes a no-op via the locked flag).

const fs = require("fs");
const path = require("path");

const CURRENT_VERSION = 1;

// ── Schema ──
// Each field has: type, default OR defaultFactory, optional enum/normalize/validate.
// `defaultFactory` is required for object/array fields so callers never share references.
const SCHEMA = {
  version: {
    type: "number",
    default: CURRENT_VERSION,
  },
  // Window state
  x: { type: "number", default: 0, validate: (v) => Number.isFinite(v) },
  y: { type: "number", default: 0, validate: (v) => Number.isFinite(v) },
  positionSaved: { type: "boolean", default: false },
  size: {
    type: "string",
    default: "P:10",
    // Accept "S"/"M"/"L" (legacy) or "P:<num>" — full migration happens elsewhere.
    validate: (v) =>
      typeof v === "string" &&
      (v === "S" || v === "M" || v === "L" || /^P:\d+(?:\.\d+)?$/.test(v)),
  },
  // Mini mode runtime state (persisted so Mini Mode survives restart)
  miniMode: { type: "boolean", default: false },
  miniEdge: { type: "string", default: "right", enum: ["left", "right"] },
  preMiniX: { type: "number", default: 0, validate: (v) => Number.isFinite(v) },
  preMiniY: { type: "number", default: 0, validate: (v) => Number.isFinite(v) },
  // Pure data prefs
  lang: { type: "string", default: "en", enum: ["en", "zh"] },
  showTray: { type: "boolean", default: true },
  showDock: { type: "boolean", default: true },
  autoStartWithClaude: { type: "boolean", default: false },
  // System-backed: actual truth lives in OS login items / autostart files.
  // `openAtLoginHydrated` starts false; main.js's startup hydrate helper imports
  // the current system value into prefs on first run, then flips this flag.
  // Without hydration, an upgrading user with login-startup already enabled
  // would see prefs report `false` and have it written back to the system.
  openAtLogin: { type: "boolean", default: false },
  openAtLoginHydrated: { type: "boolean", default: false },
  bubbleFollowPet: { type: "boolean", default: false },
  hideBubbles: { type: "boolean", default: false },
  showSessionId: { type: "boolean", default: false },
  soundMuted: { type: "boolean", default: false },
  // Theme
  theme: { type: "string", default: "clawd" },
  // Phase 2/3 placeholders — schema reserves the keys so future migrations don't need v2.
  agents: {
    type: "object",
    defaultFactory: () => ({
      "claude-code": { enabled: true, permissionsEnabled: true },
      "codex": { enabled: true, permissionsEnabled: true },
      "copilot-cli": { enabled: true, permissionsEnabled: true },
      "cursor-agent": { enabled: true, permissionsEnabled: true },
      "gemini-cli": { enabled: true, permissionsEnabled: true },
      "codebuddy": { enabled: true, permissionsEnabled: true },
      "kiro-cli": { enabled: true, permissionsEnabled: true },
      "opencode": { enabled: true, permissionsEnabled: true },
    }),
    normalize: normalizeAgents,
  },
  themeOverrides: {
    type: "object",
    defaultFactory: () => ({}),
    normalize: normalizeThemeOverrides,
  },
};

const SCHEMA_KEYS = Object.freeze(Object.keys(SCHEMA));

function defaultFor(field) {
  if (typeof field.defaultFactory === "function") return field.defaultFactory();
  return field.default;
}

// Build a fresh defaults snapshot. Each call returns a brand-new object so
// callers can never accidentally mutate a shared default.
function getDefaults() {
  const out = {};
  for (const key of SCHEMA_KEYS) {
    out[key] = defaultFor(SCHEMA[key]);
  }
  return out;
}

function isValidValue(field, value) {
  if (value === undefined || value === null) return false;
  if (field.type === "object") {
    return typeof value === "object" && !Array.isArray(value);
  }
  if (typeof value !== field.type) return false;
  if (field.enum && !field.enum.includes(value)) return false;
  if (typeof field.validate === "function" && !field.validate(value)) return false;
  return true;
}

// Coerce an arbitrary object into a valid snapshot — drop bad fields, fill
// missing fields from defaults, run normalize() on objects.
function validate(raw) {
  const out = getDefaults();
  if (!raw || typeof raw !== "object") return out;
  for (const key of SCHEMA_KEYS) {
    if (!(key in raw)) continue;
    const field = SCHEMA[key];
    let value = raw[key];
    if (field.type === "object" && typeof field.normalize === "function") {
      value = field.normalize(value, out[key]);
    }
    if (isValidValue(field, value)) {
      out[key] = value;
    }
    // else: keep default already in `out`
  }
  return out;
}

// Apply version-to-version migrations on raw input. Returns the upgraded raw
// object (still needs to be passed through validate()).
//
// v0 → v1: add `version`, `agents`, `themeOverrides` fields. Existing fields
//   stay as-is and get re-validated downstream. Pre-existing prefs files have
//   no `version` key — that's the v0 marker.
function migrate(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const out = { ...raw };
  if (out.version === undefined || out.version === null) {
    out.version = 1;
    if (out.agents === undefined) {
      out.agents = SCHEMA.agents.defaultFactory();
    }
    if (out.themeOverrides === undefined) {
      out.themeOverrides = SCHEMA.themeOverrides.defaultFactory();
    }
  }
  // v1 backfill: positionSaved didn't exist before this field was added.
  // Existing users who have non-default x/y clearly had a saved position.
  if (out.positionSaved === undefined) {
    out.positionSaved =
      (typeof out.x === "number" && out.x !== 0) ||
      (typeof out.y === "number" && out.y !== 0);
  }
  // Future migrations slot in here as `if (out.version < N) { ... out.version = N }`.
  return out;
}

const AGENT_FLAGS = ["enabled", "permissionsEnabled"];

function normalizeAgents(value, defaultsValue) {
  if (!value || typeof value !== "object") return defaultsValue;
  const out = { ...defaultsValue };
  for (const id of Object.keys(value)) {
    const entry = value[id];
    if (!entry || typeof entry !== "object") continue;
    const base = (defaultsValue && defaultsValue[id]) || { enabled: true, permissionsEnabled: true };
    const merged = { ...base };
    let touched = false;
    for (const flag of AGENT_FLAGS) {
      if (typeof entry[flag] === "boolean") {
        merged[flag] = entry[flag];
        touched = true;
      }
    }
    if (touched) out[id] = merged;
  }
  return out;
}

function normalizeThemeOverrides(value, defaultsValue) {
  if (!value || typeof value !== "object") return defaultsValue;
  const out = {};
  for (const themeId of Object.keys(value)) {
    const themeMap = value[themeId];
    if (!themeMap || typeof themeMap !== "object") continue;
    const cleanThemeMap = {};
    for (const stateKey of Object.keys(themeMap)) {
      const entry = themeMap[stateKey];
      if (
        entry &&
        typeof entry === "object" &&
        typeof entry.sourceThemeId === "string" &&
        typeof entry.file === "string"
      ) {
        cleanThemeMap[stateKey] = {
          sourceThemeId: entry.sourceThemeId,
          file: entry.file,
        };
      }
    }
    if (Object.keys(cleanThemeMap).length > 0) {
      out[themeId] = cleanThemeMap;
    }
  }
  return out;
}

// ── Disk I/O ──

// Read prefs from disk. Returns `{ snapshot, locked }`:
//   - snapshot: a valid prefs object (always — falls back to defaults on any error)
//   - locked: true if the file came from a future version; save() should be a no-op
//             to avoid clobbering it.
function load(prefsPath) {
  let raw;
  try {
    const text = fs.readFileSync(prefsPath, "utf8");
    raw = JSON.parse(text);
  } catch (err) {
    // Missing file is normal on first run — return defaults silently.
    if (err && err.code === "ENOENT") {
      return { snapshot: getDefaults(), locked: false };
    }
    // Any other error (parse fail, permission, etc.) → backup + defaults
    try {
      const bak = prefsPath + ".bak";
      fs.copyFileSync(prefsPath, bak);
      console.warn(`Clawd: prefs file unreadable, backed up to ${bak}:`, err.message);
    } catch (bakErr) {
      console.warn("Clawd: prefs file unreadable and backup failed:", err.message, bakErr.message);
    }
    return { snapshot: getDefaults(), locked: false };
  }
  if (!raw || typeof raw !== "object") {
    return { snapshot: getDefaults(), locked: false };
  }
  // Future-version guard: refuse to overwrite a prefs file written by a newer version.
  const incomingVersion = typeof raw.version === "number" ? raw.version : 0;
  if (incomingVersion > CURRENT_VERSION) {
    console.warn(
      `Clawd: prefs file version ${incomingVersion} is newer than supported (${CURRENT_VERSION}). ` +
      `Settings will be readable but not saved to avoid data loss.`
    );
    return { snapshot: validate(raw), locked: true };
  }
  const migrated = migrate(raw);
  return { snapshot: validate(migrated), locked: false };
}

function save(prefsPath, snapshot) {
  const validated = validate(snapshot);
  // Ensure parent directory exists (Electron userData is normally created by the
  // framework, but we can't assume it for tests).
  try {
    fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  } catch {}
  fs.writeFileSync(prefsPath, JSON.stringify(validated, null, 2));
}

module.exports = {
  CURRENT_VERSION,
  SCHEMA,
  SCHEMA_KEYS,
  AGENT_FLAGS,
  getDefaults,
  validate,
  migrate,
  load,
  save,
};
