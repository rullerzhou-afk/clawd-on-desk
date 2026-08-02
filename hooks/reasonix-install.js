#!/usr/bin/env node
// Merge Clawd Reasonix hooks into the active current/legacy settings.json
// (append-only, idempotent), and remove managed hooks from both on uninstall.
// Reasonix hook format: { "hooks": { "EventName": [{ "match", "command", ... }] } }

const fs = require("fs");
const path = require("path");
const os = require("os");
const { resolveNodeBin } = require("./server-config");
const {
  readJsonFile,
  writeJsonAtomic,
  writeJsonAtomicWithBackup,
  asarUnpackedPath,
  commandMatchesMarker,
  extractExistingNodeBin,
  formatNodeHookCommand,
  removeMatchingCommandHooks,
} = require("./json-utils");

const MARKER = "reasonix-hook.js";
const SETTINGS_DIRNAME = ".reasonix";
const SETTINGS_FILENAME = "settings.json";
const BRACED_ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g;
const BARE_ENV_VAR_PATTERN = /\$([A-Za-z_][A-Za-z0-9_]*)/g;

function expandHomePath(value, homeDir, env = process.env) {
  let unresolved = false;
  const expandedBraced = String(value || "").trim().replace(
    BRACED_ENV_VAR_PATTERN,
    (_match, name, fallbackClause, fallbackValue) => {
      const envValue = env && env[name] != null ? String(env[name]) : "";
      if (envValue) return envValue;
      if (fallbackClause) return fallbackValue;
      unresolved = true;
      return "";
    }
  );
  const raw = expandedBraced.replace(BARE_ENV_VAR_PATTERN, (_match, name) => {
    const envValue = env && env[name] != null ? String(env[name]) : "";
    if (envValue) return envValue;
    unresolved = true;
    return "";
  });
  // An authoritative override containing any missing, fallback-less variable
  // is invalid as a whole. Otherwise `${MISSING}/tmp` would silently become
  // `/tmp`, which is worse than the original cwd fallback.
  if (unresolved) return "";
  if (!raw) return "";
  const home = homeDir || os.homedir();
  if (raw === "~") return home;
  if ((raw.startsWith("~/") || raw.startsWith("~\\")) && home) {
    return path.join(home, raw.slice(2));
  }
  return raw;
}

function resolveReasonixHome(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;

  // Test/legacy override mirrors Reasonix's hook.GlobalSettingsPath(homeDir):
  // the override is a fake OS home, not the Reasonix home itself.
  if (options.homeDir) return path.join(options.homeDir, SETTINGS_DIRNAME);

  const configuredHome = String(env.REASONIX_HOME || "").trim();
  if (configuredHome) {
    const explicit = expandHomePath(configuredHome, options.userHomeDir || os.homedir(), env);
    // A configured override is authoritative. If any fallback-less variable
    // is unresolved, fail closed instead of collapsing the remaining suffix
    // into a different absolute path (or the launch cwd).
    if (!explicit) return "";
    return path.resolve(explicit);
  }

  if (platform === "win32") {
    const appData = String(env.APPDATA || env.AppData || "").trim();
    if (appData) return path.join(appData, "reasonix");
    const home = options.userHomeDir || os.homedir();
    return path.join(home, "AppData", "Roaming", "reasonix");
  }

  return path.join(options.userHomeDir || os.homedir(), SETTINGS_DIRNAME);
}

function resolveLegacyReasonixHome(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;

  // Reasonix treats both the test-only home override and REASONIX_HOME as
  // isolated runtimes. Neither is allowed to fall back to another user config.
  if (options.homeDir) return "";
  if (String(env.REASONIX_HOME || "").trim()) return "";
  if (platform !== "win32") return "";

  const legacy = path.join(options.userHomeDir || os.homedir(), SETTINGS_DIRNAME);
  return path.resolve(legacy) === path.resolve(resolveReasonixHome(options)) ? "" : legacy;
}

function resolveReasonixConfigTargets(options = {}) {
  const platform = options.platform || process.platform;
  const homes = [
    { label: "current", parentDir: resolveReasonixHome(options) },
    { label: "legacy", parentDir: resolveLegacyReasonixHome(options) },
  ];
  const seen = new Set();
  const targets = [];
  for (const home of homes) {
    if (!home.parentDir) continue;
    const resolved = path.resolve(home.parentDir);
    const key = platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      label: home.label,
      parentDir: home.parentDir,
      configPath: path.join(home.parentDir, SETTINGS_FILENAME),
    });
  }
  return targets;
}

function selectReasonixSettingsPath(options = {}) {
  if (options.settingsPath) return options.settingsPath;
  const targets = resolveReasonixConfigTargets(options);
  if (targets.length === 0) return "";

  // Mirror Reasonix's own loader: an existing current settings file wins; when
  // it is absent, the legacy ~/.reasonix/settings.json remains active.
  const withConfig = targets.find((target) => fs.existsSync(target.configPath));
  if (withConfig) return withConfig.configPath;
  const withHome = targets.find((target) => fs.existsSync(target.parentDir));
  return (withHome || targets[0]).configPath;
}

const DEFAULT_PARENT_DIR = resolveReasonixHome();
const DEFAULT_CONFIG_PATH = DEFAULT_PARENT_DIR
  ? path.join(DEFAULT_PARENT_DIR, SETTINGS_FILENAME)
  : "";
const DEFAULT_CONFIG_TARGETS = Object.freeze(
  resolveReasonixConfigTargets().map((target) => Object.freeze(target))
);

const REASONIX_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "Notification",
  "PreCompact",
];

function isClawdHookCommand(command) {
  return commandMatchesMarker(command, MARKER);
}

function buildReasonixHookEntry(command) {
  return { match: "*", command };
}

function buildReasonixHookCommand(nodeBin, hookScript, options = {}) {
  // Reasonix wraps commands with `cmd /c` on Windows (see hook.go shellInvocation).
  // Go's Windows argv builder escapes every embedded `"` in that single command
  // argument as `\"`; cmd.exe treats the backslashes literally, so every plain
  // quoted command fails even when neither path contains spaces. Always use the
  // encoded wrapper to bypass that argv/quote mismatch.
  //
  // PowerShell normalizes a native child's non-zero exit code to 1 here. This is
  // safe only while reasonix-hook.js is state-only and always exits 0. A future
  // blocking hook that needs Reasonix's exit-2 DecisionBlock contract must add
  // explicit native exit-code propagation instead of reusing this wrapper as-is.
  const platform = options.platform || process.platform;
  if (platform === "win32") {
    return formatNodeHookCommand(nodeBin, hookScript, { ...options, windowsWrapper: "encoded" });
  }
  return formatNodeHookCommand(nodeBin, hookScript, options);
}

function isDesiredReasonixHookEntry(entry, desiredCommand) {
  return !!(
    entry
    && typeof entry === "object"
    && (entry.match === "*" || entry.match === "")
    && entry.command === desiredCommand
  );
}

function normalizeReasonixHookEntries(entries, desiredCommand) {
  if (!Array.isArray(entries)) return { matched: false, changed: false };

  let matched = false;
  let changed = false;
  let dedicatedIndex = -1;

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;

    if (isClawdHookCommand(entry.command)) {
      matched = true;
      if (dedicatedIndex === -1) {
        const cmdChanged = entry.command !== desiredCommand;
        const timeoutChanged = entry.timeout != null;
        if (cmdChanged) entry.command = desiredCommand;
        entry.match = "*";
        if (timeoutChanged) { delete entry.timeout; }
        if (cmdChanged || timeoutChanged) changed = true;
        dedicatedIndex = index;
      } else {
        entries.splice(index, 1);
        index--;
        changed = true;
      }
    }
  }

  if (!matched) return { matched: false, changed: false };

  if (dedicatedIndex === -1) {
    entries.push(buildReasonixHookEntry(desiredCommand));
    return { matched: true, changed: true };
  }

  return { matched: true, changed };
}

/**
 * Register Clawd hooks into <Reasonix home>/settings.json
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.settingsPath]
 * @param {string} [options.homeDir] internal override for tests
 * @returns {{ added: number, skipped: number, updated: number }}
 */
function registerReasonixHooks(options = {}) {
  const settingsPath = selectReasonixSettingsPath(options);
  if (!settingsPath) {
    const message = "REASONIX_HOME contains an unresolved variable or expands to an empty path; refusing to register hooks";
    if (!options.silent) throw new Error(message);
    console.warn(`Clawd: ${message}`);
    return {
      status: "skipped",
      reason: "reasonix-home-invalid",
      message,
      added: 0,
      skipped: 0,
      updated: 0,
    };
  }

  // Skip if Reasonix home doesn't exist (Reasonix not installed/initialized).
  const reasonixDir = path.dirname(settingsPath);
  if (!options.settingsPath && !fs.existsSync(reasonixDir)) {
    if (!options.silent) console.log(`Clawd: ${reasonixDir} not found — skipping Reasonix hook registration`);
    return { added: 0, skipped: 0, updated: 0 };
  }

  const hookScript = asarUnpackedPath(path.resolve(__dirname, "reasonix-hook.js").replace(/\\/g, "/"));

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read settings.json: ${err.message}`);
    }
  }

  // Resolve node path; if detection fails, preserve existing absolute path
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved
    || extractExistingNodeBin(settings, MARKER)
    || "node";

  const desiredCommand = buildReasonixHookCommand(nodeBin, hookScript, options);

  let added = 0;
  let skipped = 0;
  let updated = 0;
  let changed = false;

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  for (const event of REASONIX_HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const arr = settings.hooks[event];
    const result = normalizeReasonixHookEntries(arr, desiredCommand);
    const found = result.matched;
    const entryChanged = result.changed;
    if (entryChanged) changed = true;

    if (found) {
      if (entryChanged) {
        updated++;
      } else {
        skipped++;
      }
      continue;
    }

    arr.push(buildReasonixHookEntry(desiredCommand));
    added++;
    changed = true;
  }

  if (added > 0 || changed) {
    writeJsonAtomic(settingsPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd Reasonix hooks → ${settingsPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
  }

  return { added, skipped, updated };
}

function unregisterReasonixHooksAtPath(settingsPath, options = {}) {
  let settings = {};
  try {
    settings = readJsonFile(settingsPath);
  } catch (err) {
    if (err.code === "ENOENT") return { removed: 0, changed: false, settingsPath };
    throw new Error(`Failed to read settings.json: ${err.message}`);
  }

  if (!settings.hooks || typeof settings.hooks !== "object") {
    return { removed: 0, changed: false, settingsPath };
  }

  let removed = 0;
  let changed = false;
  for (const event of REASONIX_HOOK_EVENTS) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    const result = removeMatchingCommandHooks(entries, (command) => commandMatchesMarker(command, MARKER));
    if (!result.changed) continue;
    removed += result.removed;
    changed = true;
    if (result.entries.length > 0) settings.hooks[event] = result.entries;
    else delete settings.hooks[event];
  }

  let backupPath = null;
  if (changed) backupPath = writeJsonAtomicWithBackup(settingsPath, settings, options);
  if (!options.silent) console.log(`Clawd Reasonix hooks removed: ${removed}`);
  const result = { removed, changed, settingsPath };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

function unregisterReasonixHooks(options = {}) {
  const requestedPaths = Array.isArray(options.settingsPaths) && options.settingsPaths.length > 0
    ? options.settingsPaths
    : options.settingsPath
      ? [options.settingsPath]
      : resolveReasonixConfigTargets(options).map((target) => target.configPath);
  const settingsPaths = [...new Set(requestedPaths)];
  if (settingsPaths.length === 0) {
    const message = "REASONIX_HOME contains an unresolved variable or expands to an empty path; refusing to unregister hooks";
    if (!options.silent) {
      return {
        status: "error",
        reason: "reasonix-home-invalid",
        message,
        removed: 0,
        changed: false,
        settingsPath: "",
        settingsPaths: [],
        results: [],
      };
    }
    console.warn(`Clawd: ${message}`);
    return {
      status: "skipped",
      reason: "reasonix-home-invalid",
      message,
      removed: 0,
      changed: false,
      settingsPath: "",
      settingsPaths: [],
      results: [],
    };
  }
  let removed = 0;
  let changed = false;
  const backupPaths = [];
  const results = [];
  const errors = [];

  for (const settingsPath of settingsPaths) {
    let result;
    try {
      result = unregisterReasonixHooksAtPath(settingsPath, { ...options, silent: true });
    } catch (err) {
      result = {
        removed: 0,
        changed: false,
        settingsPath,
        status: "error",
        message: err && err.message ? err.message : String(err),
      };
      errors.push(result);
    }
    results.push(result);
    removed += result.removed;
    changed = changed || result.changed;
    if (result.backupPath) backupPaths.push(result.backupPath);
  }

  if (!options.silent) console.log(`Clawd Reasonix hooks removed: ${removed}`);
  const primary = results.find((result) => result.changed) || results[0];
  const result = {
    removed,
    changed,
    settingsPath: primary ? primary.settingsPath : settingsPaths[0],
    settingsPaths,
    results,
  };
  if (errors.length > 0) {
    result.status = "error";
    result.errors = errors;
    result.message = errors.length === 1
      ? `Failed to clean Reasonix hooks at ${errors[0].settingsPath}: ${errors[0].message}`
      : `Failed to clean Reasonix hooks at ${errors.length} settings paths`;
  }
  if (options.backup === true) {
    if (settingsPaths.length === 1) result.backupPath = backupPaths[0] || null;
    else result.backupPaths = backupPaths;
  }
  return result;
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  DEFAULT_CONFIG_TARGETS,
  MARKER,
  REASONIX_HOOK_EVENTS,
  registerReasonixHooks,
  unregisterReasonixHooks,
  resolveReasonixConfigTargets,
  __test: {
    buildReasonixHookCommand,
    resolveLegacyReasonixHome,
    resolveReasonixHome,
    selectReasonixSettingsPath,
  },
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) {
      const result = unregisterReasonixHooks({});
      if (result.status === "error") throw new Error(result.message);
    } else registerReasonixHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
