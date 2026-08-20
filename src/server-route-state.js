"use strict";

const path = require("path");
const { resolveSessionIdentity } = require("./session-key");
const {
  assessSessionAutomationIdentity,
} = require("./session-automation-identity");
const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
  CLAWD_HOOK_PID_HEADER,
  CLAWD_LEGACY_PROCESS_CACHE_HEADER,
  CLAWD_PROCESS_INSTANCE_HEADER,
} = require("../hooks/server-config");
const { isCodexDesktopOriginator } = require("../hooks/codex-originator");
const {
  assessWindowsProcessChainRequest,
  buildShadowComparison,
  processMetadataForState,
} = require("./server-windows-process-metadata");
const {
  normalizeHookToolUseId,
  findPendingPermissionForStateEvent,
} = require("./server-permission-utils");
const {
  INTERACTION_INTENT,
  classifyPermissionInteraction,
  isDecisionInteraction,
} = require("./permission-automation-policy");
const {
  MAX_SUBAGENT_ID_LENGTH,
  MAX_SUBAGENT_TYPE_LENGTH,
  normalizeSubagentMetadata,
  resolveHookAgentId,
} = require("./server-agent-id");
const { resolveCodexOfficialHookState } = require("./server-codex-official-turns");
const { normalizeTranscriptPath } = require("./transcript-path");
const { normalizeQuotaGroup } = require("../hooks/quota-bucket");
const { ANTIGRAVITY_QUOTA_FIELDS } = require("../hooks/antigravity-context-usage");
const { CLAUDE_QUOTA_FIELDS } = require("../hooks/claude-rate-limits");
const { CODEX_QUOTA_FIELDS } = require("../hooks/codex-rate-limits");
const { extractPermissionToolInput } = require("../hooks/kimi-hook");
const { normalizeCodexUserInputWire } = require("../hooks/codex-user-input");
const { sanitizeShadowRecord } = require("./windows-process-chain-shadow-log");

const NATIVE_TERMINAL_ANSWER_OPTIONS = Object.freeze({
  disposition: Object.freeze({ reason: "handed_to_terminal", decided: true }),
});
const SESSION_ENDED_OPTIONS = Object.freeze({
  disposition: Object.freeze({ reason: "agent_gone", decided: false }),
});

// /state POST body size cap. Raised 1024 → 4096 → 16384: a CJK
// assistant_last_output (3 UTF-8 bytes/char) on a Stop completion blew past
// 4096, and the server's headerless 413 made the hook read posted=false, so the
// happy animation was silently dropped for Chinese/Japanese/Korean users. Hooks
// clamp that field by CHARACTER count while this caps by BYTE count — hooks now
// also byte-fit the body before POST (hooks/state-payload-size.js); this cap is
// the matching receive-side headroom. Still a local-only 127.0.0.1 endpoint —
// not an Internet DoS concern.
const MAX_STATE_BODY_BYTES = 16 * 1024;
const ASSISTANT_LAST_OUTPUT_MAX = 2400;
// Transport recognition and metadata acceptance are distinct wire facts.
// A recognized 204 may still mean "unknown session" or another designed
// metadata drop; only this header allows a metadata sender to advance its
// application-level dedup baseline.
const CLAWD_METADATA_ACCEPTED_HEADER = "X-Clawd-Metadata-Accepted";

function normalizeHwndString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!/^[1-9]\d{0,18}$/.test(text)) return null;
  try {
    return BigInt(text) <= 9223372036854775807n ? text : null;
  } catch {
    return null;
  }
}

function normalizeTmuxSocket(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 4096 || /[\0\r\n]/.test(text)) return null;
  if (text.startsWith("/")) return text;
  return text !== "default" && /^[\w.-]{1,64}$/.test(text) ? text : null;
}

function normalizeTmuxClient(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 256 || text.startsWith("-")) return null;
  return /^[\w./:-]+$/.test(text) ? text : null;
}

function normalizeOrcaPaneKey(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 256) return null;
  return /^[\w-]+:[\w-]+$/.test(text) ? text : null;
}

function normalizeAssistantLastOutput(value) {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (!text) return null;
  return text.length > ASSISTANT_LAST_OUTPUT_MAX
    ? text.slice(0, ASSISTANT_LAST_OUTPUT_MAX)
    : text;
}

function normalizeContextUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const used = Number(value.used);
  if (!Number.isFinite(used) || used < 0) return null;

  const out = { used };
  const limit = Number(value.limit);
  if (Number.isFinite(limit) && limit > 0) out.limit = limit;

  const percent = Number(value.percent);
  if (Number.isFinite(percent)) {
    out.percent = Math.max(0, Math.min(100, Math.round(percent)));
  } else if (out.limit) {
    out.percent = Math.max(0, Math.min(100, Math.round((used / out.limit) * 100)));
  }

  if (value.source === "claude" || value.source === "codex" || value.source === "antigravity" || value.source === "opencode") out.source = value.source;
  return out;
}

// Context-usage provenance for metadata_only POSTs (statusline / plugin
// quota path). Only sources whose posts are a live telemetry stream get an
// origin; everything else reports plain usage without provenance.
const OPENCODE_FAMILY_AGENT_IDS = new Set(["opencode", "mimocode"]);

function resolveMetadataContextUsageOrigin(agentId, contextUsage) {
  if (!contextUsage || typeof contextUsage !== "object") return null;
  if (agentId === "claude-code" && contextUsage.source === "claude") return "claude-statusline";
  if (OPENCODE_FAMILY_AGENT_IDS.has(agentId) && contextUsage.source === "opencode") return "opencode-statusline";
  return null;
}

// Context-usage provenance for real lifecycle state POSTs. Claude keeps the
// transcript origin (the state event itself is the delivery path); the
// opencode family plugin reports the same summary on its own channel, so the
// state-event usage carries the statusline origin like the metadata branch.
function resolveStateContextUsageOrigin(agentId, contextUsage) {
  if (!contextUsage || typeof contextUsage !== "object") return null;
  if (agentId === "claude-code" && contextUsage.source === "claude") return "claude-transcript";
  if (OPENCODE_FAMILY_AGENT_IDS.has(agentId) && contextUsage.source === "opencode") return "opencode-statusline";
  return null;
}

// Account-wide rate-limit quota. Re-validated here rather than trusted from
// the hook, matching normalizeContextUsage. Two independent sources - see
// hooks/antigravity-context-usage.js and hooks/claude-rate-limits.js.
function normalizeAntigravityQuota(value) {
  return normalizeQuotaGroup(value, ANTIGRAVITY_QUOTA_FIELDS);
}

function normalizeClaudeQuota(value) {
  return normalizeQuotaGroup(value, CLAUDE_QUOTA_FIELDS);
}

function normalizeCodexQuota(value) {
  return normalizeQuotaGroup(value, CODEX_QUOTA_FIELDS);
}

function sendStateHealthResponse(res, options) {
  const body = JSON.stringify({ ok: true, app: CLAWD_SERVER_ID, port: options.getHookServerPort() });
  res.writeHead(200, {
    "Content-Type": "application/json",
    [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
  });
  res.end(body);
}

function handleStatePost(req, res, options) {
  const {
    ctx,
    createRequestHookRecorder,
    shouldDropForDnd,
    codexOfficialTurns,
    dshStateSequenceFence = null,
    pathApi = path,
    // #627 residual: injectable so unit tests never load the real koffi FFI.
    // Defaults to the real host OS check / a probe that never samples.
    isWinHost = process.platform === "win32",
    captureForegroundWindowsTerminal = () => null,
    remoteProfile = null,
    isClaudeStatuslineMetadataAllowed = () => true,
    windowsProcessChainRuntime = null,
    resolveWindowsProcessMetadata = null,
    recordWindowsProcessChainShadow = null,
  } = options;
  let body = "";
  let bodySize = 0;
  let tooLarge = false;
  req.on("data", (chunk) => {
    if (tooLarge) return;
    bodySize += chunk.length;
    if (bodySize > MAX_STATE_BODY_BYTES) { tooLarge = true; return; }
    body += chunk;
  });
  req.on("end", () => {
    if (tooLarge) {
      res.writeHead(413);
      res.end("state payload too large");
      return;
    }
    try {
      const data = JSON.parse(body);
      const requestHeaders = req && req.headers && typeof req.headers === "object"
        ? req.headers
        : {};
      const agentIdentity = resolveHookAgentId(data, {
        customAgentIds: typeof ctx.getCustomAgentIds === "function" ? ctx.getCustomAgentIds() : [],
      });
      const recordRequestHookEvent = createRequestHookRecorder(agentIdentity, data, "state");
      if (agentIdentity.rejected) {
        recordRequestHookEvent.droppedInvalidAgent();
        res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
        res.end();
        return;
      }
      let { state, svg, session_id, event } = data;
      let display_svg;
      if (data.display_svg === null) display_svg = null;
      else if (typeof data.display_svg === "string") display_svg = pathApi.basename(data.display_svg);
      else display_svg = undefined;
      const source_pid = Number.isFinite(data.source_pid) && data.source_pid > 0 ? Math.floor(data.source_pid) : null;
      const wtHwnd = normalizeHwndString(data.wt_hwnd ?? data.wtHwnd);
      const cwd = typeof data.cwd === "string" ? data.cwd : "";
      const editor = (data.editor === "code" || data.editor === "cursor") ? data.editor : null;
      const pidChain = Array.isArray(data.pid_chain) ? data.pid_chain.filter(n => Number.isFinite(n) && n > 0) : null;
      const tmuxSocket = normalizeTmuxSocket(data.tmux_socket);
      const tmuxClient = normalizeTmuxClient(data.tmux_client);
      const orcaPaneKey = normalizeOrcaPaneKey(data.orca_pane_key);
      const rawAgentPid = data.agent_pid ?? data.claude_pid ?? data.cursor_pid;
      const agentPid = Number.isFinite(rawAgentPid) && rawAgentPid > 0 ? Math.floor(rawAgentPid) : null;
      const agentId = agentIdentity.agentId;
      const trustedProfileId = remoteProfile && typeof remoteProfile.profileId === "string"
        ? remoteProfile.profileId
        : "local";
      const sessionAutomationIdentity = assessSessionAutomationIdentity({
        agentId,
        channel: "state",
        event,
        // Preserve the actual wire value. The custom-agent namespace and the
        // resolveSessionIdentity fallback below must not manufacture evidence
        // of a stable session.
        rawSessionId: session_id,
        profileId: trustedProfileId,
        hookSource: data.hook_source,
        codexOriginator: data.codex_originator,
        codexSource: data.codex_source,
        agentPid,
      });
      const reportedSubagentId = agentId === "claude-code"
        ? normalizeSubagentMetadata(data.subagent_id, MAX_SUBAGENT_ID_LENGTH)
        : null;
      const reportedSubagentType = reportedSubagentId
        ? normalizeSubagentMetadata(data.subagent_type, MAX_SUBAGENT_TYPE_LENGTH)
        : null;
      const subagentId = agentIdentity.source === "subagent"
        ? agentIdentity.subagentId
        : reportedSubagentId;
      const subagentType = agentIdentity.source === "subagent"
        ? agentIdentity.subagentType
        : reportedSubagentType;
      // State sessions share one process-wide Map keyed only by session id.
      // Registered custom applications commonly send generic ids such as
      // "default" or "project-a", so namespace them at the trust boundary to
      // prevent two custom apps (or a custom app and a built-in agent) from
      // overwriting or ending each other's sessions.
      if (agentIdentity.source === "custom") {
        const rawCustomSessionId = typeof session_id === "string" && session_id.trim()
          ? session_id.trim()
          : "default";
        const customSessionPrefix = `${agentId}:`;
        session_id = rawCustomSessionId.startsWith(customSessionPrefix)
          ? rawCustomSessionId
          : `${customSessionPrefix}${rawCustomSessionId}`;
      }
      const sessionIdentity = resolveSessionIdentity(session_id, trustedProfileId, "default");
      session_id = sessionIdentity.sessionId;
      const host = remoteProfile && typeof remoteProfile.displayHost === "string"
        ? remoteProfile.displayHost
        : (typeof data.host === "string" ? data.host : null);
      const wslDistro = typeof data.wsl_distro === "string" && data.wsl_distro.trim()
        ? data.wsl_distro.trim()
        : null;
      const headless = data.headless === true;
      const platform = typeof data.platform === "string" && data.platform.trim()
        ? data.platform.trim()
        : null;
      const model = typeof data.model === "string" && data.model.trim()
        ? data.model.trim()
        : null;
      const provider = typeof data.provider === "string" && data.provider.trim()
        ? data.provider.trim()
        : null;
      const codexOriginator = typeof data.codex_originator === "string" && data.codex_originator.trim()
        ? data.codex_originator.trim()
        : null;
      const codexSource = typeof data.codex_source === "string" && data.codex_source.trim()
        ? data.codex_source.trim()
        : null;
      const ghosttyTerminalId = typeof data.ghostty_terminal_id === "string" && data.ghostty_terminal_id.trim()
        ? data.ghostty_terminal_id.trim()
        : null;
      const toolName = typeof data.tool_name === "string" && data.tool_name ? data.tool_name : null;
      const subagentLifecycleSource = (
        data.subagent_lifecycle_source === "native"
        || ["synthetic-tool", "synthetic-task"].includes(data.subagent_lifecycle_source)
        || data.subagent_lifecycle_source === "anonymous"
      ) ? data.subagent_lifecycle_source : null;
      const sessionStartSource = (
        data.session_start_source === "startup"
        || data.session_start_source === "resume"
        || data.session_start_source === "clear"
        || data.session_start_source === "compact"
      ) ? data.session_start_source : null;
      // #583: hook-reported stdin diagnostics, attached only when the hook's
      // stdin payload carried no session_id. Normalized here so state.js can
      // log it without trusting hook-side shapes.
      const stdinDiag = data.stdin_diag && typeof data.stdin_diag === "object"
        ? {
            bytes: Number.isFinite(data.stdin_diag.bytes) ? Math.max(0, Math.floor(data.stdin_diag.bytes)) : null,
            timedOut: data.stdin_diag.timed_out === true,
            durationMs: Number.isFinite(data.stdin_diag.duration_ms) ? Math.max(0, Math.floor(data.stdin_diag.duration_ms)) : null,
            parseError: typeof data.stdin_diag.parse_error === "string" && data.stdin_diag.parse_error
              ? data.stdin_diag.parse_error.slice(0, 120)
              : null,
          }
        : null;
      const toolUseId = normalizeHookToolUseId(
        data.tool_use_id ?? data.toolUseId ?? data.toolUseID
      );
      const toolInputFingerprint = typeof data.tool_input_fingerprint === "string" && data.tool_input_fingerprint
        ? data.tool_input_fingerprint
        : null;
      // Session title (Claude Code /rename or Codex turn_context.summary).
      // Non-string / empty values are silently dropped - matches the
      // "ignore + fall back" pattern used by cwd / agent_id above.
      const rawTitle = typeof data.session_title === "string" ? data.session_title.trim() : "";
      const sessionTitle = rawTitle || null;
      const contextUsage = normalizeContextUsage(data.context_usage);
      const antigravityQuota = normalizeAntigravityQuota(data.antigravity_quota);
      const claudeQuota = normalizeClaudeQuota(data.claude_quota);
      const codexQuota = normalizeCodexQuota(data.codex_quota);
      const codexSparkQuota = normalizeCodexQuota(data.codex_spark_quota);
      const assistantLastOutput = normalizeAssistantLastOutput(data.assistant_last_output);
      const assistantLastOutputTruncated = data.assistant_last_output_truncated === true;
      const transcriptPath = normalizeTranscriptPath(data.transcript_path);
      const permissionSuspect = data.permission_suspect === true;
      // #563: Kimi Code native PermissionRequest carries a human-readable
      // action ("Running: echo hi") and the real command; the passive bubble
      // shows them instead of the generic "check the terminal" line.
      const permissionAction = typeof data.permission_action === "string" && data.permission_action.trim()
        ? data.permission_action.trim().slice(0, 300)
        : null;
      const permissionCommand = typeof data.permission_command === "string" && data.permission_command.trim()
        ? data.permission_command.trim().slice(0, 500)
        : null;
      // Whitelisted tool_input subset from a Kimi Code native
      // PermissionRequest. Same validator the hook runs before POSTing —
      // re-run here at the trust boundary rather than trusted from the hook,
      // matching normalizeContextUsage.
      const permissionToolInput = extractPermissionToolInput(data.permission_tool_input);
      // Kimi legacy gate-ledger markers (batched-approvals fix). Booleans plus
      // a clamped opaque tool_call_id, re-validated at the trust boundary like
      // permission_suspect above — the hook's word alone is not enough.
      const permissionGateOpen = data.permission_gate_open === true;
      const permissionGated = data.permission_gated === true;
      const permissionGateId = typeof data.permission_gate_id === "string" && data.permission_gate_id.trim()
        ? data.permission_gate_id.trim().slice(0, 100)
        : null;
      const preserveState = data.preserve_state === true;
      const testResult = (
        (agentId === "claude-code" || agentId === "cursor-agent")
        && (event === "PostToolUse" || event === "PostToolUseFailure")
        && (data.test_result === "pass" || data.test_result === "fail")
      ) ? data.test_result : null;
      // Statusline refresh POSTs are metadata, not lifecycle (#590 B2): they
      // may only annotate an existing session with quota/context and must
      // never create one, touch recentEvents, or bump updatedAt. state.js
      // updateSessionMetadata owns those guarantees; this flag just routes
      // around the full updateSession lifecycle machine.
      const metadataOnly = data.metadata_only === true;
      const hookSource = typeof data.hook_source === "string" ? data.hook_source : null;
      // #406 completion-gate inputs from the Claude Stop hook. Counts / boolean
      // only — the hook never forwards task command or description text.
      const backgroundTasksCount = Number.isFinite(data.background_tasks_count)
        ? data.background_tasks_count : 0;
      const sessionCronsCount = Number.isFinite(data.session_crons_count)
        ? data.session_crons_count : 0;
      const stopHookActive = data.stop_hook_active === true;
      const codexUserInput = normalizeCodexUserInputWire(data.codex_user_input);
      // Agent gate: user disabled this agent in the settings panel. Drop
      // with 204 so hook scripts get a quick no-op response instead of
      // hanging on our HTTP connection. Still surfaces as a success code
      // so hook exit behavior is unchanged.
      if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled(agentId)) {
        recordRequestHookEvent.droppedByDisabled();
        res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
        res.end();
        return;
      }
      if (agentId === "deepseek-harness") {
        const sequenceResult = dshStateSequenceFence
          && typeof dshStateSequenceFence.accept === "function"
          ? dshStateSequenceFence.accept({
              // The fence is upstream-protocol scoped. Keep it on DSH's raw
              // canonical id; the local/remote profile key is a separate
              // Clawd storage concern applied by resolveSessionIdentity.
              sessionId: sessionIdentity.rawSessionId,
              event,
              eventSeq: data.event_seq,
              sessionSeq: data.session_seq,
            })
          : { accepted: false, reason: "sequence-fence-unavailable" };
        if (!sequenceResult.accepted) {
          recordRequestHookEvent.droppedUnsupported();
          res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
          res.end();
          return;
        }
      }
      // The persisted preference authorizes statusline telemetry only for the
      // local profile. Remote SSH profiles have their own deployed lifecycle
      // and must keep reporting even when this machine's local statusline is
      // disabled. A WSL session still belongs to profileId="local" — its
      // client-supplied host label must not bypass the local gate.
      const localClaudeStatuslineMetadataAllowed = agentId !== "claude-code"
        || trustedProfileId !== "local"
        || isClaudeStatuslineMetadataAllowed() === true;
      // Account quota goes to the session-independent per-source store,
      // regardless of POST shape — it must survive with no live session at
      // all ("check the remote's quota before starting work"), so it is
      // never gated on the session lookup that contextUsage annotation
      // performs. The source is the reporting host (null = this machine).
      // `host` is client-supplied and cannot be origin-verified (every
      // remote's reverse tunnel lands on the same local port) — same trust
      // model as the session cards' host grouping: machines the user
      // deployed Clawd hooks to. The store shape-sanitizes the label.
      const acceptedClaudeQuota = localClaudeStatuslineMetadataAllowed ? claudeQuota : null;
      if (typeof ctx.updateAccountQuota === "function"
        && (antigravityQuota || acceptedClaudeQuota || codexQuota || codexSparkQuota)) {
        const quotaSource = trustedProfileId === "local" ? host : `remote:${trustedProfileId}`;
        ctx.updateAccountQuota(quotaSource, {
          antigravityQuota,
          claudeQuota: acceptedClaudeQuota,
          codexQuota,
          ...(codexSparkQuota ? { codexSparkQuota } : {}),
          ...(trustedProfileId === "local" ? {} : { displayHost: host }),
        });
      }
      if (agentId === "codex" && codexUserInput) {
        const sid = session_id || "default";
        if (codexUserInput.phase === "resolved") {
          if (typeof ctx.clearCodexUserInputBubbles === "function") {
            ctx.clearCodexUserInputBubbles(sid, codexUserInput.callId, "codex-user-input-resolved");
          }
          res.writeHead(200, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
          res.end("ok");
          return;
        }
        if (headless || shouldDropForDnd()) {
          recordRequestHookEvent.droppedByDnd();
          res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
          res.end();
          return;
        }
        const shown = typeof ctx.showCodexUserInputBubble === "function"
          && ctx.showCodexUserInputBubble({
            sessionId: sid,
            callId: codexUserInput.callId,
            questions: codexUserInput.questions,
            autoResolutionMs: codexUserInput.autoResolutionMs,
            sourcePid: source_pid,
            agentPid,
            cwd,
            host,
            codexOriginator,
            codexSource,
          });
        if (!shown) {
          res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
          res.end();
          return;
        }
        state = "notification";
        event = "CodexUserInputRequest";
      }
      if (metadataOnly) {
        // Deliberately NOT recorded in the recent-hook-events ring: a
        // statusline refreshing every few hundred ms would evict the real
        // hook events the diagnostics exist to show. 204 either way — legacy
        // statusline scripts ignore the response, while delivery-aware
        // plugins use CLAWD_METADATA_ACCEPTED_HEADER to distinguish a live
        // accepted session from the designed "session unknown" drop.
        let metadataAccepted = false;
        if (typeof ctx.updateSessionMetadata === "function") {
          const metaUpdate = {};
          if (
            contextUsage
            && localClaudeStatuslineMetadataAllowed
          ) {
            metaUpdate.contextUsage = contextUsage;
            metaUpdate.contextUsageOrigin = resolveMetadataContextUsageOrigin(agentId, contextUsage);
          }
          // OpenCode title changes ride the same metadata-only channel (the
          // placeholder → real title swap arrives on session.updated, which
          // maps to no Clawd state). Not gated on the Claude telemetry flag —
          // it's not Claude statusline data.
          if (sessionTitle) metaUpdate.sessionTitle = sessionTitle;
          if (Object.keys(metaUpdate).length > 0) {
            metadataAccepted = ctx.updateSessionMetadata(session_id || "default", metaUpdate) === true;
          }
        }
        res.writeHead(204, {
          [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
          ...(metadataAccepted ? { [CLAWD_METADATA_ACCEPTED_HEADER]: "1" } : {}),
        });
        res.end();
        return;
      }
      if (ctx.STATE_SVGS[state]) {
        const sid = session_id || "default";
        const codexHookState = resolveCodexOfficialHookState(
          data,
          state,
          codexOfficialTurns,
          ctx.codexSubagentClassifier,
          sid,
        );
        if (codexHookState.drop) {
          res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
          res.end();
          return;
        }
        state = codexHookState.state;
        if (state.startsWith("mini-") && !svg) {
          res.writeHead(400);
          res.end("mini states require svg override");
          return;
        }
        // #627 residual: UserPromptSubmit no longer carries a fresh wt_hwnd
        // from the hook (cache-only prompt path, hooks/clawd-hook.js) — sample
        // the foreground Windows Terminal window synchronously here instead
        // (koffi FFI inside the already-running Electron process, never a
        // subprocess, so it cannot reproduce the console flash #627 was
        // about). Priority: incoming hook wt_hwnd (older hook versions, or a
        // pre-#627-residual sample) > this sample > existing session's last
        // value (state.js:1431 MERGE, handled automatically by passing null
        // through when we have nothing new).
        //
        // Placed AFTER resolveCodexOfficialHookState on purpose: a codex
        // subagent prompt is classified headless THERE, and that verdict must
        // join the effective metadata below — otherwise a first-seen subagent
        // prompt arriving without a hook wt_hwnd could sample the local
        // foreground WT before anything knows the session is headless
        // (matters most once PR2/#634 makes the codex hook cache-only too).
        // Dropped/invalid requests above never reach the probe at all.
        //
        // The eligibility check below MUST use "effective" metadata —
        // incoming body fields merged with the existing session's known
        // fields — not just the incoming body: a cache-miss prompt
        // deliberately omits process metadata (host/wslDistro/platform/
        // headless/sourcePid), and judging eligibility on the bare incoming
        // body would misjudge an already-known headless/remote session as
        // interactive and sample a Windows Terminal window that has nothing
        // to do with it. See docs/plans/plan-issue-627-residual-userprompt-flash.md §4.2.
        const existingSession = ctx.sessions && typeof ctx.sessions.get === "function"
          ? ctx.sessions.get(sid)
          : null;
        const effHost = host || (existingSession && existingSession.host) || null;
        const effWslDistro = wslDistro || (existingSession && existingSession.wslDistro) || null;
        const effPlatform = platform || (existingSession && existingSession.platform) || null;
        const effHeadless = headless === true
          || codexHookState.headless === true
          || (existingSession && existingSession.headless) === true;
        const processChainAssessment = codexUserInput
          ? { eligible: false, reason: "codex-user-input-outside-b1a", mode: "legacy", hookPid: null }
          : assessWindowsProcessChainRequest({
              agentId,
              runtime: windowsProcessChainRuntime,
              isWinHost,
              remoteProfile,
              effectiveHost: effHost,
              effectiveWslDistro: effWslDistro,
              effectivePlatform: effPlatform,
              effectiveHeadless: effHeadless,
              hookPidHeader: requestHeaders[CLAWD_HOOK_PID_HEADER.toLowerCase()],
              instanceGeneration: requestHeaders[CLAWD_PROCESS_INSTANCE_HEADER.toLowerCase()],
            });
        let processChainResult = null;
        if (processChainAssessment.eligible && typeof resolveWindowsProcessMetadata === "function") {
          try {
            processChainResult = resolveWindowsProcessMetadata({
              agentId,
              hookPid: processChainAssessment.hookPid,
              preferAgentPid: agentId === "codex" && isCodexDesktopOriginator(codexOriginator),
            });
          } catch {
            processChainResult = {
              status: "unavailable",
              reason: "resolver-threw",
              sourcePid: null,
              agentPid: null,
              pidChain: null,
              editor: null,
            };
          }
        }
        const legacyProcessMetadata = {
          sourcePid: source_pid,
          agentPid,
          pidChain,
          editor,
        };
        const authoritativeProcessMetadata = processMetadataForState(processChainResult);
        if (
          processChainAssessment.mode === "b1a-authoritative"
          && agentId === "cursor-agent"
          && !authoritativeProcessMetadata.editor
        ) {
          // Cursor's editor label is an adapter-owned constant, not ancestry
          // output. Preserve it even when the authoritative walk fails.
          authoritativeProcessMetadata.editor = "cursor";
        }
        const replaceProcessMetadata = processChainAssessment.eligible
          && processChainAssessment.mode === "b1a-authoritative";
        const effectiveProcessMetadata = replaceProcessMetadata
          ? authoritativeProcessMetadata
          : legacyProcessMetadata;
        if (processChainAssessment.eligible && processChainAssessment.mode === "shadow") {
          const shadowRecord = {
            channel: "state",
            agentId,
            event,
            status: processChainResult && processChainResult.status || "unavailable",
            reason: processChainResult && processChainResult.reason || "resolver-unavailable",
            comparisonClass: processChainResult && processChainResult.comparisonClass || null,
            agentSeenBeforeFailure: processChainResult && processChainResult.agentSeenBeforeFailure === true,
            failureStage: processChainResult && processChainResult.failureStage || null,
            errorKind: processChainResult && processChainResult.errorKind || null,
            depth: processChainResult && processChainResult.depth || 0,
            durationMs: processChainResult && processChainResult.durationMs || 0,
            cacheSource: requestHeaders[CLAWD_LEGACY_PROCESS_CACHE_HEADER.toLowerCase()] || null,
            rawEditor: processChainResult && processChainResult.rawEditor || null,
            effectiveEditor: authoritativeProcessMetadata.editor,
            legacyMetadata: legacyProcessMetadata,
            candidateMetadata: authoritativeProcessMetadata,
            comparison: buildShadowComparison(legacyProcessMetadata, processChainResult),
          };
          if (typeof recordWindowsProcessChainShadow === "function") {
            try { recordWindowsProcessChainShadow(shadowRecord); } catch {}
          } else if (typeof ctx.debugLog === "function") {
            const safeShadowRecord = sanitizeShadowRecord(shadowRecord);
            if (safeShadowRecord) ctx.debugLog(`win-chain-shadow ${JSON.stringify(safeShadowRecord)}`);
          }
        }
        const effSourcePid = effectiveProcessMetadata.sourcePid
          || (!replaceProcessMetadata && existingSession && existingSession.sourcePid)
          || null;
        // effectiveSourcePid gate: the focus entry point is a hard sourcePid
        // requirement (src/session-focus.js:41, src/main.js:1668) — sampling
        // for a session nobody can focus yet risks mis-attributing whatever
        // WT window the user happens to have foreground to a headless/unknown
        // session. A cache HIT (server already knows sourcePid) still samples
        // normally; only a miss on a completely unknown session skips.
        let sampledWtHwnd = null;
        const authoritativeCodexSessionStart = replaceProcessMetadata
          && agentId === "codex"
          && event === "SessionStart";
        const trustedIncomingWtHwnd = replaceProcessMetadata ? null : wtHwnd;
        const wtHwndSamplingEligible = !trustedIncomingWtHwnd
          && (event === "UserPromptSubmit" || authoritativeCodexSessionStart)
          && isWinHost
          && !effHost
          && !effWslDistro
          && effPlatform !== "webui"
          && !effHeadless
          && !!effSourcePid;
        if (wtHwndSamplingEligible) {
          try { sampledWtHwnd = captureForegroundWindowsTerminal(); } catch { sampledWtHwnd = null; }
        }
        // Shadow SessionStart comparison intentionally bypasses the legacy
        // `!wtHwnd` gate: the point is to compare a server-side sample with
        // the hook-provided HWND. A foreground change between the two sample
        // times is diagnostic, not a strict parity failure.
        if (
          processChainAssessment.eligible
          && processChainAssessment.mode === "shadow"
          && agentId === "codex"
          && event === "SessionStart"
          && isWinHost
          && !effHost
          && !effWslDistro
          && effPlatform !== "webui"
          && !effHeadless
          && !!effSourcePid
        ) {
          let shadowWtHwnd = null;
          try { shadowWtHwnd = captureForegroundWindowsTerminal(); } catch { shadowWtHwnd = null; }
          const hwndShadowRecord = {
            channel: "state",
            agentId,
            event,
            kind: "wt-hwnd",
            hookPresent: !!wtHwnd,
            serverPresent: !!shadowWtHwnd,
            equal: !!wtHwnd && !!shadowWtHwnd && wtHwnd === shadowWtHwnd,
            timingSensitive: true,
          };
          if (typeof recordWindowsProcessChainShadow === "function") {
            try { recordWindowsProcessChainShadow(hwndShadowRecord); } catch {}
          } else if (typeof ctx.debugLog === "function") {
            ctx.debugLog(`win-chain-shadow ${JSON.stringify(hwndShadowRecord)}`);
          }
        }
        // Failure/ineligibility red line: never anything but null here — no
        // hook-side PowerShell fallback is ever triggered by this route.
        const effectiveWtHwnd = trustedIncomingWtHwnd || sampledWtHwnd || null;
        const wtHwndSource = trustedIncomingWtHwnd
          ? "hook"
          : (sampledWtHwnd
            ? "server"
            : ((existingSession && existingSession.wtHwnd) ? "previous" : "none"));
        // Provenance is only meaningful where sampling can happen; logging it
        // on every PreToolUse/PostToolUse would flood session-debug.log
        // (sessionLog is unconditionally enabled once the app is ready).
        if (event === "UserPromptSubmit" && typeof ctx.debugLog === "function") {
          ctx.debugLog(`wt-hwnd sid=${sid} event=${event} source=${wtHwndSource}`);
        }
        const stateEventInteraction = classifyPermissionInteraction({
          agentId,
          toolName,
        });
        const pendingForSessionAgent = () => ctx.pendingPermissions.filter((perm) => (
          perm
          && perm.res
          && perm.sessionId === sid
          && perm.agentId === agentId
        ));
        const pendingForSource = () => pendingForSessionAgent().filter(
          (perm) => (perm.subagentId || null) === subagentId
        );
        const resolveOnlyUnambiguous = (candidates, behavior, message) => {
          if (candidates.length !== 1) {
            if (candidates.length > 1 && typeof ctx.permLog === "function") {
              ctx.permLog(
                `decision sweep ambiguous: event=${event} session=${sid} agent=${agentId}`
                + ` subagent=${subagentId || "main"} candidates=${candidates.length}`
              );
            }
            return;
          }
          ctx.resolvePermissionEntry(
            candidates[0],
            behavior,
            message,
            NATIVE_TERMINAL_ANSWER_OPTIONS
          );
        };
        if (event === "PostToolUse" || event === "PostToolUseFailure" || event === "Stop") {
          const perm = findPendingPermissionForStateEvent(ctx.pendingPermissions, {
            sessionId: sid,
            agentId,
            subagentId,
            toolName,
            toolUseId,
            toolInputFingerprint,
            allowSingletonFallback: event === "Stop",
          });
          if (perm) {
            const behavior = perm.isQwenCode ? "no-decision" : "deny";
            ctx.resolvePermissionEntry(
              perm,
              behavior,
              "User answered in terminal",
              NATIVE_TERMINAL_ANSWER_OPTIONS
            );
          }
          // A later hook event may be the only evidence that the user answered
          // a decision in the agent's native terminal UI. Never sweep across
          // agent/subagent sources, and never guess when more than one decision
          // remains for the same canonical source.
          // An exact match already identifies which decision completed. Do
          // not infer that a sibling decision from the same session/subagent
          // also completed — concurrent questions can legitimately coexist.
          if (!perm || !isDecisionInteraction(perm.interaction)) {
            const staleDecisions = pendingForSource().filter((stale) => (
              stale !== perm && isDecisionInteraction(stale.interaction)
            ));
            resolveOnlyUnambiguous(
              staleDecisions,
              "deny",
              "User answered in terminal"
            );
          }
        }
        // Decision lifecycle for events outside the PostToolUse/Stop block:
        // UserPromptSubmit = user typed feedback in plan TUI ("Tell Claude what to
        // change"); PreToolUse(non-ExitPlanMode) = Claude started executing after
        // plan approval. SessionEnd is authoritative and clears both plan and
        // human-question entries without inventing a user decision.
        if (event === "SessionEnd") {
          // A main-thread SessionEnd is authoritative for the whole agent
          // session and must clear requests from every subagent. A SessionEnd
          // emitted by a subagent only closes that subagent's own requests; its
          // siblings and parent session can still be live.
          const sessionEndPending = subagentId
            ? pendingForSource()
            : pendingForSessionAgent();
          for (const stale of sessionEndPending.filter((entry) => (
            isDecisionInteraction(entry.interaction)
          ))) {
            ctx.resolvePermissionEntry(
              stale,
              "no-decision",
              "Session ended",
              SESSION_ENDED_OPTIONS
            );
          }
        } else if (
          event === "UserPromptSubmit"
          || (
            event === "PreToolUse"
            && stateEventInteraction.intent !== INTERACTION_INTENT.PLAN_REVIEW
          )
        ) {
          const stalePlans = pendingForSource().filter((entry) => (
            entry.interaction
            && entry.interaction.intent === INTERACTION_INTENT.PLAN_REVIEW
          ));
          resolveOnlyUnambiguous(
            stalePlans,
            "deny",
            "Plan dialog dismissed in terminal"
          );
        }
        recordRequestHookEvent.acceptedUnlessDnd(shouldDropForDnd());
        if (svg) {
          const safeSvg = pathApi.basename(svg);
          ctx.setState(state, safeSvg);
        } else {
          ctx.updateSession(sid, state, event, {
            sourcePid: effectiveProcessMetadata.sourcePid,
            wtHwnd: effectiveWtHwnd,
            cwd,
            editor: effectiveProcessMetadata.editor,
            pidChain: effectiveProcessMetadata.pidChain,
            tmuxSocket,
            tmuxClient,
            orcaPaneKey,
            agentPid: effectiveProcessMetadata.agentPid,
            agentId,
            ...(subagentId ? { subagentId } : {}),
            ...(subagentType ? { subagentType } : {}),
            ...(subagentLifecycleSource ? { subagentLifecycleSource } : {}),
            ...(sessionStartSource ? { sessionStartSource } : {}),
            profileId: sessionIdentity.profileId,
            rawSessionId: sessionIdentity.rawSessionId,
            host,
            wslDistro,
            headless: headless || codexHookState.headless === true,
            platform,
            model,
            provider,
            codexOriginator,
            codexSource,
            ghosttyTerminalId,
            displayHint: display_svg,
            sessionTitle,
            contextUsage,
            contextUsageOrigin: resolveStateContextUsageOrigin(agentId, contextUsage),
            assistantLastOutput,
            assistantLastOutputTruncated,
            toolName,
            transcriptPath,
            permissionSuspect,
            permissionAction,
            permissionCommand,
            permissionToolInput,
            permissionGateOpen,
            permissionGated,
            permissionGateId,
            preserveState,
            hookSource,
            ...(codexHookState.turnId ? { turnId: codexHookState.turnId } : {}),
            backgroundTasksCount,
            sessionCronsCount,
            stopHookActive,
            stdinDiag,
            sessionAutomationIdentity,
            ...(codexUserInput ? { transientPermissionEvent: true } : {}),
            ...(agentIdentity.defaulted ? { agentIdDefaulted: true } : {}),
            ...(replaceProcessMetadata ? { replaceProcessMetadata: true } : {}),
          });
        }
        // Decorative only: the lifecycle update above remains authoritative.
        // Main owns the opt-in / DND / visibility / mini / drag gate; a visual
        // failure must never turn a valid hook state POST into a 400.
        if (testResult && typeof ctx.handleTestResult === "function") {
          try {
            ctx.handleTestResult(testResult, {
              sessionId: sid,
              agentId,
              event,
              headless: effHeadless,
            });
          } catch {}
        }
        res.writeHead(200, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
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
}

module.exports = {
  MAX_STATE_BODY_BYTES,
  CLAWD_METADATA_ACCEPTED_HEADER,
  sendStateHealthResponse,
  handleStatePost,
};
