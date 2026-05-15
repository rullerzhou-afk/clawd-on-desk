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
    syncCursorHooksImpl: () => {},
    syncCodeBuddyHooksImpl: () => {},
    syncKiroHooksImpl: () => {},
    syncCodexHooksImpl: () => {},
    syncOpencodePluginImpl: () => {},
    pendingPermissions,
    doNotDisturb: false,
    hideBubbles: false,
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    updateSession: (...args) => updates.push(args),
    showPermissionBubble: (entry) => shown.push(entry),
    resolvePermissionEntry: (entry) => {
      const idx = pendingPermissions.indexOf(entry);
      if (idx !== -1) pendingPermissions.splice(idx, 1);
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

describe("Codex official /permission path", () => {
  it("returns no-decision on DND instead of denying", async () => {
    const { handler, pendingPermissions } = startServer({ doNotDisturb: true });

    const res = await callPermission(handler, {
      agent_id: "codex",
      session_id: "codex:s1",
      tool_name: "Bash",
      tool_input: { command: "npm test", description: "Run tests" },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.body, "");
    assert.strictEqual(pendingPermissions.length, 0);
  });

  it("returns no-decision when Codex permission bubbles are disabled", async () => {
    const { handler, pendingPermissions } = startServer({
      isAgentPermissionsEnabled: (agentId) => agentId !== "codex",
      isCodexPermissionInterceptEnabled: () => true,
    });

    const res = await callPermission(handler, {
      agent_id: "codex",
      session_id: "codex:s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(pendingPermissions.length, 0);
  });

  it("defaults Codex PermissionRequest to a real approval bubble", async () => {
    const { handler, pendingPermissions, updates, shown } = startServer();
    const req = makeReq({
      agent_id: "codex",
      hook_source: "codex-official",
      session_id: "codex:s1",
      tool_name: "Bash",
      tool_input: { command: "whoami /all" },
    });
    const res = makeRes();

    handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(res.writableEnded, false);
    assert.strictEqual(pendingPermissions.length, 1);
    assert.strictEqual(shown.length, 1);
    assert.deepStrictEqual(updates[0], [
      "codex:s1",
      "notification",
      "PermissionRequest",
      { agentId: "codex", hookSource: "codex-official" },
    ]);

    res.destroy();
  });

  it("returns no-decision in explicit native mode while recording the event", async () => {
    const { handler, pendingPermissions, updates, shown } = startServer({
      isCodexPermissionInterceptEnabled: () => false,
    });
    const res = await callPermission(handler, {
      agent_id: "codex",
      hook_source: "codex-official",
      session_id: "codex:019e115a-4df2-7ed0-b90e-8e6345aca777",
      tool_name: "Bash",
      tool_input: { command: "whoami /all" },
      cwd: "/repo",
      source_pid: 456,
      agent_pid: 456,
      pid_chain: [789, 456],
      model: "gpt-5.4",
      codex_originator: "Codex Desktop",
      codex_source: "vscode",
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.body, "");
    assert.strictEqual(pendingPermissions.length, 0);
    assert.strictEqual(shown.length, 0);
    assert.deepStrictEqual(updates[0], [
      "codex:019e115a-4df2-7ed0-b90e-8e6345aca777",
      "notification",
      "PermissionRequest",
      {
        agentId: "codex",
        hookSource: "codex-official",
        sourcePid: 456,
        agentPid: 456,
        pidChain: [789, 456],
        cwd: "/repo",
        model: "gpt-5.4",
        codexOriginator: "Codex Desktop",
        codexSource: "vscode",
      },
    ]);
  });

  it("enqueues a real Codex approval bubble in intercept mode without suggestions or elicitation", async () => {
    const { handler, pendingPermissions, updates, shown } = startServer({
      isCodexPermissionInterceptEnabled: () => true,
    });
    const req = makeReq({
      agent_id: "codex",
      hook_source: "codex-official",
      session_id: "codex:s1",
      tool_name: "Bash",
      tool_input_description: "Run tests with escalated permission",
      tool_input: { command: "npm test", description: "from tool input" },
      tool_input_fingerprint: "abc123",
      turn_id: "turn-1",
    });
    const res = makeRes();

    handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(res.writableEnded, false);
    assert.strictEqual(pendingPermissions.length, 1);
    assert.strictEqual(shown.length, 1);

    const entry = pendingPermissions[0];
    assert.strictEqual(entry.isCodex, true);
    assert.strictEqual(entry.agentId, "codex");
    assert.strictEqual(entry.sessionId, "codex:s1");
    assert.strictEqual(entry.toolName, "Bash");
    assert.deepStrictEqual(entry.suggestions, []);
    assert.strictEqual(entry.isElicitation || false, false);
    assert.strictEqual(entry.toolInput.description, "Run tests with escalated permission");
    assert.strictEqual(entry.toolInput.command, "npm test");
    assert.strictEqual(entry.toolInputFingerprint, "abc123");
    assert.deepStrictEqual(updates[0], [
      "codex:s1",
      "notification",
      "PermissionRequest",
      { agentId: "codex", hookSource: "codex-official" },
    ]);

    res.destroy();
  });

  it("does not suppress subagent PermissionRequest or pass headless", async () => {
    const { handler, pendingPermissions, updates, shown } = startServer({
      isCodexPermissionInterceptEnabled: () => true,
    });
    const req = makeReq({
      agent_id: "codex",
      hook_source: "codex-official",
      codex_session_role: "subagent",
      session_id: "codex:sub",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    const res = makeRes();

    handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(res.writableEnded, false);
    assert.strictEqual(pendingPermissions.length, 1);
    assert.strictEqual(shown.length, 1);
    assert.deepStrictEqual(updates[0], [
      "codex:sub",
      "notification",
      "PermissionRequest",
      { agentId: "codex", hookSource: "codex-official" },
    ]);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(updates[0][3], "headless"), false);

    res.destroy();
  });
});
