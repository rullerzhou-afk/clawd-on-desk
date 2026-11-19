"use strict";

// Qoder Desktop (com.qoder.app.stable / com.qodercn.app.stable) keeps session
// titles and delegation metadata in main.sqlite `chat_sessions`. Newer builds
// no longer append ai-title/custom-title JSONL records, so the JSONL tracker
// alone cannot name these sessions. Only the explicit delegation marker
// (extra_json.delegationParent) suppresses a row: session_kind /
// owner_session_id also describe user-visible side chats and must never infer
// delegation. Unknown/unreadable databases never suppress.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeSessionTitle } = require("./jsonl-session-title");

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
  return new DatabaseSync(filePath, { readOnly: true });
}

function bareQoderRaw(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const bare = trimmed.startsWith("qoder:") ? trimmed.slice(6) : trimmed;
  return bare || null;
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
    const fraction = Number(snapshot && snapshot.percentage);
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

// Returns the best row across installed editions, or null when unreadable.
// Active rows win over archived/deleted/delegated copies; ties prefer the
// most recently updated row. null means "unknown", never a reason to suppress.
function readQoderDesktopSession(input, options = {}) {
  const raw = bareQoderRaw(input.rawSessionId);
  if (!raw) return null;
  const dirs = options.dataDirs || qoderDesktopDataDirs(options);
  const openDatabase = options.openDatabase || openReadOnlyDatabase;
  const handles = options.handles || null;
  let best = null;
  let bestSuppressed = false;
  for (const dir of dirs) {
    const filePath = path.join(dir, "main.sqlite");
    let db = handles ? handles.get(dir) : undefined;
    let own = false;
    try {
      if (!db) {
        if (!fs.existsSync(filePath)) continue;
        db = openDatabase(filePath);
        own = true;
      }
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
      if (own && db) { try { db.close(); } catch {} }
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
  const readSession = options.readSession || readQoderDesktopSession;
  const debugLog = typeof options.debugLog === "function" ? options.debugLog : null;
  const pollMs = options.pollMs || TITLE_POLL_MS;
  const idlePollMs = options.idlePollMs || IDLE_POLL_MS;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const readerOptions = options.readerOptions || {};
  const entries = new Map();
  const metaCache = new Map();
  let timer = null;

  function readMeta(rawSessionId, force = false, handles = null) {
    const raw = bareQoderRaw(rawSessionId);
    if (!raw) return null;
    const cached = metaCache.get(raw);
    if (!force && cached && now() - cached.readAt < pollMs) return cached.meta;
    let meta = null;
    try {
      meta = readSession({ rawSessionId: raw }, { ...readerOptions, handles, debugLog });
    } catch { meta = null; }
    metaCache.delete(raw);
    metaCache.set(raw, { meta, readAt: now() });
    while (metaCache.size > MAX_SESSIONS) metaCache.delete(metaCache.keys().next().value);
    return meta;
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
      const entry = entries.get(sessionId);
      if (entry) metaCache.delete(entry.rawSessionId);
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

  async function refresh(entry, handles = null) {
    if (entry.pending) return entry.pending;
    const live = getSession(entry.sessionId);
    if (!live) { clear(entry.sessionId); return; }
    // Idle conversations back off; active ones keep the short poll window.
    const idle = live.state === "idle" || live.state === "sleeping";
    if (idle && now() - entry.lastReadAt < idlePollMs) return;
    entry.lastReadAt = now();
    entry.pending = (async () => {
      try {
        const meta = readMeta(entry.rawSessionId, true, handles);
        // SessionEnd, disable/uninstall and late async reads must not annotate
        // another lifecycle or create a phantom HUD row.
        if (entries.get(entry.sessionId) !== entry || getSession(entry.sessionId) !== live) return;
        if (meta && (meta.delegated || meta.archived || meta.deleted)) {
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
        if (meta && meta.contextUsage) updateContextUsage(entry.sessionId, meta.contextUsage);
      } catch {} // Metadata discovery never breaks state delivery.
    })();
    try { await entry.pending; }
    finally { entry.pending = null; }
  }

  // One connection per edition per poll cycle instead of per session.
  async function poll() {
    const handles = new Map();
    const openDatabase = readerOptions.openDatabase || openReadOnlyDatabase;
    try {
      for (const dir of readerOptions.dataDirs || qoderDesktopDataDirs(readerOptions)) {
        const filePath = path.join(dir, "main.sqlite");
        try {
          if (fs.existsSync(filePath)) handles.set(dir, openDatabase(filePath));
        } catch {}
      }
      await Promise.all([...entries.values()].map((entry) => refresh(entry, handles)));
    } finally {
      for (const db of handles.values()) { try { db.close(); } catch {} }
    }
  }

  function track(input) {
    // Production rawSessionId carries the qoder: namespace; SQL keys are bare.
    const rawSessionId = bareQoderRaw(input.rawSessionId) || input.rawSessionId;
    const previous = entries.get(input.sessionId);
    const entry = {
      sessionId: input.sessionId,
      rawSessionId,
      cwd: input.cwd,
      transcriptPath: input.transcriptPath,
      pending: null,
      lastReadAt: previous && previous.rawSessionId === rawSessionId ? previous.lastReadAt : 0,
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

  return {
    track,
    sweep,
    poll,
    clear,
    readMeta,
    size: () => entries.size,
  };
}

// Pet/HUD projection parity with Codex: while delegated children are active
// the parent presents "juggling" without rewriting canonical state. Strong
// states (notification/sweeping/error) keep their own presentation. Evidence
// lives outside sessions, like codex-subagent-presentation.
function createQoderSubagentPresentation(sessions, now = Date.now) {
  const parents = new Map();
  function isLocalQoderParent(session) {
    return session && session.agentId === "qoder" && !session.headless
      && session.state !== "sleeping" && !session.host && !session.wslDistro
      && (!session.profileId || session.profileId === "local");
  }
  function prune() {
    let changed = false;
    for (const [id, children] of parents) {
      for (const [childId, at] of children) {
        if (!isLocalQoderParent(sessions.get(id)) || now() - at > SUBAGENT_TTL_MS) {
          children.delete(childId); changed = true;
        }
      }
      if (!children.size) parents.delete(id);
    }
    return changed;
  }
  function update(parentId, input = {}) {
    prune();
    const childId = typeof input.childId === "string" && input.childId ? input.childId : null;
    if (!childId || parentId === childId || !isLocalQoderParent(sessions.get(parentId))) return false;
    if (input.phase === "end") {
      const changed = parents.has(parentId);
      parents.delete(parentId);
      return changed;
    }
    if (!["start", "activity", "stop"].includes(input.phase)) return false;
    const children = parents.get(parentId);
    if (input.phase === "stop") {
      if (!children || !children.delete(childId)) return false;
      if (!children.size) parents.delete(parentId);
      return true;
    }
    const occurredAt = Number.isSafeInteger(input.occurredAt) ? input.occurredAt : now();
    if (occurredAt > now() + 1500 || now() - occurredAt > SUBAGENT_TTL_MS) return false;
    const previous = children && children.get(childId);
    if (previous && occurredAt < previous) return false;
    const target = children || new Map();
    if (!previous && target.size >= 200) return false;
    target.set(childId, occurredAt);
    parents.set(parentId, target);
    return !previous || previous !== occurredAt;
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
    project,
    count: (id) => { prune(); return parents.get(id)?.size || 0; },
    has: (id) => { prune(); return !!parents.get(id)?.size; },
    hasAny: () => { prune(); return parents.size > 0; },
    clear: () => parents.clear(),
  };
}

const { CODEX_LOCAL_WORKING_STALE_FLOOR_MS: SUBAGENT_TTL_MS } = require("./state-stale-cleanup");

module.exports = {
  TITLE_POLL_MS,
  MAX_DB_TITLE_BYTES,
  qoderDesktopDataDirs,
  readQoderDesktopSession,
  createQoderDesktopTitleTracker,
  createQoderSubagentPresentation,
};