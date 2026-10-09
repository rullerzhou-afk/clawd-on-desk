"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const themeLoader = require("../src/theme-loader");
const { createRecapRuntime } = require("../src/recap-runtime");
const { createMemoryRecapSink } = require("../src/recap-sink");

themeLoader.init(path.join(__dirname, "..", "src"));
const theme = themeLoader.loadTheme("clawd");

function makeRuntime(options = {}) {
  const sink = options.sink || createMemoryRecapSink();
  const effects = { renderer: [], sounds: [] };
  const ctx = {
    lang: "en",
    theme,
    doNotDisturb: false,
    miniTransitioning: false,
    miniMode: false,
    mouseOverPet: false,
    idlePaused: false,
    forceEyeResend: false,
    eyePauseUntil: 0,
    mouseStillSince: Date.now(),
    miniSleepPeeked: false,
    playSound: (...args) => effects.sounds.push(args),
    sendToRenderer: (...args) => effects.renderer.push(args),
    syncHitWin: () => {},
    sendToHitWin: () => {},
    miniPeekIn: () => {},
    miniPeekOut: () => {},
    buildContextMenu: () => {},
    buildTrayMenu: () => {},
    pendingPermissions: [],
    resolvePermissionEntry: () => {},
    dismissPermissionsForDnd: () => {},
    focusTerminalWindow: () => {},
    focusHostPlatform: "darwin",
    processKill: () => { const error = new Error("ESRCH"); error.code = "ESRCH"; throw error; },
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    recapSink: sink,
    isAgentEnabled: options.isAgentEnabled || (() => true),
    isAgentPermissionsEnabled: options.isAgentPermissionsEnabled,
  };
  return { api: require("../src/state")(ctx), sink, effects };
}

function send(api, event, state, options = {}) {
  api.updateSession(options.sessionId || "session-1", state, event, {
    agentId: options.agentId || "claude-code",
    profileId: options.profileId || "local",
    rawSessionId: options.rawSessionId || "raw-session-1",
    host: options.host || null,
    wslDistro: options.wslDistro || null,
    sessionStartSource: options.sessionStartSource || null,
    recapBoundary: options.recapBoundary || null,
    recapIsSubagent: options.recapIsSubagent === true,
    toolUseId: options.toolUseId || null,
    subagentId: options.subagentId || null,
    subagentType: options.subagentType || null,
    headless: options.headless === true,
    assistantLastOutput: options.assistantLastOutput || null,
    ...(Object.prototype.hasOwnProperty.call(options, "recapOccurredAt")
      ? { recapOccurredAt: options.recapOccurredAt }
      : {}),
    recapDedupeId: options.recapDedupeId || null,
    recapSuppressed: options.recapSuppressed === true,
    hookSource: options.hookSource || null,
  });
}

describe("recap accepted ingress", () => {
  it("records fresh starts, tools and accepted completion without content fields", () => {
    const { api, sink } = makeRuntime();
    try {
      send(api, "SessionStart", "idle", { sessionStartSource: "startup", recapOccurredAt: 1001 });
      send(api, "PreToolUse", "working", { toolUseId: "tool-secret", recapOccurredAt: 1002 });
      send(api, "Stop", "attention", { assistantLastOutput: "private answer", recapOccurredAt: 1003 });
      send(api, "Stop", "attention", { assistantLastOutput: "private answer", recapOccurredAt: 1004 });
      assert.deepStrictEqual(sink.snapshot().map((event) => event.metrics), [
        ["activity", "session-start"],
        ["activity", "tool-call"],
        ["activity", "turn-complete"],
      ]);
      const serialized = JSON.stringify(sink.snapshot());
      for (const forbidden of ["raw-session-1", "tool-secret", "private answer", "cwd", "toolName"]) {
        assert.strictEqual(serialized.includes(forbidden), false);
      }
    } finally {
      api.cleanup();
    }
  });

  it("confirms Claude starts only after later activity with the same raw id", () => {
    const { api, sink } = makeRuntime();
    try {
      send(api, "SessionStart", "idle", {
        sessionId: "resume-real",
        rawSessionId: "resume-real",
        sessionStartSource: "startup",
        recapOccurredAt: 5001,
      });
      send(api, "SessionStart", "idle", {
        sessionId: "resume-phantom",
        rawSessionId: "resume-phantom",
        sessionStartSource: "startup",
        recapOccurredAt: 5002,
      });
      assert.deepStrictEqual(sink.snapshot(), []);

      send(api, "UserPromptSubmit", "thinking", {
        sessionId: "resume-real",
        rawSessionId: "resume-real",
        recapOccurredAt: 5003,
      });
      assert.deepStrictEqual(sink.snapshot().map((event) => ({
        occurredAt: event.occurredAt,
        metrics: event.metrics,
      })), [
        { occurredAt: 5001, metrics: ["activity", "session-start"] },
        { occurredAt: 5003, metrics: ["activity"] },
      ]);
      assert.equal(sink.snapshot().some((event) => event.occurredAt === 5002), false);
    } finally {
      api.cleanup();
    }
  });

  it("keeps a provisional Claude start until delayed real activity confirms it", () => {
    const { api, sink } = makeRuntime();
    const originalNow = Date.now;
    let clock = originalNow();
    Date.now = () => clock;
    try {
      send(api, "SessionStart", "idle", {
        sessionId: "delayed-real",
        rawSessionId: "delayed-real",
        sessionStartSource: "startup",
        recapOccurredAt: 6001,
      });
      assert.deepStrictEqual(sink.snapshot(), []);

      clock += 11 * 60 * 1000;
      send(api, "UserPromptSubmit", "thinking", {
        sessionId: "delayed-real",
        rawSessionId: "delayed-real",
        recapOccurredAt: 6002,
      });
      assert.deepStrictEqual(sink.snapshot().map((event) => ({
        occurredAt: event.occurredAt,
        metrics: event.metrics,
      })), [
        { occurredAt: 6001, metrics: ["activity", "session-start"] },
        { occurredAt: 6002, metrics: ["activity"] },
      ]);
    } finally {
      Date.now = originalNow;
      api.cleanup();
    }
  });

  it("keeps permission provenance as activity but not a QwenWork tool", () => {
    const { api, sink } = makeRuntime();
    try {
      send(api, "PreToolUse", "working", {
        agentId: "qwenwork",
        recapBoundary: "permission",
      });
      assert.deepStrictEqual(sink.snapshot()[0].metrics, ["activity"]);
    } finally {
      api.cleanup();
    }
  });

  it("does not emit for disabled agents or untrusted remote Codex JSONL", () => {
    const disabled = makeRuntime({ isAgentEnabled: () => false });
    try {
      send(disabled.api, "PreToolUse", "working");
      assert.deepStrictEqual(disabled.sink.snapshot(), []);
    } finally {
      disabled.api.cleanup();
    }

    const remoteCodex = makeRuntime();
    try {
      send(remoteCodex.api, "event_msg:task_complete", "attention", {
        agentId: "codex",
        profileId: "remote-profile",
        host: "private-host",
        recapOccurredAt: 2001,
        hookSource: "codex-jsonl",
      });
      assert.deepStrictEqual(remoteCodex.sink.snapshot(), []);
    } finally {
      remoteCodex.api.cleanup();
    }
  });

  it("accepts timestamped remote Codex official hooks", () => {
    const { api, sink } = makeRuntime();
    try {
      send(api, "PreToolUse", "working", {
        agentId: "codex",
        profileId: "remote-profile",
        host: "private-host",
        recapOccurredAt: 2101,
        recapDedupeId: "remote-tool-1",
        hookSource: "codex-official",
      });
      send(api, "Stop", "attention", {
        agentId: "codex",
        profileId: "remote-profile",
        host: "private-host",
        recapOccurredAt: 2102,
        recapDedupeId: "remote-turn-1",
        hookSource: "codex-official",
      });
      assert.deepStrictEqual(sink.snapshot().map((event) => event.metrics), [
        ["activity", "tool-call"],
        ["activity", "turn-complete"],
      ]);
      assert.ok(sink.snapshot().every((event) => event.scope === "remote"));
    } finally {
      api.cleanup();
    }
  });

  it("keeps trusted subagent completions as activity only", () => {
    const { api, sink } = makeRuntime();
    try {
      send(api, "Stop", "attention", {
        agentId: "deepseek-harness",
        recapIsSubagent: true,
      });
      assert.deepStrictEqual(sink.snapshot().map((event) => event.metrics), [["activity"]]);
    } finally {
      api.cleanup();
    }
  });

  it("counts a remapped Kimi PreToolUse exactly as a tool call", () => {
    const sink = createMemoryRecapSink({ captureEphemeralIdentity: true });
    const { api } = makeRuntime({ sink });
    try {
      send(api, "PermissionRequest", "notification", {
        agentId: "kimi-cli",
        recapBoundary: "tool-call",
        toolUseId: "kimi-call-1",
      });
      assert.deepStrictEqual(sink.snapshot()[0].metrics, ["activity", "tool-call"]);
      assert.strictEqual(sink.identitySnapshot()[0].dedupeId, "tool-call:kimi-call-1");
    } finally {
      api.cleanup();
    }
  });

  it("keeps Kimi tool observation independent from its permission bubble", () => {
    const sink = createMemoryRecapSink({ captureEphemeralIdentity: true });
    const { api, effects } = makeRuntime({
      sink,
      isAgentPermissionsEnabled: () => false,
    });
    try {
      send(api, "PermissionRequest", "notification", {
        agentId: "kimi-cli",
        sessionId: "kimi-remapped",
        recapBoundary: "tool-call",
        toolUseId: "kimi-call-off",
      });
      assert.deepStrictEqual(sink.snapshot()[0].metrics, ["activity", "tool-call"]);
      assert.strictEqual(sink.identitySnapshot()[0].dedupeId, "tool-call:kimi-call-off");
      assert.strictEqual(api.sessions.has("kimi-remapped"), false);
      assert.deepStrictEqual(effects.renderer, []);
      assert.deepStrictEqual(effects.sounds, []);

      sink.clear();
      send(api, "PermissionRequest", "notification", {
        agentId: "kimi-cli",
        sessionId: "kimi-native",
        toolUseId: "native-permission-id",
      });
      assert.deepStrictEqual(sink.snapshot()[0].metrics, ["activity"]);
      assert.strictEqual(sink.identitySnapshot()[0].dedupeId, undefined);
    } finally {
      api.cleanup();
    }
  });

  it("classifies WSL and remote profiles without exposing their identities", () => {
    const wslSink = createMemoryRecapSink({ captureEphemeralIdentity: true });
    const wsl = makeRuntime({ sink: wslSink });
    try {
      send(wsl.api, "PreToolUse", "working", {
        agentId: "qwen-code",
        profileId: "local",
        host: "wsl:Ubuntu",
        wslDistro: "Ubuntu",
      });
      assert.strictEqual(wslSink.snapshot()[0].scope, "wsl");
      assert.strictEqual(wslSink.identitySnapshot()[0].scopeId, "Ubuntu");
      assert.strictEqual(JSON.stringify(wslSink.snapshot()).includes("Ubuntu"), false);
    } finally {
      wsl.api.cleanup();
    }

    const wslCodex = makeRuntime();
    try {
      send(wslCodex.api, "PreToolUse", "working", {
        agentId: "codex",
        profileId: "local",
        host: "wsl:Ubuntu",
        wslDistro: "Ubuntu",
      });
      assert.deepStrictEqual(wslCodex.sink.snapshot().map((event) => ({
        scope: event.scope,
        metrics: event.metrics,
      })), [{
        scope: "wsl",
        metrics: ["activity", "tool-call"],
      }]);
    } finally {
      wslCodex.api.cleanup();
    }

    const remoteSink = createMemoryRecapSink({ captureEphemeralIdentity: true });
    const remote = makeRuntime({ sink: remoteSink });
    try {
      send(remote.api, "PreToolUse", "working", {
        agentId: "qwen-code",
        profileId: "profile-a",
        host: "shared-host",
      });
      assert.strictEqual(remoteSink.snapshot()[0].scope, "remote");
      assert.strictEqual(remoteSink.identitySnapshot()[0].scopeId, "profile-a");
      assert.strictEqual(JSON.stringify(remoteSink.snapshot()).includes("profile-a"), false);
      assert.strictEqual(JSON.stringify(remoteSink.snapshot()).includes("shared-host"), false);
    } finally {
      remote.api.cleanup();
    }
  });

  it("uses trusted Codex JSONL time and drops JSONL lifecycle without it", () => {
    const { api, sink } = makeRuntime();
    try {
      send(api, "response_item:function_call", "working", {
        agentId: "codex",
        recapOccurredAt: 345678,
        toolUseId: "call-1",
      });
      assert.deepStrictEqual(sink.snapshot(), [{
        occurredAt: 345678,
        agentId: "codex",
        scope: "local",
        metrics: ["activity", "tool-call"],
      }]);

      sink.clear();
      send(api, "response_item:function_call", "working", {
        agentId: "codex",
        toolUseId: "call-2",
        recapSuppressed: true,
      });
      assert.deepStrictEqual(sink.snapshot(), []);
    } finally {
      api.cleanup();
    }
  });

  it("records a trusted recap-only Codex boundary without creating or reviving a session", () => {
    const { api, sink } = makeRuntime();
    try {
      assert.equal(api.sessions.size, 0);
      assert.equal(api.recordRecapEventOnly({
        occurredAt: 3101,
        sessionId: "codex:late",
        rawSessionId: "late",
        agentId: "codex",
        profileId: "local",
        event: "response_item:web_search_call",
        toolUseId: "search-late",
        hookSource: "codex-jsonl",
      }), true);
      assert.equal(api.sessions.size, 0);
      assert.deepStrictEqual(sink.snapshot().map((event) => event.metrics), [
        ["activity", "tool-call"],
      ]);
      assert.equal(api.recordRecapEventOnly({
        sessionId: "codex:late",
        agentId: "codex",
        event: "response_item:web_search_call",
      }), false, "receipt time is never invented on the recap-only path");
    } finally {
      api.cleanup();
    }
  });

  it("dedupes generic and dedicated late WebSearch shapes by their stable tool id", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recap-late-search-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const now = Date.UTC(2026, 7, 30, 1);
    const recap = createRecapRuntime({
      root,
      now: () => now,
      getTimeZone: () => "UTC",
      setTimeout: () => ({ unref() {} }),
      clearTimeout: () => {},
    });
    recap.start();
    const { api } = makeRuntime({ sink: recap });
    try {
      for (const [index, event] of [
        "response_item:function_call",
        "response_item:web_search_call",
      ].entries()) {
        api.recordRecapEventOnly({
          occurredAt: now + index,
          sessionId: "codex:late",
          rawSessionId: "late",
          agentId: "codex",
          profileId: "local",
          event,
          toolUseId: "search-shared",
          hookSource: "codex-jsonl",
        });
      }
      await recap.whenReady();
      const row = recap.query("today").days[0].rows[0];
      assert.equal(row.metrics.toolCalls, 1);
      assert.equal(row.metrics.activityEvents, 1);
    } finally {
      api.cleanup();
      recap.dispose();
    }
  });

  it("exposes only genuinely stable dedupe identities to the future ledger", () => {
    const sink = createMemoryRecapSink({ captureEphemeralIdentity: true });
    const { api } = makeRuntime({ sink });
    try {
      send(api, "SessionStart", "idle", {
        sessionId: "claude-start",
        rawSessionId: "raw-start",
        sessionStartSource: "startup",
        recapOccurredAt: 4001,
      });
      send(api, "UserPromptSubmit", "thinking", {
        sessionId: "claude-start",
        rawSessionId: "raw-start",
        recapOccurredAt: 4001,
      });
      send(api, "PreToolUse", "working", {
        sessionId: "claude-tool",
        rawSessionId: "raw-tool",
        toolUseId: "tool-1",
        recapOccurredAt: 4002,
      });
      send(api, "Stop", "attention", {
        sessionId: "claude-complete",
        rawSessionId: "raw-complete",
        recapOccurredAt: 4003,
      });
      send(api, "Stop", "attention", {
        agentId: "codex",
        sessionId: "codex-complete",
        rawSessionId: "raw-codex",
        recapDedupeId: "turn-1",
        recapOccurredAt: 4004,
      });

      assert.deepStrictEqual(sink.identitySnapshot().map((identity) => identity.dedupeId), [
        "session-start:raw-start",
        undefined,
        "tool-call:tool-1",
        undefined,
        "turn-complete:turn-1",
      ]);
    } finally {
      api.cleanup();
    }
  });

  it("does not count a cancelled Claude Stop or a subagent Stop as a completed turn", () => {
    const { api, sink } = makeRuntime();
    try {
      send(api, "UserPromptSubmit", "thinking", { headless: true });
      sink.clear();
      send(api, "Stop", "attention", {
        headless: true,
        assistantLastOutput: "candidate",
      });
      send(api, "PreToolUse", "working", { headless: true });
      assert.strictEqual(sink.snapshot().some((event) => event.metrics.includes("turn-complete")), false);

      sink.clear();
      send(api, "SubagentStart", "juggling", { subagentId: "child-1" });
      sink.clear();
      send(api, "SubagentStop", "working", { subagentId: "child-1" });
      assert.strictEqual(sink.snapshot().some((event) => event.metrics.includes("turn-complete")), false);
    } finally {
      api.cleanup();
    }
  });
});
