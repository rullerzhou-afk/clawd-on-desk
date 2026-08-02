"use strict";

const DEFAULT_BALLOON_TTL_MS = 30_000;

function createTrayBalloonOwner(options = {}) {
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0
    ? options.ttlMs
    : DEFAULT_BALLOON_TTL_MS;
  let activeCleanup = null;

  function dispose() {
    if (activeCleanup) activeCleanup();
  }

  function show(tray, payload = {}) {
    if (!tray
      || typeof tray.displayBalloon !== "function"
      || typeof tray.once !== "function"
      || typeof tray.removeListener !== "function") {
      return false;
    }
    dispose();

    let active = true;
    let timer = null;
    const cleanup = () => {
      if (!active) return;
      active = false;
      tray.removeListener("balloon-click", handleClick);
      tray.removeListener("balloon-closed", handleClosed);
      if (timer) clearTimer(timer);
      timer = null;
      if (activeCleanup === cleanup) activeCleanup = null;
    };
    const handleClick = () => {
      cleanup();
      if (typeof payload.onClick === "function") {
        try { payload.onClick(); } catch {}
      }
    };
    const handleClosed = () => cleanup();

    activeCleanup = cleanup;
    tray.once("balloon-click", handleClick);
    tray.once("balloon-closed", handleClosed);
    try {
      tray.displayBalloon({
        iconType: payload.iconType || "warning",
        title: String(payload.title || ""),
        content: String(payload.content || ""),
      });
    } catch (err) {
      cleanup();
      throw err;
    }
    if (active) {
      timer = setTimer(cleanup, ttlMs);
      if (timer && typeof timer.unref === "function") timer.unref();
    }
    return true;
  }

  return { show, dispose };
}

module.exports = {
  DEFAULT_BALLOON_TTL_MS,
  createTrayBalloonOwner,
};
