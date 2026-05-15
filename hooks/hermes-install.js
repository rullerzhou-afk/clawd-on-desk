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
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".hermes");
const DEFAULT_PLUGIN_DIR = path.join(DEFAULT_PARENT_DIR, "plugins", PLUGIN_ID);

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

function copyManagedPluginFiles(options = {}) {
  const sourceDir = options.sourcePluginDir || resolvePluginSourceDir(options.baseDir);
  const pluginDir = options.pluginDir;
  if (!pluginDir) throw new Error("copyManagedPluginFiles requires pluginDir");

  fs.mkdirSync(pluginDir, { recursive: true });

  let installed = 0;
  let updated = 0;
  let skipped = 0;
  for (const file of MANAGED_PLUGIN_FILES) {
    const sourcePath = path.join(sourceDir, file);
    const destPath = path.join(pluginDir, file);
    const source = fs.readFileSync(sourcePath);
    let current = null;
    try {
      current = fs.readFileSync(destPath);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    if (!current) {
      fs.writeFileSync(destPath, source);
      installed++;
      continue;
    }
    if (!Buffer.compare(current, source)) {
      skipped++;
      continue;
    }
    fs.writeFileSync(destPath, source);
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
  const pluginDir = options.pluginDir || path.join(hermesHome, "plugins", PLUGIN_ID);
  const copied = copyManagedPluginFiles({
    baseDir: options.baseDir,
    sourcePluginDir: options.sourcePluginDir,
    pluginDir,
  });

  const enableResult = runHermesCli(["plugins", "enable", PLUGIN_ID], {
    ...options,
    hermesHome,
  });
  const enableCommand = enableResult.displayCommand
    || formatHermesCommand(resolveHermesCommand({ ...options, hermesHome }) || "hermes", ["plugins", "enable", PLUGIN_ID]);

  const base = {
    ...copied,
    pluginDir,
    hermesHome,
    enableCommand,
    reason: null,
    skipped: copied.skipped,
  };

  if (!enableResult.ok) {
    const reason = enableResult.unavailable ? "hermes-cli-unavailable" : "hermes-cli-enable-failed";
    return {
      ...base,
      status: "error",
      reason,
      message: enableResult.unavailable
        ? `Hermes plugin files were installed, but Hermes CLI was not found. Run: ${enableCommand}`
        : `Hermes plugin files were installed, but enabling failed: ${enableResult.message}`,
    };
  }

  if (!options.silent) {
    console.log(`Clawd Hermes plugin -> ${pluginDir}`);
    console.log(`  Installed: ${copied.installed}, updated: ${copied.updated}, skipped: ${copied.skipped}`);
    console.log("  Enabled: clawd-on-desk");
  }

  return {
    ...base,
    status: "ok",
    message: copied.installed || copied.updated ? "Hermes plugin installed" : "Hermes plugin already installed",
  };
}

function unregisterHermesPlugin(options = {}) {
  const hermesHome = resolveHermesHome(options);
  const pluginDir = options.pluginDir || path.join(hermesHome, "plugins", PLUGIN_ID);
  const warnings = [];
  const disableResult = runHermesCli(["plugins", "disable", PLUGIN_ID], {
    ...options,
    hermesHome,
  });
  const disableCommand = disableResult.displayCommand
    || formatHermesCommand(resolveHermesCommand({ ...options, hermesHome }) || "hermes", ["plugins", "disable", PLUGIN_ID]);

  if (!disableResult.ok) {
    warnings.push(
      disableResult.unavailable
        ? `Hermes CLI was not found; skipped disable. If Hermes keeps a stale enabled entry, run: ${disableCommand}`
        : `Hermes CLI disable failed: ${disableResult.message}`
    );
  }

  let removed = false;
  try {
    if (fs.existsSync(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed = true;
    }
  } catch (err) {
    return {
      status: "error",
      pluginDir,
      hermesHome,
      disableCommand,
      removed,
      warnings,
      message: `Failed to remove Hermes plugin directory: ${err.message}`,
    };
  }

  if (!options.silent) {
    console.log(`Clawd Hermes plugin removed -> ${pluginDir}`);
    for (const warning of warnings) console.warn(`  Warning: ${warning}`);
  }

  return {
    status: "ok",
    pluginDir,
    hermesHome,
    disableCommand,
    removed,
    warnings,
    message: warnings.length
      ? "Hermes plugin removed with warnings"
      : "Hermes plugin removed",
  };
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_PLUGIN_DIR,
  MANAGED_PLUGIN_FILES,
  PLUGIN_ID,
  copyManagedPluginFiles,
  formatHermesCommand,
  isHermesInstalled,
  registerHermesPlugin,
  resolveHermesCommand,
  resolveHermesHome,
  resolvePluginSourceDir,
  runHermesCli,
  unregisterHermesPlugin,
};

if (require.main === module) {
  const uninstall = process.argv.includes("--uninstall");
  const result = uninstall ? unregisterHermesPlugin({}) : registerHermesPlugin({});
  if (result && result.status === "error") {
    console.error(result.message || "Hermes plugin install failed");
    process.exit(1);
  }
}
