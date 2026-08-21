"use strict";

const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { describe, it } = require("node:test");

const initServer = require("../src/server");
const { makeSessionKey } = require("../src/session-key");

const localSessionKey = (rawSessionId) => makeSessionKey({
  profileId: "local",
  rawSessionId,
});

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

describe("ZCode /permission path", () => {
  it("returns no-decision on DND", async () => {
    const { handler, pendingPermissions } = startServer({ doNotDisturb: true });

    const res = await callPermission(handler, {
      agent_id: "zcode",
      session_id: "zcode:s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.body, "");
    assert.strictEqual(pendingPermissions.length, 0);
  });

  it("returns no-decision when ZCode or ZCode permissions are disabled", async () => {
    for (const overrides of [
      { isAgentEnabled: (agentId) => agentId !== "zcode" },
      { isAgentPermissionsEnabled: (agentId) => agentId !== "zcode" },
    ]) {
      const { handler, pendingPermissions } = startServer(overrides);
      const res = await callPermission(handler, {
        agent_id: "zcode",
        session_id: "zcode:s1",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      });

      assert.strictEqual(res.statusCode, 204);
      assert.strictEqual(res.body, "");
      assert.strictEqual(pendingPermissions.length, 0);
    }
  });

  it("returns no-decision when permission bubbles are globally hidden", async () => {
    const { handler, pendingPermissions } = startServer({
      getBubblePolicy: () => ({ enabled: false, autoCloseMs: null }),
    });

    const res = await callPermission(handler, {
      agent_id: "zcode",
      session_id: "zcode:s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.body, "");
    assert.strictEqual(pendingPermissions.length, 0);
  });

  it("routes to remote-only approval when local bubbles are hidden but remote is available", async () => {
    const remoteEntries = [];
    const { handler, pendingPermissions, shown } = startServer({
      getBubblePolicy: () => ({ enabled: false, autoCloseMs: null }),
      maybeStartRemoteApproval(entry) {
        remoteEntries.push(entry);
        return true;
      },
    });
    const req = makeReq({
      agent_id: "zcode",
      session_id: "zcode:s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    const res = makeRes();

    handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    // The request stays pending on the remote channel — no 204, no bubble.
    assert.strictEqual(res.writableEnded, false);
    assert.strictEqual(shown.length, 0);
    assert.strictEqual(pendingPermissions.length, 1);
    const entry = pendingPermissions[0];
    assert.strictEqual(entry.remoteOnly, true);
    assert.strictEqual(entry.isZcode, true);
    assert.strictEqual(entry.agentId, "zcode");
    assert.strictEqual(remoteEntries.length, 1);

    res.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(pendingPermissions.length, 0);
  });

  it("returns no-decision before remote-only approval for a no-capability interaction", async () => {
    let remoteStarts = 0;
    const { handler, pendingPermissions, shown } = startServer({
      getBubblePolicy: () => ({ enabled: false, autoCloseMs: null }),
      maybeStartRemoteApproval() {
        remoteStarts++;
        return true;
      },
    });
    const req = makeReq({
      agent_id: "zcode",
      session_id: "zcode:s1",
      tool_name: "ExitPlanMode",
      tool_input: { plan: "do the thing" },
    });
    const res = makeRes();

    handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.writableEnded, true);
    assert.strictEqual(pendingPermissions.length, 0);
    assert.strictEqual(shown.length, 0);
    assert.strictEqual(remoteStarts, 0);
  });

  it("rolls back a remote-only approval when the session update fails", async () => {
    const remoteEntries = [];
    const { handler, pendingPermissions, shown } = startServer({
      getBubblePolicy: () => ({ enabled: false, autoCloseMs: null }),
      maybeStartRemoteApproval(entry) {
        remoteEntries.push(entry);
        return true;
      },
      updateSession() {
        throw new Error("session store unavailable");
      },
    });

    const res = await callPermission(handler, {
      agent_id: "zcode",
      session_id: "zcode:remote-update-failure",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(pendingPermissions.length, 0);
    assert.strictEqual(shown.length, 0);
    assert.strictEqual(remoteEntries.length, 1);
  });

  it("returns no-decision when local bubbles are hidden and no remote channel is available", async () => {
    const { handler, pendingPermissions } = startServer({
      getBubblePolicy: () => ({ enabled: false, autoCloseMs: null }),
      // No maybeStartRemoteApproval on ctx.
    });

    const res = await callPermission(handler, {
      agent_id: "zcode",
      session_id: "zcode:s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(pendingPermissions.length, 0);
  });

  it("never offers Allow/Deny for a no-capability interaction (ZCode ExitPlanMode)", async () => {
    const { handler, pendingPermissions, shown, updates } = startServer();

    const res = await callPermission(handler, {
      agent_id: "zcode",
      session_id: "zcode:s1",
      tool_name: "ExitPlanMode",
      tool_input: { plan: "do the thing" },
    });

    // ZCode 3.5.3 ships a real ExitPlanMode; without a reviewed decision-tool
    // contract it has no allow/answer/plan capability, so neither the bubble
    // nor a remote card may decide — hand it back to the native UI.
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(pendingPermissions.length, 0);
    assert.strictEqual(shown.length, 0);
    assert.strictEqual(updates.length, 0);
  });

  it("never offers decisions for AskUserQuestion (no answerQuestions capability)", async () => {
    const { handler, pendingPermissions } = startServer();

    const res = await callPermission(handler, {
      agent_id: "zcode",
      session_id: "zcode:s1",
      tool_name: "AskUserQuestion",
      tool_input: { question: "continue?" },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(pendingPermissions.length, 0);
  });

  it("rolls back to no-decision when updateSession throws (no pending leak)", async () => {
    const { handler, pendingPermissions, shown } = startServer({
      updateSession() {
        throw new Error("boom");
      },
    });

    const res = await callPermission(handler, {
      agent_id: "zcode",
      session_id: "zcode:s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(pendingPermissions.length, 0);
    assert.strictEqual(shown.length, 0);
  });

  it("enqueues a ZCode approval bubble with the zcode session namespace and no suggestions", async () => {
    const { handler, pendingPermissions, updates, shown } = startServer();
    const req = makeReq({
      agent_id: "zcode",
      session_id: "zcode:s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_input_fingerprint: "abc123",
      tool_use_id: "tool-1",
      cwd: "/repo",
      model: "GLM-5.2",
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
    assert.strictEqual(entry.isZcode, true);
    assert.strictEqual(entry.agentId, "zcode");
    assert.strictEqual(entry.profileId, "local");
    assert.strictEqual(entry.rawSessionId, "zcode:s1");
    assert.deepStrictEqual(entry.suggestions, []);
    assert.strictEqual(entry.toolInputFingerprint, "abc123");
    assert.strictEqual(entry.toolUseId, "tool-1");
    assert.strictEqual(entry.model, "GLM-5.2");
    assert.deepStrictEqual(updates[0], [
      localSessionKey("zcode:s1"),
      "notification",
      "PermissionRequest",
      {
        agentId: "zcode",
        sourcePid: 123,
        agentPid: 456,
        pidChain: [789, 456, 123],
        cwd: "/repo",
        model: "GLM-5.2",
        profileId: "local",
        rawSessionId: "zcode:s1",
        sessionAutomationIdentity: {
          eligible: false,
          reason: "automation-not-audited",
        },
      },
    ]);

    res.destroy();
  });

  it("falls back to the zcode:default session when no session_id is present", async () => {
    const { handler, pendingPermissions } = startServer();
    const req = makeReq({
      agent_id: "zcode",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    const res = makeRes();

    handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(pendingPermissions.length, 1);
    assert.strictEqual(pendingPermissions[0].sessionId, localSessionKey("zcode:default"));

    res.destroy();
  });

  it("returns no-decision when bubble creation fails", async () => {
    const { handler, pendingPermissions } = startServer({
      showPermissionBubble: () => {
        throw new Error("boom");
      },
    });

    const res = await callPermission(handler, {
      agent_id: "zcode",
      session_id: "zcode:s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.body, "");
    assert.strictEqual(pendingPermissions.length, 0);
  });

  it("answers no-decision when the ZCode hook client disconnects", async () => {
    const { handler, pendingPermissions } = startServer();
    const req = makeReq({
      agent_id: "zcode",
      session_id: "zcode:s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    const res = makeRes();

    handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(pendingPermissions.length, 1);

    res.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(pendingPermissions.length, 0);
  });
});
