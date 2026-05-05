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

const {
  CURRENT_VERSION,
  AGENT_FLAGS,
  CODEX_PERMISSION_MODES,
  normalizeThemeOverrides,
} = require("./prefs");
const { getCodexPermissionMode, isAgentEnabled } = require("./agent-gate");
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
const {
  SHORTCUT_ACTIONS,
  SHORTCUT_ACTION_IDS,
  getDefaultShortcuts,
  parseAccelerator,
  isDangerousAccelerator,
  validateShortcutMapShape,
} = require("./shortcut-actions");

const ANIMATION_OVERRIDES_EXPORT_VERSION = 1;
const { isPlainObject } = require("./theme-loader");

const AUTO_REPAIRABLE_AGENT_IDS = new Set([
  "claude-code",
  "codex",
  "cursor-agent",
  "gemini-cli",
  "codebuddy",
  "kiro-cli",
  "kimi-cli",
  "opencode",
]);
const CLAUDE_HOOKS_LOCK_KEY = "claude-hooks";

// ── Validator helpers ──

function requireBoolean(key) {
  return function (value) {
    if (typeof value !== "boolean") {
      return { status: "error", message: `${key} must be a boolean` };
    }
    return { status: "ok" };
  };
}

function requireFiniteNumber(key) {
  return function (value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { status: "error", message: `${key} must be a finite number` };
    }
    return { status: "ok" };
  };
}

function requireNonNegativeFiniteNumber(key) {
  return function (value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return { status: "error", message: `${key} must be a non-negative finite number` };
    }
    return { status: "ok" };
  };
}

function requireNumberInRange(key, min, max) {
  return function (value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      return { status: "error", message: `${key} must be a finite number between ${min} and ${max}` };
    }
    return { status: "ok" };
  };
}

function requireIntegerInRange(key, min, max) {
  return function (value) {
    if (!Number.isInteger(value) || value < min || value > max) {
      return { status: "error", message: `${key} must be an integer between ${min} and ${max}` };
    }
    return { status: "ok" };
  };
}

function requireEnum(key, allowed) {
  return function (value) {
    if (!allowed.includes(value)) {
      return {
        status: "error",
        message: `${key} must be one of: ${allowed.join(", ")}`,
      };
    }
    return { status: "ok" };
  };
}

function requireString(key, { allowEmpty = false } = {}) {
  return function (value) {
    if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
      return { status: "error", message: `${key} must be a non-empty string` };
    }
    return { status: "ok" };
  };
}

function requirePlainObject(key) {
  return function (value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { status: "error", message: `${key} must be a plain object` };
    }
    return { status: "ok" };
  };
}

const THEME_OVERRIDE_RESERVED_KEYS = new Set(["states", "tiers", "timings", "idleAnimations", "reactions", "hitbox", "sounds"]);
const TIER_OVERRIDE_GROUPS = new Set(["workingTiers", "jugglingTiers"]);
const REACTION_KEYS = new Set(["drag", "clickLeft", "clickRight", "annoyed", "double"]);

function cloneStateOverrides(themeMap) {
  const out = {};
  if (!isPlainObject(themeMap)) return out;
  if (isPlainObject(themeMap.states)) {
    for (const [stateKey, entry] of Object.entries(themeMap.states)) {
      if (isPlainObject(entry)) out[stateKey] = { ...entry };
    }
  }
  for (const [key, entry] of Object.entries(themeMap)) {
    if (THEME_OVERRIDE_RESERVED_KEYS.has(key)) continue;
    if (!out[key] && isPlainObject(entry)) out[key] = { ...entry };
  }
  return out;
}

function cloneFileKeyedMap(map) {
  const out = {};
  if (!isPlainObject(map)) return out;
  for (const [originalFile, entry] of Object.entries(map)) {
    if (isPlainObject(entry)) out[originalFile] = { ...entry };
  }
  return out;
}

function cloneTierOverrides(themeMap, tierGroup) {
  if (!isPlainObject(themeMap) || !isPlainObject(themeMap.tiers)) return {};
  return cloneFileKeyedMap(themeMap.tiers[tierGroup]);
}

function cloneAutoReturnOverrides(themeMap) {
  const out = {};
  if (!isPlainObject(themeMap) || !isPlainObject(themeMap.timings)) return out;
  const autoReturn = themeMap.timings.autoReturn;
  if (!isPlainObject(autoReturn)) return out;
  for (const [stateKey, value] of Object.entries(autoReturn)) {
    if (typeof value === "number" && Number.isFinite(value)) out[stateKey] = value;
  }
  return out;
}

function cloneIdleAnimationOverrides(themeMap) {
  if (!isPlainObject(themeMap)) return {};
  return cloneFileKeyedMap(themeMap.idleAnimations);
}

function cloneReactionOverrides(themeMap) {
  const out = {};
  if (!isPlainObject(themeMap) || !isPlainObject(themeMap.reactions)) return out;
  for (const [reactionKey, entry] of Object.entries(themeMap.reactions)) {
    if (isPlainObject(entry)) out[reactionKey] = { ...entry };
  }
  return out;
}

function cloneHitboxOverrides(themeMap) {
  const out = {};
  if (!isPlainObject(themeMap) || !isPlainObject(themeMap.hitbox)) return out;
  for (const [groupKey, entry] of Object.entries(themeMap.hitbox)) {
    if (isPlainObject(entry)) out[groupKey] = { ...entry };
  }
  return out;
}

function cloneSoundOverrides(themeMap) {
  const out = {};
  if (!isPlainObject(themeMap) || !isPlainObject(themeMap.sounds)) return out;
  for (const [soundName, entry] of Object.entries(themeMap.sounds)) {
    if (isPlainObject(entry)) out[soundName] = { ...entry };
  }
  return out;
}

function buildThemeOverrideMap({ states, workingTiers, jugglingTiers, autoReturn, idleAnimations, reactions, hitbox, sounds }) {
  const out = {};
  if (states && Object.keys(states).length > 0) out.states = states;
  const tiers = {};
  if (workingTiers && Object.keys(workingTiers).length > 0) tiers.workingTiers = workingTiers;
  if (jugglingTiers && Object.keys(jugglingTiers).length > 0) tiers.jugglingTiers = jugglingTiers;
  if (Object.keys(tiers).length > 0) out.tiers = tiers;
  if (autoReturn && Object.keys(autoReturn).length > 0) out.timings = { autoReturn };
  if (idleAnimations && Object.keys(idleAnimations).length > 0) out.idleAnimations = idleAnimations;
  if (reactions && Object.keys(reactions).length > 0) out.reactions = reactions;
  if (hitbox && Object.keys(hitbox).length > 0) out.hitbox = hitbox;
  if (sounds && Object.keys(sounds).length > 0) out.sounds = sounds;
  return out;
}

function normalizeTransitionPayload(transition) {
  if (!isPlainObject(transition)) return null;
  const out = {};
  if (typeof transition.in === "number" && Number.isFinite(transition.in) && transition.in >= 0) out.in = transition.in;
  if (typeof transition.out === "number" && Number.isFinite(transition.out) && transition.out >= 0) out.out = transition.out;
  return Object.keys(out).length > 0 ? out : null;
}

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
  lang: requireEnum("lang", ["en", "zh", "ko", "ja"]),
  soundMuted: requireBoolean("soundMuted"),
  soundVolume: requireNumberInRange("soundVolume", 0, 1),
  lowPowerIdleMode: requireBoolean("lowPowerIdleMode"),
  bubbleFollowPet: requireBoolean("bubbleFollowPet"),
  sessionHudEnabled: requireBoolean("sessionHudEnabled"),
  sessionHudShowElapsed: requireBoolean("sessionHudShowElapsed"),
  sessionHudCleanupDetached: requireBoolean("sessionHudCleanupDetached"),
  hideBubbles: requireBoolean("hideBubbles"),
  permissionBubblesEnabled: requireBoolean("permissionBubblesEnabled"),
  notificationBubbleAutoCloseSeconds: requireIntegerInRange(
    "notificationBubbleAutoCloseSeconds",
    0,
    MAX_AUTO_CLOSE_SECONDS
  ),
  updateBubbleAutoCloseSeconds: requireIntegerInRange(
    "updateBubbleAutoCloseSeconds",
    0,
    MAX_AUTO_CLOSE_SECONDS
  ),
  allowEdgePinning: requireBoolean("allowEdgePinning"),
  keepSizeAcrossDisplays: requireBoolean("keepSizeAcrossDisplays"),

  // ── System-backed prefs (object-form: validate + effect pre-commit gate) ──
  //
  // autoStartWithClaude: writes/removes a SessionStart hook in
  //   ~/.claude/settings.json via hooks/install.js. Failure to write the file
  //   (permission denied, disk full, corrupt JSON) MUST prevent the prefs
  //   commit so the UI never shows "on" while the file is unchanged.
  autoStartWithClaude: {
    lockKey: CLAUDE_HOOKS_LOCK_KEY,
    validate: requireBoolean("autoStartWithClaude"),
    effect(value, deps) {
      if (deps && deps.snapshot && deps.snapshot.manageClaudeHooksAutomatically === false) {
        return { status: "ok", noop: true };
      }
      if (!deps || typeof deps.installAutoStart !== "function" || typeof deps.uninstallAutoStart !== "function") {
        return {
          status: "error",
          message: "autoStartWithClaude effect requires installAutoStart/uninstallAutoStart deps",
        };
      }
      try {
        if (value) deps.installAutoStart();
        else deps.uninstallAutoStart();
        return { status: "ok" };
      } catch (err) {
        return {
          status: "error",
          message: `autoStartWithClaude: ${err && err.message}`,
        };
      }
    },
  },

  manageClaudeHooksAutomatically: {
    lockKey: CLAUDE_HOOKS_LOCK_KEY,
    validate: requireBoolean("manageClaudeHooksAutomatically"),
    effect(value, deps) {
      if (
        !deps
        || typeof deps.syncClaudeHooksNow !== "function"
        || typeof deps.startClaudeSettingsWatcher !== "function"
        || typeof deps.stopClaudeSettingsWatcher !== "function"
      ) {
        return {
          status: "error",
          message: "manageClaudeHooksAutomatically effect requires syncClaudeHooksNow/startClaudeSettingsWatcher/stopClaudeSettingsWatcher deps",
        };
      }
      if (!value) {
        try {
          deps.stopClaudeSettingsWatcher();
          return { status: "ok" };
        } catch (err) {
          return {
            status: "error",
            message: `manageClaudeHooksAutomatically: ${err && err.message}`,
          };
        }
      }
      if (!isAgentEnabled(deps.snapshot, "claude-code")) {
        return { status: "ok" };
      }
      return Promise.resolve()
        .then(() => deps.syncClaudeHooksNow())
        .then(() => {
          deps.startClaudeSettingsWatcher();
          return { status: "ok" };
        })
        .catch((err) => ({
          status: "error",
          message: `manageClaudeHooksAutomatically: ${err && err.message}`,
        }));
    },
  },

  // openAtLogin: writes the OS login item entry. Truth lives in the OS
  //   (LaunchAgent on macOS, Registry Run key on Windows, ~/.config/autostart
  //   on Linux). Effect proxies to a deps-injected setter so platform branching
  //   stays in main.js. See main.js's hydrateSystemBackedSettings() for the
  //   inverse direction (system → prefs on first run).
  openAtLogin: {
    validate: requireBoolean("openAtLogin"),
    effect(value, deps) {
      if (!deps || typeof deps.setOpenAtLogin !== "function") {
        return {
          status: "error",
          message: "openAtLogin effect requires setOpenAtLogin dep",
        };
      }
      try {
        deps.setOpenAtLogin(value);
        return { status: "ok" };
      } catch (err) {
        return {
          status: "error",
          message: `openAtLogin: ${err && err.message}`,
        };
      }
    },
  },

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

function getShortcutSnapshot(snapshot) {
  const defaults = getDefaultShortcuts();
  if (!snapshot || !snapshot.shortcuts || typeof snapshot.shortcuts !== "object") {
    return defaults;
  }
  return { ...defaults, ...snapshot.shortcuts };
}

function getPersistentShortcutHandler(actionId, deps) {
  const handlers = deps && deps.shortcutHandlers;
  const handler = handlers && handlers[actionId];
  if (typeof handler !== "function") return null;
  return handler;
}

function tryRegisterGlobalShortcut(globalShortcutModule, accelerator, handler) {
  if (!globalShortcutModule || typeof globalShortcutModule.register !== "function") return false;
  try {
    return !!globalShortcutModule.register(accelerator, handler);
  } catch {
    return false;
  }
}

function tryUnregisterGlobalShortcut(globalShortcutModule, accelerator) {
  if (!globalShortcutModule || typeof globalShortcutModule.unregister !== "function") {
    return { ok: false };
  }
  try {
    globalShortcutModule.unregister(accelerator);
  } catch {
    return { ok: false };
  }
  if (typeof globalShortcutModule.isRegistered === "function") {
    try {
      if (globalShortcutModule.isRegistered(accelerator)) {
        return { ok: false };
      }
    } catch {
      return { ok: false };
    }
  }
  return { ok: true };
}

function getShortcutFailure(actionId, deps) {
  if (!deps || typeof deps.getShortcutFailure !== "function") return null;
  return deps.getShortcutFailure(actionId) || null;
}

function clearShortcutFailure(actionId, deps) {
  if (deps && typeof deps.clearShortcutFailure === "function") {
    try { deps.clearShortcutFailure(actionId); } catch {}
  }
}

function validateShortcutBinding(actionId, accelerator, deps) {
  const meta = SHORTCUT_ACTIONS[actionId];
  if (!meta) {
    return { status: "error", message: "unknown shortcut action" };
  }

  if (accelerator === null) {
    return { status: "ok", accelerator: null };
  }
  if (typeof accelerator !== "string") {
    return { status: "error", message: "invalid accelerator format" };
  }

  const parsed = parseAccelerator(accelerator);
  if (!parsed) {
    return { status: "error", message: "invalid accelerator format" };
  }
  if (isDangerousAccelerator(parsed.accelerator)) {
    return { status: "error", message: "reserved accelerator" };
  }

  const shortcuts = getShortcutSnapshot(deps && deps.snapshot);
  for (const otherActionId of SHORTCUT_ACTION_IDS) {
    if (otherActionId === actionId) continue;
    if (shortcuts[otherActionId] === parsed.accelerator) {
      return {
        status: "error",
        message: `conflict: already bound to ${otherActionId}`,
      };
    }
  }

  return { status: "ok", accelerator: parsed.accelerator };
}

function applyPersistentShortcutChange(actionId, oldAccelerator, newAccelerator, deps, { allowRetrySame = false } = {}) {
  const globalShortcutModule = deps && deps.globalShortcut;
  const handler = getPersistentShortcutHandler(actionId, deps);
  if (!globalShortcutModule || typeof globalShortcutModule.register !== "function") {
    return {
      status: "error",
      message: "registerShortcut requires globalShortcut dep",
    };
  }
  if (!handler) {
    return {
      status: "error",
      message: `registerShortcut missing handler for ${actionId}`,
    };
  }

  if (oldAccelerator === newAccelerator) {
    if (!allowRetrySame || !newAccelerator) {
      clearShortcutFailure(actionId, deps);
      return { status: "ok", noop: true };
    }
    let alreadyRegistered = false;
    if (typeof globalShortcutModule.isRegistered === "function") {
      try {
        alreadyRegistered = !!globalShortcutModule.isRegistered(newAccelerator);
      } catch {
        alreadyRegistered = false;
      }
    }
    if (alreadyRegistered) {
      clearShortcutFailure(actionId, deps);
      return { status: "ok", noop: true };
    }
    const retryOk = tryRegisterGlobalShortcut(globalShortcutModule, newAccelerator, handler);
    if (!retryOk) {
      return { status: "error", message: "system conflict: accelerator is in use" };
    }
    clearShortcutFailure(actionId, deps);
    return { status: "ok", noop: true };
  }

  if (newAccelerator !== null) {
    const ok = tryRegisterGlobalShortcut(globalShortcutModule, newAccelerator, handler);
    if (!ok) {
      return { status: "error", message: "system conflict: accelerator is in use" };
    }
  }

  if (oldAccelerator !== null) {
    const unregistered = tryUnregisterGlobalShortcut(globalShortcutModule, oldAccelerator);
    if (!unregistered.ok) {
      if (newAccelerator !== null) {
        try { globalShortcutModule.unregister(newAccelerator); } catch {}
      }
      return {
        status: "error",
        message: "unregister of old accelerator failed, rolled back",
      };
    }
  }

  clearShortcutFailure(actionId, deps);
  return { status: "ok" };
}

function registerShortcut(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "registerShortcut payload must be an object" };
  }
  const { actionId } = payload;
  if (typeof actionId !== "string" || !SHORTCUT_ACTIONS[actionId]) {
    return { status: "error", message: "unknown shortcut action" };
  }

  const accelerator = Object.prototype.hasOwnProperty.call(payload, "accelerator")
    ? payload.accelerator
    : undefined;
  const validated = validateShortcutBinding(actionId, accelerator, deps);
  if (validated.status !== "ok") return validated;

  const shortcuts = getShortcutSnapshot(deps && deps.snapshot);
  const currentAccelerator = shortcuts[actionId] ?? null;
  const nextAccelerator = validated.accelerator;
  const currentFailure = getShortcutFailure(actionId, deps);

  if (currentAccelerator === nextAccelerator) {
    if (SHORTCUT_ACTIONS[actionId].persistent && currentFailure) {
      return applyPersistentShortcutChange(
        actionId,
        currentAccelerator,
        nextAccelerator,
        deps,
        { allowRetrySame: true }
      );
    }
    return { status: "ok", noop: true };
  }

  if (SHORTCUT_ACTIONS[actionId].persistent) {
    const result = applyPersistentShortcutChange(
      actionId,
      currentAccelerator,
      nextAccelerator,
      deps
    );
    if (result.status !== "ok") return result;
  }

  return {
    status: "ok",
    commit: {
      shortcuts: { ...shortcuts, [actionId]: nextAccelerator },
    },
  };
}

function resetShortcut(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "resetShortcut payload must be an object" };
  }
  const { actionId } = payload;
  if (typeof actionId !== "string" || !SHORTCUT_ACTIONS[actionId]) {
    return { status: "error", message: "unknown shortcut action" };
  }
  return registerShortcut({
    actionId,
    accelerator: SHORTCUT_ACTIONS[actionId].defaultAccelerator,
  }, deps);
}

function rollbackAppliedShortcutChanges(appliedChanges, deps) {
  const globalShortcutModule = deps && deps.globalShortcut;
  if (!globalShortcutModule) return;
  // Unwind in reverse order for symmetry: new-first applied (register new →
  // unregister old), so rollback is (unregister new → re-register old).
  for (let i = appliedChanges.length - 1; i >= 0; i--) {
    const change = appliedChanges[i];
    const handler = getPersistentShortcutHandler(change.actionId, deps);
    if (change.newAccelerator !== null) {
      try { globalShortcutModule.unregister(change.newAccelerator); } catch {}
    }
    if (change.oldAccelerator !== null && handler) {
      try { globalShortcutModule.register(change.oldAccelerator, handler); } catch {}
    }
  }
}

function resetAllShortcuts(_payload, deps) {
  const currentShortcuts = getShortcutSnapshot(deps && deps.snapshot);
  const targetShortcuts = getDefaultShortcuts();

  const seen = new Set();
  for (const actionId of SHORTCUT_ACTION_IDS) {
    const validated = validateShortcutBinding(actionId, targetShortcuts[actionId], {
      ...deps,
      snapshot: { ...(deps && deps.snapshot), shortcuts: {} },
    });
    if (validated.status !== "ok") return validated;
    if (validated.accelerator !== null) {
      if (seen.has(validated.accelerator)) {
        return { status: "error", message: `conflict: already bound to ${actionId}` };
      }
      seen.add(validated.accelerator);
    }
  }

  // Track successfully applied persistent changes so we can roll back on
  // mid-loop failure. Today only `togglePet` is persistent so the loop runs
  // at most once and rollback is a no-op — but this future-proofs the plan
  // v3 §4.2 all-or-nothing contract for when additional persistent actions
  // get added.
  const appliedChanges = [];
  for (const actionId of SHORTCUT_ACTION_IDS) {
    const meta = SHORTCUT_ACTIONS[actionId];
    if (!meta.persistent) continue;
    const oldAccelerator = currentShortcuts[actionId] ?? null;
    const newAccelerator = targetShortcuts[actionId] ?? null;
    const currentFailure = getShortcutFailure(actionId, deps);
    const result = applyPersistentShortcutChange(
      actionId,
      oldAccelerator,
      newAccelerator,
      deps,
      { allowRetrySame: !!currentFailure }
    );
    if (result.status !== "ok") {
      rollbackAppliedShortcutChanges(appliedChanges, deps);
      return {
        status: "error",
        message: `system conflict on ${actionId}: accelerator in use`,
      };
    }
    if (!result.noop) {
      appliedChanges.push({ actionId, oldAccelerator, newAccelerator });
    }
  }

  if (JSON.stringify(currentShortcuts) === JSON.stringify(targetShortcuts)) {
    return { status: "ok", noop: true };
  }
  return { status: "ok", commit: { shortcuts: targetShortcuts } };
}

// setAgentFlag — atomic single-agent, single-flag toggle.
// Payload `{ agentId, flag, value }` where flag ∈ AGENT_FLAGS.
//
// Flags:
//   enabled                  — master: event stream on/off
//   permissionsEnabled       — sub: bubble UI on/off (events still flow)
//   notificationHookEnabled  — sub: wait-for-input bell + animation on/off
//                              (presentation-layer mute; session bookkeeping
//                              and Kimi hold-release cleanup still run)
//
// Main + sub share one command so rapid toggles serialize under the same
// controller lockKey — two separate commands would lost-update the
// agents object.
const _validateAgentFlagId = requireString("setAgentFlag.agentId");
const _validateAgentFlagValue = requireBoolean("setAgentFlag.value");
function setAgentFlag(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "setAgentFlag: payload must be an object" };
  }
  const { agentId, flag, value } = payload;
  const idCheck = _validateAgentFlagId(agentId);
  if (idCheck.status !== "ok") return idCheck;
  if (typeof flag !== "string" || !AGENT_FLAGS.includes(flag)) {
    return {
      status: "error",
      message: `setAgentFlag.flag must be one of: ${AGENT_FLAGS.join(", ")}`,
    };
  }
  const valueCheck = _validateAgentFlagValue(value);
  if (valueCheck.status !== "ok") return valueCheck;
  const snapshot = deps && deps.snapshot;
  const currentAgents = (snapshot && snapshot.agents) || {};
  const currentEntry = currentAgents[agentId];
  const currentValue =
    currentEntry && typeof currentEntry[flag] === "boolean" ? currentEntry[flag] : true;
  if (currentValue === value) {
    return { status: "ok", noop: true };
  }

  try {
    if (flag === "enabled") {
      if (!value) {
        if (agentId === "claude-code" && typeof deps.stopIntegrationForAgent === "function") {
          deps.stopIntegrationForAgent(agentId);
        }
        if (typeof deps.stopMonitorForAgent === "function") deps.stopMonitorForAgent(agentId);
        if (typeof deps.clearSessionsByAgent === "function") deps.clearSessionsByAgent(agentId);
        if (typeof deps.dismissPermissionsByAgent === "function") deps.dismissPermissionsByAgent(agentId);
      } else {
        if (typeof deps.syncIntegrationForAgent === "function") deps.syncIntegrationForAgent(agentId);
        if (typeof deps.startMonitorForAgent === "function") deps.startMonitorForAgent(agentId);
      }
    } else if (flag === "permissionsEnabled") {
      if (!value && typeof deps.dismissPermissionsByAgent === "function") {
        deps.dismissPermissionsByAgent(agentId);
      }
    }
  } catch (err) {
    return {
      status: "error",
      message: `setAgentFlag side effect threw: ${err && err.message}`,
    };
  }

  const nextEntry = { ...(currentEntry || {}), [flag]: value };
  const nextAgents = { ...currentAgents, [agentId]: nextEntry };
  return { status: "ok", commit: { agents: nextAgents } };
}

const _validateAgentPermissionModeId = requireString("setAgentPermissionMode.agentId");
function setAgentPermissionMode(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "setAgentPermissionMode: payload must be an object" };
  }
  const idCheck = _validateAgentPermissionModeId(payload.agentId);
  if (idCheck.status !== "ok") return idCheck;
  if (payload.agentId !== "codex") {
    return { status: "error", message: "setAgentPermissionMode only supports codex" };
  }
  if (!CODEX_PERMISSION_MODES.includes(payload.mode)) {
    return {
      status: "error",
      message: `setAgentPermissionMode.mode must be one of: ${CODEX_PERMISSION_MODES.join(", ")}`,
    };
  }

  const snapshot = deps && deps.snapshot;
  const currentAgents = (snapshot && snapshot.agents) || {};
  const currentEntry = currentAgents.codex || {};
  const currentMode = getCodexPermissionMode({ agents: currentAgents });
  if (currentMode === payload.mode) return { status: "ok", noop: true };

  try {
    if (payload.mode !== "intercept" && typeof deps.dismissPermissionsByAgent === "function") {
      deps.dismissPermissionsByAgent("codex");
    }
  } catch (err) {
    return {
      status: "error",
      message: `setAgentPermissionMode side effect threw: ${err && err.message}`,
    };
  }

  const nextAgents = {
    ...currentAgents,
    codex: { ...currentEntry, permissionMode: payload.mode },
  };
  return { status: "ok", commit: { agents: nextAgents } };
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

// Phase 3b: 仅允许 override 这 5 个"打扰态"——其他 state 要么不走 theme.states
// 这条路（idle/working/juggling 走 tiers/闭包），要么不是打扰（idle/sleeping 等
// 关了会让桌宠消失）。白名单硬钉在 action 层，UI 只是表象。
const ONESHOT_OVERRIDE_STATES = new Set([
  "attention", "error", "sweeping", "notification", "carrying",
]);

const _validateThemeOverrideThemeId = requireString("setThemeOverrideDisabled.themeId");
function setThemeOverrideDisabled(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "setThemeOverrideDisabled: payload must be an object" };
  }
  const { themeId, stateKey, disabled } = payload;
  const idCheck = _validateThemeOverrideThemeId(themeId);
  if (idCheck.status !== "ok") return idCheck;
  if (typeof stateKey !== "string" || !ONESHOT_OVERRIDE_STATES.has(stateKey)) {
    return {
      status: "error",
      message: `setThemeOverrideDisabled.stateKey must be one of: ${[...ONESHOT_OVERRIDE_STATES].join(", ")}`,
    };
  }
  if (typeof disabled !== "boolean") {
    return { status: "error", message: "setThemeOverrideDisabled.disabled must be a boolean" };
  }

  const snapshot = (deps && deps.snapshot) || {};
  const currentOverrides = snapshot.themeOverrides || {};
  const currentThemeMap = currentOverrides[themeId] || {};
  const currentStates = cloneStateOverrides(currentThemeMap);
  const currentEntry = currentStates[stateKey];
  const currentDisabled = !!(currentEntry && currentEntry.disabled === true);
  if (currentDisabled === disabled) {
    return { status: "ok", noop: true };
  }

  const nextStates = { ...currentStates };
  if (disabled) {
    nextStates[stateKey] = { ...(currentEntry || {}), disabled: true };
  } else {
    const preserved = { ...(currentEntry || {}) };
    delete preserved.disabled;
    if (Object.keys(preserved).length > 0) nextStates[stateKey] = preserved;
    else delete nextStates[stateKey];
  }

  const nextThemeMap = buildThemeOverrideMap({
    states: nextStates,
    workingTiers: cloneTierOverrides(currentThemeMap, "workingTiers"),
    jugglingTiers: cloneTierOverrides(currentThemeMap, "jugglingTiers"),
    autoReturn: cloneAutoReturnOverrides(currentThemeMap),
    idleAnimations: cloneIdleAnimationOverrides(currentThemeMap),
    reactions: cloneReactionOverrides(currentThemeMap),
    hitbox: cloneHitboxOverrides(currentThemeMap),
    sounds: cloneSoundOverrides(currentThemeMap),
  });
  const nextOverrides = { ...currentOverrides };
  if (Object.keys(nextThemeMap).length > 0) {
    nextOverrides[themeId] = nextThemeMap;
  } else {
    delete nextOverrides[themeId];
  }
  return { status: "ok", commit: { themeOverrides: nextOverrides } };
}

const _validateAnimationOverrideThemeId = requireString("setAnimationOverride.themeId");
function setAnimationOverride(payload, deps) {
  if (!isPlainObject(payload)) {
    return { status: "error", message: "setAnimationOverride: payload must be an object" };
  }
  const { themeId, slotType } = payload;
  const idCheck = _validateAnimationOverrideThemeId(themeId);
  if (idCheck.status !== "ok") return idCheck;
  if (slotType !== "state" && slotType !== "tier" && slotType !== "idleAnimation" && slotType !== "reaction") {
    return { status: "error", message: "setAnimationOverride.slotType must be 'state', 'tier', 'idleAnimation', or 'reaction'" };
  }

  const touchesFile = Object.prototype.hasOwnProperty.call(payload, "file");
  const touchesTransition = Object.prototype.hasOwnProperty.call(payload, "transition");
  const touchesAutoReturn = Object.prototype.hasOwnProperty.call(payload, "autoReturnMs");
  const touchesDuration = Object.prototype.hasOwnProperty.call(payload, "durationMs");
  if (!touchesFile && !touchesTransition && !touchesAutoReturn && !touchesDuration) {
    return { status: "error", message: "setAnimationOverride must change file, transition, autoReturnMs, or durationMs" };
  }

  if (touchesFile && payload.file !== null && (typeof payload.file !== "string" || !payload.file)) {
    return { status: "error", message: "setAnimationOverride.file must be null or a non-empty string" };
  }
  if (touchesTransition && payload.transition !== null && !normalizeTransitionPayload(payload.transition)) {
    return { status: "error", message: "setAnimationOverride.transition must contain finite non-negative in/out values" };
  }
  if (touchesAutoReturn && payload.autoReturnMs !== null) {
    if (typeof payload.autoReturnMs !== "number" || !Number.isFinite(payload.autoReturnMs)) {
      return { status: "error", message: "setAnimationOverride.autoReturnMs must be null or a finite number" };
    }
    if (payload.autoReturnMs < 500 || payload.autoReturnMs > 60000) {
      return { status: "error", message: "setAnimationOverride.autoReturnMs must be between 500 and 60000" };
    }
  }
  if (touchesDuration && payload.durationMs !== null) {
    if (typeof payload.durationMs !== "number" || !Number.isFinite(payload.durationMs)) {
      return { status: "error", message: "setAnimationOverride.durationMs must be null or a finite number" };
    }
    if (payload.durationMs < 500 || payload.durationMs > 60000) {
      return { status: "error", message: "setAnimationOverride.durationMs must be between 500 and 60000" };
    }
  }

  const snapshot = (deps && deps.snapshot) || {};
  const currentOverrides = snapshot.themeOverrides || {};
  const currentThemeMap = currentOverrides[themeId] || {};
  const nextStates = cloneStateOverrides(currentThemeMap);
  const nextWorkingTiers = cloneTierOverrides(currentThemeMap, "workingTiers");
  const nextJugglingTiers = cloneTierOverrides(currentThemeMap, "jugglingTiers");
  const nextAutoReturn = cloneAutoReturnOverrides(currentThemeMap);
  const nextIdleAnimations = cloneIdleAnimationOverrides(currentThemeMap);
  const nextReactions = cloneReactionOverrides(currentThemeMap);
  const nextHitbox = cloneHitboxOverrides(currentThemeMap);
  const nextSounds = cloneSoundOverrides(currentThemeMap);

  if (slotType === "state") {
    if (typeof payload.stateKey !== "string" || !payload.stateKey) {
      return { status: "error", message: "setAnimationOverride.stateKey must be a non-empty string for state slots" };
    }
    if (touchesDuration) {
      return { status: "error", message: "setAnimationOverride.durationMs is only supported for idleAnimation slots" };
    }
    const stateKey = payload.stateKey;
    const nextEntry = { ...(nextStates[stateKey] || {}) };
    if (touchesFile) {
      if (payload.file === null) {
        delete nextEntry.file;
        delete nextEntry.sourceThemeId;
      } else {
        nextEntry.file = payload.file;
      }
    }
    if (touchesTransition) {
      if (payload.transition === null) delete nextEntry.transition;
      else nextEntry.transition = normalizeTransitionPayload(payload.transition);
    }
    if (Object.keys(nextEntry).length > 0) nextStates[stateKey] = nextEntry;
    else delete nextStates[stateKey];

    if (touchesAutoReturn) {
      if (payload.autoReturnMs === null) delete nextAutoReturn[stateKey];
      else nextAutoReturn[stateKey] = payload.autoReturnMs;
    }
  } else if (slotType === "tier") {
    const { tierGroup, originalFile } = payload;
    if (!TIER_OVERRIDE_GROUPS.has(tierGroup)) {
      return { status: "error", message: "setAnimationOverride.tierGroup must be workingTiers or jugglingTiers" };
    }
    if (typeof originalFile !== "string" || !originalFile) {
      return { status: "error", message: "setAnimationOverride.originalFile must be a non-empty string for tier slots" };
    }
    if (touchesAutoReturn) {
      return { status: "error", message: "setAnimationOverride.autoReturnMs is only supported for state slots" };
    }
    if (touchesDuration) {
      return { status: "error", message: "setAnimationOverride.durationMs is not supported for tier slots" };
    }
    const tierMap = tierGroup === "workingTiers" ? nextWorkingTiers : nextJugglingTiers;
    const nextEntry = { ...(tierMap[originalFile] || {}) };
    if (touchesFile) {
      if (payload.file === null) {
        delete nextEntry.file;
        delete nextEntry.sourceThemeId;
      } else {
        nextEntry.file = payload.file;
      }
    }
    if (touchesTransition) {
      if (payload.transition === null) delete nextEntry.transition;
      else nextEntry.transition = normalizeTransitionPayload(payload.transition);
    }
    if (Object.keys(nextEntry).length > 0) tierMap[originalFile] = nextEntry;
    else delete tierMap[originalFile];
  } else if (slotType === "idleAnimation") {
    const { originalFile } = payload;
    if (typeof originalFile !== "string" || !originalFile) {
      return { status: "error", message: "setAnimationOverride.originalFile must be a non-empty string for idleAnimation slots" };
    }
    if (touchesAutoReturn) {
      return { status: "error", message: "setAnimationOverride.autoReturnMs is not supported for idleAnimation slots" };
    }
    const nextEntry = { ...(nextIdleAnimations[originalFile] || {}) };
    if (touchesFile) {
      if (payload.file === null) {
        delete nextEntry.file;
        delete nextEntry.sourceThemeId;
      } else {
        nextEntry.file = payload.file;
      }
    }
    if (touchesTransition) {
      if (payload.transition === null) delete nextEntry.transition;
      else nextEntry.transition = normalizeTransitionPayload(payload.transition);
    }
    if (touchesDuration) {
      if (payload.durationMs === null) delete nextEntry.durationMs;
      else nextEntry.durationMs = payload.durationMs;
    }
    if (Object.keys(nextEntry).length > 0) nextIdleAnimations[originalFile] = nextEntry;
    else delete nextIdleAnimations[originalFile];
  } else {
    // slotType === "reaction"
    const { reactionKey } = payload;
    if (!REACTION_KEYS.has(reactionKey)) {
      return { status: "error", message: "setAnimationOverride.reactionKey must be one of: drag, clickLeft, clickRight, annoyed, double" };
    }
    if (touchesAutoReturn) {
      return { status: "error", message: "setAnimationOverride.autoReturnMs is not supported for reaction slots" };
    }
    // drag plays until pointer-up — no duration semantics. Other reactions use
    // durationMs to control how long the oneshot stays on screen.
    if (touchesDuration && reactionKey === "drag") {
      return { status: "error", message: "setAnimationOverride.durationMs is not supported for reaction 'drag' (plays until pointer-up)" };
    }
    const nextEntry = { ...(nextReactions[reactionKey] || {}) };
    if (touchesFile) {
      if (payload.file === null) {
        delete nextEntry.file;
        delete nextEntry.sourceThemeId;
      } else {
        nextEntry.file = payload.file;
      }
    }
    if (touchesTransition) {
      if (payload.transition === null) delete nextEntry.transition;
      else nextEntry.transition = normalizeTransitionPayload(payload.transition);
    }
    if (touchesDuration) {
      if (payload.durationMs === null) delete nextEntry.durationMs;
      else nextEntry.durationMs = payload.durationMs;
    }
    if (Object.keys(nextEntry).length > 0) nextReactions[reactionKey] = nextEntry;
    else delete nextReactions[reactionKey];
  }

  const nextThemeMap = buildThemeOverrideMap({
    states: nextStates,
    workingTiers: nextWorkingTiers,
    jugglingTiers: nextJugglingTiers,
    autoReturn: nextAutoReturn,
    idleAnimations: nextIdleAnimations,
    reactions: nextReactions,
    hitbox: nextHitbox,
    sounds: nextSounds,
  });
  const nextOverrides = { ...currentOverrides };
  if (Object.keys(nextThemeMap).length > 0) nextOverrides[themeId] = nextThemeMap;
  else delete nextOverrides[themeId];

  if (JSON.stringify(nextOverrides) === JSON.stringify(currentOverrides)) {
    return { status: "ok", noop: true };
  }

  const activeThemeId = snapshot.theme;
  if (themeId === activeThemeId) {
    if (!deps || typeof deps.activateTheme !== "function") {
      return { status: "error", message: "setAnimationOverride effect requires activateTheme dep for the active theme" };
    }
    try {
      deps.activateTheme(themeId, null, nextThemeMap);
    } catch (err) {
      return { status: "error", message: `setAnimationOverride: ${err && err.message}` };
    }
  }

  return { status: "ok", commit: { themeOverrides: nextOverrides } };
}

// Per-sound-name audio replacement. `file` is a basename only; main.js's IPC
// layer handles copying the user-picked audio into the sound-overrides directory
// before calling this command, so the action layer stays transport-agnostic.
// Passing `file: null` clears the override for that sound name.
function setSoundOverride(payload, deps) {
  if (!isPlainObject(payload)) {
    return { status: "error", message: "setSoundOverride: payload must be an object" };
  }
  const { themeId, soundName, file, originalName } = payload;
  if (typeof themeId !== "string" || !themeId) {
    return { status: "error", message: "setSoundOverride.themeId must be a non-empty string" };
  }
  if (typeof soundName !== "string" || !soundName) {
    return { status: "error", message: "setSoundOverride.soundName must be a non-empty string" };
  }
  if (file !== null && (typeof file !== "string" || !file)) {
    return { status: "error", message: "setSoundOverride.file must be null or a non-empty string" };
  }

  const snapshot = (deps && deps.snapshot) || {};
  const currentOverrides = snapshot.themeOverrides || {};
  const currentThemeMap = currentOverrides[themeId] || {};
  const nextSounds = cloneSoundOverrides(currentThemeMap);

  if (file === null) {
    delete nextSounds[soundName];
  } else {
    const entry = { file };
    if (typeof originalName === "string" && originalName) entry.originalName = originalName;
    nextSounds[soundName] = entry;
  }

  const nextThemeMap = buildThemeOverrideMap({
    states: cloneStateOverrides(currentThemeMap),
    workingTiers: cloneTierOverrides(currentThemeMap, "workingTiers"),
    jugglingTiers: cloneTierOverrides(currentThemeMap, "jugglingTiers"),
    autoReturn: cloneAutoReturnOverrides(currentThemeMap),
    idleAnimations: cloneIdleAnimationOverrides(currentThemeMap),
    reactions: cloneReactionOverrides(currentThemeMap),
    hitbox: cloneHitboxOverrides(currentThemeMap),
    sounds: nextSounds,
  });
  const nextOverrides = { ...currentOverrides };
  if (Object.keys(nextThemeMap).length > 0) nextOverrides[themeId] = nextThemeMap;
  else delete nextOverrides[themeId];

  if (JSON.stringify(nextOverrides) === JSON.stringify(currentOverrides)) {
    return { status: "ok", noop: true };
  }

  const activeThemeId = snapshot.theme;
  if (themeId === activeThemeId) {
    if (!deps || typeof deps.activateTheme !== "function") {
      return { status: "error", message: "setSoundOverride effect requires activateTheme dep for the active theme" };
    }
    try {
      deps.activateTheme(themeId, null, nextThemeMap);
    } catch (err) {
      return { status: "error", message: `setSoundOverride: ${err && err.message}` };
    }
  }

  return { status: "ok", commit: { themeOverrides: nextOverrides } };
}

// Per-file toggle: force a file INTO or OUT of the wide-hitbox set, overriding
// the theme author's declaration. Passing `enabled: null` clears the override
// for that file (fall back to whatever the theme declares).
function setWideHitboxOverride(payload, deps) {
  if (!isPlainObject(payload)) {
    return { status: "error", message: "setWideHitboxOverride: payload must be an object" };
  }
  const { themeId, file, enabled } = payload;
  if (typeof themeId !== "string" || !themeId) {
    return { status: "error", message: "setWideHitboxOverride.themeId must be a non-empty string" };
  }
  if (typeof file !== "string" || !file) {
    return { status: "error", message: "setWideHitboxOverride.file must be a non-empty string" };
  }
  if (enabled !== null && typeof enabled !== "boolean") {
    return { status: "error", message: "setWideHitboxOverride.enabled must be boolean or null" };
  }

  const snapshot = (deps && deps.snapshot) || {};
  const currentOverrides = snapshot.themeOverrides || {};
  const currentThemeMap = currentOverrides[themeId] || {};
  const currentHitbox = isPlainObject(currentThemeMap.hitbox) ? currentThemeMap.hitbox : {};
  const currentWide = isPlainObject(currentHitbox.wide) ? { ...currentHitbox.wide } : {};

  if (enabled === null) {
    delete currentWide[file];
  } else {
    currentWide[file] = enabled;
  }

  const nextHitbox = { ...currentHitbox };
  if (Object.keys(currentWide).length > 0) {
    nextHitbox.wide = currentWide;
  } else {
    delete nextHitbox.wide;
  }

  const nextThemeMap = { ...currentThemeMap };
  if (Object.keys(nextHitbox).length > 0) {
    nextThemeMap.hitbox = nextHitbox;
  } else {
    delete nextThemeMap.hitbox;
  }

  const nextOverrides = { ...currentOverrides };
  if (Object.keys(nextThemeMap).length > 0) nextOverrides[themeId] = nextThemeMap;
  else delete nextOverrides[themeId];

  if (JSON.stringify(nextOverrides) === JSON.stringify(currentOverrides)) {
    return { status: "ok", noop: true };
  }

  const activeThemeId = snapshot.theme;
  if (themeId === activeThemeId) {
    if (!deps || typeof deps.activateTheme !== "function") {
      return { status: "error", message: "setWideHitboxOverride effect requires activateTheme dep" };
    }
    try {
      deps.activateTheme(themeId, null, nextThemeMap);
    } catch (err) {
      return { status: "error", message: `setWideHitboxOverride: ${err && err.message}` };
    }
  }

  return { status: "ok", commit: { themeOverrides: nextOverrides } };
}

function importAnimationOverrides(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "importAnimationOverrides payload must be an object" };
  }
  const mode = payload.mode === "replace" ? "replace" : "merge";

  const incomingVersion = payload.version;
  if (typeof incomingVersion === "number" && incomingVersion > ANIMATION_OVERRIDES_EXPORT_VERSION) {
    return {
      status: "error",
      message: `importAnimationOverrides: file version ${incomingVersion} newer than supported (${ANIMATION_OVERRIDES_EXPORT_VERSION})`,
    };
  }

  const themesPayload = payload.themes;
  if (!themesPayload || typeof themesPayload !== "object" || Array.isArray(themesPayload)) {
    return { status: "error", message: "importAnimationOverrides: payload.themes must be an object" };
  }

  const normalizedIncoming = normalizeThemeOverrides(themesPayload, {});
  if (!normalizedIncoming || Object.keys(normalizedIncoming).length === 0) {
    return { status: "error", message: "importAnimationOverrides: no valid override entries found" };
  }

  const snapshot = (deps && deps.snapshot) || {};
  const currentOverrides = snapshot.themeOverrides || {};
  const nextOverrides = mode === "replace"
    ? normalizedIncoming
    : { ...currentOverrides, ...normalizedIncoming };

  const activeThemeId = snapshot.theme;
  const activeChanged = activeThemeId
    && JSON.stringify(nextOverrides[activeThemeId] || null)
       !== JSON.stringify(currentOverrides[activeThemeId] || null);

  if (activeChanged) {
    if (!deps || typeof deps.activateTheme !== "function") {
      return { status: "error", message: "importAnimationOverrides effect requires activateTheme dep" };
    }
    try {
      // Must pass nextOverrides[activeThemeId] — the effect runs BEFORE
      // controller._commit(), so activateTheme reading themeOverrides from the
      // store would still see the old map. Passing nextOverrideMap explicitly
      // is what makes the newly-imported slots actually take effect.
      deps.activateTheme(activeThemeId, null, nextOverrides[activeThemeId] || null);
    } catch (err) {
      return { status: "error", message: `importAnimationOverrides: ${err && err.message}` };
    }
  }

  const importedThemeCount = Object.keys(normalizedIncoming).length;
  return {
    status: "ok",
    commit: { themeOverrides: nextOverrides },
    importedThemeCount,
    mode,
  };
}

const _validateResetOverridesThemeId = requireString("resetThemeOverrides.themeId");
function resetThemeOverrides(payload, deps) {
  const themeId = typeof payload === "string" ? payload : (payload && payload.themeId);
  const idCheck = _validateResetOverridesThemeId(themeId);
  if (idCheck.status !== "ok") return idCheck;

  const snapshot = (deps && deps.snapshot) || {};
  const currentOverrides = snapshot.themeOverrides || {};
  if (!currentOverrides[themeId]) {
    return { status: "ok", noop: true };
  }

  const activeThemeId = snapshot.theme;
  if (themeId === activeThemeId) {
    if (!deps || typeof deps.activateTheme !== "function") {
      return { status: "error", message: "resetThemeOverrides effect requires activateTheme dep for the active theme" };
    }
    try {
      deps.activateTheme(themeId, null, null);
    } catch (err) {
      return { status: "error", message: `resetThemeOverrides: ${err && err.message}` };
    }
  }

  const nextOverrides = { ...currentOverrides };
  delete nextOverrides[themeId];
  return { status: "ok", commit: { themeOverrides: nextOverrides } };
}

async function installHooks(_payload, deps) {
  if (!deps || typeof deps.syncClaudeHooksNow !== "function") {
    return {
      status: "error",
      message: "installHooks requires syncClaudeHooksNow dep",
    };
  }
  try {
    await deps.syncClaudeHooksNow();
    return { status: "ok" };
  } catch (err) {
    return { status: "error", message: `installHooks: ${err && err.message}` };
  }
}

async function uninstallHooks(_payload, deps) {
  if (
    !deps
    || typeof deps.uninstallClaudeHooksNow !== "function"
    || typeof deps.stopClaudeSettingsWatcher !== "function"
  ) {
    return {
      status: "error",
      message: "uninstallHooks requires uninstallClaudeHooksNow and stopClaudeSettingsWatcher deps",
    };
  }

  const shouldRestoreWatcher = !!(deps.snapshot && deps.snapshot.manageClaudeHooksAutomatically);
  try {
    deps.stopClaudeSettingsWatcher();
    await deps.uninstallClaudeHooksNow();
    return { status: "ok", commit: { manageClaudeHooksAutomatically: false } };
  } catch (err) {
    if (shouldRestoreWatcher && typeof deps.startClaudeSettingsWatcher === "function") {
      try { deps.startClaudeSettingsWatcher(); } catch {}
    }
    return { status: "error", message: `uninstallHooks: ${err && err.message}` };
  }
}

async function repairAgentIntegration(payload, deps) {
  const agentId = typeof payload === "string" ? payload : payload && payload.agentId;
  const idCheck = _validateAgentFlagId(agentId);
  if (idCheck.status !== "ok") return idCheck;
  if (
    payload
    && typeof payload === "object"
    && Object.prototype.hasOwnProperty.call(payload, "forceCodexHooksFeature")
    && typeof payload.forceCodexHooksFeature !== "boolean"
  ) {
    return { status: "error", message: "repairAgentIntegration.forceCodexHooksFeature must be a boolean" };
  }
  const forceCodexHooksFeature =
    !!(payload && typeof payload === "object" && payload.forceCodexHooksFeature === true);

  if (!AUTO_REPAIRABLE_AGENT_IDS.has(agentId)) {
    return {
      status: "error",
      message: agentId === "copilot-cli"
        ? "Copilot CLI uses manual project-level hooks and cannot be auto-repaired"
        : `No automatic integration repair is available for ${agentId}`,
    };
  }

  const snapshot = deps && deps.snapshot;
  if (!isAgentEnabled(snapshot, agentId)) {
    return {
      status: "error",
      message: `${agentId} is disabled in Settings; enable it before repairing the integration`,
    };
  }

  if (agentId === "claude-code" && snapshot && snapshot.manageClaudeHooksAutomatically === false) {
    return {
      status: "error",
      message: "Claude hook management is disabled in Settings",
    };
  }

  const repairFn =
    deps && typeof deps.repairIntegrationForAgent === "function"
      ? deps.repairIntegrationForAgent
      : deps && typeof deps.syncIntegrationForAgent === "function"
        ? deps.syncIntegrationForAgent
        : null;
  if (!repairFn) {
    return {
      status: "error",
      message: "repairAgentIntegration requires repairIntegrationForAgent or syncIntegrationForAgent dep",
    };
  }

  try {
    const result = await repairFn(agentId, {
      forceCodexHooksFeature: agentId === "codex" && forceCodexHooksFeature,
    });
    if (result === false) {
      return { status: "error", message: `No automatic integration repair is available for ${agentId}` };
    }
    if (result && typeof result === "object" && result.status && result.status !== "ok") {
      return {
        status: "error",
        message: result.message || `Failed to repair ${agentId}`,
      };
    }
    return {
      status: "ok",
      message: result && typeof result === "object" && result.message
        ? result.message
        : `Repaired ${agentId}`,
    };
  } catch (err) {
    return {
      status: "error",
      message: `repairAgentIntegration: ${err && err.message}`,
    };
  }
}

async function repairLocalServer(_payload, deps) {
  if (!deps || typeof deps.repairLocalServer !== "function") {
    return {
      status: "error",
      message: "repairLocalServer requires repairLocalServer dep",
    };
  }
  try {
    const result = await deps.repairLocalServer();
    if (result === false) {
      return { status: "error", message: "Local server repair failed" };
    }
    if (result && typeof result === "object" && result.status && result.status !== "ok") {
      return {
        status: "error",
        message: result.message || "Local server repair failed",
      };
    }
    return { status: "ok" };
  } catch (err) {
    return {
      status: "error",
      message: `repairLocalServer: ${err && err.message}`,
    };
  }
}

async function repairDoctorIssue(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "repairDoctorIssue payload must be an object" };
  }
  const { type } = payload;
  if (type === "agent-integration") {
    return repairAgentIntegration(payload, deps);
  }
  if (type === "permission-bubble-policy") {
    return setBubbleCategoryEnabled({ category: "permission", enabled: true }, deps);
  }
  if (type === "theme-health") {
    return {
      status: "error",
      message: "Theme health issues must be fixed manually in Settings -> Theme",
    };
  }
  if (type === "local-server") {
    return repairLocalServer(payload, deps);
  }
  if (type === "restart-clawd") {
    return restartClawd(payload, deps);
  }
  return {
    status: "error",
    message: `Unknown Doctor repair target: ${type || "missing"}`,
  };
}

function restartClawd(payload, deps) {
  if (!payload || payload.confirmed !== true) {
    return { status: "error", message: "restartClawd requires confirmation" };
  }
  if (!deps || typeof deps.restartClawd !== "function") {
    return { status: "error", message: "restartClawd requires deps.restartClawd" };
  }
  try {
    deps.restartClawd();
    return { status: "ok", message: "Clawd is restarting" };
  } catch (err) {
    return { status: "error", message: `restartClawd: ${err && err.message}` };
  }
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

installHooks.lockKey = CLAUDE_HOOKS_LOCK_KEY;
uninstallHooks.lockKey = CLAUDE_HOOKS_LOCK_KEY;

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
  setSessionAlias,
  setAnimationOverride,
  setSoundOverride,
  setThemeOverrideDisabled,
  resetThemeOverrides,
  importAnimationOverrides,
  setWideHitboxOverride,
  setThemeSelection,
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
