// src/state.js — State machine + session management + DND + wake poll
// Extracted from main.js L158-240, L299-505, L544-960

const { screen } = require("electron");
const path = require("path");

module.exports = function initState(ctx) {

// ── SVG filename constants ──
const SVG_IDLE_FOLLOW = "clawd-idle-follow.svg";
const SVG_IDLE_LOOK = "clawd-idle-look.svg";
const SVG_IDLE_LIVING = "clawd-idle-living.svg";

// ── State → SVG mapping ──
const STATE_SVGS = {
  idle: [SVG_IDLE_FOLLOW, "clawd-working-debugger.svg", "clawd-idle-reading.svg"],
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
  notification: 3500,
  carrying: 3000,
  working: 1000,
  thinking: 1000,
  "mini-alert": 4000,
  "mini-happy": 4000,
};

const AUTO_RETURN_MS = {
  attention: 4000,
  error: 5000,
  sweeping: 300000,
  notification: 3500,
  carrying: 3000,
  "mini-alert": 4000,
  "mini-happy": 4000,
};

const DEEP_SLEEP_TIMEOUT = 600000;
const YAWN_DURATION = 3000;
const WAKE_DURATION = 1500;
const SLEEP_SEQUENCE = new Set(["yawning", "dozing", "collapsing", "sleeping", "waking"]);

const STATE_PRIORITY = {
  error: 8, notification: 7, sweeping: 6, attention: 5,
  carrying: 4, juggling: 4, working: 3, thinking: 2, idle: 1, sleeping: 0,
};

const ONESHOT_STATES = new Set(["attention", "error", "sweeping", "notification", "carrying"]);

// ── Session tracking ──
const sessions = new Map();
const SESSION_STALE_MS = 600000;
const WORKING_STALE_MS = 300000;
let startupRecoveryActive = false;
let startupRecoveryTimer = null;
const STARTUP_RECOVERY_MAX_MS = 300000;

// ── Hit-test bounding boxes ──
const HIT_BOXES = {
  default:  { x: -1, y: 5, w: 17, h: 12 },
  sleeping: { x: -2, y: 9, w: 19, h: 7 },
  wide:     { x: -3, y: 3, w: 21, h: 14 },
};
const WIDE_SVGS = new Set(["clawd-error.svg", "clawd-notification.svg", "clawd-working-conducting.svg"]);
let currentHitBox = HIT_BOXES.default;

// ── State machine internal ──
let currentState = "idle";
let currentSvg = null;
let stateChangedAt = Date.now();
let pendingTimer = null;
let autoReturnTimer = null;
let pendingState = null;
let eyeResendTimer = null;

// ── Wake poll ──
let wakePollTimer = null;
let lastWakeCursorX = null, lastWakeCursorY = null;

// ── Stale cleanup ──
let staleCleanupTimer = null;
let _detectInFlight = false;

// ── Session Dashboard constants ──
const STATE_EMOJI = {
  working: "\u{1F528}", thinking: "\u{1F914}", juggling: "\u{1F939}",
  idle: "\u{1F4A4}", sleeping: "\u{1F4A4}",
};
const STATE_LABEL_KEY = {
  working: "sessionWorking", thinking: "sessionThinking", juggling: "sessionJuggling",
  idle: "sessionIdle", sleeping: "sessionSleeping",
};

function setState(newState, svgOverride) {
  if (ctx.doNotDisturb) return;

  if (newState === "yawning" && SLEEP_SEQUENCE.has(currentState)) return;

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
    if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
    pendingState = newState;
    const pendingSvgOverride = svgOverride;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      const queued = pendingState;
      const queuedSvg = pendingSvgOverride;
      pendingState = null;
      if (ONESHOT_STATES.has(queued)) {
        applyState(queued, queuedSvg);
      } else {
        const resolved = resolveDisplayState();
        applyState(resolved, getSvgOverride(resolved));
      }
    }, remaining);
  } else {
    applyState(newState, svgOverride);
  }
}

function applyState(state, svgOverride) {
  if (ctx.miniTransitioning && !state.startsWith("mini-")) {
    return;
  }

  if (ctx.miniMode && !state.startsWith("mini-")) {
    if (state === "notification") return applyState("mini-alert");
    if (state === "attention") return applyState("mini-happy");
    if (AUTO_RETURN_MS[currentState] && !autoReturnTimer) {
      return applyState(ctx.mouseOverPet ? "mini-peek" : "mini-idle");
    }
    return;
  }

  currentState = state;
  stateChangedAt = Date.now();
  ctx.idlePaused = false;

  const svgs = STATE_SVGS[state] || STATE_SVGS.idle;
  const svg = svgOverride || svgs[Math.floor(Math.random() * svgs.length)];
  currentSvg = svg;

  // Force eye resend after SVG load completes (~300ms)
  if (eyeResendTimer) { clearTimeout(eyeResendTimer); eyeResendTimer = null; }
  if (state === "idle" || state === "mini-idle") {
    eyeResendTimer = setTimeout(() => { eyeResendTimer = null; ctx.forceEyeResend = true; }, 300);
  }

  // Update hit box based on SVG
  if (svg === "clawd-sleeping.svg" || svg === "clawd-collapse-sleep.svg") {
    currentHitBox = HIT_BOXES.sleeping;
  } else if (WIDE_SVGS.has(svg)) {
    currentHitBox = HIT_BOXES.wide;
  } else {
    currentHitBox = HIT_BOXES.default;
  }

  ctx.sendToRenderer("state-change", state, svg);
  ctx.syncHitWin();
  ctx.sendToHitWin("hit-state-sync", { currentSvg: svg });
  ctx.sendToHitWin("hit-cancel-reaction");

  if (state !== "idle" && state !== "mini-idle") {
    ctx.sendToRenderer("eye-move", 0, 0);
  }

  if ((state === "dozing" || state === "collapsing" || state === "sleeping") && !ctx.doNotDisturb) {
    setTimeout(() => {
      if (currentState === state) startWakePoll();
    }, 500);
  } else {
    stopWakePoll();
  }

  if (autoReturnTimer) clearTimeout(autoReturnTimer);
  if (state === "yawning") {
    autoReturnTimer = setTimeout(() => {
      autoReturnTimer = null;
      applyState(ctx.doNotDisturb ? "collapsing" : "dozing");
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
      if (ctx.miniMode) {
        if (ctx.mouseOverPet && !ctx.doNotDisturb) {
          ctx.miniPeekIn();
          applyState("mini-peek");
        } else {
          applyState(ctx.doNotDisturb ? "mini-sleep" : "mini-idle");
        }
      } else {
        const resolved = resolveDisplayState();
        applyState(resolved, getSvgOverride(resolved));
      }
    }, AUTO_RETURN_MS[state]);
  }
}

// ── Wake poll ──
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

    if (currentState === "dozing" && Date.now() - ctx.mouseStillSince >= DEEP_SLEEP_TIMEOUT) {
      stopWakePoll();
      applyState("collapsing");
    }
  }, 200);
}

function stopWakePoll() {
  if (wakePollTimer) { clearInterval(wakePollTimer); wakePollTimer = null; }
}

function wakeFromDoze() {
  if (currentState === "sleeping" || currentState === "collapsing") {
    applyState("waking");
    return;
  }
  ctx.sendToRenderer("wake-from-doze");
  setTimeout(() => {
    if (currentState === "dozing") {
      applyState("idle", SVG_IDLE_FOLLOW);
    }
  }, 350);
}

// ── Session management ──
function updateSession(sessionId, state, event, sourcePid, cwd, editor, pidChain, agentPid, agentId, host, headless) {
  if (startupRecoveryActive) {
    startupRecoveryActive = false;
    if (startupRecoveryTimer) { clearTimeout(startupRecoveryTimer); startupRecoveryTimer = null; }
  }

  if (event === "PermissionRequest") {
    setState("notification");
    return;
  }

  const existing = sessions.get(sessionId);
  const srcPid = sourcePid || (existing && existing.sourcePid) || null;
  const srcCwd = cwd || (existing && existing.cwd) || "";
  const srcEditor = editor || (existing && existing.editor) || null;
  const srcPidChain = (pidChain && pidChain.length) ? pidChain : (existing && existing.pidChain) || null;
  const srcAgentPid = agentPid || (existing && existing.agentPid) || null;
  const srcAgentId = agentId || (existing && existing.agentId) || null;
  const srcHost = host || (existing && existing.host) || null;
  const srcHeadless = headless || (existing && existing.headless) || false;

  const pidReachable = existing ? existing.pidReachable :
    (srcAgentPid ? isProcessAlive(srcAgentPid) : (srcPid ? isProcessAlive(srcPid) : false));

  const base = { sourcePid: srcPid, cwd: srcCwd, editor: srcEditor, pidChain: srcPidChain, agentPid: srcAgentPid, agentId: srcAgentId, host: srcHost, headless: srcHeadless, pidReachable };

  if (event === "SessionEnd") {
    const endingSession = sessions.get(sessionId);
    sessions.delete(sessionId);
    cleanStaleSessions();
    if (!endingSession || !endingSession.headless) {
      let hasLiveInteractive = false;
      for (const s of sessions.values()) {
        if (!s.headless) { hasLiveInteractive = true; break; }
      }
      if (!hasLiveInteractive) {
        setState("sleeping");
        return;
      }
    }
    const displayState = resolveDisplayState();
    setState(displayState, getSvgOverride(displayState));
    return;
  } else if (state === "attention" || state === "notification" || SLEEP_SEQUENCE.has(state)) {
    sessions.set(sessionId, { state: "idle", updatedAt: Date.now(), ...base });
  } else if (ONESHOT_STATES.has(state)) {
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
    if (existing && existing.state === "juggling" && state === "working" && event !== "SubagentStop" && event !== "subagentStop") {
      existing.updatedAt = Date.now();
    } else {
      sessions.set(sessionId, { state, updatedAt: Date.now(), ...base });
    }
  }
  cleanStaleSessions();

  if (ONESHOT_STATES.has(state)) {
    setState(state);
    return;
  }

  const displayState = resolveDisplayState();
  setState(displayState, getSvgOverride(displayState));
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function cleanStaleSessions() {
  const now = Date.now();
  let changed = false;
  let removedNonHeadless = false;
  for (const [id, s] of sessions) {
    const age = now - s.updatedAt;

    if (s.pidReachable && s.agentPid && !isProcessAlive(s.agentPid)) {
      if (!s.headless) removedNonHeadless = true;
      sessions.delete(id); changed = true;
      continue;
    }

    if (age > SESSION_STALE_MS) {
      if (s.pidReachable && s.sourcePid) {
        if (!isProcessAlive(s.sourcePid)) {
          if (!s.headless) removedNonHeadless = true;
          sessions.delete(id); changed = true;
        } else if (s.state !== "idle") {
          s.state = "idle"; changed = true;
        }
      } else if (!s.pidReachable) {
        if (!s.headless) removedNonHeadless = true;
        sessions.delete(id); changed = true;
      } else {
        if (!s.headless) removedNonHeadless = true;
        sessions.delete(id); changed = true;
      }
    } else if (age > WORKING_STALE_MS) {
      if (s.pidReachable && s.sourcePid && !isProcessAlive(s.sourcePid)) {
        if (!s.headless) removedNonHeadless = true;
        sessions.delete(id); changed = true;
      } else if (s.state === "working" || s.state === "juggling" || s.state === "thinking") {
        s.state = "idle"; s.updatedAt = now; changed = true;
      }
    }
  }
  if (changed && sessions.size === 0) {
    if (removedNonHeadless) {
      setState("yawning");
    } else {
      setState("idle", SVG_IDLE_FOLLOW);
    }
  } else if (changed) {
    const resolved = resolveDisplayState();
    setState(resolved, getSvgOverride(resolved));
  }

  if (startupRecoveryActive && sessions.size === 0) {
    detectRunningAgentProcesses((found) => {
      if (!found) {
        startupRecoveryActive = false;
        if (startupRecoveryTimer) { clearTimeout(startupRecoveryTimer); startupRecoveryTimer = null; }
      }
    });
  }
}

function detectRunningAgentProcesses(callback) {
  if (_detectInFlight) return;
  _detectInFlight = true;
  const done = (result) => { _detectInFlight = false; callback(result); };
  const { exec } = require("child_process");
  if (process.platform === "win32") {
    exec(
      'wmic process where "(Name=\'node.exe\' and CommandLine like \'%claude-code%\') or Name=\'claude.exe\' or Name=\'codex.exe\' or Name=\'copilot.exe\' or Name=\'gemini.exe\'" get ProcessId /format:csv',
      { encoding: "utf8", timeout: 5000, windowsHide: true },
      (err, stdout) => done(!err && /\d+/.test(stdout))
    );
  } else {
    exec("pgrep -f 'claude-code|codex|copilot' || pgrep -x 'gemini'", { timeout: 3000 },
      (err) => done(!err)
    );
  }
}

function startStaleCleanup() {
  if (staleCleanupTimer) return;
  staleCleanupTimer = setInterval(cleanStaleSessions, 10000);
}

function stopStaleCleanup() {
  if (staleCleanupTimer) { clearInterval(staleCleanupTimer); staleCleanupTimer = null; }
}

function resolveDisplayState() {
  if (sessions.size === 0) return "idle";
  let best = "sleeping";
  let hasNonHeadless = false;
  for (const [, s] of sessions) {
    if (s.headless) continue;
    hasNonHeadless = true;
    if ((STATE_PRIORITY[s.state] || 0) > (STATE_PRIORITY[best] || 0)) best = s.state;
  }
  if (!hasNonHeadless) return "idle";
  return best;
}

function getActiveWorkingCount() {
  let n = 0;
  for (const [, s] of sessions) {
    if (!s.headless && (s.state === "working" || s.state === "thinking" || s.state === "juggling")) n++;
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
    if (!s.headless && s.state === "juggling") n++;
  }
  return n >= 2 ? "clawd-working-conducting.svg" : "clawd-working-juggling.svg";
}

// ── Session Dashboard ──
function formatElapsed(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return ctx.t("sessionJustNow");
  const min = Math.floor(sec / 60);
  if (min < 60) return ctx.t("sessionMinAgo").replace("{n}", min);
  const hr = Math.floor(min / 60);
  return ctx.t("sessionHrAgo").replace("{n}", hr);
}

function buildSessionSubmenu() {
  const entries = [];
  for (const [id, s] of sessions) {
    entries.push({ id, state: s.state, updatedAt: s.updatedAt, sourcePid: s.sourcePid, cwd: s.cwd, editor: s.editor, pidChain: s.pidChain, host: s.host, headless: s.headless });
  }
  if (entries.length === 0) {
    return [{ label: ctx.t("noSessions"), enabled: false }];
  }
  entries.sort((a, b) => {
    const pa = STATE_PRIORITY[a.state] || 0;
    const pb = STATE_PRIORITY[b.state] || 0;
    if (pb !== pa) return pb - pa;
    return b.updatedAt - a.updatedAt;
  });

  const now = Date.now();

  function buildItem(e) {
    const emoji = STATE_EMOJI[e.state] || "";
    const stateText = ctx.t(STATE_LABEL_KEY[e.state] || "sessionIdle");
    const folder = e.cwd ? path.basename(e.cwd) : (e.id.length > 6 ? e.id.slice(0, 6) + ".." : e.id);
    const name = ctx.showSessionId ? `${folder} #${e.id.slice(-3)}` : folder;
    const elapsed = formatElapsed(now - e.updatedAt);
    const hasPid = !!e.sourcePid;
    return {
      label: `${e.headless ? "🤖 " : ""}${emoji} ${name}  ${stateText}  ${elapsed}`,
      enabled: hasPid,
      click: hasPid ? () => ctx.focusTerminalWindow(e.sourcePid, e.cwd, e.editor, e.pidChain) : undefined,
    };
  }

  // Single-pass grouping by host
  const groups = new Map(); // key: host || "" for local
  for (const e of entries) {
    const key = e.host || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  if (groups.size === 1 && groups.has("")) return entries.map(buildItem);

  // Build grouped menu: local first, then each remote host
  const items = [];
  const local = groups.get("");
  if (local) {
    items.push({ label: `📍 ${ctx.t("sessionLocal")}`, enabled: false });
    items.push(...local.map(buildItem));
  }
  for (const [h, group] of groups) {
    if (!h) continue;
    if (items.length) items.push({ type: "separator" });
    items.push({ label: `🖥 ${h}`, enabled: false });
    items.push(...group.map(buildItem));
  }
  return items;
}

// ── Do Not Disturb ──
function enableDoNotDisturb() {
  if (ctx.doNotDisturb) return;
  ctx.doNotDisturb = true;
  ctx.sendToRenderer("dnd-change", true);
  ctx.sendToHitWin("hit-state-sync", { dndEnabled: true });
  for (const perm of [...ctx.pendingPermissions]) ctx.resolvePermissionEntry(perm, "deny", "DND enabled");
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; pendingState = null; }
  if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
  stopWakePoll();
  if (ctx.miniMode) {
    applyState("mini-sleep");
  } else {
    applyState("yawning");
  }
  ctx.buildContextMenu();
  ctx.buildTrayMenu();
}

function disableDoNotDisturb() {
  if (!ctx.doNotDisturb) return;
  ctx.doNotDisturb = false;
  ctx.sendToRenderer("dnd-change", false);
  ctx.sendToHitWin("hit-state-sync", { dndEnabled: false });
  if (ctx.miniMode) {
    if (ctx.miniSleepPeeked) { ctx.miniPeekOut(); ctx.miniSleepPeeked = false; }
    applyState("mini-idle");
  } else {
    applyState("waking");
  }
  ctx.buildContextMenu();
  ctx.buildTrayMenu();
}

function startStartupRecovery() {
  startupRecoveryActive = true;
  startupRecoveryTimer = setTimeout(() => {
    startupRecoveryActive = false;
    startupRecoveryTimer = null;
  }, STARTUP_RECOVERY_MAX_MS);
}

function getCurrentState() { return currentState; }
function getCurrentSvg() { return currentSvg; }
function getCurrentHitBox() { return currentHitBox; }
function getStartupRecoveryActive() { return startupRecoveryActive; }

function cleanup() {
  if (pendingTimer) clearTimeout(pendingTimer);
  if (autoReturnTimer) clearTimeout(autoReturnTimer);
  if (eyeResendTimer) clearTimeout(eyeResendTimer);
  if (startupRecoveryTimer) clearTimeout(startupRecoveryTimer);
  if (wakePollTimer) clearInterval(wakePollTimer);
  stopStaleCleanup();
}

return {
  setState, applyState, updateSession, resolveDisplayState,
  enableDoNotDisturb, disableDoNotDisturb,
  startStaleCleanup, stopStaleCleanup, startWakePoll, stopWakePoll,
  getSvgOverride, cleanStaleSessions, startStartupRecovery,
  detectRunningAgentProcesses, buildSessionSubmenu,
  getCurrentState, getCurrentSvg, getCurrentHitBox, getStartupRecoveryActive,
  sessions, STATE_SVGS, STATE_PRIORITY, ONESHOT_STATES, SLEEP_SEQUENCE,
  HIT_BOXES, WIDE_SVGS,
  cleanup,
};

};
