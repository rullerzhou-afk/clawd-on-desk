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

function unionRects(a, b) {
  if (!isValidRect(a)) return isValidRect(b) ? { ...b } : null;
  if (!isValidRect(b)) return { ...a };
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function scaleFactorOf(display) {
  const scale = display && Number(display.scaleFactor);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

// The overlay has to contain BOTH ends of the shot: a hard flick near a seam
// carries the pet onto the neighbouring monitor, and a line that leaves its
// window is simply not drawn.
//
// The one exception is a landing display whose SCALE FACTOR differs from the
// launch display's. A window spanning two displays renders its CSS pixels at a
// single scale factor, so the far half of the line would be drawn at the wrong
// size and offset — worse than being clipped. On such a desk the overlay stays
// on the launch display and the line is cut at the seam; the pet still crosses,
// because where it flies is the runtime's decision, not this window's.
function resolveOverlayBounds(screen, from, to) {
  if (!screen || typeof screen.getDisplayNearestPoint !== "function") return null;
  const displayFor = (point) => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    const display = screen.getDisplayNearestPoint({
      x: Math.round(point.x),
      y: Math.round(point.y),
    });
    return display && isValidRect(display.bounds) ? display : null;
  };
  const launch = displayFor(from);
  if (!launch) return null;
  const landing = displayFor(to);
  if (!landing || sameRect(landing.bounds, launch.bounds)) return { ...launch.bounds };
  if (scaleFactorOf(landing) !== scaleFactorOf(launch)) return { ...launch.bounds };
  return unionRects(launch.bounds, landing.bounds);
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
    const bounds = resolveOverlayBounds(screen, shot.from, shot.to);
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
  unionRects,
};
