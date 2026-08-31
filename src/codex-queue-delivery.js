"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile: defaultExecFile } = require("child_process");
const {
  getCodexThreadId,
  isCodexQueueTarget,
  normalizeCodexThreadId,
} = require("./codex-thread-id");

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_BUFFER_BYTES = 64 * 1024;
const CODEX_QUEUE_UNSUPPORTED_RE = /(?:unexpected argument|unrecognized (?:sub)?command|unknown (?:sub)?command|invalid subcommand)/i;
const CODEX_QUEUE_UNCERTAIN_RE = /(?:timed? out|timeout|aborted|abort_err|killed)/i;
const WINDOWS_CMD_EXTENSIONS = new Set([".cmd", ".bat"]);
const WINDOWS_POWERSHELL_EXTENSIONS = new Set([".ps1"]);

function normalizeExecutable(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^"(.*)"$/, "$1");
}

// Windows environment names are case-insensitive, while plain object test
// doubles (and some embedders) preserve the spelling they were given. Read a
// known key using the same semantics before deriving executable paths.
function readEnvValue(env, name, { caseInsensitive = false } = {}) {
  if (!env || typeof env !== "object" || !name) return "";
  if (!caseInsensitive) {
    return Object.prototype.hasOwnProperty.call(env, name) ? env[name] : "";
  }
  const lowerName = String(name).toLowerCase();
  // Object spread preserves both `PATH` and `Path` when a caller overlays a
  // Windows environment with a plain object. The latter key is usually the
  // caller's intentional override, so use the last matching key rather than
  // letting an earlier exact spelling win.
  let value = "";
  for (const key of Object.keys(env)) {
    if (String(key).toLowerCase() === lowerName) value = env[key];
  }
  return value;
}

function pathKey(value, platform) {
  const text = normalizeExecutable(value);
  return platform === "win32" ? text.toLowerCase() : text;
}

function addCandidate(out, seen, value, { platform, existsSync, requireExists = false } = {}) {
  const candidate = normalizeExecutable(value);
  if (!candidate) return;
  const key = pathKey(candidate, platform);
  if (!key || seen.has(key)) return;
  if (requireExists && typeof existsSync === "function") {
    try {
      if (!existsSync(candidate)) return;
    } catch {
      return;
    }
  }
  seen.add(key);
  out.push(candidate);
}

function pathEntries(pathEnv, platform) {
  if (typeof pathEnv !== "string" || !pathEnv) return [];
  const delimiter = platform === "win32" ? ";" : ":";
  return pathEnv
    .split(delimiter)
    .map((value) => normalizeExecutable(value))
    .filter(Boolean);
}

function sortCodexInstallDirs(dirs, statSync) {
  return dirs.sort((left, right) => {
    let leftTime = 0;
    let rightTime = 0;
    try {
      const stat = statSync(left);
      leftTime = Number(stat && stat.mtimeMs) || 0;
    } catch {}
    try {
      const stat = statSync(right);
      rightTime = Number(stat && stat.mtimeMs) || 0;
    } catch {}
    if (rightTime !== leftTime) return rightTime - leftTime;
    return left.localeCompare(right);
  });
}

function isWindowsPathWithExtension(value, extensions) {
  const text = normalizeExecutable(value);
  if (!text) return false;
  return extensions.has(path.win32.extname(text).toLowerCase());
}

function quotePowerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const CODEX_SHIM_SOURCE_MAX_BYTES = 64 * 1024;

function readBoundedText(fsModule, filePath) {
  if (!fsModule || typeof fsModule.readFileSync !== "function") return "";
  let value;
  try {
    value = fsModule.readFileSync(filePath, {
      encoding: "utf8",
      flag: "r",
    });
  } catch {
    try {
      value = fsModule.readFileSync(filePath, "utf8");
    } catch {
      return "";
    }
  }
  return typeof value === "string" ? value.slice(0, CODEX_SHIM_SOURCE_MAX_BYTES) : "";
}

function resolveShimPathToken(token, candidate, pathModule, fsModule) {
  let value = String(token || "").trim();
  if (!value) return "";
  value = value.replace(/^['"]|['"]$/g, "");
  const candidateDir = pathModule.dirname(candidate);
  // npm's generated shims use `%dp0%` in cmd and `$basedir` in PowerShell.
  value = value
    .replace(/%dp0%/ig, candidateDir)
    .replace(/\$basedir/ig, candidateDir);
  if (!pathModule.isAbsolute(value)) value = pathModule.join(candidateDir, value);
  // Keep only paths that resolve to an existing regular file when the caller
  // supplied a filesystem implementation. A malformed shim must fall back to
  // the interpreter path instead of sending an invented script to Node.
  if (fsModule && typeof fsModule.existsSync === "function") {
    try {
      if (!fsModule.existsSync(value)) return "";
    } catch {
      return "";
    }
  }
  return value;
}

/**
 * Resolve the standard npm-generated Codex .cmd/.ps1 shim to its underlying
 * Node script. This avoids a second `%*` parse inside the shim, where cmd.exe
 * would expand percent sequences in a Telegram message even if the outer
 * invocation used an encoded PowerShell command. Unknown/custom PowerShell
 * shims use the encoded fallback below; unknown batch shims are skipped.
 */
function resolveNpmCodexShimInvocation(candidate, args, { fsModule = fs, pathModule = path.win32 } = {}) {
  const source = readBoundedText(fsModule, candidate);
  if (!source) return null;
  const scriptMatch = source.match(/(?:['"])([^'"]*node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js)(?:['"])/i);
  if (!scriptMatch) return null;
  const scriptPath = resolveShimPathToken(scriptMatch[1], candidate, pathModule, fsModule);
  if (!scriptPath) return null;

  const candidateDir = pathModule.dirname(candidate);
  const hasLocalNode = /(?:%dp0%|\$basedir)[\\/]node\.exe/i.test(source);
  let nodeBin = "node";
  if (hasLocalNode) {
    const localNode = pathModule.join(candidateDir, "node.exe");
    try {
      if (!fsModule || typeof fsModule.existsSync !== "function" || fsModule.existsSync(localNode)) {
        nodeBin = localNode;
      }
    } catch {}
  }
  return {
    command: nodeBin,
    args: [scriptPath, ...args],
    options: {},
    source: "npm-shim-direct",
  };
}

/**
 * Build an invocation for a Windows PowerShell shim. The encoded command is
 * decoded before parsing and each value is a literal single-quoted token.
 * Generic .cmd/.bat wrappers are deliberately excluded by the resolver below:
 * PowerShell invokes them through cmd.exe, which expands percent sequences in
 * arguments such as `%PATH%`. Standard npm batch shims are instead resolved to
 * their underlying Node script and never enter cmd.exe.
 */
function buildWindowsPowerShellShimInvocation(scriptPath, args, powerShellBin = "powershell.exe") {
  const command = [
    "$ErrorActionPreference = 'Stop';",
    "$clawdExitCode = $null;",
    "$clawdInvocationOk = $false;",
    "try { &",
    quotePowerShellLiteral(scriptPath),
    ...(Array.isArray(args) ? args : []).map(quotePowerShellLiteral),
    // A PowerShell shim reports native-child status through $LASTEXITCODE and
    // may call `exit` itself, in which case the remaining code is not reached.
    // Capture both forms before another statement can overwrite `$?`;
    // invocation errors must never fall through as exit 0.
    "; $clawdInvocationOk = $?; $clawdExitCode = $LASTEXITCODE }",
    "catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 };",
    "if ($null -ne $clawdExitCode) { exit [int]$clawdExitCode };",
    "if (-not $clawdInvocationOk) { exit 1 };",
    "exit 0",
  ].join(" ");
  return {
    command: powerShellBin,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(command, "utf16le").toString("base64"),
    ],
    options: {
      // The encoded payload is already a single safe argv token. Do not let
      // Node add another Windows command-line quoting layer around it.
      windowsVerbatimArguments: true,
    },
  };
}

function resolveWindowsShimInvocation(candidate, args, {
  env = process.env,
  fsModule = fs,
  pathModule = path.win32,
} = {}) {
  if (isWindowsPathWithExtension(candidate, WINDOWS_CMD_EXTENSIONS)) {
    const direct = resolveNpmCodexShimInvocation(candidate, args, { fsModule, pathModule });
    if (direct) return direct;
    // PowerShell ultimately dispatches a batch file through cmd.exe. Its `%*`
    // expansion reinterprets percent-delimited text from the Telegram reply,
    // so an unknown batch wrapper is not a lossless delivery channel.
    return null;
  }
  if (isWindowsPathWithExtension(candidate, WINDOWS_POWERSHELL_EXTENSIONS)) {
    const direct = resolveNpmCodexShimInvocation(candidate, args, { fsModule, pathModule });
    if (direct) return direct;
    const configuredPowerShell = normalizeExecutable(
      readEnvValue(env, "CLAWD_POWERSHELL_PATH", { caseInsensitive: true })
      || readEnvValue(env, "POWERSHELL_PATH", { caseInsensitive: true }),
    );
    return buildWindowsPowerShellShimInvocation(
      candidate,
      args,
      configuredPowerShell || "powershell.exe",
    );
  }
  return { command: candidate, args, options: {} };
}

function mergedExecutionEnv(env, platform = process.platform) {
  const base = process && process.env && typeof process.env === "object"
    ? process.env
    : {};
  const source = env && typeof env === "object" ? env : {};
  const out = { ...base };
  const caseInsensitive = platform === "win32";
  for (const [key, value] of Object.entries(source)) {
    if (!key) continue;
    if (caseInsensitive) {
      const lowerKey = String(key).toLowerCase();
      // Windows treats environment names case-insensitively. Remove an older
      // spelling before applying the overlay so the child process cannot see
      // contradictory PATH/CODEX_HOME values.
      for (const existingKey of Object.keys(out)) {
        if (existingKey !== key && String(existingKey).toLowerCase() === lowerKey) {
          delete out[existingKey];
        }
      }
    }
    if (value === undefined || value === null) {
      delete out[key];
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

function appendWindowsCodexRootCandidates({
  add,
  root,
  pathModule,
  fsModule,
  statSync,
}) {
  const normalizedRoot = normalizeExecutable(root);
  if (!normalizedRoot) return;

  // Current standalone installs expose bin/codex.exe directly. The Desktop
  // runtime uses versioned children below its bin directory, while older
  // standalone layouts put a `bin` child below each release directory.
  add(pathModule.join(normalizedRoot, "codex.exe"), true);
  let entries = [];
  try {
    entries = fsModule && typeof fsModule.readdirSync === "function"
      ? fsModule.readdirSync(normalizedRoot, { withFileTypes: true })
      : [];
  } catch {}
  const dirs = entries
    .filter((entry) => entry && (
      (typeof entry.isDirectory === "function" && entry.isDirectory())
      || typeof entry === "string"
    ))
    .map((entry) => pathModule.join(normalizedRoot, typeof entry === "string" ? entry : entry.name));
  sortCodexInstallDirs(dirs, statSync);
  for (const dir of dirs) {
    add(pathModule.join(dir, "codex.exe"), true);
    add(pathModule.join(dir, "bin", "codex.exe"), true);
  }
}

/**
 * Return likely Codex executables in delivery preference order. The Desktop
 * app installs a native codex.exe beside its app-server, while PATH may still
 * point at an older Scoop/npm wrapper without the `queue` command. Keep both
 * families so the adapter can choose the first one that understands queue.
 */
function resolveCodexQueueExecutableCandidates({
  platform = process.platform,
  env = process.env,
  fsModule = fs,
  homeDir = os.homedir(),
  pathModule = platform === "win32" ? path.win32 : path.posix,
} = {}) {
  const out = [];
  const seen = new Set();
  const existsSync = fsModule && typeof fsModule.existsSync === "function"
    ? fsModule.existsSync.bind(fsModule)
    : null;
  const add = (value, requireExists = false) => addCandidate(out, seen, value, {
    platform,
    existsSync,
    requireExists,
  });
  const read = (name) => readEnvValue(env, name, { caseInsensitive: platform === "win32" });

  // An explicit path is useful for portable installs and for the environment
  // Codex Desktop uses when it launches hooks.
  add(read("CODEX_CLI_PATH"), false);

  if (platform === "win32") {
    const localAppData = normalizeExecutable(read("LOCALAPPDATA"))
      || pathModule.join(homeDir || "", "AppData", "Local");
    const statSync = fsModule && typeof fsModule.statSync === "function"
      ? fsModule.statSync.bind(fsModule)
      : () => ({ mtimeMs: 0 });
    const programFiles = [
      normalizeExecutable(read("ProgramW6432")),
      normalizeExecutable(read("ProgramFiles")),
      normalizeExecutable(read("ProgramFiles(x86)")),
    ].filter(Boolean);
    const codexHome = normalizeExecutable(read("CODEX_HOME"))
      || pathModule.join(homeDir || "", ".codex");
    const roots = [
      // This adapter is selected only for a Codex Desktop-originated session,
      // so prefer the app-managed runtime that owns the active thread store.
      pathModule.join(localAppData, "OpenAI", "Codex", "bin"),
      // Official standalone installer layout. Keep this ahead of PATH because
      // an old npm/Scoop shim can shadow the native queue-capable binary.
      pathModule.join(localAppData, "Programs", "OpenAI", "Codex", "bin"),
      pathModule.join(localAppData, "Programs", "Codex", "bin"),
      // Standalone package cache fallback. `current` is a junction on recent
      // installers; releases/* is retained for older layouts.
      pathModule.join(codexHome, "packages", "standalone", "current", "bin"),
      pathModule.join(codexHome, "packages", "standalone", "releases"),
      ...programFiles.flatMap((base) => [
        pathModule.join(base, "OpenAI", "Codex", "bin"),
        pathModule.join(base, "Codex", "bin"),
      ]),
    ];
    const seenRoots = new Set();
    for (const root of roots) {
      const key = pathKey(root, platform);
      if (!key || seenRoots.has(key)) continue;
      seenRoots.add(key);
      appendWindowsCodexRootCandidates({
        add,
        root,
        pathModule,
        fsModule,
        statSync,
      });
    }

    // Prefer native executables in PATH over .cmd/.ps1 shims. The latter are
    // retained as a final compatibility candidate when no native binary exists.
    const pathEnv = read("PATH");
    for (const dir of pathEntries(pathEnv, platform)) {
      add(pathModule.join(dir, "codex.exe"), true);
    }
    for (const dir of pathEntries(pathEnv, platform)) {
      add(pathModule.join(dir, "codex.cmd"), true);
      add(pathModule.join(dir, "codex.ps1"), true);
    }
    add("codex.exe");
    add("codex");
  } else {
    for (const dir of pathEntries(read("PATH"), platform)) {
      add(pathModule.join(dir, "codex"), true);
    }
    add("codex");
  }

  return out;
}

function execFileAsync(execFile, command, args, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    try {
      execFile(command, args, options, (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          finish(reject, err);
          return;
        }
        finish(resolve, { stdout, stderr });
      });
    } catch (err) {
      finish(reject, err);
    }
  });
}

function errorText(error) {
  if (!error) return "";
  return [error.message, error.stdout, error.stderr]
    .filter((value) => typeof value === "string" && value)
    .join("\n")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 1000);
}

function classifyQueueError(error) {
  const text = errorText(error);
  const code = error && error.code;
  if (
    code === "ENOENT"
    || code === "ENOTFOUND"
    || code === "EACCES"
    || code === "EPERM"
    // Node reports direct attempts to execute .cmd/.ps1 on Windows as these
    // platform-specific spawn errors. They are candidate availability issues,
    // not a failed queue submission, so probing must continue.
    || code === "EINVAL"
    || code === "EFTYPE"
    || code === "ENOEXEC"
  ) {
    return "codex_queue_unavailable";
  }
  if (CODEX_QUEUE_UNSUPPORTED_RE.test(text)) return "codex_queue_unsupported";
  if (error && (error.name === "AbortError" || code === "ABORT_ERR")) {
    return "direct_send_cancelled";
  }
  if (error && (
    error.killed === true
    || error.signal
    || code === "ETIMEDOUT"
    || CODEX_QUEUE_UNCERTAIN_RE.test(text)
  )) {
    return "codex_queue_result_unknown";
  }
  if (/(?:no active session found matching|no rollout found|invalid thread|failed to read thread|thread-store)/i.test(text)) {
    return "codex_thread_not_found";
  }
  return "codex_queue_failed";
}

function effectiveTimeout(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 250
    ? Math.min(30000, Math.floor(numeric))
    : DEFAULT_TIMEOUT_MS;
}

function createCodexQueueDeliveryAdapter({
  execFile = defaultExecFile,
  executable = null,
  executableCandidates = null,
  env = process.env,
  fsModule = fs,
  homeDir = os.homedir(),
  osPlatform = process.platform,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBuffer = MAX_BUFFER_BYTES,
  log = () => {},
} = {}) {
  let cachedExecutable = normalizeExecutable(executable) || null;
  const executionEnv = mergedExecutionEnv(env, osPlatform);

  function safeLog(level, message, meta) {
    try { log(level, message, meta); } catch {}
  }

  function candidates() {
    const configured = Array.isArray(executableCandidates)
      ? executableCandidates
      : resolveCodexQueueExecutableCandidates({
        platform: osPlatform,
        env: executionEnv,
        fsModule,
        homeDir,
      });
    const out = [];
    const seen = new Set();
    const add = (value) => addCandidate(out, seen, value, { platform: osPlatform });
    add(cachedExecutable);
    for (const value of configured || []) add(value);
    return out;
  }

  async function deliver(payload = {}) {
    if (payload.signal && payload.signal.aborted) {
      return { status: "failed", delivered: false, errorClass: "direct_send_cancelled" };
    }
    const entry = payload.entry;
    if (!isCodexQueueTarget(entry)) {
      return { status: "failed", delivered: false, errorClass: "codex_thread_id_invalid" };
    }
    const threadId = getCodexThreadId(entry);
    const promptText = typeof payload.promptText === "string" ? payload.promptText : "";
    if (!threadId || !normalizeCodexThreadId(threadId)) {
      return { status: "failed", delivered: false, errorClass: "codex_thread_id_invalid" };
    }
    if (!promptText) {
      return { status: "failed", delivered: false, errorClass: "empty_prompt" };
    }

    const args = ["queue", "--thread", threadId, "--message", promptText];
    const failures = [];
    for (const candidate of candidates()) {
      if (payload.signal && payload.signal.aborted) {
        return { status: "failed", delivered: false, errorClass: "direct_send_cancelled" };
      }
      try {
        const invocation = osPlatform === "win32"
          ? resolveWindowsShimInvocation(candidate, args, {
            env: executionEnv,
            fsModule,
            pathModule: path.win32,
          })
          : { command: candidate, args, options: {} };
        if (!invocation) {
          failures.push({ candidate, errorClass: "codex_queue_unavailable" });
          if (candidate === cachedExecutable) cachedExecutable = null;
          continue;
        }
        await execFileAsync(execFile, invocation.command, invocation.args, {
          windowsHide: osPlatform === "win32",
          timeout: effectiveTimeout(timeoutMs),
          maxBuffer: Math.max(1024, Number(maxBuffer) || MAX_BUFFER_BYTES),
          encoding: "utf8",
          env: executionEnv,
          ...invocation.options,
          ...(payload.signal ? { signal: payload.signal } : {}),
        });
        cachedExecutable = candidate;
        safeLog("debug", "codex queue delivery succeeded", {
          executable: candidate,
          threadId,
        });
        return {
          status: "queued",
          delivered: true,
          autoEnter: true,
          errorClass: null,
        };
      } catch (error) {
        const errorClass = classifyQueueError(error);
        failures.push({ candidate, errorClass });
        // An old CLI or an unavailable shim is not the final answer: try the
        // next installed Codex binary, especially the Desktop-side executable.
        if (errorClass === "codex_queue_unsupported" || errorClass === "codex_queue_unavailable") {
          if (candidate === cachedExecutable) cachedExecutable = null;
          continue;
        }
        safeLog("warn", "codex queue delivery failed", {
          executable: candidate,
          threadId,
          errorClass,
        });
        return { status: "failed", delivered: false, errorClass };
      }
    }

    const finalError = failures.find((item) => item.errorClass !== "codex_queue_unsupported")
      || failures[failures.length - 1];
    const errorClass = finalError ? finalError.errorClass : "codex_queue_unavailable";
    safeLog("warn", "no Codex executable accepted queue delivery", {
      threadId,
      errorClass,
      candidates: failures.map((item) => item.candidate),
    });
    return { status: "failed", delivered: false, errorClass };
  }

  return {
    requiresFocus: false,
    requiresMappedAgentPid: false,
    requiresFocusableTarget: false,
    requiresPidDisambiguation: false,
    canDeliver: isCodexQueueTarget,
    deliver,
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_BUFFER_BYTES,
  buildWindowsPowerShellShimInvocation,
  classifyQueueError,
  createCodexQueueDeliveryAdapter,
  getCodexThreadId,
  isCodexQueueTarget,
  normalizeCodexThreadId,
  resolveNpmCodexShimInvocation,
  resolveCodexQueueExecutableCandidates,
};
