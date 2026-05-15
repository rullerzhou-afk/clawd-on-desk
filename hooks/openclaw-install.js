#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const { asarUnpackedPath, writeJsonAtomic } = require("./json-utils");

const PLUGIN_ID = "clawd-on-desk";
const PLUGIN_DIR_NAME = "openclaw-plugin";
const DEFAULT_STATE_DIR = path.join(os.homedir(), ".openclaw");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_STATE_DIR, "openclaw.json");

function resolvePluginDir(baseDir) {
  const dir = path.resolve(baseDir || __dirname, PLUGIN_DIR_NAME).replace(/\\/g, "/");
  return asarUnpackedPath(dir);
}

function resolveOpenClawPaths(options = {}) {
  const env = options.env || process.env;
  const stateDir = options.stateDir || env.OPENCLAW_STATE_DIR || DEFAULT_STATE_DIR;
  const configPath = options.configPath || env.OPENCLAW_CONFIG_PATH || path.join(stateDir, "openclaw.json");
  return { stateDir, configPath };
}

function fileExists(filePath, fsImpl = fs) {
  try {
    return fsImpl.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function dirExists(dirPath, fsImpl = fs) {
  try {
    return fsImpl.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function commandExists(command, args, options = {}) {
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  try {
    execFileSync(command, args, {
      encoding: "utf8",
      timeout: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function hasOpenClawCommand(options = {}) {
  if (typeof options.openclawCommandAvailable === "boolean") return options.openclawCommandAvailable;
  if (typeof options.openclawCommandAvailable === "function") return !!options.openclawCommandAvailable();

  const platform = options.platform || process.platform;
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  if (platform === "win32") {
    return commandExists("where", ["openclaw"], { execFileSync });
  }
  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    if (commandExists(shell, ["-lic", "command -v openclaw"], { execFileSync })) return true;
  }
  return commandExists("sh", ["-lc", "command -v openclaw"], { execFileSync });
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAbsoluteAnyPlatform(value) {
  if (typeof value !== "string" || !value) return false;
  const normalized = value.replace(/\\/g, "/");
  return path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized);
}

function hasIncludeDirective(value) {
  if (!isObject(value) && !Array.isArray(value)) return false;
  if (Array.isArray(value)) return value.some(hasIncludeDirective);

  for (const [key, entry] of Object.entries(value)) {
    if (key === "$include") return true;
    if (key === "include" && Array.isArray(entry)) return true;
    if (hasIncludeDirective(entry)) return true;
  }
  return false;
}

function normalizePluginPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function findPluginPathIndex(paths, pluginDir) {
  if (!Array.isArray(paths)) return -1;
  const normalizedPluginDir = normalizePluginPath(pluginDir);
  for (let i = 0; i < paths.length; i++) {
    const entry = paths[i];
    if (typeof entry !== "string") continue;
    const normalized = normalizePluginPath(entry);
    if (normalized === normalizedPluginDir) return i;
    if (isAbsoluteAnyPlatform(normalized) && path.posix.basename(normalized) === PLUGIN_DIR_NAME) {
      return i;
    }
  }
  return -1;
}

function installViaCli(options = {}) {
  const spawnSync = options.spawnSync || childProcess.spawnSync;
  const command = options.openclawCommand || "openclaw";
  const pluginDir = options.pluginDir || resolvePluginDir();
  const env = options.env || process.env;
  const result = spawnSync(command, ["plugins", "install", "--link", pluginDir], {
    encoding: "utf8",
    env,
    windowsHide: true,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (result.status === 0) {
    return {
      installed: true,
      skipped: false,
      updated: true,
      usedCli: true,
      pluginDir,
      message: output,
    };
  }
  if (/already\s+installed/i.test(output)) {
    return {
      installed: true,
      skipped: true,
      updated: false,
      usedCli: true,
      reason: "already-installed",
      pluginDir,
      message: output,
    };
  }
  return {
    installed: false,
    skipped: true,
    updated: false,
    usedCli: true,
    reason: "cli-failed",
    pluginDir,
    message: output || `openclaw exited with status ${result.status}`,
  };
}

function withCliStatus(result, configPath) {
  const ok = result && (result.installed || result.removed || result.reason === "already-installed");
  return { status: ok ? "ok" : "error", configPath, ...result };
}

function uninstallViaCli(options = {}) {
  const spawnSync = options.spawnSync || childProcess.spawnSync;
  const command = options.openclawCommand || "openclaw";
  const env = options.env || process.env;
  const result = spawnSync(command, ["plugins", "uninstall", PLUGIN_ID, "--force"], {
    encoding: "utf8",
    env,
    windowsHide: true,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (result.status === 0 || /not\s+found|not\s+installed/i.test(output)) {
    return { removed: result.status === 0, skipped: result.status !== 0, usedCli: true, message: output };
  }
  return { removed: false, skipped: true, usedCli: true, reason: "cli-failed", message: output };
}

function ensureOpenClawConfigLinked(config, pluginDir) {
  if (!isObject(config)) return { reason: "config-not-object" };
  if (hasIncludeDirective(config)) return { reason: "config-has-include" };

  if (config.plugins === undefined) config.plugins = {};
  if (!isObject(config.plugins)) return { reason: "plugins-not-object" };

  if (config.plugins.load === undefined) config.plugins.load = {};
  if (!isObject(config.plugins.load)) return { reason: "plugins-load-not-object" };
  if (config.plugins.load.paths === undefined) config.plugins.load.paths = [];
  if (!Array.isArray(config.plugins.load.paths)) return { reason: "plugins-load-paths-not-array" };

  if (config.plugins.entries === undefined) config.plugins.entries = {};
  if (!isObject(config.plugins.entries)) return { reason: "plugins-entries-not-object" };
  const currentEntry = isObject(config.plugins.entries[PLUGIN_ID]) ? config.plugins.entries[PLUGIN_ID] : {};

  let updated = false;
  const index = findPluginPathIndex(config.plugins.load.paths, pluginDir);
  if (index === -1) {
    config.plugins.load.paths.push(pluginDir);
    updated = true;
  } else if (config.plugins.load.paths[index] !== pluginDir) {
    config.plugins.load.paths[index] = pluginDir;
    updated = true;
  }

  const nextEntry = {
    ...currentEntry,
    enabled: true,
    hooks: {
      ...(isObject(currentEntry.hooks) ? currentEntry.hooks : {}),
      allowConversationAccess: false,
    },
  };
  if (JSON.stringify(config.plugins.entries[PLUGIN_ID]) !== JSON.stringify(nextEntry)) {
    config.plugins.entries[PLUGIN_ID] = nextEntry;
    updated = true;
  }

  return { updated };
}

function registerOpenClawPlugin(options = {}) {
  const fsImpl = options.fs || fs;
  const pluginDir = options.pluginDir || resolvePluginDir();
  const { stateDir, configPath } = resolveOpenClawPaths(options);
  const stateDirExists = dirExists(stateDir, fsImpl);
  const configFileExists = fileExists(configPath, fsImpl);
  let commandAvailable;
  const getCommandAvailable = () => {
    if (commandAvailable === undefined) commandAvailable = hasOpenClawCommand(options);
    return commandAvailable;
  };

  if (!stateDirExists && !configFileExists && !getCommandAvailable()) {
    if (!options.silent) console.log("Clawd: OpenClaw not found - skipping OpenClaw plugin registration");
    return {
      installed: false,
      skipped: true,
      updated: false,
      reason: "openclaw-not-found",
      configPath,
      pluginDir,
    };
  }

  if (!configFileExists) {
    if (options.useCliFallback && getCommandAvailable()) {
      return withCliStatus(installViaCli({ ...options, pluginDir }), configPath);
    }
    if (!options.silent) {
      console.log(`Clawd: ${configPath} missing - skipping OpenClaw plugin registration`);
    }
    return {
      installed: false,
      skipped: true,
      updated: false,
      reason: "openclaw-config-missing",
      configPath,
      pluginDir,
    };
  }

  let config;
  try {
    config = JSON.parse(fsImpl.readFileSync(configPath, "utf8"));
  } catch (err) {
    if (options.useCliFallback && getCommandAvailable()) {
      return withCliStatus(installViaCli({ ...options, pluginDir }), configPath);
    }
    return {
      installed: false,
      skipped: true,
      updated: false,
      reason: "openclaw-config-not-strict-json",
      configPath,
      pluginDir,
      message: err && err.message,
    };
  }

  const linked = ensureOpenClawConfigLinked(config, pluginDir);
  if (linked.reason) {
    if (options.useCliFallback && getCommandAvailable()) {
      return withCliStatus(installViaCli({ ...options, pluginDir }), configPath);
    }
    return {
      installed: false,
      skipped: true,
      updated: false,
      reason: linked.reason,
      configPath,
      pluginDir,
    };
  }

  if (linked.updated) writeJsonAtomic(configPath, config);
  if (!options.silent) {
    console.log(`Clawd OpenClaw plugin -> ${configPath}`);
    console.log(linked.updated ? `  Registered: ${pluginDir}` : `  Already registered: ${pluginDir}`);
  }
  return {
    installed: true,
    skipped: false,
    updated: !!linked.updated,
    configPath,
    pluginDir,
  };
}

function unregisterOpenClawPlugin(options = {}) {
  const fsImpl = options.fs || fs;
  const pluginDir = options.pluginDir || resolvePluginDir();
  const { configPath } = resolveOpenClawPaths(options);
  let commandAvailable;
  const getCommandAvailable = () => {
    if (commandAvailable === undefined) commandAvailable = hasOpenClawCommand(options);
    return commandAvailable;
  };

  if (!fileExists(configPath, fsImpl)) {
    if (options.useCliFallback && getCommandAvailable()) return uninstallViaCli(options);
    return { removed: false, skipped: true, reason: "openclaw-config-missing", configPath, pluginDir };
  }

  let config;
  try {
    config = JSON.parse(fsImpl.readFileSync(configPath, "utf8"));
  } catch {
    if (options.useCliFallback && getCommandAvailable()) return uninstallViaCli(options);
    return { removed: false, skipped: true, reason: "openclaw-config-not-strict-json", configPath, pluginDir };
  }

  if (!isObject(config) || hasIncludeDirective(config)) {
    if (options.useCliFallback && getCommandAvailable()) return uninstallViaCli(options);
    return { removed: false, skipped: true, reason: "config-has-include", configPath, pluginDir };
  }

  let updated = false;
  const paths = config.plugins && config.plugins.load && config.plugins.load.paths;
  if (Array.isArray(paths)) {
    const index = findPluginPathIndex(paths, pluginDir);
    if (index !== -1) {
      paths.splice(index, 1);
      updated = true;
    }
  }
  if (config.plugins && config.plugins.entries && config.plugins.entries[PLUGIN_ID]) {
    delete config.plugins.entries[PLUGIN_ID];
    updated = true;
  }
  if (updated) writeJsonAtomic(configPath, config);
  return { removed: updated, skipped: !updated, configPath, pluginDir };
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  DEFAULT_STATE_DIR,
  PLUGIN_DIR_NAME,
  PLUGIN_ID,
  ensureOpenClawConfigLinked,
  hasIncludeDirective,
  hasOpenClawCommand,
  registerOpenClawPlugin,
  resolveOpenClawPaths,
  resolvePluginDir,
  unregisterOpenClawPlugin,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) {
      unregisterOpenClawPlugin({ useCliFallback: true });
    } else {
      registerOpenClawPlugin({ useCliFallback: true });
    }
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}
