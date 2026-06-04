"use strict";

// macOS "Hide" → pet visibility bridge (issue #416).
//
// The pet windows are created with setCanHide:NO so they stay put across all
// Spaces and survive app deactivation. The side effect: macOS "Hide" (⌘H /
// Dock right-click → 隐藏) marks the *app* hidden but the windows refuse to
// vanish, so the pet appears to ignore Hide entirely. Worse, an inactive-app
// Dock Hide fires NO `did-resign-active`, so there is no reliable Electron
// event to react to.
//
// Probe (2026-06-04) confirmed that under canHide:NO `app.isHidden()` DOES flip
// true on Hide (windows stay visible) and false on unhide. So we POLL
// app.isHidden() and drive the pet's visibility ourselves, leaving the
// load-bearing window flags untouched. ~250ms poll → up to one tick of latency
// before the pet hides/shows, which is acceptable.

const DEFAULT_POLL_MS = 250;
const MINI_RETRY_MS = 120;
// Safety backstop only. A mini "crabwalk" transition runs walkDist / CRABWALK_SPEED
// ms and can be many seconds on large displays, so the retry must comfortably
// outlast it — it normally stops the instant the transition ends (setPetHidden no
// longer deferred) or a manual/opposite change cancels it. ~60s; hitting it means
// a mini transition never settled (a bug elsewhere) and we warn rather than swallow.
const MINI_RETRY_MAX = 500;

function createMacHideController(options = {}) {
  const isMac = options.isMac != null ? !!options.isMac : process.platform === "darwin";
  const app = options.app || null;
  const getShowDock = options.getShowDock || (() => true);
  const isPetHidden = options.isPetHidden || (() => false);
  const setPetHidden = options.setPetHidden
    || (() => ({ applied: false, deferred: false, changed: false }));
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : DEFAULT_POLL_MS;

  // True only while the pet is hidden *because the OS hid the app*. Cleared on
  // the matching unhide and on any manual hide/show (noteManualChange), so a
  // later activate/unhide never "restores" a deliberate user hide.
  let hiddenByOsHide = false;
  let lastHidden = false;
  let pollTimer = null;
  let miniRetryTimer = null;

  function appIsHidden() {
    try {
      return !!(app && typeof app.isHidden === "function" && app.isHidden());
    } catch (_) {
      return false;
    }
  }

  // Drive the pet to `hidden`; if a mini transition defers it, retry shortly so
  // the pet/OS states reconcile once the transition clears. (mini clears its
  // flag at several sites, so we poll getMiniTransitioning rather than rely on a
  // completion callback.)
  function applyWithMiniRetry(hidden, attempt) {
    if (miniRetryTimer) { clearTimeoutFn(miniRetryTimer); miniRetryTimer = null; }
    const res = setPetHidden(hidden) || {};
    if (!res.deferred) return;
    if (attempt >= MINI_RETRY_MAX) {
      try {
        console.warn(`Clawd: mac-hide gave up applying petHidden=${hidden} after ${attempt} retries (mini transition stuck?)`);
      } catch (_) { /* console may be unavailable */ }
      return;
    }
    miniRetryTimer = setTimeoutFn(() => {
      miniRetryTimer = null;
      applyWithMiniRetry(hidden, attempt + 1);
    }, MINI_RETRY_MS);
    if (miniRetryTimer && typeof miniRetryTimer.unref === "function") miniRetryTimer.unref();
  }

  function onHiddenStateChange(nowHidden) {
    if (nowHidden) {
      // OS hid the app → hide the pet and remember we own this hide.
      hiddenByOsHide = true;
      applyWithMiniRetry(true, 0);
    } else if (hiddenByOsHide) {
      // OS unhid the app (dock click / ⌘Tab) → restore the pet.
      hiddenByOsHide = false;
      applyWithMiniRetry(false, 0);
    }
  }

  function poll() {
    const nowHidden = appIsHidden();
    if (nowHidden !== lastHidden) {
      lastHidden = nowHidden;
      onHiddenStateChange(nowHidden);
    }
  }

  function start() {
    if (!isMac || pollTimer) return;
    lastHidden = appIsHidden();
    pollTimer = setIntervalFn(poll, pollMs);
    if (pollTimer && typeof pollTimer.unref === "function") pollTimer.unref();
  }

  function stop() {
    if (pollTimer) { clearIntervalFn(pollTimer); pollTimer = null; }
    if (miniRetryTimer) { clearTimeoutFn(miniRetryTimer); miniRetryTimer = null; }
  }

  // Call when the user manually changes visibility (tray / shortcut) or when the
  // Dock-visibility setting toggles: release OS-hide ownership.
  function noteManualChange() {
    hiddenByOsHide = false;
    // Cancel any pending OS-hide retry so a stale retry can't re-hide/re-show
    // after the user has manually taken over.
    if (miniRetryTimer) { clearTimeoutFn(miniRetryTimer); miniRetryTimer = null; }
  }

  // Dock-tile click / app reactivation.
  //  - If the app is OS-hidden, unhide it; the poll then restores the pet.
  //  - Else if the pet is manually hidden (and the Dock is visible), treat the
  //    click as an explicit "come back" and restore it.
  function onActivate() {
    if (!isMac) return;
    if (appIsHidden()) {
      try { app.show(); } catch (_) {}
      return;
    }
    if (isPetHidden() && getShowDock()) {
      hiddenByOsHide = false;
      applyWithMiniRetry(false, 0);
    }
  }

  return {
    start,
    stop,
    noteManualChange,
    onActivate,
    // exposed for unit tests
    _poll: poll,
    _onHiddenStateChange: onHiddenStateChange,
    _state: () => ({ hiddenByOsHide, lastHidden }),
  };
}

module.exports = createMacHideController;
