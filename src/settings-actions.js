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

const { CURRENT_VERSION, AGENT_FLAGS } = require("./prefs");

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

  // ── Pure data prefs (function-form: validator only) ──
  lang: requireEnum("lang", ["en", "zh"]),
  soundMuted: requireBoolean("soundMuted"),
  bubbleFollowPet: requireBoolean("bubbleFollowPet"),
  hideBubbles: requireBoolean("hideBubbles"),
  showSessionId: requireBoolean("showSessionId"),

  // ── System-backed prefs (object-form: validate + effect pre-commit gate) ──
  //
  // autoStartWithClaude: writes/removes a SessionStart hook in
  //   ~/.claude/settings.json via hooks/install.js. Failure to write the file
  //   (permission denied, disk full, corrupt JSON) MUST prevent the prefs
  //   commit so the UI never shows "on" while the file is unchanged.
  autoStartWithClaude: {
    validate: requireBoolean("autoStartWithClaude"),
    effect(value, deps) {
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

  // ── Theme ──
  theme: requireString("theme"),

  // ── Phase 2/3 placeholders — schema reserves these so applyUpdate accepts them ──
  agents: requirePlainObject("agents"),
  themeOverrides: requirePlainObject("themeOverrides"),

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

// setAgentFlag — atomic single-agent, single-flag toggle.
// Payload `{ agentId, flag, value }` where flag ∈ AGENT_FLAGS.
//
// Flags:
//   enabled             — master: event stream on/off
//   permissionsEnabled  — sub: bubble UI on/off (events still flow)
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
        if (typeof deps.stopMonitorForAgent === "function") deps.stopMonitorForAgent(agentId);
        if (typeof deps.clearSessionsByAgent === "function") deps.clearSessionsByAgent(agentId);
        if (typeof deps.dismissPermissionsByAgent === "function") deps.dismissPermissionsByAgent(agentId);
      } else {
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

const commandRegistry = {
  removeTheme: notImplemented("removeTheme"),
  installHooks: notImplemented("installHooks"),
  uninstallHooks: notImplemented("uninstallHooks"),
  registerShortcut: notImplemented("registerShortcut"),
  setAgentFlag,
};

module.exports = {
  updateRegistry,
  commandRegistry,
  // Exposed for tests
  requireBoolean,
  requireFiniteNumber,
  requireEnum,
  requireString,
  requirePlainObject,
};
