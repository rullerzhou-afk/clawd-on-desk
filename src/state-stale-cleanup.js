"use strict";

const SESSION_STALE_MS = 600000;
const WORKING_STALE_MS = 300000;
const DETACHED_IDLE_STALE_MS = 30000;

function isWorkingLikeState(state) {
  return state === "working" || state === "juggling" || state === "thinking";
}

function getStaleSessionDecision(session, options = {}) {
  const now = options.now;
  const config = options.staleConfig || {};
  const sessionStaleMs = Number.isFinite(config.sessionStaleMs)
    ? config.sessionStaleMs
    : SESSION_STALE_MS;
  const workingStaleMs = Number.isFinite(config.workingStaleMs)
    ? config.workingStaleMs
    : WORKING_STALE_MS;
  const detachedIdleStaleMs = Number.isFinite(config.detachedIdleStaleMs)
    ? config.detachedIdleStaleMs
    : DETACHED_IDLE_STALE_MS;

  const age = now - session.updatedAt;
  const isProcessAlive = options.isProcessAlive;

  if (session.pidReachable && session.agentPid && !isProcessAlive(session.agentPid)) {
    return { action: "delete", reason: "agent-exit" };
  }

  const deriveSessionBadge = options.deriveSessionBadge;
  const shouldAutoClearDetachedSession = options.shouldAutoClearDetachedSession;
  const badge = deriveSessionBadge(session);
  const autoClearDetached = shouldAutoClearDetachedSession(session, badge);
  if (autoClearDetached) {
    if (age > detachedIdleStaleMs) {
      return { action: "delete", reason: "detached-ended", badge };
    }
    return { action: null, snapshotRefreshNeeded: true };
  }

  // sessionStaleMs === 0 disables the idle-age cutoff entirely; the
  // working-timeout branch below still applies for stuck working/thinking
  // sessions because it's a UX guard, not an idle cutoff.
  if (sessionStaleMs > 0 && age > sessionStaleMs) {
    if (session.pidReachable && session.sourcePid) {
      if (!isProcessAlive(session.sourcePid)) {
        return { action: "delete", reason: "source-exit" };
      }
      if (session.state !== "idle") {
        return { action: "idle", reason: "session-timeout", updateTimestamp: false };
      }
    } else if (!session.pidReachable) {
      return { action: "delete", reason: "unreachable" };
    } else {
      return { action: "delete", reason: "no-source" };
    }
  } else if (age > workingStaleMs) {
    if (session.pidReachable && session.sourcePid && !isProcessAlive(session.sourcePid)) {
      return { action: "delete", reason: "working-source-exit" };
    }
    if (isWorkingLikeState(session.state)) {
      return { action: "idle", reason: "working-timeout", updateTimestamp: true };
    }
  }

  return { action: null };
}

module.exports = {
  SESSION_STALE_MS,
  WORKING_STALE_MS,
  DETACHED_IDLE_STALE_MS,
  isWorkingLikeState,
  getStaleSessionDecision,
};
