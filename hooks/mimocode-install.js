#!/usr/bin/env node
// Register Clawd's mimocode plugin in the user's global mimocode config.
//
// Strategy: append the absolute path of hooks/mimocode-plugin/ into
// ~/.config/mimocode/mimocode.jsonc under the "plugin" array. Idempotent.
//
// Why global mimocode.jsonc and not plugins/ directory scanning:
//   - Phase 0 spike verified that 1.3.13 does NOT auto-scan ~/.config/mimocode/plugins/
//     for bare .mjs files. It only loads plugins listed in "plugin" arrays.
//   - Global scope (~/.config/mimocode/mimocode.jsonc) applies to every project
//     the user opens, matching Gemini/Cursor install behavior.
//   - opencode.ai/docs/plugins confirms Load Order starts with "global config".
//     mimocode is an opencode-derived runtime and shares the same plugin loader.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { readJsonFile, writeJsonAtomic, writeJsonAtomicWithBackup, asarUnpackedPath } = require("./json-utils");

const PLUGIN_DIR_NAME = "mimocode-plugin";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".config", "mimocode");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "mimocode.jsonc");

/**
 * Resolve the absolute path to hooks/mimocode-plugin/ as seen from a running
 * mimocode (Bun) process. When Clawd is packaged into app.asar, hooks/** is
 * unpacked to app.asar.unpacked/ (see package.json "asarUnpack"). mimocode
 * cannot require files inside asar, so we must point it at the unpacked copy.
 *
 * @param {string} [baseDir]  defaults to __dirname (hooks/); exposed for tests
 */
function resolvePluginDir(baseDir) {
  // Normalize to forward slashes for JSON storage + cross-platform mimocode compat
  const dir = path.resolve(baseDir || __dirname, PLUGIN_DIR_NAME).replace(/\\/g, "/");
  return asarUnpackedPath(dir);
}

function normalizePluginEntry(value) {
  return String(value || "").replace(/\\/g, "/");
}

function entryIsExactManagedPlugin(entry, pluginDir) {
  return typeof entry === "string" && normalizePluginEntry(entry) === normalizePluginEntry(pluginDir);
}

/**
 * Register the Clawd mimocode plugin in ~/.config/mimocode/mimocode.jsonc.
 *
 * @param {object} [options]
 * @param {boolean} [options.silent]   suppress console output
 * @param {string}  [options.configPath]  override path to mimocode.jsonc (for tests)
 * @param {string}  [options.pluginDir]   override plugin dir absolute path (for tests)
 * @returns {{ added: boolean, skipped: boolean, created: boolean, configPath: string, pluginDir: string }}
 */
function registerMimocodePlugin(options = {}) {
  const configDir = path.join(os.homedir(), ".config", "mimocode");
  const configPath = options.configPath || path.join(configDir, "mimocode.jsonc");
  const pluginDir = options.pluginDir || resolvePluginDir();

  // Skip if ~/.config/mimocode/ doesn't exist (mimocode not installed) — unless caller overrides
  if (!options.configPath) {
    let exists = false;
    try { exists = fs.statSync(configDir).isDirectory(); } catch {}
    if (!exists) {
      if (!options.silent) {
        console.log("Clawd: ~/.config/mimocode/ not found — skipping mimocode plugin registration");
      }
      return {
        added: false,
        skipped: true,
        created: false,
        reason: "mimocode-not-found",
        configPath,
        pluginDir,
      };
    }
  }

  let settings = {};
  let created = false;
  try {
    settings = readJsonFile(configPath);
    if (!settings || typeof settings !== "object") settings = {};
  } catch (err) {
    if (err.code === "ENOENT") {
      settings = { $schema: "https://opencode.ai/config.json" };
      created = true;
    } else {
      // Parse error or other I/O — do not clobber the user's config
      throw new Error(`Failed to read ${configPath}: ${err.message}`);
    }
  }

  if (!Array.isArray(settings.plugin)) settings.plugin = [];

  // Idempotency: match by exact path OR by directory basename on an
  // absolute-path entry. Basename catches stale paths from earlier installs
  // at different locations (dev vs packaged) and updates them in place.
  // The isAbsolute guard is critical: mimocode also accepts npm package
  // specifiers in the plugin array (e.g. "mimocode-wakatime" or a scoped
  // "@vendor/mimocode-plugin"), and path.basename of a scoped package name
  // happens to return the segment after the slash — so a naive basename
  // equality would stomp any third-party scoped package ending in
  // "/mimocode-plugin". Clawd itself only ever writes absolute paths, so
  // restricting the match to absolute entries is safe.
  let matchIndex = -1;
  for (let i = 0; i < settings.plugin.length; i++) {
    const entry = settings.plugin[i];
    if (typeof entry !== "string") continue;
    if (entry === pluginDir) {
      matchIndex = i;
      break;
    }
    const normalized = entry.replace(/\\/g, "/");
    // Platform-agnostic absolute-path check: POSIX (/foo) or Windows (C:/foo).
    // Config files can sync across machines, so we accept either shape.
    const isAbsolute = path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized);
    if (isAbsolute && path.posix.basename(normalized) === PLUGIN_DIR_NAME) {
      matchIndex = i;
      break;
    }
  }

  let added = false;
  let skipped = false;
  if (matchIndex === -1) {
    settings.plugin.push(pluginDir);
    added = true;
  } else if (settings.plugin[matchIndex] !== pluginDir) {
    // Stale path (e.g. old install location) — update in place
    settings.plugin[matchIndex] = pluginDir;
    added = true; // counts as a change for atomic write
  } else {
    skipped = true;
  }

  if (!skipped) {
    writeJsonAtomic(configPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd mimocode plugin → ${configPath}`);
    if (created) console.log("  Created mimocode.jsonc");
    if (added) console.log(`  Registered: ${pluginDir}`);
    if (skipped) console.log(`  Already registered: ${pluginDir}`);
  }

  return { added, skipped, created, configPath, pluginDir };
}

function unregisterMimocodePlugin(options = {}) {
  const configDir = path.join(options.homeDir || os.homedir(), ".config", "mimocode");
  const configPath = options.configPath || path.join(configDir, "mimocode.jsonc");
  const pluginDir = options.pluginDir || resolvePluginDir();

  let settings = {};
  try {
    settings = readJsonFile(configPath);
    if (!settings || typeof settings !== "object") settings = {};
  } catch (err) {
    if (err.code === "ENOENT") return { removed: 0, changed: false, skipped: true, configPath, pluginDir };
    throw new Error(`Failed to read ${configPath}: ${err.message}`);
  }

  if (!Array.isArray(settings.plugin)) {
    return { removed: 0, changed: false, skipped: true, configPath, pluginDir };
  }

  const before = settings.plugin.length;
  settings.plugin = settings.plugin.filter((entry) => !entryIsExactManagedPlugin(entry, pluginDir));
  const removed = before - settings.plugin.length;
  const changed = removed > 0;

  let backupPath = null;
  if (changed) backupPath = writeJsonAtomicWithBackup(configPath, settings, options);
  if (!options.silent) console.log(`Clawd mimocode plugin entries removed: ${removed}`);
  const result = { removed, changed, skipped: !changed, configPath, pluginDir };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  registerMimocodePlugin,
  unregisterMimocodePlugin,
  resolvePluginDir,
  __test: { entryIsExactManagedPlugin, normalizePluginEntry },
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterMimocodePlugin({});
    else registerMimocodePlugin({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
