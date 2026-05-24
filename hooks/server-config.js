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
const RUNTIME_CONFIG_PATH = path.join(os.homedir(), ".clawd", "runtime.json");
const DEFAULT_HOOK_HTTP_TIMEOUT_MS = 100;
const REMOTE_HOOK_HTTP_TIMEOUT_MS = 5000;

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && SERVER_PORTS.includes(port) ? port : null;
}

const HOST_PREFIX_PATH = path.join(os.homedir(), ".claude", "hooks", "clawd-host-prefix");

function readHostPrefix() {
  let prefix = null;
  try { prefix = fs.readFileSync(HOST_PREFIX_PATH, "utf8").trim(); } catch {}
  return prefix || os.hostname().split(".")[0];
}

function readRuntimeConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const port = normalizePort(raw.port);
    return port ? { port } : null;
  } catch {
    return null;
  }
}

function readRuntimePort() {
  const config = readRuntimeConfig();
  return config ? config.port : null;
}

function writeRuntimeConfig(port) {
  const safePort = normalizePort(port);
  if (!safePort) return false;

  const dir = path.dirname(RUNTIME_CONFIG_PATH);
  const tmpPath = path.join(dir, `.runtime.${process.pid}.${Date.now()}.tmp`);
  const body = JSON.stringify({ app: CLAWD_SERVER_ID, port: safePort }, null, 2);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(tmpPath, body, "utf8");
    fs.renameSync(tmpPath, RUNTIME_CONFIG_PATH);
    return true;
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

function clearRuntimeConfig(filePath = RUNTIME_CONFIG_PATH) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function getPortCandidates(preferredPort, options = {}) {
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

function buildPermissionUrl(port) {
  const safePort = normalizePort(port) || DEFAULT_SERVER_PORT;
  return `http://127.0.0.1:${safePort}${PERMISSION_PATH}`;
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

function isRemoteHookMode(options = {}) {
  if (options.remote === true) return true;
  if (options.remote === false) return false;
  const env = options.env || process.env;
  const value = env && env.CLAWD_REMOTE;
  if (!value) return false;
  return !/^(0|false)$/i.test(String(value));
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
  const httpGet = options.httpGet || http.get;
  const req = httpGet(
    { hostname: "127.0.0.1", port, path: STATE_PATH, timeout: timeoutMs },
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
      callback(false, null, "", 0);
      return;
    }
    post(port, payload, timeoutMs, (ok, confirmedPort, responseBody, statusCode) => {
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
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
  DEFAULT_HOOK_HTTP_TIMEOUT_MS,
  DEFAULT_SERVER_PORT,
  PERMISSION_PATH,
  REMOTE_HOOK_HTTP_TIMEOUT_MS,
  RUNTIME_CONFIG_PATH,
  SERVER_PORTS,
  STATE_PATH,
  buildPermissionUrl,
  clearRuntimeConfig,
  discoverClawdPort,
  getPortCandidates,
  getPermissionProbeTimeoutMs,
  getStatePostTimeoutMs,
  postPermissionToPort,
  postPermissionToRunningServer,
  postStateToRunningServer,
  probePort,
  readHostPrefix,
  readRuntimePort,
  resolveNodeBin,
  resolveNodeBinAsync,
  resolveWindowsNodeBinSync,
  resolveWindowsNodeBinAsync,
  validateWindowsNodeCandidate,
  splitPortCandidates,
  postStateToPort,
  writeRuntimeConfig,
};
