"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  createWindowsProcessChainShadowLogger,
  sanitizeShadowRecord,
} = require("../src/windows-process-chain-shadow-log");

describe("windows process-chain shadow log", () => {
  it("keeps only the bounded diagnostic allowlist", () => {
    const safe = sanitizeShadowRecord({
      channel: "state",
      agentId: "codex",
      event: "PreToolUse",
      status: "ok",
      reason: "system-boundary",
      comparisonClass: "intentional-stricter-partial-failure",
      agentSeenBeforeFailure: true,
      failureStage: "ancestor",
      errorKind: "not-found",
      cacheSource: "fresh",
      depth: 4,
      durationMs: 3.7,
      legacyMetadata: { sourcePid: 101, agentPid: 102, pidChain: [101, 102], editor: "code" },
      candidateMetadata: { sourcePid: 201, agentPid: 202, pidChain: [201, 202], editor: "cursor" },
      comparison: { sourcePid: true, agentPid: false, pidChain: true, editor: true, all: false },
      sessionId: "secret-session",
      cwd: "D:\\private",
      payload: { command: "secret" },
    });
    assert.deepStrictEqual({ ...safe, at: "<time>" }, {
      at: "<time>",
      channel: "state",
      agentId: "codex",
      event: "PreToolUse",
      kind: "process-chain",
      status: "ok",
      reason: "system-boundary",
      comparisonClass: "intentional-stricter-partial-failure",
      agentSeenBeforeFailure: true,
      failureStage: "ancestor",
      errorKind: "not-found",
      cacheSource: "fresh",
      depth: 4,
      durationMs: 3,
      legacyMetadata: { sourcePid: 101, agentPid: 102, pidChain: [101, 102], editor: "code" },
      candidateMetadata: { sourcePid: 201, agentPid: 202, pidChain: [201, 202], editor: "cursor" },
      comparison: { sourcePid: true, agentPid: false, pidChain: true, editor: true, all: false },
    });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(safe, "sessionId"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(safe, "cwd"), false);
  });

  it("fail-closes malformed PID diagnostics instead of expanding the log schema", () => {
    const safe = sanitizeShadowRecord({
      channel: "permission",
      agentId: "codex",
      event: "PermissionRequest",
      legacyMetadata: {
        sourcePid: 0,
        agentPid: 0x100000000,
        pidChain: [1, "2"],
        editor: "not allowed whitespace",
        commandLine: "secret",
      },
      candidateMetadata: { sourcePid: 42, agentPid: 43, pidChain: [42, 43], editor: "code" },
    });
    assert.deepStrictEqual(safe.legacyMetadata, {
      sourcePid: null,
      agentPid: null,
      pidChain: null,
      editor: null,
    });
    assert.deepStrictEqual(safe.candidateMetadata, {
      sourcePid: 42,
      agentPid: 43,
      pidChain: [42, 43],
      editor: "code",
    });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(safe.legacyMetadata, "commandLine"), false);
  });

  it("caps samples independently per channel/agent/event/kind", () => {
    const writes = [];
    const log = createWindowsProcessChainShadowLogger({
      filePath: "shadow.log",
      sampleLimit: 2,
      append: (...args) => writes.push(args),
    });
    const record = { channel: "state", agentId: "kiro-cli", event: "preToolUse" };
    assert.strictEqual(log(record), true);
    assert.strictEqual(log(record), true);
    assert.strictEqual(log(record), false);
    assert.strictEqual(log({ ...record, kind: "wt-hwnd" }), true);
    assert.strictEqual(writes.length, 3);
  });
});
