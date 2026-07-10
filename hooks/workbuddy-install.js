#!/usr/bin/env node
// Merge Clawd WorkBuddy hooks into ~/.workbuddy/settings.json.
// WorkBuddy uses the CodeBuddy/Claude Code-compatible hook format:
// { matcher, hooks: [{ type, command }] }

const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  resolveNodeBin,
  buildPermissionUrl,
  DEFAULT_SERVER_PORT,
  PERMISSION_PATH,
  readRuntimePort,
  SERVER_PORTS,
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

const MARKER = "workbuddy-hook.js";
const HTTP_MARKER = "/permission";
const HTTP_HOOK_NAME = "clawd-workbuddy-permission";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".workbuddy");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "settings.json");

const WORKBUDDY_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "Notification",
  "PreCompact",
];

function isManagedPermissionUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    return parsed.protocol === "http:"
      && parsed.hostname === "127.0.0.1"
      && parsed.pathname === PERMISSION_PATH
      && parsed.searchParams.get("agent_id") === "workbuddy"
      && [...parsed.searchParams.keys()].every((key) => key === "agent_id")
      && parsed.hash === ""
      && SERVER_PORTS.includes(port);
  } catch {
    return false;
  }
}

function isManagedPermissionHook(hook) {
  if (!hook || hook.type !== "http") return false;
  return hook.name === HTTP_HOOK_NAME || isManagedPermissionUrl(hook.url);
}

function buildWorkBuddyPermissionUrl(port) {
  const parsed = new URL(buildPermissionUrl(port));
  parsed.searchParams.set("agent_id", "workbuddy");
  return parsed.toString();
}

function normalizeCustomPermissionUrl(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("WorkBuddy custom hook URL must use http or https");
  }
  return parsed.toString();
}

function registerWorkBuddyHooks(options = {}) {
  const settingsPath = options.settingsPath || path.join(os.homedir(), ".workbuddy", "settings.json");
  const workbuddyDir = path.dirname(settingsPath);

  // Unlike the upstream CodeBuddy installer, WorkBuddy is a local compatibility
  // target for this user, so create the config directory on explicit install.
  fs.mkdirSync(workbuddyDir, { recursive: true });

  const hookScript = asarUnpackedPath(path.resolve(__dirname, MARKER).replace(/\\/g, "/"));

  let settings = {};
  try {
    settings = readJsonFile(settingsPath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read settings.json: ${err.message}`);
    }
  }

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

  for (const event of WORKBUDDY_HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const arr = settings.hooks[event];
    let found = false;
    let stalePath = false;

    for (const entry of arr) {
      if (!entry || typeof entry !== "object") continue;
      const innerHooks = entry.hooks;
      if (Array.isArray(innerHooks)) {
        for (const hook of innerHooks) {
          if (!hook || typeof hook.command !== "string") continue;
          if (!commandMatchesMarker(hook.command, MARKER)) continue;
          found = true;
          if (hook.command !== desiredCommand) {
            hook.command = desiredCommand;
            stalePath = true;
          }
          break;
        }
      }
      if (!found && typeof entry.command === "string" && commandMatchesMarker(entry.command, MARKER)) {
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

    arr.push({
      matcher: "",
      hooks: [{ type: "command", command: desiredCommand }],
    });
    added++;
    changed = true;
  }

  const hookPort = readRuntimePort() || DEFAULT_SERVER_PORT;
  const permissionUrl = normalizeCustomPermissionUrl(options.customPermissionUrl)
    || buildWorkBuddyPermissionUrl(hookPort);
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
      for (const hook of innerHooks) {
        if (!hook || hook.type !== "http" || typeof hook.url !== "string") continue;
        if (!isManagedPermissionHook(hook)) continue;
        permFound = true;
        if (hook.url !== permissionUrl || hook.name !== HTTP_HOOK_NAME) {
          hook.url = permissionUrl;
          hook.name = HTTP_HOOK_NAME;
          updated++;
          changed = true;
        }
        break;
      }
    }
    if (!permFound && isManagedPermissionHook(entry)) {
      permFound = true;
      if (entry.url !== permissionUrl || entry.name !== HTTP_HOOK_NAME) {
        entry.url = permissionUrl;
        entry.name = HTTP_HOOK_NAME;
        updated++;
        changed = true;
      }
    }
    if (permFound) break;
  }
  if (!permFound) {
    settings.hooks[permEvent].push({
      matcher: "",
      hooks: [{ name: HTTP_HOOK_NAME, type: "http", url: permissionUrl, timeout: 600 }],
    });
    added++;
    changed = true;
  }

  if (changed) writeJsonAtomic(settingsPath, settings);

  if (!options.silent) {
    console.log(`Clawd WorkBuddy hooks -> ${settingsPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
  }

  return { added, skipped, updated, settingsPath };
}

function unregisterWorkBuddyHooks(options = {}) {
  const settingsPath = options.settingsPath || path.join(os.homedir(), ".workbuddy", "settings.json");

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
  for (const event of WORKBUDDY_HOOK_EVENTS) {
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
  if (!options.silent) console.log(`Clawd WorkBuddy hooks removed: ${removed}`);
  const result = { removed, changed, settingsPath };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

module.exports = {
  MARKER,
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  WORKBUDDY_HOOK_EVENTS,
  buildWorkBuddyPermissionUrl,
  normalizeCustomPermissionUrl,
  registerWorkBuddyHooks,
  unregisterWorkBuddyHooks,
  __test: { isManagedPermissionHook, isManagedPermissionUrl, normalizeCustomPermissionUrl },
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterWorkBuddyHooks({});
    else registerWorkBuddyHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
