"use strict";

const DefaultCodexSubagentClassifier = require("../agents/codex-subagent-classifier");
const {
  buildCodexMonitorSessionOptions,
  normalizeCodexMonitorAccountQuotas,
  isCodexMonitorMetadataOnlyEvent,
} = require("./codex-monitor-callback");
const { resolveSessionIdentity } = require("./session-key");
const { digestCodexTurnId } = require("./codex-turn-id");
const createCodexTurnFence = require("./codex-turn-fence");
const createCodexOfficialActivity = require("./codex-official-activity");

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
  const captureGhosttyTerminalId = options.captureGhosttyTerminalId || null;
  const clearCodexNotifyBubbles = options.clearCodexNotifyBubbles || (() => {});
  const showCodexUserInputBubble = options.showCodexUserInputBubble || (() => false);
  const clearCodexUserInputBubbles = options.clearCodexUserInputBubbles || (() => {});

  let codexMonitor = null;
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
    return result;
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
    if (agentId === "codex" && codexMonitor) codexMonitor.start();
  }

  function stopMonitorForAgent(agentId) {
    if (agentId === "codex" && codexMonitor) codexMonitor.stop();
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

  function touchLocalCodexUserInputActivity(sessionId) {
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
    if (agentId === "codex") resetLocalCodexLifecycleTracking();
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
      if (isAgentEnabled("codex")) codexMonitor.start();
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
          // A live blocking question proves the turn is still active even when
          // the Desktop app has emitted no ordinary lifecycle hook during a
          // long model/network-retry segment. Never creates a missing session.
          touchLocalCodexUserInputActivity(sessionId);
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
            // This passive/recovery card deliberately bypasses the ordinary
            // JSONL timestamp + turn-fence path. Until it carries the original
            // line time and equivalent official suppression, it is UI-only and
            // must never be stamped into recap with receipt time.
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
            touchLocalCodexUserInputActivity(sessionId);
          }
          clearCodexUserInputBubbles(sessionId, callId, "codex-user-input-resolved");
        },
      });
      if (isAgentEnabled("codex")) {
        codexMonitor.start();
      }
    } catch (err) {
      logWarn("Clawd: Codex log monitor not started:", err && err.message);
    }
    return codexMonitor;
  }

  function cleanup() {
    if (codexMonitor && typeof codexMonitor.stop === "function") codexMonitor.stop();
    resetLocalCodexLifecycleTracking();
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
    markCodexOfficialHookSession,
    shouldSuppressCodexLogEvent,
    resetLocalCodexLifecycleTracking,
    getCodexTurnFenceSnapshot: (sessionId) => codexTurnFence.getSnapshot(sessionId),
    getCodexOfficialActivitySnapshot: (sessionId) => codexOfficialActivity.getSnapshot(sessionId),
    cleanup,
  };
}

createAgentRuntimeMain.CODEX_LOG_EVENTS_COVERED_BY_OFFICIAL_HOOKS = CODEX_LOG_EVENTS_COVERED_BY_OFFICIAL_HOOKS;
createAgentRuntimeMain.CODEX_OFFICIAL_LOG_SUPPRESS_TTL_MS = CODEX_OFFICIAL_LOG_SUPPRESS_TTL_MS;

module.exports = createAgentRuntimeMain;
