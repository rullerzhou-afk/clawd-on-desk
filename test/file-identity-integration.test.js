"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { collidingFileIds } = require("./helpers/colliding-file-ids");
const { toNumberStats } = require("../hooks/file-identity");
const { KiroDesktopLogMonitor } = require("../agents/kiro-desktop-log-monitor");
const { createJsonlSessionTitleTracker } = require("../src/jsonl-session-title");
const { createWorkBuddySessionTitleTracker } = require("../src/workbuddy-session-title");
const createArchiveTracker = require("../src/codex-archive-tracker");
const { resolveCodexApprovalRoute } = require("../src/codex-approval-routing");
const SID = "019d23d4-f1a9-7633-b9c7-758327137228";
const jsonl = record => JSON.stringify(record) + "\n";
const title = text => jsonl({ type: "ai-title", sessionId: SID, aiTitle: text });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "identity-integration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ids = collidingFileIds(t);
  function pair(file, oldText, newText = oldText) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, oldText);
    const replacement = file + ".replacement";
    fs.writeFileSync(replacement, newText);
    const before = ids.snapshot(file), after = ids.snapshot(replacement);
    ids.assertCollision(before, after);
    return { replacement, before, after, replace() {
      fs.renameSync(replacement, file);
      ids.assertCollision(before, ids.snapshot(file));
    } };
  }
  return { dir, ids, pair };
}

for (const replace of [true, false]) {
  test(`S2: Kiro colliding IDs ${replace ? "rebaseline replacement" : "keep unchanged file"}`, t => {
    const f = fixture(t);
    const file = path.join(f.dir, "bucket", SID, "messages.jsonl");
    const pair = f.pair(file, "{}\n");
    const records = [];
    const monitor = new KiroDesktopLogMonitor({ sessionsDir: f.dir, onRecord: r => records.push(r),
      setInterval: () => 1, clearInterval: () => {} });
    t.after(() => monitor.stop());
    monitor.start();
    if (replace) pair.replace();
    monitor.poll();
    assert.deepEqual(records.map(r => r.type), replace ? ["monitor_rebaseline"] : []);
  });

  test(`S3: JSONL colliding IDs ${replace ? "read replaced title despite matching anchor" : "keep cursor"}`, async t => {
    const f = fixture(t), file = path.join(f.dir, "session.jsonl");
    const filler = jsonl({ type: "message", text: "x".repeat(200) });
    const oldText = title("Old") + filler;
    const newText = title("New") + filler + filler;
    const pair = f.pair(file, oldText, newText);
    const scans = [];
    const tracker = createJsonlSessionTitleTracker({ onScan: m => scans.push(m) });
    t.after(() => tracker.clear());
    const input = { sessionId: SID, transcriptPath: file, event: "Stop" };
    assert.equal(await tracker.resolve(input), "Old");
    if (replace) pair.replace();
    assert.equal(await tracker.resolve(input), replace ? "New" : "Old");
    assert.equal(scans.at(-1).reset, replace);
    if (!replace) assert.equal(scans.at(-1).contentBytesRead, 0);
  });

  test(`S4: WorkBuddy colliding IDs ${replace ? "reset source" : "retain source title"}`, async t => {
    const f = fixture(t), file = path.join(f.dir, "session.jsonl");
    const pair = f.pair(file, title("Old") + jsonl({ text: "x".repeat(200) }),
      jsonl({ type: "message", text: "no title" }));
    const updates = [], reads = [], session = {};
    const readerFs = {
      async open(...args) {
        const handle = await fs.promises.open(...args);
        return {
          stat: (...args) => handle.stat(...args),
          close: () => handle.close(),
          read: (...args) => { reads.push(args[3]); return handle.read(...args); },
        };
      },
    };
    const tracker = createWorkBuddySessionTitleTracker({ dataDirs: [path.join(f.dir, "absent")],
      getSession: () => session, updateTitle: (_id, text) => updates.push(text), readerFs, pollMs: 60000 });
    t.after(() => tracker.clear());
    const input = { sessionId: SID, rawSessionId: SID, transcriptPath: file };
    tracker.track(input);
    await tracker.poll();
    assert.equal(updates.at(-1), "Old");
    updates.length = 0;
    reads.length = 0;
    if (replace) pair.replace();
    tracker.beginTurn(input);
    await tracker.poll();
    assert.deepEqual(updates, replace ? [] : ["Old"]);
    if (!replace) {
      assert.ok(reads.length > 0);
      assert.ok(reads.every(position => position > 0), "unchanged source must retain its reader cursor");
    }
  });

  test(`S5: archive default lstat ${replace ? "revalidates equal-size equal-mtime replacement" : "keeps evidence"}`, async t => {
    const f = fixture(t);
    const file = path.join(f.dir, "archived_sessions", `rollout-2026-03-25T15-10-51-${SID}.jsonl`);
    const oldText = jsonl({ type: "session_meta", payload: { id: SID } });
    const pair = f.pair(file, oldText, oldText.replace(SID, "00000000-0000-4000-8000-000000000000"));
    // Pin both timestamps before the first scan; no statFile injection here.
    for (const target of [file, pair.replacement]) fs.utimesSync(target, 1700000000, 1700000000);
    assert.equal(fs.statSync(file).size, fs.statSync(pair.replacement).size);
    assert.equal(fs.statSync(file).mtimeMs, fs.statSync(pair.replacement).mtimeMs);
    let reads = 0;
    const tracker = createArchiveTracker({ codexHome: f.dir, getLiveCandidateIds: () => [SID],
      readFirstLine: async target => { reads++; return fs.readFileSync(target, "utf8").trim(); } });
    t.after(() => tracker.stop());
    await tracker.scanNow();
    assert.equal(tracker.isArchived(SID), true);
    const evidence = tracker.getEvidence(SID), previousReads = reads;
    if (replace) pair.replace();
    await tracker.scanNow();
    assert.equal(tracker.isArchived(SID), !replace);
    if (replace) assert.ok(reads > previousReads);
    else { assert.equal(reads, previousReads); assert.equal(tracker.getEvidence(SID), evidence); }
  });

  test(`S6: approval colliding IDs ${replace ? "reject replacement with size/mtime unchanged" : "accept unchanged transcript"}`, t => {
    const f = fixture(t), file = path.join(f.dir, "sessions", "rollout.jsonl");
    const text = jsonl({ type: "session_meta", payload: { id: SID } })
      + jsonl({ type: "turn_context", payload: { turn_id: "turn", approvals_reviewer: "user", approval_policy: "on-request" } });
    const pair = f.pair(file, text);
    for (const target of [file, pair.replacement]) fs.utimesSync(target, 1700000000, 1700000000);
    assert.equal(fs.statSync(file).size, fs.statSync(pair.replacement).size);
    assert.equal(fs.statSync(file).mtimeMs, fs.statSync(pair.replacement).mtimeMs);
    if (replace) {
      const stat = fs.statSync;
      const canonicalFile = fs.realpathSync.native(file);
      // The open fd still sees the original file; path stat sees its replacement.
      // Returning a real peer stat avoids renaming over an open file on Windows.
      t.mock.method(fs, "statSync", (target, options) => {
        return stat(target === canonicalFile ? pair.replacement : target, options);
      });
    }
    const route = resolveCodexApprovalRoute({ session_id: SID, turn_id: "turn", tool_name: "Bash",
      permission_mode: "default", transcript_path: file }, { codexHome: f.dir });
    assert.deepEqual(route, replace ? { owner: "codex", reason: "transcript-changed" }
      : { owner: "clawd", reason: "current-human-reviewer" });
  });
}

test("S3: device-only identity change resets JSONL with unchanged anchor", async t => {
  const f = fixture(t), file = path.join(f.dir, "session.jsonl");
  const filler = jsonl({ text: "x".repeat(200) });
  const pair = f.pair(file, title("Old") + filler, title("New") + filler + filler);
  const open = fs.promises.open;
  let dev = 1n;
  t.mock.method(fs.promises, "open", async (...args) => {
    const handle = await open(...args), stat = handle.stat.bind(handle);
    handle.stat = async options => {
      const result = await stat(options);
      Object.assign(result, { dev: options?.bigint ? dev : Number(dev), ino: options?.bigint ? 0n : 0,
        birthtimeNs: 0n, birthtimeMs: 0 });
      return result;
    };
    return handle;
  });
  const scans = [];
  const tracker = createJsonlSessionTitleTracker({ onScan: scan => scans.push(scan) });
  t.after(() => tracker.clear());
  const input = { sessionId: SID, transcriptPath: file, event: "Stop" };
  assert.equal(await tracker.resolve(input), "Old");
  // Positive control for this fallback too.
  assert.equal(await tracker.resolve(input), "Old");
  assert.equal(scans.at(-1).reset, false);
  pair.replace(); dev = 2n;
  assert.equal(await tracker.resolve(input), "New");
});

test("S8: approval treats two unavailable identities as changed", t => {
  const f = fixture(t), file = path.join(f.dir, "sessions", "rollout.jsonl");
  f.pair(file, jsonl({ type: "session_meta", payload: { id: SID } })
    + jsonl({ type: "turn_context", payload: { turn_id: "turn", approvals_reviewer: "user", approval_policy: "on-request" } }));
  for (const name of ["statSync", "fstatSync"]) {
    const original = fs[name];
    t.mock.method(fs, name, (...args) => {
      const stat = toNumberStats(original(...args));
      return { ...stat, dev: 0, ino: 0, birthtimeMs: 0, isFile: () => stat.isFile() };
    });
  }
  assert.deepEqual(resolveCodexApprovalRoute({ session_id: SID, turn_id: "turn", tool_name: "Bash",
    permission_mode: "default", transcript_path: file }, { codexHome: f.dir }),
  { owner: "codex", reason: "transcript-changed" });
});
