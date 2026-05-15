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
