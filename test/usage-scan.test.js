"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { scanClaudeUsage, collectClaudeFiles, claudeProjectsDir } = require("../src/usage-scan");

// Fake fs over a { absPath: content } file map (dirs inferred), with a
// separate mtimes map so re-scan tests can bump a file's mtime.
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
      const children = new Set();
      for (const f of fileMap.keys()) if (path.dirname(f) === nd) children.add(path.basename(f));
      for (const d of dirs) if (d !== nd && path.dirname(d) === nd) children.add(path.basename(d));
      return [...children];
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
const PROJ = claudeProjectsDir(HOME);

const line = (id, model, u, stop, ts) => JSON.stringify({
  type: "assistant",
  message: { id, model, usage: u, stop_reason: stop },
  timestamp: ts, sessionId: "s1",
});

test("collects main + subagent + workflow jsonl files", () => {
  const fs = makeFs({
    [path.join(PROJ, "proj1", "main.jsonl")]: "{}",
    [path.join(PROJ, "proj1", "sess1", "subagents", "a.jsonl")]: "{}",
    [path.join(PROJ, "proj1", "sess1", "subagents", "workflows", "wf_1", "b.jsonl")]: "{}",
    [path.join(PROJ, "proj1", "sess1", "other.txt")]: "x",
  });
  const files = collectClaudeFiles(fs, PROJ);
  assert.strictEqual(files.length, 3);
  assert.ok(files.some((f) => f.endsWith("main.jsonl")));
  assert.ok(files.some((f) => f.endsWith("a.jsonl")));
  assert.ok(files.some((f) => f.endsWith("b.jsonl")));
});

test("scans, dedups by message id (keeps final), keys records", () => {
  const file = path.join(PROJ, "proj1", "main.jsonl");
  const content = [
    line("msg1", "claude-opus-4-8", { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 5000, cache_creation_input_tokens: 10000 }, null, "2026-04-05T12:00:00Z"),
    line("msg1", "claude-opus-4-8", { input_tokens: 3, output_tokens: 150, cache_read_input_tokens: 5000, cache_creation_input_tokens: 10000 }, "end_turn", "2026-04-05T12:00:01Z"),
    line("msg2", "claude-sonnet-5", { input_tokens: 20, output_tokens: 8 }, "end_turn", "2026-04-05T12:01:00Z"),
  ].join("\n") + "\n";
  const fs = makeFs({ [file]: content }, { [file]: 2000 });
  const out = scanClaudeUsage({ fs, homeDir: HOME, records: {}, syncState: { files: {} }, now: 9999 });
  assert.strictEqual(out.records["claude:msg1"].output, 150); // final block kept
  assert.strictEqual(out.records["claude:msg1"].cacheRead, 5000);
  assert.strictEqual(out.records["claude:msg2"].model, "claude-sonnet-5");
  assert.strictEqual(out.records["claude:msg1"].ts, Math.floor(Date.parse("2026-04-05T12:00:01Z") / 1000));
  assert.strictEqual(Object.keys(out.records).length, 2);
  assert.strictEqual(out.syncState.files[file].offset, 3); // 3 lines consumed
});

test("re-scan of an unchanged file imports nothing (idempotent)", () => {
  const file = path.join(PROJ, "proj1", "main.jsonl");
  const content = line("msg1", "claude-opus-4-8", { input_tokens: 3, output_tokens: 150 }, "end_turn", "2026-04-05T12:00:00Z") + "\n";
  const fs = makeFs({ [file]: content }, { [file]: 2000 });
  const first = scanClaudeUsage({ fs, homeDir: HOME, records: {}, syncState: { files: {} }, now: 1 });
  assert.strictEqual(first.imported, 1);
  const second = scanClaudeUsage({ fs, homeDir: HOME, records: first.records, syncState: first.syncState, now: 1 });
  assert.strictEqual(second.imported, 0);
  assert.strictEqual(Object.keys(second.records).length, 1);
});

test("skips all-zero-token placeholder messages", () => {
  const file = path.join(PROJ, "proj1", "main.jsonl");
  const content = line("empty", "claude-opus-4-8", { input_tokens: 0, output_tokens: 0 }, null, "2026-04-05T12:00:00Z") + "\n";
  const fs = makeFs({ [file]: content }, { [file]: 2000 });
  const out = scanClaudeUsage({ fs, homeDir: HOME, records: {}, syncState: { files: {} }, now: 1 });
  assert.strictEqual(Object.keys(out.records).length, 0);
});
