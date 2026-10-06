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
  let root, clock, sessions, enabled, launches, runtime, payload;
  const identity = { agentId: "claude-code", sessionId: "saved-session" };
  function makeRuntime(launcher = async () => ({ ok: true })) {
    return createSessionHistoryRuntime({
      getSessions: () => sessions,
      isAgentEnabled: () => enabled,
      launchClaudeSession: (...args) => { launches.push(args); return launcher(...args); },
      now: () => clock,
      historyOptions: {
        historyDir: path.join(root, "history"),
        claudeProjectsDir: path.join(root, "claude-projects"),
        now: clock,
      },
    });
  }
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-resume-owner-"));
    clock = Date.now();
    enabled = true;
    sessions = new Map();
    launches = [];
    const recorded = recordSessionHistoryFromStateBody({
      agent_id: identity.agentId,
      session_id: identity.sessionId,
      event: "UserPromptSubmit", state: "working", cwd: root },
    { historyDir: path.join(root, "history"), eventAt: clock, env: {} });
    payload = { agentId: identity.agentId, historyKey: recorded.record.historyKey };
    runtime = makeRuntime();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("propagates the real launcher's all-terminals-failed result", async () => {
    runtime = makeRuntime((mode, cwd, id, profile) => launchClaudeSession(mode, cwd, id, {
      platform: () => "win32", findClaudeCmd: async () => "claude",
      tryLaunch: async () => ({ ok: false, error: new Error("ENOENT") }),
    }, profile));
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
    sessions.set("live", {
      agentId: identity.agentId,
      rawSessionId: identity.sessionId,
      profileId: "local",
    });
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
      sessions.set("other", { agentId: "claude-code", rawSessionId: identity.sessionId,
        profileId: "local", ...extra });
      assert.equal(runtime.getHistory().length, 1);
    }
  });

  it("refuses absent targets, foreign agents and missing project folders", async () => {
    assert.equal((await runtime.resume({ ...payload, historyKey: "0".repeat(32) })).reason, "unresolvable");
    assert.equal((await runtime.resume({ ...payload, agentId: "codex" })).reason, "agent-unavailable");
    const project = path.join(root, "project");
    fs.mkdirSync(project);
    recordSessionHistoryFromStateBody({ agent_id: identity.agentId, session_id: identity.sessionId,
      event: "PreToolUse", state: "working", cwd: project },
    { historyDir: path.join(root, "history"), eventAt: clock + 1, env: {} });
    fs.rmdirSync(project);
    assert.equal((await runtime.resume(payload)).reason, "unresolvable");
    assert.equal(launches.length, 0);
  });

  it("serializes identical raw session ids across Claude profiles because live identity cannot distinguish them", async () => {
    const customConfigDir = path.join(root, "custom-claude");
    const custom = recordSessionHistoryFromStateBody({
      agent_id: identity.agentId,
      session_id: identity.sessionId,
      event: "UserPromptSubmit",
      state: "working",
      cwd: root,
    }, {
      historyDir: path.join(root, "history"),
      eventAt: clock + 1,
      env: { CLAUDE_CONFIG_DIR: customConfigDir },
    });
    const rows = runtime.getHistory();
    assert.equal(rows.length, 2);
    const customPayload = { agentId: identity.agentId, historyKey: custom.record.historyKey };

    const [defaultResult, customResult] = await Promise.all([
      runtime.resume(payload),
      runtime.resume(customPayload),
    ]);

    assert.deepEqual(defaultResult, customResult);
    assert.equal(defaultResult.status, "submitted");
    assert.equal(launches.length, 1);
    assert.deepEqual(launches[0][3], { kind: "default", configDir: null });
    assert.deepEqual(runtime.getHistory().map((row) => row.resumePending), [true, true]);
  });
});
