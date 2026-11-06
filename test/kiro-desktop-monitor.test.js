"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { KiroDesktopLogMonitor, RECORD_TYPES: T, fileIdentity } = require("../agents/kiro-desktop-log-monitor");

// Poll temporary session files using an injected clock and owned timers.
function fixture(t) {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-desktop-monitor-"));
  let now = Date.now();
  const records = [], timers = new Map();
  let timerId = 0;
  const monitor = new KiroDesktopLogMonitor({
    sessionsDir,
    now: () => now,
    onRecord: record => records.push(record),
    setInterval(callback) {
      timers.set(++timerId, callback);
      return timerId;
    },
    clearInterval(id) {
      timers.delete(id);
    },
  });
  t.after(() => {
    monitor.stop();
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });
  function file(id, contents = "", mtime = now) {
    const dir = path.join(sessionsDir, "bucket", id);
    fs.mkdirSync(dir, { recursive: true });
    const filename = path.join(dir, "messages.jsonl");
    fs.writeFileSync(filename, contents);
    fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ workspacePaths: ["/project"] }));
    fs.utimesSync(filename, mtime / 1000, mtime / 1000);
    return filename;
  }
  function line(type = T.PENDING, fields = {}, timestamp = now) {
    return JSON.stringify({
      id: "record",
      timestamp,
      payload: {
        type,
        executionId: "e",
        toolCallId: "tool",
        consentRound: 1,
        interactionType: "tool_approval",
        question: "执行吗？",
        ...fields,
      },
    }) + "\n";
  }
  return {
    monitor, records, timers, file, line,
    advance(ms) {
      now += ms;
    },
  };
}

test("kiro-desktop: initial files baseline without replay, including incomplete UTF-8 tail", t => {
  const f = fixture(t), filename = f.file("sess_a", f.line() + f.line(T.RESOLVED).slice(0, -1));
  f.monitor.start();
  f.monitor.poll();
  assert.deepEqual(f.records, []);
  assert.equal([...f.monitor.files.values()][0].offset, Buffer.byteLength(f.line()));
  fs.appendFileSync(filename, "\n" + f.line(T.PENDING, { consentRound: 2, question: "回答\u0000这个问题" }));
  f.monitor.poll();
  assert.deepEqual(f.records.map(r => r.type), [T.RESOLVED, T.PENDING]);
  assert.equal(f.records[1].question, "回答这个问题");
  assert.equal(f.records[1].cwd, "/project");
});

test("kiro-desktop: new files read from zero and skip old, malformed, unsupported or incomplete records", t => {
  const f = fixture(t);
  f.monitor.start();
  const contents = [
    f.line(T.PENDING, {}, Date.now() - 6000),
    "bad json\n",
    f.line(T.PENDING, { interactionType: "unknown" }),
    f.line(T.PENDING, { executionId: null }),
    f.line(T.PENDING, { consentRound: null }),
    f.line(T.PENDING, { question: null }),
    f.line(T.TURN_END, { stopReason: "cancelled", boundarySource: "observed" }),
    f.line(),
  ].join("");
  f.file("sess_new", contents);
  f.monitor.discover();
  f.monitor.poll();
  assert.deepEqual(f.records.map(r => r.type), [T.TURN_END, T.PENDING]);
});

test("kiro-desktop: partial multibyte records finish once without corrupting text or byte offsets", t => {
  const f = fixture(t);
  const filename = f.file("sess_a");
  f.monitor.start();
  const bytes = Buffer.from(f.line(T.PENDING, { question: "你好🌈" }));
  const split = bytes.indexOf(Buffer.from("🌈")) + 2;
  fs.appendFileSync(filename, bytes.subarray(0, split));
  f.monitor.poll();
  assert.equal(f.records.length, 0);
  fs.appendFileSync(filename, bytes.subarray(split));
  f.monitor.poll();
  f.monitor.poll();
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].question, "你好🌈");
  assert.equal([...f.monitor.files.values()][0].offset, bytes.length);
});

test("kiro-desktop: overlong lines are discarded across polls and each file has its own 1 MB budget", t => {
  const f = fixture(t), large = f.file("sess_large"), other = f.file("sess_other");
  f.monitor.start();
  fs.appendFileSync(large, "x".repeat(2 * 1024 * 1024 + 13) + "\n" + f.line());
  fs.appendFileSync(other, f.line());
  f.monitor.poll();
  assert.deepEqual(f.records.map(r => r.sessionId), ["sess_other"]);
  assert.equal(f.monitor.files.get(large).offset, 1024 * 1024);
  f.monitor.poll();
  f.monitor.poll();
  assert.equal(f.records.filter(r => r.sessionId === "sess_large").length, 1);
});

for (const mode of ["identity", "shorter", "same-size-boundary"]) {
  test(`kiro-desktop: rewrite detection rebaselines ${mode} without replay`, t => {
    const f = fixture(t), filename = f.file("sess_a", f.line());
    f.monitor.start();
    if (mode === "identity") {
      fs.renameSync(filename, filename + ".old");
      fs.writeFileSync(filename, f.line());
    }
    if (mode === "shorter") fs.writeFileSync(filename, "");
    if (mode === "same-size-boundary") {
      const data = fs.readFileSync(filename);
      data[data.length - 1] = 32;
      fs.writeFileSync(filename, data);
    }
    f.monitor.poll();
    assert.deepEqual(f.records, [{ type: T.REBASELINE, sessionId: "sess_a" }]);
    fs.appendFileSync(filename, "\n" + f.line(T.PENDING, { consentRound: 2 }));
    f.monitor.poll();
    assert.equal(f.records.at(-1).consentRound, 2);
  });
}

test("kiro-desktop: discovery tracks newest 64, untracks evicted files, and resumes LRU offsets", t => {
  const f = fixture(t);
  const filenames = Array.from({ length: 65 }, (_, index) => f.file(
    `sess_${String(index).padStart(2, "0")}`, "", Date.now() - index * 1000,
  ));
  f.monitor.start();
  assert.equal(f.monitor.files.size, 64);
  assert.equal(f.monitor.files.has(filenames[64]), false);
  fs.appendFileSync(filenames[0], f.line());
  f.monitor.poll();
  assert.equal(f.records.length, 1);
  const old = Date.now() - 100000;
  fs.utimesSync(filenames[0], old / 1000, old / 1000);
  f.monitor.discover();
  assert.equal(f.records.at(-1).type, T.UNTRACKED);
  assert.equal(f.records.at(-1).sessionId, "sess_00");
  const fresh = Date.now();
  fs.utimesSync(filenames[0], fresh / 1000, fresh / 1000);
  f.monitor.discover();
  f.records.length = 0;
  f.monitor.poll();
  assert.deepEqual(f.records, []);
  f.advance(25 * 60 * 60 * 1000);
  f.monitor.discover();
  assert.equal(f.monitor.files.size, 0);
  assert.equal(f.records.filter(r => r.type === T.UNTRACKED).length, 64);
});

test("kiro-desktop: retirement cache is bounded and restart clears offsets and timers", t => {
  const f = fixture(t);
  f.monitor.start();
  for (let batch = 0; batch < 9; batch++) {
    for (let index = 0; index < 64; index++) f.file(`sess_${batch}_${index}`);
    f.monitor.discover();
    f.advance(25 * 60 * 60 * 1000);
    f.monitor.discover();
  }
  assert.ok(f.monitor.retired.size <= 500);
  f.monitor.stop();
  assert.equal(f.timers.size, 0);
  assert.equal(f.monitor.retired.size, 0);
  f.file("sess_restart", f.line());
  f.monitor.start();
  f.monitor.poll();
  assert.equal(f.records.filter(r => r.type === T.PENDING).length, 0);
  assert.equal(f.timers.size, 2);
  assert.equal(fileIdentity({ ino: 0, birthtimeMs: 42 }), "birth:42");
});

test("kiro-desktop: a disappearing baseline file does not prevent polling or later discovery", t => {
  const f = fixture(t), filename = f.file("sess_race");
  const originalOpen = fs.openSync;
  let fail = true;
  t.mock.method(fs, "openSync", function open(file, ...args) {
    if (file === filename && fail) {
      fail = false;
      const error = new Error("removed during discovery");
      error.code = "ENOENT";
      throw error;
    }
    return originalOpen.call(this, file, ...args);
  });
  assert.doesNotThrow(() => f.monitor.start());
  assert.equal(f.timers.size, 2);
  assert.equal(f.monitor.files.size, 0);
  fs.appendFileSync(filename, f.line());
  f.monitor.discover();
  f.monitor.poll();
  assert.equal(f.records.length, 1);
});
