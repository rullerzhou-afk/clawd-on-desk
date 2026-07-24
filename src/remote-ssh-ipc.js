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
const crypto = require("crypto");
const {
  deploy,
  startCodexMonitor,
  stopCodexMonitor,
  uninstallRemoteIntegrations,
  finalizeRetiredRemoteLayout,
  bootstrapIsolatedRuntime,
} = require("./remote-ssh-deploy");
const { buildSshArgs } = require("./remote-ssh-runtime");
const {
  remoteOwnershipDomainKey,
} = require("./remote-ssh-profile");
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

function listProfiles(settingsController) {
  const snap = settingsController.getSnapshot();
  return (snap.remoteSsh && Array.isArray(snap.remoteSsh.profiles))
    ? snap.remoteSsh.profiles
    : [];
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
  const enableProfileIsolation = options.enableProfileIsolation === true;
  const hooksDir = options.hooksDir;
  const getInstallationIdentity = typeof options.getInstallationIdentity === "function"
    ? options.getInstallationIdentity
    : () => null;
  // Test-only injection points. Production main.js never overrides these.
  const deployFn = options.deployFn || deploy;
  const startCodexMonitorFn = options.startCodexMonitorFn || startCodexMonitor;
  const stopCodexMonitorFn = options.stopCodexMonitorFn || stopCodexMonitor;
  const uninstallRemoteIntegrationsFn = options.uninstallRemoteIntegrationsFn || uninstallRemoteIntegrations;
  const finalizeRetiredRemoteLayoutFn = options.finalizeRetiredRemoteLayoutFn || finalizeRetiredRemoteLayout;
  const bootstrapIsolatedRuntimeFn = options.bootstrapIsolatedRuntimeFn || bootstrapIsolatedRuntime;

  const disposers = [];
  const runtimeModeSwitches = new Set();

  function requireVerifiedInstallationBinding() {
    const identity = getInstallationIdentity();
    const snapshot = settingsController.getSnapshot();
    const expected = snapshot.remoteSsh && snapshot.remoteSsh.installId;
    if (!identity || typeof identity.installId !== "string" || identity.installId !== expected) {
      throw new Error("Remote SSH installation identity is unavailable or mismatched; redeploy is required");
    }
    return identity;
  }

  function refreshRuntimeProfile(profileId) {
    const profile = findProfile(settingsController, profileId);
    if (profile && typeof remoteSshRuntime.refreshProfile === "function") {
      remoteSshRuntime.refreshProfile(profile);
    }
    return profile;
  }

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
    const identity = getInstallationIdentity();
    return {
      status: "ok",
      statuses: remoteSshRuntime.listStatuses(),
      profileIsolationAvailable: enableProfileIsolation,
      bindingSecurity: identity ? {
        strongStorage: identity.strongStorage === true,
        storageBackend: typeof identity.storageBackend === "string"
          ? identity.storageBackend
          : "unknown",
      } : {
        strongStorage: false,
        storageBackend: "unavailable",
      },
    };
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
    const binding = requireVerifiedInstallationBinding();
    if (profile.runtimeMode === "profile-isolated" && !enableProfileIsolation) {
      throw new Error(
        "Profile-isolated runtime is gated until the real SSH and CLI validation matrix is complete."
      );
    }
    if (profile.runtimeMode === "profile-isolated" && profile.isolatedActive !== true) {
      throw new Error(
        "This isolated runtime is not active yet. Run every applicable CLI through its wrapper, then Deploy / Repair Hooks again."
      );
    }
    const runtimeProfile = { ...profile, installId: binding.installId };
    remoteSshRuntime.connect(runtimeProfile);
    if (profile.autoStartCodexMonitor === true) {
      startCodexMonitorFn({ profile: runtimeProfile, runtime: remoteSshRuntime, deps: { spawn } })
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
      if (profile && profile.autoStartCodexMonitor === true && profile.remoteHome) {
        const binding = requireVerifiedInstallationBinding();
        stopCodexMonitorFn({
          profile: { ...profile, installId: binding.installId },
          runtime: remoteSshRuntime,
          deps: { spawn },
        })
          .catch((err) => log("codex monitor stop failed:", err && err.message));
      }
      return { status: "ok", state: remoteSshRuntime.getProfileStatus(id) };
    } catch (err) {
      return { status: "error", message: (err && err.message) || "disconnect threw" };
    }
  });

  // ── Cleanup (profile deletion) ──
  //
  // Cleanup is ownership-scoped. Fresh profiles have no right to mutate a
  // remote account; duplicate profiles share its global hook/statusline
  // installation; and an A → B edit must clean A, not the current B fields.
  handle("remoteSsh:cleanup", async (_event, payload) => {
    const id = typeof payload === "string" ? payload : (payload && payload.profileId);
    if (typeof id !== "string" || !id) {
      return { status: "error", message: "remoteSsh:cleanup requires { profileId }" };
    }
    const profile = findProfile(settingsController, id);
    if (!profile) return { status: "error", message: "profile not found" };
    try {
      const binding = requireVerifiedInstallationBinding();
      if (profile.identityTxn && profile.identityTxn.phase !== "committed") {
        return {
          status: "error",
          reason: "identity_transaction_in_progress",
          message: "Finish or force-revoke the current identity transaction before cleanup",
        };
      }
      remoteSshRuntime.disconnect(id);
      const ownedTargets = Array.isArray(profile.managedDeployTargets)
        ? profile.managedDeployTargets
        : [];
      if (!ownedTargets.length) {
        return { status: "ok", uninstalled: true, skipped: "not-owned" };
      }
      const siblingOwnershipDomains = new Set(
        listProfiles(settingsController)
          .filter((candidate) => candidate.id !== id)
          .flatMap((candidate) => Array.isArray(candidate.managedDeployTargets)
            ? candidate.managedDeployTargets
            : [])
          .map(remoteOwnershipDomainKey)
      );
      let uninstalled = true;
      let attempted = 0;
      let shared = 0;
      for (const target of ownedTargets) {
        if (siblingOwnershipDomains.has(remoteOwnershipDomainKey(target))) {
          shared += 1;
          continue;
        }
        attempted += 1;
        const cleanupProfile = {
          ...target,
          id: profile.id,
          autoStartCodexMonitor: profile.autoStartCodexMonitor === true,
        };
        if (!cleanupProfile.installId
          || cleanupProfile.installId !== binding.installId
          || !cleanupProfile.remoteHome) {
          uninstalled = false;
          log("remote uninstall skipped: deployment ownership does not match this installation");
          continue;
        }
        const result = await uninstallRemoteIntegrationsFn({
          profile: cleanupProfile,
          runtime: remoteSshRuntime,
          deps: { spawn },
        }).catch((err) => {
          log("remote uninstall failed:", err && err.message);
          return { ok: false };
        });
        if (!result || result.ok === false) {
          uninstalled = false;
          const stderr = (result && result.stderr || "").toString().trim();
          log("remote uninstall incomplete for", target.host, stderr.slice(0, 200));
        }
      }
      return {
        status: "ok",
        uninstalled,
        attempted,
        shared,
        skipped: attempted === 0 ? "shared-owner" : undefined,
      };
    } catch (err) {
      return { status: "error", message: (err && err.message) || "cleanup threw" };
    }
  });

  handle("remoteSsh:force-revoke", async (_event, payload) => {
    const id = payload && payload.profileId;
    const mode = payload && payload.mode;
    if (typeof id !== "string"
      || (mode !== "old" && mode !== "all")
      || payload.confirmed !== true) {
      return {
        status: "error",
        message: "remoteSsh:force-revoke requires profileId, mode old|all, and confirmed:true",
      };
    }
    const profile = findProfile(settingsController, id);
    if (!profile) return { status: "error", message: "profile not found" };
    try {
      requireVerifiedInstallationBinding();
      remoteSshRuntime.disconnect(id);
      const revoked = await settingsController.applyCommand("remoteSsh.forceRevoke", {
        id,
        mode,
        confirmed: true,
      });
      if (!revoked || revoked.status !== "ok") {
        return revoked || { status: "error", message: "Identity revocation failed" };
      }
      const refreshed = refreshRuntimeProfile(id);
      if (!refreshed) {
        return { status: "error", message: "Profile disappeared while revoking its identity" };
      }
      return {
        status: "ok",
        mode,
        identityTxn: refreshed.identityTxn || null,
      };
    } catch (err) {
      return { status: "error", message: (err && err.message) || "identity revocation failed" };
    }
  });

  handle("remoteSsh:set-runtime-mode", async (_event, payload) => {
    const id = payload && payload.profileId;
    const runtimeMode = payload && payload.runtimeMode;
    if (typeof id !== "string"
      || (runtimeMode !== "account-default" && runtimeMode !== "profile-isolated")
      || payload.confirmed !== true) {
      return {
        status: "error",
        message: "remoteSsh:set-runtime-mode requires profileId, a valid runtimeMode, and confirmed:true",
      };
    }
    const profile = findProfile(settingsController, id);
    if (!profile) return { status: "error", message: "profile not found" };
    if (!profile.runtimeModeTxn
      && (profile.runtimeMode || "account-default") === runtimeMode) {
      return { status: "ok", noop: true };
    }
    if (runtimeMode === "profile-isolated" && !enableProfileIsolation) {
      return {
        status: "error",
        reason: "profile_isolation_validation_pending",
        message: "Profile-isolated runtime is gated until the real SSH and CLI validation matrix is complete.",
      };
    }
    if (runtimeModeSwitches.has(id)) {
      return {
        status: "error",
        reason: "runtime_mode_switch_in_progress",
        message: "A runtime mode switch is already in progress for this profile",
      };
    }
    if (profile.identityTxn && profile.identityTxn.phase !== "committed") {
      return {
        status: "error",
        message: "Finish or force-revoke the current identity transaction before switching runtime mode",
      };
    }
    runtimeModeSwitches.add(id);
    try {
      const binding = requireVerifiedInstallationBinding();
      remoteSshRuntime.disconnect(id);
      let workingProfile = profile;
      if (!workingProfile.runtimeModeTxn) {
        const proposedRuntimeKey = runtimeMode === "profile-isolated"
          ? `rt_${crypto.randomBytes(12).toString("hex")}`
          : "account-default";
        const begun = await settingsController.applyCommand("remoteSsh.beginRuntimeModeSwitch", {
          id,
          runtimeMode,
          runtimeKey: proposedRuntimeKey,
        });
        if (!begun || begun.status !== "ok") {
          return {
            status: "error",
            message: (begun && begun.message) || "Could not persist the runtime mode transaction",
          };
        }
        workingProfile = refreshRuntimeProfile(id) || findProfile(settingsController, id);
      }
      const txn = workingProfile && workingProfile.runtimeModeTxn;
      if (!txn || txn.toMode !== runtimeMode) {
        return {
          status: "error",
          reason: "runtime_mode_transaction_invalid",
          message: "The persisted runtime mode transaction is missing or targets another mode",
        };
      }
      const ownedTargets = Array.isArray(workingProfile.managedDeployTargets)
        ? workingProfile.managedDeployTargets.filter((target) =>
          (target.runtimeMode || "account-default") === txn.fromMode
          && (target.runtimeKey || "account-default") === txn.fromKey)
        : [];
      if (workingProfile.runtimeModeTxn.phase === "prepared" && ownedTargets.length === 0) {
        return {
          status: "error",
          reason: "old_layout_ownership_missing",
          message: "The current runtime has no verifiable ownership ledger. Deploy / Repair Hooks in the current mode before switching layouts.",
        };
      }
      if (txn.phase === "prepared") {
        for (const target of ownedTargets) {
          const cleanup = await uninstallRemoteIntegrationsFn({
            profile: { ...target, id: workingProfile.id, installId: binding.installId },
            runtime: remoteSshRuntime,
            deps: { spawn },
            // Keep the ownership record until the local cleanup-done phase is
            // durable. This makes a crash between remote cleanup and prefs
            // persistence safely retryable.
            preserveIdentity: true,
          });
          if (!cleanup || cleanup.ok !== true) {
            return {
              status: "error",
              reason: (cleanup && cleanup.reason) || "old_layout_cleanup_failed",
              message: (cleanup && cleanup.stderr) || "Old runtime layout cleanup did not complete",
            };
          }
        }
        const advanced = await settingsController.applyCommand("remoteSsh.advanceRuntimeModeSwitch", {
          id,
          phase: "cleanup-done",
        });
        if (!advanced || advanced.status !== "ok") {
          return {
            status: "error",
            message: (advanced && advanced.message) || "Could not persist cleanup completion",
          };
        }
        workingProfile = refreshRuntimeProfile(id) || findProfile(settingsController, id);
      }

      if (workingProfile.runtimeModeTxn.phase === "cleanup-done") {
        for (const target of ownedTargets) {
          const finalized = await finalizeRetiredRemoteLayoutFn({
            profile: { ...target, id: workingProfile.id, installId: binding.installId },
            runtime: remoteSshRuntime,
            deps: { spawn },
          });
          if (!finalized || finalized.ok !== true) {
            return {
              status: "error",
              reason: (finalized && finalized.reason) || "old_layout_finalize_failed",
              message: (finalized && finalized.stderr) || "Old runtime ownership retirement did not complete",
            };
          }
        }
      }

      const runtimeKey = txn.toKey;
      let bootstrap = null;
      if (runtimeMode === "profile-isolated"
        && workingProfile.runtimeModeTxn.phase === "cleanup-done") {
        bootstrap = await bootstrapIsolatedRuntimeFn({
          profile: workingProfile,
          installId: binding.installId,
          runtimeKey,
          runtime: remoteSshRuntime,
          deps: { spawn },
        });
        if (!bootstrap || bootstrap.ok !== true) {
          return {
            status: "error",
            reason: (bootstrap && bootstrap.reason) || "isolated_bootstrap_failed",
            message: (bootstrap && bootstrap.stderr) || "Could not prepare the isolated runtime root",
          };
        }
        const advanced = await settingsController.applyCommand("remoteSsh.advanceRuntimeModeSwitch", {
          id,
          phase: "bootstrap-done",
        });
        if (!advanced || advanced.status !== "ok") {
          return {
            status: "error",
            message: (advanced && advanced.message) || "Could not persist isolated bootstrap completion",
            orphanedRuntimeRoot: bootstrap && bootstrap.layout && bootstrap.layout.runtimeRoot,
          };
        }
        workingProfile = refreshRuntimeProfile(id) || findProfile(settingsController, id);
      }

      const switched = await settingsController.applyCommand("remoteSsh.switchRuntimeMode", {
        id,
      });
      if (!switched || switched.status !== "ok") {
        return {
          status: "error",
          message: (switched && switched.message) || "Could not persist runtime mode",
          orphanedRuntimeRoot: bootstrap && bootstrap.layout && bootstrap.layout.runtimeRoot,
        };
      }
      refreshRuntimeProfile(id);
      return {
        status: "ok",
        runtimeMode,
        runtimeKey,
        runtimeRoot: bootstrap && bootstrap.layout && bootstrap.layout.runtimeRoot,
      };
    } catch (err) {
      return { status: "error", message: (err && err.message) || "runtime mode switch failed" };
    } finally {
      runtimeModeSwitches.delete(id);
    }
  });

  // ── Deploy ──

  handle("remoteSsh:deploy", async (_event, payload) => {
    const id = typeof payload === "string" ? payload : (payload && payload.profileId);
    const legacyMigrationConfirmed = !!(
      payload
      && typeof payload === "object"
      && payload.legacyMigrationConfirmed === true
    );
    const profile = id ? findProfile(settingsController, id) : null;
    if (!profile) return { status: "error", message: "profile not found" };
    if (profile.runtimeMode === "profile-isolated" && !enableProfileIsolation) {
      return {
        status: "error",
        reason: "profile_isolation_validation_pending",
        message: "Profile-isolated runtime is gated until the real SSH and CLI validation matrix is complete.",
      };
    }
    try {
      const installationIdentity = requireVerifiedInstallationBinding();
      const begin = await settingsController.applyCommand("remoteSsh.beginIdentityRotation", {
        id: profile.id,
      });
      if (!begin || begin.status !== "ok") {
        return {
          status: "error",
          message: (begin && begin.message) || "could not start secure identity transaction",
        };
      }
      const deployProfile = refreshRuntimeProfile(profile.id) || findProfile(settingsController, profile.id);
      if (!deployProfile || !deployProfile.identityTxn) {
        return { status: "error", message: "secure identity transaction was not persisted" };
      }
      const result = await deployFn({
        profile: deployProfile,
        installId: installationIdentity.installId,
        identityTxn: deployProfile.identityTxn,
        legacyMigrationConfirmed,
        runtime: remoteSshRuntime,
        deps: {
          spawn,
          hooksDir,
          isPackaged,
          onIdentityStep: async (step, value) => {
            const updated = await settingsController.applyCommand("remoteSsh.updateIdentityStep", {
              id: profile.id,
              step,
              value,
            });
            if (!updated || updated.status !== "ok") {
              throw new Error((updated && updated.message) || `failed to persist ${step}`);
            }
            refreshRuntimeProfile(profile.id);
          },
        },
      });
      if (result.ok) {
        // Persist the verified target and cleanup ownership BEFORE committing
        // A → B. If this durable write fails, the transaction must remain in
        // its verifying phase so Retry resumes the same B instead of minting
        // C and stranding a remotely valid but locally unowned deployment.
        //
        // Stamp via remoteSsh.markDeployed (NOT remoteSsh.update with a full
        // profile snapshot). Deploy can take 30+ seconds, during which the
        // user might edit the profile via Settings — full-snapshot update
        // would clobber those edits with the pre-deploy state (lost-update
        // race). markDeployed reads the current profile by id and only
        // mutates deployment metadata.
        //
        // expectedTarget is a fingerprint captured at deploy start. If the
        // user changed a deploy-target field mid-deploy, the deploy ran
        // against the old target — markDeployed no-ops in that case so we
        // don't falsely claim the new (drifted) configuration is
        // "deployed". Must carry EVERY field in DEPLOY_TARGET_FIELDS
        // (remote-ssh-profile.js), or profiles using the missing field
        // false-positive as drifted on every deploy.
        const expectedTarget = {
          host: profile.host,
          port: profile.port,
          identityFile: profile.identityFile,
          remoteForwardPort: profile.remoteForwardPort,
          hostPrefix: profile.hostPrefix,
          chainStatusline: profile.chainStatusline,
          runtimeMode: profile.runtimeMode,
          runtimeKey: profile.runtimeKey,
          layoutVersion: profile.layoutVersion,
        };
        let stampWarning = null;
        try {
          const stamp = await settingsController.applyCommand("remoteSsh.markDeployed", {
            id: profile.id,
            deployedAt: Date.now(),
            expectedTarget,
            remoteNode: result.remoteNode,
            installId: installationIdentity.installId,
            remoteHome: result.layout && result.layout.remoteHome,
            isolation: result.isolation,
          });
          if (stamp && stamp.noop && stamp.reason === "target_drift") {
            log("remote-ssh: deploy stamp skipped due to target drift on", stamp.targetDrift);
            stampWarning = { warning: "target_drift", driftedField: stamp.targetDrift };
          }
          if (!stamp || stamp.status !== "ok") {
            const msg = (stamp && stamp.message) || "stamp returned non-ok";
            log("remote-ssh: failed to stamp lastDeployedAt:", msg);
            return { status: "error", step: "deployment-stamp", message: msg };
          }
        } catch (err) {
          const msg = (err && err.message) || "stamp threw";
          log("remote-ssh: failed to stamp lastDeployedAt:", msg);
          return { status: "error", step: "deployment-stamp", message: msg };
        }

        const committed = await settingsController.applyCommand("remoteSsh.commitIdentityRotation", {
          id: profile.id,
        });
        if (!committed || committed.status !== "ok") {
          return {
            status: "error",
            step: "identity-commit",
            message: (committed && committed.message) || "identity transaction was not committed",
          };
        }
        refreshRuntimeProfile(profile.id);
        return { status: "ok", ...(stampWarning || {}) };
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
