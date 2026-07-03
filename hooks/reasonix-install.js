#!/usr/bin/env node
// Merge Clawd Reasonix hooks into <Reasonix home>/settings.json (append-only, idempotent)
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

function expandHomePath(value, homeDir) {
  const raw = String(value || "").trim();
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

  const explicit = expandHomePath(env.REASONIX_HOME, options.userHomeDir || os.homedir());
  if (explicit) return path.resolve(explicit);

  if (platform === "win32") {
    const appData = String(env.APPDATA || env.AppData || "").trim();
    if (appData) return path.join(appData, "reasonix");
    const home = options.userHomeDir || os.homedir();
    return path.join(home, "AppData", "Roaming", "reasonix");
  }

  return path.join(options.userHomeDir || os.homedir(), SETTINGS_DIRNAME);
}

const DEFAULT_PARENT_DIR = resolveReasonixHome();
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, SETTINGS_FILENAME);

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
  // cmd /c cannot handle a quoted first token (node) or paths with spaces.
  // Use PowerShell -EncodedCommand to bypass cmd's quoting bugs entirely.
  const platform = options.platform || process.platform;
  if (platform === "win32" && typeof nodeBin === "string" && nodeBin.includes(" ")) {
    return formatNodeHookCommand(nodeBin, hookScript, { ...options, windowsWrapper: "encoded" });
  }
  return formatNodeHookCommand(nodeBin, hookScript, { ...options, windowsWrapper: "none" });
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
  const settingsPath = options.settingsPath || path.join(resolveReasonixHome(options), SETTINGS_FILENAME);

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

function unregisterReasonixHooks(options = {}) {
  const settingsPath = options.settingsPath || path.join(resolveReasonixHome(options), SETTINGS_FILENAME);

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

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  MARKER,
  REASONIX_HOOK_EVENTS,
  registerReasonixHooks,
  unregisterReasonixHooks,
  __test: { buildReasonixHookCommand, resolveReasonixHome },
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterReasonixHooks({});
    else registerReasonixHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
