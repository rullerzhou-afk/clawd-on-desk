const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");
const path = require("path");
const {
  buildCodexNoDecisionOutput,
  buildCodexPermissionOutput,
  buildPermissionBody,
  buildStateBody,
  buildToolInputFingerprint,
  extractCodexSessionIdFromTranscriptPath,
  normalizeCodexSessionId,
  readFirstSessionMeta,
  sanitizeCodexPermissionOutput,
} = require("../hooks/codex-hook");
const { readCodexThreadName } = require("../hooks/codex-session-index");

const mockResolve = () => ({
  stablePid: 123,
  agentPid: 456,
  detectedEditor: "code",
  pidChain: [789, 456, 123],
});

function withTempTranscript(lines, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hook-"));
  const file = path.join(dir, "rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl");
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withTempCodexIndex(lines, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-index-"));
  fs.writeFileSync(path.join(dir, "session_index.jsonl"), lines.join("\n") + "\n", "utf8");
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("Codex official hook", () => {
  it("normalizes session ids with the codex prefix", () => {
    assert.strictEqual(normalizeCodexSessionId("abc"), "codex:abc");
    assert.strictEqual(normalizeCodexSessionId("codex:abc"), "codex:abc");
    assert.strictEqual(normalizeCodexSessionId(""), "codex:default");
  });

  it("prefers rollout transcript ids when normalizing session ids", () => {
    const transcriptPath = "/tmp/rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl";

    assert.strictEqual(
      extractCodexSessionIdFromTranscriptPath(transcriptPath),
      "019d23d4-f1a9-7633-b9c7-758327137228"
    );
    assert.strictEqual(
      normalizeCodexSessionId("official-session", transcriptPath),
      "codex:019d23d4-f1a9-7633-b9c7-758327137228"
    );
    assert.strictEqual(normalizeCodexSessionId("official-session", "/tmp/rollout.jsonl"), "codex:official-session");
  });

  it("builds SessionStart state payloads", () => {
    const body = buildStateBody({
      hook_event_name: "SessionStart",
      session_id: "s1",
      cwd: "/repo",
      turn_id: "turn-1",
      permission_mode: "default",
      transcript_path: "/tmp/rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl",
      model: "gpt-5.2-codex",
    }, mockResolve);

    assert.strictEqual(body.state, "idle");
    assert.strictEqual(body.session_id, "codex:019d23d4-f1a9-7633-b9c7-758327137228");
    assert.strictEqual(body.agent_id, "codex");
    assert.strictEqual(body.hook_source, "codex-official");
    assert.strictEqual(body.event, "SessionStart");
    assert.strictEqual(body.cwd, "/repo");
    assert.strictEqual(body.turn_id, "turn-1");
    assert.strictEqual(body.permission_mode, "default");
    assert.strictEqual(body.transcript_path, "/tmp/rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl");
    assert.strictEqual(body.model, "gpt-5.2-codex");
    assert.strictEqual(body.source_pid, 123);
    assert.strictEqual(body.agent_pid, 456);
    assert.strictEqual(body.editor, "code");
    assert.deepStrictEqual(body.pid_chain, [789, 456, 123]);
  });

  it("carries Codex Desktop session metadata and prefers persistent agent pid", () => {
    withTempTranscript([
      JSON.stringify({
        type: "session_meta",
        payload: {
          cwd: "/repo",
          originator: "Codex Desktop",
          source: "vscode",
        },
      }),
    ], (transcriptPath) => {
      const body = buildStateBody({
        hook_event_name: "SessionStart",
        session_id: "official-session",
        transcript_path: transcriptPath,
      }, mockResolve);

      assert.strictEqual(body.session_id, "codex:019d23d4-f1a9-7633-b9c7-758327137228");
      assert.strictEqual(body.codex_originator, "Codex Desktop");
      assert.strictEqual(body.codex_source, "vscode");
      assert.strictEqual(body.source_pid, 456);
      assert.strictEqual(body.agent_pid, 456);
      assert.deepStrictEqual(body.pid_chain, [789, 456, 123]);
    });
  });

  it("reads Codex /rename thread_name from session_index.jsonl", () => {
    withTempCodexIndex([
      JSON.stringify({ id: "019d23d4-f1a9-7633-b9c7-758327137228", thread_name: "Old Name" }),
      JSON.stringify({ id: "other", thread_name: "Other" }),
      JSON.stringify({ id: "019d23d4-f1a9-7633-b9c7-758327137228", thread_name: "요구사항개선" }),
    ], (codexDir) => {
      assert.strictEqual(
        readCodexThreadName("codex:019d23d4-f1a9-7633-b9c7-758327137228", { codexDir }),
        "요구사항개선"
      );
    });
  });

  it("sends Codex /rename thread_name as session_title", () => {
    withTempCodexIndex([
      JSON.stringify({ id: "019d23d4-f1a9-7633-b9c7-758327137228", thread_name: "요구사항개선" }),
    ], (codexDir) => {
      const oldCodexHome = process.env.CODEX_HOME;
      process.env.CODEX_HOME = codexDir;
      try {
        const body = buildStateBody({
          hook_event_name: "SessionStart",
          session_id: "official-session",
          transcript_path: "/tmp/rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl",
        }, mockResolve);

        assert.strictEqual(body.session_title, "요구사항개선");
      } finally {
        if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = oldCodexHome;
      }
    });
  });

  it("passes through tool metadata without raw tool_input", () => {
    const toolInput = { command: "npm test", description: "Run tests" };
    const body = buildStateBody({
      hook_event_name: "PreToolUse",
      session_id: "s1",
      turn_id: "turn-1",
      tool_name: "Bash",
      tool_use_id: "tool-1",
      tool_input: toolInput,
    }, mockResolve);

    assert.strictEqual(body.state, "working");
    assert.strictEqual(body.tool_name, "Bash");
    assert.strictEqual(body.tool_use_id, "tool-1");
    assert.strictEqual(body.tool_input_fingerprint, buildToolInputFingerprint(toolInput));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(body, "tool_input"), false);
  });

  it("uses idle as Stop placeholder and carries stop_hook_active=false", () => {
    const body = buildStateBody({
      hook_event_name: "Stop",
      session_id: "s1",
      turn_id: "turn-1",
      stop_hook_active: false,
    }, mockResolve);

    assert.strictEqual(body.state, "idle");
    assert.strictEqual(body.event, "Stop");
    assert.strictEqual(body.stop_hook_active, false);
  });

  it("reads long first-line session_meta and marks subagent state payloads", () => {
    withTempTranscript([
      JSON.stringify({
        type: "session_meta",
        payload: {
          source: { subagent: { thread_spawn: { parent_thread_id: "root", agent_role: "explorer" } } },
          agent_role: "explorer",
          base_instructions: { text: "x".repeat(12000) },
        },
      }),
    ], (transcriptPath) => {
      const meta = readFirstSessionMeta(transcriptPath);
      assert.strictEqual(meta.agent_role, "explorer");

      const body = buildStateBody({
        hook_event_name: "SessionStart",
        session_id: "official-session",
        transcript_path: transcriptPath,
      }, mockResolve);

      assert.strictEqual(body.session_id, "codex:019d23d4-f1a9-7633-b9c7-758327137228");
      assert.strictEqual(body.agent_id, "codex");
      assert.strictEqual(body.codex_session_role, "subagent");
    });
  });

  it("scans early transcript records until session_meta is found", () => {
    withTempTranscript([
      JSON.stringify({ type: "turn_context", payload: { cwd: "/repo" } }),
      "{not json",
      JSON.stringify({
        type: "session_meta",
        payload: {
          source: { subagent: { thread_spawn: { parent_thread_id: "root", agent_role: "worker" } } },
          agent_id: "upstream-agent-id",
          agent_type: "worker",
        },
      }),
    ], (transcriptPath) => {
      const meta = readFirstSessionMeta(transcriptPath);
      assert.strictEqual(meta.agent_type, "worker");

      const body = buildStateBody({
        hook_event_name: "SessionStart",
        session_id: "official-session",
        transcript_path: transcriptPath,
      }, mockResolve);

      assert.strictEqual(body.codex_session_role, "subagent");
      assert.strictEqual(body.codex_subagent_id, "upstream-agent-id");
      assert.strictEqual(body.codex_agent_type, "worker");
    });
  });

  it("renames upstream Codex agent fields without polluting Clawd agent_id", () => {
    const body = buildStateBody({
      hook_event_name: "PreToolUse",
      session_id: "s1",
      agent_id: "upstream-subagent-id",
      agent_type: "explorer",
      source: { subagent: { thread_spawn: { agent_role: "explorer" } } },
    }, mockResolve);

    assert.strictEqual(body.agent_id, "codex");
    assert.strictEqual(body.codex_subagent_id, "upstream-subagent-id");
    assert.strictEqual(body.codex_agent_type, "explorer");
    assert.strictEqual(body.codex_session_role, "subagent");
  });

  it("fails open when transcript_path cannot be read", () => {
    const body = buildStateBody({
      hook_event_name: "SessionStart",
      session_id: "s1",
      transcript_path: path.join(os.tmpdir(), "missing-codex-transcript.jsonl"),
    }, mockResolve);

    assert.strictEqual(body.agent_id, "codex");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(body, "codex_session_role"), false);
  });

  it("no-ops stop_hook_active continuations", () => {
    const body = buildStateBody({
      hook_event_name: "Stop",
      session_id: "s1",
      turn_id: "turn-1",
      stop_hook_active: true,
    }, mockResolve);

    assert.strictEqual(body, null);
  });

  it("builds PermissionRequest payloads for /permission", () => {
    const toolInput = {
      command: "npm test",
      description: "Run tests with approval",
      ignored: "x".repeat(600),
    };
    const body = buildPermissionBody({
      hook_event_name: "PermissionRequest",
      session_id: "s1",
      cwd: "/repo",
      turn_id: "turn-1",
      permission_mode: "default",
      transcript_path: "/tmp/rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl",
      model: "gpt-5.2-codex",
      tool_name: "Bash",
      tool_input: toolInput,
    }, mockResolve);

    assert.strictEqual(body.agent_id, "codex");
    assert.strictEqual(body.hook_source, "codex-official");
    assert.strictEqual(body.session_id, "codex:019d23d4-f1a9-7633-b9c7-758327137228");
    assert.strictEqual(body.tool_name, "Bash");
    assert.strictEqual(body.tool_input.description, "Run tests with approval");
    assert.strictEqual(body.tool_input_description, "Run tests with approval");
    assert.strictEqual(body.tool_input.ignored.length, 240);
    assert.strictEqual(body.tool_input_fingerprint, buildToolInputFingerprint(toolInput));
    assert.strictEqual(body.turn_id, "turn-1");
    assert.strictEqual(body.permission_mode, "default");
    assert.strictEqual(body.source_pid, 123);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(body, "codex_session_role"), false);
  });

  it("carries Codex Desktop metadata on PermissionRequest payloads", () => {
    withTempTranscript([
      JSON.stringify({
        type: "session_meta",
        payload: {
          originator: "Codex Desktop",
          source: "vscode",
        },
      }),
    ], (transcriptPath) => {
      const body = buildPermissionBody({
        hook_event_name: "PermissionRequest",
        session_id: "official-session",
        transcript_path: transcriptPath,
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      }, mockResolve);

      assert.strictEqual(body.session_id, "codex:019d23d4-f1a9-7633-b9c7-758327137228");
      assert.strictEqual(body.codex_originator, "Codex Desktop");
      assert.strictEqual(body.codex_source, "vscode");
      assert.strictEqual(body.source_pid, 456);
      assert.strictEqual(body.agent_pid, 456);
    });
  });

  it("does not classify PermissionRequest payloads even when the transcript is subagent", () => {
    withTempTranscript([
      JSON.stringify({
        type: "session_meta",
        payload: {
          source: { subagent: { thread_spawn: { agent_role: "worker" } } },
          agent_role: "worker",
        },
      }),
    ], (transcriptPath) => {
      const body = buildPermissionBody({
        hook_event_name: "PermissionRequest",
        session_id: "s1",
        transcript_path: transcriptPath,
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      }, mockResolve);

      assert.strictEqual(body.agent_id, "codex");
      assert.strictEqual(Object.prototype.hasOwnProperty.call(body, "codex_session_role"), false);
    });
  });

  it("does not build a state payload for PermissionRequest", () => {
    assert.strictEqual(buildStateBody({ hook_event_name: "PermissionRequest", session_id: "s1" }, mockResolve), null);
  });

  it("sanitizes Codex PermissionRequest output by omitting unsupported keys", () => {
    const output = sanitizeCodexPermissionOutput(JSON.stringify({
      interrupt: true,
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          message: "ignored on allow",
          updatedInput: null,
          updatedPermissions: [{ type: "setMode", mode: "default" }],
          interrupt: true,
        },
      },
    }));
    const parsed = JSON.parse(output);
    const decision = parsed.hookSpecificOutput.decision;

    assert.deepStrictEqual(decision, { behavior: "allow" });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(decision, "updatedInput"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(decision, "updatedPermissions"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(decision, "interrupt"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(parsed, "interrupt"), false);
  });

  it("keeps deny messages in sanitized Codex PermissionRequest output", () => {
    const output = buildCodexPermissionOutput({ behavior: "deny", message: "Blocked" });
    const parsed = JSON.parse(output);

    assert.deepStrictEqual(parsed.hookSpecificOutput.decision, {
      behavior: "deny",
      message: "Blocked",
    });
  });

  it("returns no-decision output for invalid PermissionRequest responses", () => {
    assert.strictEqual(sanitizeCodexPermissionOutput("not json"), buildCodexNoDecisionOutput());
    assert.strictEqual(sanitizeCodexPermissionOutput(JSON.stringify({ hookSpecificOutput: null })), "{}");
  });

  it("writes no stdout and exits 0 when stop_hook_active=true", () => {
    const scriptPath = path.resolve(__dirname, "..", "hooks", "codex-hook.js");
    const result = spawnSync(process.execPath, [scriptPath], {
      input: JSON.stringify({
        hook_event_name: "Stop",
        session_id: "s1",
        turn_id: "turn-1",
        stop_hook_active: true,
      }),
      encoding: "utf8",
      windowsHide: true,
    });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
  });

  describe("remote mode", () => {
    before(() => { process.env.CLAWD_REMOTE = "1"; });
    after(() => { delete process.env.CLAWD_REMOTE; });

    it("uses host instead of local pid fields", () => {
      const body = buildStateBody({ hook_event_name: "UserPromptSubmit", session_id: "s1" }, () => {
        throw new Error("resolve should not run in remote mode");
      });

      assert.strictEqual(typeof body.host, "string");
      assert.strictEqual(Object.prototype.hasOwnProperty.call(body, "source_pid"), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(body, "pid_chain"), false);
    });
  });
});
