#!/usr/bin/env node
// Merge Clawd TraeCode hooks into ~/.trae-cn/hooks.json (append-only, idempotent)
// TraeCode uses Claude Code-compatible hook format: { matcher, hooks: [{ type, command }] }

const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  resolveNodeBin,
} = require("./server-config");
const {
  readJsonFile,
  writeJsonAtomic,
  writeJsonAtomicWithBackup,
  asarUnpackedPath,
  commandMatchesMarker,
  extractExistingNodeBin,
  removeMatchingCommandHooks,
} = require("./json-utils");
const MARKER = "traecode-hook.js";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".trae-cn");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "hooks.json");

// TraeCode supported hook events (no SessionEnd, PermissionRequest, PreCompact)
const TRAECODE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "Notification",
];

/**
 * Register Clawd hooks into ~/.trae-cn/hooks.json
 * Uses Claude Code-compatible nested format: { matcher, hooks: [{ type, command }] }
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.hooksPath]
 * @param {string} [options.homeDir] internal override for tests
 * @returns {{ added: number, skipped: number, updated: number }}
 */
function registerTraeCodeHooks(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const hooksPath = options.hooksPath || path.join(homeDir, ".trae-cn", "hooks.json");

  // Skip if ~/.trae-cn/ doesn't exist (TraeCode not installed)
  if (!options.hooksPath) {
    const traeDir = path.dirname(hooksPath);
    if (!fs.existsSync(traeDir)) {
      if (!options.silent) console.log("Clawd: ~/.trae-cn/ not found — skipping TraeCode hook registration");
      return { added: 0, skipped: 0, updated: 0 };
    }
  }

  const hookScript = asarUnpackedPath(path.resolve(__dirname, "traecode-hook.js").replace(/\\/g, "/"));

  let settings = {};
  try {
    settings = readJsonFile(hooksPath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read hooks.json: ${err.message}`);
    }
  }

  // Resolve node path; if detection fails, preserve existing absolute path
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved
    || extractExistingNodeBin(settings, MARKER, { nested: true })
    || "node";
  const desiredCommand = `"${nodeBin}" "${hookScript}"`;

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  let added = 0;
  let skipped = 0;
  let updated = 0;
  let changed = false;

  for (const event of TRAECODE_HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const arr = settings.hooks[event];
    let found = false;
    let stalePath = false;

    for (const entry of arr) {
      if (!entry || typeof entry !== "object") continue;
      // Check nested hooks array (Claude Code format)
      const innerHooks = entry.hooks;
      if (Array.isArray(innerHooks)) {
        for (const h of innerHooks) {
          if (!h || !h.command) continue;
          if (!h.command.includes(MARKER)) continue;
          found = true;
          if (h.command !== desiredCommand) {
            h.command = desiredCommand;
            stalePath = true;
          }
          break;
        }
      }
      // Also check flat format for migration
      if (!found && entry.command && entry.command.includes(MARKER)) {
        found = true;
        if (entry.command !== desiredCommand) {
          entry.command = desiredCommand;
          stalePath = true;
        }
      }
      if (found) break;
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

    // Add in Claude Code-compatible nested format
    arr.push({
      matcher: "",
      hooks: [{ type: "command", command: desiredCommand }],
    });
    added++;
    changed = true;
  }

  if (added > 0 || changed) {
    writeJsonAtomic(hooksPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd TraeCode hooks → ${hooksPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
  }

  return { added, skipped, updated };
}

function unregisterTraeCodeHooks(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const hooksPath = options.hooksPath || path.join(homeDir, ".trae-cn", "hooks.json");

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
  for (const event of TRAECODE_HOOK_EVENTS) {
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
  if (!options.silent) console.log(`Clawd TraeCode hooks removed: ${removed}`);
  const result = { removed, changed, hooksPath };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  MARKER,
  registerTraeCodeHooks,
  unregisterTraeCodeHooks,
  TRAECODE_HOOK_EVENTS,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterTraeCodeHooks({});
    else registerTraeCodeHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
