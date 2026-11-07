"use strict";

// Shared predicate for "passive" notification bubbles — Codex/Kimi cues that
// carry no HTTP decision channel and must never be treated as an actionable
// permission (Allow/Deny), a Telegram-approvable request, or an auto-approve
// target. Extracted so permission.js, main.js, and telegram-direct-send.js
// can't drift by hand-rolling their own exclusion list per passive type.
function isPassiveNotifyEntry(permEntry) {
  return !!(permEntry && (
    permEntry.isCodexNotify
    || permEntry.isCodexUserInputNotify
    || permEntry.isClaudeTurnAskNotify
    || permEntry.isKimiNotify
    || permEntry.isKiroDesktopNotify
  ));
}

// Read-only "native question" cards: the agent asked the user something, but
// the answer can only travel through the agent's own UI (Codex Desktop's
// app-server connection for request_user_input; Claude Desktop's end-of-turn
// box for mcp__ccd_turn__wrap_up). Clawd shows the question, never answers
// it, and its only action is "dismiss + bring the agent's app forward".
function isNativeQuestionNotify(permEntry) {
  return !!(permEntry && (
    permEntry.isCodexUserInputNotify
    || permEntry.isClaudeTurnAskNotify
  ));
}

module.exports = { isPassiveNotifyEntry, isNativeQuestionNotify };
