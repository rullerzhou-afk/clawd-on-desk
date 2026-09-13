"use strict";

const DefaultCodexSubagentClassifier = require("../agents/codex-subagent-classifier");
const {
  buildCodexMonitorSessionOptions,
  normalizeCodexMonitorAccountQuotas,
  isCodexMonitorMetadataOnlyEvent,
} = require("./codex-monitor-callback");
const { resolveSessionIdentity } = require("./session-key");
const { bareCodexSessionId } = require("../hooks/codex-session-index");
const { digestCodexTurnId, normalizeCodexTurnId } = require("./codex-turn-id");
const createCodexTurnFence = require("./codex-turn-fence");
const createCodexOfficialActivity = require("./codex-official-activity");
const { createQoderSessionTitleTracker, QODER_TITLE_EVENTS } = require("./qoder-session-title");

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
  "event_msg:task_started",
  "event_msg:task_complete",
  "event_msg:turn_aborted",
]);

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
  const qoderSessionTitleTracker = options.qoderSessionTitleTracker
    || createQoderSessionTitleTracker();
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
  function shouldAllowCodexJsonlCompletionFallback(sessionId, state, event) {
    if (event !== "event_msg:task_complete") return false;
    // codex-log-monitor only resolves task_complete to a completion state.
    if (state !== "attention" && state !== "idle") return false;
    const stateRuntime = getStateRuntime();
    const sessions = stateRuntime && stateRuntime.sessions;
    const session = sessions && typeof sessions.get === "function" ? sessions.get(sessionId) : null;
    if (!session || session.agentId !== "codex") return false;
    if (session.host || session.headless) return false;
    return CODEX_WORKING_LIKE_STATES.has(session.state);
  }

  function shouldSuppressCodexLogEvent(sessionId, state, event, turnId = null, extra = null) {
    // Some Codex builds encode WebSearch as a generic function_call. Official
    // hooks do not expose that boundary, so keep this privacy-safe monitor bit
    // on the same fallback path as response_item:web_search_call.
    if (event === "response_item:function_call" && extra && extra.recapIsWebSearch === true) return false;
    if (!CODEX_LOG_EVENTS_COVERED_BY_OFFICIAL_HOOKS.has(event)) return false;
    if (!hasRecentCodexOfficialHookSession(sessionId, turnId)) return false;
    if (shouldAllowCodexJsonlCompletionFallback(sessionId, state, event)) return false;
    return true;
  }

  function isCodexWebSearchLogBoundary(event, extra) {
    return event === "response_item:web_search_call"
      || (event === "response_item:function_call" && extra && extra.recapIsWebSearch === true);
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
        if (!fenceDecision.accept) return false;
      }
    }
    const result = updateSession(sessionId, state, event, opts);
    maybeCaptureGhosttyTerminalId(sessionId, event, opts);
    enrichQoderSessionTitle(sessionId, event, opts);
    return result;
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

  function uninstallIntegrationForAgent(agentId) {
    return callServer("uninstallIntegrationForAgent", agentId);
  }

  function clearSessionsByAgent(agentId) {
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
          annotateCodexContextUsage();
          annotateCodexAccountQuota();
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
    resetLocalCodexLifecycleTracking,
    getCodexTurnFenceSnapshot: (sessionId) => codexTurnFence.getSnapshot(sessionId),
    getCodexOfficialActivitySnapshot: (sessionId) => codexOfficialActivity.getSnapshot(sessionId),
    cleanup,
  };
}

createAgentRuntimeMain.CODEX_LOG_EVENTS_COVERED_BY_OFFICIAL_HOOKS = CODEX_LOG_EVENTS_COVERED_BY_OFFICIAL_HOOKS;
createAgentRuntimeMain.CODEX_OFFICIAL_LOG_SUPPRESS_TTL_MS = CODEX_OFFICIAL_LOG_SUPPRESS_TTL_MS;

module.exports = createAgentRuntimeMain;
