"use strict";

// Pure gate helpers over a prefs snapshot. Most gates default true for missing
// snapshot / entry / flag so an install that predates a flag still runs.

function readFlag(snapshot, agentId, flag, defaultValue = true) {
  if (!agentId) return defaultValue;
  if (!snapshot || typeof snapshot !== "object") return defaultValue;
  const agents = snapshot.agents;
  if (!agents || typeof agents !== "object") return defaultValue;
  const entry = agents[agentId];
  if (!entry || typeof entry !== "object") return defaultValue;
  if (typeof entry[flag] !== "boolean") return defaultValue;
  return entry[flag];
}

const isAgentEnabled = (snapshot, agentId) => readFlag(snapshot, agentId, "enabled");
// Missing `integrationInstalled` defaults true only for legacy/un-normalized
// snapshots. Normal prefs snapshots carry an explicit v11 value for every
// registered agent, so fresh installs still follow prefs defaults.
const isAgentIntegrationInstalled = (snapshot, agentId) => (
  readFlag(snapshot, agentId, "integrationInstalled", true)
);
const shouldSyncAgentIntegration = (snapshot, agentId) => (
  isAgentEnabled(snapshot, agentId) && isAgentIntegrationInstalled(snapshot, agentId)
);
// Unlike legacy per-agent flags, Codex cold-launch is an explicit opt-in for
// fresh installs. It also requires the local integration to be both installed
// and enabled; WSL/remote exclusion is enforced inside codex-hook.js.
const isCodexAutoStartEnabled = (snapshot) => {
  if (!snapshot || typeof snapshot !== "object" || snapshot.autoStartWithCodex !== true) {
    return false;
  }
  const agents = snapshot.agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return false;
  const codex = agents.codex;
  if (!codex || typeof codex !== "object" || Array.isArray(codex)) return false;
  return codex.integrationInstalled === true && codex.enabled === true;
};

// Capture startup authority once. A normalized fallback snapshot can look
// valid after malformed prefs have been repaired in memory, so authority lost
// during the initial load must stay lost for this process and recover only
// after a clean restart.
function createCodexAutoStartGateEvaluator({ authorityLost = false } = {}) {
  const canEnable = authorityLost !== true;
  return (snapshot) => canEnable && isCodexAutoStartEnabled(snapshot);
}
const isAgentPermissionsEnabled = (snapshot, agentId) => readFlag(snapshot, agentId, "permissionsEnabled");
// #451 sub-gate under permissionsEnabled: bubbles for PermissionRequests that
// fire from inside a Claude Code subagent (Task tool). Only claude-code's
// prefs entry carries the flag; other agents read default-true and are
// unaffected.
const isAgentSubagentPermissionsEnabled = (snapshot, agentId) => readFlag(snapshot, agentId, "subagentPermissionsEnabled");
const isAgentNotificationHookEnabled = (snapshot, agentId) => readFlag(snapshot, agentId, "notificationHookEnabled");
const isCodexNativeNotificationSoundEnabled = (snapshot) =>
  readFlag(snapshot, "codex", "nativeNotificationSoundEnabled", false);
function getCodexPermissionMode(snapshot) {
  const entry = snapshot && snapshot.agents && snapshot.agents.codex;
  if (entry && entry.permissionMode === "native") return "native";
  return "intercept";
}
const isCodexPermissionInterceptEnabled = (snapshot) => getCodexPermissionMode(snapshot) === "intercept";

// Runtime reader over the live Settings controller snapshot. The pure helpers
// above deliberately fail open for missing legacy fields; that is correct only
// when the snapshot came from readable prefs. An unreadable prefs file instead
// supplies an in-memory defaults fallback, so every prefs-backed runtime gate
// must fail closed until restart rather than treating those defaults as user
// intent.
function createRuntimeAgentGate({ getSnapshot, isAuthoritative = () => true } = {}) {
  if (typeof getSnapshot !== "function") {
    throw new TypeError("createRuntimeAgentGate requires getSnapshot");
  }

  function canUseSnapshot() {
    try {
      return isAuthoritative() !== false;
    } catch {
      return false;
    }
  }

  function withSnapshot(read) {
    if (!canUseSnapshot()) return false;
    try {
      return read(getSnapshot());
    } catch {
      return false;
    }
  }

  return Object.freeze({
    isAuthoritative: canUseSnapshot,
    isAgentEnabled(agentId) {
      return withSnapshot((current) => isAgentEnabled(current, agentId));
    },
    isAgentIntegrationInstalled(agentId) {
      return withSnapshot((current) => isAgentIntegrationInstalled(current, agentId));
    },
    shouldSyncAgentIntegration(agentId) {
      return withSnapshot((current) => shouldSyncAgentIntegration(current, agentId));
    },
    isAgentPermissionsEnabled(agentId) {
      return withSnapshot((current) => isAgentPermissionsEnabled(current, agentId));
    },
    isAgentSubagentPermissionsEnabled(agentId) {
      return withSnapshot((current) => isAgentSubagentPermissionsEnabled(current, agentId));
    },
    isAgentNotificationHookEnabled(agentId) {
      return withSnapshot((current) => isAgentNotificationHookEnabled(current, agentId));
    },
    isCodexNativeNotificationSoundEnabled() {
      return withSnapshot((current) => isCodexNativeNotificationSoundEnabled(current));
    },
    isCodexPermissionInterceptEnabled() {
      return withSnapshot((current) => isCodexPermissionInterceptEnabled(current));
    },
    hasAnyEnabledAgent() {
      return withSnapshot((current) => {
        const agents = current && current.agents;
        if (!agents || typeof agents !== "object") return true;
        const probe = { agents };
        return Object.keys(agents).some((agentId) => isAgentEnabled(probe, agentId));
      });
    },
  });
}

module.exports = {
  createCodexAutoStartGateEvaluator,
  createRuntimeAgentGate,
  getCodexPermissionMode,
  isAgentIntegrationInstalled,
  isAgentEnabled,
  isAgentPermissionsEnabled,
  isAgentSubagentPermissionsEnabled,
  isAgentNotificationHookEnabled,
  isCodexNativeNotificationSoundEnabled,
  isCodexAutoStartEnabled,
  isCodexPermissionInterceptEnabled,
  shouldSyncAgentIntegration,
};
