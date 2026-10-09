#!/usr/bin/env node
// Clawd - Antigravity CLI statusline adapter.
// Registered as `statusLine.command` in ~/.gemini/antigravity-cli/settings.json
// by hooks/antigravity-install.js. Antigravity pipes a JSON telemetry payload
// (agent state, context window usage, model, cwd, etc.) to stdin on every
// statusline refresh and renders whatever we write to stdout as the terminal
// status line.
//
// Unlike the PreInvocation/PostToolUse/PostInvocation/Stop hooks in
// antigravity-hook.js (which only drive Clawd's own session state), this
// script also owns rendering visible terminal text, so it must always print
// *something* fast and never throw - a stuck or crashed statusline script
// would blank out the user's real Antigravity CLI status line.

const {
  applyWslSourceFields,
  postStateToRunningServer,
  readHostPrefix,
} = require("./server-config");
const { readStdinJson } = require("./shared-process");
const {
  resolveAntigravityContextUsage,
  resolveAntigravityModelLabel,
  resolveAntigravityQuota,
} = require("./antigravity-context-usage");

const STATE_POST_TIMEOUT_MS = 150;

function normalizeSessionId(conversationId) {
  const raw = conversationId != null && conversationId !== "" ? String(conversationId) : "default";
  return raw.startsWith("antigravity:") ? raw : `antigravity:${raw}`;
}

function buildStatusLineText(payload, contextUsage, modelLabel) {
  const parts = [];
  if (modelLabel) parts.push(modelLabel);
  if (contextUsage && Number.isFinite(contextUsage.percent)) parts.push(`${contextUsage.percent}% ctx`);
  const state = payload && typeof payload.agent_state === "string" ? payload.agent_state : null;
  if (state) parts.push(state);
  return parts.length ? parts.join(" · ") : "";
}

function buildStateBody(payload, contextUsage, quota, options = {}) {
  const conversationId = payload && payload.conversation_id;
  if (!conversationId) return null;

  // metadata_only routes this around the updateSession lifecycle machine
  // entirely (src/server-route-state.js + state.js updateSessionMetadata):
  // context/quota are annotated onto an existing session and dropped
  // otherwise - never creating a session, touching recentEvents, or bumping
  // updatedAt. That also sidesteps all event-keyed bookkeeping concerns
  // (tool boundaries, post-Stop drop guards). state/preserve_state stay as
  // a defensive fallback shape only.
  const body = {
    state: "idle",
    preserve_state: true,
    metadata_only: true,
    session_id: normalizeSessionId(conversationId),
    agent_id: "antigravity-cli",
  };
  const cwd = payload && typeof payload.cwd === "string" ? payload.cwd : "";
  if (cwd) body.cwd = cwd;
  if (contextUsage) body.context_usage = contextUsage;
  if (quota) body.antigravity_quota = quota;
  if (options.remote) {
    body.host = options.host || readHostPrefix();
  }
  return (options.applyWslSourceFields || applyWslSourceFields)(body, {
    remote: !!options.remote,
  });
}

function postStateBody(body, deps, env) {
  if (!body) return Promise.resolve(false);
  const postState = deps.postState || postStateToRunningServer;
  return new Promise((resolve) => {
    postState(JSON.stringify(body), { timeoutMs: STATE_POST_TIMEOUT_MS, env }, (posted) => resolve(!!posted));
  });
}

async function main(deps = {}) {
  const env = deps.env || process.env;
  let payload = null;
  try {
    payload = deps.payload !== undefined ? deps.payload : await (deps.readStdinJson || readStdinJson)();
  } catch {
    payload = null;
  }

  let contextUsage = null;
  let quota = null;
  let modelLabel = null;
  let text = "";
  try {
    contextUsage = resolveAntigravityContextUsage(payload);
    quota = resolveAntigravityQuota(payload);
    modelLabel = resolveAntigravityModelLabel(payload);
    text = buildStatusLineText(payload, contextUsage, modelLabel);
  } catch {
    // fall through with whatever defaults were already assigned
  }

  try {
    const remote = !!env.CLAWD_REMOTE;
    const body = buildStateBody(payload, contextUsage, quota, {
      remote,
      host: remote && deps.readHostPrefix ? deps.readHostPrefix() : undefined,
      applyWslSourceFields: deps.applyWslSourceFields,
    });
    await postStateBody(body, deps, env);
  } catch {
    // Never let a failed/slow POST take down the visible status line.
  }

  process.stdout.write(`${text}\n`);
}

if (require.main === module) {
  main().catch(() => {
    process.stdout.write("\n");
  }).finally(() => {
    process.exit(0);
  });
}

module.exports = {
  __test: {
    normalizeSessionId,
    buildStatusLineText,
    buildStateBody,
    postStateBody,
    main,
  },
};
