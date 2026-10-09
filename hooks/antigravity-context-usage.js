"use strict";

const { normalizeQuotaGroup, anchorRelativeResetAt } = require("./quota-bucket");

// Antigravity's statusline payload (unlike Claude Code's transcript) already
// reports the model's real context window size and fill level directly, so
// there is no model-name -> limit table to maintain here.
// Field names come from the community-documented statusline JSON contract:
// https://github.com/weby-homelab/antigravity-cli-statusline

function normalizeNonNegativeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function resolveAntigravityContextUsage(payload) {
  const ctx = payload && typeof payload.context_window === "object" ? payload.context_window : null;
  if (!ctx) return null;

  const limit = normalizeNonNegativeNumber(ctx.context_window_size);
  const inputTokens = normalizeNonNegativeNumber(ctx.total_input_tokens);
  const outputTokens = normalizeNonNegativeNumber(ctx.total_output_tokens);
  const usedPercentage = normalizeNonNegativeNumber(ctx.used_percentage);

  let used = null;
  if (inputTokens !== null || outputTokens !== null) {
    used = (inputTokens || 0) + (outputTokens || 0);
  } else if (usedPercentage !== null && limit !== null) {
    used = Math.round((usedPercentage / 100) * limit);
  }
  if (used === null) return null;

  const out = { used, source: "antigravity" };
  if (limit !== null && limit > 0) {
    out.limit = limit;
    out.percent = usedPercentage !== null
      ? Math.max(0, Math.min(100, Math.round(usedPercentage)))
      : Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
  }
  return out;
}

function resolveAntigravityModelLabel(payload) {
  const model = payload && typeof payload.model === "object" ? payload.model : null;
  if (!model) return null;
  const displayName = typeof model.display_name === "string" && model.display_name.trim();
  if (displayName) return displayName.trim();
  const id = typeof model.id === "string" && model.id.trim();
  return id ? id.trim() : null;
}

// Account-wide rate-limit quota (the same data agy's own `/usage` command
// shows), not per-conversation context usage. agy reports `remaining_fraction`
// (how much is left); we invert it to usedPercent at the parsing boundary so
// every quota source in the app (agy, Claude Code) shares one "how much is
// used" convention - see hooks/quota-bucket.js.
const ANTIGRAVITY_QUOTA_FIELDS = ["geminiFiveHour", "geminiWeekly", "thirdPartyFiveHour", "thirdPartyWeekly"];
const QUOTA_BUCKET_KEYS = {
  "gemini-5h": "geminiFiveHour",
  "gemini-weekly": "geminiWeekly",
  "3p-5h": "thirdPartyFiveHour",
  "3p-weekly": "thirdPartyWeekly",
};

function invertAntigravityQuotaPayload(quota) {
  const out = {};
  const nowMs = Date.now();
  for (const [key, field] of Object.entries(QUOTA_BUCKET_KEYS)) {
    const bucket = quota[key];
    if (!bucket || typeof bucket !== "object") continue;
    const remaining = Number(bucket.remaining_fraction);
    if (!Number.isFinite(remaining)) continue;
    const entry = { usedPercent: (1 - Math.max(0, Math.min(1, remaining))) * 100 };
    // agy reports a relative countdown (reset_in_seconds), not an absolute
    // instant - anchor it to receive time, minute-quantized against the
    // broadcast-storm jitter (see quota-bucket.js anchorRelativeResetAt).
    const resetAt = anchorRelativeResetAt(bucket.reset_in_seconds, nowMs);
    if (resetAt !== null) entry.resetAt = resetAt;
    out[field] = entry;
  }
  return out;
}

function resolveAntigravityQuota(payload) {
  const quota = payload && typeof payload.quota === "object" ? payload.quota : null;
  if (!quota) return null;
  return normalizeQuotaGroup(invertAntigravityQuotaPayload(quota), ANTIGRAVITY_QUOTA_FIELDS);
}

module.exports = {
  resolveAntigravityContextUsage,
  resolveAntigravityModelLabel,
  resolveAntigravityQuota,
  ANTIGRAVITY_QUOTA_FIELDS,
};
