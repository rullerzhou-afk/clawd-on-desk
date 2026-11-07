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
//      forwarded (/state listens on loopback only, but every request body is
//      still untrusted input, and remote sessions can relay events here).
//   2. decideClaudeTurnAskAction — the stateless show / clear / ignore rules.
//
// The answer can only be given in Claude Desktop (a button sends the next user
// message), so the bubble is a read-only native-question card; see
// isNativeQuestionNotify in passive-notify-entry.js.

const CLAUDE_WRAP_UP_TOOL_NAME = "mcp__ccd_turn__wrap_up";

const MAX_ASK_CHARS = 300;
const MAX_ACTIONS = 4;
const MAX_ACTION_LABEL_CHARS = 60;

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
  const actions = Array.isArray(raw.actions)
    ? raw.actions
      .slice(0, MAX_ACTIONS)
      .map((action) => {
        if (!action || typeof action !== "object") return null;
        const label = clampText(action.label, MAX_ACTION_LABEL_CHARS);
        return label ? { label } : null;
      })
      .filter(Boolean)
    : [];
  return { ask, actions };
}

// The card lives until Claude moves the session on.
//
// - PreToolUse(wrap_up) with an ask   → show (one card per session, refreshed)
// - PreToolUse(wrap_up) recap-only    → clear: a later recap-only call replaces
//                                       the box in Claude Desktop, so the
//                                       question is gone there too
// - PreToolUse(any other tool)        → clear: Claude moved on
// - UserPromptSubmit / SessionEnd     → clear: the user answered / session over
// - SubagentStart(synthetic-tool)     → clear: the hook renamed a main-thread
//                                       Agent/Task call, so Claude delegated
// - Stop / native SubagentStart       → ignore
//
// There is deliberately no "stopped since the prompt" state: Claude can start a
// queued turn without another UserPromptSubmit, and a vetoed Stop continues the
// same prompt. Both must still show or clear the card.
//
// The prompt-suggestion fork (anthropics/claude-code#106339) fires PreToolUse
// for calls that never run. In the reported 2.1.314 build those payloads carry
// a freshly assigned `agent_id` with no `agent_type`; the hook records a
// non-Claude agent_id as subagent provenance and the route ignores events with
// a subagent id. A build that omits that field cannot be told apart from a real
// queued turn: the card would be cleared or replaced by the phantom question a
// few seconds after Stop.
function decideClaudeTurnAskAction({
  event,
  toolName,
  hasAsk,
  subagentLifecycleSource,
} = {}) {
  switch (event) {
    case "UserPromptSubmit":
    case "SessionEnd":
      return "clear";
    case "SubagentStart":
      // Only the current hook's synthetic main-thread Agent/Task start clears.
      // Legacy "synthetic-task" hooks never forwarded claude_turn_ask, and
      // native/anonymous starts belong to a child or an unknown shape.
      return subagentLifecycleSource === "synthetic-tool" ? "clear" : "ignore";
    case "PreToolUse":
      if (toolName === CLAUDE_WRAP_UP_TOOL_NAME) return hasAsk ? "show" : "clear";
      return "clear";
    default:
      return "ignore";
  }
}

module.exports = {
  CLAUDE_WRAP_UP_TOOL_NAME,
  normalizeClaudeTurnAsk,
  decideClaudeTurnAskAction,
  MAX_ASK_CHARS,
  MAX_ACTIONS,
  MAX_ACTION_LABEL_CHARS,
};
