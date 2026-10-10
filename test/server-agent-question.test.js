"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");
const originalLoad = Module._load;
Module._load = function (name) {
  if (name === "electron") return { BrowserWindow: { fromWebContents: sender => sender.__window },
    globalShortcut: { register: () => true, unregister() {}, isRegistered: () => false } };
  return originalLoad.apply(this, arguments);
};
const { createPermissionIngressHarness, postPermission, waitUntil } = require("./helpers/permission-ingress-harness");
const { resolveSessionIdentity } = require("../src/session-key");
Module._load = originalLoad;

function payload(agent = "opencode", id = "que_test") {
  return { agent_id: agent, hook_source: `${agent}-plugin`, question_protocol: "clawd.question.v1",
    host_version: agent === "mimocode" ? "0.1.15" : "1.18.31", question_instance_id: "a".repeat(32),
    request: { id, sessionID: "ses_test", tool: { messageID: "msg_test", callID: "call_test" },
      questions: [{ header: "Pick", question: "Which?", options: [{ label: "A, B", description: "Exact label" }], custom: false }] } };
}

test("real question HTTP response contains exact answers and no approval decision", async t => {
  const h = await createPermissionIngressHarness(); t.after(() => h.close());
  const pending = postPermission(h.port, payload(), {}, "/question");
  await waitUntil(() => h.shown.length === 1, "question should show");
  const entry = h.shown[0]; entry.bubble = { isDestroyed: () => false };
  assert.equal(entry.interaction.capabilities.answerQuestions, true);
  assert.equal(entry.interaction.capabilities.allowDeny, false);
  assert.equal(entry.interaction.automationEligibility.unattended, false);
  h.permission.handleDecide({ sender: { __window: entry.bubble } }, { type: "elicitation-submit", answers: { 0: ["A, B"] } });
  // A repeated IPC cannot send a second response once pending ownership is removed.
  h.permission.handleDecide({ sender: { __window: entry.bubble } }, "allow");
  const response = await pending.response;
  assert.equal(response.status, 200);
  const selected = JSON.parse(response.body);
  assert.deepEqual(selected.answers, [["A, B"]]);
  assert.match(selected.confirmation_token, /^[a-f0-9]{64}$/);
  assert.equal(h.permission.pendingPermissions.length, 1, "selected answers are not native delivery confirmation");
  assert.equal(entry.questionAwaitingDelivery, true);
  await postPermission(h.port, { ...payload(), question_result: "accepted", confirmation_token: selected.confirmation_token }, {}, "/question").response;
  assert.equal(h.permission.pendingPermissions.length, 0);
});

test("notification bubbles off alone do not suppress either family's question cards", async t => {
  const h = await createPermissionIngressHarness({ ctxOverrides: {
    getBubblePolicy: kind => ({ enabled: kind !== "notification", autoCloseMs: 0 }),
  } });
  t.after(() => h.close());
  for (const agent of ["opencode", "mimocode"]) {
    const pending = postPermission(h.port, payload(agent), {}, "/question");
    await waitUntil(() => h.permission.pendingPermissions.length === 1, "permission-enabled question should show");
    const entry = h.permission.pendingPermissions[0];
    assert.equal(entry.agentId, agent);
    h.permission.resolvePermissionEntry(entry, "no-decision");
    assert.equal((await pending.response).status, 204);
  }
  assert.equal(h.shown.length, 2);
});

test("global permission bubble switch off keeps both families native", async t => {
  const h = await createPermissionIngressHarness({ ctxOverrides: {
    getBubblePolicy: kind => ({ enabled: kind !== "permission", autoCloseMs: 0 }),
  } });
  t.after(() => h.close());
  for (const agent of ["opencode", "mimocode"]) {
    const response = await postPermission(h.port, payload(agent), {}, "/question").response;
    assert.equal(response.status, 204); assert.equal(response.body, "");
  }
  assert.equal(h.shown.length, 0); assert.equal(h.permission.pendingPermissions.length, 0);
});

test("family permission sub-gates remain per-agent for question cards", async t => {
  for (const disabledAgent of ["opencode", "mimocode"]) {
    const h = await createPermissionIngressHarness({ ctxOverrides: {
      isAgentPermissionsEnabled: agent => agent !== disabledAgent,
    } });
    try {
      const disabled = await postPermission(h.port, payload(disabledAgent), {}, "/question").response;
      assert.equal(disabled.status, 204); assert.equal(h.shown.length, 0);
      const enabledAgent = disabledAgent === "opencode" ? "mimocode" : "opencode";
      const pending = postPermission(h.port, payload(enabledAgent), {}, "/question");
      await waitUntil(() => h.permission.pendingPermissions.length === 1, "other family's switch remains enabled");
      assert.equal(h.shown[0].agentId, enabledAgent);
      h.permission.resolvePermissionEntry(h.shown[0], "no-decision"); await pending.response;
    } finally { await h.close(); }
  }
});

test("DND and disabled-agent guards still keep questions native", async t => {
  for (const ctxOverrides of [{ doNotDisturb: true }, { isAgentEnabled: () => false }]) {
    const h = await createPermissionIngressHarness({ ctxOverrides });
    try {
      for (const agent of ["opencode", "mimocode"]) {
        assert.equal((await postPermission(h.port, payload(agent), {}, "/question").response).status, 204);
      }
      assert.equal(h.shown.length, 0);
    } finally { await h.close(); }
  }
});

test("invalid or approval-shaped actions only return no decision", async t => {
  const h = await createPermissionIngressHarness(); t.after(() => h.close());
  for (const [index, action] of ["allow", "deny", "family-always", { type: "elicitation-submit", answers: {} },
    { type: "elicitation-submit", answers: { 0: ["wrong"] } }].entries()) {
    const pending = postPermission(h.port, payload("opencode", `que_${index}`), {}, "/question");
    await waitUntil(() => h.permission.pendingPermissions.length === 1, "question should show");
    const entry = h.permission.pendingPermissions[0]; entry.bubble = { isDestroyed: () => false };
    h.permission.handleDecide({ sender: { __window: entry.bubble } }, action);
    const response = await pending.response;
    assert.equal(response.status, 204); assert.equal(response.body, "");
  }
});

test("browser, foreign Host and non-JSON requests retain ingress protection", async t => {
  const h = await createPermissionIngressHarness(); t.after(() => h.close());
  for (const headers of [{ Origin: "https://foreign.example" }, { Host: "foreign.example" }, { "Content-Type": "text/plain" }]) {
    const response = await postPermission(h.port, payload(), headers, "/question").response;
    assert.ok([403, 404, 415].includes(response.status));
  }
  assert.equal(h.shown.length, 0);
});

test("unreviewed agent, source, version, protocol, remote shape and body size stay native", async t => {
  const h = await createPermissionIngressHarness(); t.after(() => h.close());
  const candidates = [payload("codex"), payload("qwen-code"), payload("custom-untrusted"),
    { ...payload(), hook_source: "opencode-plugin-v2" }, { ...payload(), host_version: "2.0.15" },
    { ...payload(), question_protocol: "unknown" }, { ...payload(), headless: true }, { ...payload(), host: "remote" },
    { ...payload(), question_instance_id: "invalid" }, { ...payload(), padding: "x".repeat(70 * 1024) }];
  for (const candidate of candidates) assert.equal((await postPermission(h.port, candidate, {}, "/question").response).status, 204);
  assert.equal(h.shown.length, 0);
});

test("native failure and forged receipts never create a confirmed or retryable answer", async t => {
  const h = await createPermissionIngressHarness(); t.after(() => h.close());
  const packet = payload(); const pending = postPermission(h.port, packet, {}, "/question");
  await waitUntil(() => h.shown.length === 1, "question should show");
  const entry = h.shown[0]; entry.bubble = { isDestroyed: () => false };
  h.permission.handleDecide({ sender: { __window: entry.bubble } }, { type: "elicitation-submit", answers: { 0: ["A, B"] } });
  const selected = JSON.parse((await pending.response).body);
  for (const forged of [
    { ...packet, confirmation_token: "0".repeat(64) },
    { ...packet, confirmation_token: selected.confirmation_token, question_instance_id: "b".repeat(32) },
    { ...packet, confirmation_token: selected.confirmation_token, host_version: "1.18.32" },
    { ...packet, confirmation_token: selected.confirmation_token, request: { ...packet.request, tool: { messageID: "msg_other", callID: "call_test" } } },
  ]) {
    await postPermission(h.port, { ...forged, question_result: "accepted" }, {}, "/question").response;
    assert.equal(entry.questionAwaitingDelivery, true);
  }
  await postPermission(h.port, { ...packet, confirmation_token: selected.confirmation_token, question_result: "unknown" }, {}, "/question").response;
  assert.equal(entry.questionDeliveryUnconfirmed, true);
  assert.equal(entry.interaction.capabilities.answerQuestions, false);
  assert.equal(entry.interaction.capabilities.allowDeny, false);
  assert.equal(h.permission.buildPermissionBubblePayload(entry).questionDeliveryUnconfirmed, true);
  h.permission.handleDecide({ sender: { __window: entry.bubble } }, { type: "elicitation-submit", answers: { 0: ["A, B"] } });
  assert.equal(h.permission.pendingPermissions.length, 0, "failed delivery cannot be resubmitted from the old card");
});

test("missing receipt becomes explicit native fallback after its deadline", async t => {
  const h = await createPermissionIngressHarness(); t.after(() => h.close());
  const pending = postPermission(h.port, payload(), {}, "/question");
  await waitUntil(() => h.shown.length === 1, "question should show");
  const entry = h.shown[0]; entry.bubble = { isDestroyed: () => false };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  h.permission.handleDecide({ sender: { __window: entry.bubble } }, { type: "elicitation-submit", answers: { 0: ["A, B"] } });
  await pending.response;
  assert.equal(entry.questionAwaitingDelivery, true);
  t.mock.timers.tick(12000);
  assert.equal(entry.questionDeliveryUnconfirmed, true);
  assert.equal(entry.questionAwaitingDelivery, false);
  assert.equal(entry.interaction.capabilities.answerQuestions, false);
});

test("canonical local identity reuses the existing session for focus and SessionEnd cleanup", async t => {
  const focus = [];
  const h = await createPermissionIngressHarness({ ctxOverrides: {
    focusTerminalForSession: sid => focus.push(sid), STATE_SVGS: { working: "working.svg", sleeping: "sleeping.svg" },
  } });
  t.after(() => h.close());
  const identity = resolveSessionIdentity("opencode:ses_test", "local");
  h.ctx.sessions.set(identity.sessionId, { ...identity, agentId: "opencode" });
  const first = postPermission(h.port, payload(), {}, "/question");
  await waitUntil(() => h.shown.length === 1, "question should show");
  const entry = h.shown[0]; entry.bubble = { isDestroyed: () => false };
  assert.equal(entry.sessionId, identity.sessionId);
  assert.equal(entry.rawSessionId, "opencode:ses_test");
  assert.equal(entry.profileId, "local");
  assert.equal(h.ctx.sessions.size, 1, "a question must not create another session row");
  h.permission.handleDecide({ sender: { __window: entry.bubble } }, "deny-and-focus");
  assert.equal((await first.response).status, 204);
  assert.deepEqual(focus, [identity.sessionId]);
  const second = postPermission(h.port, payload("opencode", "que_end"), {}, "/question");
  await waitUntil(() => h.permission.pendingPermissions.length === 1, "next question should show");
  await postPermission(h.port, { agent_id: "opencode", hook_source: "opencode-plugin",
    session_id: "opencode:ses_test", event: "SessionEnd", state: "sleeping" }, {}, "/state").response;
  assert.equal((await second.response).status, 204);
  assert.equal(h.permission.pendingPermissions.length, 0);
});

test("agent disable cleanup returns no decision on its canonical question only", async t => {
  const h = await createPermissionIngressHarness(); t.after(() => h.close());
  const first = postPermission(h.port, payload("opencode", "que_one"), {}, "/question");
  const second = postPermission(h.port, payload("mimocode", "que_two"), {}, "/question");
  await waitUntil(() => h.permission.pendingPermissions.length === 2, "both should show");
  assert.equal(h.permission.dismissPermissionsByAgent("opencode"), 1);
  assert.equal((await first.response).status, 204);
  assert.equal(h.permission.pendingPermissions.length, 1);
  assert.equal(h.permission.pendingPermissions[0].agentId, "mimocode");
  h.permission.resolvePermissionEntry(h.permission.pendingPermissions[0], "no-decision"); await second.response;
});

test("a disconnected question owner cleans only its own pending entry", async t => {
  const h = await createPermissionIngressHarness(); t.after(() => h.close());
  const first = postPermission(h.port, payload("opencode", "que_one"), {}, "/question");
  const second = postPermission(h.port, payload("mimocode", "que_two"), {}, "/question");
  await waitUntil(() => h.permission.pendingPermissions.length === 2, "both questions should show");
  first.request.destroy(); await first.response;
  await waitUntil(() => h.permission.pendingPermissions.length === 1, "owner should clean its question");
  assert.equal(h.permission.pendingPermissions[0].familyRequestId, "que_two");
  h.permission.resolvePermissionEntry(h.permission.pendingPermissions[0], "no-decision"); await second.response;
});
