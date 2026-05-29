"use strict";

const CODEX_LIMITS = Object.freeze({
  primary: { id: "codex.primary", label: "Codex 5h", windowLabel: "5h" },
  secondary: { id: "codex.secondary", label: "Codex weekly", windowLabel: "7d" },
});

const CLAUDE_LIMITS = Object.freeze({
  five_hour: { id: "claude.five_hour", label: "Claude 5h", windowLabel: "5h" },
  seven_day: { id: "claude.seven_day", label: "Claude weekly", windowLabel: "7d" },
  seven_day_opus: { id: "claude.seven_day_opus", label: "Claude Opus weekly", windowLabel: "7d Opus" },
  seven_day_sonnet: { id: "claude.seven_day_sonnet", label: "Claude Sonnet weekly", windowLabel: "7d Sonnet" },
});

function normalizePercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  const percent = n <= 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, percent));
}

function normalizeResetMs(value) {
  if (value == null || value === "") return null;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    value = Number(value.trim());
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

function normalizeCapturedAtMs(value) {
  if (value == null || value === "") return null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

function severityFor(percent) {
  if (!Number.isFinite(percent)) return "unknown";
  if (percent > 85) return "red";
  if (percent >= 60) return "yellow";
  return "green";
}

function makeLimit({ provider, key, meta, raw, windowMinutes }) {
  if (!raw || typeof raw !== "object") return null;
  const usedPercent = normalizePercent(raw.used_percent != null ? raw.used_percent : raw.utilization);
  if (usedPercent == null) return null;
  const minutes = Number(raw.window_minutes != null ? raw.window_minutes : windowMinutes);
  return {
    id: meta.id,
    provider,
    key,
    label: meta.label,
    windowLabel: meta.windowLabel,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    severity: severityFor(usedPercent),
    windowMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : null,
    resetsAtMs: normalizeResetMs(raw.resets_at),
  };
}

function normalizeCodexRateLimits(rateLimits) {
  if (!rateLimits || typeof rateLimits !== "object") {
    return { provider: "codex", limits: [] };
  }
  const limits = [];
  for (const key of ["primary", "secondary"]) {
    const limit = makeLimit({
      provider: "codex",
      key,
      meta: CODEX_LIMITS[key],
      raw: rateLimits[key],
      windowMinutes: key === "primary" ? 300 : 10080,
    });
    if (limit) limits.push(limit);
  }
  return { provider: "codex", limits };
}

function extractCodexRateLimitsFromObject(obj) {
  const payload = obj && typeof obj === "object" && obj.payload && typeof obj.payload === "object"
    ? obj.payload
    : null;
  if (!payload || !payload.rate_limits || typeof payload.rate_limits !== "object") return null;
  const normalized = normalizeCodexRateLimits(payload.rate_limits);
  return normalized.limits.length
    ? { ...normalized, capturedAtMs: normalizeCapturedAtMs(obj.timestamp) }
    : null;
}

function extractCodexRateLimitsFromLine(line) {
  if (typeof line !== "string" || !line.trim()) return null;
  try {
    return extractCodexRateLimitsFromObject(JSON.parse(line));
  } catch {
    return null;
  }
}

function extractCodexRateLimitsFromJsonl(text) {
  if (typeof text !== "string" || !text.trim()) return { provider: "codex", limits: [], capturedAtMs: null };
  let latest = null;
  for (const line of text.split(/\r?\n/)) {
    const parsed = extractCodexRateLimitsFromLine(line);
    if (parsed && parsed.limits.length) latest = parsed;
  }
  return latest || { provider: "codex", limits: [], capturedAtMs: null };
}

function normalizeClaudeUsageResponse(body, capturedAtMs) {
  // The Claude usage API returns live utilization with no "measured at"
  // field (resets_at is the window end, not a capture time). Because the
  // value is real-time, the moment we receive the response IS the data's
  // freshness. Default to Date.now(); callers (local/remote fetchers) may
  // inject the receive time, and tests pass a deterministic value.
  const captured = Number.isFinite(capturedAtMs) ? capturedAtMs : Date.now();
  if (!body || typeof body !== "object") {
    return { provider: "claude", limits: [], capturedAtMs: captured };
  }
  const limits = [];
  for (const key of ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"]) {
    const limit = makeLimit({
      provider: "claude",
      key,
      meta: CLAUDE_LIMITS[key],
      raw: body[key],
      windowMinutes: key === "five_hour" ? 300 : 10080,
    });
    if (limit) limits.push(limit);
  }
  return { provider: "claude", limits, capturedAtMs: captured };
}

module.exports = {
  normalizePercent,
  normalizeResetMs,
  normalizeCapturedAtMs,
  severityFor,
  normalizeCodexRateLimits,
  extractCodexRateLimitsFromObject,
  extractCodexRateLimitsFromLine,
  extractCodexRateLimitsFromJsonl,
  normalizeClaudeUsageResponse,
};
