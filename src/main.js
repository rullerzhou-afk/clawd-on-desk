const { app, BrowserWindow, screen, ipcMain, globalShortcut, nativeTheme, dialog, shell, nativeImage, powerSaveBlocker, clipboard } = require("electron");
// ── Linux/Wayland: relaunch under XWayland so the pet is draggable (issue #441) ──
// Native Wayland ignores client-side window positioning and blocks global cursor
// queries, so the pet spawns centered, can't be dragged, and has no tracking;
// --ozone-platform=x11 (XWayland) restores positioning + drag.
//
// This canNOT be done with app.commandLine.appendSwitch from here: Electron
// selects AND instantiates the Ozone backend in C++ PreEarlyInitialization
// (ui::SetOzonePlatformForLinuxIfNeeded + ui::OzonePlatform::PreEarlyInitialization),
// which runs BEFORE this main script (PostEarlyInitialization → JoinAppCode) —
// so any in-process switch change lands after the backend is already chosen.
// SetOzonePlatformForLinuxIfNeeded DOES honor a --ozone-platform already on argv,
// so the fix is to relaunch ourselves with that flag: this first process selects
// Wayland but exits before creating any window; the second boots into XWayland.
const { planXWaylandRelaunch } = require("./linux-ozone");
const _xwaylandRelaunch = planXWaylandRelaunch({
  platform: process.platform,
  env: process.env,
  argv: process.argv,
});
if (_xwaylandRelaunch) {
  console.log(
    "Clawd: Linux — relaunching under XWayland (--ozone-platform=x11) " +
    "(issue #441; override with CLAWD_OZONE_PLATFORM=wayland|x11|auto)"
  );
  process.env.CLAWD_OZONE_RELAUNCHED = "1";
  // Spawn the replacement ourselves instead of app.relaunch(). Electron's
  // relauncher helper is a process run from the binary INSIDE the AppImage's
  // FUSE mount, and it deliberately waits for this process to die before it
  // execs the replacement — but our exit also kills the AppImage runtime,
  // which IS the FUSE daemon, so the mount vanishes and the helper loses its
  // own code pages and dies without ever launching anything (reproduced on a
  // real Wayland compositor in CI: the helper outlives us by <1s, no child).
  // spawn() avoids both traps: the exec happens NOW, while this process and
  // its mount are still alive, and the exec target is the on-disk .AppImage
  // (process.env.APPIMAGE) or real binary — never the doomed mount path.
  // detached gives the child its own process group so it survives us;
  // stdio "inherit" keeps its logs on the user's terminal (the relauncher
  // piped them to /dev/null, which made field reports needlessly blind).
  let _xwaylandChild = null;
  try {
    _xwaylandChild = require("child_process").spawn(
      process.env.APPIMAGE || process.execPath,
      _xwaylandRelaunch.args,
      { detached: true, stdio: "inherit" },
    );
  } catch {
    _xwaylandChild = null;
  }
  if (_xwaylandChild && typeof _xwaylandChild.on === "function") {
    _xwaylandChild.on("error", (err) => {
      console.error("Clawd: XWayland relaunch spawn error:", err && err.message ? err.message : err);
    });
  }
  if (_xwaylandChild && typeof _xwaylandChild.pid === "number") {
    _xwaylandChild.unref();
    app.exit(0);
    return; // throwaway first process — stop before loading the rest of main.js
  }
  // No pid ⇒ the spawn failed before creating a child. Do NOT exit into
  // nothing — clear the sentinel and fall through to a normal (native Wayland)
  // startup so the app still runs, just without drag (issue #441). The error
  // listener above also prevents async exec failures (ENOENT/EACCES) from
  // crashing this fallback path.
  delete process.env.CLAWD_OZONE_RELAUNCHED;
  console.error("Clawd: XWayland relaunch failed; continuing under native Wayland (issue #441).");
}

const { clampTextScale, scaleWidth, scaleHeight, resolveTextScaleForKey } = require("./text-scale");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const { EventEmitter } = require("events");
const {
  applyWindowsAppUserModelId,
  shouldOpenSettingsWindowFromArgv,
} = require("./settings-window-icon");
const createSettingsWindowRuntime = require("./settings-window");
const {
  createSettingsSizePreviewSession,
} = require("./settings-size-preview-session");
const { registerSettingsIpc } = require("./settings-ipc");
const createSettingsEffectRouter = require("./settings-effect-router");
const { registerSessionIpc } = require("./session-ipc");
const { registerPetInteractionIpc } = require("./pet-interaction-ipc");
const { launchClaudeSession, openTerminalAt } = require("./launch-claude");
const { dialog: electronDialog } = require("electron");
const initPermission = require("./permission");
const { registerPermissionIpc } = initPermission;
const { createTelegramApprovalSidecar } = require("./telegram-approval-sidecar");
const telegramApprovalSettings = require("./telegram-approval-settings");
const {
  buildTelegramApprovalStatus,
  isNativeTelegramApprovalSelected,
  buildTelegramStatusDiagnostic,
  formatTelegramStatusDiagnostic,
} = require("./telegram-approval-runtime-status");
const { createTelegramMigrationController } = require("./telegram-migration-controller");
const { createTelegramSidecarStatusBridge } = require("./telegram-sidecar-status-bridge");
const initUpdateBubble = require("./update-bubble");
const { registerUpdateBubbleIpc } = initUpdateBubble;
const createSettingsAnimationOverridesMain = require("./settings-animation-overrides-main");
const { registerSettingsAnimationOverridesIpc } = createSettingsAnimationOverridesMain;
const createShortcutRuntime = require("./shortcut-runtime");
const {
  findNearestWorkArea,
  buildDisplaySnapshot,
  SYNTHETIC_WORK_AREA,
} = require("./work-area");
const {
  getLaunchPixelSize,
  getLaunchSizingWorkArea,
  getProportionalPixelSize,
} = require("./size-utils");
const { keepOutOfTaskbar } = require("./taskbar");
const createTopmostRuntime = require("./topmost-runtime");
const { WIN_TOPMOST_LEVEL } = createTopmostRuntime;
const createThemeFadeSequencer = require("./theme-fade-sequencer");
const createThemeRuntime = require("./theme-runtime");
const createAgentRuntimeMain = require("./agent-runtime-main");
const createFloatingWindowRuntime = require("./floating-window-runtime");
const createPetWindowRuntime = require("./pet-window-runtime");
const createMacHideController = require("./mac-hide");
const { createHardwareBuddyAdapter } = require("./hardware-buddy-adapter");
const {
  getFocusableLocalHudSessionIds: selectFocusableLocalHudSessionIds,
  getSessionFocusTarget,
} = require("./session-focus");
const { focusCodexThreadTarget } = require("./session-focus-handoff");
const { isSessionInProgress } = require("./state-session-snapshot");
const { getAllAgents } = require("../agents/registry");
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

// ── Windows: switch the dev console to UTF-8 ──
//
// `npm start` attaches Clawd to a parent PowerShell/cmd console. That
// console defaults to the system codepage (CP936 on zh-CN), so any
// Chinese string we console.log lands as mojibake — the strings are
// already UTF-8 in memory (after the GBK stderr decode fix), but the
// console interprets the bytes as GBK on the way out.
//
// SetConsoleOutputCP(65001) tells the attached console to interpret
// stdout/stderr as UTF-8 while Clawd is running. Packaged builds run under
// the Windows GUI subsystem with no console attached, so this call is a
// no-op there.
let _restoreConsoleOutputCP = null;
if (isWin) {
  try {
    const koffi = require("koffi");
    const kernel32 = koffi.load("kernel32.dll");
    const getConsoleOutputCP = kernel32.func("uint __stdcall GetConsoleOutputCP()");
    const setConsoleOutputCP = kernel32.func("bool __stdcall SetConsoleOutputCP(uint wCodePageID)");
    const previousOutputCP = getConsoleOutputCP();
    if (setConsoleOutputCP(65001) && previousOutputCP && previousOutputCP !== 65001) {
      let restored = false;
      _restoreConsoleOutputCP = () => {
        if (restored) return;
        restored = true;
        try { setConsoleOutputCP(previousOutputCP); } catch {}
      };
      app.once("will-quit", _restoreConsoleOutputCP);
      process.once("exit", _restoreConsoleOutputCP);
    }
  } catch (err) {
    // Best-effort — mojibake in dev console is annoying but not fatal.
    console.warn("Clawd: SetConsoleOutputCP(65001) failed:", err && err.message);
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
const { createTranslator, i18n, SUPPORTED_LANGS } = require("./i18n");
const {
  getBubblePolicy,
  isAllBubblesHidden,
} = require("./bubble-policy");
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

let shortcutRuntime = null;
let themeRuntime = null;
let agentRuntime = null;
let floatingWindowRuntime = null;
let codexPetMain = null;
let telegramApprovalSidecar = null;
let telegramApprovalSyncPromise = Promise.resolve();
let telegramApprovalConfigSignature = "";
let telegramApprovalTokenRevision = 0;
let _telegramMigrationController = null;
let telegramNativeRunner = null;
let telegramCompanion = null;
let telegramDirectSend = null;
let suppressTelegramApprovalSidecarSync = 0;
let hardwareBuddyAdapter = null;
let hardwareBuddyStatus = null;
let hardwareBuddyTestApprovalPromise = null;
let lastHardwareBuddyStatusLogKey = "";
let unsubscribeHardwareBuddySettings = null;
const shortcutHandlers = {
  togglePet: () => togglePetVisibility(),
};
const _settingsController = createSettingsController({
  prefsPath: PREFS_PATH,
  loadResult: _initialPrefsLoad,
  injectedDeps: {
    installAutoStart: _installAutoStartHook,
    uninstallAutoStart: _uninstallAutoStartHook,
    resolveTextScaleDisplayKey: () => getSettingsDisplayKey(),
    syncClaudeHooksNow: () => {
      const { registerHooksAsync } = require("../hooks/install.js");
      return registerHooksAsync({ silent: true, autoStart: autoStartWithClaude, port: getHookServerPort() });
    },
    uninstallClaudeHooksNow: _uninstallClaudeHooksNow,
    startClaudeSettingsWatcher: () => _server.startClaudeSettingsWatcher(),
    stopClaudeSettingsWatcher: () => _server.stopClaudeSettingsWatcher(),
    setOpenAtLogin: _writeSystemOpenAtLogin,
    startMonitorForAgent: (id) => agentRuntime && agentRuntime.startMonitorForAgent(id),
    stopMonitorForAgent: (id) => agentRuntime && agentRuntime.stopMonitorForAgent(id),
    syncIntegrationForAgent: (id) => agentRuntime ? agentRuntime.syncIntegrationForAgent(id) : false,
    repairIntegrationForAgent: (id, options) =>
      agentRuntime ? agentRuntime.repairIntegrationForAgent(id, options) : false,
    stopIntegrationForAgent: (id) => agentRuntime ? agentRuntime.stopIntegrationForAgent(id) : false,
    uninstallIntegrationForAgent: (id) => agentRuntime ? agentRuntime.uninstallIntegrationForAgent(id) : false,
    cleanupIntegrations: (options = {}) => {
      const { cleanupIntegrations } = require("../hooks/cleanup-integrations.js");
      return cleanupIntegrations({ ...options, backup: true, silent: true });
    },
    repairLocalServer: () => _server && typeof _server.repairRuntimeStatus === "function"
      ? _server.repairRuntimeStatus()
      : false,
    restartClawd: _restartClawdNow,
    clearSessionsByAgent: (id) => agentRuntime ? agentRuntime.clearSessionsByAgent(id) : 0,
    dismissPermissionsByAgent: (id, options) => agentRuntime ? agentRuntime.dismissPermissionsByAgent(id, options) : 0,
    resizePet: _deferredResizePet,
    getActiveSessionAliasKeys: () =>
      _state && typeof _state.getActiveSessionAliasKeys === "function"
        ? _state.getActiveSessionAliasKeys()
        : new Set(),
    writeTelegramApprovalToken: (token) => writeTelegramApprovalToken(token),
    getTelegramApprovalStatus: () => getTelegramApprovalStatus(),
    getTelegramApprovalTokenInfo: () => getTelegramApprovalTokenInfo(),
    sendTelegramApprovalTest: () => sendTelegramApprovalTest(),
    deleteTelegramApprovalTokenFile: () => deleteTelegramApprovalTokenFile(),
    // Lazy getter so settings-actions can use the controller even though it's
    // instantiated below (forward-reference).
    get telegramMigration() {
      return _telegramMigrationController;
    },
    // Theme runtime is wired after theme-loader.init(); keep these closures
    // lazy so settings actions never capture a pre-init runtime reference.
    activateTheme: (id, variantId, overrideMap) => themeRuntime.activateTheme(id, variantId, overrideMap),
    refreshActiveThemeHitboxOverrides: (id, overrideMap) =>
      themeRuntime.refreshActiveThemeHitboxOverrides(id, overrideMap),
    getThemeInfo: (id) => themeRuntime.getThemeInfo(id),
    removeThemeDir: (id) => themeRuntime.removeThemeDir(id),
    globalShortcut,
    shortcutHandlers,
    // The controller is created before shortcutRuntime because each side needs
    // the other. These callbacks may run before the runtime is assigned.
    getShortcutFailure: (actionId) => shortcutRuntime ? shortcutRuntime.getFailure(actionId) : null,
    clearShortcutFailure: (actionId) => {
      if (shortcutRuntime) shortcutRuntime.clearFailure(actionId);
    },
  },
});

// Mirror of `_settingsController.get("lang")` so existing sync read sites in
// menu.js / state.js / etc. don't have to round-trip through the controller.
// Updated by the settings-effect-router subscriber below; never
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

// First-run only: seed the UI language from the device locale. A brand-new
// install has no prefs file, so `lang` would otherwise sit at the schema default
// ("en") regardless of the user's OS language. Gated on _initialPrefsLoad.fresh
// (missing-file load) so a RETURNING user's chosen language is never touched.
// MUST run inside app.whenReady() — app.getLocale() is only stable after ready —
// and before createWindow() so the first menu/tray render is already localized.
function hydrateFreshInstallLanguage() {
  if (!_initialPrefsLoad || !_initialPrefsLoad.fresh) return;
  let detected = "en";
  try {
    detected = prefsModule.mapLocaleToLang(app.getLocale());
  } catch (err) {
    console.warn("Clawd: failed to detect device locale for language:", err && err.message);
    return;
  }
  if (detected && detected !== _settingsController.get("lang")) {
    _settingsController.applyUpdate("lang", detected);
  }
}

// Capture window/mini runtime state into the controller and write to disk.
// Replaces the legacy `savePrefs()` callsites — they used to read fresh
// `win.getBounds()` and `_mini.*` at save time, so we mirror that here.
function flushRuntimeStateToPrefs() {
  if (!win || win.isDestroyed()) return;
  const bounds = getPetWindowBounds();
  const theme = getActiveTheme();
  // #408: persist the frozen keep-size, not the live window bounds — otherwise a
  // bounds value inflated by a DPI flux gets saved and restored on relaunch.
  const isFrozenActive = keepSizeAcrossDisplaysCached && isProportionalMode();
  const persistPx = isFrozenActive
    ? getEffectiveCurrentPixelSize()
    : { width: bounds.width, height: bounds.height };
  // #408 round-2: also persist the frozen-origin work area (kept independent
  // of positionDisplay; see the schema comment on savedPixelWorkArea). Calling
  // getEffectiveCurrentPixelSize above already lazy-seeded the origin if it
  // wasn't seeded yet.
  const persistOriginWa = isFrozenActive
    ? (keepSizeFrozenOriginWa
        ? { width: keepSizeFrozenOriginWa.width, height: keepSizeFrozenOriginWa.height }
        : null)
    : null;
  _settingsController.applyBulk({
    x: bounds.x,
    y: bounds.y,
    positionSaved: true,
    positionThemeId: theme ? theme._id : "",
    positionVariantId: theme ? theme._variantId : "",
    positionDisplay: captureCurrentDisplaySnapshot(bounds),
    savedPixelWidth: persistPx.width,
    savedPixelHeight: persistPx.height,
    savedPixelWorkArea: persistOriginWa,
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
const createCodexPetMain = require("./codex-pet-main");
themeLoader.init(__dirname, app.getPath("userData"));
themeRuntime = createThemeRuntime({
  themeLoader,
  settingsController: _settingsController,
  fs,
  path,
  getRenderWindow: () => win,
  getHitWindow: () => hitWin,
  getStateRuntime: () => _state,
  getTickRuntime: () => _tick,
  getMiniRuntime: () => _mini,
  getAnimationOverridesRuntime: () => animationOverridesMain,
  getFadeSequencer: () => themeFadeSequencer,
  getPetWindowBounds,
  applyPetWindowBounds,
  computeFinalDragBounds,
  clampToScreenVisual,
  flushRuntimeStateToPrefs,
  syncHitStateAfterLoad,
  syncRendererStateAfterLoad,
  syncHitWin,
  syncSessionHudVisibility: () => syncSessionHudVisibility(),
  startMainTick: () => startMainTick(),
  bumpAnimationOverridePreviewPosterGeneration,
  rebuildAllMenus: () => rebuildAllMenus(),
  isManagedTheme: (themeId) => codexPetMain && codexPetMain.isManagedTheme(themeId),
});
themeLoader.bindActiveThemeRuntime(themeRuntime);

function getActiveTheme() {
  return themeRuntime ? themeRuntime.getActiveTheme() : null;
}

let animationOverridesMain = null;
function bumpAnimationOverridePreviewPosterGeneration() {
  return animationOverridesMain && animationOverridesMain.bumpPreviewPosterGeneration();
}
function maybeDestroyIdleAnimationPreviewPosterWindow() {
  if (animationOverridesMain) animationOverridesMain.maybeDestroyIdlePreviewPosterWindow();
}

const settingsWindowRuntime = createSettingsWindowRuntime({
  app,
  BrowserWindow,
  fs,
  isWin,
  nativeTheme,
  path,
  getPetWindowBounds: () => getPetWindowBounds(),
  getNearestWorkArea: (cx, cy) => getNearestWorkArea(cx, cy),
  getTextScale: () => effectiveTextScaleForKey(getSettingsDisplayKey()),
  onBeforeCreate: () => bumpAnimationOverridePreviewPosterGeneration(),
  onBeforeClosed: () => {
    bumpAnimationOverridePreviewPosterGeneration();
    if (shortcutRuntime) shortcutRuntime.stopRecording();
    void settingsSizePreviewSession.cleanup();
    // The renderer-side rollback (slider blur / control dispose) rides IPC
    // and can't be trusted while the window is being torn down — without
    // this, closing mid-drag leaves the transient preview scale applied to
    // the display until the next commit or restart.
    endTextScalePreview();
  },
  onAfterClosed: () => maybeDestroyIdleAnimationPreviewPosterWindow(),
});

function getSettingsWindow() {
  return settingsWindowRuntime.getWindow();
}

shortcutRuntime = createShortcutRuntime({
  ipcMain,
  globalShortcut,
  settingsController: _settingsController,
  getSettingsWindow,
  shortcutHandlers,
});

// The injected window/menu closures below are intentionally lazy. During
// startup before themeRuntime / win / Settings window / rebuildAllMenus exist,
// only the sync/summary/merge methods are safe to call.
codexPetMain = createCodexPetMain({
  app,
  BrowserWindow,
  dialog,
  fs,
  getActiveTheme: () => getActiveTheme(),
  getLang: () => lang,
  getMainWindow: () => win,
  getSettingsWindow,
  path,
  reloadActiveTheme: () => themeRuntime.reloadActiveTheme(),
  rebuildAllMenus: () => rebuildAllMenus(),
  settingsController: _settingsController,
  shell,
  themeLoader,
});
const REGISTER_PROTOCOL_DEV_ARG = codexPetMain.REGISTER_PROTOCOL_DEV_ARG;
// Lenient load so a missing/corrupt user-selected theme can't brick boot.
// If lenient fell back to "clawd" OR the variant fell back to "default",
// hydrate prefs to match so the store stays truth.
//
// Startup runs BEFORE the window is ready, so we call the runtime's initial
// load path, not activateTheme (which requires ready windows) and not the
// setThemeSelection command (which goes through activateTheme). The runtime
// switch path via UI goes through setThemeSelection post-window-ready.
let _requestedThemeId = _settingsController.get("theme") || "clawd";
const _initialVariantMap = _settingsController.get("themeVariant") || {};
let _requestedVariantId = _initialVariantMap[_requestedThemeId] || "default";
const _initialThemeOverrides = _settingsController.get("themeOverrides") || {};
let _requestedThemeOverrides = _initialThemeOverrides[_requestedThemeId] || null;
let _startupCodexPetSyncSummary = codexPetMain.syncThemes(_requestedThemeId);
if (codexPetMain.summaryHasActiveOrphan(_startupCodexPetSyncSummary, _requestedThemeId)) {
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
  _startupCodexPetSyncSummary = codexPetMain.mergeSyncSummaries(
    _startupCodexPetSyncSummary,
    codexPetMain.syncThemes(_requestedThemeId)
  );
  codexPetMain.setLastSyncSummary(_startupCodexPetSyncSummary);
}
const _loadedStartupTheme = themeRuntime.loadInitialTheme(_requestedThemeId, {
  variant: _requestedVariantId,
  overrides: _requestedThemeOverrides,
});
if (_loadedStartupTheme._id !== _requestedThemeId || _loadedStartupTheme._variantId !== _requestedVariantId) {
  const nextVariantMap = { ...(_settingsController.get("themeVariant") || {}) };
  // Self-heal: store the resolved ids so next boot doesn't fall back again.
  nextVariantMap[_loadedStartupTheme._id] = _loadedStartupTheme._variantId;
  if (_loadedStartupTheme._id !== _requestedThemeId) {
    delete nextVariantMap[_requestedThemeId];
  }
  const result = _settingsController.hydrate({
    theme: _loadedStartupTheme._id,
    themeVariant: nextVariantMap,
  });
  if (result && result.status === "error") {
    console.warn("Clawd: theme hydrate after fallback failed:", result.message);
  }
}

// ── Pet window geometry / bounds runtime ──
const petWindowRuntime = createPetWindowRuntime({
  screen,
  isWin,
  isMac,
  isLinux,
  linuxWindowType: LINUX_WINDOW_TYPE,
  topmostLevel: WIN_TOPMOST_LEVEL,
  getRenderWindow: () => win,
  getHitWindow: () => hitWin,
  getSettingsWindow: () => getSettingsWindow(),
  getActiveTheme: () => getActiveTheme(),
  getCurrentState: () => _state.getCurrentState(),
  getCurrentSvg: () => _state.getCurrentSvg(),
  getCurrentHitBox: () => _state.getCurrentHitBox(),
  getMiniMode: () => _mini.getMiniMode(),
  getMiniTransitioning: () => _mini.getMiniTransitioning(),
  getMiniContainedSeam: () => _mini.getContainedSeam(),
  getMiniPeekOffset: () => _mini.PEEK_OFFSET,
  getCurrentPixelSize: () => getCurrentPixelSize(),
  getEffectiveCurrentPixelSize: (workArea) => getEffectiveCurrentPixelSize(workArea),
  getKeepSizeAcrossDisplays: () => keepSizeAcrossDisplaysCached,
  getAllowEdgePinning: () => allowEdgePinningCached,
  isProportionalMode: () => isProportionalMode(),
  getPrimaryWorkAreaSafe: () => getPrimaryWorkAreaSafe(),
  getNearestWorkArea,
  sendToRenderer,
  keepOutOfTaskbar,
  repositionSessionHud: () => repositionSessionHud(),
  repositionAnchoredSurfaces: () => repositionAnchoredFloatingSurfaces(),
  repositionFloatingBubbles: () => repositionFloatingBubbles(),
  showFloatingSurfacesForPet: () => floatingWindowRuntime.showFloatingSurfacesForPet(),
  hideFloatingSurfacesForPet: () => floatingWindowRuntime.hideFloatingSurfacesForPet(),
  syncSessionHudVisibilityAndBubbles: () => syncSessionHudVisibilityAndBubbles(),
  syncPermissionShortcuts: () => syncPermissionShortcuts(),
  buildTrayMenu: () => buildTrayMenu(),
  buildContextMenu: () => buildContextMenu(),
  reapplyMacVisibility: () => reapplyMacVisibility(),
  reassertWinTopmost: () => reassertWinTopmost(),
  scheduleHwndRecovery: () => scheduleHwndRecovery(),
  isNearWorkAreaEdge: (bounds) => isNearWorkAreaEdge(bounds),
  flushRuntimeStateToPrefs: () => flushRuntimeStateToPrefs(),
  handleMiniDisplayChange: () => _mini.handleDisplayChange(),
  exitMiniMode: () => exitMiniMode(),
});

function getObjRect(bounds) {
  return petWindowRuntime.getObjRect(bounds);
}

function getAssetPointerPayload(bounds, point) {
  return petWindowRuntime.getAssetPointerPayload(bounds, point);
}

let win;
let hitWin;  // input window — small opaque rect over hitbox, receives all pointer events

// Tray icon flash state
let trayFlashTimer = null;
let trayFlashStopTimer = null;
let trayFlashNormalIcon = null;
let trayFlashHighlightIcon = null;
let tray = null;
let contextMenuOwner = null;
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

// #408: while keepSizeAcrossDisplays is ON, the frozen pixel size is held in
// memory (keepSizeFrozenPx) rather than re-read from win.getBounds() on every
// access. Re-reading the live bounds let a transiently-wrong value during a
// Windows sleep/wake DPI flux get laundered back through setBounds(), ratcheting
// the pet larger each cycle ("the longer it sleeps, the bigger it gets"). Seeded
// at launch and lazily on first use; cleared (→ re-seeded from the proportional
// size) whenever the size or the keepSize toggle changes.
let keepSizeFrozenPx = null;
// #408 round-2: track the *origin* display's work area alongside the frozen
// pixel size so a legitimate cross-display keep-size (set on a large display,
// later moved to a smaller one via "Send to display") is not mis-clamped on
// the next launch — positionDisplay tracks the LAST-FLUSH display, which after
// a send diverges from the actual frozen origin. Lifecycle mirrors
// keepSizeFrozenPx (lazy-seeded together, reset together, persisted together).
let keepSizeFrozenOriginWa = null;

function resetKeepSizeFrozen() {
  keepSizeFrozenPx = null;
  keepSizeFrozenOriginWa = null;
}

function snapshotKeepSizeOriginWa(wa) {
  if (!wa || typeof wa !== "object") return null;
  const w = Number(wa.width);
  const h = Number(wa.height);
  if (!Number.isFinite(w) || w <= 0) return null;
  if (!Number.isFinite(h) || h <= 0) return null;
  return { width: w, height: h };
}

function getEffectiveCurrentPixelSize(overrideWa) {
  if (keepSizeAcrossDisplaysCached && isProportionalMode()) {
    // #408: seed from the CURRENT display's proportional size, never from an
    // overrideWa — callers like sendToDisplay/bringPetToPrimaryDisplay pass a
    // *target* display's work area, and seeding from that would freeze the
    // pet at the target's proportional size instead of its realized size.
    if (!keepSizeFrozenPx) {
      // Mirror getPixelSizeFor's wa resolution so the captured origin matches
      // the display we actually sized from.
      let seedWa = null;
      if (win && !win.isDestroyed()) {
        const { x, y, width, height } = getPetWindowBounds();
        seedWa = getNearestWorkArea(x + width / 2, y + height / 2);
      }
      if (!seedWa) seedWa = getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA;
      keepSizeFrozenPx = getProportionalPixelSize(getProportionalRatio(), seedWa);
      keepSizeFrozenOriginWa = snapshotKeepSizeOriginWa(seedWa);
    }
    return { width: keepSizeFrozenPx.width, height: keepSizeFrozenPx.height };
  }
  return getCurrentPixelSize(overrideWa);
}
let contextMenu;
let doNotDisturb = false;
let isQuitting = false;
// Mirror caches: kept in sync with the settings store via settings-effect-router
// further down. Read freely; never assign
// directly (writes go through ctx setters → controller.applyUpdate).
let showTray = _settingsController.get("showTray");
let showDock = _settingsController.get("showDock");
let manageClaudeHooksAutomatically = _settingsController.get("manageClaudeHooksAutomatically");
let autoStartWithClaude = _settingsController.get("autoStartWithClaude");
let openAtLogin = _settingsController.get("openAtLogin");
let bubbleFollowPet = _settingsController.get("bubbleFollowPet");
let sessionHudEnabled = _settingsController.get("sessionHudEnabled");
let sessionHudShowStateLabels = _settingsController.get("sessionHudShowStateLabels");
let sessionHudShowElapsed = _settingsController.get("sessionHudShowElapsed");
let sessionHudShowContextUsage = _settingsController.get("sessionHudShowContextUsage");
let sessionHudCleanupDetached = _settingsController.get("sessionHudCleanupDetached");
let sessionHudPinned = _settingsController.get("sessionHudPinned");
let sessionStaleMs = _settingsController.get("sessionStaleMs");
let workingStaleMs = _settingsController.get("workingStaleMs");
let detachedIdleStaleMs = _settingsController.get("detachedIdleStaleMs");
let soundMuted = _settingsController.get("soundMuted");
let soundVolume = _settingsController.get("soundVolume");
let lowPowerIdleMode = _settingsController.get("lowPowerIdleMode");
let keepAwakeWhileWorking = _settingsController.get("keepAwakeWhileWorking");
let allowEdgePinningCached = _settingsController.get("allowEdgePinning");
let disableMiniModeCached = _settingsController.get("disableMiniMode");
let keepSizeAcrossDisplaysCached = _settingsController.get("keepSizeAcrossDisplays");
let textScale = _settingsController.get("textScale");
let textScaleByDisplay = _settingsController.get("textScaleByDisplay");
// Transient slider-drag override for ONE display — the one the settings
// window sits on (what you see is what you tune). Applied to live windows but
// never written to the store; cleared on commit (mirror setters) or rollback
// (endTextScalePreview).
let textScalePreview = null; // { key: string, value: number }

function getDisplayKeyForBounds(bounds) {
  if (!bounds) return null;
  try {
    const display = screen.getDisplayMatching(bounds);
    return display && display.id != null ? String(display.id) : null;
  } catch {
    return null;
  }
}

function getPetDisplayKey() {
  // Resolve from the pet's CENTER POINT, not the window rect: the pet windows
  // use enableLargerThanScreen and can overhang display edges, which makes
  // getDisplayMatching unstable. Nearest-point matches the same anchor the
  // bubble/HUD geometry uses (getNearestWorkArea of the pet center), so the
  // zoom value and the layout always agree on which display they are on.
  try {
    const bounds = getPetWindowBounds();
    if (!bounds) return null;
    const point = {
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
    };
    const display = screen.getDisplayNearestPoint(point);
    return display && display.id != null ? String(display.id) : null;
  } catch {
    return null;
  }
}

function getWindowDisplayKey(win) {
  if (!win || typeof win.isDestroyed !== "function" || win.isDestroyed()) return null;
  try { return getDisplayKeyForBounds(win.getBounds()); } catch { return null; }
}

function getSettingsDisplayKey() {
  return getWindowDisplayKey(settingsWindowRuntime.getWindow()) || getPetDisplayKey();
}

function effectiveTextScaleForKey(key) {
  if (textScalePreview && key && textScalePreview.key === key) {
    return clampTextScale(textScalePreview.value);
  }
  return resolveTextScaleForKey(textScaleByDisplay, textScale, key);
}

// Pet-anchored floating windows (permission bubbles, update bubble, session
// HUD) all read the scale of whichever display the pet is on right now.
function getTextScaleForPetWindows() {
  return effectiveTextScaleForKey(getPetDisplayKey());
}

// textScale changed (commit, preview tick, or display change): the resizable
// windows re-zoom themselves against their own display, and the pet-anchored
// floating windows re-resolve scale + re-inject zoom inside their reposition
// paths (applyZoomToWindow memoizes, so this is cheap to call broadly).
function applyTextScaleNow() {
  try {
    if (settingsWindowRuntime && typeof settingsWindowRuntime.applyTextScaleToWindow === "function") {
      settingsWindowRuntime.applyTextScaleToWindow();
    }
  } catch (err) {
    console.warn("Clawd: settings window text scale failed:", err && err.message);
  }
  try {
    if (_dashboard && typeof _dashboard.applyTextScaleToWindow === "function") {
      _dashboard.applyTextScaleToWindow();
    }
  } catch (err) {
    console.warn("Clawd: dashboard text scale failed:", err && err.message);
  }
  repositionAnchoredFloatingSurfaces();
}

function previewTextScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    textScalePreview = null;
  } else {
    const key = getSettingsDisplayKey();
    textScalePreview = key ? { key, value: clampTextScale(n) } : null;
  }
  applyTextScaleNow();
  return { status: "ok" };
}

function endTextScalePreview() {
  if (!textScalePreview) return { status: "ok", noop: true };
  textScalePreview = null;
  applyTextScaleNow();
  return { status: "ok" };
}

function getRuntimeBubblePolicy(kind) {
  return getBubblePolicy(_settingsController.getSnapshot(), kind);
}

function getAllBubblesHidden() {
  return isAllBubblesHidden(_settingsController.getSnapshot());
}

let macHideController = null; // macOS app-hidden ↔ pet visibility bridge (#416); created in whenReady
// Shared mac prep for any manual "show / move the pet" entry point (tray,
// shortcut, bring-to-primary): release OS-hide ownership so a later
// activate/unhide won't falsely restore, and if the app is OS-hidden, unhide it
// first to avoid a "window shown but app still hidden" limbo.
function prepManualPetVisibility() {
  if (macHideController) macHideController.noteManualChange();
  if (isMac && petWindowRuntime.isPetHidden() && typeof app.isHidden === "function" && app.isHidden()) {
    try { app.show(); } catch (_) {}
  }
}
function togglePetVisibility() {
  prepManualPetVisibility();
  return petWindowRuntime.togglePetVisibility();
}
function bringPetToPrimaryDisplay() {
  prepManualPetVisibility();
  return petWindowRuntime.bringPetToPrimaryDisplay();
}

function sendToRenderer(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}
function sendToHitWin(channel, ...args) {
  if (hitWin && !hitWin.isDestroyed()) hitWin.webContents.send(channel, ...args);
}

function getThemeSoundPreloadUrls() {
  const urls = [];
  for (const name of ["complete", "confirm"]) {
    const url = themeRuntime.getSoundUrl(name);
    if (url && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

function syncSoundPreloads() {
  const urls = getThemeSoundPreloadUrls();
  if (urls.length) sendToRenderer("preload-sounds", { urls });
}

function setViewportOffsetY(offsetY) { return petWindowRuntime.setViewportOffsetY(offsetY); }
function getPetWindowBounds() { return petWindowRuntime.getPetWindowBounds(); }
function applyPetWindowBounds(bounds) { return petWindowRuntime.applyPetWindowBounds(bounds); }
function applyPetWindowPosition(x, y) { return petWindowRuntime.applyPetWindowPosition(x, y); }

function syncHitStateAfterLoad() {
  sendToHitWin("hit-state-sync", {
    currentSvg: _state.getCurrentSvg(),
    currentState: _state.getCurrentState(),
    miniMode: _mini.getMiniMode(),
    dndEnabled: doNotDisturb,
  });
}

function syncRendererStateAfterLoad({ includeStartupRecovery = true } = {}) {
  syncSoundPreloads();
  sendToRenderer("low-power-idle-mode-change", lowPowerIdleMode);
  if (_mini.getMiniMode()) {
    sendToRenderer("mini-mode-change", true, _mini.getMiniEdge());
    // mini-clip is a renderer inline style — a renderer/theme reload (and
    // startup recovery) drops it. Re-send the current seam clip so a
    // contained mini stays clipped instead of bleeding onto the neighbour.
    _mini.syncContainedClip();
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
  const url = themeRuntime.getSoundUrl(name);
  if (!url) return;
  lastSoundTime = now;
  sendToRenderer("play-sound", { url, volume: soundVolume });
}

function resetSoundCooldown() {
  lastSoundTime = 0;
}

function stopTrayFlash() {
  if (trayFlashTimer) {
    clearInterval(trayFlashTimer);
    trayFlashTimer = null;
  }
  if (trayFlashStopTimer) {
    clearTimeout(trayFlashStopTimer);
    trayFlashStopTimer = null;
  }
  const t = _menu.getTray ? _menu.getTray() : null;
  if (t && trayFlashNormalIcon) {
    t.setImage(trayFlashNormalIcon);
  }
}

function flashTaskbar() {
  if (doNotDisturb) return;
  if (!_settingsController.get("flashTaskbarOnComplete")) return;

  const tray = _menu.getTray ? _menu.getTray() : null;
  if (!tray) return;

  // Cache the normal icon on first call
  if (!trayFlashNormalIcon) {
    if (process.platform === "darwin") {
      trayFlashNormalIcon = nativeImage.createFromPath(
        path.join(__dirname, "../assets/tray-iconTemplate.png")
      );
      trayFlashNormalIcon.setTemplateImage(true);
    } else {
      trayFlashNormalIcon = nativeImage.createFromPath(
        path.join(__dirname, "../assets/tray-icon.png")
      ).resize({ width: 32, height: 32 });
    }
  }

  // Cache the highlight icon (orange circle) on first call
  if (!trayFlashHighlightIcon) {
    const flashPath = path.join(__dirname, "../assets/tray-icon-flash.png");
    if (fs.existsSync(flashPath)) {
      const img = nativeImage.createFromPath(flashPath).resize({ width: 32, height: 32 });
      if (!img.isEmpty()) {
        trayFlashHighlightIcon = img;
      }
    }
  }

  if (!trayFlashHighlightIcon) return;

  // Clear any existing flash timers
  if (trayFlashTimer) clearInterval(trayFlashTimer);
  if (trayFlashStopTimer) {
    clearTimeout(trayFlashStopTimer);
    trayFlashStopTimer = null;
  }

  const intervalMs = _settingsController.get("flashIntervalMs") || 500;
  const durationMs = _settingsController.get("flashDurationMs");
  // durationMs defaults to 5000; 0 means flash until manually stopped

  let useHighlight = true;
  trayFlashTimer = setInterval(() => {
    if (!_menu.getTray || !_menu.getTray()) {
      stopTrayFlash();
      return;
    }
    const t = _menu.getTray();
    t.setImage(useHighlight ? trayFlashHighlightIcon : trayFlashNormalIcon);
    useHighlight = !useHighlight;
  }, intervalMs);

  // Auto-stop after duration (unless duration is 0 = always)
  if (durationMs !== 0) {
    trayFlashStopTimer = setTimeout(() => {
      stopTrayFlash();
    }, durationMs || 5000);
  }

  // Stop on tray click
  tray.removeAllListeners("click");
  tray.on("click", () => {
    stopTrayFlash();
    tray.removeAllListeners("click");
  });
}

function syncHitWin() { return petWindowRuntime.syncHitWin(); }

let mouseOverPet = false;
let menuOpen = false;
let idlePaused = false;
let lowPowerIdlePaused = false;
let forceEyeResend = false;
let forceEyeResendBoostUntil = 0;
let requestFastTick = () => {};
let repositionSessionHud = () => {};
let syncSessionHudVisibility = () => {};
let broadcastSessionHudSnapshot = () => {};
let sendSessionHudI18n = () => {};
let getSessionHudReservedOffset = () => 0;
let getSessionHudWindow = () => null;
const themeFadeSequencer = createThemeFadeSequencer({
  getRenderWindow: () => win,
  getHitWindow: () => hitWin,
  fadeOutMs: THEME_SWITCH_FADE_OUT_MS,
  fadeInMs: THEME_SWITCH_FADE_IN_MS,
  fallbackMs: THEME_SWITCH_FADE_FALLBACK_MS,
});

function setForceEyeResend(value) {
  forceEyeResend = !!value;
  if (forceEyeResend) {
    forceEyeResendBoostUntil = Math.max(forceEyeResendBoostUntil, Date.now() + 2000);
    requestFastTick(100);
  }
}

function setLowPowerIdlePaused(value) {
  const next = !!value;
  if (lowPowerIdlePaused === next) return;
  lowPowerIdlePaused = next;
  if (!next) setForceEyeResend(true);
}

function beginDragSnapshot() { return petWindowRuntime.beginDragSnapshot(); }
function clearDragSnapshot() { return petWindowRuntime.clearDragSnapshot(); }
function moveWindowForDrag() { return petWindowRuntime.moveWindowForDrag(); }

// ── Mini Mode — delegated to src/mini.js ──
// Initialized after state module (needs applyState, resolveDisplayState, etc.)
// See _mini initialization below

// ── alwaysOnTop recovery — delegated to src/topmost-runtime.js ──
const topmostRuntime = createTopmostRuntime({
  isWin,
  isMac,
  getWin: () => win,
  getHitWin: () => hitWin,
  getPendingPermissions: () => pendingPermissions,
  getUpdateBubbleWindow: () => _updateBubble.getBubbleWindow(),
  getSessionHudWindow: () => getSessionHudWindow(),
  getContextMenuOwner: () => contextMenuOwner,
  getNearestWorkArea,
  getPetWindowBounds,
  getShowDock: () => showDock,
  isDragLocked: () => petWindowRuntime.isDragLocked(),
  isMiniAnimating: () => _mini.getIsAnimating(),
  isMiniTransitioning: () => _mini.getMiniTransitioning(),
  keepOutOfTaskbar,
  setForceEyeResend,
  applyPetWindowPosition,
  syncHitWin,
});
const {
  reassertWinTopmost,
  reapplyMacVisibility,
  isNearWorkAreaEdge,
  scheduleHwndRecovery,
  guardAlwaysOnTop,
  startTopmostWatchdog,
} = topmostRuntime;

// ── Permission bubble — delegated to src/permission.js ──
const {
  isAgentEnabled: _isAgentEnabled,
  isAgentPermissionsEnabled: _isAgentPermissionsEnabled,
  isAgentSubagentPermissionsEnabled: _isAgentSubagentPermissionsEnabled,
  isAgentNotificationHookEnabled: _isAgentNotificationHookEnabled,
  isCodexNativeNotificationSoundEnabled: _isCodexNativeNotificationSoundEnabled,
  isCodexPermissionInterceptEnabled: _isCodexPermissionInterceptEnabled,
  shouldSyncAgentIntegration: _shouldSyncAgentIntegration,
} = require("./agent-gate");
const _permCtx = {
  get win() { return win; },
  get lang() { return lang; },
  get sessions() { return sessions; },
  get bubbleFollowPet() { return bubbleFollowPet; },
  get permDebugLog() { return permDebugLog; },
  get doNotDisturb() { return doNotDisturb; },
  get hideBubbles() { return getAllBubblesHidden(); },
  get petHidden() { return petWindowRuntime.isPetHidden(); },
  getBubblePolicy: getRuntimeBubblePolicy,
  getPetWindowBounds,
  getNearestWorkArea,
  getHitRectScreen,
  getHudReservedOffset: () => getSessionHudReservedOffset(),
  getTextScale: () => getTextScaleForPetWindows(),
  guardAlwaysOnTop,
  reapplyMacVisibility,
  isAgentPermissionsEnabled: (agentId) =>
    _isAgentPermissionsEnabled({ agents: _settingsController.get("agents") }, agentId),
  // DANGER "auto-pilot": when true, showPermissionBubble auto-approves every
  // request instead of rendering a bubble. DND / per-agent / headless gates
  // run earlier in the route, so they still win — this only fires once a
  // bubble would otherwise show. Headless fallback stays agent-specific
  // (no-decision/native fallback, opencode silent TUI fallback, or CC deny).
  isAutoApproveAllEnabled: () =>
    _settingsController.get("autoApproveAllPermissions") === true,
  focusTerminalForSession: (sessionId, options = {}) => {
    focusDashboardSession(sessionId, {
      requestSource: options.requestSource || "permission-bubble",
      fallbackEntry: options.fallbackEntry || getPendingPermissionFocusEntry(sessionId),
    });
  },
  getSettingsSnapshot: () => _settingsController.getSnapshot(),
  subscribeShortcuts: (cb) => _settingsController.subscribeKey("shortcuts", (_value, snapshot) => {
    if (typeof cb === "function") cb(snapshot);
  }),
  reportShortcutFailure: (actionId, reason) => shortcutRuntime.reportFailure(actionId, reason),
  clearShortcutFailure: (actionId) => shortcutRuntime.clearFailure(actionId),
  repositionUpdateBubble: () => repositionUpdateBubble(),
  getTelegramApprovalClient: () => getTelegramApprovalClient(),
  onPermissionsChanged: () => {
    if (hardwareBuddyAdapter) hardwareBuddyAdapter.notifyPermissionsChanged();
  },
  onPermissionResolved: (permEntry, options = {}) => {
    if (!_state || typeof _state.clearPermissionNotification !== "function") return;
    _state.clearPermissionNotification(permEntry && permEntry.sessionId, options);
  },
};
const _perm = initPermission(_permCtx);
const { showPermissionBubble, resolvePermissionEntry, sendPermissionResponse, repositionBubbles, permLog, PASSTHROUGH_TOOLS, addPendingPermission, removePendingPermission, maybeStartRemoteApproval, showCodexNotifyBubble, clearCodexNotifyBubbles, showKimiNotifyBubble, clearKimiNotifyBubbles, syncPermissionShortcuts, replyOpencodePermission } = _perm;
const pendingPermissions = _perm.pendingPermissions;
let permDebugLog = null; // set after app.whenReady()
let updateDebugLog = null; // set after app.whenReady()
let sessionDebugLog = null; // set after app.whenReady()
let focusDebugLog = null; // set after app.whenReady()

function getPendingPermissionFocusEntry(sessionId) {
  const id = String(sessionId || "");
  if (!id) return null;
  const entry = pendingPermissions.find((perm) => perm && perm.sessionId === id && perm.agentId === "codex");
  if (!entry) return null;
  const focusEntry = { id, agentId: entry.agentId };
  if (entry.sourcePid) focusEntry.sourcePid = entry.sourcePid;
  if (entry.wtHwnd) focusEntry.wtHwnd = entry.wtHwnd;
  if (entry.cwd) focusEntry.cwd = entry.cwd;
  if (entry.agentPid) focusEntry.agentPid = entry.agentPid;
  if (entry.pidChain) focusEntry.pidChain = entry.pidChain;
  if (entry.tmuxSocket) focusEntry.tmuxSocket = entry.tmuxSocket;
  if (entry.tmuxClient) focusEntry.tmuxClient = entry.tmuxClient;
  if (entry.host) focusEntry.host = entry.host;
  if (entry.platform) focusEntry.platform = entry.platform;
  if (entry.model) focusEntry.model = entry.model;
  if (entry.codexOriginator) focusEntry.codexOriginator = entry.codexOriginator;
  if (entry.codexSource) focusEntry.codexSource = entry.codexSource;
  return focusEntry;
}

const _updateBubbleCtx = {
  get win() { return win; },
  get bubbleFollowPet() { return bubbleFollowPet; },
  get petHidden() { return petWindowRuntime.isPetHidden(); },
  getBubblePolicy: getRuntimeBubblePolicy,
  getPendingPermissions: () => pendingPermissions,
  getPetWindowBounds,
  getNearestWorkArea,
  getUpdateBubbleAnchorRect,
  getHitRectScreen,
  getHudReservedOffset: () => getSessionHudReservedOffset(),
  getTextScale: () => getTextScaleForPetWindows(),
  guardAlwaysOnTop,
  reapplyMacVisibility,
};
const _updateBubble = initUpdateBubble(_updateBubbleCtx);
const {
  showUpdateBubble,
  hideUpdateBubble,
  repositionUpdateBubble,
  syncVisibility: syncUpdateBubbleVisibility,
} = _updateBubble;

floatingWindowRuntime = createFloatingWindowRuntime({
  getPendingPermissions: () => pendingPermissions,
  repositionPermissionBubbles: () => repositionBubbles(),
  repositionUpdateBubble: () => repositionUpdateBubble(),
  repositionSessionHud: () => repositionSessionHud(),
  syncSessionHudVisibility: () => syncSessionHudVisibility(),
  syncUpdateBubbleVisibility: () => syncUpdateBubbleVisibility(),
  hideUpdateBubble: () => hideUpdateBubble(),
  keepOutOfTaskbar,
});

function repositionFloatingBubbles() {
  return floatingWindowRuntime.repositionFloatingBubbles();
}

function repositionAnchoredFloatingSurfaces() {
  return floatingWindowRuntime.repositionAnchoredSurfaces();
}

function syncSessionHudVisibilityAndBubbles() {
  return floatingWindowRuntime.syncSessionHudVisibilityAndBubbles();
}

// ── State machine — delegated to src/state.js ──
let showDashboard = () => {};
let broadcastDashboardSessionSnapshot = () => {};
let sendDashboardI18n = () => {};

// Forward hook for the #329 updater scheduler. State/mini ctxs reference
// this via notifyUpdaterSilentExit; the actual implementation is wired
// after the updater module is constructed below.
let notifyUpdaterSilentExit = () => {};

const _stateCtx = {
  get theme() { return getActiveTheme(); },
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
  notifyUpdaterSilentExit: () => notifyUpdaterSilentExit(),
  sendToRenderer,
  sendToHitWin,
  syncHitWin,
  playSound,
  flashTaskbar,
  t: (key) => t(key),
  focusTerminalWindow: (...args) => focusTerminalWindow(...args),
  resolvePermissionEntry: (...args) => resolvePermissionEntry(...args),
  dismissPermissionsForDnd: (...args) => _perm.dismissPermissionsForDnd(...args),
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
    reconcilePowerSaveBlocker();
    broadcastDashboardSessionSnapshot(snapshot);
    broadcastSessionHudSnapshot(snapshot);
    repositionFloatingBubbles();
    if (hardwareBuddyAdapter) hardwareBuddyAdapter.notifyStateChanged();
    // R1a: best-effort completion notifications. Must never throw or block the
    // broadcast — the companion computes synchronously and fires sends async.
    if (telegramCompanion) {
      try { telegramCompanion.onSnapshot(snapshot); } catch {}
    }
    if (_lanWss) { try { _lanWss.onSnapshot(); } catch {} }
  },
  // Phase 3b: 读 prefs.themeOverrides 判断某个 oneshot state 是否被用户禁用。
  // state.js gate 调这个做 early-return。不做白名单校验——settings-actions
  // 负责写入合法性，这里只读。
  isOneshotDisabled: (stateKey) => {
    const theme = getActiveTheme();
    const themeId = theme && theme._id;
    if (!themeId || !stateKey) return false;
    const overrides = _settingsController.get("themeOverrides");
    const themeMap = overrides && overrides[themeId];
    const stateMap = themeMap && themeMap.states;
    const entry = (stateMap && stateMap[stateKey]) || (themeMap && themeMap[stateKey]);
    return !!(entry && entry.disabled === true);
  },
  get sessionHudCleanupDetached() { return sessionHudCleanupDetached; },
  getStaleConfig: () => ({
    sessionStaleMs,
    workingStaleMs,
    detachedIdleStaleMs,
  }),
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

// ── Keep-awake: block OS sleep while any agent task is in progress ──
// State→in-progress mapping lives in state-session-snapshot.isSessionInProgress
// (kept as a pure helper so the semantics are unit-tested).
let powerSaveBlockerId = null;
function anySessionInProgress() {
  for (const [, s] of sessions) {
    if (isSessionInProgress(s)) return true;
  }
  return false;
}
function reconcilePowerSaveBlocker() {
  try {
    const shouldBlock = keepAwakeWhileWorking && anySessionInProgress();
    const active = powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId);
    if (shouldBlock && !active) {
      powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    } else if (!shouldBlock && active) {
      powerSaveBlocker.stop(powerSaveBlockerId);
      powerSaveBlockerId = null;
    }
  } catch (err) {
    console.warn("Clawd: reconcilePowerSaveBlocker failed:", err);
  }
}
function releasePowerSaveBlocker() {
  try {
    if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
      powerSaveBlocker.stop(powerSaveBlockerId);
    }
  } catch {}
  powerSaveBlockerId = null;
}

// ── Hit-test: SVG bounding box → screen coordinates ──
function getHitRectScreen(bounds) { return petWindowRuntime.getHitRectScreen(bounds); }
function getUpdateBubbleAnchorRect(bounds) { return petWindowRuntime.getUpdateBubbleAnchorRect(bounds); }
function getSessionHudAnchorRect(bounds) { return petWindowRuntime.getSessionHudAnchorRect(bounds); }

// ── Main tick — delegated to src/tick.js ──
const _tickCtx = {
  get theme() { return getActiveTheme(); },
  get win() { return win; },
  getPetWindowBounds,
  get currentState() { return _state.getCurrentState(); },
  get currentSvg() { return _state.getCurrentSvg(); },
  get miniMode() { return _mini.getMiniMode(); },
  get miniTransitioning() { return _mini.getMiniTransitioning(); },
  get dragLocked() { return petWindowRuntime.isDragLocked(); },
  get menuOpen() { return menuOpen; },
  get idlePaused() { return idlePaused; },
  get lowPowerIdlePaused() { return lowPowerIdlePaused; },
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
  get roam() { return _roam; },
};
const _tick = require("./tick")(_tickCtx);
requestFastTick = (maxDelay) => _tick.scheduleSoon(maxDelay);
const { startMainTick, resetIdleTimer } = _tick;

// ── Terminal focus — delegated to src/focus.js ──
const _focus = require("./focus")({ _allowSetForeground, focusLog });
const {
  initFocusHelper,
  killFocusHelper,
  focusTerminalWindow,
  captureGhosttyTerminalId,
  clearMacFocusCooldownTimer,
} = _focus;

function getFocusableLocalHudSessionIds() {
  if (!_state || typeof _state.buildSessionSnapshot !== "function") return [];
  return selectFocusableLocalHudSessionIds(_state.buildSessionSnapshot(), { osPlatform: process.platform });
}

function focusTerminalSession(session, sessionId, requestSource) {
  if (!session || !session.sourcePid) return false;
  return focusTerminalWindow({
    sourcePid: session.sourcePid,
    wtHwnd: session.wtHwnd,
    cwd: session.cwd,
    editor: session.editor,
    pidChain: session.pidChain,
    tmuxSocket: session.tmuxSocket,
    tmuxClient: session.tmuxClient,
    ghosttyTerminalId: session.ghosttyTerminalId,
    sessionId: String(sessionId),
    agentId: session.agentId,
    requestSource,
  });
}

function focusDashboardSession(sessionId, options = {}) {
  if (!sessionId) return false;
  const requestSource = options.requestSource || "dashboard";
  const id = String(sessionId);
  const session = sessions.get(id);
  const fallbackEntry = options.fallbackEntry && typeof options.fallbackEntry === "object"
    ? options.fallbackEntry
    : null;
  if (!session && !fallbackEntry) {
    focusLog(`focus result branch=none reason=session-not-found source=${requestSource} sid=${id}`);
    return false;
  }

  const focusEntry = { ...(session || {}), ...(fallbackEntry || {}), id };
  const focusTarget = getSessionFocusTarget(focusEntry, { osPlatform: process.platform });
  if (focusTarget.type === "codex-thread" && focusTarget.url) {
    focusCodexThreadTarget({
      shell,
      focusEntry,
      sessionId: id,
      requestSource,
      url: focusTarget.url,
      focusLog,
      focusTerminalSession,
    });
    return true;
  }

  if (focusTarget.type === "terminal") {
    return focusTerminalSession(focusEntry, id, requestSource);
  }

  if (focusEntry.platform === "webui") {
    focusLog(`focus result branch=none reason=webui-unfocusable source=${requestSource} sid=${id}`);
  } else {
    focusLog(`focus result branch=none reason=no-source-pid source=${requestSource} sid=${id}`);
  }
  return false;
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
  getSettingsWindow: () => settingsWindowRuntime.getWindow(),
  getTextScale: () => effectiveTextScaleForKey(
    getWindowDisplayKey(_dashboard ? _dashboard.getWindow() : null) || getPetDisplayKey()
  ),
  iconPath: settingsWindowRuntime.getIconPath(),
});
showDashboard = _dashboard.showDashboard;
broadcastDashboardSessionSnapshot = _dashboard.broadcastSessionSnapshot;
sendDashboardI18n = _dashboard.sendI18n;

// ── First-run onboarding tutorial ──
// Buckets the installable agents for the tutorial's step 2. We call the
// detector with skipDefaultIntegrations:false so the default integrations
// (claude-code, codex) are checked too — that's the only way to flag the
// marquee "default Codex hook but Codex isn't installed → recommend removing"
// case, which the Settings UI doesn't surface.
function buildTutorialAgentOnboardingState() {
  const { detectAgentInstallations } = require("./agent-installation-detector");
  const { INSTALLABLE_AGENT_IDS } = require("./settings-actions-agents");
  const { bucketAgentsForTutorial } = require("./tutorial-agent-buckets");
  let detection = { agents: [] };
  try {
    detection = detectAgentInstallations({ skipDefaultIntegrations: false }) || detection;
  } catch (err) {
    console.warn("Clawd: tutorial agent detection failed:", err && err.message);
  }
  return bucketAgentsForTutorial({
    detectionAgents: detection.agents,
    agentsPref: _settingsController.get("agents") || {},
    installableIds: INSTALLABLE_AGENT_IDS,
  });
}

// The editable shortcuts the tutorial teaches. Reflects the user's current
// binding (null when they've unassigned it) and falls back to the shipped
// default only when the key has never been touched.
function buildTutorialShortcutsSummary() {
  const { SHORTCUT_ACTIONS, SHORTCUT_ACTION_IDS } = require("./shortcut-actions");
  const userShortcuts = _settingsController.get("shortcuts") || {};
  return SHORTCUT_ACTION_IDS.map((id) => {
    const action = SHORTCUT_ACTIONS[id] || {};
    const accelerator = Object.prototype.hasOwnProperty.call(userShortcuts, id)
      ? userShortcuts[id]
      : action.defaultAccelerator;
    return {
      id,
      label: translate(action.labelKey),
      accelerator,
      defaultAccelerator: action.defaultAccelerator,
      persistent: !!action.persistent,
    };
  });
}

// The welcome screen uses the app icon so first run feels like product setup.
// Keep this as a file URL so repeated tutorial state pushes don't clone the
// 1.46 MB PNG as a base64 string on every agent/shortcut update.
let _tutorialHeroSrcCache = null;
function getTutorialHeroSrc() {
  if (_tutorialHeroSrcCache != null) return _tutorialHeroSrcCache;
  try {
    _tutorialHeroSrcCache = pathToFileURL(path.join(__dirname, "..", "assets", "icon.png")).href;
  } catch (err) {
    console.warn("Clawd: failed to resolve tutorial icon:", err && err.message);
    _tutorialHeroSrcCache = "";
  }
  return _tutorialHeroSrcCache;
}

let _tutorialDoneHeroSvgCache = null;
function getTutorialDoneHeroSvg() {
  if (_tutorialDoneHeroSvgCache != null) return _tutorialDoneHeroSvgCache;
  try {
    _tutorialDoneHeroSvgCache = fs.readFileSync(
      path.join(__dirname, "..", "assets", "svg", "clawd-about-hero.svg"),
      "utf8"
    );
  } catch (err) {
    console.warn("Clawd: failed to read tutorial done hero:", err && err.message);
    _tutorialDoneHeroSvgCache = "";
  }
  return _tutorialDoneHeroSvgCache;
}

const _tutorial = require("./tutorial")({
  t: (key) => translate(key),
  getI18n: () => getDashboardI18nPayload().translations,
  getLang: () => lang,
  getLangs: () => SUPPORTED_LANGS.slice(),
  // Let the user override the (system-seeded) language right from the wizard.
  // Persists as their chosen language; the set-lang IPC re-pushes state so the
  // whole wizard re-localizes immediately.
  setLang: (value) => {
    if (typeof value === "string" && SUPPORTED_LANGS.includes(value)) {
      _settingsController.applyUpdate("lang", value);
    }
  },
  getHeroSrc: () => getTutorialHeroSrc(),
  getDoneHeroSvg: () => getTutorialDoneHeroSvg(),
  iconPath: settingsWindowRuntime.getIconPath(),
  getAgentOnboardingState: () => buildTutorialAgentOnboardingState(),
  // install/uninstall route through the controller's command API so the commit
  // (integrationInstalled flag, hint cleanup, monitor start/stop) persists and
  // validates exactly as the Settings → Agents path does.
  installAgent: (agentId) => _settingsController.applyCommand("installAgentIntegration", { agentId }),
  uninstallAgent: (agentId) => _settingsController.applyCommand("uninstallAgentIntegration", { agentId }),
  registerShortcut: (payload) => _settingsController.applyCommand("registerShortcut", payload),
  resetShortcut: (payload) => _settingsController.applyCommand("resetShortcut", payload),
  // v1: deep-link to a specific tab is deferred — open Settings to its default tab.
  openSettingsTab: () => settingsWindowRuntime.open(),
  markTutorialSeen: () => {
    _settingsController.applyUpdate("tutorialSeen", true);
  },
  getShortcutsSummary: () => buildTutorialShortcutsSummary(),
  getTextScale: () => effectiveTextScaleForKey(
    getWindowDisplayKey(_tutorial ? _tutorial.getWindow() : null) || getPetDisplayKey()
  ),
});

const _sessionHud = require("./session-hud")({
  get win() { return win; },
  get petHidden() { return petWindowRuntime.isPetHidden(); },
  get sessionHudEnabled() { return sessionHudEnabled; },
  get sessionHudShowStateLabels() { return sessionHudShowStateLabels; },
  get sessionHudShowElapsed() { return sessionHudShowElapsed; },
  get sessionHudShowContextUsage() { return sessionHudShowContextUsage; },
  get sessionHudPinned() { return sessionHudPinned; },
  get lowPowerIdleMode() { return lowPowerIdleMode; },
  getMiniMode: () => _mini.getMiniMode(),
  getMiniTransitioning: () => _mini.getMiniTransitioning(),
  getSessionSnapshot: () => _state.buildSessionSnapshot(),
  getI18n: () => getDashboardI18nPayload(),
  getPetWindowBounds,
  getHitRectScreen,
  getSessionHudAnchorRect,
  getNearestWorkArea,
  getTextScale: () => getTextScaleForPetWindows(),
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

agentRuntime = createAgentRuntimeMain({
  getServer: () => _server,
  getStateRuntime: () => _state,
  getPermissionRuntime: () => _perm,
  isAgentEnabled: (agentId) => _isAgentEnabled(_settingsController.getSnapshot(), agentId),
  updateSession: (sessionId, state, event, opts) => updateSession(sessionId, state, event, opts),
  captureGhosttyTerminalId,
  showCodexNotifyBubble: (payload) => showCodexNotifyBubble(payload),
  clearCodexNotifyBubbles: (...args) => clearCodexNotifyBubbles(...args),
});

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
  shouldSyncAgentIntegration: (agentId) =>
    _shouldSyncAgentIntegration({ agents: _settingsController.get("agents") }, agentId),
  isAgentPermissionsEnabled: (agentId) => _isAgentPermissionsEnabled({ agents: _settingsController.get("agents") }, agentId),
  isAgentSubagentPermissionsEnabled: (agentId) => _isAgentSubagentPermissionsEnabled({ agents: _settingsController.get("agents") }, agentId),
  isCodexNativeNotificationSoundEnabled: () => _isCodexNativeNotificationSoundEnabled({ agents: _settingsController.get("agents") }),
  isCodexPermissionInterceptEnabled: () => _isCodexPermissionInterceptEnabled({ agents: _settingsController.get("agents") }),
  codexSubagentClassifier: agentRuntime.getCodexSubagentClassifier(),
  setState,
  updateSession: agentRuntime.updateSessionFromServer,
  resolvePermissionEntry,
  sendPermissionResponse,
  addPendingPermission,
  removePendingPermission,
  showPermissionBubble,
  maybeStartRemoteApproval,
  replyOpencodePermission,
  permLog,
};
const _server = require("./server")(_serverCtx);
const { startHttpServer, getHookServerPort } = _server;

// ── LAN WebSocket bridge for PWA mobile clients (lazy-loaded) ──
let _lanWss = null;
if (_settingsController.get("mobilePreviewEnabled") === true) {
  const { initMobilePreviewServer } = require("./network/mobile-preview-server");
  _lanWss = initMobilePreviewServer({
    sessions,
    getSettingsSnapshot: () => _settingsController.getSnapshot(),
    isEnabled: () => _settingsController.get("mobilePreviewEnabled") === true,
  });
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

ipcMain.on("sound-playback-error", (_event, payload) => {
  const phase = payload && typeof payload.phase === "string"
    ? payload.phase.replace(/[^a-z0-9_-]/gi, "").slice(0, 32)
    : "unknown";
  const message = payload && typeof payload.message === "string"
    ? payload.message.replace(/\s+/g, " ").slice(0, 240)
    : "unknown";
  sessionLog(`sound playback error phase=${phase || "unknown"} message=${message || "unknown"}`);
});

function focusLog(msg) {
  if (!focusDebugLog) return;
  const { rotatedAppend } = require("./log-rotate");
  rotatedAppend(focusDebugLog, `[${new Date().toISOString()}] ${msg}\n`);
}

function getTelegramApprovalClient() {
  const controller = _telegramMigrationController;
  if (controller && typeof controller.getSnapshot === "function") {
    const snap = controller.getSnapshot() || {};
    if (isNativeTelegramApprovalSelected(snap)) {
      if (snap.state === "NATIVE_ACTIVE"
        && telegramNativeRunner
        && typeof telegramNativeRunner.isPolling === "function"
        && telegramNativeRunner.isPolling()
        && typeof telegramNativeRunner.requestApproval === "function") {
        return telegramNativeRunner;
      }
      return null;
    }
  }
  if (!telegramApprovalSidecar || typeof telegramApprovalSidecar.getClient !== "function") return null;
  return telegramApprovalSidecar.getClient();
}

// R1a companion notifications are native-only: the legacy sidecar has no
// sendNotification surface, so legacy users silently lack completion pings
// (Settings copy must say so — tracked for a follow-up UI pass). Unlike
// getTelegramApprovalClient this never falls back to the sidecar.
function getTelegramCompanionClient() {
  const controller = _telegramMigrationController;
  if (controller && typeof controller.getSnapshot === "function") {
    const snap = controller.getSnapshot() || {};
    if (snap.state === "NATIVE_ACTIVE"
      && telegramNativeRunner
      && typeof telegramNativeRunner.sendNotification === "function") {
      return telegramNativeRunner;
    }
  }
  return null;
}

function telegramApprovalLog(level, message, meta = {}) {
  const parts = [`telegram approval ${level}: ${message}`];
  if (meta && meta.text) parts.push(String(meta.text).trim());
  if (meta && meta.error) parts.push(String(meta.error).trim());
  for (const key of ["errorClass", "errorCode", "delayMs", "id", "sessionId", "messageId", "status", "reason", "fallbackReason"]) {
    const value = meta && meta[key];
    if (value !== undefined && value !== null && value !== "") {
      parts.push(`${key}=${String(value).trim()}`);
    }
  }
  permLog(parts.filter(Boolean).join(" | "));
}

function getTelegramApprovalPrefs() {
  return telegramApprovalSettings.normalizeTelegramApproval(_settingsController.get("tgApproval"));
}

function getTelegramMigrationPrefs() {
  const raw = _settingsController.get("tgMigration");
  return raw && typeof raw === "object" ? raw : {};
}

function readTelegramMigrationPrefsForController() {
  const raw = { ...getTelegramMigrationPrefs() };
  if (typeof raw.legacyEnabled !== "boolean") {
    raw.legacyEnabled = getTelegramApprovalPrefs().enabled === true;
  }
  return raw;
}

function hasCompleteTelegramApprovalConfig(config, tokenInfo) {
  return !!(
    tokenInfo && tokenInfo.tokenStored === true
    && config && config.allowedTgUserId
    && config.targetSessionKey
  );
}

function isTelegramLegacySidecarSyncAllowed() {
  const migration = getTelegramMigrationPrefs();
  if (migration.transport === "native" || migration.transport === "off") return false;
  const controller = _telegramMigrationController;
  if (controller && typeof controller.getSnapshot === "function") {
    const snap = controller.getSnapshot() || {};
    if (snap.state === "NATIVE_ACTIVE" || snap.state === "TESTING_NATIVE") return false;
    if (snap.transport === "native" || snap.transport === "off") return false;
  }
  return true;
}

async function applySettingsUpdateOrThrow(key, value, label) {
  const result = await Promise.resolve(_settingsController.applyUpdate(key, value));
  if (!result || result.status !== "ok") {
    throw new Error((result && result.message) || `${label || key} update failed`);
  }
  return result;
}

async function setTelegramApprovalEnabledForMigration(enabled) {
  const current = getTelegramApprovalPrefs();
  if (current.enabled === enabled) return;
  suppressTelegramApprovalSidecarSync += 1;
  try {
    await applySettingsUpdateOrThrow("tgApproval", { ...current, enabled }, "tgApproval");
  } finally {
    suppressTelegramApprovalSidecarSync = Math.max(0, suppressTelegramApprovalSidecarSync - 1);
  }
}

async function persistTelegramMigrationPatch(patch) {
  const cur = getTelegramMigrationPrefs();
  await applySettingsUpdateOrThrow("tgMigration", { ...cur, ...patch }, "tgMigration");
  if (patch && patch.transport === "legacy") {
    await setTelegramApprovalEnabledForMigration(true);
  } else if (patch && (patch.transport === "native" || patch.transport === "off")) {
    await setTelegramApprovalEnabledForMigration(false);
  }
}

// Canonical paths only — no env-var override. The Settings "Save token" button,
// the sidecar's bridge TOML, and tokenStatus all share this single location so
// a malicious or accidental CLAWD_TG_BOT_TOKEN_FILE / CLAWD_BRIDGE_CONFIG can't
// redirect the writer to an attacker-controlled path or split the writer/reader
// view of where the token lives.
function getTelegramApprovalPaths() {
  const userDataDir = app.getPath("userData");
  return {
    userDataDir,
    configPath: telegramApprovalSettings.defaultBridgeConfigPath(userDataDir),
    tokenEnvFilePath: telegramApprovalSettings.defaultTokenEnvFilePath(userDataDir),
  };
}

function getTelegramApprovalTokenStatus() {
  const paths = getTelegramApprovalPaths();
  return telegramApprovalSettings.tokenStatus({
    fs,
    filePath: paths.tokenEnvFilePath,
  });
}

function getTelegramApprovalTokenInfo() {
  const paths = getTelegramApprovalPaths();
  const status = telegramApprovalSettings.tokenStatus({
    fs,
    filePath: paths.tokenEnvFilePath,
  });
  if (!status.tokenStored) return { configured: false, masked: "" };
  return {
    configured: true,
    masked: telegramApprovalSettings.readMaskedBotToken({
      fs,
      filePath: paths.tokenEnvFilePath,
    }),
  };
}

function buildTelegramApprovalSignature(config, paths, tokenStatus) {
  return JSON.stringify({
    enabled: config.enabled === true,
    allowedTgUserId: config.allowedTgUserId,
    targetSessionKey: config.targetSessionKey,
    configPath: paths.configPath,
    tokenEnvFilePath: paths.tokenEnvFilePath,
    tokenStored: tokenStatus.tokenStored === true,
    tokenFileMtimeMs: tokenStatus.tokenFileMtimeMs || 0,
    tokenRevision: telegramApprovalTokenRevision,
  });
}

function getTelegramApprovalStatus() {
  const config = getTelegramApprovalPrefs();
  const token = getTelegramApprovalTokenStatus();
  const sidecarStatus = telegramApprovalSidecar && typeof telegramApprovalSidecar.getStatus === "function"
    ? telegramApprovalSidecar.getStatus()
    : { status: "stopped" };
  const migrationSnapshot = _telegramMigrationController && typeof _telegramMigrationController.getSnapshot === "function"
    ? _telegramMigrationController.getSnapshot()
    : null;
  const nativePolling = telegramNativeRunner
    && typeof telegramNativeRunner.isPolling === "function"
    && telegramNativeRunner.isPolling();
  return buildTelegramApprovalStatus({
    config,
    token,
    sidecarStatus,
    migrationSnapshot,
    nativePolling,
  });
}

function getPendingTelegramApprovalCount() {
  return pendingPermissions.filter((entry) =>
    entry
    && !entry.isCodexNotify
    && !entry.isKimiNotify
    && !entry.isHardwareBuddyTest
  ).length;
}

function getTelegramNativeRunnerStatus() {
  if (telegramNativeRunner && typeof telegramNativeRunner.getStatus === "function") {
    try { return telegramNativeRunner.getStatus(); } catch {}
  }
  return {
    polling: !!(telegramNativeRunner
      && typeof telegramNativeRunner.isPolling === "function"
      && telegramNativeRunner.isPolling()),
    pendingApprovalCount: telegramNativeRunner && telegramNativeRunner._pendingApprovals
      ? telegramNativeRunner._pendingApprovals.size
      : 0,
    lastError: null,
  };
}

function buildTelegramStatusCommandText(options = {}) {
  const config = getTelegramApprovalPrefs();
  const token = getTelegramApprovalTokenStatus();
  const sidecarStatus = telegramApprovalSidecar && typeof telegramApprovalSidecar.getStatus === "function"
    ? telegramApprovalSidecar.getStatus()
    : { status: "stopped" };
  const migrationSnapshot = _telegramMigrationController && typeof _telegramMigrationController.getSnapshot === "function"
    ? _telegramMigrationController.getSnapshot()
    : null;
  const nativeRunnerStatus = getTelegramNativeRunnerStatus();
  const nativePolling = nativeRunnerStatus && nativeRunnerStatus.polling === true;
  const approvalStatus = buildTelegramApprovalStatus({
    config,
    token,
    sidecarStatus,
    migrationSnapshot,
    nativePolling,
  });
  const sessionSnapshot = _state && typeof _state.buildSessionSnapshot === "function"
    ? _state.buildSessionSnapshot()
    : null;
  const diagnostic = buildTelegramStatusDiagnostic({
    config,
    token,
    approvalStatus,
    migrationSnapshot,
    nativeRunnerStatus,
    nativePolling,
    pendingApprovalCount: getPendingTelegramApprovalCount(),
    sessionSnapshot,
    now: Date.now(),
    all: options && options.all === true,
  });
  return formatTelegramStatusDiagnostic(diagnostic, {
    all: options && options.all === true,
    lang: _settingsController.get("lang") || lang || "en",
  });
}

function handleTelegramNativeCommand({ command, args } = {}) {
  if (command !== "status") return null;
  return buildTelegramStatusCommandText({ all: true });
}

function writeTelegramApprovalToken(token) {
  const paths = getTelegramApprovalPaths();
  const result = telegramApprovalSettings.writeTokenEnvFile({
    fs,
    path,
    filePath: paths.tokenEnvFilePath,
    token,
    platform: process.platform,
  });
  if (result && result.status === "ok") {
    telegramApprovalTokenRevision += 1;
    queueTelegramApprovalSidecarSync("token");
  }
  return result;
}

function isTelegramTokenFileRequiredByNative() {
  const migration = getTelegramMigrationPrefs();
  if (migration.transport === "native") return true;
  const controller = _telegramMigrationController;
  if (!controller || typeof controller.getSnapshot !== "function") return false;
  const snap = controller.getSnapshot() || {};
  const owner = snap.ownerSnapshot || {};
  return snap.state === "NATIVE_ACTIVE"
    || snap.state === "TESTING_NATIVE"
    || owner.nativePolling === true;
}

async function deleteTelegramApprovalTokenFile() {
  if (isTelegramTokenFileRequiredByNative()) {
    return {
      status: "error",
      code: "TOKEN_FILE_IN_USE",
      message: "Native Telegram currently uses the shared token file. Keep it until native token storage is split.",
    };
  }
  const paths = getTelegramApprovalPaths();
  if (telegramApprovalSidecar) {
    await stopTelegramApprovalSidecar();
  }
  try {
    fs.unlinkSync(paths.tokenEnvFilePath);
    telegramApprovalTokenRevision += 1;
    queueTelegramApprovalSidecarSync("token-delete");
    return { status: "ok", deleted: true };
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { status: "ok", deleted: false, noop: true };
    }
    return {
      status: "error",
      code: err && err.code ? err.code : "DELETE_FAILED",
      message: `Telegram token file delete failed: ${err && err.message ? err.message : err}`,
    };
  }
}

// Bridge a freshly-created legacy sidecar's status-changed stream into the
// migration controller. A new bridge per instance keeps everReady/dedupe state
// scoped to that process; the controller is referenced lazily because it may be
// created after the first sidecar (init drives the first start).
function attachTelegramSidecarStatusBridge(sidecar) {
  if (!sidecar || typeof sidecar.on !== "function") return;
  const bridge = createTelegramSidecarStatusBridge({
    getSnapshot: () => (_telegramMigrationController
      && typeof _telegramMigrationController.getSnapshot === "function"
      ? _telegramMigrationController.getSnapshot()
      : null),
    dispatch: (event) => (_telegramMigrationController
      && typeof _telegramMigrationController.dispatch === "function"
      ? _telegramMigrationController.dispatch(event)
      : Promise.resolve()),
    log: telegramApprovalLog,
  });
  sidecar.on("status-changed", (status) => bridge.onStatusChanged(status));
}

async function startTelegramApprovalSidecar() {
  const config = getTelegramApprovalPrefs();
  const paths = getTelegramApprovalPaths();
  const token = getTelegramApprovalTokenStatus();
  const ready = telegramApprovalSettings.readiness(config, token);
  if (!ready.ready) {
    if (ready.reason !== "disabled") {
      telegramApprovalLog("info", ready.reason || "not configured", {
        error: ready.message || "",
      });
    }
    return false;
  }
  const configWrite = telegramApprovalSettings.writeBridgeConfigFile({
    fs,
    path,
    filePath: paths.configPath,
    config,
  });
  if (!configWrite || configWrite.status !== "ok") {
    telegramApprovalLog("warn", "config write failed", {
      error: configWrite && configWrite.message,
    });
    return false;
  }
  const signature = buildTelegramApprovalSignature(config, paths, token);
  if (telegramApprovalSidecar && telegramApprovalConfigSignature === signature) {
    const sidecar = telegramApprovalSidecar;
    if (typeof sidecar.isRunning !== "function" || !sidecar.isRunning()) {
      try {
        await sidecar.start();
        if (telegramApprovalSidecar === sidecar) telegramApprovalLog("info", "running");
      } catch (err) {
        telegramApprovalLog("warn", "start failed", {
          error: err && err.message ? err.message : String(err),
        });
        return false;
      }
    }
    return telegramApprovalSidecar === sidecar;
  }
  if (telegramApprovalSidecar) await stopTelegramApprovalSidecar();
  // The bot token only ever lives at userData/telegram-approval.env on disk.
  // The sidecar reads it from there directly — Clawd's main process must never
  // pipe a token value through process.env or child env, so there is no
  // botToken option here and no CLAWD_TG_BOT_TOKEN read from process.env.
  telegramApprovalSidecar = createTelegramApprovalSidecar({
    baseEnv: process.env,
    env: process.env,
    userDataDir: paths.userDataDir,
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    configPath: paths.configPath,
    tokenEnvFilePath: paths.tokenEnvFilePath,
    redactionSecrets: telegramApprovalSettings.redactionSecretsForTelegramApproval(config),
    log: telegramApprovalLog,
  });
  attachTelegramSidecarStatusBridge(telegramApprovalSidecar);
  telegramApprovalConfigSignature = signature;
  const sidecar = telegramApprovalSidecar;
  try {
    await sidecar.start();
    if (telegramApprovalSidecar === sidecar) {
      telegramApprovalLog("info", "running");
      return true;
    }
  } catch (err) {
    telegramApprovalLog("warn", "start failed", {
      error: err && err.message ? err.message : String(err),
    });
  }
  return false;
}

async function initTelegramMigrationController() {
  if (_telegramMigrationController) return _telegramMigrationController;
  const paths = getTelegramApprovalPaths();

  // Sidecar handle: forwards to the existing async start/stop functions so
  // there is exactly one sidecar lifecycle in the process.
  const sidecarHandle = {
    isRunning: () => !!(telegramApprovalSidecar && telegramApprovalSidecar.isRunning && telegramApprovalSidecar.isRunning()),
    start: async () => {
      await setTelegramApprovalEnabledForMigration(true);
      const started = await startTelegramApprovalSidecar();
      if (!started) {
        const err = new Error("Telegram approval sidecar did not start");
        err.code = "SIDECAR_START_FAILED";
        throw err;
      }
      return true;
    },
    stop: () => stopTelegramApprovalSidecar(),
  };

  // Native handle: spike-level real implementation. Token comes from the same
  // env file the sidecar uses; production transport closes over the token.
  const { envFileTokenStore } = require("./telegram-token-store");
  const {
    createClipboardFallbackDeliveryAdapter,
    createTelegramDirectSend,
    createWindowsPasteOnlyDeliveryAdapter,
  } = require("./telegram-direct-send");
  const { createTelegramNativeRunner } = require("./telegram-native-runner");
  const { createTelegramFetchTransport } = require("./telegram-fetch-transport");
  const tokenStore = envFileTokenStore({ filePath: paths.tokenEnvFilePath });
  telegramDirectSend = createTelegramDirectSend({
    getSessionSnapshot: () => _state && typeof _state.buildSessionSnapshot === "function"
      ? _state.buildSessionSnapshot()
      : { sessions: [] },
    getPendingPermissions: () => pendingPermissions,
    focusSession: (sessionId, options) => focusDashboardSession(sessionId, options),
    deliveryAdapter: createWindowsPasteOnlyDeliveryAdapter({
      clipboard,
      restoreClipboardOnSuccess: true,
    }),
    fallbackAdapter: createClipboardFallbackDeliveryAdapter({ clipboard }),
    isEnabled: () => {
      const snap = _telegramMigrationController && typeof _telegramMigrationController.getSnapshot === "function"
        ? _telegramMigrationController.getSnapshot()
        : null;
      return !!(snap && snap.state === "NATIVE_ACTIVE"
        && getTelegramApprovalPrefs().r3DirectSendEnabled === true);
    },
    osPlatform: process.platform,
    log: telegramApprovalLog,
  });
  const nativeRunner = createTelegramNativeRunner({
    tokenStore,
    // issue #359: route the bot's HTTP through Electron's Chromium net stack so
    // it follows the OS system proxy (and PAC/SOCKS), instead of Node's global
    // fetch which ignores system/env proxy. Dedicated in-memory session.
    transport: createTelegramFetchTransport({
      tokenStore,
      sessionFactory: () => require("electron").session.fromPartition("clawd-telegram", { cache: false }),
      log: telegramApprovalLog,
    }),
    getDispatch: () => _telegramMigrationController && _telegramMigrationController.dispatch,
    getChatId: () => {
      const cfg = getTelegramApprovalPrefs();
      const key = cfg && cfg.targetSessionKey;
      // targetSessionKey is "telegram:<chat>:..." — extract chat id.
      const m = typeof key === "string" ? key.match(/^telegram:(-?\d+)/) : null;
      return m ? m[1] : "";
    },
    getAllowedUserId: () => {
      const cfg = getTelegramApprovalPrefs();
      return (cfg && cfg.allowedTgUserId) || "";
    },
    isCommandEnabled: () => {
      const snap = _telegramMigrationController && typeof _telegramMigrationController.getSnapshot === "function"
        ? _telegramMigrationController.getSnapshot()
        : null;
      return !!(snap && snap.state === "NATIVE_ACTIVE");
    },
    onCommand: (payload) => handleTelegramNativeCommand(payload),
    isTextMessageEnabled: () => {
      const snap = _telegramMigrationController && typeof _telegramMigrationController.getSnapshot === "function"
        ? _telegramMigrationController.getSnapshot()
        : null;
      return !!(snap && snap.state === "NATIVE_ACTIVE"
        && getTelegramApprovalPrefs().r3DirectSendEnabled === true);
    },
    onTextMessage: (payload) => telegramDirectSend && telegramDirectSend.handleTextMessage(payload),
    log: telegramApprovalLog,
  });
  telegramNativeRunner = nativeRunner;

  // R1a: completion notifications ride the existing snapshot fanout. The
  // companion holds its own dedupe state (the snapshot carries no prev) and
  // only sends while native is the active owner + the user left the toggle on.
  const { createTelegramCompanion } = require("./telegram-companion");
  telegramCompanion = createTelegramCompanion({
    getClient: () => getTelegramCompanionClient(),
    getLang: () => _settingsController.get("lang") || lang || "en",
    getCompletionOutputMode: () => getTelegramApprovalPrefs().completionOutputMode || "off",
    getNotifyOnComplete: () => getTelegramApprovalPrefs().notifyOnComplete === true,
    // Native-active client present. The companion still advances its dedupe map
    // while native is inactive, and internally decides whether to send a bare
    // ping or require assistant output based on tgApproval prefs.
    isEnabled: () => !!getTelegramCompanionClient(),
    onNotificationSent: ({ entry, messageId }) => {
      if (telegramDirectSend && typeof telegramDirectSend.registerCompletionNotification === "function") {
        telegramDirectSend.registerCompletionNotification({
          messageId,
          sessionId: entry && entry.id,
        });
      }
    },
    log: telegramApprovalLog,
  });

  _telegramMigrationController = createTelegramMigrationController({
    sidecar: sidecarHandle,
    native: nativeRunner,
    readPrefs: () => readTelegramMigrationPrefsForController(),
    writePrefs: (patch) => persistTelegramMigrationPatch(patch),
    readFiles: () => {
      const cfg = getTelegramApprovalPrefs();
      const tokenInfo = getTelegramApprovalTokenStatus();
      const hasTokenFile = !!(tokenInfo && tokenInfo.tokenStored);
      const configComplete = hasCompleteTelegramApprovalConfig(cfg, tokenInfo);
      return {
        hasLegacyEnvFile: hasTokenFile,
        legacyConfigComplete: configComplete,
        nativeConfigComplete: configComplete,
      };
    },
    log: telegramApprovalLog,
  });

  await _telegramMigrationController.init();
  return _telegramMigrationController;
}

function stopTelegramApprovalSidecar() {
  const sidecar = telegramApprovalSidecar;
  telegramApprovalSidecar = null;
  telegramApprovalConfigSignature = "";
  if (!sidecar || typeof sidecar.stop !== "function") return Promise.resolve();
  return sidecar.stop().catch((err) => telegramApprovalLog("warn", "stop failed", {
    error: err && err.message ? err.message : String(err),
  }));
}

async function syncTelegramApprovalSidecar(reason = "settings") {
  if (!isTelegramLegacySidecarSyncAllowed()) {
    if (telegramApprovalSidecar) await stopTelegramApprovalSidecar();
    telegramApprovalLog("debug", `sync ${reason} skipped by migration transport`);
    return false;
  }
  const config = getTelegramApprovalPrefs();
  const paths = getTelegramApprovalPaths();
  const token = getTelegramApprovalTokenStatus();
  const ready = telegramApprovalSettings.readiness(config, token);
  if (!ready.ready) {
    if (telegramApprovalSidecar) await stopTelegramApprovalSidecar();
    return false;
  }
  const nextSignature = buildTelegramApprovalSignature(config, paths, token);
  if (telegramApprovalSidecar && telegramApprovalConfigSignature !== nextSignature) {
    await stopTelegramApprovalSidecar();
  }
  const started = await startTelegramApprovalSidecar();
  if (started) telegramApprovalLog("debug", `sync ${reason}`);
  return started;
}

function queueTelegramApprovalSidecarSync(reason) {
  telegramApprovalSyncPromise = telegramApprovalSyncPromise
    .catch(() => {})
    .then(() => syncTelegramApprovalSidecar(reason));
  return telegramApprovalSyncPromise;
}

function telegramApprovalUnavailableMessage(status) {
  if (status && status.message) return status.message;
  if (status && status.reason === "disabled") return "Telegram approval is disabled";
  if (status && status.reason === "missing-token") return "Telegram bot token is not configured";
  if (status && status.reason === "invalid-config") return "Telegram approval config is incomplete";
  if (status && status.reason === "native-inactive") return "Native Telegram approval is not active";
  if (status && status.reason === "native-testing") return "Native Telegram approval test is already in progress";
  if (status && status.transport === "native") return "Native Telegram approval is not active";
  return "Telegram approval sidecar is not running";
}

async function sendTelegramApprovalTest() {
  const beforeStatus = getTelegramApprovalStatus();
  if (beforeStatus.configured !== true) {
    return { status: "error", message: telegramApprovalUnavailableMessage(beforeStatus) };
  }
  if (!(beforeStatus && beforeStatus.transport === "native")) {
    await queueTelegramApprovalSidecarSync("test");
  }
  const client = getTelegramApprovalClient();
  if (!client || typeof client.requestApproval !== "function") {
    return { status: "error", message: telegramApprovalUnavailableMessage(getTelegramApprovalStatus()) };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60 * 1000);
  try {
    const decision = await client.requestApproval({
      title: "Clawd Telegram approval test",
      detail: "This is a settings test message. It is not attached to any agent permission request.",
    }, { signal: controller.signal });
    if (decision === "allow" || decision === "deny") {
      return { status: "ok", decision };
    }
    if (decision && (decision.action === "allow" || decision.action === "deny")) {
      return { status: "ok", decision: decision.action };
    }
    return { status: "error", message: "Telegram test did not receive a button response" };
  } finally {
    clearTimeout(timer);
  }
}

function hardwareBuddyLog(msg) {
  const line = `[hardware-buddy] ${msg}`;
  if (sessionDebugLog) {
    sessionLog(line);
  } else {
    console.log(`Clawd: ${line}`);
  }
}

function summarizeHardwareBuddyStatus(status) {
  const lastError = status && status.lastError && typeof status.lastError === "object"
    ? status.lastError
    : null;
  return {
    enabled: !!(status && status.enabled),
    started: !!(status && status.started),
    sidecarRunning: !!(status && status.sidecarRunning),
    permissionsEnabled: !!(status && status.permissionsEnabled),
    connected: !!(status && status.connected),
    secure: !!(status && status.secure),
    error: lastError ? `${lastError.category || "unknown"}:${lastError.code || ""}` : "",
    retryAttempt: status && Number.isFinite(status.retryAttempt) ? status.retryAttempt : 0,
  };
}

function logHardwareBuddyStatus(status) {
  const summary = summarizeHardwareBuddyStatus(status);
  const key = JSON.stringify(summary);
  if (key === lastHardwareBuddyStatusLogKey) return;
  lastHardwareBuddyStatusLogKey = key;
  hardwareBuddyLog(
    `status enabled=${summary.enabled} started=${summary.started} sidecar=${summary.sidecarRunning}`
      + ` permissions=${summary.permissionsEnabled} connected=${summary.connected} secure=${summary.secure}`
      + ` retry=${summary.retryAttempt}${summary.error ? ` error=${summary.error}` : ""}`
  );
}

function broadcastHardwareBuddyStatus(status) {
  hardwareBuddyStatus = status || null;
  logHardwareBuddyStatus(hardwareBuddyStatus);
  try {
    for (const bw of BrowserWindow.getAllWindows()) {
      if (!bw.isDestroyed() && bw.webContents && !bw.webContents.isDestroyed()) {
        bw.webContents.send("hardwareBuddy:status-changed", hardwareBuddyStatus);
      }
    }
  } catch (err) {
    console.warn("Clawd: Hardware Buddy status broadcast failed:", err && err.message);
  }
}

function createHardwareBuddyTestResponse(onFinish) {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.destroyed = false;
  res.headersSent = false;
  res.statusCode = null;
  res.body = "";
  res.writeHead = (statusCode, headers) => {
    res.statusCode = statusCode;
    res.headers = headers || {};
    res.headersSent = true;
    return res;
  };
  res.end = (body = "") => {
    if (res.writableEnded || res.destroyed) return res;
    res.writableEnded = true;
    res.body = typeof body === "string" ? body : String(body || "");
    if (typeof onFinish === "function") onFinish(null, res);
    res.emit("close");
    return res;
  };
  res.destroy = (err) => {
    if (res.writableEnded || res.destroyed) return res;
    res.destroyed = true;
    if (typeof onFinish === "function") onFinish(err || new Error("response destroyed"), res);
    res.emit("close");
    return res;
  };
  return res;
}

function parseHardwareBuddyTestDecision(res) {
  if (!res || !res.body) return null;
  try {
    const parsed = JSON.parse(res.body);
    const decision = parsed
      && parsed.hookSpecificOutput
      && parsed.hookSpecificOutput.decision;
    const behavior = decision && decision.behavior;
    return behavior === "allow" || behavior === "deny" ? behavior : null;
  } catch {
    return null;
  }
}

function hardwareBuddyTestError(code, message) {
  return { status: "error", code, message };
}

function sendHardwareBuddyTestApproval() {
  if (hardwareBuddyTestApprovalPromise) return hardwareBuddyTestApprovalPromise;

  const status = hardwareBuddyAdapter && typeof hardwareBuddyAdapter.getStatus === "function"
    ? hardwareBuddyAdapter.getStatus()
    : hardwareBuddyStatus;
  if (!status || status.enabled !== true || status.started !== true) {
    return Promise.resolve(hardwareBuddyTestError("disabled", "Hardware Buddy is not enabled."));
  }
  if (status.permissionsEnabled !== true) {
    return Promise.resolve(hardwareBuddyTestError("permissions_off", "Hardware permission replies are disabled."));
  }
  if (status.connected !== true || status.secure !== true) {
    return Promise.resolve(hardwareBuddyTestError("not_secure", "Hardware Buddy is not connected over a secure link."));
  }

  const createdAt = Date.now();
  const sessionId = `hardware-buddy-test-${createdAt}`;
  const toolUseId = `hardware-buddy-test-tool-${createdAt}`;
  const timeoutMs = 60000;

  const promise = new Promise((resolve) => {
    let settled = false;
    let permEntry = null;
    let timeout = null;
    let noDecisionCode = null;

    const cleanupSession = () => {
      try {
        _state.updateSession(sessionId, "idle", "SessionEnd", { agentId: "codex" });
      } catch (err) {
        hardwareBuddyLog(`test cleanup failed: ${err && err.message ? err.message : err}`);
      }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      cleanupSession();
      resolve(result);
    };

    const res = createHardwareBuddyTestResponse((err, response) => {
      if (settled) return;
      if (err) {
        finish(hardwareBuddyTestError("internal_error", err.message || String(err)));
        return;
      }
      const decision = parseHardwareBuddyTestDecision(response);
      if (decision === "allow" || decision === "deny") {
        finish({ status: "ok", decision });
        return;
      }
      finish(hardwareBuddyTestError(
        noDecisionCode || "no_decision",
        noDecisionCode === "timeout"
          ? "Hardware Buddy test timed out."
          : "Hardware Buddy test did not receive a decision."
      ));
    });

    permEntry = {
      res,
      abortHandler: null,
      suggestions: [],
      sessionId,
      bubble: null,
      hideTimer: null,
      toolName: "Bash",
      toolInput: {
        command: "echo hardware-buddy-smoke",
        description: "Hardware Buddy smoke test: echo hardware-buddy-smoke",
      },
      toolUseId,
      toolInputFingerprint: `hardware-buddy-test:${createdAt}`,
      resolvedSuggestion: null,
      createdAt,
      agentId: "codex",
      isCodex: true,
      isHardwareBuddyTest: true,
      cwd: __dirname,
      codexOriginator: "clawd-settings",
      codexSource: "hardware-buddy-test",
    };

    try {
      _state.updateSession(sessionId, "idle", "SessionStart", {
        agentId: "codex",
        cwd: __dirname,
        sessionTitle: "Hardware Buddy test",
      });
      addPendingPermission(permEntry, "hardware-buddy-test");
    } catch (err) {
      removePendingPermission(permEntry, "hardware-buddy-test-failed");
      finish(hardwareBuddyTestError("internal_error", err && err.message ? err.message : String(err)));
      return;
    }

    timeout = setTimeout(() => {
      if (settled) return;
      hardwareBuddyLog("test approval timed out");
      noDecisionCode = "timeout";
      resolvePermissionEntry(permEntry, "no-decision", "Hardware Buddy test timed out");
    }, timeoutMs);
  });
  hardwareBuddyTestApprovalPromise = promise.finally(() => {
    hardwareBuddyTestApprovalPromise = null;
  });
  return hardwareBuddyTestApprovalPromise;
}

hardwareBuddyAdapter = createHardwareBuddyAdapter({
  env: process.env,
  getSettings: () => _settingsController.get("hardwareBuddy"),
  getSessionSnapshot: () => _state.buildSessionSnapshot(),
  getPendingPermissions: () => pendingPermissions,
  getDoNotDisturb: () => doNotDisturb,
  isAgentEnabled: (agentId) => _isAgentEnabled({ agents: _settingsController.get("agents") }, agentId),
  isAgentPermissionsEnabled: (agentId) =>
    _isAgentPermissionsEnabled({ agents: _settingsController.get("agents") }, agentId),
  resolvePermissionEntry: (...args) => resolvePermissionEntry(...args),
  statePriority: _state.STATE_PRIORITY,
  log: hardwareBuddyLog,
  onStatusChanged: broadcastHardwareBuddyStatus,
});

unsubscribeHardwareBuddySettings = _settingsController.subscribeKey("hardwareBuddy", () => {
  if (!hardwareBuddyAdapter || typeof hardwareBuddyAdapter.applySettingsChange !== "function") return;
  try {
    hardwareBuddyAdapter.applySettingsChange();
  } catch (err) {
    console.warn("Clawd: failed to apply Hardware Buddy settings:", err && err.message);
    hardwareBuddyLog(`settings apply failed: ${err && err.message ? err.message : err}`);
  }
});

// ── Menu — delegated to src/menu.js ──
//
// Setters that previously assigned to module-level vars now route through
// `_settingsController.applyUpdate(key, value)`. The mirror cache is updated
// by the settings-effect-router subscriber after this ctx is built. Side
// effects that used to live inside setters (e.g.
// `syncPermissionShortcuts()` for hideBubbles) are now reactive and live in
// the subscriber too.

async function confirmDangerousMode(t) {
  const parent = win && !win.isDestroyed() ? win : null;
  const result = await electronDialog.showMessageBox(parent, {
    type: "warning",
    buttons: [t("confirm") || "Confirm", t("cancel") || "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: t("dangerousConfirmTitle") || "Confirm Dangerous Mode",
    message: t("dangerousConfirmMessage") || "Dangerous mode skips ALL permission checks.",
  });
  return result.response === 0;
}

// Await launchClaudeSession and surface failures instead of swallowing them:
// show a localized error dialog so the user knows nothing happened, and log
// for diagnosis. Never throws.
async function runLaunchClaudeSession(t, mode, cwd, sessionId) {
  let res;
  try {
    res = await launchClaudeSession(mode, cwd, sessionId);
  } catch (err) {
    console.error("[launch-claude] launch threw:", err);
    res = { ok: false, message: (err && err.message) || String(err) };
  }
  if (res && res.ok) return res;
  console.error("[launch-claude] launch failed:", res && res.message);
  try {
    const parent = win && !win.isDestroyed() ? win : null;
    await electronDialog.showMessageBox(parent, {
      type: "error",
      buttons: [t("dismiss") || "OK"],
      title: t("newSession") || "New Session",
      message: t("launchFailed") || "Failed to launch Claude Code.",
      detail: (res && res.message) || "",
    });
  } catch (err) {
    console.error("[launch-claude] failed to show error dialog:", err);
  }
  return res;
}

function showResumeInput(t) {
  return new Promise((resolve) => {
    // data: URL — outside the file:// zoom map, so the scale is baked into the
    // window size and an inline body zoom instead.
    const resumeScale = getTextScaleForPetWindows();
    const inputWin = new BrowserWindow({
      width: scaleWidth(420, resumeScale),
      height: scaleHeight(180, resumeScale),
      resizable: false,
      alwaysOnTop: true,
      frame: false,
      transparent: true,
      skipTaskbar: true,
      parent: win && !win.isDestroyed() ? win : undefined,
      modal: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    const title = t("resumeSessionTitle") || "Resume Session";
    const hint = t("resumeSessionHint") || "Enter Session ID";
    const confirmLabel = t("confirm") || "OK";
    const cancelLabel = t("dismiss") || "Cancel";
    const html = `<!DOCTYPE html><html><head><style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{zoom:${resumeScale};font-family:system-ui,-apple-system,sans-serif;background:#1e1e2e;color:#cdd6f4;display:flex;flex-direction:column;height:calc(100vh / ${resumeScale});padding:16px;border-radius:12px;overflow:hidden}
      .title{font-size:14px;font-weight:600;margin-bottom:12px}
      input{width:100%;padding:8px 12px;border:1px solid #45475a;border-radius:6px;background:#313244;color:#cdd6f4;font-size:13px;outline:none}
      input:focus{border-color:#89b4fa}
      input::placeholder{color:#6c7086}
      .btns{display:flex;gap:8px;margin-top:14px;justify-content:flex-end}
      button{padding:6px 16px;border:none;border-radius:6px;font-size:12px;cursor:pointer}
      .ok{background:#89b4fa;color:#1e1e2e;font-weight:600}
      .cancel{background:#45475a;color:#cdd6f4}
    </style></head><body>
      <div class="title">${title}</div>
      <input id="sid" type="text" placeholder="${hint}" autofocus />
      <div class="btns">
        <button class="cancel" onclick="result(null)">${cancelLabel}</button>
        <button class="ok" onclick="result(document.getElementById('sid').value)">${confirmLabel}</button>
      </div>
      <script>
        function result(v){window._resolve(v)}
        document.getElementById('sid').addEventListener('keydown',e=>{
          if(e.key==='Enter')result(document.getElementById('sid').value);
          if(e.key==='Escape')result(null);
        });
      </script>
    </body></html>`;
    inputWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    inputWin.webContents.on("did-finish-load", () => {
      inputWin.webContents.executeJavaScript(
        "new Promise(r=>{window._resolve=r})"
      ).then((val) => {
        const sessionId = typeof val === "string" ? val.trim() : "";
        resolve(sessionId || null);
        try { inputWin.close(); } catch {}
      });
    });
    inputWin.on("closed", () => resolve(null));
  });
}

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
  get autoApproveAllPermissions() { return _settingsController.get("autoApproveAllPermissions") === true; },
  // Route through the gated command. The menu shows its own native danger
  // confirm before setting true, so it passes confirmed:true; disabling needs
  // no confirmation. applyUpdate is intentionally NOT used — the field is
  // gated so the confirm dialog is a real boundary, not UI-only.
  set autoApproveAllPermissions(v) {
    _settingsController.applyCommand("setAutoApproveAll", { enabled: !!v, confirmed: true }).catch((err) => {
      console.warn("Clawd: setAutoApproveAll failed:", err && err.message);
    });
  },
  get soundMuted() { return soundMuted; },
  set soundMuted(v) { _settingsController.applyUpdate("soundMuted", v); },
  get soundVolume() { return soundVolume; },
  get pendingPermissions() { return pendingPermissions; },
  repositionBubbles: () => repositionFloatingBubbles(),
  get petHidden() { return petWindowRuntime.isPetHidden(); },
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
  enterMiniViaMenu: () => {
    if (!disableMiniModeCached) enterMiniViaMenu();
  },
  exitMiniMode: () => exitMiniMode(),
  getDisableMiniMode: () => disableMiniModeCached,
  getMiniMode: () => _mini.getMiniMode(),
  getMiniTransitioning: () => _mini.getMiniTransitioning(),
  miniHandleResize: (sizeKey) => _mini.handleResize(sizeKey),
  checkForUpdates: (...args) => checkForUpdates(...args),
  getUpdateMenuItem: () => getUpdateMenuItem(),
  openDashboard: () => showDashboard(),
  launchClaudeSession: (mode, cwd, sessionId) => launchClaudeSession(mode, cwd, sessionId),
  newSessionWithFolder: async (t) => {
    const parent = win && !win.isDestroyed() ? win : null;
    const result = await electronDialog.showOpenDialog(parent, {
      title: t("selectFolder"),
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths.length) return;
    const folder = result.filePaths[0];
    const mode = await electronDialog.showMessageBox(parent, {
      type: "question",
      buttons: [t("newSessionNormal"), t("newSessionDangerous"), t("newSessionContinue"), t("newSessionResume"), t("dismiss")],
      defaultId: 0,
      cancelId: 4,
      title: t("newSession"),
      message: t("newSession"),
      detail: folder,
    });
    if (mode.response === 4) return;
    if (mode.response === 3) {
      const sessionId = await showResumeInput(t);
      if (!sessionId) return;
      const resumeMode = await electronDialog.showMessageBox(parent, {
        type: "question",
        buttons: [t("modeNormal"), t("modeDangerous"), t("dismiss")],
        defaultId: 0,
        cancelId: 2,
        title: t("newSessionResume"),
        message: sessionId,
      });
      if (resumeMode.response === 2) return;
      if (resumeMode.response === 1 && !(await confirmDangerousMode(t))) return;
      await runLaunchClaudeSession(t, resumeMode.response === 1 ? "resume-dangerous" : "resume", folder, sessionId);
      return;
    }
    if (mode.response === 1 && !(await confirmDangerousMode(t))) return;
    const modes = ["normal", "dangerous", "continue"];
    await runLaunchClaudeSession(t, modes[mode.response], folder);
  },
  newSessionInCurrentDir: async (t) => {
    const parent = win && !win.isDestroyed() ? win : null;
    const mode = await electronDialog.showMessageBox(parent, {
      type: "question",
      buttons: [t("newSessionNormal"), t("newSessionDangerous"), t("newSessionContinue"), t("newSessionResume"), t("dismiss")],
      defaultId: 0,
      cancelId: 4,
      title: t("newSession"),
      message: t("newSession"),
    });
    if (mode.response === 4) return;
    if (mode.response === 3) {
      const sessionId = await showResumeInput(t);
      if (!sessionId) return;
      const resumeMode = await electronDialog.showMessageBox(parent, {
        type: "question",
        buttons: [t("modeNormal"), t("modeDangerous"), t("dismiss")],
        defaultId: 0,
        cancelId: 2,
        title: t("newSessionResume"),
        message: sessionId,
      });
      if (resumeMode.response === 2) return;
      if (resumeMode.response === 1 && !(await confirmDangerousMode(t))) return;
      await runLaunchClaudeSession(t, resumeMode.response === 1 ? "resume-dangerous" : "resume", undefined, sessionId);
      return;
    }
    if (mode.response === 1 && !(await confirmDangerousMode(t))) return;
    const modes = ["normal", "dangerous", "continue"];
    await runLaunchClaudeSession(t, modes[mode.response]);
  },
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
  getActiveThemeId: () => themeRuntime.getActiveThemeId("clawd"),
  getActiveThemeCapabilities: () => themeRuntime.getActiveThemeCapabilities(),
  ensureUserThemesDir: () => themeLoader.ensureUserThemesDir(),
  openSettingsWindow: () => settingsWindowRuntime.open(),
  showTutorial: () => _tutorial.open(),
};
const _menu = require("./menu")(_menuCtx);
const { t, buildContextMenu, buildTrayMenu, rebuildAllMenus, createTray,
        destroyTray, showPetContextMenu, ensureContextMenuOwner,
        requestAppQuit, applyDockVisibility } = _menu;

// ── Settings effect router ──
const SETTINGS_MIRROR_SETTERS = {
  lang: (v) => { lang = v; }, size: (v) => { currentSize = v; resetKeepSizeFrozen(); }, showTray: (v) => { showTray = v; },
  showDock: (v) => { showDock = v; if (macHideController) macHideController.noteManualChange(); }, manageClaudeHooksAutomatically: (v) => { manageClaudeHooksAutomatically = v; },
  autoStartWithClaude: (v) => { autoStartWithClaude = v; }, openAtLogin: (v) => { openAtLogin = v; },
  bubbleFollowPet: (v) => { bubbleFollowPet = v; }, sessionHudEnabled: (v) => { sessionHudEnabled = v; },
  sessionHudShowStateLabels: (v) => { sessionHudShowStateLabels = v; },
  sessionHudShowElapsed: (v) => { sessionHudShowElapsed = v; },
  sessionHudShowContextUsage: (v) => { sessionHudShowContextUsage = v; },
  sessionHudCleanupDetached: (v) => { sessionHudCleanupDetached = v; },
  sessionHudPinned: (v) => { sessionHudPinned = v; },
  sessionStaleMs: (v) => { sessionStaleMs = v; }, workingStaleMs: (v) => { workingStaleMs = v; },
  detachedIdleStaleMs: (v) => { detachedIdleStaleMs = v; },
  soundMuted: (v) => { soundMuted = v; }, soundVolume: (v) => { soundVolume = v; }, lowPowerIdleMode: (v) => { lowPowerIdleMode = v; },
  keepAwakeWhileWorking: (v) => { keepAwakeWhileWorking = v; },
  allowEdgePinning: (v) => { allowEdgePinningCached = v; }, disableMiniMode: (v) => { disableMiniModeCached = v; }, keepSizeAcrossDisplays: (v) => { keepSizeAcrossDisplaysCached = v; resetKeepSizeFrozen(); },
  freeRoam: (v) => { _roam.setEnabled(v); },
  textScale: (v) => { textScale = v; textScalePreview = null; },
  textScaleByDisplay: (v) => { textScaleByDisplay = v; textScalePreview = null; },
};

function updateSettingsMirrors(changes) { for (const [key, value] of Object.entries(changes)) if (SETTINGS_MIRROR_SETTERS[key]) SETTINGS_MIRROR_SETTERS[key](value); }

function callRuntimeMethod(owner, method, ...args) { return owner && typeof owner[method] === "function" ? owner[method](...args) : undefined; }

function reclampPetAfterEdgePinningChange() {
  if (!win || win.isDestroyed() || petWindowRuntime.isDragLocked() || _mini.getMiniMode() || _mini.getMiniTransitioning()) return;
  const clamped = computeFinalDragBounds(getPetWindowBounds(), getEffectiveCurrentPixelSize(), clampToScreenVisual);
  if (clamped) applyPetWindowBounds(clamped);
  syncHitWin(); repositionFloatingBubbles();
}

const settingsEffectRouter = createSettingsEffectRouter({
  settingsController: _settingsController,
  BrowserWindow,
  updateMirrors: updateSettingsMirrors,
  createTray,
  destroyTray,
  applyDockVisibility,
  sendToRenderer,
  sendDashboardI18n: () => sendDashboardI18n(),
  sendSessionHudI18n: () => sendSessionHudI18n(),
  emitSessionSnapshot: (options) => _state.emitSessionSnapshot(options),
  cleanStaleSessions: () => _state.cleanStaleSessions(),
  syncPermissionShortcuts,
  dismissInteractivePermissionBubbles: () => callRuntimeMethod(_perm, "dismissInteractivePermissionBubbles"),
  clearCodexNotifyBubbles,
  clearKimiNotifyBubbles,
  refreshPassiveNotifyAutoClose: () => callRuntimeMethod(_perm, "refreshPassiveNotifyAutoClose"),
  refreshPermissionAutoCloseForPolicy: () => callRuntimeMethod(_perm, "refreshPermissionAutoCloseForPolicy"),
  hideUpdateBubbleForPolicy: () => callRuntimeMethod(_updateBubble, "hideForPolicy"),
  refreshUpdateBubbleAutoClose: () => callRuntimeMethod(_updateBubble, "refreshAutoCloseForPolicy"),
  repositionFloatingBubbles,
  applyTextScale: () => applyTextScaleNow(),
  syncSessionHudVisibility: () => syncSessionHudVisibility(),
  handleSessionHudPinnedChanged: (next) => {
    if (_sessionHud && typeof _sessionHud.handlePinnedChanged === "function") {
      _sessionHud.handlePinnedChanged(next);
    }
  },
  reclampPetAfterEdgePinningChange,
  exitMiniMode: () => exitMiniMode(),
  getMiniMode: () => _mini.getMiniMode(),
  rebuildAllMenus,
  reconcilePowerSaveBlocker,
  logWarn: console.warn,
});
settingsEffectRouter.start();
_settingsController.subscribeKey("tgApproval", () => {
  if (suppressTelegramApprovalSidecarSync > 0) return;
  queueTelegramApprovalSidecarSync("settings");
});
_settingsController.subscribeKey("mobilePreviewEnabled", async (enabled) => {
  if (enabled) {
    if (!_lanWss) {
      const { initMobilePreviewServer } = require("./network/mobile-preview-server");
      _lanWss = initMobilePreviewServer({
        sessions,
        getSettingsSnapshot: () => _settingsController.getSnapshot(),
        isEnabled: () => _settingsController.get("mobilePreviewEnabled") === true,
      });
    }
    await _lanWss.start();
  } else if (_lanWss) {
    _lanWss.cleanup();
  }
});

animationOverridesMain = createSettingsAnimationOverridesMain({
  app,
  BrowserWindow,
  dialog,
  shell,
  fs,
  path,
  themeLoader,
  settingsController: _settingsController,
  getActiveTheme: () => getActiveTheme(),
  getSettingsWindow,
  getLang: () => lang,
  getThemeReloadInProgress: () => themeRuntime.isReloadInProgress(),
  getStateRuntime: () => _state,
  sendToRenderer,
});
registerSettingsAnimationOverridesIpc({
  ipcMain,
  animationOverridesMain,
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
  // #329 scheduler / pending-state prefs IO. Reads go straight to the
  // settingsController snapshot; writes go through applyUpdate so the
  // single-writer architecture (settings-controller.js) is honored.
  getUpdatePref: (key) => {
    try { return _settingsController.get(key); } catch { return undefined; }
  },
  setUpdatePref: (key, value) => {
    try { _settingsController.applyUpdate(key, value); } catch {}
  },
};
const _updater = require("./updater")(_updaterCtx);
const {
  setupAutoUpdater,
  checkForUpdates,
  getUpdateMenuItem,
  getUpdateMenuLabel,
  reconcilePendingOnStartup,
  onSilentModeExit: updaterOnSilentModeExit,
  startUpdateScheduler,
  stopUpdateScheduler,
} = _updater;
// Now that updater is constructed, point the forward hook at it.
notifyUpdaterSilentExit = () => { try { updaterOnSilentModeExit(); } catch {} };

// #329: react to the autoUpdateCheck toggle in real time so users see
// the scheduler start/stop without restarting Clawd.
try {
  _settingsController.subscribeKey("autoUpdateCheck", (value) => {
    try {
      if (value === false) stopUpdateScheduler();
      else startUpdateScheduler();
    } catch (err) {
      updateLog(`scheduler toggle failed: ${err && err.message}`);
    }
  });
} catch (err) {
  updateLog(`scheduler subscribeKey failed: ${err && err.message}`);
}

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

// ── Remote SSH (Phase 2) ──
//
// Runtime owner of background SSH tunnels. Profile CRUD goes through
// settings-controller (commands "remoteSsh.add" / .update / .delete);
// runtime state (Connect / Disconnect / Deploy / Authenticate / Open
// Terminal) goes through `remote-ssh-ipc.js`. Cleanup on app quit kills
// any spawned ssh / scp children.
const { createRemoteSshRuntime } = require("./remote-ssh-runtime");
const { registerRemoteSshIpc } = require("./remote-ssh-ipc");
const _remoteSshRuntime = createRemoteSshRuntime({
  getHookServerPort: () => getHookServerPort(),
  log: (...args) => console.warn("Clawd remote-ssh:", ...args),
});
const _remoteSshIpc = registerRemoteSshIpc({
  ipcMain,
  settingsController: _settingsController,
  remoteSshRuntime: _remoteSshRuntime,
  BrowserWindow,
  isPackaged: app.isPackaged,
});

// ── Settings panel window ──
//
// Single-instance, non-modal, system-titlebar BrowserWindow that hosts the
// settings UI. Reuses the settings IPC registration already wired up for the
// controller. The renderer subscribes to
// settings-changed broadcasts so menu changes and panel changes stay in sync.
const SIZE_PREVIEW_KEY_RE = /^P:\d+(?:\.\d+)?$/;

function isValidSizePreviewKey(value) {
  return typeof value === "string" && SIZE_PREVIEW_KEY_RE.test(value);
}

function beginSettingsSizePreviewProtection() {
  return petWindowRuntime.beginSettingsSizePreviewProtection();
}

function endSettingsSizePreviewProtection() {
  return petWindowRuntime.endSettingsSizePreviewProtection();
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

registerSettingsIpc({
  ipcMain,
  app,
  BrowserWindow,
  dialog,
  shell,
  fs,
  path,
  settingsController: _settingsController,
  themeLoader,
  codexPetMain,
  getSettingsWindow,
  getActiveTheme: () => getActiveTheme(),
  getLang: () => lang,
  settingsSizePreviewSession,
  isValidSizePreviewKey,
  previewTextScale,
  endTextScalePreview,
  getTextScaleContext: () => ({
    percent: Math.round(
      resolveTextScaleForKey(textScaleByDisplay, textScale, getSettingsDisplayKey()) * 100
    ),
  }),
  sendToRenderer,
  getDoNotDisturb: () => doNotDisturb,
  getSoundMuted: () => soundMuted,
  getSoundVolume: () => soundVolume,
  getAllAgents,
  getHardwareBuddyStatus: () => hardwareBuddyStatus || (hardwareBuddyAdapter && hardwareBuddyAdapter.getStatus
    ? hardwareBuddyAdapter.getStatus()
    : null),
  testHardwareBuddyApproval: () => sendHardwareBuddyTestApproval(),
  getQuickCommandPresets: () => hardwareBuddyAdapter && typeof hardwareBuddyAdapter.getQuickCommandPresets === "function"
    ? hardwareBuddyAdapter.getQuickCommandPresets()
    : { enabled: false, presets: [] },
  sendQuickCommand: (payload) => hardwareBuddyAdapter && typeof hardwareBuddyAdapter.createQuickCommand === "function"
    ? hardwareBuddyAdapter.createQuickCommand(payload)
    : { status: "error", code: "quick_commands_unavailable", message: "Quick Commands are unavailable" },
  checkForUpdates,
  showTutorial: () => {
    _tutorial.open();
    return { status: "ok" };
  },
  aboutHeroSvgPath: path.join(__dirname, "..", "assets", "svg", "clawd-about-hero.svg"),
  getLanWsServer: () => _lanWss,
});

registerSessionIpc({
  ipcMain,
  getSessionSnapshot: () => _state.buildSessionSnapshot(),
  getI18n: () => getDashboardI18nPayload(),
  focusSession: (sessionId, options) => focusDashboardSession(sessionId, options),
  hideSession: (sessionId) => hideDashboardSession(sessionId),
  ackSessionCompletion: (sessionId) => _state.ackSessionCompletion(sessionId),
  setSessionAlias: (payload) => _settingsController.applyCommand("setSessionAlias", payload),
  showDashboard: (options) => showDashboard(options),
  setSessionHudPinned: (value) => {
    const result = _settingsController.applyUpdate("sessionHudPinned", !!value);
    if (result && typeof result.then === "function") {
      result
        .then((r) => {
          if (r && r.status === "error") console.warn("Clawd: failed to pin Session HUD:", r.message);
        })
        .catch((err) => console.warn("Clawd: failed to pin Session HUD:", err && err.message));
    } else if (result && result.status === "error") {
      console.warn("Clawd: failed to pin Session HUD:", result.message);
    }
  },
  getLanWsServer: () => _lanWss,
});

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
  // #408: seed the in-memory frozen keep-size from the realized launch size, so
  // display events reuse it instead of re-reading transiently-wrong live bounds.
  if (keepSizeAcrossDisplaysCached && isProportionalMode()) {
    keepSizeFrozenPx = { width: size.width, height: size.height };
    // #408 round-2: restore the frozen origin Wa too. Prefer the dedicated
    // savedPixelWorkArea (post-fix prefs); fall back to positionDisplay.workArea
    // for legacy prefs — the next flush will rewrite with the new field.
    const persistedOrigin = snapshotKeepSizeOriginWa(prefs.savedPixelWorkArea);
    if (persistedOrigin) {
      keepSizeFrozenOriginWa = persistedOrigin;
    } else if (prefs.positionDisplay && prefs.positionDisplay.workArea) {
      keepSizeFrozenOriginWa = snapshotKeepSizeOriginWa(prefs.positionDisplay.workArea);
    }
  }

  const {
    initialVirtualBounds,
    initialWindowBounds,
  } = petWindowRuntime.resolveStartupPlacement(prefs, size, {
    restoreMiniFromPrefs: (prefsSnapshot, pixelSize) => _mini.restoreFromPrefs(prefsSnapshot, pixelSize),
  });

  petWindowRuntime.createRenderWindow({
    BrowserWindow,
    size,
    initialWindowBounds,
    initialVirtualBounds,
    preloadPath: path.join(__dirname, "preload.js"),
    loadFilePath: path.join(__dirname, "index.html"),
    themeConfig: themeRuntime.getRendererConfig(),
    setRenderWindow: (createdWindow) => { win = createdWindow; },
    isQuitting: () => isQuitting,
    applyDockVisibility,
  });

  buildContextMenu();
  if (!isMac || showTray) createTray();
  ensureContextMenuOwner();

  // ── Create input window (hitWin) — small rect over hitbox, receives all pointer events ──
  hitWin = petWindowRuntime.createHitWindow({
    BrowserWindow,
    preloadPath: path.join(__dirname, "preload-hit.js"),
    loadFilePath: path.join(__dirname, "hit.html"),
    hitThemeConfig: themeRuntime.getHitRendererConfig(),
    guardAlwaysOnTop,
    onDidFinishLoad: () => {
      sendToHitWin("theme-config", themeRuntime.getHitRendererConfig());
      if (themeRuntime.isReloadInProgress()) return;
      syncHitStateAfterLoad();
    },
    onRenderProcessGone: (details, ownedHitWin) => {
      safeConsoleError("hitWin renderer crashed:", details.reason);
      petWindowRuntime.setDragLocked(false);
      petWindowRuntime.clearDragSnapshot();
      idlePaused = false;
      mouseOverPet = false;
      petWindowRuntime.reloadWindowWebContents(ownedHitWin, { crashKey: "hitWin", details });
    },
  });

  // Event-level safety net for position sync
  win.on("move", () => petWindowRuntime.syncFloatingWindowsAfterPetBoundsChange());
  win.on("resize", () => petWindowRuntime.syncFloatingWindowsAfterPetBoundsChange());

  syncSessionHudVisibility();

  registerPetInteractionIpc({
    ipcMain,
    showContextMenu: (event) => showPetContextMenu(event),
    moveWindowForDrag: () => moveWindowForDrag(),
    setIdlePaused: (value) => { idlePaused = !!value; },
    setLowPowerIdlePaused,
    isMiniTransitioning: () => _mini.getMiniTransitioning(),
    getCurrentState: () => _state.getCurrentState(),
    getCurrentSvg: () => _state.getCurrentSvg(),
    sendToRenderer,
    setDragLocked: (value) => { petWindowRuntime.setDragLocked(value); },
    setMouseOverPet: (value) => { mouseOverPet = !!value; },
    beginDragSnapshot: () => beginDragSnapshot(),
    clearDragSnapshot: () => clearDragSnapshot(),
    syncHitWin: () => syncHitWin(),
    isMiniMode: () => _mini.getMiniMode(),
    checkMiniModeSnap: () => checkMiniModeSnap(),
    getDisableMiniMode: () => disableMiniModeCached,
    hasPetWindow: () => !!(win && !win.isDestroyed()),
    getPetWindowBounds: () => getPetWindowBounds(),
    getKeepSizeAcrossDisplays: () => keepSizeAcrossDisplaysCached,
    getCurrentPixelSize: () => getCurrentPixelSize(),
    getEffectiveCurrentPixelSize: () => getEffectiveCurrentPixelSize(),
    computeDragEndBounds: (virtualBounds, size) =>
      computeFinalDragBounds(virtualBounds, size, clampToScreenVisual),
    applyPetWindowBounds: (bounds) => applyPetWindowBounds(bounds),
    flushRuntimeStateToPrefs: () => flushRuntimeStateToPrefs(),
    reassertWinTopmost: () => reassertWinTopmost(),
    scheduleHwndRecovery: () => scheduleHwndRecovery(),
    repositionFloatingBubbles: () => repositionFloatingBubbles(),
    exitMiniMode: () => exitMiniMode(),
    getFocusableLocalHudSessionIds: () => getFocusableLocalHudSessionIds(),
    focusLog: (message) => focusLog(message),
    showDashboard: () => showDashboard(),
    focusSession: (sessionId, options) => focusDashboardSession(sessionId, options),
    revealSessionHud: () => {
      if (_sessionHud && typeof _sessionHud.revealFromPet === "function") {
        _sessionHud.revealFromPet();
      }
    },
    statPath: (p) => fs.promises.stat(p),
    openTerminalAt: (dir) => openTerminalAt(dir),
    dropLog: (message) => console.log(`Clawd: ${message}`),
  });

  registerPermissionIpc({
    ipcMain,
    permission: _perm,
  });

  registerUpdateBubbleIpc({
    ipcMain,
    updateBubble: _updateBubble,
  });

  initFocusHelper();
  startMainTick();
  startHttpServer();
  if (_settingsController.get("mobilePreviewEnabled") === true) _lanWss.start();
  startStaleCleanup();
  // Wait for renderer to be ready before sending initial state
  // If hooks arrived during startup, respect them instead of forcing idle
  // Also handles crash recovery (render-process-gone → reload)
  win.webContents.on("did-start-loading", () => {
    setLowPowerIdlePaused(false);
  });
  win.webContents.on("did-finish-load", () => {
    sendToRenderer("theme-config", themeRuntime.getRendererConfig());
    sendToRenderer("viewport-offset", petWindowRuntime.getViewportOffsetY());
    if (themeRuntime.isReloadInProgress()) return;
    syncRendererStateAfterLoad();
  });

  // ── Crash recovery: renderer process can die from <object> churn ──
  win.webContents.on("render-process-gone", (_event, details) => {
    safeConsoleError("Renderer crashed:", details.reason);
    setLowPowerIdlePaused(false);
    petWindowRuntime.setDragLocked(false);
    idlePaused = false;
    mouseOverPet = false;
    petWindowRuntime.reloadWindowWebContents(win, { crashKey: "renderWin", details });
  });

  guardAlwaysOnTop(win);
  startTopmostWatchdog();

  // display-metrics-changed fires in bursts during DPI changes and RDP
  // reconnects, and each one re-clamps/repositions the pet — running them all
  // makes the pet visibly jitter mid-transition. Debounce the geometry handler
  // to the settled state, mirroring the textScale debounce below. (Keep
  // display-removed/added immediate: those rescue the pet off a vanished
  // display and must not be delayed.)
  let displayMetricsGeometryTimer = null;
  const reapplyDisplayGeometryAfterMetricsChange = () => {
    if (displayMetricsGeometryTimer) clearTimeout(displayMetricsGeometryTimer);
    displayMetricsGeometryTimer = setTimeout(() => {
      displayMetricsGeometryTimer = null;
      petWindowRuntime.handleDisplayMetricsChanged();
    }, 400);
  };
  screen.on("display-metrics-changed", reapplyDisplayGeometryAfterMetricsChange);
  screen.on("display-removed", () => petWindowRuntime.handleDisplayRemoved());
  screen.on("display-added", () => petWindowRuntime.handleDisplayAdded());

  // textScale is per-display: when the topology changes, window→display
  // mappings (and therefore effective scales) can change wholesale. Debounced
  // because these events arrive in bursts during reconnects.
  let textScaleTopologyTimer = null;
  const reapplyTextScaleAfterTopologyChange = () => {
    if (textScaleTopologyTimer) clearTimeout(textScaleTopologyTimer);
    textScaleTopologyTimer = setTimeout(() => {
      textScaleTopologyTimer = null;
      applyTextScaleNow();
    }, 400);
  };
  screen.on("display-metrics-changed", reapplyTextScaleAfterTopologyChange);
  screen.on("display-removed", reapplyTextScaleAfterTopologyChange);
  screen.on("display-added", reapplyTextScaleAfterTopologyChange);
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

function clampToScreenVisual(x, y, w, h, options = {}) { return petWindowRuntime.clampToScreenVisual(x, y, w, h, options); }
function clampToScreen(x, y, w, h) { return petWindowRuntime.clampToScreen(x, y, w, h); }

function computeFinalDragBounds(bounds, size, clampPosition = clampToScreenVisual) {
  return petWindowRuntime.computeFinalDragBounds(bounds, size, clampPosition);
}

// ── Mini Mode — initialized here after state module ──
const _miniCtx = {
  get theme() { return getActiveTheme(); },
  get win() { return win; },
  get currentSize() { return currentSize; },
  get doNotDisturb() { return doNotDisturb; },
  set doNotDisturb(v) { doNotDisturb = v; },
  get currentState() { return _state.getCurrentState(); },
  notifyUpdaterSilentExit: () => notifyUpdaterSilentExit(),
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
  syncSessionHudVisibility: () => syncSessionHudVisibilityAndBubbles(),
  repositionSessionHud: () => repositionSessionHud(),
  buildContextMenu: () => buildContextMenu(),
  buildTrayMenu: () => buildTrayMenu(),
  getAnimationAssetCycleMs: (file) => {
    if (!file) return null;
    const probe = animationOverridesMain && typeof animationOverridesMain.buildAnimationAssetProbe === "function"
      ? animationOverridesMain.buildAnimationAssetProbe(file)
      : null;
    return Number.isFinite(probe && probe.assetCycleMs) && probe.assetCycleMs > 0
      ? probe.assetCycleMs
      : null;
  },
};
const _mini = require("./mini")(_miniCtx);
const { enterMiniMode, exitMiniMode, enterMiniViaMenu, miniPeekIn, miniPeekOut,
        checkMiniModeSnap, cancelMiniTransition, animateWindowX, animateWindowParabola } = _mini;

// ── Free Roam — initialized here after state and mini modules ──
const _roamCtx = {
  get win() { return win; },
  getPetWindowBounds,
  applyPetWindowPosition,
  syncHitWin: () => syncHitWin(),
  repositionSessionHud: () => repositionSessionHud(),
  repositionAnchoredSurfaces: () => repositionAnchoredFloatingSurfaces(),
  repositionBubbles: () => repositionFloatingBubbles(),
  get bubbleFollowPet() { return bubbleFollowPet; },
  get pendingPermissions() { return pendingPermissions; },
  getNearestWorkArea,
  clampToScreenVisual,
  getMiniMode: () => _mini.getMiniMode(),
  getCurrentState: () => _state.getCurrentState(),
  get miniTransitioning() { return _mini.getMiniTransitioning(); },
  applyState: (state, svgOverride, opts) => _state.applyState(state, svgOverride, opts),
  setState: (state, svgOverride, opts) => _state.setState(state, svgOverride, opts),
};
const _roam = require("./roam")(_roamCtx);

// Free roam: initialize from prefs and react to toggle changes
_roam.setEnabled(_settingsController.get("freeRoam") === true);
try {
  _settingsController.subscribeKey("freeRoam", (value) => {
    _roam.setEnabled(value === true);
  });
} catch (err) {
  console.warn("Clawd: freeRoam subscribeKey failed:", err && err.message);
}

// Convenience getters for mini state (used throughout main.js)
Object.defineProperties(this || {}, {}); // no-op placeholder
// Mini state is accessed via _mini getters in ctx objects below

// ── Theme switching ──
//
// The settings controller calls themeRuntime.activateTheme through lazy
// injected deps. main.js remains the composition root; theme-runtime owns the
// active theme source and the cleanup/refresh/reload protocol.

// ── Auto-install VS Code / Cursor terminal-focus extension ──
const EXT_ID = "clawd.clawd-terminal-focus";
const EXT_VERSION = "0.1.1";
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
  codexPetMain.enqueueImportUrl(url);
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  if (process.argv.includes(REGISTER_PROTOCOL_DEV_ARG)) {
    const protocolRegistered = codexPetMain.registerProtocolClient();
    console.log(`Clawd: clawd:// dev protocol registration ${protocolRegistered ? "succeeded" : "failed"}`);
  }
  // Another instance is already running — quit silently
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    if (petWindowRuntime.isPetHidden()) {
      prepManualPetVisibility();
      petWindowRuntime.setPetHidden(false);
    } else {
      if (win) {
        win.showInactive();
        keepOutOfTaskbar(win);
      }
      if (hitWin && !hitWin.isDestroyed()) {
        hitWin.showInactive();
        keepOutOfTaskbar(hitWin);
      }
    }
    if (shouldOpenSettingsWindowFromArgv(commandLine)) {
      settingsWindowRuntime.openWhenReady();
    }
    codexPetMain.enqueueImportUrlsFromArgv(commandLine);
    reapplyMacVisibility();
  });

  // macOS: hide dock icon early if user previously disabled it
  if (isMac && app.dock) {
    if (_settingsController.get("showDock") === false) {
      app.dock.hide();
    }
  }

  app.whenReady().then(() => {
    // macOS: override the dock icon with a version padded to the macOS icon
    // grid (~80.5% of the canvas, ~100px transparent margin per side) so the
    // Dock tile matches neighbor apps. The build-time icon.png sits ~72.6%
    // (looks small); the earlier full-bleed dock-icon.png looked oversized
    // (issue #416). Source preserved at assets/source/dock-icon-fullbleed.png.
    if (isMac && app.dock && _settingsController.get("showDock") !== false) {
      try {
        app.dock.setIcon(path.join(__dirname, "..", "assets", "dock-icon.png"));
      } catch (_) {
        // non-fatal: fall back to the bundled icon
      }
    }

    const protocolRegistered = codexPetMain.registerProtocolClient();
    if (process.argv.includes(REGISTER_PROTOCOL_DEV_ARG)) {
      console.log(`Clawd: clawd:// dev protocol registration ${protocolRegistered ? "succeeded" : "failed"}`);
      app.quit();
      return;
    }

    // Import system-backed settings (openAtLogin) into prefs on first run.
    // Must run before createWindow() so the first menu draw sees the
    // hydrated value rather than the schema default.
    hydrateSystemBackedSettings();
    // First-run only: seed UI language from the device locale, before createWindow
    // so the very first menu/tray render is already in the user's language.
    hydrateFreshInstallLanguage();

    permDebugLog = path.join(app.getPath("userData"), "permission-debug.log");
    updateDebugLog = path.join(app.getPath("userData"), "update-debug.log");
    sessionDebugLog = path.join(app.getPath("userData"), "session-debug.log");
    focusDebugLog = path.join(app.getPath("userData"), "focus-debug.log");
    initTelegramMigrationController().catch((err) => {
      console.warn("Clawd: migration controller init failed:", err && err.message);
    });
    createWindow();
    // macOS: bridge the OS app-hidden state (⌘H / Dock right-click → 隐藏) to the
    // pet. Pet windows are setCanHide:NO, so the OS marks the app hidden but the
    // windows refuse to vanish, and an inactive-app Dock Hide fires no
    // did-resign-active — so we poll app.isHidden() and drive setPetHidden(). (#416)
    if (isMac) {
      macHideController = createMacHideController({
        isMac,
        app,
        getShowDock: () => showDock,
        isPetHidden: () => petWindowRuntime.isPetHidden(),
        setPetHidden: (hidden) => petWindowRuntime.setPetHidden(hidden),
      });
      macHideController.start();
      app.on("activate", () => { if (macHideController) macHideController.onActivate(); });
    }
    if (shouldOpenSettingsWindowFromArgv(process.argv)) {
      settingsWindowRuntime.open();
    }
    // First-run onboarding: anyone who has never seen the tutorial gets it once.
    // `tutorialSeen` is persisted but deliberately NOT migration-backfilled, so
    // existing users who update also see it once on their next launch, then the
    // flag flips to true forever (any dismissal counts). See prefs.js SCHEMA.
    try {
      if (!_settingsController.get("tutorialSeen")) _tutorial.open();
    } catch (err) {
      console.warn("Clawd: failed to open first-run tutorial:", err && err.message);
    }
    codexPetMain.enqueueImportUrlsFromArgv(process.argv);
    codexPetMain.flushPendingImportUrls().catch((err) => {
      console.warn("Clawd: Codex Pet import queue failed:", err && err.message);
    });

    // Register persistent global shortcuts from the validated prefs snapshot.
    shortcutRuntime.registerPersistentShortcutsFromSettings();

    // Construct log monitors. We always instantiate them so toggling the
    // agent on/off later can call start()/stop() without paying the require
    // cost at click time. Whether we call .start() right now depends on the
    // agent-gate snapshot — a user who disabled Codex at last shutdown
    // shouldn't see its file watcher spin up on the next launch.
    agentRuntime.startCodexLogMonitor();

    try {
      hardwareBuddyAdapter.start();
    } catch (err) {
      console.warn("Clawd: failed to start Hardware Buddy adapter:", err && err.message);
      hardwareBuddyLog(`start failed: ${err && err.message ? err.message : err}`);
    }

    // Auto-install VS Code/Cursor terminal-focus extension
    try { installTerminalFocusExtension(); } catch (err) {
      console.warn("Clawd: failed to auto-install terminal-focus extension:", err.message);
    }

    // Auto-updater: setup event handlers (user triggers check via tray menu)
    setupAutoUpdater();
    // #329: reconcile any stale pending-update entry (e.g. user installed
    // out-of-band on macOS) and start the background scheduler. Both are
    // safe in dev mode — reconcile is a no-op when nothing is pending,
    // and startUpdateScheduler() short-circuits on !app.isPackaged.
    try { reconcilePendingOnStartup(); } catch (err) { updateLog(`reconcile failed: ${err && err.message}`); }
    try { startUpdateScheduler(); } catch (err) { updateLog(`scheduler start failed: ${err && err.message}`); }
  });

  app.on("before-quit", () => {
    isQuitting = true;
    try { stopUpdateScheduler(); } catch {}
    releasePowerSaveBlocker();
    flushRuntimeStateToPrefs();
    globalShortcut.unregisterAll();
    void settingsSizePreviewSession.cleanup();
    stopTelegramApprovalSidecar();
    if (typeof unsubscribeHardwareBuddySettings === "function") {
      unsubscribeHardwareBuddySettings();
      unsubscribeHardwareBuddySettings = null;
    }
    if (hardwareBuddyAdapter) hardwareBuddyAdapter.stop();
    _perm.cleanup();
    _server.cleanup();
    if (_lanWss) _lanWss.cleanup();
    _updateBubble.cleanup();
    _state.cleanup();
    _tick.cleanup();
    _mini.cleanup();
    if (macHideController) macHideController.stop();
    _sessionHud.cleanup();
    agentRuntime.cleanup();
    topmostRuntime.cleanup();
    themeRuntime.cleanup();
    _focus.cleanup();
    if (animationOverridesMain) animationOverridesMain.cleanup();
    try { _remoteSshIpc.dispose(); } catch {}
    try { _remoteSshRuntime.cleanup(); } catch {}
    if (hitWin && !hitWin.isDestroyed()) hitWin.destroy();
  });

  app.on("window-all-closed", () => {
    if (!isQuitting) return;
    app.quit();
  });
}
