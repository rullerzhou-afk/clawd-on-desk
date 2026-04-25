"use strict";

const { BrowserWindow, nativeTheme } = require("electron");
const path = require("path");

const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 600;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 400;
const LIGHT_BACKGROUND = "#f5f5f7";
const DARK_BACKGROUND = "#1c1c1f";

function getDashboardBackgroundColor() {
  return nativeTheme.shouldUseDarkColors ? DARK_BACKGROUND : LIGHT_BACKGROUND;
}

module.exports = function initDashboard(ctx) {
  let dashboardWindow = null;

  function getCurrentSnapshot() {
    return typeof ctx.getSessionSnapshot === "function"
      ? ctx.getSessionSnapshot()
      : { sessions: [], groups: [], orderedIds: [], menuOrderedIds: [] };
  }

  function computeInitialBounds() {
    const petBounds = typeof ctx.getPetWindowBounds === "function"
      ? ctx.getPetWindowBounds()
      : null;
    const cx = petBounds ? petBounds.x + petBounds.width / 2 : 0;
    const cy = petBounds ? petBounds.y + petBounds.height / 2 : 0;
    const workArea = typeof ctx.getNearestWorkArea === "function"
      ? ctx.getNearestWorkArea(cx, cy)
      : { x: 0, y: 0, width: 1280, height: 800 };
    const width = Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, workArea.width));
    const height = Math.min(DEFAULT_HEIGHT, Math.max(MIN_HEIGHT, workArea.height));
    return {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height,
    };
  }

  function sendSnapshot(snapshot = getCurrentSnapshot()) {
    if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
    if (!dashboardWindow.webContents || dashboardWindow.webContents.isDestroyed()) return;
    dashboardWindow.webContents.send("dashboard:session-snapshot", snapshot);
  }

  function sendI18n() {
    if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
    if (!dashboardWindow.webContents || dashboardWindow.webContents.isDestroyed()) return;
    if (typeof ctx.getI18n !== "function") return;
    dashboardWindow.webContents.send("dashboard:lang-change", ctx.getI18n());
  }

  function createDashboardWindow() {
    const bounds = computeInitialBounds();
    const opts = {
      ...bounds,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      frame: true,
      transparent: false,
      resizable: true,
      minimizable: true,
      maximizable: true,
      skipTaskbar: false,
      alwaysOnTop: false,
      title: typeof ctx.t === "function" ? ctx.t("dashboardWindowTitle") : "Sessions",
      backgroundColor: getDashboardBackgroundColor(),
      webPreferences: {
        preload: path.join(__dirname, "preload-dashboard.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    };
    if (ctx.iconPath) opts.icon = ctx.iconPath;

    dashboardWindow = new BrowserWindow(opts);
    dashboardWindow.setMenuBarVisibility(false);
    dashboardWindow.loadFile(path.join(__dirname, "dashboard.html"));
    dashboardWindow.webContents.once("did-finish-load", () => {
      sendI18n();
      sendSnapshot();
    });
    dashboardWindow.once("ready-to-show", () => {
      if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
      dashboardWindow.show();
      dashboardWindow.focus();
    });
    dashboardWindow.on("closed", () => {
      dashboardWindow = null;
    });
    return dashboardWindow;
  }

  function syncThemeBackground() {
    if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
    dashboardWindow.setBackgroundColor(getDashboardBackgroundColor());
  }

  if (nativeTheme && typeof nativeTheme.on === "function") {
    nativeTheme.on("updated", syncThemeBackground);
  }

  function showDashboard() {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      if (dashboardWindow.isMinimized()) dashboardWindow.restore();
      dashboardWindow.show();
      dashboardWindow.focus();
      sendI18n();
      sendSnapshot();
      return dashboardWindow;
    }
    return createDashboardWindow();
  }

  function broadcastSessionSnapshot(snapshot) {
    sendSnapshot(snapshot);
  }

  return {
    showDashboard,
    broadcastSessionSnapshot,
    sendI18n,
    getWindow: () => dashboardWindow,
  };
};
