"use strict";

// Rolling event history per session. Used by deriveSessionBadge() to infer a
// user-facing status ("Running" / "Done" / "Interrupted" / "Idle") without
// extending the state machine. Cap avoids unbounded growth on long sessions.
const RECENT_EVENT_LIMIT = 8;

function pushRecentEvent(existing, state, event, options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const previous = Array.isArray(existing && existing.recentEvents)
    ? existing.recentEvents.slice(-(RECENT_EVENT_LIMIT - 1))
    : [];
  previous.push({
    at: now(),
    event: event || null,
    state: state || "idle",
  });
  return previous;
}

function pickDisplayHint(state, existing, incoming, displayHintMap) {
  if (state !== "working" && state !== "executing" && state !== "thinking" && state !== "juggling") {
    return null;
  }
  if (incoming !== undefined) {
    if (incoming === null || incoming === "") return null;
    if (displayHintMap[incoming] != null) return incoming;
    return existing && existing.displayHint != null ? existing.displayHint : null;
  }
  return existing && existing.displayHint != null ? existing.displayHint : null;
}

module.exports = {
  RECENT_EVENT_LIMIT,
  pushRecentEvent,
  pickDisplayHint,
};
