"use strict";

const SESSION_STALE_MS = 600000;
const WORKING_STALE_MS = 300000;
const DETACHED_IDLE_STALE_MS = 30000;

// Hard ceiling for sessions held back by requiresCompletionAck — beyond this
// we delete the session even if the user never clicked anything. Private
// constant; tests inject `options.unackedMaxAgeMs` if they need to override.
const UNACKED_SESSION_MAX_AGE_MS = 86_400_000;

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

  const isProcessAlive = options.isProcessAlive;

  if (session.pidReachable && session.agentPid && !isProcessAlive(session.agentPid)) {
    return { action: "delete", reason: "agent-exit" };
  }

  // GLOBAL reference time hoisted to the top: ack-pending guard and stale
  // branches both consume Math.max(updatedAt, ackedAt). Without this hoist,
  // an ack-then-natural-stale path would revert to raw updatedAt the moment
  // the flag clears, deleting on the next 10s tick.
  const referenceTs = Math.max(
    Number(session.updatedAt) || 0,
    Number(session.ackedAt) || 0
  );
  const age = now - referenceTs;

  // requiresCompletionAck holds the session out of stale cleanup until the
  // user acknowledges, OR until the hard ceiling fires. Order matters:
  // agent-exit above still wins (a dead process is dead). The ack-pending
  // guard runs BEFORE the detached-cleanup branch — once a session has the
  // flag set, the detached sweep cannot reach it either (the whole point of
  // the flag is "hold this session until user sees it").
  if (session.requiresCompletionAck === true) {
    const cap = Number.isFinite(options.unackedMaxAgeMs)
      ? options.unackedMaxAgeMs
      : UNACKED_SESSION_MAX_AGE_MS;
    if (age <= cap) {
      return { action: null, reason: "ack-pending" };
    }
    // Explicit delete at the cap. With sessionStaleMs=0 the branch below is
    // skipped, and a `done`-state session isn't working-like either, so
    // without an explicit delete here the session would leak forever.
    return { action: "delete", reason: "ack-expired" };
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
