// src/state.js — State machine + session management + DND + wake poll
// Extracted from main.js L158-240, L299-505, L544-960

let screen;
try { ({ screen } = require("electron")); } catch { screen = null; }
const {
  createStatePriorityConstants,
  getStatePriority,
  resolveDisplayStateFromSessions,
} = require("./state-priority");
const {
  buildStateBindings,
  hasOwnVisualFiles: hasOwnVisualFilesWithBindings,
  resolveVisualBinding: resolveVisualBindingWithBindings,
  getSvgOverride: getSvgOverrideWithDeps,
} = require("./state-visual-resolver");
const {
  getStaleSessionDecision,
  isWorkingLikeState,
} = require("./state-stale-cleanup");
const {
  createHitboxRuntime,
  resolveHitBoxForSvg: resolveHitBoxForSvgWithRuntime,
} = require("./state-hitbox-resolver");
const {
  pickDisplayHint: pickDisplayHintWithMap,
  pushRecentEvent,
} = require("./state-session-events");
const {
  deriveSessionBadge,
  normalizeTitle,
  shouldAutoClearDetachedSession: shouldAutoClearDetachedSessionWithDeps,
  buildSessionSnapshot: buildSessionSnapshotFromSessions,
  getActiveSessionAliasKeys: getActiveSessionAliasKeysFromSessions,
  sessionSnapshotSignature,
} = require("./state-session-snapshot");
const { getAgentIconUrl } = require("./state-agent-icons");

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
let DND_SLEEP_TRANSITION_SVG = null;
let DND_SLEEP_TRANSITION_DURATION = 0;
let COLLAPSE_DURATION = 0;
let SLEEP_MODE = "full";
const { SLEEP_SEQUENCE, STATE_PRIORITY, ONESHOT_STATES } = createStatePriorityConstants();

// Session display hints — validated against theme.displayHintMap keys
let DISPLAY_HINT_MAP = {};

// ── Session tracking ──
const sessions = new Map();
const MAX_SESSIONS = 20;
const ASSISTANT_OUTPUT_MAX = 2400;
const CODEX_EXIT_PROBE_DELAYS_MS = [1000, 3000, 8000, 15000];
// PostCompact intentionally excluded (#406): compaction finishing is not a turn
// completion, so it must not flip awaitingInputSinceStop.
const POST_COMPLETION_EVENTS = new Set(["Stop", "event_msg:task_complete"]);
// #406: forward progress for a session cancels its pending (debounced)
// completion — these events all mean the agent loop is still running.
const COMPLETION_CANCEL_EVENTS = new Set([
  "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
  "PermissionRequest", "Elicitation", "StopFailure", "ApiError", "SessionEnd",
]);
function getCompletionDebounceMs() {
  const raw = process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
  const n = Number.parseInt(raw, 10);
  // Opt-in, default 0 = celebrate immediately on Stop. The field gates
  // (PostCompact / background_tasks / session_crons / stop_hook_active) already
  // suppress the common false completions with zero delay; the debounce only
  // adds value for the rare third-party Stop-hook veto, so it is off by default
  // and users who actually hit that can set CLAWD_COMPLETION_DEBOUNCE_MS > 0.
  if (Number.isFinite(n) && n >= 0 && n <= 10000) return n;
  return 0;
}
let lastSessionSnapshotSignature = null;
let lastSessionSnapshot = null;
let startupRecoveryActive = false;
let startupRecoveryTimer = null;
const STARTUP_RECOVERY_MAX_MS = 300000;
const codexExitProbes = new Map();

function normalizeAssistantOutput(value) {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (!text) return null;
  return text.length > ASSISTANT_OUTPUT_MAX
    ? text.slice(0, ASSISTANT_OUTPUT_MAX)
    : text;
}

// ── Hit-test bounding boxes (from theme) ──
let HIT_BOXES = {};
let FILE_HIT_BOXES = {};
let WIDE_SVGS = new Set();
let SLEEPING_SVGS = new Set();
let hitboxRuntime = { hitBoxes: HIT_BOXES, fileHitBoxes: FILE_HIT_BOXES, wideSvgs: WIDE_SVGS, sleepingSvgs: SLEEPING_SVGS };
let currentHitBox = HIT_BOXES.default;

// ── State machine internal ──
let currentState = "idle";
let previousState = "idle";
let currentSvg = null;
let stateChangedAt = Date.now();
let pendingTimer = null;
let autoReturnTimer = null;
let pendingState = null;
// #406 Stop completion debounce: sessionId -> timer holding a Stop as "working"
// until a quiet window confirms the turn really ended.
const pendingCompletionTimers = new Map();
let eyeResendTimer = null;
let updateVisualState = null;
let updateVisualKind = null;
let updateVisualSvgOverride = null;
let updateVisualPriority = null;

const UPDATE_VISUAL_STATE_MAP = {
  checking: "thinking",
  available: "notification",
  downloading: "carrying",
};

const UPDATE_VISUAL_PRIORITY_MAP = {
  checking: STATE_PRIORITY.notification,
  available: STATE_PRIORITY.notification,
  downloading: STATE_PRIORITY.carrying,
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

function resolveAwaitingInputSinceStop(existing, event) {
  if (POST_COMPLETION_EVENTS.has(event)) return true;
  if (event === "Notification") return !!(existing && existing.awaitingInputSinceStop === true);
  if (!event || event === "stale-cleanup") return !!(existing && existing.awaitingInputSinceStop === true);
  return false;
}

function shouldMuteMiniPostCompletionNotification(state, event, session) {
  return !!ctx.miniMode
    && state === "notification"
    && event === "Notification"
    && session
    && session.awaitingInputSinceStop === true
    && !hasPermissionAnimationLock();
}

// ── Qwen Code self-submit filter ──
// qwen 0.16.1 fires a synthetic UserPromptSubmit ~900-1000ms after
// PostToolUse to feed the tool result back to the model. Without filtering,
// the mascot flashes "thinking" (typing animation) between working and idle.
// Measured twice in dogfood: 908ms (non-interactive) and 945ms (interactive).
// 2000ms window covers the agentic loop with ~2x headroom while still letting
// real human input through after the loop settles. See
// project_qwen_0_16_1_event_semantics for the canary.
//
// Two timestamps split: `lastToolBoundaryAt` tracks PostToolUse /
// PostToolUseFailure (where the agentic loop may still self-submit), and
// `lastStopAt` tracks end-of-turn. Filter only fires when a recent tool
// boundary has NOT yet been followed by Stop — once Stop arrives, any
// further UserPromptSubmit is real user input even if the tool boundary
// is still inside the window. This avoids eating a real "继续" typed
// within 2s of the happy end animation.
const QWEN_SELF_SUBMIT_WINDOW_DEFAULT_MS = 2000;
const QWEN_SELF_SUBMIT_WINDOW_MAX_MS = 10000;
function getQwenSelfSubmitWindowMs() {
  const raw = process.env.CLAWD_QWEN_SELF_SUBMIT_WINDOW_MS;
  if (typeof raw !== "string" || !raw.trim()) return QWEN_SELF_SUBMIT_WINDOW_DEFAULT_MS;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 0 || n > QWEN_SELF_SUBMIT_WINDOW_MAX_MS) {
    return QWEN_SELF_SUBMIT_WINDOW_DEFAULT_MS;
  }
  return n;
}
function isQwenSelfSubmitFilterEnabled() {
  // Default on. Kill switch for users to disable if qwen ≥0.17 changes the
  // self-submit behavior in a way that breaks this filter.
  return process.env.CLAWD_QWEN_SELF_SUBMIT_FILTER !== "0";
}

// ── Stale cleanup ──
let staleCleanupTimer = null;
let _detectInFlight = false;

// ── Session Dashboard constants ──
const STATE_LABEL_KEY = {
  working: "sessionWorking", thinking: "sessionThinking", juggling: "sessionJuggling",
  idle: "sessionIdle", sleeping: "sessionSleeping",
};

function resolveHitBoxForSvg(svg) {
  return resolveHitBoxForSvgWithRuntime(svg, hitboxRuntime);
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
  DND_SLEEP_TRANSITION_SVG = typeof theme.timings.dndSleepTransitionSvg === "string" && theme.timings.dndSleepTransitionSvg
    ? theme.timings.dndSleepTransitionSvg.split(/[\\/]/).pop()
    : null;
  DND_SLEEP_TRANSITION_DURATION = Number.isFinite(theme.timings.dndSleepTransitionDuration) && theme.timings.dndSleepTransitionDuration > 0
    ? Math.floor(theme.timings.dndSleepTransitionDuration)
    : 0;
  COLLAPSE_DURATION = theme.timings.collapseDuration || 0;
  SLEEP_MODE = theme.sleepSequence && theme.sleepSequence.mode === "direct" ? "direct" : "full";
  DISPLAY_HINT_MAP = theme.displayHintMap || {};
  hitboxRuntime = createHitboxRuntime(theme);
  HIT_BOXES = hitboxRuntime.hitBoxes;
  FILE_HIT_BOXES = hitboxRuntime.fileHitBoxes;
  WIDE_SVGS = hitboxRuntime.wideSvgs;
  SLEEPING_SVGS = hitboxRuntime.sleepingSvgs;

  currentHitBox = resolveHitBoxForSvg(currentSvg);
  refreshUpdateVisualOverride();
}

refreshTheme();

function refreshUpdateVisualOverride() {
  updateVisualSvgOverride = (updateVisualKind === "checking" && theme && theme.updateVisuals && theme.updateVisuals.checking)
    ? theme.updateVisuals.checking
    : null;
}

function shouldDropForDnd() {
  return !!ctx.doNotDisturb;
}

function setState(newState, svgOverride, options = {}) {
  if (shouldDropForDnd()) return;

  if (newState === "yawning" && SLEEP_SEQUENCE.has(currentState)) return;

  if (pendingTimer) {
    if (pendingState && getStatePriority(newState, STATE_PRIORITY) < getStatePriority(pendingState, STATE_PRIORITY)) {
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
    const pendingOptions = options;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      const queued = pendingState;
      const queuedSvg = pendingSvgOverride;
      const queuedOptions = pendingOptions || {};
      pendingState = null;
      if (ONESHOT_STATES.has(queued)) {
        applyState(queued, queuedSvg, queuedOptions);
      } else {
        const resolved = resolveDisplayState();
        applyState(resolved, getSvgOverride(resolved), queuedOptions);
      }
    }, remaining);
  } else {
    applyState(newState, svgOverride, options);
  }
}

function isOneshotDisabled(logicalState) {
  if (!ONESHOT_STATES.has(logicalState)) return false;
  if (typeof ctx.isOneshotDisabled !== "function") return false;
  try { return ctx.isOneshotDisabled(logicalState) === true; }
  catch { return false; }
}

function hasOwnVisualFiles(state) {
  return hasOwnVisualFilesWithBindings(STATE_BINDINGS, state);
}

function resolveVisualBinding(state) {
  return resolveVisualBindingWithBindings(state, STATE_BINDINGS);
}

function applyResolvedDisplayState() {
  const resolved = resolveDisplayState();
  applyState(resolved, getSvgOverride(resolved), resolveSoundOptionsForState(resolved));
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

function applyDndSleepState() {
  if (SLEEP_MODE === "direct") {
    applyState("sleeping");
    return;
  }
  if (DND_SLEEP_TRANSITION_SVG) {
    applyState("collapsing", DND_SLEEP_TRANSITION_SVG);
    return;
  }
  applyState(DND_SKIP_YAWN ? "collapsing" : "yawning");
}

function resolveSoundOptionsForState(state) {
  const logicalState = state === "mini-alert" ? "notification" : state;
  if (logicalState !== "notification") return {};
  let sawNotificationSession = false;
  for (const [, session] of sessions) {
    if (!session || session.headless || session.state !== "notification") continue;
    sawNotificationSession = true;
    if (session.muteNotificationSound !== true) return {};
  }
  return sawNotificationSession ? { muteNotificationSound: true } : {};
}

function normalizeApplyStateOptions(state, options = {}) {
  const derived = resolveSoundOptionsForState(state);
  return {
    ...options,
    muteNotificationSound:
      options.muteNotificationSound === true || derived.muteNotificationSound === true,
  };
}

function applyState(state, svgOverride, options = {}) {
  const applyOptions = normalizeApplyStateOptions(state, options);
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
    if (state === "notification") return applyState("mini-alert", undefined, applyOptions);
    if (state === "attention") return applyState("mini-happy", undefined, applyOptions);
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
    if (ctx.flashTaskbar) ctx.flashTaskbar();
  } else if (state === "notification" || state === "mini-alert") {
    if (!applyOptions.muteNotificationSound) ctx.playSound("confirm");
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

  currentHitBox = resolveHitBoxForSvg(svg);

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
  } else if (state === "collapsing") {
    const dndCollapseDuration = (
      ctx.doNotDisturb
      && DND_SLEEP_TRANSITION_SVG
      && svg === DND_SLEEP_TRANSITION_SVG
      && DND_SLEEP_TRANSITION_DURATION > 0
    )
      ? DND_SLEEP_TRANSITION_DURATION
      : 0;
    const collapseDuration = dndCollapseDuration || COLLAPSE_DURATION;
    if (collapseDuration > 0) {
      autoReturnTimer = setTimeout(() => {
        autoReturnTimer = null;
        applyState("sleeping");
      }, collapseDuration);
    }
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
  return pickDisplayHintWithMap(state, existing, incoming, DISPLAY_HINT_MAP);
}

function debugSession(msg) {
  if (typeof ctx.debugLog !== "function") return;
  try { ctx.debugLog(msg); } catch {}
}

function formatPidChain(pidChain) {
  return Array.isArray(pidChain) && pidChain.length
    ? `[${pidChain.join(">")}]`
    : "[]";
}

function clearCodexExitProbe(sessionId) {
  const id = typeof sessionId === "string" ? sessionId : "";
  if (!id) return false;
  const existing = codexExitProbes.get(id);
  if (!existing) return false;
  for (const timer of existing.timers || []) clearTimeout(timer);
  codexExitProbes.delete(id);
  return true;
}

function cancelCodexExitProbe(sessionId, reason) {
  const id = typeof sessionId === "string" ? sessionId : "";
  if (!id) return false;
  const removed = clearCodexExitProbe(id);
  if (removed) debugSession(`codex-exit-probe cancel sid=${id} reason=${reason || "-"}`);
  return removed;
}

function runCodexExitProbe(sessionId, token, delayMs) {
  const entry = codexExitProbes.get(sessionId);
  if (!entry || entry.token !== token) return;

  const session = sessions.get(sessionId);
  if (!session) {
    clearCodexExitProbe(sessionId);
    debugSession(`codex-exit-probe finish sid=${sessionId} reason=no-session delay=${delayMs}`);
    return;
  }

  if (session.agentId !== "codex" || session.headless || session.host || !session.agentPid || !session.pidReachable) {
    clearCodexExitProbe(sessionId);
    debugSession(
      `codex-exit-probe finish ${describeSession(sessionId, session)} reason=not-probeable ` +
      `delay=${delayMs} host=${session.host || "-"} chain=${formatPidChain(session.pidChain)}`
    );
    return;
  }

  const agentAlive = isProcessAlive(session.agentPid);
  const sourceAlive = session.sourcePid ? isProcessAlive(session.sourcePid) : null;
  const final = delayMs === entry.finalDelay;
  debugSession(
    `codex-exit-probe check ${describeSession(sessionId, session)} delay=${delayMs} ` +
    `agentAlive=${agentAlive ? 1 : 0} sourceAlive=${sourceAlive == null ? "-" : (sourceAlive ? 1 : 0)} ` +
    `final=${final ? 1 : 0} chain=${formatPidChain(session.pidChain)}`
  );

  if (!agentAlive) {
    clearCodexExitProbe(sessionId);
    debugSession(
      `codex-exit-probe delete reason=agent-exit delay=${delayMs} ` +
      `${describeSession(sessionId, session)} chain=${formatPidChain(session.pidChain)}`
    );
    cleanStaleSessions();
    return;
  }

  if (final) {
    clearCodexExitProbe(sessionId);
    debugSession(
      `codex-exit-probe keep reason=agent-alive ${describeSession(sessionId, session)} ` +
      `chain=${formatPidChain(session.pidChain)}`
    );
  }
}

function scheduleCodexExitProbe(sessionId) {
  const session = sessions.get(sessionId);
  clearCodexExitProbe(sessionId);

  if (!session) {
    debugSession(`codex-exit-probe skip sid=${sessionId} reason=no-session`);
    return;
  }
  if (session.agentId !== "codex") return;
  if (session.headless) {
    debugSession(`codex-exit-probe skip ${describeSession(sessionId, session)} reason=headless`);
    return;
  }
  if (session.host) {
    debugSession(`codex-exit-probe skip ${describeSession(sessionId, session)} reason=remote-host host=${session.host}`);
    return;
  }
  if (!session.agentPid) {
    debugSession(
      `codex-exit-probe skip ${describeSession(sessionId, session)} reason=no-agent-pid ` +
      `chain=${formatPidChain(session.pidChain)}`
    );
    return;
  }
  if (!session.pidReachable) {
    debugSession(
      `codex-exit-probe skip ${describeSession(sessionId, session)} reason=pid-unreachable ` +
      `chain=${formatPidChain(session.pidChain)}`
    );
    return;
  }

  const token = Symbol(sessionId);
  const entry = {
    token,
    timers: [],
    finalDelay: CODEX_EXIT_PROBE_DELAYS_MS[CODEX_EXIT_PROBE_DELAYS_MS.length - 1],
  };
  codexExitProbes.set(sessionId, entry);
  debugSession(
    `codex-exit-probe schedule ${describeSession(sessionId, session)} ` +
    `delays=${CODEX_EXIT_PROBE_DELAYS_MS.join(",")} chain=${formatPidChain(session.pidChain)}`
  );
  for (const delayMs of CODEX_EXIT_PROBE_DELAYS_MS) {
    const timer = setTimeout(() => runCodexExitProbe(sessionId, token, delayMs), delayMs);
    entry.timers.push(timer);
  }
}

function updateCodexExitProbe(sessionId, agentId, event) {
  if (agentId !== "codex") return;
  if (event === "Stop") {
    scheduleCodexExitProbe(sessionId);
  } else {
    cancelCodexExitProbe(sessionId, event || "state-update");
  }
}

function shouldAutoClearDetachedSession(session, badge) {
  return shouldAutoClearDetachedSessionWithDeps(session, badge, {
    sessionHudCleanupDetached: ctx.sessionHudCleanupDetached === true,
    isProcessAlive,
  });
}

function getSessionAliases() {
  if (typeof ctx.getSessionAliases !== "function") return {};
  const aliases = ctx.getSessionAliases();
  return aliases && typeof aliases === "object" && !Array.isArray(aliases)
    ? aliases
    : {};
}

function buildSessionSnapshot() {
  return buildSessionSnapshotFromSessions(sessions, {
    sessionAliases: getSessionAliases(),
    getAgentIconUrl,
    statePriority: STATE_PRIORITY,
    sessionHudCleanupDetached: ctx.sessionHudCleanupDetached === true,
    focusHostPlatform: ctx.focusHostPlatform || process.platform,
    isProcessAlive,
  });
}

function getActiveSessionAliasKeys() {
  return getActiveSessionAliasKeysFromSessions(sessions);
}

function broadcastSessionSnapshot(snapshot) {
  if (typeof ctx.broadcastSessionSnapshot !== "function") return;
  try { ctx.broadcastSessionSnapshot(snapshot); } catch {}
}

function emitSessionSnapshot(options = {}) {
  const force = !!options.force;
  const snapshot = buildSessionSnapshot();
  const signature = sessionSnapshotSignature(snapshot);
  const changed = force || signature !== lastSessionSnapshotSignature;
  lastSessionSnapshot = snapshot;
  if (changed) {
    lastSessionSnapshotSignature = signature;
    broadcastSessionSnapshot(snapshot);
  }
  return { changed, snapshot };
}

function getLastSessionSnapshot() {
  if (!lastSessionSnapshot) lastSessionSnapshot = buildSessionSnapshot();
  return lastSessionSnapshot;
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
    `pidReachable=${session.pidReachable ? 1 : 0}`,
    `headless=${session.headless ? 1 : 0}`,
  ].join(" ");
}

function resolvePidReachable(existing, agentPid, sourcePid) {
  if (agentPid && isProcessAlive(agentPid)) return true;
  if (sourcePid && isProcessAlive(sourcePid)) return true;
  return existing ? !!existing.pidReachable : false;
}

function evictOldestSessionIfNeeded(sessionId) {
  if (sessions.has(sessionId) || sessions.size < MAX_SESSIONS) return;

  // Phase 1: prefer the oldest NON-ack session — capacity safety is what we
  // care about first, but we don't want to silently evict a session the user
  // hasn't seen yet.
  let oldestId = null;
  let oldestTime = Infinity;
  for (const [id, s] of sessions) {
    if (s && s.requiresCompletionAck === true) continue;
    if (s.updatedAt < oldestTime) {
      oldestTime = s.updatedAt;
      oldestId = id;
    }
  }

  // Phase 2: only when EVERY entry is ack-pending do we evict the oldest
  // ack one — capacity is a memory cap, ack retention is a UX promise; when
  // they conflict, capacity has to win.
  if (!oldestId) {
    for (const [id, s] of sessions) {
      if (s.updatedAt < oldestTime) {
        oldestTime = s.updatedAt;
        oldestId = id;
      }
    }
  }

  if (oldestId) sessions.delete(oldestId);
}

// Sets / clears `requiresCompletionAck` based on the current event.
// Called from updateSession's `finally` block so every early-return path
// (PermissionRequest on disabled Kimi, SessionEnd, SubagentStop on missing
// session, etc.) still gets its flag reconciled — placing this in the
// dispatch body would miss those paths.
//
// `ackedAt` is intentionally NOT touched here. It's only set in
// ackSessionCompletion (user-initiated). The reconciler just toggles the
// boolean flag.
function isRemoteCodexCompletionEvent(srcAgentId, srcHost, event) {
  return srcAgentId === "codex"
    && !!srcHost
    && (event === "Stop" || event === "event_msg:task_complete");
}

function isAckPreservingHousekeepingEvent(srcAgentId, srcHost, event) {
  return srcAgentId === "codex"
    && !!srcHost
    && event === "stale-cleanup";
}

function reconcileAckFlag(sessionId, srcAgentId, srcHost, event) {
  const entry = sessions.get(sessionId);
  if (!entry) return; // session was deleted by this update — nothing to do
  if (isRemoteCodexCompletionEvent(srcAgentId, srcHost, event)) {
    entry.requiresCompletionAck = true;
  } else if (
    entry.requiresCompletionAck
    && !isAckPreservingHousekeepingEvent(srcAgentId, srcHost, event)
  ) {
    // Strict equality on completion events: any other semantic event
    // (including null/undefined refreshes) clears the flag. Remote Codex
    // stale-cleanup is housekeeping from the JSONL monitor, so it must not
    // erase an unacknowledged completion.
    entry.requiresCompletionAck = false;
  }
}

// User-initiated acknowledgment. Returns true if the session existed AND had
// the flag set (a meaningful clear happened). Returns false for missing
// sessions or sessions that aren't pending — both are idempotent no-ops the
// renderer can safely ignore.
function ackSessionCompletion(sessionId) {
  const id = typeof sessionId === "string" ? sessionId : "";
  if (!id) return false;
  const session = sessions.get(id);
  if (!session) return false;
  if (session.requiresCompletionAck !== true) return false;
  session.requiresCompletionAck = false;
  session.ackedAt = Date.now();
  // Force snapshot so the Mark-read button visibility (and any HUD bell
  // wiring) reaches renderers without waiting for the next debounce.
  emitSessionSnapshot({ force: true });
  return true;
}

function resolveIncomingAgentId(existing, incomingAgentId, incomingDefaulted) {
  const remembered = existing && existing.agentId ? existing.agentId : null;
  // `incomingDefaulted` means the route only fell back to the legacy
  // Claude attribution. Preserve the remembered owner for that session id;
  // agents that can share ids with other agents must namespace upstream.
  if (incomingDefaulted && remembered) return remembered;
  return incomingAgentId || remembered || null;
}

// ── #406 Stop completion gate ──
// A Claude "Stop" maps to "attention" (celebrate + complete sound), but a Stop
// is not always a real turn completion. Decidable-now signals (live
// background_tasks/session_crons, or a stop_hook_active continuation) are held
// as "working" by updateSession directly. For a plain Stop we debounce: hold
// "working" and only celebrate if no forward-progress event for the session
// arrives within the window — this catches a third-party Stop hook that vetoes
// the stop (Claude keeps going) without us ever seeing the veto.
function scheduleCompletionDebounce(sessionId) {
  const debounceMs = getCompletionDebounceMs();
  const existing = pendingCompletionTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingCompletionTimers.delete(sessionId);
    promoteCompletion(sessionId);
  }, debounceMs);
  pendingCompletionTimers.set(sessionId, timer);
}

function cancelCompletionDebounce(sessionId, reason) {
  const timer = pendingCompletionTimers.get(sessionId);
  if (!timer) return;
  clearTimeout(timer);
  pendingCompletionTimers.delete(sessionId);
  debugSession(`stop-debounce cancel sid=${sessionId} by=${reason || "-"}`);
}

function clearAllCompletionDebounces() {
  for (const timer of pendingCompletionTimers.values()) clearTimeout(timer);
  pendingCompletionTimers.clear();
}

// Debounce window elapsed with no forward progress → the turn really ended.
// Replay the real Stop the gate withheld: append a Stop event (so the badge →
// "done" and the Telegram completion fires exactly once, re-asserting a Stop
// tail over any Notification that landed during the window), settle to idle,
// and only now flip awaitingInputSinceStop. Then celebrate, unless a Kimi
// permission lock is holding the pet.
function promoteCompletion(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.recentEvents = pushRecentEvent(session, "idle", "Stop");
  session.state = "idle";
  session.updatedAt = Date.now();
  session.displayHint = null;
  session.awaitingInputSinceStop = true;
  emitSessionSnapshot({ force: true });
  if (hasPermissionAnimationLock()) {
    const display = resolveDisplayState();
    setState(display, getSvgOverride(display));
    return;
  }
  // The completion's data (done badge + Telegram push) already landed via the
  // snapshot above. The celebration is visual-only, so let setState()'s
  // priority guard decide: if a higher-priority visual is queued — possibly
  // from ANOTHER session (e.g. an error) — it must win. We must NOT clear the
  // global pending queue here; pendingTimer/pendingState are process-wide, not
  // per-session, so clearing them would swallow another session's visual.
  setState("attention");
}

// ── Session management ──
// Session-related fields go through `opts`. Earlier versions took 13
// positional params — refactored in B2 to an options bag so new fields
// (sessionTitle, etc.) don't keep extending the argument list.
function updateSession(sessionId, state, event, opts = {}) {
  try {
  const {
    sourcePid = null,
    wtHwnd = null,
    cwd = null,
    editor = null,
    pidChain = null,
    agentPid = null,
    agentId = null,
    host = null,
    headless = false,
    platform = null,
    model = null,
    provider = null,
    codexOriginator = null,
    codexSource = null,
    displayHint = undefined,
    sessionTitle = null,
    assistantLastOutput = null,
    assistantLastOutputTruncated = false,
    permissionSuspect = false,
    preserveState = false,
    hookSource = null,
    agentIdDefaulted = false,
    muteNotificationSound = false,
    transientPermissionEvent = false,
    backgroundTasksCount = 0,
    sessionCronsCount = 0,
    stopHookActive = false,
  } = opts;
  if (startupRecoveryActive) {
    startupRecoveryActive = false;
    if (startupRecoveryTimer) { clearTimeout(startupRecoveryTimer); startupRecoveryTimer = null; }
  }

  // #406: forward progress cancels a pending debounced completion. Runs before
  // the PermissionRequest early-return so a permission prompt cancels too.
  if (event !== "Stop" && COMPLETION_CANCEL_EVENTS.has(event)) {
    cancelCompletionDebounce(sessionId, event);
  }

  const sessionForPerm = sessions.get(sessionId);
  const permAgentId = resolveIncomingAgentId(sessionForPerm, agentId, agentIdDefaulted);

  if (event === "PermissionRequest") {
    if (permAgentId === "codex") cancelCodexExitProbe(sessionId, "PermissionRequest");
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
    const shouldPersistCodexPermissionFocus = permAgentId === "codex" && (
      sourcePid || wtHwnd || agentPid || (pidChain && pidChain.length) || cwd || host ||
      model || provider || codexOriginator || codexSource || platform
    );
    if (shouldPersistCodexPermissionFocus) {
      const existing = sessions.get(sessionId);
      evictOldestSessionIfNeeded(sessionId);
      const srcPid = sourcePid || (existing && existing.sourcePid) || null;
      const srcWtHwnd = wtHwnd || (existing && existing.wtHwnd) || null;
      const srcCwd = cwd || (existing && existing.cwd) || "";
      const srcEditor = editor || (existing && existing.editor) || null;
      const srcPidChain = (pidChain && pidChain.length) ? pidChain : (existing && existing.pidChain) || null;
      const srcAgentPid = agentPid || (existing && existing.agentPid) || null;
      const srcAgentId = resolveIncomingAgentId(existing, agentId, agentIdDefaulted);
      const srcHost = host || (existing && existing.host) || null;
      const srcHeadless = headless || (existing && existing.headless) || false;
      const srcPlatform = platform || (existing && existing.platform) || null;
      const srcModel = model || (existing && existing.model) || null;
      const srcProvider = provider || (existing && existing.provider) || null;
      const srcCodexOriginator = codexOriginator || (existing && existing.codexOriginator) || null;
      const srcCodexSource = codexSource || (existing && existing.codexSource) || null;
      const srcSessionTitle = normalizeTitle(sessionTitle) || (existing && existing.sessionTitle) || null;
      // PermissionRequest should flash the pet via setState("notification"),
      // but a brand-new Codex permission session must not persist as
      // notification. Otherwise, if the prompt is resolved remotely and no
      // later hook arrives for that synthetic session, auto-return keeps
      // resolving back to notification forever.
      const storedState = existing && existing.state ? existing.state : "idle";
      const recentEvents = transientPermissionEvent === true
        ? (Array.isArray(existing && existing.recentEvents) ? existing.recentEvents.slice() : [])
        : pushRecentEvent(existing, storedState, event);
      sessions.set(sessionId, {
        state: storedState,
        updatedAt: Date.now(),
        displayHint: existing ? existing.displayHint : null,
        sourcePid: srcPid,
        wtHwnd: srcWtHwnd,
        cwd: srcCwd,
        editor: srcEditor,
        pidChain: srcPidChain,
        agentPid: srcAgentPid,
        agentId: srcAgentId,
        host: srcHost,
        headless: srcHeadless,
        platform: srcPlatform,
        model: srcModel,
        provider: srcProvider,
        codexOriginator: srcCodexOriginator,
        codexSource: srcCodexSource,
        sessionTitle: srcSessionTitle,
        recentEvents,
        pidReachable: resolvePidReachable(existing, srcAgentPid, srcPid),
        resumeState: (existing && existing.resumeState) || null,
        muteNotificationSound: muteNotificationSound === true,
      });
    }
    setState("notification", undefined, { muteNotificationSound: muteNotificationSound === true });
    if (permAgentId === "kimi-cli") startKimiPermissionPoll(sessionId);
    return;
  }

  const existing = sessions.get(sessionId);
  const srcPid = sourcePid || (existing && existing.sourcePid) || null;
  const srcWtHwnd = wtHwnd || (existing && existing.wtHwnd) || null;
  const srcCwd = cwd || (existing && existing.cwd) || "";
  const srcEditor = editor || (existing && existing.editor) || null;
  const srcPidChain = (pidChain && pidChain.length) ? pidChain : (existing && existing.pidChain) || null;
  const srcAgentPid = agentPid || (existing && existing.agentPid) || null;
  const srcAgentId = resolveIncomingAgentId(existing, agentId, agentIdDefaulted);
  const srcHost = host || (existing && existing.host) || null;
  const srcHeadless = headless || (existing && existing.headless) || false;
  const srcPlatform = platform || (existing && existing.platform) || null;
  const srcModel = model || (existing && existing.model) || null;
  const srcProvider = provider || (existing && existing.provider) || null;
  const srcCodexOriginator = codexOriginator || (existing && existing.codexOriginator) || null;
  const srcCodexSource = codexSource || (existing && existing.codexSource) || null;
  // Sticky: empty input does not clear an existing title. A session that has
  // ever been named keeps that name until the user explicitly renames it.
  const srcSessionTitle = normalizeTitle(sessionTitle) || (existing && existing.sessionTitle) || null;
  const srcAssistantLastOutput = normalizeAssistantOutput(assistantLastOutput);
  const srcAssistantLastOutputTruncated = !!(srcAssistantLastOutput && assistantLastOutputTruncated === true);
  const srcResumeState = (existing && existing.resumeState) || null;
  const isSubagentStart = event === "SubagentStart" || event === "subagentStart";
  const isSubagentStop = event === "SubagentStop" || event === "subagentStop";
  const preservedState = preserveState && existing ? existing.state : null;

  // #406 Stop completion gate — Claude Code only; other agents keep their own
  // completion semantics (Codex task_complete + remote exit probes, etc.). A
  // Stop → "attention" is not always a real turn end:
  //   · live background_tasks / session_crons → work continues in the bg
  //   · stop_hook_active → a Stop hook vetoed the stop; Claude will continue
  //   · a third-party Stop hook can veto THIS stop, invisibly to us → debounce
  // The first two are decidable now: hold "working" (badge stays "running", no
  // celebrate, no "done"). A plain Stop is debounced — held "working" until a
  // quiet window with no forward-progress event confirms the turn really ended.
  if (event === "Stop" && state === "attention" && srcAgentId === "claude-code") {
    cancelCompletionDebounce(sessionId, "stop-superseded");
    const liveWork =
      backgroundTasksCount > 0 || sessionCronsCount > 0 || stopHookActive === true;
    const debounceMs = getCompletionDebounceMs();
    if (liveWork || debounceMs > 0) {
      // Hold the Stop as "working" and DROP the event to null so recentEvents
      // keeps NO "Stop" tail while held. Why null and not "Stop": deriveSessionBadge
      // only inspects the latest event, so a withheld Stop tail would (a) be
      // resurrected as a false "done" once stale-cleanup flips the session to
      // idle, and (b) be buried by a follow-up Notification, losing the real
      // completion. With no tail the badge stays "running" (no celebrate, no
      // done, no Telegram push). promoteCompletion replays a real Stop if/when
      // the quiet window confirms the turn actually ended.
      state = "working";
      event = null;
      if (liveWork) {
        debugSession(
          `stop-gate sid=${sessionId} bg=${backgroundTasksCount} crons=${sessionCronsCount} active=${stopHookActive} action=hold-working`
        );
        // liveWork never auto-promotes; a later plain Stop (no bg work) will.
      } else {
        scheduleCompletionDebounce(sessionId);
      }
    }
    // debounceMs <= 0 && !liveWork → keep "attention" (immediate celebration).
  }

  // Qwen Code 0.16.1 self-submit guard. qwen's agentic loop fires a synthetic
  // UserPromptSubmit ~900-1000ms after PostToolUse to feed the tool result
  // back to the model. Dropping it here (before pushRecentEvent / setState)
  // prevents the mascot from flashing "thinking" between working and idle.
  // Falls through to normal handling when:
  //   - No existing session / no tool boundary (cannot prove self-submit)
  //   - Outside the window (real human input)
  //   - Stop has fired AFTER the most recent tool boundary (end-of-turn
  //     reached — any UserPromptSubmit now is real user input)
  //   - Kill switch CLAWD_QWEN_SELF_SUBMIT_FILTER="0"
  if (
    event === "UserPromptSubmit"
    && srcAgentId === "qwen-code"
    && existing
    && Number.isFinite(existing.lastToolBoundaryAt)
    && (Date.now() - existing.lastToolBoundaryAt) < getQwenSelfSubmitWindowMs()
    && !(Number.isFinite(existing.lastStopAt) && existing.lastStopAt >= existing.lastToolBoundaryAt)
    && isQwenSelfSubmitFilterEnabled()
  ) {
    debugSession(`qwen self-submit drop sid=${sessionId} elapsed=${Date.now() - existing.lastToolBoundaryAt}ms`);
    return;
  }

  debugSession(`event ${describeSession(sessionId, existing)} -> incoming=${state}/${event || "-"} hint=${displayHint || "-"} source=${hookSource || "-"}`);

  const pidReachable = resolvePidReachable(existing, srcAgentPid, srcPid);

  const recentEvents = pushRecentEvent(existing, preservedState || state, event);
  const preserveCompletionAck =
    existing
    && existing.requiresCompletionAck === true
    && isAckPreservingHousekeepingEvent(srcAgentId, srcHost, event);
  // Agent-loop boundary timestamps for the qwen self-submit filter. Two
  // split fields: `lastToolBoundaryAt` (PostToolUse / PostToolUseFailure)
  // marks where a synthetic UserPromptSubmit may still follow within the
  // ~1s window; `lastStopAt` (Stop) marks end-of-turn after which any
  // UserPromptSubmit is real user input. PostToolUseFailure is a generic
  // defensive boundary — qwen 0.16.1 does not emit it, but other agents
  // sharing this state.js do (claude-code, codex), and a future qwen
  // version may. Propagated through `base` so every sessions.set path
  // keeps both values until the next bump.
  const isToolBoundary = event === "PostToolUse" || event === "PostToolUseFailure";
  const isStopBoundary = event === "Stop";
  const srcLastToolBoundaryAt = isToolBoundary
    ? Date.now()
    : (existing && Number.isFinite(existing.lastToolBoundaryAt) ? existing.lastToolBoundaryAt : null);
  const srcLastStopAt = isStopBoundary
    ? Date.now()
    : (existing && Number.isFinite(existing.lastStopAt) ? existing.lastStopAt : null);
  const base = { sourcePid: srcPid, wtHwnd: srcWtHwnd, cwd: srcCwd, editor: srcEditor, pidChain: srcPidChain, agentPid: srcAgentPid, agentId: srcAgentId, host: srcHost, headless: srcHeadless, platform: srcPlatform, model: srcModel, provider: srcProvider, codexOriginator: srcCodexOriginator, codexSource: srcCodexSource, sessionTitle: srcSessionTitle, assistantLastOutput: srcAssistantLastOutput, assistantLastOutputTruncated: srcAssistantLastOutputTruncated, recentEvents, pidReachable, lastToolBoundaryAt: srcLastToolBoundaryAt, lastStopAt: srcLastStopAt, awaitingInputSinceStop: resolveAwaitingInputSinceStop(existing, event), muteNotificationSound: state === "notification" && muteNotificationSound === true };
  if (preserveCompletionAck) base.requiresCompletionAck = true;

  // Evict oldest session if at capacity and this is a new session.
  evictOldestSessionIfNeeded(sessionId);

  if (isSubagentStop) {
    updateCodexExitProbe(sessionId, srcAgentId, event);
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
    cancelCodexExitProbe(sessionId, "SessionEnd");
    sessions.delete(sessionId);
    debugSession(`session-end delete ${describeSession(sessionId, endingSession)}`);
    cleanStaleSessions();
    if (srcAgentId === "kimi-cli") stopKimiPermissionPoll(sessionId);
    if (!endingSession || !endingSession.headless) {
      // /clear sends sweeping — play it even if other sessions are active
      // (sweeping is ONESHOT and auto-returns, so it won't interfere)
      if (state === "sweeping") {
        setState("sweeping");
        return;
      }
    }
    const displayState = resolveDisplayState();
    setState(displayState, getSvgOverride(displayState));
    return;
  } else if (preservedState) {
    const dh = pickDisplayHint(preservedState, existing, displayHint);
    sessions.set(sessionId, {
      state: preservedState,
      updatedAt: Date.now(),
      displayHint: dh,
      ...base,
      resumeState: srcResumeState,
    });
  } else if (state === "attention" || state === "notification" || SLEEP_SEQUENCE.has(state)) {
    sessions.set(sessionId, { state: "idle", updatedAt: Date.now(), displayHint: null, ...base, resumeState: null });
  } else if (ONESHOT_STATES.has(state)) {
    if (existing) {
      Object.assign(existing, base);
      existing.state = "idle";
      existing.updatedAt = Date.now();
      existing.displayHint = null;
      existing.resumeState = null;
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
  updateCodexExitProbe(sessionId, srcAgentId, event);
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
    // Mini mode already celebrated completion with mini-happy. Keep the idle
    // wait-for-input event in session history, but do not make the tucked-away
    // pet pop a second strong alert for the same completed turn.
    if (
      event === "Notification"
      && state === "notification"
      && shouldMuteMiniPostCompletionNotification(state, event, sessions.get(sessionId))
    ) {
      const displayState = resolveDisplayState();
      setState(displayState, getSvgOverride(displayState));
      return;
    }
    // Per-agent Notification-hook mute: presentation-layer only. By this
    // point session bookkeeping, recentEvents, and Kimi hold-release cleanup
    // have already run — matching the Animation Map "events still fire"
    // contract. We only skip the bell + animation for agents whose
    // wait-for-input alerts toggle is off.
    if (
      event === "Notification"
      && state === "notification"
      && srcAgentId
      && typeof ctx.isAgentNotificationHookEnabled === "function"
      && !ctx.isAgentNotificationHookEnabled(srcAgentId)
    ) {
      const displayState = resolveDisplayState();
      setState(displayState, getSvgOverride(displayState));
      return;
    }
    setState(state);
    return;
  }

  const displayState = resolveDisplayState();
  setState(displayState, getSvgOverride(displayState));
  } finally {
    try {
      // Reconcile the ack flag from the LATEST entry view, not the closure
      // copies taken at the top — early-return paths (state.js Kimi
      // PermissionRequest gate, SessionEnd, SubagentStop on missing
      // session) bail out before the resolved srcAgentId/srcHost block
      // runs. The Object.assign(existing, base) ONESHOT branch can also
      // rebuild the entry midway. Re-fetch + fall back to raw opts so we
      // never miss either signal.
      const entry = sessions.get(sessionId);
      const srcAgentId = (opts && opts.agentId) || (entry && entry.agentId) || null;
      const srcHost = (opts && opts.host) || (entry && entry.host) || null;
      reconcileAckFlag(sessionId, srcAgentId, srcHost, event);
    } catch (err) {
      // Defensive: must never let a reconciler throw shadow the outer
      // error chain. The reconciler is one Map lookup + a boolean toggle,
      // so this should never fire — log if it does so the regression is
      // visible.
      console.warn("reconcileAckFlag threw:", err);
    }
    emitSessionSnapshot();
  }
}

function isProcessAlive(pid) {
  try { _kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function cleanStaleSessions() {
  const now = Date.now();
  let changed = false;
  let snapshotRefreshNeeded = false;
  const staleConfig = typeof ctx.getStaleConfig === "function" ? ctx.getStaleConfig() : null;
  for (const [id, s] of sessions) {
    const decision = getStaleSessionDecision(s, {
      now,
      isProcessAlive,
      deriveSessionBadge,
      shouldAutoClearDetachedSession,
      staleConfig,
    });

    if (decision.snapshotRefreshNeeded) snapshotRefreshNeeded = true;

    if (decision.action === "delete") {
      const badgeSuffix = decision.reason === "detached-ended" ? ` badge=${decision.badge}` : "";
      debugSession(`stale-delete ${decision.reason} ${describeSession(id, s)}${badgeSuffix}`);
      if (s && s.agentId === "codex") cancelCodexExitProbe(id, `stale-delete-${decision.reason}`);
      if (s && s.agentId === "kimi-cli") disposeKimiSessionState(id, "kimi-session-disposed");
      sessions.delete(id); changed = true;
      continue;
    }

    if (decision.action === "idle") {
      debugSession(`stale-idle ${decision.reason} ${describeSession(id, s)}`);
      s.state = "idle"; s.displayHint = null;
      if (decision.updateTimestamp) s.updatedAt = now;
      changed = true;
    }
  }
  if (changed && sessions.size === 0) {
    setState("idle", SVG_IDLE_FOLLOW);
  } else if (changed) {
    const resolved = resolveDisplayState();
    setState(resolved, getSvgOverride(resolved));
  }
  if (changed || snapshotRefreshNeeded) emitSessionSnapshot();

  if (startupRecoveryActive && sessions.size === 0) {
    detectRunningAgentProcesses((found) => {
      if (!found) {
        startupRecoveryActive = false;
        if (startupRecoveryTimer) { clearTimeout(startupRecoveryTimer); startupRecoveryTimer = null; }
      }
    });
  }
}

// Session removal helpers. Kimi has extra animation/bubble bookkeeping because
// its approval prompt is terminal-driven rather than an HTTP permission roundtrip.
function disposeKimiSessionState(id, reason) {
  const hadSuspect = cancelPermissionSuspect(id);
  const hold = kimiPermissionHolds.get(id);
  if (hold) {
    if (hold.timer) clearTimeout(hold.timer);
    kimiPermissionHolds.delete(id);
  }
  if ((hold || hadSuspect) && typeof ctx.clearKimiNotifyBubbles === "function") {
    ctx.clearKimiNotifyBubbles(id, reason || "kimi-session-disposed");
  }
  return !!(hold || hadSuspect);
}

function dismissSession(sessionId) {
  const id = typeof sessionId === "string" ? sessionId : "";
  if (!id) return false;
  const session = sessions.get(id);
  if (!session) return false;
  if (session.agentId === "codex") cancelCodexExitProbe(id, "session-hidden");
  sessions.delete(id);
  if (session.agentId === "kimi-cli") disposeKimiSessionState(id, "kimi-session-hidden");
  const resolved = resolveDisplayState();
  setState(resolved, getSvgOverride(resolved));
  emitSessionSnapshot({ force: true });
  return true;
}

function takeTrailingPermissionRequest(session) {
  const events = Array.isArray(session && session.recentEvents)
    ? session.recentEvents
    : null;
  if (!events || events.length === 0) return null;
  const last = events[events.length - 1];
  if (!last || last.event !== "PermissionRequest") return null;
  session.recentEvents = events.slice(0, -1);
  return last;
}

function clearPermissionNotification(sessionId, options = {}) {
  const id = typeof sessionId === "string" ? sessionId : "";
  if (!id || options.hasPendingForSession === true) return false;

  let changed = false;
  const session = sessions.get(id);
  if (session) {
    const trailingPermission = takeTrailingPermissionRequest(session);
    if (session.state === "notification") {
      session.state = "idle";
      session.displayHint = null;
      session.resumeState = null;
      changed = true;
    } else if (
      session.state === "idle"
      && trailingPermission
      && isWorkingLikeState(trailingPermission.state)
    ) {
      // A stale sweep may downgrade a Codex session while the approval is
      // still pending. Once the permission resolves, restore the work state
      // recorded at request time so long commands do not stay visually idle.
      session.state = trailingPermission.state;
      changed = true;
    }
    if (trailingPermission) {
      session.updatedAt = Date.now();
      changed = true;
    } else if (changed) {
      session.updatedAt = Date.now();
    }
  }

  // Leave the one-shot notification immediately after the permission channel
  // resolves. If another session still deserves notification, resolveDisplayState
  // will pick it again.
  applyResolvedDisplayState();
  if (changed) emitSessionSnapshot({ force: true });
  return changed;
}

function clearSessionsByAgent(agentId) {
  if (!agentId) return 0;
  let removed = 0;
  for (const [id, s] of sessions) {
    if (s && s.agentId === agentId) {
      if (agentId === "codex") cancelCodexExitProbe(id, "clear-sessions");
      sessions.delete(id);
      if (agentId === "kimi-cli") disposeKimiSessionState(id, "kimi-clear-sessions");
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
        ctx.clearKimiNotifyBubbles(id, "kimi-orphan-hold-cleared");
      }
      removed++;
    }
    const orphanSuspects = [...kimiPermissionSuspectTimers.keys()];
    for (const id of orphanSuspects) {
      cancelPermissionSuspect(id);
      if (typeof ctx.clearKimiNotifyBubbles === "function") {
        ctx.clearKimiNotifyBubbles(id, "kimi-orphan-suspect-cleared");
      }
    }
  }
  if (removed > 0) {
    const resolved = resolveDisplayState();
    setState(resolved, getSvgOverride(resolved));
    emitSessionSnapshot();
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
  // to agent ids without per-name process queries, and the result
  // is only a boolean for startup recovery — not a session creator.
  if (typeof ctx.hasAnyEnabledAgent === "function" && !ctx.hasAnyEnabledAgent()) {
    done(false);
    return;
  }
  const { execFile, exec } = require("child_process");
  if (process.platform === "win32") {
    const psScript =
      "$names = 'claude.exe','codex.exe','copilot.exe','gemini.exe','agy.exe','codebuddy.exe','kiro-cli.exe','kimi.exe','opencode.exe','pi.exe','hermes.exe'; " +
      "$match = Get-CimInstance Win32_Process | Where-Object { " +
        "$names -contains $_.Name -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*claude-code*') " +
      "} | Select-Object -First 1; " +
      "if ($match) { $match.ProcessId }";
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psScript],
      { encoding: "utf8", timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => done(!err && /\d+/.test(stdout))
    );
  } else {
    exec("pgrep -f 'claude-code|codex|copilot|codebuddy|kimi|@earendil-works/pi-coding-agent|pi-coding-agent/dist/cli\\.js' || pgrep -x 'gemini' || pgrep -x 'agy' || pgrep -x 'kiro-cli' || pgrep -x 'opencode' || pgrep -x 'hermes'", { timeout: 3000 },
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
    if (typeof ctx.clearKimiNotifyBubbles === "function") ctx.clearKimiNotifyBubbles(undefined, "kimi-stop-all");
    applyResolvedDisplayState();
    return;
  }
  const cancelled = cancelPermissionSuspect(sessionId);
  const existing = kimiPermissionHolds.get(sessionId);
  if (existing) {
    if (existing.timer) clearTimeout(existing.timer);
    kimiPermissionHolds.delete(sessionId);
    if (typeof ctx.clearKimiNotifyBubbles === "function") ctx.clearKimiNotifyBubbles(sessionId, "kimi-stop-session");
    applyResolvedDisplayState();
  } else if (cancelled) {
    if (typeof ctx.clearKimiNotifyBubbles === "function") ctx.clearKimiNotifyBubbles(sessionId, "kimi-stop-suspect");
    applyResolvedDisplayState();
  }
}

function resolveDisplayState() {
  return resolveDisplayStateFromSessions(sessions, {
    statePriority: STATE_PRIORITY,
    permissionLocked: hasPermissionAnimationLock(),
    updateVisualState,
    updateVisualPriority,
  });
}

function setUpdateVisualState(kind) {
  if (!kind) {
    updateVisualState = null;
    updateVisualKind = null;
    updateVisualSvgOverride = null;
    updateVisualPriority = null;
    return null;
  }
  updateVisualKind = kind;
  updateVisualState = UPDATE_VISUAL_STATE_MAP[kind] || kind;
  updateVisualPriority = UPDATE_VISUAL_PRIORITY_MAP[kind] || getStatePriority(updateVisualState, STATE_PRIORITY);
  refreshUpdateVisualOverride();
  return updateVisualState;
}

function getSvgOverride(state) {
  return getSvgOverrideWithDeps(state, {
    updateVisualState,
    updateVisualSvgOverride,
    idleFollowSvg: SVG_IDLE_FOLLOW,
    sessions,
    displayHintMap: DISPLAY_HINT_MAP,
    theme,
    stateSvgs: STATE_SVGS,
  });
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

// ── Do Not Disturb ──
// Drops every Kimi hold + suspect timer WITHOUT triggering a state resolve.
// Used by two "channel is no longer available" paths:
//   1. enableDoNotDisturb — the DND permission dismiss helper has already
//      dropped matching bubbles without answering for the user, but without
//      this the lock would pin notification the moment DND is disabled.
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
  if (typeof ctx.dismissPermissionsForDnd === "function") {
    ctx.dismissPermissionsForDnd();
  }
  disposeAllKimiPermissionState();
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; pendingState = null; }
  if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
  clearAllCompletionDebounces();
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
  // #329: a deferred update bubble may be waiting on DND exit.
  if (typeof ctx.notifyUpdaterSilentExit === "function") {
    try { ctx.notifyUpdaterSilentExit(); } catch {}
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
  pendingState = null;
  if (autoReturnTimer) clearTimeout(autoReturnTimer);
  clearAllCompletionDebounces();
  if (eyeResendTimer) clearTimeout(eyeResendTimer);
  if (startupRecoveryTimer) clearTimeout(startupRecoveryTimer);
  if (wakePollTimer) clearInterval(wakePollTimer);
  for (const { timer } of kimiPermissionHolds.values()) {
    if (timer) clearTimeout(timer);
  }
  kimiPermissionHolds.clear();
  for (const { timer } of kimiPermissionSuspectTimers.values()) clearTimeout(timer);
  kimiPermissionSuspectTimers.clear();
  for (const id of [...codexExitProbes.keys()]) clearCodexExitProbe(id);
  stopStaleCleanup();
}

return {
  setState, applyState, updateSession, resolveDisplayState, resolveVisualBinding, setUpdateVisualState,
  shouldDropForDnd,
  enableDoNotDisturb, disableDoNotDisturb,
  startStaleCleanup, stopStaleCleanup, startWakePoll, stopWakePoll,
  getSvgOverride, cleanStaleSessions, startStartupRecovery, refreshTheme,
  detectRunningAgentProcesses, buildSessionSnapshot,
  emitSessionSnapshot, broadcastSessionSnapshot, getLastSessionSnapshot,
  getActiveSessionAliasKeys,
  dismissSession,
  clearPermissionNotification,
  ackSessionCompletion,
  clearSessionsByAgent,
  disposeAllKimiPermissionState,
  deriveSessionBadge,
  getCurrentState, getCurrentSvg, getCurrentHitBox, getStartupRecoveryActive,
  sessions, STATE_PRIORITY, ONESHOT_STATES, SLEEP_SEQUENCE,
  get STATE_SVGS() { return STATE_SVGS; },
  get HIT_BOXES() { return HIT_BOXES; },
  get FILE_HIT_BOXES() { return FILE_HIT_BOXES; },
  get WIDE_SVGS() { return WIDE_SVGS; },
  cleanup,
};

};
