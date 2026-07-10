"use strict";

const CODEX_OFFICIAL_HOOK_SOURCE = "codex-official";
const MAX_CODEX_OFFICIAL_TURNS = 200;
const CODEX_SESSION_ROLE_SUBAGENT = "subagent";

function pruneCodexOfficialTurns(turns) {
  if (!turns || turns.size <= MAX_CODEX_OFFICIAL_TURNS) return;
  const overflow = turns.size - MAX_CODEX_OFFICIAL_TURNS;
  let removed = 0;
  for (const key of turns.keys()) {
    turns.delete(key);
    removed++;
    if (removed >= overflow) break;
  }
}

function getCodexOfficialTurnKey(sessionId, turnId) {
  if (!turnId) return null;
  return `${sessionId || "default"}|${turnId}`;
}

function hasCodexAssistantCompletionOutput(data) {
  return typeof data.assistant_last_output === "string" && data.assistant_last_output.trim().length > 0;
}

function resolveCodexOfficialStopState(current, data) {
  if (current && current.hadToolUse) return "attention";
  return hasCodexAssistantCompletionOutput(data) ? "attention" : "idle";
}

function classifyCodexOfficialSession(data, classifier) {
  if (!classifier || typeof classifier.registerSession !== "function") return "unknown";
  const sessionId = typeof data.session_id === "string" && data.session_id ? data.session_id : "default";
  try {
    return classifier.registerSession(sessionId, {
      hookPayload: data,
      hookRole: data.codex_session_role,
    });
  } catch {
    return "unknown";
  }
}

function resolveCodexOfficialHookState(data, requestedState, turns, classifier = null) {
  if (!data || data.agent_id !== "codex" || data.hook_source !== CODEX_OFFICIAL_HOOK_SOURCE) {
    return { state: requestedState, drop: false };
  }

  const event = typeof data.event === "string" ? data.event : "";
  const turnId = typeof data.turn_id === "string" && data.turn_id ? data.turn_id : null;
  const sessionId = typeof data.session_id === "string" && data.session_id ? data.session_id : "default";
  const sessionRole = classifyCodexOfficialSession(data, classifier);
  const isSubagent = sessionRole === CODEX_SESSION_ROLE_SUBAGENT;
  const headless = isSubagent ? { headless: true } : {};
  const turnKey = getCodexOfficialTurnKey(sessionId, turnId);

  if (event === "Stop" && data.stop_hook_active === true) {
    if (turnKey && turns) turns.delete(turnKey);
    return { state: requestedState, drop: true, ...headless };
  }

  if (turnKey && turns) {
    if (event === "UserPromptSubmit") {
      turns.set(turnKey, { sessionId, hadToolUse: false });
      pruneCodexOfficialTurns(turns);
    } else if (event === "PreToolUse" || event === "PostToolUse") {
      const current = turns.get(turnKey) || { sessionId, hadToolUse: false };
      current.sessionId = sessionId;
      current.hadToolUse = true;
      turns.set(turnKey, current);
      pruneCodexOfficialTurns(turns);
    } else if (event === "Stop") {
      const current = turns.get(turnKey);
      if (current) turns.delete(turnKey);
      if (isSubagent) return { state: "idle", drop: false, headless: true };
      return { state: resolveCodexOfficialStopState(current, data), drop: false };
    }
  } else if (event === "Stop") {
    return {
      state: isSubagent ? "idle" : resolveCodexOfficialStopState(null, data),
      drop: false,
      ...headless,
    };
  }

  return { state: requestedState, drop: false, ...headless };
}

module.exports = {
  CODEX_OFFICIAL_HOOK_SOURCE,
  MAX_CODEX_OFFICIAL_TURNS,
  CODEX_SESSION_ROLE_SUBAGENT,
  pruneCodexOfficialTurns,
  getCodexOfficialTurnKey,
  hasCodexAssistantCompletionOutput,
  classifyCodexOfficialSession,
  resolveCodexOfficialHookState,
};
