"use strict";

const defaultFs = require("fs");
const defaultPath = require("path");

// Design invariant: this closure is the only active-theme owner. theme-loader
// stays a stateless loader; legacy active facades must delegate here.

function requiredDependency(value, name) {
  if (!value) throw new Error(`createThemeRuntime requires ${name}`);
  return value;
}

function isLiveWindow(win) {
  return !!(win && (typeof win.isDestroyed !== "function" || !win.isDestroyed()));
}

function callMethod(owner, method, ...args) {
  if (!owner || typeof owner[method] !== "function") {
    throw new Error(`theme runtime requires ${method}()`);
  }
  return owner[method](...args);
}

function createThemeRuntime(options = {}) {
  const themeLoader = requiredDependency(options.themeLoader, "themeLoader");
  const settingsController = requiredDependency(options.settingsController, "settingsController");
  const fs = options.fs || defaultFs;
  const path = options.path || defaultPath;
  const getRenderWindow = options.getRenderWindow || (() => null);
  const getHitWindow = options.getHitWindow || (() => null);
  const getStateRuntime = options.getStateRuntime || (() => null);
  const getTickRuntime = options.getTickRuntime || (() => null);
  const getMiniRuntime = options.getMiniRuntime || (() => null);
  const getAnimationOverridesRuntime = options.getAnimationOverridesRuntime || (() => null);
  const getFadeSequencer = options.getFadeSequencer || (() => null);
  const getPetWindowBounds = options.getPetWindowBounds || (() => null);
  const applyPetWindowBounds = options.applyPetWindowBounds || (() => null);
  const computeFinalDragBounds = options.computeFinalDragBounds || (() => null);
  const clampToScreenVisual = options.clampToScreenVisual || ((x, y) => ({ x, y }));
  const flushRuntimeStateToPrefs = options.flushRuntimeStateToPrefs || (() => {});
  const syncHitStateAfterLoad = options.syncHitStateAfterLoad || (() => {});
  const syncRendererStateAfterLoad = options.syncRendererStateAfterLoad || (() => {});
  const syncHitWin = options.syncHitWin || (() => {});
  const syncSessionHudVisibility = options.syncSessionHudVisibility || (() => {});
  const startMainTick = options.startMainTick || (() => {});
  const invalidateDisplayedVisual = options.invalidateDisplayedVisual || (() => {});
  const refreshDisplayedVisualHitBoxes = options.refreshDisplayedVisualHitBoxes || (() => {});
  const bumpAnimationOverridePreviewPosterGeneration =
    options.bumpAnimationOverridePreviewPosterGeneration || (() => {});
  const rebuildAllMenus = options.rebuildAllMenus || (() => {});
  const isManagedTheme = options.isManagedTheme || (() => false);

  let activeTheme = null;
  let activeThemeContext = null;
  let reloadInProgress = false;
  // Resolvers waiting for the renderer to finish loading the new theme assets.
  // `activateTheme` returns before the fade/reload sequencer settles, so a
  // caller that must delete the old on-disk assets (official theme uninstall)
  // waits on this instead of trusting the command's own resolve.
  const reloadWaiters = new Set();

  function waitForThemeReloadSettled(opts = {}) {
    if (!reloadInProgress) return Promise.resolve({ status: "settled", reason: "idle" });
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 8000;
    return new Promise((resolvePromise) => {
      const entry = {};
      entry.timer = setTimeout(() => {
        reloadWaiters.delete(entry);
        resolvePromise({ status: "timeout" });
      }, timeoutMs);
      entry.resolve = (value) => {
        clearTimeout(entry.timer);
        resolvePromise(value || { status: "settled" });
      };
      reloadWaiters.add(entry);
    });
  }

  function resolveReloadWaiters(value) {
    for (const entry of [...reloadWaiters]) {
      reloadWaiters.delete(entry);
      try { entry.resolve(value); } catch {}
    }
  }

  function buildThemeContext(theme) {
    return typeof themeLoader.createThemeContext === "function"
      ? themeLoader.createThemeContext(theme)
      : null;
  }

  function setActiveTheme(theme) {
    activeTheme = theme || null;
    activeThemeContext = activeTheme ? buildThemeContext(activeTheme) : null;
    return activeTheme;
  }

  function loadInitialTheme(themeId, opts = {}) {
    const theme = themeLoader.loadTheme(themeId, opts);
    theme._overrideSignature = JSON.stringify(opts.overrides || {});
    return setActiveTheme(theme);
  }

  function getActiveTheme() {
    return activeTheme;
  }

  function getActiveThemeContext() {
    return activeThemeContext;
  }

  function getActiveThemeId(fallback = "clawd") {
    return activeTheme ? activeTheme._id : fallback;
  }

  function getActiveThemeCapabilities() {
    return activeTheme ? activeTheme._capabilities : null;
  }

  function resolveHint(hookFilename) {
    if (!activeTheme || !activeTheme.displayHintMap) return null;
    return activeTheme.displayHintMap[hookFilename] || null;
  }

  function getAssetPath(filename) {
    if (activeThemeContext) return activeThemeContext.resolveAssetPath(filename);
    return null;
  }

  function getRendererAssetsPath() {
    return activeThemeContext ? activeThemeContext.getRendererAssetsPath() : "../assets/svg";
  }

  function getRendererSourceAssetsPath() {
    return activeThemeContext ? activeThemeContext.getRendererSourceAssetsPath() : null;
  }

  function getRendererConfig() {
    return activeThemeContext ? activeThemeContext.getRendererConfig() : null;
  }

  function getHitRendererConfig() {
    return activeThemeContext ? activeThemeContext.getHitRendererConfig() : null;
  }

  function getSoundUrl(soundName) {
    return activeThemeContext ? activeThemeContext.getSoundUrl(soundName) : null;
  }

  function getPreviewSoundUrl() {
    return activeThemeContext ? activeThemeContext.getPreviewSoundUrl() : null;
  }

  function activateTheme(themeId, variantId) {
    const renderWin = getRenderWindow();
    if (!isLiveWindow(renderWin)) {
      throw new Error("theme switch requires ready windows");
    }

    const activateOptions = arguments.length >= 4 ? arguments[3] : null;
    const currentVariantMap = settingsController.get("themeVariant") || {};
    const targetVariant = (typeof variantId === "string" && variantId)
      ? variantId
      : (currentVariantMap[themeId] || "default");
    const currentOverrides = settingsController.get("themeOverrides") || {};
    const targetOverrideMap = arguments.length >= 3 ? arguments[2] : (currentOverrides[themeId] || null);
    const targetOverrideSignature = JSON.stringify(targetOverrideMap || {});

    if (
      activeTheme &&
      activeTheme._id === themeId &&
      activeTheme._variantId === targetVariant &&
      (activeTheme._overrideSignature || "{}") === targetOverrideSignature &&
      !(activateOptions && activateOptions.forceReload === true)
    ) {
      return { themeId, variantId: activeTheme._variantId };
    }

    const newTheme = themeLoader.loadTheme(themeId, {
      strict: true,
      variant: targetVariant,
      overrides: targetOverrideMap,
    });
    newTheme._overrideSignature = targetOverrideSignature;

    const animationOverrides = getAnimationOverridesRuntime();
    // A reload re-applies whatever state is current once it finishes, so a
    // preview has to be handed back here, not just have its timer dropped —
    // otherwise the preview visual becomes the state the reload restores.
    if (animationOverrides && typeof animationOverrides.cancelAnimationPreview === "function") {
      animationOverrides.cancelAnimationPreview();
    } else if (animationOverrides && typeof animationOverrides.clearPreviewTimer === "function") {
      animationOverrides.clearPreviewTimer();
    }
    if (!activeTheme || activeTheme._id !== newTheme._id) {
      bumpAnimationOverridePreviewPosterGeneration();
    }

    const stateRuntime = getStateRuntime();
    const tickRuntime = getTickRuntime();
    const miniRuntime = getMiniRuntime();
    let preservedVirtualBounds = getPetWindowBounds();

    callMethod(stateRuntime, "cleanup");
    callMethod(tickRuntime, "cleanup");
    callMethod(miniRuntime, "cleanup");
    // Do not clear pending permission bubbles, sessions, or displayHint here;
    // those are runtime concepts that survive a theme asset reload.

    if (
      typeof miniRuntime.getMiniMode === "function" &&
      miniRuntime.getMiniMode() &&
      (!newTheme.miniMode || !newTheme.miniMode.supported)
    ) {
      preservedVirtualBounds = null;
      callMethod(miniRuntime, "exitMiniMode");
    }

    setActiveTheme(newTheme);
    invalidateDisplayedVisual("theme-activation");
    callMethod(miniRuntime, "refreshTheme");
    callMethod(stateRuntime, "refreshTheme");
    callMethod(tickRuntime, "refreshTheme");
    if (typeof miniRuntime.getMiniMode === "function" && miniRuntime.getMiniMode()) {
      callMethod(miniRuntime, "handleDisplayChange");
    }

    reloadInProgress = true;

    let reloadSettled = false;
    const finishThemeReload = () => {
      if (reloadSettled) return;
      reloadSettled = true;
      reloadInProgress = false;
      resolveReloadWaiters({ status: "settled" });
      if (
        preservedVirtualBounds &&
        !(typeof miniRuntime.getMiniTransitioning === "function" && miniRuntime.getMiniTransitioning()) &&
        isLiveWindow(getRenderWindow())
      ) {
        applyPetWindowBounds(preservedVirtualBounds);
        const clamped = computeFinalDragBounds(
          getPetWindowBounds(),
          { width: preservedVirtualBounds.width, height: preservedVirtualBounds.height },
          clampToScreenVisual
        );
        if (clamped) applyPetWindowBounds(clamped);
      }
      if (isLiveWindow(getHitWindow())) syncHitStateAfterLoad();
      if (isLiveWindow(getRenderWindow())) {
        syncRendererStateAfterLoad({ includeStartupRecovery: false });
        syncHitWin();
      }
      syncSessionHudVisibility();
      if (isLiveWindow(getRenderWindow())) startMainTick();
      if (animationOverrides && typeof animationOverrides.runPendingPostReloadTasks === "function") {
        animationOverrides.runPendingPostReloadTasks();
      }
    };

    const sequencer = getFadeSequencer();
    try {
      callMethod(sequencer, "run", {
        onReloadFinished: () => finishThemeReload(),
        onFallback: () => finishThemeReload(),
      });
    } catch (err) {
      // The sequencer can throw synchronously after the runtime has already
      // switched (windows not ready, animation setup failure). The theme is
      // active either way, so complete the no-fade fallback and report success
      // — returning an error here would leave prefs contradicting the runtime.
      console.warn("Clawd: theme fade sequencer failed; applying without fade:", err && err.message);
      finishThemeReload();
    }

    flushRuntimeStateToPrefs();
    return { themeId, variantId: newTheme._variantId };
  }

  function reloadActiveTheme() {
    if (!activeTheme) throw new Error("active theme is not loaded");
    const currentOverrides = settingsController.get("themeOverrides") || {};
    return activateTheme(
      activeTheme._id,
      activeTheme._variantId || "default",
      currentOverrides[activeTheme._id] || null,
      { forceReload: true }
    );
  }

  function refreshActiveThemeHitboxOverrides(themeId, overrideMap) {
    if (!activeTheme || activeTheme._id !== themeId) {
      throw new Error("hitbox refresh requires the requested theme to already be active");
    }

    const targetVariant = activeTheme._variantId || "default";
    const targetOverrideSignature = JSON.stringify(overrideMap || {});
    if ((activeTheme._overrideSignature || "{}") === targetOverrideSignature) {
      return { themeId, variantId: targetVariant };
    }

    const newTheme = themeLoader.loadTheme(themeId, {
      strict: true,
      variant: targetVariant,
      overrides: overrideMap,
    });
    newTheme._overrideSignature = targetOverrideSignature;
    setActiveTheme(newTheme);

    const stateRuntime = getStateRuntime();
    callMethod(stateRuntime, "refreshTheme");
    refreshDisplayedVisualHitBoxes();
    if (isLiveWindow(getHitWindow())) syncHitStateAfterLoad();
    if (isLiveWindow(getRenderWindow())) syncHitWin();
    flushRuntimeStateToPrefs();

    return { themeId, variantId: newTheme._variantId };
  }

  function getThemeInfo(themeId) {
    const all = themeLoader.discoverThemes();
    const entry = all.find((theme) => theme.id === themeId);
    if (!entry) return null;
    return {
      builtin: !!entry.builtin,
      active: activeTheme && activeTheme._id === themeId,
      managedCodexPet: isManagedTheme(themeId),
      managedOfficialTheme: typeof options.isOfficialManagedTheme === "function"
        ? options.isOfficialManagedTheme(themeId)
        : false,
    };
  }

  function removeThemeDir(themeId) {
    const userThemesDir = themeLoader.ensureUserThemesDir();
    if (!userThemesDir) throw new Error("user themes directory unavailable");
    const target = path.resolve(path.join(userThemesDir, themeId));
    const root = path.resolve(userThemesDir);
    if (!target.startsWith(root + path.sep)) {
      throw new Error(`theme path escapes user themes directory: ${themeId}`);
    }
    fs.rmSync(target, { recursive: true, force: true });
    try { rebuildAllMenus(); } catch {}
  }

  function isReloadInProgress() {
    return reloadInProgress;
  }

  function cleanup() {
    reloadInProgress = false;
    resolveReloadWaiters({ status: "cleanup" });
    const sequencer = getFadeSequencer();
    if (sequencer && typeof sequencer.cleanup === "function") sequencer.cleanup();
  }

  return {
    loadInitialTheme,
    activateTheme,
    reloadActiveTheme,
    refreshActiveThemeHitboxOverrides,
    getActiveTheme,
    getActiveThemeContext,
    getActiveThemeId,
    getActiveThemeCapabilities,
    resolveHint,
    getAssetPath,
    getRendererAssetsPath,
    getRendererSourceAssetsPath,
    getRendererConfig,
    getHitRendererConfig,
    getSoundUrl,
    getPreviewSoundUrl,
    getThemeInfo,
    removeThemeDir,
    isReloadInProgress,
    waitForThemeReloadSettled,
    cleanup,
  };
}

module.exports = createThemeRuntime;
