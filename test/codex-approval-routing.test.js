"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveCodexApprovalRoute } = require("../src/codex-approval-routing");
const SESSION = "01a119d3-1893-7f42-aadc-fa33ca4166a8";
const TURN = "01a119d7-24b5-7010-9da2-d8791ff8a1d1";
const line = (type, payload) => JSON.stringify({ type, payload });
const CHUNK_BYTES = 1024 * 1024;
function responseRecord(bytes) {
  const empty = line("response_item", { type: "message", text: "" });
  return line("response_item", { type: "message", text: "x".repeat(bytes - empty.length - 1) });
}
function fixture(t, reviewer = "user", after = [], extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-routing-"));
  const sessions = path.join(home, "sessions");
  fs.mkdirSync(sessions);
  const file = path.join(sessions, "rollout-" + SESSION + ".jsonl");
  fs.writeFileSync(file, [
    line("session_meta", { id: SESSION }),
    line("turn_context", { turn_id: TURN, approvals_reviewer: reviewer, approval_policy: "on-request" }),
    ...after,
  ].join("\n") + "\n");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const data = { session_id: "codex:" + SESSION, turn_id: TURN, tool_name: "Bash",
    permission_mode: "default", transcript_path: file, ...extra };
  return { home, file, data, route: (opts) => resolveCodexApprovalRoute(data, { codexHome: home, ...opts }) };
}
test("Auto can mirror a current human-reviewed shell request", (t) => {
  assert.equal(fixture(t).route().owner, "clawd");
});
test("Auto never blocks an automatic reviewer", (t) => {
  assert.equal(fixture(t, "auto_review").route().owner, "codex");
});
test("a same-turn settings update invalidates the turn snapshot", (t) => {
  const f = fixture(t, "user", [line("event_msg", { type: "thread_settings_applied",
    thread_settings: { approvals_reviewer: "auto_review", approval_policy: "on-request" } })]);
  assert.equal(f.route().owner, "codex");
});
test("Auto does not borrow a later or earlier turn", (t) => {
  const f = fixture(t, "user", [line("turn_context", { turn_id: "other-turn",
    approvals_reviewer: "user", approval_policy: "on-request" })]);
  assert.equal(f.route().owner, "codex");
  f.data.turn_id = "missing-turn";
  assert.equal(f.route().owner, "codex");
});
test("MCP requests delegate because their reviewer can override the turn", (t) => {
  assert.equal(fixture(t, "user", [], { tool_name: "mcp__github__get_issue" }).route().owner, "codex");
});
test("a foreign session or transcript outside Codex sessions cannot select Clawd", (t) => {
  const f = fixture(t);
  f.data.session_id = "codex:019d23d4-f1a9-7633-b9c7-758327137228";
  assert.equal(f.route().owner, "codex");
  f.data.session_id = "codex:" + SESSION;
  const foreign = path.join(f.home, "foreign.jsonl");
  fs.copyFileSync(f.file, foreign); f.data.transcript_path = foreign;
  assert.equal(f.route().owner, "codex");
});
test("missing, partial and corrupt evidence delegates without a decision", (t) => {
  const f = fixture(t);
  fs.appendFileSync(f.file, '{"type":"event_msg"');
  assert.equal(f.route().owner, "codex");
  fs.writeFileSync(f.file, "corrupt\n");
  assert.equal(f.route().owner, "codex");
  f.data.transcript_path = null;
  assert.equal(f.route().owner, "codex");
});
test("completed turns and unreadable or bounded-out snapshots delegate", (t) => {
  const f = fixture(t, "user", [line("event_msg", { type: "task_complete", turn_id: TURN })]);
  assert.equal(f.route().owner, "codex");
  const g = fixture(t, "user", [line("response_item", { type: "message", text: "x".repeat(4096) })]);
  assert.equal(g.route({ maxScanBytes: 1024 }).owner, "codex");
  fs.unlinkSync(g.file);
  assert.equal(g.route().owner, "codex");
});
test("remote and bypass requests cannot be mistaken for local human approval", (t) => {
  assert.equal(fixture(t, "user", [], { host: "remote" }).route().owner, "codex");
  assert.equal(fixture(t, "user", [], { permission_mode: "bypassPermissions" }).route().owner, "codex");
});
test("noninteractive or absent reviewer context stays with Codex", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, [line("session_meta", { id: SESSION }),
    line("turn_context", { turn_id: TURN, approvals_reviewer: "user", approval_policy: "never" })].join("\n") + "\n");
  assert.equal(f.route().owner, "codex");
});

test("PR #1156 follow-up: Auto finds human evidence behind 3 MiB of response items", (t) => {
  const f = fixture(t, "user", Array(6).fill(responseRecord(CHUNK_BYTES / 2)));
  const parse = t.mock.method(JSON, "parse");
  assert.equal(f.route().owner, "clawd");
  assert.ok(parse.mock.calls.every((call) => !call.arguments[0].startsWith('{"type":"response_item"')));
});
test("PR #1156 follow-up: settings changes invalidate evidence across scan blocks", (t) => {
  const f = fixture(t, "user", [responseRecord(CHUNK_BYTES / 2),
    line("event_msg", { type: "thread_settings_applied",
      thread_settings: { approvals_reviewer: "auto_review", approval_policy: "on-request" } }),
    ...Array(5).fill(responseRecord(CHUNK_BYTES / 2))]);
  assert.equal(f.route().owner, "codex");
});
test("PR #1156 follow-up: unchanged approval settings preserve human evidence across scan blocks", (t) => {
  const f = fixture(t, "user", [responseRecord(CHUNK_BYTES / 2),
    line("event_msg", { type: "thread_settings_applied",
      thread_settings: { approvals_reviewer: "user", approval_policy: "on-request" } }),
    ...Array(7).fill(responseRecord(CHUNK_BYTES / 2))]);
  assert.equal(f.route().owner, "clawd");
});
test("PR #1156 follow-up: a policy change invalidates evidence even when the reviewer is unchanged", (t) => {
  const f = fixture(t, "user", [line("event_msg", { type: "thread_settings_applied",
    thread_settings: { approvals_reviewer: "user", approval_policy: "never" } })]);
  assert.equal(f.route().owner, "codex");
});
test("PR #1156 follow-up: incomplete or nonobject settings invalidate approval evidence", (t) => {
  for (const settings of [undefined, null, "invalid", 1, [],
    { approval_policy: "on-request" }, { approvals_reviewer: "user" }]) {
    const f = fixture(t, "user", [line("event_msg", { type: "thread_settings_applied", thread_settings: settings })]);
    assert.equal(f.route().owner, "codex", JSON.stringify(settings));
  }
});
test("PR #1156 follow-up: a later reviewer change invalidates previously preserved evidence", (t) => {
  const unchanged = line("event_msg", { type: "thread_settings_applied",
    thread_settings: { approvals_reviewer: "user", approval_policy: "on-request" } });
  const f = fixture(t, "user", [unchanged]);
  assert.equal(f.route().owner, "clawd");
  fs.appendFileSync(f.file, line("event_msg", { type: "thread_settings_applied",
    thread_settings: { approvals_reviewer: "auto_review", approval_policy: "on-request" } }) + "\n");
  assert.equal(f.route().owner, "codex");
  fs.appendFileSync(f.file, unchanged + "\n");
  assert.equal(f.route().owner, "codex");
});
test("PR #1156 follow-up: invalid context payloads do not stop the search for earlier human evidence", (t) => {
  for (const payload of [null, undefined, "invalid", 1, false]) {
    const f = fixture(t, "user", [...Array(6).fill(responseRecord(CHUNK_BYTES / 2)),
      line("turn_context", payload), responseRecord(CHUNK_BYTES / 2)]);
    assert.equal(f.route().owner, "clawd", String(payload));
  }
});
test("PR #1156 follow-up: an aborted turn invalidates evidence across scan blocks", (t) => {
  const f = fixture(t, "user", [responseRecord(CHUNK_BYTES / 2),
    line("event_msg", { type: "turn_aborted", turn_id: TURN }),
    ...Array(5).fill(responseRecord(CHUNK_BYTES / 2))]);
  assert.deepEqual(f.route(), { owner: "codex", reason: "automatic-or-unknown-reviewer" });
});
test("PR #1156 follow-up: a newer turn context stops the scan without borrowing older evidence", (t) => {
  const f = fixture(t, "user", [...Array(6).fill(responseRecord(CHUNK_BYTES / 2)),
    line("turn_context", { turn_id: "other-turn", approvals_reviewer: "user", approval_policy: "on-request" }),
    responseRecord(CHUNK_BYTES / 2)]);
  const read = t.mock.method(fs, "readSync");
  assert.equal(f.route().owner, "codex");
  assert.equal(read.mock.calls.filter((call) => call.arguments[3] === CHUNK_BYTES).length, 1);
});
test("PR #1156 follow-up: the cumulative scan limit leaves older contexts out of bounds", (t) => {
  const f = fixture(t, "user", Array(8).fill(responseRecord(512)));
  assert.deepEqual(f.route({ maxScanBytes: 2048 }), { owner: "codex", reason: "automatic-or-unknown-reviewer" });
  assert.equal(f.route({ maxScanBytes: 8192 }).owner, "clawd");
});
test("PR #1156 follow-up: a requested budget above 32 MiB cannot exceed the hard scan limit", (t) => {
  const f = fixture(t);
  const response = responseRecord(CHUNK_BYTES / 2) + "\n";
  for (let i = 0; i < 66; i++) fs.appendFileSync(f.file, response);
  const read = t.mock.method(fs, "readSync");
  assert.deepEqual(f.route({ maxScanBytes: 64 * CHUNK_BYTES }), {
    owner: "codex", reason: "automatic-or-unknown-reviewer",
  });
  assert.equal(read.mock.calls.filter((call) => call.arguments[3] === CHUNK_BYTES).length, 32);
});
test("PR #1156 follow-up: inode replacement with unchanged size and mtime invalidates the transcript", (t) => {
  const f = fixture(t);
  // Match the native canonical path used by the reader, including Windows
  // short-name expansion and case normalization in CI temporary directories.
  const file = fs.realpathSync.native(f.file);
  if (process.platform === "win32") f.data.transcript_path = file.toUpperCase();
  const before = fs.statSync(file);
  const after = { ...before, ino: before.ino === 0 ? 1 : 0 };
  const stat = fs.statSync;
  const statMock = t.mock.method(fs, "statSync", (filePath, ...args) => {
    if (filePath === file) return after;
    return stat(filePath, ...args);
  });
  assert.notEqual(after.ino, before.ino);
  assert.deepEqual({ ...after, ino: before.ino }, { ...before });
  const route = f.route();
  assert.equal(statMock.mock.calls.filter(call => call.arguments[0] === file).length, 1);
  assert.deepEqual(route, { owner: "codex", reason: "transcript-changed" });
});
test("PR #1156 follow-up: a turn context split by a scan block is completed by the next block", (t) => {
  const context = line("turn_context", { turn_id: TURN, approvals_reviewer: "user", approval_policy: "on-request" });
  const f = fixture(t, "user", [responseRecord(CHUNK_BYTES - Math.floor((context.length + 1) / 2))]);
  assert.equal(f.route().owner, "clawd");
});
test("PR #1156 follow-up: a truncated response fragment cannot invalidate complete human evidence", (t) => {
  const f = fixture(t);
  const text = [line("session_meta", { id: SESSION }),
    line("response_item", { text: "x".repeat(4096), tail: { type: "event_msg", payload: { type: "task_complete" } } }),
    line("turn_context", { turn_id: TURN, approvals_reviewer: "user", approval_policy: "on-request" }),
    responseRecord(512)].join("\n") + "\n";
  fs.writeFileSync(f.file, text);
  const start = text.indexOf('"type":"event_msg"');
  assert.equal(f.route({ maxScanBytes: text.length - start }).owner, "clawd");
});
test("PR #1156 follow-up: response contents cannot impersonate approval records", (t) => {
  const f = fixture(t, "user", [line("response_item", { text: '"type":"turn_context"',
    payload: { type: "turn_context", turn_id: "other-turn" } })]);
  const parse = t.mock.method(JSON, "parse");
  assert.equal(f.route().owner, "clawd");
  assert.ok(parse.mock.calls.every((call) => !call.arguments[0].startsWith('{"type":"response_item"')));
});
test("PR #1156 follow-up: symlinked Codex session directories accept their real transcripts", {
  skip: process.platform === "win32" ? "Directory symlinks require Windows privileges; this case covers POSIX." : false,
}, (t) => {
  for (const name of ["sessions", "archived_sessions"]) {
    const f = fixture(t);
    const storage = path.join(f.home, "storage");
    fs.renameSync(path.join(f.home, "sessions"), storage);
    fs.symlinkSync(storage, path.join(f.home, name), "dir");
    f.data.transcript_path = path.join(storage, path.basename(f.file));
    assert.equal(f.route().owner, "clawd", name);
  }
});


test("approval evidence uses native canonical paths for home, session roots and transcript", (t) => {
  const f = fixture(t);
  const native = t.mock.method(fs.realpathSync, "native");
  assert.equal(f.route().owner, "clawd");
  const paths = native.mock.calls.map(call => call.arguments[0]);
  assert.ok(paths.includes(f.home));
  assert.ok(paths.includes(f.file));
  assert.ok(paths.includes(path.join(fs.realpathSync.native(f.home), "sessions")));
});

test("Windows namespaced transcript paths preserve current-turn and containment checks", {
  skip: process.platform !== "win32" ? "Uses real Windows namespaced filesystem paths." : false,
}, (t) => {
  const f = fixture(t);
  f.data.transcript_path = path.toNamespacedPath(f.file);
  assert.deepEqual(f.route({ codexHome: path.toNamespacedPath(f.home) }), {
    owner: "clawd", reason: "current-human-reviewer",
  });
  f.data.turn_id = "wrong-turn";
  assert.equal(f.route().owner, "codex");
  f.data.turn_id = TURN;
  const foreign = path.join(f.home, "foreign.jsonl");
  fs.copyFileSync(f.file, foreign);
  f.data.transcript_path = path.toNamespacedPath(foreign);
  assert.deepEqual(f.route(), { owner: "codex", reason: "foreign-transcript" });
});
