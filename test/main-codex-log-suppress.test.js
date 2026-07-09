"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const createAgentRuntimeMain = require("../src/agent-runtime-main");

function makeFakeMonitorClass(instances) {
  return class FakeCodexLogMonitor {
    constructor(agent, callback, options) {
      this.agent = agent;
      this.callback = callback;
      this.options = options;
      instances.push(this);
    }

    start() {}

    stop() {}

    emit(sessionId, state, event, extra) {
      return this.callback(sessionId, state, event, extra);
    }

    emitRaw(sessionId, record, extra) {
      if (this.options && typeof this.options.onCodexRecord === "function") {
        return this.options.onCodexRecord(sessionId, record, extra);
      }
      return undefined;
    }
  };
}

describe("main Codex official hook JSONL suppression", () => {
  it("suppresses guardian_assessment for hook-active Codex sessions", () => {
    assert.ok(
      createAgentRuntimeMain.CODEX_LOG_EVENTS_COVERED_BY_OFFICIAL_HOOKS.has("event_msg:guardian_assessment"),
      "guardian_assessment should not re-drive hook-active Codex sessions from JSONL"
    );
  });

  it("keeps lifecycle suppression while still allowing WavePet raw records through", () => {
    const instances = [];
    const wavePetUpdateCalls = [];
    const fakeWavePetRuntime = {
      processCodexRecord(sessionId, record, meta) {
        return {
          sessionId,
          state: "working",
          event: "wavepet:thinking_stream",
          displayHint: "clawd-working-ultrathink.svg",
          extra: {
            agentId: "codex",
            wavepet: { state: "thinking_stream" },
          },
        };
      },
    };
    const FakeMonitor = makeFakeMonitorClass(instances);
    const runtime = createAgentRuntimeMain({
      loadCodexLogMonitor: () => FakeMonitor,
      loadCodexAgent: () => ({ id: "codex" }),
      wavePetRuntime: fakeWavePetRuntime,
      codexSubagentClassifier: {},
      isAgentEnabled: (agentId) => agentId === "codex",
      updateSession: (...args) => wavePetUpdateCalls.push({
        sessionId: args[0],
        state: args[1],
        event: args[2],
        options: args[3],
      }),
    });
    const monitor = runtime.startCodexLogMonitor();

    runtime.updateSessionFromServer("codex:s1", "working", "response_item:function_call", {
      agentId: "codex",
      hookSource: "codex-official",
    });

    assert.equal(
      runtime.shouldSuppressCodexLogEvent("codex:s1", "working", "response_item:function_call"),
      true
    );

    const callCountAfterOfficialHook = wavePetUpdateCalls.length;

    monitor.emit("codex:s1", "working", "response_item:function_call", {
      cwd: "/repo",
      headless: false,
    });
    monitor.emitRaw("codex:s1", {
      type: "event_msg",
      payload: { type: "agent_message", message: "x ".repeat(700) },
    }, {
      cwd: "/repo",
      headless: false,
    });

    assert.equal(wavePetUpdateCalls.length, callCountAfterOfficialHook + 1);
    assert.equal(
      wavePetUpdateCalls.filter((call) => call.event === "response_item:function_call").length,
      1
    );
    assert.ok(wavePetUpdateCalls.some((call) => call.event.startsWith("wavepet:")));
  });
});
