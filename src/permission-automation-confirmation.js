"use strict";

const defaultPath = require("path");

const RESULT_CHANNEL = "permission-automation-confirmation:result";
const STATE_CHANNEL = "permission-automation-confirmation:state";
const READY_CHANNEL = "permission-automation-confirmation:ready";
const STATE_APPLIED_CHANNEL = "permission-automation-confirmation:state-applied";
const STARTUP_TIMEOUT_MS = 5000;
const DEFAULT_WORK_AREA = { x: 0, y: 0, width: 1280, height: 800 };
const DEFAULT_WIDTH = 520;
const CONFIRM_HEIGHT = 376;
const ERROR_HEIGHT = 280;
const SUPPORTED_LANGS = new Set(["en", "zh", "zh-TW", "ko", "ja", "pt-BR", "es"]);

function isUsableWorkArea(value) {
  return !!value
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
    && Number.isFinite(value.width)
    && Number.isFinite(value.height)
    && value.width > 0
    && value.height > 0;
}

function computeCenteredBounds(screen, height) {
  let workArea = DEFAULT_WORK_AREA;
  try {
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point) || screen.getPrimaryDisplay();
    if (display && isUsableWorkArea(display.workArea)) workArea = display.workArea;
  } catch {
    try {
      const primary = screen.getPrimaryDisplay();
      if (primary && isUsableWorkArea(primary.workArea)) workArea = primary.workArea;
    } catch {}
  }
  const width = Math.min(DEFAULT_WIDTH, workArea.width);
  const boundedHeight = Math.min(height, workArea.height);
  return {
    width,
    height: boundedHeight,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - boundedHeight) / 2),
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value : "";
}

function normalizeLang(value) {
  return SUPPORTED_LANGS.has(value) ? value : "en";
}

function createPermissionAutomationConfirmationRuntime(options = {}) {
  const BrowserWindow = options.BrowserWindow;
  const ipcMain = options.ipcMain;
  const nativeTheme = options.nativeTheme;
  const screen = options.screen;
  const path = options.path || defaultPath;
  const scheduleLater = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const clearScheduled = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;
  if (!BrowserWindow || !ipcMain || !screen) {
    throw new Error("permission automation confirmation requires BrowserWindow, ipcMain, and screen");
  }

  const htmlPath = options.htmlPath || path.join(__dirname, "permission-automation-confirmation.html");
  const preloadPath = options.preloadPath || path.join(__dirname, "preload-permission-automation-confirmation.js");
  let activeWindow = null;
  let activeResolve = null;
  let activeKind = null;
  let activeState = null;
  let pageLoaded = false;
  let rendererReady = false;
  let stateSent = false;
  let stateApplied = false;
  let windowReadyToShow = false;
  let windowShown = false;
  let startupTimer = null;

  function isLiveWindow(win) {
    return !!win && (typeof win.isDestroyed !== "function" || !win.isDestroyed());
  }

  function focusActiveWindow() {
    if (!isLiveWindow(activeWindow)) return false;
    // A duplicate request must not bypass the startup gate and expose a blank
    // or partially initialized renderer.
    if (!windowShown) return true;
    try {
      if (typeof activeWindow.isMinimized === "function" && activeWindow.isMinimized()) {
        activeWindow.restore();
      }
      activeWindow.show();
      activeWindow.focus();
    } catch {
      settle(defaultResult(activeKind));
    }
    return true;
  }

  function defaultResult(kind) {
    return kind === "confirm"
      ? { confirmed: false, suppressFutureConfirmation: false }
      : undefined;
  }

  function clearStartupTimer() {
    if (!startupTimer) return;
    clearScheduled(startupTimer);
    startupTimer = null;
  }

  function settle(result, closeWindow = true) {
    const win = activeWindow;
    const resolve = activeResolve;
    const kind = activeKind;
    activeWindow = null;
    activeResolve = null;
    activeKind = null;
    activeState = null;
    pageLoaded = false;
    rendererReady = false;
    stateSent = false;
    stateApplied = false;
    windowReadyToShow = false;
    windowShown = false;
    clearStartupTimer();
    if (typeof resolve === "function") resolve(result === undefined ? defaultResult(kind) : result);
    if (closeWindow && isLiveWindow(win)) {
      try { win.close(); } catch {
        try { win.destroy(); } catch {}
      }
    }
  }

  function handleResult(event, payload) {
    if (!isLiveWindow(activeWindow) || event.sender !== activeWindow.webContents) return;
    const action = payload && payload.action;
    if (activeKind === "confirm" && action === "confirm") {
      settle({
        confirmed: true,
        suppressFutureConfirmation: payload.suppressFutureConfirmation === true,
      });
      return;
    }
    settle(defaultResult(activeKind));
  }

  function finishStartupWhenReady() {
    if (!isLiveWindow(activeWindow)) return;
    if (pageLoaded && rendererReady && !stateSent) {
      try {
        activeWindow.webContents.send(STATE_CHANNEL, activeState);
      } catch {
        settle(defaultResult(activeKind));
        return;
      }
      activeState = null;
      stateSent = true;
    }
    if (
      !stateSent
      || !stateApplied
      || !windowReadyToShow
      || windowShown
      || !isLiveWindow(activeWindow)
    ) return;
    try {
      activeWindow.show();
      activeWindow.focus();
      windowShown = true;
      clearStartupTimer();
    } catch {
      settle(defaultResult(activeKind));
    }
  }

  function handleReady(event) {
    if (!isLiveWindow(activeWindow) || event.sender !== activeWindow.webContents) return;
    rendererReady = true;
    finishStartupWhenReady();
  }

  function handleStateApplied(event) {
    if (
      !isLiveWindow(activeWindow)
      || event.sender !== activeWindow.webContents
      || !stateSent
    ) return;
    stateApplied = true;
    finishStartupWhenReady();
  }

  ipcMain.on(RESULT_CHANNEL, handleResult);
  ipcMain.on(READY_CHANNEL, handleReady);
  ipcMain.on(STATE_APPLIED_CHANNEL, handleStateApplied);

  function openWindow(kind, payload) {
    if (focusActiveWindow()) return Promise.resolve(defaultResult(kind));

    const parent = isLiveWindow(payload.parent) ? payload.parent : null;
    const height = kind === "confirm" ? CONFIRM_HEIGHT : ERROR_HEIGHT;
    const bounds = computeCenteredBounds(screen, height);
    const backgroundColor = nativeTheme && nativeTheme.shouldUseDarkColors ? "#202124" : "#f7f7f8";
    const windowOptions = {
      ...bounds,
      minWidth: Math.min(460, bounds.width),
      minHeight: Math.min(kind === "confirm" ? 320 : 250, bounds.height),
      show: false,
      frame: false,
      transparent: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: !!parent,
      alwaysOnTop: !parent,
      title: normalizeText(payload.title),
      backgroundColor,
      webPreferences: {
        preload: preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    };
    if (parent) {
      windowOptions.parent = parent;
      windowOptions.modal = true;
    }
    if (options.iconPath) windowOptions.icon = options.iconPath;

    let win;
    try {
      win = new BrowserWindow(windowOptions);
    } catch {
      return Promise.resolve(defaultResult(kind));
    }
    activeWindow = win;
    activeKind = kind;
    activeState = {
      kind,
      lang: normalizeLang(payload.lang),
      title: normalizeText(payload.title),
      message: normalizeText(payload.message),
      detail: normalizeText(payload.detail),
      checkboxLabel: normalizeText(payload.checkboxLabel),
      confirmLabel: normalizeText(payload.confirmLabel),
      cancelLabel: normalizeText(payload.cancelLabel),
      dismissLabel: normalizeText(payload.dismissLabel),
    };
    pageLoaded = false;
    rendererReady = false;
    stateSent = false;
    stateApplied = false;
    windowReadyToShow = false;
    windowShown = false;

    const resultPromise = new Promise((resolve) => {
      activeResolve = resolve;
    });

    try {
      if (typeof win.setMenuBarVisibility === "function") win.setMenuBarVisibility(false);
      win.webContents.once("did-finish-load", () => {
        if (activeWindow !== win || !isLiveWindow(win)) return;
        pageLoaded = true;
        finishStartupWhenReady();
      });
      win.webContents.once("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
        if (isMainFrame === false) return;
        if (activeWindow === win) settle(defaultResult(kind));
      });
      win.webContents.once("render-process-gone", () => {
        if (activeWindow === win) settle(defaultResult(kind));
      });
      win.once("ready-to-show", () => {
        if (activeWindow !== win || !isLiveWindow(win)) return;
        windowReadyToShow = true;
        finishStartupWhenReady();
      });
      win.on("closed", () => {
        if (activeWindow === win) settle(defaultResult(kind), false);
      });

      startupTimer = scheduleLater(() => {
        if (activeWindow === win && !windowShown) {
          settle(defaultResult(kind));
        }
      }, STARTUP_TIMEOUT_MS);
      if (startupTimer && typeof startupTimer.unref === "function") startupTimer.unref();

      const loadResult = win.loadFile(htmlPath);
      if (loadResult && typeof loadResult.catch === "function") {
        loadResult.catch(() => {
          if (activeWindow === win) settle(defaultResult(kind));
        });
      }
    } catch {
      settle(defaultResult(kind));
    }
    return resultPromise;
  }

  function confirmPermissionAutomation(payload = {}) {
    return openWindow("confirm", payload);
  }

  function showPermissionAutomationError(payload = {}) {
    // Persistence failures must not disappear behind an unrelated confirmation.
    // Cancel the pending trust change before replacing it with the error.
    if (isLiveWindow(activeWindow)) settle(defaultResult(activeKind));
    return openWindow("error", payload).then(() => undefined);
  }

  function dispose() {
    if (typeof ipcMain.removeListener === "function") ipcMain.removeListener(RESULT_CHANNEL, handleResult);
    if (typeof ipcMain.removeListener === "function") ipcMain.removeListener(READY_CHANNEL, handleReady);
    if (typeof ipcMain.removeListener === "function") {
      ipcMain.removeListener(STATE_APPLIED_CHANNEL, handleStateApplied);
    }
    settle(defaultResult(activeKind));
  }

  return {
    confirmPermissionAutomation,
    showPermissionAutomationError,
    dispose,
    getWindow: () => activeWindow,
  };
}

module.exports = createPermissionAutomationConfirmationRuntime;
module.exports.computeCenteredBounds = computeCenteredBounds;
module.exports.RESULT_CHANNEL = RESULT_CHANNEL;
module.exports.STATE_CHANNEL = STATE_CHANNEL;
module.exports.READY_CHANNEL = READY_CHANNEL;
module.exports.STATE_APPLIED_CHANNEL = STATE_APPLIED_CHANNEL;
