"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  extractCodexRateLimitsFromLine,
  extractCodexRateLimitsFromJsonl,
  normalizeClaudeUsageResponse,
} = require("../src/usage-parsers");

describe("usage parsers", () => {
  it("extracts Codex rollout rate_limits from JSONL lines", () => {
    const line = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 42.5, window_minutes: 300, resets_at: 1800000000 },
          secondary: { used_percent: 61, window_minutes: 10080, resets_at: 1800600000 },
        },
      },
    });

    const parsed = extractCodexRateLimitsFromLine(line);
    assert.strictEqual(parsed.provider, "codex");
    assert.strictEqual(parsed.limits.length, 2);
    assert.strictEqual(parsed.limits[0].id, "codex.primary");
    assert.strictEqual(parsed.limits[0].usedPercent, 42.5);
    assert.strictEqual(parsed.limits[0].severity, "green");
    assert.strictEqual(parsed.limits[0].resetsAtMs, 1800000000 * 1000);
    assert.strictEqual(parsed.limits[1].id, "codex.secondary");
    assert.strictEqual(parsed.limits[1].severity, "yellow");
  });

  it("keeps the latest Codex rate_limits record and ignores missing data", () => {
    const jsonl = [
      JSON.stringify({ type: "event_msg", payload: { type: "other" } }),
      JSON.stringify({ type: "event_msg", payload: { rate_limits: { primary: { used_percent: 20, resets_at: 1 } } } }),
      "{bad json",
      JSON.stringify({ type: "event_msg", payload: { rate_limits: { primary: { used_percent: 90, resets_at: 2 } } } }),
    ].join("\n");

    const parsed = extractCodexRateLimitsFromJsonl(jsonl);
    assert.strictEqual(parsed.limits.length, 1);
    assert.strictEqual(parsed.limits[0].usedPercent, 90);
    assert.strictEqual(parsed.limits[0].severity, "red");
  });

  it("normalizes Claude usage response windows", () => {
    const parsed = normalizeClaudeUsageResponse({
      five_hour: { utilization: 0.5, resets_at: "2026-05-29T12:00:00.000Z" },
      seven_day: { utilization: 70, resets_at: 1800000000 },
      seven_day_opus: { utilization: 0.86, resets_at: 1800001000 },
      seven_day_sonnet: { utilization: 8, resets_at: 1800002000 },
    });

    assert.deepStrictEqual(parsed.limits.map((l) => l.id), [
      "claude.five_hour",
      "claude.seven_day",
      "claude.seven_day_opus",
      "claude.seven_day_sonnet",
    ]);
    assert.strictEqual(parsed.limits[0].usedPercent, 50);
    assert.strictEqual(parsed.limits[1].severity, "yellow");
    assert.strictEqual(parsed.limits[2].severity, "red");
    assert.strictEqual(parsed.limits[3].severity, "green");
  });

  it("degrades to empty provider data for failed or missing shapes", () => {
    assert.deepStrictEqual(extractCodexRateLimitsFromLine("{bad"), null);
    assert.deepStrictEqual(extractCodexRateLimitsFromJsonl(""), { provider: "codex", limits: [] });
    assert.deepStrictEqual(normalizeClaudeUsageResponse(null), { provider: "claude", limits: [] });
    assert.deepStrictEqual(normalizeClaudeUsageResponse({ five_hour: {} }), { provider: "claude", limits: [] });
  });
});
