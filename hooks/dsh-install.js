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

const BRIDGE_PACKAGE_NAME = "@dsh-external/dsh-clawd-bridge";
const WEB_PROFILE_NAME = "web";
const DSH_RESTART_HINT = "DeepSeek Harness bridge verified on disk. Restart any running dsh web process to load this plugin generation.";
const MANAGED_OWNER = "clawd-on-desk";
const MANIFEST_FILE = "clawd-manifest.json";
const MANIFEST_SCHEMA_VERSION = 1;
const BRIDGE_PROTOCOL_VERSION = 1;
// Verified DSH versions, newest first. Each entry is an exact-version
// contract: the version, its exact supported range, and the npm artifact
// bound to it. New installs prefer the first entry; Repair, Uninstall, and
// manual commands select the contract whose version matches the detected
// host or the owned marker. Pre-release DSH versions are intentionally
// exact-pinned — a broad range (>=0.1.x) would admit artifacts this bridge
// has not verified.
const DSH_VERSION_CONTRACTS = Object.freeze([
  Object.freeze({
    version: "0.1.1-rc.2",
    supportedDshRange: "=0.1.1-rc.2",
    verifiedDshArtifact: "@deepseek-ai/dsh@0.1.1-rc.2",
    verifiedDshArtifactIntegrity: "sha512-UP1UIh6q3Gme/yXRn/QL2P8IsVlv8Shpg22TRJIZPsCRWLm4CBiA1MUvXmJAfsOEETBMLAl+xWPtFw6ICsN3wg==",
  }),
  Object.freeze({
    version: "0.1.0-rc.6",
    supportedDshRange: "=0.1.0-rc.6",
    verifiedDshArtifact: "@deepseek-ai/dsh@0.1.0-rc.6",
    verifiedDshArtifactIntegrity: "sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg==",
  }),
]);
const PREFERRED_DSH_CONTRACT = DSH_VERSION_CONTRACTS[0];

// Backwards-compatible aliases for the preferred contract. Code that acts on a
// specific detected host or an owned marker should use dshContractForVersion /
// dshContractForMarker instead of these singletons.
const SUPPORTED_DSH_VERSION = PREFERRED_DSH_CONTRACT.version;
const SUPPORTED_DSH_RANGE = PREFERRED_DSH_CONTRACT.supportedDshRange;
const VERIFIED_DSH_ARTIFACT = PREFERRED_DSH_CONTRACT.verifiedDshArtifact;
const VERIFIED_DSH_ARTIFACT_INTEGRITY = PREFERRED_DSH_CONTRACT.verifiedDshArtifactIntegrity;
const SOURCE_AUDIT_BASELINE_COMMIT = "47f943859bef60e4160492346772ded9b24f765a";
const DEFAULT_OPERATION_TIMEOUT_MS = 120000;
const MUTATION_LOCK_SCHEMA_VERSION = 2;
const MUTATION_LOCK_STALE_MULTIPLIER = 2;
const MAX_MUTATION_LOCK_OPERATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MANUAL_GENERATION_REFERENCE_FILE = "manual-generation-reference.json";
const MANUAL_GENERATION_REFERENCE_SCHEMA_VERSION = 1;
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

function resolveDshProfileDir(dshHome) {
  return path.join(dshHome, "profiles", WEB_PROFILE_NAME);
}

function realpathSyncCanonical(fsImpl, value) {
  return fsImpl.realpathSync.native
    ? fsImpl.realpathSync.native(value)
    : fsImpl.realpathSync(value);
}

function resolveCanonicalDshHome(options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const configured = options.canonicalDshHome
    || options.dshHome
    || resolveDshHome(options.env);
  let canonical = pathApi.resolve(configured);
  if (platform === process.platform) {
    try {
      canonical = realpathSyncCanonical(fs, canonical);
    } catch {}
  }
  return canonical;
}

// Resolve symlinks in the deepest existing ancestor while preserving any
// not-yet-created suffix. Managed roots are often created below a temporary or
// relocated home whose lexical path differs from its real path (for example
// macOS /var -> /private/var). Keeping the future suffix lets first install and
// later ownership inspection agree without weakening marker/hash checks.
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
  if (!commandInfo || !commandInfo.env) return options;
  return {
    ...options,
    env: {
      ...(options.env || process.env),
      ...commandInfo.env,
    },
  };
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

function parseDshVersion(value) {
  const match = String(value || "").match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/);
  return match ? match[1] : null;
}

function dshContractForVersion(version) {
  return DSH_VERSION_CONTRACTS.find((contract) => contract.version === version) || null;
}

function isSupportedDshVersion(version) {
  return dshContractForVersion(version) !== null;
}

function supportedDshRangeLabel() {
  return DSH_VERSION_CONTRACTS.map((contract) => contract.supportedDshRange).join(" or ");
}

// Resolve the exact contract an installed generation was staged for. A marker
// whose installedDshVersion is not in the table, or whose supportedDshRange
// disagrees with its version's contract, is unlisted and returns null.
function dshContractForMarker(marker) {
  if (!marker || typeof marker.installedDshVersion !== "string") return null;
  const contract = dshContractForVersion(marker.installedDshVersion);
  if (!contract || marker.supportedDshRange !== contract.supportedDshRange) return null;
  return contract;
}

async function readDshVersion(commandInfo, options = {}) {
  if (typeof options.dshVersion === "string") return parseDshVersion(options.dshVersion);
  if (!commandInfo) return null;
  const result = await runCommand(commandInfo.command, [...commandInfo.prefixArgs, "--version"], {
    ...commandExecutionOptions(commandInfo, options),
    timeoutMs: 5000,
  });
  if (result.code !== 0) return null;
  return parseDshVersion(`${result.stdout}\n${result.stderr}`);
}

async function hasDshCommand(options = {}) {
  if (typeof options.dshCommandAvailable === "boolean") return options.dshCommandAvailable;
  const command = await resolveDshCommand(options);
  if (!command) return false;
  const result = await runCommand(command.command, [...command.prefixArgs, "--version"], {
    ...commandExecutionOptions(command, options),
    timeoutMs: 5000,
  });
  return result.code === 0;
}

async function resolvePnpmRuntime(commandInfo, options = {}) {
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
    return runCommand(
      command.command,
      [...command.prefixArgs, ...args],
      commandExecutionOptions(command, options),
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
  const profileDir = resolveDshProfileDir(dshHome);
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
  return {
    status: "inspection-required",
    healthReason: "profile-removal-residue",
    dshHome,
    profileDir: resolveDshProfileDir(dshHome),
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

// Hash the current bridge source once per verified contract so health checks
// can compare an installed marker against the source hash for the exact
// contract it was staged for (never against another contract's hash).
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
    for (const contract of DSH_VERSION_CONTRACTS) {
      hashes[contract.version] = digestBridgeFiles(files, contract);
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

function readInspectionLatchSync(fsImpl, options = {}) {
  const filePath = inspectionLatchPath(options);
  try {
    if (!fsImpl.statSync(filePath).isFile()) return null;
  } catch {
    return null;
  }
  return readJsonSync(fsImpl, filePath) || { invalid: true, reason: "inspection-latch-invalid" };
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
    } else if (!dshContractForMarker(marker)) {
      status = "version-unsupported";
    } else if (expectedHashes && marker.bundleHash !== expectedHashes[marker.installedDshVersion]) {
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
  const dshHome = options.dshHome || resolveDshHome(options.env);
  const profileDir = resolveDshProfileDir(dshHome);
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
    return {
      status: latch ? "inspection-required" : (profileManifestExists ? "profile-corrupt" : "profile-missing"),
      dshHome,
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
  const dshInstallRoot = options.dshInstallRoot !== undefined
    ? options.dshInstallRoot
    : resolveDshInstallRootSync({ ...options, fs: fsImpl });
  const dshPackageManifest = dshInstallRoot
    ? readJsonSync(fsImpl, path.join(dshInstallRoot, "package.json"))
    : null;
  const detectedDshVersion = dshPackageManifest && typeof dshPackageManifest.version === "string"
    ? parseDshVersion(dshPackageManifest.version)
    : null;
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
  compatibilityAwareHealth.detectedDshVersion = detectedDshVersion;
  compatibilityAwareHealth.supportedDshRange = supportedDshRangeLabel();
  compatibilityAwareHealth.supportedDshVersions = DSH_VERSION_CONTRACTS.map((contract) => contract.version);
  const latch = readInspectionLatchSync(fsImpl, options);
  if (!latch) return compatibilityAwareHealth;
  const latchBlockedByHigherPriority = immutableConflict
    || compatibilityAwareHealth.status === "host-version-unsupported";
  return {
    ...compatibilityAwareHealth,
    status: latchBlockedByHigherPriority ? compatibilityAwareHealth.status : "inspection-required",
    inspectionLatch: latch,
  };
}

async function inspectDeepSeekHarnessIntegration(options = {}) {
  const dshHome = options.dshHome || resolveDshHome(options.env);
  const profileDir = resolveDshProfileDir(dshHome);
  const removalResidueHealth = managedProfileRemovalResidueHealth(
    await listManagedProfileRemovalResidues(options),
    options
  );
  if (removalResidueHealth) return removalResidueHealth;
  const profileManifestPath = path.join(profileDir, "package.json");
  const profileManifest = await readJson(profileManifestPath);
  if (!profileManifest) {
    return {
      status: await exists(profileManifestPath) ? "profile-corrupt" : "profile-missing",
      dshHome,
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
  const installationManifest = commandInfo && commandInfo.installRoot
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
  return classifyDeepSeekHarnessProfile({
    dshHome,
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
}

async function readSourceBundle(options = {}) {
  const contract = options.contract || dshContractForVersion(options.dshVersion) || PREFERRED_DSH_CONTRACT;
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
  const contract = options.contract || dshContractForVersion(options.dshVersion) || bundle.contract || PREFERRED_DSH_CONTRACT;
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
    && existingContract.version === contract.version
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
      installedDshVersion: options.dshVersion || contract.version,
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
  return path.join(resolveManagedRoot(options), "inspection-required.json");
}

async function readInspectionLatch(options = {}) {
  const filePath = inspectionLatchPath(options);
  if (!(await exists(filePath))) return null;
  const parsed = await readJson(filePath);
  return parsed || { invalid: true, reason: "inspection-latch-invalid" };
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

async function clearInspectionLatch(options = {}) {
  const filePath = inspectionLatchPath(options);
  const current = await readJson(filePath);
  if (!current) return;
  if (current.owner !== MANAGED_OWNER || current.schemaVersion !== 1) {
    throw new Error("DeepSeek Harness inspection latch ownership is invalid; manual inspection required");
  }
  await fsp.rm(filePath, { force: false });
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
  await clearManualGenerationReference(options);
  await cleanUnreferencedGenerations(null, options);
  if (lockedLatch) await clearInspectionLatch(options);
  return { status: "ok", removed: true, updated: true };
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

async function cleanUnreferencedGenerations(activeHash, options = {}) {
  const removalResidues = await listManagedProfileRemovalResidues(options);
  if (removalResidues.unreadableError || removalResidues.paths.length) return;
  const generationsDir = path.join(resolveManagedRoot(options), "generations");
  let entries;
  try {
    entries = await fsp.readdir(generationsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === activeHash || entry.name.startsWith(".staging-")) continue;
    const candidate = path.join(generationsDir, entry.name);
    const marker = await readJson(path.join(candidate, MANIFEST_FILE));
    if (!marker || marker.owner !== MANAGED_OWNER || marker.bundleHash !== entry.name) continue;
    if (await isGenerationReferenced(candidate, options)) continue;
    await fsp.rm(candidate, { recursive: true, force: false });
  }
}

function isPathWithin(candidate, parent) {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedParent = path.resolve(parent);
  return normalizedCandidate === normalizedParent
    || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
}

async function isGenerationReferenced(generationDir, options = {}) {
  const removalResidues = await listManagedProfileRemovalResidues(options);
  if (removalResidues.unreadableError || removalResidues.paths.length) return true;
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
  // generation after the real profile reference is gone.
  for (const root of [resolveDshProfileDir(dshHome)]) {
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
  if (!generation || generation.created !== true) return;
  const generationsDir = path.join(resolveManagedRoot(options), "generations");
  const candidate = path.resolve(generation.generationDir);
  if (!candidate.startsWith(`${path.resolve(generationsDir)}${path.sep}`)) return;
  const marker = await readJson(path.join(candidate, MANIFEST_FILE));
  if (!marker || marker.owner !== MANAGED_OWNER || marker.bundleHash !== generation.bundleHash) return;
  // Inspect the exact generation rather than trusting a health record that may
  // describe the previous managed version. A manifest row referencing this
  // candidate counts even when pnpm did not materialize the package yet.
  if (await isGenerationReferenced(candidate, options)) return;
  await fsp.rm(candidate, { recursive: true, force: false });
}

async function syncDeepSeekHarnessIntegration(options = {}) {
  options = freezeDshOperationOptions(options);
  const operation = options.operation || "install";
  const silent = options.silent === true;
  try {
    return await enqueueMutation(async () => {
    const removalResidueHealth = managedProfileRemovalResidueHealth(
      await listManagedProfileRemovalResidues(options),
      options
    );
    if (removalResidueHealth) return managedProfileRemovalResidueResult(removalResidueHealth);
    const latch = await readInspectionLatch(options);
    if (latch && operation === "startup-sync") return inspectionLatchResult(latch);
    if (!(await isDshInstalled(options))) {
      return { status: "skipped", reason: "dsh-not-found", message: "DeepSeek Harness is not installed" };
    }
    const profileDir = resolveDshProfileDir(options.dshHome || resolveDshHome(options.env));
    if (operation === "startup-sync" && !(await exists(path.join(profileDir, "package.json")))) {
      return {
        status: "error",
        reason: "repair-required",
        message: "DeepSeek Harness web profile is missing; use Settings Repair to initialize it",
      };
    }
    const commandInfo = await resolveDshCommand(options);
    const before = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
    const currentVersion = await sourceClawdVersion(options);
    const manualReference = await readManualGenerationReference(options);
    if (manualReference && manualReference.invalid) {
      return manualGenerationReferenceResult(manualReference, options);
    }
    if (!hasMutableManagedState(before)) {
      return {
        status: "error",
        reason: before.status || "ownership-not-proven",
        message: before.status === "generation-integrity-failed"
          ? "The managed DSH bridge bytes no longer match their ownership marker; manual inspection is required"
          : (before.status === "profile-corrupt"
            ? "The DeepSeek Harness web profile manifest is unreadable; Clawd will not rewrite it automatically"
            : "A foreign or conflicting DSH plugin uses the Clawd package name"),
        manualInspectionRequired: true,
      };
    }
    if (!commandInfo) {
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
      const noCliContract = markerContract || PREFERRED_DSH_CONTRACT;
      const bundle = await readSourceBundle({ ...options, contract: noCliContract });
      if (before.status === "healthy" && before.marker.bundleHash === bundle.bundleHash) {
        if (latch) return inspectionLatchResult(latch);
        if (manualReference) {
          const lock = await acquireMutationLock(options);
          try {
            const locked = await inspectDeepSeekHarnessIntegration({
              ...options,
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
            return { status: "ok", updated: false, health: locked, message: DSH_RESTART_HINT };
          } finally {
            await lock.release();
          }
        }
        return { status: "ok", updated: false, health: before, message: DSH_RESTART_HINT };
      }
      if (operation !== "startup-sync") {
        const lock = await acquireMutationLock(options);
        try {
          const locked = await inspectDeepSeekHarnessIntegration({
            ...options,
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
          const lockedContract = locked.marker ? dshContractForMarker(locked.marker) : null;
          if (
            (before.marker && (!lockedContract || lockedContract.version !== noCliContract.version))
            || (!before.marker && locked.marker)
          ) {
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
            dshVersion: noCliContract.version,
            dshVersionAssumed: true,
          });
          await writeManualGenerationReference(generation, options);
          await cleanUnreferencedGenerations(generation.bundleHash, options);
          return {
            status: "error",
            reason: "cli-unavailable",
            message: "DeepSeek Harness was detected, but a global dsh CLI is not available",
            manualCommand: buildManualDshCommand([
              "npx",
              `@deepseek-ai/dsh@${noCliContract.version}`,
              "plugin",
              "--profile",
              WEB_PROFILE_NAME,
              "add",
              generation.generationDir,
            ], options),
            manualGenerationReferenced: true,
          };
        } finally {
          await lock.release();
        }
      }
      return { status: "error", reason: "cli-unavailable", message: "DeepSeek Harness CLI is not available" };
    }
    const dshVersion = await readDshVersion(commandInfo, options);
    const contract = dshContractForVersion(dshVersion);
    const bundle = await readSourceBundle({ ...options, contract });
    if (!contract) {
      return {
        status: "error",
        reason: "version-unsupported",
        message: `DeepSeek Harness ${dshVersion || "unknown"} is unsupported; this bridge supports ${supportedDshRangeLabel()}`,
        detectedVersion: dshVersion,
        supportedRange: supportedDshRangeLabel(),
      };
    }
    if (
      !latch
      && !manualReference
      && before.status === "healthy"
      && before.marker.bundleHash === bundle.bundleHash
    ) {
      return { status: "ok", updated: false, health: before, message: DSH_RESTART_HINT };
    }
    if (before.owned && before.marker && before.marker.bundleHash !== bundle.bundleHash) {
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
      const locked = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
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
      if (lockedVersion !== contract.version) {
        return {
          status: "error",
          reason: "version-changed",
          message: `DeepSeek Harness changed from ${contract.version} to ${lockedVersion} before mutation; retry after the host version is stable`,
          detectedVersion: lockedVersion,
          expectedVersion: contract.version,
          supportedRange: supportedDshRangeLabel(),
        };
      }
      if (!hasMutableManagedState(locked)) {
        return {
          status: "error",
          reason: locked.status || "ownership-changed",
          message: "DSH plugin ownership or managed bytes changed before mutation",
          manualInspectionRequired: true,
        };
      }
      const lockedLatch = await readInspectionLatch(options);
      if (locked.status === "healthy" && locked.marker.bundleHash === bundle.bundleHash) {
        if (manualReference) {
          await clearManualGenerationReference(options);
          await cleanUnreferencedGenerations(locked.marker.bundleHash, options);
        }
        if (lockedLatch) await clearInspectionLatch(options);
        return { status: "ok", updated: false, health: locked, message: DSH_RESTART_HINT };
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
      const result = await runDshCommand([
        "plugin", "--profile", WEB_PROFILE_NAME, "add", generation.generationDir,
      ], { ...options, commandInfo: pnpmRuntime.commandInfo });
      if (result.code !== 0) {
        const failedHealth = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
        const unknown = isUnknownCommandResult(result);
        const changed = healthFingerprint(failedHealth) !== healthFingerprint(locked);
        if (unknown || changed) {
          await writeInspectionLatch(
            unknown ? "plugin-add-unknown" : "plugin-add-partial-mutation",
            (result.stderr || result.stdout || "dsh plugin add failed").trim(),
            options
          );
          return {
            status: "error",
            reason: "inspection-required",
            message: (result.stderr || result.stdout || "dsh plugin add had an unknown or partial result").trim(),
            manualCommand: buildManualDshCommand([
              "dsh", "plugin", "--profile", WEB_PROFILE_NAME, "add", generation.generationDir,
            ], options),
            manualInspectionRequired: true,
          };
        }
        await discardCreatedGenerationIfUnreferenced(generation, failedHealth, options);
        return {
          status: "error",
          reason: "plugin-add-failed",
          message: (result.stderr || result.stdout || "dsh plugin add failed").trim(),
          manualCommand: buildManualDshCommand([
            "dsh", "plugin", "--profile", WEB_PROFILE_NAME, "add", generation.generationDir,
          ], options),
        };
      }
      const after = await inspectDeepSeekHarnessIntegration({
        ...options,
        commandInfo,
        expectedHashes: { [contract.version]: generation.bundleHash },
      });
      if (after.status !== "healthy") {
        await writeInspectionLatch("plugin-add-verification-failed", after.status, options);
        return {
          status: "error",
          reason: "inspection-required",
          healthReason: after.status,
          message: "dsh plugin add completed but the managed bridge did not verify healthy",
          manualInspectionRequired: true,
        };
      }
      await clearManualGenerationReference(options);
      await cleanUnreferencedGenerations(generation.bundleHash, options);
      if (lockedLatch) await clearInspectionLatch(options);
      if (!silent) console.log(`Clawd: DeepSeek Harness bridge ready (${generation.bundleHash.slice(0, 12)})`);
      return {
        status: "ok",
        updated: true,
        generation: generation.generationDir,
        health: after,
        message: DSH_RESTART_HINT,
      };
    } finally {
      await lock.release();
    }
    });
  } catch (err) {
    if (err && err.code === "DSH_MANUAL_GENERATION_REFERENCE_INVALID") {
      return manualGenerationReferenceResult({ referencePath: err.referencePath }, options);
    }
    throw err;
  }
}

async function uninstallDeepSeekHarnessBridge(options = {}) {
  options = freezeDshOperationOptions(options);
  try {
    return await enqueueMutation(async () => {
    const removalResidueHealth = managedProfileRemovalResidueHealth(
      await listManagedProfileRemovalResidues(options),
      options
    );
    if (removalResidueHealth) return managedProfileRemovalResidueResult(removalResidueHealth);
    const latch = await readInspectionLatch(options);
    const manualReference = await readManualGenerationReference(options);
    if (manualReference && manualReference.invalid) {
      return manualGenerationReferenceResult(manualReference, options);
    }
    const commandInfo = await resolveDshCommand(options);
    const before = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
    if (before.status === "absent" || before.status === "profile-missing") {
      if (!latch) {
        const lock = await acquireMutationLock(options);
        try {
          const locked = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
          if (locked.status !== "absent" && locked.status !== "profile-missing") {
            return {
              status: "error",
              reason: "ownership-changed",
              message: "DSH plugin state changed while cleaning unreferenced managed generations",
              manualInspectionRequired: true,
            };
          }
          await clearManualGenerationReference(options);
          await cleanUnreferencedGenerations(null, options);
          return { status: "skipped", reason: "bridge-not-installed" };
        } finally {
          await lock.release();
        }
      }
      if (!commandInfo) return inspectionLatchResult(latch);
      const dshVersion = await readDshVersion(commandInfo, options);
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
        const locked = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
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
        const lockedLatch = await readInspectionLatch(options);
        await clearManualGenerationReference(options);
        await cleanUnreferencedGenerations(null, options);
        if (lockedLatch) await clearInspectionLatch(options);
        return { status: "skipped", reason: "bridge-not-installed" };
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
      if (before.status === "managed-residue") {
        const lock = await acquireMutationLock(options);
        try {
          const locked = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
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
          if (lockedContract.version !== removalContract.version) {
            return {
              status: "error",
              reason: "ownership-changed",
              message: "DSH plugin contract changed before managed residue cleanup",
            };
          }
          const lockedLatch = await readInspectionLatch(options);
          return await cleanLockedManagedProfileResidue(locked, commandInfo, lockedLatch, options);
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
          `@deepseek-ai/dsh@${removalContract.version}`,
          "plugin",
          "--profile",
          WEB_PROFILE_NAME,
          "remove",
          BRIDGE_PACKAGE_NAME,
        ], options),
      };
    }
    const dshVersion = await readDshVersion(commandInfo, options);
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
      const locked = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
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
      if (
        !hasMutableManagedState(locked)
        || !locked.owned
        || !locked.marker
        || locked.marker.bundleHash !== before.marker.bundleHash
      ) {
        return { status: "error", reason: "ownership-changed", message: "DSH plugin ownership changed before removal" };
      }
      const lockedLatch = await readInspectionLatch(options);
      if (locked.status === "managed-residue") {
        return await cleanLockedManagedProfileResidue(locked, commandInfo, lockedLatch, options);
      }
      const pnpmRuntime = await resolvePnpmRuntime(commandInfo, options);
      if (!pnpmRuntime.available) {
        return { status: "error", reason: "pnpm-unavailable", message: "pnpm is required by dsh plugin remove" };
      }
      const result = await runDshCommand([
        "plugin", "--profile", WEB_PROFILE_NAME, "remove", BRIDGE_PACKAGE_NAME,
      ], { ...options, commandInfo: pnpmRuntime.commandInfo });
      if (result.code !== 0) {
        const failedHealth = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
        const unknown = isUnknownCommandResult(result);
        const changed = healthFingerprint(failedHealth) !== healthFingerprint(locked);
        if (unknown || changed) {
          await writeInspectionLatch(
            unknown ? "plugin-remove-unknown" : "plugin-remove-partial-mutation",
            (result.stderr || result.stdout || "dsh plugin remove failed").trim(),
            options
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
      let after = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
      if (after.status === "managed-residue") {
        const cleanup = await unlinkManagedProfileResidue(after, options);
        if (!cleanup.removed) {
          await writeInspectionLatch("plugin-remove-residue-cleanup-failed", cleanup.reason, options);
          return {
            status: "error",
            reason: "inspection-required",
            healthReason: after.status,
            cleanupReason: cleanup.reason,
            message: "dsh plugin remove left a profile-local package residue that could not be safely unlinked",
            manualInspectionRequired: true,
          };
        }
        after = await inspectDeepSeekHarnessIntegration({ ...options, commandInfo });
      }
      if (after.status !== "absent" && after.status !== "profile-missing") {
        await writeInspectionLatch("plugin-remove-verification-failed", after.status, options);
        return {
          status: "error",
          reason: "inspection-required",
          healthReason: after.status,
          message: "dsh plugin remove completed but profile entries or a resolved package remain",
          manualInspectionRequired: true,
        };
      }
      await clearManualGenerationReference(options);
      await cleanUnreferencedGenerations(null, options);
      if (lockedLatch) await clearInspectionLatch(options);
      return { status: "ok", removed: true, updated: true };
    } finally {
      await lock.release();
    }
    });
  } catch (err) {
    if (err && err.code === "DSH_MANUAL_GENERATION_REFERENCE_INVALID") {
      return manualGenerationReferenceResult({ referencePath: err.referencePath }, options);
    }
    throw err;
  }
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
  return result.status === "ok"
    ? { ...result, removed: true, skipped: false }
    : { ...result, removed: false, skipped: true };
}

async function isBridgeInstalled(options = {}) {
  return (await inspectDeepSeekHarnessIntegration(options)).status === "healthy";
}

module.exports = {
  BRIDGE_PACKAGE_NAME,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SOURCE_FILES,
  DSH_RESTART_HINT,
  DSH_VERSION_CONTRACTS,
  MANAGED_OWNER,
  PREFERRED_DSH_CONTRACT,
  SUPPORTED_DSH_RANGE,
  SUPPORTED_DSH_VERSION,
  VERIFIED_DSH_ARTIFACT,
  VERIFIED_DSH_ARTIFACT_INTEGRITY,
  WEB_PROFILE_NAME,
  dshContractForMarker,
  dshContractForVersion,
  isSupportedDshVersion,
  supportedDshRangeLabel,
  dshCommandPathsSync,
  hasDshCommand,
  hasPnpm,
  installDeepSeekHarnessBridge,
  inspectDeepSeekHarnessDiskSync,
  inspectDeepSeekHarnessIntegration,
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
    isGenerationReferenced,
    unlinkManagedProfileResidue,
    manualGenerationReferencePath,
    readManualGenerationReference,
    buildManualDshCommand,
    computeExpectedSourceHashesSync,
    digestBridgeFiles,
    dshContractForMarker,
    dshContractForVersion,
    isSupportedDshVersion,
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
