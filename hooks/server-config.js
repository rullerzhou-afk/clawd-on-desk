const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const CLAWD_SERVER_ID = "clawd-on-desk";
const CLAWD_SERVER_HEADER = "x-clawd-server";
const DEFAULT_SERVER_PORT = 23333;
const SERVER_PORT_COUNT = 5;
const SERVER_PORTS = Array.from({ length: SERVER_PORT_COUNT }, (_, i) => DEFAULT_SERVER_PORT + i);
const STATE_PATH = "/state";
const PERMISSION_PATH = "/permission";
const DEFAULT_HOOK_HTTP_TIMEOUT_MS = 100;
const REMOTE_HOOK_HTTP_TIMEOUT_MS = 5000;
const REMOTE_IDENTITY_FILENAME = "clawd-remote.json";
const SSH_SECURE_MARKER_FILENAME = "clawd-ssh-secure-v1";
const HOST_PREFIX_FILENAME = "clawd-host-prefix";
const REMOTE_LAST_LOG_FILENAME = "clawd-remote-last-error.log";
const CODEX_AUTO_START_GATE_FILENAME = "codex-auto-start.json";
const CODEX_AUTO_START_GATE_VERSION = 1;
const CODEX_WSL_INTEROP_ARG = "--clawd-wsl-interop";
const CODEX_WINDOWS_STABLE_ARG = "--clawd-windows-stable";
const APPIMAGE_HOOK_MARKER_FILE = ".clawd-appimage-path";
const REMOTE_FAILURE_LOG_INTERVAL_MS = 5 * 60 * 1000;
const ROUTING_NONCE_HEADER = "x-clawd-routing-nonce";
const REMOTE_IDENTITY_VERSION = 2;
const ROUTING_NONCE_RE = /^[a-f0-9]{32}$/;
const INSTALL_ID_RE = /^[a-f0-9]{64}$/;
const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SECURE_TRANSPORT_FAILURE_REASONS = new Set([
  "identity-unreadable",
  "identity-invalid",
  "state-delivery-failed",
  "permission-discovery-failed",
  "permission-delivery-failed",
]);

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && SERVER_PORTS.includes(port) ? port : null;
}

function defaultRuntimeConfigPath(options = {}) {
  const homeDir = typeof options.homeDir === "string" ? options.homeDir : os.homedir();
  return path.join(homeDir, ".clawd", "runtime.json");
}

function defaultCodexAutoStartGatePath(options = {}) {
  const homeDir = typeof options.homeDir === "string" ? options.homeDir : os.homedir();
  return path.join(homeDir, ".clawd", CODEX_AUTO_START_GATE_FILENAME);
}

function readCodexAutoStartGate(options = {}) {
  const fsApi = options.fs || fs;
  const filePath = options.gatePath || defaultCodexAutoStartGatePath(options);
  try {
    const parsed = JSON.parse(fsApi.readFileSync(filePath, "utf8"));
    return !!(
      parsed
      && parsed.app === CLAWD_SERVER_ID
      && parsed.version === CODEX_AUTO_START_GATE_VERSION
      && parsed.enabled === true
    );
  } catch {
    return false;
  }
}

function writeCodexAutoStartGate(enabled, options = {}) {
  if (typeof enabled !== "boolean") return false;
  const fsApi = options.fs || fs;
  const filePath = options.gatePath || defaultCodexAutoStartGatePath(options);
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.codex-auto-start.${process.pid}.${Date.now()}.tmp`);
  const body = JSON.stringify({
    app: CLAWD_SERVER_ID,
    version: CODEX_AUTO_START_GATE_VERSION,
    enabled,
  }, null, 2);
  try {
    fsApi.mkdirSync(dir, { recursive: true });
    fsApi.writeFileSync(tmpPath, body, "utf8");
    fsApi.renameSync(tmpPath, filePath);
    return true;
  } catch {
    try { fsApi.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

function resolveCoLocatedPath(filename, options = {}, optionKey, envKey) {
  if (typeof options[optionKey] === "string" && options[optionKey]) return options[optionKey];
  const env = options.env || process.env;
  if (env && typeof env[envKey] === "string" && env[envKey]) return env[envKey];
  return path.join(__dirname, filename);
}

function resolveRemoteIdentityPath(options = {}) {
  return resolveCoLocatedPath(
    REMOTE_IDENTITY_FILENAME,
    options,
    "remoteIdentityPath",
    "CLAWD_REMOTE_IDENTITY_PATH",
  );
}

function resolveSshSecureMarkerPath(options = {}) {
  return resolveCoLocatedPath(
    SSH_SECURE_MARKER_FILENAME,
    options,
    "secureMarkerPath",
    "CLAWD_SSH_SECURE_MARKER_PATH",
  );
}

function resolveRemoteLastLogPath(options = {}) {
  return resolveCoLocatedPath(
    REMOTE_LAST_LOG_FILENAME,
    options,
    "remoteLastLogPath",
    "CLAWD_REMOTE_LAST_LOG_PATH",
  );
}

function recordSecureTransportFailure(reason, options = {}) {
  const now = typeof options.now === "function" ? options.now() : Date.now();
  const fsApi = options.fs || fs;
  const filePath = resolveRemoteLastLogPath(options);
  const safeReason = SECURE_TRANSPORT_FAILURE_REASONS.has(reason)
    ? reason
    : "transport-failed";
  try {
    const stat = fsApi.statSync(filePath);
    if (Number.isFinite(stat.mtimeMs) && now - stat.mtimeMs < REMOTE_FAILURE_LOG_INTERVAL_MS) {
      return false;
    }
  } catch {}
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  try {
    fsApi.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fsApi.writeFileSync(tmpPath, `${new Date(now).toISOString()} ${safeReason}\n`, {
      mode: 0o600,
    });
    try { fsApi.chmodSync(tmpPath, 0o600); } catch {}
    fsApi.renameSync(tmpPath, filePath);
    try { fsApi.chmodSync(filePath, 0o600); } catch {}
    return true;
  } catch {
    try { fsApi.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

function readHostPrefix(options = {}) {
  const hostPrefixPath = resolveCoLocatedPath(
    HOST_PREFIX_FILENAME,
    options,
    "hostPrefixPath",
    "CLAWD_HOST_PREFIX_PATH",
  );
  let prefix = null;
  try { prefix = (options.readFileSync || fs.readFileSync)(hostPrefixPath, "utf8").trim(); } catch {}
  return prefix || os.hostname().split(".")[0];
}

function envFlagEnabled(value) {
  return !!value && !/^(0|false)$/i.test(String(value));
}

function isSshSecureMode(options = {}) {
  if (options.sshSecure === true) return true;
  if (options.sshSecure === false) return false;
  const env = options.env || process.env;
  if (envFlagEnabled(env && env.CLAWD_SSH_REMOTE)) return true;
  const existsSync = options.existsSync || fs.existsSync;
  try {
    if (existsSync(resolveSshSecureMarkerPath(options))) return true;
  } catch {
    // An unreadable marker path is still a reason to avoid legacy scanning
    // when the explicit path was supplied by a managed remote registration.
    if ((options.env || process.env).CLAWD_SSH_SECURE_MARKER_PATH) return true;
  }
  try {
    if (existsSync(resolveRemoteIdentityPath(options))) return true;
  } catch {
    if ((options.env || process.env).CLAWD_REMOTE_IDENTITY_PATH) return true;
  }
  return false;
}

function readRemoteIdentity(options = {}) {
  const readFileSync = options.readFileSync || fs.readFileSync;
  const filePath = resolveRemoteIdentityPath(options);
  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return { ok: false, reason: "identity-unreadable", filePath };
  }
  const port = normalizePort(raw && raw.remotePort);
  if (!raw
    || typeof raw !== "object"
    || Array.isArray(raw)
    || raw.version !== REMOTE_IDENTITY_VERSION
    || !Number.isInteger(raw.layoutVersion)
    || raw.layoutVersion <= 0
    || !SAFE_ID_RE.test(raw.runtimeKey || "")
    || !SAFE_ID_RE.test(raw.profileId || "")
    || !INSTALL_ID_RE.test(raw.installId || "")
    || !port
    || !ROUTING_NONCE_RE.test(raw.routingNonce || "")
    || !Number.isFinite(raw.deployedAt)
    || raw.deployedAt <= 0) {
    return { ok: false, reason: "identity-invalid", filePath };
  }
  return {
    ok: true,
    reason: null,
    filePath,
    version: raw.version,
    layoutVersion: raw.layoutVersion,
    runtimeKey: raw.runtimeKey,
    profileId: raw.profileId,
    installId: raw.installId,
    remotePort: port,
    routingNonce: raw.routingNonce,
    deployedAt: raw.deployedAt,
  };
}

function resolveSecureTransport(options = {}) {
  if (!isSshSecureMode(options)) return { secure: false, identity: null };
  const identity = options.remoteIdentity && options.remoteIdentity.ok !== undefined
    ? options.remoteIdentity
    : readRemoteIdentity(options);
  const result = {
    secure: true,
    identity: identity && identity.ok ? identity : null,
    reason: identity && identity.reason ? identity.reason : "identity-invalid",
  };
  if (!result.identity) recordSecureTransportFailure(result.reason, options);
  return result;
}

// WSL detection shared by all agent hooks. WSL_DISTRO_NAME is set by WSL
// init and matches `wsl -l -q` output exactly; /proc/version is the
// fallback for unusual init setups. Cached — the answer cannot change
// within one hook process.
function detectWslDistro(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const fsApi = options.fs || fs;
  if (platform !== "linux") return null;
  if (env && env.WSL_DISTRO_NAME) return env.WSL_DISTRO_NAME;
  try {
    if (/microsoft|wsl/i.test(fsApi.readFileSync("/proc/version", "utf8"))) {
      // Inside WSL but WSL_DISTRO_NAME not set (older builds / custom
      // init). Stable sentinel keeps the host prefix self-consistent.
      return "wsl";
    }
  } catch {}
  return null;
}

let cachedWslDistro;
function resolveWslDistro() {
  if (cachedWslDistro !== undefined) return cachedWslDistro;
  cachedWslDistro = detectWslDistro();
  return cachedWslDistro;
}

// Stamp WSL source fields onto a /state body. Local sessions get the
// `wsl:<distro>` host so HUD/dashboard group them; remote (SSH) sessions
// keep their configured host prefix and carry the distro as metadata only.
// No-op outside WSL, so every hook can call this unconditionally.
function applyWslSourceFields(body, options = {}) {
  const distro = resolveWslDistro();
  if (!distro) return body;
  body.wsl_distro = distro;
  if (!options.remote) body.host = `wsl:${distro}`;
  return body;
}

// ── runtime.json identity (#681) ─────────────────────────────────────────────
// The file carries app + port + ownerPid. `app` has always been written but was
// never validated on read; `ownerPid` is new in #681 and is the liveness anchor
// that lets a hook decide "Clawd is gone" WITHOUT spawning anything.
//
// Two readers with deliberately different strictness:
//   - readRuntimePort()     — the PORT reader every POST path already uses.
//     Stays permissive about ownerPid so a runtime.json written by an older
//     Clawd (no ownerPid) keeps routing state/permission POSTs. It DOES now
//     require a matching `app`, which every Clawd that ever wrote this file
//     stamped, so no released shape regresses.
//   - readRuntimeIdentity() — the strict gate for hooks/shared-process.js.
//     Requires app + port + ownerPid. Missing ownerPid is fail-closed: the hook
//     omits process metadata rather than spawn a PowerShell to guess it.
//
// Liveness is NOT checked here on purpose. os/fs are this module's only
// dependencies; processAlive lives in shared-process.js, and requiring it back
// from here would create a cycle now that shared-process.js requires this
// module. Callers that own a liveness probe (the resolver gate, src/server.js's
// Doctor status) apply it to the returned ownerPid themselves.

const RUNTIME_REASON_MISSING = "runtime-missing";
const RUNTIME_REASON_APP_MISMATCH = "runtime-app-mismatch";
const RUNTIME_REASON_PORT_INVALID = "runtime-port-invalid";
const RUNTIME_REASON_OWNER_INVALID = "runtime-owner-invalid";
const WINDOWS_PROCESS_CHAIN_VERSION = 1;
const WINDOWS_PROCESS_CHAIN_AGENT_IDS = new Set([
  "codex", "cursor-agent", "kiro-cli", "codebuddy", "reasonix",
]);
const WINDOWS_PROCESS_CHAIN_MODES = new Set(["legacy", "shadow", "b1a-authoritative"]);
const PROCESS_INSTANCE_RE = /^[A-Za-z0-9_-]{1,128}$/;
const CLAWD_HOOK_PID_HEADER = "X-Clawd-Hook-Pid";
const CLAWD_PROCESS_INSTANCE_HEADER = "X-Clawd-Process-Instance";
const CLAWD_LEGACY_PROCESS_CACHE_HEADER = "X-Clawd-Legacy-Process-Cache";

function normalizeOwnerPid(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeWindowsProcessChainConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.version !== WINDOWS_PROCESS_CHAIN_VERSION) return null;
  if (typeof value.instanceGeneration !== "string"
    || !PROCESS_INSTANCE_RE.test(value.instanceGeneration)) return null;
  if (!value.agents || typeof value.agents !== "object" || Array.isArray(value.agents)) return null;
  const agents = {};
  for (const agentId of WINDOWS_PROCESS_CHAIN_AGENT_IDS) {
    const mode = value.agents[agentId];
    agents[agentId] = WINDOWS_PROCESS_CHAIN_MODES.has(mode) ? mode : "legacy";
  }
  return Object.freeze({
    version: WINDOWS_PROCESS_CHAIN_VERSION,
    instanceGeneration: value.instanceGeneration,
    agents: Object.freeze(agents),
  });
}

// Parse + validate in one place so readRuntimePort and readRuntimeIdentity can
// never disagree about what a well-formed file looks like. Returns a
// discriminated result rather than throwing; `reason` is diagnostic only.
function parseRuntimeConfig(options = {}) {
  const readFileSync = options.readFileSync || fs.readFileSync;
  const filePath = options.runtimeConfigPath || defaultRuntimeConfigPath(options);
  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return { ok: false, reason: RUNTIME_REASON_MISSING, port: null, ownerPid: null };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: RUNTIME_REASON_MISSING, port: null, ownerPid: null };
  }
  if (raw.app !== CLAWD_SERVER_ID) {
    return { ok: false, reason: RUNTIME_REASON_APP_MISMATCH, port: null, ownerPid: null };
  }
  const port = normalizePort(raw.port);
  if (!port) {
    return { ok: false, reason: RUNTIME_REASON_PORT_INVALID, port: null, ownerPid: null };
  }
  return {
    ok: true,
    reason: null,
    port,
    ownerPid: normalizeOwnerPid(raw.ownerPid),
    windowsProcessChain: normalizeWindowsProcessChainConfig(raw.windowsProcessChain),
  };
}

function readRuntimeConfig(options = {}) {
  const parsed = parseRuntimeConfig(options);
  return parsed.ok ? { port: parsed.port } : null;
}

function readRuntimePort(options = {}) {
  const config = readRuntimeConfig(options);
  return config ? config.port : null;
}

// Strict identity for the zero-spawn resolver gate. ok=true means the file is a
// well-formed Clawd runtime with a usable ownerPid — it does NOT mean Clawd is
// alive (the caller checks that) and it is NOT an authentication or ownership
// proof: any process running as this user can write this file, and a PID can be
// reused. It is a liveness hint inside an existing trust boundary, nothing more.
function readRuntimeIdentity(options = {}) {
  const parsed = parseRuntimeConfig(options);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, port: null, ownerPid: null };
  if (!parsed.ownerPid) {
    return { ok: false, reason: RUNTIME_REASON_OWNER_INVALID, port: parsed.port, ownerPid: null };
  }
  const identity = { ok: true, reason: null, port: parsed.port, ownerPid: parsed.ownerPid };
  if (parsed.windowsProcessChain) identity.windowsProcessChain = parsed.windowsProcessChain;
  return identity;
}

function readWindowsProcessChainHookContext(agentId, options = {}) {
  const readIdentity = typeof options.readRuntimeIdentity === "function"
    ? options.readRuntimeIdentity
    : () => readRuntimeIdentity(options);
  const identity = readIdentity();
  if (!identity || !identity.ok) {
    return Object.freeze({ identity, observation: null });
  }
  const capability = identity.windowsProcessChain || null;
  const agentMode = capability && WINDOWS_PROCESS_CHAIN_AGENT_IDS.has(agentId)
    ? capability.agents[agentId]
    : "legacy";
  const observation = Object.freeze({
    port: identity.port,
    ownerPid: identity.ownerPid,
    version: capability ? capability.version : null,
    instanceGeneration: capability ? capability.instanceGeneration : null,
    agentId,
    agentMode,
  });
  return Object.freeze({ identity, observation });
}

function readWindowsProcessChainObservation(agentId, options = {}) {
  return readWindowsProcessChainHookContext(agentId, options).observation;
}

// Boolean contract: returns true on success, false on ANY failure, and never
// throws. mkdirSync is INSIDE the try (#681) — it used to sit outside, so an
// EACCES on ~/.clawd escaped as an exception into src/server.js's 'listening'
// handler and stranded startHttpServer's promise before it could settle.
function writeRuntimeConfig(port, options = {}) {
  const safePort = normalizePort(port);
  if (!safePort) return false;

  const fsApi = options.fs || fs;
  const filePath = options.runtimeConfigPath || defaultRuntimeConfigPath(options);
  const ownerPid = normalizeOwnerPid(options.ownerPid) || process.pid;
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.runtime.${process.pid}.${Date.now()}.tmp`);
  const runtimeBody = { app: CLAWD_SERVER_ID, port: safePort, ownerPid };
  const windowsProcessChain = normalizeWindowsProcessChainConfig(options.windowsProcessChain);
  if (windowsProcessChain) runtimeBody.windowsProcessChain = windowsProcessChain;
  const body = JSON.stringify(runtimeBody, null, 2);
  try {
    fsApi.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Permission-capable plugins use this file to avoid disclosing their
    // reverse-bridge bearer token to arbitrary listeners during a port scan.
    // Keep the replacement owner-only on POSIX; Windows ignores this mode and
    // relies on the user's profile ACL.
    fsApi.writeFileSync(tmpPath, body, { encoding: "utf8", mode: 0o600 });
    fsApi.renameSync(tmpPath, filePath);
    return true;
  } catch {
    try { fsApi.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

// Owner-guarded (#681 review P2-2). Two live instances share this ONE file —
// an installed build and a dev build hold different user-data-dir singleton
// locks, so both can run, and whoever started LAST owns the current bytes. An
// earlier instance quitting later must not tear down the survivor's identity:
// with the #681 gate that would blind every Windows hook (offline shape, no
// focus metadata) until the survivor restarts, where pre-gate the cost was
// one port-probe fallback. So the unlink happens only when the file's
// ownerPid is ours. Legacy (no ownerPid) and corrupt files are residue and
// still get cleaned. A foreign ownerPid is deliberately NOT liveness-checked:
// a dead foreign owner's file is already harmless (the gate's own liveness
// probe fails it) and the next start overwrites it — not worth coupling this
// module to a kill(pid,0) helper it otherwise never needs.
function clearRuntimeConfig(filePath, options = {}) {
  const targetPath = filePath || defaultRuntimeConfigPath(options);
  const ownPid = normalizeOwnerPid(options.ownerPid) || process.pid;
  try {
    const raw = JSON.parse(fs.readFileSync(targetPath, "utf8"));
    const filePid = normalizeOwnerPid(raw && raw.ownerPid);
    if (filePid && filePid !== ownPid) return false;
  } catch {
    // Missing: the unlink below reports false, as before. Corrupt/unreadable:
    // residue — fall through and clean it.
  }
  try {
    fs.unlinkSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function getPortCandidates(preferredPort, options = {}) {
  const secureTransport = resolveSecureTransport(options);
  if (secureTransport.secure) {
    return secureTransport.identity ? [secureTransport.identity.remotePort] : [];
  }
  const ports = [];
  const seen = new Set();
  const runtimePort = normalizePort(
    Object.prototype.hasOwnProperty.call(options, "runtimePort")
      ? options.runtimePort
      : readRuntimePort()
  );
  const add = (value) => {
    const port = normalizePort(value);
    if (!port || seen.has(port)) return;
    seen.add(port);
    ports.push(port);
  };

  if (Array.isArray(preferredPort)) preferredPort.forEach(add);
  else add(preferredPort);
  add(runtimePort);
  SERVER_PORTS.forEach(add);
  return ports;
}

function splitPortCandidates(preferredPort, options = {}) {
  const secureTransport = resolveSecureTransport(options);
  if (secureTransport.secure) {
    const direct = secureTransport.identity ? [secureTransport.identity.remotePort] : [];
    return { direct, fallback: [], all: direct.slice() };
  }
  const runtimePort = normalizePort(
    Object.prototype.hasOwnProperty.call(options, "runtimePort")
      ? options.runtimePort
      : readRuntimePort()
  );
  const all = getPortCandidates(preferredPort, { runtimePort });
  const direct = [];
  const fallback = [];
  const directSeen = new Set();

  const addDirect = (port) => {
    if (!port || directSeen.has(port)) return;
    directSeen.add(port);
    direct.push(port);
  };

  if (Array.isArray(preferredPort)) preferredPort.forEach((port) => addDirect(normalizePort(port)));
  else addDirect(normalizePort(preferredPort));
  addDirect(runtimePort);

  for (const port of all) {
    if (directSeen.has(port)) continue;
    fallback.push(port);
  }

  return { direct, fallback, all };
}

function buildPermissionUrl(port, routingNonce, transport = "path") {
  const safePort = normalizePort(port) || DEFAULT_SERVER_PORT;
  const nonce = ROUTING_NONCE_RE.test(routingNonce || "") ? routingNonce : "";
  if (nonce && transport === "query") {
    return `http://127.0.0.1:${safePort}${PERMISSION_PATH}?nonce=${nonce}`;
  }
  const suffix = nonce ? `/${nonce}` : "";
  return `http://127.0.0.1:${safePort}${PERMISSION_PATH}${suffix}`;
}

// Ownership test for PermissionRequest HTTP hooks: true only for URLs that
// buildPermissionUrl could have written (any bindable server port). Installers
// must gate every update/remove of an HTTP hook on this — a user's own
// approval endpoint (e.g. https://approval.corp.example/permission) merely
// contains "/permission" and must never be rewritten or deleted.
function isManagedPermissionUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    return parsed.protocol === "http:"
      && parsed.hostname === "127.0.0.1"
      && (parsed.pathname === PERMISSION_PATH
        || new RegExp(`^${PERMISSION_PATH}/[a-f0-9]{32}$`).test(parsed.pathname))
      && (parsed.search === ""
        || (parsed.pathname === PERMISSION_PATH
          && /^\?nonce=[a-f0-9]{32}$/.test(parsed.search)))
      && parsed.hash === ""
      && parsed.username === ""
      && parsed.password === ""
      && SERVER_PORTS.includes(port);
  } catch {
    return false;
  }
}

function readHeader(res, headerName) {
  const value = res.headers && res.headers[headerName];
  return Array.isArray(value) ? value[0] : value;
}

function isClawdResponse(res, body) {
  if (readHeader(res, CLAWD_SERVER_HEADER) === CLAWD_SERVER_ID) return true;
  if (!body) return false;
  try {
    const data = JSON.parse(body);
    return data && data.app === CLAWD_SERVER_ID;
  } catch {
    return false;
  }
}

function secureRequestHeaders(options = {}) {
  const secureTransport = resolveSecureTransport(options);
  if (!secureTransport.secure || !secureTransport.identity) return {};
  return {
    [ROUTING_NONCE_HEADER]: secureTransport.identity.routingNonce,
  };
}

function isRemoteHookMode(options = {}) {
  if (options.remote === true) return true;
  if (options.remote === false) return false;
  const env = options.env || process.env;
  return envFlagEnabled(env && env.CLAWD_REMOTE);
}

function buildWindowsProcessChainHeaders(port, options = {}) {
  const request = options.windowsProcessChain;
  if (!request || typeof request !== "object" || Array.isArray(request)) return {};
  const platform = options.platform || request.platform || process.platform;
  if (platform !== "win32") return {};
  if (isRemoteHookMode(options) || resolveSecureTransport(options).secure) return {};

  const agentId = typeof request.agentId === "string" ? request.agentId : "";
  const observation = request.runtimeObservation;
  if (!WINDOWS_PROCESS_CHAIN_AGENT_IDS.has(agentId)
    || !observation
    || observation.agentId !== agentId
    || normalizePort(observation.port) !== normalizePort(port)
    || observation.version !== WINDOWS_PROCESS_CHAIN_VERSION
    || !PROCESS_INSTANCE_RE.test(observation.instanceGeneration || "")
    || !WINDOWS_PROCESS_CHAIN_MODES.has(observation.agentMode)
    || observation.agentMode === "legacy") return {};

  const hookPid = Number(request.hookPid);
  if (!Number.isInteger(hookPid) || hookPid <= 0 || hookPid > 0xffffffff) return {};
  const headers = {
    [CLAWD_HOOK_PID_HEADER]: String(hookPid),
    [CLAWD_PROCESS_INSTANCE_HEADER]: observation.instanceGeneration,
  };
  const cacheSource = request.legacyCacheSource;
  if (cacheSource === "fresh" || cacheSource === "v2" || cacheSource === "v1" || cacheSource === "none") {
    headers[CLAWD_LEGACY_PROCESS_CACHE_HEADER] = cacheSource;
  }
  return headers;
}

function normalizeHookHttpTimeout(value, fallback, options = {}) {
  const n = Number(value);
  const requested = Number.isFinite(n) && n > 0 ? n : fallback;
  return isRemoteHookMode(options)
    ? Math.max(requested, REMOTE_HOOK_HTTP_TIMEOUT_MS)
    : requested;
}

function getStatePostTimeoutMs(options = {}) {
  return normalizeHookHttpTimeout(
    options.timeoutMs,
    DEFAULT_HOOK_HTTP_TIMEOUT_MS,
    options
  );
}

function getPermissionProbeTimeoutMs(options = {}) {
  // Permission discovery also crosses the reverse tunnel in remote mode.
  // This can make the all-ports-dead path slower, but avoids missing a
  // healthy local Clawd behind a high-latency tunnel.
  return normalizeHookHttpTimeout(
    options.probeTimeoutMs,
    DEFAULT_HOOK_HTTP_TIMEOUT_MS,
    options
  );
}

function probePort(port, timeoutMs, callback, options = {}) {
  const secureTransport = resolveSecureTransport(options);
  if (secureTransport.secure && !secureTransport.identity) {
    callback(false);
    return;
  }
  const httpGet = options.httpGet || http.get;
  const req = httpGet(
    {
      hostname: "127.0.0.1",
      port,
      path: STATE_PATH,
      timeout: timeoutMs,
      headers: secureRequestHeaders({
        ...options,
        remoteIdentity: secureTransport.identity || options.remoteIdentity,
      }),
    },
    (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (body.length < 256) body += chunk;
      });
      res.on("end", () => callback(isClawdResponse(res, body)));
    }
  );

  req.on("error", () => callback(false));
  req.on("timeout", () => {
    req.destroy();
    callback(false);
  });
}

function postStateToPort(port, payload, timeoutMs, callback, options = {}) {
  const secureTransport = resolveSecureTransport(options);
  if (secureTransport.secure && !secureTransport.identity) {
    callback(false, port);
    return;
  }
  const httpRequest = options.httpRequest || http.request;
  const req = httpRequest(
    {
      hostname: "127.0.0.1",
      port,
      path: STATE_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...secureRequestHeaders({
          ...options,
          remoteIdentity: secureTransport.identity || options.remoteIdentity,
        }),
        ...buildWindowsProcessChainHeaders(port, options),
      },
      timeout: timeoutMs,
    },
    (res) => {
      if (readHeader(res, CLAWD_SERVER_HEADER) === CLAWD_SERVER_ID) {
        res.resume();
        callback(true, port);
        return;
      }

      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (responseBody.length < 256) responseBody += chunk;
      });
      res.on("end", () => callback(isClawdResponse(res, responseBody), port));
    }
  );

  req.on("error", () => callback(false, port));
  req.on("timeout", () => {
    req.destroy();
    callback(false, port);
  });
  req.end(payload);
}

function discoverClawdPort(options, callback) {
  const timeoutMs = options && options.timeoutMs ? options.timeoutMs : DEFAULT_HOOK_HTTP_TIMEOUT_MS;
  const ports = getPortCandidates(options && options.preferredPort, options);
  const probe = options && options.probePort ? options.probePort : probePort;
  let index = 0;

  const tryNext = () => {
    if (index >= ports.length) {
      callback(null);
      return;
    }

    const port = ports[index++];
    probe(port, timeoutMs, (ok) => {
      if (ok) {
        callback(port);
        return;
      }
      tryNext();
    }, options);
  };

  tryNext();
}

function postStateToRunningServer(body, options, callback) {
  const timeoutMs = getStatePostTimeoutMs(options || {});
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const { direct, fallback } = splitPortCandidates(options && options.preferredPort, options);
  const probe = options && options.probePort ? options.probePort : probePort;
  const post = options && options.postStateToPort ? options.postStateToPort : postStateToPort;
  let directIndex = 0;
  let fallbackIndex = 0;

  const tryFallback = () => {
    if (fallbackIndex >= fallback.length) {
      if (resolveSecureTransport(options || {}).secure) {
        recordSecureTransportFailure("state-delivery-failed", options || {});
      }
      callback(false, null);
      return;
    }

    const port = fallback[fallbackIndex++];
    probe(port, timeoutMs, (ok) => {
      if (!ok) {
        tryFallback();
        return;
      }
      post(port, payload, timeoutMs, (posted, confirmedPort) => {
        if (posted) {
          callback(true, confirmedPort);
          return;
        }
        tryFallback();
      }, options);
    }, options);
  };

  const tryDirect = () => {
    if (directIndex >= direct.length) {
      tryFallback();
      return;
    }

    const port = direct[directIndex++];
    post(port, payload, timeoutMs, (posted, confirmedPort) => {
      if (posted) {
        callback(true, confirmedPort);
        return;
      }
      tryDirect();
    }, options);
  };

  tryDirect();
}

function postPermissionToPort(port, payload, timeoutMs, callback, options = {}) {
  const secureTransport = resolveSecureTransport(options);
  if (secureTransport.secure && !secureTransport.identity) {
    callback(false, port, "", 0);
    return;
  }
  const httpRequest = options.httpRequest || http.request;
  let settled = false;
  const finish = (ok, responseBody = "", statusCode = 0) => {
    if (settled) return;
    settled = true;
    callback(ok, port, responseBody, statusCode);
  };

  const req = httpRequest(
    {
      hostname: "127.0.0.1",
      port,
      path: PERMISSION_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...secureRequestHeaders({
          ...options,
          remoteIdentity: secureTransport.identity || options.remoteIdentity,
        }),
        ...buildWindowsProcessChainHeaders(port, options),
      },
      timeout: timeoutMs,
    },
    (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (responseBody.length < 262144) responseBody += chunk;
      });
      res.on("end", () => {
        finish(readHeader(res, CLAWD_SERVER_HEADER) === CLAWD_SERVER_ID, responseBody, res.statusCode || 0);
      });
    }
  );

  req.on("error", () => finish(false));
  req.on("timeout", () => {
    req.destroy();
    finish(false);
  });
  req.end(payload);
}

function postPermissionToRunningServer(body, options, callback) {
  const timeoutMs = options && options.timeoutMs ? options.timeoutMs : 590000;
  const probeTimeoutMs = getPermissionProbeTimeoutMs(options || {});
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const discover = options && options.discoverClawdPort ? options.discoverClawdPort : discoverClawdPort;
  const post = options && options.postPermissionToPort ? options.postPermissionToPort : postPermissionToPort;

  discover({ ...options, timeoutMs: probeTimeoutMs }, (port) => {
    if (!port) {
      if (resolveSecureTransport(options || {}).secure) {
        recordSecureTransportFailure("permission-discovery-failed", options || {});
      }
      callback(false, null, "", 0);
      return;
    }
    post(port, payload, timeoutMs, (ok, confirmedPort, responseBody, statusCode) => {
      if (!ok && resolveSecureTransport(options || {}).secure) {
        recordSecureTransportFailure("permission-delivery-failed", options || {});
      }
      callback(ok, confirmedPort, responseBody, statusCode);
    }, options);
  });
}

function joinPosixPath(...parts) {
  return path.posix.join(
    ...parts
      .filter((part) => typeof part === "string" && part.length > 0)
      .map((part, index) => (index === 0 ? part.replace(/\\/g, "/") : part))
  );
}

function parseNodeVersionName(value) {
  const match = String(value || "").match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[.-].*)?$/);
  if (!match) return null;
  return [
    Number(match[1]) || 0,
    Number(match[2]) || 0,
    Number(match[3]) || 0,
  ];
}

function compareVersionNamesDesc(a, b) {
  const av = parseNodeVersionName(a);
  const bv = parseNodeVersionName(b);
  if (!av && !bv) return String(b).localeCompare(String(a));
  if (!av) return 1;
  if (!bv) return -1;
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const delta = (bv[i] || 0) - (av[i] || 0);
    if (delta !== 0) return delta;
  }
  return String(b).localeCompare(String(a));
}

function readNodeVersionDirsSync(baseDir, options = {}) {
  const readdirSync = options.readdirSync || fs.readdirSync;
  try {
    return readdirSync(baseDir)
      .filter((entry) => typeof entry === "string" && parseNodeVersionName(entry))
      .sort(compareVersionNamesDesc);
  } catch {
    return [];
  }
}

async function readNodeVersionDirsAsync(baseDir, options = {}) {
  const readdir = options.readdir || fs.promises.readdir.bind(fs.promises);
  try {
    const entries = await readdir(baseDir);
    return entries
      .filter((entry) => typeof entry === "string" && parseNodeVersionName(entry))
      .sort(compareVersionNamesDesc);
  } catch {
    return [];
  }
}

function getManagedNodeCandidatesSync(homeDir, options = {}) {
  const directCandidates = [
    joinPosixPath(homeDir, ".volta", "bin", "node"),
    joinPosixPath(homeDir, ".local", "bin", "node"),
    joinPosixPath(homeDir, ".nvm", "current", "bin", "node"),
  ];
  const shimCandidates = [
    joinPosixPath(homeDir, ".asdf", "shims", "node"),
    joinPosixPath(homeDir, ".mise", "shims", "node"),
    joinPosixPath(homeDir, ".local", "share", "mise", "shims", "node"),
  ];
  const candidates = [...directCandidates];

  const versionedRoots = [
    {
      root: joinPosixPath(homeDir, ".nvm", "versions", "node"),
      suffix: ["bin", "node"],
    },
    {
      root: joinPosixPath(homeDir, ".fnm", "node-versions"),
      suffix: ["installation", "bin", "node"],
    },
    {
      root: joinPosixPath(homeDir, ".local", "share", "fnm", "node-versions"),
      suffix: ["installation", "bin", "node"],
    },
    {
      root: joinPosixPath(homeDir, ".asdf", "installs", "nodejs"),
      suffix: ["bin", "node"],
    },
  ];

  for (const { root, suffix } of versionedRoots) {
    for (const versionDir of readNodeVersionDirsSync(root, options)) {
      candidates.push(joinPosixPath(root, versionDir, ...suffix));
    }
  }

  candidates.push(...shimCandidates);
  return candidates;
}

async function getManagedNodeCandidatesAsync(homeDir, options = {}) {
  const directCandidates = [
    joinPosixPath(homeDir, ".volta", "bin", "node"),
    joinPosixPath(homeDir, ".local", "bin", "node"),
    joinPosixPath(homeDir, ".nvm", "current", "bin", "node"),
  ];
  const shimCandidates = [
    joinPosixPath(homeDir, ".asdf", "shims", "node"),
    joinPosixPath(homeDir, ".mise", "shims", "node"),
    joinPosixPath(homeDir, ".local", "share", "mise", "shims", "node"),
  ];
  const candidates = [...directCandidates];

  const versionedRoots = [
    {
      root: joinPosixPath(homeDir, ".nvm", "versions", "node"),
      suffix: ["bin", "node"],
    },
    {
      root: joinPosixPath(homeDir, ".fnm", "node-versions"),
      suffix: ["installation", "bin", "node"],
    },
    {
      root: joinPosixPath(homeDir, ".local", "share", "fnm", "node-versions"),
      suffix: ["installation", "bin", "node"],
    },
    {
      root: joinPosixPath(homeDir, ".asdf", "installs", "nodejs"),
      suffix: ["bin", "node"],
    },
  ];

  for (const { root, suffix } of versionedRoots) {
    for (const versionDir of await readNodeVersionDirsAsync(root, options)) {
      candidates.push(joinPosixPath(root, versionDir, ...suffix));
    }
  }

  candidates.push(...shimCandidates);
  return candidates;
}

function getShellCandidates(options = {}) {
  const candidates = [];
  const add = (value) => {
    if (typeof value !== "string" || !value.startsWith("/")) return;
    if (!candidates.includes(value)) candidates.push(value);
  };
  add(options.shellPath);
  add(options.env && options.env.SHELL);
  add(process.env.SHELL);
  add("/bin/zsh");
  add("/bin/bash");
  add("/bin/sh");
  return candidates;
}

function isCleanAbsoluteShellPath(value) {
  const text = String(value || "").trim();
  return text.startsWith("/") && !/[\s"'$`]/.test(text);
}

function extractAbsolutePathFromShellOutput(raw) {
  const lines = String(raw || "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (isCleanAbsoluteShellPath(line)) return line;
  }
  return null;
}

// Use path.win32.* explicitly throughout so resolveNodeBin behaves identically
// when the test suite (or any caller) drives win32 logic from a Linux/macOS
// host. The default `path` module follows the host platform, which on POSIX
// treats `C:\Program Files\nodejs\node.exe` as a single filename — basename
// returns the entire string and every Windows check silently misfires.
const WINDOWS_NODE_BASENAMES = new Set(["node.exe", "node"]);

function isWindowsNodeBasename(value) {
  return WINDOWS_NODE_BASENAMES.has(
    path.win32.basename(String(value || "")).toLowerCase()
  );
}

function normalizeWindowsPathForMatch(value) {
  return path.win32.normalize(String(value || "")).replace(/\//g, "\\").toLowerCase();
}

function isScoopShimPath(value) {
  if (typeof value !== "string" || !value) return false;
  return normalizeWindowsPathForMatch(value).includes("\\scoop\\shims\\");
}

function isClawdOrElectronPath(value) {
  const norm = normalizeWindowsPathForMatch(value);
  if (!norm) return false;
  // Reject the packaged Electron host. Match by basename so we don't false-flag
  // a legitimate Node living under a parent folder whose name happens to
  // contain "Clawd" or "Electron".
  const base = path.win32.basename(norm);
  return base.includes("clawd on desk") || base === "electron.exe";
}

function validateWindowsNodeCandidate(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Accept drive letter (C:\...), UNC (\\server\share\...). path.win32.isAbsolute
  // already covers both; the regex fallback exists only as a belt-and-braces
  // guard if a future caller hands in a hand-built path object.
  if (!path.win32.isAbsolute(trimmed) && !/^[A-Za-z]:[\\/]/.test(trimmed) && !trimmed.startsWith("\\\\")) {
    return null;
  }
  if (!isWindowsNodeBasename(trimmed)) return null;
  if (isScoopShimPath(trimmed)) return null;
  if (isClawdOrElectronPath(trimmed)) return null;
  return trimmed;
}

function getWindowsCommonNodePaths(options = {}) {
  const env = options.env || process.env;
  const probes = [];
  if (env.ProgramFiles) {
    probes.push(path.win32.join(env.ProgramFiles, "nodejs", "node.exe"));
  }
  if (env["ProgramFiles(x86)"]) {
    probes.push(path.win32.join(env["ProgramFiles(x86)"], "nodejs", "node.exe"));
  }
  if (env.LOCALAPPDATA) {
    probes.push(path.win32.join(env.LOCALAPPDATA, "Programs", "nodejs", "node.exe"));
    probes.push(path.win32.join(env.LOCALAPPDATA, "Volta", "bin", "node.exe"));
  }
  if (env.USERPROFILE) {
    probes.push(path.win32.join(env.USERPROFILE, "scoop", "apps", "nodejs", "current", "node.exe"));
  }
  return probes;
}

function windowsWhereExePath(options = {}) {
  const systemRoot = (options.env || process.env).SystemRoot;
  return systemRoot
    ? path.win32.join(systemRoot, "System32", "where.exe")
    : "where.exe";
}

function resolveWindowsNodeBinSync(options = {}) {
  const access = options.accessSync || fs.accessSync;
  const checkAccess = (candidate) => {
    if (!candidate) return null;
    try {
      access(candidate, fs.constants.F_OK);
      return candidate;
    } catch {
      return null;
    }
  };

  // 1. process.execPath / options.execPath when it's actually node[.exe].
  //    In packaged Clawd builds this is `Clawd on Desk.exe`, so it falls
  //    through; mostly useful for unit tests and non-Electron Node runs.
  const execHit = checkAccess(validateWindowsNodeCandidate(options.execPath || process.execPath));
  if (execHit) return execHit;

  // 2. where.exe node — iterate every line; first line passing validation wins.
  try {
    const execFileSync = options.execFileSync || require("child_process").execFileSync;
    const out = execFileSync(windowsWhereExePath(options), ["node"], {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
    });
    for (const line of String(out || "").split(/\r?\n/)) {
      const hit = checkAccess(validateWindowsNodeCandidate(line));
      if (hit) return hit;
    }
  } catch {}

  // 3. Common install locations.
  for (const probe of getWindowsCommonNodePaths(options)) {
    const hit = checkAccess(validateWindowsNodeCandidate(probe));
    if (hit) return hit;
  }

  return null;
}

async function resolveWindowsNodeBinAsync(options = {}) {
  const access = options.access || fs.promises.access.bind(fs.promises);
  const checkAccess = async (candidate) => {
    if (!candidate) return null;
    try {
      await access(candidate, fs.constants.F_OK);
      return candidate;
    } catch {
      return null;
    }
  };

  const execHit = await checkAccess(validateWindowsNodeCandidate(options.execPath || process.execPath));
  if (execHit) return execHit;

  try {
    const execFile = options.execFile || ((command, args, execOptions) => new Promise((resolve, reject) => {
      require("child_process").execFile(command, args, execOptions, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    }));
    const out = await execFile(windowsWhereExePath(options), ["node"], {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
    });
    const raw = typeof out === "string"
      ? out
      : (out && typeof out.stdout === "string" ? out.stdout : "");
    for (const line of raw.split(/\r?\n/)) {
      const hit = await checkAccess(validateWindowsNodeCandidate(line));
      if (hit) return hit;
    }
  } catch {}

  for (const probe of getWindowsCommonNodePaths(options)) {
    const hit = await checkAccess(validateWindowsNodeCandidate(probe));
    if (hit) return hit;
  }

  return null;
}

/**
 * Resolve the absolute path to the Node.js binary for hook commands.
 * On macOS/Linux, Claude Code runs hooks with a minimal PATH (/usr/bin:/bin)
 * that excludes Homebrew, nvm, volta, fnm, etc.  On Windows, hook runners
 * can execute under PowerShell whose PATH does not include the Node install
 * directory (see issue #317).  We embed the full path in hook commands so
 * they work regardless of the hook runner's PATH.
 *
 * @param {object} [options] — for testing
 * @param {string} [options.platform]
 * @param {string} [options.homeDir]
 * @param {Function} [options.execFileSync]
 * @param {Function} [options.accessSync]
 * @param {string} [options.execPath]
 * @param {boolean} [options.isElectron]
 * @param {object} [options.env]
 * @returns {string|null} absolute path, or null when detection fails
 */
function resolveNodeBin(options = {}) {
  const platform = options.platform || process.platform;

  if (platform === "win32") return resolveWindowsNodeBinSync(options);

  const isElectron = options.isElectron !== undefined
    ? options.isElectron
    : !!process.versions.electron;

  // Non-Electron Node.js: process.execPath IS the node binary
  if (!isElectron) {
    return options.execPath || process.execPath;
  }

  // Electron on macOS/Linux: need to find system node
  const homeDir = options.homeDir || os.homedir();
  const access = options.accessSync || fs.accessSync;

  // Strategy 1: Check well-known and common Node-manager paths (fast, no shell spawn).
  const candidates = [
    "/opt/homebrew/bin/node",                          // Homebrew ARM Mac
    "/usr/local/bin/node",                             // Homebrew Intel Mac / official .pkg
    ...getManagedNodeCandidatesSync(homeDir, options), // Volta / nvm / fnm / asdf / mise
    "/usr/bin/node",                                   // system package manager
  ];

  for (const candidate of candidates) {
    try {
      access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }

  // Strategy 2: Login + interactive shell (sources both .zprofile AND .zshrc/.bashrc,
  // needed because nvm/fnm initialize in rc files, not profile files)
  const execFileSync = options.execFileSync || require("child_process").execFileSync;
  for (const shell of getShellCandidates(options)) {
    try {
      const raw = execFileSync(shell, ["-lic", "command -v node 2>/dev/null; which node 2>/dev/null; true"], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      // Interactive shells may produce extra output (Oh My Zsh, Powerlevel10k, etc.)
      // before `command -v node`. Take the last line that looks like an absolute path.
      const resolved = extractAbsolutePathFromShellOutput(raw);
      if (resolved) {
        access(resolved, fs.constants.X_OK);
        return resolved;
      }
    } catch {}
  }

  // Detection failed — return null so callers can preserve existing config
  // instead of destructively overwriting an absolute path with bare "node"
  return null;
}

async function resolveNodeBinAsync(options = {}) {
  const platform = options.platform || process.platform;

  if (platform === "win32") return await resolveWindowsNodeBinAsync(options);

  const isElectron = options.isElectron !== undefined
    ? options.isElectron
    : !!process.versions.electron;

  if (!isElectron) {
    return options.execPath || process.execPath;
  }

  const homeDir = options.homeDir || os.homedir();
  const access = options.access || fs.promises.access.bind(fs.promises);
  const candidates = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    ...await getManagedNodeCandidatesAsync(homeDir, options),
    "/usr/bin/node",
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }

  const execFile = options.execFile || ((command, args, execOptions) => new Promise((resolve, reject) => {
    require("child_process").execFile(command, args, execOptions, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  }));
  for (const shell of getShellCandidates(options)) {
    try {
      const out = await execFile(shell, ["-lic", "command -v node 2>/dev/null; which node 2>/dev/null; true"], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      const raw = typeof out === "string" ? out : out && typeof out.stdout === "string" ? out.stdout : "";
      const resolved = extractAbsolutePathFromShellOutput(raw);
      if (resolved) {
        await access(resolved, fs.constants.X_OK);
        return resolved;
      }
    } catch {}
  }

  return null;
}

module.exports = {
  APPIMAGE_HOOK_MARKER_FILE,
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
  CODEX_AUTO_START_GATE_FILENAME,
  CODEX_AUTO_START_GATE_VERSION,
  CODEX_WSL_INTEROP_ARG,
  CODEX_WINDOWS_STABLE_ARG,
  DEFAULT_HOOK_HTTP_TIMEOUT_MS,
  DEFAULT_SERVER_PORT,
  HOST_PREFIX_FILENAME,
  REMOTE_LAST_LOG_FILENAME,
  REMOTE_FAILURE_LOG_INTERVAL_MS,
  INSTALL_ID_RE,
  PERMISSION_PATH,
  REMOTE_HOOK_HTTP_TIMEOUT_MS,
  REMOTE_IDENTITY_FILENAME,
  REMOTE_IDENTITY_VERSION,
  ROUTING_NONCE_HEADER,
  ROUTING_NONCE_RE,
  SERVER_PORTS,
  SSH_SECURE_MARKER_FILENAME,
  STATE_PATH,
  CLAWD_HOOK_PID_HEADER,
  CLAWD_PROCESS_INSTANCE_HEADER,
  CLAWD_LEGACY_PROCESS_CACHE_HEADER,
  WINDOWS_PROCESS_CHAIN_VERSION,
  buildPermissionUrl,
  buildWindowsProcessChainHeaders,
  clearRuntimeConfig,
  defaultCodexAutoStartGatePath,
  defaultRuntimeConfigPath,
  isManagedPermissionUrl,
  isRemoteHookMode,
  isSshSecureMode,
  discoverClawdPort,
  getPortCandidates,
  getPermissionProbeTimeoutMs,
  getStatePostTimeoutMs,
  postPermissionToPort,
  postPermissionToRunningServer,
  postStateToRunningServer,
  probePort,
  readHostPrefix,
  readCodexAutoStartGate,
  readRemoteIdentity,
  resolveRemoteIdentityPath,
  resolveRemoteLastLogPath,
  recordSecureTransportFailure,
  resolveSecureTransport,
  resolveSshSecureMarkerPath,
  resolveWslDistro,
  applyWslSourceFields,
  readRuntimeConfig,
  readRuntimeIdentity,
  readRuntimePort,
  readWindowsProcessChainHookContext,
  readWindowsProcessChainObservation,
  detectWslDistro,
  resolveNodeBin,
  resolveNodeBinAsync,
  resolveWindowsNodeBinSync,
  resolveWindowsNodeBinAsync,
  validateWindowsNodeCandidate,
  splitPortCandidates,
  postStateToPort,
  normalizeWindowsProcessChainConfig,
  writeRuntimeConfig,
  writeCodexAutoStartGate,
};
