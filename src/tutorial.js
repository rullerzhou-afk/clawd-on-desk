"use strict";

// First-run onboarding tutorial window. A standalone, dashboard-style wizard
// (welcome → connect/clean up agents → keyboard shortcuts → more features →
// done). The heavy lifting — agent detection, hook install/uninstall, deep-links
// into Settings, persisting the "seen" flag — is delegated to the host via `ctx`
// so this module stays a thin window shell (mirrors src/dashboard.js).

const path = require("path");
const { BrowserWindow, nativeTheme, ipcMain, screen } = require("electron");

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 700;
const MIN_WIDTH = 560;
const MIN_HEIGHT = 600;

function getBackgroundColor() {
  // Match tutorial.html's dark-mode palette to avoid a white flash before the
  // CSS media query kicks in.
  return nativeTheme && nativeTheme.shouldUseDarkColors ? "#1c1c1f" : "#f5f5f7";
}

// Center the window on whichever display currently holds the cursor, falling
// back to the primary display, so the tutorial opens where the user is looking.
function computeCenteredBounds() {
  let work = { x: 0, y: 0, width: 1280, height: 800 };
  try {
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point) || screen.getPrimaryDisplay();
    if (display && display.workArea) work = display.workArea;
  } catch {
    // screen.* can be unavailable very early — defaults above are fine.
  }
  const width = Math.min(DEFAULT_WIDTH, work.width);
  const height = Math.min(DEFAULT_HEIGHT, work.height);
  return {
    width,
    height,
    x: Math.round(work.x + (work.width - width) / 2),
    y: Math.round(work.y + (work.height - height) / 2),
  };
}

module.exports = function initTutorial(ctx = {}) {
  let win = null;
  let ipcReady = false;

  function t(key) {
    return typeof ctx.t === "function" ? ctx.t(key) : key;
  }

  // The full payload the renderer needs to draw every step. Pushed on load and
  // re-pushed after each agent action so step 2 reflects the new install state.
  function buildState() {
    let agents = { install: [], cleanup: [], active: [] };
    try {
      if (typeof ctx.getAgentOnboardingState === "function") {
        agents = ctx.getAgentOnboardingState() || agents;
      }
    } catch (err) {
      console.warn("Clawd: tutorial getAgentOnboardingState failed:", err && err.message);
    }
    return {
      i18n: typeof ctx.getI18n === "function" ? ctx.getI18n() : {},
      lang: typeof ctx.getLang === "function" ? ctx.getLang() : "en",
      langs: typeof ctx.getLangs === "function" ? ctx.getLangs() : [],
      heroSrc: typeof ctx.getHeroSrc === "function" ? ctx.getHeroSrc() : "",
      doneHeroSvg: typeof ctx.getDoneHeroSvg === "function" ? ctx.getDoneHeroSvg() : "",
      platform: process.platform,
      shortcuts: typeof ctx.getShortcutsSummary === "function" ? ctx.getShortcutsSummary() : [],
      agents,
    };
  }

  function sendState() {
    if (!win || win.isDestroyed()) return;
    if (!win.webContents || win.webContents.isDestroyed()) return;
    win.webContents.send("tutorial:state", buildState());
  }

  function applyZoom() {
    if (!win || win.isDestroyed() || !win.webContents) return;
    if (typeof ctx.getTextScale !== "function") return;
    let scale = 1;
    try {
      const v = Number(ctx.getTextScale());
      if (Number.isFinite(v) && v > 0) scale = Math.max(0.5, Math.min(3, v));
    } catch {}
    try { win.webContents.setZoomFactor(scale); } catch {}
  }

  function registerIpcOnce() {
    if (ipcReady) return;
    ipcReady = true;
    // handle() throws if a stale handler lingers (tests/HMR) — clear first.
    ipcMain.removeHandler("tutorial:get-state");
    ipcMain.handle("tutorial:get-state", () => buildState());

    ipcMain.removeHandler("tutorial:install-agent");
    ipcMain.handle("tutorial:install-agent", async (_e, agentId) => {
      const result = typeof ctx.installAgent === "function"
        ? await ctx.installAgent(agentId)
        : { status: "error", message: "install not wired" };
      sendState();
      return result;
    });

    ipcMain.removeHandler("tutorial:uninstall-agent");
    ipcMain.handle("tutorial:uninstall-agent", async (_e, agentId) => {
      const result = typeof ctx.uninstallAgent === "function"
        ? await ctx.uninstallAgent(agentId)
        : { status: "error", message: "uninstall not wired" };
      sendState();
      return result;
    });

    ipcMain.removeHandler("tutorial:register-shortcut");
    ipcMain.handle("tutorial:register-shortcut", async (_e, payload) => {
      const result = typeof ctx.registerShortcut === "function"
        ? await ctx.registerShortcut(payload)
        : { status: "error", message: "register shortcut not wired" };
      sendState();
      return result;
    });

    ipcMain.removeHandler("tutorial:reset-shortcut");
    ipcMain.handle("tutorial:reset-shortcut", async (_e, payload) => {
      const result = typeof ctx.resetShortcut === "function"
        ? await ctx.resetShortcut(payload)
        : { status: "error", message: "reset shortcut not wired" };
      sendState();
      return result;
    });

    ipcMain.removeAllListeners("tutorial:open-settings-tab");
    ipcMain.on("tutorial:open-settings-tab", (_e, tab) => {
      try { if (typeof ctx.openSettingsTab === "function") ctx.openSettingsTab(tab); } catch (err) {
        console.warn("Clawd: tutorial openSettingsTab failed:", err && err.message);
      }
    });

    ipcMain.removeAllListeners("tutorial:set-lang");
    ipcMain.on("tutorial:set-lang", (_e, value) => {
      try { if (typeof ctx.setLang === "function") ctx.setLang(value); } catch (err) {
        console.warn("Clawd: tutorial setLang failed:", err && err.message);
      }
      // Re-push so the wizard re-renders in the newly chosen language.
      sendState();
    });

    ipcMain.removeAllListeners("tutorial:open-shortcuts");
    ipcMain.on("tutorial:open-shortcuts", () => {
      try { if (typeof ctx.openSettingsTab === "function") ctx.openSettingsTab("shortcuts"); } catch (err) {
        console.warn("Clawd: tutorial open shortcuts failed:", err && err.message);
      }
    });

    ipcMain.removeAllListeners("tutorial:finish");
    ipcMain.on("tutorial:finish", () => {
      markSeen();
      close();
    });

    ipcMain.removeAllListeners("tutorial:mark-seen");
    ipcMain.on("tutorial:mark-seen", () => markSeen());
  }

  function markSeen() {
    try { if (typeof ctx.markTutorialSeen === "function") ctx.markTutorialSeen(); } catch (err) {
      console.warn("Clawd: tutorial markTutorialSeen failed:", err && err.message);
    }
  }

  function createWindow() {
    registerIpcOnce();
    const opts = {
      ...computeCenteredBounds(),
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      frame: true,
      transparent: false,
      resizable: true,
      minimizable: true,
      maximizable: false,
      skipTaskbar: false,
      alwaysOnTop: false,
      title: t("tutorialWindowTitle"),
      backgroundColor: getBackgroundColor(),
      webPreferences: {
        preload: path.join(__dirname, "preload-tutorial.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    };
    if (ctx.iconPath) opts.icon = ctx.iconPath;

    win = new BrowserWindow(opts);
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, "tutorial.html"));
    win.webContents.once("did-finish-load", () => {
      applyZoom();
      sendState();
    });
    win.once("ready-to-show", () => {
      if (!win || win.isDestroyed()) return;
      win.show();
      win.focus();
    });
    // Any dismissal — Finish, Skip, or the OS window close button — counts as
    // "seen", so the tutorial never auto-reopens once the user has closed it.
    win.on("close", () => { markSeen(); });
    win.on("closed", () => {
      win = null;
    });
    return win;
  }

  function open() {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      sendState();
      return win;
    }
    return createWindow();
  }

  function close() {
    if (win && !win.isDestroyed()) win.close();
  }

  function syncThemeBackground() {
    if (!win || win.isDestroyed()) return;
    win.setBackgroundColor(getBackgroundColor());
  }
  if (nativeTheme && typeof nativeTheme.on === "function") {
    nativeTheme.on("updated", syncThemeBackground);
  }

  return {
    open,
    close,
    sendState,
    getWindow: () => win,
  };
};
