"use strict";

// Shared shape for account-wide rate-limit quota buckets (Antigravity's
// gemini-5h/weekly/3p-5h/weekly, Claude Code's five_hour/seven_day). Always
// "how much has been used" (0-100) so every source and every renderer means
// the same thing - a full bar is a warning, not a healthy state.
//
// resetAt is an absolute epoch-ms timestamp, not a countdown. A relative
// "resets in N seconds" value goes stale the moment the CLI stops refreshing
// the statusline (the renderer would keep showing the same countdown
// forever), and it also changes every tick even when nothing else did,
// which defeats sessionSnapshotSignature's dedup and re-broadcasts the full
// snapshot on every refresh. Storing the absolute instant lets the renderer
// compute "time left" fresh on every paint, and keeps the signature stable
// between real quota updates.

function normalizeQuotaBucket(value) {
  if (!value || typeof value !== "object") return null;
  const usedPercent = Number(value.usedPercent);
  if (!Number.isFinite(usedPercent)) return null;
  const out = { usedPercent: Math.max(0, Math.min(100, Math.round(usedPercent))) };
  const resetAt = Number(value.resetAt);
  if (Number.isFinite(resetAt)) out.resetAt = Math.round(resetAt);
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
