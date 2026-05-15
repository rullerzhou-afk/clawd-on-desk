"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  buildCodexMonitorUpdateOptions,
  isCodexMonitorPermissionEvent,
} = require("../src/codex-monitor-callback");

describe("Codex monitor callback helpers", () => {
  it("identifies JSONL permission events", () => {
    assert.strictEqual(isCodexMonitorPermissionEvent("codex-permission"), true);
    assert.strictEqual(isCodexMonitorPermissionEvent("working"), false);
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

  it("omits headless for permission update options", () => {
    const options = buildCodexMonitorUpdateOptions({
      cwd: "/repo",
      sessionTitle: "Approval",
      headless: true,
    }, { includeHeadless: false });

    assert.deepStrictEqual(options, {
      cwd: "/repo",
      agentId: "codex",
      sessionTitle: "Approval",
    });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(options, "headless"), false);
  });
});
