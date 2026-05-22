"use strict";

// ── Settings actions (transport-agnostic) ──
//
// Two registries:
//
//   updateRegistry  — single-field updates. Each entry is EITHER:
//
//     (a) a plain function `(value, deps) => { status, message? }` —
//         a PURE VALIDATOR with no side effect. Used for fields whose
//         truth lives entirely inside prefs (lang, soundMuted, ...).
//         Reactive UI projection lives in main.js subscribers.
//
//     (b) an object `{ validate, effect }` — a PRE-COMMIT GATE for
//         fields whose truth depends on the OUTSIDE WORLD (the OS login
//         items database, ~/.claude/settings.json, etc.). The effect
//         actually performs the system call; if it fails, the controller
//         does NOT commit, so prefs cannot drift away from system reality.
//         Effects can be sync or async; effects throw → controller wraps
//         as { status: 'error' }.
//
//     Why both forms coexist: the gate-vs-projection split is real (see
//     plan-settings-panel.md §4.2). Forcing every entry to be a gate
//     would create empty effect functions for pure-data fields and blur
//     the contract. Forcing every effect into a subscriber would make
//     "save the system call's failure" impossible because subscribers
//     run AFTER commit and can't unwind it.
//
//   commandRegistry — non-field actions like `removeTheme`, `installHooks`,
//                     `registerShortcut`. These return
//                     `{ status, message?, commit? }`. If `commit` is present,
//                     the controller calls `_commit(commit)` after success so
//                     commands can update store fields atomically with their
//                     side effects.
//
// This module imports nothing from electron, the store, or the controller.
// All deps that an action needs are passed via the second argument:
//
//   actionFn(value, { snapshot, ...injectedDeps })
//
// `injectedDeps` is whatever main.js passed to `createSettingsController`. For
// effect-bearing entries this MUST include the system helpers the effect
// needs (e.g. `setLoginItem`, `registerHooks`) — actions never `require()`
// electron or fs directly so the test suite can inject mocks.
//
// HYDRATE PATH: `controller.hydrate(partial)` runs only the validator and
// SKIPS the effect. This is how startup imports system-backed values into
// prefs without writing them right back. Object-form entries must therefore
// keep validate side-effect-free.

const { CURRENT_VERSION } = require("./prefs");
const { isValidDisplaySnapshot } = require("./work-area");
const {
  MAX_AUTO_CLOSE_SECONDS,
  buildAggregateHideCommit,
  buildCategoryEnabledCommit,
} = require("./bubble-policy");
const {
  normalizeSessionAliases,
  pruneExpiredSessionAliases,
  sanitizeSessionAlias,
  sessionAliasKey,
} = require("./session-alias");
const { validateShortcutMapShape } = require("./shortcut-actions");
const {
  requireBoolean,
  requireFiniteNumber,
  requireNonNegativeFiniteNumber,
  requireNumberInRange,
  requireIntegerInRange,
  requireEnum,
  requireString,
  requirePlainObject,
} = require("./settings-validators");
const {
  registerShortcut,
  resetShortcut,
  resetAllShortcuts,
} = require("./settings-actions-shortcuts");
const {
  setAgentFlag,
  setAgentPermissionMode,
  repairAgentIntegration,
} = require("./settings-actions-agents");
const {
  ANIMATION_OVERRIDES_EXPORT_VERSION,
  ONESHOT_OVERRIDE_STATES,
  importAnimationOverrides,
  resetThemeOverrides,
  setAnimationOverride,
  setSoundOverride,
  setThemeOverrideDisabled,
  setWideHitboxOverride,
} = require("./settings-actions-theme-overrides");
const {
  autoStartWithClaude,
  createRepairDoctorIssue,
  installHooks,
  manageClaudeHooksAutomatically,
  openAtLogin,
  repairLocalServer,
  uninstallHooks,
} = require("./settings-actions-system");
const {
  validateProfile: validateRemoteSshProfile,
  sanitizeProfile: sanitizeRemoteSshProfile,
  isValidDetectedRemoteNodeBin,
  isValidDetectedRemoteNodeVersion,
  isValidDetectedRemoteNodeSource,
  deployTargetFingerprint,
  deployTargetDrift,
} = require("./remote-ssh-profile");
const {
  validateTelegramApproval,
  validateTelegramBotToken,
} = require("./telegram-approval-settings");
const {
  validateHardwareBuddySettings,
} = require("./hardware-buddy-settings");

// ── updateRegistry ──
// Maps prefs field name → validator. Controller looks up by key and runs.

const updateRegistry = {
  // ── Window state ──
  x: requireFiniteNumber("x"),
  y: requireFiniteNumber("y"),
  size(value) {
    if (typeof value !== "string") {
      return { status: "error", message: "size must be a string" };
    }
    if (value === "S" || value === "M" || value === "L") return { status: "ok" };
    if (/^P:\d+(?:\.\d+)?$/.test(value)) return { status: "ok" };
    return {
      status: "error",
      message: `size must be S/M/L or P:<num>, got: ${value}`,
    };
  },

  // ── Mini mode persisted state ──
  miniMode: requireBoolean("miniMode"),
  miniEdge: requireEnum("miniEdge", ["left", "right"]),
  preMiniX: requireFiniteNumber("preMiniX"),
  preMiniY: requireFiniteNumber("preMiniY"),
  positionSaved: requireBoolean("positionSaved"),
  positionThemeId: requireString("positionThemeId", { allowEmpty: true }),
  positionVariantId: requireString("positionVariantId", { allowEmpty: true }),
  // Written only by flushRuntimeStateToPrefs() with a snapshot Electron just
  // handed us; null marks "no snapshot yet" (legacy prefs, headless CI, the
  // rare startup race where screen.* is still coming up).
  positionDisplay: (value) => {
    if (value === null || isValidDisplaySnapshot(value)) return { status: "ok" };
    return { status: "error", message: "positionDisplay must be null or a valid display snapshot" };
  },
  savedPixelWidth: requireNonNegativeFiniteNumber("savedPixelWidth"),
  savedPixelHeight: requireNonNegativeFiniteNumber("savedPixelHeight"),

  // ── Pure data prefs (function-form: validator only) ──
  lang: requireEnum("lang", ["en", "zh", "zh-TW", "ko", "ja"]),
  soundMuted: requireBoolean("soundMuted"),
  soundVolume: requireNumberInRange("soundVolume", 0, 1),
  lowPowerIdleMode: requireBoolean("lowPowerIdleMode"),
  bubbleFollowPet: requireBoolean("bubbleFollowPet"),
  sessionHudEnabled: requireBoolean("sessionHudEnabled"),
  sessionHudShowStateLabels: requireBoolean("sessionHudShowStateLabels"),
  sessionHudShowElapsed: requireBoolean("sessionHudShowElapsed"),
  sessionHudCleanupDetached: requireBoolean("sessionHudCleanupDetached"),
  sessionHudAutoHide: requireBoolean("sessionHudAutoHide"),
  sessionHudPinned: requireBoolean("sessionHudPinned"),
  hideBubbles: requireBoolean("hideBubbles"),
  permissionBubblesEnabled: requireBoolean("permissionBubblesEnabled"),
  notificationBubbleAutoCloseSeconds: requireIntegerInRange(
    "notificationBubbleAutoCloseSeconds",
    0,
    MAX_AUTO_CLOSE_SECONDS
  ),
  permissionBubbleAutoCloseSeconds: requireIntegerInRange(
    "permissionBubbleAutoCloseSeconds",
    0,
    MAX_AUTO_CLOSE_SECONDS
  ),
  updateBubbleAutoCloseSeconds: requireIntegerInRange(
    "updateBubbleAutoCloseSeconds",
    0,
    MAX_AUTO_CLOSE_SECONDS
  ),
  // Session stale-cleanup intervals. Cross-field invariant
  // (sessionStaleMs > 0 -> workingStaleMs <= sessionStaleMs) is enforced
  // here against the live snapshot AND atomically through the
  // `sessionCleanup.setTriple` command below. Hand-edit fallback lives in
  // prefs.normalizeStaleTriple.
  sessionStaleMs(value, deps = {}) {
    if (value === 0) return { status: "ok" };
    const base = requireIntegerInRange("sessionStaleMs", 60_000, 86_400_000)(value);
    if (base.status !== "ok") return base;
    const snapshot = (deps && deps.snapshot) || {};
    const currentWorking = Number(snapshot.workingStaleMs);
    if (Number.isFinite(currentWorking) && currentWorking > value) {
      return {
        status: "error",
        message:
          `sessionStaleMs (${value}) must be >= workingStaleMs (${currentWorking}). ` +
          "To lower both, use the Reset / paired control.",
      };
    }
    return { status: "ok" };
  },
  workingStaleMs(value, deps = {}) {
    const base = requireIntegerInRange("workingStaleMs", 30_000, 86_400_000)(value);
    if (base.status !== "ok") return base;
    const snapshot = (deps && deps.snapshot) || {};
    const currentSession = Number(snapshot.sessionStaleMs);
    if (Number.isFinite(currentSession) && currentSession > 0 && value > currentSession) {
      return {
        status: "error",
        message: `workingStaleMs (${value}) must be <= sessionStaleMs (${currentSession}).`,
      };
    }
    return { status: "ok" };
  },
  detachedIdleStaleMs: requireIntegerInRange("detachedIdleStaleMs", 5_000, 300_000),
  allowEdgePinning: requireBoolean("allowEdgePinning"),
  keepSizeAcrossDisplays: requireBoolean("keepSizeAcrossDisplays"),

  // ── System-backed prefs (object-form: validate + effect pre-commit gate) ──
  autoStartWithClaude,
  manageClaudeHooksAutomatically,
  openAtLogin,

  // openAtLoginHydrated is set exactly once by hydrateSystemBackedSettings()
  //   on first run after the openAtLogin field is added. Pure validator —
  //   no effect. After hydration prefs becomes the source of truth and the
  //   user-visible toggle goes through the openAtLogin gate above.
  openAtLoginHydrated: requireBoolean("openAtLoginHydrated"),

  // ── macOS visibility (cross-field validation) ──
  showTray(value, { snapshot }) {
    if (typeof value !== "boolean") {
      return { status: "error", message: "showTray must be a boolean" };
    }
    if (!value && snapshot && snapshot.showDock === false) {
      return {
        status: "error",
        message: "Cannot hide Menu Bar while Dock is also hidden — Clawd would become unquittable.",
      };
    }
    return { status: "ok" };
  },
  showDock(value, { snapshot }) {
    if (typeof value !== "boolean") {
      return { status: "error", message: "showDock must be a boolean" };
    }
    if (!value && snapshot && snapshot.showTray === false) {
      return {
        status: "error",
        message: "Cannot hide Dock while Menu Bar is also hidden — Clawd would become unquittable.",
      };
    }
    return { status: "ok" };
  },

  // Strict activation gate. Startup uses the lenient path + hydrate() so
  // a deleted theme can't brick boot without polluting this effect.
  theme: {
    validate: requireString("theme"),
    effect(value, deps) {
      if (!deps || typeof deps.activateTheme !== "function") {
        return {
          status: "error",
          message: "theme effect requires activateTheme dep",
        };
      }
      try {
        const snapshot = (deps && deps.snapshot) || {};
        const currentOverrides = snapshot.themeOverrides || {};
        deps.activateTheme(value, null, currentOverrides[value] || null);
        return { status: "ok" };
      } catch (err) {
        return {
          status: "error",
          message: `theme: ${err && err.message}`,
        };
      }
    },
  },

  // ── Phase 2/3 placeholders — schema reserves these so applyUpdate accepts them ──
  agents: requirePlainObject("agents"),
  themeOverrides: requirePlainObject("themeOverrides"),
  sessionAliases(value, deps = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { status: "error", message: "sessionAliases must be a plain object" };
    }
    const normalized = normalizeSessionAliases(value, { now: deps.now });
    if (Object.keys(normalized).length !== Object.keys(value).length) {
      return { status: "error", message: "sessionAliases must contain valid alias entries" };
    }
    return { status: "ok" };
  },

  // Phase 3b-swap: per-theme variant selection. NO effect — the runtime switch
  // runs through the `setThemeSelection` command which atomically commits
  // `theme` + `themeVariant` after calling activateTheme(themeId, variantId).
  // Letting this field have an effect would double-activate when the UI
  // updates `theme` and `themeVariant` separately.
  themeVariant: requirePlainObject("themeVariant"),

  // Remote SSH profile store. Plain validator — actual CRUD goes through
  // commandRegistry below to keep id-uniqueness, default-fill, and
  // monotonic createdAt logic in one place. The validator only ensures the
  // top-level shape is sane so direct hydrate paths can't write garbage.
  remoteSsh(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { status: "error", message: "remoteSsh must be a plain object" };
    }
    if (!Array.isArray(value.profiles)) {
      return { status: "error", message: "remoteSsh.profiles must be an array" };
    }
    for (let i = 0; i < value.profiles.length; i++) {
      const r = validateRemoteSshProfile(value.profiles[i]);
      if (r.status !== "ok") {
        return { status: "error", message: `remoteSsh.profiles[${i}]: ${r.message}` };
      }
    }
    return { status: "ok" };
  },
  tgApproval(value) {
    return validateTelegramApproval(value);
  },

  hardwareBuddy(value) {
    return validateHardwareBuddySettings(value);
  },

  shortcuts: {
    validate(value) {
      return validateShortcutMapShape(value);
    },
  },

  // ── Internal — version is owned by prefs.js / migrate(), shouldn't normally
  //    be set via applyUpdate, but we accept it so programmatic upgrades work. ──
  version(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
      return { status: "error", message: "version must be a positive number" };
    }
    if (value > CURRENT_VERSION) {
      return {
        status: "error",
        message: `version ${value} is newer than supported (${CURRENT_VERSION})`,
      };
    }
    return { status: "ok" };
  },
};

// ── commandRegistry ──
// Non-field actions. Phase 0 has only stubs — they'll be filled in by later phases.

function notImplemented(name) {
  return function () {
    return {
      status: "error",
      message: `${name}: not implemented yet (Phase 0 stub)`,
    };
  };
}

function setAllBubblesHidden(payload, deps) {
  const hidden = typeof payload === "boolean" ? payload : payload && payload.hidden;
  if (typeof hidden !== "boolean") {
    return { status: "error", message: "setAllBubblesHidden.hidden must be a boolean" };
  }
  return { status: "ok", commit: buildAggregateHideCommit(hidden, deps && deps.snapshot) };
}

function setBubbleCategoryEnabled(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "setBubbleCategoryEnabled: payload must be an object" };
  }
  const { category, enabled } = payload;
  const result = buildCategoryEnabledCommit((deps && deps.snapshot) || {}, category, enabled);
  if (result.error) return { status: "error", message: result.error };
  return { status: "ok", commit: result.commit };
}

// Atomic three-key writer for the session-cleanup intervals. Lives as a
// command (not as `applyBulk`) because applyBulk runs each single-key
// validator against the PRE-bulk snapshot, which would reject a Reset that
// lowers both knobs simultaneously. The controller's command path re-runs
// validators against the merged snapshot, so the cross-field invariant is
// checked against the values being written together rather than mixed
// with the current state.
function setSessionCleanupTriple(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "sessionCleanup.setTriple: payload must be an object" };
  }
  const snapshot = (deps && deps.snapshot) || {};

  // Strict presence check: a present-but-wrong-type value is a programmer
  // error and must surface, not silently fall back to the snapshot.
  function pick(key) {
    if (key in payload) {
      const v = payload[key];
      if (!Number.isInteger(v)) {
        return { error: `${key} must be an integer (received ${typeof v})` };
      }
      return { value: v };
    }
    const fallback = Number(snapshot[key]);
    if (!Number.isFinite(fallback)) {
      return { error: `${key} missing from payload and not present in snapshot` };
    }
    return { value: fallback };
  }

  const s = pick("sessionStaleMs");
  if (s.error) return { status: "error", message: s.error };
  const w = pick("workingStaleMs");
  if (w.error) return { status: "error", message: w.error };
  const d = pick("detachedIdleStaleMs");
  if (d.error) return { status: "error", message: d.error };

  const sessionStaleMs = s.value;
  const workingStaleMs = w.value;
  const detachedIdleStaleMs = d.value;

  if (!(sessionStaleMs === 0 || (sessionStaleMs >= 60_000 && sessionStaleMs <= 86_400_000))) {
    return { status: "error", message: `sessionStaleMs out of range: ${sessionStaleMs}` };
  }
  if (!(workingStaleMs >= 30_000 && workingStaleMs <= 86_400_000)) {
    return { status: "error", message: `workingStaleMs out of range: ${workingStaleMs}` };
  }
  if (!(detachedIdleStaleMs >= 5_000 && detachedIdleStaleMs <= 300_000)) {
    return { status: "error", message: `detachedIdleStaleMs out of range: ${detachedIdleStaleMs}` };
  }

  if (sessionStaleMs > 0 && workingStaleMs > sessionStaleMs) {
    return {
      status: "error",
      message: `workingStaleMs (${workingStaleMs}) must be <= sessionStaleMs (${sessionStaleMs}).`,
    };
  }

  return {
    status: "ok",
    commit: { sessionStaleMs, workingStaleMs, detachedIdleStaleMs },
  };
}

function sessionAliasMapEqual(a, b) {
  const aKeys = Object.keys(a || {});
  const bKeys = Object.keys(b || {});
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const av = a[key];
    const bv = b[key];
    if (!bv || av.title !== bv.title || av.updatedAt !== bv.updatedAt) return false;
  }
  return true;
}

function getCommandNow(deps) {
  const now = deps && typeof deps.now === "function" ? deps.now() : deps && deps.now;
  return Number.isFinite(Number(now)) && Number(now) > 0 ? Number(now) : Date.now();
}

function getActiveSessionAliasKeys(deps) {
  if (!deps || typeof deps.getActiveSessionAliasKeys !== "function") return new Set();
  try {
    const keys = deps.getActiveSessionAliasKeys();
    if (keys instanceof Set) return keys;
    if (Array.isArray(keys)) return new Set(keys);
    if (keys && typeof keys[Symbol.iterator] === "function") return new Set(keys);
  } catch {}
  return new Set();
}

function setSessionAlias(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "setSessionAlias: payload must be an object" };
  }
  const { host, agentId, sessionId, cwd, alias } = payload;
  const key = sessionAliasKey(host, agentId, sessionId, { cwd });
  if (!key) {
    return { status: "error", message: "setSessionAlias.sessionId must be a non-empty string" };
  }
  const cleanAlias = sanitizeSessionAlias(alias);
  if (cleanAlias === null) {
    return { status: "error", message: "setSessionAlias.alias must be a string" };
  }

  const now = getCommandNow(deps);
  const snapshot = (deps && deps.snapshot) || {};
  const currentAliases = normalizeSessionAliases(snapshot.sessionAliases || {}, { now });
  const nextAliases = { ...currentAliases };
  if (cleanAlias) {
    const existing = currentAliases[key];
    if (!existing || existing.title !== cleanAlias) {
      nextAliases[key] = { title: cleanAlias, updatedAt: now };
    }
  }
  else delete nextAliases[key];

  const prunedAliases = pruneExpiredSessionAliases(nextAliases, {
    now,
    activeKeys: getActiveSessionAliasKeys(deps),
  });

  if (sessionAliasMapEqual(prunedAliases, currentAliases)) {
    return { status: "ok", noop: true };
  }
  return { status: "ok", commit: { sessionAliases: prunedAliases } };
}

const _validateRemoveThemeId = requireString("removeTheme.themeId");
async function removeTheme(payload, deps) {
  const themeId = typeof payload === "string" ? payload : (payload && payload.themeId);
  const idCheck = _validateRemoveThemeId(themeId);
  if (idCheck.status !== "ok") return idCheck;

  if (!deps || typeof deps.getThemeInfo !== "function" || typeof deps.removeThemeDir !== "function") {
    return {
      status: "error",
      message: "removeTheme effect requires getThemeInfo and removeThemeDir deps",
    };
  }

  let info;
  try {
    info = deps.getThemeInfo(themeId);
  } catch (err) {
    return { status: "error", message: `removeTheme: ${err && err.message}` };
  }
  if (!info) {
    return { status: "error", message: `removeTheme: theme "${themeId}" not found` };
  }
  if (info.builtin) {
    return { status: "error", message: `removeTheme: cannot delete built-in theme "${themeId}"` };
  }
  if (info.active) {
    return {
      status: "error",
      message: `removeTheme: cannot delete active theme "${themeId}" — switch to another theme first`,
    };
  }
  if (info.managedCodexPet) {
    return {
      status: "error",
      message: `removeTheme: cannot delete managed Codex Pet theme "${themeId}" — remove it from Petdex instead`,
    };
  }

  try {
    await deps.removeThemeDir(themeId);
  } catch (err) {
    return { status: "error", message: `removeTheme: ${err && err.message}` };
  }

  const snapshot = deps.snapshot || {};
  const currentOverrides = snapshot.themeOverrides || {};
  const currentVariantMap = snapshot.themeVariant || {};
  const nextCommit = {};
  if (currentOverrides[themeId]) {
    const nextOverrides = { ...currentOverrides };
    delete nextOverrides[themeId];
    nextCommit.themeOverrides = nextOverrides;
  }
  if (currentVariantMap[themeId] !== undefined) {
    const nextVariantMap = { ...currentVariantMap };
    delete nextVariantMap[themeId];
    nextCommit.themeVariant = nextVariantMap;
  }
  if (Object.keys(nextCommit).length > 0) {
    return { status: "ok", commit: nextCommit };
  }
  return { status: "ok" };
}

// Phase 3b-swap: atomic theme + variant switch.
//   payload: { themeId: string, variantId?: string }
// Why a dedicated command vs. letting the `theme` field effect handle it:
// the theme effect only commits `{theme}`, so the dirty "author deleted the
// variant user had selected" scenario leaves `themeVariant[themeId]` pointing
// at a dead variantId. Fix: call activateTheme which lenient-fallbacks unknown
// variants, read back the actually-resolved variantId, and commit both fields.
// See docs/plans/plan-settings-panel-3b-swap.md §6.2 "Runtime 切换路径".
const _validateSetThemeSelectionThemeId = requireString("setThemeSelection.themeId");
function setThemeSelection(payload, deps) {
  const themeId = typeof payload === "string" ? payload : (payload && payload.themeId);
  const variantIdInput = (payload && typeof payload === "object") ? payload.variantId : null;
  const idCheck = _validateSetThemeSelectionThemeId(themeId);
  if (idCheck.status !== "ok") return idCheck;
  if (variantIdInput != null && (typeof variantIdInput !== "string" || !variantIdInput)) {
    return { status: "error", message: "setThemeSelection.variantId must be a non-empty string when provided" };
  }

  if (!deps || typeof deps.activateTheme !== "function") {
    return { status: "error", message: "setThemeSelection effect requires activateTheme dep" };
  }

  const snapshot = deps.snapshot || {};
  const currentVariantMap = snapshot.themeVariant || {};
  const currentOverrides = snapshot.themeOverrides || {};
  const targetVariant = variantIdInput || currentVariantMap[themeId] || "default";
  const targetOverrideMap = currentOverrides[themeId] || null;

  let resolved;
  try {
    resolved = deps.activateTheme(themeId, targetVariant, targetOverrideMap);
  } catch (err) {
    return { status: "error", message: `setThemeSelection: ${err && err.message}` };
  }
  // activateTheme returns { themeId, variantId } — the variantId here reflects
  // lenient fallback (dead variant → "default"). We commit the resolved value
  // so prefs self-heal away from stale ids.
  const resolvedVariant = (resolved && typeof resolved === "object" && typeof resolved.variantId === "string")
    ? resolved.variantId
    : targetVariant;

  const nextVariantMap = { ...currentVariantMap, [themeId]: resolvedVariant };
  return {
    status: "ok",
    commit: { theme: themeId, themeVariant: nextVariantMap },
  };
}

function resizePet(payload, deps) {
  // Settings panel slider entry point. Routes to menu.resizeWindow via
  // deps.resizePet so it picks up the full side-effect chain (actual window
  // resize, hitWin sync, bubble reposition, runtime flush) that a raw
  // applyUpdate("size", ...) would miss. menu.resizeWindow itself writes
  // prefs.size through the controller, so this command returns no commit.
  if (typeof payload !== "string" || !/^P:\d+(?:\.\d+)?$/.test(payload)) {
    return { status: "error", message: `resizePet: invalid size "${payload}"` };
  }
  if (!deps || typeof deps.resizePet !== "function") {
    return { status: "error", message: "resizePet requires deps.resizePet" };
  }
  try {
    deps.resizePet(payload);
    return { status: "ok" };
  } catch (err) {
    return { status: "error", message: `resizePet: ${err && err.message}` };
  }
}

// ── Remote SSH profile commands ──
//
// Three commands route through the controller so the IPC layer never writes
// prefs directly. Each returns `{ status, commit }` so the controller can
// atomically validate + write the new `remoteSsh` field.
//
// id semantics: `add` requires the caller to supply an id (the renderer
// generates a uuid). This keeps the renderer in charge of the id it'll later
// reference for connect/disconnect, avoiding a roundtrip race.

function _remoteSshSnapshot(deps) {
  const snap = (deps && deps.snapshot) || {};
  const cur = snap.remoteSsh && typeof snap.remoteSsh === "object" ? snap.remoteSsh : {};
  const profiles = Array.isArray(cur.profiles) ? cur.profiles.slice() : [];
  return { profiles };
}

function normalizeRemoteNodeDetection(input, detectedAtFallback = Date.now()) {
  if (!input || typeof input !== "object") return null;
  const nodeBin = input.nodeBin || input.detectedRemoteNodeBin;
  if (!isValidDetectedRemoteNodeBin(nodeBin)) return null;

  const out = {
    detectedRemoteNodeBin: nodeBin,
  };
  const version = input.version || input.detectedRemoteNodeVersion;
  if (isValidDetectedRemoteNodeVersion(version)) {
    out.detectedRemoteNodeVersion = version;
  }
  const source = input.source || input.detectedRemoteNodeSource;
  if (isValidDetectedRemoteNodeSource(source)) {
    out.detectedRemoteNodeSource = source;
  }
  const detectedAt = Number.isFinite(input.detectedAt)
    ? input.detectedAt
    : (Number.isFinite(input.detectedRemoteNodeAt) ? input.detectedRemoteNodeAt : detectedAtFallback);
  if (Number.isFinite(detectedAt) && detectedAt > 0) {
    out.detectedRemoteNodeAt = detectedAt;
  }
  return out;
}

function copyRemoteNodeDetection(target, source) {
  if (!target || !source || !isValidDetectedRemoteNodeBin(source.detectedRemoteNodeBin)) return;
  target.detectedRemoteNodeBin = source.detectedRemoteNodeBin;
  if (isValidDetectedRemoteNodeVersion(source.detectedRemoteNodeVersion)) {
    target.detectedRemoteNodeVersion = source.detectedRemoteNodeVersion;
  }
  if (isValidDetectedRemoteNodeSource(source.detectedRemoteNodeSource)) {
    target.detectedRemoteNodeSource = source.detectedRemoteNodeSource;
  }
  if (Number.isFinite(source.detectedRemoteNodeAt) && source.detectedRemoteNodeAt > 0) {
    target.detectedRemoteNodeAt = source.detectedRemoteNodeAt;
  }
}

function remoteSshAddProfile(payload, deps) {
  const profile = sanitizeRemoteSshProfile(payload);
  if (!profile) {
    const detail = validateRemoteSshProfile(payload || {});
    return {
      status: "error",
      message: detail.status === "error" ? detail.message : "remoteSsh.add: invalid profile",
    };
  }
  const next = _remoteSshSnapshot(deps);
  if (next.profiles.some((p) => p.id === profile.id)) {
    return { status: "error", message: `remoteSsh.add: profile id "${profile.id}" already exists` };
  }
  next.profiles.push(profile);
  return { status: "ok", commit: { remoteSsh: next } };
}

function remoteSshUpdateProfile(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "remoteSsh.update: payload must be an object" };
  }
  const profile = sanitizeRemoteSshProfile(payload);
  if (!profile) {
    const detail = validateRemoteSshProfile(payload || {});
    return {
      status: "error",
      message: detail.status === "error" ? detail.message : "remoteSsh.update: invalid profile",
    };
  }
  const next = _remoteSshSnapshot(deps);
  const idx = next.profiles.findIndex((p) => p.id === profile.id);
  if (idx === -1) {
    return { status: "error", message: `remoteSsh.update: profile id "${profile.id}" not found` };
  }
  // Preserve original createdAt if caller didn't supply one new.
  const prev = next.profiles[idx];
  if (Number.isFinite(prev.createdAt) && !Number.isFinite(payload.createdAt)) {
    profile.createdAt = prev.createdAt;
  }
  // Preserve lastDeployedAt across cosmetic edits (label, autoStartCodexMonitor,
  // connectOnLaunch). Only clear it when deploy target fields drifted — those
  // changes mean the previous deploy is no longer valid for the new target,
  // so the UI should re-warn "never deployed" until user runs Deploy again.
  // Use deployTargetFingerprint to normalize port-22-vs-undefined and empty
  // optional strings before comparing — naive prev[f] === profile[f] would
  // false-flag "port drift" when prev had port:22 and the UI saveBtn omitted
  // the default 22 from the payload.
  const drift = deployTargetDrift(deployTargetFingerprint(prev), deployTargetFingerprint(profile));
  if (drift === null) {
    if (Number.isFinite(prev.lastDeployedAt) && !Number.isFinite(payload.lastDeployedAt)) {
      profile.lastDeployedAt = prev.lastDeployedAt;
    }
    if (profile.detectedRemoteNodeBin === undefined) {
      copyRemoteNodeDetection(profile, prev);
    }
  }
  next.profiles[idx] = profile;
  return { status: "ok", commit: { remoteSsh: next } };
}

// Stamp deploy completion onto a profile WITHOUT touching any other field.
// Use this from the deploy IPC handler instead of remoteSsh.update with a
// pre-deploy profile snapshot — deploy can take 30+ seconds, during which
// the user may have edited the profile. Re-writing the whole profile from
// the snapshot would clobber those edits (lost-update race).
//
// expectedTarget is an optional fingerprint of {host, port, identityFile,
// remoteForwardPort, hostPrefix} captured by the caller at deploy start.
// If the current profile's target fields drifted away from that fingerprint,
// the deploy ran against an old target — we no-op rather than falsely claim
// the new (drifted) configuration is "deployed". Caller learns from the
// noop+targetDrift response and can prompt the user to redeploy.
function remoteSshMarkDeployed(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "remoteSsh.markDeployed: payload must be an object" };
  }
  const { id, deployedAt, expectedTarget } = payload;
  if (typeof id !== "string" || !id) {
    return { status: "error", message: "remoteSsh.markDeployed.id must be a non-empty string" };
  }
  if (!Number.isFinite(deployedAt) || deployedAt <= 0) {
    return { status: "error", message: "remoteSsh.markDeployed.deployedAt must be a positive finite number" };
  }
  const next = _remoteSshSnapshot(deps);
  const idx = next.profiles.findIndex((p) => p.id === id);
  if (idx === -1) {
    // Profile was deleted mid-deploy — silently skip rather than error.
    return { status: "ok", noop: true, reason: "profile_deleted" };
  }
  const current = next.profiles[idx];
  if (expectedTarget && typeof expectedTarget === "object") {
    // Normalize both sides through deployTargetFingerprint so port-22 vs
    // undefined / empty-string vs missing don't false-flag drift. This also
    // means the IPC caller's expectedTarget can be a raw profile-shaped
    // object — fingerprint normalizes it the same way.
    const drift = deployTargetDrift(
      deployTargetFingerprint(current),
      deployTargetFingerprint(expectedTarget)
    );
    if (drift) {
      return {
        status: "ok",
        noop: true,
        reason: "target_drift",
        targetDrift: drift,
        message: `remoteSsh.markDeployed: profile ${id}.${drift} changed during deploy; not stamping`,
      };
    }
  }
  // Only mutate deployment metadata — every other field stays as-is so
  // concurrent user edits (label / autoStartCodexMonitor / connectOnLaunch)
  // survive.
  const updatedProfile = { ...current, lastDeployedAt: deployedAt };
  const remoteNode = normalizeRemoteNodeDetection(payload.remoteNode || payload, deployedAt);
  if (remoteNode) copyRemoteNodeDetection(updatedProfile, remoteNode);
  const newProfiles = next.profiles.slice();
  newProfiles[idx] = updatedProfile;
  return { status: "ok", commit: { remoteSsh: { profiles: newProfiles } } };
}

function remoteSshMarkRemoteNode(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "remoteSsh.markRemoteNode: payload must be an object" };
  }
  const { id, expectedTarget } = payload;
  if (typeof id !== "string" || !id) {
    return { status: "error", message: "remoteSsh.markRemoteNode.id must be a non-empty string" };
  }
  const remoteNode = normalizeRemoteNodeDetection(payload);
  if (!remoteNode) {
    return { status: "error", message: "remoteSsh.markRemoteNode.nodeBin must be an absolute POSIX path" };
  }
  const next = _remoteSshSnapshot(deps);
  const idx = next.profiles.findIndex((p) => p.id === id);
  if (idx === -1) {
    return { status: "ok", noop: true, reason: "profile_deleted" };
  }
  const current = next.profiles[idx];
  if (expectedTarget && typeof expectedTarget === "object") {
    const drift = deployTargetDrift(
      deployTargetFingerprint(current),
      deployTargetFingerprint(expectedTarget)
    );
    if (drift) {
      return {
        status: "ok",
        noop: true,
        reason: "target_drift",
        targetDrift: drift,
        message: `remoteSsh.markRemoteNode: profile ${id}.${drift} changed during detection; not stamping`,
      };
    }
  }
  const updatedProfile = { ...current };
  copyRemoteNodeDetection(updatedProfile, remoteNode);
  const newProfiles = next.profiles.slice();
  newProfiles[idx] = updatedProfile;
  return { status: "ok", commit: { remoteSsh: { profiles: newProfiles } } };
}

function remoteSshDeleteProfile(payload, deps) {
  const id = typeof payload === "string"
    ? payload
    : (payload && typeof payload === "object" ? payload.id : null);
  if (typeof id !== "string" || !id) {
    return { status: "error", message: "remoteSsh.delete: id must be a non-empty string" };
  }
  const next = _remoteSshSnapshot(deps);
  const idx = next.profiles.findIndex((p) => p.id === id);
  if (idx === -1) {
    // No-op rather than error — UI may have raced with a re-render.
    return { status: "ok", noop: true };
  }
  next.profiles.splice(idx, 1);
  return { status: "ok", commit: { remoteSsh: next } };
}

async function telegramApprovalSetToken(payload, deps = {}) {
  const token = typeof payload === "string"
    ? payload
    : (payload && typeof payload === "object" ? payload.token : "");
  const valid = validateTelegramBotToken(token);
  if (valid.status !== "ok") return valid;
  if (!deps || typeof deps.writeTelegramApprovalToken !== "function") {
    return { status: "error", message: "telegramApproval.setToken requires writeTelegramApprovalToken dep" };
  }
  const result = await deps.writeTelegramApprovalToken(valid.token);
  if (!result || result.status !== "ok") {
    return result || { status: "error", message: "Telegram bot token write failed" };
  }
  return { status: "ok", tokenStored: true };
}

function telegramApprovalStatus(_payload, deps = {}) {
  if (!deps || typeof deps.getTelegramApprovalStatus !== "function") {
    return { status: "error", message: "telegramApproval.status requires getTelegramApprovalStatus dep" };
  }
  const status = deps.getTelegramApprovalStatus();
  return { status: "ok", state: status || { status: "stopped" } };
}

function telegramApprovalTokenInfo(_payload, deps = {}) {
  if (!deps || typeof deps.getTelegramApprovalTokenInfo !== "function") {
    return { status: "error", message: "telegramApproval.tokenInfo requires getTelegramApprovalTokenInfo dep" };
  }
  const info = deps.getTelegramApprovalTokenInfo() || { configured: false, masked: "" };
  return {
    status: "ok",
    configured: info.configured === true,
    masked: typeof info.masked === "string" ? info.masked : "",
  };
}

async function telegramApprovalSendTest(_payload, deps = {}) {
  if (!deps || typeof deps.sendTelegramApprovalTest !== "function") {
    return { status: "error", message: "telegramApproval.test requires sendTelegramApprovalTest dep" };
  }
  const result = await deps.sendTelegramApprovalTest();
  return result || { status: "error", message: "Telegram approval test returned no result" };
}

// Share a domain lock across all four remoteSsh.* commands so concurrent
// invocations against the same prefs field serialize. Without this, the
// controller assigns each command its own lock by name, and two commands
// (e.g. remoteSsh.update and remoteSsh.markDeployed) can both read the same
// snapshot, compute their own commit, and stomp each other's writes.
//
// Concrete races this guards:
//   - update + markDeployed: stamp can clobber a label edit committed
//     between the read and write of update.
//   - delete + markDeployed: markDeployed can resurrect a profile after
//     delete committed.
//   - add + markDeployed: less likely (different ids) but kept for
//     defense-in-depth.
remoteSshAddProfile.lockKey = "remoteSsh";
remoteSshUpdateProfile.lockKey = "remoteSsh";
remoteSshDeleteProfile.lockKey = "remoteSsh";
remoteSshMarkDeployed.lockKey = "remoteSsh";
remoteSshMarkRemoteNode.lockKey = "remoteSsh";
telegramApprovalSetToken.lockKey = "tgApproval";
telegramApprovalSendTest.lockKey = "tgApproval";

const repairDoctorIssue = createRepairDoctorIssue({
  repairAgentIntegration,
  setBubbleCategoryEnabled,
});

const commandRegistry = {
  removeTheme,
  installHooks,
  uninstallHooks,
  repairAgentIntegration,
  repairLocalServer,
  repairDoctorIssue,
  resizePet,
  registerShortcut,
  resetShortcut,
  resetAllShortcuts,
  setAgentFlag,
  setAgentPermissionMode,
  setAllBubblesHidden,
  setBubbleCategoryEnabled,
  "sessionCleanup.setTriple": setSessionCleanupTriple,
  setSessionAlias,
  setAnimationOverride,
  setSoundOverride,
  setThemeOverrideDisabled,
  resetThemeOverrides,
  importAnimationOverrides,
  setWideHitboxOverride,
  setThemeSelection,
  "remoteSsh.add": remoteSshAddProfile,
  "remoteSsh.update": remoteSshUpdateProfile,
  "remoteSsh.delete": remoteSshDeleteProfile,
  "remoteSsh.markDeployed": remoteSshMarkDeployed,
  "remoteSsh.markRemoteNode": remoteSshMarkRemoteNode,
  "telegramApproval.setToken": telegramApprovalSetToken,
  "telegramApproval.status": telegramApprovalStatus,
  "telegramApproval.tokenInfo": telegramApprovalTokenInfo,
  "telegramApproval.test": telegramApprovalSendTest,
};

module.exports = {
  updateRegistry,
  commandRegistry,
  ONESHOT_OVERRIDE_STATES,
  ANIMATION_OVERRIDES_EXPORT_VERSION,
  // Exposed for tests
  requireBoolean,
  requireFiniteNumber,
  requireEnum,
  requireString,
  requirePlainObject,
  requireIntegerInRange,
};
