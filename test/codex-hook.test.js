const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { runSpawnedHook } = require("./helpers/spawned-hook");
const {
  CODEX_AUTO_START_TIMEOUT_MS,
  buildCodexNoDecisionOutput,
  buildCodexPermissionOutput,
  buildPermissionBody,
  buildStateBody,
  buildToolInputFingerprint,
  extractLastAssistantTextFromTranscript,
  extractCodexSessionIdFromTranscriptPath,
  normalizeCodexSessionId,
  readFirstSessionMeta,
  runCodexHook,
  sanitizeCodexPermissionOutput,
  startClawdAndWait,
} = require("../hooks/codex-hook");
const { readCodexThreadName } = require("../hooks/codex-session-index");
const { CODEX_WSL_INTEROP_ARG } = require("../hooks/server-config");

const mockResolve = () => ({
  stablePid: 123,
  agentPid: 456,
  detectedEditor: "code",
  pidChain: [789, 456, 123],
});

const mockResolveWithWtHwnd = () => ({
  stablePid: 123,
  agentPid: 456,
  detectedEditor: "code",
  pidChain: [789, 456, 123],
  foregroundWtHwnd: "123456",
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

  it("includes foreground WT HWND only on foreground-safe state events", () => {
    const startBody = buildStateBody({
      hook_event_name: "SessionStart",
      session_id: "s1",
    }, mockResolveWithWtHwnd);
    const promptBody = buildStateBody({
      hook_event_name: "UserPromptSubmit",
      session_id: "s1",
    }, mockResolveWithWtHwnd);
    const stopBody = buildStateBody({
      hook_event_name: "Stop",
      session_id: "s1",
    }, mockResolveWithWtHwnd);

    assert.strictEqual(startBody.wt_hwnd, "123456");
    assert.strictEqual(promptBody.wt_hwnd, "123456");
    assert.ok(!("wt_hwnd" in stopBody));
  });

  it("carries Codex Desktop session metadata and prefers persistent agent pid", () => {
    withTempTranscript([
      JSON.stringify({
        type: "session_meta",
        payload: {
          cwd: "/repo",
          originator: "codex_work_desktop",
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
      assert.strictEqual(body.codex_originator, "codex_work_desktop");
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

  it("extracts the latest Codex assistant text without tool or reasoning records", () => {
    withTempTranscript([
      JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({ type: "response_item", payload: { type: "reasoning", text: "hidden thoughts" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "Implemented the fix." },
            { type: "function_call", name: "shell_command", arguments: "{\"command\":\"npm test\"}" },
            { type: "text", text: "Tests pass." },
          ],
        },
      }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
    ], (transcriptPath) => {
      const output = extractLastAssistantTextFromTranscript(transcriptPath);
      assert.deepStrictEqual(output, {
        text: "Implemented the fix.\n\nTests pass.",
        truncated: false,
      });
    });
  });

  it("adds assistant_last_output on Codex Stop when the transcript has final assistant text", () => {
    withTempTranscript([
      JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "All done.\nReady to ship." } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
    ], (transcriptPath) => {
      const body = buildStateBody({
        hook_event_name: "Stop",
        session_id: "official-session",
        transcript_path: transcriptPath,
      }, mockResolve);

      assert.strictEqual(body.assistant_last_output, "All done.\nReady to ship.");
      assert.ok(!("assistant_last_output_truncated" in body));
    });
  });

  it("does not carry a previous Codex turn output across a new task_started boundary", () => {
    withTempTranscript([
      JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Previous answer" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell_command" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
    ], (transcriptPath) => {
      const body = buildStateBody({
        hook_event_name: "Stop",
        session_id: "official-session",
        transcript_path: transcriptPath,
      }, mockResolve);

      assert.ok(!("assistant_last_output" in body));
    });
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

  it("fails closed instead of posting a PermissionRequest with an unknown tool", () => {
    for (const tool_name of [undefined, "", "  ", "Unknown", "unknown"]) {
      assert.strictEqual(buildPermissionBody({
        hook_event_name: "PermissionRequest",
        session_id: "s1",
        tool_name,
        tool_input: {},
      }, mockResolve), null);
    }
  });

  it("carries Codex Desktop metadata on PermissionRequest payloads", () => {
    withTempTranscript([
      JSON.stringify({
        type: "session_meta",
        payload: {
          originator: "codex_work_desktop",
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
      assert.strictEqual(body.codex_originator, "codex_work_desktop");
      assert.strictEqual(body.codex_source, "vscode");
      assert.strictEqual(body.source_pid, 456);
      assert.strictEqual(body.agent_pid, 456);
    });
  });

  it("carries interactive subagent provenance without classifying the permission as headless", () => {
    withTempTranscript([
      JSON.stringify({
        type: "session_meta",
        payload: {
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "parent-1",
                agent_role: "worker",
                agent_nickname: "Halley",
              },
            },
          },
          originator: "codex-tui",
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
      assert.strictEqual(body.codex_session_role, "subagent");
      assert.strictEqual(body.codex_originator, "codex-tui");
      assert.strictEqual(body.codex_source, "cli");
      assert.strictEqual(body.codex_agent_nickname, "Halley");
      assert.strictEqual(body.codex_agent_role, "worker");
      assert.strictEqual(body.codex_parent_thread_id, "parent-1");
      assert.strictEqual(Object.prototype.hasOwnProperty.call(body, "headless"), false);
    });
  });

  it("preserves an explicit process-level headless signal on PermissionRequest", () => {
    const body = buildPermissionBody({
      hook_event_name: "PermissionRequest",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      headless: true,
    }, mockResolve);

    assert.strictEqual(body.headless, true);
  });

  it("forwards a resolver-derived headless signal on PermissionRequest", () => {
    const body = buildPermissionBody({
      hook_event_name: "PermissionRequest",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    }, () => ({
      stablePid: 123,
      agentPid: 456,
      pidChain: [456, 123],
      headless: true,
    }));

    assert.strictEqual(body.headless, true);
  });

  it("does not synthesize CLI provenance for exec, Desktop, or unknown subagents", () => {
    for (const originator of ["codex_exec", "codex_work_desktop", "unknown-client"]) {
      withTempTranscript([
        JSON.stringify({
          type: "session_meta",
          payload: {
            source: { subagent: { thread_spawn: { agent_role: "worker" } } },
            originator,
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

        assert.strictEqual(body.codex_originator, originator);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(body, "codex_source"), false);
      });
    }
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
    const result = runSpawnedHook({
      script: scriptPath,
      payload: {
        hook_event_name: "Stop",
        session_id: "s1",
        turn_id: "turn-1",
        stop_hook_active: true,
      },
      httpContract: "expect-none",
    });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(result.stderr, "");
  });

  it("reuses the runtime port for state and permission hooks", async () => {
    let resolveCalls = 0;
    let identityReads = 0;
    const options = {
      readRuntimeIdentity() {
        identityReads += 1;
        return { ok: true, reason: null, port: 23335, ownerPid: process.pid };
      },
      createPidResolver(resolverOptions) {
        return () => {
          resolveCalls += 1;
          resolverOptions.readRuntimeIdentity();
          return mockResolve();
        };
      },
      postState(_body, options, callback) {
        assert.strictEqual(options.preferredPort, 23335);
        assert.strictEqual(options.runtimePort, 23335);
        callback(true, 23335);
      },
      postPermission(_body, requestOptions, callback) {
        assert.strictEqual(requestOptions.preferredPort, 23335);
        assert.strictEqual(requestOptions.runtimePort, 23335);
        callback(true, 23335, JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "allow" },
          },
        }));
      },
    };
    const stateResult = await runCodexHook({ hook_event_name: "SessionStart", session_id: "s1" }, options);
    const permissionResult = await runCodexHook({
      hook_event_name: "PermissionRequest",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    }, options);

    assert.strictEqual(resolveCalls, 2);
    assert.strictEqual(identityReads, 2);
    assert.strictEqual(stateResult.posted, true);
    assert.strictEqual(stateResult.port, 23335);
    assert.strictEqual(permissionResult.posted, true);
    assert.strictEqual(permissionResult.port, 23335);
  });

  it("starts Clawd and retries a local SessionStart when the server is offline", async () => {
    const posts = [];
    let autoStarts = 0;
    const result = await runCodexHook({
      hook_event_name: "SessionStart",
      session_id: "s1",
    }, {
      resolvePid: mockResolve,
      readCodexAutoStartGate: () => true,
      readRuntimeIdentity: () => null,
      postState(_body, options, callback) {
        posts.push(options);
        if (posts.length === 1) callback(false, null);
        else callback(true, 23334);
      },
      async runAutoStart() {
        autoStarts += 1;
      },
    });

    assert.strictEqual(autoStarts, 1);
    assert.strictEqual(posts.length, 2);
    assert.deepStrictEqual(posts[1], { timeoutMs: 100 });
    assert.strictEqual(result.posted, true);
    assert.strictEqual(result.port, 23334);
  });

  it("does not start Clawd for an offline non-SessionStart event", async () => {
    let autoStarts = 0;
    const result = await runCodexHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "s1",
    }, {
      resolvePid: mockResolve,
      postState(_body, _options, callback) {
        callback(false, null);
      },
      async runAutoStart() {
        autoStarts += 1;
      },
    });

    assert.strictEqual(autoStarts, 0);
    assert.strictEqual(result.posted, false);
  });

  it("fails closed without an enabled Codex auto-start gate", async () => {
    for (const readGate of [
      () => false,
      () => { throw new Error("corrupt gate"); },
    ]) {
      let autoStarts = 0;
      const result = await runCodexHook({
        hook_event_name: "SessionStart",
        session_id: "s1",
      }, {
        resolvePid: mockResolve,
        readCodexAutoStartGate: readGate,
        postState(_body, _options, callback) {
          callback(false, null);
        },
        async runAutoStart() {
          autoStarts += 1;
        },
      });

      assert.strictEqual(autoStarts, 0);
      assert.strictEqual(result.posted, false);
    }
  });

  it("does not start a desktop app for a WSL SessionStart", async () => {
    let autoStarts = 0;
    const result = await runCodexHook({
      hook_event_name: "SessionStart",
      session_id: "s1",
    }, {
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      resolveWslDistro: () => "Ubuntu",
      resolvePid: mockResolve,
      readCodexAutoStartGate: () => true,
      postState(_body, _options, callback) {
        callback(false, null);
      },
      async runAutoStart() {
        autoStarts += 1;
      },
    });

    assert.strictEqual(autoStarts, 0);
    assert.strictEqual(result.posted, false);
  });

  it("does not start a desktop app for Windows-node WSL interop", async () => {
    let autoStarts = 0;
    const result = await runCodexHook({
      hook_event_name: "SessionStart",
      session_id: "s1",
    }, {
      argv: ["node.exe", "codex-hook.js", CODEX_WSL_INTEROP_ARG],
      env: {},
      resolveWslDistro: () => null,
      resolvePid: mockResolve,
      readCodexAutoStartGate: () => true,
      postState(_body, _options, callback) {
        callback(false, null);
      },
      async runAutoStart() {
        autoStarts += 1;
      },
    });

    assert.strictEqual(autoStarts, 0);
    assert.strictEqual(result.posted, false);
  });

  it("rebuilds the retry with fresh PID metadata and runtime port", async () => {
    let resolverCreations = 0;
    let identityReads = 0;
    const postedBodies = [];
    const postedOptions = [];
    const result = await runCodexHook({
      hook_event_name: "SessionStart",
      session_id: "s1",
    }, {
      createPidResolver(resolverOptions) {
        resolverCreations += 1;
        const stablePid = resolverCreations === 1 ? 111 : 222;
        return () => {
          resolverOptions.readRuntimeIdentity();
          return { stablePid, agentPid: 333, pidChain: [333, stablePid] };
        };
      },
      readRuntimeIdentity() {
        identityReads += 1;
        return identityReads >= 2 ? { ok: true, port: 23335, ownerPid: 999 } : null;
      },
      readCodexAutoStartGate: () => true,
      postState(body, options, callback) {
        postedBodies.push(JSON.parse(body));
        postedOptions.push(options);
        callback(postedBodies.length === 2, postedBodies.length === 2 ? 23335 : null);
      },
      async runAutoStart() {},
    });

    assert.strictEqual(resolverCreations, 2);
    assert.strictEqual(postedBodies[0].source_pid, 111);
    assert.strictEqual(postedBodies[1].source_pid, 222);
    assert.deepStrictEqual(postedBodies[1].pid_chain, [333, 222]);
    assert.deepStrictEqual(postedOptions[1], {
      timeoutMs: 100,
      preferredPort: 23335,
      runtimePort: 23335,
    });
    assert.strictEqual(result.body.source_pid, 222);
    assert.strictEqual(result.port, 23335);
  });

  it("re-observes an authoritative runtime after auto-start and skips legacy PID resolution on retry", async () => {
    let observations = 0;
    let legacyResolves = 0;
    const postedBodies = [];
    const postedOptions = [];
    const result = await runCodexHook({
      hook_event_name: "SessionStart",
      session_id: "s-authoritative-retry",
    }, {
      platform: "win32",
      env: {},
      resolveWslDistro: () => null,
      readWindowsProcessChainHookContext() {
        observations += 1;
        if (observations === 1) {
          return {
            identity: { ok: false, reason: "runtime-missing", port: null, ownerPid: null },
            observation: null,
          };
        }
        return {
          identity: { ok: true, reason: null, port: 23335, ownerPid: 999 },
          observation: {
            port: 23335,
            ownerPid: 999,
            version: 1,
            instanceGeneration: "retry-generation",
            agentId: "codex",
            agentMode: "b1a-authoritative",
          },
        };
      },
      processAlive: () => true,
      resolvePid() {
        legacyResolves += 1;
        return { stablePid: 111, agentPid: 222, pidChain: [222, 111] };
      },
      readCodexAutoStartGate: () => true,
      postState(bodyText, options, callback) {
        postedBodies.push(JSON.parse(bodyText));
        postedOptions.push(options);
        callback(postedBodies.length === 2, postedBodies.length === 2 ? 23335 : null);
      },
      async runAutoStart() {},
    });

    assert.strictEqual(observations, 2);
    assert.strictEqual(legacyResolves, 1);
    assert.strictEqual(postedBodies[0].source_pid, 111);
    for (const key of ["source_pid", "agent_pid", "pid_chain", "editor", "wt_hwnd"]) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(postedBodies[1], key), false);
    }
    assert.strictEqual(postedOptions[1].preferredPort, 23335);
    assert.strictEqual(postedOptions[1].runtimePort, 23335);
    assert.strictEqual(postedOptions[1].windowsProcessChain.runtimeObservation.agentMode, "b1a-authoritative");
    assert.strictEqual(result.posted, true);
  });

  describe("startClawdAndWait", () => {
    it("spawns the production helper and cleans up after exit", async () => {
      const child = new EventEmitter();
      const cleared = [];
      let timeoutCallback = null;
      let spawnCall = null;
      const pending = startClawdAndWait({
        spawn(command, args, options) {
          spawnCall = { command, args, options };
          return child;
        },
        setTimeout(callback, timeoutMs) {
          timeoutCallback = callback;
          assert.strictEqual(timeoutMs, CODEX_AUTO_START_TIMEOUT_MS);
          return 42;
        },
        clearTimeout(timer) {
          cleared.push(timer);
        },
      });

      assert.strictEqual(spawnCall.command, process.execPath);
      assert.deepStrictEqual(spawnCall.args, [path.join(__dirname, "..", "hooks", "auto-start.js")]);
      assert.deepStrictEqual(spawnCall.options, { stdio: "ignore", windowsHide: true });
      assert.strictEqual(child.listenerCount("error"), 1);
      assert.strictEqual(child.listenerCount("exit"), 1);
      child.emit("exit", 0);
      await pending;
      assert.deepStrictEqual(cleared, [42]);
      assert.strictEqual(child.listenerCount("error"), 0);
      assert.strictEqual(child.listenerCount("exit"), 0);
      assert.strictEqual(typeof timeoutCallback, "function");
    });

    it("settles on child error and synchronous spawn failure", async () => {
      const child = new EventEmitter();
      const pending = startClawdAndWait({
        spawn: () => child,
        setTimeout: () => 7,
        clearTimeout() {},
      });
      child.emit("error", new Error("spawn failed"));
      await pending;

      await startClawdAndWait({
        spawn() { throw new Error("sync spawn failed"); },
      });
    });

    it("kills a hung helper and removes listeners at the bounded timeout", async () => {
      const child = new EventEmitter();
      let timeoutCallback = null;
      let killed = 0;
      child.kill = () => { killed += 1; };
      const pending = startClawdAndWait({
        spawn: () => child,
        timeoutMs: 25,
        setTimeout(callback, timeoutMs) {
          assert.strictEqual(timeoutMs, 25);
          timeoutCallback = callback;
          return 9;
        },
        clearTimeout() {},
      });

      timeoutCallback();
      await pending;
      assert.strictEqual(killed, 1);
      assert.strictEqual(child.listenerCount("error"), 0);
      assert.strictEqual(child.listenerCount("exit"), 0);
    });
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

    it("does not start a desktop app when remote SessionStart delivery fails", async () => {
      let autoStarts = 0;
      const result = await runCodexHook({
        hook_event_name: "SessionStart",
        session_id: "s1",
      }, {
        postState(_body, _options, callback) {
          callback(false, null);
        },
        async runAutoStart() {
          autoStarts += 1;
        },
      });

      assert.strictEqual(autoStarts, 0);
      assert.strictEqual(result.posted, false);
    });
  });
});
