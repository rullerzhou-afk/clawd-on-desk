#!/usr/bin/env node
// Register the Clawd pet bridge into KiroCrew's chat lifecycle hooks.
//
// KiroCrew stores hooks in ~/.kiro/crew/hooks.json as { "hooks": [ ... ] }.
// Each entry fires one of four gateway events and runs a shell command with the
// hook-event JSON on stdin and KIROCREW_HOOK_EVENT in the environment. We add
// one hook per event, all pointing at hooks/kirocrew-hook.js, so the pet reacts
// to KiroCrew gateway activity the same way it reacts to kiro-cli.
//
// This is idempotent: entries are matched only when they have the exact simple
// Node + kirocrew-hook.js command shape Clawd emits. A marker substring alone
// never authorizes updates or removal.
//
// Docs: KiroCrew "Steering files, prompts and hooks" (chat lifecycle hooks).

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { resolveNodeBin } = require("./server-config");
const { formatNodeHookCommand } = require("./json-utils");
const { isOwnedKiroCrewCommand } = require("./kirocrew-command");
const {
  acquireKiroCrewDirectoryLock,
  acquireKiroCrewLock,
  hardenOwnerOnlyFile,
  writeKiroCrewStoreAtomic,
} = require("./kirocrew-store");

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
// cmd /c on Windows); keep its Windows command wrapper specific to this runner.
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

function readHooksStore(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (err) {
    if (err.code === "ENOENT") return { hooks: [] };
    throw new Error(`Failed to inspect ${path.basename(filePath)}: ${err.message}`);
  }
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error(`${path.basename(filePath)} must be a regular file with one link`);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("hooks.json root must be an object");
    }
    if (Object.prototype.hasOwnProperty.call(raw, "hooks") && !Array.isArray(raw.hooks)) {
      throw new Error("hooks.json hooks field must be an array");
    }
    return raw;
  } catch (err) {
    throw new Error(`Failed to read ${path.basename(filePath)}: ${err.message}`);
  }
}

// Match KiroCrew's own advisory locks. The gateway lock closes startup races;
// the hooks sidecar serializes the full read/validate/merge/atomic-write with
// KiroCrew's hooks API. Both acquisitions are single-shot on Electron's main
// thread, so a concurrent writer produces an explicit retryable failure.
function acquireStoreLocks(hooksPath, options = {}) {
  const crewDir = path.dirname(hooksPath);
  const platform = options.platform || process.platform;
  if (options.force !== true && isGatewayRunning(crewDir)) {
    return { blocked: "gateway-running" };
  }
  const releaseGateway = acquireKiroCrewLock(path.join(crewDir, "gateway.lock"), { platform });
  if (!releaseGateway) return { blocked: "gateway-running" };
  let releaseHome;
  let releaseHooks;
  try {
    releaseHome = acquireKiroCrewDirectoryLock(crewDir, { platform });
    if (!releaseHome) {
      releaseGateway();
      return { blocked: "gateway-running" };
    }
    releaseHooks = acquireKiroCrewLock(`${hooksPath}.lock`, { platform });
  } catch (error) {
    if (releaseHome) releaseHome();
    releaseGateway();
    throw error;
  }
  if (!releaseHooks) {
    releaseHome();
    releaseGateway();
    return { blocked: "locked" };
  }
  return {
    release() {
      try { releaseHooks(); } finally {
        try { releaseHome(); } finally { releaseGateway(); }
      }
    },
  };
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
  if (!fs.existsSync(crewDir)) {
    return {
      status: "skipped", reason: "kirocrew-not-installed",
      message: "KiroCrew home was not found; skipped hook registration",
      added: 0, updated: 0, skipped: 0, hooksPath, gatewayRunning: false,
    };
  }

  const resolvedNodeBin =
    options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  if (typeof resolvedNodeBin !== "string" || !resolvedNodeBin.trim()) {
    return {
      status: "error", reason: "node-not-found",
      message: "Could not find a Node.js executable for KiroCrew hooks",
      added: 0, updated: 0, skipped: 0, hooksPath, gatewayRunning: false,
    };
  }
  const desiredCommand = formatHookCommand(resolvedNodeBin, getHookScriptPath(), options.platform);
  if (!isOwnedKiroCrewCommand(desiredCommand)) {
    return {
      status: "error", reason: "unsupported-hook-command",
      message: "The Node.js or hook path cannot be represented as a safe KiroCrew command",
      added: 0, updated: 0, skipped: 0, hooksPath, gatewayRunning: false,
    };
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;
  let removedObsolete = 0;
  let locks;
  try {
    locks = acquireStoreLocks(hooksPath, options);
    if (locks.blocked) {
      return {
        status: "error", reason: locks.blocked, blocked: locks.blocked,
        message: locks.blocked === "gateway-running"
          ? "The KiroCrew gateway is active or holds its lock; stop it before installing hooks"
          : "KiroCrew hooks.json is being changed by another process; retry the install",
        added: 0, updated: 0, skipped: 0, hooksPath,
        gatewayRunning: locks.blocked === "gateway-running",
      };
    }

    // Read only after holding both locks. Invalid JSON or a malformed root /
    // hooks field is an error; never reinterpret it as an empty store.
    const store = readHooksStore(hooksPath);
    store.hooks = Array.isArray(store.hooks) ? store.hooks : [];
    const before = store.hooks.length;
    store.hooks = store.hooks.filter((hook) => !(
      hook && typeof hook === "object" && hook.event === "PreToolUse"
      && isOwnedKiroCrewCommand(hook.command)
    ));
    removedObsolete = before - store.hooks.length;

    for (const event of KIROCREW_HOOK_EVENTS) {
      const existing = store.hooks.find((hook) => (
        hook && typeof hook === "object" && hook.event === event
        && isOwnedKiroCrewCommand(hook.command)
      ));
      if (existing) {
        let changed = false;
        if (existing.command !== desiredCommand) { existing.command = desiredCommand; changed = true; }
        if (existing.enabled === false) { existing.enabled = true; changed = true; }
        if (changed) updated++;
        else skipped++;
      } else {
        store.hooks.push(makeHookEntry(event, desiredCommand));
        added++;
      }
    }

    if (added > 0 || updated > 0 || removedObsolete > 0) {
      writeKiroCrewStoreAtomic(hooksPath, store, { platform: options.platform || process.platform });
    } else if (fs.existsSync(hooksPath)) {
      const platform = options.platform || process.platform;
      if (platform === "win32") {
        hardenOwnerOnlyFile(hooksPath, platform);
      } else if ((fs.statSync(hooksPath).mode & 0o777) !== 0o600) {
        fs.chmodSync(hooksPath, 0o600);
      }
    }
  } catch (err) {
    return {
      status: "error", reason: "store-write-failed",
      message: err && err.message ? err.message : "Failed to update KiroCrew hooks.json",
      added: 0, updated: 0, skipped, hooksPath, gatewayRunning: false,
    };
  } finally {
    if (locks && typeof locks.release === "function") locks.release();
  }

  if (!options.silent) {
    if (added > 0 || updated > 0 || removedObsolete > 0) {
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

  return { status: "ok", added, updated, skipped, removedObsolete, hooksPath, gatewayRunning: false };
}

/**
 * Remove the Clawd bridge from KiroCrew's hooks.json.
 * @param {object} [options]
 * @returns {{ removed: number, changed: boolean, hooksPath: string, gatewayRunning: boolean, blocked?: string }}
 */
function unregisterKiroCrewHooks(options = {}) {
  const hooksPath = options.hooksPath || DEFAULT_HOOKS_PATH;
  const crewDir = path.dirname(hooksPath);

  if (!fs.existsSync(crewDir)) {
    if (!options.silent) {
      console.log("Clawd: KiroCrew home not found — nothing to remove");
    }
    return { status: "ok", removed: 0, changed: false, registrationRemoved: true, hooksPath, gatewayRunning: false };
  }
  let removed = 0;
  let changed = false;
  let locks;
  try {
    locks = acquireStoreLocks(hooksPath, options);
    if (locks.blocked) {
      return {
        status: "error", reason: locks.blocked, blocked: locks.blocked,
        message: locks.blocked === "gateway-running"
          ? "The KiroCrew gateway is active or holds its lock; stop it before uninstalling hooks"
          : "KiroCrew hooks.json is being changed by another process; retry the uninstall",
        removed: 0, changed: false, registrationRemoved: false, hooksPath,
        gatewayRunning: locks.blocked === "gateway-running",
      };
    }
    const store = readHooksStore(hooksPath);
    store.hooks = Array.isArray(store.hooks) ? store.hooks : [];
    const before = store.hooks.length;
    store.hooks = store.hooks.filter((hook) => !(
      hook && typeof hook === "object" && typeof hook.command === "string"
      && isOwnedKiroCrewCommand(hook.command)
    ));
    removed = before - store.hooks.length;
    changed = removed > 0;
    if (changed) writeKiroCrewStoreAtomic(hooksPath, store, { platform: options.platform || process.platform });
  } catch (err) {
    return {
      status: "error", reason: "store-write-failed",
      message: err && err.message ? err.message : "Failed to update KiroCrew hooks.json",
      removed: 0, changed: false, registrationRemoved: false, hooksPath, gatewayRunning: false,
    };
  } finally {
    if (locks && typeof locks.release === "function") locks.release();
  }

  if (!options.silent) {
    console.log(`Clawd: KiroCrew hooks removed: ${removed}`);
    if (changed) {
      console.log("Clawd: start the KiroCrew gateway so the removal takes effect (it reads hooks.json at startup).");
    }
  }

  return { status: "ok", removed, changed, registrationRemoved: true, hooksPath, gatewayRunning: false };
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
    acquireStoreLocks,
    isGatewayRunning,
    isOwnedKiroCrewCommand,
  },
};

if (require.main === module) {
  const force = process.argv.includes("--force");
  try {
    const result = process.argv.includes("--uninstall")
      ? unregisterKiroCrewHooks({ force })
      : registerKiroCrewHooks({ force });
    if (!result || result.status !== "ok") {
      console.error(result && result.message ? result.message : "KiroCrew hook operation failed");
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
