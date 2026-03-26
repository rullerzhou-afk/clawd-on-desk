const { app, BrowserWindow, screen, Menu, Tray, ipcMain, nativeImage, dialog, shell } = require("electron");
const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");

const isMac = process.platform === "darwin";


// ── Windows: AllowSetForegroundWindow via FFI ──
let _allowSetForeground = null;
if (!isMac) {
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

// ── Internationalization ──
const i18n = {
  en: {
    size: "Size",
    small: "Small (S)",
    medium: "Medium (M)",
    large: "Large (L)",
    miniMode: "Mini Mode",
    exitMiniMode: "Exit Mini Mode",
    sleep: "Sleep (Do Not Disturb)",
    wake: "Wake Clawd",
    startOnLogin: "Start on Login",
    startWithClaude: "Start with Claude Code",
    showInMenuBar: "Show in Menu Bar",
    showInDock: "Show in Dock",
    language: "Language",
    checkForUpdates: "Check for Updates",
    checkingForUpdates: "Checking for Updates…",
    updateAvailable: "Update Available",
    updateAvailableMsg: "v{version} is available. Download and install now?",
    updateAvailableMacMsg: "v{version} is available. Open the download page?",
    updateNotAvailable: "You're Up to Date",
    updateNotAvailableMsg: "Clawd v{version} is the latest version.",
    updateDownloading: "Downloading Update…",
    updateReady: "Update Ready",
    updateReadyMsg: "v{version} has been downloaded. Restart now to update?",
    updateError: "Update Error",
    updateErrorMsg: "Failed to check for updates. Please try again later.",
    restartNow: "Restart Now",
    restartLater: "Later",
    download: "Download",
    sessions: "Sessions",
    noSessions: "No active sessions",
    sessionWorking: "Working",
    sessionThinking: "Thinking",
    sessionJuggling: "Juggling",
    sessionIdle: "Idle",
    sessionSleeping: "Sleeping",
    sessionJustNow: "just now",
    sessionMinAgo: "{n}m ago",
    sessionHrAgo: "{n}h ago",
    quit: "Quit",
  },
  zh: {
    size: "大小",
    small: "小 (S)",
    medium: "中 (M)",
    large: "大 (L)",
    miniMode: "极简模式",
    exitMiniMode: "退出极简模式",
    sleep: "休眠（免打扰）",
    wake: "唤醒 Clawd",
    startOnLogin: "开机自启",
    startWithClaude: "随 Claude Code 启动",
    showInMenuBar: "在菜单栏显示",
    showInDock: "在 Dock 显示",
    language: "语言",
    checkForUpdates: "检查更新",
    checkingForUpdates: "正在检查更新…",
    updateAvailable: "发现新版本",
    updateAvailableMsg: "v{version} 已发布，是否下载并安装？",
    updateAvailableMacMsg: "v{version} 已发布，是否打开下载页面？",
    updateNotAvailable: "已是最新版本",
    updateNotAvailableMsg: "Clawd v{version} 已是最新版本。",
    updateDownloading: "正在下载更新…",
    updateReady: "更新就绪",
    updateReadyMsg: "v{version} 已下载完成，是否立即重启以完成更新？",
    updateError: "更新失败",
    updateErrorMsg: "检查更新失败，请稍后再试。",
    restartNow: "立即重启",
    restartLater: "稍后",
    download: "下载",
    sessions: "会话",
    noSessions: "无活跃会话",
    sessionWorking: "工作中",
    sessionThinking: "思考中",
    sessionJuggling: "多任务",
    sessionIdle: "空闲",
    sessionSleeping: "睡眠",
    sessionJustNow: "刚刚",
    sessionMinAgo: "{n}分钟前",
    sessionHrAgo: "{n}小时前",
    quit: "退出",
  },
};
let lang = "en";
function t(key) { return (i18n[lang] || i18n.en)[key] || key; }

// ── Position persistence ──
const PREFS_PATH = path.join(app.getPath("userData"), "clawd-prefs.json");

function loadPrefs() {
  try {
    const raw = JSON.parse(fs.readFileSync(PREFS_PATH, "utf8"));
    if (!raw || typeof raw !== "object") return null;
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
    miniMode, preMiniX, preMiniY, lang,
    showTray, showDock,
    autoStartWithClaude,
  };
  try { fs.writeFileSync(PREFS_PATH, JSON.stringify(data)); } catch {}
}

// ── SVG filename constants (used across main + renderer via IPC) ──
const SVG_IDLE_FOLLOW = "clawd-idle-follow.svg";
const SVG_IDLE_LOOK = "clawd-idle-look.svg";
const SVG_IDLE_LIVING = "clawd-idle-living.svg";

// ── State → SVG mapping ──
const STATE_SVGS = {
  idle: [SVG_IDLE_FOLLOW, SVG_IDLE_LIVING],
  yawning: ["clawd-idle-yawn.svg"],
  dozing: ["clawd-idle-doze.svg"],
  collapsing: ["clawd-collapse-sleep.svg"],
  thinking: ["clawd-working-thinking.svg"],
  working: ["clawd-working-typing.svg"],
  juggling: ["clawd-working-juggling.svg"],
  sweeping: ["clawd-working-sweeping.svg"],
  error: ["clawd-error.svg"],
  attention: ["clawd-happy.svg"],
  notification: ["clawd-notification.svg"],
  carrying: ["clawd-working-carrying.svg"],
  sleeping: ["clawd-sleeping.svg"],
  waking: ["clawd-wake.svg"],
};

// Mini mode SVG mappings
STATE_SVGS["mini-idle"]  = ["clawd-mini-idle.svg"];
STATE_SVGS["mini-alert"] = ["clawd-mini-alert.svg"];
STATE_SVGS["mini-happy"] = ["clawd-mini-happy.svg"];
STATE_SVGS["mini-enter"] = ["clawd-mini-enter.svg"];
STATE_SVGS["mini-peek"]  = ["clawd-mini-peek.svg"];
STATE_SVGS["mini-crabwalk"] = ["clawd-mini-crabwalk.svg"];
STATE_SVGS["mini-enter-sleep"] = ["clawd-mini-enter-sleep.svg"];
STATE_SVGS["mini-sleep"] = ["clawd-mini-sleep.svg"];

const MIN_DISPLAY_MS = {
  attention: 4000,
  error: 5000,
  sweeping: 2000,
  notification: 4000,
  carrying: 3000,
  working: 1000,
  thinking: 1000,
  "mini-alert": 4000,
  "mini-happy": 4000,
};

// Oneshot states that auto-return to idle (subset of MIN_DISPLAY_MS)
const AUTO_RETURN_MS = {
  attention: 4000,
  error: 5000,
  sweeping: 300000,  // 5min safety; PostCompact ends sweeping normally
  notification: 4000,  // matches SVG animation loop (4s)
  carrying: 3000,
  "mini-alert": 4000,
  "mini-happy": 4000,
};

const MOUSE_IDLE_TIMEOUT = 20000;   // 20s → idle-look
const MOUSE_SLEEP_TIMEOUT = 60000;  // 60s → yawning → dozing
const DEEP_SLEEP_TIMEOUT = 600000;  // 10min → collapsing → sleeping
const YAWN_DURATION = 3000;
const COLLAPSE_DURATION = 800;
const WAKE_DURATION = 1500;
const IDLE_LOOK_DURATION = 10000;  // idle-look CSS loop is 10s
const SLEEP_SEQUENCE = new Set(["yawning", "dozing", "collapsing", "sleeping", "waking"]);

// ── Session tracking ──
const sessions = new Map(); // session_id → { state, updatedAt, sourcePid, cwd, editor, pidChain, agentPid, agentId, pidReachable }
const SESSION_STALE_MS = 600000; // 10 min: delete idle sessions entirely
const WORKING_STALE_MS = 300000; // 5 min: working/thinking with no new event → decay to idle
let startupRecoveryActive = false; // suppress sleep sequence while waiting for hooks after restart
let startupRecoveryTimer = null;   // hard timeout to clear startupRecoveryActive
let _codexMonitor = null;          // Codex CLI JSONL log polling instance
const STARTUP_RECOVERY_MAX_MS = 300000; // 5 min: give up waiting for hooks
const STATE_PRIORITY = {
  error: 8, notification: 7, sweeping: 6, attention: 5,
  carrying: 4, juggling: 4, working: 3, thinking: 2, idle: 1, sleeping: 0,
};

// ── CSS <object> sizing (mirrors styles.css #clawd) ──
const OBJ_SCALE_W = 1.9;   // width: 190%
const OBJ_SCALE_H = 1.3;   // height: 130%
const OBJ_OFF_X   = -0.45; // left: -45%
const OBJ_OFF_Y   = -0.25; // top: -25%

function getObjRect(bounds) {
  return {
    x: bounds.x + bounds.width * OBJ_OFF_X,
    y: bounds.y + bounds.height * OBJ_OFF_Y,
    w: bounds.width * OBJ_SCALE_W,
    h: bounds.height * OBJ_SCALE_H,
  };
}

// ── Hit-test bounding boxes (SVG coordinate system) ──
const HIT_BOXES = {
  default:  { x: -1, y: 5, w: 17, h: 12 },   // 站姿：身体+腿+手臂
  sleeping: { x: -2, y: 9, w: 19, h: 7 },     // 趴姿：更宽更矮
  wide:     { x: -3, y: 3, w: 21, h: 14 },    // 带特效（error/building/notification）
};
const WIDE_SVGS = new Set(["clawd-error.svg", "clawd-working-building.svg", "clawd-notification.svg", "clawd-working-conducting.svg"]);
let currentHitBox = HIT_BOXES.default;

let win;
let hitWin;  // input window — small opaque rect over hitbox, receives all pointer events
let tray = null;
let contextMenuOwner = null;
let currentSize = "S";
let contextMenu;
let doNotDisturb = false;
let isQuitting = false;
let showTray = true;
let showDock = true;
let autoStartWithClaude = false;

function sendToRenderer(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}
function sendToHitWin(channel, ...args) {
  if (hitWin && !hitWin.isDestroyed()) hitWin.webContents.send(channel, ...args);
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

// ── State machine ──
let currentState = "idle";
let currentSvg = null;
let stateChangedAt = Date.now();
let pendingTimer = null;
let autoReturnTimer = null;
let mainTickTimer = null;
let mouseOverPet = false;
let dragLocked = false;
let menuOpen = false;
let idlePaused = false;
let idleWasActive = false;
let lastEyeDx = 0, lastEyeDy = 0;
let forceEyeResend = false;
let eyeResendTimer = null;

// ── Mini Mode ──
const MINI_OFFSET_RATIO = 0.486;
const PEEK_OFFSET = 25;
const SNAP_TOLERANCE = 30;
const JUMP_PEAK_HEIGHT = 40;
const JUMP_DURATION = 350;
const CRABWALK_SPEED = 0.12;  // px/ms

let miniMode = false;
let miniTransitioning = false;
let miniSleepPeeked = false;
let preMiniX = 0, preMiniY = 0;
let currentMiniX = 0;
let miniSnap = null;  // { y, width, height } — canonical rect to prevent DPI drift
let miniTransitionTimer = null;
let peekAnimTimer = null;
let isAnimating = false;


// ── Mouse idle tracking ──
let lastCursorX = null, lastCursorY = null;
let mouseStillSince = Date.now();
let isMouseIdle = false;       // showing idle-look
let hasTriggeredYawn = false;  // 60s threshold already fired
let idleLookPlayed = false;    // idle-look already played once since last movement
let idleLookReturnTimer = null;
let yawnDelayTimer = null;     // tracked setTimeout for yawn/idle-look transitions

// ── Wake poll (during dozing) ──
let wakePollTimer = null;
let lastWakeCursorX = null, lastWakeCursorY = null;

let pendingState = null; // tracks what state is waiting in pendingTimer

// ── Permission bubble (stacking) ──
// Each entry: { res, abortHandler, suggestions, sessionId, bubble, hideTimer, toolName, toolInput, resolvedSuggestion, createdAt, measuredHeight }
const pendingPermissions = [];
// Pure-metadata tools auto-allowed without showing a bubble (zero side effects)
const PASSTHROUGH_TOOLS = new Set([
  "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TaskStop", "TaskOutput",
]);
let permDebugLog = null; // set after app.whenReady()
let updateDebugLog = null; // set after app.whenReady()

function setState(newState, svgOverride) {
  if (doNotDisturb) return;

  // Oneshot events from hooks should always wake from sleep —
  // any hook event means Claude Code is active, Clawd shouldn't stay asleep.

  // Don't re-enter sleep sequence when already in it
  if (newState === "yawning" && SLEEP_SEQUENCE.has(currentState)) return;

  // Don't displace a pending higher-priority state with a lower-priority one
  if (pendingTimer) {
    if (pendingState && (STATE_PRIORITY[newState] || 0) < (STATE_PRIORITY[pendingState] || 0)) {
      return;
    }
    clearTimeout(pendingTimer);
    pendingTimer = null;
    pendingState = null;
  }

  const sameState = newState === currentState;
  const sameSvg = !svgOverride || svgOverride === currentSvg;
  if (sameState && sameSvg) {
    return;
  }

  const minTime = MIN_DISPLAY_MS[currentState] || 0;
  const elapsed = Date.now() - stateChangedAt;
  const remaining = minTime - elapsed;

  if (remaining > 0) {
    // Cancel current state's auto-return to prevent timer race
    if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
    pendingState = newState;
    const pendingSvgOverride = svgOverride;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      const queued = pendingState;
      const queuedSvg = pendingSvgOverride;
      pendingState = null;
      // Oneshot states (error/notification/etc.) are not stored in sessions,
      // so re-resolving would lose them. Apply the queued state directly.
      if (ONESHOT_STATES.has(queued)) {
        applyState(queued, queuedSvg);
      } else {
        // For persistent states, re-resolve from live sessions — the captured
        // state may be stale (e.g. SessionEnd arrived while we waited)
        const resolved = resolveDisplayState();
        applyState(resolved, getSvgOverride(resolved));
      }
    }, remaining);
  } else {
    applyState(newState, svgOverride);
  }
}

function applyState(state, svgOverride) {
  // Mini transition protection: only allow mini-* states through
  if (miniTransitioning && !state.startsWith("mini-")) {
    return;
  }

  // Mini mode interception: redirect to mini variants
  if (miniMode && !state.startsWith("mini-")) {
    if (state === "notification") return applyState("mini-alert");
    if (state === "attention") return applyState("mini-happy");
    // Other states are silent in mini mode — but if we're stuck in a
    // oneshot mini state whose auto-return timer was cancelled (e.g. by
    // setState's pending logic), recover to mini-idle/mini-peek now.
    if (AUTO_RETURN_MS[currentState] && !autoReturnTimer) {
      return applyState(mouseOverPet ? "mini-peek" : "mini-idle");
    }
    return;
  }

  currentState = state;
  stateChangedAt = Date.now();
  idlePaused = false;

  const svgs = STATE_SVGS[state] || STATE_SVGS.idle;
  const svg = svgOverride || svgs[Math.floor(Math.random() * svgs.length)];
  currentSvg = svg;

  // Force eye resend after SVG load completes (~300ms)
  if (eyeResendTimer) { clearTimeout(eyeResendTimer); eyeResendTimer = null; }
  if (state === "idle" || state === "mini-idle") {
    eyeResendTimer = setTimeout(() => { eyeResendTimer = null; forceEyeResend = true; }, 300);
  }

  // Update hit box based on SVG
  if (svg === "clawd-sleeping.svg" || svg === "clawd-collapse-sleep.svg") {
    currentHitBox = HIT_BOXES.sleeping;
  } else if (WIDE_SVGS.has(svg)) {
    currentHitBox = HIT_BOXES.wide;
  } else {
    currentHitBox = HIT_BOXES.default;
  }

  sendToRenderer("state-change", state, svg);
  // Sync hitWin position/size to match new hitbox + state
  syncHitWin();
  sendToHitWin("hit-state-sync", { currentSvg: svg });
  sendToHitWin("hit-cancel-reaction");

  // Reset eyes when leaving idle/mini-idle
  if (state !== "idle" && state !== "mini-idle") {
    sendToRenderer("eye-move", 0, 0);
  }

  // Wake poll: dozing, collapsing, sleeping (not DND sleeping)
  if ((state === "dozing" || state === "collapsing" || state === "sleeping") && !doNotDisturb) {
    setTimeout(() => {
      if (currentState === state) startWakePoll();
    }, 500);
  } else {
    stopWakePoll();
  }

  // Sleep/doze sequence: yawning → dozing; waking → resolve session state
  if (autoReturnTimer) clearTimeout(autoReturnTimer);
  if (state === "yawning") {
    autoReturnTimer = setTimeout(() => {
      autoReturnTimer = null;
      applyState(doNotDisturb ? "collapsing" : "dozing");
    }, YAWN_DURATION);
  } else if (state === "waking") {
    autoReturnTimer = setTimeout(() => {
      autoReturnTimer = null;
      const resolved = resolveDisplayState();
      applyState(resolved, getSvgOverride(resolved));
    }, WAKE_DURATION);
  } else if (AUTO_RETURN_MS[state]) {
    autoReturnTimer = setTimeout(() => {
      autoReturnTimer = null;
      if (miniMode) {
        if (mouseOverPet && !doNotDisturb) {
          miniPeekIn();
          applyState("mini-peek");
        } else {
          applyState(doNotDisturb ? "mini-sleep" : "mini-idle");
        }
      } else {
        const resolved = resolveDisplayState();
        applyState(resolved, getSvgOverride(resolved));
      }
    }, AUTO_RETURN_MS[state]);
  }
}

// ── Hit-test: SVG bounding box → screen coordinates ──
function getHitRectScreen(bounds) {
  const obj = getObjRect(bounds);

  // viewBox="-15 -25 45 45", preserveAspectRatio default xMidYMid meet
  const scale = Math.min(obj.w, obj.h) / 45;
  const offsetX = obj.x + (obj.w - 45 * scale) / 2;
  const offsetY = obj.y + (obj.h - 45 * scale) / 2;

  const hb = currentHitBox;
  return {
    left:   offsetX + (hb.x + 15) * scale,
    top:    offsetY + (hb.y + 25) * scale,
    right:  offsetX + (hb.x + 15 + hb.w) * scale,
    bottom: offsetY + (hb.y + 25 + hb.h) * scale,
  };
}

// ── Unified main tick (cursor polling for eye tracking + sleep + mini peek) ──
// Input routing is handled by hitWin — no setIgnoreMouseEvents toggling here.
function startMainTick() {
  if (mainTickTimer) return;
  // Render window: permanently click-through (set once, never toggle)
  win.setIgnoreMouseEvents(true);
  mouseOverPet = false;

  mainTickTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();

    // ── Cursor-over-pet tracking (for mini peek + eye tracking, NOT for input routing) ──
    const bounds = win.getBounds();
    if (!dragLocked) {
      const hit = getHitRectScreen(bounds);
      const over = cursor.x >= hit.left && cursor.x <= hit.right
                && cursor.y >= hit.top  && cursor.y <= hit.bottom;
      mouseOverPet = over;
    }

    // ── Mini mode peek hover ──
    if (miniMode && !miniTransitioning && !dragLocked && !menuOpen) {
      const canPeek = currentState === "mini-idle" || currentState === "mini-peek"
        || currentState === "mini-sleep";
      if (!isAnimating && canPeek) {
        if (mouseOverPet && currentState === "mini-sleep" && !miniSleepPeeked) {
          miniPeekIn();
          miniSleepPeeked = true;
        } else if (!mouseOverPet && currentState === "mini-sleep" && miniSleepPeeked) {
          miniPeekOut();
          miniSleepPeeked = false;
        } else if (mouseOverPet && currentState !== "mini-peek" && currentState !== "mini-sleep") {
          miniPeekIn();
          applyState("mini-peek");
        } else if (!mouseOverPet && currentState === "mini-peek") {
          miniPeekOut();
          applyState("mini-idle");
        }
      }
    }

    // ── Eye tracking + sleep detection (idle only, not during reactions) ──
    const idleNow = currentState === "idle" && !idlePaused;
    const miniIdleNow = currentState === "mini-idle" && !idlePaused && !miniTransitioning;

    // Edge detection: idle entry → reset state variables
    if (idleNow && !idleWasActive) {
      isMouseIdle = false;
      hasTriggeredYawn = false;
      idleLookPlayed = false;
      lastCursorX = null;
      lastCursorY = null;
      mouseStillSince = Date.now();
      lastEyeDx = 0;
      lastEyeDy = 0;
      if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
      if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
    }

    // Edge detection: idle exit → clear pending timers
    // (variable resets not needed here — idle entry will overwrite them all)
    if (!idleNow && idleWasActive) {
      if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
      if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
    }
    idleWasActive = idleNow;

    if (!idleNow && !miniIdleNow) return;

    // ── Below: idle or mini-idle logic ──
    const moved = lastCursorX !== null && (cursor.x !== lastCursorX || cursor.y !== lastCursorY);
    lastCursorX = cursor.x;
    lastCursorY = cursor.y;

    // Normal idle: mouse idle detection + sleep sequence
    if (idleNow) {
      if (moved) {
        mouseStillSince = Date.now();
        hasTriggeredYawn = false;
        idleLookPlayed = false;
        if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
        if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
        if (isMouseIdle) {
          isMouseIdle = false;
          sendToRenderer("state-change", "idle", SVG_IDLE_FOLLOW);
        }
      }

      const elapsed = Date.now() - mouseStillSince;

      // Startup recovery: Claude Code is running but no hook yet — stay awake
      // Only suppress sleep sequence, don't skip eye tracking below
      if (startupRecoveryActive) {
        mouseStillSince = Date.now();
      }

      // 60s no mouse movement → yawning → dozing
      if (!hasTriggeredYawn && elapsed >= MOUSE_SLEEP_TIMEOUT) {
        hasTriggeredYawn = true;
        if (!isMouseIdle) sendToRenderer("eye-move", 0, 0);
        yawnDelayTimer = setTimeout(() => {
          yawnDelayTimer = null;
          if (currentState === "idle") setState("yawning");
        }, isMouseIdle ? 50 : 250);
        return;
      }

      // 20s no mouse movement → idle-look (play once, then return)
      if (!isMouseIdle && !hasTriggeredYawn && !idleLookPlayed && elapsed >= MOUSE_IDLE_TIMEOUT) {
        isMouseIdle = true;
        idleLookPlayed = true;
        sendToRenderer("eye-move", 0, 0);
        setTimeout(() => {
          if (isMouseIdle && currentState === "idle") {
            sendToRenderer("state-change", "idle", SVG_IDLE_LOOK);
          }
        }, 250);
        idleLookReturnTimer = setTimeout(() => {
          idleLookReturnTimer = null;
          if (isMouseIdle && currentState === "idle") {
            isMouseIdle = false;
            sendToRenderer("state-change", "idle", SVG_IDLE_FOLLOW);
            setTimeout(() => { forceEyeResend = true; }, 200);
          }
        }, 250 + IDLE_LOOK_DURATION);
        return;
      }
    }

    const trackEyesNow = (idleNow && currentSvg === SVG_IDLE_FOLLOW && !isMouseIdle) || miniIdleNow;
    if (!trackEyesNow) return;
    if (!moved && !forceEyeResend) return;

    // ── Eye position calculation (shared by idle and mini-idle) ──
    const skipDedup = forceEyeResend;
    forceEyeResend = false;

    const obj = getObjRect(bounds);
    const eyeScreenX = obj.x + obj.w * (22 / 45);
    const eyeScreenY = obj.y + obj.h * (34 / 45);

    const relX = cursor.x - eyeScreenX;
    const relY = cursor.y - eyeScreenY;

    const MAX_OFFSET = 3;
    const dist = Math.sqrt(relX * relX + relY * relY);
    let eyeDx = 0, eyeDy = 0;
    if (dist > 1) {
      const scale = Math.min(1, dist / 300);
      eyeDx = (relX / dist) * MAX_OFFSET * scale;
      eyeDy = (relY / dist) * MAX_OFFSET * scale;
    }

    eyeDx = Math.round(eyeDx * 2) / 2;
    eyeDy = Math.round(eyeDy * 2) / 2;
    eyeDy = Math.max(-1.5, Math.min(1.5, eyeDy));

    if (skipDedup || eyeDx !== lastEyeDx || eyeDy !== lastEyeDy) {
      lastEyeDx = eyeDx;
      lastEyeDy = eyeDy;
      sendToRenderer("eye-move", eyeDx, eyeDy);
    }
  }, 50); // ~20fps — hit-test needs faster response than 67ms eye tracking
}

// ── Wake poll (detect mouse movement during dozing → wake up) ──
function startWakePoll() {
  if (wakePollTimer) return;
  const cursor = screen.getCursorScreenPoint();
  lastWakeCursorX = cursor.x;
  lastWakeCursorY = cursor.y;

  wakePollTimer = setInterval(() => {
    const cursor = screen.getCursorScreenPoint();
    const moved = cursor.x !== lastWakeCursorX || cursor.y !== lastWakeCursorY;

    if (moved) {
      stopWakePoll();
      wakeFromDoze();
      return;
    }

    // 10min total mouse idle → deep sleep (only from dozing, not sleeping)
    if (currentState === "dozing" && Date.now() - mouseStillSince >= DEEP_SLEEP_TIMEOUT) {
      stopWakePoll();
      applyState("collapsing");
    }
  }, 200); // 5 checks/sec, lightweight
}

function stopWakePoll() {
  if (wakePollTimer) { clearInterval(wakePollTimer); wakePollTimer = null; }
}

function wakeFromDoze() {
  if (currentState === "sleeping" || currentState === "collapsing") {
    applyState("waking");
    return;
  }
  sendToRenderer("wake-from-doze");
  // After eye-opening transition, switch to idle
  setTimeout(() => {
    if (currentState === "dozing") {
      applyState("idle", SVG_IDLE_FOLLOW);
    }
  }, 350);
}

// ── Session management ──
const ONESHOT_STATES = new Set(["attention", "error", "sweeping", "notification", "carrying"]);

function updateSession(sessionId, state, event, sourcePid, cwd, editor, pidChain, agentPid, agentId) {
  // Agent is communicating — no need for startup recovery
  if (startupRecoveryActive) {
    startupRecoveryActive = false;
    if (startupRecoveryTimer) { clearTimeout(startupRecoveryTimer); startupRecoveryTimer = null; }
  }

  // PermissionRequest command hook: show notification animation only, don't mutate session.
  // The HTTP hook runs in parallel and handles the actual decision. If we set session to idle
  // here, it can overwrite a newer "working" state after the user approves.
  if (event === "PermissionRequest") {
    setState("notification");
    return;
  }

  // Preserve existing fields — only SessionStart sends them all, other events reuse cached
  const existing = sessions.get(sessionId);
  const srcPid = sourcePid || (existing && existing.sourcePid) || null;
  const srcCwd = cwd || (existing && existing.cwd) || "";
  const srcEditor = editor || (existing && existing.editor) || null;
  const srcPidChain = (pidChain && pidChain.length) ? pidChain : (existing && existing.pidChain) || null;
  const srcAgentPid = agentPid || (existing && existing.agentPid) || null;
  const srcAgentId = agentId || (existing && existing.agentId) || null;

  // WSL2/remote: PID from hook may be a Linux PID unreachable on Windows.
  // Check once on session creation; if unreachable, skip PID liveness checks later.
  const pidReachable = existing ? existing.pidReachable :
    (srcAgentPid ? isProcessAlive(srcAgentPid) : (srcPid ? isProcessAlive(srcPid) : false));

  const base = { sourcePid: srcPid, cwd: srcCwd, editor: srcEditor, pidChain: srcPidChain, agentPid: srcAgentPid, agentId: srcAgentId, pidReachable };

  if (event === "SessionEnd") {
    sessions.delete(sessionId);
  } else if (state === "attention" || state === "notification" || SLEEP_SEQUENCE.has(state)) {
    // Stop/notification/sleep: session goes idle — if work continues, new hooks will re-set
    sessions.set(sessionId, { state: "idle", updatedAt: Date.now(), ...base });
  } else if (ONESHOT_STATES.has(state)) {
    // Other oneshots (error/sweeping/notification/carrying):
    // preserve session's previous state so auto-return resolves correctly
    if (existing) {
      existing.updatedAt = Date.now();
      if (sourcePid) existing.sourcePid = sourcePid;
      if (cwd) existing.cwd = cwd;
      if (editor) existing.editor = editor;
      if (pidChain && pidChain.length) existing.pidChain = pidChain;
      if (agentPid) existing.agentPid = agentPid;
    } else {
      sessions.set(sessionId, { state: "idle", updatedAt: Date.now(), ...base });
    }
  } else {
    // Preserve juggling: subagent's own tool use (PreToolUse/PostToolUse)
    // shouldn't override juggling — only SubagentStop should end it.
    if (existing && existing.state === "juggling" && state === "working" && event !== "SubagentStop" && event !== "subagentStop") {
      existing.updatedAt = Date.now();
    } else {
      sessions.set(sessionId, { state, updatedAt: Date.now(), ...base });
    }
  }
  cleanStaleSessions();

  // All sessions ended → sleep immediately
  if (sessions.size === 0 && event === "SessionEnd") {
    setState("sleeping");
    return;
  }

  // Oneshot: show animation directly, auto-return will re-resolve from session map
  if (ONESHOT_STATES.has(state)) {
    setState(state);
    return;
  }

  const displayState = resolveDisplayState();
  setState(displayState, getSvgOverride(displayState));
}

let staleCleanupTimer = null;

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function cleanStaleSessions() {
  const now = Date.now();
  let changed = false;
  for (const [id, s] of sessions) {
    const age = now - s.updatedAt;

    // Agent process dead → orphan session, delete immediately
    // Skip PID check for WSL2/remote sessions where PIDs are unreachable
    if (s.pidReachable && s.agentPid && !isProcessAlive(s.agentPid)) {
      sessions.delete(id); changed = true;
      continue;
    }

    if (age > SESSION_STALE_MS) {
      // Very stale (5 min): PID check or delete
      if (s.pidReachable && s.sourcePid) {
        if (!isProcessAlive(s.sourcePid)) {
          sessions.delete(id); changed = true;
        } else if (s.state !== "idle") {
          s.state = "idle"; changed = true;
        }
      } else if (!s.pidReachable) {
        // Remote session: rely purely on timeout
        sessions.delete(id); changed = true;
      } else {
        sessions.delete(id); changed = true;
      }
    } else if (age > WORKING_STALE_MS) {
      // Moderately stale (5 min): check if terminal was closed
      if (s.pidReachable && s.sourcePid && !isProcessAlive(s.sourcePid)) {
        sessions.delete(id); changed = true;
      } else if (s.state === "working" || s.state === "juggling" || s.state === "thinking") {
        // No hook event for 5 min while busy → likely interrupted or stalled
        s.state = "idle"; s.updatedAt = now; changed = true;
      }
    }
    // Sessions updated recently: skip — recent hook events prove liveness
  }
  // If stale sessions were cleaned, re-resolve display state
  if (changed && sessions.size === 0) {
    setState("yawning");
  } else if (changed) {
    const resolved = resolveDisplayState();
    setState(resolved, getSvgOverride(resolved));
  }

  // Startup recovery: recheck if Claude Code is still running
  if (startupRecoveryActive && sessions.size === 0) {
    detectRunningAgentProcesses((found) => {
      if (!found) {
        startupRecoveryActive = false;
        if (startupRecoveryTimer) { clearTimeout(startupRecoveryTimer); startupRecoveryTimer = null; }
      }
    });
  }
}

// Detect running agent processes (async, for startup recovery).
// Matches Claude Code (native + node), Codex CLI, and Copilot CLI.
let _detectInFlight = false;
function detectRunningAgentProcesses(callback) {
  if (_detectInFlight) return;
  _detectInFlight = true;
  const done = (result) => { _detectInFlight = false; callback(result); };
  const { exec } = require("child_process");
  if (process.platform === "win32") {
    exec(
      'wmic process where "(Name=\'node.exe\' and CommandLine like \'%claude-code%\') or Name=\'claude.exe\' or Name=\'codex.exe\' or Name=\'copilot.exe\'" get ProcessId /format:csv',
      { encoding: "utf8", timeout: 5000, windowsHide: true },
      (err, stdout) => done(!err && /\d+/.test(stdout))
    );
  } else {
    exec("pgrep -f 'claude-code|codex|copilot'", { timeout: 3000 },
      (err) => done(!err)
    );
  }
}

function startStaleCleanup() {
  if (staleCleanupTimer) return;
  staleCleanupTimer = setInterval(cleanStaleSessions, 10000); // every 10s
}

function stopStaleCleanup() {
  if (staleCleanupTimer) { clearInterval(staleCleanupTimer); staleCleanupTimer = null; }
}

function resolveDisplayState() {
  if (sessions.size === 0) return "idle";
  let best = "sleeping";
  for (const [, s] of sessions) {
    if ((STATE_PRIORITY[s.state] || 0) > (STATE_PRIORITY[best] || 0)) best = s.state;
  }
  return best;
}

function getActiveWorkingCount() {
  let n = 0;
  for (const [, s] of sessions) {
    if (s.state === "working" || s.state === "thinking" || s.state === "juggling") n++;
  }
  return n;
}

function getWorkingSvg() {
  const n = getActiveWorkingCount();
  if (n >= 3) return "clawd-working-building.svg";
  if (n >= 2) return "clawd-working-juggling.svg";
  return "clawd-working-typing.svg";
}

function getSvgOverride(state) {
  if (state === "idle") return SVG_IDLE_FOLLOW;
  if (state === "working") return getWorkingSvg();
  if (state === "juggling") return getJugglingSvg();
  return null;
}

function getJugglingSvg() {
  let n = 0;
  for (const [, s] of sessions) {
    if (s.state === "juggling") n++;
  }
  return n >= 2 ? "clawd-working-conducting.svg" : "clawd-working-juggling.svg";
}

// ── Session Dashboard (submenu for context menu + hotkey) ──
const STATE_EMOJI = {
  working: "\u{1F528}", thinking: "\u{1F914}", juggling: "\u{1F939}",
  idle: "\u{1F4A4}", sleeping: "\u{1F4A4}",
};
const STATE_LABEL_KEY = {
  working: "sessionWorking", thinking: "sessionThinking", juggling: "sessionJuggling",
  idle: "sessionIdle", sleeping: "sessionSleeping",
};

function formatElapsed(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return t("sessionJustNow");
  const min = Math.floor(sec / 60);
  if (min < 60) return t("sessionMinAgo").replace("{n}", min);
  const hr = Math.floor(min / 60);
  return t("sessionHrAgo").replace("{n}", hr);
}

function buildSessionSubmenu() {
  // Collect sessions, sorted by priority desc then updatedAt desc
  const entries = [];
  for (const [id, s] of sessions) {
    entries.push({ id, state: s.state, updatedAt: s.updatedAt, sourcePid: s.sourcePid, cwd: s.cwd, editor: s.editor, pidChain: s.pidChain });
  }
  if (entries.length === 0) {
    return [{ label: t("noSessions"), enabled: false }];
  }
  entries.sort((a, b) => {
    const pa = STATE_PRIORITY[a.state] || 0;
    const pb = STATE_PRIORITY[b.state] || 0;
    if (pb !== pa) return pb - pa;
    return b.updatedAt - a.updatedAt;
  });

  const now = Date.now();
  return entries.map((e) => {
    const emoji = STATE_EMOJI[e.state] || "";
    const stateText = t(STATE_LABEL_KEY[e.state] || "sessionIdle");
    const name = e.cwd ? path.basename(e.cwd) : (e.id.length > 6 ? e.id.slice(0, 6) + ".." : e.id);
    const elapsed = formatElapsed(now - e.updatedAt);
    const hasPid = !!e.sourcePid;
    return {
      label: `${emoji} ${name}  ${stateText}  ${elapsed}`,
      enabled: hasPid,
      click: hasPid ? () => focusTerminalWindow(e.sourcePid, e.cwd, e.editor, e.pidChain) : undefined,
    };
  });
}

// ── Do Not Disturb ──
function enableDoNotDisturb() {
  if (doNotDisturb) return;
  doNotDisturb = true;
  sendToRenderer("dnd-change", true);
    sendToHitWin("hit-state-sync", { dndEnabled: true });
  // Dismiss all pending permission bubbles — DND means no interaction
  for (const perm of [...pendingPermissions]) resolvePermissionEntry(perm, "deny", "DND enabled");
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; pendingState = null; }
  if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
  stopWakePoll();
  if (miniMode) {
    applyState("mini-sleep");
  } else {
    applyState("yawning");  // walk through yawning → collapsing → sleeping
  }
  buildContextMenu();
  buildTrayMenu();
}

function disableDoNotDisturb() {
  if (!doNotDisturb) return;
  doNotDisturb = false;
  sendToRenderer("dnd-change", false);
    sendToHitWin("hit-state-sync", { dndEnabled: false });
  if (miniMode) {
    if (miniSleepPeeked) { miniPeekOut(); miniSleepPeeked = false; }
    applyState("mini-idle");
  } else {
    applyState("waking");
  }
  buildContextMenu();
  buildTrayMenu();
}

// ── Terminal focus (click pet → activate terminal window) ──
// Uses a persistent PowerShell process to avoid cold-start delay on each click.
// Add-Type compiles the C# interop once at startup; subsequent focus calls are near-instant.
const { execFile, spawn } = require("child_process");

const PS_FOCUS_ADDTYPE = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinFocus {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int maxCount);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    public static void Focus(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return;
        if (IsIconic(hWnd)) ShowWindow(hWnd, 9);
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        SetForegroundWindow(hWnd);
    }
    public static IntPtr FindByPidTitle(uint targetPid, string sub) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hWnd, _) => {
            if (!IsWindowVisible(hWnd)) return true;
            uint pid; GetWindowThreadProcessId(hWnd, out pid);
            if (pid != targetPid) return true;
            int len = GetWindowTextLength(hWnd);
            if (len == 0) return true;
            var sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            if (sb.ToString().IndexOf(sub, StringComparison.OrdinalIgnoreCase) >= 0) {
                found = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@
`;

function makeFocusCmd(sourcePid, cwdCandidates) {
  // Walk up the process tree (same proven logic as before).
  // When we find the process with MainWindowHandle, try title-matching first
  // to support multi-window editors (Cursor/VS Code). Fall back to MainWindowHandle.
  // Base64-encode cwd candidates so CJK/Unicode chars survive the Node→PowerShell
  // stdin pipe (PowerShell 5.1 reads stdin as system codepage, not UTF-8).
  const psNames = cwdCandidates.length
    ? cwdCandidates.map(c => {
        const b64 = Buffer.from(c, "utf8").toString("base64");
        return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`;
      }).join(",")
    : "";
  const titleMatchBlock = psNames ? `
        $matched = $false
        foreach ($name in @(${psNames})) {
            $hwnd = [WinFocus]::FindByPidTitle([uint32]$curPid, $name)
            if ($hwnd -ne [IntPtr]::Zero) {
                [WinFocus]::Focus($hwnd); $matched = $true; break
            }
        }
        if ($matched) { $focused = $true; break }` : "";
  // Windows Terminal fallback: same title matching but against WT windows
  const wtTitleMatch = psNames ? `
    $wtProcs = Get-Process -Name 'WindowsTerminal' -ErrorAction SilentlyContinue
    foreach ($wt in $wtProcs) {
        if ($wt.MainWindowHandle -eq 0) { continue }
        foreach ($name in @(${psNames})) {
            $hwnd = [WinFocus]::FindByPidTitle([uint32]$wt.Id, $name)
            if ($hwnd -ne [IntPtr]::Zero) {
                [WinFocus]::Focus($hwnd); $focused = $true; break
            }
        }
        if ($focused) { break }
    }` : "";

  return `
$curPid = ${sourcePid}
$focused = $false
for ($i = 0; $i -lt 8; $i++) {
    $proc = Get-Process -Id $curPid -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.ProcessName -eq 'explorer') { break }
    if ($proc.MainWindowHandle -ne 0) {${titleMatchBlock}
        [WinFocus]::Focus($proc.MainWindowHandle)
        $focused = $true
        break
    }
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$curPid" -ErrorAction SilentlyContinue
    if (-not $cim -or $cim.ParentProcessId -eq 0 -or $cim.ParentProcessId -eq $curPid) { break }
    $curPid = $cim.ParentProcessId
}
if (-not $focused) {${wtTitleMatch}
    if (-not $focused) {
        $wt = Get-Process -Name 'WindowsTerminal' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($wt -and $wt.MainWindowHandle -ne 0) { [WinFocus]::Focus($wt.MainWindowHandle) }
    }
}
`;
}

// Persistent PowerShell process — warm at startup, reused for all focus calls
let psProc = null;

function initFocusHelper() {
  if (isMac || psProc) return;
  psProc = spawn("powershell.exe", ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", "-"], {
    windowsHide: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  // Set UTF-8 input encoding so Chinese/CJK window titles match correctly,
  // then pre-compile the C# type (once, ~500ms, non-blocking)
  psProc.on("error", () => { psProc = null; }); // Spawn failure (powershell.exe not found, etc.)
  psProc.stdin.on("error", () => {}); // Suppress EPIPE if process exits unexpectedly
  psProc.stdin.write("[Console]::InputEncoding = [System.Text.Encoding]::UTF8\n");
  psProc.stdin.write(PS_FOCUS_ADDTYPE + "\n");
  psProc.on("exit", () => { psProc = null; });
  psProc.unref(); // Don't keep the app alive for this
}

function killFocusHelper() {
  if (psProc) { psProc.kill(); psProc = null; }
}

function focusTerminalWindow(sourcePid, cwd, editor, pidChain) {
  if (!sourcePid) return;

  // Grant PowerShell helper permission to call SetForegroundWindow.
  // This must happen HERE — Electron just received user input (click/hotkey),
  // so it has foreground privilege to delegate.
  if (_allowSetForeground && psProc && psProc.pid) {
    try { _allowSetForeground(psProc.pid); } catch {}
  }

  // Legacy focus for reliable window activation (ALT key trick + SetForegroundWindow)
  focusTerminalWindowLegacy(sourcePid, cwd);

  // VS Code / Cursor: request precise terminal tab switch via extension's HTTP server.
  // Delayed so legacy PowerShell focus completes first (it's fire-and-forget via stdin).
  if (editor && pidChain && pidChain.length) {
    setTimeout(() => {
      const body = JSON.stringify({ pids: pidChain });
      for (let port = 23456; port <= 23460; port++) {
        const tabReq = http.request({
          hostname: "127.0.0.1", port, path: "/focus-tab", method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
          timeout: 300,
        }, () => {});
        tabReq.on("error", () => {});
        tabReq.on("timeout", () => tabReq.destroy());
        tabReq.end(body);
      }
    }, 800);
  }
}

function focusTerminalWindowLegacy(sourcePid, cwd) {
  // Build candidate folder names from cwd for title matching (deepest first).
  // e.g. "C:\Users\X\GPT_Test\redbook" → ['redbook', 'GPT_Test']
  // Cursor window title typically shows workspace root, which may not be the deepest folder.
  const cwdCandidates = [];
  if (cwd) {
    let dir = cwd;
    for (let i = 0; i < 3; i++) {
      const name = path.basename(dir);
      if (!name || name === dir || /^[A-Z]:$/i.test(name)) break;
      cwdCandidates.push(name);
      dir = path.dirname(dir);
    }
  }
  if (isMac) {
    const script = `
      set pid to ${sourcePid}
      repeat 8 times
        try
          set pInfo to do shell script "ps -o ppid=,comm= -p " & pid
          set ppid to (word 1 of pInfo) as integer
          tell application "System Events"
            set pList to every process whose unix id is pid
            if (count of pList) > 0 then
              set frontmost of item 1 of pList to true
              return
            end if
          end tell
          if ppid is less than or equal to 1 then exit repeat
          set pid to ppid
        on error
          exit repeat
        end try
      end repeat`;
    execFile("osascript", ["-e", script], { timeout: 5000 }, (err) => {
      if (err) console.warn("focusTerminal macOS failed:", err.message);
    });
    return;
  }

  // Windows: send command to persistent PowerShell process (near-instant)
  const cmd = makeFocusCmd(sourcePid, cwdCandidates);
  if (psProc && psProc.stdin.writable) {
    psProc.stdin.write(cmd + "\n");
  } else {
    // Fallback: one-shot PowerShell if persistent process died
    psProc = null;
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      PS_FOCUS_ADDTYPE + cmd],
      { windowsHide: true, timeout: 5000 },
      (err) => { if (err) console.warn("focusTerminal failed:", err.message); }
    );
    // Re-init persistent process for next call
    initFocusHelper();
  }
}

// ── HTTP server ──
let httpServer = null;

function startHttpServer() {
  httpServer = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/state") {
      let body = "";
      let bodySize = 0;
      let destroyed = false;
      req.on("data", (chunk) => {
        bodySize += chunk.length;
        if (bodySize > 1024) { destroyed = true; req.destroy(); return; }
        body += chunk;
      });
      req.on("end", () => {
        if (destroyed) return;
        try {
          const data = JSON.parse(body);
          const { state, svg, session_id, event } = data;
          const source_pid = Number.isFinite(data.source_pid) && data.source_pid > 0 ? Math.floor(data.source_pid) : null;
          const cwd = typeof data.cwd === "string" ? data.cwd : "";
          const editor = (data.editor === "code" || data.editor === "cursor") ? data.editor : null;
          const pidChain = Array.isArray(data.pid_chain) ? data.pid_chain.filter(n => Number.isFinite(n) && n > 0) : null;
          // agent_pid (new) takes precedence over claude_pid (backward compat)
          const rawAgentPid = data.agent_pid ?? data.claude_pid;
          const agentPid = Number.isFinite(rawAgentPid) && rawAgentPid > 0 ? Math.floor(rawAgentPid) : null;
          const agentId = typeof data.agent_id === "string" ? data.agent_id : "claude-code";
          if (STATE_SVGS[state]) {
            const sid = session_id || "default";
            // mini-* states are internal — only allow via direct SVG override (test scripts)
            if (state.startsWith("mini-") && !svg) {
              res.writeHead(400);
              res.end("mini states require svg override");
              return;
            }
            // Detect "user answered in terminal": only PostToolUse/PostToolUseFailure
            // reliably indicate the tool ran or was rejected (i.e. permission resolved).
            // Other events (PreToolUse, Notification, etc.) are too noisy — late hooks
            // from previous tool calls cause false dismissals.
            if (event === "PostToolUse" || event === "PostToolUseFailure" || event === "Stop") {
              for (const perm of [...pendingPermissions]) {
                if (perm.sessionId === sid) {
                  resolvePermissionEntry(perm, "deny", "User answered in terminal");
                }
              }
            }
            if (svg) {
              // Direct SVG override (test-demo.sh, manual curl) — bypass session logic
              // Sanitize: strip path separators to prevent directory traversal
              const safeSvg = path.basename(svg);
              setState(state, safeSvg);
            } else {
              updateSession(sid, state, event, source_pid, cwd, editor, pidChain, agentPid, agentId);
            }
            res.writeHead(200);
            res.end("ok");
          } else {
            res.writeHead(400);
            res.end("unknown state");
          }
        } catch {
          res.writeHead(400);
          res.end("bad json");
        }
      });
    } else if (req.method === "POST" && req.url === "/permission") {
      // ── Permission HTTP hook — Claude Code sends PermissionRequest here ──
      permLog(`/permission hit | DND=${doNotDisturb} pending=${pendingPermissions.length}`);
      let body = "";
      let bodySize = 0;
      let destroyed = false;
      req.on("data", (chunk) => {
        bodySize += chunk.length;
        if (bodySize > 8192) { destroyed = true; req.destroy(); return; }
        body += chunk;
      });
      req.on("end", () => {
        if (destroyed) return;

        // DND mode: explicitly deny so Claude Code falls back to terminal prompt
        if (doNotDisturb) {
          permLog("SKIPPED: DND mode");
          sendPermissionResponse(res, "deny", "Clawd is in Do Not Disturb mode");
          return;
        }

        try {
          const data = JSON.parse(body);
          const toolName = typeof data.tool_name === "string" ? data.tool_name : "Unknown";
          const toolInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
          const sessionId = data.session_id || "default";
          const suggestions = Array.isArray(data.permission_suggestions) ? data.permission_suggestions : [];

          if (PASSTHROUGH_TOOLS.has(toolName)) {
            permLog(`PASSTHROUGH: tool=${toolName} session=${sessionId}`);
            sendPermissionResponse(res, "allow");
            return;
          }

          // Detect client disconnect (e.g. Claude Code timeout or user answered in terminal).
          const permEntry = { res, abortHandler: null, suggestions, sessionId, bubble: null, hideTimer: null, toolName, toolInput, resolvedSuggestion: null, createdAt: Date.now() };
          const abortHandler = () => {
            if (res.writableFinished) return;
            permLog("abortHandler fired");
            resolvePermissionEntry(permEntry, "deny", "Client disconnected");
          };
          permEntry.abortHandler = abortHandler;
          res.on("close", abortHandler);

          pendingPermissions.push(permEntry);

          permLog(`showing bubble: tool=${toolName} session=${sessionId} suggestions=${suggestions.length} stack=${pendingPermissions.length}`);
          showPermissionBubble(permEntry);
        } catch {
          res.writeHead(400);
          res.end("bad json");
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  httpServer.listen(23333, "127.0.0.1", () => {
    console.log("Clawd state server listening on 127.0.0.1:23333");
  });

  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn("Port 23333 is in use — running in idle-only mode (no state sync)");
    } else {
      console.error("HTTP server error:", err.message);
    }
  });
}

// ── alwaysOnTop recovery (Windows DWM / Shell can strip TOPMOST flag) ──
// The "always-on-top-changed" event only fires from Electron's own SetAlwaysOnTop
// path — it does NOT fire when Explorer/Start menu/Gallery silently reorder windows.
// So we keep the event listener for the cases it does catch (Alt/Win key), and add
// a slow watchdog (20s) to recover from silent shell-initiated z-order drops.
const WIN_TOPMOST_LEVEL = "pop-up-menu";  // above taskbar-level UI
const TOPMOST_WATCHDOG_MS = 5_000;
let topmostWatchdog = null;
let hwndRecoveryTimer = null;

// Reinitialize HWND input routing after DWM z-order disruptions.
// showInactive() (ShowWindow SW_SHOWNOACTIVATE) is the same call that makes
// the right-click context menu restore drag capability — it forces Windows to
// fully recalculate the transparent window's input target region.
function scheduleHwndRecovery() {
  if (isMac) return;
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
  if (isMac) return;
  w.on("always-on-top-changed", (_, isOnTop) => {
    if (!isOnTop && w && !w.isDestroyed()) {
      w.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
      if (w === win && !dragLocked) {
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
  if (isMac || topmostWatchdog) return;
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

// ── Permission bubble window ──



// Fallback height before renderer reports actual measurement
function estimateBubbleHeight(sugCount) {
  return 200 + (sugCount || 0) * 37;
}

function repositionBubbles() {
  // Stack bubbles from bottom-right upward. Newest (last in array) at bottom.
  const margin = 8;
  const gap = 6;
  const bw = 340;
  const petBounds = win.getBounds();
  const cx = petBounds.x + petBounds.width / 2;
  const cy = petBounds.y + petBounds.height / 2;
  const wa = getNearestWorkArea(cx, cy);
  const x = wa.x + wa.width - bw - margin;

  let yBottom = wa.y + wa.height - margin;
  // Iterate in reverse: newest bubble (end of array) gets the bottom slot
  for (let i = pendingPermissions.length - 1; i >= 0; i--) {
    const perm = pendingPermissions[i];
    const bh = perm.measuredHeight || estimateBubbleHeight((perm.suggestions || []).length);
    const y = yBottom - bh;
    yBottom = y - gap;
    if (perm.bubble && !perm.bubble.isDestroyed()) {
      perm.bubble.setBounds({ x, y, width: bw, height: bh });
    }
  }
}

function showPermissionBubble(permEntry) {
  const sugCount = (permEntry.suggestions || []).length;
  const bh = estimateBubbleHeight(sugCount);
  // Temporary position — repositionBubbles() will finalize after renderer reports real height
  const pos = { x: 0, y: 0, width: 340, height: bh };

  const bub = new BrowserWindow({
    width: pos.width,
    height: pos.height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-bubble.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  permEntry.bubble = bub;

  if (isMac) {
    bub.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    bub.setAlwaysOnTop(true, "floating");
  } else {
    bub.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
  }

  bub.loadFile(path.join(__dirname, "bubble.html"));

  bub.webContents.once("did-finish-load", () => {
    bub.webContents.send("permission-show", {
      toolName: permEntry.toolName,
      toolInput: permEntry.toolInput,
      suggestions: permEntry.suggestions || [],
      lang,
    });
    // Don't call bub.focus() — it steals focus from terminal and can trigger
    // false "User answered in terminal" denials in Claude Code, wasting tokens.
  });

  repositionBubbles();
  bub.showInactive();

  bub.on("closed", () => {
    const idx = pendingPermissions.indexOf(permEntry);
    if (idx !== -1) {
      resolvePermissionEntry(permEntry, "deny", "Bubble window closed by user");
    }
  });

  guardAlwaysOnTop(bub);
}

function resolvePermissionEntry(permEntry, behavior, message) {
  const idx = pendingPermissions.indexOf(permEntry);
  if (idx === -1) return;
  pendingPermissions.splice(idx, 1);

  const { res, abortHandler, bubble: bub } = permEntry;
  if (abortHandler) res.removeListener("close", abortHandler);

  // Hide this bubble (fade out + destroy)
  if (bub && !bub.isDestroyed()) {
    bub.webContents.send("permission-hide");
    if (permEntry.hideTimer) clearTimeout(permEntry.hideTimer);
    permEntry.hideTimer = setTimeout(() => {
      if (bub && !bub.isDestroyed()) bub.destroy();
    }, 250);
  }

  // Reposition remaining bubbles to fill the gap
  repositionBubbles();

  // Guard: client may have disconnected
  if (res.writableEnded || res.destroyed) return;

  const decision = { behavior: behavior === "deny" ? "deny" : "allow" };
  if (behavior === "deny" && message) decision.message = message;
  if (permEntry.resolvedSuggestion) {
    decision.updatedPermissions = [permEntry.resolvedSuggestion];
  }

  sendPermissionResponse(res, decision);
}

function permLog(msg) {
  if (!permDebugLog) return;
  fs.appendFileSync(permDebugLog, `[${new Date().toISOString()}] ${msg}\n`);
}

function updateLog(msg) {
  if (!updateDebugLog) return;
  fs.appendFileSync(updateDebugLog, `[${new Date().toISOString()}] ${msg}\n`);
}

function sendPermissionResponse(res, decisionOrBehavior, message) {
  let decision;
  if (typeof decisionOrBehavior === "string") {
    decision = { behavior: decisionOrBehavior };
    if (message) decision.message = message;
  } else {
    decision = decisionOrBehavior;
  }
  const responseBody = JSON.stringify({
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision },
  });
  permLog(`response: ${responseBody}`);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(responseBody);
}

// ── System tray ──
function createTray() {
  if (tray) return;
  let icon;
  if (isMac) {
    icon = nativeImage.createFromPath(path.join(__dirname, "../assets/tray-iconTemplate.png"));
    icon.setTemplateImage(true);
  } else {
    icon = nativeImage.createFromPath(path.join(__dirname, "../assets/tray-icon.png")).resize({ width: 32, height: 32 });
  }
  tray = new Tray(icon);
  tray.setToolTip("Clawd Desktop Pet");
  buildTrayMenu();
}

function destroyTray() {
  if (!tray) return;
  tray.destroy();
  tray = null;
}

function setShowTray(val) {
  // Prevent disabling both Menu Bar and Dock — app would become unquittable
  if (!val && !showDock) return;
  showTray = val;
  if (showTray) {
    createTray();
  } else {
    destroyTray();
  }
  buildContextMenu();
  savePrefs();
}

function applyDockVisibility() {
  if (!isMac) return;
  if (showDock) {
    app.setActivationPolicy("regular");
    if (app.dock) app.dock.show();
  } else {
    app.setActivationPolicy("accessory");
    if (app.dock) app.dock.hide();
  }
}

function setShowDock(val) {
  if (!isMac || !app.dock) return;
  // Prevent disabling both Dock and Menu Bar — app would become unquittable
  if (!val && !showTray) return;
  showDock = val;
  applyDockVisibility();
  buildTrayMenu();
  buildContextMenu();
  savePrefs();
}

function buildTrayMenu() {
  if (!tray) return;
  const items = [
    {
      label: doNotDisturb ? t("wake") : t("sleep"),
      click: () => doNotDisturb ? disableDoNotDisturb() : enableDoNotDisturb(),
    },
    { type: "separator" },
    {
      label: t("startOnLogin"),
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
      },
    },
    {
      label: t("startWithClaude"),
      type: "checkbox",
      checked: autoStartWithClaude,
      click: (menuItem) => {
        autoStartWithClaude = menuItem.checked;
        try {
          const { registerHooks, unregisterAutoStart } = require("../hooks/install.js");
          if (autoStartWithClaude) {
            registerHooks({ silent: true, autoStart: true });
          } else {
            unregisterAutoStart();
          }
        } catch (err) {
          console.warn("Clawd: failed to toggle auto-start hook:", err.message);
        }
        savePrefs();
      },
    },
  ];
  // macOS: Dock and Menu Bar visibility toggles
  if (isMac) {
    items.push(
      { type: "separator" },
      {
        label: t("showInMenuBar"),
        type: "checkbox",
        checked: showTray,
        enabled: showTray ? showDock : true, // can't uncheck if Dock is already hidden
        click: (menuItem) => setShowTray(menuItem.checked),
      },
      {
        label: t("showInDock"),
        type: "checkbox",
        checked: showDock,
        enabled: showDock ? showTray : true, // can't uncheck if Menu Bar is already hidden
        click: (menuItem) => setShowDock(menuItem.checked),
      },
    );
  }
  items.push(
    { type: "separator" },
    getUpdateMenuItem(),
    { type: "separator" },
    {
      label: t("language"),
      submenu: [
        { label: "English", type: "radio", checked: lang === "en", click: () => setLanguage("en") },
        { label: "中文", type: "radio", checked: lang === "zh", click: () => setLanguage("zh") },
      ],
    },
    { type: "separator" },
    { label: t("quit"), click: () => requestAppQuit() },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ── Auto-updater (lazy-loaded to avoid slowing startup) ──
let _autoUpdater = null;
function getAutoUpdater() {
  if (!_autoUpdater) {
    try {
      _autoUpdater = require("electron-updater").autoUpdater;
      _autoUpdater.autoDownload = false;
      _autoUpdater.autoInstallOnAppQuit = true;
      updateLog("Auto-updater initialized successfully");
    } catch (err) {
      const errMsg = `electron-updater load failed: ${err.message}`;
      console.warn("Clawd:", errMsg);
      updateLog(`ERROR: ${errMsg}`);
      updateLog(`Stack: ${err.stack}`);
      return null;
    }
  }
  return _autoUpdater;
}

let updateStatus = "idle"; // idle | checking | available | downloading | ready | error

function setupAutoUpdater() {
  const autoUpdater = getAutoUpdater();
  if (!autoUpdater) {
    updateLog("setupAutoUpdater: autoUpdater is null, skipping event setup");
    return;
  }
  updateLog("Setting up auto-updater event handlers");

  autoUpdater.on("update-available", (info) => {
    updateLog(`Update available: v${info.version} (current: v${app.getVersion()})`);
    const wasManual = manualUpdateCheck;
    manualUpdateCheck = false;
    // Silent check during DND/mini: skip dialog, stay idle so user can check later
    if (!wasManual && (doNotDisturb || miniMode)) {
      updateLog("Silent mode (DND/mini), skipping dialog");
      return;
    }
    updateStatus = "available";
    rebuildAllMenus();
    if (isMac) {
      // macOS: no code signing → can't auto-update, open GitHub Releases page instead
      updateLog("macOS detected: will open GitHub Releases page");
      dialog.showMessageBox({
        type: "info",
        title: t("updateAvailable"),
        message: t("updateAvailableMacMsg").replace("{version}", info.version),
        buttons: [t("download"), t("restartLater")],
        defaultId: 0,
        noLink: true,
      }).then(({ response }) => {
        if (response === 0) {
          updateLog("User chose to download, opening GitHub Releases");
          shell.openExternal("https://github.com/rullerzhou-afk/clawd-on-desk/releases/latest");
        } else {
          updateLog("User chose to download later");
        }
        updateStatus = "idle";
        rebuildAllMenus();
      });
    } else {
      // Windows: auto-download
      updateLog("Windows detected: will offer auto-download");
      dialog.showMessageBox({
        type: "info",
        title: t("updateAvailable"),
        message: t("updateAvailableMsg").replace("{version}", info.version),
        buttons: [t("download"), t("restartLater")],
        defaultId: 0,
        noLink: true,
      }).then(({ response }) => {
        if (response === 0) {
          updateLog("User chose to download, starting download");
          updateStatus = "downloading";
          rebuildAllMenus();
          autoUpdater.downloadUpdate();
        } else {
          updateLog("User chose to download later");
          updateStatus = "idle";
          rebuildAllMenus();
        }
      });
    }
  });

  autoUpdater.on("update-not-available", (info) => {
    updateLog(`No update available: current v${app.getVersion()} is latest`);
    updateStatus = "idle";
    rebuildAllMenus();
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      updateLog("Showing 'up to date' dialog");
      dialog.showMessageBox({
        type: "info",
        title: t("updateNotAvailable"),
        message: t("updateNotAvailableMsg").replace("{version}", app.getVersion()),
        noLink: true,
      });
    }
  });

  autoUpdater.on("update-downloaded", (info) => {
    updateLog(`Update downloaded: v${info.version}`);
    updateStatus = "ready";
    rebuildAllMenus();
    dialog.showMessageBox({
      type: "info",
      title: t("updateReady"),
      message: t("updateReadyMsg").replace("{version}", info.version),
      buttons: [t("restartNow"), t("restartLater")],
      defaultId: 0,
      noLink: true,
    }).then(({ response }) => {
      if (response === 0) {
        updateLog("User chose to restart now");
        autoUpdater.quitAndInstall(false, true);
      } else {
        updateLog("User chose to restart later");
      }
    });
  });

  autoUpdater.on("error", (err) => {
    updateLog(`ERROR: AutoUpdater error: ${err.message}`);
    updateLog(`Error code: ${err.code || 'none'}`);
    updateLog(`Error stack: ${err.stack}`);

    // Note: 404 errors during download might mean:
    // 1. Release files not uploaded yet (check GitHub first)
    // 2. Real network error
    // Since we now check GitHub API first, 404 here likely means
    // the release exists but files aren't ready
    updateStatus = "error";
    rebuildAllMenus();

    // For auto-checks (not manual), just log silently
    if (!manualUpdateCheck) {
      updateLog("Auto-check error, not showing dialog");
      return;
    }

    // For manual checks, show user-friendly error
    manualUpdateCheck = false;
    const is404Error = err.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' ||
                       err.message?.includes('404') ||
                       err.message?.includes('Cannot find latest.yml');

    if (is404Error) {
      // 404 after GitHub API check = release exists but files missing
      updateLog("404 error: release files not ready, showing 'up to date'");
      dialog.showMessageBox({
        type: "info",
        title: t("updateNotAvailable"),
        message: t("updateNotAvailableMsg").replace("{version}", app.getVersion()),
        noLink: true,
      });
    } else {
      // Real error: network, permissions, corrupted download, etc.
      updateLog("Real error: showing error dialog");
      dialog.showMessageBox({
        type: "error",
        title: t("updateError"),
        message: t("updateErrorMsg"),
        noLink: true,
      });
    }
  });
}

let manualUpdateCheck = false;

// ── Version comparison utilities ──
// Compare two version strings (e.g., "0.5.0" vs "0.5.1")
// Returns: -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2
function compareVersions(v1, v2) {
  const parts1 = v1.replace('v', '').split('.').map(Number);
  const parts2 = v2.replace('v', '').split('.').map(Number);
  const maxLength = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLength; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  return 0;
}

// Fetch latest release version from GitHub API
function fetchLatestVersion() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/rullerzhou-afk/clawd-on-desk/releases/latest',
      headers: {
        'User-Agent': 'Clawd-on-Desk'
      }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const release = JSON.parse(data);
            resolve(release.tag_name || release.name);
          } catch (err) {
            reject(new Error(`Failed to parse GitHub response: ${err.message}`));
          }
        } else if (res.statusCode === 404) {
          reject(new Error('No releases found'));
        } else {
          reject(new Error(`GitHub API returned ${res.statusCode}`));
        }
      });
    }).on('error', reject);
  });
}

async function checkForUpdates(manual = false) {
  if (updateStatus === "checking" || updateStatus === "downloading") {
    updateLog(`Check skipped: already ${updateStatus}`);
    return;
  }

  const currentVersion = app.getVersion();
  updateLog(`Starting update check (manual: ${manual}, current version: v${currentVersion})`);
  manualUpdateCheck = manual;
  updateStatus = "checking";
  rebuildAllMenus();

  // Step 1: Check GitHub API for latest version
  updateLog("Fetching latest version from GitHub API...");
  let latestVersion;
  try {
    latestVersion = await fetchLatestVersion();
    updateLog(`Latest version on GitHub: ${latestVersion}`);
  } catch (err) {
    updateLog(`ERROR: Failed to fetch latest version: ${err.message}`);

    // Network error or GitHub API issue
    updateStatus = "error";
    manualUpdateCheck = false;
    rebuildAllMenus();
    if (manual) {
      updateLog("Showing error dialog (GitHub API failed)");
      dialog.showMessageBox({
        type: "error",
        title: t("updateError"),
        message: t("updateErrorMsg"),
        noLink: true,
      });
    }
    return;
  }

  // Step 2: Compare versions
  const versionCompare = compareVersions(currentVersion, latestVersion);
  updateLog(`Version comparison: ${currentVersion} vs ${latestVersion} = ${versionCompare}`);

  if (versionCompare >= 0) {
    // Current version is up-to-date or newer
    updateLog("Current version is up-to-date or newer");
    updateStatus = "idle";
    manualUpdateCheck = false;
    rebuildAllMenus();
    if (manual) {
      updateLog("Showing 'up to date' dialog");
      dialog.showMessageBox({
        type: "info",
        title: t("updateNotAvailable"),
        message: t("updateNotAvailableMsg").replace("{version}", currentVersion),
        noLink: true,
      });
    }
    return;
  }

  // Step 3: Newer version available, use electron-updater to download
  updateLog(`Newer version available: ${latestVersion}, proceeding with electron-updater`);
  const au = getAutoUpdater();
  if (!au) {
    updateLog("ERROR: AutoUpdater not available");
    updateStatus = "error";
    manualUpdateCheck = false;
    rebuildAllMenus();
    if (manual) {
      updateLog("Showing error dialog (auto-updater not available)");
      dialog.showMessageBox({
        type: "error",
        title: t("updateError"),
        message: t("updateErrorMsg"),
        noLink: true,
      });
    }
    return;
  }

  // Let electron-updater handle the download
  au.checkForUpdates().then((result) => {
    if (!result) {
      updateLog("Update check returned null (likely dev mode)");
      updateStatus = "idle";
      manualUpdateCheck = false;
      rebuildAllMenus();
    } else {
      updateLog(`Update check result: ${JSON.stringify(result)}`);
    }
  }).catch((err) => {
    updateLog(`ERROR: checkForUpdates promise rejected: ${err.message}`);
    updateLog(`Stack: ${err.stack}`);

    // Distinguish between real errors and "no newer version"
    const is404Error = err.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' ||
                       err.message?.includes('404') ||
                       err.message?.includes('Cannot find latest.yml');

    if (is404Error) {
      // This might mean the release files aren't ready yet
      updateLog("404 error: release files may not be uploaded yet");
      updateStatus = "idle";
      manualUpdateCheck = false;
      rebuildAllMenus();
      if (manual) {
        updateLog("Showing 'up to date' dialog (release files not found)");
        dialog.showMessageBox({
          type: "info",
          title: t("updateNotAvailable"),
          message: t("updateNotAvailableMsg").replace("{version}", currentVersion),
          noLink: true,
        });
      }
    } else {
      // Real error: network, permissions, etc.
      updateLog("Real error in promise: showing error dialog");
      updateStatus = "error";
      manualUpdateCheck = false;
      rebuildAllMenus();
      if (manual) {
        updateLog("Showing error dialog (check failed)");
        dialog.showMessageBox({
          type: "error",
          title: t("updateError"),
          message: t("updateErrorMsg"),
          noLink: true,
        });
      }
    }
  });
}

function getUpdateMenuItem() {
  return {
    label: getUpdateMenuLabel(),
    enabled: updateStatus !== "checking" && updateStatus !== "downloading",
    click: () => updateStatus === "ready"
      ? getAutoUpdater()?.quitAndInstall(false, true)
      : checkForUpdates(true),
  };
}

function getUpdateMenuLabel() {
  switch (updateStatus) {
    case "checking": return t("checkingForUpdates");
    case "downloading": return t("updateDownloading");
    case "ready": return t("updateReady");
    default: return t("checkForUpdates");
  }
}

function rebuildAllMenus() {
  buildTrayMenu();
  buildContextMenu();
}

// ── Window creation ──
function requestAppQuit() {
  isQuitting = true;
  app.quit();
}

function ensureContextMenuOwner() {
  if (contextMenuOwner && !contextMenuOwner.isDestroyed()) return contextMenuOwner;
  if (!win || win.isDestroyed()) return null;

  contextMenuOwner = new BrowserWindow({
    parent: win,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    focusable: true,
    closable: false,
    minimizable: false,
    maximizable: false,
    hasShadow: false,
  });

  contextMenuOwner.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      contextMenuOwner.hide();
    }
  });

  contextMenuOwner.on("closed", () => {
    contextMenuOwner = null;
  });

  return contextMenuOwner;
}

function popupMenuAt(menu) {
  if (menuOpen) return;
  const owner = ensureContextMenuOwner();
  if (!owner) return;

  const cursor = screen.getCursorScreenPoint();
  owner.setBounds({ x: cursor.x, y: cursor.y, width: 1, height: 1 });
  owner.show();
  owner.focus();

  menuOpen = true;
  menu.popup({
    window: owner,
    callback: () => {
      menuOpen = false;
      if (owner && !owner.isDestroyed()) owner.hide();
      if (win && !win.isDestroyed()) {
        win.showInactive();
        win.setAlwaysOnTop(true, isMac ? "floating" : WIN_TOPMOST_LEVEL);
      }
    },
  });
}

function showPetContextMenu() {
  if (!win || win.isDestroyed()) return;
  buildContextMenu();
  popupMenuAt(contextMenu);
}

function createWindow() {
  const prefs = loadPrefs();
  if (prefs && SIZES[prefs.size]) currentSize = prefs.size;
  if (prefs && i18n[prefs.lang]) lang = prefs.lang;
  // macOS: restore tray/dock visibility from prefs
  if (isMac && prefs) {
    if (typeof prefs.showTray === "boolean") showTray = prefs.showTray;
    if (typeof prefs.showDock === "boolean") showDock = prefs.showDock;
  }
  if (prefs && typeof prefs.autoStartWithClaude === "boolean") autoStartWithClaude = prefs.autoStartWithClaude;
  // macOS: apply dock visibility (default hidden)
  if (isMac) {
    applyDockVisibility();
  }
  const size = SIZES[currentSize];

  // Restore saved position, or default to bottom-right of primary display
  let startX, startY;
  if (prefs && prefs.miniMode) {
    // Restore mini mode
    preMiniX = prefs.preMiniX || 0;
    preMiniY = prefs.preMiniY || 0;
    const wa = getNearestWorkArea(prefs.x + size.width / 2, prefs.y + size.height / 2);
    currentMiniX = wa.x + wa.width - Math.round(size.width * (1 - MINI_OFFSET_RATIO));
    startX = currentMiniX;
    startY = Math.max(wa.y, Math.min(prefs.y, wa.y + wa.height - size.height));
    miniSnap = { y: startY, width: size.width, height: size.height };
    miniMode = true;
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
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false,
    },
  });

  win.setFocusable(false);
  if (isMac) {
    // macOS: show on all Spaces (virtual desktops) and use floating window level
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    win.setAlwaysOnTop(true, "floating");
  } else {
    // Windows: use pop-up-menu level to stay above taskbar/shell UI
    win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
  }
  win.loadFile(path.join(__dirname, "index.html"));
  win.showInactive();

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
      focusable: true,  // KEY EXPERIMENT: allow activation to avoid WS_EX_NOACTIVATE input routing bugs
      webPreferences: {
        preload: path.join(__dirname, "preload-hit.js"),
        backgroundThrottling: false,
      },
    });
    // setShape: native hit region, no per-pixel alpha dependency.
    // hitWin has no visual content — clipping is irrelevant.
    hitWin.setShape([{ x: 0, y: 0, width: hw, height: hh }]);
    hitWin.setIgnoreMouseEvents(false);  // PERMANENT — never toggle
    hitWin.showInactive();
    if (isMac) {
      hitWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
      hitWin.setAlwaysOnTop(true, "floating");
    } else {
      hitWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    }
    hitWin.loadFile(path.join(__dirname, "hit.html"));
    if (!isMac) guardAlwaysOnTop(hitWin);

    // Event-level safety net for position sync
    win.on("move", syncHitWin);
    win.on("resize", syncHitWin);

    // Send initial state to hitWin once it's ready
    hitWin.webContents.on("did-finish-load", () => {
      sendToHitWin("hit-state-sync", {
        currentSvg, miniMode, dndEnabled: doNotDisturb,
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
    if (miniMode || miniTransitioning) return;
    const { x, y } = win.getBounds();
    const size = SIZES[currentSize];
    const clamped = clampToScreen(x + dx, y + dy, size.width, size.height);
    win.setBounds({ ...clamped, width: size.width, height: size.height });
    syncHitWin();
  });

  ipcMain.on("pause-cursor-polling", () => { idlePaused = true; });
  ipcMain.on("resume-from-reaction", () => {
    idlePaused = false;
    if (miniTransitioning) return;
    sendToRenderer("state-change", currentState, currentSvg);
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
    if (!miniMode && !miniTransitioning) {
      checkMiniModeSnap();
    }
  });

  ipcMain.on("exit-mini-mode", () => {
    if (miniMode) exitMiniMode();
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

  ipcMain.on("bubble-height", (event, height) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    const perm = pendingPermissions.find(p => p.bubble === senderWin);
    if (perm && typeof height === "number" && height > 0) {
      perm.measuredHeight = Math.ceil(height);
      repositionBubbles();
    }
  });

  ipcMain.on("permission-decide", (event, behavior) => {
    // Identify which permission this bubble belongs to via sender webContents
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    const perm = pendingPermissions.find(p => p.bubble === senderWin);
    permLog(`IPC permission-decide: behavior=${behavior} matched=${!!perm}`);
    if (!perm) return;
    // "suggestion:N" — user picked a permission suggestion
    if (typeof behavior === "string" && behavior.startsWith("suggestion:")) {
      const idx = parseInt(behavior.split(":")[1], 10);
      const suggestion = perm.suggestions?.[idx];
      if (!suggestion) { resolvePermissionEntry(perm, "deny", "Invalid suggestion index"); return; }
      permLog(`suggestion raw: ${JSON.stringify(suggestion)}`);
      if (suggestion.type === "addRules") {
        const rules = Array.isArray(suggestion.rules) ? suggestion.rules
          : [{ toolName: suggestion.toolName, ruleContent: suggestion.ruleContent }];
        perm.resolvedSuggestion = {
          type: "addRules",
          destination: suggestion.destination || "localSettings",
          behavior: suggestion.behavior || "allow",
          rules,
        };
      } else if (suggestion.type === "setMode") {
        perm.resolvedSuggestion = {
          type: "setMode",
          mode: suggestion.mode,
          destination: suggestion.destination || "localSettings",
        };
      }
      resolvePermissionEntry(perm, "allow");
    } else {
      resolvePermissionEntry(perm, behavior === "allow" ? "allow" : "deny");
    }
  });

  startMainTick();
  startHttpServer();
  startStaleCleanup();
  // Wait for renderer to be ready before sending initial state
  // If hooks arrived during startup, respect them instead of forcing idle
  // Also handles crash recovery (render-process-gone → reload)
  win.webContents.on("did-finish-load", () => {
    if (miniMode) {
      sendToRenderer("mini-mode-change", true);
    sendToHitWin("hit-state-sync", { miniMode: true });
    }
    if (doNotDisturb) {
      sendToRenderer("dnd-change", true);
    sendToHitWin("hit-state-sync", { dndEnabled: true });
      if (miniMode) {
        applyState("mini-sleep");
      } else {
        applyState("sleeping");
      }
    } else if (miniMode) {
      applyState("mini-idle");
    } else if (sessions.size > 0) {
      const resolved = resolveDisplayState();
      applyState(resolved, getSvgOverride(resolved));
    } else {
      applyState("idle", SVG_IDLE_FOLLOW);
      // Startup recovery: delay 5s to let HWND/z-order/drag systems stabilize,
      // then detect running Claude Code processes → suppress sleep sequence
      setTimeout(() => {
        if (sessions.size > 0 || doNotDisturb) return; // hook arrived during wait
        detectRunningAgentProcesses((found) => {
          if (found && sessions.size === 0 && !doNotDisturb) {
            startupRecoveryActive = true;
            mouseStillSince = Date.now();
            // Hard timeout: give up if no hooks arrive within 5 min
            startupRecoveryTimer = setTimeout(() => {
              startupRecoveryActive = false;
              startupRecoveryTimer = null;
            }, STARTUP_RECOVERY_MAX_MS);
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
  screen.on("display-metrics-changed", () => {
    if (!win || win.isDestroyed()) return;
    if (miniMode) {
      const size = SIZES[currentSize];
      const snapY = miniSnap ? miniSnap.y : win.getBounds().y;
      const wa = getNearestWorkArea(currentMiniX + size.width / 2, snapY + size.height / 2);
      currentMiniX = wa.x + wa.width - Math.round(size.width * (1 - MINI_OFFSET_RATIO));
      const clampedY = Math.max(wa.y, Math.min(snapY, wa.y + wa.height - size.height));
      miniSnap = { y: clampedY, width: size.width, height: size.height };
      win.setBounds({ x: currentMiniX, y: clampedY, width: size.width, height: size.height });
      return;
    }
    const { x, y, width, height } = win.getBounds();
    const clamped = clampToScreen(x, y, width, height);
    if (clamped.x !== x || clamped.y !== y) {
      win.setBounds({ ...clamped, width, height });
    }
  });
  screen.on("display-removed", () => {
    if (!win || win.isDestroyed()) return;
    if (miniMode) {
      exitMiniMode();
      return;
    }
    const { x, y, width, height } = win.getBounds();
    const clamped = clampToScreen(x, y, width, height);
    win.setBounds({ ...clamped, width, height });
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

// ── Window animation ──
function animateWindowX(targetX, durationMs) {
  if (peekAnimTimer) { clearTimeout(peekAnimTimer); peekAnimTimer = null; }
  const bounds = win.getBounds();
  const startX = bounds.x;
  if (startX === targetX) { isAnimating = false; return; }
  isAnimating = true;
  const startTime = Date.now();
  // Use miniSnap to lock y/width/height and prevent DPI drift accumulation
  const snapY = miniSnap ? miniSnap.y : bounds.y;
  const snapW = miniSnap ? miniSnap.width : bounds.width;
  const snapH = miniSnap ? miniSnap.height : bounds.height;
  const step = () => {
    if (!win || win.isDestroyed()) { peekAnimTimer = null; isAnimating = false; return; }
    const t = Math.min(1, (Date.now() - startTime) / durationMs);
    const eased = t * (2 - t);
    const x = Math.round(startX + (targetX - startX) * eased);
    win.setBounds({ x, y: snapY, width: snapW, height: snapH });
    syncHitWin();
    if (t < 1) {
      peekAnimTimer = setTimeout(step, 16);
    } else {
      peekAnimTimer = null;
      isAnimating = false;
    }
  };
  step();
}

function animateWindowParabola(targetX, targetY, durationMs, onDone) {
  if (peekAnimTimer) { clearTimeout(peekAnimTimer); peekAnimTimer = null; }
  const bounds = win.getBounds();
  const startX = bounds.x, startY = bounds.y;
  const size = SIZES[currentSize];
  if (startX === targetX && startY === targetY) {
    isAnimating = false;
    if (onDone) onDone();
    return;
  }
  isAnimating = true;
  const startTime = Date.now();
  const step = () => {
    if (!win || win.isDestroyed()) { peekAnimTimer = null; isAnimating = false; return; }
    const t = Math.min(1, (Date.now() - startTime) / durationMs);
    const eased = t * (2 - t);
    const x = Math.round(startX + (targetX - startX) * eased);
    const arc = -4 * JUMP_PEAK_HEIGHT * t * (t - 1);
    const y = Math.round(startY + (targetY - startY) * eased - arc);
    win.setPosition(x, y);
    syncHitWin();
    if (t < 1) {
      peekAnimTimer = setTimeout(step, 16);
    } else {
      peekAnimTimer = null;
      isAnimating = false;
      if (onDone) onDone();
    }
  };
  step();
}

// ── Mini Mode functions ──
function miniPeekIn() {
  animateWindowX(currentMiniX - PEEK_OFFSET, 200);
}

function miniPeekOut() {
  animateWindowX(currentMiniX, 200);
}

function cancelMiniTransition() {
  miniTransitioning = false;
  if (miniTransitionTimer) { clearTimeout(miniTransitionTimer); miniTransitionTimer = null; }
}

function checkMiniModeSnap() {
  if (miniMode) return;
  const bounds = win.getBounds();
  const size = SIZES[currentSize];
  const mRight = Math.round(size.width * 0.25);
  // Check against ALL monitors' right edges, but only if window center is on that monitor
  const centerX = bounds.x + size.width / 2;
  const displays = screen.getAllDisplays();
  for (const d of displays) {
    const wa = d.workArea;
    const centerY = bounds.y + size.height / 2;
    if (centerX < wa.x || centerX > wa.x + wa.width) continue;
    if (centerY < wa.y || centerY > wa.y + wa.height) continue;
    const rightLimit = wa.x + wa.width - size.width + mRight;
    if (bounds.x >= rightLimit - SNAP_TOLERANCE) {
      enterMiniMode(wa);
      return;
    }
  }
}

function enterMiniMode(wa, viaMenu) {
  if (miniMode && !viaMenu) return; // Already in mini mode
  const bounds = win.getBounds();
  if (!viaMenu) {
    preMiniX = bounds.x;
    preMiniY = bounds.y;
  }
  miniMode = true;
  const size = SIZES[currentSize];
  currentMiniX = wa.x + wa.width - Math.round(size.width * (1 - MINI_OFFSET_RATIO));
  miniSnap = { y: bounds.y, width: size.width, height: size.height };

  if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; pendingState = null; }
  stopWakePoll();

  sendToRenderer("mini-mode-change", true);
    sendToHitWin("hit-state-sync", { miniMode: true });
  miniTransitioning = true;
  buildContextMenu();
  buildTrayMenu();

  const enterSvgState = doNotDisturb ? "mini-enter-sleep" : "mini-enter";

  if (viaMenu) {
    // Jump past ALL screens, load enter SVG off-screen, then slide to mini position
    const displays = screen.getAllDisplays();
    let maxRight = 0;
    for (const d of displays) maxRight = Math.max(maxRight, d.bounds.x + d.bounds.width);
    const jumpTarget = maxRight;
    animateWindowParabola(jumpTarget, bounds.y, JUMP_DURATION, () => {
      // Window is past all screens — load enter SVG here (invisible)
      applyState(enterSvgState);
      miniTransitionTimer = setTimeout(() => {
        // SVG is loaded, now move to mini position (enter animation already playing)
        miniSnap = { y: bounds.y, width: size.width, height: size.height };
        win.setBounds({ x: currentMiniX, y: miniSnap.y, width: miniSnap.width, height: miniSnap.height });
        miniTransitionTimer = setTimeout(() => {
          miniTransitioning = false;
          applyState(doNotDisturb ? "mini-sleep" : "mini-idle");
        }, 3200);
      }, 300);
    });
  } else {
    // Drag entry: fast slide + immediate enter animation (no idle hiccup)
    animateWindowX(currentMiniX, 100);
    applyState(enterSvgState);
    miniTransitionTimer = setTimeout(() => {
      miniTransitioning = false;
      applyState(doNotDisturb ? "mini-sleep" : "mini-idle");
    }, 3200);
  }
}

function exitMiniMode() {
  if (!miniMode) return;
  cancelMiniTransition();
  miniMode = false;
  miniSnap = null;
  miniSleepPeeked = false;
  sendToRenderer("mini-mode-change", false);
    sendToHitWin("hit-state-sync", { miniMode: false });
  buildContextMenu();
  buildTrayMenu();

  const size = SIZES[currentSize];
  const clamped = clampToScreen(preMiniX, preMiniY, size.width, size.height);
  const wa = getNearestWorkArea(clamped.x + size.width / 2, clamped.y + size.height / 2);
  const mRight = Math.round(size.width * 0.25);
  if (clamped.x >= wa.x + wa.width - size.width + mRight - SNAP_TOLERANCE) {
    clamped.x = wa.x + wa.width - size.width + mRight - 100;
  }

  // Clear any lingering mini state timers
  if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; pendingState = null; }

  animateWindowParabola(clamped.x, clamped.y, JUMP_DURATION, () => {
    // Use applyState directly — bypass MIN_DISPLAY_MS so mini animations don't linger
    if (doNotDisturb) {
      doNotDisturb = false;
      sendToRenderer("dnd-change", false);
    sendToHitWin("hit-state-sync", { dndEnabled: false });
      buildContextMenu();
      buildTrayMenu();
      applyState("waking");
    } else {
      const resolved = resolveDisplayState();
      applyState(resolved, getSvgOverride(resolved));
    }
  });
}

function enterMiniViaMenu() {
  const bounds = win.getBounds();
  const size = SIZES[currentSize];
  const wa = getNearestWorkArea(bounds.x + size.width / 2, bounds.y + size.height / 2);

  preMiniX = bounds.x;
  preMiniY = bounds.y;
  miniTransitioning = true;

  // Tell renderer early so it blocks drag during crabwalk
  sendToRenderer("mini-mode-change", true);
    sendToHitWin("hit-state-sync", { miniMode: true });

  applyState("mini-crabwalk");

  const edgeX = wa.x + wa.width - size.width + Math.round(size.width * 0.25);
  const walkDist = Math.abs(bounds.x - edgeX);
  const walkDuration = walkDist / CRABWALK_SPEED;
  animateWindowX(edgeX, walkDuration);

  miniTransitionTimer = setTimeout(() => {
    enterMiniMode(wa, true);
  }, walkDuration + 50);
}

function buildContextMenu() {
  const template = [
    {
      label: t("size"),
      submenu: [
        { label: t("small"), type: "radio", checked: currentSize === "S", click: () => resizeWindow("S") },
        { label: t("medium"), type: "radio", checked: currentSize === "M", click: () => resizeWindow("M") },
        { label: t("large"), type: "radio", checked: currentSize === "L", click: () => resizeWindow("L") },
      ],
    },
    { type: "separator" },
    {
      label: miniMode ? t("exitMiniMode") : t("miniMode"),
      enabled: !miniTransitioning && !(doNotDisturb && !miniMode),
      click: () => miniMode ? exitMiniMode() : enterMiniViaMenu(),
    },
    { type: "separator" },
    {
      label: doNotDisturb ? t("wake") : t("sleep"),
      click: () => doNotDisturb ? disableDoNotDisturb() : enableDoNotDisturb(),
    },
    { type: "separator" },
    {
      label: `${t("sessions")} (${sessions.size})`,
      submenu: buildSessionSubmenu(),
    },
  ];
  // macOS: Dock and Menu Bar visibility toggles
  if (isMac) {
    template.push(
      { type: "separator" },
      {
        label: t("showInMenuBar"),
        type: "checkbox",
        checked: showTray,
        enabled: showTray ? showDock : true, // can't uncheck if Dock is already hidden
        click: (menuItem) => setShowTray(menuItem.checked),
      },
      {
        label: t("showInDock"),
        type: "checkbox",
        checked: showDock,
        enabled: showDock ? showTray : true, // can't uncheck if Menu Bar is already hidden
        click: (menuItem) => setShowDock(menuItem.checked),
      },
    );
  }
  template.push(
    { type: "separator" },
    getUpdateMenuItem(),
    { type: "separator" },
    {
      label: t("language"),
      submenu: [
        { label: "English", type: "radio", checked: lang === "en", click: () => setLanguage("en") },
        { label: "中文", type: "radio", checked: lang === "zh", click: () => setLanguage("zh") },
      ],
    },
    { type: "separator" },
    { label: t("quit"), click: () => requestAppQuit() },
  );
  contextMenu = Menu.buildFromTemplate(template);
}

function setLanguage(newLang) {
  lang = newLang;
  rebuildAllMenus();
  savePrefs();
}

function resizeWindow(sizeKey) {
  currentSize = sizeKey;
  const size = SIZES[sizeKey];
  if (miniMode) {
    const { y } = win.getBounds();
    const wa = getNearestWorkArea(currentMiniX + size.width / 2, y + size.height / 2);
    currentMiniX = wa.x + wa.width - Math.round(size.width * (1 - MINI_OFFSET_RATIO));
    const clampedY = Math.max(wa.y, Math.min(y, wa.y + wa.height - size.height));
    miniSnap = { y: clampedY, width: size.width, height: size.height };
    win.setBounds({ x: currentMiniX, y: clampedY, width: size.width, height: size.height });
  } else {
    const { x, y } = win.getBounds();
    const clamped = clampToScreen(x, y, size.width, size.height);
    win.setBounds({ ...clamped, width: size.width, height: size.height });
  }
  buildContextMenu();
  savePrefs();
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
    if (win) win.showInactive();
    if (hitWin && !hitWin.isDestroyed()) hitWin.showInactive();
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

    // Auto-register Claude Code hooks on every launch (dedup-safe)
    try {
      const { registerHooks } = require("../hooks/install.js");
      const { added } = registerHooks({ silent: true, autoStart: autoStartWithClaude });
      if (added > 0) console.log(`Clawd: auto-registered ${added} Claude Code hooks`);
    } catch (err) {
      console.warn("Clawd: failed to auto-register hooks:", err.message);
    }

    // Start Codex CLI JSONL log monitor
    try {
      const CodexLogMonitor = require("../agents/codex-log-monitor");
      const codexAgent = require("../agents/codex");
      _codexMonitor = new CodexLogMonitor(codexAgent, (sid, state, event, extra) => {
        updateSession(sid, state, event, extra.sourcePid, extra.cwd, null, null, extra.agentPid, "codex");
      });
      _codexMonitor.start();
    } catch (err) {
      console.warn("Clawd: Codex log monitor not started:", err.message);
    }

    // Auto-install VS Code/Cursor terminal-focus extension
    try { installTerminalFocusExtension(); } catch (err) {
      console.warn("Clawd: failed to auto-install terminal-focus extension:", err.message);
    }

    // Auto-updater: setup event handlers + silent check after 5s
    setupAutoUpdater();
    setTimeout(() => checkForUpdates(false), 5000);
  });

  app.on("before-quit", () => {
    isQuitting = true;
    savePrefs();
    if (pendingTimer) clearTimeout(pendingTimer);
    if (autoReturnTimer) clearTimeout(autoReturnTimer);
    if (mainTickTimer) clearInterval(mainTickTimer);
    if (wakePollTimer) clearInterval(wakePollTimer);
    if (miniTransitionTimer) clearTimeout(miniTransitionTimer);
    if (peekAnimTimer) clearTimeout(peekAnimTimer);
    if (yawnDelayTimer) clearTimeout(yawnDelayTimer);
    if (idleLookReturnTimer) clearTimeout(idleLookReturnTimer);
    if (startupRecoveryTimer) clearTimeout(startupRecoveryTimer);
    if (_codexMonitor) _codexMonitor.stop();
    stopStaleCleanup();
    stopTopmostWatchdog();
    if (hitWin && !hitWin.isDestroyed()) hitWin.destroy();
    killFocusHelper();
    // Clean up all pending permission requests — send explicit deny so Claude Code doesn't hang
    for (const perm of [...pendingPermissions]) {
      resolvePermissionEntry(perm, "deny", "Clawd is quitting");
    }
    if (httpServer) httpServer.close();
  });

  app.on("window-all-closed", () => {
    if (!isQuitting) return;
    app.quit();
  });
}
