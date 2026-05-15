"use strict";

const {
  applyStationaryCollectionBehavior: defaultApplyStationaryCollectionBehavior,
} = require("./mac-window");

const WIN_TOPMOST_LEVEL = "pop-up-menu";  // above taskbar-level UI
const MAC_TOPMOST_LEVEL = "screen-saver"; // above fullscreen apps on macOS
const TOPMOST_WATCHDOG_MS = 5_000;
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
  const setForceEyeResend = options.setForceEyeResend || (() => {});
  const applyPetWindowPosition = options.applyPetWindowPosition || (() => {});
  const syncHitWin = options.syncHitWin || (() => {});
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const watchdogMs = Number.isFinite(options.watchdogMs) ? options.watchdogMs : TOPMOST_WATCHDOG_MS;
  const hwndRecoveryDelayMs = Number.isFinite(options.hwndRecoveryDelayMs)
    ? options.hwndRecoveryDelayMs
    : HWND_RECOVERY_DELAY_MS;

  let topmostWatchdog = null;
  let hwndRecoveryTimer = null;
  let pendingNudgeRestore = null;

  function reassertWinTopmost() {
    if (!isWin) return;
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
      winToGuard.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
      if (
        winToGuard === getWin()
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

  function reassertWindowAndTaskbar(win) {
    if (!isLiveWindow(win)) return;
    win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    keepOutOfTaskbar(win);
  }

  function startTopmostWatchdog() {
    if (!isWin || topmostWatchdog) return;
    topmostWatchdog = setIntervalFn(() => {
      reassertWindowAndTaskbar(getWin());
      reassertWindowAndTaskbar(getHitWin());

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

  function cleanup() {
    stopTopmostWatchdog();
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
    cleanup,
  };
}

createTopmostRuntime.WIN_TOPMOST_LEVEL = WIN_TOPMOST_LEVEL;
createTopmostRuntime.MAC_TOPMOST_LEVEL = MAC_TOPMOST_LEVEL;
createTopmostRuntime.TOPMOST_WATCHDOG_MS = TOPMOST_WATCHDOG_MS;
createTopmostRuntime.HWND_RECOVERY_DELAY_MS = HWND_RECOVERY_DELAY_MS;

module.exports = createTopmostRuntime;
