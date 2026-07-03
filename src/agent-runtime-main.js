"use strict";

const DefaultCodexSubagentClassifier = require("../agents/codex-subagent-classifier");
const {
  buildCodexMonitorUpdateOptions,
  isCodexMonitorMetadataOnlyEvent,
} = require("./codex-monitor-callback");

const CODEX_OFFICIAL_LOG_SUPPRESS_TTL_MS = 10 * 60 * 1000;
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

function createAgentRuntimeMain(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const logWarn = typeof options.logWarn === "function" ? options.logWarn : console.warn;
  const loadCodexLogMonitor = options.loadCodexLogMonitor || (() => require("../agents/codex-log-monitor"));
  const loadCodexAgent = options.loadCodexAgent || (() => require("../agents/codex"));
  const codexSubagentClassifier = options.codexSubagentClassifier || new DefaultCodexSubagentClassifier();
  const getServer = options.getServer || (() => null);
  const getStateRuntime = options.getStateRuntime || (() => null);
  const getPermissionRuntime = options.getPermissionRuntime || (() => null);
  const isAgentEnabled = options.isAgentEnabled || (() => true);
  const updateSession = options.updateSession || (() => {});
  const captureGhosttyTerminalId = options.captureGhosttyTerminalId || null;
  const clearCodexNotifyBubbles = options.clearCodexNotifyBubbles || (() => {});

  let codexMonitor = null;
  const codexOfficialHookSessions = new Map();

  function markCodexOfficialHookSession(sessionId) {
    if (!sessionId) return;
    codexOfficialHookSessions.set(String(sessionId), now());
  }

  function hasRecentCodexOfficialHookSession(sessionId) {
    const lastHookAt = codexOfficialHookSessions.get(String(sessionId));
    if (!lastHookAt) return false;
    if (now() - lastHookAt > CODEX_OFFICIAL_LOG_SUPPRESS_TTL_MS) {
      codexOfficialHookSessions.delete(String(sessionId));
      return false;
    }
    return true;
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

  function shouldSuppressCodexLogEvent(sessionId, state, event) {
    if (!CODEX_LOG_EVENTS_COVERED_BY_OFFICIAL_HOOKS.has(event)) return false;
    if (!hasRecentCodexOfficialHookSession(sessionId)) return false;
    if (shouldAllowCodexJsonlCompletionFallback(sessionId, state, event)) return false;
    return true;
  }

  function updateSessionFromServer(sessionId, state, event, opts = {}) {
    if (opts && opts.agentId === "codex" && opts.hookSource === "codex-official") {
      markCodexOfficialHookSession(sessionId);
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

  function syncIntegrationForAgent(agentId) {
    return callServer("syncIntegrationForAgent", agentId);
  }

  function repairIntegrationForAgent(agentId, optionsArg) {
    return callServer("repairIntegrationForAgent", agentId, optionsArg);
  }

  function stopIntegrationForAgent(agentId) {
    return callServer("stopIntegrationForAgent", agentId);
  }

  function uninstallIntegrationForAgent(agentId) {
    return callServer("uninstallIntegrationForAgent", agentId);
  }

  function clearSessionsByAgent(agentId) {
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
        if (isCodexMonitorMetadataOnlyEvent(event, extra)) {
          const metadataOptions = buildCodexMonitorUpdateOptions(extra, {
            includeHeadless: true,
          });
          if (metadataOptions.contextUsage) {
            updateSession(sid, state, event, {
              ...metadataOptions,
              preserveState: true,
            });
          }
          return;
        }
        if (shouldSuppressCodexLogEvent(sid, state, event)) {
          const metadataOptions = buildCodexMonitorUpdateOptions(extra, {
            includeHeadless: true,
          });
          if (metadataOptions.contextUsage) {
            updateSession(sid, state, event, {
              ...metadataOptions,
              preserveState: true,
            });
          }
          return;
        }
        clearCodexNotifyBubbles(sid, `codex-state-transition:${state}`);
        updateSession(sid, state, event, buildCodexMonitorUpdateOptions(extra, {
          includeHeadless: true,
        }));
      }, { classifier: codexSubagentClassifier });
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
    codexOfficialHookSessions.clear();
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
    cleanup,
  };
}

createAgentRuntimeMain.CODEX_LOG_EVENTS_COVERED_BY_OFFICIAL_HOOKS = CODEX_LOG_EVENTS_COVERED_BY_OFFICIAL_HOOKS;
createAgentRuntimeMain.CODEX_OFFICIAL_LOG_SUPPRESS_TTL_MS = CODEX_OFFICIAL_LOG_SUPPRESS_TTL_MS;

module.exports = createAgentRuntimeMain;
