"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  workBuddyDataDirs,
  readWorkBuddyDatabaseSession,
  readWorkBuddyDatabaseTitle,
  createWorkBuddySessionTitleTracker,
} = require("../src/workbuddy-session-title");
const { createJsonlSessionTitleTracker } = require("../src/jsonl-session-title");
const createAgentRuntimeMain = require("../src/agent-runtime-main");
const initState = require("../src/state");
const themeLoader = require("../src/theme-loader");

let DatabaseSync;
try { ({ DatabaseSync } = require("node:sqlite")); } catch {}
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-workbuddy-title-"));
  try { await run(home); }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function makeRuntimeState() {
  themeLoader.init(path.join(__dirname, "..", "src"));
  const sounds = [];
  const state = initState({
    theme: themeLoader.loadTheme("clawd"), lang: "en", pendingPermissions: [],
    playSound: (name) => sounds.push(name),
    sendToRenderer() {}, syncHitWin() {}, sendToHitWin() {}, buildContextMenu() {}, buildTrayMenu() {},
    getCursorScreenPoint: () => ({ x: 0, y: 0 }), mouseStillSince: Date.now(), getSessionAliases: () => ({}),
  });
  return { state, sounds };
}

function createDatabase(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "workbuddy.db"));
  db.exec("DROP TABLE IF EXISTS sessions; "
    + "CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, custom_title TEXT, cwd TEXT, deleted_at INTEGER, status TEXT)");
  const insert = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)");
  for (const row of rows) insert.run(row[0], row[1], row[2], row[3], row[4], row[5] ?? null);
  db.close();
}

function createLegacyDatabase(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "workbuddy.db"));
  db.exec("DROP TABLE IF EXISTS sessions; "
    + "CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, custom_title TEXT, cwd TEXT, deleted_at INTEGER)");
  const insert = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)");
  for (const row of rows) insert.run(...row);
  db.close();
}

function updateDatabase(dir, sql, ...args) {
  const db = new DatabaseSync(path.join(dir, "workbuddy.db"));
  db.prepare(sql).run(...args);
  db.close();
}

// Wraps fs/promises so the reader parks on the read after `pauseAfterReads`.
// This is a real read barrier: the bytes before it are already consumed, and
// the scan is genuinely still in flight until resume() is called. `parked`
// resolves the moment the reader is held, so tests can await it instead of
// polling the clock.
function makePausedReaderFs(pauseAfterReads = 1) {
  const fsp = require("node:fs/promises");
  let reads = 0;
  let armed = true;
  let release;
  let markParked;
  const gate = new Promise((resolve) => { release = resolve; });
  const parked = new Promise((resolve) => { markParked = resolve; });
  return {
    fs: {
      async open(...args) {
        const fd = await fsp.open(...args);
        return {
          stat: (...a) => fd.stat(...a),
          close: (...a) => fd.close(...a),
          async read(buffer, offset, length, position) {
            reads++;
            if (armed && reads > pauseAfterReads) {
              armed = false;
              markParked();
              await gate;
            }
            return fd.read(buffer, offset, length, position);
          },
        };
      },
    },
    parked,
    resume: () => release(),
  };
}

function runtimeWorkBuddyOptions(extra = {}) {
  return { agentId: "workbuddy", profileId: "local", rawSessionId: "s1", cwd: "/project", ...extra };
}

function hash(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

describe("WorkBuddy native title storage", () => {
  it("uses an absolute configured home and both desktop generations", () => {
    const home = path.resolve("fixture-home");
    const custom = path.resolve("custom-workbuddy");
    assert.deepEqual(workBuddyDataDirs({ homeDir: home, env: { WORKBUDDY_CONFIG_DIR: ` ${custom} ` } }),
      [custom, path.join(home, ".workbuddy-ai"), path.join(home, ".workbuddy")]);
    assert.equal(workBuddyDataDirs({ homeDir: home, env: { WORKBUDDY_CONFIG_DIR: "relative" } }).length, 2);
  });

  it("reads only the matching session, prefers custom names, and leaves bytes unchanged", { skip: !DatabaseSync }, async () => {
    await fixture(async (dir) => {
      createDatabase(dir, [["s1", "Generated name", "User renamed chat", "/project", null],
        ["other", "Wrong session", null, "/project", null]]);
      const file = path.join(dir, "workbuddy.db");
      const before = hash(file);
      assert.equal(readWorkBuddyDatabaseTitle({ rawSessionId: "s1", cwd: "/project" }, { dataDirs: [dir] }), "User renamed chat");
      assert.equal(readWorkBuddyDatabaseTitle({ rawSessionId: "s1", cwd: "/different" }, { dataDirs: [dir] }), null);
      assert.equal(readWorkBuddyDatabaseTitle({ rawSessionId: "s1' OR 1=1 --" }, { dataDirs: [dir] }), null);
      assert.equal(hash(file), before);
      // The read-only handle is closed, so the application can still write.
      const db = new DatabaseSync(file);
      db.prepare("UPDATE sessions SET custom_title = ? WHERE id = ?").run("Renamed again", "s1");
      db.close();
      assert.equal(readWorkBuddyDatabaseTitle({ rawSessionId: "s1" }, { dataDirs: [dir] }), "Renamed again");
    });
  });

  it("prefers the home owning the transcript and ignores deleted/oversized rows", { skip: !DatabaseSync }, async () => {
    await fixture(async (home) => {
      const current = path.join(home, ".workbuddy-ai");
      const legacy = path.join(home, ".workbuddy");
      createDatabase(current, [["s1", "Stale current home", null, "/project", null]]);
      createDatabase(legacy, [["s1", "Active legacy home", null, "/project", null],
        ["deleted", "Deleted", null, "/project", 1],
        ["large", "x".repeat(5000), null, "/project", null],
        ["custom-only", null, "Custom only", "/project", null]]);
      const options = { homeDir: home, env: {} };
      assert.equal(readWorkBuddyDatabaseTitle({ rawSessionId: "s1", transcriptPath: path.join(legacy, "projects", "p", "s1.jsonl") }, options), "Active legacy home");
      for (const rawSessionId of ["deleted", "large", "missing"]) {
        assert.equal(readWorkBuddyDatabaseTitle({ rawSessionId }, options), null);
      }
      assert.equal(readWorkBuddyDatabaseTitle({ rawSessionId: "custom-only" }, options), "Custom only");
    });
  });

  it("tolerates absent files, unavailable SQLite, and unknown/corrupt schemas", async () => {
    await fixture(async (dir) => {
      const options = { dataDirs: [dir], openDatabase: () => { throw new Error("unsupported SQLite"); } };
      assert.equal(readWorkBuddyDatabaseTitle({ rawSessionId: "s1" }, options), null);
      assert.deepEqual(fs.readdirSync(dir), []);
      fs.writeFileSync(path.join(dir, "workbuddy.db"), "not a database");
      assert.equal(readWorkBuddyDatabaseTitle({ rawSessionId: "s1" }, options), null);
      assert.equal(readWorkBuddyDatabaseTitle({ rawSessionId: "s1" }, { dataDirs: [dir] }), null);
    });
  });

  it("issue #655: reports an unreadable database as unknown, never as archive evidence", async () => {
    await fixture(async (dir) => {
      const options = { dataDirs: [dir], openDatabase: () => { throw new Error("unsupported SQLite"); } };
      assert.equal(readWorkBuddyDatabaseSession({ rawSessionId: "s1" }, options), null);
      assert.deepEqual(fs.readdirSync(dir), []);
      fs.writeFileSync(path.join(dir, "workbuddy.db"), "not a database");
      assert.equal(readWorkBuddyDatabaseSession({ rawSessionId: "s1" }, options), null);
      assert.equal(readWorkBuddyDatabaseSession({ rawSessionId: "s1" }, { dataDirs: [dir] }), null);
    });
  });

  it("issue #655: reports archived and deleted rows, and reports nothing for unknown ones", { skip: !DatabaseSync }, async () => {
    await fixture(async (dir) => {
      createDatabase(dir, [
        ["active", "Active chat", null, "/project", null, "Pending"],
        ["archived", "Archived chat", null, "/project", null, "archived"],
        ["deleted", "Deleted chat", null, "/project", 1700, "Pending"],
        ["completed", "Completed chat", null, "/project", null, "completed"],
      ]);
      // The lifecycle is only reported for the home owning the transcript.
      const transcriptPath = path.join(dir, "projects", "p", "s1.jsonl");
      const read = (rawSessionId) => readWorkBuddyDatabaseSession(
        { rawSessionId, cwd: "/project", transcriptPath }, { dataDirs: [dir] });
      assert.deepEqual(read("active"), { title: "Active chat", archived: false, home: dir });
      assert.deepEqual(read("archived"), { title: "Archived chat", archived: true, home: dir });
      assert.deepEqual(read("deleted"), { title: null, archived: true, home: dir });
      assert.deepEqual(read("completed"), { title: "Completed chat", archived: false, home: dir });
      assert.equal(read("missing"), null);
    });
  });

  it("issue #655: without an owning transcript the lifecycle is always unknown", { skip: !DatabaseSync }, async () => {
    await fixture(async (dir) => {
      createDatabase(dir, [["s1", "Some title", null, "/project", null, "archived"]]);
      // No transcript at all.
      assert.equal(
        readWorkBuddyDatabaseSession({ rawSessionId: "s1", cwd: "/project" }, { dataDirs: [dir] }).archived,
        null
      );
      // A transcript that no known home owns.
      const outside = path.join(path.dirname(dir), "elsewhere", "s1.jsonl");
      const result = readWorkBuddyDatabaseSession(
        { rawSessionId: "s1", cwd: "/project", transcriptPath: outside }, { dataDirs: [dir] });
      assert.equal(result.archived, null, "an unowned transcript cannot pick a lifecycle home");
      assert.equal(result.title, "Some title", "the title is still searched across homes");
    });
  });

  it("issue #655: decides lifecycle only from the home owning the transcript", { skip: !DatabaseSync }, async () => {
    await fixture(async (home) => {
      const owner = path.join(home, ".workbuddy-ai");
      const sibling = path.join(home, ".workbuddy");
      // The owning home has the live row but no title; the sibling holds an
      // archived copy of the same id and cwd.
      createDatabase(owner, [["s1", null, null, "/project", null, "Pending"]]);
      createDatabase(sibling, [["s1", "Archived copy", null, "/project", null, "archived"]]);
      const options = { homeDir: home, env: {} };
      const transcriptPath = path.join(owner, "projects", "p", "s1.jsonl");
      const live = readWorkBuddyDatabaseSession({ rawSessionId: "s1", cwd: "/project", transcriptPath }, options);
      assert.deepEqual(live, { title: "Archived copy", archived: false, home: owner });
      // Pinning the owning home keeps the same verdict when a late read has no
      // transcript path to sort with.
      assert.deepEqual(
        readWorkBuddyDatabaseSession({ rawSessionId: "s1", cwd: "/project", lifecycleHome: owner }, options),
        { title: "Archived copy", archived: false, home: owner }
      );
    });
  });

  it("issue #655: a missing or unreadable owning home never adopts a sibling's archive copy", { skip: !DatabaseSync }, async () => {
    await fixture(async (home) => {
      const owner = path.join(home, ".workbuddy-ai");
      const sibling = path.join(home, ".workbuddy");
      createDatabase(owner, [["elsewhere", "Other", null, "/project", null, "Pending"]]);
      createDatabase(sibling, [["s1", "Sibling copy", null, "/project", null, "archived"]]);
      const options = { homeDir: home, env: {} };
      const transcriptPath = path.join(owner, "projects", "p", "s1.jsonl");
      const missing = readWorkBuddyDatabaseSession({ rawSessionId: "s1", cwd: "/project", transcriptPath }, options);
      assert.equal(missing.archived, null, "the owning home has no row, so lifecycle is unknown");
      const unreadable = readWorkBuddyDatabaseSession({ rawSessionId: "s1", cwd: "/project", transcriptPath },
        { ...options, openDatabase: (file) => {
          if (file.startsWith(owner)) throw new Error("locked");
          const { DatabaseSync: Db } = require("node:sqlite");
          return new Db(file, { readOnly: true });
        } });
      assert.equal(unreadable.archived, null, "the owning home cannot be read, so lifecycle is unknown");
    });
  });

  it("issue #655: a table without a status column still supplies titles and reports unknown lifecycle", { skip: !DatabaseSync }, async () => {
    await fixture(async (dir) => {
      createLegacyDatabase(dir, [["s1", "Legacy title", null, "/project", null]]);
      const transcriptPath = path.join(dir, "projects", "p", "s1.jsonl");
      assert.deepEqual(
        readWorkBuddyDatabaseSession({ rawSessionId: "s1", cwd: "/project", transcriptPath }, { dataDirs: [dir] }),
        { title: "Legacy title", archived: null, home: dir }
      );
      const updates = [];
      const retired = [];
      const session = {};
      const tracker = createWorkBuddySessionTitleTracker({ dataDirs: [dir], getSession: () => session,
        updateTitle: (id, title) => updates.push(title), onRetired: (i) => retired.push(i), pollMs: 60_000 });
      try {
        tracker.track({ sessionId: "s1", rawSessionId: "s1", cwd: "/project", transcriptPath });
        await tracker.poll();
        assert.deepEqual(updates, ["Legacy title"]);
        assert.deepEqual(retired, []);
      } finally { tracker.clear(); }
    });
  });

  it("issue #655: observes an archive committed by another open WAL-mode connection", { skip: !DatabaseSync }, async () => {
    await fixture(async (dir) => {
      const file = path.join(dir, "workbuddy.db");
      const writer = new DatabaseSync(file);
      try {
        assert.equal(writer.prepare("PRAGMA journal_mode=WAL").get().journal_mode, "wal");
        writer.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, custom_title TEXT, cwd TEXT, deleted_at INTEGER, status TEXT)");
        writer.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)").run("s1", "Name", null, "/project", null, "Pending");
        writer.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run("s1");
        // A separate connection must see the committed value the observer
        // relies on for archive detection.
        assert.deepEqual(
          readWorkBuddyDatabaseSession(
            { rawSessionId: "s1", cwd: "/project", transcriptPath: path.join(dir, "projects", "p", "s1.jsonl") },
            { dataDirs: [dir] }),
          { title: "Name", archived: true, home: dir }
        );
      } finally {
        writer.close();
      }
    });
  });
});

describe("WorkBuddy title observer", () => {
  it("discovers delayed ai-title and custom-title without another hook", async () => {
    await fixture(async (dir) => {
      const transcriptPath = path.join(dir, "s1.jsonl");
      fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: "message", content: "Prompt content must not be a native title" })}\n`);
      const session = {};
      const updates = [];
      const tracker = createWorkBuddySessionTitleTracker({ dataDirs: [dir], getSession: () => session,
        updateTitle: (id, title) => updates.push([id, title]), pollMs: 60_000 });
      try {
        tracker.track({ sessionId: "s1", rawSessionId: "s1", transcriptPath });
        await tracker.poll();
        assert.deepEqual(updates, []);
        fs.appendFileSync(transcriptPath, `${JSON.stringify({ type: "ai-title", sessionId: "other", aiTitle: "Wrong chat" })}\n`
          + `${JSON.stringify({ type: "ai-title", sessionId: "s1", aiTitle: "Generated chat name" })}\n`);
        await tracker.poll();
        assert.deepEqual(updates.at(-1), ["s1", "Generated chat name"]);
        fs.appendFileSync(transcriptPath, `${JSON.stringify({ type: "custom-title", sessionId: "s1", customTitle: "Renamed chat" })}\n`
          + `${JSON.stringify({ type: "ai-title", sessionId: "s1", aiTitle: "Later generation" })}\n`);
        await tracker.poll();
        assert.deepEqual(updates.at(-1), ["s1", "Renamed chat"]);
      } finally { tracker.clear(); }
    });
  });

  it("bounds each JSONL scan while eventually reaching a late title", async () => {
    await fixture(async (dir) => {
      const transcriptPath = path.join(dir, "s1.jsonl");
      fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: "message", content: "x".repeat(150_000) })}\n`
        + `${JSON.stringify({ type: "ai-title", sessionId: "s1", aiTitle: "Late native name" })}\n`);
      const scans = [];
      const reader = createJsonlSessionTitleTracker({ maxScanBytes: 64 * 1024, onScan: (scan) => scans.push(scan) });
      try {
        const input = { event: "Stop", sessionId: "s1", transcriptPath };
        assert.equal(await reader.resolve(input), null);
        assert.equal(await reader.resolve(input), null);
        assert.equal(await reader.resolve(input), "Late native name");
        assert.ok(scans.every((scan) => scan.contentBytesRead <= 64 * 1024));
      } finally { reader.clear(); }
    });
  });

  it("serializes overlapping polls and discards reads after end, resume, or disable", async () => {
    for (const action of ["end", "resume", "disable"]) {
      const resolvers = [];
      let reads = 0;
      let session = {};
      const updates = [];
      const tracker = createWorkBuddySessionTitleTracker({ getSession: () => session,
        updateTitle: (...args) => updates.push(args), pollMs: 60_000,
        readTitle: () => { reads++; return new Promise((done) => { resolvers.push(done); }); } });
      try {
        tracker.track({ sessionId: "s1", rawSessionId: "s1" });
        const pending = tracker.poll();
        assert.equal(reads, 1);
        if (action === "disable") session = null;
        else {
          tracker.clear("s1");
          if (action === "resume") { session = {}; tracker.track({ sessionId: "s1", rawSessionId: "s1" }); }
        }
        resolvers[0]("Old name");
        await pending;
        assert.deepEqual(updates, []);
        if (action === "resume") {
          resolvers[1]("Resumed name");
          await tracker.poll();
          assert.deepEqual(updates, [["s1", "Resumed name"]]);
        }
        if (action === "disable") { await tracker.poll(); assert.equal(tracker.size(), 0); }
      } finally { tracker.clear(); }
    }
  });

  it("issue #655: retires once the row is archived or deleted and never on unknown evidence", { skip: !DatabaseSync }, async () => {
    await fixture(async (dir) => {
      const transcriptPath = path.join(dir, "projects", "p", "s1.jsonl");
      for (const [label, mutate, extraRows] of [
        ["status-archived", "UPDATE sessions SET status = 'archived' WHERE id = 's1'", [["s1", "Name", null, "/project", null, "Pending"]]],
        ["deleted_at", "UPDATE sessions SET deleted_at = 1700 WHERE id = 's1'", [["s1", "Name", null, "/project", null, "Pending"]]],
        ["missing-row", null, []],
      ]) {
        createDatabase(dir, extraRows);
        const session = {};
        const retired = [];
        const tracker = createWorkBuddySessionTitleTracker({ dataDirs: [dir], getSession: () => session,
          onRetired: (info) => retired.push(info), pollMs: 60_000 });
        try {
          tracker.track({ sessionId: "s1", rawSessionId: "s1", cwd: "/project", transcriptPath });
          await tracker.poll();
          if (mutate) {
            updateDatabase(dir, mutate);
            await tracker.poll();
            assert.deepEqual(retired, [{ sessionId: "s1", rawSessionId: "s1", lifecycleHome: dir }], label);
            assert.equal(tracker.size(), 0, label);
          } else {
            assert.deepEqual(retired, [], label);
          }
        } finally { tracker.clear(); }
      }
    });
  });

  it("issue #655: an unavailable database reader is consulted and never retires", async () => {
    await fixture(async (dir) => {
      const session = {};
      const retired = [];
      let openerCalls = 0;
      // The file has to exist or the injected opener is never consulted.
      fs.writeFileSync(path.join(dir, "workbuddy.db"), "");
      const tracker = createWorkBuddySessionTitleTracker({ dataDirs: [dir], getSession: () => session,
        openDatabase: () => { openerCalls++; throw new Error("unsupported SQLite"); },
        onRetired: (i) => retired.push(i), pollMs: 60_000 });
      try {
        tracker.track({ sessionId: "s1", rawSessionId: "s1" });
        await tracker.poll();
        assert.ok(openerCalls >= 1, "the injected opener must be exercised");
        assert.deepEqual(retired, []);
      } finally { tracker.clear(); }
    });
  });

  it("issue #655: a real archive retires the observed session", { skip: !DatabaseSync }, async () => {
    await fixture(async (dir) => {
      createDatabase(dir, [["s1", "Name", null, "/project", null, "archived"]]);
      const session = {};
      const retired = [];
      const tracker = createWorkBuddySessionTitleTracker({ dataDirs: [dir], getSession: () => session,
        onRetired: (i) => retired.push(i), pollMs: 60_000 });
      try {
        tracker.track({ sessionId: "s1", rawSessionId: "s1", cwd: "/project",
          transcriptPath: path.join(dir, "projects", "p", "s1.jsonl") });
        await tracker.poll();
        assert.equal(retired.length, 1, "a real archive retires the observed session");
      } finally { tracker.clear(); }
    });
  });

  it("issue #655: never retires a live card from a sibling home's archive copy", { skip: !DatabaseSync }, async () => {
    await fixture(async (home) => {
      const owner = path.join(home, ".workbuddy-ai");
      const sibling = path.join(home, ".workbuddy");
      createDatabase(owner, [["s1", null, null, "/project", null, "Pending"]]);
      createDatabase(sibling, [["s1", "Archived copy", null, "/project", null, "archived"]]);
      const session = {};
      const retired = [];
      const tracker = createWorkBuddySessionTitleTracker({ homeDir: home, env: {}, getSession: () => session,
        onRetired: (i) => retired.push(i), pollMs: 60_000 });
      try {
        tracker.track({ sessionId: "s1", rawSessionId: "s1", cwd: "/project",
          transcriptPath: path.join(owner, "projects", "p", "s1.jsonl") });
        await tracker.poll();
        assert.deepEqual(retired, []);
      } finally { tracker.clear(); }
    });
  });

  it("issue #655: a transcript outside every home never retires a card", { skip: !DatabaseSync }, async () => {
    await fixture(async (dir) => {
      createDatabase(dir, [["s1", "Copy", null, "/project", null, "archived"]]);
      const retired = [];
      const session = {};
      const tracker = createWorkBuddySessionTitleTracker({ dataDirs: [dir], getSession: () => session,
        onRetired: (i) => retired.push(i), pollMs: 60_000 });
      try {
        const outside = path.join(path.dirname(dir), "elsewhere", "s1.jsonl");
        tracker.track({ sessionId: "s1", rawSessionId: "s1", cwd: "/project", transcriptPath: outside });
        await tracker.poll();
        assert.deepEqual(retired, [], "an unowned transcript cannot pick the archive home");
        tracker.clear("s1");
        tracker.track({ sessionId: "s1", rawSessionId: "s1", cwd: "/project" });
        await tracker.poll();
        assert.deepEqual(retired, [], "no transcript is unknown, not an archive");
      } finally { tracker.clear(); }
    });
  });

  // These two tests replace the transcript while the old scan still holds it
  // open, so that the next event has to notice the changed file identity.
  // Windows refuses to rename over a file another handle holds open
  // (fs.renameSync raises EPERM), so the precondition cannot be built there;
  // the identity comparison itself is platform-independent and is exercised on
  // macOS and Linux.
  const replaceWhileOpen = {
    timeout: 10_000,
    skip: process.platform === "win32"
      ? "Windows cannot replace a file that another handle holds open"
      : false,
  };

  it("issue #655: a replacement before the SessionStart sample drops the old reader immediately", replaceWhileOpen, async () => {
    await fixture(async (dir) => {
      const transcriptPath = path.join(dir, "s.jsonl");
      const filler = `{"type":"message","content":"${"x".repeat(500)}"}\n`;
      fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: "ai-title", sessionId: "s1", aiTitle: "Old file title" })}\n`
        + filler.repeat(400)); // > one 64 KiB chunk, < one 1 MiB scan
      const barrier = makePausedReaderFs(1);
      const updates = [];
      const session = {};
      const tracker = createWorkBuddySessionTitleTracker({ dataDirs: [path.join(dir, "absent")],
        getSession: () => session, updateTitle: (id, title) => updates.push(title),
        readerFs: barrier.fs, pollMs: 60_000 });
      try {
        tracker.track({ sessionId: "s1", rawSessionId: "s1", transcriptPath });
        // The title chunk is consumed and the old scan is parked; replace the
        // file before beginTurn takes its identity sample.
        await barrier.parked;
        const replacement = path.join(dir, "replacement.jsonl");
        fs.writeFileSync(replacement, `${JSON.stringify({ type: "message", content: "no title here" })}\n`);
        fs.renameSync(replacement, transcriptPath);
        tracker.beginTurn({ sessionId: "s1", rawSessionId: "s1", transcriptPath });
        barrier.resume();
        await tracker.poll();
        assert.deepEqual(updates, [], "the old reader must be dropped before the new turn reads");
      } finally { barrier.resume(); tracker.clear(); }
    });
  });

  it("issue #655: a replacement after the SessionStart sample surfaces on the next event", replaceWhileOpen, async () => {
    await fixture(async (dir) => {
      const transcriptPath = path.join(dir, "s.jsonl");
      const filler = `{"type":"message","content":"${"x".repeat(500)}"}\n`;
      fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: "ai-title", sessionId: "s1", aiTitle: "Old file title" })}\n`
        + filler.repeat(400));
      const barrier = makePausedReaderFs(1);
      let armSwap = false;
      let swapped = false;
      // The swap happens from inside the first stat call after `armSwap`. That
      // sample only decides whether the JSONL reader is kept or reset and is the
      // identity recorded on the observation; it has nothing to do with the
      // archive/delete lifecycle.
      const statSync = (file) => {
        const stat = fs.statSync(file);
        if (armSwap && !swapped) {
          swapped = true;
          armSwap = false;
          const replacement = path.join(dir, "replacement.jsonl");
          fs.writeFileSync(replacement, `${JSON.stringify({ type: "message", content: "no title here" })}\n`);
          fs.renameSync(replacement, transcriptPath);
        }
        return { dev: stat.dev, ino: stat.ino };
      };
      const updates = [];
      const session = {};
      const tracker = createWorkBuddySessionTitleTracker({ dataDirs: [path.join(dir, "absent")],
        getSession: () => session, updateTitle: (id, title) => updates.push(title),
        readerFs: barrier.fs, statSync, pollMs: 60_000 });
      try {
        tracker.track({ sessionId: "s1", rawSessionId: "s1", transcriptPath });
        await barrier.parked;
        armSwap = true;
        tracker.beginTurn({ sessionId: "s1", rawSessionId: "s1", transcriptPath });
        barrier.resume();
        await tracker.poll();
        // This event sampled the old file, so its own read may still report the
        // old title. What we verify is the next event: once its sample sees the
        // changed identity and the reader is reset, no old title is reported.
        const before = updates.length;
        tracker.track({ sessionId: "s1", rawSessionId: "s1", transcriptPath });
        await tracker.poll();
        assert.deepEqual(updates.slice(before), [], "the next event must not resurrect the old file's title");
      } finally { barrier.resume(); tracker.clear(); }
    });
  });

  it("issue #655: the same steps still read the title when the file is not replaced", { timeout: 10_000 }, async () => {
    await fixture(async (dir) => {
      const transcriptPath = path.join(dir, "s.jsonl");
      const filler = `{"type":"message","content":"${"x".repeat(500)}"}\n`;
      fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: "ai-title", sessionId: "s1", aiTitle: "Kept title" })}\n`
        + filler.repeat(400));
      const barrier = makePausedReaderFs(1);
      const updates = [];
      const session = {};
      const tracker = createWorkBuddySessionTitleTracker({ dataDirs: [path.join(dir, "absent")],
        getSession: () => session, updateTitle: (id, title) => updates.push(title),
        readerFs: barrier.fs, pollMs: 60_000 });
      try {
        tracker.track({ sessionId: "s1", rawSessionId: "s1", transcriptPath });
        await barrier.parked;
        tracker.beginTurn({ sessionId: "s1", rawSessionId: "s1", transcriptPath });
        barrier.resume();
        await tracker.poll();
        assert.equal(updates.at(-1), "Kept title", "without a replacement the title is read normally");
      } finally { barrier.resume(); tracker.clear(); }
    });
  });

  it("issue #655: an unreadable file identity resets the reader", async () => {
    await fixture(async (dir) => {
      const transcriptPath = path.join(dir, "s.jsonl");
      fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: "ai-title", sessionId: "s1", aiTitle: "Old file title" })}\n`);
      let failStat = false;
      const statSync = (file) => {
        if (failStat) throw new Error("EACCES");
        return fs.statSync(file);
      };
      const updates = [];
      const session = {};
      const tracker = createWorkBuddySessionTitleTracker({ dataDirs: [path.join(dir, "absent")],
        getSession: () => session, updateTitle: (id, title) => updates.push(title), statSync, pollMs: 60_000 });
      try {
        tracker.track({ sessionId: "s1", rawSessionId: "s1", transcriptPath });
        await tracker.poll();
        assert.equal(updates.at(-1), "Old file title");
        updates.length = 0;
        // Replace the file, but the identity cannot be confirmed this turn, so
        // the reader must be treated as a different file and reset.
        const replacement = path.join(dir, "replacement.jsonl");
        fs.writeFileSync(replacement, `${JSON.stringify({ type: "message", content: "no title here" })}\n`);
        fs.renameSync(replacement, transcriptPath);
        failStat = true;
        tracker.beginTurn({ sessionId: "s1", rawSessionId: "s1", transcriptPath });
        failStat = false;
        await tracker.poll();
        assert.deepEqual(updates, [], "an unreadable identity must reset the reader");
      } finally { tracker.clear(); }
    });
  });

  it("issue #655: beginTurn enforces the shared 256 observation cap", () => {
    const sessions = new Map();
    const tracker = createWorkBuddySessionTitleTracker({ pollMs: 60_000,
      getSession: (id) => { if (!sessions.has(id)) sessions.set(id, {}); return sessions.get(id); },
      readTitle: async () => null });
    try {
      for (let i = 0; i < 257; i++) tracker.beginTurn({ sessionId: `s${i}`, rawSessionId: `s${i}` });
      assert.equal(tracker.size(), 256);
    } finally { tracker.clear(); }
  });

  it("issue #655: samples the transcript identity once per event", () => {
    let stats = 0;
    const sessions = new Map();
    const tracker = createWorkBuddySessionTitleTracker({
      statSync: () => { stats++; return { dev: 1, ino: 1 }; },
      getSession: (id) => { if (!sessions.has(id)) sessions.set(id, {}); return sessions.get(id); },
      readTitle: async () => null,
      pollMs: 60_000,
    });
    try {
      tracker.track({ sessionId: "s1", rawSessionId: "s1", transcriptPath: "/t.jsonl" });
      assert.equal(stats, 1, "track must sample the identity once");
      tracker.beginTurn({ sessionId: "s1", rawSessionId: "s1", transcriptPath: "/t.jsonl" });
      assert.equal(stats, 2, "beginTurn must sample the identity once");
    } finally { tracker.clear(); }
  });

  it("issue #655: exposes an unknown/active/archived lifecycle re-check", { skip: !DatabaseSync }, async () => {
    await fixture(async (dir) => {
      createDatabase(dir, [["s1", "Name", null, "/project", null, "Pending"]]);
      const tracker = createWorkBuddySessionTitleTracker({ dataDirs: [dir], getSession: () => ({}), pollMs: 60_000 });
      const transcriptPath = path.join(dir, "projects", "p", "s1.jsonl");
      try {
        assert.equal(tracker.readArchived({ rawSessionId: "s1", cwd: "/project", transcriptPath }), false);
        assert.equal(tracker.readArchived({ rawSessionId: "missing", cwd: "/project", transcriptPath }), null);
        assert.equal(tracker.readArchived({ rawSessionId: "s1", cwd: "/project" }), null,
          "no transcript and no pinned home is unknown");
        updateDatabase(dir, "UPDATE sessions SET status = 'archived' WHERE id = 's1'");
        assert.equal(tracker.readArchived({ rawSessionId: "s1", cwd: "/project", transcriptPath }), true);
      } finally { tracker.clear(); }
    });
  });

  it("issue #655: rate-limits immediate reads to one per poll window", async () => {
    let reads = 0;
    const sessions = new Map();
    const tracker = createWorkBuddySessionTitleTracker({ pollMs: 60_000,
      getSession: (id) => { if (!sessions.has(id)) sessions.set(id, {}); return sessions.get(id); },
      readTitle: async () => { reads++; return null; } });
    try {
      for (let i = 0; i < 30; i++) {
        tracker.track({ sessionId: "s1", rawSessionId: "s1" });
        await nextTurn();
      }
      assert.ok(reads >= 1, `expected the first read to happen, got ${reads}`);
      assert.ok(reads <= 2, `expected at most 2 reads, got ${reads}`);
    } finally { tracker.clear(); }
  });

  it("issue #655: evicts the oldest observed session past the 256 cap", async () => {
    const sessions = new Map();
    const updates = [];
    const tracker = createWorkBuddySessionTitleTracker({ pollMs: 60_000,
      getSession: (id) => { if (!sessions.has(id)) sessions.set(id, {}); return sessions.get(id); },
      updateTitle: (id) => updates.push(id),
      readTitle: async () => ({ title: "t" }) });
    try {
      for (let i = 0; i < 257; i++) tracker.track({ sessionId: `s${i}`, rawSessionId: `s${i}` });
      assert.equal(tracker.size(), 256);
      await tracker.poll();
      assert.equal(updates.length, 256);
      assert.ok(!updates.includes("s0"), "the oldest observed session is evicted");
    } finally { tracker.clear(); }
  });

  it("issue #655: bounds each JSONL fallback scan to 1 MiB", async () => {
    await fixture(async (dir) => {
      const transcriptPath = path.join(dir, "s1.jsonl");
      const filler = `{"type":"message","content":"${"x".repeat(1000)}"}\n`;
      const fillerBytes = Math.ceil((1.5 * 1024 * 1024) / filler.length);
      fs.writeFileSync(transcriptPath, filler.repeat(fillerBytes)
        + `${JSON.stringify({ type: "ai-title", sessionId: "s1", aiTitle: "Past one MiB" })}\n`);
      const updates = [];
      const session = {};
      const tracker = createWorkBuddySessionTitleTracker({ dataDirs: [path.join(dir, "absent")],
        getSession: () => session, updateTitle: (id, title) => updates.push(title), pollMs: 60_000 });
      try {
        tracker.track({ sessionId: "s1", rawSessionId: "s1", transcriptPath });
        await tracker.poll();
        assert.deepEqual(updates, [], "a >1 MiB transcript must not publish from an unbounded first scan");
        await tracker.poll();
        assert.deepEqual(updates.at(-1), "Past one MiB");
      } finally { tracker.clear(); }
    });
  });
});

describe("WorkBuddy native names through the runtime and snapshots", () => {
  it("keeps real names across follow-up prompts, observes idle renames, and never refreshes activity", { skip: !DatabaseSync }, async () => {
    await fixture(async (dir) => {
      createDatabase(dir, [["s1", "Actual WorkBuddy chat", null, "/project", null]]);
      themeLoader.init(path.join(__dirname, "..", "src"));
      const state = initState({ theme: themeLoader.loadTheme("clawd"), lang: "en", pendingPermissions: [],
        playSound() {}, sendToRenderer() {}, syncHitWin() {}, sendToHitWin() {}, buildContextMenu() {}, buildTrayMenu() {},
        getCursorScreenPoint: () => ({ x: 0, y: 0 }), mouseStillSince: Date.now(), getSessionAliases: () => ({}) });
      let enabled = true;
      const runtime = createAgentRuntimeMain({ updateSession: state.updateSession, getStateRuntime: () => state,
        isAgentEnabled: () => enabled, workBuddySessionTitleOptions: { dataDirs: [dir], pollMs: 20 } });
      const update = (event, title) => runtime.updateSessionFromServer("s1", event === "Stop" ? "attention" : "thinking", event,
        { agentId: "workbuddy", profileId: "local", rawSessionId: "s1", cwd: "/project", sessionTitle: title, sessionTitleFromPrompt: true });
      const waitFor = async (test) => {
        const until = Date.now() + 2000;
        while (!test() && Date.now() < until) await new Promise((done) => setTimeout(done, 5));
        assert.ok(test());
      };
      try {
        update("UserPromptSubmit", "Prompt text");
        await waitFor(() => state.sessions.get("s1").sessionTitle === "Actual WorkBuddy chat");
        update("UserPromptSubmit", "Different follow-up content");
        assert.equal(state.sessions.get("s1").sessionTitle, "Actual WorkBuddy chat");
        update("Stop");
        const before = { updatedAt: state.sessions.get("s1").updatedAt, state: state.sessions.get("s1").state,
          event: state.sessions.get("s1").event };
        const db = new DatabaseSync(path.join(dir, "workbuddy.db"));
        db.prepare("UPDATE sessions SET custom_title=? WHERE id=?").run("Renamed while idle", "s1");
        db.close();
        await waitFor(() => state.sessions.get("s1").sessionTitle === "Renamed while idle");
        const session = state.sessions.get("s1");
        assert.equal(session.updatedAt, before.updatedAt);
        assert.equal(session.state, before.state);
        assert.equal(session.event, before.event);
        assert.equal(session.sessionTitleFromPrompt, false);
        assert.equal(state.buildSessionSnapshot().sessions.find((s) => s.rawSessionId === "s1").sessionTitle, "Renamed while idle");
        enabled = false;
        await nextTurn();
        runtime.clearSessionsByAgent("workbuddy");
        assert.equal(state.sessions.size, 0);
      } finally { runtime.cleanup(); state.cleanup(); }
    });
  });

  it("does not observe remote, WSL, disabled, ended, or foreign-agent sessions", () => {
    const tracks = [];
    const clears = [];
    const sessions = new Map();
    let enabled = true;
    const runtime = createAgentRuntimeMain({ getStateRuntime: () => ({ sessions }), isAgentEnabled: () => enabled,
      updateSession: (id, state, event, opts) => sessions.set(id, { ...opts }),
      workBuddySessionTitleTracker: { track: (...args) => tracks.push(args), clear: (...args) => clears.push(args) } });
    try {
      for (const opts of [{ profileId: "remote" }, { host: "remote-host" }, { wslDistro: "Ubuntu" }, { headless: true }]) {
        runtime.updateSessionFromServer("s1", "working", "PreToolUse", { agentId: "workbuddy", ...opts });
      }
      enabled = false;
      runtime.updateSessionFromServer("s1", "working", "PreToolUse", { agentId: "workbuddy" });
      enabled = true;
      runtime.updateSessionFromServer("s1", "idle", "SessionEnd", { agentId: "workbuddy" });
      runtime.updateSessionFromServer("s1", "working", "PreToolUse", { agentId: "other" });
      assert.deepEqual(tracks, []);
      assert.deepEqual(clears, [["s1"]]);
    } finally { runtime.cleanup(); }
  });

  it("issue #655: retires an archived local card and drops late hooks until unarchived", { skip: !DatabaseSync }, async () => {
    await fixture(async (dir) => {
      createDatabase(dir, [["s1", "Archived soon", null, "/project", null, "archived"]]);
      const transcriptPath = path.join(dir, "projects", "p", "s1.jsonl");
      const { state, sounds } = makeRuntimeState();
      const runtime = createAgentRuntimeMain({ updateSession: state.updateSession, getStateRuntime: () => state,
        isAgentEnabled: () => true, workBuddySessionTitleOptions: { dataDirs: [dir], pollMs: 3_600_000 } });
      const opts = (extra) => runtimeWorkBuddyOptions({ transcriptPath, ...extra });
      try {
        runtime.updateSessionFromServer("s1", "thinking", "UserPromptSubmit", opts());
        await nextTurn();
        assert.equal(state.sessions.get("s1"), undefined);
        assert.deepEqual(sounds.filter((name) => name === "complete"), [], "archive retirement is not a completion");

        assert.strictEqual(runtime.updateSessionFromServer("s1", "attention", "Stop", opts()), false);
        assert.strictEqual(runtime.updateSessionFromServer("s1", "notification", "Notification", opts()), false);
        assert.strictEqual(runtime.updateSessionFromServer("s1", "thinking", "UserPromptSubmit", opts()), false);
        assert.equal(state.sessions.get("s1"), undefined);

        updateDatabase(dir, "UPDATE sessions SET status = 'Pending' WHERE id = 's1'");
        assert.notStrictEqual(runtime.updateSessionFromServer("s1", "thinking", "UserPromptSubmit", opts()), false);
        assert.ok(state.sessions.get("s1"), "unarchived activity rebuilds the card");
      } finally { runtime.cleanup(); state.cleanup(); }
    });
  });

  it("issue #655: never suppresses late hooks for remote, WSL, headless, or foreign agents", { skip: !DatabaseSync }, async () => {
    await fixture(async (dir) => {
      createDatabase(dir, [["s1", "Archived", null, "/project", null, "archived"]]);
      const transcriptPath = path.join(dir, "projects", "p", "s1.jsonl");
      const { state } = makeRuntimeState();
      const runtime = createAgentRuntimeMain({ updateSession: state.updateSession, getStateRuntime: () => state,
        isAgentEnabled: () => true, workBuddySessionTitleOptions: { dataDirs: [dir], pollMs: 3_600_000 } });
      try {
        runtime.updateSessionFromServer("s1", "thinking", "UserPromptSubmit", runtimeWorkBuddyOptions({ transcriptPath }));
        await nextTurn();
        assert.equal(state.sessions.get("s1"), undefined);
        for (const extra of [{ host: "remote-host" }, { wslDistro: "Ubuntu" }, { headless: true }, { agentId: "codex" }]) {
          const result = runtime.updateSessionFromServer("s1", "thinking", "UserPromptSubmit", runtimeWorkBuddyOptions(extra));
          assert.notStrictEqual(result, false, `must not suppress ${JSON.stringify(extra)}`);
        }
      } finally { runtime.cleanup(); state.cleanup(); }
    });
  });

  it("issue #655: suppression follows the stored session's sticky scope, not just this event", { skip: !DatabaseSync }, async () => {
    await fixture(async (dir) => {
      createDatabase(dir, [["s1", "Archived", null, "/project", null, "archived"]]);
      const transcriptPath = path.join(dir, "projects", "p", "s1.jsonl");
      const { state } = makeRuntimeState();
      const runtime = createAgentRuntimeMain({ updateSession: state.updateSession, getStateRuntime: () => state,
        isAgentEnabled: () => true, workBuddySessionTitleOptions: { dataDirs: [dir], pollMs: 3_600_000 } });
      const opts = (extra) => runtimeWorkBuddyOptions({ transcriptPath, ...extra });
      try {
        runtime.updateSessionFromServer("s1", "thinking", "UserPromptSubmit", opts());
        await nextTurn();
        assert.equal(state.sessions.get("s1"), undefined);
        // Re-create the same raw id as a headless session; it is out of scope
        // for archive suppression.
        assert.notStrictEqual(runtime.updateSessionFromServer("s1", "working", "PreToolUse", opts({ headless: true })), false);
        assert.equal(state.sessions.get("s1").headless, true);
        // The next event omits headless; the stored session keeps it, so the
        // effective scope is still headless and must not be suppressed.
        assert.notStrictEqual(runtime.updateSessionFromServer("s1", "working", "PreToolUse", opts()), false);
      } finally { runtime.cleanup(); state.cleanup(); }
    });
  });

  it("issue #655: clears the retired set when the WorkBuddy integration is removed", { skip: !DatabaseSync }, async () => {
    await fixture(async (dir) => {
      createDatabase(dir, [["s1", "Archived", null, "/project", null, "archived"]]);
      const transcriptPath = path.join(dir, "projects", "p", "s1.jsonl");
      const { state } = makeRuntimeState();
      const runtime = createAgentRuntimeMain({ updateSession: state.updateSession, getStateRuntime: () => state,
        isAgentEnabled: () => true, workBuddySessionTitleOptions: { dataDirs: [dir], pollMs: 3_600_000 } });
      const opts = () => runtimeWorkBuddyOptions({ transcriptPath });
      try {
        runtime.updateSessionFromServer("s1", "thinking", "UserPromptSubmit", opts());
        await nextTurn();
        assert.strictEqual(runtime.updateSessionFromServer("s1", "attention", "Stop", opts()), false);
        runtime.clearSessionsByAgent("workbuddy");
        assert.notStrictEqual(runtime.updateSessionFromServer("s1", "thinking", "UserPromptSubmit", opts()), false);
      } finally { runtime.cleanup(); state.cleanup(); }
    });
  });

  it("issue #655: a rebuilt card survives the observer read, even with a sibling archive copy", { skip: !DatabaseSync }, async () => {
    await fixture(async (home) => {
      const owner = path.join(home, ".workbuddy-ai");
      const sibling = path.join(home, ".workbuddy");
      createDatabase(owner, [["s1", null, null, "/project", null, "archived"]]);
      createDatabase(sibling, [["s1", null, null, "/project", null, "archived"]]);
      const { state } = makeRuntimeState();
      // The sibling comes first, so only the pinned owning home can tell that
      // this conversation was unarchived.
      const runtime = createAgentRuntimeMain({ updateSession: state.updateSession, getStateRuntime: () => state,
        isAgentEnabled: () => true, workBuddySessionTitleOptions: { dataDirs: [sibling, owner], pollMs: 3_600_000 } });
      const transcriptPath = path.join(owner, "projects", "p", "s1.jsonl");
      const tracker = runtime.getWorkBuddySessionTitleTracker();
      try {
        runtime.updateSessionFromServer("s1", "thinking", "UserPromptSubmit", runtimeWorkBuddyOptions({ transcriptPath }));
        await nextTurn();
        assert.equal(state.sessions.get("s1"), undefined, "the owning home's archive retires the card");
        updateDatabase(owner, "UPDATE sessions SET status = 'Pending' WHERE id = 's1'");
        // The late hook omits the transcript path; only the pinned home can tell
        // that this conversation is alive again.
        assert.notStrictEqual(
          runtime.updateSessionFromServer("s1", "thinking", "UserPromptSubmit", runtimeWorkBuddyOptions()),
          false
        );
        assert.ok(state.sessions.get("s1"), "the pinned owning home restores the card");
        // Let the observer actually read before trusting the rebuilt card; a
        // path-less read must stay unknown rather than fall back to the sibling.
        await tracker.poll();
        assert.ok(state.sessions.get("s1"), "the rebuilt card is still there after the observer read");
        assert.notStrictEqual(
          runtime.updateSessionFromServer("s1", "thinking", "UserPromptSubmit", runtimeWorkBuddyOptions()),
          false
        );
        assert.ok(state.sessions.get("s1"), "the following event is accepted normally");
      } finally { runtime.cleanup(); state.cleanup(); }
    });
  });

  it("issue #655: a SessionStart cannot bypass the database read rate limit", { skip: !DatabaseSync }, async () => {
    await fixture(async (dir) => {
      createDatabase(dir, [["s1", "Name", null, "/project", null, "Pending"]]);
      let opens = 0;
      const { state } = makeRuntimeState();
      const runtime = createAgentRuntimeMain({ updateSession: state.updateSession, getStateRuntime: () => state,
        isAgentEnabled: () => true,
        workBuddySessionTitleOptions: { dataDirs: [dir], pollMs: 60_000, now: () => 1_000_000,
          openDatabase: (file) => { opens++; return new DatabaseSync(file, { readOnly: true }); } } });
      try {
        for (let i = 0; i < 30; i++) {
          runtime.updateSessionFromServer("s1", "thinking", "UserPromptSubmit", runtimeWorkBuddyOptions());
          runtime.updateSessionFromServer("s1", "idle", "SessionStart", runtimeWorkBuddyOptions());
        }
        assert.ok(opens >= 1, `expected the first read to happen, got ${opens}`);
        assert.ok(opens <= 2, `expected at most 2 database reads, got ${opens}`);
      } finally { runtime.cleanup(); state.cleanup(); }
    });
  });

  it("issue #655: an unreadable transcript identity keeps the database rate limit", { skip: !DatabaseSync }, async () => {
    await fixture(async (dir) => {
      createDatabase(dir, [["s1", "Name", null, "/project", null, "Pending"]]);
      let opens = 0;
      const { state } = makeRuntimeState();
      const runtime = createAgentRuntimeMain({ updateSession: state.updateSession, getStateRuntime: () => state,
        isAgentEnabled: () => true,
        workBuddySessionTitleOptions: { dataDirs: [dir], pollMs: 60_000, now: () => 1_000_000,
          openDatabase: (file) => { opens++; return new DatabaseSync(file, { readOnly: true }); } } });
      const missing = path.join(dir, "projects", "p", "s1.jsonl"); // never created
      try {
        for (let i = 0; i < 30; i++) {
          runtime.updateSessionFromServer("s1", "thinking", "UserPromptSubmit",
            runtimeWorkBuddyOptions({ transcriptPath: missing }));
        }
        assert.ok(opens >= 1, `expected the first read to happen, got ${opens}`);
        assert.ok(opens <= 2, `expected at most 2 database reads, got ${opens}`);
      } finally { runtime.cleanup(); state.cleanup(); }
    });
  });

  it("issue #655: a late hook without a transcript is still gated by the pinned home", { skip: !DatabaseSync }, async () => {
    await fixture(async (dir) => {
      createDatabase(dir, [["s1", "Archived", null, "/project", null, "archived"]]);
      const transcriptPath = path.join(dir, "projects", "p", "s1.jsonl");
      const { state } = makeRuntimeState();
      const runtime = createAgentRuntimeMain({ updateSession: state.updateSession, getStateRuntime: () => state,
        isAgentEnabled: () => true, workBuddySessionTitleOptions: { dataDirs: [dir], pollMs: 3_600_000 } });
      try {
        runtime.updateSessionFromServer("s1", "thinking", "UserPromptSubmit", runtimeWorkBuddyOptions({ transcriptPath }));
        await nextTurn();
        assert.equal(state.sessions.get("s1"), undefined);
        // The late hook carries no transcript; only the home pinned when the
        // card retired can still prove the row is archived, so it is dropped.
        assert.strictEqual(runtime.updateSessionFromServer("s1", "attention", "Stop", runtimeWorkBuddyOptions()), false);
        assert.equal(state.sessions.get("s1"), undefined);
      } finally { runtime.cleanup(); state.cleanup(); }
    });
  });

  it("issue #655: every-turn SessionStart keeps the 256 observation cap", { skip: !DatabaseSync }, async () => {
    await fixture(async (dir) => {
      const { state } = makeRuntimeState();
      const runtime = createAgentRuntimeMain({ updateSession: state.updateSession, getStateRuntime: () => state,
        isAgentEnabled: () => true,
        workBuddySessionTitleOptions: { dataDirs: [path.join(dir, "absent")], pollMs: 3_600_000 } });
      const tracker = runtime.getWorkBuddySessionTitleTracker();
      try {
        for (let i = 0; i < 257; i++) {
          runtime.updateSessionFromServer(`s${i}`, "idle", "SessionStart",
            { agentId: "workbuddy", profileId: "local", rawSessionId: `s${i}`, cwd: "/project" });
        }
        assert.equal(tracker.size(), 256);
      } finally { runtime.cleanup(); state.cleanup(); }
    });
  });

  it("issue #655: keeps JSONL progress across every-turn SessionStart for long transcripts", async () => {
    await fixture(async (dir) => {
      const transcriptPath = path.join(dir, "s1.jsonl");
      const filler = `{"type":"message","content":"${"x".repeat(80)}"}\n`;
      const fillerBytes = Math.ceil((3 * 1024 * 1024) / filler.length);
      fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: "ai-title", sessionId: "s1", aiTitle: "Native across turns" })}\n`
        + filler.repeat(fillerBytes));
      const { state } = makeRuntimeState();
      const runtime = createAgentRuntimeMain({ updateSession: state.updateSession, getStateRuntime: () => state,
        isAgentEnabled: () => true,
        workBuddySessionTitleOptions: { dataDirs: [path.join(dir, "absent")], pollMs: 3_600_000 } });
      const tracker = runtime.getWorkBuddySessionTitleTracker();
      try {
        for (let turn = 0; turn < 6; turn++) {
          runtime.updateSessionFromServer("s1", "thinking", "UserPromptSubmit", runtimeWorkBuddyOptions({ transcriptPath }));
          runtime.updateSessionFromServer("s1", "idle", "SessionStart", runtimeWorkBuddyOptions({ transcriptPath }));
          // Drive the reads deterministically instead of waiting on the timer.
          await tracker.poll();
        }
        assert.equal(state.sessions.get("s1").sessionTitle, "Native across turns");
      } finally { runtime.cleanup(); state.cleanup(); }
    });
  });
});
