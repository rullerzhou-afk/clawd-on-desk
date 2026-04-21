const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  buildStateBody,
  PERMISSION_TOOLS,
  DEFAULT_PERMISSION_TOOLS,
  resolvePermissionTools,
  shouldRemapPreToolToPermission,
  classifyPreTool,
} = require("../hooks/kimi-hook");

describe("Kimi hook script", () => {
  it("maps PreToolUse for permission tools to notification when payload marks approval", () => {
    const resolve = () => ({
      stablePid: 12345,
      agentPid: 67890,
      detectedEditor: null,
      pidChain: [67890, 12345],
    });

    // Test both PascalCase (Claude-style) and snake_case (Kimi CLI actual)
    const testNames = [
      ...PERMISSION_TOOLS,                        // normalized form (shell, writefile...)
      "Shell", "WriteFile", "StrReplaceFile",      // PascalCase
      "shell", "write_file", "str_replace_file",  // snake_case
    ];
    for (const toolName of testNames) {
      const body = buildStateBody(
        "PreToolUse",
        { session_id: "test-sid", cwd: "/tmp", tool_name: toolName, permission_required: true },
        resolve
      );
      assert.strictEqual(body.state, "notification", `tool ${toolName} should map to notification`);
      assert.strictEqual(body.event, "PermissionRequest", `tool ${toolName} should remap event to PermissionRequest`);
      assert.strictEqual(body.agent_id, "kimi-cli");
    }
  });

  it("reads event from hook_event_name (Kimi CLI format)", () => {
    const resolve = () => ({ stablePid: null, agentPid: null, detectedEditor: null, pidChain: [] });
    const body = buildStateBody(
      "PreToolUse",
      {
        hook_event_name: "PreToolUse",
        session_id: "test-sid",
        cwd: "/tmp",
        tool_name: "shell",
        requires_approval: true,
      },
      resolve
    );
    assert.strictEqual(body.state, "notification");
    assert.strictEqual(body.event, "PermissionRequest");
  });

  it("maps PreToolUse for non-permission tools to working", () => {
    const resolve = () => ({
      stablePid: 12345,
      agentPid: null,
      detectedEditor: null,
      pidChain: [],
    });

    const body = buildStateBody(
      "PreToolUse",
      { session_id: "test-sid", cwd: "/tmp", tool_name: "ReadFile" },
      resolve
    );
    assert.strictEqual(body.state, "working");
  });

  it("defaults to suspect (working + permission_suspect) for permission tools without explicit signal", () => {
    const oldDisable = process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION;
    const oldImmediate = process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE;
    try {
      delete process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION;
      delete process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE;
      const resolve = () => ({
        stablePid: 12345,
        agentPid: null,
        detectedEditor: null,
        pidChain: [],
      });
      const body = buildStateBody(
        "PreToolUse",
        { session_id: "test-sid", cwd: "/tmp", tool_name: "shell" },
        resolve
      );
      // Default path must NOT flash notification immediately — we let
      // state.js defer-promote only if no PostToolUse arrives in time.
      assert.strictEqual(body.state, "working");
      assert.strictEqual(body.event, "PreToolUse");
      assert.strictEqual(body.permission_suspect, true);
      assert.strictEqual(
        classifyPreTool("PreToolUse", { tool_name: "shell" }),
        "suspect"
      );
    } finally {
      if (oldDisable == null) delete process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION;
      else process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION = oldDisable;
      if (oldImmediate == null) delete process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE;
      else process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE = oldImmediate;
    }
  });

  it("CLAWD_KIMI_PERMISSION_IMMEDIATE=1 restores legacy instant notification mapping", () => {
    const oldImmediate = process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE;
    try {
      process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE = "1";
      const resolve = () => ({
        stablePid: 12345,
        agentPid: null,
        detectedEditor: null,
        pidChain: [],
      });
      const body = buildStateBody(
        "PreToolUse",
        { session_id: "test-sid", cwd: "/tmp", tool_name: "shell" },
        resolve
      );
      assert.strictEqual(body.state, "notification");
      assert.strictEqual(body.event, "PermissionRequest");
      assert.notStrictEqual(body.permission_suspect, true);
      assert.strictEqual(
        classifyPreTool("PreToolUse", { tool_name: "shell" }),
        "immediate"
      );
    } finally {
      if (oldImmediate == null) delete process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE;
      else process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE = oldImmediate;
    }
  });

  it("keeps PreToolUse as working without permission_suspect when disable env is set", () => {
    const old = process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION;
    try {
      process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION = "1";
      const resolve = () => ({
        stablePid: 12345,
        agentPid: null,
        detectedEditor: null,
        pidChain: [],
      });
      const body = buildStateBody(
        "PreToolUse",
        { session_id: "test-sid", cwd: "/tmp", tool_name: "shell" },
        resolve
      );
      assert.strictEqual(body.state, "working");
      assert.strictEqual(body.event, "PreToolUse");
      assert.notStrictEqual(body.permission_suspect, true);
    } finally {
      if (old == null) delete process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION;
      else process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION = old;
    }
  });

  it("still remaps to PermissionRequest when disable env is set but payload is explicit", () => {
    const old = process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION;
    try {
      process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION = "1";
      const resolve = () => ({
        stablePid: 12345,
        agentPid: null,
        detectedEditor: null,
        pidChain: [],
      });
      const body = buildStateBody(
        "PreToolUse",
        {
          session_id: "test-sid",
          cwd: "/tmp",
          tool_name: "shell",
          permission_required: true,
        },
        resolve
      );
      assert.strictEqual(body.state, "notification");
      assert.strictEqual(body.event, "PermissionRequest");
    } finally {
      if (old == null) delete process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION;
      else process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION = old;
    }
  });

  it("maps SessionStart to idle", () => {
    const resolve = () => ({
      stablePid: null,
      agentPid: null,
      detectedEditor: null,
      pidChain: [],
    });

    const body = buildStateBody(
      "SessionStart",
      { session_id: "test-sid", cwd: "/tmp", source: "user" },
      resolve
    );
    assert.strictEqual(body.state, "idle");
    assert.strictEqual(body.event, "SessionStart");
  });

  it("maps SessionEnd to sleeping", () => {
    const resolve = () => ({ stablePid: null, agentPid: null, detectedEditor: null, pidChain: [] });
    const body = buildStateBody("SessionEnd", { session_id: "test-sid", cwd: "/tmp" }, resolve);
    assert.strictEqual(body.state, "sleeping");
  });

  it("maps Notification to notification", () => {
    const resolve = () => ({ stablePid: null, agentPid: null, detectedEditor: null, pidChain: [] });
    const body = buildStateBody("Notification", { session_id: "test-sid", cwd: "/tmp" }, resolve);
    assert.strictEqual(body.state, "notification");
  });

  it("maps SubagentStart to juggling", () => {
    const resolve = () => ({ stablePid: null, agentPid: null, detectedEditor: null, pidChain: [] });
    const body = buildStateBody("SubagentStart", { session_id: "test-sid", cwd: "/tmp" }, resolve);
    assert.strictEqual(body.state, "juggling");
  });

  it("maps PostToolUse to working", () => {
    const resolve = () => ({
      stablePid: null,
      agentPid: null,
      detectedEditor: null,
      pidChain: [],
    });

    const body = buildStateBody(
      "PostToolUse",
      { session_id: "test-sid", cwd: "/tmp", tool_name: "Shell" },
      resolve
    );
    assert.strictEqual(body.state, "working");
  });

  it("maps Stop to attention", () => {
    const resolve = () => ({
      stablePid: null,
      agentPid: null,
      detectedEditor: null,
      pidChain: [],
    });

    const body = buildStateBody(
      "Stop",
      { session_id: "test-sid", cwd: "/tmp" },
      resolve
    );
    assert.strictEqual(body.state, "attention");
  });

  it("returns null for unknown events", () => {
    const resolve = () => ({
      stablePid: null,
      agentPid: null,
      detectedEditor: null,
      pidChain: [],
    });

    const body = buildStateBody("UnknownEvent", {}, resolve);
    assert.strictEqual(body, null);
  });

  it("includes PID info from resolver", () => {
    const resolve = () => ({
      stablePid: 11111,
      agentPid: 22222,
      detectedEditor: "code",
      pidChain: [22222, 11111],
    });

    const body = buildStateBody(
      "UserPromptSubmit",
      { session_id: "test-sid", cwd: "/tmp", prompt: "hello" },
      resolve
    );
    assert.strictEqual(body.source_pid, 11111);
    assert.strictEqual(body.agent_pid, 22222);
    assert.strictEqual(body.kimi_pid, 22222);
    assert.strictEqual(body.editor, "code");
    assert.deepStrictEqual(body.pid_chain, [22222, 11111]);
  });

  it("allows overriding permission tools through env parser", () => {
    const old = process.env.CLAWD_KIMI_PERMISSION_TOOLS;
    try {
      delete process.env.CLAWD_KIMI_PERMISSION_TOOLS;
      assert.deepStrictEqual([...resolvePermissionTools()], DEFAULT_PERMISSION_TOOLS);

      process.env.CLAWD_KIMI_PERMISSION_TOOLS = "shell,ask_user_question";
      assert.deepStrictEqual([...resolvePermissionTools()], ["shell", "askuserquestion"]);
    } finally {
      if (old == null) delete process.env.CLAWD_KIMI_PERMISSION_TOOLS;
      else process.env.CLAWD_KIMI_PERMISSION_TOOLS = old;
    }
  });

  it("classifyPreTool: default / immediate / disable / explicit matrix", () => {
    const oldDisable = process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION;
    const oldImmediate = process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE;
    try {
      delete process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION;
      delete process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE;

      // Non-permission tools are classified as "none" (no signal at all).
      assert.strictEqual(
        classifyPreTool("PreToolUse", { tool_name: "read_file" }),
        "none"
      );
      // Default: gated tools → suspect (defer notification to state.js).
      assert.strictEqual(
        classifyPreTool("PreToolUse", { tool_name: "shell" }),
        "suspect"
      );
      // shouldRemapPreToolToPermission() is the "flash notification right
      // now" predicate — suspect should NOT trigger it.
      assert.strictEqual(
        shouldRemapPreToolToPermission("PreToolUse", { tool_name: "shell" }),
        false
      );

      // Disable: suspect turns into none (no animation at all unless payload
      // explicitly says so).
      process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION = "1";
      assert.strictEqual(
        classifyPreTool("PreToolUse", { tool_name: "shell" }),
        "none"
      );
      // Explicit signal wins even with disable on.
      assert.strictEqual(
        classifyPreTool("PreToolUse", {
          tool_name: "shell",
          permission_required: true,
        }),
        "immediate"
      );
      delete process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION;

      // Immediate legacy switch: gated tools → immediate unconditionally.
      process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE = "1";
      assert.strictEqual(
        classifyPreTool("PreToolUse", { tool_name: "shell" }),
        "immediate"
      );
      assert.strictEqual(
        shouldRemapPreToolToPermission("PreToolUse", { tool_name: "shell" }),
        true
      );
    } finally {
      if (oldDisable == null) delete process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION;
      else process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION = oldDisable;
      if (oldImmediate == null) delete process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE;
      else process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE = oldImmediate;
    }
  });
});
