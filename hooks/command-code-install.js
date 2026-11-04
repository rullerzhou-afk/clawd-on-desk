#!/usr/bin/env node
// Merge Clawd Command Code hooks into ~/.commandcode/settings.json
// (append-only, idempotent).
//
// Command Code deep-merges three settings scopes (project-local > project >
// user) and reads hooks from each; Clawd only ever touches the USER scope.
// The document shape is:
//
//   hooks: { <Event>: [ { matcher?, hooks: [ { type, command, timeout? } ] } ] }
//
// Phase 1 is state-only: the registered hook script posts state to Clawd and
// always returns `{}`, so Command Code's native permission flow stays in
// control. Ownership is marker-scoped on the command string (`command-code-hook.js`);
// foreign entries and foreign handlers inside mixed entries are preserved
// byte-for-byte, and a Clawd-only entry is rewritten to the canonical shape.
//
// `matcher` is deliberately omitted: for Stop / SessionStart a matcher makes
// the hook not fire at all, and for the tool events an absent matcher matches
// every tool. Command Code runs hook commands through `/bin/bash -c` on POSIX
// and `cmd.exe /c` on Windows, so Windows uses the shared portable wrapper
// (unquoted forward-slash node token + double-quoted paths), never
// PowerShell -EncodedCommand.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { resolveNodeBin } = require("./server-config");
const {
  readJsonFile,
  writeJsonAtomic,
  writeJsonAtomicWithBackup,
  asarUnpackedPath,
  extractExistingNodeBin,
  formatNodeHookCommand,
  decodeWindowsEncodedCommand,
} = require("./json-utils");

const MARKER = "command-code-hook.js";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".commandcode");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "settings.json");

const COMMAND_CODE_HOOK_EVENTS = Object.freeze([
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "Stop",
]);

// Bounds the passive state hook on Command Code's critical path. The hook has
// its own 2s safety timer, so 5s only guards against a wedged process.
const HOOK_TIMEOUT_SECONDS = 5;

function isClawdHookCommand(command) {
  if (typeof command !== "string") return false;
  if (command.includes(MARKER)) return true;
  // A user may have migrated the entry through a PowerShell-encoded wrapper;
  // decode before matching so the marker inside the blob is still recognized.
  const decoded = decodeWindowsEncodedCommand(command);
  return !!(decoded && decoded.includes(MARKER));
}

function buildCommandCodeHookEntry(command) {
  return {
    hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }],
  };
}

function buildCommandCodeHookCommand(nodeBin, hookScript, options = {}) {
  return formatNodeHookCommand(nodeBin, hookScript, {
    ...options,
    windowsWrapper: "portable",
  });
}

function replaceEntry(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function isDesiredCommandCodeHookEntry(entry, desiredCommand) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const keys = Object.keys(entry);
  if (keys.length !== 1 || keys[0] !== "hooks") return false;
  if (!Array.isArray(entry.hooks) || entry.hooks.length !== 1) return false;
  const hook = entry.hooks[0];
  if (!hook || typeof hook !== "object" || Array.isArray(hook)) return false;
  const hookKeys = Object.keys(hook).sort();
  if (hookKeys.length !== 3) return false;
  if (hookKeys[0] !== "command" || hookKeys[1] !== "timeout" || hookKeys[2] !== "type") return false;
  return hook.type === "command"
    && hook.command === desiredCommand
    && hook.timeout === HOOK_TIMEOUT_SECONDS;
}

// Normalize one event's entries so exactly one canonical managed entry
// remains. Foreign entries, and foreign handlers inside a mixed entry, are
// preserved; owned handlers under a non-empty matcher are stripped rather
// than rewritten (a matcher on Stop/SessionStart would stop our hook firing).
function normalizeCommandCodeHookEntries(entries, desiredCommand) {
  if (!Array.isArray(entries)) return { matched: false, changed: false };

  let matched = false;
  let changed = false;
  let dedicatedIndex = -1;

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;

    // Flat legacy Clawd entry ({ command }) — normalize into the nested shape.
    if (isClawdHookCommand(entry.command)) {
      matched = true;
      if (dedicatedIndex === -1) {
        replaceEntry(entry, buildCommandCodeHookEntry(desiredCommand));
        dedicatedIndex = index;
        changed = true;
      } else {
        entries.splice(index, 1);
        index--;
        changed = true;
      }
      continue;
    }

    if (!Array.isArray(entry.hooks)) continue;
    const otherHooks = [];
    let clawdHookCount = 0;
    for (const hook of entry.hooks) {
      if (hook && isClawdHookCommand(hook.command)) {
        clawdHookCount++;
      } else {
        otherHooks.push(hook);
      }
    }
    if (clawdHookCount === 0) continue;

    matched = true;
    // The entry mixes a Clawd hook with user hooks — strip ours, keep theirs.
    if (otherHooks.length > 0) {
      entry.hooks = otherHooks;
      changed = true;
      continue;
    }

    if (dedicatedIndex === -1) {
      if (!isDesiredCommandCodeHookEntry(entry, desiredCommand)) {
        replaceEntry(entry, buildCommandCodeHookEntry(desiredCommand));
        changed = true;
      }
      dedicatedIndex = index;
      continue;
    }

    entries.splice(index, 1);
    index--;
    changed = true;
  }

  if (!matched) return { matched: false, changed: false };

  if (dedicatedIndex === -1) {
    entries.push(buildCommandCodeHookEntry(desiredCommand));
    return { matched: true, changed: true };
  }

  const dedicatedEntry = entries[dedicatedIndex];
  if (!isDesiredCommandCodeHookEntry(dedicatedEntry, desiredCommand)) {
    replaceEntry(dedicatedEntry, buildCommandCodeHookEntry(desiredCommand));
    changed = true;
  }
  return { matched: true, changed };
}

function readSettings(settingsPath) {
  try {
    return readJsonFile(settingsPath);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`Failed to read settings.json: ${err.message}`);
  }
}

/**
 * Register Clawd hooks into ~/.commandcode/settings.json
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.settingsPath]
 * @param {string} [options.homeDir] internal override for tests
 * @param {string} [options.nodeBin] override node binary path
 * @param {string} [options.platform] override platform (tests)
 * @returns {{ added: number, skipped: number, updated: number }}
 */
function registerCommandCodeHooks(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const settingsPath = options.settingsPath || path.join(homeDir, ".commandcode", "settings.json");

  // Skip if ~/.commandcode/ doesn't exist (Command Code not installed or never
  // launched — the CLI creates the directory on first run).
  const commandCodeDir = path.dirname(settingsPath);
  if (!options.settingsPath && !fs.existsSync(commandCodeDir)) {
    if (!options.silent) console.log("Clawd: ~/.commandcode/ not found — skipping Command Code hook registration");
    return { added: 0, skipped: 0, updated: 0 };
  }

  const settings = readSettings(settingsPath);
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new Error("Invalid Command Code settings.json: top level must be an object");
  }
  const hookScript = asarUnpackedPath(path.resolve(__dirname, MARKER).replace(/\\/g, "/"));

  // Resolve node path; if detection fails, preserve any existing absolute path.
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved
    || extractExistingNodeBin(settings, MARKER, { nested: true })
    || "node";

  let added = 0;
  let skipped = 0;
  let updated = 0;
  let changed = false;

  if (settings.hooks == null) {
    settings.hooks = {};
  } else if (typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    throw new Error("Invalid Command Code settings.json: hooks must be an object keyed by event name");
  }

  for (const event of COMMAND_CODE_HOOK_EVENTS) {
    const desiredCommand = buildCommandCodeHookCommand(nodeBin, hookScript, {
      platform: options.platform || process.platform,
    });
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const result = normalizeCommandCodeHookEntries(settings.hooks[event], desiredCommand);
    if (result.changed) changed = true;

    if (result.matched) {
      if (result.changed) updated++;
      else skipped++;
      continue;
    }

    settings.hooks[event].push(buildCommandCodeHookEntry(desiredCommand));
    added++;
    changed = true;
  }

  if (changed) writeJsonAtomic(settingsPath, settings);

  if (!options.silent) {
    console.log(`Clawd Command Code hooks → ${settingsPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
  }

  return { added, skipped, updated };
}

/**
 * Remove Clawd hook entries from ~/.commandcode/settings.json
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.settingsPath]
 * @param {string} [options.homeDir] internal override for tests
 * @returns {{ removed: number, changed: boolean, settingsPath: string, backupPath?: string|null }}
 */
function unregisterCommandCodeHooks(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const settingsPath = options.settingsPath || path.join(homeDir, ".commandcode", "settings.json");

  let settings;
  try {
    settings = readJsonFile(settingsPath);
  } catch (err) {
    if (err.code === "ENOENT") {
      const result = { removed: 0, changed: false, settingsPath };
      if (options.backup === true) result.backupPath = null;
      return result;
    }
    throw new Error(`Failed to read settings.json: ${err.message}`);
  }

  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    const result = { removed: 0, changed: false, settingsPath };
    if (options.backup === true) result.backupPath = null;
    return result;
  }

  let removed = 0;
  let changed = false;

  for (const event of Object.keys(settings.hooks)) {
    const arr = settings.hooks[event];
    if (!Array.isArray(arr)) continue;

    const next = [];
    for (const entry of arr) {
      if (!entry || typeof entry !== "object") {
        next.push(entry);
        continue;
      }
      // Flat command format.
      if (isClawdHookCommand(entry.command)) {
        removed++;
        changed = true;
        continue;
      }
      // Nested hooks format.
      if (Array.isArray(entry.hooks)) {
        const otherHooks = entry.hooks.filter(
          (hook) => !(hook && typeof hook === "object" && isClawdHookCommand(hook.command))
        );
        removed += entry.hooks.length - otherHooks.length;
        if (otherHooks.length !== entry.hooks.length) {
          changed = true;
          if (otherHooks.length === 0) continue; // drop the whole entry
          entry.hooks = otherHooks;
        }
      }
      next.push(entry);
    }

    if (next.length !== arr.length) {
      // Drop the event key entirely when Clawd's handlers were all it held, so
      // uninstall does not leave `"SessionStart": []` behind in the user file.
      if (next.length === 0) delete settings.hooks[event];
      else settings.hooks[event] = next;
      changed = true;
    }
  }

  // ...and the container itself when it is only Clawd residue. A `hooks` key
  // holding anything but arrays (foreign shape) is left untouched.
  if (changed && Object.keys(settings.hooks).length === 0) delete settings.hooks;

  let backupPath = null;
  if (changed) backupPath = writeJsonAtomicWithBackup(settingsPath, settings, options);
  if (!options.silent) console.log(`Clawd Command Code hooks removed: ${removed}`);
  const result = { removed, changed, settingsPath };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

module.exports = {
  MARKER,
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  COMMAND_CODE_HOOK_EVENTS,
  HOOK_TIMEOUT_SECONDS,
  buildCommandCodeHookCommand,
  buildCommandCodeHookEntry,
  isClawdHookCommand,
  isDesiredCommandCodeHookEntry,
  normalizeCommandCodeHookEntries,
  registerCommandCodeHooks,
  unregisterCommandCodeHooks,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterCommandCodeHooks({});
    else registerCommandCodeHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
