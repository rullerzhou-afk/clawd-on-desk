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
  formatNodeHookCommand,
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

  // Fail closed on an unsupported schema: refusing to modify a hooks.json we
  // do not understand is safer than silently overwriting a foreign structure.
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(`Refusing to modify ${hooksPath}: root is not a JSON object`);
  }
  // Trae's documented hooks schema is version 1. Missing `version` is accepted
  // because Trae defaults it to 1, but any present value other than the numeric
  // version 1 is unrecognized and must not be mutated using today's assumptions.
  if (Object.prototype.hasOwnProperty.call(settings, "version") && settings.version !== 1) {
    throw new Error(
      `Refusing to modify ${hooksPath}: unsupported "version" ${JSON.stringify(settings.version)} (expected 1)`
    );
  }
  if (settings.hooks != null) {
    if (typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
      throw new Error(`Refusing to modify ${hooksPath}: "hooks" is not an object`);
    }
    for (const event of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[event])) {
        throw new Error(`Refusing to modify ${hooksPath}: "${event}" is not an array`);
      }
    }
  }

  // Resolve node path; if detection fails, preserve existing absolute path
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved
    || extractExistingNodeBin(settings, MARKER, { nested: true })
    || "node";
  // Trae executes hook commands via PowerShell on Windows and bash on POSIX
  // (verified in Trae's cloudide.icube-agent-shell-exec execCommandHook).
  // In Windows sandbox mode Trae embeds this command as a single native
  // `trae-sandbox.exe --command-line` argument. PowerShell 5.1 does not retain
  // that argv boundary when the value itself contains quoted paths, so the
  // default `C:\Program Files\nodejs\node.exe` is split before the sandbox CLI
  // can run it. Keep all quoted paths inside a UTF-16LE EncodedCommand payload;
  // the outer command then contains no quote characters for PowerShell's native
  // argv marshaller to corrupt. POSIX keeps the normal quoted form.
  //
  // The command carries no `shell` field; that field is undocumented by Trae,
  // so it is never written and any legacy field is removed on migration.
  const platform = options.platform || process.platform;
  const desiredCommand = formatNodeHookCommand(nodeBin, hookScript, {
    platform,
    windowsWrapper: "encoded",
  });

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
          if (!commandMatchesMarker(h.command, MARKER)) continue;
          found = true;
          if (h.command !== desiredCommand) {
            h.command = desiredCommand;
            stalePath = true;
          }
          // Drop the undocumented shell field this installer wrote in earlier
          // revisions — Trae does not document it and PowerShell already runs
          // the `&`-prefixed command without it.
          if (h.shell !== undefined) {
            delete h.shell;
            stalePath = true;
          }
          break;
        }
      }
      // Also check flat format for migration — convert owned flat entries to
      // the documented nested shape ({ matcher: "", hooks: [{ type, command }] })
      // instead of leaving them flat.
      if (!found && commandMatchesMarker(entry.command, MARKER)) {
        found = true;
        const index = arr.indexOf(entry);
        arr[index] = {
          matcher: "",
          hooks: [{ type: "command", command: desiredCommand }],
        };
        stalePath = true;
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
    const hookEntry = { type: "command", command: desiredCommand };
    arr.push({
      matcher: "",
      hooks: [hookEntry],
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
