const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildStateBody,
  PERMISSION_TOOLS,
  DEFAULT_PERMISSION_TOOLS,
  resolvePermissionTools,
  shouldRemapPreToolToPermission,
  classifyPreTool,
  isExplicitPermissionSignal,
  readToolName,
  hasKeywordPermissionSignal,
  readPermissionMode,
  MODE_EXPLICIT,
  MODE_SUSPECT,
  readHookDebugMaxBytes,
  appendHookDebug,
  DEFAULT_HOOK_DEBUG_MAX_BYTES,
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

  it("supports camelCase toolName and explicit permission flags", () => {
    const resolve = () => ({ stablePid: null, agentPid: null, detectedEditor: null, pidChain: [] });
    const body = buildStateBody(
      "PreToolUse",
      {
        hook_event_name: "PreToolUse",
        session_id: "test-sid",
        cwd: "/tmp",
        toolName: "WriteFile",
        requiresApproval: true,
      },
      resolve
    );
    assert.strictEqual(body.state, "notification");
    assert.strictEqual(body.event, "PermissionRequest");
  });

  it("treats string-form waiting status as explicit permission signal", () => {
    assert.strictEqual(
      isExplicitPermissionSignal({
        permission_status: "waiting_for_approval",
      }),
      true
    );
    assert.strictEqual(
      isExplicitPermissionSignal({
        approval: { status: "awaiting_approval" },
      }),
      true
    );
  });

  it("recognizes unknown permission-key payload shapes via keyword fallback", () => {
    assert.strictEqual(
      hasKeywordPermissionSignal({
        check: { approvalFlowState: "pending_user_confirm" },
      }),
      true
    );
    assert.strictEqual(
      isExplicitPermissionSignal({
        check: { approvalFlowState: "pending_user_confirm" },
      }),
      true
    );
  });

  it("reads tool name from tool_name / toolName / nested tool object", () => {
    assert.strictEqual(readToolName({ tool_name: "shell" }), "shell");
    assert.strictEqual(readToolName({ toolName: "WriteFile" }), "WriteFile");
    assert.strictEqual(readToolName({ tool: "Background" }), "Background");
    assert.strictEqual(readToolName({ tool: { name: "StrReplaceFile" } }), "StrReplaceFile");
    assert.strictEqual(readToolName({ tool: { tool_name: "background" } }), "background");
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

  it("defaults to explicit-only (no suspect) for permission tools without explicit signal", () => {
    const oldDisable = process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION;
    const oldImmediate = process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE;
    const oldSuspect = process.env.CLAWD_KIMI_PERMISSION_SUSPECT;
    try {
      delete process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION;
      delete process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE;
      delete process.env.CLAWD_KIMI_PERMISSION_SUSPECT;
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
      // state.js defer-promote only in opt-in suspect mode.
      assert.strictEqual(body.state, "working");
      assert.strictEqual(body.event, "PreToolUse");
      assert.notStrictEqual(body.permission_suspect, true);
      assert.strictEqual(
        classifyPreTool("PreToolUse", { tool_name: "shell" }),
        "none"
      );
    } finally {
      if (oldDisable == null) delete process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION;
      else process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION = oldDisable;
      if (oldImmediate == null) delete process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE;
      else process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE = oldImmediate;
      if (oldSuspect == null) delete process.env.CLAWD_KIMI_PERMISSION_SUSPECT;
      else process.env.CLAWD_KIMI_PERMISSION_SUSPECT = oldSuspect;
    }
  });

  it("CLAWD_KIMI_PERMISSION_SUSPECT=1 enables deferred suspect mode", () => {
    const oldSuspect = process.env.CLAWD_KIMI_PERMISSION_SUSPECT;
    try {
      process.env.CLAWD_KIMI_PERMISSION_SUSPECT = "1";
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
      assert.strictEqual(body.permission_suspect, true);
      assert.strictEqual(
        classifyPreTool("PreToolUse", { tool_name: "shell" }),
        "suspect"
      );
    } finally {
      if (oldSuspect == null) delete process.env.CLAWD_KIMI_PERMISSION_SUSPECT;
      else process.env.CLAWD_KIMI_PERMISSION_SUSPECT = oldSuspect;
    }
  });

  it("CLAWD_KIMI_PERMISSION_MODE controls default classification persistently", () => {
    const oldMode = process.env.CLAWD_KIMI_PERMISSION_MODE;
    try {
      process.env.CLAWD_KIMI_PERMISSION_MODE = MODE_SUSPECT;
      assert.strictEqual(readPermissionMode(), MODE_SUSPECT);
      assert.strictEqual(
        classifyPreTool("PreToolUse", { tool_name: "shell" }),
        "suspect"
      );

      process.env.CLAWD_KIMI_PERMISSION_MODE = MODE_EXPLICIT;
      assert.strictEqual(readPermissionMode(), MODE_EXPLICIT);
      assert.strictEqual(
        classifyPreTool("PreToolUse", { tool_name: "shell" }),
        "none"
      );
    } finally {
      if (oldMode == null) delete process.env.CLAWD_KIMI_PERMISSION_MODE;
      else process.env.CLAWD_KIMI_PERMISSION_MODE = oldMode;
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

  it("coerces non-string session_id instead of throwing", () => {
    const resolve = () => ({ stablePid: 0, agentPid: 0, detectedEditor: null, pidChain: [] });
    const body = buildStateBody(
      "UserPromptSubmit",
      { session_id: 42, cwd: "/tmp", prompt: "hello" },
      resolve
    );
    assert.strictEqual(body.session_id, "kimi-cli:42");
  });

  it("falls back to default when session_id is missing", () => {
    const resolve = () => ({ stablePid: 0, agentPid: 0, detectedEditor: null, pidChain: [] });
    const body = buildStateBody(
      "UserPromptSubmit",
      { cwd: "/tmp", prompt: "hello" },
      resolve
    );
    assert.strictEqual(body.session_id, "kimi-cli:default");
  });

  it("ignores non-string cwd instead of passing it through", () => {
    const resolve = () => ({ stablePid: 0, agentPid: 0, detectedEditor: null, pidChain: [] });
    const body = buildStateBody(
      "UserPromptSubmit",
      { session_id: "sid", cwd: { not: "a string" } },
      resolve
    );
    assert.strictEqual(body.cwd, undefined);
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
    const oldSuspect = process.env.CLAWD_KIMI_PERMISSION_SUSPECT;
    try {
      delete process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION;
      delete process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE;
      delete process.env.CLAWD_KIMI_PERMISSION_SUSPECT;

      // Non-permission tools are classified as "none" (no signal at all).
      assert.strictEqual(
        classifyPreTool("PreToolUse", { tool_name: "read_file" }),
        "none"
      );
      // Default: gated tools -> none (explicit-only mode).
      assert.strictEqual(
        classifyPreTool("PreToolUse", { tool_name: "shell" }),
        "none"
      );
      // shouldRemapPreToolToPermission() is the "flash notification right now"
      // predicate and remains false by default.
      assert.strictEqual(
        shouldRemapPreToolToPermission("PreToolUse", { tool_name: "shell" }),
        false
      );

      // Disable remains compatible: no animation at all unless payload
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

      // Suspect mode is opt-in.
      process.env.CLAWD_KIMI_PERMISSION_SUSPECT = "1";
      assert.strictEqual(
        classifyPreTool("PreToolUse", { tool_name: "shell" }),
        "suspect"
      );
      delete process.env.CLAWD_KIMI_PERMISSION_SUSPECT;

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
      if (oldSuspect == null) delete process.env.CLAWD_KIMI_PERMISSION_SUSPECT;
      else process.env.CLAWD_KIMI_PERMISSION_SUSPECT = oldSuspect;
    }
  });

  it("uses default debug log size cap when env is unset/invalid", () => {
    const old = process.env.CLAWD_KIMI_HOOK_DEBUG_MAX_BYTES;
    try {
      delete process.env.CLAWD_KIMI_HOOK_DEBUG_MAX_BYTES;
      assert.strictEqual(readHookDebugMaxBytes(), DEFAULT_HOOK_DEBUG_MAX_BYTES);

      process.env.CLAWD_KIMI_HOOK_DEBUG_MAX_BYTES = "not-a-number";
      assert.strictEqual(readHookDebugMaxBytes(), DEFAULT_HOOK_DEBUG_MAX_BYTES);
    } finally {
      if (old == null) delete process.env.CLAWD_KIMI_HOOK_DEBUG_MAX_BYTES;
      else process.env.CLAWD_KIMI_HOOK_DEBUG_MAX_BYTES = old;
    }
  });

  it("stops writing debug log when file reaches max bytes cap", () => {
    const oldDebug = process.env.CLAWD_KIMI_HOOK_DEBUG;
    const oldPath = process.env.CLAWD_KIMI_HOOK_DEBUG_PATH;
    const oldMax = process.env.CLAWD_KIMI_HOOK_DEBUG_MAX_BYTES;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-kimi-hook-"));
    const debugFile = path.join(tmpDir, "kimi-hook-debug.jsonl");
    try {
      process.env.CLAWD_KIMI_HOOK_DEBUG = "1";
      process.env.CLAWD_KIMI_HOOK_DEBUG_PATH = debugFile;
      process.env.CLAWD_KIMI_HOOK_DEBUG_MAX_BYTES = "30";

      appendHookDebug({ a: "1234567890" });
      const first = fs.readFileSync(debugFile, "utf8");
      assert.ok(first.length > 0);

      appendHookDebug({ b: "1234567890" });
      const second = fs.readFileSync(debugFile, "utf8");
      assert.strictEqual(second, first);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (oldDebug == null) delete process.env.CLAWD_KIMI_HOOK_DEBUG;
      else process.env.CLAWD_KIMI_HOOK_DEBUG = oldDebug;
      if (oldPath == null) delete process.env.CLAWD_KIMI_HOOK_DEBUG_PATH;
      else process.env.CLAWD_KIMI_HOOK_DEBUG_PATH = oldPath;
      if (oldMax == null) delete process.env.CLAWD_KIMI_HOOK_DEBUG_MAX_BYTES;
      else process.env.CLAWD_KIMI_HOOK_DEBUG_MAX_BYTES = oldMax;
    }
  });
});
