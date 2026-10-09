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
    || permEntry.isKimiNotify
  ));
}

module.exports = { isPassiveNotifyEntry };
