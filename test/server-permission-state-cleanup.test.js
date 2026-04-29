"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const initServer = require("../src/server");

const {
  buildToolInputFingerprint,
  findPendingPermissionForStateEvent,
} = initServer.__test;

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
  const resolved = [];
  const ctx = {
    createHttpServer: null,
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
    syncOpencodePluginImpl: () => {},
    STATE_SVGS: {
      working: "x.svg",
      error: "x.svg",
      attention: "x.svg",
    },
    pendingPermissions: [],
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    setState: () => {},
    updateSession: () => {},
    resolvePermissionEntry: (perm, behavior, message) => {
      resolved.push({ perm, behavior, message });
    },
    permLog: () => {},
    updateLog: () => {},
    ...overrides,
  };
  return { ctx, resolved };
}

function startServer(overrides) {
  const http = makeFakeHttp();
  const { ctx, resolved } = makeCtx(overrides);
  ctx.createHttpServer = http.createHttpServer;
  const api = initServer(ctx);
  api.startHttpServer();
  return {
    handler: http.getHandler(),
    resolved,
  };
}

describe("findPendingPermissionForStateEvent", () => {
  it("matches concurrent requests by tool_use_id", () => {
    const pending = [
      { id: "a", sessionId: "sid", toolUseId: "toolu_a", toolName: "Read", res: {} },
      { id: "b", sessionId: "sid", toolUseId: "toolu_b", toolName: "Read", res: {} },
    ];
    const match = findPendingPermissionForStateEvent(pending, {
      sessionId: "sid",
      toolUseId: "toolu_b",
    });
    assert.strictEqual(match.id, "b");
  });

  it("falls back to tool fingerprint when tool_use_id is missing", () => {
    const fingerprintA = buildToolInputFingerprint({ file_path: "src/a.js" });
    const fingerprintB = buildToolInputFingerprint({ file_path: "src/b.js" });
    const pending = [
      { id: "a", sessionId: "sid", toolName: "Read", toolInputFingerprint: fingerprintA, res: {} },
      { id: "b", sessionId: "sid", toolName: "Read", toolInputFingerprint: fingerprintB, res: {} },
    ];
    const match = findPendingPermissionForStateEvent(pending, {
      sessionId: "sid",
      toolName: "Read",
      toolInputFingerprint: fingerprintB,
    });
    assert.strictEqual(match.id, "b");
  });

  it("falls back to fingerprint when the event has tool_use_id but the pending request does not", () => {
    const fingerprint = buildToolInputFingerprint({ command: "printenv COMPUTERNAME" });
    const pending = [
      { id: "only", sessionId: "sid", toolName: "Bash", toolInputFingerprint: fingerprint, res: {} },
    ];
    const match = findPendingPermissionForStateEvent(pending, {
      sessionId: "sid",
      toolName: "Bash",
      toolUseId: "toolu_terminal",
      toolInputFingerprint: fingerprint,
    });
    assert.strictEqual(match.id, "only");
  });

  it("uses the single pending request fallback for Stop cleanup", () => {
    const pending = [
      { id: "only", sessionId: "sid", toolName: "Bash", res: {} },
    ];
    const match = findPendingPermissionForStateEvent(pending, {
      sessionId: "sid",
      allowSingletonFallback: true,
    });
    assert.strictEqual(match.id, "only");
  });

  it("refuses ambiguous Stop cleanup when multiple requests are pending", () => {
    const pending = [
      { id: "a", sessionId: "sid", toolName: "Bash", res: {} },
      { id: "b", sessionId: "sid", toolName: "Bash", res: {} },
    ];
    const match = findPendingPermissionForStateEvent(pending, {
      sessionId: "sid",
      allowSingletonFallback: true,
    });
    assert.strictEqual(match, null);
  });

  it("does not use singleton fallback for unrelated PostToolUse events", () => {
    const pending = [
      { id: "only", sessionId: "sid", toolName: "Bash", res: {} },
    ];
    const match = findPendingPermissionForStateEvent(pending, {
      sessionId: "sid",
      toolName: "Read",
    });
    assert.strictEqual(match, null);
  });

  it("does not match by tool name alone when only one pending request exists", () => {
    const pending = [
      { id: "only", sessionId: "sid", toolUseId: "toolu_pending", toolName: "Bash", res: {} },
    ];
    const match = findPendingPermissionForStateEvent(pending, {
      sessionId: "sid",
      toolName: "Bash",
    });
    assert.strictEqual(match, null);
  });

  it("does not fall back to fingerprint when tool_use_id mismatches", () => {
    const fingerprint = buildToolInputFingerprint({ command: "stat -c '%n %y' src/server.js" });
    const pending = [
      {
        id: "only",
        sessionId: "sid",
        toolUseId: "toolu_pending",
        toolName: "Bash",
        toolInputFingerprint: fingerprint,
        res: {},
      },
    ];
    const match = findPendingPermissionForStateEvent(pending, {
      sessionId: "sid",
      toolName: "Bash",
      toolUseId: "toolu_other",
      toolInputFingerprint: fingerprint,
    });
    assert.strictEqual(match, null);
  });
});

describe("/state permission cleanup", () => {
  it("resolves only the matching concurrent permission entry", async () => {
    const pendingPermissions = [
      {
        id: "a",
        sessionId: "sid",
        toolUseId: "toolu_a",
        toolName: "Read",
        toolInputFingerprint: buildToolInputFingerprint({ file_path: "src/a.js" }),
        res: {},
      },
      {
        id: "b",
        sessionId: "sid",
        toolUseId: "toolu_b",
        toolName: "Read",
        toolInputFingerprint: buildToolInputFingerprint({ file_path: "src/b.js" }),
        res: {},
      },
    ];
    const { handler, resolved } = startServer({ pendingPermissions });

    const res = await callHandler(handler, makeReq("POST", "/state", JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "PostToolUse",
      tool_name: "Read",
      tool_use_id: "toolu_b",
      tool_input_fingerprint: buildToolInputFingerprint({ file_path: "src/b.js" }),
    })));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(resolved.map((entry) => entry.perm.id), ["b"]);
    assert.deepStrictEqual(resolved.map((entry) => entry.message), ["User answered in terminal"]);
  });

  it("keeps concurrent pending requests untouched when Stop is ambiguous", async () => {
    const pendingPermissions = [
      { id: "a", sessionId: "sid", toolName: "Bash", res: {} },
      { id: "b", sessionId: "sid", toolName: "Bash", res: {} },
    ];
    const { handler, resolved } = startServer({ pendingPermissions });

    const res = await callHandler(handler, makeReq("POST", "/state", JSON.stringify({
      state: "attention",
      session_id: "sid",
      event: "Stop",
    })));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(resolved, []);
  });

  it("does not clear a single pending Bash request when another tool finishes", async () => {
    const pendingPermissions = [
      { id: "bash", sessionId: "sid", toolName: "Bash", res: {} },
    ];
    const { handler, resolved } = startServer({ pendingPermissions });

    const res = await callHandler(handler, makeReq("POST", "/state", JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "PostToolUse",
      tool_name: "Read",
    })));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(resolved, []);
  });

  it("does not clear a pending Bash request when another Bash finishes", async () => {
    const pendingPermissions = [
      {
        id: "pending-bash",
        sessionId: "sid",
        toolUseId: "toolu_pending",
        toolName: "Bash",
        toolInputFingerprint: buildToolInputFingerprint({ command: "stat -c '%n %y' src/server.js" }),
        res: {},
      },
    ];
    const { handler, resolved } = startServer({ pendingPermissions });

    const res = await callHandler(handler, makeReq("POST", "/state", JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu_other",
      tool_input_fingerprint: buildToolInputFingerprint({ command: "tail -100 permission-debug.log" }),
    })));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(resolved, []);
  });

  it("does not clear a pending Bash request when another Bash fails", async () => {
    const pendingPermissions = [
      {
        id: "pending-bash",
        sessionId: "sid",
        toolUseId: "toolu_pending",
        toolName: "Bash",
        toolInputFingerprint: buildToolInputFingerprint({ command: "stat -c '%n %y' src/server.js" }),
        res: {},
      },
    ];
    const { handler, resolved } = startServer({ pendingPermissions });

    const res = await callHandler(handler, makeReq("POST", "/state", JSON.stringify({
      state: "error",
      session_id: "sid",
      event: "PostToolUseFailure",
      tool_name: "Bash",
      tool_use_id: "toolu_other",
      tool_input_fingerprint: buildToolInputFingerprint({ command: "find /tmp -name '*clawd*'" }),
    })));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(resolved, []);
  });

  it("sweeps stale elicitation bubble when any PostToolUse fires for the same session", async () => {
    const pendingPermissions = [
      {
        id: "elicit",
        sessionId: "sid",
        toolName: "AskUserQuestion",
        toolUseId: "toolu_elicit",
        toolInputFingerprint: buildToolInputFingerprint({ questions: [{ question: "Pick one" }] }),
        isElicitation: true,
        res: {},
      },
    ];
    const { handler, resolved } = startServer({ pendingPermissions });

    const res = await callHandler(handler, makeReq("POST", "/state", JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu_bash_after",
      tool_input_fingerprint: buildToolInputFingerprint({ command: "echo hi" }),
    })));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(resolved.map((e) => e.perm.id), ["elicit"]);
    assert.deepStrictEqual(resolved.map((e) => e.message), ["User answered in terminal"]);
  });

  it("does not sweep non-elicitation bubbles from other sessions", async () => {
    const pendingPermissions = [
      {
        id: "elicit",
        sessionId: "other-sid",
        toolName: "AskUserQuestion",
        toolUseId: "toolu_elicit",
        isElicitation: true,
        res: {},
      },
      {
        id: "bash-perm",
        sessionId: "sid",
        toolUseId: "toolu_bash_perm",
        toolName: "Bash",
        res: {},
      },
    ];
    const { handler, resolved } = startServer({ pendingPermissions });

    const res = await callHandler(handler, makeReq("POST", "/state", JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "PostToolUse",
      tool_name: "Read",
      tool_use_id: "toolu_read",
    })));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(resolved, []);
  });

  it("clears a terminal-answered pending Bash request when the pending entry lacks tool_use_id", async () => {
    const command = "printenv COMPUTERNAME";
    const pendingPermissions = [
      {
        id: "pending-bash",
        sessionId: "sid",
        toolName: "Bash",
        toolInputFingerprint: buildToolInputFingerprint({ command }),
        res: {},
      },
    ];
    const { handler, resolved } = startServer({ pendingPermissions });

    const res = await callHandler(handler, makeReq("POST", "/state", JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu_terminal",
      tool_input_fingerprint: buildToolInputFingerprint({ command }),
    })));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(resolved.map((entry) => entry.perm.id), ["pending-bash"]);
    assert.deepStrictEqual(resolved.map((entry) => entry.message), ["User answered in terminal"]);
  });
});
