"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const { describe, it } = require("node:test");
const { sanitizeCodexPermissionOutput } = require("../hooks/codex-hook");

// Exercise real HTTP routes and permission ownership without launching a GUI.
// Only the Electron window/shortcut boundary is replaced, as in the family
// lifecycle tests. No installed integration or user settings are changed.
const originalLoad = Module._load;
let createPermissionIngressHarness, postPermission, waitUntil;
try {
  Module._load = function (request) {
    if (request === "electron") return {
      BrowserWindow: { fromWebContents: () => null },
      globalShortcut: { register: () => true, unregister() {}, isRegistered: () => false },
    };
    return originalLoad.apply(this, arguments);
  };
  ({ createPermissionIngressHarness, postPermission, waitUntil } = require("./helpers/permission-ingress-harness"));
} finally {
  Module._load = originalLoad;
}

function requestBody(overrides = {}) {
  return {
    agent_id: "codex", hook_source: "codex-official",
    session_id: "codex:cleanup", tool_name: "Bash",
    tool_use_id: "call-pending", tool_input: { command: "echo cleanup" },
    ...overrides,
  };
}

function stateBody(event, overrides = {}) {
  return {
    agent_id: "codex", session_id: "codex:cleanup", state: "working", event,
    ...(event === "Stop" ? {} : { tool_name: "Bash", tool_use_id: "call-pending" }),
    ...overrides,
  };
}

describe("Codex lifecycle cleanup over HTTP", () => {
  for (const event of ["PostToolUse", "PostToolUseFailure", "Stop"]) {
    it(`${event} releases the hook without a decision and cancels the mirrored approval`, async (t) => {
      const harness = await createPermissionIngressHarness();
      t.after(() => harness.close());
      const hook = postPermission(harness.port, requestBody());
      await waitUntil(() => harness.shown.length === 1, "permission was not registered");
      const entry = harness.shown[0];
      const controller = new AbortController();
      const outcomes = [];
      entry.remoteApprovalAbortControllers = [controller];
      entry.remoteApprovalRequests = [{ name: "test-remote", signal: controller.signal,
        client: { resolveApprovalExternally(signal, outcome) { outcomes.push(outcome); return true; } } }];
      let hidden = false;
      entry.bubble = {
        isDestroyed: () => false, isVisible: () => true, destroy() {},
        webContents: { isDestroyed: () => false, send(eventName) { if (eventName === "permission-hide") hidden = true; } },
      };

      const state = await postPermission(harness.port, stateBody(event), {}, "/state").response;
      assert.equal(state.status, 200);
      const response = await hook.response;
      assert.equal(response.status, 204);
      assert.equal(response.body, "");
      assert.equal(sanitizeCodexPermissionOutput(response.body), "{}");
      assert.equal(harness.permission.pendingPermissions.length, 0);
      assert.equal(hidden, true);
      assert.equal(controller.signal.aborted, true);
      assert.deepEqual(outcomes.map((outcome) => outcome.decision), ["no-decision"]);

      // A duplicate event or late UI decision must not revive the request.
      await postPermission(harness.port, stateBody(event), {}, "/state").response;
      harness.permission.resolvePermissionEntry(entry, "allow");
      assert.equal(outcomes.length, 1);
    });
  }

  for (const [name, event, overrides] of [
    ["unrelated tool", "PostToolUse", { tool_use_id: "call-other" }],
    ["another session", "PostToolUse", { session_id: "codex:other" }],
    ["another agent", "PostToolUse", { agent_id: "qwen-code" }],
    ["missing session", "Stop", { session_id: undefined }],
    ["PreToolUse is not completion", "PreToolUse", {}],
  ]) {
    it(`leaves the approval pending for ${name}`, async (t) => {
      const harness = await createPermissionIngressHarness();
      t.after(() => harness.close());
      const hook = postPermission(harness.port, requestBody());
      await waitUntil(() => harness.shown.length === 1, "permission was not registered");
      const response = await postPermission(harness.port, stateBody(event, overrides), {}, "/state").response;
      assert.equal(response.status, 200);
      assert.equal(harness.permission.pendingPermissions.length, 1);
      assert.equal(hook.settled, false);
    });
  }

  it("leaves concurrent requests pending on Stop and clears only an exact completion", async (t) => {
    const harness = await createPermissionIngressHarness();
    t.after(() => harness.close());
    const first = postPermission(harness.port, requestBody());
    const second = postPermission(harness.port, requestBody({ tool_use_id: "call-second" }));
    await waitUntil(() => harness.shown.length === 2, "concurrent permissions were not registered");
    await postPermission(harness.port, stateBody("Stop"), {}, "/state").response;
    assert.equal(harness.permission.pendingPermissions.length, 2);
    assert.equal(first.settled, false);
    assert.equal(second.settled, false);
    await postPermission(harness.port, stateBody("PostToolUse"), {}, "/state").response;
    assert.equal((await first.response).status, 204);
    assert.equal(second.settled, false);
    assert.equal(harness.permission.pendingPermissions[0].toolUseId, "call-second");
  });
});
