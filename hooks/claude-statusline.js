#!/usr/bin/env node
// Clawd - Claude Code statusline adapter.
// Registered as `statusLine.command` in ~/.claude/settings.json by
// hooks/install.js (registerClaudeStatusline). Claude Code pipes a JSON
// telemetry payload (model, workspace, context_window, rate_limits, etc.)
// to stdin on every statusline refresh and renders whatever we write to
// stdout as the terminal status line. See:
// https://code.claude.com/docs/en/statusline
//
// This only forwards rate_limits (Pro/Max subscription quota) - Claude
// context-window usage already flows through hooks/context-usage.js via the
// transcript, so posting context_window here too would be a redundant,
// possibly-conflicting second writer for the same field.
//
// Like antigravity-statusline.js, this script also owns rendering visible
// terminal text, so it must always print *something* fast and never throw -
// a stuck or crashed statusline script would blank out the real status line.

const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { readStdinJson } = require("./shared-process");
const { resolveClaudeRateLimitQuota, resolveClaudeModelLabel } = require("./claude-rate-limits");

const STATE_POST_TIMEOUT_MS = 150;

function buildStatusLineText(payload, quota, modelLabel) {
  const parts = [];
  if (modelLabel) parts.push(modelLabel);
  const contextPercent = payload && payload.context_window && Number.isFinite(payload.context_window.used_percentage)
    ? Math.round(payload.context_window.used_percentage)
    : null;
  if (contextPercent !== null) parts.push(`${contextPercent}% ctx`);
  if (quota && quota.claudeWeekly) parts.push(`${quota.claudeWeekly.usedPercent}% weekly`);
  return parts.join(" · ");
}

function buildStateBody(payload, quota, options = {}) {
  const sessionId = payload && payload.session_id;
  if (!sessionId || !quota) return null;

  // metadata_only routes this around the updateSession lifecycle machine:
  // quota is annotated onto an existing session and dropped otherwise -
  // never creating a session, touching recentEvents, or bumping updatedAt
  // (src/server-route-state.js + state.js updateSessionMetadata).
  // state/preserve_state stay as a defensive fallback shape only.
  const body = {
    state: "idle",
    preserve_state: true,
    metadata_only: true,
    session_id: String(sessionId),
    agent_id: "claude-code",
    claude_quota: quota,
  };
  const cwd = payload && payload.workspace && typeof payload.workspace.current_dir === "string"
    ? payload.workspace.current_dir
    : "";
  if (cwd) body.cwd = cwd;
  if (options.remote) {
    body.host = options.host || readHostPrefix();
  }
  return body;
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

  let quota = null;
  let modelLabel = null;
  let text = "";
  try {
    quota = resolveClaudeRateLimitQuota(payload);
    modelLabel = resolveClaudeModelLabel(payload);
    text = buildStatusLineText(payload, quota, modelLabel);
  } catch {
    // fall through with whatever defaults were already assigned
  }

  try {
    const remote = !!env.CLAWD_REMOTE;
    const body = buildStateBody(payload, quota, {
      remote,
      host: remote && deps.readHostPrefix ? deps.readHostPrefix() : undefined,
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
    buildStatusLineText,
    buildStateBody,
    postStateBody,
    main,
  },
};
