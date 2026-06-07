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

// Mirror the transcript-pollution guards used by the assistant-output
// extractor in clawd-hook.js. Without these, the most recent usage-bearing
// entry can belong to a Task sub-agent (sidechain), a different session
// (resumed/forked transcript), or a synthetic API-error message — none of
// which reflect the main session's context window.
function entryMatchesSession(entry, sessionId) {
  if (!sessionId) return true;
  if (!entry || typeof entry !== "object") return false;
  return !entry.sessionId || entry.sessionId === sessionId;
}

function entryLooksSubagent(entry) {
  if (!entry || typeof entry !== "object") return false;
  return entry.isSidechain === true
    || entry.isSubagent === true
    || entry.is_subagent === true
    || entry.subagent === true;
}

function extractClaudeContextUsageFromEntries(entries, sessionId) {
  if (!Array.isArray(entries)) return null;
  // Walk backwards so the first acceptable entry is the most recent one,
  // skipping non-assistant / sub-agent / cross-session / API-error entries
  // rather than letting a trailing message win. Usage is only meaningful on
  // assistant turns; the type guard also stops a future non-assistant record
  // that happens to carry a usage object from being read as Claude context.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object") continue;
    if (entry.type !== "assistant") continue;
    if (entry.isApiErrorMessage === true) continue;
    if (!entryMatchesSession(entry, sessionId)) continue;
    if (entryLooksSubagent(entry)) continue;
    const usage = computeClaudeUsageFromEntry(entry);
    if (usage) return usage;
  }
  return null;
}

module.exports = {
  CLAUDE_1M_CONTEXT_LIMIT,
  DEFAULT_CLAUDE_CONTEXT_LIMIT,
  computeClaudeUsageFromEntry,
  extractClaudeContextUsageFromEntries,
  resolveClaudeContextLimit,
};
