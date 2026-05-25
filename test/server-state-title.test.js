"use strict";

// Integration tests for the /state endpoint's session_title handling
// and the raised MAX_STATE_BODY_BYTES = 4096 cap.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

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

function makeReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  // Emit data/end asynchronously — mirrors real http.IncomingMessage behavior
  setImmediate(() => {
    if (body != null) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function callHandler(handler, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: null,
      headers: {},
      body: "",
      writeHead(code, headers) {
        this.statusCode = code;
        if (headers) this.headers = headers;
      },
      end(data) {
        if (data) this.body += String(data);
        resolve(this);
      },
    };
    handler(req, res);
  });
}

function makeCtx(overrides = {}) {
  const updateSessionCalls = [];
  const setStateCalls = [];

  const ctx = {
    // Required HTTP/server deps — injected to avoid real file/network I/O.
    createHttpServer: null, // caller fills in
    setImmediate: () => {}, // no-op: don't fire sync routines during /state tests
    getPortCandidates: () => [23333],
    writeRuntimeConfig: () => true,
    clearRuntimeConfig: () => true,
    readRuntimePort: () => null,

    // Hook sync impls — keep them all as no-ops
    syncClawdHooksImpl: () => {},
    syncGeminiHooksImpl: () => {},
    syncCursorHooksImpl: () => {},
    syncCodeBuddyHooksImpl: () => {},
    syncKiroHooksImpl: () => {},
    syncQwenHooksImpl: () => {},
    syncOpencodePluginImpl: () => {},

    // /state handler deps
    STATE_SVGS: {
      idle: "x.svg",
      working: "x.svg",
      thinking: "x.svg",
      attention: "x.svg",
      sweeping: "x.svg",
    },
    pendingPermissions: [],
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    setState: (...args) => setStateCalls.push(args),
    updateSession: (...args) => updateSessionCalls.push(args),
    resolvePermissionEntry: () => {},

    // Telemetry hooks — optional, default to no-ops
    permLog: () => {},
    updateLog: () => {},

    ...overrides,
  };

  return { ctx, updateSessionCalls, setStateCalls };
}

function startServer(overrides) {
  const http = makeFakeHttp();
  const { ctx, updateSessionCalls, setStateCalls } = makeCtx(overrides);
  ctx.createHttpServer = http.createHttpServer;
  const api = initServer(ctx);
  api.startHttpServer();
  return {
    handler: http.getHandler(),
    updateSessionCalls,
    setStateCalls,
    api,
  };
}

// updateSession signature (post-B2): (sessionId, state, event, opts = {})
// — opts.sessionTitle is what we're asserting on.

describe("/state session_title handling", () => {
  it("passes session_title through to updateSession opts", async () => {
    const { handler, updateSessionCalls } = startServer();
    const req = makeReq("POST", "/state", JSON.stringify({
      state: "working",
      session_id: "sid-1",
      event: "PreToolUse",
      session_title: "Fix login bug",
    }));
    const res = await callHandler(handler, req);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(updateSessionCalls.length, 1);
    assert.strictEqual(updateSessionCalls[0][3].sessionTitle, "Fix login bug");
  });

  it("trims whitespace on session_title", async () => {
    const { handler, updateSessionCalls } = startServer();
    const req = makeReq("POST", "/state", JSON.stringify({
      state: "working",
      session_id: "sid-1",
      session_title: "   Padded Title   ",
    }));
    await callHandler(handler, req);
    assert.strictEqual(updateSessionCalls[0][3].sessionTitle, "Padded Title");
  });

  it("passes null when session_title is absent (keeps 200)", async () => {
    const { handler, updateSessionCalls } = startServer();
    const req = makeReq("POST", "/state", JSON.stringify({
      state: "working",
      session_id: "sid-1",
    }));
    const res = await callHandler(handler, req);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(updateSessionCalls[0][3].sessionTitle, null);
  });

  it("ignores non-string session_title and keeps 200 (matches cwd/agent_id style)", async () => {
    const { handler, updateSessionCalls } = startServer();
    const req = makeReq("POST", "/state", JSON.stringify({
      state: "working",
      session_id: "sid-1",
      session_title: 12345,
    }));
    const res = await callHandler(handler, req);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(updateSessionCalls[0][3].sessionTitle, null);
  });

  it("ignores empty/whitespace session_title and keeps 200", async () => {
    const { handler, updateSessionCalls } = startServer();
    const req = makeReq("POST", "/state", JSON.stringify({
      state: "working",
      session_id: "sid-1",
      session_title: "   ",
    }));
    const res = await callHandler(handler, req);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(updateSessionCalls[0][3].sessionTitle, null);
  });

  it("ignores object session_title and keeps 200", async () => {
    const { handler, updateSessionCalls } = startServer();
    const req = makeReq("POST", "/state", JSON.stringify({
      state: "working",
      session_id: "sid-1",
      session_title: { nested: "bad" },
    }));
    const res = await callHandler(handler, req);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(updateSessionCalls[0][3].sessionTitle, null);
  });
});

describe("/state MAX_STATE_BODY_BYTES (4KB cap)", () => {
  it("accepts a normal payload with session_title (returns 200)", async () => {
    const { handler, updateSessionCalls } = startServer();
    const req = makeReq("POST", "/state", JSON.stringify({
      state: "working",
      session_id: "sid-1",
      session_title: "Normal Title",
      cwd: "/some/path",
      pid_chain: [1, 2, 3, 4, 5],
    }));
    const res = await callHandler(handler, req);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(updateSessionCalls.length, 1);
  });

  it("returns 413 when body exceeds MAX_STATE_BODY_BYTES (4KB)", async () => {
    const { handler, updateSessionCalls } = startServer();
    // 5KB of padding in session_title — well over the 4KB cap
    const hugePayload = JSON.stringify({
      state: "working",
      session_id: "sid-1",
      session_title: "x".repeat(5000),
    });
    const req = makeReq("POST", "/state", hugePayload);
    const res = await callHandler(handler, req);
    assert.strictEqual(res.statusCode, 413);
    assert.strictEqual(updateSessionCalls.length, 0);
  });

  it("accepts a payload just under 4KB", async () => {
    const { handler, updateSessionCalls } = startServer();
    // Construct a payload that fits under 4096 bytes total
    const payload = {
      state: "working",
      session_id: "sid-1",
      session_title: "t".repeat(3500),
    };
    const body = JSON.stringify(payload);
    assert.ok(body.length < 4096, `test payload is ${body.length} bytes, should be < 4096`);
    const req = makeReq("POST", "/state", body);
    const res = await callHandler(handler, req);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(updateSessionCalls.length, 1);
  });
});

describe("/state Codex subagent role handling", () => {
  it("passes headless for official subagent state signals", async () => {
    const { handler, updateSessionCalls } = startServer({
      codexSubagentClassifier: {
        registerSession: () => "subagent",
      },
    });

    await callHandler(handler, makeReq("POST", "/state", JSON.stringify({
      state: "working",
      agent_id: "codex",
      hook_source: "codex-official",
      session_id: "codex:sub",
      event: "PreToolUse",
      turn_id: "turn-1",
      codex_session_role: "subagent",
    })));
    const res = await callHandler(handler, makeReq("POST", "/state", JSON.stringify({
      state: "idle",
      agent_id: "codex",
      hook_source: "codex-official",
      session_id: "codex:sub",
      event: "Stop",
      turn_id: "turn-1",
      codex_session_role: "subagent",
    })));

    assert.strictEqual(res.statusCode, 200);
    const last = updateSessionCalls[updateSessionCalls.length - 1];
    assert.strictEqual(last[0], "codex:sub");
    assert.strictEqual(last[1], "idle");
    assert.strictEqual(last[2], "Stop");
    assert.strictEqual(last[3].headless, true);
  });
});
