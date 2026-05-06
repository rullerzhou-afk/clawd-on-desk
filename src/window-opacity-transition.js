"use strict";

function clampOpacity(value) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

function isUsableWindow(win) {
  if (!win || typeof win.setOpacity !== "function") return false;
  if (typeof win.isDestroyed === "function" && win.isDestroyed()) return false;
  return true;
}

function getWindowOpacity(win) {
  if (!win || typeof win.getOpacity !== "function") return 1;
  try {
    return clampOpacity(win.getOpacity());
  } catch {
    return 1;
  }
}

function setWindowOpacity(win, value) {
  if (!isUsableWindow(win)) return false;
  try {
    win.setOpacity(clampOpacity(value));
    return true;
  } catch {
    return false;
  }
}

function easeInOut(t) {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5 ? 2 * x * x : 1 - ((-2 * x + 2) ** 2) / 2;
}

function isCancelled(signal) {
  return !!(signal && signal.cancelled);
}

function animateWindowOpacity(win, targetOpacity, options = {}) {
  if (!isUsableWindow(win)) return Promise.resolve(false);

  const durationMs = Math.max(0, Number(options.durationMs) || 0);
  const frameMs = Math.max(1, Number(options.frameMs) || 16);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const setTimer = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;
  const cancelSignal = options.cancelSignal || null;
  const from = getWindowOpacity(win);
  const to = clampOpacity(targetOpacity);

  if (isCancelled(cancelSignal)) return Promise.resolve(false);

  if (durationMs <= 0 || Math.abs(from - to) < 0.001) {
    return Promise.resolve(setWindowOpacity(win, to));
  }

  const startedAt = now();
  return new Promise((resolve) => {
    let timer = null;
    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
      resolve(ok);
    };

    const step = () => {
      if (isCancelled(cancelSignal)) {
        finish(false);
        return;
      }
      if (!isUsableWindow(win)) {
        finish(false);
        return;
      }
      const elapsed = Math.max(0, now() - startedAt);
      const progress = Math.min(1, elapsed / durationMs);
      const nextOpacity = from + (to - from) * easeInOut(progress);
      if (!setWindowOpacity(win, progress >= 1 ? to : nextOpacity)) {
        finish(false);
        return;
      }
      if (progress >= 1) {
        finish(true);
        return;
      }
      timer = setTimer(step, frameMs);
    };

    step();
  });
}

module.exports = {
  animateWindowOpacity,
  clampOpacity,
  setWindowOpacity,
};
