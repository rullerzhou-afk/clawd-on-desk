"use strict";

// Primary-side owner of Claude profile pets. Each enabled entry of the
// `claudeProfiles` pref runs as its own Clawd process (src/claude-profile-mode.js).
// This module only starts and stops those processes; everything a child shows
// is owned by the child itself.

const childProcess = require("child_process");
const fs = require("fs");
const { buildElectronLaunchConfig } = require("../hooks/shared-process");
const { claudeProfileRuntimeConfigPath } = require("../hooks/server-config");
const { buildProfileModeArgs } = require("./claude-profile-mode");

function buildChildLaunch(options, forwardedArgs) {
  const env = { ...(options.env || process.env) };
  delete env.ELECTRON_RUN_AS_NODE;
  if (options.isPackaged) {
    // AppImage: the running binary lives in a FUSE mount owned by this
    // process; launch the on-disk image instead (same rule as main.js).
    const command = options.appImagePath || options.execPath;
    return { command, args: [...forwardedArgs], env, cwd: undefined };
  }
  const config = buildElectronLaunchConfig(options.appPath, {
    forwardedArgs,
    env,
    platform: options.platform,
  });
  return { command: options.execPath, args: config.args, env: config.env, cwd: config.cwd };
}

// The slot only seeds a first-run position, so it never forces a restart.
function profileLaunchKey(profile) {
  return JSON.stringify([profile.configDir, profile.label]);
}

function readRuntimeOwnerPid(profile, options) {
  const filePath = claudeProfileRuntimeConfigPath(profile.configDir, options);
  if (!filePath) return null;
  try {
    const raw = JSON.parse((options.fs || fs).readFileSync(filePath, "utf8"));
    return Number.isInteger(raw && raw.ownerPid) && raw.ownerPid > 0 ? raw.ownerPid : null;
  } catch {
    return null;
  }
}

function createClaudeProfileInstances(options = {}) {
  const spawn = options.spawn || childProcess.spawn;
  const kill = options.kill || ((pid, signal) => process.kill(pid, signal));
  const log = options.log || ((msg) => console.warn(`Clawd profiles: ${msg}`));
  const settingsArg = options.settingsArg || null;
  // A primary started with --user-data-dir (dev builds, tests) must keep its
  // profile pets under that directory too.
  const inheritedArgs = (Array.isArray(options.argv) ? options.argv : [])
    .filter((arg) => typeof arg === "string" && arg.startsWith("--user-data-dir="));
  // id -> { profile, slot, key, child }
  const running = new Map();

  function spawnChild(profile, slot, extraArgs = []) {
    const launch = buildChildLaunch(options, [
      ...inheritedArgs,
      ...buildProfileModeArgs(profile, slot),
      ...extraArgs,
    ]);
    let child;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
    } catch (err) {
      log(`failed to start "${profile.id}": ${err && err.message}`);
      return null;
    }
    if (child && typeof child.on === "function") {
      child.on("error", (err) => log(`profile "${profile.id}" failed: ${err && err.message}`));
    }
    if (child && typeof child.unref === "function") child.unref();
    return child || null;
  }

  function launch(profile, slot) {
    const child = spawnChild(profile, slot);
    const entry = { profile, slot, key: profileLaunchKey(profile), child };
    running.set(profile.id, entry);
    if (child && typeof child.on === "function") {
      child.on("exit", () => {
        const current = running.get(profile.id);
        if (current && current.child === child) current.child = null;
      });
    }
  }

  // Stop the process we spawned and, when the primary restarted while a child
  // kept running, the process recorded in that profile's runtime file.
  function stopProfile(profile, child) {
    const pids = new Set();
    if (child && Number.isInteger(child.pid)) pids.add(child.pid);
    const ownerPid = readRuntimeOwnerPid(profile, options);
    if (ownerPid && ownerPid !== process.pid) pids.add(ownerPid);
    for (const pid of pids) {
      try { kill(pid, "SIGTERM"); } catch {}
    }
  }

  function stop(id) {
    const entry = running.get(id);
    if (!entry) return;
    running.delete(id);
    stopProfile(entry.profile, entry.child);
  }

  // Bring the running set in line with the pref. Slots follow list order so
  // each pet gets a distinct default position.
  function reconcile(profiles) {
    const wanted = new Map();
    (Array.isArray(profiles) ? profiles : []).forEach((profile, index) => {
      if (profile && profile.enabled !== false) wanted.set(profile.id, { profile, slot: index + 1 });
    });
    for (const [id, entry] of Array.from(running)) {
      const next = wanted.get(id);
      if (!next || profileLaunchKey(next.profile) !== entry.key) stop(id);
    }
    for (const [id, next] of wanted) {
      if (!running.has(id)) launch(next.profile, next.slot);
    }
  }

  // A second launch with the same profile arguments reaches the running child
  // through its single-instance lock; the settings flag makes it open Settings.
  function openSettings(id) {
    const entry = running.get(id);
    if (!entry) return false;
    return !!spawnChild(entry.profile, entry.slot, settingsArg ? [settingsArg] : []);
  }

  // Our spawn exits at once when a pet from an earlier primary session still
  // holds the profile's lock, so the runtime file is the better witness.
  function isRunning(id) {
    const entry = running.get(id);
    if (!entry) return false;
    if (entry.child) return true;
    const ownerPid = readRuntimeOwnerPid(entry.profile, options);
    if (!ownerPid) return false;
    try {
      kill(ownerPid, 0);
      return true;
    } catch (err) {
      return !!(err && err.code === "EPERM");
    }
  }

  function stopAll() {
    for (const id of Array.from(running.keys())) stop(id);
  }

  return { reconcile, openSettings, isRunning, stop, stopAll };
}

module.exports = {
  buildChildLaunch,
  createClaudeProfileInstances,
};
