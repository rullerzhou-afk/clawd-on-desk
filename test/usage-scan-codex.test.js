"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { scanCodexUsage, normalizeCodexModel, collectCodexFiles, codexSessionsDir } = require("../src/usage-scan");

function makeFs(files = {}, mtimes = {}) {
  const norm = (p) => path.resolve(p);
  const fileMap = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  const mtimeMap = new Map(Object.entries(mtimes).map(([k, v]) => [norm(k), v]));
  const dirs = new Set();
  for (const f of fileMap.keys()) {
    let d = path.dirname(f);
    while (true) { dirs.add(d); const parent = path.dirname(d); if (parent === d) break; d = parent; }
  }
  return {
    readdirSync(dir) {
      const nd = norm(dir);
      if (!dirs.has(nd)) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
      const c = new Set();
      for (const f of fileMap.keys()) if (path.dirname(f) === nd) c.add(path.basename(f));
      for (const d of dirs) if (d !== nd && path.dirname(d) === nd) c.add(path.basename(d));
      return [...c];
    },
    statSync(p) {
      const np = norm(p);
      if (fileMap.has(np)) return { isFile: () => true, isDirectory: () => false, mtimeMs: mtimeMap.get(np) || 1000 };
      if (dirs.has(np)) return { isFile: () => false, isDirectory: () => true, mtimeMs: 0 };
      const e = new Error("ENOENT"); e.code = "ENOENT"; throw e;
    },
    readFileSync(p) { const np = norm(p); if (fileMap.has(np)) return fileMap.get(np); const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
  };
}
const HOME = path.resolve("/fake/home");
const SESS = codexSessionsDir(HOME);

test("normalizeCodexModel lowercases, strips provider prefix and date suffix", () => {
  assert.strictEqual(normalizeCodexModel("openai/GPT-5.1-Codex"), "gpt-5.1-codex");
  assert.strictEqual(normalizeCodexModel("gpt-5.4-2026-03-05"), "gpt-5.4");
  assert.strictEqual(normalizeCodexModel("gpt-5.4-20260305"), "gpt-5.4");
  assert.strictEqual(normalizeCodexModel("gpt-5-codex"), "gpt-5-codex");
});

test("computes per-turn deltas from cumulative token_count, skips zero-delta", () => {
  const file = path.join(SESS, "2026", "03", "05", "rollout-abc.jsonl");
  const tc = (info) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info }, timestamp: "2026-03-05T10:00:00Z" });
  const content = [
    JSON.stringify({ type: "session_meta", payload: { id: "thread-x" } }),
    JSON.stringify({ type: "turn_context", payload: { model: "openai/gpt-5.1-codex" } }),
    tc({ total_token_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 } }),
    tc({ total_token_usage: { input_tokens: 1500, cached_input_tokens: 400, output_tokens: 120 } }),
    tc({ total_token_usage: { input_tokens: 1500, cached_input_tokens: 400, output_tokens: 120 } }), // zero delta
  ].join("\n") + "\n";
  const fs = makeFs({ [file]: content }, { [file]: 2000 });
  const out = scanCodexUsage({ fs, homeDir: HOME, records: {}, syncState: { files: {} }, now: 1 });
  const r1 = out.records["codex:rollout-abc:1"];
  const r2 = out.records["codex:rollout-abc:2"];
  assert.ok(r1 && r2);
  assert.strictEqual(Object.keys(out.records).length, 2); // 3rd event zero-delta skipped
  // event1: input 1000 incl 200 cached -> fresh 800, cacheRead 200, output 50
  assert.deepStrictEqual([r1.input, r1.cacheRead, r1.output], [800, 200, 50]);
  // event2 delta: input 500 incl cached 200 -> fresh 300, cacheRead 200, output 70
  assert.deepStrictEqual([r2.input, r2.cacheRead, r2.output], [300, 200, 70]);
  assert.strictEqual(r1.model, "gpt-5.1-codex");
  assert.strictEqual(r1.cacheCreation, 0);
});

test("re-scan of an unchanged file imports nothing", () => {
  const file = path.join(SESS, "2026", "03", "05", "r.jsonl");
  const content = [
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.1-codex" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } } }, timestamp: "2026-03-05T10:00:00Z" }),
  ].join("\n") + "\n";
  const fs = makeFs({ [file]: content }, { [file]: 2000 });
  const first = scanCodexUsage({ fs, homeDir: HOME, records: {}, syncState: { files: {} }, now: 1 });
  assert.strictEqual(Object.keys(first.records).length, 1);
  const second = scanCodexUsage({ fs, homeDir: HOME, records: first.records, syncState: first.syncState, now: 1 });
  assert.strictEqual(second.imported, 0);
  assert.strictEqual(Object.keys(second.records).length, 1);
});
