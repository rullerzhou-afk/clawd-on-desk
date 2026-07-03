"use strict";

const {
  buildLatestLocalCodexProcessIds,
  isSupersededLocalCodexProcessSession,
} = require("./state-session-dedupe");

const SLEEP_SEQUENCE_STATES = ["yawning", "dozing", "collapsing", "sleeping", "waking"];

const STATE_PRIORITY = Object.freeze({
  error: 8,
  notification: 7,
  sweeping: 6,
  attention: 5,
  carrying: 4,
  juggling: 4,
  working: 3,
  thinking: 2,
  idle: 1,
  roam: 1,
  sleeping: 0,
});

const ONESHOT_STATE_NAMES = ["attention", "error", "sweeping", "notification", "carrying"];

const SLEEP_SEQUENCE = new Set(SLEEP_SEQUENCE_STATES);
const ONESHOT_STATES = new Set(ONESHOT_STATE_NAMES);

function createStatePriorityConstants() {
  return {
    SLEEP_SEQUENCE: new Set(SLEEP_SEQUENCE_STATES),
    STATE_PRIORITY: { ...STATE_PRIORITY },
    ONESHOT_STATES: new Set(ONESHOT_STATE_NAMES),
  };
}

function getStatePriority(state, statePriority = STATE_PRIORITY) {
  return (statePriority && statePriority[state]) || 0;
}

function normalizeSessionsIterable(sessions) {
  if (!sessions) return [];
  if (sessions instanceof Map) return sessions.entries();
  if (typeof sessions[Symbol.iterator] === "function") return sessions;
  return [];
}

function resolveDominantSessionState(sessions, options = {}) {
  const statePriority = options.statePriority || STATE_PRIORITY;
  let best = "sleeping";
  let hasSession = false;
  let hasNonHeadless = false;
  const latestLocalCodexProcessIds = buildLatestLocalCodexProcessIds(sessions);

  for (const [id, session] of normalizeSessionsIterable(sessions)) {
    hasSession = true;
    if (session && session.headless) continue;
    if (isSupersededLocalCodexProcessSession(id, session, latestLocalCodexProcessIds)) continue;
    hasNonHeadless = true;
    const state = session && session.state;
    if (getStatePriority(state, statePriority) > getStatePriority(best, statePriority)) best = state;
  }

  if (!hasSession || !hasNonHeadless) return "idle";
  return best;
}

function resolveDisplayStateFromSessions(sessions, options = {}) {
  const statePriority = options.statePriority || STATE_PRIORITY;
  let best = resolveDominantSessionState(sessions, { statePriority });

  if (options.permissionLocked === true) {
    best = "notification";
  }

  const updateVisualState = options.updateVisualState || null;
  if (updateVisualState) {
    const updateVisualPriority = options.updateVisualPriority || getStatePriority(updateVisualState, statePriority);
    if (updateVisualPriority > getStatePriority(best, statePriority)) {
      return updateVisualState;
    }
  }

  return best;
}

module.exports = {
  SLEEP_SEQUENCE,
  STATE_PRIORITY,
  ONESHOT_STATES,
  createStatePriorityConstants,
  getStatePriority,
  resolveDominantSessionState,
  resolveDisplayStateFromSessions,
};
