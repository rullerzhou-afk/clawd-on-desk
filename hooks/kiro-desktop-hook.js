#!/usr/bin/env node
// Kiro IDE forwards hook stdout to the model. Every exit must stay silent.
const { postStateToRunningServer, readWindowsProcessChainHookContext } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig, applyOrcaPaneKey, processAlive } = require("./shared-process");

// Keep this standalone hook's map local. Hook deployment dependencies are
// limited to Node built-ins and deployable helpers under hooks/.
const HOOK_MAP = {
  SessionStart: "idle",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "working",
  Stop: "attention",
};
const EVENT_TO_LIFECYCLE = { SessionStart: "start", UserPromptSubmit: "prompt" };
// Electron children share the main image name on Windows/Linux. Only macOS
// currently has a verified main-process match for agentPid.
const AGENT_NAMES = { win: new Set(), mac: new Set(["kiro"]), linux: new Set() };
const config = getPlatformConfig();
let runtimeContext = Object.freeze({
  identity: { ok: false, reason: "not-observed", port: null, ownerPid: null },
  observation: null,
});
const resolve = createPidResolver({
  agentNames: AGENT_NAMES,
  platformConfig: config,
  readRuntimeIdentity: () => runtimeContext.identity,
});

// Follow hooks/traecode-hook.js prompt-title limits and secret filtering.
const SESSION_TITLE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]+/g;
const SESSION_TITLE_MAX = 80;
const PROMPT_TITLE_MAX = 40;
const PROMPT_TITLE_SECRET_RE =
  /\b(api[_-]?key|authorization|bearer|password|passwd|private[_-]?key|secret|token)\b|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|[A-Za-z0-9+/=_-]{32,}/i;

function normalizeTitle(value) {
  if (typeof value !== "string") return null;
  const collapsed = value
    .replace(SESSION_TITLE_CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return null;
  return collapsed.length > SESSION_TITLE_MAX
    ? `${collapsed.slice(0, SESSION_TITLE_MAX - 1)}…`
    : collapsed;
}

function normalizeTitleWithMax(value, maxLen) {
  const title = normalizeTitle(value);
  if (!title || title.length <= maxLen) return title;
  return `${title.slice(0, maxLen - 1)}…`;
}

function looksSecretishPromptTitle(value) {
  return typeof value === "string" && PROMPT_TITLE_SECRET_RE.test(value);
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


function pickSourcePid({ agentPid, stablePid }) {
  return agentPid || stablePid;
}

function buildBody(payload, pidMetadata = {}) {
  const event = payload && payload.hook_event_name;
  const state = Object.prototype.hasOwnProperty.call(HOOK_MAP, event) ? HOOK_MAP[event] : null;
  const sessionId = typeof payload?.session_id === "string" ? payload.session_id.trim() : "";
  if (!state || !sessionId) return null;
  const body = { state, event, session_id: sessionId, agent_id: "kiro-desktop" };
  if (typeof payload.cwd === "string") body.cwd = payload.cwd;
  if (event === "UserPromptSubmit") {
    const title = extractPromptTitle(payload.prompt);
    if (title) body.session_title = title;
  }
  const { agentPid, stablePid, detectedEditor, pidChain, tmuxSocket, tmuxClient } = pidMetadata;
  const sourcePid = pickSourcePid({ agentPid, stablePid });
  if (sourcePid) body.source_pid = sourcePid;
  if (agentPid) body.agent_pid = agentPid;
  if (detectedEditor) body.editor = detectedEditor;
  if (Array.isArray(pidChain) && pidChain.length) body.pid_chain = pidChain;
  if (tmuxSocket) body.tmux_socket = tmuxSocket;
  if (tmuxClient) body.tmux_client = tmuxClient;
  applyOrcaPaneKey(body);
  return body;
}

function main(deps = {}) {
  const readStdin = deps.readStdinJson || readStdinJson;
  const postState = deps.postState || postStateToRunningServer;
  const timer = setTimeout(() => process.exit(0), 800);
  const finish = () => {
    clearTimeout(timer);
    process.exit(0);
  };
  Promise.resolve().then(() => readStdin()).then(payload => {
    const event = payload?.hook_event_name;
    const sessionId = typeof payload?.session_id === "string" ? payload.session_id.trim() : "";
    if (!Object.hasOwn(HOOK_MAP, event) || !sessionId) return finish();
    const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
    if (process.platform === "win32") {
      runtimeContext = readWindowsProcessChainHookContext("kiro-desktop");
    }
    const runtimeObservation = runtimeContext.observation;
    const serverProcessChainEnabled = !!(
      process.platform === "win32"
      && runtimeObservation
      && runtimeObservation.agentMode !== "legacy"
      && processAlive(runtimeObservation.ownerPid)
    );
    const authoritativeProcessChain = serverProcessChainEnabled
      && runtimeObservation.agentMode === "b1a-authoritative";
    if (event === "SessionStart" && !authoritativeProcessChain) resolve();
    const pidMetadata = authoritativeProcessChain ? {} : resolve({
      namespace: "kiro-desktop",
      sessionId,
      cacheCwd: cwd,
      lifecycle: EVENT_TO_LIFECYCLE[event] || "event",
      cacheable: !!cwd,
    });
    const postOptions = { timeoutMs: 100 };
    if (serverProcessChainEnabled) {
      postOptions.preferredPort = runtimeObservation.port;
      postOptions.runtimePort = runtimeObservation.port;
      postOptions.windowsProcessChain = {
        agentId: "kiro-desktop",
        hookPid: process.pid,
        runtimeObservation,
        legacyCacheSource: pidMetadata.cacheSource || "none",
      };
    }
    const body = buildBody(payload, pidMetadata);
    postState(JSON.stringify(body), postOptions, finish);
  }).catch(finish);
}

if (require.main === module) main();
module.exports = { __test: { HOOK_MAP, AGENT_NAMES, extractPromptTitle, buildBody, pickSourcePid, main } };
