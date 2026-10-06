#!/usr/bin/env node
// Clawd — Reasonix state-only hook.
// Registered in <Reasonix home>/settings.json by hooks/reasonix-install.js
//
// All events: POST /state, fire-and-forget, exit immediately.
// Reasonix owns its own permission flow natively (Gate + terminal prompt);
// Clawd only observes state for the desktop pet animation.

// Start the in-process budget before loading helper modules. Reasonix measures
// its outer timeout from the PowerShell/cmd wrapper, which starts even earlier;
// the blocking deadline below deliberately leaves another second for that
// unobservable launch overhead.
const HOOK_STARTED_AT = Date.now();

const {
  postStateToRunningServer,
  readHostPrefix,
  applyWslSourceFields,
  readWindowsProcessChainHookContext,
} = require("./server-config");
const {
  createPidResolver,
  readStdinJsonDetailed,
  getPlatformConfig,
  applyOrcaPaneKey,
  processAlive,
} = require("./shared-process");

const EVENT_TO_STATE = {
  SessionStart: "idle",
  SessionEnd: "sleeping",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "working",
  Stop: "attention",
  SubagentStop: "working",
  Notification: "notification",
  PreCompact: "sweeping",
};

// #634: lifecycle for the shared resolver's cross-process pid cache. Stop is
// deliberately NOT "end" (turn completion; Reasonix even delays its Stop POST).
const EVENT_TO_LIFECYCLE = {
  SessionStart: "start",
  UserPromptSubmit: "prompt",
  SessionEnd: "end",
};

const config = getPlatformConfig();
let runtimeContext = Object.freeze({
  identity: { ok: false, reason: "not-observed", port: null, ownerPid: null },
  observation: null,
});
const resolve = createPidResolver({
  agentNames: {
    win: new Set(["reasonix.exe", "reasonix-desktop.exe", "reasonix-cli.exe"]),
    mac: new Set(["reasonix", "reasonix-desktop"]),
    // reasonix-deskto: Linux comm is truncated to TASK_COMM_LEN(16)-1 = 15
    // chars, so ps/pgrep never see the full "reasonix-desktop".
    linux: new Set(["reasonix", "reasonix-desktop", "reasonix-deskto"]),
  },
  platformConfig: config,
  readRuntimeIdentity: () => runtimeContext.identity,
});

function normalizeReasonixSessionId(value) {
  const raw = value != null && value !== "" ? String(value) : "default";
  return raw.startsWith("reasonix:") ? raw : `reasonix:${raw}`;
}

function readRawReasonixSessionId(payload) {
  if (!payload || typeof payload !== "object") return "";
  // Keep the legacy snake_case input working, but prefer Reasonix's official
  // native `sessionId` contract whenever the legacy field is absent/empty.
  for (const value of [payload.session_id, payload.sessionId]) {
    if (value != null && value !== "") return String(value);
  }
  return "";
}

// Reasonix fires PostToolUse and Stop in quick succession when a turn ends.
// Both spawn separate hook processes — if Stop's POST arrives at the server
// before PostToolUse's, the state ends up as "working" instead of "attention".
// A short delay on Stop lets PostToolUse's POST land first.
const STOP_DELAY_MS = 200;

// Reasonix (Go CLI / Wails desktop) can take longer than the shared 400ms
// default to flush the hook payload to stdin after a long idle period (Go
// scheduler warm-up + child-process pipe setup on first event). Use a wider
// 2000ms read window so the first post-idle event actually arrives.
const STDIN_READ_TIMEOUT_MS = 2000;

// Safety timeout: guarantee the hook exits even if stdin never arrives.
// Phased, deadline-based budgets instead of one blanket 800ms — the single
// budget fired while a cold machine was still legitimately working (post-idle
// stdin flush + cold WMI snapshot inside resolve()), and safeExit(0)
// swallowed the event BEFORE the POST with a clean exit 0: no error anywhere,
// the pet just looked "disconnected" after every long idle.
// Blocking hooks (UserPromptSubmit/PreToolUse) get a 5s budget from Reasonix
// and a timeout becomes a DecisionBlock that ABORTS the user's turn, so the
// internal deadline leaves a full second for the cmd/PowerShell + Node startup
// that happens before this script can observe time. Blocking events also never
// perform a fresh synchronous process walk (see the local PID branch below),
// so a cold WMI/ps call cannot pin the event loop past this guard. Non-blocking
// events (upstream budget 30s) use a relaxed deadline instead.
const HARD_DEADLINE_MS = 4000;
const RELAXED_DEADLINE_MS = 15000;
const STDIN_PHASE_BUDGET_MS = STDIN_READ_TIMEOUT_MS + 500;
const POST_STDIN_BUDGET_MS = 3500;
const STOP_EXTRA_MS = STOP_DELAY_MS + 200;
const BLOCKING_HOOKS = new Set(["UserPromptSubmit", "PreToolUse"]);
let _exited = false;
let safetyTimer = null;

function armSafety(ms, deadlineMs = HARD_DEADLINE_MS) {
  if (safetyTimer) clearTimeout(safetyTimer);
  const remaining = deadlineMs - (Date.now() - HOOK_STARTED_AT);
  safetyTimer = setTimeout(() => safeExit(0), Math.max(1, Math.min(ms, remaining)));
}

function safeExit(code) {
  if (_exited) return;
  _exited = true;
  if (safetyTimer) clearTimeout(safetyTimer);
  // Reasonix consumes stdout as text for PreCompact/PostLLMCall hooks; this
  // state-only observer must stay silent and rely on exit code 0 as pass.
  process.exit(code);
}

armSafety(STDIN_PHASE_BUDGET_MS);

readStdinJsonDetailed({ timeoutMs: STDIN_READ_TIMEOUT_MS })
  .then((result) => {
    const payload = result.payload;
    const hookName = (payload && typeof payload.event === "string" && payload.event) || "";
    const isBlockingHook = BLOCKING_HOOKS.has(hookName);

    // stdin settled (payload or read timeout) — re-arm for resolve() + POST.
    // Stop is non-blocking (30s upstream) and gets the relaxed deadline plus
    // its ordering-delay allowance.
    const isStop = hookName === "Stop";
    armSafety(
      isStop ? POST_STDIN_BUDGET_MS + STOP_EXTRA_MS : POST_STDIN_BUDGET_MS,
      isBlockingHook ? HARD_DEADLINE_MS : RELAXED_DEADLINE_MS
    );

    const mapped = EVENT_TO_STATE[hookName];
    if (!mapped) {
      safeExit(0);
      return;
    }

    const remote = !!process.env.CLAWD_REMOTE;
    const host = remote ? readHostPrefix() : undefined;
    if (!remote && process.platform === "win32") {
      runtimeContext = readWindowsProcessChainHookContext("reasonix");
    }
    const runtimeObservation = runtimeContext.observation;
    const serverProcessChainEnabled = !!(
      !remote
      && process.platform === "win32"
      && runtimeObservation
      && runtimeObservation.agentMode !== "legacy"
      && processAlive(runtimeObservation.ownerPid)
    );
    const authoritativeProcessChain = serverProcessChainEnabled
      && runtimeObservation.agentMode === "b1a-authoritative";

    if (hookName === "SessionStart" && !remote && !authoritativeProcessChain) resolve();

    const rawSessionId = readRawReasonixSessionId(payload);
    const body = {
      state: mapped,
      session_id: normalizeReasonixSessionId(rawSessionId),
      event: hookName,
      agent_id: "reasonix",
    };

    if (payload && typeof payload.cwd === "string" && payload.cwd) body.cwd = payload.cwd;

    if (hookName === "PreToolUse" || hookName === "PostToolUse") {
      const toolName = payload && typeof payload.toolName === "string" ? payload.toolName : null;
      if (toolName) body.tool_name = toolName;
    }

    let legacyCacheSource = "none";
    if (remote) {
      body.host = host;
      applyWslSourceFields(body, { remote: true });
      applyOrcaPaneKey(body);
    } else {
      applyWslSourceFields(body);
      // Reasonix aborts UserPromptSubmit/PreToolUse when a hook exceeds its 5s
      // outer budget. A JS timer cannot interrupt createPidResolver's sync WMI
      // or ps walk, so blocking events must never take a fresh snapshot:
      //   - Windows uses the resolver's cache-only `prompt` lifecycle. A live
      //     v2 entry still restores PID/editor metadata without spawning.
      //   - macOS/Linux have no cross-process PID cache; even `prompt` resolves
      //     fresh there, so skip the resolver entirely.
      // SessionStart, PostToolUse and Stop are non-blocking and still populate
      // or repair metadata. src/state.js keeps existing PID fields when a
      // blocking body omits them, so this safety rule never erases a good PID.
      let pidMetadata = {};
      if (!authoritativeProcessChain && (!isBlockingHook || process.platform === "win32")) {
        pidMetadata = resolve({
          namespace: "reasonix",
          sessionId: body.session_id,
          cacheCwd: body.cwd || "",
          lifecycle: isBlockingHook ? "prompt" : (EVENT_TO_LIFECYCLE[hookName] || "event"),
          // Cacheability keys off the raw ID. The normalized fallback would
          // otherwise make unrelated missing/default sessions share one file.
          cacheable: !!rawSessionId && rawSessionId !== "default" && !!body.cwd,
        });
      }
      legacyCacheSource = pidMetadata.cacheSource || "none";
      const { stablePid, agentPid, detectedEditor, pidChain } = pidMetadata;
      if (Number.isFinite(stablePid) && stablePid > 0) body.source_pid = Math.floor(stablePid);
      if (detectedEditor) body.editor = detectedEditor;
      if (Number.isFinite(agentPid) && agentPid > 0) body.agent_pid = Math.floor(agentPid);
      if (Array.isArray(pidChain) && pidChain.length) body.pid_chain = pidChain;
      applyOrcaPaneKey(body);
    }

    // For Stop: delay the POST so PostToolUse's POST arrives at the server first
    const postFn = () => {
      const postOptions = { timeoutMs: 100 };
      if (serverProcessChainEnabled) {
        postOptions.preferredPort = runtimeObservation.port;
        postOptions.runtimePort = runtimeObservation.port;
        postOptions.windowsProcessChain = {
          agentId: "reasonix",
          hookPid: process.pid,
          runtimeObservation,
          legacyCacheSource,
        };
      }
      postStateToRunningServer(JSON.stringify(body), postOptions, () => {
        safeExit(0);
      });
    };

    if (hookName === "Stop") {
      setTimeout(postFn, STOP_DELAY_MS);
    } else {
      postFn();
    }
  })
  .catch(() => safeExit(0));
