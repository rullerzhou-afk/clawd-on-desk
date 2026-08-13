#!/usr/bin/env node
// Clawd - Claude Code statusline adapter.
// Registered as `statusLine.command` in ~/.claude/settings.json by
// hooks/install.js (registerClaudeStatusline). Claude Code pipes a JSON
// telemetry payload (model, workspace, context_window, rate_limits, etc.)
// to stdin on every statusline refresh and renders whatever we write to
// stdout as the terminal status line. See:
// https://code.claude.com/docs/en/statusline
//
// This forwards Claude's documented context window plus rate_limits when the
// latter are available. Context metadata is authoritative for the denominator;
// transcript hooks remain the fallback and keep used tokens moving.
//
// Like antigravity-statusline.js, this script also owns rendering visible
// terminal text, so it must always print *something* fast and never throw -
// a stuck or crashed statusline script would blank out the real status line.

const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { readJsonFile } = require("./json-utils");
const {
  applyWslSourceFields,
  postStateToRunningServer,
  readHostPrefix,
} = require("./server-config");
const { readStdinJson } = require("./shared-process");
const { resolveClaudeRateLimitQuota, resolveClaudeModelLabel } = require("./claude-rate-limits");
const { extractClaudeStatuslineContextUsage } = require("./context-usage");

const STATE_POST_TIMEOUT_MS = 150;

// ── Chain mode (POSIX remotes only, installed via --chain-existing) ──
// The user's own statusline keeps rendering the visible line while we only
// siphon rate_limits. Their original statusLine object lives verbatim in a
// sidecar written by hooks/install.js (a file, not a CLI argument - real
// statusline commands are arbitrarily-quoted shell one-liners).
function resolveChainSidecarPath(options = {}) {
  const env = options.env || process.env;
  if (typeof options.chainSidecarPath === "string" && options.chainSidecarPath) {
    return options.chainSidecarPath;
  }
  if (typeof env.CLAWD_STATUSLINE_SIDECAR_PATH === "string"
    && env.CLAWD_STATUSLINE_SIDECAR_PATH) {
    return env.CLAWD_STATUSLINE_SIDECAR_PATH;
  }
  const claudeConfigDir = typeof env.CLAUDE_CONFIG_DIR === "string" && env.CLAUDE_CONFIG_DIR
    ? env.CLAUDE_CONFIG_DIR
    : path.join(os.homedir(), ".claude");
  return path.join(claudeConfigDir, "hooks", "clawd-statusline-chain.json");
}
// A hung chained script must not accumulate orphan processes across
// statusline refreshes: Claude Code refreshes sub-second and nothing
// serializes overlapping invocations, so the worst-case concurrent orphan
// count is roughly cap / refresh-interval. 3s is still well past any sane
// statusline render time while keeping that bound small.
const CHAIN_EXIT_CAP_MS = 3000;

function readChainedCommand(sidecarPath) {
  try {
    // readJsonFile, not a hand-rolled parse: BOM'd JSON permanently broke
    // statusline registration once before (#590 review C3).
    const raw = readJsonFile(sidecarPath);
    const statusLine = raw && typeof raw === "object" ? raw.statusLine : null;
    const command = statusLine && typeof statusLine.command === "string" ? statusLine.command.trim() : "";
    return command || null;
  } catch {
    return null;
  }
}

// stdin is re-fed verbatim-equivalent (re-serialized payload), stdout is
// inherited (the chained script owns the visible line), stderr is swallowed
// (a broken chained script must not bleed error text into the status line
// area). Resolves on child exit so our process outlives the pipe the child
// renders through.
//
// Resolution: "ok" (child exited), "timeout" (cap hit — it may already have
// rendered, so the caller must stay silent), "spawn-failed" (nothing ever
// ran — the caller renders the plain fallback line instead of leaving the
// status line blank).
function runChainedStatusLine(command, stdinText, deps = {}) {
  const spawnFn = deps.spawn || spawn;
  return new Promise((resolve) => {
    let child;
    try {
      // detached: the chained command runs in its own POSIX process group
      // (chain mode is POSIX-remote-only), so the timeout below can kill the
      // whole tree — SIGKILLing only the sh wrapper would orphan whatever it
      // spawned, and a hung statusline invoked on every sub-second refresh
      // accumulates exactly the orphans the cap exists to prevent.
      child = spawnFn("sh", ["-c", command], { stdio: ["pipe", "inherit", "ignore"], detached: true });
    } catch {
      resolve("spawn-failed");
      return;
    }
    const cap = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch {}
      }
      resolve("timeout");
    }, Number.isFinite(deps.chainCapMs) ? deps.chainCapMs : CHAIN_EXIT_CAP_MS);
    child.on("error", () => { clearTimeout(cap); resolve("spawn-failed"); });
    child.on("close", () => { clearTimeout(cap); resolve("ok"); });
    try {
      child.stdin.on("error", () => {});
      child.stdin.end(stdinText || "");
    } catch {}
  });
}

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

function buildStateBody(payload, quota, contextUsage, options = {}) {
  const sessionId = payload && payload.session_id;
  if (!sessionId || (!quota && !contextUsage)) return null;

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
  };
  if (quota) body.claude_quota = quota;
  if (contextUsage) body.context_usage = contextUsage;
  const cwd = payload && payload.workspace && typeof payload.workspace.current_dir === "string"
    ? payload.workspace.current_dir
    : "";
  if (cwd) body.cwd = cwd;
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
    // Status-line quota forwarding is best-effort telemetry, not a blocking
    // hook. Keep its small timeout even on CLAWD_REMOTE: the shared transport
    // normally raises every remote request to 5s, which is appropriate for
    // state/permission hooks but lets a stale reverse tunnel accumulate
    // long-lived status-line processes. The payload itself is still stamped as
    // remote by buildStateBody; this override only controls transport timing.
    postState(
      JSON.stringify(body),
      { timeoutMs: STATE_POST_TIMEOUT_MS, env, remote: false },
      (posted) => resolve(!!posted)
    );
  });
}

async function main(deps = {}) {
  const env = deps.env || process.env;
  const argv = deps.argv || process.argv.slice(2);
  const writeStdout = deps.writeStdout || ((chunk) => process.stdout.write(chunk));
  let payload = null;
  try {
    payload = deps.payload !== undefined ? deps.payload : await (deps.readStdinJson || readStdinJson)();
  } catch {
    payload = null;
  }

  let quota = null;
  let contextUsage = null;
  let modelLabel = null;
  let text = "";
  try {
    quota = resolveClaudeRateLimitQuota(payload);
    contextUsage = extractClaudeStatuslineContextUsage(payload);
    modelLabel = resolveClaudeModelLabel(payload);
    text = buildStatusLineText(payload, quota, modelLabel);
  } catch {
    // fall through with whatever defaults were already assigned
  }

  // Chain first, POST second: the chained script streams the user's visible
  // line as soon as it spawns, so a slow or downed tunnel can never delay
  // their rendering. Missing/unreadable sidecar degrades to plain mode
  // (rendering our own text beats a blank status line).
  let chainPromise = null;
  if (argv.includes("--chain")) {
    const chainedCommand = (deps.readChainedCommand || readChainedCommand)(
      resolveChainSidecarPath(deps)
    );
    if (chainedCommand) {
      let stdinText = "";
      try { stdinText = payload === null ? "" : JSON.stringify(payload); } catch {}
      chainPromise = runChainedStatusLine(chainedCommand, stdinText, deps);
    }
  }

  // Plain mode owns the visible line, so publish it before touching the
  // network. Claude reads the child pipe as it runs; a slow or half-open SSH
  // reverse tunnel must never hold the terminal UI behind quota forwarding.
  // Chain mode keeps stdout reserved for the user's command and only falls
  // back below when that command could not spawn at all.
  if (!chainPromise) writeStdout(`${text}\n`);

  let chainResult = null;
  try {
    const remote = !!env.CLAWD_REMOTE;
    const body = buildStateBody(payload, quota, contextUsage, {
      remote,
      host: remote && deps.readHostPrefix ? deps.readHostPrefix() : undefined,
      applyWslSourceFields: deps.applyWslSourceFields,
    });
    const postPromise = postStateBody(body, deps, env);
    if (chainPromise) [chainResult] = await Promise.all([chainPromise, postPromise]);
    else await postPromise;
  } catch {
    // Never let a failed/slow POST take down the visible status line.
    if (chainPromise) { try { chainResult = await chainPromise; } catch {} }
  }

  // In chain mode the chained script owns stdout - writing our own line too
  // would corrupt theirs. Exception: a chain that never ran ("spawn-failed",
  // e.g. the command's binary is gone) rendered nothing, so falling back to
  // our plain line beats a permanently blank status line. A "timeout" chain
  // may have already rendered before hanging - stay silent there.
  if (chainResult === "spawn-failed") writeStdout(`${text}\n`);
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
    readChainedCommand,
    resolveChainSidecarPath,
    runChainedStatusLine,
    main,
  },
};
