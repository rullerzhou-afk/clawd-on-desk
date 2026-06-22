#!/usr/bin/env node
// Merge Clawd Cursor Agent hooks into ~/.cursor/hooks.json (append-only, idempotent)

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
const MARKER = "cursor-hook.js";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".cursor");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "hooks.json");

const CURSOR_HOOK_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "subagentStart",
  "subagentStop",
  "preCompact",
  "stop",
];

function buildCursorHookCommand(nodeBin, hookScript, platform = process.platform) {
  return formatNodeHookCommand(nodeBin, hookScript, { platform });
}

/**
 * Register Clawd hooks into ~/.cursor/hooks.json
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.hooksPath]
 * @param {string} [options.homeDir] internal override for tests
 * @returns {{ added: number, skipped: number, updated: number }}
 */
function registerCursorHooks(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const hooksPath = options.hooksPath || path.join(homeDir, ".cursor", "hooks.json");

  // Skip if ~/.cursor/ doesn't exist (Cursor not installed) — unless caller overrides path
  if (!options.hooksPath) {
    const cursorDir = path.dirname(hooksPath);
    let exists = false;
    try { exists = fs.statSync(cursorDir).isDirectory(); } catch {}
    if (!exists) {
      if (!options.silent) console.log("Cursor not installed (~/.cursor/ not found) — skipping hook registration.");
      return { added: 0, skipped: 0, updated: 0 };
    }
  }
  const hookScript = asarUnpackedPath(path.resolve(__dirname, "cursor-hook.js").replace(/\\/g, "/"));

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read hooks.json: ${err.message}`);
    }
  }

  // Resolve node path; if detection fails, preserve existing absolute path
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved
    || extractExistingNodeBin(settings, MARKER)
    || "node";
  const desiredCommand = buildCursorHookCommand(
    nodeBin,
    hookScript,
    options.platform || process.platform
  );

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  if (typeof settings.version !== "number") settings.version = 1;

  let added = 0;
  let skipped = 0;
  let updated = 0;
  let changed = false;

  for (const event of CURSOR_HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const arr = settings.hooks[event];
    let found = false;
    let stalePath = false;
    for (const entry of arr) {
      if (!entry || typeof entry !== "object" || typeof entry.command !== "string") continue;
      if (!entry.command.includes(MARKER)) continue;
      found = true;
      if (entry.command !== desiredCommand) {
        entry.command = desiredCommand;
        stalePath = true;
      }
      break;
    }

    if (found) {
      if (stalePath) {
        updated++;
        changed = true;
      } else {
        skipped++;
      }
      continue;
    }

    arr.push({ command: desiredCommand });
    added++;
    changed = true;
  }

  if (added > 0 || changed) {
    writeJsonAtomic(hooksPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd Cursor hooks → ${hooksPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
  }

  return { added, skipped, updated };
}

function unregisterCursorHooks(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const hooksPath = options.hooksPath || path.join(homeDir, ".cursor", "hooks.json");

  let settings = {};
  try {
    settings = readJsonFile(hooksPath);
  } catch (err) {
    if (err.code === "ENOENT") return { removed: 0, changed: false, hooksPath };
    throw new Error(`Failed to read hooks.json: ${err.message}`);
  }

  if (!settings.hooks || typeof settings.hooks !== "object") {
    return { removed: 0, changed: false, hooksPath };
  }

  let removed = 0;
  let changed = false;
  for (const event of CURSOR_HOOK_EVENTS) {
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
  if (changed) backupPath = writeJsonAtomicWithBackup(hooksPath, settings, options);
  if (!options.silent) console.log(`Clawd Cursor hooks removed: ${removed}`);
  const result = { removed, changed, hooksPath };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  registerCursorHooks,
  unregisterCursorHooks,
  CURSOR_HOOK_EVENTS,
  buildCursorHookCommand,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterCursorHooks({});
    else registerCursorHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
