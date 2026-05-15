#!/usr/bin/env node
// Merge Clawd Copilot CLI hooks into ~/.copilot/hooks/hooks.json
// (append-only, idempotent).
//
// Local installs are intentionally still configured by hand — Copilot CLI is
// the one supported agent for which Clawd does not auto-sync hooks at startup
// (see AGENTS.md, docs/guides/copilot-setup.md). This installer exists so the
// `scripts/remote-deploy.sh` flow can register Copilot hooks on a remote SSH
// host alongside Claude Code and Codex CLI, matching their UX.
//
// Copilot's hooks.json schema uses `bash` + `powershell` per-platform command
// strings (not the single `command` field used by Claude/Cursor), so the
// installer writes both fields. Marker-based reconciliation keeps existing
// user-authored entries untouched and rewrites only the Clawd entry.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { writeJsonAtomic, asarUnpackedPath } = require("./json-utils");

const MARKER = "copilot-hook.js";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".copilot");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "hooks", "hooks.json");

const COPILOT_HOOK_EVENTS = [
  "sessionStart",
  "userPromptSubmitted",
  "preToolUse",
  "postToolUse",
  "sessionEnd",
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
  const bash = typeof entry.bash === "string" ? entry.bash : "";
  const ps = typeof entry.powershell === "string" ? entry.powershell : "";
  return bash.includes(MARKER) || ps.includes(MARKER);
}

/**
 * Register Clawd hooks into ~/.copilot/hooks/hooks.json.
 *
 * @param {object} [options]
 * @param {boolean} [options.silent]    suppress console output (used by tests)
 * @param {string}  [options.hooksPath] override config file location (tests)
 * @param {string}  [options.homeDir]   override home dir (tests)
 * @param {string}  [options.nodeBin]   pin node binary. Remote installs default
 *                                       to this process' Node executable so
 *                                       non-interactive SSH PATH is not needed.
 * @param {string}  [options.hookScript] override absolute path to copilot-hook.js
 * @param {boolean} [options.remote]     register hooks for SSH remote mode
 * @returns {{ added: number, updated: number, skipped: number, configChanged: boolean }}
 */
function registerCopilotHooks(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const hooksPath = options.hooksPath || path.join(homeDir, ".copilot", "hooks", "hooks.json");

  // Skip if Copilot CLI isn't installed (no ~/.copilot/) — but only when caller
  // didn't explicitly override the path (tests do).
  if (!options.hooksPath) {
    const copilotDir = path.join(homeDir, ".copilot");
    let exists = false;
    try { exists = fs.statSync(copilotDir).isDirectory(); } catch {}
    if (!exists) {
      if (!options.silent) {
        console.log("Copilot CLI not installed (~/.copilot/ not found) — skipping hook registration.");
      }
      return { added: 0, updated: 0, skipped: 0, configChanged: false };
    }
  }

  const hookScript = options.hookScript
    || asarUnpackedPath(path.resolve(__dirname, "copilot-hook.js").replace(/\\/g, "/"));

  const nodeBin = options.nodeBin || (options.remote === true ? process.execPath : "node");

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
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  COPILOT_HOOK_EVENTS,
  TIMEOUT_SEC,
  buildCopilotHookCommands,
  buildCopilotHookEntry,
  registerCopilotHooks,
};

// CLI: `node hooks/copilot-install.js [--remote]`.
if (require.main === module) {
  try {
    registerCopilotHooks({ remote: process.argv.includes("--remote") });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
