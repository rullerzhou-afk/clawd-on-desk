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
const BOUNDS_SAVE_DEBOUNCE_MS = 500;
const RECAP_CHANGED_DEBOUNCE_MS = 500;
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

function roundedBounds(bounds) {
  if (!isUsableBounds(bounds)) return null;
  const normalized = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
  return isUsableBounds(normalized) ? normalized : null;
}

function sameBounds(a, b) {
  return !!a
    && !!b
    && a.x === b.x
    && a.y === b.y
    && a.width === b.width
    && a.height === b.height;
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
  let saveBoundsTimer = null;
  let recapChangedTimer = null;
  let lastSavedBounds = null;
  let showPendingSettingsWindow = null;
  let pendingRequestedTab = null;
  let settingsRendererLoaded = false;

  const ALLOWED_TABS = new Set([
    "general",
    "agents",
    "theme",
    "animOverrides",
    "shortcuts",
    "telegram-approval",
    "discord-presence",
    "remote-ssh",
    "recap",
    "about",
  ]);

  function normalizeRequestedTab(value) {
    return typeof value === "string" && ALLOWED_TABS.has(value) ? value : null;
  }

  function sendRequestedTab(win) {
    if (!pendingRequestedTab || !settingsRendererLoaded || !isLiveWindow(win)) return false;
    const wc = win.webContents;
    if (!wc || (typeof wc.isDestroyed === "function" && wc.isDestroyed())) return false;
    if (typeof wc.send !== "function") return false;
    const tab = pendingRequestedTab;
    pendingRequestedTab = null;
    try {
      wc.send("settings:select-tab", tab);
      return true;
    } catch {
      pendingRequestedTab = tab;
      return false;
    }
  }

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

  function clearSaveBoundsTimer() {
    if (!saveBoundsTimer) return;
    clearScheduled(saveBoundsTimer);
    saveBoundsTimer = null;
  }

  function clearRecapChangedTimer() {
    if (!recapChangedTimer) return;
    clearScheduled(recapChangedTimer);
    recapChangedTimer = null;
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
    let savedBounds = null;
    if (typeof options.getSavedBounds === "function") {
      try { savedBounds = roundedBounds(options.getSavedBounds()); } catch {}
    }

    let cx = 0;
    let cy = 0;
    if (savedBounds) {
      cx = savedBounds.x + savedBounds.width / 2;
      cy = savedBounds.y + savedBounds.height / 2;
    } else if (typeof options.getPetWindowBounds === "function") {
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

    const scale = getTextScale(savedBounds || workArea);
    const minWidth = scaleWidth(MIN_WIDTH, scale);
    const minHeight = scaleHeight(MIN_HEIGHT, scale);
    if (savedBounds) {
      return clampBoundsToWorkArea({
        ...savedBounds,
        width: Math.max(savedBounds.width, minWidth),
        height: Math.max(savedBounds.height, minHeight),
      }, workArea);
    }
    const width = Math.min(scaleWidth(DEFAULT_WIDTH, scale), Math.max(1, workArea.width));
    const height = Math.min(scaleHeight(DEFAULT_HEIGHT, scale), Math.max(1, workArea.height));
    return clampBoundsToWorkArea({
      x: workArea.x + (workArea.width - width) / 2,
      y: workArea.y + (workArea.height - height) / 2,
      width,
      height,
    }, workArea);
  }

  function getTextScale(bounds = null) {
    return clampTextScale(typeof options.getTextScale === "function" ? options.getTextScale(bounds) : 1);
  }

  function getNormalWindowBounds(win) {
    if (!isLiveWindow(win)) return null;
    try {
      if (typeof win.getNormalBounds === "function") {
        const bounds = roundedBounds(win.getNormalBounds());
        if (bounds) return bounds;
      }
    } catch {}
    try {
      return typeof win.getBounds === "function" ? roundedBounds(win.getBounds()) : null;
    } catch {
      return null;
    }
  }

  function persistWindowBoundsNow(win) {
    clearSaveBoundsTimer();
    if (typeof options.onSaveBounds !== "function") return false;
    const bounds = getNormalWindowBounds(win);
    if (!bounds || sameBounds(bounds, lastSavedBounds)) return false;
    try {
      const result = options.onSaveBounds(bounds);
      if (result && typeof result.then === "function") {
        const attemptedBounds = bounds;
        Promise.resolve(result).then(
          (response) => {
            if (!response || response.status !== "error") return;
            if (sameBounds(lastSavedBounds, attemptedBounds)) lastSavedBounds = null;
            console.warn("Clawd: failed to persist Settings window bounds:", response.message);
          },
          (err) => {
            if (sameBounds(lastSavedBounds, attemptedBounds)) lastSavedBounds = null;
            console.warn("Clawd: failed to persist Settings window bounds:", err && err.message);
          },
        );
      } else if (result && result.status === "error") {
        console.warn("Clawd: failed to persist Settings window bounds:", result.message);
        return false;
      }
      lastSavedBounds = bounds;
      return true;
    } catch (err) {
      console.warn("Clawd: failed to persist Settings window bounds:", err && err.message);
      return false;
    }
  }

  function scheduleWindowBoundsSave(win) {
    if (typeof options.onSaveBounds !== "function") return;
    clearSaveBoundsTimer();
    saveBoundsTimer = scheduleTimer(() => {
      saveBoundsTimer = null;
      persistWindowBoundsNow(win);
    }, BOUNDS_SAVE_DEBOUNCE_MS);
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

  // Hook bursts often contain several activity boundaries for one tool call.
  // Coalesce them before crossing IPC so an open Footprints page can update
  // promptly without rebuilding itself for every individual hook event.
  function notifyRecapChanged() {
    const currentWindow = getWindow();
    if (!settingsRendererLoaded || !isLiveWindow(currentWindow)) return false;
    const currentWebContents = currentWindow.webContents;
    if (!currentWebContents
      || (typeof currentWebContents.isDestroyed === "function" && currentWebContents.isDestroyed())
      || typeof currentWebContents.send !== "function") return false;
    if (recapChangedTimer) return false;
    recapChangedTimer = scheduleTimer(() => {
      recapChangedTimer = null;
      const win = getWindow();
      if (!settingsRendererLoaded || !isLiveWindow(win)) return;
      const wc = win.webContents;
      if (!wc || (typeof wc.isDestroyed === "function" && wc.isDestroyed())) return;
      if (typeof wc.send !== "function") return;
      try { wc.send("settings:recap-changed"); } catch {}
    }, RECAP_CHANGED_DEBOUNCE_MS);
    return true;
  }

  // textScale changed while settings is open: re-zoom, raise the minimum
  // size, and only grow the window if it now sits below that minimum — never
  // touch a user-chosen size otherwise.
  function applyTextScaleToWindow() {
    const win = getWindow();
    if (!isLiveWindow(win)) return;
    const bounds = typeof win.getBounds === "function" ? win.getBounds() : null;
    const scale = getTextScale(bounds);
    applyZoomToWindow(win, scale);
    notifyTextScaleContextChanged(win);
    const minW = scaleWidth(MIN_WIDTH, scale);
    const minH = scaleHeight(MIN_HEIGHT, scale);
    if (typeof win.setMinimumSize === "function") win.setMinimumSize(minW, minH);
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

  function openWhenReady(openOptions = {}) {
    if (app.isReady()) {
      open(openOptions);
      return;
    }
    app.once("ready", () => open(openOptions));
  }

  function open(openOptions = {}) {
    const requestedTab = normalizeRequestedTab(openOptions && openOptions.tab);
    if (requestedTab) pendingRequestedTab = requestedTab;
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      sendRequestedTab(settingsWindow);
      if (typeof showPendingSettingsWindow === "function") {
        showPendingSettingsWindow({ restoreMinimized: true });
      } else {
        showAndFocusSettingsWindow(settingsWindow, { restoreMinimized: true });
      }
      return;
    }

    const iconPath = getIconPath();
    const bounds = computeInitialBounds();
    const createScale = getTextScale(bounds);
    const opts = {
      ...bounds,
      minWidth: Math.min(scaleWidth(MIN_WIDTH, createScale), bounds.width),
      minHeight: Math.min(scaleHeight(MIN_HEIGHT, createScale), bounds.height),
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
    settingsRendererLoaded = false;
    const createdWindow = settingsWindow;
    // BrowserWindow's constructor can quantize framed window geometry at
    // fractional Windows DPI (for example, a persisted outer width of 960
    // may initially report as 962). Re-apply the requested outer bounds via
    // setBounds before listeners are attached so repeated reopen cycles do
    // not persist and accumulate that native-frame drift.
    try {
      const createdBounds = typeof createdWindow.getBounds === "function"
        ? roundedBounds(createdWindow.getBounds())
        : null;
      if (
        createdBounds
        && !sameBounds(createdBounds, bounds)
        && typeof createdWindow.setBounds === "function"
      ) {
        createdWindow.setBounds(bounds);
      }
    } catch {}
    // Treat the post-correction native rectangle as the initial baseline.
    // Closing an untouched window must not rewrite prefs, and any platform
    // that cannot adopt the requested rectangle exactly must not feed its
    // constructor/frame quantization back into the next launch.
    lastSavedBounds = getNormalWindowBounds(createdWindow) || bounds;
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
        settingsRendererLoaded = true;
        applyZoomToWindow(createdWindow, getTextScale());
        applyTitleToWindow();
        sendRequestedTab(createdWindow);
      });
    }
    // textScale is per-display: re-resolve after the user drags the window
    // somewhere else (debounced — "move" fires continuously during drags).
    let moveTextScaleTimer = null;
    if (typeof createdWindow.on === "function") {
      createdWindow.on("move", () => {
        if (moveTextScaleTimer) clearScheduled(moveTextScaleTimer);
        moveTextScaleTimer = scheduleTimer(() => {
          moveTextScaleTimer = null;
          applyTextScaleToWindow();
        }, 350);
        scheduleWindowBoundsSave(createdWindow);
      });
      createdWindow.on("resize", () => scheduleWindowBoundsSave(createdWindow));
      // `closed` is too late to query native geometry. Flush while the window
      // is still live so a pending debounce cannot lose the user's last move.
      createdWindow.on("close", () => persistWindowBoundsNow(createdWindow));
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
        clearSaveBoundsTimer();
        clearRecapChangedTimer();
        if (moveTextScaleTimer) {
          clearScheduled(moveTextScaleTimer);
          moveTextScaleTimer = null;
        }
      }
      if (typeof options.onBeforeClosed === "function") options.onBeforeClosed();
      if (isCurrentWindow) settingsWindow = null;
      if (isCurrentWindow) settingsRendererLoaded = false;
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
    notifyRecapChanged,
  };
}

module.exports = createSettingsWindowRuntime;
