"use strict";

const defaultFs = require("fs");
const defaultPath = require("path");
const crypto = require("crypto");
const { pathToFileURL } = require("url");
const {
  normalizeMusicAuraSettings,
} = require("./music-aura-settings");

const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".opus"]);
const MAX_SCAN_TRACKS = 1500;
const MAX_SCAN_DEPTH = 8;

function isAudioFile(path, filePath) {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function titleFromFile(path, filePath) {
  return path.basename(filePath, path.extname(filePath)).replace(/[_-]+/g, " ").trim() || path.basename(filePath);
}

function stableTrackId(filePath) {
  return crypto.createHash("sha1").update(String(filePath)).digest("hex").slice(0, 16);
}

function safeStat(fs, filePath) {
  try { return fs.statSync(filePath); }
  catch { return null; }
}

function scanDir({ fs, path, rootDir, out, depth }) {
  if (out.length >= MAX_SCAN_TRACKS || depth > MAX_SCAN_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  for (const entry of entries) {
    if (out.length >= MAX_SCAN_TRACKS) return;
    if (!entry || !entry.name || entry.name.startsWith(".")) continue;
    const abs = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      scanDir({ fs, path, rootDir: abs, out, depth: depth + 1 });
      continue;
    }
    if (!entry.isFile() || !isAudioFile(path, abs)) continue;
    const stat = safeStat(fs, abs);
    out.push({
      id: stableTrackId(abs),
      title: titleFromFile(path, abs),
      fileName: path.basename(abs),
      path: abs,
      url: pathToFileURL(abs).toString(),
      size: stat && Number.isFinite(stat.size) ? stat.size : 0,
      mtimeMs: stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0,
    });
  }
}

function scanLibrary(settings, options = {}) {
  const fs = options.fs || defaultFs;
  const path = options.path || defaultPath;
  const config = normalizeMusicAuraSettings(settings);
  const tracks = [];
  const dirs = [];
  const missingDirs = [];
  for (const raw of config.libraryDirs) {
    const dir = path.resolve(raw);
    const stat = safeStat(fs, dir);
    if (!stat || !stat.isDirectory()) {
      missingDirs.push(raw);
      continue;
    }
    dirs.push(dir);
    scanDir({ fs, path, rootDir: dir, out: tracks, depth: 0 });
    if (tracks.length >= MAX_SCAN_TRACKS) break;
  }
  return {
    ok: true,
    tracks,
    count: tracks.length,
    dirs,
    missingDirs,
    truncated: tracks.length >= MAX_SCAN_TRACKS,
    scannedAt: Date.now(),
  };
}

function createMusicAuraMain(options = {}) {
  const fs = options.fs || defaultFs;
  const path = options.path || defaultPath;
  const settingsController = options.settingsController;
  const dialog = options.dialog;
  const getSettingsWindow = options.getSettingsWindow || (() => null);
  const sendToRenderer = options.sendToRenderer || (() => {});
  const broadcastSettingsWindow = options.broadcastSettingsWindow || (() => {});
  let cachedLibrary = null;
  let cachedLibraryKey = "";
  let runtimeStatus = {
    playing: false,
    track: null,
    trackIndex: -1,
    count: 0,
    error: "",
    visual: null,
    currentTime: 0,
    duration: 0,
  };

  function normalizeVisualStatus(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return {
      active: value.active === true,
      visible: value.visible === true,
      webglReady: value.webglReady === true,
      particleCount: Number.isFinite(value.particleCount) ? Math.max(0, Math.floor(value.particleCount)) : 0,
      style: typeof value.style === "string" ? value.style : "",
      backgroundAdaptation: typeof value.backgroundAdaptation === "string" ? value.backgroundAdaptation : "",
      error: typeof value.error === "string" ? value.error : "",
    };
  }

  function getSettings() {
    return normalizeMusicAuraSettings(settingsController ? settingsController.get("musicAura") : {});
  }

  function libraryKey(settings) {
    const config = normalizeMusicAuraSettings(settings);
    return config.libraryDirs.join("\n");
  }

  function refreshLibrary({ force = false } = {}) {
    const settings = getSettings();
    if (!force && cachedLibrary) return cachedLibrary;
    cachedLibrary = scanLibrary(settings, { fs, path });
    cachedLibraryKey = libraryKey(settings);
    sendToRenderer("music-aura-library", cachedLibrary);
    broadcastSettingsWindow("musicAura:runtime-changed", getRuntime());
    return cachedLibrary;
  }

  function getRuntime() {
    const library = cachedLibrary || refreshLibrary();
    return {
      settings: getSettings(),
      library: {
        count: library.count || 0,
        dirs: library.dirs || [],
        missingDirs: library.missingDirs || [],
        truncated: !!library.truncated,
        scannedAt: library.scannedAt || 0,
      },
      status: runtimeStatus,
    };
  }

  async function chooseDirectory() {
    if (!dialog || typeof dialog.showOpenDialog !== "function") {
      return { status: "error", message: "directory picker unavailable" };
    }
    const result = await dialog.showOpenDialog(getSettingsWindow(), {
      properties: ["openDirectory"],
    });
    if (!result || result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { status: "ok", canceled: true };
    }
    return { status: "ok", dir: result.filePaths[0] };
  }

  function rendererBootstrap() {
    const library = refreshLibrary();
    return {
      settings: getSettings(),
      library,
      status: runtimeStatus,
    };
  }

  function applySettingsChange() {
    const settings = getSettings();
    const nextLibraryKey = libraryKey(settings);
    const shouldRefreshLibrary = !cachedLibrary || nextLibraryKey !== cachedLibraryKey;
    const library = shouldRefreshLibrary ? refreshLibrary({ force: true }) : cachedLibrary;
    sendToRenderer("music-aura-settings", settings);
    if (!shouldRefreshLibrary) {
      sendToRenderer("music-aura-library", library);
      broadcastSettingsWindow("musicAura:runtime-changed", getRuntime());
    }
    return { settings, library };
  }

  function command(command, payload = {}) {
    sendToRenderer("music-aura-command", { command, payload });
    return { status: "ok" };
  }

  function updateStatus(payload) {
    const source = payload && typeof payload === "object" ? payload : {};
    runtimeStatus = {
      playing: source.playing === true,
      track: source.track && typeof source.track === "object" ? {
        id: source.track.id || "",
        title: source.track.title || "",
        fileName: source.track.fileName || "",
      } : null,
      trackIndex: Number.isFinite(source.trackIndex) ? source.trackIndex : -1,
      count: Number.isFinite(source.count) ? source.count : 0,
      error: typeof source.error === "string" ? source.error : "",
      visual: normalizeVisualStatus(source.visual),
      currentTime: Number.isFinite(source.currentTime) ? Math.max(0, source.currentTime) : 0,
      duration: Number.isFinite(source.duration) ? Math.max(0, source.duration) : 0,
    };
    broadcastSettingsWindow("musicAura:runtime-changed", getRuntime());
    return { status: "ok" };
  }

  return {
    chooseDirectory,
    refreshLibrary,
    getRuntime,
    rendererBootstrap,
    applySettingsChange,
    command,
    updateStatus,
  };
}

module.exports = {
  AUDIO_EXTENSIONS,
  MAX_SCAN_TRACKS,
  scanLibrary,
  createMusicAuraMain,
};
