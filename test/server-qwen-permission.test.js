"use strict";

const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { describe, it } = require("node:test");

const initServer = require("../src/server");

function makeFakeHttp() {
  let capturedHandler = null;
  function createHttpServer(handler) {
    capturedHandler = handler;
    const server = new EventEmitter();
    server.listen = function () { this.emit("listening"); };
    server.close = function () {};
    return server;
  }
  return { createHttpServer, getHandler: () => capturedHandler };
}

function makeReq(body) {
  const req = new EventEmitter();
  req.method = "POST";
  req.url = "/permission";
  setImmediate(() => {
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function makeRes(resolve) {
  const res = new EventEmitter();
  res.statusCode = null;
  res.headers = {};
  res.body = "";
  res.writableEnded = false;
  res.writableFinished = false;
  res.destroyed = false;
  res.headersSent = false;
  res.writeHead = function (code, headers) {
    this.statusCode = code;
    this.headers = headers || {};
    this.headersSent = true;
  };
  res.end = function (data) {
    if (data) this.body += String(data);
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit("close");
    if (resolve) resolve(this);
  };
  res.destroy = function () {
    this.destroyed = true;
    this.emit("close");
  };
  return res;
}

function callPermission(handler, body) {
  return new Promise((resolve) => {
    handler(makeReq(body), makeRes(resolve));
  });
}

function startServer(overrides = {}) {
  const http = makeFakeHttp();
  const pendingPermissions = [];
  const updates = [];
  const shown = [];
  const ctx = {
    createHttpServer: http.createHttpServer,
    setImmediate: () => {},
    getPortCandidates: () => [23333],
    writeRuntimeConfig: () => true,
    clearRuntimeConfig: () => true,
    readRuntimePort: () => null,
    syncClawdHooksImpl: () => {},
    syncGeminiHooksImpl: () => {},
    syncAntigravityHooksImpl: () => {},
    syncCursorHooksImpl: () => {},
    syncCodeBuddyHooksImpl: () => {},
    syncKiroHooksImpl: () => {},
    syncKimiHooksImpl: () => {},
    syncQwenHooksImpl: () => {},
    syncCodexHooksImpl: () => {},
    syncOpencodePluginImpl: () => {},
    syncPiExtensionImpl: () => {},
    syncOpenClawPluginImpl: () => {},
    syncHermesPluginImpl: () => {},
    pendingPermissions,
    doNotDisturb: false,
    hideBubbles: false,
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    updateSession: (...args) => updates.push(args),
    showPermissionBubble: (entry) => shown.push(entry),
    resolvePermissionEntry: (entry, behavior, message) => {
      const idx = pendingPermissions.indexOf(entry);
      if (idx !== -1) pendingPermissions.splice(idx, 1);
      if (behavior === "no-decision") {
        entry.res.writeHead(204, {});
        entry.res.end();
      }
      return message;
    },
    permLog: () => {},
    updateLog: () => {},
    ...overrides,
  };
  const api = initServer(ctx);
  api.startHttpServer();
  return {
    handler: http.getHandler(),
    pendingPermissions,
    updates,
    shown,
  };
}

describe("Qwen Code /permission path", () => {
  it("returns no-decision on DND", async () => {
    const { handler, pendingPermissions } = startServer({ doNotDisturb: true });

    const res = await callPermission(handler, {
      agent_id: "qwen-code",
      session_id: "qwen-code:s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.body, "");
    assert.strictEqual(pendingPermissions.length, 0);
  });

  it("returns no-decision when Qwen or Qwen permissions are disabled", async () => {
    for (const overrides of [
      { isAgentEnabled: (agentId) => agentId !== "qwen-code" },
      { isAgentPermissionsEnabled: (agentId) => agentId !== "qwen-code" },
    ]) {
      const { handler, pendingPermissions } = startServer(overrides);
      const res = await callPermission(handler, {
        agent_id: "qwen-code",
        session_id: "qwen-code:s1",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      });

      assert.strictEqual(res.statusCode, 204);
      assert.strictEqual(res.body, "");
      assert.strictEqual(pendingPermissions.length, 0);
    }
  });

  it("enqueues a Qwen approval bubble without suggestions or provider-specific fields", async () => {
    const { handler, pendingPermissions, updates, shown } = startServer();
    const req = makeReq({
      agent_id: "qwen-code",
      session_id: "qwen-code:s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_input_fingerprint: "abc123",
      tool_use_id: "tool-1",
      cwd: "/repo",
      model: "qwen3-coder-plus",
      permission_suggestions: [{ type: "addRules" }],
      source_pid: 123,
      agent_pid: 456,
      pid_chain: [789, 456, 123],
    });
    const res = makeRes();

    handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(res.writableEnded, false);
    assert.strictEqual(pendingPermissions.length, 1);
    assert.strictEqual(shown.length, 1);
    const entry = pendingPermissions[0];
    assert.strictEqual(entry.isQwenCode, true);
    assert.strictEqual(entry.agentId, "qwen-code");
    assert.deepStrictEqual(entry.suggestions, []);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, "opencodeAlwaysCandidates"), false);
    assert.strictEqual(entry.toolInputFingerprint, "abc123");
    assert.strictEqual(entry.toolUseId, "tool-1");
    assert.strictEqual(entry.model, "qwen3-coder-plus");
    assert.deepStrictEqual(updates[0], [
      "qwen-code:s1",
      "notification",
      "PermissionRequest",
      {
        agentId: "qwen-code",
        sourcePid: 123,
        agentPid: 456,
        pidChain: [789, 456, 123],
        cwd: "/repo",
        model: "qwen3-coder-plus",
      },
    ]);

    res.destroy();
  });

  it("returns no-decision when bubble creation fails", async () => {
    const { handler, pendingPermissions } = startServer({
      showPermissionBubble: () => {
        throw new Error("boom");
      },
    });

    const res = await callPermission(handler, {
      agent_id: "qwen-code",
      session_id: "qwen-code:s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.body, "");
    assert.strictEqual(pendingPermissions.length, 0);
  });
});
