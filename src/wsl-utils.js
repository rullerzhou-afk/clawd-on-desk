"use strict";

// WSL utility functions for Clawd on Desk (Windows host only).
//
// All public functions are async (child_process.spawn) — they never block
// the Electron main process. wsl.exe serialises access per-distro internally,
// so parallel calls still queue at the Windows boundary.
//
// Design principles:
// - Async-only API (sync only used internally for tests/spawnSync fallback)
// - WSL_DISTRO_NAME is the stable identity (not PRETTY_NAME from os-release)
// - Paths targeting WSL filesystem use POSIX separators (path.posix)

const childProcess = require("child_process");
const os = require("os");
const path = require("path");

const WSL_EXE = "wsl.exe";
const DEFAULT_TIMEOUT_MS = 15000;

// Distro names that are infrastructure, not user dev environments.
const EXCLUDED_DISTROS = new Set([
  "docker-desktop",
  "docker-desktop-data",
  "DevHOME",
]);

function isWindows() {
  return process.platform === "win32";
}

function safeTrim(value) {
  return typeof value === "string" ? value.trim() : "";
}

// ── Internal: spawn helper ────────────────────────────────────────────

function spawnWsl(args, options = {}) {
  return new Promise((resolve) => {
    const timeout = options.timeout || DEFAULT_TIMEOUT_MS;
    const child = childProcess.spawn(WSL_EXE, args, {
      env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill("SIGTERM"); } catch {}
      resolve({
        code: -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        error: new Error("timeout"),
      });
    }, timeout);

    child.stdout.on("data", (d) => { stdoutChunks.push(d); });
    child.stderr.on("data", (d) => { stderrChunks.push(d); });

    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        code: -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        error: err,
      });
    });

    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        error: null,
      });
    });
  });
}

// ── Distribution enumeration ──────────────────────────────────────────

function parseDistroList(raw) {
  if (!raw) return [];
  return raw.replace(/\0/g, "").split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function getWslDistributions(options = {}) {
  if (!isWindows()) return [];

  const exclude = options.exclude || EXCLUDED_DISTROS;
  const customExclude = Array.isArray(options.excludeDistros) ? options.excludeDistros : [];

  const result = await spawnWsl(["-l", "-q"]);
  if (result.code !== 0 || !result.stdout) return [];

  const names = parseDistroList(result.stdout);
  return names
    .filter((name) => !exclude.has(name) && !customExclude.includes(name))
    .map((name, index) => ({ name, default: index === 0 }));
}

// ── Command execution inside WSL ──────────────────────────────────────

async function execInWsl(distro, command, options = {}) {
  if (!isWindows()) {
    return { code: -1, stdout: "", stderr: "not on Windows", error: new Error("not on Windows") };
  }
  if (!distro || !command) {
    return { code: -1, stdout: "", stderr: "distro and command required", error: new Error("distro and command required") };
  }

  const shell = options.shell || "bash";
  const shellFlags = options.shellFlags || ["-c"];
  const args = ["-d", distro, "--", shell, ...shellFlags, command];

  const result = await spawnWsl(args, { timeout: options.timeout });

  // Detect stopped distro: wsl.exe exits 1 with a specific message
  if (result.code === 1 && result.stderr && /(is not running|stopped|shutdown|terminated)/i.test(result.stderr)) {
    result.distroStopped = true;
  }

  return result;
}

// ── Filesystem helpers ────────────────────────────────────────────────

async function getWslHomeDir(distro, options = {}) {
  const result = await execInWsl(distro, "echo $HOME", { timeout: options.timeout || 10000 });
  return result.code === 0 && result.stdout ? safeTrim(result.stdout) : null;
}

async function dirExistsInWsl(distro, wslPath, options = {}) {
  if (!wslPath) return false;
  // Use single quotes to avoid double-quote escaping issues with $HOME etc.
  const escaped = wslPath.replace(/'/g, "'\\''");
  const result = await execInWsl(
    distro,
    `test -d '${escaped}' && echo yes || echo no`,
    { timeout: options.timeout || 10000 }
  );
  return safeTrim(result.stdout) === "yes";
}

async function fileExistsInWsl(distro, wslPath, options = {}) {
  if (!wslPath) return false;
  const escaped = wslPath.replace(/'/g, "'\\''");
  const result = await execInWsl(
    distro,
    `test -f '${escaped}' && echo yes || echo no`,
    { timeout: options.timeout || 10000 }
  );
  return safeTrim(result.stdout) === "yes";
}

// ── Node.js detection ─────────────────────────────────────────────────

async function resolveWslNodePath(distro, options = {}) {
  // Strategy 1: login shell — picks up nvm/volta/fnm/asdf-managed Node.
  // Slow (~2–5s) but finds the Node the user actually uses.
  const loginResult = await execInWsl(
    distro,
    "bash -lc 'command -v node 2>/dev/null || which node 2>/dev/null || true'",
    { timeout: options.timeout || 15000 }
  );
  const loginPath = safeTrim(loginResult.stdout).split("\n")
    .map(safeTrim).filter((p) => p.startsWith("/")).pop();
  if (loginPath) return loginPath;

  // Strategy 2: bare PATH search (faster, for apt/pacman/brew Node)
  const fastResult = await execInWsl(
    distro,
    "command -v node 2>/dev/null || which node 2>/dev/null",
    { timeout: 8000 }
  );
  const fastPath = safeTrim(fastResult.stdout);
  if (fastPath && fastPath.startsWith("/")) return fastPath;

  // Strategy 3: check common locations
  for (const candidate of ["/usr/local/bin/node", "/usr/bin/node", "/home/linuxbrew/.linuxbrew/bin/node"]) {
    if (await fileExistsInWsl(distro, candidate, options)) return candidate;
  }

  return null;
}

// ── Path conversion ──────────────────────────────────────────────────

// Convert a Windows home-relative path to its WSL POSIX equivalent.
// e.g. "C:\\Users\\v1staz\\.claude" + wslHome "/home/v1staz" → "/home/v1staz/.claude"
function rebaseHomePathPosix(value, wslHome, winHome) {
  if (typeof value !== "string" || !value || typeof wslHome !== "string" || !wslHome) return value;
  const currentHome = path.resolve(winHome || os.homedir());
  const resolved = path.resolve(value);
  if (resolved === currentHome) return wslHome;
  if (resolved.startsWith(`${currentHome}${path.sep}`)) {
    const rel = path.relative(currentHome, resolved).split(path.sep).join("/");
    return `${wslHome.replace(/\/+$/, "")}/${rel}`;
  }
  return value;
}

// ── Agent detection helpers ───────────────────────────────────────────

async function detectAgentDirInWsl(distro, wslParentDir, options = {}) {
  return wslParentDir ? dirExistsInWsl(distro, wslParentDir, options) : false;
}

async function detectAgentCommandInWsl(distro, commandName, options = {}) {
  const result = await execInWsl(
    distro,
    `command -v '${commandName.replace(/'/g, "'\\''")}' 2>/dev/null || which '${commandName.replace(/'/g, "'\\''")}' 2>/dev/null`,
    { timeout: options.timeout || 10000 }
  );
  const found = safeTrim(result.stdout);
  return !!(found && found.startsWith("/"));
}

module.exports = {
  getWslDistributions,
  execInWsl,
  getWslHomeDir,
  dirExistsInWsl,
  fileExistsInWsl,
  resolveWslNodePath,
  detectAgentDirInWsl,
  detectAgentCommandInWsl,
  isWindows,
  rebaseHomePathPosix,
  // Exported for tests
  parseDistroList,
  EXCLUDED_DISTROS,
};
