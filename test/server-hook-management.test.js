"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const initServer = require("../src/server");
const {
  MAX_CODEX_OFFICIAL_TURNS,
  resolveCodexOfficialHookState,
} = require("../src/server-codex-official-turns");

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

function makeFakeTimers() {
  const pending = [];
  return {
    setTimeout(fn) {
      const token = { fn, cleared: false };
      pending.push(token);
      return token;
    },
    clearTimeout(token) {
      if (token) token.cleared = true;
    },
    flush() {
      while (pending.length) {
        const token = pending.shift();
        if (!token.cleared) token.fn();
      }
    },
  };
}

function makeServer(overrides = {}) {
  const httpFactory = makeFakeHttpFactory();
  const timers = makeFakeTimers();
  const syncCalls = [];
  let lastWatcher = null;
  let settingsRaw = JSON.stringify({
    hooks: {
      Stop: [
        {
          matcher: "",
          hooks: [{ type: "command", command: 'node "/tmp/clawd-hook.js" Stop' }],
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
    getPortCandidates: () => [23333],
    writeRuntimeConfig: () => true,
    clearRuntimeConfig: () => true,
    fs: {
      watch(_dir, callback) {
        lastWatcher = new FakeWatcher(callback);
        return lastWatcher;
      },
      readFileSync() {
        return settingsRaw;
      },
    },
    syncClawdHooksImpl: () => syncCalls.push("claude"),
    syncGeminiHooksImpl: () => syncCalls.push("gemini"),
    syncCursorHooksImpl: () => syncCalls.push("cursor"),
    syncCodeBuddyHooksImpl: () => syncCalls.push("codebuddy"),
    syncKiroHooksImpl: () => syncCalls.push("kiro"),
    syncKimiHooksImpl: () => syncCalls.push("kimi"),
    syncCodexHooksImpl: () => syncCalls.push("codex"),
    repairCodexHooksImpl: () => syncCalls.push("codex-repair"),
    syncOpencodePluginImpl: () => syncCalls.push("opencode"),
    syncPiExtensionImpl: () => syncCalls.push("pi"),
    syncOpenClawPluginImpl: () => syncCalls.push("openclaw"),
    repairOpenClawPluginImpl: () => syncCalls.push("openclaw-repair"),
    syncHermesPluginImpl: () => syncCalls.push("hermes"),
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

describe("server Claude hook management", () => {
  it("startup syncs Claude hooks and starts watcher when automatic management is enabled", () => {
    const { api, syncCalls, getWatcher } = makeServer({
      manageClaudeHooksAutomatically: true,
    });

    api.startHttpServer();

    assert.deepStrictEqual(syncCalls, ["claude", "gemini", "cursor", "codebuddy", "kiro", "kimi", "codex", "opencode", "pi", "openclaw", "hermes"]);
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

      assert.deepStrictEqual(syncCalls, ["claude", "gemini", "cursor", "codebuddy", "kiro", "kimi", "codex", "opencode", "pi", "openclaw"]);
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

    assert.deepStrictEqual(syncCalls, ["gemini", "cursor", "codebuddy", "kiro", "kimi", "codex", "opencode", "pi", "openclaw", "hermes"]);
    assert.strictEqual(getWatcher(), null);
  });

  it("startup skips automatic hook/plugin sync for disabled agents", () => {
    const disabled = new Set(["gemini-cli", "cursor-agent", "kiro-cli", "opencode", "pi", "openclaw"]);
    const { api, syncCalls, getWatcher } = makeServer({
      isAgentEnabled: (agentId) => !disabled.has(agentId),
    });

    api.startHttpServer();

    assert.deepStrictEqual(syncCalls, ["claude", "codebuddy", "kimi", "codex", "hermes"]);
    assert.ok(getWatcher(), "Claude watcher should still start when Claude is enabled");
  });

  it("startup skips Claude hook sync and watcher when Claude Code is disabled", () => {
    const { api, syncCalls, getWatcher } = makeServer({
      isAgentEnabled: (agentId) => agentId !== "claude-code",
    });

    api.startHttpServer();

    assert.deepStrictEqual(syncCalls, ["gemini", "cursor", "codebuddy", "kiro", "kimi", "codex", "opencode", "pi", "openclaw", "hermes"]);
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

  it("watcher no longer re-syncs after it has been stopped", () => {
    const { api, syncCalls, timers, getWatcher, setSettingsRaw } = makeServer();

    api.startClaudeSettingsWatcher();
    api.stopClaudeSettingsWatcher();
    setSettingsRaw('{"hooks":{}}');
    getWatcher().emitChange("settings.json");
    timers.flush();

    assert.deepStrictEqual(syncCalls, []);
  });

  it("watcher re-syncs when PermissionRequest hook disappears but command hooks remain", () => {
    const { api, syncCalls, timers, getWatcher, setSettingsRaw } = makeServer();

    api.startClaudeSettingsWatcher();
    setSettingsRaw(JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: 'node "/tmp/clawd-hook.js" Stop' }],
          },
        ],
      },
    }));
    getWatcher().emitChange("settings.json");
    timers.flush();

    assert.deepStrictEqual(syncCalls, ["claude"]);
  });

  it("watcher re-syncs when PermissionRequest hook points to the wrong port", () => {
    const { api, syncCalls, timers, getWatcher, setSettingsRaw } = makeServer();

    api.startClaudeSettingsWatcher();
    setSettingsRaw(JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: 'node "/tmp/clawd-hook.js" Stop' }],
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
    timers.flush();

    assert.deepStrictEqual(syncCalls, ["claude"]);
  });

  it("watcher ignores settings changes when both command and PermissionRequest hooks are intact", () => {
    const { api, syncCalls, timers, getWatcher } = makeServer();

    api.startClaudeSettingsWatcher();
    getWatcher().emitChange("settings.json");
    timers.flush();

    assert.deepStrictEqual(syncCalls, []);
  });

  it("watcher does not re-sync missing Claude hooks while Claude Code is disabled", () => {
    let claudeEnabled = true;
    const { api, syncCalls, timers, getWatcher, setSettingsRaw } = makeServer({
      isAgentEnabled: (agentId) => agentId !== "claude-code" || claudeEnabled,
    });

    api.startClaudeSettingsWatcher();
    claudeEnabled = false;
    setSettingsRaw('{"hooks":{}}');
    getWatcher().emitChange("settings.json");
    timers.flush();

    assert.deepStrictEqual(syncCalls, []);
  });

  it("disconnect-style restart does not reinstall Claude hooks when management stays disabled", () => {
    const first = makeServer({ manageClaudeHooksAutomatically: false });
    first.api.startHttpServer();
    first.api.cleanup();

    const second = makeServer({ manageClaudeHooksAutomatically: false });
    second.api.startHttpServer();

    assert.deepStrictEqual(first.syncCalls, ["gemini", "cursor", "codebuddy", "kiro", "kimi", "codex", "opencode", "pi", "openclaw", "hermes"]);
    assert.deepStrictEqual(second.syncCalls, ["gemini", "cursor", "codebuddy", "kiro", "kimi", "codex", "opencode", "pi", "openclaw", "hermes"]);
  });

  it("repairIntegrationForAgent uses the Codex official hook repair path", () => {
    const { api, syncCalls } = makeServer();

    const repaired = api.repairIntegrationForAgent("codex");
    const unsupported = api.repairIntegrationForAgent("copilot-cli");

    assert.strictEqual(repaired, true);
    assert.strictEqual(unsupported, false);
    assert.deepStrictEqual(syncCalls, ["codex-repair"]);
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

  it("resolves Stop to idle when no tool was seen", () => {
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
