"use strict";

// ── Remote SSH deploy ──
//
// Secure deployment controller used by the Settings Remote SSH tab
// "Deploy / Repair Hooks" button. The former shell entrypoint is intentionally
// a fail-fast tombstone because it cannot participate in identity transactions
// or runtime-scoped leases.
//
// Conceptually mirrors src/wsl-deploy.js: both deploy hook scripts to a
// remote environment and run agent-specific install scripts. Step lists
// differ (scp vs wsl.exe stdin pipe) but new deploy requirements should
// be addressed in both paths.
//
// All ssh / scp invocations route through buildSshArgs / buildScpArgs from
// remote-ssh-runtime so non-default `-i identityFile` / `-p port` profiles
// also Deploy correctly (v7 fix). Progress reports flow through the
// runtime's emitter as `progress` events with shape:
//
//   { profileId, step, status: "start"|"ok"|"fail", message? }
//
// Steps in order: verify → remote-shell → mkdir → check-node → scp →
// host-prefix → install-claude → install-codex → install-copilot
// (last three are best-effort — failures don't abort).
//
// remote-shell aborts the deploy when the remote default shell is cmd.exe:
// every later step would fail anyway (`mkdir -p`, `~/...` expansion, the
// POSIX `sh -c` invoked by buildRemoteHookNodeCommand), and the cmd.exe
// stderr would land in the renderer as CP936/GBK mojibake — so it's both
// a cheaper failure and a more actionable message to stop here.

const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { buildSshArgs, buildScpArgs } = require("./remote-ssh-runtime");
const {
  resolveRemoteNodeBin,
  buildRemoteHookNodeCommand,
  buildRemoteNodeEvalCommand,
} = require("./remote-ssh-node");
const { decodeShellBytes } = require("./remote-ssh-decode");
const { redactTransportDiagnostic } = require("./remote-ssh-transport");
const { detectRemoteShell } = require("./remote-ssh-shell-detect");
const {
  normalizeRemoteRuntimeIdentity,
  resolveRemoteRuntimeLayout,
} = require("./remote-ssh-layout");
const { buildRemoteIdentityDocument } = require("./remote-ssh-identity");
const { quoteForPosixShellArg } = require("./remote-ssh-quote");

// ── Hook files manifest ──
//
// Single source of truth. The former shell deploy path is now a fail-fast
// tombstone because it cannot participate in profile identity transactions.
const HOOK_FILES = [
  "server-config.js",
  "json-utils.js",
  "shared-process.js",
  "pid-cache.js",
  "context-usage.js",
  "antigravity-context-usage.js",
  "claude-rate-limits.js",
  "claude-statusline.js",
  "codex-rate-limits.js",
  "quota-bucket.js",
  "state-payload-size.js",
  "claude-stop-disposition.js",
  "session-recovery-lease.js",
  "clawd-hook.js",
  "install.js",
  "uninstall.js",
  "codex-hook.js",
  "codex-originator.js",
  "codex-assistant-output.js",
  "codex-user-input.js",
  "codex-install.js",
  "codex-install-utils.js",
  "codex-remote-monitor.js",
  "codex-session-index.js",
  "codex-subagent-fields.js",
  "copilot-hook.js",
  "copilot-install.js",
];
const ISOLATED_CLI_MINIMUMS = Object.freeze({
  // Claude has a reviewed baseline in plan v8. Codex/Copilot stay fail-closed
  // until the real CLI matrix establishes supported minimums.
  claude: Object.freeze({ major: 2, minor: 1, patch: 211 }),
  codex: null,
  copilot: null,
});
const WRAPPER_EVIDENCE_VERSION = "clawd-wrapper-evidence-v1";

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
  const {
    stdin,
    env,
    timeoutMs = 60000,
    runtime,
    role = command,
    mutation = false,
  } = opts;
  return new Promise((resolve, reject) => {
    let child;
    const managed = runtime && typeof runtime.spawnManagedTransportChild === "function";
    const childOptions = {
      env: { ...process.env, LANG: "C", LC_ALL: "C", ...(env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    };
    try {
      child = managed
        ? runtime.spawnManagedTransportChild({ role, tool: command, args, options: childOptions })
        : spawn(command, args, childOptions);
    } catch (err) {
      if (managed) {
        reject(err);
        return;
      }
      resolve({ code: -1, signal: null, stdout: "", stderr: (err && err.message) || "spawn failed", spawnError: true });
      return;
    }
    // Register with runtime so before-quit cleanup can kill the child if
    // the user closes the app mid-Deploy. Unregister on resolve so we
    // don't pile up references for completed children.
    if (!managed && runtime && typeof runtime.registerChild === "function") {
      runtime.registerChild(child);
    }
    // Accumulate raw bytes — decode once at finish via decodeShellBytes so
    // GBK/CP936 from a Windows or zh-locale remote doesn't become mojibake
    // (per-chunk toString() also risks splitting multi-byte chars across
    // boundaries).
    const stdoutChunks = [];
    const stderrChunks = [];
    let done = false;
    let exitCode = null;
    let exitSignal = null;
    let processError = null;
    let timedOut = false;
    let drainTimer = null;
    const timer = setTimeout(() => {
      if (done) return;
      timedOut = true;
      // A managed serialized child is not force-killed here. Closing only the
      // outer ssh process cannot prove that its nested ProxyCommand transport
      // has drained. Keep tracking it and quarantine if it will not close on
      // its own. Ordinary transports retain the legacy termination request.
      if (!managed) {
        try { child.kill(); } catch {}
      }
      // A timeout request is not a verified drain. Serialized operation
      // contexts invalidate here and retain their independent close registry;
      // the public operation can still return within a bound.
      drainTimer = setTimeout(() => {
        if (done) return;
        const err = Object.assign(new Error("Remote SSH child did not close after timeout"), {
          name: "TransportUndrainedError",
          code: "transport_drain_timeout",
          timedOut: true,
          drainVerified: false,
          role,
          tool: command,
        });
        if (managed && typeof runtime.invalidateManagedOperation === "function") {
          try { runtime.invalidateManagedOperation(err); } catch {}
          done = true;
          clearTimeout(timer);
          reject(err);
          return;
        }
        // Ordinary transports retain the exact child in runtime's auxiliary
        // registry for app cleanup; do not unregister it here.
        done = true;
        clearTimeout(timer);
        resolve({
          code: exitCode,
          signal: exitSignal,
          stdout: decodeShellBytes(stdoutChunks),
          stderr: decodeShellBytes(stderrChunks),
          timedOut: true,
          drainVerified: false,
        });
      }, 5000);
    }, timeoutMs);

    function finish(payload, { unregister = true } = {}) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      if (unregister && !managed && runtime && typeof runtime.unregisterChild === "function") {
        runtime.unregisterChild(child);
      }
      if (managed && runtime && typeof runtime.assertTransportActive === "function") {
        try {
          runtime.assertTransportActive();
        } catch (err) {
          reject(err);
          return;
        }
      }
      resolve(payload);
    }

    if (child.stdout) child.stdout.on("data", (d) => { stdoutChunks.push(d); });
    if (child.stderr) child.stderr.on("data", (d) => { stderrChunks.push(d); });

    if (stdin != null && child.stdin) {
      try {
        child.stdin.end(stdin);
      } catch {
        // Will surface as exit error.
      }
    } else if (child.stdin) {
      try { child.stdin.end(); } catch {}
    }

    child.on("error", (err) => { processError = err; });
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    child.on("close", (code, signal) => {
      const stdout = decodeShellBytes(stdoutChunks);
      const stderr = decodeShellBytes(stderrChunks);
      if (managed && timedOut) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (drainTimer) clearTimeout(drainTimer);
        const err = Object.assign(new Error("Remote SSH child exceeded its operation deadline"), {
          name: "TransportOperationTimeoutError",
          code: "transport_operation_timeout",
          timedOut: true,
          drainVerified: true,
          role,
          tool: command,
        });
        if (runtime && typeof runtime.settleManagedTimeoutAfterClose === "function") {
          try { runtime.settleManagedTimeoutAfterClose(err); } catch {}
        }
        reject(err);
        return;
      }
      const payload = {
        code: exitCode === null ? code : exitCode,
        signal: exitSignal === null ? signal : exitSignal,
        stdout,
        stderr: stderr || (processError && processError.message) || "",
        ...(processError ? { spawnError: true } : {}),
        ...(timedOut ? { timedOut: true, drainVerified: true } : {}),
      };
      const ambiguousMutation = managed && mutation && payload.code !== 0 && (
        payload.code === 255
        || payload.signal != null
        || /(?:^|\s)EOF(?:\s|$)|connection (?:closed|reset)|broken pipe/i.test(payload.stderr)
      );
      if (ambiguousMutation) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (drainTimer) clearTimeout(drainTimer);
        const err = Object.assign(new Error("Remote SSH mutation completed with an unknown transport result"), {
          name: "TransportUnknownResultError",
          code: "transport_unknown_result",
          role,
          tool: command,
          exitCode: payload.code,
          signal: payload.signal,
          drainVerified: true,
        });
        if (runtime && typeof runtime.invalidateManagedOperation === "function") {
          try { runtime.invalidateManagedOperation(err); } catch {}
        }
        reject(err);
        return;
      }
      finish(payload);
    });
  });
}

function managedTransportIsActive(runtime) {
  if (!runtime || typeof runtime.assertTransportActive !== "function") return true;
  try {
    runtime.assertTransportActive();
    return true;
  } catch {
    return false;
  }
}

// ── Deploy ──

async function legacyDeploy({ profile, runtime, deps = {} }) {
  if (!profile || !profile.id) throw new Error("deploy: profile.id required");
  if (!runtime || typeof runtime.emit !== "function") {
    throw new Error("deploy: runtime emitter required");
  }
  const spawn = deps.spawn || childProcess.spawn;
  const hooksDir = deps.hooksDir || resolveHooksDir({ isPackaged: deps.isPackaged });
  const detectShellFn = deps.detectRemoteShell || detectRemoteShell;
  const log = deps.log || (() => {});

  function progress(step, status, message, hint) {
    runtime.emit("progress", {
      profileId: profile.id,
      step,
      status,
      message: message ? redactTransportDiagnostic(message, profile) : null,
      hint: hint || null,
    });
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

  // 0.5. Remote shell probe — bail out early on Windows cmd.exe so the
  // user gets a single actionable error instead of CP936 mojibake from
  // every subsequent POSIX command. Unknown shells fall through; if the
  // host is some custom POSIX-ish setup, the existing steps still run.
  progress("remote-shell", "start");
  const shell = await detectShellFn({ profile, spawn, buildSshArgs, runtime });
  if (shell && shell.shell === "windows-cmd") {
    const msg = "Remote default shell is Windows cmd.exe. Remote SSH needs a POSIX shell — set OpenSSH DefaultShell to Git Bash or WSL bash on the remote, then redeploy.";
    progress("remote-shell", "fail", msg, "remoteSshErrWindowsCmdShell");
    return {
      ok: false,
      step: "remote-shell",
      reason: "windows_cmd_shell",
      hint: "remoteSshErrWindowsCmdShell",
      message: msg,
    };
  }
  progress("remote-shell", "ok", shell && shell.os ? shell.os : null);

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
  // --chain-existing (profile opt-in) additionally lets the statusline
  // installer wrap a pre-existing third-party statusline on the remote
  // instead of skipping it (see install.js registerClaudeStatusline).
  progress("install-claude", "start");
  {
    const installClaudeArgs = profile.chainStatusline === true
      ? ["--remote", "--chain-existing"]
      : ["--remote"];
    const args = buildSshArgs(profile).concat([
      buildRemoteHookNodeCommand(remoteNode, "install.js", installClaudeArgs),
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

const INSTALL_ID_RE = /^[a-f0-9]{64}$/;
const LEASE_ID_RE = /^[a-f0-9]{32}$/;

function compactJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function assertLeaseCommand(layout, leaseId, remoteNode) {
  const js = [
    "const fs=require('fs');",
    `const p=${JSON.stringify(path.posix.join(layout.deployLockDir, "owner"))};`,
    "let o;try{o=JSON.parse(fs.readFileSync(p,'utf8'))}catch{process.exit(91)}",
    `if(o.leaseId!==${JSON.stringify(leaseId)}||o.runtimeKey!==${JSON.stringify(layout.runtimeKey)}||o.layoutVersion!==${layout.layoutVersion})process.exit(92);`,
  ].join("");
  return buildRemoteNodeEvalCommand(remoteNode, js);
}

function fencedCommand(layout, leaseId, remoteNode, command) {
  return `${assertLeaseCommand(layout, leaseId, remoteNode)} && (\n${command}\n)`;
}

async function resolveRemoteHome({ profile, spawn, runtime }) {
  const command = "printf 'CLAWD_REMOTE_HOME=%s\\n' \"$HOME\"";
  const result = await spawnAndWait(
    spawn,
    "ssh",
    buildSshArgs(profile).concat([command]),
    { runtime },
  );
  if (result.code !== 0) {
    return { ok: false, message: result.stderr || `ssh exited ${formatExit(result)}` };
  }
  const match = String(result.stdout || "").match(/(?:^|\n)CLAWD_REMOTE_HOME=([^\r\n]+)(?:\r?\n|$)/);
  if (!match) return { ok: false, message: "Remote HOME could not be resolved" };
  try {
    const layout = resolveRemoteRuntimeLayout({
      runtimeMode: profile.runtimeMode,
      runtimeKey: profile.runtimeKey,
      remoteHome: match[1],
    });
    return { ok: true, layout };
  } catch (err) {
    return { ok: false, message: err && err.message };
  }
}

async function acquireDeployLock({
  profile,
  layout,
  installId,
  leaseId,
  spawn,
  runtime,
  now = Date.now,
}) {
  if (runtime && typeof runtime.setManagedLockStage === "function") {
    runtime.setManagedLockStage("acquire-attempted");
  }
  const owner = {
    leaseId,
    installId,
    profileId: profile.id,
    runtimeKey: layout.runtimeKey,
    layoutVersion: layout.layoutVersion,
    acquiredAt: now(),
  };
  const lock = quoteForPosixShellArg(layout.deployLockDir);
  const ownerPath = quoteForPosixShellArg(path.posix.join(layout.deployLockDir, "owner"));
  const tmpPath = quoteForPosixShellArg(path.posix.join(layout.deployLockDir, `.owner-${leaseId}.tmp`));
  const command = [
    "umask 077",
    `if mkdir ${lock} 2>/dev/null; then`,
    `  if cat > ${tmpPath} && mv -f ${tmpPath} ${ownerPath}; then exit 0; fi`,
    `  rm -f ${tmpPath}`,
    `  rmdir ${lock} 2>/dev/null || true`,
    "  exit 75",
    "fi",
    `if [ -f ${ownerPath} ]; then cat ${ownerPath}; exit 73; fi`,
    "exit 74",
  ].join("\n");
  const result = await spawnAndWait(
    spawn,
    "ssh",
    buildSshArgs(profile).concat([command]),
    { stdin: compactJson(owner), runtime, role: "deploy-lock-acquire", mutation: true },
  );
  if (result.code === 0) {
    if (runtime && typeof runtime.setManagedLockStage === "function") {
      runtime.setManagedLockStage("lock-owned");
    }
    return { ok: true, owner };
  }
  if ((result.code === 73 || result.code === 74)
    && runtime && typeof runtime.setManagedLockStage === "function") {
    // The remote command proved that this lease never acquired the lock.
    // Keep the transport usable even though the remote lock itself may need
    // another owner (73) or manual inspection (74).
    runtime.setManagedLockStage("before-acquire");
  } else if (runtime && typeof runtime.invalidateManagedOperation === "function") {
    // Code 75 means mkdir may have succeeded but owner persistence/cleanup did
    // not. Any other unexpected result is likewise unsafe to treat as a
    // cleanly unowned lock.
    const err = Object.assign(new Error("Remote deployment lock acquisition requires manual inspection"), {
      name: "TransportRecoveryError",
      code: "lock_acquire_unknown",
      recoveryCode: "manual_lock_inspection_required",
      drainVerified: true,
    });
    try { runtime.invalidateManagedOperation(err); } catch {}
    throw err;
  }
  const reason = result.code === 73
    ? "lock_busy"
    : (result.code === 74 ? "lock_owner_invalid" : "lock_acquire_failed");
  return {
    ok: false,
    reason,
    ownerSummary: String(result.stdout || "").trim().slice(0, 500),
    message: reason === "lock_busy"
      ? "Another Clawd deployment owns this remote runtime; try again later."
      : `Remote deployment lock is unavailable at ${layout.deployLockDir}; do not remove it until all deployers are stopped.`,
  };
}

async function releaseDeployLock({ profile, layout, leaseId, remoteNode, spawn, runtime }) {
  const lock = quoteForPosixShellArg(layout.deployLockDir);
  const command = `${assertLeaseCommand(layout, leaseId, remoteNode)} && rm -rf ${lock}`;
  const result = await spawnAndWait(
    spawn,
    "ssh",
    buildSshArgs(profile).concat([command]),
    { runtime, role: "deploy-lock-release", mutation: true },
  );
  if (result.code !== 0 && runtime && typeof runtime.invalidateManagedOperation === "function") {
    const err = Object.assign(new Error("Remote deployment lock release requires manual inspection"), {
      name: "TransportRecoveryError",
      code: "manual_lock_inspection_required",
      recoveryCode: "manual_lock_inspection_required",
      drainVerified: true,
    });
    try { runtime.invalidateManagedOperation(err); } catch {}
    throw err;
  }
  if (result.code === 0 && runtime && typeof runtime.setManagedLockStage === "function") {
    runtime.setManagedLockStage("before-acquire");
  }
  return result;
}

function buildOwnershipPreflightScript({ profile, layout, installId }) {
  const expected = {
    installId,
    profileId: profile.id,
    runtimeKey: layout.runtimeKey,
    layoutVersion: layout.layoutVersion,
  };
  const tracePaths = [
    layout.secureMarkerFile,
    layout.hostPrefixFile,
    layout.monitorPidFile,
    ...(layout.legacyMonitorPidFile ? [layout.legacyMonitorPidFile] : []),
    path.posix.join(layout.claudeHooksDir, "server-config.js"),
  ];
  const configTracePaths = [
    layout.claudeSettingsFile,
    path.posix.join(layout.codexHome, "hooks.json"),
    path.posix.join(layout.copilotHome, "hooks", "hooks.json"),
    path.posix.join(layout.copilotHome, "settings.json"),
  ];
  const managedConfigMarkers = [
    "clawd-hook.js",
    "auto-start.js",
    "claude-statusline.js",
    "codex-hook.js",
    "copilot-hook.js",
  ];
  return [
    "const fs=require('fs');",
    `const identityPath=${JSON.stringify(layout.identityFile)};`,
    `const runtimePath=${JSON.stringify(path.posix.join(layout.clawdStateDir, "runtime.json"))};`,
    `const expected=${JSON.stringify(expected)};`,
    `const tracePaths=${JSON.stringify(tracePaths)};`,
    `const configTracePaths=${JSON.stringify(configTracePaths)};`,
    `const managedConfigMarkers=${JSON.stringify(managedConfigMarkers)};`,
    "let localClawdAlive=false;",
    "try{const r=JSON.parse(fs.readFileSync(runtimePath,'utf8'));if(Number.isInteger(r.ownerPid)&&r.ownerPid>0){try{process.kill(r.ownerPid,0);localClawdAlive=true}catch{}}}catch{}",
    `if(${JSON.stringify(layout.runtimeMode)}==='account-default'&&localClawdAlive){console.log(JSON.stringify({ok:false,reason:'local_clawd_conflict'}));process.exit(84)}`,
    "let identity=null;",
    "try{identity=JSON.parse(fs.readFileSync(identityPath,'utf8'))}catch(e){if(e&&e.code!=='ENOENT'){console.log(JSON.stringify({ok:false,reason:'identity_invalid'}));process.exit(82)}}",
    "if(identity){for(const k of Object.keys(expected)){if(identity[k]!==expected[k]){console.log(JSON.stringify({ok:false,reason:'ownership_conflict',field:k}));process.exit(83)}}}",
    "const traces=tracePaths.filter(p=>{try{return fs.existsSync(p)}catch{return true}});",
    "const configTraces=configTracePaths.filter(p=>{try{const raw=fs.readFileSync(p,'utf8');return managedConfigMarkers.some(m=>raw.includes(m))}catch(e){return e&&e.code!=='ENOENT'}});",
    "console.log(JSON.stringify({ok:true,identity:!!identity,legacyTraces:traces.length,legacyConfigTraces:configTraces.length,legacyMonitorPresent:"
      + (layout.legacyMonitorPidFile
        ? `fs.existsSync(${JSON.stringify(layout.legacyMonitorPidFile)})`
        : "false")
      + ",claudePresent:fs.existsSync(" + JSON.stringify(layout.claudeConfigDir) + "),codexPresent:fs.existsSync(" + JSON.stringify(layout.codexHome) + "),copilotPresent:fs.existsSync(" + JSON.stringify(layout.copilotHome) + ")}));",
  ].join("");
}

async function runOwnershipPreflight({
  profile,
  layout,
  installId,
  remoteNode,
  spawn,
  runtime,
}) {
  const command = buildRemoteNodeEvalCommand(
    remoteNode,
    buildOwnershipPreflightScript({ profile, layout, installId }),
  );
  const result = await spawnAndWait(
    spawn,
    "ssh",
    buildSshArgs(profile).concat([command]),
    { runtime },
  );
  let detail = null;
  try {
    const lines = String(result.stdout || "").trim().split(/\r?\n/);
    detail = JSON.parse(lines[lines.length - 1]);
  } catch {}
  if (result.code === 0 && detail && detail.ok) return { ok: true, detail };
  const reason = detail && detail.reason
    ? detail.reason
    : (result.code === 84 ? "local_clawd_conflict" : "ownership_preflight_failed");
  return {
    ok: false,
    reason,
    message: reason === "local_clawd_conflict"
      ? "A live Clawd desktop is using this remote account's default configuration. Deployment is blocked."
      : (reason === "ownership_conflict"
        ? "This remote runtime is owned by another Clawd installation or profile."
        : "Remote ownership could not be verified; no live files were changed."),
  };
}

function buildLegacyMonitorCleanupScript(layout) {
  if (!layout || layout.runtimeMode !== "account-default" || !layout.legacyMonitorPidFile) {
    throw new TypeError("legacy monitor cleanup is account-default only");
  }
  const expectedScript = path.posix.join(layout.claudeHooksDir, "codex-remote-monitor.js");
  return [
    "const fs=require('fs'),cp=require('child_process');",
    `const pidFile=${JSON.stringify(layout.legacyMonitorPidFile)};`,
    `const expected=${JSON.stringify(expectedScript)};`,
    "let raw;try{raw=fs.readFileSync(pidFile,'utf8').trim()}catch(e){if(e&&e.code==='ENOENT'){console.log(JSON.stringify({status:'absent'}));process.exit(0)}console.log(JSON.stringify({status:'unreadable'}));process.exit(0)}",
    "if(!/^[1-9]\\d*$/.test(raw)){console.log(JSON.stringify({status:'invalid-pid'}));process.exit(0)}",
    "const pid=Number(raw);let argv=[];let command='';",
    "try{argv=fs.readFileSync('/proc/'+pid+'/cmdline').toString('utf8').split('\\0').filter(Boolean)}catch{}",
    "if(!argv.length){try{command=cp.execFileSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8'}).trim()}catch{}}",
    "const escaped=expected.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&');",
    "const matches=argv.includes(expected)||new RegExp('(?:^|[\\\\s\"\\\\\\'])'+escaped+'(?:$|[\\\\s\"\\\\\\'])').test(command);",
    "if(!matches){console.log(JSON.stringify({status:argv.length||command?'command-mismatch':'pid-not-running'}));process.exit(0)}",
    "try{process.kill(pid,'SIGTERM')}catch(e){console.log(JSON.stringify({status:'kill-failed'}));process.exit(87)}",
    "try{fs.unlinkSync(pidFile)}catch(e){if(!e||e.code!=='ENOENT')process.exit(87)}",
    "console.log(JSON.stringify({status:'stopped'}));",
  ].join("");
}

async function cleanupLegacyMonitor({
  profile,
  layout,
  leaseId,
  remoteNode,
  spawn,
  runtime,
}) {
  if (layout.runtimeMode !== "account-default" || !layout.legacyMonitorPidFile) {
    return { ok: true, status: "not-applicable" };
  }
  const result = await spawnAndWait(
    spawn,
    "ssh",
    buildSshArgs(profile).concat([
      fencedCommand(
        layout,
        leaseId,
        remoteNode,
        buildRemoteNodeEvalCommand(remoteNode, buildLegacyMonitorCleanupScript(layout)),
      ),
    ]),
    { runtime, role: "legacy-monitor-cleanup", mutation: true },
  );
  let detail = null;
  try {
    detail = JSON.parse(String(result.stdout || "").trim().split(/\r?\n/).at(-1));
  } catch {}
  return {
    ok: result.code === 0,
    status: detail && typeof detail.status === "string" ? detail.status : "inspection-failed",
    stderr: result.stderr,
  };
}

function buildRemoteInstallerEnv(layout, remotePermissionTransport = "path") {
  return [
    `CLAUDE_CONFIG_DIR=${quoteForPosixShellArg(layout.claudeConfigDir)}`,
    `CODEX_HOME=${quoteForPosixShellArg(layout.codexHome)}`,
    `COPILOT_HOME=${quoteForPosixShellArg(layout.copilotHome)}`,
    "CLAWD_REMOTE=1",
    "CLAWD_SSH_REMOTE=1",
    `CLAWD_REMOTE_IDENTITY_PATH=${quoteForPosixShellArg(layout.identityFile)}`,
    `CLAWD_SSH_SECURE_MARKER_PATH=${quoteForPosixShellArg(layout.secureMarkerFile)}`,
    `CLAWD_HOST_PREFIX_PATH=${quoteForPosixShellArg(layout.hostPrefixFile)}`,
    `CLAWD_REMOTE_LAST_LOG_PATH=${quoteForPosixShellArg(layout.lastLogFile)}`,
    `CLAWD_STATUSLINE_SIDECAR_PATH=${quoteForPosixShellArg(layout.statuslineSidecarFile)}`,
    `CLAWD_REMOTE_PERMISSION_TRANSPORT=${quoteForPosixShellArg(
      remotePermissionTransport === "query" || remotePermissionTransport === "native"
        ? remotePermissionTransport
        : "path"
    )}`,
  ].join(" ");
}

function buildInstallerVerificationCommand(txnStep, layout, remoteNode) {
  const specs = {
    installClaude: {
      file: layout.claudeSettingsFile,
      commandFields: ["command"],
      commandMarkers: [
        "clawd-hook.js",
        layout.identityFile,
      ],
    },
    installCodex: {
      file: path.posix.join(layout.codexHome, "hooks.json"),
      commandFields: ["command"],
      commandMarkers: [
        "codex-hook.js",
        layout.identityFile,
        layout.codexHome,
      ],
    },
    installCopilot: {
      file: path.posix.join(layout.copilotHome, "hooks", "hooks.json"),
      commandFields: ["bash"],
      commandMarkers: [
        "copilot-hook.js",
        layout.identityFile,
        layout.copilotHome,
      ],
    },
  };
  const spec = specs[txnStep];
  if (!spec) throw new TypeError(`Unknown installer transaction step: ${String(txnStep)}`);
  const script = [
    "const fs=require('fs');",
    `const file=${JSON.stringify(spec.file)};`,
    `const commandFields=${JSON.stringify(spec.commandFields)};`,
    `const markers=${JSON.stringify(spec.commandMarkers)};`,
    "let raw;try{raw=fs.readFileSync(file,'utf8')}catch{process.exit(1)}",
    "let doc;try{doc=JSON.parse(raw)}catch{process.exit(2)}",
    "const commands=[];",
    "const walk=v=>{if(!v||typeof v!=='object')return;if(Array.isArray(v)){for(const x of v)walk(x);return}for(const [k,x] of Object.entries(v)){if(commandFields.includes(k)&&typeof x==='string')commands.push(x);else walk(x)}};",
    "walk(doc);",
    "const command=commands.find(value=>markers.every(marker=>value.includes(marker)));",
    "if(!command)process.exit(3);",
    "const commandTokens=command.trim().split(/\\s+/);",
    "const hasEnv=(name,value)=>[name+'='+value,name+\"='\"+value+\"'\",name+'=\"'+value+'\"'].some(token=>commandTokens.includes(token));",
    "if(!hasEnv('CLAWD_REMOTE','1')||!hasEnv('CLAWD_SSH_REMOTE','1'))process.exit(4);",
  ].join("");
  return buildRemoteNodeEvalCommand(remoteNode, script);
}

function buildMonitorVerificationCommand(layout, remoteNode) {
  const script = [
    "const fs=require('fs'),cp=require('child_process');",
    `const pidFile=${JSON.stringify(layout.monitorPidFile)};`,
    `const marker=${JSON.stringify(path.posix.join(layout.claudeHooksDir, "codex-remote-monitor.js"))};`,
    "let pid,stat;try{pid=Number(fs.readFileSync(pidFile,'utf8').trim());stat=fs.statSync(pidFile)}catch{process.exit(1)}",
    "if(!Number.isInteger(pid)||pid<=0)process.exit(2);",
    "try{process.kill(pid,0)}catch{process.exit(3)}",
    "const age=Date.now()-stat.mtimeMs;if(age< -5000||age>120000)process.exit(4);",
    "let command='';try{command=cp.execFileSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8'}).trim()}catch{process.exit(5)}",
    "if(!command.includes(marker))process.exit(6);",
  ].join("");
  return buildRemoteNodeEvalCommand(remoteNode, script);
}

function buildScpRemoteTarget(host, remoteDir) {
  if (typeof host !== "string" || !host) {
    throw new TypeError("buildScpRemoteTarget: host required");
  }
  if (typeof remoteDir !== "string" || !remoteDir.startsWith("/")) {
    throw new TypeError("buildScpRemoteTarget: absolute remoteDir required");
  }
  // child_process.spawn passes this as one argv token, so shell quoting is not
  // needed here. Embedded quote characters are interpreted literally by the
  // SFTP-backed scp used by current OpenSSH, producing a directory named "'".
  const targetDir = remoteDir.endsWith("/") ? remoteDir : `${remoteDir}/`;
  return `${host}:${targetDir}`;
}

function parseCliVersion(text) {
  const match = String(text || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? {
    raw: String(text || "").trim().slice(0, 160),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  } : null;
}

function versionAtLeast(version, minimum) {
  if (!version) return false;
  for (const key of ["major", "minor", "patch"]) {
    if (version[key] > minimum[key]) return true;
    if (version[key] < minimum[key]) return false;
  }
  return true;
}

async function probeRemoteCliCapabilities({
  profile,
  layout,
  remoteNode,
  spawn,
  runtime,
  minimums = ISOLATED_CLI_MINIMUMS,
}) {
  const script = [
    "const cp=require('child_process'),fs=require('fs'),p=require('path');",
    "const names=['claude','codex','copilot'];",
    `const roots=${JSON.stringify({
      claude: ["CLAUDE_CONFIG_DIR", layout.claudeConfigDir],
      codex: ["CODEX_HOME", layout.codexHome],
      copilot: ["COPILOT_HOME", layout.copilotHome],
    })};`,
    `const wrapperBin=${JSON.stringify(layout.binDir)};`,
    "const real=x=>{try{return fs.realpathSync(x)}catch{return p.resolve(x)}};",
    "const wrapperReal=real(wrapperBin);",
    "const searchPath=String(process.env.PATH||'').split(':').filter(x=>x&&real(x)!==wrapperReal).join(':');",
    "const out={};",
    "for(const name of names){",
    " let found='';for(const dir of searchPath.split(':')){const candidate=p.join(dir,name);try{fs.accessSync(candidate,fs.constants.X_OK);found=candidate;break}catch{}}",
    " if(!found||!found.startsWith('/')){out[name]={present:false};continue}",
    " const resolved=real(found);if(resolved===wrapperReal||resolved.startsWith(wrapperReal+p.sep)){out[name]={present:false};continue}",
    " const [envName,root]=roots[name];const env={...process.env,[envName]:root};",
    " let version='';try{version=cp.execFileSync(resolved,['--version'],{encoding:'utf8',timeout:10000,env}).trim().split(/\\r?\\n/)[0]}catch(e){version=String(e&&e.stdout||'').trim().split(/\\r?\\n/)[0]}",
    " out[name]={present:true,path:resolved,version:version.slice(0,160)};",
    "}",
    "console.log(JSON.stringify(out));",
  ].join("");
  const result = await spawnAndWait(
    spawn,
    "ssh",
    buildSshArgs(profile).concat([buildRemoteNodeEvalCommand(remoteNode, script)]),
    { runtime },
  );
  if (result.code !== 0) return { ok: false, reason: "cli_probe_failed", stderr: result.stderr };
  let raw;
  try {
    raw = JSON.parse(String(result.stdout || "").trim().split(/\r?\n/).at(-1));
  } catch {
    return { ok: false, reason: "cli_probe_invalid", stderr: "Remote CLI probe returned invalid data" };
  }
  const capabilities = {};
  for (const name of ["claude", "codex", "copilot"]) {
    const entry = raw && raw[name];
    const validPath = entry && entry.present === true
      && typeof entry.path === "string"
      && path.posix.isAbsolute(entry.path)
      && !/[\x00-\x1f\x7f]/.test(entry.path);
    const parsedVersion = validPath ? parseCliVersion(entry.version) : null;
    const minimum = minimums[name];
    capabilities[name] = validPath ? {
      present: true,
      executablePath: entry.path,
      version: parsedVersion ? parsedVersion.raw : String(entry.version || "").slice(0, 160),
      versionVerified: !!minimum && versionAtLeast(parsedVersion, minimum),
    } : { present: false, versionVerified: false };
  }
  return { ok: true, capabilities };
}

function buildWrapperEvidence(executablePath, envName, envValue) {
  return [
    WRAPPER_EVIDENCE_VERSION,
    envName,
    envValue,
    executablePath,
    "",
  ].join("\n");
}

function buildIsolatedWrapper(layout, executablePath, envName, envValue, evidenceFile) {
  const evidenceTmp = `${evidenceFile}.tmp.$$`;
  const evidence = buildWrapperEvidence(executablePath, envName, envValue);
  return [
    "#!/bin/sh",
    "umask 077",
    `mkdir -p ${quoteForPosixShellArg(layout.wrapperEvidenceDir)} || exit 1`,
    `chmod 700 ${quoteForPosixShellArg(layout.wrapperEvidenceDir)} || exit 1`,
    `export ${envName}=${quoteForPosixShellArg(envValue)}`,
    `${quoteForPosixShellArg(executablePath)} "$@"`,
    "status=$?",
    "if [ \"$status\" -eq 0 ]; then",
    `  evidence_tmp=${quoteForPosixShellArg(evidenceTmp)}`,
    `  printf '%s' ${quoteForPosixShellArg(evidence)} > "$evidence_tmp" && chmod 600 "$evidence_tmp" && mv -f "$evidence_tmp" ${quoteForPosixShellArg(evidenceFile)} || { rm -f "$evidence_tmp"; exit 1; }`,
    "fi",
    "exit \"$status\"",
    "",
  ].join("\n");
}

async function writeIsolatedWrappers({
  profile,
  layout,
  capabilities,
  leaseId,
  remoteNode,
  spawn,
  runtime,
}) {
  const specs = [
    ["claude", layout.claudeWrapperFile, "CLAUDE_CONFIG_DIR", layout.claudeConfigDir, layout.claudeWrapperEvidenceFile],
    ["codex", layout.codexWrapperFile, "CODEX_HOME", layout.codexHome, layout.codexWrapperEvidenceFile],
    ["copilot", layout.copilotWrapperFile, "COPILOT_HOME", layout.copilotHome, layout.copilotWrapperEvidenceFile],
  ];
  const files = {};
  for (const [name, wrapperPath, envName, envValue, evidenceFile] of specs) {
    const capability = capabilities[name];
    if (!capability || !capability.present) continue;
    files[wrapperPath] = buildIsolatedWrapper(
      layout,
      capability.executablePath,
      envName,
      envValue,
      evidenceFile,
    );
    capability.wrapperPath = wrapperPath;
  }
  const writer = [
    "const fs=require('fs'),p=require('path');",
    "const files=JSON.parse(fs.readFileSync(0,'utf8'));",
    "for(const [target,body] of Object.entries(files)){",
    " const tmp=target+'.tmp';fs.mkdirSync(p.dirname(target),{recursive:true,mode:0o700});",
    " fs.writeFileSync(tmp,body,{mode:0o700});fs.chmodSync(tmp,0o700);fs.renameSync(tmp,target);",
    " if(fs.readFileSync(target,'utf8')!==body||(fs.statSync(target).mode&0o777)!==0o700)process.exit(1);",
    "}",
  ].join("");
  const command = fencedCommand(
    layout,
    leaseId,
    remoteNode,
    buildRemoteNodeEvalCommand(remoteNode, writer),
  );
  const result = await spawnAndWait(
    spawn,
    "ssh",
    buildSshArgs(profile).concat([command]),
    { stdin: compactJson(files), runtime, role: "isolated-wrapper-write", mutation: true },
  );
  return { ok: result.code === 0, stderr: result.stderr, files };
}

async function verifyIsolatedArtifacts({
  profile,
  layout,
  capabilities,
  leaseId,
  remoteNode,
  spawn,
  runtime,
}) {
  const script = [
    "const fs=require('fs'),p=require('path');",
    `const roots=${JSON.stringify({
      claude: {
        root: layout.claudeConfigDir,
        evidence: layout.claudeWrapperEvidenceFile,
        expectedEvidence: capabilities.claude && capabilities.claude.present
          ? buildWrapperEvidence(
              capabilities.claude.executablePath,
              "CLAUDE_CONFIG_DIR",
              layout.claudeConfigDir,
            )
          : null,
      },
      codex: {
        root: layout.codexHome,
        evidence: layout.codexWrapperEvidenceFile,
        expectedEvidence: capabilities.codex && capabilities.codex.present
          ? buildWrapperEvidence(
              capabilities.codex.executablePath,
              "CODEX_HOME",
              layout.codexHome,
            )
          : null,
      },
      copilot: {
        root: layout.copilotHome,
        evidence: layout.copilotWrapperEvidenceFile,
        expectedEvidence: capabilities.copilot && capabilities.copilot.present
          ? buildWrapperEvidence(
              capabilities.copilot.executablePath,
              "COPILOT_HOME",
              layout.copilotHome,
            )
          : null,
      },
    })};`,
    "const exists=x=>{try{return fs.existsSync(x)}catch{return false}};",
    "const anySession=root=>{const todo=[p.join(root,'sessions')];while(todo.length){const d=todo.pop();let entries;try{entries=fs.readdirSync(d,{withFileTypes:true})}catch{continue}for(const e of entries){if(e.isFile())return true;if(e.isDirectory())todo.push(p.join(d,e.name))}}return false};",
    "const evidenceMatches=x=>{try{return typeof x.expectedEvidence==='string'&&fs.readFileSync(x.evidence,'utf8')===x.expectedEvidence}catch{return false}};",
    "const out={",
    " claude:{artifact:exists(p.join(roots.claude.root,'.claude.json'))||exists(p.join(roots.claude.root,'history.jsonl'))||exists(p.join(roots.claude.root,'projects')),wrapper:evidenceMatches(roots.claude)},",
    " codex:{artifact:exists(p.join(roots.codex.root,'auth.json'))||anySession(roots.codex.root),wrapper:evidenceMatches(roots.codex)},",
    " copilot:{artifact:exists(p.join(roots.copilot.root,'config.json'))||exists(p.join(roots.copilot.root,'session-state'))||exists(p.join(roots.copilot.root,'permissions.json')),wrapper:evidenceMatches(roots.copilot)}",
    "};console.log(JSON.stringify(out));",
  ].join("");
  const result = await spawnAndWait(
    spawn,
    "ssh",
    buildSshArgs(profile).concat([
      fencedCommand(layout, leaseId, remoteNode, buildRemoteNodeEvalCommand(remoteNode, script)),
    ]),
    { runtime },
  );
  let artifactMap = {};
  try { artifactMap = JSON.parse(String(result.stdout || "").trim().split(/\r?\n/).at(-1)); } catch {}
  for (const name of ["claude", "codex", "copilot"]) {
    if (capabilities[name]) {
      capabilities[name].artifactVerified = artifactMap[name] && artifactMap[name].artifact === true;
      capabilities[name].wrapperInvoked = artifactMap[name] && artifactMap[name].wrapper === true;
    }
  }
  const applicable = Object.values(capabilities).filter((entry) => entry.present);
  return {
    ok: result.code === 0,
    active: applicable.length > 0
      && applicable.every((entry) => (
        entry.versionVerified
        && entry.artifactVerified
        && entry.wrapperInvoked
        && entry.wrapperPath
      )),
    capabilities,
  };
}

async function secureDeploy({
  profile,
  installId,
  identityTxn,
  legacyMigrationConfirmed = false,
  runtime,
  deps = {},
}) {
  if (!profile || !profile.id) throw new Error("deploy: profile.id required");
  if (!runtime || typeof runtime.emit !== "function") throw new Error("deploy: runtime emitter required");
  if (!INSTALL_ID_RE.test(installId || "")) throw new Error("deploy: valid installId required");
  if (!identityTxn || !/^[a-f0-9]{32}$/.test(identityTxn.toNonce || "")) {
    throw new Error("deploy: active identity transaction required");
  }
  const spawn = deps.spawn || childProcess.spawn;
  const hooksDir = deps.hooksDir || resolveHooksDir({ isPackaged: deps.isPackaged });
  const detectShellFn = deps.detectRemoteShell || detectRemoteShell;
  const randomBytes = deps.randomBytes || crypto.randomBytes;
  const onStep = typeof deps.onIdentityStep === "function"
    ? deps.onIdentityStep
    : async () => {};
  const leaseId = randomBytes(16).toString("hex");
  if (!LEASE_ID_RE.test(leaseId)) throw new Error("deploy: invalid lease id source");
  let layout = null;
  let remoteNode = null;
  let lockHeld = false;

  function progress(step, status, message, hint) {
    runtime.emit("progress", {
      profileId: profile.id,
      step,
      status,
      message: message ? redactTransportDiagnostic(message, profile) : null,
      hint: hint || null,
    });
  }
  async function recordStep(name, status, evidence) {
    await onStep(name, { status, ...(evidence ? { evidence } : {}) });
  }
  async function fail(step, message, reason = null, identityStep = null) {
    const safeMessage = redactTransportDiagnostic(message, profile);
    progress(step, "fail", safeMessage);
    if (identityStep) {
      try { await recordStep(identityStep, "failed", String(safeMessage || "failed").slice(0, 500)); } catch {}
    }
    return { ok: false, step, message: safeMessage, reason };
  }

  const missing = HOOK_FILES
    .map((name) => path.join(hooksDir, name))
    .filter((file) => !fs.existsSync(file));
  if (missing.length) return fail("verify", `Missing files: ${missing.join(", ")}`);
  progress("verify", "ok");

  progress("remote-shell", "start");
  const shell = await detectShellFn({ profile, spawn, buildSshArgs, runtime });
  if (shell && shell.shell === "windows-cmd") {
    return fail(
      "remote-shell",
      "Remote default shell is Windows cmd.exe. Remote SSH needs a POSIX shell.",
      "windows_cmd_shell",
    );
  }
  progress("remote-shell", "ok", shell && shell.os);

  progress("layout", "start");
  const homeResult = await resolveRemoteHome({ profile, spawn, runtime });
  if (!homeResult.ok) return fail("layout", homeResult.message, "remote_home_invalid");
  layout = homeResult.layout;
  if (layout.runtimeKey !== identityTxn.runtimeKey
    || layout.layoutVersion !== identityTxn.layoutVersion) {
    return fail("layout", "Identity transaction belongs to another remote runtime layout", "layout_drift");
  }
  progress("layout", "ok", layout.runtimeKey);

  progress("check-node", "start");
  const resolved = await resolveRemoteNodeBin({
    profile,
    spawn,
    buildSshArgs,
    runtime,
    verifyCache: true,
  });
  if (!resolved.ok) return fail("check-node", resolved.message || "Remote Node.js not found");
  remoteNode = resolved.nodeBin;
  const remoteNodeInfo = {
    nodeBin: resolved.nodeBin,
    version: resolved.version || null,
    source: resolved.source || null,
  };
  progress("check-node", "ok", resolved.version || null);

  progress("lock", "start");
  const lock = await acquireDeployLock({
    profile,
    layout,
    installId,
    leaseId,
    spawn,
    runtime,
    now: deps.now,
  });
  if (!lock.ok) return fail("lock", lock.message, lock.reason);
  lockHeld = true;
  progress("lock", "ok");

  let operationResult = null;
  let primaryError = null;
  try {
    operationResult = await (async () => {
    progress("preflight", "start");
    const preflight = await runOwnershipPreflight({
      profile,
      layout,
      installId,
      remoteNode,
      spawn,
      runtime,
    });
    if (!preflight.ok) return fail("preflight", preflight.message, preflight.reason);
    const componentPresence = preflight.detail;
    if (componentPresence.identity !== true
      && (componentPresence.legacyTraces > 0
        || componentPresence.legacyConfigTraces > 0)
      && legacyMigrationConfirmed !== true) {
      return fail(
        "preflight",
        "This remote runtime contains a legacy Clawd deployment with no verifiable owner. Confirm migration before changing it.",
        "legacy_deployment_confirmation_required",
      );
    }
    progress("preflight", "ok");

    if (layout.runtimeMode === "account-default" && componentPresence.legacyMonitorPresent === true) {
      progress("legacy-monitor", "start");
      const legacyMonitor = await cleanupLegacyMonitor({
        profile,
        layout,
        leaseId,
        remoteNode,
        spawn,
        runtime,
      });
      if (!legacyMonitor.ok) {
        return fail(
          "legacy-monitor",
          legacyMonitor.stderr || "The verified legacy Codex monitor could not be stopped",
          "legacy_monitor_cleanup_failed",
        );
      }
      progress("legacy-monitor", "ok", legacyMonitor.status);
    }

    let isolatedCapabilities = null;
    if (layout.runtimeMode === "profile-isolated") {
      const cliProbe = await probeRemoteCliCapabilities({
        profile,
        layout,
        remoteNode,
        spawn,
        runtime,
        minimums: deps.isolatedCliMinimums || ISOLATED_CLI_MINIMUMS,
      });
      if (!cliProbe.ok) return fail("cli-probe", cliProbe.stderr || "Remote CLI capability probe failed", cliProbe.reason);
      isolatedCapabilities = cliProbe.capabilities;
      componentPresence.claudePresent = isolatedCapabilities.claude.present;
      componentPresence.codexPresent = isolatedCapabilities.codex.present;
      componentPresence.copilotPresent = isolatedCapabilities.copilot.present;
    }

    const mkdirs = [
      layout.claudeHooksDir,
      layout.codexHome,
      layout.copilotHome,
      layout.clawdStateDir,
      ...(layout.binDir ? [layout.binDir] : []),
      ...(layout.wrapperEvidenceDir ? [layout.wrapperEvidenceDir] : []),
      path.posix.join(layout.deployStagingDir, leaseId),
    ];
    const mkdirCommand = fencedCommand(
      layout,
      leaseId,
      remoteNode,
      `umask 077 && mkdir -p ${mkdirs.map(quoteForPosixShellArg).join(" ")} && chmod 700 ${mkdirs.map(quoteForPosixShellArg).join(" ")}`,
    );
    const mkdirResult = await spawnAndWait(
      spawn,
      "ssh",
      buildSshArgs(profile).concat([mkdirCommand]),
      { runtime, role: "layout-create", mutation: true },
    );
    if (mkdirResult.code !== 0) return fail("mkdir", mkdirResult.stderr || "Remote layout creation failed");

    const targetProfile = { ...profile, routingNonce: identityTxn.toNonce };
    const identityDocument = buildRemoteIdentityDocument({
      profile: targetProfile,
      installId,
      deployedAt: identityTxn.startedAt,
    });
    progress("identity", "start");
    const identityTmp = `${layout.identityFile}.tmp-${leaseId}`;
    const identityCommand = fencedCommand(
      layout,
      leaseId,
      remoteNode,
      `umask 077 && cat > ${quoteForPosixShellArg(identityTmp)} && chmod 600 ${quoteForPosixShellArg(identityTmp)} && mv -f ${quoteForPosixShellArg(identityTmp)} ${quoteForPosixShellArg(layout.identityFile)}`,
    );
    const identityWrite = await spawnAndWait(
      spawn,
      "ssh",
      buildSshArgs(profile).concat([identityCommand]),
      { stdin: compactJson(identityDocument), runtime, role: "identity-write", mutation: true },
    );
    if (identityWrite.code !== 0) {
      return fail("identity", identityWrite.stderr || "Identity write failed", null, "identity");
    }
    const identityVerifyScript = [
      "const fs=require('fs');",
      `const a=JSON.parse(fs.readFileSync(${JSON.stringify(layout.identityFile)},'utf8'));`,
      "const b=JSON.parse(fs.readFileSync(0,'utf8'));",
      "for(const k of Object.keys(b))if(a[k]!==b[k])process.exit(1);",
    ].join("");
    const identityVerify = await spawnAndWait(
      spawn,
      "ssh",
      buildSshArgs(profile).concat([
        fencedCommand(layout, leaseId, remoteNode, buildRemoteNodeEvalCommand(remoteNode, identityVerifyScript)),
      ]),
      { stdin: compactJson(identityDocument), runtime },
    );
    if (identityVerify.code !== 0) return fail("identity", "Identity read-back verification failed", null, "identity");
    await recordStep("identity", "done", "identity read-back matched transaction");
    progress("identity", "ok");

    progress("secure-marker", "start");
    const markerTmp = `${layout.secureMarkerFile}.tmp-${leaseId}`;
    const markerCommand = fencedCommand(
      layout,
      leaseId,
      remoteNode,
      `umask 077 && cat > ${quoteForPosixShellArg(markerTmp)} && chmod 600 ${quoteForPosixShellArg(markerTmp)} && mv -f ${quoteForPosixShellArg(markerTmp)} ${quoteForPosixShellArg(layout.secureMarkerFile)} && test "$(cat ${quoteForPosixShellArg(layout.secureMarkerFile)})" = "clawd-ssh-secure-v1"`,
    );
    const markerWrite = await spawnAndWait(
      spawn,
      "ssh",
      buildSshArgs(profile).concat([markerCommand]),
      { stdin: "clawd-ssh-secure-v1", runtime, role: "secure-marker-write", mutation: true },
    );
    if (markerWrite.code !== 0) return fail("secure-marker", markerWrite.stderr || "Secure marker write failed", null, "secureMarker");
    await recordStep("secureMarker", "done", "marker atomically written and read back");
    progress("secure-marker", "ok");

    progress("hook-files", "start");
    const stagingDir = path.posix.join(layout.deployStagingDir, leaseId);
    const localFiles = HOOK_FILES.map((name) => path.join(hooksDir, name));
    const remoteTarget = buildScpRemoteTarget(profile.host, stagingDir);
    const scp = await spawnAndWait(
      spawn,
      "scp",
      buildScpArgs(profile).concat([...localFiles, remoteTarget]),
      { timeoutMs: 120000, runtime, role: "hook-files-upload", mutation: true },
    );
    if (scp.code !== 0) return fail("hook-files", scp.stderr || "Hook staging upload failed", null, "hookFiles");
    const promotion = HOOK_FILES
      .map((name) => `mv -f ${quoteForPosixShellArg(path.posix.join(stagingDir, name))} ${quoteForPosixShellArg(path.posix.join(layout.claudeHooksDir, name))}`)
      .join(" && ");
    const promote = await spawnAndWait(
      spawn,
      "ssh",
      buildSshArgs(profile).concat([
        fencedCommand(layout, leaseId, remoteNode, `${promotion} && rmdir ${quoteForPosixShellArg(stagingDir)}`),
      ]),
      { runtime, role: "hook-files-promote", mutation: true },
    );
    if (promote.code !== 0) return fail("hook-files", promote.stderr || "Hook promotion lost its deployment lease", null, "hookFiles");
    const expectedHashes = Object.fromEntries(HOOK_FILES.map((name) => [
      name,
      crypto.createHash("sha256").update(fs.readFileSync(path.join(hooksDir, name))).digest("hex"),
    ]));
    const hashScript = [
      "const fs=require('fs'),c=require('crypto'),p=require('path');",
      `const d=${JSON.stringify(layout.claudeHooksDir)},e=${JSON.stringify(expectedHashes)};`,
      "for(const [n,h] of Object.entries(e)){const a=c.createHash('sha256').update(fs.readFileSync(p.join(d,n))).digest('hex');if(a!==h)process.exit(1)}",
    ].join("");
    const hashVerify = await spawnAndWait(
      spawn,
      "ssh",
      buildSshArgs(profile).concat([
        fencedCommand(layout, leaseId, remoteNode, buildRemoteNodeEvalCommand(remoteNode, hashScript)),
      ]),
      { runtime },
    );
    if (hashVerify.code !== 0) return fail("hook-files", "Remote hook manifest hash verification failed", null, "hookFiles");
    await recordStep("hookFiles", "done", `sha256 verified ${HOOK_FILES.length} files`);
    progress("hook-files", "ok");

    if (isolatedCapabilities) {
      progress("isolated-wrappers", "start");
      const wrappers = await writeIsolatedWrappers({
        profile,
        layout,
        capabilities: isolatedCapabilities,
        leaseId,
        remoteNode,
        spawn,
        runtime,
      });
      if (!wrappers.ok) return fail("isolated-wrappers", wrappers.stderr || "Isolated wrapper generation failed");
      progress("isolated-wrappers", "ok");
    }

    if (profile.hostPrefix) {
      const hpTmp = `${layout.hostPrefixFile}.tmp-${leaseId}`;
      const hpCommand = fencedCommand(
        layout,
        leaseId,
        remoteNode,
        `umask 077 && cat > ${quoteForPosixShellArg(hpTmp)} && chmod 600 ${quoteForPosixShellArg(hpTmp)} && mv -f ${quoteForPosixShellArg(hpTmp)} ${quoteForPosixShellArg(layout.hostPrefixFile)}`,
      );
      const hp = await spawnAndWait(
        spawn,
        "ssh",
        buildSshArgs(profile).concat([hpCommand]),
        { stdin: profile.hostPrefix, runtime, role: "host-prefix-write", mutation: true },
      );
      if (hp.code !== 0) return fail("host-prefix", hp.stderr || "Host prefix write failed");
    }

    const envPrefix = buildRemoteInstallerEnv(layout, profile.remotePermissionTransport);
    const installers = [
      ["installClaude", "install-claude", "install.js", profile.chainStatusline ? ["--remote", "--chain-existing"] : ["--remote"], componentPresence.claudePresent],
      ["installCodex", "install-codex", "codex-install.js", ["--remote"], componentPresence.codexPresent],
      ["installCopilot", "install-copilot", "copilot-install.js", ["--remote"], componentPresence.copilotPresent],
    ];
    for (const [txnStep, progressStep, script, argv, present] of installers) {
      progress(progressStep, "start");
      if (!present) {
        await recordStep(txnStep, "not-applicable", `${script} target root absent before deploy`);
        progress(progressStep, "ok", "not applicable");
        continue;
      }
      const nodeCommand = buildRemoteHookNodeCommand(remoteNode, script, argv, {
        hooksDir: layout.claudeHooksDir,
      });
      const verifyCommand = buildInstallerVerificationCommand(txnStep, layout, remoteNode);
      const result = await spawnAndWait(
        spawn,
        "ssh",
        buildSshArgs(profile).concat([
          fencedCommand(
            layout,
            leaseId,
            remoteNode,
            `${envPrefix} ${nodeCommand} && ${verifyCommand}`,
          ),
        ]),
        { timeoutMs: 60000, runtime, role: `installer-${txnStep}`, mutation: true },
      );
      if (result.code !== 0) {
        return fail(progressStep, summarizeStderr(result.stderr) || "Remote installer failed", null, txnStep);
      }
      await recordStep(
        txnStep,
        "done",
        `${script} settings readback verified secure managed command shape`,
      );
      progress(progressStep, "ok");
    }

    if (!componentPresence.claudePresent) {
      await recordStep(
        "claudePermission",
        "not-applicable",
        "Claude config root absent before deploy; native approval remains",
      );
    } else {
      const permissionVerifyScript = [
      "const fs=require('fs');",
      `const s=JSON.parse(fs.readFileSync(${JSON.stringify(layout.claudeSettingsFile)},'utf8'));`,
      `const i=JSON.parse(fs.readFileSync(${JSON.stringify(layout.identityFile)},'utf8'));`,
      "const a=Array.isArray(s&&s.hooks&&s.hooks.PermissionRequest)?s.hooks.PermissionRequest:[];",
      "const flat=[];for(const e of a){if(e&&Array.isArray(e.hooks))flat.push(...e.hooks);else flat.push(e)}",
      "const ours=flat.find(h=>h&&typeof h.url==='string'&&h.url.includes('127.0.0.1:'));",
      "if(ours){const u=new URL(ours.url);const n=u.pathname==='/permission'?u.searchParams.get('nonce'):u.pathname.split('/').pop();if(n!==i.routingNonce)process.exit(1);console.log('managed')}else console.log('native')",
    ].join("");
      const permissionVerify = await spawnAndWait(
      spawn,
      "ssh",
      buildSshArgs(profile).concat([
        fencedCommand(layout, leaseId, remoteNode, buildRemoteNodeEvalCommand(remoteNode, permissionVerifyScript)),
      ]),
      { runtime },
    );
      if (permissionVerify.code !== 0) return fail("claude-permission", "Claude PermissionRequest shape verification failed", null, "claudePermission");
      const permissionMode = String(permissionVerify.stdout || "").trim().endsWith("native") ? "native" : "managed";
      await recordStep(
        "claudePermission",
        permissionMode === "native" ? "not-applicable" : "done",
        permissionMode === "native"
          ? "no managed PermissionRequest; Claude native approval retained"
          : "managed PermissionRequest URL contains transaction nonce",
      );
    }

    if (profile.autoStartCodexMonitor !== true || !componentPresence.codexPresent) {
      await recordStep(
        "codexMonitor",
        "not-applicable",
        profile.autoStartCodexMonitor !== true
          ? "profile monitor option disabled"
          : "Codex root absent before deploy",
      );
    } else {
      const monitorCommand = [
        secureMonitorStopCommand(layout),
        `nohup env ${envPrefix} ${buildRemoteHookNodeCommand(remoteNode, "codex-remote-monitor.js", [], { hooksDir: layout.claudeHooksDir })} >/dev/null 2>&1 &`,
        `printf '%s\\n' "$!" > ${quoteForPosixShellArg(layout.monitorPidFile)}`,
        buildMonitorVerificationCommand(layout, remoteNode),
      ].join("\n");
      const monitor = await spawnAndWait(
        spawn,
        "ssh",
        buildSshArgs(profile).concat([
          fencedCommand(layout, leaseId, remoteNode, monitorCommand),
        ]),
        { runtime, role: "codex-monitor-restart", mutation: true },
      );
      if (monitor.code !== 0) return fail("codex-monitor", monitor.stderr || "Codex monitor verification failed", null, "codexMonitor");
      await recordStep(
        "codexMonitor",
        "done",
        "fresh layout-scoped monitor pid, liveness, and command path verified",
      );
    }

    let isolation = null;
    if (isolatedCapabilities) {
      const verified = await verifyIsolatedArtifacts({
        profile,
        layout,
        capabilities: isolatedCapabilities,
        leaseId,
        remoteNode,
        spawn,
        runtime,
      });
      if (!verified.ok) return fail("isolated-artifacts", "Isolated CLI artifact verification failed");
      isolation = {
        active: verified.active,
        runtimeRoot: layout.runtimeRoot,
        binDir: layout.binDir,
        capabilities: verified.capabilities,
      };
      progress(
        "isolated-artifacts",
        "ok",
        verified.active
          ? "Isolated CLI artifacts verified"
          : "Wrappers are prepared; run each applicable CLI through its wrapper, then Repair to verify activation",
      );
    }

    return {
      ok: true,
      secure: true,
      leaseId,
      layout,
      remoteNode: remoteNodeInfo,
      transactionReady: true,
      isolation,
    };
    })();
  } catch (err) {
    primaryError = err;
  }

  let releaseError = null;
  if (lockHeld && layout && remoteNode && managedTransportIsActive(runtime)) {
    try {
      const released = await releaseDeployLock({
        profile,
        layout,
        leaseId,
        remoteNode,
        spawn,
        runtime,
      });
      if (released.code !== 0) {
        releaseError = Object.assign(new Error("Remote deployment lock release requires manual inspection"), {
          code: "manual_lock_inspection_required",
          recoveryCode: "manual_lock_inspection_required",
        });
        progress("lock-release", "fail", `Lock release requires manual inspection at ${layout.deployLockDir}`);
      } else {
        progress("lock-release", "ok");
      }
    } catch (err) {
      releaseError = err;
      progress("lock-release", "fail", `Lock release requires manual inspection at ${layout.deployLockDir}`);
    }
  }

  if (releaseError) {
    const recoveryCode = releaseError.recoveryCode || "manual_lock_inspection_required";
    if (primaryError) {
      primaryError.recoveryCode = recoveryCode;
      primaryError.recoveryError = "Remote deployment lock release requires manual inspection";
      throw primaryError;
    }
    if (operationResult && operationResult.ok === false) {
      return {
        ...operationResult,
        recoveryCode,
        recoveryError: "Remote deployment lock release requires manual inspection",
      };
    }
    releaseError.recoveryCode = recoveryCode;
    throw releaseError;
  }
  if (primaryError) throw primaryError;
  return operationResult;
}

async function deploy(options) {
  if (!options || !INSTALL_ID_RE.test(options.installId || "") || !options.identityTxn) {
    return {
      ok: false,
      skipped: true,
      step: "identity",
      reason: "secure_identity_required",
      stderr: "A trusted installation binding and active identity transaction are required; no remote mutation was attempted.",
    };
  }
  return secureDeploy(options);
}

async function bootstrapIsolatedRuntime({
  profile,
  installId,
  runtimeKey,
  runtime = null,
  deps = {},
}) {
  if (!profile || !profile.id || !INSTALL_ID_RE.test(installId || "")) {
    return { ok: false, skipped: true, reason: "secure_identity_required" };
  }
  try {
    normalizeRemoteRuntimeIdentity({
      runtimeMode: "profile-isolated",
      runtimeKey,
    });
  } catch (err) {
    return { ok: false, reason: "layout_invalid", stderr: err && err.message };
  }
  const spawn = deps.spawn || childProcess.spawn;
  const accountProfile = {
    ...profile,
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    layoutVersion: 1,
  };
  const homeResult = await resolveRemoteHome({ profile: accountProfile, spawn, runtime });
  if (!homeResult.ok) return { ok: false, reason: "remote_home_invalid", stderr: homeResult.message };
  const accountLayout = homeResult.layout;
  let isolatedLayout;
  try {
    isolatedLayout = resolveRemoteRuntimeLayout({
      runtimeMode: "profile-isolated",
      runtimeKey,
      remoteHome: accountLayout.remoteHome,
    });
  } catch (err) {
    return { ok: false, reason: "layout_invalid", stderr: err && err.message };
  }
  const resolved = await resolveRemoteNodeBin({
    profile: accountProfile,
    spawn,
    buildSshArgs,
    runtime,
    verifyCache: true,
  });
  if (!resolved.ok) return { ok: false, reason: "node_unavailable", stderr: resolved.message };
  const remoteNode = resolved.nodeBin;
  const leaseId = (deps.randomBytes || crypto.randomBytes)(16).toString("hex");
  const lock = await acquireDeployLock({
    profile: accountProfile,
    layout: accountLayout,
    installId,
    leaseId,
    spawn,
    runtime,
    now: deps.now,
  });
  if (!lock.ok) return { ok: false, skipped: true, reason: lock.reason, stderr: lock.message };
  try {
    const dirs = [
      isolatedLayout.runtimeRoot,
      isolatedLayout.claudeConfigDir,
      isolatedLayout.codexHome,
      isolatedLayout.copilotHome,
      isolatedLayout.clawdStateDir,
      isolatedLayout.binDir,
      isolatedLayout.wrapperEvidenceDir,
    ];
    const bootstrapOwner = {
      version: 1,
      installId,
      profileId: profile.id,
      runtimeKey,
      layoutVersion: isolatedLayout.layoutVersion,
    };
    const bootstrapScript = [
      "const fs=require('fs'),p=require('path');",
      `const root=${JSON.stringify(isolatedLayout.runtimeRoot)};`,
      `const dirs=${JSON.stringify(dirs)};`,
      `const ownerPath=${JSON.stringify(isolatedLayout.bootstrapOwnerFile)};`,
      `const expected=${JSON.stringify(bootstrapOwner)};`,
      `const tmp=ownerPath+${JSON.stringify(`.tmp-${leaseId}`)};`,
      "function same(a,b){return a&&Object.keys(b).every(k=>a[k]===b[k])}",
      "if(fs.existsSync(root)){let current;try{current=JSON.parse(fs.readFileSync(ownerPath,'utf8'))}catch{process.exit(88)}if(!same(current,expected))process.exit(88)}",
      "else{for(const d of dirs)fs.mkdirSync(d,{recursive:true,mode:0o700});fs.writeFileSync(tmp,JSON.stringify(expected)+'\\n',{mode:0o600});fs.chmodSync(tmp,0o600);fs.renameSync(tmp,ownerPath)}",
      "for(const d of dirs)fs.chmodSync(d,0o700);",
      "fs.chmodSync(ownerPath,0o600);",
      "const actual=JSON.parse(fs.readFileSync(ownerPath,'utf8'));if(!same(actual,expected))process.exit(89);",
    ].join("");
    const command = buildRemoteNodeEvalCommand(remoteNode, bootstrapScript);
    const created = await spawnAndWait(
      spawn,
      "ssh",
      buildSshArgs(accountProfile).concat([
        fencedCommand(accountLayout, leaseId, remoteNode, command),
      ]),
      { runtime, role: "isolated-runtime-bootstrap", mutation: true },
    );
    if (created.code !== 0) {
      return {
        ok: false,
        reason: created.code === 88 ? "isolated_root_exists" : "isolated_root_create_failed",
        stderr: created.stderr || (
          created.code === 88
            ? "The isolated runtime root exists without matching bootstrap ownership; no ownership was assumed."
            : "Could not create isolated runtime root"
        ),
      };
    }
    return {
      ok: true,
      layout: isolatedLayout,
      remoteNode: {
        nodeBin: resolved.nodeBin,
        version: resolved.version || null,
        source: resolved.source || null,
      },
    };
  } finally {
    if (managedTransportIsActive(runtime)) {
      await releaseDeployLock({
        profile: accountProfile,
        layout: accountLayout,
        leaseId,
        remoteNode,
        spawn,
        runtime,
      });
    }
  }
}

// ── Codex remote monitor PID management ──
//
// `~/.clawd-codex-monitor.pid` on the remote is a fixed marker holding the
// last-launched monitor PID. `startCodexMonitor` first kills any prior
// monitor (avoiding orphan accumulation per v7) then launches a fresh one
// and writes the new PID. `stopCodexMonitor` kills the PID and rms the file.

async function legacyStartCodexMonitor({ profile, runtime = null, deps = {} }) {
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

async function legacyStopCodexMonitor({ profile, runtime = null, deps = {} }) {
  const spawn = deps.spawn || childProcess.spawn;
  const cmd =
    "[ -f ~/.clawd-codex-monitor.pid ] && kill $(cat ~/.clawd-codex-monitor.pid) 2>/dev/null; " +
    "rm -f ~/.clawd-codex-monitor.pid";
  const args = buildSshArgs(profile).concat([cmd]);
  const r = await spawnAndWait(spawn, "ssh", args, { runtime });
  // best-effort — don't surface failures. Caller decides whether to log.
  return { ok: true, stderr: r.stderr };
}

// Full remote cleanup for profile deletion: unregister the Claude hooks and
// statusline (restoring a chained third-party statusline from its sidecar)
// plus the Codex hooks, so nothing on the remote keeps firing into a dead
// forward port after the profile is gone. Deliberately NOT run on mere
// disconnect: installed hooks are harmless while the tunnel is down (their
// POSTs die on an instant local connection refusal) and removing them would
// force a full redeploy on every reconnect. Best-effort by design — the
// host may already be unreachable at delete time.
async function legacyUninstallRemoteIntegrations({ profile, runtime = null, deps = {} }) {
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
  const claudeUninstall = buildRemoteHookNodeCommand(remoteNode, "uninstall.js", []);
  // Profiles deployed before uninstall.js joined the manifest still have
  // install.js. Fall back to its exported unregister functions so an app
  // upgrade can clean those remotes instead of silently stranding hooks.
  const legacyClaudeUninstall = buildRemoteNodeEvalCommand(remoteNode,
    'const i=require(process.env.HOME+"/.claude/hooks/install.js");'
    + 'i.unregisterHooks();'
    + 'if(typeof i.unregisterClaudeStatusline==="function")i.unregisterClaudeStatusline();');
  const claudeCleanupStep = `if [ -f "$HOME/.claude/hooks/uninstall.js" ]; then ${claudeUninstall}; else ${legacyClaudeUninstall}; fi`;
  const steps = [
    claudeCleanupStep,
    buildRemoteHookNodeCommand(remoteNode, "codex-install.js", ["--uninstall"]),
  ];
  let lastStderr = null;
  let ok = true;
  for (const cmd of steps) {
    const args = buildSshArgs(profile).concat([cmd]);
    const r = await spawnAndWait(spawn, "ssh", args, { timeoutMs: 30000, runtime });
    if (r.code !== 0) {
      ok = false;
      lastStderr = r.stderr;
    }
  }
  return { ok, stderr: lastStderr };
}

function hasSecureRemoteOwnership(profile) {
  return !!profile
    && INSTALL_ID_RE.test(profile.installId || "")
    && typeof profile.remoteHome === "string"
    && profile.remoteHome.startsWith("/")
    && typeof profile.runtimeKey === "string"
    && Number.isInteger(profile.layoutVersion);
}

async function withOwnedRemoteLease({ profile, runtime, deps = {}, operation }) {
  if (!hasSecureRemoteOwnership(profile)) {
    return {
      ok: false,
      skipped: true,
      reason: "ownership_unverified",
      stderr: "Remote ownership metadata is incomplete; no remote mutation was attempted.",
    };
  }
  const spawn = deps.spawn || childProcess.spawn;
  let layout;
  try {
    layout = resolveRemoteRuntimeLayout({
      runtimeMode: profile.runtimeMode,
      runtimeKey: profile.runtimeKey,
      remoteHome: profile.remoteHome,
    });
  } catch (err) {
    return { ok: false, skipped: true, reason: "layout_invalid", stderr: err && err.message };
  }
  let remoteNode = deps.nodeBin;
  if (!remoteNode) {
    const resolved = await resolveRemoteNodeBin({
      profile,
      spawn,
      buildSshArgs,
      runtime,
      verifyCache: true,
    });
    if (!resolved.ok) return { ok: false, reason: "node_unavailable", stderr: resolved.message };
    remoteNode = resolved.nodeBin;
  }
  const leaseId = (deps.randomBytes || crypto.randomBytes)(16).toString("hex");
  const lock = await acquireDeployLock({
    profile,
    layout,
    installId: profile.installId,
    leaseId,
    spawn,
    runtime,
    now: deps.now,
  });
  if (!lock.ok) {
    return { ok: false, skipped: true, reason: lock.reason, stderr: lock.message };
  }
  let operationResult = null;
  let primaryError = null;
  try {
    const ownership = await runOwnershipPreflight({
      profile,
      layout,
      installId: profile.installId,
      remoteNode,
      spawn,
      runtime,
    });
    if (!ownership.ok || !ownership.detail || ownership.detail.identity !== true) {
      operationResult = {
        ok: false,
        skipped: true,
        reason: ownership.ok
          ? "ownership_identity_missing"
          : (ownership.reason || "ownership_conflict"),
        stderr: ownership.ok
          ? "Remote identity is missing; no cleanup or monitor mutation was attempted."
          : ownership.message,
      };
    } else {
      operationResult = await operation({ spawn, layout, remoteNode, leaseId });
    }
  } catch (err) {
    primaryError = err;
  }

  let releaseError = null;
  if (managedTransportIsActive(runtime)) {
    try {
      const released = await releaseDeployLock({
        profile,
        layout,
        leaseId,
        remoteNode,
        spawn,
        runtime,
      });
      if (released.code !== 0) {
        releaseError = Object.assign(new Error("Remote deployment lock release requires manual inspection"), {
          code: "manual_lock_inspection_required",
          recoveryCode: "manual_lock_inspection_required",
        });
      }
    } catch (err) {
      releaseError = err;
    }
  }

  if (releaseError) {
    const recoveryCode = releaseError.recoveryCode || "manual_lock_inspection_required";
    if (primaryError) {
      primaryError.recoveryCode = recoveryCode;
      primaryError.recoveryError = "Remote deployment lock release requires manual inspection";
      throw primaryError;
    }
    if (operationResult && operationResult.ok === false) {
      return {
        ...operationResult,
        recoveryCode,
        recoveryError: "Remote deployment lock release requires manual inspection",
      };
    }
    releaseError.recoveryCode = recoveryCode;
    throw releaseError;
  }
  if (primaryError) throw primaryError;
  return operationResult;
}

function secureMonitorStopCommand(layout) {
  const pidFile = quoteForPosixShellArg(layout.monitorPidFile);
  const marker = quoteForPosixShellArg(path.posix.join(layout.claudeHooksDir, "codex-remote-monitor.js"));
  return [
    `pidfile=${pidFile}`,
    "if [ -f \"$pidfile\" ]; then",
    "  pid=\"$(cat \"$pidfile\" 2>/dev/null || true)\"",
    "  case \"$pid\" in ''|*[!0-9]*) ;; *)",
    `    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"; case "$cmd" in *${marker}*) kill "$pid" 2>/dev/null || true ;; esac`,
    "  ;; esac",
    "fi",
    "rm -f \"$pidfile\"",
  ].join("\n");
}

async function secureStartCodexMonitor({ profile, runtime = null, deps = {} }) {
  return withOwnedRemoteLease({
    profile,
    runtime,
    deps,
    operation: async ({ spawn, layout, remoteNode, leaseId }) => {
      const envPrefix = buildRemoteInstallerEnv(layout, profile.remotePermissionTransport);
      const stop = secureMonitorStopCommand(layout);
      const start = [
        stop,
        `nohup env ${envPrefix} ${buildRemoteHookNodeCommand(remoteNode, "codex-remote-monitor.js", [], { hooksDir: layout.claudeHooksDir })} >/dev/null 2>&1 &`,
        `printf '%s\\n' "$!" > ${quoteForPosixShellArg(layout.monitorPidFile)}`,
        buildMonitorVerificationCommand(layout, remoteNode),
      ].join("\n");
      const result = await spawnAndWait(
        spawn,
        "ssh",
        buildSshArgs(profile).concat([
          fencedCommand(layout, leaseId, remoteNode, start),
        ]),
        { runtime, role: "codex-monitor-start", mutation: true },
      );
      return { ok: result.code === 0, stderr: result.stderr, layout };
    },
  });
}

async function secureStopCodexMonitor({ profile, runtime = null, deps = {} }) {
  return withOwnedRemoteLease({
    profile,
    runtime,
    deps,
    operation: async ({ spawn, layout, remoteNode, leaseId }) => {
      const result = await spawnAndWait(
        spawn,
        "ssh",
        buildSshArgs(profile).concat([
          fencedCommand(layout, leaseId, remoteNode, secureMonitorStopCommand(layout)),
        ]),
        { runtime, role: "codex-monitor-stop", mutation: true },
      );
      return { ok: result.code === 0, stderr: result.stderr, layout };
    },
  });
}

async function secureUninstallRemoteIntegrations({
  profile,
  runtime = null,
  deps = {},
  preserveIdentity = false,
}) {
  return withOwnedRemoteLease({
    profile,
    runtime,
    deps,
    operation: async ({ spawn, layout, remoteNode, leaseId }) => {
      const envPrefix = buildRemoteInstallerEnv(layout, profile.remotePermissionTransport);
      const optionalInstaller = (script, argv) => {
        const scriptPath = path.posix.join(layout.claudeHooksDir, script);
        return `if [ -f ${quoteForPosixShellArg(scriptPath)} ]; then ${envPrefix} ${buildRemoteHookNodeCommand(remoteNode, script, argv, { hooksDir: layout.claudeHooksDir })}; fi`;
      };
      const commands = [
        secureMonitorStopCommand(layout),
        optionalInstaller("uninstall.js", []),
        optionalInstaller("codex-install.js", ["--uninstall"]),
        optionalInstaller("copilot-install.js", ["--uninstall"]),
        `rm -f ${[
          layout.hostPrefixFile,
          layout.statuslineSidecarFile,
          layout.lastLogFile,
          ...HOOK_FILES.map((name) => path.posix.join(layout.claudeHooksDir, name)),
        ].map(quoteForPosixShellArg).join(" ")}`,
      ];
      if (!preserveIdentity) {
        commands.push(
          `rm -f ${quoteForPosixShellArg(layout.identityFile)}`,
          `rm -f ${quoteForPosixShellArg(layout.secureMarkerFile)}`,
        );
      }
      for (const command of commands) {
        const result = await spawnAndWait(
          spawn,
          "ssh",
          buildSshArgs(profile).concat([
            fencedCommand(layout, leaseId, remoteNode, command),
          ]),
          { timeoutMs: 30000, runtime, role: "remote-cleanup", mutation: true },
        );
        if (result.code !== 0) {
          return { ok: false, stderr: result.stderr, reason: "cleanup_step_failed", layout };
        }
      }
      return { ok: true, layout };
    },
  });
}

async function finalizeRetiredRemoteLayout({
  profile,
  runtime = null,
  deps = {},
}) {
  if (!hasSecureRemoteOwnership(profile)) {
    return {
      ok: false,
      skipped: true,
      reason: "ownership_unverified",
      stderr: "Remote ownership metadata is incomplete; retirement could not be finalized.",
    };
  }
  const spawn = deps.spawn || childProcess.spawn;
  let layout;
  try {
    layout = resolveRemoteRuntimeLayout({
      runtimeMode: profile.runtimeMode,
      runtimeKey: profile.runtimeKey,
      remoteHome: profile.remoteHome,
    });
  } catch (err) {
    return { ok: false, reason: "layout_invalid", stderr: err && err.message };
  }
  let remoteNode = deps.nodeBin;
  if (!remoteNode) {
    const resolved = await resolveRemoteNodeBin({
      profile,
      spawn,
      buildSshArgs,
      runtime,
      verifyCache: true,
    });
    if (!resolved.ok) return { ok: false, reason: "node_unavailable", stderr: resolved.message };
    remoteNode = resolved.nodeBin;
  }
  const leaseId = (deps.randomBytes || crypto.randomBytes)(16).toString("hex");
  const lock = await acquireDeployLock({
    profile,
    layout,
    installId: profile.installId,
    leaseId,
    spawn,
    runtime,
    now: deps.now,
  });
  if (!lock.ok) return { ok: false, skipped: true, reason: lock.reason, stderr: lock.message };
  try {
    const expected = {
      installId: profile.installId,
      profileId: profile.id,
      runtimeKey: layout.runtimeKey,
      layoutVersion: layout.layoutVersion,
    };
    const script = [
      "const fs=require('fs');",
      `const identityPath=${JSON.stringify(layout.identityFile)};`,
      `const markerPath=${JSON.stringify(layout.secureMarkerFile)};`,
      `const expected=${JSON.stringify(expected)};`,
      "let identity=null;try{identity=JSON.parse(fs.readFileSync(identityPath,'utf8'))}catch(e){if(!e||e.code!=='ENOENT')process.exit(82)}",
      "if(!identity){if(fs.existsSync(markerPath))process.exit(86);process.exit(0)}",
      "for(const k of Object.keys(expected))if(identity[k]!==expected[k])process.exit(83);",
      "fs.rmSync(identityPath,{force:true});fs.rmSync(markerPath,{force:true});",
      "if(fs.existsSync(identityPath)||fs.existsSync(markerPath))process.exit(87);",
    ].join("");
    const result = await spawnAndWait(
      spawn,
      "ssh",
      buildSshArgs(profile).concat([
        fencedCommand(layout, leaseId, remoteNode, buildRemoteNodeEvalCommand(remoteNode, script)),
      ]),
      { runtime, role: "runtime-layout-retire", mutation: true },
    );
    if (result.code !== 0) {
      const reason = result.code === 83
        ? "ownership_conflict"
        : (result.code === 86 ? "retirement_marker_without_identity" : "retirement_finalize_failed");
      return {
        ok: false,
        reason,
        stderr: result.stderr || "Retired runtime ownership could not be finalized safely.",
        layout,
      };
    }
    return { ok: true, layout };
  } finally {
    if (managedTransportIsActive(runtime)) {
      await releaseDeployLock({
        profile,
        layout,
        leaseId,
        remoteNode,
        spawn,
        runtime,
      });
    }
  }
}

async function startCodexMonitor(options) {
  return secureStartCodexMonitor(options || {});
}

async function stopCodexMonitor(options) {
  return secureStopCodexMonitor(options || {});
}

async function uninstallRemoteIntegrations(options) {
  return secureUninstallRemoteIntegrations(options || {});
}

// ── Helpers ──

function formatExit(r) {
  if (r.signal) return `signal ${r.signal}`;
  return `code ${r.code == null ? "?" : r.code}`;
}

function summarizeStderr(text) {
  const t = redactTransportDiagnostic(text);
  if (!t) return null;
  return t.length > 200 ? t.slice(0, 200) + "..." : t;
}

module.exports = {
  HOOK_FILES,
  resolveHooksDir,
  deploy,
  startCodexMonitor,
  stopCodexMonitor,
  uninstallRemoteIntegrations,
  finalizeRetiredRemoteLayout,
  bootstrapIsolatedRuntime,
  __test: {
    spawnAndWait,
    legacyDeploy,
    legacyStartCodexMonitor,
    legacyStopCodexMonitor,
    legacyUninstallRemoteIntegrations,
    secureDeploy,
    secureStartCodexMonitor,
    secureStopCodexMonitor,
    secureUninstallRemoteIntegrations,
    acquireDeployLock,
    releaseDeployLock,
    buildOwnershipPreflightScript,
    buildLegacyMonitorCleanupScript,
    buildInstallerVerificationCommand,
    buildMonitorVerificationCommand,
    buildScpRemoteTarget,
    probeRemoteCliCapabilities,
    buildIsolatedWrapper,
    buildWrapperEvidence,
    cleanupLegacyMonitor,
    runOwnershipPreflight,
    buildRemoteInstallerEnv,
    fencedCommand,
    hasSecureRemoteOwnership,
  },
};
