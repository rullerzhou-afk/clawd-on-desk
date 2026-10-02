"use strict";

const { getAllAgents } = require("../agents/registry");

const STANDARD_TOOL_START = Object.freeze(["PreToolUse"]);
const STANDARD_COMPLETION = Object.freeze(["Stop"]);

// Metric capability is intentionally separate from agents/registry.js
// capabilities. Every registry agent is listed explicitly: new integrations
// must choose a proven boundary or opt out instead of inheriting a guess.
const AGENT_METRIC_POLICIES = Object.freeze({
  "claude-code": policy("fresh-session-source", STANDARD_COMPLETION, STANDARD_TOOL_START),
  "deepseek-harness": policy(null, STANDARD_COMPLETION, STANDARD_TOOL_START),
  codex: policy(null, ["Stop", "event_msg:task_complete"], [
    "PreToolUse",
    "response_item:function_call",
    "response_item:custom_tool_call",
    "response_item:web_search_call",
  ]),
  "copilot-cli": policy(null, null, ["preToolUse"]),
  "gemini-cli": policy(null, null, STANDARD_TOOL_START),
  // Antigravity intentionally does not install PreToolUse. Its normalized
  // PostToolUse is also not a safe substitute: failed tools become
  // PostToolUseFailure, while a non-idle Stop can also fold into PostToolUse.
  "antigravity-cli": policy(null, STANDARD_COMPLETION, null),
  // Cursor's native sessionStart hook does not carry the fresh-start source.
  // The Claude-compatible import path sometimes does, but an agent-wide
  // capability must stay unsupported until every production path can prove it.
  "cursor-agent": policy(null, STANDARD_COMPLETION, STANDARD_TOOL_START),
  codebuddy: policy(null, STANDARD_COMPLETION, STANDARD_TOOL_START),
  "kiro-cli": policy(null, null, ["preToolUse"]),
  "kimi-cli": policy(null, STANDARD_COMPLETION, STANDARD_TOOL_START),
  "qwen-code": policy(null, STANDARD_COMPLETION, STANDARD_TOOL_START),
  zcode: policy(null, STANDARD_COMPLETION, STANDARD_TOOL_START),
  codewhale: policy(null, null, STANDARD_TOOL_START),
  // OpenCode-family tool lifecycle events are delivered per call: the family
  // plugin exempts them from visual-state dedup/compaction so every
  // PreToolUse reaches /state (hooks/opencode-family-plugin/core.mjs). Only a
  // transport overflow that drops the oldest queued snapshot can undercount,
  // and only during extreme delivery stalls.
  opencode: policy(null, STANDARD_COMPLETION, STANDARD_TOOL_START),
  mimocode: policy(null, STANDARD_COMPLETION, STANDARD_TOOL_START),
  pi: policy(null, STANDARD_COMPLETION, STANDARD_TOOL_START),
  // OMP records a main-session completion candidate at session_stop and emits
  // Stop only after the following agent_end proves willContinue !== true, so
  // accepted Stop remains a completed-turn boundary here.
  omp: policy(null, STANDARD_COMPLETION, STANDARD_TOOL_START),
  openclaw: policy(null, STANDARD_COMPLETION, STANDARD_TOOL_START),
  // Hermes normalizes both post_llm_call and on_session_end to Stop. The first
  // can be an intermediate model boundary before a tool call, so Stop is not a
  // proven completed-turn boundary for recap.
  hermes: policy(null, null, STANDARD_TOOL_START),
  qoder: policy(null, STANDARD_COMPLETION, STANDARD_TOOL_START),
  reasonix: policy(null, STANDARD_COMPLETION, STANDARD_TOOL_START),
  qoderwork: policy(null, STANDARD_COMPLETION, STANDARD_TOOL_START),
  qwenwork: policy(null, STANDARD_COMPLETION, STANDARD_TOOL_START),
  workbuddy: policy(null, STANDARD_COMPLETION, STANDARD_TOOL_START),
  traecode: policy(null, STANDARD_COMPLETION, STANDARD_TOOL_START),
  // MiniMax Code maps SessionStart→Stop turn boundaries exactly like the
  // Claude-compatible adapters; PreToolUse/PostToolUse bracket tool calls.
  minimax: policy(null, STANDARD_COMPLETION, STANDARD_TOOL_START),
  "grok-build": policy(null, null, STANDARD_TOOL_START),
});

function policy(sessionStart, turnCompleteEvents, toolCallEvents) {
  return Object.freeze({
    sessionStart,
    turnCompleteEvents: turnCompleteEvents ? Object.freeze([...turnCompleteEvents]) : null,
    toolCallEvents: toolCallEvents ? Object.freeze([...toolCallEvents]) : null,
  });
}

function hasEvent(events, event) {
  return Array.isArray(events) && events.includes(event);
}

function hasReusableDefaultIdentity(value) {
  if (value === null || value === undefined) return true;
  const normalized = String(value).trim().toLowerCase();
  return !normalized || normalized === "default" || normalized.endsWith(":default");
}

function getMetricSupport(agentId) {
  const entry = AGENT_METRIC_POLICIES[agentId];
  if (!entry) return null;
  return Object.freeze({
    sessionsStarted: entry.sessionStart !== null && entry.sessionStart !== undefined,
    turnsCompleted: Array.isArray(entry.turnCompleteEvents),
    toolCalls: Array.isArray(entry.toolCallEvents),
  });
}

function mapRecapMetrics(input) {
  if (!input || typeof input !== "object") return null;
  const policyEntry = AGENT_METRIC_POLICIES[input.agentId];
  if (!policyEntry || typeof input.event !== "string" || !input.event) return null;

  const metrics = ["activity"];
  const isSubagent = input.recapIsSubagent === true || !!(input.subagentId || input.subagentType);
  if (
    policyEntry.sessionStart === "fresh-session-source"
    && input.event === "SessionStart"
    && (input.sessionStartSource === "startup" || input.sessionStartSource === "clear")
    && !hasReusableDefaultIdentity(input.rawSessionId)
    && !isSubagent
  ) {
    metrics.push("session-start");
  }
  if (
    input.completionAccepted === true
    && !isSubagent
    && hasEvent(policyEntry.turnCompleteEvents, input.event)
  ) {
    metrics.push("turn-complete");
  }
  if (
    input.recapBoundary !== "permission"
    && (
      (
        input.recapBoundary === "tool-call"
        && input.agentId === "kimi-cli"
        && input.event === "PermissionRequest"
      )
      || hasEvent(policyEntry.toolCallEvents, input.event)
    )
  ) {
    metrics.push("tool-call");
  }
  return metrics;
}

function assertRegistryCoverage() {
  const registryIds = getAllAgents().map((agent) => agent.id).sort();
  const policyIds = Object.keys(AGENT_METRIC_POLICIES).sort();
  if (JSON.stringify(registryIds) !== JSON.stringify(policyIds)) {
    throw new Error("recap metric policies must explicitly cover every registry agent");
  }
  return true;
}

assertRegistryCoverage();

module.exports = {
  AGENT_METRIC_POLICIES,
  assertRegistryCoverage,
  getMetricSupport,
  hasReusableDefaultIdentity,
  mapRecapMetrics,
};
