"use strict";

const {
  applyStationaryCollectionBehavior: defaultApplyStationaryCollectionBehavior,
} = require("./mac-window");

const WIN_TOPMOST_LEVEL = "pop-up-menu";  // above taskbar-level UI
const MAC_TOPMOST_LEVEL = "screen-saver"; // above fullscreen apps on macOS
const TOPMOST_WATCHDOG_MS = 5_000;
// #562: the hit window's activation (focusable) tracks the fullscreen state on
// its own fast timer, separate from the 5s topmost watchdog. Entering a
// fullscreen game has to flip the hit window non-activating quickly — while it
// still activates, an early click/drag can kick the game out of fullscreen — so
// this polls ~1s instead of riding the slow watchdog (which left a ~5s window).
const FOCUSABLE_POLL_MS = 1_000;
const HWND_RECOVERY_DELAY_MS = 1000;

function isLiveWindow(win) {
  return !!(win && typeof win.isDestroyed === "function" && !win.isDestroyed());
}

function defaultGetter(value) {
  return typeof value === "function" ? value : () => value;
}

function createTopmostRuntime(options = {}) {
  const isWin = options.isWin != null ? !!options.isWin : process.platform === "win32";
  const isMac = options.isMac != null ? !!options.isMac : process.platform === "darwin";
  const getWin = defaultGetter(options.getWin || null);
  const getHitWin = defaultGetter(options.getHitWin || null);
  const getPendingPermissions = options.getPendingPermissions || (() => []);
  const getUpdateBubbleWindow = options.getUpdateBubbleWindow || (() => null);
  const getSessionHudWindow = options.getSessionHudWindow || (() => null);
  const getContextMenuOwner = options.getContextMenuOwner || (() => null);
  const getNearestWorkArea = options.getNearestWorkArea || (() => null);
  const getPetWindowBounds = options.getPetWindowBounds || (() => null);
  const getShowDock = options.getShowDock || (() => true);
  const isDragLocked = options.isDragLocked || (() => false);
  const isMiniAnimating = options.isMiniAnimating || (() => false);
  const isMiniTransitioning = options.isMiniTransitioning || (() => false);
  const applyStationaryCollectionBehavior = options.applyStationaryCollectionBehavior
    || defaultApplyStationaryCollectionBehavior;
  const keepOutOfTaskbar = options.keepOutOfTaskbar || (() => {});
  // Windows-only: when a fullscreen app/game owns the foreground, the watchdog
  // and always-on-top guard stand down so we stop clawing the pet back over it
  // every tick (#538). Defaults to "never fullscreen" so non-Windows and any
  // FFI-load failure keep the original always-reassert behavior.
  const isForegroundFullscreen = options.isForegroundFullscreen || (() => false);
  // Windows-only (#562): when the user opts into fullscreen-overlay mode the pet
  // floats ON TOP of a foreground fullscreen app instead of standing down. The
  // topmost watchdog/guard keep re-asserting (pet stays visible + draggable over
  // e.g. a borderless game); only the focus-stealing activation still stands
  // down so a click can't yank the game's foreground. Defaults off → the
  // original #538 stand-down. Off Windows isForegroundFullscreen is always false
  // so this is moot.
  const getFullscreenOverlay = options.getFullscreenOverlay || (() => false);
  // Windows-only: toggle the hit window's activation with the fullscreen state.
  // While a fullscreen app owns the foreground we make the hit window
  // non-activating so a click on the pet can't steal focus from an
  // exclusive-fullscreen game and minimize it; we re-enable activation when
  // fullscreen ends because dragging needs it (#545). No-op off Windows / when
  // unset. (#538 drag focus-steal)
  const setHitWinFocusable = options.setHitWinFocusable || (() => {});
  const setForceEyeResend = options.setForceEyeResend || (() => {});
  const applyPetWindowPosition = options.applyPetWindowPosition || (() => {});
  const syncHitWin = options.syncHitWin || (() => {});
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const watchdogMs = Number.isFinite(options.watchdogMs) ? options.watchdogMs : TOPMOST_WATCHDOG_MS;
  const focusablePollMs = Number.isFinite(options.focusablePollMs)
    ? options.focusablePollMs
    : FOCUSABLE_POLL_MS;
  const hwndRecoveryDelayMs = Number.isFinite(options.hwndRecoveryDelayMs)
    ? options.hwndRecoveryDelayMs
    : HWND_RECOVERY_DELAY_MS;

  let topmostWatchdog = null;
  let focusablePoll = null;
  let hwndRecoveryTimer = null;
  let pendingNudgeRestore = null;

  function reassertWinTopmost() {
    if (!isWin) return;
    // A fullscreen foreground app owns the screen — stand down so the pet/hit
    // windows don't claw their topmost band back over it. This is the same
    // #538 stand-down the watchdog and always-on-top guard already apply, but
    // it has to live here too: dragging funnels through this function both
    // mid-drag (pet-window-runtime nudges topmost near a work-area edge) and on
    // drag-end, and HWND recovery re-enters it on a timer. Without the guard a
    // single drag would yank the pet back in front of the fullscreen game.
    // #562: in fullscreen-overlay mode keep re-topping over the fullscreen app
    // rather than standing down here (drag funnels through this function).
    if (isForegroundFullscreen() && !getFullscreenOverlay()) return;
    const win = getWin();
    const hitWin = getHitWin();
    if (isLiveWindow(win)) win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    if (isLiveWindow(hitWin)) hitWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
  }

  function reapplyMacVisibility() {
    if (!isMac) return;
    const apply = (win) => {
      if (!isLiveWindow(win)) return;
      const deferUntil = Number(win.__clawdMacDeferredVisibilityUntil) || 0;
      if (deferUntil > Date.now()) return;
      if (deferUntil) delete win.__clawdMacDeferredVisibilityUntil;
      win.setAlwaysOnTop(true, MAC_TOPMOST_LEVEL);
      if (!applyStationaryCollectionBehavior(win)) {
        const options = { visibleOnFullScreen: true };
        if (!getShowDock()) options.skipTransformProcessType = true;
        win.setVisibleOnAllWorkspaces(true, options);
        // First try the native flicker-free path. If Electron's fallback is
        // needed, retry native behavior because Electron can reset collection
        // behavior while changing cross-space visibility.
        applyStationaryCollectionBehavior(win);
      }
    };

    apply(getWin());
    apply(getHitWin());
    for (const perm of getPendingPermissions()) {
      apply(perm && perm.bubble);
    }
    apply(getUpdateBubbleWindow());
    apply(getSessionHudWindow());
    apply(getContextMenuOwner());
  }

  function isNearWorkAreaEdge(bounds, tolerance = 2) {
    if (!bounds) return false;
    const wa = getNearestWorkArea(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    if (!wa) return false;
    return (
      bounds.x <= wa.x + tolerance ||
      bounds.y <= wa.y + tolerance ||
      bounds.x + bounds.width >= wa.x + wa.width - tolerance ||
      bounds.y + bounds.height >= wa.y + wa.height - tolerance
    );
  }

  function scheduleHwndRecovery() {
    if (!isWin) return;
    if (hwndRecoveryTimer) clearTimeoutFn(hwndRecoveryTimer);
    hwndRecoveryTimer = setTimeoutFn(() => {
      hwndRecoveryTimer = null;
      const win = getWin();
      if (!isLiveWindow(win)) return;
      reassertWinTopmost();
      if (!isDragLocked() && !isMiniAnimating() && !isMiniTransitioning()) {
        restorePendingNudge();
      } else {
        pendingNudgeRestore = null;
      }
      setForceEyeResend(true);
    }, hwndRecoveryDelayMs);
  }

  function restorePendingNudge(options = {}) {
    if (!pendingNudgeRestore) return false;
    const pending = pendingNudgeRestore;
    const clear = options.clear !== false;
    const current = getPetWindowBounds();
    if (!current) {
      if (clear) pendingNudgeRestore = null;
      return false;
    }

    const stillAtNudgedPosition = current.x === pending.nudgedX && current.y === pending.y;
    const movedElsewhere = current.x !== pending.x || current.y !== pending.y;
    if (stillAtNudgedPosition) {
      if (clear) pendingNudgeRestore = null;
      applyPetWindowPosition(pending.x, pending.y);
      syncHitWin();
      return true;
    }

    if (movedElsewhere || clear) pendingNudgeRestore = null;
    return false;
  }

  function applyFreshNudge(bounds) {
    if (!bounds) return false;
    pendingNudgeRestore = { x: bounds.x, y: bounds.y, nudgedX: bounds.x + 1 };
    applyPetWindowPosition(bounds.x + 1, bounds.y);
    applyPetWindowPosition(bounds.x, bounds.y);
    return true;
  }

  function guardAlwaysOnTop(winToGuard) {
    if (!isWin || !winToGuard || typeof winToGuard.on !== "function") return;
    winToGuard.on("always-on-top-changed", (_event, isOnTop) => {
      if (isOnTop || !isLiveWindow(winToGuard)) return;
      const renderWin = getWin();
      const hitLayerWin = getHitWin();
      // A fullscreen app legitimately took topmost — don't fight back (no
      // re-top, no 1px nudge, no HWND recovery). The 5s watchdog restores the
      // pet within a cycle once the user leaves fullscreen (#538).
      if ((winToGuard === renderWin || winToGuard === hitLayerWin) && isForegroundFullscreen() && !getFullscreenOverlay()) return;
      if (winToGuard === renderWin) {
        // Re-topping only the render window would re-insert it at the top of
        // the topmost band, briefly leaving the hit window beneath it
        // (z-order inversion). reassertWinTopmost re-tops win then hitWin, so
        // the hit layer lands back above the pet.
        reassertWinTopmost();
      } else {
        winToGuard.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
      }
      if (
        winToGuard === renderWin
        && !isDragLocked()
        && !isMiniAnimating()
        && !isMiniTransitioning()
      ) {
        setForceEyeResend(true);
        const bounds = getPetWindowBounds();
        if (bounds && !pendingNudgeRestore) {
          applyFreshNudge(bounds);
        } else if (pendingNudgeRestore) {
          const handled = restorePendingNudge({ clear: false });
          if (!handled && !pendingNudgeRestore) {
            const fresh = getPetWindowBounds();
            applyFreshNudge(fresh);
          }
        }
        syncHitWin();
        scheduleHwndRecovery();
      }
    });
  }

  function reassertWindowAndTaskbar(win, { skipTopmost = false } = {}) {
    if (!isLiveWindow(win)) return;
    // When a fullscreen app is foreground we skip the topmost re-assert (the
    // part that interrupts the fullscreen app) but still keep the pet out of
    // the taskbar, which is a non-focus-stealing maintenance op.
    if (!skipTopmost) win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    keepOutOfTaskbar(win);
  }

  function startTopmostWatchdog() {
    if (!isWin || topmostWatchdog) return;
    topmostWatchdog = setIntervalFn(() => {
      // Only the pet + hit windows stand down under a fullscreen foreground.
      // Permission bubbles / HUD below are deliberate interruptions the user
      // must act on, so they keep re-asserting even over a fullscreen app.
      // #562: stand down topmost over a fullscreen foreground app UNLESS the
      // user opted into overlay mode (then keep floating on top). The hit
      // window's activation is handled separately on the faster focusable poll
      // (startFocusablePoll) — float-on-top (topmost, here) and don't-steal-
      // focus (focusable, there) are independent decisions (#562).
      const fsForeground = isForegroundFullscreen();
      const skipTopmost = fsForeground && !getFullscreenOverlay();
      reassertWindowAndTaskbar(getWin(), { skipTopmost });
      reassertWindowAndTaskbar(getHitWin(), { skipTopmost });

      for (const perm of getPendingPermissions()) {
        const bubble = perm && perm.bubble;
        if (isLiveWindow(bubble) && bubble.isVisible()) {
          reassertWindowAndTaskbar(bubble);
        }
      }

      const updateBubbleWin = getUpdateBubbleWindow();
      if (isLiveWindow(updateBubbleWin) && updateBubbleWin.isVisible()) {
        reassertWindowAndTaskbar(updateBubbleWin);
      }

      const sessionHudWin = getSessionHudWindow();
      if (isLiveWindow(sessionHudWin) && sessionHudWin.isVisible()) {
        reassertWindowAndTaskbar(sessionHudWin);
      }

      const contextMenuOwner = getContextMenuOwner();
      if (isLiveWindow(contextMenuOwner)) {
        keepOutOfTaskbar(contextMenuOwner);
      }
    }, watchdogMs);
  }

  function stopTopmostWatchdog() {
    if (topmostWatchdog) {
      clearIntervalFn(topmostWatchdog);
      topmostWatchdog = null;
    }
  }

  // #562: drop the hit window's activation whenever a fullscreen app owns the
  // foreground (a click on the pet must never steal focus and kick an
  // exclusive-fullscreen game out), and restore it otherwise (desktop drag
  // needs activation, #545). Runs on its own ~1s timer instead of the 5s
  // watchdog so entering fullscreen flips activation within ~1s — closing the
  // window where an early drag could still kick the game out (#562). Decoupled
  // from the overlay/topmost decision: focus is never stolen from a fullscreen
  // app, overlay or not. setHitWinFocusable is idempotent (no-op unchanged).
  function syncHitWinFocusable() {
    if (!isWin) return;
    setHitWinFocusable(!isForegroundFullscreen());
  }

  function startFocusablePoll() {
    if (!isWin || focusablePoll) return;
    // Sync once up front: if Clawd starts (or this re-arms) while a fullscreen
    // game is already foreground, drop the hit window's activation immediately
    // rather than leaving it activatable for up to one poll interval (the hit
    // window is created focusable: true). Idempotent, so the desktop case is a
    // no-op.
    syncHitWinFocusable();
    focusablePoll = setIntervalFn(syncHitWinFocusable, focusablePollMs);
  }

  function stopFocusablePoll() {
    if (focusablePoll) {
      clearIntervalFn(focusablePoll);
      focusablePoll = null;
    }
  }

  function cleanup() {
    stopTopmostWatchdog();
    stopFocusablePoll();
    if (hwndRecoveryTimer) {
      clearTimeoutFn(hwndRecoveryTimer);
      hwndRecoveryTimer = null;
    }
    pendingNudgeRestore = null;
  }

  return {
    reassertWinTopmost,
    reapplyMacVisibility,
    isNearWorkAreaEdge,
    scheduleHwndRecovery,
    guardAlwaysOnTop,
    startTopmostWatchdog,
    stopTopmostWatchdog,
    startFocusablePoll,
    stopFocusablePoll,
    cleanup,
  };
}

createTopmostRuntime.WIN_TOPMOST_LEVEL = WIN_TOPMOST_LEVEL;
createTopmostRuntime.MAC_TOPMOST_LEVEL = MAC_TOPMOST_LEVEL;
createTopmostRuntime.TOPMOST_WATCHDOG_MS = TOPMOST_WATCHDOG_MS;
createTopmostRuntime.FOCUSABLE_POLL_MS = FOCUSABLE_POLL_MS;
createTopmostRuntime.HWND_RECOVERY_DELAY_MS = HWND_RECOVERY_DELAY_MS;

module.exports = createTopmostRuntime;
