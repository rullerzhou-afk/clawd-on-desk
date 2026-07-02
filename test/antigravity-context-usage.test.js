"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  resolveAntigravityContextUsage,
  resolveAntigravityModelLabel,
  resolveAntigravityQuota,
} = require("../hooks/antigravity-context-usage");

describe("Antigravity context usage parser", () => {
  it("builds used/limit/percent from total input+output tokens and used_percentage", () => {
    const usage = resolveAntigravityContextUsage({
      context_window: {
        context_window_size: 1000000,
        used_percentage: 2.3,
        total_input_tokens: 23003,
        total_output_tokens: 313,
      },
    });

    assert.deepStrictEqual(usage, {
      used: 23316,
      source: "antigravity",
      limit: 1000000,
      percent: 2,
    });
  });

  it("derives used from used_percentage when token counts are absent", () => {
    const usage = resolveAntigravityContextUsage({
      context_window: {
        context_window_size: 200000,
        used_percentage: 50,
      },
    });

    assert.deepStrictEqual(usage, {
      used: 100000,
      source: "antigravity",
      limit: 200000,
      percent: 50,
    });
  });

  it("returns raw used without limit/percent when context_window_size is missing", () => {
    const usage = resolveAntigravityContextUsage({
      context_window: {
        total_input_tokens: 500,
        total_output_tokens: 10,
      },
    });

    assert.deepStrictEqual(usage, { used: 510, source: "antigravity" });
  });

  it("returns null when there is no context_window field", () => {
    assert.strictEqual(resolveAntigravityContextUsage({}), null);
    assert.strictEqual(resolveAntigravityContextUsage(null), null);
  });

  it("returns null when context_window has no usable numeric fields", () => {
    assert.strictEqual(resolveAntigravityContextUsage({ context_window: {} }), null);
  });

  it("clamps percent to [0, 100]", () => {
    const usage = resolveAntigravityContextUsage({
      context_window: { context_window_size: 1000, used_percentage: 142 },
    });
    assert.strictEqual(usage.percent, 100);
  });

  it("prefers model.display_name over model.id", () => {
    assert.strictEqual(
      resolveAntigravityModelLabel({ model: { id: "gemini-pro-agent", display_name: "Gemini 3.1 Pro (High)" } }),
      "Gemini 3.1 Pro (High)"
    );
    assert.strictEqual(
      resolveAntigravityModelLabel({ model: { id: "gemini-pro-agent" } }),
      "gemini-pro-agent"
    );
    assert.strictEqual(resolveAntigravityModelLabel({}), null);
    assert.strictEqual(resolveAntigravityModelLabel(null), null);
  });
});

describe("Antigravity account quota parser", () => {
  it("maps all four buckets from remaining_fraction to a rounded usedPercent (inverted)", () => {
    const quota = resolveAntigravityQuota({
      quota: {
        "gemini-5h": { remaining_fraction: 0.9977, reset_in_seconds: 16920 },
        "gemini-weekly": { remaining_fraction: 0.9813, reset_in_seconds: 431180 },
        "3p-5h": { remaining_fraction: 1 },
        "3p-weekly": { remaining_fraction: 0.6918, reset_in_seconds: 431100 },
      },
    });

    assert.deepStrictEqual(quota, {
      geminiFiveHour: { usedPercent: 0, resetInSeconds: 16920 },
      geminiWeekly: { usedPercent: 2, resetInSeconds: 431180 },
      thirdPartyFiveHour: { usedPercent: 0 },
      thirdPartyWeekly: { usedPercent: 31, resetInSeconds: 431100 },
    });
  });

  it("drops individual buckets with no numeric remaining_fraction but keeps the rest", () => {
    const quota = resolveAntigravityQuota({
      quota: {
        "gemini-5h": { remaining_fraction: 0.5 },
        "gemini-weekly": {},
        "3p-5h": null,
      },
    });

    assert.deepStrictEqual(quota, { geminiFiveHour: { usedPercent: 50 } });
  });

  it("returns null when there is no quota field or no usable buckets", () => {
    assert.strictEqual(resolveAntigravityQuota({}), null);
    assert.strictEqual(resolveAntigravityQuota(null), null);
    assert.strictEqual(resolveAntigravityQuota({ quota: {} }), null);
    assert.strictEqual(resolveAntigravityQuota({ quota: { "gemini-5h": {} } }), null);
  });

  it("clamps out-of-range fractions into [0, 100]", () => {
    const quota = resolveAntigravityQuota({
      quota: { "gemini-5h": { remaining_fraction: 1.4 }, "gemini-weekly": { remaining_fraction: -0.2 } },
    });
    assert.strictEqual(quota.geminiFiveHour.usedPercent, 0);
    assert.strictEqual(quota.geminiWeekly.usedPercent, 100);
  });
});
