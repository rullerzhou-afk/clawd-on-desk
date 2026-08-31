"use strict";

const defaultFs = require("fs");
const defaultPath = require("path");
const { pathToFileURL } = require("url");
const { detectAgentInstallations: defaultDetectAgentInstallations } = require("./agent-installation-detector");
const { DEFAULT_INTEGRATION_INSTALLED_IDS } = require("./prefs");
const settingsThemeImporter = require("./settings-theme-importer");
const {
  listPetTintOptions,
  listPetAccessoryOptions,
  listPetMouthAccessoryOptions,
} = require("./pet-customization-catalog");

const SOUND_OVERRIDE_ASSET_EXTS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"]);
// #895: cleanup prompts must skip the default integrations, referencing the
// prefs list rather than a second hardcoded copy of the ids.
const CLEANUP_EXEMPT_AGENT_IDS = new Set(DEFAULT_INTEGRATION_INSTALLED_IDS);
// These commands mutate trust material or persist facts learned from an SSH
// transaction. They are main-process capabilities, not renderer commands.
// Keeping the check at the IPC boundary means an injected/compromised Settings
// renderer cannot mint a trusted install binding, advance a deployment
// transaction, or claim that a remote profile was verified.
const INTERNAL_SETTINGS_COMMANDS = new Set([
  "remoteSsh.applyInstallationIdentity",
  "remoteSsh.beginIdentityRotation",
  "remoteSsh.updateIdentityStep",
  "remoteSsh.commitIdentityRotation",
  "remoteSsh.forceRevoke",
  "remoteSsh.beginRuntimeModeSwitch",
  "remoteSsh.advanceRuntimeModeSwitch",
  "remoteSsh.switchRuntimeMode",
  "remoteSsh.markDeployed",
  "remoteSsh.markRemoteNode",
  "feishuApproval.commitResolvedApprover",
]);
const SOUND_OVERRIDE_DIALOG_STRINGS = {
  en: { title: "Choose a sound file", filterName: "Audio" },
  zh: { title: "选择音效文件", filterName: "音频" },
  "zh-TW": { title: "選擇音效檔案", filterName: "音效" },
  ko: { title: "음향 파일 선택", filterName: "오디오" },
  ja: { title: "音声ファイルを選択", filterName: "音声" },
  "pt-BR": { title: "Escolha um arquivo de som", filterName: "Áudio" },
  es: { title: "Elige un archivo de sonido", filterName: "Audio" },
};

const AGENT_DISCOVERY_DIALOG_STRINGS = {
  en: { file: "Choose a tool executable", directory: "Choose a tool installation folder" },
  zh: { file: "选择工具可执行文件", directory: "选择工具安装目录" },
  "zh-TW": { file: "選擇工具執行檔", directory: "選擇工具安裝目錄" },
  ko: { file: "도구 실행 파일 선택", directory: "도구 설치 폴더 선택" },
  ja: { file: "ツールの実行ファイルを選択", directory: "ツールのインストールフォルダーを選択" },
  "pt-BR": { file: "Escolha o executável da ferramenta", directory: "Escolha a pasta de instalação da ferramenta" },
  es: { file: "Elige el ejecutable de la herramienta", directory: "Elige la carpeta de instalación de la herramienta" },
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
  "pt-BR": {
    delete: "Excluir",
    cancel: "Cancelar",
    message: (name) => `Excluir o tema "${name}"?`,
    detail: "Isso não pode ser desfeito. Todos os arquivos deste tema serão removidos do disco.",
  },
  es: {
    delete: "Eliminar",
    cancel: "Cancelar",
    message: (name) => `¿Eliminar el tema "${name}"?`,
    detail: "Esta acción no se puede deshacer. Todos los archivos de este tema se eliminarán del disco.",
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
  const metadata = {
    id: agent.id,
    name: agent.name,
    eventSource: agent.eventSource,
    capabilities: agent.capabilities || {},
    // #895: default integrations never earn a "remove this stale hook" prompt —
    // their parent dirs are not trustworthy evidence (Clawd's own Claude sync
    // creates ~/.claude). Shipped as an explicit boolean rather than a list the
    // renderer has to hold, so a missing field reads as "unknown" and the
    // renderer fails closed instead of proposing a deletion.
    cleanupSuggestionExempt: CLEANUP_EXEMPT_AGENT_IDS.has(agent.id),
  };
  if (typeof agent.category === "string" && agent.category) {
    metadata.category = agent.category;
  }
  return metadata;
}

function mapCustomApplicationMetadata(application, options = {}) {
  return {
    id: application.id,
    name: application.name,
    category: application.category || "code",
    eventSource: "custom-http",
    custom: true,
    sourcePath: application.sourcePath,
    executablePath: application.executablePath,
    processName: application.processName,
    stateEndpoint: options.stateEndpoint || "",
    lastStateEvent: options.lastStateEvent || null,
    capabilities: {
      httpHook: true,
      permissionApproval: false,
      interactiveBubble: false,
      notificationHook: true,
      sessionEnd: true,
      subagent: false,
      managedIntegration: false,
    },
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
  const settingsPageUrl = pathToFileURL(
    options.settingsHtmlPath || defaultPath.join(__dirname, "settings.html"),
  ).href;
  const getSettingsWindow = options.getSettingsWindow || (() => null);
  const getActiveTheme = options.getActiveTheme || (() => null);
  const getLang = options.getLang || (() => "en");
  const roamFenceSettings = requiredDependency(options.roamFenceSettings, "roamFenceSettings");
  const roamFencePicker = requiredDependency(options.roamFencePicker, "roamFencePicker");
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
  const saveFeishuApproverByEmail = requiredDependency(
    options.saveFeishuApproverByEmail,
    "saveFeishuApproverByEmail",
  );
  const previewTextScale = options.previewTextScale
    || (() => ({ status: "error", message: "text scale preview unavailable" }));
  const endTextScalePreview = options.endTextScalePreview
    || (() => ({ status: "error", message: "text scale preview unavailable" }));
  const getTextScaleContext = options.getTextScaleContext
    || (() => ({ percent: 100 }));
  const getAllAgents = requiredDependency(options.getAllAgents, "getAllAgents");
  const detectAgentInstallations = options.detectAgentInstallations || defaultDetectAgentInstallations;
  const getHookServerPort = options.getHookServerPort || (() => null);
  const getRecentHookEvents = options.getRecentHookEvents || (() => []);
  const checkForUpdates = options.checkForUpdates || (() => {});
  const getUpdateCheckSnapshot = options.getUpdateCheckSnapshot || (() => ({ state: "idle" }));
  const clearUpdateError = options.clearUpdateError || (() => ({ state: "idle" }));
  const copyUpdateError = options.copyUpdateError || (() => ({ status: "error", message: "clipboard unavailable" }));
  const showTutorial = options.showTutorial || (() => ({
    status: "error",
    message: "Tutorial is unavailable",
  }));
  const now = options.now || (() => Date.now());
  const aboutHeroSvgPath = options.aboutHeroSvgPath
    || path.join(__dirname, "..", "assets", "svg", "clawd-about-hero.svg");
  const disposers = [];
  let currentFeishuApproverLookup = null;

  function handle(channel, listener) {
    ipcMain.handle(channel, listener);
    disposers.push(() => ipcMain.removeHandler(channel));
  }

  function getDialogParent(event) {
    return getSettingsDialogParent(event, { BrowserWindow, getSettingsWindow });
  }

  function isTrustedSettingsEvent(event) {
    const win = getSettingsWindow();
    if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return false;
    const contents = win.webContents;
    const frame = event && event.senderFrame;
    return !!contents
      && event.sender === contents
      && !!frame
      && frame === contents.mainFrame
      && frame.url === settingsPageUrl;
  }

  function rejectUntrustedSettingsEvent(event) {
    return isTrustedSettingsEvent(event)
      ? null
      : { status: "error", message: "untrusted settings sender" };
  }

  function removeFeishuLookupListeners(operation) {
    if (!operation || !operation.sender || typeof operation.sender.removeListener !== "function") return;
    operation.sender.removeListener("destroyed", operation.onDestroyed);
    operation.sender.removeListener("render-process-gone", operation.onRenderProcessGone);
  }

  function abortCurrentFeishuApproverLookup(reason, sender = null) {
    const operation = currentFeishuApproverLookup;
    if (!operation || (sender && operation.sender !== sender)) return false;
    if (!operation.controller.signal.aborted) {
      operation.reason = reason;
      operation.controller.abort();
    }
    return true;
  }

  function publicFeishuLookupResult(result) {
    if (result && result.status === "ok") return { status: "ok" };
    return result && typeof result.code === "string"
      ? { status: "error", code: result.code }
      : { status: "error" };
  }

  async function runFeishuApproverLookup(event, email) {
    abortCurrentFeishuApproverLookup("superseded");
    const operation = {
      sender: event.sender,
      controller: new AbortController(),
      reason: "cancelled",
      onDestroyed: null,
      onRenderProcessGone: null,
    };
    operation.onDestroyed = () => {
      if (currentFeishuApproverLookup === operation) {
        abortCurrentFeishuApproverLookup("destroyed", operation.sender);
      }
    };
    operation.onRenderProcessGone = operation.onDestroyed;
    currentFeishuApproverLookup = operation;
    if (typeof operation.sender.once === "function") {
      operation.sender.once("destroyed", operation.onDestroyed);
      operation.sender.once("render-process-gone", operation.onRenderProcessGone);
    }

    try {
      let result;
      try {
        result = await saveFeishuApproverByEmail({
          email,
          signal: operation.controller.signal,
        });
      } catch {
        result = { status: "error", code: "lookup-failed" };
      }
      if (operation.controller.signal.aborted) {
        return {
          status: "error",
          code: operation.reason === "superseded" ? "lookup-superseded" : "lookup-cancelled",
        };
      }
      return publicFeishuLookupResult(result);
    } finally {
      removeFeishuLookupListeners(operation);
      if (currentFeishuApproverLookup === operation) currentFeishuApproverLookup = null;
    }
  }

  handle("settings:get-snapshot", () => settingsController.getSnapshot());
  handle("settings:recap-query", async (event, period) => {
    const rejected = rejectUntrustedSettingsEvent(event);
    if (rejected) return rejected;
    if (!["today", "week", "month", "year"].includes(period)) {
      return { status: "error", reason: "invalid-period" };
    }
    const runtime = options.recapRuntime;
    if (!runtime || typeof runtime.query !== "function") {
      return { status: "error", reason: "runtime-unavailable" };
    }
    try {
      if (typeof runtime.whenReady === "function") await runtime.whenReady();
      return runtime.query(period);
    }
    catch { return { status: "error", reason: "query-failed" }; }
  });
  handle("settings:recap-clear", (event) => {
    const rejected = rejectUntrustedSettingsEvent(event);
    if (rejected) return rejected;
    const runtime = options.recapRuntime;
    if (!runtime || typeof runtime.clear !== "function") {
      return { status: "error", reason: "runtime-unavailable" };
    }
    try {
      return runtime.clear()
        ? { status: "ok" }
        : { status: "error", reason: "clear-failed" };
    } catch {
      return { status: "error", reason: "clear-failed" };
    }
  });
  // Distinct quota-reporting sources (this machine + WSL / SSH remotes). The
  // General tab uses it to hide the "merge across machines" switch when it is
  // a single-machine no-op.
  handle("settings:get-quota-source-count", () => {
    try {
      return typeof options.getQuotaSourceCount === "function" ? options.getQuotaSourceCount() : 0;
    } catch (_err) {
      return 0;
    }
  });
  // Which providers the "show beside the pet" list should offer. Driven by the
  // live snapshot, not by the static provider table, so the list never shows a
  // checkbox for a provider the user has not connected — the same reasoning
  // that keeps "merge across machines" hidden on a single-machine setup. An
  // empty array is the honest failure mode: the settings row hides itself
  // rather than rendering a list that claims nothing is connected.
  handle("settings:get-quota-ring-providers", () => {
    try {
      return typeof options.getQuotaRingProviders === "function"
        ? options.getQuotaRingProviders()
        : [];
    } catch (_err) {
      return [];
    }
  });
  // Kimi API keys are accepted only by these trusted Settings-window handlers.
  // They never transit settings:command, prefs, or a renderer-broadcast
  // snapshot. Results are deliberately sanitized by kimi-quota-runtime.
  handle("settings:kimi-quota-status", (event) => {
    const rejected = rejectUntrustedSettingsEvent(event);
    if (rejected) return rejected;
    const runtime = options.kimiQuotaRuntime;
    return runtime && typeof runtime.getStatus === "function"
      ? runtime.getStatus()
      : { status: "error", reason: "runtime-unavailable" };
  });
  handle("settings:kimi-quota-connect", async (event, payload) => {
    const rejected = rejectUntrustedSettingsEvent(event);
    if (rejected) return rejected;
    if (!payload || typeof payload !== "object" || typeof payload.apiKey !== "string") {
      return { status: "error", reason: "invalid-credential-input" };
    }
    const runtime = options.kimiQuotaRuntime;
    return runtime && typeof runtime.connect === "function"
      ? runtime.connect(payload.apiKey)
      : { status: "error", reason: "runtime-unavailable" };
  });
  handle("settings:kimi-quota-refresh", (event) => {
    const rejected = rejectUntrustedSettingsEvent(event);
    if (rejected) return rejected;
    const runtime = options.kimiQuotaRuntime;
    return runtime && typeof runtime.refresh === "function"
      ? runtime.refresh()
      : { status: "error", reason: "runtime-unavailable" };
  });
  handle("settings:kimi-quota-reconnect", (event) => {
    const rejected = rejectUntrustedSettingsEvent(event);
    if (rejected) return rejected;
    const runtime = options.kimiQuotaRuntime;
    return runtime && typeof runtime.reconnect === "function"
      ? runtime.reconnect()
      : { status: "error", reason: "runtime-unavailable" };
  });
  handle("settings:kimi-quota-disconnect", (event) => {
    const rejected = rejectUntrustedSettingsEvent(event);
    if (rejected) return rejected;
    const runtime = options.kimiQuotaRuntime;
    return runtime && typeof runtime.disconnect === "function"
      ? runtime.disconnect()
      : { status: "error", reason: "runtime-unavailable" };
  });
  handle("settings:kimi-quota-forget", (event) => {
    const rejected = rejectUntrustedSettingsEvent(event);
    if (rejected) return rejected;
    const runtime = options.kimiQuotaRuntime;
    return runtime && typeof runtime.forget === "function"
      ? runtime.forget()
      : { status: "error", reason: "runtime-unavailable" };
  });
  handle("settings:get-pet-tint-options", () => listPetTintOptions());
  handle("settings:get-pet-accessory-options", () => listPetAccessoryOptions());
  handle("settings:get-pet-mouth-accessory-options", () => listPetMouthAccessoryOptions());
  handle("settings:get-roam-fence", (event) => {
    const rejected = rejectUntrustedSettingsEvent(event);
    return rejected || roamFenceSettings.getStatus();
  });
  handle("settings:select-roam-fence", async (event) => {
    const rejected = rejectUntrustedSettingsEvent(event);
    if (rejected) return rejected;
    const picked = await roamFencePicker.selectArea({
      lang: getLang(),
    });
    if (!picked || picked.status !== "ok") return picked || { status: "cancel" };
    return roamFenceSettings.saveFence(picked.fence);
  });
  handle("settings:clear-roam-fence", (event) => {
    const rejected = rejectUntrustedSettingsEvent(event);
    return rejected || roamFenceSettings.clearFence();
  });
  handle("settings:update", (_event, payload) => {
    if (!payload || typeof payload !== "object") {
      return { status: "error", message: "settings:update payload must be { key, value }" };
    }
    if (payload.key === "tgMigration") {
      return { status: "error", message: "tgMigration is internal; use telegramMigration.dispatch" };
    }
    // Permission automation is command-only: the command enforces confirmed
    // transitions for both automatic modes at the data layer.
    if (
      payload.key === "permissionAutomationMode"
      || payload.key === "permissionAutomationAutoToolsWarningDismissed"
      || payload.key === "permissionAutomationUnattendedWarningDismissed"
      || payload.key === "autoApproveAllPermissions"
    ) {
      return {
        status: "error",
        message: "permission automation is gated; use the setPermissionAutomationMode command",
      };
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
  // Transient textScale preview while the slider drags: applies zoom to live
  // windows but never writes the store. Commit still goes through
  // settings:update so the controller stays the only writer.
  handle("settings:preview-text-scale", (_event, value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return { status: "error", message: `invalid text scale "${value}"` };
    }
    return previewTextScale(n);
  });
  handle("settings:end-text-scale-preview", () => endTextScalePreview());
  // textScale is per-display; the renderer can't resolve its own display, so
  // the slider asks main for the committed value of the display the settings
  // window currently sits on.
  handle("settings:get-text-scale-context", () => getTextScaleContext());
  handle("settings:get-preview-sound-url", () => {
    try { return themeLoader.getPreviewSoundUrl(); }
    catch { return null; }
  });
  handle("settings:command", async (event, payload) => {
    if (!payload || typeof payload !== "object") {
      return { status: "error", message: "settings:command payload must be { action, payload }" };
    }
    if (payload.action === "feishuApproval.saveApproverByEmail") {
      const rejected = rejectUntrustedSettingsEvent(event);
      if (rejected) return rejected;
      const email = payload.payload && typeof payload.payload === "object"
        ? payload.payload.email
        : undefined;
      return runFeishuApproverLookup(event, email);
    }
    if (payload.action === "feishuApproval.cancelApproverLookup") {
      const rejected = rejectUntrustedSettingsEvent(event);
      if (rejected) return rejected;
      abortCurrentFeishuApproverLookup("cancelled", event.sender);
      return { status: "ok" };
    }
    if (INTERNAL_SETTINGS_COMMANDS.has(payload.action)) {
      return { status: "error", message: `settings command "${payload.action}" is internal` };
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
    if (newUrl) {
      sendToRenderer("invalidate-sound-cache", newUrl);
      sendToRenderer("preload-sounds", { urls: [newUrl] });
    }
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
      return themeLoader.listThemesWithMetadata().map((theme) => {
        const active = theme.id === activeId;
        const runtimeCapabilities = active
          && activeTheme
          && isPlainObject(activeTheme._capabilities)
          ? activeTheme._capabilities
          : null;
        return codexPetMain.decorateThemeMetadata({
          ...theme,
          active,
          ...(runtimeCapabilities
            ? { capabilities: { ...(theme.capabilities || {}), ...runtimeCapabilities } }
            : {}),
        });
      });
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
      const snapshot = settingsController.getSnapshot();
      const custom = Array.isArray(snapshot.customApplications)
        ? snapshot.customApplications.map((application) => {
          const port = getHookServerPort();
          const stateEvents = getRecentHookEvents({ agentId: application.id })
            .filter((event) => event && event.route === "state" && event.outcome === "accepted");
          const lastStateEvent = stateEvents.length > 0 ? stateEvents[stateEvents.length - 1] : null;
          return mapCustomApplicationMetadata(application, {
            stateEndpoint: Number.isInteger(port) ? `http://127.0.0.1:${port}/state` : "",
            lastStateEvent: lastStateEvent
              ? { timestamp: lastStateEvent.timestamp, eventType: lastStateEvent.eventType }
              : null,
          });
        })
        : [];
      return [...getAllAgents().map(mapAgentMetadata), ...custom];
    } catch (err) {
      console.warn("Clawd: settings:list-agents failed:", err && err.message);
      return [];
    }
  });

  handle("settings:pick-agent-discovery-path", async (event, payload) => {
    const kind = payload && payload.kind;
    if (kind !== "file" && kind !== "directory") {
      return { status: "error", message: "pickAgentDiscoveryPath.kind must be file or directory" };
    }
    const lang = getLang();
    const strings = AGENT_DISCOVERY_DIALOG_STRINGS[lang] || AGENT_DISCOVERY_DIALOG_STRINGS.en;
    try {
      const result = await dialog.showOpenDialog(getDialogParent(event), {
        title: strings[kind],
        properties: [kind === "file" ? "openFile" : "openDirectory"],
      });
      if (!result || result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) {
        return { status: "cancel" };
      }
      return { status: "ok", path: result.filePaths[0] };
    } catch (err) {
      return { status: "error", message: `agent discovery path picker failed: ${err && err.message}` };
    }
  });

  handle("settings:detect-agent-installations", async (_ev, opts) => {
    try {
      const options = opts && typeof opts === "object" ? opts : {};
      const detectorOptions = { fs, path, now, snapshot: settingsController.getSnapshot() };
      if (options.refreshWsl) {
        const { refreshWslDetection } = require("./agent-installation-detector");
        await refreshWslDetection({ ...detectorOptions, skipDefaultIntegrations: false });
        return detectAgentInstallations(detectorOptions);
      }
      return detectAgentInstallations(detectorOptions);
    } catch (err) {
      console.warn("Clawd: settings:detect-agent-installations failed:", err && err.message);
      return {
        checkedAt: now(),
        agents: [],
        customAgents: [],
        customTools: [],
        skippedAgentIds: [],
        wslAgents: [],
        wslDistros: [],
        // Keep the manual Scan entry point alive even on a hard failure.
        wslSupported: process.platform === "win32",
        error: err && err.message ? err.message : String(err),
      };
    }
  });

  handle("settings:get-about-info", () => {
    let heroSvgContent = "";
    try {
      heroSvgContent = fs.readFileSync(aboutHeroSvgPath, "utf8");
    } catch (err) {
      console.warn("Clawd: failed to read about hero SVG:", err && err.message);
    }
    let pendingUpdateVersion = "";
    let autoUpdateCheck = true;
    try {
      pendingUpdateVersion = String(settingsController.get("pendingUpdateVersion") || "");
      autoUpdateCheck = settingsController.get("autoUpdateCheck") !== false;
    } catch {}
    return {
      version: app.getVersion(),
      repoUrl: "https://github.com/rullerzhou-afk/clawd-on-desk",
      license: "AGPL-3.0",
      copyright: "\u00a9 2026 Ruller_Lulu",
      authorName: "Ruller_Lulu / \u9e7f\u9e7f",
      authorUrl: "https://github.com/rullerzhou-afk",
      heroSvgContent,
      pendingUpdateVersion,
      autoUpdateCheck,
      updateCheckSnapshot: getUpdateCheckSnapshot(),
    };
  });

  handle("settings:check-for-updates", async () => {
    try {
      const snapshot = await checkForUpdates(true);
      return snapshot || getUpdateCheckSnapshot();
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  handle("settings:clear-update-error", () => clearUpdateError());

  handle("settings:copy-update-error", (_event, copyText) => {
    const boundedText = String(copyText == null ? "" : copyText).slice(0, 8 * 1024);
    if (!boundedText) return { status: "error", message: "empty update error report" };
    return copyUpdateError(boundedText);
  });

  handle("settings:show-tutorial", async () => {
    try {
      const result = await showTutorial();
      return result || { status: "ok" };
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

  handle("settings:mobile-connection-info", async () => {
    try {
      const lanWsServer = options.getLanWsServer ? options.getLanWsServer() : null;
      if (!lanWsServer) return { status: "error", message: "LAN bridge not available" };
      const port = lanWsServer.getPort();
      const tok = lanWsServer.getToken();
      if (!Number.isInteger(port) || port <= 0 || typeof tok !== "string" || !tok) {
        return { status: "starting", message: "LAN bridge is starting" };
      }
      const os = require("os");
      let lanIp = "127.0.0.1";
      const interfaces = os.networkInterfaces();
      const wlanPattern = /WLAN|Wi-?Fi|Wireless|无线/i;
      // 1) 优先找 WLAN 接口
      for (const name of Object.keys(interfaces)) {
        if (wlanPattern.test(name)) {
          for (const iface of interfaces[name]) {
            if (iface.family === "IPv4" && !iface.internal) { lanIp = iface.address; break; }
          }
          if (lanIp !== "127.0.0.1") break;
        }
      }
      // 2) fallback：第一个非 internal IPv4
      if (lanIp === "127.0.0.1") {
        for (const name of Object.keys(interfaces)) {
          for (const iface of interfaces[name]) {
            if (iface.family === "IPv4" && !iface.internal) { lanIp = iface.address; break; }
          }
          if (lanIp !== "127.0.0.1") break;
        }
      }
      const pairUrl = `http://${lanIp}:${port}/mobile/?host=${lanIp}&port=${port}&token=${tok}`;
      return { status: "ok", port, token: tok, lanIp, pairUrl };
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  handle("settings:regenerate-mobile-token", async () => {
    try {
      const lanWsServer = options.getLanWsServer ? options.getLanWsServer() : null;
      if (!lanWsServer) return { status: "error", message: "LAN bridge not available" };
      const newToken = lanWsServer.regenerateToken();
      return { status: "ok", token: newToken };
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  handle("settings:reset-mobile-access", async () => {
    try {
      const lanWsServer = options.getLanWsServer ? options.getLanWsServer() : null;
      if (!lanWsServer) return { status: "error", message: "LAN bridge not available" };
      const newToken = lanWsServer.resetMobileAccess();
      return { status: "ok", token: newToken };
    } catch (err) {
      return { status: "error", message: (err && err.message) || String(err) };
    }
  });

  return {
    dispose() {
      abortCurrentFeishuApproverLookup("destroyed");
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
