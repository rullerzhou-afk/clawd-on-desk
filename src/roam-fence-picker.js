"use strict";

const defaultPath = require("path");
const { pathToFileURL } = require("url");

const READY_CHANNEL = "roam-fence-picker:ready";
const APPLIED_CHANNEL = "roam-fence-picker:state-applied";
const STATE_CHANNEL = "roam-fence-picker:state";
const RESULT_CHANNEL = "roam-fence-picker:result";
const STARTUP_TIMEOUT_MS = 5000;
const FALLBACK_WORK_AREA = { x: 0, y: 0, width: 1280, height: 800 };
const SUPPORTED_LANGS = new Set(["en", "zh", "zh-TW", "ko", "ja", "pt-BR", "es"]);

function isUsableRect(value) {
  return !!value
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
    && Number.isFinite(value.width)
    && Number.isFinite(value.height)
    && value.width > 0
    && value.height > 0;
}

function isUsableSize(value) {
  return !!value
    && Number.isFinite(value.width)
    && Number.isFinite(value.height)
    && value.width > 0
    && value.height > 0;
}

function normalizeLang(value) {
  return SUPPORTED_LANGS.has(value) ? value : "en";
}

function selectionToFence(selection, workArea, minimumSize = {}) {
  if (!isUsableRect(selection) || !isUsableSize(workArea)) return null;
  const areaWidth = Math.max(1, Math.round(workArea.width));
  const areaHeight = Math.max(1, Math.round(workArea.height));
  const x = Math.round(selection.x);
  const y = Math.round(selection.y);
  const width = Math.round(selection.width);
  const height = Math.round(selection.height);
  const minWidth = Math.max(1, Math.ceil(Number(minimumSize.width) || 1));
  const minHeight = Math.max(1, Math.ceil(Number(minimumSize.height) || 1));
  if (x < 0 || y < 0 || width < minWidth || height < minHeight) return null;
  if (x + width > areaWidth || y + height > areaHeight) return null;
  return {
    left: x / areaWidth,
    top: y / areaHeight,
    right: (x + width) / areaWidth,
    bottom: (y + height) / areaHeight,
  };
}

function createRoamFencePicker(options = {}) {
  const BrowserWindow = options.BrowserWindow;
  const ipcMain = options.ipcMain;
  const screen = options.screen;
  const path = options.path || defaultPath;
  if (!BrowserWindow || !ipcMain || !screen) {
    throw new Error("roam fence picker requires BrowserWindow, ipcMain, and screen");
  }
  const htmlPath = options.htmlPath || path.join(__dirname, "roam-fence-picker.html");
  const pickerUrl = pathToFileURL(htmlPath).href;
  const preloadPath = options.preloadPath || path.join(__dirname, "preload-roam-fence-picker.js");
  const scheduleLater = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const clearScheduled = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;

  let activeWindow = null;
  let activePromise = null;
  let activeResolve = null;
  let activeContext = null;
  let pageLoaded = false;
  let rendererReady = false;
  let rendererApplied = false;
  let stateSent = false;
  let windowReady = false;
  let shown = false;
  let startupTimer = null;
  let hiddenSettingsWindow = null;
  let displayListenersAttached = false;

  function isLiveWindow(win) {
    return !!win && (typeof win.isDestroyed !== "function" || !win.isDestroyed());
  }

  function clearStartupTimer() {
    if (!startupTimer) return;
    clearScheduled(startupTimer);
    startupTimer = null;
  }

  function restoreSettingsWindow() {
    const win = hiddenSettingsWindow;
    hiddenSettingsWindow = null;
    if (!isLiveWindow(win)) return;
    try {
      if (typeof win.show === "function") win.show();
      if (typeof win.moveTop === "function") win.moveTop();
      if (typeof win.focus === "function") win.focus();
    } catch {}
  }

  function detachDisplayListeners() {
    if (!displayListenersAttached || typeof screen.removeListener !== "function") return;
    screen.removeListener("display-removed", handleDisplayInvalidated);
    screen.removeListener("display-metrics-changed", handleDisplayInvalidated);
    displayListenersAttached = false;
  }

  function attachDisplayListeners() {
    if (displayListenersAttached || typeof screen.on !== "function") return;
    screen.on("display-removed", handleDisplayInvalidated);
    screen.on("display-metrics-changed", handleDisplayInvalidated);
    displayListenersAttached = true;
  }

  function settle(result, closeWindow = true, restoreSettings = true) {
    const win = activeWindow;
    const resolve = activeResolve;
    activeWindow = null;
    activePromise = null;
    activeResolve = null;
    activeContext = null;
    pageLoaded = false;
    rendererReady = false;
    rendererApplied = false;
    stateSent = false;
    windowReady = false;
    shown = false;
    clearStartupTimer();
    detachDisplayListeners();
    if (typeof resolve === "function") resolve(result || { status: "cancel" });
    if (closeWindow && isLiveWindow(win)) {
      try { win.close(); } catch {
        try { win.destroy(); } catch {}
      }
    }
    if (restoreSettings) restoreSettingsWindow();
    else hiddenSettingsWindow = null;
  }

  function maybeFinishStartup() {
    if (!isLiveWindow(activeWindow)) return;
    if (pageLoaded && rendererReady && activeContext && !stateSent) {
      try { activeWindow.webContents.send(STATE_CHANNEL, activeContext); }
      catch { settle({ status: "error", message: "area picker failed to initialize" }); return; }
      stateSent = true;
    }
    if (!pageLoaded || !rendererReady || !stateSent || !rendererApplied || !windowReady || shown) return;
    try {
      const settingsWindow = typeof options.getSettingsWindow === "function"
        ? options.getSettingsWindow()
        : null;
      if (isLiveWindow(settingsWindow)) {
        hiddenSettingsWindow = settingsWindow;
        if (typeof settingsWindow.hide === "function") settingsWindow.hide();
      }
      activeWindow.show();
      activeWindow.focus();
      shown = true;
      clearStartupTimer();
    } catch {
      settle({ status: "error", message: "area picker could not be shown" });
    }
  }

  function isTrustedPickerEvent(event) {
    if (!isLiveWindow(activeWindow) || !event) return false;
    const contents = activeWindow.webContents;
    const frame = event.senderFrame;
    return event.sender === contents
      && !!frame
      && frame === contents.mainFrame
      && frame.url === pickerUrl;
  }

  function resolveDisplay() {
    let petBounds = null;
    try {
      if (typeof options.getPetWindowBounds === "function") {
        petBounds = options.getPetWindowBounds();
      }
    } catch {}
    try {
      if (isUsableRect(petBounds) && typeof screen.getDisplayMatching === "function") {
        const matching = screen.getDisplayMatching(petBounds);
        if (matching && isUsableRect(matching.workArea)) return matching;
      }
    } catch {}
    try {
      if (isUsableRect(petBounds) && typeof screen.getDisplayNearestPoint === "function") {
        const nearest = screen.getDisplayNearestPoint({
          x: Math.round(petBounds.x + petBounds.width / 2),
          y: Math.round(petBounds.y + petBounds.height / 2),
        });
        if (nearest && isUsableRect(nearest.workArea)) return nearest;
      }
    } catch {}
    try {
      const primary = screen.getPrimaryDisplay();
      if (primary && isUsableRect(primary.workArea)) return primary;
    } catch {}
    return { id: null, workArea: FALLBACK_WORK_AREA, scaleFactor: 1 };
  }

  function handleReady(event) {
    if (!isTrustedPickerEvent(event)) return;
    rendererReady = true;
    maybeFinishStartup();
  }

  function handleApplied(event) {
    if (!isTrustedPickerEvent(event) || !stateSent) return;
    rendererApplied = true;
    maybeFinishStartup();
  }

  function handleResult(event, payload) {
    if (!isTrustedPickerEvent(event)) return;
    if (!payload || payload.action !== "confirm") {
      settle({ status: "cancel" });
      return;
    }
    const context = activeWindow.__clawdRoamFenceContext;
    const fence = context && selectionToFence(payload.selection, context.workArea, context.minimumSize);
    if (!fence) {
      settle({ status: "error", message: "selected area is too small or outside the work area" });
      return;
    }
    settle({ status: "ok", fence });
  }

  ipcMain.on(READY_CHANNEL, handleReady);
  ipcMain.on(APPLIED_CHANNEL, handleApplied);
  ipcMain.on(RESULT_CHANNEL, handleResult);

  function handleDisplayInvalidated(_event, display) {
    if (!isLiveWindow(activeWindow) || !activeContext) return;
    const activeId = activeContext.displayId;
    const changedId = display && display.id;
    if (activeId !== null && changedId !== activeId) return;
    settle({
      status: "error",
      code: "display-changed",
      message: "the display changed while choosing an area; try again",
    });
  }

  function selectArea(payload = {}) {
    if (isLiveWindow(activeWindow) && activePromise) {
      if (shown) {
        try { activeWindow.show(); activeWindow.focus(); } catch {}
      }
      return activePromise;
    }
    const display = resolveDisplay();
    const workArea = {
      x: Math.round(display.workArea.x),
      y: Math.round(display.workArea.y),
      width: Math.max(1, Math.round(display.workArea.width)),
      height: Math.max(1, Math.round(display.workArea.height)),
    };
    let minimumSize = { width: 1, height: 1 };
    try {
      const effective = typeof options.getEffectivePetSize === "function"
        ? options.getEffectivePetSize(workArea)
        : null;
      if (effective && Number.isFinite(effective.width) && Number.isFinite(effective.height)) {
        minimumSize = {
          width: Math.max(1, Math.ceil(effective.width)),
          height: Math.max(1, Math.ceil(effective.height)),
        };
      }
    } catch {}
    if (minimumSize.width > workArea.width || minimumSize.height > workArea.height) {
      return Promise.resolve({
        status: "error",
        code: "pet-too-large",
        message: "the pet is larger than this display's work area",
      });
    }
    const context = {
      lang: normalizeLang(payload.lang),
      workArea: { width: workArea.width, height: workArea.height },
      displayId: display.id == null ? null : display.id,
      scaleFactor: Number.isFinite(display.scaleFactor) ? display.scaleFactor : 1,
      minimumSize,
    };
    const windowOptions = {
      x: Math.round(workArea.x),
      y: Math.round(workArea.y),
      width: Math.round(workArea.width),
      height: Math.round(workArea.height),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,
      title: "Choose Clawd activity area",
      webPreferences: {
        preload: preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    };
    if (options.iconPath) windowOptions.icon = options.iconPath;
    let win;
    try { win = new BrowserWindow(windowOptions); }
    catch (err) {
      return Promise.resolve({ status: "error", message: (err && err.message) || String(err) });
    }
    activeWindow = win;
    activeContext = context;
    attachDisplayListeners();
    win.__clawdRoamFenceContext = context;
    pageLoaded = false;
    rendererReady = false;
    rendererApplied = false;
    stateSent = false;
    windowReady = false;
    shown = false;
    activePromise = new Promise((resolve) => { activeResolve = resolve; });
    const resultPromise = activePromise;

    try {
      if (typeof win.setMenuBarVisibility === "function") win.setMenuBarVisibility(false);
      try {
        if (typeof win.setAlwaysOnTop === "function") win.setAlwaysOnTop(true, "screen-saver");
      } catch {}
      if (typeof win.setVisibleOnAllWorkspaces === "function") {
        try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
      }
      if (typeof win.webContents.setWindowOpenHandler === "function") {
        win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      }
      const rejectNavigation = (event, url) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        if (activeWindow === win) {
          settle({ status: "error", message: "area picker navigation was blocked" });
        }
      };
      win.webContents.on("will-navigate", rejectNavigation);
      win.webContents.on("will-redirect", rejectNavigation);
      win.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
        if (isInPlace || isMainFrame === false || !pageLoaded) return;
        if (activeWindow === win) {
          settle({ status: "error", message: "area picker navigation was blocked" });
        }
      });
      win.webContents.once("did-finish-load", () => {
        if (activeWindow !== win || !isLiveWindow(win)) return;
        pageLoaded = true;
        maybeFinishStartup();
      });
      win.webContents.once("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
        if (isMainFrame === false) return;
        if (activeWindow === win) settle({ status: "error", message: "area picker failed to load" });
      });
      win.webContents.once("render-process-gone", () => {
        if (activeWindow === win) settle({ status: "error", message: "area picker stopped unexpectedly" });
      });
      win.once("ready-to-show", () => {
        if (activeWindow !== win || !isLiveWindow(win)) return;
        windowReady = true;
        maybeFinishStartup();
      });
      win.on("closed", () => {
        if (activeWindow === win) settle({ status: "cancel" }, false);
      });
      startupTimer = scheduleLater(() => {
        if (activeWindow === win && !shown) {
          settle({ status: "error", message: "area picker timed out while starting" });
        }
      }, STARTUP_TIMEOUT_MS);
      if (startupTimer && typeof startupTimer.unref === "function") startupTimer.unref();
      const loadResult = win.loadFile(htmlPath);
      if (loadResult && typeof loadResult.catch === "function") {
        loadResult.catch(() => {
          if (activeWindow === win) settle({ status: "error", message: "area picker failed to load" });
        });
      }
    } catch (err) {
      settle({ status: "error", message: (err && err.message) || String(err) });
    }
    return resultPromise;
  }

  function cancel() {
    if (isLiveWindow(activeWindow)) settle({ status: "cancel" });
  }

  function dispose() {
    if (typeof ipcMain.removeListener === "function") ipcMain.removeListener(READY_CHANNEL, handleReady);
    if (typeof ipcMain.removeListener === "function") ipcMain.removeListener(APPLIED_CHANNEL, handleApplied);
    if (typeof ipcMain.removeListener === "function") ipcMain.removeListener(RESULT_CHANNEL, handleResult);
    detachDisplayListeners();
    if (isLiveWindow(activeWindow)) settle({ status: "cancel" }, true, false);
    else hiddenSettingsWindow = null;
  }

  return { selectArea, cancel, dispose, getWindow: () => activeWindow };
}

module.exports = createRoamFencePicker;
module.exports.selectionToFence = selectionToFence;
module.exports.READY_CHANNEL = READY_CHANNEL;
module.exports.APPLIED_CHANNEL = APPLIED_CHANNEL;
module.exports.STATE_CHANNEL = STATE_CHANNEL;
module.exports.RESULT_CHANNEL = RESULT_CHANNEL;
