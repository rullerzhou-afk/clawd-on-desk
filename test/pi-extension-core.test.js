"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const core = require("../hooks/pi-extension-core");

function makeCtx(overrides = {}) {
  return {
    hasUI: true,
    cwd: "D:/work/project",
    sessionManager: {
      getSessionId: () => "session-1",
    },
    ...overrides,
  };
}

describe("pi-extension-core", () => {
  it("detects non-interactive Pi modes from argv", () => {
    assert.strictEqual(core.parseMode(["node", "pi"]), "interactive");
    assert.strictEqual(core.parseMode(["node", "pi", "-p"]), "print");
    assert.strictEqual(core.parseMode(["node", "pi", "--print"]), "print");
    assert.strictEqual(core.parseMode(["node", "pi", "--mode", "rpc"]), "rpc");
    assert.strictEqual(core.parseMode(["node", "pi", "--mode=json"]), "json");
  });

  it("uses ctx.hasUI when Pi provides it", () => {
    assert.strictEqual(core.shouldReport({ hasUI: true }), true);
    assert.strictEqual(core.shouldReport({ hasUI: false }), false);
  });

  it("falls back to TTY detection when ctx.hasUI is unavailable", () => {
    assert.strictEqual(core.shouldReport({}, {
      argv: ["node", "pi"],
      stdin: { isTTY: true },
      stdout: { isTTY: true },
    }), true);
    assert.strictEqual(core.shouldReport({}, {
      argv: ["node", "pi", "--mode", "rpc"],
      stdin: { isTTY: true },
      stdout: { isTTY: true },
    }), false);
  });

  it("builds a generic Clawd /state payload with Pi session and pid fields", () => {
    const payload = core.buildPayload({
      state: "working",
      event: "PreToolUse",
      nativeEvent: {
        toolName: "bash",
        toolCallId: "tool-1",
      },
      ctx: makeCtx(),
      metadata: {
        cwd: "D:/work/project",
        sourcePid: 1234,
        pidChain: [3333, 2222, 1234],
        editor: "cursor",
      },
      agentPid: 3333,
    });

    assert.deepStrictEqual(payload, {
      agent_id: "pi",
      hook_source: "pi-extension",
      event: "PreToolUse",
      state: "working",
      session_id: "pi:session-1",
      agent_pid: 3333,
      cwd: "D:/work/project",
      source_pid: 1234,
      pid_chain: [3333, 2222, 1234],
      editor: "cursor",
      tool_name: "bash",
      tool_use_id: "tool-1",
    });
  });

  it("falls back to a default session id when Pi session metadata is unavailable", () => {
    const payload = core.buildPayload({
      state: "idle",
      event: "SessionStart",
      ctx: makeCtx({ sessionManager: {} }),
    });

    assert.strictEqual(payload.session_id, "pi:default");
  });

  it("registers Pi lifecycle handlers and maps them to Clawd events", async () => {
    const handlers = {};
    const pi = {
      on(name, handler) {
        handlers[name] = handler;
      },
    };
    const posts = [];
    core.attach(pi, {
      shouldReport: (ctx) => ctx && ctx.hasUI,
      buildPayload: ({ state, event, nativeEvent, ctx }) => core.buildPayload({
        state,
        event,
        nativeEvent,
        ctx,
        agentPid: 999,
      }),
      postState: async (payload) => {
        posts.push(payload);
        return true;
      },
    });

    handlers.session_start({ type: "session_start" }, makeCtx());
    handlers.before_agent_start({ type: "before_agent_start" }, makeCtx());
    handlers.tool_call({ type: "tool_call", toolName: "read", toolCallId: "tool-2" }, makeCtx());
    await handlers.agent_end({ type: "agent_end" }, makeCtx());
    await Promise.resolve();

    assert.deepStrictEqual(
      posts.map((payload) => [payload.event, payload.state]),
      [
        ["SessionStart", "idle"],
        ["UserPromptSubmit", "thinking"],
        ["PreToolUse", "working"],
        ["Stop", "attention"],
      ]
    );
    assert.deepStrictEqual(posts[2].tool_name, "read");
    assert.strictEqual(posts[0].agent_pid, 999);
  });

  it("reports mutating tool calls as state only and never asks for permission", async () => {
    const handlers = {};
    const pi = {
      on(name, handler) {
        handlers[name] = handler;
      },
    };
    const posts = [];
    core.attach(pi, {
      shouldReport: () => true,
      buildPayload: ({ state, event, nativeEvent, ctx }) => core.buildPayload({
        state,
        event,
        nativeEvent,
        ctx,
      }),
      postState: (payload) => {
        posts.push(payload);
        return true;
      },
    });

    const result = await handlers.tool_call({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "tool-bash",
      input: { command: "echo ok" },
    }, makeCtx());
    await Promise.resolve();

    assert.strictEqual(result, undefined);
    assert.deepStrictEqual(posts.map((payload) => [payload.event, payload.state, payload.tool_name]), [
      ["PreToolUse", "working", "bash"],
    ]);
  });

  it("does not block Pi tools if state reporting fails", async () => {
    const handlers = {};
    const pi = {
      on(name, handler) {
        handlers[name] = handler;
      },
    };
    core.attach(pi, {
      shouldReport: () => true,
      buildPayload: () => {
        throw new Error("metadata failed");
      },
      postState: () => true,
    });

    const result = await handlers.tool_call({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "tool-bash",
      input: { command: "echo ok" },
    }, makeCtx());
    await Promise.resolve();

    assert.strictEqual(result, undefined);
  });

  it("maps tool_result errors separately from successful tool results", async () => {
    const handlers = {};
    const pi = {
      on(name, handler) {
        handlers[name] = handler;
      },
    };
    const posts = [];
    core.attach(pi, {
      shouldReport: () => true,
      buildPayload: ({ state, event, nativeEvent, ctx }) => core.buildPayload({
        state,
        event,
        nativeEvent,
        ctx,
      }),
      postState: async (payload) => {
        posts.push(payload);
        return true;
      },
    });

    handlers.tool_result({ type: "tool_result", isError: false }, makeCtx());
    await handlers.tool_result({ type: "tool_result", isError: true }, makeCtx());
    await Promise.resolve();

    assert.deepStrictEqual(
      posts.map((payload) => [payload.event, payload.state]),
      [
        ["PostToolUse", "working"],
        ["PostToolUseFailure", "error"],
      ]
    );
  });

  it("preserves per-session delivery ordering for awaited posts", async () => {
    const handlers = {};
    const pi = {
      on(name, handler) {
        handlers[name] = handler;
      },
    };
    const posts = [];
    const pending = [];
    core.attach(pi, {
      shouldReport: () => true,
      buildPayload: ({ state, event, nativeEvent, ctx }) => core.buildPayload({
        state,
        event,
        nativeEvent,
        ctx,
      }),
      postState: (payload) => new Promise((resolve) => {
        posts.push(payload);
        pending.push(resolve);
      }),
    });

    const first = handlers.tool_result({
      type: "tool_result",
      toolName: "bash",
      toolCallId: "first",
      isError: true,
    }, makeCtx());
    const second = handlers.tool_result({
      type: "tool_result",
      toolName: "bash",
      toolCallId: "second",
      isError: true,
    }, makeCtx());
    await Promise.resolve();
    await Promise.resolve();

    assert.deepStrictEqual(posts.map((payload) => payload.tool_use_id), ["first"]);
    pending[0](true);
    await first;
    await Promise.resolve();
    await Promise.resolve();

    assert.deepStrictEqual(posts.map((payload) => payload.tool_use_id), ["first", "second"]);
    pending[1](true);
    await second;
  });

  it("does not report events when Pi runs without interactive UI", () => {
    const handlers = {};
    const pi = {
      on(name, handler) {
        handlers[name] = handler;
      },
    };
    const posts = [];
    core.attach(pi, {
      shouldReport: () => false,
      postState: (payload) => posts.push(payload),
    });

    const result = handlers.session_start({ type: "session_start" }, makeCtx({ hasUI: false }));

    assert.strictEqual(result, false);
    assert.deepStrictEqual(posts, []);
  });
});
