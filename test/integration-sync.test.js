"use strict";

const { afterEach, beforeEach, describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createIntegrationSyncRuntime } = require("../src/integration-sync");

const missingFakeImpls = [];
let integrationFailureWarnings = [];
let allowedIntegrationFailureWarningPatterns = [];
let restoreConsoleWarn = null;

function createGuardedIntegrationCtx(target, calls) {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (Object.prototype.hasOwnProperty.call(obj, prop)) {
        return Reflect.get(obj, prop, receiver);
      }
      if (typeof prop !== "string" || !/^(sync|repair)[A-Z]\w*Impl$/.test(prop)) {
        return Reflect.get(obj, prop, receiver);
      }
      return () => {
        calls.push({ name: `missing-fake:${prop}` });
        missingFakeImpls.push(prop);
        throw new Error(`Missing integration test fake: ${prop}`);
      };
    },
  });
}

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
  const { ctx: ctxOverrides = {}, ...runtimeOverrides } = overrides;
  const ctx = createGuardedIntegrationCtx({
    autoStartWithClaude: true,
    syncClawdHooksImpl: (options) => {
      calls.push({ name: "claude", options });
      return { status: "ok", source: "claude" };
    },
    syncGeminiHooksImpl: () => calls.push({ name: "gemini" }),
    syncAntigravityHooksImpl: () => calls.push({ name: "antigravity" }),
    syncCursorHooksImpl: () => calls.push({ name: "cursor" }),
    syncCopilotHooksImpl: () => calls.push({ name: "copilot" }),
    syncCodeBuddyHooksImpl: (options) => calls.push({ name: "codebuddy", options }),
    syncWorkBuddyHooksImpl: () => calls.push({ name: "workbuddy" }),
    syncKiroHooksImpl: () => calls.push({ name: "kiro" }),
    syncKimiHooksImpl: () => calls.push({ name: "kimi" }),
    syncQwenHooksImpl: () => calls.push({ name: "qwen" }),
    syncZcodeHooksImpl: () => calls.push({ name: "zcode" }),
    syncCodewhaleHooksImpl: () => calls.push({ name: "codewhale" }),
    syncCodexHooksImpl: () => calls.push({ name: "codex" }),
    syncDeepSeekHarnessPluginImpl: (options) => {
      calls.push({ name: "deepseek-harness", options });
      return { status: "ok" };
    },
    repairCodexHooksImpl: (options) => {
      calls.push({ name: "codex-repair" });
      repairOptions.push(options);
      return { status: "ok", message: "done" };
    },
    syncOpencodePluginImpl: () => calls.push({ name: "opencode" }),
    syncMimocodePluginImpl: () => calls.push({ name: "mimocode" }),
    syncPiExtensionImpl: () => calls.push({ name: "pi" }),
    syncOpenClawPluginImpl: () => calls.push({ name: "openclaw" }),
    repairOpenClawPluginImpl: () => {
      calls.push({ name: "openclaw-repair" });
      return { status: "ok", message: "done" };
    },
    syncHermesPluginImpl: () => calls.push({ name: "hermes" }),
    syncQoderHooksImpl: () => calls.push({ name: "qoder" }),
    syncReasonixHooksImpl: () => calls.push({ name: "reasonix" }),
    syncQoderWorkHooksImpl: () => calls.push({ name: "qoderwork" }),
    syncTraeCodeHooksImpl: () => calls.push({ name: "traecode" }),
    syncQwenWorkHooksImpl: () => calls.push({ name: "qwenwork" }),
    ...ctxOverrides,
  }, calls);
  const runtime = createIntegrationSyncRuntime({
    getHookServerPort: () => 24444,
    shouldManageClaudeHooks: () => true,
    isAgentEnabled: () => true,
    startClaudeSettingsWatcher: () => calls.push({ name: "watcher:start" }),
    stopClaudeSettingsWatcher: () => {
      calls.push({ name: "watcher:stop" });
      return "stopped";
    },
    ...runtimeOverrides,
    ctx,
  });
  return { runtime, calls, repairOptions };
}

describe("integration sync runtime", () => {
  beforeEach(() => {
    const originalWarn = console.warn;
    integrationFailureWarnings = [];
    allowedIntegrationFailureWarningPatterns = [];
    restoreConsoleWarn = () => {
      console.warn = originalWarn;
    };
    console.warn = (...args) => {
      const message = args.map((arg) => String(arg)).join(" ");
      if (/^Clawd:\s+failed to (?:sync|repair)\b/i.test(message)) {
        integrationFailureWarnings.push(message);
        return;
      }
      originalWarn(...args);
    };
  });

  afterEach(() => {
    if (restoreConsoleWarn) restoreConsoleWarn();
    restoreConsoleWarn = null;
    const missing = missingFakeImpls.splice(0);
    const warnings = integrationFailureWarnings;
    integrationFailureWarnings = [];
    const unexpectedWarnings = warnings.filter((message) => (
      !allowedIntegrationFailureWarningPatterns.some((pattern) => pattern.test(message))
    ));
    allowedIntegrationFailureWarningPatterns = [];
    assert.deepStrictEqual(
      { missingFakeImpls: missing, unexpectedIntegrationFailureWarnings: unexpectedWarnings },
      { missingFakeImpls: [], unexpectedIntegrationFailureWarnings: [] }
    );
  });

  it("test ctx guard records missing sync/repair fakes and blocks real fallbacks", () => {
    const calls = [];
    const ctx = createGuardedIntegrationCtx({}, calls);
    const runtime = createIntegrationSyncRuntime({ ctx });
    allowedIntegrationFailureWarningPatterns.push(
      /^Clawd:\s+failed to sync Reasonix hooks:\s+Missing integration test fake: syncReasonixHooksImpl$/
    );

    const result = runtime.syncReasonixHooks();
    assert.throws(
      () => ctx.repairFuturePluginImpl(),
      /Missing integration test fake: repairFuturePluginImpl/
    );

    assert.deepStrictEqual(result, {
      status: "error",
      message: "Missing integration test fake: syncReasonixHooksImpl",
    });
    assert.deepStrictEqual(calls, [
      { name: "missing-fake:syncReasonixHooksImpl" },
      { name: "missing-fake:repairFuturePluginImpl" },
    ]);
    assert.deepStrictEqual(missingFakeImpls.splice(0), [
      "syncReasonixHooksImpl",
      "repairFuturePluginImpl",
    ]);
  });

  it("syncClawdHooks passes auto-start, the current server port, and sync provenance", () => {
    const { runtime, calls } = makeRuntime();

    const result = runtime.syncClawdHooks();

    assert.deepStrictEqual(result, { status: "ok", source: "claude" });
    assert.deepStrictEqual(calls, [
      { name: "claude", options: { autoStart: true, port: 24444, source: null, automatic: true } },
    ]);
  });

  it("syncClawdHooks forwards an explicit source/automatic pair unchanged", () => {
    const { runtime, calls } = makeRuntime();

    runtime.syncClawdHooks({ source: "doctor", automatic: false });

    assert.deepStrictEqual(calls, [
      { name: "claude", options: { autoStart: true, port: 24444, source: "doctor", automatic: false } },
    ]);
  });

  it("repairIntegrationForAgent('claude-code') syncs as an explicit, non-automatic doctor repair", () => {
    const { runtime, calls } = makeRuntime();

    const result = runtime.repairIntegrationForAgent("claude-code");

    assert.deepStrictEqual(result, { status: "ok", source: "claude" });
    // watcher:start appears twice: once from syncIntegrationForAgent's own
    // success path, once from repairIntegrationForAgent's unconditional
    // ensure-started call (Doctor Fix's enabled precondition holds regardless
    // of this repair's outcome). start() is idempotent in production; the
    // fake watcher stub here just isn't, so both calls show up.
    assert.deepStrictEqual(calls.map((entry) => entry.name), ["claude", "watcher:start", "watcher:start"]);
    assert.deepStrictEqual(calls[0].options, { autoStart: true, port: 24444, source: "doctor", automatic: false });
  });

  it("syncIntegrationForAgent waits for an async Claude sync to settle before starting the watcher", async () => {
    let resolveSync;
    const { runtime, calls } = makeRuntime({
      ctx: {
        syncClawdHooksImpl: (options) => {
          calls.push({ name: "claude", options });
          return new Promise((resolve) => { resolveSync = resolve; });
        },
      },
    });

    const pending = runtime.syncIntegrationForAgent("claude-code");
    assert.deepStrictEqual(calls.map((entry) => entry.name), ["claude"], "watcher must not start before the async sync settles");

    resolveSync({ status: "ok" });
    const result = await pending;

    assert.deepStrictEqual(result, { status: "ok" });
    assert.deepStrictEqual(calls.map((entry) => entry.name), ["claude", "watcher:start"]);
  });

  it("does not start the Claude watcher when a synchronous sync result is an error (Settings Enable failure)", () => {
    const { runtime, calls } = makeRuntime({
      ctx: {
        syncClawdHooksImpl: (options) => {
          calls.push({ name: "claude", options });
          return { status: "error", message: "write failed" };
        },
      },
    });

    const result = runtime.syncIntegrationForAgent("claude-code", { source: "settings-agent-enable", automatic: false });

    assert.deepStrictEqual(result, { status: "error", message: "write failed" });
    assert.deepStrictEqual(
      calls.map((entry) => entry.name),
      ["claude"],
      "a failed Settings Enable sync must not leave the directory watcher running for a still-disabled agent"
    );
  });

  it("does not start the Claude watcher when an async sync resolves an error (Settings Install failure)", async () => {
    const { runtime, calls } = makeRuntime({
      ctx: {
        syncClawdHooksImpl: async (options) => {
          calls.push({ name: "claude", options });
          return { status: "error", message: "source script missing" };
        },
      },
    });

    const result = await runtime.syncIntegrationForAgent("claude-code", { source: "settings-agent-install", automatic: false });

    assert.deepStrictEqual(result, { status: "error", message: "source script missing" });
    assert.deepStrictEqual(
      calls.map((entry) => entry.name),
      ["claude"],
      "a failed Settings Install sync must not leave the directory watcher running for a not-yet-installed agent"
    );
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
      "workbuddy",
      "kiro",
      "kimi",
      "qwen",
      "zcode",
      "codewhale",
      "codex",
      "deepseek-harness",
      "mimocode",
      "pi",
      "openclaw",
      "hermes",
      "qoder",
      "reasonix",
      "qoderwork",
      "traecode",
      "qwenwork",
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
      "workbuddy",
      "kiro",
      "kimi",
      "qwen",
      "zcode",
      "codewhale",
      "codex",
      "deepseek-harness",
      "opencode",
      "mimocode",
      "openclaw",
      "hermes",
      "qoder",
      "reasonix",
      "qoderwork",
      "traecode",
      "qwenwork",
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

  it("gives DSH startup, Settings Install, and Doctor Repair distinct mutation intent", async () => {
    const { runtime, calls } = makeRuntime();
    await runtime.syncIntegrationForAgent("deepseek-harness", { source: "startup", automatic: true });
    await runtime.syncIntegrationForAgent("deepseek-harness", { source: "settings-agent-install", automatic: false });
    await runtime.repairIntegrationForAgent("deepseek-harness", { source: "doctor-fix" });
    assert.deepStrictEqual(calls.map((entry) => ({
      name: entry.name,
      operation: entry.options.operation,
      automatic: entry.options.automatic,
      silent: entry.options.silent,
    })), [
      { name: "deepseek-harness", operation: "startup-sync", automatic: true, silent: true },
      { name: "deepseek-harness", operation: "install", automatic: false, silent: true },
      { name: "deepseek-harness", operation: "explicit-repair", automatic: false, silent: true },
    ]);
  });

  it("awaits DSH repair and preserves its structured failure", async () => {
    let settle;
    const { runtime } = makeRuntime({
      ctx: {
        syncDeepSeekHarnessPluginImpl: () => new Promise((resolve) => { settle = resolve; }),
      },
    });
    const pending = runtime.repairIntegrationForAgent("deepseek-harness");
    assert.strictEqual(typeof pending.then, "function");
    settle({ status: "error", reason: "inspection-required", manualInspectionRequired: true });
    assert.deepStrictEqual(await pending, {
      status: "error",
      reason: "inspection-required",
      manualInspectionRequired: true,
    });
  });

  it("passes custom integration options to CodeBuddy sync", () => {
    const { runtime, calls } = makeRuntime();

    runtime.syncIntegrationForAgent("codebuddy", {
      permissionTarget: { mode: "custom", url: "https://approval.example.test/permission" },
    });

    assert.deepStrictEqual(calls, [{
      name: "codebuddy",
      options: { permissionTarget: { mode: "custom", url: "https://approval.example.test/permission" } },
    }]);
  });

  it("reads saved custom integration options during startup sync", () => {
    const { runtime, calls } = makeRuntime({
      shouldSyncAgentIntegration: (agentId) => agentId === "codebuddy",
      getAgentIntegrationOptions: (agentId) => (
        agentId === "codebuddy"
          ? { permissionTarget: { mode: "custom", url: "https://approval.example.test/permission" } }
          : {}
      ),
    });

    runtime.syncEnabledStartupIntegrations();

    assert.deepStrictEqual(calls, [{
      name: "codebuddy",
      options: { permissionTarget: { mode: "custom", url: "https://approval.example.test/permission" } },
    }]);
  });

  it("uses an explicit local target when CodeBuddy sync is called without saved options", () => {
    let received = null;
    const { runtime } = makeRuntime({
      ctx: { syncCodeBuddyHooksImpl: null },
    });
    const modulePath = require.resolve("../hooks/codebuddy-install.js");

    withPatchedExport(modulePath, "registerCodeBuddyHooks", (options) => {
      received = options;
      return { added: 0, updated: 0, skipped: 9 };
    }, () => runtime.syncCodeBuddyHooks());

    assert.deepStrictEqual(received.permissionTarget, { mode: "local" });
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
        agentId: "workbuddy",
        ctxKey: "syncWorkBuddyHooksImpl",
        modulePath: "../hooks/workbuddy-install.js",
        exportName: "registerWorkBuddyHooks",
        reason: "workbuddy-not-installed",
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

  it("syncIntegrationForAgent distinguishes mimocode missing from already registered (R8 P1)", () => {
    // Without these, the production mimocode mapping could be swapped for a
    // no-op and the whole Settings-Install / startup / Doctor-Repair sync
    // chain would fail green.
    const missing = withPatchedExport(
      "../hooks/mimocode-install.js",
      "registerMimocodePlugin",
      () => ({ added: false, skipped: true, created: false, reason: "mimocode-not-found" }),
      () => {
        const { runtime } = makeRuntime({ ctx: { syncMimocodePluginImpl: undefined } });
        return runtime.syncIntegrationForAgent("mimocode");
      }
    );

    assert.strictEqual(missing.status, "skipped");
    assert.strictEqual(missing.reason, "mimocode-not-found");

    const alreadyCurrent = withPatchedExport(
      "../hooks/mimocode-install.js",
      "registerMimocodePlugin",
      () => ({ added: false, skipped: true, created: false }),
      () => {
        const { runtime } = makeRuntime({ ctx: { syncMimocodePluginImpl: undefined } });
        return runtime.syncIntegrationForAgent("mimocode");
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
