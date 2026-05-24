"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
} = require("../hooks/server-config");
const {
  MAX_PERMISSION_BODY_BYTES,
  handlePermissionPost,
  shouldBypassCCBubble,
  shouldBypassCodexBubble,
  shouldBypassOpencodeBubble,
} = require("../src/server-route-permission");

function makeReq(body) {
  const req = new EventEmitter();
  setImmediate(() => {
    if (body != null) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function makeRes() {
  const res = new EventEmitter();
  res.statusCode = null;
  res.headers = {};
  res.body = "";
  res.headersSent = false;
  res.writableFinished = false;
  res.destroyed = false;
  res.writeHead = function writeHead(code, headers) {
    this.statusCode = code;
    this.headersSent = true;
    if (headers) this.headers = headers;
  };
  res.end = function end(data) {
    if (data) this.body += String(data);
    this.writableFinished = true;
  };
  res.destroy = function destroy() {
    this.destroyed = true;
    this.emit("close");
  };
  return res;
}

function makeCtx(overrides = {}) {
  const calls = {
    logs: [],
    updateSession: [],
    showPermissionBubble: [],
    sendPermissionResponse: [],
    replyOpencodePermission: [],
    resolved: [],
    maybeStartRemoteApproval: [],
    addPendingPermission: [],
    removePendingPermission: [],
  };
  const ctx = {
    doNotDisturb: false,
    hideBubbles: false,
    pendingPermissions: [],
    sessions: new Map(),
    PASSTHROUGH_TOOLS: new Set(),
    permLog: (message) => calls.logs.push(message),
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    updateSession: (...args) => calls.updateSession.push(args),
    showPermissionBubble: (entry) => calls.showPermissionBubble.push(entry),
    sendPermissionResponse: (res, behavior, message) => {
      calls.sendPermissionResponse.push({ behavior, message });
      res.writeHead(200);
      res.end(behavior);
    },
    replyOpencodePermission: (payload) => calls.replyOpencodePermission.push(payload),
    resolvePermissionEntry: (entry, behavior, message) => calls.resolved.push({ entry, behavior, message }),
    maybeStartRemoteApproval: (entry) => calls.maybeStartRemoteApproval.push(entry),
    addPendingPermission(entry) {
      calls.addPendingPermission.push(entry);
      this.pendingPermissions.push(entry);
      return entry;
    },
    removePendingPermission(entry, reason) {
      calls.removePendingPermission.push({ entry, reason });
      const idx = this.pendingPermissions.indexOf(entry);
      if (idx === -1) return false;
      this.pendingPermissions.splice(idx, 1);
      return true;
    },
    ...overrides,
  };
  ctx.calls = calls;
  return ctx;
}

function callPermissionPost(body, overrides = {}) {
  return new Promise((resolve) => {
    const res = makeRes();
    const ctx = makeCtx(overrides.ctx);
    const recorder = [];
    handlePermissionPost(makeReq(body), res, {
      ctx,
      createRequestHookRecorder: (data, route) => {
        recorder.push({ data, route });
        return {
          accepted: () => recorder.push({ outcome: "accepted" }),
          droppedByDisabled: () => recorder.push({ outcome: "disabled" }),
          droppedByDnd: () => recorder.push({ outcome: "dnd" }),
        };
      },
      ...overrides.options,
    });
    setImmediate(() => {
      setImmediate(() => {
        res.ctx = ctx;
        res.recorder = recorder;
        resolve(res);
      });
    });
  });
}

describe("server-route-permission helpers", () => {
  it("preserves bubble bypass decisions for CC, Codex, and opencode", () => {
    assert.strictEqual(shouldBypassCCBubble({ hideBubbles: true }, "Bash", "claude-code"), true);
    assert.strictEqual(shouldBypassCCBubble({ hideBubbles: true }, "ExitPlanMode", "claude-code"), false);
    assert.strictEqual(shouldBypassCCBubble({ hideBubbles: true }, "AskUserQuestion", "claude-code"), false);
    assert.strictEqual(shouldBypassCodexBubble({ hideBubbles: true }), true);
    assert.strictEqual(shouldBypassCodexBubble({
      isAgentPermissionsEnabled: (agentId) => agentId !== "codex",
    }), true);
    assert.strictEqual(shouldBypassOpencodeBubble({
      isAgentPermissionsEnabled: (agentId) => agentId !== "opencode",
    }), true);
  });

});

describe("server-route-permission POST", () => {
  it("returns 400 for invalid JSON", async () => {
    const res = await callPermissionPost("{not json");

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body, "bad json");
    assert.strictEqual(res.recorder.length, 0);
  });

  it("uses the existing deny response for oversized permission bodies", async () => {
    const res = await callPermissionPost("x".repeat(MAX_PERMISSION_BODY_BYTES + 1));

    assert.deepStrictEqual(res.ctx.calls.sendPermissionResponse, [{
      behavior: "deny",
      message: "Permission request too large for Clawd bubble; answer in terminal",
    }]);
  });

  it("returns no-decision for Codex DND fallback", async () => {
    const res = await callPermissionPost(JSON.stringify({
      agent_id: "codex",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    }), {
      ctx: { doNotDisturb: true },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    assert.deepStrictEqual(res.recorder.map((entry) => entry.outcome).filter(Boolean), ["dnd"]);
    assert.deepStrictEqual(res.ctx.pendingPermissions, []);
  });

  it("passes Codex Desktop focus metadata through permission bubbles", async () => {
    const sessionId = "codex:019e115a-4df2-7ed0-b90e-8e6345aca777";
    const res = await callPermissionPost(JSON.stringify({
      agent_id: "codex",
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      source_pid: 456,
      agent_pid: 456,
      pid_chain: [789, 456, -1],
      cwd: "/repo",
      platform: "webui",
      model: "gpt-5.4",
      codex_originator: "Codex Desktop",
      codex_source: "vscode",
    }));

    assert.strictEqual(res.statusCode, null);
    assert.strictEqual(res.ctx.pendingPermissions.length, 1);
    const entry = res.ctx.pendingPermissions[0];
    assert.strictEqual(entry.sessionId, sessionId);
    assert.strictEqual(entry.agentId, "codex");
    assert.strictEqual(entry.isCodex, true);
    assert.strictEqual(entry.sourcePid, 456);
    assert.strictEqual(entry.agentPid, 456);
    assert.deepStrictEqual(entry.pidChain, [789, 456]);
    assert.strictEqual(entry.cwd, "/repo");
    assert.strictEqual(entry.platform, "webui");
    assert.strictEqual(entry.model, "gpt-5.4");
    assert.strictEqual(entry.codexOriginator, "Codex Desktop");
    assert.strictEqual(entry.codexSource, "vscode");
    assert.deepStrictEqual(res.ctx.calls.updateSession, [[
      sessionId,
      "notification",
      "PermissionRequest",
      {
        agentId: "codex",
        hookSource: "codex-official",
        sourcePid: 456,
        agentPid: 456,
        pidChain: [789, 456],
        cwd: "/repo",
        platform: "webui",
        model: "gpt-5.4",
        codexOriginator: "Codex Desktop",
        codexSource: "vscode",
      },
    ]]);
    assert.deepStrictEqual(res.ctx.calls.showPermissionBubble, [entry]);
    assert.deepStrictEqual(res.ctx.calls.maybeStartRemoteApproval, [entry]);
    assert.deepStrictEqual(res.ctx.calls.addPendingPermission, [entry]);
  });

  it("silently drops disabled opencode permissions after ACK", async () => {
    const res = await callPermissionPost(JSON.stringify({
      agent_id: "opencode",
      tool_name: "Bash",
      request_id: "req-1",
      bridge_url: "http://127.0.0.1:1234",
      bridge_token: "token",
    }), {
      ctx: {
        isAgentEnabled: (agentId) => agentId !== "opencode",
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body, "ok");
    assert.deepStrictEqual(res.recorder.map((entry) => entry.outcome).filter(Boolean), ["disabled"]);
    assert.deepStrictEqual(res.ctx.pendingPermissions, []);
    assert.deepStrictEqual(res.ctx.calls.replyOpencodePermission, []);
  });

  it("destroys the Claude/CodeBuddy connection during DND", async () => {
    const res = await callPermissionPost(JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    }), {
      ctx: { doNotDisturb: true },
    });

    assert.strictEqual(res.destroyed, true);
    assert.deepStrictEqual(res.recorder.map((entry) => entry.outcome).filter(Boolean), ["dnd"]);
    assert.deepStrictEqual(res.ctx.pendingPermissions, []);
  });

  it("allows legacy Pi permission requests during DND to preserve Pi YOLO behavior", async () => {
    const res = await callPermissionPost(JSON.stringify({
      agent_id: "pi",
      session_id: "pi:sid",
      tool_name: "bash",
      tool_input: { command: "npm test" },
    }), {
      ctx: { doNotDisturb: true },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    assert.strictEqual(JSON.parse(res.body).hookSpecificOutput.decision.behavior, "allow");
    assert.deepStrictEqual(res.recorder.map((entry) => entry.outcome).filter(Boolean), ["dnd"]);
    assert.deepStrictEqual(res.ctx.pendingPermissions, []);
  });

  it("returns no-decision for Antigravity DND fallback", async () => {
    const res = await callPermissionPost(JSON.stringify({
      agent_id: "antigravity-cli",
      session_id: "antigravity:sid",
      tool_name: "run_command",
      tool_input: { CommandLine: "npm test", Cwd: "/repo" },
    }), {
      ctx: { doNotDisturb: true },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    assert.deepStrictEqual(res.recorder.map((entry) => entry.outcome).filter(Boolean), ["dnd"]);
    assert.deepStrictEqual(res.ctx.pendingPermissions, []);
  });

  it("still returns 204 when Antigravity permission subgate is disabled (subgate has no effect on state-only flow)", async () => {
    // D2: Antigravity is state-only. The permission subgate (per-agent
    // bubble switch) no longer participates in any decision — kept here as
    // a regression guard so a future Settings change cannot accidentally
    // re-introduce a bubble path through the subgate.
    const res = await callPermissionPost(JSON.stringify({
      agent_id: "antigravity-cli",
      session_id: "antigravity:sid",
      tool_name: "write_to_file",
      tool_input: { TargetFile: "out.txt", CodeContent: "x" },
    }), {
      ctx: {
        isAgentPermissionsEnabled: (agentId) => agentId !== "antigravity-cli",
      },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    assert.deepStrictEqual(res.ctx.pendingPermissions, []);
  });

  it("returns no-decision when the Antigravity agent master switch is off", async () => {
    const res = await callPermissionPost(JSON.stringify({
      agent_id: "antigravity-cli",
      session_id: "antigravity:sid",
      tool_name: "run_command",
      tool_input: { CommandLine: "npm test", Cwd: "/repo" },
    }), {
      ctx: {
        isAgentEnabled: (agentId) => agentId !== "antigravity-cli",
      },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    assert.deepStrictEqual(res.recorder.map((entry) => entry.outcome).filter(Boolean), ["disabled"]);
    assert.deepStrictEqual(res.ctx.pendingPermissions, []);
  });

  it("hard-blocks a stray Antigravity PreToolUse: 204, no bubble, no entry", async () => {
    // D2 (post-codex-review-4): even if a user manually re-registers a
    // PreToolUse hook in their hooks.json (or auto-sync is skipped), the
    // server-side antigravity branch never creates a Clawd bubble. The
    // hook will print decision:"ask" and agy's own native menu owns the
    // permission decision.
    const res = await callPermissionPost(JSON.stringify({
      agent_id: "antigravity-cli",
      session_id: "antigravity:sid",
      tool_name: "run_command",
      tool_input: { CommandLine: "npm test", Cwd: "/repo" },
      tool_use_id: "tool-1",
      source_pid: 456,
      agent_pid: 456,
      pid_chain: [789, 456, -1],
      cwd: "/repo",
      host: "devbox",
      platform: "win32",
    }));

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    assert.deepStrictEqual(res.ctx.pendingPermissions, []);
    assert.deepStrictEqual(res.ctx.calls.showPermissionBubble || [], []);
    assert.deepStrictEqual(res.ctx.calls.addPendingPermission || [], []);
    assert.deepStrictEqual(res.ctx.calls.maybeStartRemoteApproval || [], []);
    assert.deepStrictEqual(res.ctx.calls.updateSession || [], []);
    assert.deepStrictEqual(res.ctx.calls.removePendingPermission || [], []);
    assert.deepStrictEqual(res.ctx.calls.sendPermissionResponse || [], []);
    assert.deepStrictEqual(res.recorder.map((item) => item.outcome).filter(Boolean), ["accepted"]);
  });

  it("allows legacy Pi permission requests without creating a bubble", async () => {
    const res = await callPermissionPost(JSON.stringify({
      agent_id: "pi",
      session_id: "pi:sid",
      tool_name: "write",
      tool_input: { path: "out.txt", content: "x" },
      tool_use_id: "tool-1",
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    assert.strictEqual(JSON.parse(res.body).hookSpecificOutput.decision.behavior, "allow");
    assert.deepStrictEqual(res.ctx.pendingPermissions, []);
    assert.deepStrictEqual(res.ctx.calls.updateSession, []);
    assert.deepStrictEqual(res.ctx.calls.showPermissionBubble, []);
    assert.deepStrictEqual(res.ctx.calls.maybeStartRemoteApproval, []);
    assert.deepStrictEqual(res.ctx.calls.addPendingPermission, []);
    assert.deepStrictEqual(res.recorder.map((item) => item.outcome).filter(Boolean), ["accepted"]);
  });

  it("allows legacy Pi permission requests when the Pi agent is disabled", async () => {
    const res = await callPermissionPost(JSON.stringify({
      agent_id: "pi",
      session_id: "pi:sid",
      tool_name: "edit",
      tool_input: { path: "a.txt" },
    }), {
      ctx: {
        isAgentEnabled: (agentId) => agentId !== "pi",
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    assert.strictEqual(JSON.parse(res.body).hookSpecificOutput.decision.behavior, "allow");
    assert.deepStrictEqual(res.ctx.pendingPermissions, []);
    assert.deepStrictEqual(res.recorder.map((item) => item.outcome).filter(Boolean), ["disabled"]);
  });

  it("pushes a normal Claude permission entry and shows the bubble", async () => {
    const res = await callPermissionPost(JSON.stringify({
      agent_id: "claude-code",
      session_id: "sid",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_use_id: "tool-1",
    }));

    assert.strictEqual(res.statusCode, null);
    assert.strictEqual(res.ctx.pendingPermissions.length, 1);
    const entry = res.ctx.pendingPermissions[0];
    assert.strictEqual(entry.res, res);
    assert.strictEqual(entry.sessionId, "sid");
    assert.strictEqual(entry.toolName, "Bash");
    assert.strictEqual(entry.toolUseId, "tool-1");
    assert.strictEqual(entry.agentId, "claude-code");
    assert.deepStrictEqual(res.ctx.calls.updateSession, [[
      "sid",
      "notification",
      "PermissionRequest",
      { agentId: "claude-code" },
    ]]);
    assert.deepStrictEqual(res.ctx.calls.showPermissionBubble, [entry]);
    assert.deepStrictEqual(res.ctx.calls.maybeStartRemoteApproval, [entry]);
    assert.deepStrictEqual(res.recorder.map((item) => item.outcome).filter(Boolean), ["accepted"]);
  });

  it("starts remote approval only after a Claude bubble is shown", async () => {
    const order = [];
    const res = await callPermissionPost(JSON.stringify({
      agent_id: "claude-code",
      session_id: "sid",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    }), {
      ctx: {
        showPermissionBubble: () => order.push("bubble"),
        maybeStartRemoteApproval: () => order.push("remote"),
      },
    });

    assert.strictEqual(res.statusCode, null);
    assert.deepStrictEqual(order, ["bubble", "remote"]);
  });

  it("does not start remote approval when a Claude bubble fails", async () => {
    const res = await callPermissionPost(JSON.stringify({
      agent_id: "claude-code",
      session_id: "sid",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    }), {
      ctx: {
        showPermissionBubble: () => {
          throw new Error("no window");
        },
      },
    });

    assert.strictEqual(res.destroyed, true);
    assert.deepStrictEqual(res.ctx.pendingPermissions, []);
    assert.deepStrictEqual(res.ctx.calls.maybeStartRemoteApproval, []);
    assert.deepStrictEqual(res.ctx.calls.removePendingPermission.map((item) => item.reason), ["bubble-failed"]);
  });

  it("returns terminal fallback when an elicitation bubble fails", async () => {
    const res = await callPermissionPost(JSON.stringify({
      agent_id: "claude-code",
      session_id: "sid",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Continue?" }] },
    }), {
      ctx: {
        showPermissionBubble: () => {
          throw new Error("no window");
        },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.ctx.pendingPermissions, []);
    assert.deepStrictEqual(res.ctx.calls.maybeStartRemoteApproval, []);
    assert.deepStrictEqual(res.ctx.calls.sendPermissionResponse, [{
      behavior: "deny",
      message: "Elicitation bubble unavailable; answer in terminal",
    }]);
  });

  it("keeps local Claude permission pending if remote approval startup throws", async () => {
    const res = await callPermissionPost(JSON.stringify({
      agent_id: "claude-code",
      session_id: "sid",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    }), {
      ctx: {
        maybeStartRemoteApproval: () => {
          throw new Error("sidecar unavailable");
        },
      },
    });

    assert.strictEqual(res.statusCode, null);
    assert.strictEqual(res.ctx.pendingPermissions.length, 1);
    assert.match(res.ctx.calls.logs.join("\n"), /sidecar unavailable/);
  });

  it("does not start remote approval for elicitation, passthrough, DND, or opencode paths", async () => {
    const cases = [
      {
        body: { tool_name: "ExitPlanMode", tool_input: { plan: "ship it" } },
      },
      {
        body: { tool_name: "AskUserQuestion", tool_input: { questions: [] } },
      },
      {
        body: { tool_name: "TaskList", tool_input: {} },
        ctx: { PASSTHROUGH_TOOLS: new Set(["TaskList"]) },
      },
      {
        body: { tool_name: "Bash", tool_input: { command: "npm test" } },
        ctx: { doNotDisturb: true },
      },
      {
        body: {
          agent_id: "opencode",
          tool_name: "Bash",
          request_id: "req-1",
          bridge_url: "http://127.0.0.1:1234",
          bridge_token: "token",
        },
      },
    ];

    for (const item of cases) {
      const res = await callPermissionPost(JSON.stringify(item.body), { ctx: item.ctx || {} });
      assert.deepStrictEqual(res.ctx.calls.maybeStartRemoteApproval, [], item.body.tool_name);
    }
  });
});
