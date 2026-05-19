#!/usr/bin/env node
// Register Clawd's CodeFree-O plugin in the user's CodeFree-O config.
//
// CodeFree-O (中国电信 CodeFree 研发大模型) uses its own config directory
// at ~/.codefree-o/.config/ and reads codefree.json (NOT the shared
// ~/.config/opencode/opencode.json that vanilla opencode uses).
//
// This installer registers the codefree-o-plugin/ in
// ~/.codefree-o/.config/codefree.json under the "plugin" array.
// It also writes disabled_hooks: ["session-notification"] to
// ~/.codefree-o/.config/oh-my-openagent.jsonc so that oh-my-openagent's
// built-in session-notification hook (which sends native Windows/macOS/Linux
// toast notifications) is suppressed — Clawd's bell animation takes over
// the notification UX instead.
//
// Idempotent — safe to run multiple times.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { writeJsonAtomic, asarUnpackedPath } = require("./json-utils");

const PLUGIN_DIR_NAME = "codefree-o-plugin";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".codefree-o", ".config");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "codefree.json");
const DEFAULT_OMA_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "oh-my-openagent.jsonc");

// Minimal JSONC strip: remove single-line (//) and multi-line (/* */) comments
// and trailing commas before ] or } so JSON.parse can handle the result.
function stripJsonc(raw) {
  // State machine: track whether we're inside a string literal
  let out = "";
  let i = 0;
  let inString = false;
  while (i < raw.length) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < raw.length) { out += raw[++i]; }
      else if (ch === '"') { inString = false; }
      i++;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; i++; continue; }
    if (ch === "/" && i + 1 < raw.length && raw[i + 1] === "/") {
      // Single-line comment — skip to EOL
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && i + 1 < raw.length && raw[i + 1] === "*") {
      // Multi-line comment — skip to */
      i += 2;
      while (i < raw.length - 1 && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i += 2; // skip */
      continue;
    }
    out += ch;
    i++;
  }
  // Strip trailing commas before ] or }
  out = out.replace(/,\s*([}\]])/g, "$1");
  return out;
}

function parseJsonc(raw) {
  return JSON.parse(stripJsonc(raw));
}

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

/**
 * Disable oh-my-openagent's session-notification hook in
 * ~/.codefree-o/.config/oh-my-openagent.jsonc so that native OS
 * notifications (Windows toast, macOS Notification Center, Linux
 * notify-send) are suppressed. Clawd's bell animation + sound takes
 * over the notification UX instead.
 *
 * Adds "session-notification" to the "disabled_hooks" array.
 * Idempotent — safe to run multiple times.
 *
 * @param {object} [options]
 * @param {boolean} [options.silent]       suppress console output
 * @param {string}  [options.omaConfigPath] override path to oh-my-openagent.jsonc (for tests)
 * @returns {{ updated: boolean, skipped: boolean, created: boolean, configPath: string }}
 */
function disableSessionNotificationHook(options = {}) {
  const configPath = options.omaConfigPath || DEFAULT_OMA_CONFIG_PATH;
  const configDir = path.dirname(configPath);

  // Skip if config dir doesn't exist (CodeFree-O not installed) — unless caller overrides
  if (!options.omaConfigPath) {
    let exists = false;
    try { exists = fs.statSync(configDir).isDirectory(); } catch {}
    if (!exists) {
      if (!options.silent) {
        console.log("Clawd: ~/.codefree-o/.config/ not found — skipping oh-my-openagent notification disable");
      }
      return { updated: false, skipped: true, created: false, configPath };
    }
  }

  let settings = {};
  let created = false;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    settings = parseJsonc(raw);
    if (!settings || typeof settings !== "object") settings = {};
  } catch (err) {
    if (err.code === "ENOENT") {
      settings = {};
      created = true;
    } else {
      throw new Error(`Failed to read ${configPath}: ${err.message}`);
    }
  }

  if (!Array.isArray(settings.disabled_hooks)) settings.disabled_hooks = [];

  const HOOK_NAME = "session-notification";
  if (settings.disabled_hooks.includes(HOOK_NAME)) {
    if (!options.silent) {
      console.log(`Clawd: ${HOOK_NAME} already in disabled_hooks — skipping`);
    }
    return { updated: false, skipped: true, created: false, configPath };
  }

  settings.disabled_hooks.push(HOOK_NAME);
  writeJsonAtomic(configPath, settings);

  if (!options.silent) {
    console.log(`Clawd: disabled ${HOOK_NAME} hook → ${configPath}`);
    if (created) console.log("  Created oh-my-openagent.jsonc");
  }

  return { updated: true, skipped: false, created, configPath };
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  DEFAULT_OMA_CONFIG_PATH,
  registerCodeFreeOPlugin,
  disableSessionNotificationHook,
  resolveCodeFreeOPluginDir,
};

if (require.main === module) {
  try {
    registerCodeFreeOPlugin({});
    disableSessionNotificationHook({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
