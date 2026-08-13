"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  TransportUndrainedError,
  createRemoteSshTransportCoordinator,
} = require("../src/remote-ssh-transport-coordinator");

function profile(id = "p1", host = "space") {
  return { id, host, port: 22, sshTransportMode: "auto" };
}

function serializedInspection(p) {
  return Promise.resolve({
    mode: "serialized",
    kind: "codespaces-stdio",
    key: "codespace:fuzzy-space",
    fingerprint: `fp:${p.host}:${p.port || 22}`,
  });
}

function parallelInspection(p) {
  return Promise.resolve({
    mode: "parallel",
    kind: "standard",
    key: `parallel:${p.host}`,
    fingerprint: `fp:${p.host}`,
  });
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = { endCalls: 0, end() { this.endCalls += 1; } };
  child.kill = () => {};
  return child;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("serialized spawn is rejected before raw spawn without a live opaque lease", async () => {
  let spawnCalls = 0;
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
    spawn: () => { spawnCalls += 1; return fakeChild(); },
  });
  assert.throws(() => coordinator.spawnManagedTransportChild({
    reservationToken: {},
    profileId: "p1",
    role: "node-resolve",
    tool: "ssh",
    args: [],
  }), /reservation is no longer active/);
  assert.equal(spawnCalls, 0);
});

test("one serialized lease admits at most one live child until close", async () => {
  const children = [];
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
    spawn: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });
  const acquired = await coordinator.acquireConnection(profile());
  assert.equal(acquired.ok, true);
  const first = acquired.context.spawn({
    attemptToken: acquired.context.attemptToken,
    role: "node-resolve",
    tool: "ssh",
    args: ["space", "node -v"],
  });
  assert.throws(() => acquired.context.spawn({
    attemptToken: acquired.context.attemptToken,
    role: "probe",
    tool: "ssh",
    args: ["space", "probe"],
  }), /already has a live child/);
  first.emit("exit", 0, null);
  assert.throws(() => acquired.context.spawn({
    attemptToken: acquired.context.attemptToken,
    role: "probe",
    tool: "ssh",
    args: ["space", "probe"],
  }), /already has a live child/, "exit must not release admission");
  first.emit("close", 0, null);
  const second = acquired.context.spawn({
    attemptToken: acquired.context.attemptToken,
    role: "probe",
    tool: "ssh",
    args: ["space", "probe"],
  });
  assert.equal(children.length, 2);
  second.emit("close", 0, null);
});

test("same-key non-owner is busy and does not change its intent", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
    spawn: () => fakeChild(),
  });
  const owner = await coordinator.acquireConnection(profile("p1"));
  assert.equal(owner.ok, true);
  const other = await coordinator.acquireConnection(profile("p2", "alias-two"));
  assert.equal(other.ok, false);
  assert.equal(other.code, "serialized_transport_busy");
  assert.deepEqual(coordinator.getIntent("p2"), { desiredConnected: false, intentGeneration: 0 });
});

test("same-key profiles receive safe conflict snapshots until the owner releases", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
  });
  const first = profile("p1", "alias-one");
  const second = profile("p2", "alias-two");
  await coordinator.refreshProfileInspections([first, second]);
  const events = [];
  coordinator.onStatusChanged((snapshot) => events.push(snapshot));

  const acquired = await coordinator.acquireConnection(first);
  assert.equal(acquired.ok, true);
  const owner = coordinator.snapshotForProfile(first.id);
  const conflict = coordinator.snapshotForProfile(second.id);
  assert.equal(owner.transportOwnerProfileId, first.id);
  assert.deepEqual(owner.conflictingProfileIds, [second.id]);
  assert.equal(conflict.transportPhase, "preparing");
  assert.equal(conflict.transportOwnerProfileId, first.id);
  assert.deepEqual(conflict.conflictingProfileIds, [first.id]);
  assert.equal(Object.hasOwn(conflict, "transportKey"), false);
  assert.equal(Object.hasOwn(conflict, "inspection"), false);
  assert.ok(events.some((snapshot) => snapshot.profileId === second.id
    && snapshot.transportOwnerProfileId === first.id));

  coordinator.release(acquired.context);
  assert.equal(coordinator.snapshotForProfile(second.id).transportPhase, "idle");
  assert.deepEqual(coordinator.snapshotForProfile(second.id).conflictingProfileIds, []);
});

test("display priming follows a newer safety inspection instead of committing a superseded result", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async () => {
      calls += 1;
      if (calls === 1) return first.promise;
      if (calls === 2) return second.promise;
      return {
        mode: "serialized",
        kind: "codespaces-stdio",
        key: "codespace:new",
        fingerprint: "effective:new",
      };
    },
  });
  const testProfile = profile("prime-race", "same-config-path");
  const priming = coordinator.refreshProfileInspections([testProfile]);
  await Promise.resolve();
  const admission = coordinator.acquireConnection(testProfile);
  first.resolve({
    mode: "parallel",
    kind: "standard",
    key: "parallel:old",
    fingerprint: "effective:old",
  });
  second.resolve({
    mode: "serialized",
    kind: "codespaces-stdio",
    key: "codespace:new",
    fingerprint: "effective:new",
  });
  const acquired = await admission;
  assert.equal(acquired.ok, true);
  assert.equal(acquired.serialized, true);
  await priming;
  assert.equal(coordinator._profileInspections.get(testProfile.id).mode, "serialized");
  assert.equal(coordinator._profileInspections.get(testProfile.id).key, "codespace:new");
  coordinator.release(acquired.context);
});

test("a historical safety inspection cannot replace the current profile registry fingerprint", async () => {
  const currentPending = deferred();
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async (p) => {
      if (p.host === "current-host") return currentPending.promise;
      return {
        mode: "serialized",
        kind: "codespaces-stdio",
        key: "codespace:historical",
        fingerprint: "effective:historical",
      };
    },
  });
  const current = profile("same-profile", "current-host");
  const historical = profile("same-profile", "historical-host");
  const priming = coordinator.refreshProfileInspections([current]);
  await Promise.resolve();
  const inspectedHistorical = await coordinator.inspect(historical);
  assert.equal(inspectedHistorical.key, "codespace:historical");
  currentPending.resolve({
    mode: "serialized",
    kind: "codespaces-stdio",
    key: "codespace:current",
    fingerprint: "effective:current",
  });
  await priming;
  assert.equal(coordinator._profileInspections.get(current.id).key, "codespace:current");
});

test("deleting a profile while its first inspection is pending cannot recreate a ghost mapping", async () => {
  const pending = deferred();
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: () => pending.promise,
  });
  const testProfile = profile("deleted-before-prime", "pending-host");
  const firstRefresh = coordinator.refreshProfileInspections([testProfile]);
  await Promise.resolve();
  await coordinator.refreshProfileInspections([]);
  pending.resolve({
    mode: "serialized",
    kind: "codespaces-stdio",
    key: "codespace:ghost",
    fingerprint: "effective:ghost",
  });
  await firstRefresh;
  assert.equal(coordinator._profileInspections.has(testProfile.id), false);
  assert.equal(
    coordinator.listSnapshots().some((snapshot) => snapshot.profileId === testProfile.id),
    false,
  );
});

test("a retained serialized occupancy stays visible after display inspection drifts to parallel", async () => {
  const modes = new Map([["p1", "serialized"], ["p2", "serialized"]]);
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async (p) => modes.get(p.id) === "parallel"
      ? {
          mode: "parallel",
          kind: "standard",
          key: `parallel:${p.host}`,
          fingerprint: `effective:${p.host}`,
        }
      : {
          mode: "serialized",
          kind: "codespaces-stdio",
          key: "codespace:retained-ui",
          fingerprint: `effective:${p.host}`,
        },
  });
  const ownerProfile = profile("p1", "owner-alias");
  const conflictProfile = profile("p2", "conflict-alias");
  await coordinator.refreshProfileInspections([ownerProfile, conflictProfile]);
  const owner = await coordinator.acquireConnection(ownerProfile);
  modes.set("p2", "parallel");
  await coordinator.refreshProfileInspections([ownerProfile, conflictProfile]);

  const conflict = coordinator.snapshotForProfile(conflictProfile.id);
  assert.equal(conflict.transportOwnerProfileId, ownerProfile.id);
  assert.equal(conflict.transportPhase, "preparing");
  assert.deepEqual(conflict.conflictingProfileIds, [ownerProfile.id]);

  const events = [];
  coordinator.onStatusChanged((snapshot) => events.push(snapshot));
  await coordinator.refreshProfileInspections([ownerProfile]);
  assert.deepEqual(coordinator.snapshotForProfile(ownerProfile.id).conflictingProfileIds, []);
  assert.ok(events.some((snapshot) => snapshot.profileId === conflictProfile.id
    && snapshot.transportPhase === "idle"));
  coordinator.release(owner.context);
});

test("listSnapshots always prefers a profile's owned slot over its display mapping", async () => {
  let pKey = "codespace:x";
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async (p) => ({
      mode: "serialized",
      kind: "codespaces-stdio",
      key: p.id === "p" ? pKey : "codespace:y",
      fingerprint: `effective:${p.id}:${pKey}`,
    }),
  });
  const ownedProfile = profile("p", "alias-x");
  const otherProfile = profile("q", "alias-y");
  const owned = await coordinator.acquireConnection(ownedProfile);
  const other = await coordinator.acquireConnection(otherProfile);
  pKey = "codespace:y";
  await coordinator.refreshProfileInspections([ownedProfile, otherProfile]);
  const listed = coordinator.listSnapshots().find((snapshot) => snapshot.profileId === "p");
  assert.equal(listed.transportOwnerProfileId, "p");
  assert.equal(listed.transportPhase, "preparing");
  coordinator.release(owned.context);
  coordinator.release(other.context);
});

test("profile snapshot exposes desired connection intent during an owned operation", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
  });
  const testProfile = profile("intent-snapshot");
  await coordinator.acquireConnection(testProfile);
  const operation = await coordinator.acquireOwnedOperation(testProfile, "deploy");
  assert.equal(operation.ok, true);
  assert.deepEqual(coordinator.snapshotForProfile(testProfile.id), {
    profileId: testProfile.id,
    transportPhase: "suspending",
    transportOwnerProfileId: testProfile.id,
    transportOperation: "deploy",
    transportErrorReason: null,
    transportRecoveryCode: null,
    conflictingProfileIds: [],
    transportDesiredConnected: true,
  });

  coordinator.recordDisconnectIntent(testProfile.id);
  assert.equal(
    coordinator.snapshotForProfile(testProfile.id).transportDesiredConnected,
    false,
  );
  coordinator.release(operation.context);
});

test("ordinary inspection does not create a serialized slot", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: parallelInspection,
  });
  const result = await coordinator.acquireConnection(profile());
  assert.equal(result.ok, true);
  assert.equal(result.serialized, false);
  assert.equal(coordinator._slots.size, 0);
});

test("fresh parallel inspection cannot bypass a retained serialized slot for the same target", async () => {
  let calls = 0;
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async () => {
      calls += 1;
      return calls === 1
        ? {
            mode: "serialized",
            kind: "codespaces-stdio",
            key: "codespace:retained",
            fingerprint: "same-local-target",
          }
        : {
            mode: "parallel",
            kind: "standard",
            key: "parallel:changed-config",
            fingerprint: "same-local-target",
          };
    },
  });
  const owner = await coordinator.acquireConnection(profile("p1", "shared-alias"));
  assert.equal(owner.ok, true);

  const sibling = await coordinator.acquireOperation(profile("p2", "shared-alias"), "deploy");
  assert.equal(sibling.ok, false);
  assert.equal(sibling.code, "serialized_transport_busy");
  assert.equal(sibling.ownerProfileId, "p1");
  owner.context.assertActive();
});

test("a busy non-owner cannot overwrite the live owner's retained target fingerprint", async () => {
  let ownerInspections = 0;
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async (p) => {
      if (p.id === "p2") {
        return {
          mode: "serialized",
          kind: "codespaces-stdio",
          key: "codespace:shared",
          fingerprint: "fingerprint:b",
        };
      }
      ownerInspections += 1;
      return ownerInspections === 1
        ? {
            mode: "serialized",
            kind: "codespaces-stdio",
            key: "codespace:shared",
            fingerprint: "fingerprint:a",
          }
        : {
            mode: "parallel",
            kind: "standard",
            key: "parallel:a",
            fingerprint: "fingerprint:a",
          };
    },
  });
  const owner = await coordinator.acquireConnection(profile("p1", "alias-a"));
  assert.equal(owner.ok, true);
  const busy = await coordinator.acquireConnection(profile("p2", "alias-b"));
  assert.equal(busy.ok, false);
  assert.equal(busy.code, "serialized_transport_busy");
  assert.equal(coordinator._slots.get("codespace:shared").inspection.fingerprint, "fingerprint:a");

  const driftedOwner = await coordinator.acquireOperation(profile("p1", "alias-a"), "deploy");
  assert.equal(driftedOwner.ok, false);
  assert.equal(driftedOwner.code, "profile_changed");
  owner.context.assertActive();
});

test("owner operation takeover invalidates the old connection lease", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
    spawn: () => fakeChild(),
  });
  const connection = await coordinator.acquireConnection(profile());
  const oldAttempt = connection.context.attemptToken;
  const operation = await coordinator.acquireOperation(profile(), "deploy");
  assert.equal(operation.ok, true);
  assert.throws(() => connection.context.spawn({
    attemptToken: oldAttempt,
    role: "stale",
    tool: "ssh",
    args: [],
  }), /no longer active/);
});

test("connection preparation cannot be taken over after a remote lock attempt starts", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
  });
  const connection = await coordinator.acquireConnection(profile());
  connection.context.setLockStage("acquire-attempted");

  const deploy = await coordinator.acquireOperation(profile(), "deploy");
  assert.equal(deploy.ok, false);
  assert.equal(deploy.code, "transport_operation_busy");
  const disconnect = await coordinator.acquireOwnedOperation(profile(), "disconnect");
  assert.equal(disconnect.ok, false);
  assert.equal(disconnect.code, "transport_operation_busy");
  connection.context.assertActive();
  assert.equal(coordinator.getActiveOwnerOperation("p1").lockStage, "acquire-attempted");
});

test("a second owner operation is busy instead of invalidating the active mutation", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
  });
  const connection = await coordinator.acquireConnection(profile());
  const first = await coordinator.acquireOperation(profile(), "deploy");
  assert.equal(first.ok, true);
  const second = await coordinator.acquireOperation(profile(), "cleanup");
  assert.equal(second.ok, false);
  assert.equal(second.code, "transport_operation_busy");
  first.context.assertActive();
  assert.throws(() => connection.context.assertActive(), /no longer active/);
});

test("a completed owner operation can transition its lease back to connection ownership", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    spawn: () => fakeChild(),
    inspectEffectiveTransport: serializedInspection,
  });
  const testProfile = profile("resume-transition-profile");
  const connection = await coordinator.acquireConnection(testProfile);
  const operation = await coordinator.acquireOwnedOperation(testProfile, "deploy");
  assert.equal(operation.ok, true);

  operation.context.transitionToConnection();
  const snapshot = coordinator.getActiveOwnerOperation(testProfile.id);
  assert.equal(snapshot.phase, "preparing");
  assert.equal(snapshot.operation, "connect");

  const nextOperation = await coordinator.acquireOwnedOperation(testProfile, "deploy");
  assert.equal(nextOperation.ok, true);
  assert.equal(nextOperation.context.profileId, testProfile.id);
  coordinator.release(nextOperation.context);
});

test("drain waits for close, not exit", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
    spawn: () => fakeChild(),
    drainTimeoutMs: 1000,
  });
  const connection = await coordinator.acquireConnection(profile());
  const child = connection.context.spawn({
    attemptToken: connection.context.attemptToken,
    role: "tunnel",
    tool: "ssh",
    args: [],
  });
  const operation = await coordinator.acquireOperation(profile(), "deploy");
  const drain = coordinator.waitForDrain(operation.context, (owned) => owned.stdin.end());
  let settled = false;
  drain.then(() => { settled = true; });
  child.emit("exit", 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(child.stdin.endCalls, 1);
  child.emit("close", 0, null);
  assert.deepEqual(await drain, { ok: true, drainVerified: true });
});

test("pre-lock drain quarantine recovers only after the tracked child later closes", async () => {
  const timers = [];
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
    spawn: () => fakeChild(),
    setTimeout: (fn) => { timers.push(fn); return fn; },
    clearTimeout: () => {},
  });
  const connection = await coordinator.acquireConnection(profile());
  const child = connection.context.spawn({
    attemptToken: connection.context.attemptToken,
    role: "tunnel",
    tool: "ssh",
    args: [],
  });
  const operation = await coordinator.acquireOperation(profile(), "deploy");
  const drain = coordinator.waitForDrain(operation.context, () => {});
  timers.shift()();
  await assert.rejects(drain, (err) => {
    assert.ok(err instanceof TransportUndrainedError);
    assert.equal(err.drainVerified, false);
    return true;
  });
  const slot = coordinator._slots.get("codespace:fuzzy-space");
  assert.equal(slot.phase, "quarantined");
  assert.equal(slot.trackedChildren.size, 1);
  child.emit("close", 0, null);
  assert.equal(slot.phase, "idle");
  assert.equal(slot.trackedChildren.size, 0);
  assert.throws(() => operation.context.assertActive(), /no longer active/);
  const retry = await coordinator.acquireOperation(profile(), "deploy");
  assert.equal(retry.ok, true);
  coordinator.release(retry.context);
});

test("a signaled outer SSH close never proves a quarantined ProxyCommand transport drained", async () => {
  const timers = [];
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
    spawn: () => fakeChild(),
    setTimeout: (fn) => { timers.push(fn); return fn; },
    clearTimeout: () => {},
  });
  const connection = await coordinator.acquireConnection(profile());
  const child = connection.context.spawn({
    attemptToken: connection.context.attemptToken,
    role: "node-resolve",
    tool: "ssh",
    args: [],
  });
  const operation = await coordinator.acquireOperation(profile(), "deploy");
  const drain = coordinator.waitForDrain(operation.context, () => {});
  timers.shift()();
  await assert.rejects(drain, TransportUndrainedError);

  child.emit("close", null, "SIGTERM");
  const slot = coordinator._slots.get("codespace:fuzzy-space");
  assert.equal(slot.phase, "failed");
  const retry = await coordinator.acquireOperation(profile(), "deploy");
  assert.equal(retry.ok, false);
  assert.equal(retry.code, "transport_drain_unverified");
});

test("a signaled child in a normal phase immediately invalidates release and retry", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
    spawn: () => fakeChild(),
  });
  const connection = await coordinator.acquireConnection(profile());
  const child = connection.context.spawn({
    attemptToken: connection.context.attemptToken,
    role: "node-resolve",
    tool: "ssh",
    args: [],
  });
  child.emit("close", null, "SIGTERM");
  assert.throws(() => coordinator.release(connection.context), /no longer active/);
  assert.throws(() => connection.context.nextAttempt(), /no longer active/);
  const retry = await coordinator.acquireConnection(profile());
  assert.equal(retry.ok, false);
  assert.equal(retry.code, "transport_drain_unverified");
});

test("late close after deploy-lock acquisition remains failed for manual inspection", async () => {
  const timers = [];
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
    spawn: () => fakeChild(),
    setTimeout: (fn) => { timers.push(fn); return fn; },
    clearTimeout: () => {},
  });
  const operation = await coordinator.acquireOperation(profile(), "deploy");
  operation.context.setLockStage("lock-owned");
  const child = operation.context.spawn({
    attemptToken: operation.context.attemptToken,
    role: "remote-cleanup",
    tool: "ssh",
    args: [],
  });
  const drain = coordinator.waitForDrain(operation.context, () => {});
  timers.shift()();
  await assert.rejects(drain, TransportUndrainedError);
  child.emit("close", 0, null);
  const slot = coordinator._slots.get("codespace:fuzzy-space");
  assert.equal(slot.phase, "failed");
  const retry = await coordinator.acquireOperation(profile(), "deploy");
  assert.equal(retry.ok, false);
  assert.equal(retry.code, "transport_drain_timeout");
  assert.equal(retry.recoveryCode, "manual_lock_inspection_required");
});

test("sticky serialized evidence is used only after a fresh inspection failure", async () => {
  let calls = 0;
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async (p) => {
      calls += 1;
      if (calls === 1) return serializedInspection(p);
      return { mode: "unknown", kind: "inspection-failed", key: null, message: "boom" };
    },
  });
  const first = await coordinator.inspect(profile());
  assert.equal(first.mode, "serialized");
  const second = await coordinator.inspect(profile());
  assert.equal(second.mode, "serialized");
  assert.equal(second.stickyFallback, true);
  assert.equal(calls, 2, "sticky safety must not skip reinspection");
});

test("disconnect intent increments independently of operation attempts", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: parallelInspection,
  });
  await coordinator.acquireConnection(profile());
  assert.deepEqual(coordinator.getIntent("p1"), { desiredConnected: true, intentGeneration: 1 });
  coordinator.recordDisconnectIntent("p1");
  assert.deepEqual(coordinator.getIntent("p1"), { desiredConnected: false, intentGeneration: 2 });
});

test("one profile cannot acquire a second transport key while its original slot is live", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async (p) => ({
      mode: "serialized",
      kind: "explicit-serialized",
      key: `target:${p.host}`,
    }),
  });
  const first = await coordinator.acquireConnection(profile("p1", "old-host"));
  assert.equal(first.ok, true);
  const changed = await coordinator.acquireOperation(profile("p1", "new-host"), "deploy");
  assert.equal(changed.ok, false);
  assert.equal(changed.code, "profile_changed");
  assert.equal(coordinator._slots.size, 1);
});

test("interactive SSH is blocked for every non-idle serialized phase", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
  });
  const idle = await coordinator.checkInteractive(profile());
  assert.equal(idle.ok, true);
  await coordinator.acquireConnection(profile());
  const busy = await coordinator.checkInteractive(profile("p2", "alias-two"));
  assert.equal(busy.ok, false);
  assert.equal(busy.code, "serialized_transport_busy");
  assert.equal(busy.ownerProfileId, "p1");
});

test("interactive SSH stays blocked when a live serialized target freshly inspects as parallel", async () => {
  let calls = 0;
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async () => {
      calls += 1;
      return calls === 1
        ? {
            mode: "serialized",
            kind: "codespaces-stdio",
            key: "codespace:interactive-drift",
            fingerprint: "same-interactive-target",
          }
        : {
            mode: "parallel",
            kind: "standard",
            key: "parallel:interactive-drift",
            fingerprint: "same-interactive-target",
          };
    },
  });
  const testProfile = profile("interactive-owner", "drifting-alias");
  await coordinator.acquireConnection(testProfile);
  const availability = await coordinator.checkInteractive(testProfile);
  assert.equal(availability.ok, false);
  assert.equal(availability.code, "profile_changed");
});

test("interactive SSH honors a retained occupancy token for a drifted sibling alias", async () => {
  const modes = new Map([["owner", "serialized"], ["sibling", "serialized"]]);
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async (p) => modes.get(p.id) === "parallel"
      ? {
          mode: "parallel",
          kind: "standard",
          key: `parallel:${p.host}`,
          fingerprint: `parallel-fp:${p.host}`,
        }
      : {
          mode: "serialized",
          kind: "codespaces-stdio",
          key: "codespace:interactive-retained",
          fingerprint: `serialized-fp:${p.host}`,
        },
  });
  const ownerProfile = profile("owner", "owner-alias");
  const siblingProfile = profile("sibling", "sibling-alias");
  await coordinator.refreshProfileInspections([ownerProfile, siblingProfile]);
  await coordinator.acquireConnection(ownerProfile);
  modes.set("sibling", "parallel");
  await coordinator.refreshProfileInspections([ownerProfile, siblingProfile]);

  const availability = await coordinator.checkInteractive(siblingProfile);
  assert.equal(availability.ok, false);
  assert.equal(availability.code, "serialized_transport_busy");
  assert.equal(availability.ownerProfileId, ownerProfile.id);
});

test("verified timeout before lock acquisition releases admission but invalidates the old callback", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
  });
  const acquired = await coordinator.acquireOperation(profile(), "deploy");
  const outcome = coordinator.abortAfterVerifiedClose(acquired.context, "operation_timeout");
  assert.equal(outcome.recoveryCode, null);
  assert.throws(() => acquired.context.assertActive(), /no longer active/);
  const retry = await coordinator.acquireOperation(profile(), "deploy");
  assert.equal(retry.ok, true);
});

test("verified timeout after lock acquisition fails closed for manual inspection", async () => {
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
  });
  const acquired = await coordinator.acquireOperation(profile(), "deploy");
  acquired.context.setLockStage("lock-owned");
  const outcome = coordinator.abortAfterVerifiedClose(acquired.context, "operation_timeout");
  assert.equal(outcome.recoveryCode, "manual_lock_inspection_required");
  const retry = await coordinator.acquireOperation(profile(), "deploy");
  assert.equal(retry.ok, false);
  assert.equal(retry.code, "operation_timeout");
  assert.equal(retry.recoveryCode, "manual_lock_inspection_required");
});

test("app shutdown sends EOF to the exact persistent tunnel and admits no new work", async () => {
  const child = fakeChild();
  child.killCalls = 0;
  child.kill = () => { child.killCalls += 1; };
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: serializedInspection,
    spawn: () => child,
    drainTimeoutMs: 1000,
  });
  const acquired = await coordinator.acquireConnection(profile());
  acquired.context.spawn({
    attemptToken: acquired.context.attemptToken,
    role: "persistent-tunnel-readiness",
    tool: "ssh",
    args: [],
  });
  const draining = coordinator.shutdown(1000);
  assert.equal(child.stdin.endCalls, 1);
  assert.equal(child.killCalls, 0);
  const rejected = await coordinator.acquireOperation(profile(), "deploy");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "transport_shutdown");
  child.emit("close", 0, null);
  assert.deepEqual(await draining, { ok: true, drainVerified: true, remaining: 0 });
});
