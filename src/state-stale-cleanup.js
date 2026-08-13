"use strict";

const { isCodexDesktopOriginator } = require("../hooks/codex-originator");

const SESSION_STALE_MS = 600000;
const WORKING_STALE_MS = 300000;
const DETACHED_IDLE_STALE_MS = 30000;
const CODEX_LOCAL_WORKING_STALE_FLOOR_MS = 20 * 60 * 1000;
const OPENCODE_LOCAL_WORKING_STALE_FLOOR_MS = 20 * 60 * 1000;

function isWorkingLikeState(state) {
  return state === "working" || state === "juggling" || state === "thinking";
}

function isLocalCodexWorkingLikeSession(session) {
  return !!session
    && session.agentId === "codex"
    && !session.host
    && isWorkingLikeState(session.state);
}

function isLocalOpencodeWorkingLikeSession(session) {
  return !!session
    && session.agentId === "opencode"
    && !session.host
    && !session.headless
    && isWorkingLikeState(session.state);
}

function isLocalCodexDesktopIdleSession(session) {
  return !!session
    && session.agentId === "codex"
    && !session.host
    && !session.headless
    && session.state === "idle"
    && isCodexDesktopOriginator(session.codexOriginator);
}

function isLocalZcodeDesktopIdleSession(session) {
  return !!session
    && session.agentId === "zcode"
    && !session.host
    && !session.headless
    && session.state === "idle";
}

function getStaleSessionDecision(session, options = {}) {
  const now = options.now;
  const config = options.staleConfig || {};
  let sessionStaleMs = Number.isFinite(config.sessionStaleMs)
    ? config.sessionStaleMs
    : SESSION_STALE_MS;
  let workingStaleMs = Number.isFinite(config.workingStaleMs)
    ? config.workingStaleMs
    : WORKING_STALE_MS;
  const detachedIdleStaleMs = Number.isFinite(config.detachedIdleStaleMs)
    ? config.detachedIdleStaleMs
    : DETACHED_IDLE_STALE_MS;

  if (isLocalCodexWorkingLikeSession(session)) {
    // Codex can spend many minutes in one silent model/command segment. Keep
    // the stuck-session guard, but do not let the generic 5/10 minute defaults
    // make an active local Codex turn look idle.
    const floor = (
      Number.isFinite(config.codexLocalWorkingStaleFloorMs)
      && config.codexLocalWorkingStaleFloorMs > 0
    )
      ? config.codexLocalWorkingStaleFloorMs
      : CODEX_LOCAL_WORKING_STALE_FLOOR_MS;
    workingStaleMs = Math.max(workingStaleMs, floor);
    if (sessionStaleMs > 0) sessionStaleMs = Math.max(sessionStaleMs, floor);
  }

  if (isLocalOpencodeWorkingLikeSession(session)) {
    // OpenCode tools can run silently for many minutes (for example, a long
    // shell command). Keep the same bounded stale guard used for local Codex
    // instead of letting the generic five-minute working timeout release the
    // sleep blocker during a legitimate tool call.
    const floor = (
      Number.isFinite(config.opencodeLocalWorkingStaleFloorMs)
      && config.opencodeLocalWorkingStaleFloorMs > 0
    )
      ? config.opencodeLocalWorkingStaleFloorMs
      : OPENCODE_LOCAL_WORKING_STALE_FLOOR_MS;
    workingStaleMs = Math.max(workingStaleMs, floor);
    if (sessionStaleMs > 0) sessionStaleMs = Math.max(sessionStaleMs, floor);
  }

  const isProcessAlive = options.isProcessAlive;

  if (session.pidReachable && session.agentPid && !isProcessAlive(session.agentPid)) {
    return { action: "delete", reason: "agent-exit" };
  }

  // GLOBAL reference time: the stale branches consume Math.max(updatedAt,
  // ackedAt) so a freshly-acked session restarts its idle countdown from the
  // ack instant instead of its (possibly ancient) last updatedAt.
  const referenceTs = Math.max(
    Number(session.updatedAt) || 0,
    Number(session.ackedAt) || 0
  );
  const age = now - referenceTs;

  // Codex Desktop threads share one long-lived app-server PID and do not emit
  // SessionEnd. A live process therefore cannot keep an individual idle thread
  // alive forever; use the existing user-configured idle-age cutoff instead.
  if (
    sessionStaleMs > 0
    && age > sessionStaleMs
    && isLocalCodexDesktopIdleSession(session)
  ) {
    return { action: "delete", reason: "codex-desktop-idle-timeout" };
  }

  // ZCode desktop conversations have no SessionEnd event and can share the
  // app's long-lived app-server PID. Once source_pid is correctly anchored to
  // ZCode.exe, process liveness alone cannot retire an individual closed
  // conversation, so apply the same configured idle cutoff as Codex Desktop.
  if (
    sessionStaleMs > 0
    && age > sessionStaleMs
    && isLocalZcodeDesktopIdleSession(session)
  ) {
    return { action: "delete", reason: "zcode-desktop-idle-timeout" };
  }

  // NOTE: requiresCompletionAck does NOT hold a session out of stale cleanup.
  // The completion notification (e.g. Telegram push) already fires once at the
  // completion instant, so an unacknowledged remote session has already been
  // surfaced — it does not need to linger past the user's configured session
  // timeout to be "seen". The `done` badge (deriveSessionBadge) keeps the
  // session visually distinct while it waits out the normal timeout, then it
  // deletes like any other idle remote session. With sessionStaleMs=0 the
  // session is kept forever, matching a normal idle session. agent-exit above
  // still wins (a dead process is dead).

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
  CODEX_LOCAL_WORKING_STALE_FLOOR_MS,
  OPENCODE_LOCAL_WORKING_STALE_FLOOR_MS,
  isWorkingLikeState,
  isLocalCodexWorkingLikeSession,
  isLocalOpencodeWorkingLikeSession,
  isLocalZcodeDesktopIdleSession,
  getStaleSessionDecision,
};
