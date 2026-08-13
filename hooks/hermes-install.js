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
const { spawnSync } = require("child_process");
const { asarUnpackedPath } = require("./json-utils");

const PLUGIN_ID = "clawd-on-desk";
const PLUGIN_SOURCE_DIR_NAME = "hermes-plugin";
const MANAGED_PLUGIN_FILES = ["plugin.yaml", "__init__.py"];
const HERMES_RESULT_SCHEMA_VERSION = 1;
const HERMES_RESULT_SENTINEL = "CLAWD_HERMES_RESULT_V1=";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".hermes");
const DEFAULT_PLUGIN_DIR = path.join(DEFAULT_PARENT_DIR, "plugins", PLUGIN_ID);
let _atomicWriteCounter = 0;

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
  };
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_PLUGIN_DIR,
  HERMES_RESULT_SCHEMA_VERSION,
  HERMES_RESULT_SENTINEL,
  MANAGED_PLUGIN_FILES,
  PLUGIN_ID,
  copyManagedPluginFiles,
  discoverHermesManagedPluginHomes,
  discoverHermesProfileHomes,
  formatHermesCommand,
  hermesHomesForRemoval,
  hermesHomesForSync,
  isHermesInstalled,
  registerHermesPlugin,
  resolveHermesCommand,
  resolveHermesHome,
  resolvePluginSourceDir,
  runHermesCli,
  toHermesCliResult,
  unregisterHermesPlugin,
  writeManagedFileAtomic,
};

if (require.main === module) {
  const uninstall = process.argv.includes("--uninstall");
  const jsonMode = process.argv.includes("--json");
  let result;
  try {
    result = uninstall
      ? unregisterHermesPlugin({ silent: jsonMode })
      : registerHermesPlugin({ silent: jsonMode });
  } catch (err) {
    result = {
      status: "error",
      reason: "hermes-plugin-operation-threw",
      message: err && err.message ? err.message : "Hermes plugin operation failed",
    };
  }
  if (jsonMode) {
    console.log(`${HERMES_RESULT_SENTINEL}${JSON.stringify(toHermesCliResult(result, uninstall ? "uninstall" : "install"))}`);
  }
  if (result && result.status === "error") {
    if (!jsonMode) console.error(result.message || "Hermes plugin install failed");
    process.exitCode = 1;
  }
}
