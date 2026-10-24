#!/usr/bin/env node
"use strict";

// Installer for the Clawd plugin inside the AutoClaw desktop app's embedded
// OpenClaw gateway (state dir ~/.openclaw-autoclaw). AutoClaw ships no CLI,
// and its GatewayManager actively deletes `plugins.entries` keys it does not
// recognize on every remote-config refresh ("Removing unknown plugin entry"),
// while keeping `plugins.load.paths` untouched — so registering through a
// linked load path leaves the plugin discovered-but-disabled forever.
//
// The supported shape (real-machine verified, AutoClaw 1.20.0): materialize a
// self-contained copy of the plugin into ~/.openclaw-autoclaw/extensions/<EXTENSION_DIR_NAME>/
// — AutoClaw scans that dir as the "user" extension root and treats both the
// dir name and the manifest id as known — plus `plugins.entries[PLUGIN_ID]`
// with enabled: true. The copy carries a .clawd-managed.json ownership marker:
// install replaces only a missing/empty/verifiable-owned directory and refuses
// to touch a foreign one; uninstall removes only the marker-verified directory.
// Registration never creates the state dir or the app-authored config file —
// a missing config means AutoClaw has not completed a first launch yet.
//
// The embedded gateway reads its plugin set only at startup, so callers should
// surface "restart AutoClaw" after a file-level update.
// See docs/investigations/autoclaw-e1-evidence.md.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { writeJsonAtomic, writeJsonAtomicWithBackup } = require("./json-utils");

const PLUGIN_ID = "clawd-on-desk";
const PLUGIN_DIR_NAME = "autoclaw-plugin";
const EXTENSION_DIR_NAME = "clawd-on-desk";
const MARKER_FILE = ".clawd-managed.json";
// Only the files Clawd authors; the marker is managed separately and nothing
// else inside the owned directory is touched.
const PLUGIN_FILES = ["index.js", "package.json", "openclaw.plugin.json"];
const STAGING_PREFIX = ".clawd-autoclaw-staging-";
const REMOVING_PREFIX = ".clawd-autoclaw-removing-";
const DEFAULT_STATE_DIR = path.join(os.homedir(), ".openclaw-autoclaw");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_STATE_DIR, "openclaw.json");
const DEFAULT_EXTENSIONS_DIR = path.join(DEFAULT_STATE_DIR, "extensions");

function resolvePluginDir(baseDir) {
  return path.resolve(baseDir || __dirname, PLUGIN_DIR_NAME).replace(/\\/g, "/");
}

function resolveAutoClawPaths(options = {}) {
  const env = options.env || process.env;
  const stateDir = options.stateDir || env.AUTOCLAW_STATE_DIR || DEFAULT_STATE_DIR;
  const configPath = options.configPath || env.AUTOCLAW_CONFIG_PATH || path.join(stateDir, "openclaw.json");
  const extensionsDir = options.extensionsDir || env.AUTOCLAW_EXTENSIONS_DIR || path.join(stateDir, "extensions");
  return { stateDir, configPath, extensionsDir, extensionDir: path.join(extensionsDir, EXTENSION_DIR_NAME) };
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

function isManagedPluginPath(value, pluginDir = resolvePluginDir()) {
  return findPluginPathIndex([value], pluginDir) === 0;
}

// Legacy registration wrote the linked source dir into plugins.load.paths.
// The GatewayManager never removes unknown load paths, so old registrations
// linger; strip only entries whose basename is our unique dir name.
function removeLegacyLoadPath(config) {
  const paths = config.plugins && config.plugins.load && config.plugins.load.paths;
  if (!Array.isArray(paths)) return false;
  const index = findPluginPathIndex(paths);
  if (index === -1) return false;
  paths.splice(index, 1);
  return true;
}

function removePluginEntry(config) {
  if (!isObject(config.plugins) || !isObject(config.plugins.entries)) return false;
  if (!config.plugins.entries[PLUGIN_ID]) return false;
  delete config.plugins.entries[PLUGIN_ID];
  return true;
}

function ensurePluginEntry(config) {
  if (config.plugins === undefined) config.plugins = {};
  if (!isObject(config.plugins)) return { reason: "plugins-not-object" };
  if (config.plugins.entries === undefined) config.plugins.entries = {};
  if (!isObject(config.plugins.entries)) return { reason: "plugins-entries-not-object" };

  const currentEntry = isObject(config.plugins.entries[PLUGIN_ID]) ? config.plugins.entries[PLUGIN_ID] : {};
  const nextEntry = {
    ...currentEntry,
    enabled: true,
    hooks: {
      ...(isObject(currentEntry.hooks) ? currentEntry.hooks : {}),
      allowConversationAccess: false,
    },
  };
  let updated = false;
  if (JSON.stringify(config.plugins.entries[PLUGIN_ID]) !== JSON.stringify(nextEntry)) {
    config.plugins.entries[PLUGIN_ID] = nextEntry;
    updated = true;
  }
  if (removeLegacyLoadPath(config)) updated = true;
  return { updated };
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function readSourceFiles(pluginDir, fsImpl) {
  const files = {};
  for (const name of PLUGIN_FILES) {
    const filePath = path.join(pluginDir, name);
    try {
      files[name] = fsImpl.readFileSync(filePath);
    } catch (err) {
      return { reason: "plugin-source-missing", missing: name, message: err && err.message };
    }
  }
  return { files };
}

// Classifies the extension directory without mutating anything:
//   { state: "missing" | "empty" | "owned" | "owned-stale" | "foreign" }
function classifyExtensionDir(extensionDir, sourceFiles, fsImpl) {
  if (!dirExists(extensionDir, fsImpl)) return { state: "missing" };
  const names = fsImpl.readdirSync(extensionDir);
  if (!names.length) return { state: "empty" };

  const markerPath = path.join(extensionDir, MARKER_FILE);
  let marker = null;
  try {
    marker = JSON.parse(fsImpl.readFileSync(markerPath, "utf8"));
  } catch {
    marker = null;
  }
  const owned = !!marker
    && marker.owner === "clawd-on-desk"
    && marker.pluginId === PLUGIN_ID
    && marker.agentId === "autoclaw";
  if (!owned) return { state: "foreign" };

  const stale = PLUGIN_FILES.some((name) => {
    const onDisk = sourceFiles.files ? sourceFiles.files[name] : undefined;
    const current = (() => {
      try { return fsImpl.readFileSync(path.join(extensionDir, name)); } catch { return null; }
    })();
    if (!onDisk || !current) return true;
    return !onDisk.equals(current);
  });
  return { state: stale ? "owned-stale" : "owned" };
}

// Replaces the extension directory with a fresh copy of the source files:
// staging lives outside the scanned extensions/ dir (an in-flight manifest
// there could be picked up as a plugin), the old dir is moved out of the way
// first, and the new one is renamed into place before the old copy is deleted.
function materializeExtensionDir(extensionDir, stateDir, sourceFiles, pluginDir, fsImpl) {
  fsImpl.mkdirSync(stateDir, { recursive: true });
  const stagingDir = path.join(stateDir, `${STAGING_PREFIX}${process.pid}-${Date.now()}`);
  fsImpl.mkdirSync(stagingDir, { recursive: true });
  const filesSha256 = {};
  for (const name of PLUGIN_FILES) {
    fsImpl.writeFileSync(path.join(stagingDir, name), sourceFiles.files[name]);
    filesSha256[name] = sha256Buffer(sourceFiles.files[name]);
  }
  fsImpl.writeFileSync(path.join(stagingDir, MARKER_FILE), `${JSON.stringify({
    owner: "clawd-on-desk",
    pluginId: PLUGIN_ID,
    agentId: "autoclaw",
    sourceDir: normalizePluginPath(pluginDir),
    filesSha256,
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");

  const removingDir = path.join(stateDir, `${REMOVING_PREFIX}${process.pid}-${Date.now()}`);
  let replaced = false;
  if (dirExists(extensionDir, fsImpl)) {
    fsImpl.renameSync(extensionDir, removingDir);
    replaced = true;
  }
  try {
    // extensions/ is OpenClaw's standard user extension root; AutoClaw scans
    // it but does not create it until a user plugin exists.
    fsImpl.mkdirSync(path.dirname(extensionDir), { recursive: true });
    fsImpl.renameSync(stagingDir, extensionDir);
  } catch (err) {
    if (replaced) fsImpl.renameSync(removingDir, extensionDir);
    try { fsImpl.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    return { reason: "extension-materialize-failed", message: err && err.message };
  }
  if (replaced) {
    try { fsImpl.rmSync(removingDir, { recursive: true, force: true }); } catch {}
  }
  return { filesSha256 };
}

function registerAutoClawPlugin(options = {}) {
  const fsImpl = options.fs || fs;
  const pluginDir = options.pluginDir || resolvePluginDir();
  const { stateDir, configPath, extensionsDir, extensionDir } = resolveAutoClawPaths(options);
  const configFileExists = fileExists(configPath, fsImpl);

  // The embedded gateway's config is app-authored. Never bootstrap it: a
  // plugins-only file written before AutoClaw's first launch could be
  // clobbered or misread by the app's own config generation.
  if (!configFileExists) {
    if (!options.silent) console.log("Clawd: AutoClaw not found - skipping AutoClaw plugin registration");
    return {
      installed: false,
      skipped: true,
      updated: false,
      reason: "autoclaw-not-found",
      configPath,
      extensionDir,
      pluginDir,
    };
  }

  let config;
  try {
    config = JSON.parse(fsImpl.readFileSync(configPath, "utf8"));
  } catch (err) {
    return {
      installed: false,
      skipped: true,
      updated: false,
      reason: "autoclaw-config-not-strict-json",
      configPath,
      extensionDir,
      pluginDir,
      message: err && err.message,
    };
  }
  if (!isObject(config) || hasIncludeDirective(config)) {
    return {
      installed: false,
      skipped: true,
      updated: false,
      reason: "config-has-include",
      configPath,
      extensionDir,
      pluginDir,
    };
  }

  const sourceFiles = readSourceFiles(pluginDir, fsImpl);
  if (sourceFiles.reason) {
    return {
      installed: false,
      skipped: true,
      updated: false,
      reason: sourceFiles.reason,
      configPath,
      extensionDir,
      pluginDir,
      message: sourceFiles.message,
    };
  }

  const classified = classifyExtensionDir(extensionDir, sourceFiles, fsImpl);
  if (classified.state === "foreign") {
    return {
      installed: false,
      skipped: true,
      updated: false,
      reason: "extension-dir-foreign",
      configPath,
      extensionDir,
      pluginDir,
      message: `${extensionDir} exists without a Clawd ownership marker`,
    };
  }

  let filesUpdated = false;
  if (classified.state === "missing" || classified.state === "empty" || classified.state === "owned-stale") {
    const materialized = materializeExtensionDir(extensionDir, stateDir, sourceFiles, pluginDir, fsImpl);
    if (materialized.reason) {
      return {
        installed: false,
        skipped: true,
        updated: false,
        reason: materialized.reason,
        configPath,
        extensionDir,
        pluginDir,
        message: materialized.message,
      };
    }
    filesUpdated = true;
  }

  const linked = ensurePluginEntry(config);
  if (linked.reason) {
    return {
      installed: false,
      skipped: true,
      updated: false,
      reason: linked.reason,
      configPath,
      extensionDir,
      pluginDir,
    };
  }

  const configUpdated = linked.updated;
  if (configUpdated) writeJsonAtomic(configPath, config);

  if (!options.silent) {
    console.log(`Clawd AutoClaw plugin -> ${extensionDir}`);
    console.log(filesUpdated ? "  Plugin files materialized" : "  Plugin files already current");
    console.log(configUpdated ? `  Registered in ${configPath}` : `  Registration in ${configPath} already current`);
    if (filesUpdated) console.log("  Restart AutoClaw so the embedded gateway loads the updated files");
  }
  return {
    installed: true,
    skipped: false,
    updated: filesUpdated || configUpdated,
    filesUpdated,
    restartRequired: filesUpdated,
    configPath,
    extensionDir,
    pluginDir,
  };
}

// Read-only classification for Doctor: same shapes registerAutoClawPlugin
// would act on, plus per-file currency against the current source.
function inspectAutoClawExtension(options = {}) {
  const fsImpl = options.fs || fs;
  const pluginDir = options.pluginDir || resolvePluginDir();
  const { extensionDir } = resolveAutoClawPaths(options);
  const sourceFiles = readSourceFiles(pluginDir, fsImpl);
  if (sourceFiles.reason) {
    return { ok: false, reason: sourceFiles.reason, extensionDir, pluginDir };
  }
  const classified = classifyExtensionDir(extensionDir, sourceFiles, fsImpl);
  return { ok: true, state: classified.state, extensionDir, pluginDir };
}

function unregisterAutoClawPlugin(options = {}) {
  const fsImpl = options.fs || fs;
  const pluginDir = options.pluginDir || resolvePluginDir();
  const { stateDir, configPath, extensionDir } = resolveAutoClawPaths(options);

  let configChanged = false;
  let backupPath = null;
  if (fileExists(configPath, fsImpl)) {
    let config = null;
    try {
      config = JSON.parse(fsImpl.readFileSync(configPath, "utf8"));
    } catch {
      config = null;
    }
    if (isObject(config) && !hasIncludeDirective(config)) {
      const entryRemoved = removePluginEntry(config);
      const pathRemoved = removeLegacyLoadPath(config);
      if (entryRemoved || pathRemoved) {
        backupPath = writeJsonAtomicWithBackup(configPath, config, options);
        configChanged = true;
      }
    }
  }

  let dirRemoved = false;
  let warning = null;
  if (dirExists(extensionDir, fsImpl)) {
    const names = fsImpl.readdirSync(extensionDir);
    let marker = null;
    try {
      marker = JSON.parse(fsImpl.readFileSync(path.join(extensionDir, MARKER_FILE), "utf8"));
    } catch {
      marker = null;
    }
    const owned = !!marker
      && marker.owner === "clawd-on-desk"
      && marker.pluginId === PLUGIN_ID
      && marker.agentId === "autoclaw";
    if (!owned) {
      warning = `left foreign ${extensionDir} untouched (no Clawd ownership marker)`;
    } else if (!names.length) {
      fsImpl.rmdirSync(extensionDir);
      dirRemoved = true;
    } else {
      // Move out of the scanned extensions/ dir before deleting so the
      // gateway never observes a half-removed plugin.
      fsImpl.mkdirSync(stateDir, { recursive: true });
      const removingDir = path.join(stateDir, `${REMOVING_PREFIX}${process.pid}-${Date.now()}`);
      fsImpl.renameSync(extensionDir, removingDir);
      try {
        fsImpl.rmSync(removingDir, { recursive: true, force: true });
        dirRemoved = true;
      } catch (err) {
        warning = `moved the owned plugin out of extensions/ but could not delete ${removingDir}: ${err && err.message}`;
        dirRemoved = true;
      }
    }
  }

  const removed = configChanged || dirRemoved;
  const result = { removed, skipped: !removed, configPath, extensionDir, pluginDir };
  if (options.backup === true) result.backupPath = backupPath;
  if (warning) result.warning = warning;
  return result;
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  DEFAULT_EXTENSIONS_DIR,
  DEFAULT_STATE_DIR,
  EXTENSION_DIR_NAME,
  MARKER_FILE,
  PLUGIN_DIR_NAME,
  PLUGIN_FILES,
  PLUGIN_ID,
  REMOVING_PREFIX,
  STAGING_PREFIX,
  classifyExtensionDir,
  ensurePluginEntry,
  findPluginPathIndex,
  hasIncludeDirective,
  inspectAutoClawExtension,
  isManagedPluginPath,
  registerAutoClawPlugin,
  removeLegacyLoadPath,
  resolveAutoClawPaths,
  resolvePluginDir,
  unregisterAutoClawPlugin,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) {
      unregisterAutoClawPlugin();
    } else {
      registerAutoClawPlugin();
    }
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}
