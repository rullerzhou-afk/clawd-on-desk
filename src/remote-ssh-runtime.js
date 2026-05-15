"use strict";

// ── Remote SSH runtime ──
//
// Main-process owner of the SSH tunnel lifecycle. Spawn / kill `ssh` / `scp`
// children, run the state machine, classify errors, drive the health probe,
// hand status changes back to the IPC layer.
//
// Pure data → safe to require under tests:
//
//   detectSsh()                — `where|which ssh` + `ssh -V` parse
//   buildSshArgs(profile, opt) — shared arg constructor for ALL ssh calls
//   buildScpArgs(profile, opt) — same for scp (note: scp port flag is `-P`)
//   classifyStderr(stderr)     — pure error classifier
//   classifyProbeExit(code)    — pure probe-exit-code classifier
//   buildProbeCommand(port)    — builds the remote Node health probe command
//
// Stateful (factory):
//
//   createRemoteSshRuntime({ spawn, getHookServerPort, hooksDir, log })
//     .getProfileStatus(id)   — { status, message?, lastError? }
//     .listStatuses()         — Array<{ profileId, status, ... }>
//     .connect(profile)
//     .disconnect(profileId)
//     .cleanup()              — kill all children + clear timers
//     .on("status-changed", cb({ profileId, status, ... }))
//     .on("progress", cb({ profileId, step, status, message? })) — deploy hooks
//
// The runtime never writes prefs. Profile CRUD goes through
// `settings-controller`; this file only consumes the validated profile.

const childProcess = require("child_process");
const { EventEmitter } = require("events");
const {
  resolveRemoteNodeBin,
  getCachedRemoteNodeBin,
  clearCachedRemoteNodeBin,
  buildRemoteNodeEvalCommand,
} = require("./remote-ssh-node");

const SSH_BASE_OPTS = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
const SCP_BASE_OPTS = ["-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];

const PROBE_WINDOW_MS = 12000;
const PROBE_MIN_GAP_MS = 250;
const BACKOFF_SCHEDULE_MS = [5000, 15000, 45000, 120000, 300000];
const UNKNOWN_STRIKES_LIMIT = 3;

const CLAWD_SERVER_HEADER = "x-clawd-server";
const CLAWD_SERVER_ID = "clawd-on-desk";

// ── Detect ssh client ──
//
// Cheap one-shot at runtime construction. Returns
//   { available: true, version: "OpenSSH_9.5p2 ..." }
// or { available: false, error: "..." } on failure / not found.
//
// Stays small (<30 lines) and inlined per plan v6 (folding detect into runtime).
function detectSsh({ exec = childProcess.execFileSync } = {}) {
  try {
    // ssh -V writes to STDERR on every implementation. Capture both streams
    // and merge for resilience against future behavior changes.
    const out = exec("ssh", ["-V"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      windowsHide: true,
    });
    // Some platforms put the banner on stderr only — execFileSync returns
    // stdout. If empty, fall back to a flag-less invocation that should fail
    // gracefully but still returns. We accept whatever ssh wrote.
    const version = (out || "").toString().trim() || "(no version banner)";
    return { available: true, version };
  } catch (err) {
    if (err && err.stderr) {
      const stderr = err.stderr.toString().trim();
      // Older ssh writes -V to stderr and exits 0 — execFileSync treats that
      // as success. If it landed in catch we have an actual problem (ENOENT).
      if (stderr && err.code !== "ENOENT") {
        return { available: true, version: stderr };
      }
    }
    const msg = err && err.code === "ENOENT"
      ? "ssh executable not found in PATH"
      : (err && err.message) || "ssh detect failed";
    return { available: false, error: msg };
  }
}

// ── Shared ssh / scp arg builders ──
//
// Every ssh / scp invocation across the runtime, deploy, probe, codex monitor,
// authenticate, and open-terminal paths MUST go through these. They guarantee:
//
//   1. Non-interactive defaults (-T, BatchMode=yes, ConnectTimeout=15) so
//      the spawned process never wedges on a prompt.
//   2. Profile's `-i identityFile` / `-p port` (scp: `-P port`) are always
//      injected, so non-default-port / specified-key profiles work for
//      Deploy, Codex monitor, Authenticate — not just Connect.
//   3. extraOpts append AFTER profile defaults so `-o BatchMode=no` and
//      `-o ConnectTimeout=2` overrides can win via ssh's last-wins semantics.
//
// Host is appended last for ssh; scp callers add `host:path` themselves.
function buildSshArgs(profile, { extraOpts = [], interactive = false } = {}) {
  if (!profile || typeof profile.host !== "string" || !profile.host) {
    throw new Error("buildSshArgs: profile.host required");
  }
  if (!Array.isArray(extraOpts)) {
    throw new TypeError("buildSshArgs: extraOpts must be an array");
  }
  // `-T` (no pseudo-tty) is correct for backgrounded tunnels, deploys, and
  // probes — but **wrong** for Authenticate / Open Terminal: those land the
  // user in an interactive shell, where -T breaks vim/less/bash readline.
  // Caller passes interactive: true to drop -T, letting ssh negotiate a pty
  // by default (terminal emulator already provides a local tty).
  const baseOpts = interactive
    ? SSH_BASE_OPTS.filter((opt) => opt !== "-T")
    : SSH_BASE_OPTS.slice();
  const args = baseOpts;
  if (profile.identityFile) args.push("-i", profile.identityFile);
  if (profile.port && profile.port !== 22) args.push("-p", String(profile.port));
  args.push(...extraOpts);
  args.push(profile.host);
  return args;
}

function buildScpArgs(profile, { extraOpts = [] } = {}) {
  if (!profile) throw new Error("buildScpArgs: profile required");
  if (!Array.isArray(extraOpts)) {
    throw new TypeError("buildScpArgs: extraOpts must be an array");
  }
  const args = SCP_BASE_OPTS.slice();
  if (profile.identityFile) args.push("-i", profile.identityFile);
  if (profile.port && profile.port !== 22) args.push("-P", String(profile.port));
  args.push(...extraOpts);
  return args;
}

// ── stderr classifier ──
//
// Maps ssh stderr text to one of:
//   { kind: "permanent", reason: <slug>, hint: <i18n key> }
//   { kind: "transient", reason: <slug>, hint: <i18n key> }
//   { kind: "unknown" }
//
// Reasons are stable slugs; UI translates via i18n. Match against `LANG=C
// LC_ALL=C` ssh output (English locale forced via spawn env).
function classifyStderr(stderr) {
  const text = (stderr || "").toString();
  if (!text.trim()) return { kind: "unknown" };

  // Permanent — authentication / configuration errors that won't self-heal.
  if (/Permission denied/i.test(text)) {
    return { kind: "permanent", reason: "auth_denied", hint: "remoteSshErrAuthDenied" };
  }
  if (/Host key verification failed/i.test(text)) {
    return { kind: "permanent", reason: "host_key", hint: "remoteSshErrHostKey" };
  }
  if (/remote port forwarding failed/i.test(text)) {
    return { kind: "permanent", reason: "forward_failed", hint: "remoteSshErrForwardFailed" };
  }
  if (/Bad configuration option/i.test(text)) {
    return { kind: "permanent", reason: "bad_config", hint: "remoteSshErrBadConfig" };
  }
  if (/(no such identity|cannot read identity|Identity file .* not accessible)/i.test(text)) {
    return { kind: "permanent", reason: "identity_missing", hint: "remoteSshErrIdentityMissing" };
  }
  if (/Could not resolve hostname/i.test(text)) {
    return { kind: "permanent", reason: "dns", hint: "remoteSshErrDns" };
  }

  // Transient — network layer issues that exponential-backoff retries.
  if (/Connection (timed out|refused|reset)/i.test(text)) {
    return { kind: "transient", reason: "net_timeout", hint: "remoteSshErrNetTimeout" };
  }
  if (/Network is unreachable/i.test(text)) {
    return { kind: "transient", reason: "net_unreachable", hint: "remoteSshErrNetUnreachable" };
  }
  if (/Broken pipe/i.test(text)) {
    return { kind: "transient", reason: "broken_pipe", hint: "remoteSshErrBrokenPipe" };
  }
  if (/Operation timed out/i.test(text)) {
    return { kind: "transient", reason: "op_timeout", hint: "remoteSshErrNetTimeout" };
  }

  return { kind: "unknown" };
}

// ── Probe exit code classifier ──
//
// The probe is a single ssh + node-e GET against the remote forward port.
// Exit codes are defined by buildProbeCommand below:
//   0   header match + status 200 (connected)
//   1   header match + non-200    (local Clawd server unhealthy)
//   2   http.get error event       (forward up but server unresponsive)
//   3   header mismatch            (port hijacked by another HTTP service)
//   4   req.setTimeout fired       (server accepted TCP but hung)
//   126 remote node not executable
//   127 remote node not found
//   130 SIGINT
//   137 SIGKILL (often OOM)
//   143 SIGTERM
//   255 ssh self-disconnected
//   *   anything else — treat as transient
function classifyProbeExit(code) {
  if (code === 0) return { kind: "ok" };
  if (code === 1) return { kind: "permanent", reason: "probe_local_unhealthy", hint: "remoteSshProbeLocalUnhealthy" };
  if (code === 2) return { kind: "permanent", reason: "probe_unresponsive", hint: "remoteSshProbeUnresponsive" };
  if (code === 3) return { kind: "permanent", reason: "probe_port_hijack", hint: "remoteSshProbePortHijack" };
  if (code === 4) return { kind: "transient", reason: "probe_http_timeout", hint: "remoteSshProbeHttpTimeout" };
  if (code === 126) return { kind: "permanent", reason: "probe_node_not_exec", hint: "remoteSshProbeNodeNotExec" };
  if (code === 127) return { kind: "permanent", reason: "probe_node_missing", hint: "remoteSshProbeNodeMissing" };
  if (code === 130 || code === 137 || code === 143 || code === 255) {
    return { kind: "transient", reason: "probe_signal", hint: "remoteSshProbeSignal" };
  }
  return { kind: "transient", reason: "probe_unknown", hint: "remoteSshProbeSignal" };
}

// ── Probe command builder ──
//
// Returns the remote command string to append after the ssh args. Single
// argument: the remoteForwardPort (NOT localRuntimePort — probe runs from
// remote and hits 127.0.0.1:<remoteForwardPort> which is the bound side of
// the reverse tunnel).
function buildProbeCommand(remoteForwardPort, nodeBin = "node") {
  if (!Number.isInteger(remoteForwardPort)) {
    throw new TypeError("buildProbeCommand: remoteForwardPort must be an integer");
  }
  // Node single-line: header check first (per v7), then status. Embedded
  // double quotes get backslash-escaped so the whole thing fits on a single
  // ssh remote-command argument once forwarded as one shell token.
  const url = `http://127.0.0.1:${remoteForwardPort}/state`;
  const js =
    `const r=require('http').get(${JSON.stringify(url)},res=>{` +
      `const m=res.headers[${JSON.stringify(CLAWD_SERVER_HEADER)}]===${JSON.stringify(CLAWD_SERVER_ID)};` +
      `if(!m)process.exit(3);` +
      `process.exit(res.statusCode===200?0:1);` +
    `});` +
    `r.on('error',()=>process.exit(2));` +
    `r.setTimeout(2000,()=>{r.destroy();process.exit(4);});`;
  if (nodeBin === "node") return `node -e ${JSON.stringify(js)}`;
  return buildRemoteNodeEvalCommand(nodeBin, js);
}

// ── Backoff helper ──
function backoffMsForAttempt(attempt) {
  if (!Number.isInteger(attempt) || attempt < 0) return BACKOFF_SCHEDULE_MS[0];
  const idx = Math.min(attempt, BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[idx];
}

// ── Runtime factory ──

function createRemoteSshRuntime(deps = {}) {
  const spawn = deps.spawn || childProcess.spawn;
  const getHookServerPort = deps.getHookServerPort;
  const log = deps.log || (() => {});
  const setTimeoutFn = deps.setTimeout || setTimeout;
  const clearTimeoutFn = deps.clearTimeout || clearTimeout;
  const resolveRemoteNode = deps.resolveRemoteNodeBin || resolveRemoteNodeBin;

  if (typeof getHookServerPort !== "function") {
    throw new Error("createRemoteSshRuntime: deps.getHookServerPort is required");
  }

  const emitter = new EventEmitter();
  // Map<profileId, ProfileState>
  const states = new Map();

  function newState(profile) {
    return {
      profile,
      status: "idle",
      message: null,
      lastError: null,
      lastErrorReason: null,
      sshChild: null,
      stderrBuf: "",
      probeChild: null,
      probeInFlight: false,
      probeStartedAt: 0,
      probeWindowDeadline: 0,
      probeIntervalTimer: null,
      probeWindowTimer: null,
      remoteNodeBin: null,
      remoteNodeSource: null,
      allowBareNodeProbe: false,
      remoteNodeResolveInFlight: false,
      backoffTimer: null,
      retryAttempt: 0,
      unknownStrikes: 0,
      stopped: false,
    };
  }

  function setStatus(state, status, extra = {}) {
    state.status = status;
    if ("message" in extra) state.message = extra.message;
    if ("lastError" in extra) state.lastError = extra.lastError;
    if ("lastErrorReason" in extra) state.lastErrorReason = extra.lastErrorReason;
    emitStatus(state);
  }

  function emitStatus(state) {
    emitter.emit("status-changed", snapshotState(state));
  }

  function snapshotState(state) {
    return {
      profileId: state.profile.id,
      status: state.status,
      message: state.message,
      lastError: state.lastError,
      lastErrorReason: state.lastErrorReason,
      retryAttempt: state.retryAttempt,
    };
  }

  function getProfileStatus(profileId) {
    const state = states.get(profileId);
    if (!state) return { profileId, status: "idle", message: null, lastError: null };
    return snapshotState(state);
  }

  function listStatuses() {
    const out = [];
    for (const state of states.values()) out.push(snapshotState(state));
    return out;
  }

  // ── Connect ──

  function connect(profile) {
    if (!profile || !profile.id) throw new Error("connect: profile.id required");
    let state = states.get(profile.id);
    if (state) {
      // Replace profile snapshot — caller may have just edited fields.
      state.profile = profile;
      // If already connecting / connected, no-op (idempotent).
      if (state.status === "connecting" || state.status === "connected"
          || state.status === "reconnecting") {
        return snapshotState(state);
      }
      // Reset retry counters on a user-initiated re-connect.
      state.retryAttempt = 0;
      state.unknownStrikes = 0;
      state.stopped = false;
    } else {
      state = newState(profile);
      states.set(profile.id, state);
    }
    startConnect(state);
    return snapshotState(state);
  }

  function startConnect(state) {
    if (state.stopped) return;
    state.remoteNodeResolveInFlight = false;
    setStatus(state, state.status === "reconnecting" ? "reconnecting" : "connecting", {
      message: null,
      lastError: null,
      lastErrorReason: null,
    });

    let localPort;
    try {
      localPort = getHookServerPort();
    } catch (err) {
      log("remote-ssh: getHookServerPort threw:", err && err.message);
      finishFailure(state, {
        kind: "permanent",
        reason: "no_local_port",
        hint: "remoteSshErrNoLocalPort",
        message: (err && err.message) || "Local server port unavailable",
      });
      return;
    }
    if (!Number.isInteger(localPort)) {
      finishFailure(state, {
        kind: "permanent",
        reason: "no_local_port",
        hint: "remoteSshErrNoLocalPort",
        message: "Local server port unavailable",
      });
      return;
    }

    const profile = state.profile;
    const forwardOpt = `127.0.0.1:${profile.remoteForwardPort}:127.0.0.1:${localPort}`;
    const extraOpts = [
      "-N",
      "-R", forwardOpt,
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
    ];
    const args = buildSshArgs(profile, { extraOpts });

    let child;
    try {
      child = spawn("ssh", args, {
        env: { ...process.env, LANG: "C", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      finishFailure(state, {
        kind: "permanent",
        reason: "spawn_failed",
        hint: "remoteSshErrSpawnFailed",
        message: (err && err.message) || "ssh spawn failed",
      });
      return;
    }

    state.sshChild = child;
    state.stderrBuf = "";

    // All handlers below identity-gate against `child` (closure-captured) so
    // a stale exit/error from a previous Disconnect→Connect cycle can't
    // corrupt the current child's state. Pattern: rapid Disconnect (kills A)
    // immediately followed by Connect (spawns B) leaves A's exit pending;
    // when it fires, the closure still references the runtime state which
    // now points at B, so without identity check A's handler would null out
    // sshChild → orphan B and trigger a reconnect using A's stderr.
    child.on("error", (err) => {
      if (state.sshChild !== child) return;
      // ENOENT, EACCES, etc. before spawn completes.
      const reason = err && err.code === "ENOENT" ? "ssh_missing" : "spawn_failed";
      const hint = reason === "ssh_missing" ? "remoteSshErrSshMissing" : "remoteSshErrSpawnFailed";
      finishFailure(state, {
        kind: "permanent",
        reason,
        hint,
        message: (err && err.message) || "ssh process error",
      });
    });

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        if (state.sshChild !== child) return;
        state.stderrBuf += chunk.toString();
        // Cap buffer at 8KB to avoid unbounded growth on noisy hosts.
        if (state.stderrBuf.length > 8192) {
          state.stderrBuf = state.stderrBuf.slice(-8192);
        }
      });
    }

    child.on("exit", (code, signal) => {
      onSshExit(state, child, code, signal);
    });

    startProbeLoopWithRemoteNode(state, child);
  }

  function remoteNodeExpectedTarget(profile) {
    return {
      host: profile && profile.host,
      port: profile && profile.port,
      identityFile: profile && profile.identityFile,
      remoteForwardPort: profile && profile.remoteForwardPort,
      hostPrefix: profile && profile.hostPrefix,
    };
  }

  function startProbeLoopWithRemoteNode(state, child) {
    const cached = getCachedRemoteNodeBin(state.profile);
    if (cached && cached.nodeBin) {
      state.remoteNodeBin = cached.nodeBin;
      state.remoteNodeSource = cached.source || "cache";
      state.allowBareNodeProbe = false;
      startProbeLoop(state);
      return;
    }

    // Cache miss: start the health probe immediately with the legacy bare
    // node command while resolving an absolute Node path in the background.
    // Once the resolver returns, subsequent probes switch to the absolute
    // path and the result is emitted for profile persistence.
    state.remoteNodeBin = null;
    state.remoteNodeSource = null;
    state.allowBareNodeProbe = true;
    startProbeLoop(state);
  }

  function emitRemoteNodeDetected(state, resolved) {
    emitter.emit("remote-node-detected", {
      id: state.profile.id,
      nodeBin: resolved.nodeBin,
      version: resolved.version || null,
      source: resolved.source || null,
      detectedAt: Date.now(),
      expectedTarget: remoteNodeExpectedTarget(state.profile),
    });
  }

  function resolveRemoteNodeInBackground(state, child) {
    if (state.remoteNodeResolveInFlight) return;
    state.remoteNodeResolveInFlight = true;
    const finish = (resolved) => {
      if (state.sshChild !== child) return;
      if (state.stopped) {
        state.remoteNodeResolveInFlight = false;
        return;
      }
      state.remoteNodeResolveInFlight = false;
      if (!resolved || resolved.ok !== true || !resolved.nodeBin) {
        const cls = classifyStderr((resolved && resolved.stderr) || "");
        if (cls.kind === "permanent") {
          finishFailure(state, {
            kind: "permanent",
            reason: cls.reason,
            hint: cls.hint,
            message: stderrSummary(resolved.stderr) || (resolved && resolved.message) || "Remote SSH failed.",
          });
          return;
        }
        if (state.status === "connected") {
          // TODO(remote-ssh): add a short-lived negative cache for resolver
          // failures. Some hosts can pass the bare `node` health probe but
          // still fail this absolute-path resolver; without a retry-after
          // cache, every reconnect pays another background resolver attempt.
          log("remote-ssh: remote Node resolver failed after probe success:", resolved && resolved.message);
          return;
        }
        finishFailure(state, {
          kind: "permanent",
          reason: "probe_node_missing",
          hint: "remoteSshProbeNodeMissing",
          message: (resolved && resolved.message) || "Remote Node.js not found.",
        });
        return;
      }
      state.remoteNodeBin = resolved.nodeBin;
      state.remoteNodeSource = resolved.source || null;
      state.allowBareNodeProbe = false;
      emitRemoteNodeDetected(state, resolved);
      if (state.status !== "connected" && state.sshChild && !state.probeInFlight) {
        schedNextProbe(state, 0);
      }
    };
    const fail = (err) => {
      if (state.sshChild !== child) return;
      if (state.stopped) {
        state.remoteNodeResolveInFlight = false;
        return;
      }
      state.remoteNodeResolveInFlight = false;
      const cls = classifyStderr((err && err.stderr) || "");
      if (cls.kind === "permanent") {
        finishFailure(state, {
          kind: "permanent",
          reason: cls.reason,
          hint: cls.hint,
          message: stderrSummary(err.stderr) || (err && err.message) || "Remote SSH failed.",
        });
        return;
      }
      if (state.status === "connected") {
        // TODO(remote-ssh): add a short-lived negative cache for resolver
        // failures. Some hosts can pass the bare `node` health probe but
        // still fail this absolute-path resolver; without a retry-after
        // cache, every reconnect pays another background resolver attempt.
        log("remote-ssh: remote Node resolver threw after probe success:", err && err.message);
        return;
      }
      finishFailure(state, {
        kind: "permanent",
        reason: "probe_node_missing",
        hint: "remoteSshProbeNodeMissing",
        message: (err && err.message) || "Remote Node.js probe failed.",
      });
    };

    try {
      const result = resolveRemoteNode({
        profile: state.profile,
        spawn,
        buildSshArgs,
        runtime: {
          registerChild,
          unregisterChild,
        },
        useCache: false,
      });
      if (result && typeof result.then === "function") {
        result.then(finish, fail);
      } else {
        finish(result);
      }
    } catch (err) {
      fail(err);
    }
  }

  function onSshExit(state, child, code, signal) {
    // Identity-gate: if this child isn't the current sshChild anymore, the
    // exit belongs to a stale process from a prior connect cycle — drop.
    if (state.sshChild !== child) return;
    state.sshChild = null;
    cleanupProbeLoop(state);

    if (state.stopped) {
      // User-initiated disconnect already flipped state to idle.
      return;
    }

    // We exit here for one of three reasons:
    //   (a) connect attempt failed before probe succeeded
    //   (b) connected → ssh died (ServerAlive timed out, network drop)
    //   (c) immediate failure (ENOENT-by-other-means caught here)
    const stderr = state.stderrBuf || "";
    const cls = classifyStderr(stderr);
    const wasConnected = state.status === "connected";

    if (cls.kind === "permanent") {
      finishFailure(state, {
        kind: "permanent",
        reason: cls.reason,
        hint: cls.hint,
        message: stderrSummary(stderr) || `ssh exited ${formatExit(code, signal)}`,
      });
      return;
    }

    if (cls.kind === "unknown") {
      state.unknownStrikes += 1;
      if (state.unknownStrikes >= UNKNOWN_STRIKES_LIMIT) {
        finishFailure(state, {
          kind: "permanent",
          reason: "unknown_strikes",
          hint: "remoteSshErrUnknownStrikes",
          message: stderrSummary(stderr) || `ssh exited ${formatExit(code, signal)}`,
        });
        return;
      }
    } else {
      // transient
      state.unknownStrikes = 0;
    }

    // Transient (or unknown under strike-limit): backoff + reconnect.
    scheduleReconnect(state, {
      message: stderrSummary(stderr) || `ssh exited ${formatExit(code, signal)}`,
      lastErrorReason: cls.reason || (cls.kind === "unknown" ? "unknown" : null),
      wasConnected,
    });
  }

  // ── Probe loop ──
  //
  // Runs from when the main ssh is spawned until either:
  //   - probe returns 0  → status flipped to connected, loop ends
  //   - 12s window elapses with no success → classify last probe exit
  //   - main ssh exits → loop torn down by onSshExit
  //
  // Lock guard `probeInFlight` prevents launching a probe before the prior
  // one finishes — under flaky networks back-to-back probes can accumulate.

  function startProbeLoop(state) {
    state.probeStartedAt = Date.now();
    state.probeWindowDeadline = state.probeStartedAt + PROBE_WINDOW_MS;
    state.probeInFlight = false;
    state.probeLastExitCode = null;
    schedNextProbe(state, 0);
    state.probeWindowTimer = setTimeoutFn(() => {
      onProbeWindowTimeout(state);
    }, PROBE_WINDOW_MS);
  }

  function schedNextProbe(state, delayMs) {
    if (state.probeIntervalTimer) {
      clearTimeoutFn(state.probeIntervalTimer);
      state.probeIntervalTimer = null;
    }
    state.probeIntervalTimer = setTimeoutFn(() => {
      state.probeIntervalTimer = null;
      if (state.stopped || !state.sshChild) return;
      if (state.status === "connected") return;
      runProbe(state);
    }, Math.max(0, delayMs));
  }

  function runProbe(state) {
    if (state.probeInFlight) return;
    if (Date.now() >= state.probeWindowDeadline) return;
    if (state.allowBareNodeProbe && state.remoteNodeResolveInFlight && !state.remoteNodeBin) {
      return;
    }
    state.probeInFlight = true;

    const profile = state.profile;
    const nodeBin = state.remoteNodeBin || (state.allowBareNodeProbe ? "node" : null);
    if (!nodeBin) {
      state.probeInFlight = false;
      finishFailure(state, {
        kind: "permanent",
        reason: "probe_node_missing",
        hint: "remoteSshProbeNodeMissing",
        message: "Remote Node.js path has not been resolved.",
      });
      return;
    }
    const probeCmd = buildProbeCommand(profile.remoteForwardPort, nodeBin);
    const probeArgs = buildSshArgs(profile, {
      extraOpts: ["-o", "ConnectTimeout=2"],
    }).concat([probeCmd]);

    let probe;
    try {
      probe = spawn("ssh", probeArgs, {
        env: { ...process.env, LANG: "C", LC_ALL: "C" },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      state.probeInFlight = false;
      log("remote-ssh probe spawn threw:", err && err.message);
      schedNextProbe(state, PROBE_MIN_GAP_MS);
      return;
    }

    state.probeChild = probe;

    // Identity-gate both handlers: if probeChild has rotated to a newer
    // probe (or been cleared by cleanupProbeLoop / disconnect), this stale
    // event must NOT touch probeInFlight, probeLastExitCode, or trigger a
    // false connected status from the old probe's exitCode === 0.
    //
    // Also defensive against Node only emitting 'error' (e.g. stdio pipe
    // failure) without 'exit' — the error handler does the same cleanup
    // work the exit handler would have, so the lock can't deadlock.
    probe.on("error", (err) => {
      if (state.probeChild !== probe) return;
      state.probeInFlight = false;
      state.probeChild = null;
      // Synthetic exit code so classifyProbeExit treats this as transient.
      state.probeLastExitCode = -1;
      log("remote-ssh probe child error:", err && err.message);
      if (state.stopped) return;
      if (Date.now() < state.probeWindowDeadline && state.sshChild) {
        schedNextProbe(state, PROBE_MIN_GAP_MS);
      }
    });

    probe.on("exit", (code, signal) => {
      if (state.probeChild !== probe) return;
      state.probeInFlight = false;
      state.probeChild = null;
      const exitCode = signalToExitCode(code, signal);
      state.probeLastExitCode = exitCode;
      if (state.stopped) return;
      if ((exitCode === 126 || exitCode === 127)
          && state.sshChild
          && !state.remoteNodeResolveInFlight) {
        if (state.remoteNodeBin) {
          clearCachedRemoteNodeBin(state.profile);
          state.remoteNodeBin = null;
          state.remoteNodeSource = null;
          state.allowBareNodeProbe = true;
        }
        resolveRemoteNodeInBackground(state, state.sshChild);
      }
      if (exitCode === 0 && state.sshChild) {
        onProbeSuccess(state);
        return;
      }
      // Schedule next attempt if we still have window time left.
      if (Date.now() < state.probeWindowDeadline && state.sshChild && !state.stopped) {
        schedNextProbe(state, PROBE_MIN_GAP_MS);
      }
    });
  }

  function onProbeSuccess(state) {
    const child = state.sshChild;
    const shouldResolveBareNode = state.allowBareNodeProbe
      && !state.remoteNodeBin
      && child
      && !state.remoteNodeResolveInFlight;
    cleanupProbeLoop(state);
    state.retryAttempt = 0;
    state.unknownStrikes = 0;
    setStatus(state, "connected", {
      message: null,
      lastError: null,
      lastErrorReason: null,
    });
    if (shouldResolveBareNode) {
      resolveRemoteNodeInBackground(state, child);
    }
  }

  function onProbeWindowTimeout(state) {
    state.probeWindowTimer = null;
    if (state.stopped) return;
    if (state.status === "connected") return;
    if (!state.sshChild) return;
    // Main ssh still up but probe never returned 200 in window. Classify
    // by last probe exit code; fall back to transient if no probe ever
    // returned (network flake).
    const exitCode = state.probeLastExitCode;
    if (exitCode == null) {
      // No probe completed — network flake; keep main alive but mark probe_failed
      // transient. We don't kill main; let main's stderr eventually report.
      // For UX we surface a "still trying" hint by leaving status as connecting.
      // Re-arm the window for another 12s pass.
      state.probeWindowDeadline = Date.now() + PROBE_WINDOW_MS;
      state.probeWindowTimer = setTimeoutFn(() => onProbeWindowTimeout(state), PROBE_WINDOW_MS);
      schedNextProbe(state, PROBE_MIN_GAP_MS);
      return;
    }
    const cls = classifyProbeExit(exitCode);
    if (cls.kind === "ok") {
      onProbeSuccess(state);
      return;
    }
    if (cls.kind === "permanent") {
      if ((cls.reason === "probe_node_missing" || cls.reason === "probe_node_not_exec")
          && (state.allowBareNodeProbe || state.remoteNodeBin)) {
        if (state.remoteNodeBin) {
          clearCachedRemoteNodeBin(state.profile);
          state.remoteNodeBin = null;
          state.remoteNodeSource = null;
          state.allowBareNodeProbe = true;
        }
        if (!state.remoteNodeResolveInFlight && state.sshChild) {
          resolveRemoteNodeInBackground(state, state.sshChild);
        }
        if (state.stopped) return;
        if (state.remoteNodeResolveInFlight) {
          state.probeWindowDeadline = Date.now() + PROBE_WINDOW_MS;
          state.probeWindowTimer = setTimeoutFn(() => onProbeWindowTimeout(state), PROBE_WINDOW_MS);
          schedNextProbe(state, PROBE_MIN_GAP_MS);
          return;
        }
      }
      // Tear down main ssh and mark failed.
      killChild(state.sshChild);
      state.sshChild = null;
      finishFailure(state, {
        kind: "permanent",
        reason: cls.reason,
        hint: cls.hint,
        message: `Health probe failed (exit ${exitCode})`,
      });
      return;
    }
    // Transient — keep main alive, re-arm probe window.
    state.probeWindowDeadline = Date.now() + PROBE_WINDOW_MS;
    state.probeWindowTimer = setTimeoutFn(() => onProbeWindowTimeout(state), PROBE_WINDOW_MS);
    schedNextProbe(state, PROBE_MIN_GAP_MS);
  }

  function cleanupProbeLoop(state) {
    if (state.probeIntervalTimer) {
      clearTimeoutFn(state.probeIntervalTimer);
      state.probeIntervalTimer = null;
    }
    if (state.probeWindowTimer) {
      clearTimeoutFn(state.probeWindowTimer);
      state.probeWindowTimer = null;
    }
    if (state.probeChild) {
      killChild(state.probeChild);
      state.probeChild = null;
    }
    state.probeInFlight = false;
  }

  // ── Reconnect / failure paths ──

  function scheduleReconnect(state, { message, lastErrorReason, wasConnected }) {
    if (state.stopped) return;
    state.lastError = message;
    state.lastErrorReason = lastErrorReason;
    state.message = message;
    const delay = backoffMsForAttempt(state.retryAttempt);
    state.retryAttempt += 1;
    setStatus(state, "reconnecting", {
      message,
      lastError: message,
      lastErrorReason,
    });
    if (state.backoffTimer) clearTimeoutFn(state.backoffTimer);
    state.backoffTimer = setTimeoutFn(() => {
      state.backoffTimer = null;
      if (state.stopped) return;
      startConnect(state);
    }, delay);
    // Suppress the unused wasConnected — kept in signature for future
    // differentiation between drop-while-connected vs. failed-to-connect UX.
    void wasConnected;
  }

  function finishFailure(state, { reason, hint, message }) {
    cleanupProbeLoop(state);
    if (state.sshChild) {
      killChild(state.sshChild);
      state.sshChild = null;
    }
    if (state.backoffTimer) {
      clearTimeoutFn(state.backoffTimer);
      state.backoffTimer = null;
    }
    state.remoteNodeResolveInFlight = false;
    state.stopped = true;
    setStatus(state, "failed", {
      message: message || hint || reason,
      lastError: message || hint || reason,
      lastErrorReason: reason,
    });
  }

  // ── Disconnect ──

  function disconnect(profileId) {
    const state = states.get(profileId);
    if (!state) return { profileId, status: "idle" };
    state.stopped = true;
    cleanupProbeLoop(state);
    if (state.backoffTimer) {
      clearTimeoutFn(state.backoffTimer);
      state.backoffTimer = null;
    }
    if (state.sshChild) {
      killChild(state.sshChild);
      state.sshChild = null;
    }
    state.retryAttempt = 0;
    state.unknownStrikes = 0;
    state.remoteNodeResolveInFlight = false;
    setStatus(state, "idle", {
      message: null,
      lastError: null,
      lastErrorReason: null,
    });
    return snapshotState(state);
  }

  // ── Auxiliary children registry (deploy / codex monitor) ──
  //
  // Tunnel + probe children live on per-profile state above. Deploy and
  // Codex monitor are one-shot ssh / scp invocations whose Promise-awaited
  // children would orphan if the user quits the app mid-Deploy. Modules
  // that spawn such children call registerChild() on entry and
  // unregisterChild() on exit; cleanup() kills any still registered.
  const auxChildren = new Set();

  function registerChild(child) {
    if (!child) return;
    auxChildren.add(child);
  }

  function unregisterChild(child) {
    if (!child) return;
    auxChildren.delete(child);
  }

  function cleanup() {
    for (const state of states.values()) {
      state.stopped = true;
      cleanupProbeLoop(state);
      if (state.backoffTimer) clearTimeoutFn(state.backoffTimer);
      state.backoffTimer = null;
      state.remoteNodeResolveInFlight = false;
      if (state.sshChild) killChild(state.sshChild);
      state.sshChild = null;
    }
    states.clear();
    for (const child of auxChildren) killChild(child);
    auxChildren.clear();
  }

  return {
    connect,
    disconnect,
    cleanup,
    getProfileStatus,
    listStatuses,
    registerChild,
    unregisterChild,
    on: (event, cb) => emitter.on(event, cb),
    off: (event, cb) => emitter.off(event, cb),
    emit: (event, payload) => emitter.emit(event, payload),
    // For deploy module to broadcast progress under the same channel.
    _emitter: emitter,
  };
}

// ── Helpers ──

function killChild(child) {
  if (!child) return;
  try {
    child.kill();
  } catch {}
}

function stderrSummary(stderr) {
  const text = (stderr || "").toString().trim();
  if (!text) return null;
  return text.length > 200 ? text.slice(0, 200) + "..." : text;
}

function formatExit(code, signal) {
  if (signal) return `signal ${signal}`;
  return `code ${code == null ? "?" : code}`;
}

function signalToExitCode(code, signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGKILL") return 137;
  if (signal === "SIGTERM") return 143;
  if (signal && typeof signal === "string") return 128;
  if (Number.isInteger(code)) return code;
  return -1;
}

module.exports = {
  // pure helpers — stable surface for tests
  detectSsh,
  buildSshArgs,
  buildScpArgs,
  classifyStderr,
  classifyProbeExit,
  buildProbeCommand,
  backoffMsForAttempt,
  // factory
  createRemoteSshRuntime,
  // constants
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
  PROBE_WINDOW_MS,
  PROBE_MIN_GAP_MS,
  BACKOFF_SCHEDULE_MS,
  UNKNOWN_STRIKES_LIMIT,
};
