"use strict";

const { normalizeQuotaGroup } = require("./quota-bucket");

// Claude Code's own statusline payload (~/.claude/settings.json statusLine,
// registered by hooks/install.js registerClaudeStatusline). Since v2.1.80,
// Claude Code puts the Pro/Max subscription rate limit directly on stdin -
// no separate API call needed. Field names/semantics from the official docs:
// https://code.claude.com/docs/en/statusline
// rate_limits.{five_hour,seven_day}.used_percentage is already 0-100 "used"
// (same convention this app standardizes on - see hooks/quota-bucket.js).
// .resets_at is an absolute Unix-epoch-seconds timestamp - converted to
// epoch-ms here so it matches the quota-bucket.js resetAt convention.
const CLAUDE_QUOTA_FIELDS = ["claudeFiveHour", "claudeWeekly"];
const RATE_LIMIT_KEYS = {
  five_hour: "claudeFiveHour",
  seven_day: "claudeWeekly",
};

function convertClaudeRateLimitsPayload(rateLimits) {
  const out = {};
  for (const [key, field] of Object.entries(RATE_LIMIT_KEYS)) {
    const bucket = rateLimits[key];
    if (!bucket || typeof bucket !== "object") continue;
    const usedPercent = Number(bucket.used_percentage);
    if (!Number.isFinite(usedPercent)) continue;
    const entry = { usedPercent };
    const resetsAt = Number(bucket.resets_at);
    if (Number.isFinite(resetsAt)) entry.resetAt = resetsAt * 1000;
    out[field] = entry;
  }
  return out;
}

function resolveClaudeRateLimitQuota(payload) {
  const rateLimits = payload && typeof payload.rate_limits === "object" ? payload.rate_limits : null;
  if (!rateLimits) return null;
  return normalizeQuotaGroup(convertClaudeRateLimitsPayload(rateLimits), CLAUDE_QUOTA_FIELDS);
}

function resolveClaudeModelLabel(payload) {
  const model = payload && typeof payload.model === "object" ? payload.model : null;
  if (!model) return null;
  const displayName = typeof model.display_name === "string" && model.display_name.trim();
  if (displayName) return displayName.trim();
  const id = typeof model.id === "string" && model.id.trim();
  return id ? id.trim() : null;
}

module.exports = {
  resolveClaudeRateLimitQuota,
  resolveClaudeModelLabel,
  CLAUDE_QUOTA_FIELDS,
};
