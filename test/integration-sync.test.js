"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createIntegrationSyncRuntime } = require("../src/integration-sync");

function withPatchedExport(modulePath, exportName, replacement, run) {
  const moduleExports = require(modulePath);
  const original = moduleExports[exportName];
  moduleExports[exportName] = replacement;
  try {
    return run();
  } finally {
    moduleExports[exportName] = original;
  }
}

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
    syncAntigravityHooksImpl: () => calls.push({ name: "antigravity" }),
    syncCursorHooksImpl: () => calls.push({ name: "cursor" }),
    syncCopilotHooksImpl: () => calls.push({ name: "copilot" }),
    syncCodeBuddyHooksImpl: () => calls.push({ name: "codebuddy" }),
    syncKiroHooksImpl: () => calls.push({ name: "kiro" }),
    syncKimiHooksImpl: () => calls.push({ name: "kimi" }),
    syncQwenHooksImpl: () => calls.push({ name: "qwen" }),
    syncCodewhaleHooksImpl: () => calls.push({ name: "codewhale" }),
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
    syncQoderHooksImpl: () => calls.push({ name: "qoder" }),
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
      "antigravity",
      "copilot",
      "codebuddy",
      "kiro",
      "kimi",
      "qwen",
      "codewhale",
      "codex",
      "pi",
      "openclaw",
      "hermes",
      "qoder",
    ]);
  });

  it("startup sync uses installed-and-enabled intent instead of enabled alone", () => {
    const uninstalled = new Set(["claude-code", "copilot-cli", "pi"]);
    const { runtime, calls } = makeRuntime({
      isAgentEnabled: () => true,
      shouldSyncAgentIntegration: (agentId) => !uninstalled.has(agentId),
    });

    runtime.syncEnabledStartupIntegrations();

    assert.deepStrictEqual(calls.map((entry) => entry.name), [
      "gemini",
      "antigravity",
      "cursor",
      "codebuddy",
      "kiro",
      "kimi",
      "qwen",
      "codewhale",
      "codex",
      "opencode",
      "openclaw",
      "hermes",
      "qoder",
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

  it("syncIntegrationForAgent('copilot-cli') invokes the Copilot syncer", () => {
    const { runtime, calls } = makeRuntime();

    const result = runtime.syncIntegrationForAgent("copilot-cli");

    assert.ok(result === true || (result && typeof result === "object"));
    assert.deepStrictEqual(calls.map((entry) => entry.name), ["copilot"]);
  });

  it("syncIntegrationForAgent treats count-style zero writes as a missing local integration", () => {
    const cases = [
      {
        agentId: "gemini-cli",
        ctxKey: "syncGeminiHooksImpl",
        modulePath: "../hooks/gemini-install.js",
        exportName: "registerGeminiHooks",
        reason: "gemini-not-installed",
      },
      {
        agentId: "cursor-agent",
        ctxKey: "syncCursorHooksImpl",
        modulePath: "../hooks/cursor-install.js",
        exportName: "registerCursorHooks",
        reason: "cursor-not-installed",
      },
      {
        agentId: "copilot-cli",
        ctxKey: "syncCopilotHooksImpl",
        modulePath: "../hooks/copilot-install.js",
        exportName: "registerCopilotHooks",
        reason: "copilot-not-installed",
      },
      {
        agentId: "codebuddy",
        ctxKey: "syncCodeBuddyHooksImpl",
        modulePath: "../hooks/codebuddy-install.js",
        exportName: "registerCodeBuddyHooks",
        reason: "codebuddy-not-installed",
      },
      {
        agentId: "kiro-cli",
        ctxKey: "syncKiroHooksImpl",
        modulePath: "../hooks/kiro-install.js",
        exportName: "registerKiroHooks",
        reason: "kiro-not-installed",
      },
      {
        agentId: "kimi-cli",
        ctxKey: "syncKimiHooksImpl",
        modulePath: "../hooks/kimi-install.js",
        exportName: "registerKimiHooks",
        reason: "kimi-not-installed",
      },
      {
        agentId: "qwen-code",
        ctxKey: "syncQwenHooksImpl",
        modulePath: "../hooks/qwen-code-install.js",
        exportName: "registerQwenCodeHooks",
        reason: "qwen-not-installed",
      },
      {
        agentId: "codewhale",
        ctxKey: "syncCodewhaleHooksImpl",
        modulePath: "../hooks/codewhale-install.js",
        exportName: "registerCodewhaleHooks",
        reason: "codewhale-not-installed",
      },
      {
        agentId: "codex",
        ctxKey: "syncCodexHooksImpl",
        modulePath: "../hooks/codex-install.js",
        exportName: "registerCodexHooks",
        reason: "codex-not-installed",
      },
      {
        agentId: "qoder",
        ctxKey: "syncQoderHooksImpl",
        modulePath: "../hooks/qoder-install.js",
        exportName: "registerQoderHooks",
        reason: "qoder-not-installed",
      },
      {
        agentId: "reasonix",
        ctxKey: "syncReasonixHooksImpl",
        modulePath: "../hooks/reasonix-install.js",
        exportName: "registerReasonixHooks",
        reason: "reasonix-not-installed",
      },
    ];

    for (const entry of cases) {
      const missing = withPatchedExport(
        entry.modulePath,
        entry.exportName,
        () => ({ added: 0, updated: 0, skipped: 0 }),
        () => {
          const { runtime } = makeRuntime({ ctx: { [entry.ctxKey]: undefined } });
          return runtime.syncIntegrationForAgent(entry.agentId);
        }
      );
      assert.strictEqual(missing.status, "skipped", entry.agentId);
      assert.strictEqual(missing.reason, entry.reason, entry.agentId);

      const alreadyCurrent = withPatchedExport(
        entry.modulePath,
        entry.exportName,
        () => ({ added: 0, updated: 0, skipped: 1 }),
        () => {
          const { runtime } = makeRuntime({ ctx: { [entry.ctxKey]: undefined } });
          return runtime.syncIntegrationForAgent(entry.agentId);
        }
      );
      assert.strictEqual(alreadyCurrent.status, "ok", entry.agentId);
      assert.strictEqual(alreadyCurrent.skipped, 1, entry.agentId);
    }
  });

  it("syncIntegrationForAgent treats installed:false results as skipped", () => {
    const cases = [
      {
        agentId: "antigravity-cli",
        ctxKey: "syncAntigravityHooksImpl",
        modulePath: "../hooks/antigravity-install.js",
        exportName: "registerAntigravityHooks",
        reason: "antigravity-not-installed",
      },
      {
        agentId: "pi",
        ctxKey: "syncPiExtensionImpl",
        modulePath: "../hooks/pi-install.js",
        exportName: "registerPiExtension",
        reason: "pi-not-found",
      },
      {
        agentId: "openclaw",
        ctxKey: "syncOpenClawPluginImpl",
        modulePath: "../hooks/openclaw-install.js",
        exportName: "registerOpenClawPlugin",
        reason: "openclaw-not-found",
      },
    ];

    // antigravity-cli's real syncAntigravityHooks() also calls
    // registerAntigravityStatusline as a side effect. Patch it to a no-op
    // stub too, or this test would hit the real ~/.gemini/antigravity-cli
    // on any machine that has Antigravity CLI installed.
    const runEntry = (entry, run) => (entry.agentId === "antigravity-cli"
      ? withPatchedExport("../hooks/antigravity-install.js", "registerAntigravityStatusline", () => ({ installed: false, changed: false, skippedExisting: false }), run)
      : run());

    for (const entry of cases) {
      const missing = withPatchedExport(
        entry.modulePath,
        entry.exportName,
        () => ({ installed: false, skipped: true, updated: false, reason: entry.reason }),
        () => runEntry(entry, () => {
          const { runtime } = makeRuntime({ ctx: { [entry.ctxKey]: undefined } });
          return runtime.syncIntegrationForAgent(entry.agentId);
        })
      );
      assert.strictEqual(missing.status, "skipped", entry.agentId);
      assert.strictEqual(missing.reason, entry.reason, entry.agentId);

      const alreadyCurrent = withPatchedExport(
        entry.modulePath,
        entry.exportName,
        () => ({ installed: true, skipped: true, updated: false }),
        () => runEntry(entry, () => {
          const { runtime } = makeRuntime({ ctx: { [entry.ctxKey]: undefined } });
          return runtime.syncIntegrationForAgent(entry.agentId);
        })
      );
      assert.strictEqual(alreadyCurrent.status, "ok", entry.agentId);
      assert.strictEqual(alreadyCurrent.installed, true, entry.agentId);
    }

    const unmanagedPi = withPatchedExport(
      "../hooks/pi-install.js",
      "registerPiExtension",
      () => ({
        installed: false,
        skipped: true,
        updated: false,
        reason: "unmanaged-existing-extension",
      }),
      () => {
        const { runtime } = makeRuntime({ ctx: { syncPiExtensionImpl: undefined } });
        return runtime.syncIntegrationForAgent("pi");
      }
    );
    assert.strictEqual(unmanagedPi.status, "skipped");
    assert.strictEqual(unmanagedPi.reason, "unmanaged-existing-extension");
    assert.strictEqual(unmanagedPi.message, "Pi integration sync skipped: unmanaged-existing-extension");
  });

  it("syncIntegrationForAgent distinguishes opencode missing from already registered", () => {
    const missing = withPatchedExport(
      "../hooks/opencode-install.js",
      "registerOpencodePlugin",
      () => ({ added: false, skipped: true, created: false, reason: "opencode-not-found" }),
      () => {
        const { runtime } = makeRuntime({ ctx: { syncOpencodePluginImpl: undefined } });
        return runtime.syncIntegrationForAgent("opencode");
      }
    );

    assert.strictEqual(missing.status, "skipped");
    assert.strictEqual(missing.reason, "opencode-not-found");

    const alreadyCurrent = withPatchedExport(
      "../hooks/opencode-install.js",
      "registerOpencodePlugin",
      () => ({ added: false, skipped: true, created: false }),
      () => {
        const { runtime } = makeRuntime({ ctx: { syncOpencodePluginImpl: undefined } });
        return runtime.syncIntegrationForAgent("opencode");
      }
    );

    assert.strictEqual(alreadyCurrent.status, "ok");
    assert.strictEqual(alreadyCurrent.skipped, true);
  });

  it("syncIntegrationForAgent preserves Hermes not-installed skips", () => {
    const { runtime } = makeRuntime({
      ctx: {
        syncHermesPluginImpl: undefined,
        isHermesInstalledImpl: () => false,
      },
    });

    const result = runtime.syncIntegrationForAgent("hermes");

    assert.strictEqual(result.status, "skipped");
    assert.strictEqual(result.reason, "hermes-not-installed");
  });

  it("repairIntegrationForAgent preserves skipped sync results", () => {
    const { runtime } = makeRuntime({
      ctx: {
        syncGeminiHooksImpl: () => ({
          status: "skipped",
          reason: "gemini-not-installed",
          message: "Gemini CLI missing",
        }),
      },
    });

    const result = runtime.repairIntegrationForAgent("gemini-cli");

    assert.deepStrictEqual(result, {
      status: "skipped",
      reason: "gemini-not-installed",
      message: "Gemini CLI missing",
    });
  });

  it("uninstallIntegrationForAgent routes through the matching marker-scoped cleaner", () => {
    const uninstallCalls = [];
    const { runtime } = makeRuntime({
      ctx: {
        uninstallIntegrationImpls: {
          "copilot-cli": (options) => {
            uninstallCalls.push({ name: "copilot-uninstall", options });
            return { removed: 0, changed: false };
          },
        },
      },
    });

    const result = runtime.uninstallIntegrationForAgent("copilot-cli");

    assert.deepStrictEqual(result, { removed: 0, changed: false });
    assert.deepStrictEqual(uninstallCalls, [{ name: "copilot-uninstall", options: { silent: true } }]);
  });

  it("uninstallIntegrationForAgent passes Codex cleanup markers on the real fallback path", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-cleanup-"));
    try {
      const hooksPath = path.join(homeDir, ".codex", "hooks.json");
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(hooksPath, JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: '"/node" "/app/hooks/codex-hook.js" SessionStart' }] },
            { hooks: [{ type: "command", command: '"/node" "/other/user-hook.js" SessionStart' }] },
          ],
        },
      }, null, 2), "utf8");
      const { runtime } = makeRuntime({
        ctx: { cleanupHomeDir: homeDir },
      });

      const result = runtime.uninstallIntegrationForAgent("codex");
      const next = JSON.parse(fs.readFileSync(hooksPath, "utf8"));

      assert.deepStrictEqual(
        { removed: result.removed, changed: result.changed },
        { removed: 1, changed: true }
      );
      assert.strictEqual(next.hooks.SessionStart.length, 1);
      assert.ok(next.hooks.SessionStart[0].hooks[0].command.includes("user-hook.js"));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("repairIntegrationForAgent('copilot-cli') routes through syncCopilotHooks (no separate repair)", () => {
    const { runtime, calls } = makeRuntime();

    const result = runtime.repairIntegrationForAgent("copilot-cli");

    assert.ok(result === true || (result && typeof result === "object"));
    assert.deepStrictEqual(calls.map((entry) => entry.name), ["copilot"]);
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

  it("does not log CodeWhale hook sync when the config is already current", () => {
    const codewhaleInstall = require("../hooks/codewhale-install");
    const originalRegister = codewhaleInstall.registerCodewhaleHooks;
    const originalLog = console.log;
    const logs = [];
    codewhaleInstall.registerCodewhaleHooks = () => ({
      added: 0,
      removed: 7,
      updated: false,
      skipped: true,
    });
    console.log = (message) => logs.push(message);

    try {
      const { runtime } = makeRuntime({ ctx: { syncCodewhaleHooksImpl: undefined } });
      const result = runtime.syncCodewhaleHooks();

      assert.strictEqual(result.status, "ok");
      assert.strictEqual(result.added, 0);
      assert.strictEqual(result.updated, false);
      assert.deepStrictEqual(logs, []);
    } finally {
      codewhaleInstall.registerCodewhaleHooks = originalRegister;
      console.log = originalLog;
    }
  });
});
