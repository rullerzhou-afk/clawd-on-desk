"use strict";

const {
  animateWindowOpacity: defaultAnimateWindowOpacity,
  setWindowOpacity: defaultSetWindowOpacity,
} = require("./window-opacity-transition");

function isLiveWindow(win) {
  return !!(win && (typeof win.isDestroyed !== "function" || !win.isDestroyed()));
}

function createThemeFadeSequencer(options = {}) {
  const getRenderWindow = options.getRenderWindow || (() => null);
  const getHitWindow = options.getHitWindow || (() => null);
  // #640: "full" opacity is not always 1 — while the pet dodges an editing
  // bubble it sits at a faded value owned by topmost-runtime. Every restore
  // path below asks this at restore time instead of hardcoding 1, so a theme
  // reload mid-edit doesn't snap the pet opaque over the box being typed into.
  const getRestoreOpacity = options.getRestoreOpacity || (() => 1);
  const animateWindowOpacity = options.animateWindowOpacity || defaultAnimateWindowOpacity;
  const setWindowOpacity = options.setWindowOpacity || defaultSetWindowOpacity;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const fadeOutMs = Number.isFinite(options.fadeOutMs) ? options.fadeOutMs : 140;
  const fadeInMs = Number.isFinite(options.fadeInMs) ? options.fadeInMs : 180;
  const fallbackMs = Number.isFinite(options.fallbackMs) ? options.fallbackMs : 4000;

  let sequenceId = 0;
  let fadeFallbackTimer = null;
  let opacityCancelSignal = null;
  let reloadListenerCleanup = null;

  function isCurrent(seq) {
    return seq === sequenceId;
  }

  function restoreOpacity() {
    let value = 1;
    try { value = Number(getRestoreOpacity()); } catch { value = 1; }
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
  }

  function clearFadeFallback() {
    if (fadeFallbackTimer) {
      clearTimeoutFn(fadeFallbackTimer);
      fadeFallbackTimer = null;
    }
  }

  function cancelOpacityAnimation() {
    if (opacityCancelSignal) {
      opacityCancelSignal.cancelled = true;
      opacityCancelSignal = null;
    }
  }

  function clearReloadListeners() {
    if (reloadListenerCleanup) {
      reloadListenerCleanup();
      reloadListenerCleanup = null;
    }
  }

  function scheduleFadeFallback(seq, onFallback) {
    clearFadeFallback();
    fadeFallbackTimer = setTimeoutFn(() => {
      fadeFallbackTimer = null;
      if (!isCurrent(seq)) return;
      if (typeof onFallback === "function") {
        onFallback();
      } else {
        setWindowOpacity(getRenderWindow(), restoreOpacity());
      }
    }, fallbackMs);
  }

  function animateOpacity(seq, targetOpacity, durationMs) {
    if (!isCurrent(seq)) return Promise.resolve(false);
    cancelOpacityAnimation();
    const cancelSignal = { cancelled: false };
    opacityCancelSignal = cancelSignal;
    return Promise.resolve(animateWindowOpacity(getRenderWindow(), targetOpacity, {
      durationMs,
      cancelSignal,
    })).finally(() => {
      if (opacityCancelSignal === cancelSignal) {
        opacityCancelSignal = null;
      }
    });
  }

  function fadeIn(seq) {
    if (!isCurrent(seq)) return;
    clearFadeFallback();
    const target = restoreOpacity();
    animateOpacity(seq, target, fadeInMs).then((ok) => {
      if (!isCurrent(seq)) return;
      if (!ok) {
        setWindowOpacity(getRenderWindow(), restoreOpacity());
        return;
      }
      // #640: the baseline can move WHILE this fade-in runs (the dodge engages
      // or releases mid-animation, racing this loop with its own independent
      // one — separate cancel signals, last writer wins). Whoever finishes
      // last must land on the CURRENT baseline, so re-read it at completion
      // and converge instead of trusting the target chosen at start.
      const finalTarget = restoreOpacity();
      if (finalTarget !== target) setWindowOpacity(getRenderWindow(), finalTarget);
    });
  }

  function reloadAfterFade(seq, onReady, onFallback) {
    if (!isCurrent(seq)) return;
    const renderWin = getRenderWindow();
    const hitWin = getHitWindow();
    if (!isLiveWindow(renderWin) || !isLiveWindow(hitWin)) {
      if (typeof onFallback === "function") onFallback();
      else setWindowOpacity(renderWin, restoreOpacity());
      return;
    }

    clearReloadListeners();
    const renderContents = renderWin.webContents;
    const hitContents = hitWin.webContents;
    renderContents.once("did-finish-load", onReady);
    hitContents.once("did-finish-load", onReady);
    reloadListenerCleanup = () => {
      renderContents.removeListener("did-finish-load", onReady);
      hitContents.removeListener("did-finish-load", onReady);
    };
    scheduleFadeFallback(seq, onFallback);

    try {
      renderContents.reload();
      hitContents.reload();
    } catch {
      if (typeof onFallback === "function") onFallback();
    }
  }

  function run(callbacks = {}) {
    const seq = ++sequenceId;
    cancelOpacityAnimation();
    clearFadeFallback();
    clearReloadListeners();

    let ready = 0;
    let settled = false;
    const finish = (reason) => {
      if (!isCurrent(seq) || settled) return false;
      settled = true;
      clearFadeFallback();
      clearReloadListeners();
      const callback = reason === "fallback" && typeof callbacks.onFallback === "function"
        ? callbacks.onFallback
        : callbacks.onReloadFinished;
      if (typeof callback === "function") callback({ sequenceId: seq, reason });
      fadeIn(seq);
      return true;
    };
    const onReady = () => {
      if (!isCurrent(seq)) return;
      if (++ready < 2) return;
      finish("loaded");
    };

    scheduleFadeFallback(seq, () => finish("fallback"));

    animateOpacity(seq, 0, fadeOutMs).then(() => {
      if (!isCurrent(seq) || settled) return;
      reloadAfterFade(seq, onReady, () => finish("fallback"));
    });

    return seq;
  }

  function cleanup() {
    sequenceId += 1;
    cancelOpacityAnimation();
    clearFadeFallback();
    clearReloadListeners();
  }

  return {
    run,
    cleanup,
    isCurrent,
  };
}

module.exports = createThemeFadeSequencer;
