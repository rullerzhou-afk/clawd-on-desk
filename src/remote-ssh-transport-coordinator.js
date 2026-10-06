"use strict";

const childProcess = require("child_process");
const { EventEmitter } = require("events");
const { localTargetFingerprint } = require("./remote-ssh-transport");

const DEFAULT_DRAIN_TIMEOUT_MS = 10000;

class TransportUndrainedError extends Error {
  constructor(message = "Remote SSH transport did not close before the drain deadline", details = {}) {
    super(message);
    this.name = "TransportUndrainedError";
    this.code = "transport_drain_timeout";
    this.timedOut = true;
    this.drainVerified = false;
    Object.assign(this, details);
  }
}

function errorResult(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function createRemoteSshTransportCoordinator(deps = {}) {
  const spawn = deps.spawn || childProcess.spawn;
  const inspectTransport = deps.inspectEffectiveTransport;
  const setTimeoutFn = deps.setTimeout || setTimeout;
  const clearTimeoutFn = deps.clearTimeout || clearTimeout;
  const drainTimeoutMs = Number.isFinite(deps.drainTimeoutMs)
    ? deps.drainTimeoutMs
    : DEFAULT_DRAIN_TIMEOUT_MS;
  if (typeof inspectTransport !== "function") {
    throw new Error("createRemoteSshTransportCoordinator: inspectEffectiveTransport required");
  }

  const slots = new Map();
  const leases = new WeakMap();
  const sticky = new Map();
  const inspectionInFlight = new Map();
  const inspectionEpochByFingerprint = new Map();
  const lastFingerprintByProfile = new Map();
  const profileRegistrationEpochs = new Map();
  const profileInspections = new Map();
  const intents = new Map();
  const emitter = new EventEmitter();
  let leaseGeneration = 0;
  let attemptGeneration = 0;
  let closing = false;

  function profileIdsForSlot(slot) {
    const ids = new Set();
    if (slot && slot.ownerProfileId) ids.add(slot.ownerProfileId);
    if (slot) {
      for (const [profileId, inspection] of profileInspections.entries()) {
        if (inspection && (
          (inspection.mode === "serialized" && inspection.key === slot.transportKey)
          || (inspection.retainedOccupancyToken
            && inspection.retainedOccupancyToken === slot.occupancyToken)
        )) {
          ids.add(profileId);
        }
      }
    }
    return Array.from(ids).sort();
  }

  function slotForProfileInspection(inspection) {
    if (!inspection) return null;
    if (inspection.mode === "serialized" && inspection.key) {
      return slots.get(inspection.key) || null;
    }
    if (inspection.retainedOccupancyToken) {
      return Array.from(slots.values()).find((candidate) =>
        candidate.phase !== "idle"
        && candidate.occupancyToken === inspection.retainedOccupancyToken
      ) || null;
    }
    return null;
  }

  function slotSnapshot(slot, profileId = slot && slot.ownerProfileId) {
    const quarantine = slot && slot.quarantine;
    const relatedProfileIds = slot && slot.phase !== "idle" ? profileIdsForSlot(slot) : [];
    return {
      profileId: profileId || null,
      transportPhase: slot ? slot.phase : "idle",
      transportOwnerProfileId: slot ? slot.ownerProfileId : null,
      transportOperation: slot ? slot.operationName : null,
      transportErrorReason: quarantine && quarantine.reason || null,
      transportRecoveryCode: quarantine && quarantine.lockStage !== "before-acquire"
        ? "manual_lock_inspection_required"
        : null,
      conflictingProfileIds: relatedProfileIds.filter((id) => id !== profileId),
    };
  }

  function emitSlot(slot, profileId) {
    const profileIds = new Set(profileIdsForSlot(slot));
    if (profileId) profileIds.add(profileId);
    if (profileIds.size === 0) {
      emitter.emit("status-changed", slotSnapshot(slot, profileId));
      return;
    }
    for (const id of profileIds) {
      emitter.emit("status-changed", slotSnapshot(slot, id));
    }
  }

  function onStatusChanged(listener) {
    emitter.on("status-changed", listener);
    return () => emitter.off("status-changed", listener);
  }

  function getIntent(profileId) {
    return intents.get(profileId) || { desiredConnected: false, intentGeneration: 0 };
  }

  function recordIntent(profileId, desiredConnected) {
    const previous = getIntent(profileId);
    const next = {
      desiredConnected: desiredConnected === true,
      intentGeneration: previous.intentGeneration + 1,
    };
    intents.set(profileId, next);
    return { ...next };
  }

  function recordDisconnectIntent(profileId) {
    return recordIntent(profileId, false);
  }

  function forgetProfile(profileId) {
    profileRegistrationEpochs.set(profileId, (profileRegistrationEpochs.get(profileId) || 0) + 1);
    const fingerprint = lastFingerprintByProfile.get(profileId);
    const inspection = profileInspections.get(profileId);
    if (fingerprint) sticky.delete(fingerprint);
    lastFingerprintByProfile.delete(profileId);
    profileInspections.delete(profileId);
    intents.delete(profileId);
    const slot = slotForProfileInspection(inspection);
    if (slot) {
      emitter.emit("status-changed", slotSnapshot(null, profileId));
      emitSlot(slot);
    }
  }

  function registerProfileFingerprint(profile) {
    const fingerprint = localTargetFingerprint(profile);
    const previous = lastFingerprintByProfile.get(profile.id);
    if (previous && previous !== fingerprint) sticky.delete(previous);
    lastFingerprintByProfile.set(profile.id, fingerprint);
    return fingerprint;
  }

  function rememberProfileInspection(profile, inspection, expectedFingerprint, expectedEpoch) {
    if (!profile || typeof profile.id !== "string") return;
    if (Number.isFinite(expectedEpoch)
      && profileRegistrationEpochs.get(profile.id) !== expectedEpoch) return;
    if (expectedFingerprint
      && lastFingerprintByProfile.get(profile.id) !== expectedFingerprint) return;
    const previous = profileInspections.get(profile.id);
    const next = inspection && (inspection.mode === "serialized" || inspection.mode === "parallel")
      ? {
          mode: inspection.mode,
          key: typeof inspection.key === "string" ? inspection.key : null,
          fingerprint: expectedFingerprint || null,
        }
      : { mode: "unknown", key: null, fingerprint: expectedFingerprint || null };
    if (next.mode === "parallel" && previous) {
      const previousSlot = previous.mode === "serialized" && previous.key
        ? slots.get(previous.key)
        : null;
      if (previousSlot && previousSlot.phase !== "idle" && previousSlot.occupancyToken) {
        next.retainedOccupancyToken = previousSlot.occupancyToken;
      } else if (previous.retainedOccupancyToken) {
        const retainedSlot = Array.from(slots.values()).find((slot) =>
          slot.phase !== "idle"
          && slot.occupancyToken === previous.retainedOccupancyToken
        );
        if (retainedSlot) next.retainedOccupancyToken = previous.retainedOccupancyToken;
      }
    }
    profileInspections.set(profile.id, next);
    const changed = !previous
      || previous.mode !== next.mode
      || previous.key !== next.key
      || previous.retainedOccupancyToken !== next.retainedOccupancyToken;
    if (!changed) return;
    if (previous) {
      const oldSlot = slotForProfileInspection(previous);
      emitter.emit("status-changed", slotSnapshot(null, profile.id));
      if (oldSlot) emitSlot(oldSlot);
    }
    const nextSlot = slotForProfileInspection(next);
    if (nextSlot && nextSlot.phase !== "idle") emitSlot(nextSlot, profile.id);
  }

  async function inspect(profile, options = {}) {
    // Safety inspections may target an immutable historical deploy target.
    // They must not change the Settings-facing registration for the current
    // profile id; only refreshProfileInspections owns that registry.
    const fingerprint = localTargetFingerprint(profile);
    let pending = inspectionInFlight.get(fingerprint);
    // Safety-critical callers get an inspection that started after their
    // barrier by default. UI priming may explicitly pass forceFresh:false to
    // coalesce duplicate profiles within the same refresh only.
    if (!pending || options.forceFresh !== false) {
      const epoch = (inspectionEpochByFingerprint.get(fingerprint) || 0) + 1;
      inspectionEpochByFingerprint.set(fingerprint, epoch);
      let promise = null;
      promise = Promise.resolve(inspectTransport(profile)).finally(() => {
        if (inspectionInFlight.get(fingerprint) === pending) inspectionInFlight.delete(fingerprint);
      });
      pending = { promise, epoch };
      inspectionInFlight.set(fingerprint, pending);
    }
    const result = await pending.promise;
    if (inspectionEpochByFingerprint.get(fingerprint) !== pending.epoch) {
      return {
        mode: "unknown",
        kind: "inspection-superseded",
        fingerprint,
        message: "Effective SSH inspection was superseded by a newer safety check; retry the operation.",
      };
    }
    const trackProfile = options.trackProfile === true;
    if (result && result.mode === "serialized" && result.key) {
      sticky.set(fingerprint, {
        lastKnownMode: "serialized",
        key: result.key,
        evidenceKind: result.kind,
        fingerprintVersion: 1,
      });
      if (trackProfile) rememberProfileInspection(
        profile,
        result,
        options.expectedFingerprint || fingerprint,
        options.profileRegistrationEpoch,
      );
      return result;
    }
    if (result && result.mode === "parallel") {
      sticky.delete(fingerprint);
      if (trackProfile) rememberProfileInspection(
        profile,
        result,
        options.expectedFingerprint || fingerprint,
        options.profileRegistrationEpoch,
      );
      return result;
    }
    const previous = sticky.get(fingerprint);
    if (previous && previous.lastKnownMode === "serialized") {
      const resolved = {
        ...result,
        mode: "serialized",
        kind: previous.evidenceKind,
        key: previous.key,
        fingerprint,
        warning: "Effective SSH inspection failed; retaining the last known serialized safety mode.",
        stickyFallback: true,
      };
      if (trackProfile) rememberProfileInspection(
        profile,
        resolved,
        options.expectedFingerprint || fingerprint,
        options.profileRegistrationEpoch,
      );
      return resolved;
    }
    const hint = profile && profile.sshTransportHint;
    if (hint && hint.version === 1 && hint.mode === "serialized" && typeof hint.keyId === "string") {
      const resolved = {
        ...result,
        mode: "serialized",
        kind: hint.kind,
        key: hint.keyId,
        fingerprint,
        warning: "Effective SSH inspection failed; using the trusted historical serialized hint.",
        historicalHintFallback: true,
      };
      if (trackProfile) rememberProfileInspection(
        profile,
        resolved,
        options.expectedFingerprint || fingerprint,
        options.profileRegistrationEpoch,
      );
      return resolved;
    }
    if (trackProfile) rememberProfileInspection(
      profile,
      result,
      options.expectedFingerprint || fingerprint,
      options.profileRegistrationEpoch,
    );
    return result;
  }

  async function refreshProfileInspections(profiles) {
    const currentProfiles = (Array.isArray(profiles) ? profiles : [])
      .filter((profile) => profile && typeof profile.id === "string");
    const currentIds = new Set(currentProfiles.map((profile) => profile.id));
    const registeredIds = new Set([
      ...profileInspections.keys(),
      ...lastFingerprintByProfile.keys(),
      ...profileRegistrationEpochs.keys(),
    ]);
    for (const profileId of registeredIds) {
      if (!currentIds.has(profileId)) forgetProfile(profileId);
    }
    const registrations = currentProfiles.map((profile) => {
      const epoch = (profileRegistrationEpochs.get(profile.id) || 0) + 1;
      profileRegistrationEpochs.set(profile.id, epoch);
      const fingerprint = registerProfileFingerprint(profile);
      return { profile, epoch, fingerprint };
    });
    await Promise.allSettled(registrations.map(async ({ profile, epoch, fingerprint }) => {
      try {
        // A safety inspection may supersede a display-only priming read. In
        // that case follow the newest in-flight result without superseding it
        // in return. Keep the loop bounded; retaining the previous mapping is
        // safer than blocking list/status forever under continuous edits.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const result = await inspect(profile, {
            forceFresh: false,
            trackProfile: true,
            expectedFingerprint: fingerprint,
            profileRegistrationEpoch: epoch,
          });
          if (!result || result.kind !== "inspection-superseded") return result;
          if (profileRegistrationEpochs.get(profile.id) !== epoch
            || lastFingerprintByProfile.get(profile.id) !== fingerprint) return result;
        }
        return null;
      } catch (err) {
        throw err;
      }
    }));
    return listSnapshots();
  }

  function createLease(slot, profileId, operation) {
    const lease = Object.freeze({});
    const internal = {
      slot,
      profileId,
      operation,
      leaseGeneration: ++leaseGeneration,
      attemptGeneration: ++attemptGeneration,
      attemptToken: Object.freeze({}),
      active: true,
      invalidReason: null,
      lockStage: "before-acquire",
      lastCloseProvenance: null,
    };
    leases.set(lease, internal);
    slot.activeLease = lease;
    slot.operationName = operation;
    emitSlot(slot, profileId);
    return lease;
  }

  function validateLease(lease, { attemptToken } = {}) {
    const internal = leases.get(lease);
    if (!internal || !internal.active || internal.slot.activeLease !== lease) {
      throw Object.assign(new Error("Remote SSH transport reservation is no longer active"), {
        code: "transport_operation_inactive",
      });
    }
    if (attemptToken && internal.attemptToken !== attemptToken) {
      throw Object.assign(new Error("Remote SSH transport attempt is stale"), {
        code: "transport_attempt_stale",
      });
    }
    return internal;
  }

  function makeContext(lease) {
    return Object.freeze({
      reservationToken: lease,
      get attemptToken() {
        const internal = validateLease(lease);
        return internal.attemptToken;
      },
      get profileId() { return validateLease(lease).profileId; },
      get transportKey() { return validateLease(lease).slot.transportKey; },
      assertActive() { validateLease(lease); },
      nextAttempt() {
        const internal = validateLease(lease);
        internal.attemptGeneration = ++attemptGeneration;
        internal.attemptToken = Object.freeze({});
        return internal.attemptToken;
      },
      setLockStage(stage) {
        const internal = validateLease(lease);
        if (!["before-acquire", "acquire-attempted", "lock-owned"].includes(stage)) {
          throw new Error("invalid remote transport lock stage");
        }
        internal.lockStage = stage;
      },
      getRecoveryCode() {
        const internal = validateLease(lease);
        return internal.lockStage === "before-acquire"
          ? null
          : "manual_lock_inspection_required";
      },
      transitionToConnection() {
        const internal = validateLease(lease);
        if (internal.slot.trackedChildren.size > 0) {
          throw new TransportUndrainedError("Cannot resume a connection while an operation child is still live", {
            profileId: internal.profileId,
            operation: internal.operation,
          });
        }
        internal.operation = "connect";
        internal.lockStage = "before-acquire";
        internal.slot.operationName = "connect";
        internal.slot.phase = "preparing";
        emitSlot(internal.slot, internal.profileId);
      },
      spawn(spec) {
        return spawnManagedTransportChild({ ...spec, reservationToken: lease });
      },
    });
  }

  function retainedSerializedSlotFor(profileId, inspection) {
    return Array.from(slots.values()).find((slot) =>
      slot.phase !== "idle"
      && ((slot.inspection && slot.inspection.fingerprint === inspection.fingerprint)
        || (profileInspections.get(profileId)
          && profileInspections.get(profileId).retainedOccupancyToken === slot.occupancyToken))
    ) || null;
  }

  async function acquire(profile, operation, options = {}) {
    if (closing) {
      return errorResult("transport_shutdown", "Remote SSH transport is shutting down");
    }
    if (!profile || typeof profile.id !== "string") {
      return errorResult("invalid_profile", "Remote SSH profile id is required");
    }
    const inspection = await inspect(profile);
    if (!inspection || inspection.mode === "unknown") {
      return errorResult(
        "transport_inspection_failed",
        (inspection && inspection.message) || "Unable to inspect effective SSH transport",
        { profileId: profile.id },
      );
    }
    if (inspection.mode !== "serialized") {
      // A live serialized slot remains authoritative for the local target
      // fingerprint captured at admission. If ssh_config drifts to ordinary
      // while that child is live, treating the next operation as parallel
      // would bypass the slot and overlap the existing ProxyCommand chain.
      const retained = retainedSerializedSlotFor(profile.id, inspection);
      if (retained) {
        const sameOwner = retained.ownerProfileId === profile.id;
        return errorResult(
          sameOwner ? "profile_changed" : "serialized_transport_busy",
          sameOwner
            ? "The effective SSH transport changed; Disconnect the existing serialized session first"
            : "Another profile still owns the serialized transport for this SSH target",
          {
            profileId: profile.id,
            ownerProfileId: retained.ownerProfileId || undefined,
            operation: retained.operationName || undefined,
          },
        );
      }
      return { ok: true, serialized: false, inspection, context: null };
    }

    // A live connection/operation is bound to the immutable transport key
    // that admitted it.  A settings edit must not let the same profile create
    // a second slot while the old ProxyCommand chain is still alive.
    for (const existing of slots.values()) {
      if (existing.ownerProfileId === profile.id
        && existing.transportKey !== inspection.key
        && existing.phase !== "idle") {
        return errorResult(
          "profile_changed",
          "The effective SSH transport changed; Disconnect before using the updated profile",
          { profileId: profile.id, operation: existing.operationName || undefined },
        );
      }
    }

    let slot = slots.get(inspection.key);
    if (!slot) {
      slot = {
        transportKey: inspection.key,
        inspection,
        ownerProfileId: null,
        phase: "idle",
        operationName: null,
        activeLease: null,
        trackedChildren: new Map(),
        quarantine: null,
        occupancyToken: null,
      };
      slots.set(inspection.key, slot);
    } else if (slot.phase === "idle") {
      slot.inspection = inspection;
    }
    if (slot.phase !== "idle") {
      if (slot.phase === "failed" || slot.phase === "quarantined") {
        const recoveryCode = slot.quarantine && slot.quarantine.lockStage !== "before-acquire"
          ? "manual_lock_inspection_required"
          : undefined;
        return errorResult(
          (slot.quarantine && slot.quarantine.reason) || "transport_drain_timeout",
          "The serialized SSH transport is quarantined and requires explicit recovery",
          {
            profileId: profile.id,
            ownerProfileId: slot.ownerProfileId || undefined,
            operation: slot.operationName || (slot.quarantine && slot.quarantine.operation) || undefined,
            ...(recoveryCode ? { recoveryCode } : {}),
          },
        );
      }
      const sameOwner = slot.ownerProfileId === profile.id;
      if (!(sameOwner && options.takeoverOwner === true)) {
        return errorResult(
          sameOwner ? "transport_operation_busy" : "serialized_transport_busy",
          sameOwner
            ? "Another Remote SSH operation is already active for this profile"
            : "Another profile already owns this serialized SSH transport",
          {
            profileId: profile.id,
            ownerProfileId: slot.ownerProfileId || undefined,
            operation: slot.operationName || undefined,
          },
        );
      }
      if (slot.operationName && slot.operationName !== "connect") {
        return errorResult(
          "transport_operation_busy",
          "Another Remote SSH operation is already active for this profile",
          {
            profileId: profile.id,
            ownerProfileId: slot.ownerProfileId || undefined,
            operation: slot.operationName,
          },
        );
      }
      const previous = leases.get(slot.activeLease);
      if (previous && previous.lockStage !== "before-acquire") {
        return errorResult(
          "transport_operation_busy",
          "The active Remote SSH connection preparation is completing a protected remote mutation",
          {
            profileId: profile.id,
            ownerProfileId: slot.ownerProfileId || undefined,
            operation: slot.operationName || undefined,
          },
        );
      }
      if (previous) {
        previous.active = false;
        previous.invalidReason = "owner_takeover";
      }
      slot.phase = "suspending";
    } else {
      slot.occupancyToken = Object.freeze({});
      slot.ownerProfileId = profile.id;
      slot.phase = options.phase || "preparing";
    }
    const lease = createLease(slot, profile.id, operation);
    return {
      ok: true,
      serialized: true,
      inspection,
      context: makeContext(lease),
    };
  }

  async function acquireConnection(profile, options = {}) {
    const result = await acquire(profile, "connect", { phase: "preparing" });
    if (result.ok && result.serialized) {
      result.intent = recordIntent(profile.id, true);
    } else if (result.ok && !result.serialized) {
      result.intent = recordIntent(profile.id, true);
    }
    return result;
  }

  async function acquireOperation(profile, operation) {
    return acquire(profile, operation, { takeoverOwner: true, phase: "operation" });
  }

  async function acquireOwnedOperation(profile, operation) {
    if (!profile || typeof profile.id !== "string") {
      return errorResult("invalid_profile", "Remote SSH profile id is required");
    }
    const owned = Array.from(slots.values()).filter((slot) =>
      slot.ownerProfileId === profile.id && slot.phase !== "idle"
    );
    if (owned.length === 0) return acquireOperation(profile, operation);
    if (owned.length !== 1) {
      return errorResult(
        "serialized_transport_busy",
        "The profile owns more than one active serialized SSH transport",
        { profileId: profile.id },
      );
    }
    const slot = owned[0];
    if (slot.phase === "failed" || slot.phase === "quarantined") {
      const recoveryCode = slot.quarantine && slot.quarantine.lockStage !== "before-acquire"
        ? "manual_lock_inspection_required"
        : undefined;
      return errorResult(
        (slot.quarantine && slot.quarantine.reason) || "transport_drain_timeout",
        "The serialized SSH transport is quarantined and requires explicit recovery",
        {
          profileId: profile.id,
          ownerProfileId: slot.ownerProfileId || undefined,
          operation: (slot.quarantine && slot.quarantine.operation) || undefined,
          ...(recoveryCode ? { recoveryCode } : {}),
        },
      );
    }
    if (slot.operationName && slot.operationName !== "connect") {
      return errorResult(
        "transport_operation_busy",
        "Another Remote SSH operation is already active for this profile",
        {
          profileId: profile.id,
          ownerProfileId: slot.ownerProfileId || undefined,
          operation: slot.operationName,
        },
      );
    }
    const previous = leases.get(slot.activeLease);
    if (previous && previous.lockStage !== "before-acquire") {
      return errorResult(
        "transport_operation_busy",
        "The active Remote SSH connection preparation is completing a protected remote mutation",
        {
          profileId: profile.id,
          ownerProfileId: slot.ownerProfileId || undefined,
          operation: slot.operationName || undefined,
        },
      );
    }
    if (previous) {
      previous.active = false;
      previous.invalidReason = "owner_takeover";
    }
    slot.phase = "suspending";
    const lease = createLease(slot, profile.id, operation);
    return {
      ok: true,
      serialized: true,
      inspection: slot.inspection || {
        mode: "serialized",
        kind: "retained-owner",
        key: slot.transportKey,
      },
      context: makeContext(lease),
      retainedOwner: true,
    };
  }

  function trackChild(internal, child, metadata) {
    let closeResolve;
    const closePromise = new Promise((resolve) => { closeResolve = resolve; });
    const record = {
      profileId: internal.profileId,
      transportKey: internal.slot.transportKey,
      role: metadata.role,
      tool: metadata.tool,
      attemptToken: internal.attemptToken,
      closePromise,
      closed: false,
    };
    internal.slot.trackedChildren.set(child, record);
    child.once("close", (code, signal) => {
      if (record.closed) return;
      record.closed = true;
      internal.lastCloseProvenance = { code, signal };
      internal.slot.trackedChildren.delete(child);
      closeResolve({ code, signal });
      if (signal != null && !closing) {
        // A signal only proves that the outer ssh.exe closed. It does not prove
        // its nested ProxyCommand process (notably gh cs ssh --stdio) drained.
        // Quarantine immediately in every runtime phase, not only after an
        // explicit drain timeout, and invalidate whichever lease currently
        // owns the shared slot.
        const current = leases.get(internal.slot.activeLease) || internal;
        current.active = false;
        current.invalidReason = "transport_drain_unverified";
        internal.active = false;
        internal.invalidReason = "transport_drain_unverified";
        internal.slot.activeLease = null;
        internal.slot.operationName = null;
        internal.slot.phase = "failed";
        internal.slot.quarantine = {
          reason: "transport_drain_unverified",
          lockStage: current.lockStage || internal.lockStage,
          operation: current.operation || internal.operation,
          childCount: internal.slot.trackedChildren.size,
        };
        emitSlot(internal.slot, current.profileId || internal.profileId);
        return;
      }
      if (internal.slot.phase === "quarantined" && internal.slot.trackedChildren.size === 0) {
        const previousOwner = internal.slot.ownerProfileId || internal.profileId;
        internal.slot.activeLease = null;
        internal.slot.operationName = null;
        if (internal.slot.quarantine
          && internal.slot.quarantine.lockStage === "before-acquire"
          && signal == null) {
          // No remote deploy lock could have been touched. A later natural or
          // cooperatively requested close proves the top-level transport has
          // drained, so a new explicit operation may be admitted. Operation
          // takeovers never force-kill managed one-shots; app shutdown is the
          // only forced-close path and admits no subsequent work.
          internal.slot.phase = "idle";
          internal.slot.ownerProfileId = null;
          internal.slot.quarantine = null;
        } else {
          internal.slot.phase = "failed";
        }
        emitSlot(internal.slot, previousOwner);
      }
    });
    return record;
  }

  function spawnManagedTransportChild(spec = {}) {
    const internal = validateLease(spec.reservationToken, { attemptToken: spec.attemptToken });
    if (!spec.role || !spec.tool || !Array.isArray(spec.args)) {
      throw new Error("spawnManagedTransportChild requires role, tool, and args");
    }
    if (internal.slot.trackedChildren.size > 0) {
      throw Object.assign(new Error("Serialized SSH transport already has a live child"), {
        code: "serialized_transport_busy",
      });
    }
    const child = spawn(spec.tool, spec.args, spec.options || {});
    trackChild(internal, child, spec);
    return child;
  }

  function setPhase(context, phase) {
    const internal = validateLease(context && context.reservationToken);
    internal.slot.phase = phase;
    emitSlot(internal.slot, internal.profileId);
  }

  function waitForDrain(context, requestStop, timeoutOverride) {
    const internal = validateLease(context && context.reservationToken);
    internal.slot.phase = "suspending";
    emitSlot(internal.slot, internal.profileId);
    const records = Array.from(internal.slot.trackedChildren.entries());
    for (const [child, record] of records) {
      try { requestStop(child, record); } catch {}
    }
    if (records.length === 0) return Promise.resolve({ ok: true, drainVerified: true });
    const deadline = Number.isFinite(timeoutOverride) ? timeoutOverride : drainTimeoutMs;
    return new Promise((resolve, reject) => {
      let timer = null;
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeoutFn(timer);
        fn(value);
      };
      Promise.all(records.map(([, record]) => record.closePromise)).then((outcomes) => {
        if (outcomes.some((outcome) => outcome && outcome.signal != null)) {
          internal.active = false;
          internal.invalidReason = "transport_drain_unverified";
          internal.slot.phase = "failed";
          internal.slot.activeLease = null;
          internal.slot.operationName = null;
          internal.slot.quarantine = {
            reason: "transport_drain_unverified",
            lockStage: internal.lockStage,
            operation: internal.operation,
            childCount: 0,
          };
          emitSlot(internal.slot, internal.profileId);
          const err = new TransportUndrainedError(
            "The outer SSH process was force-terminated; nested transport drain is unverified",
            { profileId: internal.profileId, operation: internal.operation },
          );
          err.code = "transport_drain_unverified";
          finish(reject, err);
          return;
        }
        finish(resolve, { ok: true, drainVerified: true });
      });
      timer = setTimeoutFn(() => {
        internal.active = false;
        internal.invalidReason = "transport_drain_timeout";
        internal.slot.phase = "quarantined";
        internal.slot.quarantine = {
          reason: "transport_drain_timeout",
          lockStage: internal.lockStage,
          operation: internal.operation,
          childCount: internal.slot.trackedChildren.size,
        };
        emitSlot(internal.slot, internal.profileId);
        finish(reject, new TransportUndrainedError(undefined, {
          profileId: internal.profileId,
          operation: internal.operation,
          recoveryCode: internal.lockStage === "before-acquire"
            ? undefined
            : "manual_lock_inspection_required",
        }));
      }, deadline);
    });
  }

  function invalidate(context, reason = "operation_invalidated") {
    const internal = validateLease(context && context.reservationToken);
    internal.active = false;
    internal.invalidReason = reason;
    internal.slot.phase = "quarantined";
    internal.slot.quarantine = {
      reason,
      lockStage: internal.lockStage,
      operation: internal.operation,
      childCount: internal.slot.trackedChildren.size,
    };
    emitSlot(internal.slot, internal.profileId);
  }

  function abortAfterVerifiedClose(context, reason = "operation_timeout") {
    const internal = validateLease(context && context.reservationToken);
    if (internal.slot.trackedChildren.size > 0) {
      throw new TransportUndrainedError("Cannot abort while the transport child is still live", {
        profileId: internal.profileId,
        operation: internal.operation,
      });
    }
    if (internal.lastCloseProvenance && internal.lastCloseProvenance.signal != null) {
      internal.active = false;
      internal.invalidReason = "transport_drain_unverified";
      internal.slot.activeLease = null;
      internal.slot.operationName = null;
      internal.slot.phase = "failed";
      internal.slot.quarantine = {
        reason: "transport_drain_unverified",
        lockStage: internal.lockStage,
        operation: internal.operation,
        childCount: 0,
      };
      emitSlot(internal.slot, internal.profileId);
      const err = new TransportUndrainedError(
        "The outer SSH process was force-terminated; nested transport drain is unverified",
        { profileId: internal.profileId, operation: internal.operation },
      );
      err.code = "transport_drain_unverified";
      throw err;
    }
    const recoveryCode = internal.lockStage === "before-acquire"
      ? null
      : "manual_lock_inspection_required";
    internal.active = false;
    internal.invalidReason = reason;
    internal.slot.activeLease = null;
    internal.slot.operationName = null;
    internal.slot.quarantine = recoveryCode ? {
      reason,
      lockStage: internal.lockStage,
      operation: internal.operation,
      childCount: 0,
    } : null;
    if (recoveryCode) {
      internal.slot.phase = "failed";
    } else {
      internal.slot.phase = "idle";
      internal.slot.ownerProfileId = null;
    }
    emitSlot(internal.slot, internal.profileId);
    return { recoveryCode };
  }

  function release(context, options = {}) {
    const internal = validateLease(context && context.reservationToken);
    if (internal.slot.trackedChildren.size > 0) {
      throw new TransportUndrainedError("Cannot release a transport with a live child", {
        profileId: internal.profileId,
        operation: internal.operation,
      });
    }
    internal.active = false;
    internal.invalidReason = "released";
    internal.slot.activeLease = null;
    internal.slot.operationName = null;
    if (options.keepOwner === true) {
      internal.slot.phase = options.phase || "tunnel";
    } else {
      internal.slot.phase = options.phase || "idle";
      internal.slot.ownerProfileId = null;
    }
    emitSlot(internal.slot, internal.profileId);
  }

  function snapshotForProfile(profileId) {
    const intent = getIntent(profileId);
    for (const slot of slots.values()) {
      if (slot.ownerProfileId !== profileId) continue;
      return { ...slotSnapshot(slot, profileId), transportDesiredConnected: intent.desiredConnected };
    }
    const inspection = profileInspections.get(profileId);
    if (inspection && inspection.retainedOccupancyToken) {
      const retainedSlot = Array.from(slots.values()).find((slot) =>
        slot.phase !== "idle"
        && slot.occupancyToken === inspection.retainedOccupancyToken
      );
      if (retainedSlot) {
        return { ...slotSnapshot(retainedSlot, profileId), transportDesiredConnected: intent.desiredConnected };
      }
    }
    if (inspection && inspection.mode === "serialized" && inspection.key) {
      const slot = slots.get(inspection.key);
      if (slot && slot.phase !== "idle") {
        return { ...slotSnapshot(slot, profileId), transportDesiredConnected: intent.desiredConnected };
      }
    }
    return { ...slotSnapshot(null, profileId), transportDesiredConnected: intent.desiredConnected };
  }

  function getActiveOwnerOperation(profileId) {
    for (const slot of slots.values()) {
      if (slot.ownerProfileId !== profileId || slot.phase === "idle") continue;
      const active = leases.get(slot.activeLease);
      return {
        phase: slot.phase,
        operation: slot.operationName,
        quarantined: slot.phase === "failed" || slot.phase === "quarantined",
        lockStage: active
          ? active.lockStage
          : (slot.quarantine && slot.quarantine.lockStage),
        quarantineLockStage: slot.quarantine && slot.quarantine.lockStage,
        quarantineReason: slot.quarantine && slot.quarantine.reason,
      };
    }
    return null;
  }

  function listSnapshots() {
    const profileIds = new Set(profileInspections.keys());
    for (const slot of slots.values()) {
      if (slot.ownerProfileId) profileIds.add(slot.ownerProfileId);
      for (const profileId of profileIdsForSlot(slot)) profileIds.add(profileId);
    }
    return Array.from(profileIds, (profileId) => snapshotForProfile(profileId));
  }

  async function checkInteractive(profile) {
    if (closing) return errorResult("transport_shutdown", "Remote SSH transport is shutting down");
    const inspection = await inspect(profile);
    if (!inspection || inspection.mode === "unknown") {
      return errorResult(
        "transport_inspection_failed",
        (inspection && inspection.message) || "Unable to inspect effective SSH transport",
        { profileId: profile && profile.id },
      );
    }
    if (inspection.mode !== "serialized") {
      const retained = retainedSerializedSlotFor(profile.id, inspection);
      if (retained) {
        const sameOwner = retained.ownerProfileId === profile.id;
        return errorResult(
          sameOwner ? "profile_changed" : "serialized_transport_busy",
          sameOwner
            ? "The effective SSH transport changed; Disconnect the existing serialized session first"
            : "Another profile still owns the serialized transport for this SSH target",
          {
            profileId: profile.id,
            ownerProfileId: retained.ownerProfileId || undefined,
            operation: retained.operationName || undefined,
          },
        );
      }
      return { ok: true, serialized: false, inspection };
    }
    const slot = slots.get(inspection.key);
    if (slot && slot.phase !== "idle") {
      return errorResult(
        "serialized_transport_busy",
        "Disconnect the managed Remote SSH session before opening an interactive terminal",
        {
          profileId: profile.id,
          ownerProfileId: slot.ownerProfileId || undefined,
          operation: slot.operationName || undefined,
        },
      );
    }
    return { ok: true, serialized: true, inspection };
  }

  function shutdown(timeoutOverride) {
    closing = true;
    const records = [];
    for (const slot of slots.values()) {
      slot.phase = "stopping";
      const internal = leases.get(slot.activeLease);
      if (internal) {
        internal.active = false;
        internal.invalidReason = "transport_shutdown";
      }
      for (const [child, record] of slot.trackedChildren.entries()) {
        records.push([child, record]);
        if (record.role === "persistent-tunnel-readiness" && child.stdin) {
          try { child.stdin.end(); } catch {}
        } else {
          // Final app shutdown may terminate the exact top-level child that
          // Clawd owns. No later transport work is admitted in this process.
          try { child.kill(); } catch {}
        }
      }
    }
    if (records.length === 0) {
      return Promise.resolve({ ok: true, drainVerified: true, remaining: 0 });
    }
    const deadline = Number.isFinite(timeoutOverride) ? timeoutOverride : drainTimeoutMs;
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeoutFn(timer);
        resolve(result);
      };
      Promise.all(records.map(([, record]) => record.closePromise)).then(() => {
        finish({ ok: true, drainVerified: true, remaining: 0 });
      });
      timer = setTimeoutFn(() => {
        let remaining = 0;
        for (const [child, record] of records) {
          if (record.closed) continue;
          remaining += 1;
          try { child.kill(); } catch {}
        }
        finish({ ok: false, drainVerified: false, remaining });
      }, deadline);
    });
  }

  return {
    inspect,
    acquire,
    acquireConnection,
    acquireOperation,
    acquireOwnedOperation,
    recordDisconnectIntent,
    getIntent,
    forgetProfile,
    refreshProfileInspections,
    spawnManagedTransportChild,
    waitForDrain,
    setPhase,
    invalidate,
    abortAfterVerifiedClose,
    release,
    snapshotForProfile,
    getActiveOwnerOperation,
    listSnapshots,
    onStatusChanged,
    checkInteractive,
    shutdown,
    isClosing: () => closing,
    _slots: slots,
    _sticky: sticky,
    _profileInspections: profileInspections,
  };
}

module.exports = {
  DEFAULT_DRAIN_TIMEOUT_MS,
  TransportUndrainedError,
  createRemoteSshTransportCoordinator,
};
