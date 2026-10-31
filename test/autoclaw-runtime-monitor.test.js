"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  AutoClawRuntimeMonitor,
  SQL_ALLOWLIST,
  SESSIONS_SQL,
  RUNS_SQL,
  WORKSPACES_SQL,
  buildSnapshot,
  computeAutoClawSessionDiffs,
  discoverRuntimeDatabasePaths,
  resolveAutoClawUserDataRoots,
  userDataBaseDir,
} = require("../agents/autoclaw-runtime-monitor");

const tempDirs = [];

function makeTempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `clawd-autoclaw-monitor-${name}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

const SCHEMA_COLUMNS = {
  work_sessions: ["session_id", "title", "workspace_id", "updated_at", "deleted_at", "archived_at"],
  work_runs: ["run_id", "session_id", "status", "created_at", "updated_at"],
  work_workspaces: ["workspace_id", "root_path"],
};

// In-memory query backend mirroring the runtime schema's read surface.
function makeQueryBackend(state) {
  return (dbPath, sql) => {
    if (sql.startsWith("PRAGMA table_info(work_sessions)")) {
      return SCHEMA_COLUMNS.work_sessions.map((name) => ({ name }));
    }
    if (sql.startsWith("PRAGMA table_info(work_runs)")) {
      return SCHEMA_COLUMNS.work_runs.map((name) => ({ name }));
    }
    if (sql.startsWith("PRAGMA table_info(work_workspaces)")) {
      return SCHEMA_COLUMNS.work_workspaces.map((name) => ({ name }));
    }
    if (sql === SESSIONS_SQL || sql.includes("FROM work_sessions")) return state.sessions;
    if (sql === RUNS_SQL || sql.includes("FROM work_runs")) return state.runs;
    if (sql === WORKSPACES_SQL || sql.includes("FROM work_workspaces")) return state.workspaces;
    throw new Error(`unexpected SQL: ${sql}`);
  };
}

const FAKE_DISCOVERY_FS = {
  readdirSync: (dir) => {
    if (/accounts$/.test(dir)) return ["account-hash"];
    throw new Error(`ENOENT: ${dir}`);
  },
  statSync: (filePath) => {
    if (filePath.endsWith("runtime.sqlite")) return { isFile: () => true };
    throw new Error(`ENOENT: ${filePath}`);
  },
};

function makeMonitor(state, options = {}) {
  const emitted = [];
  const monitor = new AutoClawRuntimeMonitor(
    { id: "autoclaw", name: "AutoClaw" },
    (rawSessionId, state2, event, extra) => emitted.push({ rawSessionId, state: state2, event, extra }),
    {
      queryFn: makeQueryBackend(state),
      pollIntervalMs: 9999,
      fs: FAKE_DISCOVERY_FS,
      env: options.env || { AUTOCLAW_USER_DATA_ROOT: "/fake-userdata" },
      log: options.log || (() => {}),
      ...(options.monitorOptions || {}),
    }
  );
  if (options.roots !== undefined) monitor._discoveryOptions.roots = options.roots;
  else monitor._discoveryOptions.roots = ["fake-root"];
  return { monitor, emitted };
}

function session(overrides = {}) {
  return {
    session_id: "11111111-2222-4333-8444-555555555555",
    title: "会话",
    workspace_id: null,
    updated_at: "2026-10-24T06:23:31.770Z",
    deleted: 0,
    archived: 0,
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    run_id: "rrrrrrrr-2222-4333-8444-555555555555",
    session_id: "11111111-2222-4333-8444-555555555555",
    status: "queued",
    created_at: "2026-10-24T06:23:31.654Z",
    updated_at: "2026-10-24T06:23:31.700Z",
    ...overrides,
  };
}

// ── Privacy contract ────────────────────────────────────────────────────────

describe("autoclaw runtime monitor privacy contract", () => {
  it("selects explicit column lists and never references content columns", () => {
    for (const sql of SQL_ALLOWLIST) {
      assert.match(sql, /^SELECT /, sql);
      assert.doesNotMatch(sql, /\btext\b/, `content column leaked: ${sql}`);
      assert.doesNotMatch(sql, /\banswer_preview\b/, `content column leaked: ${sql}`);
      assert.doesNotMatch(sql, /\bmodel_context\b/, `content column leaked: ${sql}`);
      assert.doesNotMatch(sql, /\bpayload_json\b/, `content column leaked: ${sql}`);
      assert.doesNotMatch(sql, /\battachments_json\b/, `content column leaked: ${sql}`);
      assert.doesNotMatch(sql, /\bdraft\b/i, `content column leaked: ${sql}`);
    }
    // The session query must not come from SELECT *.
    for (const sql of SQL_ALLOWLIST) assert.ok(!/SELECT \*/.test(sql), sql);
  });

  it("executes only allowlisted SQL", () => {
    const state = { sessions: [], runs: [], workspaces: [] };
    const executed = [];
    const backend = makeQueryBackend(state);
    const queryFn = (dbPath, sql, params) => {
      executed.push(sql);
      return backend(dbPath, sql, params);
    };
    const { monitor } = makeMonitor(state, { monitorOptions: { queryFn } });
    monitor._discoveryOptions.roots = ["fake-root"];
    monitor.pollOnce();
    assert.ok(executed.length > 0, "monitor must have executed queries");
    for (const sql of executed) {
      assert.ok(SQL_ALLOWLIST.includes(sql) || /^PRAGMA table_info\(work_(sessions|runs|workspaces)\)$/.test(sql), sql);
    }
  });
});

// ── Discovery ───────────────────────────────────────────────────────────────

describe("autoclaw runtime database discovery", () => {
  it("maps platform defaults for the app userData root", () => {
    // Env comes from the caller: a stray XDG_CONFIG_HOME / APPDATA on the
    // host must not leak into explicit-homeDir lookups.
    const env = {};
    assert.strictEqual(
      userDataBaseDir("/home/u", "darwin", env),
      path.join("/home/u", "Library", "Application Support")
    );
    assert.strictEqual(userDataBaseDir("/home/u", "linux", env), path.join("/home/u", ".config"));
    assert.strictEqual(userDataBaseDir("/home/u", "win32", env), path.join("/home/u", "AppData", "Roaming"));
    assert.strictEqual(userDataBaseDir("/home/u", "linux", { XDG_CONFIG_HOME: "/xdg" }), "/xdg");
    assert.strictEqual(userDataBaseDir("/home/u", "win32", { APPDATA: "/appdata" }), "/appdata");
    assert.strictEqual(
      userDataBaseDir("/home/u", "darwin", { XDG_CONFIG_HOME: "/xdg" }),
      path.join("/home/u", "Library", "Application Support")
    );
  });

  it("honors the app's AUTOCLAW_USER_DATA_ROOT override", () => {
    assert.deepStrictEqual(
      resolveAutoClawUserDataRoots({ env: { AUTOCLAW_USER_DATA_ROOT: "/custom" } }),
      ["/custom"]
    );
  });

  it("finds accounts/*/runtime/runtime.sqlite and ignores dirs without accounts", () => {
    const root = makeTempDir("roots");
    const base = path.join(root, "Library", "Application Support");
    const official = path.join(base, "AutoClaw-official");
    const legacy = path.join(base, "autoclaw"); // 1.x userData must not match
    for (const dir of [
      path.join(official, "accounts", "hash-a", "runtime"),
      path.join(official, "accounts", "hash-b", "runtime"),
      legacy,
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(official, "accounts", "hash-a", "runtime", "runtime.sqlite"), "x");
    fs.writeFileSync(path.join(official, "accounts", "hash-b", "runtime", "runtime.sqlite"), "x");
    fs.writeFileSync(path.join(legacy, "settings.json"), "{}");

    const found = discoverRuntimeDatabasePaths({
      fs,
      baseDir: base,
      platform: "darwin",
    });
    assert.strictEqual(found.length, 2);
    assert.ok(found.every((p) => p.includes("AutoClaw-official")));
    assert.ok(found.every((p) => !p.includes(`${path.sep}autoclaw${path.sep}`)));
  });
});

// ── State machine ───────────────────────────────────────────────────────────

describe("autoclaw runtime monitor state machine", () => {
  it("skips sessions without any run until their first activity", () => {
    let tracked = new Map();
    const snap = buildSnapshot({
      sessionRows: [session()],
      runRows: [],
      workspaceRows: [],
    });
    const result = computeAutoClawSessionDiffs(tracked, snap);
    assert.deepStrictEqual(result.emits, []);
    assert.strictEqual(result.nextTracked.size, 1);
    tracked = result.nextTracked;

    const result2 = computeAutoClawSessionDiffs(tracked, buildSnapshot({
      sessionRows: [session()],
      runRows: [run({ status: "running", updated_at: "2026-10-24T06:24:00.000Z" })],
      workspaceRows: [],
    }));
    assert.deepStrictEqual(result2.emits.map((e) => `${e.event}:${e.state}`), ["PreToolUse:working"]);
  });

  it("does not resurrect terminal history on first sight", () => {
    const result = computeAutoClawSessionDiffs(new Map(), buildSnapshot({
      sessionRows: [session()],
      runRows: [run({ status: "completed" })],
      workspaceRows: [],
    }));
    assert.deepStrictEqual(result.emits, []);
    assert.strictEqual(result.nextTracked.get("11111111-2222-4333-8444-555555555555").signature, "terminal:rrrrrrrr-2222-4333-8444-555555555555");
  });

  it("surfaces first-sight live activity immediately", () => {
    const result = computeAutoClawSessionDiffs(new Map(), buildSnapshot({
      sessionRows: [session()],
      runRows: [run({ status: "running" })],
      workspaceRows: [],
    }));
    assert.strictEqual(result.emits.length, 1);
    assert.strictEqual(result.emits[0].state, "working");
    assert.strictEqual(result.emits[0].event, "PreToolUse");
    assert.strictEqual(result.emits[0].rawSessionId, "autoclaw2:11111111-2222-4333-8444-555555555555");
  });

  it("walks the full run lifecycle with transition-only emissions", () => {
    let tracked = new Map();
    const statuses = ["queued", "running", "waiting_approval", "running", "completed"];
    const expected = [
      "UserPromptSubmit:thinking",
      "PreToolUse:working",
      "Notification:attention",
      "PreToolUse:working",
      "Stop:attention",
    ];
    for (const [index, status] of statuses.entries()) {
      const result = computeAutoClawSessionDiffs(tracked, buildSnapshot({
        sessionRows: [session()],
        runRows: [run({ status, updated_at: `2026-10-24T06:2${index}:00.000Z` })],
        workspaceRows: [],
      }));
      assert.deepStrictEqual(
        result.emits.map((e) => `${e.event}:${e.state}`),
        [expected[index]],
        `status ${status}`
      );
      tracked = result.nextTracked;
    }
  });

  it("maps failed runs to error and cancelled runs to attention", () => {
    for (const [status, expected] of [
      ["failed", "StopFailure:error"],
      ["cancelled", "Stop:attention"],
      ["interrupted", "Stop:attention"],
    ]) {
      let tracked = new Map();
      tracked.set("11111111-2222-4333-8444-555555555555", { signature: "active:running", title: "", ended: false });
      const result = computeAutoClawSessionDiffs(tracked, buildSnapshot({
        sessionRows: [session()],
        runRows: [run({ status })],
        workspaceRows: [],
      }));
      assert.deepStrictEqual(result.emits.map((e) => `${e.event}:${e.state}`), [expected], status);
    }
  });

  it("ignores merged-only runs and closes a vanished active turn", () => {
    const tracked = new Map();
    tracked.set("11111111-2222-4333-8444-555555555555", { signature: "active:running", title: "会话", cwd: undefined, ended: false });
    const result = computeAutoClawSessionDiffs(tracked, buildSnapshot({
      sessionRows: [session()],
      runRows: [run({ status: "merged" })],
      workspaceRows: [],
    }));
    assert.deepStrictEqual(result.emits.map((e) => `${e.event}:${e.state}`), ["Stop:attention"]);
  });

  it("emits SessionEnd once on delete and then drops the session", () => {
    let tracked = new Map();
    tracked.set("11111111-2222-4333-8444-555555555555", { signature: "terminal:rrrrrrrr-2222-4333-8444-555555555555", title: "会话", ended: false });
    const result = computeAutoClawSessionDiffs(tracked, buildSnapshot({
      sessionRows: [session({ deleted: 1 })],
      runRows: [run({ status: "completed" })],
      workspaceRows: [],
    }));
    assert.deepStrictEqual(result.emits.map((e) => `${e.event}:${e.state}`), ["SessionEnd:sleeping"]);
    assert.strictEqual(result.nextTracked.size, 0);

    // A still-tracked terminal session with a deleted marker whose id was
    // never emitted must not fire either (defensive parity with the row).
    const result2 = computeAutoClawSessionDiffs(new Map(), buildSnapshot({
      sessionRows: [session({ deleted: 1 })],
      runRows: [],
      workspaceRows: [],
    }));
    assert.deepStrictEqual(result2.emits, []);
  });

  it("sends title-only metadata updates instead of re-firing lifecycle events", () => {
    let tracked = new Map();
    tracked.set("11111111-2222-4333-8444-555555555555", {
      signature: "terminal:rrrrrrrr-2222-4333-8444-555555555555",
      title: "旧标题",
      cwd: undefined,
      ended: false,
    });
    const result = computeAutoClawSessionDiffs(tracked, buildSnapshot({
      sessionRows: [session({ title: "新标题" })],
      runRows: [run({ status: "completed" })],
      workspaceRows: [],
    }));
    assert.strictEqual(result.emits.length, 1);
    assert.strictEqual(result.emits[0].extra.titleOnly, true);
    assert.strictEqual(result.emits[0].extra.sessionTitle, "新标题");
    assert.strictEqual(result.emits[0].state, "attention");
  });

  it("carries the workspace root path as cwd", () => {
    const result = computeAutoClawSessionDiffs(new Map(), buildSnapshot({
      sessionRows: [session({ workspace_id: "ws-1" })],
      runRows: [run({ status: "queued" })],
      workspaceRows: [{ workspace_id: "ws-1", root_path: "/Users/u/project" }],
    }));
    assert.strictEqual(result.emits.length, 1);
    assert.strictEqual(result.emits[0].extra.cwd, "/Users/u/project");
  });

  it("aggregates rows from multiple accounts and multiple sessions", () => {
    const { monitor, emitted } = makeMonitor({
      sessions: [
        session({ session_id: "aaaa", title: "A", updated_at: "T1" }),
        session({ session_id: "bbbb", title: "B", updated_at: "T2" }),
      ],
      runs: [
        run({ run_id: "r-a", session_id: "aaaa", status: "completed" }),
        run({ run_id: "r-b", session_id: "bbbb", status: "queued" }),
      ],
      workspaces: [],
    });
    monitor._discoveryOptions.roots = ["single-fake-root"];
    monitor.pollOnce();
    // aaaa is terminal on first sight → silent; bbbb is live → one event.
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].rawSessionId, "autoclaw2:bbbb");
  });
});

// ── Monitor loop ────────────────────────────────────────────────────────────

describe("autoclaw runtime monitor loop", () => {
  it("marks a schema-mismatched database unsupported without throwing", () => {
    const brokenBackend = (dbPath, sql) => {
      if (sql.startsWith("PRAGMA table_info(work_runs)")) {
        return [{ name: "run_id" }]; // missing columns
      }
      if (sql.startsWith("PRAGMA table_info(")) {
        return ["session_id", "title"].map((name) => ({ name }));
      }
      throw new Error("should not be queried");
    };
    const warnings = [];
    const { monitor } = makeMonitor({ sessions: [], runs: [], workspaces: [] }, {
      monitorOptions: { queryFn: brokenBackend },
      log: (msg) => warnings.push(msg),
    });
    monitor._discoveryOptions.roots = ["fake"];
    assert.strictEqual(monitor.pollOnce(), 0);
    assert.strictEqual(monitor.pollOnce(), 0);
    assert.ok(warnings.some((msg) => msg.includes("does not expose the expected")));
  });

  it("recovers after a transient read failure and re-verifies schema", () => {
    const state = {
      sessions: [session()],
      runs: [run({ status: "running" })],
      workspaces: [],
    };
    let failing = true;
    let failures = 0;
    const backend = makeQueryBackend(state);
    const queryFn = (dbPath, sql, params) => {
      if (failing && !sql.startsWith("PRAGMA")) {
        failures += 1;
        throw new Error("database handle is stale");
      }
      return backend(dbPath, sql, params);
    };
    const warnings = [];
    const { monitor, emitted } = makeMonitor(state, {
      monitorOptions: { queryFn },
      log: (msg) => warnings.push(msg),
    });
    monitor._discoveryOptions.roots = ["fake"];
    assert.strictEqual(monitor.pollOnce(), 0);
    assert.ok(warnings.some((msg) => msg.includes("read failed")));
    failing = false;
    assert.strictEqual(monitor.pollOnce(), 1);
    assert.strictEqual(emitted[0].state, "working");
  });

  it("never resurrects history across a monitor restart", () => {
    const state = {
      sessions: [session()],
      runs: [run({ status: "completed" })],
      workspaces: [],
    };
    const first = makeMonitor(state, {});
    first.monitor._discoveryOptions.roots = ["fake"];
    first.monitor.pollOnce();
    assert.deepStrictEqual(first.emitted, []);
    first.monitor.stop();

    const second = makeMonitor(state, {});
    second.monitor._discoveryOptions.roots = ["fake"];
    second.monitor.pollOnce();
    assert.deepStrictEqual(second.emitted, []);
  });

  it("honors AUTOCLAW_USER_DATA_ROOT when discovering real sqlite files", () => {
    const root = makeTempDir("userdata");
    const dbDir = path.join(root, "accounts", "hash", "runtime");
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, "runtime.sqlite");
    fs.writeFileSync(dbPath, "not-a-real-db-but-a-file");

    const found = discoverRuntimeDatabasePaths({
      fs,
      env: { AUTOCLAW_USER_DATA_ROOT: root },
    });
    assert.deepStrictEqual(found, [dbPath]);
  });
});
