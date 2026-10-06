"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { normalizeQuotaBucket, normalizeQuotaGroup } = require("../hooks/quota-bucket");

describe("normalizeQuotaBucket", () => {
  it("clamps usedPercent and preserves rounded window/reset metadata", () => {
    assert.deepStrictEqual(normalizeQuotaBucket({
      usedPercent: 41.6,
      windowMinutes: 10079.6,
      resetAt: 1234.9,
    }), {
      usedPercent: 42,
      windowMinutes: 10080,
      resetAt: 1235,
    });
    assert.strictEqual(normalizeQuotaBucket({ usedPercent: 142 }).usedPercent, 100);
    assert.strictEqual(normalizeQuotaBucket({ usedPercent: -5 }).usedPercent, 0);
  });

  it("omits resetAt when absent or non-numeric", () => {
    assert.deepStrictEqual(normalizeQuotaBucket({ usedPercent: 10 }), { usedPercent: 10 });
    assert.deepStrictEqual(normalizeQuotaBucket({ usedPercent: 10, resetAt: "nope" }), { usedPercent: 10 });
  });

  it("omits invalid windowMinutes instead of inventing a label", () => {
    assert.deepStrictEqual(normalizeQuotaBucket({ usedPercent: 10, windowMinutes: 0 }), {
      usedPercent: 10,
    });
    assert.deepStrictEqual(normalizeQuotaBucket({ usedPercent: 10, windowMinutes: "nope" }), {
      usedPercent: 10,
    });
  });

  it("returns null for missing/non-numeric usedPercent", () => {
    assert.strictEqual(normalizeQuotaBucket(null), null);
    assert.strictEqual(normalizeQuotaBucket({}), null);
    assert.strictEqual(normalizeQuotaBucket({ usedPercent: "nope" }), null);
  });
});

describe("normalizeQuotaGroup", () => {
  it("keeps only the requested fields with valid buckets", () => {
    const group = normalizeQuotaGroup(
      { a: { usedPercent: 10 }, b: {}, c: { usedPercent: 20 }, extra: { usedPercent: 30 } },
      ["a", "b", "c"]
    );
    assert.deepStrictEqual(group, { a: { usedPercent: 10 }, c: { usedPercent: 20 } });
  });

  it("returns null when no field has a usable bucket", () => {
    assert.strictEqual(normalizeQuotaGroup({ a: {} }, ["a", "b"]), null);
    assert.strictEqual(normalizeQuotaGroup(null, ["a"]), null);
  });
});
