#!/usr/bin/env node
// Clawd — Codex official lifecycle and permission hook.
// Registered in ~/.codex/hooks.json by hooks/codex-install.js

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { StringDecoder } = require("string_decoder");
const {
  postPermissionToRunningServer,
  postStateToRunningServer,
  readHostPrefix,
} = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");
const {
  ROLE_UNKNOWN,
  classifyHookPayload,
  classifySessionMeta,
} = require("./codex-subagent-fields");
const { readCodexThreadName } = require("./codex-session-index");

const TOOL_MATCH_STRING_MAX = 240;
const TOOL_MATCH_ARRAY_MAX = 16;
const TOOL_MATCH_OBJECT_KEYS_MAX = 32;
const TOOL_MATCH_DEPTH_MAX = 6;
const CODEX_PERMISSION_TIMEOUT_MS = 590000;
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
  const codexSource = firstString(meta.source, source.source);
  if (originator) body.codex_originator = originator;
  if (codexSource) body.codex_source = codexSource;
}

function isCodexDesktopSession(payload, sessionMeta) {
  const source = payload && typeof payload === "object" ? payload : {};
  const meta = sessionMeta && typeof sessionMeta === "object" ? sessionMeta : {};
  return firstString(meta.originator, source.originator).toLowerCase() === "codex desktop";
}

function applyLocalProcessFields(body, resolve, options = {}) {
  const { stablePid, agentPid, detectedEditor, pidChain } = resolve();
  const sourcePid = options.preferAgentPid && agentPid ? agentPid : stablePid;
  body.source_pid = sourcePid;
  if (detectedEditor) body.editor = detectedEditor;
  if (agentPid) body.agent_pid = agentPid;
  if (pidChain.length) body.pid_chain = pidChain;
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

function buildPermissionBody(payload, resolve) {
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
  const toolName = typeof payload.tool_name === "string" && payload.tool_name
    ? payload.tool_name
    : "Unknown";
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
  applyCodexSessionMetaFields(body, payload, sessionMeta);

  const toolUseId = normalizeToolUseId(payload.tool_use_id ?? payload.toolUseId ?? payload.toolUseID);
  const toolInputFingerprint = buildToolInputFingerprint(rawToolInput);
  if (toolUseId) body.tool_use_id = toolUseId;
  if (toolInputFingerprint) body.tool_input_fingerprint = toolInputFingerprint;

  if (process.env.CLAWD_REMOTE) {
    body.host = readHostPrefix();
  } else {
    applyLocalProcessFields(body, resolve, {
      preferAgentPid: isCodexDesktopSession(payload, sessionMeta),
    });
  }

  return body;
}

function buildStateBody(payload, resolve) {
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
  } else {
    applyLocalProcessFields(body, resolve, {
      preferAgentPid: isCodexDesktopSession(payload, sessionMeta),
    });
  }

  return body;
}

function requestCodexPermission(body, callback) {
  postPermissionToRunningServer(
    JSON.stringify(body),
    {
      timeoutMs: getCodexPermissionTimeoutMs(),
      probeTimeoutMs: 100,
    },
    (ok, _port, responseBody) => {
      callback(ok ? sanitizeCodexPermissionOutput(responseBody) : buildCodexNoDecisionOutput());
    }
  );
}

function main() {
  const config = getPlatformConfig();
  const resolve = createPidResolver({
    agentNames: { win: new Set(["codex.exe"]), mac: new Set(["codex"]), linux: new Set(["codex"]) },
    platformConfig: config,
  });

  readStdinJson().then((payload) => {
    const permissionBody = buildPermissionBody(payload || {}, resolve);
    if (permissionBody) {
      requestCodexPermission(permissionBody, (output) => {
        process.stdout.write(`${output}\n`);
        process.exit(0);
      });
      return;
    }

    const body = buildStateBody(payload || {}, resolve);
    if (!body) process.exit(0);
    postStateToRunningServer(JSON.stringify(body), { timeoutMs: 100 }, () => process.exit(0));
  });
}

if (require.main === module) main();

module.exports = {
  EVENT_TO_STATE,
  applyCodexSessionMetaFields,
  applyLocalProcessFields,
  buildCodexNoDecisionOutput,
  buildCodexPermissionOutput,
  buildPermissionBody,
  buildStateBody,
  buildToolInputFingerprint,
  extractCodexSessionIdFromTranscriptPath,
  isCodexDesktopSession,
  normalizeCodexSessionId,
  readFirstSessionMeta,
  sanitizeCodexPermissionDecision,
  sanitizeCodexPermissionOutput,
};
