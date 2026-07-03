"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { resolveClaudeRateLimitQuota, resolveClaudeModelLabel } = require("../hooks/claude-rate-limits");

describe("Claude Code rate limit quota parser", () => {
  it("maps five_hour and seven_day into claudeFiveHour/claudeWeekly, converting resets_at to epoch-ms", () => {
    const quota = resolveClaudeRateLimitQuota({
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
        seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
      },
    });

    assert.deepStrictEqual(quota, {
      claudeFiveHour: { usedPercent: 24, resetAt: 1738425600 * 1000 },
      claudeWeekly: { usedPercent: 41, resetAt: 1738857600 * 1000 },
    });
  });

  it("keeps a bucket without resets_at (usedPercent only)", () => {
    const quota = resolveClaudeRateLimitQuota({
      rate_limits: { five_hour: { used_percentage: 10 } },
    });
    assert.deepStrictEqual(quota, { claudeFiveHour: { usedPercent: 10 } });
  });

  it("drops an individually malformed bucket but keeps the rest", () => {
    const quota = resolveClaudeRateLimitQuota({
      rate_limits: {
        five_hour: { used_percentage: "nope" },
        seven_day: { used_percentage: 5 },
      },
    });
    assert.deepStrictEqual(quota, { claudeWeekly: { usedPercent: 5 } });
  });

  it("returns null when rate_limits is absent (API key users, or before first response)", () => {
    assert.strictEqual(resolveClaudeRateLimitQuota({}), null);
    assert.strictEqual(resolveClaudeRateLimitQuota(null), null);
    assert.strictEqual(resolveClaudeRateLimitQuota({ rate_limits: {} }), null);
  });

  it("resolves model label preferring display_name over id", () => {
    assert.strictEqual(
      resolveClaudeModelLabel({ model: { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" } }),
      "Claude Sonnet 5"
    );
    assert.strictEqual(resolveClaudeModelLabel({ model: { id: "claude-sonnet-5" } }), "claude-sonnet-5");
    assert.strictEqual(resolveClaudeModelLabel({}), null);
  });
});
