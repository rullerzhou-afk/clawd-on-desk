"use strict";

// Reads the Claude usage snapshot written by hooks/clawd-statusline-tap.js
// (~/.clawd/statusline.json) and converts it into the {provider, limits,
// capturedAtMs} shape the usage gauge runtime consumes.
//
// This is the PRIMARY Claude usage source. When Claude Code is running it
// refreshes this file every prompt via the statusLine stdin tap, so the gauge
// can show live usage with zero calls to the per-token usage API (which 429s
// stickily). When CC is idle the snapshot goes stale and the runtime falls back
// to the rate-limited API poll.
//
// The snapshot shape (claude-hud external-usage compatible):
//   { updated_at: <ISO|epoch>, five_hour: { used_percentage, resets_at },
//     seven_day: { used_percentage, resets_at } }
//
// NOTE the key names differ from the usage API: the statusLine stdin uses
// `used_percentage`, the API uses `utilization`. makeLimit handles
// `used_percent` and `utilization`, so we normalize `used_percentage` into a
// `used_percent` field before reusing the shared limit builder.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { normalizeClaudeUsageResponse, normalizeCapturedAtMs } = require("./usage-parsers");

const DEFAULT_FRESHNESS_MS = 5 * 60 * 1000;

function defaultSnapshotPath() {
  return path.join(os.homedir(), ".clawd", "statusline.json");
}

// Translate one snapshot window into the makeLimit raw shape. makeLimit reads
// `used_percent` (preferred) || `utilization`; the statusLine snapshot stores
// `used_percentage`, so map it across. Returns null when used_percentage is not
// a finite number (a window with only resets_at is malformed and ignored).
function windowToRaw(window) {
  if (!window || typeof window !== "object") return null;
  const pct = Number(window.used_percentage);
  if (!Number.isFinite(pct)) return null;
  const raw = { used_percent: pct };
  if (window.resets_at != null) raw.resets_at = window.resets_at;
  return raw;
}

// Parse a snapshot object (already JSON-parsed) into the provider result, or
// null when stale / empty / malformed. `freshnessMs` defaults to 5 min; pass a
// deterministic `now` in tests.
function normalizeStatuslineSnapshot(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const freshnessMs = Number.isFinite(options.freshnessMs) ? options.freshnessMs : DEFAULT_FRESHNESS_MS;

  const updatedAt = normalizeCapturedAtMs(snapshot.updated_at);
  if (updatedAt == null) return null;
  if (now - updatedAt > freshnessMs) return null;

  // Reuse the shared Claude normalizer by feeding it API-shaped windows. Only
  // five_hour / seven_day exist in the statusLine stream; the opus/sonnet
  // sub-buckets are API-only.
  const body = {};
  const fiveHour = windowToRaw(snapshot.five_hour);
  const sevenDay = windowToRaw(snapshot.seven_day);
  if (fiveHour) body.five_hour = fiveHour;
  if (sevenDay) body.seven_day = sevenDay;

  const result = normalizeClaudeUsageResponse(body, updatedAt);
  if (!result.limits.length) return null;
  return { ...result, source: { kind: "statusline", path: options.path || null } };
}

// Read + parse the snapshot file. Returns null on any failure (missing file,
// unreadable, bad JSON, stale, empty) — the caller falls back to the API.
function readStatuslineUsage(options = {}) {
  const snapshotPath = options.snapshotPath || defaultSnapshotPath();
  const readFileSync = options.readFileSync || fs.readFileSync;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(snapshotPath, "utf8"));
  } catch {
    return null;
  }
  return normalizeStatuslineSnapshot(parsed, { ...options, path: snapshotPath });
}

module.exports = {
  DEFAULT_FRESHNESS_MS,
  defaultSnapshotPath,
  windowToRaw,
  normalizeStatuslineSnapshot,
  readStatuslineUsage,
};
