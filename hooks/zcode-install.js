#!/usr/bin/env node
// Merge Clawd ZCode hooks into ~/.zcode/cli/config.json.
//
// ZCode (智谱/Z.ai) is an Electron desktop ADE. Legacy 3.4.x builds spawned a
// standalone `zcode-cli`; current macOS 3.5.x builds run Resources/glm/zcode.cjs
// through Electron's Node mode. Both read ~/.zcode/cli/config.json. Per ZCode's
// official configuration and hook documentation, config-file hooks differ from
// plugin hooks.json in three ways:
//   1. They nest under `hooks.events.<EventName>` (plugin hooks.json uses
//      `hooks.<EventName>` — DO NOT confuse the two, or config.json fails to load).
//   2. They are DISABLED by default; `hooks.enabled: true` is required.
//   3. Missing / empty / "*" matchers all match every tool. State-only hooks
//      omit the matcher because they do not need tool filtering.
// ZCode supports exactly 7 events: SessionStart, UserPromptSubmit, PreToolUse,
// PermissionRequest, PostToolUse, PostToolUseFailure, Stop (no SessionEnd /
// Notification). All 7 are registered — see ZCODE_HOOK_EVENTS below.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { resolveNodeBin } = require("./server-config");
const {
  readJsonFile,
  writeJsonAtomic,
  writeJsonAtomicWithBackup,
  asarUnpackedPath,
  formatNodeHookCommand,
  decodeWindowsEncodedCommand,
} = require("./json-utils");

// ZCode config-file hooks nest under hooks.events.<Event> (unlike Claude /
// Qwen settings.json hooks which sit directly under hooks.<Event>), so the
// shared extractExistingNodeBin() helper cannot see them. Walk hooks.events.*
// ourselves to reuse a previously-installed absolute node path.
function extractExistingZcodeNodeBin(settings, marker) {
  const events = settings && settings.hooks && settings.hooks.events;
  if (!events || typeof events !== "object") return null;
  for (const entries of Object.values(events)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        const target = extractZcodeHookTarget(h, marker);
        if (target && target.nodeBin) return target.nodeBin;
      }
    }
  }
  return null;
}

// Find the node executable path in a hook command string. Handles quoted
// forms ("..."/'...') and the PowerShell call operator (`& 'node' ...`), where
// node is NOT the first token.
function extractNodeBinFromCommand(command) {
  const tokenRegex = /"([^"]+node(?:\.exe)?)"|'([^']+node(?:\.exe)?)'|(\S*node(?:\.exe)?)/gi;
  let match;
  while ((match = tokenRegex.exec(command)) !== null) {
    const candidate = match[1] || match[2] || match[3];
    if (candidate) return candidate;
  }
  return null;
}

const MARKER = "zcode-hook.js";
// Claude Code's state hook. When a user imports their Claude config into ZCode
// (via ZCode's Hooks settings), `clawd-hook.js` entries can end up in
// ~/.zcode/cli/config.json. Because clawd-hook.js hardcodes agent_id="claude-code"
// (it does not detect the host process), a ZCode session would then produce a
// spurious Claude-Code-attributed session alongside the correct zcode one. We
// strip ONLY these Clawd-owned Claude entries from the zcode config — third-party
// hooks are untouched, and ~/.claude/settings.json is NEVER modified.
const CLAUDE_MARKER = "clawd-hook.js";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".zcode");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "cli", "config.json");

// ZCode supports exactly 7 events: SessionStart, UserPromptSubmit, PreToolUse,
// PermissionRequest, PostToolUse, PostToolUseFailure, Stop (no SessionEnd /
// Notification). Phase 2 registers all 7: the six state events plus the
// blocking PermissionRequest permission-bubble hook.
const ZCODE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "PermissionRequest",
];

function isAbsoluteNodeBin(value) {
  if (typeof value !== "string" || !value) return false;
  const normalized = value.replace(/\\/g, "/");
  const base = path.posix.basename(normalized).toLowerCase();
  return (
    (path.posix.isAbsolute(value) || path.win32.isAbsolute(value))
    && (base === "node" || base === "node.exe")
  );
}

function timeoutMsForZcodeEvent(event) {
  // State-only process hooks are synchronous, but their own bounded work is
  // much shorter: stdin 400ms + a Windows process snapshot capped at 3s + a
  // 100ms local POST. Keep enough cold-start headroom without allowing six
  // events to freeze ZCode for 30s each if a hook wedges.
  //
  // PermissionRequest blocks on the local bubble / remote approval and needs
  // the same budget qwen uses (600s hook vs 590s HTTP wait).
  //
  // IMPORTANT: ZCode's hook schema differs from Claude Code / Qwen in timeout
  // units. The `timeout` field is in SECONDS (internally ×1000), so writing
  // `timeout: 30000` would mean ~8.3 hours and block inline hooks on a hang.
  // Use `timeoutMs` (milliseconds) explicitly — it also takes precedence over
  // `timeout`. (Qwen's `timeout: 30000` is millisecond-semantic because Qwen
  // uses the Claude Code schema; do NOT copy that field across.)
  if (event === "PermissionRequest") return 600000;
  return 8000;
}

// ZCode treats a missing / empty / "*" matcher as match-all. Clawd's hooks do
// not filter by tool name — including PermissionRequest, where the match value
// is the tool name and we intentionally answer for every tool — so omit the
// matcher everywhere.
function matcherForZcodeEvent() {
  return null;
}

function isClawdHookCommand(command) {
  if (typeof command !== "string") return false;
  if (command.includes(MARKER)) return true;
  const decoded = decodeWindowsEncodedCommand(command);
  return !!(decoded && decoded.includes(MARKER));
}

function hookArgsContainMarker(hook, marker) {
  return !!(
    hook
    && Array.isArray(hook.args)
    && hook.args.some((arg) => typeof arg === "string" && arg.includes(marker))
  );
}

function isClawdZcodeHook(hook) {
  if (!hook || typeof hook !== "object") return false;
  return isClawdHookCommand(hook.command) || hookArgsContainMarker(hook, MARKER);
}

function extractZcodeHookTarget(hook, marker = MARKER) {
  if (!hook || typeof hook !== "object") return null;
  if (
    hook.type === "process"
    && typeof hook.command === "string"
    && hookArgsContainMarker(hook, marker)
  ) {
    const scriptPath = hook.args.find((arg) => typeof arg === "string" && arg.includes(marker));
    return {
      nodeBin: hook.command,
      scriptPath,
    };
  }
  if (typeof hook.command !== "string") return null;
  const decoded = decodeWindowsEncodedCommand(hook.command);
  const command = decoded && decoded.includes(marker) ? decoded : hook.command;
  if (!command.includes(marker)) return null;
  return {
    nodeBin: extractNodeBinFromCommand(command),
    scriptPath: null,
  };
}

// Detect Clawd's Claude hook (clawd-hook.js) that was imported into the zcode
// config. Matches both raw and PowerShell -EncodedCommand forms, like
// isClawdHookCommand does for the zcode marker.
function isClaudeHookCommand(command) {
  if (typeof command !== "string") return false;
  if (command.includes(CLAUDE_MARKER)) return true;
  const decoded = decodeWindowsEncodedCommand(command);
  return !!(decoded && decoded.includes(CLAUDE_MARKER));
}

function isClawdClaudeHook(hook) {
  return !!(
    hook
    && typeof hook === "object"
    && (
      isClaudeHookCommand(hook.command)
      || hookArgsContainMarker(hook, CLAUDE_MARKER)
    )
  );
}

// Strip Clawd's Claude hook entries (clawd-hook.js) migrated into the zcode
// config's hooks.events.* by a ZCode Claude-config import. This is a pure
// subtraction: clawd-hook.js uses an un-prefixed session_id + agent_id
// "claude-code", so removing it cannot merge into or corrupt any zcode
// session. Third-party hooks in the same entry are preserved.
//
// Returns { changed, removed } — removed counts stripped Clawd Claude commands
// (used only for reporting; it is NOT mixed into the register() added/updated
// counters, which track the zcode hooks specifically).
function stripMigratedClaudeHooks(events) {
  let changed = false;
  let removed = 0;
  if (!events || typeof events !== "object") return { changed, removed };

  for (const eventName of Object.keys(events)) {
    const entries = events[eventName];
    if (!Array.isArray(entries)) continue;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry || typeof entry !== "object") continue;
      if (isClawdClaudeHook(entry)) {
        entries.splice(i, 1);
        i--;
        removed++;
        changed = true;
        continue;
      }
      if (Array.isArray(entry.hooks)) {
        const before = entry.hooks.length;
        entry.hooks = entry.hooks.filter((h) => {
          if (isClawdClaudeHook(h)) {
            removed++;
            changed = true;
            return false;
          }
          return true;
        });
        // Drop the entry entirely if it was a Clawd-only Claude entry now empty.
        if (entry.hooks.length === 0 && before > 0) {
          entries.splice(i, 1);
          i--;
        }
      }
    }
    if (entries.length === 0) delete events[eventName];
  }
  return { changed, removed };
}

// Legacy command-executor builder retained for recognizing/migrating existing
// PowerShell -EncodedCommand entries and for uninstall compatibility. New
// installs use buildZcodeProcessHook() and never invoke a shell.
function buildZcodeHookCommand(nodeBin, hookScript, event, options = {}) {
  return formatNodeHookCommand(nodeBin, hookScript, {
    ...options,
    args: [event],
    windowsWrapper: "encoded",
  });
}

function buildZcodeProcessHook(nodeBin, hookScript, event, options = {}) {
  const hook = {
    type: "process",
    command: nodeBin,
    args: [hookScript, event],
    timeoutMs: timeoutMsForZcodeEvent(event),
  };
  if (options.enabled === false) hook.enabled = false;
  return hook;
}

function buildZcodeHookEntry(desiredHook, event, options = {}) {
  const matcher = matcherForZcodeEvent(event);
  const hook = {
    ...desiredHook,
    args: Array.isArray(desiredHook.args) ? [...desiredHook.args] : desiredHook.args,
  };
  // `enabled` belongs on each hook object in ZCode's schema. Preserve an
  // explicit user opt-out when normalizing a stale Clawd command; omitting the
  // field is the canonical enabled form.
  if (options.enabled === false) hook.enabled = false;
  const entry = {
    hooks: [hook],
  };
  if (matcher !== null) entry.matcher = matcher;
  return entry;
}

function replaceEntry(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function isDesiredHookEntry(entry, desiredHook, event, options = {}) {
  if (!entry || typeof entry !== "object") return false;
  const matcher = matcherForZcodeEvent(event);
  // The wrapper schema is strict: only matcher + hooks are valid. In our
  // matcherless canonical form that means exactly one `hooks` key. In
  // particular, entry-level enabled:false is invalid and must be removed;
  // the supported opt-out lives on the nested hook object.
  if (Object.keys(entry).some((key) => key !== "matcher" && key !== "hooks")) return false;
  if (matcher === null) {
    if (Object.prototype.hasOwnProperty.call(entry, "matcher")) return false;
  } else if (entry.matcher !== matcher) {
    return false;
  }
  const hook = Array.isArray(entry.hooks) ? entry.hooks[0] : null;
  return !!(
    Array.isArray(entry.hooks)
    && entry.hooks.length === 1
    && hook
    // ZCode's hook schema is strict — a "name" key makes config.json fail to
    // load. Treat any entry still carrying "name" as not-desired so a re-run
    // strips it (migration from the pre-fix form).
    && !Object.keys(hook).some((key) => (
      key !== "type"
      && key !== "command"
      && key !== "args"
      && key !== "enabled"
      && key !== "timeoutMs"
    ))
    && hook.type === "process"
    && hook.command === desiredHook.command
    && Array.isArray(hook.args)
    && hook.args.length === desiredHook.args.length
    && hook.args.every((arg, index) => arg === desiredHook.args[index])
    && (hook.enabled === false) === (options.enabled === false)
    // Must use the per-event timeoutMs (ms). A pre-fix entry carrying
    // `timeout: 30000` (8.3h under ZCode's seconds-semantics) — or a state
    // timeout on PermissionRequest — is treated as not-desired so a re-run
    // rewrites it into the correct timeoutMs form.
    && hook.timeoutMs === timeoutMsForZcodeEvent(event)
  );
}

function managedHookIntent(entries) {
  let found = 0;
  let foundEnabled = false;
  if (!Array.isArray(entries)) return { found, enabled: true };

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    // Old flat command entries are not part of ZCode's current wrapper schema.
    // Treat them as enabled while migrating; entry-level `enabled` is not a
    // supported substitute for hook.enabled.
    if (isClawdZcodeHook(entry)) {
      found++;
      foundEnabled = true;
    }
    if (!Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (!isClawdZcodeHook(hook)) continue;
      found++;
      if (hook.enabled !== false) foundEnabled = true;
    }
  }

  return {
    found,
    enabled: found === 0 || foundEnabled,
  };
}

function normalizeHookEntries(entries, desiredHook, event) {
  if (!Array.isArray(entries)) return { matched: false, changed: false };

  const intent = managedHookIntent(entries);
  const desiredOptions = { enabled: intent.enabled };
  let matched = false;
  let changed = false;
  let dedicatedIndex = -1;

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;

    if (isClawdZcodeHook(entry)) {
      matched = true;
      if (dedicatedIndex === -1) {
        replaceEntry(entry, buildZcodeHookEntry(desiredHook, event, desiredOptions));
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
      if (isClawdZcodeHook(hook)) clawdHookCount++;
      else otherHooks.push(hook);
    }
    if (clawdHookCount === 0) continue;

    matched = true;
    if (otherHooks.length > 0) {
      entry.hooks = otherHooks;
      changed = true;
      continue;
    }

    if (dedicatedIndex === -1) {
      if (!isDesiredHookEntry(entry, desiredHook, event, desiredOptions)) {
        replaceEntry(entry, buildZcodeHookEntry(desiredHook, event, desiredOptions));
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
    entries.push(buildZcodeHookEntry(desiredHook, event, desiredOptions));
    return { matched: true, changed: true };
  }

  const dedicatedEntry = entries[dedicatedIndex];
  if (!isDesiredHookEntry(dedicatedEntry, desiredHook, event, desiredOptions)) {
    replaceEntry(dedicatedEntry, buildZcodeHookEntry(desiredHook, event, desiredOptions));
    changed = true;
  }
  return { matched: true, changed };
}

function readSettings(settingsPath) {
  try {
    return readJsonFile(settingsPath);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`Failed to read config.json: ${err.message}`);
  }
}

function removeMatchingZcodeHooks(entries, predicate) {
  if (!Array.isArray(entries)) return { entries, removed: 0, changed: false };

  let removed = 0;
  let changed = false;
  const nextEntries = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      nextEntries.push(entry);
      continue;
    }
    if (predicate(entry)) {
      removed++;
      changed = true;
      continue;
    }
    if (!Array.isArray(entry.hooks)) {
      nextEntries.push(entry);
      continue;
    }
    const nextHooks = entry.hooks.filter((hook) => {
      if (!predicate(hook)) return true;
      removed++;
      changed = true;
      return false;
    });
    if (nextHooks.length === entry.hooks.length) {
      nextEntries.push(entry);
    } else if (nextHooks.length > 0) {
      nextEntries.push({ ...entry, hooks: nextHooks });
    }
  }
  return { entries: nextEntries, removed, changed };
}

function registerZcodeHooks(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const parentDir = options.parentDir || path.join(homeDir, ".zcode");
  const settingsPath = options.settingsPath || path.join(parentDir, "cli", "config.json");

  if (!options.settingsPath && !fs.existsSync(parentDir)) {
    if (!options.silent) console.log("Clawd: ~/.zcode/ not found - skipping ZCode hook registration");
    return { added: 0, skipped: 0, updated: 0, warnings: [] };
  }

  const settings = readSettings(settingsPath);
  const warnings = [];

  const hookScript = asarUnpackedPath(path.resolve(__dirname, MARKER).replace(/\\/g, "/"));
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved
    || extractExistingZcodeNodeBin(settings, MARKER);
  if (!isAbsoluteNodeBin(nodeBin)) {
    throw new Error(
      "Unable to register ZCode hooks: an absolute Node executable path is required"
    );
  }

  let changed = false;

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  // Config-file hooks are disabled by default. Default an absent/malformed
  // value to true for a fresh install, but never override an explicit false:
  // this is ZCode's global runner switch and enabling it would also reactivate
  // unrelated user hooks.
  if (settings.hooks.enabled !== true && settings.hooks.enabled !== false) {
    settings.hooks.enabled = true;
    changed = true;
  }
  if (settings.hooks.enabled === false) {
    warnings.push("hooks.enabled=false; Clawd preserves this ZCode-wide user setting, so config-file hooks will not fire.");
  }
  if (!settings.hooks.events || typeof settings.hooks.events !== "object") {
    settings.hooks.events = {};
  }
  const events = settings.hooks.events;

  // Migration (#734): if the user imported their Claude config into ZCode,
  // Clawd's Claude hook (clawd-hook.js) may already be in hooks.events.* and
  // would fire alongside zcode-hook.js — producing a spurious Claude-Code
  // session for a real ZCode session. Strip those Clawd-owned entries first
  // (third-party hooks preserved, ~/.claude/settings.json untouched).
  const migrated = stripMigratedClaudeHooks(events);
  if (migrated.changed) changed = true;

  let added = 0;
  let skipped = 0;
  let updated = 0;
  const disabledManagedEvents = [];

  // Phase 1 opt-out inheritance: when every Phase 1 managed state hook exists
  // and is explicitly enabled:false, the user opted out of Clawd's ZCode
  // hooks. The new blocking PermissionRequest hook must not silently re-enter
  // the loop — especially not as a 600s blocking hook. (Evaluated per event
  // AFTER the six state events have been normalized above, so the check sees
  // canonical managed entries. Flat managed command entries cannot express
  // the explicit opt-out and are treated as enabled, failing this check.)
  const allPhase1StateHooksExplicitlyDisabled = () => {
    for (const event of ZCODE_HOOK_EVENTS) {
      if (event === "PermissionRequest") continue;
      const intent = managedHookIntent(events[event]);
      // Every Phase 1 event must have at least one managed hook, and every
      // managed hook for that event must be explicitly disabled. A partial or
      // foreign-only config is not evidence of a six-event Clawd opt-out.
      if (intent.found === 0 || intent.enabled) return false;
    }
    return true;
  };

  // Foreign PermissionRequest conflict: ZCode runs same-event hooks serially
  // and the LAST permissionRequestResult wins, so a Clawd hook appended after
  // the user's own hook would let a Clawd allow override that hook's deny
  // (and vice versa). Never silently register ours on top of a foreign hook.
  const foreignPermissionRequestHooks = () => {
    const foreign = [];
    const entries = events.PermissionRequest;
    if (!Array.isArray(entries)) return foreign;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (!isClawdZcodeHook(entry) && typeof entry.command === "string") foreign.push(entry);
      if (!Array.isArray(entry.hooks)) continue;
      for (const hook of entry.hooks) {
        if (hook && typeof hook === "object" && !isClawdZcodeHook(hook)) foreign.push(hook);
      }
    }
    return foreign;
  };

  for (const event of ZCODE_HOOK_EVENTS) {
    const desiredHook = buildZcodeProcessHook(
      nodeBin,
      hookScript,
      event
    );

    if (event === "PermissionRequest") {
      const foreign = foreignPermissionRequestHooks();
      if (foreign.length > 0) {
        const managedIntent = managedHookIntent(events.PermissionRequest);
        if (managedIntent.found > 0) {
          // A foreign hook may be added after Clawd was already installed. A
          // warning alone still leaves the unsafe last-wins chain active, so
          // remove only Clawd-owned hooks and preserve every foreign entry.
          // When the foreign owner is later removed, a normal sync installs
          // Clawd again; no ambiguous auto-disabled state is persisted.
          const removedManaged = removeMatchingZcodeHooks(
            events.PermissionRequest,
            isClawdZcodeHook
          );
          events.PermissionRequest = removedManaged.entries;
          if (removedManaged.changed) {
            changed = true;
            updated++;
          }
          warnings.push(
            "foreign PermissionRequest hook detected; removed Clawd's blocking permission hook to prevent last-wins decisions from overriding the existing hook's deny. Remove the foreign hook and re-sync if Clawd should own PermissionRequest."
          );
        } else {
          warnings.push(
            "foreign PermissionRequest hook detected; Clawd's blocking permission hook NOT registered — ZCode runs same-event hooks serially with last-wins decisions, so a Clawd allow could override the existing hook's deny. Remove the other hook (or Clawd's) and re-sync to resolve."
          );
        }
        continue;
      }
    }

    if (!Array.isArray(events[event])) {
      events[event] = [];
      changed = true;
    }

    const existingIntent = managedHookIntent(events[event]);
    if (existingIntent.found > 0 && existingIntent.enabled === false) {
      disabledManagedEvents.push(event);
    }
    const result = normalizeHookEntries(events[event], desiredHook, event);
    if (result.changed) changed = true;

    if (result.matched) {
      // The Phase 1 opt-out must hold in BOTH directions: if the user
      // disabled the six state hooks AFTER the blocking hook was installed,
      // that same strict all-disabled condition disables the already-installed
      // PermissionRequest hook too (idempotent — an already-disabled hook is
      // left untouched).
      if (event === "PermissionRequest" && allPhase1StateHooksExplicitlyDisabled()) {
        const managedHook = events.PermissionRequest
          .flatMap((entry) => (Array.isArray(entry.hooks) ? entry.hooks : []))
          .find((hook) => isClawdZcodeHook(hook));
        if (managedHook && managedHook.enabled !== false) {
          managedHook.enabled = false;
          changed = true;
          disabledManagedEvents.push("PermissionRequest");
        }
      }
      if (result.changed) updated++;
      else skipped++;
      continue;
    }

    if (event === "PermissionRequest" && allPhase1StateHooksExplicitlyDisabled()) {
      events[event].push(buildZcodeHookEntry(desiredHook, event, { enabled: false }));
      disabledManagedEvents.push("PermissionRequest");
    } else {
      events[event].push(buildZcodeHookEntry(desiredHook, event));
    }
    added++;
    changed = true;
  }
  if (disabledManagedEvents.length > 0) {
    warnings.push(`Clawd ZCode hooks remain disabled for: ${disabledManagedEvents.join(", ")}`);
  }

  if (changed) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeJsonAtomic(settingsPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd ZCode hooks -> ${settingsPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
    if (migrated.removed > 0) {
      console.log(`  Migrated: removed ${migrated.removed} stale Clawd Claude hook(s) imported from Claude config`);
    }
    for (const warning of warnings) console.warn(`  Warning: ${warning}`);
  }

  return { added, skipped, updated, migratedClaudeHooks: migrated.removed, warnings };
}

function unregisterZcodeHooks(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const parentDir = options.parentDir || path.join(homeDir, ".zcode");
  const settingsPath = options.settingsPath || path.join(parentDir, "cli", "config.json");

  let settings = {};
  try {
    settings = readJsonFile(settingsPath);
  } catch (err) {
    if (err.code === "ENOENT") return { removed: 0, changed: false, settingsPath };
    throw new Error(`Failed to read config.json: ${err.message}`);
  }

  if (!settings.hooks || typeof settings.hooks !== "object") {
    return { removed: 0, changed: false, settingsPath };
  }
  // Config-file hooks live under hooks.events.* (unlike plugin hooks.json).
  const events = settings.hooks.events;
  if (!events || typeof events !== "object") {
    return { removed: 0, changed: false, settingsPath };
  }

  let removed = 0;
  let changed = false;
  for (const event of ZCODE_HOOK_EVENTS) {
    const entries = events[event];
    if (!Array.isArray(entries)) continue;
    const result = removeMatchingZcodeHooks(entries, isClawdZcodeHook);
    if (!result.changed) continue;
    removed += result.removed;
    changed = true;
    if (result.entries.length > 0) events[event] = result.entries;
    else delete events[event];
  }

  // Also strip any Clawd Claude hooks (clawd-hook.js) imported from a Claude
  // config — they only ever produce spurious Claude-Code sessions here, so
  // uninstalling the ZCode integration removes them too. Third-party hooks
  // remain; ~/.claude/settings.json is never touched.
  const migrated = stripMigratedClaudeHooks(events);
  if (migrated.changed) {
    removed += migrated.removed;
    changed = true;
  }

  // If Clawd was the only config-file hook source, clean up the now-empty
  // hooks wrapper (drop the enabled flag + empty events object) so the user's
  // config.json is left pristine, not carrying a stale "enabled": true.
  if (changed) {
    const remainingEvents = Object.keys(events).filter((k) => Array.isArray(events[k]) && events[k].length > 0);
    if (remainingEvents.length === 0) {
      delete settings.hooks.events;
      // Only drop `enabled` if nothing else references it; since the runner is
      // only meaningful for config-file hooks (plugin hooks auto-enable), and
      // we own the only config-file hooks, it is safe to drop here.
      if (settings.hooks.enabled !== false) delete settings.hooks.enabled;
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }
  }

  let backupPath = null;
  if (changed) backupPath = writeJsonAtomicWithBackup(settingsPath, settings, options);
  if (!options.silent) console.log(`Clawd ZCode hooks removed: ${removed}`);
  const result = { removed, changed, settingsPath };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  MARKER,
  CLAUDE_MARKER,
  ZCODE_HOOK_EVENTS,
  buildZcodeHookCommand,
  buildZcodeProcessHook,
  extractZcodeHookTarget,
  isClawdZcodeHook,
  matcherForZcodeEvent,
  registerZcodeHooks,
  unregisterZcodeHooks,
  timeoutMsForZcodeEvent,
  isClaudeHookCommand,
  stripMigratedClaudeHooks,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterZcodeHooks({});
    else registerZcodeHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
