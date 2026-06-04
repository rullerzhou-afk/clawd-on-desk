"use strict";

const createPetGeometryMain = require("./pet-geometry-main");
const {
  computeLooseClamp,
  getDisplayInsets,
  findMatchingDisplay,
  isPointInAnyWorkArea,
  SYNTHETIC_WORK_AREA,
} = require("./work-area");
const {
  getThemeMarginBox,
  computeStableVisibleContentMargins,
  getLooseDragMargins,
  getRestClampMargins,
} = require("./visible-margins");
const {
  createDragSnapshot,
  computeAnchoredDragBounds,
  computeFinalDragBounds: computeFinalDragBoundsRaw,
  needsFinalClampAdjustment: needsFinalClampAdjustmentRaw,
  materializeVirtualBounds: materializeVirtualBoundsRaw,
} = require("./drag-position");

const noop = () => {};

function isLiveWindow(win) {
  return !!(win && typeof win.isDestroyed === "function" && !win.isDestroyed());
}

function createPetWindowRuntime(options = {}) {
  const screen = options.screen || {};
  const isWin = !!options.isWin;
  const isMac = !!options.isMac;
  const isLinux = !!options.isLinux;
  const linuxWindowType = options.linuxWindowType;
  const topmostLevel = options.topmostLevel;
  const getRenderWindow = options.getRenderWindow || (() => null);
  const getHitWindow = options.getHitWindow || (() => null);
  const getSettingsWindow = options.getSettingsWindow || (() => null);
  const getPrimaryWorkAreaSafe = options.getPrimaryWorkAreaSafe || (() => null);
  const getNearestWorkArea = options.getNearestWorkArea || (() => getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA);
  const getActiveTheme = options.getActiveTheme || (() => null);
  const getCurrentState = options.getCurrentState || (() => null);
  const getCurrentSvg = options.getCurrentSvg || (() => null);
  const getCurrentHitBox = options.getCurrentHitBox || (() => null);
  const getMiniMode = options.getMiniMode || (() => false);
  const getMiniTransitioning = options.getMiniTransitioning || (() => false);
  const getMiniContainedSeam = options.getMiniContainedSeam || (() => null);
  const getMiniPeekOffset = options.getMiniPeekOffset || (() => 0);
  const getCurrentPixelSize = options.getCurrentPixelSize || (() => null);
  const getEffectiveCurrentPixelSize = options.getEffectiveCurrentPixelSize || getCurrentPixelSize;
  const getKeepSizeAcrossDisplays = options.getKeepSizeAcrossDisplays || (() => false);
  const getAllowEdgePinning = options.getAllowEdgePinning || (() => false);
  const isProportionalMode = options.isProportionalMode || (() => false);
  const sendToRenderer = options.sendToRenderer || noop;
  const keepOutOfTaskbar = options.keepOutOfTaskbar || noop;
  const repositionSessionHud = options.repositionSessionHud || noop;
  const repositionAnchoredSurfaces = options.repositionAnchoredSurfaces || noop;
  const repositionFloatingBubbles = options.repositionFloatingBubbles || noop;
  const showFloatingSurfacesForPet = options.showFloatingSurfacesForPet || noop;
  const hideFloatingSurfacesForPet = options.hideFloatingSurfacesForPet || noop;
  const syncSessionHudVisibilityAndBubbles = options.syncSessionHudVisibilityAndBubbles || noop;
  const syncPermissionShortcuts = options.syncPermissionShortcuts || noop;
  const buildTrayMenu = options.buildTrayMenu || noop;
  const buildContextMenu = options.buildContextMenu || noop;
  const reapplyMacVisibility = options.reapplyMacVisibility || noop;
  const reassertWinTopmost = options.reassertWinTopmost || noop;
  const scheduleHwndRecovery = options.scheduleHwndRecovery || noop;
  const isNearWorkAreaEdge = options.isNearWorkAreaEdge || (() => false);
  const flushRuntimeStateToPrefs = options.flushRuntimeStateToPrefs || noop;
  const handleMiniDisplayChange = options.handleMiniDisplayChange || noop;
  const exitMiniMode = options.exitMiniMode || noop;

  const petGeometryMain = createPetGeometryMain({
    getActiveTheme,
    getCurrentState,
    getCurrentSvg,
    getCurrentHitBox,
    getMiniMode,
    getMiniPeekOffset,
  });

  let viewportOffsetY = 0;
  let petHidden = false;
  let dragLocked = false;
  let dragSnapshot = null;
  let hitShapeWidth = 0;
  let hitShapeHeight = 0;
  let settingsSizePreviewSyncFrozen = false;
  const themeMarginEnvelopeCache = new Map();

  function getPrimaryWorkAreaFallback() {
    return getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA;
  }

  function getAllDisplays() {
    return typeof screen.getAllDisplays === "function" ? screen.getAllDisplays() : [];
  }

  function getCursorScreenPoint() {
    return typeof screen.getCursorScreenPoint === "function"
      ? screen.getCursorScreenPoint()
      : null;
  }

  function getNearestDisplayBottomInset(cx, cy) {
    const point = { x: Math.round(cx), y: Math.round(cy) };
    let display = null;
    try {
      if (typeof screen.getDisplayNearestPoint === "function") {
        display = screen.getDisplayNearestPoint(point);
      }
    } catch {}
    if (!display || !display.bounds || !display.workArea) {
      try {
        if (typeof screen.getPrimaryDisplay === "function") display = screen.getPrimaryDisplay();
      } catch {}
    }
    return getDisplayInsets(display).bottom;
  }

  function setViewportOffsetY(offsetY) {
    const next = Number.isFinite(offsetY) ? Math.max(0, Math.round(offsetY)) : 0;
    if (next === viewportOffsetY) return;
    viewportOffsetY = next;
    sendToRenderer("viewport-offset", viewportOffsetY);
  }

  function getViewportOffsetY() {
    return viewportOffsetY;
  }

  function getPetWindowBounds() {
    const win = getRenderWindow();
    if (!isLiveWindow(win)) return null;
    const bounds = win.getBounds();
    return {
      x: bounds.x,
      y: bounds.y - viewportOffsetY,
      width: bounds.width,
      height: bounds.height,
    };
  }

  function materializeVirtualBounds(bounds, workArea) {
    const resolvedWorkArea = workArea || (
      bounds
        ? getNearestWorkArea(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        : null
    );
    return materializeVirtualBoundsRaw(bounds, resolvedWorkArea);
  }

  function applyPetWindowBounds(bounds) {
    const win = getRenderWindow();
    if (!isLiveWindow(win) || !bounds) return null;
    const materialized = materializeVirtualBounds(bounds);
    if (!materialized) return null;
    win.setBounds(materialized.bounds);
    setViewportOffsetY(materialized.viewportOffsetY);
    repositionSessionHud();
    return materialized.bounds;
  }

  function applyPetWindowPosition(x, y) {
    const bounds = getPetWindowBounds();
    if (!bounds) return null;
    return applyPetWindowBounds({ ...bounds, x, y });
  }

  function isPetHidden() {
    return petHidden;
  }

  function showPetWindows() {
    const win = getRenderWindow();
    if (isLiveWindow(win)) {
      win.showInactive();
      keepOutOfTaskbar(win);
    }
    const hitWin = getHitWindow();
    if (isLiveWindow(hitWin)) {
      hitWin.showInactive();
      keepOutOfTaskbar(hitWin);
    }
  }

  function hidePetWindows() {
    const win = getRenderWindow();
    if (isLiveWindow(win)) win.hide();
    const hitWin = getHitWindow();
    if (isLiveWindow(hitWin)) hitWin.hide();
  }

  // Idempotent visibility setter. Returns { applied, deferred, changed }:
  //  - no render window  -> { applied:false, deferred:false, changed:false }
  //  - mini transitioning -> { applied:false, deferred:true,  changed:false } (petHidden untouched)
  //  - already in target  -> { applied:true,  deferred:false, changed:false }
  //  - state flipped      -> { applied:true,  deferred:false, changed:true  }
  function setPetHidden(hidden) {
    const target = !!hidden;
    const win = getRenderWindow();
    if (!isLiveWindow(win)) return { applied: false, deferred: false, changed: false };
    if (getMiniTransitioning()) return { applied: false, deferred: true, changed: false };
    if (target === petHidden) return { applied: true, deferred: false, changed: false };
    if (petHidden) {
      // becoming visible
      showPetWindows();
      showFloatingSurfacesForPet();
      reapplyMacVisibility();
      petHidden = false;
    } else {
      // becoming hidden
      hidePetWindows();
      hideFloatingSurfacesForPet();
      petHidden = true;
    }
    syncSessionHudVisibilityAndBubbles();
    syncPermissionShortcuts();
    buildTrayMenu();
    buildContextMenu();
    return { applied: true, deferred: false, changed: true };
  }

  function togglePetVisibility() {
    return setPetHidden(!petHidden);
  }

  function bringPetToPrimaryDisplay() {
    const win = getRenderWindow();
    if (!isLiveWindow(win)) return;
    if (getMiniMode() || getMiniTransitioning()) return;

    const workArea = getPrimaryWorkAreaFallback();
    const size = getEffectiveCurrentPixelSize(workArea);
    const bounds = {
      x: Math.round(workArea.x + (workArea.width - size.width) / 2),
      y: Math.round(workArea.y + (workArea.height - size.height) / 2),
      width: size.width,
      height: size.height,
    };

    applyPetWindowBounds(bounds);
    syncHitWin();
    repositionFloatingBubbles();

    if (petHidden) {
      togglePetVisibility();
    } else {
      showPetWindows();
    }

    reapplyMacVisibility();
    reassertWinTopmost();
    scheduleHwndRecovery();
    flushRuntimeStateToPrefs();
  }

  function getObjRect(bounds) {
    return petGeometryMain.getObjRect(bounds);
  }

  function getAssetPointerPayload(bounds, point) {
    return petGeometryMain.getAssetPointerPayload(bounds, point);
  }

  function getHitRectScreen(bounds) {
    return clipHitRectToMiniSeam(petGeometryMain.getHitRectScreen(bounds));
  }

  function getUpdateBubbleAnchorRect(bounds) {
    return petGeometryMain.getUpdateBubbleAnchorRect(bounds);
  }

  function getSessionHudAnchorRect(bounds) {
    return petGeometryMain.getSessionHudAnchorRect(bounds);
  }

  function getVisibleContentMargins(bounds) {
    const theme = getActiveTheme();
    if (!bounds || !theme) return { top: 0, bottom: 0 };
    const box = getThemeMarginBox(theme);
    if (!box) return { top: 0, bottom: 0 };

    const cacheKey = [
      theme._id || "",
      theme._variantId || "",
      bounds.width,
      bounds.height,
      JSON.stringify(box),
    ].join("|");
    const cached = themeMarginEnvelopeCache.get(cacheKey);
    if (cached) return cached;

    const margins = computeStableVisibleContentMargins(theme, bounds, { box });
    themeMarginEnvelopeCache.set(cacheKey, margins);
    return margins;
  }

  function looseClampPetToDisplays(x, y, w, h) {
    const margins = getVisibleContentMargins({ x, y, width: w, height: h });
    const bottomInset = getNearestDisplayBottomInset(x + w / 2, y + h / 2);
    return computeLooseClamp(
      getAllDisplays(),
      getPrimaryWorkAreaSafe(),
      x,
      y,
      w,
      h,
      getLooseDragMargins({
        width: w,
        height: h,
        visibleMargins: margins,
        allowEdgePinning: getAllowEdgePinning(),
        bottomInset,
      })
    );
  }

  function clampToScreenVisual(x, y, w, h, optionsArg = {}) {
    const margins = getVisibleContentMargins(
      { x, y, width: w, height: h },
      optionsArg
    );
    const nearest = getNearestWorkArea(x + w / 2, y + h / 2);
    const bottomInset = getNearestDisplayBottomInset(x + w / 2, y + h / 2);
    const mLeft = Math.round(w * 0.25);
    const mRight = Math.round(w * 0.25);
    const clampMargins = getRestClampMargins({
      height: h,
      visibleMargins: margins,
      allowEdgePinning: "allowEdgePinning" in optionsArg
        ? optionsArg.allowEdgePinning
        : getAllowEdgePinning(),
      bottomInset,
    });
    return {
      x: Math.max(nearest.x - mLeft, Math.min(x, nearest.x + nearest.width - w + mRight)),
      y: Math.max(
        nearest.y - clampMargins.top,
        Math.min(y, nearest.y + nearest.height - h + clampMargins.bottom)
      ),
    };
  }

  function clampToScreen(x, y, w, h) {
    return clampToScreenVisual(x, y, w, h);
  }

  function computeFinalDragBounds(bounds, size, clampPosition = clampToScreenVisual) {
    return computeFinalDragBoundsRaw(bounds, size, clampPosition);
  }

  function needsFinalClampAdjustment(bounds, size, clampPosition = clampToScreenVisual) {
    return needsFinalClampAdjustmentRaw(bounds, size, clampPosition);
  }

  // At an internal multi-monitor seam the render window is clip-pathed so its
  // seam-crossing half shows nothing — but the hit (input) window is a
  // transparent surface and would keep capturing clicks over the neighbouring
  // display. Clip the hit rect to the same seam so those clicks fall through.
  // The clamps keep the rect from inverting when the whole hit rect is past
  // the seam; the w<=0 guard in the callers then drops the degenerate result.
  function clipHitRectToMiniSeam(hit) {
    if (!hit) return hit;
    const seam = getMiniContainedSeam();
    if (!seam || !Number.isFinite(seam.boundary)) return hit;
    if (seam.edge === "right") {
      if (hit.right <= seam.boundary) return hit;
      return { ...hit, right: Math.max(hit.left, seam.boundary) };
    }
    if (hit.left >= seam.boundary) return hit;
    return { ...hit, left: Math.min(hit.right, seam.boundary) };
  }

  function syncHitWin() {
    const hitWin = getHitWindow();
    const win = getRenderWindow();
    if (!isLiveWindow(hitWin) || !isLiveWindow(win)) return;
    // Keep the captured pointer stable while dragging. Repositioning the input
    // window mid-drag can break pointer capture on Windows.
    if (dragLocked) return;
    const bounds = getPetWindowBounds();
    const hit = getHitRectScreen(bounds);
    if (!hit) return;
    const x = Math.round(hit.left);
    const y = Math.round(hit.top);
    const w = Math.round(hit.right - hit.left);
    const h = Math.round(hit.bottom - hit.top);
    if (w <= 0 || h <= 0) return;
    hitWin.setBounds({ x, y, width: w, height: h });
    // Update shape if hitbox dimensions changed (e.g. after resize).
    if (w !== hitShapeWidth || h !== hitShapeHeight) {
      hitShapeWidth = w;
      hitShapeHeight = h;
      hitWin.setShape([{ x: 0, y: 0, width: w, height: h }]);
    }
    repositionSessionHud();
  }

  function getInitialHitWindowBounds(renderBounds = getPetWindowBounds()) {
    const hit = getHitRectScreen(renderBounds);
    if (!hit) return null;
    return {
      x: Math.round(hit.left),
      y: Math.round(hit.top),
      width: Math.round(hit.right - hit.left),
      height: Math.round(hit.bottom - hit.top),
    };
  }

  function createRenderWindow(optionsArg = {}) {
    const BrowserWindow = optionsArg.BrowserWindow;
    if (typeof BrowserWindow !== "function") {
      throw new Error("createRenderWindow requires BrowserWindow");
    }
    const isQuitting = typeof optionsArg.isQuitting === "function" ? optionsArg.isQuitting : () => false;
    const size = optionsArg.size;
    const initialWindowBounds = optionsArg.initialWindowBounds;
    const renderWin = new BrowserWindow({
      width: size.width,
      height: size.height,
      x: initialWindowBounds.x,
      y: initialWindowBounds.y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      fullscreenable: false,
      enableLargerThanScreen: true,
      ...(isLinux ? { type: linuxWindowType } : {}),
      ...(isMac ? { type: "panel", roundedCorners: false } : {}),
      webPreferences: {
        preload: optionsArg.preloadPath,
        backgroundThrottling: false,
        additionalArguments: [
          "--theme-config=" + JSON.stringify(optionsArg.themeConfig),
        ],
      },
    });

    if (typeof optionsArg.setRenderWindow === "function") {
      optionsArg.setRenderWindow(renderWin);
    }
    renderWin.setFocusable(false);

    if (isLinux) {
      renderWin.on("close", (event) => {
        if (!isQuitting()) {
          event.preventDefault();
          if (!renderWin.isVisible()) {
            renderWin.showInactive();
            keepOutOfTaskbar(renderWin);
          }
        }
      });
      renderWin.on("unresponsive", () => {
        if (isQuitting()) return;
        console.warn("Clawd: renderer unresponsive — reloading");
        renderWin.webContents.reload();
      });
    }

    if (isWin) renderWin.setAlwaysOnTop(true, topmostLevel);
    renderWin.loadFile(optionsArg.loadFilePath);
    applyPetWindowBounds(optionsArg.initialVirtualBounds);
    renderWin.showInactive();
    keepOutOfTaskbar(renderWin);
    reapplyMacVisibility();

    if (isMac && typeof optionsArg.applyDockVisibility === "function") {
      setTimeout(() => {
        if (!isLiveWindow(renderWin)) return;
        optionsArg.applyDockVisibility();
      }, 0);
    }

    return renderWin;
  }

  function createHitWindow(optionsArg = {}) {
    const BrowserWindow = optionsArg.BrowserWindow;
    if (typeof BrowserWindow !== "function") {
      throw new Error("createHitWindow requires BrowserWindow");
    }
    const initialHitWindowBounds = getInitialHitWindowBounds();
    const hitWin = new BrowserWindow({
      width: initialHitWindowBounds.width,
      height: initialHitWindowBounds.height,
      x: initialHitWindowBounds.x,
      y: initialHitWindowBounds.y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      fullscreenable: false,
      enableLargerThanScreen: true,
      ...(isLinux ? { type: linuxWindowType } : {}),
      ...(isMac ? { type: "panel", roundedCorners: false } : {}),
      // KEY EXPERIMENT: allow activation to avoid WS_EX_NOACTIVATE input
      // routing bugs. Linux keeps the old non-focusable behavior.
      focusable: !isLinux,
      webPreferences: {
        preload: optionsArg.preloadPath,
        backgroundThrottling: false,
        additionalArguments: [
          "--hit-theme-config=" + JSON.stringify(optionsArg.hitThemeConfig),
          "--hit-platform=" + process.platform,
        ],
      },
    });
    // setShape: native hit region, no per-pixel alpha dependency.
    // hitWin has no visual content, so clipping is irrelevant.
    hitWin.setShape([{ x: 0, y: 0, width: initialHitWindowBounds.width, height: initialHitWindowBounds.height }]);
    hitWin.setIgnoreMouseEvents(false); // PERMANENT: never toggle outside settings preview protection.
    if (isMac) hitWin.setFocusable(false);
    hitWin.showInactive();
    keepOutOfTaskbar(hitWin);
    if (isWin) hitWin.setAlwaysOnTop(true, topmostLevel);
    reapplyMacVisibility();
    hitWin.loadFile(optionsArg.loadFilePath);
    if (isWin && typeof optionsArg.guardAlwaysOnTop === "function") {
      optionsArg.guardAlwaysOnTop(hitWin);
    }
    if (typeof optionsArg.onDidFinishLoad === "function") {
      hitWin.webContents.on("did-finish-load", () => optionsArg.onDidFinishLoad(hitWin));
    }
    hitWin.webContents.on("render-process-gone", (_event, details) => {
      if (typeof optionsArg.onRenderProcessGone === "function") {
        optionsArg.onRenderProcessGone(details, hitWin);
        return;
      }
      hitWin.webContents.reload();
    });
    return hitWin;
  }

  function setDragLocked(value) {
    dragLocked = !!value;
  }

  function isDragLocked() {
    return dragLocked;
  }

  function beginDragSnapshot() {
    const win = getRenderWindow();
    if (!isLiveWindow(win)) {
      dragSnapshot = null;
      return;
    }
    const bounds = getPetWindowBounds();
    if (!bounds) {
      dragSnapshot = null;
      return;
    }
    // When keepSizeAcrossDisplays is on, the pet may currently be sized from
    // a prior display. Snapshotting getCurrentPixelSize() here would snap it
    // to the current display's proportional size at drag start.
    const size = getKeepSizeAcrossDisplays()
      ? { width: bounds.width, height: bounds.height }
      : getCurrentPixelSize();
    dragSnapshot = createDragSnapshot(
      getCursorScreenPoint(),
      bounds,
      size
    );
  }

  function clearDragSnapshot() {
    dragSnapshot = null;
  }

  function moveWindowForDrag() {
    if (!dragLocked) return;
    if (getMiniMode() || getMiniTransitioning()) return;
    if (!isLiveWindow(getRenderWindow())) return;
    if (!dragSnapshot) return;

    const bounds = computeAnchoredDragBounds(
      dragSnapshot,
      getCursorScreenPoint(),
      looseClampPetToDisplays
    );
    if (!bounds) return;

    applyPetWindowBounds(bounds);
    if (isWin && isNearWorkAreaEdge(bounds)) reassertWinTopmost();
    syncHitWin();
    repositionAnchoredSurfaces();
  }

  function hasStoredPositionThemeMismatch(prefs) {
    const theme = getActiveTheme();
    if (!prefs || !theme) return false;
    return prefs.positionThemeId !== theme._id
      || prefs.positionVariantId !== theme._variantId;
  }

  function resolveStartupPlacement(prefs, size, optionsArg = {}) {
    const restoreMiniFromPrefs = optionsArg.restoreMiniFromPrefs || (() => null);
    let startBounds;
    if (prefs.miniMode) {
      startBounds = restoreMiniFromPrefs(prefs, size);
    } else if (prefs.positionSaved) {
      startBounds = { x: prefs.x, y: prefs.y, width: size.width, height: size.height };
    } else {
      const workArea = getPrimaryWorkAreaFallback();
      startBounds = {
        x: workArea.x + workArea.width - size.width - 20,
        y: workArea.y + workArea.height - size.height - 20,
        width: size.width,
        height: size.height,
      };
    }

    const allDisplays = getAllDisplays();
    const savedDisplayStillAttached = !!findMatchingDisplay(
      prefs.positionDisplay,
      allDisplays
    );
    const savedCenterVisible = isPointInAnyWorkArea(
      startBounds.x + startBounds.width / 2,
      startBounds.y + startBounds.height / 2,
      allDisplays
    );
    const startupNeedsRegularize = prefs.positionSaved
      && !prefs.miniMode
      && (
        hasStoredPositionThemeMismatch(prefs)
        || (
          !(savedDisplayStillAttached && savedCenterVisible)
          && needsFinalClampAdjustment(startBounds, size, clampToScreenVisual)
        )
      );
    const startupRegularizedBounds = startupNeedsRegularize
      ? computeFinalDragBounds(startBounds, size, clampToScreenVisual)
      : null;
    const initialVirtualBounds = startupRegularizedBounds || startBounds;
    const initialMaterialized = materializeVirtualBounds(initialVirtualBounds);
    return {
      startBounds,
      startupNeedsRegularize,
      startupRegularizedBounds,
      initialVirtualBounds,
      initialWindowBounds: (initialMaterialized && initialMaterialized.bounds) || initialVirtualBounds,
    };
  }

  function beginSettingsSizePreviewProtection() {
    settingsSizePreviewSyncFrozen = true;
    if (!isWin) return;
    const settingsWindow = getSettingsWindow();
    if (
      isLiveWindow(settingsWindow)
      && typeof settingsWindow.setAlwaysOnTop === "function"
    ) {
      settingsWindow.setAlwaysOnTop(true, topmostLevel);
      if (typeof settingsWindow.moveTop === "function") settingsWindow.moveTop();
    }
    const hitWin = getHitWindow();
    if (
      isLiveWindow(hitWin)
      && typeof hitWin.setIgnoreMouseEvents === "function"
    ) {
      hitWin.setIgnoreMouseEvents(true);
    }
  }

  function endSettingsSizePreviewProtection() {
    settingsSizePreviewSyncFrozen = false;
    if (!isWin) return;
    const settingsWindow = getSettingsWindow();
    if (
      isLiveWindow(settingsWindow)
      && typeof settingsWindow.setAlwaysOnTop === "function"
    ) {
      settingsWindow.setAlwaysOnTop(false);
    }
    const hitWin = getHitWindow();
    if (
      isLiveWindow(hitWin)
      && typeof hitWin.setIgnoreMouseEvents === "function"
    ) {
      hitWin.setIgnoreMouseEvents(false);
      hitWin.setAlwaysOnTop(true, topmostLevel);
    }
    reassertWinTopmost();
    scheduleHwndRecovery();
  }

  function syncFloatingWindowsAfterPetBoundsChange() {
    if (settingsSizePreviewSyncFrozen) return;
    syncHitWin();
    repositionAnchoredSurfaces();
  }

  function handleDisplayMetricsChanged() {
    reapplyMacVisibility();
    const win = getRenderWindow();
    if (!isLiveWindow(win)) return;
    if (getMiniTransitioning()) return;
    if (getMiniMode()) {
      handleMiniDisplayChange();
      return;
    }
    const current = getPetWindowBounds();
    const size = getKeepSizeAcrossDisplays()
      ? { width: current.width, height: current.height }
      : getCurrentPixelSize();
    const clamped = clampToScreenVisual(current.x, current.y, size.width, size.height);
    const proportionalRecalc = isProportionalMode() && !getKeepSizeAcrossDisplays();
    if (proportionalRecalc || clamped.x !== current.x || clamped.y !== current.y) {
      applyPetWindowBounds({ ...clamped, width: size.width, height: size.height });
      syncHitWin();
      repositionAnchoredSurfaces();
    }
  }

  function handleDisplayRemoved() {
    reapplyMacVisibility();
    const win = getRenderWindow();
    if (!isLiveWindow(win)) return;
    if (getMiniTransitioning()) return;
    if (getMiniMode()) {
      exitMiniMode();
      return;
    }
    const current = getPetWindowBounds();
    const size = getKeepSizeAcrossDisplays()
      ? { width: current.width, height: current.height }
      : getCurrentPixelSize();
    const clamped = clampToScreenVisual(current.x, current.y, size.width, size.height);
    applyPetWindowBounds({ ...clamped, width: size.width, height: size.height });
    syncHitWin();
    repositionAnchoredSurfaces();
  }

  function handleDisplayAdded() {
    reapplyMacVisibility();
    const win = getRenderWindow();
    if (isLiveWindow(win) && !getMiniTransitioning() && getMiniMode()) {
      handleMiniDisplayChange();
    }
    repositionAnchoredSurfaces();
  }

  return {
    getObjRect,
    getAssetPointerPayload,
    getHitRectScreen,
    getUpdateBubbleAnchorRect,
    getSessionHudAnchorRect,
    getPetWindowBounds,
    applyPetWindowBounds,
    applyPetWindowPosition,
    isPetHidden,
    setPetHidden,
    togglePetVisibility,
    bringPetToPrimaryDisplay,
    getViewportOffsetY,
    setViewportOffsetY,
    getVisibleContentMargins,
    looseClampPetToDisplays,
    clampToScreenVisual,
    clampToScreen,
    computeFinalDragBounds,
    needsFinalClampAdjustment,
    materializeVirtualBounds,
    syncHitWin,
    getInitialHitWindowBounds,
    createRenderWindow,
    createHitWindow,
    setDragLocked,
    isDragLocked,
    beginDragSnapshot,
    clearDragSnapshot,
    moveWindowForDrag,
    resolveStartupPlacement,
    beginSettingsSizePreviewProtection,
    endSettingsSizePreviewProtection,
    syncFloatingWindowsAfterPetBoundsChange,
    handleDisplayMetricsChanged,
    handleDisplayRemoved,
    handleDisplayAdded,
  };
}

module.exports = createPetWindowRuntime;
