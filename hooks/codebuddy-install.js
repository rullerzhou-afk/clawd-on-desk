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
const CLAWD_PERMISSION_HOOK_NAME = "clawd-on-desk.permission.v1";

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

function normalizeCustomPermissionUrl(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("permission URL must be a valid http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("permission URL must be a valid http(s) URL");
  }
  return trimmed;
}

function normalizePermissionTarget(value) {
  if (value === undefined) return { mode: "preserve" };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("permissionTarget must be an object");
  }
  if (value.mode === "local" || value.mode === "preserve") return { mode: value.mode };
  if (value.mode === "custom") {
    const url = normalizeCustomPermissionUrl(value.url);
    if (!url) throw new Error("permissionTarget custom mode requires an http(s) URL");
    return { mode: "custom", url };
  }
  throw new Error("permissionTarget.mode must be local, custom, or preserve");
}

function normalizePreservedPermissionUrl(value) {
  try {
    return normalizeCustomPermissionUrl(value);
  } catch {
    // Preserve is a best-effort compatibility mode for config that already
    // exists on disk. A malformed marker-owned URL must not prevent the
    // command hooks from being installed; repair it to the local endpoint.
    return "";
  }
}

function isManagedPermissionHook(hook) {
  if (!hook || hook.type !== "http") return false;
  return hook.name === CLAWD_PERMISSION_HOOK_NAME || isManagedPermissionUrl(hook.url);
}

function findManagedPermissionHook(entries) {
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (Array.isArray(entry.hooks)) {
      const nested = entry.hooks.find(isManagedPermissionHook);
      if (nested) return nested;
    }
    if (isManagedPermissionHook(entry)) return entry;
  }
  return null;
}

function resolvePermissionUrl(permissionTarget, existingHook, hookPort) {
  if (permissionTarget.mode === "custom") return permissionTarget.url;
  if (
    permissionTarget.mode === "preserve"
    && existingHook
    && existingHook.name === CLAWD_PERMISSION_HOOK_NAME
    && !isManagedPermissionUrl(existingHook.url)
  ) {
    return normalizePreservedPermissionUrl(existingHook.url) || buildPermissionUrl(hookPort);
  }
  return buildPermissionUrl(hookPort);
}

function parsePermissionTargetArgv(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const index = args.indexOf("--permission-url");
  if (index < 0) return { mode: "preserve" };
  const value = args[index + 1];
  if (typeof value !== "string" || !value.trim() || value.startsWith("--")) {
    throw new Error("--permission-url requires local, preserve, or an http(s) URL");
  }
  const trimmed = value.trim();
  if (trimmed === "local" || trimmed === "preserve") return { mode: trimmed };
  return { mode: "custom", url: normalizeCustomPermissionUrl(trimmed) };
}

/**
 * Register Clawd hooks into ~/.codebuddy/settings.json
 * Uses Claude Code-compatible nested format: { matcher, hooks: [{ type, command }] }
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.settingsPath]
 * @param {{ mode: "local" }|{ mode: "custom", url: string }|{ mode: "preserve" }} [options.permissionTarget]
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
  const permissionTarget = normalizePermissionTarget(options.permissionTarget);
  const permEvent = "PermissionRequest";
  if (!Array.isArray(settings.hooks[permEvent])) {
    settings.hooks[permEvent] = [];
    changed = true;
  }
  const existingPermissionHook = findManagedPermissionHook(settings.hooks[permEvent]);
  const permissionUrl = resolvePermissionUrl(permissionTarget, existingPermissionHook, hookPort);
  let permFound = false;
  for (const entry of settings.hooks[permEvent]) {
    if (!entry || typeof entry !== "object") continue;
    const innerHooks = entry.hooks;
    if (Array.isArray(innerHooks)) {
      for (const h of innerHooks) {
        if (!h || h.type !== "http") continue;
        // Only URLs we wrote ourselves are eligible for the in-place port
        // refresh; foreign endpoints are skipped and we append our own entry.
        if (!isManagedPermissionHook(h)) continue;
        permFound = true;
        if (h.name !== CLAWD_PERMISSION_HOOK_NAME) { h.name = CLAWD_PERMISSION_HOOK_NAME; changed = true; }
        if (h.url !== permissionUrl) { h.url = permissionUrl; updated++; changed = true; }
        break;
      }
    }
    if (!permFound && entry.type === "http" && isManagedPermissionHook(entry)) {
      permFound = true;
      if (entry.name !== CLAWD_PERMISSION_HOOK_NAME) { entry.name = CLAWD_PERMISSION_HOOK_NAME; changed = true; }
      if (entry.url !== permissionUrl) { entry.url = permissionUrl; updated++; changed = true; }
    }
    if (permFound) break;
  }
  if (!permFound) {
    settings.hooks[permEvent].push({
      matcher: "",
      hooks: [{ name: CLAWD_PERMISSION_HOOK_NAME, type: "http", url: permissionUrl, timeout: 600 }],
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
      isManagedPermissionHook(hook)
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
  CLAWD_PERMISSION_HOOK_NAME,
  isManagedPermissionHook,
  registerCodeBuddyHooks,
  unregisterCodeBuddyHooks,
  CODEBUDDY_HOOK_EVENTS,
  __test: {
    findManagedPermissionHook,
    isManagedPermissionHook,
    isManagedPermissionUrl,
    normalizeCustomPermissionUrl,
    normalizePreservedPermissionUrl,
    normalizePermissionTarget,
    parsePermissionTargetArgv,
    resolvePermissionUrl,
  },
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterCodeBuddyHooks({});
    else registerCodeBuddyHooks({ permissionTarget: parsePermissionTargetArgv(process.argv.slice(2)) });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
