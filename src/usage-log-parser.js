"use strict";

// Parse token usage from a single parsed session-log JSON object.
//
// Claude Code writes ~/.claude/projects/*/*.jsonl transcripts where each
// assistant turn carries `message.usage`. Mirrors cc-switch's
// session_usage.rs extraction: only `type === "assistant"` lines with both a
// message id and a usage object count. Returns a normalized record or null.

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseClaudeLine(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.type !== "assistant") return null;
  const message = obj.message;
  if (!message || typeof message !== "object") return null;
  const messageId = typeof message.id === "string" ? message.id : null;
  if (!messageId) return null;
  const usage = message.usage;
  if (!usage || typeof usage !== "object") return null;
  return {
    messageId,
    model: typeof message.model === "string" && message.model ? message.model : "unknown",
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheCreation: num(usage.cache_creation_input_tokens),
    stopReason: typeof message.stop_reason === "string" ? message.stop_reason : null,
    ts: typeof obj.timestamp === "string" ? obj.timestamp : null,
    sessionId: typeof obj.sessionId === "string" ? obj.sessionId : null,
  };
}

module.exports = { parseClaudeLine };
