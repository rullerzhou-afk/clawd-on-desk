"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { priceFor, costOf } = require("../src/usage-pricing");

test("priceFor matches Claude models incl. dated transcript ids", () => {
  assert.strictEqual(priceFor("claude-opus-4-8").input, 5);
  assert.strictEqual(priceFor("claude-opus-4-8").output, 25);
  // real Claude Code transcript model carries a date suffix -> prefix match
  assert.strictEqual(priceFor("claude-sonnet-4-5-20250929").input, 3);
  assert.strictEqual(priceFor("claude-haiku-4-5-20251001").input, 1);
  // legacy opus 4 / 4.1 keep the old 15/75 list price
  assert.strictEqual(priceFor("claude-opus-4-1-20250805").input, 15);
});

test("priceFor matches GPT-5.x / Codex without confusing gpt-5 with gpt-5.6", () => {
  assert.strictEqual(priceFor("gpt-5-codex").input, 1.25);
  assert.strictEqual(priceFor("gpt-5.1-codex-max").input, 1.25);
  assert.strictEqual(priceFor("gpt-5.6-sol").input, 5);
  assert.strictEqual(priceFor("gpt-5.6").output, 30);
});

test("priceFor distinguishes gemini flash vs flash-lite", () => {
  assert.strictEqual(priceFor("gemini-2.5-flash").input, 0.3);
  assert.strictEqual(priceFor("gemini-2.5-flash-lite").input, 0.1);
  assert.strictEqual(priceFor("gemini-2.5-pro").output, 10);
});

test("priceFor returns null for unknown", () => {
  assert.strictEqual(priceFor("totally-unknown-model"), null);
  assert.strictEqual(priceFor(""), null);
});

test("costOf computes per-bucket cost for a known model", () => {
  const c = costOf({ model: "claude-sonnet-5", input: 1000, output: 500, cacheRead: 200, cacheCreation: 100 });
  // 1000*3 + 500*15 + 200*0.3 + 100*3.75, all /1e6
  assert.ok(Math.abs(c - 0.010935) < 1e-9);
});

test("costOf is 0 for an unknown model", () => {
  assert.strictEqual(costOf({ model: "mystery", input: 1000, output: 1000, cacheRead: 0, cacheCreation: 0 }), 0);
});
