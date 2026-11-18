"use strict";

// Qoder Desktop (com.qoder.app.stable / com.qodercn.app.stable) keeps session
// titles and delegation metadata in main.sqlite `chat_sessions`. Newer builds
// no longer append ai-title/custom-title JSONL records, so the JSONL tracker
// alone cannot name these sessions. Delegated child sessions (extra_json
// delegationParent, sideChat owner, non-standard kind) fire their own hooks
// but must not open HUD cards of their own.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeSessionTitle } = require("./jsonl-session-title");

const TITLE_POLL_MS = 2000;
const MAX_SESSIONS = 256;
const MAX_DB_TITLE_BYTES = 4096;

function qoderDesktopDataDirs(options = {}) {
  const home = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  let root;
  if (platform === "win32") root = env.APPDATA || path.join(home, "AppData", "Roaming");
  else if (platform === "darwin") root = path.join(home, "Library", "Application Support");
  else root = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return [
    path.join(root, "com.qoder.app.stable"),
    path.join(root, "com.qodercn.app.stable"),
  ];
}

function openReadOnlyDatabase(filePath) {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(filePath, { readOnly: true });
}

// Returns { title, delegated, archived, deleted, home } or null when no row /
// database could be read. Callers must treat null as "unknown", never as a
// reason to suppress.
function readQoderDesktopSession(input, options = {}) {
  const raw = typeof input.rawSessionId === "string" ? input.rawSessionId.trim() : "";
  if (!raw) return null;
  const dirs = options.dataDirs || qoderDesktopDataDirs(options);
  const openDatabase = options.openDatabase || openReadOnlyDatabase;
  for (const dir of dirs) {
    const filePath = path.join(dir, "main.sqlite");
    let db;
    try {
      // readOnly alone throws on absent files; don't create a Qoder home.
      if (!fs.existsSync(filePath)) continue;
      db = openDatabase(filePath);
      const row = db.prepare(
        "SELECT CASE WHEN title IS NULL OR length(CAST(title AS BLOB)) <= ? THEN title ELSE NULL END AS title, "
        + "extra_json, session_kind, owner_session_id, archived, deleted_at "
        + "FROM chat_sessions WHERE session_id = ?",
      ).get(MAX_DB_TITLE_BYTES, raw);
      if (!row) continue;
      let delegated = !!row.owner_session_id
        || (typeof row.session_kind === "string" && row.session_kind !== "standard");
      let parentSessionId = null;
      if (!delegated) {
        try {
          const extra = JSON.parse(row.extra_json || "{}");
          const parent = extra && extra.delegationParent && extra.delegationParent.sessionId;
          if (parent) {
            delegated = true;
            parentSessionId = String(parent);
          }
        } catch {}
      }
      const deleted = row.deleted_at !== null && row.deleted_at !== undefined;
      const archived = row.archived === 1 || row.archived === true;
      return {
        title: deleted ? null : normalizeSessionTitle(row.title),
        delegated,
        parentSessionId,
        archived,
        deleted,
        home: dir,
      };
    } catch {
      // Older Node, locked/corrupt DBs, or unknown schemas: unknown, not false.
      continue;
    } finally {
      if (db) { try { db.close(); } catch {} }
    }
  }
  return null;
}

function suppressedMeta(meta) {
  return !!(meta && (meta.delegated || meta.archived || meta.deleted));
}

function createQoderDesktopTitleTracker(options = {}) {
  const getSession = options.getSession || (() => null);
  const updateTitle = options.updateTitle || (() => {});
  const onRetired = typeof options.onRetired === "function" ? options.onRetired : () => {};
  const jsonl = options.jsonl || null;
  const readSession = options.readSession || readQoderDesktopSession;
  const pollMs = options.pollMs || TITLE_POLL_MS;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const readerOptions = options.readerOptions || {};
  const entries = new Map();
  const metaCache = new Map();
  let timer = null;

  function readMeta(rawSessionId, force = false) {
    const cached = metaCache.get(rawSessionId);
    if (!force && cached && now() - cached.readAt < pollMs) return cached.meta;
    let meta = null;
    try {
      meta = readSession({ rawSessionId }, readerOptions);
    } catch { meta = null; }
    metaCache.delete(rawSessionId);
    metaCache.set(rawSessionId, { meta, readAt: now() });
    while (metaCache.size > MAX_SESSIONS) metaCache.delete(metaCache.keys().next().value);
    return meta;
  }

  // Synchronous gate for the accept path. Only a confirmed delegated /
  // archived / deleted row suppresses; an unreadable database never does.
  function readSuppression(rawSessionId) {
    if (typeof rawSessionId !== "string" || !rawSessionId) return false;
    return suppressedMeta(readMeta(rawSessionId));
  }

  function ensureTimer() {
    if (timer) return;
    timer = setInterval(() => { void poll(); }, pollMs);
    timer.unref?.();
  }

  function clear(sessionId = null) {
    if (sessionId === null) {
      entries.clear();
      metaCache.clear();
    } else {
      entries.delete(sessionId);
    }
    if (!entries.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function insertEntry(sessionId, entry) {
    entries.delete(sessionId);
    entries.set(sessionId, entry);
    while (entries.size > MAX_SESSIONS) clear(entries.keys().next().value);
  }

  async function refresh(entry) {
    if (entry.pending) return entry.pending;
    const live = getSession(entry.sessionId);
    if (!live) { clear(entry.sessionId); return; }
    entry.pending = (async () => {
      try {
        const meta = readMeta(entry.rawSessionId, true);
        // SessionEnd, disable/uninstall and late async reads must not annotate
        // another lifecycle or create a phantom HUD row.
        if (entries.get(entry.sessionId) !== entry || getSession(entry.sessionId) !== live) return;
        if (suppressedMeta(meta)) {
          clear(entry.sessionId);
          try { onRetired({ sessionId: entry.sessionId, rawSessionId: entry.rawSessionId, meta }); } catch {}
          return;
        }
        let title = meta ? meta.title : null;
        if (!title && jsonl && entry.transcriptPath) {
          title = await jsonl.resolve({
            event: "Stop", sessionId: entry.rawSessionId, transcriptPath: entry.transcriptPath,
          });
        }
        if (entries.get(entry.sessionId) !== entry || getSession(entry.sessionId) !== live) return;
        if (title) updateTitle(entry.sessionId, title);
      } catch {} // Metadata discovery never breaks state delivery.
    })();
    try { await entry.pending; }
    finally { entry.pending = null; }
  }

  async function poll() {
    await Promise.all([...entries.values()].map(refresh));
  }

  function track(input) {
    const previous = entries.get(input.sessionId);
    const entry = {
      sessionId: input.sessionId,
      rawSessionId: input.rawSessionId,
      cwd: input.cwd,
      transcriptPath: input.transcriptPath,
      pending: null,
      lastReadAt: previous && previous.rawSessionId === input.rawSessionId ? previous.lastReadAt : 0,
    };
    insertEntry(input.sessionId, entry);
    ensureTimer();
    // A brand-new session reads immediately so its title is not delayed by a
    // full interval; repeat events within the window wait for the poll.
    if (now() - entry.lastReadAt >= pollMs) {
      entry.lastReadAt = now();
      void refresh(entry);
    }
  }

  // Startup reconciliation for rows restored before this observer existed.
  function sweep(sessions) {
    for (const session of sessions || []) {
      if (!session || !session.sessionId || !session.rawSessionId) continue;
      track({
        sessionId: session.sessionId,
        rawSessionId: session.rawSessionId,
        cwd: session.cwd,
        transcriptPath: session.transcriptPath,
      });
    }
  }

  return { track, sweep, poll, clear, readSuppression, readMeta, size: () => entries.size };
}

module.exports = {
  TITLE_POLL_MS,
  MAX_DB_TITLE_BYTES,
  qoderDesktopDataDirs,
  readQoderDesktopSession,
  createQoderDesktopTitleTracker,
};