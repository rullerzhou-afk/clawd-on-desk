"use strict";

const defaultFs = require("fs");
const defaultPath = require("path");
const settingsThemeImporter = require("./settings-theme-importer");

const SOUND_OVERRIDE_ASSET_EXTS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"]);
const SOUND_OVERRIDE_DIALOG_STRINGS = {
  en: { title: "Choose a sound file", filterName: "Audio" },
  zh: { title: "选择音效文件", filterName: "音频" },
  "zh-TW": { title: "選擇音效檔案", filterName: "音效" },
  ko: { title: "음향 파일 선택", filterName: "오디오" },
  ja: { title: "音声ファイルを選択", filterName: "音声" },
};

const REMOVE_THEME_DIALOG_STRINGS = {
  en: {
    delete: "Delete",
    cancel: "Cancel",
    message: (name) => `Delete theme "${name}"?`,
    detail: "This cannot be undone. All files for this theme will be removed from disk.",
  },
  zh: {
    delete: "删除",
    cancel: "取消",
    message: (name) => `确认删除主题 "${name}"？`,
    detail: "此操作不可撤销。主题的所有文件将从磁盘移除。",
  },
  "zh-TW": {
    delete: "刪除",
    cancel: "取消",
    message: (name) => `確定要刪除主題「${name}」？`,
    detail: "此動作無法復原。此主題的所有檔案都會從磁碟移除。",
  },
  ko: {
    delete: "삭제",
    cancel: "취소",
    message: (name) => `테마 "${name}"을(를) 삭제할까요?`,
    detail: "이 작업은 되돌릴 수 없습니다. 이 테마의 모든 파일이 디스크에서 제거됩니다.",
  },
  ja: {
    delete: "削除",
    cancel: "キャンセル",
    message: (name) => `テーマ "${name}" を削除しますか？`,
    detail: "この操作は元に戻せません。このテーマのすべてのファイルがディスクから削除されます。",
  },
};

function requiredDependency(value, name) {
  if (!value) throw new Error(`registerSettingsIpc requires ${name}`);
  return value;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getSettingsDialogParent(event, { BrowserWindow, getSettingsWindow }) {
  const sender = event && event.sender;
  const fromSender = sender && BrowserWindow && typeof BrowserWindow.fromWebContents === "function"
    ? BrowserWindow.fromWebContents(sender)
    : null;
  return fromSender || (typeof getSettingsWindow === "function" ? getSettingsWindow() : null) || null;
}

function cleanupSiblingSoundOverrides(fs, path, overridesDir, soundName, keepExt) {
  let entries;
  try { entries = fs.readdirSync(overridesDir); }
  catch { return; }
  for (const entry of entries) {
    if (path.parse(entry).name !== soundName) continue;
    if (path.extname(entry).toLowerCase() === keepExt) continue;
    try { fs.unlinkSync(path.join(overridesDir, entry)); } catch {}
  }
}

function rememberRuntimeSoundOverrideFile({ getActiveTheme }, themeId, soundName, absPath) {
  const activeTheme = getActiveTheme();
  if (!activeTheme || activeTheme._id !== themeId) return;
  if (typeof soundName !== "string" || !soundName) return;
  if (typeof absPath !== "string" || !absPath) return;
  const nextOverrideMap = isPlainObject(activeTheme._soundOverrideFiles)
    ? { ...activeTheme._soundOverrideFiles }
    : {};
  nextOverrideMap[soundName] = absPath;
  activeTheme._soundOverrideFiles = nextOverrideMap;
}

function mapAgentMetadata(agent) {
  return {
    id: agent.id,
    name: agent.name,
    eventSource: agent.eventSource,
    capabilities: agent.capabilities || {},
  };
}

function registerSettingsIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain");
  const settingsController = requiredDependency(options.settingsController, "settingsController");
  const themeLoader = requiredDependency(options.themeLoader, "themeLoader");
  const codexPetMain = requiredDependency(options.codexPetMain, "codexPetMain");
  const dialog = requiredDependency(options.dialog, "dialog");
  const shell = requiredDependency(options.shell, "shell");
  const app = requiredDependency(options.app, "app");
  const BrowserWindow = requiredDependency(options.BrowserWindow, "BrowserWindow");
  const fs = options.fs || defaultFs;
  const path = options.path || defaultPath;
  const getSettingsWindow = options.getSettingsWindow || (() => null);
  const getActiveTheme = options.getActiveTheme || (() => null);
  const getLang = options.getLang || (() => "en");
  const settingsSizePreviewSession = requiredDependency(
    options.settingsSizePreviewSession,
    "settingsSizePreviewSession"
  );
  const isValidSizePreviewKey = requiredDependency(
    options.isValidSizePreviewKey,
    "isValidSizePreviewKey"
  );
  const sendToRenderer = options.sendToRenderer || (() => {});
  const getDoNotDisturb = options.getDoNotDisturb || (() => false);
  const getSoundMuted = options.getSoundMuted || (() => false);
  const getSoundVolume = options.getSoundVolume || (() => 1);
  const getAllAgents = requiredDependency(options.getAllAgents, "getAllAgents");
  const checkForUpdates = options.checkForUpdates || (() => {});
  const now = options.now || (() => Date.now());
  const aboutHeroSvgPath = options.aboutHeroSvgPath
    || path.join(__dirname, "..", "assets", "svg", "clawd-about-hero.svg");
  const disposers = [];

  function handle(channel, listener) {
    ipcMain.handle(channel, listener);
    disposers.push(() => ipcMain.removeHandler(channel));
  }

  function getDialogParent(event) {
    return getSettingsDialogParent(event, { BrowserWindow, getSettingsWindow });
  }

  handle("settings:get-snapshot", () => settingsController.getSnapshot());
  handle("settings:update", (_event, payload) => {
    if (!payload || typeof payload !== "object") {
      return { status: "error", message: "settings:update payload must be { key, value }" };
    }
    return settingsController.applyUpdate(payload.key, payload.value);
  });
  handle("settings:begin-size-preview", () => settingsSizePreviewSession.begin());
  handle("settings:preview-size", (_event, value) => {
    if (!isValidSizePreviewKey(value)) {
      return { status: "error", message: `invalid preview size "${value}"` };
    }
    return settingsSizePreviewSession.preview(value).then(() => ({ status: "ok" }));
  });
  handle("settings:end-size-preview", (_event, value) => {
    if (value !== null && value !== undefined && !isValidSizePreviewKey(value)) {
      return { status: "error", message: `invalid preview size "${value}"` };
    }
    return settingsSizePreviewSession.end(value || null);
  });
  handle("settings:get-preview-sound-url", () => {
    try { return themeLoader.getPreviewSoundUrl(); }
    catch { return null; }
  });
  handle("settings:command", async (_event, payload) => {
    if (!payload || typeof payload !== "object") {
      return { status: "error", message: "settings:command payload must be { action, payload }" };
    }
    return settingsController.applyCommand(payload.action, payload.payload);
  });

  handle("settings:pick-sound-file", async (event, payload) => {
    if (!payload || typeof payload !== "object") {
      return { status: "error", message: "pickSoundFile payload must be an object" };
    }
    const { soundName } = payload;
    if (typeof soundName !== "string" || !soundName) {
      return { status: "error", message: "pickSoundFile.soundName must be a non-empty string" };
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(soundName)) {
      return { status: "error", message: `pickSoundFile.soundName "${soundName}" contains invalid characters` };
    }

    const activeTheme = getActiveTheme();
    if (!activeTheme) return { status: "error", message: "no active theme" };
    const themeId = activeTheme._id;
    if (!isPlainObject(activeTheme.sounds) || !activeTheme.sounds[soundName]) {
      return { status: "error", message: `sound "${soundName}" not declared by theme "${themeId}"` };
    }
    const overridesDir = themeLoader.getSoundOverridesDir(themeId);
    if (!overridesDir) return { status: "error", message: "sound-overrides directory unavailable" };

    const lang = getLang();
    const strings = SOUND_OVERRIDE_DIALOG_STRINGS[lang] || SOUND_OVERRIDE_DIALOG_STRINGS.en;
    const extList = [...SOUND_OVERRIDE_ASSET_EXTS].map((ext) => ext.slice(1));
    let result;
    try {
      result = await dialog.showOpenDialog(getDialogParent(event), {
        title: strings.title,
        filters: [{ name: strings.filterName, extensions: extList }],
        properties: ["openFile"],
      });
    } catch (err) {
      return { status: "error", message: `pick dialog failed: ${err && err.message}` };
    }
    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { status: "cancel" };
    }

    const sourcePath = result.filePaths[0];
    const ext = path.extname(sourcePath).toLowerCase();
    if (!SOUND_OVERRIDE_ASSET_EXTS.has(ext)) {
      return { status: "error", message: `unsupported audio extension: ${ext || "(none)"}` };
    }

    try { fs.mkdirSync(overridesDir, { recursive: true }); }
    catch (err) { return { status: "error", message: `mkdir failed: ${err && err.message}` }; }

    const destFilename = `${soundName}${ext}`;
    const destPath = path.join(overridesDir, destFilename);
    try {
      fs.copyFileSync(sourcePath, destPath);
    } catch (err) {
      return { status: "error", message: `copy failed: ${err && err.message}` };
    }
    cleanupSiblingSoundOverrides(fs, path, overridesDir, soundName, ext);

    const cmdResult = await settingsController.applyCommand("setSoundOverride", {
      themeId,
      soundName,
      file: destFilename,
      originalName: path.basename(sourcePath),
    });
    if (!cmdResult || cmdResult.status !== "ok") {
      return cmdResult || { status: "error", message: "setSoundOverride failed" };
    }
    rememberRuntimeSoundOverrideFile({ getActiveTheme }, themeId, soundName, destPath);
    const newUrl = themeLoader.getSoundUrl(soundName);
    if (newUrl) sendToRenderer("invalidate-sound-cache", newUrl);
    return { status: "ok", file: destFilename };
  });

  handle("settings:preview-sound", (_event, payload) => {
    if (!payload || typeof payload !== "object") {
      return { status: "error", message: "previewSound payload must be an object" };
    }
    const { soundName } = payload;
    if (typeof soundName !== "string" || !soundName) {
      return { status: "error", message: "previewSound.soundName must be a non-empty string" };
    }
    if (getDoNotDisturb()) return { status: "skipped", reason: "dnd" };
    if (getSoundMuted()) return { status: "skipped", reason: "muted" };
    const url = themeLoader.getSoundUrl(soundName);
    if (!url) return { status: "error", message: "sound unavailable" };
    const bustedUrl = `${url}${url.includes("?") ? "&" : "?"}_t=${now()}`;
    sendToRenderer("play-sound", { url: bustedUrl, volume: getSoundVolume() });
    return { status: "ok" };
  });

  handle("settings:open-sound-overrides-dir", async () => {
    const activeTheme = getActiveTheme();
    if (!activeTheme) return { status: "error", message: "no active theme" };
    const dir = themeLoader.getSoundOverridesDir(activeTheme._id);
    if (!dir) return { status: "error", message: "sound-overrides directory unavailable" };
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const openResult = await shell.openPath(dir);
    if (openResult) return { status: "error", message: openResult };
    return { status: "ok", path: dir };
  });

  handle("settings:list-themes", () => {
    try {
      const activeTheme = getActiveTheme();
      const activeId = activeTheme ? activeTheme._id : "clawd";
      return themeLoader.listThemesWithMetadata().map((theme) =>
        codexPetMain.decorateThemeMetadata({
          ...theme,
          active: theme.id === activeId,
        })
      );
    } catch (err) {
      console.warn("Clawd: settings:list-themes failed:", err && err.message);
      return [];
    }
  });

  handle("settings:open-user-themes-dir", async () => {
    const dir = typeof themeLoader.ensureUserThemesDir === "function"
      ? themeLoader.ensureUserThemesDir()
      : null;
    if (!dir) return { status: "error", message: "user themes directory unavailable" };
    const openResult = await shell.openPath(dir);
    if (openResult) return { status: "error", message: openResult };
    return { status: "ok", path: dir };
  });

  handle("settings:import-user-theme-zip", async (event) => {
    let result;
    try {
      result = await dialog.showOpenDialog(getDialogParent(event), {
        properties: ["openFile"],
        filters: [{ name: "Clawd theme zip", extensions: ["zip"] }],
      });
    } catch (err) {
      return { status: "error", message: `theme zip picker failed: ${err && err.message}` };
    }
    if (!result || result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { status: "cancel" };
    }

    try {
      const userThemesDir = typeof themeLoader.ensureUserThemesDir === "function"
        ? themeLoader.ensureUserThemesDir()
        : null;
      return settingsThemeImporter.importUserThemeZip(result.filePaths[0], {
        fs,
        path,
        userThemesDir,
      });
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  handle("settings:refresh-codex-pets", () => codexPetMain.refreshFromSettings());
  handle("settings:open-codex-pets-dir", () => codexPetMain.openCodexPetsDir());
  handle("settings:import-codex-pet-zip", (event) => codexPetMain.importCodexPetZip(event));
  handle("settings:remove-codex-pet", (_event, themeId) => codexPetMain.removeCodexPet(themeId));

  handle("settings:confirm-remove-theme", async (event, themeId) => {
    if (typeof themeId !== "string" || !themeId) return { confirmed: false };
    const meta = themeLoader.getThemeMetadata(themeId);
    const displayName = (meta && meta.name) || themeId;
    const lang = getLang();
    const strings = REMOVE_THEME_DIALOG_STRINGS[lang] || REMOVE_THEME_DIALOG_STRINGS.en;
    try {
      const { response } = await dialog.showMessageBox(getDialogParent(event), {
        type: "warning",
        buttons: [strings.delete, strings.cancel],
        defaultId: 1,
        cancelId: 1,
        message: strings.message(displayName),
        detail: strings.detail,
        noLink: true,
      });
      return { confirmed: response === 0 };
    } catch (err) {
      console.warn("Clawd: confirm-remove-theme dialog failed:", err && err.message);
      return { confirmed: false };
    }
  });

  handle("settings:list-agents", () => {
    try {
      return getAllAgents().map(mapAgentMetadata);
    } catch (err) {
      console.warn("Clawd: settings:list-agents failed:", err && err.message);
      return [];
    }
  });

  handle("settings:get-about-info", () => {
    let heroSvgContent = "";
    try {
      heroSvgContent = fs.readFileSync(aboutHeroSvgPath, "utf8");
    } catch (err) {
      console.warn("Clawd: failed to read about hero SVG:", err && err.message);
    }
    return {
      version: app.getVersion(),
      repoUrl: "https://github.com/rullerzhou-afk/clawd-on-desk",
      license: "AGPL-3.0",
      copyright: "\u00a9 2026 Ruller_Lulu",
      authorName: "Ruller_Lulu / \u9e7f\u9e7f",
      authorUrl: "https://github.com/rullerzhou-afk",
      heroSvgContent,
    };
  });

  handle("settings:check-for-updates", () => {
    try {
      checkForUpdates(true);
      return { status: "ok" };
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  handle("settings:open-external", async (_event, url) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      return { status: "error", message: "Invalid URL" };
    }
    try {
      await shell.openExternal(url);
      return { status: "ok" };
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  return {
    dispose() {
      while (disposers.length) {
        const dispose = disposers.pop();
        try { dispose(); } catch {}
      }
    },
  };
}

module.exports = {
  registerSettingsIpc,
};
