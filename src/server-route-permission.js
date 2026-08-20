"use strict";

const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
  CLAWD_HOOK_PID_HEADER,
  CLAWD_LEGACY_PROCESS_CACHE_HEADER,
  CLAWD_PROCESS_INSTANCE_HEADER,
} = require("../hooks/server-config");
const {
  assessWindowsProcessChainRequest,
  buildShadowComparison,
  processMetadataForState,
} = require("./server-windows-process-metadata");
const {
  CODEX_OFFICIAL_HOOK_SOURCE,
  CODEX_SESSION_ROLE_SUBAGENT,
} = require("./server-codex-official-turns");
const {
  isCodexCliOriginator,
  isCodexDesktopOriginator,
} = require("../hooks/codex-originator");
const {
  truncateDeep,
  normalizePermissionSuggestions,
  prepareElicitationToolInput,
  normalizeHookToolUseId,
  normalizeCodexPermissionToolInput,
  buildToolInputFingerprint,
} = require("./server-permission-utils");
const { resolveHookAgentId } = require("./server-agent-id");
const { getAgent } = require("../agents/registry");
const { isOpencodeFamily } = require("../agents/opencode-family");
const { resolveSessionIdentity } = require("./session-key");
const {
  assessSessionAutomationIdentity,
} = require("./session-automation-identity");
const {
  INTERACTION_INTENT,
  classifyPermissionInteraction,
  isDecisionInteraction,
} = require("./permission-automation-policy");
const { sanitizeShadowRecord } = require("./windows-process-chain-shadow-log");

const MAX_PERMISSION_BODY_BYTES = 524288;
const CLIENT_DISCONNECTED_OPTIONS = Object.freeze({
  disposition: Object.freeze({ reason: "agent_gone", decided: false }),
});

// ExitPlanMode (Plan Review) and AskUserQuestion (elicitation) happen to
// travel through /permission, but they're UX flows — not approvals the
// sub-gate is named for. Silencing them would break plan-mode and leave
// CC hanging on an elicitation.
//
// The aggregate/split permission bubble gates are also honored here:
// dropping the HTTP connection lets CC/codebuddy fall back to their terminal
// chat prompt. The previous behavior merely skipped showPermissionBubble,
// leaving the request parked in pendingPermissions — CC would then hang for
// 600s before timing out with nothing in the terminal.
function shouldBypassCCBubble(ctx, interaction, agentId) {
  if (isDecisionInteraction(interaction)) return false;
  if (!arePermissionBubblesEnabled(ctx)) return true;
  if (typeof ctx.isAgentPermissionsEnabled !== "function") return false;
  return !ctx.isAgentPermissionsEnabled(agentId);
}

// #451: PermissionRequests fired from inside a Claude Code subagent (Task
// tool) carry agent_id/agent_type in the common hook fields; resolveHookAgentId
// surfaces that as source:"subagent". When the per-agent subagent sub-gate is
// off, dropping the HTTP connection lets CC fall back to its native flow
// (terminal chat prompt, or the background-subagent auto-deny) exactly as if
// Clawd weren't installed — never answer allow/deny on the user's behalf.
// ExitPlanMode / AskUserQuestion stay exempt for the same reason they're
// exempt from shouldBypassCCBubble above.
function shouldBypassCCSubagentBubble(ctx, interaction, agentId, hookIdentity) {
  if (!hookIdentity || hookIdentity.source !== "subagent") return false;
  if (isDecisionInteraction(interaction)) return false;
  if (typeof ctx.isAgentSubagentPermissionsEnabled !== "function") return false;
  return !ctx.isAgentSubagentPermissionsEnabled(agentId);
}

function shouldBypassFamilyBubble(ctx, agentId) {
  if (typeof ctx.isAgentPermissionsEnabled !== "function") return false;
  // Sub-gates stay per-agent: the registry parameterizes the check, it does
  // not merge the user-facing switches (plan §3.5).
  return !ctx.isAgentPermissionsEnabled(agentId);
}

function shouldBypassCodexBubble(ctx) {
  if (!arePermissionBubblesEnabled(ctx)) return true;
  if (typeof ctx.isAgentPermissionsEnabled !== "function") return false;
  return !ctx.isAgentPermissionsEnabled("codex");
}

function shouldBypassQwenCodeBubble(ctx) {
  if (!arePermissionBubblesEnabled(ctx)) return true;
  if (typeof ctx.isAgentPermissionsEnabled !== "function") return false;
  return !ctx.isAgentPermissionsEnabled("qwen-code");
}

function shouldBypassCopilotBubble(ctx) {
  if (!arePermissionBubblesEnabled(ctx)) return true;
  if (typeof ctx.isAgentPermissionsEnabled !== "function") return false;
  return !ctx.isAgentPermissionsEnabled("copilot-cli");
}

function shouldBypassHermesBubble(ctx) {
  if (!arePermissionBubblesEnabled(ctx)) return true;
  if (typeof ctx.isAgentPermissionsEnabled !== "function") return false;
  return !ctx.isAgentPermissionsEnabled("hermes");
}

function shouldBypassDshBubble(ctx) {
  if (!arePermissionBubblesEnabled(ctx)) return true;
  if (typeof ctx.isAgentPermissionsEnabled !== "function") return false;
  return !ctx.isAgentPermissionsEnabled("deepseek-harness");
}

function shouldInterceptCodexPermission(ctx) {
  if (typeof ctx.isCodexPermissionInterceptEnabled !== "function") return true;
  return ctx.isCodexPermissionInterceptEnabled();
}

function shouldMuteCodexNativeNotificationSound(ctx) {
  if (typeof ctx.isCodexNativeNotificationSoundEnabled !== "function") return false;
  return ctx.isCodexNativeNotificationSoundEnabled() === false;
}

function isOfficialCodexSubagentPermission(agentId, data) {
  return !!(data
    && agentId === "codex"
    && data.hook_source === CODEX_OFFICIAL_HOOK_SOURCE
    && data.codex_session_role === CODEX_SESSION_ROLE_SUBAGENT);
}

function isInteractiveCodexSubagentPermission(agentId, data) {
  return !!(isOfficialCodexSubagentPermission(agentId, data)
    && (
      isCodexCliOriginator(data.codex_originator)
      || isCodexDesktopOriginator(data.codex_originator)
    )
    && data.headless !== true);
}

function isHeadlessPermissionRequest(ctx, sessionId, data, agentId) {
  // An explicit process-level signal always wins. In contrast, Codex state
  // sessions use headless=true for subagents as a presentation/focus policy
  // (keep them out of HUD priority and completion noise). A PermissionRequest
  // from a visible official Agent thread is still interactive, so that state
  // marker must not suppress the approval bubble.
  if (data && data.headless === true) return true;
  if (isOfficialCodexSubagentPermission(agentId, data)) {
    // PermissionRequest may be the first event for a child, before a session
    // exists in memory. Only audited interactive clients may cross the
    // chokepoint; exec/unknown children must fail safe to the native prompt.
    return !isInteractiveCodexSubagentPermission(agentId, data);
  }
  if (ctx && ctx.sessions && typeof ctx.sessions.get === "function") {
    const session = ctx.sessions.get(sessionId);
    if (session && session.headless) {
      return !isInteractiveCodexSubagentPermission(agentId, data);
    }
  }
  return false;
}

function arePermissionBubblesEnabled(ctx) {
  if (typeof ctx.getBubblePolicy === "function") {
    try {
      const policy = ctx.getBubblePolicy("permission");
      if (policy && typeof policy.enabled === "boolean") return policy.enabled;
    } catch {}
  }
  return !ctx.hideBubbles;
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const DSH_REASON_MAX_CHARS = 500;

function normalizeDshReason(value) {
  if (typeof value !== "string") return null;
  let text = value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (text.length > DSH_REASON_MAX_CHARS) {
    text = `${text.slice(0, DSH_REASON_MAX_CHARS - 1).trimEnd()}…`;
  }
  return text;
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

function normalizePositiveInteger(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function applyTerminalSessionOptions(options, data) {
  const tmuxSocket = normalizeTmuxSocket(data.tmux_socket);
  const tmuxClient = normalizeTmuxClient(data.tmux_client);
  const orcaPaneKey = normalizeOrcaPaneKey(data.orca_pane_key);
  if (tmuxSocket) options.tmuxSocket = tmuxSocket;
  if (tmuxClient) options.tmuxClient = tmuxClient;
  if (orcaPaneKey) options.orcaPaneKey = orcaPaneKey;
}

function buildCodexPermissionSessionOptions(data) {
  const sourcePid = normalizePositiveInteger(data.source_pid);
  const rawAgentPid = data.agent_pid ?? data.claude_pid ?? data.cursor_pid;
  const agentPid = normalizePositiveInteger(rawAgentPid);
  const pidChain = Array.isArray(data.pid_chain)
    ? data.pid_chain.filter((n) => Number.isFinite(n) && n > 0).map((n) => Math.floor(n))
    : null;
  const options = {
    agentId: "codex",
    hookSource: CODEX_OFFICIAL_HOOK_SOURCE,
  };

  if (sourcePid) options.sourcePid = sourcePid;
  if (agentPid) options.agentPid = agentPid;
  if (pidChain && pidChain.length) options.pidChain = pidChain;
  applyTerminalSessionOptions(options, data);
  const cwd = normalizeString(data.cwd);
  const host = normalizeString(data.host);
  const platform = normalizeString(data.platform);
  const model = normalizeString(data.model);
  const editor = data.editor === "code" || data.editor === "cursor" ? data.editor : null;
  const codexOriginator = normalizeString(data.codex_originator);
  const codexSource = normalizeString(data.codex_source);
  const codexSessionRole = normalizeString(data.codex_session_role);
  const codexAgentNickname = normalizeString(data.codex_agent_nickname);
  const codexAgentRole = normalizeString(data.codex_agent_role);
  const codexParentThreadId = normalizeString(data.codex_parent_thread_id);
  if (cwd) options.cwd = cwd;
  if (host) options.host = host;
  if (platform) options.platform = platform;
  if (model) options.model = model;
  if (editor) options.editor = editor;
  if (codexOriginator) options.codexOriginator = codexOriginator;
  if (codexSource) options.codexSource = codexSource;
  if (codexSessionRole) options.codexSessionRole = codexSessionRole;
  if (codexAgentNickname) options.codexAgentNickname = codexAgentNickname;
  if (codexAgentRole) options.codexAgentRole = codexAgentRole;
  if (codexParentThreadId) options.codexParentThreadId = codexParentThreadId;
  return options;
}

function buildQwenCodePermissionSessionOptions(data) {
  const sourcePid = normalizePositiveInteger(data.source_pid);
  const rawAgentPid = data.agent_pid ?? data.claude_pid ?? data.cursor_pid;
  const agentPid = normalizePositiveInteger(rawAgentPid);
  const pidChain = Array.isArray(data.pid_chain)
    ? data.pid_chain.filter((n) => Number.isFinite(n) && n > 0).map((n) => Math.floor(n))
    : null;
  const options = { agentId: "qwen-code" };

  if (sourcePid) options.sourcePid = sourcePid;
  if (agentPid) options.agentPid = agentPid;
  if (pidChain && pidChain.length) options.pidChain = pidChain;
  applyTerminalSessionOptions(options, data);
  const cwd = normalizeString(data.cwd);
  const host = normalizeString(data.host);
  const platform = normalizeString(data.platform);
  const model = normalizeString(data.model);
  if (cwd) options.cwd = cwd;
  if (host) options.host = host;
  if (platform) options.platform = platform;
  if (model) options.model = model;
  return options;
}

function buildCopilotPermissionSessionOptions(data) {
  const sourcePid = normalizePositiveInteger(data.source_pid);
  const agentPid = normalizePositiveInteger(data.agent_pid);
  const pidChain = Array.isArray(data.pid_chain)
    ? data.pid_chain.filter((n) => Number.isFinite(n) && n > 0).map((n) => Math.floor(n))
    : null;
  const options = { agentId: "copilot-cli" };

  if (sourcePid) options.sourcePid = sourcePid;
  if (agentPid) options.agentPid = agentPid;
  if (pidChain && pidChain.length) options.pidChain = pidChain;
  applyTerminalSessionOptions(options, data);
  const cwd = normalizeString(data.cwd);
  const host = normalizeString(data.host);
  if (cwd) options.cwd = cwd;
  if (host) options.host = host;
  return options;
}

function buildHermesPermissionSessionOptions(data) {
  const sourcePid = normalizePositiveInteger(data.source_pid);
  const agentPid = normalizePositiveInteger(data.agent_pid);
  const pidChain = Array.isArray(data.pid_chain)
    ? data.pid_chain.filter((n) => Number.isFinite(n) && n > 0).map((n) => Math.floor(n))
    : null;
  const options = { agentId: "hermes" };

  if (sourcePid) options.sourcePid = sourcePid;
  if (agentPid) options.agentPid = agentPid;
  if (pidChain && pidChain.length) options.pidChain = pidChain;
  applyTerminalSessionOptions(options, data);
  const cwd = normalizeString(data.cwd);
  if (cwd) options.cwd = cwd;
  const editor = normalizeString(data.editor);
  if (editor) options.editor = editor;
  return options;
}

function buildDshPermissionSessionOptions(data) {
  const sourcePid = normalizePositiveInteger(data.source_pid);
  const agentPid = normalizePositiveInteger(data.agent_pid);
  const pidChain = Array.isArray(data.pid_chain)
    ? data.pid_chain.filter((n) => Number.isFinite(n) && n > 0).map((n) => Math.floor(n))
    : null;
  const options = { agentId: "deepseek-harness" };
  if (sourcePid) options.sourcePid = sourcePid;
  if (agentPid) options.agentPid = agentPid;
  if (pidChain && pidChain.length) options.pidChain = pidChain;
  applyTerminalSessionOptions(options, data);
  const cwd = normalizeString(data.cwd);
  if (cwd) options.cwd = cwd;
  return options;
}

function sendCodexPermissionNoDecision(res) {
  res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
  res.end();
}

function sendQwenCodePermissionNoDecision(res) {
  res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
  res.end();
}

function sendCopilotPermissionNoDecision(res) {
  res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
  res.end();
}

function sendPiPermissionAllow(res) {
  const responseBody = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    },
  });
  res.writeHead(200, {
    "Content-Type": "application/json",
    [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
  });
  res.end(responseBody);
}

function sendAntigravityPermissionNoDecision(res) {
  res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
  res.end();
}

function sendHermesPermissionNoDecision(res) {
  res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
  res.end();
}

function sendDshPermissionNoDecision(res) {
  res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
  res.end();
}

function sendGenericPermissionNoDecision(res) {
  res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
  res.end();
}

// Turning off the desktop permission bubble (arePermissionBubblesEnabled ===
// false) means "don't show a window on this computer" — it must not also
// silence Telegram remote approval, since that's a separate channel the user
// may still be relying on. Builds a permEntry with no bubble (bubble stays
// null forever) and hands it straight to Telegram. Returns true if Telegram
// picked it up — caller must leave the HTTP connection open; it's answered
// later via the normal resolvePermissionEntry path. Returns false if there's
// nowhere to send it (Telegram not configured/enabled), in which case the
// caller keeps the pre-existing destroy-connection/native-chat-fallback
// behavior.
function tryRemoteOnlyApproval(ctx, fields) {
  const { res } = fields;
  const permEntry = {
    ...fields,
    bubble: null,
    hideTimer: null,
    resolvedSuggestion: null,
    createdAt: Date.now(),
    // Never gets a desktop bubble (that's the whole point of this path) —
    // lets the bubble-stack layout skip it instead of reserving an empty slot.
    remoteOnly: true,
  };
  const abortHandler = () => {
    if (res.writableFinished) return;
    ctx.permLog("abortHandler fired (remote-only, bubbles disabled)");
    // no-decision, not deny: the agent went away (timeout/exit) — nobody
    // denied anything. The socket is already closed so no response is sent
    // either way; this only keeps the remote-card status line honest
    // ("no decision" instead of "denied") when the card is cancelled.
    ctx.resolvePermissionEntry(
      permEntry,
      "no-decision",
      "Client disconnected",
      CLIENT_DISCONNECTED_OPTIONS
    );
  };
  permEntry.abortHandler = abortHandler;
  res.on("close", abortHandler);
  addPendingPermission(ctx, permEntry);

  if (typeof ctx.maybeAutoResolveSessionPermission === "function") {
    try {
      if (ctx.maybeAutoResolveSessionPermission(permEntry, { sessionOnly: true })) {
        return { handled: true, resolution: "session-automation" };
      }
    } catch (err) {
      ctx.permLog(`session automation check failed (remote-only): ${err && err.message ? err.message : err}`);
    }
  }

  let started = false;
  if (typeof ctx.maybeStartRemoteApproval === "function") {
    try {
      started = !!ctx.maybeStartRemoteApproval(permEntry);
    } catch (err) {
      ctx.permLog(`telegram remote approval start failed (remote-only): ${err && err.message ? err.message : err}`);
      started = false;
    }
  }

  if (!started) {
    removePendingPermission(ctx, permEntry, "remote-only-approval-unavailable");
    res.removeListener("close", abortHandler);
    return { handled: false, resolution: "unhandled" };
  }

  // Only after a remote client actually took the request: a card is on its
  // way, so the pet's PermissionRequest notification animation has something
  // to announce. Playing it before the `started` check meant a no-op flash
  // when Telegram wasn't available and the caller fell back to res.destroy().
  ctx.updateSession(fields.sessionId, "notification", "PermissionRequest", {
    agentId: fields.agentId,
    profileId: fields.profileId,
    rawSessionId: fields.rawSessionId,
    ...(fields.host ? { host: fields.host } : {}),
    sessionAutomationIdentity: fields.sessionAutomationIdentity,
  });
  if (typeof ctx.syncPermissionShortcuts === "function") {
    try { ctx.syncPermissionShortcuts(); } catch {}
  }
  ctx.permLog(`permission bubbles disabled, routed to Telegram-only approval: tool=${fields.toolName} session=${fields.sessionId}`);
  return { handled: true, resolution: "remote" };
}

function startRemoteApproval(ctx, permEntry) {
  if (
    permEntry
    && isDecisionInteraction(permEntry.interaction)
    && permEntry.interaction.intent === INTERACTION_INTENT.PLAN_REVIEW
  ) return;
  if (typeof ctx.maybeStartRemoteApproval !== "function") return;
  try {
    ctx.maybeStartRemoteApproval(permEntry);
  } catch (err) {
    ctx.permLog(`telegram remote approval start failed: ${err && err.message ? err.message : err}`);
  }
}

function addPendingPermission(ctx, permEntry) {
  if (typeof ctx.addPendingPermission === "function") {
    return ctx.addPendingPermission(permEntry);
  }
  ctx.pendingPermissions.push(permEntry);
  return permEntry;
}

function removePendingPermission(ctx, permEntry, reason) {
  if (typeof ctx.removePendingPermission !== "function") {
    throw new TypeError("permission route requires ctx.removePendingPermission");
  }
  return ctx.removePendingPermission(permEntry, reason);
}

function handlePermissionPost(req, res, options) {
  const {
    ctx,
    createRequestHookRecorder,
    remoteProfile = null,
    isWinHost = process.platform === "win32",
    windowsProcessChainRuntime = null,
    resolveWindowsProcessMetadata = null,
    recordWindowsProcessChainShadow = null,
  } = options;
  ctx.permLog(`/permission hit | DND=${ctx.doNotDisturb} pending=${ctx.pendingPermissions.length}`);
  let body = "";
  let bodySize = 0;
  let tooLarge = false;
  req.on("data", (chunk) => {
    if (tooLarge) return;
    bodySize += chunk.length;
    if (bodySize > MAX_PERMISSION_BODY_BYTES) { tooLarge = true; return; }
    body += chunk;
  });
  req.on("end", () => {
    if (tooLarge) {
      ctx.permLog("SKIPPED: permission payload too large");
      ctx.sendPermissionResponse(res, "deny", "Permission request too large for Clawd bubble; answer in terminal");
      return;
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("bad json");
      return;
    }
    const requestHeaders = req && req.headers && typeof req.headers === "object"
      ? req.headers
      : {};
    const hookIdentity = resolveHookAgentId(data, {
      customAgentIds: typeof ctx.getCustomAgentIds === "function" ? ctx.getCustomAgentIds() : [],
    });
    const recordRequestHookEvent = createRequestHookRecorder(hookIdentity, data, "permission");
    if (hookIdentity.rejected) {
      recordRequestHookEvent.droppedInvalidAgent();
      sendGenericPermissionNoDecision(res);
      return;
    }
    if (hookIdentity.source === "custom") {
      recordRequestHookEvent.droppedUnsupported();
      sendGenericPermissionNoDecision(res);
      return;
    }
    const { agentId } = hookIdentity;
    const trustedProfileId = remoteProfile && typeof remoteProfile.profileId === "string"
      ? remoteProfile.profileId
      : "local";
    const trustedDisplayHost = remoteProfile && typeof remoteProfile.displayHost === "string"
      ? remoteProfile.displayHost
      : null;
    const sessionAutomationIdentity = assessSessionAutomationIdentity({
      agentId,
      channel: "permission",
      event: data.hook_event_name || data.event || "PermissionRequest",
      // This must stay the original wire value. In particular, do not feed the
      // "default" fallbacks below back into the eligibility decision.
      rawSessionId: data.session_id,
      profileId: trustedProfileId,
      hookSource: data.hook_source,
      codexOriginator: data.codex_originator,
      codexSource: data.codex_source,
      agentPid: normalizePositiveInteger(data.agent_pid),
    });
    const resolvePermissionSession = (value, fallback) =>
      resolveSessionIdentity(value, trustedProfileId, fallback);
    // The route owns this identity: callers cannot choose the profile, and the
    // raw id must survive canonical Map-key normalization on both local and
    // remote requests. The display host remains remote-only.
    const trustedSessionFields = (sessionIdentity) => ({
      profileId: sessionIdentity.profileId,
      rawSessionId: sessionIdentity.rawSessionId,
      ...(trustedProfileId !== "local" && trustedDisplayHost ? { host: trustedDisplayHost } : {}),
    });

    try {
      // ── opencode-family branch (opencode + opencode-derived runtimes) ──
      // The family plugin (hooks/opencode-family-plugin/) posts fire-and-forget.
      // We always 200 ACK immediately; the user's decision routes through
      // the plugin's reverse bridge (see permission.js
      // replyOpencodeFamilyPermission). This means no res is retained on the
      // permEntry, no res.on("close") abort handler, and hideBubbles
      // degrades to "TUI only" (plugin doesn't wait on us).
      //
      // DND handling is branch-specific: the plugin cannot observe the
      // HTTP response (fire-and-forget), so a generic HTTP deny would
      // leave the TUI hanging until timeout. Instead we route DND
      // through the same reverse bridge the plugin uses for replies.
      if (isOpencodeFamily(agentId)) {
        res.writeHead(200, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
        res.end("ok");
        const toolName = typeof data.tool_name === "string" && data.tool_name ? data.tool_name : "unknown";
        const interaction = classifyPermissionInteraction({
          agentId,
          eventKind: "permission",
          toolName,
        });

        // Agent gate: same silent-drop semantics as DND — plugin is
        // fire-and-forget, so 200 ACK satisfies it; skipping the bridge
        // reply lets the host TUI fall back to its built-in prompt.
        if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled(agentId)) {
          recordRequestHookEvent.droppedByDisabled();
          ctx.permLog(`${agentId} disabled → silent drop, TUI fallback`);
          return;
        }

        const rawInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
        const toolInput = truncateDeep(rawInput);
        const sessionIdentity = resolvePermissionSession(data.session_id, "default");
        const sessionId = sessionIdentity.sessionId;
        const requestId = typeof data.request_id === "string" ? data.request_id : null;
        const bridgeUrl = typeof data.bridge_url === "string" ? data.bridge_url : "";
        const bridgeToken = typeof data.bridge_token === "string" ? data.bridge_token : "";
        const alwaysCandidates = Array.isArray(data.always) ? data.always : [];
        const patterns = Array.isArray(data.patterns) ? data.patterns : [];

        ctx.permLog(`${agentId} perm: tool=${toolName} session=${sessionId} req=${requestId} bridge=${bridgeUrl} always=${alwaysCandidates.length}`);

        // bridge_url/bridge_token are required — this is the reverse
        // channel Clawd uses to send the decision back to the plugin,
        // which then calls the host's in-process Hono route. Without it
        // we have no way to resolve the pending permission.
        if (!requestId || !bridgeUrl || !bridgeToken) {
          const missing = !requestId ? "request_id" : (!bridgeUrl ? "bridge_url" : "bridge_token");
          recordRequestHookEvent.accepted();
          ctx.permLog(`SKIPPED ${agentId} perm: missing ${missing}`);
          return;
        }

        // DND: drop silently — do NOT reply via bridge. The host TUI
        // will fall back to its built-in permission prompt so the user
        // can confirm in the terminal themselves. Spike 2026-04-06
        // confirmed this works: TUI shows Allow/Reject without hanging.
        if (ctx.doNotDisturb) {
          recordRequestHookEvent.droppedByDnd();
          ctx.permLog(`${agentId} DND → silent drop, TUI fallback — request=${requestId}`);
          return;
        }

        if (isHeadlessPermissionRequest(ctx, sessionId, data, agentId)) {
          recordRequestHookEvent.accepted();
          ctx.permLog(`${agentId} headless session=${sessionId} → silent drop, TUI fallback — request=${requestId}`);
          return;
        }

        // No HTTP connection to hold open — only degradation is to
        // not render a bubble and let the TUI prompt handle it.
        const familySubGateBypass = shouldBypassFamilyBubble(ctx, agentId);
        if (!arePermissionBubblesEnabled(ctx) || familySubGateBypass) {
          recordRequestHookEvent.accepted();
          ctx.permLog(`${agentId} bubble hidden: tool=${toolName} — TUI fallback (permissionBubblesEnabled=${arePermissionBubblesEnabled(ctx)} subGateBypass=${familySubGateBypass})`);
          return;
        }

        const permEntry = {
          res: null,
          abortHandler: null,
          suggestions: [],
          sessionId,
          ...trustedSessionFields(sessionIdentity),
          bubble: null,
          hideTimer: null,
          toolName,
          toolInput,
          resolvedSuggestion: null,
          createdAt: Date.now(),
          interaction,
          sessionAutomationIdentity,
          // Public identity field — generic consumers (focus, logging, remote
          // approval, disable-agent sweep) key off it; never replace it with a
          // family-specific field (plan §3.5).
          agentId,
          // Neutral family bridge fields — one vocabulary for every member.
          familyRequestId: requestId,
          familyBridgeUrl: bridgeUrl,
          familyBridgeToken: bridgeToken,
          familyAlwaysCandidates: alwaysCandidates,
          familyPatterns: patterns,
        };
        addPendingPermission(ctx, permEntry);
        // Play notification animation on the pet body so the bubble doesn't
        // appear "silently". Mirrors the Codex path (main.js showCodexNotifyBubble)
        // and the Elicitation branch below. state.js:581 has a special
        // PermissionRequest branch that setStates notification without
        // mutating session state — so working/thinking is preserved for resolve.
        ctx.updateSession(sessionId, "notification", "PermissionRequest", {
          agentId,
          sessionAutomationIdentity,
          ...trustedSessionFields(sessionIdentity),
        });
        ctx.permLog(`${agentId} showing bubble: tool=${toolName} session=${sessionId}`);
        recordRequestHookEvent.accepted();
        try {
          ctx.showPermissionBubble(permEntry);
        } catch (bubbleErr) {
          // If bubble creation fails (BrowserWindow error, bad html,
          // window-positioning crash, etc), we have already 200-ACKed
          // the plugin and it is waiting for a bridge reply. Without
          // this rescue the permEntry would linger in pendingPermissions
          // until the host TUI hits its own timeout (minutes).
          // Pop the ghost entry and send an immediate reject so the
          // TUI unblocks and the user can re-answer in the terminal.
          ctx.permLog(`${agentId} bubble failed: ${bubbleErr && bubbleErr.message} — reject via bridge`);
          removePendingPermission(ctx, permEntry, `${agentId}-bubble-failed`);
          ctx.replyOpencodeFamilyPermission({ agentId, bridgeUrl, bridgeToken, requestId, reply: "reject", toolName });
        }
        return;
      }

      // ── Antigravity CLI PreToolUse branch (state-only after D2 decision) ──
      // Clawd intentionally does NOT show a permission bubble for agy. If a
      // stray PreToolUse request arrives anyway (legacy hooks.json entry, user
      // manually re-registered the hook, or auto-sync was skipped), respond
      // with 204 so the hook prints `decision:"ask"` and agy's own 5-option
      // native menu owns the decision. The downstream antigravity branches in
      // permission.js / bubble-format.js are kept as intentional dead code so
      // a future Path C restoration (e.g. if agy ships a final-allow protocol
      // field) only needs to re-enable this entry point.
      if (agentId === "antigravity-cli") {
        const toolName = typeof data.tool_name === "string" && data.tool_name ? data.tool_name : "Unknown";
        if (ctx.doNotDisturb) {
          recordRequestHookEvent.droppedByDnd();
        } else if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled("antigravity-cli")) {
          recordRequestHookEvent.droppedByDisabled();
        } else {
          recordRequestHookEvent.accepted();
        }
        ctx.permLog(`antigravity state-only -> ask fallback (tool=${toolName})`);
        sendAntigravityPermissionNoDecision(res);
        return;
      }

      // ── Codex official PermissionRequest branch ──
      // The hook is blocking, but fallback must be no-decision rather than
      // Deny: Codex will then continue to its native approval prompt.
      if (agentId === "codex") {
        const toolName = typeof data.tool_name === "string" && data.tool_name ? data.tool_name : "Unknown";
        const interaction = classifyPermissionInteraction({
          agentId: "codex",
          eventKind: "permission",
          toolName,
        });
        const rawInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
        const description = typeof data.tool_input_description === "string" && data.tool_input_description
          ? data.tool_input_description
          : (typeof rawInput.description === "string" ? rawInput.description : "");
        const toolInput = normalizeCodexPermissionToolInput(rawInput, description);
        const sessionIdentity = resolvePermissionSession(data.session_id, "codex:default");
        const sessionId = sessionIdentity.sessionId;
        const toolUseId = normalizeHookToolUseId(
          data.tool_use_id ?? data.toolUseId ?? data.toolUseID
        );
        const toolInputFingerprint = typeof data.tool_input_fingerprint === "string" && data.tool_input_fingerprint
          ? data.tool_input_fingerprint
          : buildToolInputFingerprint(rawInput);
        const legacyCodexSessionOptions = {
          ...buildCodexPermissionSessionOptions(data),
          sessionAutomationIdentity,
          ...trustedSessionFields(sessionIdentity),
        };
        const isCodexSubagent = isInteractiveCodexSubagentPermission(agentId, data);
        let codexSessionOptions = legacyCodexSessionOptions;
        let codexProcessMetadataResolved = false;
        const resolveCodexSessionProcessMetadata = () => {
          if (codexProcessMetadataResolved) return codexSessionOptions;
          codexProcessMetadataResolved = true;
          const existingSession = ctx.sessions && typeof ctx.sessions.get === "function"
            ? ctx.sessions.get(sessionId)
            : null;
          const effectiveHost = legacyCodexSessionOptions.host
            || (existingSession && existingSession.host)
            || null;
          const effectiveWslDistro = normalizeString(data.wsl_distro)
            || (existingSession && existingSession.wslDistro)
            || null;
          const effectivePlatform = legacyCodexSessionOptions.platform
            || (existingSession && existingSession.platform)
            || null;
          const assessment = assessWindowsProcessChainRequest({
            agentId: "codex",
            runtime: windowsProcessChainRuntime,
            isWinHost,
            remoteProfile,
            effectiveHost,
            effectiveWslDistro,
            effectivePlatform,
            // All headless paths returned before this resolver is invoked.
            effectiveHeadless: false,
            hookPidHeader: requestHeaders[CLAWD_HOOK_PID_HEADER.toLowerCase()],
            instanceGeneration: requestHeaders[CLAWD_PROCESS_INSTANCE_HEADER.toLowerCase()],
          });
          if (!assessment.eligible || typeof resolveWindowsProcessMetadata !== "function") {
            return codexSessionOptions;
          }

          let result;
          try {
            result = resolveWindowsProcessMetadata({
              agentId: "codex",
              hookPid: assessment.hookPid,
              preferAgentPid: isCodexDesktopOriginator(legacyCodexSessionOptions.codexOriginator),
            });
          } catch {
            result = {
              status: "unavailable",
              reason: "resolver-threw",
              sourcePid: null,
              agentPid: null,
              pidChain: null,
              editor: null,
            };
          }

          if (assessment.mode === "shadow") {
            const candidateMetadata = processMetadataForState(result);
            const legacyMetadata = {
              sourcePid: legacyCodexSessionOptions.sourcePid || null,
              agentPid: legacyCodexSessionOptions.agentPid || null,
              pidChain: legacyCodexSessionOptions.pidChain || null,
              editor: legacyCodexSessionOptions.editor || null,
            };
            const record = {
              channel: "permission",
              agentId: "codex",
              event: "PermissionRequest",
              status: result && result.status || "unavailable",
              reason: result && result.reason || "resolver-unavailable",
              comparisonClass: result && result.comparisonClass || null,
              agentSeenBeforeFailure: result && result.agentSeenBeforeFailure === true,
              failureStage: result && result.failureStage || null,
              errorKind: result && result.errorKind || null,
              depth: result && result.depth || 0,
              durationMs: result && result.durationMs || 0,
              cacheSource: requestHeaders[CLAWD_LEGACY_PROCESS_CACHE_HEADER.toLowerCase()] || null,
              rawEditor: result && result.rawEditor || null,
              effectiveEditor: candidateMetadata.editor,
              legacyMetadata,
              candidateMetadata,
              comparison: buildShadowComparison(legacyMetadata, result),
            };
            if (typeof recordWindowsProcessChainShadow === "function") {
              try { recordWindowsProcessChainShadow(record); } catch {}
            } else if (typeof ctx.debugLog === "function") {
              const safeShadowRecord = sanitizeShadowRecord(record);
              if (safeShadowRecord) ctx.debugLog(`win-chain-shadow ${JSON.stringify(safeShadowRecord)}`);
            }
            return codexSessionOptions;
          }

          if (assessment.mode === "b1a-authoritative") {
            const metadata = processMetadataForState(result);
            codexSessionOptions = {
              ...legacyCodexSessionOptions,
              sourcePid: metadata.sourcePid,
              agentPid: metadata.agentPid,
              pidChain: metadata.pidChain,
              editor: metadata.editor,
              replaceProcessMetadata: true,
            };
          }
          return codexSessionOptions;
        };

        if (ctx.doNotDisturb) {
          recordRequestHookEvent.droppedByDnd();
          ctx.permLog(`codex DND -> no decision, native prompt fallback (tool=${toolName})`);
          sendCodexPermissionNoDecision(res);
          return;
        }

        if (isHeadlessPermissionRequest(ctx, sessionId, data, agentId)) {
          recordRequestHookEvent.accepted();
          ctx.permLog(`codex headless session=${sessionId} -> no decision, native prompt fallback (tool=${toolName})`);
          sendCodexPermissionNoDecision(res);
          return;
        }

        if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled("codex")) {
          recordRequestHookEvent.droppedByDisabled();
          ctx.permLog(`codex disabled -> no decision, native prompt fallback (tool=${toolName})`);
          sendCodexPermissionNoDecision(res);
          return;
        }

        if (!shouldInterceptCodexPermission(ctx)) {
          codexSessionOptions = resolveCodexSessionProcessMetadata();
          const nativeSessionOptions = { ...codexSessionOptions };
          if (shouldMuteCodexNativeNotificationSound(ctx)) {
            nativeSessionOptions.muteNotificationSound = true;
          }
          nativeSessionOptions.transientPermissionEvent = true;
          ctx.updateSession(sessionId, "notification", "PermissionRequest", nativeSessionOptions);
          ctx.permLog(`codex native permission mode -> no decision, native prompt fallback (tool=${toolName})`);
          recordRequestHookEvent.accepted();
          sendCodexPermissionNoDecision(res);
          return;
        }

        if (shouldBypassCodexBubble(ctx)) {
          recordRequestHookEvent.accepted();
          const reason = !arePermissionBubblesEnabled(ctx)
            ? "permission bubbles disabled"
            : "codex bubbles disabled";
          ctx.permLog(`${reason} -> no decision, native prompt fallback (tool=${toolName})`);
          sendCodexPermissionNoDecision(res);
          return;
        }

        codexSessionOptions = resolveCodexSessionProcessMetadata();

        const permEntry = {
          res,
          abortHandler: null,
          suggestions: [],
          sessionId,
          ...trustedSessionFields(sessionIdentity),
          bubble: null,
          hideTimer: null,
          toolName,
          toolInput,
          toolUseId,
          toolInputFingerprint,
          resolvedSuggestion: null,
          createdAt: Date.now(),
          interaction,
          sessionAutomationIdentity,
          agentId: "codex",
          isCodex: true,
          codexInteractiveSubagent: isCodexSubagent,
          headless: data.headless === true,
          codexSessionRole: codexSessionOptions.codexSessionRole || null,
          codexAgentNickname: codexSessionOptions.codexAgentNickname || null,
          codexAgentRole: codexSessionOptions.codexAgentRole || null,
          codexParentThreadId: codexSessionOptions.codexParentThreadId || null,
          subagentId: isCodexSubagent ? sessionId : null,
          subagentType: isCodexSubagent
            ? (codexSessionOptions.codexAgentNickname || codexSessionOptions.codexAgentRole || "Agent")
            : null,
          sourcePid: codexSessionOptions.sourcePid || null,
          cwd: codexSessionOptions.cwd || "",
          agentPid: codexSessionOptions.agentPid || null,
          pidChain: codexSessionOptions.pidChain || null,
          tmuxSocket: codexSessionOptions.tmuxSocket || null,
          tmuxClient: codexSessionOptions.tmuxClient || null,
          orcaPaneKey: codexSessionOptions.orcaPaneKey || null,
          host: codexSessionOptions.host || null,
          platform: codexSessionOptions.platform || null,
          model: codexSessionOptions.model || null,
          codexOriginator: codexSessionOptions.codexOriginator || null,
          codexSource: codexSessionOptions.codexSource || null,
        };
        const abortHandler = () => {
          if (res.writableFinished) return;
          ctx.permLog("abortHandler fired (codex)");
          ctx.resolvePermissionEntry(permEntry, "no-decision", "Client disconnected", CLIENT_DISCONNECTED_OPTIONS);
        };
        permEntry.abortHandler = abortHandler;
        res.on("close", abortHandler);

        addPendingPermission(ctx, permEntry);
        ctx.updateSession(sessionId, "notification", "PermissionRequest", codexSessionOptions);

        ctx.permLog(`codex showing bubble: tool=${toolName} session=${sessionId} stack=${ctx.pendingPermissions.length}`);
        recordRequestHookEvent.accepted();
        try {
          ctx.showPermissionBubble(permEntry);
        } catch (bubbleErr) {
          ctx.permLog(`codex bubble failed: ${bubbleErr && bubbleErr.message} -> no decision`);
          removePendingPermission(ctx, permEntry, "codex-bubble-failed");
          if (permEntry.abortHandler) res.removeListener("close", permEntry.abortHandler);
          sendCodexPermissionNoDecision(res);
          return;
        }
        startRemoteApproval(ctx, permEntry);
        return;
      }

      // ── Qwen Code PermissionRequest branch ──
      // Qwen command hooks treat empty/no-decision output as "show native
      // permission prompt". Keep every fallback as 204/no-decision so Clawd
      // never denies tools on cleanup or disabled bubble paths.
      if (agentId === "qwen-code") {
        const toolName = typeof data.tool_name === "string" && data.tool_name ? data.tool_name : "Unknown";
        const interaction = classifyPermissionInteraction({
          agentId: "qwen-code",
          eventKind: "permission",
          toolName,
        });
        const rawInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
        const toolInput = truncateDeep(rawInput);
        const sessionIdentity = resolvePermissionSession(data.session_id, "qwen-code:default");
        const sessionId = sessionIdentity.sessionId;
        const toolUseId = normalizeHookToolUseId(
          data.tool_use_id ?? data.toolUseId ?? data.toolUseID
        );
        const toolInputFingerprint = typeof data.tool_input_fingerprint === "string" && data.tool_input_fingerprint
          ? data.tool_input_fingerprint
          : buildToolInputFingerprint(rawInput);
        const qwenSessionOptions = {
          ...buildQwenCodePermissionSessionOptions(data),
          sessionAutomationIdentity,
          ...trustedSessionFields(sessionIdentity),
        };

        if (ctx.doNotDisturb) {
          recordRequestHookEvent.droppedByDnd();
          ctx.permLog(`qwen DND -> no decision, native prompt fallback (tool=${toolName})`);
          sendQwenCodePermissionNoDecision(res);
          return;
        }

        if (isHeadlessPermissionRequest(ctx, sessionId, data, agentId)) {
          recordRequestHookEvent.accepted();
          ctx.permLog(`qwen headless session=${sessionId} -> no decision, native prompt fallback (tool=${toolName})`);
          sendQwenCodePermissionNoDecision(res);
          return;
        }

        if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled("qwen-code")) {
          recordRequestHookEvent.droppedByDisabled();
          ctx.permLog(`qwen disabled -> no decision, native prompt fallback (tool=${toolName})`);
          sendQwenCodePermissionNoDecision(res);
          return;
        }

        if (shouldBypassQwenCodeBubble(ctx)) {
          recordRequestHookEvent.accepted();
          const reason = !arePermissionBubblesEnabled(ctx)
            ? "permission bubbles disabled"
            : "qwen bubbles disabled";
          ctx.permLog(`${reason} -> no decision, native prompt fallback (tool=${toolName})`);
          sendQwenCodePermissionNoDecision(res);
          return;
        }

        const permEntry = {
          res,
          abortHandler: null,
          suggestions: [],
          sessionId,
          ...trustedSessionFields(sessionIdentity),
          bubble: null,
          hideTimer: null,
          toolName,
          toolInput,
          toolUseId,
          toolInputFingerprint,
          resolvedSuggestion: null,
          createdAt: Date.now(),
          interaction,
          sessionAutomationIdentity,
          agentId: "qwen-code",
          isQwenCode: true,
          sourcePid: qwenSessionOptions.sourcePid || null,
          cwd: qwenSessionOptions.cwd || "",
          agentPid: qwenSessionOptions.agentPid || null,
          pidChain: qwenSessionOptions.pidChain || null,
          tmuxSocket: qwenSessionOptions.tmuxSocket || null,
          tmuxClient: qwenSessionOptions.tmuxClient || null,
          orcaPaneKey: qwenSessionOptions.orcaPaneKey || null,
          host: qwenSessionOptions.host || null,
          platform: qwenSessionOptions.platform || null,
          model: qwenSessionOptions.model || null,
        };
        const abortHandler = () => {
          if (res.writableFinished) return;
          ctx.permLog("abortHandler fired (qwen)");
          ctx.resolvePermissionEntry(permEntry, "no-decision", "Client disconnected", CLIENT_DISCONNECTED_OPTIONS);
        };
        permEntry.abortHandler = abortHandler;
        res.on("close", abortHandler);

        addPendingPermission(ctx, permEntry);
        ctx.updateSession(sessionId, "notification", "PermissionRequest", qwenSessionOptions);

        ctx.permLog(`qwen showing bubble: tool=${toolName} session=${sessionId} stack=${ctx.pendingPermissions.length}`);
        recordRequestHookEvent.accepted();
        try {
          ctx.showPermissionBubble(permEntry);
        } catch (bubbleErr) {
          ctx.permLog(`qwen bubble failed: ${bubbleErr && bubbleErr.message} -> no decision`);
          removePendingPermission(ctx, permEntry, "qwen-bubble-failed");
          if (permEntry.abortHandler) res.removeListener("close", permEntry.abortHandler);
          sendQwenCodePermissionNoDecision(res);
          return;
        }
        startRemoteApproval(ctx, permEntry);
        return;
      }

      // ── Copilot CLI PermissionRequest branch ──
      // Copilot command hooks treat empty stdout + exit 0 as "no decision,
      // continue native flow" (Phase 0 §3, locked). Every Clawd path here
      // either resolves through the bubble or returns 204 so the hook
      // emits empty stdout and lets Copilot's native menu run. We must
      // NOT route Copilot through the Claude/CodeBuddy branch below,
      // which would emit hookSpecificOutput JSON that Copilot can't parse.
      //
      // Telegram remote approval is intentionally excluded in v1
      // (plan §6, Phase 6 lifecycle table). Track follow-up after a
      // safe human-readable summary format is designed for Copilot's
      // tool-specific toolInput shapes (edit's full diff is the
      // worst-case carrier and shouldn't be telegrammed verbatim).
      if (agentId === "copilot-cli") {
        const toolName = typeof data.tool_name === "string" && data.tool_name ? data.tool_name : "Unknown";
        const interaction = classifyPermissionInteraction({
          agentId: "copilot-cli",
          eventKind: "permission",
          toolName,
        });
        const rawInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
        const toolInput = truncateDeep(rawInput);
        const sessionIdentity = resolvePermissionSession(data.session_id, "copilot-cli:default");
        const sessionId = sessionIdentity.sessionId;
        const toolUseId = normalizeHookToolUseId(
          data.tool_use_id ?? data.toolUseId ?? data.toolUseID
        );
        const toolInputFingerprint = typeof data.tool_input_fingerprint === "string" && data.tool_input_fingerprint
          ? data.tool_input_fingerprint
          : buildToolInputFingerprint(rawInput);
        const copilotSessionOptions = {
          ...buildCopilotPermissionSessionOptions(data),
          sessionAutomationIdentity,
          ...trustedSessionFields(sessionIdentity),
        };

        if (ctx.doNotDisturb) {
          recordRequestHookEvent.droppedByDnd();
          ctx.permLog(`copilot DND -> no decision, native prompt fallback (tool=${toolName})`);
          sendCopilotPermissionNoDecision(res);
          return;
        }

        if (isHeadlessPermissionRequest(ctx, sessionId, data, agentId)) {
          recordRequestHookEvent.accepted();
          ctx.permLog(`copilot headless session=${sessionId} -> no decision, native prompt fallback (tool=${toolName})`);
          sendCopilotPermissionNoDecision(res);
          return;
        }

        if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled("copilot-cli")) {
          recordRequestHookEvent.droppedByDisabled();
          ctx.permLog(`copilot disabled -> no decision, native prompt fallback (tool=${toolName})`);
          sendCopilotPermissionNoDecision(res);
          return;
        }

        if (shouldBypassCopilotBubble(ctx)) {
          recordRequestHookEvent.accepted();
          const reason = !arePermissionBubblesEnabled(ctx)
            ? "permission bubbles disabled"
            : "copilot bubbles disabled";
          ctx.permLog(`${reason} -> no decision, native prompt fallback (tool=${toolName})`);
          sendCopilotPermissionNoDecision(res);
          return;
        }

        const permEntry = {
          res,
          abortHandler: null,
          suggestions: [],
          sessionId,
          ...trustedSessionFields(sessionIdentity),
          bubble: null,
          hideTimer: null,
          toolName,
          toolInput,
          toolUseId,
          toolInputFingerprint,
          resolvedSuggestion: null,
          createdAt: Date.now(),
          interaction,
          sessionAutomationIdentity,
          agentId: "copilot-cli",
          isCopilotCli: true,
          sourcePid: copilotSessionOptions.sourcePid || null,
          cwd: copilotSessionOptions.cwd || "",
          agentPid: copilotSessionOptions.agentPid || null,
          pidChain: copilotSessionOptions.pidChain || null,
          tmuxSocket: copilotSessionOptions.tmuxSocket || null,
          tmuxClient: copilotSessionOptions.tmuxClient || null,
          orcaPaneKey: copilotSessionOptions.orcaPaneKey || null,
          host: copilotSessionOptions.host || null,
        };
        // Closed connection => no-decision (NOT deny). Phase 0 §4.2:
        // Copilot deadlocks if the hook gets killed; a defensive deny
        // here would also surprise users by overriding native flow on
        // transient errors. Native fallback is always safer.
        const abortHandler = () => {
          if (res.writableFinished) return;
          ctx.permLog("abortHandler fired (copilot)");
          ctx.resolvePermissionEntry(permEntry, "no-decision", "Client disconnected", CLIENT_DISCONNECTED_OPTIONS);
        };
        permEntry.abortHandler = abortHandler;
        res.on("close", abortHandler);

        addPendingPermission(ctx, permEntry);
        ctx.updateSession(sessionId, "notification", "PermissionRequest", copilotSessionOptions);

        ctx.permLog(`copilot showing bubble: tool=${toolName} session=${sessionId} stack=${ctx.pendingPermissions.length}`);
        recordRequestHookEvent.accepted();
        try {
          ctx.showPermissionBubble(permEntry);
        } catch (bubbleErr) {
          ctx.permLog(`copilot bubble failed: ${bubbleErr && bubbleErr.message} -> no decision`);
          removePendingPermission(ctx, permEntry, "copilot-bubble-failed");
          if (permEntry.abortHandler) res.removeListener("close", permEntry.abortHandler);
          sendCopilotPermissionNoDecision(res);
          return;
        }
        // v1: no startRemoteApproval. Telegram remote approval requires
        // a Copilot-aware safe summary formatter (see Phase 7 follow-up).
        return;
      }

      // ── Pi extension legacy PermissionRequest branch ──
      // Pi is state-only in Clawd. Current extensions never POST /permission.
      // A pre-state-only managed extension may still be loaded in an existing
      // Pi process, so return "allow" to preserve Pi's native YOLO behavior
      // instead of turning Clawd fallback into a terminal confirmation prompt.
      if (agentId === "pi") {
        const toolName = typeof data.tool_name === "string" && data.tool_name ? data.tool_name : "unknown";
        if (ctx.doNotDisturb) {
          recordRequestHookEvent.droppedByDnd();
        } else if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled("pi")) {
          recordRequestHookEvent.droppedByDisabled();
        } else {
          recordRequestHookEvent.accepted();
        }
        ctx.permLog(`pi state-only -> allow native YOLO fallback (tool=${toolName})`);
        sendPiPermissionAllow(res);
        return;
      }

      // ── DeepSeek Harness branch ──
      // Blocking HTTP. The in-process DSH plugin awaits this response inside
      // approval/request. A 204 means no Clawd decision; the plugin calls
      // next() so DSH's downstream web answerer remains authoritative.
      if (agentId === "deepseek-harness") {
        const toolName = typeof data.tool_name === "string" && data.tool_name.trim()
          ? data.tool_name.trim()
          : "unknown";
        const interaction = classifyPermissionInteraction({
          agentId: "deepseek-harness",
          eventKind: "permission",
          toolName,
        });
        const sessionIdentity = resolvePermissionSession(data.session_id, "deepseek-harness:default");
        const sessionId = sessionIdentity.sessionId;

        // ask_user_question is intentionally DSH-native. This guard is
        // defense-in-depth for stale/foreign bridge builds that still POST it.
        if (
          interaction.intent === INTERACTION_INTENT.HUMAN_QUESTION
          || interaction.intent !== INTERACTION_INTENT.TOOL_APPROVAL
        ) {
          recordRequestHookEvent.droppedUnsupported();
          ctx.permLog(`dsh unsupported interaction -> native fallback (tool=${toolName})`);
          sendDshPermissionNoDecision(res);
          return;
        }

        if (ctx.doNotDisturb) {
          recordRequestHookEvent.droppedByDnd();
          ctx.permLog(`dsh DND -> no decision, native fallback (tool=${toolName})`);
          sendDshPermissionNoDecision(res);
          return;
        }
        if (isHeadlessPermissionRequest(ctx, sessionId, data, agentId)) {
          recordRequestHookEvent.accepted();
          ctx.permLog(`dsh headless session=${sessionId} -> no decision, native fallback`);
          sendDshPermissionNoDecision(res);
          return;
        }
        if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled(agentId)) {
          recordRequestHookEvent.droppedByDisabled();
          sendDshPermissionNoDecision(res);
          return;
        }

        const agentGateOff = typeof ctx.isAgentPermissionsEnabled === "function"
          && !ctx.isAgentPermissionsEnabled(agentId);
        // ApprovalRequest intentionally does not expose tool arguments. Ignore
        // any foreign/stale bridge payload that tries to supply them. The
        // public human-readable reason is bounded again at this trust boundary
        // and is display-only; it never participates in automation/fingerprints.
        const rawInput = {};
        const reason = normalizeDshReason(data.reason);
        const toolInput = reason ? { description: reason } : {};
        const toolUseId = normalizeHookToolUseId(
          data.tool_use_id ?? data.toolUseId ?? data.toolUseID
        );
        const toolInputFingerprint = buildToolInputFingerprint(rawInput);
        const sessionOptions = {
          ...buildDshPermissionSessionOptions(data),
          sessionAutomationIdentity,
          ...trustedSessionFields(sessionIdentity),
        };

        if (shouldBypassDshBubble(ctx)) {
          recordRequestHookEvent.accepted();
          if (!agentGateOff && !arePermissionBubblesEnabled(ctx)) {
            const remoteOnlyResult = tryRemoteOnlyApproval(ctx, {
              res,
              sessionId,
              toolName,
              toolInput,
              toolUseId,
              toolInputFingerprint,
              agentId,
              suggestions: [],
              interaction,
              sessionAutomationIdentity,
              isDsh: true,
              ...sessionOptions,
            });
            if (remoteOnlyResult.handled) return;
          }
          ctx.permLog(`dsh ${agentGateOff ? "agent gate" : "local bubble"} disabled -> native fallback`);
          sendDshPermissionNoDecision(res);
          return;
        }

        const permEntry = {
          res,
          abortHandler: null,
          suggestions: [],
          sessionId,
          ...sessionOptions,
          bubble: null,
          hideTimer: null,
          toolName,
          toolInput,
          toolUseId,
          toolInputFingerprint,
          resolvedSuggestion: null,
          createdAt: Date.now(),
          interaction,
          sessionAutomationIdentity,
          isDsh: true,
          agentId,
        };
        const abortHandler = () => {
          if (res.writableFinished) return;
          ctx.permLog("dsh abortHandler fired");
          ctx.resolvePermissionEntry(permEntry, "no-decision", "Client disconnected", CLIENT_DISCONNECTED_OPTIONS);
        };
        permEntry.abortHandler = abortHandler;
        res.on("close", abortHandler);
        addPendingPermission(ctx, permEntry);
        ctx.updateSession(sessionId, "notification", "PermissionRequest", sessionOptions);
        recordRequestHookEvent.accepted();
        try {
          ctx.showPermissionBubble(permEntry);
        } catch (bubbleErr) {
          ctx.permLog(`dsh bubble failed: ${bubbleErr && bubbleErr.message} -> native fallback`);
          removePendingPermission(ctx, permEntry, "dsh-bubble-failed");
          if (permEntry.abortHandler) res.removeListener("close", permEntry.abortHandler);
          if (permEntry.autoCloseTimer) clearTimeout(permEntry.autoCloseTimer);
          if (permEntry.hideTimer) clearTimeout(permEntry.hideTimer);
          if (permEntry.bubble && !permEntry.bubble.isDestroyed()) {
            try { permEntry.bubble.destroy(); } catch {}
          }
          permEntry.bubble = null;
          sendDshPermissionNoDecision(res);
          return;
        }
        startRemoteApproval(ctx, permEntry);
        return;
      }

      // ── Hermes Agent branch ──
      // Blocking HTTP. Fallback is 204 (no-decision) so the Hermes plugin
      // returns None and the tool executes via Hermes's native flow.
      if (data.agent_id === "hermes") {
        const toolName = typeof data.tool_name === "string" && data.tool_name ? data.tool_name : "Unknown";
        const interaction = classifyPermissionInteraction({
          agentId: "hermes",
          eventKind: "permission",
          toolName,
        });
        const rawInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
        const toolInput = truncateDeep(rawInput);
        const sessionIdentity = resolvePermissionSession(data.session_id, "hermes:default");
        const sessionId = sessionIdentity.sessionId;
        const toolUseId = normalizeHookToolUseId(
          data.tool_use_id ?? data.toolUseId ?? data.toolUseID
        );
        const toolInputFingerprint = buildToolInputFingerprint(rawInput);

        if (ctx.doNotDisturb) {
          recordRequestHookEvent.droppedByDnd();
          ctx.permLog(`hermes DND -> no decision, native fallback (tool=${toolName})`);
          sendHermesPermissionNoDecision(res);
          return;
        }

        if (isHeadlessPermissionRequest(ctx, sessionId, data, agentId)) {
          recordRequestHookEvent.accepted();
          ctx.permLog(`hermes headless session=${sessionId} -> no decision, native fallback (tool=${toolName})`);
          sendHermesPermissionNoDecision(res);
          return;
        }

        if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled("hermes")) {
          recordRequestHookEvent.droppedByDisabled();
          ctx.permLog(`hermes disabled -> no decision, native fallback (tool=${toolName})`);
          sendHermesPermissionNoDecision(res);
          return;
        }

        if (shouldBypassHermesBubble(ctx)) {
          recordRequestHookEvent.accepted();
          const reason = !arePermissionBubblesEnabled(ctx)
            ? "permission bubbles disabled"
            : "hermes bubbles disabled";
          ctx.permLog(`${reason} -> no decision, native fallback (tool=${toolName})`);
          sendHermesPermissionNoDecision(res);
          return;
        }

        const isElicitation = interaction.intent === INTERACTION_INTENT.HUMAN_QUESTION;

        if (isElicitation) {
          const elicitation = prepareElicitationToolInput(rawInput);
          if (!elicitation.canAnswer) {
            recordRequestHookEvent.accepted();
            ctx.permLog(`HERMES ELICITATION unsupported shape (${elicitation.reason}) -> native fallback`);
            sendHermesPermissionNoDecision(res);
            return;
          }
          const elicitationInput = elicitation.displayInput;
          const hermesSessionOptions = {
            ...buildHermesPermissionSessionOptions(data),
            sessionAutomationIdentity,
            ...trustedSessionFields(sessionIdentity),
          };
          ctx.permLog(`HERMES ELICITATION: tool=${toolName} session=${sessionId}`);
          ctx.updateSession(sessionId, "notification", "Elicitation", hermesSessionOptions);

          const permEntry = {
            res,
            abortHandler: null,
            suggestions: [],
            sessionId,
            ...trustedSessionFields(sessionIdentity),
            bubble: null,
            hideTimer: null,
            toolName,
            toolInput: elicitationInput,
            elicitationWireInput: elicitation.wireInput,
            toolUseId,
            toolInputFingerprint,
            resolvedSuggestion: null,
            createdAt: Date.now(),
            interaction,
            sessionAutomationIdentity,
            isElicitation: true,
            isHermes: true,
            agentId: "hermes",
            cwd: hermesSessionOptions.cwd || "",
            agentPid: hermesSessionOptions.agentPid || null,
            sourcePid: hermesSessionOptions.sourcePid || null,
            pidChain: hermesSessionOptions.pidChain || null,
            tmuxSocket: hermesSessionOptions.tmuxSocket || null,
            tmuxClient: hermesSessionOptions.tmuxClient || null,
            orcaPaneKey: hermesSessionOptions.orcaPaneKey || null,
            editor: hermesSessionOptions.editor || null,
          };
          const abortHandler = () => {
            if (res.writableFinished) return;
            ctx.permLog("hermes abortHandler fired (elicitation)");
            ctx.resolvePermissionEntry(permEntry, "no-decision", "Client disconnected", CLIENT_DISCONNECTED_OPTIONS);
          };
          permEntry.abortHandler = abortHandler;
          res.on("close", abortHandler);
          addPendingPermission(ctx, permEntry);
          recordRequestHookEvent.accepted();
          try {
            ctx.showPermissionBubble(permEntry);
          } catch (bubbleErr) {
            ctx.permLog(`hermes elicitation bubble failed: ${bubbleErr && bubbleErr.message} -> no decision`);
            removePendingPermission(ctx, permEntry, "hermes-elicitation-bubble-failed");
            if (permEntry.abortHandler) res.removeListener("close", permEntry.abortHandler);
            if (permEntry.autoCloseTimer) { clearTimeout(permEntry.autoCloseTimer); permEntry.autoCloseTimer = null; }
            if (permEntry.hideTimer) { clearTimeout(permEntry.hideTimer); permEntry.hideTimer = null; }
            if (permEntry.bubble && !permEntry.bubble.isDestroyed()) {
              try { permEntry.bubble.destroy(); } catch {}
            }
            permEntry.bubble = null;
            sendHermesPermissionNoDecision(res);
            return;
          }
          if (Array.isArray(elicitationInput.questions) && elicitationInput.questions.length > 0) {
            startRemoteApproval(ctx, permEntry);
          }
          return;
        }

        // General permission request
        const hermesSessionOptions = {
          ...buildHermesPermissionSessionOptions(data),
          sessionAutomationIdentity,
          ...trustedSessionFields(sessionIdentity),
        };
        ctx.permLog(`HERMES PERMISSION: tool=${toolName} session=${sessionId}`);
        ctx.updateSession(sessionId, "notification", "PermissionRequest", hermesSessionOptions);

        const permEntry = {
          res,
          abortHandler: null,
          suggestions: [],
          sessionId,
          ...trustedSessionFields(sessionIdentity),
          bubble: null,
          hideTimer: null,
          toolName,
          toolInput,
          toolUseId,
          toolInputFingerprint,
          resolvedSuggestion: null,
          createdAt: Date.now(),
          interaction,
          sessionAutomationIdentity,
          isHermes: true,
          agentId: "hermes",
          cwd: hermesSessionOptions.cwd || "",
          agentPid: hermesSessionOptions.agentPid || null,
          sourcePid: hermesSessionOptions.sourcePid || null,
          pidChain: hermesSessionOptions.pidChain || null,
          tmuxSocket: hermesSessionOptions.tmuxSocket || null,
          tmuxClient: hermesSessionOptions.tmuxClient || null,
          orcaPaneKey: hermesSessionOptions.orcaPaneKey || null,
          editor: hermesSessionOptions.editor || null,
        };
        const abortHandler = () => {
          if (res.writableFinished) return;
          ctx.permLog("hermes abortHandler fired");
          ctx.resolvePermissionEntry(permEntry, "no-decision", "Client disconnected", CLIENT_DISCONNECTED_OPTIONS);
        };
        permEntry.abortHandler = abortHandler;
        res.on("close", abortHandler);
        addPendingPermission(ctx, permEntry);
        recordRequestHookEvent.accepted();
        try {
          ctx.showPermissionBubble(permEntry);
        } catch (bubbleErr) {
          ctx.permLog(`hermes bubble failed: ${bubbleErr && bubbleErr.message} -> no decision`);
          removePendingPermission(ctx, permEntry, "hermes-bubble-failed");
          if (permEntry.abortHandler) res.removeListener("close", permEntry.abortHandler);
          if (permEntry.autoCloseTimer) { clearTimeout(permEntry.autoCloseTimer); permEntry.autoCloseTimer = null; }
          if (permEntry.hideTimer) { clearTimeout(permEntry.hideTimer); permEntry.hideTimer = null; }
          if (permEntry.bubble && !permEntry.bubble.isDestroyed()) {
            try { permEntry.bubble.destroy(); } catch {}
          }
          permEntry.bubble = null;
          sendHermesPermissionNoDecision(res);
        }
        return;
      }

      // The remaining branch is the shared Claude Code / CodeBuddy-style
      // blocking permission transport. Registry capabilities are the routing
      // authority: a known state-only agent must never inherit this path just
      // because it has a valid agent_id. Pi and Antigravity are intentionally
      // handled above because their stale-client compatibility responses are
      // agent-specific; every other non-approving agent gets a neutral 204.
      const registeredAgent = getAgent(agentId);
      if (!registeredAgent
        || !registeredAgent.capabilities
        || registeredAgent.capabilities.permissionApproval !== true) {
        recordRequestHookEvent.droppedUnsupported();
        ctx.permLog(`${agentId} has no permission-approval capability -> no decision`);
        sendGenericPermissionNoDecision(res);
        return;
      }

      // ── Claude Code branch ──
      // DND: destroy connection — do NOT send deny on the user's behalf.
      // CC falls back to its built-in chat permission prompt so the user
      // decides themselves. Spike 2026-04-07 confirmed: CC shows Allow/
      // Deny in chat, no hang, no timeout. Same pattern as opencode
      // silent drop (95cbfc7).
      const ccAgentId = agentId;
      const toolName = typeof data.tool_name === "string" ? data.tool_name : "Unknown";
      const interaction = classifyPermissionInteraction({
        agentId: ccAgentId,
        eventKind: "permission",
        toolName,
      });
      if (ctx.doNotDisturb) {
        recordRequestHookEvent.droppedByDnd();
        ctx.permLog("CC DND → destroy connection, CC chat fallback");
        res.destroy();
        return;
      }

      // Agent gate: mirror DND — destroy the connection so CC (or
      // codebuddy, since they share this path) falls back to its built-in
      // chat prompt. Any non-opencode agent_id passing through here
      // gets the same treatment.
      if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled(ccAgentId)) {
        recordRequestHookEvent.droppedByDisabled();
        ctx.permLog(`${ccAgentId} disabled → destroy connection, chat fallback`);
        res.destroy();
        return;
      }

      const rawInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
      const toolInput = truncateDeep(rawInput);
      const toolUseId = normalizeHookToolUseId(
        data.tool_use_id ?? data.toolUseId ?? data.toolUseID
      );
      const toolInputFingerprint = buildToolInputFingerprint(rawInput);
      const sessionIdentity = resolvePermissionSession(data.session_id, "default");
      const sessionId = sessionIdentity.sessionId;
      // Tag the permEntry with the source agent. Clawd's HTTP permission
      // path is shared between Claude Code and codebuddy (both set
      // capabilities.permissionApproval=true and POST here). Stamping lets
      // dismissPermissionsByAgent() clean up the right ones when the user
      // disables an agent mid-flight.
      const permAgentId = agentId;
      // CC subagent origin (#451): stamped on the permEntry so the settings
      // side effect can dismiss exactly the subagent bubbles when the
      // sub-gate flips off, without touching main-thread ones.
      const subagentId = hookIdentity.source === "subagent" ? hookIdentity.subagentId : null;
      const subagentType = hookIdentity.source === "subagent" ? hookIdentity.subagentType : null;
      const rawSuggestions = Array.isArray(data.permission_suggestions) ? data.permission_suggestions : [];
      const suggestions = normalizePermissionSuggestions(rawSuggestions);

      const existingSession = ctx.sessions.get(sessionId);
      if (existingSession && existingSession.headless) {
        recordRequestHookEvent.accepted();
        ctx.permLog(`SKIPPED: headless session=${sessionId}`);
        ctx.sendPermissionResponse(res, "deny", "Non-interactive session; auto-denied");
        return;
      }

      if (ctx.PASSTHROUGH_TOOLS.has(toolName)) {
        recordRequestHookEvent.accepted();
        ctx.permLog(`PASSTHROUGH: tool=${toolName} session=${sessionId}`);
        ctx.sendPermissionResponse(res, "allow");
        return;
      }

      if (shouldBypassCCSubagentBubble(ctx, interaction, permAgentId, hookIdentity)) {
        recordRequestHookEvent.accepted();
        ctx.permLog(`${permAgentId} subagent bubbles disabled → destroy connection, chat fallback (tool=${toolName} subagent=${subagentType || subagentId})`);
        res.destroy();
        return;
      }

      if (shouldBypassCCBubble(ctx, interaction, permAgentId)) {
        recordRequestHookEvent.accepted();
        // "Permission bubbles disabled" (the global/local toggle) only means
        // no desktop window — it must not also drop Telegram remote approval.
        // "<agent> bubbles disabled" is the per-agent gate (isAgentPermissionsEnabled),
        // a stronger opt-out that keeps Clawd fully out of that agent's loop —
        // including remote channels — so it is checked first and falls straight
        // back to the native chat prompt even when the global toggle is also off.
        const agentGateOff = typeof ctx.isAgentPermissionsEnabled === "function"
          && !ctx.isAgentPermissionsEnabled(permAgentId);
        if (!agentGateOff && !arePermissionBubblesEnabled(ctx)) {
          const remoteOnlyResult = tryRemoteOnlyApproval(ctx, {
            res, sessionId, toolName, toolInput, toolUseId, toolInputFingerprint,
            agentId: permAgentId, subagentId, subagentType, suggestions, interaction,
            sessionAutomationIdentity,
            ...trustedSessionFields(sessionIdentity),
          });
          if (remoteOnlyResult.handled) return;
          ctx.permLog(`permission bubbles disabled, no remote approval available → destroy connection, chat fallback (tool=${toolName})`);
          res.destroy();
          return;
        }
        const reason = agentGateOff ? `${permAgentId} bubbles disabled` : "permission bubbles disabled";
        ctx.permLog(`${reason} → destroy connection, chat fallback (tool=${toolName})`);
        res.destroy();
        return;
      }

      // CodeBuddy shares the transport route but its rich elicitation/plan
      // response contract is not verified. Do not create a Claude-shaped entry;
      // dropping the connection reuses the route's existing native fallback
      // primitive while keeping the new decision branch explicit.
      if (permAgentId === "codebuddy" && isDecisionInteraction(interaction)) {
        recordRequestHookEvent.accepted();
        ctx.permLog(`codebuddy decision -> native fallback before entry (intent=${interaction.intent} tool=${toolName})`);
        res.destroy();
        return;
      }

      // Elicitation (AskUserQuestion) — show notification bubble, not permission bubble.
      // User clicks "Go to Terminal" → deny → Claude Code falls back to terminal.
      if (interaction.intent === INTERACTION_INTENT.HUMAN_QUESTION) {
        const elicitation = prepareElicitationToolInput(rawInput);
        if (!elicitation.canAnswer) {
          recordRequestHookEvent.accepted();
          ctx.permLog(`ELICITATION unsupported shape (${elicitation.reason}) -> native fallback`);
          res.destroy();
          return;
        }
        const elicitationInput = elicitation.displayInput;
        ctx.permLog(`ELICITATION: tool=${toolName} session=${sessionId}`);
        ctx.updateSession(sessionId, "notification", "Elicitation", {
          agentId: permAgentId,
          sessionAutomationIdentity,
          ...trustedSessionFields(sessionIdentity),
        });

        const permEntry = {
          res,
          abortHandler: null,
          suggestions: [],
          sessionId,
          ...trustedSessionFields(sessionIdentity),
          bubble: null,
          hideTimer: null,
          toolName,
          toolInput: elicitationInput,
          elicitationWireInput: elicitation.wireInput,
          toolUseId,
          toolInputFingerprint,
          resolvedSuggestion: null,
          createdAt: Date.now(),
          interaction,
          sessionAutomationIdentity,
          isElicitation: true,
          agentId: permAgentId,
          subagentId,
          subagentType,
        };
        const abortHandler = () => {
          if (res.writableFinished) return;
          ctx.permLog("abortHandler fired (elicitation)");
          ctx.resolvePermissionEntry(permEntry, "no-decision", "Client disconnected", CLIENT_DISCONNECTED_OPTIONS);
        };
        permEntry.abortHandler = abortHandler;
        res.on("close", abortHandler);
        addPendingPermission(ctx, permEntry);
        recordRequestHookEvent.accepted();
        try {
          ctx.showPermissionBubble(permEntry);
        } catch (bubbleErr) {
          ctx.permLog(`elicitation bubble failed: ${bubbleErr && bubbleErr.message} -> terminal fallback`);
          removePendingPermission(ctx, permEntry, "elicitation-bubble-failed");
          if (permEntry.abortHandler) res.removeListener("close", permEntry.abortHandler);
          if (permEntry.autoCloseTimer) { clearTimeout(permEntry.autoCloseTimer); permEntry.autoCloseTimer = null; }
          if (permEntry.hideTimer) { clearTimeout(permEntry.hideTimer); permEntry.hideTimer = null; }
          if (permEntry.bubble && !permEntry.bubble.isDestroyed()) {
            try { permEntry.bubble.destroy(); } catch {}
          }
          permEntry.bubble = null;
          ctx.sendPermissionResponse(res, "deny", "Elicitation bubble unavailable; answer in terminal", "Elicitation");
          return;
        }
        if (Array.isArray(elicitationInput.questions) && elicitationInput.questions.length > 0) {
          startRemoteApproval(ctx, permEntry);
        }
        return;
      }

      const permEntry = {
        res,
        abortHandler: null,
        suggestions,
        sessionId,
        ...trustedSessionFields(sessionIdentity),
        bubble: null,
        hideTimer: null,
        toolName,
        toolInput,
        toolUseId,
        toolInputFingerprint,
        resolvedSuggestion: null,
        createdAt: Date.now(),
        interaction,
        sessionAutomationIdentity,
        agentId: permAgentId,
        subagentId,
        subagentType,
      };
      const abortHandler = () => {
        if (res.writableFinished) return;
        ctx.permLog("abortHandler fired");
        ctx.resolvePermissionEntry(permEntry, "no-decision", "Client disconnected", CLIENT_DISCONNECTED_OPTIONS);
      };
      permEntry.abortHandler = abortHandler;
      res.on("close", abortHandler);

      addPendingPermission(ctx, permEntry);

      // Play notification animation on the pet body so the bubble doesn't
      // appear "silently". Mirrors the other permission-notification branches
      // and the Elicitation branch above. state.js:581 has a special
      // PermissionRequest branch that setStates notification without
      // mutating session state — so working/thinking is preserved for resolve.
      ctx.updateSession(sessionId, "notification", "PermissionRequest", {
        agentId: permAgentId,
        sessionAutomationIdentity,
        ...trustedSessionFields(sessionIdentity),
      });

      ctx.permLog(`showing bubble: tool=${toolName} session=${sessionId} suggestions=${suggestions.length} stack=${ctx.pendingPermissions.length}`);
      recordRequestHookEvent.accepted();
      try {
        ctx.showPermissionBubble(permEntry);
      } catch (bubbleErr) {
        // Mirror the Codex branch: a BrowserWindow construction failure
        // here would leave a ghost permEntry in pendingPermissions because
        // abortHandler only fires on res close. Pop the entry explicitly and
        // destroy the socket so CC falls back to its built-in chat prompt
        // (non-blocking error per hooks doc) instead of hanging on a stale
        // bubble that was never visible. showPermissionBubble assigns
        // permEntry.bubble before loadFile/showInactive/reposition, so a
        // throw after that point leaves a partially-constructed window —
        // tear it down along with any timers we've armed.
        ctx.permLog(`bubble failed: ${bubbleErr && bubbleErr.message} -> drop connection, chat fallback`);
        removePendingPermission(ctx, permEntry, "bubble-failed");
        if (permEntry.abortHandler) res.removeListener("close", permEntry.abortHandler);
        if (permEntry.autoCloseTimer) { clearTimeout(permEntry.autoCloseTimer); permEntry.autoCloseTimer = null; }
        if (permEntry.hideTimer) { clearTimeout(permEntry.hideTimer); permEntry.hideTimer = null; }
        if (permEntry.bubble && !permEntry.bubble.isDestroyed()) {
          try { permEntry.bubble.destroy(); } catch {}
        }
        permEntry.bubble = null;
        try { res.destroy(); } catch {}
        return;
      }
      startRemoteApproval(ctx, permEntry);
    } catch (err) {
      ctx.permLog(`/permission handler error: ${err && err.message}`);
      // Response may already be sent (opencode branch 200-ACKs before
      // processing), so guard against a second writeHead.
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("internal error");
      }
    }
  });
}

module.exports = {
  MAX_PERMISSION_BODY_BYTES,
  shouldBypassCCBubble,
  shouldBypassCCSubagentBubble,
  shouldBypassCodexBubble,
  shouldBypassQwenCodeBubble,
  shouldBypassCopilotBubble,
  shouldBypassFamilyBubble,
  arePermissionBubblesEnabled,
  shouldInterceptCodexPermission,
  shouldMuteCodexNativeNotificationSound,
  sendCodexPermissionNoDecision,
  sendQwenCodePermissionNoDecision,
  sendCopilotPermissionNoDecision,
  sendPiPermissionAllow,
  sendAntigravityPermissionNoDecision,
  sendDshPermissionNoDecision,
  sendHermesPermissionNoDecision,
  shouldBypassDshBubble,
  shouldBypassHermesBubble,
  handlePermissionPost,
};
