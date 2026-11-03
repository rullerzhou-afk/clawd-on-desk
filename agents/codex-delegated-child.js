"use strict";

const { normalizeCodexThreadId, CODEX_THREAD_ID_RE } = require("../src/codex-thread-id");
const { normalizeCodexTurnId } = require("../src/codex-turn-id");
const { CODEX_LOCAL_WORKING_STALE_FLOOR_MS } = require("../src/state-stale-cleanup");

const MAX_CLOSED_TURNS = 64;
const ACTIVE_EVENTS = new Set([
  "event_msg:task_started", "event_msg:user_message", "event_msg:agent_message",
  "event_msg:agent_reasoning", "event_msg:agent_reasoning_raw_content", "response_item:reasoning",
  "response_item:function_call", "response_item:custom_tool_call", "response_item:web_search_call",
  "event_msg:exec_command_end", "event_msg:patch_apply_end", "event_msg:custom_tool_call_output",
]);
const TERMINAL_EVENTS = new Set(["event_msg:task_complete", "event_msg:turn_aborted"]);

// Role classification intentionally includes internal guardian threads. Animation
// ownership is narrower: only this exact upstream relationship proves delegation.
function normalizeDelegatedThread(value) {
  const id = normalizeCodexThreadId(value);
  return id && CODEX_THREAD_ID_RE.test(id) ? `codex:${id}` : null;
}

function readDelegatedParent(meta, childId) {
  const subagent = meta && meta.source && meta.source.subagent;
  if (!subagent || typeof subagent !== "object" || Array.isArray(subagent)
    || Object.keys(subagent).length !== 1 || !subagent.thread_spawn) return null;
  const child = normalizeDelegatedThread(childId);
  const parent = normalizeDelegatedThread(subagent.thread_spawn.parent_thread_id);
  if (meta.id && normalizeDelegatedThread(meta.id) !== child) return null;
  return child && parent && parent !== child ? parent : null;
}

function closeTurn(child, turnId) {
  child.closed.add(turnId);
  while (child.closed.size > MAX_CLOSED_TURNS) child.closed.delete(child.closed.values().next().value);
}

function observeDelegatedChild(child, event, turnId, occurredAt, now = Date.now()) {
  const turn = normalizeCodexTurnId(turnId);
  // Reject clock-skewed records before they can close an accepted turn or
  // advance its ordering fence. A publish-only guard would be too late.
  if (!child || child.invalid || !turn || !Number.isSafeInteger(occurredAt)
    || !Number.isSafeInteger(now) || occurredAt > now + 1500) return null;
  if (event === "event_msg:task_started") {
    if (child.parentEndedAt && occurredAt <= child.parentEndedAt) return null;
    if (child.closed.has(turn) || occurredAt < (child.latestStartAt || 0)) return null;
    if (child.turnId === turn) return null;
    if (child.turnId) closeTurn(child, child.turnId);
    child.turnId = turn;
    child.latestStartAt = occurredAt;
    child.lastActivityAt = occurredAt;
    return "start";
  }
  if (TERMINAL_EVENTS.has(event)) {
    if (child.turnId !== turn) { closeTurn(child, turn); return null; }
    closeTurn(child, turn);
    child.turnId = null;
    return "stop";
  }
  if (ACTIVE_EVENTS.has(event) && child.turnId === turn && !child.closed.has(turn)) {
    child.lastActivityAt = Math.max(child.lastActivityAt, occurredAt);
    return "activity";
  }
  return null;
}

module.exports = { normalizeDelegatedThread, readDelegatedParent, observeDelegatedChild,
  CHILD_ACTIVITY_TTL_MS: CODEX_LOCAL_WORKING_STALE_FLOOR_MS };
