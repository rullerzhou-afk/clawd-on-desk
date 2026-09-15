const { afterEach, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  SESSION_TITLE_MAX,
  PROMPT_TITLE_MAX,
  MAX_DB_VALUE_LENGTH,
  normalizeTitle,
  extractPromptTitle,
  composerHeadersDbPath,
  readComposerSessionTitle,
  resolveSessionTitle,
} = require("../hooks/cursor-session-title");
const { createSpawnedHookHarness } = require("./helpers/spawned-hook");

let DatabaseSync;
try { ({ DatabaseSync } = require("node:sqlite")); } catch { /* explicitly skipped below */ }
const sqliteUnavailable = !DatabaseSync && "node:sqlite unavailable; requires Node 22.13+ or --experimental-sqlite on 22.12";
const tempDirs = [];

function makeHome() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cursor-title-"));
  tempDirs.push(directory);
  return directory;
}

function makeDb(setup, dbPath = path.join(makeHome(), "state.vscdb")) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try { setup(db); } finally { db.close(); }
  return dbPath;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Cursor title normalization and prompt fallback", () => {
  it("normalizes control characters and limits metadata and prompt titles", () => {
    assert.equal(normalizeTitle("  修复\u0000路径\u0085问题\n  "), "修复 路径 问题");
    assert.equal(normalizeTitle(null), null);
    assert.equal(normalizeTitle("  \n"), null);
    assert.equal(normalizeTitle("标题".repeat(80)).length, SESSION_TITLE_MAX);
    const title = extractPromptTitle("\n  修复路径 " + "很长的描述 ".repeat(20) + "\n详细内容");
    assert.equal(title.length, PROMPT_TITLE_MAX);
    assert.ok(title.endsWith("…"));
  });

  it("filters common bare credentials and secrets past the truncation boundary", () => {
    for (const secret of [
      "sk-" + "a".repeat(24), "ghp_" + "X".repeat(36), "github_pat_" + "x".repeat(60),
      "AKIAABCDEFGHIJKLMNOP", "Bearer abc.def.ghi", "private_key=example", "password=example",
      "Q7dP4xN9vL2wC8mR5bF1hJ6sT3yK0zAe", "api-key: example",
      "a harmless beginning ".repeat(4) + "token=example",
    ]) {
      assert.equal(extractPromptTitle("\n" + secret + "\notherwise safe"), null, secret);
    }
  });

  it("keeps ordinary prose and does not copy later prompt lines", () => {
    for (const text of ["fix tokenizer highlighting", "修一下 Cursor 的标题", "secretary view layout", "Update API docs"]) {
      assert.equal(extractPromptTitle(text + "\nprivate second line"), text);
    }
    assert.equal(extractPromptTitle({ text: "not a prompt" }), null);
    assert.equal(extractPromptTitle("\n \n"), null);
  });

  it("uses native platform paths rather than Windows paths on every platform", () => {
    const suffix = "Cursor/User/globalStorage/state.vscdb";
    assert.equal(composerHeadersDbPath({ platform: "win32", env: { APPDATA: "C:\\Custom AppData" }, homeDir: "C:\\Users\\sample" }),
      path.win32.join("C:\\Custom AppData", suffix));
    assert.equal(composerHeadersDbPath({ platform: "win32", env: { APPDATA: " " }, homeDir: "C:\\Users\\sample" }),
      path.win32.join("C:\\Users\\sample", "AppData/Roaming", suffix));
    assert.equal(composerHeadersDbPath({ platform: "darwin", env: { APPDATA: "ignored" }, homeDir: "/Users/sample" }),
      "/Users/sample/Library/Application Support/" + suffix);
    assert.equal(composerHeadersDbPath({ platform: "linux", env: { XDG_CONFIG_HOME: "/custom/config" }, homeDir: "/home/sample" }),
      "/custom/config/" + suffix);
    for (const xdg of [undefined, "", "  ", "relative/config"]) {
      assert.equal(composerHeadersDbPath({ platform: "linux", env: { XDG_CONFIG_HOME: xdg }, homeDir: "/home/sample" }),
        "/home/sample/.config/" + suffix);
    }
    assert.equal(composerHeadersDbPath({ platform: "unsupported", env: {} }), null);
  });

  it("does not create missing databases and still supplies a prompt fallback", () => {
    const dbPath = path.join(makeHome(), "not-installed", "state.vscdb");
    const options = { dbPath };
    assert.equal(readComposerSessionTitle("conversation", options), null);
    assert.equal(fs.existsSync(path.dirname(dbPath)), false);
    assert.equal(resolveSessionTitle({ conversation_id: "conversation", prompt: "fix hooks" }, "beforeSubmitPrompt", options), "fix hooks");
    assert.equal(resolveSessionTitle({ prompt: "must not leak" }, "preToolUse", options), null);
    assert.equal(resolveSessionTitle(null, "beforeSubmitPrompt", options), null);
  });

  it("falls back when SQLite is unavailable and skips local DB lookup for remote hooks", () => {
    const dbPath = path.join(makeHome(), "state.vscdb");
    fs.writeFileSync(dbPath, "fixture");
    let attempts = 0;
    const options = { dbPath, openDatabase() { attempts++; throw new Error("node:sqlite unavailable"); } };
    const payload = { conversation_id: "conversation", prompt: "fix hooks" };
    // Exercise the real optional import with an existing file as well: Node
    // 22.12 has no SQLite by default, newer Node rejects the corrupt fixture.
    assert.equal(resolveSessionTitle(payload, "beforeSubmitPrompt", { dbPath }), "fix hooks");
    assert.equal(resolveSessionTitle(payload, "beforeSubmitPrompt", options), "fix hooks");
    assert.equal(attempts, 1);
    assert.equal(resolveSessionTitle(payload, "beforeSubmitPrompt", { ...options, readDatabase: false }), "fix hooks");
    assert.equal(attempts, 1);
    for (const id of [null, undefined, "", "default", 123]) assert.equal(readComposerSessionTitle(id, options), null);
    assert.equal(attempts, 1);
  });

  it("keeps stderr free of the optional SQLite notice without disabling other warnings", () => {
    const dbPath = path.join(makeHome(), "state.vscdb");
    fs.writeFileSync(dbPath, "fixture");
    const result = spawnSync(process.execPath, [
      ...process.execArgv.filter((arg) => arg === "--experimental-sqlite"),
      "-e", `
        const before = process.emitWarning;
        require(process.argv[1]).readComposerSessionTitle("one", { dbPath: process.argv[2] });
        if (process.emitWarning !== before) process.exit(2);
        process.emitWarning("unrelated experimental feature", "ExperimentalWarning");
      `,
      path.resolve(__dirname, "..", "hooks", "cursor-session-title.js"), dbPath,
    ], { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "", NODE_OPTIONS: "" } });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /SQLite is an experimental feature/);
    assert.match(result.stderr, /ExperimentalWarning: unrelated experimental feature/);
  });
});

describe("Cursor SQLite title layouts", { skip: sqliteUnavailable }, () => {
  it("reads current composerHeaders names, isolates conversations, and observes renames", () => {
    const dbPath = makeDb((db) => {
      db.exec("CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, value TEXT)");
      db.prepare("INSERT INTO composerHeaders VALUES (?, ?, ?)").run("one", "workspace", JSON.stringify({ composerId: "one", name: "First title" }));
      db.prepare("INSERT INTO composerHeaders VALUES (?, ?, ?)").run("two", "workspace", JSON.stringify({ composerId: "two", name: "Other chat" }));
    });
    const before = fs.readFileSync(dbPath);
    assert.equal(readComposerSessionTitle("one", { dbPath }), "First title");
    assert.equal(readComposerSessionTitle("two", { dbPath }), "Other chat");
    assert.equal(readComposerSessionTitle("missing", { dbPath }), null);
    assert.equal(readComposerSessionTitle("one' OR 1=1 --", { dbPath }), null);
    assert.deepEqual(fs.readFileSync(dbPath), before, "reading metadata must not modify Cursor's database");
    const writer = new DatabaseSync(dbPath);
    writer.prepare("UPDATE composerHeaders SET value = ? WHERE composerId = ?").run(JSON.stringify({ name: "Renamed chat" }), "one");
    writer.close();
    assert.equal(resolveSessionTitle({ session_id: "one", prompt: "prompt must not win" }, "beforeSubmitPrompt", { dbPath }), "Renamed chat");
    assert.equal(resolveSessionTitle({ conversation_id: "one" }, "stop", { dbPath }), "Renamed chat");
  });

  it("reads legacy ItemTable headers and BLOB values from real Cursor storage shapes", () => {
    const dbPath = makeDb((db) => {
      db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
      db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run("composer.composerHeaders", Buffer.from(JSON.stringify({ allComposers: [
        { composerId: "other", name: "Wrong chat" }, { composerId: "one", name: "Legacy header title" },
      ] })));
    });
    assert.equal(readComposerSessionTitle("one", { dbPath }), "Legacy header title");
    assert.equal(readComposerSessionTitle("missing", { dbPath }), null);
  });

  it("reads legacy cursorDiskKV composerData names without taking another session's title", () => {
    const dbPath = makeDb((db) => {
      db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB); CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value BLOB)");
      db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run("composerData:one", Buffer.from(JSON.stringify({ composerId: "one", name: "Older chat title", conversation: [] })));
    });
    assert.equal(readComposerSessionTitle("one", { dbPath }), "Older chat title");
    assert.equal(readComposerSessionTitle("missing", { dbPath }), null);
  });

  it("prefers migrated names and falls through malformed or nameless metadata", () => {
    const dbPath = makeDb((db) => {
      db.exec("CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, value TEXT); CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB); CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value BLOB)");
      db.prepare("INSERT INTO composerHeaders VALUES (?, ?)").run("one", JSON.stringify({ name: "Current title" }));
      db.prepare("INSERT INTO composerHeaders VALUES (?, ?)").run("two", "not JSON");
      db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run("composer.composerHeaders", JSON.stringify({ allComposers: [
        { composerId: "one", name: "Stale title" }, { composerId: "two", name: 42 },
      ] }));
      db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run("composerData:two", JSON.stringify({ name: "Fallback title" }));
    });
    assert.equal(readComposerSessionTitle("one", { dbPath }), "Current title");
    assert.equal(readComposerSessionTitle("two", { dbPath }), "Fallback title");
  });

  it("declines oversized records and corrupt/locked databases without blocking hooks", () => {
    const dbPath = makeDb((db) => {
      db.exec("CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, value TEXT)");
      db.prepare("INSERT INTO composerHeaders VALUES (?, ?)").run("one", JSON.stringify({ name: "Too large", extra: "x".repeat(MAX_DB_VALUE_LENGTH) }));
      db.prepare("INSERT INTO composerHeaders VALUES (?, ?)").run("unicode", JSON.stringify({ name: "Too many bytes", extra: "字".repeat(Math.ceil(MAX_DB_VALUE_LENGTH / 3)) }));
    });
    assert.equal(readComposerSessionTitle("one", { dbPath }), null);
    assert.equal(readComposerSessionTitle("unicode", { dbPath }), null);
    const writer = new DatabaseSync(dbPath);
    try {
      writer.exec("BEGIN EXCLUSIVE");
      const start = Date.now();
      assert.equal(readComposerSessionTitle("one", { dbPath }), null);
      assert.ok(Date.now() - start < 1000, "a locked database must not wait for Cursor's writer");
    } finally { writer.exec("ROLLBACK"); writer.close(); }
    const corrupt = path.join(makeHome(), "state.vscdb");
    fs.writeFileSync(corrupt, "not a SQLite database");
    assert.equal(readComposerSessionTitle("one", { dbPath: corrupt }), null);
  });
});

describe("Cursor hook title delivery", () => {
  function runHook(payload, setup) {
    const home = makeHome();
    const harness = createSpawnedHookHarness({ home });
    if (setup) {
      const dbPath = composerHeadersDbPath({ homeDir: home, env: {
        APPDATA: path.join(home, "app-data"), XDG_CONFIG_HOME: path.join(home, "xdg-config"),
      } });
      makeDb(setup, dbPath);
    }
    const result = harness.run({
      script: path.resolve(__dirname, "..", "hooks", "cursor-hook.js"), payload,
      httpContract: "expect-attempt", env: {
        CLAWD_POST_RECORDER_SUCCEED: "1",
        ...(process.execArgv.includes("--experimental-sqlite") ? { NODE_OPTIONS: "--experimental-sqlite" } : {}),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "", "Cursor reports stderr output as a hook execution error");
    const post = result.attempts.find((attempt) => attempt.kind === "request" && attempt.path === "/state");
    assert.ok(post);
    return { body: JSON.parse(post.body), stdout: result.stdout };
  }

  it("delivers only the safe title and keeps Cursor's prompt stdout contract", () => {
    const result = runHook({ hook_event_name: "beforeSubmitPrompt", conversation_id: "one", prompt: "修复 Cursor 标题\nprivate second line", cwd: "/project" });
    assert.equal(result.stdout, '{"continue":true}\n');
    assert.equal(result.body.agent_id, "cursor-agent");
    assert.equal(result.body.session_id, "one");
    assert.equal(result.body.session_title, "修复 Cursor 标题");
    assert.ok(!JSON.stringify(result.body).includes("private second line"));
    assert.ok(!("prompt" in result.body));
  });

  it("omits secret prompt titles from the outbound state payload", () => {
    const result = runHook({ hook_event_name: "beforeSubmitPrompt", conversation_id: "one", prompt: "ghp_" + "X".repeat(36) });
    assert.equal(result.stdout, '{"continue":true}\n');
    assert.ok(!("session_title" in result.body));
    assert.ok(!JSON.stringify(result.body).includes("ghp_"));
  });

  it("delivers a stored Composer name on stop without copying the rest of its record", { skip: sqliteUnavailable }, () => {
    const result = runHook({ hook_event_name: "stop", conversation_id: "one", status: "completed" }, (db) => {
      db.exec("CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, value TEXT)");
      db.prepare("INSERT INTO composerHeaders VALUES (?, ?)").run("one", JSON.stringify({ name: "Named chat", privateDetail: "do not send" }));
    });
    assert.equal(result.stdout, "{}\n");
    assert.equal(result.body.session_title, "Named chat");
    assert.equal(result.body.state, "attention");
    assert.ok(!JSON.stringify(result.body).includes("do not send"));
  });
});
