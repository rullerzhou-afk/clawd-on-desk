"use strict";

const {
  applyStationaryCollectionBehavior: defaultApplyStationaryCollectionBehavior,
} = require("./mac-window");
const { animateWindowOpacity } = require("./window-opacity-transition");

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
// #640: while a bubble text field is focused AND the pet visually overlaps that
// bubble, the pet fades to this opacity and its hit window goes click-through.
// The pet lives in the SkyLight private space (always above the editing bubble,
// which drops to the normal level — #626), so until a native de-delegation
// exists this is the polite way to keep the input box readable and clickable.
const IME_EDIT_PET_FADE_OPACITY = 0.18;
const IME_EDIT_PET_FADE_MS = 160;

function isLiveWindow(win) {
  return !!(win && typeof win.isDestroyed === "function" && !win.isDestroyed());
}

function defaultGetter(value) {
  return typeof value === "function" ? value : () => value;
}

// Accepts both rect shapes in use across the codebase: window bounds are
// { x, y, width, height } while hit-geometry rects (getHitRectScreen) are
// { left, top, right, bottom }.
function normalizeRect(rect) {
  if (!rect) return null;
  if (Number.isFinite(rect.x) && Number.isFinite(rect.width)) {
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }
  if (Number.isFinite(rect.left) && Number.isFinite(rect.right)) {
    return { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top };
  }
  return null;
}

function rectsIntersect(rawA, rawB) {
  const a = normalizeRect(rawA);
  const b = normalizeRect(rawB);
  if (!a || !b) return false;
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
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
  // #640: tight screen-space rect of the visible pet sprite (the pet window
  // frame is much larger than what's drawn). Falls back to the window bounds
  // when unset, which only makes the overlap test more conservative.
  const getHitRectScreen = options.getHitRectScreen || (() => null);
  const imeEditingFadeMs = Number.isFinite(options.imeEditingFadeMs)
    ? options.imeEditingFadeMs
    : IME_EDIT_PET_FADE_MS;
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
  // #525: cloak self-heal hook, run at the tail of each watchdog tick. The
  // callee (pet-window-runtime recoverIfCloaked) carries its own guards and
  // exponential backoff; the watchdog only decides WHEN it's appropriate to
  // try at all (see the fullscreen stand-down at the call site).
  const recoverCloakedPet = options.recoverCloakedPet || (() => {});
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
  // #640 editing-overlap dodge state: true while the pet is faded +
  // click-through because it overlaps the bubble being typed into.
  let imeEditingPetDodge = false;
  // Tracked separately from the dodge boolean: the hit window's click-through
  // write is deferred while a drag is in flight (see syncImeEditingPetDodge),
  // so "what we want" and "what we last wrote" can legitimately differ.
  let imeEditingHitIgnoreApplied = false;
  let imeEditingFadeCancel = null;

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
    const applyElectronCrossSpace = (win) => {
      const options = { visibleOnFullScreen: true };
      if (!getShowDock()) options.skipTransformProcessType = true;
      win.setVisibleOnAllWorkspaces(true, options);
    };
    const apply = (win) => {
      if (!isLiveWindow(win)) return;
      const deferUntil = Number(win.__clawdMacDeferredVisibilityUntil) || 0;
      if (deferUntil > Date.now()) return;
      if (deferUntil) delete win.__clawdMacDeferredVisibilityUntil;
      // While a text field inside a bubble is focused it must drop out of
      // always-on-top so the OS IME candidate window can surface (permission.js
      // handleImeEditing sets __clawdMacImeEditing). This branch is the single
      // source of truth for that editing state: force non-topmost, but keep the
      // bubble cross-space visible so switching Spaces mid-edit doesn't strand
      // it. Re-asserting topmost or the native stationary path here would
      // re-occlude the IME, so both are skipped until the flag clears.
      if (win.__clawdMacImeEditing) {
        win.setAlwaysOnTop(false);
        if (win.__clawdMacTextInputBubble) applyElectronCrossSpace(win);
        return;
      }
      win.setAlwaysOnTop(true, MAC_TOPMOST_LEVEL);
      // Text-input bubbles stay cross-space visible via Electron only — the
      // native stationary path (applyStationaryCollectionBehavior) delegates the
      // window into a SkyLight private space that occludes the OS IME candidate
      // window, so it's skipped here (permission.js __clawdMacTextInputBubble).
      if (win.__clawdMacTextInputBubble) {
        applyElectronCrossSpace(win);
        return;
      }
      if (!applyStationaryCollectionBehavior(win)) {
        applyElectronCrossSpace(win);
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
    syncImeEditingPetDodge();
  }

  function findImeEditingBubble() {
    for (const perm of getPendingPermissions() || []) {
      const bubble = perm && perm.bubble;
      if (isLiveWindow(bubble) && bubble.__clawdMacImeEditing) return bubble;
    }
    return null;
  }

  function fadePetWindow(targetOpacity) {
    if (imeEditingFadeCancel) imeEditingFadeCancel.cancelled = true;
    const signal = { cancelled: false };
    imeEditingFadeCancel = signal;
    const win = getWin();
    if (!isLiveWindow(win) || typeof win.setOpacity !== "function") return;
    animateWindowOpacity(win, targetOpacity, {
      durationMs: imeEditingFadeMs,
      cancelSignal: signal,
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
    });
  }

  // #640: while a bubble text field is focused (permission.js handleImeEditing,
  // macOS only) AND the pet sprite overlaps that bubble, the pet politely steps
  // back: its render window fades to IME_EDIT_PET_FADE_OPACITY and the hit
  // window stops intercepting clicks, so the box being typed into stays
  // readable and clickable underneath. The pet stays in the SkyLight private
  // space — always above the editing bubble, which #626 drops to the normal
  // level — so until a native space de-delegation exists (#640 phase 2) this
  // fade is the mitigation. Edge-triggered on the overlap state; every
  // transition path funnels here: handleImeEditing calls reapplyMacVisibility,
  // pet moves call this directly (main.js), and every pendingPermissions
  // add/remove calls this via notifyPermissionsChanged (permission.js) — that
  // last one covers bubbles that leave the list while their text field still
  // holds focus (Enter submit, auto-close), where no blur ever fires.
  // The hit window's ignore-mouse has exactly one other writer — the Windows
  // settings-size-preview protection (pet-window-runtime.js) — which is
  // platform-disjoint with this macOS-only path, so the two never fight.
  // The render window's opacity has one other writer, the theme-switch fade
  // (theme-fade-sequencer.js): its restore target asks getPetTargetOpacity()
  // below instead of assuming 1, so a mid-edit theme reload lands back on the
  // faded value rather than snapping the pet opaque over the input box.
  function syncImeEditingPetDodge() {
    if (!isMac) return;
    const editingBubble = findImeEditingBubble();
    let overlap = false;
    if (editingBubble && typeof editingBubble.getBounds === "function") {
      const petBounds = getPetWindowBounds();
      let petRect = null;
      try { petRect = getHitRectScreen(petBounds); } catch { petRect = null; }
      if (!petRect) petRect = petBounds;
      let bubbleRect = null;
      try { bubbleRect = editingBubble.getBounds(); } catch { bubbleRect = null; }
      overlap = rectsIntersect(petRect, bubbleRect);
    }
    if (overlap !== imeEditingPetDodge) {
      imeEditingPetDodge = overlap;
      fadePetWindow(overlap ? IME_EDIT_PET_FADE_OPACITY : 1);
    }
    // The click-through write is deferred while a drag is in flight: an
    // established macOS mouse-tracking session keeps delivering the drag's
    // events, but Electron's setIgnoreMouseEvents contract makes no promise
    // about toggling mid-gesture — flipping it here could strand the drag
    // with dragLocked stuck true. The fade above still runs mid-drag (that
    // transition is the hands-on-verified experience); the ignore-mouse state
    // is applied on the next sync after the drag ends (pet-interaction-ipc
    // re-runs this on drag-lock release).
    if (isDragLocked()) return;
    if (imeEditingHitIgnoreApplied === imeEditingPetDodge) return;
    const hitWin = getHitWin();
    if (isLiveWindow(hitWin) && typeof hitWin.setIgnoreMouseEvents === "function") {
      hitWin.setIgnoreMouseEvents(imeEditingPetDodge);
      imeEditingHitIgnoreApplied = imeEditingPetDodge;
    }
  }

  // #640: the render window's baseline opacity as far as the dodge is
  // concerned. External opacity writers that restore "full" opacity (the
  // theme-switch fade) must ask this instead of hardcoding 1.
  function getPetTargetOpacity() {
    return imeEditingPetDodge ? IME_EDIT_PET_FADE_OPACITY : 1;
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

      // #525: periodic cloak self-heal. Skipped while standing down for a
      // fullscreen app — recovery calls showInactive()/setAlwaysOnTop, exactly
      // the interference stand-down exists to avoid (§8.3).
      if (!skipTopmost) recoverCloakedPet();

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
    if (imeEditingFadeCancel) {
      imeEditingFadeCancel.cancelled = true;
      imeEditingFadeCancel = null;
    }
  }

  return {
    reassertWinTopmost,
    reapplyMacVisibility,
    syncImeEditingPetDodge,
    getPetTargetOpacity,
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
createTopmostRuntime.IME_EDIT_PET_FADE_OPACITY = IME_EDIT_PET_FADE_OPACITY;
createTopmostRuntime.TOPMOST_WATCHDOG_MS = TOPMOST_WATCHDOG_MS;
createTopmostRuntime.FOCUSABLE_POLL_MS = FOCUSABLE_POLL_MS;
createTopmostRuntime.HWND_RECOVERY_DELAY_MS = HWND_RECOVERY_DELAY_MS;

module.exports = createTopmostRuntime;
