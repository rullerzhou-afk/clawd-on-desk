"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  buildCodexMonitorSessionOptions,
  normalizeCodexMonitorAccountQuotas,
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

  it("identifies token_count quota-only updates as metadata-only events", () => {
    assert.strictEqual(
      isCodexMonitorMetadataOnlyEvent("event_msg:token_count", {
        codexQuota: { codexFiveHour: { usedPercent: 1 } },
      }),
      true
    );
    assert.strictEqual(
      isCodexMonitorMetadataOnlyEvent("event_msg:token_count", {
        codexSparkQuota: { codexWeekly: { usedPercent: 7 } },
      }),
      true
    );
  });

  it("normalizes generic and Spark quota outside session options", () => {
    const quotas = normalizeCodexMonitorAccountQuotas({
      cwd: "/repo",
      codexQuota: {
        codexFiveHour: { usedPercent: 1.4, resetAt: 1783669570000 },
        codexWeekly: { usedPercent: 43 },
      },
      codexSparkQuota: {
        codexWeekly: { usedPercent: 7.4, windowMinutes: 10080 },
      },
    });
    assert.deepStrictEqual(quotas, {
      codexQuota: {
        codexFiveHour: { usedPercent: 1, resetAt: 1783669570000 },
        codexWeekly: { usedPercent: 43 },
      },
      codexSparkQuota: {
        codexWeekly: { usedPercent: 7, windowMinutes: 10080 },
      },
    });
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(buildCodexMonitorSessionOptions({
        cwd: "/repo",
        codexQuota: quotas.codexQuota,
        codexSparkQuota: quotas.codexSparkQuota,
      }), "codexQuota"),
      false
    );
  });

  it("omits invalid quota groups from account quota updates", () => {
    const quotas = normalizeCodexMonitorAccountQuotas({
      cwd: "/repo",
      codexQuota: { codexFiveHour: { usedPercent: "nope" } },
      codexSparkQuota: { codexWeekly: { usedPercent: "nope" } },
    });
    assert.strictEqual(quotas, null);
  });

  it("passes headless for normal monitor state updates", () => {
    assert.deepStrictEqual(buildCodexMonitorSessionOptions({
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
    assert.deepStrictEqual(buildCodexMonitorSessionOptions({
      cwd: "/repo",
    }, { includeHeadless: true }), {
      cwd: "/repo",
      agentId: "codex",
      sessionTitle: undefined,
      headless: false,
    });
  });

  it("passes Codex Desktop focus metadata from JSONL monitor updates", () => {
    assert.deepStrictEqual(buildCodexMonitorSessionOptions({
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
    assert.deepStrictEqual(buildCodexMonitorSessionOptions({
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
    assert.deepStrictEqual(buildCodexMonitorSessionOptions({
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
    const options = buildCodexMonitorSessionOptions({
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

  it("passes trusted JSONL recap time and ephemeral ids without quota fields", () => {
    assert.deepStrictEqual(buildCodexMonitorSessionOptions({
      cwd: "/repo",
      recapOccurredAt: 1788013260000,
      recapDedupeId: "turn-secret",
      toolUseId: "call-secret",
      syntheticBackfill: true,
    }, { includeHeadless: true, includeRecap: true }), {
      cwd: "/repo",
      agentId: "codex",
      sessionTitle: undefined,
      recapOccurredAt: 1788013260000,
      recapDedupeId: "turn-secret",
      toolUseId: "call-secret",
      recapSuppressed: true,
      headless: false,
    });
  });

  it("marks trusted headless JSONL lifecycle as subagent recap input", () => {
    assert.deepStrictEqual(buildCodexMonitorSessionOptions({
      cwd: "/repo",
      recapOccurredAt: 1788013260000,
      recapDedupeId: "subagent-turn-secret",
      headless: true,
    }, { includeHeadless: true, includeRecap: true }), {
      cwd: "/repo",
      agentId: "codex",
      sessionTitle: undefined,
      recapOccurredAt: 1788013260000,
      recapDedupeId: "subagent-turn-secret",
      recapIsSubagent: true,
      headless: true,
    });
  });
});
