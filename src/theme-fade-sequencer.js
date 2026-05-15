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
        setWindowOpacity(getRenderWindow(), 1);
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
    animateOpacity(seq, 1, fadeInMs).then((ok) => {
      if (!ok && isCurrent(seq)) setWindowOpacity(getRenderWindow(), 1);
    });
  }

  function reloadAfterFade(seq, onReady, onFallback) {
    if (!isCurrent(seq)) return;
    const renderWin = getRenderWindow();
    const hitWin = getHitWindow();
    if (!isLiveWindow(renderWin) || !isLiveWindow(hitWin)) {
      if (typeof onFallback === "function") onFallback();
      else setWindowOpacity(renderWin, 1);
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
