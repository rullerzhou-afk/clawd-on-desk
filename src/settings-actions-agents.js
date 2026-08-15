"use strict";

const {
  AGENT_FLAGS,
  CODEX_PERMISSION_MODES,
  MAX_CUSTOM_DISCOVERY_PATH_LENGTH,
  MAX_CUSTOM_DISCOVERY_PATHS,
  normalizeOptionalHttpUrl,
  normalizePathList,
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
const { getAgent } = require("../agents/registry");
const {
  MAX_CUSTOM_APPLICATIONS,
  identifyCustomApplication: defaultIdentifyCustomApplication,
  isCustomApplicationId,
  isCustomApplicationNamespace,
  normalizeCustomApplications,
} = require("./custom-applications");

const AUTO_REPAIRABLE_AGENT_IDS = new Set([
  "claude-code",
  "codex",
  "deepseek-harness",
  "copilot-cli",
  "cursor-agent",
  "gemini-cli",
  "antigravity-cli",
  "codebuddy",
  "workbuddy",
  "kiro-cli",
  "kimi-cli",
  "qwen-code",
  "zcode",
  "codewhale",
  "opencode",
  "mimocode",
  "hermes",
  "qoder",
  "reasonix",
  "qoderwork",
  "traecode",
  "qwenwork",
]);

const INSTALLABLE_AGENT_IDS = new Set([
  "claude-code",
  "codex",
  "deepseek-harness",
  "copilot-cli",
  "cursor-agent",
  "gemini-cli",
  "antigravity-cli",
  "codebuddy",
  "workbuddy",
  "kiro-cli",
  "kimi-cli",
  "qwen-code",
  "zcode",
  "codewhale",
  "opencode",
  "mimocode",
  "pi",
  "openclaw",
  "hermes",
  "qoder",
  "reasonix",
  "qoderwork",
  "traecode",
  "qwenwork",
]);
const SETTABLE_AGENT_FLAGS = AGENT_FLAGS.filter((flag) => flag !== "integrationInstalled");
const CUSTOM_DISCOVERY_AGENT_IDS = new Set([...INSTALLABLE_AGENT_IDS, "custom"]);

// setAgentFlag is atomic single-agent, single-flag toggle.
// Payload `{ agentId, flag, value }` where flag is in AGENT_FLAGS.
const _validateAgentFlagId = requireString("setAgentFlag.agentId");
const _validateAgentFlagValue = requireBoolean("setAgentFlag.value");
const _validateRepairAgentId = requireString("repairAgentIntegration.agentId");

function disableCodexAutoStartGate(agentId, deps, actionName) {
  if (agentId !== "codex") return null;
  if (!deps || typeof deps.writeCodexAutoStartGate !== "function") {
    return { status: "error", message: `${actionName}: writeCodexAutoStartGate is required` };
  }
  try {
    if (deps.writeCodexAutoStartGate(false) !== true) {
      return { status: "error", message: `${actionName}: failed to persist Codex auto-start gate` };
    }
  } catch (err) {
    return {
      status: "error",
      message: `${actionName}: failed to persist Codex auto-start gate: ${err && err.message}`,
    };
  }
  return null;
}

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
  if (flag === "permissionsEnabled" && isCustomApplicationNamespace(agentId)) {
    return {
      status: "error",
      message: "setAgentFlag.permissionsEnabled is not supported for custom state-only agents",
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

  const nextEntry = { ...(currentEntry || {}), [flag]: value };
  const nextAgents = { ...currentAgents, [agentId]: nextEntry };
  const commitResult = { status: "ok", commit: { agents: nextAgents } };
  if (agentId === "codex" && flag === "enabled" && value === false) {
    const gateError = disableCodexAutoStartGate(agentId, deps, "setAgentFlag");
    if (gateError) return gateError;
  }

  // Claude Code enable is the one branch with an awaited external mutation:
  // hooks must actually land (via the server-owned operation queue, #657)
  // before the UI reports "enabled", so prefs are never committed ahead of
  // reality. Every other agent/flag combination stays synchronous below —
  // deliberately not making setAgentFlag() unconditionally async, to avoid
  // forcing every caller/test to await a Promise it doesn't otherwise need.
  if (
    flag === "enabled"
    && value === true
    && agentId === "claude-code"
    && isAgentIntegrationInstalled(snapshot, agentId)
    && typeof deps.syncIntegrationForAgent === "function"
  ) {
    return Promise.resolve()
      .then(() => deps.syncIntegrationForAgent(agentId, { source: "settings-agent-enable", automatic: false }))
      .then((result) => {
        if (result === false) {
          return { status: "error", message: `No automatic integration install is available for ${agentId}` };
        }
        if (result && typeof result === "object" && result.status === "error") {
          return { status: "error", message: result.message || `Failed to enable ${agentId}` };
        }
        if (typeof deps.startMonitorForAgent === "function") deps.startMonitorForAgent(agentId);
        return commitResult;
      })
      .catch((err) => ({ status: "error", message: `setAgentFlag: ${err && err.message}` }));
  }

  try {
    if (flag === "enabled") {
      if (!value) {
        if (agentId === "claude-code" && typeof deps.stopIntegrationForAgent === "function") {
          deps.stopIntegrationForAgent(agentId);
        }
        if (typeof deps.stopMonitorForAgent === "function") deps.stopMonitorForAgent(agentId);
        if (typeof deps.clearSessionAutomationByAgent === "function") {
          deps.clearSessionAutomationByAgent(agentId);
        }
        if (typeof deps.clearSessionsByAgent === "function") deps.clearSessionsByAgent(agentId);
        if (typeof deps.dismissPermissionsByAgent === "function") deps.dismissPermissionsByAgent(agentId);
      } else {
        if (
          isAgentIntegrationInstalled(snapshot, agentId)
          && typeof deps.syncIntegrationForAgent === "function"
        ) {
          deps.syncIntegrationForAgent(agentId, buildAgentIntegrationOptions(snapshot, agentId));
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

  return commitResult;
}

const _validateAgentPermissionModeId = requireString("setAgentPermissionMode.agentId");
const _validateInstallAgentId = requireString("installAgentIntegration.agentId");
const _validateUninstallAgentId = requireString("uninstallAgentIntegration.agentId");
const _validateDismissInstallHintId = requireString("dismissAgentInstallHints.agentId");
const _validateDismissCleanupHintId = requireString("dismissAgentCleanupHints.agentId");
const _validateClearCleanupHintId = requireString("clearAgentCleanupHints.agentId");
const _validateCustomPermissionUrlAgentId = requireString("setAgentCustomPermissionUrl.agentId");
const _validateCustomDiscoveryPathsAgentId = requireString("setAgentCustomDiscoveryPaths.agentId");

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
  const base = result && typeof result === "object" && typeof result.message === "string" && result.message
    ? result.message
    : fallback;
  const manualCommand = result && typeof result === "object" && typeof result.manualCommand === "string"
    ? result.manualCommand.trim()
    : "";
  return manualCommand && !base.includes(manualCommand) ? `${base}\n${manualCommand}` : base;
}

function integrationResultMetadata(result) {
  if (!result || typeof result !== "object") return {};
  const metadata = {};
  for (const key of ["reason", "manualCommand", "supportedRange", "detectedVersion", "healthReason"]) {
    if (typeof result[key] === "string" && result[key]) metadata[key] = result[key];
  }
  if (result.manualInspectionRequired === true) metadata.manualInspectionRequired = true;
  return metadata;
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

function buildAgentIntegrationOptions(snapshot, agentId) {
  const entry = snapshot && snapshot.agents && snapshot.agents[agentId];
  if (!entry || typeof entry !== "object") return {};
  const options = {};
  if (agentSupportsCustomPermissionUrl(agentId)) {
    const customPermissionUrl = normalizeOptionalHttpUrl(entry.customPermissionUrl);
    options.permissionTarget = customPermissionUrl
      ? { mode: "custom", url: customPermissionUrl }
      : { mode: "local" };
  }
  return options;
}

function agentSupportsCustomPermissionUrl(agentId) {
  const agent = getAgent(agentId);
  return !!(
    agent
    && agent.capabilities
    && agent.capabilities.httpHook
    && agent.capabilities.customPermissionUrl
  );
}

function buildAgentIntegrationOptionsWithPatch(snapshot, agentId, patch) {
  const currentAgents = (snapshot && snapshot.agents) || {};
  const currentEntry = currentAgents[agentId] && typeof currentAgents[agentId] === "object"
    ? currentAgents[agentId]
    : {};
  return buildAgentIntegrationOptions({
    ...snapshot,
    agents: {
      ...currentAgents,
      [agentId]: {
        ...currentEntry,
        ...patch,
      },
    },
  }, agentId);
}

function setAgentCustomPermissionUrl(payload, deps = {}) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "setAgentCustomPermissionUrl: payload must be an object" };
  }
  const idCheck = _validateCustomPermissionUrlAgentId(payload.agentId);
  if (idCheck.status !== "ok") return idCheck;
  if (!agentSupportsCustomPermissionUrl(payload.agentId)) {
    return {
      status: "error",
      message: `setAgentCustomPermissionUrl does not support ${payload.agentId}`,
    };
  }
  if (typeof payload.value !== "string") {
    return { status: "error", message: "setAgentCustomPermissionUrl.value must be a string" };
  }
  const value = normalizeOptionalHttpUrl(payload.value);
  if (payload.value.trim() && !value) {
    return { status: "error", message: "setAgentCustomPermissionUrl.value must be an http(s) URL" };
  }
  const snapshot = deps.snapshot || {};
  const current = snapshot.agents && snapshot.agents[payload.agentId];
  const currentValue = normalizeOptionalHttpUrl(current && current.customPermissionUrl);
  if (currentValue === value) return { status: "ok", noop: true };
  try {
    if (
      isAgentIntegrationInstalled(snapshot, payload.agentId)
      && typeof deps.syncIntegrationForAgent === "function"
    ) {
      deps.syncIntegrationForAgent(
        payload.agentId,
        buildAgentIntegrationOptionsWithPatch(snapshot, payload.agentId, { customPermissionUrl: value })
      );
    }
  } catch (err) {
    return {
      status: "error",
      message: `setAgentCustomPermissionUrl side effect threw: ${err && err.message}`,
    };
  }
  return {
    status: "ok",
    commit: buildAgentCommit(snapshot, payload.agentId, { customPermissionUrl: value }),
  };
}

function setAgentCustomDiscoveryPaths(payload, deps = {}) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "setAgentCustomDiscoveryPaths: payload must be an object" };
  }
  const idCheck = _validateCustomDiscoveryPathsAgentId(payload.agentId);
  if (idCheck.status !== "ok") return idCheck;
  if (!CUSTOM_DISCOVERY_AGENT_IDS.has(payload.agentId)) {
    return {
      status: "error",
      message: `setAgentCustomDiscoveryPaths does not support ${payload.agentId}`,
    };
  }
  const rawPaths = Array.isArray(payload.value)
    ? payload.value
    : (typeof payload.value === "string" ? payload.value.split(/[;\n]/g) : []);
  if (rawPaths.some((entry) => typeof entry !== "string")) {
    return { status: "error", message: "setAgentCustomDiscoveryPaths.value must contain only strings" };
  }
  if (rawPaths.some((entry) => entry.replace(/\0/g, "").trim().length > MAX_CUSTOM_DISCOVERY_PATH_LENGTH)) {
    return {
      status: "error",
      message: `Discovery paths must be at most ${MAX_CUSTOM_DISCOVERY_PATH_LENGTH} characters`,
    };
  }
  const paths = normalizePathList(payload.value, { maxEntries: MAX_CUSTOM_DISCOVERY_PATHS + 1 });
  if (paths.length > MAX_CUSTOM_DISCOVERY_PATHS) {
    return { status: "error", message: `Discovery path limit reached (${MAX_CUSTOM_DISCOVERY_PATHS})` };
  }
  const snapshot = deps.snapshot || {};
  const current = snapshot.agents && snapshot.agents[payload.agentId];
  const currentPaths = payload.agentId === "custom"
    ? normalizePathList(snapshot.customToolDiscoveryPaths)
    : normalizePathList(current && current.customDiscoveryPaths);
  if (paths.length === currentPaths.length && paths.every((value, index) => value === currentPaths[index])) {
    return { status: "ok", noop: true };
  }
  return payload.agentId === "custom"
    ? { status: "ok", commit: { customToolDiscoveryPaths: paths } }
    : {
      status: "ok",
      commit: buildAgentCommit(snapshot, payload.agentId, { customDiscoveryPaths: paths }),
    };
}

function addCustomApplication(payload, deps = {}) {
  if (!payload || typeof payload !== "object" || typeof payload.path !== "string") {
    return { status: "error", message: "addCustomApplication requires a path" };
  }
  const identify = deps.identifyCustomApplication || defaultIdentifyCustomApplication;
  const application = normalizeCustomApplications([identify(payload.path)])[0] || null;
  if (!application) {
    return { status: "error", message: "No launchable application was found at this path" };
  }
  const responseApplication = { ...application, managedIntegration: false, permissionApproval: false };
  const snapshot = deps.snapshot || {};
  const current = Array.isArray(snapshot.customApplications) ? snapshot.customApplications : [];
  if (current.some((entry) => entry && entry.id === application.id)) {
    return { status: "ok", noop: true, application: responseApplication };
  }
  if (current.length >= MAX_CUSTOM_APPLICATIONS) {
    return { status: "error", message: `Custom AI limit reached (${MAX_CUSTOM_APPLICATIONS})` };
  }
  const agents = snapshot.agents && typeof snapshot.agents === "object" ? snapshot.agents : {};
  return {
    status: "ok",
    application: responseApplication,
    commit: {
      customApplications: [...current, application],
      agents: {
        ...agents,
        [application.id]: {
          integrationInstalled: false,
          enabled: true,
          permissionsEnabled: false,
          notificationHookEnabled: true,
        },
      },
    },
  };
}

function removeCustomApplication(payload, deps = {}) {
  const id = payload && typeof payload.id === "string" ? payload.id.trim() : "";
  if (!isCustomApplicationId(id)) {
    return { status: "error", message: "removeCustomApplication requires a valid custom agent id" };
  }
  const snapshot = deps.snapshot || {};
  const current = Array.isArray(snapshot.customApplications) ? snapshot.customApplications : [];
  if (!current.some((entry) => entry && entry.id === id)) return { status: "ok", noop: true };
  if (typeof deps.clearSessionAutomationByAgent === "function") {
    deps.clearSessionAutomationByAgent(id);
  }
  if (typeof deps.clearSessionsByAgent === "function") deps.clearSessionsByAgent(id);
  if (typeof deps.dismissPermissionsByAgent === "function") deps.dismissPermissionsByAgent(id);
  if (typeof deps.clearRecentHookEvents === "function") deps.clearRecentHookEvents(id);
  const agents = snapshot.agents && typeof snapshot.agents === "object" ? { ...snapshot.agents } : {};
  delete agents[id];
  return {
    status: "ok",
    commit: {
      customApplications: current.filter((entry) => entry && entry.id !== id),
      agents,
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
    const result = await deps.syncIntegrationForAgent(agentId, {
      ...buildAgentIntegrationOptions(snapshot, agentId),
      source: "settings-agent-install",
      automatic: false,
    });
    if (result === false) {
      return { status: "error", message: `No automatic integration install is available for ${agentId}` };
    }
    if (result && typeof result === "object" && result.status === "skipped") {
      return {
        status: "skipped",
        ...integrationResultMetadata(result),
        message: resultMessage(result, `Skipped installing ${agentId}`),
      };
    }
    if (result && typeof result === "object" && result.status && result.status !== "ok") {
      return {
        status: "error",
        ...integrationResultMetadata(result),
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
  const gateError = disableCodexAutoStartGate(agentId, deps, "uninstallAgentIntegration");
  if (gateError) return gateError;

  try {
    const result = await deps.uninstallIntegrationForAgent(agentId);
    if (result === false) {
      return { status: "error", message: `No automatic integration uninstall is available for ${agentId}` };
    }
    if (result && typeof result === "object" && result.status === "error") {
      return {
        status: "error",
        ...integrationResultMetadata(result),
        message: resultMessage(result, `Failed to uninstall ${agentId}`),
      };
    }
    if (typeof deps.stopMonitorForAgent === "function") deps.stopMonitorForAgent(agentId);
    if (typeof deps.clearSessionAutomationByAgent === "function") {
      deps.clearSessionAutomationByAgent(agentId);
    }
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
      ...buildAgentIntegrationOptions(snapshot, agentId),
      forceCodexHooksFeature: agentId === "codex" && forceCodexHooksFeature,
    });
    if (result === false) {
      return { status: "error", message: `No automatic integration repair is available for ${agentId}` };
    }
    if (result && typeof result === "object" && result.status && result.status !== "ok") {
      return {
        status: "error",
        ...integrationResultMetadata(result),
        message: resultMessage(result, `Failed to repair ${agentId}`),
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
setAgentCustomPermissionUrl.lockKey = "agentIntegration";
setAgentCustomDiscoveryPaths.lockKey = "agentIntegration";
addCustomApplication.lockKey = "agentIntegration";
removeCustomApplication.lockKey = "agentIntegration";
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
      const okResult = {
        status: "ok",
        message: (typeof result.message === "string" && result.message) || `${action} WSL ${distro}`,
      };
      // deploy-only: false = hooks installed but Clawd is unreachable from
      // the distro (NAT networking) — renderer shows a localized warning.
      if (result.connectivity === false) okResult.wslConnectivity = false;
      if (typeof result.warning === "string" && result.warning) okResult.warning = result.warning;
      if (commandName === "deployToWsl" && agentId === "hermes") {
        // WSL pairing opens the shared ingress gate but is not a Windows-local
        // integration install. Preserve integrationInstalled and every sibling
        // flag so startup cannot auto-sync Hermes onto the host by accident.
        okResult.commit = buildAgentCommit(deps.snapshot || {}, agentId, { enabled: true });
      }
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
  AUTO_REPAIRABLE_AGENT_IDS,
  INSTALLABLE_AGENT_IDS,
  addCustomApplication,
  clearAgentCleanupHints,
  clearAgentInstallHints,
  deployToWsl,
  dismissAgentCleanupHints,
  dismissAgentInstallHints,
  installAgentIntegration,
  removeCustomApplication,
  removeFromWsl,
  setAgentCustomDiscoveryPaths,
  setAgentFlag,
  setAgentCustomPermissionUrl,
  setAgentPermissionMode,
  uninstallAgentIntegration,
  repairAgentIntegration,
};
