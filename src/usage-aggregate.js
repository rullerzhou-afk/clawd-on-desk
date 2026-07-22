"use strict";

// Aggregate JSONL usage records into the dashboard totals (SP4). Sums each
// token bucket, counts requests, sums per-record cost via the pricing table,
// and computes cache hit rate = cacheRead / (input + cacheCreation + cacheRead)
// — the same ratio cc-switch's usage page reports.

const { costOf } = require("./usage-pricing");

function num(v) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; }

function aggregateUsage(records) {
  const list = Array.isArray(records) ? records : [];
  let input = 0, output = 0, cacheRead = 0, cacheCreation = 0, cost = 0;
  for (const r of list) {
    input += num(r.input);
    output += num(r.output);
    cacheRead += num(r.cacheRead);
    cacheCreation += num(r.cacheCreation);
    cost += costOf(r);
  }
  const inputSide = input + cacheCreation + cacheRead;
  return {
    requests: list.length,
    input,
    output,
    cacheRead,
    cacheCreation,
    totalTokens: input + output + cacheRead + cacheCreation,
    cost,
    cacheHitRate: inputSide > 0 ? cacheRead / inputSide : 0,
  };
}

// Group records by a key (model, agent) into per-key totals, sorted by total
// tokens descending — feeds the dashboard's per-model / per-platform tables.
function aggregateBy(records, keyOf) {
  const list = Array.isArray(records) ? records : [];
  const groups = new Map();
  for (const r of list) {
    const key = keyOf(r) || "unknown";
    let g = groups.get(key);
    if (!g) { g = { key, requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 }; groups.set(key, g); }
    g.requests += 1;
    g.input += num(r.input);
    g.output += num(r.output);
    g.cacheRead += num(r.cacheRead);
    g.cacheCreation += num(r.cacheCreation);
    g.cost += costOf(r);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, totalTokens: g.input + g.output + g.cacheRead + g.cacheCreation }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

function aggregateByModel(records) { return aggregateBy(records, (r) => r.model); }
function aggregateByAgent(records) { return aggregateBy(records, (r) => r.agentId); }

module.exports = { aggregateUsage, aggregateByModel, aggregateByAgent };
