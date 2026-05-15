"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
} = require("../hooks/server-config");
const {
  MAX_STATE_BODY_BYTES,
  sendStateHealthResponse,
  handleStatePost,
} = require("../src/server-route-state");

function makeReq(body) {
  const req = new EventEmitter();
  setImmediate(() => {
    if (body != null) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function makeRes() {
  return {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(code, headers) {
      this.statusCode = code;
      if (headers) this.headers = headers;
    },
    end(data) {
      if (data) this.body += String(data);
      if (this.resolve) this.resolve(this);
    },
  };
}

function callStatePost(body, overrides = {}) {
  return new Promise((resolve) => {
    const res = makeRes();
    res.resolve = resolve;
    const calls = {
      updateSession: [],
      setState: [],
      recorder: [],
      resolved: [],
    };
    const ctx = {
      STATE_SVGS: {
        working: "x.svg",
        attention: "x.svg",
        "mini-idle": "x.svg",
      },
      pendingPermissions: [],
      isAgentEnabled: () => true,
      setState: (...args) => calls.setState.push(args),
      updateSession: (...args) => calls.updateSession.push(args),
      resolvePermissionEntry: (perm, behavior, message) => calls.resolved.push({ perm, behavior, message }),
      ...overrides.ctx,
    };
    handleStatePost(makeReq(body), res, {
      ctx,
      createRequestHookRecorder: (data, route) => {
        calls.recorder.push({ data, route });
        return {
          acceptedUnlessDnd: (dropForDnd) => calls.recorder.push({ outcome: dropForDnd ? "dnd" : "accepted" }),
          droppedByDisabled: () => calls.recorder.push({ outcome: "disabled" }),
        };
      },
      shouldDropForDnd: () => false,
      codexOfficialTurns: new Map(),
      ...overrides.options,
    });
    res.calls = calls;
  });
}

describe("server-route-state health", () => {
  it("returns the same /state health payload and header", () => {
    const res = makeRes();

    sendStateHealthResponse(res, { getHookServerPort: () => 23334 });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["Content-Type"], "application/json");
    assert.strictEqual(res.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    assert.deepStrictEqual(JSON.parse(res.body), {
      ok: true,
      app: CLAWD_SERVER_ID,
      port: 23334,
    });
  });
});

describe("server-route-state POST", () => {
  it("passes normalized metadata to updateSession", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "PreToolUse",
      display_svg: "/tmp/display.svg",
      source_pid: 123.9,
      cwd: "D:\\repo",
      editor: "cursor",
      pid_chain: [1, "bad", 3],
      agent_pid: 99.8,
      agent_id: "codex",
      host: "remote-host",
      headless: true,
      platform: "webui",
      model: "gpt-5.4",
      provider: "openai",
      codex_originator: "Codex Desktop",
      codex_source: "vscode",
      session_title: "  Work title  ",
      permission_suspect: true,
      preserve_state: true,
      hook_source: "codex-official",
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.calls.updateSession, [[
      "sid",
      "working",
      "PreToolUse",
      {
        sourcePid: 123,
        cwd: "D:\\repo",
        editor: "cursor",
        pidChain: [1, 3],
        agentPid: 99,
        agentId: "codex",
        host: "remote-host",
        headless: true,
        platform: "webui",
        model: "gpt-5.4",
        provider: "openai",
        codexOriginator: "Codex Desktop",
        codexSource: "vscode",
        displayHint: "display.svg",
        sessionTitle: "Work title",
        permissionSuspect: true,
        preserveState: true,
        hookSource: "codex-official",
      },
    ]]);
  });

  it("uses basename for explicit svg state overrides", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "working",
      svg: "/tmp/pet.svg",
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.calls.setState, [["working", "pet.svg"]]);
  });

  it("drops disabled agents with a 204 and records the disabled outcome", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "working",
      agent_id: "codex",
    }), {
      ctx: {
        isAgentEnabled: (agentId) => agentId !== "codex",
      },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    assert.deepStrictEqual(res.calls.recorder.map((entry) => entry.outcome).filter(Boolean), ["disabled"]);
    assert.deepStrictEqual(res.calls.updateSession, []);
  });

  it("returns 400 for mini states without an svg override", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "mini-idle",
    }));

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body, "mini states require svg override");
  });

  it("returns 413 when the body exceeds MAX_STATE_BODY_BYTES", async () => {
    const body = JSON.stringify({
      state: "working",
      session_title: "x".repeat(MAX_STATE_BODY_BYTES),
    });

    const res = await callStatePost(body);

    assert.strictEqual(res.statusCode, 413);
    assert.strictEqual(res.body, "state payload too large");
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await callStatePost("{not json");

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body, "bad json");
  });
});
