"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Monitor = require("../agents/codex-log-monitor");
const config = require("../agents/codex");
const { collidingFileIds } = require("./helpers/colliding-file-ids");
const { readStats, fileIdentity } = require("../hooks/file-identity");
const SID = "019d23d4-f1a9-7633-b9c7-758327137228";
const NAME = `rollout-2026-03-25T15-10-51-${SID}.jsonl`;
const record = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n";
const meta = record("session_meta", { id: SID, cwd: "/identity" });
const start = record("event_msg", { type: "task_started", turn_id: "turn" });

function fixture(t, text = meta) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-identity-"));
  const now = new Date();
  const dir = path.join(base, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, NAME), replacement = path.join(base, "replacement.jsonl");
  fs.writeFileSync(file, text); fs.writeFileSync(replacement, text);
  const ids = collidingFileIds(t);
  const before = ids.snapshot(file), after = ids.snapshot(replacement);
  ids.assertCollision(before, after);
  const events = [], requests = [], children = [];
  const monitor = new Monitor({ ...config, logConfig: { ...config.logConfig, sessionDir: base } },
    (...args) => events.push(args), { codexDir: base, onUserInputRequest: (...args) => requests.push(args),
      onSubagentActivity: (...args) => children.push(args) });
  monitor._findCodexWriterPid = () => null;
  t.after(() => { monitor.stop(); fs.rmSync(base, { recursive: true, force: true }); });
  function replace() {
    fs.renameSync(replacement, file);
    ids.assertCollision(before, ids.snapshot(file));
  }
  return { base, dir, file, replacement, monitor, events, requests, children, replace };
}

for (const replaced of [true, false]) {
  test(`S1a: active rollout ${replaced ? "rebaselines collision" : "reads append without rebaseline"}`, t => {
    const f = fixture(t);
    f.monitor._poll(); f.events.length = 0;
    if (replaced) {
      fs.writeFileSync(f.replacement, " ".repeat(Buffer.byteLength(meta)) + start);
      f.replace();
    } else fs.appendFileSync(f.file, start);
    f.monitor._poll();
    assert.deepEqual(f.events.map(e => e[2]), replaced ? [] : ["event_msg:task_started"]);
    assert.equal(f.monitor._tracked.get(f.file).offset, fs.statSync(f.file).size);
    if (replaced) {
      fs.appendFileSync(f.file, start); f.monitor._poll();
      assert.deepEqual(f.events.map(e => e[2]), ["event_msg:task_started"]);
    }
  });

  test(`S1b: stat/open race ${replaced ? "rebaselines collision" : "retains exact identity"}`, t => {
    const f = fixture(t);
    f.monitor._poll(); f.events.length = 0;
    fs.appendFileSync(f.file, start);
    fs.writeFileSync(f.replacement, " ".repeat(Buffer.byteLength(meta)) + start);
    const open = fs.openSync;
    let opened = false;
    t.mock.method(fs, "openSync", (target, ...args) => {
      if (target === f.file && !opened) { opened = true; if (replaced) f.replace(); }
      return open(target, ...args);
    });
    f.monitor._poll();
    assert.equal(opened, true);
    assert.deepEqual(f.events.map(e => e[2]), replaced ? [] : ["event_msg:task_started"]);
    if (replaced) {
      fs.appendFileSync(f.file, start); f.monitor._poll();
      assert.deepEqual(f.events.map(e => e[2]), ["event_msg:task_started"]);
    }
  });

  test(`S1c: startup preStat ${replaced ? "detects replacement before open" : "reads first snapshot"}`, t => {
    const f = fixture(t, meta + start);
    const open = fs.openSync;
    let opened = false;
    t.mock.method(fs, "openSync", (target, ...args) => {
      if (target === f.file && !opened) { opened = true; if (replaced) f.replace(); }
      return open(target, ...args);
    });
    f.monitor._poll();
    assert.equal(opened, true);
    assert.equal(f.monitor._tracked.get(f.file).offset, fs.statSync(f.file).size);
    assert.equal(f.monitor._tracked.get(f.file).fileIdentity, fileIdentity(readStats(fs.statSync, f.file)));
    assert.deepEqual(f.events.map(e => e[2]), replaced ? [] : ["session_meta", "event_msg:task_started"]);
  });

  test(`S1e: rich tracker eviction ${replaced ? "baselines replacement" : "resumes saved append"}`, t => {
    const f = fixture(t);
    f.monitor._pollFile(f.file, NAME); f.events.length = 0;
    f.monitor._retireTrackedFile(f.file, f.monitor._tracked.get(f.file));
    for (let i = 0; i <= 100; i++) f.monitor._retireTrackedFile(`dummy-${i}`, { offset: 0, lastEventTime: i });
    assert.equal(f.monitor._retiredTracked.has(f.file), false);
    if (replaced) { fs.writeFileSync(f.replacement, meta + start); f.replace(); }
    else fs.appendFileSync(f.file, start);
    f.monitor._pollFile(f.file, NAME);
    assert.deepEqual(f.events.map(e => e[2]), replaced ? [] : ["event_msg:task_started"]);
    assert.equal(f.monitor._tracked.get(f.file).offset, fs.statSync(f.file).size);
  });

  for (const route of ["direct", "sweep", "startup", "delegated"]) {
    test(`S1d: ${route} recovery ${replaced ? "rejects collision during read" : "accepts unchanged snapshot"}`, t => {
      const source = route === "delegated" ? { subagent: { thread_spawn: {
        parent_thread_id: "00000000-0000-4000-8000-000000000099" } } } : "cli";
      const text = record("session_meta", { id: SID, cwd: "/identity", source }) + start
        + record("response_item", { type: "function_call", name: "request_user_input", call_id: "call",
          arguments: JSON.stringify({ questions: [{ id: "q", header: "Pick", question: "Choose", options: [] }] }) });
      const f = fixture(t, text);
      const old = new Date(Date.now() - 10 * 60 * 1000);
      for (const target of [f.file, f.replacement]) fs.utimesSync(target, old, old);
      const candidate = { filePath: f.file, file: NAME, fileName: NAME };
      const read = fs.readSync;
      let didRead = false;
      t.mock.method(fs, "readSync", (...args) => {
        const result = read(...args);
        didRead = true;
        return result;
      });
      if (replaced) {
        const stat = fs.statSync;
        // Model replacement after reading starts without renaming an open file.
        t.mock.method(fs, "statSync", (target, options) => {
          return stat(didRead && target === f.file ? f.replacement : target, options);
        });
      }
      if (route === "direct") {
        const result = f.monitor._recoverStalePendingUserInput(f.file, NAME, null, { deferSideEffects: true });
        assert.equal(result !== null, !replaced);
        assert.deepEqual(f.events, []);
        assert.deepEqual(f.requests, []);
      } else if (route === "sweep") f.monitor._runRecoverySweep([candidate]);
      else if (route === "startup") {
        f.monitor._insertStartupRecoveryCandidate({ ...candidate, mtimeMs: old.getTime(), size: Buffer.byteLength(text) });
        f.monitor._runReadyStartupRecovery({ remainingAttempts: 64 });
      } else {
        f.monitor._recoverGrownDelegatedFile(candidate, readStats(fs.statSync, f.file), {
          remainingAttempts: 64, remainingGrowthRecoveries: 4, remainingRequestBytes: 8 * 1024 * 1024,
        }, { pendingGrowth: true });
      }
      assert.equal(didRead, true);
      if (route !== "direct") {
        assert.equal(f.monitor._tracked.has(f.file), !replaced);
        if (route !== "delegated") assert.equal(f.requests.length, replaced ? 0 : 1);
        else if (!replaced) assert.equal(f.monitor._tracked.get(f.file).offset, Buffer.byteLength(text));
      }
    });
  }
}
