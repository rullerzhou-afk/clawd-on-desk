"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MAX_DB_TITLE_BYTES,
  qoderDesktopDataDirs,
  readQoderDesktopSession,
  createQoderDesktopTitleTracker,
} = require("../src/qoder-desktop-sessions");

let DatabaseSync;
try { ({ DatabaseSync } = require("node:sqlite")); } catch {}
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-qoder-desktop-"));
  try { await run(home); }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function createDatabase(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "main.sqlite"));
  db.exec("CREATE TABLE chat_sessions ("
    + "session_id TEXT PRIMARY KEY, title TEXT, extra_json TEXT, session_kind TEXT, "
    + "owner_session_id TEXT, archived INTEGER, deleted_at INTEGER, updated_at INTEGER)");
  const insert = db.prepare("INSERT INTO chat_sessions "
    + "(session_id, title, extra_json, session_kind, owner_session_id, archived, deleted_at, updated_at) "
    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const row of rows) {
    insert.run(
      row.session_id,
      row.title ?? null,
      row.extra_json ?? null,
      row.session_kind ?? "standard",
      row.owner_session_id ?? null,
      row.archived ?? 0,
      row.deleted_at ?? null,
      row.updated_at ?? 0,
    );
  }
  db.close();
}

function meta(overrides = {}) {
  return { title: "DB title", delegated: false, archived: false, deleted: false, home: "C:/qoder", ...overrides };
}

// Deterministic tracker harness: stable live-session objects, recording seams,
// and a hand-cranked clock so the poll window never depends on real time.
function createHarness(options = {}) {
  const live = new Map();
  const updates = [];
  const retired = [];
  const reads = [];
  let clock = options.startMs ?? 10000;
  const tracker = createQoderDesktopTitleTracker({
    getSession: (sessionId) => live.get(sessionId) || null,
    updateTitle: (sessionId, title) => updates.push({ sessionId, title }),
    onRetired: (info) => retired.push(info),
    readSession: (input, readerOptions) => {
      reads.push(input.rawSessionId);
      return options.readSession ? options.readSession(input, readerOptions) : null;
    },
    jsonl: options.jsonl || null,
    pollMs: options.pollMs ?? 2000,
    now: () => clock,
    readerOptions: options.readerOptions || {},
  });
  return {
    tracker, live, updates, retired, reads,
    addLive(sessionId) { const session = { sessionId }; live.set(sessionId, session); return session; },
    advance(ms) { clock += ms; },
  };
}

describe("qoderDesktopDataDirs", () => {
  it("resolves both Qoder Desktop app dirs per platform", () => {
    const win = qoderDesktopDataDirs({
      platform: "win32", homeDir: "C:/Users/pet", env: { APPDATA: "C:/Users/pet/AppData/Roaming" },
    });
    assert.deepEqual(win, [
      path.join("C:/Users/pet/AppData/Roaming", "com.qoder.app.stable"),
      path.join("C:/Users/pet/AppData/Roaming", "com.qodercn.app.stable"),
    ]);
    const mac = qoderDesktopDataDirs({ platform: "darwin", homeDir: "/Users/pet", env: {} });
    assert.deepEqual(mac, [
      path.join("/Users/pet/Library/Application Support", "com.qoder.app.stable"),
      path.join("/Users/pet/Library/Application Support", "com.qodercn.app.stable"),
    ]);
    const linux = qoderDesktopDataDirs({ platform: "linux", homeDir: "/home/pet", env: {} });
    assert.deepEqual(linux, [
      path.join("/home/pet/.config", "com.qoder.app.stable"),
      path.join("/home/pet/.config", "com.qodercn.app.stable"),
    ]);
  });
});

describe("readQoderDesktopSession", () => {
  it("reads and normalizes the stored title and reports the owning home", { skip: !DatabaseSync }, async () => {
    await fixture(async (home) => {
      const dir = path.join(home, "com.qoder.app.stable");
      createDatabase(dir, [
        { session_id: "s-plain", title: "  Fix\n\u202E auth  " },
        { session_id: "s-tabs", title: "A\t\tB\nC" },
        { session_id: "s-blank", title: " \t " },
        { session_id: "s-null", title: null },
      ]);
      const options = { dataDirs: [dir] };
      const plain = readQoderDesktopSession({ rawSessionId: "s-plain" }, options);
      assert.equal(plain.title, "Fix auth");
      assert.equal(plain.delegated, false);
      assert.equal(plain.archived, false);
      assert.equal(plain.deleted, false);
      assert.equal(plain.home, dir);
      assert.equal(readQoderDesktopSession({ rawSessionId: "s-tabs" }, options).title, "A B C");
      const blank = readQoderDesktopSession({ rawSessionId: "s-blank" }, options);
      assert.equal(blank.title, null);
      assert.equal(blank.delegated, false);
      assert.equal(readQoderDesktopSession({ rawSessionId: "s-null" }, options).title, null);
      // The raw id is trimmed before the lookup.
      assert.equal(readQoderDesktopSession({ rawSessionId: "  s-plain  " }, options).title, "Fix auth");
    });
  });

  it("projects titles over the SQL byte limit to null while keeping the boundary", { skip: !DatabaseSync }, async () => {
    await fixture(async (home) => {
      const dir = path.join(home, "com.qoder.app.stable");
      // "修" is 3 UTF-8 bytes: exercise bytes, not JavaScript characters.
      const multibyte = "修".repeat(Math.floor(MAX_DB_TITLE_BYTES / 3));
      const atLimit = multibyte + "x".repeat(MAX_DB_TITLE_BYTES - Buffer.byteLength(multibyte));
      assert.equal(Buffer.byteLength(atLimit), MAX_DB_TITLE_BYTES);
      createDatabase(dir, [
        { session_id: "ascii-over", title: "x".repeat(MAX_DB_TITLE_BYTES + 1) },
        { session_id: "ascii-at", title: "x".repeat(MAX_DB_TITLE_BYTES) },
        { session_id: "mb-over", title: atLimit + "x" },
        { session_id: "mb-at", title: atLimit },
      ]);
      const options = { dataDirs: [dir] };
      const over = readQoderDesktopSession({ rawSessionId: "ascii-over" }, options);
      assert.equal(over.title, null);
      assert.equal(over.delegated, false);
      assert.equal(readQoderDesktopSession({ rawSessionId: "mb-over" }, options).title, null);
      // At the limit the row survives; normalizeSessionTitle still caps at 80 chars.
      for (const id of ["ascii-at", "mb-at"]) {
        const kept = readQoderDesktopSession({ rawSessionId: id }, options);
        assert.ok(kept.title, `${id} keeps a title`);
        assert.equal(Array.from(kept.title).length, 80);
        assert.ok(kept.title.endsWith("\u2026"));
      }
    });
  });

  it("flags extra_json delegationParent sessions as delegated", { skip: !DatabaseSync }, async () => {
    await fixture(async (home) => {
      const dir = path.join(home, "com.qoder.app.stable");
      createDatabase(dir, [
        { session_id: "s-child", title: "Child task", extra_json: JSON.stringify({ delegationParent: { sessionId: "s-parent" } }) },
        { session_id: "s-empty-parent", title: "No parent id", extra_json: JSON.stringify({ delegationParent: {} }) },
      ]);
      const options = { dataDirs: [dir] };
      const child = readQoderDesktopSession({ rawSessionId: "s-child" }, options);
      assert.equal(child.delegated, true);
      assert.equal(child.title, "Child task");
      assert.equal(readQoderDesktopSession({ rawSessionId: "s-empty-parent" }, options).delegated, false);
    });
  });

  it("only the explicit delegationParent marker suppresses; side chats stay visible", { skip: !DatabaseSync }, async () => {
    await fixture(async (home) => {
      const dir = path.join(home, "com.qoder.app.stable");
      createDatabase(dir, [
        { session_id: "s-owner", title: "Owned", owner_session_id: "s-parent" },
        { session_id: "s-side", title: "Side chat", session_kind: "sideChat" },
        { session_id: "s-auto", title: "Automation", session_kind: "automationExecution" },
        { session_id: "s-delegated", title: "Delegated", extra_json: JSON.stringify({ delegationParent: { sessionId: "s-parent" } }) },
        { session_id: "s-standard", title: "Standard", session_kind: "standard", extra_json: "{}" },
      ]);
      const options = { dataDirs: [dir] };
      assert.equal(readQoderDesktopSession({ rawSessionId: "s-owner" }, options).delegated, false);
      assert.equal(readQoderDesktopSession({ rawSessionId: "s-side" }, options).delegated, false);
      assert.equal(readQoderDesktopSession({ rawSessionId: "s-auto" }, options).delegated, false);
      assert.equal(readQoderDesktopSession({ rawSessionId: "s-delegated" }, options).delegated, true);
      assert.equal(readQoderDesktopSession({ rawSessionId: "s-standard" }, options).delegated, false);
    });
  });

  it("reports archived rows without delegating them", { skip: !DatabaseSync }, async () => {
    await fixture(async (home) => {
      const dir = path.join(home, "com.qoder.app.stable");
      createDatabase(dir, [
        { session_id: "s-archived", title: "Archived chat", archived: 1 },
        { session_id: "s-active", title: "Active chat", archived: 0 },
      ]);
      const options = { dataDirs: [dir] };
      const archived = readQoderDesktopSession({ rawSessionId: "s-archived" }, options);
      assert.equal(archived.archived, true);
      assert.equal(archived.delegated, false);
      assert.equal(archived.deleted, false);
      assert.equal(archived.title, "Archived chat");
      assert.equal(readQoderDesktopSession({ rawSessionId: "s-active" }, options).archived, false);
    });
  });

  it("reports deleted rows with a null title", { skip: !DatabaseSync }, async () => {
    await fixture(async (home) => {
      const dir = path.join(home, "com.qoder.app.stable");
      createDatabase(dir, [
        { session_id: "s-deleted", title: "Gone", deleted_at: 1700000000000 },
        { session_id: "s-deleted-zero", title: "Also gone", deleted_at: 0 },
      ]);
      const options = { dataDirs: [dir] };
      const deleted = readQoderDesktopSession({ rawSessionId: "s-deleted" }, options);
      assert.equal(deleted.deleted, true);
      assert.equal(deleted.title, null);
      const zero = readQoderDesktopSession({ rawSessionId: "s-deleted-zero" }, options);
      assert.equal(zero.deleted, true);
      assert.equal(zero.title, null);
    });
  });

  it("tolerates malformed or absent extra_json without delegating", { skip: !DatabaseSync }, async () => {
    await fixture(async (home) => {
      const dir = path.join(home, "com.qoder.app.stable");
      createDatabase(dir, [
        { session_id: "s-broken", title: "Broken extra", extra_json: "{not-json" },
        { session_id: "s-no-extra", title: "No extra", extra_json: null },
      ]);
      const options = { dataDirs: [dir] };
      const broken = readQoderDesktopSession({ rawSessionId: "s-broken" }, options);
      assert.equal(broken.delegated, false);
      assert.equal(broken.title, "Broken extra");
      assert.equal(readQoderDesktopSession({ rawSessionId: "s-no-extra" }, options).delegated, false);
    });
  });

  it("returns null for missing rows, missing or schemaless databases, and empty ids", { skip: !DatabaseSync }, async () => {
    await fixture(async (home) => {
      const dir = path.join(home, "com.qoder.app.stable");
      createDatabase(dir, [{ session_id: "s-known", title: "Known" }]);
      const options = { dataDirs: [dir] };
      assert.equal(readQoderDesktopSession({ rawSessionId: "s-unknown" }, options), null);
      assert.equal(readQoderDesktopSession({ rawSessionId: "" }, options), null);
      assert.equal(readQoderDesktopSession({ rawSessionId: "   " }, options), null);
      assert.equal(readQoderDesktopSession({ rawSessionId: 42 }, options), null);
      assert.equal(readQoderDesktopSession({}, options), null);
      assert.equal(readQoderDesktopSession({ rawSessionId: "s-known" }, { dataDirs: [] }), null);
      // An absent Qoder home is never created by a read.
      const absent = path.join(home, "absent");
      assert.equal(readQoderDesktopSession({ rawSessionId: "s-known" }, { dataDirs: [absent] }), null);
      assert.equal(fs.existsSync(path.join(absent, "main.sqlite")), false);
      // A database without the chat_sessions table stays "unknown", not false.
      const schemaless = path.join(home, "schemaless");
      fs.mkdirSync(schemaless, { recursive: true });
      const db = new DatabaseSync(path.join(schemaless, "main.sqlite"));
      db.close();
      assert.equal(readQoderDesktopSession({ rawSessionId: "s-known" }, { dataDirs: [schemaless] }), null);
    });
  });

  it("falls through to the next data dir and honors the openDatabase seam", { skip: !DatabaseSync }, async () => {
    await fixture(async (home) => {
      const empty = path.join(home, "com.qoder.app.stable");
      const dir = path.join(home, "com.qodercn.app.stable");
      fs.mkdirSync(empty, { recursive: true });
      createDatabase(dir, [{ session_id: "s-cn", title: "CN title" }]);
      const opened = [];
      const result = readQoderDesktopSession({ rawSessionId: "s-cn" }, {
        dataDirs: [empty, dir],
        openDatabase: (filePath) => {
          opened.push(filePath);
          return new DatabaseSync(filePath, { readOnly: true });
        },
      });
      assert.equal(result.title, "CN title");
      assert.equal(result.home, dir);
      assert.deepEqual(opened, [path.join(dir, "main.sqlite")]);
    });
  });
});

describe("createQoderDesktopTitleTracker", () => {
  it("applies the database title on the first track without touching jsonl", async () => {
    const jsonlCalls = [];
    const harness = createHarness({
      readSession: () => meta({ title: "Desktop title" }),
      jsonl: { resolve: async (request) => { jsonlCalls.push(request); return "JSONL title"; } },
    });
    harness.addLive("s1");
    harness.tracker.track({
      sessionId: "s1", rawSessionId: "raw-1", cwd: "C:/repo", transcriptPath: "C:/repo/session.jsonl",
    });
    await nextTurn();
    assert.deepEqual(harness.updates, [{ sessionId: "s1", title: "Desktop title" }]);
    assert.deepEqual(harness.reads, ["raw-1"]);
    assert.equal(harness.retired.length, 0);
    assert.equal(jsonlCalls.length, 0);
    assert.equal(harness.tracker.size(), 1);
    harness.tracker.clear();
  });

  it("retires delegated, archived, and deleted sessions without title updates", async () => {
    const metas = {
      "raw-delegated": meta({ delegated: true }),
      "raw-archived": meta({ archived: true }),
      "raw-deleted": meta({ deleted: true, title: null }),
    };
    const harness = createHarness({ readSession: ({ rawSessionId }) => metas[rawSessionId] || null });
    ["raw-delegated", "raw-archived", "raw-deleted"].forEach((rawSessionId, index) => {
      const sessionId = `s${index}`;
      harness.addLive(sessionId);
      harness.tracker.track({ sessionId, rawSessionId });
    });
    await nextTurn();
    assert.equal(harness.updates.length, 0);
    assert.deepEqual(harness.retired.map((entry) => entry.sessionId), ["s0", "s1", "s2"]);
    assert.equal(harness.retired[0].rawSessionId, "raw-delegated");
    assert.equal(harness.retired[0].meta.delegated, true);
    assert.equal(harness.retired[1].meta.archived, true);
    assert.equal(harness.retired[2].meta.deleted, true);
    assert.equal(harness.tracker.size(), 0);
    harness.tracker.clear();
  });

  it("falls back to jsonl Stop resolution when the database has no title", async () => {
    const jsonlCalls = [];
    const harness = createHarness({
      readSession: ({ rawSessionId }) => (rawSessionId === "raw-null-title" ? meta({ title: null }) : null),
      jsonl: { resolve: async (request) => { jsonlCalls.push(request); return "JSONL title"; } },
    });
    harness.addLive("s1");
    harness.addLive("s2");
    harness.addLive("s3");
    harness.tracker.track({ sessionId: "s1", rawSessionId: "raw-unknown", transcriptPath: "C:/t/one.jsonl" });
    harness.tracker.track({ sessionId: "s2", rawSessionId: "raw-null-title", transcriptPath: "C:/t/two.jsonl" });
    harness.tracker.track({ sessionId: "s3", rawSessionId: "raw-unknown" });
    await nextTurn();
    assert.deepEqual(harness.updates, [
      { sessionId: "s1", title: "JSONL title" },
      { sessionId: "s2", title: "JSONL title" },
    ]);
    assert.deepEqual(jsonlCalls, [
      { event: "Stop", sessionId: "raw-unknown", transcriptPath: "C:/t/one.jsonl" },
      { event: "Stop", sessionId: "raw-null-title", transcriptPath: "C:/t/two.jsonl" },
    ]);
    // Unknown metadata never retires a live card, even without a fallback title.
    assert.equal(harness.retired.length, 0);
    assert.equal(harness.tracker.size(), 3);
    harness.tracker.clear();
  });

  it("readMeta exposes suppression flags only for confirmed rows, never unknown or invalid ids", async () => {
    const metas = {
      "raw-normal": meta(),
      "raw-delegated": meta({ delegated: true }),
      "raw-archived": meta({ archived: true }),
      "raw-deleted": meta({ deleted: true, title: null }),
    };
    const harness = createHarness({ readSession: ({ rawSessionId }) => metas[rawSessionId] ?? null });
    const flags = (raw) => {
      const m = harness.tracker.readMeta(raw);
      return !!(m && (m.delegated || m.archived || m.deleted));
    };
    assert.equal(flags("raw-normal"), false);
    assert.equal(flags("raw-delegated"), true);
    assert.equal(flags("raw-archived"), true);
    assert.equal(flags("raw-deleted"), true);
    assert.equal(flags("raw-missing"), false);
    const readsBefore = harness.reads.length;
    assert.equal(harness.tracker.readMeta(""), null);
    assert.equal(harness.tracker.readMeta(null), null);
    assert.equal(harness.tracker.readMeta(42), null);
    assert.equal(harness.reads.length, readsBefore);
    harness.tracker.clear();
  });

  it("track and sweep normalize the qoder: prefix before querying (S1)", async () => {
    const harness = createHarness({ readSession: () => meta({ title: "T" }) });
    harness.addLive("s1");
    harness.tracker.track({ sessionId: "s1", rawSessionId: "qoder:raw-1" });
    await nextTurn();
    assert.deepEqual(harness.reads, ["raw-1"]);
    assert.deepEqual(harness.updates, [{ sessionId: "s1", title: "T" }]);
    harness.addLive("s2");
    harness.tracker.sweep([{ sessionId: "s2", rawSessionId: "qoder:raw-2" }]);
    await nextTurn();
    assert.ok(harness.reads.includes("raw-2"));
    harness.tracker.clear();
  });

  it("clear(sessionId) invalidates the meta cache for that raw id (L3)", async () => {
    const harness = createHarness({ readSession: () => meta() });
    harness.addLive("s1");
    harness.tracker.track({ sessionId: "s1", rawSessionId: "raw-1" });
    await nextTurn();
    const readsBefore = harness.reads.length;
    harness.tracker.readMeta("raw-1");
    assert.equal(harness.reads.length, readsBefore);
    harness.tracker.clear("s1");
    harness.tracker.readMeta("raw-1");
    assert.equal(harness.reads.length, readsBefore + 1);
    harness.tracker.clear();
  });

  it("degraded schema without lifecycle columns still yields the title (M4)", { skip: !DatabaseSync }, async () => {
    await fixture(async (home) => {
      const dir = path.join(home, "com.qoder.app.stable");
      fs.mkdirSync(dir, { recursive: true });
      const db = new DatabaseSync(path.join(dir, "main.sqlite"));
      db.exec("CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, title TEXT, extra_json TEXT)");
      db.prepare("INSERT INTO chat_sessions VALUES (?, ?, ?)").run("s-min", "Minimal title", "{}");
      db.close();
      const row = readQoderDesktopSession({ rawSessionId: "s-min" }, { dataDirs: [dir] });
      assert.equal(row.title, "Minimal title");
      assert.equal(row.archived, false);
      assert.equal(row.delegated, false);
    });
  });

  it("active row in a second edition wins over an archived copy in the first (L2)", { skip: !DatabaseSync }, async () => {
    await fixture(async (home) => {
      const dirA = path.join(home, "com.qoder.app.stable");
      const dirB = path.join(home, "com.qodercn.app.stable");
      createDatabase(dirA, [{ session_id: "s-dup", title: "Archived copy", archived: 1, updated_at: 200 }]);
      createDatabase(dirB, [{ session_id: "s-dup", title: "Active copy", archived: 0, updated_at: 100 }]);
      const row = readQoderDesktopSession({ rawSessionId: "s-dup" }, { dataDirs: [dirA, dirB] });
      assert.equal(row.title, "Active copy");
      assert.equal(row.archived, false);
    });
  });

  it("omits used/limit when token counts are unavailable (L6)", { skip: !DatabaseSync }, async () => {
    await fixture(async (home) => {
      const dir = path.join(home, "com.qoder.app.stable");
      createDatabase(dir, [{ session_id: "s-usage", title: "U" }]);
      const db = new DatabaseSync(path.join(dir, "main.sqlite"));
      db.exec("CREATE TABLE chat_session_context_usage (session_id TEXT PRIMARY KEY, snapshot_json TEXT, updated_at INTEGER)");
      db.prepare("INSERT INTO chat_session_context_usage VALUES (?, ?, ?)")
        .run("s-usage", JSON.stringify({ percentage: 0.37, tokenCountsAvailable: false, totalTokens: 0, maxTokens: 0 }), 1);
      db.close();
      const row = readQoderDesktopSession({ rawSessionId: "s-usage" }, { dataDirs: [dir] });
      assert.equal(row.contextUsage.percent, 37);
      assert.equal(Object.hasOwn(row.contextUsage, "used"), false);
      assert.equal(Object.hasOwn(row.contextUsage, "limit"), false);
    });
  });

  it("readMeta caches inside the poll window and re-reads once it expires", async () => {
    const harness = createHarness({ readSession: () => meta(), pollMs: 2000, startMs: 10000 });
    const first = harness.tracker.readMeta("raw-1");
    assert.equal(harness.reads.length, 1);
    assert.strictEqual(harness.tracker.readMeta("raw-1"), first);
    harness.advance(1999);
    assert.strictEqual(harness.tracker.readMeta("raw-1"), first);
    assert.equal(harness.reads.length, 1);
    harness.advance(1);
    harness.tracker.readMeta("raw-1");
    assert.equal(harness.reads.length, 2);
    harness.tracker.clear();
  });

  it("track reads immediately once, defers repeats to the poll, and resets on a new raw id", async () => {
    const harness = createHarness({
      readSession: () => meta({ title: "Desktop title" }), pollMs: 2000, startMs: 10000,
    });
    harness.addLive("s1");
    harness.tracker.track({ sessionId: "s1", rawSessionId: "raw-1" });
    assert.equal(harness.reads.length, 1);
    await nextTurn();
    harness.tracker.track({ sessionId: "s1", rawSessionId: "raw-1" });
    await nextTurn();
    assert.equal(harness.reads.length, 1);
    harness.advance(2000);
    await harness.tracker.poll();
    assert.equal(harness.reads.length, 2);
    harness.tracker.track({ sessionId: "s1", rawSessionId: "raw-2" });
    assert.equal(harness.reads.length, 3);
    await nextTurn();
    assert.deepEqual(harness.updates.map((entry) => entry.title), ["Desktop title", "Desktop title", "Desktop title"]);
    assert.equal(harness.tracker.size(), 1);
    harness.tracker.clear();
  });

  it("sweep reconciles restored rows against a real database", { skip: !DatabaseSync }, async () => {
    await fixture(async (home) => {
      const dir = path.join(home, "com.qoder.app.stable");
      createDatabase(dir, [
        { session_id: "raw-normal", title: "Restored title" },
        {
          session_id: "raw-delegated",
          title: "Child",
          extra_json: JSON.stringify({ delegationParent: { sessionId: "raw-normal" } }),
        },
      ]);
      const harness = createHarness({
        readSession: readQoderDesktopSession,
        readerOptions: { dataDirs: [dir] },
      });
      harness.addLive("s-normal");
      harness.addLive("s-delegated");
      harness.tracker.sweep([
        null,
        { sessionId: "s-missing-raw" },
        { sessionId: "s-normal", rawSessionId: "raw-normal", cwd: "C:/repo", transcriptPath: "C:/repo/a.jsonl" },
        { sessionId: "s-delegated", rawSessionId: "raw-delegated" },
      ]);
      await nextTurn();
      assert.deepEqual(harness.updates, [{ sessionId: "s-normal", title: "Restored title" }]);
      assert.equal(harness.retired.length, 1);
      assert.equal(harness.retired[0].sessionId, "s-delegated");
      assert.equal(harness.retired[0].rawSessionId, "raw-delegated");
      assert.equal(harness.retired[0].meta.delegated, true);
      assert.equal(harness.tracker.size(), 1);
      harness.tracker.clear();
      assert.equal(harness.tracker.size(), 0);
    });
  });

  it("clear drops entries and the cached metadata", async () => {
    const harness = createHarness({ readSession: () => meta(), pollMs: 2000, startMs: 10000 });
    harness.addLive("s1");
    harness.addLive("s2");
    harness.tracker.track({ sessionId: "s1", rawSessionId: "raw-1" });
    harness.tracker.track({ sessionId: "s2", rawSessionId: "raw-2" });
    await nextTurn();
    assert.equal(harness.tracker.size(), 2);
    harness.tracker.clear("s1");
    assert.equal(harness.tracker.size(), 1);
    harness.tracker.clear();
    assert.equal(harness.tracker.size(), 0);
    // A full clear also wipes the meta cache: the next read happens even
    // inside the original poll window.
    const readsBefore = harness.reads.length;
    harness.tracker.readMeta("raw-1");
    assert.equal(harness.reads.length, readsBefore + 1);
  });
});