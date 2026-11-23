"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeDeepseekBalanceResponse, buildBalanceQuota } = require("../src/deepseek-balance-normalizer");

const response = (entries) => ({ is_available: true, balance_infos: entries });
const info = (currency, total_balance) => ({ currency, total_balance });

test("DeepSeek balance selects CNY before USD and accepts USD alone", () => {
  assert.deepEqual(normalizeDeepseekBalanceResponse(response([info("USD", "12"), info("CNY", "110.00")])),
    { amount: 110, currency: "CNY" });
  assert.deepEqual(normalizeDeepseekBalanceResponse(response([info("USD", "12.00")])),
    { amount: 12, currency: "USD" });
});

test("DeepSeek balance rejects empty or malformed amounts and currencies", () => {
  for (const entries of [[], [info("EUR", "12")], ...["", " ", "NaN", "Infinity", "-1", null, 1,
    "0x10", "1e2"].map((amount) => [info("CNY", amount)])]) {
    assert.throws(() => normalizeDeepseekBalanceResponse(response(entries)));
  }
  assert.deepEqual(normalizeDeepseekBalanceResponse({ ...response([info("CNY", "0")]), is_available: false }),
    { amount: 0, currency: "CNY" });
});

test("DeepSeek fuel gauge handles first capture, spending, topups, keys, currencies and zero", () => {
  const first = buildBalanceQuota({ amount: 100, currency: "CNY" }, null, "key-a", 1000);
  assert.equal(first.record.baseline, 100);
  const spent = buildBalanceQuota({ amount: 60, currency: "CNY" }, first.record, "key-a", 2000);
  assert.equal(spent.quota.deepseekBalance.usedPercent, 40);
  const topup = buildBalanceQuota({ amount: 60.01, currency: "CNY" }, spent.record, "key-a", 3000);
  assert.equal(topup.record.baseline, 60.01);
  assert.equal(topup.quota.deepseekBalance.usedPercent, 0);
  for (const [credentialId, currency] of [["key-b", "CNY"], ["key-a", "USD"]]) {
    assert.equal(buildBalanceQuota({ amount: 40, currency }, spent.record, credentialId, 4000)
      .record.baseline, 40);
  }
  assert.equal(buildBalanceQuota({ amount: 0, currency: "CNY" }, spent.record, "key-a", 5000)
    .quota.deepseekBalance.usedPercent, 100);
  assert.equal(buildBalanceQuota({ amount: 0, currency: "CNY" }, null, "key-a", 5000)
    .quota.deepseekBalance.usedPercent, 100);
  assert.equal(buildBalanceQuota({ amount: 60, currency: "CNY" }, { ...spent.record, baseline: 0 }, "key-a", 5000)
    .quota.deepseekBalance.usedPercent, 100);
  assert.deepEqual(Object.keys(spent.quota.deepseekBalance).sort(),
    ["amount", "baseline", "capturedAt", "currency", "usedPercent"]);
});
