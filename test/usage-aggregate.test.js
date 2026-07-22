"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { aggregateUsage, aggregateByModel, aggregateByAgent } = require("../src/usage-aggregate");

test("aggregates totals, tokens, and cache hit rate", () => {
  const recs = [
    { input: 100, output: 50, cacheRead: 400, cacheCreation: 20, model: "claude-sonnet-5", status: 200 },
    { input: 200, output: 60, cacheRead: 0, cacheCreation: 0, model: "gpt-4o", status: 200 },
  ];
  const a = aggregateUsage(recs);
  assert.strictEqual(a.requests, 2);
  assert.strictEqual(a.input, 300);
  assert.strictEqual(a.output, 110);
  assert.strictEqual(a.cacheRead, 400);
  assert.strictEqual(a.cacheCreation, 20);
  assert.strictEqual(a.totalTokens, 830);
  assert.ok(Math.abs(a.cacheHitRate - 400 / 720) < 1e-9);
  assert.ok(a.cost > 0);
});

test("empty input yields zeroed stats, no NaN", () => {
  const a = aggregateUsage([]);
  assert.strictEqual(a.requests, 0);
  assert.strictEqual(a.totalTokens, 0);
  assert.strictEqual(a.cost, 0);
  assert.strictEqual(a.cacheHitRate, 0);
});

test("aggregateByModel groups + sorts by tokens desc", () => {
  const recs = [
    { agentId: "claude-code", model: "claude-opus-4-8", input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
    { agentId: "codex", model: "gpt-5.6-sol", input: 100, output: 20, cacheRead: 0, cacheCreation: 0 },
    { agentId: "claude-code", model: "claude-opus-4-8", input: 5, output: 5, cacheRead: 0, cacheCreation: 0 },
  ];
  const rows = aggregateByModel(recs);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].key, "gpt-5.6-sol"); // 120 tokens > opus 25
  assert.strictEqual(rows[1].key, "claude-opus-4-8");
  assert.strictEqual(rows[1].requests, 2);
  assert.strictEqual(rows[1].totalTokens, 25);
});

test("aggregateByAgent groups by agentId", () => {
  const recs = [
    { agentId: "claude-code", model: "claude-opus-4-8", input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
    { agentId: "codex", model: "gpt-5.6-sol", input: 100, output: 20, cacheRead: 0, cacheCreation: 0 },
  ];
  const rows = aggregateByAgent(recs);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].key, "codex");
  assert.strictEqual(rows[0].requests, 1);
});
