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

function isLocalTraeDesktopIdleSession(session) {
  return !!session
    && session.agentId === "traecode"
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
    // Local Codex can spend many minutes in one silent model/command segment,
    // especially while the Desktop app is retrying a weak network. Unlike the
    // generic working timeout, this is an explicit user choice. Zero means a
    // silent-but-live local Codex turn is never idled by age alone.
    const configuredCodexTimeout = Number.isFinite(config.codexWorkingStaleMs)
      && config.codexWorkingStaleMs >= 0
      ? config.codexWorkingStaleMs
      : CODEX_LOCAL_WORKING_STALE_FLOOR_MS;
    workingStaleMs = configuredCodexTimeout;
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

  // TraeCode conversations have no SessionEnd event and share the IDE's
  // long-lived process. A live IDE process therefore cannot keep an individual
  // closed conversation alive forever — apply the same configured idle cutoff
  // used for Codex Desktop and ZCode.
  if (
    sessionStaleMs > 0
    && age > sessionStaleMs
    && isLocalTraeDesktopIdleSession(session)
  ) {
    return { action: "delete", reason: "traecode-desktop-idle-timeout" };
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

  // Active-turn silence and idle-card retention are separate clocks. Always
  // settle a working-like session through its effective working timeout first
  // and stamp that transition. Otherwise a 20-minute-old Codex turn can be
  // changed to idle with its old timestamp, then deleted immediately by the
  // ordinary 10-minute idle cutoff on the next sweep.
  //
  // With an age window enabled, only check source liveness after it elapses. A
  // source_pid frequently belongs to a per-event launcher rather than to the
  // session host — Windows Claude Code runs every hook through a throwaway
  // pwsh wrapper, so the pid shipped with an event is already gone when the
  // next sweep reads it. Probing it while the turn is still reporting deletes
  // the live session between events, and the following event recreates it.
  if (isWorkingLikeState(session.state)) {
    const workingWindowElapsed = workingStaleMs > 0 && age > workingStaleMs;
    // Zero disables age-based expiry, not process-death cleanup. In particular,
    // a local Codex session may have only a source PID when agent PID discovery
    // failed, so the earlier agent-exit check cannot retire it on its own.
    if (
      (workingStaleMs === 0 || workingWindowElapsed)
      && session.pidReachable && session.sourcePid && !isProcessAlive(session.sourcePid)
    ) {
      return { action: "delete", reason: "working-source-exit" };
    }
    if (workingWindowElapsed) {
      return { action: "idle", reason: "working-timeout", updateTimestamp: true };
    }
    return { action: null };
  }

  // sessionStaleMs === 0 disables the idle/non-working age cutoff entirely.
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
  isLocalTraeDesktopIdleSession,
  getStaleSessionDecision,
};
