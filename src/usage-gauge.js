"use strict";

const { BrowserWindow } = require("electron");
const path = require("path");
const { keepOutOfTaskbar } = require("./taskbar");

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";

const WIDTH = 236;
const COMPACT_HEIGHT = 72;
const ROW_HEIGHT = 23;
const SHELL = Object.freeze({ top: 2, right: 3, bottom: 8, left: 3 });
const PET_GAP = 4;
const EDGE_MARGIN = 8;
const WIN_TOPMOST_LEVEL = "pop-up-menu";
const LINUX_WINDOW_TYPE = "toolbar";

function clamp(value, min, max) {
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

function computeHeight(snapshot, expanded) {
  if (!expanded) return COMPACT_HEIGHT;
  const rows = Array.isArray(snapshot && snapshot.expanded) ? snapshot.expanded.length : 0;
  return COMPACT_HEIGHT + Math.max(1, rows) * ROW_HEIGHT + 12;
}

function computeUsageGaugeBounds({ hitRect, anchorRect, workArea, position, width = WIDTH, height = COMPACT_HEIGHT }) {
  const followRect = isScreenRect(anchorRect) ? anchorRect : hitRect;
  if (!isScreenRect(followRect) || !workArea) return null;
  const followTop = Math.round(followRect.top);
  const followBottom = Math.round(followRect.bottom);
  const followCx = Math.round((followRect.left + followRect.right) / 2);
  const minX = Math.round(workArea.x + EDGE_MARGIN);
  const maxX = Math.round(workArea.x + workArea.width - width - EDGE_MARGIN);
  let x = clamp(followCx - Math.round(width / 2), minX, maxX);
  if (position === "floating") {
    x = clamp(Math.round(followRect.right + PET_GAP), minX, maxX);
  }
  const minY = Math.round(workArea.y + EDGE_MARGIN);
  const maxY = Math.round(workArea.y + workArea.height - height - EDGE_MARGIN);
  let y;
  if (position === "above") {
    y = clamp(followTop - height - PET_GAP, minY, maxY);
  } else if (position === "floating") {
    y = clamp(Math.round((followTop + followBottom - height) / 2), minY, maxY);
  } else {
    const belowY = followBottom + PET_GAP;
    y = belowY + height <= workArea.y + workArea.height - EDGE_MARGIN
      ? belowY
      : clamp(followTop - height - PET_GAP, minY, maxY);
  }
  return {
    x: x - SHELL.left,
    y: y - SHELL.top,
    width: width + SHELL.left + SHELL.right,
    height: height + SHELL.top + SHELL.bottom,
  };
}

module.exports = function initUsageGauge(ctx) {
  let gaugeWindow = null;
  let didFinishLoad = false;
  let latestSnapshot = null;
  let expanded = false;

  function sendSnapshot() {
    if (!latestSnapshot || !gaugeWindow || gaugeWindow.isDestroyed() || !didFinishLoad) return;
    if (!gaugeWindow.webContents || gaugeWindow.webContents.isDestroyed()) return;
    gaugeWindow.webContents.send("usage-gauge:snapshot", {
      ...latestSnapshot,
      expandedOpen: expanded,
    });
  }

  function ensureWindow() {
    if (gaugeWindow && !gaugeWindow.isDestroyed()) return gaugeWindow;
    if (!ctx.win || ctx.win.isDestroyed()) return null;
    didFinishLoad = false;
    gaugeWindow = new BrowserWindow({
      parent: ctx.win,
      width: WIDTH + SHELL.left + SHELL.right,
      height: COMPACT_HEIGHT + SHELL.top + SHELL.bottom,
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
        preload: path.join(__dirname, "preload-usage-gauge.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    if (isWin) gaugeWindow.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    if (typeof ctx.guardAlwaysOnTop === "function") ctx.guardAlwaysOnTop(gaugeWindow);
    gaugeWindow.loadFile(path.join(__dirname, "usage-gauge.html"));
    gaugeWindow.webContents.once("did-finish-load", () => {
      didFinishLoad = true;
      sync();
    });
    gaugeWindow.on("closed", () => {
      gaugeWindow = null;
      didFinishLoad = false;
    });
    return gaugeWindow;
  }

  function computeBounds() {
    if (!ctx.win || ctx.win.isDestroyed()) return null;
    const petBounds = typeof ctx.getPetWindowBounds === "function" ? ctx.getPetWindowBounds() : null;
    if (!petBounds) return null;
    const hitRect = typeof ctx.getHitRectScreen === "function" ? ctx.getHitRectScreen(petBounds) : null;
    const anchorRect = typeof ctx.getUsageGaugeAnchorRect === "function" ? ctx.getUsageGaugeAnchorRect(petBounds) : null;
    const cx = petBounds.x + petBounds.width / 2;
    const cy = petBounds.y + petBounds.height / 2;
    const workArea = typeof ctx.getNearestWorkArea === "function"
      ? ctx.getNearestWorkArea(cx, cy)
      : { x: 0, y: 0, width: 1280, height: 800 };
    const settings = typeof ctx.getSettings === "function" ? ctx.getSettings() : {};
    const height = computeHeight(latestSnapshot, expanded);
    return computeUsageGaugeBounds({
      hitRect,
      anchorRect,
      workArea,
      position: settings.position || "below",
      height,
    });
  }

  function hide() {
    if (gaugeWindow && !gaugeWindow.isDestroyed()) gaugeWindow.hide();
  }

  function sync(snapshot = latestSnapshot) {
    latestSnapshot = snapshot;
    const settings = typeof ctx.getSettings === "function" ? ctx.getSettings() : {};
    if (!settings || settings.enabled === false || !latestSnapshot || !Array.isArray(latestSnapshot.alwaysOn) || latestSnapshot.alwaysOn.length === 0) {
      hide();
      return;
    }
    if (typeof ctx.petHidden === "function" && ctx.petHidden()) {
      hide();
      return;
    }
    if (typeof ctx.getMiniMode === "function" && ctx.getMiniMode()) {
      hide();
      return;
    }
    if (typeof ctx.getMiniTransitioning === "function" && ctx.getMiniTransitioning()) {
      hide();
      return;
    }
    const win = ensureWindow();
    if (!win || win.isDestroyed()) return;
    const bounds = computeBounds();
    if (!bounds) {
      hide();
      return;
    }
    win.setBounds(bounds);
    sendSnapshot();
    if (!win.isVisible()) {
      win.showInactive();
      keepOutOfTaskbar(win);
      if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
    }
  }

  function showSnapshot(snapshot) {
    latestSnapshot = snapshot;
    sync(snapshot);
  }

  function toggleExpanded() {
    expanded = !expanded;
    sync(latestSnapshot);
  }

  function reposition() {
    sync(latestSnapshot);
  }

  function cleanup() {
    if (gaugeWindow && !gaugeWindow.isDestroyed()) gaugeWindow.destroy();
    gaugeWindow = null;
    didFinishLoad = false;
  }

  return {
    showSnapshot,
    hide,
    reposition,
    toggleExpanded,
    cleanup,
    getWindow: () => gaugeWindow,
  };
};

module.exports.computeUsageGaugeBounds = computeUsageGaugeBounds;
module.exports.computeHeight = computeHeight;
