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
  isDoneEvent,
  normalizeTitle,
  shouldAutoClearDetachedSession: shouldAutoClearDetachedSessionWithDeps,
  buildSessionSnapshot: buildSessionSnapshotFromSessions,
  getActiveSessionAliasKeys: getActiveSessionAliasKeysFromSessions,
  sessionSnapshotSignature,
} = require("./state-session-snapshot");
const { getAgentIconUrl } = require("./state-agent-icons");
const { resolveSessionIdentity } = require("./session-key");
const { normalizeTranscriptPath } = require("./transcript-path");
const { createAccountQuotaStore } = require("./state-account-quota");
const { normalizeQuotaGroup } = require("../hooks/quota-bucket");
const { ANTIGRAVITY_QUOTA_FIELDS } = require("../hooks/antigravity-context-usage");
const { CLAUDE_QUOTA_FIELDS } = require("../hooks/claude-rate-limits");
const { getClaudeStopDisposition } = require("../hooks/claude-stop-disposition");
const { getStartupRecoveryProcessNames } = require("../agents/registry");
const { hasReusableDefaultIdentity, mapRecapMetrics } = require("./recap-metrics");
const {
  NOOP_RECAP_SINK,
  recordCanonicalRecapEvent,
} = require("./recap-sink");
const {
  readTranscriptTailEntries: readClaudeTranscriptTailEntries,
  extractLastAssistantTextFromEntries: extractLastClaudeAssistantTextFromEntries,
} = require("../hooks/clawd-hook");

module.exports = function initState(ctx) {

const recapSink = ctx.recapSink && typeof ctx.recapSink.record === "function"
  ? ctx.recapSink
  : NOOP_RECAP_SINK;
const pendingClaudeRecapStarts = new Map();
const MAX_PENDING_CLAUDE_RECAP_STARTS = 256;

const _getCursor = ctx.getCursorScreenPoint || (screen ? () => screen.getCursorScreenPoint() : null);
const _kill = ctx.processKill || process.kill.bind(process);

function normalizeGhosttyTerminalId(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/[\r\n\t]+/g, " ").trim();
  if (!text || text.length > 160) return null;
  if (/^(error|unsupported|missing|miss)([-:]|$)/i.test(text)) return null;
  return text;
}

function normalizePositiveInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

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
const {
  clearSubagentTracker,
  cloneSubagentTracker,
  getSubagentVisualCount,
  hasConfirmedSubagents,
  hasSubagentHoldEvidence,
  normalizeChildId,
} = require("./subagent-lifecycle");

// Session display hints — validated against theme.displayHintMap keys
let DISPLAY_HINT_MAP = {};

// ── Session tracking ──
const sessions = new Map();
// Account-wide rate-limit quota, keyed by reporting source — deliberately
// NOT session state (see src/state-account-quota.js). Persistence is
// opt-in via ctx so the many test-constructed state runtimes stay
// filesystem-free; main.js passes the real path.
const accountQuota = createAccountQuotaStore({
  persistPath: ctx.accountQuotaPersistPath || null,
  logWarn: console.warn,
});
// Upgrade cleanup: older builds retained the last local Claude quota even
// after the user opted out. Remove that misleading cache before the first
// snapshot while preserving Remote SSH and every non-Claude provider.
if (ctx.claudeQuotaCollectionEnabled === false) {
  clearLocalClaudeQuota({ broadcast: false });
}
if (ctx.kimiQuotaCollectionEnabled === false) {
  clearLocalKimiQuota({ broadcast: false });
}
const MAX_SESSIONS = 20;
const ASSISTANT_OUTPUT_MAX = 2400;
const CODEX_EXIT_PROBE_DELAYS_MS = [1000, 3000, 8000, 15000];
const COMPLETION_HOUSEKEEPING_EVENTS = new Set([
  "Notification",
  "stale-cleanup",
  "event_msg:token_count",
]);
// #406: forward progress for a session cancels its pending (debounced)
// completion — these events all mean the agent loop is still running.
const COMPLETION_CANCEL_EVENTS = new Set([
  "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
  "PermissionRequest", "CodexUserInputRequest", "Elicitation", "StopFailure", "ApiError", "SessionEnd",
]);
const CLAUDE_ELICITATION_COMPLETION_PROBE_DELAY_MS = 2000;
const CLAUDE_ELICITATION_COMPLETION_PROBE_INTERVAL_MS = 3000;
const CLAUDE_ELICITATION_COMPLETION_PROBE_MAX_MS = 5 * 60 * 1000;
const CLAUDE_ELICITATION_COMPLETION_TOOLS = new Set(["AskUserQuestion"]);
let lastSessionSnapshotSignature = null;
let lastSessionSnapshot = null;
let startupRecoveryActive = false;
let startupRecoveryTimer = null;
const STARTUP_RECOVERY_MAX_MS = 300000;
const codexExitProbes = new Map();
const claudeTranscriptCompletionProbes = new Map();

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

function normalizeToolName(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 160 || /[\0\r\n]/.test(text)) return null;
  return text;
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
// #406 Stop completion debounce: sessionId -> record holding one exact Stop
// as "working" until a quiet window confirms the turn really ended.
const pendingCompletionDebounces = new Map();
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
const WAKE_POLL_START_DELAY_MS = 500;
// Cursor-sample cadence while dozing/collapsing/sleeping. (A low-power idle-mode
// slowdown was tried here and removed: real-machine powermetrics showed no wakeup
// or CPU win — macOS timer coalescing absorbs a 200ms timer — for added latency.)
const WAKE_POLL_MS = 200;
let wakePollStartTimer = null;
let wakePollStartState = null;
let wakePollTimer = null;
let lastWakeCursorX = null, lastWakeCursorY = null;

function isWakePollState(state) {
  return state === "dozing" || state === "collapsing" || state === "sleeping";
}

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

// ── Kimi CLI permission gate ledger ──
// Legacy kimi-cli fires the PreToolUse for EVERY queued tool call up front
// (two calls in one assistant message arrive ~0.1s apart), then blocks on the
// approval TUI one tool at a time. The hold/suspect slots above are
// per-session booleans, so without extra bookkeeping only the FIRST approval
// ever gets a cue — the second prompt sits invisible in the terminal.
// The ledger tracks outstanding permission-gated tool calls per session:
//   sessionId -> Array<{ id: string|null, detail: object|null }>
// insertion-ordered (index 0 = oldest = what the terminal blocks on next).
// Opened by gated PreToolUse / synthesized PermissionRequest (hook marks them
// permission_gate_open), closed by gated PostToolUse/PostToolUseFailure —
// exact match when a tool_call_id is present, FIFO across anonymous entries
// otherwise. Native Kimi Code PermissionRequests carry no gate markers and
// never touch the ledger.
const kimiPermissionGateLedgers = new Map();

function buildKimiGateDetail(toolName, permissionAction, permissionCommand, permissionToolInput) {
  if (!toolName && !permissionAction && !permissionCommand && !permissionToolInput) return null;
  return { toolName, permissionAction, permissionCommand, permissionToolInput };
}

function openKimiPermissionGate(sessionId, gateId, detail) {
  if (!sessionId) return;
  let gates = kimiPermissionGateLedgers.get(sessionId);
  if (!gates) {
    gates = [];
    kimiPermissionGateLedgers.set(sessionId, gates);
  }
  const id = typeof gateId === "string" && gateId ? gateId : null;
  if (id) {
    // Idempotent refresh: a re-sent PreToolUse for the same call replaces its
    // own entry instead of inflating the queue.
    const dup = gates.findIndex((gate) => gate.id === id);
    if (dup !== -1) gates.splice(dup, 1);
  }
  gates.push({ id, detail: detail || null });
}

function closeKimiPermissionGate(sessionId, gateId) {
  const gates = kimiPermissionGateLedgers.get(sessionId);
  if (!gates || !gates.length) return false;
  const id = typeof gateId === "string" && gateId ? gateId : null;
  let idx = -1;
  if (id) {
    // Exact pairing only. An unknown id is a no-op on purpose: a duplicate or
    // out-of-order Post must not eat an anonymous entry it doesn't own.
    idx = gates.findIndex((gate) => gate.id === id);
  } else {
    // Anonymous close (old hook / payload without tool_call_id): FIFO —
    // settle the oldest anonymous gate.
    idx = gates.findIndex((gate) => gate.id === null);
  }
  if (idx === -1) return false;
  gates.splice(idx, 1);
  if (!gates.length) kimiPermissionGateLedgers.delete(sessionId);
  return true;
}

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

function hasConfirmedPermissionAnimationLock() {
  // Native PermissionRequest is authoritative and may pin other one-shot
  // visuals. The legacy timing heuristic is only a passive cue: a slow but
  // pre-authorized Kimi tool must not swallow another agent's Stop/error.
  return [...kimiPermissionHolds.values()].some((hold) => hold && hold.source === "confirmed");
}

// Later events legitimately omit the pane key, so it has to be sticky — but a
// session start means the agent just (re)attached to a terminal, and then the key
// must come from that event's own environment or not at all. `--resume` of the
// same session id from a different terminal would otherwise keep the old Orca
// key and, because the pane key outranks the Windows window cache and the hook's
// wt_hwnd, raise Orca instead of the terminal the agent actually moved to.
//
// Producers spell the session start three ways: most post "SessionStart",
// copilot-hook.js posts its raw argv name "sessionStart", and kiro-hook.js posts
// "agentSpawn". Kiro is the one that matters most — its stdin carries no session
// id, so it merges every session into "default" and a pane key stored there would
// otherwise never be cleared.
//
// antigravity-hook.js has no session-start event at all, so the event name alone
// can never clear one of its keys. Its id normalizes payload.conversationId
// (falling back to the transcript directory), so resuming the same conversation
// from a different terminal lands back on the same entry — which is why the
// identity check below exists rather than a longer list of event names.
const SESSION_START_EVENTS = new Set(["SessionStart", "sessionStart", "agentSpawn"]);

// A pane key names one specific Orca pane, and focus consults it before the
// sourcePid/wtHwnd that would otherwise be authoritative. So an event reporting a
// terminal identity that differs from the stored one means the session moved, and
// keeping the key would send the user to the old pane instead of the terminal that
// just reported in. Only values present on BOTH sides count: most events carry no
// process metadata, and reading "absent" as "moved" would blank the key immediately.
// Producers disagree on the wire type of the pid, so compare as strings.
function terminalIdentityChanged(existing, incoming) {
  if (!existing || !incoming) return false;
  const differs = (next, stored) => !!next && !!stored && String(next) !== String(stored);
  return differs(incoming.sourcePid, existing.sourcePid) || differs(incoming.wtHwnd, existing.wtHwnd);
}

function mergeOrcaPaneKey(orcaPaneKey, existing, event, incoming) {
  if (orcaPaneKey) return orcaPaneKey;
  if (SESSION_START_EVENTS.has(event)) return null;
  if (terminalIdentityChanged(existing, incoming)) return null;
  return (existing && existing.orcaPaneKey) || null;
}

function resolveAwaitingInputSinceStop(existing, event) {
  if (isDoneEvent(event)) return true;
  if (!event || COMPLETION_HOUSEKEEPING_EVENTS.has(event)) return !!(existing && existing.awaitingInputSinceStop === true);
  return false;
}

function getCompletionTailWithoutProgress(session) {
  const events = Array.isArray(session && session.recentEvents) ? session.recentEvents : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const entry = events[i];
    const event = entry && entry.event;
    if (isDoneEvent(event)) return entry;
    if (event == null || COMPLETION_HOUSEKEEPING_EVENTS.has(event)) continue;
    return null;
  }
  return null;
}

function hasCompletionTailWithoutProgress(session) {
  return !!getCompletionTailWithoutProgress(session);
}

function markCompletionTailPresented(recentEvents) {
  const copy = recentEvents.slice();
  for (let i = copy.length - 1; i >= 0; i--) {
    const entry = copy[i];
    const event = entry && entry.event;
    if (isDoneEvent(event)) {
      copy[i] = { ...entry, state: "attention" };
      break;
    }
    if (event == null || COMPLETION_HOUSEKEEPING_EVENTS.has(event)) continue;
    break;
  }
  return copy;
}

function shouldSuppressDuplicateCompletionVisual(existing, state, event) {
  if (state !== "attention" || !isDoneEvent(event)) return false;
  if (!existing || (existing.state !== "idle" && existing.state !== "sleeping")) return false;
  const completionTail = getCompletionTailWithoutProgress(existing);
  if (completionTail) return completionTail.state === "attention";
  return existing.awaitingInputSinceStop === true;
}

function shouldKeepExistingCompletionEventTail(existing, state, event) {
  return state === "attention"
    && existing
    && (existing.state === "idle" || existing.state === "sleeping")
    && isDoneEvent(event)
    && hasCompletionTailWithoutProgress(existing);
}

function shouldMuteMiniPostCompletionNotification(state, event, session) {
  return !!ctx.miniMode
    && state === "notification"
    && event === "Notification"
    && session
    && session.awaitingInputSinceStop === true
    && !hasPermissionAnimationLock();
}

function shouldDropAntigravityPostStopToolUse(existing, state, event, agentId) {
  return agentId === "antigravity-cli"
    && event === "PostToolUse"
    && state === "working"
    && existing
    && existing.awaitingInputSinceStop === true
    && Number.isFinite(existing.lastStopAt);
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
  // Sync back so settings-animation-overrides can resolve roam/fallback states
  theme._stateBindings = STATE_BINDINGS;
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

function scheduleAutoReturn(state) {
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

function clearPendingStateTimer() {
  if (!pendingTimer) return;
  clearTimeout(pendingTimer);
  pendingTimer = null;
  pendingState = null;
}

function setState(newState, svgOverride, options = {}) {
  if (shouldDropForDnd()) return;

  if (newState === "yawning" && SLEEP_SEQUENCE.has(currentState)) return;

  const sameState = newState === currentState;
  const sameSvg = !svgOverride || svgOverride === currentSvg;
  if (sameState && sameSvg) {
    // Kimi CLI permission hold: re-arm the auto-return timer so the
    // notification animation keeps cycling while the user is reviewing
    // the permission prompt.
    if (hasPermissionAnimationLock() && newState === "notification" && AUTO_RETURN_MS[newState]) {
      clearPendingStateTimer();
      if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
      scheduleAutoReturn(newState);
    } else if (AUTO_RETURN_MS[newState] && !autoReturnTimer && !pendingTimer) {
      scheduleAutoReturn(newState);
    }
    return;
  }

  if (pendingTimer) {
    if (pendingState && getStatePriority(newState, STATE_PRIORITY) < getStatePriority(pendingState, STATE_PRIORITY)) {
      return;
    }
    clearPendingStateTimer();
  }

  // Internal movement states such as free roam must be interruptible by direct
  // user interaction. Callers may bypass only the current state's display
  // hold; DND and pending-state priority checks above still apply unchanged.
  const minTime = options.bypassMinDisplay === true
    ? 0
    : (MIN_DISPLAY_MS[currentState] || 0);
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

  // #509: no-override idle entries (e.g. roam ending) also rest on the
  // user-selected idle visual instead of a random states.idle pick.
  const userIdle = (state === "idle" && !svgOverride && typeof ctx.getIdleVisualChoice === "function")
    ? ctx.getIdleVisualChoice()
    : null;
  const svg = svgOverride || userIdle || resolveVisualBinding(state);
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
  ctx.sendToHitWin("hit-state-sync", { currentState: state });
  ctx.sendToHitWin("hit-cancel-reaction");

  if (state !== "idle" && state !== "mini-idle") {
    ctx.sendToRenderer("eye-move", 0, 0);
  }

  if (isWakePollState(state) && !ctx.doNotDisturb) {
    scheduleWakePollStart(state);
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
    scheduleAutoReturn(state);
  }
}

// ── Wake poll ──
function clearWakePollStartTimer() {
  if (!wakePollStartTimer) return;
  clearTimeout(wakePollStartTimer);
  wakePollStartTimer = null;
  wakePollStartState = null;
}

function scheduleWakePollStart(state) {
  if (wakePollTimer) return;
  if (wakePollStartTimer && wakePollStartState === state) return;
  clearWakePollStartTimer();
  wakePollStartState = state;
  wakePollStartTimer = setTimeout(() => {
    wakePollStartTimer = null;
    wakePollStartState = null;
    if (currentState === state) startWakePoll();
  }, WAKE_POLL_START_DELAY_MS);
}

function startWakePoll() {
  if (!_getCursor || wakePollTimer) return;
  if (!isWakePollState(currentState) || ctx.doNotDisturb) return;
  const cursor = _getCursor();
  lastWakeCursorX = cursor.x;
  lastWakeCursorY = cursor.y;
  scheduleWakePollTick();
}

function scheduleWakePollTick(delay = WAKE_POLL_MS) {
  if (!_getCursor || wakePollTimer) return;
  clearWakePollStartTimer();
  wakePollTimer = setTimeout(runWakePollTick, delay);
}

function runWakePollTick() {
  wakePollTimer = null;
  if (!_getCursor || !isWakePollState(currentState) || ctx.doNotDisturb) return;
  const cursor = _getCursor();
  const moved = cursor.x !== lastWakeCursorX || cursor.y !== lastWakeCursorY;

  if (moved) {
    stopWakePoll();
    wakeFromDoze();
    return;
  }

  if (currentState === "dozing" && Date.now() - ctx.mouseStillSince >= DEEP_SLEEP_TIMEOUT) {
    applyState("collapsing");
    scheduleWakePollTick();
    return;
  }

  scheduleWakePollTick();
}

function stopWakePoll() {
  clearWakePollStartTimer();
  if (wakePollTimer) { clearTimeout(wakePollTimer); wakePollTimer = null; }
}

function wakeFromDoze() {
  if (currentState === "sleeping" || currentState === "collapsing") {
    playWakeTransitionOrResolve();
    return;
  }
  ctx.sendToRenderer("wake-from-doze");
  setTimeout(() => {
    if (currentState === "dozing") {
      applyState("idle", getSvgOverride("idle"));
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
    resolveAgentDisplayName: ctx.resolveAgentDisplayName,
    statePriority: STATE_PRIORITY,
    sessionHudCleanupDetached: ctx.sessionHudCleanupDetached === true,
    focusHostPlatform: ctx.focusHostPlatform || process.platform,
    isProcessAlive,
    accountQuota: accountQuota.snapshot({ mergeSources: ctx.quotaMergeSources === true }),
    sessionAutomationRecords: typeof ctx.getSessionAutomationRecords === "function"
      ? ctx.getSessionAutomationRecords()
      : [],
    permissionAutomationMode: typeof ctx.getPermissionAutomationMode === "function"
      ? ctx.getPermissionAutomationMode()
      : "off",
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

function resolveRecapScope(input) {
  if (input && input.profileId && input.profileId !== "local") return "remote";
  if (input && input.wslDistro) return "wsl";
  return "local";
}

function resolveRecapScopeId(input) {
  const scope = resolveRecapScope(input);
  if (scope === "remote") return input.profileId;
  if (scope === "wsl") return input.wslDistro || "wsl";
  return "local";
}

function findSnapshotSession(snapshot, sessionId) {
  const entries = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  return entries.find((entry) => entry && entry.id === sessionId) || null;
}

function claudeRecapStartKey(input) {
  if (!input || input.agentId !== "claude-code" || hasReusableDefaultIdentity(input.rawSessionId)) return null;
  return `${resolveRecapScope(input)}\0${resolveRecapScopeId(input)}\0${input.rawSessionId}`;
}

function prunePendingClaudeRecapStarts() {
  while (pendingClaudeRecapStarts.size > MAX_PENDING_CLAUDE_RECAP_STARTS) {
    pendingClaudeRecapStarts.delete(pendingClaudeRecapStarts.keys().next().value);
  }
}

function persistRecapMetrics(input, metrics) {
  let dedupeId = null;
  if (metrics.includes("session-start")) {
    dedupeId = `session-start:${input.rawSessionId}`;
  } else if (metrics.includes("tool-call") && input.toolUseId) {
    dedupeId = `tool-call:${input.toolUseId}`;
  } else if (metrics.includes("turn-complete")) {
    dedupeId = input.recapDedupeId ? `turn-complete:${input.recapDedupeId}` : null;
  }
  return recordCanonicalRecapEvent(recapSink, {
    occurredAt: input.occurredAt,
    agentId: input.agentId,
    scope: resolveRecapScope(input),
    metrics,
  }, {
    scopeId: resolveRecapScopeId(input),
    sessionId: input.rawSessionId || input.sessionId,
    dedupeId,
    sessionStartPartial: hasReusableDefaultIdentity(input.rawSessionId),
  });
}

function recordAcceptedRecapEvent(input, snapshot) {
  if (!input || !input.agentId || !input.event) return false;
  if (input.recapSuppressed === true) return false;
  if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled(input.agentId)) return false;
  // Remote Codex ordinary lifecycle does not yet have the local monitor's
  // replay fence + authoritative line timestamp. Keep it out until that
  // contract exists instead of stamping receipt time onto historical work.
  if (
    input.agentId === "codex"
    && input.profileId
    && input.profileId !== "local"
    && input.hookSource !== "codex-official"
  ) return false;

  prunePendingClaudeRecapStarts();
  const pendingKey = claudeRecapStartKey(input);
  const isFreshClaudeStart = !!(
    pendingKey
    && input.event === "SessionStart"
    && (input.sessionStartSource === "startup" || input.sessionStartSource === "clear")
    && input.recapIsSubagent !== true
    && !input.subagentId
    && !input.subagentType
  );
  if (isFreshClaudeStart) {
    if (!pendingClaudeRecapStarts.has(pendingKey)) {
      pendingClaudeRecapStarts.set(pendingKey, { input: { ...input } });
    }
    prunePendingClaudeRecapStarts();
    return false;
  }
  const pendingStart = pendingKey && pendingClaudeRecapStarts.get(pendingKey);
  if (pendingStart && input.event === "SessionEnd") pendingClaudeRecapStarts.delete(pendingKey);
  const confirmsPendingStart = !!(
    pendingStart
    && input.event !== "SessionStart"
    && input.event !== "SessionEnd"
  );

  let completionAccepted = false;
  if (input.completionCandidate === true) {
    const entry = findSnapshotSession(snapshot, input.sessionId);
    const lastEvent = entry && entry.lastEvent;
    completionAccepted = !!(
      entry
      && entry.badge === "done"
      && lastEvent
      && lastEvent.rawEvent === input.event
      && Number.isSafeInteger(input.snapshotEventAt)
      && lastEvent.at === input.snapshotEventAt
    );
  }
  const metrics = mapRecapMetrics({ ...input, completionAccepted });
  if (!metrics) return false;

  try {
    if (confirmsPendingStart) {
      pendingClaudeRecapStarts.delete(pendingKey);
      persistRecapMetrics(pendingStart.input, ["activity", "session-start"]);
    }
    return persistRecapMetrics(input, metrics);
  } catch (err) {
    console.warn("recap event rejected:", err && err.message ? err.message : "invalid event");
    return false;
  }
}

function recordRecapEventOnly(input) {
  // This narrow path is for a boundary that already passed source/replay
  // arbitration but arrived too late to re-drive session state (currently a
  // Codex WebSearch discovered after its official Stop). Never invent receipt
  // time here: callers must carry the trusted source timestamp.
  if (!input || !Number.isSafeInteger(input.occurredAt) || input.occurredAt < 0) return false;
  return recordAcceptedRecapEvent(input, getLastSessionSnapshot());
}

function getLastSessionSnapshot() {
  if (!lastSessionSnapshot) lastSessionSnapshot = buildSessionSnapshot();
  return lastSessionSnapshot;
}

function describeSession(sessionId, session) {
  if (!session) return `sid=${sessionId} <deleted>`;
  const tracker = cloneSubagentTracker(session);
  return [
    `sid=${sessionId}`,
    `state=${session.state || "-"}`,
    `resume=${session.resumeState || "-"}`,
    `confirmed=${tracker.confirmedIds.size}`,
    `legacy=${tracker.legacyFloor ? 1 : 0}`,
    `recovered=${tracker.recoveredFloor ? 1 : 0}`,
    `live=${getSubagentVisualCount(tracker)}`,
    `agent=${session.agentId || "-"}`,
    `agentPid=${session.agentPid || "-"}`,
    `sourcePid=${session.sourcePid || "-"}`,
    `pidReachable=${session.pidReachable ? 1 : 0}`,
    `headless=${session.headless ? 1 : 0}`,
  ].join(" ");
}

// #583: renders hook-reported stdin diagnostics (present only when the hook's
// stdin payload had no session_id) for the event log line. bytes:0 + timeout:1
// means stdin never reached the hook; bytes>0 + stdinErr means it arrived
// mangled — entirely different culprits, distinguishable from one log line.
// parseError arrives via /state which any local process can forge: strip
// quotes, backslashes, and control chars (incl. ANSI escapes) so a crafted
// value cannot close the quoted field early or corrupt the log line.
function formatStdinDiag(diag) {
  if (!diag || typeof diag !== "object") return "";
  const bytes = Number.isFinite(diag.bytes) ? diag.bytes : "-";
  const durationMs = Number.isFinite(diag.durationMs) ? diag.durationMs : "-";
  const err = typeof diag.parseError === "string" && diag.parseError
    ? ` stdinErr="${diag.parseError
        .replace(/["\\\u0000-\u001F\u007F-\u009F]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80)}"`
    : "";
  return ` stdin=bytes:${bytes},timeout:${diag.timedOut === true ? 1 : 0},ms:${durationMs}${err}`;
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

  if (oldestId) deleteSessionWithCompletionCleanup(oldestId, "max-sessions-evict");
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
    && COMPLETION_HOUSEKEEPING_EVENTS.has(event);
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

function normalizeContextUsage(value) {
  if (!value || typeof value !== "object") return null;
  const used = Number(value.used);
  if (!Number.isFinite(used) || used < 0) return null;
  const out = { used };
  const limit = Number(value.limit);
  if (Number.isFinite(limit) && limit > 0) out.limit = limit;
  const percent = Number(value.percent);
  if (Number.isFinite(percent)) out.percent = Math.max(0, Math.min(100, Math.round(percent)));
  if (value.source === "claude" || value.source === "codex" || value.source === "antigravity" || value.source === "opencode") out.source = value.source;
  return out;
}

function normalizeContextUsageOrigin(value) {
  return value === "claude-statusline" || value === "claude-transcript" || value === "opencode-statusline" ? value : null;
}

function isStatuslineOrigin(origin) {
  return origin === "claude-statusline" || origin === "opencode-statusline";
}

function resolveContextUsageUpdate(existing, incomingValue, incomingOriginValue) {
  const existingUsage = normalizeContextUsage(existing && existing.contextUsage);
  const existingOrigin = normalizeContextUsageOrigin(existing && existing.contextUsageOrigin);
  const incomingUsage = normalizeContextUsage(incomingValue);
  const incomingOrigin = normalizeContextUsageOrigin(incomingOriginValue);
  if (!incomingUsage) {
    return { contextUsage: existingUsage, contextUsageOrigin: existingOrigin };
  }
  if (isStatuslineOrigin(incomingOrigin)) {
    return { contextUsage: incomingUsage, contextUsageOrigin: incomingOrigin };
  }
  if (
    incomingOrigin === "claude-transcript"
    && existingOrigin === "claude-statusline"
    && existingUsage
    && Number.isFinite(existingUsage.limit)
    && existingUsage.limit > 0
  ) {
    const used = incomingUsage.used;
    return {
      contextUsage: {
        used,
        limit: existingUsage.limit,
        percent: Math.max(0, Math.min(100, Math.round((used / existingUsage.limit) * 100))),
        source: "claude",
      },
      contextUsageOrigin: "claude-statusline",
    };
  }
  return {
    contextUsage: incomingUsage,
    contextUsageOrigin: incomingOrigin,
  };
}

function updateSessionFocusMetadata(sessionId, opts = {}) {
  const id = typeof sessionId === "string" ? sessionId : "";
  if (!id) return false;
  const session = sessions.get(id);
  if (!session) return false;
  const expectedSourcePid = normalizePositiveInteger(opts.sourcePid);
  if (expectedSourcePid && normalizePositiveInteger(session.sourcePid) !== expectedSourcePid) return false;
  const ghosttyTerminalId = normalizeGhosttyTerminalId(opts.ghosttyTerminalId);
  if (!ghosttyTerminalId) return false;
  session.ghosttyTerminalId = ghosttyTerminalId;
  return true;
}

// Refresh lifecycle liveness from a request-bound observer without inventing a
// hook event. This deliberately sits between updateSessionFocusMetadata (which
// owns focus-only fields) and updateSessionMetadata (which must never affect
// staleness): a correlated request_user_input request/output is real turn
// activity, but it must not create a ghost row, append recentEvents, fire a
// sound, or manufacture a completion boundary.
function touchSessionActivity(sessionId, opts = {}) {
  const id = typeof sessionId === "string" ? sessionId : "";
  if (!id) return false;
  const session = sessions.get(id);
  if (!session) return false;
  const expectedAgentId = typeof opts.agentId === "string" ? opts.agentId : null;
  if (expectedAgentId && session.agentId !== expectedAgentId) return false;
  const expectedProfileId = typeof opts.profileId === "string" ? opts.profileId : null;
  if (expectedProfileId && (session.profileId || "local") !== expectedProfileId) return false;
  if (opts.localOnly === true && (session.host || session.headless)) return false;
  // A completion awaiting acknowledgement is a stronger lifecycle boundary
  // than a late transcript record; never revive or extend it.
  if (session.requiresCompletionAck === true) return false;

  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const reviveIdle = opts.reviveIdle === true && session.state === "idle";
  session.updatedAt = now;
  if (reviveIdle) {
    session.state = "working";
    session.displayHint = null;
    session.subagentTracker = clearSubagentTracker(cloneSubagentTracker(session));
    const resolved = resolveDisplayState();
    setState(resolved, getSvgOverride(resolved));
  }
  emitSessionSnapshot();
  return true;
}

// Statusline refresh POSTs (metadata_only: true) annotate a session that real
// hook traffic already created — they are telemetry, not lifecycle. Hence:
// never create a session (a statusline for a dead/unknown session id would
// resurrect it as a ghost card), never touch recentEvents (no hook event
// happened, and the badge derivation reads that tail), and never bump
// updatedAt (a statusline refreshing every ~300ms would keep any session
// eternally "fresh", defeating staleness sweeps and resurrecting completed
// cards as idle). Context usage is the only per-session field a statusline
// owns — account quota is not a session property and lives in the
// session-independent store (updateAccountQuota below).
// Broadcast goes through emitSessionSnapshot, whose signature dedup already
// swallows no-op refreshes.
function updateSessionMetadata(sessionId, opts = {}) {
  const id = typeof sessionId === "string" ? sessionId : "";
  if (!id) return false;
  const session = sessions.get(id);
  if (!session) {
    debugSession(`metadata-only drop sid=${id} reason=no-session`);
    return false;
  }
  const incomingContextUsage = normalizeContextUsage(opts.contextUsage);
  const incomingTitle = typeof opts.sessionTitle === "string"
    ? normalizeTitle(opts.sessionTitle)
    : null;
  if (!incomingContextUsage && !incomingTitle) return false;
  let applied = false;
  if (incomingContextUsage) {
    const resolved = resolveContextUsageUpdate(
      session,
      incomingContextUsage,
      opts.contextUsageOrigin
    );
    const usageChanged = JSON.stringify(resolved.contextUsage) !== JSON.stringify(session.contextUsage);
    const originChanged = resolved.contextUsageOrigin !== normalizeContextUsageOrigin(session.contextUsageOrigin);
    if (usageChanged || originChanged) {
      session.contextUsage = resolved.contextUsage;
      session.contextUsageOrigin = resolved.contextUsageOrigin;
      // Freshness stamp for telemetry arbitration. Deliberately a separate
      // field from updatedAt: staleness sweeps, badge derivation and eviction
      // all key on updatedAt, and a statusline heartbeat must not feed them.
      // Stamped only on real changes, so it cannot re-introduce a per-tick
      // broadcast (and it is excluded from the snapshot signature anyway).
      session.metadataUpdatedAt = Date.now();
      applied = true;
    }
  }
  // OpenCode swaps its placeholder title for a real one after session
  // creation; that arrives on session.updated which maps to no state change,
  // so the plugin forwards the title change as a metadata-only POST. Update
  // the stored title here without touching the lifecycle state. Deliberately
  // NOT stamping metadataUpdatedAt: that field is context/quota telemetry
  // freshness, and a rename must not make stale telemetry look fresh. The
  // title broadcasts anyway - sessionTitle/displayTitle are in the snapshot
  // signature, so emitSessionSnapshot below fans it out.
  if (incomingTitle && incomingTitle !== session.sessionTitle) {
    session.sessionTitle = incomingTitle;
    applied = true;
  }
  if (applied) emitSessionSnapshot();
  return true;
}

function clearClaudeStatuslineAuthority(profileId = "local") {
  let cleared = 0;
  for (const session of sessions.values()) {
    if (!session || session.agentId !== "claude-code") continue;
    if ((session.profileId || "local") !== profileId) continue;
    if (session.contextUsageOrigin !== "claude-statusline") continue;
    session.contextUsageOrigin = null;
    cleared++;
  }
  return cleared;
}

// Account-wide rate-limit quota reported by one source (host prefix for
// remotes, null for this machine). Session-independent by design: the
// numbers must survive session eviction and app restarts so "check the
// remote's quota before starting work" has something honest to show — see
// src/state-account-quota.js for the expiry/staleness contract.
function updateAccountQuota(host, quotas = {}) {
  const changed = accountQuota.update(host, quotas);
  if (changed) emitSessionSnapshot();
  return changed;
}

function clearLocalClaudeQuota(options = {}) {
  const cleared = accountQuota.clearProvider(
    "claudeQuota",
    (sourceKey) => !sourceKey.startsWith("remote:")
  );
  if (!cleared) return 0;
  // An explicit opt-out is a data-lifecycle boundary, not a routine refresh:
  // persist it synchronously so a crash/restart cannot resurrect stale quota.
  accountQuota.flush();
  if (options.broadcast !== false) emitSessionSnapshot();
  return cleared;
}

// Kimi quota is collected only by the local, explicit API-key runtime. Its
// durable commit seam reports persistence separately so the credentialId
// binding journal can never claim a quota snapshot reached disk when it did
// not. Existing generic/Claude callers keep their historical boolean/numeric
// contracts above.
function commitLocalKimiQuota(kimiQuota) {
  const result = accountQuota.updateDetailed(null, { kimiQuota });
  if (!result.accepted) return { accepted: false, persisted: false };
  const persisted = accountQuota.flush();
  if (result.changed) emitSessionSnapshot();
  return { accepted: true, persisted: persisted === true };
}

function clearLocalKimiQuota(options = {}) {
  const cleared = accountQuota.clearProvider("kimiQuota", (sourceKey) => sourceKey === "");
  const persisted = cleared ? accountQuota.flush() === true : true;
  if (cleared && options.broadcast !== false) emitSessionSnapshot();
  return { cleared: cleared > 0, persisted };
}

// Distinct reporting sources that currently carry quota (this machine + WSL /
// SSH remotes), UNmerged. The settings UI hides the "merge across machines"
// switch when there is only one source, since merging is then a no-op.
function getQuotaSourceCount() {
  return accountQuota.snapshot({ mergeSources: false }).length;
}

// ── #406 Stop completion gate ──
// A Claude "Stop" maps to "attention" (celebrate + complete sound), but a Stop
// is not always a real turn completion. Decidable-now signals (live crons,
// background tasks with no final assistant text, or a stop_hook_active
// continuation) are held as "working" by updateSession directly. Plain Stops
// and bg-only Stops with final assistant text can be debounced: hold "working"
// and only celebrate if no forward-progress event for the session arrives
// within the window.
function scheduleCompletionDebounce(sessionId, debounceMs, payload = {}) {
  const existing = pendingCompletionDebounces.get(sessionId);
  if (existing && existing.timer) clearTimeout(existing.timer);
  const text = normalizeAssistantOutput(payload && payload.text);
  const record = {
    timer: null,
    occurredAt: Number.isSafeInteger(payload.occurredAt) && payload.occurredAt >= 0
      ? payload.occurredAt
      : Date.now(),
    assistantLastOutput: text,
    assistantLastOutputTruncated: !!(text && payload && payload.truncated === true),
  };
  record.timer = setTimeout(() => {
    if (pendingCompletionDebounces.get(sessionId) !== record) return;
    pendingCompletionDebounces.delete(sessionId);
    promoteCompletion(sessionId, {
      occurredAt: record.occurredAt,
      text: record.assistantLastOutput,
      truncated: record.assistantLastOutputTruncated,
    });
  }, debounceMs);
  pendingCompletionDebounces.set(sessionId, record);
}

function cancelCompletionDebounce(sessionId, reason) {
  const record = pendingCompletionDebounces.get(sessionId);
  if (!record) return;
  if (record.timer) clearTimeout(record.timer);
  pendingCompletionDebounces.delete(sessionId);
  debugSession(`stop-debounce cancel sid=${sessionId} by=${reason || "-"}`);
}

function clearAllCompletionDebounces() {
  for (const record of pendingCompletionDebounces.values()) {
    if (record && record.timer) clearTimeout(record.timer);
  }
  pendingCompletionDebounces.clear();
}

function cancelClaudeTranscriptCompletionProbe(sessionId, reason) {
  const existing = claudeTranscriptCompletionProbes.get(sessionId);
  if (!existing) return;
  clearTimeout(existing.timer);
  claudeTranscriptCompletionProbes.delete(sessionId);
  debugSession(`claude-transcript-stop-probe cancel sid=${sessionId} by=${reason || "-"}`);
}

function clearAllClaudeTranscriptCompletionProbes() {
  for (const { timer } of claudeTranscriptCompletionProbes.values()) clearTimeout(timer);
  claudeTranscriptCompletionProbes.clear();
}

function deleteSessionWithCompletionCleanup(sessionId, reason) {
  cancelCompletionDebounce(sessionId, reason);
  cancelClaudeTranscriptCompletionProbe(sessionId, reason);
  return sessions.delete(sessionId);
}

function isClaudeElicitationCompletionTool(toolName) {
  return CLAUDE_ELICITATION_COMPLETION_TOOLS.has(toolName);
}

function hasClaudeBackgroundSubagentCompletionHold(sessionOrTracker) {
  // Only the authoritative typed-count marker may block completion producers.
  // Tracker-only evidence keeps the pre-#952 recovery behavior: if an older or
  // malformed hook misses SubagentStop and never sends a typed zero, a later
  // parent completion must still be able to settle the session.
  return !!(
    sessionOrTracker
    && Number.isFinite(sessionOrTracker.claudeBackgroundSubagentHoldAt)
    && sessionOrTracker.claudeBackgroundSubagentHoldAt > 0
  );
}

function scheduleClaudeTranscriptCompletionProbe(sessionId, transcriptPath) {
  const safePath = normalizeTranscriptPath(transcriptPath);
  if (!safePath) return;

  cancelClaudeTranscriptCompletionProbe(sessionId, "reschedule");

  const startedAt = Date.now();
  const probe = { timer: null, transcriptPath: safePath, startedAt };

  const runProbe = () => {
    const session = sessions.get(sessionId);
    if (!session || session.agentId !== "claude-code" || session.state !== "working") {
      claudeTranscriptCompletionProbes.delete(sessionId);
      return;
    }
    if (Date.now() - startedAt > CLAUDE_ELICITATION_COMPLETION_PROBE_MAX_MS) {
      claudeTranscriptCompletionProbes.delete(sessionId);
      debugSession(`claude-transcript-stop-probe expire sid=${sessionId}`);
      return;
    }
    if (hasClaudeBackgroundSubagentCompletionHold(session)) {
      probe.timer = setTimeout(runProbe, CLAUDE_ELICITATION_COMPLETION_PROBE_INTERVAL_MS);
      claudeTranscriptCompletionProbes.set(sessionId, probe);
      return;
    }

    const assistantOutput = extractLastClaudeAssistantTextFromEntries(
      readClaudeTranscriptTailEntries(safePath),
      sessionId
    );
    if (assistantOutput && assistantOutput.text) {
      claudeTranscriptCompletionProbes.delete(sessionId);
      session.assistantLastOutput = normalizeAssistantOutput(assistantOutput.text);
      session.assistantLastOutputTruncated = assistantOutput.truncated === true;
      debugSession(`claude-transcript-stop-probe promote sid=${sessionId}`);
      promoteCompletion(sessionId, {
        occurredAt: Date.now(),
        text: session.assistantLastOutput,
        truncated: session.assistantLastOutputTruncated,
      });
      return;
    }

    probe.timer = setTimeout(runProbe, CLAUDE_ELICITATION_COMPLETION_PROBE_INTERVAL_MS);
    claudeTranscriptCompletionProbes.set(sessionId, probe);
  };

  probe.timer = setTimeout(runProbe, CLAUDE_ELICITATION_COMPLETION_PROBE_DELAY_MS);
  claudeTranscriptCompletionProbes.set(sessionId, probe);
  debugSession(`claude-transcript-stop-probe schedule sid=${sessionId}`);
}

// Debounce window elapsed with no forward progress → the turn really ended.
// Replay the real Stop the gate withheld: append a Stop event (so the badge →
// "done" and the Telegram completion fires exactly once, re-asserting a Stop
// tail over any Notification that landed during the window), settle to idle,
// and only now flip awaitingInputSinceStop. Then celebrate, unless a Kimi
// permission lock is holding the pet.
function promoteCompletion(sessionId, completionPayload = undefined) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (hasClaudeBackgroundSubagentCompletionHold(session)) {
    debugSession(`completion-promote hold sid=${sessionId} reason=background-subagent`);
    return false;
  }
  const suppliedOccurredAt = completionPayload && completionPayload.occurredAt;
  const completionOccurredAt = Number.isSafeInteger(suppliedOccurredAt) && suppliedOccurredAt >= 0
    ? suppliedOccurredAt
    : Date.now();
  if (completionPayload !== undefined) {
    const text = normalizeAssistantOutput(completionPayload && completionPayload.text);
    session.assistantLastOutput = text;
    session.assistantLastOutputTruncated = !!(
      text
      && completionPayload
      && completionPayload.truncated === true
    );
  }
  session.subagentTracker = clearSubagentTracker(cloneSubagentTracker(session));
  // The stored session settles idle, but this Stop consumed the completion
  // attention cue. Record that distinction so a later duplicate Stop is
  // suppressed while an earlier idle-only terminal can still be upgraded.
  session.recentEvents = pushRecentEvent(session, "attention", "Stop");
  const completionSnapshotEvent = session.recentEvents[session.recentEvents.length - 1] || null;
  session.state = "idle";
  session.updatedAt = Date.now();
  session.displayHint = null;
  session.awaitingInputSinceStop = true;
  const recapSnapshot = emitSessionSnapshot({ force: true }).snapshot;
  recordAcceptedRecapEvent({
    occurredAt: completionOccurredAt,
    sessionId,
    rawSessionId: session.rawSessionId || sessionId,
    agentId: session.agentId,
    profileId: session.profileId || "local",
    host: session.host || null,
    wslDistro: session.wslDistro || null,
    event: "Stop",
    snapshotEventAt: completionSnapshotEvent && completionSnapshotEvent.at,
    recapDedupeId: completionPayload && completionPayload.recapDedupeId,
    completionCandidate: true,
  }, recapSnapshot);
  if (hasConfirmedPermissionAnimationLock()) {
    const display = resolveDisplayState();
    setState(display, getSvgOverride(display));
    return true;
  }
  // The completion's data (done badge + Telegram push) already landed via the
  // snapshot above. The celebration is visual-only, so let setState()'s
  // priority guard decide: if a higher-priority visual is queued — possibly
  // from ANOTHER session (e.g. an error) — it must win. We must NOT clear the
  // global pending queue here; pendingTimer/pendingState are process-wide, not
  // per-session, so clearing them would swallow another session's visual.
  setState("attention");
  return true;
}

// ── Session management ──
// Session-related fields go through `opts`. Earlier versions took 13
// positional params — refactored in B2 to an options bag so new fields
// (sessionTitle, etc.) don't keep extending the argument list.
function normalizeSessionAutomationIdentity(value) {
  if (!value || typeof value !== "object") return null;
  if (
    typeof value.eligible !== "boolean"
    || typeof value.reason !== "string"
    || !value.reason.trim()
  ) {
    return Object.freeze({
      eligible: false,
      reason: "invalid-route-assessment",
    });
  }
  return Object.freeze({
    eligible: value.eligible === true,
    reason: value.reason.trim().slice(0, 120),
  });
}

function mergeSessionProcessMetadata(existing, incoming = {}, options = {}) {
  const replace = options.replace === true;
  const incomingPidChain = Array.isArray(incoming.pidChain) && incoming.pidChain.length
    ? incoming.pidChain.slice()
    : null;

  if (!replace) {
    return {
      sourcePid: incoming.sourcePid || (existing && existing.sourcePid) || null,
      wtHwnd: incoming.wtHwnd || (existing && existing.wtHwnd) || null,
      editor: incoming.editor || (existing && existing.editor) || null,
      pidChain: incomingPidChain || (existing && existing.pidChain) || null,
      agentPid: incoming.agentPid || (existing && existing.agentPid) || null,
      identityChanged: terminalIdentityChanged(existing, incoming),
    };
  }

  const sourcePid = incoming.sourcePid || null;
  const agentPid = incoming.agentPid || null;
  const editor = incoming.editor || null;
  const previousSourcePid = (existing && existing.sourcePid) || null;
  const previousAgentPid = (existing && existing.agentPid) || null;
  const identityChanged = !!existing && (
    previousSourcePid !== sourcePid
    || previousAgentPid !== agentPid
  );

  return {
    sourcePid,
    agentPid,
    editor,
    pidChain: incomingPidChain,
    // A foreground HWND is still useful across ordinary lifecycle events for
    // the same terminal identity. Once authoritative metadata replaces or
    // clears that identity, retaining the old HWND could focus another
    // terminal, so it must be cleared unless this event supplied a fresh one.
    wtHwnd: incoming.wtHwnd || (identityChanged ? null : (existing && existing.wtHwnd) || null),
    identityChanged,
  };
}

// Trae stores the session title server-side, so Clawd derives it from the
// first prompt line. The first title that reaches the server wins — a title
// whose POST fails is not permanently claimed, and follow-up prompts never
// overwrite the first one (matching Trae's constant session title).
const FIRST_WINS_TITLE_AGENT_IDS = new Set(["traecode"]);

function resolveIncomingSessionTitle(existing, agentId, incomingTitle) {
  const normalized = normalizeTitle(incomingTitle);
  if (FIRST_WINS_TITLE_AGENT_IDS.has(agentId)) {
    return (existing && existing.sessionTitle) || normalized || null;
  }
  return normalized || (existing && existing.sessionTitle) || null;
}

function updateSession(sessionId, state, event, opts = {}) {
  const suppliedRecapOccurredAt = opts && opts.recapOccurredAt;
  const recapTimestampTrusted = Number.isSafeInteger(suppliedRecapOccurredAt) && suppliedRecapOccurredAt >= 0;
  const recapOccurredAt = recapTimestampTrusted
    ? suppliedRecapOccurredAt
    : Date.now();
  let recapPendingInput = null;
  try {
  const {
    sourcePid = null,
    wtHwnd = null,
    cwd = null,
    editor = null,
    pidChain = null,
    tmuxSocket = null,
    tmuxClient = null,
    orcaPaneKey = null,
    agentPid = null,
    agentId = null,
    profileId = "local",
    rawSessionId = null,
    host = null,
    wslDistro = null,
    headless = false,
    platform = null,
    model = null,
    provider = null,
    codexOriginator = null,
    codexSource = null,
    ghosttyTerminalId = null,
    displayHint = undefined,
    sessionTitle = null,
    contextUsage = null,
    contextUsageOrigin = null,
    assistantLastOutput = null,
    assistantLastOutputTruncated = false,
    toolName = null,
    transcriptPath = null,
    permissionSuspect = false,
    permissionAction = null,
    permissionCommand = null,
    permissionToolInput = null,
    permissionGateOpen = false,
    permissionGated = false,
    permissionGateId = null,
    preserveState = false,
    hookSource = null,
    agentIdDefaulted = false,
    muteNotificationSound = false,
    transientPermissionEvent = false,
    backgroundTasksCount = 0,
    backgroundSubagentsCount,
    sessionCronsCount = 0,
    stopHookActive = false,
    stdinDiag = null,
    sessionAutomationIdentity = null,
    subagentId = null,
    subagentType = null,
    subagentLifecycleSource = null,
    sessionStartSource = null,
    recapBoundary = null,
    recapIsSubagent = false,
    recapDedupeId = null,
    toolUseId = null,
    recapSuppressed = false,
    replaceProcessMetadata = false,
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
  if (event === "Stop" || COMPLETION_CANCEL_EVENTS.has(event)) {
    cancelClaudeTranscriptCompletionProbe(sessionId, event);
  }

  const sessionForPerm = sessions.get(sessionId);
  const permAgentId = resolveIncomingAgentId(sessionForPerm, agentId, agentIdDefaulted);
  const normalizedSessionAutomationIdentity = normalizeSessionAutomationIdentity(
    sessionAutomationIdentity
  );

  const isTransientAttentionRequest = event === "PermissionRequest" || event === "CodexUserInputRequest";
  if (isTransientAttentionRequest) {
    if (permAgentId === "codex") cancelCodexExitProbe(sessionId, event);
    // A transient route event owns its identity assessment just as ordinary
    // state traffic does. Merge it only into an existing session for the same agent:
    // PermissionRequest must not create a ghost session, and a raw-id collision
    // from another agent must not relabel an existing Dashboard row.
    const shouldStorePermissionAutomationIdentity = !!(
      normalizedSessionAutomationIdentity
      && sessionForPerm
      && permAgentId
      && sessionForPerm.agentId === permAgentId
    );
    if (shouldStorePermissionAutomationIdentity) {
      sessionForPerm.sessionAutomationIdentity = normalizedSessionAutomationIdentity;
    }
    // Observation is independent from the permission-bubble preference. A
    // legacy Kimi PreToolUse may arrive here as PermissionRequest with a
    // closed tool-call provenance marker; disabling that UI must not erase
    // the underlying accepted activity from recap.
    recapPendingInput = {
      occurredAt: recapOccurredAt,
      sessionId,
      rawSessionId: (sessionForPerm && sessionForPerm.rawSessionId) || rawSessionId || sessionId,
      agentId: permAgentId,
      profileId: (sessionForPerm && sessionForPerm.profileId) || profileId || "local",
      host: host || (sessionForPerm && sessionForPerm.host) || null,
      wslDistro: wslDistro || (sessionForPerm && sessionForPerm.wslDistro) || null,
      event,
      sessionStartSource,
      recapBoundary,
      recapIsSubagent,
      recapDedupeId,
      toolUseId,
      hookSource,
      recapSuppressed,
      subagentId,
      subagentType,
      completionCandidate: false,
    };
    // Kimi-only gate: startKimiPermissionPoll suppresses the passive bubble
    // when the user disabled Kimi permissions in Settings, but the setState
    // ran first and flashed notification anyway — leaving a silent animation
    // with no follow-up UI. setState already early-returns under DND so we
    // don't need a second DND check here. CC / opencode keep the
    // unconditional setState — their bubble flow gates DND upstream.
    if (
      event === "PermissionRequest"
      && permAgentId === "kimi-cli"
      && typeof ctx.isAgentPermissionsEnabled === "function"
      && !ctx.isAgentPermissionsEnabled("kimi-cli")
    ) return;
    const hasCodexPermissionMetadata = !!(
      sourcePid || wtHwnd || agentPid || (pidChain && pidChain.length) || cwd || host || wslDistro ||
      model || provider || codexOriginator || codexSource || platform || ghosttyTerminalId ||
      tmuxSocket || tmuxClient || orcaPaneKey
    );
    const shouldPersistCodexPermissionFocus = permAgentId === "codex" && (
      hasCodexPermissionMetadata
      // An authoritative all-null result still has to clear stale process
      // metadata on an existing session. It must not create a new ghost row.
      || (replaceProcessMetadata === true && !!sessionForPerm)
    );
    if (shouldPersistCodexPermissionFocus) {
      const existing = sessions.get(sessionId);
      evictOldestSessionIfNeeded(sessionId);
      const processMetadata = mergeSessionProcessMetadata(
        existing,
        { sourcePid, wtHwnd, editor, pidChain, agentPid },
        { replace: replaceProcessMetadata === true }
      );
      const srcPid = processMetadata.sourcePid;
      const srcWtHwnd = processMetadata.wtHwnd;
      const srcCwd = cwd || (existing && existing.cwd) || "";
      const srcEditor = processMetadata.editor;
      const srcPidChain = processMetadata.pidChain;
      const srcTmuxSocket = tmuxSocket || (existing && existing.tmuxSocket) || null;
      const srcTmuxClient = tmuxClient || (existing && existing.tmuxClient) || null;
      const srcOrcaPaneKey = processMetadata.identityChanged && !orcaPaneKey
        ? null
        : mergeOrcaPaneKey(orcaPaneKey, existing, event, { sourcePid, wtHwnd });
      const srcAgentPid = processMetadata.agentPid;
      const srcAgentId = resolveIncomingAgentId(existing, agentId, agentIdDefaulted);
      const srcHost = host || (existing && existing.host) || null;
      const srcWslDistro = wslDistro || (existing && existing.wslDistro) || null;
      const srcHeadless = headless || (existing && existing.headless) || false;
      const srcPlatform = platform || (existing && existing.platform) || null;
      const srcModel = model || (existing && existing.model) || null;
      const srcProvider = provider || (existing && existing.provider) || null;
      const srcCodexOriginator = codexOriginator || (existing && existing.codexOriginator) || null;
      const srcCodexSource = codexSource || (existing && existing.codexSource) || null;
      const srcGhosttyTerminalId = normalizeGhosttyTerminalId(ghosttyTerminalId) || (existing && existing.ghosttyTerminalId) || null;
      const srcSessionTitle = resolveIncomingSessionTitle(existing, srcAgentId, sessionTitle);
      const permissionContext = resolveContextUsageUpdate(existing, contextUsage, contextUsageOrigin);
      const srcContextUsage = permissionContext.contextUsage;
      const srcContextUsageOrigin = permissionContext.contextUsageOrigin;
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
        tmuxSocket: srcTmuxSocket,
        tmuxClient: srcTmuxClient,
        orcaPaneKey: srcOrcaPaneKey,
        agentPid: srcAgentPid,
        agentId: srcAgentId,
        profileId: (existing && existing.profileId) || profileId || "local",
        rawSessionId: (existing && existing.rawSessionId) || rawSessionId || sessionId,
        sessionAutomationIdentity: normalizedSessionAutomationIdentity
          || (existing && existing.sessionAutomationIdentity)
          || null,
        host: srcHost,
        wslDistro: srcWslDistro,
        headless: srcHeadless,
        platform: srcPlatform,
        model: srcModel,
        provider: srcProvider,
        codexOriginator: srcCodexOriginator,
        codexSource: srcCodexSource,
        ghosttyTerminalId: srcGhosttyTerminalId,
        sessionTitle: srcSessionTitle,
        contextUsage: srcContextUsage,
        contextUsageOrigin: srcContextUsageOrigin,
        recentEvents,
        pidReachable: resolvePidReachable(
          replaceProcessMetadata === true ? null : existing,
          srcAgentPid,
          srcPid
        ),
        resumeState: (existing && existing.resumeState) || null,
        muteNotificationSound: muteNotificationSound === true,
        subagentTracker: cloneSubagentTracker(existing),
        claudeBackgroundSubagentHoldAt: existing
          && Number.isFinite(existing.claudeBackgroundSubagentHoldAt)
          && existing.claudeBackgroundSubagentHoldAt > 0
          ? existing.claudeBackgroundSubagentHoldAt
          : null,
      });
    }
    setState("notification", undefined, { muteNotificationSound: muteNotificationSound === true });
    if (event === "PermissionRequest" && permAgentId === "kimi-cli") {
      // Synthesized PermissionRequest (rewritten gated PreToolUse) carries a
      // gate marker — record it so the Post that settles it can re-arm the
      // cue for the next queued approval. Native Kimi Code PermissionRequests
      // have no marker and skip the ledger.
      if (permissionGateOpen === true) {
        openKimiPermissionGate(
          sessionId,
          permissionGateId,
          buildKimiGateDetail(toolName, permissionAction, permissionCommand, permissionToolInput)
        );
        // Same invariant as the suspect path: the cue must describe what the
        // terminal actually blocks on — the OLDEST outstanding gate. Batched
        // synthesized requests all land up front, so refreshing the card with
        // the newest arrival would show a tool whose prompt hasn't appeared
        // yet.
        const gates = kimiPermissionGateLedgers.get(sessionId);
        const headDetail = gates && gates.length
          ? gates[0].detail
          : buildKimiGateDetail(toolName, permissionAction, permissionCommand, permissionToolInput);
        startKimiPermissionPoll(sessionId, headDetail);
      } else {
        // Native Kimi Code: a PermissionRequest fires when its prompt really
        // is on screen, so the newest request IS what the terminal blocks on —
        // refresh-to-newest stays correct here.
        startKimiPermissionPoll(sessionId, { toolName, permissionAction, permissionCommand, permissionToolInput });
      }
    }
    if (
      shouldStorePermissionAutomationIdentity
      || (shouldPersistCodexPermissionFocus && normalizedSessionAutomationIdentity)
    ) {
      emitSessionSnapshot();
    }
    return;
  }

  const existing = sessions.get(sessionId);
  if (existing && existing.startupRecovered === true) {
    delete existing.startupRecovered;
    delete existing.recoveryEventAt;
    delete existing.recoveryValidUntil;
  }
  const processMetadata = mergeSessionProcessMetadata(
    existing,
    { sourcePid, wtHwnd, editor, pidChain, agentPid },
    { replace: replaceProcessMetadata === true }
  );
  const srcPid = processMetadata.sourcePid;
  const srcWtHwnd = processMetadata.wtHwnd;
  const srcCwd = cwd || (existing && existing.cwd) || "";
  const srcEditor = processMetadata.editor;
  const srcPidChain = processMetadata.pidChain;
  const srcTmuxSocket = tmuxSocket || (existing && existing.tmuxSocket) || null;
  const srcTmuxClient = tmuxClient || (existing && existing.tmuxClient) || null;
  const srcOrcaPaneKey = processMetadata.identityChanged && !orcaPaneKey
    ? null
    : mergeOrcaPaneKey(orcaPaneKey, existing, event, { sourcePid, wtHwnd });
  const srcAgentPid = processMetadata.agentPid;
  const srcAgentId = resolveIncomingAgentId(existing, agentId, agentIdDefaulted);
  const srcSessionAutomationIdentity = normalizedSessionAutomationIdentity
    || (existing && existing.sessionAutomationIdentity)
    || null;
  const srcHost = host || (existing && existing.host) || null;
  const srcWslDistro = wslDistro || (existing && existing.wslDistro) || null;
  const srcHeadless = headless || (existing && existing.headless) || false;
  const srcPlatform = platform || (existing && existing.platform) || null;
  const srcModel = model || (existing && existing.model) || null;
  const srcProvider = provider || (existing && existing.provider) || null;
  const srcCodexOriginator = codexOriginator || (existing && existing.codexOriginator) || null;
  const srcCodexSource = codexSource || (existing && existing.codexSource) || null;
  const srcGhosttyTerminalId = normalizeGhosttyTerminalId(ghosttyTerminalId) || (existing && existing.ghosttyTerminalId) || null;
  // Sticky: empty input does not clear an existing title. A session that has
  // ever been named keeps that name until the user explicitly renames it.
  const srcSessionTitle = resolveIncomingSessionTitle(existing, srcAgentId, sessionTitle);
  const normalizedIncomingContextUsage = normalizeContextUsage(contextUsage);
  const effectiveContextUsageOrigin = normalizeContextUsageOrigin(contextUsageOrigin)
    || (srcAgentId === "claude-code" && normalizedIncomingContextUsage && normalizedIncomingContextUsage.source === "claude"
      ? "claude-transcript"
      : null);
  const resolvedContextUsage = resolveContextUsageUpdate(
    existing,
    normalizedIncomingContextUsage,
    effectiveContextUsageOrigin
  );
  const srcContextUsage = resolvedContextUsage.contextUsage;
  const srcContextUsageOrigin = resolvedContextUsage.contextUsageOrigin;
  const incomingAssistantLastOutput = normalizeAssistantOutput(assistantLastOutput);
  const srcAssistantLastOutput = incomingAssistantLastOutput;
  const srcAssistantLastOutputTruncated = !!(
    srcAssistantLastOutput
    && assistantLastOutputTruncated === true
  );
  const incomingToolName = normalizeToolName(toolName);
  const srcToolName = incomingToolName || (existing && existing.lastToolName) || null;
  const srcTranscriptPath = normalizeTranscriptPath(transcriptPath) || (existing && existing.transcriptPath) || null;
  const srcResumeState = (existing && existing.resumeState) || null;
  const isSubagentStart = event === "SubagentStart" || event === "subagentStart";
  const isSubagentStop = event === "SubagentStop" || event === "subagentStop";
  const normalizedSubagentId = normalizeChildId(subagentId);
  const isSubagentScopedSessionEnd = event === "SessionEnd" && !!normalizedSubagentId;
  const isSyntheticSubagentStart = !!(
    isSubagentStart
    && (
      ["synthetic-tool", "synthetic-task"].includes(subagentLifecycleSource)
      || ["Agent", "Task"].includes(incomingToolName)
    )
  );
  const preservedState = preserveState && existing ? existing.state : null;
  const duplicateCompletionVisualAtEntry = shouldSuppressDuplicateCompletionVisual(existing, state, event);
  const isClaudeMainStop = event === "Stop"
    && state === "attention"
    && srcAgentId === "claude-code"
    && !normalizedSubagentId;
  const typedSubagentSnapshotKnown = Object.prototype.hasOwnProperty.call(
    opts,
    "backgroundSubagentsCount",
  ) && Number.isSafeInteger(backgroundSubagentsCount) && backgroundSubagentsCount >= 0;
  const incomingTypedSubagentCount = typedSubagentSnapshotKnown
    ? backgroundSubagentsCount
    : 0;
  const typedSubagentSnapshotIsZero = typedSubagentSnapshotKnown
    && incomingTypedSubagentCount === 0;
  const existingTypedSubagentHold = !!(
    existing
    && Number.isFinite(existing.claudeBackgroundSubagentHoldAt)
    && existing.claudeBackgroundSubagentHoldAt > 0
  );
  const effectiveTypedSubagentHold = incomingTypedSubagentCount > 0
    || (existingTypedSubagentHold && !typedSubagentSnapshotKnown);
  let claudeBackgroundSubagentHoldAt = existingTypedSubagentHold
    ? existing.claudeBackgroundSubagentHoldAt
    : null;
  if (isClaudeMainStop && duplicateCompletionVisualAtEntry) {
    // A late duplicate Stop must not reopen a completed session or leave a
    // private hold behind that can block a later legitimate completion.
    claudeBackgroundSubagentHoldAt = null;
  } else if (isClaudeMainStop && incomingTypedSubagentCount > 0) {
    claudeBackgroundSubagentHoldAt = Math.max(1, Date.now());
  } else if (isClaudeMainStop && typedSubagentSnapshotIsZero) {
    claudeBackgroundSubagentHoldAt = null;
  }

  // #406 Stop completion gate — Claude Code only; other agents keep their own
  // completion semantics (Codex task_complete + remote exit probes, etc.). A
  // Stop → "attention" is not always a real turn end:
  //   · live background_tasks / session_crons → work continues in the bg
  //   · stop_hook_active → a Stop hook vetoed the stop; Claude will continue
  //   · a third-party Stop hook can veto THIS stop, invisibly to us → debounce
  // Hard gates hold "working" (badge stays "running", no celebrate, no
  // "done"). A plain Stop, and a bg-only Stop that already has final assistant
  // text, can be debounced until a quiet window confirms the turn really ended.
  if (
    !duplicateCompletionVisualAtEntry
    && isClaudeMainStop
  ) {
    cancelCompletionDebounce(sessionId, "stop-superseded");
    const disposition = getClaudeStopDisposition({
      backgroundTasksCount,
      backgroundSubagentsCount: typedSubagentSnapshotKnown
        ? incomingTypedSubagentCount
        : undefined,
      sessionCronsCount,
      stopHookActive,
      // Incoming, never the carried-forward value: this asks whether THIS Stop
      // ended the turn with text. Feeding it a carried value flips a genuinely
      // text-less Stop from "hold" to "promote", celebrating and pushing while
      // background work is still live -- the exact case #406 exists to prevent.
      hasFinalAssistantText: !!incomingAssistantLastOutput,
      headless: srcHeadless,
    });
    const hardLiveWork = disposition.kind === "hold"
      || effectiveTypedSubagentHold;
    const debounceMs = hardLiveWork ? 0 : disposition.debounceMs;
    if (hardLiveWork || debounceMs > 0) {
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
      if (hardLiveWork) {
        debugSession(
          `stop-gate sid=${sessionId} bg=${backgroundTasksCount} subagents=${typedSubagentSnapshotKnown ? incomingTypedSubagentCount : "unknown"} crons=${sessionCronsCount} active=${stopHookActive} action=hold-working`
        );
        // Hard live work never auto-promotes; a later plain Stop (no hard
        // blockers) will.
      } else {
        if (backgroundTasksCount > 0) {
          debugSession(
            `stop-gate sid=${sessionId} bg=${backgroundTasksCount} crons=${sessionCronsCount} active=${stopHookActive} action=debounce-working`
          );
        }
        scheduleCompletionDebounce(sessionId, debounceMs, {
          occurredAt: recapOccurredAt,
          text: incomingAssistantLastOutput,
          truncated: assistantLastOutputTruncated === true,
        });
      }
    }
    // debounceMs <= 0 && !hardLiveWork → keep "attention" (immediate celebration).
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

  // Antigravity 1.0.6 can emit a trailing PostToolUse about a second after a
  // fully-idle Stop for the same conversation. Treat it as stale so it does not
  // resurrect the completed session into a permanent typing/working state.
  if (shouldDropAntigravityPostStopToolUse(existing, state, event, srcAgentId)) {
    debugSession(`antigravity trailing PostToolUse drop sid=${sessionId}`);
    return;
  }

  debugSession(`event ${describeSession(sessionId, existing)} -> incoming=${state}/${event || "-"} hint=${displayHint || "-"} source=${hookSource || "-"}${formatStdinDiag(stdinDiag)}`);

  const pidReachable = resolvePidReachable(
    replaceProcessMetadata === true ? null : existing,
    srcAgentPid,
    srcPid
  );

  const keepExistingCompletionEventTail = shouldKeepExistingCompletionEventTail(existing, state, event);
  const recentEvents = keepExistingCompletionEventTail && Array.isArray(existing.recentEvents)
    ? (duplicateCompletionVisualAtEntry
      ? existing.recentEvents.slice()
      : markCompletionTailPresented(existing.recentEvents))
    : pushRecentEvent(existing, preservedState || state, event);
  const recapSnapshotEvent = event && recentEvents.length > 0
    ? recentEvents[recentEvents.length - 1]
    : null;
  if (event && !(duplicateCompletionVisualAtEntry && isDoneEvent(event))) {
    recapPendingInput = {
      occurredAt: recapOccurredAt,
      sessionId,
      rawSessionId: (existing && existing.rawSessionId) || rawSessionId || sessionId,
      agentId: srcAgentId,
      profileId: (existing && existing.profileId) || profileId || "local",
      host: srcHost,
      wslDistro: srcWslDistro,
      event,
      snapshotEventAt: recapSnapshotEvent && recapSnapshotEvent.at,
      sessionStartSource,
      recapBoundary,
      recapIsSubagent,
      recapDedupeId,
      toolUseId,
      hookSource,
      recapSuppressed,
      subagentId: normalizedSubagentId,
      subagentType,
      completionCandidate: !duplicateCompletionVisualAtEntry && isDoneEvent(event),
    };
  }
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
  // metadataUpdatedAt rides along with the telemetry it timestamps
  // (contextUsage): a lifecycle event that carries it forward from
  // `existing` must not silently reset the freshness stamp.
  const srcMetadataUpdatedAt = existing && Number.isFinite(existing.metadataUpdatedAt) ? existing.metadataUpdatedAt : null;
  const subagentTracker = cloneSubagentTracker(existing);
  const hadSubagentHoldBefore = hasSubagentHoldEvidence(subagentTracker);

  // A restored lease is only an initial visual guess. The first real lifecycle
  // event replaces it; metadata-only statusline traffic bypasses updateSession.
  if (event && preserveState !== true) subagentTracker.recoveredFloor = false;

  // SessionStart has several upstream sources. Only startup/clear are known to
  // begin a fresh lifecycle; resume/compact and unknown sources preserve
  // confirmed ids until D0 proves a stronger boundary.
  if (
    event === "SessionStart"
    && !normalizedSubagentId
    && (sessionStartSource === "startup" || sessionStartSource === "clear")
  ) {
    clearSubagentTracker(subagentTracker);
    claudeBackgroundSubagentHoldAt = null;
  }

  // A new parent prompt bounds only anonymous evidence. Trusted child ids may
  // represent background work spanning the parent turn.
  if (event === "UserPromptSubmit" && !normalizedSubagentId) {
    subagentTracker.legacyFloor = false;
    subagentTracker.recoveredFloor = false;
  }

  if (isSubagentStart) {
    subagentTracker.recoveredFloor = false;
    if (isSyntheticSubagentStart) {
      subagentTracker.legacyFloor = true;
      // A nested Task/Agent tool call's id names the originator, not the new
      // child. Activity still proves that originator itself is live, so it may
      // be readmitted.
      if (normalizedSubagentId) subagentTracker.confirmedIds.add(normalizedSubagentId);
    } else if (normalizedSubagentId) {
      subagentTracker.confirmedIds.add(normalizedSubagentId);
    } else {
      subagentTracker.legacyFloor = true;
    }
  } else if (isSubagentStop || isSubagentScopedSessionEnd) {
    subagentTracker.recoveredFloor = false;
    if (normalizedSubagentId) subagentTracker.confirmedIds.delete(normalizedSubagentId);
    // Native + synthetic double delivery observes the same population. Any
    // child close is also the bounded legacy lane's first-stop release.
    subagentTracker.legacyFloor = false;
  } else if (normalizedSubagentId && event !== "SessionEnd") {
    // SubagentStop can be vetoed by another hook. Any later activity from the
    // same child is positive liveness evidence and self-corrects the removal.
    subagentTracker.confirmedIds.add(normalizedSubagentId);
  }

  if (
    (isSubagentStop || isSubagentScopedSessionEnd)
    && typedSubagentSnapshotIsZero
    && !hasSubagentHoldEvidence(subagentTracker)
  ) {
    // SubagentStop is resolving evidence, not a completion event. It may clear
    // the aggregate typed marker only after the identity tracker agrees that no
    // child remains; the existing session state is preserved below.
    claudeBackgroundSubagentHoldAt = null;
  }

  // Reaching this point with a real main Stop means the completion gate above
  // accepted it. Held/debounced stops were rewritten to event=null.
  // An authoritative typed zero must release the tracker before a debounced
  // completion timer can call promoteCompletion(); duplicate completion Stops
  // likewise cannot retain hidden child evidence on an already-complete row.
  if (
    (event === "Stop" && !normalizedSubagentId)
    || (isClaudeMainStop && typedSubagentSnapshotIsZero)
    || (isClaudeMainStop && duplicateCompletionVisualAtEntry)
  ) {
    clearSubagentTracker(subagentTracker);
  }

  const base = { sourcePid: srcPid, wtHwnd: srcWtHwnd, cwd: srcCwd, editor: srcEditor, pidChain: srcPidChain, tmuxSocket: srcTmuxSocket, tmuxClient: srcTmuxClient, orcaPaneKey: srcOrcaPaneKey, agentPid: srcAgentPid, agentId: srcAgentId, profileId: (existing && existing.profileId) || profileId || "local", rawSessionId: (existing && existing.rawSessionId) || rawSessionId || sessionId, sessionAutomationIdentity: srcSessionAutomationIdentity, host: srcHost, wslDistro: srcWslDistro, headless: srcHeadless, platform: srcPlatform, model: srcModel, provider: srcProvider, codexOriginator: srcCodexOriginator, codexSource: srcCodexSource, ghosttyTerminalId: srcGhosttyTerminalId, sessionTitle: srcSessionTitle, contextUsage: srcContextUsage, contextUsageOrigin: srcContextUsageOrigin, metadataUpdatedAt: srcMetadataUpdatedAt, assistantLastOutput: srcAssistantLastOutput, assistantLastOutputTruncated: srcAssistantLastOutputTruncated, lastToolName: srcToolName, transcriptPath: srcTranscriptPath, recentEvents, pidReachable, lastToolBoundaryAt: srcLastToolBoundaryAt, lastStopAt: srcLastStopAt, awaitingInputSinceStop: resolveAwaitingInputSinceStop(existing, event), muteNotificationSound: state === "notification" && muteNotificationSound === true, claudeBackgroundSubagentHoldAt };
  if (preserveCompletionAck) base.requiresCompletionAck = true;
  // #862: every branch below rebuilds the session object from `base`; carry the
  // private identity tracker through without exposing it on snapshot surfaces.
  base.subagentTracker = subagentTracker;
  const typedSubagentHoldActive = Number.isFinite(claudeBackgroundSubagentHoldAt)
    && claudeBackgroundSubagentHoldAt > 0;

  // Evict oldest session if at capacity and this is a new session.
  evictOldestSessionIfNeeded(sessionId);

  if (isSubagentStop || isSubagentScopedSessionEnd) {
    updateCodexExitProbe(sessionId, srcAgentId, event);
    if (!existing) {
      recapPendingInput = null;
      debugSession(`subagent-stop ignore sid=${sessionId} reason=no-session`);
      cleanStaleSessions();
      const displayState = resolveDisplayState();
      setState(displayState, getSvgOverride(displayState));
      return;
    }

    if (hasConfirmedSubagents(subagentTracker)) {
      const dh = pickDisplayHint("juggling", existing, displayHint);
      sessions.set(sessionId, {
        state: "juggling",
        updatedAt: Date.now(),
        displayHint: dh,
        ...base,
        resumeState: existing.resumeState || null,
      });
      debugSession(`subagent-stop hold ${describeSession(sessionId, sessions.get(sessionId))}`);
      cleanStaleSessions();
      const heldState = resolveDisplayState();
      setState(heldState, getSvgOverride(heldState));
      return;
    }

    if (existing.state === "juggling") {
      // #862: one stop does not mean the work is over. Restoring on the first
      // stop dropped the pet back to typing while other subagents were still
      // running; hold juggling until the last one reports in.
      const resumeState = existing.resumeState || null;
      if (resumeState) {
        const dh = pickDisplayHint(resumeState, existing, displayHint);
        sessions.set(sessionId, { state: resumeState, updatedAt: Date.now(), displayHint: dh, ...base, resumeState: null });
        debugSession(`subagent-stop restore ${describeSession(sessionId, sessions.get(sessionId))}`);
      } else if (typedSubagentHoldActive) {
        sessions.set(sessionId, {
          state: "working",
          updatedAt: Date.now(),
          displayHint: pickDisplayHint("working", existing, displayHint),
          ...base,
          resumeState: null,
        });
        debugSession(`subagent-stop typed-hold ${describeSession(sessionId, sessions.get(sessionId))}`);
      } else {
        deleteSessionWithCompletionCleanup(sessionId, "subagent-stop-no-resume");
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
    if (
      !subagentId
      && !subagentType
      && typeof ctx.onSessionAutomationLifecycleEnd === "function"
    ) {
      ctx.onSessionAutomationLifecycleEnd({
        agentId: (endingSession && endingSession.agentId) || srcAgentId,
        sessionId,
        reason: "session-end",
      });
    }
    deleteSessionWithCompletionCleanup(sessionId, "session-end");
    debugSession(`session-end delete ${describeSession(sessionId, endingSession)}`);
    cleanStaleSessions();
    if (srcAgentId === "kimi-cli") disposeKimiPermissionSession(sessionId);
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
    if (hasSubagentHoldEvidence(subagentTracker)) {
      sessions.set(sessionId, {
        state: "juggling",
        updatedAt: Date.now(),
        displayHint: pickDisplayHint("juggling", existing, displayHint),
        ...base,
        resumeState: (existing && existing.resumeState) || null,
      });
    } else if (typedSubagentHoldActive) {
      sessions.set(sessionId, {
        state: "working",
        updatedAt: Date.now(),
        displayHint: pickDisplayHint("working", existing, displayHint),
        ...base,
        resumeState: (existing && existing.resumeState) || null,
      });
    } else {
      sessions.set(sessionId, { state: "idle", updatedAt: Date.now(), displayHint: null, ...base, resumeState: null });
    }
  } else if (ONESHOT_STATES.has(state)) {
    if (hasSubagentHoldEvidence(subagentTracker)) {
      sessions.set(sessionId, {
        state: "juggling",
        updatedAt: Date.now(),
        displayHint: pickDisplayHint("juggling", existing, displayHint),
        ...base,
        resumeState: (existing && existing.resumeState) || null,
      });
    } else if (typedSubagentHoldActive) {
      sessions.set(sessionId, {
        state: "working",
        updatedAt: Date.now(),
        displayHint: pickDisplayHint("working", existing, displayHint),
        ...base,
        resumeState: (existing && existing.resumeState) || null,
      });
    } else if (existing) {
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
      const resumeState = !hadSubagentHoldBefore && existing && existing.state !== "juggling"
        ? existing.state
        : srcResumeState;
      sessions.set(sessionId, { state, updatedAt: Date.now(), displayHint: dh, ...base, resumeState });
      debugSession(`subagent-start store ${describeSession(sessionId, sessions.get(sessionId))}`);
    } else if (
      hasSubagentHoldEvidence(subagentTracker)
      && (state === "working" || state === "thinking" || state === "idle" || state === "juggling")
    ) {
      sessions.set(sessionId, {
        state: "juggling",
        updatedAt: Date.now(),
        displayHint: pickDisplayHint("juggling", existing, displayHint),
        ...base,
        resumeState: (existing && existing.resumeState) || null,
      });
      debugSession(`juggling-hold ${describeSession(sessionId, sessions.get(sessionId))} event=${event || "-"}`);
    } else if (typedSubagentHoldActive && state === "idle") {
      sessions.set(sessionId, {
        state: "working",
        updatedAt: Date.now(),
        displayHint: pickDisplayHint("working", existing, displayHint),
        ...base,
        resumeState: (existing && existing.resumeState) || null,
      });
    } else {
      const dh = pickDisplayHint(state, existing, displayHint);
      sessions.set(sessionId, { state, updatedAt: Date.now(), displayHint: dh, ...base, resumeState: null });
    }
  }
  cleanStaleSessions();
  updateCodexExitProbe(sessionId, srcAgentId, event);
  if (
    srcAgentId === "claude-code"
    && event === "PostToolUse"
    && isClaudeElicitationCompletionTool(srcToolName)
    && srcTranscriptPath
  ) {
    scheduleClaudeTranscriptCompletionProbe(sessionId, srcTranscriptPath);
  }
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
    // Kimi Code native events (#563). PermissionResult is the definitive
    // "approval answered" signal (decision: approved/rejected). On the
    // rejected path upstream fires PostToolUseFailure BEFORE
    // PermissionResult — both clear, so ordering does not matter here.
    // Interrupt is the user's Esc: any pending approval UI is gone with it.
    "PermissionResult",
    "Interrupt",
  ]);
  if (srcAgentId === "kimi-cli" && KIMI_HOLD_CLEAR_EVENTS.has(event)) {
    if (event === "PostToolUse" || event === "PostToolUseFailure") {
      // A gated Post settles its ledger entry first (exact tool_call_id
      // match, FIFO for anonymous entries). Non-gated Posts leave the
      // ledger alone.
      if (permissionGated === true) closeKimiPermissionGate(sessionId, permissionGateId);
      // Cue-level clear only — the ledger survives. The user answered THIS
      // tool, so the pet must leave notification now (sleep-30 rule above);
      // but if the same assistant message queued more gated calls, re-arm
      // the suspect window so the NEXT pending approval re-surfaces its own
      // cue ~800ms later. Like any suspect it is cancelled if the next
      // PostToolUse lands sooner (auto-approved chain → no flash). This also
      // covers a non-gated tool finishing between two gated ones: its Post
      // clears the cue, and the re-arm brings the pending approval back.
      stopKimiPermissionPoll(sessionId);
      const pendingGates = kimiPermissionGateLedgers.get(sessionId);
      if (pendingGates && pendingGates.length) {
        schedulePermissionSuspect(sessionId, pendingGates[0].detail);
      }
    } else {
      // Turn-level / terminal events (Stop, UserPromptSubmit, PermissionResult,
      // Interrupt, …): the whole approval context is gone — drop the ledger
      // together with the cue.
      disposeKimiPermissionSession(sessionId);
    }
  }

  // A brand-new PreToolUse normally starts a fresh approval gate. Preserve an
  // existing cue, however, when the legacy hook batches a gated Pre followed
  // by a non-gated Pre: the first tool is still blocked in the terminal and
  // its ledger/timer remains authoritative until its matching Post arrives.
  if (event === "PreToolUse" && srcAgentId === "kimi-cli") {
    const pendingGates = kimiPermissionGateLedgers.get(sessionId);
    const preservePendingGateCue = permissionGateOpen !== true && pendingGates && pendingGates.length > 0;
    if (!preservePendingGateCue) {
      if (kimiPermissionHolds.has(sessionId)) stopKimiPermissionPoll(sessionId);
      else cancelPermissionSuspect(sessionId);
    }
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
    if (permissionGateOpen === true) {
      openKimiPermissionGate(
        sessionId,
        permissionGateId,
        buildKimiGateDetail(toolName, permissionAction, permissionCommand, permissionToolInput)
      );
    }
    // The cue must describe what the terminal actually blocks on — the OLDEST
    // outstanding gate — not the PreToolUse that happened to arrive last
    // (batched Pres land back-to-back and each reschedules this timer).
    const gates = kimiPermissionGateLedgers.get(sessionId);
    const headDetail = gates && gates.length
      ? gates[0].detail
      : buildKimiGateDetail(toolName, permissionAction, permissionCommand, permissionToolInput);
    schedulePermissionSuspect(sessionId, headDetail);
  }

  const suppressDuplicateCompletionVisual =
    duplicateCompletionVisualAtEntry || shouldSuppressDuplicateCompletionVisual(existing, state, event);

  if (ONESHOT_STATES.has(state)) {
    // Permission animation lock: while any permission request is pending,
    // keep the pet on notification and block all other one-shot visuals.
    // (One-shot branch normally bypasses resolveDisplayState()).
    if (hasConfirmedPermissionAnimationLock() && state !== "notification") {
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
      && (state === "notification" || state === "attention")
      && srcAgentId
      && typeof ctx.isAgentNotificationHookEnabled === "function"
      && !ctx.isAgentNotificationHookEnabled(srcAgentId)
    ) {
      const displayState = resolveDisplayState();
      setState(displayState, getSvgOverride(displayState));
      return;
    }
    if (suppressDuplicateCompletionVisual) {
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
    const recapSnapshot = emitSessionSnapshot().snapshot;
    if (recapPendingInput) recordAcceptedRecapEvent(recapPendingInput, recapSnapshot);
  }
}

function restoreSessionFromLease(lease) {
  if (!lease || typeof lease !== "object") return false;
  const rawSessionId = typeof lease.sessionId === "string" ? lease.sessionId : "";
  const agentId = typeof lease.agentId === "string" ? lease.agentId : "";
  if (!rawSessionId || rawSessionId === "default" || agentId !== "claude-code" || lease.active !== true) return false;
  if (!Number.isFinite(lease.eventAt) || lease.eventAt <= 0 || lease.validUntil !== null) return false;
  if (lease.state !== "thinking" && lease.state !== "working" && lease.state !== "juggling") return false;
  const sessionIdentity = resolveSessionIdentity(rawSessionId, "local");
  const sessionId = sessionIdentity.sessionId;
  if (sessions.has(sessionId)) return false;
  if (sessions.size >= MAX_SESSIONS) return false;
  const pid = Number.isInteger(lease.pid) && lease.pid > 0 ? lease.pid : null;
  const sourcePid = Number.isInteger(lease.sourcePid) && lease.sourcePid > 0 ? lease.sourcePid : null;
  if (!pid && !sourcePid) return false;
  sessions.set(sessionId, {
    state: lease.state,
    updatedAt: Date.now(),
    displayHint: null,
    sourcePid,
    wtHwnd: null,
    cwd: typeof lease.cwd === "string" ? lease.cwd : "",
    editor: null,
    pidChain: null,
    tmuxSocket: null,
    tmuxClient: null,
    orcaPaneKey: null,
    agentPid: pid,
    agentId,
    profileId: sessionIdentity.profileId,
    rawSessionId: sessionIdentity.rawSessionId,
    host: null,
    wslDistro: null,
    headless: false,
    platform: null,
    model: null,
    provider: null,
    codexOriginator: null,
    codexSource: null,
    ghosttyTerminalId: null,
    sessionTitle: typeof lease.title === "string" ? lease.title : null,
    contextUsage: null,
    contextUsageOrigin: null,
    antigravityQuota: null,
    claudeQuota: null,
    metadataUpdatedAt: null,
    assistantLastOutput: null,
    assistantLastOutputTruncated: false,
    lastToolName: null,
    transcriptPath: null,
    recentEvents: [],
    pidReachable: true,
    resumeState: null,
    awaitingInputSinceStop: false,
    muteNotificationSound: false,
    subagentTracker: {
      confirmedIds: new Set(),
      legacyFloor: false,
      recoveredFloor: lease.state === "juggling",
    },
    startupRecovered: true,
    recoveryEventAt: lease.eventAt,
    recoveryValidUntil: lease.validUntil,
  });
  lastSessionSnapshot = null;
  lastSessionSnapshotSignature = null;
  return true;
}

function isProcessAlive(pid) {
  try { _kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function cleanStaleSessions() {
  const now = Date.now();
  let changed = false;
  // Quota is session-independent and can go stale while no hook events are
  // arriving. The existing 10-second lifecycle sweep must therefore retire
  // dead buckets too and force a snapshot refresh when it does.
  let snapshotRefreshNeeded = accountQuota.prune();
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
      if (s && s.agentId && typeof ctx.onSessionAutomationLifecycleEnd === "function") {
        ctx.onSessionAutomationLifecycleEnd({
          agentId: s.agentId,
          sessionId: id,
          reason: `stale-delete-${decision.reason}`,
        });
      }
      deleteSessionWithCompletionCleanup(id, `stale-delete-${decision.reason}`); changed = true;
      continue;
    }

    if (decision.action === "idle") {
      debugSession(`stale-idle ${decision.reason} ${describeSession(id, s)}`);
      s.state = "idle"; s.displayHint = null;
      s.subagentTracker = clearSubagentTracker(cloneSubagentTracker(s));
      s.claudeBackgroundSubagentHoldAt = null;
      cancelCompletionDebounce(id, `stale-idle-${decision.reason}`);
      cancelClaudeTranscriptCompletionProbe(id, `stale-idle-${decision.reason}`);
      if (decision.updateTimestamp) s.updatedAt = now;
      changed = true;
    }
  }
  if (changed && sessions.size === 0) {
    setState("idle", getSvgOverride("idle"));
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
  kimiPermissionGateLedgers.delete(id);
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
  deleteSessionWithCompletionCleanup(id, "session-hidden");
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
      deleteSessionWithCompletionCleanup(id, "clear-sessions");
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
    // Gate ledgers can hold the same orphans (immediate-mode sessions never
    // enter the `sessions` Map either). Today's callers pair this function
    // with dismissPermissionsByAgent → disposeAllKimiPermissionState, which
    // would clear them anyway — but this function must not depend on that
    // pairing to keep the ledger from re-arming a cue for a dead session.
    kimiPermissionGateLedgers.clear();
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
  // Skip the system call when every integration is disabled, then build the
  // query from each enabled agent's explicit conservative detection surface.
  if (typeof ctx.hasAnyEnabledAgent === "function" && !ctx.hasAnyEnabledAgent()) {
    done(false);
    return;
  }
  const isEnabled = typeof ctx.isAgentEnabled === "function"
    ? (agentId) => ctx.isAgentEnabled(agentId)
    : () => true;
  const processEntries = getStartupRecoveryProcessNames()
    .filter((entry) => entry && entry.name && entry.agentId && isEnabled(entry.agentId));
  // Preserve node-shaped CLI detection only as a weak keep-awake fallback.
  // A match here never creates a session or publishes a task-level state.
  // An optional `processName` overrides the default `node.exe` host for an
  // entry — used by agents whose Windows runtime is a different binary (e.g.
  // ZCode reuses the desktop executable to run `zcode.cjs`). On POSIX the
  // same marker is matched with pgrep -f, covering current macOS builds without
  // treating the always-running GUI shell as active work.
  const commandLineNeedles = [
    { agentId: "claude-code", needle: "claude-code" },
    { agentId: "codex", needle: "codex" },
    { agentId: "copilot-cli", needle: "copilot" },
    { agentId: "codebuddy", needle: "codebuddy" },
    { agentId: "kimi-cli", needle: "kimi-code" },
    // Current ZCode runtimes use resources/glm/zcode.cjs app-server; only the
    // cmdline token disambiguates the working process from the GUI shell.
    { agentId: "zcode", needle: "zcode.cjs", processName: "zcode.exe" },
  ].filter((entry) => isEnabled(entry.agentId));
  const platformCommandLineNeedles = process.platform === "win32" || !isEnabled("pi")
    ? commandLineNeedles
    : [
        ...commandLineNeedles,
        { agentId: "pi", needle: "@earendil-works/pi-coding-agent" },
        { agentId: "pi", needle: "pi-coding-agent/dist/cli.js" },
      ];
  if (processEntries.length === 0 && platformCommandLineNeedles.length === 0) {
    done(false);
    return;
  }
  const { execFile, exec } = require("child_process");
  if (process.platform === "win32") {
    // Registry declarations are source-controlled literals. External input
    // must never be spliced into this WQL filter.
    const names = [...new Set(processEntries.map((entry) => String(entry.name).toLowerCase()))];
    const quotedNames = names.map((name) => `'${name.replace(/'/g, "''")}'`).join(",");
    const quotedNeedles = platformCommandLineNeedles
      .map((entry) => `'${entry.needle.replace(/'/g, "''")}'`)
      .join(",");
    const psScript =
      `$names = @(${quotedNames}); ` +
      `$nodeNeedles = @(${quotedNeedles}); ` +
      // Each needle may carry its own host process name (default node.exe) so a
      // non-node runtime like ZCode.exe can be matched by name+cmdline jointly.
      `$nodeNeedleNames = @(${platformCommandLineNeedles.map((entry) => `'${String(entry.processName || "node.exe").replace(/'/g, "''")}'`).join(",")}); ` +
      "$nameFilters = $names | ForEach-Object { \"Name='$_'\" }; " +
      "$nodeFilters = for ($i = 0; $i -lt $nodeNeedles.Length; $i++) { \"(Name='$($nodeNeedleNames[$i])' AND CommandLine LIKE '%$($nodeNeedles[$i])%')\" }; " +
      "$filter = (@($nameFilters) + @($nodeFilters)) -join ' OR '; " +
      "$match = Get-CimInstance Win32_Process -Filter $filter | Select-Object -First 1; " +
      "if ($match) { $match.ProcessId }";
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psScript],
      { encoding: "utf8", timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => done(!err && /\d+/.test(stdout))
    );
  } else {
    const shellQuote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
    const regexEscape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exactClauses = [...new Set(processEntries.map((entry) => String(entry.name)))]
      .map((name) => `pgrep -x ${shellQuote(name)}`);
    const markerPattern = platformCommandLineNeedles
      .map((entry) => regexEscape(entry.needle))
      .join("|");
    const clauses = markerPattern
      ? [`pgrep -f ${shellQuote(markerPattern)}`, ...exactClauses]
      : exactClauses;
    exec(clauses.join(" || "), { timeout: 3000 },
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

function startKimiPermissionPoll(sessionId, permissionDetail = null, source = "confirmed") {
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
    // permanent stuck state if every other signal is somehow lost — and in
    // that lost-signal world the gate ledger is stale too, so drop it whole.
    timer = setTimeout(() => {
      disposeKimiPermissionSession(sessionId);
    }, maxMs);
  }
  kimiPermissionHolds.set(sessionId, {
    timer,
    until: maxMs > 0 ? Date.now() + maxMs : null,
    source: source === "heuristic" ? "heuristic" : "confirmed",
  });
  // Refreshing the hold must still forward fresh detail: with the rich cue,
  // showing request #1's command while the terminal blocks on request #2
  // would be authoritatively wrong. showKimiNotifyBubble dedupes per session
  // and refreshes the existing card in place (codex idiom), so no bubble
  // stacking. Suspect promotions carry no detail object and skip the
  // refresh — a heuristic re-affirmation must not downgrade a rich card.
  if (typeof ctx.showKimiNotifyBubble === "function" && (!existing || permissionDetail)) {
    // #563: Kimi Code native PermissionRequest carries what actually needs
    // approval; the bubble shows the real command instead of generic copy.
    // Legacy synthesized requests pass null detail and keep the old text.
    ctx.showKimiNotifyBubble({
      sessionId,
      toolName: permissionDetail && permissionDetail.toolName ? permissionDetail.toolName : null,
      permissionAction: permissionDetail && permissionDetail.permissionAction ? permissionDetail.permissionAction : null,
      permissionCommand: permissionDetail && permissionDetail.permissionCommand ? permissionDetail.permissionCommand : null,
      permissionToolInput: permissionDetail && permissionDetail.permissionToolInput ? permissionDetail.permissionToolInput : null,
    });
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

function schedulePermissionSuspect(sessionId, permissionDetail = null) {
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
    // permissionDetail (queue head of the gate ledger, or null for a plain
    // legacy suspect) makes the promoted cue name the tool that actually
    // blocks the terminal; null degrades to the generic copy.
    startKimiPermissionPoll(sessionId, permissionDetail, "heuristic");
    setState("notification");
  }, delay);
  kimiPermissionSuspectTimers.set(sessionId, { timer, scheduledAt: Date.now() });
}

// Cue-level clear: hold + suspect timer + visible card. The gate ledger is
// deliberately PRESERVED — a Post that settles one of several batched
// approvals must clear the current cue without forgetting the queued rest.
// Full teardown (turn-level events, session disposal, safety cap) goes
// through disposeKimiPermissionSession instead. The no-arg variant is the
// global stop-everything path and drops the ledgers too.
function stopKimiPermissionPoll(sessionId) {
  if (!sessionId) {
    kimiPermissionGateLedgers.clear();
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

// Full per-session teardown: cue + gate ledger. Used by turn-level events
// (Stop/UserPromptSubmit/PermissionResult/Interrupt/…), SessionEnd, the
// safety-cap timer, and session disposal — every path where the approval
// context as a whole is gone and queued gates must not re-arm a cue later.
function disposeKimiPermissionSession(sessionId) {
  if (!sessionId) return;
  kimiPermissionGateLedgers.delete(sessionId);
  stopKimiPermissionPoll(sessionId);
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
    idleDefaultVisual: typeof ctx.getIdleVisualChoice === "function" ? ctx.getIdleVisualChoice() : null,
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
  kimiPermissionGateLedgers.clear();
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
  // DND suppresses presentation, not observation. Pending completion
  // arbitration must finish so snapshots, recap and remote completion
  // consumers still receive the accepted turn boundary.
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
  // The persist debounce timer is unref'd, so a quota update inside the
  // final debounce window before quit would otherwise never reach disk
  // (main.js before-quit calls this cleanup).
  accountQuota.flush();
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingState = null;
  pendingClaudeRecapStarts.clear();
  if (autoReturnTimer) clearTimeout(autoReturnTimer);
  clearAllCompletionDebounces();
  clearAllClaudeTranscriptCompletionProbes();
  if (eyeResendTimer) clearTimeout(eyeResendTimer);
  if (startupRecoveryTimer) clearTimeout(startupRecoveryTimer);
  stopWakePoll();
  for (const { timer } of kimiPermissionHolds.values()) {
    if (timer) clearTimeout(timer);
  }
  kimiPermissionHolds.clear();
  for (const { timer } of kimiPermissionSuspectTimers.values()) clearTimeout(timer);
  kimiPermissionSuspectTimers.clear();
  kimiPermissionGateLedgers.clear();
  for (const id of [...codexExitProbes.keys()]) clearCodexExitProbe(id);
  stopStaleCleanup();
}

return {
  setState, applyState, updateSession, recordRecapEventOnly, restoreSessionFromLease, resolveDisplayState, resolveVisualBinding, setUpdateVisualState,
  shouldDropForDnd,
  enableDoNotDisturb, disableDoNotDisturb,
  startStaleCleanup, stopStaleCleanup, startWakePoll, stopWakePoll,
  getSvgOverride, cleanStaleSessions, startStartupRecovery, refreshTheme,
  detectRunningAgentProcesses, buildSessionSnapshot,
  emitSessionSnapshot, broadcastSessionSnapshot, getLastSessionSnapshot,
  getActiveSessionAliasKeys,
  dismissSession,
  formatStdinDiag,
  updateSessionFocusMetadata,
  touchSessionActivity,
  updateSessionMetadata,
  clearClaudeStatuslineAuthority,
  updateAccountQuota,
  clearLocalClaudeQuota,
  commitLocalKimiQuota,
  clearLocalKimiQuota,
  getQuotaSourceCount,
  clearPermissionNotification,
  promoteCompletion,
  ackSessionCompletion,
  clearSessionsByAgent,
  disposeAllKimiPermissionState,
  deriveSessionBadge,
  getCurrentState, getCurrentSvg, getCurrentHitBox, resolveHitBoxForSvg, getStartupRecoveryActive,
  sessions, STATE_PRIORITY, ONESHOT_STATES, SLEEP_SEQUENCE,
  get STATE_SVGS() { return STATE_SVGS; },
  get HIT_BOXES() { return HIT_BOXES; },
  get FILE_HIT_BOXES() { return FILE_HIT_BOXES; },
  get WIDE_SVGS() { return WIDE_SVGS; },
  cleanup,
};

};
