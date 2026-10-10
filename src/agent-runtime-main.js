"use strict";

const DefaultCodexSubagentClassifier = require("../agents/codex-subagent-classifier");
const {
  buildCodexMonitorSessionOptions,
  normalizeCodexMonitorAccountQuotas,
  isCodexMonitorMetadataOnlyEvent,
} = require("./codex-monitor-callback");
const { resolveSessionIdentity } = require("./session-key");
const { bareCodexSessionId } = require("../hooks/codex-session-index");
const {
  CODEX_INTERNAL_THREAD_AMBIENT_SUGGESTIONS,
} = require("../hooks/codex-internal-worker");
const { digestCodexTurnId, normalizeCodexTurnId } = require("./codex-turn-id");
const createCodexTurnFence = require("./codex-turn-fence");
const createCodexOfficialActivity = require("./codex-official-activity");
const { createQoderSessionTitleTracker, QODER_TITLE_EVENTS } = require("./qoder-session-title");
const { createWorkBuddySessionTitleTracker } = require("./workbuddy-session-title");

const CODEX_OFFICIAL_LOG_SUPPRESS_TTL_MS = 10 * 60 * 1000;
// Intentionally excludes response_item:web_search_call. Codex official hooks
// do not cover WebSearch, so JSONL is its only lifecycle/tool boundary today.
// Keep this asymmetry under test: adding it here would silently drop web-search
// recap; upstream adding an official WebSearch hook requires a new dedupe path.
const CODEX_LOG_EVENTS_COVERED_BY_OFFICIAL_HOOKS = new Set([
  "session_meta",
  "event_msg:task_started",
  "event_msg:user_message",
  "event_msg:guardian_assessment",
  "response_item:function_call",
  "response_item:custom_tool_call",
  "event_msg:exec_command_end",
  "event_msg:patch_apply_end",
  "event_msg:custom_tool_call_output",
  "event_msg:task_complete",
]);

// Local Codex turns that are still in flight sit in one of these states. Kept in
// sync with isWorkingLikeState() in state-stale-cleanup.js.
const CODEX_WORKING_LIKE_STATES = new Set(["working", "thinking", "juggling"]);
const CODEX_TURN_CAPTURE_EVENTS = new Set([
  "UserPromptSubmit",
  "Stop",
  "Interrupt",
  "event_msg:task_started",
  "event_msg:task_complete",
  "event_msg:turn_aborted",
]);
// A JSONL poll can lag an official SessionEnd by seconds and still replay the
// tail of the turn it just retired. Tombstone the sessions an official
// SessionEnd actually deleted so those late rollout events cannot rebuild a
// row; the capacity mirrors the turn fence's session bound.
const MAX_CODEX_SESSION_END_TOMBSTONES = 200;
// Local Codex sids the hook recognized as hidden ambient-suggestion threads.
// Same bound as the SessionEnd tombstones; entries are active only across a
// thread's lifetime and are removed by its SessionEnd.
const MAX_CODEX_AMBIENT_SUGGESTION_SESSIONS = 200;

function createProfileScopedClassifier(classifier, profileId) {
  const canonicalSessionId = (sessionId) =>
    resolveSessionIdentity(sessionId, profileId).sessionId;
  return {
    registerSession(sessionId, input) {
      return classifier && typeof classifier.registerSession === "function"
        ? classifier.registerSession(canonicalSessionId(sessionId), input)
        : "unknown";
    },
    classify(sessionId) {
      return classifier && typeof classifier.classify === "function"
        ? classifier.classify(canonicalSessionId(sessionId))
        : "unknown";
    },
    clear(sessionId) {
      if (classifier && typeof classifier.clear === "function") {
        classifier.clear(canonicalSessionId(sessionId));
      }
    },
  };
}

function createAgentRuntimeMain(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const logWarn = typeof options.logWarn === "function" ? options.logWarn : console.warn;
  const debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};
  const loadCodexLogMonitor = options.loadCodexLogMonitor || (() => require("../agents/codex-log-monitor"));
  const loadCodexAgent = options.loadCodexAgent || (() => require("../agents/codex"));
  const codexSubagentClassifier = options.codexSubagentClassifier || new DefaultCodexSubagentClassifier();
  const localCodexSubagentClassifier = createProfileScopedClassifier(codexSubagentClassifier, "local");
  const getServer = options.getServer || (() => null);
  const getStateRuntime = options.getStateRuntime || (() => null);
  const getPermissionRuntime = options.getPermissionRuntime || (() => null);
  const isAgentEnabled = options.isAgentEnabled || (() => true);
  const updateSession = options.updateSession || (() => {});

  // ── Local WorkBuddy archive/delete retirement (#655) ────────────────────
  // WorkBuddy changes a conversation's lifecycle only in workbuddy.db, without
  // sending any hook, so a finished card would otherwise linger until the idle
  // timeout. The title observer spots that and hands the session here; late
  // lifecycle hooks are then re-checked against the database so an unarchived
  // chat can rebuild its card. Only local WorkBuddy is ever matched.
  const MAX_RETIRED_WORKBUDDY_SESSIONS = 256;
  // raw session id -> the home whose database decided the lifecycle, so a late
  // hook without a transcript path re-reads the same database.
  const retiredWorkBuddySessions = new Map();

  // The scope that decides whether an event belongs to a local WorkBuddy
  // conversation. Like localWorkBuddySession, it honors the fields the stored
  // session already carries (host / wslDistro / headless are sticky in state),
  // so a later event that omits them still resolves to the same scope.
  function workBuddyEventScope(sessionId, opts) {
    const state = getStateRuntime();
    const session = state && state.sessions && typeof state.sessions.get === "function"
      ? state.sessions.get(sessionId)
      : null;
    return {
      agentId: (opts && opts.agentId) || (session && session.agentId) || null,
      profileId: (opts && opts.profileId) || (session && session.profileId) || "local",
      host: (opts && opts.host) || (session && session.host) || null,
      wslDistro: (opts && opts.wslDistro) || (session && session.wslDistro) || null,
      headless: (opts && opts.headless === true) || !!(session && session.headless === true),
    };
  }

  function isLocalWorkBuddyScope(scope) {
    return !!(
      scope
      && scope.agentId === "workbuddy"
      && (scope.profileId || "local") === "local"
      && !scope.host
      && !scope.wslDistro
      && !scope.headless
    );
  }

  function rememberRetiredWorkBuddy(rawSessionId, lifecycleHome) {
    if (typeof rawSessionId !== "string" || !rawSessionId) return;
    retiredWorkBuddySessions.delete(rawSessionId);
    retiredWorkBuddySessions.set(rawSessionId, typeof lifecycleHome === "string" && lifecycleHome ? lifecycleHome : null);
    while (retiredWorkBuddySessions.size > MAX_RETIRED_WORKBUDDY_SESSIONS) {
      retiredWorkBuddySessions.delete(retiredWorkBuddySessions.keys().next().value);
    }
  }

  function clearRetiredWorkBuddySessions() {
    retiredWorkBuddySessions.clear();
  }

  function handleWorkBuddyRetired({ sessionId, rawSessionId, lifecycleHome } = {}) {
    rememberRetiredWorkBuddy(rawSessionId, lifecycleHome);
    const state = getStateRuntime();
    if (state && typeof state.dismissSession === "function" && sessionId) {
      state.dismissSession(sessionId);
    }
    debugLog(`workbuddy-archive retire sid=${String(rawSessionId || sessionId || "-").replace(/[\r\n]/g, "_")}`);
  }

  function shouldSuppressRetiredWorkBuddy(sessionId, rawSessionId, opts) {
    if (!isLocalWorkBuddyScope(workBuddyEventScope(sessionId, opts))) return false;
    const raw = typeof rawSessionId === "string" && rawSessionId ? rawSessionId : null;
    if (!raw || !retiredWorkBuddySessions.has(raw)) return false;
    let archived = null;
    if (workBuddySessionTitleTracker && typeof workBuddySessionTitleTracker.readArchived === "function") {
      try {
        archived = workBuddySessionTitleTracker.readArchived({
          rawSessionId: raw,
          cwd: opts && opts.cwd,
          transcriptPath: opts && opts.transcriptPath,
          lifecycleHome: retiredWorkBuddySessions.get(raw),
        });
      } catch {
        archived = null;
      }
    }
    // Still archived/deleted: drop the hook. Unarchived or unreadable: stop
    // suppressing so a revived conversation can rebuild its card.
    if (archived === true) return true;
    retiredWorkBuddySessions.delete(raw);
    return false;
  }

  const qoderSessionTitleTracker = options.qoderSessionTitleTracker
    || createQoderSessionTitleTracker();
  const workBuddySessionTitleTracker = options.workBuddySessionTitleTracker
    || createWorkBuddySessionTitleTracker({
      ...options.workBuddySessionTitleOptions,
      getSession: localWorkBuddySession,
      onRetired: handleWorkBuddyRetired,
      updateTitle(sessionId, title) {
        const state = getStateRuntime();
        if (state && typeof state.updateSessionMetadata === "function") {
          state.updateSessionMetadata(sessionId, { sessionTitle: title, expectedAgentId: "workbuddy" });
        }
      },
      updateContextUsage(sessionId, contextUsage) {
        const session = localWorkBuddySession(sessionId);
        const state = getStateRuntime();
        if (!session || !state || typeof state.updateSessionMetadata !== "function") return;
        if (contextUsage === null) {
          // Unknown native usage must not erase another telemetry source.
          if (session.contextUsageOrigin !== "workbuddy-native"
            || session.contextUsage?.source !== "workbuddy") return;
          state.updateSessionMetadata(sessionId, { clearContextUsage: true, expectedAgentId: "workbuddy" });
        } else {
          state.updateSessionMetadata(sessionId, {
            contextUsage, contextUsageOrigin: "workbuddy-native", expectedAgentId: "workbuddy",
          });
        }
      },
    });
  const captureGhosttyTerminalId = options.captureGhosttyTerminalId || null;
  const clearCodexNotifyBubbles = options.clearCodexNotifyBubbles || (() => {});
  const showCodexUserInputBubble = options.showCodexUserInputBubble || (() => false);
  const clearCodexUserInputBubbles = options.clearCodexUserInputBubbles || (() => {});
  // Narrow archive-specific lifecycle-end hook: revokes this session's
  // automation grant/candidate exactly like a real lifecycle end, without
  // faking SessionEnd into recap/completion. Wired by main.js to the session
  // automation coordinator.
  const onCodexArchiveLifecycleEnd = typeof options.onCodexArchiveLifecycleEnd === "function"
    ? options.onCodexArchiveLifecycleEnd
    : null;

  let codexMonitor = null;
  let disposed = false;
  const codexTurnFence = createCodexTurnFence({ now, debugLog });
  // Canonical session ids an official local Codex SessionEnd deleted. Bounded
  // FIFO: re-inserting refreshes recency, and the oldest entry is evicted once
  // the cap is exceeded.
  const codexSessionEndTombstones = new Set();

  function rememberCodexSessionEndTombstone(sessionId) {
    if (typeof sessionId !== "string" || !sessionId) return;
    codexSessionEndTombstones.delete(sessionId);
    codexSessionEndTombstones.add(sessionId);
    while (codexSessionEndTombstones.size > MAX_CODEX_SESSION_END_TOMBSTONES) {
      codexSessionEndTombstones.delete(codexSessionEndTombstones.values().next().value);
    }
  }

  function clearCodexSessionEndTombstone(sessionId) {
    codexSessionEndTombstones.delete(sessionId);
  }

  function hasCodexSessionEndTombstone(sessionId) {
    return codexSessionEndTombstones.has(sessionId);
  }

  // Canonical local Codex sids recognized as hidden ambient-suggestion threads.
  // Any official event from one is dropped (no row, no completion) until its
  // SessionEnd clears the entry. Bounded FIFO like the tombstones.
  const codexAmbientSuggestionSessions = new Set();

  function rememberCodexAmbientSuggestionSession(sessionId) {
    if (typeof sessionId !== "string" || !sessionId) return;
    codexAmbientSuggestionSessions.delete(sessionId);
    codexAmbientSuggestionSessions.add(sessionId);
    while (codexAmbientSuggestionSessions.size > MAX_CODEX_AMBIENT_SUGGESTION_SESSIONS) {
      codexAmbientSuggestionSessions.delete(codexAmbientSuggestionSessions.values().next().value);
    }
  }

  function forgetCodexAmbientSuggestionSession(sessionId) {
    codexAmbientSuggestionSessions.delete(sessionId);
  }

  function isCodexAmbientSuggestionSession(sessionId) {
    return codexAmbientSuggestionSessions.has(sessionId);
  }

  const codexOfficialActivity = createCodexOfficialActivity({
    now,
    debugLog,
    ttlMs: CODEX_OFFICIAL_LOG_SUPPRESS_TTL_MS,
  });

  function recordCodexTurnIdCapture(sessionId, source, event, turnId) {
    if (!CODEX_TURN_CAPTURE_EVENTS.has(event)) return;
    const digest = digestCodexTurnId(turnId);
    debugLog(
      `codex-turn-id sid=${String(sessionId || "-").replace(/[\r\n]/g, "_")}`
      + ` source=${source} event=${event} turn=${digest || "-"}`
    );
  }

  function markCodexOfficialHookSession(sessionId, turnId = null) {
    codexOfficialActivity.mark(sessionId, turnId);
  }

  function hasRecentCodexOfficialHookSession(sessionId, turnId = null) {
    return codexOfficialActivity.hasRecent(sessionId, turnId);
  }

  // ── Local Codex archive lifecycle (#655) ────────────────────────────────
  // Positive local archive evidence retires the live card/focus entry and
  // suppresses late lifecycle callbacks for that raw id until the archived file
  // disappears (unarchive). Remote profiles, WSL and other agents are never
  // matched even when their raw id collides. The tracker is independent of the
  // JSONL monitor so official-hook-only sessions are covered too.
  const loadCodexArchiveTracker = typeof options.loadCodexArchiveTracker === "function"
    ? options.loadCodexArchiveTracker
    : null;
  let codexArchiveTracker = options.codexArchiveTracker || null;

  function clearCodexSessionTracking(sessionId) {
    if (codexTurnFence && typeof codexTurnFence.clearSession === "function") {
      codexTurnFence.clearSession(sessionId);
    }
    if (codexOfficialActivity && typeof codexOfficialActivity.clearSession === "function") {
      codexOfficialActivity.clearSession(sessionId);
    }
  }

  function isLocalCodexSessionRecord(session) {
    return !!(
      session
      && session.agentId === "codex"
      && (session.profileId || "local") === "local"
      && !session.host
      && !session.wslDistro
    );
  }

  function collectLiveLocalCodexCandidates() {
    const state = getStateRuntime();
    const sessions = state && state.sessions;
    const out = [];
    if (!sessions || typeof sessions.forEach !== "function") return out;
    sessions.forEach((session, id) => {
      if (!isLocalCodexSessionRecord(session)) return;
      const raw = bareCodexSessionId(session.rawSessionId || id);
      if (raw) out.push(raw);
    });
    return out;
  }

  function retireArchivedCodexSession(sessionId) {
    const state = getStateRuntime();
    if (!state || typeof state.dismissSession !== "function") return false;
    // Narrow archive lifecycle end for this one session: revoke its automation
    // grant / cancel a pending trust candidate before any async authorization
    // can land. This is not a SessionEnd — no recap/completion is recorded.
    if (onCodexArchiveLifecycleEnd) {
      try {
        onCodexArchiveLifecycleEnd({
          agentId: "codex",
          sessionId,
          reason: "codex-session-archived",
        });
      } catch (err) {
        debugLog(`codex-archive automation-end failed sid=${sessionId} reason=${err && err.message}`);
      }
    }
    // Owned passive cards are cleared; any owned interactive prompt is handed
    // back with no-decision semantics scoped to this session only.
    clearCodexNotifyBubbles(sessionId, "codex-session-archived");
    clearCodexUserInputBubbles(sessionId, undefined, "codex-session-archived");
    const perm = getPermissionRuntime();
    if (perm && typeof perm.dismissPermissionsForSession === "function") {
      perm.dismissPermissionsForSession(sessionId, "codex-session-archived");
    }
    // Archive is not a completion: no sound, recap or completion push. Reset
    // per-session fence tombstones so a later unarchive + real turn resumes.
    clearCodexSessionTracking(sessionId);
    return state.dismissSession(sessionId) === true;
  }

  // A recognized ambient-suggestion thread must never keep a row — its prompts
  // are hidden background work, not the user's. If an earlier event opened one
  // before recognition landed, retire it like an archived task: dismiss without
  // a completion sound, recap entry or completion push.
  function dismissCodexAmbientSuggestionSession(sessionId) {
    const state = getStateRuntime();
    const sessions = state && state.sessions;
    const session = sessions && typeof sessions.get === "function" ? sessions.get(sessionId) : null;
    if (!isLocalCodexSessionRecord(session)) return false;
    clearCodexNotifyBubbles(sessionId, "codex-ambient-suggestions");
    clearCodexUserInputBubbles(sessionId, undefined, "codex-ambient-suggestions");
    const perm = getPermissionRuntime();
    if (perm && typeof perm.dismissPermissionsForSession === "function") {
      perm.dismissPermissionsForSession(sessionId, "codex-ambient-suggestions");
    }
    // Mirror archive retirement: reset per-session fence/activity so a reused
    // raw id is not shadowed by the retired row.
    clearCodexSessionTracking(sessionId);
    return typeof state.dismissSession === "function" && state.dismissSession(sessionId) === true;
  }

  function handleCodexArchiveConfirmed(rawArchiveId) {
    const state = getStateRuntime();
    const sessions = state && state.sessions;
    if (!sessions || typeof sessions.forEach !== "function") return false;
    const targets = [];
    sessions.forEach((session, id) => {
      if (!isLocalCodexSessionRecord(session)) return;
      const raw = bareCodexSessionId(session.rawSessionId || id);
      if (raw === rawArchiveId) targets.push(id);
    });
    let retired = false;
    for (const id of targets) {
      if (retireArchivedCodexSession(id)) retired = true;
    }
    return retired;
  }

  function ensureCodexArchiveTracker() {
    if (codexArchiveTracker) return codexArchiveTracker;
    if (typeof loadCodexArchiveTracker !== "function") return null;
    try {
      const createTracker = loadCodexArchiveTracker();
      const trackerOptions = options.codexArchiveOptions
        && typeof options.codexArchiveOptions === "object"
        ? options.codexArchiveOptions
        : {};
      codexArchiveTracker = createTracker({
        debugLog,
        now,
        getLiveCandidateIds: collectLiveLocalCodexCandidates,
        onArchiveConfirmed: handleCodexArchiveConfirmed,
        ...trackerOptions,
      });
    } catch (err) {
      logWarn("Clawd: Codex archive tracker not started:", err && err.message);
      codexArchiveTracker = null;
    }
    return codexArchiveTracker;
  }

  function startCodexArchiveTracker() {
    if (disposed) return null;
    const tracker = ensureCodexArchiveTracker();
    if (tracker && typeof tracker.start === "function") tracker.start();
    return tracker;
  }

  function stopCodexArchiveTracker() {
    if (codexArchiveTracker && typeof codexArchiveTracker.stop === "function") {
      codexArchiveTracker.stop();
    }
  }

  function shouldSuppressCodexArchive(rawSessionId, opts = {}) {
    if (!codexArchiveTracker || typeof codexArchiveTracker.isArchived !== "function") return false;
    if (!opts || opts.agentId !== "codex") return false;
    if ((opts.profileId || "local") !== "local") return false;
    if (opts.host || opts.wslDistro) return false;
    const raw = bareCodexSessionId(rawSessionId);
    if (!raw) return false;
    return codexArchiveTracker.isArchived(raw) === true;
  }

  // JSONL fallback rescue. Official Codex hooks normally emit a Stop that closes
  // the turn, so the matching JSONL event_msg:task_complete is suppressed as a
  // duplicate. But when the official Stop never arrives, the session stays stuck
  // working-like while the rollout JSONL still records task_complete. Let that one
  // JSONL completion through to close the turn — only for a local (non-remote,
  // non-headless) Codex session the state runtime still shows as working-like.
  // Once Stop (or this very fallback) idles the session it is no longer
  // working-like, so a later duplicate task_complete is suppressed again and we
  // avoid double done/celebration.
  function shouldAllowCodexJsonlCompletionFallback(sessionId, state, event, turnId, extra) {
    if (event !== "event_msg:task_complete") return false;
    // codex-log-monitor only resolves task_complete to a completion state.
    if (state !== "attention" && state !== "idle") return false;
    const stateRuntime = getStateRuntime();
    const sessions = stateRuntime && stateRuntime.sessions;
    const session = sessions && typeof sessions.get === "function" ? sessions.get(sessionId) : null;
    if (!isLocalCodexSessionRecord(session) || session.headless) return false;
    return CODEX_WORKING_LIKE_STATES.has(session.state)
      || (typeof stateRuntime.hasCodexCompactionHold === "function"
        && stateRuntime.hasCodexCompactionHold(sessionId, {
          turnId, occurredAt: extra && extra.recapOccurredAt,
        }));
  }

  function shouldSuppressCodexLogEvent(sessionId, state, event, turnId = null, extra = null) {
    // Some Codex builds encode WebSearch as a generic function_call. Official
    // hooks do not expose that boundary, so keep this privacy-safe monitor bit
    // on the same fallback path as response_item:web_search_call.
    if (event === "response_item:function_call" && extra && extra.recapIsWebSearch === true) return false;
    if (!CODEX_LOG_EVENTS_COVERED_BY_OFFICIAL_HOOKS.has(event)) return false;
    if (!hasRecentCodexOfficialHookSession(sessionId, turnId)) return false;
    if (shouldAllowCodexJsonlCompletionFallback(sessionId, state, event, turnId, extra)) return false;
    return true;
  }

  function isCodexWebSearchLogBoundary(event, extra) {
    return event === "response_item:web_search_call"
      || (event === "response_item:function_call" && extra && extra.recapIsWebSearch === true);
  }

  // Mirrors the turn fence's start rule: only an explicit task_started, or a
  // synthetic backfill that opens a turn boundary with a turn id, is a new
  // turn. Any other rollout event belongs to the session an official
  // SessionEnd already retired.
  function isCodexJsonlTurnStart(event, extra) {
    if (event === "event_msg:task_started") return true;
    return !!(
      extra
      && extra.syntheticBackfill === true
      && extra.turnBoundaryOpen === true
      && normalizeCodexTurnId(extra.turnId)
    );
  }

  function recordCodexWebSearchRecapOnly(sessionIdentity, sessionOptions, event, extra) {
    if (
      !isCodexWebSearchLogBoundary(event, extra)
      || sessionOptions.recapSuppressed === true
      || !Number.isSafeInteger(sessionOptions.recapOccurredAt)
    ) return false;
    const stateRuntime = getStateRuntime();
    if (!stateRuntime || typeof stateRuntime.recordRecapEventOnly !== "function") return false;
    return stateRuntime.recordRecapEventOnly({
      occurredAt: sessionOptions.recapOccurredAt,
      sessionId: sessionIdentity.sessionId,
      rawSessionId: sessionIdentity.rawSessionId,
      agentId: "codex",
      profileId: sessionIdentity.profileId,
      event,
      toolUseId: sessionOptions.toolUseId || null,
      recapDedupeId: sessionOptions.recapDedupeId || null,
      recapIsSubagent: sessionOptions.recapIsSubagent === true,
      headless: sessionOptions.headless === true,
      hookSource: "codex-jsonl",
    });
  }

  function updateSessionFromServer(sessionId, state, event, opts = {}) {
    // Late official hooks for a locally archived task must not recreate an
    // entry. Scoped to the local profile only; remote/WSL are never matched.
    // Decision-bearing permission prompts never reach here for an archived
    // task: the /permission route returns no-decision before any bubble, state
    // or automation is created, so this gate is only a second line of defense.
    if (shouldSuppressCodexArchive(opts && opts.rawSessionId ? opts.rawSessionId : sessionId, {
      agentId: opts && opts.agentId,
      profileId: opts && opts.profileId,
      host: opts && opts.host,
      wslDistro: opts && opts.wslDistro,
    })) {
      return false;
    }
    // A locally archived/deleted WorkBuddy conversation emits no hook, but a
    // late one may still arrive; re-read workbuddy.db and only drop it while
    // the row is still archived/deleted.
    if (shouldSuppressRetiredWorkBuddy(
      sessionId,
      opts && opts.rawSessionId ? opts.rawSessionId : sessionId,
      opts,
    )) {
      return false;
    }
    const isLocalOfficialCodexEvent = !!(opts
      && opts.agentId === "codex"
      && opts.hookSource === "codex-official"
      && opts.profileId === "local"
      && !opts.host
      && !opts.wslDistro);
    if (isLocalOfficialCodexEvent) {
      if (opts.codexInternalThread === CODEX_INTERNAL_THREAD_AMBIENT_SUGGESTIONS) {
        // Hidden ambient-suggestion work: remember the sid so later official
        // events are dropped too, and retire any row opened before recognition.
        rememberCodexAmbientSuggestionSession(sessionId);
        dismissCodexAmbientSuggestionSession(sessionId);
        debugLog(`codex-ambient-suggestions recognize sid=${String(sessionId || "-").replace(/[\r\n]/g, "_")}`);
        return false;
      }
      if (isCodexAmbientSuggestionSession(sessionId)) {
        // A recognized thread must not open a row from any of its other events.
        // Its SessionEnd clears the entry and then flows through normally (a
        // no-op without a row).
        if (event === "SessionEnd") {
          forgetCodexAmbientSuggestionSession(sessionId);
        } else {
          return false;
        }
      }
    }
    if (opts && opts.agentId === "codex" && opts.hookSource === "codex-official") {
      markCodexOfficialHookSession(sessionId, opts.turnId);
      if (opts.profileId === "local") {
        recordCodexTurnIdCapture(sessionId, "official", event, opts.turnId);
        const fenceDecision = codexTurnFence.observe({
          sessionId,
          source: "official",
          event,
          state,
          turnId: opts.turnId,
        });
        if (!fenceDecision.accept) {
          if (fenceDecision.reason === "duplicate-terminal") {
            const stateRuntime = getStateRuntime();
            stateRuntime?.releaseCodexCompactionOnTerminal?.(sessionId, event, {
              turnId: opts.turnId, occurredAt: now(),
            });
          }
          return false;
        }
        // A fresh official lifecycle proves the same raw id is live again, so
        // release the tombstone left by an earlier SessionEnd — the new turn's
        // rollout must be able to rebuild the row.
        if (event === "SessionStart" || event === "UserPromptSubmit") {
          clearCodexSessionEndTombstone(sessionId);
        }
      }
    }
    const stateRuntime = getStateRuntime();
    const sessions = stateRuntime && stateRuntime.sessions;
    const sessionBeforeUpdate = event === "SessionEnd" && sessions && typeof sessions.get === "function"
      ? sessions.get(sessionId)
      : null;
    // Initialization can arrive after the fallback already accepted this turn.
    // Keep its real phase/clock; valid initialization metadata still belongs to
    // the conversation. New/closed owners and compaction keep their lifecycle path.
    const preserveCodexInitialization = isLocalOfficialCodexEvent
      && event === "SessionStart" && state === "idle"
      && shouldPreserveCodexInitialization(sessionId, opts, stateRuntime);
    const result = preserveCodexInitialization
      ? stateRuntime.updateCodexInitializationMetadata(sessionId, opts)
      : updateSession(sessionId, state, event, opts);
    // Tombstone only a local Codex row this official SessionEnd actually
    // deleted. A row kept alive for a replyable completion mapping (state.js
    // treats that end as a no-op) must not be tombstoned.
    if (
      event === "SessionEnd"
      && isLocalCodexSessionRecord(sessionBeforeUpdate)
      && sessions
      && typeof sessions.get === "function"
      && !sessions.get(sessionId)
    ) {
      rememberCodexSessionEndTombstone(sessionId);
    }
    maybeCaptureGhosttyTerminalId(sessionId, event, opts);
    enrichQoderSessionTitle(sessionId, event, opts);
    enrichWorkBuddySessionTitle(sessionId, event, opts);
    return result;
  }

  function shouldPreserveCodexInitialization(sessionId, opts, stateRuntime) {
    if (!stateRuntime || typeof stateRuntime.updateCodexInitializationMetadata !== "function") return false;
    const session = stateRuntime.sessions?.get(sessionId);
    if (!isLocalCodexSessionRecord(session) || session.headless
      || opts.headless || opts.subagentId || opts.subagentType || opts.recapIsSubagent
      || !CODEX_WORKING_LIKE_STATES.has(session.state)
      || session.requiresCompletionAck === true) return false;
    const owner = codexTurnFence.getSnapshot(sessionId);
    const turnId = normalizeCodexTurnId(opts.turnId);
    if (!owner || owner.terminalLatch
      || (turnId && turnId !== owner.currentTurnId)) return false;
    // SessionStart is an existing compaction finish signal. Do not bypass it
    // merely because the underlying turn remains open during the sweep.
    if (stateRuntime.hasCodexCompactionHold?.(sessionId)) return false;
    return true;
  }

  function localWorkBuddySession(sessionId) {
    if (disposed || !isAgentEnabled("workbuddy")) return null;
    const state = getStateRuntime();
    const session = state && state.sessions && state.sessions.get(sessionId);
    return session && session.agentId === "workbuddy" && (session.profileId || "local") === "local"
      && !session.host && !session.wslDistro && !session.headless ? session : null;
  }

  function enrichWorkBuddySessionTitle(sessionId, event, opts) {
    if (opts.agentId !== "workbuddy" || (opts.profileId || "local") !== "local"
      || opts.host || opts.wslDistro || opts.headless) return;
    if (event === "SessionEnd") {
      workBuddySessionTitleTracker.clear(sessionId);
      return;
    }
    const session = localWorkBuddySession(sessionId);
    if (!session) return;
    const input = {
      sessionId,
      rawSessionId: session.rawSessionId || opts.rawSessionId || sessionId,
      cwd: session.cwd,
      transcriptPath: session.transcriptPath || null,
    };
    if (event === "SessionStart") {
      // WorkBuddy 5.6.x emits a SessionStart on every turn (source=resume).
      workBuddySessionTitleTracker.beginTurn(input);
      return;
    }
    workBuddySessionTitleTracker.track(input);
  }

  function localQoderSession(sessionId) {
    if (disposed || !isAgentEnabled("qoder")) return null;
    const state = getStateRuntime();
    const session = state && state.sessions && state.sessions.get(sessionId);
    return session && session.agentId === "qoder"
      && (session.profileId || "local") === "local"
      && !session.host && !session.wslDistro ? session : null;
  }

  function noteQoderExternalTitle(sessionId, title) {
    const session = localQoderSession(sessionId);
    if (!session || !title) return;
    qoderSessionTitleTracker.noteExternalTitle(session.rawSessionId || sessionId, title);
  }

  function updateSessionMetadataFromServer(sessionId, opts = {}) {
    const state = getStateRuntime();
    const accepted = !!(state && typeof state.updateSessionMetadata === "function"
      && state.updateSessionMetadata(sessionId, opts));
    if (accepted) noteQoderExternalTitle(sessionId, opts.sessionTitle);
    return accepted;
  }

  function enrichQoderSessionTitle(sessionId, event, opts) {
    if (opts.agentId !== "qoder" || (opts.profileId || "local") !== "local"
      || opts.host || opts.wslDistro) return;
    const session = localQoderSession(sessionId);
    const rawSessionId = (session && session.rawSessionId) || opts.rawSessionId || sessionId;
    // A new lifecycle must invalidate work from an earlier --resume of this id.
    if (event === "SessionStart" || event === "SessionEnd") {
      qoderSessionTitleTracker.clear(rawSessionId, { preserveExternalTitle: event === "SessionStart" });
    }
    if (event === "SessionEnd") return;
    if (!session) return;
    if (opts.sessionTitle) {
      noteQoderExternalTitle(sessionId, opts.sessionTitle);
      return;
    }
    if (!QODER_TITLE_EVENTS.has(event) || !session.transcriptPath) return;
    const transcriptPath = session.transcriptPath;
    // Lifecycle acceptance is already complete. This result only annotates a
    // surviving local session and must not refresh activity or replay an event.
    qoderSessionTitleTracker.resolve({ event, sessionId: rawSessionId, transcriptPath }).then((title) => {
      const live = localQoderSession(sessionId);
      if (!title || !live || live.transcriptPath !== transcriptPath
        || qoderSessionTitleTracker.getTitle(rawSessionId) !== title) return;
      const state = getStateRuntime();
      if (state && typeof state.updateSessionMetadata === "function") {
        state.updateSessionMetadata(sessionId, { sessionTitle: title });
      }
    }).catch(() => {});
  }

  function maybeCaptureGhosttyTerminalId(sessionId, event, opts = {}) {
    if (typeof captureGhosttyTerminalId !== "function") return false;
    if (!sessionId || opts.host || opts.ghosttyTerminalId || !opts.sourcePid || !opts.cwd) return false;
    if (event !== "SessionStart" && event !== "UserPromptSubmit") return false;
    return captureGhosttyTerminalId({ sourcePid: opts.sourcePid, cwd: opts.cwd }, (terminalId) => {
      if (!terminalId) return;
      const state = getStateRuntime();
      if (!state || typeof state.updateSessionFocusMetadata !== "function") return;
      state.updateSessionFocusMetadata(String(sessionId), {
        sourcePid: opts.sourcePid,
        ghosttyTerminalId: terminalId,
      });
    });
  }

  function startMonitorForAgent(agentId) {
    // Caller (Settings pre-commit enable/install, or startup) has already
    // decided to start; re-reading the persisted gate here races the settings
    // store write. Match the existing monitor.start() semantics.
    if (agentId !== "codex" || disposed) return;
    if (codexMonitor) codexMonitor.start();
    startCodexArchiveTracker();
  }

  function stopMonitorForAgent(agentId) {
    if (agentId !== "codex") return;
    if (codexMonitor) codexMonitor.stop();
    stopCodexArchiveTracker();
  }

  function callServer(method, ...args) {
    const server = getServer();
    return server && typeof server[method] === "function" ? server[method](...args) : false;
  }

  function syncIntegrationForAgent(agentId, optionsArg) {
    return callServer("syncIntegrationForAgent", agentId, optionsArg);
  }

  function repairIntegrationForAgent(agentId, optionsArg) {
    return callServer("repairIntegrationForAgent", agentId, optionsArg);
  }

  function stopIntegrationForAgent(agentId) {
    return callServer("stopIntegrationForAgent", agentId);
  }

  function touchLocalCodexUserInputActivity(sessionId, activity) {
    if (!activity || activity.userInputReplay === true
      || !Number.isSafeInteger(activity.recapOccurredAt)
      || activity.recapOccurredAt < 0 || activity.recapOccurredAt > now() + 1500) return false;
    const snapshot = codexTurnFence.getSnapshot(sessionId);
    const turnId = normalizeCodexTurnId(activity.turnId);
    // An idless observer cannot prove it belongs to a known active turn.
    if (snapshot && snapshot.currentTurnId && !turnId) return false;
    const decision = codexTurnFence.observe({
      sessionId, source: "jsonl", event: "CodexUserInputActivity", state: "working",
      turnId,
    });
    if (!decision.accept) return false;
    const state = getStateRuntime();
    return !!(
      state
      && typeof state.touchSessionActivity === "function"
      && state.touchSessionActivity(sessionId, {
        agentId: "codex",
        profileId: "local",
        localOnly: true,
        reviveIdle: true,
      })
    );
  }

  function touchLocalCodexProgress(sessionId, activityState, activity) {
    if (!activity || activity.headless === true
      || !CODEX_WORKING_LIKE_STATES.has(activityState)
      || !Number.isSafeInteger(activity.recapOccurredAt)
      || activity.recapOccurredAt < 0 || activity.recapOccurredAt > now() + 1500) return false;
    const state = getStateRuntime();
    const session = state?.sessions?.get(sessionId);
    if (!isLocalCodexSessionRecord(session) || session.headless
      || (session.state === "idle" && !Number.isFinite(session.codexWorkingTimeoutAt))) return false;
    const lastActivityAt = session.state === "idle"
      ? session.codexWorkingTimeoutActivityAt : session.updatedAt;
    if (!Number.isFinite(lastActivityAt) || activity.recapOccurredAt < lastActivityAt) return false;
    const snapshot = codexTurnFence.getSnapshot(sessionId);
    const turnId = normalizeCodexTurnId(activity.turnId);
    // Only the already accepted current turn can refresh/revive its row.
    // Never create an owner from a stray model record or a late closed turn.
    if (!turnId || !snapshot || snapshot.terminalLatch
      || snapshot.currentTurnId !== turnId) return false;
    const decision = codexTurnFence.observe({
      sessionId, source: "jsonl", event: "CodexLiveProgress", state: activityState, turnId,
    });
    if (!decision.accept) return false;
    return typeof state.touchSessionActivity === "function" && state.touchSessionActivity(sessionId, {
      agentId: "codex", profileId: "local", localOnly: true, reviveIdle: true,
      activityState, onlyWorkingTimeout: true, now: activity.recapOccurredAt,
    });
  }

  function uninstallIntegrationForAgent(agentId) {
    return callServer("uninstallIntegrationForAgent", agentId);
  }

  function clearSessionsByAgent(agentId) {
    if (agentId === "workbuddy") {
      workBuddySessionTitleTracker.clear();
      clearRetiredWorkBuddySessions();
    }
    if (agentId === "codex") {
      resetLocalCodexLifecycleTracking();
      stopCodexArchiveTracker();
    }
    if (agentId === "qoder" && qoderSessionTitleTracker && typeof qoderSessionTitleTracker.clear === "function") {
      qoderSessionTitleTracker.clear();
    }
    const state = getStateRuntime();
    return state && typeof state.clearSessionsByAgent === "function"
      ? state.clearSessionsByAgent(agentId)
      : 0;
  }

  function dismissPermissionsByAgent(agentId, options) {
    const perm = getPermissionRuntime();
    const state = getStateRuntime();
    const removed = perm && typeof perm.dismissPermissionsByAgent === "function"
      ? perm.dismissPermissionsByAgent(agentId, options)
      : 0;
    // Kimi keeps a state-side permission hold for passive notifications; when
    // an agent is disabled, dismissing the bubble must release that hold too.
    if (agentId === "kimi-cli" && state && typeof state.disposeAllKimiPermissionState === "function") {
      const disposed = state.disposeAllKimiPermissionState();
      if (disposed && typeof state.resolveDisplayState === "function" && typeof state.setState === "function") {
        const resolved = state.resolveDisplayState();
        state.setState(resolved, state.getSvgOverride ? state.getSvgOverride(resolved) : undefined);
      }
    }
    return removed;
  }

  function startCodexLogMonitor() {
    if (codexMonitor) {
      if (isAgentEnabled("codex")) {
        codexMonitor.start();
        startCodexArchiveTracker();
      }
      return codexMonitor;
    }
    try {
      const CodexLogMonitor = loadCodexLogMonitor();
      const codexAgent = loadCodexAgent();
      codexMonitor = new CodexLogMonitor(codexAgent, (sid, state, event, extra) => {
        const sessionIdentity = resolveSessionIdentity(sid, "local");
        const sessionId = sessionIdentity.sessionId;
        // Subscription quota is account state, not session state: it goes
        // to the session-independent per-source store (null host = this
        // machine), never into updateSession opts — see state.js
        // updateAccountQuota and src/state-account-quota.js.
        const sessionOptions = {
          ...buildCodexMonitorSessionOptions(extra, { includeHeadless: true, includeRecap: true }),
          profileId: sessionIdentity.profileId,
          rawSessionId: sessionIdentity.rawSessionId,
        };
        const accountQuotas = normalizeCodexMonitorAccountQuotas(extra);
        recordCodexTurnIdCapture(sessionId, "jsonl", event, extra && extra.turnId);
        const annotateCodexAccountQuota = () => {
          if (!accountQuotas) return;
          const stateRuntime = getStateRuntime();
          if (stateRuntime && typeof stateRuntime.updateAccountQuota === "function") {
            stateRuntime.updateAccountQuota(null, accountQuotas);
          }
        };
        const annotateCodexContextUsage = () => {
          if (!sessionOptions.contextUsage) return false;
          const stateRuntime = getStateRuntime();
          if (!stateRuntime || typeof stateRuntime.updateSessionMetadata !== "function") return false;
          return stateRuntime.updateSessionMetadata(sessionId, {
            contextUsage: sessionOptions.contextUsage,
          });
        };
        if (isCodexMonitorMetadataOnlyEvent(event, extra)) {
          if (event === "session_index:title") {
            const stateRuntime = getStateRuntime();
            if (stateRuntime && typeof stateRuntime.updateSessionMetadata === "function") {
              const existing = stateRuntime.sessions && stateRuntime.sessions.get(sessionId);
              if (existing && (existing.host || existing.wslDistro)) return;
              stateRuntime.updateSessionMetadata(sessionId, {
                expectedAgentId: "codex",
                sessionTitle: sessionOptions.sessionTitle,
              });
            }
          } else {
            annotateCodexContextUsage();
            annotateCodexAccountQuota();
          }
          return;
        }
        // Positive archive evidence: drop the lifecycle without recreating the
        // card, but keep session-independent quota/context ingestion intact.
        if (shouldSuppressCodexArchive(sessionIdentity.rawSessionId, {
          agentId: "codex",
          profileId: sessionIdentity.profileId,
        })) {
          annotateCodexContextUsage();
          annotateCodexAccountQuota();
          return;
        }
        // Official SessionEnd already retired this local Codex row. A rollout
        // poll that began before the teardown can still emit the tail of the
        // old turn; drop anything but the start of a new turn so the row is not
        // rebuilt. Quota/context are session-independent and stay ingested.
        const tombstoned = hasCodexSessionEndTombstone(sessionId);
        const tombstoneTurnStart = tombstoned && isCodexJsonlTurnStart(event, extra);
        if (tombstoned && !tombstoneTurnStart) {
          annotateCodexContextUsage();
          annotateCodexAccountQuota();
          return;
        }
        const fenceDecision = codexTurnFence.observe({
          sessionId,
          source: "jsonl",
          event,
          state,
          turnId: extra && extra.turnId,
          syntheticBackfill: extra && extra.syntheticBackfill === true,
          turnBoundaryOpen: extra && extra.turnBoundaryOpen === true,
        });
        if (!fenceDecision.accept) {
          if (fenceDecision.reason === "duplicate-terminal") {
            const stateRuntime = getStateRuntime();
            // The local rollout monitor must not release presentation owned
            // by a remote/WSL session that happens to share its raw id.
            if (isLocalCodexSessionRecord(stateRuntime?.sessions?.get(sessionId))) {
              stateRuntime.releaseCodexCompactionOnTerminal?.(sessionId, event, {
                turnId: extra && extra.turnId, occurredAt: extra && extra.recapOccurredAt,
              });
            }
          }
          if (
            fenceDecision.reason === "closed-turn-id"
            || fenceDecision.reason === "terminal-latch"
          ) {
            recordCodexWebSearchRecapOnly(sessionIdentity, sessionOptions, event, extra);
          }
          annotateCodexContextUsage();
          annotateCodexAccountQuota();
          return;
        }
        // Only a fence-accepted new turn releases the tombstone: a late start
        // for an already-closed turn is rejected above and must keep it.
        if (tombstoneTurnStart) clearCodexSessionEndTombstone(sessionId);
        if (shouldSuppressCodexLogEvent(sessionId, state, event, extra && extra.turnId, extra)) {
          annotateCodexContextUsage();
          annotateCodexAccountQuota();
          return;
        }
        clearCodexNotifyBubbles(sessionId, `codex-state-transition:${state}`);
        updateSession(sessionId, state, event, sessionOptions);
        annotateCodexAccountQuota();
      }, {
        classifier: localCodexSubagentClassifier,
        onActivity: (sid, activityState, _event, activity) => {
          const sessionIdentity = resolveSessionIdentity(sid, "local");
          if (shouldSuppressCodexArchive(sessionIdentity.rawSessionId, {
            agentId: "codex", profileId: sessionIdentity.profileId,
          }) || hasCodexSessionEndTombstone(sessionIdentity.sessionId)) return;
          touchLocalCodexProgress(sessionIdentity.sessionId, activityState, activity);
        },
        onUserInputRequest: (sid, request, extra) => {
          const sessionIdentity = resolveSessionIdentity(sid, "local");
          const sessionId = sessionIdentity.sessionId;
          if (shouldSuppressCodexArchive(sessionIdentity.rawSessionId, {
            agentId: "codex",
            profileId: sessionIdentity.profileId,
          })) return;
          // A live blocking question proves the turn is still active even when
          // the Desktop app has emitted no ordinary lifecycle hook during a
          // long model/network-retry segment. Never creates a missing session.
          touchLocalCodexUserInputActivity(sessionId, extra);
          const shown = showCodexUserInputBubble({
            sessionId,
            callId: request.callId,
            questions: request.questions,
            autoResolutionMs: request.autoResolutionMs,
            ...extra,
          });
          if (!shown) return;
          updateSession(sessionId, "notification", "CodexUserInputRequest", {
            ...buildCodexMonitorSessionOptions(extra, { includeHeadless: true }),
            profileId: sessionIdentity.profileId,
            rawSessionId: sessionIdentity.rawSessionId,
            transientPermissionEvent: true,
            // Card/focus recovery is independent of accepted activity. Only
            // the fenced touch above may extend the session's lifetime, and
            // this UI event must never enter recap with receipt time.
            recapSuppressed: true,
          });
        },
        onUserInputResolved: (sid, callId, resolution = null) => {
          const sessionId = resolveSessionIdentity(sid, "local").sessionId;
          // The correlated function_call_output is also forward progress. It
          // used to close only the card, leaving the stale clock untouched.
          // Terminal cleanup (task_complete / turn_aborted) uses the same card
          // callback but is not forward progress and must never revive work.
          if (!resolution || resolution.source !== "turn-terminal") {
            touchLocalCodexUserInputActivity(sessionId, resolution);
          }
          clearCodexUserInputBubbles(sessionId, callId, "codex-user-input-resolved");
        },
      });
      if (isAgentEnabled("codex")) codexMonitor.start();
    } catch (err) {
      logWarn("Clawd: Codex log monitor not started:", err && err.message);
    }
    // The archive observer is independent of the JSONL monitor, so it still
    // starts when the monitor is unavailable.
    if (isAgentEnabled("codex")) startCodexArchiveTracker();
    return codexMonitor;
  }

  function cleanup() {
    disposed = true;
    workBuddySessionTitleTracker.clear();
    clearRetiredWorkBuddySessions();
    if (codexMonitor && typeof codexMonitor.stop === "function") codexMonitor.stop();
    stopCodexArchiveTracker();
    resetLocalCodexLifecycleTracking();
    if (qoderSessionTitleTracker && typeof qoderSessionTitleTracker.clear === "function") {
      qoderSessionTitleTracker.clear();
    }
  }

  function resetLocalCodexLifecycleTracking() {
    codexTurnFence.clear();
    codexOfficialActivity.clear();
    codexSessionEndTombstones.clear();
    codexAmbientSuggestionSessions.clear();
  }

  return {
    getCodexSubagentClassifier: () => codexSubagentClassifier,
    startCodexLogMonitor,
    startMonitorForAgent,
    stopMonitorForAgent,
    syncIntegrationForAgent,
    repairIntegrationForAgent,
    stopIntegrationForAgent,
    uninstallIntegrationForAgent,
    clearSessionsByAgent,
    dismissPermissionsByAgent,
    updateSessionFromServer,
    updateSessionMetadataFromServer,
    markCodexOfficialHookSession,
    shouldSuppressCodexLogEvent,
    shouldSuppressCodexArchive,
    startCodexArchiveTracker,
    stopCodexArchiveTracker,
    getCodexArchiveTracker: () => codexArchiveTracker,
    getWorkBuddySessionTitleTracker: () => workBuddySessionTitleTracker,
    resetLocalCodexLifecycleTracking,
    getCodexTurnFenceSnapshot: (sessionId) => codexTurnFence.getSnapshot(sessionId),
    getCodexOfficialActivitySnapshot: (sessionId) => codexOfficialActivity.getSnapshot(sessionId),
    cleanup,
  };
}

createAgentRuntimeMain.CODEX_LOG_EVENTS_COVERED_BY_OFFICIAL_HOOKS = CODEX_LOG_EVENTS_COVERED_BY_OFFICIAL_HOOKS;
createAgentRuntimeMain.CODEX_OFFICIAL_LOG_SUPPRESS_TTL_MS = CODEX_OFFICIAL_LOG_SUPPRESS_TTL_MS;

module.exports = createAgentRuntimeMain;
