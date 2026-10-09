"use strict";

// Shared, unit-testable session-id resolution for the KiroCrew bridge.
//
// KiroCrew's hook stdin carries no `session_id`. It exposes `session_key`
// (main hooks.py) and, for a subagent, `parent_session_key` (the spawning
// chat). Reading these keeps each chat on its own pet session instead of
// collapsing every chat into one shared "default" session — which would let
// one chat's Stop celebrate while another chat is still working. A subagent's
// own id is appended so its tool events don't un-finish its parent row.
function resolveSessionId(payload) {
  if (!payload || typeof payload !== "object") return "default";
  const base =
    payload.session_key ||
    payload.sessionKey ||
    payload.parent_session_key ||
    payload.parentSessionKey ||
    payload.session_id ||
    payload.sessionId ||
    "default";
  const subagent = payload.subagent_id || payload.subagentId || "";
  return subagent ? `${String(base)}::sub:${subagent}` : String(base);
}

module.exports = resolveSessionId;
module.exports.resolveSessionId = resolveSessionId;
