"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Monitor = require("../agents/codex-log-monitor");
const codex = require("../agents/codex");

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const raw = n => `codex:${uuid(n)}`;
const source = { subagent: { thread_spawn: { parent_thread_id: uuid(99) } } };
const record = (type, payload, at = Date.now()) => JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload }) + "\n";

function fixture(t, { children = 2, closed = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-growth-"));
  const d = new Date();
  const dir = path.join(base, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  fs.mkdirSync(dir, { recursive: true });
  const file = n => path.join(dir, `rollout-2026-10-26T00-00-00-${uuid(n)}.jsonl`);
  const frozen = new Date(Date.now() - 60 * 60 * 1000);
  function write(n, text, age = 60 * 60 * 1000) {
    fs.writeFileSync(file(n), text);
    const date = new Date(Date.now() - age); fs.utimesSync(file(n), date, date);
  }
  function append(n, type, payload, at) {
    fs.appendFileSync(file(n), record(type, payload, at)); fs.utimesSync(file(n), frozen, frozen);
  }
  for (let n = 1; n <= children; n++) {
    let text = record("session_meta", { id: uuid(n), source }, Date.now() - 20000);
    if (closed) text += record("event_msg", { type: "task_started", turn_id: `old-${n}` }, Date.now() - 10000)
      + record("event_msg", { type: "task_complete", turn_id: `old-${n}` }, Date.now() - 9000);
    write(n, text);
  }
  // More-recent old-mtime files exhaust the unchanged 20-file startup shortlist.
  for (let n = 100; n < 121; n++) write(n, record("session_meta", { id: uuid(n), source: "cli" }, Date.now() - 3600000), 30 * 60 * 1000);
  const events = [], states = [];
  const monitor = new Monitor({ ...codex, logConfig: { ...codex.logConfig, sessionDir: base } },
    (...args) => states.push(args), { codexDir: path.join(base, "isolated-index"),
      onSubagentActivity: (parentId, event) => events.push({ parentId, ...event }) });
  monitor._findCodexWriterPid = () => null;
  t.after(() => { monitor.stop(); fs.rmSync(base, { recursive: true, force: true }); });
  const poll = (n = 8) => { for (let i = 0; i < n; i++) monitor._poll(); };
  poll();
  assert.equal(monitor._didInitialRecoveryScan, true);
  for (let n = 1; n <= children; n++) assert.equal(monitor._tracked.has(file(n)), false, "cold discovery is only a baseline outside the startup shortlist");
  return { monitor, events, states, file, append, write, poll };
}

describe("Codex delegated old-mtime growth discovery", () => {
  it("admits two genuinely appended children through production polling, then observes 2→1→0", t => {
    const h = fixture(t);
    assert.deepEqual(h.events, []);
    h.append(1, "event_msg", { type: "task_started", turn_id: "turn-1" });
    h.append(2, "event_msg", { type: "task_started", turn_id: "turn-2" });
    h.poll(2);
    assert.deepEqual(h.events.filter(e => e.phase === "start").map(e => e.childId).sort(), [raw(1), raw(2)]);
    assert.equal(h.monitor._publishedChildren.size, 2);
    for (const n of [1, 2]) assert.equal(h.monitor._tracked.get(h.file(n)).offset, fs.statSync(h.file(n)).size);
    h.append(1, "event_msg", { type: "task_complete", turn_id: "turn-1" }); h.poll(2);
    assert.equal(h.monitor._publishedChildren.size, 1);
    h.append(2, "event_msg", { type: "task_complete", turn_id: "turn-2" }); h.poll(2);
    assert.equal(h.monitor._publishedChildren.size, 0);
    assert.equal(h.events.filter(e => e.phase === "stop").length, 2);
    assert.ok(h.events.every(e => e.parentId === raw(99)));
    assert.ok(h.states.every(([, , , extra]) => extra.headless === true));
  });

  it("does not read unchanged baselines and rejects root/guardian growth without creating child activity", t => {
    const h = fixture(t, { children: 3 });
    h.write(2, record("session_meta", { id: uuid(2), source: "cli" }));
    h.write(3, record("session_meta", { id: uuid(3), source: { subagent: { other: "guardian" } } }));
    h.poll(2); // Establish replacement/truncation baselines before appending.
    let reads = 0;
    const recover = h.monitor._recoverStalePendingUserInput;
    h.monitor._recoverStalePendingUserInput = function(...args) { if (args[3]?.requireDelegatedChild) reads++; return recover.apply(this, args); };
    h.poll(4); assert.equal(reads, 0);
    for (const n of [2, 3]) h.append(n, "event_msg", { type: "task_started", turn_id: `not-child-${n}` });
    h.poll(3);
    assert.equal(reads, 2);
    assert.deepEqual(h.events, []);
    assert.equal(h.monitor._tracked.has(h.file(2)), false);
    assert.equal(h.monitor._tracked.has(h.file(3)), false);
    h.poll(3); assert.equal(reads, 2, "validated negative results consume their growth trigger");
  });

  it("does not revive a completed child from token/metadata-only appends", t => {
    const h = fixture(t, { children: 1, closed: true });
    h.append(1, "event_msg", { type: "token_count", info: { total_token_usage: { total_tokens: 1 } } });
    h.poll(3);
    assert.deepEqual(h.events, []);
    assert.equal(h.monitor._publishedChildren.size, 0);
    assert.equal(h.monitor._tracked.get(h.file(1)).delegatedChild.turnId, null);
    h.append(1, "event_msg", { type: "task_started", turn_id: "new-real-turn" }); h.poll(2);
    assert.equal(h.events.at(-1).phase, "start");
    assert.equal(h.events.at(-1).turnId, "new-real-turn");
  });

  it("keeps pending growth across a read-budget shortage and limits recovery to two per poll", t => {
    const h = fixture(t, { children: 3 });
    for (const n of [1, 2, 3]) h.append(n, "event_msg", { type: "task_started", turn_id: `turn-${n}` });
    const stat = fs.statSync(h.file(1));
    const growth = h.monitor._observeFileGrowth(h.file(1), stat);
    assert.equal(growth.pendingGrowth, true);
    h.monitor._recoverGrownDelegatedFile({ filePath: h.file(1), fileName: path.basename(h.file(1)) }, stat,
      { remainingAttempts: 64, remainingRequestBytes: 0, remainingGrowthRecoveries: 2 }, growth);
    assert.equal(growth.pendingGrowth, true);
    assert.deepEqual(h.events, []);
    h.poll(1); assert.equal(h.events.filter(e => e.phase === "start").length, 2);
    assert.equal([...h.monitor._observedFileGrowth.values()].filter(e => e.pendingGrowth).length, 1);
    h.poll(1); assert.equal(h.events.filter(e => e.phase === "start").length, 3);
  });

  it("retains the only growth evidence after a temporary short read, backs off, then retries unchanged size", t => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const h = fixture(t, { children: 1 });
    h.append(1, "event_msg", { type: "task_started", turn_id: "after-short-read" });
    const read = h.monitor._readCompleteFirstLine;
    let attempts = 0;
    h.monitor._readCompleteFirstLine = function(...args) { attempts++; if (attempts === 1) return null; return read.apply(this, args); };
    h.poll(1);
    const growth = h.monitor._observedFileGrowth.get(h.file(1));
    assert.equal(growth.pendingGrowth, true);
    assert.ok(growth.retryAt > Date.now());
    h.poll(3); assert.equal(attempts, 1, "same-size retries obey the existing bounded backoff");
    t.mock.timers.tick(30001); h.poll(2);
    assert.equal(attempts, 2);
    assert.equal(h.events.at(-1).phase, "start");
    assert.equal(growth.pendingGrowth, false);
  });

  it("bounds the ledger at 2048 without evicting every first baseline or pending trigger", t => {
    const h = fixture(t, { children: 0 });
    h.monitor._observedFileGrowth.clear();
    const stat = (n, size = 100) => ({ dev: 1, ino: n, size, birthtimeMs: 1 });
    for (let n = 1; n <= 2049; n++) h.monitor._observeFileGrowth(`fixture-${n}`, stat(n));
    assert.equal(h.monitor._observedFileGrowth.size, 2048);
    assert.equal(h.monitor._observedFileGrowth.has("fixture-2049"), false);
    const compared = h.monitor._observeFileGrowth("fixture-1", stat(1, 101));
    assert.equal(compared.pendingGrowth, true, "an over-cap directory still gets a genuine second comparison");
    h.monitor._observeFileGrowth("fixture-2", stat(2));
    h.monitor._observeFileGrowth("fixture-2049", stat(2049));
    assert.equal(h.monitor._observedFileGrowth.has("fixture-1"), true, "pending evidence survives rotation");
    assert.equal(h.monitor._observedFileGrowth.has("fixture-2"), false);
    assert.equal(h.monitor._observedFileGrowth.size, 2048);
    h.monitor.stop(); assert.equal(h.monitor._observedFileGrowth.size, 0);
  });

  it("keeps pending growth after a transient post-read stat error and recovers with no new append", t => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const h = fixture(t, { children: 1 });
    h.append(1, "event_msg", { type: "task_started", turn_id: "after-stat-error" });
    const stat = fs.statSync;
    const recover = h.monitor._recoverStalePendingUserInput;
    let failPostStat = false, injected = false;
    h.monitor._recoverStalePendingUserInput = function(...args) {
      const result = recover.apply(this, args);
      if (args[3]?.requireDelegatedChild && !injected) { failPostStat = true; injected = true; }
      return result;
    };
    t.mock.method(fs, "statSync", function(file, ...args) {
      if (file === h.file(1) && failPostStat) {
        failPostStat = false; throw Object.assign(new Error("fixture transient stat failure"), { code: "EACCES" });
      }
      return stat.call(this, file, ...args);
    });
    h.poll(1);
    const growth = h.monitor._observedFileGrowth.get(h.file(1));
    assert.equal(growth.pendingGrowth, true);
    assert.ok(growth.retryAt > Date.now());
    assert.deepEqual(h.events, []);
    h.poll(2); assert.deepEqual(h.events, []);
    t.mock.timers.tick(30001); h.poll(2);
    assert.equal(h.events.at(-1).phase, "start");
    assert.equal(growth.pendingGrowth, false);
  });

  it("resets identity/truncation evidence and never treats an unknown file identity as append proof", t => {
    const h = fixture(t, { children: 0 });
    const observe = (ino, size) => h.monitor._observeFileGrowth("identity-fixture", { dev: 1, ino, size });
    assert.equal(observe(1, 100).pendingGrowth, false);
    assert.equal(observe(1, 110).pendingGrowth, true);
    assert.equal(observe(2, 200).pendingGrowth, false);
    assert.equal(observe(2, 210).pendingGrowth, true);
    assert.equal(observe(2, 10).pendingGrowth, false);
    assert.equal(observe(2, 11).pendingGrowth, true);
    assert.equal(h.monitor._observeFileGrowth("unknown-fixture", { size: 100 }).pendingGrowth, false);
    assert.equal(h.monitor._observeFileGrowth("unknown-fixture", { size: 200 }).pendingGrowth, false);
  });
});
