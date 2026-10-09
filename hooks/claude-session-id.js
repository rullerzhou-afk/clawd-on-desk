"use strict";

// Shared by the hook-side resume index and the terminal launcher. A session
// identifier must remain one filename component and one shell-safe argument.
function normalizeClaudeSessionId(sessionId) {
  if (sessionId == null || sessionId === "") return "";
  if (typeof sessionId !== "string") {
    throw new TypeError("normalizeClaudeSessionId: sessionId must be a string");
  }
  const normalized = sessionId.trim();
  if (!normalized || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error("Invalid Claude session ID. Use only letters, numbers, underscores, and hyphens.");
  }
  return normalized;
}

module.exports = { normalizeClaudeSessionId };
