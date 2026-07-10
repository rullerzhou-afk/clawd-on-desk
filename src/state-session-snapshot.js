"use strict";

const path = require("path");
const { sessionAliasKey } = require("./session-alias");
const { getSessionFocusTarget } = require("./session-focus");
const {
  buildLatestLocalCodexProcessIds,
  isSupersededLocalCodexProcessSession,
} = require("./state-session-dedupe");
const { readCodexThreadName } = require("../hooks/codex-session-index");
const { normalizeQuotaGroup } = require("../hooks/quota-bucket");
const { ANTIGRAVITY_QUOTA_FIELDS } = require("../hooks/antigravity-context-usage");
const { CLAUDE_QUOTA_FIELDS } = require("../hooks/claude-rate-limits");

// ── Session source derivation ────────────────────────────────────────

const WSL_HOST_PREFIX = "wsl:";

function deriveSourceInfo(host) {
  if (typeof host === "string" && host.startsWith(WSL_HOST_PREFIX)) {
    const distro = host.slice(WSL_HOST_PREFIX.length) || "unknown";
    return {
      sourceType: "wsl",
      sourceLabel: distro,
      displayLabel: `WSL: ${distro}`,
    };
  }
  if (typeof host === "string" && host && host !== "local") {
    return {
      sourceType: "ssh",
      sourceLabel: host,
      displayLabel: host,
    };
  }
  return {
    sourceType: "local",
    sourceLabel: "",
    displayLabel: "",
  };
}

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
  ApiError: "eventLabelApiError",
  SubagentStart: "eventLabelSubagentStart",
  SubagentStop: "eventLabelSubagentStop",
  PreCompress: "eventLabelPreCompress",
  PreCompact: "eventLabelPreCompact",
  PostCompact: "eventLabelPostCompact",
  Notification: "eventLabelNotification",
  Elicitation: "eventLabelElicitation",
  WorktreeCreate: "eventLabelWorktreeCreate",
  "event_msg:task_complete": "eventLabelStop",
  "stale-cleanup": "eventLabelStaleCleanup",
};

// PostCompact intentionally excluded (#406): compaction finishing is not turn
// completion, so it must not raise the "done" badge.
const DONE_EVENTS = new Set(["Stop", "event_msg:task_complete"]);

function isDoneEvent(event) {
  return DONE_EVENTS.has(event);
}

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

// A persisted session counts as "in progress" when it is non-headless and its
// stored state is anything other than idle/sleeping (mirrors deriveSessionBadge's
// "running" semantics). One-shot visuals like attention/notification are
// normally stored as idle by updateSession(); permission prompts stay awake by
// preserving the prior working/thinking state.
function isSessionInProgress(session) {
  if (!session || session.headless) return false;
  if (session.state === "idle" || session.state === "sleeping") return false;
  return true;
}

function deriveSessionBadge(session) {
  if (!session) return "idle";
  if (session.state !== "idle" && session.state !== "sleeping") return "running";
  if (session.state === "sleeping") return "idle";
  if (session.requiresCompletionAck === true) return "done";
  const events = Array.isArray(session.recentEvents) ? session.recentEvents : [];
  const latest = events.length ? events[events.length - 1] : null;
  const latestEvent = latest && latest.event;
  if (latestEvent === "StopFailure" || latestEvent === "PostToolUseFailure" || latestEvent === "ApiError") return "interrupted";
  if (isDoneEvent(latestEvent)) return "done";
  return "idle";
}

function getDisplayLastEvent(session, recentEvents) {
  const latestEvent = recentEvents.length ? recentEvents[recentEvents.length - 1] : null;
  if (!(session && session.requiresCompletionAck === true)) return latestEvent;
  for (let i = recentEvents.length - 1; i >= 0; i--) {
    const event = recentEvents[i];
    if (event && isDoneEvent(event.event)) return event;
  }
  return latestEvent;
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
  if (cwd && typeof cwd === "string") {
    // Skip the cwd fallback only for QoderWork sessions running inside a
    // QoderWork internal workspace (~/.qoderwork/workspace/<id>) — the raw
    // workspace ID like "mqgw60jiigjsjcid" is meaningless to the user. Other
    // agents keep the basename fallback even under that path.
    const isQoderWorkSession = (sessionLike && sessionLike.agentId === "qoderwork")
      || (typeof id === "string" && id.startsWith("qoderwork:"));
    const isQoderWorkWorkspaceCwd = /\/\.qoderwork\/workspace\/[^/]+$/.test(cwd.replace(/\\/g, "/"));
    if (!(isQoderWorkSession && isQoderWorkWorkspaceCwd)) {
      return path.basename(cwd);
    }
  }
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
  const latestEvent = getDisplayLastEvent(session, recentEvents);
  const rawEvent = latestEvent && latestEvent.event ? latestEvent.event : null;
  const eventAt = Number(latestEvent && latestEvent.at);
  const badge = deriveSessionBadge(session);
  const getAgentIconUrl = typeof options.getAgentIconUrl === "function"
    ? options.getAgentIconUrl
    : () => null;
  const state = (session && session.state) || "idle";
  const hiddenFromHud = shouldAutoClearDetachedSession(session, badge, options)
    || isSupersededLocalCodexProcessSession(id, session, options.latestLocalCodexProcessIds);
  const focusTarget = session && !session.headless && state !== "sleeping" && !hiddenFromHud
    ? getSessionFocusTarget({ ...(session || {}), id }, {
      osPlatform: options.focusHostPlatform || options.osPlatform,
    })
    : { canFocus: false, type: null, url: null };
  const source = deriveSourceInfo(session && session.host);
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
    // Quota/context freshness (statusline metadata POSTs, which do not bump
    // updatedAt). Excluded from sessionSnapshotSignature, like updatedAt.
    metadataUpdatedAt: (session && Number.isFinite(session.metadataUpdatedAt)) ? session.metadataUpdatedAt : null,
    sourcePid: (session && session.sourcePid) || null,
    wtHwnd: (session && session.wtHwnd) || null,
    editor: (session && session.editor) || null,
    canFocus: focusTarget.canFocus === true,
    focusTarget: focusTarget.type ? { type: focusTarget.type, url: focusTarget.url || null } : null,
    host: (session && session.host) || null,
    wslDistro: (session && session.wslDistro) || null,
    sourceType: source.sourceType,
    sourceLabel: source.sourceLabel,
    sourceDisplayLabel: source.displayLabel,
    headless: !!(session && session.headless),
    platform: (session && session.platform) || null,
    model: (session && session.model) || null,
    provider: (session && session.provider) || null,
    codexOriginator: (session && session.codexOriginator) || null,
    codexSource: (session && session.codexSource) || null,
    contextUsage: snapshotContextUsage(session),
    antigravityQuota: normalizeQuotaGroup(session && session.antigravityQuota, ANTIGRAVITY_QUOTA_FIELDS),
    claudeQuota: normalizeQuotaGroup(session && session.claudeQuota, CLAUDE_QUOTA_FIELDS),
    assistantLastOutput: (session && typeof session.assistantLastOutput === "string")
      ? session.assistantLastOutput
      : null,
    assistantLastOutputTruncated: !!(session && session.assistantLastOutputTruncated === true),
    lastEvent: latestEvent ? {
      labelKey: rawEvent ? (EVENT_LABEL_KEYS[rawEvent] || null) : null,
      rawEvent,
      at: Number.isFinite(eventAt) ? eventAt : 0,
    } : null,
    // Lifecycle flag for the Dashboard "Mark read" button visibility (PR2).
    // ackedAt stays internal — only the boolean reaches renderers.
    requiresCompletionAck: !!(session && session.requiresCompletionAck === true),
  };
}

function snapshotContextUsage(session) {
  const usage = session && session.contextUsage;
  if (!usage || typeof usage !== "object") return null;
  const used = Number(usage.used);
  if (!Number.isFinite(used) || used < 0) return null;
  const out = { used };
  const limit = Number(usage.limit);
  if (Number.isFinite(limit) && limit > 0) out.limit = limit;
  const percent = Number(usage.percent);
  if (Number.isFinite(percent)) out.percent = Math.max(0, Math.min(100, Math.round(percent)));
  if (usage.source === "claude" || usage.source === "codex" || usage.source === "antigravity") out.source = usage.source;
  return out;
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
  const latestLocalCodexProcessIds = buildLatestLocalCodexProcessIds(sessions);
  for (const [id, session] of normalizeSessionsIterable(sessions)) {
    entries.push(buildSessionSnapshotEntry(id, session, sessionAliases, {
      ...options,
      latestLocalCodexProcessIds,
    }));
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
    if (!groupMap.has(host)) {
      const displayHost = entry.sourceDisplayLabel || host;
      groupMap.set(host, { ids: [], displayHost });
    }
    groupMap.get(host).ids.push(entry.id);
  }
  const groups = [];
  if (groupMap.has("")) {
    const g = groupMap.get("");
    groups.push({ host: "", ids: g.ids, displayHost: "" });
  }
  for (const [host, g] of groupMap) {
    if (!host) continue;
    groups.push({ host, ids: g.ids, displayHost: g.displayHost });
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
      wtHwnd: entry.wtHwnd,
      canFocus: entry.canFocus,
      focusTarget: entry.focusTarget,
      headless: entry.headless,
      hiddenFromHud: !!entry.hiddenFromHud,
      host: entry.host,
      wslDistro: entry.wslDistro,
      platform: entry.platform,
      model: entry.model,
      provider: entry.provider,
      codexOriginator: entry.codexOriginator,
      codexSource: entry.codexSource,
      contextUsage: entry.contextUsage,
      antigravityQuota: entry.antigravityQuota,
      claudeQuota: entry.claudeQuota,
      assistantLastOutput: entry.assistantLastOutput,
      assistantLastOutputTruncated: !!entry.assistantLastOutputTruncated,
      lastEventLabelKey: entry.lastEvent ? entry.lastEvent.labelKey : null,
      lastEventRawEvent: entry.lastEvent ? entry.lastEvent.rawEvent : null,
      lastEventAt: entry.lastEvent ? entry.lastEvent.at : null,
      requiresCompletionAck: !!entry.requiresCompletionAck,
    })),
  });
}

module.exports = {
  EVENT_LABEL_KEYS,
  SESSION_TITLE_MAX,
  deriveSourceInfo,
  normalizeTitle,
  sessionUpdatedAt,
  isSessionInProgress,
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
