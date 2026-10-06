#!/usr/bin/env node
// Register the Clawd pet bridge into KiroCrew's chat lifecycle hooks.
//
// KiroCrew stores hooks in ~/.kiro/crew/hooks.json as { "hooks": [ ... ] }.
// Each entry fires one of five gateway events and runs a shell command with the
// hook-event JSON on stdin and KIROCREW_HOOK_EVENT in the environment. We add
// one hook per event, all pointing at hooks/kirocrew-hook.js, so the pet reacts
// to KiroCrew gateway activity the same way it reacts to kiro-cli.
//
// This is idempotent and marker-based (like hooks/kiro-install.js): entries are
// matched by the `kirocrew-hook.js` marker in their command, so re-running
// updates a stale node/script path instead of duplicating hooks, and uninstall
// removes exactly our entries and nothing the user authored.
//
// Docs: KiroCrew "Steering files, prompts and hooks" (chat lifecycle hooks).

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { resolveNodeBin } = require("./server-config");
const {
  writeJsonAtomic,
  writeJsonAtomicWithBackup,
  formatNodeHookCommand,
} = require("./json-utils");

const MARKER = "kirocrew-hook.js";

// The five gateway events, and the pet state each drives (for documentation;
// the mapping itself lives in hooks/kirocrew-hook.js).
//
// PreToolUse fails CLOSED in KiroCrew: any non-zero exit denies the tool. The
// bridge is written to always exit 0 (it never blocks and swallows its own
// errors), so it is safe here — but that is a property of the script, not of
// this list, so keep the bridge's exit-0 guarantee if you ever edit it.
const KIROCREW_HOOK_EVENTS = [
  "AgentSpawn",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
];

const HOOK_TIMEOUT_SECONDS = 5; // generous for a localhost POST; well under the 300s cap

const DEFAULT_HOOKS_PATH = path.join(os.homedir(), ".kiro", "crew", "hooks.json");
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".kiro", "crew");

function getHookScriptPath() {
  let hookScript = path.resolve(__dirname, "kirocrew-hook.js").replace(/\\/g, "/");
  // In a packaged build the hooks dir is unpacked from the asar archive.
  hookScript = hookScript.replace("app.asar/", "app.asar.unpacked/");
  return hookScript;
}

// A KiroCrew hook runs in the platform's native shell (/bin/sh -c on POSIX,
// cmd /c on Windows), so the command format matches the kiro-cli installer.
function formatHookCommand(nodeBin, scriptPath, platformOverride) {
  const platform = platformOverride || process.platform;
  return formatNodeHookCommand(nodeBin, scriptPath, {
    platform,
    windowsWrapper: "cmd",
  });
}

function shortId() {
  return crypto.randomBytes(4).toString("hex");
}

function readHooksStore(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (raw && typeof raw === "object" && Array.isArray(raw.hooks)) return raw;
    // Preserve any unknown top-level keys the gateway may add later.
    if (raw && typeof raw === "object") return { ...raw, hooks: [] };
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read ${path.basename(filePath)}: ${err.message}`);
    }
  }
  return { hooks: [] };
}

function makeHookEntry(event, command) {
  return {
    id: shortId(),
    name: `Clawd pet — ${event}`,
    event,
    matcher: "", // every tool / every message
    matcher_mode: "glob",
    command,
    skills: [],
    timeout: HOOK_TIMEOUT_SECONDS,
    enabled: true,
  };
}

/**
 * Register the Clawd bridge into KiroCrew's hooks.json.
 * @param {object} [options]
 * @param {string} [options.hooksPath]
 * @param {string} [options.nodeBin]
 * @param {string} [options.platform]
 * @param {boolean} [options.silent]
 * @returns {{ added: number, updated: number, skipped: number, hooksPath: string }}
 */
function registerKiroCrewHooks(options = {}) {
  const hooksPath = options.hooksPath || DEFAULT_HOOKS_PATH;
  const crewDir = path.dirname(hooksPath);

  // Skip if ~/.kiro/crew/ doesn't exist (KiroCrew not installed).
  if (!fs.existsSync(crewDir)) {
    if (!options.silent) {
      console.log("Clawd: ~/.kiro/crew/ not found — skipping KiroCrew hook registration");
    }
    return { added: 0, updated: 0, skipped: 0, hooksPath };
  }

  const store = readHooksStore(hooksPath);
  const nodeBin =
    (options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin()) || "node";
  const desiredCommand = formatHookCommand(nodeBin, getHookScriptPath(), options.platform);

  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const event of KIROCREW_HOOK_EVENTS) {
    const existing = store.hooks.find(
      (h) =>
        h &&
        typeof h === "object" &&
        h.event === event &&
        typeof h.command === "string" &&
        h.command.includes(MARKER)
    );

    if (existing) {
      if (existing.command !== desiredCommand) {
        existing.command = desiredCommand; // refresh a stale node/script path
        updated++;
      } else {
        skipped++;
      }
      continue;
    }

    store.hooks.push(makeHookEntry(event, desiredCommand));
    added++;
  }

  if (added > 0 || updated > 0) {
    writeJsonAtomic(hooksPath, store);
  }

  if (!options.silent) {
    if (added > 0 || updated > 0) {
      console.log(
        `Clawd: KiroCrew hooks registered in ${path.basename(hooksPath)} — ` +
          `added ${added}, updated ${updated}, skipped ${skipped}`
      );
      console.log(
        "Clawd: restart the KiroCrew gateway (or reload hooks) so the new hooks take effect."
      );
    } else {
      console.log("Clawd: KiroCrew hooks already up to date");
    }
  }

  return { added, updated, skipped, hooksPath };
}

/**
 * Remove the Clawd bridge from KiroCrew's hooks.json.
 * @param {object} [options]
 * @returns {{ removed: number, changed: boolean, hooksPath: string }}
 */
function unregisterKiroCrewHooks(options = {}) {
  const hooksPath = options.hooksPath || DEFAULT_HOOKS_PATH;

  if (!fs.existsSync(hooksPath)) {
    if (!options.silent) {
      console.log("Clawd: KiroCrew hooks.json not found — nothing to remove");
    }
    return { removed: 0, changed: false, hooksPath };
  }

  const store = readHooksStore(hooksPath);
  const before = store.hooks.length;
  store.hooks = store.hooks.filter(
    (h) => !(h && typeof h.command === "string" && h.command.includes(MARKER))
  );
  const removed = before - store.hooks.length;
  const changed = removed > 0;

  if (changed) {
    if (options.backup === true) writeJsonAtomicWithBackup(hooksPath, store, options);
    else writeJsonAtomic(hooksPath, store);
  }

  if (!options.silent) {
    console.log(`Clawd: KiroCrew hooks removed: ${removed}`);
    if (changed) {
      console.log("Clawd: restart the KiroCrew gateway (or reload hooks) to drop them.");
    }
  }

  return { removed, changed, hooksPath };
}

module.exports = {
  DEFAULT_HOOKS_PATH,
  DEFAULT_PARENT_DIR,
  KIROCREW_HOOK_EVENTS,
  registerKiroCrewHooks,
  unregisterKiroCrewHooks,
  __test: {
    MARKER,
    formatHookCommand,
    getHookScriptPath,
    makeHookEntry,
    readHooksStore,
  },
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterKiroCrewHooks({});
    else registerKiroCrewHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
