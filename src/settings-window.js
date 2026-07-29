"use strict";

const defaultFs = require("fs");
const defaultPath = require("path");

const {
  SETTINGS_WINDOW_TITLE,
  getSettingsWindowIconPath,
  getSettingsWindowTaskbarDetails,
} = require("./settings-window-icon");
const { clampTextScale, scaleWidth, scaleHeight, applyZoomToWindow } = require("./text-scale");

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 560;
const MIN_WIDTH = 640;
const MIN_HEIGHT = 480;
const READY_TO_SHOW_FALLBACK_MS = 2000;
const SETTINGS_FRONT_LIFT_MS = 200;
const FALLBACK_WORK_AREA = { x: 0, y: 0, width: 1280, height: 800 };

function requiredDependency(value, name) {
  if (!value) throw new Error(`createSettingsWindowRuntime requires ${name}`);
  return value;
}

function isUsableBounds(bounds) {
  return !!bounds
    && Number.isFinite(bounds.x)
    && Number.isFinite(bounds.y)
    && Number.isFinite(bounds.width)
    && Number.isFinite(bounds.height)
    && bounds.width > 0
    && bounds.height > 0;
}

function normalizeWorkArea(workArea) {
  return isUsableBounds(workArea) ? workArea : FALLBACK_WORK_AREA;
}

function clampBoundsToWorkArea(bounds, workArea) {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  const minX = workArea.x;
  const minY = workArea.y;
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;
  return {
    x: Math.round(Math.min(Math.max(bounds.x, minX), maxX)),
    y: Math.round(Math.min(Math.max(bounds.y, minY), maxY)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function createSettingsWindowRuntime(options = {}) {
  const app = requiredDependency(options.app, "app");
  const BrowserWindow = requiredDependency(options.BrowserWindow, "BrowserWindow");
  const nativeTheme = requiredDependency(options.nativeTheme, "nativeTheme");
  const fs = options.fs || defaultFs;
  const path = options.path || defaultPath;
  const platform = options.platform || process.platform;
  const isWin = options.isWin != null ? !!options.isWin : platform === "win32";
  const resourcesPath = options.resourcesPath || process.resourcesPath;
  const execPath = options.execPath || process.execPath;
  const appDir = options.appDir || path.join(__dirname, "..");
  const settingsHtmlPath = options.settingsHtmlPath || path.join(__dirname, "settings.html");
  const preloadPath = options.preloadPath || path.join(__dirname, "preload-settings.js");
  const discordDefaultAppIdPresent = !!options.discordDefaultAppIdPresent;
  const scheduleLater = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const clearScheduled = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;

  let settingsWindow = null;
  let readyToShowFallbackTimer = null;
  let liftTimer = null;
  let showPendingSettingsWindow = null;

  function getWindow() {
    return settingsWindow;
  }

  function isLiveWindow(win) {
    return !!win && (typeof win.isDestroyed !== "function" || !win.isDestroyed());
  }

  function scheduleTimer(callback, delayMs) {
    const timer = scheduleLater(callback, delayMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    return timer;
  }

  function clearReadyToShowFallbackTimer() {
    if (!readyToShowFallbackTimer) return;
    clearScheduled(readyToShowFallbackTimer);
    readyToShowFallbackTimer = null;
  }

  function clearLiftTimer() {
    if (!liftTimer) return;
    clearScheduled(liftTimer);
    liftTimer = null;
  }

  function getIconPath() {
    return getSettingsWindowIconPath({
      platform,
      isPackaged: app.isPackaged,
      resourcesPath,
      appDir,
      existsSync: fs.existsSync,
    });
  }

  function getTaskbarDetails() {
    return getSettingsWindowTaskbarDetails({
      platform,
      isPackaged: app.isPackaged,
      resourcesPath,
      appDir,
      execPath,
      appPath: app.getAppPath(),
      existsSync: fs.existsSync,
    });
  }

  function computeInitialBounds() {
    let cx = 0;
    let cy = 0;
    if (typeof options.getPetWindowBounds === "function") {
      try {
        const petBounds = options.getPetWindowBounds();
        if (isUsableBounds(petBounds)) {
          cx = petBounds.x + petBounds.width / 2;
          cy = petBounds.y + petBounds.height / 2;
        }
      } catch {}
    }

    let workArea = FALLBACK_WORK_AREA;
    if (typeof options.getNearestWorkArea === "function") {
      try {
        workArea = normalizeWorkArea(options.getNearestWorkArea(cx, cy));
      } catch {
        workArea = FALLBACK_WORK_AREA;
      }
    }

    const scale = getTextScale();
    const width = Math.min(scaleWidth(DEFAULT_WIDTH, scale), Math.max(1, workArea.width));
    const height = Math.min(scaleHeight(DEFAULT_HEIGHT, scale), Math.max(1, workArea.height));
    return clampBoundsToWorkArea({
      x: workArea.x + (workArea.width - width) / 2,
      y: workArea.y + (workArea.height - height) / 2,
      width,
      height,
    }, workArea);
  }

  function getTextScale() {
    return clampTextScale(typeof options.getTextScale === "function" ? options.getTextScale() : 1);
  }

  function getTitle() {
    if (typeof options.getTitle !== "function") return SETTINGS_WINDOW_TITLE;
    try {
      const title = options.getTitle();
      return typeof title === "string" && title ? title : SETTINGS_WINDOW_TITLE;
    } catch {
      return SETTINGS_WINDOW_TITLE;
    }
  }

  function applyTitleToWindow() {
    const win = getWindow();
    if (!isLiveWindow(win) || typeof win.setTitle !== "function") return;
    win.setTitle(getTitle());
  }

  // The text-scale slider shows the committed percent of the display this
  // window sits on, which it can only learn via getTextScaleContext() — a
  // display change never goes through the settings store, so without this
  // poke the slider keeps showing the previous display's value (and a nudge
  // would commit from that stale base).
  function notifyTextScaleContextChanged(win) {
    const wc = win && win.webContents;
    if (!wc || (typeof wc.isDestroyed === "function" && wc.isDestroyed())) return;
    if (typeof wc.send !== "function") return;
    try { wc.send("settings:text-scale-context-changed"); } catch {}
  }

  // textScale changed while settings is open: re-zoom, raise the minimum
  // size, and only grow the window if it now sits below that minimum — never
  // touch a user-chosen size otherwise.
  function applyTextScaleToWindow() {
    const win = getWindow();
    if (!isLiveWindow(win)) return;
    const scale = getTextScale();
    applyZoomToWindow(win, scale);
    notifyTextScaleContextChanged(win);
    const minW = scaleWidth(MIN_WIDTH, scale);
    const minH = scaleHeight(MIN_HEIGHT, scale);
    if (typeof win.setMinimumSize === "function") win.setMinimumSize(minW, minH);
    const bounds = typeof win.getBounds === "function" ? win.getBounds() : null;
    if (bounds && (bounds.width < minW || bounds.height < minH)) {
      win.setBounds({
        ...bounds,
        width: Math.max(bounds.width, minW),
        height: Math.max(bounds.height, minH),
      });
    }
  }

  function temporarilyLiftSettingsWindow(win) {
    if (!isWin || !isLiveWindow(win) || typeof win.setAlwaysOnTop !== "function") return false;
    clearLiftTimer();
    win.setAlwaysOnTop(true);
    if (typeof win.moveTop === "function") win.moveTop();
    liftTimer = scheduleTimer(() => {
      liftTimer = null;
      if (isLiveWindow(win) && typeof win.setAlwaysOnTop === "function") {
        win.setAlwaysOnTop(false);
      }
    }, SETTINGS_FRONT_LIFT_MS);
    return true;
  }

  function showAndFocusSettingsWindow(win, showOptions = {}) {
    if (!isLiveWindow(win)) return false;
    if (
      showOptions.restoreMinimized
      && typeof win.isMinimized === "function"
      && win.isMinimized()
      && typeof win.restore === "function"
    ) {
      win.restore();
    }
    if (typeof win.show === "function") win.show();
    const lifted = temporarilyLiftSettingsWindow(win);
    if (!lifted && typeof win.moveTop === "function") win.moveTop();
    if (typeof win.focus === "function") win.focus();
    return true;
  }

  function openWhenReady() {
    if (app.isReady()) {
      open();
      return;
    }
    app.once("ready", open);
  }

  function open() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      if (typeof showPendingSettingsWindow === "function") {
        showPendingSettingsWindow({ restoreMinimized: true });
      } else {
        showAndFocusSettingsWindow(settingsWindow, { restoreMinimized: true });
      }
      return;
    }

    const iconPath = getIconPath();
    const bounds = computeInitialBounds();
    const createScale = getTextScale();
    const opts = {
      ...bounds,
      minWidth: scaleWidth(MIN_WIDTH, createScale),
      minHeight: scaleHeight(MIN_HEIGHT, createScale),
      show: false,
      frame: true,
      transparent: false,
      resizable: true,
      minimizable: true,
      maximizable: true,
      skipTaskbar: false,
      alwaysOnTop: false,
      title: getTitle(),
      // Match settings.html's dark-mode palette to avoid a white flash before
      // CSS media query kicks in. Hex values must stay in sync with the
      // `--bg` CSS variable in settings.html for each theme.
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c1f" : "#f5f5f7",
      webPreferences: {
        preload: preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        // Sandboxed preloads can't require app modules; pass build-time flags by value.
        additionalArguments: [
          `--discord-default-app-id-present=${discordDefaultAppIdPresent ? "1" : "0"}`,
        ],
      },
    };
    if (iconPath) opts.icon = iconPath;

    if (typeof options.onBeforeCreate === "function") options.onBeforeCreate();
    settingsWindow = new BrowserWindow(opts);
    const createdWindow = settingsWindow;
    if (isWin && typeof createdWindow.setAppDetails === "function") {
      const taskbarDetails = getTaskbarDetails();
      if (taskbarDetails && taskbarDetails.appIconPath) {
        createdWindow.setAppDetails(taskbarDetails);
      }
    }
    createdWindow.setMenuBarVisibility(false);
    createdWindow.loadFile(settingsHtmlPath);
    if (createdWindow.webContents && typeof createdWindow.webContents.once === "function") {
      createdWindow.webContents.once("did-finish-load", () => {
        applyZoomToWindow(createdWindow, getTextScale());
        applyTitleToWindow();
      });
    }
    // textScale is per-display: re-resolve after the user drags the window
    // somewhere else (debounced — "move" fires continuously during drags).
    if (typeof createdWindow.on === "function") {
      let moveTextScaleTimer = null;
      createdWindow.on("move", () => {
        if (moveTextScaleTimer) clearScheduled(moveTextScaleTimer);
        moveTextScaleTimer = scheduleTimer(() => {
          moveTextScaleTimer = null;
          applyTextScaleToWindow();
        }, 350);
      });
    }
    let didShowCreatedWindow = false;
    function showCreatedWindow(showOptions = {}) {
      if (didShowCreatedWindow) return;
      didShowCreatedWindow = true;
      if (showPendingSettingsWindow === showCreatedWindow) {
        showPendingSettingsWindow = null;
      }
      clearReadyToShowFallbackTimer();
      showAndFocusSettingsWindow(createdWindow, showOptions);
    }
    showPendingSettingsWindow = showCreatedWindow;
    createdWindow.once("ready-to-show", showCreatedWindow);
    readyToShowFallbackTimer = scheduleTimer(showCreatedWindow, READY_TO_SHOW_FALLBACK_MS);
    createdWindow.on("closed", () => {
      const isCurrentWindow = settingsWindow === createdWindow;
      if (isCurrentWindow) {
        showPendingSettingsWindow = null;
        clearReadyToShowFallbackTimer();
        clearLiftTimer();
      }
      if (typeof options.onBeforeClosed === "function") options.onBeforeClosed();
      if (isCurrentWindow) settingsWindow = null;
      if (typeof options.onAfterClosed === "function") options.onAfterClosed();
    });
  }

  return {
    getIconPath,
    getTaskbarDetails,
    getWindow,
    open,
    openWhenReady,
    applyTextScaleToWindow,
    applyTitleToWindow,
  };
}

module.exports = createSettingsWindowRuntime;
