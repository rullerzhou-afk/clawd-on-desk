"use strict";

// Per-model pricing (USD per 1,000,000 tokens): [input, output, cacheRead,
// cacheCreation]. Values copied from cc-switch's seed_model_pricing table
// (database/schema.rs). Input is FRESH input (cache buckets billed separately).
// Unknown model -> cost 0.
//
// Matching mirrors cc-switch (exact, then prefix): the list is ordered
// most-specific-first and priceFor returns the first entry whose lowercased
// model id equals or starts with the key. So a real transcript model like
// "claude-sonnet-4-5-20250929" prefix-matches "claude-sonnet-4-5", and
// "gpt-5.6-sol" is matched before the generic "gpt-5".

const PRICING_TABLE = Object.freeze([
  // Claude — newest / most specific first; generic families last
  ["claude-fable-5", { input: 10, output: 50, cacheRead: 1.0, cacheCreation: 12.5 }],
  ["claude-mythos-5", { input: 10, output: 50, cacheRead: 1.0, cacheCreation: 12.5 }],
  ["claude-opus-4-8", { input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25 }],
  ["claude-opus-4-7", { input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25 }],
  ["claude-opus-4-6", { input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25 }],
  ["claude-opus-4-5", { input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25 }],
  ["claude-opus-4-1", { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 }],
  ["claude-opus-4", { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 }],
  ["claude-sonnet-5", { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 }],
  ["claude-sonnet-4-6", { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 }],
  ["claude-sonnet-4-5", { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 }],
  ["claude-sonnet-4", { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 }],
  ["claude-3-5-sonnet", { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 }],
  ["claude-sonnet", { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 }],
  ["claude-haiku-4-5", { input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25 }],
  ["claude-3-5-haiku", { input: 0.8, output: 4, cacheRead: 0.08, cacheCreation: 1 }],
  ["claude-haiku", { input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25 }],
  ["claude-opus", { input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25 }],
  // OpenAI GPT-5.x — specific before generic; gpt-5 last so it can't shadow gpt-5.6
  ["gpt-5.6-terra", { input: 2.5, output: 15, cacheRead: 0.25, cacheCreation: 3.125 }],
  ["gpt-5.6-luna", { input: 1, output: 6, cacheRead: 0.1, cacheCreation: 1.25 }],
  ["gpt-5.6-sol", { input: 5, output: 30, cacheRead: 0.5, cacheCreation: 6.25 }],
  ["gpt-5.6", { input: 5, output: 30, cacheRead: 0.5, cacheCreation: 6.25 }],
  ["gpt-5.5", { input: 5, output: 30, cacheRead: 0.5, cacheCreation: 0 }],
  ["gpt-5.4-mini", { input: 0.75, output: 4.5, cacheRead: 0.075, cacheCreation: 0 }],
  ["gpt-5.4-nano", { input: 0.2, output: 1.25, cacheRead: 0.02, cacheCreation: 0 }],
  ["gpt-5.4", { input: 2.5, output: 15, cacheRead: 0.25, cacheCreation: 0 }],
  ["gpt-5.3-codex", { input: 1.75, output: 14, cacheRead: 0.175, cacheCreation: 0 }],
  ["gpt-5.2-codex", { input: 1.75, output: 14, cacheRead: 0.175, cacheCreation: 0 }],
  ["gpt-5.2", { input: 1.75, output: 14, cacheRead: 0.175, cacheCreation: 0 }],
  ["gpt-5.1-codex", { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 0 }],
  ["gpt-5.1", { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 0 }],
  ["gpt-5-codex", { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 0 }],
  ["gpt-5", { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 0 }],
  ["gpt-4.1-mini", { input: 0.4, output: 1.6, cacheRead: 0.1, cacheCreation: 0 }],
  ["gpt-4.1-nano", { input: 0.1, output: 0.4, cacheRead: 0.025, cacheCreation: 0 }],
  ["gpt-4.1", { input: 2, output: 8, cacheRead: 0.5, cacheCreation: 0 }],
  ["gpt-4o-mini", { input: 0.15, output: 0.6, cacheRead: 0.075, cacheCreation: 0 }],
  ["gpt-4o", { input: 2.5, output: 10, cacheRead: 1.25, cacheCreation: 0 }],
  ["o4-mini", { input: 1.1, output: 4.4, cacheRead: 0.275, cacheCreation: 0 }],
  ["o3", { input: 2, output: 8, cacheRead: 0.5, cacheCreation: 0 }],
  // Gemini — flash-lite before flash before generic
  ["gemini-3.5-flash", { input: 1.5, output: 9, cacheRead: 0.15, cacheCreation: 0 }],
  ["gemini-3.1-pro", { input: 2, output: 12, cacheRead: 0.2, cacheCreation: 0 }],
  ["gemini-3.1-flash-lite", { input: 0.25, output: 1.5, cacheRead: 0.025, cacheCreation: 0 }],
  ["gemini-3-pro", { input: 2, output: 12, cacheRead: 0.2, cacheCreation: 0 }],
  ["gemini-3-flash", { input: 0.5, output: 3, cacheRead: 0.05, cacheCreation: 0 }],
  ["gemini-2.5-pro", { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 0 }],
  ["gemini-2.5-flash-lite", { input: 0.1, output: 0.4, cacheRead: 0.01, cacheCreation: 0 }],
  ["gemini-2.5-flash", { input: 0.3, output: 2.5, cacheRead: 0.03, cacheCreation: 0 }],
  ["gemini-2.0-flash", { input: 0.1, output: 0.4, cacheRead: 0.025, cacheCreation: 0 }],
  ["gemini", { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 0 }],
]);

function priceFor(model) {
  const m = typeof model === "string" ? model.toLowerCase().trim() : "";
  if (!m) return null;
  for (const [key, pricing] of PRICING_TABLE) {
    if (m === key || m.startsWith(key)) return pricing;
  }
  return null;
}

function num(v) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; }

function costOf(record) {
  const p = priceFor(record && record.model);
  if (!p) return 0;
  const million = 1000000;
  return (
    num(record.input) * p.input +
    num(record.output) * p.output +
    num(record.cacheRead) * p.cacheRead +
    num(record.cacheCreation) * p.cacheCreation
  ) / million;
}

module.exports = { priceFor, costOf, PRICING_TABLE };
