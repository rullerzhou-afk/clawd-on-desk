"use strict";

const { BrowserWindow, nativeTheme } = require("electron");
const path = require("path");
const { clampTextScale, scaleWidth, scaleHeight, applyZoomToWindow } = require("./text-scale");

const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 600;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 400;
const BOUNDS_SAVE_DEBOUNCE_MS = 500;
const LIGHT_BACKGROUND = "#f5f5f7";
const DARK_BACKGROUND = "#1c1c1f";

function getDashboardBackgroundColor() {
  return nativeTheme.shouldUseDarkColors ? DARK_BACKGROUND : LIGHT_BACKGROUND;
}

const FALLBACK_WORK_AREA = { x: 0, y: 0, width: 1280, height: 800 };

function isUsableBounds(bounds) {
  return !!bounds
    && Number.isFinite(bounds.x)
    && Number.isFinite(bounds.y)
    && Number.isFinite(bounds.width)
    && Number.isFinite(bounds.height)
    && bounds.width > 0
    && bounds.height > 0;
}

// Displays can transiently report zero-size work areas during unplug or
// session reconnect; a degenerate rect would collapse the window to nothing.
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

module.exports = function initDashboard(ctx) {
  let dashboardWindow = null;
  let saveBoundsTimer = null;
  let lastSavedBounds = null;
  let programmaticEventBounds = null;
  let programmaticBoundsMutationDepth = 0;
  let pendingUserBounds = null;
  let pendingUserBoundsRevision = 0;
  const scheduleLater = typeof ctx.setTimeout === "function" ? ctx.setTimeout : setTimeout;
  const clearScheduled = typeof ctx.clearTimeout === "function" ? ctx.clearTimeout : clearTimeout;

  function scheduleTimer(callback, delayMs) {
    const timer = scheduleLater(callback, delayMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    return timer;
  }

  function clearSaveBoundsTimer() {
    if (!saveBoundsTimer) return;
    clearScheduled(saveBoundsTimer);
    saveBoundsTimer = null;
  }

  function getSavedDashboardBounds() {
    if (typeof ctx.getSavedBounds !== "function") return null;
    try { return roundedBounds(ctx.getSavedBounds()); } catch { return null; }
  }

  function getWorkAreaNear(cx, cy) {
    if (typeof ctx.getNearestWorkArea !== "function") return FALLBACK_WORK_AREA;
    try {
      return normalizeWorkArea(ctx.getNearestWorkArea(cx, cy));
    } catch {
      return FALLBACK_WORK_AREA;
    }
  }

  function getNormalWindowBounds(win) {
    if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return null;
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

  function getCurrentWindowBounds(win) {
    if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return null;
    try {
      return typeof win.getBounds === "function" ? roundedBounds(win.getBounds()) : null;
    } catch {
      return null;
    }
  }

  function hasTransientWindowBounds(win) {
    if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return true;
    try {
      if (
        (typeof win.isMaximized === "function" && win.isMaximized())
        || (typeof win.isFullScreen === "function" && win.isFullScreen())
      ) {
        return true;
      }
      // macOS's green-button "Zoom" can keep isMaximized() false. During that
      // transition getBounds() exposes the transient zoom rectangle while
      // getNormalBounds() retains the restorable user rectangle.
      const currentBounds = getCurrentWindowBounds(win);
      const normalBounds = getNormalWindowBounds(win);
      return !!currentBounds && !!normalBounds && !sameBounds(currentBounds, normalBounds);
    } catch {
      return false;
    }
  }

  // Programmatic placement and text-scale growth can emit the same native
  // move/resize events as a user drag. Rebase both persistence and event
  // baselines after the change: synchronous events are cancelled here, while
  // matching asynchronous events are ignored by isProgrammaticBoundsEvent().
  function rebaseProgrammaticBounds(win, fallbackBounds = null) {
    clearSaveBoundsTimer();
    const persistenceBaseline = getNormalWindowBounds(win) || roundedBounds(fallbackBounds);
    if (persistenceBaseline) lastSavedBounds = persistenceBaseline;
    programmaticEventBounds = getCurrentWindowBounds(win) || persistenceBaseline;
  }

  function isProgrammaticBoundsEvent(win) {
    if (programmaticBoundsMutationDepth > 0) return true;
    if (!programmaticEventBounds) return false;
    const currentBounds = getCurrentWindowBounds(win);
    if (sameBounds(currentBounds, programmaticEventBounds)) return true;
    programmaticEventBounds = null;
    return false;
  }

  function runProgrammaticBoundsMutation(callback) {
    programmaticBoundsMutationDepth += 1;
    try {
      return callback();
    } finally {
      programmaticBoundsMutationDepth -= 1;
    }
  }

  function rememberPendingUserBounds(bounds) {
    // Keep the latest user rectangle as retry debt until persistence confirms
    // success. Programmatic rebases may change lastSavedBounds, but must never
    // consume geometry that has not reached prefs yet.
    const normalized = roundedBounds(bounds);
    if (!normalized) return null;
    if (!sameBounds(normalized, pendingUserBounds)) {
      pendingUserBounds = normalized;
      pendingUserBoundsRevision += 1;
    }
    return {
      bounds: pendingUserBounds,
      revision: pendingUserBoundsRevision,
    };
  }

  function clearPersistedUserBounds(attempt) {
    if (!attempt || attempt.revision === null) return;
    if (
      pendingUserBoundsRevision === attempt.revision
      && sameBounds(pendingUserBounds, attempt.bounds)
    ) {
      pendingUserBounds = null;
    }
  }

  function persistWindowBoundsNow(win) {
    clearSaveBoundsTimer();
    if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return false;
    if (typeof ctx.onSaveBounds !== "function") return false;
    const currentBounds = getNormalWindowBounds(win);
    const bounds = pendingUserBounds || currentBounds;
    // A retry debt can equal a later programmatic baseline (for example when a
    // scale change only updates zoom and minimum size), so only dedupe geometry
    // that has no outstanding user write behind it.
    if (!bounds || (!pendingUserBounds && sameBounds(bounds, lastSavedBounds))) return false;
    const attempt = {
      bounds,
      revision: pendingUserBounds ? pendingUserBoundsRevision : null,
    };
    try {
      const result = ctx.onSaveBounds(bounds);
      if (result && typeof result.then === "function") {
        const attemptedBounds = bounds;
        Promise.resolve(result).then(
          (response) => {
            if (!response || response.status !== "error") {
              clearPersistedUserBounds(attempt);
              return;
            }
            if (sameBounds(lastSavedBounds, attemptedBounds)) lastSavedBounds = null;
            console.warn("Clawd: failed to persist Dashboard window bounds:", response.message);
          },
          (err) => {
            if (sameBounds(lastSavedBounds, attemptedBounds)) lastSavedBounds = null;
            console.warn("Clawd: failed to persist Dashboard window bounds:", err && err.message);
          },
        );
      } else if (result && result.status === "error") {
        console.warn("Clawd: failed to persist Dashboard window bounds:", result.message);
        return false;
      }
      if (!result || typeof result.then !== "function") clearPersistedUserBounds(attempt);
      programmaticEventBounds = null;
      lastSavedBounds = bounds;
      return true;
    } catch (err) {
      console.warn("Clawd: failed to persist Dashboard window bounds:", err && err.message);
      return false;
    }
  }

  function scheduleWindowBoundsSave(win) {
    if (typeof ctx.onSaveBounds !== "function") return;
    const bounds = getNormalWindowBounds(win);
    if (!pendingUserBounds && sameBounds(bounds, lastSavedBounds)) return;
    rememberPendingUserBounds(bounds);
    clearSaveBoundsTimer();
    saveBoundsTimer = scheduleTimer(() => {
      saveBoundsTimer = null;
      persistWindowBoundsNow(win);
    }, BOUNDS_SAVE_DEBOUNCE_MS);
  }

  function getCurrentSnapshot() {
    return typeof ctx.getSessionSnapshot === "function"
      ? ctx.getSessionSnapshot()
      : { sessions: [], groups: [], orderedIds: [], menuOrderedIds: [] };
  }

  // textScale is per-display; `bounds` selects the display the metrics are
  // for. Without it the host falls back to the current window, then the pet.
  function getTextScale(bounds = null) {
    return clampTextScale(typeof ctx.getTextScale === "function" ? ctx.getTextScale(bounds) : 1);
  }

  // DEFAULT_*/MIN_* are CSS px; windows are sized in DIP.
  function getScaledMetrics(bounds = null) {
    const scale = getTextScale(bounds);
    return {
      defaultWidth: scaleWidth(DEFAULT_WIDTH, scale),
      defaultHeight: scaleHeight(DEFAULT_HEIGHT, scale),
      minWidth: scaleWidth(MIN_WIDTH, scale),
      minHeight: scaleHeight(MIN_HEIGHT, scale),
    };
  }

  function computeInitialBounds() {
    const savedBounds = getSavedDashboardBounds();
    let petBounds = null;
    if (!savedBounds && typeof ctx.getPetWindowBounds === "function") {
      try { petBounds = ctx.getPetWindowBounds(); } catch { petBounds = null; }
    }
    const anchor = savedBounds || petBounds;
    const cx = anchor ? anchor.x + anchor.width / 2 : 0;
    const cy = anchor ? anchor.y + anchor.height / 2 : 0;
    const workArea = getWorkAreaNear(cx, cy);
    const metrics = getScaledMetrics(savedBounds || workArea);
    if (savedBounds) {
      return clampBoundsToWorkArea({
        ...savedBounds,
        width: Math.max(savedBounds.width, metrics.minWidth),
        height: Math.max(savedBounds.height, metrics.minHeight),
      }, workArea);
    }
    const width = Math.min(metrics.defaultWidth, Math.max(metrics.minWidth, workArea.width));
    const height = Math.min(metrics.defaultHeight, Math.max(metrics.minHeight, workArea.height));
    return {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height,
    };
  }

  function getSettingsWindow() {
    return typeof ctx.getSettingsWindow === "function"
      ? ctx.getSettingsWindow()
      : null;
  }

  function getSettingsBounds(settingsWindow) {
    if (!settingsWindow || typeof settingsWindow.isDestroyed !== "function") return null;
    if (settingsWindow.isDestroyed()) return null;
    if (typeof settingsWindow.isMinimized === "function" && settingsWindow.isMinimized()) return null;
    if (typeof settingsWindow.getBounds !== "function") return null;
    const bounds = settingsWindow.getBounds();
    return isUsableBounds(bounds) ? bounds : null;
  }

  function computeSettingsAnchoredBounds(settingsBounds) {
    const cx = settingsBounds.x + settingsBounds.width / 2;
    const cy = settingsBounds.y + settingsBounds.height / 2;
    const workArea = getWorkAreaNear(cx, cy);
    const metrics = getScaledMetrics(settingsBounds);
    const width = Math.max(metrics.minWidth, Math.min(metrics.defaultWidth, settingsBounds.width, workArea.width));
    const height = Math.max(metrics.minHeight, Math.min(settingsBounds.height, workArea.height));
    return clampBoundsToWorkArea({
      x: settingsBounds.x + (settingsBounds.width - width) / 2,
      y: settingsBounds.y,
      width,
      height,
    }, workArea);
  }

  function getDashboardPlacement(options = {}) {
    if (options.source !== "settings") {
      return { bounds: computeInitialBounds() };
    }
    // Keep Settings-opened dashboards visually attached with absolute bounds.
    // Matching native outer frames exactly is brittle on Windows because DWM can
    // add invisible borders and titlebar frame offsets per window.
    const settingsWindow = getSettingsWindow();
    const settingsBounds = getSettingsBounds(settingsWindow);
    if (!settingsBounds) {
      return { bounds: computeInitialBounds() };
    }
    return {
      bounds: computeSettingsAnchoredBounds(settingsBounds),
    };
  }

  function applySettingsPlacement(options = {}) {
    if (options.source !== "settings") return;
    if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
    const placement = getDashboardPlacement(options);
    if (isUsableBounds(placement.bounds) && typeof dashboardWindow.setBounds === "function") {
      runProgrammaticBoundsMutation(() => {
        dashboardWindow.setBounds(placement.bounds);
        // The anchored placement can land the window on a display with a
        // different textScale; re-zoom right away (memoized — cheap no-op when
        // nothing changed). This can grow the window to that display's scaled
        // minimum; the helper rebases after that growth has settled.
        applyTextScaleToWindow({
          flushPendingUserBounds: false,
          fallbackBounds: placement.bounds,
        });
      });
      // Programmatic anchoring is not user geometry. The helper's rebase keeps
      // it from overwriting the user's saved standalone position, even if
      // move/resize is delivered later.
    }
  }

  function scheduleSettingsPlacementSync(options = {}) {
    if (options.source !== "settings") return;
    for (const delay of [0, 80]) {
      scheduleLater(() => {
        applySettingsPlacement(options);
      }, delay);
    }
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

  function createDashboardWindow(options = {}) {
    const placement = getDashboardPlacement(options);
    const metrics = getScaledMetrics(placement.bounds);
    const opts = {
      ...placement.bounds,
      // Electron enforces the minimum over the requested size, so an uncapped
      // minimum would undo the work-area clamp and overflow small displays.
      minWidth: Math.min(metrics.minWidth, placement.bounds.width),
      minHeight: Math.min(metrics.minHeight, placement.bounds.height),
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
    // BrowserWindow's constructor can quantize framed window geometry at
    // fractional Windows DPI. Re-apply the requested outer bounds before
    // listeners are attached, and treat the post-correction rectangle as the
    // persistence baseline: closing an untouched window must not rewrite
    // prefs, and native frame drift must not accumulate across reopens.
    try {
      const createdBounds = typeof dashboardWindow.getBounds === "function"
        ? roundedBounds(dashboardWindow.getBounds())
        : null;
      if (
        createdBounds
        && !sameBounds(createdBounds, placement.bounds)
        && typeof dashboardWindow.setBounds === "function"
      ) {
        dashboardWindow.setBounds(placement.bounds);
      }
    } catch {}
    lastSavedBounds = getNormalWindowBounds(dashboardWindow) || placement.bounds;
    dashboardWindow.setMenuBarVisibility(false);
    dashboardWindow.loadFile(path.join(__dirname, "dashboard.html"));
    // textScale is per-display: re-resolve after the user drags the window
    // somewhere else (debounced — "move" fires continuously during drags).
    let moveTextScaleTimer = null;
    const createdWindow = dashboardWindow;
    dashboardWindow.on("move", () => {
      if (moveTextScaleTimer) clearScheduled(moveTextScaleTimer);
      moveTextScaleTimer = scheduleLater(() => {
        moveTextScaleTimer = null;
        applyTextScaleToWindow();
      }, 350);
      // Every move can cross into a display with a different text scale, even
      // while maximized/fullscreen or when native delivery follows setBounds().
      // The guards below only decide whether the rectangle is user geometry.
      if (hasTransientWindowBounds(createdWindow)) return;
      if (isProgrammaticBoundsEvent(createdWindow)) return;
      scheduleWindowBoundsSave(createdWindow);
    });
    dashboardWindow.on("resize", () => {
      if (hasTransientWindowBounds(createdWindow)) return;
      if (isProgrammaticBoundsEvent(createdWindow)) return;
      scheduleWindowBoundsSave(createdWindow);
    });
    // `closed` is too late to query native geometry. Flush while the window
    // is still live so a pending debounce cannot lose the user's last move.
    dashboardWindow.on("close", () => persistWindowBoundsNow(createdWindow));
    dashboardWindow.webContents.once("did-finish-load", () => {
      applyZoomToWindow(dashboardWindow, getTextScale());
      sendI18n();
      sendSnapshot();
    });
    dashboardWindow.once("ready-to-show", () => {
      if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
      applySettingsPlacement(options);
      dashboardWindow.show();
      scheduleSettingsPlacementSync(options);
      dashboardWindow.focus();
    });
    dashboardWindow.on("closed", () => {
      clearSaveBoundsTimer();
      if (moveTextScaleTimer) {
        clearScheduled(moveTextScaleTimer);
        moveTextScaleTimer = null;
      }
      programmaticEventBounds = null;
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

  function showDashboard(options = {}) {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      if (dashboardWindow.isMinimized()) dashboardWindow.restore();
      // A debounce still pending on an open window holds the user's own last
      // move. The re-anchor below drops that timer and rebases the baseline,
      // so without flushing first the placement is lost for good — the close
      // flush cannot recover it once the baseline matches the anchor.
      if (options.source === "settings" && saveBoundsTimer) {
        persistWindowBoundsNow(dashboardWindow);
      }
      applySettingsPlacement(options);
      dashboardWindow.show();
      scheduleSettingsPlacementSync(options);
      dashboardWindow.focus();
      sendI18n();
      sendSnapshot();
      return dashboardWindow;
    }
    return createDashboardWindow(options);
  }

  function broadcastSessionSnapshot(snapshot) {
    sendSnapshot(snapshot);
  }

  // textScale changed while the dashboard is open: re-zoom, raise the minimum
  // size, and only grow the window if it now sits below that minimum — never
  // touch a user-chosen size otherwise.
  function applyTextScaleToWindow(options = {}) {
    if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
    // A pending debounce represents the user's pre-scale geometry. Flush it
    // before minimum-size enforcement can grow the native window; otherwise
    // the timer would later read and persist the programmatic rectangle.
    if (options.flushPendingUserBounds !== false && saveBoundsTimer) {
      persistWindowBoundsNow(dashboardWindow);
    }
    runProgrammaticBoundsMutation(() => {
      const metrics = getScaledMetrics();
      applyZoomToWindow(dashboardWindow, getTextScale());
      if (typeof dashboardWindow.setMinimumSize === "function") {
        dashboardWindow.setMinimumSize(metrics.minWidth, metrics.minHeight);
      }
      const bounds = getCurrentWindowBounds(dashboardWindow);
      if (bounds && (bounds.width < metrics.minWidth || bounds.height < metrics.minHeight)) {
        dashboardWindow.setBounds({
          ...bounds,
          width: Math.max(bounds.width, metrics.minWidth),
          height: Math.max(bounds.height, metrics.minHeight),
        });
      }
      rebaseProgrammaticBounds(dashboardWindow, options.fallbackBounds || bounds);
    });
  }

  return {
    showDashboard,
    broadcastSessionSnapshot,
    sendI18n,
    getWindow: () => dashboardWindow,
    applyTextScaleToWindow,
  };
};
