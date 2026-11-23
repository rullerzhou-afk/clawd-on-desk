"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { toNumberStats, fileIdentity } = require("../hooks/file-identity");
const {
  createJsonlSessionTitleTracker,
  normalizeSessionTitle,
} = require("./jsonl-session-title");

const TITLE_POLL_MS = 2000;
const MAX_SESSIONS = 256;
const MAX_DB_TITLE_BYTES = 4096;

function workBuddyDataDirs(options = {}) {
  const home = options.homeDir || os.homedir();
  const configured = (options.env || process.env).WORKBUDDY_CONFIG_DIR;
  return [...new Set([
    typeof configured === "string" && path.isAbsolute(configured.trim()) ? configured.trim() : null,
    path.join(home, ".workbuddy-ai"),
    path.join(home, ".workbuddy"),
  ].filter(Boolean))];
}

function sameCwd(a, b) {
  if (!a || !b) return true;
  const normalize = (value) => {
    // WorkBuddy stores Windows paths with either separator spelling.
    const result = path.normalize(value).replace(/\\/g, "/").replace(/\/$/, "");
    return process.platform === "win32" ? result.toLowerCase() : result;
  };
  return normalize(a) === normalize(b);
}

function openReadOnlyDatabase(filePath) {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(filePath, { readOnly: true });
}

function workBuddyHomeOwnsTranscript(dir, transcriptPath) {
  if (!transcriptPath) return false;
  const relative = path.relative(path.join(dir, "projects"), transcriptPath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

// Identity of the transcript file itself (same path is not the same file: a
// transcript can be replaced in place). Returns null when the file cannot be
// stat'd, which callers must treat as "cannot confirm the same file".
function statTranscriptIdentity(transcriptPath, statSync = fs.statSync) {
  if (!transcriptPath) return null;
  try {
    return fileIdentity(toNumberStats(statSync(transcriptPath, { bigint: true })));
  } catch {
    return null;
  }
}

function sameTranscriptIdentity(a, b) {
  return typeof a === "string" && a === b;
}

function normalizeWorkBuddyContextUsage(row) {
  if (!row || typeof row.used !== "number" || typeof row.size !== "number"
    || !Number.isSafeInteger(row.used) || !Number.isSafeInteger(row.size)
    || row.used < 0 || row.size <= 0) return null;
  return {
    used: row.used,
    limit: row.size,
    percent: Math.max(0, Math.min(100, Math.round((row.used / row.size) * 100))),
    source: "workbuddy",
  };
}

// Reads one home's matching row. archived is true/false, or null for an older
// lifecycle schema. Optional contextUsage is read separately on the same handle
// only for the owning home, so unsupported usage cannot alter title/lifecycle.
function readWorkBuddyHomeSession(openDatabase, dir, input, readContextUsage = false) {
  const filePath = path.join(dir, "workbuddy.db");
  let db;
  try {
    // readOnly alone throws on absent files; don't create a WorkBuddy home.
    if (!fs.existsSync(filePath)) return null;
    db = openDatabase(filePath);
    let row;
    let hasLifecycle = true;
    try {
      // Read the matching row even when it has been deleted: the lifecycle is
      // the whole point. Oversized titles are projected to NULL in SQL so the
      // bounded-memory guarantee survives while status/deleted_at stay visible.
      row = db.prepare(
        "SELECT "
        + "CASE WHEN title IS NULL OR length(CAST(title AS BLOB)) <= ? THEN title ELSE NULL END AS title, "
        + "CASE WHEN custom_title IS NULL OR length(CAST(custom_title AS BLOB)) <= ? THEN custom_title ELSE NULL END AS custom_title, "
        + "cwd, status, deleted_at FROM sessions WHERE id = ?",
      ).get(MAX_DB_TITLE_BYTES, MAX_DB_TITLE_BYTES, input.rawSessionId);
    } catch {
      // Older tables have no status column. Keep main's title-only behavior;
      // lifecycle is reported as unknown rather than guessed.
      hasLifecycle = false;
      row = db.prepare(
        "SELECT title, custom_title, cwd FROM sessions WHERE id = ? AND deleted_at IS NULL "
        + "AND (title IS NULL OR length(CAST(title AS BLOB)) <= ?) "
        + "AND (custom_title IS NULL OR length(CAST(custom_title AS BLOB)) <= ?)",
      ).get(input.rawSessionId, MAX_DB_TITLE_BYTES, MAX_DB_TITLE_BYTES);
    }
    if (!row || !sameCwd(input.cwd, row.cwd)) return null;
    const deleted = row.deleted_at !== null && row.deleted_at !== undefined;
    // A deleted row never supplies a title; an archived one still may.
    const title = deleted
      ? null
      : normalizeSessionTitle(row.custom_title) || normalizeSessionTitle(row.title);
    const archived = hasLifecycle ? (row.status === "archived" || deleted) : null;
    const result = { title, archived };
    if (readContextUsage && !deleted && archived !== true) {
      try {
        // WorkBuddy persists the same current context gauge shown by its UI.
        // Its effective size can differ from the optional model override on
        // sessions. Never read credit_json or sum transcript billing counters.
        const usage = db.prepare("SELECT used, size FROM session_usage WHERE session_id = ?")
          .get(input.rawSessionId);
        // Native cost-only events carry numeric 0/0. Some older backends persist
        // that pair, but WorkBuddy's UI ignores it rather than clearing context.
        // Keep the same last-known gauge; a genuine 0/positive-size is still 0%.
        if (!(usage && usage.used === 0 && usage.size === 0)) {
          // A readable missing/invalid value is unknown, not 0%. A missing table,
          // old schema or failed query leaves the field absent and preserves the
          // last observation without affecting title/lifecycle discovery.
          result.contextUsage = normalizeWorkBuddyContextUsage(usage);
        }
      } catch {}
    }
    return result;
  } catch {
    // Older Node, locked/corrupt DBs, or unknown schemas use JSONL instead.
    return null;
  } finally {
    if (db) { try { db.close(); } catch {} }
  }
}

// Returns { title, archived, home } or null when nothing at all could be read.
// Title search spans all installed homes in order. Lifecycle is only reported
// when the owning home is known: the home holding the transcript, or a home
// pinned by an earlier decision. Without a transcript under a known home the
// lifecycle is unknown, never inferred from another home's archive copy — so a
// path-less read can neither retire nor un-retire a card on its own.
// `archived` is true, false, or null (unknown, including a table with no
// lifecycle columns).
function readWorkBuddyDatabaseSession(input, options = {}) {
  if (typeof input.rawSessionId !== "string" || !input.rawSessionId.trim()) return null;
  const dirs = [...(options.dataDirs || workBuddyDataDirs(options))];
  // When both generations are installed, prefer the home owning this transcript.
  dirs.sort((a, b) => Number(workBuddyHomeOwnsTranscript(b, input.transcriptPath))
    - Number(workBuddyHomeOwnsTranscript(a, input.transcriptPath)));
  const openDatabase = options.openDatabase || openReadOnlyDatabase;

  // A pinned home comes from the decision that retired this session. Otherwise
  // it must be the home that owns the transcript; no transcript owner means the
  // lifecycle stays unknown.
  const lifecycleHome = typeof input.lifecycleHome === "string" && input.lifecycleHome
    ? input.lifecycleHome
    : (dirs.find((dir) => workBuddyHomeOwnsTranscript(dir, input.transcriptPath)) || null);

  const reads = new Map();
  let title = null;
  for (const dir of dirs) {
    const result = readWorkBuddyHomeSession(openDatabase, dir, input, dir === lifecycleHome);
    reads.set(dir, result);
    if (title === null && result && result.title) title = result.title;
  }

  const lifecycleRead = lifecycleHome ? reads.get(lifecycleHome) : null;
  const archived = lifecycleRead ? lifecycleRead.archived : null;
  const hasContextUsage = !!lifecycleRead && Object.hasOwn(lifecycleRead, "contextUsage");
  if (title === null && archived === null && !hasContextUsage) return null;
  const result = { title, archived, home: lifecycleHome };
  if (hasContextUsage) result.contextUsage = lifecycleRead.contextUsage;
  return result;
}

function readWorkBuddyDatabaseTitle(input, options = {}) {
  const session = readWorkBuddyDatabaseSession(input, options);
  return session ? session.title : null;
}

function createWorkBuddySessionTitleTracker(options = {}) {
  const entries = new Map();
  const getSession = options.getSession || (() => null);
  const updateTitle = options.updateTitle || (() => {});
  const updateContextUsage = options.updateContextUsage || (() => {});
  // Invoked when the database marks an observed conversation archived or
  // deleted. The observer stops watching it and the runtime retires the card;
  // this is a lifecycle end, not a completion.
  const onRetired = typeof options.onRetired === "function" ? options.onRetired : () => {};
  const pollMs = options.pollMs || TITLE_POLL_MS;
  const now = typeof options.now === "function" ? options.now : Date.now;
  // Seams for tests that need to control file reads / identity; production uses
  // the real fs.
  const statFile = typeof options.statSync === "function" ? options.statSync : fs.statSync;
  const jsonl = createJsonlSessionTitleTracker({
    maxScanBytes: 1024 * 1024,
    ...(options.readerFs ? { fs: options.readerFs } : {}),
  });
  const readTitle = options.readTitle || (async (entry) => {
    const row = readWorkBuddyDatabaseSession(entry, options);
    if (row && (row.archived === true || row.title)) return row;
    // Only SQLite can report the lifecycle; the JSONL fallback supplies a
    // title only and never retires a card.
    if (!entry.transcriptPath) return row;
    const title = await jsonl.resolve({
      event: "Stop", sessionId: entry.rawSessionId, transcriptPath: entry.transcriptPath,
    });
    return row ? { ...row, title } : title;
  });
  let timer = null;

  function ensureTimer() {
    if (timer) return;
    timer = setInterval(() => { void poll(); }, pollMs);
    timer.unref?.();
  }

  function clear(sessionId = null) {
    if (sessionId === null) {
      entries.clear();
      jsonl.clear();
    } else {
      const entry = entries.get(sessionId);
      if (entry) jsonl.clear(entry.rawSessionId);
      entries.delete(sessionId);
    }
    if (!entries.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  // Same raw id and same path is not enough: WorkBuddy can replace a transcript
  // in place, and the shared reader keeps parsed title fields when it detects a
  // new identity. Only a confirmed matching file identity keeps the accumulated
  // state; a changed or unreadable identity resets it. The caller passes the
  // identity it sampled once, so the decision and the recorded entry can never
  // disagree about which file they saw.
  function sameSource(previous, input, identity) {
    if (!previous) return false;
    if (previous.rawSessionId !== input.rawSessionId) return false;
    if (previous.transcriptPath !== input.transcriptPath) return false;
    if (!input.transcriptPath) return true;
    return sameTranscriptIdentity(previous.sourceIdentity, identity);
  }

  // A different raw session id is a new conversation and starts a fresh
  // rate-limit window; the same conversation keeps its window even when the
  // JSONL reader has to be reset (replaced file, unreadable transcript).
  function readWindow(previous, input) {
    return previous && previous.rawSessionId === input.rawSessionId ? previous.lastReadAt : 0;
  }

  function makeEntry(input, previous, identity) {
    return {
      ...input,
      pending: null,
      lastReadAt: readWindow(previous, input),
      sourceIdentity: identity,
    };
  }

  function transcriptIdentity(transcriptPath) {
    return statTranscriptIdentity(transcriptPath, statFile);
  }

  // The observer cap is shared by track() and beginTurn() so neither path can
  // grow the map past MAX_SESSIONS; the oldest observation is evicted.
  function insertEntry(sessionId, entry) {
    entries.delete(sessionId);
    entries.set(sessionId, entry);
    while (entries.size > MAX_SESSIONS) clear(entries.keys().next().value);
  }

  async function refresh(entry) {
    if (entry.pending) return entry.pending;
    const live = getSession(entry.sessionId);
    if (!live) { clear(entry.sessionId); return; }
    entry.lastReadAt = now();
    entry.pending = (async () => {
      try {
        const read = await readTitle(entry);
        const title = typeof read === "string" ? read : (read && read.title) || null;
        const archived = !!(read && typeof read === "object" && read.archived === true);
        const lifecycleHome = typeof read === "object" && typeof read.home === "string" ? read.home : null;
        // SessionEnd, disable/uninstall, same-id resume, and late async reads
        // cannot annotate another lifecycle or create a phantom HUD row.
        if (entries.get(entry.sessionId) !== entry || getSession(entry.sessionId) !== live) return;
        if (archived) {
          // Stop observing and let the runtime dismiss the card. Not a
          // completion: no sound, recap, or completion push is produced.
          // lifecycleHome is pinned so the late-hook re-check reads the same
          // database even when the later event omits the transcript path.
          clear(entry.sessionId);
          try { onRetired({ sessionId: entry.sessionId, rawSessionId: entry.rawSessionId, lifecycleHome }); } catch {}
          return;
        }
        if (title) updateTitle(entry.sessionId, title);
        if (read && typeof read === "object" && Object.hasOwn(read, "contextUsage")
          && entries.get(entry.sessionId) === entry && getSession(entry.sessionId) === live) {
          updateContextUsage(entry.sessionId, read.contextUsage);
        }
      } catch {} // Metadata discovery never breaks state delivery.
    })();
    try { await entry.pending; }
    finally { entry.pending = null; }
  }

  async function poll() {
    await Promise.all([...entries.values()].map(refresh));
  }

  // Synchronous re-check used to gate late hooks for an already retired
  // conversation. Returns true (still archived/deleted), false (readable and
  // active) or null (unknown: no pinned home, missing row, unreadable database,
  // unavailable SQLite, or a table without lifecycle columns). Callers must only
  // suppress on true.
  function readArchived(input = {}) {
    const row = readWorkBuddyDatabaseSession({
      rawSessionId: input.rawSessionId,
      cwd: input.cwd,
      transcriptPath: input.transcriptPath,
      lifecycleHome: input.lifecycleHome,
    }, options);
    if (!row) return null;
    return row.archived;
  }

  // SessionStart boundary. A fresh observer identity stops any read started
  // before this turn from annotating it, while the rate-limit window carries
  // over so the boundary cannot force an extra database read. The JSONL reader
  // is kept only for the same file (same path and same file identity); a transcript
  // switch or a replaced file resets it, so the previous file's late scan
  // cannot leak its title into this turn.
  function beginTurn(input) {
    const previous = entries.get(input.sessionId);
    const identity = transcriptIdentity(input.transcriptPath);
    if (previous && !sameSource(previous, input, identity)) jsonl.clear(previous.rawSessionId);
    const entry = makeEntry(input, previous, identity);
    insertEntry(input.sessionId, entry);
    ensureTimer();
    if (now() - entry.lastReadAt >= pollMs) void refresh(entry);
  }

  function track(input) {
    const previous = entries.get(input.sessionId);
    const identity = transcriptIdentity(input.transcriptPath);
    let entry = previous;
    if (!previous || !sameSource(previous, input, identity) || previous.cwd !== input.cwd) {
      clear(input.sessionId);
      entry = makeEntry(input, previous, identity);
    }
    insertEntry(input.sessionId, entry);
    ensureTimer();
    // One database open per hook event would be wasteful; within a poll window
    // the scheduled poll catches up. A brand-new session reads immediately so
    // its title is not delayed by a full interval.
    if (now() - entry.lastReadAt >= pollMs) void refresh(entry);
  }

  return { track, beginTurn, clear, poll, readArchived, size: () => entries.size };
}

module.exports = {
  TITLE_POLL_MS,
  workBuddyDataDirs,
  readWorkBuddyDatabaseSession,
  readWorkBuddyDatabaseTitle,
  createWorkBuddySessionTitleTracker,
};
