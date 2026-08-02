"use strict";

const { normalizeQuotaGroup, anchorRelativeResetAt } = require("./quota-bucket");

// Codex CLI has no statusline mechanism (its lifecycle hooks carry no rate
// limit data either), so its Plus/Pro subscription quota rides the rollout
// JSONL `token_count` events (payload.rate_limits) that the local and remote
// log monitors already tail. Codex supplies window_minutes on each bucket;
// that value is authoritative. Do not infer "5h" from primary or "7d" from
// secondary: the service can expose a different set of windows (including a
// single 7-day primary window).
// used_percent is already 0-100 "used" (the quota-bucket.js convention), and
// current CLIs emit an absolute resets_at converted to epoch-ms here, exactly
// like Claude's. Older builds emitted a relative resets_in_seconds instead;
// that fallback is anchored + minute-quantized on receipt (see
// quota-bucket.js anchorRelativeResetAt for why quantization matters).
const CODEX_QUOTA_FIELDS = ["codexFiveHour", "codexWeekly"];
const RATE_LIMIT_KEYS = ["primary", "secondary"];
const LONG_WINDOW_THRESHOLD_MINUTES = 24 * 60;
const CODEX_MAIN_LIMIT_ID = "codex";
const CODEX_SPARK_LIMIT_ID = "codex_bengalfox";
const CODEX_SPARK_LIMIT_NAME = "GPT-5.3-Codex-Spark";
const CODEX_SPARK_MODEL = "gpt-5.3-codex-spark";
const CODEX_MAIN_QUOTA_PROVIDER = "codexQuota";
const CODEX_SPARK_QUOTA_PROVIDER = "codexSparkQuota";

// Rollout files are re-read from offset 0 after a monitor restart, so an old
// token_count line can be parsed long after it was written. Posting it would
// stamp a fresh metadataUpdatedAt on stale quota and beat genuinely fresher
// reporters in the dashboard's freshest-wins arbitration - callers drop
// captures older than this instead. Both timestamps come from the same
// machine's clock (the monitor runs where the rollout is written), so no
// cross-host skew is involved.
const CODEX_QUOTA_MAX_AGE_MS = 10 * 60 * 1000;

// Far-future envelope timestamps must not pass as "fresh" either: a clock
// correction or malformed rollout line dated years ahead would otherwise be
// re-accepted on every restart for an unbounded period. Small forward skew
// is legitimate (rollout writer and monitor share a machine but not a
// scheduler tick).
const CODEX_QUOTA_MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;

function convertCodexRateLimitsPayload(rateLimits, nowMs, capturedAt) {
  const out = {};
  for (const key of RATE_LIMIT_KEYS) {
    const bucket = rateLimits[key];
    if (!bucket || typeof bucket !== "object") continue;
    const usedPercent = Number(bucket.used_percent);
    if (!Number.isFinite(usedPercent)) continue;
    const entry = { usedPercent };
    const windowMinutes = Number(bucket.window_minutes);
    if (Number.isFinite(windowMinutes) && windowMinutes > 0) {
      entry.windowMinutes = windowMinutes;
    }
    const resetsAt = Number(bucket.resets_at);
    if (Number.isFinite(resetsAt)) {
      entry.resetAt = resetsAt * 1000;
    } else {
      const resetAt = anchorRelativeResetAt(bucket.resets_in_seconds, nowMs);
      if (resetAt !== null) entry.resetAt = resetAt;
    }
    if (Number.isFinite(capturedAt)) entry.capturedAt = capturedAt;
    // The fixed internal fields remain for compatibility with snapshots and
    // settings written by earlier builds, but the assignment follows the
    // reported duration. Missing window_minutes falls back to the legacy
    // primary/secondary mapping.
    let field = Number.isFinite(windowMinutes) && windowMinutes > 0
      ? (windowMinutes >= LONG_WINDOW_THRESHOLD_MINUTES ? "codexWeekly" : "codexFiveHour")
      : (key === "primary" ? "codexFiveHour" : "codexWeekly");
    // Defensive collision handling for an unusual two-window payload whose
    // durations land on the same side of the threshold: keep both buckets
    // rather than silently overwriting one.
    if (out[field]) {
      field = field === "codexFiveHour" ? "codexWeekly" : "codexFiveHour";
    }
    out[field] = entry;
  }
  return out;
}

function normalizedIdentity(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// Current Codex CLI builds can report limit_id="codex" even while the active
// turn is using Spark. turn_context.model is therefore classified inside the
// monitor and retained only as this fixed provider hint — the raw model never
// enters quota payloads, persistence, IPC, or the remote wire format.
function resolveCodexModelQuotaProvider(model) {
  const normalizedModel = normalizedIdentity(model);
  if (!normalizedModel) return null;
  return normalizedModel === normalizedIdentity(CODEX_SPARK_MODEL)
    ? CODEX_SPARK_QUOTA_PROVIDER
    : CODEX_MAIN_QUOTA_PROVIDER;
}

function resolveProviderHint(options) {
  if (options && options.providerHint === CODEX_SPARK_QUOTA_PROVIDER) {
    return CODEX_SPARK_QUOTA_PROVIDER;
  }
  if (options && options.providerHint === CODEX_MAIN_QUOTA_PROVIDER) {
    return CODEX_MAIN_QUOTA_PROVIDER;
  }
  return resolveCodexModelQuotaProvider(options && options.model);
}

// A token_count report carries one quota identity at rate_limits scope. Keep
// that identity until after routing: flattening both the generic Codex quota
// and Spark's independent quota into the same codexQuota group is what caused
// alternating reports to overwrite each other.
function resolveCodexRateLimitProvider(rateLimits, options = {}) {
  if (!rateLimits || typeof rateLimits !== "object") return null;
  const providerHint = resolveProviderHint(options);
  const rawLimitId = rateLimits.limit_id;
  if (rawLimitId != null && typeof rawLimitId !== "string") {
    // A malformed-but-present identity is not the same as a legacy report
    // with no identity. Fail closed so it cannot overwrite the main quota.
    return null;
  }
  const limitId = normalizedIdentity(rawLimitId);
  if (limitId) {
    if (limitId === CODEX_SPARK_LIMIT_ID) return CODEX_SPARK_QUOTA_PROVIDER;
    if (limitId === CODEX_MAIN_LIMIT_ID) {
      // "codex" is now a generic family id, not proof that this is the main
      // quota. The active turn's exact Spark model is the only allowed
      // override; absent that evidence, preserve the generic main behavior.
      return providerHint === CODEX_SPARK_QUOTA_PROVIDER
        ? CODEX_SPARK_QUOTA_PROVIDER
        : CODEX_MAIN_QUOTA_PROVIDER;
    }
    // A new named quota must never silently become the main quota. Support it
    // only after its semantics and UI have been intentionally designed.
    return null;
  }

  // Narrow compatibility fallback: real Spark reports observed before this
  // fix consistently carry both this exact name and the id above. If a future
  // CLI omits only the id, keep Spark isolated. No substring/fuzzy matching.
  if (normalizedIdentity(rateLimits.limit_name) === normalizedIdentity(CODEX_SPARK_LIMIT_NAME)) {
    return CODEX_SPARK_QUOTA_PROVIDER;
  }

  if (providerHint === CODEX_SPARK_QUOTA_PROVIDER) {
    return CODEX_SPARK_QUOTA_PROVIDER;
  }

  // Older Codex token_count payloads had no identity fields. Preserve their
  // established generic-quota behavior.
  return CODEX_MAIN_QUOTA_PROVIDER;
}

function resolveCodexRateLimitReport(payload, options = {}) {
  const rateLimits = payload && typeof payload.rate_limits === "object" ? payload.rate_limits : null;
  if (!rateLimits) return null;
  const providerKey = resolveCodexRateLimitProvider(rateLimits, options);
  if (!providerKey) return null;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  // options.capturedAt: the rollout line's own timestamp (epoch-ms), stamped
  // onto every bucket so the account store can order writes by observation
  // time instead of receive time (see quota-bucket.js normalizeQuotaBucket).
  const capturedAt = Number(options.capturedAt);
  const quota = normalizeQuotaGroup(
    convertCodexRateLimitsPayload(rateLimits, nowMs, capturedAt),
    CODEX_QUOTA_FIELDS
  );
  return quota ? { providerKey, quota } : null;
}

// Compatibility helper for callers interested in the generic account quota
// only. Production monitors use resolveCodexRateLimitReport so identity can
// never be discarded before routing.
function resolveCodexRateLimitQuota(payload, options = {}) {
  const report = resolveCodexRateLimitReport(payload, options);
  return report && report.providerKey === CODEX_MAIN_QUOTA_PROVIDER
    ? report.quota
    : null;
}

// Freshness gate for the rollout line's own envelope timestamp.
function isFreshCodexQuotaTimestamp(timestamp, nowMs = Date.now()) {
  const capturedAt = Date.parse(timestamp);
  if (!Number.isFinite(capturedAt)) return false;
  const age = nowMs - capturedAt;
  return age <= CODEX_QUOTA_MAX_AGE_MS && age >= -CODEX_QUOTA_MAX_FUTURE_SKEW_MS;
}

module.exports = {
  resolveCodexRateLimitQuota,
  resolveCodexRateLimitReport,
  resolveCodexRateLimitProvider,
  resolveCodexModelQuotaProvider,
  isFreshCodexQuotaTimestamp,
  CODEX_QUOTA_FIELDS,
  CODEX_MAIN_LIMIT_ID,
  CODEX_SPARK_LIMIT_ID,
  CODEX_SPARK_LIMIT_NAME,
  CODEX_SPARK_MODEL,
  CODEX_MAIN_QUOTA_PROVIDER,
  CODEX_SPARK_QUOTA_PROVIDER,
  CODEX_QUOTA_MAX_AGE_MS,
  CODEX_QUOTA_MAX_FUTURE_SKEW_MS,
};
