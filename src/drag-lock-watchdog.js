"use strict";

// ── Stuck drag-lock watchdog (#545 follow-up) ──
//
// The hit renderer owns the drag lifecycle: pointerdown sends "drag-lock"
// (true), pointerup/cancel/lostpointercapture/blur send (false). The main
// process trusts that handshake unconditionally — setDragLocked() is a bare
// setter. That trust fails when the hit renderer hangs (unresponsive but not
// gone, so no render-process-gone fires) or the closing mouse-up is swallowed
// (UAC secure desktop, RDP reconnect, fullscreen transition): dragLocked is
// then stranded true, and while it is, syncHitWin() defers forever (the input
// window stops following the pet), recoverIfCloaked() reports "busy", and
// cursor tracking / roam / position-follow are gated off. The user sees the
// pet frozen at a fixed spot, unclickable and undraggable, while the render
// window keeps animating normally — hide/show and bringPetToPrimaryDisplay
// do not clear the lock, so only an app restart used to recover.
//
// Fix: the hit renderer emits a 1s "drag-alive" heartbeat while a drag is
// captured (a held-still mouse generates no moves, so the heartbeat must be
// timer-based, not rAF/move-based; hitWin disables backgroundThrottling so
// the timer is not deferred). If the lock is held but no heartbeat arrived
// within DRAG_STUCK_AFTER_MS, the renderer is provably silent and the main
// process releases the lock itself. A live drag can never trip this: the
// first heartbeat is scheduled in the same pointerdown tick that locks.
//
// The watchdog only *releases main-side state*; it never touches the
// renderer. If the renderer is alive-but-stranded (its isDragging still true
// because the closing event was swallowed, not because it hung), its next
// pointerdown re-locks cleanly and its eventual pointerup re-releases; the
// main.js force-release wrapper additionally pushes "force-drag-release" so
// an alive renderer drops its stale isDragging immediately.

const DEFAULT_STUCK_AFTER_MS = 8_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

function createDragLockWatchdog(options = {}) {
  const isDragLocked = options.isDragLocked;
  const forceRelease = options.forceRelease;
  const getLastDragAliveAt = options.getLastDragAliveAt;
  const now = options.now || (() => Date.now());
  const stuckAfterMs = Number.isFinite(options.stuckAfterMs)
    ? options.stuckAfterMs
    : DEFAULT_STUCK_AFTER_MS;
  const setIntervalFn = options.setIntervalFn || ((cb, ms) => setInterval(cb, ms));
  const clearIntervalFn = options.clearIntervalFn || ((t) => clearInterval(t));
  const log = typeof options.log === "function" ? options.log : () => {};

  if (typeof isDragLocked !== "function" || typeof forceRelease !== "function") {
    throw new Error("createDragLockWatchdog requires isDragLocked and forceRelease");
  }

  let timer = null;

  // Pure check, exported for tests. Returns why the round ended:
  //   "idle"     lock not held — nothing to watch
  //   "unarmed"  no heartbeat source wired — never release on a hunch
  //   "alive"    heartbeat fresh — lock belongs to a live drag
  //   "released" heartbeat stale beyond stuckAfterMs — stranded, release it
  function check() {
    if (!isDragLocked()) return "idle";
    if (typeof getLastDragAliveAt !== "function") return "unarmed";
    const last = getLastDragAliveAt();
    if (!Number.isFinite(last)) return "unarmed";
    const age = now() - last;
    if (age < stuckAfterMs) return "alive";
    log(`drag lock stale (no heartbeat for ${age}ms) — force-releasing`);
    forceRelease("watchdog-stale-heartbeat");
    return "released";
  }

  function start(intervalMs = DEFAULT_POLL_INTERVAL_MS) {
    if (timer !== null) return;
    timer = setIntervalFn(check, intervalMs);
  }

  function stop() {
    if (timer === null) return;
    clearIntervalFn(timer);
    timer = null;
  }

  return { check, start, stop };
}

module.exports = {
  createDragLockWatchdog,
  DEFAULT_STUCK_AFTER_MS,
  DEFAULT_POLL_INTERVAL_MS,
};
