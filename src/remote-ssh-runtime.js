"use strict";

// ── Remote SSH runtime ──
//
// Main-process owner of the SSH tunnel lifecycle. Spawn / kill `ssh` / `scp`
// children, run the state machine, classify errors, drive the health probe,
// hand status changes back to the IPC layer.
//
// Pure data → safe to require under tests:
//
//   detectSsh()                — `ssh -V` parse
//   buildSshArgs(profile, opt) — shared arg constructor for ALL ssh calls
//   buildScpArgs(profile, opt) — same for scp (note: scp port flag is `-P`)
//   classifyStderr(stderr)     — pure error classifier
//   classifyProbeExit(code)    — pure probe-exit-code classifier
//   buildProbeCommand(port)    — builds the remote Node health probe command
//   tunnelTargetKey(profile)   — normalized reverse-tunnel target identity
//   checkSecureConnectReadiness(profile) — local fail-closed deployment gate
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
const crypto = require("crypto");
const { EventEmitter } = require("events");
const {
  resolveRemoteNodeBin,
  getCachedRemoteNodeBin,
  clearCachedRemoteNodeBin,
  buildRemoteNodeEvalCommand,
} = require("./remote-ssh-node");
const { decodeShellBytes } = require("./remote-ssh-decode");
const { acceptedRoutingNonces } = require("./remote-ssh-identity");
const { resolveRemoteRuntimeLayout } = require("./remote-ssh-layout");
const { redactTransportDiagnostic } = require("./remote-ssh-transport");
const { appendRemoteSshConfigArgs } = require("./remote-ssh-local-config");

const SSH_BASE_OPTS = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
const SCP_BASE_OPTS = ["-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
// Interactive base intentionally empty: no -T (pty needed), no BatchMode=yes
// (must allow password / passphrase / host-key prompts), no ConnectTimeout=15
// (user-initiated; they can wait). Callers add `-o BatchMode=no` via extraOpts
// to also beat any `BatchMode yes` in the user's ~/.ssh/config — command-line
// -o wins because it's the FIRST BatchMode token ssh sees.
const SSH_INTERACTIVE_BASE_OPTS = [];

// "cmd is not recognized" — emitted by Windows OpenSSH when the remote
// default shell is cmd.exe and our `sh -c <script>` probe lands on it.
// Multi-language because the Windows console respects the user locale
// (zh-CN/zh-TW/ja/ko/de). When the resolver fails with this pattern we
// know the host is windows-cmd and there's no point retrying the resolver
// or logging the same expected failure on every reconnect — the bare
// `node` health probe already keeps the tunnel green on Windows hosts
// that happen to have node.exe on PATH.
const WINDOWS_CMD_STDERR_RX =
  /not recognized as an internal or external command|不是内部或外部命令|不是內部或外部命令|内部コマンドまたは外部コマンド|내부 명령 또는 외부 명령|nicht als interner oder externer/i;

function looksLikeWindowsCmdStderr(stderr) {
  return WINDOWS_CMD_STDERR_RX.test(String(stderr || ""));
}

const PROBE_WINDOW_MS = 12000;
const SERIALIZED_READINESS_TIMEOUT_MS = 30000;
const SERIALIZED_READINESS_DRAIN_TIMEOUT_MS = 5000;
const PROBE_MIN_GAP_MS = 250;
const PROBE_CHILD_TIMEOUT_MS = 5000;
const BACKOFF_SCHEDULE_MS = [5000, 15000, 45000, 120000, 300000];
const UNKNOWN_STRIKES_LIMIT = 3;
const FORWARD_RECOVERY_FAILURE_LIMIT = 4;

const CLAWD_SERVER_HEADER = "x-clawd-server";
const CLAWD_SERVER_ID = "clawd-on-desk";
const ROUTING_NONCE_HEADER = "x-clawd-routing-nonce";

// ── Detect ssh client ──
//
// Cheap one-shot. Returns
//   { available: true, version: "OpenSSH_9.5p2 ...", parsedVersion: { ... } }
// or { available: false, error: "..." } on failure / not found.

function parseOpenSshVersion(version) {
  const text = (version || "").toString();
  const match = text.match(/OpenSSH(?:_for_Windows)?_(\d+)\.(\d+)(?:p(\d+))?/i);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] == null ? null : Number(match[3]),
  };
}

function isUnsupportedWindowsOpenSsh(sshInfo, platform = process.platform) {
  if (platform !== "win32") return false;
  if (!sshInfo || sshInfo.available !== true) return false;
  const parsed = sshInfo.parsedVersion || parseOpenSshVersion(sshInfo.version);
  return !!parsed && parsed.major < 8;
}

function detectSsh({ spawnSync = childProcess.spawnSync } = {}) {
  try {
    // ssh -V writes to stderr on most OpenSSH builds. spawnSync lets us read
    // both streams even on success, unlike execFileSync's stdout-only return.
    const result = spawnSync("ssh", ["-V"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      windowsHide: true,
    });

    if (result && result.error) {
      const msg = result.error.code === "ENOENT"
        ? "ssh executable not found in PATH"
        : result.error.message || "ssh detect failed";
      return { available: false, error: msg };
    }

    const stdout = result && result.stdout ? result.stdout.toString().trim() : "";
    const stderr = result && result.stderr ? result.stderr.toString().trim() : "";
    const version = stderr || stdout || "(no version banner)";
    const parsedVersion = parseOpenSshVersion(version);
    return { available: true, version, parsedVersion };
  } catch (err) {
    if (err && err.stderr) {
      const stderr = err.stderr.toString().trim();
      // Defensive: unusual spawnSync implementations can throw after producing
      // stderr, while stock Node reports most failures via result.error.
      if (stderr && err.code !== "ENOENT") {
        return { available: true, version: stderr, parsedVersion: parseOpenSshVersion(stderr) };
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
//      backgrounded tunnels / probes / deploys never wedge on a prompt.
//   2. Profile's `-i identityFile` / `-p port` (scp: `-P port`) are always
//      injected, so non-default-port / specified-key profiles work for
//      Deploy, Codex monitor, Authenticate — not just Connect.
//   3. Interactive callers (`interactive: true`) get an empty base via
//      `SSH_INTERACTIVE_BASE_OPTS`, since `-T` breaks remote pty, and
//      `BatchMode=yes` would suppress the very prompts (password,
//      passphrase, host-key confirm) the user opened the terminal to answer.
//
// FIRST-WINS, NOT LAST-WINS. ssh_config(5): "For each parameter, the first
// obtained value will be used." This applies to command-line `-o` too:
// `-o BatchMode=yes -o BatchMode=no` resolves to BatchMode=yes, not no
// (verified with `ssh -G` on OpenSSH 9.5p2 / 10.0p2). Consequence: a future
// `extraOpts` `-o Foo=bar` only wins if Foo is NOT already in the base opt
// list. If you need to override a base opt, change the base or add a
// separate base array — appending in extraOpts is a no-op.
//
// Host is appended last for ssh; scp callers add `host:path` themselves.
function buildSshArgs(profile, { extraOpts = [], interactive = false } = {}) {
  if (!profile || typeof profile.host !== "string" || !profile.host) {
    throw new Error("buildSshArgs: profile.host required");
  }
  if (!Array.isArray(extraOpts)) {
    throw new TypeError("buildSshArgs: extraOpts must be an array");
  }
  const args = interactive
    ? SSH_INTERACTIVE_BASE_OPTS.slice()
    : SSH_BASE_OPTS.slice();
  appendRemoteSshConfigArgs(args);
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
  appendRemoteSshConfigArgs(args);
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
  if (code === 5) return { kind: "permanent", reason: "probe_secure_identity_invalid", hint: "remoteSshErrSecureIdentityMissing" };
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
function buildProbeCommand(remoteForwardPort, nodeBin = "node", options = {}) {
  if (!Number.isInteger(remoteForwardPort)) {
    throw new TypeError("buildProbeCommand: remoteForwardPort must be an integer");
  }
  // Node single-line: header check first (per v7), then status. Embedded
  // double quotes get backslash-escaped so the whole thing fits on a single
  // ssh remote-command argument once forwarded as one shell token.
  const url = `http://127.0.0.1:${remoteForwardPort}/state`;
  const profile = options.profile;
  let securePrefix = "";
  let requestOptions = JSON.stringify(url);
  if (profile && profile.runtimeKey && profile.installId && profile.id) {
    let layout = null;
    try {
      layout = resolveRemoteRuntimeLayout({
        runtimeMode: profile.runtimeMode,
        runtimeKey: profile.runtimeKey,
        remoteHome: profile.remoteHome,
      });
    } catch {}
    if (!layout) {
      securePrefix = "process.exit(5);";
    } else {
      securePrefix =
        `const p=${JSON.stringify(layout.identityFile)};` +
        "let i;try{i=JSON.parse(require('fs').readFileSync(p,'utf8'))}catch{process.exit(5)};" +
        `if(i.version!==2||i.installId!==${JSON.stringify(profile.installId)}||i.profileId!==${JSON.stringify(profile.id)}||i.runtimeKey!==${JSON.stringify(profile.runtimeKey)}||i.layoutVersion!==${JSON.stringify(profile.layoutVersion || 1)}||i.remotePort!==${JSON.stringify(remoteForwardPort)}||!Number.isFinite(i.deployedAt)||i.deployedAt<=0||!/^[a-f0-9]{32}$/.test(i.routingNonce||''))process.exit(5);`;
      requestOptions = `{hostname:'127.0.0.1',port:${remoteForwardPort},path:'/state',headers:{${JSON.stringify(ROUTING_NONCE_HEADER)}:i.routingNonce}}`;
    }
  }
  const js =
    securePrefix +
    `const r=require('http').get(${requestOptions},res=>{` +
      `const m=res.headers[${JSON.stringify(CLAWD_SERVER_HEADER)}]===${JSON.stringify(CLAWD_SERVER_ID)};` +
      `if(!m)process.exit(3);` +
      `process.exit(res.statusCode===200?0:1);` +
    `});` +
    `r.on('error',()=>process.exit(2));` +
    `r.setTimeout(2000,()=>{r.destroy();process.exit(4);});`;
  if (nodeBin === "node") {
    // The PATH fallback must work under both POSIX shells and Windows cmd.exe.
    // A JSON/double-quoted raw program still expands $, $(), and backticks on
    // POSIX; POSIX single quotes in turn are not argument quotes under cmd.
    // Base64 keeps the remote-owned identity path opaque to either shell.
    const encoded = Buffer.from(js, "utf8").toString("base64");
    const loader = `eval(Buffer.from('${encoded}','base64').toString('utf8'))`;
    return `node -e ${JSON.stringify(loader)}`;
  }
  return buildRemoteNodeEvalCommand(nodeBin, js);
}

function buildPersistentReadinessCommand(remoteForwardPort, nodeBin, options = {}) {
  if (!Number.isInteger(remoteForwardPort)) {
    throw new TypeError("buildPersistentReadinessCommand: remoteForwardPort must be an integer");
  }
  if (typeof options.challenge !== "string" || !/^[a-f0-9]{32}$/.test(options.challenge)) {
    throw new TypeError("buildPersistentReadinessCommand: 128-bit lowercase hex challenge required");
  }
  const profile = options.profile;
  let layout;
  try {
    layout = resolveRemoteRuntimeLayout({
      runtimeMode: profile && profile.runtimeMode,
      runtimeKey: profile && profile.runtimeKey,
      remoteHome: profile && profile.remoteHome,
    });
  } catch {
    layout = null;
  }
  const marker = `__CLAWD_REMOTE_READY__:${options.challenge}`;
  const windowMs = Number.isFinite(options.probeWindowMs)
    ? Math.max(1000, Math.min(60000, Math.trunc(options.probeWindowMs)))
    : PROBE_WINDOW_MS;
  const identityGuard = layout
    ? [
        `const p=${JSON.stringify(layout.identityFile)};`,
        "let i;try{i=JSON.parse(fs.readFileSync(p,'utf8'))}catch{process.exit(5)};",
        `if(i.version!==2||i.installId!==${JSON.stringify(profile.installId)}||i.profileId!==${JSON.stringify(profile.id)}||i.runtimeKey!==${JSON.stringify(profile.runtimeKey)}||i.layoutVersion!==${JSON.stringify(profile.layoutVersion || 1)}||i.remotePort!==${JSON.stringify(remoteForwardPort)}||!Number.isFinite(i.deployedAt)||i.deployedAt<=0||!/^[a-f0-9]{32}$/.test(i.routingNonce||''))process.exit(5);`,
      ].join("")
    : "process.exit(5);";
  const requestOptions = `{hostname:'127.0.0.1',port:${remoteForwardPort},path:'/state',headers:{${JSON.stringify(ROUTING_NONCE_HEADER)}:i.routingNonce}}`;
  const js = [
    "const fs=require('fs'),http=require('http');",
    identityGuard,
    `const marker=${JSON.stringify(marker)},deadline=Date.now()+${windowMs};`,
    "let stopped=false,ready=false,request=null,retryTimer=null,holdTimer=null,lastExit=2,attemptDone=false;",
    "function stop(){if(stopped)return;stopped=true;if(retryTimer)clearTimeout(retryTimer);if(holdTimer)clearInterval(holdTimer);if(request)request.destroy();process.exit(0)}",
    "process.stdin.resume();process.stdin.once('end',stop);process.stdin.once('error',stop);",
    "function retry(code){if(attemptDone)return;attemptDone=true;lastExit=code;if(stopped)return;if(Date.now()>=deadline)process.exit(lastExit);retryTimer=setTimeout(attempt,250)}",
    "function attempt(){if(stopped||ready)return;attemptDone=false;",
    `request=http.get(${requestOptions},res=>{res.resume();const good=res.headers[${JSON.stringify(CLAWD_SERVER_HEADER)}]===${JSON.stringify(CLAWD_SERVER_ID)};if(!good)process.exit(3);if(res.statusCode!==200)process.exit(1);ready=true;process.stdout.write(marker+'\\n');holdTimer=setInterval(()=>{},60000)});`,
    "request.once('error',()=>retry(2));request.setTimeout(2000,()=>{request.destroy();retry(4)})}",
    "attempt();",
  ].join("");
  return buildRemoteNodeEvalCommand(nodeBin, js);
}

// ── Backoff helper ──
function backoffMsForAttempt(attempt) {
  if (!Number.isInteger(attempt) || attempt < 0) return BACKOFF_SCHEDULE_MS[0];
  const idx = Math.min(attempt, BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[idx];
}

function tunnelTargetKey(profile) {
  return JSON.stringify({
    profileId: profile && profile.id || "",
    host: profile && profile.host || "",
    port: Number.isInteger(profile && profile.port) ? profile.port : 22,
    identityFile: profile && profile.identityFile || "",
    remoteForwardPort: Number.isInteger(profile && profile.remoteForwardPort)
      ? profile.remoteForwardPort
      : null,
    installId: profile && profile.installId || "",
    runtimeMode: profile && profile.runtimeMode || "account-default",
    runtimeKey: profile && profile.runtimeKey || "account-default",
    layoutVersion: Number.isInteger(profile && profile.layoutVersion)
      ? profile.layoutVersion
      : 1,
  });
}

function checkSecureConnectReadiness(profile) {
  const failure = (detail) => ({
    ok: false,
    kind: "permanent",
    reason: "deployment_required",
    detail,
    hint: "remoteSshErrDeploymentRequired",
    message: "Remote SSH hooks are not deployed for this target. Deploy or repair hooks before connecting.",
  });
  if (!Number.isFinite(profile && profile.lastDeployedAt) || profile.lastDeployedAt <= 0) {
    return failure("deployment_stamp_missing");
  }
  try {
    resolveRemoteRuntimeLayout({
      runtimeMode: profile && profile.runtimeMode,
      runtimeKey: profile && profile.runtimeKey,
      remoteHome: profile && profile.remoteHome,
    });
  } catch {
    return failure("secure_layout_missing");
  }
  if (!acceptedRoutingNonces(profile).length) {
    return failure("secure_identity_missing");
  }
  return { ok: true };
}

// ── Runtime factory ──

function createRemoteSshRuntime(deps = {}) {
  const spawn = deps.spawn || childProcess.spawn;
  const transportCoordinator = deps.transportCoordinator || null;
  const getHookServerPort = deps.getHookServerPort;
  const createProfileIngress = deps.createProfileIngress;
  const log = deps.log || (() => {});
  const setTimeoutFn = deps.setTimeout || setTimeout;
  const clearTimeoutFn = deps.clearTimeout || clearTimeout;
  const serializedReadinessTimeoutMs = Number.isFinite(deps.serializedReadinessTimeoutMs)
    ? deps.serializedReadinessTimeoutMs
    : SERIALIZED_READINESS_TIMEOUT_MS;
  const serializedReadinessDrainTimeoutMs = Number.isFinite(deps.serializedReadinessDrainTimeoutMs)
    ? deps.serializedReadinessDrainTimeoutMs
    : SERIALIZED_READINESS_DRAIN_TIMEOUT_MS;
  const resolveRemoteNode = deps.resolveRemoteNodeBin || resolveRemoteNodeBin;
  const detectSshClient = deps.detectSsh || (() => detectSsh());
  const platform = deps.platform || process.platform;
  let sshDetectionCache = null;

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
      hint: null,
      lastError: null,
      lastErrorReason: null,
      sshChild: null,
      ingress: null,
      ingressStartGeneration: 0,
      connectionGeneration: 0,
      // Accumulated raw stderr bytes — decoded once on read so a GBK/CP936
      // remote (Windows cmd, zh-locale Linux) doesn't show up as mojibake.
      stderrBuf: Buffer.alloc(0),
      stderrTruncated: false,
      probeChild: null,
      probeInFlight: false,
      probeStartedAt: 0,
      probeWindowDeadline: 0,
      probeIntervalTimer: null,
      probeWindowTimer: null,
      probeChildTimer: null,
      remoteNodeBin: null,
      remoteNodeSource: null,
      allowBareNodeProbe: false,
      remoteNodeResolveInFlight: false,
      // Set to "windows-cmd" the first time the resolver fails with the
      // "is not recognized" stderr pattern. Acts as a one-shot negative
      // cache for the background resolver and any future resolver retry
      // call site, so we don't spam the user with the same expected
      // failure every time the tunnel reconnects.
      remoteShell: null,
      remoteShellTarget: null,
      backoffTimer: null,
      retryAttempt: 0,
      unknownStrikes: 0,
      healthyTunnelTargetKey: null,
      recoveryTargetKey: null,
      forwardRecoveryFailures: 0,
      stopped: false,
      serializedTransport: false,
      transportInspection: null,
      transportContext: null,
      prepareSerializedAttempt: null,
      cancelSerializedAttempt: null,
      serializedPreparationPending: false,
      serializedConnectInFlight: null,
      readinessChallenge: null,
      readinessLineBuffer: "",
      readinessTimer: null,
      sshExitCode: null,
      sshExitSignal: null,
      intentionalClose: false,
      releaseTransportOnClose: false,
    };
  }

  function setStatus(state, status, extra = {}) {
    state.status = status;
    if ("message" in extra) state.message = extra.message;
    if ("hint" in extra) state.hint = extra.hint;
    if ("lastError" in extra) state.lastError = extra.lastError;
    if ("lastErrorReason" in extra) state.lastErrorReason = extra.lastErrorReason;
    emitStatus(state);
  }

  function emitStatus(state) {
    emitter.emit("status-changed", snapshotState(state));
  }

  function snapshotState(state) {
    const ingressStatus = state.ingress && typeof state.ingress.getStatus === "function"
      ? state.ingress.getStatus()
      : null;
    const transport = transportCoordinator
      && typeof transportCoordinator.snapshotForProfile === "function"
      ? transportCoordinator.snapshotForProfile(state.profile.id)
      : null;
    const transportFailed = transport && (transport.transportPhase === "failed"
      || transport.transportPhase === "quarantined");
    const transportFailureReason = transport
      && (transport.transportRecoveryCode || transport.transportErrorReason);
    const transportFailureMessage = "Remote SSH transport requires explicit recovery";
    return {
      profileId: state.profile.id,
      status: transportFailed ? "failed" : state.status,
      message: transportFailed ? transportFailureMessage : state.message,
      hint: state.hint,
      lastError: transportFailed ? transportFailureMessage : state.lastError,
      lastErrorReason: transportFailed
        ? (transportFailureReason || "transport_drain_timeout")
        : state.lastErrorReason,
      retryAttempt: state.retryAttempt,
      forwardRecoveryFailures: state.forwardRecoveryFailures,
      ...(transport ? transport : {}),
      ...(ingressStatus ? {
        ingressPort: ingressStatus.port,
        ingressRejectedCount: ingressStatus.rejectedCount,
      } : {}),
    };
  }

  function getProfileStatus(profileId) {
    const state = states.get(profileId);
    if (!state) {
      const transport = transportCoordinator
        && typeof transportCoordinator.snapshotForProfile === "function"
        ? transportCoordinator.snapshotForProfile(profileId)
        : null;
      return noStateTransportSnapshot(profileId, transport);
    }
    return snapshotState(state);
  }

  function noStateTransportSnapshot(profileId, transport) {
    const failed = transport && (transport.transportPhase === "failed"
      || transport.transportPhase === "quarantined");
    const reason = transport && (transport.transportRecoveryCode || transport.transportErrorReason);
    return {
      profileId,
      status: failed ? "failed" : "idle",
      message: failed
        ? "Remote SSH transport requires explicit recovery"
        : (transport && transport.transportPhase !== "idle"
          ? `Remote SSH ${transport.transportOperation || "operation"} is active`
          : null),
      hint: null,
      lastError: failed ? "Remote SSH transport requires explicit recovery" : null,
      lastErrorReason: failed ? (reason || "transport_drain_timeout") : null,
      ...(transport ? transport : {}),
    };
  }

  function listStatuses() {
    const out = [];
    const known = new Set();
    for (const state of states.values()) {
      known.add(state.profile.id);
      out.push(snapshotState(state));
    }
    if (transportCoordinator && typeof transportCoordinator.listSnapshots === "function") {
      for (const transport of transportCoordinator.listSnapshots()) {
        if (!transport || typeof transport.profileId !== "string" || known.has(transport.profileId)) continue;
        out.push(noStateTransportSnapshot(transport.profileId, transport));
      }
    }
    return out;
  }

  const unsubscribeCoordinatorStatus = transportCoordinator
    && typeof transportCoordinator.onStatusChanged === "function"
    ? transportCoordinator.onStatusChanged((transport) => {
        if (!transport || typeof transport.profileId !== "string") return;
        const state = states.get(transport.profileId);
        emitter.emit(
          "status-changed",
          state ? snapshotState(state) : noStateTransportSnapshot(transport.profileId, transport),
        );
      })
    : () => {};

  function refreshProfile(profile) {
    if (!profile || !profile.id) throw new Error("refreshProfile: profile.id required");
    const state = states.get(profile.id);
    if (!state) return false;
    const nextProfile = {
      ...profile,
      ...(state.profile && state.profile.installId && !profile.installId
        ? { installId: state.profile.installId }
        : {}),
    };
    const targetChanged = tunnelTargetKey(state.profile) !== tunnelTargetKey(nextProfile);
    if (targetChanged && state.serializedTransport
      && (state.sshChild || state.status === "connecting" || state.status === "connected"
        || state.status === "reconnecting")) {
      // A managed child is permanently bound to the immutable target used at
      // admission. Settings prevents this edit in the normal UI; keep this
      // runtime guard for stale IPC/settings races.
      state.message = "Disconnect before changing SSH transport fields.";
      state.hint = "remoteSshErrProfileChanged";
      emitStatus(state);
      return false;
    }
    state.profile = nextProfile;
    if (targetChanged) {
      resetRecoveryContext(state);
      clearRemoteShellCache(state);
    }
    emitStatus(state);
    return true;
  }

  // ── Connect ──

  function connect(profile, options = {}) {
    if (!profile || !profile.id) throw new Error("connect: profile.id required");
    let state = states.get(profile.id);
    let retainedSerializedInspection = null;
    if (state) {
      retainedSerializedInspection = state.serializedTransport
        ? state.transportInspection
        : null;
      const targetChanged = tunnelTargetKey(state.profile) !== tunnelTargetKey(profile);
      // Replace profile snapshot — caller may have just edited fields.
      state.profile = profile;
      if (targetChanged) {
        clearRemoteShellCache(state);
        resetRecoveryContext(state);
      }
      // If already connecting / connected, no-op (idempotent).
      if (state.stopped !== true
          && (state.status === "connecting" || state.status === "connected"
          || state.status === "reconnecting")) {
        return snapshotState(state);
      }
      // Reset retry counters on a user-initiated re-connect.
      state.retryAttempt = 0;
      state.unknownStrikes = 0;
      state.stopped = false;
      resetRecoveryContext(state);
      clearRemoteShellCache(state);
    } else {
      state = newState(profile);
      states.set(profile.id, state);
    }
    if (options.serialized === true) {
      if (!options.transportContext || typeof options.transportContext.spawn !== "function") {
        throw new Error("connect: serialized transport context required");
      }
      state.serializedTransport = true;
      state.transportInspection = options.transportInspection || retainedSerializedInspection || null;
      state.transportContext = options.transportContext;
      state.prepareSerializedAttempt = typeof options.prepareSerializedAttempt === "function"
        ? options.prepareSerializedAttempt
        : null;
      state.cancelSerializedAttempt = typeof options.cancelSerializedAttempt === "function"
        ? options.cancelSerializedAttempt
        : null;
      state.serializedPreparationPending = !!state.prepareSerializedAttempt;
      if (options.remoteNode && options.remoteNode.nodeBin) {
        state.remoteNodeBin = options.remoteNode.nodeBin;
        state.remoteNodeSource = options.remoteNode.source || null;
      }
    } else {
      state.serializedTransport = false;
      state.transportInspection = options.transportInspection || null;
      state.transportContext = null;
      state.prepareSerializedAttempt = null;
      state.cancelSerializedAttempt = null;
      state.serializedPreparationPending = false;
    }
    state.connectionGeneration += 1;
    // A manual Connect is the user's chance to recover after installing or
    // upgrading ssh.exe. Keep detection cached only within automatic retries.
    sshDetectionCache = null;
    startConnect(state);
    return snapshotState(state);
  }

  function startConnect(state) {
    if (state.stopped) return;
    state.remoteNodeResolveInFlight = false;
    setStatus(state, state.status === "reconnecting" ? "reconnecting" : "connecting", {
      message: null,
      hint: null,
      lastError: null,
      lastErrorReason: null,
    });

    if (typeof createProfileIngress === "function") {
      if (state.profile.runtimeMode === "profile-isolated"
        && state.profile.isolatedActive !== true) {
        finishFailure(state, {
          kind: "permanent",
          reason: "isolated_runtime_inactive",
          hint: "remoteSshErrIsolatedInactive",
          message: "This isolated runtime is not active; run each CLI through its profile wrapper and repair the deployment.",
        });
        return;
      }
      const readiness = checkSecureConnectReadiness(state.profile);
      if (!readiness.ok) {
        finishFailure(state, readiness);
        return;
      }
    }

    const sshPreflight = getSshPreflightFailure();
    if (sshPreflight) {
      finishFailure(state, sshPreflight);
      return;
    }

    if (state.serializedTransport) {
      startSerializedConnect(state);
      return;
    }

    if (typeof createProfileIngress === "function") {
      ensureProfileIngress(state);
      return;
    }

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

    spawnTunnel(state, localPort);
  }

  function managedRuntimeForState(state, context = state.transportContext) {
    // Bind every operation helper to the lease that created it. A later
    // Disconnect/Deploy takeover may replace state.transportContext, but an
    // older Node/monitor continuation must never spawn through or mutate the
    // replacement lease.
    const boundContext = context;
    return {
      emit: (event, payload) => emitter.emit(event, payload),
      spawnManagedTransportChild: (spec) => boundContext.spawn({
        ...spec,
        attemptToken: boundContext.attemptToken,
      }),
      assertTransportActive: () => boundContext.assertActive(),
      invalidateManagedOperation: (err) => {
        try {
          const recoveryCode = boundContext.getRecoveryCode();
          if (recoveryCode && err && typeof err === "object") err.recoveryCode = recoveryCode;
        } catch {}
        if (transportCoordinator && typeof transportCoordinator.invalidate === "function") {
          transportCoordinator.invalidate(boundContext, (err && err.code) || "transport_drain_timeout");
        }
      },
      settleManagedTimeoutAfterClose: (err) => {
        if (!transportCoordinator || typeof transportCoordinator.abortAfterVerifiedClose !== "function") return;
        try {
          const outcome = transportCoordinator.abortAfterVerifiedClose(
            boundContext,
            (err && err.code) || "operation_timeout",
          );
          if (outcome && outcome.recoveryCode && err && typeof err === "object") {
            err.recoveryCode = outcome.recoveryCode;
          }
        } catch {}
      },
      setManagedLockStage: (stage) => boundContext.setLockStage(stage),
    };
  }

  async function serializedTargetStillMatches(state, context) {
    if (!transportCoordinator || typeof transportCoordinator.inspect !== "function") return true;
    const inspected = await transportCoordinator.inspect(state.profile);
    context.assertActive();
    return !!inspected
      && inspected.mode === "serialized"
      && inspected.key === context.transportKey
      && inspected.stickyFallback !== true
      && inspected.historicalHintFallback !== true;
  }

  async function ordinaryTargetStillMatches(state) {
    if (!transportCoordinator || typeof transportCoordinator.inspect !== "function"
      || !state.transportInspection) return true;
    const inspected = await transportCoordinator.inspect(state.profile);
    const original = state.transportInspection;
    return !!inspected
      && original.mode === "parallel"
      && inspected.mode === "parallel"
      && inspected.key === original.key
      && inspected.effectiveHost === original.effectiveHost
      && inspected.effectiveUser === original.effectiveUser
      && inspected.effectivePort === original.effectivePort
      && inspected.stickyFallback !== true
      && inspected.historicalHintFallback !== true;
  }

  function failSerializedTargetDrift(state, message) {
    finishFailure(state, {
      reason: "profile_changed",
      hint: "remoteSshErrProfileChanged",
      message,
    });
  }

  async function startSerializedConnect(state) {
    if (state.stopped) return;
    const context = state.transportContext;
    if (!context) return;
    const generation = state.connectionGeneration;
    const existingTask = state.serializedConnectInFlight;
    if (existingTask && existingTask.generation === generation && existingTask.context === context) return;
    const task = { generation, context };
    state.serializedConnectInFlight = task;
    const isCurrent = () => !state.stopped
      && state.connectionGeneration === generation
      && state.transportContext === context
      && state.serializedConnectInFlight === task;
    const assertCurrent = () => {
      if (isCurrent()) return;
      throw Object.assign(new Error("Serialized SSH connection attempt is stale"), {
        code: "transport_attempt_stale",
      });
    };
    try {
      assertCurrent();
      context.assertActive();
      if (!await serializedTargetStillMatches(state, context)) {
        assertCurrent();
        failSerializedTargetDrift(
          state,
          "The effective SSH transport changed; Disconnect and Connect again.",
        );
        return;
      }
      context.nextAttempt();
      const managedRuntime = managedRuntimeForState(state, context);
      const resolved = await resolveRemoteNode({
        profile: state.profile,
        spawn,
        buildSshArgs,
        runtime: managedRuntime,
        useCache: true,
        verifyCache: true,
      });
      assertCurrent();
      context.assertActive();
      if (!resolved || resolved.ok !== true || !resolved.nodeBin) {
        const cls = classifyStderr((resolved && resolved.stderr) || "");
        finishFailure(state, {
          reason: cls.reason || "probe_node_missing",
          hint: cls.hint || "remoteSshProbeNodeMissing",
          message: (resolved && resolved.message) || "Remote Node.js not found.",
        });
        return;
      }
      state.remoteNodeBin = resolved.nodeBin;
      state.remoteNodeSource = resolved.source || null;
      state.allowBareNodeProbe = false;
      emitRemoteNodeDetected(state, resolved);

      // Node resolution is read-only, but monitor preparation mutates remote
      // state. Re-inspect after the await boundary before allowing it to use
      // the reservation captured for the original effective target.
      if (!await serializedTargetStillMatches(state, context)) {
        assertCurrent();
        failSerializedTargetDrift(
          state,
          "The effective SSH transport changed before monitor preparation; Connect again.",
        );
        return;
      }

      if (state.serializedPreparationPending && state.prepareSerializedAttempt) {
        assertCurrent();
        const prepare = state.prepareSerializedAttempt;
        state.serializedPreparationPending = false;
        state.prepareSerializedAttempt = null;
        const prepared = await prepare({
          profile: state.profile,
          remoteNode: resolved,
          runtime: managedRuntime,
          transportContext: context,
        });
        assertCurrent();
        context.assertActive();
        if (prepared && prepared.ok === false) {
          log("remote-ssh: serialized monitor preparation warning:", redactTransportDiagnostic(
            prepared.stderr || prepared.message || prepared.reason,
            state.profile,
          ));
        }
      }

      // The monitor operation can itself take time. Verify once more before a
      // disconnect cleanup mutation or the persistent tunnel is started.
      if (!await serializedTargetStillMatches(state, context)) {
        assertCurrent();
        failSerializedTargetDrift(
          state,
          "The effective SSH transport changed during connection preparation; Connect again.",
        );
        return;
      }

      if (transportCoordinator && typeof transportCoordinator.getIntent === "function"
        && transportCoordinator.getIntent(state.profile.id).desiredConnected === false) {
        assertCurrent();
        if (state.cancelSerializedAttempt) {
          const cancelled = await state.cancelSerializedAttempt({
            profile: state.profile,
            remoteNode: resolved,
            runtime: managedRuntime,
            transportContext: context,
          });
          assertCurrent();
          context.assertActive();
          if (cancelled && cancelled.ok === false) {
            log("remote-ssh: serialized disconnect preparation warning:", redactTransportDiagnostic(
              cancelled.stderr || cancelled.message || cancelled.reason,
              state.profile,
            ));
          }
        }
        state.stopped = true;
        closeProfileIngress(state);
        resetRecoveryContext(state);
        setStatus(state, "idle", {
          message: null,
          hint: null,
          lastError: null,
          lastErrorReason: null,
        });
        releaseSerializedContextIfIdle(state);
        return;
      }

      if (typeof createProfileIngress === "function") {
        assertCurrent();
        ensureProfileIngress(state);
        return;
      }
      const localPort = getHookServerPort();
      if (!Number.isInteger(localPort)) throw new Error("Local server port unavailable");
      assertCurrent();
      spawnTunnel(state, localPort);
    } catch (err) {
      if (!isCurrent()) return;
      finishFailure(state, {
        reason: (err && err.code) || "serialized_prepare_failed",
        hint: err && err.hint || null,
        message: (err && err.message) || "Serialized SSH preparation failed",
      });
    } finally {
      if (state.serializedConnectInFlight === task) state.serializedConnectInFlight = null;
    }
  }

  function ensureProfileIngress(state) {
    const generation = ++state.ingressStartGeneration;
    if (!state.ingress) {
      try {
        state.ingress = createProfileIngress({
          remoteProfile: {
            profileId: state.profile.id,
            displayHost: state.profile.label || state.profile.host,
          },
          getAcceptedNonces: () => acceptedRoutingNonces(state.profile),
        });
      } catch (err) {
        finishFailure(state, {
          kind: "permanent",
          reason: "ingress_create_failed",
          hint: "remoteSshErrNoLocalPort",
          message: (err && err.message) || "Failed to create secure Remote SSH ingress",
        });
        return;
      }
    }
    Promise.resolve(state.ingress.start()).then((localPort) => {
      if (state.stopped || state.ingressStartGeneration !== generation) return;
      if (!Number.isInteger(localPort)) {
        throw new Error("Secure Remote SSH ingress did not bind a local port");
      }
      spawnTunnel(state, localPort);
    }).catch((err) => {
      if (state.stopped || state.ingressStartGeneration !== generation) return;
      finishFailure(state, {
        kind: "permanent",
        reason: "ingress_listen_failed",
        hint: "remoteSshErrNoLocalPort",
        message: (err && err.message) || "Secure Remote SSH ingress failed to listen",
      });
    });
  }

  function spawnTunnel(state, localPort) {
    if (state.stopped) return;
    const profile = state.profile;
    const forwardOpt = `127.0.0.1:${profile.remoteForwardPort}:127.0.0.1:${localPort}`;
    const extraOpts = [
      "-R", forwardOpt,
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
    ];
    if (state.serializedTransport
      && state.transportInspection
      && state.transportInspection.kind === "codespaces-stdio") {
      // Win32 OpenSSH can exit 255 with empty stderr when a Codespaces
      // ProxyCommand rejects the remote forward. DEBUG1 is the first level
      // that reliably carries the forward-failure record through
      // `gh cs ssh --stdio`, which lets classifyStderr surface the permanent
      // conflict instead of entering a blind reconnect loop. The captured
      // buffer remains bounded/redacted by the existing stderr path.
      extraOpts.unshift("-v");
    } else if (!state.serializedTransport) {
      extraOpts.unshift("-N");
    }
    let args = buildSshArgs(profile, { extraOpts });
    if (state.serializedTransport) {
      state.readinessChallenge = crypto.randomBytes(16).toString("hex");
      state.readinessLineBuffer = "";
      args = args.concat([buildPersistentReadinessCommand(
        profile.remoteForwardPort,
        state.remoteNodeBin,
        { profile, challenge: state.readinessChallenge },
      )]);
    }

    let child;
    const childOptions = {
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
      stdio: [state.serializedTransport ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    };
    try {
      child = state.serializedTransport
        ? state.transportContext.spawn({
            attemptToken: state.transportContext.attemptToken,
            role: "persistent-tunnel-readiness",
            tool: "ssh",
            args,
            options: childOptions,
          })
        : spawn("ssh", args, childOptions);
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
    state.stderrBuf = Buffer.alloc(0);
    state.stderrTruncated = false;
    state.sshExitCode = null;
    state.sshExitSignal = null;
    state.intentionalClose = false;
    clearSerializedReadinessTimer(state);

    // All handlers below identity-gate against `child` (closure-captured) so
    // a stale exit/error from a previous Disconnect→Connect cycle can't
    // corrupt the current child's state. Pattern: rapid Disconnect (kills A)
    // immediately followed by Connect (spawns B) leaves A's exit pending;
    // when it fires, the closure still references the runtime state which
    // now points at B, so without identity check A's handler would null out
    // sshChild → orphan B and trigger a reconnect using A's stderr.
    child.on("error", (err) => {
      if (state.sshChild !== child) return;
      if (state.serializedTransport) {
        state.lastError = (err && err.message) || "ssh process error";
        state.lastErrorReason = err && err.code === "ENOENT" ? "ssh_missing" : "spawn_failed";
        return;
      }
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
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        state.stderrBuf = state.stderrBuf.length === 0
          ? buf
          : Buffer.concat([state.stderrBuf, buf]);
        // Cap buffer at 8KB to avoid unbounded growth on noisy hosts.
        if (state.stderrBuf.length > 8192) {
          state.stderrTruncated = true;
          state.stderrBuf = state.stderrBuf.slice(-8192);
        }
      });
    }

    if (state.serializedTransport && child.stdout) {
      child.stdout.on("data", (chunk) => onSerializedTunnelStdout(state, child, chunk));
    }

    child.on("exit", (code, signal) => {
      if (state.serializedTransport) {
        if (state.sshChild !== child) return;
        state.sshExitCode = code;
        state.sshExitSignal = signal;
        return;
      }
      onSshExit(state, child, code, signal);
    });

    if (state.serializedTransport) {
      child.on("close", (code, signal) => {
        clearSerializedReadinessTimer(state);
        if (state.sshChild !== child) return;
        onSshExit(
          state,
          child,
          state.sshExitCode === null ? code : state.sshExitCode,
          state.sshExitSignal === null ? signal : state.sshExitSignal,
        );
      });
      state.readinessTimer = setTimeoutFn(() => {
        state.readinessTimer = null;
        if (state.sshChild !== child || state.status === "connected" || state.stopped) return;
        const context = state.transportContext;
        const connectionGeneration = state.connectionGeneration;
        const timeoutStillOwnsState = () => state.connectionGeneration === connectionGeneration
          && state.transportContext === context;
        state.stopped = true;
        state.intentionalClose = true;
        state.releaseTransportOnClose = false;
        closeProfileIngress(state);
        Promise.resolve().then(async () => {
          if (!transportCoordinator || !context) {
            if (child.stdin) {
              try { child.stdin.end(); } catch {}
            }
            throw Object.assign(new Error("Serialized readiness exceeded its local deadline"), {
              code: "readiness_timeout",
            });
          }
          await transportCoordinator.waitForDrain(context, (owned, metadata) => {
            if (metadata && metadata.role === "persistent-tunnel-readiness" && owned.stdin) {
              try { owned.stdin.end(); } catch {}
            }
          }, serializedReadinessDrainTimeoutMs);
          if (!timeoutStillOwnsState()) return;
          transportCoordinator.abortAfterVerifiedClose(context, "readiness_timeout");
          if (!timeoutStillOwnsState()) return;
          state.transportContext = null;
          setStatus(state, "failed", {
            message: "Remote SSH readiness exceeded its local deadline",
            hint: "remoteSshProbeUnresponsive",
            lastError: "Remote SSH readiness exceeded its local deadline",
            lastErrorReason: "readiness_timeout",
          });
        }).catch((err) => {
          if (!timeoutStillOwnsState()) return;
          state.transportContext = null;
          setStatus(state, "failed", {
            message: (err && err.message) || "Remote SSH readiness did not drain",
            hint: "remoteSshProbeUnresponsive",
            lastError: (err && err.message) || "Remote SSH readiness did not drain",
            lastErrorReason: (err && (err.recoveryCode || err.code)) || "transport_drain_timeout",
          });
        });
      }, serializedReadinessTimeoutMs);
      return;
    }

    startProbeLoopWithRemoteNode(state, child);
  }

  function onSerializedTunnelStdout(state, child, chunk) {
    if (state.sshChild !== child || state.status === "connected") return;
    state.readinessLineBuffer += decodeShellBytes(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    if (state.readinessLineBuffer.length > 8192) {
      state.readinessLineBuffer = state.readinessLineBuffer.slice(-8192);
    }
    const lines = state.readinessLineBuffer.split(/\r?\n/);
    state.readinessLineBuffer = lines.pop() || "";
    const expected = `__CLAWD_REMOTE_READY__:${state.readinessChallenge}`;
    if (!lines.some((line) => line === expected)) return;
    if (state.sshChild !== child || state.stopped) return;
    clearSerializedReadinessTimer(state);
    state.retryAttempt = 0;
    state.unknownStrikes = 0;
    state.healthyTunnelTargetKey = tunnelTargetKey(state.profile);
    resetRecoveryContext(state, { clearHealthy: false });
    if (transportCoordinator && typeof transportCoordinator.setPhase === "function") {
      try { transportCoordinator.setPhase(state.transportContext, "tunnel"); } catch {}
    }
    setStatus(state, "connected", {
      message: null,
      hint: null,
      lastError: null,
      lastErrorReason: null,
    });
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

  function remoteShellCacheKey(profile) {
    return JSON.stringify({
      host: profile && profile.host || "",
      port: Number.isInteger(profile && profile.port) ? profile.port : 22,
      identityFile: profile && profile.identityFile || "",
    });
  }

  function clearRemoteShellCache(state) {
    if (!state) return;
    state.remoteShell = null;
    state.remoteShellTarget = null;
  }

  function resetRecoveryContext(state, { clearHealthy = true } = {}) {
    if (!state) return;
    state.recoveryTargetKey = null;
    state.forwardRecoveryFailures = 0;
    if (clearHealthy) state.healthyTunnelTargetKey = null;
  }

  function markRemoteShell(state, shell, target) {
    state.remoteShell = shell;
    state.remoteShellTarget = target || remoteShellCacheKey(state.profile);
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

  function getSshDetection() {
    if (sshDetectionCache) return sshDetectionCache;
    try {
      sshDetectionCache = detectSshClient() || { available: false, error: "ssh detect failed" };
    } catch (err) {
      sshDetectionCache = {
        available: false,
        error: (err && err.message) || "ssh detect failed",
      };
    }
    return sshDetectionCache;
  }

  function getSshPreflightFailure() {
    const info = getSshDetection();
    if (isUnsupportedWindowsOpenSsh(info, platform)) {
      const version = info.version || "OpenSSH 7.x";
      return {
        kind: "permanent",
        reason: "windows_openssh_legacy",
        hint: "remoteSshErrWindowsOpenSshLegacy",
        message: `${version} has a broken ConnectTimeout implementation on Windows. Upgrade Windows OpenSSH to 8.x or newer.`,
      };
    }
    return null;
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
    const shellTarget = remoteShellCacheKey(state.profile);
    // One-shot negative cache: once we've seen this remote reject `sh`,
    // every later resolver call is guaranteed to fail the same way.
    // Stay on bare-node-probe mode and don't bother (or spam log).
    if (state.remoteShell === "windows-cmd") {
      if (state.remoteShellTarget === shellTarget) return;
      clearRemoteShellCache(state);
    }
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
            message: stderrSummary(resolved.stderr, state.profile) || (resolved && resolved.message) || "Remote SSH failed.",
          });
          return;
        }
        if (state.status === "connected") {
          // Stay connected — bare `node` health probe is already keeping
          // the tunnel green. Only log this once-per-host: if the stderr
          // is the Windows-cmd "is not recognized" pattern, flip the
          // one-shot cache so we don't repeat this every reconnect.
          if (looksLikeWindowsCmdStderr(resolved && resolved.stderr)) {
            markRemoteShell(state, "windows-cmd", shellTarget);
          } else {
            log("remote-ssh: remote Node resolver failed after probe success:", resolved && resolved.message);
          }
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
          message: stderrSummary(err.stderr, state.profile) || (err && err.message) || "Remote SSH failed.",
        });
        return;
      }
      if (state.status === "connected") {
        // Same one-shot suppression as finish(): if the throw came from
        // a Windows-cmd remote rejecting `sh`, flip the cache silently.
        if (looksLikeWindowsCmdStderr(err && err.stderr)) {
          markRemoteShell(state, "windows-cmd", shellTarget);
        } else {
          log("remote-ssh: remote Node resolver threw after probe success:", err && err.message);
        }
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
      if (state.serializedTransport && state.releaseTransportOnClose) {
        releaseSerializedContextIfIdle(state);
      }
      if (state.serializedTransport && transportCoordinator
        && typeof transportCoordinator.snapshotForProfile === "function") {
        const transport = transportCoordinator.snapshotForProfile(state.profile.id);
        if (transport.transportPhase === "idle" && state.status !== "idle") {
          setStatus(state, "idle", {
            message: null,
            hint: null,
            lastError: null,
            lastErrorReason: null,
          });
        } else if ((transport.transportPhase === "failed"
          || transport.transportPhase === "quarantined") && state.status !== "failed") {
          setStatus(state, "failed", {
            message: "Remote SSH transport requires explicit recovery",
            hint: null,
            lastError: "Remote SSH transport requires explicit recovery",
            lastErrorReason: transport.transportPhase === "failed"
              ? "manual_lock_inspection_required"
              : "transport_drain_timeout",
          });
        }
      }
      return;
    }

    // We exit here for one of three reasons:
    //   (a) connect attempt failed before probe succeeded
    //   (b) connected → ssh died (ServerAlive timed out, network drop)
    //   (c) immediate failure (ENOENT-by-other-means caught here)
    const stderr = decodeShellBytes(state.stderrBuf);
    const cls = classifyStderr(stderr);
    const safeStderr = stderrSummary(stderr, state.profile, {
      dropPartialFirstLine: state.stderrTruncated,
    });
    const wasConnected = state.status === "connected";
    const serializedExitCode = state.serializedTransport && !wasConnected
      ? signalToExitCode(code, signal)
      : null;
    let readinessCls = serializedExitCode == null ? null : classifyProbeExit(serializedExitCode);
    if (readinessCls && readinessCls.kind === "ok") {
      readinessCls = {
        kind: "permanent",
        reason: "readiness_marker_missing",
        hint: "remoteSshProbeUnresponsive",
      };
    }
    if (serializedExitCode === 126 || serializedExitCode === 127) {
      clearCachedRemoteNodeBin(state.profile);
      state.remoteNodeBin = null;
      state.remoteNodeSource = null;
      readinessCls = {
        kind: "transient",
        reason: "probe_node_stale",
        hint: serializedExitCode === 126
          ? "remoteSshProbeNodeNotExec"
          : "remoteSshProbeNodeMissing",
      };
    }

    const currentTargetKey = tunnelTargetKey(state.profile);
    const canRecoverForwardConflict = cls.reason === "forward_failed"
      && state.recoveryTargetKey === currentTargetKey;
    if (canRecoverForwardConflict) {
      state.forwardRecoveryFailures += 1;
      state.unknownStrikes = 0;
      if (state.forwardRecoveryFailures < FORWARD_RECOVERY_FAILURE_LIMIT) {
        scheduleReconnect(state, {
          message: safeStderr || `ssh exited ${formatExit(code, signal)}`,
          hint: "remoteSshErrForwardRetrying",
          lastErrorReason: "forward_recovery_conflict",
          wasConnected: false,
        });
        return;
      }
    }

    if (cls.kind === "permanent") {
      finishFailure(state, {
        kind: "permanent",
        reason: cls.reason,
        hint: cls.hint,
        message: safeStderr || `ssh exited ${formatExit(code, signal)}`,
      });
      return;
    }

    if (readinessCls && readinessCls.kind === "permanent") {
      finishFailure(state, {
        kind: "permanent",
        reason: readinessCls.reason,
        hint: readinessCls.hint,
        message: safeStderr || `readiness command exited ${formatExit(code, signal)}`,
      });
      return;
    }

    const effectiveCls = readinessCls && readinessCls.kind === "transient"
      ? readinessCls
      : cls;
    if (effectiveCls.kind === "unknown") {
      state.unknownStrikes += 1;
      if (state.unknownStrikes >= UNKNOWN_STRIKES_LIMIT) {
        finishFailure(state, {
          kind: "permanent",
          reason: "unknown_strikes",
          hint: "remoteSshErrUnknownStrikes",
          message: safeStderr || `ssh exited ${formatExit(code, signal)}`,
        });
        return;
      }
    } else {
      // transient
      state.unknownStrikes = 0;
    }

    // Transient (or unknown under strike-limit): backoff + reconnect.
    scheduleReconnect(state, {
      message: safeStderr || `ssh exited ${formatExit(code, signal)}`,
      hint: effectiveCls.hint || null,
      lastErrorReason: effectiveCls.reason || (effectiveCls.kind === "unknown" ? "unknown" : null),
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
    const probeCmd = buildProbeCommand(profile.remoteForwardPort, nodeBin, { profile });
    // No extraOpts override for ConnectTimeout: ssh -o is first-wins, so the
    // base's ConnectTimeout=15 would always win anyway. PROBE_CHILD_TIMEOUT_MS
    // (5s) is the real upper bound on each probe attempt.
    const probeArgs = buildSshArgs(profile).concat([probeCmd]);

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
    state.probeChildTimer = setTimeoutFn(() => {
      if (state.probeChild !== probe) return;
      state.probeInFlight = false;
      state.probeChild = null;
      state.probeChildTimer = null;
      state.probeLastExitCode = -1;
      killChild(probe);
      log("remote-ssh probe child timed out");
      if (state.stopped) return;
      if (Date.now() < state.probeWindowDeadline && state.sshChild) {
        schedNextProbe(state, PROBE_MIN_GAP_MS);
      }
    }, PROBE_CHILD_TIMEOUT_MS);

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
      clearProbeChildTimer(state);
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
      clearProbeChildTimer(state);
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
    state.healthyTunnelTargetKey = tunnelTargetKey(state.profile);
    resetRecoveryContext(state, { clearHealthy: false });
    setStatus(state, "connected", {
      message: null,
      hint: null,
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
    clearProbeChildTimer(state);
    if (state.probeChild) {
      killChild(state.probeChild);
      state.probeChild = null;
    }
    state.probeInFlight = false;
  }

  function clearSerializedReadinessTimer(state) {
    if (!state || !state.readinessTimer) return;
    clearTimeoutFn(state.readinessTimer);
    state.readinessTimer = null;
  }

  function clearProbeChildTimer(state) {
    if (!state.probeChildTimer) return;
    clearTimeoutFn(state.probeChildTimer);
    state.probeChildTimer = null;
  }

  // ── Reconnect / failure paths ──

  function scheduleReconnect(state, { message, hint, lastErrorReason, wasConnected }) {
    if (state.stopped) return;
    if (wasConnected) {
      const currentTargetKey = tunnelTargetKey(state.profile);
      if (state.healthyTunnelTargetKey === currentTargetKey) {
        state.recoveryTargetKey = currentTargetKey;
        state.forwardRecoveryFailures = 0;
      } else {
        resetRecoveryContext(state);
      }
    }
    state.lastError = message;
    state.lastErrorReason = lastErrorReason;
    state.message = message;
    state.hint = hint || null;
    const delay = backoffMsForAttempt(state.retryAttempt);
    state.retryAttempt += 1;
    setStatus(state, "reconnecting", {
      message,
      hint: hint || null,
      lastError: message,
      lastErrorReason,
    });
    if (state.backoffTimer) clearTimeoutFn(state.backoffTimer);
    const reconnectGeneration = state.connectionGeneration;
    state.backoffTimer = setTimeoutFn(async () => {
      state.backoffTimer = null;
      if (state.stopped || state.connectionGeneration !== reconnectGeneration) return;
      if (!state.serializedTransport && state.transportInspection) {
        try {
          const matches = await ordinaryTargetStillMatches(state);
          if (state.stopped || state.connectionGeneration !== reconnectGeneration) return;
          if (!matches) {
            failSerializedTargetDrift(
              state,
              "The effective SSH transport changed before automatic reconnect; Disconnect and Connect again.",
            );
            return;
          }
        } catch (err) {
          if (state.stopped || state.connectionGeneration !== reconnectGeneration) return;
          finishFailure(state, {
            reason: "transport_inspection_failed",
            hint: "remoteSshErrProfileChanged",
            message: (err && err.message) || "The effective SSH transport could not be re-verified before reconnect.",
          });
          return;
        }
      }
      startConnect(state);
    }, delay);
  }

  function finishFailure(state, { reason, hint, message }) {
    cleanupProbeLoop(state);
    clearSerializedReadinessTimer(state);
    if (state.sshChild) {
      if (state.serializedTransport && state.sshChild.stdin) {
        state.releaseTransportOnClose = true;
        try { state.sshChild.stdin.end(); } catch {}
      } else {
        killChild(state.sshChild);
        state.sshChild = null;
      }
    }
    if (state.backoffTimer) {
      clearTimeoutFn(state.backoffTimer);
      state.backoffTimer = null;
    }
    state.remoteNodeResolveInFlight = false;
    closeProfileIngress(state);
    resetRecoveryContext(state);
    state.stopped = true;
    setStatus(state, "failed", {
      message: message || hint || reason,
      hint: hint || null,
      lastError: message || hint || reason,
      lastErrorReason: reason,
    });
    if (state.serializedTransport && !state.sshChild) {
      releaseSerializedContextIfIdle(state);
    }
  }

  function releaseSerializedContextIfIdle(state) {
    if (!state || !state.transportContext || !transportCoordinator) return false;
    try {
      transportCoordinator.release(state.transportContext);
      state.transportContext = null;
      state.releaseTransportOnClose = false;
      // The status may already be idle/failed, but its previous snapshot was
      // emitted while the coordinator still reported a live transport phase.
      // Publish the post-release snapshot so Settings cannot retain stale
      // owner/phase metadata after the child's close event.
      emitStatus(state);
      return true;
    } catch {
      return false;
    }
  }

  // ── Disconnect ──

  async function suspendForOperation(profileId, transportContext, options = {}) {
    const state = states.get(profileId);
    if (!state) {
      if (transportCoordinator && transportContext) {
        return transportCoordinator.waitForDrain(transportContext, (child, metadata) => {
          if (metadata && metadata.role === "persistent-tunnel-readiness" && child.stdin) {
            try { child.stdin.end(); } catch {}
          }
        });
      }
      return { ok: true, drainVerified: true };
    }
    state.stopped = true;
    state.connectionGeneration += 1;
    state.intentionalClose = true;
    state.releaseTransportOnClose = false;
    state.transportContext = transportContext || state.transportContext;
    cleanupProbeLoop(state);
    clearSerializedReadinessTimer(state);
    if (state.backoffTimer) {
      clearTimeoutFn(state.backoffTimer);
      state.backoffTimer = null;
    }
    state.retryAttempt = 0;
    state.unknownStrikes = 0;
    state.remoteNodeResolveInFlight = false;
    if (options.closeIngress === true) await closeProfileIngressAndWait(state);

    if (transportCoordinator && transportContext) {
      const drained = await transportCoordinator.waitForDrain(transportContext, (child, metadata) => {
        if (metadata && metadata.role === "persistent-tunnel-readiness" && child.stdin) {
          try { child.stdin.end(); } catch {}
          return;
        }
        // Managed one-shots cannot be cooperatively cancelled. Wait for their
        // natural close; if they outlive the drain deadline the coordinator
        // quarantines the slot. Killing only the outer ssh.exe would not prove
        // that its nested ProxyCommand chain has exited.
      });
      if (state.sshChild && state.sshChild.stdin) {
        // The coordinator owns close accounting; this is only a defensive
        // repeat for fake/injected children whose metadata is incomplete.
        try { state.sshChild.stdin.end(); } catch {}
      }
      setStatus(state, "idle", {
        message: options.message || null,
        hint: null,
        lastError: null,
        lastErrorReason: null,
      });
      return drained;
    }
    return { ok: true, drainVerified: !state.sshChild };
  }

  function finalizeSerializedDisconnect(profileId, transportContext) {
    const state = states.get(profileId);
    if (transportCoordinator && transportContext) {
      transportCoordinator.release(transportContext);
    }
    if (state) {
      state.transportContext = null;
      state.stopped = true;
      state.intentionalClose = true;
      state.releaseTransportOnClose = false;
      closeProfileIngress(state);
      resetRecoveryContext(state);
      clearRemoteShellCache(state);
      setStatus(state, "idle", {
        message: null,
        hint: null,
        lastError: null,
        lastErrorReason: null,
      });
    }
    return state ? snapshotState(state) : { profileId, status: "idle" };
  }

  function disconnect(profileId) {
    const state = states.get(profileId);
    if (!state) return { profileId, status: "idle" };
    state.connectionGeneration += 1;
    if (state.serializedTransport) {
      if (transportCoordinator && typeof transportCoordinator.recordDisconnectIntent === "function") {
        transportCoordinator.recordDisconnectIntent(profileId);
      }
      state.stopped = true;
      state.intentionalClose = true;
      state.releaseTransportOnClose = true;
      cleanupProbeLoop(state);
      clearSerializedReadinessTimer(state);
      if (state.backoffTimer) clearTimeoutFn(state.backoffTimer);
      state.backoffTimer = null;
      closeProfileIngress(state);
      if (state.sshChild && state.sshChild.stdin) {
        try { state.sshChild.stdin.end(); } catch {}
      } else if (!state.sshChild) {
        releaseSerializedContextIfIdle(state);
      }
      setStatus(state, "idle", {
        message: null,
        hint: null,
        lastError: null,
        lastErrorReason: null,
      });
      return snapshotState(state);
    }
    state.stopped = true;
    cleanupProbeLoop(state);
    clearSerializedReadinessTimer(state);
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
    closeProfileIngress(state);
    resetRecoveryContext(state);
    clearRemoteShellCache(state);
    setStatus(state, "idle", {
      message: null,
      hint: null,
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
    unsubscribeCoordinatorStatus();
    for (const state of states.values()) {
      state.stopped = true;
      cleanupProbeLoop(state);
      if (state.backoffTimer) clearTimeoutFn(state.backoffTimer);
      state.backoffTimer = null;
      state.remoteNodeResolveInFlight = false;
      closeProfileIngress(state);
      resetRecoveryContext(state);
      if (state.sshChild) killChild(state.sshChild);
      state.sshChild = null;
    }
    states.clear();
    for (const child of auxChildren) killChild(child);
    auxChildren.clear();
  }

  function getProfileTransportMode(profileId) {
    const state = states.get(profileId);
    if (!state) return null;
    return state.serializedTransport ? "serialized" : "parallel";
  }

  function getProfileTransportInspection(profileId) {
    const state = states.get(profileId);
    return state && state.transportInspection ? { ...state.transportInspection } : null;
  }

  async function shutdown(options = {}) {
    unsubscribeCoordinatorStatus();
    const ingressCloses = [];
    for (const state of states.values()) {
      state.stopped = true;
      cleanupProbeLoop(state);
      if (state.backoffTimer) clearTimeoutFn(state.backoffTimer);
      state.backoffTimer = null;
      state.remoteNodeResolveInFlight = false;
      resetRecoveryContext(state);
      ingressCloses.push(closeProfileIngressAndWait(state));
      if (!state.serializedTransport && state.sshChild) {
        killChild(state.sshChild);
        state.sshChild = null;
      }
    }
    await Promise.allSettled(ingressCloses);
    let drain = { ok: true, drainVerified: true, remaining: 0 };
    if (transportCoordinator && typeof transportCoordinator.shutdown === "function") {
      drain = await transportCoordinator.shutdown(options.timeoutMs);
    }
    for (const child of auxChildren) killChild(child);
    auxChildren.clear();
    states.clear();
    return drain;
  }

  function closeProfileIngress(state) {
    if (!state) return;
    state.ingressStartGeneration += 1;
    if (state.ingress && typeof state.ingress.close === "function") {
      try { state.ingress.close(); } catch {}
    }
    state.ingress = null;
  }

  async function closeProfileIngressAndWait(state) {
    if (!state) return;
    state.ingressStartGeneration += 1;
    const ingress = state.ingress;
    state.ingress = null;
    if (!ingress || typeof ingress.close !== "function") return;
    try {
      await ingress.close();
    } catch {}
  }

  return {
    connect,
    disconnect,
    cleanup,
    shutdown,
    getProfileStatus,
    listStatuses,
    getProfileTransportMode,
    getProfileTransportInspection,
    refreshProfile,
    suspendForOperation,
    finalizeSerializedDisconnect,
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

function stderrSummary(stderr, profile, { dropPartialFirstLine = false } = {}) {
  let text;
  if (Buffer.isBuffer(stderr)) {
    text = decodeShellBytes(stderr).trim();
  } else {
    text = (stderr || "").toString().trim();
  }
  if (dropPartialFirstLine) {
    const newline = text.indexOf("\n");
    text = newline >= 0 ? text.slice(newline + 1) : "";
  }
  text = redactTransportDiagnostic(text, profile);
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
  parseOpenSshVersion,
  isUnsupportedWindowsOpenSsh,
  buildSshArgs,
  buildScpArgs,
  classifyStderr,
  classifyProbeExit,
  buildProbeCommand,
  buildPersistentReadinessCommand,
  backoffMsForAttempt,
  tunnelTargetKey,
  checkSecureConnectReadiness,
  looksLikeWindowsCmdStderr,
  WINDOWS_CMD_STDERR_RX,
  // factory
  createRemoteSshRuntime,
  // constants
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
  PROBE_WINDOW_MS,
  SERIALIZED_READINESS_TIMEOUT_MS,
  PROBE_MIN_GAP_MS,
  PROBE_CHILD_TIMEOUT_MS,
  BACKOFF_SCHEDULE_MS,
  UNKNOWN_STRIKES_LIMIT,
  FORWARD_RECOVERY_FAILURE_LIMIT,
};
