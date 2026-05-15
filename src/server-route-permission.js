"use strict";

const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
} = require("../hooks/server-config");
const { CODEX_OFFICIAL_HOOK_SOURCE } = require("./server-codex-official-turns");
const {
  truncateDeep,
  normalizePermissionSuggestions,
  normalizeElicitationToolInput,
  normalizeHookToolUseId,
  normalizeCodexPermissionToolInput,
  buildToolInputFingerprint,
} = require("./server-permission-utils");

const MAX_PERMISSION_BODY_BYTES = 524288;

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
function shouldBypassCCBubble(ctx, toolName, agentId) {
  if (toolName === "ExitPlanMode" || toolName === "AskUserQuestion") return false;
  if (!arePermissionBubblesEnabled(ctx)) return true;
  if (typeof ctx.isAgentPermissionsEnabled !== "function") return false;
  return !ctx.isAgentPermissionsEnabled(agentId);
}

function shouldBypassOpencodeBubble(ctx) {
  if (typeof ctx.isAgentPermissionsEnabled !== "function") return false;
  return !ctx.isAgentPermissionsEnabled("opencode");
}

function shouldBypassPiBubble(ctx) {
  if (!arePermissionBubblesEnabled(ctx)) return true;
  if (typeof ctx.isAgentPermissionsEnabled !== "function") return false;
  return !ctx.isAgentPermissionsEnabled("pi");
}

function shouldBypassCodexBubble(ctx) {
  if (!arePermissionBubblesEnabled(ctx)) return true;
  if (typeof ctx.isAgentPermissionsEnabled !== "function") return false;
  return !ctx.isAgentPermissionsEnabled("codex");
}

function shouldInterceptCodexPermission(ctx) {
  if (typeof ctx.isCodexPermissionInterceptEnabled !== "function") return true;
  return ctx.isCodexPermissionInterceptEnabled();
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

function normalizePositiveInteger(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
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
  const cwd = normalizeString(data.cwd);
  const host = normalizeString(data.host);
  const platform = normalizeString(data.platform);
  const model = normalizeString(data.model);
  const codexOriginator = normalizeString(data.codex_originator);
  const codexSource = normalizeString(data.codex_source);
  if (cwd) options.cwd = cwd;
  if (host) options.host = host;
  if (platform) options.platform = platform;
  if (model) options.model = model;
  if (codexOriginator) options.codexOriginator = codexOriginator;
  if (codexSource) options.codexSource = codexSource;
  return options;
}

function sendCodexPermissionNoDecision(res) {
  res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
  res.end();
}

function sendPiPermissionNoDecision(res) {
  res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
  res.end();
}

function handlePermissionPost(req, res, options) {
  const {
    ctx,
    createRequestHookRecorder,
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
    const recordRequestHookEvent = createRequestHookRecorder(data, "permission");

    try {
      // ── opencode branch ──
      // opencode plugin (agents/opencode.js) posts fire-and-forget. We
      // always 200 ACK immediately; the user's decision routes through
      // a separate REST call to opencode's own server (see permission.js
      // replyOpencodePermission). This means no res is retained on the
      // permEntry, no res.on("close") abort handler, and hideBubbles
      // degrades to "TUI only" (plugin doesn't wait on us).
      //
      // DND handling is branch-specific: opencode cannot observe the
      // HTTP response (fire-and-forget), so a generic HTTP deny would
      // leave the TUI hanging until timeout. Instead we route DND
      // through the same reverse bridge the plugin uses for replies.
      if (data.agent_id === "opencode") {
        res.writeHead(200, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
        res.end("ok");

        // Agent gate: same silent-drop semantics as DND — plugin is
        // fire-and-forget, so 200 ACK satisfies it; skipping the bridge
        // reply lets the opencode TUI fall back to its built-in prompt.
        if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled("opencode")) {
          recordRequestHookEvent.droppedByDisabled();
          ctx.permLog("opencode disabled → silent drop, TUI fallback");
          return;
        }

        const toolName = typeof data.tool_name === "string" && data.tool_name ? data.tool_name : "unknown";
        const rawInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
        const toolInput = truncateDeep(rawInput);
        const sessionId = typeof data.session_id === "string" ? data.session_id : "default";
        const requestId = typeof data.request_id === "string" ? data.request_id : null;
        const bridgeUrl = typeof data.bridge_url === "string" ? data.bridge_url : "";
        const bridgeToken = typeof data.bridge_token === "string" ? data.bridge_token : "";
        const alwaysCandidates = Array.isArray(data.always) ? data.always : [];
        const patterns = Array.isArray(data.patterns) ? data.patterns : [];

        ctx.permLog(`opencode perm: tool=${toolName} session=${sessionId} req=${requestId} bridge=${bridgeUrl} always=${alwaysCandidates.length}`);

        // bridge_url/bridge_token are required — this is the reverse
        // channel Clawd uses to send the decision back to the plugin,
        // which then calls opencode's in-process Hono route. Without it
        // we have no way to resolve the pending permission.
        if (!requestId || !bridgeUrl || !bridgeToken) {
          const missing = !requestId ? "request_id" : (!bridgeUrl ? "bridge_url" : "bridge_token");
          recordRequestHookEvent.accepted();
          ctx.permLog(`SKIPPED opencode perm: missing ${missing}`);
          return;
        }

        // DND: drop silently — do NOT reply via bridge. opencode TUI
        // will fall back to its built-in permission prompt so the user
        // can confirm in the terminal themselves. Spike 2026-04-06
        // confirmed this works: TUI shows Allow/Reject without hanging.
        if (ctx.doNotDisturb) {
          recordRequestHookEvent.droppedByDnd();
          ctx.permLog(`opencode DND → silent drop, TUI fallback — request=${requestId}`);
          return;
        }

        // No HTTP connection to hold open — only degradation is to
        // not render a bubble and let the TUI prompt handle it.
        const opencodeSubGateBypass = shouldBypassOpencodeBubble(ctx);
        if (!arePermissionBubblesEnabled(ctx) || opencodeSubGateBypass) {
          recordRequestHookEvent.accepted();
          ctx.permLog(`opencode bubble hidden: tool=${toolName} — TUI fallback (permissionBubblesEnabled=${arePermissionBubblesEnabled(ctx)} subGateBypass=${opencodeSubGateBypass})`);
          return;
        }

        const permEntry = {
          res: null,
          abortHandler: null,
          suggestions: [],
          sessionId,
          bubble: null,
          hideTimer: null,
          toolName,
          toolInput,
          resolvedSuggestion: null,
          createdAt: Date.now(),
          agentId: "opencode",
          isOpencode: true,
          opencodeRequestId: requestId,
          opencodeBridgeUrl: bridgeUrl,
          opencodeBridgeToken: bridgeToken,
          opencodeAlwaysCandidates: alwaysCandidates,
          opencodePatterns: patterns,
        };
        ctx.pendingPermissions.push(permEntry);
        // Play notification animation on the pet body so the bubble doesn't
        // appear "silently". Mirrors the Codex path (main.js showCodexNotifyBubble)
        // and the Elicitation branch below. state.js:581 has a special
        // PermissionRequest branch that setStates notification without
        // mutating session state — so working/thinking is preserved for resolve.
        ctx.updateSession(sessionId, "notification", "PermissionRequest", { agentId: "opencode" });
        ctx.permLog(`opencode showing bubble: tool=${toolName} session=${sessionId}`);
        recordRequestHookEvent.accepted();
        try {
          ctx.showPermissionBubble(permEntry);
        } catch (bubbleErr) {
          // If bubble creation fails (BrowserWindow error, bad html,
          // window-positioning crash, etc), we have already 200-ACKed
          // the plugin and it is waiting for a bridge reply. Without
          // this rescue the permEntry would linger in pendingPermissions
          // until the opencode TUI hits its own timeout (minutes).
          // Pop the ghost entry and send an immediate reject so the
          // TUI unblocks and the user can re-answer in the terminal.
          ctx.permLog(`opencode bubble failed: ${bubbleErr && bubbleErr.message} — reject via bridge`);
          const popIdx = ctx.pendingPermissions.indexOf(permEntry);
          if (popIdx !== -1) ctx.pendingPermissions.splice(popIdx, 1);
          ctx.replyOpencodePermission({ bridgeUrl, bridgeToken, requestId, reply: "reject", toolName });
        }
        return;
      }

      // ── Codex official PermissionRequest branch ──
      // The hook is blocking, but fallback must be no-decision rather than
      // Deny: Codex will then continue to its native approval prompt.
      if (data.agent_id === "codex") {
        const toolName = typeof data.tool_name === "string" && data.tool_name ? data.tool_name : "Unknown";
        const rawInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
        const description = typeof data.tool_input_description === "string" && data.tool_input_description
          ? data.tool_input_description
          : (typeof rawInput.description === "string" ? rawInput.description : "");
        const toolInput = normalizeCodexPermissionToolInput(rawInput, description);
        const sessionId = typeof data.session_id === "string" && data.session_id ? data.session_id : "codex:default";
        const toolUseId = normalizeHookToolUseId(
          data.tool_use_id ?? data.toolUseId ?? data.toolUseID
        );
        const toolInputFingerprint = typeof data.tool_input_fingerprint === "string" && data.tool_input_fingerprint
          ? data.tool_input_fingerprint
          : buildToolInputFingerprint(rawInput);
        const codexSessionOptions = buildCodexPermissionSessionOptions(data);

        if (ctx.doNotDisturb) {
          recordRequestHookEvent.droppedByDnd();
          ctx.permLog(`codex DND -> no decision, native prompt fallback (tool=${toolName})`);
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
          ctx.updateSession(sessionId, "notification", "PermissionRequest", codexSessionOptions);
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

        const permEntry = {
          res,
          abortHandler: null,
          suggestions: [],
          sessionId,
          bubble: null,
          hideTimer: null,
          toolName,
          toolInput,
          toolUseId,
          toolInputFingerprint,
          resolvedSuggestion: null,
          createdAt: Date.now(),
          agentId: "codex",
          isCodex: true,
          sourcePid: codexSessionOptions.sourcePid || null,
          cwd: codexSessionOptions.cwd || "",
          agentPid: codexSessionOptions.agentPid || null,
          pidChain: codexSessionOptions.pidChain || null,
          host: codexSessionOptions.host || null,
          platform: codexSessionOptions.platform || null,
          model: codexSessionOptions.model || null,
          codexOriginator: codexSessionOptions.codexOriginator || null,
          codexSource: codexSessionOptions.codexSource || null,
        };
        const abortHandler = () => {
          if (res.writableFinished) return;
          ctx.permLog("abortHandler fired (codex)");
          ctx.resolvePermissionEntry(permEntry, "no-decision", "Client disconnected");
        };
        permEntry.abortHandler = abortHandler;
        res.on("close", abortHandler);

        ctx.pendingPermissions.push(permEntry);
        ctx.updateSession(sessionId, "notification", "PermissionRequest", codexSessionOptions);

        ctx.permLog(`codex showing bubble: tool=${toolName} session=${sessionId} stack=${ctx.pendingPermissions.length}`);
        recordRequestHookEvent.accepted();
        try {
          ctx.showPermissionBubble(permEntry);
        } catch (bubbleErr) {
          ctx.permLog(`codex bubble failed: ${bubbleErr && bubbleErr.message} -> no decision`);
          const popIdx = ctx.pendingPermissions.indexOf(permEntry);
          if (popIdx !== -1) ctx.pendingPermissions.splice(popIdx, 1);
          if (permEntry.abortHandler) res.removeListener("close", permEntry.abortHandler);
          sendCodexPermissionNoDecision(res);
        }
        return;
      }

      // ── Pi extension PermissionRequest branch ──
      // Pi waits synchronously on tool_call handlers but has no native
      // permission prompt. Any Clawd-side no-decision must therefore return
      // promptly so the extension can call ctx.ui.confirm() in the terminal.
      if (data.agent_id === "pi") {
        const toolName = typeof data.tool_name === "string" && data.tool_name ? data.tool_name : "unknown";
        const rawInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
        const toolInput = truncateDeep(rawInput);
        const sessionId = typeof data.session_id === "string" && data.session_id ? data.session_id : "pi:default";
        const toolUseId = normalizeHookToolUseId(
          data.tool_use_id ?? data.toolUseId ?? data.toolUseID
        );
        const toolInputFingerprint = buildToolInputFingerprint(rawInput);

        if (ctx.doNotDisturb) {
          recordRequestHookEvent.droppedByDnd();
          ctx.permLog(`pi DND -> no decision, terminal fallback (tool=${toolName})`);
          sendPiPermissionNoDecision(res);
          return;
        }

        if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled("pi")) {
          recordRequestHookEvent.droppedByDisabled();
          ctx.permLog(`pi disabled -> no decision, terminal fallback (tool=${toolName})`);
          sendPiPermissionNoDecision(res);
          return;
        }

        if (shouldBypassPiBubble(ctx)) {
          recordRequestHookEvent.accepted();
          const reason = !arePermissionBubblesEnabled(ctx)
            ? "permission bubbles disabled"
            : "pi bubbles disabled";
          ctx.permLog(`${reason} -> no decision, terminal fallback (tool=${toolName})`);
          sendPiPermissionNoDecision(res);
          return;
        }

        const permEntry = {
          res,
          abortHandler: null,
          suggestions: [],
          sessionId,
          bubble: null,
          hideTimer: null,
          toolName,
          toolInput,
          toolUseId,
          toolInputFingerprint,
          resolvedSuggestion: null,
          createdAt: Date.now(),
          agentId: "pi",
          isPi: true,
        };
        const abortHandler = () => {
          if (res.writableFinished) return;
          ctx.permLog("abortHandler fired (pi)");
          ctx.resolvePermissionEntry(permEntry, "no-decision", "Client disconnected");
        };
        permEntry.abortHandler = abortHandler;
        res.on("close", abortHandler);

        ctx.pendingPermissions.push(permEntry);
        ctx.updateSession(sessionId, "notification", "PermissionRequest", { agentId: "pi" });

        ctx.permLog(`pi showing bubble: tool=${toolName} session=${sessionId} stack=${ctx.pendingPermissions.length}`);
        recordRequestHookEvent.accepted();
        try {
          ctx.showPermissionBubble(permEntry);
        } catch (bubbleErr) {
          ctx.permLog(`pi bubble failed: ${bubbleErr && bubbleErr.message} -> no decision`);
          const popIdx = ctx.pendingPermissions.indexOf(permEntry);
          if (popIdx !== -1) ctx.pendingPermissions.splice(popIdx, 1);
          if (permEntry.abortHandler) res.removeListener("close", permEntry.abortHandler);
          sendPiPermissionNoDecision(res);
        }
        return;
      }

      // ── Claude Code branch ──
      // DND: destroy connection — do NOT send deny on the user's behalf.
      // CC falls back to its built-in chat permission prompt so the user
      // decides themselves. Spike 2026-04-07 confirmed: CC shows Allow/
      // Deny in chat, no hang, no timeout. Same pattern as opencode
      // silent drop (95cbfc7).
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
      const ccAgentId = typeof data.agent_id === "string" && data.agent_id ? data.agent_id : "claude-code";
      if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled(ccAgentId)) {
        recordRequestHookEvent.droppedByDisabled();
        ctx.permLog(`${ccAgentId} disabled → destroy connection, chat fallback`);
        res.destroy();
        return;
      }

      const toolName = typeof data.tool_name === "string" ? data.tool_name : "Unknown";
      const rawInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
      const toolInput = truncateDeep(rawInput);
      const toolUseId = normalizeHookToolUseId(
        data.tool_use_id ?? data.toolUseId ?? data.toolUseID
      );
      const toolInputFingerprint = buildToolInputFingerprint(rawInput);
      const sessionId = data.session_id || "default";
      // Tag the permEntry with the source agent. Clawd's HTTP permission
      // path is shared between Claude Code and codebuddy (both set
      // capabilities.permissionApproval=true and POST here). Stamping lets
      // dismissPermissionsByAgent() clean up the right ones when the user
      // disables an agent mid-flight.
      const permAgentId = typeof data.agent_id === "string" && data.agent_id ? data.agent_id : "claude-code";
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

      if (shouldBypassCCBubble(ctx, toolName, permAgentId)) {
        recordRequestHookEvent.accepted();
        const reason = !arePermissionBubblesEnabled(ctx)
          ? "permission bubbles disabled"
          : `${permAgentId} bubbles disabled`;
        ctx.permLog(`${reason} → destroy connection, chat fallback (tool=${toolName})`);
        res.destroy();
        return;
      }

      // Elicitation (AskUserQuestion) — show notification bubble, not permission bubble.
      // User clicks "Go to Terminal" → deny → Claude Code falls back to terminal.
      if (toolName === "AskUserQuestion") {
        const elicitationInput = normalizeElicitationToolInput(toolInput);
        ctx.permLog(`ELICITATION: tool=${toolName} session=${sessionId}`);
        ctx.updateSession(sessionId, "notification", "Elicitation", { agentId: "claude-code" });

        const permEntry = {
          res,
          abortHandler: null,
          suggestions: [],
          sessionId,
          bubble: null,
          hideTimer: null,
          toolName,
          toolInput: elicitationInput,
          toolUseId,
          toolInputFingerprint,
          resolvedSuggestion: null,
          createdAt: Date.now(),
          isElicitation: true,
          agentId: permAgentId,
        };
        const abortHandler = () => {
          if (res.writableFinished) return;
          ctx.permLog("abortHandler fired (elicitation)");
          ctx.resolvePermissionEntry(permEntry, "deny", "Client disconnected");
        };
        permEntry.abortHandler = abortHandler;
        res.on("close", abortHandler);
        ctx.pendingPermissions.push(permEntry);
        recordRequestHookEvent.accepted();
        ctx.showPermissionBubble(permEntry);
        return;
      }

      const permEntry = {
        res,
        abortHandler: null,
        suggestions,
        sessionId,
        bubble: null,
        hideTimer: null,
        toolName,
        toolInput,
        toolUseId,
        toolInputFingerprint,
        resolvedSuggestion: null,
        createdAt: Date.now(),
        agentId: permAgentId,
      };
      const abortHandler = () => {
        if (res.writableFinished) return;
        ctx.permLog("abortHandler fired");
        ctx.resolvePermissionEntry(permEntry, "deny", "Client disconnected");
      };
      permEntry.abortHandler = abortHandler;
      res.on("close", abortHandler);

      ctx.pendingPermissions.push(permEntry);

      // Play notification animation on the pet body so the bubble doesn't
      // appear "silently". Mirrors the Codex path (main.js showCodexNotifyBubble)
      // and the Elicitation branch above. state.js:581 has a special
      // PermissionRequest branch that setStates notification without
      // mutating session state — so working/thinking is preserved for resolve.
      ctx.updateSession(sessionId, "notification", "PermissionRequest", { agentId: permAgentId });

      ctx.permLog(`showing bubble: tool=${toolName} session=${sessionId} suggestions=${suggestions.length} stack=${ctx.pendingPermissions.length}`);
      recordRequestHookEvent.accepted();
      try {
        ctx.showPermissionBubble(permEntry);
      } catch (bubbleErr) {
        // Mirror the Codex/Pi branches: a BrowserWindow construction failure
        // here would leave a ghost permEntry in pendingPermissions because
        // abortHandler only fires on res close. Pop the entry explicitly and
        // destroy the socket so CC falls back to its built-in chat prompt
        // (non-blocking error per hooks doc) instead of hanging on a stale
        // bubble that was never visible. showPermissionBubble assigns
        // permEntry.bubble before loadFile/showInactive/reposition, so a
        // throw after that point leaves a partially-constructed window —
        // tear it down along with any timers we've armed.
        ctx.permLog(`bubble failed: ${bubbleErr && bubbleErr.message} -> drop connection, chat fallback`);
        const popIdx = ctx.pendingPermissions.indexOf(permEntry);
        if (popIdx !== -1) ctx.pendingPermissions.splice(popIdx, 1);
        if (permEntry.abortHandler) res.removeListener("close", permEntry.abortHandler);
        if (permEntry.autoCloseTimer) { clearTimeout(permEntry.autoCloseTimer); permEntry.autoCloseTimer = null; }
        if (permEntry.hideTimer) { clearTimeout(permEntry.hideTimer); permEntry.hideTimer = null; }
        if (permEntry.bubble && !permEntry.bubble.isDestroyed()) {
          try { permEntry.bubble.destroy(); } catch {}
        }
        permEntry.bubble = null;
        try { res.destroy(); } catch {}
      }
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
  shouldBypassCodexBubble,
  shouldBypassOpencodeBubble,
  shouldBypassPiBubble,
  arePermissionBubblesEnabled,
  shouldInterceptCodexPermission,
  sendCodexPermissionNoDecision,
  sendPiPermissionNoDecision,
  handlePermissionPost,
};
