#!/usr/bin/env node
// Merge Clawd WorkBuddy hooks into the active WorkBuddy settings.json
// (current WorkBuddy AI: ~/.workbuddy-ai; legacy WorkBuddy: ~/.workbuddy).
// WorkBuddy uses Claude Code-compatible hook format: { matcher, hooks: [{ type, command }] }

const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  resolveNodeBin,
  isManagedPermissionUrl,
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
const CURRENT_PARENT_DIR = path.join(os.homedir(), ".workbuddy-ai");
const CURRENT_CONFIG_PATH = path.join(CURRENT_PARENT_DIR, "settings.json");
const LEGACY_PARENT_DIR = path.join(os.homedir(), ".workbuddy");
const LEGACY_CONFIG_PATH = path.join(LEGACY_PARENT_DIR, "settings.json");
const DEFAULT_PARENT_DIR = CURRENT_PARENT_DIR;
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "settings.json");

function workBuddySettingsCandidates(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  return [
    {
      label: "workbuddy-ai",
      parentDir: path.join(homeDir, ".workbuddy-ai"),
      settingsPath: path.join(homeDir, ".workbuddy-ai", "settings.json"),
    },
    {
      label: "legacy",
      parentDir: path.join(homeDir, ".workbuddy"),
      settingsPath: path.join(homeDir, ".workbuddy", "settings.json"),
    },
  ];
}

// WorkBuddy AI 5.2.3 sets WORKBUDDY_CONFIG_DIR to ~/.workbuddy-ai while also
// keeping toolchain binaries under ~/.workbuddy. Directory existence alone is
// therefore ambiguous: prefer the current settings file/dir before the legacy
// one, and never let the binaries directory pull hook installation back to the
// config path the desktop runtime does not read.
function resolveWorkBuddySettingsPath(options = {}) {
  if (typeof options.settingsPath === "string" && options.settingsPath) return options.settingsPath;
  const fsImpl = options.fs || fs;
  const [current, legacy] = workBuddySettingsCandidates(options);
  if (fsImpl.existsSync(current.settingsPath) || fsImpl.existsSync(current.parentDir)) {
    return current.settingsPath;
  }
  // A bare ~/.workbuddy directory may contain only WorkBuddy's toolchain
  // binaries. Preserve genuine legacy installs only when their settings file
  // already exists; never create a dead config from directory presence alone.
  if (fsImpl.existsSync(legacy.settingsPath)) {
    return legacy.settingsPath;
  }
  return current.settingsPath;
}

// WorkBuddy supported hook events (Claude Code-compatible)
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

/**
 * Register Clawd hooks into the active WorkBuddy settings.json.
 * Uses Claude Code-compatible nested format: { matcher, hooks: [{ type, command }] }
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.settingsPath]
 * @returns {{ added: number, skipped: number, updated: number }}
 */
function registerWorkBuddyHooks(options = {}) {
  const settingsPath = resolveWorkBuddySettingsPath(options);

  // Skip if neither current nor legacy WorkBuddy config directory exists.
  const workbuddyDir = path.dirname(settingsPath);
  if (!options.settingsPath && !fs.existsSync(workbuddyDir)) {
    if (!options.silent) console.log("Clawd: WorkBuddy config directory not found — skipping hook registration");
    return { added: 0, skipped: 0, updated: 0, settingsPath };
  }

  const hookScript = asarUnpackedPath(path.resolve(__dirname, "workbuddy-hook.js").replace(/\\/g, "/"));

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

  // Legacy cleanup (state + Notification only, #618): earlier builds of this
  // installer registered a blocking PermissionRequest HTTP hook pointing at
  // Clawd's /permission endpoint. Desktop WorkBuddy resolves permissions in its
  // own native sandbox + GUI and never calls that endpoint, so we no longer
  // register it — and anyone who ran an old installer should have the dead
  // managed URL pruned. This is strictly marker-scoped: only URLs WE wrote
  // (isManagedPermissionUrl) are removed; a user's own foreign PermissionRequest
  // endpoint is left completely untouched.
  if (Array.isArray(settings.hooks.PermissionRequest)) {
    const cleanup = removeMatchingHttpHooks(settings.hooks.PermissionRequest, (hook) =>
      hook && hook.type === "http" && isManagedPermissionUrl(hook.url)
    );
    if (cleanup.changed) {
      updated += cleanup.removed;
      changed = true;
      if (cleanup.entries.length > 0) settings.hooks.PermissionRequest = cleanup.entries;
      else delete settings.hooks.PermissionRequest;
    }
  }

  if (added > 0 || changed) {
    writeJsonAtomic(settingsPath, settings);
  }

  // Only after the active config was read and (if needed) written successfully,
  // migrate marker-scoped Clawd hooks away from the inactive generation. This
  // preserves foreign hooks and prevents Settings from leaving a temporary
  // checkout reference in ~/.workbuddy after installing the live hooks into
  // ~/.workbuddy-ai. Once the active write succeeds, inactive cleanup errors
  // are warnings: throwing here would leave live hooks on disk while Settings
  // records the integration as uninstalled. A later sync/uninstall can retry
  // the stale marker cleanup without creating that disk/prefs split.
  let migratedRemoved = 0;
  let migrationBackupPaths = [];
  const migrationSkippedPaths = [];
  const migrationFailedPaths = [];
  if (!options.settingsPath) {
    const inactivePaths = workBuddySettingsCandidates(options)
      .map((candidate) => candidate.settingsPath)
      .filter((candidatePath) => candidatePath !== settingsPath && fs.existsSync(candidatePath));
    for (const inactivePath of inactivePaths) {
      try {
        const migration = unregisterWorkBuddyHooks({
          ...options,
          silent: true,
          backup: true,
          settingsPaths: [inactivePath],
        });
        migratedRemoved += migration.removed || 0;
        migrationBackupPaths.push(...(migration.backupPaths || []));
      } catch (err) {
        if (err && err.code === "INVALID_JSON") {
          migrationSkippedPaths.push(inactivePath);
          if (!options.silent) console.warn(`Clawd: skipped invalid inactive WorkBuddy config ${inactivePath}`);
        } else {
          migrationFailedPaths.push({
            settingsPath: inactivePath,
            code: err && err.code ? err.code : "UNKNOWN",
            message: err && err.message ? err.message : String(err),
          });
          if (!options.silent) console.warn(`Clawd: could not clean inactive WorkBuddy config ${inactivePath}`);
        }
      }
    }
  }

  if (!options.silent) {
    console.log(`Clawd WorkBuddy hooks → ${settingsPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
  }

  return {
    added,
    skipped,
    updated,
    settingsPath,
    migratedRemoved,
    migrationBackupPaths,
    migrationSkippedPaths,
    migrationFailedPaths,
    warnings: migrationFailedPaths.map((failure) =>
      `Could not clean inactive WorkBuddy config ${failure.settingsPath}: ${failure.message}`
    ),
  };
}

function unregisterWorkBuddyHooksAtPath(settingsPath, options = {}) {
  let settings = {};
  try {
    settings = readJsonFile(settingsPath);
  } catch (err) {
    if (err.code === "ENOENT") return { removed: 0, changed: false, settingsPath };
    const wrapped = new Error(`Failed to read settings.json: ${err.message}`);
    wrapped.code = err instanceof SyntaxError ? "INVALID_JSON" : err.code;
    wrapped.settingsPath = settingsPath;
    throw wrapped;
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
  const result = { removed, changed, settingsPath };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

/**
 * Remove marker-scoped Clawd hooks from WorkBuddy config(s). Default: current
 * and legacy generations. options.settingsPaths/settingsPath can narrow it.
 */
function unregisterWorkBuddyHooks(options = {}) {
  const paths = Array.isArray(options.settingsPaths) && options.settingsPaths.length > 0
    ? options.settingsPaths
    : options.settingsPath
      ? [options.settingsPath]
      : workBuddySettingsCandidates(options).map((candidate) => candidate.settingsPath);
  const uniquePaths = [...new Set(paths)];
  const results = uniquePaths.map((settingsPath) => unregisterWorkBuddyHooksAtPath(settingsPath, options));
  const removed = results.reduce((sum, result) => sum + (result.removed || 0), 0);
  const changed = results.some((result) => result.changed);
  if (!options.silent) console.log(`Clawd WorkBuddy hooks removed: ${removed}`);
  const primary = results.find((result) => result.changed) || results[0];
  const aggregate = {
    removed,
    changed,
    settingsPath: primary ? primary.settingsPath : uniquePaths[0],
    results,
  };
  if (options.backup === true) {
    aggregate.backupPaths = results
      .map((result) => result.backupPath)
      .filter((backupPath) => typeof backupPath === "string" && backupPath);
    aggregate.backupPath = aggregate.backupPaths[0] || null;
  }
  return aggregate;
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  CURRENT_PARENT_DIR,
  CURRENT_CONFIG_PATH,
  LEGACY_PARENT_DIR,
  LEGACY_CONFIG_PATH,
  MARKER,
  registerWorkBuddyHooks,
  unregisterWorkBuddyHooks,
  WORKBUDDY_HOOK_EVENTS,
  resolveWorkBuddySettingsPath,
  workBuddySettingsCandidates,
  __test: { isManagedPermissionUrl },
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
