const { app, BrowserWindow, screen, Menu, ipcMain, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs");
const { applyStationaryCollectionBehavior } = require("./mac-window");
const hitGeometry = require("./hit-geometry");
const { findNearestWorkArea, computeLooseClamp, SYNTHETIC_WORK_AREA } = require("./work-area");

// ── Autoplay policy: allow sound playback without user gesture ──
// MUST be set before any BrowserWindow is created (before app.whenReady)
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
const isWin = process.platform === "win32";
const LINUX_WINDOW_TYPE = "toolbar";


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
const PREFS_PATH = path.join(app.getPath("userData"), "clawd-prefs.json");
const _initialPrefsLoad = prefsModule.load(PREFS_PATH);
const _settingsController = createSettingsController({
  prefsPath: PREFS_PATH,
  loadResult: _initialPrefsLoad,
});

// Mirror of `_settingsController.get("lang")` so existing sync read sites in
// menu.js / state.js / etc. don't have to round-trip through the controller.
// Updated by the subscriber in `wireSettingsSubscribers()` below — never
// assign directly.
let lang = _settingsController.get("lang");

// Capture window/mini runtime state into the controller and write to disk.
// Replaces the legacy `savePrefs()` callsites — they used to read fresh
// `win.getBounds()` and `_mini.*` at save time, so we mirror that here.
function flushRuntimeStateToPrefs() {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  _settingsController.applyBulk({
    x: bounds.x,
    y: bounds.y,
    size: currentSize,
    miniMode: _mini.getMiniMode(),
    miniEdge: _mini.getMiniEdge(),
    preMiniX: _mini.getPreMiniX(),
    preMiniY: _mini.getPreMiniY(),
  });
}

let _codexMonitor = null;          // Codex CLI JSONL log polling instance
let _geminiMonitor = null;         // Gemini CLI session JSON polling instance

// ── Theme loader ──
const themeLoader = require("./theme-loader");
themeLoader.init(__dirname, app.getPath("userData"));

let activeTheme = themeLoader.loadTheme(_settingsController.get("theme") || "clawd");

// ── CSS <object> sizing (from theme) ──
function getObjRect(bounds) {
  const state = _state.getCurrentState();
  const file = _state.getCurrentSvg() || (activeTheme && activeTheme.states && activeTheme.states.idle[0]);
  return hitGeometry.getAssetRectScreen(activeTheme, bounds, state, file)
    || { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height };
}

let win;
let hitWin;  // input window — small opaque rect over hitbox, receives all pointer events
let tray = null;
let contextMenuOwner = null;
// Mirror of _settingsController.get("size") — initialized from disk, kept in
// sync by the settings subscriber. The legacy S/M/L → P:N migration runs
// inside createWindow() because it needs the screen API.
let currentSize = _settingsController.get("size");

// ── Proportional size mode ──
// currentSize = "P:<ratio>" means the pet occupies <ratio>% of the work area width.
const PROPORTIONAL_RATIOS = [8, 10, 12, 15];

function isProportionalMode(size) {
  return typeof (size || currentSize) === "string" && (size || currentSize).startsWith("P:");
}

function getProportionalRatio(size) {
  return parseFloat((size || currentSize).slice(2)) || 10;
}

function getCurrentPixelSize(overrideWa) {
  if (!isProportionalMode()) return SIZES[currentSize] || SIZES.S;
  const ratio = getProportionalRatio();
  let wa = overrideWa;
  if (!wa && win && !win.isDestroyed()) {
    const { x, y, width, height } = win.getBounds();
    wa = getNearestWorkArea(x + width / 2, y + height / 2);
  }
  if (!wa) wa = getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA;
  const px = Math.round(wa.width * ratio / 100);
  return { width: px, height: px };
}
let contextMenu;
let doNotDisturb = false;
let isQuitting = false;
// Mirror caches — kept in sync with the settings store via the subscriber
// in wireSettingsSubscribers() further down. Read freely; never assign
// directly (writes go through ctx setters → controller.applyUpdate).
let showTray = _settingsController.get("showTray");
let showDock = _settingsController.get("showDock");
let autoStartWithClaude = _settingsController.get("autoStartWithClaude");
let bubbleFollowPet = _settingsController.get("bubbleFollowPet");
let hideBubbles = _settingsController.get("hideBubbles");
let showSessionId = _settingsController.get("showSessionId");
let soundMuted = _settingsController.get("soundMuted");
let petHidden = false;
const DEFAULT_TOGGLE_SHORTCUT = "CommandOrControl+Shift+Alt+C";

function togglePetVisibility() {
  if (!win || win.isDestroyed()) return;
  if (_mini.getMiniTransitioning()) return;
  if (petHidden) {
    win.showInactive();
    if (isLinux) win.setSkipTaskbar(true);
    if (hitWin && !hitWin.isDestroyed()) {
      hitWin.showInactive();
      if (isLinux) hitWin.setSkipTaskbar(true);
    }
    // Restore any permission bubbles that were hidden
    for (const perm of pendingPermissions) {
      if (perm.bubble && !perm.bubble.isDestroyed()) {
        perm.bubble.showInactive();
        if (isLinux) perm.bubble.setSkipTaskbar(true);
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
  syncPermissionShortcuts();
  buildTrayMenu();
  buildContextMenu();
}

function registerToggleShortcut() {
  try {
    globalShortcut.register(DEFAULT_TOGGLE_SHORTCUT, togglePetVisibility);
  } catch (err) {
    console.warn("Clawd: failed to register global shortcut:", err.message);
  }
}

function unregisterToggleShortcut() {
  try {
    globalShortcut.unregister(DEFAULT_TOGGLE_SHORTCUT);
  } catch {}
}

function sendToRenderer(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}
function sendToHitWin(channel, ...args) {
  if (hitWin && !hitWin.isDestroyed()) hitWin.webContents.send(channel, ...args);
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
  if (sessions.size > 0) {
    const resolved = resolveDisplayState();
    applyState(resolved, getSvgOverride(resolved));
    return;
  }

  applyState("idle", getSvgOverride("idle"));
  if (!includeStartupRecovery) return;

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
  sendToRenderer("play-sound", url);
}

function resetSoundCooldown() {
  lastSoundTime = 0;
}

// Sync input window position to match render window's hitbox.
// Called manually after every win position/size change + event-level safety net.
let _lastHitW = 0, _lastHitH = 0;
function syncHitWin() {
  if (!hitWin || hitWin.isDestroyed() || !win || win.isDestroyed()) return;
  const bounds = win.getBounds();
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
}

let mouseOverPet = false;
let dragLocked = false;
let menuOpen = false;
let idlePaused = false;
let forceEyeResend = false;
let themeReloadInProgress = false;

// ── Mini Mode — delegated to src/mini.js ──
// Initialized after state module (needs applyState, resolveDisplayState, etc.)
// See _mini initialization below


// ── Permission bubble — delegated to src/permission.js ──
const _permCtx = {
  get win() { return win; },
  get lang() { return lang; },
  get sessions() { return sessions; },
  get bubbleFollowPet() { return bubbleFollowPet; },
  get permDebugLog() { return permDebugLog; },
  get doNotDisturb() { return doNotDisturb; },
  get hideBubbles() { return hideBubbles; },
  get petHidden() { return petHidden; },
  getNearestWorkArea,
  getHitRectScreen,
  guardAlwaysOnTop,
  reapplyMacVisibility,
  focusTerminalForSession: (sessionId) => {
    const s = sessions.get(sessionId);
    if (s && s.sourcePid) focusTerminalWindow(s.sourcePid, s.cwd, s.editor, s.pidChain);
  },
};
const _perm = require("./permission")(_permCtx);
const { showPermissionBubble, resolvePermissionEntry, sendPermissionResponse, repositionBubbles, permLog, PASSTHROUGH_TOOLS, showCodexNotifyBubble, clearCodexNotifyBubbles, syncPermissionShortcuts, replyOpencodePermission } = _perm;
const pendingPermissions = _perm.pendingPermissions;
let permDebugLog = null; // set after app.whenReady()
let updateDebugLog = null; // set after app.whenReady()

const _updateBubbleCtx = {
  get win() { return win; },
  get bubbleFollowPet() { return bubbleFollowPet; },
  get petHidden() { return petHidden; },
  getPendingPermissions: () => pendingPermissions,
  getNearestWorkArea,
  getHitRectScreen,
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
  apply(contextMenuOwner);
}

// ── State machine — delegated to src/state.js ──
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
  set forceEyeResend(v) { forceEyeResend = v; },
  get mouseStillSince() { return _tick ? _tick._mouseStillSince : Date.now(); },
  get pendingPermissions() { return pendingPermissions; },
  get showSessionId() { return showSessionId; },
  sendToRenderer,
  sendToHitWin,
  syncHitWin,
  playSound,
  t: (key) => t(key),
  focusTerminalWindow: (...args) => focusTerminalWindow(...args),
  resolvePermissionEntry: (...args) => resolvePermissionEntry(...args),
  miniPeekIn: () => miniPeekIn(),
  miniPeekOut: () => miniPeekOut(),
  buildContextMenu: () => buildContextMenu(),
  buildTrayMenu: () => buildTrayMenu(),
};
const _state = require("./state")(_stateCtx);
const { setState, applyState, updateSession, resolveDisplayState, getSvgOverride,
        enableDoNotDisturb, disableDoNotDisturb, startStaleCleanup, stopStaleCleanup,
        startWakePoll, stopWakePoll, detectRunningAgentProcesses, buildSessionSubmenu,
        startStartupRecovery: _startStartupRecovery } = _state;
const sessions = _state.sessions;
const STATE_PRIORITY = _state.STATE_PRIORITY;

// ── Hit-test: SVG bounding box → screen coordinates ──
function getHitRectScreen(bounds) {
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

// ── Main tick — delegated to src/tick.js ──
const _tickCtx = {
  get theme() { return activeTheme; },
  get win() { return win; },
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
  set forceEyeResend(v) { forceEyeResend = v; },
  get startupRecoveryActive() { return _state.getStartupRecoveryActive(); },
  sendToRenderer,
  sendToHitWin,
  setState,
  applyState,
  miniPeekIn: () => miniPeekIn(),
  miniPeekOut: () => miniPeekOut(),
  getObjRect,
  getHitRectScreen,
};
const _tick = require("./tick")(_tickCtx);
const { startMainTick, resetIdleTimer } = _tick;

// ── Terminal focus — delegated to src/focus.js ──
const _focus = require("./focus")({ _allowSetForeground });
const { initFocusHelper, killFocusHelper, focusTerminalWindow, clearMacFocusCooldownTimer } = _focus;

// ── HTTP server — delegated to src/server.js ──
const _serverCtx = {
  get autoStartWithClaude() { return autoStartWithClaude; },
  get doNotDisturb() { return doNotDisturb; },
  get hideBubbles() { return hideBubbles; },
  get pendingPermissions() { return pendingPermissions; },
  get PASSTHROUGH_TOOLS() { return PASSTHROUGH_TOOLS; },
  get STATE_SVGS() { return _state.STATE_SVGS; },
  get sessions() { return sessions; },
  setState,
  updateSession,
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
    win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    if (hitWin && !hitWin.isDestroyed()) hitWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    forceEyeResend = true;
  }, 1000);
}

function guardAlwaysOnTop(w) {
  if (!isWin) return;
  w.on("always-on-top-changed", (_, isOnTop) => {
    if (!isOnTop && w && !w.isDestroyed()) {
      w.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
      if (w === win && !dragLocked && !_mini.getIsAnimating()) {
        forceEyeResend = true;
        const { x, y } = win.getBounds();
        win.setPosition(x + 1, y);
        win.setPosition(x, y);
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
    }
    // Keep hitWin topmost too
    if (hitWin && !hitWin.isDestroyed()) {
      hitWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    }
    for (const perm of pendingPermissions) {
      if (perm.bubble && !perm.bubble.isDestroyed() && perm.bubble.isVisible()) perm.bubble.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    }
    const updateBubbleWin = _updateBubble.getBubbleWindow();
    if (updateBubbleWin && !updateBubbleWin.isDestroyed() && updateBubbleWin.isVisible()) {
      updateBubbleWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
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
  get autoStartWithClaude() { return autoStartWithClaude; },
  set autoStartWithClaude(v) { _settingsController.applyUpdate("autoStartWithClaude", v); },
  get bubbleFollowPet() { return bubbleFollowPet; },
  set bubbleFollowPet(v) { _settingsController.applyUpdate("bubbleFollowPet", v); },
  get hideBubbles() { return hideBubbles; },
  set hideBubbles(v) { _settingsController.applyUpdate("hideBubbles", v); },
  get showSessionId() { return showSessionId; },
  set showSessionId(v) { _settingsController.applyUpdate("showSessionId", v); },
  get soundMuted() { return soundMuted; },
  set soundMuted(v) { _settingsController.applyUpdate("soundMuted", v); },
  get pendingPermissions() { return pendingPermissions; },
  repositionBubbles: () => repositionFloatingBubbles(),
  get petHidden() { return petHidden; },
  togglePetVisibility: () => togglePetVisibility(),
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
  focusTerminalWindow: (...args) => focusTerminalWindow(...args),
  checkForUpdates: (...args) => checkForUpdates(...args),
  getUpdateMenuItem: () => getUpdateMenuItem(),
  buildSessionSubmenu: () => buildSessionSubmenu(),
  // The settings controller is the only writer of persisted prefs. Toggle
  // setters above route through it; resize/sendToDisplay use
  // flushRuntimeStateToPrefs to capture window bounds after movement.
  flushRuntimeStateToPrefs,
  settings: _settingsController,
  syncHitWin,
  getCurrentPixelSize,
  isProportionalMode,
  PROPORTIONAL_RATIOS,
  getHookServerPort: () => getHookServerPort(),
  clampToScreen,
  getNearestWorkArea,
  reapplyMacVisibility,
  switchTheme: (id) => switchTheme(id),
  discoverThemes: () => themeLoader.discoverThemes(),
  getActiveThemeId: () => activeTheme ? activeTheme._id : "clawd",
  ensureUserThemesDir: () => themeLoader.ensureUserThemesDir(),
};
const _menu = require("./menu")(_menuCtx);
const { t, buildContextMenu, buildTrayMenu, rebuildAllMenus, createTray,
        destroyTray, showPetContextMenu, popupMenuAt, ensureContextMenuOwner,
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
  "lang", "soundMuted", "bubbleFollowPet", "hideBubbles", "showSessionId",
  "autoStartWithClaude", "showTray", "showDock", "theme", "size",
]);
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
    if ("autoStartWithClaude" in changes) {
      autoStartWithClaude = changes.autoStartWithClaude;
      try {
        const { registerHooks, unregisterAutoStart } = require("../hooks/install.js");
        if (changes.autoStartWithClaude) {
          registerHooks({ silent: true, autoStart: true, port: getHookServerPort() });
        } else {
          unregisterAutoStart();
        }
      } catch (err) {
        console.warn("Clawd: failed to toggle auto-start hook:", err && err.message);
      }
    }
    if ("bubbleFollowPet" in changes) bubbleFollowPet = changes.bubbleFollowPet;
    if ("hideBubbles" in changes) hideBubbles = changes.hideBubbles;
    if ("showSessionId" in changes) showSessionId = changes.showSessionId;
    if ("soundMuted" in changes) soundMuted = changes.soundMuted;

    // 2. Reactive side effects (mirror what the legacy setters / click handlers used to do).
    if ("hideBubbles" in changes) {
      try { syncPermissionShortcuts(); } catch (err) {
        console.warn("Clawd: syncPermissionShortcuts failed:", err && err.message);
      }
    }
    if ("bubbleFollowPet" in changes) {
      try { repositionFloatingBubbles(); } catch (err) {
        console.warn("Clawd: repositionFloatingBubbles failed:", err && err.message);
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
          bw.webContents.send("settings-changed", { changes });
        }
      }
    } catch (err) {
      console.warn("Clawd: settings-changed broadcast failed:", err && err.message);
    }
  });
}
wireSettingsSubscribers();

// ── IPC: settings panel write entry points ──
// Renderer-side callers (the future settings panel) use these. Menu/main code
// in this process calls _settingsController directly — no IPC round-trip.
ipcMain.handle("settings:get-snapshot", () => _settingsController.getSnapshot());
ipcMain.handle("settings:update", (_event, payload) => {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "settings:update payload must be { key, value }" };
  }
  return _settingsController.applyUpdate(payload.key, payload.value);
});
ipcMain.handle("settings:command", async (_event, payload) => {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "settings:command payload must be { action, payload }" };
  }
  return _settingsController.applyCommand(payload.action, payload.payload);
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

function createWindow() {
  // Read everything from the settings controller. The mirror caches above
  // (lang/showTray/etc.) were already initialized at module-load time, so
  // here we just need the position/mini fields plus the legacy size migration.
  const prefs = _settingsController.getSnapshot();
  // Legacy S/M/L → P:N migration. Only kicks in for prefs files that haven't
  // been touched since v0; new files always store the proportional form.
  if (SIZES[prefs.size]) {
    const wa = getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA;
    const px = SIZES[prefs.size].width;
    const ratio = Math.round(px / wa.width * 100);
    const migrated = `P:${Math.max(1, Math.min(75, ratio))}`;
    _settingsController.applyUpdate("size", migrated); // subscriber updates currentSize mirror
  }
  // macOS: apply dock visibility (default visible — but persisted state wins).
  if (isMac) {
    applyDockVisibility();
  }
  const size = getCurrentPixelSize();

  // Restore saved position, or default to bottom-right of primary display.
  // Prefs file always exists in the new architecture (defaults are hydrated
  // by prefs.load()), so the "no prefs" branch from the legacy code is gone —
  // a fresh install gets x=0, y=0 from defaults, and we treat that as "place
  // bottom-right" via the explicit zero check below.
  let startX, startY;
  if (prefs.miniMode) {
    const miniPos = _mini.restoreFromPrefs(prefs, size);
    startX = miniPos.x;
    startY = miniPos.y;
  } else if (prefs.x !== 0 || prefs.y !== 0) {
    const clamped = clampToScreen(prefs.x, prefs.y, size.width, size.height);
    startX = clamped.x;
    startY = clamped.y;
  } else {
    const workArea = getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA;
    startX = workArea.x + workArea.width - size.width - 20;
    startY = workArea.y + workArea.height - size.height - 20;
  }

  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: startX,
    y: startY,
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
        if (!win.isVisible()) win.showInactive();
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
  win.showInactive();
  // Linux WMs may reset skipTaskbar after showInactive — re-apply explicitly
  if (isLinux) win.setSkipTaskbar(true);
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
    const initBounds = win.getBounds();
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
    // Linux WMs may reset skipTaskbar after showInactive — re-apply explicitly
    if (isLinux) hitWin.setSkipTaskbar(true);
    if (isWin) {
      hitWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    }
    // macOS: apply after showInactive() — it resets NSWindowCollectionBehavior
    reapplyMacVisibility();
    hitWin.loadFile(path.join(__dirname, "hit.html"));
    if (isWin) guardAlwaysOnTop(hitWin);

    // Event-level safety net for position sync
    const syncFloatingWindows = () => {
      syncHitWin();
      if (bubbleFollowPet) repositionFloatingBubbles();
      else repositionUpdateBubble();
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
      console.error("hitWin renderer crashed:", details.reason);
      hitWin.webContents.reload();
    });
  }

  ipcMain.on("show-context-menu", showPetContextMenu);

  ipcMain.on("move-window-by", (event, dx, dy) => {
    if (_mini.getMiniMode() || _mini.getMiniTransitioning()) return;
    const { x, y } = win.getBounds();
    const size = getCurrentPixelSize();
    // During drag: allow free movement across screens, only prevent
    // the pet from going completely off-screen (keep 25% visible).
    const newX = x + dx, newY = y + dy;
    const looseClamped = looseClampToDisplays(newX, newY, size.width, size.height);
    win.setBounds({ ...looseClamped, width: size.width, height: size.height });
    syncHitWin();
    if (bubbleFollowPet) repositionFloatingBubbles();
  });

  ipcMain.on("pause-cursor-polling", () => { idlePaused = true; });
  ipcMain.on("resume-from-reaction", () => {
    idlePaused = false;
    if (_mini.getMiniTransitioning()) return;
    sendToRenderer("state-change", _state.getCurrentState(), _state.getCurrentSvg());
  });

  ipcMain.on("drag-lock", (event, locked) => {
    dragLocked = !!locked;
    if (locked) mouseOverPet = true;
  });

  // Reaction relay: hitWin → main → renderWin
  ipcMain.on("start-drag-reaction", () => sendToRenderer("start-drag-reaction"));
  ipcMain.on("end-drag-reaction", () => sendToRenderer("end-drag-reaction"));
  ipcMain.on("play-click-reaction", (_, svg, duration) => {
    sendToRenderer("play-click-reaction", svg, duration);
  });

  ipcMain.on("drag-end", () => {
    if (!_mini.getMiniMode() && !_mini.getMiniTransitioning()) {
      checkMiniModeSnap();
      // After drag, clamp to the nearest screen (loose clamp during drag allows cross-screen).
      // In proportional mode, also recalculate size for the landing display.
      if (win && !win.isDestroyed()) {
        const size = getCurrentPixelSize();
        const { x, y } = win.getBounds();
        const clamped = clampToScreen(x, y, size.width, size.height);
        win.setBounds({ ...clamped, width: size.width, height: size.height });
        syncHitWin();
        repositionUpdateBubble();
      }
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

  ipcMain.on("show-session-menu", () => {
    popupMenuAt(Menu.buildFromTemplate(buildSessionSubmenu()));
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
    if (themeReloadInProgress) return;
    syncRendererStateAfterLoad();
  });

  // ── Crash recovery: renderer process can die from <object> churn ──
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("Renderer crashed:", details.reason);
    dragLocked = false;
    idlePaused = false;
    mouseOverPet = false;
    win.webContents.reload();
  });

  guardAlwaysOnTop(win);
  startTopmostWatchdog();

  // ── Display change: re-clamp window to prevent off-screen ──
  // In proportional mode, also recalculate size based on the new work area.
  screen.on("display-metrics-changed", () => {
    reapplyMacVisibility();
    if (!win || win.isDestroyed()) return;
    if (_mini.getMiniMode()) {
      _mini.handleDisplayChange();
      return;
    }
    const size = getCurrentPixelSize();
    const { x, y } = win.getBounds();
    const clamped = clampToScreen(x, y, size.width, size.height);
    if (isProportionalMode() || clamped.x !== x || clamped.y !== y) {
      win.setBounds({ ...clamped, width: size.width, height: size.height });
      syncHitWin();
      repositionUpdateBubble();
    }
  });
  screen.on("display-removed", () => {
    reapplyMacVisibility();
    if (!win || win.isDestroyed()) return;
    if (_mini.getMiniMode()) {
      exitMiniMode();
      return;
    }
    const size = getCurrentPixelSize();
    const { x, y } = win.getBounds();
    const clamped = clampToScreen(x, y, size.width, size.height);
    win.setBounds({ ...clamped, width: size.width, height: size.height });
    syncHitWin();
    repositionUpdateBubble();
  });
  screen.on("display-added", () => {
    reapplyMacVisibility();
    repositionUpdateBubble();
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

// Loose clamp used during drag: union of all display work areas as the boundary,
// so the pet can freely cross between screens. Only prevents going fully off-screen.
function looseClampToDisplays(x, y, w, h) {
  return computeLooseClamp(screen.getAllDisplays(), getPrimaryWorkAreaSafe(), x, y, w, h);
}

function clampToScreen(x, y, w, h) {
  const nearest = getNearestWorkArea(x + w / 2, y + h / 2);
  const mLeft  = Math.round(w * 0.25);
  const mRight = Math.round(w * 0.25);
  const mTop   = Math.round(h * 0.6);
  const mBot   = Math.round(h * 0.04);
  return {
    x: Math.max(nearest.x - mLeft, Math.min(x, nearest.x + nearest.width - w + mRight)),
    y: Math.max(nearest.y - mTop,  Math.min(y, nearest.y + nearest.height - h + mBot)),
  };
}

// ── Mini Mode — initialized here after state module ──
const _miniCtx = {
  get theme() { return activeTheme; },
  get win() { return win; },
  get currentSize() { return currentSize; },
  get doNotDisturb() { return doNotDisturb; },
  set doNotDisturb(v) { doNotDisturb = v; },
  SIZES,
  getCurrentPixelSize,
  isProportionalMode,
  sendToRenderer,
  sendToHitWin,
  syncHitWin,
  applyState,
  resolveDisplayState,
  getSvgOverride,
  stopWakePoll,
  clampToScreen,
  getNearestWorkArea,
  get bubbleFollowPet() { return bubbleFollowPet; },
  get pendingPermissions() { return pendingPermissions; },
  repositionBubbles: () => repositionFloatingBubbles(),
  buildContextMenu: () => buildContextMenu(),
  buildTrayMenu: () => buildTrayMenu(),
};
const _mini = require("./mini")(_miniCtx);
const { enterMiniMode, exitMiniMode, enterMiniViaMenu, miniPeekIn, miniPeekOut,
        checkMiniModeSnap, cancelMiniTransition, animateWindowX, animateWindowParabola } = _mini;

// Convenience getters for mini state (used throughout main.js)
Object.defineProperties(this || {}, {}); // no-op placeholder
// Mini state is accessed via _mini getters in ctx objects below

// ── Theme switching ──
function switchTheme(themeId) {
  if (!win || win.isDestroyed()) return;
  if (activeTheme && activeTheme._id === themeId) return;

  // 1. Cleanup timers in all modules
  _state.cleanup();
  _tick.cleanup();
  _mini.cleanup();
  // ⚠️ Don't clear pendingPermissions — permission bubbles are independent BrowserWindows
  // ��️ Don't clear sessions — keep active session tracking
  // ��️ Don't clear displayHint — semantic tokens resolve through new theme's map

  // 2. If currently in mini mode and new theme doesn't support mini, exit first
  const newTheme = themeLoader.loadTheme(themeId);
  if (_mini.getMiniMode() && !newTheme.miniMode.supported) {
    _mini.exitMiniMode();
  }

  // 3. Update active theme
  activeTheme = newTheme;
  _mini.refreshTheme();
  _state.refreshTheme();
  _tick.refreshTheme();
  if (_mini.getMiniMode()) _mini.handleDisplayChange();

  // 4. Reload both windows
  themeReloadInProgress = true;
  win.webContents.reload();
  hitWin.webContents.reload();

  // 5. After both reloads complete, re-sync state with the new theme.
  let ready = 0;
  const onReady = () => {
    if (++ready < 2) return;
    themeReloadInProgress = false;
    syncHitStateAfterLoad();
    syncRendererStateAfterLoad({ includeStartupRecovery: false });
    syncHitWin();
    startMainTick();
  };
  win.webContents.once("did-finish-load", onReady);
  hitWin.webContents.once("did-finish-load", onReady);

  flushRuntimeStateToPrefs();
  rebuildAllMenus();
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
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // Another instance is already running — quit silently
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      win.showInactive();
      if (isLinux) win.setSkipTaskbar(true);
    }
    if (hitWin && !hitWin.isDestroyed()) {
      hitWin.showInactive();
      if (isLinux) hitWin.setSkipTaskbar(true);
    }
    reapplyMacVisibility();
  });

  // macOS: hide dock icon early if user previously disabled it
  if (isMac && app.dock) {
    if (_settingsController.get("showDock") === false) {
      app.dock.hide();
    }
  }

  app.whenReady().then(() => {
    permDebugLog = path.join(app.getPath("userData"), "permission-debug.log");
    updateDebugLog = path.join(app.getPath("userData"), "update-debug.log");
    createWindow();

    // Register global shortcut for toggling pet visibility
    registerToggleShortcut();

    // Start Codex CLI JSONL log monitor
    try {
      const CodexLogMonitor = require("../agents/codex-log-monitor");
      const codexAgent = require("../agents/codex");
      _codexMonitor = new CodexLogMonitor(codexAgent, (sid, state, event, extra) => {
        if (state === "codex-permission") {
          updateSession(sid, "notification", event, null, extra.cwd, null, null, null, "codex");
          showCodexNotifyBubble({
            sessionId: sid,
            command: extra.permissionDetail?.command || "",
          });
          return;
        }
        // Non-permission event — clear any lingering Codex notify bubbles
        clearCodexNotifyBubbles(sid);
        updateSession(sid, state, event, null, extra.cwd, null, null, null, "codex");
      });
      _codexMonitor.start();
    } catch (err) {
      console.warn("Clawd: Codex log monitor not started:", err.message);
    }

    // Start Gemini CLI session JSON monitor
    try {
      const GeminiLogMonitor = require("../agents/gemini-log-monitor");
      const geminiAgent = require("../agents/gemini-cli");
      _geminiMonitor = new GeminiLogMonitor(geminiAgent, (sid, state, event, extra) => {
        updateSession(sid, state, event, null, extra.cwd, null, null, null, "gemini-cli");
      });
      _geminiMonitor.start();
    } catch (err) {
      console.warn("Clawd: Gemini log monitor not started:", err.message);
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
    unregisterToggleShortcut();
    globalShortcut.unregisterAll();
    _perm.cleanup();
    _server.cleanup();
    _updateBubble.cleanup();
    _state.cleanup();
    _tick.cleanup();
    _mini.cleanup();
    if (_codexMonitor) _codexMonitor.stop();
    if (_geminiMonitor) _geminiMonitor.stop();
    stopTopmostWatchdog();
    if (hwndRecoveryTimer) { clearTimeout(hwndRecoveryTimer); hwndRecoveryTimer = null; }
    _focus.cleanup();
    if (hitWin && !hitWin.isDestroyed()) hitWin.destroy();
  });

  app.on("window-all-closed", () => {
    if (!isQuitting) return;
    app.quit();
  });
}
