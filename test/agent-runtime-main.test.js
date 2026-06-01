"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const createAgentRuntimeMain = require("../src/agent-runtime-main");

const SRC_DIR = path.join(__dirname, "..", "src");

function makeFakeMonitorClass(instances) {
  return class FakeCodexLogMonitor {
    constructor(agent, callback, options) {
      this.agent = agent;
      this.callback = callback;
      this.options = options;
      this.started = 0;
      this.stopped = 0;
      instances.push(this);
    }

    start() {
      this.started += 1;
    }

    stop() {
      this.stopped += 1;
    }

    emit(sessionId, state, event, extra) {
      return this.callback(sessionId, state, event, extra);
    }
  };
}

describe("agent-runtime-main", () => {
  it("keeps Codex monitor ownership and agent deferred wrappers out of main", () => {
    const mainSource = fs.readFileSync(path.join(SRC_DIR, "main.js"), "utf8");

    assert.match(mainSource, /createAgentRuntimeMain/);
    assert.ok(!mainSource.includes("_codexMonitor"));
    assert.ok(!mainSource.includes("CODEX_LOG_EVENTS_COVERED_BY_OFFICIAL_HOOKS"));
    assert.ok(!mainSource.includes("function _deferredStartMonitorForAgent"));
    assert.ok(!mainSource.includes("function _deferredDismissPermissionsByAgent"));
  });

  it("marks official Codex sessions and suppresses covered JSONL events until the TTL expires", () => {
    let currentTime = 1000;
    const updates = [];
    const runtime = createAgentRuntimeMain({
      now: () => currentTime,
      updateSession: (...args) => updates.push(args),
      codexSubagentClassifier: {},
    });

    runtime.updateSessionFromServer("codex-1", "working", "event_msg:task_started", {
      agentId: "codex",
      hookSource: "codex-official",
    });

    assert.deepStrictEqual(updates, [[
      "codex-1",
      "working",
      "event_msg:task_started",
      { agentId: "codex", hookSource: "codex-official" },
    ]]);
    assert.equal(
      runtime.shouldSuppressCodexLogEvent("codex-1", "working", "event_msg:guardian_assessment"),
      true
    );
    assert.equal(
      runtime.shouldSuppressCodexLogEvent("codex-1", "codex-permission", "response_item:function_call"),
      true
    );
    assert.equal(
      runtime.shouldSuppressCodexLogEvent("codex-1", "working", "event_msg:context_compacted"),
      false
    );

    currentTime += createAgentRuntimeMain.CODEX_OFFICIAL_LOG_SUPPRESS_TTL_MS + 1;
    assert.equal(
      runtime.shouldSuppressCodexLogEvent("codex-1", "working", "event_msg:guardian_assessment"),
      false
    );
  });

  it("lets JSONL token_count update official-hook Codex session metadata during suppression", () => {
    let currentTime = 1000;
    const instances = [];
    const calls = [];
    const FakeMonitor = makeFakeMonitorClass(instances);
    const runtime = createAgentRuntimeMain({
      now: () => currentTime,
      loadCodexLogMonitor: () => FakeMonitor,
      loadCodexAgent: () => ({ id: "codex" }),
      isAgentEnabled: (agentId) => agentId === "codex",
      updateSession: (...args) => calls.push(["update", ...args]),
      clearCodexNotifyBubbles: (...args) => calls.push(["clear", ...args]),
      codexSubagentClassifier: {},
    });
    const monitor = runtime.startCodexLogMonitor();

    runtime.updateSessionFromServer("codex:abc", "working", "UserPromptSubmit", {
      agentId: "codex",
      hookSource: "codex-official",
    });

    monitor.emit("codex:abc", "idle", "event_msg:task_complete", {
      cwd: "D:\\repo",
      contextUsage: {
        used: 49961,
        limit: 258400,
        percent: 19,
        source: "codex",
      },
    });

    assert.deepStrictEqual(calls, [
      ["update", "codex:abc", "working", "UserPromptSubmit", {
        agentId: "codex",
        hookSource: "codex-official",
      }],
      ["update", "codex:abc", "idle", "event_msg:task_complete", {
        cwd: "D:\\repo",
        agentId: "codex",
        sessionTitle: undefined,
        contextUsage: {
          used: 49961,
          limit: 258400,
          percent: 19,
          source: "codex",
        },
        headless: false,
        preserveState: true,
      }],
    ]);
  });

  it("handles JSONL token_count as metadata without clearing bubbles or changing state", () => {
    const instances = [];
    const calls = [];
    const FakeMonitor = makeFakeMonitorClass(instances);
    const runtime = createAgentRuntimeMain({
      loadCodexLogMonitor: () => FakeMonitor,
      loadCodexAgent: () => ({ id: "codex" }),
      isAgentEnabled: (agentId) => agentId === "codex",
      updateSession: (...args) => calls.push(["update", ...args]),
      clearCodexNotifyBubbles: (...args) => calls.push(["clear", ...args]),
      codexSubagentClassifier: {},
    });
    const monitor = runtime.startCodexLogMonitor();

    monitor.emit("codex:abc", "working", "event_msg:token_count", {
      cwd: "D:\\repo",
      contextUsage: {
        used: 23959,
        limit: 258400,
        percent: 9,
        source: "codex",
      },
    });

    assert.deepStrictEqual(calls, [
      ["update", "codex:abc", "working", "event_msg:token_count", {
        cwd: "D:\\repo",
        agentId: "codex",
        sessionTitle: undefined,
        contextUsage: {
          used: 23959,
          limit: 258400,
          percent: 9,
          source: "codex",
        },
        headless: false,
        preserveState: true,
      }],
    ]);
  });

  it("maps Codex JSONL monitor permission and state callbacks through the main runtime effects", () => {
    const instances = [];
    const calls = [];
    const classifier = { classify: () => null };
    const FakeMonitor = makeFakeMonitorClass(instances);
    const runtime = createAgentRuntimeMain({
      loadCodexLogMonitor: () => FakeMonitor,
      loadCodexAgent: () => ({ id: "codex" }),
      codexSubagentClassifier: classifier,
      isAgentEnabled: (agentId) => agentId === "codex",
      updateSession: (...args) => calls.push(["update", ...args]),
      showCodexNotifyBubble: (...args) => calls.push(["notify", ...args]),
      clearCodexNotifyBubbles: (...args) => calls.push(["clear", ...args]),
    });

    const monitor = runtime.startCodexLogMonitor();

    assert.equal(monitor, instances[0]);
    assert.equal(monitor.started, 1);
    assert.deepStrictEqual(monitor.agent, { id: "codex" });
    assert.equal(monitor.options.classifier, classifier);

    monitor.emit("sid", "codex-permission", "event_msg:exec_command_end", {
      cwd: "D:\\repo",
      sessionTitle: "Run tests",
      headless: true,
      permissionDetail: { command: "npm test" },
    });
    monitor.emit("sid", "working", "response_item:web_search_call", {
      cwd: "D:\\repo",
      sessionTitle: "Run tests",
      headless: true,
    });

    assert.deepStrictEqual(calls, [
      ["update", "sid", "notification", "event_msg:exec_command_end", {
        cwd: "D:\\repo",
        agentId: "codex",
        sessionTitle: "Run tests",
      }],
      ["notify", { sessionId: "sid", command: "npm test" }],
      ["clear", "sid", "codex-state-transition:working"],
      ["update", "sid", "working", "response_item:web_search_call", {
        cwd: "D:\\repo",
        agentId: "codex",
        sessionTitle: "Run tests",
        headless: true,
      }],
    ]);
  });

  it("starts and stops the Codex monitor through agent gate hooks and cleanup", () => {
    const instances = [];
    const FakeMonitor = makeFakeMonitorClass(instances);
    const runtime = createAgentRuntimeMain({
      loadCodexLogMonitor: () => FakeMonitor,
      loadCodexAgent: () => ({ id: "codex" }),
      codexSubagentClassifier: {},
      isAgentEnabled: () => false,
    });

    const monitor = runtime.startCodexLogMonitor();

    assert.equal(monitor.started, 0);
    runtime.startMonitorForAgent("claude-code");
    runtime.stopMonitorForAgent("claude-code");
    assert.equal(monitor.started, 0);
    assert.equal(monitor.stopped, 0);

    runtime.startMonitorForAgent("codex");
    runtime.stopMonitorForAgent("codex");
    runtime.cleanup();

    assert.equal(monitor.started, 1);
    assert.equal(monitor.stopped, 2);
  });

  it("delegates integration repair and sync calls to the server when available", () => {
    const calls = [];
    const runtime = createAgentRuntimeMain({
      codexSubagentClassifier: {},
      getServer: () => ({
        syncIntegrationForAgent: (agentId) => {
          calls.push(["sync", agentId]);
          return "synced";
        },
        repairIntegrationForAgent: (agentId, options) => {
          calls.push(["repair", agentId, options]);
          return "repaired";
        },
        stopIntegrationForAgent: (agentId) => {
          calls.push(["stop", agentId]);
          return "stopped";
        },
      }),
    });
    const missingServerRuntime = createAgentRuntimeMain({
      codexSubagentClassifier: {},
      getServer: () => null,
    });

    assert.equal(runtime.syncIntegrationForAgent("codex"), "synced");
    assert.equal(runtime.repairIntegrationForAgent("codex", { force: true }), "repaired");
    assert.equal(runtime.stopIntegrationForAgent("codex"), "stopped");
    assert.deepStrictEqual(calls, [
      ["sync", "codex"],
      ["repair", "codex", { force: true }],
      ["stop", "codex"],
    ]);
    assert.equal(missingServerRuntime.syncIntegrationForAgent("codex"), false);
    assert.equal(missingServerRuntime.repairIntegrationForAgent("codex"), false);
    assert.equal(missingServerRuntime.stopIntegrationForAgent("codex"), false);
  });

  it("clears sessions and releases Kimi permission state when an agent is disabled", () => {
    const calls = [];
    const runtime = createAgentRuntimeMain({
      codexSubagentClassifier: {},
      getPermissionRuntime: () => ({
        dismissPermissionsByAgent: (agentId) => {
          calls.push(["dismiss", agentId]);
          return 3;
        },
      }),
      getStateRuntime: () => ({
        clearSessionsByAgent: (agentId) => {
          calls.push(["clear", agentId]);
          return 2;
        },
        disposeAllKimiPermissionState: () => {
          calls.push(["disposeKimi"]);
          return true;
        },
        resolveDisplayState: () => {
          calls.push(["resolve"]);
          return "idle";
        },
        getSvgOverride: (state) => `svg:${state}`,
        setState: (state, svg) => calls.push(["setState", state, svg]),
      }),
    });

    assert.equal(runtime.clearSessionsByAgent("kimi-cli"), 2);
    assert.equal(runtime.dismissPermissionsByAgent("kimi-cli"), 3);
    assert.deepStrictEqual(calls, [
      ["clear", "kimi-cli"],
      ["dismiss", "kimi-cli"],
      ["disposeKimi"],
      ["resolve"],
      ["setState", "idle", "svg:idle"],
    ]);
  });
});
