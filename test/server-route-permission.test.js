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
  shouldBypassPiBubble,
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
    assert.strictEqual(shouldBypassPiBubble({ hideBubbles: true }), true);
    assert.strictEqual(shouldBypassPiBubble({
      isAgentPermissionsEnabled: (agentId) => agentId !== "pi",
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

  it("returns no-decision for Pi DND fallback", async () => {
    const res = await callPermissionPost(JSON.stringify({
      agent_id: "pi",
      session_id: "pi:sid",
      tool_name: "bash",
      tool_input: { command: "npm test" },
    }), {
      ctx: { doNotDisturb: true },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    assert.deepStrictEqual(res.recorder.map((entry) => entry.outcome).filter(Boolean), ["dnd"]);
    assert.deepStrictEqual(res.ctx.pendingPermissions, []);
  });

  it("returns no-decision when Pi permission subgate is disabled", async () => {
    const res = await callPermissionPost(JSON.stringify({
      agent_id: "pi",
      session_id: "pi:sid",
      tool_name: "write",
      tool_input: { path: "out.txt", content: "x" },
    }), {
      ctx: {
        isAgentPermissionsEnabled: (agentId) => agentId !== "pi",
      },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    assert.deepStrictEqual(res.ctx.pendingPermissions, []);
  });

  it("pushes a Pi permission entry and shows the bubble", async () => {
    const res = await callPermissionPost(JSON.stringify({
      agent_id: "pi",
      session_id: "pi:sid",
      tool_name: "bash",
      tool_input: { command: "npm test" },
      tool_use_id: "tool-1",
    }));

    assert.strictEqual(res.statusCode, null);
    assert.strictEqual(res.ctx.pendingPermissions.length, 1);
    const entry = res.ctx.pendingPermissions[0];
    assert.strictEqual(entry.res, res);
    assert.strictEqual(entry.sessionId, "pi:sid");
    assert.strictEqual(entry.toolName, "bash");
    assert.strictEqual(entry.toolUseId, "tool-1");
    assert.strictEqual(entry.agentId, "pi");
    assert.strictEqual(entry.isPi, true);
    assert.deepStrictEqual(res.ctx.calls.updateSession, [[
      "pi:sid",
      "notification",
      "PermissionRequest",
      { agentId: "pi" },
    ]]);
    assert.deepStrictEqual(res.ctx.calls.showPermissionBubble, [entry]);
    assert.deepStrictEqual(res.recorder.map((item) => item.outcome).filter(Boolean), ["accepted"]);
  });

  it("returns no-decision when Pi bubble creation fails", async () => {
    const res = await callPermissionPost(JSON.stringify({
      agent_id: "pi",
      session_id: "pi:sid",
      tool_name: "edit",
      tool_input: { path: "a.txt" },
    }), {
      ctx: {
        showPermissionBubble: () => {
          throw new Error("no window");
        },
      },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    assert.deepStrictEqual(res.ctx.pendingPermissions, []);
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
    assert.deepStrictEqual(res.recorder.map((item) => item.outcome).filter(Boolean), ["accepted"]);
  });
});
