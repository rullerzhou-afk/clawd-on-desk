#!/usr/bin/env node
// Clawd Desktop Pet — Claude Code Hook Script
// Usage: node clawd-hook.js <event_name>
// Reads stdin JSON from Claude Code for session_id

const crypto = require("crypto");
const fs = require("fs");
const { postStateToRunningServer, readHostPrefix, resolveWslDistro } = require("./server-config");
const { fitStateBodyToByteBudget } = require("./state-payload-size");
const { extractClaudeContextUsageFromEntries } = require("./context-usage");
const { createPidResolver, readStdinJsonDetailed, getPlatformConfig, tmuxSocketFromEnv, processAlive } = require("./shared-process");
const pidCache = require("./pid-cache");

const isWin = process.platform === "win32";

const TRANSCRIPT_TAIL_BYTES = 262144; // 256 KB
// #583: claude-code registers this hook with async:true and a 5s timeout
// (hooks/install.js), so a 2s stdin window never stalls the agent. Do NOT
// raise the shared default in shared-process.js instead — other agent hooks
// run ~800ms stdout safety timers that must win against a slow stdin read.
const STDIN_READ_TIMEOUT_MS = 2000;
const ASSISTANT_OUTPUT_MAX = 2200;
// Observed in Claude Code 2.1.150 StopFailure hook schema (tyq enum).
// Unknown values from future versions fall back to "unknown".
const API_ERROR_TYPES = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
  "rate_limit",
  "invalid_request",
  "model_not_found",
  "server_error",
  "unknown",
  "max_output_tokens",
]);
const SESSION_TITLE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]+/g;
const SESSION_TITLE_MAX = 80;
const PROMPT_TITLE_MAX = 40;
const PROMPT_TITLE_SECRET_RE =
  /\b(api[_-]?key|authorization|bearer|password|passwd|private[_-]?key|secret|token)\b|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|[A-Za-z0-9+/=_-]{32,}/i;
const TOOL_MATCH_STRING_MAX = 240;
const TOOL_MATCH_ARRAY_MAX = 16;
const TOOL_MATCH_OBJECT_KEYS_MAX = 32;
const TOOL_MATCH_DEPTH_MAX = 6;
const ASSISTANT_OUTPUT_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001F\u007F-\u009F]+/g;

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

function normalizeTitleWithMax(value, maxLen) {
  const title = normalizeTitle(value);
  if (!title || title.length <= maxLen) return title;
  return `${title.slice(0, maxLen - 1)}\u2026`;
}

function looksSecretishPromptTitle(value) {
  if (typeof value !== "string") return false;
  return PROMPT_TITLE_SECRET_RE.test(value);
}

function extractPromptTitle(prompt) {
  if (typeof prompt !== "string") return null;
  for (const line of prompt.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate) continue;
    if (looksSecretishPromptTitle(candidate)) return null;
    return normalizeTitleWithMax(candidate, PROMPT_TITLE_MAX);
  }
  return null;
}

// Read the tail of a Claude Code transcript JSONL and return parsed entries.
// Skips the truncated first line when the tail is a partial read, and silently
// drops lines that fail JSON.parse. Returns null if the file is missing or
// unreadable.
function readTranscriptTailEntries(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;

  let data;
  let truncated = false;
  let fd = null;
  try {
    const stat = fs.statSync(transcriptPath);
    fd = fs.openSync(transcriptPath, "r");
    const readLen = Math.min(stat.size, TRANSCRIPT_TAIL_BYTES);
    truncated = stat.size > readLen;
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, Math.max(0, stat.size - readLen));
    data = buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  const lines = data.split("\n");
  if (truncated && lines.length > 1) lines.shift();

  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj && typeof obj === "object") entries.push(obj);
  }
  return entries;
}

function extractSessionTitleFromEntries(entries) {
  if (!entries) return null;
  let latest = null;
  for (const obj of entries) {
    const type = typeof obj.type === "string" ? obj.type : "";
    if (type !== "custom-title" && type !== "agent-name") continue;
    latest =
      normalizeTitle(obj.customTitle) ||
      normalizeTitle(obj.title) ||
      normalizeTitle(obj.custom_title) ||
      normalizeTitle(obj.agentName) ||
      normalizeTitle(obj.agent_name) ||
      latest;
  }
  return latest;
}

function extractSessionTitleFromTranscript(transcriptPath) {
  return extractSessionTitleFromEntries(readTranscriptTailEntries(transcriptPath));
}

function normalizeAssistantOutputText(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(ASSISTANT_OUTPUT_CONTROL_RE, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function clampAssistantOutputText(text, maxLen = ASSISTANT_OUTPUT_MAX) {
  const normalized = normalizeAssistantOutputText(text);
  const max = Number.isInteger(maxLen) && maxLen > 0 ? maxLen : ASSISTANT_OUTPUT_MAX;
  if (!normalized) return null;
  if (normalized.length <= max) return { text: normalized, truncated: false };

  const marker = "\n...[truncated]...\n";
  if (max <= marker.length + 20) {
    return { text: normalized.slice(Math.max(0, normalized.length - max)), truncated: true };
  }
  const keep = max - marker.length;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return {
    text: `${normalized.slice(0, head)}${marker}${normalized.slice(normalized.length - tail)}`,
    truncated: true,
  };
}

function assistantEntryMatchesSession(entry, sessionId) {
  if (!sessionId) return true;
  if (!entry || typeof entry !== "object") return false;
  return !entry.sessionId || entry.sessionId === sessionId;
}

function assistantEntryLooksSubagent(entry) {
  if (!entry || typeof entry !== "object") return false;
  return entry.isSidechain === true
    || entry.isSubagent === true
    || entry.is_subagent === true
    || entry.subagent === true;
}

function assistantEntryIsTurnBoundary(entry, sessionId) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.type !== "user") return false;
  return assistantEntryMatchesSession(entry, sessionId);
}

function assistantTextPartsFromContent(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "tool_use" || type === "server_tool_use") continue;
    if ((type === "text" || type === "output_text") && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts;
}

function assistantTextFromEntry(entry) {
  if (!entry || typeof entry !== "object") return "";
  const message = entry.message && typeof entry.message === "object" ? entry.message : null;
  const content = message && Object.prototype.hasOwnProperty.call(message, "content")
    ? message.content
    : entry.content;
  return normalizeAssistantOutputText(assistantTextPartsFromContent(content).join("\n\n"));
}

function extractLastAssistantTextFromEntries(entries, sessionId, options = {}) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const maxLen = Number.isInteger(options.maxLen) && options.maxLen > 0
    ? options.maxLen
    : ASSISTANT_OUTPUT_MAX;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object") continue;
    if (assistantEntryIsTurnBoundary(entry, sessionId)) break;
    if (entry.type !== "assistant") continue;
    if (entry.isApiErrorMessage === true) continue;
    if (!assistantEntryMatchesSession(entry, sessionId)) continue;
    if (assistantEntryLooksSubagent(entry)) continue;
    const text = assistantTextFromEntry(entry);
    if (!text) continue;
    return clampAssistantOutputText(text, maxLen);
  }
  return null;
}

// Find the most recent isApiErrorMessage entry for the current session, but
// only if it belongs to the current turn. A current-turn API error has no
// later "user" or non-error "assistant" entry — those indicate the turn has
// moved on (user re-prompted or model recovered) and the error is stale.
// See docs/investigations/api-error-race-condition.md for the 11-sample basis.
function extractApiErrorFromEntries(entries, sessionId) {
  if (!entries || !sessionId) return null;

  let lastErrorIndex = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.isApiErrorMessage !== true) continue;
    if (e.sessionId !== sessionId) continue;
    lastErrorIndex = i;
    break;
  }
  if (lastErrorIndex < 0) return null;

  for (let i = lastErrorIndex + 1; i < entries.length; i++) {
    const e = entries[i];
    const type = typeof e.type === "string" ? e.type : "";
    if (type === "user") return null;
    if (type === "assistant" && e.isApiErrorMessage !== true) return null;
  }

  const rawType = entries[lastErrorIndex].error;
  const apiErrorType = API_ERROR_TYPES.has(rawType) ? rawType : "unknown";
  return { api_error_type: apiErrorType };
}

function normalizeToolUseId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeToolMatchValue(value, depth = 0) {
  if (depth > TOOL_MATCH_DEPTH_MAX) return null;
  if (Array.isArray(value)) {
    return value
      .slice(0, TOOL_MATCH_ARRAY_MAX)
      .map((entry) => normalizeToolMatchValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort().slice(0, TOOL_MATCH_OBJECT_KEYS_MAX)) {
      out[key] = normalizeToolMatchValue(value[key], depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    return value.length > TOOL_MATCH_STRING_MAX
      ? `${value.slice(0, TOOL_MATCH_STRING_MAX - 1)}…`
      : value;
  }
  return value;
}

function buildToolInputFingerprint(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  const normalized = normalizeToolMatchValue(toolInput);
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

function shouldReportForegroundWtHwnd(event) {
  return event === "SessionStart" || event === "UserPromptSubmit";
}

const EVENT_TO_STATE = {
  SessionStart: "idle",
  SessionEnd: "sleeping",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "working",
  PostToolUseFailure: "error",
  Stop: "attention",
  StopFailure: "error",
  ApiError: "error",
  SubagentStart: "juggling",
  SubagentStop: "working",
  PreCompact: "sweeping",
  // PostCompact is "compaction finished", NOT turn completion (#406). Default to
  // thinking so the pet stays busy until work resumes (auto-compact continues
  // the task); buildStateBody downgrades a manual /compact to idle below. Either
  // way it must not be "attention" — compacting is not task done.
  PostCompact: "thinking",
  Notification: "notification",
  // PermissionRequest is handled by HTTP hook (blocking) — not command hook
  Elicitation: "notification",
  WorktreeCreate: "carrying",
};

function isTaskToolStart(event, payload) {
  // Claude Code may report subagent launches as PreToolUse(Task) without a
  // matching SubagentStart. Keep PostToolUse(Task) as a normal working update:
  // state.js holds juggling through working events and releases it on a later
  // Stop/UserPromptSubmit, or on a real SubagentStop if Claude emits one.
  return event === "PreToolUse"
    && payload
    && typeof payload.tool_name === "string"
    && payload.tool_name === "Task";
}

// #442-compat + #627: agent pid fields. Shared by the fresh-resolve and
// cache-hit paths so the `headless` derivation and the `claude_pid` backward-
// compat alias can never drift between them.
function applyAgentPidFields(body, agentPid, agentCommandLine) {
  if (!agentPid) return;
  body.agent_pid = agentPid;
  body.claude_pid = agentPid; // backward compat with older Clawd versions
  if (agentCommandLine && /\s(-p|--print)(\s|$)/.test(agentCommandLine)) {
    body.headless = true;
  }
}

// Fresh-resolve path: preserves the exact pre-cache field output (#627).
function applyResolvedFields(body, resolved, event) {
  const { stablePid, agentPid, agentCommandLine, detectedEditor, pidChain, foregroundWtHwnd, tmuxSocket, tmuxClient } = resolved;
  body.source_pid = stablePid;
  if (detectedEditor) body.editor = detectedEditor;
  applyAgentPidFields(body, agentPid, agentCommandLine);
  if (pidChain && pidChain.length) body.pid_chain = pidChain;
  if (tmuxSocket) body.tmux_socket = tmuxSocket;
  if (tmuxClient) body.tmux_client = tmuxClient;
  if (shouldReportForegroundWtHwnd(event) && foregroundWtHwnd) {
    body.wt_hwnd = String(foregroundWtHwnd);
  }
}

// Cache-hit path (#627): stable subset only. Deliberately omits pid_chain — the
// server MERGEs a missing pid_chain and keeps the SessionStart one, whereas the
// cached chain's head would be a dead per-event PowerShell — and wt_hwnd, which
// is only reported on the always-fresh SessionStart/UserPromptSubmit events.
// tmux_socket is a pure-env value, recomputed so a tmux user still gets it.
function applyCachedFields(body, cached) {
  body.source_pid = cached.stablePid;
  if (cached.detectedEditor) body.editor = cached.detectedEditor;
  applyAgentPidFields(body, cached.agentPid, cached.agentCommandLine);
  const tmuxSocket = tmuxSocketFromEnv();
  if (tmuxSocket) body.tmux_socket = tmuxSocket;
}

function buildStateBody(event, payload, resolve) {
  const state = EVENT_TO_STATE[event];
  if (!state) return null;

  const sessionId = payload.session_id || "default";
  const cwd = payload.cwd || "";
  const source = payload.source || payload.reason || "";
  const syntheticSubagentStart = isTaskToolStart(event, payload);

  // /clear triggers SessionEnd → SessionStart in quick succession;
  // show sweeping (clearing context) instead of sleeping
  // PostCompact: keep the EVENT_TO_STATE "thinking" for auto-compact (context
  // full, work resumes right after), but settle a manual /compact to idle.
  // Neither is "attention" anymore — see #406.
  const postCompactState = event === "PostCompact"
    ? (payload.trigger === "manual" ? "idle" : "thinking")
    : null;
  const resolvedState = syntheticSubagentStart
    ? "juggling"
    : (postCompactState
        || ((event === "SessionEnd" && source === "clear") ? "sweeping" : state));
  const resolvedEvent = syntheticSubagentStart ? "SubagentStart" : event;

  const body = { state: resolvedState, session_id: sessionId, event: resolvedEvent };
  body.agent_id = "claude-code";
  if (cwd) body.cwd = cwd;
  const toolName = typeof payload.tool_name === "string" && payload.tool_name ? payload.tool_name : null;
  const toolUseId = normalizeToolUseId(payload.tool_use_id ?? payload.toolUseId ?? payload.toolUseID);
  const toolInputFingerprint = buildToolInputFingerprint(
    payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : null
  );
  if (toolName) body.tool_name = toolName;
  if (toolUseId) body.tool_use_id = toolUseId;
  if (toolInputFingerprint) body.tool_input_fingerprint = toolInputFingerprint;
  if (event !== "Stop" && typeof payload.transcript_path === "string" && payload.transcript_path) {
    body.transcript_path = payload.transcript_path;
  }
  // Read transcript tail once and reuse for both session title extraction and
  // API error detection (Stop only). Avoids two file reads per hook invocation.
  const transcriptEntries = readTranscriptTailEntries(payload.transcript_path);
  // Pass the raw session id (null when the hook payload omits it), not the
  // "default" placeholder above: a transcript whose entries carry a real
  // sessionId must not be filtered out just because session_id was missing.
  const contextUsage = extractClaudeContextUsageFromEntries(
    transcriptEntries,
    payload.session_id || null,
  );
  if (contextUsage) body.context_usage = contextUsage;
  const sessionTitle =
    normalizeTitle(payload.session_title) ||
    extractSessionTitleFromEntries(transcriptEntries);
  if (sessionTitle) body.session_title = sessionTitle;
  if (event === "UserPromptSubmit" && !body.session_title) {
    const promptTitle = extractPromptTitle(payload.prompt);
    if (promptTitle) body.session_title = promptTitle;
  }

  // Claude Code synthesizes API errors into a fake assistant message tagged
  // isApiErrorMessage:true and emits a regular Stop hook (not StopFailure).
  // Upgrade Stop → ApiError when transcript tail shows a current-turn error.
  // See docs/investigations/api-error-race-condition.md.
  if (event === "Stop" && !syntheticSubagentStart) {
    const apiError = extractApiErrorFromEntries(transcriptEntries, sessionId);
    if (apiError) {
      body.event = "ApiError";
      body.state = "error";
      body.failure_kind = "api_error";
      body.api_error_type = apiError.api_error_type;
      body.error_present = true;
    } else {
      const assistantOutput = extractLastAssistantTextFromEntries(transcriptEntries, sessionId);
      if (assistantOutput && assistantOutput.text) {
        body.assistant_last_output = assistantOutput.text;
        if (assistantOutput.truncated) body.assistant_last_output_truncated = true;
      }
    }
  }
  // #406 completion-gate inputs. A Stop that still has live background shells or
  // cron wakeups, or a Stop-hook continuation (stop_hook_active), is not a real
  // turn completion. Forward only counts + the boolean — never the task
  // command/description — so state.js can suppress the celebration without
  // leaking shell contents into Clawd state.
  if (body.event === "Stop") {
    const bgCount = Array.isArray(payload.background_tasks) ? payload.background_tasks.length : 0;
    const cronCount = Array.isArray(payload.session_crons) ? payload.session_crons.length : 0;
    if (bgCount > 0) body.background_tasks_count = bgCount;
    if (cronCount > 0) body.session_crons_count = cronCount;
    if (payload.stop_hook_active === true) body.stop_hook_active = true;
  }
  const wslDistro = resolveWslDistro();
  if (process.env.CLAWD_REMOTE) {
    // Remote session: preserve existing host prefix, add WSL distro as
    // separate metadata. Do NOT override the SSH host.
    body.host = readHostPrefix();
    if (wslDistro) body.wsl_distro = wslDistro;
  } else {
    // #627: on Windows every hook event otherwise cold-starts a PowerShell to
    // snapshot the process tree, flashing a console window under Windows
    // Terminal. The tree is stable within a session, so snapshot once on
    // SessionStart; every other event reads a per-session cache instead of
    // spawning. Ordinary high-frequency events (PreToolUse/PostToolUse/Stop/
    // etc.) keep #630's original miss behavior: a miss still falls back to
    // one fresh resolve (and may repopulate the cache) — that fallback is
    // what gets the cache warm again after a PID dies mid-session, and it's
    // rare in steady state once SessionStart has populated the cache.
    //
    // #627 residual: two events get a STRICTER "miss = zero spawn, no
    // fallback" contract instead:
    //   - UserPromptSubmit used to be an always-fresh event (it needed a live
    //     foreground WT window handle). That handle is now sampled
    //     server-side (src/main.js's koffi probe, wired through
    //     src/server-route-state.js), so UserPromptSubmit no longer has any
    //     reason to spawn — cache hit or miss, it never calls resolve().
    //   - SessionEnd reads the cache to fill the final body, then drops it;
    //     a miss no longer falls back to a fresh resolve either (see below).
    // A miss on either ships a body with no process-metadata fields; the
    // server's MERGE (state.js) keeps whatever the session already had.
    // See docs/plans/plan-issue-627-residual-userprompt-flash.md §4.3.
    const canCacheSession = isWin && pidCache.canCache(sessionId, cwd);
    const wantsFresh = event === "SessionStart";
    // The no-fallback contract is a WINDOWS contract, not a cache-availability
    // one: it must hold even when caching is disabled (session_id "default" /
    // empty cwd, #583) — otherwise those degenerate sessions keep flashing a
    // console once per prompt, which is the exact symptom this fix removes.
    // Non-Windows keeps resolving fresh on every event (the ps path neither
    // flashes nor pays a cold start), unchanged.
    const cacheOnlyNoFallback = isWin && (event === "UserPromptSubmit" || event === "SessionEnd");

    let cached = null;
    if (canCacheSession && event === "SessionEnd") {
      // Cache-only + drop: read the last-known subset for the final body (if
      // any), then drop — and, per the #627 residual plan, a MISS no longer
      // falls back to a fresh resolve. That resolve was itself the
      // console-flashing spawn this cache exists to avoid, and by SessionEnd
      // the session is already ending: an incomplete final body (server
      // MERGE keeps whatever the session already had) beats a guaranteed
      // flash. This reverses the #630-shipped SessionEnd-miss fallback (630
      // plan §3.2) — test/clawd-hook-pid-cache.test.js's "SessionEnd on a
      // miss" case is inverted to match.
      cached = pidCache.readPidCache(sessionId, cwd);
      pidCache.dropPidCache(sessionId, cwd);
    } else if (canCacheSession && !wantsFresh) {
      const c = pidCache.readPidCache(sessionId, cwd);
      // M1 (630 plan §5) + lease rewrite (#627 residual §4.4): the PID that
      // becomes source_pid (stablePid) must be alive — session-focus.js only
      // checks source_pid's existence, so a dead stablePid must trigger a
      // fresh resolve. agentPid (claude.exe) must ALSO be alive: it tracks
      // session liveness, so a dead agentPid means the session ended and the
      // cache must NOT be treated as a hit. Both alive → hit, no clock
      // consulted (pid-cache.js's readPidCache no longer expires by time).
      if (c && c.cwd === cwd && processAlive(c.stablePid) && processAlive(c.agentPid)) {
        pidCache.touchPidCache(sessionId, cwd);
        cached = c;
      }
    }

    if (cached) {
      applyCachedFields(body, cached);
    } else if (!cacheOnlyNoFallback) {
      // Fresh resolve: non-Windows (always resolves on every event,
      // unchanged), SessionStart (still the one event that spawns once,
      // prewarmed during stdin buffering — see main() below), or an ordinary
      // cache-only event (PreToolUse/PostToolUse/Stop/etc.) on a miss or with
      // caching unavailable — #630's original repopulate fallback, unchanged.
      // On Windows, UserPromptSubmit/SessionEnd can NEVER reach this branch,
      // cacheable session or not (see cacheOnlyNoFallback above).
      if (event === "SessionStart" && canCacheSession) {
        pidCache.sweepStalePidCaches({ isProcessAlive: processAlive });
      }
      const resolved = resolve();
      applyResolvedFields(body, resolved, event);
      // M2 (630 plan §5): only cache a non-degraded result. An empty Windows
      // snapshot decays stablePid to process.ppid (a per-event ephemeral
      // PID); snapshotOk rules that out, and a found agentPid proves the walk
      // reached a real ancestor. Never write on SessionEnd (unreachable here
      // since SessionEnd never takes this branch, but keep the guard as
      // defense in depth).
      if (canCacheSession && event !== "SessionEnd" && resolved.snapshotOk && resolved.agentPid) {
        pidCache.writePidCache(sessionId, cwd, {
          stablePid: resolved.stablePid,
          agentPid: resolved.agentPid,
          agentCommandLine: resolved.agentCommandLine,
          detectedEditor: resolved.detectedEditor,
        });
      }
    }
    // else: Windows UserPromptSubmit/SessionEnd with no usable cache entry
    // (cacheable miss OR caching unavailable) — zero spawn, no fallback. Body
    // gets no source_pid/agent_pid/etc.; server MERGE keeps whatever the
    // session already had. Never degrade to process.ppid — that would ship a
    // wrong-but-plausible-looking pid (#627 residual plan §4.3).

    if (wslDistro) {
      body.wsl_distro = wslDistro;
      body.host = `wsl:${wslDistro}`;
    }
  }

  return body;
}

// #583: a missing session_id means the agent's stdin JSON was lost or mangled
// somewhere between the agent host and this process (every real session then
// collapses to sid=default server-side). Attach what the stdin read actually
// saw so session-debug.log can separate "never arrived" (bytes:0 + timeout)
// from "arrived broken" (bytes>0 + parse error) without a repro rig.
function attachStdinDiag(body, stdinRead) {
  if (!body || !stdinRead) return body;
  const payload = stdinRead.payload;
  if (payload && payload.session_id) return body;
  const diag = {
    bytes: stdinRead.bytes,
    timed_out: stdinRead.timedOut === true,
    duration_ms: stdinRead.durationMs,
  };
  if (stdinRead.parseError) diag.parse_error = stdinRead.parseError;
  body.stdin_diag = diag;
  return body;
}

function main() {
  const event = process.argv[2];
  if (!EVENT_TO_STATE[event]) process.exit(0);

  const config = getPlatformConfig();
  const resolve = createPidResolver({
    agentNames: { win: new Set(["claude.exe"]), mac: new Set(["claude"]) },
    agentCmdlineCheck: (cmd) => cmd.includes("claude-code") || cmd.includes("@anthropic-ai"),
    platformConfig: config,
  });

  // Pre-resolve on SessionStart (runs during stdin buffering, not after)
  // Remote mode: skip PID collection — remote PIDs are meaningless on the local machine
  if (event === "SessionStart" && !process.env.CLAWD_REMOTE) resolve();

  readStdinJsonDetailed({ timeoutMs: STDIN_READ_TIMEOUT_MS })
    .then((stdinRead) => {
      const payload = stdinRead.payload;
      const body = buildStateBody(event, payload || {}, resolve);
      if (!body) process.exit(0);
      attachStdinDiag(body, stdinRead);
      // Completion events (Stop) fire the happy animation, are low-frequency,
      // and matter more than a few ms of latency. Give them a generous POST
      // timeout so a momentarily slow (but alive) Clawd still receives them;
      // connection-refused (Clawd not running) still fails instantly, so an
      // idle machine is never penalized. High-frequency events keep 100ms so
      // they never stall the agent.
      const isCompletionEvent = body.event === "Stop";
      const statePostTimeoutMs = isCompletionEvent ? 1500 : 100;
      // Byte-fit the body so a long CJK assistant_last_output can't push it past
      // the server's /state cap and trigger a headerless 413 (read back as
      // posted=false, dropping the happy completion). hooks/state-payload-size.js.
      const fitted = fitStateBodyToByteBudget(body);
      postStateToRunningServer(
        JSON.stringify(fitted.body),
        { timeoutMs: statePostTimeoutMs },
        () => process.exit(0)
      );
    })
    .catch(() => process.exit(0));
}

if (require.main === module) main();

module.exports = {
  buildStateBody,
  attachStdinDiag,
  STDIN_READ_TIMEOUT_MS,
  extractSessionTitleFromTranscript,
  extractApiErrorFromEntries,
  extractLastAssistantTextFromEntries,
  readTranscriptTailEntries,
};
