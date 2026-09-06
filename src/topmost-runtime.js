"use strict";

const {
  applyStationaryCollectionBehavior: defaultApplyStationaryCollectionBehavior,
  deDelegateWindowFromStationarySpace: defaultDeDelegateWindowFromStationarySpace,
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
// #935: how many non-fullscreen focusable-poll ticks an armed manual-show
// override waits for a fullscreen app to bind to before it decays (see
// noteFullscreenAutoHideOverride). Sized to outlast a tray-menu round trip —
// menu open, read, click, refocus the game — while staying far below the gap
// between two distinct fullscreen sessions.
const FSAUTOHIDE_OVERRIDE_GRACE_TICKS = 15;
// When the native probe can only report a fullscreen verdict (plain `true`)
// and not an HWND identity, a manual-show override cannot distinguish the
// original app from the next one. Two consecutive non-fullscreen observations
// are enough to end that anonymous episode without letting one transient probe
// miss immediately re-hide the pet. Most builds report an identity and never
// use this degradation path.
const FSAUTOHIDE_ANONYMOUS_EXIT_TICKS = 2;
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
  const getPermissionPresentationWindows = options.getPermissionPresentationWindows || (() => (
    (getPendingPermissions() || []).map((entry) => entry && entry.bubble).filter(Boolean)
  ));
  const getUpdateBubbleWindow = options.getUpdateBubbleWindow || (() => null);
  const getSessionHudWindow = options.getSessionHudWindow || (() => null);
  const getQuotaRingWindow = options.getQuotaRingWindow || (() => null);
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
  // #640 phase 2: pulls a pet window OUT of the SkyLight private space so it
  // drops to a normal window level and sits BEHIND the editing bubble instead
  // of merely fading. Restore is applyStationaryCollectionBehavior (idempotent).
  const deDelegateWindowFromStationarySpace = options.deDelegateWindowFromStationarySpace
    || defaultDeDelegateWindowFromStationarySpace;
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
  // Companion metadata for the boolean-compatible probe above. A reliable
  // non-fullscreen observation still carries the foreground HWND identity,
  // which lets the manual-show override detect that the SAME window exited
  // F11 without mistaking an Alt-Tab or tray menu for the episode boundary.
  const getForegroundFullscreenObservation = options.getForegroundFullscreenObservation || (() => null);
  // Optional three-state liveness check for a remembered fullscreen HWND:
  // true = still live, false = definitely dead, null = unavailable/error.
  // Only a definite false may clear the episode; failures preserve behavior.
  const isFullscreenWindowAlive = options.isFullscreenWindowAlive || (() => null);
  // Windows-only (#935): opt-in auto-hide — when a fullscreen app owns the
  // foreground, hide the pet entirely instead of floating over (overlay) or
  // standing down below (#538). Rides the 1s focusable poll, which already
  // tracks the fullscreen state at the cadence hiding needs. The writer is
  // pet-window-runtime's setFullscreenAutoHidden (a separate visibility layer
  // stacked on the user's manual hide); defaults keep everything inert when
  // main.js doesn't wire the pref, and off Windows isForegroundFullscreen is
  // constant false.
  const getFullscreenAutoHide = options.getFullscreenAutoHide || (() => false);
  const setFullscreenAutoHidden = options.setFullscreenAutoHidden
    || (() => ({ applied: false, deferred: false, changed: false }));
  const isFullscreenAutoHidden = options.isFullscreenAutoHidden || (() => false);
  // Windows-only: toggle the hit window's activation with the fullscreen state.
  // While a fullscreen app owns the foreground we make the hit window
  // non-activating so a click on the pet can't steal focus from an
  // exclusive-fullscreen game and minimize it; outside fullscreen we restore
  // ordinary desktop activation semantics. No-op off Windows / when unset.
  // (#538 drag focus-steal)
  const setHitWinFocusable = options.setHitWinFocusable || (() => {});
  // #525: cloak self-heal hook, run at the tail of each watchdog tick. The
  // callee (pet-window-runtime recoverIfCloaked) carries its own guards and
  // exponential backoff; the watchdog only decides WHEN it's appropriate to
  // try at all (see the fullscreen stand-down at the call site).
  const recoverCloakedPet = options.recoverCloakedPet || (() => {});
  const setForceEyeResend = options.setForceEyeResend || (() => {});
  const applyPetWindowPosition = options.applyPetWindowPosition || (() => {});
  const syncHitWin = options.syncHitWin || (() => {});
  // I5 (plan §3): the hit window's ignore-mouse state has exactly one writer,
  // pet-window-runtime's applyHitInputState() — this module reports its
  // overlap-dodge intent through the flag instead of calling
  // hitWin.setIgnoreMouseEvents() directly, so a suppressed/petHidden hit
  // window can never be un-suppressed by this path racing a different one.
  const setImeEditingPetDodge = options.setImeEditingPetDodge || (() => {});
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
  // #640 editing-overlap dodge state: true while the pet is stepped back
  // (de-delegated behind, or faded as fallback) + click-through because it
  // overlaps the bubble being typed into.
  let imeEditingPetDodge = false;
  // #640 phase 2: true only while the dodge is active AND native de-delegation
  // was unavailable, so we're falling back to fading the pet rather than
  // dropping it behind the bubble. Drives getPetTargetOpacity so external
  // opacity writers (theme-switch fade) restore the right baseline.
  let imeEditingFadeFallback = false;
  // I5 (plan §3): the local imeEditingHitIgnoreApplied cache this used to
  // keep ("what we want" vs "what we last wrote can legitimately differ
  // while a drag is in flight") is gone — pet-window-runtime's
  // applyHitInputState() is now the single writer with the single cache, so
  // there is nothing left for a second cache to disagree with.
  let imeEditingFadeCancel = null;

  function reassertWinTopmost(fullscreenObservation) {
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
    // Callers already running inside the 1s fullscreen poll can pass its
    // observation through. That keeps the focusability, auto-hide restore,
    // and topmost decision on one native foreground snapshot instead of
    // probing a second time during the same tick.
    const observation = arguments.length > 0
      ? fullscreenObservation
      : isForegroundFullscreen();
    if (shouldStandDownForFullscreen(observation)) return;
    const win = getWin();
    const hitWin = getHitWin();
    if (isLiveWindow(win)) win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    if (isLiveWindow(hitWin)) hitWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
  }

  // The pet is drawn by two stacked windows: the render window (getWin) and the
  // transparent hit window above it (getHitWin). The #640 dodge acts on both.
  function isPetWindow(win) {
    return win === getWin() || win === getHitWin();
  }

  // #640 phase 2: pull both pet windows out of the SkyLight private space so
  // they fall to a normal level and sit behind the editing bubble. Success is
  // judged by the render window (that's what determines visibility / whether the
  // fade fallback is needed); the hit window is de-delegated for click ordering.
  function applyPetDeDelegate() {
    const win = getWin();
    const hitWin = getHitWin();
    let renderDeDelegated = false;
    if (isLiveWindow(win)) renderDeDelegated = deDelegateWindowFromStationarySpace(win, 0);
    if (isLiveWindow(hitWin)) deDelegateWindowFromStationarySpace(hitWin, 0);
    return renderDeDelegated;
  }

  // #640 phase 2: reverse of applyPetDeDelegate — re-delegate both pet windows
  // back into the private space at the assistive-tech level (idempotent).
  function restorePetDelegate() {
    const win = getWin();
    const hitWin = getHitWin();
    if (isLiveWindow(win)) applyStationaryCollectionBehavior(win);
    if (isLiveWindow(hitWin)) applyStationaryCollectionBehavior(hitWin);
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
      // #640 phase 2: while the editing-overlap dodge is active, the pet's
      // render + hit windows must stay OUT of the private space so they sit
      // behind the bubble. Re-running applyStationaryCollectionBehavior below
      // would re-delegate them to the absolute-level space (back on top) every
      // pass; syncImeEditingPetDodge is edge-triggered and wouldn't undo that
      // until the overlap state changed. deDelegate is idempotent, so re-run it.
      if (imeEditingPetDodge && !imeEditingFadeFallback && isPetWindow(win)) {
        deDelegateWindowFromStationarySpace(win, 0);
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
    for (const bubble of getPermissionPresentationWindows()) {
      apply(bubble);
    }
    apply(getUpdateBubbleWindow());
    apply(getSessionHudWindow());
    apply(getQuotaRingWindow());
    apply(getContextMenuOwner());
    syncImeEditingPetDodge();
  }

  // #640 Phase 2: the dodge triggers on the pet OVERLAPPING a text-input bubble
  // (permission.js flags elicitation / ExitPlanMode bubbles __clawdMacTextInputBubble
  // at creation) — NOT merely on a focused text field (__clawdMacImeEditing).
  // Why: #626 deliberately keeps text-input bubbles OUT of the SkyLight private
  // space so the OS IME candidate window can surface, but that same treatment
  // leaves the pet (private space, assistive-tech level) sitting ON TOP of them
  // from the moment they appear — covering the options and the input box before
  // the user ever focuses it. #626 unified both bubble kinds under one model, so
  // the pet must step back for the whole overlapping bubble, not just while
  // typing. (A focused field is a strict subset: those bubbles are text-input
  // bubbles too.) Permission (options-only) bubbles get the same private-space
  // treatment as the pet, so they coexist in one level band and are unaffected.
  function petOverlapsTextInputBubble() {
    let petRect = null;
    let petRectComputed = false;
    for (const perm of getPendingPermissions() || []) {
      const bubble = perm && perm.bubble;
      if (
        !isLiveWindow(bubble)
        || !bubble.__clawdMacTextInputBubble
        || (typeof bubble.isVisible === "function" && !bubble.isVisible())
      ) continue;
      if (typeof bubble.getBounds !== "function") continue;
      if (!petRectComputed) {
        const petBounds = getPetWindowBounds();
        try { petRect = getHitRectScreen(petBounds); } catch { petRect = null; }
        if (!petRect) petRect = petBounds;
        petRectComputed = true;
      }
      let bubbleRect = null;
      try { bubbleRect = bubble.getBounds(); } catch { bubbleRect = null; }
      if (rectsIntersect(petRect, bubbleRect)) return true;
    }
    return false;
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

  // #640: while the pet sprite overlaps a text-input bubble (macOS; see
  // petOverlapsTextInputBubble for why the trigger is overlap, not focus) the
  // pet politely steps back so the bubble — its options AND the box being typed
  // into — stays readable and clickable underneath.
  // Phase 2 (#640): the primary path pulls both pet windows OUT of the SkyLight
  // private space (deDelegateWindowFromStationarySpace) so they drop to a normal
  // level and sit genuinely BEHIND the bubble — fully opaque, just behind. The
  // fade to IME_EDIT_PET_FADE_OPACITY is kept only as a FALLBACK for when native
  // de-delegation is unavailable (FFI load failure returns false). Either way
  // the hit window stops intercepting clicks. Edge-triggered on the overlap
  // state; every
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
    const overlap = petOverlapsTextInputBubble();
    if (overlap !== imeEditingPetDodge) {
      imeEditingPetDodge = overlap;
      if (overlap) {
        // Native path: drop the pet behind the bubble. If it works the pet stays
        // opaque (it's simply behind now); only fall back to fading when
        // de-delegation is unavailable.
        imeEditingFadeFallback = !applyPetDeDelegate();
      } else {
        // Restore the pet to the private space + assistive-tech level.
        restorePetDelegate();
        imeEditingFadeFallback = false;
      }
      fadePetWindow(imeEditingFadeFallback ? IME_EDIT_PET_FADE_OPACITY : 1);
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
    // I5: report intent through the single writer (pet-window-runtime's
    // applyHitInputState()) instead of calling hitWin.setIgnoreMouseEvents()
    // here directly — that function has its own dedup cache, so there's
    // nothing left for this call to do when the value hasn't changed.
    setImeEditingPetDodge(imeEditingPetDodge);
  }

  // #640: the render window's baseline opacity as far as the dodge is
  // concerned. External opacity writers that restore "full" opacity (the
  // theme-switch fade) must ask this instead of hardcoding 1. Phase 2: only the
  // fade FALLBACK lowers opacity; when the pet is de-delegated behind the bubble
  // it stays fully opaque, so the baseline is 1.
  function getPetTargetOpacity() {
    return imeEditingFadeFallback ? IME_EDIT_PET_FADE_OPACITY : 1;
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
    // force:true is the safety line plan §12.12 calls for: the whole point of
    // a nudge is a real native write. Today the two positions always differ
    // physically (Windows-only path, no X virtualization), so the same-rect
    // skip can't swallow them — but if this ever runs where logical X
    // materializes onto a clamped boundary, x+1 and x could collapse to the
    // same physical rect and a non-forced nudge would silently no-op.
    applyPetWindowPosition(bounds.x + 1, bounds.y, { force: true });
    applyPetWindowPosition(bounds.x, bounds.y, { force: true });
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
      if (
        (winToGuard === renderWin || winToGuard === hitLayerWin)
        && shouldStandDownForFullscreen(isForegroundFullscreen())
      ) return;
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
      const skipTopmost = shouldStandDownForFullscreen(fsForeground);
      reassertWindowAndTaskbar(getWin(), { skipTopmost });
      reassertWindowAndTaskbar(getHitWin(), { skipTopmost });

      // #525: periodic cloak self-heal. Skipped while standing down for a
      // fullscreen app — recovery calls showInactive()/setAlwaysOnTop, exactly
      // the interference stand-down exists to avoid (§8.3).
      if (!skipTopmost) recoverCloakedPet();

      for (const bubble of getPermissionPresentationWindows()) {
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

      const quotaRingWin = getQuotaRingWindow();
      if (isLiveWindow(quotaRingWin) && quotaRingWin.isVisible()) {
        reassertWindowAndTaskbar(quotaRingWin);
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
  // exclusive-fullscreen game out), and otherwise restore ordinary desktop
  // activation semantics (#545). Runs on its own ~1s timer instead of the 5s
  // watchdog so entering fullscreen flips activation within ~1s — closing the
  // window where an early drag could still kick the game out (#562). Decoupled
  // from the overlay/topmost decision: focus is never stolen from a fullscreen
  // app, overlay or not. setHitWinFocusable is idempotent (no-op unchanged).
  function syncHitWinFocusable(fullscreenObservation) {
    if (!isWin) return;
    setHitWinFocusable(!fullscreenObservation);
  }

  // #935: edge-triggered fullscreen auto-hide, riding the same 1s poll (the
  // 5s watchdog would leave the pet floating over a game for up to 5s).
  //
  // The override: a manual show (Show Pet in a menu, the toggle hotkey, a
  // second-instance launch) must WIN over the auto-hide until the fullscreen
  // app exits — otherwise the sync yanks the pet away ~1s after the user
  // explicitly asked for it. The writer reports that intent through
  // noteFullscreenAutoHideOverride() (pet-window-runtime's setPetHidden(false)
  // path, wired in main.js) rather than this module inferring it from flag
  // state: reaching a menu takes the foreground off the fullscreen app, so at
  // observation time "fullscreen" is false and the pet was often already
  // auto-restored — an inference from "the flag cleared while fullscreen"
  // never sees the very gesture the setting's description promises about.
  //
  // Lifecycle: while auto-hide is enabled, remember the last concrete
  // fullscreen HWND until that same HWND is reliably observed non-fullscreen.
  // This lets a tray-menu Show bind directly to the episode it came from even
  // when the menu stays open longer than the fallback grace window. If no
  // episode has been observed, the override arms with a grace window measured
  // in poll ticks and binds to the first fullscreen app the probe reports. A
  // bound override holds for that app across foreground excursions to a
  // different HWND — alt-tab and tray menus — plus unreliable probe errors.
  // It ends when that SAME HWND is reliably observed non-fullscreen (a
  // confirmed F11/borderless exit), or when a different fullscreen app takes
  // the foreground: exactly "keeps the pet visible until the next fullscreen
  // episode". An armed override that never sees a fullscreen app decays after
  // the grace window instead of suppressing some future session. Known lean:
  // a show clicked on the plain desktop binds to a fullscreen app started
  // within the grace window and keeps the pet visible for that app's session
  // — erring toward the explicit show. If the
  // probe ever degrades to plain `true` (no per-window identity available),
  // the anonymous bind survives a transient miss but ends after consecutive
  // non-fullscreen observations. That path cannot preserve same-app identity
  // across a long alt-tab, but it cannot suppress auto-hide forever either.
  let fsOverridePendingTicks = 0;
  let fsOverrideBoundTo = null;
  let fsOverrideAnonymousExitTicks = 0;
  let fsLastFullscreenEpisodeId = null;

  function clearFullscreenAutoHideOverride() {
    fsOverridePendingTicks = 0;
    fsOverrideBoundTo = null;
    fsOverrideAnonymousExitTicks = 0;
    fsLastFullscreenEpisodeId = null;
  }

  function clearFullscreenAutoHideOverrideBinding() {
    fsOverridePendingTicks = 0;
    fsOverrideBoundTo = null;
    fsOverrideAnonymousExitTicks = 0;
  }

  function isFullscreenAutoHideOverrideActive(fullscreenObservation) {
    if (!fullscreenObservation || !getFullscreenAutoHide()) return false;
    const fullscreenId = fullscreenObservation || null;
    const hasWindowIdentity = typeof fullscreenId === "string" && fullscreenId.length > 0;
    return fsOverridePendingTicks > 0
      || fsOverrideBoundTo === true
      || (!hasWindowIdentity && fsOverrideBoundTo != null)
      || (hasWindowIdentity && fsOverrideBoundTo === fullscreenId);
  }

  // A manual Show while auto-hide is enabled is an explicit request to keep
  // the pet visible over this fullscreen episode. Even when the older overlay
  // preference is off, that visible pet must stay in the topmost band; otherwise
  // the state says "shown" while an exclusive fullscreen window covers it.
  function shouldStandDownForFullscreen(fullscreenObservation) {
    return !!fullscreenObservation
      && !getFullscreenOverlay()
      && !isFullscreenAutoHideOverrideActive(fullscreenObservation);
  }

  function noteFullscreenAutoHideOverride() {
    if (!getFullscreenAutoHide()) {
      clearFullscreenAutoHideOverride();
      return;
    }
    // A tray or Alt-Tab foreground excursion can last arbitrarily long. When
    // it came from a concrete fullscreen episode, bind to that remembered HWND
    // immediately instead of making the user's Show gesture race a 15s timer.
    // A definitively dead HWND is discarded first, bounding stale state without
    // imposing a TTL that would break legitimate long Alt-Tab excursions.
    if (fsLastFullscreenEpisodeId != null) {
      let alive = null;
      try { alive = isFullscreenWindowAlive(fsLastFullscreenEpisodeId); } catch {}
      if (alive === false) clearFullscreenAutoHideOverride();
    }
    fsOverrideBoundTo = fsLastFullscreenEpisodeId;
    fsOverridePendingTicks = fsOverrideBoundTo == null
      ? FSAUTOHIDE_OVERRIDE_GRACE_TICKS
      : 0;
    fsOverrideAnonymousExitTicks = 0;
  }

  function syncFullscreenAutoHide(fullscreenObservation) {
    if (!isWin) return;
    const fullscreenId = fullscreenObservation || null;
    const hasWindowIdentity = typeof fullscreenId === "string" && fullscreenId.length > 0;
    const autoHideEnabled = !!getFullscreenAutoHide();
    if (!autoHideEnabled) clearFullscreenAutoHideOverride();
    if (fullscreenId != null) {
      if (autoHideEnabled && hasWindowIdentity) {
        fsLastFullscreenEpisodeId = fullscreenId;
      }
      if (autoHideEnabled && fsOverridePendingTicks > 0) {
        fsOverrideBoundTo = hasWindowIdentity ? fullscreenId : true;
      } else if (autoHideEnabled && hasWindowIdentity && fsOverrideBoundTo === true) {
        // The address probe recovered after an identity-less verdict. Adopt
        // the first concrete identity so a later different HWND can end the
        // override normally.
        fsOverrideBoundTo = fullscreenId;
      } else if (
        autoHideEnabled
        && hasWindowIdentity
        && typeof fsOverrideBoundTo === "string"
        && fsOverrideBoundTo !== fullscreenId
      ) {
        // The NEXT fullscreen app: the override's episode is over.
        clearFullscreenAutoHideOverrideBinding();
      }
      fsOverridePendingTicks = 0;
      fsOverrideAnonymousExitTicks = 0;
    } else if (autoHideEnabled && fsOverridePendingTicks > 0) {
      fsOverridePendingTicks -= 1;
    } else if (autoHideEnabled && fsOverrideBoundTo === true) {
      fsOverrideAnonymousExitTicks += 1;
      if (fsOverrideAnonymousExitTicks >= FSAUTOHIDE_ANONYMOUS_EXIT_TICKS) {
        fsOverrideBoundTo = null;
        fsOverrideAnonymousExitTicks = 0;
      }
    } else if (autoHideEnabled && fsLastFullscreenEpisodeId != null) {
      let observation = null;
      try { observation = getForegroundFullscreenObservation(); } catch {}
      if (
        observation
        && observation.reliable === true
        && observation.foregroundId === fsLastFullscreenEpisodeId
      ) {
        // The remembered HWND itself is still foreground but no longer
        // fullscreen: this is a confirmed F11/borderless exit, not an Alt-Tab
        // blip. End the episode so re-entering fullscreen in the same window
        // hides normally and a later desktop Show cannot inherit it.
        clearFullscreenAutoHideOverride();
      }
    }
    const overridden = isFullscreenAutoHideOverrideActive(fullscreenObservation);
    const want = fullscreenId != null && autoHideEnabled && !overridden;
    // A deferred write (mini transition in flight) leaves the flag untouched,
    // so want !== current still holds next tick and the setter is retried.
    if (want !== isFullscreenAutoHidden()) {
      setFullscreenAutoHidden(want, fullscreenObservation);
    }
  }

  function syncFocusablePollTick() {
    // One native observation per tick keeps focusability and visibility on the
    // same foreground snapshot during rapid Alt-Tab/tray transitions.
    const fullscreenObservation = isForegroundFullscreen();
    syncHitWinFocusable(fullscreenObservation);
    syncFullscreenAutoHide(fullscreenObservation);
  }

  function startFocusablePoll() {
    if (!isWin || focusablePoll) return;
    // Sync once up front: if Clawd starts (or this re-arms) while a fullscreen
    // game is already foreground, drop the hit window's activation immediately
    // rather than leaving it activatable for up to one poll interval (the hit
    // window could otherwise retain activating native styles). Idempotent, so
    // the desktop case is a no-op. The #935 auto-hide gets the same up-front
    // reason.
    syncFocusablePollTick();
    focusablePoll = setIntervalFn(syncFocusablePollTick, focusablePollMs);
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
    clearFullscreenAutoHideOverride();
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
    noteFullscreenAutoHideOverride,
    clearFullscreenAutoHideOverride,
    cleanup,
  };
}

createTopmostRuntime.WIN_TOPMOST_LEVEL = WIN_TOPMOST_LEVEL;
createTopmostRuntime.MAC_TOPMOST_LEVEL = MAC_TOPMOST_LEVEL;
createTopmostRuntime.IME_EDIT_PET_FADE_OPACITY = IME_EDIT_PET_FADE_OPACITY;
createTopmostRuntime.TOPMOST_WATCHDOG_MS = TOPMOST_WATCHDOG_MS;
createTopmostRuntime.FOCUSABLE_POLL_MS = FOCUSABLE_POLL_MS;
createTopmostRuntime.FSAUTOHIDE_OVERRIDE_GRACE_TICKS = FSAUTOHIDE_OVERRIDE_GRACE_TICKS;
createTopmostRuntime.FSAUTOHIDE_ANONYMOUS_EXIT_TICKS = FSAUTOHIDE_ANONYMOUS_EXIT_TICKS;
createTopmostRuntime.HWND_RECOVERY_DELAY_MS = HWND_RECOVERY_DELAY_MS;

module.exports = createTopmostRuntime;
