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
const { writeJsonAtomic, asarUnpackedPath } = require("./json-utils");
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

const COPILOT_HOOK_EVENTS = [
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

const TIMEOUT_SEC = 5;

function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

/**
 * Build the per-event bash + powershell command strings Copilot CLI expects.
 * Both fields go into the same hook entry; Copilot picks the right one for
 * the host OS at runtime.
 */
function buildCopilotHookCommands(nodeBin, hookScript, eventName, options = {}) {
  const tail = `${quote(hookScript)} ${quote(eventName)}`;
  const command = `${quote(nodeBin)} ${tail}`;
  const bash = options.remote ? `CLAWD_REMOTE=1 ${command}` : command;
  // PowerShell needs `&` to invoke a quoted exe path as a command, otherwise
  // the quoted string is parsed as a literal.
  const powershell = options.remote
    ? `$env:CLAWD_REMOTE='1'; & ${command}`
    : `& ${command}`;
  return { bash, powershell };
}

function buildCopilotHookEntry(nodeBin, hookScript, eventName, options = {}) {
  const { bash, powershell } = buildCopilotHookCommands(nodeBin, hookScript, eventName, options);
  return {
    type: "command",
    bash,
    powershell,
    timeoutSec: TIMEOUT_SEC,
  };
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
 * @returns {{ added: number, updated: number, skipped: number, configChanged: boolean }}
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
      return { added: 0, updated: 0, skipped: 0, configChanged: false };
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
    settings = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
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

  for (const event of COPILOT_HOOK_EVENTS) {
    const desired = buildCopilotHookEntry(nodeBin, hookScript, event, {
      remote: options.remote === true,
    });

    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const arr = settings.hooks[event];
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
  }

  return { added, updated, skipped, configChanged: changed };
}

module.exports = {
  MARKER,
  COPILOT_HOOK_EVENTS,
  TIMEOUT_SEC,
  resolveCopilotHome,
  resolveCopilotHooksPath,
  resolveCopilotSettingsPath,
  buildCopilotHookCommands,
  buildCopilotHookEntry,
  registerCopilotHooks,
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
    registerCopilotHooks({ remote: process.argv.includes("--remote") });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
