"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSessionHistoryRuntime, RESUME_CONFIRMATION_MS } = require("../src/session-history-runtime");
const { recordSessionHistoryFromStateBody } = require("../hooks/session-history");
const { launchClaudeSession } = require("../src/launch-claude");

describe("session history resume owner", () => {
  let root, clock, sessions, enabled, launches, runtime;
  const payload = { agentId: "claude-code", sessionId: "saved-session" };
  function makeRuntime(launcher = async () => ({ ok: true })) {
    return createSessionHistoryRuntime({
      getSessions: () => sessions,
      isAgentEnabled: () => enabled,
      launchClaudeSession: (...args) => { launches.push(args); return launcher(...args); },
      now: () => clock,
      historyOptions: { historyDir: path.join(root, "history"), now: clock },
    });
  }
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-resume-owner-"));
    clock = Date.now();
    enabled = true;
    sessions = new Map();
    launches = [];
    recordSessionHistoryFromStateBody({ agent_id: payload.agentId, session_id: payload.sessionId,
      event: "UserPromptSubmit", state: "working", cwd: root },
    { historyDir: path.join(root, "history"), eventAt: clock });
    runtime = makeRuntime();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("propagates the real launcher's all-terminals-failed result", async () => {
    runtime = makeRuntime((mode, cwd, id) => launchClaudeSession(mode, cwd, id, {
      platform: () => "win32", findClaudeCmd: async () => "claude",
      tryLaunch: async () => ({ ok: false, error: new Error("ENOENT") }),
    }));
    assert.deepEqual(await runtime.resume(payload), {
      status: "error", reason: "launch-failed", message: "ENOENT",
    });
    assert.equal(runtime.getHistory()[0].resumePending, false);
    await runtime.resume(payload);
    assert.equal(launches.length, 2, "known failure permits a deliberate retry");
  });

  it("coalesces concurrent requests, retains submission across page reloads, then observes live state", async () => {
    let finish;
    runtime = makeRuntime(() => new Promise((resolve) => { finish = resolve; }));
    const first = runtime.resume(payload);
    const second = runtime.resume(payload);
    await Promise.resolve();
    assert.equal(launches.length, 1);
    assert.equal(runtime.getHistory()[0].resumePending, true);
    finish({ ok: true });
    const result = await first;
    assert.deepEqual(result, { status: "submitted", retryAt: clock + RESUME_CONFIRMATION_MS });
    assert.deepEqual(await second, result);
    assert.deepEqual(await runtime.resume(payload), result);
    assert.equal(launches.length, 1);
    assert.equal(runtime.getHistory()[0].resumePending, true, "a new Dashboard sees main's pending state");
    sessions.set("live", { ...payload, rawSessionId: payload.sessionId, profileId: "local" });
    assert.deepEqual(runtime.getHistory(), []);
    assert.deepEqual(await runtime.resume(payload), { status: "already-running" });
    assert.equal(launches.length, 1);
    sessions.clear();
    assert.equal(runtime.getHistory()[0].resumePending, false);
  });

  it("allows only an explicit retry after the confirmation window", async () => {
    await runtime.resume(payload);
    clock += RESUME_CONFIRMATION_MS + 1;
    assert.equal(runtime.getHistory()[0].resumePending, false);
    assert.equal(launches.length, 1, "expiry never starts a terminal");
    await runtime.resume(payload);
    assert.equal(launches.length, 2);
  });

  it("blocks disabled/uninstalled agents both at request and dispatch", async () => {
    enabled = false;
    assert.equal((await runtime.resume(payload)).reason, "agent-unavailable");
    enabled = true;
    const requested = runtime.resume(payload);
    enabled = false;
    assert.equal((await requested).reason, "agent-unavailable");
    assert.equal(launches.length, 0);
  });

  it("does not confuse a remote, WSL or other-agent raw ID with local Claude", () => {
    for (const extra of [{ profileId: "ssh-one" }, { host: "server" },
      { wslDistro: "Ubuntu" }, { agentId: "codex" }]) {
      sessions.set("other", { agentId: "claude-code", rawSessionId: payload.sessionId,
        profileId: "local", ...extra });
      assert.equal(runtime.getHistory().length, 1);
    }
  });

  it("refuses absent targets, foreign agents and missing project folders", async () => {
    assert.equal((await runtime.resume({ ...payload, sessionId: "unknown" })).reason, "unresolvable");
    assert.equal((await runtime.resume({ ...payload, agentId: "codex" })).reason, "agent-unavailable");
    const project = path.join(root, "project");
    fs.mkdirSync(project);
    recordSessionHistoryFromStateBody({ agent_id: payload.agentId, session_id: payload.sessionId,
      event: "PreToolUse", state: "working", cwd: project },
    { historyDir: path.join(root, "history"), eventAt: clock + 1 });
    fs.rmdirSync(project);
    assert.equal((await runtime.resume(payload)).reason, "unresolvable");
    assert.equal(launches.length, 0);
  });
});
