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
    syncCursorHooksImpl: () => {},
    syncCodeBuddyHooksImpl: () => {},
    syncKiroHooksImpl: () => {},
    syncQwenHooksImpl: () => {},
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
      localSessionKey("codex:s1"),
      "notification",
      "PermissionRequest",
      {
        agentId: "codex",
        hookSource: "codex-official",
        profileId: "local",
        rawSessionId: "codex:s1",
        sessionAutomationIdentity: {
          eligible: false,
          reason: "non-authoritative-codex-session-id",
        },
      },
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
      localSessionKey("codex:019e115a-4df2-7ed0-b90e-8e6345aca777"),
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
        profileId: "local",
        rawSessionId: "codex:019e115a-4df2-7ed0-b90e-8e6345aca777",
        sessionAutomationIdentity: {
          eligible: false,
          reason: "unsupported-codex-session-source",
        },
        transientPermissionEvent: true,
      },
    ]);
  });

  it("marks native PermissionRequest notification sound muted when the Codex switch is off", async () => {
    const { handler, updates } = startServer({
      isCodexPermissionInterceptEnabled: () => false,
      isCodexNativeNotificationSoundEnabled: () => false,
    });
    const res = await callPermission(handler, {
      agent_id: "codex",
      hook_source: "codex-official",
      session_id: "codex:silent",
      tool_name: "Bash",
      tool_input: { command: "whoami /all" },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0][3].muteNotificationSound, true);
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
    assert.strictEqual(entry.sessionId, localSessionKey("codex:s1"));
    assert.strictEqual(entry.profileId, "local");
    assert.strictEqual(entry.rawSessionId, "codex:s1");
    assert.strictEqual(entry.toolName, "Bash");
    assert.deepStrictEqual(entry.suggestions, []);
    assert.strictEqual(entry.isElicitation || false, false);
    assert.strictEqual(entry.toolInput.description, "Run tests with escalated permission");
    assert.strictEqual(entry.toolInput.command, "npm test");
    assert.strictEqual(entry.toolInputFingerprint, "abc123");
    assert.deepStrictEqual(updates[0], [
      localSessionKey("codex:s1"),
      "notification",
      "PermissionRequest",
      {
        agentId: "codex",
        hookSource: "codex-official",
        profileId: "local",
        rawSessionId: "codex:s1",
        sessionAutomationIdentity: {
          eligible: false,
          reason: "non-authoritative-codex-session-id",
        },
      },
    ]);

    res.destroy();
  });

  it("marks an audited local process-bound Codex TUI permission eligible", async () => {
    const sessionId = "codex:019f9c87-23a9-7d03-a7ac-c11e3270c3b8";
    const { handler, pendingPermissions, updates } = startServer();
    const req = makeReq({
      agent_id: "codex",
      hook_source: "codex-official",
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      source_pid: 778,
      agent_pid: 777,
      codex_originator: "codex-tui",
      codex_source: "cli",
    });
    const res = makeRes();

    handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(
      pendingPermissions[0].sessionAutomationIdentity,
      { eligible: true, reason: "eligible" }
    );
    assert.deepStrictEqual(
      updates[0][3].sessionAutomationIdentity,
      pendingPermissions[0].sessionAutomationIdentity
    );
    res.destroy();
  });

  it("routes an interactive subagent PermissionRequest through the approval bubble", async () => {
    const { handler, pendingPermissions, updates, shown } = startServer({
      isCodexPermissionInterceptEnabled: () => true,
    });
    const req = makeReq({
      hook_source: "codex-official",
      codex_session_role: "subagent",
      codex_originator: "codex-tui",
      codex_agent_nickname: "Halley",
      codex_parent_thread_id: "parent-1",
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
    assert.strictEqual(pendingPermissions[0].codexSessionRole, "subagent");
    assert.strictEqual(pendingPermissions[0].codexAgentNickname, "Halley");
    assert.strictEqual(pendingPermissions[0].codexParentThreadId, "parent-1");
    assert.strictEqual(pendingPermissions[0].subagentId, localSessionKey("codex:sub"));
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(updates[0][3], "headless"), false);

    res.destroy();
  });

  it("does not let the state-only subagent headless marker suppress an interactive approval", async () => {
    const sessionId = localSessionKey("codex:sub-state");
    const { handler, pendingPermissions, shown } = startServer({
      sessions: new Map([[sessionId, { agentId: "codex", headless: true }]]),
      isCodexPermissionInterceptEnabled: () => true,
    });
    const req = makeReq({
      hook_source: "codex-official",
      codex_session_role: "subagent",
      codex_originator: "codex_work_desktop",
      session_id: "codex:sub-state",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    const res = makeRes();

    handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(res.writableEnded, false);
    assert.strictEqual(pendingPermissions.length, 1);
    assert.strictEqual(shown.length, 1);
    res.destroy();
  });

  it("keeps an explicitly headless subagent on the native no-decision fallback", async () => {
    const { handler, pendingPermissions, updates, shown } = startServer({
      isCodexPermissionInterceptEnabled: () => true,
    });
    const res = await callPermission(handler, {
      hook_source: "codex-official",
      codex_session_role: "subagent",
      codex_originator: "codex-tui",
      headless: true,
      session_id: "codex:sub-headless",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(pendingPermissions.length, 0);
    assert.strictEqual(shown.length, 0);
    assert.deepStrictEqual(updates, []);
  });

  it("keeps codex_exec and unknown subagent originators on native fallback", async () => {
    for (const originator of ["codex_exec", "unknown-client", null]) {
      const rawSessionId = `codex:sub-${originator || "missing"}`;
      const { handler, pendingPermissions, updates, shown } = startServer({
        isCodexPermissionInterceptEnabled: () => true,
      });
      const body = {
        hook_source: "codex-official",
        codex_session_role: "subagent",
        session_id: rawSessionId,
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      };
      if (originator) body.codex_originator = originator;
      const res = await callPermission(handler, body);

      assert.strictEqual(res.statusCode, 204, String(originator));
      assert.strictEqual(pendingPermissions.length, 0, String(originator));
      assert.strictEqual(shown.length, 0, String(originator));
      assert.deepStrictEqual(updates, [], String(originator));
    }
  });
});
