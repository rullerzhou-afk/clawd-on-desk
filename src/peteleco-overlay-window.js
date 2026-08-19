"use strict";

// src/peteleco-overlay-window.js — the aim projection's own window
//
// A transparent, click-through, always-on-top window that exists only while a
// peteleco gesture is being aimed. It has to be a separate window because the
// projection is drawn OUTSIDE the pet: the render window is exactly the pet's
// size, so anything reaching toward the landing spot would be clipped away.
//
// The window is created lazily on the first aim and then reused (hidden, not
// destroyed) — a gesture is short, and paying window-creation latency in the
// middle of one is visible as a missing first frame of the projection.
//
// Coordinates: everything from src/peteleco-geometry.js is in screen DIP, the
// renderer draws in window-local CSS px, and the only conversion is the
// subtraction in show(). Keeping that conversion in one place is why the
// renderer can be a pure view.

const path = require("path");
const { PETELECO_FADE_OUT_MS } = require("./peteleco-geometry");

// Matches session-hud.js's HIDDEN_WINDOW_DESTROY_MS. Same decision, same
// trade-off: a warm window makes the next reveal instant, and low-power mode
// would rather have the memory back.
const HIDDEN_WINDOW_DESTROY_MS = 30000;

function isLiveWindow(win) {
  return !!(win && (typeof win.isDestroyed !== "function" || !win.isDestroyed()));
}

function isValidRect(rect) {
  return !!(
    rect
    && Number.isFinite(rect.x) && Number.isFinite(rect.y)
    && Number.isFinite(rect.width) && Number.isFinite(rect.height)
    && rect.width > 0 && rect.height > 0
  );
}

function sameRect(a, b) {
  return !!(
    a && b
    && a.x === b.x && a.y === b.y
    && a.width === b.width && a.height === b.height
  );
}

// The overlay covers exactly ONE display: the one the pet is on, identified by
// the launch end of the shot.
//
// It deliberately does not stretch to reach a landing point on another monitor.
// A window spanning two displays renders its CSS pixels at a single scale
// factor, so on a mixed-DPI desktop the far half of the line would be drawn in
// the wrong place — worse than not drawing it. The runtime makes the case moot
// anyway by forcing every clamp onto the launch display's work area (see
// beginAim in src/peteleco.js), so both ends of the shot are always here.
function resolveOverlayBounds(screen, from) {
  if (!screen || typeof screen.getDisplayNearestPoint !== "function") return null;
  if (!from || !Number.isFinite(from.x) || !Number.isFinite(from.y)) return null;
  const display = screen.getDisplayNearestPoint({
    x: Math.round(from.x),
    y: Math.round(from.y),
  });
  return display && isValidRect(display.bounds) ? { ...display.bounds } : null;
}

function createPetelecoOverlayWindow(options = {}) {
  const BrowserWindow = options.BrowserWindow;
  const screen = options.screen;
  const isMac = !!options.isMac;
  const isWin = !!options.isWin;
  const isLinux = !!options.isLinux;
  const linuxWindowType = options.linuxWindowType || "toolbar";
  const topmostLevel = options.topmostLevel || "pop-up-menu";
  const keepOutOfTaskbar = options.keepOutOfTaskbar || (() => {});
  const logWarn = options.logWarn || (() => {});
  const preloadPath = options.preloadPath || path.join(__dirname, "preload-peteleco-overlay.js");
  const loadFilePath = options.loadFilePath || path.join(__dirname, "peteleco-overlay.html");

  const schedule = options.setTimeout || setTimeout;
  const unschedule = options.clearTimeout || clearTimeout;
  const isLowPowerIdleMode = options.isLowPowerIdleMode || (() => false);

  let win = null;
  let currentBounds = null;
  let visible = false;
  let fadeTimer = null;
  let hiddenDestroyTimer = null;

  function clearFadeTimer() {
    if (fadeTimer === null) return;
    unschedule(fadeTimer);
    fadeTimer = null;
  }

  function cancelHiddenDestroy() {
    if (hiddenDestroyTimer === null) return;
    unschedule(hiddenDestroyTimer);
    hiddenDestroyTimer = null;
  }

  // Mirrors session-hud.js's scheduleHiddenDestroy(): the overlay is kept warm
  // by default, because building a window in the middle of a gesture costs the
  // first frame of the projection. Under low-power idle mode a screen-sized,
  // always-on-top, transparent window that may not be used again all session is
  // exactly the kind of thing the user asked to reclaim.
  function scheduleHiddenDestroy() {
    if (!isLowPowerIdleMode()) return;
    if (hiddenDestroyTimer !== null) return;
    if (!isLiveWindow(win) || visible) return;
    hiddenDestroyTimer = schedule(() => {
      hiddenDestroyTimer = null;
      // Re-check both: the user may have left low-power mode, or started a new
      // gesture, while the window sat hidden.
      if (!isLowPowerIdleMode()) return;
      if (!isLiveWindow(win) || visible) return;
      destroy();
    }, HIDDEN_WINDOW_DESTROY_MS);
  }

  function ensureWindow(bounds) {
    if (typeof BrowserWindow !== "function" || !isValidRect(bounds)) return null;
    if (!isLiveWindow(win)) {
      win = null;
      currentBounds = null;
      visible = false;
      try {
        win = new BrowserWindow({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          show: false,
          frame: false,
          transparent: true,
          resizable: false,
          movable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          skipTaskbar: true,
          alwaysOnTop: true,
          focusable: false,
          hasShadow: false,
          backgroundColor: "#00000000",
          enableLargerThanScreen: true,
          ...(isLinux ? { type: linuxWindowType } : {}),
          ...(isMac ? { type: "panel", roundedCorners: false } : {}),
          webPreferences: {
            preload: preloadPath,
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: false,
          },
        });
      } catch (err) {
        logWarn(`Clawd: peteleco overlay window failed: ${(err && err.message) || err}`);
        win = null;
        return null;
      }
      currentBounds = { ...bounds };
      // The overlay is decoration, never a target. Without this it would eat
      // the very pointer events the gesture is made of.
      try { win.setIgnoreMouseEvents(true, { forward: false }); } catch (_) {}
      if (typeof win.setFocusable === "function") {
        try { win.setFocusable(false); } catch (_) {}
      }
      if (isWin && typeof win.setAlwaysOnTop === "function") {
        try { win.setAlwaysOnTop(true, topmostLevel); } catch (_) {}
      }
      win.on("closed", () => {
        win = null;
        currentBounds = null;
        visible = false;
      });
      try { win.loadFile(loadFilePath); } catch (err) {
        logWarn(`Clawd: peteleco overlay load failed: ${(err && err.message) || err}`);
      }
      return win;
    }
    if (!sameRect(currentBounds, bounds)) {
      try {
        win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
        currentBounds = { ...bounds };
      } catch (err) {
        logWarn(`Clawd: peteleco overlay resize failed: ${(err && err.message) || err}`);
      }
    }
    return win;
  }

  function send(channel, payload) {
    if (!isLiveWindow(win)) return;
    const contents = win.webContents;
    if (!contents || (typeof contents.isDestroyed === "function" && contents.isDestroyed())) return;
    try { contents.send(channel, payload); } catch (_) {}
  }

  // shot: a computeAim() result (screen coordinates).
  function show(shot) {
    if (!shot || !shot.from || !shot.to) return false;
    // A new gesture during a fade takes the window back; the renderer drops the
    // fading class on redraw, so only the pending hide needs cancelling.
    clearFadeTimer();
    cancelHiddenDestroy();
    const bounds = resolveOverlayBounds(screen, shot.from);
    if (!bounds) return false;
    const target = ensureWindow(bounds);
    if (!target) return false;

    send("peteleco:projection", {
      from: { x: shot.from.x - bounds.x, y: shot.from.y - bounds.y },
      to: { x: shot.to.x - bounds.x, y: shot.to.y - bounds.y },
      power: shot.power,
      // Lets the renderer keep the shaft clear of the sprite without knowing
      // anything about pet sizing.
      petSize: shot.target
        ? Math.min(shot.target.width, shot.target.height)
        : null,
    });

    if (!visible) {
      try {
        if (typeof target.showInactive === "function") target.showInactive();
        else target.show();
        keepOutOfTaskbar(target);
        if (isWin && typeof target.setAlwaysOnTop === "function") {
          target.setAlwaysOnTop(true, topmostLevel);
        }
      } catch (err) {
        logWarn(`Clawd: peteleco overlay show failed: ${(err && err.message) || err}`);
        return false;
      }
      visible = true;
    }
    return true;
  }

  // Immediate teardown — for a cancelled gesture, where the projection must
  // stop describing a shot that is not going to happen.
  function hide() {
    clearFadeTimer();
    if (!isLiveWindow(win)) {
      visible = false;
      return false;
    }
    // Armed even when the window was already hidden: a cancelled gesture that
    // never showed anything still leaves a warm window behind.
    scheduleHiddenDestroy();
    // Clear before hiding: the window is reused, and a stale line would flash
    // for one frame at the start of the next gesture.
    send("peteleco:clear");
    if (!visible) return false;
    try { win.hide(); } catch (_) {}
    visible = false;
    scheduleHiddenDestroy();
    return true;
  }

  // Release teardown: the line stays up and dissolves while the pet flies, then
  // the window goes away. Falls back to an immediate hide when there is nothing
  // on screen to dissolve.
  function fadeOut() {
    if (!visible || !isLiveWindow(win)) return hide();
    clearFadeTimer();
    send("peteleco:fade");
    fadeTimer = schedule(() => {
      fadeTimer = null;
      hide();
    }, PETELECO_FADE_OUT_MS);
    return true;
  }

  function destroy() {
    clearFadeTimer();
    cancelHiddenDestroy();
    if (!isLiveWindow(win)) {
      win = null;
      visible = false;
      currentBounds = null;
      return;
    }
    try { win.destroy(); } catch (_) {}
    win = null;
    visible = false;
    currentBounds = null;
  }

  return {
    show,
    hide,
    fadeOut,
    destroy,
    isVisible: () => visible,
    getWindow: () => win,
  };
}

module.exports = {
  createPetelecoOverlayWindow,
  resolveOverlayBounds,
};
