#!/usr/bin/env node
// Clawd — Codex official lifecycle and permission hook.
// Registered in ~/.codex/hooks.json by hooks/codex-install.js

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");
const {
  postPermissionToRunningServer,
  postStateToRunningServer,
  readCodexAutoStartGate,
  readHostPrefix,
  readRuntimeIdentity,
  readWindowsProcessChainHookContext,
  CODEX_WINDOWS_STABLE_ARG,
  CODEX_WSL_INTEROP_ARG,
  resolveWslDistro,
  applyWslSourceFields,
} = require("./server-config");
const {
  createPidResolver,
  readStdinJson,
  getPlatformConfig,
  applyOrcaPaneKey,
  processAlive,
} = require("./shared-process");
const {
  ROLE_UNKNOWN,
  classifyHookPayload,
  classifySessionMeta,
} = require("./codex-subagent-fields");
const {
  extractLastAssistantTextFromTranscript,
} = require("./codex-assistant-output");
const { readCodexThreadName } = require("./codex-session-index");
const {
  isCodexCliOriginator,
  isCodexDesktopOriginator,
} = require("./codex-originator");
const { fitStateBodyToByteBudget } = require("./state-payload-size");

const WINDOWS_STABLE_RUN_SIGNATURE = "clawd-codex-stable-windows-run-v1";

function decodeStableSidecarValue(value) {
  if (typeof value !== "string") throw new Error("invalid-sidecar-value");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("invalid-sidecar-base64");
  const decoded = bytes.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(bytes)) throw new Error("invalid-sidecar-utf8");
  return decoded;
}

function normalizeWindowsStablePath(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

// Windows local stable entries used to run through an inline PowerShell
// dispatcher that decoded this sidecar and injected env vars before invoking
// Node. Defender flags that command-line shape, so the reviewed command now
// calls Node directly and the hook imports only the data portion here.
//
// Keep this main-process-only and native-Windows-only: requiring codex-hook.js
// from tests must not mutate their env, while remote and WSL-interop commands
// have separate environment contracts. Parse and validate the complete file
// before applying any key so a damaged tail cannot leave a partially-mutated
// process environment. The target binding prevents an unrelated/stale sidecar
// from supplying env to a different copy of codex-hook.js.
function applyWindowsStableSidecarEnv(options = {}) {
  const platform = options.platform || process.platform;
  const argv = Array.isArray(options.argv) ? options.argv : process.argv;
  const env = options.env || process.env;
  if (platform !== "win32") return { applied: false, reason: "not-windows" };
  if (!argv.includes(CODEX_WINDOWS_STABLE_ARG)) return { applied: false, reason: "not-stable" };
  if (argv.includes(CODEX_WSL_INTEROP_ARG)) return { applied: false, reason: "wsl-interop" };
  if (env.CLAWD_REMOTE) return { applied: false, reason: "remote" };

  const fsApi = options.fs || fs;
  const codexHome = options.codexHome || env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const sidecarPath = path.join(codexHome, "clawd-hooks", "codex-hook.js.windows.run");
  let lines;
  try {
    lines = fsApi.readFileSync(sidecarPath, "utf8").replace(/\r\n/g, "\n").split("\n");
  } catch {
    return { applied: false, reason: "missing" };
  }

  try {
    if (lines[0] !== WINDOWS_STABLE_RUN_SIGNATURE || !lines[1] || !lines[2]) {
      return { applied: false, reason: "invalid" };
    }
    decodeStableSidecarValue(lines[1]); // Node path is validated by installer + Doctor.
    const target = decodeStableSidecarValue(lines[2]);
    const expectedTarget = options.hookPath || __filename;
    if (normalizeWindowsStablePath(target) !== normalizeWindowsStablePath(expectedTarget)) {
      return { applied: false, reason: "target-mismatch" };
    }

    const entries = [];
    for (const line of lines.slice(3).filter(Boolean)) {
      const separator = line.indexOf(".");
      if (!line.startsWith("E") || separator < 2) {
        return { applied: false, reason: "invalid" };
      }
      const key = decodeStableSidecarValue(line.slice(1, separator));
      const value = decodeStableSidecarValue(line.slice(separator + 1));
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        return { applied: false, reason: "invalid" };
      }
      entries.push([key, value]);
    }
    for (const [key, value] of entries) env[key] = value;
    return { applied: true, reason: null, count: entries.length };
  } catch {
    return { applied: false, reason: "invalid" };
  }
}

if (require.main === module) applyWindowsStableSidecarEnv();

const TOOL_MATCH_STRING_MAX = 240;
const TOOL_MATCH_ARRAY_MAX = 16;
const TOOL_MATCH_OBJECT_KEYS_MAX = 32;
const TOOL_MATCH_DEPTH_MAX = 6;
const CODEX_PERMISSION_TIMEOUT_MS = 590000;
const CODEX_AUTO_START_TIMEOUT_MS = 10000;
const SESSION_META_READ_CHUNK_BYTES = 8192;
const SESSION_META_READ_MAX_BYTES = 256 * 1024;

const EVENT_TO_STATE = {
  SessionStart: "idle",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "working",
  // Placeholder: server.js resolves official Codex Stop to attention/idle
  // using the per-turn tool-use map it owns.
  Stop: "idle",
};

function getCodexPermissionTimeoutMs() {
  const raw = Number(process.env.CLAWD_CODEX_PERMISSION_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, CODEX_PERMISSION_TIMEOUT_MS);
  return CODEX_PERMISSION_TIMEOUT_MS;
}

function extractCodexSessionIdFromTranscriptPath(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) return null;
  const fileName = path.basename(transcriptPath.replace(/\\/g, "/"));
  const match = fileName.match(
    /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
  );
  return match ? match[1] : null;
}

function normalizeCodexSessionId(value, transcriptPath = "") {
  const transcriptSessionId = extractCodexSessionIdFromTranscriptPath(transcriptPath);
  const raw = transcriptSessionId
    || (typeof value === "string" && value.trim() ? value.trim() : "default");
  return raw.startsWith("codex:") ? raw : `codex:${raw}`;
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

function parseSessionMetaLine(line) {
  if (typeof line !== "string" || !line.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(line.replace(/\r$/, ""));
  } catch {
    return null;
  }
  if (parsed && parsed.type === "session_meta" && parsed.payload && typeof parsed.payload === "object") {
    return parsed.payload;
  }
  return null;
}

function readFirstSessionMeta(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) return null;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const decoder = new StringDecoder("utf8");
    let buffered = "";
    let offset = 0;

    while (offset < SESSION_META_READ_MAX_BYTES) {
      const readLen = Math.min(SESSION_META_READ_CHUNK_BYTES, SESSION_META_READ_MAX_BYTES - offset);
      const buf = Buffer.allocUnsafe(readLen);
      const bytesRead = fs.readSync(fd, buf, 0, readLen, offset);
      if (bytesRead <= 0) break;

      const slice = buf.subarray(0, bytesRead);
      offset += bytesRead;
      buffered += decoder.write(slice);

      let newlineIndex = buffered.indexOf("\n");
      while (newlineIndex >= 0) {
        const meta = parseSessionMetaLine(buffered.slice(0, newlineIndex));
        if (meta) return meta;
        buffered = buffered.slice(newlineIndex + 1);
        newlineIndex = buffered.indexOf("\n");
      }

      if (bytesRead < readLen) break;
    }

    buffered += decoder.end();
    return parseSessionMetaLine(buffered);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return null;
}

function applyCodexUpstreamFields(body, payload, sessionMeta) {
  const source = payload && typeof payload === "object" ? payload : {};
  const meta = sessionMeta && typeof sessionMeta === "object" ? sessionMeta : {};
  const upstreamAgentId = typeof source.agent_id === "string" && source.agent_id
    ? source.agent_id
    : (typeof meta.agent_id === "string" && meta.agent_id ? meta.agent_id : null);
  const upstreamAgentType = typeof source.agent_type === "string" && source.agent_type
    ? source.agent_type
    : (typeof meta.agent_type === "string" && meta.agent_type ? meta.agent_type : null);

  if (upstreamAgentId) body.codex_subagent_id = upstreamAgentId;
  if (upstreamAgentType) body.codex_agent_type = upstreamAgentType;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function applyCodexSessionMetaFields(body, payload, sessionMeta) {
  const source = payload && typeof payload === "object" ? payload : {};
  const meta = sessionMeta && typeof sessionMeta === "object" ? sessionMeta : {};
  const originator = firstString(meta.originator, source.originator);
  let codexSource = firstString(meta.source, source.source);
  const metaSubagent = meta.source && typeof meta.source === "object"
    ? meta.source.subagent
    : null;
  const hookSubagent = source.source && typeof source.source === "object"
    ? source.source.subagent
    : null;
  const subagent = metaSubagent && typeof metaSubagent === "object"
    ? metaSubagent
    : (hookSubagent && typeof hookSubagent === "object" ? hookSubagent : null);
  const spawn = subagent && subagent.thread_spawn && typeof subagent.thread_spawn === "object"
    ? subagent.thread_spawn
    : {};

  // A subagent session_meta replaces the root's string source ("cli") with
  // a structured `source.subagent` object. `originator:"codex-tui"` is the
  // audited local-CLI provenance for that shape, so preserve the inherited
  // source instead of making every interactive child fail automation identity.
  if (!codexSource && subagent && isCodexCliOriginator(originator)) codexSource = "cli";
  if (originator) body.codex_originator = originator;
  if (codexSource) body.codex_source = codexSource;

  const agentNickname = firstString(
    meta.agent_nickname,
    source.agent_nickname,
    spawn.agent_nickname,
  );
  const agentRole = firstString(
    meta.agent_role,
    source.agent_role,
    spawn.agent_role,
  );
  const parentThreadId = firstString(
    meta.parent_thread_id,
    source.parent_thread_id,
    spawn.parent_thread_id,
  );
  if (agentNickname) body.codex_agent_nickname = agentNickname.slice(0, 100);
  if (agentRole) body.codex_agent_role = agentRole.slice(0, 100);
  if (parentThreadId) body.codex_parent_thread_id = parentThreadId.slice(0, 200);
}

function isCodexDesktopSession(payload, sessionMeta) {
  const source = payload && typeof payload === "object" ? payload : {};
  const meta = sessionMeta && typeof sessionMeta === "object" ? sessionMeta : {};
  return isCodexDesktopOriginator(firstString(meta.originator, source.originator));
}

function shouldReportForegroundWtHwnd(event) {
  return event === "SessionStart" || event === "UserPromptSubmit";
}

function applyLocalProcessFields(body, resolve, options = {}) {
  // #634: cross-process pid cache via the shared resolver. Lifecycle keys off
  // the state event (permission bodies carry no event → "event"); codex has no
  // SessionEnd hook and Stop is deliberately NOT "end" (turn completion). The
  // cacheable guard compares against the exact normalizeCodexSessionId
  // fallback, so an id-less payload (raw "default", cf. #583) never keys a
  // shared cache entry.
  const lifecycle = options.event === "SessionStart" ? "start"
    : options.event === "UserPromptSubmit" ? "prompt"
    : "event";
  const metadata = resolve({
    namespace: "codex",
    sessionId: body.session_id,
    cacheCwd: body.cwd || "",
    lifecycle,
    cacheable: body.session_id !== "codex:default" && !!body.cwd,
  });
  const { stablePid, agentPid, detectedEditor, pidChain, foregroundWtHwnd, tmuxSocket, tmuxClient, headless } = metadata;
  const sourcePid = options.preferAgentPid && agentPid ? agentPid : stablePid;
  body.source_pid = sourcePid;
  if (detectedEditor) body.editor = detectedEditor;
  if (agentPid) body.agent_pid = agentPid;
  if (agentPid && headless === true) body.headless = true;
  if (Array.isArray(pidChain) && pidChain.length) body.pid_chain = pidChain;
  if (tmuxSocket) body.tmux_socket = tmuxSocket;
  if (tmuxClient) body.tmux_client = tmuxClient;
  applyOrcaPaneKey(body);
  if (shouldReportForegroundWtHwnd(options.event, foregroundWtHwnd) && foregroundWtHwnd) {
    body.wt_hwnd = String(foregroundWtHwnd);
  }
  return metadata;
}

function resolveCodexSessionRole(payload, sessionMeta) {
  const hookRole = classifyHookPayload(payload);
  if (hookRole !== ROLE_UNKNOWN) return hookRole;
  return classifySessionMeta(sessionMeta);
}

function sanitizeCodexPermissionDecision(decision) {
  if (!decision || typeof decision !== "object") return null;
  const behavior = decision.behavior === "deny" ? "deny"
    : (decision.behavior === "allow" ? "allow" : null);
  if (!behavior) return null;

  const out = { behavior };
  if (behavior === "deny" && typeof decision.message === "string" && decision.message) {
    out.message = decision.message;
  }
  return out;
}

function buildCodexNoDecisionOutput() {
  return "{}";
}

function buildCodexPermissionOutput(decision) {
  const safeDecision = sanitizeCodexPermissionDecision(decision);
  if (!safeDecision) return buildCodexNoDecisionOutput();
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: safeDecision,
    },
  });
}

function sanitizeCodexPermissionOutput(rawBody) {
  if (typeof rawBody !== "string" || !rawBody.trim()) return buildCodexNoDecisionOutput();
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return buildCodexNoDecisionOutput();
  }
  const decision = parsed
    && parsed.hookSpecificOutput
    && parsed.hookSpecificOutput.hookEventName === "PermissionRequest"
    ? parsed.hookSpecificOutput.decision
    : null;
  return buildCodexPermissionOutput(decision);
}

function buildPermissionBody(payload, resolve, options = {}) {
  const event = payload && typeof payload.hook_event_name === "string"
    ? payload.hook_event_name
    : "";
  if (event !== "PermissionRequest") return null;

  const rawToolInput = payload.tool_input && typeof payload.tool_input === "object"
    ? payload.tool_input
    : {};
  const description = typeof rawToolInput.description === "string" && rawToolInput.description.trim()
    ? rawToolInput.description.trim().slice(0, 500)
    : null;
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name.trim() : "";
  if (!toolName || /^unknown$/i.test(toolName)) return null;
  const sessionMeta = readFirstSessionMeta(payload.transcript_path);

  const body = {
    agent_id: "codex",
    hook_source: "codex-official",
    session_id: normalizeCodexSessionId(payload.session_id, payload.transcript_path),
    tool_name: toolName,
    tool_input: normalizeToolMatchValue(rawToolInput) || {},
  };

  if (description) body.tool_input_description = description;
  if (typeof payload.cwd === "string" && payload.cwd) body.cwd = payload.cwd;
  if (typeof payload.turn_id === "string" && payload.turn_id) body.turn_id = payload.turn_id;
  if (typeof payload.permission_mode === "string" && payload.permission_mode) {
    body.permission_mode = payload.permission_mode;
  }
  if (typeof payload.transcript_path === "string" && payload.transcript_path) {
    body.transcript_path = payload.transcript_path;
  }
  if (typeof payload.model === "string" && payload.model) body.model = payload.model;
  if (payload.headless === true) body.headless = true;
  // Permission routing must distinguish a visible Agent thread from a truly
  // non-interactive process. Carry the role for provenance/UI. An explicit or
  // resolver-derived `headless` bit remains a hard bypass; the server also
  // fail-closes subagents whose originator is not an audited interactive client.
  const codexRole = resolveCodexSessionRole(payload, sessionMeta);
  if (codexRole !== ROLE_UNKNOWN) body.codex_session_role = codexRole;
  applyCodexSessionMetaFields(body, payload, sessionMeta);

  const toolUseId = normalizeToolUseId(payload.tool_use_id ?? payload.toolUseId ?? payload.toolUseID);
  const toolInputFingerprint = buildToolInputFingerprint(rawToolInput);
  if (toolUseId) body.tool_use_id = toolUseId;
  if (toolInputFingerprint) body.tool_input_fingerprint = toolInputFingerprint;

  if (process.env.CLAWD_REMOTE) {
    body.host = readHostPrefix();
    applyWslSourceFields(body, { remote: true });
    applyOrcaPaneKey(body);
  } else {
    applyWslSourceFields(body);
    if (options.authoritativeProcessChain === true) {
      applyOrcaPaneKey(body);
    } else {
      const metadata = applyLocalProcessFields(body, resolve, {
        preferAgentPid: isCodexDesktopSession(payload, sessionMeta),
        event,
      });
      if (typeof options.onProcessMetadata === "function") options.onProcessMetadata(metadata);
    }
  }

  return body;
}

function buildStateBody(payload, resolve, options = {}) {
  const event = payload && typeof payload.hook_event_name === "string"
    ? payload.hook_event_name
    : "";
  const state = EVENT_TO_STATE[event];
  if (!state) return null;
  if (event === "Stop" && payload.stop_hook_active === true) return null;

  const sessionId = normalizeCodexSessionId(payload.session_id, payload.transcript_path);
  const body = {
    state,
    session_id: sessionId,
    event,
    agent_id: "codex",
    hook_source: "codex-official",
  };

  const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
  if (cwd) body.cwd = cwd;
  if (typeof payload.turn_id === "string" && payload.turn_id) body.turn_id = payload.turn_id;
  if (typeof payload.permission_mode === "string" && payload.permission_mode) {
    body.permission_mode = payload.permission_mode;
  }
  if (typeof payload.transcript_path === "string" && payload.transcript_path) {
    body.transcript_path = payload.transcript_path;
  }
  if (typeof payload.model === "string" && payload.model) body.model = payload.model;
  if (payload.stop_hook_active === true || payload.stop_hook_active === false) {
    body.stop_hook_active = payload.stop_hook_active;
  }
  if (event === "Stop") {
    const assistantOutput = extractLastAssistantTextFromTranscript(payload.transcript_path);
    if (assistantOutput && assistantOutput.text) {
      body.assistant_last_output = assistantOutput.text;
      if (assistantOutput.truncated) body.assistant_last_output_truncated = true;
    }
  }

  const sessionMeta = readFirstSessionMeta(payload.transcript_path);
  const threadName = readCodexThreadName(sessionId);
  if (threadName) body.session_title = threadName;
  const codexRole = resolveCodexSessionRole(payload, sessionMeta);
  if (codexRole !== ROLE_UNKNOWN) body.codex_session_role = codexRole;
  applyCodexSessionMetaFields(body, payload, sessionMeta);
  applyCodexUpstreamFields(body, payload, sessionMeta);

  const toolName = typeof payload.tool_name === "string" && payload.tool_name ? payload.tool_name : null;
  const toolUseId = normalizeToolUseId(payload.tool_use_id ?? payload.toolUseId ?? payload.toolUseID);
  const toolInput = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : null;
  const toolInputFingerprint = buildToolInputFingerprint(toolInput);
  if (toolName) body.tool_name = toolName;
  if (toolUseId) body.tool_use_id = toolUseId;
  if (toolInputFingerprint) body.tool_input_fingerprint = toolInputFingerprint;

  if (process.env.CLAWD_REMOTE) {
    body.host = readHostPrefix();
    applyWslSourceFields(body, { remote: true });
    applyOrcaPaneKey(body);
  } else {
    applyWslSourceFields(body);
    if (options.authoritativeProcessChain === true) {
      applyOrcaPaneKey(body);
    } else {
      const metadata = applyLocalProcessFields(body, resolve, {
        preferAgentPid: isCodexDesktopSession(payload, sessionMeta),
        event,
      });
      if (typeof options.onProcessMetadata === "function") options.onProcessMetadata(metadata);
    }
  }

  return body;
}

function requestCodexPermission(body, callback, options = {}) {
  const postPermission = options.postPermission || postPermissionToRunningServer;
  const requestOptions = {
    timeoutMs: getCodexPermissionTimeoutMs(),
    probeTimeoutMs: 100,
  };
  if (options.preferredPort) {
    requestOptions.preferredPort = options.preferredPort;
    requestOptions.runtimePort = options.preferredPort;
  }
  if (options.windowsProcessChain) requestOptions.windowsProcessChain = options.windowsProcessChain;
  postPermission(
    JSON.stringify(body),
    requestOptions,
    (ok, port, responseBody) => {
      callback(ok ? sanitizeCodexPermissionOutput(responseBody) : buildCodexNoDecisionOutput(), ok, port);
    }
  );
}

function startClawdAndWait(options = {}) {
  const spawnProcess = options.spawn || spawn;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(0, options.timeoutMs)
    : CODEX_AUTO_START_TIMEOUT_MS;
  return new Promise((resolveStart) => {
    let settled = false;
    let child = null;
    let timer = null;
    const cleanup = () => {
      if (timer !== null) {
        clearTimeoutFn(timer);
        timer = null;
      }
      if (child && typeof child.removeListener === "function") {
        child.removeListener("error", done);
        child.removeListener("exit", done);
      }
    };
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveStart();
    };
    const onTimeout = () => {
      if (child && typeof child.kill === "function") {
        try { child.kill(); } catch {}
      }
      done();
    };
    try {
      child = spawnProcess(
        process.execPath,
        [path.join(__dirname, "auto-start.js")],
        { stdio: "ignore", windowsHide: true }
      );
      if (!child || typeof child.once !== "function") {
        done();
        return;
      }
      child.once("error", done);
      child.once("exit", done);
      timer = setTimeoutFn(onTimeout, timeoutMs);
      if (timer && typeof timer.unref === "function") timer.unref();
    } catch {
      done();
    }
  });
}

async function runCodexHook(payload, options = {}) {
  const config = getPlatformConfig();
  const readIdentity = options.readRuntimeIdentity || readRuntimeIdentity;
  const env = options.env || process.env;
  const argv = Array.isArray(options.argv) ? options.argv : process.argv;
  const platform = options.platform || process.platform;
  const wslInterop = argv.includes(CODEX_WSL_INTEROP_ARG);
  let wslDistro = null;
  try {
    const resolveHookWslDistro = options.resolveWslDistro || resolveWslDistro;
    wslDistro = resolveHookWslDistro();
  } catch {}
  const mayUseWindowsProcessChain = platform === "win32"
    && !env.CLAWD_REMOTE
    && !env.CLAWD_WSL_DISTRO
    && !wslInterop
    && !wslDistro;
  const readHookContext = options.readWindowsProcessChainHookContext
    || readWindowsProcessChainHookContext;
  const isAlive = options.processAlive || processAlive;
  const observeAttempt = () => {
    if (!mayUseWindowsProcessChain) {
      return { context: null, observation: null, enabled: false, authoritative: false };
    }
    let context;
    try {
      context = readHookContext("codex", { readRuntimeIdentity: readIdentity });
    } catch {
      context = { identity: { ok: false, reason: "runtime-read-failed", port: null, ownerPid: null }, observation: null };
    }
    const observation = context && context.observation || null;
    let ownerAlive = false;
    if (observation) {
      try { ownerAlive = isAlive(observation.ownerPid) === true; } catch { ownerAlive = false; }
    }
    const enabled = !!(observation && observation.agentMode !== "legacy" && ownerAlive);
    return {
      context,
      observation,
      enabled,
      authoritative: enabled && observation.agentMode === "b1a-authoritative",
    };
  };
  const createAttemptResolver = (initialPreferredPort = null, processChainAttempt = null) => {
    let preferredPort = initialPreferredPort
      || (processChainAttempt && processChainAttempt.observation && processChainAttempt.observation.port)
      || (processChainAttempt && processChainAttempt.context
        && processChainAttempt.context.identity && processChainAttempt.context.identity.port)
      || null;
    const resolverOptions = {
      agentNames: { win: new Set(["codex.exe"]), mac: new Set(["codex"]), linux: new Set(["codex"]) },
      platformConfig: config,
      readRuntimeIdentity() {
        if (processChainAttempt && processChainAttempt.context) {
          return processChainAttempt.context.identity;
        }
        const identity = readIdentity();
        if (!preferredPort && identity && identity.port) preferredPort = identity.port;
        return identity;
      },
    };
    const resolve = options.resolvePid || (options.createPidResolver
      ? options.createPidResolver(resolverOptions)
      : createPidResolver(resolverOptions));
    return {
      resolve,
      getPreferredPort: () => preferredPort,
    };
  };

  if (payload && payload.hook_event_name === "PermissionRequest") {
    const processChainAttempt = observeAttempt();
    const permissionAttempt = createAttemptResolver(options.preferredPort || null, processChainAttempt);
    let legacyCacheSource = "none";
    const permissionBody = buildPermissionBody(payload, permissionAttempt.resolve, {
      authoritativeProcessChain: processChainAttempt.authoritative,
      onProcessMetadata: (metadata) => { legacyCacheSource = metadata && metadata.cacheSource || "none"; },
    });
    if (!permissionBody) return { body: null, posted: false, stdout: "" };
    const windowsProcessChain = processChainAttempt.enabled ? {
      agentId: "codex",
      hookPid: options.hookPid || process.pid,
      runtimeObservation: processChainAttempt.observation,
      legacyCacheSource,
    } : null;
    return new Promise((resolveRun) => {
      requestCodexPermission(permissionBody, (stdout, posted, port) => {
        resolveRun({ body: permissionBody, posted: !!posted, port: port || null, stdout });
      }, {
        ...options,
        preferredPort: permissionAttempt.getPreferredPort(),
        windowsProcessChain,
      });
    });
  }

  const postState = options.postState || postStateToRunningServer;
  const buildStateAttempt = (preferredPort = null, processChainAttempt = observeAttempt()) => {
    const attempt = createAttemptResolver(preferredPort, processChainAttempt);
    let legacyCacheSource = "none";
    const body = buildStateBody(payload || {}, attempt.resolve, {
      authoritativeProcessChain: processChainAttempt.authoritative,
      onProcessMetadata: (metadata) => { legacyCacheSource = metadata && metadata.cacheSource || "none"; },
    });
    if (!body) return null;
    // Byte-fit before POST so a long CJK assistant_last_output can't trip the
    // server's headerless 413 (read back as posted=false). See
    // hooks/state-payload-size.js.
    const fitted = fitStateBodyToByteBudget(body);
    return {
      body: fitted.body,
      preferredPort: attempt.getPreferredPort(),
      windowsProcessChain: processChainAttempt.enabled ? {
        agentId: "codex",
        hookPid: options.hookPid || process.pid,
        runtimeObservation: processChainAttempt.observation,
        legacyCacheSource,
      } : null,
    };
  };
  const postAttempt = (attempt) => new Promise((resolveRun) => {
    const requestOptions = { timeoutMs: 100 };
    if (attempt.preferredPort) {
      requestOptions.preferredPort = attempt.preferredPort;
      requestOptions.runtimePort = attempt.preferredPort;
    }
    if (attempt.windowsProcessChain) requestOptions.windowsProcessChain = attempt.windowsProcessChain;
    postState(
      JSON.stringify(attempt.body),
      requestOptions,
      (posted, port) => resolveRun({
        body: attempt.body,
        posted: !!posted,
        port: port || null,
        stdout: "",
      })
    );
  });

  const firstAttempt = buildStateAttempt(options.preferredPort || null);
  if (!firstAttempt) return { body: null, posted: false, stdout: "" };
  const result = await postAttempt(firstAttempt);
  if (
    result.posted
    || payload.hook_event_name !== "SessionStart"
    || env.CLAWD_REMOTE
    || env.CLAWD_WSL_DISTRO
    || wslInterop
    || wslDistro
  ) return result;

  const readAutoStartGate = options.readCodexAutoStartGate || readCodexAutoStartGate;
  let autoStartEnabled = false;
  try {
    autoStartEnabled = readAutoStartGate(options.codexAutoStartGateOptions || {}) === true;
  } catch {}
  if (!autoStartEnabled) return result;

  // Codex launches matching hooks concurrently, so a separate SessionStart
  // auto-start hook would race this state delivery. Wait for the existing
  // launcher helper to finish its readiness probe, then rebuild this event
  // with fresh runtime and process identity before retrying it.
  const runAutoStart = options.runAutoStart || startClawdAndWait;
  await runAutoStart();
  const retryAttempt = buildStateAttempt();
  return postAttempt(retryAttempt);
}

async function main() {
  const payload = await readStdinJson();
  const result = await runCodexHook(payload || {});
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
}

if (require.main === module) {
  main().then(() => process.exit(0), () => process.exit(0));
}

module.exports = {
  CODEX_AUTO_START_TIMEOUT_MS,
  EVENT_TO_STATE,
  applyCodexSessionMetaFields,
  applyWindowsStableSidecarEnv,
  applyLocalProcessFields,
  buildCodexNoDecisionOutput,
  buildCodexPermissionOutput,
  buildPermissionBody,
  buildStateBody,
  buildToolInputFingerprint,
  extractLastAssistantTextFromTranscript,
  extractCodexSessionIdFromTranscriptPath,
  isCodexDesktopSession,
  normalizeCodexSessionId,
  readFirstSessionMeta,
  runCodexHook,
  sanitizeCodexPermissionDecision,
  sanitizeCodexPermissionOutput,
  startClawdAndWait,
};
