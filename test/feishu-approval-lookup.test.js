"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createFeishuApprovalLookupCoordinator,
} = require("../src/feishu-approval-lookup");

function createCoordinator() {
  let nextId = 0;
  return createFeishuApprovalLookupCoordinator({
    createLookupId: () => `lookup-${++nextId}`,
  });
}

const IDENTITY = Object.freeze({ platform: "feishu", appId: "cli_saved" });

test("coordinator retains only bounded lookup metadata and the ready approver", () => {
  const coordinator = createCoordinator();
  const started = coordinator.begin({
    requestId: "renderer-request-1",
    identity: IDENTITY,
    secretsRevision: 3,
    email: "must-not-be-stored@example.invalid",
    appSecret: "must-not-be-stored-secret",
    token: "must-not-be-stored-token",
    snapshot: { mustNot: "be stored" },
  });
  assert.equal(started.status, "ok");
  assert.equal(started.lookupId, "lookup-1");
  assert.equal(typeof started.signal.aborted, "boolean");
  assert.deepEqual(coordinator.succeed({
    lookupId: started.lookupId,
    approverId: "ou_main_side_only",
  }), { status: "ok", lookupId: "lookup-1" });

  const inspected = coordinator.inspect();
  assert.deepEqual(inspected.current.keys.sort(), [
    "abortController",
    "appId",
    "approverId",
    "lookupId",
    "phase",
    "platform",
    "requestId",
    "secretsRevision",
  ]);
  assert.equal(inspected.current.hasApproverId, true);
  const serialized = JSON.stringify(inspected);
  assert.doesNotMatch(
    serialized,
    /must-not-be-stored@example\.invalid|must-not-be-stored-secret|must-not-be-stored-token/i,
  );
});

test("cancel before consume rejects the handle and clears the approver", () => {
  const coordinator = createCoordinator();
  const started = coordinator.begin({ requestId: "request-a", identity: IDENTITY, secretsRevision: 1 });
  coordinator.succeed({ lookupId: started.lookupId, approverId: "ou_ready" });

  assert.deepEqual(coordinator.cancel({ requestId: "request-a" }), {
    status: "ok",
    code: "lookup-cancelled",
  });
  assert.deepEqual(coordinator.consume({
    lookupId: started.lookupId,
    identity: IDENTITY,
    secretsRevision: 1,
  }), { status: "error", code: "lookup-cancelled" });
  assert.equal(coordinator.inspect().current.hasApproverId, false);
});

test("consume before cancel succeeds once and cannot be rolled back", () => {
  const coordinator = createCoordinator();
  const started = coordinator.begin({ requestId: "request-a", identity: IDENTITY, secretsRevision: 1 });
  coordinator.succeed({ lookupId: started.lookupId, approverId: "ou_ready" });

  assert.deepEqual(coordinator.consume({
    lookupId: started.lookupId,
    identity: IDENTITY,
    secretsRevision: 1,
  }), { status: "ok", approverId: "ou_ready" });
  assert.deepEqual(coordinator.cancel({ requestId: "request-a" }), {
    status: "ok",
    code: "lookup-result-consumed",
  });
  assert.deepEqual(coordinator.consume({
    lookupId: started.lookupId,
    identity: IDENTITY,
    secretsRevision: 1,
  }), { status: "error", code: "lookup-result-consumed" });
});

test("credential identity or revision mismatch takes precedence over terminal state", () => {
  for (const terminal of ["cancelled", "consumed"]) {
    const coordinator = createCoordinator();
    const started = coordinator.begin({ requestId: `request-${terminal}`, identity: IDENTITY, secretsRevision: 4 });
    coordinator.succeed({ lookupId: started.lookupId, approverId: "ou_ready" });
    if (terminal === "cancelled") {
      coordinator.cancel({ requestId: `request-${terminal}` });
    } else {
      coordinator.consume({ lookupId: started.lookupId, identity: IDENTITY, secretsRevision: 4 });
    }
    assert.deepEqual(coordinator.consume({
      lookupId: started.lookupId,
      identity: { ...IDENTITY, appId: "cli_changed" },
      secretsRevision: 5,
    }), { status: "error", code: "lookup-credentials-changed" });
  }
});

test("unknown handles are stale and a newer lookup supersedes the previous handle", () => {
  const coordinator = createCoordinator();
  const first = coordinator.begin({ requestId: "request-a", identity: IDENTITY, secretsRevision: 1 });
  coordinator.succeed({ lookupId: first.lookupId, approverId: "ou_first" });
  const second = coordinator.begin({ requestId: "request-b", identity: IDENTITY, secretsRevision: 1 });

  assert.deepEqual(coordinator.consume({
    lookupId: first.lookupId,
    identity: IDENTITY,
    secretsRevision: 1,
  }), { status: "error", code: "lookup-superseded" });
  assert.deepEqual(coordinator.consume({
    lookupId: "missing",
    identity: IDENTITY,
    secretsRevision: 1,
  }), { status: "error", code: "lookup-stale" });
  assert.equal(second.lookupId, "lookup-2");
});
