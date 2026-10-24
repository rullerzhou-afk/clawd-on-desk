"use strict";

// AutoClaw 2.x runtime monitor (state-only polling integration).
//
// AutoClaw 2.x ("zwork harness") removed the embedded OpenClaw gateway that
// the 1.x plugin integration rides on: no OpenClaw plugin loader, no
// plugins.entries, no extension mechanism — the harness embeds a Pi-family
// engine directly in the Electron main process. The one stable, local,
// third-party-readable surface it exposes is its runtime SQLite database
// (read-only): the main process keeps a WAL write handle open on
//   <userData>/accounts/<account-hash>/runtime/runtime.sqlite
// whose work_sessions / work_runs / work_workspaces tables carry the full
// session and run lifecycle (status enums, timestamps, titles, workspace
// root paths).
//
// This monitor polls that database read-only (node:sqlite DatabaseSync with
// readOnly: true — readers never block the writer under WAL) and maps run
// lifecycle to Clawd state events, exactly like the Codex JSONL fallback
// monitor. Privacy contract: the SQL below is a closed allowlist with
// explicit column lists — content columns (work_runs.text,
// answer_preview, payload_json, attachments, drafts…) are never selected.
//
// The private schema has no stability guarantee: every statement runs
// against a verified column set (PRAGMA table_info gate) and any mismatch
// marks the database unsupported instead of guessing. Real-machine evidence
// lives in docs/investigations/autoclaw-e1-evidence.md.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ── Identity ────────────────────────────────────────────────────────────────

// Distinct from the 1.x plugin (raw OpenClaw session keys / autoclaw:default):
// the 2.x harness uses UUID session ids, namespaced so both carriers can be
// tracked under the same autoclaw agent id without colliding.
const SESSION_ID_PREFIX = "autoclaw2:";

const RUN_STATUS_CLASSES = Object.freeze({
  queued: "thinking",
  stopping: "thinking",
  running: "working",
  waiting_approval: "attention",
});

const ACTIVE_RUN_STATUSES = new Set(Object.keys(RUN_STATUS_CLASSES));
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
  "stopped",
  "cancelled",
  "merged",
]);

// ── SQL allowlist (privacy contract) ────────────────────────────────────────
// Explicit column lists only. NEVER add content columns here:
// work_runs.text / answer_preview / model_context / attachments_json /
// work_sessions.draft / draft_annotations_json / work_events.payload_json.

const SESSIONS_SQL = "SELECT session_id, title, workspace_id, updated_at, "
  + "(deleted_at IS NOT NULL) AS deleted, (archived_at IS NOT NULL) AS archived "
  + "FROM work_sessions ORDER BY updated_at DESC LIMIT ?";
const RUNS_SQL = "SELECT run_id, session_id, status, created_at, updated_at "
  + "FROM work_runs ORDER BY updated_at DESC LIMIT ?";
const WORKSPACES_SQL = "SELECT workspace_id, root_path FROM work_workspaces";
const SQL_ALLOWLIST = Object.freeze([SESSIONS_SQL, RUNS_SQL, WORKSPACES_SQL]);

const REQUIRED_SESSION_COLUMNS = Object.freeze([
  "session_id", "title", "workspace_id", "updated_at", "deleted_at", "archived_at",
]);
const REQUIRED_RUN_COLUMNS = Object.freeze([
  "run_id", "session_id", "status", "created_at", "updated_at",
]);
const REQUIRED_WORKSPACE_COLUMNS = Object.freeze(["workspace_id", "root_path"]);

const SESSIONS_LIMIT = 500;
const RUNS_LIMIT = 1000;

// ── Discovery ───────────────────────────────────────────────────────────────

const USER_DATA_DIR_NAME = "AutoClaw-official";

function userDataBaseDir(homeDir, platform) {
  const home = homeDir || os.homedir();
  if (platform === "win32") {
    return process.env.APPDATA || path.join(home, "AppData", "Roaming");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support");
  }
  return process.env.XDG_CONFIG_HOME || path.join(home, ".config");
}

// Electron userData roots the 2.x app may use. The default is the app's
// userData name (AutoClaw-official); any sibling directory that actually
// contains accounts/*/runtime/runtime.sqlite also qualifies, so a future
// rename keeps working. The 1.x userData ("autoclaw") has no accounts/ tree
// and never matches. AUTOCLAW_USER_DATA_ROOT is the app's own override env.
function resolveAutoClawUserDataRoots(options = {}) {
  const env = options.env || process.env;
  const override = typeof env.AUTOCLAW_USER_DATA_ROOT === "string"
    && env.AUTOCLAW_USER_DATA_ROOT.trim()
    ? env.AUTOCLAW_USER_DATA_ROOT.trim()
    : null;
  if (override) return [override];

  const base = options.baseDir
    || userDataBaseDir(options.homeDir, options.platform || process.platform);
  const roots = new Set([path.join(base, USER_DATA_DIR_NAME)]);
  const fsImpl = options.fs || fs;
  try {
    for (const entry of fsImpl.readdirSync(base)) {
      if (/^AutoClaw/i.test(entry)) roots.add(path.join(base, entry));
    }
  } catch {}
  return [...roots];
}

// A runtime database is proof of a launched-and-used AutoClaw 2.x: the app
// creates accounts/<hash>/runtime/runtime.sqlite on first run.
function discoverRuntimeDatabasePaths(options = {}) {
  const fsImpl = options.fs || fs;
  const roots = options.roots
    || resolveAutoClawUserDataRoots({ ...options, fs: fsImpl });
  const found = [];
  for (const root of roots) {
    const accountsDir = path.join(root, "accounts");
    let accounts;
    try {
      accounts = fsImpl.readdirSync(accountsDir);
    } catch {
      continue;
    }
    for (const account of accounts) {
      const dbPath = path.join(accountsDir, account, "runtime", "runtime.sqlite");
      try {
        if (fsImpl.statSync(dbPath).isFile()) found.push(dbPath);
      } catch {}
    }
  }
  return found.sort();
}

// ── Pure state machine ──────────────────────────────────────────────────────
// tracked: Map<sessionId, { signature, title, cwd, ended }>
// emits:   [{ rawSessionId, state, event, extra: { sessionTitle, cwd, titleOnly } }]

function runPriority(status) {
  if (status === "waiting_approval") return 3;
  if (status === "running") return 2;
  if (status === "queued" || status === "stopping") return 1;
  return 0;
}

function activeRunView(runs) {
  let best = null;
  for (const run of runs) {
    if (!ACTIVE_RUN_STATUSES.has(run.status)) continue;
    const priority = runPriority(run.status);
    if (!best || priority > best.priority) best = { run, priority };
  }
  return best ? best.run : null;
}

function terminalRunView(runs) {
  let best = null;
  for (const run of runs) {
    if (!TERMINAL_RUN_STATUSES.has(run.status) || run.status === "merged") continue;
    if (!best || String(run.updated_at) > String(best.updated_at)) best = run;
  }
  return best;
}

function terminalTransition(run) {
  if (run.status === "failed") return { state: "error", event: "StopFailure" };
  return { state: "attention", event: "Stop" };
}

function activeTransition(status) {
  const state = RUN_STATUS_CLASSES[status];
  if (state === "attention") return { state: "attention", event: "Notification" };
  if (state === "working") return { state: "working", event: "PreToolUse" };
  return { state: "thinking", event: "UserPromptSubmit" };
}

// Builds the per-poll snapshot from raw query rows. Kept separate from the
// differ so tests can feed fixtures without sqlite.
function buildSnapshot({ sessionRows, runRows, workspaceRows }) {
  const workspaces = new Map();
  for (const row of workspaceRows || []) {
    if (row && typeof row.workspace_id === "string" && typeof row.root_path === "string") {
      workspaces.set(row.workspace_id, row.root_path);
    }
  }
  const runsBySession = new Map();
  for (const row of runRows || []) {
    if (!row || typeof row.session_id !== "string" || typeof row.status !== "string") continue;
    if (!ACTIVE_RUN_STATUSES.has(row.status) && !TERMINAL_RUN_STATUSES.has(row.status)) continue;
    const list = runsBySession.get(row.session_id) || [];
    list.push(row);
    runsBySession.set(row.session_id, list);
  }
  const sessions = [];
  for (const row of sessionRows || []) {
    if (!row || typeof row.session_id !== "string") continue;
    sessions.push({
      sessionId: row.session_id,
      title: typeof row.title === "string" ? row.title : "",
      workspaceId: typeof row.workspace_id === "string" ? row.workspace_id : null,
      deleted: row.deleted === 1 || row.deleted === true,
      archived: row.archived === 1 || row.archived === true,
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
    });
  }
  return { sessions, runsBySession, workspaces };
}

function computeAutoClawSessionDiffs(tracked, snapshot) {
  const emits = [];
  const next = new Map(tracked);

  for (const session of snapshot.sessions) {
    const rawSessionId = SESSION_ID_PREFIX + session.sessionId;
    const cwd = session.workspaceId
      ? snapshot.workspaces.get(session.workspaceId) || undefined
      : undefined;
    const prior = tracked.get(session.sessionId);

    if (session.deleted || session.archived) {
      if (prior && !prior.ended) {
        emits.push({
          rawSessionId,
          state: "sleeping",
          event: "SessionEnd",
          extra: { sessionTitle: session.title, cwd },
        });
      }
      next.delete(session.sessionId);
      continue;
    }

    const runs = snapshot.runsBySession.get(session.sessionId) || [];
    let transition = null;
    let signature = null;

    const active = activeRunView(runs);
    if (active) {
      transition = activeTransition(active.status);
      signature = `active:${active.status}`;
    } else {
      const terminal = terminalRunView(runs);
      if (terminal) {
        transition = terminalTransition(terminal);
        signature = `terminal:${terminal.run_id}`;
      } else if (prior && prior.signature && prior.signature.startsWith("active:")) {
        // Every run left the LIMIT window or was merged away while we still
        // show an active state — close the turn instead of sticking forever.
        transition = { state: "attention", event: "Stop" };
        signature = "terminal:vanished";
      }
    }

    if (!transition) {
      // No activity yet: the session must not enter the HUD until its first
      // run (same awaitingActivity semantics as DSH/Kimi desktop sessions),
      // but remember the title so the first event carries it.
      if (!prior) {
        next.set(session.sessionId, {
          signature: null,
          title: session.title,
          cwd,
          ended: false,
        });
      } else {
        next.set(session.sessionId, { ...prior, title: session.title, cwd });
      }
      continue;
    }

    const priorSignature = prior ? prior.signature : null;
    const titleChanged = !prior || prior.title !== session.title;
    const cwdChanged = !prior || (prior.cwd || undefined) !== (cwd || undefined);
    const signatureChanged = priorSignature !== signature;

    if (!prior) {
      // A session never seen before that is ALREADY terminal is history from
      // before this Clawd run: record it silently so Clawd restarts do not
      // resurrect every old conversation as a Done row. Live activity always
      // surfaces, and any later run re-emits normally.
      if (transition.event === "Stop" || transition.event === "StopFailure") {
        next.set(session.sessionId, { signature, title: session.title, cwd, ended: false });
        continue;
      }
      emits.push({ rawSessionId, state: transition.state, event: transition.event, extra: { sessionTitle: session.title, cwd } });
      next.set(session.sessionId, { signature, title: session.title, cwd, ended: false });
      continue;
    }

    if (signatureChanged) {
      emits.push({ rawSessionId, state: transition.state, event: transition.event, extra: { sessionTitle: session.title, cwd } });
      next.set(session.sessionId, { signature, title: session.title, cwd, ended: false });
      continue;
    }

    // Same lifecycle point: surface title/cwd metadata without re-firing the
    // state event (a repeated Stop would double-count recap completions).
    if (titleChanged || cwdChanged) {
      emits.push({
        rawSessionId,
        state: transition.state,
        event: transition.event,
        extra: { sessionTitle: session.title, cwd, titleOnly: true },
      });
      next.set(session.sessionId, { signature, title: session.title, cwd, ended: false });
    }
  }

  return { emits, nextTracked: next };
}

// ── Monitor ─────────────────────────────────────────────────────────────────

class AutoClawRuntimeMonitor {
  /**
   * @param {object} agentConfig - agents/autoclaw.js (identity for logging)
   * @param {function} onStateChange - (rawSessionId, state, event, extra) => void
   * @param {object} options
   *   - pollIntervalMs, queryFn(dbPath, sql, params) -> rows, fs, homeDir,
   *     env, platform, log(message)
   */
  constructor(agentConfig, onStateChange, options = {}) {
    this._config = agentConfig || {};
    this._onStateChange = typeof onStateChange === "function" ? onStateChange : () => {};
    this._pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 1500;
    this._fs = options.fs || fs;
    this._discoveryOptions = {
      fs: this._fs,
      homeDir: options.homeDir,
      env: options.env,
      platform: options.platform,
    };
    this._queryFn = options.queryFn || null; // lazily bound to node:sqlite
    this._log = typeof options.log === "function" ? options.log : (() => {});
    this._interval = null;
    // Map<dbPath, { database }>
    this._databases = new Map();
    // Map<"${dbPath}\u0000${table}", boolean> — schema verdicts, dropped
    // together with a handle so a replaced database is re-verified.
    this._schemaCache = new Map();
    // Map<sessionId, tracked>
    this._tracked = new Map();
    this._warnedUnsupported = new Set();
  }

  start() {
    if (this._interval) return;
    this.pollOnce();
    this._interval = setInterval(() => {
      try {
        this.pollOnce();
      } catch (err) {
        // A monitor must never take the main process down: log and keep the
        // loop alive; the next poll reopens handles as needed.
        this._log(`poll failed: ${err && err.message}`);
      }
    }, this._pollIntervalMs);
    if (this._interval.unref) this._interval.unref();
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this.closeDatabases();
    this._tracked.clear();
  }

  closeDatabases() {
    for (const entry of this._databases.values()) {
      try {
        if (entry.database) entry.database.close();
      } catch {}
    }
    this._databases.clear();
    this._schemaCache.clear();
  }

  // Single read path: injected queryFn (tests) or a cached readOnly handle.
  runQuery(dbPath, sql, params) {
    if (this._queryFn) return this._queryFn(dbPath, sql, params);
    const entry = this.ensureDatabase(dbPath);
    return entry.database.prepare(sql).all(...(params || []));
  }

  ensureDatabase(dbPath) {
    let entry = this._databases.get(dbPath);
    if (!entry || !entry.database) {
      const { DatabaseSync } = require("node:sqlite");
      const database = new DatabaseSync(dbPath, { readOnly: true });
      entry = { database };
      this._databases.set(dbPath, entry);
    }
    return entry;
  }

  closeDatabase(dbPath) {
    const entry = this._databases.get(dbPath);
    try {
      if (entry && entry.database) entry.database.close();
    } catch {}
    this._databases.delete(dbPath);
    for (const key of [...this._schemaCache.keys()]) {
      if (key.startsWith(`${dbPath}\u0000`)) this._schemaCache.delete(key);
    }
  }

  // PRAGMA table_info verdicts are cached per database; a schema mismatch
  // marks the database unsupported instead of letting partial guesses through.
  verifySchema(dbPath, table, required) {
    const cacheKey = `${dbPath}\u0000${table}`;
    if (this._schemaCache.has(cacheKey)) return this._schemaCache.get(cacheKey);
    let ok = false;
    try {
      const columns = new Set(
        this.runQuery(dbPath, `PRAGMA table_info(${table})`, []).map((row) => row.name)
      );
      ok = required.every((name) => columns.has(name));
    } catch {
      ok = false;
    }
    this._schemaCache.set(cacheKey, ok);
    return ok;
  }

  pollOnce() {
    const dbPaths = discoverRuntimeDatabasePaths(this._discoveryOptions);
    const alive = new Set(dbPaths);

    // Drop handles for databases that disappeared (app data removed).
    for (const dbPath of [...this._databases.keys()]) {
      if (!alive.has(dbPath)) {
        this.closeDatabase(dbPath);
        this._warnedUnsupported.delete(dbPath);
      }
    }

    const sessionRows = [];
    const runRows = [];
    const workspaceRows = [];
    for (const dbPath of dbPaths) {
      const schemaOk = this.verifySchema(dbPath, "work_sessions", REQUIRED_SESSION_COLUMNS)
        && this.verifySchema(dbPath, "work_runs", REQUIRED_RUN_COLUMNS)
        && this.verifySchema(dbPath, "work_workspaces", REQUIRED_WORKSPACE_COLUMNS);
      if (!schemaOk) {
        if (!this._warnedUnsupported.has(dbPath)) {
          this._warnedUnsupported.add(dbPath);
          this._log(`${dbPath} does not expose the expected AutoClaw 2.x runtime tables; skipping`);
        }
        continue;
      }
      try {
        sessionRows.push(...this.runQuery(dbPath, SESSIONS_SQL, [SESSIONS_LIMIT]));
        runRows.push(...this.runQuery(dbPath, RUNS_SQL, [RUNS_LIMIT]));
        workspaceRows.push(...this.runQuery(dbPath, WORKSPACES_SQL, []));
      } catch (err) {
        // Stale handle (app restarted, WAL checkpoint, db replaced): reopen
        // on the next poll. Schema gates re-verify with the new handle.
        this._log(`read failed on ${dbPath}: ${err && err.message}`);
        this.closeDatabase(dbPath);
      }
    }

    const snapshot = buildSnapshot({ sessionRows, runRows, workspaceRows });
    const { emits, nextTracked } = computeAutoClawSessionDiffs(this._tracked, snapshot);
    this._tracked = nextTracked;
    for (const item of emits) {
      try {
        this._onStateChange(item.rawSessionId, item.state, item.event, item.extra);
      } catch {}
    }
    return emits.length;
  }
}

// ── Doctor helper ───────────────────────────────────────────────────────────
// Read-only check used by the doctor detector: does any discovered runtime
// database expose the tables this build understands? Never throws.
function inspectAutoClawRuntimeDatabases(options = {}) {
  const fsImpl = options.fs || fs;
  const dbPaths = discoverRuntimeDatabasePaths({ ...options, fs: fsImpl });
  if (!dbPaths.length) return { found: 0, supported: false };
  let supported = false;
  let opened = 0;
  for (const dbPath of dbPaths) {
    let database;
    try {
      const { DatabaseSync } = require("node:sqlite");
      database = new DatabaseSync(dbPath, { readOnly: true });
      opened += 1;
      const check = (table, required) => {
        const columns = new Set(
          database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)
        );
        return required.every((name) => columns.has(name));
      };
      if (check("work_sessions", REQUIRED_SESSION_COLUMNS)
        && check("work_runs", REQUIRED_RUN_COLUMNS)
        && check("work_workspaces", REQUIRED_WORKSPACE_COLUMNS)) {
        supported = true;
      }
    } catch {
      // unreadable / node:sqlite unavailable — leave supported as-is
    } finally {
      try {
        if (database) database.close();
      } catch {}
    }
  }
  return { found: dbPaths.length, opened, supported };
}

module.exports = {
  ACTIVE_RUN_STATUSES,
  RUN_STATUS_CLASSES,
  SESSION_ID_PREFIX,
  SESSIONS_SQL,
  RUNS_SQL,
  WORKSPACES_SQL,
  SQL_ALLOWLIST,
  REQUIRED_SESSION_COLUMNS,
  REQUIRED_RUN_COLUMNS,
  REQUIRED_WORKSPACE_COLUMNS,
  USER_DATA_DIR_NAME,
  AutoClawRuntimeMonitor,
  activeTransition,
  buildSnapshot,
  computeAutoClawSessionDiffs,
  discoverRuntimeDatabasePaths,
  inspectAutoClawRuntimeDatabases,
  resolveAutoClawUserDataRoots,
  terminalTransition,
  userDataBaseDir,
};
