"use strict";

// #1326: the Claude Desktop Code tab ends many turns with an end-of-turn
// "next-step box" instead of an AskUserQuestion picker. The model draws it by
// calling the Desktop's built-in MCP tool `mcp__ccd_turn__wrap_up` with
// `{ recap, ask, actions: [{ label, message? }] }`. The call never goes through
// PermissionRequest, so Clawd's question bubble never fired for it — the only
// signal Clawd gets is the PreToolUse hook (matcher "").
//
// This module owns the two pieces that are easy to get wrong, so the /state
// route stays a thin caller and the rules are unit-testable:
//   1. normalizeClaudeTurnAsk — re-validate and cap the fields the hook
//      forwarded (the /state body is a local-only but still untrusted input).
//   2. createClaudeTurnAskTracker — per-session show / clear / ignore rules.
//
// The answer can only be given in Claude Desktop (a button sends the next user
// message), so the bubble is a read-only native-question card; see
// isNativeQuestionNotify in passive-notify-entry.js.

const CLAUDE_WRAP_UP_TOOL_NAME = "mcp__ccd_turn__wrap_up";

const MAX_ASK_CHARS = 300;
const MAX_RECAP_CHARS = 400;
const MAX_ACTIONS = 4;
const MAX_ACTION_LABEL_CHARS = 60;
const MAX_ACTION_MESSAGE_CHARS = 200;
const MAX_TRACKED_SESSIONS = 500;

function clampText(value, maxChars) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function normalizeClaudeTurnAsk(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const ask = clampText(raw.ask, MAX_ASK_CHARS);
  if (!ask) return null;
  const recap = clampText(raw.recap, MAX_RECAP_CHARS);
  const actions = Array.isArray(raw.actions)
    ? raw.actions
      .slice(0, MAX_ACTIONS)
      .map((action) => {
        if (!action || typeof action !== "object") return null;
        const label = clampText(action.label, MAX_ACTION_LABEL_CHARS);
        if (!label) return null;
        const message = clampText(action.message, MAX_ACTION_MESSAGE_CHARS);
        return message ? { label, message } : { label };
      })
      .filter(Boolean)
    : [];
  return { ask, recap, actions };
}

// The bubble lives from the wrap_up call until the user moves the session on.
//
// - PreToolUse(wrap_up) with an ask   → show (one card per session, refreshed)
// - PreToolUse(wrap_up) recap-only    → clear: a later recap-only call replaces
//                                       the box in Claude Desktop, so the
//                                       question is gone there too
// - PreToolUse(any other tool)        → clear: Claude moved on
// - UserPromptSubmit / SessionEnd     → clear: the user answered / session over
// - Stop                              → NEVER clears: the real wrap_up is the
//                                       turn's last call, so a Stop always
//                                       follows it immediately
//
// Phantom guard (anthropics/claude-code#106339): with prompt suggestions on,
// a fork of the main conversation runs after each turn and can fire PreToolUse
// for tool calls that never execute, carrying the main session_id. A real
// wrap_up arrives BEFORE the turn's Stop, so once a session has stopped, every
// PreToolUse is ignored — neither shown nor allowed to clear the real card —
// until the next UserPromptSubmit starts a new turn.
function createClaudeTurnAskTracker() {
  const stoppedSincePrompt = new Map();

  function remember(sessionId, stopped) {
    stoppedSincePrompt.delete(sessionId);
    stoppedSincePrompt.set(sessionId, stopped);
    while (stoppedSincePrompt.size > MAX_TRACKED_SESSIONS) {
      const oldest = stoppedSincePrompt.keys().next().value;
      stoppedSincePrompt.delete(oldest);
    }
  }

  function decide({ sessionId, event, toolName, hasAsk } = {}) {
    if (typeof sessionId !== "string" || !sessionId) return "ignore";
    switch (event) {
      case "UserPromptSubmit":
        remember(sessionId, false);
        return "clear";
      case "Stop":
        remember(sessionId, true);
        return "ignore";
      case "SessionEnd":
        stoppedSincePrompt.delete(sessionId);
        return "clear";
      case "PreToolUse":
        if (stoppedSincePrompt.get(sessionId) === true) return "ignore";
        if (toolName === CLAUDE_WRAP_UP_TOOL_NAME) return hasAsk ? "show" : "clear";
        return "clear";
      default:
        return "ignore";
    }
  }

  return {
    decide,
    // test-only introspection
    _size: () => stoppedSincePrompt.size,
  };
}

module.exports = {
  CLAUDE_WRAP_UP_TOOL_NAME,
  normalizeClaudeTurnAsk,
  createClaudeTurnAskTracker,
  MAX_ASK_CHARS,
  MAX_RECAP_CHARS,
  MAX_ACTIONS,
};
