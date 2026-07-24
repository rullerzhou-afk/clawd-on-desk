#!/usr/bin/env node
// Merge Clawd Copilot CLI hooks into <copilot-home>/hooks/hooks.json
// (append-only, idempotent). Called by both local startup integration sync
// and `scripts/remote-deploy.sh` for SSH remotes.
//
// Copilot's hooks.json schema uses `bash` + `powershell` per-platform command
// strings (not the single `command` field used by Claude/Cursor), so the
// installer writes both fields. Marker-based reconciliation keeps existing
// user-authored entries untouched and rewrites only the Clawd entry.
//
// `<copilot-home>` resolves to `$COPILOT_HOME` (trimmed, non-empty) when set,
// else `~/.copilot`. See `resolveCopilotHome()` below. Paths are resolved at
// call time, not at module load, so test injection of `options.env` /
// `options.homeDir` / `options.copilotHome` works.

const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  readJsonFile,
  writeJsonAtomic,
  writeJsonAtomicWithBackup,
  asarUnpackedPath,
} = require("./json-utils");
const { resolveNodeBin } = require("./server-config");

const MARKER = "copilot-hook.js";

function resolveCopilotHome(options = {}) {
  if (options && typeof options.copilotHome === "string") {
    const trimmed = options.copilotHome.trim();
    if (trimmed) return trimmed;
  }
  const env = (options && options.env) || process.env;
  if (env && typeof env.COPILOT_HOME === "string") {
    const trimmed = env.COPILOT_HOME.trim();
    if (trimmed) return trimmed;
  }
  return path.join(options.homeDir || os.homedir(), ".copilot");
}

function resolveCopilotHooksPath(options = {}) {
  return path.join(resolveCopilotHome(options), "hooks", "hooks.json");
}

function resolveCopilotSettingsPath(options = {}) {
  return path.join(resolveCopilotHome(options), "settings.json");
}

// Copilot CLI hook events are split into two purposes:
//   - state events fire-and-forget into Clawd's /state route; they MUST be
//     fast so Copilot's CLI doesn't visibly stutter on every tool call. 5s.
//   - permission events block Copilot until the user answers a Clawd bubble
//     or Clawd returns no-decision. They MUST allow a long wait. 600s.
//
// PERMISSION_HTTP_TIMEOUT_MS is the internal Clawd /permission HTTP timeout.
// It MUST stay strictly below PERMISSION_TIMEOUT_SEC × 1000 so the hook
// always returns and exits cleanly *before* Copilot kills it on timeoutSec
// expiry — Phase 0 capture confirmed Copilot 1.0.54 deadlocks the prompt
// UI when it kills a hook on timeout, instead of falling back to the
// native menu. The 60s buffer covers worst-case port discovery (remote
// mode: 5s × 5 ports = 25s) plus stdout flush, safeExit overhead, and OS
// scheduling jitter. Mirrored in hooks/copilot-hook.js to avoid a
// require-chain failure escaping main()'s try/catch (Phase 0 §4.2).
// See docs/investigations/copilot-permission-payload-2026-05.md §4.2.
const COPILOT_STATE_HOOK_EVENTS = [
  "sessionStart",
  "userPromptSubmitted",
  "preToolUse",
  "postToolUse",
  "sessionEnd",
  "errorOccurred",
  "agentStop",
  "subagentStart",
  "subagentStop",
  "preCompact",
];

const COPILOT_PERMISSION_HOOK_EVENTS = [
  "permissionRequest",
];

// Combined list kept for backward-compat exports. Doctor + tests use this
// as the "Clawd should manage these events" canonical list.
const COPILOT_HOOK_EVENTS = [
  ...COPILOT_STATE_HOOK_EVENTS,
  ...COPILOT_PERMISSION_HOOK_EVENTS,
];

const STATE_TIMEOUT_SEC = 5;
const PERMISSION_TIMEOUT_SEC = 600;
const PERMISSION_HTTP_TIMEOUT_MS = 540000;

// Backward-compat alias. External callers (tests, agent-descriptors,
// remote-ssh-deploy) may still import `TIMEOUT_SEC`. New code should
// prefer the explicit STATE/PERMISSION constants.
const TIMEOUT_SEC = STATE_TIMEOUT_SEC;

function timeoutSecForCopilotEvent(event) {
  return COPILOT_PERMISSION_HOOK_EVENTS.includes(event)
    ? PERMISSION_TIMEOUT_SEC
    : STATE_TIMEOUT_SEC;
}

function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function quoteBashEnv(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function remoteHookEnvironment(options = {}) {
  const env = options.env || process.env;
  const out = {
    CLAWD_REMOTE: "1",
  };
  const sshSecureRemote = options.sshRemote === true || env.CLAWD_SSH_REMOTE === "1";
  if (!sshSecureRemote) return out;
  out.CLAWD_SSH_REMOTE = "1";
  for (const key of [
    "CLAWD_REMOTE_IDENTITY_PATH",
    "CLAWD_SSH_SECURE_MARKER_PATH",
    "CLAWD_HOST_PREFIX_PATH",
    "CLAWD_REMOTE_LAST_LOG_PATH",
    "COPILOT_HOME",
  ]) {
    if (typeof env[key] === "string" && env[key]) out[key] = env[key];
  }
  return out;
}

/**
 * Build the per-event bash + powershell command strings Copilot CLI expects.
 * Both fields go into the same hook entry; Copilot picks the right one for
 * the host OS at runtime.
 */
function buildCopilotHookCommands(nodeBin, hookScript, eventName, options = {}) {
  const tail = `${quote(hookScript)} ${quote(eventName)}`;
  const command = `${quote(nodeBin)} ${tail}`;
  const remoteEnv = options.remote ? remoteHookEnvironment(options) : null;
  const bash = remoteEnv
    ? `${Object.entries(remoteEnv).map(([key, value]) => (
        value === "1" ? `${key}=1` : `${key}=${quoteBashEnv(value)}`
      )).join(" ")} ${command}`
    : command;
  // PowerShell needs `&` to invoke a quoted exe path as a command, otherwise
  // the quoted string is parsed as a literal.
  const powershell = remoteEnv
    ? `${Object.entries(remoteEnv).map(([key, value]) => `$env:${key}='${String(value).replace(/'/g, "''")}'`).join("; ")}; & ${command}`
    : `& ${command}`;
  return { bash, powershell };
}

function buildCopilotHookEntry(nodeBin, hookScript, eventName, options = {}) {
  const { bash, powershell } = buildCopilotHookCommands(nodeBin, hookScript, eventName, options);
  return {
    type: "command",
    bash,
    powershell,
    timeoutSec: timeoutSecForCopilotEvent(eventName),
  };
}

// Safe-v1 registration policy for `permissionRequest`:
// Copilot runs ALL permissionRequest hooks across the entire `<copilot-home>/hooks/`
// directory (per GitHub Copilot CLI docs — user-level loading merges every
// `*.json` file in that directory). Later outputs override earlier outputs,
// so blindly appending a Clawd "allow" anywhere along the chain could
// silently overwrite a user's deny coming from a different file
// (e.g. `~/.copilot/hooks/security-audit.json`).
//
// Two-layer check, both must pass:
//   1. The hooks.json `permissionRequest` array contains only Clawd entries
//      (or is empty).
//   2. No OTHER `*.json` file in the same directory declares any
//      `permissionRequest` entry — even Clawd-looking ones (Clawd never
//      writes outside hooks.json, so anything found there is user-authored).
//
// The doctor surfaces a warning when this path is hit so the user can
// opt in manually.
function isCopilotPermissionRegistrable(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return true;
  return arr.every(entryHasMarker);
}

// Return true if any `*.json` file in `<copilot-home>/hooks/` OTHER than
// `hooks.json` declares a `permissionRequest` entry. Conservative: any
// directory read or parse error is treated as "no other hook found" so a
// transient FS hiccup doesn't permanently block Clawd registration.
function hasUserPermissionHookInOtherFiles(hooksDir, hooksPath, options = {}) {
  const fsImpl = options.fs || fs;
  const HOOKS_JSON = "hooks.json";
  const targetBaseName = path.basename(hooksPath);
  let entries;
  try {
    entries = fsImpl.readdirSync(hooksDir);
  } catch {
    return false;
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    // Skip the file we're about to write — hooks.json itself is checked by
    // isCopilotPermissionRegistrable() in the registration loop.
    if (name === HOOKS_JSON || name === targetBaseName) continue;

    const fullPath = path.join(hooksDir, name);
    let raw;
    try { raw = fsImpl.readFileSync(fullPath, "utf-8"); } catch { continue; }
    // Same BOM concern as in registerCopilotHooks: a sibling file written by
    // PowerShell/Notepad-with-BOM should still be parseable.
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    if (!parsed || typeof parsed !== "object") continue;

    const hooks = parsed.hooks;
    if (!hooks || typeof hooks !== "object") continue;
    const arr = hooks.permissionRequest;
    if (Array.isArray(arr) && arr.length > 0) return true;
  }
  return false;
}

// Return true if the user-level settings.json declares an inline
// `hooks.permissionRequest` entry. Per Copilot CLI hooks reference, the
// settings.json `hooks` block participates in the same merged hook chain
// as user-level hooks/*.json and repo-level .github/hooks/*.json, so a
// user audit/deny hook here also needs to block Clawd's safe-v1 path.
//
// Same conservative posture as hasUserPermissionHookInOtherFiles: any read
// or parse error is treated as "no inline hook" so a transient FS hiccup
// doesn't permanently break Clawd registration.
function hasUserPermissionHookInSettingsJson(settingsPath, options = {}) {
  const fsImpl = options.fs || fs;
  let raw;
  try { raw = fsImpl.readFileSync(settingsPath, "utf-8"); } catch { return false; }
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return false; }
  if (!parsed || typeof parsed !== "object") return false;
  const hooks = parsed.hooks;
  if (!hooks || typeof hooks !== "object") return false;
  const arr = hooks.permissionRequest;
  return Array.isArray(arr) && arr.length > 0;
}

function entryMatches(existing, desired) {
  if (!existing || typeof existing !== "object") return false;
  return existing.type === desired.type
    && existing.bash === desired.bash
    && existing.powershell === desired.powershell
    && existing.timeoutSec === desired.timeoutSec;
}

function entryHasMarker(entry) {
  if (!entry || typeof entry !== "object") return false;
  // Match doctor's scan in findCopilotHookCommandsForEvent: any of the three
  // platform fields (bash / powershell / legacy `command`) counts. Otherwise
  // a legacy command-only Clawd entry would be missed here, the installer
  // would append a fresh bash/powershell entry, and the same Copilot event
  // would fire two HTTP state posts.
  for (const field of ["bash", "powershell", "command"]) {
    const value = entry[field];
    if (typeof value === "string" && value.includes(MARKER)) return true;
  }
  return false;
}

/**
 * Register Clawd hooks into <copilot-home>/hooks/hooks.json.
 *
 * @param {object} [options]
 * @param {boolean} [options.silent]      suppress console output (used by tests)
 * @param {string}  [options.hooksPath]   override config file location (tests)
 * @param {string}  [options.homeDir]     override home dir (tests)
 * @param {string}  [options.copilotHome] override resolved copilot home (tests)
 * @param {object}  [options.env]         override process.env (tests)
 * @param {string}  [options.nodeBin]     pin node binary. Remote installs default
 *                                         to this process' Node executable so
 *                                         non-interactive SSH PATH is not needed.
 * @param {string}  [options.hookScript]  override absolute path to copilot-hook.js
 * @param {boolean} [options.remote]      register hooks for SSH remote mode
 * @returns {{ added: number, updated: number, skipped: number, configChanged: boolean, permissionSkippedDueToUserHook: boolean }}
 */
function registerCopilotHooks(options = {}) {
  const copilotDir = resolveCopilotHome(options);
  const hooksPath = options.hooksPath || path.join(copilotDir, "hooks", "hooks.json");

  // Skip if Copilot CLI isn't installed (no <copilot-home>/) — but only when caller
  // didn't explicitly override the path (tests do).
  if (!options.hooksPath) {
    let exists = false;
    try { exists = fs.statSync(copilotDir).isDirectory(); } catch {}
    if (!exists) {
      if (!options.silent) {
        console.log(`Copilot CLI not installed (${copilotDir} not found) — skipping hook registration.`);
      }
      return { added: 0, updated: 0, skipped: 0, configChanged: false, permissionSkippedDueToUserHook: false };
    }
  }

  const hookScript = options.hookScript
    || asarUnpackedPath(path.resolve(__dirname, "copilot-hook.js").replace(/\\/g, "/"));

  // Remote installs keep using this process' Node executable so the SSH host
  // doesn't need a working PATH. Local installs go through the shared resolver
  // so Windows users get an absolute path (issue #317) instead of bare "node".
  const localResolved = options.remote === true ? null : resolveNodeBin(options);
  const nodeBin = options.nodeBin
    || (options.remote === true ? process.execPath : localResolved)
    || "node";

  let settings = {};
  try {
    settings = readJsonFile(hooksPath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read hooks.json: ${err.message}`);
    }
  }

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  if (typeof settings.version !== "number") settings.version = 1;

  let added = 0;
  let updated = 0;
  let skipped = 0;
  let changed = false;
  let permissionSkippedDueToUserHook = false;

  // Pre-compute the cross-file safe-v1 signal once before the per-event
  // loop. Re-checking inside the loop would re-read the directory for every
  // event, but only permissionRequest cares.
  //
  // Two user-level locations participate in the merged Copilot hook chain
  // alongside hooks.json: sibling *.json files in the same hooks/ dir, and
  // the inline `hooks` block in user-level settings.json. Repo-level
  // .github/hooks/*.json also merges, but the installer doesn't know the
  // user's future cwd — the hook runtime in copilot-hook.js handles that
  // case at request time.
  const hooksDir = path.dirname(hooksPath);
  const settingsPath = options.settingsPath || resolveCopilotSettingsPath(options);
  const hasOtherFilePermissionHook = hasUserPermissionHookInOtherFiles(hooksDir, hooksPath);
  const hasInlineSettingsHook = hasUserPermissionHookInSettingsJson(settingsPath);

  for (const event of COPILOT_HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const arr = settings.hooks[event];

    // Safe-v1: for permissionRequest only, refuse to add or update the Clawd
    // entry if EITHER the in-file array carries a non-Clawd entry OR any
    // other `*.json` file in the same hooks directory declares any
    // permissionRequest hook. Copilot merges hooks across every file in the
    // directory and runs them all; appending Clawd anywhere could silently
    // weaken a user-authored deny.
    //
    // We don't just `continue`: a Clawd entry registered by an earlier run
    // (before the user added their audit/deny hook) would still sit in the
    // merged hook chain and could override that deny. So when safe-v1
    // trips, also strip out every existing Clawd-managed entry from this
    // array. The user's entries are preserved byte-for-byte. Doctor surfaces
    // a warning afterwards so the user can wire Clawd in manually if they
    // want to.
    if (event === "permissionRequest"
        && (!isCopilotPermissionRegistrable(arr)
            || hasOtherFilePermissionHook
            || hasInlineSettingsHook)) {
      permissionSkippedDueToUserHook = true;
      const beforeLen = arr.length;
      const cleaned = arr.filter((entry) => !entryHasMarker(entry));
      if (cleaned.length !== beforeLen) {
        settings.hooks[event] = cleaned;
        changed = true;
      }
      skipped++;
      continue;
    }

    const desired = buildCopilotHookEntry(nodeBin, hookScript, event, {
      remote: options.remote === true,
      sshRemote: options.sshRemote === true,
      env: options.env || process.env,
    });

    const idx = arr.findIndex(entryHasMarker);

    if (idx === -1) {
      arr.push(desired);
      added++;
      changed = true;
      continue;
    }

    if (entryMatches(arr[idx], desired)) {
      skipped++;
    } else {
      arr[idx] = desired;
      updated++;
      changed = true;
    }
  }

  if (changed) {
    writeJsonAtomic(hooksPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd Copilot hooks → ${hooksPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
    if (permissionSkippedDueToUserHook) {
      console.log(`  Note: permissionRequest left untouched because a non-Clawd hook is already registered.`);
    }
  }

  return { added, updated, skipped, configChanged: changed, permissionSkippedDueToUserHook };
}

function unregisterCopilotHooks(options = {}) {
  const copilotDir = resolveCopilotHome(options);
  const hooksPath = options.hooksPath || path.join(copilotDir, "hooks", "hooks.json");

  let settings = {};
  try {
    settings = readJsonFile(hooksPath);
  } catch (err) {
    if (err.code === "ENOENT") return { removed: 0, changed: false, configChanged: false, hooksPath };
    throw new Error(`Failed to read hooks.json: ${err.message}`);
  }

  if (!settings.hooks || typeof settings.hooks !== "object") {
    return { removed: 0, changed: false, configChanged: false, hooksPath };
  }

  let removed = 0;
  let changed = false;
  for (const event of Object.keys(settings.hooks)) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    const next = entries.filter((entry) => !entryHasMarker(entry));
    if (next.length === entries.length) continue;
    removed += entries.length - next.length;
    changed = true;
    if (next.length > 0) settings.hooks[event] = next;
    else delete settings.hooks[event];
  }

  let backupPath = null;
  if (changed) backupPath = writeJsonAtomicWithBackup(hooksPath, settings, options);
  if (!options.silent) console.log(`Clawd Copilot hooks removed: ${removed}`);
  const result = { removed, changed, configChanged: changed, hooksPath };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

module.exports = {
  MARKER,
  COPILOT_HOOK_EVENTS,
  COPILOT_STATE_HOOK_EVENTS,
  COPILOT_PERMISSION_HOOK_EVENTS,
  TIMEOUT_SEC,
  STATE_TIMEOUT_SEC,
  PERMISSION_TIMEOUT_SEC,
  PERMISSION_HTTP_TIMEOUT_MS,
  timeoutSecForCopilotEvent,
  isCopilotPermissionRegistrable,
  hasUserPermissionHookInOtherFiles,
  hasUserPermissionHookInSettingsJson,
  resolveCopilotHome,
  resolveCopilotHooksPath,
  resolveCopilotSettingsPath,
  buildCopilotHookCommands,
  buildCopilotHookEntry,
  registerCopilotHooks,
  unregisterCopilotHooks,
};

// Lazy-getter exports for back-compat — values reflect current env at access time.
Object.defineProperty(module.exports, "DEFAULT_PARENT_DIR", {
  enumerable: true,
  get() { return resolveCopilotHome(); },
});
Object.defineProperty(module.exports, "DEFAULT_CONFIG_PATH", {
  enumerable: true,
  get() { return resolveCopilotHooksPath(); },
});

// CLI: `node hooks/copilot-install.js [--remote]`.
if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterCopilotHooks({});
    else registerCopilotHooks({ remote: process.argv.includes("--remote") });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
