"use strict";

// Shared shape for account-wide rate-limit quota buckets (Antigravity's
// gemini-5h/weekly/3p-5h/weekly, Claude Code's five_hour/seven_day). Always
// "how much has been used" (0-100) so every source and every renderer means
// the same thing - a full bar is a warning, not a healthy state.
//
// windowMinutes is the reporter's actual rate-limit window. It is display
// metadata, not a slot name: providers can change which windows they expose
// without leaving a stale "5h" label in the UI.
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
  const windowMinutes = Number(value.windowMinutes);
  if (Number.isFinite(windowMinutes) && windowMinutes > 0) {
    out.windowMinutes = Math.round(windowMinutes);
  }
  const resetAt = Number(value.resetAt);
  if (Number.isFinite(resetAt)) out.resetAt = Math.round(resetAt);
  // capturedAt (epoch-ms): when the reporter actually observed this number
  // (a rollout line's own timestamp, not receive time). The account store
  // uses it to reject out-of-order writes — two live sessions replaying
  // cached values must not let an older observation overwrite a newer one.
  const capturedAt = Number(value.capturedAt);
  if (Number.isFinite(capturedAt)) out.capturedAt = Math.round(capturedAt);
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

// Anchor a relative "resets in N seconds" countdown to an absolute epoch-ms
// instant, quantized to whole minutes. The countdown and our receive time
// tick independently, so a raw nowMs + s*1000 jitters by hundreds of ms on
// every refresh - each refresh would produce a "different" resetAt, changing
// the snapshot signature every tick and re-opening the broadcast storm that
// absolute timestamps were adopted to close. Reset labels render at minute
// granularity, so nothing is lost.
function anchorRelativeResetAt(resetInSeconds, nowMs = Date.now()) {
  const seconds = Number(resetInSeconds);
  if (!Number.isFinite(seconds)) return null;
  return Math.round((nowMs + seconds * 1000) / 60000) * 60000;
}

module.exports = { normalizeQuotaBucket, normalizeQuotaGroup, anchorRelativeResetAt };
