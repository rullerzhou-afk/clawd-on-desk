"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  buildCodexMonitorUpdateOptions,
  isCodexMonitorMetadataOnlyEvent,
} = require("../src/codex-monitor-callback");

describe("Codex monitor callback helpers", () => {
  it("identifies token_count context updates as metadata-only events", () => {
    assert.strictEqual(
      isCodexMonitorMetadataOnlyEvent("event_msg:token_count", {
        contextUsage: { used: 23959, limit: 258400, percent: 9, source: "codex" },
      }),
      true
    );
    assert.strictEqual(isCodexMonitorMetadataOnlyEvent("event_msg:token_count", {}), false);
    assert.strictEqual(
      isCodexMonitorMetadataOnlyEvent("event_msg:task_complete", {
        contextUsage: { used: 23959, source: "codex" },
      }),
      false
    );
  });

  it("passes headless for normal monitor state updates", () => {
    assert.deepStrictEqual(buildCodexMonitorUpdateOptions({
      cwd: "/repo",
      sessionTitle: "Build",
      headless: true,
    }, { includeHeadless: true }), {
      cwd: "/repo",
      agentId: "codex",
      sessionTitle: "Build",
      headless: true,
    });
  });

  it("defaults normal monitor headless to false", () => {
    assert.deepStrictEqual(buildCodexMonitorUpdateOptions({
      cwd: "/repo",
    }, { includeHeadless: true }), {
      cwd: "/repo",
      agentId: "codex",
      sessionTitle: undefined,
      headless: false,
    });
  });

  it("passes Codex Desktop focus metadata from JSONL monitor updates", () => {
    assert.deepStrictEqual(buildCodexMonitorUpdateOptions({
      cwd: "/repo",
      sourcePid: 11,
      agentPid: 22,
      pidChain: [22, 11],
      codexOriginator: "Codex Desktop",
      codexSource: "vscode",
    }, { includeHeadless: true }), {
      cwd: "/repo",
      agentId: "codex",
      sessionTitle: undefined,
      sourcePid: 11,
      agentPid: 22,
      pidChain: [22, 11],
      codexOriginator: "Codex Desktop",
      codexSource: "vscode",
      headless: false,
    });
  });

  it("passes context usage from JSONL monitor updates", () => {
    assert.deepStrictEqual(buildCodexMonitorUpdateOptions({
      cwd: "/repo",
      contextUsage: {
        used: 24846,
        limit: 258400,
        percent: 10,
        source: "codex",
      },
    }, { includeHeadless: true }), {
      cwd: "/repo",
      agentId: "codex",
      sessionTitle: undefined,
      contextUsage: {
        used: 24846,
        limit: 258400,
        percent: 10,
        source: "codex",
      },
      headless: false,
    });
  });

  it("omits invalid context usage from JSONL monitor updates", () => {
    assert.deepStrictEqual(buildCodexMonitorUpdateOptions({
      cwd: "/repo",
      contextUsage: { used: -1, limit: 0, source: "codex" },
    }, { includeHeadless: true }), {
      cwd: "/repo",
      agentId: "codex",
      sessionTitle: undefined,
      headless: false,
    });
  });

  it("omits headless when requested", () => {
    const options = buildCodexMonitorUpdateOptions({
      cwd: "/repo",
      sessionTitle: "State update",
      headless: true,
    }, { includeHeadless: false });

    assert.deepStrictEqual(options, {
      cwd: "/repo",
      agentId: "codex",
      sessionTitle: "State update",
    });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(options, "headless"), false);
  });
});
