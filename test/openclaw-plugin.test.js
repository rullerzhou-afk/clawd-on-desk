"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
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
