#!/usr/bin/env node
// Merge Clawd CodeBuddy hooks into ~/.codebuddy/settings.json (append-only, idempotent)
// CodeBuddy uses Claude Code-compatible hook format: { matcher, hooks: [{ type, command }] }

const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  resolveNodeBin,
  buildPermissionUrl,
  isManagedPermissionUrl,
  DEFAULT_SERVER_PORT,
  readRuntimePort,
} = require("./server-config");
const {
  readJsonFile,
  writeJsonAtomic,
  writeJsonAtomicWithBackup,
  asarUnpackedPath,
  commandMatchesMarker,
  extractExistingNodeBin,
  removeMatchingCommandHooks,
  removeMatchingHttpHooks,
} = require("./json-utils");
const MARKER = "codebuddy-hook.js";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".codebuddy");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "settings.json");

// CodeBuddy supported hook events (as of v1.16+)
const CODEBUDDY_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "Notification",
  "PreCompact",
];

/**
 * Register Clawd hooks into ~/.codebuddy/settings.json
 * Uses Claude Code-compatible nested format: { matcher, hooks: [{ type, command }] }
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.settingsPath]
 * @returns {{ added: number, skipped: number, updated: number }}
 */
function registerCodeBuddyHooks(options = {}) {
  const settingsPath = options.settingsPath || path.join(os.homedir(), ".codebuddy", "settings.json");

  // Skip if ~/.codebuddy/ doesn't exist (CodeBuddy not installed)
  const codebuddyDir = path.dirname(settingsPath);
  if (!options.settingsPath && !fs.existsSync(codebuddyDir)) {
    if (!options.silent) console.log("Clawd: ~/.codebuddy/ not found — skipping CodeBuddy hook registration");
    return { added: 0, skipped: 0, updated: 0 };
  }

  const hookScript = asarUnpackedPath(path.resolve(__dirname, "codebuddy-hook.js").replace(/\\/g, "/"));

  let settings = {};
  try {
    settings = readJsonFile(settingsPath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read settings.json: ${err.message}`);
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

  for (const event of CODEBUDDY_HOOK_EVENTS) {
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

  // Register PermissionRequest HTTP hook (blocking, for permission bubble)
  const hookPort = readRuntimePort() || DEFAULT_SERVER_PORT;
  const permissionUrl = buildPermissionUrl(hookPort);
  const permEvent = "PermissionRequest";
  if (!Array.isArray(settings.hooks[permEvent])) {
    settings.hooks[permEvent] = [];
    changed = true;
  }
  let permFound = false;
  for (const entry of settings.hooks[permEvent]) {
    if (!entry || typeof entry !== "object") continue;
    const innerHooks = entry.hooks;
    if (Array.isArray(innerHooks)) {
      for (const h of innerHooks) {
        if (!h || h.type !== "http" || typeof h.url !== "string") continue;
        // Only URLs we wrote ourselves are eligible for the in-place port
        // refresh; foreign endpoints are skipped and we append our own entry.
        if (!isManagedPermissionUrl(h.url)) continue;
        permFound = true;
        if (h.url !== permissionUrl) { h.url = permissionUrl; updated++; changed = true; }
        break;
      }
    }
    if (!permFound && entry.type === "http" && typeof entry.url === "string" && isManagedPermissionUrl(entry.url)) {
      permFound = true;
      if (entry.url !== permissionUrl) { entry.url = permissionUrl; updated++; changed = true; }
    }
    if (permFound) break;
  }
  if (!permFound) {
    settings.hooks[permEvent].push({
      matcher: "",
      hooks: [{ type: "http", url: permissionUrl, timeout: 600 }],
    });
    added++;
    changed = true;
  }

  if (added > 0 || changed) {
    writeJsonAtomic(settingsPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd CodeBuddy hooks → ${settingsPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
  }

  return { added, skipped, updated };
}

function unregisterCodeBuddyHooks(options = {}) {
  const settingsPath = options.settingsPath || path.join(os.homedir(), ".codebuddy", "settings.json");

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
  for (const event of CODEBUDDY_HOOK_EVENTS) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    const result = removeMatchingCommandHooks(entries, (command) => commandMatchesMarker(command, MARKER));
    if (!result.changed) continue;
    removed += result.removed;
    changed = true;
    if (result.entries.length > 0) settings.hooks[event] = result.entries;
    else delete settings.hooks[event];
  }

  if (Array.isArray(settings.hooks.PermissionRequest)) {
    const result = removeMatchingHttpHooks(settings.hooks.PermissionRequest, (hook) =>
      hook && hook.type === "http" && isManagedPermissionUrl(hook.url)
    );
    if (result.changed) {
      removed += result.removed;
      changed = true;
      if (result.entries.length > 0) settings.hooks.PermissionRequest = result.entries;
      else delete settings.hooks.PermissionRequest;
    }
  }

  let backupPath = null;
  if (changed) backupPath = writeJsonAtomicWithBackup(settingsPath, settings, options);
  if (!options.silent) console.log(`Clawd CodeBuddy hooks removed: ${removed}`);
  const result = { removed, changed, settingsPath };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  registerCodeBuddyHooks,
  unregisterCodeBuddyHooks,
  CODEBUDDY_HOOK_EVENTS,
  __test: { isManagedPermissionUrl },
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterCodeBuddyHooks({});
    else registerCodeBuddyHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
