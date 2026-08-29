const { app, BrowserWindow, Notification, screen, ipcMain, globalShortcut, nativeTheme, dialog, shell, nativeImage, powerSaveBlocker, powerMonitor, clipboard, safeStorage } = require("electron");
const { maybeRunPackageKoffiSmoke } = require("./package-koffi-smoke");
if (maybeRunPackageKoffiSmoke({ app, BrowserWindow })) {
  return;
}
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
const crypto = require("crypto");
const { pathToFileURL } = require("url");
const { EventEmitter } = require("events");
const {
  applyWindowsAppUserModelId,
  shouldOpenSettingsWindowFromArgv,
} = require("./settings-window-icon");
const createSettingsWindowRuntime = require("./settings-window");
const createRoamFenceLoader = require("./roam-fence");
const createRoamFenceSettings = require("./roam-fence-settings");
const createRoamFencePicker = require("./roam-fence-picker");
const createPermissionAutomationConfirmationRuntime = require("./permission-automation-confirmation");
const {
  createSettingsSizePreviewSession,
} = require("./settings-size-preview-session");
const { registerSettingsIpc } = require("./settings-ipc");
const createSettingsEffectRouter = require("./settings-effect-router");
const { createKimiQuotaClient } = require("./kimi-quota-client");
const { createKimiQuotaCredentialStore } = require("./kimi-quota-credential-store");
const { createKimiQuotaRuntime } = require("./kimi-quota-runtime");
const {
  getPetTintIdForTheme,
  resolvePetTintPayload,
  buildPetAccessoryPayload,
  getPetMouthAccessoryIdForTheme,
  buildPetMouthAccessoryPayload,
} = require("./pet-customization-catalog");
const {
  finalizePetAccessorySlotsDelivery,
  getPetAccessorySlotsSnapshot,
  preparePetAccessorySlotsDelivery,
} = require("./pet-accessory-state");
const {
  getEffectivePetAccessoryIdForTheme,
  createHolidayAccessoryRuntime,
} = require("./holiday-accessory");
const { registerSessionIpc } = require("./session-ipc");
const { createSessionAutomationStore } = require("./session-automation-store");
const { createSessionAutomationCoordinator } = require("./session-automation-coordinator");
const {
  selectSessionAutomationDialogParent,
} = require("./session-automation-dialog-parent");
const { createSessionFolderOpener } = require("./session-open-folder");
const { isTrustedMainFrameEvent, registerPetInteractionIpc } = require("./pet-interaction-ipc");
const { createSystemWakeRecovery } = require("./system-wake-recovery");
const { formatLocalTimestamp } = require("./log-timestamp");
const { launchClaudeSession, openTerminalAt } = require("./launch-claude");
const { dialog: electronDialog } = require("electron");
const initPermission = require("./permission");
const { isPassiveNotifyEntry } = require("./passive-notify-entry");
const { registerPermissionIpc } = initPermission;
const telegramApprovalSettings = require("./telegram-approval-settings");
const { sanitizeTelegramApprovalLogMeta } = require("./telegram-approval-log-meta");
const discordPresenceSettings = require("./discord-presence-settings");
const { createDiscordPresenceBridge } = require("./discord-presence-rpc");
const { resolveAgentDisplayName } = require("./agent-display-name");
const {
  FeishuApprovalClient,
  classifyFeishuSdkError,
  lookupOpenIdByEmail,
} = require("./feishu-approval-client");
const feishuApprovalSettings = require("./feishu-approval-settings");
const { createSlackNotifyClient } = require("./slack-notify-client");
const slackNotifySettings = require("./slack-notify-settings");
const { saveFeishuApproverByEmail } = require("./settings-actions");
const {
  buildTelegramApprovalStatus,
  isNativeTelegramApprovalSelected,
  buildTelegramStatusDiagnostic,
  formatTelegramStatusDiagnostic,
} = require("./telegram-approval-runtime-status");
const { createTelegramMigrationController } = require("./telegram-migration-controller");
const { createTelegramMigrationNudge } = require("./telegram-migration-nudge");
const { createFeishuApprovalMigrationNudge } = require("./feishu-approval-migration-nudge");
const { createTrayBalloonOwner } = require("./tray-balloon-owner");
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
  isUsableWorkArea: isUsableBubbleWorkArea,
  resolveBubbleWorkArea,
} = require("./bubble-work-area");
const {
  getLaunchPixelSize,
  getLaunchSizingWorkArea,
  getProportionalPixelSize,
} = require("./size-utils");
const { keepOutOfTaskbar } = require("./taskbar");
const { loadTrayNormalIcon, loadTrayFlashIcon } = require("./tray-flash-icon");
const {
  installStartupDockIcon,
  resolveRuntimeDockIconPolicy,
} = require("./mac-dock-icon-runtime");
const createTopmostRuntime = require("./topmost-runtime");
const { WIN_TOPMOST_LEVEL } = createTopmostRuntime;
const createThemeFadeSequencer = require("./theme-fade-sequencer");
const createThemeRuntime = require("./theme-runtime");
const createAgentRuntimeMain = require("./agent-runtime-main");
const createFloatingWindowRuntime = require("./floating-window-runtime");
const createPetWindowRuntime = require("./pet-window-runtime");
const { collectRequiredAssetFiles } = require("./theme-schema");
const { describeGeometrySync } = require("./pet-accessory-state");
const { createDisplayedVisualProjection } = require("./displayed-visual-projection");
const { createTestReactionHandler } = require("./test-reaction");
const createMacHideController = require("./mac-hide");
const {
  getFocusableLocalHudSessionIds: selectFocusableLocalHudSessionIds,
  getSessionFocusTarget,
} = require("./session-focus");
const { focusCodexThreadTarget } = require("./session-focus-handoff");
const { isSessionInProgress } = require("./state-session-snapshot");
const { restoreSessionsFromRecoveryLeases } = require("./session-recovery-loader");
const { getAllAgents, getAgent } = require("../agents/registry");
const { getAgentIconUrl } = require("./state-agent-icons");
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

// ── Windows: foreground-fullscreen probe (suppress topmost over games) ──
// Best-effort; degrades to "never fullscreen" if koffi/user32 is unavailable,
// so a broken probe can never hide the pet.
const { createForegroundFullscreenProbe } = require("./win-fullscreen-detect");
const _isForegroundFullscreen = createForegroundFullscreenProbe({
  isWin,
  onError: (err) => console.warn("Clawd: win-fullscreen-detect not available:", err && err.message),
});

// ── Windows: DWM cloak inspection + un-cloak (#525 self-heal) ──
// Best-effort; degrades to "never cloaked / recovery no-op" when koffi/dwmapi
// or the virtual-desktop COM manager is unavailable.
const { createCloakInspector } = require("./win-cloak-recovery");
const _cloakInspector = createCloakInspector({
  isWin,
  log: (line) => console.warn(`Clawd: ${line}`),
});

// ── Windows: foreground Windows Terminal probe (server-side wt_hwnd sample,
// #627 residual) ──
// Best-effort; degrades to "never sampled" (always null) if koffi/user32 is
// unavailable, so a broken probe never blocks a /state POST — wt_hwnd just
// falls back to the session's last-known value (state.js merge). Never spawns
// a subprocess, so it cannot reproduce the console flash it exists to avoid.
const { createForegroundWindowsTerminalProbe } = require("./win-foreground-terminal");
const _captureForegroundWindowsTerminal = createForegroundWindowsTerminalProbe({
  isWin,
  onError: (err) => console.warn("Clawd: win-foreground-terminal not available:", err && err.message),
});

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
const { loadOrCreateInstallationIdentity } = require("./remote-ssh-identity");
const { createTranslator, i18n, SUPPORTED_LANGS } = require("./i18n");
const {
  getBubblePolicy,
  isAllBubblesHidden,
} = require("./bubble-policy");
const loginItemHelpers = require("./login-item");
const { writeCodexAutoStartGate } = require("../hooks/server-config");
const { createCodexAutoStartGateEvaluator } = require("./agent-gate");
const PREFS_PATH = path.join(app.getPath("userData"), "clawd-prefs.json");
const _initialPrefsLoad = prefsModule.load(PREFS_PATH);
// Recovery from readable invalid contents is writable only after the original
// bytes are safely kept in .bak. That fallback is not user intent for this
// process, and a backup failure locks persistence as well. Runtime gates stay
// closed until restart in either case.
const _initialPrefsRecovered = _initialPrefsLoad.recovered === true;
const _initialPrefsRecoveryBackupFailed = _initialPrefsLoad.recoveryBackupFailed === true;
const _codexAutoStartAuthorityLost = (
  _initialPrefsLoad.locked === true
  || _initialPrefsRecovered
  || _initialPrefsRecoveryBackupFailed
  || _initialPrefsLoad.codexAutoStartAuthoritative === false
);
const _evaluateCodexAutoStartGate = createCodexAutoStartGateEvaluator({
  authorityLost: _codexAutoStartAuthorityLost,
});

function _persistCodexAutoStartGate(enabled) {
  return writeCodexAutoStartGate(enabled === true);
}

function _syncCodexAutoStartGate(snapshot, source) {
  if (_persistCodexAutoStartGate(_evaluateCodexAutoStartGate(snapshot))) return true;
  console.warn(`Clawd: failed to sync Codex auto-start gate (${source})`);
  return false;
}

// Lazy helpers — these run inside the action `effect` callbacks at click time,
// long after server.js / hooks/install.js are loaded. Wrapping them in closures
// avoids a chicken-and-egg require order at module load.
//
// All of these route through _server's Claude hook operation queue rather than
// requiring hooks/install.js directly: every process-internal settings.json
// mutation must be serialized against the fs watcher, periodic health audit,
// and other Settings actions (#657).
function _installAutoStartHook() {
  return _server.setClaudeAutoStart({ enabled: true, source: "auto-start" });
}
function _uninstallAutoStartHook() {
  return _server.setClaudeAutoStart({ enabled: false, source: "auto-start" });
}
async function _uninstallClaudeHooksNow() {
  return _server.uninstallClaudeHooks({ source: "settings", automatic: false });
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

function _getAgentIntegrationOptions(agentId) {
  const agents = _settingsController && _settingsController.get("agents");
  const entry = agents && agents[agentId];
  if (!entry || typeof entry !== "object") return {};
  const options = {};
  const agent = getAgent(agentId);
  const capabilities = (agent && agent.capabilities) || {};
  if (capabilities.httpHook && capabilities.customPermissionUrl) {
    const customPermissionUrl = prefsModule.normalizeOptionalHttpUrl(entry.customPermissionUrl);
    options.permissionTarget = customPermissionUrl
      ? { mode: "custom", url: customPermissionUrl }
      : { mode: "local" };
  }
  return options;
}

function _resolveAgentDisplayName(agentId) {
  return resolveAgentDisplayName(agentId, _settingsController.get("customApplications"));
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
let sessionAutomationCoordinator = null;
let sessionAutomationStore = null;
let systemWakeRecovery = null;
let floatingWindowRuntime = null;
let codexPetMain = null;
let telegramApprovalIdentitySignature = "";
let _telegramMigrationController = null;
let telegramMigrationNudge = null;
let feishuApprovalMigrationNudge = null;
const trayBalloonOwner = createTrayBalloonOwner();
let telegramNativeRunner = null;
let telegramCompanion = null;
let telegramDirectSend = null;
let discordPresenceBridge = null;
// Renderer-visible state animations can diverge from state.currentSvg (idle
// rotation and reactions). Presence is fed only after the renderer confirms
// what is actually on screen.
let lastDiscordPresenceVisual = null;
let displayedVisualProjection = null;
let lastAppliedVisualGeneration = 0;
let suppressTelegramMigrationReconcile = 0;
let _remoteSshTransportCoordinator = null;
let feishuApprovalClient = null;
const feishuApprovalCloseDrains = new Set();
let feishuApprovalSyncPromise = Promise.resolve();
let feishuApprovalConfigSignature = "";
let feishuSessionAutomationRouteSignature = "";
let feishuApprovalSecretsRevision = 0;
// One-way Slack notifier. Unlike Feishu there is no connection to restart, but
// queued automatic sends must never cross a configuration boundary. The
// revision invalidates work captured before a preference or secret change.
let slackNotifyClient = null;
let slackNotifyConfigRevision = 0;
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
    syncClaudeHooksNow: () => _server.syncClawdHooks({ source: "settings", automatic: false }),
    setClaudeQuotaCollectionEnabled: (enabled) => _server.setClaudeQuotaCollectionEnabled({
      enabled,
      source: "settings-quota-collection",
    }),
    uninstallClaudeHooksNow: _uninstallClaudeHooksNow,
    startClaudeSettingsWatcher: () => _server.startClaudeSettingsWatcher(),
    stopClaudeSettingsWatcher: () => _server.stopClaudeSettingsWatcher(),
    setOpenAtLogin: _writeSystemOpenAtLogin,
    startMonitorForAgent: (id) => agentRuntime && agentRuntime.startMonitorForAgent(id),
    stopMonitorForAgent: (id) => agentRuntime && agentRuntime.stopMonitorForAgent(id),
    syncIntegrationForAgent: (id, options) =>
      agentRuntime ? agentRuntime.syncIntegrationForAgent(id, options) : false,
    repairIntegrationForAgent: (id, options) =>
      agentRuntime ? agentRuntime.repairIntegrationForAgent(id, options) : false,
    stopIntegrationForAgent: (id) => agentRuntime ? agentRuntime.stopIntegrationForAgent(id) : false,
    uninstallIntegrationForAgent: (id) => agentRuntime ? agentRuntime.uninstallIntegrationForAgent(id) : false,
    writeCodexAutoStartGate: _persistCodexAutoStartGate,
    deployHooksToWsl: async (distro, agentId) => {
      const { deployToWsl } = require("./wsl-deploy");
      return deployToWsl(distro, { agentId, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
    },
    removeHooksFromWsl: async (distro, agentId) => {
      const { removeFromWsl } = require("./wsl-deploy");
      return removeFromWsl(distro, { agentId, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
    },
    cleanupIntegrations: async (options = {}) => {
      // Claude hooks + statusline unregister as one queue task, awaited here so
      // it settles (and any in-flight repair drains) before the generic cleaner
      // runs. hooks/cleanup-integrations.js records this precomputed result
      // instead of unregistering Claude a second time outside the queue.
      const claudeCleanupResult = await _server.uninstallClaudeHooks({ source: "cleanup", automatic: false });
      const { cleanupIntegrations } = require("../hooks/cleanup-integrations.js");
      return cleanupIntegrations({ ...options, backup: true, silent: true, claudeCleanupResult });
    },
    repairLocalServer: () => _server && typeof _server.repairRuntimeStatus === "function"
      ? _server.repairRuntimeStatus()
      : false,
    restartClawd: _restartClawdNow,
    clearSessionsByAgent: (id) => agentRuntime ? agentRuntime.clearSessionsByAgent(id) : 0,
    clearSessionAutomationByAgent: (id) =>
      sessionAutomationCoordinator ? sessionAutomationCoordinator.clearAgent(id) : [],
    dismissPermissionsByAgent: (id, options) => agentRuntime ? agentRuntime.dismissPermissionsByAgent(id, options) : 0,
    clearRecentHookEvents: (id) => _server.clearRecentHookEvents(id),
    identifyCustomApplication: (sourcePath) => require("./custom-applications").identifyCustomApplication(sourcePath),
    resizePet: _deferredResizePet,
    getActiveSessionAliasKeys: () =>
      _state && typeof _state.getActiveSessionAliasKeys === "function"
        ? _state.getActiveSessionAliasKeys()
        : new Set(),
    writeTelegramApprovalToken: (token) => writeTelegramApprovalToken(token),
    getTelegramApprovalStatus: () => getTelegramApprovalStatus(),
    getTelegramApprovalTokenInfo: () => getTelegramApprovalTokenInfo(),
    sendTelegramApprovalTest: () => sendTelegramApprovalTest(),
    writeFeishuApprovalSecrets: (secrets) => writeFeishuApprovalSecrets(secrets),
    getFeishuApprovalPrefs: () => getFeishuApprovalPrefs(),
    getFeishuApprovalSecrets: () => getFeishuApprovalSecrets(),
    getFeishuApprovalSecretsRevision: () => feishuApprovalSecretsRevision,
    getFeishuApprovalStatus: () => getFeishuApprovalStatus(),
    getFeishuApprovalSecretInfo: () => getFeishuApprovalSecretInfo(),
    sendFeishuApprovalTest: (persisted) => sendFeishuApprovalTest(persisted),
    writeSlackNotifySecrets: (secrets) => writeSlackNotifySecrets(secrets),
    getSlackNotifyStatus: () => getSlackNotifyStatus(),
    getSlackNotifySecretInfo: () => getSlackNotifySecretInfo(),
    sendSlackNotifyTest: () => sendSlackNotifyTest(),
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
    getActiveTheme: () => themeRuntime.getActiveTheme(),
    globalShortcut,
    shortcutHandlers,
    // The controller is created before shortcutRuntime because each side needs
    // the other. These callbacks may run before the runtime is assigned.
    getShortcutFailure: (actionId) => shortcutRuntime ? shortcutRuntime.getFailure(actionId) : null,
    clearShortcutFailure: (actionId) => {
      if (shortcutRuntime) shortcutRuntime.clearFailure(actionId);
    },
    isRemoteSshTransportBusy: (profileId) => {
      if (_remoteSshTransportCoordinator) {
        const snapshot = _remoteSshTransportCoordinator.snapshotForProfile(profileId);
        if (snapshot.transportPhase !== "idle") return true;
      }
      if (_remoteSshRuntime) {
        const status = _remoteSshRuntime.getProfileStatus(profileId);
        return status.status === "connecting"
          || status.status === "connected"
          || status.status === "reconnecting";
      }
      return false;
    },
  },
});
_settingsController.subscribeKey("agents", (_agents, snapshot) => {
  // A readable future-version prefs file may still change in memory for the
  // current process. An unreadable prefs file rejects mutations earlier in the
  // controller. In both locked cases, publishing ephemeral values would let a
  // retained hook cold-launch Clawd against a different durable prefs truth.
  if (_settingsController.isLocked()) return;
  _syncCodexAutoStartGate(snapshot, "settings");
});
_settingsController.subscribeKey("autoStartWithCodex", (_enabled, snapshot) => {
  if (_settingsController.isLocked()) return;
  _syncCodexAutoStartGate(snapshot, "settings");
});
let _remoteSshInstallationIdentity = null;
let _remoteSshInstallationIdentityPromise = null;

async function initializeRemoteSshInstallationIdentity() {
  const remoteSsh = _settingsController.get("remoteSsh") || {};
  const persistedAuthorityPresent = Array.isArray(remoteSsh.profiles)
    && remoteSsh.profiles.some((profile) => profile && (
      typeof profile.routingNonce === "string"
      || typeof profile.previousNonce === "string"
      || !!profile.identityTxn
      || profile.isolatedActive === true
      || !!profile.isolatedRuntime
      || (Array.isArray(profile.managedDeployTargets) && profile.managedDeployTargets.length > 0)
      || (Number.isFinite(profile.lastDeployedAt) && profile.lastDeployedAt > 0)
    ));
  const identity = loadOrCreateInstallationIdentity({
    userDataDir: app.getPath("userData"),
    expectedInstallId: remoteSsh.installId,
    persistedAuthorityPresent,
    safeStorage,
  });
  const result = await _settingsController.applyCommand("remoteSsh.applyInstallationIdentity", {
    installId: identity.installId,
    cloneRecoveryRequired: identity.cloneRecoveryRequired === true,
  });
  if (!result || result.status !== "ok") {
    throw new Error((result && result.message) || "failed to bind Remote SSH installation identity");
  }
  _remoteSshInstallationIdentity = Object.freeze(identity);
  if (identity.cloneRecoveryRequired) {
    console.warn("Clawd remote-ssh: local installation identity changed; remote profiles require redeploy");
  }
  if (!identity.strongStorage) {
    console.warn(`Clawd remote-ssh: installation binding uses weak storage backend (${identity.storageBackend})`);
  }
  return identity;
}

function ensureRemoteSshInstallationIdentity() {
  if (_remoteSshInstallationIdentity) {
    return Promise.resolve(_remoteSshInstallationIdentity);
  }
  if (_remoteSshInstallationIdentityPromise) {
    return _remoteSshInstallationIdentityPromise;
  }
  _remoteSshInstallationIdentityPromise = initializeRemoteSshInstallationIdentity()
    .finally(() => {
      _remoteSshInstallationIdentityPromise = null;
    });
  return _remoteSshInstallationIdentityPromise;
}

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
  invalidateDisplayedVisual: (detail) => resetDisplayedVisualProjection(detail),
  refreshDisplayedVisualHitBoxes: () => refreshDisplayedVisualHitBoxes(),
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

let roamFencePickerRuntime = null;
const settingsWindowRuntime = createSettingsWindowRuntime({
  app,
  BrowserWindow,
  fs,
  isWin,
  nativeTheme,
  path,
  discordDefaultAppIdPresent: !!discordPresenceSettings.DEFAULT_CLAWD_DISCORD_APP_ID,
  getPetWindowBounds: () => getPetWindowBounds(),
  getNearestWorkArea: (cx, cy) => getNearestWorkArea(cx, cy),
  getTextScale: (bounds) => effectiveTextScaleForKey(
    getDisplayKeyForBounds(bounds) || getSettingsDisplayKey()
  ),
  getSavedBounds: () => _settingsController.get("settingsWindowBounds"),
  onSaveBounds: (bounds) => _settingsController.applyUpdate("settingsWindowBounds", bounds),
  getTitle: () => translate("settingsWindowTitle"),
  onBeforeCreate: () => bumpAnimationOverridePreviewPosterGeneration(),
  onBeforeClosed: () => {
    if (roamFencePickerRuntime) roamFencePickerRuntime.cancel();
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

const permissionAutomationConfirmationRuntime = createPermissionAutomationConfirmationRuntime({
  BrowserWindow,
  ipcMain,
  nativeTheme,
  screen,
  path,
  iconPath: settingsWindowRuntime.getIconPath(),
});

function getSettingsWindow() {
  return settingsWindowRuntime.getWindow();
}

// The file loader is shared by roam and Settings. A selection saved from the
// visual picker therefore updates the exact same last-known-good cache that a
// later walk reads; external tools keep using the same JSON contract.
const roamFenceLoader = createRoamFenceLoader();
const roamFenceSettings = createRoamFenceSettings({ loader: roamFenceLoader });
roamFencePickerRuntime = createRoamFencePicker({
  BrowserWindow,
  ipcMain,
  nativeTheme,
  screen,
  path,
  iconPath: settingsWindowRuntime.getIconPath(),
  getSettingsWindow,
  getPetWindowBounds: () => getPetWindowBounds(),
  getEffectivePetSize: (workArea) => getEffectiveCurrentPixelSize(workArea),
});

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
// Geometry's startup/theme-swap fallback only. It must stay a pure read:
// Slot candidates commit to canonical state, so using one here would let a
// hit-window sync install a payload resolved from its own
// wall clock — the midnight/holiday race the canonical payload exists to end.
function getEffectivePetAccessoryPayloads(activeTheme = getActiveTheme()) {
  const snapshot = _settingsController.getSnapshot();
  const headId = getEffectivePetAccessoryIdForTheme({
    petAccessory: snapshot.petAccessory,
    holidayAccessoryEnabled: snapshot.holidayAccessoryEnabled,
    themeId: activeTheme && activeTheme._id,
  });
  const mouthId = getPetMouthAccessoryIdForTheme(
    snapshot.petMouthAccessory,
    activeTheme && activeTheme._id
  );
  return {
    head: buildPetAccessoryPayload(headId, activeTheme),
    mouth: buildPetMouthAccessoryPayload(mouthId, activeTheme),
  };
}

function getEffectivePetAccessoryIds() {
  const activeTheme = getActiveTheme();
  const canonical = getPetAccessorySlotsSnapshot(activeTheme);
  const payloads = canonical ? canonical.payloads : getEffectivePetAccessoryPayloads();
  return Object.freeze({
    head: payloads.head.id,
    mouth: payloads.mouth.id,
  });
}

function prepareCurrentAccessorySlotsDelivery(activeTheme = getActiveTheme()) {
  return preparePetAccessorySlotsDelivery(
    getEffectivePetAccessoryPayloads(activeTheme),
    activeTheme
  );
}

function deliverAccessorySlotsSnapshot(activeTheme = getActiveTheme()) {
  const delivery = prepareCurrentAccessorySlotsDelivery(activeTheme);
  const candidate = delivery.snapshot;
  const delivered = sendToRenderer("pet-accessory-slots-change", candidate);
  if (!finalizePetAccessorySlotsDelivery(delivery, delivered)) return false;
  const geometry = describeGeometrySync(syncHitWin());
  if (geometry.applied) {
    try { repositionAnchoredFloatingSurfaces(); } catch {}
  }
  return true;
}

// Composed accessory facing as the renderer actually applied it (mini-left
// stage XOR asset-direction stage). Defaults to unmirrored until the first
// report; that matches the pre-accessory-hitbox behaviour.
let _accessoryMirrored = false;
function setAccessoryMirrored(mirrored) {
  const next = !!mirrored;
  if (_accessoryMirrored === next) return;
  _accessoryMirrored = next;
  syncHitWin();
}

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
  getDisplayedVisual: () => getDisplayedVisualTuple(),
  getCurrentState: () => getDisplayedVisualTuple().displayState,
  getCurrentSvg: () => getDisplayedVisualTuple().file,
  getCurrentHitBox: () => getDisplayedVisualTuple().hitBox,
  getCurrentAccessoryPayloads: getEffectivePetAccessoryPayloads,
  getAccessoryMirrored: () => _accessoryMirrored,
  getMiniMode: () => _mini.getMiniMode(),
  getMiniTransitioning: () => _mini.getMiniTransitioning(),
  getMiniContainedSeam: () => _mini.getContainedSeam(),
  getMiniPeekOffset: () => _mini.PEEK_OFFSET,
  getCurrentPixelSize: () => getCurrentPixelSize(),
  getEffectiveCurrentPixelSize: (workArea) => getEffectiveCurrentPixelSize(workArea),
  getAllowEdgePinning: () => allowEdgePinningCached,
  getPrimaryWorkAreaSafe: () => getPrimaryWorkAreaSafe(),
  getNearestWorkArea,
  sendToRenderer,
  keepOutOfTaskbar,
  repositionSessionHud: () => repositionSessionHud(),
  repositionAnchoredSurfaces: () => repositionAnchoredFloatingSurfaces(),
  // #640: hitbox changes without a window move (state switch, theme reload)
  // must re-answer the editing-overlap question. (Lazy — defined below.)
  syncImeEditingPetDodge: () => topmostRuntime.syncImeEditingPetDodge(),
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
  cloakInspector: _cloakInspector,
  isMiniAnimating: () => _mini.getIsAnimating(),
  // Issue #690 plan §4.3.10's fourth reconcile protection period (lazy-bound
  // like isMiniAnimating above — _roam is constructed after petWindowRuntime,
  // but this closure isn't invoked until well after module load finishes).
  isRoamAnimating: () => _roam.isRoamAnimating(),
  isNearWorkAreaEdge: (bounds) => isNearWorkAreaEdge(bounds),
  flushRuntimeStateToPrefs: () => flushRuntimeStateToPrefs(),
  handleMiniDisplayChange: () => _mini.handleDisplayChange(),
  // Issue #690 plan §4.5 point 4.5-4: handleDisplayMetricsChanged() used to
  // silently swallow topology changes that land mid-mini-transition (the
  // `if (getMiniTransitioning()) return;` guard). Instead it now hands off to
  // mini.js so the change isn't lost — mini marks pendingTopologyMaterialize
  // and does exactly one final re-materialize against fresh topology at
  // whichever of its own three transition-end points comes next.
  notifyMiniTopologyChangedDuringTransition: () => _mini.notifyTopologyChangedDuringTransition(),
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
let quitCleanupStarted = false;
let appQuitDrainStarted = false;
let appQuitDrainReady = false;
// Mirror caches: kept in sync with the settings store via settings-effect-router
// further down. Read freely; never assign
// directly (writes go through ctx setters → controller.applyUpdate).
let showTray = _settingsController.get("showTray");
let showDock = _settingsController.get("showDock");
let manageClaudeHooksAutomatically = _settingsController.get("manageClaudeHooksAutomatically");
let autoStartWithClaude = _settingsController.get("autoStartWithClaude");
let openAtLogin = _settingsController.get("openAtLogin");
let bubbleFollowPet = _settingsController.get("bubbleFollowPet");
let bubbleFollowPreference = _settingsController.get("bubbleFollowPreference");
let bubbleFixedCorner = _settingsController.get("bubbleFixedCorner");
let sessionHudEnabled = _settingsController.get("sessionHudEnabled");
let sessionHudShowStateLabels = _settingsController.get("sessionHudShowStateLabels");
let sessionHudShowElapsed = _settingsController.get("sessionHudShowElapsed");
let sessionHudShowContextUsage = _settingsController.get("sessionHudShowContextUsage");
let sessionHudShowQuota = _settingsController.get("sessionHudShowQuota");
let quotaRingDisplayMode = _settingsController.get("quotaRingDisplayMode");
let quotaRingHiddenProviders = _settingsController.get("quotaRingHiddenProviders");
let claudeQuotaCollectionEnabled = _settingsController.get("claudeQuotaCollectionEnabled");
let kimiQuotaCollectionEnabled = _settingsController.get("kimiQuotaCollectionEnabled");
let quotaMergeSources = _settingsController.get("quotaMergeSources");
let sessionHudCleanupDetached = _settingsController.get("sessionHudCleanupDetached");
let sessionHudPinned = _settingsController.get("sessionHudPinned");
let sessionStaleMs = _settingsController.get("sessionStaleMs");
let workingStaleMs = _settingsController.get("workingStaleMs");
let codexWorkingStaleMs = _settingsController.get("codexWorkingStaleMs");
let detachedIdleStaleMs = _settingsController.get("detachedIdleStaleMs");
let soundMuted = _settingsController.get("soundMuted");
let soundVolume = _settingsController.get("soundVolume");
let lowPowerIdleMode = _settingsController.get("lowPowerIdleMode");
let keepAwakeWhileWorking = _settingsController.get("keepAwakeWhileWorking");
let petTint = _settingsController.get("petTint");
let allowEdgePinningCached = _settingsController.get("allowEdgePinning");
let disableMiniModeCached = _settingsController.get("disableMiniMode");
let keepSizeAcrossDisplaysCached = _settingsController.get("keepSizeAcrossDisplays");
let fullscreenOverlayCached = _settingsController.get("fullscreenOverlay");
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

function sendRawToRenderer(channel, ...args) {
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return false;
  win.webContents.send(channel, ...args);
  return true;
}

function inferVisualSource(displayState, file) {
  return displayState === "idle" && file !== _state.getCurrentSvg()
    ? "idle-animation"
    : "state";
}

function requestDisplayedVisual(displayState, file, options = {}) {
  if (!displayedVisualProjection) return null;
  const activeTheme = getActiveTheme();
  return displayedVisualProjection.request({
    themeId: activeTheme && activeTheme._id,
    logicalState: options.logicalState || _state.getCurrentState(),
    displayState,
    file,
    hitBox: _state.resolveHitBoxForSvg(file),
    source: options.source || inferVisualSource(displayState, file),
    deliver: options.deliver || ((payload) => sendRawToRenderer("state-change", payload)),
    onLogicalSettlement: options.onLogicalSettlement,
  });
}

function resetDisplayedVisualProjection(detail = "projection-reset", options = {}) {
  if (!displayedVisualProjection) return false;
  const activeTheme = getActiveTheme();
  displayedVisualProjection.reset({
    themeId: activeTheme && activeTheme._id,
    logicalState: _state.getCurrentState(),
    detail,
    preserveCommitted: options.preserveCommitted === true,
  });
  if (options.preserveCommitted !== true) {
    lastAppliedVisualGeneration = 0;
    lastDiscordPresenceVisual = null;
  }
  return true;
}

function refreshDisplayedVisualHitBoxes() {
  if (!displayedVisualProjection) return false;
  const refreshed = displayedVisualProjection.refreshHitBoxes(
    (file) => _state.resolveHitBoxForSvg(file)
  );
  if (!refreshed) return false;
  lastAppliedVisualGeneration = 0;
  return syncDisplayedVisualGeometry();
}

function refreshDisplayedVisualForLowPowerMode() {
  const activeTheme = getActiveTheme();
  const state = _state.getCurrentState();
  const file = _state.getCurrentSvg();
  const override = activeTheme
    && activeTheme.rendering
    && activeTheme.rendering.lowPowerStaticImageOverrides
    && activeTheme.rendering.lowPowerStaticImageOverrides[state];
  if (!override || override.from !== file || !override.to) return false;
  return !!requestDisplayedVisual(state, file, {
    logicalState: state,
    source: "state",
  });
}

function isVisualGenerationCurrent(visualGeneration) {
  if (!displayedVisualProjection || !Number.isSafeInteger(visualGeneration)) return false;
  const snapshot = displayedVisualProjection.getSnapshot();
  const current = snapshot.requested || snapshot.committed;
  return !!(current && current.visualGeneration === visualGeneration);
}

function resolveDragReactionFile(direction) {
  const theme = getActiveTheme();
  const drag = theme && theme.reactions && theme.reactions.drag;
  if (!drag || typeof drag !== "object") return null;
  if (direction === "left" && typeof drag.fileLeft === "string") return drag.fileLeft;
  if (direction === "right" && typeof drag.fileRight === "string") return drag.fileRight;
  return typeof drag.file === "string" ? drag.file : null;
}

function requestDragReaction(direction) {
  const normalizedDirection = direction === "left" || direction === "right" ? direction : null;
  const file = resolveDragReactionFile(normalizedDirection);
  if (!file) return null;
  const snapshot = displayedVisualProjection.getSnapshot();
  const activeReaction = snapshot.requested || snapshot.committed;
  if (activeReaction && activeReaction.source === "reaction" && activeReaction.file === file) {
    sendRawToRenderer("start-drag-reaction", null, normalizedDirection);
    return activeReaction;
  }
  return requestDisplayedVisual(_state.getCurrentState(), file, {
    source: "reaction",
    deliver: (payload) => sendRawToRenderer("start-drag-reaction", payload, normalizedDirection),
  });
}

function requestClickReaction(file, duration) {
  const activeTheme = getActiveTheme();
  if (!activeTheme || !collectRequiredAssetFiles(activeTheme).includes(file)) return null;
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  return requestDisplayedVisual(_state.getCurrentState(), file, {
    source: "reaction",
    deliver: (payload) => sendRawToRenderer("play-click-reaction", payload, safeDuration),
  });
}

function sendToRenderer(channel, ...args) {
  if (channel === "state-change") {
    return requestDisplayedVisual(args[0], args[1], args[2] || {});
  }
  return sendRawToRenderer(channel, ...args);
}
function sendToHitWin(channel, ...args) {
  if (hitWin && !hitWin.isDestroyed()) hitWin.webContents.send(channel, ...args);
}
function broadcastSettingsWindow(channel, payload) {
  try {
    const settingsWin = getSettingsWindow();
    if (!settingsWin || settingsWin.isDestroyed()) return;
    if (!settingsWin.webContents || settingsWin.webContents.isDestroyed()) return;
    settingsWin.webContents.send(channel, payload);
  } catch {}
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
// Issue #690 Phase 3: mini's per-frame applyMiniFrameBounds() needs opts
// (workArea/edgeContext/assertNoYOffset) to actually reach
// petWindowRuntime.applyPetWindowBounds() — this wrapper used to silently
// drop a second argument, which would have made assertNoYOffset a no-op.
function applyPetWindowBounds(bounds, opts) { return petWindowRuntime.applyPetWindowBounds(bounds, opts); }
// PR #751 Codex deep review, rework batch A (coordinator-attributed fix):
// this sibling wrapper had the exact same 2-param bug applyPetWindowBounds
// above was fixed for — topmost-runtime.js's applyFreshNudge() (#525) calls
// applyPetWindowPosition(x, y, { force: true }) specifically so the
// compositor-refresh nudge writes natively even when the materialized
// physical rect already matches current live bounds, but this wrapper
// silently dropped that third argument, making force:true a no-op.
function applyPetWindowPosition(x, y, opts) { return petWindowRuntime.applyPetWindowPosition(x, y, opts); }

function syncHitStateAfterLoad() {
  sendToHitWin("hit-state-sync", {
    currentState: _state.getCurrentState(),
    miniMode: _mini.getMiniMode(),
    dndEnabled: doNotDisturb,
  });
}

function syncRendererStateAfterLoad({ includeStartupRecovery = true } = {}) {
  syncSoundPreloads();
  const activeTheme = getActiveTheme();
  const tintId = getPetTintIdForTheme(petTint, activeTheme && activeTheme._id);
  sendToRenderer("pet-tint-change", resolvePetTintPayload(tintId, activeTheme));
  deliverAccessorySlotsSnapshot(activeTheme);
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
    trayFlashNormalIcon = loadTrayNormalIcon({
      nativeImage,
      platform: process.platform,
      templatePath: path.join(__dirname, "../assets/tray-iconTemplate.png"),
      iconPath: path.join(__dirname, "../assets/icon.png"),
    });
  }

  // Cache the completion icon on first call. macOS uses a dedicated Template
  // pair in the same 18pt slot; Windows/Linux retain the 32px orange dot.
  if (!trayFlashHighlightIcon) {
    trayFlashHighlightIcon = loadTrayFlashIcon({
      nativeImage,
      platform: process.platform,
      flashPath: path.join(__dirname, "../assets/tray-icon-flash.png"),
      flashTemplatePath: path.join(__dirname, "../assets/tray-icon-flashTemplate.png"),
      fileExists: (p) => fs.existsSync(p),
    });
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

function getDisplayedVisualTuple() {
  const committed = displayedVisualProjection
    && displayedVisualProjection.getSnapshot().committed;
  if (committed) return committed;
  return {
    displayState: _state.getCurrentState(),
    file: _state.getCurrentSvg(),
    hitBox: _state.getCurrentHitBox(),
    source: "startup",
    visualGeneration: 0,
  };
}

function syncDisplayedVisualGeometry() {
  const committed = displayedVisualProjection
    && displayedVisualProjection.getSnapshot().committed;
  if (!committed || committed.visualGeneration === lastAppliedVisualGeneration) return true;
  const outcome = describeGeometrySync(syncHitWin());
  if (outcome.applied) lastAppliedVisualGeneration = committed.visualGeneration;
  return outcome.applied;
}

let mouseOverPet = false;
let menuOpen = false;
let idlePaused = false;
let lowPowerIdlePaused = false;
let forceEyeResend = false;
let forceEyeResendBoostUntil = 0;
let requestFastTick = () => {};
let repositionSessionHud = () => {};
let repositionQuotaRing = () => {};
let syncSessionHudVisibility = () => {};
let broadcastSessionHudSnapshot = () => {};
let sendSessionHudI18n = () => {};
let getSessionHudReservedOffset = () => 0;
let getSessionHudWindow = () => null;
let getQuotaRingWindow = () => null;

function getVisibleSessionHudBounds() {
  try {
    const hudWindow = getSessionHudWindow();
    if (
      !hudWindow
      || (typeof hudWindow.isDestroyed === "function" && hudWindow.isDestroyed())
      || (typeof hudWindow.isVisible === "function" && !hudWindow.isVisible())
      || typeof hudWindow.getBounds !== "function"
    ) {
      return [];
    }
    const bounds = hudWindow.getBounds();
    if (
      !bounds
      || !Number.isFinite(bounds.x)
      || !Number.isFinite(bounds.y)
      || !Number.isFinite(bounds.width)
      || bounds.width <= 0
      || !Number.isFinite(bounds.height)
      || bounds.height <= 0
    ) {
      return [];
    }
    return [{ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }];
  } catch {
    return [];
  }
}
const themeFadeSequencer = createThemeFadeSequencer({
  getRenderWindow: () => win,
  getHitWindow: () => hitWin,
  // #640: while the pet dodges an editing bubble its baseline opacity is the
  // faded value, not 1 — restoring to 1 mid-edit would plant an opaque pet on
  // top of the box being typed into. (Lazy: topmostRuntime is defined below.)
  getRestoreOpacity: () => topmostRuntime.getPetTargetOpacity(),
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

// Windows-only (#538 drag focus-steal): the topmost watchdog calls this each
// tick with the inverse of the fullscreen state. While a fullscreen app owns
// the foreground we drop the hit window's activation so a click on the pet
// can't steal focus from an exclusive-fullscreen game and minimize it; we
// restore it when fullscreen ends because dragging needs activation (#545).
// Idempotent via isFocusable() so the per-tick call is a no-op when unchanged.
function setHitWinFocusable(focusable) {
  if (!isWin) return;
  if (!hitWin || hitWin.isDestroyed() || typeof hitWin.setFocusable !== "function") return;
  const next = !!focusable;
  if (typeof hitWin.isFocusable === "function" && hitWin.isFocusable() === next) return;
  hitWin.setFocusable(next);
  // Electron's NativeWindowViews::SetFocusable couples activation to the
  // taskbar on Windows: SetFocusable(true) internally calls
  // SetSkipTaskbar(false) → ITaskbarList::AddTab, so restoring activation
  // after a fullscreen exit (or a screenshot overlay dismissing) flashes a
  // taskbar button for the hit window (#586). Delete the tab again in the
  // same turn, before the taskbar repaints.
  // true-direction ONLY: SetFocusable(false) already deletes the tab
  // internally, and re-deleting on that path broke cursor-drag while a
  // fullscreen app was foreground (real-machine repro during #586 review;
  // exact Windows-side mechanism unconfirmed). Do not "simplify" this into
  // an unconditional call.
  if (next) keepOutOfTaskbar(hitWin);
}

// ── Mini Mode — delegated to src/mini.js ──
// Initialized after state module (needs applyState, resolveDisplayState, etc.)
// See _mini initialization below

// ── alwaysOnTop recovery — delegated to src/topmost-runtime.js ──
let permissionPresentationRuntime = null;
const topmostRuntime = createTopmostRuntime({
  isWin,
  isMac,
  getWin: () => win,
  getHitWin: () => hitWin,
  recoverCloakedPet: () => petWindowRuntime.recoverIfCloaked(),
  getPendingPermissions: () => pendingPermissions,
  getPermissionPresentationWindows: () => (
    permissionPresentationRuntime
    && typeof permissionPresentationRuntime.getPermissionPresentationWindows === "function"
      ? permissionPresentationRuntime.getPermissionPresentationWindows()
      : pendingPermissions.map((entry) => entry && entry.bubble).filter(Boolean)
  ),
  getUpdateBubbleWindow: () => _updateBubble.getBubbleWindow(),
  getSessionHudWindow: () => getSessionHudWindow(),
  getQuotaRingWindow: () => getQuotaRingWindow(),
  getContextMenuOwner: () => contextMenuOwner,
  getNearestWorkArea,
  getPetWindowBounds,
  // #640: tight sprite rect for the editing-overlap dodge test
  getHitRectScreen: (bounds) => getHitRectScreen(bounds),
  getShowDock: () => showDock,
  isDragLocked: () => petWindowRuntime.isDragLocked(),
  isMiniAnimating: () => _mini.getIsAnimating(),
  isMiniTransitioning: () => _mini.getMiniTransitioning(),
  isForegroundFullscreen: () => _isForegroundFullscreen(),
  getFullscreenOverlay: () => fullscreenOverlayCached,
  setHitWinFocusable,
  keepOutOfTaskbar,
  setForceEyeResend,
  applyPetWindowPosition,
  syncHitWin,
  // I5 (plan §3): report the macOS editing-overlap dodge intent through
  // pet-window-runtime's single ignore-mouse writer instead of this module
  // calling hitWin.setIgnoreMouseEvents() directly.
  setImeEditingPetDodge: (value) => petWindowRuntime.setImeEditingPetDodge(value),
});
const {
  reassertWinTopmost,
  reapplyMacVisibility,
  isNearWorkAreaEdge,
  scheduleHwndRecovery,
  guardAlwaysOnTop,
  startTopmostWatchdog,
  startFocusablePoll,
} = topmostRuntime;

// ── Permission bubble — delegated to src/permission.js ──
const {
  createRuntimeAgentGate,
} = require("./agent-gate");
const _runtimeAgentGate = createRuntimeAgentGate({
  getSnapshot: () => _settingsController.getSnapshot(),
  // Both unreadable prefs and a writable recovered-defaults snapshot are
  // non-authoritative for this process. The latter may repair the primary file,
  // but only a clean load after restart can re-open agent paths.
  isAuthoritative: () => !_initialPrefsRecovered && !_settingsController.hasReadFailure(),
});
const _permCtx = {
  get win() { return win; },
  get lang() { return lang; },
  get sessions() { return sessions; },
  get bubbleFollowPet() { return bubbleFollowPet; },
  get bubbleFollowPreference() { return bubbleFollowPreference; },
  get bubbleFixedCorner() { return bubbleFixedCorner; },
  get permDebugLog() { return permDebugLog; },
  get doNotDisturb() { return doNotDisturb; },
  get hideBubbles() { return getAllBubblesHidden(); },
  get petHidden() { return petWindowRuntime.isPetHidden(); },
  getBubblePolicy: getRuntimeBubblePolicy,
  getPetWindowBounds,
  getNearestWorkArea,
  getBubbleWorkArea,
  getHitRectScreen,
  getHudReservedOffset: () => getSessionHudReservedOffset(),
  getSessionHudBounds: () => getVisibleSessionHudBounds(),
  getTextScale: (workArea) => getTextScaleForBubbleWorkArea(workArea),
  guardAlwaysOnTop,
  reapplyMacVisibility,
  // #640: permission.js re-runs the editing-overlap dodge scan whenever the
  // pendingPermissions list changes (notifyPermissionsChanged), so a bubble
  // that leaves the list mid-edit can't strand the pet faded + click-through.
  syncImeEditingPetDodge: () => topmostRuntime.syncImeEditingPetDodge(),
  isAgentEnabled: (agentId) => _runtimeAgentGate.isAgentEnabled(agentId),
  isAgentPermissionsEnabled: (agentId) =>
    _runtimeAgentGate.isAgentPermissionsEnabled(agentId),
  isAgentSubagentPermissionsEnabled: (agentId) =>
    _runtimeAgentGate.isAgentSubagentPermissionsEnabled(agentId),
  isCodexPermissionInterceptEnabled: () =>
    _runtimeAgentGate.isCodexPermissionInterceptEnabled(),
  // The permission layer consumes one normalized runtime mode. DND,
  // headless, per-agent and bubble gates run before this chokepoint.
  getPermissionAutomationMode: () =>
    _settingsController.get("permissionAutomationMode") || "off",
  getEffectivePermissionAutomationMode: (entry, options) =>
    sessionAutomationCoordinator
      ? sessionAutomationCoordinator.getEffectiveMode(entry, options)
      : (_settingsController.get("permissionAutomationMode") || "off"),
  hasSessionAutomationOverride: (entry) =>
    !!(
      sessionAutomationCoordinator
      && sessionAutomationCoordinator.getRecordForEntry(entry)
    ),
  canOfferSessionTrust: (entry) =>
    !!(sessionAutomationCoordinator && sessionAutomationCoordinator.canOfferSessionTrust(entry)),
  translate: (key) => translate(key),
  canOfferRemoteSessionTrust: (entry, remote) => {
    const client = remote && remote.client;
    return !!(
      sessionAutomationCoordinator
      && sessionAutomationCoordinator.canOfferSessionTrust(entry)
      && client
      && typeof client.supportsSessionAutomation === "function"
      && client.supportsSessionAutomation()
    );
  },
  requestSessionTrust: (entry) =>
    sessionAutomationCoordinator
      ? sessionAutomationCoordinator.requestEntryTrust(entry)
      : Promise.resolve({ status: "unavailable" }),
  requestRemoteSessionTrust: (entry, remote) =>
    sessionAutomationCoordinator
      ? sessionAutomationCoordinator.requestRemoteSessionTrust(entry, remote)
      : Promise.resolve({ status: "unavailable" }),
  cancelSessionTrustCandidate: (entry, options) =>
    !!(sessionAutomationCoordinator
      && sessionAutomationCoordinator.cancelSessionTrustCandidate(entry, options)),
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
  repositionFloatingBubbles: () => repositionFloatingBubbles(),
  repositionUpdateBubble: () => repositionUpdateBubble(),
  // permission.js still calls this legacy-shaped callback after the update
  // bubble has moved; only Orbit needs the second geometry pass here.
  repositionSessionHud: () => repositionQuotaRing(),
  getTelegramApprovalClient: () => getTelegramApprovalClient(),
  getRemoteApprovalClients: () => {
    const client = getFeishuApprovalClient();
    return client && typeof client.isConnected === "function" && client.isConnected()
      ? [{ name: "feishu", client }]
      : [];
  },
  onPermissionResolved: (permEntry, options = {}) => {
    if (!_state || typeof _state.clearPermissionNotification !== "function") return;
    _state.clearPermissionNotification(permEntry && permEntry.sessionId, options);
  },
  // Best-effort, read-only "permission needed" heads-up to Slack. Slack cannot
  // resolve the approval in this build (webhook is one-way), so this only
  // announces — the desktop bubble / other channels still own the decision.
  notifySlackPermission: (payload, options = {}) => {
    const client = getSlackNotifyClient();
    if (client && typeof client.notifyPermissionRequest === "function") {
      try { client.notifyPermissionRequest(payload, options); } catch {}
    }
  },
};
const _perm = initPermission(_permCtx);
permissionPresentationRuntime = _perm;
const { showPermissionBubble, resolvePermissionEntry, sendPermissionResponse, repositionBubbles, permLog, PASSTHROUGH_TOOLS, addPendingPermission, removePendingPermission, isPermissionEntryLive, canAutoResolvePendingPermission, beginSessionTrustConfirmation, endSessionTrustConfirmation, syncPermissionBubbleContent, maybeStartRemoteApproval, clearCodexNotifyBubbles, showCodexUserInputBubble, clearCodexUserInputBubbles, showKimiNotifyBubble, clearKimiNotifyBubbles, syncPermissionShortcuts, replyOpencodeFamilyPermission, dismissOpencodeFamilyPermissionResolvedExternally } = _perm;
const pendingPermissions = _perm.pendingPermissions;
let permDebugLog = null; // set after app.whenReady()
let updateDebugLog = null; // set after app.whenReady()
let sessionDebugLog = null; // set after app.whenReady()
let focusDebugLog = null; // set after app.whenReady()
let recordWindowsProcessChainShadow = () => false;

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
  if (entry.orcaPaneKey) focusEntry.orcaPaneKey = entry.orcaPaneKey;
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
  get bubbleFollowPreference() { return bubbleFollowPreference; },
  get bubbleFixedCorner() { return bubbleFixedCorner; },
  get petHidden() { return petWindowRuntime.isPetHidden(); },
  getBubblePolicy: getRuntimeBubblePolicy,
  getPetWindowBounds,
  getNearestWorkArea,
  getBubbleWorkArea,
  getUpdateBubbleAnchorRect,
  getHitRectScreen,
  getPermissionBubbleBounds: () => _perm.getVisibleBubbleBounds(),
  getSessionHudBounds: () => getVisibleSessionHudBounds(),
  getTextScale: (workArea) => getTextScaleForBubbleWorkArea(workArea),
  guardAlwaysOnTop,
  reapplyMacVisibility,
  repositionQuotaRing: () => repositionQuotaRing(),
  clipboard,
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
  repositionQuotaRing: () => repositionQuotaRing(),
  syncSessionHudVisibility: () => syncSessionHudVisibility(),
  syncUpdateBubbleVisibility: (hiddenOverride) => syncUpdateBubbleVisibility(hiddenOverride),
  hideUpdateBubble: () => hideUpdateBubble(),
  keepOutOfTaskbar,
  showPermissionSurfacesForPet: () => _perm.showPermissionSurfacesForPet(),
  hidePermissionSurfacesForPet: () => _perm.hidePermissionSurfacesForPet(),
});

function repositionFloatingBubbles() {
  return floatingWindowRuntime.repositionFloatingBubbles();
}

function repositionAnchoredFloatingSurfaces() {
  const result = floatingWindowRuntime.repositionAnchoredSurfaces();
  // #640: pet bounds changed — re-evaluate the editing-overlap dodge (a drag
  // can slide the pet over the bubble being typed into; the bubble itself is
  // frozen while editing, and roam is paused, so the pet is the mover here).
  topmostRuntime.syncImeEditingPetDodge();
  return result;
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

// #509: user-selected default idle visual, resolved against the live active
// theme so reads never go stale across theme switches. Returns null when
// unset/invalid — callers keep their existing fallback. The visible repaint
// on a pref change is the refreshIdleVisual router hook's job, further down.
const { resolveIdleVisualChoice } = require("./idle-visual");
function getIdleVisualChoice() {
  return resolveIdleVisualChoice(getActiveTheme(), _settingsController.get("idleVisual"));
}

// Renderer theme config with pre-IPC choices stamped on — the first media load
// should already use the selected idle visual and tint instead of briefly
// showing theme defaults. getRendererConfig() returns a fresh object, safe to
// extend.
function buildRendererThemeConfig(accessorySnapshot = null) {
  const cfg = themeRuntime.getRendererConfig();
  if (cfg) {
    const activeTheme = getActiveTheme();
    const tintSelections = _settingsController.get("petTint");
    const tintId = getPetTintIdForTheme(tintSelections, activeTheme && activeTheme._id);
    const canonical = accessorySnapshot || getPetAccessorySlotsSnapshot(activeTheme);
    cfg.idleDefaultVisual = getIdleVisualChoice();
    cfg.petTintPayload = resolvePetTintPayload(tintId, activeTheme);
    if (canonical) {
      cfg.accessorySlots = {
        themeId: canonical.themeId,
        accessoryGeneration: canonical.accessoryGeneration,
        head: {
          supported: cfg.accessorySupported === true,
          attachments: cfg.accessoryAttachments || null,
          payload: canonical.payloads.head,
        },
        mouth: {
          supported: cfg.mouthAccessorySupported === true,
          attachments: cfg.mouthAccessoryAttachments || null,
          payload: canonical.payloads.mouth,
        },
      };
    }
  }
  return cfg;
}

function deliverRendererThemeConfig() {
  const delivery = prepareCurrentAccessorySlotsDelivery();
  const delivered = sendToRenderer(
    "theme-config",
    buildRendererThemeConfig(delivery.snapshot)
  );
  return !!finalizePetAccessorySlotsDelivery(delivery, delivered);
}

const _stateCtx = {
  get theme() { return getActiveTheme(); },
  get win() { return win; },
  get hitWin() { return hitWin; },
  // Last-known account quota survives app restarts (state-account-quota.js).
  accountQuotaPersistPath: require("./state-account-quota").DEFAULT_PERSIST_PATH,
  get claudeQuotaCollectionEnabled() { return claudeQuotaCollectionEnabled; },
  get kimiQuotaCollectionEnabled() { return kimiQuotaCollectionEnabled; },
  get quotaMergeSources() { return quotaMergeSources; },
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
    _runtimeAgentGate.isAgentPermissionsEnabled(agentId),
  // state.js gates self-issued Notification events (idle / wait-for-input
  // pings) via this reader. Living in updateSession (not at the HTTP
  // boundary) keeps the gate consistent for hook / log-poll / plugin paths.
  isAgentNotificationHookEnabled: (agentId) =>
    _runtimeAgentGate.isAgentNotificationHookEnabled(agentId),
  resolveAgentDisplayName: _resolveAgentDisplayName,
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
    // R1a: best-effort completion notifications. Must never throw or block the
    // broadcast — the companion computes synchronously and fires sends async.
    if (telegramCompanion) {
      try { telegramCompanion.onSnapshot(snapshot); } catch {}
    }
    // Slack completion pings ride the same fanout; the client dedupes internally
    // and fires sends async, so this never throws or blocks the broadcast.
    try { getSlackNotifyClient().onSnapshot(snapshot); } catch {}
    if (discordPresenceBridge) {
      try { discordPresenceBridge.onSnapshot(snapshot); } catch {}
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
    codexWorkingStaleMs,
    detachedIdleStaleMs,
  }),
  getSessionAliases: () => _settingsController.get("sessionAliases"),
  getSessionAutomationRecords: () =>
    sessionAutomationStore ? sessionAutomationStore.list() : [],
  getPermissionAutomationMode: () =>
    _settingsController.get("permissionAutomationMode") || "off",
  onSessionAutomationLifecycleEnd: (payload) => {
    if (sessionAutomationCoordinator) sessionAutomationCoordinator.onSessionLifecycleEnd(payload);
  },
  getIdleVisualChoice,
  isAgentEnabled: (agentId) => _runtimeAgentGate.isAgentEnabled(agentId),
  hasAnyEnabledAgent: () => _runtimeAgentGate.hasAnyEnabledAgent(),
};
const _state = require("./state")(_stateCtx);
displayedVisualProjection = createDisplayedVisualProjection({
  projectActualFile: ({ actualFile, requested }) => {
    const activeTheme = getActiveTheme();
    if (!activeTheme || !collectRequiredAssetFiles(activeTheme).includes(actualFile)) return null;
    return {
      displayState: requested.displayState,
      hitBox: _state.resolveHitBoxForSvg(actualFile),
    };
  },
  onCommit: (visual) => {
    syncDisplayedVisualGeometry();
    try { repositionAnchoredFloatingSurfaces(); } catch {}
    if (visual.source === "reaction") return;
    lastDiscordPresenceVisual = {
      state: visual.displayState,
      svg: visual.file,
      themeId: visual.themeId,
    };
    if (discordPresenceBridge) {
      try {
        discordPresenceBridge.onVisual(
          lastDiscordPresenceVisual.state,
          lastDiscordPresenceVisual.svg,
          lastDiscordPresenceVisual.themeId
        );
      } catch {}
    }
  },
  onRendererUnresponsive: () => {
    if (!win || win.isDestroyed()) return;
    resetDisplayedVisualProjection("renderer-unresponsive", { preserveCommitted: true });
    petWindowRuntime.reloadWindowWebContents(win);
  },
});
const _kimiQuotaCredentialStore = createKimiQuotaCredentialStore({ safeStorage });
const _kimiQuotaRuntime = createKimiQuotaRuntime({
  credentialStore: _kimiQuotaCredentialStore,
  client: createKimiQuotaClient({ appVersion: app.getVersion() }),
  getSettingsSnapshot: () => _settingsController.getSnapshot(),
  setCollectionEnabled: (enabled) => _settingsController.applyCommand(
    "setKimiQuotaCollectionEnabled",
    { enabled }
  ),
  commitLocalKimiQuota: (quota) => _state.commitLocalKimiQuota(quota),
  clearLocalKimiQuota: () => _state.clearLocalKimiQuota(),
});
_settingsController.subscribeKey("kimiQuotaCollectionEnabled", (enabled) => {
  void _kimiQuotaRuntime.onCollectionPreferenceChanged(enabled).catch((error) => {
    console.warn("Clawd: Kimi quota preference reconciliation failed:", error && error.message);
  });
});
_settingsController.subscribeKey("agents", (_agents, snapshot) => {
  if (!_runtimeAgentGate.isAgentEnabled("kimi-cli")) {
    _kimiQuotaRuntime.invalidateRequests();
  }
});
const { setState, applyState, updateSession, resolveDisplayState, getSvgOverride,
        enableDoNotDisturb, disableDoNotDisturb, startStaleCleanup, stopStaleCleanup,
        startWakePoll, stopWakePoll, detectRunningAgentProcesses,
        startStartupRecovery: _startStartupRecovery } = _state;
const sessions = _state.sessions;

async function showSessionAutomationWarning(entry) {
  const parent = selectSessionAutomationDialogParent({
    entry,
    petWindow: win,
  });
  return permissionAutomationConfirmationRuntime.confirmPermissionAutomation({
    parent,
    lang: _settingsController.get("lang") || lang || "en",
    title: translate("sessionAutomationConfirmTitle"),
    message: translate("sessionAutomationConfirmMessage"),
    detail: translate("sessionAutomationConfirmDetail"),
    checkboxLabel: translate("permissionAutomationAutoToolsDontShowAgain"),
    confirmLabel: translate("sessionAutomationConfirmEnable"),
    cancelLabel: translate("permissionAutomationCancel"),
  });
}

sessionAutomationStore = createSessionAutomationStore({
  onChange: (changes) => {
    try { _state.emitSessionSnapshot({ force: true }); } catch {}
    for (const client of [telegramNativeRunner, feishuApprovalClient]) {
      if (client && typeof client.handleSessionAutomationChanges === "function") {
        try { client.handleSessionAutomationChanges(changes); } catch {}
      }
    }
  },
});
sessionAutomationCoordinator = createSessionAutomationCoordinator({
  store: sessionAutomationStore,
  getSession: (sessionId) => sessions.get(sessionId) || null,
  listPending: () => pendingPermissions,
  getGlobalMode: () => _settingsController.get("permissionAutomationMode") || "off",
  canAutoResolvePendingPermission,
  resolvePermissionEntry,
  beginConfirmation: beginSessionTrustConfirmation,
  endConfirmation: endSessionTrustConfirmation,
  restoreBubble: syncPermissionBubbleContent,
  isWarningDismissed: () =>
    _settingsController.get("permissionAutomationAutoToolsWarningDismissed") === true,
  showWarning: showSessionAutomationWarning,
  rememberWarning: () =>
    _settingsController.applyUpdate("permissionAutomationAutoToolsWarningDismissed", true),
  translate: (key, fallback) => translate(key) || fallback,
});

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
  get lowPowerIdleMode() { return lowPowerIdleMode; },
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
  isVisualGenerationCurrent,
  setState,
  applyState,
  getIdleVisualChoice,
  getEffectiveAccessoryIds: getEffectivePetAccessoryIds,
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
  if (!session || (!session.sourcePid && !session.orcaPaneKey)) return false;
  return focusTerminalWindow({
    sourcePid: session.sourcePid,
    wtHwnd: session.wtHwnd,
    cwd: session.cwd,
    editor: session.editor,
    pidChain: session.pidChain,
    tmuxSocket: session.tmuxSocket,
    tmuxClient: session.tmuxClient,
    orcaPaneKey: session.orcaPaneKey,
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

const openDashboardSessionFolder = createSessionFolderOpener({
  getSession: (sessionId) => sessions.get(sessionId),
  openPath: (cwd) => shell.openPath(cwd),
});

const _dashboard = require("./dashboard")({
  get lang() { return lang; },
  t: (key) => translate(key),
  getSessionSnapshot: () => _state.buildSessionSnapshot(),
  getI18n: () => getDashboardI18nPayload(),
  getPetWindowBounds,
  getNearestWorkArea,
  getSettingsWindow: () => settingsWindowRuntime.getWindow(),
  getTextScale: (bounds) => effectiveTextScaleForKey(
    getDisplayKeyForBounds(bounds)
    || getWindowDisplayKey(_dashboard ? _dashboard.getWindow() : null)
    || getPetDisplayKey()
  ),
  getSavedBounds: () => _settingsController.get("dashboardWindowBounds"),
  onSaveBounds: (bounds) => _settingsController.applyUpdate("dashboardWindowBounds", bounds),
  iconPath: settingsWindowRuntime.getIconPath(),
});
showDashboard = _dashboard.showDashboard;
broadcastDashboardSessionSnapshot = _dashboard.broadcastSessionSnapshot;
sendDashboardI18n = _dashboard.sendI18n;

// ── First-run onboarding tutorial ──
// Buckets the installable agents for the tutorial's step 2. We call the
// detector with skipDefaultIntegrations:false so the default integrations are
// present in the report; the bucketer still exempts them from cleanup (#895 —
// a missing ~/.codex is not evidence that a Codex hook is stale), so this flag
// only affects the active/install buckets.
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
    getAgentIconUrl,
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

// Shared with session-hud.js on purpose: the Settings "show beside the pet"
// list has to be built from the SAME provider table and draw rule that sizes
// the cluster window, or the list can offer a provider that never draws.
const _ringGeom = require("./quota-ring-geometry");

const _sessionHud = require("./session-hud")({
  get win() { return win; },
  get petHidden() { return petWindowRuntime.isPetHidden(); },
  get sessionHudEnabled() { return sessionHudEnabled; },
  get sessionHudShowStateLabels() { return sessionHudShowStateLabels; },
  get sessionHudShowElapsed() { return sessionHudShowElapsed; },
  get sessionHudShowContextUsage() { return sessionHudShowContextUsage; },
  get sessionHudShowQuota() { return sessionHudShowQuota; },
  get quotaRingDisplayMode() { return quotaRingDisplayMode; },
  get quotaRingHiddenProviders() { return quotaRingHiddenProviders; },
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
  getPermissionBubbleBounds: () => _perm.getVisibleBubbleBounds(),
  getUpdateBubbleWindow: () => _updateBubble.getBubbleWindow(),
  guardAlwaysOnTop,
  reapplyMacVisibility,
  onReservedOffsetChange: () => repositionFloatingBubbles(),
});
repositionSessionHud = _sessionHud.repositionSessionHud;
repositionQuotaRing = _sessionHud.repositionQuotaRing;
syncSessionHudVisibility = _sessionHud.syncSessionHud;
broadcastSessionHudSnapshot = _sessionHud.broadcastSessionSnapshot;
sendSessionHudI18n = _sessionHud.sendI18n;
getSessionHudReservedOffset = _sessionHud.getHudReservedOffset;
getSessionHudWindow = _sessionHud.getWindow;
getQuotaRingWindow = _sessionHud.getQuotaRingWindow;

agentRuntime = createAgentRuntimeMain({
  getServer: () => _server,
  getStateRuntime: () => _state,
  getPermissionRuntime: () => _perm,
  isAgentEnabled: (agentId) => _runtimeAgentGate.isAgentEnabled(agentId),
  updateSession: (sessionId, state, event, opts) => updateSession(sessionId, state, event, opts),
  debugLog: (msg) => sessionLog(msg),
  captureGhosttyTerminalId,
  clearCodexNotifyBubbles: (...args) => clearCodexNotifyBubbles(...args),
  showCodexUserInputBubble: (...args) => showCodexUserInputBubble(...args),
  clearCodexUserInputBubbles: (...args) => clearCodexUserInputBubbles(...args),
});

// ── HTTP server — delegated to src/server.js ──
const _serverCtx = {
  get manageClaudeHooksAutomatically() { return manageClaudeHooksAutomatically; },
  get autoStartWithClaude() { return autoStartWithClaude; },
  get claudeQuotaCollectionEnabled() { return claudeQuotaCollectionEnabled; },
  get doNotDisturb() { return doNotDisturb; },
  shouldDropForDnd: () => _state.shouldDropForDnd ? _state.shouldDropForDnd() : doNotDisturb,
  get hideBubbles() { return getAllBubblesHidden(); },
  getBubblePolicy: getRuntimeBubblePolicy,
  get pendingPermissions() { return pendingPermissions; },
  get PASSTHROUGH_TOOLS() { return PASSTHROUGH_TOOLS; },
  get STATE_SVGS() { return _state.STATE_SVGS; },
  get sessions() { return sessions; },
  getCustomAgentIds: () => (_settingsController.get("customApplications") || [])
    .map((application) => application && application.id)
    .filter(Boolean),
  onHookEventRecorded: (event) => {
    if (!event || event.route !== "state" || event.outcome !== "accepted") return;
    const registered = (_settingsController.get("customApplications") || [])
      .some((application) => application && application.id === event.agentId);
    if (!registered) return;
    broadcastSettingsWindow("settings:agent-activity", {
      agentId: event.agentId,
      timestamp: event.timestamp,
      eventType: event.eventType,
    });
  },
  // #627 residual: synchronous server-side wt_hwnd sample for UserPromptSubmit
  // (src/server-route-state.js). Initialized once above; never re-created per
  // request.
  captureForegroundWindowsTerminal: _captureForegroundWindowsTerminal,
  debugLog: (msg) => sessionLog(msg),
  recordWindowsProcessChainShadow: (record) => recordWindowsProcessChainShadow(record),
  isAgentEnabled: (agentId) => _runtimeAgentGate.isAgentEnabled(agentId),
  shouldSyncAgentIntegration: (agentId) =>
    _runtimeAgentGate.shouldSyncAgentIntegration(agentId),
  getAgentIntegrationOptions: _getAgentIntegrationOptions,
  isAgentPermissionsEnabled: (agentId) => _runtimeAgentGate.isAgentPermissionsEnabled(agentId),
  isAgentSubagentPermissionsEnabled: (agentId) => _runtimeAgentGate.isAgentSubagentPermissionsEnabled(agentId),
  isCodexNativeNotificationSoundEnabled: () => _runtimeAgentGate.isCodexNativeNotificationSoundEnabled(),
  isCodexPermissionInterceptEnabled: () => _runtimeAgentGate.isCodexPermissionInterceptEnabled(),
  codexSubagentClassifier: agentRuntime.getCodexSubagentClassifier(),
  setState,
  updateSession: agentRuntime.updateSessionFromServer,
  updateSessionMetadata: (sessionId, opts) => _state.updateSessionMetadata(sessionId, opts),
  clearClaudeStatuslineAuthority: (profileId) => _state.clearClaudeStatuslineAuthority(profileId),
  clearLocalClaudeQuota: () => _state.clearLocalClaudeQuota(),
  updateAccountQuota: (host, quotas) => _state.updateAccountQuota(host, quotas),
  resolvePermissionEntry,
  sendPermissionResponse,
  addPendingPermission,
  removePendingPermission,
  isPermissionEntryLive,
  canAutoResolvePendingPermission,
  maybeAutoResolveSessionPermission: (entry, options) =>
    !!(sessionAutomationCoordinator
      && sessionAutomationCoordinator.resolveIfAllowed(entry, options)),
  showPermissionBubble,
  showCodexUserInputBubble,
  clearCodexUserInputBubbles,
  handleTestResult: (result, context) => handleTestResult(result, context),
  maybeStartRemoteApproval,
  replyOpencodeFamilyPermission,
  dismissOpencodeFamilyPermissionResolvedExternally,
  syncPermissionShortcuts,
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
  rotatedAppend(sessionDebugLog, `[${formatLocalTimestamp()}] ${msg}\n`);
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
  return null;
}

// Completion notifications are native-only.
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

function getFeishuApprovalClient() {
  return feishuApprovalClient && typeof feishuApprovalClient.isConnected === "function" && feishuApprovalClient.isConnected()
    ? feishuApprovalClient
    : null;
}

function getConfiguredFeishuApprovalClient() {
  return feishuApprovalClient && typeof feishuApprovalClient.isEnabled === "function" && feishuApprovalClient.isEnabled()
    ? feishuApprovalClient
    : null;
}

function telegramApprovalLog(level, message, meta = {}) {
  const diagnosticMeta = sanitizeTelegramApprovalLogMeta(meta);
  const parts = [`telegram approval ${level}: ${message}`];
  if (meta && meta.text) parts.push(String(meta.text).trim());
  if (meta && meta.error) parts.push(String(meta.error).trim());
  for (const key of ["errorClass", "errorCode", "delayMs", "id", "sessionId", "messageId", "status", "reason", "fallbackReason"]) {
    const value = meta && meta[key];
    if (value !== undefined && value !== null && value !== "") {
      parts.push(`${key}=${String(value).trim()}`);
    }
  }
  for (const key of ["outcome", "mode", "proxy"]) {
    const value = diagnosticMeta[key];
    if (value) parts.push(`${key}=${value}`);
  }
  permLog(parts.filter(Boolean).join(" | "));
}

function feishuApprovalLog(level, message, meta = {}) {
  const parts = [`feishu approval ${level}: ${message}`];
  if (meta && meta.text) parts.push(String(meta.text).trim());
  if (meta && meta.error) parts.push(String(meta.error).trim());
  for (const key of ["requestId", "messageId", "decision", "matched", "code", "stage", "httpStatus", "businessCode", "networkCode"]) {
    const value = meta && meta[key];
    if (value !== undefined && value !== null && value !== "") {
      parts.push(`${key}=${String(value).trim()}`);
    }
  }
  const config = getFeishuApprovalPrefs();
  const secrets = getFeishuApprovalSecrets();
  const redactionSecrets = feishuApprovalSettings.redactionSecretsForFeishuApproval(config, secrets);
  for (const secret of redactionSecrets) {
    if (!secret) continue;
    for (let i = 0; i < parts.length; i += 1) {
      parts[i] = String(parts[i]).split(String(secret)).join("<redacted>");
    }
  }
  permLog(parts.filter(Boolean).join(" | "));
}

function getTelegramApprovalPrefs() {
  return telegramApprovalSettings.normalizeTelegramApproval(_settingsController.get("tgApproval"));
}

function getTelegramSessionAutomationRoute() {
  const config = getTelegramApprovalPrefs();
  const token = getTelegramApprovalTokenStatus();
  const migration = getTelegramMigrationPrefs();
  const key = config && config.targetSessionKey;
  const match = typeof key === "string" ? key.match(/^telegram:(-?\d+)/) : null;
  return {
    transport: typeof migration.transport === "string" ? migration.transport : "off",
    allowedUserId: (config && config.allowedTgUserId) || "",
    chatId: match ? match[1] : "",
    tokenStored: !!(token && token.tokenStored),
    tokenFileMtimeMs: (token && token.tokenFileMtimeMs) || 0,
    tokenFileDigest: telegramTokenFileDigest(getTelegramApprovalPaths().tokenEnvFilePath),
  };
}

function syncTelegramSessionAutomationRoute(route = getTelegramSessionAutomationRoute()) {
  if (
    telegramNativeRunner
    && typeof telegramNativeRunner.syncSessionAutomationRoute === "function"
  ) {
    telegramNativeRunner.syncSessionAutomationRoute(route);
  }
}

function getFeishuApprovalPrefs() {
  return feishuApprovalSettings.normalizeFeishuApproval(_settingsController.get("feishuApproval"));
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

function buildTelegramApprovalIdentitySignature(config) {
  const normalized = telegramApprovalSettings.normalizeTelegramApproval(config);
  return JSON.stringify({
    allowedTgUserId: normalized.allowedTgUserId,
    targetSessionKey: normalized.targetSessionKey,
  });
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
  suppressTelegramMigrationReconcile += 1;
  try {
    await applySettingsUpdateOrThrow("tgApproval", { ...current, enabled }, "tgApproval");
  } finally {
    suppressTelegramMigrationReconcile = Math.max(0, suppressTelegramMigrationReconcile - 1);
  }
}

async function persistTelegramMigrationPatch(patch) {
  const cur = getTelegramMigrationPrefs();
  // Disable the retired v0.8 flag before publishing the native/off transport
  // decision. If either write fails, the controller never exposes the target
  // state in memory; this ordering also prevents a partial write from reviving
  // legacy behavior in an older build.
  if (patch && (patch.transport === "native" || patch.transport === "off")) {
    await setTelegramApprovalEnabledForMigration(false);
  }
  await applySettingsUpdateOrThrow("tgMigration", { ...cur, ...patch }, "tgMigration");
}

// Canonical paths only — no env-var override. The Settings "Save token" button,
// native token store, and tokenStatus all share this single location so a
// malicious or accidental env override cannot redirect the writer.
function getTelegramApprovalPaths() {
  const userDataDir = app.getPath("userData");
  return {
    userDataDir,
    tokenEnvFilePath: telegramApprovalSettings.defaultTokenEnvFilePath(userDataDir),
  };
}

function getFeishuApprovalPaths() {
  const userDataDir = app.getPath("userData");
  return {
    userDataDir,
    secretsEnvFilePath: feishuApprovalSettings.defaultSecretsEnvFilePath(userDataDir),
  };
}

function getFeishuApprovalSecrets() {
  const paths = getFeishuApprovalPaths();
  return feishuApprovalSettings.readSecretsEnvFile({
    fs,
    filePath: paths.secretsEnvFilePath,
  });
}

function getFeishuApprovalSecretInfo() {
  const paths = getFeishuApprovalPaths();
  return feishuApprovalSettings.readMaskedSecrets({
    fs,
    filePath: paths.secretsEnvFilePath,
  });
}

// Anything that changes the live connection must be in here. `platform` in
// particular: switching Feishu <-> Lark has to tear the client down so the WS
// reconnects to the new host and the cached REST client (and its token cache,
// which is per-domain) is dropped with it. `lang` is deliberately absent — the
// translator reads it dynamically, so a language switch must not bounce the
// long connection.
function buildFeishuApprovalBindingSignatureFields(
  config,
  secrets,
  revision = feishuApprovalSecretsRevision,
) {
  return {
    enabled: config.enabled === true,
    platform: config.platform,
    credentialPlatform: secrets.credentialPlatform,
    idType: config.idType,
    approverId: config.approverId,
    approverSource: config.approverSource,
    approverBoundPlatform: config.approverBoundPlatform,
    approverBoundAppId: config.approverBoundAppId,
    appId: secrets.appId,
    secretsRevision: revision,
  };
}

function buildFeishuApprovalSignature(config, paths, secrets) {
  return JSON.stringify({
    ...buildFeishuApprovalBindingSignatureFields(config, secrets),
    secretsEnvFilePath: paths.secretsEnvFilePath,
    connectionTimeoutSeconds: config.connectionTimeoutSeconds,
  });
}

function buildFeishuSessionAutomationRouteSignature(config, secrets, revision = feishuApprovalSecretsRevision) {
  return JSON.stringify(buildFeishuApprovalBindingSignatureFields(config, secrets, revision));
}

function prepareFeishuSessionAutomationRouteChange(nextRouteSignature) {
  const client = feishuApprovalClient;
  if (
    !client
    || !feishuSessionAutomationRouteSignature
    || nextRouteSignature === feishuSessionAutomationRouteSignature
  ) {
    return false;
  }
  if (typeof client.markSessionAutomationRouteStale === "function") {
    client.markSessionAutomationRouteStale();
  }
  if (sessionAutomationCoordinator) {
    sessionAutomationCoordinator.onRemoteClientRouteChange(client);
  }
  return true;
}

function getFeishuApprovalStatus() {
  const config = getFeishuApprovalPrefs();
  const secrets = getFeishuApprovalSecrets();
  const ready = feishuApprovalSettings.readiness(config, secrets);
  const credentialEvaluation = feishuApprovalSettings.evaluateFeishuApprovalConfiguration(
    config,
    secrets,
    {
      requireEnabled: false,
      requireApprover: false,
    },
  );
  const setupEvaluation = feishuApprovalSettings.evaluateFeishuApprovalConfiguration(
    config,
    secrets,
    {
      requireEnabled: false,
      requireApprover: true,
    },
  );
  const clientStatus = feishuApprovalClient && typeof feishuApprovalClient.getStatus === "function"
    ? feishuApprovalClient.getStatus()
    : { status: "stopped" };
  return {
    ...clientStatus,
    enabled: config.enabled === true,
    // The platform the runtime actually resolved, so the settings page renders
    // the right brand/guide and a mismatch is visible while troubleshooting.
    platform: config.platform,
    configured: ready.ready === true,
    reason: ready.reason || "",
    message: clientStatus.message || ready.message || "",
    credentialReady: credentialEvaluation.ok === true,
    credentialReason: credentialEvaluation.ok ? "" : credentialEvaluation.code || "invalid-config",
    configurationReady: setupEvaluation.ok === true,
    setupReason: setupEvaluation.ok ? "" : setupEvaluation.code || "invalid-config",
    connectionTimeoutSeconds: config.connectionTimeoutSeconds,
    // Two different questions, deliberately two fields:
    //   secretsStored     — is ANY secret on disk? (drives render gating only)
    //   secretsConfigured — are the two REQUIRED ones both present?
    // Conflating them lets a half-written env file (App ID but no App Secret,
    // or just a Verification Token) render as a complete setup.
    secretsStored: !!(secrets.appId || secrets.appSecret || secrets.verificationToken || secrets.encryptKey),
    secretsConfigured: !!(secrets.appId && secrets.appSecret),
  };
}

function broadcastFeishuApprovalStatus() {
  broadcastSettingsWindow("remoteApproval:status-changed", {
    channel: "feishu",
    status: getFeishuApprovalStatus(),
  });
}

function writeFeishuApprovalSecrets(secrets) {
  const paths = getFeishuApprovalPaths();
  const nextRouteSignature = buildFeishuSessionAutomationRouteSignature(
    getFeishuApprovalPrefs(),
    secrets && typeof secrets === "object" ? secrets : {},
    feishuApprovalSecretsRevision + 1
  );
  const result = feishuApprovalSettings.writeSecretsEnvFile({
    fs,
    path,
    filePath: paths.secretsEnvFilePath,
    secrets,
    platform: process.platform,
  });
  if (result && result.status === "ok") {
    prepareFeishuSessionAutomationRouteChange(nextRouteSignature);
    feishuApprovalSecretsRevision += 1;
    queueFeishuApprovalSync("secrets");
    if (feishuApprovalMigrationNudge) {
      void feishuApprovalMigrationNudge.sync({ allowNotify: false });
    }
  }
  return result;
}

async function startFeishuApprovalClient(persisted = null) {
  const config = persisted && persisted.config
    ? persisted.config
    : getFeishuApprovalPrefs();
  const paths = getFeishuApprovalPaths();
  const secrets = persisted && persisted.secrets
    ? persisted.secrets
    : getFeishuApprovalSecrets();
  const ready = feishuApprovalSettings.readiness(config, secrets);
  if (!ready.ready) {
    if (feishuApprovalClient) stopFeishuApprovalClient();
    if (ready.reason !== "disabled") {
      feishuApprovalLog("info", ready.reason || "not configured", {
        error: ready.message || "",
      });
    }
    return false;
  }
  const signature = buildFeishuApprovalSignature(config, paths, secrets);
  const routeSignature = buildFeishuSessionAutomationRouteSignature(config, secrets);
  if (feishuApprovalClient && feishuApprovalConfigSignature === signature) {
    try {
      await feishuApprovalClient.start();
      return true;
    } catch (err) {
      feishuApprovalLog("warn", "start failed", classifyFeishuSdkError(err, "runtime-start"));
      return false;
    }
  }
  const handoffCardWork = feishuApprovalClient
    && feishuSessionAutomationRouteSignature === routeSignature
    ? feishuApprovalClient.sessionAutomationCardWork
    : null;
  prepareFeishuSessionAutomationRouteChange(routeSignature);
  stopFeishuApprovalClient({ routeChanging: false, preserveRouteSignature: !!handoffCardWork });
  feishuApprovalClient = new FeishuApprovalClient({
    appId: secrets.appId,
    appSecret: secrets.appSecret,
    verificationToken: secrets.verificationToken,
    encryptKey: secrets.encryptKey,
    approverId: config.approverId,
    idType: config.idType,
    platform: config.platform,
    connectionTimeoutSeconds: config.connectionTimeoutSeconds,
    getLang: () => _settingsController.get("lang") || lang || "en",
    log: feishuApprovalLog,
    onStatusChange: () => broadcastFeishuApprovalStatus(),
    sessionAutomationCardWork: handoffCardWork,
    onSessionGrantRevoke: (grantId) =>
      sessionAutomationCoordinator
        ? sessionAutomationCoordinator.revokeRemoteGrant({ grantId })
        : { status: "stale" },
  });
  feishuApprovalConfigSignature = signature;
  feishuSessionAutomationRouteSignature = routeSignature;
  try {
    await feishuApprovalClient.start();
    feishuApprovalLog("info", "starting");
    return true;
  } catch (err) {
    feishuApprovalLog("warn", "start failed", classifyFeishuSdkError(err, "runtime-start"));
    return false;
  }
}

function stopFeishuApprovalClient(options = {}) {
  const client = feishuApprovalClient;
  if (options.routeChanging !== false) {
    prepareFeishuSessionAutomationRouteChange("");
  }
  feishuApprovalClient = null;
  feishuApprovalConfigSignature = "";
  if (options.preserveRouteSignature !== true) {
    feishuSessionAutomationRouteSignature = "";
  }
  if (client && typeof client.close === "function") {
    try {
      const closeResult = client.close();
      if (closeResult && typeof closeResult.then === "function") {
        const drain = Promise.resolve(closeResult);
        feishuApprovalCloseDrains.add(drain);
        void drain.then(
          () => feishuApprovalCloseDrains.delete(drain),
          () => feishuApprovalCloseDrains.delete(drain)
        );
      }
      return closeResult;
    } catch (err) {
      feishuApprovalLog("warn", "stop failed", classifyFeishuSdkError(err, "runtime-stop"));
    }
  }
}

function settleDrainWithin(drain, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(finish, timeoutMs);
    Promise.resolve(drain).then(finish, finish);
  });
}

function drainRemoteSshAndFeishuBeforeQuit() {
  const drains = [];
  try {
    settingsIpcRuntime.dispose();
  } catch (err) {
    console.error("settings IPC shutdown failed:", err && err.message);
  }
  if (_remoteSshRuntime && typeof _remoteSshRuntime.shutdown === "function") {
    drains.push(
      Promise.resolve(_remoteSshRuntime.shutdown({ timeoutMs: 5000 }))
        .catch((err) => console.error("remote-ssh shutdown drain failed:", err && err.message))
    );
  }
  stopFeishuApprovalClient();
  drains.push(...Array.from(
    feishuApprovalCloseDrains,
    (drain) => settleDrainWithin(drain, 5000),
  ));
  return Promise.allSettled(drains);
}

async function syncFeishuApproval(reason = "settings", persisted = null) {
  if (isQuitting) {
    stopFeishuApprovalClient();
    return false;
  }
  const config = persisted && persisted.config
    ? persisted.config
    : getFeishuApprovalPrefs();
  const secrets = persisted && persisted.secrets
    ? persisted.secrets
    : getFeishuApprovalSecrets();
  const ready = feishuApprovalSettings.readiness(config, secrets);
  if (!ready.ready) {
    stopFeishuApprovalClient();
    return false;
  }
  const started = await startFeishuApprovalClient(persisted);
  if (started) feishuApprovalLog("debug", `sync ${reason}`);
  return started;
}

function queueFeishuApprovalSync(reason, persisted = null) {
  feishuApprovalSyncPromise = feishuApprovalSyncPromise
    .catch(() => {})
    .then(() => syncFeishuApproval(reason, persisted));
  return feishuApprovalSyncPromise;
}

// Brand-neutral: this channel now serves Feishu and Lark, and `message` is the
// untranslated fallback shown when the renderer has no mapping for `code`.
// Naming one brand here would tell half the users their working setup is wrong.
function feishuApprovalUnavailableMessage(status) {
  if (status && status.message) return status.message;
  if (status && status.reason === "disabled") return "Remote approval is disabled";
  if (status && status.reason === "missing-secret") return "App ID and App Secret are not configured";
  if (status && status.reason === "invalid-config") return "Remote approval config is incomplete";
  return "Remote approval client is not running";
}

// The `code` field lets the renderer map failures to localized, actionable
// toasts; `message` stays as the untranslated fallback.
function feishuApprovalUnavailableResult(status) {
  return {
    status: "error",
    code: (status && status.reason) || "not-running",
    message: feishuApprovalUnavailableMessage(status),
  };
}

async function sendFeishuApprovalTest(persisted = null) {
  const persistedReady = persisted && persisted.config && persisted.secrets
    ? feishuApprovalSettings.readiness(persisted.config, persisted.secrets)
    : null;
  const beforeStatus = persistedReady
    ? {
      configured: persistedReady.ready === true,
      reason: persistedReady.reason || "",
      message: persistedReady.message || "",
    }
    : getFeishuApprovalStatus();
  if (beforeStatus.configured !== true) {
    return feishuApprovalUnavailableResult(beforeStatus);
  }
  await queueFeishuApprovalSync("test", persisted);
  const client = getConfiguredFeishuApprovalClient();
  if (!client || typeof client.requestApproval !== "function") {
    return feishuApprovalUnavailableResult(persistedReady ? beforeStatus : getFeishuApprovalStatus());
  }
  if (typeof client.waitUntilConnected === "function") {
    const config = persisted && persisted.config
      ? persisted.config
      : getFeishuApprovalPrefs();
    const timeoutMs = Math.max(1, Number(config.connectionTimeoutSeconds) || 15) * 1000;
    const connected = await client.waitUntilConnected(timeoutMs);
    if (!connected) {
      return {
        ...feishuApprovalUnavailableResult(persistedReady ? beforeStatus : getFeishuApprovalStatus()),
        code: "not-connected",
      };
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60 * 1000);
  try {
    // Title/detail go through the same dictionary the client uses for the
    // buttons, so the test card can no longer mix an English heading with
    // Chinese buttons.
    const decision = await client.requestApproval({
      title: translate("feishuCardTestTitle"),
      detail: translate("feishuCardTestDetail"),
    }, {
      signal: controller.signal,
      rejectOnSendError: true,
      abortOutcome: { decision: "no-decision" },
    });
    if (decision === "allow" || decision === "deny") {
      return { status: "ok", decision };
    }
    return { status: "error", code: "no-button-response", message: "Test card did not receive a button response" };
  } catch (err) {
    feishuApprovalLog("warn", "test card send failed", classifyFeishuSdkError(err, "send-card"));
    return { status: "error", code: "card-send-failed" };
  } finally {
    clearTimeout(timer);
  }
}

// --- Slack notifications (one-way) -----------------------------------------
// Webhook / chat.postMessage are stateless HTTP, so there is no client to
// restart on config change: the singleton reads current prefs+secrets lazily on
// each send, and writing secrets just changes what the next read sees.
function slackNotifyLog(level, message, meta = {}) {
  const parts = [`slack notify ${level}: ${message}`];
  if (meta && meta.errorClass) parts.push(`errorClass=${String(meta.errorClass).trim()}`);
  if (meta && meta.error) parts.push(String(meta.error).trim());
  if (meta && meta.id) parts.push(`id=${String(meta.id).trim()}`);
  const config = getSlackNotifyPrefs();
  const secrets = getSlackNotifySecrets();
  const redactionSecrets = slackNotifySettings.redactionSecretsForSlackNotify(config, secrets);
  for (const secret of redactionSecrets) {
    if (!secret) continue;
    for (let i = 0; i < parts.length; i += 1) {
      parts[i] = String(parts[i]).split(String(secret)).join("<redacted>");
    }
  }
  permLog(parts.filter(Boolean).join(" | "));
}

function getSlackNotifyPrefs() {
  return slackNotifySettings.normalizeSlackNotify(_settingsController.get("slackNotify"));
}

// Canonical path only — no env-var override, mirroring the Feishu/Telegram
// secret writers so a stray env var cannot redirect where the webhook lands.
function getSlackNotifyPaths() {
  const userDataDir = app.getPath("userData");
  return {
    userDataDir,
    secretsEnvFilePath: slackNotifySettings.defaultSecretsEnvFilePath(userDataDir),
  };
}

function getSlackNotifySecrets() {
  const paths = getSlackNotifyPaths();
  return slackNotifySettings.readSecretsEnvFile({ fs, filePath: paths.secretsEnvFilePath });
}

function getSlackNotifySecretInfo() {
  const paths = getSlackNotifyPaths();
  return slackNotifySettings.readMaskedSecrets({ fs, filePath: paths.secretsEnvFilePath });
}

function getSlackNotifyStatus() {
  const config = getSlackNotifyPrefs();
  const secrets = getSlackNotifySecrets();
  const ready = slackNotifySettings.readiness(config, secrets);
  // The UI needs these four apart, not collapsed: a stored-but-unusable
  // credential, a usable one with sending switched off, and a fully live
  // channel are three different things to say to the user.
  const state = slackNotifySettings.describeTransport(config, secrets);
  return {
    credentialsPresent: state.credentialsPresent,
    transportConfigured: !!state.transport,
    transportReason: state.reason || "",
    stored: state.stored,
    enabled: config.enabled === true,
    // `configured` remains as a compatibility alias, but means transport
    // readiness rather than the master switch. `ready` is the live state.
    configured: !!state.transport,
    ready: ready.ready === true,
    reason: ready.ready ? "ready" : (ready.reason || ""),
    message: ready.message || "",
    // From describeTransport, not readiness: readiness reports no transport
    // whenever sending is switched off, which would contradict
    // transportConfigured above and leave the card unable to name the
    // credential it is about to use.
    transport: state.transport,
    notifyOnDone: config.notifyOnDone === true,
    notifyOnError: config.notifyOnError === true,
    notifyOnPermission: config.notifyOnPermission === true,
    outputMode: config.outputMode,
    secretsStored: !!(secrets.webhookUrl || secrets.botToken),
    webhookConfigured: !!secrets.webhookUrl,
    botTokenConfigured: !!secrets.botToken,
  };
}

function broadcastSlackNotifyStatus() {
  broadcastSettingsWindow("remoteApproval:status-changed", {
    channel: "slack",
    status: getSlackNotifyStatus(),
  });
}

function writeSlackNotifySecrets(secrets) {
  const paths = getSlackNotifyPaths();
  const result = slackNotifySettings.writeSecretsEnvFile({
    fs,
    path,
    filePath: paths.secretsEnvFilePath,
    secrets,
    platform: process.platform,
  });
  if (result && result.status === "ok") {
    slackNotifyConfigRevision += 1;
    broadcastSlackNotifyStatus();
  }
  return result;
}

function getSlackNotifyClient() {
  if (!slackNotifyClient) {
    slackNotifyClient = createSlackNotifyClient({
      getConfig: () => getSlackNotifyPrefs(),
      getSecrets: () => getSlackNotifySecrets(),
      getConfigRevision: () => slackNotifyConfigRevision,
      getLang: () => _settingsController.get("lang") || lang || "en",
      log: slackNotifyLog,
    });
  }
  return slackNotifyClient;
}

async function sendSlackNotifyTest() {
  const client = getSlackNotifyClient();
  if (!client || typeof client.sendTest !== "function") {
    return { status: "error", code: "not-running", message: "Slack notifier is not available" };
  }
  try {
    return await client.sendTest();
  } catch (err) {
    return { status: "error", code: "threw", message: err && err.message ? err.message : String(err) };
  }
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

function getTelegramApprovalStatus() {
  const config = getTelegramApprovalPrefs();
  const token = getTelegramApprovalTokenStatus();
  const migrationSnapshot = _telegramMigrationController && typeof _telegramMigrationController.getSnapshot === "function"
    ? _telegramMigrationController.getSnapshot()
    : null;
  const nativePolling = telegramNativeRunner
    && typeof telegramNativeRunner.isPolling === "function"
    && telegramNativeRunner.isPolling();
  return buildTelegramApprovalStatus({
    config,
    token,
    migrationSnapshot,
    nativePolling,
  });
}

function getPendingTelegramApprovalCount() {
  return pendingPermissions.filter((entry) => entry && !isPassiveNotifyEntry(entry)).length;
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
  const migrationSnapshot = _telegramMigrationController && typeof _telegramMigrationController.getSnapshot === "function"
    ? _telegramMigrationController.getSnapshot()
    : null;
  const nativeRunnerStatus = getTelegramNativeRunnerStatus();
  const nativePolling = nativeRunnerStatus && nativeRunnerStatus.polling === true;
  const approvalStatus = buildTelegramApprovalStatus({
    config,
    token,
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

function telegramTokenFileDigest(filePath) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return "";
  }
}

function writeTelegramApprovalToken(token) {
  const paths = getTelegramApprovalPaths();
  const beforeDigest = telegramTokenFileDigest(paths.tokenEnvFilePath);
  // Tighten active grants before mutating the credential. The temporary route
  // also invalidates trust cards issued against the old token even if the
  // replacement ultimately fails and leaves identical file metadata behind.
  syncTelegramSessionAutomationRoute({
    ...getTelegramSessionAutomationRoute(),
    credentialWritePending: true,
  });
  let result;
  try {
    result = telegramApprovalSettings.writeTokenEnvFile({
      fs,
      path,
      filePath: paths.tokenEnvFilePath,
      token,
      platform: process.platform,
    });
  } finally {
    syncTelegramSessionAutomationRoute();
  }
  if (result && result.status === "ok") {
    const identityChanged = beforeDigest !== telegramTokenFileDigest(paths.tokenEnvFilePath);
    if (_telegramMigrationController
      && typeof _telegramMigrationController.reconcileConfiguration === "function") {
      void _telegramMigrationController.reconcileConfiguration({ identityChanged });
    }
  }
  return result;
}

async function initTelegramMigrationController() {
  if (_telegramMigrationController) return _telegramMigrationController;
  const paths = getTelegramApprovalPaths();

  // Native handle. The token remains in the canonical userData env file;
  // neither migration state nor Settings snapshots receive its value.
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
    getLang: () => lang,
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
    getLang: () => lang,
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
    getLang: () => _settingsController.get("lang") || lang || "en",
    log: telegramApprovalLog,
    onSessionGrantRevoke: (grantId) =>
      sessionAutomationCoordinator
        ? sessionAutomationCoordinator.revokeRemoteGrant({ grantId })
        : { status: "stale" },
    onSessionAutomationRouteChange: (client) => {
      if (sessionAutomationCoordinator) {
        sessionAutomationCoordinator.onRemoteClientRouteChange(client);
      }
    },
  });
  nativeRunner.syncSessionAutomationRoute(getTelegramSessionAutomationRoute());
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

  // Seed before publishing the controller. If Settings changes the recipient
  // while init awaits native startup, the subscription below must recognize
  // that first edit as an identity change and queue reconciliation behind init.
  telegramApprovalIdentitySignature = buildTelegramApprovalIdentitySignature(
    getTelegramApprovalPrefs()
  );
  _telegramMigrationController = createTelegramMigrationController({
    native: nativeRunner,
    readPrefs: () => readTelegramMigrationPrefsForController(),
    writePrefs: (patch) => persistTelegramMigrationPatch(patch),
    readFiles: () => {
      const cfg = getTelegramApprovalPrefs();
      const tokenInfo = getTelegramApprovalTokenStatus();
      const configComplete = hasCompleteTelegramApprovalConfig(cfg, tokenInfo);
      return {
        nativeConfigComplete: configComplete,
      };
    },
    onSnapshotChanged: ({ revision }) => {
      syncTelegramSessionAutomationRoute();
      broadcastSettingsWindow("remoteApproval:status-changed", {
        channel: "telegram",
        revision,
      });
      // State changes may clear a previously persisted warning after the user
      // activates native transport or explicitly turns Telegram approval off.
      // Only the post-window startup check below is allowed to display a nudge.
      if (telegramMigrationNudge) {
        void telegramMigrationNudge.sync({ allowNotify: false });
      }
    },
    log: telegramApprovalLog,
  });

  telegramMigrationNudge = createTelegramMigrationNudge({
    getSnapshot: () => _telegramMigrationController.getSnapshot(),
    getLastSignature: () => _settingsController.get("telegramMigrationLastNotified") || "",
    setLastSignature: (value) =>
      _settingsController.applyUpdate("telegramMigrationLastNotified", value),
    showNotification: ({ kind, onClick }) => {
      const title = t("telegramMigrationNudgeTitle");
      const body = t(kind === "legacy"
        ? "telegramMigrationNudgeLegacyBody"
        : "telegramMigrationNudgeNativeBody");
      try {
        const tray = _menu && typeof _menu.getTray === "function" ? _menu.getTray() : null;
        if (process.platform === "win32" && trayBalloonOwner.show(tray, {
          iconType: "warning",
          title,
          content: body,
          onClick,
        })) {
          return true;
        }
        if (Notification && typeof Notification.isSupported === "function" && Notification.isSupported()) {
          const notification = new Notification({ title, body });
          notification.once("click", onClick);
          notification.show();
          return true;
        }
      } catch (err) {
        console.warn("Clawd: Telegram migration nudge failed:", err && err.message);
      }
      console.warn(`Clawd: ${body}`);
      return false;
    },
    openSettings: () => settingsWindowRuntime.open(),
  });

  await _telegramMigrationController.init();
  // Re-read after init so the baseline always matches the committed Settings
  // snapshot, including an edit that raced with native startup.
  telegramApprovalIdentitySignature = buildTelegramApprovalIdentitySignature(
    getTelegramApprovalPrefs()
  );
  return _telegramMigrationController;
}

// In-process IPC bridge fed by the session-snapshot subscription.
function startDiscordPresence() {
  const config = _settingsController.getSnapshot().discordPresence;
  const ready = discordPresenceSettings.readiness(config);
  if (!ready.ready) return false;
  if (!discordPresenceBridge) {
    discordPresenceBridge = createDiscordPresenceBridge({
      getConfig: () => _settingsController.getSnapshot().discordPresence,
      // Development-only seam: committed GIF URLs intentionally point at main,
      // so pre-merge real-device QA may opt into a public test ref/host. A
      // packaged build always ignores the environment and uses the stable URL.
      gifBaseUrl: app.isPackaged ? "" : process.env.CLAWD_DISCORD_GIF_BASE_URL,
      log: (level, msg) => {
        try { sessionLog(`[discord-presence] ${level}: ${msg}`); } catch {}
        // Surface warnings (e.g. wrong App ID) on the house channel; the debug
        // log alone is invisible to an ordinary user.
        if (level === "warn") { try { console.warn(`Clawd: discord presence: ${msg}`); } catch {} }
      },
    });
  }
  discordPresenceBridge.start();
  // Prime from the last renderer-visible animation (including tick.js idle
  // rotation), falling back only before the first state-change was observed.
  const activeTheme = getActiveTheme();
  const visual = lastDiscordPresenceVisual
    ? {
        ...lastDiscordPresenceVisual,
        themeId: lastDiscordPresenceVisual.themeId || (activeTheme && activeTheme._id),
      }
    : {
        state: _state.getCurrentState(),
        svg: _state.getCurrentSvg(),
        themeId: activeTheme && activeTheme._id,
      };
  try { discordPresenceBridge.onVisual(visual.state, visual.svg, visual.themeId); } catch {}
  // Force a replay; the broadcast is otherwise change-gated.
  try { _state.emitSessionSnapshot({ force: true }); } catch {}
  return true;
}

function syncDiscordPresence(reason = "settings") {
  const config = _settingsController.getSnapshot().discordPresence;
  const ready = discordPresenceSettings.readiness(config);
  if (!ready.ready) {
    if (discordPresenceBridge) discordPresenceBridge.stop();
    try { sessionLog(`[discord-presence] sync ${reason}: off (${ready.reason})`); } catch {}
    return false;
  }
  try { sessionLog(`[discord-presence] sync ${reason}: on`); } catch {}
  return startDiscordPresence();
}

function telegramApprovalUnavailableMessage(status) {
  if (status && status.message) return status.message;
  if (status && status.reason === "disabled") return translate("telegramApprovalDisabledMessage");
  if (status && status.reason === "missing-token") return translate("telegramApprovalMissingTokenMessage");
  if (status && status.reason === "invalid-config") return translate("telegramApprovalIncompleteConfigMessage");
  if (status && status.reason === "native-inactive") return translate("telegramApprovalNativeInactiveMessage");
  if (status && status.reason === "native-testing") return translate("telegramApprovalNativeTestingMessage");
  if (status && status.transport === "native") return translate("telegramApprovalNativeInactiveMessage");
  return translate("telegramApprovalNativeInactiveMessage");
}

async function sendTelegramApprovalTest() {
  const beforeStatus = getTelegramApprovalStatus();
  if (beforeStatus.configured !== true) {
    return { status: "error", message: telegramApprovalUnavailableMessage(beforeStatus) };
  }
  const client = getTelegramApprovalClient();
  if (!client || typeof client.requestApproval !== "function") {
    return { status: "error", message: telegramApprovalUnavailableMessage(getTelegramApprovalStatus()) };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60 * 1000);
  try {
    const decision = await client.requestApproval({
      title: translate("telegramSettingsTestTitle"),
      detail: translate("telegramSettingsTestDetail"),
    }, { signal: controller.signal });
    if (decision === "allow" || decision === "deny") {
      return { status: "ok", decision };
    }
    if (decision && (decision.action === "allow" || decision.action === "deny")) {
      return { status: "ok", decision: decision.action };
    }
    return { status: "error", message: translate("telegramApprovalNoButtonResponseMessage") };
  } finally {
    clearTimeout(timer);
  }
}

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
  get permissionAutomationMode() {
    return _settingsController.get("permissionAutomationMode") || "off";
  },
  isPermissionAutomationWarningDismissed(mode) {
    const key = mode === "auto-tools"
      ? "permissionAutomationAutoToolsWarningDismissed"
      : (mode === "unattended"
        ? "permissionAutomationUnattendedWarningDismissed"
        : null);
    return key ? _settingsController.get(key) === true : false;
  },
  setPermissionAutomationMode(mode, options = {}) {
    return _settingsController.applyCommand("setPermissionAutomationMode", {
      mode,
      confirmed: options.confirmed === true,
      suppressFutureConfirmation: options.suppressFutureConfirmation === true,
    }).catch((err) => {
      console.warn("Clawd: setPermissionAutomationMode failed:", err && err.message);
      return { status: "error", message: err && err.message };
    });
  },
  confirmPermissionAutomation: (payload) => (
    permissionAutomationConfirmationRuntime.confirmPermissionAutomation(payload)
  ),
  showPermissionAutomationError: (payload) => (
    permissionAutomationConfirmationRuntime.showPermissionAutomationError(payload)
  ),
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
  getSettingsWindow,
  getSystemVersion: () => process.getSystemVersion(),
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
  bubbleFollowPet: (v) => { bubbleFollowPet = v; },
  bubbleFollowPreference: (v) => { bubbleFollowPreference = v; },
  bubbleFixedCorner: (v) => { bubbleFixedCorner = v; },
  sessionHudEnabled: (v) => { sessionHudEnabled = v; },
  sessionHudShowStateLabels: (v) => { sessionHudShowStateLabels = v; },
  sessionHudShowElapsed: (v) => { sessionHudShowElapsed = v; },
  sessionHudShowContextUsage: (v) => { sessionHudShowContextUsage = v; },
  sessionHudShowQuota: (v) => { sessionHudShowQuota = v; },
  quotaRingDisplayMode: (v) => { quotaRingDisplayMode = v; },
  // Normalized to an array here as well as in prefs: this mirror also takes the
  // value straight from a settings broadcast, and every consumer indexes it.
  quotaRingHiddenProviders: (v) => { quotaRingHiddenProviders = Array.isArray(v) ? v : []; },
  claudeQuotaCollectionEnabled: (v) => { claudeQuotaCollectionEnabled = v; },
  kimiQuotaCollectionEnabled: (v) => { kimiQuotaCollectionEnabled = v; },
  quotaMergeSources: (v) => { quotaMergeSources = v; },
  sessionHudCleanupDetached: (v) => { sessionHudCleanupDetached = v; },
  sessionHudPinned: (v) => { sessionHudPinned = v; },
  sessionStaleMs: (v) => { sessionStaleMs = v; }, workingStaleMs: (v) => { workingStaleMs = v; },
  codexWorkingStaleMs: (v) => { codexWorkingStaleMs = v; },
  detachedIdleStaleMs: (v) => { detachedIdleStaleMs = v; },
  soundMuted: (v) => { soundMuted = v; }, soundVolume: (v) => { soundVolume = v; }, lowPowerIdleMode: (v) => { lowPowerIdleMode = v; },
  keepAwakeWhileWorking: (v) => { keepAwakeWhileWorking = v; },
  petTint: (v) => { petTint = v; },
  allowEdgePinning: (v) => { allowEdgePinningCached = v; }, disableMiniMode: (v) => { disableMiniModeCached = v; }, keepSizeAcrossDisplays: (v) => { keepSizeAcrossDisplaysCached = v; resetKeepSizeFrozen(); },
  fullscreenOverlay: (v) => { fullscreenOverlayCached = v; },
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

const holidayAccessoryRuntime = createHolidayAccessoryRuntime({
  powerMonitor,
  getSettingsSnapshot: () => _settingsController.getSnapshot(),
  getActiveTheme: () => getActiveTheme(),
  sendToRenderer,
  onAccessoryChange: syncHitWin,
  logWarn: console.warn,
});

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
  syncWindowTitles: () => {
    settingsWindowRuntime.applyTitleToWindow();
    // syncLocalization pushes BOTH the native title AND fresh renderer state
    // (dictionary/lang), so an external language change from Settings keeps
    // the tutorial body, buttons, and document.title in sync with the new
    // language — not just the native title bar.
    _tutorial.syncLocalization();
  },
  emitSessionSnapshot: (options) => _state.emitSessionSnapshot(options),
  cleanStaleSessions: () => _state.cleanStaleSessions(),
  syncPermissionShortcuts,
  dismissInteractivePermissionBubbles: () => callRuntimeMethod(_perm, "dismissInteractivePermissionBubbles"),
  clearCodexNotifyBubbles,
  clearCodexUserInputBubbles,
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
  getActiveTheme: () => getActiveTheme(),
  syncHitWin,
  // #509: re-rest the pet on the newly selected idle visual right away, but
  // only while actually idle — task/sleep/mini states pick it up on their
  // next natural revert instead.
  refreshIdleVisual: () => {
    if (_state.getCurrentState() !== "idle") return;
    _state.applyState("idle", _state.getSvgOverride("idle"));
  },
  refreshDisplayedVisual: refreshDisplayedVisualForLowPowerMode,
  rebuildAllMenus,
  reconcilePowerSaveBlocker,
  logWarn: console.warn,
});
settingsEffectRouter.start();
feishuApprovalMigrationNudge = createFeishuApprovalMigrationNudge({
  getConfig: () => getFeishuApprovalPrefs(),
  getSecrets: () => getFeishuApprovalSecrets(),
  getLastSignature: () => _settingsController.get("feishuApprovalMigrationLastNotified") || "",
  setLastSignature: (value) =>
    _settingsController.applyUpdate("feishuApprovalMigrationLastNotified", value),
  showNotification: ({ onClick }) => {
    const title = translate("feishuApprovalMigrationNudgeTitle");
    const body = translate("feishuApprovalMigrationNudgeBody");
    try {
      const tray = _menu && typeof _menu.getTray === "function" ? _menu.getTray() : null;
      if (process.platform === "win32" && trayBalloonOwner.show(tray, {
        iconType: "warning",
        title,
        content: body,
        onClick,
      })) {
        return true;
      }
      if (Notification && typeof Notification.isSupported === "function" && Notification.isSupported()) {
        const notification = new Notification({ title, body });
        notification.once("click", onClick);
        notification.show();
        return true;
      }
    } catch (err) {
      console.warn("Clawd: Feishu/Lark upgrade nudge failed:", err && err.message);
    }
    console.warn(`Clawd: ${body}`);
    return false;
  },
  openSettings: () => settingsWindowRuntime.open(),
});
_settingsController.subscribeKey("tgApproval", (value) => {
  syncTelegramSessionAutomationRoute();
  if (suppressTelegramMigrationReconcile > 0) return;
  const nextSignature = buildTelegramApprovalIdentitySignature(value);
  const identityChanged = telegramApprovalIdentitySignature !== ""
    && nextSignature !== telegramApprovalIdentitySignature;
  telegramApprovalIdentitySignature = nextSignature;
  if (!identityChanged) return;
  if (_telegramMigrationController
    && typeof _telegramMigrationController.reconcileConfiguration === "function") {
    void _telegramMigrationController.reconcileConfiguration({ identityChanged: true });
  }
});
_settingsController.subscribeKey("discordPresence", () => {
  syncDiscordPresence("settings");
});
_settingsController.subscribeKey("feishuApproval", () => {
  prepareFeishuSessionAutomationRouteChange(buildFeishuSessionAutomationRouteSignature(
    getFeishuApprovalPrefs(),
    getFeishuApprovalSecrets()
  ));
  queueFeishuApprovalSync("settings");
  if (feishuApprovalMigrationNudge) {
    void feishuApprovalMigrationNudge.sync({ allowNotify: false });
  }
});
_settingsController.subscribeKey("slackNotify", () => {
  slackNotifyConfigRevision += 1;
  broadcastSlackNotifyStatus();
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
  onUpdateCheckStatusChanged: (snapshot) => {
    broadcastSettingsWindow("settings:update-check-status", snapshot);
  },
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
  getUpdateCheckSnapshot,
  clearUpdateError,
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
let _remoteSshRuntime = null;
registerDoctorIpc({
  ipcMain,
  app,
  shell,
  server: _server,
  getPrefsSnapshot: () => _settingsController.getSnapshot(),
  getPrefsReadFailure: () => _settingsController.hasReadFailure(),
  getPrefsRecovered: () => _initialPrefsRecovered && !_settingsController.hasReadFailure(),
  getPrefsRecoveryBackupFailed: () => _initialPrefsRecoveryBackupFailed,
  getFeishuApprovalSecrets: () => getFeishuApprovalSecrets(),
  getDoNotDisturb: () => doNotDisturb,
  getLocale: () => _settingsController.get("lang") || "en",
  resolveAgentDisplayName: _resolveAgentDisplayName,
  getRemoteSshStatuses: () => _remoteSshRuntime
    ? _remoteSshRuntime.listStatuses()
    : [],
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
const { inspectEffectiveTransport } = require("./remote-ssh-transport");
const { createRemoteSshTransportCoordinator } = require("./remote-ssh-transport-coordinator");
_remoteSshTransportCoordinator = createRemoteSshTransportCoordinator({
  inspectEffectiveTransport: (profile) => inspectEffectiveTransport(profile),
});
_remoteSshRuntime = createRemoteSshRuntime({
  getHookServerPort: () => getHookServerPort(),
  createProfileIngress: (options) => _server.openRemoteSshIngress(options),
  transportCoordinator: _remoteSshTransportCoordinator,
  log: (...args) => console.warn("Clawd remote-ssh:", ...args),
});
const _remoteSshIpc = registerRemoteSshIpc({
  ipcMain,
  settingsController: _settingsController,
  remoteSshRuntime: _remoteSshRuntime,
  transportCoordinator: _remoteSshTransportCoordinator,
  BrowserWindow,
  isPackaged: app.isPackaged,
  getInstallationIdentity: ensureRemoteSshInstallationIdentity,
  enableProfileIsolation: process.env.CLAWD_ENABLE_EXPERIMENTAL_REMOTE_ISOLATION === "1",
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

const settingsIpcRuntime = registerSettingsIpc({
  ipcMain,
  app,
  BrowserWindow,
  dialog,
  shell,
  fs,
  path,
  settingsController: _settingsController,
  getQuotaSourceCount: () => _state.getQuotaSourceCount(),
  getQuotaRingProviders: () => _ringGeom.listQuotaRingProviders(
    _state.buildSessionSnapshot(),
    quotaRingHiddenProviders
  ),
  themeLoader,
  codexPetMain,
  getSettingsWindow,
  getActiveTheme: () => getActiveTheme(),
  getLang: () => lang,
  roamFenceSettings,
  roamFencePicker: roamFencePickerRuntime,
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
  saveFeishuApproverByEmail: ({ email, signal }) => saveFeishuApproverByEmail({ email, signal }, {
    getFeishuApprovalPrefs,
    getFeishuApprovalSecrets,
    getFeishuApprovalSecretsRevision: () => feishuApprovalSecretsRevision,
    lookupFeishuApproverByEmail: (params) => lookupOpenIdByEmail({
      ...params,
      log: feishuApprovalLog,
    }),
    commitResolvedApprover: (payload) => _settingsController.applyCommand(
      "feishuApproval.commitResolvedApprover",
      payload,
    ),
  }),
  getAllAgents,
  getHookServerPort: () => getHookServerPort(),
  getRecentHookEvents: (options) => _server.getRecentHookEvents(options),
  kimiQuotaRuntime: _kimiQuotaRuntime,
  checkForUpdates,
  getUpdateCheckSnapshot,
  clearUpdateError,
  copyUpdateError: (copyText) => {
    clipboard.writeText(copyText);
    return { status: "ok" };
  },
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
  getDashboardWindow: () => _dashboard.getWindow(),
  getKimiQuotaStatus: () => _kimiQuotaRuntime.getStatus(),
  refreshKimiQuota: () => _kimiQuotaRuntime.refresh(),
  focusSession: (sessionId, options) => focusDashboardSession(sessionId, options),
  hideSession: (sessionId) => hideDashboardSession(sessionId),
  openSessionFolder: (sessionId) => openDashboardSessionFolder(sessionId),
  ackSessionCompletion: (sessionId) => _state.ackSessionCompletion(sessionId),
  setSessionAlias: (payload) => _settingsController.applyCommand("setSessionAlias", payload),
  setSessionAutomationOverride: (payload, context) => {
    let warningParent = null;
    try {
      warningParent = BrowserWindow.fromWebContents(context && context.sender);
    } catch {}
    return sessionAutomationCoordinator.setSessionAutomationOverride(payload, { warningParent });
  },
  clearSessionAutomationGrant: (payload) =>
    sessionAutomationCoordinator.clearSessionAutomationGrant(payload),
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

  const initialAccessoryDelivery = prepareCurrentAccessorySlotsDelivery();
  petWindowRuntime.createRenderWindow({
    BrowserWindow,
    size,
    initialWindowBounds,
    initialVirtualBounds,
    preloadPath: path.join(__dirname, "preload.js"),
    loadFilePath: path.join(__dirname, "index.html"),
    themeConfig: buildRendererThemeConfig(initialAccessoryDelivery.snapshot),
    setRenderWindow: (createdWindow) => { win = createdWindow; },
    isQuitting: () => isQuitting,
    applyDockVisibility,
  });
  finalizePetAccessorySlotsDelivery(initialAccessoryDelivery, true);

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

  // Issue #690 plan §4.3.9: these replace (not supplement) the previous
  // synchronous "move"/"resize" -> syncFloatingWindowsAfterPetBoundsChange()
  // wiring. Native move/resize callbacks carry no geometry and must not
  // read/write anything themselves — onNativeGeometryEvent() only
  // (re)schedules a debounced quiet-point reconcile, which is what now calls
  // syncFloatingWindowsAfterPetBoundsChange() (as syncDerivedSurfaces()) once
  // it has classified the settled geometry.
  win.on("move", () => petWindowRuntime.onNativeGeometryEvent());
  win.on("resize", () => petWindowRuntime.onNativeGeometryEvent());
  // §4.3.11: the hit window gets the same geometry-blind debounced treatment,
  // on its own (longer) HIT_QUIET_MS quiet period.
  hitWin.on("move", () => petWindowRuntime.onHitNativeGeometryEvent());
  hitWin.on("resize", () => petWindowRuntime.onHitNativeGeometryEvent());

  syncSessionHudVisibility();

  registerPetInteractionIpc({
    ipcMain,
    showContextMenu: (event) => showPetContextMenu(event),
    moveWindowForDrag: () => moveWindowForDrag(),
    setIdlePaused: (value) => { idlePaused = !!value; },
    setLowPowerIdlePaused,
    setAccessoryMirror: setAccessoryMirrored,
    isMiniTransitioning: () => _mini.getMiniTransitioning(),
    getCurrentState: () => _state.getCurrentState(),
    getCurrentSvg: () => _state.getCurrentSvg(),
    sendToRenderer,
    requestDragReaction,
    requestClickReaction,
    settleVisual: (event, payload) => {
      if (
        !win
        || win.isDestroyed()
        || !isTrustedMainFrameEvent(event, win.webContents)
      ) return false;
      return displayedVisualProjection.settle(payload);
    },
    recoverVisiblePetAfterRendererLoad: (event) => {
      if (!win || win.isDestroyed()) return;
      if (!event || event.sender !== win.webContents) return;
      if (themeRuntime.isReloadInProgress()) return;
      petWindowRuntime.recoverVisiblePetAfterRendererLoad();
    },
    setDragLocked: (value) => { petWindowRuntime.setDragLocked(value); },
    setMouseOverPet: (value) => { mouseOverPet = !!value; },
    cancelRoam: () => _roam.cancelRoam(),
    beginDragSnapshot: () => beginDragSnapshot(),
    clearDragSnapshot: () => clearDragSnapshot(),
    syncHitWin: () => syncHitWin(),
    syncDisplayedVisualGeometry,
    syncImeEditingPetDodge: () => topmostRuntime.syncImeEditingPetDodge(),
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
  // Silently connect any remote SSH profile flagged "connect on launch" once
  // the hook server is ACTUALLY listening and its real port is known.
  // runtime.connect() reads getHookServerPort() synchronously to build the SSH
  // reverse tunnel, and listen() is async — sweeping before the 'listening'
  // event would read a stale fallback port and tunnel to the wrong local port
  // if the bind drifted (port in use, multi-instance). startHttpServer()
  // resolves null when no port could be bound, in which case we skip the sweep.
  // Best-effort: failures fall back to the runtime's own reconnect/backoff and
  // never block startup.
  startHttpServer().then((port) => {
    if (port == null) return;
    const restoredSessionIds = restoreSessionsFromRecoveryLeases(_state, {
      isAgentEnabled: (agentId) => (
        _runtimeAgentGate.isAgentEnabled(agentId)
        && _runtimeAgentGate.isAgentIntegrationInstalled(agentId)
      ),
    });
    if (restoredSessionIds.length > 0) {
      const recoveredSnapshot = _state.buildSessionSnapshot();
      reconcilePowerSaveBlocker();
      broadcastDashboardSessionSnapshot(recoveredSnapshot);
      broadcastSessionHudSnapshot(recoveredSnapshot);
      // The Slack notifier is not on the broadcast above, so without this its
      // first snapshot would be some later event — which its priming branch
      // swallows, losing the first completion after a restart. Prime it with
      // what is already history instead.
      try { getSlackNotifyClient().prime(recoveredSnapshot); } catch {}
      if (!doNotDisturb && !_mini.getMiniMode()) {
        const recoveredState = resolveDisplayState();
        applyState(recoveredState, getSvgOverride(recoveredState));
      }
      sessionLog(`startup recovery restored sessions=${restoredSessionIds.join(",")}`);
    }
    void _remoteSshIpc.connectOnLaunchProfiles().catch((err) => {
      console.warn("Clawd remote-ssh: connect-on-launch failed:", err && err.message);
    });
  }).catch(() => {});
  if (_settingsController.get("mobilePreviewEnabled") === true) _lanWss.start();
  startStaleCleanup();
  // Wait for renderer to be ready before sending initial state
  // If hooks arrived during startup, respect them instead of forcing idle
  // Also handles crash recovery (render-process-gone → reload)
  win.webContents.on("did-start-loading", () => {
    setLowPowerIdlePaused(false);
    // A fresh document draws upright: no .mini-left class, no inline scale on
    // the direction stage. Keeping the old facing here would leave the hit
    // window mirrored against an unmirrored pet until something happens to
    // make the renderer report again.
    setAccessoryMirrored(false);
  });
  win.webContents.on("did-finish-load", () => {
    deliverRendererThemeConfig();
    petWindowRuntime.resendViewportOffsets();
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
    resetDisplayedVisualProjection("renderer-process-gone", { preserveCommitted: true });
    petWindowRuntime.reloadWindowWebContents(win, { crashKey: "renderWin", details });
  });

  guardAlwaysOnTop(win);
  startTopmostWatchdog();
  startFocusablePoll();

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
  // PR #751 second-review C-6 (Codex non-blocking): §4.3.14's
  // observedClampInset is only valid until the topology it was learned
  // against changes — clearing it (and invalidating the displays cache,
  // B-5) used to wait for the SAME 400ms debounce as the geometry reflow
  // above, so a burst of metrics events could keep re-arming the debounce
  // and delay the clear indefinitely while stale insets kept getting used
  // for clamp classification in the meantime. Both now run immediately, in
  // the raw event callback, decoupled from the (still debounced, to avoid
  // visible jitter) geometry reflow itself. Clearing the whole table here
  // is a safe superset of "clear the affected display's entries" —
  // Electron doesn't cheaply say WHICH display changed from this event
  // alone.
  screen.on("display-metrics-changed", () => {
    petWindowRuntime.clearObservedClampInsets();
    petWindowRuntime.invalidateDisplaysCache();
    reapplyDisplayGeometryAfterMetricsChange();
  });
  // PR #751 second-review C-4 (Codex B4): display-removed/added now also
  // clear the inset table (handleDisplayRemoved()/handleDisplayAdded()
  // themselves do this now, as their own first lines alongside their
  // existing invalidateDisplaysCache() call) — previously only
  // metrics-changed did, leaving a stale inset alive across a monitor
  // unplug/replug or a genuine topology addition.
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

function getBubbleWorkArea(followPet, petBounds) {
  return resolveBubbleWorkArea({
    followPet,
    petBounds: petBounds || getPetWindowBounds(),
    getPrimaryWorkArea: getPrimaryWorkAreaSafe,
    getNearestWorkArea,
    syntheticWorkArea: SYNTHETIC_WORK_AREA,
  });
}

function getTextScaleForBubbleWorkArea(workArea) {
  const displayKey = isUsableBubbleWorkArea(workArea)
    ? getDisplayKeyForBounds(workArea)
    : null;
  return effectiveTextScaleForKey(displayKey || getPetDisplayKey());
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
  // Issue #690 plan §4.3.10's mini transition+animation reconcile protection
  // period release point (mirrors _roamCtx's identical wiring below).
  releaseReconcileProtection: () => petWindowRuntime.releaseReconcileProtection(),
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

const handleTestResult = createTestReactionHandler({
  getEnabled: () => _settingsController.get("testReactionsEnabled") === true,
  getDoNotDisturb: () => doNotDisturb,
  isPetHidden: () => petWindowRuntime.isPetHidden(),
  getMiniMode: () => _mini.getMiniMode(),
  getMiniTransitioning: () => _mini.getMiniTransitioning(),
  isDragging: () => petWindowRuntime.isDragLocked(),
  hasPetWindow: () => !!(win && !win.isDestroyed()),
  sendToRenderer,
});
const { enterMiniMode, exitMiniMode, enterMiniViaMenu, miniPeekIn, miniPeekOut,
        checkMiniModeSnap, cancelMiniTransition, animateWindowX, animateWindowParabola } = _mini;

// ── Free Roam — initialized here after state and mini modules ──
const _roamCtx = {
  get win() { return win; },
  get dragLocked() { return petWindowRuntime.isDragLocked(); },
  getPetWindowBounds,
  applyPetWindowBounds,
  // #569: lets roam anchor to the keep-size frozen size when that toggle is on
  getEffectiveCurrentPixelSize,
  syncHitWin: () => syncHitWin(),
  // Issue #690 plan §4.3.10's roam protection-period release point.
  releaseReconcileProtection: () => petWindowRuntime.releaseReconcileProtection(),
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
  setRoamHeading: (headingLeft) => sendToRenderer("roam-heading", !!headingLeft),
  // #640: hold still while the user types into a bubble text field (macOS)
  isImeEditingActive: () => pendingPermissions.some(
    (p) => p
      && p.bubble
      && !p.bubble.isDestroyed()
      && p.bubble.isVisible()
      && p.bubble.__clawdMacImeEditing
  ),
  hasVisiblePermissionBubbles: () => _perm.hasVisiblePermissionBubbles(),
  // #810: optional roam fence — validated async loader for
  // ~/.clawd/roam-area.json; roam reads its in-memory cache at target pick
  // time and kicks refresh() when scheduling walks (see src/roam-fence.js).
  roamFence: roamFenceLoader,
};
const _roam = require("./roam")(_roamCtx);
// #810: resolve the fence's initial status right away so the first roam
// round doesn't have to hold on an UNKNOWN state (get() === null) when a
// fence file exists — or confirm quickly that none does.
_roamCtx.roamFence.refresh();

// Free roam: initialize from prefs and react to toggle changes
_roam.setEnabled(_settingsController.get("freeRoam") === true);
_roam.setConstrainAxis(_settingsController.get("roamConstrainAxis") === true);
try {
  _settingsController.subscribeKey("freeRoam", (value) => {
    _roam.setEnabled(value === true);
  });
  _settingsController.subscribeKey("roamConstrainAxis", (value) => {
    _roam.setConstrainAxis(value === true);
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
  // Only the winning instance may publish the startup gate. A losing instance
  // can have a stale/default prefs snapshot and must never become the final
  // writer after the active instance has disabled Codex.
  // A future-version, recovered, or partially malformed snapshot is not
  // authoritative enough to publish an enabled external gate. The evaluator
  // latches that decision for this process; only a clean restart can reopen it.
  const startupGateSnapshot = (
    _initialPrefsLoad.locked === true
    || _initialPrefsLoad.recovered === true
    || _initialPrefsLoad.codexAutoStartAuthoritative === false
  ) ? null : _initialPrefsLoad.snapshot;
  _syncCodexAutoStartGate(startupGateSnapshot, "startup");
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
      // #525: relaunching while the pet is nominally visible is a "where is my
      // pet?" signal — showInactive() alone cannot clear a DWM cloak, so run
      // the cloak recovery path too.
      petWindowRuntime.recoverIfCloaked();
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

  // ── Codex official-hook health nudge ──
  //
  // Codex approval awareness now depends entirely on the official
  // PermissionRequest hook (the JSONL approval heuristic was removed). If that
  // hook silently failed to register — or [features].hooks=false, or it needs
  // Codex /hooks review — the user gets NO approval prompts and no fallback.
  // Nudge once, edge-triggered: notify only when the breakage KIND changes
  // (deduped via the persisted signature) and reset when healthy, so a broken
  // hook warns at most once per distinct breakage, never every launch. The
  // Windows tray balloon is the active nudge; the Agents-tab badge is the
  // always-on, cross-platform surface.
  function fireCodexHookNudge(verdict) {
    try {
      const tray = _menu && typeof _menu.getTray === "function" ? _menu.getTray() : null;
      if (process.platform === "win32") {
        trayBalloonOwner.show(tray, {
          iconType: "warning",
          title: t("codexHookHealthNudgeTitle"),
          content: t("codexHookHealthNudgeBody"),
        });
      }
    } catch (err) {
      console.warn("Clawd: Codex hook balloon failed:", err && err.message);
    }
    console.warn(`Clawd: Codex official hook needs attention (${verdict.signature}): ${verdict.detailText || ""}`);
  }

  function maybeNudgeCodexHookHealth() {
    try {
      const { getCodexHookHealth, decideCodexHookNotification } = require("./codex-hook-health");
      const snapshot = _settingsController.getSnapshot();
      const verdict = getCodexHookHealth({ prefs: snapshot });
      const prevSignature = _settingsController.get("codexHookHealthLastNotified") || "";
      const decision = decideCodexHookNotification(verdict, prevSignature, {
        codexEnabled: _runtimeAgentGate.isAgentEnabled("codex"),
        notifyEnabled: _settingsController.get("codexHookHealthNotifyEnabled") !== false,
      });
      if (decision.nextSignature !== prevSignature) {
        _settingsController.applyUpdate("codexHookHealthLastNotified", decision.nextSignature);
      }
      if (decision.shouldNotify) fireCodexHookNudge(verdict);
    } catch (err) {
      console.warn("Clawd: Codex hook health nudge failed:", err && err.message);
    }
  }

  function notifyPrefsAuthorityFailure() {
    const readFailure = _settingsController.hasReadFailure();
    if (!readFailure && !_initialPrefsRecovered) return false;
    const title = translate(_initialPrefsRecoveryBackupFailed
      ? "prefsRecoveryBackupFailedNudgeTitle"
      : (readFailure ? "prefsReadFailureNudgeTitle" : "prefsRecoveredNudgeTitle"));
    const body = translate(_initialPrefsRecoveryBackupFailed
      ? "prefsRecoveryBackupFailedNudgeBody"
      : (readFailure ? "prefsReadFailureNudgeBody" : "prefsRecoveredNudgeBody"));
    const onClick = () => settingsWindowRuntime.open();
    try {
      const tray = _menu && typeof _menu.getTray === "function" ? _menu.getTray() : null;
      if (process.platform === "win32" && trayBalloonOwner.show(tray, {
        iconType: "warning",
        title,
        content: body,
        onClick,
      })) {
        return true;
      }
      if (Notification && typeof Notification.isSupported === "function" && Notification.isSupported()) {
        const notification = new Notification({ title, body });
        notification.once("click", onClick);
        notification.show();
        return true;
      }
    } catch (err) {
      console.warn("Clawd: preferences authority nudge failed:", err && err.message);
    }
    console.warn(`Clawd: ${body}`);
    return false;
  }

  app.whenReady().then(async () => {
    // Older macOS and development builds retain the padded runtime icon from
    // #416. Packaged Tahoe+ leaves the Dock untouched so macOS can apply the
    // user's Default/Dark/Clear/Tinted treatment to the bundle icon (#941).
    const installRuntimeDockIcon = resolveRuntimeDockIconPolicy({
      platform: process.platform,
      isPackaged: app.isPackaged === true,
      getSystemVersion: () => process.getSystemVersion(),
    });
    installStartupDockIcon({
      dock: app.dock,
      showDock: _settingsController.get("showDock") !== false,
      dockIconPath: path.join(__dirname, "..", "assets", "dock-icon.png"),
      installRuntimeIcon: installRuntimeDockIcon,
    });

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
    // Remote SSH installation identity is intentionally lazy. Loading it uses
    // macOS Keychain through safeStorage, so ordinary Clawd startup must not
    // request credential access when no Remote SSH action is being performed.
    // Explicit Remote SSH status/actions and connect-on-launch profiles load it
    // through the single-flight provider injected into remote-ssh-ipc above.
    permDebugLog = path.join(app.getPath("userData"), "permission-debug.log");
    updateDebugLog = path.join(app.getPath("userData"), "update-debug.log");
    sessionDebugLog = path.join(app.getPath("userData"), "session-debug.log");
    focusDebugLog = path.join(app.getPath("userData"), "focus-debug.log");
    const { createWindowsProcessChainShadowLogger } = require("./windows-process-chain-shadow-log");
    recordWindowsProcessChainShadow = createWindowsProcessChainShadowLogger({
      filePath: path.join(app.getPath("userData"), "windows-process-chain-shadow.log"),
    });
    const telegramMigrationInit = initTelegramMigrationController().catch((err) => {
      console.warn("Clawd: migration controller init failed:", err && err.message);
      return null;
    });
    try { syncDiscordPresence("startup"); }
    catch (err) { console.warn("Clawd: discord presence startup failed:", err && err.message); }
    queueFeishuApprovalSync("startup");
    createWindow();
    // Reconcile the local quota binding only after the app has visible UI.
    // initialize() reads opaque credential metadata but never decrypts the key
    // or performs a network request, so ordinary startup cannot be held behind
    // a Keychain/DPAPI prompt.
    void _kimiQuotaRuntime.initialize().catch((err) => {
      console.warn("Clawd: Kimi quota startup reconciliation failed:", err && err.message);
    });
    notifyPrefsAuthorityFailure();
    if (feishuApprovalMigrationNudge) {
      void feishuApprovalMigrationNudge.sync({ allowNotify: true });
    }
    void telegramMigrationInit.then((controller) => {
      if (!controller || !telegramMigrationNudge) return;
      return telegramMigrationNudge.sync({ allowNotify: true });
    }).catch((err) => {
      console.warn("Clawd: Telegram migration startup nudge failed:", err && err.message);
    });
    holidayAccessoryRuntime.start();
    // WSL agent detection is NOT started here: scanning runs a command inside
    // every installed distro, which boots each stopped VM — too aggressive for
    // app launch. The first Settings→Agents visit triggers the scan instead
    // (see fetchAgentInstallationHints in settings-ui-core.js).
    systemWakeRecovery = createSystemWakeRecovery({
      powerMonitor,
      ipcMain,
      sendToRenderer,
      onRecovered: () => {
        setLowPowerIdlePaused(false);
        // The main mirror can already be false while the renderer still owns a
        // paused SVG. Always resend the latest cursor position after receipt.
        setForceEyeResend(true);
      },
      log: sessionLog,
      onError: (err) => safeConsoleError(
        "Clawd: system wake recovery failed:",
        err && err.message ? err.message : err
      ),
    });
    systemWakeRecovery.start();
    // #525: sleep/wake and lock/unlock are prime DWM-cloak moments. Hang the
    // cloak recovery directly on powerMonitor rather than onRecovered above:
    // onRecovered only fires after a renderer round-trip and is skipped on
    // timeout (system-wake-recovery.js finishWithTimeout), while un-cloaking is
    // a main-process concern that must not depend on renderer health. The two
    // paths coexist; recoverIfCloaked() is a no-op when nothing is cloaked.
    if (isWin) {
      powerMonitor.on("resume", () => petWindowRuntime.recoverIfCloaked());
      powerMonitor.on("unlock-screen", () => petWindowRuntime.recoverIfCloaked());
    }
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

    // Deferred so any startup Codex hook sync has settled before we read the
    // on-disk hook state; unref'd so it never blocks a fast quit.
    const codexHookNudgeTimer = setTimeout(maybeNudgeCodexHookHealth, 4000);
    if (codexHookNudgeTimer && typeof codexHookNudgeTimer.unref === "function") codexHookNudgeTimer.unref();
  });

  app.on("before-quit", (event) => {
    isQuitting = true;
    if (!appQuitDrainReady) {
      event.preventDefault();
      if (!appQuitDrainStarted) {
        appQuitDrainStarted = true;
        void drainRemoteSshAndFeishuBeforeQuit()
          .finally(() => {
            appQuitDrainReady = true;
            app.quit();
          });
      }
    }
    if (quitCleanupStarted) return;
    quitCleanupStarted = true;
    trayBalloonOwner.dispose();
    holidayAccessoryRuntime.dispose();
    if (systemWakeRecovery) systemWakeRecovery.dispose();
    // #525: release the IVirtualDesktopManager COM ref and pay back our own
    // CoInitializeEx count (see win-cloak-recovery.js dispose()).
    _cloakInspector.dispose();
    try { stopUpdateScheduler(); } catch {}
    releasePowerSaveBlocker();
    flushRuntimeStateToPrefs();
    globalShortcut.unregisterAll();
    void settingsSizePreviewSession.cleanup();
    permissionAutomationConfirmationRuntime.dispose();
    roamFencePickerRuntime.dispose();
    if (_telegramMigrationController
      && typeof _telegramMigrationController.dispose === "function") {
      void _telegramMigrationController.dispose();
    }
    if (discordPresenceBridge) discordPresenceBridge.stop();
    stopFeishuApprovalClient();
    _perm.cleanup();
    _server.cleanup();
    if (_lanWss) _lanWss.cleanup();
    _updateBubble.cleanup();
    if (displayedVisualProjection) displayedVisualProjection.dispose();
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
    if (!_remoteSshRuntime || typeof _remoteSshRuntime.shutdown !== "function") {
      try { _remoteSshRuntime.cleanup(); } catch {}
    }
    if (hitWin && !hitWin.isDestroyed()) hitWin.destroy();
  });

  app.on("window-all-closed", () => {
    if (!isQuitting) return;
    app.quit();
  });
}
