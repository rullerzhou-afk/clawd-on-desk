"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function loadPluginModule() {
  const pluginPath = path.join(__dirname, "..", "hooks", "openclaw-plugin", "index.js");
  return import(pathToFileURL(pluginPath).href);
}

function makeRuntime(api, options = {}) {
  const posts = [];
  const timers = [];
  const runtime = api.createOpenClawRuntime({
    postState: (body) => posts.push(body),
    processInfo: {
      source_pid: 101,
      pid_chain: [303, 202, 101],
      editor: "code",
    },
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer) timer.cleared = true;
    },
    ...options,
  });
  return { runtime, posts, timers };
}

const FORBIDDEN_POST_FIELDS = [
  "params",
  "derivedPaths",
  "result",
  "error",
  "message",
  "messages",
  "prompt",
  "systemPrompt",
  "historyMessages",
  "model_input",
  "model_output",
];

let nextMtimeMs = Date.now();

function bumpMtime(filePath) {
  nextMtimeMs += 2000;
  const mtime = new Date(nextMtimeMs);
  fs.utimesSync(filePath, mtime, mtime);
}

function writeOpenClawConfigFile(configPath, config) {
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
  bumpMtime(configPath);
}

function writeOpenClawConfigRaw(configPath, raw) {
  fs.writeFileSync(configPath, raw, "utf8");
  bumpMtime(configPath);
}

function writeOpenClawConfig(config, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-openclaw-plugin-"));
  const stateDir = options.stateDir ? path.join(root, options.stateDir) : root;
  fs.mkdirSync(stateDir, { recursive: true });
  const configPath = path.join(stateDir, "openclaw.json");
  writeOpenClawConfigFile(configPath, config);
  return { root, stateDir, configPath };
}

async function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("openclaw plugin runtime", () => {
  it("keeps the runtime free of child_process so OpenClaw install scan accepts it", () => {
    const pluginPath = path.join(__dirname, "..", "hooks", "openclaw-plugin", "index.js");
    const source = fs.readFileSync(pluginPath, "utf8");

    assert.strictEqual(source.includes("child_process"), false);
    assert.strictEqual(source.includes("execSync"), false);
  });

  it("registers a plain-object OpenClaw plugin without SDK imports", async () => {
    const api = await loadPluginModule();
    const registrations = [];

    api.default.register({
      on(name, handler, opts) {
        registrations.push({ name, handler, opts });
      },
    });

    assert.strictEqual(api.default.id, "clawd-on-desk");
    assert.ok(registrations.some((entry) => entry.name === "before_tool_call"));
    assert.ok(registrations.some((entry) => entry.name === "model_call_ended"));
  });

  it("redacts raw tool payload fields from state posts", async () => {
    const api = await loadPluginModule();
    const { runtime, posts } = makeRuntime(api);

    runtime.handleHook(
      "before_tool_call",
      {
        toolName: "shell",
        params: { command: "cat secret.txt" },
        derivedPaths: ["D:/secret.txt"],
        message: "single secret message",
        messages: [{ content: "secret conversation" }],
        prompt: "secret prompt",
        systemPrompt: "secret system prompt",
        historyMessages: [{ content: "secret history" }],
        model_input: "secret model input",
        model_output: "secret model output",
        toolCallId: "tool-1",
        runId: "run-1",
      },
      { sessionId: "session-1", workspaceDir: "D:/repo", toolName: "shell" },
    );

    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].agent_id, "openclaw");
    assert.strictEqual(posts[0].hook_source, "openclaw-plugin");
    assert.strictEqual(posts[0].state, "working");
    assert.strictEqual(posts[0].event, "PreToolUse");
    assert.strictEqual(posts[0].session_id, "session-1");
    assert.strictEqual(posts[0].cwd, "D:/repo");
    assert.strictEqual(posts[0].tool_name, "shell");
    assert.strictEqual(posts[0].tool_use_id, "tool-1");
    assert.strictEqual(posts[0].source_pid, 101);
    assert.deepStrictEqual(posts[0].pid_chain, [303, 202, 101]);
    assert.strictEqual(posts[0].editor, "code");
    for (const field of FORBIDDEN_POST_FIELDS) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(posts[0], field), false, `${field} leaked`);
    }
  });

  it("redacts after_tool_call result and error strings while preserving error_present", async () => {
    const api = await loadPluginModule();
    const { runtime, posts } = makeRuntime(api);

    runtime.handleHook(
      "after_tool_call",
      {
        toolName: "read_file",
        params: { path: "secret.txt" },
        result: "secret output",
        error: "ENOENT secret.txt",
        message: "secret message",
        model_output: "secret model output",
        toolCallId: "tool-2",
      },
      { sessionId: "session-1" },
    );

    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].state, "error");
    assert.strictEqual(posts[0].event, "PostToolUseFailure");
    assert.strictEqual(posts[0].error_present, true);
    for (const field of FORBIDDEN_POST_FIELDS) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(posts[0], field), false, `${field} leaked`);
    }
  });

  it("uses OpenClaw agent display name from OPENCLAW_CONFIG_PATH", async () => {
    const api = await loadPluginModule();
    const { root, configPath } = writeOpenClawConfig({
      agents: {
        list: [
          {
            id: "vultr-ops",
            name: "Fallback Name",
            identity: { name: "Vultr Admin", emoji: "OC" },
          },
        ],
      },
    });

    try {
      await withEnv({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: undefined }, async () => {
        const { runtime, posts } = makeRuntime(api);

        runtime.handleHook("session_start", {
          sessionKey: "agent:vultr-ops:tui:run-1",
        });

        assert.strictEqual(posts.length, 1);
        assert.strictEqual(posts[0].session_title, "OC Vultr Admin");
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses OPENCLAW_STATE_DIR and falls back to agent id when no display entry exists", async () => {
    const api = await loadPluginModule();
    const { root, stateDir } = writeOpenClawConfig({
      agents: {
        list: [
          { id: "router-admin", identity: { name: "Router Admin" } },
        ],
      },
    }, { stateDir: ".openclaw" });

    try {
      await withEnv({ OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: stateDir }, async () => {
        const { runtime, posts } = makeRuntime(api);

        runtime.handleHook("session_start", {
          sessionKey: "agent:vultr-ops:tui:run-1",
        });

        assert.strictEqual(posts.length, 1);
        assert.strictEqual(posts[0].session_title, "vultr-ops");
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes and truncates OpenClaw session_title before posting", async () => {
    const api = await loadPluginModule();
    const { root, configPath } = writeOpenClawConfig({
      agents: {
        list: [
          {
            id: "long-agent",
            identity: {
              name: `  Fix\tlogin\nbug ${"x".repeat(120)}  `,
              emoji: "OC",
            },
          },
        ],
      },
    });

    try {
      await withEnv({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: undefined }, async () => {
        const { runtime, posts } = makeRuntime(api);

        runtime.handleHook("session_start", {
          sessionKey: "agent:long-agent:tui:run-1",
        });

        assert.strictEqual(posts.length, 1);
        assert.strictEqual(posts[0].session_title.length, 80);
        assert.strictEqual(posts[0].session_title.startsWith("OC Fix login bug "), true);
        assert.strictEqual(posts[0].session_title.endsWith("\u2026"), true);
        assert.strictEqual(/[\u0000-\u001F\u007F-\u009F]/.test(posts[0].session_title), false);
        assert.ok(Buffer.byteLength(JSON.stringify(posts[0]), "utf8") < 4096);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes configured id fallback when display fields collapse to empty", async () => {
    const api = await loadPluginModule();
    const { root, configPath } = writeOpenClawConfig({
      agents: {
        list: [
          {
            id: "bad\u0000id",
            name: "\n",
            identity: { name: "\u0000\t" },
          },
        ],
      },
    });

    try {
      await withEnv({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: undefined }, async () => {
        const { runtime, posts } = makeRuntime(api);

        runtime.handleHook("session_start", {
          sessionKey: "agent:bad\u0000id:tui:run-1",
        });

        assert.strictEqual(posts.length, 1);
        assert.strictEqual(posts[0].session_title, "bad id");
        assert.strictEqual(/[\u0000-\u001F\u007F-\u009F]/.test(posts[0].session_title), false);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not split UTF-16 surrogate pairs when truncating session_title", async () => {
    const api = await loadPluginModule();
    const { root, configPath } = writeOpenClawConfig({
      agents: {
        list: [
          {
            id: "emoji-boundary",
            identity: { name: `${"a".repeat(78)}\u{1F600}tail` },
          },
        ],
      },
    });

    try {
      await withEnv({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: undefined }, async () => {
        const { runtime, posts } = makeRuntime(api);

        runtime.handleHook("session_start", {
          sessionKey: "agent:emoji-boundary:tui:run-1",
        });

        assert.strictEqual(posts.length, 1);
        assert.strictEqual(posts[0].session_title, `${"a".repeat(78)}\u2026`);
        assert.strictEqual(/[\uD800-\uDFFF]/.test(posts[0].session_title), false);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshes cached agent titles when the config mtime changes", async () => {
    const api = await loadPluginModule();
    const { root, configPath } = writeOpenClawConfig({
      agents: { list: [{ id: "cache-agent", identity: { name: "Before" } }] },
    });

    try {
      await withEnv({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: undefined }, async () => {
        const { runtime, posts } = makeRuntime(api);

        runtime.handleHook("session_start", { sessionKey: "agent:cache-agent:tui:run-1" });
        writeOpenClawConfigFile(configPath, {
          agents: { list: [{ id: "cache-agent", identity: { name: "After" } }] },
        });
        runtime.handleHook("session_start", { sessionKey: "agent:cache-agent:tui:run-2" });

        assert.deepStrictEqual(posts.map((entry) => entry.session_title), ["Before", "After"]);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps same-path cached titles through a transient parse failure", async () => {
    const api = await loadPluginModule();
    const { root, configPath } = writeOpenClawConfig({
      agents: { list: [{ id: "stable-agent", identity: { name: "Stable" } }] },
    });

    try {
      await withEnv({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: undefined }, async () => {
        const { runtime, posts } = makeRuntime(api);

        runtime.handleHook("session_start", { sessionKey: "agent:stable-agent:tui:run-1" });
        writeOpenClawConfigRaw(configPath, "{");
        runtime.handleHook("session_start", { sessionKey: "agent:stable-agent:tui:run-2" });

        assert.deepStrictEqual(posts.map((entry) => entry.session_title), ["Stable", "Stable"]);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses fallback id while config is missing and reloads after it is recreated", async () => {
    const api = await loadPluginModule();
    const { root, configPath } = writeOpenClawConfig({
      agents: { list: [{ id: "recreate-agent", identity: { name: "Before Delete" } }] },
    });

    try {
      await withEnv({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: undefined }, async () => {
        const { runtime, posts } = makeRuntime(api);

        runtime.handleHook("session_start", { sessionKey: "agent:recreate-agent:tui:run-1" });
        fs.unlinkSync(configPath);
        runtime.handleHook("session_start", { sessionKey: "agent:recreate-agent:tui:run-2" });
        writeOpenClawConfigFile(configPath, {
          agents: { list: [{ id: "recreate-agent", identity: { name: "After Recreate" } }] },
        });
        runtime.handleHook("session_start", { sessionKey: "agent:recreate-agent:tui:run-3" });

        assert.deepStrictEqual(
          posts.map((entry) => entry.session_title),
          ["Before Delete", "recreate-agent", "After Recreate"]
        );
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalidates the agent title cache when OPENCLAW_CONFIG_PATH changes", async () => {
    const api = await loadPluginModule();
    const first = writeOpenClawConfig({
      agents: { list: [{ id: "switch-agent", identity: { name: "First Config" } }] },
    });
    const second = writeOpenClawConfig({
      agents: { list: [{ id: "switch-agent", identity: { name: "Second Config" } }] },
    });

    try {
      await withEnv({ OPENCLAW_CONFIG_PATH: first.configPath, OPENCLAW_STATE_DIR: undefined }, async () => {
        const { runtime, posts } = makeRuntime(api);

        runtime.handleHook("session_start", { sessionKey: "agent:switch-agent:tui:run-1" });
        process.env.OPENCLAW_CONFIG_PATH = second.configPath;
        runtime.handleHook("session_start", { sessionKey: "agent:switch-agent:tui:run-2" });

        assert.deepStrictEqual(posts.map((entry) => entry.session_title), ["First Config", "Second Config"]);
      });
    } finally {
      fs.rmSync(first.root, { recursive: true, force: true });
      fs.rmSync(second.root, { recursive: true, force: true });
    }
  });

  it("falls back to normalized id for malformed agents.list", async () => {
    const api = await loadPluginModule();
    const { root, configPath } = writeOpenClawConfig({
      agents: { list: {} },
    });

    try {
      await withEnv({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: undefined }, async () => {
        const { runtime, posts } = makeRuntime(api);

        runtime.handleHook("session_start", {
          sessionKey: "agent:malformed\u0000agent:tui:run-1",
        });

        assert.strictEqual(posts.length, 1);
        assert.strictEqual(posts[0].session_title, "malformed agent");
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("debounces successful model_call_ended and cancels it on new activity", async () => {
    const api = await loadPluginModule();
    const { runtime, posts, timers } = makeRuntime(api);

    runtime.handleHook("model_call_ended", {
      outcome: "completed",
      sessionId: "session-1",
      runId: "run-1",
    });

    assert.strictEqual(posts.length, 0);
    assert.strictEqual(runtime.pendingStopCount(), 1);
    assert.strictEqual(timers[0].ms, api.STOP_DEBOUNCE_MS);

    runtime.handleHook("before_tool_call", {
      toolName: "shell",
      sessionId: "session-1",
      runId: "run-1",
    });

    assert.strictEqual(timers[0].cleared, true);
    assert.strictEqual(runtime.pendingStopCount(), 0);
    assert.deepStrictEqual(posts.map((entry) => entry.event), ["PreToolUse"]);
  });

  it("emits debounced Stop when no new activity arrives", async () => {
    const api = await loadPluginModule();
    const { runtime, posts, timers } = makeRuntime(api);

    runtime.handleHook("model_call_ended", {
      outcome: "completed",
      sessionId: "session-1",
      runId: "run-1",
    });
    timers[0].fn();

    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].state, "attention");
    assert.strictEqual(posts[0].event, "Stop");
    assert.strictEqual(runtime.pendingStopCount(), 0);
  });

  it("maps aborted and terminated model failures to non-error Stop", async () => {
    const api = await loadPluginModule();
    const { runtime, posts } = makeRuntime(api);

    runtime.handleHook("model_call_ended", {
      outcome: "error",
      failureKind: "aborted",
      sessionId: "session-1",
    });
    runtime.handleHook("model_call_ended", {
      outcome: "error",
      failureKind: "terminated",
      sessionId: "session-2",
    });

    assert.deepStrictEqual(posts.map((entry) => [entry.state, entry.event, entry.error_present]), [
      ["attention", "Stop", false],
      ["attention", "Stop", false],
    ]);
  });

  it("maps transport model failures to StopFailure", async () => {
    const api = await loadPluginModule();
    const { runtime, posts } = makeRuntime(api);

    runtime.handleHook("model_call_ended", {
      outcome: "error",
      failureKind: "timeout",
      sessionId: "session-1",
    });

    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].state, "error");
    assert.strictEqual(posts[0].event, "StopFailure");
    assert.strictEqual(posts[0].error_present, true);
  });

  it("branches session_end by reason", async () => {
    const api = await loadPluginModule();
    const { runtime, posts } = makeRuntime(api);

    runtime.handleHook("session_end", { sessionId: "session-1", reason: "compaction" });
    runtime.handleHook("session_end", { sessionId: "session-2", reason: "idle" });
    runtime.handleHook("session_end", { sessionId: "session-3", reason: "deleted" });

    assert.deepStrictEqual(posts.map((entry) => [entry.session_id, entry.state, entry.event, entry.session_end_reason]), [
      ["session-2", "sleeping", "SessionEnd", "idle"],
      ["session-3", "sleeping", "SessionEnd", "deleted"],
    ]);
  });
});
