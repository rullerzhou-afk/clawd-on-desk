"use strict";

const { getAllAgents } = require("../agents/registry");
const {
  isCustomApplicationId,
  isCustomApplicationNamespace,
} = require("./custom-applications");

const DEFAULT_HOOK_AGENT_ID = "claude-code";
const MAX_REJECTED_AGENT_ID_LENGTH = 80;
const MAX_SUBAGENT_ID_LENGTH = 256;
const MAX_SUBAGENT_TYPE_LENGTH = 128;

// Hook scripts / plugins stamp their own registry id into `agent_id`
// (codebuddy-hook.js, hermes plugin, codex-hook.js, ...). Claude Code ≥ 2.1.x
// reuses the same field name in its common hook input for something else: a
// per-instance subagent uuid, present only when the hook fired from inside a
// Task subagent (absent on the main thread, even in --agent sessions). Only
// ids registered in agents/registry.js are agent identities — anything else
// is a CC subagent marker and must not leak into per-agent gates, permEntry
// stamps, or session labels (#451).
const KNOWN_HOOK_AGENT_IDS = new Set(getAllAgents().map((agent) => agent.id));

const HOOK_SOURCE_AGENT_IDS = new Map([
  ["antigravity-hook", "antigravity-cli"],
  ["codex-official", "codex"],
  ["copilot-hook", "copilot-cli"],
  ["opencode-plugin", "opencode"],
  ["opencode-plugin-v2", "opencode"], // opencode 2.x `plugins`-key runtime (issue #1039)
  ["mimocode-plugin", "mimocode"],
  ["openclaw-plugin", "openclaw"],
  ["codewhale-hook", "codewhale"],
  ["pi-extension", "pi"],
  ["omp-extension", "omp"],
]);

function normalizeHookText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSubagentMetadata(value, maxLength) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > maxLength || /[\0\r\n]/.test(text)) return null;
  return text;
}

function resolveHookAgentId(data, options = {}) {
  const explicit = normalizeHookText(data && data.agent_id);
  if (explicit && KNOWN_HOOK_AGENT_IDS.has(explicit)) {
    return { agentId: explicit, source: "explicit", defaulted: false };
  }
  const customAgentIds = options.customAgentIds instanceof Set
    ? options.customAgentIds
    : new Set(Array.isArray(options.customAgentIds) ? options.customAgentIds : []);
  if (isCustomApplicationId(explicit) && customAgentIds.has(explicit)) {
    return { agentId: explicit, source: "custom", defaulted: false };
  }
  if (isCustomApplicationNamespace(explicit)) {
    return {
      agentId: null,
      source: "rejected-custom",
      rejected: true,
      rawAgentId: explicit.slice(0, MAX_REJECTED_AGENT_ID_LENGTH),
    };
  }

  const hookSource = normalizeHookText(data && data.hook_source);
  const sourceAgentId = HOOK_SOURCE_AGENT_IDS.get(hookSource);
  if (sourceAgentId) {
    return { agentId: sourceAgentId, source: "hook-source", defaulted: false };
  }

  if (explicit) {
    const subagentId = normalizeSubagentMetadata(explicit, MAX_SUBAGENT_ID_LENGTH);
    if (!subagentId) {
      return {
        agentId: null,
        source: "rejected-subagent",
        rejected: true,
        rawAgentId: explicit.slice(0, MAX_REJECTED_AGENT_ID_LENGTH),
      };
    }
    return {
      agentId: DEFAULT_HOOK_AGENT_ID,
      source: "subagent",
      defaulted: false,
      subagentId,
      subagentType: normalizeSubagentMetadata(
        data && data.agent_type,
        MAX_SUBAGENT_TYPE_LENGTH
      ),
    };
  }

  return { agentId: DEFAULT_HOOK_AGENT_ID, source: "default", defaulted: true };
}

module.exports = {
  DEFAULT_HOOK_AGENT_ID,
  HOOK_SOURCE_AGENT_IDS,
  KNOWN_HOOK_AGENT_IDS,
  MAX_REJECTED_AGENT_ID_LENGTH,
  MAX_SUBAGENT_ID_LENGTH,
  MAX_SUBAGENT_TYPE_LENGTH,
  normalizeSubagentMetadata,
  resolveHookAgentId,
};
