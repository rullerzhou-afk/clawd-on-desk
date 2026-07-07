"use strict";

const {
  AGENT_FLAGS,
  CODEX_PERMISSION_MODES,
} = require("./prefs");
const {
  getCodexPermissionMode,
  isAgentEnabled,
  isAgentIntegrationInstalled,
} = require("./agent-gate");
const {
  requireBoolean,
  requireString,
} = require("./settings-validators");

const AUTO_REPAIRABLE_AGENT_IDS = new Set([
  "claude-code",
  "codex",
  "copilot-cli",
  "cursor-agent",
  "gemini-cli",
  "antigravity-cli",
  "codebuddy",
  "kiro-cli",
  "kimi-cli",
  "qwen-code",
  "codewhale",
  "opencode",
  "hermes",
  "qoder",
  "reasonix",
  "qoderwork",
]);

const INSTALLABLE_AGENT_IDS = new Set([
  "claude-code",
  "codex",
  "copilot-cli",
  "cursor-agent",
  "gemini-cli",
  "antigravity-cli",
  "codebuddy",
  "kiro-cli",
  "kimi-cli",
  "qwen-code",
  "codewhale",
  "opencode",
  "pi",
  "openclaw",
  "hermes",
  "qoder",
  "reasonix",
  "qoderwork",
]);
const SETTABLE_AGENT_FLAGS = AGENT_FLAGS.filter((flag) => flag !== "integrationInstalled");

// setAgentFlag is atomic single-agent, single-flag toggle.
// Payload `{ agentId, flag, value }` where flag is in AGENT_FLAGS.
const _validateAgentFlagId = requireString("setAgentFlag.agentId");
const _validateAgentFlagValue = requireBoolean("setAgentFlag.value");
const _validateRepairAgentId = requireString("repairAgentIntegration.agentId");

function setAgentFlag(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "setAgentFlag: payload must be an object" };
  }
  const { agentId, flag, value } = payload;
  const idCheck = _validateAgentFlagId(agentId);
  if (idCheck.status !== "ok") return idCheck;
  if (typeof flag !== "string" || !SETTABLE_AGENT_FLAGS.includes(flag)) {
    return {
      status: "error",
      message: `setAgentFlag.flag must be one of: ${SETTABLE_AGENT_FLAGS.join(", ")}`,
    };
  }
  // #451: the subagent sub-gate is claude-code-scoped. normalizeAgents already
  // strips the flag for other agents on persist; reject here too so a direct
  // command-API call can't trigger the { subagentOnly } dismiss side effect
  // for agents whose dismissal path has agent-specific cleanup (e.g. Kimi's
  // permission-state disposal in agent-runtime-main.js).
  if (flag === "subagentPermissionsEnabled" && agentId !== "claude-code") {
    return {
      status: "error",
      message: "setAgentFlag.subagentPermissionsEnabled only supports claude-code",
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
        if (
          isAgentIntegrationInstalled(snapshot, agentId)
          && typeof deps.syncIntegrationForAgent === "function"
        ) {
          deps.syncIntegrationForAgent(agentId);
        }
        if (typeof deps.startMonitorForAgent === "function") deps.startMonitorForAgent(agentId);
      }
    } else if (flag === "permissionsEnabled") {
      if (!value && typeof deps.dismissPermissionsByAgent === "function") {
        deps.dismissPermissionsByAgent(agentId);
      }
    } else if (flag === "subagentPermissionsEnabled") {
      // #451: flipping the subagent sub-gate off dismisses only the pending
      // bubbles that came from a CC subagent; main-thread ones stay up.
      if (!value && typeof deps.dismissPermissionsByAgent === "function") {
        deps.dismissPermissionsByAgent(agentId, { subagentOnly: true });
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
const _validateInstallAgentId = requireString("installAgentIntegration.agentId");
const _validateUninstallAgentId = requireString("uninstallAgentIntegration.agentId");
const _validateDismissInstallHintId = requireString("dismissAgentInstallHints.agentId");
const _validateDismissCleanupHintId = requireString("dismissAgentCleanupHints.agentId");
const _validateClearCleanupHintId = requireString("clearAgentCleanupHints.agentId");

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

function normalizeAgentIntegrationPayload(payload, validateAgentId, actionName) {
  const agentId = typeof payload === "string" ? payload : payload && payload.agentId;
  const idCheck = validateAgentId(agentId);
  if (idCheck.status !== "ok") return idCheck;
  if (!INSTALLABLE_AGENT_IDS.has(agentId)) {
    return {
      status: "error",
      message: `No automatic integration ${actionName} is available for ${agentId}`,
    };
  }
  return {
    status: "ok",
    agentId,
    dismissInstallHint: !(payload && typeof payload === "object" && payload.dismissInstallHint === false),
  };
}

function resultMessage(result, fallback) {
  return result && typeof result === "object" && typeof result.message === "string" && result.message
    ? result.message
    : fallback;
}

function buildAgentCommit(snapshot, agentId, patch) {
  const currentAgents = (snapshot && snapshot.agents) || {};
  const currentEntry = currentAgents[agentId] && typeof currentAgents[agentId] === "object"
    ? currentAgents[agentId]
    : {};
  return {
    agents: {
      ...currentAgents,
      [agentId]: {
        ...currentEntry,
        ...patch,
      },
    },
  };
}

function withoutDismissedInstallHint(snapshot, agentId) {
  const current = snapshot && snapshot.dismissedAgentInstallHints;
  if (!current || typeof current !== "object" || Array.isArray(current)) return {};
  if (current[agentId] !== true) return current;
  const next = { ...current };
  delete next[agentId];
  return next;
}

function withDismissedInstallHint(snapshot, agentId) {
  const current = snapshot && snapshot.dismissedAgentInstallHints;
  return {
    ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}),
    [agentId]: true,
  };
}

function withoutDismissedCleanupHint(snapshot, agentId) {
  const current = snapshot && snapshot.dismissedAgentCleanupHints;
  if (!current || typeof current !== "object" || Array.isArray(current)) return {};
  if (current[agentId] !== true) return current;
  const next = { ...current };
  delete next[agentId];
  return next;
}

async function installAgentIntegration(payload, deps = {}) {
  const normalized = normalizeAgentIntegrationPayload(payload, _validateInstallAgentId, "install");
  if (normalized.status !== "ok") return normalized;
  const { agentId } = normalized;
  const snapshot = deps.snapshot || {};

  if (agentId === "claude-code" && snapshot.manageClaudeHooksAutomatically === false) {
    return {
      status: "error",
      message: "Claude hook management is disabled in Settings",
    };
  }
  if (!deps || typeof deps.syncIntegrationForAgent !== "function") {
    return { status: "error", message: "installAgentIntegration requires syncIntegrationForAgent dep" };
  }

  try {
    const result = await deps.syncIntegrationForAgent(agentId);
    if (result === false) {
      return { status: "error", message: `No automatic integration install is available for ${agentId}` };
    }
    if (result && typeof result === "object" && result.status === "skipped") {
      return {
        status: "skipped",
        reason: result.reason,
        message: resultMessage(result, `Skipped installing ${agentId}`),
      };
    }
    if (result && typeof result === "object" && result.status && result.status !== "ok") {
      return {
        status: "error",
        message: resultMessage(result, `Failed to install ${agentId}`),
      };
    }
    if (typeof deps.startMonitorForAgent === "function") deps.startMonitorForAgent(agentId);
    return {
      status: "ok",
      message: resultMessage(result, `Installed ${agentId}`),
      commit: {
        ...buildAgentCommit(snapshot, agentId, {
          integrationInstalled: true,
          enabled: true,
        }),
        dismissedAgentInstallHints: withoutDismissedInstallHint(snapshot, agentId),
        dismissedAgentCleanupHints: withoutDismissedCleanupHint(snapshot, agentId),
      },
    };
  } catch (err) {
    return {
      status: "error",
      message: `installAgentIntegration: ${err && err.message}`,
    };
  }
}

async function uninstallAgentIntegration(payload, deps = {}) {
  const normalized = normalizeAgentIntegrationPayload(payload, _validateUninstallAgentId, "uninstall");
  if (normalized.status !== "ok") return normalized;
  const { agentId, dismissInstallHint } = normalized;
  const snapshot = deps.snapshot || {};
  if (!deps || typeof deps.uninstallIntegrationForAgent !== "function") {
    return { status: "error", message: "uninstallAgentIntegration requires uninstallIntegrationForAgent dep" };
  }

  try {
    const result = await deps.uninstallIntegrationForAgent(agentId);
    if (result === false) {
      return { status: "error", message: `No automatic integration uninstall is available for ${agentId}` };
    }
    if (result && typeof result === "object" && result.status === "error") {
      return {
        status: "error",
        message: resultMessage(result, `Failed to uninstall ${agentId}`),
      };
    }
    if (typeof deps.stopMonitorForAgent === "function") deps.stopMonitorForAgent(agentId);
    if (typeof deps.clearSessionsByAgent === "function") deps.clearSessionsByAgent(agentId);
    if (typeof deps.dismissPermissionsByAgent === "function") deps.dismissPermissionsByAgent(agentId);
    return {
      status: "ok",
      message: resultMessage(result, `Uninstalled ${agentId}`),
      commit: {
        ...buildAgentCommit(snapshot, agentId, {
          integrationInstalled: false,
          enabled: false,
        }),
        dismissedAgentInstallHints: dismissInstallHint
          ? withDismissedInstallHint(snapshot, agentId)
          : withoutDismissedInstallHint(snapshot, agentId),
        dismissedAgentCleanupHints: withoutDismissedCleanupHint(snapshot, agentId),
      },
    };
  } catch (err) {
    return {
      status: "error",
      message: `uninstallAgentIntegration: ${err && err.message}`,
    };
  }
}

async function repairAgentIntegration(payload, deps) {
  const agentId = typeof payload === "string" ? payload : payload && payload.agentId;
  const idCheck = _validateRepairAgentId(agentId);
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
      message: `No automatic integration repair is available for ${agentId}`,
    };
  }

  const snapshot = deps && deps.snapshot;
  if (!isAgentIntegrationInstalled(snapshot, agentId)) {
    return {
      status: "error",
      message: `${agentId} integration is not installed in Settings; install it before repairing`,
    };
  }
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

function normalizeDismissAgentHintPayload(payload, validateAgentId, commandName) {
  const raw = Array.isArray(payload && payload.agentIds)
    ? payload.agentIds
    : [typeof payload === "string" ? payload : payload && payload.agentId].filter(Boolean);
  const agentIds = [];
  for (const value of raw) {
    const idCheck = validateAgentId(value);
    if (idCheck.status !== "ok") return idCheck;
    if (!INSTALLABLE_AGENT_IDS.has(value)) {
      return {
        status: "error",
        message: `No automatic integration dismiss is available for ${value}`,
      };
    }
    if (!agentIds.includes(value)) agentIds.push(value);
  }
  if (agentIds.length === 0) {
    return { status: "error", message: `${commandName}.agentIds must include at least one agent` };
  }
  return { status: "ok", agentIds };
}

function dismissAgentInstallHints(payload, deps = {}) {
  const normalized = normalizeDismissAgentHintPayload(payload, _validateDismissInstallHintId, "dismissAgentInstallHints");
  if (normalized.status !== "ok") return normalized;
  const snapshot = deps.snapshot || {};
  const current = snapshot.dismissedAgentInstallHints;
  const next = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
  let changed = false;
  for (const agentId of normalized.agentIds) {
    if (next[agentId] === true) continue;
    next[agentId] = true;
    changed = true;
  }
  if (!changed) return { status: "ok", noop: true };
  return { status: "ok", commit: { dismissedAgentInstallHints: next } };
}

function dismissAgentCleanupHints(payload, deps = {}) {
  const normalized = normalizeDismissAgentHintPayload(payload, _validateDismissCleanupHintId, "dismissAgentCleanupHints");
  if (normalized.status !== "ok") return normalized;
  const snapshot = deps.snapshot || {};
  const current = snapshot.dismissedAgentCleanupHints;
  const next = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
  let changed = false;
  for (const agentId of normalized.agentIds) {
    if (next[agentId] === true) continue;
    next[agentId] = true;
    changed = true;
  }
  if (!changed) return { status: "ok", noop: true };
  return { status: "ok", commit: { dismissedAgentCleanupHints: next } };
}

function clearAgentCleanupHints(payload, deps = {}) {
  const normalized = normalizeDismissAgentHintPayload(payload, _validateClearCleanupHintId, "clearAgentCleanupHints");
  if (normalized.status !== "ok") return normalized;
  const snapshot = deps.snapshot || {};
  const current = snapshot.dismissedAgentCleanupHints;
  const next = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
  let changed = false;
  for (const agentId of normalized.agentIds) {
    if (next[agentId] !== true) continue;
    delete next[agentId];
    changed = true;
  }
  if (!changed) return { status: "ok", noop: true };
  return { status: "ok", commit: { dismissedAgentCleanupHints: next } };
}

function clearAgentInstallHints(payload, deps = {}) {
  const normalized = normalizeDismissAgentHintPayload(payload, _validateDismissInstallHintId, "clearAgentInstallHints");
  if (normalized.status !== "ok") return normalized;
  const snapshot = deps.snapshot || {};
  const current = snapshot.dismissedAgentInstallHints;
  const next = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
  let changed = false;
  for (const agentId of normalized.agentIds) {
    if (next[agentId] !== true) continue;
    delete next[agentId];
    changed = true;
  }
  if (!changed) return { status: "ok", noop: true };
  return { status: "ok", commit: { dismissedAgentInstallHints: next } };
}

setAgentFlag.lockKey = "agentIntegration";
setAgentPermissionMode.lockKey = "agentIntegration";
installAgentIntegration.lockKey = "agentIntegration";
uninstallAgentIntegration.lockKey = "agentIntegration";
repairAgentIntegration.lockKey = "agentIntegration";
dismissAgentInstallHints.lockKey = "agentIntegration";
dismissAgentCleanupHints.lockKey = "agentIntegration";
clearAgentCleanupHints.lockKey = "agentIntegration";
clearAgentInstallHints.lockKey = "agentIntegration";

// ── WSL deploy / remove ──────────────────────────────────────────────

const _validateWslDeployDistro = requireString("deployToWsl.distro");

async function _wslCommand(payload, deps, { commandName, depName, action }) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: `${commandName}: payload must be an object` };
  }
  const distroCheck = _validateWslDeployDistro(payload.distro);
  if (distroCheck.status !== "ok") return distroCheck;
  const distro = payload.distro;
  const agentId = typeof payload.agentId === "string" ? payload.agentId : undefined;

  if (!deps || typeof deps[depName] !== "function") {
    return { status: "error", message: `${commandName}: ${depName} dep not available (Windows only)` };
  }

  try {
    const result = await deps[depName](distro, agentId);
    if (result && result.ok) {
      const okResult = { status: "ok", message: `${action} WSL ${distro}` };
      // deploy-only: false = hooks installed but Clawd is unreachable from
      // the distro (NAT networking) — renderer shows a localized warning.
      if (result.connectivity === false) okResult.wslConnectivity = false;
      return okResult;
    }
    return {
      status: "error",
      message: (result && result.message) || `WSL ${commandName} failed for ${distro}`,
    };
  } catch (err) {
    return { status: "error", message: `${commandName}: ${err && err.message}` };
  }
}

async function deployToWsl(payload, deps = {}) {
  return _wslCommand(payload, deps, {
    commandName: "deployToWsl",
    depName: "deployHooksToWsl",
    action: "Deployed to",
  });
}

async function removeFromWsl(payload, deps = {}) {
  return _wslCommand(payload, deps, {
    commandName: "removeFromWsl",
    depName: "removeHooksFromWsl",
    action: "Removed from",
  });
}

deployToWsl.lockKey = "agentIntegration";
removeFromWsl.lockKey = "agentIntegration";

module.exports = {
  INSTALLABLE_AGENT_IDS,
  clearAgentCleanupHints,
  clearAgentInstallHints,
  deployToWsl,
  dismissAgentCleanupHints,
  dismissAgentInstallHints,
  installAgentIntegration,
  removeFromWsl,
  setAgentFlag,
  setAgentPermissionMode,
  uninstallAgentIntegration,
  repairAgentIntegration,
};
