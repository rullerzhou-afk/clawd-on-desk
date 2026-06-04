"use strict";

const path = require("path");
const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
} = require("../hooks/server-config");
const {
  normalizeHookToolUseId,
  findPendingPermissionForStateEvent,
} = require("./server-permission-utils");
const { resolveHookAgentId } = require("./server-agent-id");
const { resolveCodexOfficialHookState } = require("./server-codex-official-turns");

// /state POST body size cap. Raised from 1024 to 4096 to give new fields
// (session_title) headroom on top of cwd / pid_chain / host / etc. Still a
// local-only 127.0.0.1 endpoint - not an Internet DoS concern.
const MAX_STATE_BODY_BYTES = 4096;
const ASSISTANT_LAST_OUTPUT_MAX = 2400;

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

  if (value.source === "claude" || value.source === "codex") out.source = value.source;
  return out;
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
    pathApi = path,
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
      const recordRequestHookEvent = createRequestHookRecorder(data, "state");
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
      const rawAgentPid = data.agent_pid ?? data.claude_pid ?? data.cursor_pid;
      const agentPid = Number.isFinite(rawAgentPid) && rawAgentPid > 0 ? Math.floor(rawAgentPid) : null;
      const agentIdentity = resolveHookAgentId(data);
      const agentId = agentIdentity.agentId;
      const host = typeof data.host === "string" ? data.host : null;
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
      const assistantLastOutput = normalizeAssistantLastOutput(data.assistant_last_output);
      const assistantLastOutputTruncated = data.assistant_last_output_truncated === true;
      const permissionSuspect = data.permission_suspect === true;
      const preserveState = data.preserve_state === true;
      const hookSource = typeof data.hook_source === "string" ? data.hook_source : null;
      // #406 completion-gate inputs from the Claude Stop hook. Counts / boolean
      // only — the hook never forwards task command or description text.
      const backgroundTasksCount = Number.isFinite(data.background_tasks_count)
        ? data.background_tasks_count : 0;
      const sessionCronsCount = Number.isFinite(data.session_crons_count)
        ? data.session_crons_count : 0;
      const stopHookActive = data.stop_hook_active === true;
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
      if (ctx.STATE_SVGS[state]) {
        const sid = session_id || "default";
        const codexHookState = resolveCodexOfficialHookState(
          data,
          state,
          codexOfficialTurns,
          ctx.codexSubagentClassifier
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
        if (event === "PostToolUse" || event === "PostToolUseFailure" || event === "Stop") {
          const perm = findPendingPermissionForStateEvent(ctx.pendingPermissions, {
            sessionId: sid,
            toolName,
            toolUseId,
            toolInputFingerprint,
            allowSingletonFallback: event === "Stop",
          });
          if (perm) {
            const behavior = perm.isQwenCode ? "no-decision" : "deny";
            ctx.resolvePermissionEntry(perm, behavior, "User answered in terminal");
          }
          // Stale blocking-tool sweep: both AskUserQuestion (elicitation) and
          // ExitPlanMode (plan review) are blocking tool calls. Any forward
          // progress in the same session means the user already answered in the
          // terminal. The exact-match above may miss the entry when tool_use_id
          // or tool_input_fingerprint diverge between /permission and /state.
          for (const stale of [...ctx.pendingPermissions]) {
            if (
              stale !== perm
              && stale.res
              && stale.sessionId === sid
              && (stale.isElicitation || stale.toolName === "ExitPlanMode")
            ) {
              ctx.resolvePermissionEntry(stale, "deny", "User answered in terminal");
            }
          }
        }
        // Stale ExitPlanMode sweep for events outside the PostToolUse/Stop block:
        // UserPromptSubmit = user typed feedback in plan TUI ("Tell Claude what to
        // change"); PreToolUse(non-ExitPlanMode) = Claude started executing after
        // plan approval; SessionEnd = session torn down.
        if (
          event === "UserPromptSubmit"
          || event === "SessionEnd"
          || (event === "PreToolUse" && toolName !== "ExitPlanMode")
        ) {
          for (const stale of [...ctx.pendingPermissions]) {
            if (
              stale
              && stale.res
              && stale.sessionId === sid
              && stale.toolName === "ExitPlanMode"
            ) {
              ctx.resolvePermissionEntry(stale, "deny", "Plan dialog dismissed in terminal");
            }
          }
        }
        recordRequestHookEvent.acceptedUnlessDnd(shouldDropForDnd());
        if (svg) {
          const safeSvg = pathApi.basename(svg);
          ctx.setState(state, safeSvg);
        } else {
          ctx.updateSession(sid, state, event, {
            sourcePid: source_pid,
            wtHwnd,
            cwd,
            editor,
            pidChain,
            agentPid,
            agentId,
            host,
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
            assistantLastOutput,
            assistantLastOutputTruncated,
            permissionSuspect,
            preserveState,
            hookSource,
            backgroundTasksCount,
            sessionCronsCount,
            stopHookActive,
            ...(agentIdentity.defaulted ? { agentIdDefaulted: true } : {}),
          });
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
  sendStateHealthResponse,
  handleStatePost,
};
