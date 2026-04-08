const { app, BrowserWindow, screen, Menu, ipcMain, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs");

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

let lang = "en";

// ── Position persistence ──
const PREFS_PATH = path.join(app.getPath("userData"), "clawd-prefs.json");

function loadPrefs() {
  try {
    const raw = JSON.parse(fs.readFileSync(PREFS_PATH, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    // Validate miniEdge allowlist
    if (raw.miniEdge !== "left" && raw.miniEdge !== "right") raw.miniEdge = "right";
    // Sanitize numeric fields — corrupted JSON can feed NaN into window positioning
    for (const key of ["x", "y", "preMiniX", "preMiniY"]) {
      if (key in raw && (typeof raw[key] !== "number" || !isFinite(raw[key]))) {
        raw[key] = 0;
      }
    }
    return raw;
  } catch {
    return null;
  }
}

function savePrefs() {
  if (!win || win.isDestroyed()) return;
  const { x, y } = win.getBounds();
  const data = {
    x, y, size: currentSize,
    miniMode: _mini.getMiniMode(), miniEdge: _mini.getMiniEdge(), preMiniX: _mini.getPreMiniX(), preMiniY: _mini.getPreMiniY(), lang,
    showTray, showDock,
    autoStartWithClaude, bubbleFollowPet, hideBubbles, showSessionId, soundMuted,
    theme: activeTheme ? activeTheme._id : "clawd",
  };
  try { fs.writeFileSync(PREFS_PATH, JSON.stringify(data)); } catch {}
}

let _codexMonitor = null;          // Codex CLI JSONL log polling instance
let _geminiMonitor = null;         // Gemini CLI session JSON polling instance

// ── Theme loader ──
const themeLoader = require("./theme-loader");
themeLoader.init(__dirname, app.getPath("userData"));

function loadThemeFromPrefs(prefs) {
  return themeLoader.loadTheme((prefs && prefs.theme) || "clawd");
}
let activeTheme = loadThemeFromPrefs(loadPrefs());

// ── CSS <object> sizing (from theme) ──
function getObjRect(bounds) {
  const os = activeTheme.objectScale;
  return {
    x: bounds.x + bounds.width * os.offsetX,
    y: bounds.y + bounds.height * os.offsetY,
    w: bounds.width * os.widthRatio,
    h: bounds.height * os.heightRatio,
  };
}

let win;
let hitWin;  // input window — small opaque rect over hitbox, receives all pointer events
let tray = null;
let contextMenuOwner = null;
let currentSize = "P:10"; // "P:<ratio>" — pet occupies <ratio>% of work area width

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
  if (!wa) wa = screen.getPrimaryDisplay().workArea;
  const px = Math.round(wa.width * ratio / 100);
  return { width: px, height: px };
}
let contextMenu;
let doNotDisturb = false;
let isQuitting = false;
let showTray = true;
let showDock = true;
let autoStartWithClaude = false;
let bubbleFollowPet = false;
let hideBubbles = false;
let showSessionId = false;
let soundMuted = false;
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
    reapplyMacVisibility();
    petHidden = false;
  } else {
    win.hide();
    if (hitWin && !hitWin.isDestroyed()) hitWin.hide();
    // Also hide any permission bubbles
    for (const perm of pendingPermissions) {
      if (perm.bubble && !perm.bubble.isDestroyed()) perm.bubble.hide();
    }
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

// ── Sound playback ──
let lastSoundTime = 0;
const SOUND_COOLDOWN_MS = 10000;

function playSound(name) {
  if (soundMuted || doNotDisturb) return;
  const now = Date.now();
  if (now - lastSoundTime < SOUND_COOLDOWN_MS) return;
  lastSoundTime = now;
  sendToRenderer("play-sound", name);
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

// ── Mini Mode — delegated to src/mini.js ──
// Initialized after state module (needs applyState, resolveDisplayState, etc.)
// See _mini initialization below


// ── Permission bubble — delegated to src/permission.js ──
const _permCtx = {
  get win() { return win; },
  get lang() { return lang; },
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

// ── macOS fullscreen visibility helper ──
// Re-apply visibleOnAllWorkspaces + alwaysOnTop to all windows after events
// that may reset NSWindowCollectionBehavior (showInactive, dock.hide, etc.)
function reapplyMacVisibility() {
  if (!isMac) return;
  const opts = { visibleOnFullScreen: true };
  if (!showDock) opts.skipTransformProcessType = true;
  const apply = (w) => {
    if (w && !w.isDestroyed()) {
      w.setVisibleOnAllWorkspaces(true, opts);
      w.setAlwaysOnTop(true, MAC_TOPMOST_LEVEL);
    }
  };
  apply(win);
  apply(hitWin);
  for (const perm of pendingPermissions) apply(perm.bubble);
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
const STATE_SVGS = _state.STATE_SVGS;
const STATE_PRIORITY = _state.STATE_PRIORITY;

// ── Hit-test: SVG bounding box → screen coordinates ──
function getHitRectScreen(bounds) {
  const obj = getObjRect(bounds);
  const vb = activeTheme.viewBox;
  const scale = Math.min(obj.w, obj.h) / vb.width;
  const offsetX = obj.x + (obj.w - vb.width * scale) / 2;
  const offsetY = obj.y + (obj.h - vb.height * scale) / 2;
  const hb = _state.getCurrentHitBox();
  return {
    left:   offsetX + (hb.x + -vb.x) * scale,
    top:    offsetY + (hb.y + -vb.y) * scale,
    right:  offsetX + (hb.x + -vb.x + hb.w) * scale,
    bottom: offsetY + (hb.y + -vb.y + hb.h) * scale,
  };
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
  get STATE_SVGS() { return STATE_SVGS; },
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
const _menuCtx = {
  get win() { return win; },
  get sessions() { return sessions; },
  get currentSize() { return currentSize; },
  set currentSize(v) { currentSize = v; },
  get doNotDisturb() { return doNotDisturb; },
  get lang() { return lang; },
  set lang(v) { lang = v; },
  get showTray() { return showTray; },
  set showTray(v) { showTray = v; },
  get showDock() { return showDock; },
  set showDock(v) { showDock = v; },
  get autoStartWithClaude() { return autoStartWithClaude; },
  set autoStartWithClaude(v) { autoStartWithClaude = v; },
  get bubbleFollowPet() { return bubbleFollowPet; },
  set bubbleFollowPet(v) { bubbleFollowPet = v; },
  get hideBubbles() { return hideBubbles; },
  set hideBubbles(v) { hideBubbles = v; syncPermissionShortcuts(); },
  get showSessionId() { return showSessionId; },
  set showSessionId(v) { showSessionId = v; },
  get soundMuted() { return soundMuted; },
  set soundMuted(v) { soundMuted = v; },
  get pendingPermissions() { return pendingPermissions; },
  repositionBubbles: () => repositionBubbles(),
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
  savePrefs,
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
        showPetContextMenu, popupMenuAt, ensureContextMenuOwner,
        requestAppQuit, resizeWindow, applyDockVisibility } = _menu;

// ── Auto-updater — delegated to src/updater.js ──
const _updaterCtx = {
  get doNotDisturb() { return doNotDisturb; },
  get miniMode() { return _mini.getMiniMode(); },
  t, rebuildAllMenus, updateLog,
};
const _updater = require("./updater")(_updaterCtx);
const { setupAutoUpdater, checkForUpdates, getUpdateMenuItem, getUpdateMenuLabel } = _updater;

function createWindow() {
  const prefs = loadPrefs();
  if (prefs && isProportionalMode(prefs.size)) {
    currentSize = prefs.size;
  } else if (prefs && SIZES[prefs.size]) {
    // Migrate legacy S/M/L to proportional mode
    const wa = screen.getPrimaryDisplay().workArea;
    const px = SIZES[prefs.size].width;
    const ratio = Math.round(px / wa.width * 100);
    currentSize = `P:${Math.max(1, Math.min(75, ratio))}`;
  }
  if (prefs && (prefs.lang === "en" || prefs.lang === "zh")) lang = prefs.lang;
  // macOS: restore tray/dock visibility from prefs
  if (isMac && prefs) {
    if (typeof prefs.showTray === "boolean") showTray = prefs.showTray;
    if (typeof prefs.showDock === "boolean") showDock = prefs.showDock;
  }
  if (prefs && typeof prefs.autoStartWithClaude === "boolean") autoStartWithClaude = prefs.autoStartWithClaude;
  if (prefs && typeof prefs.bubbleFollowPet === "boolean") bubbleFollowPet = prefs.bubbleFollowPet;
  if (prefs && typeof prefs.hideBubbles === "boolean") hideBubbles = prefs.hideBubbles;
  if (prefs && typeof prefs.showSessionId === "boolean") showSessionId = prefs.showSessionId;
  if (prefs && typeof prefs.soundMuted === "boolean") soundMuted = prefs.soundMuted;
  // macOS: apply dock visibility (default hidden)
  if (isMac) {
    applyDockVisibility();
  }
  const size = getCurrentPixelSize();

  // Restore saved position, or default to bottom-right of primary display
  let startX, startY;
  if (prefs && prefs.miniMode) {
    // Restore mini mode
    const miniPos = _mini.restoreFromPrefs(prefs, size);
    startX = miniPos.x;
    startY = miniPos.y;
  } else if (prefs) {
    const clamped = clampToScreen(prefs.x, prefs.y, size.width, size.height);
    startX = clamped.x;
    startY = clamped.y;
  } else {
    const { workArea } = screen.getPrimaryDisplay();
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
    win.on("move", syncHitWin);
    win.on("resize", syncHitWin);

    // Send initial state to hitWin once it's ready
    hitWin.webContents.on("did-finish-load", () => {
      sendToHitWin("hit-state-sync", {
        currentSvg: _state.getCurrentSvg(), miniMode: _mini.getMiniMode(), dndEnabled: doNotDisturb,
      });
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
    if (bubbleFollowPet && pendingPermissions.length) repositionBubbles();
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

  initFocusHelper();
  startMainTick();
  startHttpServer();
  startStaleCleanup();
  // Wait for renderer to be ready before sending initial state
  // If hooks arrived during startup, respect them instead of forcing idle
  // Also handles crash recovery (render-process-gone → reload)
  win.webContents.on("did-finish-load", () => {
    if (_mini.getMiniMode()) {
      sendToRenderer("mini-mode-change", true, _mini.getMiniEdge());
    sendToHitWin("hit-state-sync", { miniMode: true });
    }
    if (doNotDisturb) {
      sendToRenderer("dnd-change", true);
    sendToHitWin("hit-state-sync", { dndEnabled: true });
      if (_mini.getMiniMode()) {
        applyState("mini-sleep");
      } else {
        applyState("sleeping");
      }
    } else if (_mini.getMiniMode()) {
      applyState("mini-idle");
    } else if (sessions.size > 0) {
      const resolved = resolveDisplayState();
      applyState(resolved, getSvgOverride(resolved));
    } else {
      applyState("idle", "clawd-idle-follow.svg");
      // Startup recovery: delay 5s to let HWND/z-order/drag systems stabilize,
      // then detect running Claude Code processes → suppress sleep sequence
      setTimeout(() => {
        if (sessions.size > 0 || doNotDisturb) return; // hook arrived during wait
        detectRunningAgentProcesses((found) => {
          if (found && sessions.size === 0 && !doNotDisturb) {
            _startStartupRecovery();
            resetIdleTimer();
          }
        });
      }, 5000);
    }
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
  });
  screen.on("display-added", () => {
    reapplyMacVisibility();
  });
}

function getNearestWorkArea(cx, cy) {
  const displays = screen.getAllDisplays();
  let nearest = displays[0].workArea;
  let minDist = Infinity;
  for (const d of displays) {
    const wa = d.workArea;
    const dx = Math.max(wa.x - cx, 0, cx - (wa.x + wa.width));
    const dy = Math.max(wa.y - cy, 0, cy - (wa.y + wa.height));
    const dist = dx * dx + dy * dy;
    if (dist < minDist) { minDist = dist; nearest = wa; }
  }
  return nearest;
}

// Loose clamp used during drag: union of all display work areas as the boundary,
// so the pet can freely cross between screens. Only prevents going fully off-screen.
function looseClampToDisplays(x, y, w, h) {
  const displays = screen.getAllDisplays();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of displays) {
    const wa = d.workArea;
    if (wa.x < minX) minX = wa.x;
    if (wa.y < minY) minY = wa.y;
    if (wa.x + wa.width > maxX) maxX = wa.x + wa.width;
    if (wa.y + wa.height > maxY) maxY = wa.y + wa.height;
  }
  const margin = Math.round(w * 0.25);
  return {
    x: Math.max(minX - margin, Math.min(x, maxX - w + margin)),
    y: Math.max(minY - margin, Math.min(y, maxY - h + margin)),
  };
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
  repositionBubbles: () => repositionBubbles(),
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

  const rendererConfig = themeLoader.getRendererConfig();
  const hitConfig = themeLoader.getHitRendererConfig();

  // 4. Reload both windows
  win.webContents.reload();
  hitWin.webContents.reload();

  // 5. After reload completes, push new config via IPC + restart tick
  let ready = 0;
  const onReady = () => {
    if (++ready < 2) return;
    // Re-apply current state so renderer shows correct animation
    const { state, svg } = resolveDisplayState();
    sendToRenderer("state-change", state, svg);
    syncHitWin();
    startMainTick();
  };
  win.webContents.once("did-finish-load", () => {
    win.webContents.send("theme-config", rendererConfig);
    onReady();
  });
  hitWin.webContents.once("did-finish-load", () => {
    hitWin.webContents.send("theme-config", hitConfig);
    onReady();
  });

  savePrefs();
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
    const prefs = loadPrefs();
    if (prefs && prefs.showDock === false) {
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
          permLog(`codex-permission detected: sid=${sid} event=${event} pid=${extra.agentPid || "?"} cmd=${(extra.permissionDetail?.command || "").slice(0, 120)}`);
          updateSession(
            sid,
            "notification",
            event,
            extra.sourcePid || null,
            extra.cwd,
            null,
            null,
            extra.agentPid || null,
            "codex"
          );
          showCodexNotifyBubble({
            sessionId: sid,
            command: extra.permissionDetail?.command || "",
            codexPid: extra.agentPid || null,
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
    savePrefs();
    unregisterToggleShortcut();
    globalShortcut.unregisterAll();
    _perm.cleanup();
    _server.cleanup();
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
