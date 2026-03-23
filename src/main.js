const { app, BrowserWindow, screen, Menu, Tray, ipcMain, nativeImage, dialog, shell } = require("electron");
const http = require("http");
const path = require("path");
const fs = require("fs");

const isMac = process.platform === "darwin";

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
const sessions = new Map(); // session_id → { state, updatedAt, sourcePid, cwd }
const SESSION_STALE_MS = 300000; // 5 min cleanup
const WORKING_STALE_MS = 30000;  // 30s: working/thinking with no new event → decay to idle
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
let tray = null;
let contextMenuOwner = null;
let currentSize = "S";
let contextMenu;
let doNotDisturb = false;
let isQuitting = false;
let showTray = true;
let showDock = true;

function sendToRenderer(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
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

// ── Permission bubble ──
let bubble = null;
let pendingPermission = null;  // { res, abortHandler, hookEventName }
let bubbleHideTimer = null;

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

  // Update hit box based on SVG
  if (svg === "clawd-sleeping.svg" || svg === "clawd-collapse-sleep.svg") {
    currentHitBox = HIT_BOXES.sleeping;
  } else if (WIDE_SVGS.has(svg)) {
    currentHitBox = HIT_BOXES.wide;
  } else {
    currentHitBox = HIT_BOXES.default;
  }

  sendToRenderer("state-change", state, svg);

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

// ── Unified main tick (hit-test + eye tracking + sleep detection) ──
function startMainTick() {
  if (mainTickTimer) return;
  win.setIgnoreMouseEvents(true);
  mouseOverPet = false;

  mainTickTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();

    // ── Hit-test (always-on) ──
    const bounds = win.getBounds();
    if (!dragLocked) {
      const hit = getHitRectScreen(bounds);
      const over = cursor.x >= hit.left && cursor.x <= hit.right
                && cursor.y >= hit.top  && cursor.y <= hit.bottom;
      if (over !== mouseOverPet) {
        mouseOverPet = over;
        win.setIgnoreMouseEvents(!over);
      }
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

      // Only send eye position when showing idle-follow
      if (isMouseIdle || (!moved && !forceEyeResend)) return;
    } else {
      // miniIdleNow: skip sleep detection, eye tracking only
      if (!moved && !forceEyeResend) return;
    }

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
      applyState("idle");
    }
  }, 350);
}

// ── Session management ──
const ONESHOT_STATES = new Set(["attention", "error", "sweeping", "notification", "carrying"]);

function updateSession(sessionId, state, event, sourcePid, cwd) {
  // PermissionRequest command hook: show notification animation only, don't mutate session.
  // The HTTP hook runs in parallel and handles the actual decision. If we set session to idle
  // here, it can overwrite a newer "working" state after the user approves.
  if (event === "PermissionRequest") {
    setState("notification");
    return;
  }

  // Preserve existing sourcePid/cwd — only SessionStart sends them, other events reuse cached
  const existing = sessions.get(sessionId);
  const srcPid = sourcePid || (existing && existing.sourcePid) || null;
  const srcCwd = cwd || (existing && existing.cwd) || "";

  if (event === "SessionEnd") {
    sessions.delete(sessionId);
  } else if (state === "attention" || state === "notification" || SLEEP_SEQUENCE.has(state)) {
    // Stop/notification/sleep: session goes idle — if work continues, new hooks will re-set
    sessions.set(sessionId, { state: "idle", updatedAt: Date.now(), sourcePid: srcPid, cwd: srcCwd });
  } else if (ONESHOT_STATES.has(state)) {
    // Other oneshots (error/sweeping/notification/carrying):
    // preserve session's previous state so auto-return resolves correctly
    if (existing) {
      existing.updatedAt = Date.now();
      if (sourcePid) existing.sourcePid = sourcePid;
      if (cwd) existing.cwd = cwd;
    } else {
      sessions.set(sessionId, { state: "idle", updatedAt: Date.now(), sourcePid: srcPid, cwd: srcCwd });
    }
  } else {
    // Preserve juggling: subagent's own tool use (PreToolUse/PostToolUse)
    // shouldn't override juggling — only SubagentStop should end it.
    if (existing && existing.state === "juggling" && state === "working" && event !== "SubagentStop") {
      existing.updatedAt = Date.now();
    } else {
      sessions.set(sessionId, { state, updatedAt: Date.now(), sourcePid: srcPid, cwd: srcCwd });
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

    if (age > SESSION_STALE_MS) {
      // Very stale (5 min): PID check or delete
      if (s.sourcePid) {
        if (!isProcessAlive(s.sourcePid)) {
          sessions.delete(id); changed = true;
        } else if (s.state !== "idle") {
          s.state = "idle"; changed = true;
        }
      } else {
        sessions.delete(id); changed = true;
      }
    } else if (age > WORKING_STALE_MS) {
      // Moderately stale (30s): check if terminal was closed
      if (s.sourcePid && !isProcessAlive(s.sourcePid)) {
        sessions.delete(id); changed = true;
      } else if (s.state === "working" || s.state === "juggling") {
        // No hook event for 30s while working → likely interrupted (Esc)
        s.state = "idle"; s.updatedAt = now; changed = true;
      }
    }
    // Sessions updated <30s ago: skip — recent hook events prove liveness
  }
  // If stale sessions were cleaned, re-resolve display state
  if (changed && sessions.size === 0) {
    setState("yawning");
  } else if (changed) {
    const resolved = resolveDisplayState();
    setState(resolved, getSvgOverride(resolved));
  }
}

function startStaleCleanup() {
  if (staleCleanupTimer) return;
  staleCleanupTimer = setInterval(cleanStaleSessions, 10000); // every 10s (supports 30s working timeout)
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
    entries.push({ id, state: s.state, updatedAt: s.updatedAt, sourcePid: s.sourcePid, cwd: s.cwd });
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
      click: hasPid ? () => focusTerminalWindow(e.sourcePid) : undefined,
    };
  });
}

// ── Do Not Disturb ──
function enableDoNotDisturb() {
  if (doNotDisturb) return;
  doNotDisturb = true;
  sendToRenderer("dnd-change", true);
  // Dismiss any pending permission bubble — DND means no interaction
  if (pendingPermission) resolvePermission("deny", "DND enabled");
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
using System.Runtime.InteropServices;
public class WinFocus {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    public static void Focus(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return;
        if (IsIconic(hWnd)) ShowWindow(hWnd, 9);
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        SetForegroundWindow(hWnd);
    }
}
"@
`;

function makeFocusCmd(sourcePid) {
  return `
$curPid = ${sourcePid}
for ($i = 0; $i -lt 8; $i++) {
    $proc = Get-Process -Id $curPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne 0) {
        [WinFocus]::Focus($proc.MainWindowHandle)
        break
    }
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$curPid" -ErrorAction SilentlyContinue
    if (-not $cim -or $cim.ParentProcessId -eq 0 -or $cim.ParentProcessId -eq $curPid) { break }
    $curPid = $cim.ParentProcessId
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
  // Pre-compile the C# type (once, ~500ms, non-blocking)
  psProc.on("error", () => { psProc = null; }); // Spawn failure (powershell.exe not found, etc.)
  psProc.stdin.on("error", () => {}); // Suppress EPIPE if process exits unexpectedly
  psProc.stdin.write(PS_FOCUS_ADDTYPE + "\n");
  psProc.on("exit", () => { psProc = null; });
  psProc.unref(); // Don't keep the app alive for this
}

function killFocusHelper() {
  if (psProc) { psProc.kill(); psProc = null; }
}

function focusTerminalWindow(sourcePid) {
  if (!sourcePid) return;
  if (isMac) {
    // macOS: walk up process tree via ps, then activate via osascript
    // TODO: community contributor — test and refine on real macOS hardware
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
  const cmd = makeFocusCmd(sourcePid);
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
          if (STATE_SVGS[state]) {
            const sid = session_id || "default";
            // mini-* states are internal — only allow via direct SVG override (test scripts)
            if (state.startsWith("mini-") && !svg) {
              res.writeHead(400);
              res.end("mini states require svg override");
              return;
            }
            // If a new hook event arrives for the same session that has a pending
            // permission bubble, the user must have answered in the terminal — dismiss.
            if (pendingPermission && pendingPermission.sessionId === sid) {
              resolvePermission("deny", "User answered in terminal");
            }
            if (svg) {
              // Direct SVG override (test-demo.sh, manual curl) — bypass session logic
              // Sanitize: strip path separators to prevent directory traversal
              const safeSvg = path.basename(svg);
              setState(state, safeSvg);
            } else {
              updateSession(sid, state, event, source_pid, cwd);
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
      const permDebugLog = path.join(app.getPath("userData"), "permission-debug.log");
      fs.appendFileSync(permDebugLog, `[${new Date().toISOString()}] /permission hit | DND=${doNotDisturb} pending=${!!pendingPermission}\n`);
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

        // DND mode: return empty 200 so Claude Code falls back to terminal prompt
        if (doNotDisturb) {
          fs.appendFileSync(permDebugLog, `[${new Date().toISOString()}] SKIPPED: DND mode\n`);
          res.writeHead(200);
          res.end();
          return;
        }

        // Already handling a permission request: return empty 200 for the new one
        // (let Claude Code fall back to terminal, keep current bubble intact)
        if (pendingPermission) {
          fs.appendFileSync(permDebugLog, `[${new Date().toISOString()}] SKIPPED: already pending\n`);
          res.writeHead(200);
          res.end();
          return;
        }

        try {
          const data = JSON.parse(body);
          const toolName = typeof data.tool_name === "string" ? data.tool_name : "Unknown";
          const toolInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
          const sessionId = data.session_id || "default";
          const suggestions = Array.isArray(data.permission_suggestions) ? data.permission_suggestions : [];

          // Detect client disconnect (e.g. Claude Code timeout or user answered in terminal).
          // Listen on res "close" — fires when the TCP connection drops.
          // Skip if we already sent our response (writableFinished).
          // NOTE: do NOT listen on req "close" — it fires as soon as the request body is
          // fully consumed (req.on("end")), which is immediately, not on client disconnect.
          const abortHandler = () => {
            if (res.writableFinished) return;
            fs.appendFileSync(permDebugLog, `[${new Date().toISOString()}] abortHandler fired: pending=${!!pendingPermission} match=${pendingPermission?.res === res}\n`);
            if (pendingPermission && pendingPermission.res === res) {
              pendingPermission = null;
              hideBubble();
            }
          };
          res.on("close", abortHandler);

          pendingPermission = { res, abortHandler, suggestions, sessionId };

          // Show or reuse bubble window
          fs.appendFileSync(permDebugLog, `[${new Date().toISOString()}] showing bubble: tool=${toolName} session=${sessionId} suggestions=${suggestions.length}\n`);
          showPermissionBubble(toolName, toolInput);
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
const TOPMOST_WATCHDOG_MS = 20_000;
let topmostWatchdog = null;

function guardAlwaysOnTop(w) {
  if (isMac) return;
  // Event-driven: catches explicit TOPMOST stripping (Alt key, games, etc.)
  w.on("always-on-top-changed", (_, isOnTop) => {
    if (!isOnTop && w && !w.isDestroyed()) w.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
  });
}

function startTopmostWatchdog() {
  if (isMac || topmostWatchdog) return;
  topmostWatchdog = setInterval(() => {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    if (bubble && !bubble.isDestroyed() && bubble.isVisible()) bubble.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
  }, TOPMOST_WATCHDOG_MS);
}

function stopTopmostWatchdog() {
  if (topmostWatchdog) { clearInterval(topmostWatchdog); topmostWatchdog = null; }
}

// ── Permission bubble window ──

function getBubblePosition(suggestionCount) {
  const bw = 340;
  // Base height covers header + command block + Allow/Deny buttons + padding
  // Each suggestion button adds ~37px (7px padding*2 + 12px font + 1px border + 6px gap)
  const bh = 200 + (suggestionCount || 0) * 37;
  const margin = 4;

  // Fixed position: bottom-right corner of the nearest display
  const petBounds = win.getBounds();
  const cx = petBounds.x + petBounds.width / 2;
  const cy = petBounds.y + petBounds.height / 2;
  const wa = getNearestWorkArea(cx, cy);

  const x = wa.x + wa.width - bw - margin;
  const y = wa.y + wa.height - bh - margin;

  return { x, y, width: bw, height: bh };
}

function showPermissionBubble(toolName, toolInput) {
  const sugCount = pendingPermission ? (pendingPermission.suggestions || []).length : 0;
  const pos = getBubblePosition(sugCount);

  // Cancel any pending hide animation from a previous request
  if (bubbleHideTimer) { clearTimeout(bubbleHideTimer); bubbleHideTimer = null; }

  if (bubble && !bubble.isDestroyed()) {
    // Reuse existing bubble window — reposition and send new data
    bubble.setBounds(pos);
    bubble.showInactive();
    sendBubbleData(toolName, toolInput);
    if (!isMac) setTimeout(() => { if (bubble && !bubble.isDestroyed()) bubble.focus(); }, 100);
    return;
  }

  bubble = new BrowserWindow({
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
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload-bubble.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (isMac) {
    bubble.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    bubble.setAlwaysOnTop(true, "floating");
  } else {
    bubble.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
  }

  bubble.loadFile(path.join(__dirname, "bubble.html"));

  // Wait for renderer ready before sending data (once — avoid stale replay on reload)
  bubble.webContents.once("did-finish-load", () => {
    sendBubbleData(toolName, toolInput);
    // On Windows, transparent windows need explicit focus to receive clicks
    if (!isMac) setTimeout(() => { if (bubble && !bubble.isDestroyed()) bubble.focus(); }, 100);
  });

  bubble.showInactive();

  // If user closes bubble via Alt+F4 etc → treat as deny
  bubble.on("closed", () => {
    bubble = null;
    if (pendingPermission) {
      resolvePermission("deny", "Bubble window closed by user");
    }
  });

  guardAlwaysOnTop(bubble);
}

function sendBubbleData(toolName, toolInput) {
  if (!bubble || bubble.isDestroyed()) return;
  const suggestions = pendingPermission ? pendingPermission.suggestions : [];
  bubble.webContents.send("permission-show", {
    toolName,
    toolInput,
    suggestions,
    lang,
  });
}

function resolvePermission(behavior, message) {
  if (!pendingPermission) return;

  const { res, abortHandler } = pendingPermission;
  // Remove abort listener to avoid double-resolve after we send the response
  if (abortHandler) {
    res.removeListener("close", abortHandler);
  }

  // Guard: client may have disconnected
  if (res.writableEnded || res.destroyed) {
    pendingPermission = null;
    hideBubble();
    return;
  }

  const decision = { behavior: behavior === "deny" ? "deny" : "allow" };
  if (behavior === "deny" && message) {
    decision.message = message;
  }
  // If resolving with a permission suggestion, attach updatedPermissions
  if (pendingPermission.resolvedSuggestion) {
    decision.updatedPermissions = [pendingPermission.resolvedSuggestion];
  }
  const responseBody = {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision,
    },
  };

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(responseBody));

  pendingPermission = null;
  hideBubble();
}

function hideBubble() {
  if (bubble && !bubble.isDestroyed()) {
    bubble.webContents.send("permission-hide");
    if (bubbleHideTimer) clearTimeout(bubbleHideTimer);
    bubbleHideTimer = setTimeout(() => {
      bubbleHideTimer = null;
      if (bubble && !bubble.isDestroyed()) bubble.hide();
    }, 250);
  }
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

function setShowDock(val) {
  if (!isMac || !app.dock) return;
  // Prevent disabling both Dock and Menu Bar — app would become unquittable
  if (!val && !showTray) return;
  showDock = val;
  if (showDock) {
    app.dock.show();
  } else {
    app.dock.hide();
  }
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
    } catch {
      console.warn("Clawd: electron-updater not available, auto-update disabled");
      return null;
    }
  }
  return _autoUpdater;
}

let updateStatus = "idle"; // idle | checking | available | downloading | ready | error

function setupAutoUpdater() {
  const autoUpdater = getAutoUpdater();
  if (!autoUpdater) return;
  autoUpdater.on("update-available", (info) => {
    const wasManual = manualUpdateCheck;
    manualUpdateCheck = false;
    // Silent check during DND/mini: skip dialog, stay idle so user can check later
    if (!wasManual && (doNotDisturb || miniMode)) return;
    updateStatus = "available";
    rebuildAllMenus();
    if (isMac) {
      // macOS: no code signing → can't auto-update, open GitHub Releases page instead
      dialog.showMessageBox({
        type: "info",
        title: t("updateAvailable"),
        message: t("updateAvailableMacMsg").replace("{version}", info.version),
        buttons: [t("download"), t("restartLater")],
        defaultId: 0,
        noLink: true,
      }).then(({ response }) => {
        if (response === 0) {
          shell.openExternal("https://github.com/rullerzhou-afk/clawd-on-desk/releases/latest");
        }
        updateStatus = "idle";
        rebuildAllMenus();
      });
    } else {
      // Windows: auto-download
      dialog.showMessageBox({
        type: "info",
        title: t("updateAvailable"),
        message: t("updateAvailableMsg").replace("{version}", info.version),
        buttons: [t("download"), t("restartLater")],
        defaultId: 0,
        noLink: true,
      }).then(({ response }) => {
        if (response === 0) {
          updateStatus = "downloading";
          rebuildAllMenus();
          autoUpdater.downloadUpdate();
        } else {
          updateStatus = "idle";
          rebuildAllMenus();
        }
      });
    }
  });

  autoUpdater.on("update-not-available", () => {
    updateStatus = "idle";
    rebuildAllMenus();
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      dialog.showMessageBox({
        type: "info",
        title: t("updateNotAvailable"),
        message: t("updateNotAvailableMsg").replace("{version}", app.getVersion()),
        noLink: true,
      });
    }
  });

  autoUpdater.on("update-downloaded", (info) => {
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
        autoUpdater.quitAndInstall(false, true);
      }
    });
  });

  autoUpdater.on("error", () => {
    updateStatus = "error";
    rebuildAllMenus();
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
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

function checkForUpdates(manual = false) {
  if (updateStatus === "checking" || updateStatus === "downloading") return;
  manualUpdateCheck = manual;
  updateStatus = "checking";
  rebuildAllMenus();
  const au = getAutoUpdater();
  if (!au) return;
  au.checkForUpdates().then((result) => {
    // Dev mode: electron-updater resolves null without emitting events
    if (!result) {
      updateStatus = "idle";
      manualUpdateCheck = false;
      rebuildAllMenus();
    }
  }).catch(() => {
    updateStatus = "error";
    manualUpdateCheck = false;
    rebuildAllMenus();
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
  // macOS: apply dock visibility (default hidden)
  if (isMac && app.dock) {
    if (showDock) app.dock.show(); else app.dock.hide();
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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
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

  buildContextMenu();
  if (!isMac || showTray) createTray();
  ensureContextMenuOwner();

  ipcMain.on("show-context-menu", showPetContextMenu);

  ipcMain.on("move-window-by", (event, dx, dy) => {
    if (miniMode || miniTransitioning) return;
    const { x, y } = win.getBounds();
    const size = SIZES[currentSize];
    const clamped = clampToScreen(x + dx, y + dy, size.width, size.height);
    win.setBounds({ ...clamped, width: size.width, height: size.height });
  });

  ipcMain.on("pause-cursor-polling", () => { idlePaused = true; });
  ipcMain.on("resume-from-reaction", () => {
    idlePaused = false;
    // Skip re-send during mini transition (drag-end fires next and will set the right state)
    if (miniTransitioning) return;
    // Re-send current state to renderer without resetting stateChangedAt or timers.
    sendToRenderer("state-change", currentState, currentSvg);
  });

  ipcMain.on("drag-lock", (event, locked) => {
    dragLocked = !!locked;
    if (locked && !mouseOverPet) {
      mouseOverPet = true;
      win.setIgnoreMouseEvents(false);
    }
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
    let bestPid = null, bestTime = 0, bestPriority = -1;
    for (const [, s] of sessions) {
      if (!s.sourcePid) continue;
      const pri = STATE_PRIORITY[s.state] || 0;
      if (pri > bestPriority || (pri === bestPriority && s.updatedAt > bestTime)) {
        bestPid = s.sourcePid;
        bestTime = s.updatedAt;
        bestPriority = pri;
      }
    }
    if (bestPid) focusTerminalWindow(bestPid);
  });

  ipcMain.on("show-session-menu", () => {
    popupMenuAt(Menu.buildFromTemplate(buildSessionSubmenu()));
  });

  ipcMain.on("permission-decide", (_, behavior) => {
    const dbg = path.join(app.getPath("userData"), "permission-debug.log");
    fs.appendFileSync(dbg, `[${new Date().toISOString()}] IPC permission-decide: behavior=${behavior} pending=${!!pendingPermission}\n`);
    if (!pendingPermission) return;
    // "suggestion:N" — user picked a permission suggestion
    if (typeof behavior === "string" && behavior.startsWith("suggestion:")) {
      const idx = parseInt(behavior.split(":")[1], 10);
      const suggestion = pendingPermission.suggestions?.[idx];
      if (!suggestion) { resolvePermission("deny", "Invalid suggestion index"); return; }
      // Transform suggestion to updatedPermissions format
      if (suggestion.type === "addRules") {
        pendingPermission.resolvedSuggestion = {
          type: "addRules",
          destination: suggestion.destination || "localSettings",
          behavior: suggestion.behavior || "allow",
          rules: [{ toolName: suggestion.toolName, ruleContent: suggestion.ruleContent }],
        };
      } else if (suggestion.type === "setMode") {
        pendingPermission.resolvedSuggestion = {
          type: "setMode",
          mode: suggestion.mode,
          destination: suggestion.destination || "localSettings",
        };
      }
      resolvePermission("allow");
    } else {
      resolvePermission(behavior === "allow" ? "allow" : "deny");
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
    }
    if (doNotDisturb) {
      sendToRenderer("dnd-change", true);
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
      applyState("idle");
    }
  });

  // ── Crash recovery: renderer process can die from <object> churn ──
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("Renderer crashed:", details.reason);
    dragLocked = false;
    idlePaused = false;
    mouseOverPet = false;
    win.setIgnoreMouseEvents(true);
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

// ── Single instance lock ──
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // Another instance is already running — quit silently
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) win.showInactive();
  });

  // macOS: hide dock icon early if user previously disabled it
  if (isMac && app.dock) {
    const prefs = loadPrefs();
    if (prefs && prefs.showDock === false) {
      app.dock.hide();
    }
  }

  app.whenReady().then(() => {
    createWindow();

    // Auto-register Claude Code hooks on every launch (dedup-safe)
    try {
      const { registerHooks } = require("../hooks/install.js");
      const { added } = registerHooks({ silent: true });
      if (added > 0) console.log(`Clawd: auto-registered ${added} Claude Code hooks`);
    } catch (err) {
      console.warn("Clawd: failed to auto-register hooks:", err.message);
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
    stopStaleCleanup();
    stopTopmostWatchdog();
    killFocusHelper();
    // Clean up pending permission request — send explicit deny so Claude Code doesn't hang
    if (pendingPermission) {
      resolvePermission("deny", "Clawd is quitting");
    }
    if (bubbleHideTimer) { clearTimeout(bubbleHideTimer); bubbleHideTimer = null; }
    if (bubble && !bubble.isDestroyed()) bubble.destroy();
    if (httpServer) httpServer.close();
  });

  app.on("window-all-closed", () => {
    if (!isQuitting) return;
    app.quit();
  });
}
