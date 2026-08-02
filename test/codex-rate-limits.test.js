"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  resolveCodexRateLimitQuota,
  resolveCodexRateLimitReport,
  isFreshCodexQuotaTimestamp,
  CODEX_QUOTA_MAX_AGE_MS,
} = require("../hooks/codex-rate-limits");

describe("Codex rate limit quota parser", () => {
  it("maps reported short/long windows and preserves their real durations", () => {
    // Shape captured from a real rollout token_count event (plan "plus").
    const quota = resolveCodexRateLimitQuota({
      rate_limits: {
        limit_id: "codex",
        primary: { used_percent: 1.0, window_minutes: 300, resets_at: 1783669570 },
        secondary: { used_percent: 42.6, window_minutes: 10080, resets_at: 1784256370 },
        plan_type: "plus",
      },
    });

    assert.deepStrictEqual(quota, {
      codexFiveHour: { usedPercent: 1, windowMinutes: 300, resetAt: 1783669570 * 1000 },
      codexWeekly: { usedPercent: 43, windowMinutes: 10080, resetAt: 1784256370 * 1000 },
    });
  });

  it("routes a real Spark dual-window shape to its independent provider", () => {
    // Sanitized shape captured from a real event_msg:token_count report.
    const report = resolveCodexRateLimitReport({
      rate_limits: {
        limit_id: "codex_bengalfox",
        limit_name: "GPT-5.3-Codex-Spark",
        primary: { used_percent: 7, window_minutes: 300, resets_at: 1783669570 },
        secondary: { used_percent: 19, window_minutes: 10080, resets_at: 1784256370 },
      },
    });

    assert.deepStrictEqual(report, {
      providerKey: "codexSparkQuota",
      quota: {
        codexFiveHour: { usedPercent: 7, windowMinutes: 300, resetAt: 1783669570 * 1000 },
        codexWeekly: { usedPercent: 19, windowMinutes: 10080, resetAt: 1784256370 * 1000 },
      },
    });
    assert.strictEqual(resolveCodexRateLimitQuota({
      rate_limits: {
        limit_id: "codex_bengalfox",
        primary: { used_percent: 7, window_minutes: 300 },
      },
    }), null, "generic-only compatibility helper must not flatten Spark");
  });

  it("routes a real Spark lone-weekly shape without fabricating a short window", () => {
    const report = resolveCodexRateLimitReport({
      rate_limits: {
        limit_id: "codex_bengalfox",
        limit_name: "GPT-5.3-Codex-Spark",
        primary: { used_percent: 0, window_minutes: 10080, resets_at: 1785284243 },
        secondary: null,
      },
    });

    assert.deepStrictEqual(report, {
      providerKey: "codexSparkQuota",
      quota: {
        codexWeekly: {
          usedPercent: 0,
          windowMinutes: 10080,
          resetAt: 1785284243 * 1000,
        },
      },
    });
  });

  it("uses the active turn model to disambiguate the generic codex limit id", () => {
    const payload = {
      rate_limits: {
        limit_id: "codex",
        primary: { used_percent: 0, window_minutes: 10080 },
      },
    };

    assert.strictEqual(resolveCodexRateLimitReport(payload, {
      model: "gpt-5.3-codex-spark",
    }).providerKey, "codexSparkQuota");
    assert.strictEqual(resolveCodexRateLimitReport(payload, {
      model: "gpt-5.6-sol",
    }).providerKey, "codexQuota");
    assert.strictEqual(resolveCodexRateLimitReport(payload).providerKey, "codexQuota");

    assert.strictEqual(resolveCodexRateLimitReport({
      rate_limits: {
        limit_id: "codex_future_model",
        primary: { used_percent: 99, window_minutes: 10080 },
      },
    }, {
      model: "gpt-5.3-codex-spark",
    }), null, "a Spark model hint must not bypass an unknown explicit id");

    assert.strictEqual(resolveCodexRateLimitReport({
      rate_limits: {
        limit_id: "codex_bengalfox",
        primary: { used_percent: 7, window_minutes: 10080 },
      },
    }, {
      model: "gpt-5.6-sol",
    }).providerKey, "codexSparkQuota", "the explicit Spark id remains authoritative");
  });

  it("uses exact Spark name only as a missing-id fallback", () => {
    const report = resolveCodexRateLimitReport({
      rate_limits: {
        limit_name: "  gpt-5.3-codex-spark  ",
        primary: { used_percent: 5, window_minutes: 10080 },
      },
    });
    assert.strictEqual(report.providerKey, "codexSparkQuota");

    const generic = resolveCodexRateLimitReport({
      rate_limits: {
        limit_name: "Codex",
        primary: { used_percent: 5, window_minutes: 10080 },
      },
    });
    assert.strictEqual(generic.providerKey, "codexQuota");
  });

  it("ignores an unknown non-empty limit id instead of polluting the main quota", () => {
    assert.strictEqual(resolveCodexRateLimitReport({
      rate_limits: {
        limit_id: "codex_future_model",
        limit_name: "GPT-Next",
        primary: { used_percent: 99, window_minutes: 10080 },
      },
    }), null);
    assert.strictEqual(resolveCodexRateLimitReport({
      rate_limits: {
        limit_id: "codex_future_model",
        limit_name: "GPT-5.3-Codex-Spark",
        primary: { used_percent: 99, window_minutes: 10080 },
      },
    }), null, "a known name must not override an unknown present id");
    assert.strictEqual(resolveCodexRateLimitReport({
      rate_limits: {
        limit_id: 42,
        primary: { used_percent: 99, window_minutes: 10080 },
      },
    }), null, "a malformed present id must also fail closed");
  });

  it("maps a lone 7-day primary to the long slot instead of fabricating a 5h limit", () => {
    // Current Pro telemetry (2026-07): primary is the only bucket and is
    // explicitly a seven-day window; secondary is null.
    const quota = resolveCodexRateLimitQuota({
      rate_limits: {
        primary: { used_percent: 12, window_minutes: 10080, resets_at: 1785284243 },
        secondary: null,
      },
    });

    assert.deepStrictEqual(quota, {
      codexWeekly: {
        usedPercent: 12,
        windowMinutes: 10080,
        resetAt: 1785284243 * 1000,
      },
    });
    assert.strictEqual(quota.codexFiveHour, undefined);
  });

  it("uses duration rather than primary/secondary position when the order changes", () => {
    const quota = resolveCodexRateLimitQuota({
      rate_limits: {
        primary: { used_percent: 40, window_minutes: 10080 },
        secondary: { used_percent: 20, window_minutes: 300 },
      },
    });
    assert.deepStrictEqual(quota, {
      codexWeekly: { usedPercent: 40, windowMinutes: 10080 },
      codexFiveHour: { usedPercent: 20, windowMinutes: 300 },
    });
  });

  it("anchors a legacy relative resets_in_seconds to receive time, minute-quantized", () => {
    const nowMs = 1783600000123;
    const quota = resolveCodexRateLimitQuota(
      {
        rate_limits: {
          primary: { used_percent: 10, resets_in_seconds: 90 },
        },
      },
      { nowMs }
    );

    const resetAt = quota.codexFiveHour.resetAt;
    assert.strictEqual(resetAt % 60000, 0);
    assert.ok(Math.abs(resetAt - (nowMs + 90 * 1000)) <= 30000);
  });

  it("keeps a bucket without any reset field (usedPercent only)", () => {
    const quota = resolveCodexRateLimitQuota({
      rate_limits: { primary: { used_percent: 10 } },
    });
    assert.deepStrictEqual(quota, { codexFiveHour: { usedPercent: 10 } });
  });

  it("drops an individually malformed bucket but keeps the rest", () => {
    const quota = resolveCodexRateLimitQuota({
      rate_limits: {
        primary: { used_percent: "nope" },
        secondary: { used_percent: 5 },
      },
    });
    assert.deepStrictEqual(quota, { codexWeekly: { usedPercent: 5 } });
  });

  it("returns null when rate_limits is absent (API-key sessions, or non-token_count payloads)", () => {
    assert.strictEqual(resolveCodexRateLimitQuota({}), null);
    assert.strictEqual(resolveCodexRateLimitQuota(null), null);
    assert.strictEqual(resolveCodexRateLimitQuota({ rate_limits: {} }), null);
  });
});

describe("Codex quota capture freshness gate", () => {
  it("accepts a capture inside the max age and rejects an older one", () => {
    const nowMs = Date.parse("2026-07-10T12:00:00.000Z");
    assert.strictEqual(isFreshCodexQuotaTimestamp("2026-07-10T11:55:00.000Z", nowMs), true);
    assert.strictEqual(
      isFreshCodexQuotaTimestamp(new Date(nowMs - CODEX_QUOTA_MAX_AGE_MS - 1).toISOString(), nowMs),
      false
    );
  });

  it("rejects a missing or unparseable timestamp", () => {
    assert.strictEqual(isFreshCodexQuotaTimestamp(undefined), false);
    assert.strictEqual(isFreshCodexQuotaTimestamp("not-a-date"), false);
  });

  it("tolerates small forward clock skew but rejects far-future timestamps", () => {
    const nowMs = Date.parse("2026-07-10T12:00:00.000Z");
    // Writer and monitor share a machine but not a scheduler tick.
    assert.strictEqual(isFreshCodexQuotaTimestamp("2026-07-10T12:01:00.000Z", nowMs), true);
    // A clock correction or corrupt line dated ahead would otherwise be
    // re-accepted as "fresh" on every restart, forever.
    assert.strictEqual(isFreshCodexQuotaTimestamp("2026-07-10T12:10:00.000Z", nowMs), false);
    assert.strictEqual(isFreshCodexQuotaTimestamp("2027-07-10T12:00:00.000Z", nowMs), false);
  });

  it("stamps options.capturedAt onto every bucket for store-side write ordering", () => {
    const quota = resolveCodexRateLimitQuota({
      rate_limits: {
        primary: { used_percent: 1.0, window_minutes: 300, resets_at: 1783669570 },
        secondary: { used_percent: 42.6, window_minutes: 10080, resets_at: 1784256370 },
      },
    }, { capturedAt: 1783669000000 });
    assert.strictEqual(quota.codexFiveHour.capturedAt, 1783669000000);
    assert.strictEqual(quota.codexWeekly.capturedAt, 1783669000000);
    assert.strictEqual(quota.codexFiveHour.windowMinutes, 300);
    assert.strictEqual(quota.codexWeekly.windowMinutes, 10080);
  });
});
