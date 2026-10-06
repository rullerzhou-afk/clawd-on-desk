"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  assessWindowsProcessChainRequest,
  buildShadowComparison,
  createServerWindowsProcessMetadataResolver,
  normalizeHookPidHeader,
  normalizeInstanceGeneration,
  normalizeWindowsProcessChainMode,
  processMetadataForState,
} = require("../src/server-windows-process-metadata");

function time(low) {
  return { high: 1, low };
}

function queryFrom(entries, calls = []) {
  return (pid) => {
    calls.push(pid);
    const entry = entries.get(pid);
    return entry
      ? { ok: true, status: "ok", pid, ...entry }
      : { ok: false, status: "unavailable", errorKind: "not-found" };
  };
}

function codexGraph() {
  return new Map([
    [100, { parentPid: 90, name: "node.exe", creationTime: time(100) }],
    [90, { parentPid: 80, name: "codex.exe", creationTime: time(90) }],
    [80, { parentPid: 70, name: "pwsh.exe", creationTime: time(80) }],
    [70, { parentPid: 60, name: "code.exe", creationTime: time(70) }],
    [60, { parentPid: 50, name: "code.exe", creationTime: time(60) }],
    [50, { parentPid: 4, name: "explorer.exe", creationTime: time(50) }],
  ]);
}

describe("server-windows-process-metadata", () => {
  it("reproduces nearest agent/editor, outermost terminal, and boundary chain semantics", () => {
    const calls = [];
    const resolve = createServerWindowsProcessMetadataResolver({
      queryProcess: queryFrom(codexGraph(), calls),
      now: () => 10,
    });
    const result = resolve({ agentId: "codex", hookPid: 100 });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.agentPid, 90);
    assert.strictEqual(result.sourcePid, 60);
    assert.strictEqual(result.stablePid, 60);
    assert.strictEqual(result.terminalPid, 60);
    assert.strictEqual(result.editor, "code");
    assert.deepStrictEqual(result.pidChain, [90, 80, 70, 60, 50]);
    assert.deepStrictEqual(calls, [100, 90, 80, 70, 60, 50]);
  });

  it("applies Codex Desktop preferAgentPid after the same raw walk", () => {
    const resolve = createServerWindowsProcessMetadataResolver({ queryProcess: queryFrom(codexGraph()) });
    const result = resolve({ agentId: "codex", hookPid: 100, preferAgentPid: true });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.sourcePid, 90);
    assert.strictEqual(result.stablePid, 60);
  });

  it("keeps the outermost terminal as stable/source when non-terminal launchers remain outside it", () => {
    const graph = new Map([
      [100, { parentPid: 90, name: "node.exe", creationTime: time(100) }],
      [90, { parentPid: 80, name: "cmd.exe", creationTime: time(90) }],
      [80, { parentPid: 70, name: "codex.exe", creationTime: time(80) }],
      [70, { parentPid: 60, name: "node.exe", creationTime: time(70) }],
      [60, { parentPid: 50, name: "pwsh.exe", creationTime: time(60) }],
      [50, { parentPid: 40, name: "code.exe", creationTime: time(50) }],
      [40, { parentPid: 30, name: "code.exe", creationTime: time(40) }],
      [30, { parentPid: 20, name: "launcher.exe", creationTime: time(30) }],
      [20, { parentPid: 0, name: "launcher-svc.exe", creationTime: time(20) }],
    ]);
    const resolve = createServerWindowsProcessMetadataResolver({ queryProcess: queryFrom(graph) });
    const result = resolve({ agentId: "codex", hookPid: 100 });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.terminalPid, 40);
    assert.strictEqual(result.stablePid, 40);
    assert.strictEqual(result.sourcePid, 40);
    assert.deepStrictEqual(result.pidChain, [90, 80, 70, 60, 50, 40, 30, 20]);
  });

  it("fails closed when the expected adapter executable is missing", () => {
    const resolve = createServerWindowsProcessMetadataResolver({ queryProcess: queryFrom(codexGraph()) });
    const result = resolve({ agentId: "kiro-cli", hookPid: 100 });
    assert.strictEqual(result.status, "unavailable");
    assert.strictEqual(result.reason, "expected-agent-missing");
    assert.strictEqual(result.sourcePid, null);
  });

  it("does not accept a partial chain even when the expected agent was already seen", () => {
    const graph = new Map([
      [100, { parentPid: 90, name: "node.exe", creationTime: time(100) }],
      [90, { parentPid: 80, name: "codex.exe", creationTime: time(90) }],
    ]);
    const resolve = createServerWindowsProcessMetadataResolver({ queryProcess: queryFrom(graph) });
    const result = resolve({ agentId: "codex", hookPid: 100 });
    assert.strictEqual(result.status, "unavailable");
    assert.strictEqual(result.reason, "ancestor-query-failed");
    assert.strictEqual(result.comparisonClass, "intentional-stricter-partial-failure");
    assert.strictEqual(result.agentSeenBeforeFailure, true);
    assert.strictEqual(result.failureStage, "ancestor");
    assert.strictEqual(result.errorKind, "not-found");
  });

  it("classifies a partial failure before the expected agent outside the comparable set", () => {
    const graph = new Map([
      [100, { parentPid: 90, name: "node.exe", creationTime: time(100) }],
      [90, { parentPid: 80, name: "cmd.exe", creationTime: time(90) }],
    ]);
    const resolve = createServerWindowsProcessMetadataResolver({ queryProcess: queryFrom(graph) });
    const result = resolve({ agentId: "codex", hookPid: 100 });
    assert.strictEqual(result.status, "unavailable");
    assert.strictEqual(result.comparisonClass, "unavailable-before-agent");
    assert.strictEqual(result.agentSeenBeforeFailure, false);
    assert.strictEqual(result.failureStage, "ancestor");
  });

  it("keeps Cursor's adapter-level editor fallback separate from raw walk editor", () => {
    const graph = new Map([
      [100, { parentPid: 90, name: "node.exe", creationTime: time(100) }],
      [90, { parentPid: 1, name: "cursor.exe", creationTime: time(90) }],
    ]);
    const resolve = createServerWindowsProcessMetadataResolver({ queryProcess: queryFrom(graph) });
    const result = resolve({ agentId: "cursor-agent", hookPid: 100 });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.rawEditor, "cursor");
    assert.strictEqual(result.editor, "cursor");
  });

  it("keeps CodeBuddy raw editor diagnostics outside the effective route allowlist", () => {
    const query = queryFrom(new Map([
      [100, { parentPid: 90, name: "node.exe", creationTime: time(100) }],
      [90, { parentPid: 80, name: "codebuddy.exe", creationTime: time(90) }],
      [80, { parentPid: 1, name: "pwsh.exe", creationTime: time(80) }],
    ]));
    const resolver = createServerWindowsProcessMetadataResolver({ queryProcess: query, now: () => 10 });
    const result = resolver({ agentId: "codebuddy", hookPid: 100 });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.rawEditor, "codebuddy");
    assert.strictEqual(result.editor, "codebuddy");
    assert.strictEqual(processMetadataForState(result).editor, null);
  });

  it("validates hook PID, generation, and per-agent modes", () => {
    assert.strictEqual(normalizeHookPidHeader("1"), 1);
    assert.strictEqual(normalizeHookPidHeader("4294967295"), 0xffffffff);
    for (const invalid of ["", "0", "-1", "1.2", "1e2", "4294967296", ["12", "13"]]) {
      assert.strictEqual(normalizeHookPidHeader(invalid), null);
    }
    assert.strictEqual(normalizeInstanceGeneration("abc_DEF-123"), "abc_DEF-123");
    assert.strictEqual(normalizeInstanceGeneration(""), null);
    assert.strictEqual(normalizeInstanceGeneration("bad value"), null);
    assert.strictEqual(normalizeWindowsProcessChainMode("shadow"), "shadow");
    assert.strictEqual(normalizeWindowsProcessChainMode("b1a-authoritative"), "b1a-authoritative");
    assert.strictEqual(normalizeWindowsProcessChainMode("unknown"), "legacy");
  });

  it("requires matching local instance and effective source boundaries", () => {
    const runtime = {
      version: 1,
      instanceGeneration: "generation-1",
      agents: { codex: "b1a-authoritative" },
    };
    const base = {
      isWinHost: true,
      remoteProfile: null,
      agentId: "codex",
      runtime,
      hookPidHeader: "4242",
      instanceGeneration: "generation-1",
      effectiveHost: null,
      effectiveWslDistro: null,
      effectivePlatform: null,
      effectiveHeadless: false,
    };
    assert.deepStrictEqual(assessWindowsProcessChainRequest(base), {
      eligible: true, reason: null, mode: "b1a-authoritative", hookPid: 4242,
    });
    for (const [field, value, reason] of [
      ["isWinHost", false, "off-windows"],
      ["remoteProfile", { profileId: "p" }, "remote-profile"],
      ["instanceGeneration", "other", "instance-mismatch"],
      ["effectiveHost", "remote", "remote-host"],
      ["effectiveWslDistro", "Ubuntu", "wsl"],
      ["effectivePlatform", "webui", "webui"],
      ["effectiveHeadless", true, "headless"],
      ["hookPidHeader", "1e3", "invalid-hook-pid"],
    ]) {
      const result = assessWindowsProcessChainRequest({ ...base, [field]: value });
      assert.strictEqual(result.eligible, false, field);
      assert.strictEqual(result.reason, reason, field);
    }
  });

  it("builds a four-field shadow comparison without mutating either input", () => {
    const legacy = { sourcePid: 60, agentPid: 90, pidChain: [90, 60], editor: "code" };
    const candidate = { status: "ok", sourcePid: 60, agentPid: 90, pidChain: [90, 60], editor: "code" };
    assert.deepStrictEqual(buildShadowComparison(legacy, candidate), {
      sourcePid: true,
      agentPid: true,
      pidChain: true,
      editor: true,
      all: true,
    });
    assert.deepStrictEqual(legacy.pidChain, [90, 60]);
  });
});
