"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const initServer = require("../src/server");
const {
  MAX_CODEX_OFFICIAL_TURNS,
  resolveCodexOfficialHookState,
} = require("../src/server-codex-official-turns");
const { getClaudeHookScriptPath, getClaudeAutoStartScriptPath } = require("../hooks/install");

const EXPECTED_HOOK_SCRIPT_PATH = getClaudeHookScriptPath();
const EXPECTED_AUTO_START_SCRIPT_PATH = getClaudeAutoStartScriptPath();

class FakeWatcher extends EventEmitter {
  constructor(callback) {
    super();
    this._callback = callback;
    this.closed = false;
    this.closeCalls = 0;
  }

  emitChange(filename = "settings.json") {
    if (this.closed) return;
    this._callback("change", filename);
  }

  close() {
    this.closed = true;
    this.closeCalls++;
  }
}

function makeFakeHttpFactory() {
  const servers = [];
  function createHttpServer(handler) {
    const server = new EventEmitter();
    server._handler = handler;
    server.listenCalls = [];
    server.closed = false;
    server.listen = function (port, host) {
      this.listenCalls.push({ port, host });
      this.emit("listening");
    };
    server.close = function () {
      this.closed = true;
    };
    servers.push(server);
    return server;
  }
  return { createHttpServer, servers };
}

// Delay-aware fake clock — see test/claude-settings-watcher.test.js for the
// rationale. The Claude settings supervisor's periodic health audit (#657)
// self-reschedules on every tick, so a naive "flush everything until empty"
// fake timer would loop forever; advance(ms) only fires what's actually due
// within the window, in due-time order.
function makeFakeClock(initialNow = 0) {
  let now = initialNow;
  let nextId = 1;
  const pending = new Map();

  function setTimeoutFn(fn, delay) {
    const id = nextId++;
    pending.set(id, { fn, dueAt: now + (Number.isFinite(delay) ? delay : 0) });
    return id;
  }
  function clearTimeoutFn(id) {
    pending.delete(id);
  }
  function flushMicrotasks() {
    return new Promise((resolve) => setImmediate(resolve));
  }
  async function advance(ms) {
    const target = now + (Number.isFinite(ms) ? ms : 0);
    for (;;) {
      let dueId = null;
      let dueAt = null;
      for (const [id, entry] of pending) {
        if (entry.dueAt > target) continue;
        if (dueAt === null || entry.dueAt < dueAt) {
          dueAt = entry.dueAt;
          dueId = id;
        }
      }
      if (dueId === null) break;
      const entry = pending.get(dueId);
      pending.delete(dueId);
      now = entry.dueAt;
      entry.fn();
      await flushMicrotasks();
      await flushMicrotasks();
    }
    now = target;
  }
  return { setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn, now: () => now, advance };
}

function makeServer(overrides = {}) {
  const httpFactory = makeFakeHttpFactory();
  const timers = makeFakeClock();
  const syncCalls = [];
  let lastWatcher = null;
  const existingPaths = new Set([EXPECTED_HOOK_SCRIPT_PATH, EXPECTED_AUTO_START_SCRIPT_PATH]);
  let settingsRaw = JSON.stringify({
    hooks: {
      Stop: [
        {
          matcher: "",
          hooks: [{ type: "command", command: `node "${EXPECTED_HOOK_SCRIPT_PATH}" Stop` }],
        },
      ],
      PermissionRequest: [
        {
          matcher: "",
          hooks: [{ type: "http", url: "http://127.0.0.1:23333/permission", timeout: 600 }],
        },
      ],
    },
  });

  const ctx = {
    manageClaudeHooksAutomatically: true,
    autoStartWithClaude: false,
    createHttpServer: httpFactory.createHttpServer,
    setImmediate: (fn) => fn(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: timers.now,
    getPortCandidates: () => [23333],
    readRuntimePort: () => null,
    writeRuntimeConfig: () => true,
    clearRuntimeConfig: () => true,
    platform: "win32",
    fs: {
      watch(_dir, callback) {
        lastWatcher = new FakeWatcher(callback);
        return lastWatcher;
      },
      readFileSync() {
        return settingsRaw;
      },
      existsSync(p) {
        return existingPaths.has(p);
      },
    },
    syncClawdHooksImpl: () => syncCalls.push("claude"),
    syncGeminiHooksImpl: () => syncCalls.push("gemini"),
    syncAntigravityHooksImpl: () => syncCalls.push("antigravity"),
    syncCursorHooksImpl: () => syncCalls.push("cursor"),
    syncCopilotHooksImpl: () => syncCalls.push("copilot"),
    syncCodeBuddyHooksImpl: () => syncCalls.push("codebuddy"),
    syncKiroHooksImpl: () => syncCalls.push("kiro"),
    syncKimiHooksImpl: () => syncCalls.push("kimi"),
    syncQwenHooksImpl: () => syncCalls.push("qwen"),
    syncCodexHooksImpl: () => syncCalls.push("codex"),
    repairCodexHooksImpl: () => syncCalls.push("codex-repair"),
    syncOpencodePluginImpl: () => syncCalls.push("opencode"),
    syncPiExtensionImpl: () => syncCalls.push("pi"),
    syncOpenClawPluginImpl: () => syncCalls.push("openclaw"),
    repairOpenClawPluginImpl: () => syncCalls.push("openclaw-repair"),
    syncHermesPluginImpl: () => syncCalls.push("hermes"),
    syncCodewhaleHooksImpl: () => syncCalls.push("codewhale"),
    syncQoderHooksImpl: () => syncCalls.push("qoder"),
    syncReasonixHooksImpl: () => syncCalls.push("reasonix"),
    ...overrides,
  };

  return {
    api: initServer(ctx),
    syncCalls,
    timers,
    getWatcher: () => lastWatcher,
    setSettingsRaw: (raw) => { settingsRaw = raw; },
    servers: httpFactory.servers,
  };
}

function healthyClaudeSettingsWithThirdPartyHook() {
  return {
    env: { FOO: "bar" },
    permissions: { allow: ["*"], deny: [] },
    enabledPlugins: { a: true },
    skillOverrides: { sk1: true },
    hooks: {
      Stop: [{
        matcher: "",
        hooks: [
          { type: "command", command: `node "${EXPECTED_HOOK_SCRIPT_PATH}" Stop` },
          { type: "command", command: "node /home/u/.claude/hooks/third-party.js" },
        ],
      }],
      PermissionRequest: [{
        matcher: "",
        hooks: [{ type: "http", url: "http://127.0.0.1:23333/permission", timeout: 600 }],
      }],
    },
  };
}

describe("server Claude hook management", () => {
  it("startup syncs Claude hooks and starts watcher when automatic management is enabled", () => {
    const { api, syncCalls, getWatcher } = makeServer({
      manageClaudeHooksAutomatically: true,
    });

    api.startHttpServer();

    assert.deepStrictEqual(syncCalls, ["claude", "gemini", "antigravity", "cursor", "copilot", "codebuddy", "kiro", "kimi", "qwen", "codewhale", "codex", "opencode", "pi", "openclaw", "hermes", "qoder","reasonix"]);
    assert.ok(getWatcher(), "watcher should start when management is enabled");
  });

  it("startup skips Hermes plugin sync quietly when Hermes is not installed", () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const { api, syncCalls, getWatcher } = makeServer({
        manageClaudeHooksAutomatically: true,
        syncHermesPluginImpl: undefined,
        isHermesInstalledImpl: () => false,
      });

      api.startHttpServer();

      assert.deepStrictEqual(syncCalls, ["claude", "gemini", "antigravity", "cursor", "copilot", "codebuddy", "kiro", "kimi", "qwen", "codewhale", "codex", "opencode", "pi", "openclaw", "qoder","reasonix"]);
      assert.ok(getWatcher(), "watcher should start when management is enabled");
      assert.strictEqual(warnings.some((line) => /Hermes/i.test(line)), false);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("startup skips Claude sync/watcher but still syncs other agents when automatic management is disabled", () => {
    const { api, syncCalls, getWatcher } = makeServer({
      manageClaudeHooksAutomatically: false,
    });

    api.startHttpServer();

    assert.deepStrictEqual(syncCalls, ["gemini", "antigravity", "cursor", "copilot", "codebuddy", "kiro", "kimi", "qwen", "codewhale", "codex", "opencode", "pi", "openclaw", "hermes", "qoder","reasonix"]);
    assert.strictEqual(getWatcher(), null);
  });

  it("startup skips automatic hook/plugin sync for disabled agents", () => {
    const disabled = new Set(["gemini-cli", "antigravity-cli", "cursor-agent", "kiro-cli", "opencode", "pi", "openclaw"]);
    const { api, syncCalls, getWatcher } = makeServer({
      isAgentEnabled: (agentId) => !disabled.has(agentId),
    });

    api.startHttpServer();

    assert.deepStrictEqual(syncCalls, ["claude", "copilot", "codebuddy", "kimi", "qwen", "codewhale", "codex", "hermes", "qoder","reasonix"]);
    assert.ok(getWatcher(), "Claude watcher should still start when Claude is enabled");
  });

  it("startup skips Claude hook sync and watcher when Claude Code is disabled", () => {
    const { api, syncCalls, getWatcher } = makeServer({
      isAgentEnabled: (agentId) => agentId !== "claude-code",
    });

    api.startHttpServer();

    assert.deepStrictEqual(syncCalls, ["gemini", "antigravity", "cursor", "copilot", "codebuddy", "kiro", "kimi", "qwen", "codewhale", "codex", "opencode", "pi", "openclaw", "hermes", "qoder","reasonix"]);
    assert.strictEqual(getWatcher(), null);
  });

  it("stopClaudeSettingsWatcher is safe to call repeatedly", () => {
    const { api, getWatcher } = makeServer();

    const started = api.startClaudeSettingsWatcher();
    const watcher = getWatcher();
    const firstStop = api.stopClaudeSettingsWatcher();
    const secondStop = api.stopClaudeSettingsWatcher();

    assert.strictEqual(started, true);
    assert.ok(watcher);
    assert.strictEqual(firstStop, true);
    assert.strictEqual(secondStop, false);
    assert.strictEqual(watcher.closeCalls, 1);
  });

  it("watcher no longer re-syncs after it has been stopped", async () => {
    const { api, syncCalls, timers, getWatcher, setSettingsRaw } = makeServer();

    api.startClaudeSettingsWatcher();
    api.stopClaudeSettingsWatcher();
    setSettingsRaw('{"hooks":{}}');
    getWatcher().emitChange("settings.json");
    await timers.advance(10_000);

    assert.deepStrictEqual(syncCalls, []);
  });

  it("watcher re-syncs when PermissionRequest hook disappears but command hooks remain", async () => {
    const { api, syncCalls, timers, getWatcher, setSettingsRaw } = makeServer();

    api.startClaudeSettingsWatcher();
    await timers.advance(0); // consume the initial (healthy) startup check first

    setSettingsRaw(JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: `node "${EXPECTED_HOOK_SCRIPT_PATH}" Stop` }],
          },
        ],
      },
    }));
    getWatcher().emitChange("settings.json");
    await timers.advance(1000);

    assert.deepStrictEqual(syncCalls, ["claude"]);
  });

  it("watcher re-syncs when PermissionRequest hook points to the wrong port", async () => {
    const { api, syncCalls, timers, getWatcher, setSettingsRaw } = makeServer();

    api.startClaudeSettingsWatcher();
    await timers.advance(0);

    setSettingsRaw(JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: `node "${EXPECTED_HOOK_SCRIPT_PATH}" Stop` }],
          },
        ],
        PermissionRequest: [
          {
            matcher: "",
            hooks: [{ type: "http", url: "http://127.0.0.1:23335/permission", timeout: 600 }],
          },
        ],
      },
    }));
    getWatcher().emitChange("settings.json");
    await timers.advance(1000);

    assert.deepStrictEqual(syncCalls, ["claude"]);
  });

  it("records suspicious-shrink guard status when watcher skips automatic Claude repair", async () => {
    const notices = [];
    const { api, syncCalls, timers, getWatcher, setSettingsRaw } = makeServer({
      notifySuspiciousShrink: (before, after, notice) => notices.push({ before, after, notice }),
    });
    setSettingsRaw(JSON.stringify(healthyClaudeSettingsWithThirdPartyHook()));

    api.startClaudeSettingsWatcher();
    await timers.advance(0); // seeds the trusted baseline from the rich healthy fixture

    setSettingsRaw(JSON.stringify({ skipDangerousModePermissionPrompt: true }));
    getWatcher().emitChange("settings.json");
    await timers.advance(1000);

    assert.deepStrictEqual(syncCalls, []);
    assert.strictEqual(notices.length, 1);
    assert.strictEqual(notices[0].notice.type, "suspicious-shrink");
    assert.strictEqual(notices[0].before.keyCount, 5);
    assert.strictEqual(notices[0].after.keyCount, 1);
    assert.deepStrictEqual(api.getClaudeHookGuardStatus(), notices[0].notice);

    await api.repairIntegrationForAgent("claude-code");
    assert.strictEqual(api.getClaudeHookGuardStatus(), null);

    // The underlying file is still shrunk (the stub above never actually
    // fixed it) — periodic ticks must keep skipping auto-repair but must NOT
    // re-pop the same notification every cycle (#657 plan §4.6). The guard
    // notice then goes stale on its own TTL once nothing new is happening.
    await timers.advance(31 * 60 * 1000);
    assert.strictEqual(notices.length, 1, "must not re-notify every periodic cycle for the same persisting shrink");
    assert.strictEqual(api.getClaudeHookGuardStatus(), null, "the notice must go stale via its own TTL once nothing new re-triggers it");
  });

  it("keeps suspicious-shrink guard status when Claude repair fails and clears it on cleanup", async () => {
    const { api, timers, getWatcher, setSettingsRaw } = makeServer({
      syncClawdHooksImpl: () => ({ status: "error", message: "write failed" }),
    });
    setSettingsRaw(JSON.stringify(healthyClaudeSettingsWithThirdPartyHook()));

    api.startClaudeSettingsWatcher();
    await timers.advance(0);

    setSettingsRaw(JSON.stringify({ skipDangerousModePermissionPrompt: true }));
    getWatcher().emitChange("settings.json");
    await timers.advance(1000);
    const guard = api.getClaudeHookGuardStatus();
    assert.ok(guard);

    const repairResult = await api.repairIntegrationForAgent("claude-code");
    assert.deepStrictEqual(repairResult, { status: "error", message: "write failed" });
    assert.deepStrictEqual(api.getClaudeHookGuardStatus(), guard);

    api.cleanup();
    assert.strictEqual(api.getClaudeHookGuardStatus(), null);
  });

  it("watcher ignores settings changes when both command and PermissionRequest hooks are intact", async () => {
    const { api, syncCalls, timers, getWatcher } = makeServer();

    api.startClaudeSettingsWatcher();
    await timers.advance(0);
    getWatcher().emitChange("settings.json");
    await timers.advance(1000);

    assert.deepStrictEqual(syncCalls, []);
  });

  it("watcher does not re-sync missing Claude hooks while Claude Code is disabled", async () => {
    let claudeEnabled = true;
    const { api, syncCalls, timers, getWatcher, setSettingsRaw } = makeServer({
      isAgentEnabled: (agentId) => agentId !== "claude-code" || claudeEnabled,
    });

    api.startClaudeSettingsWatcher();
    claudeEnabled = false;
    setSettingsRaw('{"hooks":{}}');
    getWatcher().emitChange("settings.json");
    await timers.advance(1000);

    assert.deepStrictEqual(syncCalls, []);
  });

  it("watcher does not re-sync missing Claude hooks after Claude integration is uninstalled", async () => {
    let shouldSyncClaude = true;
    const { api, syncCalls, timers, getWatcher, setSettingsRaw } = makeServer({
      shouldSyncAgentIntegration: (agentId) => (
        agentId !== "claude-code" || shouldSyncClaude
      ),
    });

    api.startClaudeSettingsWatcher();
    shouldSyncClaude = false;
    setSettingsRaw('{"hooks":{}}');
    getWatcher().emitChange("settings.json");
    await timers.advance(1000);

    assert.deepStrictEqual(syncCalls, []);
  });

  it("getClaudeHookHealthStatus reflects the periodic supervisor's own state, distinct from the guard notice", async () => {
    const { api, timers } = makeServer();

    api.startClaudeSettingsWatcher();
    await timers.advance(0);

    const status = api.getClaudeHookHealthStatus();
    assert.strictEqual(status.status, "healthy");
    assert.ok(Array.isArray(status.issues));
  });

  it("disconnect-style restart does not reinstall Claude hooks when management stays disabled", () => {
    const first = makeServer({ manageClaudeHooksAutomatically: false });
    first.api.startHttpServer();
    first.api.cleanup();

    const second = makeServer({ manageClaudeHooksAutomatically: false });
    second.api.startHttpServer();

    assert.deepStrictEqual(first.syncCalls, ["gemini", "antigravity", "cursor", "copilot", "codebuddy", "kiro", "kimi", "qwen", "codewhale", "codex", "opencode", "pi", "openclaw", "hermes", "qoder","reasonix"]);
    assert.deepStrictEqual(second.syncCalls, ["gemini", "antigravity", "cursor", "copilot", "codebuddy", "kiro", "kimi", "qwen", "codewhale", "codex", "opencode", "pi", "openclaw", "hermes", "qoder","reasonix"]);
  });

  it("repairIntegrationForAgent uses the Codex official hook repair path", () => {
    const { api, syncCalls } = makeServer();

    const repaired = api.repairIntegrationForAgent("codex");

    assert.strictEqual(repaired, true);
    assert.deepStrictEqual(syncCalls, ["codex-repair"]);
  });

  it("repairIntegrationForAgent('copilot-cli') routes through the standard sync path", () => {
    const { api, syncCalls } = makeServer();

    const repaired = api.repairIntegrationForAgent("copilot-cli");

    assert.strictEqual(repaired, true);
    assert.deepStrictEqual(syncCalls, ["copilot"]);
  });

  it("passes Codex repair options through to the repair implementation", () => {
    const seen = [];
    const { api } = makeServer({
      repairCodexHooksImpl: (options) => {
        seen.push(options);
        return { status: "ok", message: "done" };
      },
    });

    const repaired = api.repairIntegrationForAgent("codex", { forceCodexHooksFeature: true });

    assert.deepStrictEqual(repaired, { status: "ok", message: "done" });
    assert.deepStrictEqual(seen, [{ forceCodexHooksFeature: true }]);
  });

  it("surfaces repair sync failures instead of reporting success", () => {
    const { api } = makeServer({
      syncGeminiHooksImpl: () => {
        throw new Error("permission denied");
      },
    });

    const repaired = api.repairIntegrationForAgent("gemini-cli");

    assert.strictEqual(repaired.status, "error");
    assert.match(repaired.message, /permission denied/);
  });
});

function withPatchedInstallModule(patches, run) {
  const installModule = require("../hooks/install.js");
  const originals = {};
  for (const key of Object.keys(patches)) {
    originals[key] = installModule[key];
    installModule[key] = patches[key];
  }
  const restore = () => {
    for (const key of Object.keys(patches)) {
      installModule[key] = originals[key];
    }
  };
  return Promise.resolve()
    .then(run)
    .then((value) => { restore(); return value; }, (err) => { restore(); throw err; });
}

// These exercise server.js's OWN default queue-backed implementation — every
// other test in this file injects ctx.syncClawdHooksImpl and so never reaches
// it. Passing syncClawdHooksImpl: undefined opts back into the real
// hooks/install.js-backed path (server.js only fills in its queued default
// when the caller hasn't already provided a seam).
describe("server Claude hook operation queue (default, non-injected implementation)", () => {
  it("syncClawdHooks registers hooks and, for startup, also registers the statusline", async () => {
    const calls = [];
    await withPatchedInstallModule({
      registerHooksAsync: async (opts) => { calls.push(["register", opts]); return { added: 1, updated: 0, removed: 0 }; },
      registerClaudeStatusline: (opts) => { calls.push(["statusline", opts]); return { changed: true }; },
    }, async () => {
      const { api } = makeServer({ syncClawdHooksImpl: undefined });
      const result = await api.syncClawdHooks({ source: "startup", automatic: true });
      assert.strictEqual(result.status, "ok");
      assert.deepStrictEqual(calls.map((c) => c[0]), ["register", "statusline"]);
    });
  });

  it("syncClawdHooks skips the statusline for legacy/periodic/doctor/watch sources", async () => {
    for (const source of ["settings", "doctor", "settings-watch", "periodic-health"]) {
      const calls = [];
      await withPatchedInstallModule({
        registerHooksAsync: async () => { calls.push("register"); return { added: 0, updated: 0, removed: 0 }; },
        registerClaudeStatusline: () => { calls.push("statusline"); return { changed: false }; },
      }, async () => {
        const { api } = makeServer({ syncClawdHooksImpl: undefined });
        await api.syncClawdHooks({ source, automatic: false });
        assert.deepStrictEqual(calls, ["register"], source);
      });
    }
  });

  it("syncClawdHooks (Doctor Fix / Settings Install path) does not write when the current source script is missing", async () => {
    const calls = [];
    await withPatchedInstallModule({
      registerHooksAsync: async () => { calls.push("register"); return { added: 1, updated: 0, removed: 0 }; },
    }, async () => {
      const { api } = makeServer({
        syncClawdHooksImpl: undefined,
        fs: {
          watch() { return new FakeWatcher(() => {}); },
          readFileSync() { return "{}"; },
          existsSync() { return false; }, // current packaged source script itself is gone
        },
      });

      const result = await api.syncClawdHooks({ source: "doctor", automatic: false });

      assert.strictEqual(result.status, "error");
      assert.strictEqual(result.reason, "source-script-missing");
      assert.deepStrictEqual(calls, [], "must never write toward a source path that does not exist");
    });
  });

  it("syncClawdHooks (Doctor Fix / Settings Install path) reports failure instead of a blind ok when the write does not verify healthy", async () => {
    await withPatchedInstallModule({
      // The installer "succeeds" (no throw) but structurally can't fix
      // anything — e.g. a permission error silently no-ops the write, or the
      // on-disk command still doesn't match after registerHooksAsync claims
      // success. The fixture is left exactly as broken as it started.
      registerHooksAsync: async () => ({ added: 0, updated: 0, removed: 0 }),
    }, async () => {
      const { api } = makeServer({
        syncClawdHooksImpl: undefined,
        fs: {
          watch() { return new FakeWatcher(() => {}); },
          readFileSync() { return JSON.stringify({ hooks: {} }); }, // no managed hooks at all, before or after
          existsSync(p) { return p === EXPECTED_HOOK_SCRIPT_PATH || p === EXPECTED_AUTO_START_SCRIPT_PATH; },
        },
      });

      const result = await api.syncClawdHooks({ source: "doctor", automatic: false });

      assert.strictEqual(result.status, "error");
      assert.match(result.message, /did not verify healthy/);
      assert.ok(Array.isArray(result.verifyIssues) && result.verifyIssues.length > 0);
    });
  });

  it("syncClawdHooks (Doctor Fix / Settings Install path) reports ok once the write actually verifies healthy", async () => {
    await withPatchedInstallModule({
      registerHooksAsync: async () => ({ added: 1, updated: 0, removed: 0 }),
    }, async () => {
      // Default makeServer() fixture is already healthy for core hooks.
      const { api } = makeServer({ syncClawdHooksImpl: undefined });

      const result = await api.syncClawdHooks({ source: "doctor", automatic: false });

      assert.deepStrictEqual(result, { status: "ok", added: 1, updated: 0, removed: 0 });
    });
  });

  it("syncClawdHooks (Doctor Fix / Settings Install path) reports failure, not a blind ok, when an unparseable Clawd command remains after write", async () => {
    await withPatchedInstallModule({
      // The installer runs but — like the real installer — never rewrites a
      // Clawd-owned command it could not parse in the first place (blindly
      // rewriting it risks stomping something Clawd does not actually own).
      // Nothing automatically repairable remains, but the config is still
      // visibly broken — must not be reported as a successful Fix/Install.
      registerHooksAsync: async () => ({ added: 0, updated: 0, removed: 0 }),
    }, async () => {
      const { api } = makeServer({
        syncClawdHooksImpl: undefined,
        fs: {
          watch() { return new FakeWatcher(() => {}); },
          readFileSync() {
            return JSON.stringify({
              hooks: {
                Stop: [{ matcher: "", hooks: [{ type: "command", command: '"clawd-hook.js"' }] }],
                PermissionRequest: [{ matcher: "", hooks: [{ type: "http", url: "http://127.0.0.1:23333/permission", timeout: 600 }] }],
              },
            });
          },
          existsSync(p) { return p === EXPECTED_HOOK_SCRIPT_PATH || p === EXPECTED_AUTO_START_SCRIPT_PATH; },
        },
      });

      const result = await api.syncClawdHooks({ source: "doctor", automatic: false });

      assert.strictEqual(result.status, "error");
      assert.match(result.message, /did not verify healthy/);
      assert.ok(
        result.verifyIssues.some((issue) => issue.code === "command-unparseable"),
        JSON.stringify(result.verifyIssues)
      );
    });
  });

  it("uninstallClaudeHooks removes the statusline only for settings-agent-uninstall/cleanup, not legacy settings", async () => {
    for (const [source, expectStatusline] of [["settings-agent-uninstall", true], ["cleanup", true], ["settings", false]]) {
      const calls = [];
      await withPatchedInstallModule({
        unregisterHooksAsync: async () => { calls.push("unregister"); return { removed: 1, changed: true }; },
        unregisterClaudeStatusline: () => { calls.push("statusline-remove"); return { removed: 1, changed: true }; },
      }, async () => {
        const { api } = makeServer({ syncClawdHooksImpl: undefined });
        const result = await api.uninstallClaudeHooks({ source, automatic: false });
        assert.strictEqual(result.status, "ok");
        assert.deepStrictEqual(calls, expectStatusline ? ["unregister", "statusline-remove"] : ["unregister"], source);
      });
    }
  });

  it("a statusline failure does not fail the overall hooks-sync result", async () => {
    await withPatchedInstallModule({
      registerHooksAsync: async () => ({ added: 1, updated: 0, removed: 0 }),
      registerClaudeStatusline: () => { throw new Error("statusline boom"); },
    }, async () => {
      const { api } = makeServer({ syncClawdHooksImpl: undefined });
      const result = await api.syncClawdHooks({ source: "startup", automatic: true });
      assert.strictEqual(result.status, "ok");
    });
  });

  it("setClaudeAutoStart registers (async, not the sync installer) or unregisters through the same queue", async () => {
    const calls = [];
    let setSettingsRawRef = () => {};
    await withPatchedInstallModule({
      registerHooksAsync: async (opts) => {
        calls.push(["register", opts]);
        // Simulate the installer actually writing a valid auto-start entry —
        // enabling requires requireAutoStart:true in the post-write verify,
        // so it needs to find one on the re-read.
        setSettingsRawRef(JSON.stringify({
          hooks: {
            Stop: [{ matcher: "", hooks: [{ type: "command", command: `node "${EXPECTED_HOOK_SCRIPT_PATH}" Stop` }] }],
            SessionStart: [{ matcher: "", hooks: [{ type: "command", command: `node "${EXPECTED_AUTO_START_SCRIPT_PATH}"` }] }],
            PermissionRequest: [{ matcher: "", hooks: [{ type: "http", url: "http://127.0.0.1:23333/permission", timeout: 600 }] }],
          },
        }));
        return {};
      },
      registerHooks: () => {
        throw new Error("enabling auto-start must use the async installer, not the sync one (blocks the main thread)");
      },
      unregisterAutoStart: () => { calls.push(["unregister"]); return true; },
    }, async () => {
      const { api, setSettingsRaw } = makeServer({ syncClawdHooksImpl: undefined });
      setSettingsRawRef = setSettingsRaw;
      const onResult = await api.setClaudeAutoStart({ enabled: true, source: "auto-start" });
      const offResult = await api.setClaudeAutoStart({ enabled: false, source: "auto-start" });
      assert.deepStrictEqual(onResult, { status: "ok", enabled: true });
      assert.deepStrictEqual(offResult, { status: "ok", enabled: false });
      assert.deepStrictEqual(calls.map((c) => c[0]), ["register", "unregister"]);
    });
  });

  it("setClaudeAutoStart enable does not write when the current packaged source script is missing", async () => {
    const calls = [];
    await withPatchedInstallModule({
      registerHooksAsync: async (opts) => { calls.push(["register", opts]); return {}; },
    }, async () => {
      const { api } = makeServer({
        syncClawdHooksImpl: undefined,
        fs: {
          watch() { return new FakeWatcher(() => {}); },
          readFileSync() { return "{}"; },
          existsSync() { return false; }, // current source script itself is gone
        },
      });

      const result = await api.setClaudeAutoStart({ enabled: true, source: "auto-start" });

      assert.strictEqual(result.status, "error");
      assert.strictEqual(result.reason, "source-script-missing");
      assert.deepStrictEqual(calls, [], "must not attempt a write when the source script is missing");
    });
  });

  it("setClaudeAutoStart enable does not write when only the auto-start source script is missing (core script present)", async () => {
    const calls = [];
    await withPatchedInstallModule({
      registerHooksAsync: async (opts) => { calls.push(["register", opts]); return {}; },
    }, async () => {
      const { api } = makeServer({
        syncClawdHooksImpl: undefined,
        fs: {
          watch() { return new FakeWatcher(() => {}); },
          readFileSync() { return "{}"; },
          existsSync(p) { return p === EXPECTED_HOOK_SCRIPT_PATH; }, // auto-start.js itself is gone
        },
      });

      const result = await api.setClaudeAutoStart({ enabled: true, source: "auto-start" });

      assert.strictEqual(result.status, "error");
      assert.strictEqual(result.reason, "source-script-missing");
      assert.deepStrictEqual(calls, [], "must not write a SessionStart auto-start command toward a script that does not exist");
    });
  });

  it("setClaudeAutoStart enable reports failure when the write does not verify healthy", async () => {
    await withPatchedInstallModule({
      // registerHooksAsync "succeeds" but never actually adds the auto-start
      // entry — the settings fixture is left exactly as before.
      registerHooksAsync: async () => ({}),
    }, async () => {
      const { api } = makeServer({ syncClawdHooksImpl: undefined });

      const result = await api.setClaudeAutoStart({ enabled: true, source: "auto-start" });

      assert.strictEqual(result.status, "error");
      assert.match(result.message, /did not verify healthy/);
    });
  });

  it("serializes syncClawdHooks and setClaudeAutoStart onto the same queue (max concurrency 1)", async () => {
    const order = [];
    await withPatchedInstallModule({
      registerHooksAsync: async () => {
        order.push("hooks-start");
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("hooks-end");
        return { added: 0, updated: 0, removed: 0 };
      },
    }, async () => {
      const { api } = makeServer({ syncClawdHooksImpl: undefined });
      const p1 = api.syncClawdHooks({ source: "settings", automatic: false });
      const p2 = api.setClaudeAutoStart({ enabled: true, source: "auto-start" });
      await Promise.all([p1, p2]);
      // Both enable's registerHooksAsync call and the plain sync call go
      // through the same underlying installer function now (#657 review:
      // enabling must use the async installer, not a separate sync one) —
      // the queue still only ever runs one at a time, so the second call's
      // hooks-start never interleaves with the first's hooks-end.
      assert.deepStrictEqual(order, ["hooks-start", "hooks-end", "hooks-start", "hooks-end"]);
    });
  });

  it("cleanup() disposes the operation queue so further Claude mutations are rejected", async () => {
    const { api } = makeServer({ syncClawdHooksImpl: undefined });
    api.cleanup();
    const result = await api.syncClawdHooks({ source: "settings", automatic: false });
    assert.strictEqual(result.status, "error");
  });

  it("uninstallIntegrationForAgent('claude-code') routes through the queue-backed default, not a second bare unregister", async () => {
    const calls = [];
    await withPatchedInstallModule({
      unregisterHooksAsync: async () => { calls.push("unregister"); return { removed: 2, changed: true }; },
      unregisterClaudeStatusline: () => { calls.push("statusline-remove"); return { removed: 0, changed: false }; },
    }, async () => {
      const { api } = makeServer({ syncClawdHooksImpl: undefined });
      const result = await api.uninstallIntegrationForAgent("claude-code");
      assert.strictEqual(result.status, "ok");
      assert.strictEqual(result.removed, 2);
      assert.deepStrictEqual(calls, ["unregister", "statusline-remove"]);
    });
  });
});

// main.js exposes autoStartWithClaude as a live getter on the ctx object it
// hands to initServer() (see main.js's _serverCtx) — a runtime Settings
// toggle just flips the underlying variable the getter reads. makeServer()'s
// fixture uses a plain boolean for autoStartWithClaude everywhere else in
// this file, which cannot exercise this: a static boolean is identical
// whether or not the surrounding {...ctx} spread preserved live binding.
// These tests build ctx by hand with a real getter, exactly like main.js, so
// they can actually catch a regression of "{...ctx} freezes the getter."
function makeServerWithLiveAutoStart(initialValue) {
  let liveAutoStart = initialValue;
  const httpFactory = makeFakeHttpFactory();
  const timers = makeFakeClock();
  let lastWatcher = null;
  let settingsRaw = JSON.stringify({
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: `node "${EXPECTED_HOOK_SCRIPT_PATH}" Stop` }] }],
      PermissionRequest: [{ matcher: "", hooks: [{ type: "http", url: "http://127.0.0.1:23333/permission", timeout: 600 }] }],
    },
  });
  const existingPaths = new Set([EXPECTED_HOOK_SCRIPT_PATH, EXPECTED_AUTO_START_SCRIPT_PATH]);

  const ctx = {
    manageClaudeHooksAutomatically: true,
    get autoStartWithClaude() { return liveAutoStart; },
    createHttpServer: httpFactory.createHttpServer,
    setImmediate: (fn) => fn(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: timers.now,
    getPortCandidates: () => [23333],
    readRuntimePort: () => null,
    writeRuntimeConfig: () => true,
    clearRuntimeConfig: () => true,
    platform: "win32",
    fs: {
      watch(_dir, callback) {
        lastWatcher = new FakeWatcher(callback);
        return lastWatcher;
      },
      readFileSync() { return settingsRaw; },
      existsSync(p) { return existingPaths.has(p); },
    },
  };

  return {
    api: initServer(ctx),
    timers,
    setLiveAutoStart: (v) => { liveAutoStart = v; },
    getWatcher: () => lastWatcher,
    setSettingsRaw: (raw) => { settingsRaw = raw; },
    removeExisting: (p) => existingPaths.delete(p),
  };
}

describe("server Claude hook management — live autoStartWithClaude ctx (#657 follow-up)", () => {
  it("regular sync (Doctor Fix / Settings Install) reflects a runtime autoStartWithClaude toggle, not the value frozen at server startup", async () => {
    const calls = [];
    await withPatchedInstallModule({
      registerHooksAsync: async (opts) => {
        calls.push(opts.autoStart);
        return { added: 0, updated: 0, removed: 0 };
      },
    }, async () => {
      const { api, setLiveAutoStart } = makeServerWithLiveAutoStart(false);

      await api.syncClawdHooks({ source: "doctor", automatic: false });
      assert.deepStrictEqual(calls, [false], "reflects the startup value before any toggle");

      setLiveAutoStart(true); // simulates the user flipping the Settings toggle at runtime
      await api.syncClawdHooks({ source: "doctor", automatic: false });
      assert.deepStrictEqual(calls, [false, true], "must track the CURRENT setting, not the value frozen when the server started");

      setLiveAutoStart(false);
      await api.syncClawdHooks({ source: "doctor", automatic: false });
      assert.deepStrictEqual(calls, [false, true, false], "must track a toggle back off just as well");
    });
  });

  it("watcher's periodic health check reflects a runtime autoStartWithClaude toggle instead of the value frozen at startup", async () => {
    await withPatchedInstallModule({
      // Never actually writes the auto-start entry into settingsRaw — this
      // isolates the assertion to "did the watcher decide requireAutoStart
      // should be true," not "did some other repair side effect also work."
      registerHooksAsync: async () => ({ added: 0, updated: 0, removed: 0 }),
    }, async () => {
      const { api, timers, setLiveAutoStart } = makeServerWithLiveAutoStart(false);

      api.startClaudeSettingsWatcher();
      await timers.advance(0); // consume the startup check: auto-start not required yet, fixture is otherwise healthy
      assert.strictEqual(api.getClaudeHookHealthStatus().status, "healthy");

      // User turns auto-start ON at runtime. No SessionStart auto-start
      // command has ever been written, which the watcher must now notice —
      // proving requireAutoStart tracked the live toggle instead of staying
      // frozen at the startup value (false), which would stay "healthy"
      // forever and never flag or repair a missing/broken auto-start entry.
      setLiveAutoStart(true);
      await timers.advance(5 * 60 * 1000);

      const status = api.getClaudeHookHealthStatus();
      assert.notStrictEqual(status.status, "healthy");
      assert.ok(
        status.issues.some((issue) => issue.code === "auto-start-path-missing"),
        JSON.stringify(status.issues)
      );
    });
  });
});

describe("Codex official hook turn tracking", () => {
  it("resolves Stop to attention when the turn used a tool", () => {
    const turns = new Map();
    resolveCodexOfficialHookState({
      agent_id: "codex",
      hook_source: "codex-official",
      event: "UserPromptSubmit",
      session_id: "codex:s1",
      turn_id: "turn-1",
    }, "thinking", turns);
    resolveCodexOfficialHookState({
      agent_id: "codex",
      hook_source: "codex-official",
      event: "PreToolUse",
      session_id: "codex:s1",
      turn_id: "turn-1",
    }, "working", turns);

    const result = resolveCodexOfficialHookState({
      agent_id: "codex",
      hook_source: "codex-official",
      event: "Stop",
      session_id: "codex:s1",
      turn_id: "turn-1",
    }, "idle", turns);

    assert.deepStrictEqual(result, { state: "attention", drop: false });
    assert.strictEqual(turns.size, 0);
  });

  it("resolves Stop to idle when no tool or assistant output was seen", () => {
    const turns = new Map();
    resolveCodexOfficialHookState({
      agent_id: "codex",
      hook_source: "codex-official",
      event: "UserPromptSubmit",
      session_id: "codex:s1",
      turn_id: "turn-1",
    }, "thinking", turns);

    const result = resolveCodexOfficialHookState({
      agent_id: "codex",
      hook_source: "codex-official",
      event: "Stop",
      session_id: "codex:s1",
      turn_id: "turn-1",
    }, "idle", turns);

    assert.deepStrictEqual(result, { state: "idle", drop: false });
  });

  it("resolves Stop to attention when a no-tool turn has assistant output", () => {
    const turns = new Map();
    resolveCodexOfficialHookState({
      agent_id: "codex",
      hook_source: "codex-official",
      event: "UserPromptSubmit",
      session_id: "codex:s1",
      turn_id: "turn-1",
    }, "thinking", turns);

    const result = resolveCodexOfficialHookState({
      agent_id: "codex",
      hook_source: "codex-official",
      event: "Stop",
      session_id: "codex:s1",
      turn_id: "turn-1",
      assistant_last_output: "Short answer.",
    }, "idle", turns);

    assert.deepStrictEqual(result, { state: "attention", drop: false });
    assert.strictEqual(turns.size, 0);
  });

  it("resolves Stop without a turn id to attention when assistant output is present", () => {
    const result = resolveCodexOfficialHookState({
      agent_id: "codex",
      hook_source: "codex-official",
      event: "Stop",
      session_id: "codex:s1",
      assistant_last_output: "Done.",
    }, "idle", new Map());

    assert.deepStrictEqual(result, { state: "attention", drop: false });
  });

  it("drops stop_hook_active continuations without updating state", () => {
    const turns = new Map([["codex:s1|turn-1", { sessionId: "codex:s1", hadToolUse: true }]]);

    const result = resolveCodexOfficialHookState({
      agent_id: "codex",
      hook_source: "codex-official",
      event: "Stop",
      session_id: "codex:s1",
      turn_id: "turn-1",
      stop_hook_active: true,
    }, "idle", turns);

    assert.deepStrictEqual(result, { state: "idle", drop: true });
    assert.strictEqual(turns.size, 0);
  });

  it("resolves subagent Stop to idle and marks it headless", () => {
    const turns = new Map();
    const classifier = {
      registerSession: () => "subagent",
    };

    resolveCodexOfficialHookState({
      agent_id: "codex",
      hook_source: "codex-official",
      event: "UserPromptSubmit",
      session_id: "codex:sub",
      turn_id: "turn-1",
      codex_session_role: "subagent",
    }, "thinking", turns, classifier);
    resolveCodexOfficialHookState({
      agent_id: "codex",
      hook_source: "codex-official",
      event: "PreToolUse",
      session_id: "codex:sub",
      turn_id: "turn-1",
      codex_session_role: "subagent",
    }, "working", turns, classifier);

    const result = resolveCodexOfficialHookState({
      agent_id: "codex",
      hook_source: "codex-official",
      event: "Stop",
      session_id: "codex:sub",
      turn_id: "turn-1",
      codex_session_role: "subagent",
    }, "idle", turns, classifier);

    assert.deepStrictEqual(result, { state: "idle", drop: false, headless: true });
    assert.strictEqual(turns.size, 0);
  });

  it("keeps turns scoped by session id when turn_id overlaps", () => {
    const turns = new Map();

    resolveCodexOfficialHookState({
      agent_id: "codex",
      hook_source: "codex-official",
      event: "UserPromptSubmit",
      session_id: "codex:root",
      turn_id: "same-turn",
    }, "thinking", turns);
    resolveCodexOfficialHookState({
      agent_id: "codex",
      hook_source: "codex-official",
      event: "PreToolUse",
      session_id: "codex:root",
      turn_id: "same-turn",
    }, "working", turns);
    resolveCodexOfficialHookState({
      agent_id: "codex",
      hook_source: "codex-official",
      event: "UserPromptSubmit",
      session_id: "codex:sub",
      turn_id: "same-turn",
    }, "thinking", turns);

    const subStop = resolveCodexOfficialHookState({
      agent_id: "codex",
      hook_source: "codex-official",
      event: "Stop",
      session_id: "codex:sub",
      turn_id: "same-turn",
    }, "idle", turns);
    const rootStop = resolveCodexOfficialHookState({
      agent_id: "codex",
      hook_source: "codex-official",
      event: "Stop",
      session_id: "codex:root",
      turn_id: "same-turn",
    }, "idle", turns);

    assert.deepStrictEqual(subStop, { state: "idle", drop: false });
    assert.deepStrictEqual(rootStop, { state: "attention", drop: false });
    assert.strictEqual(turns.size, 0);
  });

  it("prunes the oldest tracked turns when the cap is exceeded", () => {
    const turns = new Map();
    for (let i = 0; i < MAX_CODEX_OFFICIAL_TURNS + 3; i++) {
      resolveCodexOfficialHookState({
        agent_id: "codex",
        hook_source: "codex-official",
        event: "UserPromptSubmit",
        session_id: "codex:s1",
        turn_id: `turn-${i}`,
      }, "thinking", turns);
    }

    assert.strictEqual(turns.size, MAX_CODEX_OFFICIAL_TURNS);
    assert.strictEqual(turns.has("codex:s1|turn-0"), false);
    assert.strictEqual(turns.has("codex:s1|turn-1"), false);
    assert.strictEqual(turns.has("codex:s1|turn-2"), false);
    assert.strictEqual(turns.has(`codex:s1|turn-${MAX_CODEX_OFFICIAL_TURNS + 2}`), true);
  });
});
