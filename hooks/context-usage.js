"use strict";

const DEFAULT_CLAUDE_CONTEXT_LIMIT = 200000;
const CLAUDE_1M_CONTEXT_LIMIT = 1000000;
const CLAUDE_1M_CONTEXT_MARKER_RE = /(?:^|[^a-z0-9])1m(?:[^a-z0-9]|$)/i;

function normalizeUsageNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function resolveClaudeContextLimit(model) {
  const raw = typeof model === "string" ? model.toLowerCase() : "";
  if (!raw) return DEFAULT_CLAUDE_CONTEXT_LIMIT;
  if (CLAUDE_1M_CONTEXT_MARKER_RE.test(raw)) return CLAUDE_1M_CONTEXT_LIMIT;
  if (raw.includes("opus") || raw.includes("sonnet") || raw.includes("haiku")) {
    return DEFAULT_CLAUDE_CONTEXT_LIMIT;
  }
  return null;
}

function computeClaudeUsageFromEntry(entry) {
  const message = entry && entry.message && typeof entry.message === "object"
    ? entry.message
    : null;
  const usage = message && message.usage && typeof message.usage === "object"
    ? message.usage
    : (entry && entry.usage && typeof entry.usage === "object" ? entry.usage : null);
  if (!usage) return null;

  const used =
    normalizeUsageNumber(usage.input_tokens)
    + normalizeUsageNumber(usage.cache_read_input_tokens)
    + normalizeUsageNumber(usage.cache_creation_input_tokens);
  if (!Number.isFinite(used) || used <= 0) return null;

  const model =
    (message && typeof message.model === "string" && message.model)
    || (typeof entry.model === "string" && entry.model)
    || "";
  const limit = resolveClaudeContextLimit(model);
  const out = { used, source: "claude" };
  if (limit) {
    out.limit = limit;
    out.percent = Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
  }
  return out;
}

function extractClaudeContextUsageFromEntries(entries) {
  if (!Array.isArray(entries)) return null;
  let latest = null;
  for (const entry of entries) {
    const usage = computeClaudeUsageFromEntry(entry);
    if (usage) latest = usage;
  }
  return latest;
}

module.exports = {
  CLAUDE_1M_CONTEXT_LIMIT,
  DEFAULT_CLAUDE_CONTEXT_LIMIT,
  computeClaudeUsageFromEntry,
  extractClaudeContextUsageFromEntries,
  resolveClaudeContextLimit,
};
