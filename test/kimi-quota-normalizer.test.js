"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const {
  KIMI_QUOTA_FIELDS,
  KimiQuotaSchemaError,
  normalizeKimiQuotaResponse,
} = require("../src/kimi-quota-normalizer");

const PHASE0_FIXTURE = JSON.parse(fs.readFileSync(path.join(
  __dirname,
  "fixtures",
  "kimi-quota",
  "phase0-known-fields.json",
), "utf8"));

function weekly(detail, extras = {}) {
  return { usage: detail, ...extras };
}

function fiveHour(detail, window = { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }) {
  return { limits: [{ window, detail }] };
}

function assertSchemaError(fn, reason) {
  assert.throws(fn, (error) => (
    error instanceof KimiQuotaSchemaError && (!reason || error.reason === reason)
  ));
}

describe("Kimi quota normalizer", () => {
  it("normalizes the real Phase 0 remaining-only known fields", () => {
    const capturedAt = Date.parse("2026-08-14T12:00:32.504Z");
    const result = normalizeKimiQuotaResponse(PHASE0_FIXTURE, { capturedAt });
    assert.deepStrictEqual(KIMI_QUOTA_FIELDS, ["kimiFiveHour", "kimiWeekly"]);
    assert.deepStrictEqual(result, {
      kimiWeekly: {
        usedPercent: 0,
        windowMinutes: 10080,
        resetAt: Date.parse("2026-08-21T01:20:19.901916Z"),
        capturedAt,
      },
      kimiFiveHour: {
        usedPercent: 0,
        windowMinutes: 300,
        resetAt: Date.parse("2026-08-14T16:20:19.901916Z"),
        capturedAt,
      },
    });
    assert.strictEqual(result.totalQuota, undefined);
  });

  it("accepts used/limit numbers and decimal strings", () => {
    const result = normalizeKimiQuotaResponse({
      usage: { used: "40", limit: "1000", resetTime: "2026-08-21T00:00:00Z" },
      limits: [{
        window: { duration: "5", timeUnit: "hour" },
        detail: { used: 1, limit: 100, resetTime: "2026-08-14T16:00:00Z" },
      }],
    }, { capturedAt: 123 });
    assert.strictEqual(result.kimiWeekly.usedPercent, 4);
    assert.strictEqual(result.kimiFiveHour.usedPercent, 1);
  });

  it("supports explicit presence-aware partial responses", () => {
    assert.deepStrictEqual(Object.keys(normalizeKimiQuotaResponse(weekly({
      remaining: "90", limit: "100", resetTime: "2026-08-21T00:00:00Z",
    }))), ["kimiWeekly"]);
    assert.deepStrictEqual(Object.keys(normalizeKimiQuotaResponse(fiveHour({
      remaining: "90", limit: "100", resetTime: "2026-08-14T16:00:00Z",
    }))), ["kimiFiveHour"]);
  });

  it("ignores unknown windows and unknown financial/top-level fields", () => {
    const result = normalizeKimiQuotaResponse({
      usage: { remaining: 75, limit: 100, resetTime: "2026-08-21T00:00:00Z" },
      limits: [{
        window: { duration: 30, timeUnit: "TIME_UNIT_DAY" },
        detail: null,
      }],
      boosterWallet: { balance: "sensitive" },
      totalQuota: { value: "unreliable" },
      account: { email: "private@example.invalid" },
    });
    assert.deepStrictEqual(Object.keys(result), ["kimiWeekly"]);
    assert.strictEqual(result.kimiWeekly.usedPercent, 25);
  });

  it("fails closed for malformed present candidates and containers", () => {
    assertSchemaError(() => normalizeKimiQuotaResponse(null), "root-not-object");
    assertSchemaError(() => normalizeKimiQuotaResponse({ usage: null }), "candidate-not-object");
    assertSchemaError(() => normalizeKimiQuotaResponse({ limits: {} }), "limits-not-array");
    assertSchemaError(() => normalizeKimiQuotaResponse({ usage: {
      remaining: "90", limit: "100",
    } }), "candidate-resetTime-missing");
    assertSchemaError(() => normalizeKimiQuotaResponse({ limits: [{
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: null,
    }] }), "candidate-not-object");
  });

  it("rejects invalid decimals, limits, and remaining ranges", () => {
    const invalidDetails = [
      { remaining: "", limit: "100" },
      { remaining: "1e2", limit: "100" },
      { remaining: "0x10", limit: "100" },
      { remaining: {}, limit: "100" },
      { remaining: -1, limit: 100 },
      { remaining: 1, limit: 0 },
      { remaining: 101, limit: 100 },
      { used: Number.NaN, limit: 100 },
      { used: Number.POSITIVE_INFINITY, limit: 100 },
    ];
    for (const detail of invalidDetails) {
      assertSchemaError(() => normalizeKimiQuotaResponse(weekly({
        ...detail,
        resetTime: "2026-08-21T00:00:00Z",
      })));
    }
  });

  it("checks used+remaining with the fixed relative tolerance", () => {
    const base = { limit: 100, resetTime: "2026-08-21T00:00:00Z" };
    assert.doesNotThrow(() => normalizeKimiQuotaResponse(weekly({
      ...base, used: 40.00005, remaining: 60,
    })));
    assertSchemaError(() => normalizeKimiQuotaResponse(weekly({
      ...base, used: 40.001, remaining: 60,
    })), "used-remaining-conflict");
  });

  it("clamps over-limit used values through the shared quota bucket contract", () => {
    const result = normalizeKimiQuotaResponse(weekly({
      used: 120,
      limit: 100,
      resetTime: "2026-08-21T00:00:00Z",
    }));
    assert.strictEqual(result.kimiWeekly.usedPercent, 100);
  });

  it("deduplicates identical 5-hour entries and rejects conflicts", () => {
    const item = {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { remaining: 80, limit: 100, resetTime: "2026-08-14T16:00:00Z" },
    };
    const same = normalizeKimiQuotaResponse({ limits: [item, structuredClone(item)] });
    assert.strictEqual(same.kimiFiveHour.usedPercent, 20);

    const conflict = structuredClone(item);
    conflict.detail.remaining = 70;
    assertSchemaError(
      () => normalizeKimiQuotaResponse({ limits: [item, conflict] }),
      "five-hour-duplicate-conflict",
    );
  });

  it("requires at least one supported bucket and a valid reset timestamp", () => {
    assertSchemaError(() => normalizeKimiQuotaResponse({ limits: [] }), "no-supported-buckets");
    assertSchemaError(() => normalizeKimiQuotaResponse({ limits: [{
      window: { duration: 60, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { remaining: 1, limit: 100, resetTime: "not-a-time" },
    }] }), "no-supported-buckets");
    assertSchemaError(() => normalizeKimiQuotaResponse(weekly({
      remaining: 1, limit: 100, resetTime: "not-a-time",
    })), "resetTime-invalid");
  });
});
