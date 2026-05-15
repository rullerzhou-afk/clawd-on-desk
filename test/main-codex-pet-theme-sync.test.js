const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MAIN = path.join(ROOT, "src", "main.js");
const CODEX_PET_MAIN = path.join(ROOT, "src", "codex-pet-main.js");
const SETTINGS_IPC = path.join(ROOT, "src", "settings-ipc.js");
const PRELOAD_SETTINGS = path.join(ROOT, "src", "preload-settings.js");
const SETTINGS_ACTIONS = path.join(ROOT, "src", "settings-actions.js");
const SETTINGS_TAB_THEME = path.join(ROOT, "src", "settings-tab-theme.js");

test("main syncs Codex Pet themes before the first theme load", () => {
  const source = fs.readFileSync(MAIN, "utf8");
  const runtimeSource = fs.readFileSync(CODEX_PET_MAIN, "utf8");
  const syncIdx = source.indexOf("let _startupCodexPetSyncSummary = codexPetMain.syncThemes(_requestedThemeId);");
  const loadIdx = source.indexOf("const _loadedStartupTheme = themeRuntime.loadInitialTheme(_requestedThemeId");

  assert.ok(source.includes('const createCodexPetMain = require("./codex-pet-main");'));
  assert.ok(source.includes("codexPetMain = createCodexPetMain({"));
  assert.ok(runtimeSource.includes('const defaultCodexPetAdapter = require("./codex-pet-adapter");'));
  assert.ok(syncIdx >= 0, "startup Codex Pet sync should be present");
  assert.ok(loadIdx >= 0, "initial theme load should be present");
  assert.ok(syncIdx < loadIdx, "Codex Pet sync must run before loading the selected theme");
  assert.ok(source.includes("codexPetMain.summaryHasActiveOrphan(_startupCodexPetSyncSummary, _requestedThemeId)"));
  assert.ok(source.includes('theme: _requestedThemeId,'));
});

test("main falls back before startup theme load when active Codex Pet theme is orphaned", () => {
  const source = fs.readFileSync(MAIN, "utf8");
  const orphanCheckIdx = source.indexOf("codexPetMain.summaryHasActiveOrphan(_startupCodexPetSyncSummary, _requestedThemeId)");
  const hydrateIdx = source.indexOf("themeOverrides: nextOverrides,", orphanCheckIdx);
  const loadIdx = source.indexOf("const _loadedStartupTheme = themeRuntime.loadInitialTheme(_requestedThemeId");

  assert.ok(orphanCheckIdx >= 0, "active-orphan check should be present");
  assert.ok(hydrateIdx > orphanCheckIdx, "orphan fallback should hydrate cleaned prefs");
  assert.ok(loadIdx > hydrateIdx, "startup theme load should happen after orphan fallback");
  assert.ok(source.includes("delete nextVariantMap[orphanThemeId];"));
  assert.ok(source.includes("delete nextOverrides[orphanThemeId];"));
  assert.ok(source.includes('_requestedThemeId = "clawd";'));
  assert.ok(source.includes("codexPetMain.setLastSyncSummary(_startupCodexPetSyncSummary);"));
});

test("settings exposes Codex Pet refresh and managed theme metadata", () => {
  const settingsIpcSource = fs.readFileSync(SETTINGS_IPC, "utf8");
  const runtimeSource = fs.readFileSync(CODEX_PET_MAIN, "utf8");
  const preloadSource = fs.readFileSync(PRELOAD_SETTINGS, "utf8");
  const tabSource = fs.readFileSync(SETTINGS_TAB_THEME, "utf8");

  assert.ok(settingsIpcSource.includes('handle("settings:refresh-codex-pets"'));
  assert.ok(settingsIpcSource.includes('handle("settings:import-user-theme-zip"'));
  assert.ok(settingsIpcSource.includes('handle("settings:open-codex-pets-dir"'));
  assert.ok(settingsIpcSource.includes('handle("settings:import-codex-pet-zip"'));
  assert.ok(settingsIpcSource.includes('handle("settings:remove-codex-pet"'));
  assert.ok(settingsIpcSource.includes("codexPetMain.refreshFromSettings()"));
  assert.ok(settingsIpcSource.includes("codexPetMain.openCodexPetsDir()"));
  assert.ok(settingsIpcSource.includes("codexPetMain.importCodexPetZip(event)"));
  assert.ok(settingsIpcSource.includes("codexPetMain.removeCodexPet(themeId)"));
  assert.ok(settingsIpcSource.includes("codexPetMain.decorateThemeMetadata({"));
  assert.ok(runtimeSource.includes("codexPetImporter.importCodexPetFromZipBuffer"));
  assert.ok(runtimeSource.includes("fs.promises.readFile(zipPath)"));
  assert.ok(runtimeSource.includes("function resolveRemovalTarget(themeId)"));
  assert.ok(runtimeSource.includes("fs.promises.rm(target.packageDir"));
  assert.ok(runtimeSource.includes("managedCodexPet: true"));
  assert.ok(runtimeSource.includes("function getPreviewAtlasUrl"));
  assert.ok(runtimeSource.includes("previewAtlasUrl: getPreviewAtlasUrl(theme.id, marker)"));
  assert.ok(runtimeSource.includes("unchanged: (a.unchanged || 0) + (b.unchanged || 0)"));
  assert.ok(preloadSource.includes('refreshCodexPets: () => ipcRenderer.invoke("settings:refresh-codex-pets")'));
  assert.ok(preloadSource.includes('openUserThemesDir: () => ipcRenderer.invoke("settings:open-user-themes-dir")'));
  assert.ok(preloadSource.includes('importUserThemeZip: () => ipcRenderer.invoke("settings:import-user-theme-zip")'));
  assert.ok(preloadSource.includes('openCodexPetsDir: () => ipcRenderer.invoke("settings:open-codex-pets-dir")'));
  assert.ok(preloadSource.includes('importCodexPetZip: () => ipcRenderer.invoke("settings:import-codex-pet-zip")'));
  assert.ok(preloadSource.includes('removeCodexPet: (themeId) => ipcRenderer.invoke("settings:remove-codex-pet", themeId)'));
  assert.ok(tabSource.includes("theme.managedCodexPet"));
  assert.ok(tabSource.includes("themeRefreshImportedPets"));
  assert.ok(tabSource.includes("themeImportPetZip"));
  assert.ok(tabSource.includes("themeImportUserThemeZip"));
  assert.ok(!tabSource.includes("themeOpenCodexPetsFolder"));
  assert.ok(tabSource.includes("themeActionGroupUserThemes"));
  assert.ok(tabSource.includes("themeOpenUserThemesFolder"));
  assert.ok(tabSource.includes("handleRefreshThemes"));
  assert.ok(tabSource.includes("themeUninstallPetLabel"));
  assert.ok(tabSource.includes("handleRemoveCodexPet"));
  assert.ok(tabSource.includes("getThemeSections"));
  assert.ok(tabSource.includes("themeGroupImportedCodexPets"));
});

test("managed Codex Pet themes cannot be removed through the user-theme delete command", () => {
  const mainSource = fs.readFileSync(MAIN, "utf8");
  const themeRuntimeSource = fs.readFileSync(path.join(ROOT, "src", "theme-runtime.js"), "utf8");
  const actionsSource = fs.readFileSync(SETTINGS_ACTIONS, "utf8");

  assert.ok(mainSource.includes("isManagedTheme: (themeId) => codexPetMain && codexPetMain.isManagedTheme(themeId)"));
  assert.ok(themeRuntimeSource.includes("managedCodexPet: isManagedTheme(themeId)"));
  assert.ok(actionsSource.includes("info.managedCodexPet"));
  assert.ok(actionsSource.includes("remove it from Petdex instead"));
});
