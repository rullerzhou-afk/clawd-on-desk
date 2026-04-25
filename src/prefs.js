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
const { isPlainObject } = require("./theme-loader");
const { normalizeShortcuts, getDefaultShortcuts } = require("./shortcut-actions");
const { isValidDisplaySnapshot } = require("./work-area");
const {
  NOTIFICATION_DEFAULT_SECONDS,
  UPDATE_DEFAULT_SECONDS,
  MAX_AUTO_CLOSE_SECONDS,
} = require("./bubble-policy");
const { normalizeSessionAliases } = require("./session-alias");

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
  positionThemeId: { type: "string", default: "" },
  positionVariantId: { type: "string", default: "" },
  // Snapshot of the display the pet sat on at save time. Used on next launch
  // to distinguish "monitor got unplugged" (saved position is now stranded on
  // a phantom screen) from "monitor still here" (saved position is still
  // safe, even if a generic clamp would nudge it). `null` when no snapshot
  // was captured (legacy prefs, headless CI, startup race).
  positionDisplay: {
    type: "object",
    defaultFactory: () => null,
    normalize: normalizePositionDisplay,
  },
  // Last realized pixel bounds. Used to restore proportional mode exactly
  // when keepSizeAcrossDisplays is enabled.
  savedPixelWidth: { type: "number", default: 0, validate: (v) => Number.isFinite(v) && v >= 0 },
  savedPixelHeight: { type: "number", default: 0, validate: (v) => Number.isFinite(v) && v >= 0 },
  size: {
    type: "string",
    default: "P:9",
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
  lang: { type: "string", default: "en", enum: ["en", "zh", "ko"] },
  showTray: { type: "boolean", default: true },
  showDock: { type: "boolean", default: true },
  manageClaudeHooksAutomatically: { type: "boolean", default: true },
  autoStartWithClaude: { type: "boolean", default: false },
  // System-backed: actual truth lives in OS login items / autostart files.
  // `openAtLoginHydrated` starts false; main.js's startup hydrate helper imports
  // the current system value into prefs on first run, then flips this flag.
  // Without hydration, an upgrading user with login-startup already enabled
  // would see prefs report `false` and have it written back to the system.
  openAtLogin: { type: "boolean", default: false },
  openAtLoginHydrated: { type: "boolean", default: false },
  bubbleFollowPet: { type: "boolean", default: false },
  sessionHudEnabled: { type: "boolean", default: true },
  hideBubbles: { type: "boolean", default: false },
  permissionBubblesEnabled: { type: "boolean", default: true },
  notificationBubbleAutoCloseSeconds: {
    type: "number",
    default: NOTIFICATION_DEFAULT_SECONDS,
    validate: (v) => Number.isInteger(v) && v >= 0 && v <= MAX_AUTO_CLOSE_SECONDS,
  },
  updateBubbleAutoCloseSeconds: {
    type: "number",
    default: UPDATE_DEFAULT_SECONDS,
    validate: (v) => Number.isInteger(v) && v >= 0 && v <= MAX_AUTO_CLOSE_SECONDS,
  },
  soundMuted: { type: "boolean", default: false },
  soundVolume: {
    type: "number",
    default: 1,
    validate: (v) => Number.isFinite(v) && v >= 0 && v <= 1,
  },
  lowPowerIdleMode: { type: "boolean", default: false },
  allowEdgePinning: { type: "boolean", default: false },
  // When true, moving the pet between displays does not trigger a
  // proportional pixel-size recomputation. The pet keeps its current
  // window size; the size slider still works (per-display proportional).
  keepSizeAcrossDisplays: { type: "boolean", default: false },
  shortcuts: {
    type: "object",
    defaultFactory: () => getDefaultShortcuts(),
    normalize: normalizeShortcuts,
  },
  // Theme
  theme: { type: "string", default: "clawd" },
  // Phase 2/3 placeholders — schema reserves the keys so future migrations don't need v2.
  agents: {
    type: "object",
    defaultFactory: () => ({
      "claude-code": { enabled: true, permissionsEnabled: true, notificationHookEnabled: true },
      "codex": { enabled: true, permissionsEnabled: true, notificationHookEnabled: true },
      "copilot-cli": { enabled: true, permissionsEnabled: true, notificationHookEnabled: true },
      "cursor-agent": { enabled: true, permissionsEnabled: true, notificationHookEnabled: true },
      "gemini-cli": { enabled: true, permissionsEnabled: true, notificationHookEnabled: true },
      "codebuddy": { enabled: true, permissionsEnabled: true, notificationHookEnabled: true },
      "kiro-cli": { enabled: true, permissionsEnabled: true, notificationHookEnabled: true },
      "opencode": { enabled: true, permissionsEnabled: true, notificationHookEnabled: true },
    }),
    normalize: normalizeAgents,
  },
  themeOverrides: {
    type: "object",
    defaultFactory: () => ({}),
    normalize: normalizeThemeOverrides,
  },
  // Phase 3b-swap: per-theme variant selection (e.g. {clawd: "chill", calico: "default"}).
  // Missing key for a theme = use that theme's `default` variant. Unknown variantIds
  // get lenient-fallback to default at load time (see theme-loader._resolveVariant).
  themeVariant: {
    type: "object",
    defaultFactory: () => ({}),
    normalize: normalizeThemeVariant,
  },
  sessionAliases: {
    type: "object",
    defaultFactory: () => ({}),
    normalize: normalizeSessionAliases,
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
  // Backfill the split bubble settings from the old aggregate switch. This is
  // intentionally field-level so users who already have the new keys keep them.
  if (typeof out.hideBubbles === "boolean") {
    if (out.permissionBubblesEnabled === undefined) {
      out.permissionBubblesEnabled = !out.hideBubbles;
    }
    if (out.notificationBubbleAutoCloseSeconds === undefined) {
      out.notificationBubbleAutoCloseSeconds = out.hideBubbles ? 0 : NOTIFICATION_DEFAULT_SECONDS;
    }
    if (out.updateBubbleAutoCloseSeconds === undefined) {
      out.updateBubbleAutoCloseSeconds = out.hideBubbles ? 0 : UPDATE_DEFAULT_SECONDS;
    }
  }
  // Future migrations slot in here as `if (out.version < N) { ... out.version = N }`.
  return out;
}

const AGENT_FLAGS = ["enabled", "permissionsEnabled", "notificationHookEnabled"];

function normalizePositionDisplay(value) {
  if (!isValidDisplaySnapshot(value)) return null;
  const b = value.bounds;
  const out = {
    bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
  };
  const wa = value.workArea;
  if (wa && typeof wa === "object"
    && Number.isFinite(wa.x) && Number.isFinite(wa.y)
    && Number.isFinite(wa.width) && Number.isFinite(wa.height)) {
    out.workArea = { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
  }
  if (typeof value.id === "number" && Number.isFinite(value.id)) out.id = value.id;
  if (typeof value.scaleFactor === "number" && Number.isFinite(value.scaleFactor)) {
    out.scaleFactor = value.scaleFactor;
  }
  return out;
}

function normalizeAgents(value, defaultsValue) {
  if (!value || typeof value !== "object") return defaultsValue;
  const out = { ...defaultsValue };
  for (const id of Object.keys(value)) {
    const entry = value[id];
    if (!entry || typeof entry !== "object") continue;
    const base = (defaultsValue && defaultsValue[id])
      || { enabled: true, permissionsEnabled: true, notificationHookEnabled: true };
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

function normalizeTransitionOverride(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  if (typeof value.in === "number" && Number.isFinite(value.in)) out.in = value.in;
  if (typeof value.out === "number" && Number.isFinite(value.out)) out.out = value.out;
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeSlotOverride(entry, { allowDisabled = true } = {}) {
  if (!isPlainObject(entry)) return null;
  const out = {};
  if (allowDisabled && entry.disabled === true) out.disabled = true;
  if (typeof entry.file === "string" && entry.file) out.file = entry.file;
  if (typeof entry.sourceThemeId === "string" && entry.sourceThemeId) out.sourceThemeId = entry.sourceThemeId;
  if (typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs)) out.durationMs = entry.durationMs;
  const transition = normalizeTransitionOverride(entry.transition);
  if (transition) out.transition = transition;
  return Object.keys(out).length > 0 ? out : null;
}

const REACTION_KEYS = new Set(["drag", "clickLeft", "clickRight", "annoyed", "double"]);

// Per-file hitbox override: { file.svg: boolean }.
// true  = force the file INTO the wide-hitbox set (even if the theme author didn't list it)
// false = force the file OUT of the wide-hitbox set (even if the theme author did list it)
// absent = follow whatever the theme declares
function normalizeHitboxOverrides(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  if (isPlainObject(value.wide)) {
    const wide = {};
    for (const [file, enabled] of Object.entries(value.wide)) {
      if (typeof file !== "string" || !file) continue;
      if (typeof enabled !== "boolean") continue;
      wide[file] = enabled;
    }
    if (Object.keys(wide).length > 0) out.wide = wide;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeReactionOverridesMap(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  for (const [reactionKey, entry] of Object.entries(value)) {
    if (!REACTION_KEYS.has(reactionKey)) continue;
    const cleanEntry = normalizeSlotOverride(entry, { allowDisabled: false });
    if (!cleanEntry) continue;
    // drag has no duration semantically (it plays until pointer-up), so strip
    // any durationMs written by a wayward import.
    if (reactionKey === "drag" && Object.prototype.hasOwnProperty.call(cleanEntry, "durationMs")) {
      delete cleanEntry.durationMs;
    }
    if (Object.keys(cleanEntry).length > 0) out[reactionKey] = cleanEntry;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeStateOverridesMap(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  for (const [stateKey, entry] of Object.entries(value)) {
    if (typeof stateKey !== "string" || !stateKey) continue;
    const cleanEntry = normalizeSlotOverride(entry, { allowDisabled: true });
    if (cleanEntry) out[stateKey] = cleanEntry;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Sound overrides are per-sound-name (complete / confirm / theme-author-defined).
// Structurally simpler than state overrides: only `file` matters (no transition,
// duration, disabled, or sourceThemeId). We reuse normalizeSlotOverride to
// strip the animation-only fields, then enforce path-segment safety on both
// the key (used as filename stem when copying) and the file (joined into the
// overrides dir at load time) — defence in depth against malicious themes or
// hand-edited pref files.
// Strips any path segments and rejects traversal-only names. Returns null if
// the result isn't a usable basename, otherwise the (optionally capped) name.
function _safeBasename(raw, { maxLen } = {}) {
  if (typeof raw !== "string" || !raw) return null;
  let name = raw.replace(/^.*[\/\\]/, "");
  if (maxLen && name.length > maxLen) name = name.slice(0, maxLen);
  if (!name || name === "." || name === "..") return null;
  return name;
}

function normalizeSoundOverridesMap(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  for (const [soundName, entry] of Object.entries(value)) {
    if (typeof soundName !== "string" || !soundName) continue;
    if (!/^[a-zA-Z0-9_-]+$/.test(soundName)) continue;
    const cleanEntry = normalizeSlotOverride(entry, { allowDisabled: false });
    if (!cleanEntry) continue;
    const safeFile = _safeBasename(cleanEntry.file);
    if (!safeFile) continue;
    const soundEntry = { file: safeFile };
    // Preserves the user-picked filename; on-disk dest is renamed to
    // `${soundName}${ext}`, so without this a same-ext replacement would
    // render identically to the theme default in the UI.
    if (isPlainObject(entry)) {
      const safeOriginal = _safeBasename(entry.originalName, { maxLen: 256 });
      if (safeOriginal) soundEntry.originalName = safeOriginal;
    }
    out[soundName] = soundEntry;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeFileKeyedOverrideMap(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  for (const [originalFile, entry] of Object.entries(value)) {
    if (typeof originalFile !== "string" || !originalFile) continue;
    const cleanEntry = normalizeSlotOverride(entry, { allowDisabled: false });
    if (cleanEntry) out[originalFile] = cleanEntry;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeAutoReturnOverrides(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  for (const [stateKey, duration] of Object.entries(value)) {
    if (typeof stateKey !== "string" || !stateKey) continue;
    if (typeof duration !== "number" || !Number.isFinite(duration)) continue;
    out[stateKey] = duration;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeThemeOverrides(value, defaultsValue) {
  if (!isPlainObject(value)) return defaultsValue;
  const out = {};
  for (const themeId of Object.keys(value)) {
    const themeMap = value[themeId];
    if (!isPlainObject(themeMap)) continue;
    const cleanThemeMap = {};

    // Back-compat: older prefs wrote state entries directly under themeId.
    const legacyStates = {};
    for (const [key, entry] of Object.entries(themeMap)) {
      if (key === "states" || key === "tiers" || key === "timings" || key === "idleAnimations" || key === "reactions" || key === "hitbox" || key === "sounds") continue;
      const cleanEntry = normalizeSlotOverride(entry, { allowDisabled: true });
      if (cleanEntry) legacyStates[key] = cleanEntry;
    }

    const explicitStates = normalizeStateOverridesMap(themeMap.states);
    const states = explicitStates ? { ...legacyStates, ...explicitStates } : legacyStates;
    if (Object.keys(states).length > 0) cleanThemeMap.states = states;

    const tierGroups = isPlainObject(themeMap.tiers) ? themeMap.tiers : null;
    const cleanTiers = {};
    if (tierGroups) {
      const working = normalizeFileKeyedOverrideMap(tierGroups.workingTiers);
      const juggling = normalizeFileKeyedOverrideMap(tierGroups.jugglingTiers);
      if (working) cleanTiers.workingTiers = working;
      if (juggling) cleanTiers.jugglingTiers = juggling;
    }
    if (Object.keys(cleanTiers).length > 0) cleanThemeMap.tiers = cleanTiers;

    const timings = isPlainObject(themeMap.timings) ? themeMap.timings : null;
    if (timings) {
      const cleanAutoReturn = normalizeAutoReturnOverrides(timings.autoReturn);
      if (cleanAutoReturn) {
        cleanThemeMap.timings = { autoReturn: cleanAutoReturn };
      }
    }

    const idleAnimations = normalizeFileKeyedOverrideMap(themeMap.idleAnimations);
    if (idleAnimations) cleanThemeMap.idleAnimations = idleAnimations;

    const reactions = normalizeReactionOverridesMap(themeMap.reactions);
    if (reactions) cleanThemeMap.reactions = reactions;

    const hitbox = normalizeHitboxOverrides(themeMap.hitbox);
    if (hitbox) cleanThemeMap.hitbox = hitbox;

    const sounds = normalizeSoundOverridesMap(themeMap.sounds);
    if (sounds) cleanThemeMap.sounds = sounds;

    if (Object.keys(cleanThemeMap).length > 0) {
      out[themeId] = cleanThemeMap;
    }
  }
  return out;
}

function normalizeThemeVariant(value, defaultsValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultsValue;
  const out = {};
  for (const themeId of Object.keys(value)) {
    const variantId = value[themeId];
    if (typeof themeId !== "string" || !themeId) continue;
    if (typeof variantId !== "string" || !variantId) continue;
    out[themeId] = variantId;
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
  normalizeThemeOverrides,
  normalizeShortcuts,
};
