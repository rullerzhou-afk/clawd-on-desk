"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const initServer = require("../src/server");
const { resolveCodexOfficialHookState } = require("../src/server").__test;

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
    syncOpencodePluginImpl: () => syncCalls.push("opencode"),
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

    assert.deepStrictEqual(syncCalls, ["claude", "gemini", "cursor", "codebuddy", "kiro", "kimi", "codex", "opencode"]);
    assert.ok(getWatcher(), "watcher should start when management is enabled");
  });

  it("startup skips Claude sync/watcher but still syncs other agents when automatic management is disabled", () => {
    const { api, syncCalls, getWatcher } = makeServer({
      manageClaudeHooksAutomatically: false,
    });

    api.startHttpServer();

    assert.deepStrictEqual(syncCalls, ["gemini", "cursor", "codebuddy", "kiro", "kimi", "codex", "opencode"]);
    assert.strictEqual(getWatcher(), null);
  });

  it("startup skips automatic hook/plugin sync for disabled agents", () => {
    const disabled = new Set(["gemini-cli", "cursor-agent", "kiro-cli", "opencode"]);
    const { api, syncCalls, getWatcher } = makeServer({
      isAgentEnabled: (agentId) => !disabled.has(agentId),
    });

    api.startHttpServer();

    assert.deepStrictEqual(syncCalls, ["claude", "codebuddy", "kimi", "codex"]);
    assert.ok(getWatcher(), "Claude watcher should still start when Claude is enabled");
  });

  it("startup skips Claude hook sync and watcher when Claude Code is disabled", () => {
    const { api, syncCalls, getWatcher } = makeServer({
      isAgentEnabled: (agentId) => agentId !== "claude-code",
    });

    api.startHttpServer();

    assert.deepStrictEqual(syncCalls, ["gemini", "cursor", "codebuddy", "kiro", "kimi", "codex", "opencode"]);
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

    assert.deepStrictEqual(first.syncCalls, ["gemini", "cursor", "codebuddy", "kiro", "kimi", "codex", "opencode"]);
    assert.deepStrictEqual(second.syncCalls, ["gemini", "cursor", "codebuddy", "kiro", "kimi", "codex", "opencode"]);
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
    assert.strictEqual(turns.has("turn-1"), false);
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
    const turns = new Map([["turn-1", { sessionId: "codex:s1", hadToolUse: true }]]);

    const result = resolveCodexOfficialHookState({
      agent_id: "codex",
      hook_source: "codex-official",
      event: "Stop",
      session_id: "codex:s1",
      turn_id: "turn-1",
      stop_hook_active: true,
    }, "idle", turns);

    assert.deepStrictEqual(result, { state: "idle", drop: true });
    assert.strictEqual(turns.has("turn-1"), false);
  });
});
