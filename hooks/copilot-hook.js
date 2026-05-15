#!/usr/bin/env node
// Clawd Desktop Pet — Copilot CLI Hook Script
// Usage: node copilot-hook.js <event_name>
// Reads stdin JSON from Copilot CLI for sessionId (camelCase)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");

const SESSION_TITLE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]+/g;
const SESSION_TITLE_MAX = 80;
const WORKSPACE_YAML_MAX_BYTES = 16384; // 16 KB — workspace.yaml is tiny

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

// Strip a single layer of matching surrounding quotes from a YAML scalar.
function stripYamlQuotes(value) {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return value.slice(1, -1);
  }
  return value;
}

// Parse the top-level `name:` scalar from Copilot's workspace.yaml.
// workspace.yaml is a flat key:value file (no nesting), so a per-line
// regex is sufficient and avoids pulling in a YAML dependency.
function parseWorkspaceYamlName(text) {
  if (typeof text !== "string" || !text) return null;
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const match = raw.match(/^name:\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[1];
    // Drop trailing inline comments on unquoted scalars
    if (value && value[0] !== '"' && value[0] !== "'") {
      const hashIdx = value.indexOf(" #");
      if (hashIdx >= 0) value = value.slice(0, hashIdx).trimEnd();
    }
    value = stripYamlQuotes(value);
    return value || null;
  }
  return null;
}

// Read the renamed session title from Copilot's workspace.yaml.
// Returns null if the session id is missing/invalid, the file doesn't
// exist, or it has no usable `name:` field.
//
// Path traversal is blocked by three layers:
//   1. Charset gate: only [A-Za-z0-9._-] (no separators, no NUL, no
//      drive letters, no whitespace).
//   2. Pure-dot rejection: ".", "..", "..." etc. pass the charset gate
//      but resolve to ancestors of session-state/, so reject them
//      explicitly.
//   3. Containment check: after path.resolve, the session directory
//      must lie strictly under the resolved session-state/ base, even
//      if a future change loosens layers 1 or 2.
function readCopilotSessionTitle(sessionId, options = {}) {
  if (typeof sessionId !== "string") return null;
  const trimmed = sessionId.trim();
  if (!trimmed) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
  if (/^\.+$/.test(trimmed)) return null;
  const homeDir = options.homeDir || os.homedir();
  if (!homeDir) return null;
  const baseDir = path.resolve(path.join(homeDir, ".copilot", "session-state"));
  const sessionDir = path.resolve(path.join(baseDir, trimmed));
  if (!sessionDir.startsWith(baseDir + path.sep)) return null;
  const filePath = path.join(sessionDir, "workspace.yaml");
  let fd = null;
  let data;
  try {
    const stat = fs.statSync(filePath);
    fd = fs.openSync(filePath, "r");
    const readLen = Math.min(stat.size, WORKSPACE_YAML_MAX_BYTES);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, 0);
    data = buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return normalizeTitle(parseWorkspaceYamlName(data));
}

const EVENT_TO_STATE = {
  sessionStart: "idle",
  sessionEnd: "sleeping",
  userPromptSubmitted: "thinking",
  preToolUse: "working",
  postToolUse: "working",
  errorOccurred: "error",
  agentStop: "attention",
  subagentStart: "juggling",
  subagentStop: "working",
  preCompact: "sweeping",
};

function buildStateBody(event, payload, resolve, options = {}) {
  const state = EVENT_TO_STATE[event];
  if (!state) return null;

  // Copilot CLI uses camelCase: sessionId, not session_id
  const sessionId = payload.sessionId || payload.session_id || "default";
  const cwd = payload.cwd || "";

  const body = { state, session_id: sessionId, event };
  body.agent_id = "copilot-cli";
  if (cwd) body.cwd = cwd;

  // Session title: prefer payload field if present, otherwise read the
  // renamed name from ~/.copilot/session-state/<sid>/workspace.yaml so
  // /rename in Copilot CLI propagates to Clawd on the next hook event.
  const sessionTitle =
    normalizeTitle(payload.session_title) ||
    normalizeTitle(payload.sessionTitle) ||
    readCopilotSessionTitle(sessionId);
  if (sessionTitle) body.session_title = sessionTitle;

  if (process.env.CLAWD_REMOTE) {
    const readHost = options.readHostPrefix || readHostPrefix;
    body.host = readHost();
  } else {
    const { stablePid, agentPid, detectedEditor, pidChain } = resolve();
    body.source_pid = stablePid;
    if (detectedEditor) body.editor = detectedEditor;
    if (agentPid) body.agent_pid = agentPid;
    if (pidChain.length) body.pid_chain = pidChain;
  }

  return body;
}

function main() {
  const event = process.argv[2];
  if (!EVENT_TO_STATE[event]) process.exit(0);

  const config = getPlatformConfig();
  const resolve = createPidResolver({
    agentNames: { win: new Set(["copilot.exe"]), mac: new Set(["copilot"]) },
    agentCmdlineCheck: (cmd) => cmd.includes("@github/copilot"),
    platformConfig: config,
  });

  // Pre-resolve on sessionStart. Remote mode skips PID collection because
  // remote PIDs are meaningless on the local machine.
  if (event === "sessionStart" && !process.env.CLAWD_REMOTE) resolve();

  readStdinJson().then((payload) => {
    const body = buildStateBody(event, payload || {}, resolve);
    if (!body) process.exit(0);
    postStateToRunningServer(
      JSON.stringify(body),
      { timeoutMs: 100 },
      () => process.exit(0)
    );
  });
}

if (require.main === module) main();

module.exports = {
  buildStateBody,
  normalizeTitle,
  parseWorkspaceYamlName,
  readCopilotSessionTitle,
};
