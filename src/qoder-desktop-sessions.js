"use strict";

// Qoder Desktop (com.qoder.app.stable / com.qodercn.app.stable) keeps session
// titles and delegation metadata in main.sqlite `chat_sessions`. Newer builds
// no longer append ai-title/custom-title JSONL records, so the JSONL tracker
// alone cannot name these sessions. Delegation comes from the explicit
// extra_json.delegationParent marker because session_kind and owner_session_id
// also describe user-visible side chats. Suppression requires confirmed metadata.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeSessionTitle } = require("./jsonl-session-title");
const { normalizeQoderSessionId } = require("./qoder-session-title");
const { CODEX_LOCAL_WORKING_STALE_FLOOR_MS: SUBAGENT_TTL_MS } = require("./state-stale-cleanup");

const TITLE_POLL_MS = 2000;
const IDLE_POLL_MS = 10000;
const MAX_SESSIONS = 256;
const MAX_DB_TITLE_BYTES = 4096;
const MAX_SNAPSHOT_BYTES = 65536;

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
  return new DatabaseSync(filePath, { readOnly: true, timeout: 0 });
}

function isLocalQoderSession(session) {
  return !!session && session.agentId === "qoder"
    && (!session.profileId || session.profileId === "local")
    && !session.host && !session.wslDistro
    && String(session.platform || "").trim().toLowerCase() !== "wsl";
}

// Schema-tolerant row read: full columns, then minimal, then title-only.
// Older/future Qoder schemas missing lifecycle columns degrade instead of
// losing the title entirely.
function readRow(db, raw) {
  try {
    const row = db.prepare(
      "SELECT CASE WHEN title IS NULL OR length(CAST(title AS BLOB)) <= ? THEN title ELSE NULL END AS title, "
      + "extra_json, archived, deleted_at, updated_at FROM chat_sessions WHERE session_id = ?",
    ).get(MAX_DB_TITLE_BYTES, raw);
    if (row) return { row, degraded: false };
  } catch {}
  try {
    const row = db.prepare(
      "SELECT CASE WHEN title IS NULL OR length(CAST(title AS BLOB)) <= ? THEN title ELSE NULL END AS title, "
      + "extra_json FROM chat_sessions WHERE session_id = ?",
    ).get(MAX_DB_TITLE_BYTES, raw);
    if (row) return { row, degraded: true };
  } catch {}
  try {
    const row = db.prepare(
      "SELECT CASE WHEN title IS NULL OR length(CAST(title AS BLOB)) <= ? THEN title ELSE NULL END AS title "
      + "FROM chat_sessions WHERE session_id = ?",
    ).get(MAX_DB_TITLE_BYTES, raw);
    if (row) return { row, degraded: true };
  } catch {}
  return null;
}

function readContextUsage(db, raw) {
  try {
    const usageRow = db.prepare(
      "SELECT substr(snapshot_json, 1, ?) AS snapshot_json FROM chat_session_context_usage WHERE session_id = ?",
    ).get(MAX_SNAPSHOT_BYTES, raw);
    if (!usageRow || !usageRow.snapshot_json) return null;
    const snapshot = JSON.parse(usageRow.snapshot_json);
    const fraction = snapshot?.percentage;
    if (!Number.isFinite(fraction)) return null;
    const usage = {
      percent: Math.max(0, Math.min(100, Math.round(fraction * 100))),
      source: "qoder",
    };
    // Token counts are often unavailable (tokenCountsAvailable:false); filling
    // used:0 would render a misleading "0 tokens" tooltip.
    if (snapshot.tokenCountsAvailable === true) {
      const used = Number(snapshot.totalTokens);
      const limit = Number(snapshot.maxTokens);
      if (Number.isFinite(used)) usage.used = used;
      if (Number.isFinite(limit) && limit > 0) usage.limit = limit;
    }
    return usage;
  } catch {
    return null;
  }
}

function openSessionDatabase(dir, openDatabase) {
  const filePath = path.join(dir, "main.sqlite");
  try {
    return fs.existsSync(filePath) ? openDatabase(filePath) : null;
  } catch {
    return null;
  }
}

// Returns the best row across installed editions, or null when unreadable.
// Active rows win over archived/deleted/delegated copies; ties prefer the
// most recently updated row. null means "unknown", never a reason to suppress.
function readQoderDesktopSession(input, options = {}) {
  const raw = normalizeQoderSessionId(input.rawSessionId);
  if (!raw) return null;
  const dirs = options.dataDirs || qoderDesktopDataDirs(options);
  const openDatabase = options.openDatabase || openReadOnlyDatabase;
  const handles = options.handles || null;
  let best = null;
  let bestSuppressed = false;
  for (const dir of dirs) {
    if (handles && !handles.has(dir)) handles.set(dir, openSessionDatabase(dir, openDatabase));
    const db = handles ? handles.get(dir) : openSessionDatabase(dir, openDatabase);
    if (!db) continue;
    try {
      const got = readRow(db, raw);
      if (!got) continue;
      const { row, degraded } = got;
      if (degraded && typeof options.debugLog === "function") {
        options.debugLog(`qoder-desktop schema degraded dir=${dir}`);
      }
      let delegated = false;
      let parentSessionId = null;
      try {
        const extra = JSON.parse(row.extra_json || "{}");
        const parent = extra && extra.delegationParent && extra.delegationParent.sessionId;
        if (parent) {
          delegated = true;
          parentSessionId = String(parent);
        }
      } catch {}
      const deleted = row.deleted_at !== null && row.deleted_at !== undefined;
      const archived = row.archived === 1 || row.archived === true;
      const candidate = {
        title: deleted ? null : normalizeSessionTitle(row.title),
        delegated,
        parentSessionId,
        archived,
        deleted,
        contextUsage: readContextUsage(db, raw),
        updatedAt: Number(row.updated_at) || 0,
        home: dir,
      };
      const suppressed = archived || deleted || delegated;
      if (!best || (bestSuppressed && !suppressed)
        || (bestSuppressed === suppressed && candidate.updatedAt > best.updatedAt)) {
        best = candidate;
        bestSuppressed = suppressed;
      }
    } catch {
      continue;
    } finally {
      if (!handles) { try { db.close(); } catch {} }
    }
  }
  return best;
}

function createQoderDesktopTitleTracker(options = {}) {
  const getSession = options.getSession || (() => null);
  const updateTitle = options.updateTitle || (() => {});
  const updateContextUsage = options.updateContextUsage || (() => {});
  const onRetired = typeof options.onRetired === "function" ? options.onRetired : () => {};
  const jsonl = options.jsonl || null;
  const readerOptions = options.readerOptions || {};
  const readSession = readerOptions.readSession || readQoderDesktopSession;
  const debugLog = typeof options.debugLog === "function" ? options.debugLog : null;
  const pollMs = options.pollMs || TITLE_POLL_MS;
  const idlePollMs = options.idlePollMs || IDLE_POLL_MS;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const entries = new Map();
  const metaCache = new Map();
  const delegationParents = new Map();
  // Keep evidence across failed reads and row removal until a full clear().
  // Evicting the oldest evidence can only cause missed desktop timeouts.
  const desktopSessionIds = new Map();
  let timer = null;

  function remember(map, key, value) {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_SESSIONS) map.delete(map.keys().next().value);
  }

  function queryMeta(raw, handles = null) {
    let meta = null;
    try {
      meta = readSession({ rawSessionId: raw }, { ...readerOptions, handles, debugLog });
    } catch { meta = null; }
    if (meta) remember(desktopSessionIds, raw, true);
    const readAt = now();
    const cached = metaCache.get(raw);
    // Keep the original timestamp so failed rechecks cannot extend the window.
    if (meta === null && cached?.meta && readAt - cached.readAt < pollMs) return cached;
    const reading = { meta, readAt };
    remember(metaCache, raw, reading);
    if (meta?.parentSessionId && meta.delegated) {
      remember(delegationParents, raw, meta.parentSessionId);
    } else if (meta?.delegated === false) {
      delegationParents.delete(raw);
    }
    return reading;
  }

  function finishEventMeta(raw, reading, terminal) {
    const parentSessionId = reading?.meta?.parentSessionId || delegationParents.get(raw);
    // Late work after a child's terminal event needs fresh lifecycle evidence.
    if (parentSessionId && terminal) metaCache.delete(raw);
    return { reading, parentSessionId };
  }

  function readEventMeta(raw, event, active) {
    const parent = delegationParents.get(raw);
    const terminal = event === "Stop" || event === "SessionEnd";
    // The confirmed relationship is enough to settle a child's activity.
    if (parent && terminal) return finishEventMeta(raw, null, terminal);
    // A resumed session can already have a different title or lifecycle.
    if (event === "SessionStart") return finishEventMeta(raw, queryMeta(raw), terminal);

    const cached = metaCache.get(raw);
    // Delegation can be written after the previous hook and before a cue.
    if (!parent && !cached?.meta?.delegated && (event === "Stop" || event === "Notification")) {
      return finishEventMeta(raw, queryMeta(raw), terminal);
    }

    const fresh = cached && now() - cached.readAt < pollMs;
    // A passive event can hide a known child without refreshing its lifecycle.
    if (parent && !active && !fresh) return { reading: null, parentSessionId: parent };
    // Bound database reads while keeping lifecycle evidence fresh for work.
    return finishEventMeta(raw, fresh ? cached : queryMeta(raw), terminal);
  }

  function ensureTimer() {
    if (timer) return;
    timer = setInterval(() => { void poll(); }, pollMs);
    timer.unref?.();
  }

  function hasDesktopRow(rawSessionId) {
    return desktopSessionIds.has(normalizeQoderSessionId(rawSessionId));
  }

  function clear(sessionId = null) {
    if (sessionId === null) {
      entries.clear();
      metaCache.clear();
      delegationParents.clear();
      desktopSessionIds.clear();
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

  async function applyReading(entry, live, reading) {
    const { meta } = reading;
    entry.reading = reading;
    entry.pending = true;
    try {
      if (meta && (meta.delegated || meta.archived || meta.deleted)) {
        clear(entry.sessionId);
        onRetired({ sessionId: entry.sessionId, rawSessionId: entry.rawSessionId, meta });
        return;
      }
      let title = meta?.title;
      if (!title && jsonl && entry.transcriptPath) {
        title = await jsonl.resolve({
          event: "Stop", sessionId: entry.rawSessionId, transcriptPath: entry.transcriptPath,
        });
      }
      // An asynchronous fallback must still belong to the same lifecycle.
      if (entries.get(entry.sessionId) !== entry || getSession(entry.sessionId) !== live) return;
      if (title) updateTitle(entry.sessionId, title);
      if (meta?.contextUsage) updateContextUsage(entry.sessionId, meta.contextUsage);
    } catch {} // Metadata discovery never breaks state delivery.
    finally { entry.pending = false; }
  }

  // One connection per edition per poll cycle instead of per session.
  async function poll() {
    const due = [];
    for (const entry of entries.values()) {
      const live = getSession(entry.sessionId);
      if (!live) {
        clear(entry.sessionId);
        continue;
      }
      const idle = live.state === "idle" || live.state === "sleeping";
      if (!entry.pending && now() - entry.reading.readAt >= (idle ? idlePollMs : pollMs)) {
        due.push(entry);
      }
    }
    if (!due.length) return;

    const handles = new Map();
    try {
      const pending = [];
      for (const entry of due) {
        const live = getSession(entry.sessionId);
        if (live && entries.get(entry.sessionId) === entry) {
          pending.push(applyReading(entry, live, queryMeta(entry.rawSessionId, handles)));
        }
      }
      await Promise.all(pending);
    } finally {
      for (const db of handles.values()) {
        if (db) { try { db.close(); } catch {} }
      }
    }
  }

  function track(input) {
    const rawSessionId = normalizeQoderSessionId(input.rawSessionId);
    const live = getSession(input.sessionId);
    if (!rawSessionId || !live) return;
    const previous = entries.get(input.sessionId);
    const sameSession = previous?.rawSessionId === rawSessionId;
    const reading = input.reading || (!sameSession ? queryMeta(rawSessionId) : null);
    if (!reading || (sameSession && previous.reading === reading)) return;
    const entry = {
      sessionId: input.sessionId,
      rawSessionId,
      transcriptPath: input.transcriptPath,
    };
    insertEntry(input.sessionId, entry);
    ensureTimer();
    void applyReading(entry, live, reading);
  }

  // Startup reconciliation for rows restored before this observer existed.
  function sweep(sessions) {
    for (const session of sessions || []) {
      if (!session || !session.sessionId || !session.rawSessionId) continue;
      track({
        sessionId: session.sessionId,
        rawSessionId: session.rawSessionId,
        transcriptPath: session.transcriptPath,
      });
    }
  }

  return {
    track,
    sweep,
    poll,
    clear,
    readEventMeta,
    hasDesktopRow,
    size: () => entries.size,
  };
}

// Pet/HUD projection parity with Codex: while delegated children are active
// the parent presents "juggling" without rewriting canonical state. Strong
// states (notification/sweeping/error) keep their own presentation. Evidence
// lives outside sessions, like codex-subagent-presentation. The parent's own
// Stop still gets its completion cue because delegated children run separate turns.
function createQoderSubagentPresentation(sessions, now = Date.now) {
  const parents = new Map();
  let expirationChanged = false;
  function isLocalQoderParent(session) {
    return isLocalQoderSession(session) && !session.headless && session.state !== "sleeping";
  }
  function prune() {
    let changed = false;
    const cutoff = now() - SUBAGENT_TTL_MS;
    for (const [id, children] of parents) {
      if (!isLocalQoderParent(sessions.get(id))) {
        parents.delete(id);
        changed = true;
        continue;
      }
      for (const [childId, at] of children) {
        if (at < cutoff) {
          children.delete(childId);
          changed = true;
        }
      }
      if (!children.size) parents.delete(id);
    }
    expirationChanged ||= changed;
    return changed;
  }
  function update(parentId, input = {}) {
    const expired = prune();
    const childId = typeof input.childId === "string" && input.childId ? input.childId : null;
    if (!childId || parentId === childId || !isLocalQoderParent(sessions.get(parentId))) return expired;
    if (!["start", "activity", "stop"].includes(input.phase)) return expired;
    const children = parents.get(parentId);
    if (input.phase === "stop") {
      if (!children || !children.delete(childId)) return expired;
      if (!children.size) parents.delete(parentId);
      return true;
    }
    const occurredAt = Number.isSafeInteger(input.occurredAt) ? input.occurredAt : now();
    if (occurredAt > now() + 1500 || now() - occurredAt > SUBAGENT_TTL_MS) return expired;
    const previous = children && children.get(childId);
    if (previous != null && occurredAt < previous) return expired;
    const target = children || new Map();
    if (previous == null && target.size >= 200) return expired;
    target.set(childId, occurredAt);
    parents.set(parentId, target);
    return expired || previous !== occurredAt;
  }
  function project(source) {
    prune();
    if (!parents.size) return source;
    const projected = new Map(source);
    for (const [id, children] of parents) {
      const parent = source.get(id);
      if (!isLocalQoderParent(parent)) continue;
      if (["notification", "sweeping", "error"].includes(parent.state)) continue;
      projected.set(id, {
        ...parent,
        state: "juggling",
        displayHint: null,
        subagentTracker: { confirmedIds: new Set(children.keys()), legacyFloor: false, recoveredFloor: false },
      });
    }
    return projected;
  }
  return {
    update,
    prune,
    consumeExpirationChange() {
      const changed = expirationChanged;
      expirationChanged = false;
      return changed;
    },
    project,
    count: (id) => { prune(); return parents.get(id)?.size || 0; },
    has: (id) => { prune(); return !!parents.get(id)?.size; },
    hasAny: () => { prune(); return parents.size > 0; },
    delete: (id) => parents.delete(id),
    clear() {
      const changed = parents.size > 0 || expirationChanged;
      parents.clear();
      expirationChanged = false;
      return changed;
    },
  };
}

module.exports = {
  TITLE_POLL_MS,
  MAX_DB_TITLE_BYTES,
  qoderDesktopDataDirs,
  isLocalQoderSession,
  readQoderDesktopSession,
  createQoderDesktopTitleTracker,
  createQoderSubagentPresentation,
};
