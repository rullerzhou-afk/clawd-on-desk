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

// The four gateway events we register, and the pet state each drives (for
// documentation; the mapping itself lives in hooks/kirocrew-hook.js).
//
// PreToolUse is intentionally NOT registered. It fails CLOSED in KiroCrew: any
// exit other than 0 or 2 denies the tool on the approval path. The bridge's
// exit-0 guarantee only holds once Node has started — a missing script (exit
// 1), a stale node path (127), or a governance policy that disables
// script_hooks (returns 2) would all deny tool calls. The remaining four
// events only warn on failure and are sufficient to drive the pet.
const KIROCREW_HOOK_EVENTS = [
  "AgentSpawn",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
];

const HOOK_TIMEOUT_SECONDS = 5; // generous for a localhost POST; well under the 300s cap

// KiroCrew's home is ~/.kiro/crew by default but is relocatable via
// KIROCREW_HOME (the one gateway env var a hook does inherit). Honor it so the
// installer, Doctor and cleanup all target the same directory the gateway uses.
function kirocrewHome() {
  const fromEnv = process.env.KIROCREW_HOME;
  if (fromEnv && typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  return path.join(os.homedir(), ".kiro", "crew");
}

const DEFAULT_PARENT_DIR = kirocrewHome();
const DEFAULT_HOOKS_PATH = path.join(DEFAULT_PARENT_DIR, "hooks.json");

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

// A running gateway owns hooks.json: it reads the file once at startup and
// rewrites its in-memory list back after every hook fires, so a direct write
// here is reconciled away (an Install that adds 5 entries shows 0 on disk after
// the next event). KiroCrew records the gateway's PID in ~/.kiro/crew/gateway.lock.
// If that PID is alive, the only safe mutation path is the gateway's own Hooks
// page (/api/hooks); the direct-file installer must refuse rather than write
// entries the gateway will clobber (or, on uninstall, restore). This is why the
// dashboard Install button only drives this installer while the gateway is down.
function isGatewayRunning(crewDir) {
  try {
    const raw = fs.readFileSync(path.join(crewDir, "gateway.lock"), "utf-8").trim();
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0); // throws if the process is gone / not signalable
    return true;
  } catch (err) {
    // ENOENT (no lock) or ESRCH (stale pid) → gateway not running. EPERM means
    // the pid exists but is owned by another user: treat as running (be safe).
    return err && err.code === "EPERM";
  }
}

// Acquire KiroCrew's own advisory lock (~/.kiro/crew/hooks.json.lock) before a
// write, so we never race a gateway that is starting up. mkdir is atomic and
// cross-platform; a stale lock older than STALE_LOCK_MS is reclaimed.
const STALE_LOCK_MS = 30_000;
function acquireHooksLock(hooksPath) {
  const lockDir = `${hooksPath}.lock.d`;
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      return () => { try { fs.rmdirSync(lockDir); } catch {} };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const age = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (age > STALE_LOCK_MS) { fs.rmdirSync(lockDir); continue; }
      } catch {}
      if (Date.now() > deadline) return null; // could not acquire in time
      // brief spin; this path is only hit under a concurrent writer
    }
  }
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
    return { added: 0, updated: 0, skipped: 0, hooksPath, gatewayRunning: false };
  }

  // Refuse to write while the gateway is running — it would reconcile our
  // entries away. The caller (dashboard Install button / CLI) surfaces this.
  if (options.force !== true && isGatewayRunning(crewDir)) {
    if (!options.silent) {
      console.log(
        "Clawd: the KiroCrew gateway is running — it owns hooks.json and would revert a direct write."
      );
      console.log(
        "Clawd: stop the gateway (quit the KiroCrew app), then install; or add the hooks from KiroCrew's own Hooks page."
      );
    }
    return {
      added: 0,
      updated: 0,
      skipped: 0,
      hooksPath,
      gatewayRunning: true,
      blocked: "gateway-running",
    };
  }

  const store = readHooksStore(hooksPath);
  // When node can't be resolved, other installers KEEP the existing command
  // rather than writing a bare "node" (which may not be on the gateway's
  // allowlisted PATH). resolveNodeBin() returns null in that case; we mirror
  // it: refresh/create only when we have a real node binary, otherwise leave an
  // existing entry untouched and skip creating a new one with a bare "node".
  const resolvedNodeBin =
    options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const haveNodeBin = !!resolvedNodeBin;
  const desiredCommand = haveNodeBin
    ? formatHookCommand(resolvedNodeBin, getHookScriptPath(), options.platform)
    : null;

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
      if (desiredCommand && existing.command !== desiredCommand) {
        existing.command = desiredCommand; // refresh a stale node/script path
        updated++;
      } else {
        skipped++;
      }
      continue;
    }

    if (!desiredCommand) {
      // No node binary and no existing entry to keep — skip rather than write a
      // bare "node" the gateway's allowlisted PATH may not resolve.
      skipped++;
      continue;
    }
    store.hooks.push(makeHookEntry(event, desiredCommand));
    added++;
  }

  if (added > 0 || updated > 0) {
    const release = acquireHooksLock(hooksPath);
    if (!release) {
      return { added: 0, updated: 0, skipped, hooksPath, gatewayRunning: false, blocked: "locked" };
    }
    try {
      writeJsonAtomic(hooksPath, store);
    } finally {
      release();
    }
  }

  if (!options.silent) {
    if (added > 0 || updated > 0) {
      console.log(
        `Clawd: KiroCrew hooks registered in ${path.basename(hooksPath)} — ` +
          `added ${added}, updated ${updated}, skipped ${skipped}`
      );
      console.log(
        "Clawd: start the KiroCrew gateway so the new hooks load (it reads hooks.json at startup)."
      );
    } else {
      console.log("Clawd: KiroCrew hooks already up to date");
    }
  }

  return { added, updated, skipped, hooksPath, gatewayRunning: false };
}

/**
 * Remove the Clawd bridge from KiroCrew's hooks.json.
 * @param {object} [options]
 * @returns {{ removed: number, changed: boolean, hooksPath: string, gatewayRunning: boolean, blocked?: string }}
 */
function unregisterKiroCrewHooks(options = {}) {
  const hooksPath = options.hooksPath || DEFAULT_HOOKS_PATH;
  const crewDir = path.dirname(hooksPath);

  if (!fs.existsSync(hooksPath)) {
    if (!options.silent) {
      console.log("Clawd: KiroCrew hooks.json not found — nothing to remove");
    }
    return { removed: 0, changed: false, hooksPath, gatewayRunning: false };
  }

  // Refuse while the gateway is running: it holds the hooks in memory and
  // rewrites them back after the next event, so a removal here is undone (and
  // "uninstall, then remove Clawd" would leave stale entries behind).
  if (options.force !== true && isGatewayRunning(crewDir)) {
    if (!options.silent) {
      console.log(
        "Clawd: the KiroCrew gateway is running — it would restore removed hooks after the next event."
      );
      console.log(
        "Clawd: stop the gateway (quit the KiroCrew app), then uninstall; or remove the hooks from KiroCrew's own Hooks page."
      );
    }
    return { removed: 0, changed: false, hooksPath, gatewayRunning: true, blocked: "gateway-running" };
  }

  const store = readHooksStore(hooksPath);
  const before = store.hooks.length;
  store.hooks = store.hooks.filter(
    (h) => !(h && typeof h.command === "string" && h.command.includes(MARKER))
  );
  const removed = before - store.hooks.length;
  const changed = removed > 0;

  if (changed) {
    const release = acquireHooksLock(hooksPath);
    if (!release) {
      return { removed: 0, changed: false, hooksPath, gatewayRunning: false, blocked: "locked" };
    }
    try {
      if (options.backup === true) writeJsonAtomicWithBackup(hooksPath, store, options);
      else writeJsonAtomic(hooksPath, store);
    } finally {
      release();
    }
  }

  if (!options.silent) {
    console.log(`Clawd: KiroCrew hooks removed: ${removed}`);
    if (changed) {
      console.log("Clawd: start the KiroCrew gateway so the removal takes effect (it reads hooks.json at startup).");
    }
  }

  return { removed, changed, hooksPath, gatewayRunning: false };
}

module.exports = {
  DEFAULT_HOOKS_PATH,
  DEFAULT_PARENT_DIR,
  KIROCREW_HOOK_EVENTS,
  registerKiroCrewHooks,
  unregisterKiroCrewHooks,
  isGatewayRunning,
  __test: {
    MARKER,
    formatHookCommand,
    getHookScriptPath,
    makeHookEntry,
    readHooksStore,
    acquireHooksLock,
    isGatewayRunning,
  },
};

if (require.main === module) {
  const force = process.argv.includes("--force");
  try {
    if (process.argv.includes("--uninstall")) unregisterKiroCrewHooks({ force });
    else registerKiroCrewHooks({ force });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
