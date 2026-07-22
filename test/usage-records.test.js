"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { loadRecords, saveRecords, loadSyncState, saveSyncState } = require("../src/usage-records");

function makeFs(seed = {}) {
  const files = new Map(Object.entries(seed).map(([k, v]) => [path.resolve(k), v]));
  return {
    _files: files,
    readFileSync(p) { const k = path.resolve(p); if (files.has(k)) return files.get(k); const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
    writeFileSync(p, d) { files.set(path.resolve(p), d); },
    renameSync(a, b) { files.set(path.resolve(b), files.get(path.resolve(a))); files.delete(path.resolve(a)); },
    mkdirSync() {},
  };
}
const HOME = path.resolve("/fake/home");

test("records round-trip; defaults to {} when absent/corrupt", () => {
  const fs = makeFs({});
  assert.deepStrictEqual(loadRecords({ fs, homeDir: HOME }), {});
  saveRecords({ "claude:m1": { ts: 1, model: "x", input: 10 } }, { fs, homeDir: HOME });
  assert.strictEqual(loadRecords({ fs, homeDir: HOME })["claude:m1"].input, 10);
  const bad = makeFs({ [path.join(HOME, ".clawd", "usage-records.json")]: "{oops" });
  assert.deepStrictEqual(loadRecords({ fs: bad, homeDir: HOME }), {});
});

test("sync state round-trips with a files map", () => {
  const fs = makeFs({});
  assert.deepStrictEqual(loadSyncState({ fs, homeDir: HOME }), { files: {} });
  saveSyncState({ files: { "/a/b.jsonl": { mtime: 5, offset: 12 } } }, { fs, homeDir: HOME });
  assert.strictEqual(loadSyncState({ fs, homeDir: HOME }).files["/a/b.jsonl"].offset, 12);
});
