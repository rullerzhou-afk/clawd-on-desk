// src/state.js — State machine + session management + DND + wake poll
// Extracted from main.js L158-240, L299-505, L544-960

let screen, nativeImage;
try { ({ screen, nativeImage } = require("electron")); } catch { screen = null; nativeImage = null; }
const path = require("path");
const fs = require("fs");
const { VISUAL_FALLBACK_STATES } = require("./theme-loader");

// ── Agent icons (official logos from assets/icons/agents/) ──
const AGENT_ICON_DIR = path.join(__dirname, "..", "assets", "icons", "agents");
const _agentIconCache = new Map();

function getAgentIcon(agentId) {
  if (!nativeImage || !agentId) return undefined;
  if (_agentIconCache.has(agentId)) return _agentIconCache.get(agentId);
  const iconPath = path.join(AGENT_ICON_DIR, `${agentId}.png`);
  if (!fs.existsSync(iconPath)) return undefined;
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  _agentIconCache.set(agentId, icon);
  return icon;
}

module.exports = function initState(ctx) {

const _getCursor = ctx.getCursorScreenPoint || (screen ? () => screen.getCursorScreenPoint() : null);
const _kill = ctx.processKill || process.kill.bind(process);

// ── Theme-driven state (refreshed on hot theme switch) ──
let theme = null;
let SVG_IDLE_FOLLOW = null;
let STATE_SVGS = {};
let STATE_BINDINGS = {};
let MIN_DISPLAY_MS = {};
let AUTO_RETURN_MS = {};
let DEEP_SLEEP_TIMEOUT = 0;
let YAWN_DURATION = 0;
let WAKE_DURATION = 0;
let DND_SKIP_YAWN = false;
let COLLAPSE_DURATION = 0;
let SLEEP_MODE = "full";
const SLEEP_SEQUENCE = new Set(["yawning", "dozing", "collapsing", "sleeping", "waking"]);

const STATE_PRIORITY = {
  error: 8, notification: 7, sweeping: 6, attention: 5,
  carrying: 4, juggling: 4, working: 3, thinking: 2, idle: 1, sleeping: 0,
};

const ONESHOT_STATES = new Set(["attention", "error", "sweeping", "notification", "carrying"]);

// Rolling event history per session. Used by deriveSessionBadge() to infer a
// user-facing status ("Running" / "Done" / "Interrupted" / "Idle") without
// extending the state machine. Cap avoids unbounded growth on long sessions.
const RECENT_EVENT_LIMIT = 8;

// Badge (4-category) → i18n key. Flat keys, not dot-paths — createTranslator()
// in src/i18n.js only does flat dict[key] lookup.
const SESSION_BADGE_KEYS = {
  running: "sessionBadgeRunning",
  done: "sessionBadgeDone",
  interrupted: "sessionBadgeInterrupted",
  idle: "sessionBadgeIdle",
};

// Hook event name → i18n key for recentEvents.label derivation (C2 renders at
// read time so a language switch updates already-stored events too).
// eslint-disable-next-line no-unused-vars
const EVENT_LABEL_KEYS = {
  SessionStart: "eventLabelSessionStart",
  SessionEnd: "eventLabelSessionEnd",
  UserPromptSubmit: "eventLabelUserPromptSubmit",
  PreToolUse: "eventLabelPreToolUse",
  PostToolUse: "eventLabelPostToolUse",
  PostToolUseFailure: "eventLabelPostToolUseFailure",
  Stop: "eventLabelStop",
  StopFailure: "eventLabelStopFailure",
  SubagentStart: "eventLabelSubagentStart",
  SubagentStop: "eventLabelSubagentStop",
  PreCompact: "eventLabelPreCompact",
  PostCompact: "eventLabelPostCompact",
  Notification: "eventLabelNotification",
  Elicitation: "eventLabelElicitation",
  WorktreeCreate: "eventLabelWorktreeCreate",
  "stale-cleanup": "eventLabelStaleCleanup",
};

// Session display hints — validated against theme.displayHintMap keys
let DISPLAY_HINT_MAP = {};

// ── Session tracking ──
const sessions = new Map();
const MAX_SESSIONS = 20;
const SESSION_STALE_MS = 600000;
const WORKING_STALE_MS = 300000;
let startupRecoveryActive = false;
let startupRecoveryTimer = null;
const STARTUP_RECOVERY_MAX_MS = 300000;

// ── Hit-test bounding boxes (from theme) ──
let HIT_BOXES = {};
let WIDE_SVGS = new Set();
let SLEEPING_SVGS = new Set();
let currentHitBox = HIT_BOXES.default;

// ── State machine internal ──
let currentState = "idle";
let previousState = "idle";
let currentSvg = null;
let stateChangedAt = Date.now();
let pendingTimer = null;
let autoReturnTimer = null;
let pendingState = null;
let eyeResendTimer = null;
let updateVisualState = null;
let updateVisualSvgOverride = null;

const UPDATE_VISUAL_STATE_MAP = {
  checking: "sweeping",
  downloading: "carrying",
};
const UPDATE_VISUAL_SVG_MAP = {
  checking: "clawd-working-debugger.svg",
};

// ── Wake poll ──
let wakePollTimer = null;
let lastWakeCursorX = null, lastWakeCursorY = null;

// ── Kimi CLI permission hold ──
// Keeps the pet in notification state while Kimi is waiting for user approval.
const kimiPermissionHolds = new Map();
// Fail-safe ceiling: only triggers if every Kimi clear-event hook is missed
// AND the agent process keeps running. Real users frequently linger on the
// TUI for tens of seconds (phone, lunch, deciding) so we keep this very
// generous — the precise number isn't load bearing, the per-session cleanup
// path (cleanStaleSessions / SessionEnd / Kimi event remap) is what should
// release the hold in practice. Override with CLAWD_KIMI_PERMISSION_MAX_MS.
function parseKimiHoldMaxMs() {
  const raw = process.env.CLAWD_KIMI_PERMISSION_MAX_MS;
  const n = Number.parseInt(raw, 10);
  // 0 disables the timer entirely (hold stays until an event or stale-cleanup).
  if (Number.isFinite(n) && n >= 0 && n <= 24 * 60 * 60 * 1000) return n;
  return 10 * 60 * 1000; // 10 min default
}
// Throttle for the renderer-pulse that re-arms the notification animation
// when other agent events arrive during a hold. Without throttling the GIF
// looks like it keeps restarting from frame 0.
const KIMI_PULSE_MIN_GAP_MS = 3000;
let _lastKimiPulseAt = 0;

// Kimi CLI does not expose a "this PreToolUse requires approval" flag in its
// hook payload, and its approval UI is a TUI (not an HTTP round trip).
// We therefore use a short delay-then-promote heuristic:
//   1. PreToolUse on a permission-gated tool arrives with permission_suspect=true
//   2. We keep the pet at `working` and start a suspect timer (default 800ms)
//   3. If PostToolUse / PostToolUseFailure / Stop / SessionEnd arrives first,
//      the tool was auto-approved (previously granted) — cancel the timer,
//      never flash notification
//   4. If the timer fires, Kimi is probably still blocked on the TUI waiting
//      for the user — promote to a real permission hold (notification state)
const kimiPermissionSuspectTimers = new Map();
function parseSuspectDelay() {
  const raw = process.env.CLAWD_KIMI_PERMISSION_SUSPECT_MS;
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 0 && n <= 10000) return n;
  return 800;
}

function hasPermissionAnimationLock() {
  // Kimi-only lock: do not alter Claude/Codex/opencode permission behavior.
  return kimiPermissionHolds.size > 0;
}

// ── Stale cleanup ──
let staleCleanupTimer = null;
let _detectInFlight = false;

// ── Session Dashboard constants ──
const STATE_LABEL_KEY = {
  working: "sessionWorking", thinking: "sessionThinking", juggling: "sessionJuggling",
  idle: "sessionIdle", sleeping: "sessionSleeping",
};

function buildStateBindings(nextTheme) {
  const bindings = {};
  const sourceBindings = nextTheme && nextTheme._stateBindings;
  if (sourceBindings && typeof sourceBindings === "object") {
    for (const [stateKey, entry] of Object.entries(sourceBindings)) {
      bindings[stateKey] = {
        files: Array.isArray(entry && entry.files) ? [...entry.files] : [],
        fallbackTo: typeof (entry && entry.fallbackTo) === "string" && entry.fallbackTo ? entry.fallbackTo : null,
      };
    }
  }
  if (nextTheme && nextTheme.states) {
    for (const [stateKey, files] of Object.entries(nextTheme.states)) {
      const normalizedFiles = Array.isArray(files) ? [...files] : [];
      if (!bindings[stateKey]) {
        bindings[stateKey] = { files: normalizedFiles, fallbackTo: null };
      } else if (bindings[stateKey].files.length === 0) {
        bindings[stateKey].files = normalizedFiles;
      }
    }
  }
  if (nextTheme && nextTheme.miniMode && nextTheme.miniMode.states) {
    for (const [stateKey, files] of Object.entries(nextTheme.miniMode.states)) {
      bindings[stateKey] = {
        files: Array.isArray(files) ? [...files] : [],
        fallbackTo: null,
      };
    }
  }
  return bindings;
}

function refreshTheme() {
  theme = ctx.theme;
  SVG_IDLE_FOLLOW = theme.states.idle[0];
  STATE_SVGS = { ...theme.states };
  STATE_BINDINGS = buildStateBindings(theme);
  if (theme.miniMode && theme.miniMode.states) {
    Object.assign(STATE_SVGS, theme.miniMode.states);
  }
  MIN_DISPLAY_MS = theme.timings.minDisplay;
  AUTO_RETURN_MS = theme.timings.autoReturn;
  DEEP_SLEEP_TIMEOUT = theme.timings.deepSleepTimeout;
  YAWN_DURATION = theme.timings.yawnDuration;
  WAKE_DURATION = theme.timings.wakeDuration;
  DND_SKIP_YAWN = !!theme.timings.dndSkipYawn;
  COLLAPSE_DURATION = theme.timings.collapseDuration || 0;
  SLEEP_MODE = theme.sleepSequence && theme.sleepSequence.mode === "direct" ? "direct" : "full";
  DISPLAY_HINT_MAP = theme.displayHintMap || {};
  HIT_BOXES = theme.hitBoxes;
  WIDE_SVGS = new Set(theme.wideHitboxFiles || []);
  SLEEPING_SVGS = new Set(theme.sleepingHitboxFiles || []);

  if (currentSvg && SLEEPING_SVGS.has(currentSvg)) {
    currentHitBox = HIT_BOXES.sleeping;
  } else if (currentSvg && WIDE_SVGS.has(currentSvg)) {
    currentHitBox = HIT_BOXES.wide;
  } else {
    currentHitBox = HIT_BOXES.default;
  }
}

refreshTheme();

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
    // Kimi CLI permission hold: re-arm the auto-return timer so the
    // notification animation keeps cycling while the user is reviewing
    // the permission prompt.
    if (hasPermissionAnimationLock() && newState === "notification" && AUTO_RETURN_MS[newState]) {
      if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
      autoReturnTimer = setTimeout(() => {
        autoReturnTimer = null;
        applyResolvedDisplayState();
      }, AUTO_RETURN_MS[newState]);
    }
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

function isOneshotDisabled(logicalState) {
  if (!ONESHOT_STATES.has(logicalState)) return false;
  if (typeof ctx.isOneshotDisabled !== "function") return false;
  try { return ctx.isOneshotDisabled(logicalState) === true; }
  catch { return false; }
}

function pickStateFile(files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  return files[Math.floor(Math.random() * files.length)];
}

function hasOwnVisualFiles(state) {
  const entry = STATE_BINDINGS[state];
  return !!(entry && Array.isArray(entry.files) && entry.files.length > 0);
}

function resolveVisualBinding(state) {
  let cursor = state;
  let visited = null;
  for (let hops = 0; hops <= 3; hops += 1) {
    const entry = STATE_BINDINGS[cursor];
    if (entry && Array.isArray(entry.files) && entry.files.length > 0) {
      return pickStateFile(entry.files);
    }
    if (!entry || !entry.fallbackTo || !VISUAL_FALLBACK_STATES.has(cursor)) break;
    if (!visited) visited = new Set([cursor]);
    if (visited.has(entry.fallbackTo)) break;
    visited.add(entry.fallbackTo);
    cursor = entry.fallbackTo;
  }
  const idleEntry = STATE_BINDINGS.idle;
  if (idleEntry && Array.isArray(idleEntry.files) && idleEntry.files.length > 0) {
    return pickStateFile(idleEntry.files);
  }
  return null;
}

function applyResolvedDisplayState() {
  const resolved = resolveDisplayState();
  applyState(resolved, getSvgOverride(resolved));
  // Kimi CLI permission hold: while notification is pinned, re-trigger the
  // renderer animation so non-looping GIF/APNG assets replay instead of
  // freezing on their last frame. Throttled so concurrent agents flooding
  // events don't make the GIF visibly restart every tick.
  if (hasPermissionAnimationLock() && resolved === "notification") {
    const now = Date.now();
    if (now - _lastKimiPulseAt >= KIMI_PULSE_MIN_GAP_MS) {
      _lastKimiPulseAt = now;
      ctx.sendToRenderer("kimi-permission-pulse");
    }
  }
}

function playWakeTransitionOrResolve() {
  if (SLEEP_MODE === "direct" && !hasOwnVisualFiles("waking")) {
    applyResolvedDisplayState();
    return;
  }
  applyState("waking");
}

function queueSleepState() {
  if (SLEEP_MODE === "direct") {
    setState("sleeping");
    return;
  }
  setState("yawning");
}

function applyDndSleepState() {
  if (SLEEP_MODE === "direct") {
    applyState("sleeping");
    return;
  }
  applyState(DND_SKIP_YAWN ? "collapsing" : "yawning");
}

function applyState(state, svgOverride) {
  // Phase 3b: user-disabled oneshot state — skip visual + sound, fall back to
  // whatever resolveDisplayState picks (usually working/idle). Gate lives at
  // applyState() top so it catches all three paths that reach here:
  //   · oneshot direct setState (state.js:419)
  //   · PermissionRequest direct setState (state.js:342)
  //   · pending queued oneshot (state.js:163)
  // and also runs before the mini-mode remap below, so "disable notification"
  // silences both normal and mini visuals consistently.
  if (isOneshotDisabled(state)) {
    const resolved = resolveDisplayState();
    if (resolved !== state) {
      setState(resolved, getSvgOverride(resolved));
    }
    return;
  }

  if (ctx.miniTransitioning && !state.startsWith("mini-")) {
    return;
  }

  if (ctx.miniMode && !state.startsWith("mini-")) {
    if (state === "notification") return applyState("mini-alert");
    if (state === "attention") return applyState("mini-happy");
    if (state === "working" || state === "thinking" || state === "juggling") {
      if (hasOwnVisualFiles("mini-working")) return applyState("mini-working");
      return;
    }
    if ((AUTO_RETURN_MS[currentState] || currentState === "mini-working") && !autoReturnTimer) {
      return applyState(ctx.mouseOverPet ? "mini-peek" : "mini-idle");
    }
    return;
  }

  previousState = currentState;
  currentState = state;
  stateChangedAt = Date.now();
  ctx.idlePaused = false;

  // Sound triggers
  if (state === "attention" || state === "mini-happy") {
    ctx.playSound("complete");
  } else if (state === "notification" || state === "mini-alert") {
    ctx.playSound("confirm");
  }

  const svg = svgOverride || resolveVisualBinding(state);
  currentSvg = svg;

  // Force eye resend after SVG load completes (~300ms)
  // After sweeping → idle, pause eye tracking briefly so eyes stay centered before resuming
  if (eyeResendTimer) { clearTimeout(eyeResendTimer); eyeResendTimer = null; }
  if (state === "idle" || state === "mini-idle") {
    const afterSweep = previousState === "sweeping";
    const delay = afterSweep ? 800 : 300;
    if (afterSweep) ctx.eyePauseUntil = Date.now() + delay;
    eyeResendTimer = setTimeout(() => { eyeResendTimer = null; ctx.forceEyeResend = true; }, delay);
  }

  // Update hit box based on SVG
  if (SLEEPING_SVGS.has(svg)) {
    currentHitBox = HIT_BOXES.sleeping;
  } else if (WIDE_SVGS.has(svg)) {
    currentHitBox = HIT_BOXES.wide;
  } else {
    currentHitBox = HIT_BOXES.default;
  }

  ctx.sendToRenderer("state-change", state, svg);
  ctx.syncHitWin();
  ctx.sendToHitWin("hit-state-sync", { currentSvg: svg, currentState: state });
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
  } else if (state === "collapsing" && COLLAPSE_DURATION > 0) {
    autoReturnTimer = setTimeout(() => {
      autoReturnTimer = null;
      applyState("sleeping");
    }, COLLAPSE_DURATION);
  } else if (state === "waking") {
    autoReturnTimer = setTimeout(() => {
      autoReturnTimer = null;
      applyResolvedDisplayState();
    }, WAKE_DURATION);
  } else if (AUTO_RETURN_MS[state]) {
    autoReturnTimer = setTimeout(() => {
      autoReturnTimer = null;
      if (ctx.miniMode) {
        if (ctx.mouseOverPet && !ctx.doNotDisturb) {
          if (state === "mini-peek") {
            // Peek animation done — stay peeked but show idle (don't re-trigger peek)
            ctx.miniPeeked = true;
            applyState("mini-idle");
          } else {
            ctx.miniPeekIn();
            applyState("mini-peek");
          }
        } else {
          applyState(ctx.doNotDisturb ? "mini-sleep" : "mini-idle");
        }
      } else {
        applyResolvedDisplayState();
      }
    }, AUTO_RETURN_MS[state]);
  }
}

// ── Wake poll ──
function startWakePoll() {
  if (!_getCursor || wakePollTimer) return;
  const cursor = _getCursor();
  lastWakeCursorX = cursor.x;
  lastWakeCursorY = cursor.y;

  wakePollTimer = setInterval(() => {
    const cursor = _getCursor();
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
    playWakeTransitionOrResolve();
    return;
  }
  ctx.sendToRenderer("wake-from-doze");
  setTimeout(() => {
    if (currentState === "dozing") {
      applyState("idle", SVG_IDLE_FOLLOW);
    }
  }, 350);
}

function pickDisplayHint(state, existing, incoming) {
  if (state !== "working" && state !== "thinking" && state !== "juggling") {
    return null;
  }
  if (incoming !== undefined) {
    if (incoming === null || incoming === "") return null;
    if (DISPLAY_HINT_MAP[incoming] != null) return incoming;
    return existing && existing.displayHint != null ? existing.displayHint : null;
  }
  return existing && existing.displayHint != null ? existing.displayHint : null;
}

function debugSession(msg) {
  if (typeof ctx.debugLog !== "function") return;
  try { ctx.debugLog(msg); } catch {}
}

// Append an event to a session's rolling recentEvents list, dropping the
// oldest when over RECENT_EVENT_LIMIT. Returned list is a new array —
// caller assigns it to session.recentEvents.
// Intentionally does NOT store a human-readable label field. C2 derives
// labels via i18n at render time so language switches update existing
// sessions' menu labels too.
function pushRecentEvent(existing, state, event) {
  const previous = Array.isArray(existing && existing.recentEvents)
    ? existing.recentEvents.slice(-(RECENT_EVENT_LIMIT - 1))
    : [];
  previous.push({
    at: Date.now(),
    event: event || null,
    state: state || "idle",
  });
  return previous;
}

// Derive a user-facing status badge from a session. Returns one of:
// "running" / "done" / "interrupted" / "idle".
// Intentionally 4 categories — not 5. There is no "exited" because sessions
// are deleted on SessionEnd (src/state.js `sessions.delete(sessionId)`),
// so a session with state:"sleeping"+event:"SessionEnd" is unreachable in
// the menu iteration.
function deriveSessionBadge(session) {
  if (!session) return "idle";
  // Any non-idle/non-sleeping state → session is actively doing something
  if (session.state !== "idle" && session.state !== "sleeping") return "running";
  // Sleeping is treated as idle (the pet sleeping doesn't mean the session is dead)
  if (session.state === "sleeping") return "idle";
  // state === "idle": disambiguate by most-recent event
  const events = Array.isArray(session.recentEvents) ? session.recentEvents : [];
  const latest = events.length ? events[events.length - 1] : null;
  const latestEvent = latest && latest.event;
  if (latestEvent === "StopFailure" || latestEvent === "PostToolUseFailure") return "interrupted";
  if (latestEvent === "Stop" || latestEvent === "PostCompact") return "done";
  return "idle";
}

// Local title normalizer (trim, strip control chars, clamp, empty → null).
// Note: hooks/clawd-hook.js has an identical helper; hook scripts can't require src/* (different runtime
// context: plain node child process, no Electron), so the two are kept in
// sync manually rather than sharing a module.
const SESSION_TITLE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]+/g;
const SESSION_TITLE_MAX = 80;

function normalizeTitle(value) {
  if (typeof value !== "string") return null;
  const collapsed = value
    .replace(SESSION_TITLE_CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return null;
  return collapsed.length > SESSION_TITLE_MAX
    ? `${collapsed.slice(0, SESSION_TITLE_MAX - 1)}\u2026`
    : collapsed;
}

function describeSession(sessionId, session) {
  if (!session) return `sid=${sessionId} <deleted>`;
  return [
    `sid=${sessionId}`,
    `state=${session.state || "-"}`,
    `resume=${session.resumeState || "-"}`,
    `agent=${session.agentId || "-"}`,
    `agentPid=${session.agentPid || "-"}`,
    `sourcePid=${session.sourcePid || "-"}`,
    `headless=${session.headless ? 1 : 0}`,
  ].join(" ");
}

// ── Session management ──
// Session-related fields go through `opts`. Earlier versions took 13
// positional params — refactored in B2 to an options bag so new fields
// (sessionTitle, etc.) don't keep extending the argument list.
function updateSession(sessionId, state, event, opts = {}) {
  const {
    sourcePid = null,
    cwd = null,
    editor = null,
    pidChain = null,
    agentPid = null,
    agentId = null,
    host = null,
    headless = false,
    displayHint = undefined,
    sessionTitle = null,
    permissionSuspect = false,
  } = opts;
  if (startupRecoveryActive) {
    startupRecoveryActive = false;
    if (startupRecoveryTimer) { clearTimeout(startupRecoveryTimer); startupRecoveryTimer = null; }
  }

  const sessionForPerm = sessions.get(sessionId);
  const permAgentId = agentId || (sessionForPerm && sessionForPerm.agentId) || null;

  if (event === "PermissionRequest") {
    // Kimi-only gate: startKimiPermissionPoll suppresses the passive bubble
    // when the user disabled Kimi permissions in Settings, but the setState
    // ran first and flashed notification anyway — leaving a silent animation
    // with no follow-up UI. setState already early-returns under DND so we
    // don't need a second DND check here. CC / opencode keep the
    // unconditional setState — their bubble flow gates DND upstream.
    if (
      permAgentId === "kimi-cli"
      && typeof ctx.isAgentPermissionsEnabled === "function"
      && !ctx.isAgentPermissionsEnabled("kimi-cli")
    ) return;
    setState("notification");
    if (permAgentId === "kimi-cli") startKimiPermissionPoll(sessionId);
    return;
  }

  // Per-agent Notification-hook gate: silences self-issued "I'm idle /
  // waiting for input" pings (Claude Code fires these ~60s after Stop; other
  // agents have similar bells). Sits at the state layer — not the HTTP
  // boundary — so it applies uniformly across event sources (hook POST,
  // log poll, plugin push). Permission bubbles are safe: PermissionRequest
  // is handled by the branch above and never reaches here.
  if (
    event === "Notification"
    && permAgentId
    && typeof ctx.isAgentNotificationHookEnabled === "function"
    && !ctx.isAgentNotificationHookEnabled(permAgentId)
  ) return;

  const existing = sessions.get(sessionId);
  const srcPid = sourcePid || (existing && existing.sourcePid) || null;
  const srcCwd = cwd || (existing && existing.cwd) || "";
  const srcEditor = editor || (existing && existing.editor) || null;
  const srcPidChain = (pidChain && pidChain.length) ? pidChain : (existing && existing.pidChain) || null;
  const srcAgentPid = agentPid || (existing && existing.agentPid) || null;
  const srcAgentId = agentId || (existing && existing.agentId) || null;
  const srcHost = host || (existing && existing.host) || null;
  const srcHeadless = headless || (existing && existing.headless) || false;
  // Sticky: empty input does not clear an existing title. A session that has
  // ever been named keeps that name until the user explicitly renames it.
  const srcSessionTitle = normalizeTitle(sessionTitle) || (existing && existing.sessionTitle) || null;
  const srcResumeState = (existing && existing.resumeState) || null;
  const isSubagentStart = event === "SubagentStart" || event === "subagentStart";
  const isSubagentStop = event === "SubagentStop" || event === "subagentStop";

  debugSession(`event ${describeSession(sessionId, existing)} -> incoming=${state}/${event || "-"} hint=${displayHint || "-"}`);

  const pidReachable = existing ? existing.pidReachable :
    (srcAgentPid ? isProcessAlive(srcAgentPid) : (srcPid ? isProcessAlive(srcPid) : false));

  const recentEvents = pushRecentEvent(existing, state, event);
  const base = { sourcePid: srcPid, cwd: srcCwd, editor: srcEditor, pidChain: srcPidChain, agentPid: srcAgentPid, agentId: srcAgentId, host: srcHost, headless: srcHeadless, sessionTitle: srcSessionTitle, recentEvents, pidReachable };

  // Evict oldest session if at capacity and this is a new session
  if (!existing && sessions.size >= MAX_SESSIONS) {
    let oldestId = null, oldestTime = Infinity;
    for (const [id, s] of sessions) {
      if (s.updatedAt < oldestTime) { oldestTime = s.updatedAt; oldestId = id; }
    }
    if (oldestId) sessions.delete(oldestId);
  }

  if (isSubagentStop) {
    if (!existing) {
      debugSession(`subagent-stop ignore sid=${sessionId} reason=no-session`);
      cleanStaleSessions();
      const displayState = resolveDisplayState();
      setState(displayState, getSvgOverride(displayState));
      return;
    }

    if (existing.state === "juggling") {
      const resumeState = existing.resumeState || null;
      if (resumeState) {
        const dh = pickDisplayHint(resumeState, existing, displayHint);
        sessions.set(sessionId, { state: resumeState, updatedAt: Date.now(), displayHint: dh, ...base, resumeState: null });
        debugSession(`subagent-stop restore ${describeSession(sessionId, sessions.get(sessionId))}`);
      } else {
        sessions.delete(sessionId);
        debugSession(`subagent-stop delete sid=${sessionId} reason=no-resume`);
      }
    } else {
      const dh = pickDisplayHint(existing.state, existing, displayHint);
      sessions.set(sessionId, { state: existing.state, updatedAt: Date.now(), displayHint: dh, ...base, resumeState: null });
      debugSession(`subagent-stop keep ${describeSession(sessionId, sessions.get(sessionId))}`);
    }

    cleanStaleSessions();
    const displayState = resolveDisplayState();
    setState(displayState, getSvgOverride(displayState));
    return;
  }

  if (event === "SessionEnd") {
    const endingSession = sessions.get(sessionId);
    sessions.delete(sessionId);
    debugSession(`session-end delete ${describeSession(sessionId, endingSession)}`);
    cleanStaleSessions();
    if (srcAgentId === "kimi-cli") stopKimiPermissionPoll(sessionId);
    if (!endingSession || !endingSession.headless) {
      let hasLiveInteractive = false;
      for (const s of sessions.values()) {
        if (!s.headless) { hasLiveInteractive = true; break; }
      }
      // /clear sends sweeping — play it even if other sessions are active
      // (sweeping is ONESHOT and auto-returns, so it won't interfere)
      if (state === "sweeping") {
        setState("sweeping");
        return;
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
    sessions.set(sessionId, { state: "idle", updatedAt: Date.now(), displayHint: null, ...base, resumeState: null });
  } else if (ONESHOT_STATES.has(state)) {
    if (existing) {
      existing.updatedAt = Date.now();
      existing.displayHint = null;
      existing.resumeState = null;
      if (sourcePid) existing.sourcePid = sourcePid;
      if (cwd) existing.cwd = cwd;
      if (editor) existing.editor = editor;
      if (pidChain && pidChain.length) existing.pidChain = pidChain;
      if (agentPid) existing.agentPid = agentPid;
    } else {
      sessions.set(sessionId, { state: "idle", updatedAt: Date.now(), displayHint: null, ...base, resumeState: null });
    }
  } else {
    if (isSubagentStart) {
      const dh = pickDisplayHint(state, existing, displayHint);
      const resumeState = existing && existing.state !== "juggling" ? existing.state : srcResumeState;
      sessions.set(sessionId, { state, updatedAt: Date.now(), displayHint: dh, ...base, resumeState });
      debugSession(`subagent-start store ${describeSession(sessionId, sessions.get(sessionId))}`);
    } else if (existing && existing.state === "juggling" && state === "working") {
      existing.updatedAt = Date.now();
      existing.displayHint = pickDisplayHint("juggling", existing, displayHint);
      debugSession(`juggling-hold ${describeSession(sessionId, existing)} event=${event || "-"}`);
    } else {
      const dh = pickDisplayHint(state, existing, displayHint);
      sessions.set(sessionId, { state, updatedAt: Date.now(), displayHint: dh, ...base, resumeState: null });
    }
  }
  cleanStaleSessions();
  // Any Kimi event other than the PreToolUse that originally opened the hold
  // means the user already answered (Approve / Reject / Reject-and-tell-model)
  // and the agent loop has moved on. We must NOT keep the pet stuck on the
  // notification animation past that point, even if PostToolUse is delayed
  // (e.g. user approved `sleep 30`).
  const KIMI_HOLD_CLEAR_EVENTS = new Set([
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "StopFailure",
    "UserPromptSubmit",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "Notification",
  ]);
  const shouldClearKimiPermission = srcAgentId === "kimi-cli"
    && KIMI_HOLD_CLEAR_EVENTS.has(event);
  if (shouldClearKimiPermission) stopKimiPermissionPoll(sessionId);

  // A brand-new PreToolUse for the same Kimi session starts a fresh approval
  // gate. Drop any leftover hold/suspect from the previous round so the new
  // suspect heuristic decides cleanly (and the animation doesn't carry over
  // from the prior tool).
  if (event === "PreToolUse" && srcAgentId === "kimi-cli") {
    if (kimiPermissionHolds.has(sessionId)) stopKimiPermissionPoll(sessionId);
    else cancelPermissionSuspect(sessionId);
  }

  // Kimi permission heuristic: hook reports permission_suspect=true on
  // PreToolUse for gated tools. We defer the notification switch; if the
  // tool was auto-approved a PostToolUse will cancel us before the timer
  // fires, which is how we avoid flashing notification for auto-approved
  // commands.
  if (
    permissionSuspect === true
    && srcAgentId === "kimi-cli"
    && event === "PreToolUse"
  ) {
    schedulePermissionSuspect(sessionId);
  }

  if (ONESHOT_STATES.has(state)) {
    // Permission animation lock: while any permission request is pending,
    // keep the pet on notification and block all other one-shot visuals.
    // (One-shot branch normally bypasses resolveDisplayState()).
    if (hasPermissionAnimationLock() && state !== "notification") {
      return;
    }
    setState(state);
    return;
  }

  const displayState = resolveDisplayState();
  setState(displayState, getSvgOverride(displayState));
}

function isProcessAlive(pid) {
  try { _kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function cleanStaleSessions() {
  const now = Date.now();
  let changed = false;
  let removedNonHeadless = false;
  // Helper: when a Kimi session is removed by stale cleanup, drop any
  // hold/suspect timer attached to it. Otherwise the pet would stay locked
  // on `notification` even after the Kimi process is gone (the
  // event-driven release paths can never fire post-mortem).
  const disposeKimiTimers = (id) => {
    const hadSuspect = cancelPermissionSuspect(id);
    const hold = kimiPermissionHolds.get(id);
    if (hold) {
      if (hold.timer) clearTimeout(hold.timer);
      kimiPermissionHolds.delete(id);
    }
    // Bubble cleanup: stopKimiPermissionPoll() is the normal release path and
    // already calls clearKimiNotifyBubbles(). When the session dies under us
    // (PID exit / unreachable / source-exit) we bypass that path, so the
    // passive "Check Kimi terminal" bubble would otherwise stay forever.
    if ((hold || hadSuspect) && typeof ctx.clearKimiNotifyBubbles === "function") {
      ctx.clearKimiNotifyBubbles(id);
    }
  };
  for (const [id, s] of sessions) {
    const age = now - s.updatedAt;

    if (s.pidReachable && s.agentPid && !isProcessAlive(s.agentPid)) {
      debugSession(`stale-delete agent-exit ${describeSession(id, s)}`);
      if (!s.headless) removedNonHeadless = true;
      if (s && s.agentId === "kimi-cli") disposeKimiTimers(id);
      sessions.delete(id); changed = true;
      continue;
    }

    if (age > SESSION_STALE_MS) {
      if (s.pidReachable && s.sourcePid) {
        if (!isProcessAlive(s.sourcePid)) {
          debugSession(`stale-delete source-exit ${describeSession(id, s)}`);
          if (!s.headless) removedNonHeadless = true;
          if (s && s.agentId === "kimi-cli") disposeKimiTimers(id);
          sessions.delete(id); changed = true;
        } else if (s.state !== "idle") {
          debugSession(`stale-idle session-timeout ${describeSession(id, s)}`);
          s.state = "idle"; s.displayHint = null; changed = true;
        }
      } else if (!s.pidReachable) {
        debugSession(`stale-delete unreachable ${describeSession(id, s)}`);
        if (!s.headless) removedNonHeadless = true;
        if (s && s.agentId === "kimi-cli") disposeKimiTimers(id);
        sessions.delete(id); changed = true;
      } else {
        debugSession(`stale-delete no-source ${describeSession(id, s)}`);
        if (!s.headless) removedNonHeadless = true;
        if (s && s.agentId === "kimi-cli") disposeKimiTimers(id);
        sessions.delete(id); changed = true;
      }
    } else if (age > WORKING_STALE_MS) {
      if (s.pidReachable && s.sourcePid && !isProcessAlive(s.sourcePid)) {
        debugSession(`stale-delete working-source-exit ${describeSession(id, s)}`);
        if (!s.headless) removedNonHeadless = true;
        if (s && s.agentId === "kimi-cli") disposeKimiTimers(id);
        sessions.delete(id); changed = true;
      } else if (s.state === "working" || s.state === "juggling" || s.state === "thinking") {
        debugSession(`stale-idle working-timeout ${describeSession(id, s)}`);
        s.state = "idle"; s.displayHint = null; s.updatedAt = now; changed = true;
      }
    }
  }
  if (changed && sessions.size === 0) {
    if (removedNonHeadless) {
      queueSleepState();
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

// setState() respects minDisplay timings, so the visible pet finishes
// its current animation before settling to the resolved state.
function clearSessionsByAgent(agentId) {
  if (!agentId) return 0;
  let removed = 0;
  for (const [id, s] of sessions) {
    if (s && s.agentId === agentId) {
      sessions.delete(id);
      if (agentId === "kimi-cli") {
        const hadSuspect = cancelPermissionSuspect(id);
        const hold = kimiPermissionHolds.get(id);
        if (hold) {
          if (hold.timer) clearTimeout(hold.timer);
          kimiPermissionHolds.delete(id);
        }
        // Defense in depth: callers SHOULD pair this with
        // dismissPermissionsByAgent("kimi-cli") (settings-actions does), but
        // direct callers of clearSessionsByAgent shouldn't strand the
        // passive bubble. clearKimiNotifyBubbles is a no-op when nothing
        // matches.
        if ((hold || hadSuspect) && typeof ctx.clearKimiNotifyBubbles === "function") {
          ctx.clearKimiNotifyBubbles(id);
        }
      }
      removed++;
    }
  }
  // Kimi's PermissionRequest event takes the early-return path in
  // updateSession() and never creates a `sessions` entry — only a
  // `kimiPermissionHolds` entry. Sweep those orphans here so disabling Kimi
  // in settings (or any direct caller) doesn't leave a stuck animation lock
  // and "Check Kimi terminal" bubble behind.
  if (agentId === "kimi-cli") {
    const orphanHolds = [...kimiPermissionHolds.keys()];
    for (const id of orphanHolds) {
      const hold = kimiPermissionHolds.get(id);
      if (hold && hold.timer) clearTimeout(hold.timer);
      kimiPermissionHolds.delete(id);
      cancelPermissionSuspect(id);
      if (typeof ctx.clearKimiNotifyBubbles === "function") {
        ctx.clearKimiNotifyBubbles(id);
      }
      removed++;
    }
    const orphanSuspects = [...kimiPermissionSuspectTimers.keys()];
    for (const id of orphanSuspects) {
      cancelPermissionSuspect(id);
      if (typeof ctx.clearKimiNotifyBubbles === "function") {
        ctx.clearKimiNotifyBubbles(id);
      }
    }
  }
  if (removed > 0) {
    const resolved = resolveDisplayState();
    setState(resolved, getSvgOverride(resolved));
  }
  return removed;
}

function detectRunningAgentProcesses(callback) {
  if (_detectInFlight) return;
  _detectInFlight = true;
  const done = (result) => { _detectInFlight = false; callback(result); };
  // Agent gate short-circuit: if every agent is disabled, skip the system
  // call entirely — nothing we could "find" should keep startup recovery
  // alive. When at least one agent is enabled, we still run the combined
  // detection because the query can't attribute individual processes back
  // to agent ids (wmic/pgrep would need per-name queries), and the result
  // is only a boolean for startup recovery — not a session creator.
  if (typeof ctx.hasAnyEnabledAgent === "function" && !ctx.hasAnyEnabledAgent()) {
    done(false);
    return;
  }
  const { exec } = require("child_process");
  if (process.platform === "win32") {
    exec(
      'wmic process where "(Name=\'node.exe\' and CommandLine like \'%claude-code%\') or Name=\'claude.exe\' or Name=\'codex.exe\' or Name=\'copilot.exe\' or Name=\'gemini.exe\' or Name=\'codebuddy.exe\' or Name=\'kiro-cli.exe\' or Name=\'kimi.exe\' or Name=\'opencode.exe\'" get ProcessId /format:csv',
      { encoding: "utf8", timeout: 5000, windowsHide: true },
      (err, stdout) => done(!err && /\d+/.test(stdout))
    );
  } else {
    exec("pgrep -f 'claude-code|codex|copilot|codebuddy|kimi' || pgrep -x 'gemini' || pgrep -x 'kiro-cli' || pgrep -x 'opencode'", { timeout: 3000 },
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

function startKimiPermissionPoll(sessionId) {
  if (!sessionId) return;
  // DND / agent permissions-off both suppress the passive bubble at creation
  // time (see shouldSuppressKimiNotifyBubble in permission.js). Skipping the
  // hold here keeps the animation lock in sync: without it, turning DND off
  // or flipping permissions back on would pin a stale `notification` with
  // nothing actionable for the user. hideBubbles intentionally does NOT
  // short-circuit here — that flag means "hide the UI, keep the animation
  // cue" (mirrors the Codex working-state behavior).
  if (ctx.doNotDisturb) return;
  if (
    typeof ctx.isAgentPermissionsEnabled === "function"
    && !ctx.isAgentPermissionsEnabled("kimi-cli")
  ) return;
  cancelPermissionSuspect(sessionId);
  const existing = kimiPermissionHolds.get(sessionId);
  if (existing && existing.timer) clearTimeout(existing.timer);
  const maxMs = parseKimiHoldMaxMs();
  let timer = null;
  if (maxMs > 0) {
    // Last-resort safety cap. The primary release path is event-driven
    // (PostToolUse / Stop / UserPromptSubmit / new PreToolUse / SessionEnd /
    // cleanStaleSessions when the Kimi PID dies). The timer just prevents
    // permanent stuck state if every other signal is somehow lost.
    timer = setTimeout(() => {
      stopKimiPermissionPoll(sessionId);
    }, maxMs);
  }
  kimiPermissionHolds.set(sessionId, {
    timer,
    until: maxMs > 0 ? Date.now() + maxMs : null,
  });
  // Avoid stacking duplicate passive bubbles for the same pending request.
  // Refreshing the hold timer should not create extra UI noise.
  if (!existing && typeof ctx.showKimiNotifyBubble === "function") {
    ctx.showKimiNotifyBubble({ sessionId });
  }
}

function cancelPermissionSuspect(sessionId) {
  if (!sessionId) return false;
  const existing = kimiPermissionSuspectTimers.get(sessionId);
  if (!existing) return false;
  clearTimeout(existing.timer);
  kimiPermissionSuspectTimers.delete(sessionId);
  return true;
}

function schedulePermissionSuspect(sessionId) {
  if (!sessionId) return;
  const delay = parseSuspectDelay();
  // A zero delay disables the heuristic entirely (caller shouldn't reach
  // this path in that case, but handle defensively).
  if (delay <= 0) return;
  cancelPermissionSuspect(sessionId);
  const timer = setTimeout(() => {
    kimiPermissionSuspectTimers.delete(sessionId);
    // Only promote if the session still exists and no terminal event has
    // flipped it elsewhere (PostToolUse etc. would have cancelled us).
    if (!sessions.has(sessionId) && !kimiPermissionHolds.has(sessionId)) return;
    // Mirror startKimiPermissionPoll's gates here: if DND / Kimi permissions
    // are off, don't even flash notification — startKimiPermissionPoll would
    // skip the hold and the setState("notification") below would either be
    // swallowed by DND or briefly leak a lock-less flash. Keeping the two
    // paths in sync avoids subtle visual noise.
    if (ctx.doNotDisturb) return;
    if (
      typeof ctx.isAgentPermissionsEnabled === "function"
      && !ctx.isAgentPermissionsEnabled("kimi-cli")
    ) return;
    startKimiPermissionPoll(sessionId);
    setState("notification");
  }, delay);
  kimiPermissionSuspectTimers.set(sessionId, { timer, scheduledAt: Date.now() });
}

function stopKimiPermissionPoll(sessionId) {
  if (!sessionId) {
    const hadHold = kimiPermissionHolds.size > 0;
    const hadSuspect = kimiPermissionSuspectTimers.size > 0;
    if (!hadHold && !hadSuspect) return;
    for (const { timer } of kimiPermissionHolds.values()) {
      if (timer) clearTimeout(timer);
    }
    kimiPermissionHolds.clear();
    for (const { timer } of kimiPermissionSuspectTimers.values()) clearTimeout(timer);
    kimiPermissionSuspectTimers.clear();
    if (typeof ctx.clearKimiNotifyBubbles === "function") ctx.clearKimiNotifyBubbles();
    applyResolvedDisplayState();
    return;
  }
  const cancelled = cancelPermissionSuspect(sessionId);
  const existing = kimiPermissionHolds.get(sessionId);
  if (existing) {
    if (existing.timer) clearTimeout(existing.timer);
    kimiPermissionHolds.delete(sessionId);
    if (typeof ctx.clearKimiNotifyBubbles === "function") ctx.clearKimiNotifyBubbles(sessionId);
    applyResolvedDisplayState();
  } else if (cancelled) {
    if (typeof ctx.clearKimiNotifyBubbles === "function") ctx.clearKimiNotifyBubbles(sessionId);
    applyResolvedDisplayState();
  }
}

function resolveDisplayState() {
  let best;
  if (sessions.size === 0) {
    best = "idle";
  } else {
    best = "sleeping";
    let hasNonHeadless = false;
    for (const [, s] of sessions) {
      if (s.headless) continue;
      hasNonHeadless = true;
      if ((STATE_PRIORITY[s.state] || 0) > (STATE_PRIORITY[best] || 0)) best = s.state;
    }
    if (!hasNonHeadless) best = "idle";
  }
  // Permission animation lock (highest priority): if any permission request is
  // pending, always pin notification regardless of session priority.
  if (hasPermissionAnimationLock()) {
    best = "notification";
  }

  // Update overlay participates in priority — won't override higher-priority agent states
  if (updateVisualState && (STATE_PRIORITY[updateVisualState] || 0) >= (STATE_PRIORITY[best] || 0)) {
    return updateVisualState;
  }
  return best;
}

function setUpdateVisualState(kind) {
  if (!kind) {
    updateVisualState = null;
    updateVisualSvgOverride = null;
    return null;
  }
  updateVisualState = UPDATE_VISUAL_STATE_MAP[kind] || kind;
  updateVisualSvgOverride = UPDATE_VISUAL_SVG_MAP[kind] || null;
  return updateVisualState;
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
  if (theme.workingTiers) {
    for (const tier of theme.workingTiers) {
      if (n >= tier.minSessions) return tier.file;
    }
  }
  return STATE_SVGS.working[0];
}

function getWinningSessionDisplayHint(targetState) {
  let best = null;
  let bestAt = -1;
  for (const [, s] of sessions) {
    if (s.headless || s.state !== targetState) continue;
    if (s.updatedAt >= bestAt) {
      bestAt = s.updatedAt;
      best = s;
    }
  }
  if (!best || !best.displayHint) return null;
  // Resolve semantic hint token through displayHintMap
  const resolved = DISPLAY_HINT_MAP[best.displayHint];
  return resolved || null;
}

function getSvgOverride(state) {
  if (updateVisualState && state === updateVisualState && updateVisualSvgOverride) {
    return updateVisualSvgOverride;
  }
  if (state === "idle") return SVG_IDLE_FOLLOW;
  if (state === "working") {
    const hinted = getWinningSessionDisplayHint("working");
    if (hinted) return hinted;
    return getWorkingSvg();
  }
  if (state === "juggling") {
    const hinted = getWinningSessionDisplayHint("juggling");
    if (hinted) return hinted;
    return getJugglingSvg();
  }
  if (state === "thinking") {
    const hinted = getWinningSessionDisplayHint("thinking");
    if (hinted) return hinted;
    return STATE_SVGS.thinking[0];
  }
  return null;
}

function getJugglingSvg() {
  let n = 0;
  for (const [, s] of sessions) {
    if (!s.headless && s.state === "juggling") n++;
  }
  if (theme.jugglingTiers) {
    for (const tier of theme.jugglingTiers) {
      if (n >= tier.minSessions) return tier.file;
    }
  }
  return STATE_SVGS.juggling[0];
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
    entries.push({ id, state: s.state, updatedAt: s.updatedAt, sourcePid: s.sourcePid, cwd: s.cwd, editor: s.editor, pidChain: s.pidChain, host: s.host, headless: s.headless, agentId: s.agentId, sessionTitle: s.sessionTitle, recentEvents: s.recentEvents });
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
    // 4-category badge derived from session.state + recentEvents tail.
    // Not the raw state name — user-facing language (Running/Done/...).
    const badgeKey = SESSION_BADGE_KEYS[deriveSessionBadge(e)] || "sessionBadgeIdle";
    const badgeText = ctx.t(badgeKey);
    const folder = e.cwd ? path.basename(e.cwd) : (e.id.length > 6 ? e.id.slice(0, 6) + ".." : e.id);
    // Prefer user-set session title (Claude Code /rename, Codex turn summary)
    // over the cwd folder name when available.
    const baseName = normalizeTitle(e.sessionTitle) || folder;
    const name = ctx.showSessionId ? `${baseName} #${e.id.slice(-3)}` : baseName;
    const elapsed = formatElapsed(now - e.updatedAt);
    const hasPid = !!e.sourcePid;
    const icon = getAgentIcon(e.agentId);
    const item = {
      label: `${e.headless ? "🤖 " : ""}${name}  ${badgeText}  ${elapsed}`,
      enabled: hasPid,
      click: hasPid ? () => ctx.focusTerminalWindow(e.sourcePid, e.cwd, e.editor, e.pidChain) : undefined,
    };
    if (icon) item.icon = icon;
    return item;
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
// Drops every Kimi hold + suspect timer WITHOUT triggering a state resolve.
// Used by two "channel is no longer available" paths:
//   1. enableDoNotDisturb — the DND loop has already dismissed matching
//      bubbles via resolvePermissionEntry, but without this the lock would
//      pin notification the moment DND is disabled.
//   2. dismissPermissionsByAgent("kimi-cli") — when the user toggles off
//      Kimi's permission UI from settings; symmetric to (1).
// Intentionally does NOT call applyResolvedDisplayState — the callers are
// mid-transition and will resolve the visible state themselves. Returns
// `true` if anything was cleared so callers can trigger their own resolve.
function disposeAllKimiPermissionState() {
  const hadHold = kimiPermissionHolds.size > 0;
  const hadSuspect = kimiPermissionSuspectTimers.size > 0;
  if (!hadHold && !hadSuspect) return false;
  for (const { timer } of kimiPermissionHolds.values()) {
    if (timer) clearTimeout(timer);
  }
  kimiPermissionHolds.clear();
  for (const { timer } of kimiPermissionSuspectTimers.values()) clearTimeout(timer);
  kimiPermissionSuspectTimers.clear();
  return true;
}

function enableDoNotDisturb() {
  if (ctx.doNotDisturb) return;
  ctx.doNotDisturb = true;
  ctx.sendToRenderer("dnd-change", true);
  ctx.sendToHitWin("hit-state-sync", { dndEnabled: true });
  for (const perm of [...ctx.pendingPermissions]) ctx.resolvePermissionEntry(perm, "deny", "DND enabled");
  disposeAllKimiPermissionState();
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; pendingState = null; }
  if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
  stopWakePoll();
  if (ctx.miniMode) {
    applyState("mini-sleep");
  } else {
    applyDndSleepState();
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
    ctx.miniPeeked = false;
    applyState("mini-idle");
  } else {
    playWakeTransitionOrResolve();
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
  for (const { timer } of kimiPermissionHolds.values()) {
    if (timer) clearTimeout(timer);
  }
  kimiPermissionHolds.clear();
  for (const { timer } of kimiPermissionSuspectTimers.values()) clearTimeout(timer);
  kimiPermissionSuspectTimers.clear();
  stopStaleCleanup();
}

return {
  setState, applyState, updateSession, resolveDisplayState, resolveVisualBinding, setUpdateVisualState,
  enableDoNotDisturb, disableDoNotDisturb,
  startStaleCleanup, stopStaleCleanup, startWakePoll, stopWakePoll,
  getSvgOverride, cleanStaleSessions, startStartupRecovery, refreshTheme,
  detectRunningAgentProcesses, buildSessionSubmenu,
  clearSessionsByAgent,
  disposeAllKimiPermissionState,
  deriveSessionBadge,
  getCurrentState, getCurrentSvg, getCurrentHitBox, getStartupRecoveryActive,
  sessions, STATE_PRIORITY, ONESHOT_STATES, SLEEP_SEQUENCE,
  get STATE_SVGS() { return STATE_SVGS; },
  get HIT_BOXES() { return HIT_BOXES; },
  get WIDE_SVGS() { return WIDE_SVGS; },
  cleanup,
};

};
