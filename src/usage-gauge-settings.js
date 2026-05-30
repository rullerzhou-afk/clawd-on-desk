"use strict";

const PROVIDERS = Object.freeze(["codex", "claude"]);
const POSITIONS = Object.freeze(["below", "above", "floating"]);
const LIMIT_IDS = Object.freeze([
  "codex.primary",
  "claude.five_hour",
  "codex.secondary",
  "claude.seven_day",
  "claude.seven_day_opus",
  "claude.seven_day_sonnet",
]);
const DEFAULT_ALWAYS_ON_LIMIT_IDS = Object.freeze([
  "codex.primary",
  "claude.five_hour",
  "codex.secondary",
  "claude.seven_day",
]);
const DEFAULT_EXPANDED_LIMIT_IDS = Object.freeze(LIMIT_IDS.slice());
// The Claude usage API is a per-access-token bucket that 429s (stickily, for
// 30-60 min) after only a handful of polls. The statusLine stdin tap is the
// primary source and costs zero API calls; the API poll is a fallback for
// users who never run Claude Code. A slow default + a high floor keep that
// fallback from ever re-triggering the rate limit.
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
const MIN_POLL_INTERVAL_MS = 60 * 1000;
const MAX_POLL_INTERVAL_MS = 60 * 60 * 1000;

function getDefaults() {
  return {
    enabled: true,
    providers: { codex: true, claude: true },
    position: "below",
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    alwaysOnLimitIds: DEFAULT_ALWAYS_ON_LIMIT_IDS.slice(),
    expandedLimitIds: DEFAULT_EXPANDED_LIMIT_IDS.slice(),
  };
}

function normalizeLimitIds(value, fallback, { max = Infinity } = {}) {
  // An explicit array (even empty) is a deliberate user choice and must be
  // preserved; only a missing/non-array value falls back to defaults. This
  // keeps normalize consistent with validateUsageGauge, which accepts empty
  // arrays — otherwise "show none" would silently revert to defaults on reload.
  const explicit = Array.isArray(value);
  const source = explicit ? value : fallback;
  const out = [];
  const allowed = new Set(LIMIT_IDS);
  for (const id of source || []) {
    if (typeof id !== "string" || !allowed.has(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= max) break;
  }
  if (out.length) return out;
  return explicit ? [] : fallback.slice(0, max);
}

function normalizeProviders(value, fallback) {
  const out = { ...fallback };
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const provider of PROVIDERS) {
    if (typeof value[provider] === "boolean") out[provider] = value[provider];
  }
  return out;
}

function normalizeUsageGauge(value, defaultsValue) {
  const defaults = defaultsValue || getDefaults();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return getDefaults();
  }
  const poll = Number(value.pollIntervalMs);
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    providers: normalizeProviders(value.providers, defaults.providers),
    position: POSITIONS.includes(value.position) ? value.position : defaults.position,
    pollIntervalMs: Number.isInteger(poll) && poll >= MIN_POLL_INTERVAL_MS && poll <= MAX_POLL_INTERVAL_MS
      ? poll
      : defaults.pollIntervalMs,
    alwaysOnLimitIds: normalizeLimitIds(value.alwaysOnLimitIds, defaults.alwaysOnLimitIds, { max: 4 }),
    expandedLimitIds: normalizeLimitIds(value.expandedLimitIds, defaults.expandedLimitIds),
  };
}

function validateUsageGauge(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "error", message: "usageGauge must be a plain object" };
  }
  if (typeof value.enabled !== "boolean") return { status: "error", message: "usageGauge.enabled must be boolean" };
  if (!value.providers || typeof value.providers !== "object" || Array.isArray(value.providers)) {
    return { status: "error", message: "usageGauge.providers must be a plain object" };
  }
  for (const provider of PROVIDERS) {
    if (typeof value.providers[provider] !== "boolean") {
      return { status: "error", message: `usageGauge.providers.${provider} must be boolean` };
    }
  }
  if (!POSITIONS.includes(value.position)) {
    return { status: "error", message: "usageGauge.position must be below, above, or floating" };
  }
  if (!Number.isInteger(value.pollIntervalMs) || value.pollIntervalMs < MIN_POLL_INTERVAL_MS || value.pollIntervalMs > MAX_POLL_INTERVAL_MS) {
    return { status: "error", message: "usageGauge.pollIntervalMs is out of range" };
  }
  for (const key of ["alwaysOnLimitIds", "expandedLimitIds"]) {
    if (!Array.isArray(value[key])) return { status: "error", message: `usageGauge.${key} must be an array` };
    const seen = new Set();
    for (const id of value[key]) {
      if (typeof id !== "string" || !LIMIT_IDS.includes(id) || seen.has(id)) {
        return { status: "error", message: `usageGauge.${key} contains unsupported values` };
      }
      seen.add(id);
    }
  }
  if (value.alwaysOnLimitIds.length > 4) {
    return { status: "error", message: "usageGauge.alwaysOnLimitIds may contain at most 4 entries" };
  }
  return { status: "ok" };
}

const api = {
  PROVIDERS,
  POSITIONS,
  LIMIT_IDS,
  DEFAULT_ALWAYS_ON_LIMIT_IDS,
  DEFAULT_EXPANDED_LIMIT_IDS,
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  getDefaults,
  normalizeUsageGauge,
  validateUsageGauge,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}

if (typeof globalThis !== "undefined") {
  globalThis.ClawdUsageGaugeSettings = api;
}
