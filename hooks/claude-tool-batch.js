"use strict";

// Phase correlation only. Never forward tool inputs or responses with a batch.
const MAX_BATCH_TOOLS = 64;
const MAX_TOOL_ID_LENGTH = 128;

function normalizeClaudePhaseId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || id.length > MAX_TOOL_ID_LENGTH || !/^[A-Za-z0-9_.:-]+$/u.test(id)) return null;
  return id;
}

function normalizeClaudeBatchToolUseIds(values) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_BATCH_TOOLS) return null;
  const ids = values.map(normalizeClaudePhaseId);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return null;
  return ids;
}

function extractClaudeBatchToolUseIds(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length > MAX_BATCH_TOOLS) return null;
  return normalizeClaudeBatchToolUseIds(toolCalls.map((tool) => (
    tool && typeof tool === "object" && !Array.isArray(tool) ? tool.tool_use_id : null
  )));
}

module.exports = {
  MAX_BATCH_TOOLS,
  MAX_TOOL_ID_LENGTH,
  normalizeClaudePhaseId,
  normalizeClaudeBatchToolUseIds,
  extractClaudeBatchToolUseIds,
};
