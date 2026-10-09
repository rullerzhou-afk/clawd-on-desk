#!/usr/bin/env node
"use strict";

const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { asarUnpackedPath } = require("./json-utils");
const { resolveNodeBinAsync } = require("./server-config");
const {
  readDshNotices,
  applyDshNoticeOutcome,
  acknowledgeDshNotice,
} = require("./dsh-notices");

const BRIDGE_PACKAGE_NAME = "@dsh-external/dsh-clawd-bridge";
const WEB_PROFILE_NAME = "web";
const DESKTOP_PROFILE_NAME = "desktop";
const DSH_PROFILE_NAMES = Object.freeze([WEB_PROFILE_NAME, DESKTOP_PROFILE_NAME]);
// Per-profile inspection latch. Each profile's latch only fences its own
// startup sync, so a web and a desktop latch must never share a file.
const INSPECTION_LATCH_FILE = "inspection-required.json";
const DESKTOP_INSPECTION_LATCH_FILE = "inspection-required-desktop.json";
const DSH_RESTART_HINT = "DeepSeek Harness bridge verified on disk. Restart any running dsh web process to load this plugin generation.";
// The desktop app loads a newly added plugin while it runs, but a replaced
// same-name package does not hot-reload, so a plugin update (a generation
// change) needs a desktop restart.
const DSH_DESKTOP_RESTART_HINT = "DeepSeek Harness bridge verified on disk. The desktop app loads a newly added plugin while it runs; after a plugin update, restart the desktop app.";
const MANAGED_OWNER = "clawd-on-desk";
const MANIFEST_FILE = "clawd-manifest.json";
const MANIFEST_SCHEMA_VERSION = 1;
const BRIDGE_PROTOCOL_VERSION = 1;
// The one place that names concrete DSH releases. Each entry is the npm
// artifact this bridge was verified against by hand; newest first. New
// generations, markers, and manual npx fallbacks pick an artifact from here.
// The family table below is only the admission rule.
const VERIFIED_DSH_ARTIFACTS = Object.freeze([
  Object.freeze({
    version: "0.2.0-rc.2",
    artifact: "@deepseek-ai/dsh@0.2.0-rc.2",
    integrity: "sha512-EAJ3gPNcVt/uv8X19PMm9NkVhWgT7xXNMk0UKCVm+IQ5rpSQOcsMUa0HWlnYYVybKMsccjcRB21vVVsaXQ6IdA==",
  }),
  Object.freeze({
    version: "0.1.5-rc.3",
    artifact: "@deepseek-ai/dsh@0.1.5-rc.3",
    integrity: "sha512-c0W6Xqc4ChjFcCJkbzPeIxZQdnbKqe+QAcJzWGtogg0ZzsnZRcw3vopMyZ5oZU6E2fmyqGcyDR1sBeiCH4yHcg==",
  }),
  Object.freeze({
    version: "0.1.5-rc.1",
    artifact: "@deepseek-ai/dsh@0.1.5-rc.1",
    integrity: "sha512-rmNmzQCg3oIc1z8xH7izRSOuy1TNzq+/NILyfM+7e8DKOyV+yBtg47WEsqR2SiIe1ATec3L/rUa1YhIcfQ2XEg==",
  }),
  Object.freeze({
    version: "0.1.1-rc.2",
    artifact: "@deepseek-ai/dsh@0.1.1-rc.2",
    integrity: "sha512-UP1UIh6q3Gme/yXRn/QL2P8IsVlv8Shpg22TRJIZPsCRWLm4CBiA1MUvXmJAfsOEETBMLAl+xWPtFw6ICsN3wg==",
  }),
  Object.freeze({
    version: "0.1.0-rc.6",
    artifact: "@deepseek-ai/dsh@0.1.0-rc.6",
    integrity: "sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg==",
  }),
]);

// Admission rule: a host version is supported when it parses strictly, its
// major.minor matches a family, and it is at or above the family's first
// verified version. Adding a new minor means verifying and listing at least
// one artifact for it, then adding a family. Preferred family first, so a
// fresh host-less install stages the first family's newest verified artifact.
const DSH_VERSION_FAMILIES = Object.freeze([
  Object.freeze({ family: "0.2", minVersion: "0.2.0-rc.2", range: ">=0.2.0-rc.2 <0.3.0-0" }),
  Object.freeze({ family: "0.1", minVersion: "0.1.0-rc.6", range: ">=0.1.0-rc.6 <0.2.0-0" }),
]);

// Exact-version contracts derived from the artifact list. They are the old
// "=<version>" shape, kept only to recognize markers written before families
// and to hash-verify those generations in place.
const HISTORICAL_DSH_CONTRACTS = Object.freeze(
  VERIFIED_DSH_ARTIFACTS.map((entry) => Object.freeze({
    version: entry.version,
    supportedDshRange: `=${entry.version}`,
    verifiedDshArtifact: entry.artifact,
    verifiedDshArtifactIntegrity: entry.integrity,
  }))
);

const PREFERRED_DSH_FAMILY = DSH_VERSION_FAMILIES[0];
const PREFERRED_DSH_CONTRACT = dshTargetContract(PREFERRED_DSH_FAMILY, null);

// Backwards-compatible aliases. SUPPORTED_DSH_VERSION is the newest verified
// artifact, not the only supported version, and SUPPORTED_DSH_RANGE is the
// preferred family's range — a label, never a per-host decision. Use
// dshFamilyForVersion / dshContractForMarker for a specific host or marker.
const SUPPORTED_DSH_VERSION = VERIFIED_DSH_ARTIFACTS[0].version;
const SUPPORTED_DSH_RANGE = PREFERRED_DSH_FAMILY.range;
const VERIFIED_DSH_ARTIFACT = VERIFIED_DSH_ARTIFACTS[0].artifact;
const VERIFIED_DSH_ARTIFACT_INTEGRITY = VERIFIED_DSH_ARTIFACTS[0].integrity;
const SOURCE_AUDIT_BASELINE_COMMIT = "47f943859bef60e4160492346772ded9b24f765a";
const DEFAULT_OPERATION_TIMEOUT_MS = 120000;
// plugin add/remove must outlast the upstream write lock, whose wait ceiling is
// 120s, so Clawd does not kill dsh while it is still queued for the lock.
const DSH_WRITE_TIMEOUT_MS = 300000;
const DSH_NPM_VERSION_TIMEOUT_MS = 5000;
// Electron cold starts are slower than a plain Node CLI.
const DSH_DESKTOP_VERSION_TIMEOUT_MS = 15000;
const DSH_WINDOWS_POWERSHELL_TIMEOUT_MS = 10000;
const MUTATION_LOCK_SCHEMA_VERSION = 2;
const MUTATION_LOCK_STALE_MULTIPLIER = 2;
const MAX_MUTATION_LOCK_OPERATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MANUAL_GENERATION_REFERENCE_FILE = "manual-generation-reference.json";
const MANUAL_GENERATION_REFERENCE_SCHEMA_VERSION = 1;
const REPAIR_OPERATION_SCHEMA_VERSION = 1;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const POSIX_DISCOVERABLE_COMMANDS = new Set(["dsh", "pnpm"]);
const BRIDGE_SOURCE_FILES = Object.freeze([
  "package.json",
  "cordis.patch.yml",
  "lib/index.js",
  "lib/clawd-client.js",
]);

let mutationTail = Promise.resolve();

function resolveDshHome(env = process.env) {
  const override = env && typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  return path.resolve(override || path.join(os.homedir(), ".dsh"));
}

function resolveDshProfileDir(dshHome, profile) {
  return path.join(dshHome, "profiles", normalizeDshProfileName(profile));
}

// Only web and desktop are real DSH profiles. Rejecting anything else keeps a
// caller-supplied name from steering reads and writes into an unexpected path.
function normalizeDshProfileName(profile) {
  const value = profile === undefined || profile === null ? WEB_PROFILE_NAME : profile;
  if (!DSH_PROFILE_NAMES.includes(value)) {
    throw new Error(`Unsupported DeepSeek Harness profile: ${String(profile)}`);
  }
  return value;
}

function realpathSyncCanonical(fsImpl, value) {
  return fsImpl.realpathSync.native
    ? fsImpl.realpathSync.native(value)
    : fsImpl.realpathSync(value);
}

function resolveCanonicalDshHome(options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  // A running mutation already chose this identity; never resolve it again if
  // an ancestor is replaced while the operation is in progress.
  if (options.canonicalDshHome) return pathApi.resolve(options.canonicalDshHome);
  const configured = options.dshHome || resolveDshHome(options.env);
  const resolved = pathApi.resolve(configured);
  // DSH may create its home during plugin add. Resolve an existing ancestor
  // now so its managed namespace stays the same before and after that step.
  return platform === process.platform
    ? resolveCanonicalLocalPath(resolved, options)
    : resolved;
}

// Resolve symlinks in the deepest existing ancestor while preserving any
// not-yet-created suffix. DSH homes and managed roots may be created below a
// temporary or relocated parent whose lexical path differs from its real path
// (for example macOS /tmp -> /private/tmp). Keeping the future suffix lets
// first install and later ownership inspection agree without weakening
// marker/hash checks.
function resolveCanonicalLocalPath(value, options = {}) {
  const platform = options.platform || process.platform;
  const resolved = path.resolve(value);
  if (platform !== process.platform) return resolved;
  const fsImpl = options.fs || fs;
  const suffix = [];
  let cursor = resolved;
  while (true) {
    try {
      const realpath = realpathSyncCanonical(fsImpl, cursor);
      return path.join(realpath, ...suffix);
    } catch {}
    const parent = path.dirname(cursor);
    if (parent === cursor) return resolved;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
}

function freezeDshOperationOptions(options = {}) {
  const canonicalDshHome = resolveCanonicalDshHome(options);
  return {
    ...options,
    canonicalDshHome,
    dshHome: canonicalDshHome,
    env: {
      ...(options.env || process.env),
      DSH_HOME: canonicalDshHome,
    },
  };
}

function quotePowerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quotePosixShellLiteral(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildManualDshCommand(argv, options = {}) {
  const platform = options.platform || process.platform;
  const dshHome = resolveCanonicalDshHome(options);
  if (platform === "win32") {
    return `$env:DSH_HOME=${quotePowerShellLiteral(dshHome)}; & ${argv.map(quotePowerShellLiteral).join(" ")}`;
  }
  return `DSH_HOME=${quotePosixShellLiteral(dshHome)} ${argv.map(quotePosixShellLiteral).join(" ")}`;
}

function resolveManagedRoot(options = {}) {
  if (typeof options.managedRoot === "string" && options.managedRoot.trim()) {
    return resolveCanonicalLocalPath(options.managedRoot, options);
  }
  const homeDir = typeof options.homeDir === "string" && options.homeDir.trim()
    ? options.homeDir
    : os.homedir();
  let canonicalDshHome = resolveCanonicalDshHome(options);
  if ((options.platform || process.platform) === "win32") {
    canonicalDshHome = canonicalDshHome.toLowerCase();
  }
  const homeNamespace = crypto
    .createHash("sha256")
    .update(canonicalDshHome.replace(/\\/g, "/"), "utf8")
    .digest("hex");
  return path.join(
    resolveCanonicalLocalPath(homeDir, options),
    ".clawd",
    "integrations",
    "deepseek-harness",
    "homes",
    homeNamespace
  );
}

function resolveBridgeSourceDir(baseDir = __dirname) {
  return asarUnpackedPath(path.resolve(baseDir, "dsh-clawd-bridge"));
}

async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(filePath) {
  try {
    return (await fsp.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

// Content hash of a file that may legitimately be absent. "absent" and
// "unreadable" stay distinct so a failed write can tell "the tool never touched
// it" from "we cannot prove it did not".
async function readFileStateHash(filePath) {
  try {
    const content = await fsp.readFile(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch (err) {
    if (err && err.code === "ENOENT") return "absent";
    return "unreadable";
  }
}

function normalizeCommandResult(result) {
  if (!result || typeof result !== "object") return { code: 1, stdout: "", stderr: "" };
  return {
    code: Number.isInteger(result.code) ? result.code : (Number.isInteger(result.status) ? result.status : 1),
    stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout || ""),
    stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr || ""),
    signal: result.signal || null,
    timedOut: result.timedOut === true,
    outputLimited: result.outputLimited === true,
  };
}

function runCommand(command, args, options = {}) {
  if (typeof options.runCommand === "function") {
    return Promise.resolve(options.runCommand(command, args, options)).then(normalizeCommandResult);
  }
  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let outputLimited = false;
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? options.timeoutMs
      : DEFAULT_OPERATION_TIMEOUT_MS;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(normalizeCommandResult({ ...result, stdout, stderr, timedOut, outputLimited }));
    };
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: 1, stdout: "", stderr: err && err.message ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
    }, timeoutMs);
    const collect = (kind) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        outputLimited = true;
        try { child.kill(); } catch {}
        return;
      }
      if (kind === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.on("error", (err) => finish({ code: 1, stderr: err && err.message ? err.message : String(err) }));
    child.on("close", (code, signal) => finish({ code: Number.isInteger(code) ? code : 1, signal }));
  });
}

async function whereCommands(command, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return [command];
  const result = await runCommand("where.exe", [command], { ...options, timeoutMs: 5000 });
  if (result.code !== 0) return [];
  return [...new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

async function whereCommand(command, options = {}) {
  return (await whereCommands(command, options))[0] || null;
}

function posixShellCandidates(options = {}) {
  const candidates = [];
  const add = (value) => {
    const candidate = typeof value === "string" ? value.trim() : "";
    if (!candidate || !path.posix.isAbsolute(candidate) || candidates.includes(candidate)) return;
    candidates.push(candidate);
  };
  add(options.shellPath);
  add(options.env && options.env.SHELL);
  add(process.env.SHELL);
  add("/bin/zsh");
  add("/bin/bash");
  add("/bin/sh");
  return candidates;
}

async function executablePathFromShellOutput(raw, options = {}) {
  const access = options.access || fsp.access.bind(fsp);
  const lines = String(raw || "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index].trim();
    if (!candidate || !path.posix.isAbsolute(candidate) || candidate.includes("\0")) continue;
    try {
      await access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

async function resolvePosixExecutable(command, options = {}) {
  if (!POSIX_DISCOVERABLE_COMMANDS.has(command)) return null;
  for (const shell of posixShellCandidates(options)) {
    for (const shellMode of ["-lc", "-lic"]) {
      const located = await runCommand(shell, [shellMode, `command -v ${command}`], {
        ...options,
        timeoutMs: 5000,
      });
      if (located.code !== 0) continue;
      const resolved = await executablePathFromShellOutput(located.stdout, options);
      if (resolved) return resolved;
    }
  }
  return null;
}

function buildPosixCommandEnv(options = {}, commandInfo = null, executables = []) {
  const env = {
    ...(options.env || process.env),
    ...((commandInfo && commandInfo.env) || {}),
  };
  const currentEntries = typeof env.PATH === "string"
    ? env.PATH.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean)
    : [];
  const preferredEntries = executables
    .filter((entry) => typeof entry === "string" && path.posix.isAbsolute(entry))
    .map((entry) => path.posix.dirname(entry));
  env.PATH = [...new Set([...preferredEntries, ...currentEntries])].join(path.delimiter);
  return env;
}

function commandExecutionOptions(commandInfo, options = {}) {
  if (!commandInfo || (!commandInfo.env && !commandInfo.cwd)) return options;
  const next = { ...options };
  if (commandInfo.env) {
    // A desktop command carries a complete, sanitized env; merging the caller's
    // env would re-introduce the ELECTRON_* / NODE_OPTIONS keys it removed.
    const completeEnv = commandInfo.envIsComplete === true || commandInfo.kind === "desktop";
    next.env = completeEnv
      ? { ...commandInfo.env }
      : { ...(options.env || process.env), ...commandInfo.env };
  }
  // A caller-provided cwd wins; otherwise use the command's own cwd.
  if (options.cwd === undefined && commandInfo.cwd) next.cwd = commandInfo.cwd;
  return next;
}

function expandShimCandidate(candidate, shim, platform) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const shimDir = pathApi.dirname(shim);
  let expanded = String(candidate || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/%~?dp0%?/gi, `${shimDir}${pathApi.sep}`)
    .replace(/\$\{?basedir\}?/gi, shimDir)
    .replace(/\$PSScriptRoot/gi, shimDir);
  // Strip command syntax that may precede an unquoted path in a shim line.
  expanded = expanded.replace(/^(?:exec\s+)?(?:node(?:\.exe)?\s+|&\s*)/i, "").trim();
  if (!pathApi.isAbsolute(expanded)) expanded = pathApi.resolve(shimDir, expanded);
  return pathApi.normalize(expanded);
}

function extractDshBinCandidates(shim, raw, platform) {
  const candidates = [];
  const matches = String(raw || "").matchAll(
    /([^"'\r\n]*node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js)/gi
  );
  for (const match of matches) {
    const expanded = expandShimCandidate(match[1], shim, platform);
    if (expanded) candidates.push(expanded);
  }
  return [...new Set(candidates)];
}

async function readShimBinCandidates(shim, platform) {
  if (/\.exe$/i.test(shim)) return [];
  try {
    const stat = await fsp.stat(shim);
    if (!stat.isFile() || stat.size > 256 * 1024) return [];
    return extractDshBinCandidates(shim, await fsp.readFile(shim, "utf8"), platform);
  } catch {
    return [];
  }
}

async function resolveNodeRunner(options = {}) {
  if (typeof options.nodeBin === "string" && options.nodeBin.trim()) return options.nodeBin.trim();
  if (typeof options.resolveNodeBinAsyncImpl === "function") {
    return options.resolveNodeBinAsyncImpl(options);
  }
  return resolveNodeBinAsync(options);
}

async function resolveDshCommand(options = {}) {
  if (options.commandInfo && typeof options.commandInfo === "object") {
    return options.commandInfo;
  }
  if (options.dshCommand === false || options.dshCommand === null) return null;
  if (options.dshCommand && typeof options.dshCommand === "object") {
    return {
      command: options.dshCommand.command,
      prefixArgs: Array.isArray(options.dshCommand.prefixArgs) ? options.dshCommand.prefixArgs : [],
      installRoot: options.dshCommand.installRoot || null,
    };
  }
  if (typeof options.dshCommand === "string" && options.dshCommand.trim()) {
    return { command: options.dshCommand.trim(), prefixArgs: [], installRoot: null };
  }
  const platform = options.platform || process.platform;
  if (platform !== "win32") {
    const bin = await resolvePosixExecutable("dsh", options);
    if (!bin) return null;
    let realBin = bin;
    try { realBin = await fsp.realpath(bin); } catch {}
    const normalized = realBin.replace(/\\/g, "/");
    // On macOS "Manage dsh Command" symlinks /usr/local/bin/dsh to the app
    // launcher; reuse the verified desktop carrier instead of the generic path.
    const desktopAppRoot = desktopAppRootForLauncher(realBin);
    if (desktopAppRoot) {
      const bundle = readDesktopBundleSync(options.fs || fs, desktopAppRoot);
      if (bundle.ok) {
        const desktop = desktopCommandInfo({
          status: "found",
          appRoot: desktopAppRoot,
          launcherPath: bundle.launcherPath,
          staticVersion: bundle.staticVersion,
          checkedPaths: [desktopAppRoot],
          reason: null,
        }, options);
        if (desktop.commandInfo) return desktop.commandInfo;
      }
    }
    let binJs = normalized.endsWith("/lib/bin.js") ? realBin : null;
    if (!binJs) {
      const parsed = await readShimBinCandidates(bin, platform);
      for (const candidate of parsed) {
        if (await exists(candidate)) {
          binJs = candidate;
          break;
        }
      }
    }
    const installRoot = binJs ? path.dirname(path.dirname(binJs)) : null;
    const nodeRunner = await resolveNodeRunner(options);
    const env = buildPosixCommandEnv(options, null, [nodeRunner, bin]);
    if (nodeRunner && binJs) {
      return { command: nodeRunner, prefixArgs: [binJs], installRoot, env };
    }
    return { command: bin, prefixArgs: [], installRoot, env };
  }
  const shims = await whereCommands("dsh", options);
  if (shims.length === 0) return null;
  // When the first PATH entry is the desktop dsh.cmd, web reuses that verified
  // carrier. A later dsh.cmd is not trusted here; a first npm shim keeps the
  // existing behavior below.
  if (path.win32.basename(shims[0]).toLowerCase() === DSH_DESKTOP_CMD_NAME) {
    const desktop = parseDesktopDshCmd(shims[0], options);
    if (desktop.commandInfo) return desktop.commandInfo;
  }
  const candidates = [];
  for (const shim of shims) {
    candidates.push(path.join(path.dirname(shim), "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
    candidates.push(...await readShimBinCandidates(shim, platform));
  }
  const nodeRunner = await resolveNodeRunner(options);
  if (nodeRunner) {
    for (const binJs of [...new Set(candidates)]) {
      if (!(await exists(binJs))) continue;
      const packageRoot = path.dirname(path.dirname(binJs));
      return { command: nodeRunner, prefixArgs: [binJs], installRoot: packageRoot };
    }
  }
  const executable = shims.find((shim) => /\.exe$/i.test(shim));
  if (executable) return { command: executable, prefixArgs: [], installRoot: null };
  return null;
}

const DSH_DESKTOP_CMD_NAME = "dsh.cmd";
const DSH_DESKTOP_LAUNCHER_POSIX_SUFFIX = "/Contents/Resources/runtime/cli/bin/dsh";
// Upstream's apps/desktop/cli/dsh.cmd, line for line. It is strict on purpose:
// Clawd runs the exe directly instead of going through cmd.exe, where % ^ & "
// in user-supplied arguments would be unsafe.
const DSH_DESKTOP_CMD_TEMPLATE = Object.freeze([
  "@echo off",
  "setlocal DisableDelayedExpansion",
  'set "ELECTRON_RUN_AS_NODE=1"',
  '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*',
  "exit /b %errorlevel%",
]);
const DSH_DESKTOP_CMD_EXE_RELATIVE = "..\\..\\..\\..\\DeepSeek Harness.exe";
const DSH_DESKTOP_CMD_CLI_RELATIVE = "..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js";

function desktopCommandCwd(options = {}) {
  return typeof options.homeDir === "string" && options.homeDir.trim()
    ? options.homeDir
    : os.homedir();
}

// A desktop child is Electron run as Node. Inherited ELECTRON_* variables and
// NODE_OPTIONS can change how it boots, so drop them and set the one flag the
// bundled CLI needs. DSH_HOME is intentionally carried through unchanged.
function buildDesktopCommandEnv(options = {}) {
  const platform = options.platform || process.platform;
  const source = options.env || process.env;
  const env = {};
  for (const key of Object.keys(source)) {
    if (platform === "win32") {
      const upper = key.toUpperCase();
      if (upper.startsWith("ELECTRON_") || upper === "NODE_OPTIONS") continue;
    } else if (key.startsWith("ELECTRON_") || key === "NODE_OPTIONS") {
      continue;
    }
    env[key] = source[key];
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

function desktopLauncherCommandInfo(launcherPath, options = {}) {
  return {
    command: launcherPath,
    prefixArgs: [],
    installRoot: null,
    env: buildDesktopCommandEnv(options),
    envIsComplete: true,
    cwd: desktopCommandCwd(options),
    kind: "desktop",
    bundledPackageManager: true,
  };
}

function desktopAppRootForLauncher(launcherPath) {
  const normalized = String(launcherPath || "").replace(/\\/g, "/");
  if (!normalized.endsWith(DSH_DESKTOP_LAUNCHER_POSIX_SUFFIX)) return null;
  const appRoot = normalized.slice(0, -DSH_DESKTOP_LAUNCHER_POSIX_SUFFIX.length);
  return appRoot || null;
}

// Read the Windows launcher by comparing it to the one known template, then
// compute the exe and cli.js paths. app.asar contents are invisible to a plain
// Node process, so cli.js is never fs-checked; only the exe is.
function parseDesktopDshCmd(cmdPath, options = {}) {
  const fsImpl = options.fs || fs;
  let raw;
  try {
    raw = fsImpl.readFileSync(cmdPath, "utf8");
  } catch {
    return { commandInfo: null, reason: "launcher-unrecognized" };
  }
  const lines = String(raw)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length !== DSH_DESKTOP_CMD_TEMPLATE.length) {
    return { commandInfo: null, reason: "launcher-unrecognized" };
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== DSH_DESKTOP_CMD_TEMPLATE[index]) {
      return { commandInfo: null, reason: "launcher-unrecognized" };
    }
  }
  const binDir = path.win32.dirname(cmdPath);
  const command = path.win32.normalize(path.win32.join(binDir, DSH_DESKTOP_CMD_EXE_RELATIVE));
  const cliJs = path.win32.normalize(path.win32.join(binDir, DSH_DESKTOP_CMD_CLI_RELATIVE));
  let exeStat = null;
  try { exeStat = fsImpl.statSync(command); } catch {}
  if (!exeStat || !exeStat.isFile()) {
    return { commandInfo: null, reason: "launcher-target-missing" };
  }
  return {
    commandInfo: {
      command,
      prefixArgs: ["--expose-internals", cliJs],
      installRoot: null,
      env: buildDesktopCommandEnv(options),
      envIsComplete: true,
      cwd: desktopCommandCwd(options),
      kind: "desktop",
      bundledPackageManager: true,
    },
    reason: null,
  };
}

// The desktop launcher is Clawd's verified desktop carrier. Success returns the
// resolveDshCommand shape plus kind / bundledPackageManager; failure returns no
// commandInfo and a launcher-* reason for the caller to report.
function desktopCommandInfo(discovery, options = {}) {
  if (!discovery || discovery.status !== "found") {
    return { commandInfo: null, reason: "launcher-missing" };
  }
  if ((options.platform || process.platform) === "win32") {
    return parseDesktopDshCmd(discovery.launcherPath, options);
  }
  return { commandInfo: desktopLauncherCommandInfo(discovery.launcherPath, options), reason: null };
}

// Pick the whole version token out of raw command output. Only a line that is
// exactly "<token>" or "dsh <token>", with a token that starts with a digit,
// counts. Several candidates (or none) mean the version is unknown, and an
// invalid token is never trimmed down to a valid prefix.
function extractDshVersionToken(rawOutput) {
  const candidates = [];
  for (const rawLine of String(rawOutput || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(?:dsh\s+)?(\S+)$/);
    if (!match || !/^\d/.test(match[1])) continue;
    candidates.push(match[1]);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

// Strict SemVer core parser. Build metadata is rejected on purpose: the
// verified artifacts never carried it, and accepting it would widen the input
// space without evidence. Numeric segments stay strings so large integers
// keep their full precision during comparison.
function parseStrictDshVersion(token) {
  const match = String(token || "").match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
  );
  if (!match) return null;
  const [, major, minor, patch] = match;
  for (const segment of [major, minor, patch]) {
    if (segment.length > 1 && segment[0] === "0") return null;
  }
  const prerelease = match[4] ? match[4].split(".") : [];
  for (const identifier of prerelease) {
    if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier[0] === "0") return null;
  }
  return { major, minor, patch, prerelease };
}

function parseDshVersion(value) {
  const token = extractDshVersionToken(value);
  return token && parseStrictDshVersion(token) ? token : null;
}

function compareDshNumericIdentifiers(left, right) {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

// SemVer precedence. Numeric identifiers are compared as digit strings (length
// first, then lexicographically) so values above Number.MAX_SAFE_INTEGER do
// not collapse to the same Number.
function compareDshVersions(left, right) {
  const a = parseStrictDshVersion(left);
  const b = parseStrictDshVersion(right);
  if (!a || !b) return null;
  for (const key of ["major", "minor", "patch"]) {
    const order = compareDshNumericIdentifiers(a[key], b[key]);
    if (order !== 0) return order;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const shared = Math.min(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < shared; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      const order = compareDshNumericIdentifiers(leftIdentifier, rightIdentifier);
      if (order !== 0) return order;
    } else if (leftNumeric) {
      return -1;
    } else if (rightNumeric) {
      return 1;
    } else if (leftIdentifier !== rightIdentifier) {
      return leftIdentifier > rightIdentifier ? 1 : -1;
    }
  }
  if (a.prerelease.length === b.prerelease.length) return 0;
  return a.prerelease.length > b.prerelease.length ? 1 : -1;
}

function dshFamilyForRange(range) {
  return DSH_VERSION_FAMILIES.find((family) => family.range === range) || null;
}

function dshFamilyForVersion(version) {
  const parsed = parseStrictDshVersion(version);
  if (!parsed) return null;
  const family = DSH_VERSION_FAMILIES.find(
    (candidate) => candidate.family === `${parsed.major}.${parsed.minor}`
  );
  if (!family) return null;
  return compareDshVersions(version, family.minVersion) >= 0 ? family : null;
}

function isSupportedDshVersion(version) {
  return dshFamilyForVersion(version) !== null;
}

// Only the pre-family exact contracts are listed here. This is not the
// admission rule; use dshFamilyForVersion to decide whether a host is admitted.
function dshContractForVersion(version) {
  return HISTORICAL_DSH_CONTRACTS.find((contract) => contract.version === version) || null;
}

function supportedDshRangeLabel() {
  return DSH_VERSION_FAMILIES.map((family) => family.range).join(" or ");
}

// The hash contract answers "which range should verify this installed
// generation". A family marker uses its family range; a pre-family marker uses
// its old exact range. Anything else is unlisted and returns null.
function dshContractForMarker(marker) {
  if (
    !marker
    || typeof marker.installedDshVersion !== "string"
    || typeof marker.supportedDshRange !== "string"
  ) return null;
  const family = dshFamilyForRange(marker.supportedDshRange);
  if (family) {
    const markerFamily = dshFamilyForVersion(marker.installedDshVersion);
    if (!markerFamily || markerFamily.family !== family.family) return null;
    return { family: family.family, supportedDshRange: family.range };
  }
  const historical = HISTORICAL_DSH_CONTRACTS.find(
    (contract) => contract.supportedDshRange === marker.supportedDshRange
  );
  if (historical && historical.version === marker.installedDshVersion) return historical;
  return null;
}

// A stable identity for a marker during lock re-verification: its hash
// contract plus the exact version it was staged for.
function dshMarkerIdentity(marker) {
  const contract = dshContractForMarker(marker);
  if (!contract || !marker) return null;
  return `${contract.supportedDshRange}\0${marker.installedDshVersion}`;
}

function verifiedArtifactsForFamily(family) {
  return VERIFIED_DSH_ARTIFACTS.filter((entry) => dshFamilyForVersion(entry.version) === family);
}

// Manual npx commands and staged generations pin an artifact. A marker's own
// version wins when it was verified; otherwise the family's newest verified
// artifact is the closest available stand-in.
function selectDshArtifact(family, markerVersion) {
  const artifacts = verifiedArtifactsForFamily(family);
  if (markerVersion) {
    const exact = artifacts.find((entry) => entry.version === markerVersion);
    if (exact) return exact;
  }
  return artifacts[0] || null;
}

// The target contract describes the generation Clawd is about to write. Its
// identity is the family range, so hosts in the same family share one
// generation regardless of the exact host version.
function dshTargetContract(family, installedVersion) {
  if (!family) return null;
  const artifact = selectDshArtifact(
    family,
    typeof installedVersion === "string" ? installedVersion : null
  );
  if (!artifact) return null;
  return {
    family: family.family,
    // The selected artifact's version, not the detected host version. Markers
    // written from this contract stay inside the family its range describes.
    artifactVersion: artifact.version,
    supportedDshRange: family.range,
    verifiedDshArtifact: artifact.artifact,
    verifiedDshArtifactIntegrity: artifact.integrity,
  };
}

function dshVersionTimeoutMs(commandInfo) {
  return commandInfo && commandInfo.kind === "desktop"
    ? DSH_DESKTOP_VERSION_TIMEOUT_MS
    : DSH_NPM_VERSION_TIMEOUT_MS;
}

async function readDshVersion(commandInfo, options = {}) {
  if (typeof options.dshVersion === "string") return parseDshVersion(options.dshVersion);
  if (!commandInfo) return null;
  const result = await runCommand(commandInfo.command, [...commandInfo.prefixArgs, "--version"], {
    ...commandExecutionOptions(commandInfo, options),
    timeoutMs: dshVersionTimeoutMs(commandInfo),
  });
  if (result.code !== 0) return null;
  return parseDshVersion(`${result.stdout}\n${result.stderr}`);
}

// Operation-mode carrier probe. The three failure kinds stay separate so the
// caller can report "could not run it", "the output was not a version" and
// "the version is not admitted" as distinct reasons.
async function probeDshCarrier(commandInfo, options = {}) {
  if (!commandInfo) return { status: "failed", reason: "carrier-failed", detail: "no dsh command" };
  // Tests and callers may pin the version instead of running the host; keep the
  // same shortcut readDshVersion uses.
  if (typeof options.dshVersion === "string") {
    const pinned = parseDshVersion(options.dshVersion);
    if (!pinned) return { status: "failed", reason: "version-invalid", detail: options.dshVersion };
    if (!isSupportedDshVersion(pinned)) return { status: "failed", reason: "version-unsupported", version: pinned };
    return { status: "available", version: pinned };
  }
  const result = await runCommand(commandInfo.command, [...commandInfo.prefixArgs, "--version"], {
    ...commandExecutionOptions(commandInfo, options),
    timeoutMs: dshVersionTimeoutMs(commandInfo),
  });
  if (result.code !== 0 || result.timedOut || result.signal) {
    return {
      status: "failed",
      reason: "carrier-failed",
      detail: (result.stderr || result.stdout || "dsh --version failed").trim(),
    };
  }
  const version = parseDshVersion(`${result.stdout}\n${result.stderr}`);
  if (!version) {
    return {
      status: "failed",
      reason: "version-invalid",
      detail: (result.stdout || result.stderr || "").trim(),
    };
  }
  if (!isSupportedDshVersion(version)) {
    return { status: "failed", reason: "version-unsupported", version };
  }
  return { status: "available", version };
}

async function hasDshCommand(options = {}) {
  if (typeof options.dshCommandAvailable === "boolean") return options.dshCommandAvailable;
  const command = await resolveDshCommand(options);
  if (!command) return false;
  const result = await runCommand(command.command, [...command.prefixArgs, "--version"], {
    ...commandExecutionOptions(command, options),
    timeoutMs: dshVersionTimeoutMs(command),
  });
  return result.code === 0;
}

async function resolvePnpmRuntime(commandInfo, options = {}) {
  // The desktop CLI bundles its own package manager, so no global pnpm needed.
  if (commandInfo && commandInfo.bundledPackageManager) {
    return { available: true, commandInfo };
  }
  if (typeof options.pnpmAvailable === "boolean") {
    return { available: options.pnpmAvailable, commandInfo };
  }
  if ((options.platform || process.platform) === "win32") {
    return { available: !!(await whereCommand("pnpm", options)), commandInfo };
  }
  const pnpmCommand = await resolvePosixExecutable("pnpm", options);
  if (!pnpmCommand) return { available: false, commandInfo };
  const nodeRunner = await resolveNodeRunner(options);
  const env = buildPosixCommandEnv(options, commandInfo, [pnpmCommand, nodeRunner]);
  const result = await runCommand(pnpmCommand, ["--version"], {
    ...options,
    env,
    timeoutMs: 5000,
  });
  return {
    available: result.code === 0,
    commandInfo: commandInfo ? { ...commandInfo, env } : commandInfo,
  };
}

async function hasPnpm(options = {}) {
  return (await resolvePnpmRuntime(null, options)).available;
}

async function isDshInstalled(options = {}) {
  if (typeof options.dshInstalled === "boolean") return options.dshInstalled;
  const home = options.dshHome || resolveDshHome(options.env);
  if (await isDirectory(home)) {
    for (const name of ["profiles", "sessions", "storages"]) {
      if (await isDirectory(path.join(home, name))) return true;
    }
  }
  return hasDshCommand(options);
}

async function runDshCommand(args, options = {}) {
  try {
    if (typeof options.runDshCommand === "function") {
      return normalizeCommandResult(await options.runDshCommand(args, options));
    }
    const command = await resolveDshCommand(options);
    if (!command) return { code: 127, stdout: "", stderr: "dsh command is not available" };
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DSH_WRITE_TIMEOUT_MS;
    return runCommand(
      command.command,
      [...command.prefixArgs, ...args],
      { ...commandExecutionOptions(command, options), timeoutMs },
    );
  } catch (err) {
    return {
      code: 1,
      stdout: "",
      stderr: err && err.message ? err.message : String(err),
    };
  }
}

function packagePath(root, packageName) {
  return path.join(root, "node_modules", ...packageName.split("/"), "package.json");
}

function managedProfileRemovalResidueLocation(options = {}) {
  const dshHome = options.dshHome || resolveDshHome(options.env);
  const profileDir = resolveDshProfileDir(dshHome, options.profile);
  const linkDir = path.dirname(packagePath(profileDir, BRIDGE_PACKAGE_NAME));
  return {
    dir: path.dirname(linkDir),
    prefix: `${path.basename(linkDir)}.clawd-removing-`,
  };
}

function listManagedProfileRemovalResiduesSync(fsImpl, options = {}) {
  const { dir, prefix } = managedProfileRemovalResidueLocation(options);
  try {
    return {
      paths: fsImpl.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.name.startsWith(prefix))
        .map((entry) => path.join(dir, entry.name))
        .sort(),
      unreadableError: null,
    };
  } catch (err) {
    if (err && err.code === "ENOENT") return { paths: [], unreadableError: null };
    return { paths: [], unreadableError: err || new Error("DSH profile link directory is unreadable") };
  }
}

async function listManagedProfileRemovalResidues(options = {}) {
  const { dir, prefix } = managedProfileRemovalResidueLocation(options);
  try {
    return {
      paths: (await fsp.readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.name.startsWith(prefix))
        .map((entry) => path.join(dir, entry.name))
        .sort(),
      unreadableError: null,
    };
  } catch (err) {
    if (err && err.code === "ENOENT") return { paths: [], unreadableError: null };
    return { paths: [], unreadableError: err || new Error("DSH profile link directory is unreadable") };
  }
}

function managedProfileRemovalResidueHealth(scan, options = {}) {
  if (!scan || (!scan.unreadableError && scan.paths.length === 0)) return null;
  const dshHome = options.dshHome || resolveDshHome(options.env);
  const profile = normalizeDshProfileName(options.profile);
  return {
    status: "inspection-required",
    healthReason: "profile-removal-residue",
    dshHome,
    profile,
    profileDir: resolveDshProfileDir(dshHome, profile),
    diskStatus: null,
    dependencyPresent: false,
    bundlePresent: false,
    owned: false,
    resolved: null,
    residuePath: scan.paths[0] || managedProfileRemovalResidueLocation(options).dir,
    residuePaths: scan.paths,
    residueScanFailed: !!scan.unreadableError,
    manualInspectionRequired: true,
  };
}

function managedProfileRemovalResidueResult(health) {
  return {
    status: "error",
    reason: "inspection-required",
    healthReason: "profile-removal-residue",
    residuePath: health.residuePath,
    residuePaths: health.residuePaths,
    message: "A previous DeepSeek Harness profile-link cleanup was interrupted; inspect the exact residue path before retrying",
    manualInspectionRequired: true,
  };
}

function digestBridgeFiles(files, contract = PREFERRED_DSH_CONTRACT) {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  hash.update(`protocol:${BRIDGE_PROTOCOL_VERSION}\0`);
  hash.update(`dsh:${contract.supportedDshRange}\0`);
  return hash.digest("hex");
}

async function hashBridgeDirectory(packageDir, contract = PREFERRED_DSH_CONTRACT) {
  try {
    const files = [];
    for (const relativePath of BRIDGE_SOURCE_FILES) {
      const filePath = path.join(packageDir, ...relativePath.split("/"));
      const stat = await fsp.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      files.push({ relativePath, content: await fsp.readFile(filePath) });
    }
    return digestBridgeFiles(files, contract);
  } catch {
    return null;
  }
}

function hashBridgeDirectorySync(fsImpl, packageDir, contract = PREFERRED_DSH_CONTRACT) {
  try {
    const files = [];
    for (const relativePath of BRIDGE_SOURCE_FILES) {
      const filePath = path.join(packageDir, ...relativePath.split("/"));
      const stat = typeof fsImpl.lstatSync === "function"
        ? fsImpl.lstatSync(filePath)
        : fsImpl.statSync(filePath);
      if (!stat.isFile() || (typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink())) return null;
      files.push({ relativePath, content: fsImpl.readFileSync(filePath) });
    }
    return digestBridgeFiles(files, contract);
  } catch {
    return null;
  }
}

// Hash the current bridge source once per contract identity so health checks
// can compare an installed marker against the source hash for the range it was
// staged for (never against another range's hash).
function computeExpectedSourceHashesSync(fsImpl, sourceDir) {
  try {
    const files = [];
    for (const relativePath of BRIDGE_SOURCE_FILES) {
      const filePath = path.join(sourceDir, ...relativePath.split("/"));
      const stat = typeof fsImpl.lstatSync === "function"
        ? fsImpl.lstatSync(filePath)
        : fsImpl.statSync(filePath);
      if (!stat.isFile() || (typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink())) return null;
      files.push({ relativePath, content: fsImpl.readFileSync(filePath) });
    }
    const hashes = {};
    for (const family of DSH_VERSION_FAMILIES) {
      hashes[family.range] = digestBridgeFiles(files, { supportedDshRange: family.range });
    }
    for (const contract of HISTORICAL_DSH_CONTRACTS) {
      hashes[contract.supportedDshRange] = digestBridgeFiles(files, contract);
    }
    return hashes;
  } catch {
    return null;
  }
}

function dependencySourcePath(spec, profileDir, platform = process.platform) {
  if (typeof spec !== "string" || !spec.trim()) return null;
  const match = spec.trim().match(/^(?:file|link):(.*)$/i);
  if (!match || !match[1]) return null;
  let value = match[1];
  try { value = decodeURIComponent(value); } catch {}
  if (platform === "win32" && /^\/[A-Za-z]:[\\/]/.test(value)) value = value.slice(1);
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.resolve(profileDir, value);
}

async function inspectResolvedPackage(packageManifestPath, anchor) {
  if (!packageManifestPath || !(await exists(packageManifestPath))) return null;
  let realManifestPath;
  try {
    realManifestPath = await fsp.realpath(packageManifestPath);
  } catch {
    realManifestPath = packageManifestPath;
  }
  const packageManifest = await readJson(realManifestPath);
  const packageDir = path.dirname(realManifestPath);
  const clawdManifest = await readJson(path.join(packageDir, MANIFEST_FILE));
  const markerContract = dshContractForMarker(clawdManifest);
  const actualBundleHash = await hashBridgeDirectory(packageDir, markerContract || PREFERRED_DSH_CONTRACT);
  return { anchor, packageDir, packageManifest, clawdManifest, actualBundleHash };
}

function readJsonSync(fsImpl, filePath) {
  try {
    let raw = fsImpl.readFileSync(filePath, "utf8");
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// One strict interpretation of a latch file body, shared by the sync/async
// readers and the evidence classifier so they cannot drift. Returns the parsed
// record only when it is a valid Clawd-owned latch, else null.
function parseInspectionLatch(raw) {
  let text = raw;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return parsed && parsed.owner === MANAGED_OWNER && parsed.schemaVersion === 1 ? parsed : null;
}

function readInspectionLatchSync(fsImpl, options = {}) {
  const filePath = inspectionLatchPath(options);
  let stat;
  try {
    stat = fsImpl.lstatSync(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    return { invalid: true, reason: "inspection-latch-unreadable" };
  }
  if (!stat.isFile() || (typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink())) {
    return { invalid: true, reason: "inspection-latch-invalid" };
  }
  let raw;
  try {
    raw = fsImpl.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    return { invalid: true, reason: "inspection-latch-unreadable" };
  }
  return parseInspectionLatch(raw) || { invalid: true, reason: "inspection-latch-invalid" };
}

function inspectResolvedPackageSync(fsImpl, packageManifestPath, anchor) {
  try {
    if (!fsImpl.statSync(packageManifestPath).isFile()) return null;
  } catch {
    return null;
  }
  let realManifestPath = packageManifestPath;
  try {
    realManifestPath = realpathSyncCanonical(fsImpl, packageManifestPath);
  } catch {}
  const packageManifest = readJsonSync(fsImpl, realManifestPath);
  const packageDir = path.dirname(realManifestPath);
  const clawdManifest = readJsonSync(fsImpl, path.join(packageDir, MANIFEST_FILE));
  const markerContract = dshContractForMarker(clawdManifest);
  const actualBundleHash = hashBridgeDirectorySync(fsImpl, packageDir, markerContract || PREFERRED_DSH_CONTRACT);
  return { anchor, packageDir, packageManifest, clawdManifest, actualBundleHash };
}

function dshCommandPathsSync(options = {}) {
  const fsImpl = options.fs || fs;
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const pathValue = typeof env.PATH === "string" && env.PATH.trim()
    ? env.PATH
    : (typeof env.Path === "string" ? env.Path : "");
  const names = platform === "win32"
    ? ["dsh", "dsh.cmd", "dsh.ps1", "dsh.exe"]
    : ["dsh"];
  const separator = platform === "win32" ? ";" : ":";
  const results = [];
  for (const entry of pathValue.split(separator).map((value) => value.trim()).filter(Boolean)) {
    for (const name of names) {
      const candidate = pathApi.join(entry, name);
      try {
        if (fsImpl.statSync(candidate).isFile()) results.push(candidate);
      } catch {}
    }
  }
  return [...new Set(results)];
}

function resolveDshInstallRootSync(options = {}) {
  const fsImpl = options.fs || fs;
  const platform = options.platform || process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  for (const shim of dshCommandPathsSync(options)) {
    let realShim = shim;
    try { realShim = realpathSyncCanonical(fsImpl, shim); } catch {}
    const normalized = realShim.replace(/\\/g, "/");
    if (normalized.endsWith("/lib/bin.js")) return pathApi.dirname(pathApi.dirname(realShim));
    const candidates = [
      pathApi.join(pathApi.dirname(shim), "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    ];
    if (!/\.exe$/i.test(shim)) {
      try {
        const stat = fsImpl.statSync(shim);
        if (stat.isFile() && stat.size <= 256 * 1024) {
          candidates.push(...extractDshBinCandidates(shim, fsImpl.readFileSync(shim, "utf8"), platform));
        }
      } catch {}
    }
    for (const binJs of candidates) {
      try {
        if (fsImpl.statSync(binJs).isFile()) return pathApi.dirname(pathApi.dirname(binJs));
      } catch {}
    }
  }
  return null;
}

function isMarkerOwned(record) {
  const marker = record && record.clawdManifest;
  return !!(
    record
    && record.packageManifest
    && record.packageManifest.name === BRIDGE_PACKAGE_NAME
    && marker
    && marker.owner === MANAGED_OWNER
    && marker.schemaVersion === MANIFEST_SCHEMA_VERSION
    && marker.protocolVersion === BRIDGE_PROTOCOL_VERSION
    && typeof marker.bundleHash === "string"
    && marker.bundleHash
  );
}

function isIntactManaged(record) {
  return isMarkerOwned(record)
    && typeof record.actualBundleHash === "string"
    && record.actualBundleHash === record.clawdManifest.bundleHash;
}

function isManagedGenerationRecord(record, managedRoot, options = {}) {
  if (!isIntactManaged(record) || !managedRoot) return false;
  const platform = options.platform || process.platform;
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  // Canonicalize only the namespace root. Following a symlink at the generation
  // leaf would let a marker-looking package outside the managed namespace claim
  // ownership. inspectResolvedPackage* already realpaths record.packageDir, so
  // a leaf that escapes the canonical root must stay a mismatch.
  const expected = path.join(
    resolveCanonicalLocalPath(managedRoot, options),
    "generations",
    record.clawdManifest.bundleHash
  );
  return normalize(record.packageDir) === normalize(expected);
}

function classifyDeepSeekHarnessProfile({
  dshHome,
  profile,
  profileDir,
  profileManifest,
  installationResolved,
  profileResolved,
  fallbackResolved,
  sourceResolved,
  managedGenerationResolved,
  sourcePath,
  managedRoot,
  expectedHashes,
  fs: fsImpl,
  platform,
}) {
  const dependencies = profileManifest.dependencies && typeof profileManifest.dependencies === "object"
    ? profileManifest.dependencies
    : {};
  const bundles = profileManifest.dsh
    && profileManifest.dsh.profile
    && Array.isArray(profileManifest.dsh.profile.bundles)
    ? profileManifest.dsh.profile.bundles
    : [];
  const dependencySpec = dependencies[BRIDGE_PACKAGE_NAME] || null;
  const dependencyPresent = Object.prototype.hasOwnProperty.call(dependencies, BRIDGE_PACKAGE_NAME);
  const bundlePresent = bundles.includes(BRIDGE_PACKAGE_NAME);
  // Official bundle resolution is ordered, not a quorum: installation first,
  // then the profile-local package, then Node's parent-walk flat fallback only
  // when the profile-local package is absent. A stale/foreign lower-priority
  // fallback must not poison a healthy profile-local winner.
  const effectiveFallbackResolved = profileResolved ? null : fallbackResolved;
  const resolved = installationResolved || profileResolved || effectiveFallbackResolved;
  const profileOwned = isIntactManaged(profileResolved);
  const fallbackOwned = isIntactManaged(effectiveFallbackResolved);
  const ownershipOptions = { fs: fsImpl, platform };
  const sourceOwned = isManagedGenerationRecord(sourceResolved, managedRoot, ownershipOptions);
  const managedGenerationOwned = isManagedGenerationRecord(managedGenerationResolved, managedRoot, ownershipOptions);
  const ownershipRecord = sourceOwned
    ? sourceResolved
    : (managedGenerationOwned ? managedGenerationResolved : null);
  const owned = !!ownershipRecord;
  const marker = (resolved && resolved.clawdManifest)
    || (ownershipRecord && ownershipRecord.clawdManifest)
    || null;
  const markerContract = marker ? dshContractForMarker(marker) : null;
  let status = "absent";

  if (dependencyPresent || bundlePresent) {
    if (installationResolved) {
      status = "profile-entry-foreign-or-conflicting";
    } else if (profileResolved && !isMarkerOwned(profileResolved)) {
      status = "profile-entry-foreign-or-conflicting";
    } else if (profileResolved && isMarkerOwned(profileResolved) && !profileOwned) {
      status = "generation-integrity-failed";
    } else if (effectiveFallbackResolved && !isMarkerOwned(effectiveFallbackResolved)) {
      status = "profile-entry-foreign-or-conflicting";
    } else if (effectiveFallbackResolved && isMarkerOwned(effectiveFallbackResolved) && !fallbackOwned) {
      status = "generation-integrity-failed";
    } else if (sourceResolved && !isMarkerOwned(sourceResolved)) {
      status = "profile-entry-foreign-or-conflicting";
    } else if (sourceResolved && isMarkerOwned(sourceResolved) && !isIntactManaged(sourceResolved)) {
      status = "generation-integrity-failed";
    } else if (sourceResolved && !sourceOwned) {
      status = "profile-entry-foreign-or-conflicting";
    } else if (dependencyPresent && !sourcePath) {
      status = "profile-entry-foreign-or-conflicting";
    } else if (dependencyPresent !== bundlePresent) {
      status = owned ? "profile-entry-incomplete" : "profile-entry-foreign-or-conflicting";
    } else if ((!profileResolved && !effectiveFallbackResolved) || (sourcePath && !sourceResolved)) {
      status = owned ? "managed-bundle-missing" : "profile-entry-foreign-or-conflicting";
    } else if (!profileOwned && !fallbackOwned) {
      status = "profile-entry-foreign-or-conflicting";
    } else if (!markerContract) {
      status = "version-unsupported";
    } else if (expectedHashes && marker.bundleHash !== expectedHashes[markerContract.supportedDshRange]) {
      status = "generation-mismatch";
    } else {
      status = "healthy";
    }
  } else if (owned && profileResolved && isMarkerOwned(profileResolved)) {
    status = isIntactManaged(profileResolved)
      ? "managed-residue"
      : "generation-integrity-failed";
  }

  return {
    status,
    dshHome,
    profile,
    profileDir,
    profileManifest,
    dependencySpec,
    dependencySourcePath: sourcePath || null,
    dependencyPresent,
    bundlePresent,
    installationResolved,
    profileResolved,
    fallbackResolved,
    sourceResolved,
    managedGenerationResolved,
    resolved,
    owned,
    managedRoot,
    marker,
  };
}

function inspectDeepSeekHarnessDiskSync(options = {}) {
  const fsImpl = options.fs || fs;
  const profile = normalizeDshProfileName(options.profile);
  const isDesktop = profile === DESKTOP_PROFILE_NAME;
  const dshHome = options.dshHome || resolveDshHome(options.env);
  const profileDir = resolveDshProfileDir(dshHome, profile);
  const removalResidueHealth = managedProfileRemovalResidueHealth(
    listManagedProfileRemovalResiduesSync(fsImpl, options),
    options
  );
  if (removalResidueHealth) return removalResidueHealth;
  const profileManifestPath = path.join(profileDir, "package.json");
  const profileManifest = readJsonSync(fsImpl, profileManifestPath);
  if (!profileManifest) {
    let profileManifestExists = false;
    try { profileManifestExists = fsImpl.statSync(profileManifestPath).isFile(); } catch {}
    const latch = readInspectionLatchSync(fsImpl, options);
    const rawStatus = profileManifestExists ? "profile-corrupt" : "profile-missing";
    return {
      status: latch ? "inspection-required" : rawStatus,
      diskStatus: rawStatus,
      dshHome,
      profile,
      profileDir,
      dependencyPresent: false,
      bundlePresent: false,
      owned: false,
      resolved: null,
      ...(latch ? { inspectionLatch: latch } : {}),
    };
  }
  const dependencies = profileManifest.dependencies && typeof profileManifest.dependencies === "object"
    ? profileManifest.dependencies
    : {};
  const dependencySpec = dependencies[BRIDGE_PACKAGE_NAME] || null;
  const sourcePath = dependencySourcePath(dependencySpec, profileDir, options.platform || process.platform);
  // The desktop app ships its dependency inside app.asar, which a plain Node
  // process cannot read, so there is no npm install root to inspect. The caller
  // passes the version it read from the app bundle instead.
  const dshInstallRoot = isDesktop
    ? null
    : (options.dshInstallRoot !== undefined
      ? options.dshInstallRoot
      : resolveDshInstallRootSync({ ...options, fs: fsImpl }));
  const dshPackageManifest = dshInstallRoot
    ? readJsonSync(fsImpl, path.join(dshInstallRoot, "package.json"))
    : null;
  const detectedDshVersion = isDesktop
    ? (typeof options.hostVersion === "string" ? parseDshVersion(options.hostVersion) : null)
    : (dshPackageManifest && typeof dshPackageManifest.version === "string"
      ? parseDshVersion(dshPackageManifest.version)
      : null);
  const installationManifest = dshInstallRoot
    ? packagePath(dshInstallRoot, BRIDGE_PACKAGE_NAME)
    : null;
  const installationResolved = inspectResolvedPackageSync(fsImpl, installationManifest, "installation");
  const profileResolved = inspectResolvedPackageSync(
    fsImpl,
    packagePath(profileDir, BRIDGE_PACKAGE_NAME),
    "profile"
  );
  const fallbackResolved = inspectResolvedPackageSync(
    fsImpl,
    packagePath(path.join(dshHome, "profiles"), BRIDGE_PACKAGE_NAME),
    "profiles-fallback"
  );
  const sourceResolved = inspectResolvedPackageSync(
    fsImpl,
    sourcePath ? path.join(sourcePath, "package.json") : null,
    "dependency-source"
  );
  const managedRoot = resolveManagedRoot(options);
  const visibleMarker = (profileResolved && profileResolved.clawdManifest)
    || (sourceResolved && sourceResolved.clawdManifest)
    || null;
  const managedGenerationResolved = visibleMarker && typeof visibleMarker.bundleHash === "string"
    ? inspectResolvedPackageSync(
      fsImpl,
      path.join(managedRoot, "generations", visibleMarker.bundleHash, "package.json"),
      "managed-generation"
    )
    : null;
  const verifyCurrentSource = options.verifyCurrentSource !== false;
  const expectedHashes = options.expectedHashes !== undefined
    ? options.expectedHashes
    : (verifyCurrentSource
      ? computeExpectedSourceHashesSync(fsImpl, options.sourceDir || resolveBridgeSourceDir(options.baseDir))
      : null);
  const health = classifyDeepSeekHarnessProfile({
    dshHome,
    profile,
    profileDir,
    profileManifest,
    installationResolved,
    profileResolved,
    fallbackResolved,
    sourceResolved,
    managedGenerationResolved,
    sourcePath,
    managedRoot,
    expectedHashes,
    fs: fsImpl,
    platform: options.platform,
  });
  const sourceAwareHealth = verifyCurrentSource && !expectedHashes && health.owned
    ? { ...health, status: "source-unavailable" }
    : health;
  const immutableConflict = new Set([
    "profile-entry-foreign-or-conflicting",
    "generation-integrity-failed",
    "source-unavailable",
  ]).has(sourceAwareHealth.status);
  const compatibilityAwareHealth = detectedDshVersion
    && !isSupportedDshVersion(detectedDshVersion)
    && !immutableConflict
    ? { ...sourceAwareHealth, status: "host-version-unsupported" }
    : sourceAwareHealth;
  compatibilityAwareHealth.profile = profile;
  // The raw classification before the source, host-version and latch layers
  // replace it; registration is derived from this, not from the overrides.
  compatibilityAwareHealth.diskStatus = health.status;
  compatibilityAwareHealth.detectedDshVersion = detectedDshVersion;
  compatibilityAwareHealth.supportedDshRange = supportedDshRangeLabel();
  compatibilityAwareHealth.supportedDshVersions = VERIFIED_DSH_ARTIFACTS.map((entry) => entry.version);
  const latch = readInspectionLatchSync(fsImpl, options);
  if (!latch) return compatibilityAwareHealth;
  const latchBlockedByHigherPriority = immutableConflict
    || compatibilityAwareHealth.status === "host-version-unsupported";
  return {
    ...compatibilityAwareHealth,
    status: latchBlockedByHigherPriority ? compatibilityAwareHealth.status : "inspection-required",
    // The latch replaces the whole status; keep the real one for callers that
    // need to classify ownership behind a pending inspection.
    statusBeforeLatch: compatibilityAwareHealth.status,
    inspectionLatch: latch,
  };
}

async function inspectDeepSeekHarnessIntegration(options = {}) {
  const profile = normalizeDshProfileName(options.profile);
  const isDesktop = profile === DESKTOP_PROFILE_NAME;
  const dshHome = options.dshHome || resolveDshHome(options.env);
  const profileDir = resolveDshProfileDir(dshHome, profile);
  const removalResidueHealth = managedProfileRemovalResidueHealth(
    await listManagedProfileRemovalResidues(options),
    options
  );
  if (removalResidueHealth) return removalResidueHealth;
  const profileManifestPath = path.join(profileDir, "package.json");
  const profileManifest = await readJson(profileManifestPath);
  if (!profileManifest) {
    const rawStatus = await exists(profileManifestPath) ? "profile-corrupt" : "profile-missing";
    return {
      status: rawStatus,
      diskStatus: rawStatus,
      dshHome,
      profile,
      profileDir,
      dependencyPresent: false,
      bundlePresent: false,
      owned: false,
      resolved: null,
    };
  }
  const dependencies = profileManifest.dependencies && typeof profileManifest.dependencies === "object"
    ? profileManifest.dependencies
    : {};
  const dependencySpec = dependencies[BRIDGE_PACKAGE_NAME] || null;
  const sourcePath = dependencySourcePath(dependencySpec, profileDir, options.platform || process.platform);

  let commandInfo = options.commandInfo || null;
  if (!commandInfo && options.resolveCommandForInspection !== false) {
    commandInfo = await resolveDshCommand(options);
  }
  // The desktop app's dependency lives inside app.asar, so it has no npm
  // install root to inspect; only the profile-side copies are checked.
  const installationManifest = !isDesktop && commandInfo && commandInfo.installRoot
    ? packagePath(commandInfo.installRoot, BRIDGE_PACKAGE_NAME)
    : null;
  const profilePackageManifest = packagePath(profileDir, BRIDGE_PACKAGE_NAME);
  const installationResolved = await inspectResolvedPackage(installationManifest, "installation");
  const profileResolved = await inspectResolvedPackage(profilePackageManifest, "profile");
  const fallbackResolved = await inspectResolvedPackage(
    packagePath(path.join(dshHome, "profiles"), BRIDGE_PACKAGE_NAME),
    "profiles-fallback"
  );
  const sourceResolved = await inspectResolvedPackage(
    sourcePath ? path.join(sourcePath, "package.json") : null,
    "dependency-source"
  );
  const managedRoot = resolveManagedRoot(options);
  const visibleMarker = (profileResolved && profileResolved.clawdManifest)
    || (sourceResolved && sourceResolved.clawdManifest)
    || null;
  const managedGenerationResolved = visibleMarker && typeof visibleMarker.bundleHash === "string"
    ? await inspectResolvedPackage(
      path.join(managedRoot, "generations", visibleMarker.bundleHash, "package.json"),
      "managed-generation"
    )
    : null;
  const health = classifyDeepSeekHarnessProfile({
    dshHome,
    profile,
    profileDir,
    profileManifest,
    installationResolved,
    profileResolved,
    fallbackResolved,
    sourceResolved,
    managedGenerationResolved,
    sourcePath,
    managedRoot,
    expectedHashes: options.expectedHashes,
    platform: options.platform,
  });
  health.diskStatus = health.status;
  return health;
}

const DSH_DESKTOP_BUNDLE_ID = "com.deepseek.dsh";
const DSH_DESKTOP_APP_NAME = "DeepSeek Harness.app";
const DSH_DESKTOP_LAUNCHER_RELATIVE = "Contents/Resources/runtime/cli/bin/dsh";
const DSH_DESKTOP_EXE_NAME = "DeepSeek Harness.exe";
const DESKTOP_DISCOVERY_UNSUPPORTED_REASON = "unsupported-platform";
const DESKTOP_DISCOVERY_UNCONFIRMED_REASON = "app-bundle-unconfirmed";
const DESKTOP_DISCOVERY_REGISTRY_REASON = "registry-unreadable";
const DESKTOP_DISCOVERY_AMBIGUOUS_REASON = "multiple-desktop-installs";

// Read HKCU with PowerShell instead of reg.exe: reg.exe's output encoding
// follows the console code page, so non-ASCII install paths come back garbled,
// while PowerShell can emit UTF-8 JSON and expands REG_EXPAND_SZ for free.
// Any read error exits non-zero and the caller reports unknown, so a partial
// registry view is never mistaken for "no desktop install".
const DSH_WINDOWS_REGISTRY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "try {",
  "  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "  $uninstallRoot = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'",
  "  $entries = @()",
  "  if (Test-Path -LiteralPath $uninstallRoot) {",
  "    foreach ($key in Get-ChildItem -LiteralPath $uninstallRoot) {",
  "      $props = Get-ItemProperty -LiteralPath $key.PSPath",
  "      if ($props.DisplayName -is [string] -and $props.DisplayName.StartsWith('DeepSeek Harness ')) {",
  "        $guid = $key.PSChildName",
  "        $guidInstall = $null",
  "        $guidPath = 'HKCU:\\Software\\' + $guid",
  "        if (Test-Path -LiteralPath $guidPath) { $guidInstall = (Get-ItemProperty -LiteralPath $guidPath).InstallLocation }",
  "        $entries += [pscustomobject]@{ guid = $guid; displayName = $props.DisplayName; displayVersion = $props.DisplayVersion; installLocation = $props.InstallLocation; guidInstallLocation = $guidInstall }",
  "      }",
  "    }",
  "  }",
  "  $commandDirectory = $null",
  "  $commandPath = 'HKCU:\\Software\\DeepSeekHarness\\Command'",
  "  if (Test-Path -LiteralPath $commandPath) { $commandDirectory = (Get-ItemProperty -LiteralPath $commandPath).Directory }",
  "  [pscustomobject]@{ uninstall = @($entries); commandDirectory = $commandDirectory } | ConvertTo-Json -Depth 6 -Compress",
  "  exit 0",
  "} catch {",
  "  exit 1",
  "}",
].join("\n");

// Only the async entry point fills this. Static discovery just reads it, so a
// synchronous Doctor / detector call can never spawn PowerShell.
let windowsRegistryCache = { key: null, snapshot: null };
// In-flight registry reads, keyed so concurrent readers of the same
// environment share one PowerShell instead of racing to start several.
let windowsRegistryRefresh = new Map();

function windowsSystemRoot(options = {}) {
  const env = options.env || process.env;
  return String(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows");
}

function windowsRegistryCacheKey(options = {}) {
  const env = options.env || process.env;
  const localAppData = env.LOCALAPPDATA || env.LocalAppData || "";
  return `${windowsSystemRoot(options)}\0${localAppData}`;
}

function buildWindowsRegistryCommand(options = {}) {
  const powershell = path.win32.join(
    windowsSystemRoot(options),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const encoded = Buffer.from(DSH_WINDOWS_REGISTRY_SCRIPT, "utf16le").toString("base64");
  return {
    command: powershell,
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
  };
}

function parseWindowsRegistryOutput(stdout) {
  let parsed;
  try { parsed = JSON.parse(String(stdout || "")); } catch { return null; }
  return parsed && typeof parsed === "object" ? parsed : null;
}

function windowsRegistryUnknownResult() {
  return {
    status: "unknown",
    appRoot: null,
    launcherPath: null,
    staticVersion: null,
    checkedPaths: [],
    reason: DESKTOP_DISCOVERY_REGISTRY_REASON,
  };
}

function windowsDiscoveryPendingResult() {
  return {
    status: "unknown",
    appRoot: null,
    launcherPath: null,
    staticVersion: null,
    checkedPaths: [],
    reason: "windows-discovery-pending",
  };
}

async function readWindowsRegistry(options = {}) {
  if (options.windowsRegistrySnapshot !== undefined) {
    if (options.windowsRegistrySnapshot instanceof Error) throw options.windowsRegistrySnapshot;
    return options.windowsRegistrySnapshot;
  }
  const { command, args } = buildWindowsRegistryCommand(options);
  const result = await runCommand(command, args, { ...options, timeoutMs: DSH_WINDOWS_POWERSHELL_TIMEOUT_MS });
  if (result.code !== 0 || result.timedOut || result.signal) {
    throw new Error("DeepSeek Harness registry is unreadable");
  }
  const parsed = parseWindowsRegistryOutput(result.stdout);
  if (!parsed) throw new Error("DeepSeek Harness registry output is not JSON");
  return parsed;
}

function cachedWindowsRegistrySnapshot(options = {}) {
  const key = windowsRegistryCacheKey(options);
  if (!windowsRegistryCache.snapshot || windowsRegistryCache.key !== key) return null;
  return windowsRegistryCache.snapshot;
}

function resetWindowsRegistryCache() {
  windowsRegistryCache = { key: null, snapshot: null };
  windowsRegistryRefresh = new Map();
}

function windowsRootKey(root) {
  const resolved = path.win32.resolve(String(root));
  const stripped = resolved.length > 3 ? resolved.replace(/[\\/]+$/, "") : resolved;
  return stripped.toLowerCase();
}

function verifyWindowsDesktopRoot(root, options = {}) {
  const fsImpl = options.fs || fs;
  const requiredFiles = [
    path.win32.join(root, DSH_DESKTOP_EXE_NAME),
    path.win32.join(root, "resources", "runtime", "cli", "bin", DSH_DESKTOP_CMD_NAME),
  ];
  for (const filePath of requiredFiles) {
    let stat = null;
    try { stat = fsImpl.statSync(filePath); } catch {}
    if (!stat || !stat.isFile()) return false;
  }
  // electron's patched fs reports an .asar bundle as a directory, while a plain
  // Node process reports it as a file, so only "exists" is portable across both.
  // (The bundled launcher target lives inside it, so a missing app.asar still
  // fails the root.) Requiring isFile() here made Electron-based Clawd reject
  // every real desktop install.
  const asarPath = path.win32.join(root, "resources", "app.asar");
  let asarStat = null;
  try { asarStat = fsImpl.statSync(asarPath); } catch {}
  return !!asarStat;
}

function windowsDesktopCandidates(registry, options = {}) {
  const candidates = [];
  const add = (value) => {
    if (typeof value === "string" && value.trim()) candidates.push(value.trim());
  };
  const uninstall = registry && Array.isArray(registry.uninstall) ? registry.uninstall : [];
  for (const entry of uninstall) if (entry) add(entry.installLocation);
  for (const entry of uninstall) if (entry) add(entry.guidInstallLocation);
  if (registry && typeof registry.commandDirectory === "string" && registry.commandDirectory.trim()) {
    add(path.win32.resolve(registry.commandDirectory.trim(), "..", "..", "..", ".."));
  }
  const env = options.env || process.env;
  const localAppData = env.LOCALAPPDATA || env.LocalAppData;
  if (typeof localAppData === "string" && localAppData.trim()) {
    add(path.win32.join(localAppData, "Programs", "DeepSeek Harness"));
  }
  return candidates;
}

function discoverDshDesktopWindows(options = {}, registry = null) {
  const valid = new Map();
  const checkedPaths = [];
  const uninstall = registry && Array.isArray(registry.uninstall) ? registry.uninstall : [];
  for (const candidate of windowsDesktopCandidates(registry, options)) {
    const root = path.win32.resolve(candidate);
    checkedPaths.push(root);
    if (!verifyWindowsDesktopRoot(root, options)) continue;
    const key = windowsRootKey(root);
    if (valid.has(key)) continue;
    const launcherPath = path.win32.join(root, "resources", "runtime", "cli", "bin", DSH_DESKTOP_CMD_NAME);
    const match = uninstall.find((entry) => entry
      && typeof entry.installLocation === "string"
      && windowsRootKey(entry.installLocation) === key);
    const staticVersion = match && typeof match.displayVersion === "string"
      ? parseDshVersion(match.displayVersion)
      : null;
    valid.set(key, { appRoot: root, launcherPath, staticVersion });
  }
  const results = [...valid.values()];
  if (results.length === 0) {
    return { status: "not-found", appRoot: null, launcherPath: null, staticVersion: null, checkedPaths, reason: null };
  }
  if (results.length > 1) {
    return {
      status: "ambiguous",
      appRoot: null,
      launcherPath: null,
      staticVersion: null,
      checkedPaths,
      candidates: results,
      reason: DESKTOP_DISCOVERY_AMBIGUOUS_REASON,
    };
  }
  return {
    status: "found",
    appRoot: results[0].appRoot,
    launcherPath: results[0].launcherPath,
    staticVersion: results[0].staticVersion,
    checkedPaths,
    reason: null,
  };
}

// Static mode never spawns anything: it re-verifies whatever snapshot the
// async entry point last stored, or reports "pending" until one exists.
function discoverDshDesktopWindowsSync(options = {}) {
  const snapshot = cachedWindowsRegistrySnapshot(options);
  if (!snapshot) return windowsDiscoveryPendingResult();
  return discoverDshDesktopWindows(options, snapshot);
}

// The async entry point always re-reads the registry and refreshes the cache.
// refreshDshDesktopDiscovery is the same work under an explicit name, for the
// later startup / Doctor preheat paths.
async function refreshDshDesktopDiscovery(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return discoverDshDesktopSync(options);
  if (options.desktopDiscovery) return options.desktopDiscovery;
  if (options.windowsRegistrySnapshot !== undefined) {
    if (options.windowsRegistrySnapshot instanceof Error) return windowsRegistryUnknownResult();
    return discoverDshDesktopWindows(options, options.windowsRegistrySnapshot);
  }
  // Single-flight per cache key: an already-running read for the same
  // environment is shared instead of starting a second PowerShell. Injected
  // discovery / snapshots returned above and never take part.
  const key = windowsRegistryCacheKey(options);
  const inflight = windowsRegistryRefresh.get(key);
  if (inflight) return inflight;
  const promise = (async () => {
    let snapshot;
    try {
      snapshot = await readWindowsRegistry(options);
    } catch {
      return windowsRegistryUnknownResult();
    }
    windowsRegistryCache = { key, snapshot };
    return discoverDshDesktopWindows(options, snapshot);
  })().finally(() => {
    if (windowsRegistryRefresh.get(key) === promise) windowsRegistryRefresh.delete(key);
  });
  windowsRegistryRefresh.set(key, promise);
  return promise;
}

async function discoverDshDesktop(options = {}) {
  if (options.desktopDiscovery) return options.desktopDiscovery;
  const platform = options.platform || process.platform;
  if (platform !== "win32") return discoverDshDesktopSync(options);
  return refreshDshDesktopDiscovery(options);
}


function isXmlPlistText(raw) {
  const head = String(raw || "").slice(0, 1024);
  return /<\?xml/.test(head) || /<plist[\s>]/.test(head);
}

// The bundle identifier is the only thing that proves an .app is DeepSeek
// Harness and not a look-alike, so it is read straight from the Info.plist.
function readXmlPlistString(xml, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<string>([\\s\\S]*?)</string>`).exec(xml);
  if (!match) return null;
  return match[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function readDesktopBundleSync(fsImpl, appRoot) {
  let raw;
  try {
    raw = fsImpl.readFileSync(path.join(appRoot, "Contents", "Info.plist"), "utf8");
  } catch {
    return { ok: false, reason: "info-plist-unreadable" };
  }
  if (!isXmlPlistText(raw)) return { ok: false, reason: "info-plist-not-xml" };
  if (readXmlPlistString(raw, "CFBundleIdentifier") !== DSH_DESKTOP_BUNDLE_ID) {
    return { ok: false, reason: "bundle-id-mismatch" };
  }
  const launcherPath = path.join(appRoot, ...DSH_DESKTOP_LAUNCHER_RELATIVE.split("/"));
  let launcherStat;
  try { launcherStat = fsImpl.statSync(launcherPath); } catch { launcherStat = null; }
  if (!launcherStat || !launcherStat.isFile()) return { ok: false, reason: "launcher-missing" };
  return {
    ok: true,
    launcherPath,
    staticVersion: parseDshVersion(readXmlPlistString(raw, "CFBundleShortVersionString") || ""),
  };
}

// File-only discovery of the desktop app. macOS reads the bundle; Windows uses
// the last async registry snapshot (never a process) and re-verifies candidate
// roots against disk. It never launches the app or its bundled command.
function discoverDshDesktopSync(options = {}) {
  if (options.desktopDiscovery) return options.desktopDiscovery;
  const platform = options.platform || process.platform;
  const empty = { appRoot: null, launcherPath: null, staticVersion: null };
  if (platform === "win32") {
    if (options.windowsRegistrySnapshot !== undefined) {
      if (options.windowsRegistrySnapshot instanceof Error) return windowsRegistryUnknownResult();
      return discoverDshDesktopWindows(options, options.windowsRegistrySnapshot);
    }
    return discoverDshDesktopWindowsSync(options);
  }
  if (platform !== "darwin") {
    return { status: "not-found", ...empty, checkedPaths: [], reason: DESKTOP_DISCOVERY_UNSUPPORTED_REASON };
  }
  const fsImpl = options.fs || fs;
  const homeDir = typeof options.homeDir === "string" && options.homeDir.trim()
    ? options.homeDir
    : os.homedir();
  const appPaths = Array.isArray(options.desktopAppPaths)
    ? options.desktopAppPaths
    : [
      path.join("/", "Applications", DSH_DESKTOP_APP_NAME),
      path.join(homeDir, "Applications", DSH_DESKTOP_APP_NAME),
    ];
  // Installer callers only need "is it installed", so they keep the first-hit
  // behavior. A caller that is about to launch the app needs to know whether
  // that hit is the only install, hence the opt-in uniqueness check.
  const requireUniqueApp = options.requireUniqueApp === true;
  const checkedPaths = [];
  const found = [];
  const seenRoots = new Set();
  let unconfirmedReason = null;
  for (const appRoot of appPaths) {
    checkedPaths.push(appRoot);
    // A symlinked second location can point at the same bundle; the uniqueness
    // check dedupes by the real path when the fs exposes it, otherwise by the
    // lexical one. Only the uniqueness caller pays for the extra syscall.
    let rootKey = path.resolve(appRoot);
    if (requireUniqueApp && typeof fsImpl.realpathSync === "function") {
      try { rootKey = fsImpl.realpathSync(appRoot); } catch { /* keep the resolved path */ }
    }
    if (seenRoots.has(rootKey)) continue;
    seenRoots.add(rootKey);
    let dirStat;
    try {
      dirStat = fsImpl.statSync(appRoot);
    } catch (err) {
      // A path that plainly does not exist is not a candidate. Any other stat
      // failure (e.g. EACCES) may still be a DSH install we cannot verify, so
      // the uniqueness caller must not treat it as absent.
      const code = err && err.code;
      if (requireUniqueApp && code !== "ENOENT" && code !== "ENOTDIR") {
        if (!unconfirmedReason) unconfirmedReason = DESKTOP_DISCOVERY_UNCONFIRMED_REASON;
      }
      continue;
    }
    if (!dirStat.isDirectory()) continue;
    const bundle = readDesktopBundleSync(fsImpl, appRoot);
    if (!bundle.ok) {
      // A binary/unreadable Info.plist cannot prove the app is not DSH, and a
      // matching bundle id with no launcher is a DSH app we cannot use; both
      // stay "unknown" instead of being reported as not installed.
      if (bundle.reason === "info-plist-unreadable" || bundle.reason === "info-plist-not-xml") {
        if (!unconfirmedReason) unconfirmedReason = DESKTOP_DISCOVERY_UNCONFIRMED_REASON;
      } else if (bundle.reason === "launcher-missing") {
        if (!unconfirmedReason) unconfirmedReason = "launcher-missing";
      }
      continue;
    }
    const match = {
      appRoot,
      launcherPath: bundle.launcherPath,
      staticVersion: bundle.staticVersion,
    };
    if (!requireUniqueApp) {
      return { status: "found", ...match, checkedPaths, reason: null };
    }
    found.push(match);
  }
  if (requireUniqueApp && found.length > 1) {
    return {
      status: "ambiguous",
      ...empty,
      checkedPaths,
      candidates: found,
      reason: DESKTOP_DISCOVERY_AMBIGUOUS_REASON,
    };
  }
  // A single confirmed install is only unique when nothing else is unresolved:
  // another candidate that cannot be verified may also be DSH, so an unknown
  // candidate outranks the lone found result and blocks an automatic launch.
  if (unconfirmedReason) {
    return { status: "unknown", ...empty, checkedPaths, reason: unconfirmedReason };
  }
  if (requireUniqueApp && found.length === 1) {
    return { status: "found", ...found[0], checkedPaths, reason: null };
  }
  return { status: "not-found", ...empty, checkedPaths, reason: null };
}

// Disk-only evidence for one profile, read independently of the health result
// so a latch cannot hide it. Each value is deliberately one of a small set.
function describeManifestSync(fsImpl, profileDir) {
  let dirStat;
  try {
    dirStat = fsImpl.lstatSync(profileDir);
  } catch (err) {
    if (err && err.code === "ENOENT") return "absent";
    return "unreadable";
  }
  if (typeof dirStat.isSymbolicLink === "function" && dirStat.isSymbolicLink()) return "symlink";
  const manifestPath = path.join(profileDir, "package.json");
  let manifestStat;
  try {
    manifestStat = fsImpl.statSync(manifestPath);
  } catch (err) {
    if (err && err.code === "ENOENT") return "absent";
    return "unreadable";
  }
  if (!manifestStat.isFile()) return "absent";
  let raw;
  try {
    raw = fsImpl.readFileSync(manifestPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return "absent";
    return "unreadable";
  }
  try {
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    JSON.parse(raw);
    return "present";
  } catch {
    return "corrupt";
  }
}

function inspectionLatchEvidenceSync(fsImpl, options) {
  const filePath = inspectionLatchPath(options);
  let stat;
  try {
    stat = fsImpl.lstatSync(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") return "none";
    return "unknown";
  }
  if (!stat.isFile() || (typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink())) {
    return "invalid";
  }
  let raw;
  try {
    raw = fsImpl.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return "none";
    return "unknown";
  }
  return parseInspectionLatch(raw) ? "present" : "invalid";
}

function manualReferenceEvidence(reference) {
  if (!reference) return "none";
  if (isValidManualGenerationReference(reference)) return "present";
  if (reference.reason === "reference-directory-unreadable" || reference.reason === "reference-unreadable") {
    return "unknown";
  }
  return "invalid";
}

// Ownership is read from the raw classification (diskStatus), not from the
// source/host-version/latch layers that rewrite status afterwards.
function registrationEvidenceFromHealth(manifestEvidence, health) {
  if (manifestEvidence !== "present") {
    return manifestEvidence === "absent" ? "none" : "unknown";
  }
  const status = health ? health.diskStatus : null;
  switch (status) {
    case "absent":
    case "profile-missing":
      return "none";
    case "profile-entry-foreign-or-conflicting":
      return "foreign";
    case "generation-integrity-failed":
      return "damaged";
    case "healthy":
    case "profile-entry-incomplete":
    case "generation-mismatch":
    case "managed-bundle-missing":
    case "managed-residue":
    case "version-unsupported":
      return health && health.owned ? "owned" : "unknown";
    default:
      return "unknown";
  }
}

function dshDiagnose(reason) {
  return { role: "diagnose", reason };
}

function resolveWebDshRole({ evidence, carrier, operation }) {
  if (carrier.status === "unverified") {
    if (evidence.manifest === "present") return { role: "mutable", reason: null };
    if (operation === "install" || operation === "explicit-repair") {
      // Upstream plugin add creates the web profile, so this operation may too.
      return { role: "mutable", reason: null, initializesProfile: true };
    }
    if (operation === "startup-sync") return dshDiagnose("web-profile-uninitialized");
    if (operation === "uninstall") return { role: "mutable", reason: null };
    return dshDiagnose("web-profile-uninitialized");
  }
  if (
    evidence.manifest === "present"
    || evidence.registration === "owned"
    || evidence.manualReference === "present"
    || evidence.latch === "present"
  ) {
    // No command, but Clawd still owns state here: report instead of touching
    // it, and let the existing manual npx fallback handle it later.
    return { role: "diagnose", reason: "cli-unavailable", manualFallback: true };
  }
  return { role: "not-applicable", reason: "web-not-used" };
}

function resolveDesktopDshRole({ evidence, discovery }) {
  // Only Clawd's own registration, latch or residue counts as desktop
  // evidence; a desktop profile we never registered does not. Residue is
  // already resolved above, so it cannot reach this step.
  const ourEvidence = evidence.registration === "owned" || evidence.latch === "present";
  if (discovery.status === "not-found") {
    return ourEvidence
      ? dshDiagnose("carrier-unavailable")
      : { role: "not-applicable", reason: "desktop-not-installed" };
  }
  if (discovery.status === "unknown" || discovery.status === "ambiguous") {
    // "Could not find it" is not "it is gone": any surviving manifest counts.
    // An ambiguous registry answer is treated like unknown, just with a reason
    // that says more than one install was found.
    return ourEvidence || evidence.manifest === "present"
      ? dshDiagnose(discovery.status === "ambiguous" ? "multiple-desktop-installs" : "desktop-unverifiable")
      : { role: "not-applicable", reason: "desktop-not-installed" };
  }
  if (evidence.manifest === "absent") {
    return evidence.latch === "present"
      ? dshDiagnose("inspection-required")
      : { role: "not-applicable", reason: "desktop-profile-uninitialized" };
  }
  return { role: "mutable", reason: null };
}

// Ordered role decision, one branch per row of the profile role table. The
// first matching row wins; profile-specific rows are split into the two small
// helpers above.
function resolveDshRole({ profile, evidence, carrier, discovery, health, operation }) {
  if (evidence.manifest === "corrupt") return dshDiagnose("profile-corrupt");
  if (evidence.manifest === "unreadable") return dshDiagnose("profile-unreadable");
  if (evidence.manifest === "symlink") return dshDiagnose("profile-symlink");
  if (evidence.residue === "unknown") return dshDiagnose("residue-unreadable");
  if (evidence.residue === "present") return dshDiagnose("removal-residue");
  if (evidence.latch === "unknown") return dshDiagnose("latch-unreadable");
  if (evidence.latch === "invalid") return dshDiagnose("latch-invalid");
  // A broken two-step repair record fences the target before anything else.
  if (evidence.operationRecord === "unknown") return dshDiagnose("repair-record-unreadable");
  if (evidence.operationRecord === "invalid") return dshDiagnose("repair-record-invalid");
  if (profile === WEB_PROFILE_NAME && evidence.manualReference === "unknown") {
    return dshDiagnose("manual-reference-unreadable");
  }
  if (evidence.registration === "unknown") return dshDiagnose("registration-unknown");
  if (evidence.registration === "foreign") return dshDiagnose("foreign-package");
  if (evidence.registration === "damaged") return dshDiagnose("integrity-failed");
  // The source-unavailable status only exists on the pre-latch status, so read
  // it through statusBeforeLatch when a latch has replaced the status.
  const statusBeforeLatch = health && health.status === "inspection-required" && health.statusBeforeLatch
    ? health.statusBeforeLatch
    : (health ? health.status : null);
  if (statusBeforeLatch === "source-unavailable") return dshDiagnose("source-unavailable");
  if (profile === WEB_PROFILE_NAME && evidence.manualReference === "invalid") {
    return dshDiagnose("manual-reference-invalid");
  }
  // A known host version outside every family is decided from the detected
  // version, not from the overridden status.
  if (profile === WEB_PROFILE_NAME) {
    const detected = health && health.detectedDshVersion;
    if (detected && !isSupportedDshVersion(detected)) return dshDiagnose("version-unsupported");
  } else if (discovery && discovery.staticVersion && !isSupportedDshVersion(discovery.staticVersion)) {
    return dshDiagnose("version-unsupported");
  }
  if (evidence.latch === "present" && operation === "startup-sync") {
    return dshDiagnose("inspection-required");
  }
  // Startup sync only reports a pending two-step repair; it never resumes it.
  if (evidence.operationRecord === "present" && operation === "startup-sync") {
    return dshDiagnose("repair-pending");
  }
  if (profile === WEB_PROFILE_NAME) return resolveWebDshRole({ evidence, carrier, operation });
  return resolveDesktopDshRole({ evidence, discovery });
}

function inspectWebDshTargetSync(options, operation, fsImpl) {
  const scoped = { ...options, profile: WEB_PROFILE_NAME };
  const dshHome = options.dshHome || resolveDshHome(options.env);
  const profileDir = resolveDshProfileDir(dshHome, WEB_PROFILE_NAME);
  const health = inspectDeepSeekHarnessDiskSync(scoped);
  const manifest = describeManifestSync(fsImpl, profileDir);
  const residueScan = listManagedProfileRemovalResiduesSync(fsImpl, scoped);
  const residue = residueScan.unreadableError ? "unknown" : (residueScan.paths.length ? "present" : "none");
  const latch = inspectionLatchEvidenceSync(fsImpl, scoped);
  const manualReference = manualReferenceEvidence(readManualGenerationReferenceSync(fsImpl, scoped));
  const operationRecord = repairOperationEvidenceSync(fsImpl, scoped);
  const commandCandidates = dshCommandPathsSync(scoped);
  const carrier = commandCandidates.length
    ? { status: "unverified", kind: "npm", path: commandCandidates[0] }
    : { status: "unavailable", kind: "npm", path: null };
  const evidence = {
    manifest,
    registration: registrationEvidenceFromHealth(manifest, health),
    residue,
    latch,
    manualReference,
    operationRecord,
  };
  const role = resolveDshRole({
    profile: WEB_PROFILE_NAME,
    evidence,
    carrier,
    discovery: null,
    health,
    operation,
  });
  return {
    profile: WEB_PROFILE_NAME,
    profileDir,
    health,
    evidence,
    carrier,
    discovery: null,
    role: role.role,
    reason: role.reason,
    manualFallback: role.manualFallback === true,
    initializesProfile: role.initializesProfile === true,
  };
}

function inspectDesktopDshTargetSync(options, operation, fsImpl) {
  const dshHome = options.dshHome || resolveDshHome(options.env);
  const profileDir = resolveDshProfileDir(dshHome, DESKTOP_PROFILE_NAME);
  const discovery = discoverDshDesktopSync(options);
  const hostVersion = discovery && discovery.status === "found" ? discovery.staticVersion : null;
  const scoped = {
    ...options,
    profile: DESKTOP_PROFILE_NAME,
    dshInstallRoot: null,
    hostVersion,
  };
  const health = inspectDeepSeekHarnessDiskSync(scoped);
  const manifest = describeManifestSync(fsImpl, profileDir);
  const residueScan = listManagedProfileRemovalResiduesSync(fsImpl, scoped);
  const residue = residueScan.unreadableError ? "unknown" : (residueScan.paths.length ? "present" : "none");
  const latch = inspectionLatchEvidenceSync(fsImpl, scoped);
  const operationRecord = repairOperationEvidenceSync(fsImpl, scoped);
  const carrier = discovery && discovery.status === "found"
    ? { status: "unverified", kind: "desktop", path: discovery.launcherPath }
    : { status: "unavailable", kind: "desktop", path: null };
  const evidence = {
    manifest,
    registration: registrationEvidenceFromHealth(manifest, health),
    residue,
    latch,
    manualReference: null,
    operationRecord,
  };
  const role = resolveDshRole({
    profile: DESKTOP_PROFILE_NAME,
    evidence,
    carrier,
    discovery,
    health,
    operation,
  });
  return {
    profile: DESKTOP_PROFILE_NAME,
    profileDir,
    health,
    evidence,
    carrier,
    discovery,
    role: role.role,
    reason: role.reason,
    manualFallback: false,
    initializesProfile: false,
  };
}

// Unknown operations are rejected, like unknown profile names, so a typo never
// silently changes which capabilities an operation is granted.
function normalizeDshTargetOperation(operation) {
  const allowed = ["install", "startup-sync", "explicit-repair", "uninstall", "doctor"];
  if (!allowed.includes(operation)) {
    throw new Error(`Unsupported DeepSeek Harness target operation: ${String(operation)}`);
  }
  return operation === "doctor" ? "explicit-repair" : operation;
}

// Static target inspection for Doctor, detectors and Settings. It never spawns
// a process, so the mutable role only means "may be attempted"; the real
// operation mode still has to verify the carrier and re-check under the lock.
function inspectDshTargetsSync(options = {}, { operation } = {}) {
  const fsImpl = options.fs || fs;
  const resolvedOperation = normalizeDshTargetOperation(operation);
  return {
    web: inspectWebDshTargetSync(options, resolvedOperation, fsImpl),
    desktop: inspectDesktopDshTargetSync(options, resolvedOperation, fsImpl),
  };
}

function dshCarrierUnavailable(kind) {
  return { status: "unavailable", kind, path: null };
}

// Operation-mode refinement of one desktop target: only a mutable target is
// actually probed. The probe's version is kept so the caller can re-check it
// under the mutation lock.
async function resolveDshTargetCarrier(staticTarget, profile, options, operation, desktopDiscovery) {
  if (staticTarget.role !== "mutable") return staticTarget;
  const desktop = desktopCommandInfo(desktopDiscovery, options);
  if (!desktop.commandInfo) {
    return {
      ...staticTarget,
      role: "diagnose",
      reason: desktop.reason || "launcher-unrecognized",
      carrier: dshCarrierUnavailable("desktop"),
    };
  }
  const probe = await probeDshCarrier(desktop.commandInfo, options);
  if (probe.status === "available") {
    return {
      ...staticTarget,
      role: "mutable",
      reason: null,
      carrier: { status: "available", kind: "desktop", version: probe.version, commandInfo: desktop.commandInfo },
    };
  }
  return {
    ...staticTarget,
    role: "diagnose",
    reason: probe.reason,
    carrier: { ...dshCarrierUnavailable("desktop"), version: probe.version || null },
  };
}

// Web always re-resolves its command in operation mode instead of trusting the
// static PATH scan: on macOS the app PATH usually cannot see a login-shell dsh.
// Rows 1-9 of the role table (residue, latch, foreign, ...) are diagnose and
// keep their static decision; only the command/manifest row is re-decided.
async function resolveDshWebTarget(staticTarget, options, operation) {
  // Only the command/manifest row depends on whether a web command exists: a
  // static "no command" verdict can be wrong on macOS, where the app PATH
  // cannot see a login-shell dsh. Rows 1-9 are evidence-based and stay put.
  const roleDependsOnWebCommand = staticTarget.role === "mutable"
    || staticTarget.reason === "web-profile-uninitialized"
    || staticTarget.reason === "cli-unavailable"
    || staticTarget.reason === "web-not-used";
  if (!roleDependsOnWebCommand) return staticTarget;
  const commandInfo = await resolveDshCommand(options);
  const kind = commandInfo && commandInfo.kind === "desktop" ? "desktop" : "npm";
  const carrier = commandInfo
    ? { status: "unverified", kind, path: commandInfo.command }
    : { status: "unavailable", kind: "npm", path: null };
  const role = resolveWebDshRole({ evidence: staticTarget.evidence, carrier, operation });
  const rebuilt = {
    ...staticTarget,
    role: role.role,
    reason: role.reason,
    manualFallback: role.manualFallback === true,
    initializesProfile: role.initializesProfile === true,
    carrier,
  };
  if (rebuilt.role !== "mutable" || !commandInfo) return rebuilt;
  const probe = await probeDshCarrier(commandInfo, options);
  if (probe.status === "available") {
    return {
      ...rebuilt,
      role: "mutable",
      reason: null,
      carrier: { status: "available", kind, version: probe.version, commandInfo },
    };
  }
  return {
    ...rebuilt,
    role: "diagnose",
    reason: probe.reason,
    carrier: { ...dshCarrierUnavailable(kind), version: probe.version || null },
  };
}

// Operation-mode target resolution for the later orchestration: re-discover the
// desktop app asynchronously, take the static records, then probe only the
// mutable carriers. diagnose / not-applicable targets are returned untouched.
async function resolveDshTargets(options = {}, { operation } = {}) {
  const resolvedOperation = normalizeDshTargetOperation(operation);
  const desktopDiscovery = await discoverDshDesktop(options);
  const staticTargets = inspectDshTargetsSync(
    { ...options, desktopDiscovery },
    { operation: resolvedOperation }
  );
  return {
    web: await resolveDshWebTarget(staticTargets.web, options, resolvedOperation),
    desktop: await resolveDshTargetCarrier(staticTargets.desktop, DESKTOP_PROFILE_NAME, options, resolvedOperation, desktopDiscovery),
  };
}

async function readSourceBundle(options = {}) {
  const contract = options.contract
    || dshTargetContract(dshFamilyForVersion(options.dshVersion), options.dshVersion)
    || PREFERRED_DSH_CONTRACT;
  const sourceDir = options.sourceDir || resolveBridgeSourceDir(options.baseDir);
  const files = [];
  for (const relativePath of BRIDGE_SOURCE_FILES) {
    const filePath = path.join(sourceDir, ...relativePath.split("/"));
    const stat = await fsp.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`DSH bridge source must be a regular file: ${filePath}`);
    }
    files.push({ relativePath, content: await fsp.readFile(filePath) });
  }
  return { sourceDir, files, bundleHash: digestBridgeFiles(files, contract), contract };
}

async function sourceClawdVersion(options = {}) {
  if (typeof options.clawdVersion === "string" && options.clawdVersion.trim()) {
    return options.clawdVersion.trim();
  }
  const packageManifest = await readJson(path.join(__dirname, "..", "package.json"));
  return packageManifest && typeof packageManifest.version === "string"
    ? packageManifest.version
    : "0.0.0";
}

async function promoteGeneration(bundle, options = {}) {
  const contract = options.contract || bundle.contract || PREFERRED_DSH_CONTRACT;
  const managedRoot = resolveManagedRoot(options);
  const generationsDir = path.join(managedRoot, "generations");
  const generationDir = path.join(generationsDir, bundle.bundleHash);
  const version = await sourceClawdVersion(options);
  await fsp.mkdir(generationsDir, { recursive: true });
  const existing = await readJson(path.join(generationDir, MANIFEST_FILE));
  const existingContract = existing ? dshContractForMarker(existing) : null;
  const existingHash = existing && existingContract ? await hashBridgeDirectory(generationDir, existingContract) : null;
  if (
    existing
    && existing.owner === MANAGED_OWNER
    && existing.schemaVersion === MANIFEST_SCHEMA_VERSION
    && existing.protocolVersion === BRIDGE_PROTOCOL_VERSION
    && existing.bundleHash === bundle.bundleHash
    && existingContract
    && existingContract.supportedDshRange === contract.supportedDshRange
    && existingHash === bundle.bundleHash
  ) {
    return { managedRoot, generationDir, bundleHash: bundle.bundleHash, created: false, manifest: existing };
  }
  if (await exists(generationDir)) {
    throw new Error(`DSH generation path exists without a matching marker: ${generationDir}`);
  }
  const stagingDir = path.join(generationsDir, `.staging-${process.pid}-${crypto.randomUUID()}`);
  await fsp.mkdir(stagingDir, { recursive: false });
  try {
    for (const file of bundle.files) {
      const target = path.join(stagingDir, ...file.relativePath.split("/"));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, file.content, { flag: "wx" });
    }
    const manifest = {
      owner: MANAGED_OWNER,
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      packageName: BRIDGE_PACKAGE_NAME,
      bundleHash: bundle.bundleHash,
      sourceClawdVersion: version,
      supportedDshRange: contract.supportedDshRange,
      installedDshVersion: options.dshVersion || contract.artifactVersion || contract.version,
      installedDshVersionAssumedAtStaging: options.dshVersionAssumed === true,
      verifiedDshArtifact: contract.verifiedDshArtifact,
      verifiedDshArtifactIntegrity: contract.verifiedDshArtifactIntegrity,
      sourceAuditBaselineCommit: SOURCE_AUDIT_BASELINE_COMMIT,
      installedAt: new Date().toISOString(),
    };
    await fsp.writeFile(
      path.join(stagingDir, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 }
    );
    try {
      await fsp.rename(stagingDir, generationDir);
    } catch (err) {
      if (!err || (err.code !== "EEXIST" && err.code !== "ENOTEMPTY")) throw err;
      const raced = await readJson(path.join(generationDir, MANIFEST_FILE));
      const racedHash = raced ? await hashBridgeDirectory(generationDir, contract) : null;
      if (
        !raced
        || raced.owner !== MANAGED_OWNER
        || raced.bundleHash !== bundle.bundleHash
        || racedHash !== bundle.bundleHash
      ) throw err;
      await fsp.rm(stagingDir, { recursive: true, force: true });
      return { managedRoot, generationDir, bundleHash: bundle.bundleHash, created: false, manifest: raced };
    }
    return { managedRoot, generationDir, bundleHash: bundle.bundleHash, created: true, manifest };
  } catch (err) {
    if (path.resolve(stagingDir).startsWith(`${path.resolve(generationsDir)}${path.sep}`)) {
      try { await fsp.rm(stagingDir, { recursive: true, force: true }); } catch {}
    }
    throw err;
  }
}

function mutationLockOperationTimeoutMs(options = {}) {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return DEFAULT_OPERATION_TIMEOUT_MS;
  }
  const timeoutMs = Math.ceil(options.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > MAX_MUTATION_LOCK_OPERATION_TIMEOUT_MS) {
    throw new RangeError("DeepSeek Harness mutation timeout is outside the supported lock range");
  }
  return timeoutMs;
}

function mutationLockStaleMs(owner) {
  return owner.operationTimeoutMs * MUTATION_LOCK_STALE_MULTIPLIER;
}

function isValidMutationLockOwner(owner) {
  return !!(
    owner
    && owner.owner === MANAGED_OWNER
    && owner.schemaVersion === MUTATION_LOCK_SCHEMA_VERSION
    && typeof owner.token === "string"
    && owner.token.length > 0
    && owner.token.length <= 200
    && Number.isSafeInteger(owner.pid)
    && owner.pid > 0
    && Number.isSafeInteger(owner.operationTimeoutMs)
    && owner.operationTimeoutMs > 0
    && owner.operationTimeoutMs <= MAX_MUTATION_LOCK_OPERATION_TIMEOUT_MS
    && typeof owner.createdAt === "string"
    && Number.isFinite(Date.parse(owner.createdAt))
  );
}

function sameMutationLockOwner(left, right) {
  return isValidMutationLockOwner(left)
    && isValidMutationLockOwner(right)
    && left.owner === right.owner
    && left.schemaVersion === right.schemaVersion
    && left.token === right.token
    && left.pid === right.pid
    && left.operationTimeoutMs === right.operationTimeoutMs
    && left.createdAt === right.createdAt;
}

function mutationLockError(lockDir, owner, detail = "") {
  const pidDetail = owner && Number.isSafeInteger(owner.pid) ? ` (pid ${owner.pid})` : "";
  const suffix = detail ? `; ${detail}` : "";
  const err = new Error(
    `DeepSeek Harness integration mutation is already locked${pidDetail}; lock path: ${lockDir}${suffix}`
  );
  err.code = "DSH_MUTATION_LOCKED";
  err.lockPath = lockDir;
  return err;
}

function mutationLockProcessState(pid, options = {}) {
  const processKill = typeof options.processKill === "function"
    ? options.processKill
    : process.kill.bind(process);
  try {
    processKill(pid, 0);
    return "alive";
  } catch (err) {
    // ESRCH is the only portable proof that the recorded owner no longer
    // exists. EPERM and every unknown Windows error remain fail-closed.
    return err && err.code === "ESRCH" ? "dead" : "unknown";
  }
}

async function cleanupQuarantinedMutationLock(quarantineDir, expectedOwner) {
  try {
    const ownerPath = path.join(quarantineDir, "owner.json");
    const owner = await readJson(ownerPath);
    if (!sameMutationLockOwner(owner, expectedOwner)) return false;
    await fsp.unlink(ownerPath);
    await fsp.rmdir(quarantineDir);
    return true;
  } catch {
    // A quarantine sibling never blocks the canonical lock path. Do not use a
    // recursive fallback if unexpected contents appeared after the rename.
    return false;
  }
}

async function quarantineStaleMutationLock(lockDir, options = {}) {
  const owner = await readJson(path.join(lockDir, "owner.json"));
  if (!isValidMutationLockOwner(owner)) {
    if (!(await exists(lockDir))) return { retry: true, quarantineDir: null, owner: null };
    throw mutationLockError(lockDir, owner, "owner metadata is invalid; manual inspection required");
  }
  const nowMs = typeof options.nowMs === "function" ? options.nowMs() : Date.now();
  const createdAtMs = Date.parse(owner.createdAt);
  if (nowMs < createdAtMs || nowMs - createdAtMs < mutationLockStaleMs(owner)) {
    throw mutationLockError(lockDir, owner, "the lock has not exceeded its stale threshold");
  }
  const processState = mutationLockProcessState(owner.pid, options);
  if (processState !== "dead") {
    throw mutationLockError(
      lockDir,
      owner,
      processState === "alive" ? "the owner process is still alive" : "owner liveness is unknown"
    );
  }

  const quarantineDir = `${lockDir}.stale-${crypto.randomUUID()}`;
  try {
    await fsp.rename(lockDir, quarantineDir);
  } catch (err) {
    if (err && err.code === "ENOENT") return { retry: true, quarantineDir: null, owner: null };
    throw mutationLockError(lockDir, owner, "another process won the stale-lock takeover race");
  }
  const movedOwner = await readJson(path.join(quarantineDir, "owner.json"));
  if (!sameMutationLockOwner(movedOwner, owner)) {
    try { await fsp.rename(quarantineDir, lockDir); } catch {}
    throw mutationLockError(lockDir, movedOwner, "lock ownership changed during stale takeover");
  }
  return { retry: false, quarantineDir, owner };
}

async function acquireMutationLock(options = {}) {
  const managedRoot = resolveManagedRoot(options);
  const lockDir = path.join(managedRoot, "mutation.lock");
  const token = crypto.randomUUID();
  const operationTimeoutMs = mutationLockOperationTimeoutMs(options);
  let quarantined = null;
  await fsp.mkdir(managedRoot, { recursive: true });
  try {
    await fsp.mkdir(lockDir);
  } catch (err) {
    if (err && err.code === "EEXIST") {
      quarantined = await quarantineStaleMutationLock(lockDir, options);
      try {
        await fsp.mkdir(lockDir);
      } catch (retryErr) {
        if (quarantined.quarantineDir) {
          await cleanupQuarantinedMutationLock(quarantined.quarantineDir, quarantined.owner);
        }
        const owner = await readJson(path.join(lockDir, "owner.json"));
        throw mutationLockError(
          lockDir,
          owner,
          retryErr && retryErr.code === "EEXIST"
            ? "another process acquired the lock during recovery"
            : "the lock could not be recreated after recovery"
        );
      }
    } else {
      throw err;
    }
  }
  const expectedOwner = {
    owner: MANAGED_OWNER,
    schemaVersion: MUTATION_LOCK_SCHEMA_VERSION,
    token,
    pid: process.pid,
    operationTimeoutMs,
    createdAt: new Date().toISOString(),
  };
  try {
    if (options.__testMutationLockHooks && typeof options.__testMutationLockHooks.beforeOwnerWrite === "function") {
      await options.__testMutationLockHooks.beforeOwnerWrite({ lockDir, expectedOwner: { ...expectedOwner } });
    }
    await fsp.writeFile(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify(expectedOwner, null, 2)}\n`,
      { flag: "wx", mode: 0o600 }
    );
  } catch (err) {
    // Only an empty directory remains provably ours after an owner-file write
    // failure. Unexpected contents may have appeared concurrently, so never
    // recurse through the canonical lock path.
    try {
      await fsp.rmdir(lockDir);
      throw err;
    } catch (cleanupErr) {
      if (cleanupErr === err) throw err;
      const locked = mutationLockError(
        lockDir,
        await readJson(path.join(lockDir, "owner.json")),
        "owner metadata write failed and the lock is not empty; manual inspection required"
      );
      locked.cause = err;
      throw locked;
    }
  }
  if (quarantined && quarantined.quarantineDir) {
    await cleanupQuarantinedMutationLock(quarantined.quarantineDir, quarantined.owner);
  }
  return {
    lockPath: lockDir,
    async release() {
      const ownerPath = path.join(lockDir, "owner.json");
      const owner = await readJson(ownerPath);
      if (!sameMutationLockOwner(owner, expectedOwner)) {
        throw mutationLockError(lockDir, owner, "lock ownership changed; manual inspection required");
      }
      if (options.__testMutationLockHooks && typeof options.__testMutationLockHooks.beforeReleaseOwnerMove === "function") {
        await options.__testMutationLockHooks.beforeReleaseOwnerMove({ lockDir, expectedOwner: { ...expectedOwner } });
      }
      const releaseOwnerPath = path.join(lockDir, `owner.release-${token}.json`);
      try {
        await fsp.rename(ownerPath, releaseOwnerPath);
      } catch (err) {
        const locked = mutationLockError(lockDir, await readJson(ownerPath), "lock owner could not be isolated for release");
        locked.cause = err;
        throw locked;
      }
      const isolatedOwner = await readJson(releaseOwnerPath);
      if (!sameMutationLockOwner(isolatedOwner, expectedOwner)) {
        throw mutationLockError(lockDir, isolatedOwner, "lock ownership changed during release; manual inspection required");
      }
      try {
        await fsp.unlink(releaseOwnerPath);
        await fsp.rmdir(lockDir);
      } catch (err) {
        const locked = mutationLockError(
          lockDir,
          isolatedOwner,
          "unexpected lock contents prevented exact release; manual inspection required"
        );
        locked.cause = err;
        throw locked;
      }
    },
  };
}

function inspectionLatchPath(options = {}) {
  const profile = normalizeDshProfileName(options.profile);
  const fileName = profile === DESKTOP_PROFILE_NAME
    ? DESKTOP_INSPECTION_LATCH_FILE
    : INSPECTION_LATCH_FILE;
  return path.join(resolveManagedRoot(options), fileName);
}

// Mirrors inspectionLatchEvidenceSync: a missing node is "no record", while an
// invalid node (non-file, symlink, unreadable, wrong schema) is returned as an
// invalid record so every caller treats it conservatively. A plain existence
// check would follow symlinks and fold read errors into "absent", letting a
// broken record slip past the shared generation cleanup.
async function readInspectionLatch(options = {}) {
  const filePath = inspectionLatchPath(options);
  let stat;
  try {
    stat = await fsp.lstat(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    return { invalid: true, reason: "inspection-latch-unreadable" };
  }
  if (!stat.isFile() || (typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink())) {
    return { invalid: true, reason: "inspection-latch-invalid" };
  }
  let raw;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    return { invalid: true, reason: "inspection-latch-unreadable" };
  }
  return parseInspectionLatch(raw) || { invalid: true, reason: "inspection-latch-invalid" };
}

async function writeInspectionLatch(reason, detail, options = {}) {
  const filePath = inspectionLatchPath(options);
  const current = await readInspectionLatch(options);
  if (current && (current.invalid || current.owner !== MANAGED_OWNER || current.schemaVersion !== 1)) {
    throw new Error("DeepSeek Harness inspection latch ownership is invalid; manual inspection required");
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify({
    owner: MANAGED_OWNER,
    schemaVersion: 1,
    reason,
    detail: typeof detail === "string" ? detail.slice(0, 2000) : "",
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
}

// Only a valid record may be removed. A non-file/symlink/unreadable/invalid
// latch is evidence we cannot prove is ours, and the cleanup blocker is already
// paused on it; deleting the node would lift that pause.
async function clearInspectionLatch(options = {}) {
  const filePath = inspectionLatchPath(options);
  const current = await readInspectionLatch(options);
  if (!current) return;
  if (current.invalid) {
    throw new Error("DeepSeek Harness inspection latch ownership is invalid; manual inspection required");
  }
  await fsp.rm(filePath, { force: false });
}

// Per-profile two-step repair operation record. Its shape and ownership checks
// mirror the inspection latch and manual reference files.
function repairOperationPath(options = {}) {
  const profile = normalizeDshProfileName(options.profile);
  return path.join(resolveManagedRoot(options), `repair-operation-${profile}.json`);
}

function isValidRepairOperation(record) {
  return !!(
    record
    && record.owner === MANAGED_OWNER
    && record.schemaVersion === REPAIR_OPERATION_SCHEMA_VERSION
    && typeof record.profile === "string"
    && (record.state === "remove-pending" || record.state === "removed-add-pending")
    && typeof record.targetBundleHash === "string"
    && /^[a-f0-9]{64}$/.test(record.targetBundleHash)
    && typeof record.targetGenerationDir === "string"
    && record.targetGenerationDir
    && typeof record.hostVersion === "string"
    && (record.carrierKind === "npm" || record.carrierKind === "desktop")
    && typeof record.createdAt === "string"
    && Number.isFinite(Date.parse(record.createdAt))
    && typeof record.updatedAt === "string"
    && Number.isFinite(Date.parse(record.updatedAt))
  );
}

// Distinguishes "missing", "valid", "invalid", "unreadable" like the manual
// reference reader, so the caller can fail closed on the last two.
async function readRepairOperation(options = {}) {
  const filePath = repairOperationPath(options);
  let stat;
  try {
    stat = await fsp.lstat(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    return { invalid: true, reason: "repair-record-unreadable", repairPath: filePath };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { invalid: true, reason: "repair-record-invalid", repairPath: filePath };
  }
  let raw;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    return { invalid: true, reason: "repair-record-unreadable", repairPath: filePath };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch {
    return { invalid: true, reason: "repair-record-invalid", repairPath: filePath };
  }
  if (!isValidRepairOperation(parsed)) {
    return { invalid: true, reason: "repair-record-invalid", repairPath: filePath };
  }
  return parsed;
}

function repairOperationEvidenceSync(fsImpl, options) {
  const filePath = repairOperationPath(options);
  let stat;
  try {
    stat = fsImpl.lstatSync(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") return "none";
    return "unknown";
  }
  if (!stat.isFile() || (typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink())) {
    return "invalid";
  }
  let raw;
  try {
    raw = fsImpl.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return "none";
    return "unknown";
  }
  try {
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    return isValidRepairOperation(parsed) ? "present" : "invalid";
  } catch {
    return "invalid";
  }
}

// Refuse to overwrite a record we cannot prove is ours.
async function writeRepairOperation(record, options = {}) {
  const filePath = repairOperationPath(options);
  const current = await readRepairOperation(options);
  if (current && current.invalid) {
    throw new Error("DeepSeek Harness repair operation record ownership is invalid; manual inspection required");
  }
  if (
    options.__testRepairOperationHooks
    && typeof options.__testRepairOperationHooks.beforeWrite === "function"
  ) {
    await options.__testRepairOperationHooks.beforeWrite({ filePath, record });
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

async function clearRepairOperation(options = {}) {
  const filePath = repairOperationPath(options);
  const current = await readRepairOperation(options);
  if (!current) return false;
  if (current.invalid) {
    throw new Error("DeepSeek Harness repair operation record ownership is invalid; manual inspection required");
  }
  await fsp.rm(filePath, { force: false });
  return true;
}

// A valid record keeps its target generation alive; an invalid or unreadable
// record is treated conservatively, same as the manual reference anchor.
async function repairRecordReferencesGeneration(generationDir, options = {}) {
  const hash = path.basename(generationDir);
  for (const profileName of DSH_PROFILE_NAMES) {
    const record = await readRepairOperation({ ...options, profile: profileName });
    if (record && record.invalid) return true;
    if (
      record
      && isValidRepairOperation(record)
      && record.targetBundleHash === hash
      && sameResolvedPath(generationDir, record.targetGenerationDir, options.platform)
    ) return true;
  }
  return false;
}

function manualGenerationReferencePath(options = {}) {
  return path.join(resolveManagedRoot(options), MANUAL_GENERATION_REFERENCE_FILE);
}

async function listManualGenerationReferenceResidues(options = {}) {
  const filePath = manualGenerationReferencePath(options);
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.`;
  try {
    const readdir = options.__testManualGenerationReferenceHooks
      && typeof options.__testManualGenerationReferenceHooks.readdirResidues === "function"
      ? options.__testManualGenerationReferenceHooks.readdirResidues
      : fsp.readdir.bind(fsp);
    const entries = await readdir(dir, { withFileTypes: true });
    return {
      paths: entries
      .filter((entry) => entry.name.startsWith(prefix))
      .map((entry) => path.join(dir, entry.name))
      .sort(),
      unreadableError: null,
    };
  } catch (err) {
    if (err && err.code === "ENOENT") return { paths: [], unreadableError: null };
    return { paths: [], unreadableError: err || new Error("manual reference directory is unreadable") };
  }
}

function isValidManualGenerationReference(reference) {
  return !!(
    reference
    && reference.owner === MANAGED_OWNER
    && reference.schemaVersion === MANUAL_GENERATION_REFERENCE_SCHEMA_VERSION
    && reference.packageName === BRIDGE_PACKAGE_NAME
    && typeof reference.bundleHash === "string"
    && /^[a-f0-9]{64}$/.test(reference.bundleHash)
    && reference.reason === "manual-npx-add"
    && typeof reference.createdAt === "string"
    && Number.isFinite(Date.parse(reference.createdAt))
  );
}

function sameManualGenerationReference(left, right) {
  return isValidManualGenerationReference(left)
    && isValidManualGenerationReference(right)
    && left.owner === right.owner
    && left.schemaVersion === right.schemaVersion
    && left.packageName === right.packageName
    && left.bundleHash === right.bundleHash
    && left.reason === right.reason
    && left.createdAt === right.createdAt;
}

async function readManualGenerationReference(options = {}) {
  const filePath = manualGenerationReferencePath(options);
  const scanBefore = await listManualGenerationReferenceResidues(options);
  if (scanBefore.unreadableError) {
    return {
      invalid: true,
      referencePath: path.dirname(filePath),
      reason: "reference-directory-unreadable",
    };
  }
  const residuesBefore = scanBefore.paths;
  let stat;
  try {
    stat = await fsp.lstat(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      if (residuesBefore.length) {
        return {
          invalid: true,
          referencePath: residuesBefore[0],
          residuePaths: residuesBefore,
          reason: "reference-residue",
        };
      }
      return null;
    }
    return { invalid: true, referencePath: filePath, reason: "reference-unreadable" };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { invalid: true, referencePath: filePath, reason: "reference-not-regular-file" };
  }
  const reference = await readJson(filePath);
  if (!isValidManualGenerationReference(reference)) {
    return { invalid: true, referencePath: filePath, reason: "reference-invalid" };
  }
  const scanAfter = await listManualGenerationReferenceResidues(options);
  if (scanAfter.unreadableError) {
    return {
      invalid: true,
      referencePath: path.dirname(filePath),
      reason: "reference-directory-unreadable",
    };
  }
  const residues = [...new Set([...residuesBefore, ...scanAfter.paths])];
  if (residues.length) {
    return {
      invalid: true,
      referencePath: residues[0],
      residuePaths: residues,
      reason: "reference-residue",
    };
  }
  return reference;
}

function listManualGenerationReferenceResiduesSync(fsImpl, options = {}) {
  const filePath = manualGenerationReferencePath(options);
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.`;
  try {
    return {
      paths: fsImpl.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.name.startsWith(prefix))
        .map((entry) => path.join(dir, entry.name))
        .sort(),
      unreadableError: null,
    };
  } catch (err) {
    if (err && err.code === "ENOENT") return { paths: [], unreadableError: null };
    return { paths: [], unreadableError: err || new Error("manual reference directory is unreadable") };
  }
}

// Synchronous twin of readManualGenerationReference, for the static target
// inspection. It keeps the same distinguishable outcomes (missing, valid,
// residue, invalid, unreadable) so role reasons can tell them apart.
function readManualGenerationReferenceSync(fsImpl, options = {}) {
  const filePath = manualGenerationReferencePath(options);
  const scanBefore = listManualGenerationReferenceResiduesSync(fsImpl, options);
  if (scanBefore.unreadableError) {
    return {
      invalid: true,
      referencePath: path.dirname(filePath),
      reason: "reference-directory-unreadable",
    };
  }
  const residuesBefore = scanBefore.paths;
  let stat;
  try {
    stat = fsImpl.lstatSync(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      if (residuesBefore.length) {
        return {
          invalid: true,
          referencePath: residuesBefore[0],
          residuePaths: residuesBefore,
          reason: "reference-residue",
        };
      }
      return null;
    }
    return { invalid: true, referencePath: filePath, reason: "reference-unreadable" };
  }
  if (!stat.isFile() || (typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink())) {
    return { invalid: true, referencePath: filePath, reason: "reference-not-regular-file" };
  }
  const reference = readJsonSync(fsImpl, filePath);
  if (!isValidManualGenerationReference(reference)) {
    return { invalid: true, referencePath: filePath, reason: "reference-invalid" };
  }
  const scanAfter = listManualGenerationReferenceResiduesSync(fsImpl, options);
  if (scanAfter.unreadableError) {
    return {
      invalid: true,
      referencePath: path.dirname(filePath),
      reason: "reference-directory-unreadable",
    };
  }
  const residues = [...new Set([...residuesBefore, ...scanAfter.paths])];
  if (residues.length) {
    return {
      invalid: true,
      referencePath: residues[0],
      residuePaths: residues,
      reason: "reference-residue",
    };
  }
  return reference;
}

function manualGenerationReferenceError(reference, options = {}) {
  const filePath = reference && reference.referencePath
    ? reference.referencePath
    : manualGenerationReferencePath(options);
  const err = new Error(
    `DeepSeek Harness manual generation reference is invalid; manual inspection required: ${filePath}`
  );
  err.code = "DSH_MANUAL_GENERATION_REFERENCE_INVALID";
  err.referencePath = filePath;
  return err;
}

function manualGenerationReferenceResult(reference, options = {}) {
  const err = manualGenerationReferenceError(reference, options);
  return {
    status: "error",
    reason: "manual-generation-reference-invalid",
    message: err.message,
    referencePath: err.referencePath,
    manualInspectionRequired: true,
  };
}

async function writeManualGenerationReference(generation, options = {}) {
  const managedRoot = resolveManagedRoot(options);
  const expectedGeneration = path.join(managedRoot, "generations", generation.bundleHash);
  if (!sameResolvedPath(generation.generationDir, expectedGeneration, options.platform)) {
    throw new Error("Refusing to reference a manual DSH generation outside the managed namespace");
  }
  const marker = await readJson(path.join(expectedGeneration, MANIFEST_FILE));
  const markerContract = dshContractForMarker(marker);
  const actualHash = markerContract
    ? await hashBridgeDirectory(expectedGeneration, markerContract)
    : null;
  if (
    !marker
    || !markerContract
    || marker.owner !== MANAGED_OWNER
    || marker.bundleHash !== generation.bundleHash
    || actualHash !== generation.bundleHash
  ) {
    throw new Error("Refusing to reference a manual DSH generation whose marker or bytes are invalid");
  }
  const filePath = manualGenerationReferencePath(options);
  const existing = await readManualGenerationReference(options);
  if (existing && existing.invalid) throw manualGenerationReferenceError(existing, options);
  if (existing) {
    if (existing.bundleHash === generation.bundleHash) return false;
    const err = new Error(
      `A different DeepSeek Harness manual generation is still referenced; inspect it before replacement: ${filePath}`
    );
    err.code = "DSH_MANUAL_GENERATION_REFERENCE_ACTIVE";
    err.referencePath = filePath;
    throw err;
  }
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fsp.writeFile(tempPath, `${JSON.stringify({
      owner: MANAGED_OWNER,
      schemaVersion: MANUAL_GENERATION_REFERENCE_SCHEMA_VERSION,
      packageName: BRIDGE_PACKAGE_NAME,
      bundleHash: generation.bundleHash,
      reason: "manual-npx-add",
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    try {
      // Linking the completed temp file into the canonical name is an atomic
      // create-if-absent operation on the same filesystem. A concurrent or
      // malformed anchor is never overwritten (POSIX rename would overwrite).
      await fsp.link(tempPath, filePath);
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      const raced = await readManualGenerationReference(options);
      if (raced && !raced.invalid && raced.bundleHash === generation.bundleHash) return false;
      if (raced && raced.invalid) throw manualGenerationReferenceError(raced, options);
      const conflict = new Error(
        `A different DeepSeek Harness manual generation reference appeared concurrently: ${filePath}`
      );
      conflict.code = "DSH_MANUAL_GENERATION_REFERENCE_ACTIVE";
      conflict.referencePath = filePath;
      throw conflict;
    }
    return true;
  } catch (err) {
    throw err;
  } finally {
    try { await fsp.unlink(tempPath); } catch {}
  }
}

async function clearManualGenerationReference(options = {}) {
  const filePath = manualGenerationReferencePath(options);
  const reference = await readManualGenerationReference(options);
  if (!reference) return false;
  if (reference.invalid) throw manualGenerationReferenceError(reference, options);
  if (
    options.__testManualGenerationReferenceHooks
    && typeof options.__testManualGenerationReferenceHooks.beforeClearMove === "function"
  ) {
    await options.__testManualGenerationReferenceHooks.beforeClearMove({ filePath, reference: { ...reference } });
  }
  const isolatedPath = `${filePath}.clearing-${crypto.randomUUID()}`;
  try {
    await fsp.rename(filePath, isolatedPath);
  } catch (err) {
    const changed = manualGenerationReferenceError(
      { referencePath: filePath },
      options
    );
    changed.message = `DeepSeek Harness manual generation reference changed before cleanup; manual inspection required: ${filePath}`;
    changed.cause = err;
    throw changed;
  }
  const isolated = await readJson(isolatedPath);
  if (!sameManualGenerationReference(isolated, reference)) {
    try {
      if (
        options.__testManualGenerationReferenceHooks
        && typeof options.__testManualGenerationReferenceHooks.beforeRestore === "function"
      ) {
        await options.__testManualGenerationReferenceHooks.beforeRestore({
          filePath,
          isolatedPath,
          reference: isolated,
        });
      }
      await fsp.link(isolatedPath, filePath);
      await fsp.unlink(isolatedPath);
    } catch {}
    const changed = manualGenerationReferenceError({ referencePath: filePath }, options);
    changed.message = `DeepSeek Harness manual generation reference changed during cleanup; manual inspection required: ${filePath}`;
    throw changed;
  }
  if (
    options.__testManualGenerationReferenceHooks
    && typeof options.__testManualGenerationReferenceHooks.afterClearMove === "function"
  ) {
    await options.__testManualGenerationReferenceHooks.afterClearMove({
      filePath,
      isolatedPath,
      reference: { ...reference },
    });
  }
  try {
    if (
      options.__testManualGenerationReferenceHooks
      && typeof options.__testManualGenerationReferenceHooks.beforeIsolatedUnlink === "function"
    ) {
      await options.__testManualGenerationReferenceHooks.beforeIsolatedUnlink({
        filePath,
        isolatedPath,
        reference: isolated,
      });
    }
    await fsp.unlink(isolatedPath);
  } catch (err) {
    const changed = manualGenerationReferenceError({ referencePath: isolatedPath }, options);
    changed.message = `DeepSeek Harness manual generation reference residue could not be removed; manual inspection required: ${isolatedPath}`;
    changed.cause = err;
    throw changed;
  }
  const replacement = await readManualGenerationReference(options);
  if (replacement) {
    const changed = manualGenerationReferenceError(
      { referencePath: filePath },
      options
    );
    changed.message = `A new DeepSeek Harness manual generation reference appeared during cleanup; manual inspection required: ${filePath}`;
    throw changed;
  }
  return true;
}

function inspectionLatchResult(latch) {
  return {
    status: "error",
    reason: "inspection-required",
    message: latch && latch.invalid
      ? "The DeepSeek Harness inspection latch is invalid; inspect the managed integration before retrying"
      : "A previous DeepSeek Harness plugin mutation had an unknown result; use explicit Repair or Uninstall after inspecting the profile",
    manualInspectionRequired: true,
  };
}

// Startup sync reports a plugin the user disabled in DSH instead of re-adding
// it; that decision is independent of Clawd's version and the target hash.
function pluginDisabledInDshResult(health) {
  return {
    status: "error",
    reason: "plugin-disabled-in-dsh",
    healthReason: health && health.status || null,
    message: "The DeepSeek Harness plugin is disabled in DSH (dependency present, bundle entry missing); startup sync only reports it",
  };
}

function dshSuccessMessage(profile) {
  return profile === DESKTOP_PROFILE_NAME ? DSH_DESKTOP_RESTART_HINT : DSH_RESTART_HINT;
}

function dshCleanupPausedWarning(cleanup) {
  return cleanup && cleanup.paused
    ? `old plugin files were kept because the shared cleanup is paused (${cleanup.reason})`
    : null;
}

function repairRecordResult(record, scoped) {
  return {
    status: "error",
    reason: record && record.reason === "repair-record-unreadable"
      ? "repair-record-unreadable"
      : "repair-record-invalid",
    message: "The DeepSeek Harness repair operation record cannot be used; manual inspection is required",
    repairPath: (record && record.repairPath) || repairOperationPath(scoped),
    manualInspectionRequired: true,
  };
}

function repairNeedsInspectionResult(scoped, detail) {
  return {
    status: "error",
    reason: "repair-needs-inspection",
    message: "DeepSeek Harness repair state is unclear or a foreign package is present; manual inspection is required",
    detail: detail || null,
    repairPath: repairOperationPath(scoped),
    manualInspectionRequired: true,
  };
}

function isUnknownCommandResult(result) {
  return !!(result && (result.timedOut || result.signal || result.outputLimited));
}

function hasMutableManagedState(health) {
  if (!health) return false;
  if (health.status === "absent" || health.status === "profile-missing") return true;
  if (!health.owned || !health.marker) return false;
  return new Set([
    "healthy",
    "generation-mismatch",
    "version-unsupported",
    "profile-entry-incomplete",
    "managed-bundle-missing",
    "managed-residue",
  ]).has(health.status);
}

function sameResolvedPath(left, right, platform = process.platform) {
  if (!left || !right) return false;
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

async function unlinkManagedProfileResidue(health, options = {}) {
  if (
    !health
    || health.status !== "managed-residue"
    || health.dependencyPresent
    || health.bundlePresent
    || health.installationResolved
    || !health.profileResolved
    || !health.marker
    || !isIntactManaged(health.profileResolved)
  ) {
    return { removed: false, reason: "not-exact-managed-residue" };
  }
  const managedRoot = resolveManagedRoot(options);
  const expectedGeneration = path.join(
    managedRoot,
    "generations",
    health.marker.bundleHash
  );
  if (
    !isManagedGenerationRecord(health.profileResolved, managedRoot, options)
    || !sameResolvedPath(health.profileResolved.packageDir, expectedGeneration, options.platform)
  ) {
    return { removed: false, reason: "residue-target-mismatch" };
  }
  const profileDir = health.profileDir || resolveDshProfileDir(
    options.dshHome || resolveDshHome(options.env)
  );
  const linkDir = path.dirname(packagePath(profileDir, BRIDGE_PACKAGE_NAME));
  let stat;
  let realTarget;
  try {
    stat = await fsp.lstat(linkDir);
    if (!stat.isSymbolicLink()) {
      return { removed: false, reason: "residue-not-link" };
    }
    realTarget = await fsp.realpath(linkDir);
  } catch (err) {
    return { removed: false, reason: "residue-inspection-failed", error: err };
  }
  if (!sameResolvedPath(realTarget, expectedGeneration, options.platform)) {
    return { removed: false, reason: "residue-link-target-mismatch" };
  }
  if (
    options.__testManagedProfileResidueHooks
    && typeof options.__testManagedProfileResidueHooks.beforeIsolateMove === "function"
  ) {
    await options.__testManagedProfileResidueHooks.beforeIsolateMove({
      linkDir,
      expectedGeneration,
    });
  }
  const isolatedPath = `${linkDir}.clawd-removing-${crypto.randomUUID()}`;
  try {
    await fsp.rename(linkDir, isolatedPath);
  } catch (err) {
    return { removed: false, reason: "residue-isolation-failed", error: err };
  }
  let isolatedStat;
  let isolatedTarget;
  try {
    isolatedStat = await fsp.lstat(isolatedPath);
    isolatedTarget = await fsp.realpath(isolatedPath);
  } catch (err) {
    return {
      removed: false,
      reason: "residue-isolation-inspection-failed",
      residuePath: isolatedPath,
      error: err,
    };
  }
  if (!isolatedStat.isSymbolicLink() || !sameResolvedPath(
    isolatedTarget,
    expectedGeneration,
    options.platform
  )) {
    const restored = await restoreIsolatedProfileSymlink(isolatedPath, linkDir, options);
    return {
      removed: false,
      reason: restored ? "residue-target-changed" : "residue-isolation-changed",
      residuePath: restored ? null : isolatedPath,
    };
  }
  try {
    const unlink = options.unlinkManagedProfileLink || fsp.unlink.bind(fsp);
    await unlink(isolatedPath);
  } catch (err) {
    const restored = await restoreIsolatedProfileSymlink(isolatedPath, linkDir, options);
    return {
      removed: false,
      reason: restored ? "residue-unlink-failed" : "residue-unlink-restore-failed",
      residuePath: restored ? null : isolatedPath,
      error: err,
    };
  }
  return { removed: true, linkDir };
}

async function restoreIsolatedProfileSymlink(isolatedPath, linkDir, options = {}) {
  let target;
  try {
    target = await fsp.readlink(isolatedPath);
  } catch {
    return false;
  }
  try {
    await fsp.symlink(
      target,
      linkDir,
      (options.platform || process.platform) === "win32" ? "junction" : undefined
    );
  } catch {
    return false;
  }
  try {
    await fsp.unlink(isolatedPath);
    return true;
  } catch {
    return false;
  }
}

async function cleanLockedManagedProfileResidue(locked, commandInfo, lockedLatch, options = {}) {
  // An invalid/unreadable record is itself pausing shared cleanup; stop before
  // unlinking anything, or the cleanup would lift its own pause.
  if (lockedLatch && lockedLatch.invalid) return inspectionLatchResult(lockedLatch);
  const cleanup = await unlinkManagedProfileResidue(locked, options);
  if (!cleanup.removed) {
    await writeInspectionLatch("plugin-remove-residue-cleanup-failed", cleanup.reason, options);
    return {
      status: "error",
      reason: "inspection-required",
      healthReason: locked.status,
      cleanupReason: cleanup.reason,
      residuePath: cleanup.residuePath || null,
      message: "The DSH profile retains a managed package link that could not be safely removed",
      manualInspectionRequired: true,
    };
  }
  const recovered = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
  if (recovered.status !== "absent" && recovered.status !== "profile-missing") {
    await writeInspectionLatch("plugin-remove-verification-failed", recovered.status, options);
    return {
      status: "error",
      reason: "inspection-required",
      healthReason: recovered.status,
      message: "The DSH profile still resolves the managed bridge after exact link cleanup",
      manualInspectionRequired: true,
    };
  }
  // manual reference is web-owned, so residue cleanup on desktop never touches it.
  if ((options.profile || WEB_PROFILE_NAME) === WEB_PROFILE_NAME) {
    await clearManualGenerationReference(options);
  }
  // Clear this side's resolved latch and record first, so they do not pause the
  // shared cleanup they themselves just satisfied.
  if (lockedLatch) await clearInspectionLatch(options);
  // Registration is gone, so a pending repair record no longer protects anything.
  try { await clearRepairOperation(options); } catch {}
  const generationCleanup = await cleanUnreferencedGenerations(null, options);
  const warning = dshCleanupPausedWarning(generationCleanup);
  return { status: "ok", removed: true, updated: true, ...(warning ? { warnings: [warning] } : {}) };
}

function healthFingerprint(health) {
  if (!health) return "missing";
  return JSON.stringify({
    status: health.status,
    dependencySpec: health.dependencySpec || null,
    dependencyPresent: health.dependencyPresent === true,
    bundlePresent: health.bundlePresent === true,
    markerHash: health.marker && health.marker.bundleHash || null,
    resolvedAnchor: health.resolved && health.resolved.anchor || null,
  });
}

function enqueueMutation(operation) {
  const run = mutationTail.then(operation, operation);
  mutationTail = run.catch(() => {});
  return run;
}

function compareVersions(left, right) {
  const parse = (value) => String(value || "").match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) || null;
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

// The generations/ tree is shared by both profiles, so any unresolved state on
// either side pauses deletion of every generation. Returns a short reason code
// or null. This never blocks that side's own install/verify work.
async function dshGenerationCleanupBlocker(options = {}) {
  const dshHome = options.dshHome || resolveDshHome(options.env);
  const profilesDir = path.join(dshHome, "profiles");
  // 1. profiles/ unreadable (missing is fine: there is nothing to protect).
  try {
    if (options.__testKeepaliveHooks && options.__testKeepaliveHooks.readdirProfilesError) {
      throw options.__testKeepaliveHooks.readdirProfilesError;
    }
    await fsp.readdir(profilesDir, { withFileTypes: true });
  } catch (err) {
    if (!(err && err.code === "ENOENT")) return "profiles-unreadable";
  }
  for (const profileName of DSH_PROFILE_NAMES) {
    const scoped = { ...options, profile: profileName };
    const profileDir = resolveDshProfileDir(dshHome, profileName);
    // 2. A symlinked profile directory cannot be trusted to identify its own package.
    let stat;
    try {
      stat = await fsp.lstat(profileDir);
    } catch (err) {
      if (err && err.code === "ENOENT") stat = null;
      else return `${profileName}:profile-unreadable`;
    }
    if (stat && stat.isSymbolicLink()) return `${profileName}:profile-symlink`;
    // 3. A present but unreadable or unparseable manifest is unresolved state.
    const manifestPath = path.join(profileDir, "package.json");
    let raw = null;
    try {
      raw = await fsp.readFile(manifestPath, "utf8");
    } catch (err) {
      if (!(err && err.code === "ENOENT")) return `${profileName}:manifest-unreadable`;
    }
    if (raw !== null) {
      try {
        JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
      } catch {
        return `${profileName}:manifest-invalid`;
      }
    }
    // 4. Interrupted profile-link removal or an unreadable residue directory.
    const residues = await listManagedProfileRemovalResidues(scoped);
    if (residues.unreadableError) return `${profileName}:residue-unreadable`;
    if (residues.paths.length) return `${profileName}:removal-residue`;
    // 5. A single inspection record, valid or not, fences the shared cleanup
    // until that side's target is re-verified and the record is cleared.
    if (await readInspectionLatch(scoped)) return `${profileName}:inspection-latch`;
    // 6. A broken repair record cannot be used to keep generations alive.
    const record = await readRepairOperation(scoped);
    if (record && record.invalid) return `${profileName}:${record.reason}`;
  }
  // 7. The web manual reference anchor is web-owned; unresolved means pause.
  const manualReference = await readManualGenerationReference(options);
  if (manualReference && manualReference.invalid) {
    const unreadable = manualReference.reason === "reference-directory-unreadable"
      || manualReference.reason === "reference-unreadable";
    return `web:${unreadable ? "manual-reference-unreadable" : "manual-reference-invalid"}`;
  }
  return null;
}

async function cleanUnreferencedGenerations(activeHash, options = {}) {
  const blocked = await dshGenerationCleanupBlocker(options);
  if (blocked) return { paused: true, reason: blocked };
  const generationsDir = path.join(resolveManagedRoot(options), "generations");
  let entries;
  try {
    entries = await fsp.readdir(generationsDir, { withFileTypes: true });
  } catch {
    return { paused: false, removed: [] };
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === activeHash || entry.name.startsWith(".staging-")) continue;
    const candidate = path.join(generationsDir, entry.name);
    const marker = await readJson(path.join(candidate, MANIFEST_FILE));
    if (!marker || marker.owner !== MANAGED_OWNER || marker.bundleHash !== entry.name) continue;
    if (await isGenerationReferenced(candidate, options)) continue;
    await fsp.rm(candidate, { recursive: true, force: false });
    removed.push(entry.name);
  }
  return { paused: false, removed };
}

function isPathWithin(candidate, parent) {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedParent = path.resolve(parent);
  return normalizedCandidate === normalizedParent
    || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
}

async function isGenerationReferenced(generationDir, options = {}) {
  const manualReference = await readManualGenerationReference(options);
  // An invalid anchor has lost the information needed to identify its one
  // protected generation. Conservatively retain every generation until the
  // user inspects the exact reference path.
  if (manualReference && manualReference.invalid) return true;
  if (
    isValidManualGenerationReference(manualReference)
    && manualReference.bundleHash === path.basename(generationDir)
    && sameResolvedPath(
      generationDir,
      path.join(resolveManagedRoot(options), "generations", manualReference.bundleHash),
      options.platform
    )
  ) return true;
  // A pending two-step repair keeps its target generation alive; both profiles
  // share the managed namespace.
  if (await repairRecordReferencesGeneration(generationDir, options)) return true;
  const dshHome = options.dshHome || resolveDshHome(options.env);
  const profilesDir = path.join(dshHome, "profiles");
  let profiles = [];
  try {
    profiles = await fsp.readdir(profilesDir, { withFileTypes: true });
  } catch {}
  for (const profile of profiles) {
    if (!profile.isDirectory() || profile.name === "node_modules") continue;
    const profileDir = path.join(profilesDir, profile.name);
    const manifest = await readJson(path.join(profileDir, "package.json"));
    const spec = manifest
      && manifest.dependencies
      && manifest.dependencies[BRIDGE_PACKAGE_NAME];
    const sourcePath = dependencySourcePath(spec, profileDir);
    if (sourcePath && isPathWithin(sourcePath, generationDir)) return true;
    const materialized = await inspectResolvedPackage(
      packagePath(profileDir, BRIDGE_PACKAGE_NAME),
      "reference-check"
    );
    if (
      isIntactManaged(materialized)
      && materialized.clawdManifest.bundleHash === path.basename(generationDir)
    ) return true;
  }
  // The shared profiles/node_modules tree is DSH's application dependency
  // closure, not a Clawd ownership anchor. A flat fallback must not retain a
  // generation after the real profile reference is gone. Check both profiles.
  for (const root of [
    resolveDshProfileDir(dshHome, WEB_PROFILE_NAME),
    resolveDshProfileDir(dshHome, DESKTOP_PROFILE_NAME),
  ]) {
    const manifestPath = packagePath(root, BRIDGE_PACKAGE_NAME);
    try {
      const realPackageDir = path.dirname(await fsp.realpath(manifestPath));
      if (isPathWithin(realPackageDir, generationDir)) return true;
    } catch {}
    const materialized = await inspectResolvedPackage(manifestPath, "reference-check");
    if (
      isIntactManaged(materialized)
      && materialized.clawdManifest.bundleHash === path.basename(generationDir)
    ) return true;
  }
  return false;
}

async function discardCreatedGenerationIfUnreferenced(generation, _health, options = {}) {
  if (!generation || generation.created !== true) return { paused: false };
  const blocked = await dshGenerationCleanupBlocker(options);
  if (blocked) return { paused: true, reason: blocked };
  const generationsDir = path.join(resolveManagedRoot(options), "generations");
  const candidate = path.resolve(generation.generationDir);
  if (!candidate.startsWith(`${path.resolve(generationsDir)}${path.sep}`)) return { paused: false };
  const marker = await readJson(path.join(candidate, MANIFEST_FILE));
  if (!marker || marker.owner !== MANAGED_OWNER || marker.bundleHash !== generation.bundleHash) return { paused: false };
  // Inspect the exact generation rather than trusting a health record that may
  // describe the previous managed version. A manifest row referencing this
  // candidate counts even when pnpm did not materialize the package yet.
  if (await isGenerationReferenced(candidate, options)) return { paused: false };
  await fsp.rm(candidate, { recursive: true, force: false });
  return { paused: false, removed: true };
}

// A real `dsh plugin remove` deletes the dependency and bundle row but leaves
// the profile-local link behind (a symlink on macOS, a junction on Windows). It
// is Clawd's exact link, so clear it and let the caller re-inspect; anything
// that is not our exact link stays as reportable state.
async function clearRepairResidualLink(health, options = {}) {
  if (!health || health.status !== "managed-residue") return false;
  const cleanup = await unlinkManagedProfileResidue(health, options);
  return cleanup.removed === true;
}

// Classify the record target's marker with lstat, not a following read: only a
// marker node that truly does not exist means the record is stale. Anything
// else (bad JSON, foreign owner, unreadable, symlink/non-file) is an anomaly a
// fresh generation must not silently decide for.
async function inspectRepairTargetMarker(generationDir) {
  // Look at the target directory itself before its marker. A path below a
  // non-directory is ENOENT on Windows and ENOTDIR on POSIX, so a marker-only
  // lookup would read a file-shaped target as "record is stale" on Windows and
  // silently fall back to a fresh generation. Only a directory can hold a
  // marker; a file, symlink or junction is an anomaly.
  let dirStat;
  try {
    dirStat = await fsp.lstat(generationDir);
  } catch (err) {
    return err && err.code === "ENOENT" ? "missing" : "unreadable";
  }
  if (!dirStat.isDirectory()) return "invalid";
  const markerPath = path.join(generationDir, MANIFEST_FILE);
  let stat;
  try {
    stat = await fsp.lstat(markerPath);
  } catch (err) {
    return err && err.code === "ENOENT" ? "missing" : "unreadable";
  }
  if (!stat.isFile() || (typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink())) {
    return "invalid";
  }
  let raw;
  try {
    raw = await fsp.readFile(markerPath, "utf8");
  } catch (err) {
    return err && err.code === "ENOENT" ? "missing" : "unreadable";
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch {
    return "invalid";
  }
  return parsed && parsed.owner === MANAGED_OWNER ? "present" : "invalid";
}

// Fully verify a managed generation before it is used as a repair target. The
// operation record only points at a candidate; an unverified or corrupt one
// must not authorize the destructive remove. Reuses the same marker/ownership/
// hash checks as the generation-integrity classification.
async function verifyRepairTargetGeneration(generationDir, bundleHash, contract, options = {}) {
  if (!generationDir || !bundleHash || !contract) return false;
  const record = await inspectResolvedPackage(path.join(generationDir, "package.json"), "repair-target");
  if (!record || !record.clawdManifest) return false;
  if (record.clawdManifest.owner !== MANAGED_OWNER) return false;
  if (record.clawdManifest.bundleHash !== bundleHash) return false;
  if (!isIntactManaged(record)) return false;
  if (!isManagedGenerationRecord(record, resolveManagedRoot(options), options)) return false;
  const markerContract = dshContractForMarker(record.clawdManifest);
  return !!markerContract && markerContract.supportedDshRange === contract.supportedDshRange;
}

// Explicit two-step repair for a plugin DSH disabled (dependency present, bundle
// entry missing). Upstream add never re-enables an existing dependency, so the
// plugin must be removed first. All steps run under the caller's mutation lock.
async function repairDisabledDshProfile(options, scoped, locked, record, runtime) {
  const profile = scoped.profile;
  const { commandInfo, pnpmRuntime, silent, hostVersion } = runtime;

  // The per-target latch is only checked by the ordinary sync path after this
  // repair is dispatched. Read it here so an invalid/unreadable record stops
  // before the first command, staging, or cleanup. It is already pausing shared
  // cleanup, and we cannot prove a broken node is ours.
  const lockedLatch = await readInspectionLatch(scoped);
  if (lockedLatch && lockedLatch.invalid) return inspectionLatchResult(lockedLatch);

  // Recompute the target contract from the current host version on every resume.
  const family = dshFamilyForVersion(hostVersion);
  if (!family) {
    return {
      status: "error",
      reason: "version-unsupported",
      message: `DeepSeek Harness ${hostVersion || "unknown"} is unsupported; this bridge supports ${supportedDshRangeLabel()}`,
      detectedVersion: hostVersion,
      supportedRange: supportedDshRangeLabel(),
    };
  }
  const contract = dshTargetContract(family, hostVersion);
  const bundle = await readSourceBundle({ ...scoped, contract });
  const generation = await promoteGeneration(bundle, { ...options, contract, dshVersion: hostVersion });
  let targetBundleHash = generation.bundleHash;
  let targetGenerationDir = generation.generationDir;
  if (record) {
    const recordFamily = dshFamilyForVersion(record.hostVersion);
    if (recordFamily && recordFamily.family !== family.family) {
      return {
        status: "error",
        reason: "version-unsupported",
        message: `The pending DeepSeek Harness repair targets ${record.hostVersion || "unknown"}; this host is ${hostVersion || "unknown"}`,
        detectedVersion: hostVersion,
        expectedVersion: record.hostVersion,
        supportedRange: supportedDshRangeLabel(),
      };
    }
    // The record's target is only a candidate. Only a marker node that truly
    // does not exist makes the record stale (then fall through to the
    // generation this run prepared from the current source). A marker that
    // exists but is corrupt, foreign, unreadable or otherwise not our valid
    // record means the recorded target is in an unclear state; a fresh
    // generation must not decide for it, so stop before any command.
    const markerState = await inspectRepairTargetMarker(record.targetGenerationDir);
    if (markerState === "invalid" || markerState === "unreadable") {
      return repairNeedsInspectionResult(scoped, `repair-target-marker-${markerState}`);
    }
    if (markerState === "present") {
      if (!(await verifyRepairTargetGeneration(record.targetGenerationDir, record.targetBundleHash, contract, options))) {
        return repairNeedsInspectionResult(scoped, "repair-target-integrity-failed");
      }
      targetBundleHash = record.targetBundleHash;
      targetGenerationDir = record.targetGenerationDir;
    }
  }
  // Whatever we removed for must itself be intact; otherwise do not touch DSH.
  if (!(await verifyRepairTargetGeneration(targetGenerationDir, targetBundleHash, contract, options))) {
    return repairNeedsInspectionResult(scoped, "repair-target-integrity-failed");
  }
  const carrierKind = commandInfo && commandInfo.kind === "desktop" ? "desktop" : "npm";

  // A previous remove (upstream or a prior attempt) can leave our exact profile
  // link behind. It is ours, not damage: clear it and re-inspect so the repair
  // can continue instead of stopping for a human.
  let work = locked;
  if (await clearRepairResidualLink(work, scoped)) {
    work = await inspectDeepSeekHarnessIntegration({ ...scoped, commandInfo });
  }

  const depsGone = work.status === "absent" || work.status === "profile-missing";
  // The profile-local copy still carries our marker even when the source
  // generation directory is gone; that is ours, not a foreign package.
  const profileOwnedMarker = !!(work.profileResolved && isIntactManaged(work.profileResolved));
  const ourRegistrationPresent = (work.owned && !!work.marker) || profileOwnedMarker;
  const isIncomplete = ourRegistrationPresent && work.status === "profile-entry-incomplete";
  const foreignOrConflicting = work.status === "profile-entry-foreign-or-conflicting" && !profileOwnedMarker;
  const damagedOrUnclear = ourRegistrationPresent && !isIncomplete && work.status !== "healthy"
    && work.status !== "profile-entry-foreign-or-conflicting";
  const healthyTarget = work.status === "healthy" && work.owned && work.marker
    && work.marker.bundleHash === targetBundleHash;

  // "Already healthy and exactly the recorded target" converges without touching DSH.
  if (healthyTarget) {
    const latch = await readInspectionLatch(scoped);
    if (latch && latch.invalid) return inspectionLatchResult(latch);
    try { await clearRepairOperation(scoped); } catch {}
    if (latch) await clearInspectionLatch(scoped);
    await cleanUnreferencedGenerations(targetBundleHash, options);
    return { status: "ok", updated: false, health: work, message: dshSuccessMessage(profile) };
  }

  // Foreign, damaged or otherwise unclear state stops for a human. A record is
  // never authorization to overwrite a package we cannot prove is ours.
  if (foreignOrConflicting || (!depsGone && !ourRegistrationPresent) || damagedOrUnclear) {
    return repairNeedsInspectionResult(scoped, work.status);
  }

  // Resume point. "remove-pending" with dependencies already gone means the
  // remove happened before the record was updated.
  let state = record ? record.state : "remove-pending";
  if (state === "remove-pending" && depsGone) state = "removed-add-pending";
  if (state === "removed-add-pending" && !depsGone) {
    return repairNeedsInspectionResult(scoped, "remove-pending-record-with-dependencies");
  }

  const now = () => new Date().toISOString();
  const baseRecord = {
    owner: MANAGED_OWNER,
    schemaVersion: REPAIR_OPERATION_SCHEMA_VERSION,
    profile,
    targetBundleHash,
    targetGenerationDir,
    hostVersion,
    carrierKind,
    createdAt: record && record.createdAt ? record.createdAt : now(),
  };
  const writeState = (stateValue) => writeRepairOperation(
    { ...baseRecord, state: stateValue, updatedAt: now() },
    scoped
  );

  if (state === "remove-pending") {
    // Persist the intent before the first destructive command; if the record
    // cannot be written, remove is never attempted.
    try {
      await writeState("remove-pending");
    } catch (err) {
      return {
        status: "error",
        reason: "repair-record-unwritable",
        message: err && err.message ? err.message : String(err),
        repairPath: repairOperationPath(scoped),
        manualInspectionRequired: true,
      };
    }
    // Remove, then confirm the dependency is gone and the target generation survived.
    const result = await runDshCommand([
      "plugin", "--profile", profile, "remove", BRIDGE_PACKAGE_NAME,
    ], { ...options, commandInfo: pnpmRuntime.commandInfo });
    let afterRemove = await inspectDeepSeekHarnessIntegration({ ...scoped, commandInfo });
    // Upstream remove leaves our exact profile link behind; clear it before
    // deciding the remove failed.
    if (result.code === 0 && await clearRepairResidualLink(afterRemove, scoped)) {
      afterRemove = await inspectDeepSeekHarnessIntegration({ ...scoped, commandInfo });
    }
    const targetMarker = await readJson(path.join(targetGenerationDir, MANIFEST_FILE));
    const targetIntact = !!(targetMarker && targetMarker.owner === MANAGED_OWNER
      && targetMarker.bundleHash === targetBundleHash);
    if (result.code !== 0 || (afterRemove.status !== "absent" && afterRemove.status !== "profile-missing") || !targetIntact) {
      await writeInspectionLatch(
        "repair-remove-failed",
        (result.stderr || result.stdout || `remove left state ${afterRemove.status}`).trim(),
        scoped
      );
      return {
        status: "error",
        reason: "repair-remove-failed",
        message: "dsh plugin remove did not cleanly remove the disabled plugin; repair can be retried",
        healthReason: afterRemove.status,
      };
    }
    // Re-verify the host version between the two writes.
    const versionAfterRemove = await readDshVersion(commandInfo, options);
    if (versionAfterRemove !== hostVersion) {
      return {
        status: "error",
        reason: "version-changed",
        message: `DeepSeek Harness changed from ${hostVersion} to ${versionAfterRemove} between remove and add; retry after the host version is stable`,
        detectedVersion: versionAfterRemove,
        expectedVersion: hostVersion,
        supportedRange: supportedDshRangeLabel(),
      };
    }
    await writeState("removed-add-pending");
  } else {
    // Resuming after remove: re-verify the version, then pin the record state.
    const versionNow = await readDshVersion(commandInfo, options);
    if (versionNow !== hostVersion) {
      return {
        status: "error",
        reason: "version-changed",
        message: `DeepSeek Harness changed from ${hostVersion} to ${versionNow}; retry after the host version is stable`,
        detectedVersion: versionNow,
        expectedVersion: hostVersion,
        supportedRange: supportedDshRangeLabel(),
      };
    }
    await writeState("removed-add-pending");
  }

  // Re-verify the final target right before the write: an interrupt between
  // remove and add can leave a damaged generation behind.
  if (!(await verifyRepairTargetGeneration(targetGenerationDir, targetBundleHash, contract, options))) {
    await writeInspectionLatch("repair-target-integrity-failed", "repair target failed verification before add", scoped);
    return {
      status: "error",
      reason: "repair-target-integrity-failed",
      message: "The DeepSeek Harness repair target failed verification before add; manual inspection is required",
      manualInspectionRequired: true,
    };
  }
  // Add the recorded target generation and verify it landed healthy.
  const addResult = await runDshCommand([
    "plugin", "--profile", profile, "add", targetGenerationDir,
  ], { ...options, commandInfo: pnpmRuntime.commandInfo });
  if (addResult.code !== 0) {
    await writeInspectionLatch(
      "repair-add-failed",
      (addResult.stderr || addResult.stdout || "dsh plugin add failed during repair").trim(),
      scoped
    );
    return {
      status: "error",
      reason: "repair-add-failed",
      message: "dsh plugin add failed during repair; the operation record is kept for a retry",
    };
  }
  const after = await inspectDeepSeekHarnessIntegration({
    ...scoped,
    commandInfo,
    expectedHashes: { [contract.supportedDshRange]: targetBundleHash },
  });
  if (after.status !== "healthy" || !after.marker || after.marker.bundleHash !== targetBundleHash) {
    await writeInspectionLatch("repair-add-verification-failed", after.status, scoped);
    return {
      status: "error",
      reason: "repair-add-verification-failed",
      healthReason: after.status,
      message: "dsh plugin add completed but the repaired bridge did not verify healthy",
      manualInspectionRequired: true,
    };
  }

  // Converge: clear the record and this side's latch first, then the old
  // generation can be collected.
  // A lock-time invalid record must stop before clearing anything (the record
  // or the manual reference), and before the shared cleanup it pauses.
  const latch = await readInspectionLatch(scoped);
  if (latch && latch.invalid) return inspectionLatchResult(latch);
  try { await clearRepairOperation(scoped); } catch {}
  if (profile === WEB_PROFILE_NAME) await clearManualGenerationReference(options);
  if (latch) await clearInspectionLatch(scoped);
  await cleanUnreferencedGenerations(targetBundleHash, options);
  if (!silent) console.log(`Clawd: DeepSeek Harness ${profile} repair ready (${targetBundleHash.slice(0, 12)})`);
  const success = {
    status: "ok",
    updated: true,
    generation: targetGenerationDir,
    health: after,
    message: dshSuccessMessage(profile),
  };
  if (profile === DESKTOP_PROFILE_NAME) {
    success.firstInstall = false;
    // A repair replaces the profile link target, which the desktop app only
    // observes on restart.
    success.restartRequired = true;
  }
  return success;
}

async function syncDshProfile(options, target) {
  const profile = target.profile;
  const scoped = { ...options, profile };
  const operation = options.operation || "install";
  const silent = options.silent === true;
  const commandInfo = target.carrier && target.carrier.status === "available"
    ? target.carrier.commandInfo
    : null;
  try {
    const removalResidueHealth = managedProfileRemovalResidueHealth(
      await listManagedProfileRemovalResidues(scoped),
      scoped
    );
    if (removalResidueHealth) return managedProfileRemovalResidueResult(removalResidueHealth);
    const latch = await readInspectionLatch(scoped);
    if (latch && operation === "startup-sync") return inspectionLatchResult(latch);
    const profileDir = resolveDshProfileDir(options.dshHome || resolveDshHome(options.env), profile);
    if (operation === "startup-sync" && !(await exists(path.join(profileDir, "package.json")))) {
      return {
        status: "error",
        reason: "repair-required",
        message: `DeepSeek Harness ${profile} profile is missing; use Settings Repair to initialize it`,
      };
    }
    const before = await inspectDeepSeekHarnessIntegration({ ...scoped, commandInfo });
    const currentVersion = await sourceClawdVersion(options);
    // manual reference is web-owned; desktop reads nothing here so an install
    // on desktop can never consume or clear web's anchor.
    const manualReference = profile === WEB_PROFILE_NAME
      ? await readManualGenerationReference(options)
      : null;
    if (manualReference && manualReference.invalid) {
      return manualGenerationReferenceResult(manualReference, scoped);
    }
    // A pending repair record bypasses the ordinary ownership/version fast
    // paths so the repair resume logic runs under the lock.
    const pendingRecord = operation !== "startup-sync" ? await readRepairOperation(scoped) : null;
    if (pendingRecord && pendingRecord.invalid) return repairRecordResult(pendingRecord, scoped);
    if (!pendingRecord && !hasMutableManagedState(before)) {
      return {
        status: "error",
        reason: before.status || "ownership-not-proven",
        message: before.status === "generation-integrity-failed"
          ? "The managed DSH bridge bytes no longer match their ownership marker; manual inspection is required"
          : (before.status === "profile-corrupt"
            ? `The DeepSeek Harness ${profile} profile manifest is unreadable; Clawd will not rewrite it automatically`
            : "A foreign or conflicting DSH plugin uses the Clawd package name"),
        manualInspectionRequired: true,
      };
    }
    // Startup sync never re-enables a plugin the user disabled in DSH: that is
    // a report-only state regardless of Clawd's version or the target hash.
    if (operation === "startup-sync" && before.status === "profile-entry-incomplete") {
      return pluginDisabledInDshResult(before);
    }
    if (!commandInfo) {
      if (profile === DESKTOP_PROFILE_NAME) {
        // desktop is never driven by npx; the orchestrator only sends an
        // available carrier here, so this is a defensive fail-closed.
        return { status: "error", reason: "carrier-unavailable", message: "DeepSeek Harness desktop command is unavailable" };
      }
      const markerContract = before.marker ? dshContractForMarker(before.marker) : null;
      if (before.marker && !markerContract) {
        return {
          status: "error",
          reason: "version-unsupported",
          message: `The installed DeepSeek Harness marker targets ${before.marker.installedDshVersion || "an unknown version"}; refusing to stage a manual install for an unlisted contract`,
          detectedVersion: before.marker.installedDshVersion || null,
          supportedRange: supportedDshRangeLabel(),
          manualInspectionRequired: true,
        };
      }
      const targetFamily = before.marker
        ? dshFamilyForVersion(before.marker.installedDshVersion)
        : PREFERRED_DSH_FAMILY;
      const noCliContract = dshTargetContract(
        targetFamily,
        before.marker ? before.marker.installedDshVersion : null
      );
      if (!noCliContract) {
        return {
          status: "error",
          reason: "version-unsupported",
          message: `DeepSeek Harness ${before.marker ? before.marker.installedDshVersion : "unknown"} is unsupported; this bridge supports ${supportedDshRangeLabel()}`,
          detectedVersion: before.marker ? before.marker.installedDshVersion : null,
          supportedRange: supportedDshRangeLabel(),
          manualInspectionRequired: true,
        };
      }
      const assumedVersion = before.marker ? before.marker.installedDshVersion : noCliContract.artifactVersion;
      const bundle = await readSourceBundle({ ...scoped, contract: noCliContract });
      if (before.status === "healthy" && before.marker.bundleHash === bundle.bundleHash) {
        if (latch) return inspectionLatchResult(latch);
        if (manualReference) {
          const lock = await acquireMutationLock(options);
          try {
            const locked = await inspectDeepSeekHarnessIntegration({
              ...scoped,
              commandInfo: null,
              resolveCommandForInspection: false,
            });
            if (locked.status !== "healthy" || locked.marker.bundleHash !== bundle.bundleHash) {
              return {
                status: "error",
                reason: "ownership-changed",
                message: "DSH plugin state changed while finalizing a manual generation reference",
                manualInspectionRequired: true,
              };
            }
            await clearManualGenerationReference(options);
            await cleanUnreferencedGenerations(locked.marker.bundleHash, options);
            return { status: "ok", updated: false, health: locked, message: dshSuccessMessage(profile) };
          } finally {
            await lock.release();
          }
        }
        return { status: "ok", updated: false, health: before, message: dshSuccessMessage(profile) };
      }
      if (operation !== "startup-sync") {
        const lock = await acquireMutationLock(options);
        try {
          const locked = await inspectDeepSeekHarnessIntegration({
            ...scoped,
            commandInfo: null,
            resolveCommandForInspection: false,
          });
          if (!hasMutableManagedState(locked)) {
            return {
              status: "error",
              reason: locked.status || "ownership-changed",
              message: "DSH plugin ownership changed before staging the manual install generation",
              manualInspectionRequired: true,
            };
          }
          if (dshMarkerIdentity(before.marker) !== dshMarkerIdentity(locked.marker)) {
            return {
              status: "error",
              reason: "ownership-changed",
              message: "DSH marker contract changed before staging the manual install generation",
              manualInspectionRequired: true,
            };
          }
          const generation = await promoteGeneration(bundle, {
            ...options,
            contract: noCliContract,
            dshVersion: assumedVersion,
            dshVersionAssumed: true,
          });
          await writeManualGenerationReference(generation, options);
          await cleanUnreferencedGenerations(generation.bundleHash, options);
          // A disabled plugin needs remove-then-add; give both commands, pinned
          // to the same artifact and DSH_HOME.
          const commands = [];
          if (before.status === "profile-entry-incomplete") {
            commands.push(buildManualDshCommand([
              "npx",
              noCliContract.verifiedDshArtifact,
              "plugin",
              "--profile",
              profile,
              "remove",
              BRIDGE_PACKAGE_NAME,
            ], options));
          }
          commands.push(buildManualDshCommand([
            "npx",
            noCliContract.verifiedDshArtifact,
            "plugin",
            "--profile",
            profile,
            "add",
            generation.generationDir,
          ], options));
          return {
            status: "error",
            reason: "cli-unavailable",
            message: before.status === "profile-entry-incomplete"
              ? "DeepSeek Harness was detected, but a global dsh CLI is not available; remove then add the plugin manually"
              : "DeepSeek Harness was detected, but a global dsh CLI is not available",
            manualCommand: commands.join("\n"),
            manualBundleHash: generation.bundleHash,
            manualGenerationReferenced: true,
          };
        } finally {
          await lock.release();
        }
      }
      return { status: "error", reason: "cli-unavailable", message: "DeepSeek Harness CLI is not available" };
    }
    const dshVersion = target.carrier.version;
    const family = dshFamilyForVersion(dshVersion);
    if (!family) {
      return {
        status: "error",
        reason: "version-unsupported",
        message: `DeepSeek Harness ${dshVersion || "unknown"} is unsupported; this bridge supports ${supportedDshRangeLabel()}`,
        detectedVersion: dshVersion,
        supportedRange: supportedDshRangeLabel(),
      };
    }
    const contract = dshTargetContract(family, dshVersion);
    const bundle = await readSourceBundle({ ...scoped, contract });
    if (
      !pendingRecord
      && !latch
      && !manualReference
      && before.status === "healthy"
      && before.marker.bundleHash === bundle.bundleHash
    ) {
      return { status: "ok", updated: false, health: before, message: dshSuccessMessage(profile) };
    }
    if (!pendingRecord && before.owned && before.marker && before.marker.bundleHash !== bundle.bundleHash) {
      const order = compareVersions(before.marker.sourceClawdVersion, currentVersion);
      if (order === 1) {
        return { status: "skipped", reason: "newer-managed-generation", message: "A newer Clawd bridge generation is already installed" };
      }
      if ((order === 0 || order === null) && operation === "startup-sync") {
        return { status: "error", reason: "generation-conflict", message: "Managed DSH bridge version/hash conflict requires explicit inspection" };
      }
    }

    const lock = await acquireMutationLock(options);
    try {
      const locked = await inspectDeepSeekHarnessIntegration({ ...scoped, commandInfo });
      const lockedVersion = await readDshVersion(commandInfo, options);
      if (!isSupportedDshVersion(lockedVersion)) {
        return {
          status: "error",
          reason: "version-unsupported",
          message: `DeepSeek Harness ${lockedVersion || "unknown"} is unsupported; this bridge supports ${supportedDshRangeLabel()}`,
          detectedVersion: lockedVersion,
          supportedRange: supportedDshRangeLabel(),
        };
      }
      if (lockedVersion !== dshVersion) {
        return {
          status: "error",
          reason: "version-changed",
          message: `DeepSeek Harness changed from ${dshVersion} to ${lockedVersion} before mutation; retry after the host version is stable`,
          detectedVersion: lockedVersion,
          expectedVersion: dshVersion,
          supportedRange: supportedDshRangeLabel(),
        };
      }
      // Explicit operations resume or start the two-step repair; startup sync
      // never does (the role already reports repair-pending).
      if (operation !== "startup-sync") {
        const operationRecord = await readRepairOperation(scoped);
        if (operationRecord && operationRecord.invalid) {
          return repairRecordResult(operationRecord, scoped);
        }
        const ourIncomplete = locked.owned && locked.status === "profile-entry-incomplete";
        if (operationRecord || ourIncomplete) {
          const repairPnpm = await resolvePnpmRuntime(commandInfo, options);
          if (!repairPnpm.available) {
            return { status: "error", reason: "pnpm-unavailable", message: "pnpm is required by dsh plugin repair" };
          }
          return await repairDisabledDshProfile(options, scoped, locked, operationRecord, {
            commandInfo,
            pnpmRuntime: repairPnpm,
            silent,
            hostVersion: lockedVersion,
          });
        }
      }
      if (!hasMutableManagedState(locked)) {
        return {
          status: "error",
          reason: locked.status || "ownership-changed",
          message: "DSH plugin ownership or managed bytes changed before mutation",
          manualInspectionRequired: true,
        };
      }
      if (operation === "startup-sync" && locked.status === "profile-entry-incomplete") {
        return pluginDisabledInDshResult(locked);
      }
      const lockedLatch = await readInspectionLatch(scoped);
      // A lock-time re-read can see a record the pre-lock scan did not. If it
      // is invalid or unreadable, stop before any write or cleanup: the record
      // is what pauses shared cleanup, and we cannot prove it is ours.
      if (lockedLatch && lockedLatch.invalid) return inspectionLatchResult(lockedLatch);
      if (locked.status === "healthy" && locked.marker.bundleHash === bundle.bundleHash) {
        // Clear this side's latch before cleanup so it does not pause it.
        if (lockedLatch) await clearInspectionLatch(scoped);
        if (manualReference) {
          await clearManualGenerationReference(options);
          await cleanUnreferencedGenerations(locked.marker.bundleHash, options);
        }
        return { status: "ok", updated: false, health: locked, message: dshSuccessMessage(profile) };
      }
      const pnpmRuntime = await resolvePnpmRuntime(commandInfo, options);
      if (!pnpmRuntime.available) {
        return { status: "error", reason: "pnpm-unavailable", message: "pnpm is required by dsh plugin add" };
      }
      if (locked.owned && locked.marker) {
        const lockedOrder = compareVersions(locked.marker.sourceClawdVersion, currentVersion);
        if (lockedOrder === 1) {
          return { status: "skipped", reason: "newer-managed-generation", message: "A newer Clawd bridge generation is already installed" };
        }
        if ((lockedOrder === 0 || lockedOrder === null) && operation === "startup-sync") {
          return { status: "error", reason: "generation-conflict", message: "Managed DSH bridge version/hash conflict requires explicit inspection" };
        }
      }
      const generation = await promoteGeneration(bundle, { ...options, contract, dshVersion });
      // Snapshot the two files a failed add can partially rewrite. The health
      // fingerprint does not include pnpm-lock.yaml, so a lock-only rewrite
      // would otherwise look like a clean failure. This only catches a write
      // that already happened when add returned; a later write is found by the
      // next startup sync / Doctor (e.g. as plugin-disabled-in-dsh).
      const lockfilePath = path.join(profileDir, "pnpm-lock.yaml");
      const manifestPath = path.join(profileDir, "package.json");
      const beforeAdd = {
        manifest: await readFileStateHash(manifestPath),
        lockfile: await readFileStateHash(lockfilePath),
      };
      const result = await runDshCommand([
        "plugin", "--profile", profile, "add", generation.generationDir,
      ], { ...options, commandInfo: pnpmRuntime.commandInfo });
      if (result.code !== 0) {
        const failedHealth = await inspectDeepSeekHarnessIntegration({ ...scoped, commandInfo });
        const unknown = isUnknownCommandResult(result);
        const changed = healthFingerprint(failedHealth) !== healthFingerprint(locked);
        const afterAdd = {
          manifest: await readFileStateHash(manifestPath),
          lockfile: await readFileStateHash(lockfilePath),
        };
        // A changed or unreadable manifest/lock is proof of a partial mutation
        // even when the health fingerprint still matches.
        const fileMutated = beforeAdd.manifest !== afterAdd.manifest
          || beforeAdd.lockfile !== afterAdd.lockfile
          || afterAdd.manifest === "unreadable"
          || afterAdd.lockfile === "unreadable";
        if (unknown || changed || fileMutated) {
          await writeInspectionLatch(
            unknown ? "plugin-add-unknown" : "plugin-add-partial-mutation",
            (result.stderr || result.stdout || "dsh plugin add failed").trim(),
            scoped
          );
          return {
            status: "error",
            reason: "inspection-required",
            message: (result.stderr || result.stdout || "dsh plugin add had an unknown or partial result").trim(),
            manualCommand: buildManualDshCommand([
              "dsh", "plugin", "--profile", profile, "add", generation.generationDir,
            ], options),
            manualBundleHash: generation.bundleHash,
            manualInspectionRequired: true,
          };
        }
        const discarded = await discardCreatedGenerationIfUnreferenced(generation, failedHealth, options);
        return {
          status: "error",
          reason: "plugin-add-failed",
          message: (result.stderr || result.stdout || "dsh plugin add failed").trim(),
          // The command only helps if the staged generation still exists; a
          // discarded generation would point the user at a deleted directory.
          ...(discarded && discarded.removed ? {} : {
            manualCommand: buildManualDshCommand([
              "dsh", "plugin", "--profile", profile, "add", generation.generationDir,
            ], options),
            manualBundleHash: generation.bundleHash,
          }),
        };
      }
      const after = await inspectDeepSeekHarnessIntegration({
        ...scoped,
        commandInfo,
        expectedHashes: { [contract.supportedDshRange]: generation.bundleHash },
      });
      if (after.status !== "healthy") {
        await writeInspectionLatch("plugin-add-verification-failed", after.status, scoped);
        return {
          status: "error",
          reason: "inspection-required",
          healthReason: after.status,
          message: "dsh plugin add completed but the managed bridge did not verify healthy",
          manualInspectionRequired: true,
        };
      }
      if (profile === WEB_PROFILE_NAME) await clearManualGenerationReference(options);
      // Clear this side's latch before cleanup so it does not pause it.
      if (lockedLatch) await clearInspectionLatch(scoped);
      await cleanUnreferencedGenerations(generation.bundleHash, options);
      if (!silent) console.log(`Clawd: DeepSeek Harness ${profile} bridge ready (${generation.bundleHash.slice(0, 12)})`);
      const success = {
        status: "ok",
        updated: true,
        generation: generation.generationDir,
        health: after,
        message: dshSuccessMessage(profile),
      };
      // Step 5 turns these into the desktop notice; a same-generation check
      // (updated:false) above returns before them.
      if (profile === DESKTOP_PROFILE_NAME) {
        success.firstInstall = !before.owned;
        success.restartRequired = before.owned === true;
      }
      return success;
    } finally {
      await lock.release();
    }
  } catch (err) {
    if (err && err.code === "DSH_MANUAL_GENERATION_REFERENCE_INVALID") {
      return manualGenerationReferenceResult({ referencePath: err.referencePath }, scoped);
    }
    throw err;
  }
}

async function uninstallDshProfile(options, target) {
  const profile = target.profile;
  const scoped = { ...options, profile };
  const commandInfo = target.carrier && target.carrier.status === "available"
    ? target.carrier.commandInfo
    : null;
  try {
    const removalResidueHealth = managedProfileRemovalResidueHealth(
      await listManagedProfileRemovalResidues(scoped),
      scoped
    );
    if (removalResidueHealth) return managedProfileRemovalResidueResult(removalResidueHealth);
    const latch = await readInspectionLatch(scoped);
    // An invalid/unreadable record stops the uninstall before any command: it
    // is pausing shared cleanup and cannot be proven ours.
    if (latch && latch.invalid) return inspectionLatchResult(latch);
    // manual reference is web-owned; desktop must never clear or rewrite it.
    const manualReference = profile === WEB_PROFILE_NAME
      ? await readManualGenerationReference(options)
      : null;
    if (manualReference && manualReference.invalid) {
      return manualGenerationReferenceResult(manualReference, scoped);
    }
    const before = await inspectDeepSeekHarnessIntegration({ ...scoped, commandInfo });
    if (before.status === "absent" || before.status === "profile-missing") {
      if (!latch) {
        const lock = await acquireMutationLock(options);
        try {
          const locked = await inspectDeepSeekHarnessIntegration({ ...scoped, commandInfo });
          if (locked.status !== "absent" && locked.status !== "profile-missing") {
            return {
              status: "error",
              reason: "ownership-changed",
              message: "DSH plugin state changed while cleaning unreferenced managed generations",
              manualInspectionRequired: true,
            };
          }
          if (profile === WEB_PROFILE_NAME) await clearManualGenerationReference(options);
          try { await clearRepairOperation(scoped); } catch {}
          const cleanup = await cleanUnreferencedGenerations(null, options);
          const warning = dshCleanupPausedWarning(cleanup);
          return { status: "skipped", reason: "bridge-not-installed", ...(warning ? { warnings: [warning] } : {}) };
        } finally {
          await lock.release();
        }
      }
      if (!commandInfo) return inspectionLatchResult(latch);
      const dshVersion = target.carrier.version;
      if (!isSupportedDshVersion(dshVersion)) {
        return {
          status: "error",
          reason: "version-unsupported",
          message: `DeepSeek Harness ${dshVersion || "unknown"} is unsupported; refusing to clear removal state (supported: ${supportedDshRangeLabel()})`,
          detectedVersion: dshVersion,
          supportedRange: supportedDshRangeLabel(),
          manualInspectionRequired: true,
        };
      }
      const lock = await acquireMutationLock(options);
      try {
        const locked = await inspectDeepSeekHarnessIntegration({ ...scoped, commandInfo });
        const lockedVersion = await readDshVersion(commandInfo, options);
        if (!isSupportedDshVersion(lockedVersion)) {
          return {
            status: "error",
            reason: "version-unsupported",
            message: `DeepSeek Harness ${lockedVersion || "unknown"} is unsupported; refusing to clear removal state (supported: ${supportedDshRangeLabel()})`,
            detectedVersion: lockedVersion,
            supportedRange: supportedDshRangeLabel(),
            manualInspectionRequired: true,
          };
        }
        if (locked.status !== "absent" && locked.status !== "profile-missing") {
          return {
            status: "error",
            reason: "ownership-changed",
            message: "DSH plugin state changed while verifying a previous removal",
            manualInspectionRequired: true,
          };
        }
        const lockedLatch = await readInspectionLatch(scoped);
        if (lockedLatch && lockedLatch.invalid) return inspectionLatchResult(lockedLatch);
        if (profile === WEB_PROFILE_NAME) await clearManualGenerationReference(options);
        if (lockedLatch) await clearInspectionLatch(scoped);
        try { await clearRepairOperation(scoped); } catch {}
        const cleanup = await cleanUnreferencedGenerations(null, options);
        const warning = dshCleanupPausedWarning(cleanup);
        return { status: "skipped", reason: "bridge-not-installed", ...(warning ? { warnings: [warning] } : {}) };
      } finally {
        await lock.release();
      }
    }
    if (!hasMutableManagedState(before) || !before.owned || !before.marker) {
      return {
        status: "error",
        reason: "ownership-not-proven",
        message: "Refusing to remove a DSH plugin whose Clawd ownership is not fully verified",
      };
    }
    if (!commandInfo) {
      if (profile === DESKTOP_PROFILE_NAME) {
        // desktop is never removed with npx; the orchestrator only sends an
        // available carrier here, so this is a defensive fail-closed.
        return { status: "error", reason: "carrier-unavailable", message: "DeepSeek Harness desktop command is unavailable" };
      }
      const removalContract = dshContractForMarker(before.marker);
      if (!removalContract) {
        return {
          status: "error",
          reason: "version-unsupported",
          message: `The installed DeepSeek Harness marker targets ${before.marker.installedDshVersion || "an unknown version"}; refusing to build a manual uninstall command for an unlisted contract`,
          detectedVersion: before.marker.installedDshVersion || null,
          supportedRange: supportedDshRangeLabel(),
          manualInspectionRequired: true,
        };
      }
      const removalTarget = dshTargetContract(
        dshFamilyForVersion(before.marker.installedDshVersion),
        before.marker.installedDshVersion
      );
      if (!removalTarget) {
        return {
          status: "error",
          reason: "version-unsupported",
          message: `DeepSeek Harness ${before.marker.installedDshVersion || "unknown"} is unsupported; refusing to build a manual uninstall command for an unlisted contract`,
          detectedVersion: before.marker.installedDshVersion || null,
          supportedRange: supportedDshRangeLabel(),
          manualInspectionRequired: true,
        };
      }
      if (before.status === "managed-residue") {
        const lock = await acquireMutationLock(options);
        try {
          const locked = await inspectDeepSeekHarnessIntegration({ ...scoped, commandInfo });
          if (
            locked.status !== "managed-residue"
            || !hasMutableManagedState(locked)
            || !locked.owned
            || !locked.marker
            || locked.marker.bundleHash !== before.marker.bundleHash
          ) {
            return {
              status: "error",
              reason: "ownership-changed",
              message: "DSH plugin ownership changed before managed residue cleanup",
            };
          }
          const lockedContract = dshContractForMarker(locked.marker);
          if (!lockedContract) {
            return {
              status: "error",
              reason: "version-unsupported",
              message: `The installed DeepSeek Harness marker targets ${locked.marker.installedDshVersion || "an unknown version"}; refusing to clean a managed residue for an unlisted contract`,
              detectedVersion: locked.marker.installedDshVersion || null,
              supportedRange: supportedDshRangeLabel(),
              manualInspectionRequired: true,
            };
          }
          if (dshMarkerIdentity(locked.marker) !== dshMarkerIdentity(before.marker)) {
            return {
              status: "error",
              reason: "ownership-changed",
              message: "DSH plugin contract changed before managed residue cleanup",
            };
          }
          const lockedLatch = await readInspectionLatch(scoped);
          return await cleanLockedManagedProfileResidue(locked, commandInfo, lockedLatch, scoped);
        } finally {
          await lock.release();
        }
      }
      return {
        status: "error",
        reason: "cli-unavailable",
        message: "DeepSeek Harness CLI is unavailable; the managed plugin was left installed",
        manualCommand: buildManualDshCommand([
          "npx",
          removalTarget.verifiedDshArtifact,
          "plugin",
          "--profile",
          profile,
          "remove",
          BRIDGE_PACKAGE_NAME,
        ], options),
        manualBundleHash: before.marker.bundleHash,
      };
    }
    const dshVersion = target.carrier.version;
    if (!isSupportedDshVersion(dshVersion)) {
      return {
        status: "error",
        reason: "version-unsupported",
        message: `DeepSeek Harness ${dshVersion || "unknown"} is unsupported; refusing to mutate it with a removal contract for an unlisted version (supported: ${supportedDshRangeLabel()})`,
        detectedVersion: dshVersion,
        supportedRange: supportedDshRangeLabel(),
        manualInspectionRequired: true,
      };
    }
    const lock = await acquireMutationLock(options);
    try {
      const locked = await inspectDeepSeekHarnessIntegration({ ...scoped, commandInfo });
      const lockedVersion = await readDshVersion(commandInfo, options);
      if (!isSupportedDshVersion(lockedVersion)) {
        return {
          status: "error",
          reason: "version-unsupported",
          message: `DeepSeek Harness ${lockedVersion || "unknown"} is unsupported; refusing to mutate it with a removal contract for an unlisted version (supported: ${supportedDshRangeLabel()})`,
          detectedVersion: lockedVersion,
          supportedRange: supportedDshRangeLabel(),
          manualInspectionRequired: true,
        };
      }
      // An uninstall must also confirm the host version did not move while the
      // lock was acquired; the removal contract depends on the exact version.
      if (lockedVersion !== dshVersion) {
        return {
          status: "error",
          reason: "version-changed",
          message: `DeepSeek Harness changed from ${dshVersion} to ${lockedVersion} before removal; retry after the host version is stable`,
          detectedVersion: lockedVersion,
          expectedVersion: dshVersion,
          supportedRange: supportedDshRangeLabel(),
        };
      }
      if (
        !hasMutableManagedState(locked)
        || !locked.owned
        || !locked.marker
        || locked.marker.bundleHash !== before.marker.bundleHash
      ) {
        return { status: "error", reason: "ownership-changed", message: "DSH plugin ownership changed before removal" };
      }
      const lockedLatch = await readInspectionLatch(scoped);
      if (lockedLatch && lockedLatch.invalid) return inspectionLatchResult(lockedLatch);
      if (locked.status === "managed-residue") {
        return await cleanLockedManagedProfileResidue(locked, commandInfo, lockedLatch, scoped);
      }
      const pnpmRuntime = await resolvePnpmRuntime(commandInfo, options);
      if (!pnpmRuntime.available) {
        return { status: "error", reason: "pnpm-unavailable", message: "pnpm is required by dsh plugin remove" };
      }
      const result = await runDshCommand([
        "plugin", "--profile", profile, "remove", BRIDGE_PACKAGE_NAME,
      ], { ...options, commandInfo: pnpmRuntime.commandInfo });
      if (result.code !== 0) {
        const failedHealth = await inspectDeepSeekHarnessIntegration({ ...scoped, commandInfo });
        const unknown = isUnknownCommandResult(result);
        const changed = healthFingerprint(failedHealth) !== healthFingerprint(locked);
        if (unknown || changed) {
          await writeInspectionLatch(
            unknown ? "plugin-remove-unknown" : "plugin-remove-partial-mutation",
            (result.stderr || result.stdout || "dsh plugin remove failed").trim(),
            scoped
          );
          return {
            status: "error",
            reason: "inspection-required",
            message: (result.stderr || result.stdout || "dsh plugin remove had an unknown or partial result").trim(),
            manualInspectionRequired: true,
          };
        }
        return {
          status: "error",
          reason: "plugin-remove-failed",
          message: (result.stderr || result.stdout || "dsh plugin remove failed").trim(),
        };
      }
      let after = await inspectDeepSeekHarnessIntegration({ ...scoped, commandInfo });
      if (after.status === "managed-residue") {
        const cleanup = await unlinkManagedProfileResidue(after, scoped);
        if (!cleanup.removed) {
          await writeInspectionLatch("plugin-remove-residue-cleanup-failed", cleanup.reason, scoped);
          return {
            status: "error",
            reason: "inspection-required",
            healthReason: after.status,
            cleanupReason: cleanup.reason,
            message: "dsh plugin remove left a profile-local package residue that could not be safely unlinked",
            manualInspectionRequired: true,
          };
        }
        after = await inspectDeepSeekHarnessIntegration({ ...scoped, commandInfo });
      }
      if (after.status !== "absent" && after.status !== "profile-missing") {
        await writeInspectionLatch("plugin-remove-verification-failed", after.status, scoped);
        return {
          status: "error",
          reason: "inspection-required",
          healthReason: after.status,
          message: "dsh plugin remove completed but profile entries or a resolved package remain",
          manualInspectionRequired: true,
        };
      }
      if (profile === WEB_PROFILE_NAME) await clearManualGenerationReference(options);
      // Clear this side's resolved latch and record before the shared cleanup.
      if (lockedLatch) await clearInspectionLatch(scoped);
      try { await clearRepairOperation(scoped); } catch {}
      const cleanup = await cleanUnreferencedGenerations(null, options);
      const warning = dshCleanupPausedWarning(cleanup);
      return { status: "ok", removed: true, updated: true, ...(warning ? { warnings: [warning] } : {}) };
    } finally {
      await lock.release();
    }
  } catch (err) {
    if (err && err.code === "DSH_MANUAL_GENERATION_REFERENCE_INVALID") {
      return manualGenerationReferenceResult({ referencePath: err.referencePath }, scoped);
    }
    throw err;
  }
}

function dshDiagnoseMessage(target) {
  const profile = target && target.profile ? target.profile : "dsh";
  return `DeepSeek Harness ${profile} target requires manual attention (${(target && target.reason) || "unknown"})`;
}

function dshOutcome(result) {
  if (!result) return "not-applicable";
  if (result.status === "ok") return "success";
  if (result.status === "skipped") return "not-applicable";
  return "failed";
}

function dshFailureWarning(entry) {
  const message = entry.result
    ? (entry.result.message || entry.result.reason || "failed")
    : dshDiagnoseMessage(entry.target);
  return `${entry.profile}: ${message}`;
}

// The settings whitelist keeps these top-level fields; copy the first failing
// target's fields verbatim (or synthesize them for a diagnose target).
function dshErrorFields(result, entry) {
  if (!result) {
    return { reason: entry.reason || "diagnose", message: dshDiagnoseMessage(entry.target) };
  }
  const out = {};
  for (const key of [
    "reason",
    "message",
    "manualCommand",
    "detectedVersion",
    "expectedVersion",
    "supportedRange",
    "healthReason",
    "cleanupReason",
    "residuePath",
    "residuePaths",
    "referencePath",
    "lockPath",
    "targetReason",
    "manualInspectionRequired",
    "manualGenerationReferenced",
  ]) {
    if (result[key] !== undefined) out[key] = result[key];
  }
  return out;
}

function dshTargetsMap(entries) {
  const map = {};
  for (const entry of entries) {
    map[entry.profile] = {
      role: entry.role,
      reason: entry.reason === undefined ? null : entry.reason,
      result: entry.result || null,
      ...(entry.registrationAfter ? { registrationAfter: entry.registrationAfter } : {}),
    };
  }
  return map;
}

function dshOwnershipFailureResult(target, profile, kind) {
  if (kind === "uninstall") {
    return {
      status: "error",
      reason: "ownership-not-proven",
      message: "Refusing to remove a DSH plugin whose Clawd ownership is not fully verified",
    };
  }
  const status = target.health && target.health.status;
  const message = status === "generation-integrity-failed"
    ? "The managed DSH bridge bytes no longer match their ownership marker; manual inspection is required"
    : (status === "profile-corrupt"
      ? `The DeepSeek Harness ${profile} profile manifest is unreadable; Clawd will not rewrite it automatically`
      : "A foreign or conflicting DSH plugin uses the Clawd package name");
  return { status: "error", reason: status || "ownership-not-proven", message, manualInspectionRequired: true };
}

function dshUnsupportedVersionResult(target, profile, kind) {
  const detected = (target.carrier && target.carrier.version)
    || (target.health && target.health.detectedDshVersion)
    || (target.discovery && target.discovery.staticVersion)
    || null;
  if (kind === "uninstall") {
    return {
      status: "error",
      reason: "version-unsupported",
      message: `DeepSeek Harness ${detected || "unknown"} is unsupported; refusing to mutate it with a removal contract for an unlisted version (supported: ${supportedDshRangeLabel()})`,
      detectedVersion: detected,
      supportedRange: supportedDshRangeLabel(),
      manualInspectionRequired: true,
    };
  }
  return {
    status: "error",
    reason: "version-unsupported",
    message: `DeepSeek Harness ${detected || "unknown"} is unsupported; this bridge supports ${supportedDshRangeLabel()}`,
    detectedVersion: detected,
    supportedRange: supportedDshRangeLabel(),
  };
}

// A diagnose target is reported without running its profile flow. For states
// the old single-profile flow also diagnosed, reuse its result functions so
// web's reason/message/fields do not change; the role table's reason code is
// kept separately in targetReason for logs and later steps.
async function dshDiagnoseResult(target, options, kind) {
  const profile = target.profile;
  const scoped = { ...options, profile };
  const reason = target.reason;
  let result;
  if (reason === "residue-unreadable" || reason === "removal-residue") {
    result = managedProfileRemovalResidueResult(target.health);
  } else if (reason === "latch-unreadable" || reason === "latch-invalid" || reason === "inspection-required") {
    result = inspectionLatchResult(target.health && target.health.inspectionLatch || null);
  } else if (reason === "manual-reference-unreadable" || reason === "manual-reference-invalid") {
    result = manualGenerationReferenceResult(await readManualGenerationReference(scoped), scoped);
  } else if (reason === "version-unsupported") {
    result = dshUnsupportedVersionResult(target, profile, kind);
  } else if (reason === "web-profile-uninitialized") {
    result = {
      status: "error",
      reason: "repair-required",
      message: `DeepSeek Harness ${profile} profile is missing; use Settings Repair to initialize it`,
    };
  } else if (
    (reason === "registration-unknown" || reason === "foreign-package" || reason === "integrity-failed")
    && target.evidence
    && target.evidence.operationRecord === "present"
  ) {
    // A repair was in progress; a foreign or unprovable package must not be
    // "repaired" from the record alone, so report and keep the record.
    result = {
      status: "error",
      reason: "repair-needs-inspection",
      message: "A DeepSeek Harness repair is in progress but this profile is now owned by something else or cannot be confirmed; manual inspection is required",
      repairPath: repairOperationPath(scoped),
      manualInspectionRequired: true,
    };
  } else if (reason === "foreign-package" || reason === "integrity-failed" || reason === "registration-unknown"
    || reason === "profile-corrupt" || reason === "profile-unreadable" || reason === "profile-symlink"
    || reason === "source-unavailable") {
    result = dshOwnershipFailureResult(target, profile, kind);
  } else if (reason === "repair-record-invalid" || reason === "repair-record-unreadable") {
    result = {
      status: "error",
      reason,
      message: "The DeepSeek Harness repair operation record cannot be used; manual inspection is required",
      repairPath: repairOperationPath(scoped),
      manualInspectionRequired: true,
    };
  } else if (reason === "repair-pending") {
    result = {
      status: "error",
      reason: "repair-pending",
      message: "A DeepSeek Harness two-step repair is pending; use Settings Repair to resume it",
      repairPath: repairOperationPath(scoped),
    };
  } else {
    // desktop-only reasons plus carrier-failed / version-invalid keep the role code.
    result = { status: "error", reason, message: dshDiagnoseMessage(target) };
  }
  return { ...result, targetReason: reason };
}

// One target runs its profile flow only when it is mutable, or when web can
// fall back to the manual npx path. Everything else is reported, not run.
async function runDshTarget(options, operation, target, kind) {
  const runsFlow = target.role === "mutable"
    || (target.profile === WEB_PROFILE_NAME && target.role === "diagnose" && target.manualFallback === true);
  let entry;
  if (!runsFlow) {
    const result = target.role === "diagnose" ? await dshDiagnoseResult(target, options, kind) : null;
    entry = { profile: target.profile, role: target.role, reason: target.reason, result, target };
  } else {
    try {
      const result = kind === "uninstall"
        ? await uninstallDshProfile(options, target)
        : await syncDshProfile(options, target);
      entry = { profile: target.profile, role: target.role, reason: target.reason, result, target };
    } catch (err) {
      // A failure on one side never stops the other side from being processed.
      const result = {
        status: "error",
        reason: "unexpected-error",
        message: err && err.message ? err.message : String(err),
      };
      if (err && typeof err.lockPath === "string") result.lockPath = err.lockPath;
      entry = { profile: target.profile, role: target.role, reason: target.reason, result, target };
    }
  }
  // Whether the profile flow actually ran (mutable or web manual fallback). The
  // notices use this to tell a finished flow from a report-only diagnose.
  entry.ranFlow = runsFlow;
  return entry;
}

// A disk-only registration conclusion for one profile. Reuses the role table's
// evidence so it stays consistent with Doctor/roles.
function dshRegistrationAfterFromTarget(target) {
  if (!target || target.role === "not-applicable") return "removed";
  const evidence = target.evidence || {};
  const registration = evidence.registration || "unknown";
  const residue = evidence.residue || "none";
  const latch = evidence.latch || "none";
  if (registration === "owned") return "present";
  if (registration === "none" && residue === "none" && latch === "none") return "removed";
  return "unknown";
}

// The single place an uninstall conclusion is read. Per-side reads are not
// enough: the desktop flow can be long, so web's conclusion can already be
// stale by the time the whole operation returns. This only corrects staleness
// inside this operation's window; writes after this read are out of scope.
function attachDshRegistrationAfter(options, entries) {
  const targets = inspectDshTargetsSync(options, { operation: "uninstall" });
  for (const entry of entries) {
    const registrationAfter = dshRegistrationAfterFromTarget(targets[entry.profile]);
    entry.registrationAfter = registrationAfter;
    if (entry.result) entry.result.registrationAfter = registrationAfter;
  }
}

async function runDshTargets(options, operation, targets, kind) {
  return {
    web: await runDshTarget(options, operation, targets.web, kind),
    desktop: await runDshTarget(options, operation, targets.desktop, kind),
  };
}

function summarizeDshInstallResults(entries) {
  const successes = entries.filter((entry) => dshOutcome(entry.result) === "success");
  const failures = entries.filter((entry) => dshOutcome(entry.result) === "failed");
  const targets = dshTargetsMap(entries);
  if (successes.length) {
    const warnings = failures.map(dshFailureWarning);
    const webFailure = failures.find((entry) => entry.profile === WEB_PROFILE_NAME
      && entry.result
      && entry.result.manualCommand);
    // Keep the single-target result shape (updated / generation / health) the
    // callers already read; only message, warnings and targets are summarized.
    const merged = { ...successes[0].result };
    merged.updated = successes.some((entry) => entry.result.updated === true);
    const desktopSuccess = successes.find((entry) => entry.profile === DESKTOP_PROFILE_NAME);
    if (desktopSuccess) {
      if (desktopSuccess.result.firstInstall !== undefined) merged.firstInstall = desktopSuccess.result.firstInstall;
      if (desktopSuccess.result.restartRequired !== undefined) merged.restartRequired = desktopSuccess.result.restartRequired;
    }
    return {
      ...merged,
      status: "ok",
      message: successes.map((entry) => entry.result.message).filter(Boolean).join(" "),
      ...(warnings.length ? { warnings } : {}),
      ...(webFailure ? { manualCommand: webFailure.result.manualCommand } : {}),
      targets,
    };
  }
  if (failures.length) {
    const first = failures[0];
    return {
      status: "error",
      ...dshErrorFields(first.result, first),
      ...(failures.length > 1 ? { warnings: failures.slice(1).map(dshFailureWarning) } : {}),
      targets,
    };
  }
  const skipped = entries.find((entry) => entry.role !== "not-applicable"
    && entry.result
    && entry.result.status === "skipped");
  if (skipped) return { ...skipped.result, targets };
  const parts = entries.map((entry) => `${entry.profile}: ${entry.reason || "not-applicable"}`);
  let message = `No applicable DeepSeek Harness target (${parts.join("; ")})`;
  if (entries.some((entry) => entry.reason === "desktop-profile-uninitialized")) {
    message += "; open the DeepSeek Harness desktop app once to initialize its profile";
  }
  return { status: "skipped", reason: "no-applicable-target", message, targets };
}

// The error fields for a side whose post-operation conclusion is present or
// unknown. Only a side whose flow actually failed can contribute its own error
// fields; an ok/skipped result or no result at all must not turn into a bogus
// "bridge-not-installed" failure, so it gets the "still registered / could not
// confirm" text instead. The uninstall notice branch uses this same function.
function dshUninstallConclusionFields(entry) {
  const failed = entry.result && dshOutcome(entry.result) === "failed";
  const fields = failed ? dshErrorFields(entry.result, entry) : {};
  if (fields.reason) return fields;
  return {
    ...fields,
    reason: "uninstall-unconfirmed",
    message: fields.message
      || `DeepSeek Harness ${entry.profile} still has a Clawd registration, or it could not be confirmed, after uninstall`,
  };
}

function summarizeDshUninstallResults(entries) {
  const targets = dshTargetsMap(entries);
  // Every profile participates in the conclusion: the pre-operation role only
  // decides whether a flow ran and whether its warnings are collected, not
  // whether its final disk state counts.
  const warnings = [];
  let unremoved = null;
  let unconfirmed = null;
  for (const entry of entries) {
    if (entry.role !== "not-applicable" && entry.result) {
      if (Array.isArray(entry.result.warnings)) {
        for (const line of entry.result.warnings) warnings.push(`${entry.profile}: ${line}`);
      }
      if (dshOutcome(entry.result) === "failed") warnings.push(dshFailureWarning(entry));
    }
    if (entry.registrationAfter === "present") {
      if (!unremoved) unremoved = entry;
    } else if (entry.registrationAfter !== "removed") {
      if (!unconfirmed) unconfirmed = entry;
    }
  }
  if (unremoved) {
    return {
      status: "error",
      registrationRemoved: false,
      ...dshUninstallConclusionFields(unremoved),
      ...(warnings.length ? { warnings } : {}),
      targets,
    };
  }
  if (unconfirmed) {
    return {
      status: "error",
      registrationRemoved: null,
      ...dshUninstallConclusionFields(unconfirmed),
      ...(warnings.length ? { warnings } : {}),
      targets,
    };
  }
  const participants = entries.filter((entry) => entry.role !== "not-applicable");
  const anyFailed = participants.some((entry) => dshOutcome(entry.result) === "failed");
  const removedSomething = participants.some((entry) => entry.result && entry.result.status === "ok");
  if (removedSomething) {
    return {
      status: "ok",
      registrationRemoved: true,
      removed: true,
      updated: true,
      ...(warnings.length ? { warnings } : {}),
      targets,
    };
  }
  if (anyFailed) {
    // Our registration is gone on every side; only secondary cleanup failed.
    return {
      status: "ok",
      registrationRemoved: true,
      ...(warnings.length ? { warnings } : {}),
      targets,
    };
  }
  return {
    status: "skipped",
    reason: "bridge-not-installed",
    registrationRemoved: true,
    ...(warnings.length ? { warnings } : {}),
    targets,
  };
}

// Map one resolved target entry onto the notice outcome this profile applies.
// The flow's own result decides for anything that actually ran; a report-only
// diagnose is the only no-flow case that is a real failure.
function dshNoticeOutcome(operation, entry) {
  if (!entry) return { operation, notApplicable: true };
  const result = entry.result;
  // A failed result can still hand the user a manual command (e.g. no global
  // CLI); it must reach the notice rules together with the failure.
  const manualCommands = typeof (result && result.manualCommand) === "string" && result.manualCommand
    ? result.manualCommand.split("\n")
    : null;
  const manualBundleHash = (result && result.manualBundleHash) || null;
  const asFailure = (reason, message) => ({
    operation,
    manualCommands,
    manualBundleHash,
    failure: {
      reason: reason || entry.reason || "unexpected-error",
      targetReason: (result && (result.targetReason || result.reason)) || entry.reason || null,
      message: message !== undefined ? message : (result ? result.message : null),
      residuePath: result && result.residuePath,
      referencePath: result && result.referencePath,
      lockPath: result && result.lockPath,
      repairPath: result && result.repairPath,
      healthReason: result && result.healthReason,
      cleanupReason: result && result.cleanupReason,
    },
  });

  if (operation === "uninstall") {
    // The post-operation disk read is the truth: confirmed gone clears this
    // side's notices; anything else is reported as a failure, using the same
    // reason/message the summary chose.
    if (entry.registrationAfter === "removed") {
      return { operation, notApplicable: true, removedOk: true };
    }
    const fields = dshUninstallConclusionFields(entry);
    return asFailure(fields.reason, fields.message);
  }

  if (entry.ranFlow !== true) {
    if (entry.role === "diagnose" && result) return asFailure(result.reason, result.message);
    return { operation, notApplicable: true };
  }
  if (result.status === "error") return asFailure(result.reason, result.message);
  return {
    operation,
    status: result.status,
    removedOk: result.status === "ok"
      || (result.status === "skipped" && result.reason === "bridge-not-installed"),
    bundleHash: result.generation ? path.basename(result.generation) : null,
    restartRequired: result.restartRequired === true,
    firstInstall: result.firstInstall === true,
    manualCommands,
    manualBundleHash,
  };
}

// Apply notices for every resolved target inside the caller's enqueueMutation so
// notice writes stay serialized with the operation itself. A notice failure is
// secondary: it adds a warning but never changes the operation status.
async function applyDshNotices(frozen, operation, entries, result) {
  const managedRoot = resolveManagedRoot(frozen);
  const warnings = [];
  for (const entry of entries) {
    const outcome = dshNoticeOutcome(operation, entry);
    try {
      const applied = await applyDshNoticeOutcome(managedRoot, entry.profile, outcome);
      if (applied && applied.error) warnings.push(`${entry.profile}: notice write skipped (${applied.error})`);
    } catch (err) {
      warnings.push(`${entry.profile}: notice write skipped (${err && err.message ? err.message : err})`);
    }
  }
  if (!warnings.length) return result;
  return { ...result, warnings: [...(result.warnings || []), ...warnings] };
}

async function syncDeepSeekHarnessIntegration(options = {}) {
  const operation = options.operation || "install";
  try {
    return await enqueueMutation(async () => {
      const frozen = freezeDshOperationOptions(options);
      if (!(await isDshInstalled(frozen))) {
        return { status: "skipped", reason: "dsh-not-found", message: "DeepSeek Harness is not installed" };
      }
      const targets = await resolveDshTargets(frozen, { operation });
      const run = await runDshTargets(frozen, operation, targets, "sync");
      const entries = [run.web, run.desktop];
      const result = summarizeDshInstallResults(entries);
      return await applyDshNotices(frozen, operation, entries, result);
    });
  } catch (err) {
    if (err && err.code === "DSH_MANUAL_GENERATION_REFERENCE_INVALID") {
      return manualGenerationReferenceResult({ referencePath: err.referencePath }, options);
    }
    throw err;
  }
}

async function uninstallDeepSeekHarnessBridge(options = {}) {
  try {
    return await enqueueMutation(async () => {
      const frozen = freezeDshOperationOptions(options);
      const targets = await resolveDshTargets(frozen, { operation: "uninstall" });
      const run = await runDshTargets(frozen, "uninstall", targets, "uninstall");
      const entries = [run.web, run.desktop];
      // One final read after both flows, so neither side's conclusion is stale.
      attachDshRegistrationAfter(frozen, entries);
      const result = summarizeDshUninstallResults(entries);
      return await applyDshNotices(frozen, "uninstall", entries, result);
    });
  } catch (err) {
    if (err && err.code === "DSH_MANUAL_GENERATION_REFERENCE_INVALID") {
      return manualGenerationReferenceResult({ referencePath: err.referencePath }, options);
    }
    throw err;
  }
}

// Read the persisted notices for both profiles, for the Settings page.
async function readDeepSeekHarnessNotices(options = {}) {
  const frozen = freezeDshOperationOptions(options);
  const managedRoot = resolveManagedRoot(frozen);
  const web = await readDshNotices(managedRoot, WEB_PROFILE_NAME);
  const desktop = await readDshNotices(managedRoot, DESKTOP_PROFILE_NAME);
  const out = { web: web.notices, desktop: desktop.notices };
  if (web.error || desktop.error) out.errors = { web: web.error, desktop: desktop.error };
  return out;
}

// Acknowledge one notice by id. Serialized with the operation writes so the two
// never clobber each other's notice file.
async function acknowledgeDeepSeekHarnessNotice(options = {}, { profile, id } = {}) {
  const name = normalizeDshProfileName(profile);
  return enqueueMutation(async () => {
    const frozen = freezeDshOperationOptions(options);
    const managedRoot = resolveManagedRoot(frozen);
    const result = await acknowledgeDshNotice(managedRoot, name, id);
    return { found: result.found === true, ...(result.error ? { error: result.error } : {}) };
  });
}

function installDeepSeekHarnessBridge(options = {}) {
  return syncDeepSeekHarnessIntegration({ ...options, operation: options.operation || "install" });
}

function registerDeepSeekHarness(options = {}) {
  return syncDeepSeekHarnessIntegration(options);
}

async function unregisterDeepSeekHarness(options = {}) {
  const result = await uninstallDeepSeekHarnessBridge(options);
  if (result.status === "error") return result;
  if (result.status === "ok") {
    // An idempotent "nothing registered" ok must not count as a removal for
    // the About cleanup pass, which sums removed entries across repeats.
    const removed = result.removed === true;
    return { ...result, removed, skipped: !removed };
  }
  return { ...result, removed: false, skipped: true };
}

async function isBridgeInstalled(options = {}) {
  return (await inspectDeepSeekHarnessIntegration(options)).status === "healthy";
}

module.exports = {
  BRIDGE_PACKAGE_NAME,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SOURCE_FILES,
  DSH_RESTART_HINT,
  DSH_VERSION_FAMILIES,
  MANAGED_OWNER,
  PREFERRED_DSH_CONTRACT,
  SUPPORTED_DSH_RANGE,
  SUPPORTED_DSH_VERSION,
  VERIFIED_DSH_ARTIFACT,
  VERIFIED_DSH_ARTIFACT_INTEGRITY,
  VERIFIED_DSH_ARTIFACTS,
  WEB_PROFILE_NAME,
  DESKTOP_PROFILE_NAME,
  dshContractForMarker,
  dshContractForVersion,
  dshFamilyForVersion,
  dshTargetContract,
  isSupportedDshVersion,
  supportedDshRangeLabel,
  dshCommandPathsSync,
  discoverDshDesktopSync,
  discoverDshDesktop,
  refreshDshDesktopDiscovery,
  desktopCommandInfo,
  probeDshCarrier,
  hasDshCommand,
  hasPnpm,
  installDeepSeekHarnessBridge,
  inspectDeepSeekHarnessDiskSync,
  inspectDeepSeekHarnessIntegration,
  inspectDshTargetsSync,
  resolveDshTargets,
  readDeepSeekHarnessNotices,
  acknowledgeDeepSeekHarnessNotice,
  isBridgeInstalled,
  isDshInstalled,
  registerDeepSeekHarness,
  resolveBridgeSourceDir,
  resolveDshCommand,
  resolveDshHome,
  resolveDshInstallRootSync,
  resolveDshProfileDir,
  resolveManagedRoot,
  runDshCommand,
  syncDeepSeekHarnessIntegration,
  unregisterDeepSeekHarness,
  uninstallDeepSeekHarnessBridge,
  __test: {
    acquireMutationLock,
    cleanUnreferencedGenerations,
    compareVersions,
    discardCreatedGenerationIfUnreferenced,
    hashBridgeDirectorySync,
    healthFingerprint,
    inspectionLatchPath,
    clearInspectionLatch,
    readInspectionLatch,
    readInspectionLatchSync,
    isGenerationReferenced,
    unlinkManagedProfileResidue,
    manualGenerationReferencePath,
    readManualGenerationReference,
    readManualGenerationReferenceSync,
    discoverDshDesktopSync,
    discoverDshDesktop,
    refreshDshDesktopDiscovery,
    desktopCommandInfo,
    probeDshCarrier,
    parseDesktopDshCmd,
    buildDesktopCommandEnv,
    buildWindowsRegistryCommand,
    resetWindowsRegistryCache,
    resolvePnpmRuntime,
    readDshVersion,
    resolveDshTargetCarrier,
    resolveDshWebTarget,
    repairOperationPath,
    readRepairOperation,
    writeRepairOperation,
    clearRepairOperation,
    DSH_WINDOWS_REGISTRY_SCRIPT,
    DSH_WRITE_TIMEOUT_MS,
    DSH_NPM_VERSION_TIMEOUT_MS,
    DSH_DESKTOP_VERSION_TIMEOUT_MS,
    inspectDshTargetsSync,
    resolveDshTargets,
    buildManualDshCommand,
    computeExpectedSourceHashesSync,
    digestBridgeFiles,
    dshContractForMarker,
    dshContractForVersion,
    dshFamilyForVersion,
    dshMarkerIdentity,
    dshTargetContract,
    compareDshVersions,
    extractDshVersionToken,
    isSupportedDshVersion,
    parseStrictDshVersion,
    resolveCanonicalDshHome,
    packagePath,
    parseDshVersion,
    promoteGeneration,
    readSourceBundle,
    runCommand,
    supportedDshRangeLabel,
  },
};

if (require.main === module) {
  const uninstall = process.argv.includes("--uninstall") || process.argv.includes("--uninstall-bridge");
  const operation = process.argv.includes("--repair") ? "explicit-repair" : "install";
  Promise.resolve(uninstall
    ? unregisterDeepSeekHarness({ silent: false })
    : syncDeepSeekHarnessIntegration({ silent: false, operation }))
    .then((result) => {
      if (result && result.status === "error") {
        console.error(result.message || result.reason || "DeepSeek Harness integration failed");
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error(err && err.message ? err.message : err);
      process.exitCode = 1;
    });
}
