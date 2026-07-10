"use strict";

const defaultFs = require("fs");
const defaultPath = require("path");
const { pathToFileURL: defaultPathToFileURL } = require("url");

function createThemeContext(theme, options = {}) {
  const fs = options.fs || defaultFs;
  const path = options.path || defaultPath;
  const pathToFileURL = options.pathToFileURL || defaultPathToFileURL;
  const assetsSvgDir = options.assetsSvgDir || null;
  const assetsSoundsDir = options.assetsSoundsDir || null;

  function buildFileUrl(absPath) {
    return pathToFileURL(absPath).href;
  }

  function getExternalAssetsSourceDir(themeDir) {
    return path.join(themeDir, "assets");
  }

  function resolveAssetPath(filename) {
    const safeFilename = path.basename(filename);
    if (!theme) return path.join(assetsSvgDir, safeFilename);

    if (theme._builtin) {
      const themeAsset = path.join(theme._themeDir, "assets", safeFilename);
      if (fs.existsSync(themeAsset)) return themeAsset;
      return path.join(assetsSvgDir, safeFilename);
    }

    if (safeFilename.endsWith(".svg")) {
      return path.join(theme._assetsDir || getExternalAssetsSourceDir(theme._themeDir), safeFilename);
    }
    return path.join(theme._themeDir, "assets", safeFilename);
  }

  function getRendererAssetsPath() {
    if (!theme) return "../assets/svg";
    if (theme._builtin) {
      const themeAssetsDir = path.join(theme._themeDir, "assets");
      if (fs.existsSync(themeAssetsDir)) {
        return `../themes/${theme._id}/assets`;
      }
      return "../assets/svg";
    }
    return theme._assetsFileUrl || "../assets/svg";
  }

  function getRendererSourceAssetsPath() {
    if (!theme) return null;
    if (theme._builtin) {
      const themeAssetsDir = path.join(theme._themeDir, "assets");
      if (fs.existsSync(themeAssetsDir)) {
        return `../themes/${theme._id}/assets`;
      }
      return null;
    }
    return buildFileUrl(path.join(theme._themeDir, "assets"));
  }

  function getRendererConfig() {
    if (!theme) return null;
    const trustedScriptedSvgFiles = theme._builtin && theme.trustedRuntime
      ? (theme.trustedRuntime.scriptedSvgFiles || [])
      : [];
    return {
      viewBox: theme.viewBox,
      miniModeViewBox: theme.miniMode ? theme.miniMode.viewBox : null,
      fileViewBoxes: { ...(theme.fileViewBoxes || {}) },
      layout: theme.layout,
      assetsPath: getRendererAssetsPath(),
      sourceAssetsPath: getRendererSourceAssetsPath(),
      eyeTracking: theme.eyeTracking,
      glyphFlips: theme.miniMode ? theme.miniMode.glyphFlips : {},
      miniFlipAssets: theme.miniMode ? !!theme.miniMode.flipAssets : false,
      roamFlipAssets: !!theme.roamFlipAssets,
      dragSvg: theme.reactions && theme.reactions.drag ? theme.reactions.drag.file : null,
      dragSvgs: theme.reactions && theme.reactions.drag ? {
        left: theme.reactions.drag.fileLeft || null,
        right: theme.reactions.drag.fileRight || null,
      } : null,
      idleFollowSvg: theme.states.idle[0],
      // Free roam: true when the theme binds a dedicated roam visual. The
      // visual resolver injects exactly states.roam = [idle[0]] as a synthetic
      // fallback, so only that precise shape (single entry, same file as
      // idle[0]) means "no dedicated visual" — the renderer then keeps its
      // roam-walk bob compensation. Multi-entry bindings count as dedicated
      // even if one entry reuses the idle file.
      hasRoamVisual: !!(theme.states && Array.isArray(theme.states.roam)
        && theme.states.roam.length > 0
        && !(theme.states.roam.length === 1 && theme.states.roam[0] === theme.states.idle[0])),
      eyeTrackingStates: theme.eyeTracking.enabled ? theme.eyeTracking.states : [],
      trustedScriptedSvgFiles: [...trustedScriptedSvgFiles],
      rendering: theme.rendering || { svgChannel: "auto" },
      objectScale: theme.objectScale,
      transitions: theme.transitions || {},
    };
  }

  function getHitRendererConfig() {
    if (!theme) return null;
    return {
      reactions: theme.reactions || {},
      idleFollowSvg: theme.states.idle[0],
    };
  }

  function getSoundUrl(soundName) {
    if (!theme || !theme.sounds) return null;

    const overrideMap = theme._soundOverrideFiles;
    if (overrideMap && Object.prototype.hasOwnProperty.call(overrideMap, soundName)) {
      const overridePath = overrideMap[soundName];
      if (overridePath && fs.existsSync(overridePath)) {
        return buildFileUrl(overridePath);
      }
    }

    const filename = theme.sounds[soundName];
    if (!filename) return null;

    const absPath = theme._builtin
      ? path.join(assetsSoundsDir, filename)
      : path.join(theme._themeDir, "sounds", filename);

    if (fs.existsSync(absPath)) return buildFileUrl(absPath);

    if (!theme._builtin) {
      const fallback = path.join(assetsSoundsDir, filename);
      if (fs.existsSync(fallback)) return buildFileUrl(fallback);
    }

    return null;
  }

  function getPreviewSoundUrl() {
    return getSoundUrl("confirm") || getSoundUrl("complete") || null;
  }

  return {
    theme,
    resolveAssetPath,
    getRendererAssetsPath,
    getRendererSourceAssetsPath,
    getRendererConfig,
    getHitRendererConfig,
    getSoundUrl,
    getPreviewSoundUrl,
  };
}

module.exports = createThemeContext;
