"use strict";

const { BrowserWindow } = require("electron");
const path = require("path");
const { keepOutOfTaskbar } = require("./taskbar");

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";

const HOVER_WIDTH = 236;
const HOVER_HEIGHT = 82;
const HOVER_GAP = 12;
const EDGE_MARGIN = 8;
const WIN_TOPMOST_LEVEL = "pop-up-menu";
const LINUX_WINDOW_TYPE = "toolbar";
const MAC_FLOATING_TOPMOST_DELAY_MS = 120;

function clampToWorkArea(value, min, max) {
  if (max < min) return min;
  return Math.max(min, Math.min(value, max));
}

function isScreenRect(rect) {
  return !!rect
    && Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.right)
    && Number.isFinite(rect.bottom);
}

function computeUsageHoverBounds({
  hitRect,
  anchorRect,
  workArea,
  width = HOVER_WIDTH,
  height = HOVER_HEIGHT,
}) {
  const followRect = isScreenRect(anchorRect) ? anchorRect : hitRect;
  if (!isScreenRect(followRect) || !workArea) return null;

  const minX = Math.round(workArea.x + EDGE_MARGIN);
  const maxX = Math.round(workArea.x + workArea.width - EDGE_MARGIN - width);
  const cx = Math.round((followRect.left + followRect.right) / 2);
  const x = clampToWorkArea(cx - Math.round(width / 2), minX, maxX);

  const minY = Math.round(workArea.y + EDGE_MARGIN);
  const maxY = Math.round(workArea.y + workArea.height - EDGE_MARGIN - height);
  const aboveY = Math.round(followRect.top - HOVER_GAP - height);
  if (aboveY >= minY) {
    return {
      bounds: { x, y: clampToWorkArea(aboveY, minY, maxY), width, height },
      flippedBelow: false,
    };
  }

  const belowY = Math.round(followRect.bottom + HOVER_GAP);
  return {
    bounds: { x, y: clampToWorkArea(belowY, minY, maxY), width, height },
    flippedBelow: true,
  };
}

function formatCompactNumber(value) {
  const n = Number.isFinite(value) && value > 0 ? value : 0;
  if (n >= 1000000000) return `${trimFixed(n / 1000000000)}B`;
  if (n >= 1000000) return `${trimFixed(n / 1000000)}M`;
  if (n >= 1000) return `${trimFixed(n / 1000)}K`;
  return String(Math.round(n));
}

function trimFixed(value) {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

function formatDuration(ms) {
  const minutes = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 60000));
  if (minutes <= 0) return "0m";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0 && mins > 0) return `${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
}

function deferMacFloatingVisibility(ctx, win) {
  if (!isMac || !win || win.isDestroyed()) return;
  const deferUntil = Date.now() + MAC_FLOATING_TOPMOST_DELAY_MS;
  win.__clawdMacDeferredVisibilityUntil = deferUntil;
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    if (win.__clawdMacDeferredVisibilityUntil === deferUntil) {
      delete win.__clawdMacDeferredVisibilityUntil;
    }
    if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
  }, MAC_FLOATING_TOPMOST_DELAY_MS);
}

module.exports = function initUsageHover(ctx) {
  let hoverWindow = null;
  let didFinishLoad = false;
  let hoverRequested = false;
  let latestSnapshot = null;

  function getCurrentSnapshot() {
    return typeof ctx.getUsageSnapshot === "function"
      ? ctx.getUsageSnapshot({ days: 1 })
      : null;
  }

  function getMiniMode() {
    return typeof ctx.getMiniMode === "function" && ctx.getMiniMode();
  }

  function getMiniTransitioning() {
    return typeof ctx.getMiniTransitioning === "function" && ctx.getMiniTransitioning();
  }

  function shouldShow() {
    if (!hoverRequested) return false;
    if (ctx.petHidden) return false;
    if (getMiniMode() || getMiniTransitioning()) return false;
    return true;
  }

  function sendSnapshot(snapshot = latestSnapshot || getCurrentSnapshot()) {
    if (!snapshot || !hoverWindow || hoverWindow.isDestroyed() || !didFinishLoad) return;
    if (!hoverWindow.webContents || hoverWindow.webContents.isDestroyed()) return;
    hoverWindow.webContents.send("usage-hover:snapshot", snapshot);
  }

  function ensureUsageHover() {
    if (hoverWindow && !hoverWindow.isDestroyed()) return hoverWindow;
    if (!ctx.win || ctx.win.isDestroyed()) return null;

    didFinishLoad = false;
    hoverWindow = new BrowserWindow({
      parent: ctx.win,
      width: HOVER_WIDTH,
      height: HOVER_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: !isMac,
      focusable: false,
      hasShadow: false,
      backgroundColor: "#00000000",
      ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
      ...(isMac ? { type: "panel" } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload-usage-hover.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    if (typeof hoverWindow.setIgnoreMouseEvents === "function") {
      hoverWindow.setIgnoreMouseEvents(true, { forward: true });
    }
    if (isWin) hoverWindow.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    if (typeof ctx.guardAlwaysOnTop === "function") ctx.guardAlwaysOnTop(hoverWindow);

    hoverWindow.loadFile(path.join(__dirname, "usage-hover.html"));
    hoverWindow.webContents.once("did-finish-load", () => {
      didFinishLoad = true;
      sendSnapshot();
      syncUsageHover();
    });
    hoverWindow.on("closed", () => {
      hoverWindow = null;
      didFinishLoad = false;
    });
    return hoverWindow;
  }

  function computeBounds() {
    if (!ctx.win || ctx.win.isDestroyed()) return null;
    const petBounds = typeof ctx.getPetWindowBounds === "function" ? ctx.getPetWindowBounds() : null;
    if (!petBounds) return null;
    const hitRect = typeof ctx.getHitRectScreen === "function"
      ? ctx.getHitRectScreen(petBounds)
      : null;
    const cx = petBounds.x + petBounds.width / 2;
    const cy = petBounds.y + petBounds.height / 2;
    const workArea = typeof ctx.getNearestWorkArea === "function"
      ? ctx.getNearestWorkArea(cx, cy)
      : { x: 0, y: 0, width: 1280, height: 800 };
    return computeUsageHoverBounds({ hitRect, workArea });
  }

  function hideUsageHover() {
    if (hoverWindow && !hoverWindow.isDestroyed()) hoverWindow.hide();
  }

  function showUsageHover(win) {
    if (!win || win.isDestroyed() || !didFinishLoad) return;
    if (!win.isVisible()) {
      win.showInactive();
      keepOutOfTaskbar(win);
      if (isMac) deferMacFloatingVisibility(ctx, win);
      else if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
    }
  }

  function syncUsageHover(snapshot = latestSnapshot || getCurrentSnapshot(), options = {}) {
    latestSnapshot = snapshot;
    if (!shouldShow()) {
      hideUsageHover();
      return;
    }
    const win = ensureUsageHover();
    if (!win || win.isDestroyed()) return;
    const computed = computeBounds();
    if (!computed) {
      hideUsageHover();
      return;
    }
    win.setBounds(computed.bounds);
    if (options.sendSnapshot !== false) sendSnapshot(snapshot);
    showUsageHover(win);
  }

  function setHoverVisible(hovered) {
    hoverRequested = !!hovered;
    syncUsageHover();
  }

  function broadcastUsageSnapshot(snapshot) {
    latestSnapshot = snapshot;
    if (hoverWindow && !hoverWindow.isDestroyed() && hoverWindow.isVisible()) {
      sendSnapshot(snapshot);
    }
  }

  function repositionUsageHover() {
    syncUsageHover(latestSnapshot || getCurrentSnapshot(), { sendSnapshot: false });
  }

  function cleanup() {
    if (hoverWindow && !hoverWindow.isDestroyed()) hoverWindow.destroy();
    hoverWindow = null;
    didFinishLoad = false;
    hoverRequested = false;
  }

  return {
    setHoverVisible,
    syncUsageHover,
    repositionUsageHover,
    hideUsageHover,
    broadcastUsageSnapshot,
    cleanup,
    getWindow: () => hoverWindow,
  };
};

module.exports.__test = {
  computeUsageHoverBounds,
  formatCompactNumber,
  formatDuration,
  constants: {
    HOVER_WIDTH,
    HOVER_HEIGHT,
    HOVER_GAP,
    EDGE_MARGIN,
  },
};
