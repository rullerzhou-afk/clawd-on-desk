"use strict";

// ── Remote SSH IPC ──
//
// Wires `window.remoteSsh.*` invokes to the runtime + deploy module, and
// pushes runtime status / deploy progress events back to all renderer windows.
//
// Profile CRUD is NOT here — that flows through `settings:command` to keep
// settings-controller as the only writer. This module only handles runtime
// state (Connect / Disconnect / Deploy / Authenticate / Open Terminal) plus
// status / progress event push.
//
// Event push: events fire on every renderer window (settings, dashboard, etc)
// — same pattern as settings-changed broadcasts.

const childProcess = require("child_process");
const { deploy, startCodexMonitor, stopCodexMonitor } = require("./remote-ssh-deploy");
const { buildSshArgs } = require("./remote-ssh-runtime");
const {
  quoteForCmd,
  quoteForPosixShellArg,
  escapeAppleScriptString,
} = require("./remote-ssh-quote");

function requireDep(value, name) {
  if (!value) throw new Error(`registerRemoteSshIpc requires ${name}`);
  return value;
}

function findProfile(settingsController, profileId) {
  const snap = settingsController.getSnapshot();
  const list = (snap.remoteSsh && Array.isArray(snap.remoteSsh.profiles)) ? snap.remoteSsh.profiles : [];
  return list.find((p) => p.id === profileId) || null;
}

function broadcast(BrowserWindow, channel, payload) {
  try {
    for (const bw of BrowserWindow.getAllWindows()) {
      if (!bw.isDestroyed() && bw.webContents && !bw.webContents.isDestroyed()) {
        bw.webContents.send(channel, payload);
      }
    }
  } catch {
    // Best-effort — don't let broadcast errors crash the runtime.
  }
}

function registerRemoteSshIpc(options = {}) {
  const ipcMain = requireDep(options.ipcMain, "ipcMain");
  const settingsController = requireDep(options.settingsController, "settingsController");
  const remoteSshRuntime = requireDep(options.remoteSshRuntime, "remoteSshRuntime");
  const BrowserWindow = requireDep(options.BrowserWindow, "BrowserWindow");
  const platform = options.platform || process.platform;
  const spawn = options.spawn || childProcess.spawn;
  const log = options.log || (() => {});
  const isPackaged = !!options.isPackaged;
  const hooksDir = options.hooksDir;
  // Test-only injection points. Production main.js never overrides these.
  const deployFn = options.deployFn || deploy;
  const startCodexMonitorFn = options.startCodexMonitorFn || startCodexMonitor;
  const stopCodexMonitorFn = options.stopCodexMonitorFn || stopCodexMonitor;

  const disposers = [];

  function handle(channel, listener) {
    ipcMain.handle(channel, listener);
    disposers.push(() => {
      try { ipcMain.removeHandler(channel); } catch {}
    });
  }

  // Bridge runtime emitter → IPC broadcasts.
  const onStatusChanged = (snap) => {
    broadcast(BrowserWindow, "remoteSsh:status-changed", snap);
  };
  const onProgress = (payload) => {
    broadcast(BrowserWindow, "remoteSsh:progress", payload);
  };
  const onRemoteNodeDetected = (payload) => {
    settingsController.applyCommand("remoteSsh.markRemoteNode", payload)
      .then((r) => {
        if (r && r.noop && r.reason === "target_drift") {
          log("remote-ssh: remote node stamp skipped due to target drift on", r.targetDrift);
        } else if (!r || r.status !== "ok") {
          log("remote-ssh: failed to stamp remote node:", (r && r.message) || "non-ok result");
        }
      })
      .catch((err) => log("remote-ssh: failed to stamp remote node:", err && err.message));
  };
  remoteSshRuntime.on("status-changed", onStatusChanged);
  remoteSshRuntime.on("progress", onProgress);
  remoteSshRuntime.on("remote-node-detected", onRemoteNodeDetected);
  disposers.push(() => {
    remoteSshRuntime.off("status-changed", onStatusChanged);
    remoteSshRuntime.off("progress", onProgress);
    remoteSshRuntime.off("remote-node-detected", onRemoteNodeDetected);
  });

  // ── Status / list ──

  handle("remoteSsh:list-statuses", () => {
    return { status: "ok", statuses: remoteSshRuntime.listStatuses() };
  });

  handle("remoteSsh:status", (_event, payload) => {
    const id = typeof payload === "string" ? payload : (payload && payload.profileId);
    if (typeof id !== "string" || !id) {
      return { status: "error", message: "remoteSsh:status requires { profileId }" };
    }
    return { status: "ok", state: remoteSshRuntime.getProfileStatus(id) };
  });

  // ── Connect / Disconnect ──

  // Shared connect path: start the tunnel and, if opted in, the codex monitor.
  // Used by both the manual `remoteSsh:connect` IPC handler and the
  // connect-on-launch sweep so they behave identically. Throws if
  // runtime.connect throws; the codex monitor is best-effort and never blocks.
  function connectProfile(profile) {
    remoteSshRuntime.connect(profile);
    if (profile.autoStartCodexMonitor === true) {
      startCodexMonitorFn({ profile, runtime: remoteSshRuntime, deps: { spawn } })
        .catch((err) => log("codex monitor start failed:", err && err.message));
    }
  }

  handle("remoteSsh:connect", async (_event, payload) => {
    const id = typeof payload === "string" ? payload : (payload && payload.profileId);
    const profile = id ? findProfile(settingsController, id) : null;
    if (!profile) return { status: "error", message: "profile not found" };
    try {
      connectProfile(profile);
      return { status: "ok", state: remoteSshRuntime.getProfileStatus(id) };
    } catch (err) {
      return { status: "error", message: (err && err.message) || "connect threw" };
    }
  });

  handle("remoteSsh:disconnect", async (_event, payload) => {
    const id = typeof payload === "string" ? payload : (payload && payload.profileId);
    if (typeof id !== "string" || !id) {
      return { status: "error", message: "remoteSsh:disconnect requires { profileId }" };
    }
    try {
      const profile = findProfile(settingsController, id);
      remoteSshRuntime.disconnect(id);
      // Best-effort cleanup of remote codex monitor if profile had it on.
      if (profile && profile.autoStartCodexMonitor === true) {
        stopCodexMonitorFn({ profile, runtime: remoteSshRuntime, deps: { spawn } })
          .catch((err) => log("codex monitor stop failed:", err && err.message));
      }
      return { status: "ok", state: remoteSshRuntime.getProfileStatus(id) };
    } catch (err) {
      return { status: "error", message: (err && err.message) || "disconnect threw" };
    }
  });

  // ── Deploy ──

  handle("remoteSsh:deploy", async (_event, payload) => {
    const id = typeof payload === "string" ? payload : (payload && payload.profileId);
    const profile = id ? findProfile(settingsController, id) : null;
    if (!profile) return { status: "error", message: "profile not found" };
    try {
      const result = await deployFn({
        profile,
        runtime: remoteSshRuntime,
        deps: { spawn, hooksDir, isPackaged },
      });
      if (result.ok) {
        // Stamp via remoteSsh.markDeployed (NOT remoteSsh.update with a full
        // profile snapshot). Deploy can take 30+ seconds, during which the
        // user might edit the profile via Settings — full-snapshot update
        // would clobber those edits with the pre-deploy state (lost-update
        // race). markDeployed reads the current profile by id and only
        // mutates lastDeployedAt.
        //
        // expectedTarget is a fingerprint captured at deploy start. If the
        // user changed host / port / identityFile / remoteForwardPort /
        // hostPrefix mid-deploy, the deploy ran against the old target —
        // markDeployed no-ops in that case so we don't falsely claim the
        // new (drifted) configuration is "deployed".
        const expectedTarget = {
          host: profile.host,
          port: profile.port,
          identityFile: profile.identityFile,
          remoteForwardPort: profile.remoteForwardPort,
          hostPrefix: profile.hostPrefix,
        };
        try {
          const stamp = await settingsController.applyCommand("remoteSsh.markDeployed", {
            id: profile.id,
            deployedAt: Date.now(),
            expectedTarget,
            remoteNode: result.remoteNode,
          });
          if (stamp && stamp.noop && stamp.reason === "target_drift") {
            log("remote-ssh: deploy stamp skipped due to target drift on", stamp.targetDrift);
            // Surface drift to caller so the UI can prompt the user to redeploy
            // against the new target. We still return "ok" because the deploy
            // itself succeeded — only the lastDeployedAt stamp was skipped to
            // avoid mislabeling the new (drifted) config as "deployed".
            return { status: "ok", warning: "target_drift", driftedField: stamp.targetDrift };
          }
          if (!stamp || stamp.status !== "ok") {
            // Stamp returned an error object (validator / persist failed) —
            // applyCommand doesn't throw for these, it returns { status:"error" }.
            // Without this branch the UI would falsely show "Deploy succeeded"
            // while lastDeployedAt was never persisted. Surface as warning so
            // the user knows the deploy ran but the timestamp is stale.
            const msg = (stamp && stamp.message) || "stamp returned non-ok";
            log("remote-ssh: failed to stamp lastDeployedAt:", msg);
            return { status: "ok", warning: "stamp_failed", message: msg };
          }
        } catch (err) {
          const msg = (err && err.message) || "stamp threw";
          log("remote-ssh: failed to stamp lastDeployedAt:", msg);
          return { status: "ok", warning: "stamp_failed", message: msg };
        }
        return { status: "ok" };
      }
      return {
        status: "error",
        message: result.message,
        step: result.step,
        reason: result.reason || null,
        hint: result.hint || null,
      };
    } catch (err) {
      return { status: "error", message: (err && err.message) || "deploy threw" };
    }
  });

  // ── Authenticate / Open Terminal ──
  //
  // Both spawn the system terminal with `ssh -o BatchMode=no <profile>`. The
  // Authenticate UX framing exists for "first-time host key / passphrase";
  // Open Terminal is the same command path with a "general use" framing.

  function buildInteractiveSshArgs(profile) {
    // interactive: true uses SSH_INTERACTIVE_BASE_OPTS (empty) so there's no
    // BatchMode=yes / ConnectTimeout / -T in the base. The explicit
    // `-o BatchMode=no` here is the FIRST BatchMode token ssh sees and wins
    // (ssh -o is first-wins; see buildSshArgs comment). That also beats a
    // `BatchMode yes` in the user's ~/.ssh/config, since command-line -o
    // precedes config file entries in the resolution order.
    return buildSshArgs(profile, {
      extraOpts: ["-o", "BatchMode=no"],
      interactive: true,
    });
  }

  // ── Terminal launch helper ──
  //
  // Async because `child_process.spawn(missingExe)` does NOT throw
  // synchronously on ENOENT — it returns a child that emits an async
  // 'error' event. If we returned `{ ok: true }` after a synchronous spawn
  // call and never listened for that error, two bad things happen:
  //   1. The fallback chain (wt → cmd, gnome → konsole → xterm) is never
  //      triggered when the first candidate is missing.
  //   2. An EventEmitter 'error' with no listener becomes an
  //      `uncaughtException` and crashes the Electron main process.
  //
  // `tryLaunch` waits for either 'spawn' (success) or 'error' (failure),
  // then either claims the child + swallows future errors, or reports the
  // failure so the caller can try the next candidate.

  function tryLaunch(bin, args, opts) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(bin, args, opts);
      } catch (err) {
        // Truly synchronous failure (rare; Windows on certain options).
        resolve({ ok: false, error: err });
        return;
      }
      let resolved = false;
      // Always attach an 'error' listener BEFORE returning so a
      // post-success error doesn't escalate to uncaughtException.
      const onSpawn = () => {
        if (resolved) return;
        resolved = true;
        // Replace the rejecting error listener with a swallowing one.
        // The user's terminal is now showing the spawn output; if ssh
        // later errors that's their problem to read on screen, not ours
        // to crash on.
        child.removeListener("error", onError);
        child.on("error", () => {});
        try { child.unref(); } catch {}
        resolve({ ok: true, child });
      };
      const onError = (err) => {
        if (resolved) return;
        resolved = true;
        child.removeListener("spawn", onSpawn);
        resolve({ ok: false, error: err });
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  async function spawnSystemTerminalWithSsh(profile) {
    const args = buildInteractiveSshArgs(profile);
    if (platform === "win32") {
      return spawnWindowsTerminal(args);
    }
    if (platform === "darwin") {
      return spawnMacTerminal(args);
    }
    return spawnLinuxTerminal(args);
  }

  async function spawnWindowsTerminal(sshArgs) {
    // wt.exe is preferred but not on every box (Win10 LTSC, stripped images,
    // pre-1903 builds). cmd.exe is always present. We try wt first, fall back
    // to cmd on real spawn failure (verified via the error event).
    const opts = { detached: true, stdio: "ignore", windowsHide: false };
    const wt = await tryLaunch("wt.exe", ["--", "ssh", ...sshArgs], opts);
    if (wt.ok) return { ok: true, terminal: "wt" };

    const quoted = sshArgs.map(quoteForCmd).join(" ");
    const cmd = await tryLaunch("cmd.exe", ["/d", "/v:off", "/s", "/k", `ssh ${quoted}`], {
      ...opts,
      shell: false,
      windowsVerbatimArguments: true,
    });
    if (cmd.ok) return { ok: true, terminal: "cmd" };
    return { ok: false, message: (cmd.error && cmd.error.message) || "could not spawn terminal" };
  }

  async function spawnMacTerminal(sshArgs) {
    // Two-layer quoting: each ssh arg → POSIX shell quote → join with spaces
    // → AppleScript-string-escape the joined command → embed in `do script`.
    const cmd = ["ssh", ...sshArgs].map(quoteForPosixShellArg).join(" ");
    const applied = `tell application "Terminal" to do script "${escapeAppleScriptString(cmd)}"`;
    const r = await tryLaunch("osascript", ["-e", applied], { detached: true, stdio: "ignore" });
    if (r.ok) return { ok: true, terminal: "Terminal.app" };
    return { ok: false, message: (r.error && r.error.message) || "osascript failed" };
  }

  async function spawnLinuxTerminal(sshArgs) {
    const cmd = ["ssh", ...sshArgs].map(quoteForPosixShellArg).join(" ");
    const candidates = [
      process.env.TERMINAL ? [process.env.TERMINAL, "-e", "sh", "-c", cmd] : null,
      ["gnome-terminal", "--", "sh", "-c", cmd],
      ["konsole", "-e", "sh", "-c", cmd],
      ["xterm", "-e", "sh", "-c", cmd],
      ["x-terminal-emulator", "-e", "sh", "-c", cmd],
    ].filter(Boolean);
    let lastErr = null;
    for (const [bin, ...args] of candidates) {
      const r = await tryLaunch(bin, args, { detached: true, stdio: "ignore" });
      if (r.ok) return { ok: true, terminal: bin };
      lastErr = r.error;
    }
    return {
      ok: false,
      message: (lastErr && lastErr.message) || "no supported terminal emulator found",
    };
  }

  handle("remoteSsh:authenticate", async (_event, payload) => {
    const id = typeof payload === "string" ? payload : (payload && payload.profileId);
    const profile = id ? findProfile(settingsController, id) : null;
    if (!profile) return { status: "error", message: "profile not found" };
    const r = await spawnSystemTerminalWithSsh(profile);
    return r.ok ? { status: "ok", terminal: r.terminal } : { status: "error", message: r.message };
  });

  handle("remoteSsh:open-terminal", async (_event, payload) => {
    const id = typeof payload === "string" ? payload : (payload && payload.profileId);
    const profile = id ? findProfile(settingsController, id) : null;
    if (!profile) return { status: "error", message: "profile not found" };
    const r = await spawnSystemTerminalWithSsh(profile);
    return r.ok ? { status: "ok", terminal: r.terminal } : { status: "error", message: r.message };
  });

  // Connect every profile flagged `connectOnLaunch`. Called once from main.js
  // after the hook server is up. Best-effort and silent: a failed connect is
  // logged but never blocks startup, and the runtime's own retry/backoff takes
  // over from there. Returns the ids it kicked off (for tests / diagnostics).
  function connectOnLaunchProfiles() {
    const snap = settingsController.getSnapshot();
    const list = (snap.remoteSsh && Array.isArray(snap.remoteSsh.profiles)) ? snap.remoteSsh.profiles : [];
    const started = [];
    for (const profile of list) {
      if (!profile || profile.connectOnLaunch !== true) continue;
      try {
        connectProfile(profile);
        started.push(profile.id);
      } catch (err) {
        log("connect-on-launch failed for", profile.id, err && err.message);
      }
    }
    return started;
  }

  function dispose() {
    while (disposers.length) {
      const d = disposers.pop();
      try { d(); } catch {}
    }
  }

  return {
    dispose,
    connectOnLaunchProfiles,
    // Exposed for tests
    _internal: {
      buildInteractiveSshArgs,
      spawnSystemTerminalWithSsh,
    },
  };
}

module.exports = {
  registerRemoteSshIpc,
};
