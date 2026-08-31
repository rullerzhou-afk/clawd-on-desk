"use strict";

const crypto = require("crypto");
const path = require("path");
const { sessionAliasKey } = require("./session-alias");
const { getSessionFocusTarget } = require("./session-focus");
const {
  buildLatestLocalCodexProcessIds,
  isSupersededLocalCodexProcessSession,
} = require("./state-session-dedupe");
const { readCodexThreadName } = require("../hooks/codex-session-index");

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

// Defense in depth for every agent title that reaches shared UI snapshots.
// Bidi formatting marks are not HTML injection, but can visually reorder and
// disguise filenames or commands even when renderers use textContent.
const SESSION_TITLE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u061C\u200E-\u200F\u202A-\u202E\u2066-\u2069]+/g;
const SESSION_TITLE_MAX = 80;

function replaceUnpairedSurrogates(value) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        result += value[index] + value[index + 1];
        index += 1;
      } else {
        result += "\uFFFD";
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      result += "\uFFFD";
    } else {
      result += value[index];
    }
  }
  return result;
}

function normalizeTitle(value) {
  if (typeof value !== "string") return null;
  const collapsed = replaceUnpairedSurrogates(value)
    .replace(SESSION_TITLE_CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return null;
  const characters = Array.from(collapsed);
  return characters.length > SESSION_TITLE_MAX
    ? `${characters.slice(0, SESSION_TITLE_MAX - 1).join("")}\u2026`
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
  const rawSessionId = (sessionLike && sessionLike.rawSessionId) || id;
  const scopedAliasKey = sessionAliasKey(
    sessionLike && sessionLike.host,
    sessionLike && sessionLike.agentId,
    rawSessionId,
    {
      cwd: sessionLike && sessionLike.cwd,
      profileId: sessionLike && sessionLike.profileId,
    }
  );
  if (scopedAliasKey && sessionAliases[scopedAliasKey]) return sessionAliases[scopedAliasKey];

  // Read-only fallback for aliases written before profile-scoped keys.
  const legacyAliasKey = sessionAliasKey(
    sessionLike && sessionLike.host,
    sessionLike && sessionLike.agentId,
    rawSessionId
  );
  if (legacyAliasKey && legacyAliasKey !== scopedAliasKey) return sessionAliases[legacyAliasKey] || null;
  return legacyAliasKey ? sessionAliases[legacyAliasKey] : null;
}

function getEffectiveSessionTitle(id, sessionLike, options = {}) {
  const readThreadName = typeof options.readCodexThreadName === "function"
    ? options.readCodexThreadName
    : readCodexThreadName;
  if (sessionLike && sessionLike.agentId === "codex" && !sessionLike.host) {
    const threadName = normalizeTitle(readThreadName((sessionLike && sessionLike.rawSessionId) || id));
    if (threadName) return threadName;
  }
  return normalizeTitle(sessionLike && sessionLike.sessionTitle);
}

// Agents whose sessions can run inside an app-managed workspace directory whose
// leaf is an opaque internal ID (e.g. "mqgw60jiigjsjcid"). For those, the
// cwd basename fallback below would put that ID in the HUD, Dashboard
// and session menu, so it is skipped and the shortened session id wins instead.
//
// Deliberately an agent↔path PAIRING, not two independent checks: the pattern
// only suppresses the basename when the session actually belongs to that agent.
// Another agent working inside the same directory keeps its basename, because
// for it that directory is just an ordinary cwd the user chose.
//
// `agentId` is the reliable signal; `sessionPrefix` covers snapshot shapes that
// carry only the namespaced session id (older persisted sessions, and menu
// callers that pass an id without the full session object).
const INTERNAL_WORKSPACE_AGENTS = Object.freeze([
  Object.freeze({
    agentId: "qoderwork",
    sessionPrefix: "qoderwork:",
    // ~/.qoderwork/workspace/<id>
    cwdPattern: /\/\.qoderwork\/workspace\/[^/]+$/,
  }),
  Object.freeze({
    agentId: "qwenwork",
    sessionPrefix: "qwenwork:",
    // ~/.QwenWorkCN/workspace/<id> — the directory is created case-preserving
    // as ".QwenWorkCN". Windows and default macOS volumes are commonly
    // case-insensitive, while macOS can also use case-sensitive APFS; accept
    // spelling variants without making filesystem sensitivity an assumption.
    cwdPattern: /\/\.qwenworkcn\/workspace\/[^/]+$/i,
  }),
]);

function isInternalWorkspaceCwd(id, sessionLike, cwd) {
  const agentId = sessionLike && sessionLike.agentId;
  // Hook payloads are not required to normalize cwd. Strip one or more
  // trailing separators before matching so an opaque workspace leaf is not
  // exposed merely because QwenWork/QoderWork reported a directory form.
  const posixCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  for (const entry of INTERNAL_WORKSPACE_AGENTS) {
    const belongsToAgent = agentId === entry.agentId
      || (!agentId && typeof id === "string" && id.startsWith(entry.sessionPrefix));
    if (!belongsToAgent) continue;
    if (entry.cwdPattern.test(posixCwd)) return true;
  }
  return false;
}

// Display-only folder label shared by every snapshot consumer. Keep the raw
// cwd on the snapshot for focus/open-folder actions, but do not make each UI or
// outbound integration rediscover which agent-owned workspace leaves are
// opaque implementation ids.
function sessionDisplayFolder(id, sessionLike) {
  const cwd = sessionLike && sessionLike.cwd;
  if (!cwd || typeof cwd !== "string" || isInternalWorkspaceCwd(id, sessionLike, cwd)) {
    return "";
  }
  // Session metadata can cross operating-system boundaries (for example a
  // Windows agent reported to a macOS/Linux Clawd). Select the path dialect
  // from the value instead of the host, while preserving backslashes that
  // are legal characters in a POSIX path component.
  const windowsPath = /^[A-Za-z]:[\\/]/.test(cwd) || /^([\\/])\1/.test(cwd);
  const cwdBasename = windowsPath
    ? path.win32.basename(cwd)
    : path.posix.basename(cwd);
  return cwdBasename || "";
}

function shortenSessionIdForDisplay(value, sessionLike) {
  if (value === null || value === undefined) return value;
  let displayId = String(value);
  const agentId = sessionLike && sessionLike.agentId;
  for (const entry of INTERNAL_WORKSPACE_AGENTS) {
    if (!displayId.startsWith(entry.sessionPrefix)) continue;
    if (agentId && agentId !== entry.agentId) continue;
    const stripped = displayId.slice(entry.sessionPrefix.length);
    // Placeholder ids can arrive as the bare namespace (for example when an
    // adapter reports only whitespace and the server trims it). Keep the
    // namespace fallback instead of turning the display title into an empty
    // string that leaks the long canonical session key into UI consumers.
    if (stripped.trim()) displayId = stripped;
    break;
  }
  return displayId.length > 6 ? `${displayId.slice(0, 6)}..` : displayId;
}

function buildDisplaySessionTag(canonicalSessionId) {
  if (typeof canonicalSessionId !== "string") return "";
  const trimmed = canonicalSessionId.trim();
  if (!trimmed) return "";
  return crypto.createHash("sha256").update(trimmed).digest("hex").slice(0, 10);
}

function getEntryDisplaySessionTag(entry) {
  if (entry && typeof entry.displaySessionTag === "string" && entry.displaySessionTag) {
    return entry.displaySessionTag;
  }
  return buildDisplaySessionTag(entry && entry.id);
}

function sessionDisplayTitle(id, sessionLike, sessionAliases = {}, options = {}) {
  const alias = getSessionAliasEntry(id, sessionLike, sessionAliases);
  if (alias && typeof alias.title === "string" && alias.title) return alias.title;
  const title = getEffectiveSessionTitle(id, sessionLike, options);
  if (title) return title;
  const folder = sessionDisplayFolder(id, sessionLike);
  if (folder) return folder;
  const rawSessionId = (sessionLike && sessionLike.rawSessionId) || id;
  return shortenSessionIdForDisplay(rawSessionId, sessionLike);
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
  const resolveAgentDisplayName = typeof options.resolveAgentDisplayName === "function"
    ? options.resolveAgentDisplayName
    : () => "";
  const agentId = (session && session.agentId) || null;
  const state = (session && session.state) || "idle";
  const hiddenFromHud = shouldAutoClearDetachedSession(session, badge, options)
    || isSupersededLocalCodexProcessSession(id, session, options.latestLocalCodexProcessIds);
  const startupRecovered = !!(session && session.startupRecovered === true);
  const focusTarget = session && !session.headless && !startupRecovered && state !== "sleeping" && !hiddenFromHud
    ? getSessionFocusTarget({ ...(session || {}), id }, {
      osPlatform: options.focusHostPlatform || options.osPlatform,
    })
    : { canFocus: false, type: null, url: null };
  const source = deriveSourceInfo(session && session.host);
  const automationRecord = options.sessionAutomationRecord || null;
  const automationIdentity = session && session.sessionAutomationIdentity;
  const canConfigureSessionAutomation = !!(
    automationIdentity
    && automationIdentity.eligible === true
    && agentId
  );
  const globalAutomationMode = options.permissionAutomationMode === "auto-tools"
    || options.permissionAutomationMode === "unattended"
    ? options.permissionAutomationMode
    : "off";
  return {
    id,
    profileId: (session && session.profileId) || "local",
    rawSessionId: (session && session.rawSessionId) || id,
    displaySessionTag: buildDisplaySessionTag(id),
    agentId,
    agentName: resolveAgentDisplayName(agentId),
    iconUrl: getAgentIconUrl(agentId),
    state,
    startupRecovered,
    badge,
    hiddenFromHud,
    hasAlias: !!(alias && typeof alias.title === "string" && alias.title),
    sessionTitle: getEffectiveSessionTitle(id, session, options),
    displayTitle: sessionDisplayTitle(id, session, sessionAliases, options),
    displayFolder: sessionDisplayFolder(id, session),
    cwd: (session && session.cwd) || "",
    updatedAt: sessionUpdatedAt(session),
    // Quota/context freshness (statusline metadata POSTs, which do not bump
    // updatedAt). Excluded from sessionSnapshotSignature, like updatedAt.
    metadataUpdatedAt: (session && Number.isFinite(session.metadataUpdatedAt)) ? session.metadataUpdatedAt : null,
    sourcePid: (session && session.sourcePid) || null,
    wtHwnd: (session && session.wtHwnd) || null,
    editor: (session && session.editor) || null,
    // Beside editor because it feeds the same decision: both mark a host whose
    // terminal-tab switch lands after the window focus is confirmed, which
    // src/telegram-direct-send.js has to wait out before pasting.
    orcaPaneKey: (session && session.orcaPaneKey) || null,
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
    sessionAutomationMode: automationRecord ? automationRecord.mode : null,
    sessionAutomationGrantId: automationRecord ? automationRecord.grantId : null,
    sessionAutomationEffectiveMode: automationRecord
      ? automationRecord.mode
      : globalAutomationMode,
    canConfigureSessionAutomation,
    sessionAutomationDisabledReason: canConfigureSessionAutomation
      ? null
      : (
          automationIdentity && typeof automationIdentity.reason === "string"
            ? automationIdentity.reason
            : "identity-not-verified"
        ),
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
  if (usage.source === "claude" || usage.source === "codex" || usage.source === "antigravity" || usage.source === "opencode") out.source = usage.source;
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
  const automationRecords = Array.isArray(options.sessionAutomationRecords)
    ? options.sessionAutomationRecords
    : [];
  const automationByIdentity = new Map(automationRecords.map((record) => [
    `${record.agentId}\u0000${record.sessionId}`,
    record,
  ]));
  const matchedAutomationGrantIds = new Set();
  for (const [id, session] of normalizeSessionsIterable(sessions)) {
    const automationRecord = automationByIdentity.get(
      `${session && session.agentId ? session.agentId : ""}\u0000${id}`
    ) || null;
    if (automationRecord) matchedAutomationGrantIds.add(automationRecord.grantId);
    entries.push(buildSessionSnapshotEntry(id, session, sessionAliases, {
      ...options,
      latestLocalCodexProcessIds,
      sessionAutomationRecord: automationRecord,
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
    // Session-independent per-source account quota (src/state-account-quota.js).
    // Injected by the caller so this module stays a pure sessions mapper.
    // Deep-cloned at this boundary: the snapshot must stay immutable even if
    // a caller retains and mutates the array it passed in (the store's own
    // snapshot() already clones, but this API must not depend on that).
    accountQuota: Array.isArray(options.accountQuota)
      ? JSON.parse(JSON.stringify(options.accountQuota))
      : [],
    // Provider icons for the quota strip (same agent icons the session rows
    // use, resolved via the injected accessor). Static per run — excluded
    // from the snapshot signature.
    quotaAgentIcons: (() => {
      const iconFor = typeof options.getAgentIconUrl === "function"
        ? options.getAgentIconUrl
        : () => null;
      return {
        antigravityQuota: iconFor("antigravity-cli"),
        claudeQuota: iconFor("claude-code"),
        codexQuota: iconFor("codex"),
        kimiQuota: iconFor("kimi-cli"),
      };
    })(),
    sessionAutomationOrphans: automationRecords
      .filter((record) => !matchedAutomationGrantIds.has(record.grantId))
      .map((record) => ({
        agentId: record.agentId,
        sessionId: record.sessionId,
        mode: record.mode,
        sessionAutomationGrantId: record.grantId,
        displayLabel: record.displayLabel || record.sessionId.slice(-24),
        createdAt: record.createdAt,
      })),
  };
}

function getActiveSessionAliasKeys(sessions) {
  const keys = new Set();
  for (const [id, session] of normalizeSessionsIterable(sessions)) {
    const key = sessionAliasKey(
      session && session.host,
      session && session.agentId,
      (session && session.rawSessionId) || id,
      {
        cwd: session && session.cwd,
        profileId: session && session.profileId,
      }
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
    // Account quota participates as groups + lastSeenAt: updatedAt moves
    // exactly when its group changes (change-detected in the store) so it
    // would be redundant, but lastSeenAt is minute-quantized in the store
    // snapshot and is what keeps freshness labels honest for a reporter
    // that confirms unchanged numbers — its once-a-minute move must reach
    // the renderers, so it must move the signature too.
    accountQuota: (snapshot.accountQuota || []).map((entry) => ({
      host: entry.host,
      antigravityQuota: entry.antigravityQuota
        ? { group: entry.antigravityQuota.group, lastSeenAt: entry.antigravityQuota.lastSeenAt }
        : null,
      claudeQuota: entry.claudeQuota
        ? { group: entry.claudeQuota.group, lastSeenAt: entry.claudeQuota.lastSeenAt }
        : null,
      codexQuota: entry.codexQuota
        ? { group: entry.codexQuota.group, lastSeenAt: entry.codexQuota.lastSeenAt }
        : null,
      codexSparkQuota: entry.codexSparkQuota
        ? { group: entry.codexSparkQuota.group, lastSeenAt: entry.codexSparkQuota.lastSeenAt }
        : null,
      kimiQuota: entry.kimiQuota
        ? { group: entry.kimiQuota.group, lastSeenAt: entry.kimiQuota.lastSeenAt }
        : null,
    })),
    sessions: snapshot.sessions.map((entry) => ({
      id: entry.id,
      profileId: entry.profileId,
      rawSessionId: entry.rawSessionId,
      displaySessionTag: entry.displaySessionTag,
      state: entry.state,
      startupRecovered: !!entry.startupRecovered,
      badge: entry.badge,
      hasAlias: entry.hasAlias,
      sessionTitle: entry.sessionTitle,
      displayTitle: entry.displayTitle,
      displayFolder: entry.displayFolder,
      cwd: entry.cwd,
      agentId: entry.agentId,
      agentName: entry.agentName,
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
      assistantLastOutput: entry.assistantLastOutput,
      assistantLastOutputTruncated: !!entry.assistantLastOutputTruncated,
      lastEventLabelKey: entry.lastEvent ? entry.lastEvent.labelKey : null,
      lastEventRawEvent: entry.lastEvent ? entry.lastEvent.rawEvent : null,
      lastEventAt: entry.lastEvent ? entry.lastEvent.at : null,
      requiresCompletionAck: !!entry.requiresCompletionAck,
      sessionAutomationMode: entry.sessionAutomationMode,
      sessionAutomationGrantId: entry.sessionAutomationGrantId,
      sessionAutomationEffectiveMode: entry.sessionAutomationEffectiveMode,
      canConfigureSessionAutomation: entry.canConfigureSessionAutomation,
      sessionAutomationDisabledReason: entry.sessionAutomationDisabledReason,
    })),
    sessionAutomationOrphans: snapshot.sessionAutomationOrphans || [],
  });
}

module.exports = {
  EVENT_LABEL_KEYS,
  INTERNAL_WORKSPACE_AGENTS,
  SESSION_TITLE_MAX,
  isDoneEvent,
  deriveSourceInfo,
  normalizeTitle,
  sessionUpdatedAt,
  isSessionInProgress,
  deriveSessionBadge,
  shouldAutoClearDetachedSession,
  getSessionAliasEntry,
  getEffectiveSessionTitle,
  sessionDisplayFolder,
  sessionDisplayTitle,
  buildDisplaySessionTag,
  getEntryDisplaySessionTag,
  sessionMenuComparator,
  sessionUpdatedAtComparator,
  buildSessionSnapshotEntry,
  buildSessionSnapshot,
  getActiveSessionAliasKeys,
  sessionSnapshotSignature,
};
