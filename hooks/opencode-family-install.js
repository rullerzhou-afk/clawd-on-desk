#!/usr/bin/env node
// Shared installer factory for opencode-family members.
//
// Registers the family plugin dir (hooks/<agent>-plugin/) in the host's
// global config "plugin" array. Parameterized by the family registry
// (agents/opencode-family.js) so register/unregister/idempotency/stale-path
// behavior stays identical across members — a fix here fixes every member.
// Per-agent wrappers (opencode-install.js, mimocode-install.js) preserve the
// legacy named exports, return shapes (incl. reason strings), and CLI entry.
//
// Why the global config and not plugins/ directory scanning:
//   - Phase 0 spike verified that 1.3.13 does NOT auto-scan ~/.config/opencode/plugins/
//     for bare .mjs files. It only loads plugins listed in "plugin" arrays.
//   - Global scope applies to every project the user opens, matching
//     Gemini/Cursor install behavior.
//   - opencode.ai/docs/plugins confirms Load Order starts with "global config".

const fs = require("fs");
const path = require("path");
const os = require("os");
const { readJsonFile, writeJsonAtomic, writeJsonAtomicWithBackup, asarUnpackedPath } = require("./json-utils");
const { getFamilyConfig } = require("../agents/opencode-family");

function normalizePluginEntry(value) {
  return String(value || "").replace(/\\/g, "/");
}

function entryIsExactManagedPlugin(entry, pluginDir) {
  return typeof entry === "string" && normalizePluginEntry(entry) === normalizePluginEntry(pluginDir);
}

// JSONC members lazily load the family JSONC editor so the JSON-only path
// never touches (or ships) the jsonc-parser dependency — hooks/json-utils.js
// is deployed to remote SSH hosts without node_modules and must stay dep-free
// (plan §4.1). The editor module lands with the mimocode PR.
function getJsoncEditor() {
  // eslint-disable-next-line global-require
  return require("./opencode-family-jsonc");
}

/**
 * Build the installer for one family member.
 *
 * @param {string} agentId  a key of OPENCODE_FAMILY (agents/opencode-family.js)
 * @returns {{
 *   register: Function, unregister: Function, resolvePluginDir: Function,
 *   DEFAULT_PARENT_DIR: string, DEFAULT_CONFIG_PATH: string, __test: object
 * }}
 */
function makeFamilyInstaller(agentId) {
  const cfg = getFamilyConfig(agentId);
  if (!cfg) throw new Error(`makeFamilyInstaller: unknown family agent "${agentId}"`);

  const PLUGIN_DIR_NAME = cfg.pluginDirName;
  const DEFAULT_PARENT_DIR = path.join(os.homedir(), ...cfg.configDirSegments);
  const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, cfg.configFileName);
  // "~/.config/opencode/" — for user-facing skip messages
  const PARENT_DIR_DISPLAY = `~/${cfg.configDirSegments.join("/")}/`;

  /**
   * Resolve the absolute path to hooks/<agent>-plugin/ as seen from a running
   * host (Bun) process. When Clawd is packaged into app.asar, hooks/** is
   * unpacked to app.asar.unpacked/ (see package.json "asarUnpack"). The host
   * cannot require files inside asar, so we must point it at the unpacked copy.
   *
   * NOTE: this file lives directly under hooks/ (same directory as the old
   * per-agent installers), so the default __dirname base yields byte-identical
   * registered paths to the pre-refactor ones — no config migration.
   *
   * @param {string} [baseDir]  defaults to __dirname (hooks/); exposed for tests
   */
  function resolvePluginDir(baseDir) {
    // Normalize to forward slashes for JSON storage + cross-platform host compat
    const dir = path.resolve(baseDir || __dirname, PLUGIN_DIR_NAME).replace(/\\/g, "/");
    return asarUnpackedPath(dir);
  }

  /**
   * Register the Clawd family plugin in the host's global config.
   *
   * @param {object} [options]
   * @param {boolean} [options.silent]   suppress console output
   * @param {string}  [options.configPath]  override config path (for tests)
   * @param {string}  [options.pluginDir]   override plugin dir absolute path (for tests)
   * @returns {{ added: boolean, skipped: boolean, created: boolean, configPath: string, pluginDir: string }}
   */
  function register(options = {}) {
    // options.homeDir mirrors unregister() (see below). Without it a caller
    // that passes a sandbox home — tests, cleanup planning — silently writes
    // to the REAL ~/.config, which is how #825's verification harness first
    // clobbered a live config.
    const configDir = path.join(options.homeDir || os.homedir(), ...cfg.configDirSegments);
    const configPath = options.configPath || path.join(configDir, cfg.configFileName);
    const pluginDir = options.pluginDir || resolvePluginDir();

    // Skip if the host's config dir doesn't exist (host not installed) — unless caller overrides
    if (!options.configPath) {
      let exists = false;
      try { exists = fs.statSync(configDir).isDirectory(); } catch {}
      if (!exists) {
        if (!options.silent) {
          console.log(`Clawd: ${PARENT_DIR_DISPLAY} not found — skipping ${agentId} plugin registration`);
        }
        return {
          added: false,
          skipped: true,
          created: false,
          reason: `${agentId}-not-found`,
          configPath,
          pluginDir,
        };
      }
    }

    if (cfg.jsonc) {
      return getJsoncEditor().registerJsonc({ cfg, agentId, configPath, pluginDir, options });
    }

    let settings = {};
    let created = false;
    try {
      settings = readJsonFile(configPath);
      if (!settings || typeof settings !== "object") settings = {};
    } catch (err) {
      if (err.code === "ENOENT") {
        settings = cfg.schema ? { $schema: cfg.schema } : {};
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
    // The isAbsolute guard is critical: the host also accepts npm package
    // specifiers in the plugin array (e.g. "opencode-wakatime" or a scoped
    // "@vendor/opencode-plugin"), and path.basename of a scoped package name
    // happens to return the segment after the slash — so a naive basename
    // equality would stomp any third-party scoped package ending in
    // "/<agent>-plugin". Clawd itself only ever writes absolute paths, so
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
      console.log(`Clawd ${agentId} plugin → ${configPath}`);
      if (created) console.log(`  Created ${cfg.configFileName}`);
      if (added) console.log(`  Registered: ${pluginDir}`);
      if (skipped) console.log(`  Already registered: ${pluginDir}`);
    }

    return { added, skipped, created, configPath, pluginDir };
  }

  function unregister(options = {}) {
    const configDir = path.join(options.homeDir || os.homedir(), ...cfg.configDirSegments);
    const configPath = options.configPath || path.join(configDir, cfg.configFileName);
    const pluginDir = options.pluginDir || resolvePluginDir();

    if (cfg.jsonc) {
      return getJsoncEditor().unregisterJsonc({ cfg, agentId, configPath, pluginDir, options });
    }

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
    if (!options.silent) console.log(`Clawd ${agentId} plugin entries removed: ${removed}`);
    const result = { removed, changed, skipped: !changed, configPath, pluginDir };
    if (options.backup === true) result.backupPath = backupPath;
    return result;
  }

  return {
    register,
    unregister,
    resolvePluginDir,
    DEFAULT_PARENT_DIR,
    DEFAULT_CONFIG_PATH,
    __test: { entryIsExactManagedPlugin, normalizePluginEntry },
  };
}

module.exports = {
  makeFamilyInstaller,
  __test: { entryIsExactManagedPlugin, normalizePluginEntry },
};
