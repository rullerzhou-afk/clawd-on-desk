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
const {
  buildSshArgs,
  checkSecureConnectReadiness,
  tunnelTargetKey,
} = require("./remote-ssh-runtime");
const {
  localTargetFingerprint,
  redactTransportDiagnostic,
} = require("./remote-ssh-transport");
const {
  deployTargetDrift,
  deployTargetFingerprint,
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
  const transportCoordinator = options.transportCoordinator || null;
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
  const destructiveProfileOperations = new Map();
  const profileActionGenerations = new Map();
  const profileActionKinds = new Map();
  const ordinaryMonitorOperationsByProfile = new Map();

  function beginProfileAction(profileId, kind) {
    const generation = (profileActionGenerations.get(profileId) || 0) + 1;
    profileActionGenerations.set(profileId, generation);
    profileActionKinds.set(profileId, kind || null);
    return generation;
  }

  function profileActionIsCurrent(profileId, generation) {
    return profileActionGenerations.get(profileId) === generation;
  }

  function enqueueOrdinaryMonitorOperation(profileId, operation) {
    const previous = ordinaryMonitorOperationsByProfile.get(profileId);
    const task = (previous ? previous.catch(() => {}) : Promise.resolve()).then(operation);
    let tracked = null;
    tracked = task.finally(() => {
      if (ordinaryMonitorOperationsByProfile.get(profileId) === tracked) {
        ordinaryMonitorOperationsByProfile.delete(profileId);
      }
    });
    ordinaryMonitorOperationsByProfile.set(profileId, tracked);
    return tracked;
  }

  function managedRuntimeForContext(context) {
    return {
      emit: (event, payload) => remoteSshRuntime.emit(event, payload),
      spawnManagedTransportChild: (spec) => context.spawn({
        ...spec,
        attemptToken: context.attemptToken,
      }),
      assertTransportActive: () => context.assertActive(),
      invalidateManagedOperation: (err) => {
        if (!transportCoordinator) return;
        try {
          const recoveryCode = context.getRecoveryCode();
          if (recoveryCode && err && typeof err === "object") err.recoveryCode = recoveryCode;
        } catch {}
        try {
          transportCoordinator.invalidate(context, (err && err.code) || "transport_drain_timeout");
        } catch {}
      },
      settleManagedTimeoutAfterClose: (err) => {
        if (!transportCoordinator) return;
        try {
          const outcome = transportCoordinator.abortAfterVerifiedClose(
            context,
            (err && err.code) || "operation_timeout",
          );
          if (outcome && outcome.recoveryCode && err && typeof err === "object") {
            err.recoveryCode = outcome.recoveryCode;
          }
        } catch {}
      },
      setManagedLockStage: (stage) => context.setLockStage(stage),
    };
  }

  function coordinatorFailure(result) {
    return {
      status: "error",
      reason: result && result.code || "transport_operation_failed",
      ...(result && result.profileId ? { profileId: result.profileId } : {}),
      ...(result && result.ownerProfileId ? { ownerProfileId: result.ownerProfileId } : {}),
      ...(result && result.operation ? { operation: result.operation } : {}),
      ...(result && result.recoveryCode ? { recoveryCode: result.recoveryCode } : {}),
      message: result && result.message || "Remote SSH transport operation failed",
    };
  }

  function transportHintFromInspection(inspection) {
    if (!inspection || inspection.mode !== "serialized") return null;
    if (inspection.kind !== "codespaces-stdio" && inspection.kind !== "explicit-serialized") return null;
    if (typeof inspection.key !== "string" || inspection.key.length > 160) return null;
    return {
      version: 1,
      mode: "serialized",
      kind: inspection.kind,
      keyId: inspection.key,
    };
  }

  function sameEffectiveDestination(left, right) {
    return !!left && !!right
      && left.effectiveHost === right.effectiveHost
      && left.effectiveUser === right.effectiveUser
      && left.effectivePort === right.effectivePort;
  }

  function getActiveRuntimeTransportMode(profileId) {
    if (typeof remoteSshRuntime.getProfileTransportMode !== "function") return false;
    const mode = remoteSshRuntime.getProfileTransportMode(profileId);
    if (mode !== "parallel" && mode !== "serialized") return null;
    const status = remoteSshRuntime.getProfileStatus(profileId);
    return status && ["connecting", "connected", "reconnecting"].includes(status.status)
      ? mode
      : null;
  }

  async function withManagedTransport(requestedProfile, operation, policy, callback) {
    const binding = requireVerifiedInstallationBinding();
    const initialProfile = { ...requestedProfile, installId: binding.installId };
    if (!transportCoordinator) {
      if (policy && policy.disconnectOrdinary === true) {
        remoteSshRuntime.disconnect(requestedProfile.id);
      }
      return callback({
        profile: initialProfile,
        runtime: remoteSshRuntime,
        inspection: { mode: "parallel", kind: "standard" },
        transportContext: null,
      });
    }
    const admitted = policy && policy.useOwnedTransport === true
      ? await transportCoordinator.acquireOwnedOperation(initialProfile, operation)
      : await transportCoordinator.acquireOperation(initialProfile, operation);
    if (!admitted.ok) {
      const err = new Error(admitted.message);
      err.reason = admitted.code;
      err.ownerProfileId = admitted.ownerProfileId;
      err.operation = admitted.operation;
      err.recoveryCode = admitted.recoveryCode;
      throw err;
    }
    const activeRuntimeMode = getActiveRuntimeTransportMode(requestedProfile.id);
    const admittedRuntimeMode = admitted.serialized ? "serialized" : "parallel";
    if (activeRuntimeMode && activeRuntimeMode !== admittedRuntimeMode) {
      if (admitted.serialized) {
        try { transportCoordinator.release(admitted.context); } catch {}
      }
      const err = new Error("Disconnect the existing SSH session before using the changed transport mode");
      err.reason = "profile_changed";
      throw err;
    }
    if (!admitted.serialized) {
      if (policy && policy.disconnectOrdinary === true) {
        remoteSshRuntime.disconnect(requestedProfile.id);
      }
      return callback({
        profile: initialProfile,
        runtime: remoteSshRuntime,
        inspection: admitted.inspection,
        transportContext: null,
      });
    }

    const context = admitted.context;
    const intentAtAdmission = transportCoordinator.getIntent(requestedProfile.id);
    let result;
    let primaryError = null;
    let resumeWarning = null;
    let disconnectWarning = null;
    try {
      if (policy && policy.skipRuntimeSuspend === true) {
        await transportCoordinator.waitForDrain(context, (child, metadata) => {
          if (metadata && metadata.role === "persistent-tunnel-readiness" && child.stdin) {
            try { child.stdin.end(); } catch {}
            return;
          }
          // Historical targets must be idle before admission. An unexpected
          // one-shot child is left tracked: the deadline quarantines the slot
          // instead of treating a force-killed outer ssh as a verified drain.
        });
      } else {
        await remoteSshRuntime.suspendForOperation(requestedProfile.id, context, {
          closeIngress: policy && policy.closeIngressBefore === true,
          message: policy && policy.suspendMessage,
        });
      }
      context.assertActive();
      const latest = policy && policy.historicalTarget === true
        ? requestedProfile
        : findProfile(settingsController, requestedProfile.id);
      const targetDrift = latest && deployTargetDrift(
        deployTargetFingerprint(requestedProfile),
        deployTargetFingerprint(latest),
      );
      if (!latest
        || localTargetFingerprint(latest) !== localTargetFingerprint(requestedProfile)
        || targetDrift) {
        const err = new Error("Remote SSH profile changed before the operation started");
        err.reason = "profile_changed";
        err.driftedField = targetDrift || undefined;
        throw err;
      }
      const runtimeProfile = { ...latest, installId: binding.installId };
      const freshInspection = await transportCoordinator.inspect(runtimeProfile);
      context.assertActive();
      if (!freshInspection || freshInspection.mode === "unknown"
        || ((freshInspection.stickyFallback === true
          || freshInspection.historicalHintFallback === true)
          && !(policy && policy.historicalTarget === true))) {
        const err = new Error("Effective SSH transport could not be re-verified after the previous session drained");
        err.reason = "transport_inspection_failed";
        throw err;
      }
      if (freshInspection.mode !== "serialized"
        || freshInspection.key !== context.transportKey) {
        const err = new Error("Effective SSH transport changed before the operation started");
        err.reason = "profile_changed";
        throw err;
      }
      result = await callback({
        profile: runtimeProfile,
        runtime: managedRuntimeForContext(context),
        inspection: freshInspection,
        transportContext: context,
      });
      context.assertActive();
    } catch (err) {
      primaryError = err;
    }

    let active = true;
    try { context.assertActive(); } catch { active = false; }
    if (active) {
      const intent = transportCoordinator.getIntent(requestedProfile.id);
      const latest = findProfile(settingsController, requestedProfile.id);
      const targetDrift = latest && deployTargetDrift(
        deployTargetFingerprint(requestedProfile),
        deployTargetFingerprint(latest),
      );
      const shouldResume = policy && policy.resume === "if-desired"
        && !(primaryError && (primaryError.reason === "profile_changed"
          || primaryError.reason === "transport_inspection_failed"))
        && intent.desiredConnected === true
        && latest
        && localTargetFingerprint(latest) === localTargetFingerprint(requestedProfile)
        && !targetDrift;
      const disconnectedDuringOperation = intent.desiredConnected === false
        && intent.intentGeneration !== intentAtAdmission.intentGeneration;
      if (!shouldResume && disconnectedDuringOperation
        && policy && policy.stopMonitorWhenDisconnected === true
        && latest && latest.autoStartCodexMonitor === true && latest.remoteHome) {
        let monitorProfile = null;
        try {
          if (localTargetFingerprint(latest) !== localTargetFingerprint(requestedProfile)) {
            throw Object.assign(new Error("Remote SSH target changed before monitor cleanup"), {
              reason: "profile_changed",
            });
          }
          const monitorInspection = await transportCoordinator.inspect({
            ...latest,
            installId: binding.installId,
          });
          context.assertActive();
          if (!monitorInspection || monitorInspection.mode !== "serialized"
            || monitorInspection.key !== context.transportKey
            || monitorInspection.stickyFallback === true
            || monitorInspection.historicalHintFallback === true) {
            throw Object.assign(new Error("Effective SSH transport changed before monitor cleanup"), {
              reason: "profile_changed",
            });
          }
          monitorProfile = { ...latest, installId: binding.installId };
          const stopped = await stopCodexMonitorFn({
            profile: monitorProfile,
            runtime: managedRuntimeForContext(context),
            deps: { spawn },
          });
          context.assertActive();
          if (stopped && stopped.ok === false) {
            disconnectWarning = {
              reason: stopped.reason || "monitor_stop_incomplete",
              message: redactTransportDiagnostic(
                stopped.stderr || "Remote Codex monitor stop did not complete",
                monitorProfile,
              ),
            };
          }
        } catch (err) {
          try {
            context.assertActive();
            disconnectWarning = {
              reason: (err && (err.reason || err.code)) || "monitor_stop_failed",
              message: redactTransportDiagnostic(
                (err && err.message) || "Remote Codex monitor stop failed",
                latest,
              ),
            };
          } catch {
            active = false;
            if (!primaryError) primaryError = err;
          }
        }
      }
      if (active && shouldResume) {
        try {
          const runtimeProfile = { ...latest, installId: binding.installId };
          context.transitionToConnection();
          remoteSshRuntime.connect(runtimeProfile, {
            serialized: true,
            transportContext: context,
          });
        } catch (err) {
          resumeWarning = {
            reason: (err && err.reason) || "resume_failed",
            message: (err && err.message) || "Remote SSH reconnect failed",
          };
          try { remoteSshRuntime.finalizeSerializedDisconnect(requestedProfile.id, context); } catch {}
        }
      } else if (active && policy && policy.skipRuntimeSuspend === true) {
        try { transportCoordinator.release(context); } catch {}
      } else if (active) {
        try { remoteSshRuntime.finalizeSerializedDisconnect(requestedProfile.id, context); } catch {}
      }
    }

    if (primaryError) {
      if (resumeWarning) primaryError.resumeWarning = resumeWarning;
      throw primaryError;
    }
    if (resumeWarning && result && typeof result === "object") {
      return { ...result, resumeWarning, ...(disconnectWarning ? { disconnectWarning } : {}) };
    }
    if (disconnectWarning && result && typeof result === "object") {
      return { ...result, disconnectWarning };
    }
    return result;
  }

  async function drainForDestructiveOperation(profile, operation) {
    if (transportCoordinator) transportCoordinator.recordDisconnectIntent(profile.id);
    return withManagedTransport(
      profile,
      operation,
      {
        resume: "never",
        closeIngressBefore: true,
        disconnectOrdinary: true,
        useOwnedTransport: true,
      },
      async () => ({ status: "ok" }),
    );
  }

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

  // Profile CRUD travels through the generic settings IPC, not this module's
  // connect/deploy handlers. Keep every existing runtime state on the latest
  // committed profile so a queued reconnect cannot reuse a stale port or a
  // deployment stamp that remoteSsh.update has just invalidated. Deletion must
  // also cancel any live child/timer that still belongs to the removed id.
  if (typeof settingsController.subscribeKey === "function") {
    const unsubscribeRemoteSsh = settingsController.subscribeKey("remoteSsh", (remoteSsh) => {
      const profiles = remoteSsh && Array.isArray(remoteSsh.profiles)
        ? remoteSsh.profiles
        : [];
      const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
      let statuses = [];
      try {
        statuses = remoteSshRuntime.listStatuses();
      } catch (err) {
        log("remote-ssh: could not list runtime states after settings update:", err && err.message);
        return;
      }
      for (const status of statuses) {
        if (!status || typeof status.profileId !== "string") continue;
        const profile = profilesById.get(status.profileId);
        try {
          if (profile && typeof remoteSshRuntime.refreshProfile === "function") {
            remoteSshRuntime.refreshProfile(profile);
          } else if (!profile) {
            remoteSshRuntime.disconnect(status.profileId);
            if (transportCoordinator && typeof transportCoordinator.forgetProfile === "function") {
              transportCoordinator.forgetProfile(status.profileId);
            }
          }
        } catch (err) {
          log("remote-ssh: could not sync runtime profile", status.profileId, err && err.message);
        }
      }
      if (transportCoordinator
        && typeof transportCoordinator.refreshProfileInspections === "function") {
        transportCoordinator.refreshProfileInspections(profiles).catch((err) => {
          log("remote-ssh: could not refresh effective transport profiles:", err && err.message);
        });
      }
    });
    if (typeof unsubscribeRemoteSsh === "function") {
      disposers.push(unsubscribeRemoteSsh);
    }
  }

  // ── Status / list ──

  handle("remoteSsh:list-statuses", async () => {
    if (transportCoordinator
      && typeof transportCoordinator.refreshProfileInspections === "function") {
      await transportCoordinator.refreshProfileInspections(listProfiles(settingsController));
    }
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

  handle("remoteSsh:status", async (_event, payload) => {
    const id = typeof payload === "string" ? payload : (payload && payload.profileId);
    if (typeof id !== "string" || !id) {
      return { status: "error", message: "remoteSsh:status requires { profileId }" };
    }
    if (transportCoordinator
      && typeof transportCoordinator.refreshProfileInspections === "function") {
      await transportCoordinator.refreshProfileInspections(listProfiles(settingsController));
    }
    return { status: "ok", state: remoteSshRuntime.getProfileStatus(id) };
  });

  // ── Connect / Disconnect ──

  // Shared connect path: start the tunnel and, if opted in, the codex monitor.
  // Used by both the manual `remoteSsh:connect` IPC handler and the
  // connect-on-launch sweep so they behave identically. Throws if
  // runtime.connect throws; the codex monitor is best-effort and never blocks.
  async function connectProfile(profile) {
    // Invalidate deferred best-effort cleanup from an older Disconnect before
    // this Connect can prepare/start a new remote monitor.
    const connectActionGeneration = beginProfileAction(profile.id, "connect");
    const priorMonitorOperation = ordinaryMonitorOperationsByProfile.get(profile.id);
    if (priorMonitorOperation) {
      // The ordinary tunnel is already down, but its remote monitor stop may
      // still own the deploy lease. Preserve stop -> start ordering so a quick
      // new Connect cannot lose its monitor start to the older cleanup.
      await priorMonitorOperation.catch(() => {});
      if (!profileActionIsCurrent(profile.id, connectActionGeneration)) {
        const err = new Error("Remote SSH Connect was superseded by a newer profile action");
        err.reason = "transport_operation_busy";
        throw err;
      }
    }
    if (destructiveProfileOperations.has(profile.id)) {
      const err = new Error("A destructive Remote SSH operation is already active for this profile");
      err.reason = "transport_operation_busy";
      err.operation = destructiveProfileOperations.get(profile.id);
      throw err;
    }
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
    const readiness = checkSecureConnectReadiness(runtimeProfile);
    if (!readiness.ok) {
      const err = new Error(readiness.message);
      err.reason = readiness.reason;
      err.hint = readiness.hint;
      err.detail = readiness.detail;
      throw err;
    }
    if (!transportCoordinator) {
      if (!profileActionIsCurrent(profile.id, connectActionGeneration)) {
        const err = new Error("Remote SSH Connect was superseded by a newer profile action");
        err.reason = "transport_operation_busy";
        throw err;
      }
      remoteSshRuntime.connect(runtimeProfile);
      if (profile.autoStartCodexMonitor === true) {
        enqueueOrdinaryMonitorOperation(profile.id, () => {
          if (!profileActionIsCurrent(profile.id, connectActionGeneration)) return { ok: true, skipped: true };
          return startCodexMonitorFn({ profile: runtimeProfile, runtime: remoteSshRuntime, deps: { spawn } });
        })
          .catch((err) => log("codex monitor start failed:", err && err.message));
      }
      return remoteSshRuntime.getProfileStatus(profile.id);
    }

    const admitted = await transportCoordinator.acquireConnection(runtimeProfile);
    if (!profileActionIsCurrent(profile.id, connectActionGeneration)) {
      if (admitted && admitted.ok && admitted.serialized) {
        try { transportCoordinator.release(admitted.context); } catch {}
      }
      if (profileActionKinds.get(profile.id) === "disconnect"
        && typeof transportCoordinator.recordDisconnectIntent === "function") {
        transportCoordinator.recordDisconnectIntent(profile.id);
      }
      const err = new Error("Remote SSH Connect was superseded by a newer profile action");
      err.reason = "transport_operation_busy";
      throw err;
    }
    if (!admitted.ok) {
      const err = new Error(admitted.message);
      err.reason = admitted.code;
      err.ownerProfileId = admitted.ownerProfileId;
      err.operation = admitted.operation;
      err.recoveryCode = admitted.recoveryCode;
      throw err;
    }
    const activeRuntimeMode = getActiveRuntimeTransportMode(profile.id);
    const admittedRuntimeMode = admitted.serialized ? "serialized" : "parallel";
    if (activeRuntimeMode && activeRuntimeMode !== admittedRuntimeMode) {
      if (admitted.serialized) {
        try { transportCoordinator.release(admitted.context); } catch {}
      }
      const err = new Error("Disconnect the existing SSH session before using the changed transport mode");
      err.reason = "profile_changed";
      throw err;
    }
    if (!admitted.serialized) {
      remoteSshRuntime.connect(runtimeProfile, { transportInspection: admitted.inspection });
      if (profile.autoStartCodexMonitor === true) {
        enqueueOrdinaryMonitorOperation(profile.id, () => {
          if (!profileActionIsCurrent(profile.id, connectActionGeneration)) return { ok: true, skipped: true };
          return startCodexMonitorFn({ profile: runtimeProfile, runtime: remoteSshRuntime, deps: { spawn } });
        })
          .catch((err) => log("codex monitor start failed:", err && err.message));
      }
      return remoteSshRuntime.getProfileStatus(profile.id);
    }

    const latest = findProfile(settingsController, profile.id);
    const latestRuntimeProfile = latest && { ...latest, installId: binding.installId };
    if (!latestRuntimeProfile
      || localTargetFingerprint(latest) !== localTargetFingerprint(profile)
      || tunnelTargetKey(latestRuntimeProfile) !== tunnelTargetKey(runtimeProfile)) {
      transportCoordinator.release(admitted.context);
      const err = new Error("Remote SSH profile changed before connection preparation");
      err.reason = "profile_changed";
      throw err;
    }
    const prepareSerializedAttempt = profile.autoStartCodexMonitor === true
      ? async ({ profile: preparedProfile, remoteNode, runtime }) => startCodexMonitorFn({
          profile: preparedProfile,
          runtime,
          deps: { spawn, nodeBin: remoteNode.nodeBin },
        })
      : null;
    const cancelSerializedAttempt = profile.autoStartCodexMonitor === true
      ? async ({ profile: preparedProfile, remoteNode, runtime }) => stopCodexMonitorFn({
          profile: preparedProfile,
          runtime,
          deps: { spawn, nodeBin: remoteNode.nodeBin },
        })
      : null;
    try {
      remoteSshRuntime.connect(runtimeProfile, {
        serialized: true,
        transportInspection: admitted.inspection,
        transportContext: admitted.context,
        prepareSerializedAttempt,
        cancelSerializedAttempt,
      });
      return remoteSshRuntime.getProfileStatus(profile.id);
    } catch (err) {
      try { transportCoordinator.release(admitted.context); } catch {}
      throw err;
    }
  }

  handle("remoteSsh:connect", async (_event, payload) => {
    const id = typeof payload === "string" ? payload : (payload && payload.profileId);
    const profile = id ? findProfile(settingsController, id) : null;
    if (!profile) return { status: "error", message: "profile not found" };
    try {
      await connectProfile(profile);
      return { status: "ok", state: remoteSshRuntime.getProfileStatus(id) };
    } catch (err) {
      return {
        status: "error",
        ...(err && err.reason ? { reason: err.reason } : {}),
        ...(err && err.recoveryCode ? { recoveryCode: err.recoveryCode } : {}),
        ...(err && err.ownerProfileId ? { ownerProfileId: err.ownerProfileId } : {}),
        ...(err && err.operation ? { operation: err.operation } : {}),
        ...(err && err.hint ? { hint: err.hint } : {}),
        ...(err && err.detail ? { detail: err.detail } : {}),
        message: (err && err.message) || "connect threw",
      };
    }
  });

  handle("remoteSsh:disconnect", async (_event, payload) => {
    const id = typeof payload === "string" ? payload : (payload && payload.profileId);
    if (typeof id !== "string" || !id) {
      return { status: "error", message: "remoteSsh:disconnect requires { profileId }" };
    }
    const disconnectActionGeneration = beginProfileAction(id, "disconnect");
    try {
      const profile = findProfile(settingsController, id);
      if (!transportCoordinator || !profile) {
        remoteSshRuntime.disconnect(id);
      } else {
        transportCoordinator.recordDisconnectIntent(id);
        const runtimeTransportMode = typeof remoteSshRuntime.getProfileTransportMode === "function"
          ? remoteSshRuntime.getProfileTransportMode(id)
          : null;
        if (runtimeTransportMode === "parallel") {
          remoteSshRuntime.disconnect(id);
          let warning = null;
          if (profile.autoStartCodexMonitor === true && profile.remoteHome) {
            try {
              const originalInspection = typeof remoteSshRuntime.getProfileTransportInspection === "function"
                ? remoteSshRuntime.getProfileTransportInspection(id)
                : null;
              const freshInspection = await transportCoordinator.inspect(profile);
              if (!profileActionIsCurrent(id, disconnectActionGeneration)) {
                return {
                  status: "ok",
                  state: remoteSshRuntime.getProfileStatus(id),
                };
              }
              if (!originalInspection || !freshInspection
                || originalInspection.mode !== "parallel"
                || freshInspection.mode !== "parallel"
                || freshInspection.mode === "unknown"
                || freshInspection.stickyFallback === true
                || freshInspection.historicalHintFallback === true
                || originalInspection.key !== freshInspection.key
                || !sameEffectiveDestination(originalInspection, freshInspection)) {
                warning = {
                  reason: "profile_changed",
                  message: "Remote SSH disconnected, but monitor cleanup was skipped because the effective target changed",
                };
                return {
                  status: "ok",
                  state: remoteSshRuntime.getProfileStatus(id),
                  warning,
                };
              }
              const binding = requireVerifiedInstallationBinding();
              const monitorProfile = { ...profile, installId: binding.installId };
              if (!profileActionIsCurrent(id, disconnectActionGeneration)) {
                return {
                  status: "ok",
                  state: remoteSshRuntime.getProfileStatus(id),
                };
              }
              const cleanupPromise = enqueueOrdinaryMonitorOperation(id, () => stopCodexMonitorFn({
                profile: monitorProfile,
                runtime: remoteSshRuntime,
                deps: { spawn },
              }));
              const stopped = await cleanupPromise;
              if (stopped && stopped.ok === false) {
                warning = {
                  reason: stopped.reason || "monitor_stop_incomplete",
                  message: redactTransportDiagnostic(
                    stopped.stderr || "Remote Codex monitor stop did not complete",
                    profile,
                  ),
                };
              }
            } catch (err) {
              // Disconnect is the local safety valve. Missing installation
              // metadata, target drift, or a serialized transport conflict
              // may skip remote cleanup, but none may keep the ordinary
              // tunnel alive or bypass target-scoped admission.
              warning = {
                reason: (err && (err.reason || err.code)) || "monitor_stop_skipped",
                message: redactTransportDiagnostic(
                  (err && err.message) || "Remote monitor cleanup was skipped",
                  profile,
                ),
              };
              log("codex monitor stop skipped:", warning.message);
            }
          }
          return {
            status: "ok",
            state: remoteSshRuntime.getProfileStatus(id),
            ...(warning ? { warning } : {}),
          };
        }
        const activeOwnerOperation = typeof transportCoordinator.getActiveOwnerOperation === "function"
          ? transportCoordinator.getActiveOwnerOperation(id)
          : null;
        if (activeOwnerOperation
          && activeOwnerOperation.operation === "connect"
          && activeOwnerOperation.lockStage
          && activeOwnerOperation.lockStage !== "before-acquire") {
          const state = {
            ...remoteSshRuntime.getProfileStatus(id),
            ...(typeof transportCoordinator.snapshotForProfile === "function"
              ? transportCoordinator.snapshotForProfile(id)
              : {}),
          };
          broadcast(BrowserWindow, "remoteSsh:status-changed", state);
          return {
            status: "ok",
            disconnectPending: true,
            state,
          };
        }
        if (activeOwnerOperation
          && activeOwnerOperation.operation
          && activeOwnerOperation.operation !== "connect"
          && activeOwnerOperation.operation !== "disconnect") {
          if (activeOwnerOperation.quarantined) {
            return coordinatorFailure({
              code: activeOwnerOperation.quarantineReason || "transport_drain_timeout",
              recoveryCode: activeOwnerOperation.quarantineLockStage === "before-acquire"
                ? undefined
                : "manual_lock_inspection_required",
              operation: activeOwnerOperation.operation,
              message: "The serialized SSH transport is quarantined and requires explicit recovery",
            });
          }
          const state = {
            ...remoteSshRuntime.getProfileStatus(id),
            ...(typeof transportCoordinator.snapshotForProfile === "function"
              ? transportCoordinator.snapshotForProfile(id)
              : {}),
          };
          // No runtime transition occurs here: the active mutation keeps its
          // lease and only its post-operation reconnect intent changes. Push
          // the updated intent explicitly so every Settings window can replace
          // Disconnect with a disabled Connect immediately.
          broadcast(BrowserWindow, "remoteSsh:status-changed", state);
          return {
            status: "ok",
            disconnectPending: true,
            state,
          };
        }
        const binding = requireVerifiedInstallationBinding();
        const runtimeProfile = { ...profile, installId: binding.installId };
        const admitted = await transportCoordinator.acquireOwnedOperation(runtimeProfile, "disconnect");
        if (!admitted.ok) return coordinatorFailure(admitted);
        if (admitted.serialized) {
          await remoteSshRuntime.suspendForOperation(id, admitted.context, { closeIngress: true });
          const managedRuntime = managedRuntimeForContext(admitted.context);
          let disconnectWarning = null;
          let verifiedProfile = null;
          const latest = findProfile(settingsController, id);
          try {
            if (latest && localTargetFingerprint(latest) === localTargetFingerprint(profile)) {
              const freshInspection = await transportCoordinator.inspect({
                ...latest,
                installId: binding.installId,
              });
              admitted.context.assertActive();
              if (freshInspection && freshInspection.mode === "serialized"
                && freshInspection.key === admitted.context.transportKey
                && freshInspection.stickyFallback !== true
                && freshInspection.historicalHintFallback !== true) {
                verifiedProfile = { ...latest, installId: binding.installId };
              }
            }
          } catch {}
          if (!verifiedProfile) {
            disconnectWarning = {
              reason: "profile_changed",
              message: "Remote SSH disconnected, but monitor cleanup was skipped because the effective target changed",
            };
          }
          if (verifiedProfile && verifiedProfile.autoStartCodexMonitor === true && verifiedProfile.remoteHome) {
            const stopped = await stopCodexMonitorFn({
              profile: verifiedProfile,
              runtime: managedRuntime,
              deps: { spawn },
            }).catch((err) => {
              log("codex monitor stop failed:", err && err.message);
              return null;
            });
            admitted.context.assertActive();
            if (stopped && stopped.ok === false) {
              log("codex monitor stop incomplete:", redactTransportDiagnostic(
                stopped.stderr || stopped.reason,
                verifiedProfile,
              ));
            }
          }
          const state = remoteSshRuntime.finalizeSerializedDisconnect(id, admitted.context);
          return { status: "ok", state, ...(disconnectWarning ? { warning: disconnectWarning } : {}) };
        }
        remoteSshRuntime.disconnect(id);
      }
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
      return {
        status: "error",
        ...(err && (err.reason || err.code) ? { reason: err.reason || err.code } : {}),
        ...(err && err.recoveryCode ? { recoveryCode: err.recoveryCode } : {}),
        message: (err && err.message) || "disconnect threw",
      };
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
    if (destructiveProfileOperations.has(id)) {
      return coordinatorFailure({
        code: "transport_operation_busy",
        operation: destructiveProfileOperations.get(id),
        message: "Another destructive Remote SSH operation is already active for this profile",
      });
    }
    destructiveProfileOperations.set(id, "cleanup");
    try {
      const binding = requireVerifiedInstallationBinding();
      if (profile.identityTxn && profile.identityTxn.phase !== "committed") {
        return {
          status: "error",
          reason: "identity_transaction_in_progress",
          message: "Finish or force-revoke the current identity transaction before cleanup",
        };
      }
      await drainForDestructiveOperation(profile, "cleanup-disconnect");
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
      const orderedTargets = ownedTargets.slice().sort((a, b) =>
        remoteOwnershipDomainKey(a).localeCompare(remoteOwnershipDomainKey(b))
      );
      for (const target of orderedTargets) {
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
        const result = await withManagedTransport(
          cleanupProfile,
          "cleanup",
          { resume: "never", historicalTarget: true, skipRuntimeSuspend: true },
          async ({ profile: admittedProfile, runtime }) => uninstallRemoteIntegrationsFn({
            profile: admittedProfile,
            runtime,
            deps: { spawn },
          }),
        ).catch((err) => {
          log("remote uninstall failed:", err && err.message);
          return {
            ok: false,
            reason: (err && (err.reason || err.code)) || "cleanup_transport_failed",
            ...(err && err.recoveryCode ? { recoveryCode: err.recoveryCode } : {}),
            message: (err && err.message) || "Remote cleanup transport failed",
          };
        });
        if (!result || result.ok === false) {
          uninstalled = false;
          if (result && (result.recoveryCode
            || result.reason === "transport_unknown_result"
            || result.reason === "manual_lock_inspection_required"
            || result.reason === "serialized_transport_busy"
            || result.reason === "transport_inspection_failed"
            || result.reason === "transport_drain_timeout"
            || result.reason === "transport_drain_unverified")) {
            return {
              status: "error",
              reason: result.reason,
              ...(result.recoveryCode ? { recoveryCode: result.recoveryCode } : {}),
              profileId: profile.id,
              message: result.message || "Remote cleanup transport is unavailable",
            };
          }
          const stderr = redactTransportDiagnostic(result && result.stderr, cleanupProfile);
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
      return {
        status: "error",
        ...(err && (err.reason || err.code) ? { reason: err.reason || err.code } : {}),
        ...(err && err.recoveryCode ? { recoveryCode: err.recoveryCode } : {}),
        message: (err && err.message) || "cleanup threw",
      };
    } finally {
      destructiveProfileOperations.delete(id);
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
    if (destructiveProfileOperations.has(id)) {
      return coordinatorFailure({
        code: "transport_operation_busy",
        operation: destructiveProfileOperations.get(id),
        message: "Another destructive Remote SSH operation is already active for this profile",
      });
    }
    destructiveProfileOperations.set(id, "force-revoke");
    try {
      requireVerifiedInstallationBinding();
      await drainForDestructiveOperation(profile, "force-revoke-disconnect");
      return await withManagedTransport(
        profile,
        "force-revoke",
        { resume: "never", skipRuntimeSuspend: true },
        async ({ transportContext }) => {
          if (transportContext) transportContext.assertActive();
          const revoked = await settingsController.applyCommand("remoteSsh.forceRevoke", {
            id,
            mode,
            confirmed: true,
          });
          if (transportContext) transportContext.assertActive();
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
        },
      );
    } catch (err) {
      return {
        status: "error",
        ...(err && (err.reason || err.code) ? { reason: err.reason || err.code } : {}),
        ...(err && err.recoveryCode ? { recoveryCode: err.recoveryCode } : {}),
        message: (err && err.message) || "identity revocation failed",
      };
    } finally {
      destructiveProfileOperations.delete(id);
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
    if (destructiveProfileOperations.has(id)) {
      return coordinatorFailure({
        code: "transport_operation_busy",
        operation: destructiveProfileOperations.get(id),
        message: "Another destructive Remote SSH operation is already active for this profile",
      });
    }
    if (profile.identityTxn && profile.identityTxn.phase !== "committed") {
      return {
        status: "error",
        message: "Finish or force-revoke the current identity transaction before switching runtime mode",
      };
    }
    runtimeModeSwitches.add(id);
    destructiveProfileOperations.set(id, "runtime-mode-switch");
    try {
      const binding = requireVerifiedInstallationBinding();
      await drainForDestructiveOperation(profile, "runtime-mode-disconnect");
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
          .sort((a, b) => remoteOwnershipDomainKey(a).localeCompare(remoteOwnershipDomainKey(b)))
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
          const historicalProfile = {
            ...target,
            id: workingProfile.id,
            installId: binding.installId,
          };
          const cleanup = await withManagedTransport(
            historicalProfile,
            "runtime-mode-cleanup",
            { resume: "never", historicalTarget: true, skipRuntimeSuspend: true },
            async ({ profile: admittedProfile, runtime }) => uninstallRemoteIntegrationsFn({
              profile: admittedProfile,
              runtime,
              deps: { spawn },
              // Keep the ownership record until the local cleanup-done phase
              // is durable. A crash remains safely retryable.
              preserveIdentity: true,
            }),
          );
          if (!cleanup || cleanup.ok !== true) {
            return {
              status: "error",
              reason: (cleanup && cleanup.reason) || "old_layout_cleanup_failed",
              message: redactTransportDiagnostic(
                (cleanup && cleanup.stderr) || "Old runtime layout cleanup did not complete",
                historicalProfile,
              ),
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
          const historicalProfile = {
            ...target,
            id: workingProfile.id,
            installId: binding.installId,
          };
          const finalized = await withManagedTransport(
            historicalProfile,
            "runtime-mode-finalize",
            { resume: "never", historicalTarget: true, skipRuntimeSuspend: true },
            async ({ profile: admittedProfile, runtime }) => finalizeRetiredRemoteLayoutFn({
              profile: admittedProfile,
              runtime,
              deps: { spawn },
            }),
          );
          if (!finalized || finalized.ok !== true) {
            return {
              status: "error",
              reason: (finalized && finalized.reason) || "old_layout_finalize_failed",
              message: redactTransportDiagnostic(
                (finalized && finalized.stderr) || "Old runtime ownership retirement did not complete",
                historicalProfile,
              ),
            };
          }
        }
      }

      const runtimeKey = txn.toKey;
      let bootstrap = null;
      if (runtimeMode === "profile-isolated"
        && workingProfile.runtimeModeTxn.phase === "cleanup-done") {
        bootstrap = await withManagedTransport(
          workingProfile,
          "runtime-mode-bootstrap",
          { resume: "never", skipRuntimeSuspend: true },
          async ({ profile: admittedProfile, runtime }) => bootstrapIsolatedRuntimeFn({
            profile: admittedProfile,
            installId: binding.installId,
            runtimeKey,
            runtime,
            deps: { spawn },
          }),
        );
        if (!bootstrap || bootstrap.ok !== true) {
          return {
            status: "error",
            reason: (bootstrap && bootstrap.reason) || "isolated_bootstrap_failed",
            message: redactTransportDiagnostic(
              (bootstrap && bootstrap.stderr) || "Could not prepare the isolated runtime root",
              workingProfile,
            ),
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
      return {
        status: "error",
        ...(err && (err.reason || err.code) ? { reason: err.reason || err.code } : {}),
        ...(err && err.recoveryCode ? { recoveryCode: err.recoveryCode } : {}),
        message: redactTransportDiagnostic(
          (err && err.message) || "runtime mode switch failed",
          findProfile(settingsController, id) || profile,
        ),
      };
    } finally {
      runtimeModeSwitches.delete(id);
      destructiveProfileOperations.delete(id);
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
    if (destructiveProfileOperations.has(id)) {
      return coordinatorFailure({
        code: "transport_operation_busy",
        operation: destructiveProfileOperations.get(id),
        message: "Another destructive Remote SSH operation is already active for this profile",
      });
    }
    if (profile.runtimeMode === "profile-isolated" && !enableProfileIsolation) {
      return {
        status: "error",
        reason: "profile_isolation_validation_pending",
        message: "Profile-isolated runtime is gated until the real SSH and CLI validation matrix is complete.",
      };
    }
    destructiveProfileOperations.set(id, "deploy");
    try {
      return await withManagedTransport(
        profile,
        "deploy",
        {
          resume: "if-desired",
          stopMonitorWhenDisconnected: true,
          suspendMessage: "Remote SSH is paused while hooks are deployed.",
        },
        async ({ profile, runtime, inspection, transportContext }) => {
      const installationIdentity = requireVerifiedInstallationBinding();
      if (transportContext) transportContext.assertActive();
      const begin = await settingsController.applyCommand("remoteSsh.beginIdentityRotation", {
        id: profile.id,
      });
      if (transportContext) transportContext.assertActive();
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
        runtime,
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
            if (transportContext) transportContext.assertActive();
            if (!updated || updated.status !== "ok") {
              throw new Error((updated && updated.message) || `failed to persist ${step}`);
            }
            refreshRuntimeProfile(profile.id);
          },
        },
      });
      if (transportContext) transportContext.assertActive();
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
            sshTransportHint: transportHintFromInspection(inspection),
          });
          if (transportContext) transportContext.assertActive();
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
        if (transportContext) transportContext.assertActive();
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
        },
      );
    } catch (err) {
      return {
        status: "error",
        ...(err && (err.reason || err.code) ? { reason: err.reason || err.code } : {}),
        ...(err && err.recoveryCode ? { recoveryCode: err.recoveryCode } : {}),
        ...(err && err.resumeWarning ? { resumeWarning: err.resumeWarning } : {}),
        message: (err && err.message) || "deploy threw",
      };
    } finally {
      destructiveProfileOperations.delete(id);
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

  async function checkInteractiveTransport(profile) {
    if (!transportCoordinator || typeof transportCoordinator.checkInteractive !== "function") {
      return { ok: true };
    }
    return transportCoordinator.checkInteractive(profile);
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
    const availability = await checkInteractiveTransport(profile);
    if (!availability.ok) return coordinatorFailure(availability);
    const r = await spawnSystemTerminalWithSsh(profile);
    return r.ok ? { status: "ok", terminal: r.terminal } : { status: "error", message: r.message };
  });

  handle("remoteSsh:open-terminal", async (_event, payload) => {
    const id = typeof payload === "string" ? payload : (payload && payload.profileId);
    const profile = id ? findProfile(settingsController, id) : null;
    if (!profile) return { status: "error", message: "profile not found" };
    const availability = await checkInteractiveTransport(profile);
    if (!availability.ok) return coordinatorFailure(availability);
    const r = await spawnSystemTerminalWithSsh(profile);
    return r.ok ? { status: "ok", terminal: r.terminal } : { status: "error", message: r.message };
  });

  // Connect every profile flagged `connectOnLaunch`. Called once from main.js
  // after the hook server is up. Best-effort and silent: a failed connect is
  // logged but never blocks startup, and the runtime's own retry/backoff takes
  // over from there. Returns the ids it kicked off (for tests / diagnostics).
  async function connectOnLaunchProfiles() {
    const snap = settingsController.getSnapshot();
    const list = (snap.remoteSsh && Array.isArray(snap.remoteSsh.profiles)) ? snap.remoteSsh.profiles : [];
    const started = [];
    for (const profile of list) {
      if (!profile || profile.connectOnLaunch !== true) continue;
      try {
        await connectProfile(profile);
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
