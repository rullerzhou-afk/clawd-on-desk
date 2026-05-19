#!/usr/bin/env node
// Register Clawd's CodeFree-O plugin in the user's CodeFree-O config.
//
// CodeFree-O (中国电信 CodeFree 研发大模型) uses its own config directory
// at ~/.codefree-o/.config/ and reads codefree.json (NOT the shared
// ~/.config/opencode/opencode.json that vanilla opencode uses).
//
// This installer registers the codefree-o-plugin/ in
// ~/.codefree-o/.config/codefree.json under the "plugin" array.
// Idempotent — safe to run multiple times.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { writeJsonAtomic, asarUnpackedPath } = require("./json-utils");

const PLUGIN_DIR_NAME = "codefree-o-plugin";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".codefree-o", ".config");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "codefree.json");

/**
 * Resolve the absolute path to hooks/codefree-o-plugin/ as seen from a running
 * CodeFree-O (Bun) process. When Clawd is packaged into app.asar, hooks/** is
 * unpacked to app.asar.unpacked/ (see package.json "asarUnpack"). CodeFree-O
 * cannot require files inside asar, so we must point it at the unpacked copy.
 *
 * @param {string} [baseDir]  defaults to __dirname (hooks/); exposed for tests
 */
function resolveCodeFreeOPluginDir(baseDir) {
  // Normalize to forward slashes for JSON storage + cross-platform compat
  const dir = path.resolve(baseDir || __dirname, PLUGIN_DIR_NAME).replace(/\\/g, "/");
  return asarUnpackedPath(dir);
}

/**
 * Register the Clawd CodeFree-O plugin in ~/.codefree-o/.config/codefree.json.
 *
 * @param {object} [options]
 * @param {boolean} [options.silent]   suppress console output
 * @param {string}  [options.configPath]  override path to codefree.json (for tests)
 * @param {string}  [options.pluginDir]   override plugin dir absolute path (for tests)
 * @returns {{ added: boolean, skipped: boolean, created: boolean, configPath: string, pluginDir: string }}
 */
function registerCodeFreeOPlugin(options = {}) {
  const configDir = path.join(os.homedir(), ".codefree-o", ".config");
  const configPath = options.configPath || path.join(configDir, "codefree.json");
  const pluginDir = options.pluginDir || resolveCodeFreeOPluginDir();

  // Skip if ~/.codefree-o/.config/ doesn't exist (CodeFree-O not installed) — unless caller overrides
  if (!options.configPath) {
    let exists = false;
    try { exists = fs.statSync(configDir).isDirectory(); } catch {}
    if (!exists) {
      if (!options.silent) {
        console.log("Clawd: ~/.codefree-o/.config/ not found — skipping CodeFree-O plugin registration");
      }
      return { added: false, skipped: true, created: false, configPath, pluginDir };
    }
  }

  let settings = {};
  let created = false;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    settings = JSON.parse(raw);
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
  // absolute-path entry. This catches stale paths from earlier installs
  // at different locations (dev vs packaged) and updates them in place.
  // The isAbsolute guard prevents stomping on npm package specifiers.
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
    console.log(`Clawd CodeFree-O plugin → ${configPath}`);
    if (created) console.log("  Created codefree.json");
    if (added) console.log(`  Registered: ${pluginDir}`);
    if (skipped) console.log(`  Already registered: ${pluginDir}`);
  }

  return { added, skipped, created, configPath, pluginDir };
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  registerCodeFreeOPlugin,
  resolveCodeFreeOPluginDir,
};

if (require.main === module) {
  try {
    registerCodeFreeOPlugin({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
