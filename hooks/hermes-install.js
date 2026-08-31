#!/usr/bin/env node
"use strict";

// Install Clawd's Hermes Agent plugin without mutating Hermes config.yaml.
//
// Hermes config is YAML and user-owned. The only supported activation path in
// this installer is `hermes plugins enable clawd-on-desk`; if the CLI is not
// available, we copy the managed plugin files and report a repairable error.

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { asarUnpackedPath } = require("./json-utils");

const PLUGIN_ID = "clawd-on-desk";
const PLUGIN_SOURCE_DIR_NAME = "hermes-plugin";
const MANAGED_PLUGIN_FILES = ["plugin.yaml", "__init__.py"];
const SSH_SECURE_MARKER_FILENAME = "clawd-ssh-secure-v1";
const SSH_SECURE_MARKER_CONTENT = "clawd-ssh-secure-v1";
const REMOTE_ALLOWED_PLUGIN_ENTRIES = new Set([
  ...MANAGED_PLUGIN_FILES,
  SSH_SECURE_MARKER_FILENAME,
  "__pycache__",
]);
const HERMES_RESULT_SCHEMA_VERSION = 1;
const HERMES_RESULT_SENTINEL = "CLAWD_HERMES_RESULT_V1=";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".hermes");
const DEFAULT_PLUGIN_DIR = path.join(DEFAULT_PARENT_DIR, "plugins", PLUGIN_ID);
let _atomicWriteCounter = 0;

function parseHermesCliArgs(argv) {
  const parsed = {
    uninstall: false,
    jsonMode: false,
    remote: false,
    sourceDir: null,
    targetHomes: [],
    cliTimeoutMs: null,
    errors: [],
  };
  const args = Array.isArray(argv) ? argv : [];

  function takeValue(index, flag) {
    const value = args[index + 1];
    if (typeof value !== "string" || !value || value.startsWith("--")) {
      parsed.errors.push(`${flag} requires a value`);
      return { value: null, next: index };
    }
    return { value, next: index + 1 };
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--uninstall") {
      parsed.uninstall = true;
    } else if (arg === "--json") {
      parsed.jsonMode = true;
    } else if (arg === "--remote") {
      parsed.remote = true;
    } else if (arg === "--source-dir") {
      const taken = takeValue(i, arg);
      i = taken.next;
      if (taken.value !== null) parsed.sourceDir = taken.value;
    } else if (arg === "--target-home") {
      const taken = takeValue(i, arg);
      i = taken.next;
      if (taken.value !== null) parsed.targetHomes.push(taken.value);
    } else if (arg === "--cli-timeout-ms") {
      const taken = takeValue(i, arg);
      i = taken.next;
      if (taken.value !== null) {
        if (!/^[1-9][0-9]*$/.test(taken.value) || !Number.isSafeInteger(Number(taken.value))) {
          parsed.errors.push("--cli-timeout-ms must be a positive integer");
        } else {
          parsed.cliTimeoutMs = Number(taken.value);
        }
      }
    } else {
      parsed.errors.push(`Unknown argument: ${arg}`);
    }
  }

  if (parsed.sourceDir !== null && !path.posix.isAbsolute(parsed.sourceDir)) {
    parsed.errors.push("--source-dir must be an absolute POSIX path");
  }
  for (const targetHome of parsed.targetHomes) {
    if (!path.posix.isAbsolute(targetHome)) {
      parsed.errors.push(`--target-home must be an absolute POSIX path: ${targetHome}`);
    }
  }
  if (parsed.remote && !parsed.jsonMode) {
    parsed.errors.push("--remote requires --json");
  }
  if (parsed.remote && !parsed.uninstall) {
    if (!parsed.sourceDir) parsed.errors.push("Remote install requires --source-dir");
    if (!parsed.targetHomes.length) parsed.errors.push("Remote install requires at least one --target-home");
  }
  if (parsed.targetHomes.length > 2) {
    parsed.targetHomes = [parsed.targetHomes[0], ...parsed.targetHomes.slice(1).sort()];
  }
  return parsed;
}

function resolvePluginSourceDir(baseDir = __dirname) {
  return asarUnpackedPath(path.resolve(baseDir, PLUGIN_SOURCE_DIR_NAME));
}

function resolveHermesHome(options = {}) {
  if (typeof options.hermesHome === "string" && options.hermesHome.trim()) {
    return path.resolve(options.hermesHome);
  }

  const env = options.env || process.env;
  if (typeof env.HERMES_HOME === "string" && env.HERMES_HOME.trim()) {
    return path.resolve(env.HERMES_HOME);
  }

  const platform = options.platform || process.platform;
  if (platform === "win32" && typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA.trim()) {
    const localHermes = path.join(env.LOCALAPPDATA, "hermes");
    try {
      if (fs.existsSync(path.join(localHermes, "config.yaml"))) return localHermes;
      if (fs.existsSync(path.join(localHermes, "hermes-agent", "venv", "Scripts", "hermes.exe"))) {
        return localHermes;
      }
    } catch {}
  }

  return path.join(options.homeDir || os.homedir(), ".hermes");
}

function pathExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function discoverHermesProfileHomes(hermesHome) {
  const profilesDir = path.join(hermesHome, "profiles");
  let entries = [];
  try {
    entries = fs.readdirSync(profilesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const homes = [];
  for (const entry of entries) {
    if (!entry || !entry.isDirectory()) continue;
    const profileHome = path.join(profilesDir, entry.name);
    if (!pathExists(path.join(profileHome, "config.yaml"))) continue;
    homes.push(profileHome);
  }
  homes.sort((a, b) => a.localeCompare(b));
  return homes;
}

// Uninstall must also find profile-owned plugin remnants after a profile's
// config.yaml was deleted. Registration intentionally ignores those profiles,
// but leaving their managed plugin directory behind would make Settings offer
// an Unpair action that can never finish.
function discoverHermesManagedPluginHomes(hermesHome) {
  const profilesDir = path.join(hermesHome, "profiles");
  let entries = [];
  try {
    entries = fs.readdirSync(profilesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const homes = [];
  for (const entry of entries) {
    if (!entry || !entry.isDirectory()) continue;
    const profileHome = path.join(profilesDir, entry.name);
    const pluginDir = path.join(profileHome, "plugins", PLUGIN_ID);
    if (!MANAGED_PLUGIN_FILES.some((name) => pathExists(path.join(pluginDir, name)))) continue;
    homes.push(profileHome);
  }
  homes.sort((a, b) => a.localeCompare(b));
  return homes;
}

function hermesHomesForSync(options = {}) {
  const hermesHome = resolveHermesHome(options);
  const homes = [hermesHome];
  if (options.syncProfiles === false) return homes;

  const seen = new Set(homes.map((home) => path.resolve(home)));
  for (const profileHome of discoverHermesProfileHomes(hermesHome)) {
    const resolved = path.resolve(profileHome);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    homes.push(resolved);
  }
  return homes;
}

function hermesHomesForRemoval(options = {}) {
  const hermesHome = resolveHermesHome(options);
  const homes = [hermesHome];
  if (options.syncProfiles === false || options.pluginDir) return homes;

  const seen = new Set(homes.map((home) => path.resolve(home)));
  const candidates = [
    ...discoverHermesProfileHomes(hermesHome),
    ...discoverHermesManagedPluginHomes(hermesHome),
  ];
  for (const profileHome of candidates) {
    const resolved = path.resolve(profileHome);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    homes.push(resolved);
  }
  return homes;
}

function hermesCommandCandidates(options = {}, hermesHome = resolveHermesHome(options)) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const candidates = [];
  if (platform === "win32") {
    candidates.push(path.join(hermesHome, "hermes-agent", "venv", "Scripts", "hermes.exe"));
    if (typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA.trim()) {
      candidates.push(path.join(env.LOCALAPPDATA, "hermes", "hermes-agent", "venv", "Scripts", "hermes.exe"));
    }
  } else {
    candidates.push(path.join(hermesHome, "hermes-agent", "venv", "bin", "hermes"));
    if (options.remote) {
      candidates.push(path.join(path.dirname(hermesHome), ".local", "bin", "hermes"));
    }
  }
  return candidates;
}

function isHermesInstalled(options = {}) {
  if (options.hermesCommand === null || options.hermesCommand === false) return false;
  if (typeof options.hermesCommand === "string" && options.hermesCommand.trim()) return true;

  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homes = [];
  if (typeof options.hermesHome === "string" && options.hermesHome.trim()) {
    homes.push(path.resolve(options.hermesHome));
  } else if (typeof env.HERMES_HOME === "string" && env.HERMES_HOME.trim()) {
    homes.push(path.resolve(env.HERMES_HOME));
  } else {
    if (platform === "win32" && typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA.trim()) {
      homes.push(path.join(env.LOCALAPPDATA, "hermes"));
    }
    homes.push(path.join(options.homeDir || os.homedir(), ".hermes"));
  }

  for (const hermesHome of homes) {
    if (pathExists(path.join(hermesHome, "config.yaml"))) return true;
    for (const candidate of hermesCommandCandidates(options, hermesHome)) {
      if (pathExists(candidate)) return true;
    }
  }
  return false;
}

function resolveHermesCommand(options = {}) {
  if (options.hermesCommand === null || options.hermesCommand === false) return null;
  if (typeof options.hermesCommand === "string" && options.hermesCommand.trim()) {
    return options.hermesCommand;
  }

  const hermesHome = options.hermesHome || resolveHermesHome(options);
  for (const candidate of hermesCommandCandidates(options, hermesHome)) {
    if (pathExists(candidate)) return candidate;
  }

  return "hermes";
}

function quoteCommandToken(token) {
  const value = String(token || "");
  return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function formatHermesCommand(command, args) {
  const base = command || "hermes";
  return [quoteCommandToken(base), ...args].join(" ");
}

function lstatIfPresent(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

function assertSafeManagedLeaf(filePath, expectedType) {
  const stat = lstatIfPresent(filePath);
  if (!stat) return null;
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to manage symlink: ${filePath}`);
  }
  if (expectedType === "directory" && !stat.isDirectory()) {
    throw new Error(`Managed plugin path is not a directory: ${filePath}`);
  }
  if (expectedType === "file" && !stat.isFile()) {
    throw new Error(`Managed plugin file is not a regular file: ${filePath}`);
  }
  return stat;
}

function classifyManagedPluginDir(pluginDir) {
  let pluginStat;
  try {
    pluginStat = lstatIfPresent(pluginDir);
  } catch {
    return "foreign";
  }
  if (!pluginStat) return "absent";
  if (pluginStat.isSymbolicLink()) return "symlink";
  if (!pluginStat.isDirectory()) return "foreign";

  const knownPaths = [
    ...MANAGED_PLUGIN_FILES,
    SSH_SECURE_MARKER_FILENAME,
    "__pycache__",
  ];
  try {
    for (const name of knownPaths) {
      const stat = lstatIfPresent(path.join(pluginDir, name));
      if (stat && stat.isSymbolicLink()) return "symlink";
    }

    const entries = fs.readdirSync(pluginDir);
    if (entries.some((name) => !REMOTE_ALLOWED_PLUGIN_ENTRIES.has(name))) return "foreign";

    const pycachePath = path.join(pluginDir, "__pycache__");
    const pycacheStat = lstatIfPresent(pycachePath);
    if (pycacheStat) {
      if (!pycacheStat.isDirectory()) return "foreign";
      const cached = fs.readdirSync(pycachePath, { withFileTypes: true });
      if (cached.some((entry) => !entry.isFile() || !entry.name.endsWith(".pyc"))) return "foreign";
    }

    const pluginYamlPath = path.join(pluginDir, "plugin.yaml");
    const initPath = path.join(pluginDir, "__init__.py");
    const pluginYamlStat = lstatIfPresent(pluginYamlPath);
    const initStat = lstatIfPresent(initPath);
    if (!pluginYamlStat || !pluginYamlStat.isFile() || !initStat || !initStat.isFile()) {
      return "foreign";
    }

    const markerPath = path.join(pluginDir, SSH_SECURE_MARKER_FILENAME);
    const markerStat = lstatIfPresent(markerPath);
    if (markerStat) {
      if (!markerStat.isFile()) return "foreign";
      const marker = fs.readFileSync(markerPath, "utf8").trim();
      return marker === SSH_SECURE_MARKER_CONTENT ? "managed" : "foreign";
    }

    const pluginYaml = fs.readFileSync(pluginYamlPath, "utf8");
    const initSource = fs.readFileSync(initPath, "utf8");
    const hasPluginEvidence = /^name:\s*["']?clawd-on-desk["']?\s*$/m.test(pluginYaml);
    const hasInitEvidence = initSource.includes('CLAWD_SERVER_ID = "clawd-on-desk"');
    return hasPluginEvidence && hasInitEvidence ? "legacy" : "foreign";
  } catch {
    return "foreign";
  }
}

function describePluginOwnershipConflict(pluginDir) {
  try {
    const pluginStat = lstatIfPresent(pluginDir);
    if (pluginStat && pluginStat.isSymbolicLink()) return pluginDir;
    for (const name of [...MANAGED_PLUGIN_FILES, SSH_SECURE_MARKER_FILENAME, "__pycache__"]) {
      const candidate = path.join(pluginDir, name);
      const stat = lstatIfPresent(candidate);
      if (stat && stat.isSymbolicLink()) return candidate;
    }
    for (const name of fs.readdirSync(pluginDir)) {
      if (!REMOTE_ALLOWED_PLUGIN_ENTRIES.has(name)) return path.join(pluginDir, name);
    }
    const pycachePath = path.join(pluginDir, "__pycache__");
    const pycacheStat = lstatIfPresent(pycachePath);
    if (pycacheStat && pycacheStat.isDirectory()) {
      for (const entry of fs.readdirSync(pycachePath, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".pyc")) return path.join(pycachePath, entry.name);
      }
    }
  } catch {}
  return pluginDir;
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function readManagedPluginHashes(pluginDir) {
  const hashes = {};
  for (const name of MANAGED_PLUGIN_FILES) {
    hashes[name] = sha256(fs.readFileSync(path.join(pluginDir, name)));
  }
  return hashes;
}

function configHasManagedPluginEnabled(content) {
  const lines = String(content || "").split(/\r?\n/);
  let inPlugins = false;
  let inEnabled = false;
  let enabledIndent = -1;
  for (const line of lines) {
    if (!inPlugins) {
      if (/^plugins:\s*$/.test(line)) inPlugins = true;
      continue;
    }

    if (/^\S/.test(line) && line.trim()) return false;
    const inline = line.match(/^\s+enabled:\s*\[(.*)\]\s*$/);
    if (inline) {
      return /(?:^|,)\s*["']?clawd-on-desk["']?\s*(?:,|$)/.test(inline[1]);
    }
    const enabled = line.match(/^(\s+)enabled:\s*$/);
    if (enabled) {
      inEnabled = true;
      enabledIndent = enabled[1].length;
      continue;
    }
    if (!inEnabled) continue;
    if (/^\s+-\s*["']?clawd-on-desk["']?\s*$/.test(line)) return true;
    const mapping = line.match(/^(\s+)[A-Za-z0-9_.-]+:\s*/);
    if (mapping && mapping[1].length <= enabledIndent) inEnabled = false;
  }
  return false;
}

function writeManagedFileAtomic(filePath, content, options = {}) {
  const base = path.basename(filePath);
  const dir = path.dirname(filePath);
  const suffix = `${process.pid}.${Date.now()}.${++_atomicWriteCounter}`;
  const tempPath = path.join(dir, `.${base}.clawd-${suffix}.tmp`);
  const writeFileSync = options.writeFileSync || fs.writeFileSync;
  const renameSync = options.renameSync || fs.renameSync;
  const unlinkSync = options.unlinkSync || fs.unlinkSync;

  try {
    writeFileSync(tempPath, content, { flag: "wx", mode: 0o600 });
    renameSync(tempPath, filePath);
  } catch (err) {
    try { unlinkSync(tempPath); } catch {}
    throw err;
  }
}

function copyManagedPluginFiles(options = {}) {
  const sourceDir = options.sourcePluginDir || resolvePluginSourceDir(options.baseDir);
  const pluginDir = options.pluginDir;
  if (!pluginDir) throw new Error("copyManagedPluginFiles requires pluginDir");

  assertSafeManagedLeaf(pluginDir, "directory");
  fs.mkdirSync(pluginDir, { recursive: true });
  assertSafeManagedLeaf(pluginDir, "directory");

  let installed = 0;
  let updated = 0;
  let skipped = 0;
  for (const file of MANAGED_PLUGIN_FILES) {
    const sourcePath = path.join(sourceDir, file);
    const destPath = path.join(pluginDir, file);
    const source = fs.readFileSync(sourcePath);
    const destStat = assertSafeManagedLeaf(destPath, "file");
    let current = null;
    if (destStat) current = fs.readFileSync(destPath);

    if (!current) {
      writeManagedFileAtomic(destPath, source, options);
      installed++;
      continue;
    }
    if (!Buffer.compare(current, source)) {
      skipped++;
      continue;
    }
    writeManagedFileAtomic(destPath, source, options);
    updated++;
  }
  return { installed, updated, skipped };
}

function runHermesCli(args, options = {}) {
  const hermesHome = options.hermesHome || resolveHermesHome(options);
  const command = resolveHermesCommand({ ...options, hermesHome });
  const displayCommand = formatHermesCommand(command || "hermes", args);
  const timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : 5000;
  if (!command) {
    return {
      ok: false,
      unavailable: true,
      command: null,
      displayCommand,
      message: "Hermes CLI is unavailable",
    };
  }

  const spawn = options.spawnSync || spawnSync;
  const result = spawn(command, args, {
    encoding: "utf8",
    env: { ...(options.env || process.env), HERMES_HOME: hermesHome },
    timeout,
    windowsHide: true,
  });
  if (result && result.error) {
    return {
      ok: false,
      unavailable: result.error.code === "ENOENT",
      command,
      displayCommand,
      message: result.error.message,
      error: result.error,
    };
  }
  if (!result || result.status !== 0) {
    const stderr = result && typeof result.stderr === "string" ? result.stderr.trim() : "";
    const stdout = result && typeof result.stdout === "string" ? result.stdout.trim() : "";
    return {
      ok: false,
      unavailable: false,
      command,
      displayCommand,
      status: result ? result.status : null,
      message: stderr || stdout || `Hermes CLI exited with status ${result ? result.status : "unknown"}`,
      stderr,
      stdout,
    };
  }
  return {
    ok: true,
    command,
    displayCommand,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function remoteTargetBase(targetHome, index, plugin) {
  return {
    home: targetHome,
    kind: index === 0 ? "root" : "profile",
    plugin,
    action: "failed",
    status: "error",
    reason: null,
    message: "",
    hashes: null,
    marker: false,
    enabled: null,
    activation: null,
    warnings: [],
  };
}

function parsePluginListEntry(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { parsed: false, entry: null };
  }
  const candidates = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.plugins)
      ? parsed.plugins
      : (parsed && Array.isArray(parsed.data) ? parsed.data : []));
  const entry = candidates.find((item) => item && item.name === PLUGIN_ID) || null;
  return { parsed: true, entry };
}

function inspectActiveGatewayUnits(options = {}) {
  const spawn = options.spawnSync || spawnSync;
  const result = spawn("systemctl", [
    "--user",
    "list-units",
    "--type=service",
    "--no-legend",
    "--plain",
    "hermes*",
  ], {
    encoding: "utf8",
    env: options.env || process.env,
    timeout: 2000,
    windowsHide: true,
  });
  if (!result || result.error || result.status !== 0) {
    return { units: null, warning: "Could not inspect active Hermes gateway services" };
  }
  const units = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns.length >= 3 && columns[2] === "active")
    .map((columns) => columns[0]);
  return { units, warning: null };
}

function summarizeRemoteOperation(operation, targets) {
  const counts = new Map();
  for (const target of targets) counts.set(target.action, (counts.get(target.action) || 0) + 1);
  const details = ["installed", "updated", "unchanged", "removed", "skipped", "failed"]
    .filter((action) => counts.has(action))
    .map((action) => `${counts.get(action)} ${action}`)
    .join(", ");
  const restartCount = targets.filter((target) => target.activation === "restart-required").length;
  const prefix = operation === "uninstall" ? "Hermes plugin removal" : "Hermes plugin installed";
  return boundedResultText(
    `${prefix} on ${targets.length} target${targets.length === 1 ? "" : "s"}${details ? ` (${details})` : ""}`
      + (restartCount ? `; gateway restart required for ${restartCount}` : "")
  );
}

function remoteAggregate(operation, targets, options = {}) {
  const warnings = Array.isArray(options.warnings) ? options.warnings.filter(Boolean) : [];
  for (const target of targets) warnings.push(...target.warnings.map((warning) => `${target.home}: ${warning}`));
  const firstError = targets.find((target) => target.status === "error");
  const hasWarning = warnings.length > 0 || targets.some((target) => target.status === "warning");
  return {
    status: firstError ? "error" : (hasWarning ? "warning" : "ok"),
    reason: firstError ? firstError.reason : null,
    message: summarizeRemoteOperation(operation, targets),
    warnings,
    profileErrorCount: targets.filter((target) => target.status === "error").length,
    remote: true,
    cliCommand: options.cliCommand ? formatHermesCommand(options.cliCommand, []) : null,
    targets,
    activeGatewayUnits: options.activeGatewayUnits === undefined ? null : options.activeGatewayUnits,
  };
}

function unavailableRemoteInstall(targetHomes, cliCommand, message) {
  const targets = targetHomes.map((targetHome, index) => {
    const pluginDir = path.join(targetHome, "plugins", PLUGIN_ID);
    return {
      ...remoteTargetBase(targetHome, index, classifyManagedPluginDir(pluginDir)),
      reason: "hermes-cli-unavailable",
      message: boundedResultText(message, "Hermes CLI is unavailable"),
    };
  });
  return remoteAggregate("install", targets, { cliCommand, activeGatewayUnits: null });
}

function registerHermesPluginRemote(options = {}) {
  const targetHomes = Array.isArray(options.targetHomes) ? options.targetHomes.slice() : [];
  const rootHome = targetHomes[0];
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : 15000;
  const cliCommand = rootHome
    ? resolveHermesCommand({
      env: options.env,
      hermesCommand: options.hermesCommand,
      hermesHome: rootHome,
      remote: true,
    })
    : null;
  if (!cliCommand) {
    return unavailableRemoteInstall(targetHomes, null, "Hermes CLI is unavailable");
  }

  const listResult = runHermesCli(["plugins", "list", "--json"], {
    env: options.env,
    hermesCommand: cliCommand,
    hermesHome: rootHome,
    spawnSync: options.spawnSync,
    timeoutMs,
  });
  if (!listResult.ok && listResult.unavailable) {
    return unavailableRemoteInstall(targetHomes, cliCommand, listResult.message);
  }

  const diagnosticsWarnings = [];
  let listedPlugin = null;
  if (!listResult.ok) {
    diagnosticsWarnings.push(`Hermes plugin diagnostics failed: ${listResult.message}`);
  } else {
    const listDiagnostic = parsePluginListEntry(listResult.stdout);
    if (!listDiagnostic.parsed) {
      diagnosticsWarnings.push("Hermes plugin diagnostics returned invalid JSON");
    } else {
      listedPlugin = listDiagnostic.entry;
    }
  }

  const sourcePluginDir = options.sourcePluginDir;
  const sourceHashes = readManagedPluginHashes(sourcePluginDir);
  const targets = [];
  for (let index = 0; index < targetHomes.length; index++) {
    const targetHome = targetHomes[index];
    const pluginDir = path.join(targetHome, "plugins", PLUGIN_ID);
    const classification = classifyManagedPluginDir(pluginDir);
    const target = remoteTargetBase(targetHome, index, classification);
    targets.push(target);

    if (classification === "foreign" || classification === "symlink") {
      target.reason = "hermes-plugin-ownership-conflict";
      target.message = boundedResultText(
        `Hermes plugin ownership conflict at ${describePluginOwnershipConflict(pluginDir)}`
      );
      continue;
    }

    try {
      fs.mkdirSync(path.join(targetHome, "plugins"), { recursive: true, mode: 0o700 });
      fs.mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
      const copied = copyManagedPluginFiles({
        pluginDir,
        sourcePluginDir,
        writeFileSync: options.writeFileSync,
        renameSync: options.renameSync,
        unlinkSync: options.unlinkSync,
      });
      const changed = copied.installed + copied.updated;
      target.action = classification === "absent"
        ? "installed"
        : (changed ? "updated" : "unchanged");

      const hashes = readManagedPluginHashes(pluginDir);
      if (MANAGED_PLUGIN_FILES.some((name) => hashes[name] !== sourceHashes[name])) {
        target.action = "failed";
        target.reason = "hermes-readback-mismatch";
        target.message = "Hermes plugin file readback did not match the staged source";
        continue;
      }
      target.hashes = hashes;

      const enableResult = runHermesCli(["plugins", "enable", PLUGIN_ID], {
        env: options.env,
        hermesCommand: cliCommand,
        hermesHome: targetHome,
        spawnSync: options.spawnSync,
        timeoutMs,
      });
      if (!enableResult.ok) {
        target.action = "failed";
        target.reason = enableResult.unavailable
          ? "hermes-cli-unavailable"
          : "hermes-cli-enable-failed";
        target.message = boundedResultText(`Hermes plugin enable failed: ${enableResult.message}`);
        target.enabled = false;
        continue;
      }

      let configContent;
      try {
        configContent = fs.readFileSync(path.join(targetHome, "config.yaml"), "utf8");
      } catch {
        configContent = "";
      }
      if (!configHasManagedPluginEnabled(configContent)) {
        target.action = "failed";
        target.reason = "hermes-enable-not-verified";
        target.message = "Hermes plugin enable entry was not found in config.yaml";
        target.enabled = false;
        continue;
      }
      target.enabled = true;

      const markerPath = path.join(pluginDir, SSH_SECURE_MARKER_FILENAME);
      try {
        writeManagedFileAtomic(markerPath, SSH_SECURE_MARKER_CONTENT, {
          writeFileSync: options.writeFileSync,
          renameSync: options.renameSync,
          unlinkSync: options.unlinkSync,
        });
        const markerStat = fs.lstatSync(markerPath);
        const markerContent = fs.readFileSync(markerPath, "utf8");
        if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerContent !== SSH_SECURE_MARKER_CONTENT) {
          throw new Error("marker readback mismatch");
        }
        if (process.platform !== "win32" && (markerStat.mode & 0o777) !== 0o600) {
          throw new Error("marker mode mismatch");
        }
      } catch (err) {
        target.action = "failed";
        target.reason = "hermes-marker-write-failed";
        target.message = boundedResultText(`Hermes secure marker write failed: ${err.message}`);
        continue;
      }

      target.marker = true;
      target.status = "ok";
      target.reason = null;
      target.activation = target.action === "installed"
        ? "next-session"
        : (target.action === "updated" ? "restart-required" : "unchanged");
      target.message = target.activation === "restart-required"
        ? "Hermes plugin module replaced; gateway restart required"
        : (target.activation === "next-session"
          ? "Hermes plugin enabled; effective on next session"
          : "Hermes plugin already installed and enabled");
    } catch (err) {
      target.action = "failed";
      target.reason = "hermes-readback-mismatch";
      target.message = boundedResultText(`Hermes plugin installation failed: ${err.message}`);
    }
  }

  if (listedPlugin && listedPlugin.enabled !== true && listedPlugin.status !== "enabled") {
    for (const target of targets) {
      if (target.status !== "error") {
        target.status = "warning";
        target.warnings.push("Hermes CLI diagnostics did not report clawd-on-desk as enabled");
      }
    }
  }
  const gatewayDiagnostic = inspectActiveGatewayUnits(options);
  if (gatewayDiagnostic.warning) diagnosticsWarnings.push(gatewayDiagnostic.warning);
  return remoteAggregate("install", targets, {
    cliCommand,
    activeGatewayUnits: gatewayDiagnostic.units,
    warnings: diagnosticsWarnings,
  });
}

function registerHermesPlugin(options = {}) {
  const hermesHome = resolveHermesHome(options);
  const syncHomes = options.pluginDir ? [hermesHome] : hermesHomesForSync({ ...options, hermesHome });
  const primaryCommand = resolveHermesCommand({ ...options, hermesHome });
  const results = [];
  let firstError = null;
  let installed = 0;
  let updated = 0;
  let skipped = 0;
  let primaryResult = null;

  for (const targetHome of syncHomes) {
    const pluginDir = options.pluginDir && targetHome === hermesHome
      ? options.pluginDir
      : path.join(targetHome, "plugins", PLUGIN_ID);
    const copied = copyManagedPluginFiles({
      baseDir: options.baseDir,
      sourcePluginDir: options.sourcePluginDir,
      pluginDir,
    });
    installed += copied.installed;
    updated += copied.updated;
    skipped += copied.skipped;

    const enableResult = runHermesCli(["plugins", "enable", PLUGIN_ID], {
      ...options,
      hermesHome: targetHome,
      // Profile homes do not contain their own Hermes venv. Reuse the root
      // CLI command and only swap HERMES_HOME so Hermes writes that profile's
      // plugins.enabled allow-list.
      hermesCommand: options.hermesCommand || primaryCommand,
    });
    const enableCommand = enableResult.displayCommand
      || formatHermesCommand(resolveHermesCommand({ ...options, hermesHome: targetHome }) || "hermes", ["plugins", "enable", PLUGIN_ID]);

    const base = {
      ...copied,
      pluginDir,
      hermesHome: targetHome,
      enableCommand,
      reason: null,
      skipped: copied.skipped,
    };

    let entry;
    if (!enableResult.ok) {
      const reason = enableResult.unavailable ? "hermes-cli-unavailable" : "hermes-cli-enable-failed";
      entry = {
        ...base,
        status: "error",
        reason,
        message: enableResult.unavailable
          ? `Hermes plugin files were installed, but Hermes CLI was not found. Run: ${enableCommand}`
          : `Hermes plugin files were installed, but enabling failed: ${enableResult.message}`,
      };
      if (!firstError) firstError = entry;
    } else {
      entry = {
        ...base,
        status: "ok",
        message: copied.installed || copied.updated ? "Hermes plugin installed" : "Hermes plugin already installed",
      };
    }
    results.push(entry);
    if (targetHome === hermesHome) primaryResult = entry;
  }

  const base = {
    ...(primaryResult || {}),
    installed,
    updated,
    skipped,
    hermesHome,
    pluginDir: options.pluginDir || path.join(hermesHome, "plugins", PLUGIN_ID),
    profileResults: results,
  };

  if (firstError) {
    const profileErrors = results.filter((entry) => entry.status === "error");
    if (primaryResult && primaryResult.status === "ok") {
      return {
        ...base,
        status: "ok",
        profileStatus: "partial",
        profileErrorCount: profileErrors.length,
        profileWarning: firstError.message,
        message: installed || updated
          ? "Hermes plugin installed; some profiles failed to enable"
          : "Hermes plugin already installed; some profiles failed to enable",
      };
    }
    return {
      ...base,
      status: "error",
      reason: firstError.reason,
      message: firstError.message,
    };
  }

  if (!options.silent) {
    console.log(`Clawd Hermes plugin -> ${base.pluginDir}`);
    console.log(`  Installed: ${installed}, updated: ${updated}, skipped: ${skipped}`);
    if (results.length > 1) console.log(`  Profiles synced: ${results.length - 1}`);
    console.log("  Enabled: clawd-on-desk");
  }

  return {
    ...base,
    status: "ok",
    message: installed || updated ? "Hermes plugin installed" : "Hermes plugin already installed",
  };
}

function unregisterHermesPlugin(options = {}) {
  const hermesHome = resolveHermesHome(options);
  const targetHomes = options.pluginDir
    ? [hermesHome]
    : hermesHomesForRemoval({ ...options, hermesHome });
  const primaryCommand = resolveHermesCommand({ ...options, hermesHome });
  const warnings = [];
  const profileResults = [];
  let removedCount = 0;
  let firstError = null;

  for (const targetHome of targetHomes) {
    const pluginDir = options.pluginDir && targetHome === hermesHome
      ? options.pluginDir
      : path.join(targetHome, "plugins", PLUGIN_ID);
    const hasConfig = pathExists(path.join(targetHome, "config.yaml"));
    const targetWarnings = [];
    let disableCommand = null;

    // A configless residual profile has no enabled allow-list left to edit.
    // Do not invoke Hermes there: some CLI versions create a fresh config.
    if (targetHome === hermesHome || hasConfig) {
      const disableResult = runHermesCli(["plugins", "disable", PLUGIN_ID], {
        ...options,
        hermesHome: targetHome,
        hermesCommand: options.hermesCommand || primaryCommand,
      });
      disableCommand = disableResult.displayCommand
        || formatHermesCommand(
          resolveHermesCommand({ ...options, hermesHome: targetHome }) || "hermes",
          ["plugins", "disable", PLUGIN_ID]
        );
      if (!disableResult.ok) {
        targetWarnings.push(
          disableResult.unavailable
            ? `Hermes CLI was not found; skipped disable. If Hermes keeps a stale enabled entry, run: ${disableCommand}`
            : `Hermes CLI disable failed: ${disableResult.message}`
        );
      }
    }

    let removed = false;
    let removeError = null;
    try {
      const pluginStat = assertSafeManagedLeaf(pluginDir, "directory");
      if (pluginStat) {
        const rmSync = options.rmSync || fs.rmSync;
        rmSync(pluginDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        removed = true;
        removedCount++;
      }
    } catch (err) {
      removeError = err;
      if (!firstError) firstError = { err, pluginDir, hermesHome: targetHome };
    }

    const entry = {
      status: removeError ? "error" : (targetWarnings.length ? "warning" : "ok"),
      hermesHome: targetHome,
      pluginDir,
      disableCommand,
      removed,
      warnings: targetWarnings,
      message: removeError
        ? `Failed to remove Hermes plugin directory: ${removeError.message}`
        : (targetWarnings.length ? "Hermes plugin removed with warnings" : "Hermes plugin removed"),
    };
    profileResults.push(entry);
    warnings.push(...targetWarnings.map((warning) => `${targetHome}: ${warning}`));
  }

  const pluginDir = options.pluginDir || path.join(hermesHome, "plugins", PLUGIN_ID);
  const base = {
    pluginDir,
    hermesHome,
    removed: removedCount > 0,
    removedCount,
    warnings,
    profileResults,
  };

  if (firstError) {
    return {
      ...base,
      status: "error",
      reason: "hermes-plugin-remove-failed",
      message: `Failed to remove Hermes plugin directory ${firstError.pluginDir}: ${firstError.err.message}`,
    };
  }

  if (!options.silent) {
    console.log(`Clawd Hermes plugin removed -> ${pluginDir}`);
    if (profileResults.length > 1) console.log(`  Profiles cleaned: ${profileResults.length - 1}`);
    for (const warning of warnings) console.warn(`  Warning: ${warning}`);
  }

  return {
    ...base,
    status: "ok",
    message: warnings.length
      ? "Hermes plugin removed with warnings"
      : "Hermes plugin removed",
  };
}

function removeRemotePluginDirectory(pluginDir, options = {}) {
  const unlinkSync = options.unlinkSync || fs.unlinkSync;
  const rmdirSync = options.rmdirSync || fs.rmdirSync;
  for (const name of [...MANAGED_PLUGIN_FILES, SSH_SECURE_MARKER_FILENAME]) {
    const filePath = path.join(pluginDir, name);
    if (lstatIfPresent(filePath)) unlinkSync(filePath);
  }

  const pycachePath = path.join(pluginDir, "__pycache__");
  const pycacheStat = lstatIfPresent(pycachePath);
  if (pycacheStat) {
    for (const entry of fs.readdirSync(pycachePath, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".pyc")) {
        unlinkSync(path.join(pycachePath, entry.name));
      }
    }
    rmdirSync(pycachePath);
  }
  rmdirSync(pluginDir);
}

function unregisterHermesPluginRemote(options = {}) {
  const requestedHomes = Array.isArray(options.targetHomes) ? options.targetHomes : [];
  const rootHome = requestedHomes[0]
    || resolveHermesHome({
      env: options.env,
      hermesHome: options.env && options.env.HERMES_HOME,
    });
  const targetHomes = requestedHomes.length
    ? requestedHomes.slice()
    : hermesHomesForRemoval({ env: options.env, hermesHome: rootHome });
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : 15000;
  const cliCommand = resolveHermesCommand({
    env: options.env,
    hermesCommand: options.hermesCommand,
    hermesHome: rootHome,
    remote: true,
  });
  const targets = [];

  for (let index = 0; index < targetHomes.length; index++) {
    const targetHome = targetHomes[index];
    const pluginDir = path.join(targetHome, "plugins", PLUGIN_ID);
    const classification = classifyManagedPluginDir(pluginDir);
    const target = remoteTargetBase(targetHome, index, classification);
    targets.push(target);

    if (classification === "absent") {
      target.action = "skipped";
      target.status = "ok";
      target.reason = null;
      target.message = "Hermes plugin is not installed";
      continue;
    }
    if (classification === "foreign" || classification === "symlink") {
      target.action = "skipped";
      target.status = "warning";
      target.reason = "hermes-plugin-ownership-conflict";
      target.message = boundedResultText(
        `Hermes plugin ownership conflict at ${describePluginOwnershipConflict(pluginDir)}`
      );
      target.warnings.push(target.message);
      continue;
    }

    const hasConfig = pathExists(path.join(targetHome, "config.yaml"));
    if (hasConfig) {
      const disableResult = runHermesCli(["plugins", "disable", PLUGIN_ID], {
        env: options.env,
        hermesCommand: cliCommand,
        hermesHome: targetHome,
        spawnSync: options.spawnSync,
        timeoutMs,
      });
      if (!disableResult.ok) {
        target.warnings.push(`Hermes plugin disable failed: ${disableResult.message}`);
      } else {
        target.enabled = false;
      }
    }

    try {
      removeRemotePluginDirectory(pluginDir, options);
      target.action = "removed";
      target.status = target.warnings.length ? "warning" : "ok";
      target.reason = null;
      target.message = target.warnings.length
        ? "Hermes plugin removed with warnings"
        : "Hermes plugin removed";
    } catch (err) {
      target.action = "failed";
      target.reason = "hermes-plugin-remove-failed";
      target.message = boundedResultText(`Hermes plugin removal failed: ${err.message}`);
      if (err && (err.code === "ENOTEMPTY" || err.code === "EEXIST")) {
        target.status = "warning";
        target.warnings.push(target.message);
      } else {
        target.status = "error";
      }
    }
  }

  const diagnosticsWarnings = [];
  const gatewayDiagnostic = inspectActiveGatewayUnits(options);
  if (gatewayDiagnostic.warning) diagnosticsWarnings.push(gatewayDiagnostic.warning);
  return remoteAggregate("uninstall", targets, {
    cliCommand,
    activeGatewayUnits: gatewayDiagnostic.units,
    warnings: diagnosticsWarnings,
  });
}

function boundedResultText(value, fallback = "") {
  const text = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return text.slice(0, 1000);
}

function toHermesCliResult(result, operation) {
  const source = result && typeof result === "object" ? result : {};
  const warningCount = Array.isArray(source.warnings)
    ? source.warnings.length
    : (Number.isInteger(source.profileErrorCount) ? source.profileErrorCount : 0);
  const warningText = Array.isArray(source.warnings) && source.warnings.length
    ? source.warnings.join("\n")
    : source.profileWarning;
  const status = source.status === "error"
    ? "error"
    : ((source.profileStatus === "partial" || warningCount > 0) ? "warning" : "ok");
  return {
    schemaVersion: HERMES_RESULT_SCHEMA_VERSION,
    operation,
    status,
    message: boundedResultText(source.message, status === "error" ? "Hermes plugin operation failed" : "Hermes plugin operation completed"),
    reason: boundedResultText(source.reason, "") || null,
    warning: boundedResultText(warningText, "") || null,
    profileWarningCount: warningCount,
    profileErrorCount: Number.isInteger(source.profileErrorCount) ? source.profileErrorCount : 0,
    ...(source.remote ? {
      remote: true,
      cliCommand: typeof source.cliCommand === "string" ? source.cliCommand : null,
      targets: Array.isArray(source.targets) ? source.targets : [],
      activeGatewayUnits: Array.isArray(source.activeGatewayUnits) ? source.activeGatewayUnits : null,
    } : {}),
  };
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_PLUGIN_DIR,
  HERMES_RESULT_SCHEMA_VERSION,
  HERMES_RESULT_SENTINEL,
  MANAGED_PLUGIN_FILES,
  PLUGIN_ID,
  SSH_SECURE_MARKER_CONTENT,
  SSH_SECURE_MARKER_FILENAME,
  classifyManagedPluginDir,
  configHasManagedPluginEnabled,
  copyManagedPluginFiles,
  discoverHermesManagedPluginHomes,
  discoverHermesProfileHomes,
  formatHermesCommand,
  hermesHomesForRemoval,
  hermesHomesForSync,
  isHermesInstalled,
  parseHermesCliArgs,
  registerHermesPlugin,
  registerHermesPluginRemote,
  resolveHermesCommand,
  resolveHermesHome,
  resolvePluginSourceDir,
  runHermesCli,
  toHermesCliResult,
  unregisterHermesPlugin,
  unregisterHermesPluginRemote,
  writeManagedFileAtomic,
};

if (require.main === module) {
  const parsed = parseHermesCliArgs(process.argv.slice(2));
  const uninstall = parsed.uninstall;
  const jsonMode = parsed.jsonMode || parsed.remote;
  let result;
  if (parsed.errors.length) {
    result = {
      status: "error",
      reason: "invalid-arguments",
      message: parsed.errors.join("; "),
      ...(parsed.remote ? {
        remote: true,
        cliCommand: null,
        targets: [],
        activeGatewayUnits: null,
      } : {}),
    };
  } else {
    try {
      if (parsed.remote) {
        const remoteOptions = {
          env: process.env,
          targetHomes: parsed.targetHomes,
          timeoutMs: parsed.cliTimeoutMs || 15000,
        };
        result = uninstall
          ? unregisterHermesPluginRemote(remoteOptions)
          : registerHermesPluginRemote({ ...remoteOptions, sourcePluginDir: parsed.sourceDir });
      } else {
        result = uninstall
          ? unregisterHermesPlugin({ silent: jsonMode })
          : registerHermesPlugin({ silent: jsonMode });
      }
    } catch (err) {
      result = {
        status: "error",
        reason: "hermes-plugin-operation-threw",
        message: err && err.message ? err.message : "Hermes plugin operation failed",
        ...(parsed.remote ? {
          remote: true,
          cliCommand: null,
          targets: [],
          activeGatewayUnits: null,
        } : {}),
      };
    }
  }
  if (jsonMode) {
    console.log(`${HERMES_RESULT_SENTINEL}${JSON.stringify(toHermesCliResult(result, uninstall ? "uninstall" : "install"))}`);
  }
  if (result && result.status === "error") {
    if (!jsonMode) console.error(result.message || "Hermes plugin install failed");
    process.exitCode = 1;
  }
}
