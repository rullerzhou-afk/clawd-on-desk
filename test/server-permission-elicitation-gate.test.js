"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const { shouldBypassElicitationBubble, handlePermissionPost } = require("../src/server-route-permission");

describe("shouldBypassElicitationBubble", () => {
  it("does not bypass when the pref is on", () => {
    const ctx = { elicitationBubblesEnabled: true };
    assert.strictEqual(shouldBypassElicitationBubble(ctx, "AskUserQuestion"), false);
  });

  it("bypasses AskUserQuestion when the pref is off", () => {
    const ctx = { elicitationBubblesEnabled: false };
    assert.strictEqual(shouldBypassElicitationBubble(ctx, "AskUserQuestion"), true);
  });

  it("only gates AskUserQuestion — other tools are untouched", () => {
    const ctx = { elicitationBubblesEnabled: false };
    assert.strictEqual(shouldBypassElicitationBubble(ctx, "Bash"), false);
    assert.strictEqual(shouldBypassElicitationBubble(ctx, "ExitPlanMode"), false);
  });

  it("missing pref → fail-open (keep showing the bubble)", () => {
    assert.strictEqual(shouldBypassElicitationBubble({}, "AskUserQuestion"), false);
  });
});


function callPermissionPost(body, overrides) {
  const req = new EventEmitter();
  req.headers = {};
  const res = new EventEmitter();
  res.destroyed = false;
  res.destroy = () => { res.destroyed = true; res.emit("close"); };
  const calls = { showPermissionBubble: [], sendPermissionResponse: [], maybeStartRemoteApproval: [] };
  const ctx = {
    elicitationBubblesEnabled: false,
    pendingPermissions: [], sessions: new Map(), PASSTHROUGH_TOOLS: new Set(),
    permLog() {}, updateSession() {},
    isAgentEnabled: () => true, isAgentPermissionsEnabled: () => true,
    isAgentSubagentPermissionsEnabled: () => true,
    showPermissionBubble: (entry) => calls.showPermissionBubble.push(entry),
    sendPermissionResponse: (...args) => calls.sendPermissionResponse.push(args),
    maybeStartRemoteApproval: (entry) => calls.maybeStartRemoteApproval.push(entry),
    ...overrides.ctx,
    calls,
  };
  res.ctx = ctx;
  handlePermissionPost(req, res, { ctx, createRequestHookRecorder: () => ({ accepted() {} }) });
  req.emit("data", Buffer.from(body));
  req.emit("end");
  return res;
}

describe("elicitation opt-out permission route", () => {
  it("keeps AskUserQuestion in the terminal when question bubbles are disabled", async () => {
    const res = await callPermissionPost(JSON.stringify({
      agent_id: "claude-code",
      session_id: "elicitation-opt-out",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Continue?" }] },
    }), { ctx: { elicitationBubblesEnabled: false } });

    assert.strictEqual(res.destroyed, true);
    assert.deepStrictEqual(res.ctx.pendingPermissions, []);
    assert.deepStrictEqual(res.ctx.calls.showPermissionBubble, []);
    assert.deepStrictEqual(res.ctx.calls.sendPermissionResponse, []);
    assert.deepStrictEqual(res.ctx.calls.maybeStartRemoteApproval, []);
  });

  it("keeps plan review bubbles enabled when question bubbles are disabled", async () => {
    const res = await callPermissionPost(JSON.stringify({
      agent_id: "claude-code",
      session_id: "plan-with-question-opt-out",
      tool_name: "ExitPlanMode",
      tool_input: {},
    }), { ctx: { elicitationBubblesEnabled: false } });

    assert.strictEqual(res.destroyed, false);
    assert.strictEqual(res.ctx.calls.showPermissionBubble.length, 1);
  });

});
