"use strict";

const electron = require("electron");
const { nativeTheme } = electron;
const path = require("path");
const {
  clampTextScale,
  scaleWidth,
  scaleHeight,
  applyZoomToWebContents,
} = require("./text-scale");
const { createDashboardHost } = require("./dashboard-host");
const { createDashboardQuickMode } = require("./dashboard-quick-mode");

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
  const platform = ctx.platform || process.platform;
  let dashboardWindow = null;
  // Host wrapper for the single Dashboard page: BaseWindow + WebContentsView
  // on darwin/win32, plain BrowserWindow on Linux.
  let dashboardHost = null;
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

  // The one Dashboard WebContents. On darwin/win32 it belongs to the
  // WebContentsView, not to any window, so nothing may resolve it through
  // `window.webContents` or `BrowserWindow.fromWebContents()`.
  function getWebContents() {
    if (!dashboardHost) return null;
    const contents = dashboardHost.webContents;
    if (!contents) return null;
    if (typeof contents.isDestroyed === "function" && contents.isDestroyed()) return null;
    return contents;
  }

  function sendToPage(channel, payload) {
    const contents = getWebContents();
    if (!contents) return;
    try { contents.send(channel, payload); } catch {}
  }

  function sendSnapshot(snapshot = getCurrentSnapshot()) {
    if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
    sendToPage("dashboard:session-snapshot", snapshot);
  }

  function sendI18n() {
    if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
    if (typeof ctx.getI18n !== "function") return;
    sendToPage("dashboard:lang-change", ctx.getI18n());
  }

  function createDashboardWindow(options = {}, { autoShow = true } = {}) {
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

    dashboardHost = createDashboardHost({
      platform,
      electron: ctx.electron || electron,
      windowOptions: opts,
    });
    dashboardWindow = dashboardHost.window;
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
    dashboardHost.loadFile(path.join(__dirname, "dashboard.html"));
    // textScale is per-display: re-resolve after the user drags the window
    // somewhere else (debounced — "move" fires continuously during drags).
    let moveTextScaleTimer = null;
    const createdWindow = dashboardWindow;
    dashboardWindow.on("move", () => {
      if (moveTextScaleTimer) clearScheduled(moveTextScaleTimer);
      moveTextScaleTimer = scheduleLater(() => {
        moveTextScaleTimer = null;
        // A borrowed page follows the quick host, not this window.
        if (quickMode.isShown()) return;
        applyTextScaleToWindow();
      }, 350);
      // Every move can cross into a display with a different text scale, even
      // while maximized/fullscreen or when native delivery follows setBounds().
      // The guards below only decide whether the rectangle is user geometry.
      if (quickMode.isShown()) return;
      if (hasTransientWindowBounds(createdWindow)) return;
      if (isProgrammaticBoundsEvent(createdWindow)) return;
      scheduleWindowBoundsSave(createdWindow);
    });
    dashboardWindow.on("resize", () => {
      // While parked and empty the ordinary host is not showing user geometry;
      // nothing that happens to it during a borrow may reach prefs.
      if (quickMode.isShown()) return;
      if (hasTransientWindowBounds(createdWindow)) return;
      if (isProgrammaticBoundsEvent(createdWindow)) return;
      scheduleWindowBoundsSave(createdWindow);
    });
    // A real ordinary activation must end any live borrow AND leave the page
    // holding the keyboard.
    //
    // Handle either event ordering. On Electron 41.10.4 we measured the quick
    // host blurring first — which already ends the round and returns the view —
    // and ordinary focus arriving with nothing left to end. Tests also cover
    // focus arriving while the borrow is still live. Gating the page focus on
    // "did this event end a borrow" only handles that second ordering, so in
    // the measured first ordering the window held the keyboard while
    // document.hasFocus() stayed false.
    //
    // The two decisions are therefore independent: end a borrow if one is
    // still live, then separately ask whether this window is genuinely the
    // key host that currently owns the page.
    let focusingOwnedPage = false;
    dashboardWindow.on("focus", () => {
      if (dashboardWindow !== createdWindow) return;
      if (focusingOwnedPage) return;
      quickMode.handleNormalHostFocus();
      if (!shouldGivePageKeyboard()) return;
      // Only the page is focused — re-focusing the window would re-enter this
      // handler, and BrowserWindow already does this implicitly, so this just
      // restores the same behaviour for the BaseWindow + view host.
      focusingOwnedPage = true;
      try { focusOwnedWebContents(); } finally { focusingOwnedPage = false; }
    });
    // An in-place round lives on this window, so its blur ends the round.
    dashboardWindow.on("blur", () => {
      if (dashboardWindow !== createdWindow) return;
      quickMode.handleNormalHostBlur();
    });
    // `closed` is too late to query native geometry. Flush while the window
    // is still live so a pending debounce cannot lose the user's last move.
    dashboardWindow.on("close", () => persistWindowBoundsNow(createdWindow));
    const createdHost = dashboardHost;
    createdHost.webContents.once("did-finish-load", () => {
      if (dashboardHost !== createdHost) return;
      applyZoomToWebContents(createdHost.webContents, getTextScale());
      sendI18n();
      sendSnapshot();
    });
    // `ready-to-show` never fires on BaseWindow; the host maps the first-paint
    // signal to the real WebContents load on that path.
    createdHost.onceFirstPaint(() => {
      if (dashboardHost !== createdHost) return;
      if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
      if (!autoShow) return;
      applySettingsPlacement(options);
      dashboardWindow.show();
      scheduleSettingsPlacementSync(options);
      focusPage();
    });
    // A crashed or closed page must never leave a parked, invisible,
    // click-through ordinary host behind.
    createdHost.webContents.on("render-process-gone", () => {
      if (dashboardHost !== createdHost) return;
      quickMode.handlePageGone();
    });
    // A main-frame navigation or reload replaces the document the round was
    // negotiated with: no late enter/ready reply from the old one may revive
    // it, and a failed load must not leave a borrow in place either.
    createdHost.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (dashboardHost !== createdHost) return;
      if (isInPlace || isMainFrame === false) return;
      quickMode.invalidateRound("navigation");
    });
    createdHost.webContents.on("did-fail-load", (_event, _code, _desc, _url, isMainFrame) => {
      if (dashboardHost !== createdHost) return;
      if (isMainFrame === false) return;
      quickMode.invalidateRound("load-failed");
    });
    createdHost.webContents.on("destroyed", () => {
      if (dashboardHost !== createdHost) return;
      quickMode.handlePageGone();
    });
    dashboardWindow.on("closed", () => {
      clearSaveBoundsTimer();
      if (moveTextScaleTimer) {
        clearScheduled(moveTextScaleTimer);
        moveTextScaleTimer = null;
      }
      programmaticEventBounds = null;
      // The ordinary host is gone: end any borrow before dropping the handles,
      // then release the single WebContents exactly once.
      quickMode.handlePageGone();
      if (dashboardHost === createdHost) {
        createdHost.closeWebContents();
        dashboardHost = null;
        // A closed ordinary owner ends this Dashboard's lifetime. Its quick
        // shell may still contain the now-closed view after a failed return;
        // never reuse that shell for the next Dashboard's different page.
        quickMode.dispose();
      }
      dashboardWindow = null;
    });
    return dashboardWindow;
  }

  // Whether an ordinary-host focus event should hand the keyboard to the page.
  // Deliberately independent of whether a borrow just ended: the quick host's
  // blur may already have ended it. The guards are about where the page and
  // the native focus actually are right now.
  function shouldGivePageKeyboard() {
    if (!dashboardWindow || dashboardWindow.isDestroyed()) return false;
    // Our own detach/attach/show/hide is not a user activation.
    if (quickMode.isSelfFocusing()) return false;
    // The page is in the quick host; focusing it would pull focus back there.
    if (quickMode.isShown()) return false;
    // A parked host is transparent, input-disabled and holds no page.
    if (quickMode.isParked()) return false;
    try {
      if (typeof dashboardWindow.isFocused === "function" && !dashboardWindow.isFocused()) {
        return false;
      }
    } catch {
      return false;
    }
    return true;
  }

  // Hand the keyboard to the page itself. Kept separate from focusPage() so a
  // window that already has native focus can be given a focused page without
  // re-focusing the window (which would re-enter its own focus handler).
  function focusOwnedWebContents() {
    const contents = getWebContents();
    if (contents && typeof contents.focus === "function") {
      try { contents.focus(); } catch {}
    }
  }

  // Focus the page that currently owns the view, never a parked empty host.
  function focusPage() {
    const host = quickMode.getActiveHost() || dashboardWindow;
    if (host && (typeof host.isDestroyed !== "function" || !host.isDestroyed())) {
      try { host.focus(); } catch {}
    }
    focusOwnedWebContents();
  }

  function syncThemeBackground() {
    const color = getDashboardBackgroundColor();
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.setBackgroundColor(color);
    }
    // The quick host shows the same page and must not flash the other theme
    // behind it on the next borrow.
    const quickWindow = quickMode.getQuickWindow();
    if (quickWindow && typeof quickWindow.setBackgroundColor === "function") {
      try { quickWindow.setBackgroundColor(color); } catch {}
    }
  }

  if (nativeTheme && typeof nativeTheme.on === "function") {
    nativeTheme.on("updated", syncThemeBackground);
  }

  function showDashboard(options = {}) {
    // An ordinary open always wins over an in-flight quick round: return the
    // page and restore opacity/input before the window takes the keyboard, so
    // the user never focuses a blank parked host.
    quickMode.endForOrdinaryOpen();
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
      focusPage();
      sendI18n();
      sendSnapshot();
      return dashboardWindow;
    }
    return createDashboardWindow(options);
  }

  // Quick mode needs the page to exist without forcing the ordinary host to
  // appear: a cold or hidden/minimized Dashboard goes straight to the quick
  // host and the ordinary window stays exactly as the user left it.
  function ensurePageForQuickMode() {
    if (dashboardWindow && !dashboardWindow.isDestroyed() && dashboardHost) {
      return dashboardHost;
    }
    createDashboardWindow({}, { autoShow: false });
    return dashboardHost;
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
      // Page zoom follows whichever host actually shows the page: a settings
      // change during a borrow must not re-zoom the borrowed page to the
      // parked ordinary window's display. The window metrics below stay tied
      // to the ordinary window, so minimum size and geometry debt are
      // unaffected by the quick host.
      applyPageScale();
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

  // Quick host geometry: the ordinary host's restorable rectangle, clamped to
  // the work area it lands on. Never the transient fullscreen/maximized/Zoom
  // rectangle — borrowing that would cover the whole screen and hide the very
  // source window the jump is supposed to return to.
  function getQuickHostBounds() {
    // getNormalWindowBounds() prefers getNormalBounds(), which stays the
    // restorable rectangle while the window is maximized/fullscreen/zoomed.
    const base = getNormalWindowBounds(dashboardWindow)
      || getSavedDashboardBounds()
      || computeInitialBounds();
    const cx = base.x + base.width / 2;
    const cy = base.y + base.height / 2;
    const workArea = getWorkAreaNear(cx, cy);
    const metrics = getScaledMetrics(base);
    return clampBoundsToWorkArea({
      ...base,
      width: Math.max(Math.min(base.width, workArea.width), Math.min(metrics.minWidth, workArea.width)),
      height: Math.max(Math.min(base.height, workArea.height), Math.min(metrics.minHeight, workArea.height)),
    }, workArea);
  }

  // Move the single view between hosts. Detach from every known host first so
  // the page can never be attached twice.
  function attachViewTo(targetWindow) {
    if (!dashboardHost || !dashboardHost.usesView || !dashboardHost.view) return false;
    if (!targetWindow || (typeof targetWindow.isDestroyed === "function" && targetWindow.isDestroyed())) {
      return false;
    }
    const view = dashboardHost.view;
    for (const host of [dashboardWindow, quickMode.getQuickWindow()]) {
      if (!host || host === targetWindow) continue;
      if (typeof host.isDestroyed === "function" && host.isDestroyed()) continue;
      try { host.contentView.removeChildView(view); } catch {}
    }
    try {
      targetWindow.contentView.addChildView(view);
    } catch {
      // The page is now parented to nothing. Put it back where it belongs so
      // the caller's rollback has something to restore.
      try { dashboardWindow.contentView.addChildView(view); } catch {}
      dashboardHost.setHostedWindow(dashboardWindow);
      return false;
    }
    dashboardHost.setHostedWindow(targetWindow);
    syncViewBoundsFor(targetWindow);
    return true;
  }

  function syncViewBoundsFor(targetWindow) {
    if (!dashboardHost || !dashboardHost.usesView || !dashboardHost.view) return;
    const host = targetWindow || quickMode.getActiveHost() || dashboardWindow;
    if (!host || (typeof host.isDestroyed === "function" && host.isDestroyed())) return;
    let size = null;
    try { size = host.getContentSize(); } catch { size = null; }
    if (!Array.isArray(size) || size.length < 2) return;
    try {
      dashboardHost.view.setBounds({ x: 0, y: 0, width: size[0], height: size[1] });
    } catch {}
  }

  // Re-inject the page zoom for whichever display the active host sits on.
  // Deliberately narrow: it must not touch minimum size, the geometry
  // baseline or pendingUserBounds, because a borrow is not user geometry.
  function applyPageScale() {
    const host = quickMode.getActiveHost() || dashboardWindow;
    const bounds = getCurrentWindowBounds(host);
    applyZoomToWebContents(getWebContents(), getTextScale(bounds));
  }

  const quickMode = createDashboardQuickMode({
    platform,
    electron: ctx.electron || electron,
    t: ctx.t,
    iconPath: ctx.iconPath,
    getBackgroundColor: getDashboardBackgroundColor,
    getSessionSnapshot: getCurrentSnapshot,
    focusSession: ctx.focusSession,
    isAppQuitting: ctx.isAppQuitting,
    getNormalWindow: () => dashboardWindow,
    getWebContents,
    // getWebContents() filters dead pages; null alone is not death proof.
    isPageDestroyed: () => dashboardHost?.webContents?.isDestroyed() === true,
    ensurePage: ensurePageForQuickMode,
    getQuickHostBounds,
    attachViewTo,
    syncViewBounds: () => syncViewBoundsFor(null),
    applyPageScale,
    focusPage,
    focusReturnedPage: (win) => {
      // The mode has just confirmed this exact native foreground. Recheck the
      // owner's actual view attachment before focusing only its WebContents.
      if (win !== dashboardWindow || !dashboardHost || dashboardHost.getHostedWindow() !== win) return;
      const contents = getWebContents();
      if (!contents || (typeof contents.isCrashed === "function" && contents.isCrashed())) return;
      focusOwnedWebContents();
    },
  });

  return {
    showDashboard,
    broadcastSessionSnapshot(snapshot) {
      broadcastSessionSnapshot(snapshot);
      quickMode.broadcastSessionSnapshot(snapshot);
    },
    sendI18n,
    getWindow: () => dashboardWindow,
    getWebContents,
    // The window that currently owns the page — the modal parent and the
    // focus check must both use this, not `BrowserWindow.fromWebContents()`.
    getActiveHost: () => quickMode.getActiveHost() || dashboardWindow,
    getHostForWebContents(sender) {
      const contents = getWebContents();
      if (!contents || !sender || sender !== contents) return null;
      return quickMode.getActiveHost() || dashboardWindow;
    },
    // Management actions that need a modal must run against a real ordinary
    // window, so end the borrow and promote the Dashboard first.
    promoteToOrdinaryWindow() {
      quickMode.endForOrdinaryOpen();
      if (!dashboardWindow || dashboardWindow.isDestroyed()) return null;
      try {
        if (dashboardWindow.isMinimized()) dashboardWindow.restore();
        dashboardWindow.show();
      } catch {}
      focusPage();
      return dashboardWindow;
    },
    applyTextScaleToWindow,
    quick: quickMode,
  };
};
