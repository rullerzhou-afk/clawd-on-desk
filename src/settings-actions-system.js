"use strict";

const { isAgentEnabled } = require("./agent-gate");
const { requireBoolean } = require("./settings-validators");

const CLAUDE_HOOKS_LOCK_KEY = "claude-hooks";

// autoStartWithClaude: writes/removes a SessionStart hook in
// ~/.claude/settings.json via hooks/install.js. Failure to write the file must
// prevent the prefs commit so the UI never shows "on" while the file is unchanged.
const autoStartWithClaude = {
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
    // installAutoStart/uninstallAutoStart go through the server-owned Claude
    // hook operation queue and return a Promise. Wrap in Promise.resolve() so
    // a synchronous (e.g. test-injected) dep still works, then only commit
    // once the queue result actually confirms success — never on the Promise
    // object itself.
    try {
      const action = value ? deps.installAutoStart() : deps.uninstallAutoStart();
      return Promise.resolve(action)
        .then((result) => {
          if (result && typeof result === "object" && result.status === "error") {
            return { status: "error", message: result.message || "autoStartWithClaude: operation failed" };
          }
          return { status: "ok" };
        })
        .catch((err) => ({
          status: "error",
          message: `autoStartWithClaude: ${err && err.message}`,
        }));
    } catch (err) {
      return {
        status: "error",
        message: `autoStartWithClaude: ${err && err.message}`,
      };
    }
  },
};

const manageClaudeHooksAutomatically = {
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
      .then((result) => {
        // The queue never rejects on failure — it resolves { status: "error" }
        // — so success must be read from the resolved value, not inferred
        // from the Promise settling without throwing.
        if (result && typeof result === "object" && result.status === "error") {
          return { status: "error", message: result.message || "manageClaudeHooksAutomatically: sync failed" };
        }
        deps.startClaudeSettingsWatcher();
        return { status: "ok" };
      })
      .catch((err) => ({
        status: "error",
        message: `manageClaudeHooksAutomatically: ${err && err.message}`,
      }));
  },
};

// openAtLogin writes the OS login item entry. Truth lives in the OS and the
// inverse system-to-prefs hydration stays in main.js.
const openAtLogin = {
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
};

async function installHooks(_payload, deps) {
  if (!deps || typeof deps.syncClaudeHooksNow !== "function") {
    return {
      status: "error",
      message: "installHooks requires syncClaudeHooksNow dep",
    };
  }
  try {
    const result = await deps.syncClaudeHooksNow();
    if (result && typeof result === "object" && result.status === "error") {
      return { status: "error", message: result.message || "installHooks: sync failed" };
    }
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
    const result = await deps.uninstallClaudeHooksNow();
    if (result && typeof result === "object" && result.status === "error") {
      if (shouldRestoreWatcher && typeof deps.startClaudeSettingsWatcher === "function") {
        try { deps.startClaudeSettingsWatcher(); } catch {}
      }
      return { status: "error", message: result.message || "uninstallHooks: operation failed" };
    }
    return { status: "ok", commit: { manageClaudeHooksAutomatically: false } };
  } catch (err) {
    if (shouldRestoreWatcher && typeof deps.startClaudeSettingsWatcher === "function") {
      try { deps.startClaudeSettingsWatcher(); } catch {}
    }
    return { status: "error", message: `uninstallHooks: ${err && err.message}` };
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

function createRepairDoctorIssue({ repairAgentIntegration, setBubbleCategoryEnabled } = {}) {
  return async function repairDoctorIssue(payload, deps) {
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
  };
}

installHooks.lockKey = CLAUDE_HOOKS_LOCK_KEY;
uninstallHooks.lockKey = CLAUDE_HOOKS_LOCK_KEY;

module.exports = {
  autoStartWithClaude,
  createRepairDoctorIssue,
  installHooks,
  manageClaudeHooksAutomatically,
  openAtLogin,
  repairLocalServer,
  restartClawd,
  uninstallHooks,
};
