"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createIntegrationSyncRuntime } = require("../src/integration-sync");

function makeRuntime(overrides = {}) {
  const calls = [];
  const repairOptions = [];
  const ctx = {
    autoStartWithClaude: true,
    syncClawdHooksImpl: (options) => {
      calls.push({ name: "claude", options });
      return { status: "ok", source: "claude" };
    },
    syncGeminiHooksImpl: () => calls.push({ name: "gemini" }),
    syncCursorHooksImpl: () => calls.push({ name: "cursor" }),
    syncCodeBuddyHooksImpl: () => calls.push({ name: "codebuddy" }),
    syncKiroHooksImpl: () => calls.push({ name: "kiro" }),
    syncKimiHooksImpl: () => calls.push({ name: "kimi" }),
    syncCodexHooksImpl: () => calls.push({ name: "codex" }),
    repairCodexHooksImpl: (options) => {
      calls.push({ name: "codex-repair" });
      repairOptions.push(options);
      return { status: "ok", message: "done" };
    },
    syncOpencodePluginImpl: () => calls.push({ name: "opencode" }),
    syncPiExtensionImpl: () => calls.push({ name: "pi" }),
    syncOpenClawPluginImpl: () => calls.push({ name: "openclaw" }),
    repairOpenClawPluginImpl: () => {
      calls.push({ name: "openclaw-repair" });
      return { status: "ok", message: "done" };
    },
    syncHermesPluginImpl: () => calls.push({ name: "hermes" }),
    ...(overrides.ctx || {}),
  };
  const runtime = createIntegrationSyncRuntime({
    ctx,
    getHookServerPort: () => 24444,
    shouldManageClaudeHooks: () => true,
    isAgentEnabled: () => true,
    startClaudeSettingsWatcher: () => calls.push({ name: "watcher:start" }),
    stopClaudeSettingsWatcher: () => {
      calls.push({ name: "watcher:stop" });
      return "stopped";
    },
    ...overrides,
  });
  return { runtime, calls, repairOptions };
}

describe("integration sync runtime", () => {
  it("syncClawdHooks passes auto-start and the current server port", () => {
    const { runtime, calls } = makeRuntime();

    const result = runtime.syncClawdHooks();

    assert.deepStrictEqual(result, { status: "ok", source: "claude" });
    assert.deepStrictEqual(calls, [
      { name: "claude", options: { autoStart: true, port: 24444 } },
    ]);
  });

  it("startup syncs enabled integrations in the server order and starts the Claude watcher after Claude sync", () => {
    const disabled = new Set(["cursor-agent", "opencode"]);
    const { runtime, calls } = makeRuntime({
      isAgentEnabled: (agentId) => !disabled.has(agentId),
    });

    runtime.syncEnabledStartupIntegrations();

    assert.deepStrictEqual(calls.map((entry) => entry.name), [
      "claude",
      "watcher:start",
      "gemini",
      "codebuddy",
      "kiro",
      "kimi",
      "codex",
      "pi",
      "openclaw",
      "hermes",
    ]);
  });

  it("syncIntegrationForAgent respects Claude management gate", () => {
    const { runtime, calls } = makeRuntime({
      shouldManageClaudeHooks: () => false,
    });

    assert.strictEqual(runtime.syncIntegrationForAgent("claude-code"), false);
    assert.deepStrictEqual(calls, []);
  });

  it("syncIntegrationForAgent starts the Claude watcher after a managed Claude sync", () => {
    const { runtime, calls } = makeRuntime();

    const result = runtime.syncIntegrationForAgent("claude-code");

    assert.deepStrictEqual(result, { status: "ok", source: "claude" });
    assert.deepStrictEqual(calls.map((entry) => entry.name), ["claude", "watcher:start"]);
  });

  it("repairIntegrationForAgent uses Codex repair and passes options through", () => {
    const { runtime, calls, repairOptions } = makeRuntime();

    const result = runtime.repairIntegrationForAgent("codex", { forceCodexHooksFeature: true });

    assert.deepStrictEqual(result, { status: "ok", message: "done" });
    assert.deepStrictEqual(calls.map((entry) => entry.name), ["codex-repair"]);
    assert.deepStrictEqual(repairOptions, [{ forceCodexHooksFeature: true }]);
  });

  it("repairIntegrationForAgent uses OpenClaw repair", () => {
    const { runtime, calls } = makeRuntime();

    const result = runtime.repairIntegrationForAgent("openclaw");

    assert.deepStrictEqual(result, { status: "ok", message: "done" });
    assert.deepStrictEqual(calls.map((entry) => entry.name), ["openclaw-repair"]);
  });

  it("stopIntegrationForAgent only stops the Claude watcher", () => {
    const { runtime, calls } = makeRuntime();

    assert.strictEqual(runtime.stopIntegrationForAgent("codex"), false);
    assert.strictEqual(runtime.stopIntegrationForAgent("claude-code"), "stopped");
    assert.deepStrictEqual(calls.map((entry) => entry.name), ["watcher:stop"]);
  });

  it("does not log Pi extension sync when the managed files are already current", () => {
    const piInstall = require("../hooks/pi-install");
    const originalRegister = piInstall.registerPiExtension;
    const originalLog = console.log;
    const logs = [];
    piInstall.registerPiExtension = () => ({
      installed: true,
      skipped: false,
      updated: false,
      extensionDir: "C:/Users/Tester/.pi/agent/extensions/clawd-on-desk",
    });
    console.log = (message) => logs.push(message);

    try {
      const { runtime } = makeRuntime({ ctx: { syncPiExtensionImpl: undefined } });
      const result = runtime.syncPiExtension();

      assert.strictEqual(result.status, "ok");
      assert.strictEqual(result.installed, true);
      assert.deepStrictEqual(logs, []);
    } finally {
      piInstall.registerPiExtension = originalRegister;
      console.log = originalLog;
    }
  });
});
