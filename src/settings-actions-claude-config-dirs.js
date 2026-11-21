"use strict";

// Settings → Agents → Claude Code → Config folders.
//
// Claude Code keeps each profile (settings, sessions, login) in the folder
// named by CLAUDE_CONFIG_DIR. Clawd always manages the folder it resolves
// itself; these commands add or remove extra folders, which receive the same
// hooks so sessions from every profile reach the one pet, and rename the
// label shown next to their sessions.
//
// While hook management is enabled, installs verify before prefs change through
// the server's Claude hook queue. Otherwise adding a folder only records it.

const {
  MAX_CLAUDE_CONFIG_DIRS,
  normalizeClaudeConfigDir,
  normalizeClaudeConfigDirEntries,
  normalizeClaudeConfigDirLabel,
  resolvePrimaryClaudeConfigDir,
  sameClaudeConfigDir,
} = require("../hooks/claude-config-dirs");

const CLAUDE_AGENT_ID = "claude-code";

function readEntries(snapshot) {
  const agents = snapshot && snapshot.agents;
  const claude = agents && agents[CLAUDE_AGENT_ID];
  return normalizeClaudeConfigDirEntries(claude && claude.configDirs);
}

function buildCommit(snapshot, configDirs) {
  const agents = (snapshot && snapshot.agents) || {};
  const claude = agents[CLAUDE_AGENT_ID] && typeof agents[CLAUDE_AGENT_ID] === "object"
    ? agents[CLAUDE_AGENT_ID]
    : {};
  return {
    agents: {
      ...agents,
      [CLAUDE_AGENT_ID]: { ...claude, configDirs },
    },
  };
}

// Hooks only go into folders while Clawd is managing Claude hooks at all.
function shouldWriteHooks(snapshot) {
  const claude = snapshot && snapshot.agents && snapshot.agents[CLAUDE_AGENT_ID];
  return !!(
    claude
    && claude.integrationInstalled !== false
    && claude.enabled !== false
    && snapshot.manageClaudeHooksAutomatically !== false
  );
}

function primaryDir(deps) {
  return typeof deps.primaryClaudeConfigDir === "string" && deps.primaryClaudeConfigDir
    ? deps.primaryClaudeConfigDir
    : resolvePrimaryClaudeConfigDir();
}

function isFailedResult(result) {
  return result === false
    || !!(result && typeof result === "object" && (result.status === "error" || result.status === "skipped"));
}

async function addClaudeConfigDir(payload, deps = {}) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "addClaudeConfigDir: payload must be an object" };
  }
  const dir = normalizeClaudeConfigDir(payload.dir);
  if (!dir) return { status: "error", message: "addClaudeConfigDir.dir must be an absolute folder path" };
  if (sameClaudeConfigDir(dir, primaryDir(deps))) {
    return { status: "error", reason: "primary", message: "Clawd already manages this folder" };
  }
  const snapshot = deps.snapshot || {};
  const entries = readEntries(snapshot);
  if (entries.some((entry) => sameClaudeConfigDir(entry.dir, dir))) return { status: "ok", noop: true };
  if (entries.length >= MAX_CLAUDE_CONFIG_DIRS) {
    return { status: "error", message: `At most ${MAX_CLAUDE_CONFIG_DIRS} Claude config folders can be added` };
  }
  const installed = shouldWriteHooks(snapshot);
  if (installed) {
    if (typeof deps.installClaudeConfigDir !== "function") {
      return { status: "error", message: "Claude config folder install is unavailable" };
    }
    let result;
    try {
      result = await deps.installClaudeConfigDir(dir);
    } catch (err) {
      return { status: "error", message: `Installing Claude hooks failed: ${err && err.message}` };
    }
    if (isFailedResult(result)) {
      return { status: "error", message: (result && (result.message || result.reason)) || "Installing Claude hooks failed" };
    }
  }
  const label = normalizeClaudeConfigDirLabel(payload.label);
  return { status: "ok", installed, commit: buildCommit(snapshot, [...entries, { dir, label }]) };
}

async function removeClaudeConfigDir(payload, deps = {}) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "removeClaudeConfigDir: payload must be an object" };
  }
  const dir = normalizeClaudeConfigDir(payload.dir);
  if (!dir) return { status: "error", message: "removeClaudeConfigDir.dir must be an absolute folder path" };
  if (sameClaudeConfigDir(dir, primaryDir(deps))) {
    return { status: "error", reason: "primary", message: "The primary Claude folder cannot be removed" };
  }
  const snapshot = deps.snapshot || {};
  const entries = readEntries(snapshot);
  const remaining = entries.filter((entry) => !sameClaudeConfigDir(entry.dir, dir));
  if (remaining.length === entries.length) return { status: "ok", noop: true };
  // Removal always takes Clawd's hooks back out, even while automatic
  // management is off: the folder is leaving Clawd's list either way.
  if (typeof deps.uninstallClaudeConfigDir === "function") {
    let result;
    try {
      result = await deps.uninstallClaudeConfigDir(dir);
    } catch (err) {
      return { status: "error", message: `Removing Claude hooks failed: ${err && err.message}` };
    }
    if (isFailedResult(result)) {
      return { status: "error", message: (result && (result.message || result.reason)) || "Removing Claude hooks failed" };
    }
  }
  return { status: "ok", commit: buildCommit(snapshot, remaining) };
}

function setClaudeConfigDirLabel(payload, deps = {}) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "setClaudeConfigDirLabel: payload must be an object" };
  }
  const dir = normalizeClaudeConfigDir(payload.dir);
  if (!dir) return { status: "error", message: "setClaudeConfigDirLabel.dir must be an absolute folder path" };
  if (typeof payload.label !== "string") {
    return { status: "error", message: "setClaudeConfigDirLabel.label must be a string" };
  }
  const label = normalizeClaudeConfigDirLabel(payload.label);
  const snapshot = deps.snapshot || {};
  const entries = readEntries(snapshot);
  const index = entries.findIndex((entry) => sameClaudeConfigDir(entry.dir, dir));
  if (index >= 0) {
    if (entries[index].label === label) return { status: "ok", noop: true };
    const next = entries.slice();
    next[index] = { ...next[index], label };
    return { status: "ok", commit: buildCommit(snapshot, next) };
  }
  // Only the primary folder may be named without being added: its entry
  // carries the label and never receives extra hooks.
  if (!sameClaudeConfigDir(dir, primaryDir(deps))) {
    return { status: "error", message: "Add the folder before naming it" };
  }
  if (!label) return { status: "ok", noop: true };
  if (entries.length >= MAX_CLAUDE_CONFIG_DIRS) {
    return { status: "error", message: `At most ${MAX_CLAUDE_CONFIG_DIRS} Claude config folders can be listed` };
  }
  return { status: "ok", commit: buildCommit(snapshot, [{ dir, label }, ...entries]) };
}

addClaudeConfigDir.lockKey = "agentIntegration";
removeClaudeConfigDir.lockKey = "agentIntegration";
setClaudeConfigDirLabel.lockKey = "agentIntegration";

module.exports = {
  addClaudeConfigDir,
  removeClaudeConfigDir,
  setClaudeConfigDirLabel,
};
