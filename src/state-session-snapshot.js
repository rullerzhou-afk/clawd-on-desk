"use strict";

const path = require("path");
const { sessionAliasKey } = require("./session-alias");
const { getSessionFocusTarget } = require("./session-focus");
const { readCodexThreadName } = require("../hooks/codex-session-index");

const EVENT_LABEL_KEYS = {
  SessionStart: "eventLabelSessionStart",
  SessionEnd: "eventLabelSessionEnd",
  UserPromptSubmit: "eventLabelUserPromptSubmit",
  PreToolUse: "eventLabelPreToolUse",
  PostToolUse: "eventLabelPostToolUse",
  PostToolUseFailure: "eventLabelPostToolUseFailure",
  AfterAgent: "eventLabelAfterAgent",
  Stop: "eventLabelStop",
  StopFailure: "eventLabelStopFailure",
  SubagentStart: "eventLabelSubagentStart",
  SubagentStop: "eventLabelSubagentStop",
  PreCompress: "eventLabelPreCompress",
  PreCompact: "eventLabelPreCompact",
  PostCompact: "eventLabelPostCompact",
  Notification: "eventLabelNotification",
  Elicitation: "eventLabelElicitation",
  WorktreeCreate: "eventLabelWorktreeCreate",
  "stale-cleanup": "eventLabelStaleCleanup",
};

const SESSION_TITLE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]+/g;
const SESSION_TITLE_MAX = 80;

function normalizeTitle(value) {
  if (typeof value !== "string") return null;
  const collapsed = value
    .replace(SESSION_TITLE_CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return null;
  return collapsed.length > SESSION_TITLE_MAX
    ? `${collapsed.slice(0, SESSION_TITLE_MAX - 1)}\u2026`
    : collapsed;
}

function sessionUpdatedAt(session) {
  const updatedAt = Number(session && session.updatedAt);
  return Number.isFinite(updatedAt) ? updatedAt : 0;
}

function deriveSessionBadge(session) {
  if (!session) return "idle";
  if (session.state !== "idle" && session.state !== "sleeping") return "running";
  if (session.state === "sleeping") return "idle";
  const events = Array.isArray(session.recentEvents) ? session.recentEvents : [];
  const latest = events.length ? events[events.length - 1] : null;
  const latestEvent = latest && latest.event;
  if (latestEvent === "StopFailure" || latestEvent === "PostToolUseFailure") return "interrupted";
  if (latestEvent === "Stop" || latestEvent === "PostCompact") return "done";
  return "idle";
}

function isEndedSessionBadge(badge) {
  return badge === "done" || badge === "interrupted";
}

function shouldAutoClearDetachedSession(session, badge, options = {}) {
  if (options.sessionHudCleanupDetached !== true) return false;
  if (!session || session.headless || session.state !== "idle" || session.agentPid) return false;
  if (!session.pidReachable || !session.sourcePid) return false;
  if (!isEndedSessionBadge(badge)) return false;
  const isProcessAlive = typeof options.isProcessAlive === "function"
    ? options.isProcessAlive
    : () => true;
  return !isProcessAlive(session.sourcePid);
}

function getSessionAliasEntry(id, sessionLike, sessionAliases = {}) {
  const scopedAliasKey = sessionAliasKey(
    sessionLike && sessionLike.host,
    sessionLike && sessionLike.agentId,
    id,
    { cwd: sessionLike && sessionLike.cwd }
  );
  if (scopedAliasKey && sessionAliases[scopedAliasKey]) return sessionAliases[scopedAliasKey];

  const legacyAliasKey = sessionAliasKey(
    sessionLike && sessionLike.host,
    sessionLike && sessionLike.agentId,
    id
  );
  if (legacyAliasKey && legacyAliasKey !== scopedAliasKey) return sessionAliases[legacyAliasKey] || null;
  return legacyAliasKey ? sessionAliases[legacyAliasKey] : null;
}

function getEffectiveSessionTitle(id, sessionLike, options = {}) {
  const readThreadName = typeof options.readCodexThreadName === "function"
    ? options.readCodexThreadName
    : readCodexThreadName;
  if (sessionLike && sessionLike.agentId === "codex" && !sessionLike.host) {
    const threadName = normalizeTitle(readThreadName(id));
    if (threadName) return threadName;
  }
  return normalizeTitle(sessionLike && sessionLike.sessionTitle);
}

function sessionDisplayTitle(id, sessionLike, sessionAliases = {}, options = {}) {
  const alias = getSessionAliasEntry(id, sessionLike, sessionAliases);
  if (alias && typeof alias.title === "string" && alias.title) return alias.title;
  const title = getEffectiveSessionTitle(id, sessionLike, options);
  if (title) return title;
  const cwd = sessionLike && sessionLike.cwd;
  if (cwd) return path.basename(cwd);
  return id && id.length > 6 ? `${id.slice(0, 6)}..` : id;
}

function sessionMenuComparator(a, b, statePriority = {}) {
  const pa = statePriority[a.state] || 0;
  const pb = statePriority[b.state] || 0;
  if (pb !== pa) return pb - pa;
  return sessionUpdatedAt(b) - sessionUpdatedAt(a);
}

function sessionUpdatedAtComparator(a, b) {
  const byTime = sessionUpdatedAt(b) - sessionUpdatedAt(a);
  if (byTime !== 0) return byTime;
  return String(a.id).localeCompare(String(b.id));
}

function buildSessionSnapshotEntry(id, session, sessionAliases = {}, options = {}) {
  const alias = getSessionAliasEntry(id, session, sessionAliases);
  const recentEvents = Array.isArray(session && session.recentEvents)
    ? session.recentEvents
    : [];
  const latestEvent = recentEvents.length ? recentEvents[recentEvents.length - 1] : null;
  const rawEvent = latestEvent && latestEvent.event ? latestEvent.event : null;
  const eventAt = Number(latestEvent && latestEvent.at);
  const badge = deriveSessionBadge(session);
  const getAgentIconUrl = typeof options.getAgentIconUrl === "function"
    ? options.getAgentIconUrl
    : () => null;
  const state = (session && session.state) || "idle";
  const hiddenFromHud = shouldAutoClearDetachedSession(session, badge, options);
  const focusTarget = session && !session.headless && state !== "sleeping" && !hiddenFromHud
    ? getSessionFocusTarget({ ...(session || {}), id })
    : { canFocus: false, type: null, url: null };
  return {
    id,
    agentId: (session && session.agentId) || null,
    iconUrl: getAgentIconUrl(session && session.agentId),
    state,
    badge,
    hiddenFromHud,
    hasAlias: !!(alias && typeof alias.title === "string" && alias.title),
    sessionTitle: getEffectiveSessionTitle(id, session, options),
    displayTitle: sessionDisplayTitle(id, session, sessionAliases, options),
    cwd: (session && session.cwd) || "",
    updatedAt: sessionUpdatedAt(session),
    sourcePid: (session && session.sourcePid) || null,
    canFocus: focusTarget.canFocus === true,
    focusTarget: focusTarget.type ? { type: focusTarget.type, url: focusTarget.url || null } : null,
    host: (session && session.host) || null,
    headless: !!(session && session.headless),
    platform: (session && session.platform) || null,
    model: (session && session.model) || null,
    provider: (session && session.provider) || null,
    codexOriginator: (session && session.codexOriginator) || null,
    codexSource: (session && session.codexSource) || null,
    lastEvent: latestEvent ? {
      labelKey: rawEvent ? (EVENT_LABEL_KEYS[rawEvent] || null) : null,
      rawEvent,
      at: Number.isFinite(eventAt) ? eventAt : 0,
    } : null,
  };
}

function normalizeSessionsIterable(sessions) {
  if (!sessions) return [];
  if (sessions instanceof Map) return sessions.entries();
  if (typeof sessions[Symbol.iterator] === "function") return sessions;
  return [];
}

function buildSessionSnapshot(sessions, options = {}) {
  const entries = [];
  const sessionAliases = options.sessionAliases && typeof options.sessionAliases === "object"
    ? options.sessionAliases
    : {};
  for (const [id, session] of normalizeSessionsIterable(sessions)) {
    entries.push(buildSessionSnapshotEntry(id, session, sessionAliases, options));
  }

  const dashboardEntries = entries.slice().sort(sessionUpdatedAtComparator);
  const menuEntries = entries.slice().sort((a, b) => sessionMenuComparator(a, b, options.statePriority));
  const orderedIds = dashboardEntries.map((entry) => entry.id);
  const menuOrderedIds = menuEntries.map((entry) => entry.id);
  const hudEntries = dashboardEntries.filter((entry) =>
    !entry.headless && entry.state !== "sleeping" && !entry.hiddenFromHud
  );

  const groupMap = new Map();
  for (const entry of dashboardEntries) {
    const host = entry.host || "";
    if (!groupMap.has(host)) groupMap.set(host, []);
    groupMap.get(host).push(entry.id);
  }
  const groups = [];
  if (groupMap.has("")) {
    groups.push({ host: "", ids: groupMap.get("") });
  }
  for (const [host, ids] of groupMap) {
    if (!host) continue;
    groups.push({ host, ids });
  }

  const lastSession = dashboardEntries[0] || null;
  return {
    sessions: entries,
    groups,
    orderedIds,
    menuOrderedIds,
    hudTotalNonIdle: hudEntries.length,
    hudLastSessionId: hudEntries.length ? hudEntries[0].id : null,
    hudLastTitle: hudEntries.length ? hudEntries[0].displayTitle : null,
    lastSessionId: lastSession ? lastSession.id : null,
    lastTitle: lastSession ? lastSession.displayTitle : null,
  };
}

function getActiveSessionAliasKeys(sessions) {
  const keys = new Set();
  for (const [id, session] of normalizeSessionsIterable(sessions)) {
    const key = sessionAliasKey(
      session && session.host,
      session && session.agentId,
      id,
      { cwd: session && session.cwd }
    );
    if (key) keys.add(key);
  }
  return keys;
}

function sessionSnapshotSignature(snapshot) {
  return JSON.stringify({
    orderedIds: snapshot.orderedIds,
    menuOrderedIds: snapshot.menuOrderedIds,
    hudTotalNonIdle: snapshot.hudTotalNonIdle,
    hudLastSessionId: snapshot.hudLastSessionId,
    hudLastTitle: snapshot.hudLastTitle,
    lastSessionId: snapshot.lastSessionId,
    lastTitle: snapshot.lastTitle,
    sessions: snapshot.sessions.map((entry) => ({
      id: entry.id,
      state: entry.state,
      badge: entry.badge,
      hasAlias: entry.hasAlias,
      sessionTitle: entry.sessionTitle,
      displayTitle: entry.displayTitle,
      cwd: entry.cwd,
      agentId: entry.agentId,
      sourcePid: entry.sourcePid,
      canFocus: entry.canFocus,
      focusTarget: entry.focusTarget,
      headless: entry.headless,
      hiddenFromHud: !!entry.hiddenFromHud,
      host: entry.host,
      platform: entry.platform,
      model: entry.model,
      provider: entry.provider,
      codexOriginator: entry.codexOriginator,
      codexSource: entry.codexSource,
      lastEventLabelKey: entry.lastEvent ? entry.lastEvent.labelKey : null,
      lastEventRawEvent: entry.lastEvent ? entry.lastEvent.rawEvent : null,
      lastEventAt: entry.lastEvent ? entry.lastEvent.at : null,
    })),
  });
}

module.exports = {
  EVENT_LABEL_KEYS,
  SESSION_TITLE_MAX,
  normalizeTitle,
  sessionUpdatedAt,
  deriveSessionBadge,
  shouldAutoClearDetachedSession,
  getSessionAliasEntry,
  getEffectiveSessionTitle,
  sessionDisplayTitle,
  sessionMenuComparator,
  sessionUpdatedAtComparator,
  buildSessionSnapshotEntry,
  buildSessionSnapshot,
  getActiveSessionAliasKeys,
  sessionSnapshotSignature,
};
