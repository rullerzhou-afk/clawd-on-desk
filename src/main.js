const { app, BrowserWindow, screen, Menu, Tray, ipcMain, nativeImage } = require("electron");
const http = require("http");
const path = require("path");
const fs = require("fs");

// ── Window size presets ──
const SIZES = {
  S: { width: 200, height: 200 },
  M: { width: 280, height: 280 },
  L: { width: 360, height: 360 },
};

// ── Position persistence ──
const PREFS_PATH = path.join(app.getPath("userData"), "clawd-prefs.json");

function loadPrefs() {
  try {
    return JSON.parse(fs.readFileSync(PREFS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function savePrefs() {
  if (!win || win.isDestroyed()) return;
  const { x, y } = win.getBounds();
  const data = {
    x, y, size: currentSize,
    miniMode, preMiniX, preMiniY,
  };
  try { fs.writeFileSync(PREFS_PATH, JSON.stringify(data)); } catch {}
}

// ── SVG filename constants (used across main + renderer via IPC) ──
const SVG_IDLE_FOLLOW = "clawd-idle-follow.svg";
const SVG_IDLE_LOOK = "clawd-idle-look.svg";

// ── State → SVG mapping ──
const STATE_SVGS = {
  idle: [SVG_IDLE_FOLLOW],
  yawning: ["clawd-idle-yawn.svg"],
  dozing: ["clawd-idle-doze.svg"],
  collapsing: ["clawd-idle-collapse.svg"],
  thinking: ["clawd-working-thinking.svg"],
  working: ["clawd-working-typing.svg"],
  juggling: ["clawd-working-juggling.svg"],
  sweeping: ["clawd-working-sweeping.svg"],
  error: ["clawd-error.svg"],
  attention: ["clawd-happy.svg"],
  notification: ["clawd-notification.svg"],
  carrying: ["clawd-working-carrying.svg"],
  sleeping: ["clawd-sleeping.svg"],
};

// Mini mode SVG mappings
STATE_SVGS["mini-idle"]  = ["clawd-mini-idle.svg"];
STATE_SVGS["mini-alert"] = ["clawd-mini-alert.svg"];
STATE_SVGS["mini-happy"] = ["clawd-mini-happy.svg"];
STATE_SVGS["mini-enter"] = ["clawd-mini-enter.svg"];
STATE_SVGS["mini-peek"]  = ["clawd-mini-peek.svg"];
STATE_SVGS["mini-crabwalk"] = ["clawd-mini-crabwalk.svg"];

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
const YAWN_DURATION = 3800;
const COLLAPSE_DURATION = 800;
const IDLE_LOOK_DURATION = 10000;  // idle-look CSS loop is 10s
const SLEEP_SEQUENCE = new Set(["yawning", "dozing", "collapsing", "sleeping"]);

// ── Session tracking ──
const sessions = new Map(); // session_id → { state, updatedAt }
const SESSION_STALE_MS = 300000; // 5 min cleanup
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
const WIDE_SVGS = new Set(["clawd-error.svg", "clawd-working-building.svg", "clawd-notification.svg"]);
let currentHitBox = HIT_BOXES.default;

let win;
let tray = null;
let currentSize = "S";
let contextMenu;
let doNotDisturb = false;

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
let moveTopTimer = null;
let mouseOverPet = false;
let dragLocked = false;
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
let preMiniX = 0, preMiniY = 0;
let currentMiniX = 0;
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
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      pendingState = null;
      // Re-resolve from live sessions — the captured newState may be stale
      // (e.g. SessionEnd arrived while we waited, sessions is now empty)
      const resolved = resolveDisplayState();
      applyState(resolved, getSvgOverride(resolved));
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
    return; // other states: silent
  }

  currentState = state;
  stateChangedAt = Date.now();
  idlePaused = false;

  const svgs = STATE_SVGS[state] || STATE_SVGS.idle;
  const svg = svgOverride || svgs[Math.floor(Math.random() * svgs.length)];
  currentSvg = svg;

  // Update hit box based on SVG
  if (svg === "clawd-sleeping.svg") {
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

  // Wake poll: dozing and sleeping (not DND sleeping)
  if ((state === "dozing" || state === "sleeping") && !doNotDisturb) {
    setTimeout(() => {
      if (currentState === state) startWakePoll();
    }, 500);
  } else {
    stopWakePoll();
  }

  // Sleep/doze sequence: yawning → dozing, collapsing → sleeping
  if (autoReturnTimer) clearTimeout(autoReturnTimer);
  if (state === "yawning") {
    autoReturnTimer = setTimeout(() => {
      autoReturnTimer = null;
      applyState("dozing");
    }, YAWN_DURATION);
  } else if (state === "collapsing") {
    autoReturnTimer = setTimeout(() => {
      autoReturnTimer = null;
      applyState("sleeping");
    }, COLLAPSE_DURATION);
  } else if (AUTO_RETURN_MS[state]) {
    autoReturnTimer = setTimeout(() => {
      autoReturnTimer = null;
      if (miniMode) {
        if (mouseOverPet) {
          applyState("mini-peek");
        } else {
          applyState("mini-idle");
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
    if (miniMode && !miniTransitioning && !dragLocked) {
      const canPeek = currentState === "mini-idle" || currentState === "mini-peek";
      if (!isAnimating && canPeek) {
        if (mouseOverPet && currentState !== "mini-peek") {
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
  if (currentState === "sleeping") {
    // Direct wake from sleep (collapsed pose → idle, no smooth transition yet)
    applyState("idle");
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

function updateSession(sessionId, state, event) {
  if (event === "SessionEnd") {
    sessions.delete(sessionId);
  } else if (state === "attention" || SLEEP_SEQUENCE.has(state)) {
    // Stop/sleep: response complete → session goes idle
    sessions.set(sessionId, { state: "idle", updatedAt: Date.now() });
  } else if (ONESHOT_STATES.has(state)) {
    // Other oneshots (error/sweeping/notification/carrying):
    // preserve session's previous state so auto-return resolves correctly
    const existing = sessions.get(sessionId);
    if (existing) {
      existing.updatedAt = Date.now();
    } else {
      sessions.set(sessionId, { state: "idle", updatedAt: Date.now() });
    }
  } else {
    // Preserve juggling: subagent's own tool use (PreToolUse/PostToolUse)
    // shouldn't override juggling — only SubagentStop should end it.
    const existing = sessions.get(sessionId);
    if (existing && existing.state === "juggling" && state === "working" && event !== "SubagentStop") {
      existing.updatedAt = Date.now();
    } else {
      sessions.set(sessionId, { state, updatedAt: Date.now() });
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

function cleanStaleSessions() {
  const now = Date.now();
  let changed = false;
  for (const [id, s] of sessions) {
    if (now - s.updatedAt > SESSION_STALE_MS) { sessions.delete(id); changed = true; }
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
  staleCleanupTimer = setInterval(cleanStaleSessions, 60000); // every 60s
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

// ── Do Not Disturb ──
function enableDoNotDisturb() {
  if (doNotDisturb) return;
  doNotDisturb = true;
  sendToRenderer("dnd-change", true);
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; pendingState = null; }
  if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
  stopWakePoll();
  if (miniMode) {
    applyState("mini-idle");
  } else {
    applyState("sleeping");
  }
  buildContextMenu();
  buildTrayMenu();
}

function disableDoNotDisturb() {
  if (!doNotDisturb) return;
  doNotDisturb = false;
  sendToRenderer("dnd-change", false);
  if (miniMode) {
    applyState("mini-idle");
  } else {
    const resolved = resolveDisplayState();
    applyState(resolved, getSvgOverride(resolved));
  }
  buildContextMenu();
  buildTrayMenu();
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
          if (STATE_SVGS[state]) {
            const sid = session_id || "default";
            if (svg) {
              // Direct SVG override (test-demo.sh, manual curl) — bypass session logic
              setState(state, svg);
            } else {
              updateSession(sid, state, event);
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

// ── System tray ──
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "../assets/tray-icon.png")).resize({ width: 32, height: 32 });
  tray = new Tray(icon);
  tray.setToolTip("Clawd Desktop Pet");
  buildTrayMenu();
}

function buildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: doNotDisturb ? "唤醒 Clawd" : "休眠（免打扰）",
      click: () => doNotDisturb ? disableDoNotDisturb() : enableDoNotDisturb(),
    },
    { type: "separator" },
    {
      label: "开机自启",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
      },
    },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

// ── Window creation ──
function createWindow() {
  const prefs = loadPrefs();
  if (prefs && SIZES[prefs.size]) currentSize = prefs.size;
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
    startY = prefs.y;
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
  win.loadFile(path.join(__dirname, "index.html"));
  win.showInactive();

  buildContextMenu();
  createTray();

  ipcMain.on("show-context-menu", () => {
    contextMenu.popup({ window: win });
  });

  ipcMain.on("move-window-by", (event, dx, dy) => {
    if (miniMode) return;
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
    if (!miniMode) {
      checkMiniModeSnap();
    }
  });

  ipcMain.on("exit-mini-mode", () => {
    if (miniMode) exitMiniMode();
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
        applyState("mini-idle");
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

  // ── Periodic alwaysOnTop refresh (Windows DWM can drop z-order) ──
  // Use moveTop() instead of setAlwaysOnTop(false→true) to avoid a brief
  // gap where the window loses TOPMOST status — that gap lets other windows
  // slip above Clawd during window switches.
  moveTopTimer = setInterval(() => {
    if (win && !win.isDestroyed()) {
      win.moveTop();
    }
  }, 30000); // every 30s

  // ── Display change: re-clamp window to prevent off-screen ──
  screen.on("display-metrics-changed", () => {
    if (!win || win.isDestroyed()) return;
    if (miniMode) {
      const { y, width, height } = win.getBounds();
      const wa = getNearestWorkArea(currentMiniX + width / 2, y + height / 2);
      currentMiniX = wa.x + wa.width - Math.round(width * (1 - MINI_OFFSET_RATIO));
      win.setBounds({ x: currentMiniX, y, width, height });
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
  const size = SIZES[currentSize];
  if (startX === targetX) { isAnimating = false; return; }
  isAnimating = true;
  const startTime = Date.now();
  const startY = bounds.y;
  const step = () => {
    if (!win || win.isDestroyed()) { peekAnimTimer = null; isAnimating = false; return; }
    const t = Math.min(1, (Date.now() - startTime) / durationMs);
    const eased = t * (2 - t);
    const x = Math.round(startX + (targetX - startX) * eased);
    win.setPosition(x, startY);
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
    if (centerX < wa.x || centerX > wa.x + wa.width) continue;
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

  if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; pendingState = null; }
  stopWakePoll();

  sendToRenderer("mini-mode-change", true);
  miniTransitioning = true;
  buildContextMenu();
  buildTrayMenu();

  if (viaMenu) {
    // Jump past ALL screens, load enter SVG off-screen, then slide to mini position
    const displays = screen.getAllDisplays();
    let maxRight = 0;
    for (const d of displays) maxRight = Math.max(maxRight, d.bounds.x + d.bounds.width);
    const jumpTarget = maxRight;
    animateWindowParabola(jumpTarget, bounds.y, JUMP_DURATION, () => {
      // Window is past all screens — load enter SVG here (invisible)
      applyState("mini-enter");
      miniTransitionTimer = setTimeout(() => {
        // SVG is loaded, now move to mini position (enter animation already playing)
        win.setBounds({ x: currentMiniX, y: bounds.y, width: size.width, height: size.height });
        miniTransitionTimer = setTimeout(() => {
          miniTransitioning = false;
          applyState("mini-idle");
        }, 3200);
      }, 300);
    });
  } else {
    // Drag entry: fast slide + immediate enter animation (no idle hiccup)
    animateWindowX(currentMiniX, 100);
    applyState("mini-enter");
    miniTransitionTimer = setTimeout(() => {
      miniTransitioning = false;
      applyState("mini-idle");
    }, 3200);
  }
}

function exitMiniMode() {
  if (!miniMode) return;
  cancelMiniTransition();
  miniMode = false;
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
      applyState("sleeping");
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
      label: "大小",
      submenu: [
        { label: "小 (S)", type: "radio", checked: currentSize === "S", click: () => resizeWindow("S") },
        { label: "中 (M)", type: "radio", checked: currentSize === "M", click: () => resizeWindow("M") },
        { label: "大 (L)", type: "radio", checked: currentSize === "L", click: () => resizeWindow("L") },
      ],
    },
    { type: "separator" },
    {
      label: miniMode ? "退出极简模式" : "极简模式",
      click: () => miniMode ? exitMiniMode() : enterMiniViaMenu(),
    },
    { type: "separator" },
    {
      label: doNotDisturb ? "唤醒 Clawd" : "休眠（免打扰）",
      click: () => doNotDisturb ? disableDoNotDisturb() : enableDoNotDisturb(),
    },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ];
  contextMenu = Menu.buildFromTemplate(template);
}

function resizeWindow(sizeKey) {
  currentSize = sizeKey;
  const size = SIZES[sizeKey];
  if (miniMode) {
    const { y } = win.getBounds();
    const wa = getNearestWorkArea(currentMiniX + size.width / 2, y + size.height / 2);
    currentMiniX = wa.x + wa.width - Math.round(size.width * (1 - MINI_OFFSET_RATIO));
    win.setBounds({ x: currentMiniX, y, width: size.width, height: size.height });
  } else {
    const { x, y } = win.getBounds();
    win.setBounds({ x, y, width: size.width, height: size.height });
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

  app.whenReady().then(createWindow);

  app.on("before-quit", () => {
    savePrefs();
    if (pendingTimer) clearTimeout(pendingTimer);
    if (autoReturnTimer) clearTimeout(autoReturnTimer);
    if (mainTickTimer) clearInterval(mainTickTimer);
    if (wakePollTimer) clearInterval(wakePollTimer);
    if (miniTransitionTimer) clearTimeout(miniTransitionTimer);
    if (peekAnimTimer) clearTimeout(peekAnimTimer);
    if (moveTopTimer) clearInterval(moveTopTimer);
    if (yawnDelayTimer) clearTimeout(yawnDelayTimer);
    if (idleLookReturnTimer) clearTimeout(idleLookReturnTimer);
    stopStaleCleanup();
    if (httpServer) httpServer.close();
  });

  app.on("window-all-closed", () => app.quit());
}
