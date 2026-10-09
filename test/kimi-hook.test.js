const { describe, it } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
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

describe("Kimi Code native events (#563)", () => {
  const resolve = () => ({
    stablePid: 12345,
    agentPid: 67890,
    detectedEditor: null,
    pidChain: [67890, 12345],
  });

  it("maps native PermissionRequest to notification with action and command", () => {
    // Real payload shape captured on-machine from kimi-code 0.22.0.
    const body = buildStateBody(
      "PermissionRequest",
      {
        hook_event_name: "PermissionRequest",
        session_id: "session_abc",
        cwd: "D:/proj",
        turn_id: 0,
        tool_call_id: "Bash_0",
        tool_name: "Bash",
        action: "Running: echo test-approve",
        tool_input: { command: "echo test-approve" },
        display: { kind: "command", command: "echo test-approve", cwd: "D:/proj" },
      },
      resolve
    );
    assert.strictEqual(body.state, "notification");
    assert.strictEqual(body.event, "PermissionRequest");
    assert.strictEqual(body.session_id, "kimi-cli:session_abc");
    assert.strictEqual(body.tool_name, "Bash");
    assert.strictEqual(body.permission_action, "Running: echo test-approve");
    assert.strictEqual(body.permission_command, "echo test-approve");
    assert.deepStrictEqual(body.permission_tool_input, { command: "echo test-approve" });
    assert.strictEqual(body.recap_boundary, undefined);
    assert.strictEqual(body.tool_use_id, undefined);
  });

  it("forwards a whitelisted tool_input subset for file tools (path → file_path)", () => {
    // Real tool_input shapes captured on-machine from kimi-code 0.14.3:
    // Write sends { path, content }, Edit sends { path, old_string, new_string }.
    // The 0.23.6 bundle's Write/Edit input schemas are unchanged (`path`,
    // not `file_path`).
    const write = buildStateBody(
      "PermissionRequest",
      {
        hook_event_name: "PermissionRequest",
        session_id: "session_abc",
        cwd: "D:/proj",
        tool_call_id: "Write_0",
        tool_name: "Write",
        action: "Writing: cue-probe.txt",
        tool_input: { path: "cue-probe.txt", content: "hello cue" },
      },
      resolve
    );
    assert.deepStrictEqual(write.permission_tool_input, { file_path: "cue-probe.txt" });

    const edit = buildStateBody(
      "PermissionRequest",
      {
        hook_event_name: "PermissionRequest",
        session_id: "session_abc",
        tool_name: "Edit",
        tool_input: { path: "cue-probe.txt", old_string: "hello", new_string: "goodbye" },
      },
      resolve
    );
    assert.deepStrictEqual(edit.permission_tool_input, { file_path: "cue-probe.txt" });

    // An explicit Claude-style file_path wins over path.
    const explicit = buildStateBody(
      "PermissionRequest",
      {
        hook_event_name: "PermissionRequest",
        session_id: "session_abc",
        tool_name: "Write",
        tool_input: { file_path: "D:/proj/a.txt", path: "b.txt" },
      },
      resolve
    );
    assert.deepStrictEqual(explicit.permission_tool_input, { file_path: "D:/proj/a.txt" });
  });

  it("clamps forwarded tool_input strings and drops empty or non-string values", () => {
    const body = buildStateBody(
      "PermissionRequest",
      {
        hook_event_name: "PermissionRequest",
        session_id: "session_abc",
        tool_name: "Bash",
        tool_input: { command: "x".repeat(10000), file_path: 42, pattern: "" },
      },
      resolve
    );
    assert.strictEqual(body.permission_tool_input.command.length, 500);
    assert.strictEqual(body.permission_tool_input.file_path, undefined);
    assert.strictEqual(body.permission_tool_input.pattern, undefined);

    const empty = buildStateBody(
      "PermissionRequest",
      {
        hook_event_name: "PermissionRequest",
        session_id: "session_abc",
        tool_name: "Write",
        tool_input: { content: "only heavy fields" },
      },
      resolve
    );
    assert.strictEqual(empty.permission_tool_input, undefined);
  });

  it("trims tool_input values before clamping so padded content survives", () => {
    // Slice-before-trim would clamp 600 chars of leading whitespace down to
    // whitespace only, and the server's own trim would then drop the field.
    const body = buildStateBody(
      "PermissionRequest",
      {
        hook_event_name: "PermissionRequest",
        session_id: "session_abc",
        tool_name: "Bash",
        tool_input: { command: " ".repeat(600) + "rm -rf build" },
      },
      resolve
    );
    assert.strictEqual(body.permission_tool_input.command, "rm -rf build");
  });

  it("never forwards description — model-authored text would mask the real command", () => {
    // kimi-code 0.23.6's Bash schema has an optional model-written
    // `description`, and formatDetail prefers it over `command`; forwarding
    // it would let generated text replace the ground truth on the card.
    const body = buildStateBody(
      "PermissionRequest",
      {
        hook_event_name: "PermissionRequest",
        session_id: "session_abc",
        tool_name: "Bash",
        tool_input: { command: "rm -rf build", description: "Tidy workspace" },
      },
      resolve
    );
    assert.deepStrictEqual(body.permission_tool_input, { command: "rm -rf build" });
  });

  it("forwards pattern for search tools", () => {
    const body = buildStateBody(
      "PermissionRequest",
      {
        hook_event_name: "PermissionRequest",
        session_id: "session_abc",
        tool_name: "Grep",
        tool_input: { pattern: "TODO(kimi)", path: "src" },
      },
      resolve
    );
    assert.deepStrictEqual(body.permission_tool_input, { file_path: "src", pattern: "TODO(kimi)" });
  });

  it("clamps action, display.command and tool_name so a huge command can't 413 the /state POST", () => {
    // A heredoc-sized Bash command embeds itself in action AND display.command;
    // unclamped, the body blows the server's 16KB cap and the headerless 413
    // silently drops the whole notification.
    const big = "x".repeat(20000);
    const body = buildStateBody(
      "PermissionRequest",
      {
        hook_event_name: "PermissionRequest",
        session_id: "session_abc",
        tool_name: `Bash${big}`,
        action: `Running: ${big}`,
        display: { command: big },
        tool_input: { command: big },
      },
      resolve
    );
    assert.strictEqual(body.permission_action.length, 300);
    assert.strictEqual(body.permission_command.length, 500);
    assert.strictEqual(body.tool_name.length, 200);
    assert.ok(Buffer.byteLength(JSON.stringify(body), "utf8") < 14 * 1024);
  });

  it("ignores garbage tool_input shapes at the hook layer", () => {
    for (const garbage of ["text", [1, 2], 7, true, null]) {
      const body = buildStateBody(
        "PermissionRequest",
        {
          hook_event_name: "PermissionRequest",
          session_id: "session_abc",
          tool_name: "Bash",
          tool_input: garbage,
        },
        resolve
      );
      assert.strictEqual(body.permission_tool_input, undefined, `shape: ${JSON.stringify(garbage)}`);
    }
  });

  it("maps native PermissionResult to working and forwards the decision", () => {
    for (const decision of ["approved", "rejected"]) {
      const body = buildStateBody(
        "PermissionResult",
        {
          hook_event_name: "PermissionResult",
          session_id: "session_abc",
          tool_call_id: "Bash_0",
          tool_name: "Bash",
          action: "Running: echo hi",
          tool_input: { command: "echo hi" },
          decision,
        },
        resolve
      );
      assert.strictEqual(body.state, "working", `decision ${decision}`);
      assert.strictEqual(body.event, "PermissionResult");
      assert.strictEqual(body.permission_decision, decision);
      assert.strictEqual(body.permission_tool_input, undefined);
    }
  });

  it("rejected PermissionResult preserves state (PostToolUseFailure owns the visual)", () => {
    const rejected = buildStateBody(
      "PermissionResult",
      { session_id: "s", tool_name: "Bash", decision: "rejected" },
      resolve
    );
    assert.strictEqual(rejected.preserve_state, true);

    const approved = buildStateBody(
      "PermissionResult",
      { session_id: "s", tool_name: "Bash", decision: "approved" },
      resolve
    );
    assert.strictEqual(approved.preserve_state, undefined);
  });

  it("maps Interrupt (user Esc) to idle", () => {
    const body = buildStateBody(
      "Interrupt",
      { hook_event_name: "Interrupt", session_id: "session_abc", turn_id: 2, reason: "cancelled" },
      resolve
    );
    assert.strictEqual(body.state, "idle");
    assert.strictEqual(body.event, "Interrupt");
  });

  it("does not attach permission context to non-permission events", () => {
    const body = buildStateBody(
      "PostToolUse",
      {
        session_id: "s",
        tool_name: "Bash",
        tool_input: { command: "echo x" },
        tool_output: "x",
      },
      resolve
    );
    assert.strictEqual(body.permission_action, undefined);
    assert.strictEqual(body.permission_command, undefined);
    assert.strictEqual(body.permission_decision, undefined);
    assert.strictEqual(body.permission_tool_input, undefined);
  });

  it("legacy synthesized PermissionRequest still carries tool_name but no action", () => {
    const body = buildStateBody(
      "PreToolUse",
      { session_id: "s", tool_name: "shell", permission_required: true },
      resolve
    );
    assert.strictEqual(body.event, "PermissionRequest");
    assert.strictEqual(body.tool_name, "shell");
    assert.strictEqual(body.permission_action, undefined);
    assert.strictEqual(body.permission_command, undefined);
    assert.strictEqual(body.permission_tool_input, undefined);
    assert.strictEqual(body.recap_boundary, "tool-call");
  });

  it("synthesized PermissionRequest forwards the cue when the PreToolUse payload carries tool_input", () => {
    // The PreToolUse→PermissionRequest rewrite happens before cue extraction
    // on purpose: immediate mode fires on the raw PreToolUse, whose payload
    // has the real tool_input, and the same whitelist/clamps apply — an
    // accurate cue, not a trust change.
    const body = buildStateBody(
      "PreToolUse",
      {
        session_id: "s",
        tool_name: "shell",
        permission_required: true,
        tool_input: { command: "npm test" },
      },
      resolve
    );
    assert.strictEqual(body.event, "PermissionRequest");
    assert.strictEqual(body.state, "notification");
    assert.deepStrictEqual(body.permission_tool_input, { command: "npm test" });
  });
});

describe("Kimi gate-ledger markers", () => {
  const resolve = () => ({ stablePid: 1, agentPid: null, detectedEditor: null, pidChain: [] });
  const { readToolCallId, isGatedPostEvent, PERMISSION_GATE_ID_MAX_CHARS } = require("../hooks/kimi-hook");

  const withSuspectMode = (fn) => {
    const oldSuspect = process.env.CLAWD_KIMI_PERMISSION_SUSPECT;
    const oldMode = process.env.CLAWD_KIMI_PERMISSION_MODE;
    const oldImmediate = process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE;
    try {
      process.env.CLAWD_KIMI_PERMISSION_SUSPECT = "1";
      delete process.env.CLAWD_KIMI_PERMISSION_MODE;
      delete process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE;
      fn();
    } finally {
      if (oldSuspect == null) delete process.env.CLAWD_KIMI_PERMISSION_SUSPECT;
      else process.env.CLAWD_KIMI_PERMISSION_SUSPECT = oldSuspect;
      if (oldMode == null) delete process.env.CLAWD_KIMI_PERMISSION_MODE;
      else process.env.CLAWD_KIMI_PERMISSION_MODE = oldMode;
      if (oldImmediate == null) delete process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE;
      else process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE = oldImmediate;
    }
  };

  it("gated suspect PreToolUse opens a gate and forwards the tool cue detail", () => {
    withSuspectMode(() => {
      const body = buildStateBody(
        "PreToolUse",
        {
          session_id: "s1",
          tool_name: "shell",
          tool_call_id: "call_abc",
          tool_input: { command: "Remove-Item kimi-cue-test.txt" },
        },
        resolve
      );
      assert.strictEqual(body.state, "working");
      assert.strictEqual(body.event, "PreToolUse");
      assert.strictEqual(body.permission_suspect, true);
      assert.strictEqual(body.permission_gate_open, true);
      assert.strictEqual(body.permission_gate_id, "call_abc");
      assert.strictEqual(body.tool_use_id, "call_abc");
      assert.strictEqual(body.permission_gated, undefined);
      assert.strictEqual(body.tool_name, "shell");
      assert.deepStrictEqual(body.permission_tool_input, { command: "Remove-Item kimi-cue-test.txt" });
    });
  });

  it("gated suspect PreToolUse without tool_call_id opens an anonymous gate", () => {
    withSuspectMode(() => {
      const body = buildStateBody(
        "PreToolUse",
        { session_id: "s1", tool_name: "write_file", tool_input: { path: "a.txt" } },
        resolve
      );
      assert.strictEqual(body.permission_gate_open, true);
      assert.strictEqual(body.permission_gate_id, undefined);
      assert.deepStrictEqual(body.permission_tool_input, { file_path: "a.txt" });
    });
  });

  it("synthesized immediate PermissionRequest carries the gate marker too", () => {
    const body = buildStateBody(
      "PreToolUse",
      {
        session_id: "s1",
        tool_name: "shell",
        tool_call_id: "call_now",
        permission_required: true,
        tool_input: { command: "npm install" },
      },
      resolve
    );
    assert.strictEqual(body.event, "PermissionRequest");
    assert.strictEqual(body.state, "notification");
    assert.strictEqual(body.permission_gate_open, true);
    assert.strictEqual(body.permission_gate_id, "call_now");
    assert.strictEqual(body.tool_use_id, "call_now");
    assert.strictEqual(body.recap_boundary, "tool-call");
    assert.deepStrictEqual(body.permission_tool_input, { command: "npm install" });
  });

  it("gated PostToolUse and PostToolUseFailure close their gate; non-gated Posts carry no markers", () => {
    const post = buildStateBody(
      "PostToolUse",
      { session_id: "s1", tool_name: "shell", tool_call_id: "call_abc" },
      resolve
    );
    assert.strictEqual(post.permission_gated, true);
    assert.strictEqual(post.permission_gate_id, "call_abc");
    assert.strictEqual(post.permission_gate_open, undefined);

    const failure = buildStateBody(
      "PostToolUseFailure",
      { session_id: "s1", tool_name: "write_file", tool_call_id: "call_w" },
      resolve
    );
    assert.strictEqual(failure.permission_gated, true);
    assert.strictEqual(failure.permission_gate_id, "call_w");

    const nonGated = buildStateBody(
      "PostToolUse",
      { session_id: "s1", tool_name: "read_file", tool_call_id: "call_r" },
      resolve
    );
    assert.strictEqual(nonGated.permission_gated, undefined);
    assert.strictEqual(nonGated.permission_gate_id, undefined);
  });

  it("default explicit-only mode emits no gate markers at all", () => {
    const oldSuspect = process.env.CLAWD_KIMI_PERMISSION_SUSPECT;
    const oldMode = process.env.CLAWD_KIMI_PERMISSION_MODE;
    try {
      delete process.env.CLAWD_KIMI_PERMISSION_SUSPECT;
      delete process.env.CLAWD_KIMI_PERMISSION_MODE;
      const body = buildStateBody(
        "PreToolUse",
        { session_id: "s1", tool_name: "shell", tool_call_id: "call_abc" },
        resolve
      );
      assert.strictEqual(body.state, "working");
      assert.strictEqual(body.permission_suspect, undefined);
      assert.strictEqual(body.permission_gate_open, undefined);
      assert.strictEqual(body.permission_gate_id, undefined);
      assert.strictEqual(body.tool_name, undefined);
    } finally {
      if (oldSuspect == null) delete process.env.CLAWD_KIMI_PERMISSION_SUSPECT;
      else process.env.CLAWD_KIMI_PERMISSION_SUSPECT = oldSuspect;
      if (oldMode == null) delete process.env.CLAWD_KIMI_PERMISSION_MODE;
      else process.env.CLAWD_KIMI_PERMISSION_MODE = oldMode;
    }
  });

  it("readToolCallId tolerates shape drift and clamps", () => {
    assert.strictEqual(readToolCallId({ tool_call_id: " call_1 " }), "call_1");
    assert.strictEqual(readToolCallId({ toolCallId: "call_2" }), "call_2");
    assert.strictEqual(readToolCallId({ tool_call: { id: "call_3" } }), "call_3");
    assert.strictEqual(readToolCallId({ toolCall: { id: "call_4" } }), "call_4");
    assert.strictEqual(readToolCallId({ tool_call_id: 42 }), "42");
    assert.strictEqual(
      readToolCallId({ tool_call_id: "x".repeat(500) }),
      "x".repeat(PERMISSION_GATE_ID_MAX_CHARS)
    );
    assert.strictEqual(readToolCallId({ tool_call_id: "   " }), null);
    assert.strictEqual(readToolCallId({ tool_call_id: { nested: true } }), null);
    assert.strictEqual(readToolCallId({}), null);
    assert.strictEqual(readToolCallId(null), null);
  });

  it("isGatedPostEvent matches only gated tools on Post events", () => {
    assert.strictEqual(isGatedPostEvent("PostToolUse", { tool_name: "shell" }), true);
    assert.strictEqual(isGatedPostEvent("PostToolUseFailure", { tool_name: "WriteFile" }), true);
    assert.strictEqual(isGatedPostEvent("PostToolUse", { tool_name: "read_file" }), false);
    assert.strictEqual(isGatedPostEvent("PreToolUse", { tool_name: "shell" }), false);
    assert.strictEqual(isGatedPostEvent("PostToolUse", {}), false);
  });
});

describe("Kimi hook argv permission-mode flag", () => {
  const { parseHookArgv, setArgvPermissionMode } = require("../hooks/kimi-hook");

  const cleanEnv = (fn) => {
    const oldMode = process.env.CLAWD_KIMI_PERMISSION_MODE;
    const oldSuspect = process.env.CLAWD_KIMI_PERMISSION_SUSPECT;
    const oldImmediate = process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE;
    try {
      delete process.env.CLAWD_KIMI_PERMISSION_MODE;
      delete process.env.CLAWD_KIMI_PERMISSION_SUSPECT;
      delete process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE;
      fn();
    } finally {
      setArgvPermissionMode(null);
      if (oldMode == null) delete process.env.CLAWD_KIMI_PERMISSION_MODE;
      else process.env.CLAWD_KIMI_PERMISSION_MODE = oldMode;
      if (oldSuspect == null) delete process.env.CLAWD_KIMI_PERMISSION_SUSPECT;
      else process.env.CLAWD_KIMI_PERMISSION_SUSPECT = oldSuspect;
      if (oldImmediate == null) delete process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE;
      else process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE = oldImmediate;
    }
  };

  it("parses the mode flag in any position without eating the event name", () => {
    assert.deepStrictEqual(
      parseHookArgv(["--permission-mode=suspect", "PreToolUse"]),
      { event: "PreToolUse", mode: "suspect", ignoredFlags: [] }
    );
    assert.deepStrictEqual(
      parseHookArgv(["PreToolUse", "--permission-mode=explicit"]),
      { event: "PreToolUse", mode: "explicit", ignoredFlags: [] }
    );
    // kimi-cli passes no event argv at all — the installer flag must not
    // become the event name (that would silently kill every hook run).
    assert.deepStrictEqual(
      parseHookArgv(["--permission-mode=suspect"]),
      { event: "", mode: "suspect", ignoredFlags: [] }
    );
  });

  it("ignores unknown flags and invalid mode values instead of misparsing them as events", () => {
    const unknown = parseHookArgv(["--future-flag", "Stop"]);
    assert.strictEqual(unknown.event, "Stop");
    assert.deepStrictEqual(unknown.ignoredFlags, ["--future-flag"]);
    const badMode = parseHookArgv(["--permission-mode=chaotic", "Stop"]);
    assert.strictEqual(badMode.mode, null);
    assert.deepStrictEqual(badMode.ignoredFlags, ["--permission-mode=chaotic"]);
    assert.deepStrictEqual(parseHookArgv([]), { event: "", mode: null, ignoredFlags: [] });
    assert.deepStrictEqual(parseHookArgv(undefined), { event: "", mode: null, ignoredFlags: [] });
  });

  it("space-separated mode values and unknown-flag values never claim the event slot", () => {
    // `--permission-mode suspect`: the value is consumed by the flag — it must
    // not become the event (which would override the stdin hook_event_name
    // and silently kill the hook on the unknown name).
    assert.deepStrictEqual(
      parseHookArgv(["--permission-mode", "suspect"]),
      { event: "", mode: "suspect", ignoredFlags: [] }
    );
    assert.deepStrictEqual(
      parseHookArgv(["--permission-mode", "chaotic"]),
      { event: "", mode: null, ignoredFlags: ["--permission-mode chaotic"] }
    );
    assert.deepStrictEqual(
      parseHookArgv(["--permission-mode"]),
      { event: "", mode: null, ignoredFlags: ["--permission-mode"] }
    );
    // Unknown flag with a non-event value: both tokens are ignored; the event
    // stays empty so the stdin payload's hook_event_name wins.
    assert.deepStrictEqual(
      parseHookArgv(["--future-flag", "future-value"]),
      { event: "", mode: null, ignoredFlags: ["--future-flag", "future-value"] }
    );
    // A bare positional that is not a known event name is ignored too.
    assert.deepStrictEqual(
      parseHookArgv(["banana"]),
      { event: "", mode: null, ignoredFlags: ["banana"] }
    );
    // Space form still coexists with a real positional event.
    assert.deepStrictEqual(
      parseHookArgv(["--permission-mode", "explicit", "PreToolUse"]),
      { event: "PreToolUse", mode: "explicit", ignoredFlags: [] }
    );
  });

  it("argv suspect mode drives classifyPreTool when no env override exists", () => {
    cleanEnv(() => {
      setArgvPermissionMode("suspect");
      assert.strictEqual(classifyPreTool("PreToolUse", { tool_name: "shell" }), "suspect");
      setArgvPermissionMode("explicit");
      assert.strictEqual(classifyPreTool("PreToolUse", { tool_name: "shell" }), "none");
      setArgvPermissionMode(null);
      assert.strictEqual(classifyPreTool("PreToolUse", { tool_name: "shell" }), "none");
    });
  });

  it("env escape hatches beat the persisted argv mode in both directions", () => {
    cleanEnv(() => {
      setArgvPermissionMode("suspect");
      process.env.CLAWD_KIMI_PERMISSION_MODE = "explicit";
      assert.strictEqual(classifyPreTool("PreToolUse", { tool_name: "shell" }), "none");
      delete process.env.CLAWD_KIMI_PERMISSION_MODE;

      setArgvPermissionMode("explicit");
      process.env.CLAWD_KIMI_PERMISSION_SUSPECT = "1";
      assert.strictEqual(classifyPreTool("PreToolUse", { tool_name: "shell" }), "suspect");
    });
  });

  it("explicit payload signals still win over any mode (argv or otherwise)", () => {
    cleanEnv(() => {
      setArgvPermissionMode("explicit");
      assert.strictEqual(
        classifyPreTool("PreToolUse", { tool_name: "shell", permission_required: true }),
        "immediate"
      );
    });
  });
});

describe("Kimi hook agent process detection", () => {
  const {
    KIMI_PROCESS_NAMES,
    KIMI_STARTUP_RECOVERY_PROCESS_NAMES,
    isKimiAgentCommandLine,
  } = require("../hooks/kimi-process-names");
  const { buildResolverOptions } = require("../hooks/kimi-hook");
  const { runSpawnedHook } = require("./helpers/spawned-hook");
  const HOOK_PATH = path.resolve(__dirname, "..", "hooks", "kimi-hook.js");

  // Kimi Code sets process.title = "kimi-code", and libuv cuts the title to the
  // length of the original argv: on the 0.42.0 macOS build `kimi` was listed as
  // "kimi", `kimi -c` as "kimi-co", `kimi --yolo` as "kimi-code".
  const TITLE_CUTS = ["kimi", "kimi-", "kimi-c", "kimi-co", "kimi-cod", "kimi-code"];

  it("gives the resolver every cut of the kimi-code title, in lowercase", () => {
    for (const [platform, names] of Object.entries(KIMI_PROCESS_NAMES)) {
      for (const name of names) {
        assert.strictEqual(name, name.toLowerCase(), `${platform}: ${name} can never match`);
      }
    }
    for (const platform of ["mac", "linux"]) {
      for (const cut of TITLE_CUTS) {
        assert.ok(KIMI_PROCESS_NAMES[platform].includes(cut), `${platform} misses ${cut}`);
      }
    }
    assert.ok(KIMI_PROCESS_NAMES.mac.includes("kimi code"), "the desktop app must be recognizable on macOS");
    assert.deepStrictEqual(KIMI_PROCESS_NAMES.win, ["kimi.exe"]);
  });

  it("gives startup recovery the CLI's names only, not the always-running desktop app", () => {
    // The desktop app stays in the tray after its windows close; like the other
    // desktop apps it must not count as active work when Clawd starts.
    for (const platform of ["mac", "linux"]) {
      assert.deepStrictEqual([...KIMI_STARTUP_RECOVERY_PROCESS_NAMES[platform]], TITLE_CUTS, platform);
    }
    assert.deepStrictEqual(KIMI_STARTUP_RECOVERY_PROCESS_NAMES.win, ["kimi.exe"]);
  });

  it("wires the resolver to the resolver names and the package-directory check", () => {
    const options = buildResolverOptions({});
    for (const platform of ["mac", "linux", "win"]) {
      assert.deepStrictEqual([...options.agentNames[platform]], [...KIMI_PROCESS_NAMES[platform]], platform);
    }
    assert.strictEqual(options.agentCmdlineCheck, isKimiAgentCommandLine);
    // No list of its own: node-named processes are checked under the shared
    // default names, which cover Linux's MainThread naming.
    assert.ok(!("agentCmdlineNames" in options));
  });

  it("recognizes a node-hosted Kimi Code by its package directory and nothing merely similar", () => {
    const matches = [
      String.raw`"C:\Program Files\nodejs\node.exe"  "C:\Users\me\AppData\Roaming\npm\node_modules\@moonshot-ai\kimi-code\dist\main.mjs"`,
      String.raw`"C:\Program Files\nodejs\node.exe" C:\Users\me\AppData\Roaming\npm/node_modules/@moonshot-ai/kimi-code/dist/main.mjs --yolo`,
      String.raw`C:\Users\Me\AppData\Roaming\npm\node_modules\@Moonshot-AI\Kimi-Code\dist\main.mjs`,
      "node /usr/local/lib/node_modules/@moonshot-ai/kimi-code/dist/main.mjs",
      "node /Users/me/Library/pnpm/global/5/.pnpm/@moonshot-ai+kimi-code@0.42.0/node_modules/@moonshot-ai/kimi-code/dist/main.mjs",
      "node /Users/me/.npm/_npx/1a2b3c/node_modules/@moonshot-ai/kimi-code/dist/main.mjs -c",
      String.raw`C:\PROGRA~1\nodejs\node.exe  "C:\Users\me\APPDAT~1\Roaming\npm\node_modules\@moonshot-ai\kimi-code\bin\kimi"`,
    ];
    const misses = [
      "node server.js --label kimi",
      "node /Users/me/projects/kimi/server.js",
      "node /Users/me/projects/kimi-code/server.js",
      "node /Users/me/kimi-notes/relay.js",
      "node /Users/me/src/kimi-cli/main.js",
      "node /work/node_modules/@moonshot-ai/kimi-code-sdk/dist/index.js",
      "node /Users/me/.kimi-code/plugins/demo/index.js",
      "",
      undefined,
    ];
    for (const cmd of matches) assert.strictEqual(isKimiAgentCommandLine(cmd), true, cmd);
    for (const cmd of misses) assert.strictEqual(isKimiAgentCommandLine(cmd), false, String(cmd));
  });

  // Real processes, the way Kimi Code runs a hook: the agent process spawns the
  // hook command through a shell (spawn(command, { shell: true })). Each hop is
  // a small node script that can retitle itself, records its own pid, and
  // forwards stdin plus the harness's HTTP recorder (execArgv) to the next hop.
  // The recorder is preloaded in every hop and dumps its own empty recording on
  // exit, so each hop copies the next hop's recording back last.
  function hopSource({ title, pidFile, next, esm }) {
    return [
      title ? `process.title = ${JSON.stringify(title)};` : "",
      esm ? "import fs from \"node:fs\";" : "const fs = require(\"node:fs\");",
      esm ? "import { spawnSync } from \"node:child_process\";" : "const { spawnSync } = require(\"node:child_process\");",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "const out = process.env.CLAWD_POST_OUT;",
      "const nextOut = `${out}.next.json`;",
      "const command = [process.execPath, ...process.execArgv, "
        + `${JSON.stringify(next)}].map((arg) => JSON.stringify(arg)).join(" ");`,
      "const child = spawnSync(command, {",
      "  shell: true,",
      "  input: fs.readFileSync(0),",
      "  stdio: [\"pipe\", \"inherit\", \"inherit\"],",
      "  env: { ...process.env, CLAWD_POST_OUT: nextOut },",
      "});",
      "process.on(\"exit\", () => { try { fs.copyFileSync(nextOut, out); } catch {} });",
      "process.exit(child.status == null ? 1 : child.status);",
    ].join("\n");
  }

  // Runs the real hook under a stand-in Kimi process (optionally started by an
  // outer node wrapper) and returns the POSTed body plus the stand-ins' pids.
  function runUnderKimiProcess({ title, entry = "bin/kimi", wrapper = null }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-kimi-agent-"));
    const launcher = path.join(dir, entry);
    const launcherPidFile = path.join(dir, "launcher.pid");
    const wrapperScript = wrapper ? path.join(dir, wrapper) : null;
    const wrapperPidFile = path.join(dir, "wrapper.pid");
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, hopSource({
      title,
      pidFile: launcherPidFile,
      next: HOOK_PATH,
      esm: launcher.endsWith(".mjs"),
    }), "utf8");
    if (wrapperScript) {
      fs.mkdirSync(path.dirname(wrapperScript), { recursive: true });
      fs.writeFileSync(wrapperScript, hopSource({ title: null, pidFile: wrapperPidFile, next: launcher }), "utf8");
    }
    try {
      const result = runSpawnedHook({
        script: wrapperScript || launcher,
        payload: {
          session_id: `sess-agent-pid-${title || "npm"}`,
          cwd: "/tmp/project",
          hook_event_name: "UserPromptSubmit",
          prompt: "hi",
        },
        httpContract: "expect-attempt",
        // procps applies an exported COLUMNS to piped `ps` output, which would
        // cut the command line the resolver reads.
        env: { CLAWD_POST_RECORDER_SUCCEED: "1", COLUMNS: undefined },
      });
      assert.strictEqual(result.status, 0, result.stderr);
      const post = result.attempts.find((attempt) => attempt.kind === "request" && typeof attempt.body === "string");
      assert.ok(post, `expected a recorded POST; attempts=${JSON.stringify(result.attempts)}`);
      return {
        body: JSON.parse(post.body),
        launcherPid: Number(fs.readFileSync(launcherPidFile, "utf8")),
        wrapperPid: wrapperScript ? Number(fs.readFileSync(wrapperPidFile, "utf8")) : null,
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Without an agent pid Clawd cannot retire the session when Kimi Code dies
  // without SessionEnd (closed terminal, kill, crash).
  it("reports the retitled Kimi Code CLI as the agent pid, whatever its title was cut to", {
    skip: process.platform === "win32",
  }, () => {
    for (const title of TITLE_CUTS) {
      const { body, launcherPid } = runUnderKimiProcess({ title });
      assert.strictEqual(body.agent_pid, launcherPid, `${title}: ${JSON.stringify(body)}`);
      assert.strictEqual(body.kimi_pid, launcherPid, `${title}: ${JSON.stringify(body)}`);
    }
  });

  it("reports the Kimi Code desktop app's main process as the agent pid", {
    skip: process.platform !== "darwin",
  }, () => {
    // ps lists the app as ".../Kimi Code.app/Contents/MacOS/Kimi Code"; the
    // resolver compares the lowercased basename.
    const { body, launcherPid } = runUnderKimiProcess({ title: "Kimi Code" });
    assert.strictEqual(body.agent_pid, launcherPid, JSON.stringify(body));
  });

  it("reports a node-named Kimi Code (npm build) as the agent pid by its package directory", {
    skip: process.platform === "win32",
  }, () => {
    // The shape the npm build keeps on Windows, where the title does not rename
    // the process: node.exe running @moonshot-ai/kimi-code/dist/main.mjs.
    const { body, launcherPid } = runUnderKimiProcess({
      title: null,
      entry: "node_modules/@moonshot-ai/kimi-code/dist/main.mjs",
    });
    assert.strictEqual(body.agent_pid, launcherPid, JSON.stringify(body));
  });

  // The resolver walks up from the hook's parent, bounded to eight hops, and
  // takes the nearest match. Walking ppid from process.pid lists exactly the
  // ancestors that already existed before this test began, so a process the
  // test itself spawned can never be among them.
  function testRunnerAncestors() {
    const ancestors = new Set();
    let pid = process.pid;
    while (pid > 1) {
      const stdout = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).stdout;
      const ppid = Number.parseInt(stdout, 10);
      if (!Number.isInteger(ppid) || ppid <= 0 || ppid === pid || ancestors.has(ppid)) break;
      ancestors.add(ppid);
      pid = ppid;
    }
    return ancestors;
  }

  // What the old includes("kimi") check got wrong: when Kimi itself goes
  // unrecognized (here it runs under another name, which ps shows as "k"), the
  // walk continues past it, and a node ancestor whose command line merely
  // mentions kimi became the agent. That process can exit while the session
  // lives on, so reporting no pid is right. Running this suite inside Kimi Code
  // is different: the real Kimi is then a pre-existing ancestor of the test
  // process and legitimately wins the walk, so only the test's own stand-ins
  // must never be reported.
  it("does not take a node ancestor that merely mentions kimi for the agent", {
    skip: process.platform === "win32",
  }, () => {
    const { body, launcherPid, wrapperPid } = runUnderKimiProcess({
      title: "k",
      wrapper: "kimi-notes/relay.js",
    });
    assert.notStrictEqual(body.agent_pid, wrapperPid, "the unrelated node ancestor was taken for Kimi");
    assert.notStrictEqual(body.agent_pid, launcherPid, "the retitled launcher was taken for Kimi");
    if (body.agent_pid != null) {
      const ancestors = testRunnerAncestors();
      assert.ok(
        ancestors.has(body.agent_pid),
        `agent_pid was neither absent nor a pre-existing ancestor: ${JSON.stringify(body)}; `
          + `ancestors=${JSON.stringify([...ancestors])}`,
      );
    }
  });
});
