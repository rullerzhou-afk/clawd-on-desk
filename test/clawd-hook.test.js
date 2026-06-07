"use strict";

// Unit tests for hooks/clawd-hook.js pure helpers.
// Tests `buildStateBody` and `extractSessionTitleFromTranscript`.
// The top-level `main()` path (stdin read, HTTP post, process.exit) is not
// tested here; its side effects are exercised by manual / end-to-end runs.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildStateBody,
  extractSessionTitleFromTranscript,
  extractApiErrorFromEntries,
  extractLastAssistantTextFromEntries,
} = require("../hooks/clawd-hook.js");
const { buildToolInputFingerprint } = require("../src/server").__test;

function writeTmpJsonl(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-hook-test-"));
  const file = path.join(dir, "transcript.jsonl");
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(file, body);
  return file;
}

const mockResolve = () => ({
  stablePid: null,
  agentPid: null,
  detectedEditor: null,
  pidChain: [],
});

describe("buildStateBody", () => {
  it("returns null for unknown events", () => {
    assert.strictEqual(buildStateBody("UnknownEvent", {}, mockResolve), null);
  });

  it("returns null for empty event name", () => {
    assert.strictEqual(buildStateBody("", {}, mockResolve), null);
  });

  it("builds body with state + session_id + event + agent_id", () => {
    const body = buildStateBody(
      "SessionStart",
      { session_id: "sid-1", cwd: "/tmp/p" },
      mockResolve
    );
    assert.strictEqual(body.state, "idle");
    assert.strictEqual(body.session_id, "sid-1");
    assert.strictEqual(body.event, "SessionStart");
    assert.strictEqual(body.agent_id, "claude-code");
    assert.strictEqual(body.cwd, "/tmp/p");
  });

  it("maps PreToolUse to working state", () => {
    const body = buildStateBody("PreToolUse", { session_id: "s" }, mockResolve);
    assert.strictEqual(body.state, "working");
  });

  it("maps PreToolUse Task to synthetic SubagentStart", () => {
    const body = buildStateBody(
      "PreToolUse",
      { session_id: "s", tool_name: "Task" },
      mockResolve
    );
    assert.strictEqual(body.state, "juggling");
    assert.strictEqual(body.event, "SubagentStart");
    assert.strictEqual(body.tool_name, "Task");
  });

  it("keeps non-Task PreToolUse as working", () => {
    const body = buildStateBody(
      "PreToolUse",
      { session_id: "s", tool_name: "Bash" },
      mockResolve
    );
    assert.strictEqual(body.state, "working");
    assert.strictEqual(body.event, "PreToolUse");
    assert.strictEqual(body.tool_name, "Bash");
  });

  it("keeps PostToolUse Task as working", () => {
    const body = buildStateBody(
      "PostToolUse",
      { session_id: "s", tool_name: "Task" },
      mockResolve
    );
    assert.strictEqual(body.state, "working");
    assert.strictEqual(body.event, "PostToolUse");
    assert.strictEqual(body.tool_name, "Task");
  });

  it("maps Stop to attention state", () => {
    const body = buildStateBody("Stop", { session_id: "s" }, mockResolve);
    assert.strictEqual(body.state, "attention");
  });

  it("maps PostCompact (auto / unspecified) to thinking, not attention (#406)", () => {
    assert.strictEqual(
      buildStateBody("PostCompact", { session_id: "s" }, mockResolve).state,
      "thinking"
    );
    assert.strictEqual(
      buildStateBody("PostCompact", { session_id: "s", trigger: "auto" }, mockResolve).state,
      "thinking"
    );
  });

  it("maps PostCompact (manual /compact) to idle (#406)", () => {
    const body = buildStateBody(
      "PostCompact",
      { session_id: "s", trigger: "manual" },
      mockResolve
    );
    assert.strictEqual(body.state, "idle");
  });

  it("forwards background_tasks / session_crons counts on Stop (#406)", () => {
    const body = buildStateBody(
      "Stop",
      { session_id: "s", background_tasks: [{}, {}], session_crons: [{}] },
      mockResolve
    );
    assert.strictEqual(body.background_tasks_count, 2);
    assert.strictEqual(body.session_crons_count, 1);
  });

  it("forwards only counts — never background task command/description text (#406)", () => {
    const body = buildStateBody(
      "Stop",
      { session_id: "s", background_tasks: [{ command: "npm run secret-dev", description: "do not leak" }] },
      mockResolve
    );
    assert.strictEqual(body.background_tasks_count, 1);
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes("npm run secret-dev"), "task command must not leak");
    assert.ok(!serialized.includes("do not leak"), "task description must not leak");
  });

  it("forwards stop_hook_active on Stop (#406)", () => {
    const body = buildStateBody("Stop", { session_id: "s", stop_hook_active: true }, mockResolve);
    assert.strictEqual(body.stop_hook_active, true);
  });

  it("omits completion-gate fields on a plain Stop with no background work (#406)", () => {
    const body = buildStateBody("Stop", { session_id: "s" }, mockResolve);
    assert.ok(!("background_tasks_count" in body));
    assert.ok(!("session_crons_count" in body));
    assert.ok(!("stop_hook_active" in body));
  });

  it("maps SubagentStart to juggling state", () => {
    const body = buildStateBody("SubagentStart", { session_id: "s" }, mockResolve);
    assert.strictEqual(body.state, "juggling");
  });

  it("remaps SessionEnd + source=clear to sweeping state", () => {
    const body = buildStateBody(
      "SessionEnd",
      { session_id: "sid-1", source: "clear" },
      mockResolve
    );
    assert.strictEqual(body.state, "sweeping");
  });

  it("remaps SessionEnd + reason=clear to sweeping state", () => {
    // `reason` is an alias for `source` per existing payload handling
    const body = buildStateBody(
      "SessionEnd",
      { session_id: "sid-1", reason: "clear" },
      mockResolve
    );
    assert.strictEqual(body.state, "sweeping");
  });

  it("keeps SessionEnd as sleeping when source is not clear", () => {
    const body = buildStateBody(
      "SessionEnd",
      { session_id: "sid-1", source: "user" },
      mockResolve
    );
    assert.strictEqual(body.state, "sleeping");
  });

  it("falls back to 'default' when session_id is missing", () => {
    const body = buildStateBody("PreToolUse", {}, mockResolve);
    assert.strictEqual(body.session_id, "default");
  });

  it("omits cwd field when payload has no cwd", () => {
    const body = buildStateBody("PreToolUse", { session_id: "s" }, mockResolve);
    assert.ok(!("cwd" in body));
  });

  it("includes source_pid from resolve() in non-remote mode", () => {
    const resolveWithPid = () => ({
      stablePid: 12345,
      agentPid: null,
      detectedEditor: null,
      pidChain: [],
    });
    const body = buildStateBody("PreToolUse", { session_id: "s" }, resolveWithPid);
    assert.strictEqual(body.source_pid, 12345);
  });

  it("includes editor when resolve() detects one", () => {
    const resolveWithEditor = () => ({
      stablePid: 1,
      agentPid: null,
      detectedEditor: "vscode",
      pidChain: [],
    });
    const body = buildStateBody("PreToolUse", { session_id: "s" }, resolveWithEditor);
    assert.strictEqual(body.editor, "vscode");
  });

  it("includes pid_chain when non-empty", () => {
    const resolveWithChain = () => ({
      stablePid: 1,
      agentPid: null,
      detectedEditor: null,
      pidChain: [100, 200, 300],
    });
    const body = buildStateBody("PreToolUse", { session_id: "s" }, resolveWithChain);
    assert.deepStrictEqual(body.pid_chain, [100, 200, 300]);
  });

  it("omits pid_chain when empty", () => {
    const body = buildStateBody("PreToolUse", { session_id: "s" }, mockResolve);
    assert.ok(!("pid_chain" in body));
  });

  it("includes foreground WT HWND only on foreground-safe events", () => {
    const resolveWithWtHwnd = () => ({
      stablePid: 1,
      agentPid: null,
      detectedEditor: null,
      pidChain: [],
      foregroundWtHwnd: "123456",
    });

    const startBody = buildStateBody("SessionStart", { session_id: "s" }, resolveWithWtHwnd);
    const promptBody = buildStateBody("UserPromptSubmit", { session_id: "s" }, resolveWithWtHwnd);
    const stopBody = buildStateBody("Stop", { session_id: "s" }, resolveWithWtHwnd);

    assert.strictEqual(startBody.wt_hwnd, "123456");
    assert.strictEqual(promptBody.wt_hwnd, "123456");
    assert.ok(!("wt_hwnd" in stopBody));
  });

  describe("agentPid and headless detection", () => {
    const makeResolve = (agentPid, agentCommandLine = "") =>
      () => ({ stablePid: 1, agentPid, agentCommandLine, detectedEditor: null, pidChain: [] });

    it("sets agent_pid and claude_pid when agentPid is present", () => {
      const body = buildStateBody("PreToolUse", { session_id: "s" }, makeResolve(42));
      assert.strictEqual(body.agent_pid, 42);
      assert.strictEqual(body.claude_pid, 42);
    });

    it("omits agent_pid and claude_pid when agentPid is absent", () => {
      const body = buildStateBody("PreToolUse", { session_id: "s" }, makeResolve(null));
      assert.ok(!("agent_pid" in body));
      assert.ok(!("claude_pid" in body));
    });

    it("sets headless when agentCommandLine ends with -p", () => {
      const body = buildStateBody("PreToolUse", { session_id: "s" }, makeResolve(99, "node claude-code -p"));
      assert.strictEqual(body.headless, true);
    });

    it("sets headless when agentCommandLine has -p followed by a space", () => {
      const body = buildStateBody("PreToolUse", { session_id: "s" }, makeResolve(99, "node claude-code -p some-prompt"));
      assert.strictEqual(body.headless, true);
    });

    it("sets headless when agentCommandLine contains --print", () => {
      const body = buildStateBody("PreToolUse", { session_id: "s" }, makeResolve(99, "node claude-code --print"));
      assert.strictEqual(body.headless, true);
    });

    it("does not set headless when -p is a prefix of a longer option", () => {
      const body = buildStateBody("PreToolUse", { session_id: "s" }, makeResolve(99, "node claude-code --port 3000"));
      assert.ok(!("headless" in body));
    });

    it("does not set headless when agentCommandLine is empty", () => {
      const body = buildStateBody("PreToolUse", { session_id: "s" }, makeResolve(99, ""));
      assert.ok(!("headless" in body));
    });

    it("does not set headless when agentCommandLine is missing from resolve()", () => {
      // Backward compat: a resolver that never populates agentCommandLine must
      // not crash and must not set headless.
      const resolve = () => ({ stablePid: 1, agentPid: 77, detectedEditor: null, pidChain: [] });
      const body = buildStateBody("PreToolUse", { session_id: "s" }, resolve);
      assert.strictEqual(body.agent_pid, 77);
      assert.ok(!("headless" in body));
    });
  });

  it("passes through tool metadata for tool events", () => {
    const payload = {
      session_id: "s",
      tool_name: "Read",
      tool_use_id: "toolu_123",
      tool_input: { file_path: "src/server.js" },
    };
    const body = buildStateBody("PostToolUse", payload, mockResolve);
    assert.strictEqual(body.tool_name, "Read");
    assert.strictEqual(body.tool_use_id, "toolu_123");
    assert.strictEqual(body.tool_input_fingerprint, buildToolInputFingerprint(payload.tool_input));
  });

  it("adds context_usage from transcript usage", () => {
    const transcript = writeTmpJsonl([
      {
        type: "assistant",
        message: {
          model: "claude-sonnet-4-5",
          usage: {
            input_tokens: 1000,
            output_tokens: 200,
            cache_read_input_tokens: 3000,
            cache_creation_input_tokens: 400,
          },
        },
      },
    ]);

    const body = buildStateBody("PostToolUse", {
      session_id: "s",
      transcript_path: transcript,
    }, mockResolve);

    assert.deepStrictEqual(body.context_usage, {
      used: 4400,
      limit: 200000,
      percent: 2,
      source: "claude",
    });
  });

  it("omits context_usage when transcript has no usage", () => {
    const transcript = writeTmpJsonl([{ type: "user", message: { content: "hi" } }]);

    const body = buildStateBody("PostToolUse", {
      session_id: "s",
      transcript_path: transcript,
    }, mockResolve);

    assert.ok(!("context_usage" in body));
  });

  it("scopes context_usage to the main session, ignoring trailing sidechain usage", () => {
    const transcript = writeTmpJsonl([
      {
        type: "assistant",
        sessionId: "s",
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 150000 } },
      },
      {
        type: "assistant",
        sessionId: "s",
        isSidechain: true,
        message: { model: "claude-sonnet-4-5", usage: { input_tokens: 12000 } },
      },
    ]);

    const body = buildStateBody("PostToolUse", {
      session_id: "s",
      transcript_path: transcript,
    }, mockResolve);

    assert.deepStrictEqual(body.context_usage, {
      used: 150000,
      limit: 200000,
      percent: 75,
      source: "claude",
    });
  });

  it("accepts camelCase tool_use_id aliases", () => {
    const body = buildStateBody("PreToolUse", {
      session_id: "s",
      tool_name: "Bash",
      toolUseId: "toolu_alias",
      tool_input: { command: "npm test" },
    }, mockResolve);
    assert.strictEqual(body.tool_use_id, "toolu_alias");
  });

  describe("session_title extraction", () => {
    it("passes through explicit payload.session_title", () => {
      const body = buildStateBody(
        "SessionStart",
        { session_id: "s", session_title: "Fix login bug" },
        mockResolve
      );
      assert.strictEqual(body.session_title, "Fix login bug");
    });

    it("trims whitespace on payload.session_title", () => {
      const body = buildStateBody(
        "SessionStart",
        { session_id: "s", session_title: "  Spaced Title  " },
        mockResolve
      );
      assert.strictEqual(body.session_title, "Spaced Title");
    });

    it("strips control characters and truncates payload.session_title", () => {
      const body = buildStateBody(
        "SessionStart",
        { session_id: "s", session_title: `  Fix\tlogin\nbug ${"x".repeat(100)}  ` },
        mockResolve
      );
      assert.strictEqual(body.session_title.startsWith("Fix login bug "), true);
      assert.strictEqual(body.session_title.length, 80);
      assert.strictEqual(body.session_title.endsWith("…"), true);
      assert.strictEqual(/[\u0000-\u001F\u007F-\u009F]/.test(body.session_title), false);
    });

    it("omits session_title field when payload has none and no transcript path", () => {
      const body = buildStateBody("SessionStart", { session_id: "s" }, mockResolve);
      assert.ok(!("session_title" in body));
    });

    it("uses the first prompt line for UserPromptSubmit when no title exists", () => {
      const body = buildStateBody(
        "UserPromptSubmit",
        { session_id: "s", prompt: "Fix the Session HUD\nKeep the bell" },
        mockResolve
      );
      assert.strictEqual(body.session_title, "Fix the Session HUD");
    });

    it("uses the first non-empty prompt line for UserPromptSubmit fallback", () => {
      const body = buildStateBody(
        "UserPromptSubmit",
        { session_id: "s", prompt: "\n  \nContinue AWS setup\nDetails later" },
        mockResolve
      );
      assert.strictEqual(body.session_title, "Continue AWS setup");
    });

    it("keeps prompt fallback titles compact", () => {
      const body = buildStateBody(
        "UserPromptSubmit",
        { session_id: "s", prompt: `Configure ${"Lightsail ".repeat(10)}` },
        mockResolve
      );
      assert.strictEqual(body.session_title.length, 40);
      assert.strictEqual(body.session_title.endsWith("…"), true);
    });

    it("skips prompt fallback titles that look like secrets", () => {
      const body = buildStateBody(
        "UserPromptSubmit",
        { session_id: "s", prompt: "token=ghp_abcdefghijklmnopqrstuvwxyz123456\nFix deploy" },
        mockResolve
      );
      assert.ok(!("session_title" in body));
    });

    it("falls back to transcript when payload.session_title is missing", () => {
      const file = writeTmpJsonl([
        { type: "user", message: { content: "hi" } },
        { type: "custom-title", customTitle: "From Transcript" },
      ]);
      const body = buildStateBody(
        "SessionStart",
        { session_id: "s", transcript_path: file },
        mockResolve
      );
      assert.strictEqual(body.session_title, "From Transcript");
    });

    it("prefers payload.session_title over transcript", () => {
      const file = writeTmpJsonl([
        { type: "custom-title", customTitle: "Transcript Title" },
      ]);
      const body = buildStateBody(
        "SessionStart",
        { session_id: "s", session_title: "Payload Title", transcript_path: file },
        mockResolve
      );
      assert.strictEqual(body.session_title, "Payload Title");
    });

    it("prefers transcript title over prompt fallback", () => {
      const file = writeTmpJsonl([
        { type: "custom-title", customTitle: "Transcript Title" },
      ]);
      const body = buildStateBody(
        "UserPromptSubmit",
        { session_id: "s", prompt: "Prompt Title", transcript_path: file },
        mockResolve
      );
      assert.strictEqual(body.session_title, "Transcript Title");
    });

    it("ignores non-string session_title and falls back to transcript", () => {
      const file = writeTmpJsonl([
        { type: "custom-title", customTitle: "Transcript Title" },
      ]);
      const body = buildStateBody(
        "SessionStart",
        { session_id: "s", session_title: 123, transcript_path: file },
        mockResolve
      );
      assert.strictEqual(body.session_title, "Transcript Title");
    });
  });

  describe("remote mode (CLAWD_REMOTE=1)", () => {
    before(() => { process.env.CLAWD_REMOTE = "1"; });
    after(() => { delete process.env.CLAWD_REMOTE; });

    it("includes host prefix instead of source_pid", () => {
      const body = buildStateBody("SessionStart", { session_id: "sid-1" }, mockResolve);
      assert.strictEqual(typeof body.host, "string");
      assert.ok(body.host.length > 0);
      assert.ok(!("source_pid" in body));
      assert.ok(!("pid_chain" in body));
    });

    it("does not call resolve() in remote mode", () => {
      let called = false;
      const countingResolve = () => {
        called = true;
        return mockResolve();
      };
      buildStateBody("SessionStart", { session_id: "s" }, countingResolve);
      assert.strictEqual(called, false);
    });
  });
});

describe("extractSessionTitleFromTranscript", () => {
  it("returns the latest title from a tail with multiple rename events", () => {
    const file = writeTmpJsonl([
      { type: "user", message: { content: "hello" } },
      { type: "custom-title", customTitle: "First Title" },
      { type: "agent-name", agentName: "Renamed Later" },
    ]);
    assert.strictEqual(extractSessionTitleFromTranscript(file), "Renamed Later");
  });

  it("returns null for missing file", () => {
    assert.strictEqual(extractSessionTitleFromTranscript("/no/such/path.jsonl"), null);
  });

  it("returns null when transcript has no title events", () => {
    const file = writeTmpJsonl([
      { type: "user", message: { content: "hi" } },
      { type: "assistant", message: { content: "yo" } },
    ]);
    assert.strictEqual(extractSessionTitleFromTranscript(file), null);
  });

  it("supports custom_title (snake_case) variant", () => {
    const file = writeTmpJsonl([
      { type: "custom-title", custom_title: "Snake Title" },
    ]);
    assert.strictEqual(extractSessionTitleFromTranscript(file), "Snake Title");
  });

  it("supports agent_name (snake_case) variant", () => {
    const file = writeTmpJsonl([
      { type: "agent-name", agent_name: "Snake Agent" },
    ]);
    assert.strictEqual(extractSessionTitleFromTranscript(file), "Snake Agent");
  });

  it("supports plain title field", () => {
    const file = writeTmpJsonl([
      { type: "custom-title", title: "Plain Title Field" },
    ]);
    assert.strictEqual(extractSessionTitleFromTranscript(file), "Plain Title Field");
  });

  it("trims whitespace on extracted title", () => {
    const file = writeTmpJsonl([
      { type: "custom-title", customTitle: "  Padded  " },
    ]);
    assert.strictEqual(extractSessionTitleFromTranscript(file), "Padded");
  });

  it("strips control characters and truncates extracted titles", () => {
    const file = writeTmpJsonl([
      { type: "custom-title", customTitle: `  Fix\tlogin\nbug ${"x".repeat(100)}  ` },
    ]);
    const title = extractSessionTitleFromTranscript(file);
    assert.strictEqual(title.startsWith("Fix login bug "), true);
    assert.strictEqual(title.length, 80);
    assert.strictEqual(title.endsWith("…"), true);
    assert.strictEqual(/[\u0000-\u001F\u007F-\u009F]/.test(title), false);
  });

  it("ignores corrupt JSON lines and keeps scanning", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-hook-test-"));
    const file = path.join(dir, "corrupt.jsonl");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "user", message: { content: "hi" } }),
        "{ not valid json at all",
        JSON.stringify({ type: "custom-title", customTitle: "After Garbage" }),
      ].join("\n") + "\n"
    );
    assert.strictEqual(extractSessionTitleFromTranscript(file), "After Garbage");
  });

  it("returns null for non-string path input", () => {
    assert.strictEqual(extractSessionTitleFromTranscript(null), null);
    assert.strictEqual(extractSessionTitleFromTranscript(undefined), null);
    assert.strictEqual(extractSessionTitleFromTranscript(42), null);
    assert.strictEqual(extractSessionTitleFromTranscript(""), null);
  });

  it("skips the truncated first line when reading a file larger than the tail window", () => {
    // Write ~300KB of junk + a valid title event at the end.
    // The tail window is 256KB, so the first line of what we read will be a
    // truncated JSON fragment. extractSessionTitleFromTranscript must drop it
    // rather than letting JSON.parse reject it loudly.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-hook-test-"));
    const file = path.join(dir, "big.jsonl");
    const padLine = JSON.stringify({ type: "user", message: { content: "x".repeat(400) } });
    const parts = [];
    for (let i = 0; i < 700; i++) parts.push(padLine); // ~300KB of padding
    parts.push(JSON.stringify({ type: "custom-title", customTitle: "End Title" }));
    fs.writeFileSync(file, parts.join("\n") + "\n");
    assert.strictEqual(extractSessionTitleFromTranscript(file), "End Title");
  });
});

describe("extractLastAssistantTextFromEntries", () => {
  it("extracts only text blocks from the latest assistant entry", () => {
    const result = extractLastAssistantTextFromEntries([
      { type: "assistant", sessionId: "sid-1", message: { content: "older" } },
      {
        type: "assistant",
        sessionId: "sid-1",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "secret.txt" } },
            { type: "text", text: "Done with the fix." },
            { type: "server_tool_use", name: "WebSearch" },
            { type: "text", text: "Tests pass." },
          ],
        },
      },
    ], "sid-1");

    assert.deepStrictEqual(result, {
      text: "Done with the fix.\n\nTests pass.",
      truncated: false,
    });
  });

  it("skips API error, subagent, and other-session assistant entries", () => {
    const result = extractLastAssistantTextFromEntries([
      { type: "assistant", sessionId: "sid-1", message: { content: "root output" } },
      { type: "assistant", sessionId: "sid-2", message: { content: "wrong session" } },
      { type: "assistant", sessionId: "sid-1", isSidechain: true, message: { content: "subagent" } },
      { type: "assistant", sessionId: "sid-1", isApiErrorMessage: true, message: { content: "API Error" } },
    ], "sid-1");

    assert.deepStrictEqual(result, { text: "root output", truncated: false });
  });

  it("returns null when the latest assistant messages only contain tool calls", () => {
    const result = extractLastAssistantTextFromEntries([
      {
        type: "assistant",
        sessionId: "sid-1",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] },
      },
    ], "sid-1");

    assert.strictEqual(result, null);
  });

  it("does not cross a user boundary to reuse an older assistant answer", () => {
    const result = extractLastAssistantTextFromEntries([
      { type: "assistant", sessionId: "sid-1", message: { content: "older answer" } },
      { type: "user", sessionId: "sid-1", message: { content: "new prompt" } },
      {
        type: "assistant",
        sessionId: "sid-1",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] },
      },
    ], "sid-1");

    assert.strictEqual(result, null);
  });

  it("clamps long assistant text with a truncation marker", () => {
    const result = extractLastAssistantTextFromEntries([
      { type: "assistant", sessionId: "sid-1", message: { content: "a".repeat(100) + "TAIL" } },
    ], "sid-1", { maxLen: 40 });

    assert.strictEqual(result.truncated, true);
    assert.ok(result.text.includes("...[truncated]..."));
    assert.ok(result.text.endsWith("TAIL"));
    assert.ok(result.text.length <= 40);
  });
});

// Helper: build an isApiErrorMessage transcript entry. Mirrors the real
// schema observed in ~/.claude/projects/**/*.jsonl during Phase 0 investigation.
function makeApiErrorEntry({ sessionId = "sid-1", error = "unknown", uuid = "err-uuid" }) {
  return {
    type: "assistant",
    uuid,
    parentUuid: "parent",
    timestamp: "2026-05-26T00:00:00.000Z",
    sessionId,
    isApiErrorMessage: true,
    error,
    message: {
      model: "<synthetic>",
      role: "assistant",
      content: [{ type: "text", text: `API Error: ${error}` }],
    },
  };
}

describe("extractApiErrorFromEntries", () => {
  it("returns null for empty / missing entries", () => {
    assert.strictEqual(extractApiErrorFromEntries(null, "sid-1"), null);
    assert.strictEqual(extractApiErrorFromEntries([], "sid-1"), null);
  });

  it("returns null when sessionId is missing", () => {
    const entries = [makeApiErrorEntry({ sessionId: "sid-1", error: "unknown" })];
    assert.strictEqual(extractApiErrorFromEntries(entries, ""), null);
  });

  it("hits a current-turn error followed only by system marker", () => {
    const entries = [
      makeApiErrorEntry({ sessionId: "sid-1", error: "rate_limit", uuid: "e1" }),
      { type: "system", parentUuid: "e1", sessionId: "sid-1" },
    ];
    assert.deepStrictEqual(
      extractApiErrorFromEntries(entries, "sid-1"),
      { api_error_type: "rate_limit" }
    );
  });

  it("hits when error is the only entry (no metadata yet)", () => {
    const entries = [makeApiErrorEntry({ sessionId: "sid-1", error: "server_error" })];
    assert.deepStrictEqual(
      extractApiErrorFromEntries(entries, "sid-1"),
      { api_error_type: "server_error" }
    );
  });

  it("ignores error from a different sessionId (cross-session contamination guard)", () => {
    const entries = [
      makeApiErrorEntry({ sessionId: "other-session", error: "unknown" }),
    ];
    assert.strictEqual(extractApiErrorFromEntries(entries, "sid-1"), null);
  });

  it("suppresses stale error when a user message follows (turn moved on)", () => {
    const entries = [
      makeApiErrorEntry({ sessionId: "sid-1", error: "unknown", uuid: "e1" }),
      { type: "system", parentUuid: "e1", sessionId: "sid-1" },
      { type: "user", sessionId: "sid-1", message: { content: "next prompt" } },
    ];
    assert.strictEqual(extractApiErrorFromEntries(entries, "sid-1"), null);
  });

  it("suppresses when a non-error assistant message follows (auto-retry succeeded)", () => {
    const entries = [
      makeApiErrorEntry({ sessionId: "sid-1", error: "unknown", uuid: "e1" }),
      { type: "assistant", sessionId: "sid-1", message: { content: "ok" } },
    ];
    assert.strictEqual(extractApiErrorFromEntries(entries, "sid-1"), null);
  });

  it("allows benign metadata types after the error", () => {
    const entries = [
      makeApiErrorEntry({ sessionId: "sid-1", error: "invalid_request", uuid: "e1" }),
      { type: "system", parentUuid: "e1", sessionId: "sid-1" },
      { type: "last-prompt", sessionId: "sid-1" },
      { type: "file-history-snapshot", sessionId: "sid-1" },
    ];
    assert.deepStrictEqual(
      extractApiErrorFromEntries(entries, "sid-1"),
      { api_error_type: "invalid_request" }
    );
  });

  it("returns the latest current-turn error when multiple errors are stacked (same turn)", () => {
    // Multiple isApiErrorMessage entries with no user/assistant break between
    // them — auto-retry that kept failing. Expect the LAST one to win.
    const entries = [
      makeApiErrorEntry({ sessionId: "sid-1", error: "rate_limit", uuid: "e1" }),
      { type: "system", parentUuid: "e1", sessionId: "sid-1" },
      makeApiErrorEntry({ sessionId: "sid-1", error: "server_error", uuid: "e2" }),
      { type: "system", parentUuid: "e2", sessionId: "sid-1" },
    ];
    assert.deepStrictEqual(
      extractApiErrorFromEntries(entries, "sid-1"),
      { api_error_type: "server_error" }
    );
  });

  it("falls back to 'unknown' for error types outside the known enum", () => {
    const entries = [
      makeApiErrorEntry({ sessionId: "sid-1", error: "some_future_value" }),
    ];
    assert.deepStrictEqual(
      extractApiErrorFromEntries(entries, "sid-1"),
      { api_error_type: "unknown" }
    );
  });

  it("falls back to 'unknown' when error field is missing entirely", () => {
    const entries = [
      {
        type: "assistant",
        sessionId: "sid-1",
        isApiErrorMessage: true,
        message: { content: [{ type: "text", text: "No response requested." }] },
      },
    ];
    assert.deepStrictEqual(
      extractApiErrorFromEntries(entries, "sid-1"),
      { api_error_type: "unknown" }
    );
  });

  it("supports all 9 enum values observed in claude.exe 2.1.150", () => {
    const enumValues = [
      "authentication_failed", "oauth_org_not_allowed", "billing_error",
      "rate_limit", "invalid_request", "model_not_found", "server_error",
      "unknown", "max_output_tokens",
    ];
    for (const t of enumValues) {
      const entries = [makeApiErrorEntry({ sessionId: "sid-1", error: t })];
      assert.deepStrictEqual(
        extractApiErrorFromEntries(entries, "sid-1"),
        { api_error_type: t },
        `enum ${t} should pass through`
      );
    }
  });
});

describe("buildStateBody — Stop → ApiError upgrade", () => {
  it("adds assistant_last_output on normal Stop when transcript has final assistant text", () => {
    const file = writeTmpJsonl([
      { type: "assistant", sessionId: "sid-1", message: { content: "Implemented the fix.\nTests pass." } },
    ]);
    const body = buildStateBody(
      "Stop",
      { session_id: "sid-1", transcript_path: file },
      mockResolve
    );
    assert.strictEqual(body.event, "Stop");
    assert.strictEqual(body.assistant_last_output, "Implemented the fix.\nTests pass.");
    assert.ok(!("assistant_last_output_truncated" in body));
  });

  it("does not add stale assistant output when Stop upgrades to ApiError", () => {
    const file = writeTmpJsonl([
      { type: "assistant", sessionId: "sid-1", message: { content: "previous output" } },
      makeApiErrorEntry({ sessionId: "sid-1", error: "rate_limit", uuid: "e1" }),
      { type: "system", parentUuid: "e1", sessionId: "sid-1" },
    ]);
    const body = buildStateBody(
      "Stop",
      { session_id: "sid-1", transcript_path: file },
      mockResolve
    );
    assert.strictEqual(body.event, "ApiError");
    assert.ok(!("assistant_last_output" in body));
  });

  it("upgrades Stop to ApiError when transcript shows a current-turn error", () => {
    const file = writeTmpJsonl([
      makeApiErrorEntry({ sessionId: "sid-1", error: "rate_limit", uuid: "e1" }),
      { type: "system", parentUuid: "e1", sessionId: "sid-1" },
    ]);
    const body = buildStateBody(
      "Stop",
      { session_id: "sid-1", transcript_path: file },
      mockResolve
    );
    assert.strictEqual(body.event, "ApiError");
    assert.strictEqual(body.state, "error");
    assert.strictEqual(body.failure_kind, "api_error");
    assert.strictEqual(body.api_error_type, "rate_limit");
    assert.strictEqual(body.error_present, true);
  });

  it("does NOT upgrade Stop when the error is stale (user-followed)", () => {
    const file = writeTmpJsonl([
      makeApiErrorEntry({ sessionId: "sid-1", error: "unknown", uuid: "e1" }),
      { type: "system", parentUuid: "e1", sessionId: "sid-1" },
      { type: "user", sessionId: "sid-1", message: { content: "next prompt" } },
    ]);
    const body = buildStateBody(
      "Stop",
      { session_id: "sid-1", transcript_path: file },
      mockResolve
    );
    assert.strictEqual(body.event, "Stop");
    assert.strictEqual(body.state, "attention");
    assert.ok(!("failure_kind" in body));
    assert.ok(!("api_error_type" in body));
    assert.ok(!("error_present" in body));
  });

  it("does NOT upgrade events other than Stop even if transcript shows an error", () => {
    const file = writeTmpJsonl([
      makeApiErrorEntry({ sessionId: "sid-1", error: "unknown", uuid: "e1" }),
      { type: "system", parentUuid: "e1", sessionId: "sid-1" },
    ]);
    const body = buildStateBody(
      "UserPromptSubmit",
      { session_id: "sid-1", transcript_path: file },
      mockResolve
    );
    assert.strictEqual(body.event, "UserPromptSubmit");
    assert.ok(!("api_error_type" in body));
  });

  it("does NOT upgrade synthetic SubagentStart (PreToolUse Task)", () => {
    // PreToolUse Task is remapped to SubagentStart; even if a transcript error
    // exists, ApiError detection should not run for non-Stop branches.
    const file = writeTmpJsonl([
      makeApiErrorEntry({ sessionId: "sid-1", error: "unknown" }),
    ]);
    const body = buildStateBody(
      "PreToolUse",
      { session_id: "sid-1", tool_name: "Task", transcript_path: file },
      mockResolve
    );
    assert.strictEqual(body.event, "SubagentStart");
    assert.ok(!("api_error_type" in body));
  });

  it("does NOT transmit raw error text or errorDetails (privacy)", () => {
    const file = writeTmpJsonl([
      {
        ...makeApiErrorEntry({ sessionId: "sid-1", error: "invalid_request" }),
        requestId: "req_secret_001",
        errorDetails: '400 {"message":"prompt fragment leak","request_id":"req_xxx"}',
      },
    ]);
    const body = buildStateBody(
      "Stop",
      { session_id: "sid-1", transcript_path: file },
      mockResolve
    );
    assert.strictEqual(body.event, "ApiError");
    // PR1 must NOT include any of these fields
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes("prompt fragment leak"), "text leaked");
    assert.ok(!serialized.includes("req_secret_001"), "requestId leaked");
    assert.ok(!serialized.includes("req_xxx"), "errorDetails leaked");
    assert.ok(!("text" in body), "body.text must be absent");
    assert.ok(!("errorDetails" in body), "body.errorDetails must be absent");
    assert.ok(!("requestId" in body), "body.requestId must be absent");
  });

  it("ignores error from a different session (no upgrade)", () => {
    const file = writeTmpJsonl([
      makeApiErrorEntry({ sessionId: "other-sid", error: "unknown" }),
    ]);
    const body = buildStateBody(
      "Stop",
      { session_id: "sid-1", transcript_path: file },
      mockResolve
    );
    assert.strictEqual(body.event, "Stop");
    assert.ok(!("api_error_type" in body));
  });

  it("survives a transcript with corrupted JSON lines", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-hook-test-"));
    const file = path.join(dir, "corrupt.jsonl");
    const errEntry = makeApiErrorEntry({ sessionId: "sid-1", error: "server_error", uuid: "e1" });
    const body =
      JSON.stringify(errEntry) + "\n" +
      "{not-valid-json}\n" +
      JSON.stringify({ type: "system", parentUuid: "e1", sessionId: "sid-1" }) + "\n";
    fs.writeFileSync(file, body);
    const result = buildStateBody(
      "Stop",
      { session_id: "sid-1", transcript_path: file },
      mockResolve
    );
    assert.strictEqual(result.event, "ApiError");
    assert.strictEqual(result.api_error_type, "server_error");
  });

  it("falls back to Stop when transcript path is missing", () => {
    const body = buildStateBody(
      "Stop",
      { session_id: "sid-1" },
      mockResolve
    );
    assert.strictEqual(body.event, "Stop");
    assert.strictEqual(body.state, "attention");
  });
});
