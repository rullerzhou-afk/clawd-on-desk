"use strict";

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

// Headless sessions (subagents spawned by the root's `task` tool) should not
// drive idle/attention/sleeping states — those belong to the root session only.
// But their ACTIVE states (working, thinking, juggling, sweeping, error) MUST
// participate in priority resolution so the pet stays animated while background
// tasks are running, even if the root session has gone idle.
const HEADLESS_ACTIVE_STATES = new Set([
  "working", "thinking", "juggling", "sweeping", "error",
  "notification", "carrying",
]);

function resolveDominantSessionState(sessions, options = {}) {
  const statePriority = options.statePriority || STATE_PRIORITY;
  let best = "sleeping";
  let hasSession = false;
  let hasNonHeadless = false;

  for (const [, session] of normalizeSessionsIterable(sessions)) {
    hasSession = true;
    const state = session && session.state;
    // Headless sessions contribute only their active states to priority
    // resolution. Their idle/sleeping/attention states are ignored so the
    // root session's state isn't overridden by a subagent going idle.
    if (session && session.headless) {
      if (state && HEADLESS_ACTIVE_STATES.has(state)) {
        if (getStatePriority(state, statePriority) > getStatePriority(best, statePriority)) best = state;
      }
      continue;
    }
    hasNonHeadless = true;
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
