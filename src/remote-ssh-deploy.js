"use strict";

// ── Remote SSH deploy ──
//
// Node implementation of `scripts/remote-deploy.sh` step-by-step. Used by the
// Settings Remote SSH tab "Deploy / Repair Hooks" button. The shell script is
// kept as a CLI fallback; HOOK_FILES below is the source of truth on the Node
// side, and `test/remote-ssh-deploy.test.js` enforces both lists agree.
//
// All ssh / scp invocations route through buildSshArgs / buildScpArgs from
// remote-ssh-runtime so non-default `-i identityFile` / `-p port` profiles
// also Deploy correctly (v7 fix). Progress reports flow through the
// runtime's emitter as `progress` events with shape:
//
//   { profileId, step, status: "start"|"ok"|"fail", message? }
//
// Steps in order: mkdir → check-node → scp → host-prefix → install-claude
// → install-codex (last two are best-effort — failures don't abort).

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const { buildSshArgs, buildScpArgs } = require("./remote-ssh-runtime");
const {
  resolveRemoteNodeBin,
  buildRemoteHookNodeCommand,
} = require("./remote-ssh-node");

// ── Hook files manifest ──
//
// Source of truth on the Node side. Mirrors `FILES=()` in
// `scripts/remote-deploy.sh`. A test (test/remote-ssh-deploy.test.js) parses
// the shell array with a strict regex and asserts set equality with this list,
// so adding a new hook file requires updating both spots intentionally.
const HOOK_FILES = [
  "server-config.js",
  "json-utils.js",
  "shared-process.js",
  "clawd-hook.js",
  "install.js",
  "codex-hook.js",
  "codex-install.js",
  "codex-install-utils.js",
  "codex-remote-monitor.js",
  "codex-session-index.js",
  "codex-subagent-fields.js",
  "copilot-hook.js",
  "copilot-install.js",
];

// Resolve hooks dir for both dev (source tree) and packaged (asar.unpacked).
// Caller can override via deps.hooksDir for tests.
function resolveHooksDir({ app, isPackaged } = {}) {
  if (isPackaged) {
    return path.join(process.resourcesPath, "app.asar.unpacked", "hooks");
  }
  // dev path: src/remote-ssh-deploy.js → ../hooks
  return path.join(__dirname, "..", "hooks");
}

function spawnAndWait(spawn, command, args, opts = {}) {
  const { stdin, env, timeoutMs = 60000, runtime } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        env: { ...process.env, LANG: "C", LC_ALL: "C", ...(env || {}) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: -1, signal: null, stdout: "", stderr: (err && err.message) || "spawn failed", spawnError: true });
      return;
    }
    // Register with runtime so before-quit cleanup can kill the child if
    // the user closes the app mid-Deploy. Unregister on resolve so we
    // don't pile up references for completed children.
    if (runtime && typeof runtime.registerChild === "function") {
      runtime.registerChild(child);
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      try { child.kill(); } catch {}
    }, timeoutMs);

    function finish(payload) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (runtime && typeof runtime.unregisterChild === "function") {
        runtime.unregisterChild(child);
      }
      resolve(payload);
    }

    if (child.stdout) child.stdout.on("data", (d) => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on("data", (d) => { stderr += d.toString(); });

    if (stdin != null && child.stdin) {
      try {
        child.stdin.end(stdin);
      } catch {
        // Will surface as exit error.
      }
    } else if (child.stdin) {
      try { child.stdin.end(); } catch {}
    }

    child.on("error", (err) => {
      finish({ code: -1, signal: null, stdout, stderr: stderr || (err && err.message) || "process error", spawnError: true });
    });
    child.on("exit", (code, signal) => {
      finish({ code, signal, stdout, stderr });
    });
  });
}

// ── Deploy ──

async function deploy({ profile, runtime, deps = {} }) {
  if (!profile || !profile.id) throw new Error("deploy: profile.id required");
  if (!runtime || typeof runtime.emit !== "function") {
    throw new Error("deploy: runtime emitter required");
  }
  const spawn = deps.spawn || childProcess.spawn;
  const hooksDir = deps.hooksDir || resolveHooksDir({ isPackaged: deps.isPackaged });
  const log = deps.log || (() => {});

  function progress(step, status, message) {
    runtime.emit("progress", { profileId: profile.id, step, status, message: message || null });
  }

  // 0. Verify local hook files exist before touching the network.
  const missing = [];
  for (const name of HOOK_FILES) {
    const full = path.join(hooksDir, name);
    if (!fs.existsSync(full)) missing.push(full);
  }
  if (missing.length > 0) {
    progress("verify", "fail", `Missing local hook files: ${missing.join(", ")}`);
    return { ok: false, step: "verify", message: `Missing files: ${missing.join(", ")}` };
  }
  progress("verify", "ok");

  // 1. mkdir -p ~/.claude/hooks
  progress("mkdir", "start");
  {
    const args = buildSshArgs(profile).concat(["mkdir -p ~/.claude/hooks"]);
    const r = await spawnAndWait(spawn, "ssh", args, { runtime });
    if (r.code !== 0) {
      progress("mkdir", "fail", summarizeStderr(r.stderr) || `ssh exited ${formatExit(r)}`);
      return { ok: false, step: "mkdir", message: r.stderr || `ssh exited ${formatExit(r)}` };
    }
    progress("mkdir", "ok");
  }

  // 2. Resolve remote Node — abort if the remote has no executable Node.
  progress("check-node", "start");
  let remoteNode;
  let remoteNodeInfo;
  {
    const resolved = await resolveRemoteNodeBin({
      profile,
      spawn,
      buildSshArgs,
      runtime,
      verifyCache: true,
    });
    if (!resolved.ok) {
      progress("check-node", "fail", resolved.message || "remote node not found");
      return {
        ok: false,
        step: "check-node",
        message: resolved.message || "Remote Node.js not found. Install Node on the remote first.",
      };
    }
    remoteNode = resolved.nodeBin;
    remoteNodeInfo = {
      nodeBin: resolved.nodeBin,
      version: resolved.version || null,
      source: resolved.source || null,
    };
    const label = [resolved.version, resolved.source ? `via ${resolved.source}` : null]
      .filter(Boolean)
      .join(" ");
    progress("check-node", "ok", label);
  }

  // 3. scp hook files. Single scp invocation with all files for efficiency.
  progress("scp", "start");
  {
    const localFiles = HOOK_FILES.map((name) => path.join(hooksDir, name));
    const remoteTarget = `${profile.host}:~/.claude/hooks/`;
    const args = buildScpArgs(profile).concat([...localFiles, remoteTarget]);
    const r = await spawnAndWait(spawn, "scp", args, { timeoutMs: 120000, runtime });
    if (r.code !== 0) {
      progress("scp", "fail", summarizeStderr(r.stderr) || `scp exited ${formatExit(r)}`);
      return { ok: false, step: "scp", message: r.stderr || `scp exited ${formatExit(r)}` };
    }
    progress("scp", "ok", `${HOOK_FILES.length} files copied`);
  }

  // 4. host prefix — write via ssh stdin (`cat > path`) to avoid any remote
  // shell interpolation of the hostPrefix string. v7 hardening: schema
  // already blacklists `'"$\``\\!`, but stdin write is the second layer.
  if (typeof profile.hostPrefix === "string" && profile.hostPrefix.length > 0) {
    progress("host-prefix", "start");
    const args = buildSshArgs(profile).concat([
      "cat > ~/.claude/hooks/clawd-host-prefix",
    ]);
    // Write without a trailing newline — remote hooks/server-config.js reads
    // with .trim(), so it's robust to either, but no-newline avoids
    // CRLF / LF surprises across platforms.
    const r = await spawnAndWait(spawn, "ssh", args, { stdin: profile.hostPrefix, runtime });
    if (r.code !== 0) {
      progress("host-prefix", "fail", summarizeStderr(r.stderr) || `ssh exited ${formatExit(r)}`);
      return { ok: false, step: "host-prefix", message: r.stderr || `ssh exited ${formatExit(r)}` };
    }
    progress("host-prefix", "ok");
  }

  // 5. ~/.claude/hooks/install.js --remote — Claude hook registration.
  progress("install-claude", "start");
  {
    const args = buildSshArgs(profile).concat([
      buildRemoteHookNodeCommand(remoteNode, "install.js", ["--remote"]),
    ]);
    const r = await spawnAndWait(spawn, "ssh", args, { timeoutMs: 60000, runtime });
    if (r.code !== 0) {
      // Best-effort — log but don't abort. Claude may not be installed remotely.
      progress("install-claude", "fail", summarizeStderr(r.stderr) || `non-zero exit ${formatExit(r)}`);
    } else {
      progress("install-claude", "ok");
    }
  }

  // 6. ~/.claude/hooks/codex-install.js --remote — Codex hook registration.
  progress("install-codex", "start");
  {
    const args = buildSshArgs(profile).concat([
      buildRemoteHookNodeCommand(remoteNode, "codex-install.js", ["--remote"]),
    ]);
    const r = await spawnAndWait(spawn, "ssh", args, { timeoutMs: 60000, runtime });
    if (r.code !== 0) {
      progress("install-codex", "fail", summarizeStderr(r.stderr) || `non-zero exit ${formatExit(r)}`);
    } else {
      progress("install-codex", "ok");
    }
  }

  // 7. ~/.claude/hooks/copilot-install.js --remote — Copilot CLI hook registration.
  // Best-effort: silently degrades when Copilot CLI is not installed remotely
  // (the installer skips and exits 0 when ~/.copilot/ is missing).
  progress("install-copilot", "start");
  {
    const args = buildSshArgs(profile).concat([
      buildRemoteHookNodeCommand(remoteNode, "copilot-install.js", ["--remote"]),
    ]);
    const r = await spawnAndWait(spawn, "ssh", args, { timeoutMs: 60000, runtime });
    if (r.code !== 0) {
      progress("install-copilot", "fail", summarizeStderr(r.stderr) || `non-zero exit ${formatExit(r)}`);
    } else {
      progress("install-copilot", "ok");
    }
  }

  return { ok: true, remoteNode: remoteNodeInfo };
}

// ── Codex remote monitor PID management ──
//
// `~/.clawd-codex-monitor.pid` on the remote is a fixed marker holding the
// last-launched monitor PID. `startCodexMonitor` first kills any prior
// monitor (avoiding orphan accumulation per v7) then launches a fresh one
// and writes the new PID. `stopCodexMonitor` kills the PID and rms the file.

async function startCodexMonitor({ profile, runtime = null, deps = {} }) {
  const spawn = deps.spawn || childProcess.spawn;
  let remoteNode = deps.nodeBin;
  if (!remoteNode) {
    const resolved = await resolveRemoteNodeBin({
      profile,
      spawn,
      buildSshArgs,
      runtime,
      verifyCache: true,
    });
    if (!resolved.ok) {
      return { ok: false, stderr: resolved.message || "Remote Node.js not found" };
    }
    remoteNode = resolved.nodeBin;
  }
  // Pre-clean step: best-effort, never fatal. The trailing `; true` makes
  // the whole compound exit 0 even if no PID file exists or kill fails.
  const cleanCmd =
    "[ -f ~/.clawd-codex-monitor.pid ] && kill $(cat ~/.clawd-codex-monitor.pid) 2>/dev/null; " +
    "rm -f ~/.clawd-codex-monitor.pid; true";
  const cleanArgs = buildSshArgs(profile).concat([cleanCmd]);
  await spawnAndWait(spawn, "ssh", cleanArgs, { runtime });

  // Launch new monitor in background and capture its PID.
  const startCmd =
    `nohup ${buildRemoteHookNodeCommand(remoteNode, "codex-remote-monitor.js", ["--port", profile.remoteForwardPort])} ` +
    "> /dev/null 2>&1 & echo $! > ~/.clawd-codex-monitor.pid";
  const startArgs = buildSshArgs(profile).concat([startCmd]);
  const r = await spawnAndWait(spawn, "ssh", startArgs, { runtime });
  return { ok: r.code === 0, stderr: r.stderr };
}

async function stopCodexMonitor({ profile, runtime = null, deps = {} }) {
  const spawn = deps.spawn || childProcess.spawn;
  const cmd =
    "[ -f ~/.clawd-codex-monitor.pid ] && kill $(cat ~/.clawd-codex-monitor.pid) 2>/dev/null; " +
    "rm -f ~/.clawd-codex-monitor.pid";
  const args = buildSshArgs(profile).concat([cmd]);
  const r = await spawnAndWait(spawn, "ssh", args, { runtime });
  // best-effort — don't surface failures. Caller decides whether to log.
  return { ok: true, stderr: r.stderr };
}

// ── Helpers ──

function formatExit(r) {
  if (r.signal) return `signal ${r.signal}`;
  return `code ${r.code == null ? "?" : r.code}`;
}

function summarizeStderr(text) {
  const t = (text || "").toString().trim();
  if (!t) return null;
  return t.length > 200 ? t.slice(0, 200) + "..." : t;
}

module.exports = {
  HOOK_FILES,
  resolveHooksDir,
  deploy,
  startCodexMonitor,
  stopCodexMonitor,
};
