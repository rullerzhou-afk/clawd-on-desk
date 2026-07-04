"use strict";

const { getAllAgents } = require("../agents/registry");

const DEFAULT_HOOK_AGENT_ID = "claude-code";

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
  ["mimocode-plugin", "mimocode"],
  ["openclaw-plugin", "openclaw"],
  ["codewhale-hook", "codewhale"],
  ["pi-extension", "pi"],
]);

function normalizeHookText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveHookAgentId(data) {
  const explicit = normalizeHookText(data && data.agent_id);
  if (explicit && KNOWN_HOOK_AGENT_IDS.has(explicit)) {
    return { agentId: explicit, source: "explicit", defaulted: false };
  }

  const hookSource = normalizeHookText(data && data.hook_source);
  const sourceAgentId = HOOK_SOURCE_AGENT_IDS.get(hookSource);
  if (sourceAgentId) {
    return { agentId: sourceAgentId, source: "hook-source", defaulted: false };
  }

  if (explicit) {
    return {
      agentId: DEFAULT_HOOK_AGENT_ID,
      source: "subagent",
      defaulted: false,
      subagentId: explicit,
      subagentType: normalizeHookText(data && data.agent_type) || null,
    };
  }

  return { agentId: DEFAULT_HOOK_AGENT_ID, source: "default", defaulted: true };
}

module.exports = {
  DEFAULT_HOOK_AGENT_ID,
  HOOK_SOURCE_AGENT_IDS,
  KNOWN_HOOK_AGENT_IDS,
  resolveHookAgentId,
};
