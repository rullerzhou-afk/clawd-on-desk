"use strict";

const defaultFs = require("fs");
const defaultPath = require("path");
const { pathToFileURL } = require("url");
const defaultAnimationCycle = require("./animation-cycle");
const { ANIMATION_OVERRIDES_EXPORT_VERSION } = require("./settings-actions");

const ANIMATION_OVERRIDE_ASSET_EXTS = new Set([".svg", ".gif", ".apng", ".png", ".webp", ".jpg", ".jpeg"]);
const ANIMATION_OVERRIDE_PREVIEW_POSTER_SIZE = { width: 176, height: 144 };
const ANIMATION_OVERRIDE_PREVIEW_POSTER_VERSION = 2;
const ANIMATION_OVERRIDE_PREVIEW_POSTER_CACHE_MAX = 192;
const ANIMATION_OVERRIDE_PREVIEW_POSTER_TIMEOUT_MS = 30000;
const ASPECT_RATIO_WARN_THRESHOLD = 0.15;
const PREVIEW_HOLD_MIN_MS = 800;
const PREVIEW_HOLD_MAX_MS = 3500;
const TRUSTED_SCRIPTED_PREVIEW_HOLD_MAX_MS = 15000;

const REACTION_ORDER = [
  { key: "drag", triggerKind: "dragReaction", supportsDuration: false },
  { key: "clickLeft", triggerKind: "clickLeftReaction", supportsDuration: true },
  { key: "clickRight", triggerKind: "clickRightReaction", supportsDuration: true },
  { key: "annoyed", triggerKind: "annoyedReaction", supportsDuration: true },
  { key: "double", triggerKind: "doubleReaction", supportsDuration: true },
];

const ANIMATION_OVERRIDES_EXPORT_DIALOG_STRINGS = {
  en: {
    saveTitle: "Export Animation Overrides",
    openTitle: "Import Animation Overrides",
    defaultName: (ts) => `clawd-animation-overrides-${ts}.json`,
    jsonFilter: "Clawd Animation Overrides",
    nothingToExport: "No animation overrides to export. Override something first.",
  },
  zh: {
    saveTitle: "导出动画覆盖",
    openTitle: "导入动画覆盖",
    defaultName: (ts) => `clawd-animation-overrides-${ts}.json`,
    jsonFilter: "Clawd 动画覆盖",
    nothingToExport: "没有可导出的动画覆盖。先自定义几个动画试试。",
  },
  "zh-TW": {
    saveTitle: "匯出動畫與音效自訂設定",
    openTitle: "匯入動畫與音效自訂設定",
    defaultName: (ts) => `clawd-animation-overrides-${ts}.json`,
    jsonFilter: "Clawd 動畫與音效自訂設定",
    nothingToExport: "目前沒有可匯出的自訂設定。",
  },
  ko: {
    saveTitle: "애니메이션 덮어쓰기 내보내기",
    openTitle: "애니메이션 덮어쓰기 가져오기",
    defaultName: (ts) => `clawd-animation-overrides-${ts}.json`,
    jsonFilter: "Clawd 애니메이션 덮어쓰기",
    nothingToExport: "내보낼 애니메이션 덮어쓰기가 없습니다. 먼저 무언가를 덮어써 보세요.",
  },
  ja: {
    saveTitle: "アニメーション差し替えをエクスポート",
    openTitle: "アニメーション差し替えをインポート",
    defaultName: (ts) => `clawd-animation-overrides-${ts}.json`,
    jsonFilter: "Clawd アニメーション差し替え",
    nothingToExport: "エクスポートするアニメーション差し替えがありません。先に何かを差し替えてください。",
  },
};

function requiredDependency(value, name, owner) {
  if (!value) throw new Error(`${owner} requires ${name}`);
  return value;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function buildFileUrl(absPath) {
  try { return pathToFileURL(absPath).href; }
  catch { return null; }
}

function isTrustedScriptedAnimationFile(filename, theme, path = defaultPath) {
  if (!filename || !theme || !theme._builtin || !theme.trustedRuntime) return false;
  const scriptedFiles = Array.isArray(theme.trustedRuntime.scriptedSvgFiles)
    ? theme.trustedRuntime.scriptedSvgFiles
    : [];
  const base = path.basename(filename);
  return scriptedFiles.includes(base);
}

function isObjectChannelSvgAnimationFile(filename, theme, path = defaultPath) {
  return !!(
    filename
    && theme
    && theme.rendering
    && theme.rendering.svgChannel === "object"
    && path.extname(filename).toLowerCase() === ".svg"
  );
}

function needsScriptedAnimationPreviewPoster(filename, theme, path = defaultPath) {
  return isTrustedScriptedAnimationFile(filename, theme, path)
    || isObjectChannelSvgAnimationFile(filename, theme, path);
}

function getTrustedScriptedAnimationCycleMs(filename, theme, path = defaultPath) {
  if (!isTrustedScriptedAnimationFile(filename, theme, path)) return null;
  const cycleMap = theme && theme.trustedRuntime && theme.trustedRuntime.scriptedSvgCycleMs;
  const ms = cycleMap && cycleMap[path.basename(filename)];
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function buildAnimationPreviewPosterDescriptor(filename, theme, absPath, { fs = defaultFs, path = defaultPath } = {}) {
  if (!filename || !theme || !absPath) return null;
  try {
    const stat = fs.statSync(absPath);
    const themeId = theme && theme._id ? theme._id : "theme";
    const safeFilename = path.basename(filename);
    return {
      themeId,
      filename: safeFilename,
      absPath,
      fileUrl: buildFileUrl(absPath),
      posterVersion: ANIMATION_OVERRIDE_PREVIEW_POSTER_VERSION,
      size: stat.size,
      mtime: Math.round(stat.mtimeMs),
      cacheKey: `${ANIMATION_OVERRIDE_PREVIEW_POSTER_VERSION}|${themeId}|${safeFilename}|${stat.size}|${Math.round(stat.mtimeMs)}`,
    };
  } catch {
    return null;
  }
}

function registerSettingsAnimationOverridesIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain", "registerSettingsAnimationOverridesIpc");
  const animationOverridesMain = requiredDependency(
    options.animationOverridesMain,
    "animationOverridesMain",
    "registerSettingsAnimationOverridesIpc"
  );
  const disposers = [];

  function handle(channel, listener) {
    ipcMain.handle(channel, listener);
    disposers.push(() => ipcMain.removeHandler(channel));
  }

  handle("settings:get-animation-overrides-data", () => animationOverridesMain.buildAnimationOverrideData());
  handle("settings:open-theme-assets-dir", () => animationOverridesMain.openThemeAssetsDir());
  handle("settings:preview-animation-override", (_event, payload) =>
    animationOverridesMain.previewAnimationOverride(payload)
  );
  handle("settings:preview-reaction", (_event, payload) =>
    animationOverridesMain.previewReaction(payload)
  );
  handle("settings:export-animation-overrides", (event) =>
    animationOverridesMain.exportAnimationOverrides(event)
  );
  handle("settings:import-animation-overrides", (event) =>
    animationOverridesMain.importAnimationOverrides(event)
  );

  return {
    dispose() {
      while (disposers.length) {
        const dispose = disposers.pop();
        try { dispose(); } catch {}
      }
    },
  };
}

function createSettingsAnimationOverridesMain(options = {}) {
  const BrowserWindow = requiredDependency(options.BrowserWindow, "BrowserWindow", "createSettingsAnimationOverridesMain");
  const app = requiredDependency(options.app, "app", "createSettingsAnimationOverridesMain");
  const dialog = requiredDependency(options.dialog, "dialog", "createSettingsAnimationOverridesMain");
  const shell = requiredDependency(options.shell, "shell", "createSettingsAnimationOverridesMain");
  const themeLoader = requiredDependency(options.themeLoader, "themeLoader", "createSettingsAnimationOverridesMain");
  const settingsController = requiredDependency(
    options.settingsController,
    "settingsController",
    "createSettingsAnimationOverridesMain"
  );
  const fs = options.fs || defaultFs;
  const path = options.path || defaultPath;
  const animationCycle = options.animationCycle || defaultAnimationCycle;
  const getActiveTheme = options.getActiveTheme || (() => null);
  const getSettingsWindow = options.getSettingsWindow || (() => null);
  const getLang = options.getLang || (() => "en");
  const getThemeReloadInProgress = options.getThemeReloadInProgress || (() => false);
  const getStateRuntime = options.getStateRuntime || (() => options.stateRuntime || null);
  const sendToRenderer = options.sendToRenderer || (() => {});

  let animationOverridePreviewTimer = null;
  let animationOverridePreviewPosterWindow = null;
  let animationOverridePreviewPosterReady = null;
  let animationOverridePreviewPosterQueue = Promise.resolve();
  const animationOverridePreviewPosterCache = new Map();
  const animationOverridePreviewPosterPendingKeys = new Set();
  let animationOverridePreviewPosterGenerationId = 0;
  let pendingPostReloadTasks = [];

  function clearPreviewTimer() {
    if (animationOverridePreviewTimer) {
      clearTimeout(animationOverridePreviewTimer);
      animationOverridePreviewTimer = null;
    }
  }

  function runPendingPostReloadTasks() {
    const tasks = pendingPostReloadTasks;
    pendingPostReloadTasks = [];
    for (const task of tasks) {
      try { task(); } catch (err) { console.warn("Clawd: post-reload task threw:", err && err.message); }
    }
  }

  function resolveAnimationAssetAbsPath(filename, theme = getActiveTheme()) {
    if (!filename || !theme) return null;
    try {
      const absPath = typeof themeLoader._resolveAssetPath === "function"
        ? themeLoader._resolveAssetPath(theme, filename)
        : themeLoader.getAssetPath(filename);
      return absPath && fs.existsSync(absPath) ? absPath : null;
    } catch {
      return null;
    }
  }

  function readSvgAspectRatio(absPath) {
    try {
      const text = fs.readFileSync(absPath, "utf8");
      const headMatch = text.match(/<svg\b[^>]*>/i);
      if (!headMatch) return null;
      const head = headMatch[0];
      const vbMatch = head.match(/\sviewBox\s*=\s*["']([-\d.\s]+)["']/i);
      if (vbMatch) {
        const parts = vbMatch[1].trim().split(/\s+/).map(Number);
        if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
          return parts[2] / parts[3];
        }
      }
      const wMatch = head.match(/\swidth\s*=\s*["']([\d.]+)/i);
      const hMatch = head.match(/\sheight\s*=\s*["']([\d.]+)/i);
      if (wMatch && hMatch) {
        const w = parseFloat(wMatch[1]);
        const h = parseFloat(hMatch[1]);
        if (w > 0 && h > 0) return w / h;
      }
    } catch {}
    return null;
  }

  function computeAspectRatioWarning(baseFile, currentFile) {
    if (!baseFile || !currentFile) return null;
    if (baseFile === currentFile) return null;
    const lowerBase = baseFile.toLowerCase();
    const lowerCurrent = currentFile.toLowerCase();
    if (!lowerBase.endsWith(".svg") || !lowerCurrent.endsWith(".svg")) return null;
    const basePath = resolveAnimationAssetAbsPath(baseFile);
    const currentPath = resolveAnimationAssetAbsPath(currentFile);
    if (!basePath || !currentPath) return null;
    const baseAspect = readSvgAspectRatio(basePath);
    const currentAspect = readSvgAspectRatio(currentPath);
    if (baseAspect == null || currentAspect == null) return null;
    const diffRatio = Math.abs(baseAspect - currentAspect) / baseAspect;
    if (diffRatio < ASPECT_RATIO_WARN_THRESHOLD) return null;
    return { baseAspect, currentAspect, diffRatio };
  }

  function computeCardHitboxInfo(currentFile, themeOverrideMap) {
    const activeTheme = getActiveTheme();
    if (!currentFile || !activeTheme) {
      return { wideHitboxEnabled: false, wideHitboxOverridden: false, wideHitboxThemeDefault: false };
    }
    const wideFiles = Array.isArray(activeTheme.wideHitboxFiles) ? activeTheme.wideHitboxFiles : [];
    const baseWideFiles = Array.isArray(activeTheme._baseWideHitboxFiles)
      ? activeTheme._baseWideHitboxFiles
      : wideFiles;
    const wideHitboxEnabled = wideFiles.includes(currentFile);
    const wideHitboxThemeDefault = baseWideFiles.includes(currentFile);
    const overrideWide = themeOverrideMap && themeOverrideMap.hitbox && themeOverrideMap.hitbox.wide;
    const wideHitboxOverridden = !!(overrideWide
      && Object.prototype.hasOwnProperty.call(overrideWide, currentFile));
    return { wideHitboxEnabled, wideHitboxOverridden, wideHitboxThemeDefault };
  }

  function resolveAnimationAssetsDir(theme = getActiveTheme()) {
    if (!theme) return null;
    const themeAssetsDir = theme._themeDir ? path.join(theme._themeDir, "assets") : null;
    if (themeAssetsDir && fs.existsSync(themeAssetsDir)) return themeAssetsDir;
    const idleFile = theme.states && theme.states.idle && theme.states.idle[0];
    if (!idleFile) return null;
    const resolved = themeLoader.getAssetPath(idleFile);
    return resolved ? path.dirname(resolved) : null;
  }

  function resolveOpenableFsPath(absPath) {
    if (!absPath || !app.isPackaged) return absPath;
    const asarSegment = `${path.sep}app.asar${path.sep}`;
    if (!absPath.includes(asarSegment)) return absPath;
    const unpackedPath = absPath.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`);
    return fs.existsSync(unpackedPath) ? unpackedPath : absPath;
  }

  function rememberAnimationPreviewPosterCache(cacheKey, dataUrl) {
    if (!cacheKey || !dataUrl) return;
    if (animationOverridePreviewPosterCache.has(cacheKey)) {
      animationOverridePreviewPosterCache.delete(cacheKey);
    }
    animationOverridePreviewPosterCache.set(cacheKey, dataUrl);
    while (animationOverridePreviewPosterCache.size > ANIMATION_OVERRIDE_PREVIEW_POSTER_CACHE_MAX) {
      const oldestKey = animationOverridePreviewPosterCache.keys().next().value;
      if (!oldestKey) break;
      animationOverridePreviewPosterCache.delete(oldestKey);
    }
  }

  function readAnimationPreviewPosterCache(cacheKey) {
    if (!cacheKey || !animationOverridePreviewPosterCache.has(cacheKey)) return null;
    const dataUrl = animationOverridePreviewPosterCache.get(cacheKey);
    animationOverridePreviewPosterCache.delete(cacheKey);
    animationOverridePreviewPosterCache.set(cacheKey, dataUrl);
    return dataUrl;
  }

  function buildAnimationAssetPreview(filename, theme = getActiveTheme(), resolvedAbsPath = null) {
    const absPath = resolvedAbsPath || resolveAnimationAssetAbsPath(filename, theme);
    const fileUrl = absPath ? buildFileUrl(absPath) : null;
    const needsPoster = needsScriptedAnimationPreviewPoster(filename, theme, path);
    if (!needsPoster) {
      return {
        fileUrl,
        previewImageUrl: fileUrl,
        needsScriptedPreviewPoster: false,
        previewPosterCacheKey: null,
        previewPosterPending: false,
      };
    }

    const descriptor = buildAnimationPreviewPosterDescriptor(filename, theme, absPath, { fs, path });
    const cachedPoster = descriptor ? readAnimationPreviewPosterCache(descriptor.cacheKey) : null;
    return {
      fileUrl,
      previewImageUrl: cachedPoster,
      needsScriptedPreviewPoster: true,
      previewPosterCacheKey: descriptor ? descriptor.cacheKey : null,
      previewPosterPending: !!(descriptor && !cachedPoster),
    };
  }

  function animationPreviewDelay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getAnimationPreviewPosterWindow() {
    if (animationOverridePreviewPosterWindow && !animationOverridePreviewPosterWindow.isDestroyed()) {
      return animationOverridePreviewPosterWindow;
    }
    animationOverridePreviewPosterReady = null;
    animationOverridePreviewPosterWindow = new BrowserWindow({
      width: ANIMATION_OVERRIDE_PREVIEW_POSTER_SIZE.width,
      height: ANIMATION_OVERRIDE_PREVIEW_POSTER_SIZE.height,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      webPreferences: {
        offscreen: true,
        backgroundThrottling: false,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    animationOverridePreviewPosterWindow.on("closed", () => {
      animationOverridePreviewPosterWindow = null;
      animationOverridePreviewPosterReady = null;
    });
    return animationOverridePreviewPosterWindow;
  }

  async function ensureAnimationPreviewPosterPage() {
    const posterWindow = getAnimationPreviewPosterWindow();
    if (!animationOverridePreviewPosterReady) {
      animationOverridePreviewPosterReady = posterWindow.loadFile(path.join(__dirname, "settings-animation-preview.html"))
        .catch((err) => {
          animationOverridePreviewPosterReady = null;
          throw err;
        });
    }
    await animationOverridePreviewPosterReady;
    return posterWindow;
  }

  function withAnimationPreviewPosterTimeout(promise) {
    let timer = null;
    return new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const err = new Error("animation preview poster capture timed out");
        err.code = "ANIMATION_PREVIEW_POSTER_TIMEOUT";
        reject(err);
      }, ANIMATION_OVERRIDE_PREVIEW_POSTER_TIMEOUT_MS);
      Promise.resolve(promise).then(resolve, reject);
    }).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  function destroyAnimationPreviewPosterWindow() {
    if (animationOverridePreviewPosterWindow && !animationOverridePreviewPosterWindow.isDestroyed()) {
      animationOverridePreviewPosterWindow.destroy();
    }
    animationOverridePreviewPosterWindow = null;
    animationOverridePreviewPosterReady = null;
  }

  async function captureAnimationPreviewPosterDataUrl(fileUrl) {
    if (!fileUrl) return null;
    const capture = async () => {
      const posterWindow = await ensureAnimationPreviewPosterPage();
      if (!posterWindow || posterWindow.isDestroyed()) return null;
      const webContents = posterWindow.webContents;
      if (!webContents || webContents.isDestroyed()) return null;
      await webContents.executeJavaScript(`window.renderAnimationPreviewPoster(${JSON.stringify(fileUrl)})`, true);
      await animationPreviewDelay(20);
      const image = await webContents.capturePage({
        x: 0,
        y: 0,
        width: ANIMATION_OVERRIDE_PREVIEW_POSTER_SIZE.width,
        height: ANIMATION_OVERRIDE_PREVIEW_POSTER_SIZE.height,
      });
      return image && typeof image.toDataURL === "function" ? image.toDataURL() : null;
    };

    try {
      return await withAnimationPreviewPosterTimeout(capture());
    } catch (err) {
      if (err && err.code === "ANIMATION_PREVIEW_POSTER_TIMEOUT") {
        destroyAnimationPreviewPosterWindow();
      }
      throw err;
    }
  }

  function getLiveSettingsWebContents() {
    const settingsWindow = getSettingsWindow();
    if (
      !settingsWindow
      || settingsWindow.isDestroyed()
      || !settingsWindow.webContents
      || settingsWindow.webContents.isDestroyed()
    ) {
      return null;
    }
    return settingsWindow.webContents;
  }

  function bumpPreviewPosterGeneration() {
    animationOverridePreviewPosterGenerationId += 1;
    return animationOverridePreviewPosterGenerationId;
  }

  function maybeDestroyIdlePreviewPosterWindow() {
    if (animationOverridePreviewPosterPendingKeys.size > 0) return;
    if (getLiveSettingsWebContents()) return;
    destroyAnimationPreviewPosterWindow();
  }

  function sendAnimationPreviewPosterReady(job, previewImageUrl) {
    if (!job || !previewImageUrl) return;
    const webContents = getLiveSettingsWebContents();
    if (!webContents) return;
    webContents.send("settings:animation-preview-poster-ready", {
      themeId: job.themeId,
      filename: job.filename,
      previewImageUrl,
      previewPosterCacheKey: job.previewPosterCacheKey,
    });
  }

  async function runAnimationPreviewPosterJob(job) {
    try {
      if (!job || !job.previewPosterCacheKey || !job.fileUrl) return;
      if (job.generationId !== animationOverridePreviewPosterGenerationId) return;
      if (!getLiveSettingsWebContents()) return;

      const cached = readAnimationPreviewPosterCache(job.previewPosterCacheKey);
      if (cached) {
        sendAnimationPreviewPosterReady(job, cached);
        return;
      }

      const previewImageUrl = await captureAnimationPreviewPosterDataUrl(job.fileUrl);
      if (!previewImageUrl) return;
      rememberAnimationPreviewPosterCache(job.previewPosterCacheKey, previewImageUrl);
      sendAnimationPreviewPosterReady(job, previewImageUrl);
    } catch (err) {
      const message = err && err.message;
      if (err && err.code === "ANIMATION_PREVIEW_POSTER_TIMEOUT") {
        console.warn("Clawd: animation preview poster capture timed out:", message);
      } else {
        console.warn("Clawd: failed to capture animation preview poster:", message);
      }
    } finally {
      if (job && job.previewPosterCacheKey) {
        animationOverridePreviewPosterPendingKeys.delete(job.previewPosterCacheKey);
      }
      maybeDestroyIdlePreviewPosterWindow();
    }
  }

  function enqueueAnimationPreviewPosterJob(job) {
    if (!job || !job.previewPosterCacheKey || !job.fileUrl) return;
    if (animationOverridePreviewPosterCache.has(job.previewPosterCacheKey)) return;
    if (animationOverridePreviewPosterPendingKeys.has(job.previewPosterCacheKey)) return;
    animationOverridePreviewPosterPendingKeys.add(job.previewPosterCacheKey);
    const run = () => runAnimationPreviewPosterJob(job);
    animationOverridePreviewPosterQueue = animationOverridePreviewPosterQueue.then(run, run);
  }

  function scheduleAnimationPreviewPosters(data) {
    const webContents = getLiveSettingsWebContents();
    if (!webContents || !data || !data.theme || !data.theme.id) return;
    const themeId = data.theme.id;
    const generationId = animationOverridePreviewPosterGenerationId;
    const enqueue = (filename, fileUrl, previewPosterCacheKey, previewPosterPending) => {
      if (previewPosterPending !== true) return;
      if (!filename || !fileUrl || !previewPosterCacheKey) return;
      enqueueAnimationPreviewPosterJob({
        themeId,
        filename: path.basename(filename),
        fileUrl,
        previewPosterCacheKey,
        generationId,
      });
    };
    for (const asset of data.assets || []) {
      enqueue(asset && asset.name, asset && asset.fileUrl, asset && asset.previewPosterCacheKey, asset && asset.previewPosterPending);
    }
    for (const card of data.cards || []) {
      enqueue(
        card && card.currentFile,
        card && card.currentFileUrl,
        card && card.currentFilePreviewPosterCacheKey,
        card && card.previewPosterPending
      );
    }
  }

  function buildAnimationAssetProbe(file, theme = getActiveTheme(), resolvedAbsPath = null) {
    const trustedCycleMs = getTrustedScriptedAnimationCycleMs(file, theme, path);
    if (trustedCycleMs != null) {
      return {
        assetCycleMs: trustedCycleMs,
        assetCycleStatus: "exact",
        assetCycleSource: "trusted-runtime",
      };
    }
    const absPath = resolvedAbsPath || resolveAnimationAssetAbsPath(file, theme);
    if (!absPath) {
      return {
        assetCycleMs: null,
        assetCycleStatus: "unavailable",
        assetCycleSource: null,
      };
    }
    const probe = animationCycle.probeAssetCycle(absPath);
    return {
      assetCycleMs: Number.isFinite(probe && probe.ms) && probe.ms > 0 ? probe.ms : null,
      assetCycleStatus: (probe && probe.status) || "unavailable",
      assetCycleSource: (probe && probe.source) || null,
    };
  }

  function readCurrentThemeOverrideMap() {
    const activeTheme = getActiveTheme();
    const themeId = activeTheme && activeTheme._id;
    if (!themeId || !settingsController || typeof settingsController.getSnapshot !== "function") return null;
    const snapshot = settingsController.getSnapshot();
    return snapshot && snapshot.themeOverrides ? snapshot.themeOverrides[themeId] || null : null;
  }

  function hasExplicitAutoReturnOverride(themeOverrideMap, stateKey) {
    const autoReturn = themeOverrideMap && themeOverrideMap.timings && themeOverrideMap.timings.autoReturn;
    return !!(autoReturn && Object.prototype.hasOwnProperty.call(autoReturn, stateKey));
  }

  function buildTimingHint(file, fallbackMs = null) {
    const assetProbe = buildAnimationAssetProbe(file);
    const suggestedDurationMs = assetProbe.assetCycleMs != null
      ? assetProbe.assetCycleMs
      : (Number.isFinite(fallbackMs) && fallbackMs > 0 ? fallbackMs : null);
    const suggestedDurationStatus = assetProbe.assetCycleMs != null
      ? assetProbe.assetCycleStatus
      : (suggestedDurationMs != null ? "fallback" : "unavailable");
    return {
      ...assetProbe,
      suggestedDurationMs,
      suggestedDurationStatus,
      previewDurationMs: suggestedDurationMs,
    };
  }

  function listAnimationOverrideAssets(theme = getActiveTheme()) {
    if (!theme) return [];
    const dirs = [];
    const primaryDir = resolveAnimationAssetsDir(theme);
    const sourceDir = theme._themeDir ? path.join(theme._themeDir, "assets") : null;
    for (const dir of [primaryDir, sourceDir]) {
      if (!dir || !fs.existsSync(dir)) continue;
      if (!dirs.includes(dir)) dirs.push(dir);
    }
    const seen = new Set();
    const assets = [];
    for (const dir of dirs) {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!ANIMATION_OVERRIDE_ASSET_EXTS.has(ext)) continue;
        if (seen.has(entry.name)) continue;
        const absPath = resolveAnimationAssetAbsPath(entry.name, theme) || path.join(dir, entry.name);
        const preview = buildAnimationAssetPreview(entry.name, theme, absPath);
        const probe = buildAnimationAssetProbe(entry.name, theme, absPath);
        assets.push({
          name: entry.name,
          fileUrl: preview.fileUrl,
          previewImageUrl: preview.previewImageUrl,
          needsScriptedPreviewPoster: preview.needsScriptedPreviewPoster,
          previewPosterCacheKey: preview.previewPosterCacheKey,
          previewPosterPending: preview.previewPosterPending,
          ext,
          cycleMs: Number.isFinite(probe && probe.assetCycleMs) && probe.assetCycleMs > 0 ? probe.assetCycleMs : null,
          cycleStatus: (probe && probe.assetCycleStatus) || "unavailable",
          cycleSource: (probe && probe.assetCycleSource) || null,
        });
        seen.add(entry.name);
      }
    }
    assets.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    return assets;
  }

  function readTransitionFromMap(file, map) {
    const entry = map && map[file];
    return {
      in: entry && Number.isFinite(entry.in) ? entry.in : 150,
      out: entry && Number.isFinite(entry.out) ? entry.out : 150,
    };
  }

  function readResolvedTransition(file) {
    const activeTheme = getActiveTheme();
    return readTransitionFromMap(file, activeTheme && activeTheme.transitions);
  }

  function readThemeDefaultTransition(file) {
    const activeTheme = getActiveTheme();
    return readTransitionFromMap(file, activeTheme && activeTheme._baseTransitions);
  }

  function hasTransitionOverride(entry) {
    return !!(entry && Object.prototype.hasOwnProperty.call(entry, "transition"));
  }

  function hasOwnStateFiles(stateKey) {
    const activeTheme = getActiveTheme();
    if (!activeTheme) return false;
    const binding = activeTheme._stateBindings && activeTheme._stateBindings[stateKey];
    if (binding && Array.isArray(binding.files) && binding.files[0]) return true;
    if (activeTheme.states && Array.isArray(activeTheme.states[stateKey]) && activeTheme.states[stateKey][0]) return true;
    if (activeTheme.miniMode && activeTheme.miniMode.states
        && Array.isArray(activeTheme.miniMode.states[stateKey]) && activeTheme.miniMode.states[stateKey][0]) {
      return true;
    }
    return false;
  }

  function buildTierCardGroup(
    tierGroup,
    triggerKind,
    resolvedTiers,
    baseTiers,
    baseHintMap,
    sectionId = "work",
    themeOverrideMap = null
  ) {
    if (!Array.isArray(resolvedTiers)) return [];
    return resolvedTiers.map((tier, index) => {
      const baseTier = Array.isArray(baseTiers) ? baseTiers[index] : null;
      const originalFile = (baseTier && baseTier.originalFile) || tier.file;
      const higherTier = index === 0 ? null : resolvedTiers[index - 1];
      const maxSessions = higherTier ? Math.max(tier.minSessions, higherTier.minSessions - 1) : null;
      const hintTarget = baseHintMap && baseHintMap[originalFile];
      const timingHint = buildTimingHint(tier.file);
      const preview = buildAnimationAssetPreview(tier.file);
      return {
        id: `${tierGroup}:${originalFile}`,
        slotType: "tier",
        sectionId,
        tierGroup,
        triggerKind,
        originalFile,
        baseFile: originalFile,
        minSessions: tier.minSessions,
        maxSessions,
        currentFile: tier.file,
        currentFileUrl: preview.fileUrl,
        currentFilePreviewUrl: preview.previewImageUrl,
        needsScriptedPreviewPoster: preview.needsScriptedPreviewPoster,
        currentFilePreviewPosterCacheKey: preview.previewPosterCacheKey,
        previewPosterPending: preview.previewPosterPending,
        bindingLabel: `${tierGroup}[${originalFile}]`,
        transition: readResolvedTransition(tier.file),
        transitionThemeDefault: readThemeDefaultTransition(tier.file),
        hasTransitionOverride: hasTransitionOverride(
          themeOverrideMap
          && themeOverrideMap.tiers
          && themeOverrideMap.tiers[tierGroup]
          && themeOverrideMap.tiers[tierGroup][originalFile]
        ),
        supportsAutoReturn: false,
        supportsDuration: false,
        autoReturnMs: null,
        durationMs: null,
        hasAutoReturnOverride: false,
        ...timingHint,
        displayHintWarning: !!(hintTarget && hintTarget !== originalFile),
        displayHintTarget: hintTarget || null,
      };
    });
  }

  function getResolvedStateCardBinding(stateKey) {
    const activeTheme = getActiveTheme();
    if (!activeTheme) return null;
    const bindingMap = activeTheme._stateBindings || {};
    let cursor = stateKey;
    let hops = 0;
    const visited = new Set([stateKey]);

    while (cursor && hops <= 3) {
      const binding = bindingMap[cursor] || {};
      const files = Array.isArray(binding.files)
        ? binding.files
        : (
          activeTheme.states && Array.isArray(activeTheme.states[cursor]) ? activeTheme.states[cursor]
            : (
              activeTheme.miniMode && activeTheme.miniMode.states && Array.isArray(activeTheme.miniMode.states[cursor])
                ? activeTheme.miniMode.states[cursor]
                : []
            )
        );
      if (files[0]) {
        return {
          currentFile: files[0],
          resolvedState: cursor,
          fallbackTargetState: cursor !== stateKey ? cursor : null,
        };
      }
      const fallbackTo = typeof binding.fallbackTo === "string" && binding.fallbackTo ? binding.fallbackTo : null;
      if (!fallbackTo || visited.has(fallbackTo)) break;
      visited.add(fallbackTo);
      cursor = fallbackTo;
      hops += 1;
    }

    return null;
  }

  function buildStateCard(stateKey, triggerKind, themeOverrideMap, options = {}) {
    const activeTheme = getActiveTheme();
    const resolved = getResolvedStateCardBinding(stateKey);
    if (!activeTheme || !resolved || !resolved.currentFile) return null;
    const currentFile = resolved.currentFile;
    const autoReturnMap = (activeTheme && activeTheme.timings && activeTheme.timings.autoReturn) || {};
    const supportsAutoReturn = Object.prototype.hasOwnProperty.call(autoReturnMap, stateKey);
    const resolvedAutoReturnMs = supportsAutoReturn ? autoReturnMap[stateKey] : null;
    const timingHint = buildTimingHint(currentFile, resolvedAutoReturnMs);
    const fallbackTargetState = resolved.fallbackTargetState;
    const preview = buildAnimationAssetPreview(currentFile);
    const bindingMap = options.bindingMap || (
      options.bindingPathPrefix === "miniMode.states"
        ? ((activeTheme._bindingBase && activeTheme._bindingBase.miniStates) || {})
        : ((activeTheme._bindingBase && activeTheme._bindingBase.states) || {})
    );
    const bindingPathPrefix = options.bindingPathPrefix || "states";
    return {
      id: `state:${stateKey}`,
      slotType: "state",
      sectionId: options.sectionId || null,
      stateKey,
      triggerKind,
      currentFile,
      resolvedState: resolved.resolvedState,
      fallbackTargetState,
      baseFile: bindingMap[stateKey] || currentFile,
      currentFileUrl: preview.fileUrl,
      currentFilePreviewUrl: preview.previewImageUrl,
      needsScriptedPreviewPoster: preview.needsScriptedPreviewPoster,
      currentFilePreviewPosterCacheKey: preview.previewPosterCacheKey,
      previewPosterPending: preview.previewPosterPending,
      bindingLabel: fallbackTargetState
        ? `${bindingPathPrefix}.${stateKey}.fallbackTo -> ${fallbackTargetState}`
        : `${bindingPathPrefix}.${stateKey}[0]`,
      transition: readResolvedTransition(currentFile),
      transitionThemeDefault: readThemeDefaultTransition(currentFile),
      hasTransitionOverride: hasTransitionOverride(
        themeOverrideMap
        && themeOverrideMap.states
        && themeOverrideMap.states[stateKey]
      ),
      supportsAutoReturn,
      supportsDuration: false,
      autoReturnMs: resolvedAutoReturnMs,
      durationMs: null,
      hasAutoReturnOverride: supportsAutoReturn ? hasExplicitAutoReturnOverride(themeOverrideMap, stateKey) : false,
      ...timingHint,
      displayHintWarning: false,
      displayHintTarget: null,
    };
  }

  function buildIdleAnimationCards(themeOverrideMap) {
    const activeTheme = getActiveTheme();
    if (!activeTheme || !Array.isArray(activeTheme.idleAnimations)) return [];
    const baseIdleAnimations = (activeTheme._bindingBase && activeTheme._bindingBase.idleAnimations) || [];
    const overrideMap = themeOverrideMap && themeOverrideMap.idleAnimations;
    return activeTheme.idleAnimations
      .map((entry, index) => {
        if (!entry || typeof entry.file !== "string" || !entry.file) return null;
        const baseEntry = baseIdleAnimations[index] || null;
        const originalFile = (baseEntry && baseEntry.originalFile) || entry.file;
        const durationMs = Number.isFinite(entry.duration) ? entry.duration : null;
        const timingHint = buildTimingHint(entry.file, durationMs);
        const preview = buildAnimationAssetPreview(entry.file);
        const hasDurationOverride = !!(overrideMap
          && overrideMap[originalFile]
          && Object.prototype.hasOwnProperty.call(overrideMap[originalFile], "durationMs"));
        return {
          id: `idleAnimation:${originalFile}`,
          slotType: "idleAnimation",
          sectionId: "idle",
          triggerKind: "idleAnimation",
          poolIndex: index + 1,
          originalFile,
          baseFile: originalFile,
          currentFile: entry.file,
          currentFileUrl: preview.fileUrl,
          currentFilePreviewUrl: preview.previewImageUrl,
          needsScriptedPreviewPoster: preview.needsScriptedPreviewPoster,
          currentFilePreviewPosterCacheKey: preview.previewPosterCacheKey,
          previewPosterPending: preview.previewPosterPending,
          bindingLabel: `idleAnimations[${index}] (${originalFile})`,
          transition: readResolvedTransition(entry.file),
          transitionThemeDefault: readThemeDefaultTransition(entry.file),
          hasTransitionOverride: hasTransitionOverride(overrideMap && overrideMap[originalFile]),
          supportsAutoReturn: false,
          supportsDuration: true,
          autoReturnMs: null,
          durationMs,
          hasDurationOverride,
          hasAutoReturnOverride: false,
          ...timingHint,
          previewDurationMs: timingHint.previewDurationMs || durationMs,
          displayHintWarning: false,
          displayHintTarget: null,
        };
      })
      .filter(Boolean);
  }

  function buildReactionCards(themeOverrideMap) {
    const activeTheme = getActiveTheme();
    if (!activeTheme || !isPlainObject(activeTheme.reactions)) return [];
    const reactionsMap = activeTheme.reactions;
    const overrideMap = themeOverrideMap && themeOverrideMap.reactions;
    const cards = [];
    for (const spec of REACTION_ORDER) {
      const reactionEntry = reactionsMap[spec.key];
      if (!isPlainObject(reactionEntry)) continue;
      const currentFile = (Array.isArray(reactionEntry.files) && reactionEntry.files[0])
        || reactionEntry.file
        || null;
      if (!currentFile) continue;
      const durationMs = spec.supportsDuration && Number.isFinite(reactionEntry.duration)
        ? reactionEntry.duration
        : null;
      const timingHint = buildTimingHint(currentFile, durationMs);
      const preview = buildAnimationAssetPreview(currentFile);
      const overrideEntry = overrideMap && overrideMap[spec.key];
      const hasDurationOverride = !!(overrideEntry
        && Object.prototype.hasOwnProperty.call(overrideEntry, "durationMs"));
      cards.push({
        id: `reaction:${spec.key}`,
        slotType: "reaction",
        sectionId: "reactions",
        reactionKey: spec.key,
        triggerKind: spec.triggerKind,
        currentFile,
        baseFile: currentFile,
        currentFileUrl: preview.fileUrl,
        currentFilePreviewUrl: preview.previewImageUrl,
        needsScriptedPreviewPoster: preview.needsScriptedPreviewPoster,
        currentFilePreviewPosterCacheKey: preview.previewPosterCacheKey,
        previewPosterPending: preview.previewPosterPending,
        bindingLabel: `reactions.${spec.key}`,
        transition: readResolvedTransition(currentFile),
        transitionThemeDefault: readThemeDefaultTransition(currentFile),
        hasTransitionOverride: hasTransitionOverride(overrideEntry),
        supportsAutoReturn: false,
        supportsDuration: spec.supportsDuration,
        autoReturnMs: null,
        durationMs,
        hasAutoReturnOverride: false,
        hasDurationOverride,
        ...timingHint,
        previewDurationMs: timingHint.previewDurationMs || durationMs,
        displayHintWarning: false,
        displayHintTarget: null,
      });
    }
    return cards;
  }

  function pushSection(sections, id, mode, cards) {
    if (!Array.isArray(cards) || cards.length === 0) return;
    sections.push({ id, mode: mode || null, cards });
  }

  function buildAnimationOverrideSections() {
    const activeTheme = getActiveTheme();
    if (!activeTheme) return [];
    const themeOverrideMap = readCurrentThemeOverrideMap();
    const sections = [];
    const thinking = buildStateCard("thinking", "thinking", themeOverrideMap);
    const baseBindings = activeTheme._bindingBase || {};
    const workCards = [];
    if (thinking) {
      thinking.sectionId = "work";
      workCards.push(thinking);
    }
    workCards.push(...buildTierCardGroup(
      "workingTiers",
      "working",
      activeTheme.workingTiers || [],
      baseBindings.workingTiers || [],
      baseBindings.displayHintMap || {},
      "work",
      themeOverrideMap
    ));
    workCards.push(...buildTierCardGroup(
      "jugglingTiers",
      "juggling",
      activeTheme.jugglingTiers || [],
      baseBindings.jugglingTiers || [],
      baseBindings.displayHintMap || {},
      "work",
      themeOverrideMap
    ));
    pushSection(sections, "work", null, workCards);

    const idleMode = activeTheme._capabilities && activeTheme._capabilities.idleMode;
    if (idleMode === "animated") {
      pushSection(sections, "idle", idleMode, buildIdleAnimationCards(themeOverrideMap));
    } else {
      const idleCard = buildStateCard("idle", idleMode === "tracked" ? "idleTracked" : "idleStatic", themeOverrideMap, {
        sectionId: "idle",
      });
      pushSection(sections, "idle", idleMode, idleCard ? [idleCard] : []);
    }

    const interruptCards = [];
    for (const [stateKey, triggerKind] of [
      ["error", "error"],
      ["attention", "attention"],
      ["notification", "notification"],
      ["sweeping", "sweeping"],
      ["carrying", "carrying"],
    ]) {
      const card = buildStateCard(stateKey, triggerKind, themeOverrideMap, { sectionId: "interrupts" });
      if (card) interruptCards.push(card);
    }
    pushSection(sections, "interrupts", null, interruptCards);

    const sleepCards = [];
    const sleepMode = activeTheme._capabilities && activeTheme._capabilities.sleepMode;
    const sleepStates = sleepMode === "direct"
      ? [["sleeping", "sleeping"]]
      : [
        ["yawning", "yawning"],
        ["dozing", "dozing"],
        ["collapsing", "collapsing"],
        ["sleeping", "sleeping"],
      ];
    for (const [stateKey, triggerKind] of sleepStates) {
      const card = buildStateCard(stateKey, triggerKind, themeOverrideMap, { sectionId: "sleep" });
      if (card) sleepCards.push(card);
    }
    if (hasOwnStateFiles("waking")) {
      const waking = buildStateCard("waking", "waking", themeOverrideMap, { sectionId: "sleep" });
      if (waking) sleepCards.push(waking);
    }
    pushSection(sections, "sleep", sleepMode, sleepCards);

    const reactionCards = buildReactionCards(themeOverrideMap);
    pushSection(sections, "reactions", null, reactionCards);

    if (activeTheme.miniMode && activeTheme.miniMode.supported) {
      const miniCards = [];
      for (const stateKey of [
        "mini-idle",
        "mini-enter",
        "mini-enter-sleep",
        "mini-crabwalk",
        "mini-peek",
        "mini-working",
        "mini-alert",
        "mini-happy",
        "mini-sleep",
      ]) {
        const card = buildStateCard(stateKey, stateKey, themeOverrideMap, {
          sectionId: "mini",
          bindingPathPrefix: "miniMode.states",
        });
        if (card) miniCards.push(card);
      }
      pushSection(sections, "mini", null, miniCards);
    }

    for (const section of sections) {
      if (!section || !Array.isArray(section.cards)) continue;
      if (section.id === "reactions") continue;
      for (const card of section.cards) {
        const {
          wideHitboxEnabled,
          wideHitboxOverridden,
          wideHitboxThemeDefault,
        } = computeCardHitboxInfo(card.currentFile, themeOverrideMap);
        card.wideHitboxEnabled = wideHitboxEnabled;
        card.wideHitboxOverridden = wideHitboxOverridden;
        card.wideHitboxThemeDefault = wideHitboxThemeDefault;
        card.aspectRatioWarning = computeAspectRatioWarning(card.baseFile, card.currentFile);
      }
    }

    return sections;
  }

  function buildSoundOverrideSlots() {
    const activeTheme = getActiveTheme();
    if (!activeTheme || !isPlainObject(activeTheme.sounds)) return [];
    const themeOverrideMap = readCurrentThemeOverrideMap();
    const overrideSoundsMap = themeOverrideMap && isPlainObject(themeOverrideMap.sounds)
      ? themeOverrideMap.sounds : null;
    const runtimeOverrideMap = activeTheme && isPlainObject(activeTheme._soundOverrideFiles)
      ? activeTheme._soundOverrideFiles
      : null;
    const slots = [];
    for (const [name, themeDefault] of Object.entries(activeTheme.sounds)) {
      if (typeof name !== "string" || !name) continue;
      if (typeof themeDefault !== "string" || !themeDefault) continue;
      const overrideEntry = overrideSoundsMap ? overrideSoundsMap[name] : null;
      const hasStoredOverride = !!(
        overrideEntry
        && typeof overrideEntry.file === "string"
        && overrideEntry.file
      );
      const runtimeOverridePath = runtimeOverrideMap && typeof runtimeOverrideMap[name] === "string"
        ? runtimeOverrideMap[name]
        : null;
      const overrideFile = runtimeOverridePath && fs.existsSync(runtimeOverridePath)
        ? path.basename(runtimeOverridePath)
        : null;
      const originalName = overrideFile
        && overrideEntry
        && typeof overrideEntry.originalName === "string"
        && overrideEntry.originalName
        ? overrideEntry.originalName
        : null;
      slots.push({
        name,
        currentFile: overrideFile || themeDefault,
        originalName,
        themeDefaultFile: themeDefault,
        overridden: !!overrideFile,
        hasStoredOverride,
      });
    }
    slots.sort((a, b) => a.name.localeCompare(b.name));
    return slots;
  }

  function buildAnimationOverrideData() {
    const activeTheme = getActiveTheme();
    if (!activeTheme) return null;
    const meta = themeLoader.getThemeMetadata(activeTheme._id) || {};
    const sections = buildAnimationOverrideSections();
    const data = {
      theme: {
        id: activeTheme._id,
        name: meta.name || activeTheme._id,
        variantId: activeTheme._variantId || "default",
        assetsDir: resolveAnimationAssetsDir(activeTheme),
        capabilities: activeTheme._capabilities || meta.capabilities || null,
      },
      assets: listAnimationOverrideAssets(activeTheme),
      sections,
      cards: sections.flatMap((section) => section.cards || []),
      sounds: buildSoundOverrideSlots(),
    };
    scheduleAnimationPreviewPosters(data);
    return data;
  }

  function runAnimationOverridePreview(stateKey, file, durationMs) {
    clearPreviewTimer();
    const stateRuntime = getStateRuntime();
    try {
      stateRuntime.applyState(stateKey, file);
    } catch (err) {
      return { status: "error", message: `previewAnimationOverride: ${err && err.message}` };
    }
    const activeTheme = getActiveTheme();
    const trustedScriptedCycleMs = getTrustedScriptedAnimationCycleMs(file, activeTheme, path);
    const previewMaxMs = isTrustedScriptedAnimationFile(file, activeTheme, path)
      ? TRUSTED_SCRIPTED_PREVIEW_HOLD_MAX_MS
      : PREVIEW_HOLD_MAX_MS;
    const requested = (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0)
      ? durationMs
      : (trustedScriptedCycleMs != null ? trustedScriptedCycleMs : PREVIEW_HOLD_MIN_MS);
    const holdMs = Math.max(PREVIEW_HOLD_MIN_MS, Math.min(previewMaxMs, requested));
    animationOverridePreviewTimer = setTimeout(() => {
      animationOverridePreviewTimer = null;
      const latestStateRuntime = getStateRuntime();
      try {
        latestStateRuntime.applyState("idle", latestStateRuntime.getSvgOverride("idle"));
      } catch {}
    }, holdMs);
    return { status: "ok" };
  }

  function previewAnimationOverride(payload) {
    if (!payload || typeof payload !== "object") {
      return { status: "error", message: "previewAnimationOverride payload must be an object" };
    }
    const { stateKey, file, durationMs } = payload;
    if (typeof stateKey !== "string" || !stateKey) {
      return { status: "error", message: "previewAnimationOverride.stateKey must be a non-empty string" };
    }
    if (typeof file !== "string" || !file) {
      return { status: "error", message: "previewAnimationOverride.file must be a non-empty string" };
    }
    const stateRuntime = getStateRuntime();
    if (!stateRuntime || typeof stateRuntime.applyState !== "function" || typeof stateRuntime.resolveDisplayState !== "function") {
      return { status: "error", message: "previewAnimationOverride requires state runtime" };
    }
    if (getThemeReloadInProgress()) {
      pendingPostReloadTasks.push(() => runAnimationOverridePreview(stateKey, file, durationMs));
      return { status: "ok", deferred: true };
    }
    return runAnimationOverridePreview(stateKey, file, durationMs);
  }

  function previewReaction(payload) {
    if (!payload || typeof payload !== "object") {
      return { status: "error", message: "previewReaction payload must be an object" };
    }
    const { file, durationMs } = payload;
    if (typeof file !== "string" || !file) {
      return { status: "error", message: "previewReaction.file must be a non-empty string" };
    }
    const requested = (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0)
      ? durationMs
      : PREVIEW_HOLD_MIN_MS;
    const clamped = Math.max(PREVIEW_HOLD_MIN_MS, Math.min(PREVIEW_HOLD_MAX_MS, requested));
    sendToRenderer("play-click-reaction", file, clamped);
    return { status: "ok" };
  }

  function getSettingsDialogParent(event) {
    return BrowserWindow.fromWebContents(event.sender) || getSettingsWindow() || null;
  }

  async function openThemeAssetsDir() {
    const dir = resolveOpenableFsPath(resolveAnimationAssetsDir(getActiveTheme()));
    if (!dir || !fs.existsSync(dir)) {
      return { status: "error", message: "theme assets directory unavailable" };
    }
    const result = await shell.openPath(dir);
    if (result) return { status: "error", message: result };
    return { status: "ok", path: dir };
  }

  async function exportAnimationOverrides(event) {
    const s = ANIMATION_OVERRIDES_EXPORT_DIALOG_STRINGS[getLang()] || ANIMATION_OVERRIDES_EXPORT_DIALOG_STRINGS.en;
    const snapshot = settingsController.getSnapshot();
    const overrides = (snapshot && snapshot.themeOverrides) || {};
    const parent = getSettingsDialogParent(event);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const defaultName = s.defaultName(stamp);
    try {
      const result = await dialog.showSaveDialog(parent, {
        title: s.saveTitle,
        defaultPath: defaultName,
        filters: [{ name: s.jsonFilter, extensions: ["json"] }],
      });
      if (result.canceled || !result.filePath) {
        return { status: "cancel" };
      }
      const payload = {
        clawdAnimationOverrides: ANIMATION_OVERRIDES_EXPORT_VERSION,
        version: ANIMATION_OVERRIDES_EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        clawdVersion: app.getVersion(),
        themes: overrides,
      };
      fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), "utf8");
      return {
        status: "ok",
        path: result.filePath,
        themeCount: Object.keys(overrides).length,
      };
    } catch (err) {
      console.warn("Clawd: export-animation-overrides failed:", err && err.message);
      return { status: "error", message: (err && err.message) || "export failed" };
    }
  }

  async function importAnimationOverrides(event) {
    const s = ANIMATION_OVERRIDES_EXPORT_DIALOG_STRINGS[getLang()] || ANIMATION_OVERRIDES_EXPORT_DIALOG_STRINGS.en;
    const parent = getSettingsDialogParent(event);
    let filePath;
    try {
      const result = await dialog.showOpenDialog(parent, {
        title: s.openTitle,
        properties: ["openFile"],
        filters: [{ name: s.jsonFilter, extensions: ["json"] }],
      });
      if (result.canceled || !result.filePaths || !result.filePaths.length) {
        return { status: "cancel" };
      }
      filePath = result.filePaths[0];
    } catch (err) {
      console.warn("Clawd: import-animation-overrides dialog failed:", err && err.message);
      return { status: "error", message: (err && err.message) || "dialog failed" };
    }

    let parsed;
    try {
      const text = fs.readFileSync(filePath, "utf8");
      parsed = JSON.parse(text);
    } catch (err) {
      return { status: "error", message: `parse failed: ${err && err.message}` };
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "error", message: "file is not a Clawd animation overrides export" };
    }
    const magic = parsed.clawdAnimationOverrides;
    if (typeof magic !== "number") {
      return { status: "error", message: "file is not a Clawd animation overrides export" };
    }

    const commandResult = await settingsController.applyCommand("importAnimationOverrides", {
      version: parsed.version || magic,
      themes: parsed.themes,
      mode: "merge",
    });
    if (commandResult && commandResult.status === "ok") {
      return {
        status: "ok",
        path: filePath,
        themeCount: commandResult.importedThemeCount || 0,
      };
    }
    return commandResult || { status: "error", message: "import failed" };
  }

  function cleanup() {
    clearPreviewTimer();
    pendingPostReloadTasks = [];
    bumpPreviewPosterGeneration();
    destroyAnimationPreviewPosterWindow();
  }

  return {
    buildAnimationOverrideData,
    buildAnimationOverrideSections,
    listAnimationOverrideAssets,
    buildAnimationAssetPreview,
    buildAnimationAssetProbe,
    previewAnimationOverride,
    previewReaction,
    openThemeAssetsDir,
    exportAnimationOverrides,
    importAnimationOverrides,
    runPendingPostReloadTasks,
    clearPreviewTimer,
    bumpPreviewPosterGeneration,
    maybeDestroyIdlePreviewPosterWindow,
    destroyAnimationPreviewPosterWindow,
    cleanup,
  };
}

createSettingsAnimationOverridesMain.registerSettingsAnimationOverridesIpc = registerSettingsAnimationOverridesIpc;

createSettingsAnimationOverridesMain.__test = {
  ANIMATION_OVERRIDE_PREVIEW_POSTER_VERSION,
  ANIMATION_OVERRIDE_PREVIEW_POSTER_CACHE_MAX,
  ANIMATION_OVERRIDE_PREVIEW_POSTER_TIMEOUT_MS,
  PREVIEW_HOLD_MIN_MS,
  PREVIEW_HOLD_MAX_MS,
  TRUSTED_SCRIPTED_PREVIEW_HOLD_MAX_MS,
  isTrustedScriptedAnimationFile,
  isObjectChannelSvgAnimationFile,
  needsScriptedAnimationPreviewPoster,
  getTrustedScriptedAnimationCycleMs,
  buildAnimationPreviewPosterDescriptor,
};

module.exports = createSettingsAnimationOverridesMain;
