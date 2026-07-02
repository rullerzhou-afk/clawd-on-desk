"use strict";

// Shared shape for account-wide rate-limit quota buckets (Antigravity's
// gemini-5h/weekly/3p-5h/weekly, Claude Code's five_hour/seven_day). Always
// "how much has been used" (0-100) so every source and every renderer means
// the same thing - a full bar is a warning, not a healthy state.

function normalizeQuotaBucket(value) {
  if (!value || typeof value !== "object") return null;
  const usedPercent = Number(value.usedPercent);
  if (!Number.isFinite(usedPercent)) return null;
  const out = { usedPercent: Math.max(0, Math.min(100, Math.round(usedPercent))) };
  const resetInSeconds = Number(value.resetInSeconds);
  if (Number.isFinite(resetInSeconds) && resetInSeconds >= 0) out.resetInSeconds = Math.round(resetInSeconds);
  return out;
}

function normalizeQuotaGroup(value, fields) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  for (const field of fields) {
    const bucket = normalizeQuotaBucket(value[field]);
    if (bucket) out[field] = bucket;
  }
  return Object.keys(out).length ? out : null;
}

module.exports = { normalizeQuotaBucket, normalizeQuotaGroup };
