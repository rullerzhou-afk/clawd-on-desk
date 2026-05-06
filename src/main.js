const { app, BrowserWindow, screen, ipcMain, globalShortcut, nativeTheme, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const { applyStationaryCollectionBehavior } = require("./mac-window");
const {
  applyWindowsAppUserModelId,
  getSettingsWindowIconPath,
  getSettingsWindowTaskbarDetails: getSettingsWindowTaskbarDetailsHelper,
  shouldOpenSettingsWindowFromArgv,
  SETTINGS_WINDOW_TITLE,
} = require("./settings-window-icon");
const {
  createSettingsSizePreviewSession,
} = require("./settings-size-preview-session");
const hitGeometry = require("./hit-geometry");
const animationCycle = require("./animation-cycle");
const {
  findNearestWorkArea,
  computeLooseClamp,
  getDisplayInsets,
  buildDisplaySnapshot,
  findMatchingDisplay,
  isPointInAnyWorkArea,
  SYNTHETIC_WORK_AREA,
} = require("./work-area");
const {
  getThemeMarginBox,
  computeThemeAnchorRect,
  computeStableVisibleContentMargins,
  getLooseDragMargins,
  getRestClampMargins,
} = require("./visible-margins");
const {
  createDragSnapshot,
  computeAnchoredDragBounds,
  computeFinalDragBounds,
  needsFinalClampAdjustment,
  materializeVirtualBounds,
} = require("./drag-position");
const {
  getLaunchPixelSize,
  getLaunchSizingWorkArea,
  getProportionalPixelSize,
} = require("./size-utils");
const { keepOutOfTaskbar } = require("./taskbar");
const {
  animateWindowOpacity,
  setWindowOpacity,
} = require("./window-opacity-transition");

// ── Autoplay policy: allow sound playback without user gesture ──
// MUST be set before any BrowserWindow is created (before app.whenReady)
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
const isWin = process.platform === "win32";
const LINUX_WINDOW_TYPE = "toolbar";
const THEME_SWITCH_FADE_OUT_MS = 140;
const THEME_SWITCH_FADE_IN_MS = 180;
const THEME_SWITCH_FADE_FALLBACK_MS = 4000;

applyWindowsAppUserModelId(app, process.platform);


// ── Windows: AllowSetForegroundWindow via FFI ──
let _allowSetForeground = null;
if (isWin) {
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    _allowSetForeground = user32.func("bool __stdcall AllowSetForegroundWindow(int dwProcessId)");
  } catch (err) {
    console.warn("Clawd: koffi/AllowSetForegroundWindow not available:", err.message);
  }
}


// ── Window size presets ──
const SIZES = {
  S: { width: 200, height: 200 },
  M: { width: 280, height: 280 },
  L: { width: 360, height: 360 },
};

// ── Settings (prefs.js + settings-controller.js) ──
//
// `prefs.js` handles disk I/O + schema validation + migrations.
// `settings-controller.js` is the single writer of the in-memory snapshot.
// Module-level `lang`/`showTray`/etc. below are mirror caches kept in sync via
// a subscriber wired after menu.js loads. The ctx setters route writes through
// `_settingsController.applyUpdate()`, which auto-persists.
const prefsModule = require("./prefs");
const { createSettingsController } = require("./settings-controller");
const { ANIMATION_OVERRIDES_EXPORT_VERSION } = require("./settings-actions");
const { createTranslator, i18n } = require("./i18n");
const {
  getBubblePolicy,
  isAllBubblesHidden,
} = require("./bubble-policy");
const {
  SHORTCUT_ACTIONS,
  SHORTCUT_ACTION_IDS,
} = require("./shortcut-actions");
const loginItemHelpers = require("./login-item");
const PREFS_PATH = path.join(app.getPath("userData"), "clawd-prefs.json");
const _initialPrefsLoad = prefsModule.load(PREFS_PATH);

// Lazy helpers — these run inside the action `effect` callbacks at click time,
// long after server.js / hooks/install.js are loaded. Wrapping them in closures
// avoids a chicken-and-egg require order at module load.
function _installAutoStartHook() {
  const { registerHooks } = require("../hooks/install.js");
  registerHooks({ silent: true, autoStart: true, port: getHookServerPort() });
}
function _uninstallAutoStartHook() {
  const { unregisterAutoStart } = require("../hooks/install.js");
  unregisterAutoStart();
}
async function _uninstallClaudeHooksNow() {
  const { unregisterHooksAsync } = require("../hooks/install.js");
  await unregisterHooksAsync();
}

// Cross-platform "open at login" writer used by both the openAtLogin effect
// and the startup hydration helper. Throws on failure so the action layer can
// surface the error to the UI.
function _writeSystemOpenAtLogin(enabled) {
  if (isLinux) {
    const launchScript = path.join(__dirname, "..", "launch.js");
    const execCmd = app.isPackaged
      ? `"${process.env.APPIMAGE || app.getPath("exe")}"`
      : `node "${launchScript}"`;
    loginItemHelpers.linuxSetOpenAtLogin(enabled, { execCmd });
    return;
  }
  app.setLoginItemSettings(
    loginItemHelpers.getLoginItemSettings({
      isPackaged: app.isPackaged,
      openAtLogin: enabled,
      execPath: process.execPath,
      appPath: app.getAppPath(),
    })
  );
}
function _readSystemOpenAtLogin() {
  if (isLinux) return loginItemHelpers.linuxGetOpenAtLogin();
  return app.getLoginItemSettings(
    app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] }
  ).openAtLogin;
}

// Forward declarations — these are defined later in the file but the
// controller's injectedDeps need to resolve them lazily. Using a function
// wrapper lets us bind them after module scope finishes without a second
// `setDeps()` API on the controller.
function _deferredStartMonitorForAgent(id) {
  return startMonitorForAgent(id);
}
function _deferredStopMonitorForAgent(id) {
  return stopMonitorForAgent(id);
}
function _deferredSyncIntegrationForAgent(id) {
  return _server && typeof _server.syncIntegrationForAgent === "function"
    ? _server.syncIntegrationForAgent(id)
    : false;
}
function _deferredRepairIntegrationForAgent(id, options) {
  return _server && typeof _server.repairIntegrationForAgent === "function"
    ? _server.repairIntegrationForAgent(id, options)
    : false;
}
function _deferredStopIntegrationForAgent(id) {
  return _server && typeof _server.stopIntegrationForAgent === "function"
    ? _server.stopIntegrationForAgent(id)
    : false;
}
function _deferredClearSessionsByAgent(id) {
  return _state && typeof _state.clearSessionsByAgent === "function"
    ? _state.clearSessionsByAgent(id)
    : 0;
}
function _deferredDismissPermissionsByAgent(id) {
  const removed = _perm && typeof _perm.dismissPermissionsByAgent === "function"
    ? _perm.dismissPermissionsByAgent(id)
    : 0;
  // Symmetric cleanup for Kimi's state.js animation lock: dismissing the
  // passive bubble alone would leave `kimiPermissionHolds` pinning
  // notification forever with nothing actionable (same class of bug we
  // already fixed for DND). Kimi is the only agent with a state-side
  // permission lock today, so scope the extra work to it.
  if (id === "kimi-cli" && _state && typeof _state.disposeAllKimiPermissionState === "function") {
    const disposed = _state.disposeAllKimiPermissionState();
    if (disposed && typeof _state.resolveDisplayState === "function" && typeof _state.setState === "function") {
      const resolved = _state.resolveDisplayState();
      _state.setState(resolved, _state.getSvgOverride ? _state.getSvgOverride(resolved) : undefined);
    }
  }
  return removed;
}
function _deferredResizePet(sizeKey) {
  // Bound to _menu.resizeWindow after menu module is created below. Settings
  // panel's size slider commands route through here so they get the same
  // window resize + hitWin sync + bubble reposition as the context menu.
  if (_menu && typeof _menu.resizeWindow === "function") {
    _menu.resizeWindow(sizeKey);
  }
}

let _restartScheduled = false;
function _restartClawdNow() {
  if (_restartScheduled) return;
  _restartScheduled = true;
  // Triggered by Doctor's restart-clawd repair. relaunch() queues a fresh
  // process; quit() then follows the normal shutdown path so before-quit
  // still flushes prefs and cleans up server/monitor resources.
  // setImmediate so the IPC reply for repairDoctorIssue lands in the
  // renderer before the main process starts closing windows.
  setImmediate(() => {
    isQuitting = true;
    app.relaunch();
    app.quit();
  });
}

const _settingsController = createSettingsController({
  prefsPath: PREFS_PATH,
  loadResult: _initialPrefsLoad,
  injectedDeps: {
    installAutoStart: _installAutoStartHook,
    uninstallAutoStart: _uninstallAutoStartHook,
    syncClaudeHooksNow: () => {
      const { registerHooksAsync } = require("../hooks/install.js");
      return registerHooksAsync({ silent: true, autoStart: autoStartWithClaude, port: getHookServerPort() });
    },
    uninstallClaudeHooksNow: _uninstallClaudeHooksNow,
    startClaudeSettingsWatcher: () => _server.startClaudeSettingsWatcher(),
    stopClaudeSettingsWatcher: () => _server.stopClaudeSettingsWatcher(),
    setOpenAtLogin: _writeSystemOpenAtLogin,
    startMonitorForAgent: _deferredStartMonitorForAgent,
    stopMonitorForAgent: _deferredStopMonitorForAgent,
    syncIntegrationForAgent: _deferredSyncIntegrationForAgent,
    repairIntegrationForAgent: _deferredRepairIntegrationForAgent,
    stopIntegrationForAgent: _deferredStopIntegrationForAgent,
    repairLocalServer: () => _server && typeof _server.repairRuntimeStatus === "function"
      ? _server.repairRuntimeStatus()
      : false,
    restartClawd: _restartClawdNow,
    clearSessionsByAgent: _deferredClearSessionsByAgent,
    dismissPermissionsByAgent: _deferredDismissPermissionsByAgent,
    resizePet: _deferredResizePet,
    getActiveSessionAliasKeys: () =>
      _state && typeof _state.getActiveSessionAliasKeys === "function"
        ? _state.getActiveSessionAliasKeys()
        : new Set(),
    // Theme deps — defined much later in the file, wrapped in lazy closures.
    // activateTheme accepts (themeId, variantId?, overrideMap?) and returns
    // { themeId, variantId } with the actually-resolved variantId
    // (lenient fallback on unknown variants).
    activateTheme: (id, variantId, overrideMap) => _deferredActivateTheme(id, variantId, overrideMap),
    getThemeInfo: (id) => _deferredGetThemeInfo(id),
    removeThemeDir: (id) => _deferredRemoveThemeDir(id),
    globalShortcut,
    shortcutHandlers: {
      togglePet: () => togglePetVisibility(),
    },
    getShortcutFailure: (actionId) => getShortcutFailure(actionId),
    clearShortcutFailure: (actionId) => clearShortcutFailure(actionId),
  },
});

// Mirror of `_settingsController.get("lang")` so existing sync read sites in
// menu.js / state.js / etc. don't have to round-trip through the controller.
// Updated by the subscriber in `wireSettingsSubscribers()` below — never
// assign directly.
let lang = _settingsController.get("lang");
const translate = createTranslator(() => lang);

function getDashboardI18nPayload() {
  const dict = i18n[lang] || i18n.en;
  return { lang, translations: { ...dict } };
}

// First-run import of system-backed settings into prefs. The actual truth for
// `openAtLogin` lives in OS login items / autostart files; if we just trusted
// the schema default (false), an upgrading user with login-startup already
// enabled would silently lose it the first time prefs is saved. So on first
// boot after this field exists in the schema, copy the system value INTO prefs
// and mark it hydrated. After that, prefs is the source of truth and the
// openAtLogin pre-commit gate handles future writes back to the system.
//
// MUST run inside app.whenReady() — Electron's app.getLoginItemSettings() is
// only stable after the app is ready. MUST run before createWindow() so the
// first menu render reads the hydrated value.
function hydrateSystemBackedSettings() {
  if (_settingsController.get("openAtLoginHydrated")) return;
  let systemValue = false;
  try {
    systemValue = !!_readSystemOpenAtLogin();
  } catch (err) {
    console.warn("Clawd: failed to read system openAtLogin during hydration:", err && err.message);
  }
  const result = _settingsController.hydrate({
    openAtLogin: systemValue,
    openAtLoginHydrated: true,
  });
  if (result && result.status === "error") {
    console.warn("Clawd: openAtLogin hydration failed:", result.message);
  }
}

// Capture window/mini runtime state into the controller and write to disk.
// Replaces the legacy `savePrefs()` callsites — they used to read fresh
// `win.getBounds()` and `_mini.*` at save time, so we mirror that here.
function flushRuntimeStateToPrefs() {
  if (!win || win.isDestroyed()) return;
  const bounds = getPetWindowBounds();
  _settingsController.applyBulk({
    x: bounds.x,
    y: bounds.y,
    positionSaved: true,
    positionThemeId: activeTheme ? activeTheme._id : "",
    positionVariantId: activeTheme ? activeTheme._variantId : "",
    positionDisplay: captureCurrentDisplaySnapshot(bounds),
    savedPixelWidth: bounds.width,
    savedPixelHeight: bounds.height,
    size: currentSize,
    miniMode: _mini.getMiniMode(),
    miniEdge: _mini.getMiniEdge(),
    preMiniX: _mini.getPreMiniX(),
    preMiniY: _mini.getPreMiniY(),
  });
}

// Snapshot the display the pet is currently on so the next launch can tell
// whether the same physical monitor is still attached (see startup regularize
// logic below). Returns null if screen.* is unavailable — any truthy snapshot
// here unlocks the "trust saved position" path, so we fail closed.
function captureCurrentDisplaySnapshot(bounds) {
  try {
    const display = screen.getDisplayNearestPoint({
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
    });
    return buildDisplaySnapshot(display);
  } catch {
    return null;
  }
}

const CodexSubagentClassifier = require("../agents/codex-subagent-classifier");
const {
  buildCodexMonitorUpdateOptions,
  isCodexMonitorPermissionEvent,
} = require("./codex-monitor-callback");
const _codexSubagentClassifier = new CodexSubagentClassifier();
let _codexMonitor = null;          // Codex CLI JSONL log polling instance
const CODEX_OFFICIAL_LOG_SUPPRESS_TTL_MS = 10 * 60 * 1000;
const CODEX_LOG_EVENTS_COVERED_BY_OFFICIAL_HOOKS = new Set([
  "session_meta",
  "event_msg:task_started",
  "event_msg:user_message",
  "event_msg:guardian_assessment",
  "response_item:function_call",
  "response_item:custom_tool_call",
  "event_msg:exec_command_end",
  "event_msg:patch_apply_end",
  "event_msg:custom_tool_call_output",
  "event_msg:task_complete",
]);
const codexOfficialHookSessions = new Map();

function markCodexOfficialHookSession(sessionId) {
  if (!sessionId) return;
  codexOfficialHookSessions.set(String(sessionId), Date.now());
}

function hasRecentCodexOfficialHookSession(sessionId) {
  const lastHookAt = codexOfficialHookSessions.get(String(sessionId));
  if (!lastHookAt) return false;
  if (Date.now() - lastHookAt > CODEX_OFFICIAL_LOG_SUPPRESS_TTL_MS) {
    codexOfficialHookSessions.delete(String(sessionId));
    return false;
  }
  return true;
}

function shouldSuppressCodexLogEvent(sessionId, state, event) {
  // P2: official PermissionRequest owns the interactive bubble. Drop the
  // legacy JSONL codex-permission notification for hook-active sessions so the
  // user does not see both the real approval bubble and the old "Got it" hint.
  if (state === "codex-permission") return hasRecentCodexOfficialHookSession(sessionId);
  if (!CODEX_LOG_EVENTS_COVERED_BY_OFFICIAL_HOOKS.has(event)) return false;
  return hasRecentCodexOfficialHookSession(sessionId);
}

function updateSessionFromServer(sessionId, state, event, opts = {}) {
  if (opts && opts.agentId === "codex" && opts.hookSource === "codex-official") {
    markCodexOfficialHookSession(sessionId);
  }
  return updateSession(sessionId, state, event, opts);
}

// Hook-based agents have no module-level monitor — they're gated at the
// HTTP route layer. Only log-poll agents hit these branches.
function startMonitorForAgent(agentId) {
  if (agentId === "codex" && _codexMonitor) _codexMonitor.start();
}
function stopMonitorForAgent(agentId) {
  if (agentId === "codex" && _codexMonitor) _codexMonitor.stop();
}

function safeConsoleError(...args) {
  try {
    console.error(...args);
  } catch (err) {
    try {
      const line = `${new Date().toISOString()} ${args.map((x) => String(x)).join(" ")}\n`;
      fs.appendFileSync(path.join(app.getPath("userData"), "clawd-main.log"), line);
    } catch {}
  }
}

// ── Theme loader ──
const themeLoader = require("./theme-loader");
const codexPetAdapter = require("./codex-pet-adapter");
const codexPetImporter = require("./codex-pet-importer");
const { isPlainObject: _isPlainObject } = themeLoader;
themeLoader.init(__dirname, app.getPath("userData"));

let _lastCodexPetSyncSummary = null;
const REGISTER_PROTOCOL_DEV_ARG = "--register-protocol";
const CLAWD_PROTOCOL_SCHEME = "clawd";
const _pendingCodexPetImportUrls = [];
let _codexPetImportFlushRunning = false;

function _emptyCodexPetSyncSummary(overrides = {}) {
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
function _mergeCodexPetSyncSummaries(base, extra) {
  const a = base || _emptyCodexPetSyncSummary();
  const b = extra || _emptyCodexPetSyncSummary();
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
function _syncCodexPetThemesForMain(activeThemeId) {
  try {
    const summary = codexPetAdapter.syncCodexPetThemes({
      userDataDir: app.getPath("userData"),
      activeThemeId,
    });
    _lastCodexPetSyncSummary = summary;
    return summary;
  } catch (err) {
    const summary = _emptyCodexPetSyncSummary({
      error: err && err.message ? err.message : String(err),
      diagnostics: [{ errors: [`failed to sync Codex Pet themes: ${err && err.message ? err.message : err}`] }],
    });
    _lastCodexPetSyncSummary = summary;
    console.warn("Clawd: failed to sync Codex Pet themes:", err && err.message);
    return summary;
  }
}
function _summaryHasActiveCodexPetOrphan(summary, themeId) {
  return !!(
    themeId
    && summary
    && Array.isArray(summary.activeOrphanThemeIds)
    && summary.activeOrphanThemeIds.includes(themeId)
  );
}
function _sameFsPath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function _isFsPathInsideDir(rootDir, candidatePath) {
  if (typeof rootDir !== "string" || typeof candidatePath !== "string") return false;
  let root = path.resolve(rootDir);
  let candidate = path.resolve(candidatePath);
  if (process.platform === "win32") {
    root = root.toLowerCase();
    candidate = candidate.toLowerCase();
  }
  return candidate !== root && candidate.startsWith(root + path.sep);
}
function _getCodexPetManagedThemeDir(themeId) {
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
  if (!_isFsPathInsideDir(root, themeDir)) return null;
  return themeDir;
}
function _readCodexPetManagedThemeMarker(themeId) {
  const themeDir = _getCodexPetManagedThemeDir(themeId);
  if (!themeDir) return null;
  return codexPetAdapter.readManagedMarker(themeDir);
}
function _getCodexPetPreviewAtlasUrl(themeId, marker) {
  const themeDir = _getCodexPetManagedThemeDir(themeId);
  if (!themeDir || !marker || typeof marker.sourceSpritesheetPath !== "string") return null;
  const filename = path.basename(marker.sourceSpritesheetPath);
  if (!filename) return null;
  const assetsDir = path.resolve(path.join(themeDir, "assets"));
  const atlasPath = path.resolve(path.join(assetsDir, filename));
  if (!_isFsPathInsideDir(assetsDir, atlasPath) || !fs.existsSync(atlasPath)) return null;
  try {
    return pathToFileURL(atlasPath).href;
  } catch {
    return null;
  }
}
function _decorateCodexPetThemeMetadata(theme) {
  const marker = theme && _readCodexPetManagedThemeMarker(theme.id);
  if (!marker) return theme;
  return {
    ...theme,
    managedCodexPet: true,
    codexPet: {
      sourcePetId: marker.sourcePetId || "",
      sourcePackagePath: marker.sourcePackagePath || "",
      previewAtlasUrl: _getCodexPetPreviewAtlasUrl(theme.id, marker),
      adapterVersion: marker.adapterVersion || 0,
    },
  };
}
async function _refreshCodexPetThemesFromSettings() {
  const activeId = activeTheme ? activeTheme._id : (_settingsController.get("theme") || "clawd");
  let summary = _syncCodexPetThemesForMain(activeId);
  let switchedToFallback = false;

  if (summary.error) {
    return { status: "error", message: summary.error, summary };
  }

  if (_summaryHasActiveCodexPetOrphan(summary, activeId)) {
    const result = await _settingsController.applyCommand("setThemeSelection", { themeId: "clawd" });
    if (!result || result.status !== "ok") {
      return {
        status: "error",
        message: (result && result.message) || "failed to switch active orphan Codex Pet theme back to clawd",
        summary,
      };
    }
    switchedToFallback = true;
    const cleanup = _syncCodexPetThemesForMain("clawd");
    summary = _mergeCodexPetSyncSummaries(summary, cleanup);
    _lastCodexPetSyncSummary = summary;
    if (cleanup.error) {
      return { status: "error", message: cleanup.error, summary, switchedToFallback };
    }
  }

  try { rebuildAllMenus(); } catch (err) {
    console.warn("Clawd: rebuildAllMenus after Codex Pet refresh failed:", err && err.message);
  }
  return { status: "ok", summary, switchedToFallback };
}
function _resolveCodexPetRemovalTarget(themeId) {
  const marker = _readCodexPetManagedThemeMarker(themeId);
  if (!marker) {
    return { status: "error", message: "theme is not a managed Codex Pet" };
  }
  const petsRoot = path.resolve(codexPetImporter.getDefaultCodexPetsDir());
  const packageDir = path.resolve(marker.sourcePackagePath || "");
  if (!_isFsPathInsideDir(petsRoot, packageDir) || !_sameFsPath(path.dirname(packageDir), petsRoot)) {
    return { status: "error", message: "managed Codex Pet source path is outside the pets folder" };
  }
  return {
    status: "ok",
    marker,
    packageDir,
    exists: fs.existsSync(packageDir),
  };
}
function _extractClawdProtocolUrls(argv) {
  if (!Array.isArray(argv)) return [];
  return argv.filter((arg) => typeof arg === "string" && arg.toLowerCase().startsWith(`${CLAWD_PROTOCOL_SCHEME}:`));
}
function _enqueueCodexPetImportUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl) return;
  _pendingCodexPetImportUrls.push(rawUrl);
  if (app.isReady()) {
    setImmediate(() => {
      _flushPendingCodexPetImportUrls().catch((err) => {
        console.warn("Clawd: Codex Pet import queue failed:", err && err.message);
      });
    });
  }
}
function _enqueueCodexPetImportUrlsFromArgv(argv) {
  for (const rawUrl of _extractClawdProtocolUrls(argv)) {
    _enqueueCodexPetImportUrl(rawUrl);
  }
}
function _registerClawdProtocolClient() {
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
async function _flushPendingCodexPetImportUrls() {
  if (_codexPetImportFlushRunning) return;
  _codexPetImportFlushRunning = true;
  try {
    while (_pendingCodexPetImportUrls.length > 0) {
      const rawUrl = _pendingCodexPetImportUrls.shift();
      await _handleCodexPetImportProtocolUrl(rawUrl);
    }
  } finally {
    _codexPetImportFlushRunning = false;
  }
}
function _getCodexPetImportDialogParent() {
  if (settingsWindow && !settingsWindow.isDestroyed()) return settingsWindow;
  if (win && !win.isDestroyed()) return win;
  return null;
}
function _getCodexPetImportDialogStrings() {
  const all = {
    en: {
      import: "Import",
      cancel: "Cancel",
      ok: "OK",
      confirmMessage: (host) => `Import Codex Pet from ${host}?`,
      confirmDetail: (url) => `Clawd will download, validate, and install this pet package before switching to it.\n\n${url}`,
      replaceMessage: (name) => `Replace existing local pet "${name}"?`,
      replaceDetail: "A Codex Pet package with the same id already exists locally and was not imported by Clawd. Replacing it will overwrite that local package.",
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
      replaceDetail: "本地已经有同 id 的 Codex Pet 包，而且它不是由 Clawd 导入的。继续会覆盖这个本地包。",
      successMessage: (name) => `已导入 "${name}"`,
      successDetail: "导入的 Codex Pet 已设为当前主题。",
      failedMessage: "导入 Codex Pet 失败",
    },
    ko: {
      import: "가져오기",
      cancel: "취소",
      ok: "확인",
      confirmMessage: (host) => `${host}에서 Codex Pet을 가져올까요?`,
      confirmDetail: (url) => `Clawd가 이 펫 패키지를 다운로드, 검증, 설치한 뒤 전환합니다.\n\n${url}`,
      replaceMessage: (name) => `기존 로컬 펫 "${name}"을(를) 교체할까요?`,
      replaceDetail: "같은 id의 Codex Pet 패키지가 이미 로컬에 있으며 Clawd가 가져온 패키지가 아닙니다. 계속하면 해당 로컬 패키지를 덮어씁니다.",
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
      replaceDetail: "同じ id の Codex Pet パッケージがローカルにあり、Clawd がインポートしたものではありません。続行するとそのローカルパッケージを上書きします。",
      successMessage: (name) => `"${name}" をインポートしました`,
      successDetail: "インポートした Codex Pet を現在のテーマにしました。",
      failedMessage: "Codex Pet をインポートできませんでした",
    },
  };
  return all[lang] || all.en;
}
async function _showCodexPetImportError(message) {
  const s = _getCodexPetImportDialogStrings();
  try {
    await dialog.showMessageBox(_getCodexPetImportDialogParent(), {
      type: "error",
      buttons: [s.ok],
      message: s.failedMessage,
      detail: message || "unknown error",
      noLink: true,
    });
  } catch {}
}
async function _confirmReplaceExistingCodexPetPackage(payload) {
  const s = _getCodexPetImportDialogStrings();
  const existing = payload && payload.existingManifest;
  const incoming = payload && payload.incomingManifest;
  const displayName = (incoming && (incoming.displayName || incoming.id))
    || (existing && (existing.displayName || existing.id))
    || (payload && payload.packageName)
    || "Codex Pet";
  try {
    const { response } = await dialog.showMessageBox(_getCodexPetImportDialogParent(), {
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

function _getCodexPetRemovalDialogStrings() {
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
  return all[lang] || all.en;
}

async function _confirmRemoveImportedCodexPetPackage(displayName) {
  const s = _getCodexPetRemovalDialogStrings();
  try {
    const { response } = await dialog.showMessageBox(_getCodexPetImportDialogParent(), {
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

async function _materializeAndActivateImportedCodexPet(imported) {
  const activeId = activeTheme ? activeTheme._id : (_settingsController.get("theme") || "clawd");
  const summary = _syncCodexPetThemesForMain(activeId);
  if (summary.error) throw new Error(summary.error);
  const generated = (summary.themes || []).find((theme) => _sameFsPath(theme.packageDir, imported.packageDir));
  if (!generated || !generated.themeId) {
    throw new Error("imported package did not materialize into a Clawd theme");
  }
  const result = await _settingsController.applyCommand("setThemeSelection", { themeId: generated.themeId });
  if (!result || result.status !== "ok") {
    throw new Error((result && result.message) || "failed to switch to imported theme");
  }
  try { rebuildAllMenus(); } catch {}
  return { themeId: generated.themeId, summary };
}
async function _handleCodexPetImportProtocolUrl(rawUrl) {
  let parsed;
  try {
    parsed = codexPetImporter.parseClawdImportUrl(rawUrl);
  } catch (err) {
    await _showCodexPetImportError(err && err.message);
    return;
  }

  const s = _getCodexPetImportDialogStrings();
  const parent = _getCodexPetImportDialogParent();
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
      confirmReplaceExistingPackage: _confirmReplaceExistingCodexPetPackage,
    });
    await _materializeAndActivateImportedCodexPet(imported);
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
    await _showCodexPetImportError(err && err.message);
  }
}

// Lenient load so a missing/corrupt user-selected theme can't brick boot.
// If lenient fell back to "clawd" OR the variant fell back to "default",
// hydrate prefs to match so the store stays truth.
//
// Startup runs BEFORE the window is ready, so we call themeLoader.loadTheme
// directly — not activateTheme (which requires ready windows) and not the
// setThemeSelection command (which goes through activateTheme). The runtime
// switch path via UI goes through setThemeSelection post-window-ready.
let _requestedThemeId = _settingsController.get("theme") || "clawd";
const _initialVariantMap = _settingsController.get("themeVariant") || {};
let _requestedVariantId = _initialVariantMap[_requestedThemeId] || "default";
const _initialThemeOverrides = _settingsController.get("themeOverrides") || {};
let _requestedThemeOverrides = _initialThemeOverrides[_requestedThemeId] || null;
let _startupCodexPetSyncSummary = _syncCodexPetThemesForMain(_requestedThemeId);
if (_summaryHasActiveCodexPetOrphan(_startupCodexPetSyncSummary, _requestedThemeId)) {
  const orphanThemeId = _requestedThemeId;
  const nextVariantMap = { ...(_settingsController.get("themeVariant") || {}) };
  const nextOverrides = { ...(_settingsController.get("themeOverrides") || {}) };
  delete nextVariantMap[orphanThemeId];
  delete nextOverrides[orphanThemeId];

  _requestedThemeId = "clawd";
  _requestedVariantId = nextVariantMap[_requestedThemeId] || "default";
  _requestedThemeOverrides = nextOverrides[_requestedThemeId] || null;
  const result = _settingsController.hydrate({
    theme: _requestedThemeId,
    themeVariant: nextVariantMap,
    themeOverrides: nextOverrides,
  });
  if (result && result.status === "error") {
    console.warn("Clawd: Codex Pet active theme fallback hydrate failed:", result.message);
  }
  _startupCodexPetSyncSummary = _mergeCodexPetSyncSummaries(
    _startupCodexPetSyncSummary,
    _syncCodexPetThemesForMain(_requestedThemeId)
  );
  _lastCodexPetSyncSummary = _startupCodexPetSyncSummary;
}
let activeTheme = themeLoader.loadTheme(_requestedThemeId, {
  variant: _requestedVariantId,
  overrides: _requestedThemeOverrides,
});
activeTheme._overrideSignature = JSON.stringify(_requestedThemeOverrides || {});
if (activeTheme._id !== _requestedThemeId || activeTheme._variantId !== _requestedVariantId) {
  const nextVariantMap = { ...(_settingsController.get("themeVariant") || {}) };
  // Self-heal: store the resolved ids so next boot doesn't fall back again.
  nextVariantMap[activeTheme._id] = activeTheme._variantId;
  if (activeTheme._id !== _requestedThemeId) {
    delete nextVariantMap[_requestedThemeId];
  }
  const result = _settingsController.hydrate({
    theme: activeTheme._id,
    themeVariant: nextVariantMap,
  });
  if (result && result.status === "error") {
    console.warn("Clawd: theme hydrate after fallback failed:", result.message);
  }
}

// ── CSS <object> sizing (from theme) ──
function getObjRect(bounds) {
  if (!bounds) return null;
  const state = _state.getCurrentState();
  const file = _state.getCurrentSvg() || (activeTheme && activeTheme.states && activeTheme.states.idle[0]);
  return hitGeometry.getAssetRectScreen(activeTheme, bounds, state, file)
    || { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height };
}

function getAssetPointerPayload(bounds, point) {
  if (!bounds || !point || !activeTheme) return null;
  const state = _state.getCurrentState();
  const file = _state.getCurrentSvg() || (activeTheme && activeTheme.states && activeTheme.states.idle[0]);
  return hitGeometry.getAssetPointerPayload(activeTheme, bounds, state, file, point);
}

let win;
let hitWin;  // input window — small opaque rect over hitbox, receives all pointer events
let viewportOffsetY = 0;
const themeMarginEnvelopeCache = new Map();
let tray = null;
let contextMenuOwner = null;
let settingsSizePreviewSyncFrozen = false;
// Mirror of _settingsController.get("size") — initialized from disk, kept in
// sync by the settings subscriber. The legacy S/M/L → P:N migration runs
// inside createWindow() because it needs the screen API.
let currentSize = _settingsController.get("size");

// ── Proportional size mode ──
// currentSize = "P:<ratio>" means the pet occupies <ratio>% of the display long edge,
// so rotating the same monitor to portrait does not suddenly shrink the pet.
const PROPORTIONAL_RATIOS = [8, 10, 12, 15];

function isProportionalMode(size) {
  return typeof (size || currentSize) === "string" && (size || currentSize).startsWith("P:");
}

function getProportionalRatio(size) {
  return parseFloat((size || currentSize).slice(2)) || 10;
}

function getPixelSizeFor(sizeKey, overrideWa) {
  if (!isProportionalMode(sizeKey)) return SIZES[sizeKey] || SIZES.S;
  const ratio = getProportionalRatio(sizeKey);
  let wa = overrideWa;
  if (!wa && win && !win.isDestroyed()) {
    const { x, y, width, height } = getPetWindowBounds();
    wa = getNearestWorkArea(x + width / 2, y + height / 2);
  }
  if (!wa) wa = getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA;
  return getProportionalPixelSize(ratio, wa);
}

function getCurrentPixelSize(overrideWa) {
  if (!isProportionalMode()) return SIZES[currentSize] || SIZES.S;
  return getPixelSizeFor(currentSize, overrideWa);
}

function getEffectiveCurrentPixelSize(overrideWa) {
  if (
    keepSizeAcrossDisplaysCached &&
    isProportionalMode() &&
    win &&
    !win.isDestroyed()
  ) {
    const bounds = getPetWindowBounds();
    return { width: bounds.width, height: bounds.height };
  }
  return getCurrentPixelSize(overrideWa);
}
let contextMenu;
let doNotDisturb = false;
let isQuitting = false;
// Mirror caches — kept in sync with the settings store via the subscriber
// in wireSettingsSubscribers() further down. Read freely; never assign
// directly (writes go through ctx setters → controller.applyUpdate).
let showTray = _settingsController.get("showTray");
let showDock = _settingsController.get("showDock");
let manageClaudeHooksAutomatically = _settingsController.get("manageClaudeHooksAutomatically");
let autoStartWithClaude = _settingsController.get("autoStartWithClaude");
let openAtLogin = _settingsController.get("openAtLogin");
let bubbleFollowPet = _settingsController.get("bubbleFollowPet");
let sessionHudEnabled = _settingsController.get("sessionHudEnabled");
let sessionHudShowElapsed = _settingsController.get("sessionHudShowElapsed");
let sessionHudCleanupDetached = _settingsController.get("sessionHudCleanupDetached");
let soundMuted = _settingsController.get("soundMuted");
let soundVolume = _settingsController.get("soundVolume");
let lowPowerIdleMode = _settingsController.get("lowPowerIdleMode");
let allowEdgePinningCached = _settingsController.get("allowEdgePinning");
let keepSizeAcrossDisplaysCached = _settingsController.get("keepSizeAcrossDisplays");
let petHidden = false;
const shortcutRegistrationFailures = new Map();

function getShortcutFailure(actionId) {
  return shortcutRegistrationFailures.get(actionId) || null;
}

function broadcastShortcutFailures() {
  if (!settingsWindow || settingsWindow.isDestroyed() || !settingsWindow.webContents || settingsWindow.webContents.isDestroyed()) {
    return;
  }
  settingsWindow.webContents.send(
    "shortcut-failures-changed",
    Object.fromEntries(shortcutRegistrationFailures)
  );
}

function getRuntimeBubblePolicy(kind) {
  return getBubblePolicy(_settingsController.getSnapshot(), kind);
}

function getAllBubblesHidden() {
  return isAllBubblesHidden(_settingsController.getSnapshot());
}

function reportShortcutFailure(actionId, reason) {
  if (!SHORTCUT_ACTIONS[actionId]) return;
  if (shortcutRegistrationFailures.get(actionId) === reason) return;
  shortcutRegistrationFailures.set(actionId, reason);
  broadcastShortcutFailures();
}

function clearShortcutFailure(actionId) {
  if (!shortcutRegistrationFailures.has(actionId)) return;
  shortcutRegistrationFailures.delete(actionId);
  broadcastShortcutFailures();
}

function togglePetVisibility() {
  if (!win || win.isDestroyed()) return;
  if (_mini.getMiniTransitioning()) return;
  if (petHidden) {
    win.showInactive();
    keepOutOfTaskbar(win);
    if (hitWin && !hitWin.isDestroyed()) {
      hitWin.showInactive();
      keepOutOfTaskbar(hitWin);
    }
    // Restore any permission bubbles that were hidden
    for (const perm of pendingPermissions) {
      if (perm.bubble && !perm.bubble.isDestroyed()) {
        perm.bubble.showInactive();
        keepOutOfTaskbar(perm.bubble);
      }
    }
    syncUpdateBubbleVisibility();
    reapplyMacVisibility();
    petHidden = false;
  } else {
    win.hide();
    if (hitWin && !hitWin.isDestroyed()) hitWin.hide();
    // Also hide any permission bubbles
    for (const perm of pendingPermissions) {
      if (perm.bubble && !perm.bubble.isDestroyed()) perm.bubble.hide();
    }
    hideUpdateBubble();
    petHidden = true;
  }
  syncSessionHudVisibility();
  repositionFloatingBubbles();
  syncPermissionShortcuts();
  buildTrayMenu();
  buildContextMenu();
}

function bringPetToPrimaryDisplay() {
  if (!win || win.isDestroyed()) return;
  if (_mini.getMiniMode() || _mini.getMiniTransitioning()) return;

  const workArea = getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA;
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
    win.showInactive();
    keepOutOfTaskbar(win);
    if (hitWin && !hitWin.isDestroyed()) {
      hitWin.showInactive();
      keepOutOfTaskbar(hitWin);
    }
  }

  reapplyMacVisibility();
  reassertWinTopmost();
  scheduleHwndRecovery();
  flushRuntimeStateToPrefs();
}

function registerPersistentShortcutsFromSettings() {
  const snapshot = _settingsController.getSnapshot();
  const shortcuts = (snapshot && snapshot.shortcuts) || {};
  for (const actionId of SHORTCUT_ACTION_IDS) {
    const meta = SHORTCUT_ACTIONS[actionId];
    if (!meta || !meta.persistent) continue;
    const accelerator = shortcuts[actionId];
    if (!accelerator) {
      clearShortcutFailure(actionId);
      continue;
    }
    const handler = actionId === "togglePet" ? togglePetVisibility : null;
    if (typeof handler !== "function") continue;
    let ok = false;
    try {
      ok = !!globalShortcut.register(accelerator, handler);
    } catch {
      ok = false;
    }
    if (!ok) {
      reportShortcutFailure(actionId, "system conflict");
      console.warn(`Clawd: failed to register shortcut ${actionId}: ${accelerator}`);
      continue;
    }
    clearShortcutFailure(actionId);
  }
}

function sendToRenderer(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}
function sendToHitWin(channel, ...args) {
  if (hitWin && !hitWin.isDestroyed()) hitWin.webContents.send(channel, ...args);
}

function setViewportOffsetY(offsetY) {
  const next = Number.isFinite(offsetY) ? Math.max(0, Math.round(offsetY)) : 0;
  if (next === viewportOffsetY) return;
  viewportOffsetY = next;
  sendToRenderer("viewport-offset", viewportOffsetY);
}

function getPetWindowBounds() {
  if (!win || win.isDestroyed()) return null;
  const bounds = win.getBounds();
  return {
    x: bounds.x,
    y: bounds.y - viewportOffsetY,
    width: bounds.width,
    height: bounds.height,
  };
}

function applyPetWindowBounds(bounds) {
  if (!win || win.isDestroyed() || !bounds) return null;
  const workArea = getNearestWorkArea(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2
  );
  const materialized = materializeVirtualBounds(bounds, workArea);
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

function hasStoredPositionThemeMismatch(prefs) {
  if (!prefs || !activeTheme) return false;
  return prefs.positionThemeId !== activeTheme._id
    || prefs.positionVariantId !== activeTheme._variantId;
}

function syncHitStateAfterLoad() {
  sendToHitWin("hit-state-sync", {
    currentSvg: _state.getCurrentSvg(),
    currentState: _state.getCurrentState(),
    miniMode: _mini.getMiniMode(),
    dndEnabled: doNotDisturb,
  });
}

function syncRendererStateAfterLoad({ includeStartupRecovery = true } = {}) {
  sendToRenderer("low-power-idle-mode-change", lowPowerIdleMode);
  if (_mini.getMiniMode()) {
    sendToRenderer("mini-mode-change", true, _mini.getMiniEdge());
  }
  if (doNotDisturb) {
    sendToRenderer("dnd-change", true);
    if (_mini.getMiniMode()) {
      applyState("mini-sleep");
    } else {
      applyState("sleeping");
    }
    return;
  }
  if (_mini.getMiniMode()) {
    applyState("mini-idle");
    return;
  }

  // Theme hot-reload path (override tweak / variant swap): re-render whatever
  // we were already showing. Going through resolveDisplayState() here flashes
  // "working/typing" when sessions Map still holds a stale session whose
  // state hasn't been stale-downgraded yet — currentState already reflects
  // the user-visible state before reload and stays authoritative.
  if (!includeStartupRecovery) {
    const prev = _state.getCurrentState();
    applyState(prev, getSvgOverride(prev));
    return;
  }

  if (sessions.size > 0) {
    const resolved = resolveDisplayState();
    applyState(resolved, getSvgOverride(resolved));
    return;
  }

  applyState("idle", getSvgOverride("idle"));

  setTimeout(() => {
    if (sessions.size > 0 || doNotDisturb) return;
    detectRunningAgentProcesses((found) => {
      if (found && sessions.size === 0 && !doNotDisturb) {
        _startStartupRecovery();
        resetIdleTimer();
      }
    });
  }, 5000);
}

// ── Sound playback ──
let lastSoundTime = 0;
const SOUND_COOLDOWN_MS = 10000;

function playSound(name) {
  if (soundMuted || doNotDisturb) return;
  const now = Date.now();
  if (now - lastSoundTime < SOUND_COOLDOWN_MS) return;
  const url = themeLoader.getSoundUrl(name);
  if (!url) return;
  lastSoundTime = now;
  sendToRenderer("play-sound", { url, volume: soundVolume });
}

function resetSoundCooldown() {
  lastSoundTime = 0;
}

// Sync input window position to match render window's hitbox.
// Called manually after every win position/size change + event-level safety net.
let _lastHitW = 0, _lastHitH = 0;
function syncHitWin() {
  if (!hitWin || hitWin.isDestroyed() || !win || win.isDestroyed()) return;
  // Keep the captured pointer stable while dragging. Repositioning the input
  // window mid-drag can break pointer capture on Windows.
  if (dragLocked) return;
  const bounds = getPetWindowBounds();
  const hit = getHitRectScreen(bounds);
  const x = Math.round(hit.left);
  const y = Math.round(hit.top);
  const w = Math.round(hit.right - hit.left);
  const h = Math.round(hit.bottom - hit.top);
  if (w <= 0 || h <= 0) return;
  hitWin.setBounds({ x, y, width: w, height: h });
  // Update shape if hitbox dimensions changed (e.g. after resize)
  if (w !== _lastHitW || h !== _lastHitH) {
    _lastHitW = w; _lastHitH = h;
    hitWin.setShape([{ x: 0, y: 0, width: w, height: h }]);
  }
  repositionSessionHud();
}

let mouseOverPet = false;
let dragLocked = false;
let dragSnapshot = null;
let menuOpen = false;
let idlePaused = false;
let forceEyeResend = false;
let forceEyeResendBoostUntil = 0;
let requestFastTick = () => {};
let themeReloadInProgress = false;
let themeSwitchTransitionSeq = 0;
let themeSwitchFadeFallbackTimer = null;
let themeSwitchOpacityCancelSignal = null;
let themeSwitchReloadListenerCleanup = null;
let repositionSessionHud = () => {};
let syncSessionHudVisibility = () => {};
let broadcastSessionHudSnapshot = () => {};
let sendSessionHudI18n = () => {};
let getSessionHudReservedOffset = () => 0;
let getSessionHudWindow = () => null;

function setForceEyeResend(value) {
  forceEyeResend = !!value;
  if (forceEyeResend) {
    forceEyeResendBoostUntil = Math.max(forceEyeResendBoostUntil, Date.now() + 2000);
    requestFastTick(100);
  }
}

// Keep drag math in Electron's main-process DIP coordinate space. Renderer
// PointerEvent.screenX/Y can be scaled differently on high-DPI displays.
function beginDragSnapshot() {
  if (!win || win.isDestroyed()) {
    dragSnapshot = null;
    return;
  }
  const bounds = getPetWindowBounds();
  // When keepSizeAcrossDisplays is on, the pet may currently be sized from
  // a prior display (e.g. dragged from a small monitor and kept small on a
  // large one). Snapshotting getCurrentPixelSize() here would snap it to
  // the large display's proportional size at drag start, which is the
  // exact behaviour the user disabled.
  const size = keepSizeAcrossDisplaysCached
    ? { width: bounds.width, height: bounds.height }
    : getCurrentPixelSize();
  dragSnapshot = createDragSnapshot(
    screen.getCursorScreenPoint(),
    bounds,
    size
  );
}

function clearDragSnapshot() {
  dragSnapshot = null;
}

function moveWindowForDrag() {
  if (!dragLocked) return;
  if (_mini.getMiniMode() || _mini.getMiniTransitioning()) return;
  if (!win || win.isDestroyed()) return;
  if (!dragSnapshot) return;

  const bounds = computeAnchoredDragBounds(
    dragSnapshot,
    screen.getCursorScreenPoint(),
    looseClampPetToDisplays
  );
  if (!bounds) return;

  applyPetWindowBounds(bounds);
  if (isWin && isNearWorkAreaEdge(bounds)) reassertWinTopmost();
  syncHitWin();
  repositionSessionHud();
  repositionFloatingBubbles();
}

// ── Mini Mode — delegated to src/mini.js ──
// Initialized after state module (needs applyState, resolveDisplayState, etc.)
// See _mini initialization below


// ── Permission bubble — delegated to src/permission.js ──
const {
  isAgentEnabled: _isAgentEnabled,
  isAgentPermissionsEnabled: _isAgentPermissionsEnabled,
  isAgentNotificationHookEnabled: _isAgentNotificationHookEnabled,
  isCodexPermissionInterceptEnabled: _isCodexPermissionInterceptEnabled,
} = require("./agent-gate");
const _permCtx = {
  get win() { return win; },
  get lang() { return lang; },
  get sessions() { return sessions; },
  get bubbleFollowPet() { return bubbleFollowPet; },
  get permDebugLog() { return permDebugLog; },
  get doNotDisturb() { return doNotDisturb; },
  get hideBubbles() { return getAllBubblesHidden(); },
  get petHidden() { return petHidden; },
  getBubblePolicy: getRuntimeBubblePolicy,
  getPetWindowBounds,
  getNearestWorkArea,
  getHitRectScreen,
  getHudReservedOffset: () => getSessionHudReservedOffset(),
  guardAlwaysOnTop,
  reapplyMacVisibility,
  isAgentPermissionsEnabled: (agentId) =>
    _isAgentPermissionsEnabled({ agents: _settingsController.get("agents") }, agentId),
  focusTerminalForSession: (sessionId) => {
    const s = sessions.get(sessionId);
    if (s && s.sourcePid) focusTerminalWindow(s.sourcePid, s.cwd, s.editor, s.pidChain);
  },
  getSettingsSnapshot: () => _settingsController.getSnapshot(),
  subscribeShortcuts: (cb) => _settingsController.subscribeKey("shortcuts", (_value, snapshot) => {
    if (typeof cb === "function") cb(snapshot);
  }),
  reportShortcutFailure: (actionId, reason) => reportShortcutFailure(actionId, reason),
  clearShortcutFailure: (actionId) => clearShortcutFailure(actionId),
  repositionUpdateBubble: () => repositionUpdateBubble(),
};
const _perm = require("./permission")(_permCtx);
const { showPermissionBubble, resolvePermissionEntry, sendPermissionResponse, repositionBubbles, permLog, PASSTHROUGH_TOOLS, showCodexNotifyBubble, clearCodexNotifyBubbles, showKimiNotifyBubble, clearKimiNotifyBubbles, syncPermissionShortcuts, replyOpencodePermission } = _perm;
const pendingPermissions = _perm.pendingPermissions;
let permDebugLog = null; // set after app.whenReady()
let updateDebugLog = null; // set after app.whenReady()
let sessionDebugLog = null; // set after app.whenReady()

const _updateBubbleCtx = {
  get win() { return win; },
  get bubbleFollowPet() { return bubbleFollowPet; },
  get petHidden() { return petHidden; },
  getBubblePolicy: getRuntimeBubblePolicy,
  getPendingPermissions: () => pendingPermissions,
  getPetWindowBounds,
  getNearestWorkArea,
  getUpdateBubbleAnchorRect,
  getHitRectScreen,
  getHudReservedOffset: () => getSessionHudReservedOffset(),
  guardAlwaysOnTop,
  reapplyMacVisibility,
};
const _updateBubble = require("./update-bubble")(_updateBubbleCtx);
const {
  showUpdateBubble,
  hideUpdateBubble,
  repositionUpdateBubble,
  handleUpdateBubbleAction,
  handleUpdateBubbleHeight,
  syncVisibility: syncUpdateBubbleVisibility,
} = _updateBubble;

function repositionFloatingBubbles() {
  if (pendingPermissions.length) repositionBubbles();
  repositionUpdateBubble();
}

// ── macOS cross-Space visibility helper ──
// Prefer native collection behavior over Electron's setVisibleOnAllWorkspaces:
// Electron may briefly hide the window while transforming process type, while
// the native path also mirrors Masko Code's SkyLight-backed stationary Space.
function reapplyMacVisibility() {
  if (!isMac) return;
  const apply = (w) => {
    if (w && !w.isDestroyed()) {
      const deferUntil = Number(w.__clawdMacDeferredVisibilityUntil) || 0;
      if (deferUntil > Date.now()) return;
      if (deferUntil) delete w.__clawdMacDeferredVisibilityUntil;
      w.setAlwaysOnTop(true, MAC_TOPMOST_LEVEL);
      if (!applyStationaryCollectionBehavior(w)) {
        const opts = { visibleOnFullScreen: true };
        if (!showDock) opts.skipTransformProcessType = true;
        w.setVisibleOnAllWorkspaces(true, opts);
        // First, try the native flicker-free path.
        // If the native path fails, use Electron's cross-space API as a fallback.
        // After using Electron as a fallback, try the native enhancement again to avoid Electron resetting the window behavior we want.
        applyStationaryCollectionBehavior(w);
      }
    }
  };
  apply(win);
  apply(hitWin);
  for (const perm of pendingPermissions) apply(perm.bubble);
  apply(_updateBubble.getBubbleWindow());
  apply(getSessionHudWindow());
  apply(contextMenuOwner);
}

// ── State machine — delegated to src/state.js ──
let showDashboard = () => {};
let broadcastDashboardSessionSnapshot = () => {};
let sendDashboardI18n = () => {};

const _stateCtx = {
  get theme() { return activeTheme; },
  get win() { return win; },
  get hitWin() { return hitWin; },
  get doNotDisturb() { return doNotDisturb; },
  set doNotDisturb(v) { doNotDisturb = v; },
  get miniMode() { return _mini.getMiniMode(); },
  get miniTransitioning() { return _mini.getMiniTransitioning(); },
  get mouseOverPet() { return mouseOverPet; },
  get miniSleepPeeked() { return _mini.getMiniSleepPeeked(); },
  set miniSleepPeeked(v) { _mini.setMiniSleepPeeked(v); },
  get miniPeeked() { return _mini.getMiniPeeked(); },
  set miniPeeked(v) { _mini.setMiniPeeked(v); },
  get idlePaused() { return idlePaused; },
  set idlePaused(v) { idlePaused = v; },
  get forceEyeResend() { return forceEyeResend; },
  set forceEyeResend(v) { setForceEyeResend(v); },
  get mouseStillSince() { return _tick ? _tick._mouseStillSince : Date.now(); },
  get pendingPermissions() { return pendingPermissions; },
  sendToRenderer,
  sendToHitWin,
  syncHitWin,
  playSound,
  t: (key) => t(key),
  focusTerminalWindow: (...args) => focusTerminalWindow(...args),
  resolvePermissionEntry: (...args) => resolvePermissionEntry(...args),
  showKimiNotifyBubble: (...args) => showKimiNotifyBubble(...args),
  clearKimiNotifyBubbles: (...args) => clearKimiNotifyBubbles(...args),
  // state.js needs this to gate startKimiPermissionPoll symmetrically with
  // shouldSuppressKimiNotifyBubble in permission.js — without it the
  // permissionsEnabled=false toggle would silently rebuild holds on every
  // incoming Kimi PermissionRequest.
  isAgentPermissionsEnabled: (agentId) =>
    _isAgentPermissionsEnabled({ agents: _settingsController.get("agents") }, agentId),
  // state.js gates self-issued Notification events (idle / wait-for-input
  // pings) via this reader. Living in updateSession (not at the HTTP
  // boundary) keeps the gate consistent for hook / log-poll / plugin paths.
  isAgentNotificationHookEnabled: (agentId) =>
    _isAgentNotificationHookEnabled({ agents: _settingsController.get("agents") }, agentId),
  miniPeekIn: () => miniPeekIn(),
  miniPeekOut: () => miniPeekOut(),
  buildContextMenu: () => buildContextMenu(),
  buildTrayMenu: () => buildTrayMenu(),
  debugLog: (msg) => sessionLog(msg),
  broadcastSessionSnapshot: (snapshot) => {
    broadcastDashboardSessionSnapshot(snapshot);
    broadcastSessionHudSnapshot(snapshot);
    repositionFloatingBubbles();
  },
  // Phase 3b: 读 prefs.themeOverrides 判断某个 oneshot state 是否被用户禁用。
  // state.js gate 调这个做 early-return。不做白名单校验——settings-actions
  // 负责写入合法性，这里只读。
  isOneshotDisabled: (stateKey) => {
    const themeId = activeTheme && activeTheme._id;
    if (!themeId || !stateKey) return false;
    const overrides = _settingsController.get("themeOverrides");
    const themeMap = overrides && overrides[themeId];
    const stateMap = themeMap && themeMap.states;
    const entry = (stateMap && stateMap[stateKey]) || (themeMap && themeMap[stateKey]);
    return !!(entry && entry.disabled === true);
  },
  get sessionHudCleanupDetached() { return sessionHudCleanupDetached; },
  getSessionAliases: () => _settingsController.get("sessionAliases"),
  hasAnyEnabledAgent: () => {
    // `get("agents")` returns the live reference (no clone) — we're only
    // reading. Missing agents field falls back to "assume enabled" (the
    // legacy default-true contract for unconfigured installs); but an
    // explicit empty object means every agent was cleared, so return
    // false. Without that distinction, a user who wiped the field would
    // still trigger startup-recovery process scans.
    const agents = _settingsController.get("agents");
    if (!agents || typeof agents !== "object") return true;
    const probe = { agents };
    for (const id of Object.keys(agents)) {
      if (_isAgentEnabled(probe, id)) return true;
    }
    return false;
  },
};
const _state = require("./state")(_stateCtx);
const { setState, applyState, updateSession, resolveDisplayState, getSvgOverride,
        enableDoNotDisturb, disableDoNotDisturb, startStaleCleanup, stopStaleCleanup,
        startWakePoll, stopWakePoll, detectRunningAgentProcesses,
        startStartupRecovery: _startStartupRecovery } = _state;
const sessions = _state.sessions;
const STATE_PRIORITY = _state.STATE_PRIORITY;

// ── Hit-test: SVG bounding box → screen coordinates ──
function getHitRectScreen(bounds) {
  if (!bounds) return null;
  const state = _state.getCurrentState();
  const file = _state.getCurrentSvg() || (activeTheme && activeTheme.states && activeTheme.states.idle[0]);
  const hit = hitGeometry.getHitRectScreen(
    activeTheme,
    bounds,
    state,
    file,
    _state.getCurrentHitBox(),
    {
      padX: _mini.getMiniMode() ? _mini.PEEK_OFFSET : 0,
      padY: _mini.getMiniMode() ? 8 : 0,
    }
  );
  return hit || { left: bounds.x, top: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height };
}

function getUpdateBubbleAnchorRect(bounds) {
  if (!bounds || !activeTheme) return getHitRectScreen(bounds);

  const stableAnchor = computeThemeAnchorRect(activeTheme, bounds);
  if (stableAnchor) return stableAnchor;

  const box = getThemeMarginBox(activeTheme);
  const currentFile = _state.getCurrentSvg();
  if (box && currentFile) {
    const currentAnchor = computeThemeAnchorRect(activeTheme, bounds, {
      box,
      state: _state.getCurrentState(),
      file: currentFile,
    });
    if (currentAnchor) return currentAnchor;
  }

  return getHitRectScreen(bounds);
}

function getSessionHudAnchorRect(bounds) {
  if (!bounds || !activeTheme) return null;
  const box = getThemeMarginBox(activeTheme);
  if (!box) return null;
  return computeThemeAnchorRect(activeTheme, bounds, { box });
}

function getVisibleContentMargins(bounds) {
  if (!bounds || !activeTheme) return { top: 0, bottom: 0 };
  const box = getThemeMarginBox(activeTheme);
  if (!box) return { top: 0, bottom: 0 };

  const cacheKey = [
    activeTheme._id || "",
    activeTheme._variantId || "",
    bounds.width,
    bounds.height,
    JSON.stringify(box),
  ].join("|");
  const cached = themeMarginEnvelopeCache.get(cacheKey);
  if (cached) return cached;

  const margins = computeStableVisibleContentMargins(activeTheme, bounds, { box });
  themeMarginEnvelopeCache.set(cacheKey, margins);
  return margins;
}

// ── Main tick — delegated to src/tick.js ──
const _tickCtx = {
  get theme() { return activeTheme; },
  get win() { return win; },
  getPetWindowBounds,
  get currentState() { return _state.getCurrentState(); },
  get currentSvg() { return _state.getCurrentSvg(); },
  get miniMode() { return _mini.getMiniMode(); },
  get miniTransitioning() { return _mini.getMiniTransitioning(); },
  get dragLocked() { return dragLocked; },
  get menuOpen() { return menuOpen; },
  get idlePaused() { return idlePaused; },
  get isAnimating() { return _mini.getIsAnimating(); },
  get miniSleepPeeked() { return _mini.getMiniSleepPeeked(); },
  set miniSleepPeeked(v) { _mini.setMiniSleepPeeked(v); },
  get miniPeeked() { return _mini.getMiniPeeked(); },
  set miniPeeked(v) { _mini.setMiniPeeked(v); },
  get mouseOverPet() { return mouseOverPet; },
  set mouseOverPet(v) { mouseOverPet = v; },
  get forceEyeResend() { return forceEyeResend; },
  set forceEyeResend(v) { setForceEyeResend(v); },
  get forceEyeResendBoostUntil() { return forceEyeResendBoostUntil; },
  get startupRecoveryActive() { return _state.getStartupRecoveryActive(); },
  sendToRenderer,
  sendToHitWin,
  setState,
  applyState,
  miniPeekIn: () => miniPeekIn(),
  miniPeekOut: () => miniPeekOut(),
  getObjRect,
  getHitRectScreen,
  getAssetPointerPayload,
};
const _tick = require("./tick")(_tickCtx);
requestFastTick = (maxDelay) => _tick.scheduleSoon(maxDelay);
const { startMainTick, resetIdleTimer } = _tick;

// ── Terminal focus — delegated to src/focus.js ──
const _focus = require("./focus")({ _allowSetForeground });
const { initFocusHelper, killFocusHelper, focusTerminalWindow, clearMacFocusCooldownTimer } = _focus;

function focusDashboardSession(sessionId) {
  if (!sessionId) return;
  const session = sessions.get(String(sessionId));
  if (session && session.sourcePid) {
    focusTerminalWindow(session.sourcePid, session.cwd, session.editor, session.pidChain);
  }
}

function hideDashboardSession(sessionId) {
  if (!_state || typeof _state.dismissSession !== "function") {
    return { status: "error", message: "session state is not ready" };
  }
  const removed = _state.dismissSession(String(sessionId || ""));
  return removed
    ? { status: "ok" }
    : { status: "not-found" };
}

const _dashboard = require("./dashboard")({
  get lang() { return lang; },
  t: (key) => translate(key),
  getSessionSnapshot: () => _state.buildSessionSnapshot(),
  getI18n: () => getDashboardI18nPayload(),
  getPetWindowBounds,
  getNearestWorkArea,
  iconPath: getSettingsWindowIcon(),
});
showDashboard = _dashboard.showDashboard;
broadcastDashboardSessionSnapshot = _dashboard.broadcastSessionSnapshot;
sendDashboardI18n = _dashboard.sendI18n;

const _sessionHud = require("./session-hud")({
  get win() { return win; },
  get petHidden() { return petHidden; },
  get sessionHudEnabled() { return sessionHudEnabled; },
  get sessionHudShowElapsed() { return sessionHudShowElapsed; },
  getMiniMode: () => _mini.getMiniMode(),
  getMiniTransitioning: () => _mini.getMiniTransitioning(),
  getSessionSnapshot: () => _state.buildSessionSnapshot(),
  getI18n: () => getDashboardI18nPayload(),
  getPetWindowBounds,
  getHitRectScreen,
  getSessionHudAnchorRect,
  getNearestWorkArea,
  guardAlwaysOnTop,
  reapplyMacVisibility,
  onReservedOffsetChange: () => repositionFloatingBubbles(),
});
repositionSessionHud = _sessionHud.repositionSessionHud;
syncSessionHudVisibility = _sessionHud.syncSessionHud;
broadcastSessionHudSnapshot = _sessionHud.broadcastSessionSnapshot;
sendSessionHudI18n = _sessionHud.sendI18n;
getSessionHudReservedOffset = _sessionHud.getHudReservedOffset;
getSessionHudWindow = _sessionHud.getWindow;

// ── HTTP server — delegated to src/server.js ──
const _serverCtx = {
  get manageClaudeHooksAutomatically() { return manageClaudeHooksAutomatically; },
  get autoStartWithClaude() { return autoStartWithClaude; },
  get doNotDisturb() { return doNotDisturb; },
  shouldDropForDnd: () => _state.shouldDropForDnd ? _state.shouldDropForDnd() : doNotDisturb,
  get hideBubbles() { return getAllBubblesHidden(); },
  getBubblePolicy: getRuntimeBubblePolicy,
  get pendingPermissions() { return pendingPermissions; },
  get PASSTHROUGH_TOOLS() { return PASSTHROUGH_TOOLS; },
  get STATE_SVGS() { return _state.STATE_SVGS; },
  get sessions() { return sessions; },
  isAgentEnabled: (agentId) => _isAgentEnabled({ agents: _settingsController.get("agents") }, agentId),
  isAgentPermissionsEnabled: (agentId) => _isAgentPermissionsEnabled({ agents: _settingsController.get("agents") }, agentId),
  isCodexPermissionInterceptEnabled: () => _isCodexPermissionInterceptEnabled({ agents: _settingsController.get("agents") }),
  codexSubagentClassifier: _codexSubagentClassifier,
  setState,
  updateSession: updateSessionFromServer,
  resolvePermissionEntry,
  sendPermissionResponse,
  showPermissionBubble,
  replyOpencodePermission,
  permLog,
};
const _server = require("./server")(_serverCtx);
const { startHttpServer, getHookServerPort } = _server;

// ── alwaysOnTop recovery (Windows DWM / Shell can strip TOPMOST flag) ──
// The "always-on-top-changed" event only fires from Electron's own SetAlwaysOnTop
// path — it does NOT fire when Explorer/Start menu/Gallery silently reorder windows.
// So we keep the event listener for the cases it does catch (Alt/Win key), and add
// a slow watchdog (20s) to recover from silent shell-initiated z-order drops.
const WIN_TOPMOST_LEVEL = "pop-up-menu";  // above taskbar-level UI
const MAC_TOPMOST_LEVEL = "screen-saver"; // above fullscreen apps on macOS
const TOPMOST_WATCHDOG_MS = 5_000;
let topmostWatchdog = null;
let hwndRecoveryTimer = null;

function reassertWinTopmost() {
  if (!isWin) return;
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
  if (hitWin && !hitWin.isDestroyed()) hitWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
}

function isNearWorkAreaEdge(bounds, tolerance = 2) {
  if (!bounds) return false;
  const wa = getNearestWorkArea(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  if (!wa) return false;
  return (
    bounds.x <= wa.x + tolerance ||
    bounds.y <= wa.y + tolerance ||
    bounds.x + bounds.width >= wa.x + wa.width - tolerance ||
    bounds.y + bounds.height >= wa.y + wa.height - tolerance
  );
}

// Reinitialize HWND input routing after DWM z-order disruptions.
// showInactive() (ShowWindow SW_SHOWNOACTIVATE) is the same call that makes
// the right-click context menu restore drag capability — it forces Windows to
// fully recalculate the transparent window's input target region.
function scheduleHwndRecovery() {
  if (!isWin) return;
  if (hwndRecoveryTimer) clearTimeout(hwndRecoveryTimer);
  hwndRecoveryTimer = setTimeout(() => {
    hwndRecoveryTimer = null;
    if (!win || win.isDestroyed()) return;
    // Just restore z-order — input routing is handled by hitWin now
    reassertWinTopmost();
    setForceEyeResend(true);
  }, 1000);
}

function guardAlwaysOnTop(w) {
  if (!isWin) return;
  w.on("always-on-top-changed", (_, isOnTop) => {
    if (!isOnTop && w && !w.isDestroyed()) {
      w.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
      if (w === win && !dragLocked && !_mini.getIsAnimating() && !_mini.getMiniTransitioning()) {
        setForceEyeResend(true);
        const bounds = getPetWindowBounds();
        applyPetWindowPosition(bounds.x + 1, bounds.y);
        applyPetWindowPosition(bounds.x, bounds.y);
        syncHitWin();
        scheduleHwndRecovery();
      }
    }
  });
}

function startTopmostWatchdog() {
  if (!isWin || topmostWatchdog) return;
  topmostWatchdog = setInterval(() => {
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
      keepOutOfTaskbar(win);
    }
    // Keep hitWin topmost too
    if (hitWin && !hitWin.isDestroyed()) {
      hitWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
      keepOutOfTaskbar(hitWin);
    }
    for (const perm of pendingPermissions) {
      if (perm.bubble && !perm.bubble.isDestroyed() && perm.bubble.isVisible()) {
        perm.bubble.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
        keepOutOfTaskbar(perm.bubble);
      }
    }
    const updateBubbleWin = _updateBubble.getBubbleWindow();
    if (updateBubbleWin && !updateBubbleWin.isDestroyed() && updateBubbleWin.isVisible()) {
      updateBubbleWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
      keepOutOfTaskbar(updateBubbleWin);
    }
    const sessionHudWin = getSessionHudWindow();
    if (sessionHudWin && !sessionHudWin.isDestroyed() && sessionHudWin.isVisible()) {
      sessionHudWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
      keepOutOfTaskbar(sessionHudWin);
    }
    if (contextMenuOwner && !contextMenuOwner.isDestroyed()) {
      keepOutOfTaskbar(contextMenuOwner);
    }
  }, TOPMOST_WATCHDOG_MS);
}

function stopTopmostWatchdog() {
  if (topmostWatchdog) { clearInterval(topmostWatchdog); topmostWatchdog = null; }
}

function updateLog(msg) {
  if (!updateDebugLog) return;
  const { rotatedAppend } = require("./log-rotate");
  rotatedAppend(updateDebugLog, `[${new Date().toISOString()}] ${msg}\n`);
}

function sessionLog(msg) {
  if (!sessionDebugLog) return;
  const { rotatedAppend } = require("./log-rotate");
  rotatedAppend(sessionDebugLog, `[${new Date().toISOString()}] ${msg}\n`);
}

// ── Menu — delegated to src/menu.js ──
//
// Setters that previously assigned to module-level vars now route through
// `_settingsController.applyUpdate(key, value)`. The mirror cache is updated
// by the subscriber wired in `wireSettingsSubscribers()` after this ctx is
// built. Side effects that used to live inside setters (e.g.
// `syncPermissionShortcuts()` for hideBubbles) are now reactive and live in
// the subscriber too.
const _menuCtx = {
  get win() { return win; },
  get sessions() { return sessions; },
  get currentSize() { return currentSize; },
  set currentSize(v) { _settingsController.applyUpdate("size", v); },
  get doNotDisturb() { return doNotDisturb; },
  get lang() { return lang; },
  set lang(v) { _settingsController.applyUpdate("lang", v); },
  get showTray() { return showTray; },
  set showTray(v) { _settingsController.applyUpdate("showTray", v); },
  get showDock() { return showDock; },
  set showDock(v) { _settingsController.applyUpdate("showDock", v); },
  get manageClaudeHooksAutomatically() { return manageClaudeHooksAutomatically; },
  get autoStartWithClaude() { return autoStartWithClaude; },
  set autoStartWithClaude(v) { _settingsController.applyUpdate("autoStartWithClaude", v); },
  get openAtLogin() { return openAtLogin; },
  set openAtLogin(v) { _settingsController.applyUpdate("openAtLogin", v); },
  get bubbleFollowPet() { return bubbleFollowPet; },
  set bubbleFollowPet(v) { _settingsController.applyUpdate("bubbleFollowPet", v); },
  get hideBubbles() { return getAllBubblesHidden(); },
  set hideBubbles(v) { _settingsController.applyCommand("setAllBubblesHidden", { hidden: !!v }).catch((err) => {
    console.warn("Clawd: setAllBubblesHidden failed:", err && err.message);
  }); },
  get soundMuted() { return soundMuted; },
  set soundMuted(v) { _settingsController.applyUpdate("soundMuted", v); },
  get soundVolume() { return soundVolume; },
  get pendingPermissions() { return pendingPermissions; },
  repositionBubbles: () => repositionFloatingBubbles(),
  get petHidden() { return petHidden; },
  togglePetVisibility: () => togglePetVisibility(),
  bringPetToPrimaryDisplay: () => bringPetToPrimaryDisplay(),
  get isQuitting() { return isQuitting; },
  set isQuitting(v) { isQuitting = v; },
  get menuOpen() { return menuOpen; },
  set menuOpen(v) { menuOpen = v; },
  get tray() { return tray; },
  set tray(v) { tray = v; },
  get contextMenuOwner() { return contextMenuOwner; },
  set contextMenuOwner(v) { contextMenuOwner = v; },
  get contextMenu() { return contextMenu; },
  set contextMenu(v) { contextMenu = v; },
  enableDoNotDisturb: () => enableDoNotDisturb(),
  disableDoNotDisturb: () => disableDoNotDisturb(),
  enterMiniViaMenu: () => enterMiniViaMenu(),
  exitMiniMode: () => exitMiniMode(),
  getMiniMode: () => _mini.getMiniMode(),
  getMiniTransitioning: () => _mini.getMiniTransitioning(),
  miniHandleResize: (sizeKey) => _mini.handleResize(sizeKey),
  checkForUpdates: (...args) => checkForUpdates(...args),
  getUpdateMenuItem: () => getUpdateMenuItem(),
  openDashboard: () => showDashboard(),
  // The settings controller is the only writer of persisted prefs. Toggle
  // setters above route through it; resize/sendToDisplay use
  // flushRuntimeStateToPrefs to capture window bounds after movement.
  flushRuntimeStateToPrefs,
  settings: _settingsController,
  syncHitWin,
  getPetWindowBounds,
  applyPetWindowBounds,
  getCurrentPixelSize,
  getEffectiveCurrentPixelSize,
  getPixelSizeFor,
  isProportionalMode,
  PROPORTIONAL_RATIOS,
  getHookServerPort: () => getHookServerPort(),
  clampToScreenVisual,
  getNearestWorkArea,
  reapplyMacVisibility,
  discoverThemes: () => themeLoader.discoverThemes(),
  getActiveThemeId: () => activeTheme ? activeTheme._id : "clawd",
  getActiveThemeCapabilities: () => activeTheme ? activeTheme._capabilities : null,
  ensureUserThemesDir: () => themeLoader.ensureUserThemesDir(),
  openSettingsWindow: () => openSettingsWindow(),
};
const _menu = require("./menu")(_menuCtx);
const { t, buildContextMenu, buildTrayMenu, rebuildAllMenus, createTray,
        destroyTray, showPetContextMenu, ensureContextMenuOwner,
        requestAppQuit, applyDockVisibility } = _menu;

// ── Settings subscribers ──
//
// Single source of truth: any change to `_settingsController` lands here
// first. We update the mirror caches above (so existing sync read sites
// still work), then fire reactive side effects (menu rebuild, permission
// shortcut resync, bubble reposition, etc.). Setters in the ctx above
// route writes through the controller, so menu clicks and IPC updates
// from a future settings panel land here identically.
const MENU_AFFECTING_KEYS = new Set([
  "lang", "soundMuted", "bubbleFollowPet", "hideBubbles", "permissionBubblesEnabled",
  "notificationBubbleAutoCloseSeconds", "updateBubbleAutoCloseSeconds",
  "manageClaudeHooksAutomatically", "autoStartWithClaude", "openAtLogin", "showTray", "showDock", "theme", "size",
  "sessionAliases",
]);
let lastTogglePetShortcut = ((_settingsController.getSnapshot().shortcuts) || {}).togglePet || null;

function wireSettingsSubscribers() {
  _settingsController.subscribe(({ changes }) => {
    // 1. Update mirror caches first so any side-effect handler reads fresh values.
    if ("lang" in changes) lang = changes.lang;
    if ("size" in changes) currentSize = changes.size;
    if ("showTray" in changes) {
      showTray = changes.showTray;
      try { changes.showTray ? createTray() : destroyTray(); } catch (err) {
        console.warn("Clawd: tray toggle failed:", err && err.message);
      }
    }
    if ("showDock" in changes) {
      showDock = changes.showDock;
      try { applyDockVisibility(); } catch (err) {
        console.warn("Clawd: applyDockVisibility failed:", err && err.message);
      }
    }
    if ("manageClaudeHooksAutomatically" in changes) {
      manageClaudeHooksAutomatically = changes.manageClaudeHooksAutomatically;
    }
    // autoStartWithClaude / openAtLogin are object-form pre-commit gates in
    // settings-actions.js — by the time we get here the system call already
    // succeeded (or the commit was rejected), so the subscriber only needs
    // to update the mirror cache. No more registerHooks/setLoginItemSettings
    // here; that violates the unidirectional flow (see plan §4.2).
    if ("autoStartWithClaude" in changes) {
      autoStartWithClaude = changes.autoStartWithClaude;
    }
    if ("openAtLogin" in changes) {
      openAtLogin = changes.openAtLogin;
    }
    if ("bubbleFollowPet" in changes) bubbleFollowPet = changes.bubbleFollowPet;
    if ("sessionHudEnabled" in changes) sessionHudEnabled = changes.sessionHudEnabled;
    if ("sessionHudShowElapsed" in changes) sessionHudShowElapsed = changes.sessionHudShowElapsed;
    if ("sessionHudCleanupDetached" in changes) sessionHudCleanupDetached = changes.sessionHudCleanupDetached;
    if ("soundMuted" in changes) soundMuted = changes.soundMuted;
    if ("soundVolume" in changes) soundVolume = changes.soundVolume;
    if ("lowPowerIdleMode" in changes) {
      lowPowerIdleMode = changes.lowPowerIdleMode;
      sendToRenderer("low-power-idle-mode-change", lowPowerIdleMode);
    }
    if ("allowEdgePinning" in changes) allowEdgePinningCached = changes.allowEdgePinning;
    if ("keepSizeAcrossDisplays" in changes) keepSizeAcrossDisplaysCached = changes.keepSizeAcrossDisplays;
    if ("lang" in changes) {
      try { sendDashboardI18n(); } catch (err) {
        console.warn("Clawd: dashboard lang broadcast failed:", err && err.message);
      }
      try { sendSessionHudI18n(); } catch (err) {
        console.warn("Clawd: session HUD lang broadcast failed:", err && err.message);
      }
    }
    if ("sessionAliases" in changes) {
      try { _state.emitSessionSnapshot({ force: true }); } catch (err) {
        console.warn("Clawd: session alias snapshot broadcast failed:", err && err.message);
      }
    }

    // 2. Reactive side effects (mirror what the legacy setters / click handlers used to do).
    if ("hideBubbles" in changes || "permissionBubblesEnabled" in changes) {
      try { syncPermissionShortcuts(); } catch (err) {
        console.warn("Clawd: syncPermissionShortcuts failed:", err && err.message);
      }
    }
    if (
      ("permissionBubblesEnabled" in changes && changes.permissionBubblesEnabled === false) ||
      ("hideBubbles" in changes && changes.hideBubbles === true)
    ) {
      try {
        if (_perm && typeof _perm.dismissInteractivePermissionBubbles === "function") {
          _perm.dismissInteractivePermissionBubbles();
        }
      } catch (err) {
        console.warn("Clawd: dismiss interactive bubbles failed:", err && err.message);
      }
    }
    if (
      ("notificationBubbleAutoCloseSeconds" in changes && changes.notificationBubbleAutoCloseSeconds === 0) ||
      ("hideBubbles" in changes && changes.hideBubbles === true)
      ) {
        try {
          clearCodexNotifyBubbles(undefined, "settings-policy-disabled");
          clearKimiNotifyBubbles(undefined, "settings-policy-disabled");
        } catch (err) {
          console.warn("Clawd: clear notification bubbles failed:", err && err.message);
        }
    } else if (
      "notificationBubbleAutoCloseSeconds" in changes &&
      changes.notificationBubbleAutoCloseSeconds > 0
    ) {
      try {
        if (_perm && typeof _perm.refreshPassiveNotifyAutoClose === "function") {
          _perm.refreshPassiveNotifyAutoClose();
        }
      } catch (err) {
        console.warn("Clawd: refresh notification bubble timers failed:", err && err.message);
      }
    }
    if (
      ("updateBubbleAutoCloseSeconds" in changes && changes.updateBubbleAutoCloseSeconds === 0) ||
      ("hideBubbles" in changes && changes.hideBubbles === true)
    ) {
      try {
        if (_updateBubble && typeof _updateBubble.hideForPolicy === "function") _updateBubble.hideForPolicy();
      } catch (err) {
        console.warn("Clawd: hide update bubble failed:", err && err.message);
      }
    } else if (
      "updateBubbleAutoCloseSeconds" in changes &&
      changes.updateBubbleAutoCloseSeconds > 0
    ) {
      try {
        if (_updateBubble && typeof _updateBubble.refreshAutoCloseForPolicy === "function") {
          _updateBubble.refreshAutoCloseForPolicy();
        }
      } catch (err) {
        console.warn("Clawd: refresh update bubble timer failed:", err && err.message);
      }
    }
    if ("bubbleFollowPet" in changes) {
      try { repositionFloatingBubbles(); } catch (err) {
        console.warn("Clawd: repositionFloatingBubbles failed:", err && err.message);
      }
    }
    if ("sessionHudEnabled" in changes || "sessionHudShowElapsed" in changes) {
      try {
        syncSessionHudVisibility();
        repositionFloatingBubbles();
      } catch (err) {
        console.warn("Clawd: session HUD setting sync failed:", err && err.message);
      }
    }
    if ("sessionHudCleanupDetached" in changes && changes.sessionHudCleanupDetached === true) {
      try {
        _state.cleanStaleSessions();
        _state.emitSessionSnapshot({ force: true });
      } catch (err) {
        console.warn("Clawd: detached session cleanup sweep failed:", err && err.message);
      }
    } else if ("sessionHudCleanupDetached" in changes) {
      try {
        _state.emitSessionSnapshot({ force: true });
      } catch (err) {
        console.warn("Clawd: detached session cleanup snapshot refresh failed:", err && err.message);
      }
    }
    if ("allowEdgePinning" in changes) {
      try {
        if (
          win && !win.isDestroyed() &&
          !dragLocked &&
          !_mini.getMiniMode() &&
          !_mini.getMiniTransitioning()
        ) {
          const size = getEffectiveCurrentPixelSize();
          const virtualBounds = getPetWindowBounds();
          const clamped = computeFinalDragBounds(virtualBounds, size, clampToScreenVisual);
          if (clamped) applyPetWindowBounds(clamped);
          syncHitWin();
          repositionFloatingBubbles();
        }
      } catch (err) {
        console.warn("Clawd: allowEdgePinning re-clamp failed:", err && err.message);
      }
    }

    // 3. Menu rebuild — only for menu-affecting keys to avoid thrashing on
    //    window position / mini state changes.
    for (const key of Object.keys(changes)) {
      if (MENU_AFFECTING_KEYS.has(key)) {
        try { rebuildAllMenus(); } catch (err) {
          console.warn("Clawd: rebuildAllMenus failed:", err && err.message);
        }
        break;
      }
    }

    // 4. Broadcast to all renderer windows for the future settings panel.
    try {
      for (const bw of BrowserWindow.getAllWindows()) {
        if (!bw.isDestroyed() && bw.webContents && !bw.webContents.isDestroyed()) {
          bw.webContents.send("settings-changed", { changes, snapshot: _settingsController.getSnapshot() });
        }
      }
    } catch (err) {
      console.warn("Clawd: settings-changed broadcast failed:", err && err.message);
    }
  });
}
wireSettingsSubscribers();
_settingsController.subscribeKey("shortcuts", (_value, snapshot) => {
  const nextTogglePetShortcut = (snapshot && snapshot.shortcuts && snapshot.shortcuts.togglePet) || null;
  if (nextTogglePetShortcut === lastTogglePetShortcut) return;
  lastTogglePetShortcut = nextTogglePetShortcut;
  try { rebuildAllMenus(); } catch (err) {
    console.warn("Clawd: rebuildAllMenus failed:", err && err.message);
  }
});

const ANIMATION_OVERRIDE_ASSET_EXTS = new Set([".svg", ".gif", ".apng", ".png", ".webp", ".jpg", ".jpeg"]);
const ANIMATION_OVERRIDE_PREVIEW_POSTER_SIZE = { width: 176, height: 144 };
const ANIMATION_OVERRIDE_PREVIEW_POSTER_VERSION = 2;
const ANIMATION_OVERRIDE_PREVIEW_POSTER_CACHE_MAX = 192;
const ANIMATION_OVERRIDE_PREVIEW_POSTER_TIMEOUT_MS = 30000;
let animationOverridePreviewTimer = null;
let animationOverridePreviewPosterWindow = null;
let animationOverridePreviewPosterReady = null;
let animationOverridePreviewPosterQueue = Promise.resolve();
const animationOverridePreviewPosterCache = new Map();
const animationOverridePreviewPosterPendingKeys = new Set();
let animationOverridePreviewPosterGenerationId = 0;
// Tasks queued while activateTheme()'s reload is in progress. Anything that
// needs to talk to the renderer after a fresh theme load (e.g. the preview
// animation triggered right after a setAnimationOverride) lands here and fires
// once both webContents finish reloading. See _previewAnimationOverride.
let _pendingPostReloadTasks = [];
function _runPendingPostReloadTasks() {
  const tasks = _pendingPostReloadTasks;
  _pendingPostReloadTasks = [];
  for (const task of tasks) {
    try { task(); } catch (err) { console.warn("Clawd: post-reload task threw:", err && err.message); }
  }
}

function _buildFileUrl(absPath) {
  try { return pathToFileURL(absPath).href; }
  catch { return null; }
}

function _resolveAnimationAssetAbsPath(filename, theme = activeTheme) {
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

// Cheap regex-based viewBox/width-height parser for SVG. The renderer already
// uses an <object> element that resolves these at paint time, but for the
// aspect-ratio warning we compute it in main so the settings panel sees it on
// initial render without round-tripping through the renderer.
function _readSvgAspectRatio(absPath) {
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
  } catch { /* swallow — callers treat null as "unknown, skip warn" */ }
  return null;
}

// Warn when a user-overridden file's aspect ratio diverges enough from the
// original that the theme's hitbox / objectScale assumptions likely no longer
// line up. Currently only meaningful for SVG → SVG swaps — bitmap formats
// skip silently rather than mislead with a false-negative.
const ASPECT_RATIO_WARN_THRESHOLD = 0.15;

function _computeAspectRatioWarning(baseFile, currentFile) {
  if (!baseFile || !currentFile) return null;
  if (baseFile === currentFile) return null;
  const lowerBase = baseFile.toLowerCase();
  const lowerCurrent = currentFile.toLowerCase();
  if (!lowerBase.endsWith(".svg") || !lowerCurrent.endsWith(".svg")) return null;
  const basePath = _resolveAnimationAssetAbsPath(baseFile);
  const currentPath = _resolveAnimationAssetAbsPath(currentFile);
  if (!basePath || !currentPath) return null;
  const baseAspect = _readSvgAspectRatio(basePath);
  const currentAspect = _readSvgAspectRatio(currentPath);
  if (baseAspect == null || currentAspect == null) return null;
  const diffRatio = Math.abs(baseAspect - currentAspect) / baseAspect;
  if (diffRatio < ASPECT_RATIO_WARN_THRESHOLD) return null;
  return {
    baseAspect,
    currentAspect,
    diffRatio,
  };
}

function _computeCardHitboxInfo(currentFile, themeOverrideMap) {
  if (!currentFile || !activeTheme) {
    return { wideHitboxEnabled: false, wideHitboxOverridden: false };
  }
  const wideFiles = Array.isArray(activeTheme.wideHitboxFiles) ? activeTheme.wideHitboxFiles : [];
  const wideHitboxEnabled = wideFiles.includes(currentFile);
  const overrideWide = themeOverrideMap && themeOverrideMap.hitbox && themeOverrideMap.hitbox.wide;
  const wideHitboxOverridden = !!(overrideWide
    && Object.prototype.hasOwnProperty.call(overrideWide, currentFile));
  return { wideHitboxEnabled, wideHitboxOverridden };
}

function _resolveAnimationAssetsDir(theme = activeTheme) {
  if (!theme) return null;
  const themeAssetsDir = theme._themeDir ? path.join(theme._themeDir, "assets") : null;
  if (themeAssetsDir && fs.existsSync(themeAssetsDir)) return themeAssetsDir;
  const idleFile = theme.states && theme.states.idle && theme.states.idle[0];
  if (!idleFile) return null;
  const resolved = themeLoader.getAssetPath(idleFile);
  return resolved ? path.dirname(resolved) : null;
}

function _resolveOpenableFsPath(absPath) {
  if (!absPath || !app.isPackaged) return absPath;
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  if (!absPath.includes(asarSegment)) return absPath;
  const unpackedPath = absPath.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`);
  return fs.existsSync(unpackedPath) ? unpackedPath : absPath;
}

function _buildAnimationAssetUrl(filename, theme = activeTheme) {
  const absPath = _resolveAnimationAssetAbsPath(filename, theme);
  return absPath ? _buildFileUrl(absPath) : null;
}

function _isTrustedScriptedAnimationFile(filename, theme = activeTheme) {
  if (!filename || !theme || !theme._builtin || !theme.trustedRuntime) return false;
  const scriptedFiles = Array.isArray(theme.trustedRuntime.scriptedSvgFiles)
    ? theme.trustedRuntime.scriptedSvgFiles
    : [];
  const base = path.basename(filename);
  return scriptedFiles.includes(base);
}

function _isObjectChannelSvgAnimationFile(filename, theme = activeTheme) {
  return !!(
    filename
    && theme
    && theme.rendering
    && theme.rendering.svgChannel === "object"
    && path.extname(filename).toLowerCase() === ".svg"
  );
}

function _needsScriptedAnimationPreviewPoster(filename, theme = activeTheme) {
  return _isTrustedScriptedAnimationFile(filename, theme)
    || _isObjectChannelSvgAnimationFile(filename, theme);
}

function _getTrustedScriptedAnimationCycleMs(filename, theme = activeTheme) {
  if (!_isTrustedScriptedAnimationFile(filename, theme)) return null;
  const cycleMap = theme && theme.trustedRuntime && theme.trustedRuntime.scriptedSvgCycleMs;
  const ms = cycleMap && cycleMap[path.basename(filename)];
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function _rememberAnimationPreviewPosterCache(cacheKey, dataUrl) {
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

function _readAnimationPreviewPosterCache(cacheKey) {
  if (!cacheKey || !animationOverridePreviewPosterCache.has(cacheKey)) return null;
  const dataUrl = animationOverridePreviewPosterCache.get(cacheKey);
  animationOverridePreviewPosterCache.delete(cacheKey);
  animationOverridePreviewPosterCache.set(cacheKey, dataUrl);
  return dataUrl;
}

function _buildAnimationPreviewPosterDescriptor(filename, theme, absPath) {
  if (!filename || !theme || !absPath) return null;
  try {
    const stat = fs.statSync(absPath);
    const themeId = theme && theme._id ? theme._id : "theme";
    const safeFilename = path.basename(filename);
    return {
      themeId,
      filename: safeFilename,
      absPath,
      fileUrl: _buildFileUrl(absPath),
      posterVersion: ANIMATION_OVERRIDE_PREVIEW_POSTER_VERSION,
      size: stat.size,
      mtime: Math.round(stat.mtimeMs),
      cacheKey: `${ANIMATION_OVERRIDE_PREVIEW_POSTER_VERSION}|${themeId}|${safeFilename}|${stat.size}|${Math.round(stat.mtimeMs)}`,
    };
  } catch {
    return null;
  }
}

function _buildAnimationAssetPreview(filename, theme = activeTheme, resolvedAbsPath = null) {
  const absPath = resolvedAbsPath || _resolveAnimationAssetAbsPath(filename, theme);
  const fileUrl = absPath ? _buildFileUrl(absPath) : null;
  const needsPoster = _needsScriptedAnimationPreviewPoster(filename, theme);
  if (!needsPoster) {
    return {
      fileUrl,
      previewImageUrl: fileUrl,
      needsScriptedPreviewPoster: false,
      previewPosterCacheKey: null,
      previewPosterPending: false,
    };
  }

  const descriptor = _buildAnimationPreviewPosterDescriptor(filename, theme, absPath);
  const cachedPoster = descriptor ? _readAnimationPreviewPosterCache(descriptor.cacheKey) : null;
  return {
    fileUrl,
    previewImageUrl: cachedPoster,
    needsScriptedPreviewPoster: true,
    previewPosterCacheKey: descriptor ? descriptor.cacheKey : null,
    previewPosterPending: !!(descriptor && !cachedPoster),
  };
}

function _animationPreviewDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _getAnimationPreviewPosterWindow() {
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

async function _ensureAnimationPreviewPosterPage() {
  const posterWindow = _getAnimationPreviewPosterWindow();
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

function _withAnimationPreviewPosterTimeout(promise) {
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

function _destroyAnimationPreviewPosterWindow() {
  if (animationOverridePreviewPosterWindow && !animationOverridePreviewPosterWindow.isDestroyed()) {
    animationOverridePreviewPosterWindow.destroy();
  }
  animationOverridePreviewPosterWindow = null;
  animationOverridePreviewPosterReady = null;
}

async function _captureAnimationPreviewPosterDataUrl(fileUrl) {
  if (!fileUrl) return null;
  const capture = async () => {
    const posterWindow = await _ensureAnimationPreviewPosterPage();
    if (!posterWindow || posterWindow.isDestroyed()) return null;
    const webContents = posterWindow.webContents;
    if (!webContents || webContents.isDestroyed()) return null;
    await webContents.executeJavaScript(`window.renderAnimationPreviewPoster(${JSON.stringify(fileUrl)})`, true);
    await _animationPreviewDelay(20);
    const image = await webContents.capturePage({
      x: 0,
      y: 0,
      width: ANIMATION_OVERRIDE_PREVIEW_POSTER_SIZE.width,
      height: ANIMATION_OVERRIDE_PREVIEW_POSTER_SIZE.height,
    });
    return image && typeof image.toDataURL === "function" ? image.toDataURL() : null;
  };

  try {
    return await _withAnimationPreviewPosterTimeout(capture());
  } catch (err) {
    if (err && err.code === "ANIMATION_PREVIEW_POSTER_TIMEOUT") {
      _destroyAnimationPreviewPosterWindow();
    }
    throw err;
  }
}

function _getLiveSettingsWebContents() {
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

function _bumpAnimationPreviewPosterGeneration() {
  animationOverridePreviewPosterGenerationId += 1;
  return animationOverridePreviewPosterGenerationId;
}

function _maybeDestroyIdleAnimationPreviewPosterWindow() {
  if (animationOverridePreviewPosterPendingKeys.size > 0) return;
  if (_getLiveSettingsWebContents()) return;
  _destroyAnimationPreviewPosterWindow();
}

function _sendAnimationPreviewPosterReady(job, previewImageUrl) {
  if (!job || !previewImageUrl) return;
  const webContents = _getLiveSettingsWebContents();
  if (!webContents) return;
  webContents.send("settings:animation-preview-poster-ready", {
    themeId: job.themeId,
    filename: job.filename,
    previewImageUrl,
    previewPosterCacheKey: job.previewPosterCacheKey,
  });
}

async function _runAnimationPreviewPosterJob(job) {
  try {
    if (!job || !job.previewPosterCacheKey || !job.fileUrl) return;
    if (job.generationId !== animationOverridePreviewPosterGenerationId) return;
    if (!_getLiveSettingsWebContents()) return;

    // Current in-memory scheduling usually prevents this from hitting, but it
    // keeps queued jobs cheap if a later cache layer fills the key first.
    const cached = _readAnimationPreviewPosterCache(job.previewPosterCacheKey);
    if (cached) {
      _sendAnimationPreviewPosterReady(job, cached);
      return;
    }

    const previewImageUrl = await _captureAnimationPreviewPosterDataUrl(job.fileUrl);
    if (!previewImageUrl) return;
    _rememberAnimationPreviewPosterCache(job.previewPosterCacheKey, previewImageUrl);
    _sendAnimationPreviewPosterReady(job, previewImageUrl);
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
    _maybeDestroyIdleAnimationPreviewPosterWindow();
  }
}

function _enqueueAnimationPreviewPosterJob(job) {
  if (!job || !job.previewPosterCacheKey || !job.fileUrl) return;
  if (animationOverridePreviewPosterCache.has(job.previewPosterCacheKey)) return;
  if (animationOverridePreviewPosterPendingKeys.has(job.previewPosterCacheKey)) return;
  animationOverridePreviewPosterPendingKeys.add(job.previewPosterCacheKey);
  const run = () => _runAnimationPreviewPosterJob(job);
  animationOverridePreviewPosterQueue = animationOverridePreviewPosterQueue.then(run, run);
}

function _scheduleAnimationPreviewPosters(data) {
  const webContents = _getLiveSettingsWebContents();
  if (!webContents || !data || !data.theme || !data.theme.id) return;
  const themeId = data.theme.id;
  const generationId = animationOverridePreviewPosterGenerationId;
  const enqueue = (filename, fileUrl, previewPosterCacheKey, previewPosterPending) => {
    if (previewPosterPending !== true) return;
    if (!filename || !fileUrl || !previewPosterCacheKey) return;
    _enqueueAnimationPreviewPosterJob({
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

function _buildAnimationAssetProbe(file, theme = activeTheme, resolvedAbsPath = null) {
  const trustedCycleMs = _getTrustedScriptedAnimationCycleMs(file, theme);
  if (trustedCycleMs != null) {
    return {
      assetCycleMs: trustedCycleMs,
      assetCycleStatus: "exact",
      assetCycleSource: "trusted-runtime",
    };
  }
  const absPath = resolvedAbsPath || _resolveAnimationAssetAbsPath(file, theme);
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

function _readCurrentThemeOverrideMap() {
  const themeId = activeTheme && activeTheme._id;
  if (!themeId || !_settingsController || typeof _settingsController.getSnapshot !== "function") return null;
  const snapshot = _settingsController.getSnapshot();
  return snapshot && snapshot.themeOverrides ? snapshot.themeOverrides[themeId] || null : null;
}

function _hasExplicitAutoReturnOverride(themeOverrideMap, stateKey) {
  const autoReturn = themeOverrideMap && themeOverrideMap.timings && themeOverrideMap.timings.autoReturn;
  return !!(autoReturn && Object.prototype.hasOwnProperty.call(autoReturn, stateKey));
}

function _buildTimingHint(file, fallbackMs = null) {
  const assetProbe = _buildAnimationAssetProbe(file);
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

function _listAnimationOverrideAssets(theme = activeTheme) {
  if (!theme) return [];
  const dirs = [];
  const primaryDir = _resolveAnimationAssetsDir(theme);
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
      const absPath = _resolveAnimationAssetAbsPath(entry.name, theme) || path.join(dir, entry.name);
      const preview = _buildAnimationAssetPreview(entry.name, theme, absPath);
      const probe = _buildAnimationAssetProbe(entry.name, theme, absPath);
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

function _readResolvedTransition(file) {
  const entry = activeTheme && activeTheme.transitions && activeTheme.transitions[file];
  return {
    in: entry && Number.isFinite(entry.in) ? entry.in : 150,
    out: entry && Number.isFinite(entry.out) ? entry.out : 150,
  };
}

function _hasOwnStateFiles(stateKey) {
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

function _buildTierCardGroup(tierGroup, triggerKind, resolvedTiers, baseTiers, baseHintMap, sectionId = "work") {
  if (!Array.isArray(resolvedTiers)) return [];
  return resolvedTiers.map((tier, index) => {
    const baseTier = Array.isArray(baseTiers) ? baseTiers[index] : null;
    const originalFile = (baseTier && baseTier.originalFile) || tier.file;
    const higherTier = index === 0 ? null : resolvedTiers[index - 1];
    const maxSessions = higherTier ? Math.max(tier.minSessions, higherTier.minSessions - 1) : null;
    const hintTarget = baseHintMap && baseHintMap[originalFile];
    const timingHint = _buildTimingHint(tier.file);
    const preview = _buildAnimationAssetPreview(tier.file);
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
      transition: _readResolvedTransition(tier.file),
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

function _getResolvedStateCardBinding(stateKey) {
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

function _buildStateCard(stateKey, triggerKind, themeOverrideMap, options = {}) {
  const resolved = _getResolvedStateCardBinding(stateKey);
  if (!resolved || !resolved.currentFile) return null;
  const currentFile = resolved.currentFile;
  const autoReturnMap = (activeTheme && activeTheme.timings && activeTheme.timings.autoReturn) || {};
  const supportsAutoReturn = Object.prototype.hasOwnProperty.call(autoReturnMap, stateKey);
  const resolvedAutoReturnMs = supportsAutoReturn ? autoReturnMap[stateKey] : null;
  const timingHint = _buildTimingHint(currentFile, resolvedAutoReturnMs);
  const fallbackTargetState = resolved.fallbackTargetState;
  const preview = _buildAnimationAssetPreview(currentFile);
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
    transition: _readResolvedTransition(currentFile),
    supportsAutoReturn,
    supportsDuration: false,
    autoReturnMs: resolvedAutoReturnMs,
    durationMs: null,
    hasAutoReturnOverride: supportsAutoReturn ? _hasExplicitAutoReturnOverride(themeOverrideMap, stateKey) : false,
    ...timingHint,
    displayHintWarning: false,
    displayHintTarget: null,
  };
}

function _buildIdleAnimationCards(themeOverrideMap) {
  if (!activeTheme || !Array.isArray(activeTheme.idleAnimations)) return [];
  const baseIdleAnimations = (activeTheme._bindingBase && activeTheme._bindingBase.idleAnimations) || [];
  const overrideMap = themeOverrideMap && themeOverrideMap.idleAnimations;
  return activeTheme.idleAnimations
    .map((entry, index) => {
      if (!entry || typeof entry.file !== "string" || !entry.file) return null;
      const baseEntry = baseIdleAnimations[index] || null;
      const originalFile = (baseEntry && baseEntry.originalFile) || entry.file;
      const durationMs = Number.isFinite(entry.duration) ? entry.duration : null;
      const timingHint = _buildTimingHint(entry.file, durationMs);
      const preview = _buildAnimationAssetPreview(entry.file);
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
        transition: _readResolvedTransition(entry.file),
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

const REACTION_ORDER = [
  { key: "drag",       triggerKind: "dragReaction",       supportsDuration: false },
  { key: "clickLeft",  triggerKind: "clickLeftReaction",  supportsDuration: true  },
  { key: "clickRight", triggerKind: "clickRightReaction", supportsDuration: true  },
  { key: "annoyed",    triggerKind: "annoyedReaction",    supportsDuration: true  },
  { key: "double",     triggerKind: "doubleReaction",     supportsDuration: true  },
];

function _buildReactionCards(themeOverrideMap) {
  if (!activeTheme || !_isPlainObject(activeTheme.reactions)) return [];
  const reactionsMap = activeTheme.reactions;
  const overrideMap = themeOverrideMap && themeOverrideMap.reactions;
  const cards = [];
  for (const spec of REACTION_ORDER) {
    const reactionEntry = reactionsMap[spec.key];
    if (!_isPlainObject(reactionEntry)) continue;
    // `double` carries a random pool (files[]); MVP exposes only files[0].
    // Other reactions carry a single file under `file`.
    const currentFile = (Array.isArray(reactionEntry.files) && reactionEntry.files[0])
      || reactionEntry.file
      || null;
    if (!currentFile) continue;
    const durationMs = spec.supportsDuration && Number.isFinite(reactionEntry.duration)
      ? reactionEntry.duration
      : null;
    const timingHint = _buildTimingHint(currentFile, durationMs);
    const preview = _buildAnimationAssetPreview(currentFile);
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
      transition: _readResolvedTransition(currentFile),
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

function _pushSection(sections, id, mode, cards) {
  if (!Array.isArray(cards) || cards.length === 0) return;
  sections.push({ id, mode: mode || null, cards });
}

function _buildAnimationOverrideSections() {
  if (!activeTheme) return [];
  const themeOverrideMap = _readCurrentThemeOverrideMap();
  const sections = [];
  const thinking = _buildStateCard("thinking", "thinking", themeOverrideMap);
  const baseBindings = activeTheme._bindingBase || {};
  const workCards = [];
  if (thinking) {
    thinking.sectionId = "work";
    workCards.push(thinking);
  }
  workCards.push(..._buildTierCardGroup(
    "workingTiers",
    "working",
    activeTheme.workingTiers || [],
    baseBindings.workingTiers || [],
    baseBindings.displayHintMap || {},
    "work"
  ));
  workCards.push(..._buildTierCardGroup(
    "jugglingTiers",
    "juggling",
    activeTheme.jugglingTiers || [],
    baseBindings.jugglingTiers || [],
    baseBindings.displayHintMap || {},
    "work"
  ));
  _pushSection(sections, "work", null, workCards);

  const idleMode = activeTheme._capabilities && activeTheme._capabilities.idleMode;
  if (idleMode === "animated") {
    _pushSection(sections, "idle", idleMode, _buildIdleAnimationCards(themeOverrideMap));
  } else {
    const idleCard = _buildStateCard("idle", idleMode === "tracked" ? "idleTracked" : "idleStatic", themeOverrideMap, {
      sectionId: "idle",
    });
    _pushSection(sections, "idle", idleMode, idleCard ? [idleCard] : []);
  }

  const interruptCards = [];
  for (const [stateKey, triggerKind] of [
    ["error", "error"],
    ["attention", "attention"],
    ["notification", "notification"],
    ["sweeping", "sweeping"],
    ["carrying", "carrying"],
  ]) {
    const card = _buildStateCard(stateKey, triggerKind, themeOverrideMap, { sectionId: "interrupts" });
    if (card) interruptCards.push(card);
  }
  _pushSection(sections, "interrupts", null, interruptCards);

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
    const card = _buildStateCard(stateKey, triggerKind, themeOverrideMap, { sectionId: "sleep" });
    if (card) sleepCards.push(card);
  }
  if (_hasOwnStateFiles("waking")) {
    const waking = _buildStateCard("waking", "waking", themeOverrideMap, { sectionId: "sleep" });
    if (waking) sleepCards.push(waking);
  }
  _pushSection(sections, "sleep", sleepMode, sleepCards);

  const reactionCards = _buildReactionCards(themeOverrideMap);
  _pushSection(sections, "reactions", null, reactionCards);

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
      const card = _buildStateCard(stateKey, stateKey, themeOverrideMap, {
        sectionId: "mini",
        bindingPathPrefix: "miniMode.states",
      });
      if (card) miniCards.push(card);
    }
    _pushSection(sections, "mini", null, miniCards);
  }

  // Annotate every card with wide-hitbox status + aspect-ratio warning so the
  // settings panel drawer can render the toggle + warning banner. Reactions
  // are intentionally skipped — they're renderer-owned click animations that
  // don't consume HIT_BOXES.
  for (const section of sections) {
    if (!section || !Array.isArray(section.cards)) continue;
    if (section.id === "reactions") continue;
    for (const card of section.cards) {
      const { wideHitboxEnabled, wideHitboxOverridden } = _computeCardHitboxInfo(card.currentFile, themeOverrideMap);
      card.wideHitboxEnabled = wideHitboxEnabled;
      card.wideHitboxOverridden = wideHitboxOverridden;
      card.aspectRatioWarning = _computeAspectRatioWarning(card.baseFile, card.currentFile);
    }
  }

  return sections;
}

// Flat list of replaceable sound slots for the current theme. Enumerates every
// key the theme publishes under `sounds` (default DEFAULT_SOUNDS keys + anything
// theme authors added), so custom themes that ship extra sound names become
// replaceable automatically. UI labels the default `complete`/`confirm` pair via
// i18n and falls back to the raw key for custom names.
function _buildSoundOverrideSlots() {
  if (!activeTheme || !_isPlainObject(activeTheme.sounds)) return [];
  const themeOverrideMap = _readCurrentThemeOverrideMap();
  const overrideSoundsMap = themeOverrideMap && _isPlainObject(themeOverrideMap.sounds)
    ? themeOverrideMap.sounds : null;
  const runtimeOverrideMap = activeTheme && _isPlainObject(activeTheme._soundOverrideFiles)
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

function _rememberRuntimeSoundOverrideFile(themeId, soundName, absPath) {
  if (!activeTheme || activeTheme._id !== themeId) return;
  if (typeof soundName !== "string" || !soundName) return;
  if (typeof absPath !== "string" || !absPath) return;
  const nextOverrideMap = _isPlainObject(activeTheme._soundOverrideFiles)
    ? { ...activeTheme._soundOverrideFiles }
    : {};
  nextOverrideMap[soundName] = absPath;
  activeTheme._soundOverrideFiles = nextOverrideMap;
}

function _buildAnimationOverrideData() {
  if (!activeTheme) return null;
  const meta = themeLoader.getThemeMetadata(activeTheme._id) || {};
  const sections = _buildAnimationOverrideSections();
  const data = {
    theme: {
      id: activeTheme._id,
      name: meta.name || activeTheme._id,
      variantId: activeTheme._variantId || "default",
      assetsDir: _resolveAnimationAssetsDir(activeTheme),
      capabilities: activeTheme._capabilities || meta.capabilities || null,
    },
    assets: _listAnimationOverrideAssets(activeTheme),
    sections,
    cards: sections.flatMap((section) => section.cards || []),
    sounds: _buildSoundOverrideSlots(),
  };
  _scheduleAnimationPreviewPosters(data);
  return data;
}

function _previewAnimationOverride(payload) {
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
  if (!_state || typeof _state.applyState !== "function" || typeof _state.resolveDisplayState !== "function") {
    return { status: "error", message: "previewAnimationOverride requires state runtime" };
  }
  // When a preview is fired right after setAnimationOverride (the "Use this
  // file" flow), activateTheme() is still mid-reload: the renderer is tearing
  // down its webContents, so any IPC we send lands in a reloading window and
  // is racey with syncRendererStateAfterLoad() that fires when reload ends.
  // Defer until the reload is actually done — see _runPendingPostReloadTasks
  // hooked into activateTheme()'s onReady.
  if (themeReloadInProgress) {
    _pendingPostReloadTasks.push(() => _runAnimationOverridePreview(stateKey, file, durationMs));
    return { status: "ok", deferred: true };
  }
  return _runAnimationOverridePreview(stateKey, file, durationMs);
}

// Preview is a quick peek at the asset, not an unbounded playback. Hard clamp
// the hold duration:
//   · some assets have extremely long cycleMs (a SMIL animation with dur="60s"
//     or an indefinite loop that the cycle probe estimates high) — without a
//     ceiling the pet would be stuck on the preview SVG for that full duration
//   · trusted scripted SVGs can publish an explicit cycle in theme metadata;
//     those need enough room to show a complete Cloudling cycle while still
//     staying bounded
//   · the floor prevents sub-flash previews that finish before the renderer
//     has even painted the new SVG
const PREVIEW_HOLD_MIN_MS = 800;
const PREVIEW_HOLD_MAX_MS = 3500;
const TRUSTED_SCRIPTED_PREVIEW_HOLD_MAX_MS = 15000;

function _runAnimationOverridePreview(stateKey, file, durationMs) {
  if (animationOverridePreviewTimer) {
    clearTimeout(animationOverridePreviewTimer);
    animationOverridePreviewTimer = null;
  }
  try {
    _state.applyState(stateKey, file);
  } catch (err) {
    return { status: "error", message: `previewAnimationOverride: ${err && err.message}` };
  }
  const trustedScriptedCycleMs = _getTrustedScriptedAnimationCycleMs(file);
  const previewMaxMs = _isTrustedScriptedAnimationFile(file)
    ? TRUSTED_SCRIPTED_PREVIEW_HOLD_MAX_MS
    : PREVIEW_HOLD_MAX_MS;
  const requested = (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0)
    ? durationMs
    : (trustedScriptedCycleMs != null ? trustedScriptedCycleMs : PREVIEW_HOLD_MIN_MS);
  const holdMs = Math.max(PREVIEW_HOLD_MIN_MS, Math.min(previewMaxMs, requested));
  animationOverridePreviewTimer = setTimeout(() => {
    animationOverridePreviewTimer = null;
    try {
      // Unconditionally release back to idle at the end of the preview. Rationale:
      //   · continuous states (working/thinking/juggling) would otherwise stay
      //     latched on the preview SVG until the live session stales out (5 min)
      //   · oneshot states have their own autoReturn, but clamping preview duration means
      //     we'll usually beat it — forcing idle here keeps the exit consistent
      //   · if a hook event fires mid-preview and a live session is still active,
      //     the next event will re-upgrade state naturally — a brief idle flash
      //     is acceptable UX for a preview exit
      _state.applyState("idle", _state.getSvgOverride("idle"));
    } catch {}
  }, holdMs);
  return { status: "ok" };
}

// ── IPC: settings panel write entry points ──
// Renderer-side callers (the future settings panel) use these. Menu/main code
// in this process calls _settingsController directly — no IPC round-trip.
ipcMain.handle("dashboard:get-snapshot", () => _state.buildSessionSnapshot());
ipcMain.handle("dashboard:get-i18n", () => getDashboardI18nPayload());
ipcMain.on("dashboard:focus-session", (_event, sessionId) => focusDashboardSession(sessionId));
ipcMain.handle("dashboard:hide-session", (_event, sessionId) => hideDashboardSession(sessionId));
ipcMain.handle("dashboard:set-session-alias", async (_event, payload) => {
  return _settingsController.applyCommand("setSessionAlias", payload);
});
ipcMain.handle("session-hud:get-i18n", () => getDashboardI18nPayload());
ipcMain.on("session-hud:focus-session", (_event, sessionId) => focusDashboardSession(sessionId));
ipcMain.on("session-hud:open-dashboard", () => showDashboard());

ipcMain.handle("settings:get-snapshot", () => _settingsController.getSnapshot());
ipcMain.handle("settings:getShortcutFailures", () =>
  Object.fromEntries(shortcutRegistrationFailures)
);
ipcMain.handle("settings:enterShortcutRecording", (_event, actionId) =>
  startShortcutRecording(actionId)
);
ipcMain.handle("settings:exitShortcutRecording", () => {
  stopShortcutRecording();
  return { status: "ok" };
});
ipcMain.handle("settings:update", (_event, payload) => {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "settings:update payload must be { key, value }" };
  }
  return _settingsController.applyUpdate(payload.key, payload.value);
});
ipcMain.handle("settings:begin-size-preview", () => settingsSizePreviewSession.begin());
ipcMain.handle("settings:preview-size", (_event, value) => {
  if (!isValidSizePreviewKey(value)) {
    return { status: "error", message: `invalid preview size "${value}"` };
  }
  return settingsSizePreviewSession.preview(value).then(() => ({ status: "ok" }));
});
ipcMain.handle("settings:end-size-preview", (_event, value) => {
  if (value !== null && value !== undefined && !isValidSizePreviewKey(value)) {
    return { status: "error", message: `invalid preview size "${value}"` };
  }
  return settingsSizePreviewSession.end(value || null);
});
ipcMain.on("settings:open-dashboard", () => showDashboard());
ipcMain.handle("settings:get-preview-sound-url", () => {
  try { return themeLoader.getPreviewSoundUrl(); }
  catch { return null; }
});
ipcMain.handle("settings:command", async (_event, payload) => {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "settings:command payload must be { action, payload }" };
  }
  return _settingsController.applyCommand(payload.action, payload.payload);
});
ipcMain.handle("settings:get-animation-overrides-data", () => _buildAnimationOverrideData());
ipcMain.handle("settings:open-theme-assets-dir", async () => {
  const dir = _resolveOpenableFsPath(_resolveAnimationAssetsDir(activeTheme));
  if (!dir || !fs.existsSync(dir)) {
    return { status: "error", message: "theme assets directory unavailable" };
  }
  const result = await shell.openPath(dir);
  if (result) return { status: "error", message: result };
  return { status: "ok", path: dir };
});
ipcMain.handle("settings:preview-animation-override", (_event, payload) => _previewAnimationOverride(payload));

// ── Sound override IPC ──
// Audio extensions we accept for sound overrides. MIME decoding in the renderer
// is ultimately whatever Chromium supports; we restrict the dialog filter here
// to the common lossy + lossless formats a user is likely to bring in.
const SOUND_OVERRIDE_ASSET_EXTS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"]);
const SOUND_OVERRIDE_DIALOG_STRINGS = {
  en: { title: "Choose a sound file", filterName: "Audio" },
  zh: { title: "选择音效文件", filterName: "音频" },
  ko: { title: "음향 파일 선택", filterName: "오디오" },
  ja: { title: "音声ファイルを選択", filterName: "音声" },
};

function _getSettingsDialogParent(event) {
  return BrowserWindow.fromWebContents(event.sender) || settingsWindow || null;
}

function _cleanupSiblingSoundOverrides(overridesDir, soundName, keepExt) {
  // Replacing a sound with a different extension would otherwise leave the old
  // file as orphaned junk in the overrides dir (not referenced from prefs, but
  // still on disk). Strip siblings that share `soundName` but differ in ext so
  // the folder stays tidy and `Open folder` shows only what's active.
  let entries;
  try { entries = fs.readdirSync(overridesDir); }
  catch { return; }
  for (const entry of entries) {
    if (path.parse(entry).name !== soundName) continue;
    if (path.extname(entry).toLowerCase() === keepExt) continue;
    try { fs.unlinkSync(path.join(overridesDir, entry)); } catch {}
  }
}

ipcMain.handle("settings:pick-sound-file", async (event, payload) => {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "pickSoundFile payload must be an object" };
  }
  const { soundName } = payload;
  if (typeof soundName !== "string" || !soundName) {
    return { status: "error", message: "pickSoundFile.soundName must be a non-empty string" };
  }
  // soundName becomes a filename stem under sound-overrides/<themeId>/ — a
  // third-party theme could ship `sounds: { "../../foo": "x.mp3" }` and
  // weaponise this IPC as a write-anywhere primitive. Restrict to chars that
  // are unambiguously safe in a path segment on every supported OS.
  if (!/^[a-zA-Z0-9_-]+$/.test(soundName)) {
    return { status: "error", message: `pickSoundFile.soundName "${soundName}" contains invalid characters` };
  }
  if (!activeTheme) return { status: "error", message: "no active theme" };
  const themeId = activeTheme._id;
  // Only allow replacing sounds the theme actually publishes — overriding a
  // name state.js never triggers produces a silent override with no effect.
  if (!_isPlainObject(activeTheme.sounds) || !activeTheme.sounds[soundName]) {
    return { status: "error", message: `sound "${soundName}" not declared by theme "${themeId}"` };
  }
  const overridesDir = themeLoader.getSoundOverridesDir(themeId);
  if (!overridesDir) return { status: "error", message: "sound-overrides directory unavailable" };

  const parent = _getSettingsDialogParent(event);
  const s = SOUND_OVERRIDE_DIALOG_STRINGS[lang] || SOUND_OVERRIDE_DIALOG_STRINGS.en;
  const extList = [...SOUND_OVERRIDE_ASSET_EXTS].map((e) => e.slice(1));

  let result;
  try {
    result = await dialog.showOpenDialog(parent, {
      title: s.title,
      filters: [{ name: s.filterName, extensions: extList }],
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
  _cleanupSiblingSoundOverrides(overridesDir, soundName, ext);

  const cmdResult = await _settingsController.applyCommand("setSoundOverride", {
    themeId,
    soundName,
    file: destFilename,
    originalName: path.basename(sourcePath),
  });
  if (!cmdResult || cmdResult.status !== "ok") {
    return cmdResult || { status: "error", message: "setSoundOverride failed" };
  }
  // A missing override file may already exist in prefs from a prior run (for
  // example, the user deleted it manually from "Open overrides folder"). If
  // they re-pick the same basename/originalName pair, setSoundOverride() is a
  // noop and activateTheme() does not rebuild activeTheme._soundOverrideFiles.
  // Remember the freshly-copied file in the live theme so both UI and
  // playback immediately reflect the restored override.
  _rememberRuntimeSoundOverrideFile(themeId, soundName, destPath);
  // Same-filename replacements short-circuit setSoundOverride as a noop, so
  // activateTheme() never runs and the renderer's _audioCache keeps its old
  // Audio object for this URL — the user would hear the previous file on
  // every future trigger. Explicitly invalidate the cache entry for the
  // current sound URL so the next playback reloads from disk. Harmless when
  // activateTheme did run (renderer was reloaded, cache is already empty).
  const newUrl = themeLoader.getSoundUrl(soundName);
  if (newUrl) sendToRenderer("invalidate-sound-cache", newUrl);
  return { status: "ok", file: destFilename };
});

ipcMain.handle("settings:preview-sound", (_event, payload) => {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "previewSound payload must be an object" };
  }
  const { soundName } = payload;
  if (typeof soundName !== "string" || !soundName) {
    return { status: "error", message: "previewSound.soundName must be a non-empty string" };
  }
  // Mirror playSound()'s guards: DND / muted users clicking Play in Settings
  // would otherwise bypass the system they explicitly opted into (meetings,
  // shared spaces). Return a skipped status so the UI can stay silent.
  if (doNotDisturb) return { status: "skipped", reason: "dnd" };
  if (soundMuted) return { status: "skipped", reason: "muted" };
  const url = themeLoader.getSoundUrl(soundName);
  if (!url) return { status: "error", message: "sound unavailable" };
  // Cache-bust so the renderer's `_audioCache[url]` doesn't replay a stale
  // Audio object after the user swapped the override file. playSound() doesn't
  // need this because changing the override triggers activateTheme → renderer
  // reload, which clears the cache naturally; preview runs without reload.
  const bustedUrl = `${url}${url.includes("?") ? "&" : "?"}_t=${Date.now()}`;
  sendToRenderer("play-sound", { url: bustedUrl, volume: soundVolume });
  return { status: "ok" };
});

ipcMain.handle("settings:open-sound-overrides-dir", async () => {
  if (!activeTheme) return { status: "error", message: "no active theme" };
  const dir = themeLoader.getSoundOverridesDir(activeTheme._id);
  if (!dir) return { status: "error", message: "sound-overrides directory unavailable" };
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const openResult = await shell.openPath(dir);
  if (openResult) return { status: "error", message: openResult };
  return { status: "ok", path: dir };
});

// Reaction preview goes through the renderer's click-reaction channel
// (bypasses the state machine entirely — reactions are a renderer-owned
// visual layer, not a logical state). Duration is clamped to the same
// [800, 3500]ms window as state previews.
ipcMain.handle("settings:preview-reaction", (_event, payload) => {
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
});

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

ipcMain.handle("settings:export-animation-overrides", async (event) => {
  const s = ANIMATION_OVERRIDES_EXPORT_DIALOG_STRINGS[lang] || ANIMATION_OVERRIDES_EXPORT_DIALOG_STRINGS.en;
  const snapshot = _settingsController.getSnapshot();
  const overrides = (snapshot && snapshot.themeOverrides) || {};
  const parent = _getSettingsDialogParent(event);
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
});

ipcMain.handle("settings:import-animation-overrides", async (event) => {
  const s = ANIMATION_OVERRIDES_EXPORT_DIALOG_STRINGS[lang] || ANIMATION_OVERRIDES_EXPORT_DIALOG_STRINGS.en;
  const parent = _getSettingsDialogParent(event);
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

  const commandResult = await _settingsController.applyCommand("importAnimationOverrides", {
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
});

// Static metadata for the Agents tab: name, eventSource, capabilities.
// The renderer uses this (alongside the agents snapshot field) to render one
// row per agent. Static because it comes from agents/registry.js — no runtime
// state involved — so the renderer can cache the result and never has to
// re-fetch.
ipcMain.handle("settings:list-themes", () => {
  try {
    const activeId = activeTheme ? activeTheme._id : "clawd";
    return themeLoader.listThemesWithMetadata().map((t) =>
      _decorateCodexPetThemeMetadata({
        ...t,
        active: t.id === activeId,
      })
    );
  } catch (err) {
    console.warn("Clawd: settings:list-themes failed:", err && err.message);
    return [];
  }
});

ipcMain.handle("settings:refresh-codex-pets", () => _refreshCodexPetThemesFromSettings());

ipcMain.handle("settings:open-codex-pets-dir", async () => {
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
});

ipcMain.handle("settings:import-codex-pet-zip", async (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender) || settingsWindow || null;
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
      confirmReplaceExistingPackage: _confirmReplaceExistingCodexPetPackage,
    });
    const activated = await _materializeAndActivateImportedCodexPet(imported);
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
});

ipcMain.handle("settings:remove-codex-pet", async (_event, themeId) => {
  if (typeof themeId !== "string" || !themeId) return { status: "error", message: "themeId is required" };
  const target = _resolveCodexPetRemovalTarget(themeId);
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
      const confirmed = await _confirmRemoveImportedCodexPetPackage(displayName);
      if (!confirmed) return { status: "cancel" };
      await fs.promises.rm(target.packageDir, { recursive: true, force: true });
    }

    const refresh = await _refreshCodexPetThemesFromSettings();
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
});

// Kept in main so `dialog.showMessageBox` can take a BrowserWindow ref.
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
ipcMain.handle("settings:confirm-remove-theme", async (event, themeId) => {
  if (typeof themeId !== "string" || !themeId) return { confirmed: false };
  const meta = themeLoader.getThemeMetadata(themeId);
  const displayName = (meta && meta.name) || themeId;
  const parent = BrowserWindow.fromWebContents(event.sender) || settingsWindow || null;
  const s = REMOVE_THEME_DIALOG_STRINGS[lang] || REMOVE_THEME_DIALOG_STRINGS.en;
  try {
    const { response } = await dialog.showMessageBox(parent, {
      type: "warning",
      buttons: [s.delete, s.cancel],
      defaultId: 1,
      cancelId: 1,
      message: s.message(displayName),
      detail: s.detail,
      noLink: true,
    });
    return { confirmed: response === 0 };
  } catch (err) {
    console.warn("Clawd: confirm-remove-theme dialog failed:", err && err.message);
    return { confirmed: false };
  }
});


ipcMain.handle("settings:list-agents", () => {
  try {
    const { getAllAgents } = require("../agents/registry");
    return getAllAgents().map((a) => ({
      id: a.id,
      name: a.name,
      eventSource: a.eventSource,
      capabilities: a.capabilities || {},
    }));
  } catch (err) {
    console.warn("Clawd: settings:list-agents failed:", err && err.message);
    return [];
  }
});

// ── Auto-updater — delegated to src/updater.js ──
const _updaterCtx = {
  get doNotDisturb() { return doNotDisturb; },
  get miniMode() { return _mini.getMiniMode(); },
  get lang() { return lang; },
  t, rebuildAllMenus, updateLog,
  showUpdateBubble: (payload) => showUpdateBubble(payload),
  hideUpdateBubble: () => hideUpdateBubble(),
  setUpdateVisualState: (kind) => _state.setUpdateVisualState(kind),
  applyState: (state, svgOverride) => applyState(state, svgOverride),
  resolveDisplayState: () => resolveDisplayState(),
  getSvgOverride: (state) => getSvgOverride(state),
  resetSoundCooldown: () => resetSoundCooldown(),
};
const _updater = require("./updater")(_updaterCtx);
const { setupAutoUpdater, checkForUpdates, getUpdateMenuItem, getUpdateMenuLabel } = _updater;

// ── About tab IPC ──
// Hero SVG is inlined so the Settings renderer can access #shake-slot to
// drive the click reaction. Animation override posters are captured in a
// hidden renderer, so they cannot expose SVG internals to Settings either.
ipcMain.handle("settings:get-about-info", () => {
  const heroSvgAbsPath = path.join(__dirname, "..", "assets", "svg", "clawd-about-hero.svg");
  let heroSvgContent = "";
  try {
    heroSvgContent = fs.readFileSync(heroSvgAbsPath, "utf8");
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
ipcMain.handle("settings:check-for-updates", () => {
  try {
    checkForUpdates(true);
    return { status: "ok" };
  } catch (err) {
    return { status: "error", message: (err && err.message) || String(err) };
  }
});
ipcMain.handle("settings:open-external", async (_event, url) => {
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

// ── Doctor tab IPC ──
const { registerDoctorIpc } = require("./doctor-ipc");
registerDoctorIpc({
  ipcMain,
  app,
  shell,
  server: _server,
  getPrefsSnapshot: () => _settingsController.getSnapshot(),
  getDoNotDisturb: () => doNotDisturb,
  getLocale: () => _settingsController.get("lang") || "en",
});

// ── Settings panel window ──
//
// Single-instance, non-modal, system-titlebar BrowserWindow that hosts the
// settings UI. Reuses ipcMain.handle("settings:get-snapshot" / "settings:update")
// already wired up for the controller. The renderer subscribes to
// settings-changed broadcasts so menu changes and panel changes stay in sync.
let settingsWindow = null;
let settingsShortcutRecording = null;
const SIZE_PREVIEW_KEY_RE = /^P:\d+(?:\.\d+)?$/;

function isValidSizePreviewKey(value) {
  return typeof value === "string" && SIZE_PREVIEW_KEY_RE.test(value);
}

function beginSettingsSizePreviewProtection() {
  settingsSizePreviewSyncFrozen = true;
  if (!isWin) return;
  if (
    settingsWindow
    && !settingsWindow.isDestroyed()
    && typeof settingsWindow.setAlwaysOnTop === "function"
  ) {
    settingsWindow.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    if (typeof settingsWindow.moveTop === "function") settingsWindow.moveTop();
  }
  if (
    hitWin
    && !hitWin.isDestroyed()
    && typeof hitWin.setIgnoreMouseEvents === "function"
  ) {
    hitWin.setIgnoreMouseEvents(true);
  }
}

function endSettingsSizePreviewProtection() {
  settingsSizePreviewSyncFrozen = false;
  if (!isWin) return;
  if (
    settingsWindow
    && !settingsWindow.isDestroyed()
    && typeof settingsWindow.setAlwaysOnTop === "function"
  ) {
    settingsWindow.setAlwaysOnTop(false);
  }
  if (
    hitWin
    && !hitWin.isDestroyed()
    && typeof hitWin.setIgnoreMouseEvents === "function"
  ) {
    hitWin.setIgnoreMouseEvents(false);
    hitWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
  }
  reassertWinTopmost();
  scheduleHwndRecovery();
}

const settingsSizePreviewSession = createSettingsSizePreviewSession({
  beginProtection: async () => {
    beginSettingsSizePreviewProtection();
  },
  endProtection: async () => {
    endSettingsSizePreviewProtection();
  },
  applyPreview: async (sizeKey) => {
    if (!isValidSizePreviewKey(sizeKey)) {
      throw new Error(`invalid preview size "${sizeKey}"`);
    }
    if (_menu && typeof _menu.resizeWindow === "function") {
      _menu.resizeWindow(sizeKey, { mode: "preview" });
    }
  },
  commitFinal: async (sizeKey) => {
    if (!isValidSizePreviewKey(sizeKey)) {
      return { status: "error", message: `invalid preview size "${sizeKey}"` };
    }
    return _settingsController.applyCommand("resizePet", sizeKey);
  },
});

function stopShortcutRecording() {
  if (!settingsShortcutRecording) return;
  if (
    settingsWindow
    && !settingsWindow.isDestroyed()
    && settingsWindow.webContents
    && !settingsWindow.webContents.isDestroyed()
  ) {
    try {
      settingsWindow.webContents.removeListener(
        "before-input-event",
        settingsShortcutRecording.listener
      );
    } catch {}
  }

  // Restore the temporarily unregistered accelerator if prefs still hold the
  // same value (i.e. the user cancelled or pressed the same combo again so
  // the command was a noop). If prefs changed, applyPersistentShortcutChange
  // has already registered the new value — don't double-register.
  const { actionId, tempUnregisteredAccel } = settingsShortcutRecording;
  if (tempUnregisteredAccel) {
    const snapshot = _settingsController.getSnapshot();
    const current = snapshot && snapshot.shortcuts && snapshot.shortcuts[actionId];
    if (current === tempUnregisteredAccel) {
      const handler = actionId === "togglePet" ? togglePetVisibility : null;
      if (typeof handler === "function") {
        try { globalShortcut.register(tempUnregisteredAccel, handler); } catch {}
      }
    }
  }

  settingsShortcutRecording = null;
}

function startShortcutRecording(actionId) {
  if (!SHORTCUT_ACTIONS[actionId]) {
    return { status: "error", message: "unknown shortcut action" };
  }
  if (
    !settingsWindow
    || settingsWindow.isDestroyed()
    || !settingsWindow.webContents
    || settingsWindow.webContents.isDestroyed()
  ) {
    return { status: "error", message: "settings window unavailable" };
  }

  stopShortcutRecording();

  // Temporarily unregister this action's current persistent globalShortcut so
  // the user pressing their old combo doesn't fire the real handler (e.g.
  // hiding the pet) mid-recording. Contextual shortcuts (permission hotkeys)
  // manage their own lifecycle via syncPermissionShortcuts, skip them.
  let tempUnregisteredAccel = null;
  const meta = SHORTCUT_ACTIONS[actionId];
  if (meta && meta.persistent) {
    const snapshot = _settingsController.getSnapshot();
    const current = snapshot && snapshot.shortcuts && snapshot.shortcuts[actionId];
    if (current) {
      try {
        if (globalShortcut.isRegistered(current)) {
          globalShortcut.unregister(current);
          tempUnregisteredAccel = current;
        }
      } catch {}
    }
  }

  const listener = (event, input) => {
    if (!input || input.type !== "keyDown") return;
    event.preventDefault();
    settingsWindow.webContents.send("shortcut-record-key", {
      actionId,
      key: input.key,
      code: input.code,
      altKey: !!input.alt,
      ctrlKey: !!input.control,
      metaKey: !!input.meta,
      shiftKey: !!input.shift,
    });
  };
  settingsWindow.webContents.on("before-input-event", listener);
  settingsShortcutRecording = { actionId, listener, tempUnregisteredAccel };
  return { status: "ok" };
}

function getSettingsWindowIcon() {
  return getSettingsWindowIconPath({
    platform: process.platform,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appDir: path.join(__dirname, ".."),
    existsSync: fs.existsSync,
  });
}

function getSettingsWindowTaskbarDetails() {
  return getSettingsWindowTaskbarDetailsHelper({
    platform: process.platform,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appDir: path.join(__dirname, ".."),
    execPath: process.execPath,
    appPath: app.getAppPath(),
    existsSync: fs.existsSync,
  });
}

function openSettingsWindowWhenReady() {
  if (app.isReady()) {
    openSettingsWindow();
    return;
  }
  app.once("ready", openSettingsWindow);
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  const iconPath = getSettingsWindowIcon();
  const opts = {
    width: 800,
    height: 560,
    minWidth: 640,
    minHeight: 480,
    show: false,
    frame: true,
    transparent: false,
    resizable: true,
    minimizable: true,
    maximizable: true,
    skipTaskbar: false,
    alwaysOnTop: false,
    title: SETTINGS_WINDOW_TITLE,
    // Match settings.html's dark-mode palette to avoid a white flash before
    // CSS media query kicks in. Hex values must stay in sync with the
    // `--bg` CSS variable in settings.html for each theme.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c1f" : "#f5f5f7",
    webPreferences: {
      preload: path.join(__dirname, "preload-settings.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  };
  if (iconPath) opts.icon = iconPath;
  _bumpAnimationPreviewPosterGeneration();
  settingsWindow = new BrowserWindow(opts);
  if (isWin && typeof settingsWindow.setAppDetails === "function") {
    const taskbarDetails = getSettingsWindowTaskbarDetails();
    if (taskbarDetails && taskbarDetails.appIconPath) {
      settingsWindow.setAppDetails(taskbarDetails);
    }
  }
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, "settings.html"));
  settingsWindow.once("ready-to-show", () => {
    settingsWindow.show();
    settingsWindow.focus();
  });
  settingsWindow.on("closed", () => {
    _bumpAnimationPreviewPosterGeneration();
    stopShortcutRecording();
    void settingsSizePreviewSession.cleanup();
    settingsWindow = null;
    _maybeDestroyIdleAnimationPreviewPosterWindow();
  });
}

function createWindow() {
  // Read everything from the settings controller. The mirror caches above
  // (lang/showTray/etc.) were already initialized at module-load time, so
  // here we just need the position/mini fields plus the legacy size migration.
  let prefs = _settingsController.getSnapshot();
  // Legacy S/M/L → P:N migration. Only kicks in for prefs files that haven't
  // been touched since v0; new files always store the proportional form.
  if (SIZES[prefs.size]) {
    const wa = getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA;
    const px = SIZES[prefs.size].width;
    const ratio = Math.round(px / wa.width * 100);
    const migrated = `P:${Math.max(1, Math.min(75, ratio))}`;
    _settingsController.applyUpdate("size", migrated); // subscriber updates currentSize mirror
    prefs = _settingsController.getSnapshot();
  }
  // macOS: apply dock visibility (default visible — but persisted state wins).
  if (isMac) {
    applyDockVisibility();
  }
  const launchSizingWorkArea = getLaunchSizingWorkArea(
    prefs,
    getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA,
    getNearestWorkArea,
  );
  // keepSizeAcrossDisplays preserves the last realized pixel size across restarts.
  const proportionalSize = getCurrentPixelSize(launchSizingWorkArea);
  const size = getLaunchPixelSize(prefs, proportionalSize);

  // Restore saved position, or default to bottom-right of primary display.
  // Prefs file always exists in the new architecture (defaults are hydrated
  // by prefs.load()), so the "no prefs" branch from the legacy code is gone —
  // a fresh install gets x=0, y=0 from defaults, and we treat that as "place
  // bottom-right" via the explicit zero check below.
  let startBounds;
  if (prefs.miniMode) {
    startBounds = _mini.restoreFromPrefs(prefs, size);
  } else if (prefs.positionSaved) {
    startBounds = { x: prefs.x, y: prefs.y, width: size.width, height: size.height };
  } else {
    const workArea = getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA;
    startBounds = {
      x: workArea.x + workArea.width - size.width - 20,
      y: workArea.y + workArea.height - size.height - 20,
      width: size.width,
      height: size.height,
    };
  }
  // Display-snapshot gate: if the monitor the pet was last on is still here
  // (same bounds or matching display.id), we trust the saved position even if
  // a generic clamp would otherwise nudge it. Only when the monitor is gone
  // — unplugged external display, RDP session ended, laptop closed with pet
  // on the external, etc. — do we regularize to the current topology.
  //
  // Visibility backstop: even with a matching display, if the saved center
  // landed outside every current workArea (manual prefs edits, exotic multi-
  // monitor rearrangements where bounds matched but the pet's coordinates
  // ended up in no-man's-land), fall back to regularize so the user isn't
  // greeted by an invisible pet. Normal "pet partially off-screen" cases
  // pass this check because the midpoint still lands inside a workArea.
  //
  // Legacy prefs (positionDisplay === null) fall through to the clamp-delta
  // check, preserving v0.6.0 behavior for users who haven't re-saved yet.
  const allDisplays = screen.getAllDisplays();
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
  const initialWorkArea = getNearestWorkArea(
    initialVirtualBounds.x + initialVirtualBounds.width / 2,
    initialVirtualBounds.y + initialVirtualBounds.height / 2
  );
  const initialMaterialized = materializeVirtualBounds(initialVirtualBounds, initialWorkArea);
  const initialWindowBounds = (initialMaterialized && initialMaterialized.bounds) || initialVirtualBounds;

  win = new BrowserWindow({
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
    ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
    ...(isMac ? { type: "panel", roundedCorners: false } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false,
      additionalArguments: [
        "--theme-config=" + JSON.stringify(themeLoader.getRendererConfig()),
      ],
    },
  });

  win.setFocusable(false);

  // Watchdog (Linux only): prevent accidental window close.
  // render-process-gone is handled by the global crash-recovery handler below.
  // On macOS/Windows the WM handles window lifecycle differently.
  if (isLinux) {
    win.on("close", (event) => {
      if (!isQuitting) {
        event.preventDefault();
        if (!win.isVisible()) {
          win.showInactive();
          keepOutOfTaskbar(win);
        }
      }
    });
    win.on("unresponsive", () => {
      if (isQuitting) return;
      console.warn("Clawd: renderer unresponsive — reloading");
      win.webContents.reload();
    });
  }

  if (isWin) {
    // Windows: use pop-up-menu level to stay above taskbar/shell UI
    win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
  }
  win.loadFile(path.join(__dirname, "index.html"));
  applyPetWindowBounds(initialVirtualBounds);
  win.showInactive();
  keepOutOfTaskbar(win);
  // macOS: apply after showInactive() — it resets NSWindowCollectionBehavior
  reapplyMacVisibility();

  // macOS: startup-time dock state can be overridden during app/window activation.
  // Re-apply once on next tick so persisted showDock reliably takes effect.
  if (isMac) {
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      applyDockVisibility();
    }, 0);
  }

  buildContextMenu();
  if (!isMac || showTray) createTray();
  ensureContextMenuOwner();



  // ── Create input window (hitWin) — small rect over hitbox, receives all pointer events ──
  {
    const initBounds = getPetWindowBounds();
    const initHit = getHitRectScreen(initBounds);
    const hx = Math.round(initHit.left), hy = Math.round(initHit.top);
    const hw = Math.round(initHit.right - initHit.left);
    const hh = Math.round(initHit.bottom - initHit.top);

    hitWin = new BrowserWindow({
      width: hw, height: hh, x: hx, y: hy,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      fullscreenable: false,
      enableLargerThanScreen: true,
      ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
      ...(isMac ? { type: "panel", roundedCorners: false } : {}),
      focusable: !isLinux,  // KEY EXPERIMENT: allow activation to avoid WS_EX_NOACTIVATE input routing bugs (Windows-only issue)
      webPreferences: {
        preload: path.join(__dirname, "preload-hit.js"),
        backgroundThrottling: false,
        additionalArguments: [
          "--hit-theme-config=" + JSON.stringify(themeLoader.getHitRendererConfig()),
        ],
      },
    });
    // setShape: native hit region, no per-pixel alpha dependency.
    // hitWin has no visual content — clipping is irrelevant.
    hitWin.setShape([{ x: 0, y: 0, width: hw, height: hh }]);
    hitWin.setIgnoreMouseEvents(false);  // PERMANENT — never toggle
    if (isMac) hitWin.setFocusable(false);
    hitWin.showInactive();
    keepOutOfTaskbar(hitWin);
    if (isWin) {
      hitWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    }
    // macOS: apply after showInactive() — it resets NSWindowCollectionBehavior
    reapplyMacVisibility();
    hitWin.loadFile(path.join(__dirname, "hit.html"));
    if (isWin) guardAlwaysOnTop(hitWin);

    // Event-level safety net for position sync
    const syncFloatingWindows = () => {
      if (settingsSizePreviewSyncFrozen) return;
      syncHitWin();
      repositionSessionHud();
      repositionFloatingBubbles();
    };
    win.on("move", syncFloatingWindows);
    win.on("resize", syncFloatingWindows);

    // Send initial state to hitWin once it's ready
    hitWin.webContents.on("did-finish-load", () => {
      sendToHitWin("theme-config", themeLoader.getHitRendererConfig());
      if (themeReloadInProgress) return;
      syncHitStateAfterLoad();
    });

    // Crash recovery for hitWin
    hitWin.webContents.on("render-process-gone", (_event, details) => {
      safeConsoleError("hitWin renderer crashed:", details.reason);
      hitWin.webContents.reload();
    });
  }

  syncSessionHudVisibility();

  ipcMain.on("show-context-menu", showPetContextMenu);

  ipcMain.on("drag-move", () => moveWindowForDrag());

  ipcMain.on("pause-cursor-polling", () => { idlePaused = true; });
  ipcMain.on("resume-from-reaction", () => {
    idlePaused = false;
    if (_mini.getMiniTransitioning()) return;
    sendToRenderer("state-change", _state.getCurrentState(), _state.getCurrentSvg());
  });

  ipcMain.on("drag-lock", (event, locked) => {
    dragLocked = !!locked;
    if (locked) {
      mouseOverPet = true;
      beginDragSnapshot();
    } else {
      clearDragSnapshot();
      syncHitWin();
    }
  });

  // Reaction relay: hitWin → main → renderWin
  ipcMain.on("start-drag-reaction", () => sendToRenderer("start-drag-reaction"));
  ipcMain.on("end-drag-reaction", () => sendToRenderer("end-drag-reaction"));
  ipcMain.on("play-click-reaction", (_, svg, duration) => {
    sendToRenderer("play-click-reaction", svg, duration);
  });

  ipcMain.on("drag-end", () => {
    try {
      if (!_mini.getMiniMode() && !_mini.getMiniTransitioning()) {
        checkMiniModeSnap();
        if (_mini.getMiniMode() || _mini.getMiniTransitioning()) return;
        // After drag, clamp to the nearest screen (loose clamp during drag allows cross-screen).
        // In proportional mode, also recalculate size for the landing display —
        // unless the user asked to keep the pixel size across displays, in which
        // case we leave the current window size alone.
        if (win && !win.isDestroyed()) {
          const virtualBounds = getPetWindowBounds();
          const size = keepSizeAcrossDisplaysCached
            ? { width: virtualBounds.width, height: virtualBounds.height }
            : getCurrentPixelSize();
          const clamped = computeFinalDragBounds(virtualBounds, size, clampToScreenVisual);
          if (clamped) applyPetWindowBounds(clamped);
          reassertWinTopmost();
          scheduleHwndRecovery();
          syncHitWin();
          repositionFloatingBubbles();
        }
      }
    } finally {
      dragLocked = false;
      clearDragSnapshot();
    }
  });

  ipcMain.on("exit-mini-mode", () => {
    if (_mini.getMiniMode()) exitMiniMode();
  });

  ipcMain.on("focus-terminal", () => {
    // Find the best session to focus: prefer highest priority (non-idle), then most recent
    let best = null, bestTime = 0, bestPriority = -1;
    for (const [, s] of sessions) {
      if (!s.sourcePid) continue;
      const pri = STATE_PRIORITY[s.state] || 0;
      if (pri > bestPriority || (pri === bestPriority && s.updatedAt > bestTime)) {
        best = s;
        bestTime = s.updatedAt;
        bestPriority = pri;
      }
    }
    if (best) focusTerminalWindow(best.sourcePid, best.cwd, best.editor, best.pidChain);
  });

  ipcMain.on("show-dashboard", () => {
    showDashboard();
  });

  ipcMain.on("bubble-height", (event, height) => _perm.handleBubbleHeight(event, height));
  ipcMain.on("permission-decide", (event, behavior) => _perm.handleDecide(event, behavior));
  ipcMain.on("update-bubble-height", (event, height) => handleUpdateBubbleHeight(event, height));
  ipcMain.on("update-bubble-action", (event, actionId) => handleUpdateBubbleAction(event, actionId));

  initFocusHelper();
  startMainTick();
  startHttpServer();
  startStaleCleanup();
  // Wait for renderer to be ready before sending initial state
  // If hooks arrived during startup, respect them instead of forcing idle
  // Also handles crash recovery (render-process-gone → reload)
  win.webContents.on("did-finish-load", () => {
    sendToRenderer("theme-config", themeLoader.getRendererConfig());
    sendToRenderer("viewport-offset", viewportOffsetY);
    if (themeReloadInProgress) return;
    syncRendererStateAfterLoad();
  });

  // ── Crash recovery: renderer process can die from <object> churn ──
  win.webContents.on("render-process-gone", (_event, details) => {
    safeConsoleError("Renderer crashed:", details.reason);
    dragLocked = false;
    idlePaused = false;
    mouseOverPet = false;
    win.webContents.reload();
  });

  guardAlwaysOnTop(win);
  startTopmostWatchdog();

  // ── Display change: re-clamp window to prevent off-screen ──
  // In proportional mode, also recalculate size based on the new work area,
  // unless keepSizeAcrossDisplays is on — then we preserve the current window
  // size and only re-clamp the position.
  screen.on("display-metrics-changed", () => {
    reapplyMacVisibility();
    if (!win || win.isDestroyed()) return;
    if (_mini.getMiniTransitioning()) return;
    if (_mini.getMiniMode()) {
      _mini.handleDisplayChange();
      return;
    }
    const current = getPetWindowBounds();
    const size = keepSizeAcrossDisplaysCached
      ? { width: current.width, height: current.height }
      : getCurrentPixelSize();
    const clamped = clampToScreenVisual(current.x, current.y, size.width, size.height);
    const proportionalRecalc = isProportionalMode() && !keepSizeAcrossDisplaysCached;
    if (proportionalRecalc || clamped.x !== current.x || clamped.y !== current.y) {
      applyPetWindowBounds({ ...clamped, width: size.width, height: size.height });
      syncHitWin();
      repositionSessionHud();
      repositionFloatingBubbles();
    }
  });
  screen.on("display-removed", () => {
    reapplyMacVisibility();
    if (!win || win.isDestroyed()) return;
    if (_mini.getMiniTransitioning()) return;
    if (_mini.getMiniMode()) {
      exitMiniMode();
      return;
    }
    const current = getPetWindowBounds();
    const size = keepSizeAcrossDisplaysCached
      ? { width: current.width, height: current.height }
      : getCurrentPixelSize();
    const clamped = clampToScreenVisual(current.x, current.y, size.width, size.height);
    applyPetWindowBounds({ ...clamped, width: size.width, height: size.height });
    syncHitWin();
    repositionSessionHud();
    repositionFloatingBubbles();
  });
  screen.on("display-added", () => {
    reapplyMacVisibility();
    repositionSessionHud();
    repositionFloatingBubbles();
  });
}

// Read primary display safely — getPrimaryDisplay() can also throw during
// display topology changes, so wrap it. Returns null on failure; the pure
// helpers in work-area.js will fall through to a synthetic last-resort.
function getPrimaryWorkAreaSafe() {
  try {
    const primary = screen.getPrimaryDisplay();
    return (primary && primary.workArea) || null;
  } catch {
    return null;
  }
}

function getNearestWorkArea(cx, cy) {
  return findNearestWorkArea(screen.getAllDisplays(), getPrimaryWorkAreaSafe(), cx, cy);
}

function getNearestDisplayBottomInset(cx, cy) {
  const point = { x: Math.round(cx), y: Math.round(cy) };
  let display = null;
  try {
    display = screen.getDisplayNearestPoint(point);
  } catch {}
  if (!display || !display.bounds || !display.workArea) {
    try {
      display = screen.getPrimaryDisplay();
    } catch {}
  }
  return getDisplayInsets(display).bottom;
}

// Loose clamp used during drag: union of all display work areas as the boundary,
// so the pet can freely cross between screens. Only prevents going fully off-screen.
function looseClampPetToDisplays(x, y, w, h) {
  const margins = getVisibleContentMargins({ x, y, width: w, height: h });
  const bottomInset = getNearestDisplayBottomInset(x + w / 2, y + h / 2);
  return computeLooseClamp(
    screen.getAllDisplays(),
    getPrimaryWorkAreaSafe(),
    x,
    y,
    w,
    h,
    getLooseDragMargins({
      width: w,
      height: h,
      visibleMargins: margins,
      allowEdgePinning: allowEdgePinningCached,
      bottomInset,
    })
  );
}

function clampToScreenVisual(x, y, w, h, options = {}) {
  const margins = getVisibleContentMargins(
    { x, y, width: w, height: h },
    options
  );
  const nearest = getNearestWorkArea(x + w / 2, y + h / 2);
  const bottomInset = getNearestDisplayBottomInset(x + w / 2, y + h / 2);
  const mLeft  = Math.round(w * 0.25);
  const mRight = Math.round(w * 0.25);
  const clampMargins = getRestClampMargins({
    height: h,
    visibleMargins: margins,
    allowEdgePinning: "allowEdgePinning" in options ? options.allowEdgePinning : allowEdgePinningCached,
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

// ── Mini Mode — initialized here after state module ──
const _miniCtx = {
  get theme() { return activeTheme; },
  get win() { return win; },
  get currentSize() { return currentSize; },
  get doNotDisturb() { return doNotDisturb; },
  set doNotDisturb(v) { doNotDisturb = v; },
  get currentState() { return _state.getCurrentState(); },
  SIZES,
  getCurrentPixelSize,
  getEffectiveCurrentPixelSize,
  getPixelSizeFor,
  isProportionalMode,
  sendToRenderer,
  sendToHitWin,
  syncHitWin,
  applyState,
  resolveDisplayState,
  getSvgOverride,
  stopWakePoll,
  clampToScreenVisual,
  getNearestWorkArea,
  getPetWindowBounds,
  applyPetWindowBounds,
  applyPetWindowPosition,
  setViewportOffsetY,
  get bubbleFollowPet() { return bubbleFollowPet; },
  get pendingPermissions() { return pendingPermissions; },
  repositionBubbles: () => repositionFloatingBubbles(),
  syncSessionHudVisibility: () => {
    syncSessionHudVisibility();
    repositionFloatingBubbles();
  },
  repositionSessionHud: () => repositionSessionHud(),
  buildContextMenu: () => buildContextMenu(),
  buildTrayMenu: () => buildTrayMenu(),
  getAnimationAssetCycleMs: (file) => {
    if (!file) return null;
    const probe = _buildAnimationAssetProbe(file);
    return Number.isFinite(probe && probe.assetCycleMs) && probe.assetCycleMs > 0
      ? probe.assetCycleMs
      : null;
  },
};
const _mini = require("./mini")(_miniCtx);
const { enterMiniMode, exitMiniMode, enterMiniViaMenu, miniPeekIn, miniPeekOut,
        checkMiniModeSnap, cancelMiniTransition, animateWindowX, animateWindowParabola } = _mini;

// Convenience getters for mini state (used throughout main.js)
Object.defineProperties(this || {}, {}); // no-op placeholder
// Mini state is accessed via _mini getters in ctx objects below

// ── Theme switching ──
//
// The `theme` settings effect calls this. MUST throw on failure so the
// controller rejects the commit — otherwise prefs would record a theme id
// that can't actually render. Does NOT write `theme` back to prefs; the
// controller commits after this returns (writing here would infinite-loop).
function clearThemeSwitchFadeFallback() {
  if (themeSwitchFadeFallbackTimer) {
    clearTimeout(themeSwitchFadeFallbackTimer);
    themeSwitchFadeFallbackTimer = null;
  }
}

function cancelThemeSwitchOpacityAnimation() {
  if (themeSwitchOpacityCancelSignal) {
    themeSwitchOpacityCancelSignal.cancelled = true;
    themeSwitchOpacityCancelSignal = null;
  }
}

function clearThemeSwitchReloadListeners() {
  if (themeSwitchReloadListenerCleanup) {
    themeSwitchReloadListenerCleanup();
    themeSwitchReloadListenerCleanup = null;
  }
}

function scheduleThemeSwitchFadeFallback(seq, onFallback) {
  clearThemeSwitchFadeFallback();
  themeSwitchFadeFallbackTimer = setTimeout(() => {
    themeSwitchFadeFallbackTimer = null;
    if (seq !== themeSwitchTransitionSeq) return;
    if (typeof onFallback === "function") {
      onFallback();
    } else {
      setWindowOpacity(win, 1);
    }
  }, THEME_SWITCH_FADE_FALLBACK_MS);
}

function animateThemeWindowOpacity(seq, targetOpacity, durationMs) {
  if (seq !== themeSwitchTransitionSeq) return Promise.resolve(false);
  cancelThemeSwitchOpacityAnimation();
  const cancelSignal = { cancelled: false };
  themeSwitchOpacityCancelSignal = cancelSignal;
  return animateWindowOpacity(win, targetOpacity, { durationMs, cancelSignal })
    .finally(() => {
      if (themeSwitchOpacityCancelSignal === cancelSignal) {
        themeSwitchOpacityCancelSignal = null;
      }
    });
}

function fadeInThemeWindow(seq) {
  if (seq !== themeSwitchTransitionSeq) return;
  clearThemeSwitchFadeFallback();
  animateThemeWindowOpacity(seq, 1, THEME_SWITCH_FADE_IN_MS).then((ok) => {
    if (!ok && seq === themeSwitchTransitionSeq) setWindowOpacity(win, 1);
  });
}

function reloadThemeWindowsAfterFade(seq, onReady, onFallback) {
  if (seq !== themeSwitchTransitionSeq) return;
  if (!win || win.isDestroyed() || !hitWin || hitWin.isDestroyed()) {
    if (typeof onFallback === "function") onFallback();
    else setWindowOpacity(win, 1);
    return;
  }
  clearThemeSwitchReloadListeners();
  const renderContents = win.webContents;
  const hitContents = hitWin.webContents;
  renderContents.once("did-finish-load", onReady);
  hitContents.once("did-finish-load", onReady);
  themeSwitchReloadListenerCleanup = () => {
    renderContents.removeListener("did-finish-load", onReady);
    hitContents.removeListener("did-finish-load", onReady);
  };
  scheduleThemeSwitchFadeFallback(seq, onFallback);
  try {
    renderContents.reload();
    hitContents.reload();
  } catch {
    if (typeof onFallback === "function") onFallback();
  }
}

function activateTheme(themeId, variantId) {
  if (!win || win.isDestroyed()) {
    throw new Error("theme switch requires ready windows");
  }
  // Resolve variantId: explicit arg wins; else current per-theme preference; else default.
  // (Unknown variants lenient-fallback inside loadTheme, so we still commit strict on themeId.)
  const currentVariantMap = _settingsController.get("themeVariant") || {};
  const targetVariant = (typeof variantId === "string" && variantId) ? variantId
    : (currentVariantMap[themeId] || "default");
  const currentOverrides = _settingsController.get("themeOverrides") || {};
  const targetOverrideMap = arguments.length >= 3 ? arguments[2] : (currentOverrides[themeId] || null);
  const targetOverrideSignature = JSON.stringify(targetOverrideMap || {});

  // Joint dedup: same theme + same variant → skip reload. Different variant
  // on same theme MUST run the full reload pipeline (can't hot-patch tiers /
  // displayHint / geometry safely — see plan-settings-panel-3b-swap.md §6.2).
  if (
    activeTheme &&
    activeTheme._id === themeId &&
    activeTheme._variantId === targetVariant &&
    (activeTheme._overrideSignature || "{}") === targetOverrideSignature
  ) {
    return { themeId, variantId: activeTheme._variantId };
  }

  // Strict load first: if it throws, nothing downstream has mutated yet.
  const newTheme = themeLoader.loadTheme(themeId, {
    strict: true,
    variant: targetVariant,
    overrides: targetOverrideMap,
  });
  newTheme._overrideSignature = targetOverrideSignature;
  if (animationOverridePreviewTimer) {
    clearTimeout(animationOverridePreviewTimer);
    animationOverridePreviewTimer = null;
  }
  if (!activeTheme || activeTheme._id !== newTheme._id) {
    _bumpAnimationPreviewPosterGeneration();
  }
  let preservedVirtualBounds = getPetWindowBounds();

  _state.cleanup();
  _tick.cleanup();
  _mini.cleanup();
  // ⚠️ Don't clear pendingPermissions — bubbles are independent BrowserWindows
  // ⚠️ Don't clear sessions — keep active session tracking
  // ⚠️ Don't clear displayHint — semantic tokens resolve through new theme's map

  if (_mini.getMiniMode() && !newTheme.miniMode.supported) {
    preservedVirtualBounds = null;
    _mini.exitMiniMode();
  }

  activeTheme = newTheme;
  _mini.refreshTheme();
  _state.refreshTheme();
  _tick.refreshTheme();
  if (_mini.getMiniMode()) _mini.handleDisplayChange();

  const transitionSeq = ++themeSwitchTransitionSeq;
  cancelThemeSwitchOpacityAnimation();
  clearThemeSwitchFadeFallback();
  clearThemeSwitchReloadListeners();
  themeReloadInProgress = true;

  let ready = 0;
  let reloadSettled = false;
  const finishThemeReload = () => {
    if (transitionSeq !== themeSwitchTransitionSeq || reloadSettled) return;
    reloadSettled = true;
    clearThemeSwitchFadeFallback();
    clearThemeSwitchReloadListeners();
    themeReloadInProgress = false;
    if (preservedVirtualBounds && !_mini.getMiniTransitioning() && win && !win.isDestroyed()) {
      applyPetWindowBounds(preservedVirtualBounds);
      const clamped = computeFinalDragBounds(
        getPetWindowBounds(),
        { width: preservedVirtualBounds.width, height: preservedVirtualBounds.height },
        clampToScreenVisual
      );
      if (clamped) applyPetWindowBounds(clamped);
    }
    // Fallback can reach this path before both reload events arrive; the sync
    // helpers are window-guarded and serve as a best-effort state resend.
    if (hitWin && !hitWin.isDestroyed()) syncHitStateAfterLoad();
    if (win && !win.isDestroyed()) {
      syncRendererStateAfterLoad({ includeStartupRecovery: false });
      syncHitWin();
    }
    syncSessionHudVisibility();
    if (win && !win.isDestroyed()) startMainTick();
    _runPendingPostReloadTasks();
    fadeInThemeWindow(transitionSeq);
  };
  const onReady = () => {
    if (transitionSeq !== themeSwitchTransitionSeq) return;
    if (++ready < 2) return;
    finishThemeReload();
  };

  animateThemeWindowOpacity(transitionSeq, 0, THEME_SWITCH_FADE_OUT_MS).then(() => {
    reloadThemeWindowsAfterFade(
      transitionSeq,
      onReady,
      () => finishThemeReload()
    );
  });

  flushRuntimeStateToPrefs();

  // Return resolved ids so the caller (setThemeSelection command) can commit
  // the actually-loaded variantId — handles "author deleted variant" dirty state.
  return { themeId, variantId: newTheme._variantId };
}

// Inject theme deps into the settings controller now that activateTheme,
// themeLoader, and activeTheme are all defined. Uses lazy closures because
// these references are captured at call time (inside an effect or command).
function _deferredActivateTheme(themeId, variantId, overrideMap) {
  return activateTheme(themeId, variantId, overrideMap);
}
function _deferredGetThemeInfo(themeId) {
  const all = themeLoader.discoverThemes();
  const entry = all.find((t) => t.id === themeId);
  if (!entry) return null;
  return {
    builtin: !!entry.builtin,
    active: activeTheme && activeTheme._id === themeId,
    managedCodexPet: !!_readCodexPetManagedThemeMarker(themeId),
  };
}
function _deferredRemoveThemeDir(themeId) {
  const userThemesDir = themeLoader.ensureUserThemesDir();
  if (!userThemesDir) throw new Error("user themes directory unavailable");
  // Re-verify path containment as a defensive check — settings-actions
  // already rejects built-in / active themes, and ensureUserThemesDir only
  // ever returns the userData subtree, but belt + suspenders on an fs.rm
  // call is worth the two lines.
  const target = path.resolve(path.join(userThemesDir, themeId));
  const root = path.resolve(userThemesDir);
  if (!target.startsWith(root + path.sep)) {
    throw new Error(`theme path escapes user themes directory: ${themeId}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  // Rebuild menus so Theme submenu reflects the deleted entry.
  try { rebuildAllMenus(); } catch { /* best-effort */ }
}

// ── Auto-install VS Code / Cursor terminal-focus extension ──
const EXT_ID = "clawd.clawd-terminal-focus";
const EXT_VERSION = "0.1.0";
const EXT_DIR_NAME = `${EXT_ID}-${EXT_VERSION}`;

function installTerminalFocusExtension() {
  const os = require("os");
  const home = os.homedir();

  // Extension source — in dev: ../extensions/vscode/, in packaged: app.asar.unpacked/
  let extSrc = path.join(__dirname, "..", "extensions", "vscode");
  extSrc = extSrc.replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);

  if (!fs.existsSync(extSrc)) {
    console.log("Clawd: terminal-focus extension source not found, skipping auto-install");
    return;
  }

  const targets = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".cursor", "extensions"),
  ];

  const filesToCopy = ["package.json", "extension.js"];
  let installed = 0;

  for (const extRoot of targets) {
    if (!fs.existsSync(extRoot)) continue; // editor not installed
    const dest = path.join(extRoot, EXT_DIR_NAME);
    // Skip if already installed (check package.json exists)
    if (fs.existsSync(path.join(dest, "package.json"))) continue;
    try {
      fs.mkdirSync(dest, { recursive: true });
      for (const file of filesToCopy) {
        fs.copyFileSync(path.join(extSrc, file), path.join(dest, file));
      }
      installed++;
      console.log(`Clawd: installed terminal-focus extension to ${dest}`);
    } catch (err) {
      console.warn(`Clawd: failed to install extension to ${dest}:`, err.message);
    }
  }
  if (installed > 0) {
    console.log(`Clawd: terminal-focus extension installed to ${installed} editor(s). Restart VS Code/Cursor to activate.`);
  }
}

// ── Single instance lock ──
app.on("open-url", (event, url) => {
  event.preventDefault();
  _enqueueCodexPetImportUrl(url);
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  if (process.argv.includes(REGISTER_PROTOCOL_DEV_ARG)) {
    const protocolRegistered = _registerClawdProtocolClient();
    console.log(`Clawd: clawd:// dev protocol registration ${protocolRegistered ? "succeeded" : "failed"}`);
  }
  // Another instance is already running — quit silently
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    if (win) {
      win.showInactive();
      keepOutOfTaskbar(win);
    }
    if (hitWin && !hitWin.isDestroyed()) {
      hitWin.showInactive();
      keepOutOfTaskbar(hitWin);
    }
    if (shouldOpenSettingsWindowFromArgv(commandLine)) {
      openSettingsWindowWhenReady();
    }
    _enqueueCodexPetImportUrlsFromArgv(commandLine);
    reapplyMacVisibility();
  });

  // macOS: hide dock icon early if user previously disabled it
  if (isMac && app.dock) {
    if (_settingsController.get("showDock") === false) {
      app.dock.hide();
    }
  }

  app.whenReady().then(() => {
    const protocolRegistered = _registerClawdProtocolClient();
    if (process.argv.includes(REGISTER_PROTOCOL_DEV_ARG)) {
      console.log(`Clawd: clawd:// dev protocol registration ${protocolRegistered ? "succeeded" : "failed"}`);
      app.quit();
      return;
    }

    // Import system-backed settings (openAtLogin) into prefs on first run.
    // Must run before createWindow() so the first menu draw sees the
    // hydrated value rather than the schema default.
    hydrateSystemBackedSettings();

    permDebugLog = path.join(app.getPath("userData"), "permission-debug.log");
    updateDebugLog = path.join(app.getPath("userData"), "update-debug.log");
    sessionDebugLog = path.join(app.getPath("userData"), "session-debug.log");
    createWindow();
    if (shouldOpenSettingsWindowFromArgv(process.argv)) {
      openSettingsWindow();
    }
    _enqueueCodexPetImportUrlsFromArgv(process.argv);
    _flushPendingCodexPetImportUrls().catch((err) => {
      console.warn("Clawd: Codex Pet import queue failed:", err && err.message);
    });

    // Register persistent global shortcuts from the validated prefs snapshot.
    registerPersistentShortcutsFromSettings();

    // Construct log monitors. We always instantiate them so toggling the
    // agent on/off later can call start()/stop() without paying the require
    // cost at click time. Whether we call .start() right now depends on the
    // agent-gate snapshot — a user who disabled Codex at last shutdown
    // shouldn't see its file watcher spin up on the next launch.
    try {
      const CodexLogMonitor = require("../agents/codex-log-monitor");
      const codexAgent = require("../agents/codex");
      _codexMonitor = new CodexLogMonitor(codexAgent, (sid, state, event, extra) => {
        if (shouldSuppressCodexLogEvent(sid, state, event)) return;
        if (isCodexMonitorPermissionEvent(state)) {
          updateSession(sid, "notification", event, buildCodexMonitorUpdateOptions(extra, {
            includeHeadless: false,
          }));
          showCodexNotifyBubble({
            sessionId: sid,
            command: (extra && extra.permissionDetail && extra.permissionDetail.command) || "",
          });
          return;
        }
        clearCodexNotifyBubbles(sid, `codex-state-transition:${state}`);
        updateSession(sid, state, event, buildCodexMonitorUpdateOptions(extra, {
          includeHeadless: true,
        }));
      }, { classifier: _codexSubagentClassifier });
      if (_isAgentEnabled(_settingsController.getSnapshot(), "codex")) {
        _codexMonitor.start();
      }
    } catch (err) {
      console.warn("Clawd: Codex log monitor not started:", err.message);
    }

    // Auto-install VS Code/Cursor terminal-focus extension
    try { installTerminalFocusExtension(); } catch (err) {
      console.warn("Clawd: failed to auto-install terminal-focus extension:", err.message);
    }

    // Auto-updater: setup event handlers (user triggers check via tray menu)
    setupAutoUpdater();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    flushRuntimeStateToPrefs();
    globalShortcut.unregisterAll();
    void settingsSizePreviewSession.cleanup();
    _perm.cleanup();
    _server.cleanup();
    _updateBubble.cleanup();
    _state.cleanup();
    _tick.cleanup();
    _mini.cleanup();
    _sessionHud.cleanup();
    if (_codexMonitor) _codexMonitor.stop();
    stopTopmostWatchdog();
    if (hwndRecoveryTimer) { clearTimeout(hwndRecoveryTimer); hwndRecoveryTimer = null; }
    _focus.cleanup();
    _bumpAnimationPreviewPosterGeneration();
    _destroyAnimationPreviewPosterWindow();
    if (hitWin && !hitWin.isDestroyed()) hitWin.destroy();
  });

  app.on("window-all-closed", () => {
    if (!isQuitting) return;
    app.quit();
  });
}
