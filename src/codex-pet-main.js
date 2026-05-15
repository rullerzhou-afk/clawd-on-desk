"use strict";

const defaultFs = require("fs");
const defaultPath = require("path");
const { pathToFileURL } = require("url");

const defaultCodexPetAdapter = require("./codex-pet-adapter");
const defaultCodexPetImporter = require("./codex-pet-importer");

const REGISTER_PROTOCOL_DEV_ARG = "--register-protocol";
const CLAWD_PROTOCOL_SCHEME = "clawd";

function emptyCodexPetSyncSummary(overrides = {}) {
  return {
    codexPetsDir: "",
    userThemesDir: "",
    imported: 0,
    updated: 0,
    unchanged: 0,
    invalid: 0,
    removed: 0,
    activeOrphanThemeIds: [],
    themes: [],
    diagnostics: [],
    ...overrides,
  };
}

function mergeCodexPetSyncSummaries(base, extra) {
  const a = base || emptyCodexPetSyncSummary();
  const b = extra || emptyCodexPetSyncSummary();
  return {
    codexPetsDir: b.codexPetsDir || a.codexPetsDir || "",
    userThemesDir: b.userThemesDir || a.userThemesDir || "",
    imported: (a.imported || 0) + (b.imported || 0),
    updated: (a.updated || 0) + (b.updated || 0),
    unchanged: (a.unchanged || 0) + (b.unchanged || 0),
    invalid: (a.invalid || 0) + (b.invalid || 0),
    removed: (a.removed || 0) + (b.removed || 0),
    activeOrphanThemeIds: [
      ...new Set([
        ...((a.activeOrphanThemeIds || []).map(String)),
        ...((b.activeOrphanThemeIds || []).map(String)),
      ]),
    ],
    themes: [
      ...(Array.isArray(a.themes) ? a.themes : []),
      ...(Array.isArray(b.themes) ? b.themes : []),
    ],
    diagnostics: [
      ...(Array.isArray(a.diagnostics) ? a.diagnostics : []),
      ...(Array.isArray(b.diagnostics) ? b.diagnostics : []),
    ],
    error: a.error || b.error || null,
  };
}

function summaryHasActiveCodexPetOrphan(summary, themeId) {
  return !!(
    themeId
    && summary
    && Array.isArray(summary.activeOrphanThemeIds)
    && summary.activeOrphanThemeIds.includes(themeId)
  );
}

function sameFsPath(a, b, pathModule = defaultPath) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = pathModule.resolve(a);
  const right = pathModule.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isFsPathInsideDir(rootDir, candidatePath, pathModule = defaultPath) {
  if (typeof rootDir !== "string" || typeof candidatePath !== "string") return false;
  let root = pathModule.resolve(rootDir);
  let candidate = pathModule.resolve(candidatePath);
  if (process.platform === "win32") {
    root = root.toLowerCase();
    candidate = candidate.toLowerCase();
  }
  return candidate !== root && candidate.startsWith(root + pathModule.sep);
}

function extractClawdProtocolUrls(argv) {
  if (!Array.isArray(argv)) return [];
  return argv.filter((arg) => typeof arg === "string" && arg.toLowerCase().startsWith(`${CLAWD_PROTOCOL_SCHEME}:`));
}

function requiredDependency(value, name) {
  if (!value) throw new Error(`createCodexPetMain requires ${name}`);
  return value;
}

function createCodexPetMain(options = {}) {
  const app = requiredDependency(options.app, "app");
  const dialog = requiredDependency(options.dialog, "dialog");
  const shell = requiredDependency(options.shell, "shell");
  const themeLoader = requiredDependency(options.themeLoader, "themeLoader");
  const settingsController = requiredDependency(options.settingsController, "settingsController");
  const BrowserWindow = options.BrowserWindow || null;
  const fs = options.fs || defaultFs;
  const path = options.path || defaultPath;
  const codexPetAdapter = options.codexPetAdapter || defaultCodexPetAdapter;
  const codexPetImporter = options.codexPetImporter || defaultCodexPetImporter;

  const pendingImportUrls = [];
  let importFlushRunning = false;
  let lastSyncSummary = null;

  function getActiveThemeId() {
    const activeTheme = typeof options.getActiveTheme === "function" ? options.getActiveTheme() : null;
    return activeTheme ? activeTheme._id : (settingsController.get("theme") || "clawd");
  }

  function getDialogParent() {
    const settingsWindow = typeof options.getSettingsWindow === "function" ? options.getSettingsWindow() : null;
    if (settingsWindow && !settingsWindow.isDestroyed()) return settingsWindow;
    const mainWindow = typeof options.getMainWindow === "function" ? options.getMainWindow() : null;
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
    return null;
  }

  function rebuildMenusBestEffort(optionsForRebuild = {}) {
    if (typeof options.rebuildAllMenus !== "function") return;
    try {
      options.rebuildAllMenus();
    } catch (err) {
      if (optionsForRebuild.logFailure === false) return;
      console.warn("Clawd: rebuildAllMenus after Codex Pet refresh failed:", err && err.message);
    }
  }

  function getLang() {
    if (typeof options.getLang === "function") return options.getLang() || "en";
    return settingsController.get("lang") || "en";
  }

  function syncThemes(activeThemeId) {
    try {
      const summary = codexPetAdapter.syncCodexPetThemes({
        userDataDir: app.getPath("userData"),
        activeThemeId,
      });
      lastSyncSummary = summary;
      return summary;
    } catch (err) {
      const summary = emptyCodexPetSyncSummary({
        error: err && err.message ? err.message : String(err),
        diagnostics: [{ errors: [`failed to sync Codex Pet themes: ${err && err.message ? err.message : err}`] }],
      });
      lastSyncSummary = summary;
      console.warn("Clawd: failed to sync Codex Pet themes:", err && err.message);
      return summary;
    }
  }

  function setLastSyncSummary(summary) {
    lastSyncSummary = summary;
  }

  function getManagedThemeDir(themeId) {
    if (typeof themeId !== "string" || !themeId) return null;
    let userThemesDir;
    try {
      userThemesDir = themeLoader.ensureUserThemesDir();
    } catch {
      return null;
    }
    if (!userThemesDir) return null;
    const root = path.resolve(userThemesDir);
    const themeDir = path.resolve(path.join(userThemesDir, themeId));
    if (!isFsPathInsideDir(root, themeDir, path)) return null;
    return themeDir;
  }

  function readManagedThemeMarker(themeId) {
    const themeDir = getManagedThemeDir(themeId);
    if (!themeDir) return null;
    return codexPetAdapter.readManagedMarker(themeDir);
  }

  function getPreviewAtlasUrl(themeId, marker) {
    const themeDir = getManagedThemeDir(themeId);
    if (!themeDir || !marker || typeof marker.sourceSpritesheetPath !== "string") return null;
    const filename = path.basename(marker.sourceSpritesheetPath);
    if (!filename) return null;
    const assetsDir = path.resolve(path.join(themeDir, "assets"));
    const atlasPath = path.resolve(path.join(assetsDir, filename));
    if (!isFsPathInsideDir(assetsDir, atlasPath, path) || !fs.existsSync(atlasPath)) return null;
    try {
      return pathToFileURL(atlasPath).href;
    } catch {
      return null;
    }
  }

  function decorateThemeMetadata(theme) {
    const marker = theme && readManagedThemeMarker(theme.id);
    if (!marker) return theme;
    return {
      ...theme,
      managedCodexPet: true,
      codexPet: {
        sourcePetId: marker.sourcePetId || "",
        sourcePackagePath: marker.sourcePackagePath || "",
        previewAtlasUrl: getPreviewAtlasUrl(theme.id, marker),
        adapterVersion: marker.adapterVersion || 0,
      },
    };
  }

  async function refreshFromSettings() {
    const activeId = getActiveThemeId();
    let summary = syncThemes(activeId);
    let switchedToFallback = false;

    if (summary.error) {
      return { status: "error", message: summary.error, summary };
    }

    if (summaryHasActiveCodexPetOrphan(summary, activeId)) {
      const result = await settingsController.applyCommand("setThemeSelection", { themeId: "clawd" });
      if (!result || result.status !== "ok") {
        return {
          status: "error",
          message: (result && result.message) || "failed to switch active orphan Codex Pet theme back to clawd",
          summary,
        };
      }
      switchedToFallback = true;
      const cleanup = syncThemes("clawd");
      summary = mergeCodexPetSyncSummaries(summary, cleanup);
      lastSyncSummary = summary;
      if (cleanup.error) {
        return { status: "error", message: cleanup.error, summary, switchedToFallback };
      }
    }

    rebuildMenusBestEffort();
    return { status: "ok", summary, switchedToFallback };
  }

  function resolveRemovalTarget(themeId) {
    const marker = readManagedThemeMarker(themeId);
    if (!marker) {
      return { status: "error", message: "theme is not a managed Codex Pet" };
    }
    const petsRoot = path.resolve(codexPetImporter.getDefaultCodexPetsDir());
    const packageDir = path.resolve(marker.sourcePackagePath || "");
    if (!isFsPathInsideDir(petsRoot, packageDir, path) || !sameFsPath(path.dirname(packageDir), petsRoot, path)) {
      return { status: "error", message: "managed Codex Pet source path is outside the pets folder" };
    }
    return {
      status: "ok",
      marker,
      packageDir,
      exists: fs.existsSync(packageDir),
    };
  }

  function enqueueImportUrl(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl) return;
    pendingImportUrls.push(rawUrl);
    if (app.isReady()) {
      setImmediate(() => {
        flushPendingImportUrls().catch((err) => {
          console.warn("Clawd: Codex Pet import queue failed:", err && err.message);
        });
      });
    }
  }

  function enqueueImportUrlsFromArgv(argv) {
    for (const rawUrl of extractClawdProtocolUrls(argv)) {
      enqueueImportUrl(rawUrl);
    }
  }

  function registerProtocolClient() {
    try {
      if (app.isPackaged) {
        return app.setAsDefaultProtocolClient(CLAWD_PROTOCOL_SCHEME);
      }
      if (process.argv.includes(REGISTER_PROTOCOL_DEV_ARG) || process.env.CLAWD_REGISTER_PROTOCOL_DEV === "1") {
        const appRoot = path.resolve(__dirname, "..");
        return app.setAsDefaultProtocolClient(CLAWD_PROTOCOL_SCHEME, process.execPath, [appRoot]);
      }
    } catch (err) {
      console.warn("Clawd: failed to register clawd:// protocol:", err && err.message);
    }
    return false;
  }

  async function flushPendingImportUrls() {
    if (importFlushRunning) return;
    importFlushRunning = true;
    try {
      while (pendingImportUrls.length > 0) {
        const rawUrl = pendingImportUrls.shift();
        await handleImportProtocolUrl(rawUrl);
      }
    } finally {
      importFlushRunning = false;
    }
  }

  function getImportDialogStrings() {
    const all = {
      en: {
        import: "Import",
        cancel: "Cancel",
        ok: "OK",
        confirmMessage: (host) => `Import Codex Pet from ${host}?`,
        confirmDetail: (url) => `Clawd will download, validate, and install this pet package before switching to it.\n\n${url}`,
        replaceMessage: (name) => `Replace existing local pet "${name}"?`,
        replaceDetail: "A Codex Pet package with the same id already exists locally. Replacing it will overwrite that local package.",
        successMessage: (name) => `Imported "${name}"`,
        successDetail: "The imported Codex Pet is now active.",
        failedMessage: "Couldn't import Codex Pet",
      },
      zh: {
        import: "导入",
        cancel: "取消",
        ok: "确定",
        confirmMessage: (host) => `从 ${host} 导入 Codex Pet？`,
        confirmDetail: (url) => `Clawd 会先下载、校验并安装这个宠物包，然后切换到它。\n\n${url}`,
        replaceMessage: (name) => `替换已有本地宠物 "${name}"？`,
        replaceDetail: "本地已经有同 id 的 Codex Pet 包。继续会覆盖这个本地包。",
        successMessage: (name) => `已导入 "${name}"`,
        successDetail: "导入的 Codex Pet 已设为当前主题。",
        failedMessage: "导入 Codex Pet 失败",
      },
      "zh-TW": {
        import: "匯入",
        cancel: "取消",
        ok: "確定",
        confirmMessage: (host) => `從 ${host} 匯入 Codex Pet？`,
        confirmDetail: (url) => `Clawd 會先下載、驗證並安裝這個寵物套件，然後切換到它。\n\n${url}`,
        replaceMessage: (name) => `取代現有的本機寵物「${name}」？`,
        replaceDetail: "本機已經有相同 id 的 Codex Pet 套件。繼續會覆寫這個本機套件。",
        successMessage: (name) => `已匯入「${name}」`,
        successDetail: "匯入的 Codex Pet 已設為目前主題。",
        failedMessage: "匯入 Codex Pet 失敗",
      },
      ko: {
        import: "가져오기",
        cancel: "취소",
        ok: "확인",
        confirmMessage: (host) => `${host}에서 Codex Pet을 가져올까요?`,
        confirmDetail: (url) => `Clawd가 이 펫 패키지를 다운로드, 검증, 설치한 뒤 전환합니다.\n\n${url}`,
        replaceMessage: (name) => `기존 로컬 펫 "${name}"을(를) 교체할까요?`,
        replaceDetail: "같은 id의 Codex Pet 패키지가 이미 로컬에 있습니다. 계속하면 해당 로컬 패키지를 덮어씁니다.",
        successMessage: (name) => `"${name}"을(를) 가져왔습니다`,
        successDetail: "가져온 Codex Pet이 활성 테마로 설정되었습니다.",
        failedMessage: "Codex Pet을 가져오지 못했습니다",
      },
      ja: {
        import: "インポート",
        cancel: "キャンセル",
        ok: "OK",
        confirmMessage: (host) => `${host} から Codex Pet をインポートしますか？`,
        confirmDetail: (url) => `Clawd はこのペットパッケージをダウンロード、検証、インストールしてから切り替えます。\n\n${url}`,
        replaceMessage: (name) => `既存のローカルペット "${name}" を置き換えますか？`,
        replaceDetail: "同じ id の Codex Pet パッケージがローカルにあります。続行するとそのローカルパッケージを上書きします。",
        successMessage: (name) => `"${name}" をインポートしました`,
        successDetail: "インポートした Codex Pet を現在のテーマにしました。",
        failedMessage: "Codex Pet をインポートできませんでした",
      },
    };
    return all[getLang()] || all.en;
  }

  async function showImportError(message) {
    const s = getImportDialogStrings();
    try {
      await dialog.showMessageBox(getDialogParent(), {
        type: "error",
        buttons: [s.ok],
        message: s.failedMessage,
        detail: message || "unknown error",
        noLink: true,
      });
    } catch {}
  }

  async function confirmReplaceExistingPackage(payload) {
    const s = getImportDialogStrings();
    const existing = payload && payload.existingManifest;
    const incoming = payload && payload.incomingManifest;
    const displayName = (incoming && (incoming.displayName || incoming.id))
      || (existing && (existing.displayName || existing.id))
      || (payload && payload.packageName)
      || "Codex Pet";
    try {
      const { response } = await dialog.showMessageBox(getDialogParent(), {
        type: "warning",
        buttons: [s.import, s.cancel],
        defaultId: 1,
        cancelId: 1,
        message: s.replaceMessage(displayName),
        detail: s.replaceDetail,
        noLink: true,
      });
      return response === 0;
    } catch (err) {
      console.warn("Clawd: Codex Pet replace confirmation failed:", err && err.message);
      return false;
    }
  }

  function getRemovalDialogStrings() {
    const all = {
      en: {
        uninstall: "Uninstall",
        cancel: "Cancel",
        message: (name) => `Uninstall imported pet "${name}"?`,
        detail: "Clawd will remove the source package from your Codex pets folder and clean up the generated theme. This cannot be undone.",
      },
      zh: {
        uninstall: "卸载",
        cancel: "取消",
        message: (name) => `卸载导入宠物 "${name}"？`,
        detail: "Clawd 会从 Codex pets 文件夹删除源包，并清理生成的主题。此操作不可撤销。",
      },
      "zh-TW": {
        uninstall: "解除安裝",
        cancel: "取消",
        message: (name) => `解除安裝匯入的寵物「${name}」？`,
        detail: "Clawd 會從 Codex pets 資料夾移除來源套件，並清理產生的主題。此操作無法復原。",
      },
      ko: {
        uninstall: "제거",
        cancel: "취소",
        message: (name) => `가져온 펫 "${name}"을(를) 제거할까요?`,
        detail: "Clawd가 Codex pets 폴더의 원본 패키지를 제거하고 생성된 테마를 정리합니다. 이 작업은 되돌릴 수 없습니다.",
      },
      ja: {
        uninstall: "アンインストール",
        cancel: "キャンセル",
        message: (name) => `インポート済みペット "${name}" をアンインストールしますか？`,
        detail: "Clawd は Codex pets フォルダから元パッケージを削除し、生成されたテーマをクリーンアップします。この操作は元に戻せません。",
      },
    };
    return all[getLang()] || all.en;
  }

  async function confirmRemoveImportedPackage(displayName) {
    const s = getRemovalDialogStrings();
    try {
      const { response } = await dialog.showMessageBox(getDialogParent(), {
        type: "warning",
        buttons: [s.uninstall, s.cancel],
        defaultId: 1,
        cancelId: 1,
        message: s.message(displayName || "Codex Pet"),
        detail: s.detail,
        noLink: true,
      });
      return response === 0;
    } catch (err) {
      console.warn("Clawd: Codex Pet removal confirmation failed:", err && err.message);
      return false;
    }
  }

  async function materializeAndActivateImportedPet(imported) {
    const activeId = getActiveThemeId();
    const summary = syncThemes(activeId);
    if (summary.error) throw new Error(summary.error);
    const generated = (summary.themes || []).find((theme) => sameFsPath(theme.packageDir, imported.packageDir, path));
    if (!generated || !generated.themeId) {
      throw new Error("imported package did not materialize into a Clawd theme");
    }
    const result = await settingsController.applyCommand("setThemeSelection", { themeId: generated.themeId });
    if (!result || result.status !== "ok") {
      throw new Error((result && result.message) || "failed to switch to imported theme");
    }
    rebuildMenusBestEffort({ logFailure: false });
    return { themeId: generated.themeId, summary };
  }

  async function handleImportProtocolUrl(rawUrl) {
    let parsed;
    try {
      parsed = codexPetImporter.parseClawdImportUrl(rawUrl);
    } catch (err) {
      await showImportError(err && err.message);
      return;
    }

    const s = getImportDialogStrings();
    const parent = getDialogParent();
    try {
      const { response } = await dialog.showMessageBox(parent, {
        type: "question",
        buttons: [s.import, s.cancel],
        defaultId: 1,
        cancelId: 1,
        message: s.confirmMessage(parsed.asciiHostname),
        detail: s.confirmDetail(parsed.url),
        noLink: true,
      });
      if (response !== 0) return;
    } catch (err) {
      console.warn("Clawd: Codex Pet import confirmation failed:", err && err.message);
      return;
    }

    try {
      const imported = await codexPetImporter.importCodexPetFromUrl(parsed.url, {
        confirmReplaceExistingPackage: confirmReplaceExistingPackage,
      });
      await materializeAndActivateImportedPet(imported);
      await dialog.showMessageBox(parent, {
        type: "info",
        buttons: [s.ok],
        message: s.successMessage(imported.packageInfo.displayName || imported.packageInfo.id),
        detail: s.successDetail,
        noLink: true,
      });
    } catch (err) {
      if (err && err.code === codexPetImporter.ERR_REPLACE_DECLINED) return;
      console.warn("Clawd: Codex Pet import failed:", err && err.message);
      await showImportError(err && err.message);
    }
  }

  async function openCodexPetsDir() {
    try {
      const dir = codexPetImporter.getDefaultCodexPetsDir();
      fs.mkdirSync(dir, { recursive: true });
      const message = await shell.openPath(dir);
      if (message) return { status: "error", message };
      return { status: "ok", path: dir };
    } catch (err) {
      console.warn("Clawd: settings:open-codex-pets-dir failed:", err && err.message);
      return { status: "error", message: (err && err.message) || String(err) };
    }
  }

  async function importCodexPetZip(event) {
    const fromWebContents = BrowserWindow
      && typeof BrowserWindow.fromWebContents === "function"
      && event
      && event.sender
      ? BrowserWindow.fromWebContents(event.sender)
      : null;
    const parent = fromWebContents || getDialogParent();
    let picked;
    try {
      picked = await dialog.showOpenDialog(parent, {
        properties: ["openFile"],
        filters: [
          { name: "Codex Pet zip", extensions: ["zip"] },
        ],
      });
    } catch (err) {
      console.warn("Clawd: Codex Pet zip picker failed:", err && err.message);
      return { status: "error", message: (err && err.message) || String(err) };
    }
    if (!picked || picked.canceled || !Array.isArray(picked.filePaths) || !picked.filePaths[0]) {
      return { status: "cancel" };
    }

    try {
      const zipPath = picked.filePaths[0];
      const stat = await fs.promises.stat(zipPath);
      if (stat.size > codexPetImporter.MAX_ZIP_BYTES) {
        throw new Error(`zip package exceeds ${codexPetImporter.MAX_ZIP_BYTES} bytes`);
      }
      const imported = await codexPetImporter.importCodexPetFromZipBuffer(await fs.promises.readFile(zipPath), {
        confirmReplaceExistingPackage: confirmReplaceExistingPackage,
      });
      const activated = await materializeAndActivateImportedPet(imported);
      return {
        status: "ok",
        themeId: activated.themeId,
        summary: activated.summary,
        imported: {
          id: imported.packageInfo.id,
          displayName: imported.packageInfo.displayName,
        },
      };
    } catch (err) {
      if (err && err.code === codexPetImporter.ERR_REPLACE_DECLINED) return { status: "cancel" };
      console.warn("Clawd: Codex Pet zip import failed:", err && err.message);
      return { status: "error", message: (err && err.message) || String(err) };
    }
  }

  async function removeCodexPet(themeId) {
    if (typeof themeId !== "string" || !themeId) return { status: "error", message: "themeId is required" };
    const target = resolveRemovalTarget(themeId);
    if (!target || target.status !== "ok") {
      return { status: "error", message: (target && target.message) || "could not resolve imported pet" };
    }

    const meta = themeLoader.getThemeMetadata(themeId) || {};
    const displayName = typeof meta.name === "string" && meta.name
      ? meta.name
      : (target.marker.sourcePetId || themeId);

    try {
      if (target.exists) {
        const stat = await fs.promises.lstat(target.packageDir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error("managed Codex Pet source is not a plain directory");
        }
        try {
          await fs.promises.access(path.join(target.packageDir, "pet.json"), fs.constants.F_OK);
        } catch {
          throw new Error("managed Codex Pet source no longer contains pet.json; refresh imported pets instead");
        }
        const confirmed = await confirmRemoveImportedPackage(displayName);
        if (!confirmed) return { status: "cancel" };
        await fs.promises.rm(target.packageDir, { recursive: true, force: true });
      }

      const refresh = await refreshFromSettings();
      if (!refresh || refresh.status !== "ok") {
        return {
          status: "error",
          message: (refresh && refresh.message) || "removed package but failed to refresh imported pets",
          summary: refresh && refresh.summary,
        };
      }
      return {
        status: "ok",
        removed: {
          id: target.marker.sourcePetId || "",
          displayName,
        },
        summary: refresh.summary,
        switchedToFallback: !!refresh.switchedToFallback,
      };
    } catch (err) {
      console.warn("Clawd: Codex Pet removal failed:", err && err.message);
      return { status: "error", message: (err && err.message) || String(err) };
    }
  }

  return {
    REGISTER_PROTOCOL_DEV_ARG,
    CLAWD_PROTOCOL_SCHEME,
    decorateThemeMetadata,
    enqueueImportUrl,
    enqueueImportUrlsFromArgv,
    extractClawdProtocolUrls,
    flushPendingImportUrls,
    getLastSyncSummary: () => lastSyncSummary,
    importCodexPetZip,
    isManagedTheme: (themeId) => !!readManagedThemeMarker(themeId),
    mergeSyncSummaries: mergeCodexPetSyncSummaries,
    openCodexPetsDir,
    readManagedThemeMarker,
    refreshFromSettings,
    registerProtocolClient,
    removeCodexPet,
    resolveRemovalTarget,
    setLastSyncSummary,
    summaryHasActiveOrphan: summaryHasActiveCodexPetOrphan,
    syncThemes,
  };
}

module.exports = createCodexPetMain;
module.exports.REGISTER_PROTOCOL_DEV_ARG = REGISTER_PROTOCOL_DEV_ARG;
module.exports.CLAWD_PROTOCOL_SCHEME = CLAWD_PROTOCOL_SCHEME;
module.exports.__test = {
  emptyCodexPetSyncSummary,
  extractClawdProtocolUrls,
  isFsPathInsideDir,
  mergeCodexPetSyncSummaries,
  sameFsPath,
  summaryHasActiveCodexPetOrphan,
};
