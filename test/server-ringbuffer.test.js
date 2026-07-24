"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const initServer = require("../src/server");
const {
  HOOK_EVENT_RING_SIZE_PER_AGENT,
  REJECTED_CUSTOM_AGENT_ID,
  createSingleRequestHookEventRecorder,
  recordHookEventInBuffer,
  getRecentHookEventsFromBuffer,
} = require("../src/server-hook-events");
const { makeSessionKey } = require("../src/session-key");

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

function makeReq(method, url, body, headers = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  setImmediate(() => {
    if (body != null) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function makeRes(resolve) {
  const res = new EventEmitter();
  res.statusCode = null;
  res.headers = {};
  res.body = "";
  res.headersSent = false;
  res.writableFinished = false;
  res.writeHead = function (code, headers) {
    this.statusCode = code;
    this.headers = headers || {};
    this.headersSent = true;
  };
  res.end = function (data) {
    if (data) this.body += String(data);
    this.writableFinished = true;
    this.emit("close");
    if (resolve) resolve(this);
  };
  res.destroy = function () {
    this.destroyed = true;
    this.emit("close");
    if (resolve) resolve(this);
  };
  return res;
}

function callHandler(handler, method, url, body, headers) {
  return new Promise((resolve) => {
    handler(makeReq(method, url, JSON.stringify(body), headers), makeRes(resolve));
  });
}

function hookIdentity(agentId) {
  return { agentId, source: "explicit", defaulted: false };
}

function makeCtx(overrides = {}) {
  const pendingPermissions = [];
  const sessions = new Map();
  const updateSessionCalls = [];
  const setStateCalls = [];
  const shown = [];
  return {
    createHttpServer: null,
    setImmediate: () => {},
    getPortCandidates: () => [23333],
    writeRuntimeConfig: () => true,
    clearRuntimeConfig: () => true,
    readRuntimePort: () => null,
    STATE_SVGS: {
      idle: "x.svg",
      working: "x.svg",
      thinking: "x.svg",
      attention: "x.svg",
      notification: "x.svg",
    },
    pendingPermissions,
    sessions,
    PASSTHROUGH_TOOLS: new Set(),
    doNotDisturb: false,
    shouldDropForDnd: () => false,
    hideBubbles: false,
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    setState: (...args) => setStateCalls.push(args),
    updateSession: (...args) => updateSessionCalls.push(args),
    resolvePermissionEntry: () => {},
    sendPermissionResponse: (res, behavior, message) => {
      res.writeHead(200, { "x-clawd-server": "clawd-on-desk" });
      res.end(JSON.stringify({ behavior, message }));
    },
    showPermissionBubble: (entry) => shown.push(entry),
    replyOpencodeFamilyPermission: () => {},
    permLog: () => {},
    updateLog: () => {},
    _test: { pendingPermissions, sessions, updateSessionCalls, setStateCalls, shown },
    ...overrides,
  };
}

function startServer(overrides = {}) {
  const http = makeFakeHttp();
  const ctx = makeCtx(overrides);
  ctx.createHttpServer = http.createHttpServer;
  const api = initServer(ctx);
  api.startHttpServer();
  return { api, handler: http.getHandler(), ctx };
}

describe("server hook event ringbuffer", () => {
  it("main server rejects misrouted secure Remote SSH requests before state or permission routing", async () => {
    const { api, handler, ctx } = startServer();

    const res = await callHandler(handler, "POST", "/state", {
      agent_id: "codex",
      state: "working",
      session_id: "sid",
    }, {
      "x-clawd-routing-nonce": "a".repeat(32),
    });

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.headers["x-clawd-server"], undefined);
    assert.strictEqual(ctx._test.updateSessionCalls.length, 0);
    assert.deepStrictEqual(api.getRecentHookEvents(), []);
  });

  it("records /state disabled gate once", async () => {
    const { api, handler } = startServer({
      isAgentEnabled: (agentId) => agentId !== "codex",
    });

    const res = await callHandler(handler, "POST", "/state", {
      agent_id: "codex",
      state: "working",
      event: "PreToolUse",
    });

    assert.strictEqual(res.statusCode, 204);
    assert.deepStrictEqual(api.getRecentHookEvents(), [{
      timestamp: api.getRecentHookEvents()[0].timestamp,
      agentId: "codex",
      eventType: "PreToolUse",
      route: "state",
      outcome: "dropped-by-disabled",
    }]);
  });

  it("records /state DND before updateSession calls into state.js", async () => {
    const { api, handler, ctx } = startServer({
      doNotDisturb: true,
      shouldDropForDnd: () => true,
    });

    const res = await callHandler(handler, "POST", "/state", {
      agent_id: "claude-code",
      state: "working",
      event: "UserPromptSubmit",
      session_id: "sid",
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(ctx._test.updateSessionCalls.length, 1);
    assert.strictEqual(api.getRecentHookEvents()[0].outcome, "dropped-by-dnd");
  });

  it("records /state accepted with event type normalization", async () => {
    const { api, handler } = startServer();

    const res = await callHandler(handler, "POST", "/state", {
      agent_id: "gemini-cli",
      state: "thinking",
      event: "UserPromptSubmit",
    });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(api.getRecentHookEvents().map(({ agentId, eventType, route, outcome }) => ({
      agentId,
      eventType,
      route,
      outcome,
    })), [{
      agentId: "gemini-cli",
      eventType: "UserPromptSubmit",
      route: "state",
      outcome: "accepted",
    }]);
  });

  it("records registered custom state activity under the custom id", async () => {
    const id = "custom-nova-ai-0123456789ab";
    const pushed = [];
    const { api, handler } = startServer({
      getCustomAgentIds: () => [id],
      onHookEventRecorded: (event) => pushed.push(event),
    });

    const res = await callHandler(handler, "POST", "/state", {
      agent_id: id,
      state: "working",
      event: "PreToolUse",
      session_id: "nova:sid",
    });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(api.getRecentHookEvents({ agentId: id }).map(({ agentId, route, outcome }) => ({
      agentId,
      route,
      outcome,
    })), [{ agentId: id, route: "state", outcome: "accepted" }]);
    assert.strictEqual(pushed.length, 1);
    assert.strictEqual(pushed[0].agentId, id);
    assert.strictEqual(pushed[0].eventType, "PreToolUse");
  });

  it("records stale custom state activity under the bounded sentinel", async () => {
    const { api, handler, ctx } = startServer();

    const res = await callHandler(handler, "POST", "/state", {
      agent_id: "custom-stale-0123456789ab",
      state: "working",
      event: "PreToolUse",
      session_id: "stale:sid",
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(ctx._test.updateSessionCalls.length, 0);
    assert.deepStrictEqual(api.getRecentHookEvents().map(({ agentId, outcome }) => ({ agentId, outcome })), [{
      agentId: REJECTED_CUSTOM_AGENT_ID,
      outcome: "dropped-invalid-agent",
    }]);
  });

  it("forwards preserve_state to state.js without changing hook event recording", async () => {
    const { api, handler, ctx } = startServer();

    const res = await callHandler(handler, "POST", "/state", {
      agent_id: "gemini-cli",
      state: "idle",
      event: "PreCompress",
      session_id: "gemini:s1",
      preserve_state: true,
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(ctx._test.updateSessionCalls.length, 1);
    assert.strictEqual(
      ctx._test.updateSessionCalls[0][0],
      makeSessionKey({ profileId: "local", rawSessionId: "gemini:s1" }),
    );
    assert.strictEqual(ctx._test.updateSessionCalls[0][1], "idle");
    assert.strictEqual(ctx._test.updateSessionCalls[0][2], "PreCompress");
    assert.strictEqual(ctx._test.updateSessionCalls[0][3].preserveState, true);
    assert.deepStrictEqual(api.getRecentHookEvents().map(({ agentId, eventType, route, outcome }) => ({
      agentId,
      eventType,
      route,
      outcome,
    })), [{
      agentId: "gemini-cli",
      eventType: "PreCompress",
      route: "state",
      outcome: "accepted",
    }]);
  });

  it("records /permission DND gate", async () => {
    const { api, handler } = startServer({ doNotDisturb: true });

    const res = await callHandler(handler, "POST", "/permission", {
      agent_id: "codex",
      session_id: "codex:s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.deepStrictEqual(api.getRecentHookEvents().map(({ agentId, eventType, route, outcome }) => ({
      agentId,
      eventType,
      route,
      outcome,
    })), [{
      agentId: "codex",
      eventType: "PermissionRequest",
      route: "permission",
      outcome: "dropped-by-dnd",
    }]);
  });

  it("records /permission disabled gate", async () => {
    const { api, handler } = startServer({
      isAgentEnabled: (agentId) => agentId !== "codex",
    });

    const res = await callHandler(handler, "POST", "/permission", {
      agent_id: "codex",
      session_id: "codex:s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(api.getRecentHookEvents()[0].outcome, "dropped-by-disabled");
  });

  it("records Codex native permission mode as accepted HTTP activity", async () => {
    const { api, handler, ctx } = startServer({
      isCodexPermissionInterceptEnabled: () => false,
    });

    const res = await callHandler(handler, "POST", "/permission", {
      agent_id: "codex",
      hook_source: "codex-official",
      session_id: "codex:s1",
      tool_name: "Bash",
      tool_input: { command: "whoami /all" },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(ctx._test.pendingPermissions.length, 0);
    assert.deepStrictEqual(api.getRecentHookEvents().map(({ agentId, eventType, route, outcome }) => ({
      agentId,
      eventType,
      route,
      outcome,
    })), [{
      agentId: "codex",
      eventType: "PermissionRequest",
      route: "permission",
      outcome: "accepted",
    }]);
  });

  it("records /permission accepted once on the bubble path", async () => {
    const { api, handler, ctx } = startServer();
    const res = makeRes();
    handler(makeReq("POST", "/permission", JSON.stringify({
      agent_id: "claude-code",
      session_id: "sid",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    })), res);

    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(ctx._test.pendingPermissions.length, 1);
    assert.strictEqual(ctx._test.shown.length, 1);
    assert.deepStrictEqual(api.getRecentHookEvents().map(({ agentId, eventType, route, outcome }) => ({
      agentId,
      eventType,
      route,
      outcome,
    })), [{
      agentId: "claude-code",
      eventType: "PermissionRequest",
      route: "permission",
      outcome: "accepted",
    }]);
    res.destroy();
  });

  it("records registered custom permission activity as unsupported", async () => {
    const id = "custom-nova-ai-0123456789ab";
    const { api, handler, ctx } = startServer({ getCustomAgentIds: () => [id] });

    const res = await callHandler(handler, "POST", "/permission", {
      agent_id: id,
      session_id: "nova:sid",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(ctx._test.pendingPermissions.length, 0);
    assert.deepStrictEqual(api.getRecentHookEvents({ agentId: id }).map(({ route, outcome }) => ({ route, outcome })), [{
      route: "permission",
      outcome: "dropped-unsupported",
    }]);
  });

  it("records opencode malformed bridge requests as HTTP activity", async () => {
    const { api, handler } = startServer();

    const res = await callHandler(handler, "POST", "/permission", {
      agent_id: "opencode",
      session_id: "opencode:s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(api.getRecentHookEvents().map(({ agentId, route, outcome }) => ({
      agentId,
      route,
      outcome,
    })), [{
      agentId: "opencode",
      route: "permission",
      outcome: "accepted",
    }]);
  });

  it("caps each agent ring at 50 events", () => {
    const buffer = new Map();
    for (let i = 0; i < HOOK_EVENT_RING_SIZE_PER_AGENT + 7; i++) {
      recordHookEventInBuffer(buffer, hookIdentity("codex"), {
        agent_id: "codex",
        event: `E${i}`,
      }, "state", "accepted", { now: () => i });
    }

    const events = getRecentHookEventsFromBuffer(buffer);
    assert.strictEqual(events.length, HOOK_EVENT_RING_SIZE_PER_AGENT);
    assert.strictEqual(events[0].eventType, "E7");
    assert.strictEqual(events.at(-1).eventType, `E${HOOK_EVENT_RING_SIZE_PER_AGENT + 6}`);
  });

  it("attributes hook events by hook_source when agent_id is missing", () => {
    const buffer = new Map();
    recordHookEventInBuffer(buffer, hookIdentity("opencode"), {
      hook_source: "opencode-plugin",
      event: "PreToolUse",
    }, "state", "accepted", { now: () => 10 });

    const events = getRecentHookEventsFromBuffer(buffer);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].agentId, "opencode");
    assert.strictEqual(events[0].eventType, "PreToolUse");
  });

  it("filters recent hook events by agent and timestamp and returns copies", () => {
    const buffer = new Map();
    recordHookEventInBuffer(buffer, hookIdentity("codex"), { agent_id: "codex", event: "Old" }, "state", "accepted", { now: () => 10 });
    recordHookEventInBuffer(buffer, hookIdentity("codex"), { agent_id: "codex", event: "New" }, "state", "accepted", { now: () => 20 });
    recordHookEventInBuffer(buffer, hookIdentity("gemini-cli"), { agent_id: "gemini-cli", event: "Other" }, "state", "accepted", { now: () => 30 });

    const events = getRecentHookEventsFromBuffer(buffer, { agentId: "codex", since: 20 });

    assert.deepStrictEqual(events.map(({ agentId, eventType, timestamp }) => ({ agentId, eventType, timestamp })), [{
      agentId: "codex",
      eventType: "New",
      timestamp: 20,
    }]);
    events[0].eventType = "mutated";
    assert.strictEqual(buffer.get("codex")[1].eventType, "New");
  });

  it("single-request recorder keeps the first valid route outcome", () => {
    const calls = [];
    const recorder = createSingleRequestHookEventRecorder(
      (identity, data, route, outcome) => {
        calls.push({ identity, data, route, outcome });
        return { route, outcome };
      },
      hookIdentity("codex"),
      { agent_id: "codex" },
      "permission"
    );

    assert.strictEqual(recorder.record("bogus", "accepted"), null);
    assert.deepStrictEqual(recorder.accepted(), { route: "permission", outcome: "accepted" });
    assert.strictEqual(recorder.droppedByDnd(), null);
    assert.strictEqual(recorder.droppedByDisabled("state"), null);
    assert.deepStrictEqual(calls, [{
      identity: hookIdentity("codex"),
      data: { agent_id: "codex" },
      route: "permission",
      outcome: "accepted",
    }]);
  });

  it("uses one bounded sentinel ring for rejected custom ids", () => {
    const buffer = new Map();
    for (let i = 0; i < HOOK_EVENT_RING_SIZE_PER_AGENT + 7; i++) {
      const rawAgentId = `custom-${i}-${"x".repeat(100)}`;
      recordHookEventInBuffer(buffer, {
        agentId: null,
        source: "rejected-custom",
        rejected: true,
        rawAgentId,
      }, { agent_id: rawAgentId, event: "PreToolUse" }, "state", "dropped-invalid-agent", { now: () => i });
    }

    assert.deepStrictEqual([...buffer.keys()], [REJECTED_CUSTOM_AGENT_ID]);
    assert.strictEqual(buffer.get(REJECTED_CUSTOM_AGENT_ID).length, HOOK_EVENT_RING_SIZE_PER_AGENT);
    assert.ok(buffer.get(REJECTED_CUSTOM_AGENT_ID).every((event) => (
      event.agentId === REJECTED_CUSTOM_AGENT_ID && event.rawAgentId.length <= 80
    )));
  });
});
