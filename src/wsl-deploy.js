"use strict";

// One-click WSL integration deployment. Persistent command-hook integrations
// keep their historical ~/.claude/hooks payload. Asset-backed integrations
// such as Hermes use a private, exact, ephemeral payload instead.

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const wslUtils = require("./wsl-utils");

const HERMES_RESULT_SENTINEL = "CLAWD_HERMES_RESULT_V1=";
const HERMES_TEMP_SENTINEL = "CLAWD_HERMES_TMP_V1=";
const HERMES_TEMP_PARENT = "/tmp";
const HERMES_TEMP_TEMPLATE = "/tmp/clawd-hermes-XXXXXXXX";
const HERMES_TEMP_BASENAME_RE = /^clawd-hermes-[A-Za-z0-9]{8}$/;
const HERMES_WSL_FILES = Object.freeze([
  "hermes-install.js",
  "json-utils.js",
  "wsl-connectivity-probe.js",
  "server-config.js",
  "hermes-plugin/plugin.yaml",
  "hermes-plugin/__init__.py",
]);

const AGENT_WSL_OPTIONS = Object.freeze({
  hermes: Object.freeze({
    staging: "ephemeral",
    structuredResult: true,
    files: HERMES_WSL_FILES,
  }),
});

// All top-level .js files are retained for existing persistent hook agents.
function collectHookFiles(hooksDir) {
  const files = [];
  try {
    for (const name of fs.readdirSync(hooksDir)) {
      if (!name.endsWith(".js")) continue;
      const full = path.join(hooksDir, name);
      if (!fs.statSync(full).isFile()) continue;
      files.push({ name, relativePath: name, path: full, content: fs.readFileSync(full, "utf8") });
    }
  } catch (err) {
    console.warn("Clawd: collectHookFiles failed:", err && err.message ? err.message : err);
    throw err;
  }
  return files;
}

function validateDeployRelativePath(value) {
  if (typeof value !== "string" || !value) throw new Error("deploy path must be a non-empty string");
  if (value.includes("\0") || value.includes("\\") || value.includes("\r") || value.includes("\n")) {
    throw new Error(`invalid deploy path: ${JSON.stringify(value)}`);
  }
  if (path.posix.isAbsolute(value)) throw new Error(`absolute deploy path is not allowed: ${value}`);
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`unsafe deploy path: ${value}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value) throw new Error(`non-canonical deploy path: ${value}`);
  return normalized;
}

function collectAgentWslFiles(hooksDir, agentId) {
  const agentOptions = AGENT_WSL_OPTIONS[agentId];
  if (!agentOptions || !Array.isArray(agentOptions.files)) return collectHookFiles(hooksDir);

  const root = path.resolve(hooksDir);
  const seen = new Set();
  const files = [];
  for (const configuredPath of agentOptions.files) {
    const relativePath = validateDeployRelativePath(configuredPath);
    if (seen.has(relativePath)) throw new Error(`duplicate deploy destination: ${relativePath}`);
    seen.add(relativePath);

    const sourcePath = path.resolve(root, ...relativePath.split("/"));
    if (sourcePath !== root && !sourcePath.startsWith(`${root}${path.sep}`)) {
      throw new Error(`deploy source escapes hooks directory: ${relativePath}`);
    }
    let stat;
    try {
      stat = fs.lstatSync(sourcePath);
    } catch (err) {
      if (err && err.code === "ENOENT") throw new Error(`required WSL deploy file is missing: ${relativePath}`);
      throw err;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`WSL deploy source must be a regular non-symlink file: ${relativePath}`);
    }
    files.push({
      name: relativePath,
      relativePath,
      path: sourcePath,
      content: fs.readFileSync(sourcePath),
    });
  }
  return files;
}

// Map agentId to the install script that runs in WSL.
const AGENT_INSTALL_SCRIPT = {
  "claude-code": "install.js",
  codex: "codex-install.js",
  "copilot-cli": "copilot-install.js",
  "cursor-agent": "cursor-install.js",
  "gemini-cli": "gemini-install.js",
  "antigravity-cli": "antigravity-install.js",
  codebuddy: "codebuddy-install.js",
  // WorkBuddy has no standalone Linux/WSL runtime.
  "kiro-cli": "kiro-install.js",
  "kimi-cli": "kimi-install.js",
  "qwen-code": "qwen-code-install.js",
  zcode: "zcode-install.js",
  codewhale: "codewhale-install.js",
  // OpenCode / MiMo / Pi / OpenClaw remain unsupported until their complete
  // WSL runtime behavior is independently validated.
  hermes: "hermes-install.js",
  qoder: "qoder-install.js",
  reasonix: "reasonix-install.js",
  qoderwork: "qoderwork-install.js",
  // QwenWork has no standalone Linux/WSL runtime: https://qwenwork.cn/download
  // ships macOS 14+, Windows 10+ and HarmonyOS 6.1+ only. Mapping it here would
  // create a Pair entry that writes hooks into the distro HOME
  // (~/.QwenWorkCN/settings.json inside WSL), which the Windows QwenWork
  // desktop app never reads.
};

function getAgentWslOptions(agentId) {
  return AGENT_WSL_OPTIONS[agentId] || null;
}

function getInstallScript(agentId) {
  return getAgentInstallScriptName(agentId);
}

function getAgentInstallArgs(agentId) {
  return agentId === "codebuddy" ? "--permission-url preserve" : "";
}

// install.js does not implement --uninstall; Claude uses uninstall.js.
const AGENT_UNINSTALL_COMMAND = {
  "claude-code": "uninstall.js",
};

function getAgentUninstallCommand(agentId) {
  if (AGENT_UNINSTALL_COMMAND[agentId]) return AGENT_UNINSTALL_COMMAND[agentId];
  const installScript = getAgentInstallScriptName(agentId);
  return installScript ? `${installScript} --uninstall` : null;
}

function resolveHooksDir({ isPackaged, resourcesPath } = {}) {
  if (isPackaged) {
    const root = resourcesPath || process.resourcesPath;
    if (typeof root !== "string" || !root) throw new Error("resourcesPath is required for packaged WSL deploy");
    return path.join(root, "app.asar.unpacked", "hooks");
  }
  return path.join(__dirname, "..", "hooks");
}

function quotePosix(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function isSafeAbsolutePosixPath(value) {
  return typeof value === "string"
    && value.startsWith("/")
    && !value.includes("\0")
    && !value.includes("\r")
    && !value.includes("\n")
    && !value.includes("\\");
}

function getDependency(options, name, fallback) {
  return options && typeof options[name] === "function" ? options[name] : fallback;
}

function isWindowsFor(options) {
  return getDependency(options, "isWindows", wslUtils.isWindows)();
}

// Pipe bytes into a validated path below one WSL directory.
function pipeFileToWsl(distro, wslDestDir, fileName, content, options = {}) {
  let relativePath;
  try {
    relativePath = validateDeployRelativePath(fileName);
    if (!isSafeAbsolutePosixPath(wslDestDir)) throw new Error("invalid WSL destination directory");
  } catch (err) {
    return Promise.resolve({ ok: false, fileName, error: err.message });
  }

  return new Promise((resolve) => {
    const root = wslDestDir.replace(/\/+$/, "");
    const safePath = `${root}/${relativePath}`;
    const parentDir = path.posix.dirname(safePath);
    const cmd = `mkdir -p -- ${quotePosix(parentDir)} && cat > ${quotePosix(safePath)}`;
    const spawn = getDependency(options, "spawn", childProcess.spawn);
    let child;
    try {
      child = spawn("wsl.exe", ["-d", distro, "--", "bash", "-c", cmd], {
        env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, fileName: relativePath, error: err && err.message ? err.message : "spawn failed" });
      return;
    }

    const stderrChunks = [];
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch {}
      resolve({ ok: false, fileName: relativePath, error: "timeout" });
    }, options.timeout || 30000);

    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, fileName: relativePath, error: err && err.message ? err.message : "spawn failed" });
    });
    if (child.stderr) child.stderr.on("data", (data) => { stderrChunks.push(data); });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      resolve(code === 0
        ? { ok: true, fileName: relativePath, stderr: stderr || null }
        : { ok: false, fileName: relativePath, error: stderr || `exit code ${code}` });
    });

    if (!child.stdin) {
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, fileName: relativePath, error: "no stdin" });
      return;
    }
    child.stdin.on("error", () => {});
    if (Buffer.isBuffer(content)) child.stdin.end(content);
    else child.stdin.end(content, "utf8");
  });
}

function parseConnectivityProbe(stdout) {
  const text = typeof stdout === "string" ? stdout : "";
  const match = text.match(/^REACHABLE (\d+)$/m);
  if (match) return { reachable: true, port: parseInt(match[1], 10) };
  if (/^UNREACHABLE$/m.test(text)) return { reachable: false, port: null };
  return { reachable: null, port: null };
}

function parseHermesInstallerResult(stdout, expectedOperation) {
  const text = typeof stdout === "string" ? stdout : "";
  const lines = text.split(/\r?\n/).filter((line) => line.startsWith(HERMES_RESULT_SENTINEL));
  if (lines.length !== 1) return { ok: false, error: "Hermes installer did not return exactly one result sentinel" };
  let result;
  try {
    result = JSON.parse(lines[0].slice(HERMES_RESULT_SENTINEL.length));
  } catch (err) {
    return { ok: false, error: `Hermes installer returned invalid JSON: ${err.message}` };
  }
  if (!result || result.schemaVersion !== 1) return { ok: false, error: "Unsupported Hermes installer result schema" };
  if (!["ok", "warning", "error"].includes(result.status)) return { ok: false, error: "Invalid Hermes installer result status" };
  if (expectedOperation && result.operation !== expectedOperation) return { ok: false, error: "Hermes installer returned the wrong operation" };
  return { ok: true, result };
}

function parseHermesTempDir(stdout) {
  const text = typeof stdout === "string" ? stdout.trim() : "";
  if (!text || text.includes("\n") || text.includes("\r") || !text.startsWith(HERMES_TEMP_SENTINEL)) return null;
  const value = text.slice(HERMES_TEMP_SENTINEL.length);
  if (!isSafeAbsolutePosixPath(value)) return null;
  if (path.posix.dirname(value) !== HERMES_TEMP_PARENT) return null;
  if (!HERMES_TEMP_BASENAME_RE.test(path.posix.basename(value))) return null;
  return value;
}

async function createHermesTempDir(distro, options = {}) {
  const execInWsl = getDependency(options, "execInWsl", wslUtils.execInWsl);
  // wsl.exe can subject the command string to an outer Linux shell before
  // the requested bash -c. Avoid a local shell variable here: the outer
  // shell would expand it before mktemp assigns it in the inner shell.
  const command = `set -o pipefail; umask 077; mktemp -d ${HERMES_TEMP_TEMPLATE} | sed 's#^#${HERMES_TEMP_SENTINEL}#'`;
  let result;
  try {
    result = await execInWsl(distro, command, { ...options, timeout: 15000 });
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : "Could not create Hermes WSL staging directory" };
  }
  if (!result || result.code !== 0) {
    return { ok: false, error: (result && result.stderr) || "Could not create Hermes WSL staging directory" };
  }
  const tempDir = parseHermesTempDir(result.stdout);
  if (!tempDir) return { ok: false, error: "WSL returned an unsafe Hermes staging directory" };
  return { ok: true, tempDir };
}

async function cleanupHermesTempDir(distro, tempDir, options = {}) {
  if (parseHermesTempDir(`${HERMES_TEMP_SENTINEL}${tempDir}`) !== tempDir) {
    return { ok: false, error: "Refusing to clean an unsafe Hermes staging directory" };
  }
  const execInWsl = getDependency(options, "execInWsl", wslUtils.execInWsl);
  let result;
  try {
    result = await execInWsl(distro, `rm -rf -- ${quotePosix(tempDir)}`, { ...options, timeout: 30000 });
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : "Hermes staging cleanup failed" };
  }
  return result && result.code === 0
    ? { ok: true }
    : { ok: false, error: (result && (result.stderr || (result.error && result.error.message))) || "Hermes staging cleanup failed" };
}

function appendWarning(result, warning, field = "warning") {
  if (!warning) return result;
  const warnings = Array.isArray(result.warnings) ? [...result.warnings, warning] : [warning];
  return { ...result, [field]: field === "warning" ? warnings.join("\n") : warning, warnings };
}

function mergeCleanupResult(operation, cleanup) {
  if (cleanup && cleanup.ok) return { ...operation, stagingRemoved: true };
  const warning = `Hermes WSL staging cleanup failed: ${(cleanup && cleanup.error) || "unknown error"}`;
  if (operation && operation.ok) return { ...appendWarning(operation, warning), stagingRemoved: false };
  return { ...appendWarning(operation || { ok: false }, warning, "cleanupWarning"), stagingRemoved: false };
}

async function copyEntriesToWsl(distro, targetDir, entries, options, emit) {
  const upload = getDependency(options, "pipeFileToWsl", pipeFileToWsl);
  let copied = 0;
  const errors = [];
  emit("copy-files", "start");
  for (const entry of entries) {
    const relativePath = entry.relativePath || entry.name;
    let result;
    try {
      result = await upload(distro, targetDir, relativePath, entry.content, options);
    } catch (err) {
      result = { ok: false, fileName: relativePath, error: err && err.message ? err.message : String(err) };
    }
    if (result && result.ok) {
      copied++;
      if (result.stderr) emit("copy-files", "stderr", null, { fileName: relativePath, stderr: result.stderr.slice(0, 200) });
    } else {
      errors.push(result || { fileName: relativePath, error: "upload failed" });
    }
  }
  if (errors.length) {
    const names = errors.map((entry) => entry.fileName).join(", ");
    const message = `Failed to copy ${errors.length} file(s): ${names}`;
    emit("copy-files", "fail", message);
    return { ok: false, copied, errors, message };
  }
  emit("copy-files", "ok", null, { copied, total: entries.length });
  return { ok: true, copied };
}

function progressEmitter(distro, options) {
  return (step, status, message, hint) => {
    if (typeof options.onProgress === "function") {
      options.onProgress({ distro, step, status, message: message || null, hint: hint || null });
    }
  };
}

async function deployHermesToWsl(distro, hooksDir, entries, options, emit) {
  const execInWsl = getDependency(options, "execInWsl", wslUtils.execInWsl);
  emit("prepare-dir", "start");
  const prepared = await createHermesTempDir(distro, options);
  if (!prepared.ok) {
    emit("prepare-dir", "fail", prepared.error);
    return { ok: false, step: "prepare-dir", message: prepared.error };
  }
  emit("prepare-dir", "ok", null, { staging: "ephemeral" });

  const tempDir = prepared.tempDir;
  const escapedDir = quotePosix(tempDir);
  let operation;
  try {
    const copied = await copyEntriesToWsl(distro, tempDir, entries, options, emit);
    if (!copied.ok) {
      operation = { ok: false, step: "copy-files", message: copied.message, errors: copied.errors };
    } else {
      emit("run-install", "start");
      const runResult = await execInWsl(
        distro,
        `cd ${escapedDir} && node hermes-install.js --json`,
        { ...options, shell: "bash", shellFlags: ["-l", "-i", "-c"], timeout: 60000 }
      );
      const parsed = parseHermesInstallerResult(runResult && runResult.stdout, "install");
      if (!parsed.ok || !runResult || runResult.code !== 0 || parsed.result.status === "error") {
        const message = parsed.ok
          ? parsed.result.message
          : (parsed.error || (runResult && runResult.stderr) || "Hermes installer failed");
        emit("run-install", "fail", message);
        operation = { ok: false, step: "run-install", message };
      } else {
        emit("run-install", parsed.result.status === "warning" ? "warn" : "ok", parsed.result.message);
        emit("verify-connectivity", "start");
        const probeResult = await execInWsl(
          distro,
          `cd ${escapedDir} && node wsl-connectivity-probe.js`,
          { ...options, shell: "bash", shellFlags: ["-l", "-i", "-c"], timeout: 20000 }
        );
        const connectivity = parseConnectivityProbe(probeResult && probeResult.stdout);
        if (connectivity.reachable === true) emit("verify-connectivity", "ok", null, { port: connectivity.port });
        else if (connectivity.reachable === false) emit("verify-connectivity", "warn", "Clawd HTTP server unreachable from WSL (NAT networking?)");
        else emit("verify-connectivity", "skip", (probeResult && probeResult.stderr) || null);

        operation = {
          ok: true,
          distro,
          agentId: "hermes",
          message: parsed.result.message,
          filesCopied: copied.copied,
          connectivity: connectivity.reachable,
          connectivityPort: connectivity.port,
          installerResult: parsed.result,
        };
        if (parsed.result.status === "warning") {
          operation = appendWarning(operation, parsed.result.warning || parsed.result.message);
        }
      }
    }
  } catch (err) {
    operation = { ok: false, step: "exception", message: err && err.message ? err.message : String(err) };
  }

  const cleanup = await cleanupHermesTempDir(distro, tempDir, options);
  return mergeCleanupResult(operation, cleanup);
}

async function deployPersistentToWsl(distro, agentId, installScript, entries, options, emit) {
  const getWslHomeDir = getDependency(options, "getWslHomeDir", wslUtils.getWslHomeDir);
  const execInWsl = getDependency(options, "execInWsl", wslUtils.execInWsl);
  emit("prepare-dir", "start");
  const wslHome = await getWslHomeDir(distro, options);
  if (!wslHome) {
    const message = `Could not resolve $HOME in WSL ${distro}`;
    emit("prepare-dir", "fail", message);
    return { ok: false, step: "prepare-dir", message };
  }
  const hooksTargetDir = `${wslHome}/.claude/hooks`;
  const mkdirResult = await execInWsl(distro, `mkdir -p ${quotePosix(hooksTargetDir)}`, options);
  if (!mkdirResult || mkdirResult.code !== 0) {
    const message = (mkdirResult && mkdirResult.stderr) || "mkdir failed";
    emit("prepare-dir", "fail", message);
    return { ok: false, step: "prepare-dir", message };
  }
  emit("prepare-dir", "ok", null, { hooksTargetDir });

  const copied = await copyEntriesToWsl(distro, hooksTargetDir, entries, options, emit);
  if (!copied.ok) return { ok: false, step: "copy-files", message: copied.message, errors: copied.errors };

  emit("run-install", "start");
  const distroEscaped = distro.replace(/'/g, "'\\''");
  const installArgs = getAgentInstallArgs(agentId);
  const runResult = await execInWsl(
    distro,
    `cd ${quotePosix(hooksTargetDir)} && CLAWD_WSL_DISTRO='${distroEscaped}' node ${installScript}${installArgs ? ` ${installArgs}` : ""}`,
    { ...options, shell: "bash", shellFlags: ["-l", "-i", "-c"], timeout: 60000 }
  );
  if (!runResult || runResult.code !== 0) {
    const message = (runResult && runResult.stderr) || `${installScript} failed`;
    emit("run-install", "fail", message);
    return { ok: false, step: "run-install", message };
  }
  emit("run-install", "ok");

  emit("verify-connectivity", "start");
  const probeResult = await execInWsl(
    distro,
    `cd ${quotePosix(hooksTargetDir)} && node wsl-connectivity-probe.js`,
    { ...options, shell: "bash", shellFlags: ["-l", "-i", "-c"], timeout: 20000 }
  );
  const connectivity = parseConnectivityProbe(probeResult && probeResult.stdout);
  if (connectivity.reachable === true) emit("verify-connectivity", "ok", null, { port: connectivity.port });
  else if (connectivity.reachable === false) emit("verify-connectivity", "warn", "Clawd HTTP server unreachable from WSL (NAT networking?)");
  else emit("verify-connectivity", "skip", (probeResult && probeResult.stderr) || null);

  return {
    ok: true,
    distro,
    agentId,
    hooksTargetDir,
    filesCopied: copied.copied,
    connectivity: connectivity.reachable,
    connectivityPort: connectivity.port,
  };
}

async function deployToWsl(distro, options = {}) {
  if (!isWindowsFor(options)) return { ok: false, step: "platform", message: "WSL deploy only runs on Windows" };
  if (!distro) return { ok: false, step: "args", message: "distro name is required" };

  const agentId = options.agentId || "claude-code";
  const installScript = getInstallScript(agentId);
  if (!installScript) return { ok: false, step: "unsupported", message: `WSL deploy is not supported for ${agentId}` };

  const emit = progressEmitter(distro, options);
  emit("verify-files", "start");
  let hooksDir;
  let entries;
  try {
    hooksDir = options.hooksDir || resolveHooksDir(options);
    entries = collectAgentWslFiles(hooksDir, agentId);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    emit("verify-files", "fail", message);
    return { ok: false, step: "verify-files", message };
  }
  if (!entries.length || !entries.some((entry) => entry.relativePath === installScript)) {
    const message = !entries.length ? `No hook files found in ${hooksDir}` : `Install script ${installScript} not found in ${hooksDir}`;
    emit("verify-files", "fail", message);
    return { ok: false, step: "verify-files", message };
  }
  emit("verify-files", "ok", null, { fileCount: entries.length });

  return agentId === "hermes"
    ? deployHermesToWsl(distro, hooksDir, entries, options, emit)
    : deployPersistentToWsl(distro, agentId, installScript, entries, options, emit);
}

async function removeHermesFromWsl(distro, options, emit) {
  emit("verify-files", "start");
  let entries;
  try {
    const hooksDir = options.hooksDir || resolveHooksDir(options);
    entries = collectAgentWslFiles(hooksDir, "hermes");
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    emit("verify-files", "fail", message);
    return { ok: false, step: "verify-files", message };
  }
  emit("verify-files", "ok", null, { fileCount: entries.length });

  emit("prepare-dir", "start");
  const prepared = await createHermesTempDir(distro, options);
  if (!prepared.ok) {
    emit("prepare-dir", "fail", prepared.error);
    return { ok: false, step: "prepare-dir", message: prepared.error };
  }
  emit("prepare-dir", "ok", null, { staging: "ephemeral" });

  const tempDir = prepared.tempDir;
  let operation;
  try {
    const copied = await copyEntriesToWsl(distro, tempDir, entries, options, emit);
    if (!copied.ok) {
      operation = { ok: false, step: "copy-files", message: copied.message, errors: copied.errors };
    } else {
      emit("remove", "start");
      const execInWsl = getDependency(options, "execInWsl", wslUtils.execInWsl);
      const result = await execInWsl(
        distro,
        `cd ${quotePosix(tempDir)} && node hermes-install.js --uninstall --json`,
        { ...options, shell: "bash", shellFlags: ["-l", "-i", "-c"], timeout: 60000 }
      );
      const parsed = parseHermesInstallerResult(result && result.stdout, "uninstall");
      if (!parsed.ok || !result || result.code !== 0 || parsed.result.status === "error") {
        const message = parsed.ok ? parsed.result.message : (parsed.error || (result && result.stderr) || "Hermes uninstaller failed");
        emit("remove", "fail", message);
        operation = { ok: false, step: "remove", message };
      } else {
        emit("remove", parsed.result.status === "warning" ? "warn" : "ok", parsed.result.message);
        operation = {
          ok: true,
          distro,
          agentId: "hermes",
          message: parsed.result.message,
          filesRemoved: true,
          installerResult: parsed.result,
        };
        if (parsed.result.status === "warning") {
          operation = appendWarning(operation, parsed.result.warning || parsed.result.message);
        }
      }
    }
  } catch (err) {
    operation = { ok: false, step: "exception", message: err && err.message ? err.message : String(err) };
  }
  const cleanup = await cleanupHermesTempDir(distro, tempDir, options);
  return mergeCleanupResult(operation, cleanup);
}

async function removePersistentFromWsl(distro, options, emit) {
  const getWslHomeDir = getDependency(options, "getWslHomeDir", wslUtils.getWslHomeDir);
  const execInWsl = getDependency(options, "execInWsl", wslUtils.execInWsl);
  const wslHome = await getWslHomeDir(distro, options);
  if (!wslHome) return { ok: false, step: "home", message: `Could not resolve $HOME in WSL ${distro}` };

  const hooksDir = `${wslHome}/.claude/hooks`;
  const agentId = options.agentId || "claude-code";
  emit("remove", "start");
  const uninstallCommand = getAgentUninstallCommand(agentId);
  if (uninstallCommand) {
    const uninstallResult = await execInWsl(
      distro,
      `cd ${quotePosix(hooksDir)} && node ${uninstallCommand}`,
      { ...options, shell: "bash", shellFlags: ["-l", "-i", "-c"], timeout: 30000 }
    );
    if (!uninstallResult || uninstallResult.code !== 0) {
      emit("remove", "stderr", (uninstallResult && uninstallResult.stderr) || "uninstall failed");
    }
  }

  if (options.removeFiles === true) {
    const rmResult = await execInWsl(distro, `rm -rf ${quotePosix(hooksDir)}`, { ...options, timeout: 30000 });
    if (!rmResult || rmResult.code !== 0) {
      const message = (rmResult && rmResult.stderr) || "rm failed";
      emit("remove", "fail", message);
      return { ok: false, step: "remove", message };
    }
  }
  emit("remove", "ok");
  return { ok: true, distro, agentId, filesRemoved: options.removeFiles === true };
}

async function removeFromWsl(distro, options = {}) {
  if (!isWindowsFor(options)) return { ok: false, step: "platform", message: "WSL remove only runs on Windows" };
  if (!distro) return { ok: false, step: "args", message: "distro name is required" };
  const agentId = options.agentId || "claude-code";
  const emit = progressEmitter(distro, options);
  return agentId === "hermes"
    ? removeHermesFromWsl(distro, options, emit)
    : removePersistentFromWsl(distro, options, emit);
}

function getAgentInstallScriptName(agentId) {
  return AGENT_INSTALL_SCRIPT[agentId] || null;
}

module.exports = {
  HERMES_RESULT_SENTINEL,
  HERMES_TEMP_SENTINEL,
  HERMES_WSL_FILES,
  cleanupHermesTempDir,
  collectAgentWslFiles,
  collectHookFiles,
  createHermesTempDir,
  deployToWsl,
  getAgentInstallArgs,
  getAgentInstallScriptName,
  getAgentUninstallCommand,
  getAgentWslOptions,
  mergeCleanupResult,
  parseConnectivityProbe,
  parseHermesInstallerResult,
  parseHermesTempDir,
  pipeFileToWsl,
  removeFromWsl,
  resolveHooksDir,
  validateDeployRelativePath,
};
