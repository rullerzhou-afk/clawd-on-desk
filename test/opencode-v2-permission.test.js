"use strict";

// opencode v2 blocking permission round-trips (issue #1039).
//
// The v2 plugin's evaluate hook blocks on the /permission HTTP response — the
// decision IS the response body. These tests execute the real chain over the
// ingress harness (real server-route-permission handler + real
// initPermission): POST a v2-shaped request → bubble shown → handleDecide →
// 200 JSON { decision } on the held connection; every "Clawd stays out" gate
// (DND, agent disabled, sub-gate, bubbles off) answers 204 no-decision; a
// client disconnect cleans the pending entry; and the legacy v1 hook_source
// keeps the fire-and-forget 200-ACK contract.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createPermissionIngressHarness,
  postPermission,
  waitUntil,
} = require("./helpers/permission-ingress-harness");

const CLAWD_SERVER_HEADER = "x-clawd-server";
const CLAWD_SERVER_ID = "clawd-on-desk";

function makeV2Payload(overrides = {}) {
  return {
    agent_id: "opencode",
    hook_source: "opencode-plugin-v2",
    tool_name: "shell",
    tool_input: { resource: "echo askme-123" },
    patterns: [],
    always: ["shell"],
    session_id: "opencode:ses_v2rt",
    request_id: "v2:call_v2rt",
    cwd: "/tmp",
    agent_pid: process.pid,
    ...overrides,
  };
}

async function setup(t) {
  const harness = await createPermissionIngressHarness();
  t.after(() => harness.close());
  return harness;
}

test("v2 allow: decision arrives as 200 JSON on the held connection", async (t) => {
  const h = await setup(t);
  const posted = postPermission(h.port, makeV2Payload());
  await waitUntil(() => h.shown.length === 1);

  assert.strictEqual(h.permission.pendingPermissions.length, 1, "pending entry held while awaiting");
  assert.strictEqual(posted.settled, false, "connection must stay open");

  const entry = h.shown[0];
  assert.strictEqual(entry.agentId, "opencode");
  assert.strictEqual(entry.isOpencodeV2, true);
  assert.deepStrictEqual(entry.familyAlwaysCandidates, ["shell"]);

  h.permission.resolvePermissionEntry(entry, "allow");
  const result = await posted.response;
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
  assert.deepStrictEqual(JSON.parse(result.body), { decision: "allow" });
});

test("v2 always: familyAlwaysPicked upgrades the decision", async (t) => {
  const h = await setup(t);
  const posted = postPermission(h.port, makeV2Payload());
  await waitUntil(() => h.shown.length === 1);

  const entry = h.shown[0];
  entry.familyAlwaysPicked = true;
  h.permission.resolvePermissionEntry(entry, "allow");
  const result = await posted.response;
  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(JSON.parse(result.body), { decision: "always" });
});

test("v2 deny: decision carries the message", async (t) => {
  const h = await setup(t);
  const posted = postPermission(h.port, makeV2Payload());
  await waitUntil(() => h.shown.length === 1);

  const entry = h.shown[0];
  h.permission.resolvePermissionEntry(entry, "deny", "denied by Clawd test");
  const result = await posted.response;
  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(JSON.parse(result.body), {
    decision: "deny",
    message: "denied by Clawd test",
  });
});

test("v2 no-decision: handleDecide no-decision answers 204", async (t) => {
  const h = await setup(t);
  const posted = postPermission(h.port, makeV2Payload());
  await waitUntil(() => h.shown.length === 1);

  const entry = h.shown[0];
  h.permission.resolvePermissionEntry(entry, "no-decision", "autoclose");
  const result = await posted.response;
  assert.strictEqual(result.status, 204);
  assert.strictEqual(result.body, "");
});

test("v2 DND answers 204 without showing a bubble", async (t) => {
  const h = await createPermissionIngressHarness({ ctxOverrides: { doNotDisturb: true } });
  t.after(() => h.close());

  const posted = postPermission(h.port, makeV2Payload());
  const result = await posted.response;
  assert.strictEqual(result.status, 204);
  assert.strictEqual(result.body, "");
  assert.strictEqual(h.shown.length, 0);
});

test("v2 agent disabled answers 204", async (t) => {
  const h = await createPermissionIngressHarness({ ctxOverrides: { isAgentEnabled: () => false } });
  t.after(() => h.close());

  const posted = postPermission(h.port, makeV2Payload());
  const result = await posted.response;
  assert.strictEqual(result.status, 204);
  assert.strictEqual(h.shown.length, 0);
});

test("v2 per-agent permission sub-gate answers 204", async (t) => {
  const h = await createPermissionIngressHarness({ ctxOverrides: { isAgentPermissionsEnabled: () => false } });
  t.after(() => h.close());

  const posted = postPermission(h.port, makeV2Payload());
  const result = await posted.response;
  assert.strictEqual(result.status, 204);
  assert.strictEqual(h.shown.length, 0);
});

test("v2 bubbles disabled without remote channel answers 204", async (t) => {
  const h = await createPermissionIngressHarness({ ctxOverrides: { getBubblePolicy: () => ({ enabled: false, autoCloseMs: 0 }) } });
  t.after(() => h.close());

  const posted = postPermission(h.port, makeV2Payload());
  const result = await posted.response;
  assert.strictEqual(result.status, 204);
  assert.strictEqual(h.shown.length, 0);
});

test("v2 client disconnect cleans the pending entry", async (t) => {
  const h = await setup(t);
  const posted = postPermission(h.port, makeV2Payload());
  await waitUntil(() => h.shown.length === 1);
  assert.strictEqual(h.permission.pendingPermissions.length, 1);

  posted.request.destroy();
  await waitUntil(() => h.permission.pendingPermissions.length === 0);
  assert.strictEqual(h.shown.length, 1, "bubble cleanup runs via resolve path");
});

test("legacy v1 hook_source keeps the fire-and-forget 200-ACK contract", async (t) => {
  const h = await setup(t);
  const posted = postPermission(h.port, {
    agent_id: "opencode",
    hook_source: "opencode-plugin",
    tool_name: "bash",
    tool_input: { command: "echo x" },
    patterns: [],
    always: [],
    session_id: "opencode:ses_v1",
    request_id: "per_v1_1",
    bridge_url: "http://127.0.0.1:45678",
    bridge_token: "tok",
  });
  const result = await posted.response;
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body, "ok");
  // v1 contract: immediate ACK + bubble; the decision later goes through the
  // (here dead) reverse bridge and fails harmlessly — never a held connection.
  assert.strictEqual(h.shown.length, 1);
  assert.strictEqual(h.shown[0].isOpencodeV2, undefined);
});
