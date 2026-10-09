const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { runSpawnedHook } = require("./helpers/spawned-hook");
const {
  CODEX_AUTO_START_TIMEOUT_MS,
  applyWindowsStableSidecarEnv,
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
const {
  CODEX_INTERNAL_THREAD_AMBIENT_SUGGESTIONS,
} = require("../hooks/codex-internal-worker");
const { CODEX_WINDOWS_STABLE_ARG, CODEX_WSL_INTEROP_ARG } = require("../hooks/server-config");

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
  // A developer running these tests from a Codex Desktop terminal inherits
  // CODEX_INTERNAL_ORIGINATOR_OVERRIDE. Most hooks here pass no env and no
  // transcript, so clear it around the suite; client-ephemeral tests pass the
  // variable explicitly through options.
  let savedOriginatorOverride;
  before(() => {
    savedOriginatorOverride = process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
    delete process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  });
  after(() => {
    if (savedOriginatorOverride === undefined) delete process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
    else process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = savedOriginatorOverride;
  });

  it("applies a matching native Windows sidecar atomically", () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hook-sidecar-"));
    const stableDir = path.join(codexHome, "clawd-hooks");
    const sidecarPath = path.join(stableDir, "codex-hook.js.windows.run");
    const hookPath = path.resolve(__dirname, "..", "hooks", "codex-hook.js");
    const encode = (value) => Buffer.from(String(value), "utf8").toString("base64");
    fs.mkdirSync(stableDir, { recursive: true });
    try {
      fs.writeFileSync(sidecarPath, [
        "clawd-codex-stable-windows-run-v1",
        encode(process.execPath),
        encode(hookPath),
        `E${encode("CLAWD_TEST_ENV")}.${encode("环境 ✓")}`,
        "",
      ].join("\n"), "utf8");
      const env = {};
      assert.deepStrictEqual(applyWindowsStableSidecarEnv({
        platform: "win32",
        argv: [process.execPath, hookPath, CODEX_WINDOWS_STABLE_ARG],
        env,
        codexHome,
        hookPath,
      }), { applied: true, reason: null, count: 1 });
      assert.strictEqual(env.CLAWD_TEST_ENV, "环境 ✓");

      const unmarkedEnv = {};
      assert.strictEqual(applyWindowsStableSidecarEnv({
        platform: "win32",
        argv: [process.execPath, hookPath],
        env: unmarkedEnv,
        codexHome,
        hookPath,
      }).reason, "not-stable");
      assert.deepStrictEqual(unmarkedEnv, {});

      const mismatchedEnv = {};
      assert.strictEqual(applyWindowsStableSidecarEnv({
        platform: "win32",
        argv: [process.execPath, hookPath, CODEX_WINDOWS_STABLE_ARG],
        env: mismatchedEnv,
        codexHome,
        hookPath: path.join(codexHome, "other", "codex-hook.js"),
      }).reason, "target-mismatch");
      assert.deepStrictEqual(mismatchedEnv, {});

      fs.appendFileSync(sidecarPath, `E${encode("CLAWD_PARTIAL")}.%%%\n`, "utf8");
      const damagedEnv = {};
      assert.deepStrictEqual(applyWindowsStableSidecarEnv({
        platform: "win32",
        argv: [process.execPath, hookPath, CODEX_WINDOWS_STABLE_ARG],
        env: damagedEnv,
        codexHome,
        hookPath,
      }), { applied: false, reason: "invalid" });
      assert.deepStrictEqual(damagedEnv, {}, "a damaged tail must not partially apply earlier env entries");

      const skippedEnv = {};
      assert.strictEqual(applyWindowsStableSidecarEnv({
        platform: "win32",
        argv: [process.execPath, hookPath, CODEX_WINDOWS_STABLE_ARG, CODEX_WSL_INTEROP_ARG],
        env: skippedEnv,
        codexHome,
        hookPath,
      }).reason, "wsl-interop");
      assert.deepStrictEqual(skippedEnv, {});
    } finally {
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

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

  it("uses the parent thread id for Codex Desktop turn-suffixed rollouts", () => {
    const transcriptPath = "/tmp/rollout-2026-09-01T09-35-17-01a04e10-d510-7be1-9577-ba8145e64c2c_01a05a9b-3a56-7af3-b0c3-d599832f7b06.jsonl";

    assert.strictEqual(
      extractCodexSessionIdFromTranscriptPath(transcriptPath),
      "01a04e10-d510-7be1-9577-ba8145e64c2c"
    );
    assert.strictEqual(
      normalizeCodexSessionId("official-session", transcriptPath),
      "codex:01a04e10-d510-7be1-9577-ba8145e64c2c"
    );
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

  for (const event of ["PreCompact", "PostCompact"]) {
    for (const trigger of ["auto", "manual"]) {
      it(`reports ${trigger} ${event} as sweeping without completing the turn`, async () => {
        const payload = {
          hook_event_name: event, session_id: "compact-start",
          turn_id: "compact-turn", cwd: "/repo", transcript_path: null, trigger,
        };
        const posted = [];
        const result = await runCodexHook(payload, {
          platform: "linux", env: {},
          createPidResolver: () => mockResolve,
          postState(body, _options, callback) {
            posted.push(JSON.parse(body));
            callback(true, 23333);
          },
        });
        assert.strictEqual(posted.length, 1);
        assert.strictEqual(posted[0].event, event);
        assert.strictEqual(posted[0].state, "sweeping");
        assert.strictEqual(posted[0].turn_id, "compact-turn");
        assert.strictEqual(posted[0].session_id, "codex:compact-start");
        assert.strictEqual(posted[0].hook_source, "codex-official");
        assert.ok(!Object.hasOwn(posted[0], "assistant_last_output"));
        assert.strictEqual(result.stdout, "");
        assert.strictEqual(require("../agents/codex").eventMap[event], "sweeping");
      });
    }
  }

  it("reports official Interrupt as idle without a completion or approval decision", async () => {
    const posted = [];
    const result = await runCodexHook({ hook_event_name: "Interrupt", session_id: "interrupted",
      turn_id: "T1", cwd: "/repo", transcript_path: null }, {
      platform: "linux", env: {}, createPidResolver: () => mockResolve,
      postState(body, _options, callback) { posted.push(JSON.parse(body)); callback(true, 23333); },
    });
    assert.equal(posted[0].event, "Interrupt");
    assert.equal(posted[0].state, "idle");
    assert.equal(posted[0].turn_id, "T1");
    assert.equal(result.stdout, "");
    assert.equal(require("../agents/codex").eventMap.Interrupt, "idle");
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

  it("issue #1073 follow-up: reports SessionEnd as sleeping with an end lifecycle and no cold start", async () => {
    const posted = [];
    let lifecycle = null;
    let autoStarts = 0;
    let gateReads = 0;
    const result = await runCodexHook({
      hook_event_name: "SessionEnd",
      session_id: "s1",
      reason: "other",
      cwd: "/repo",
    }, {
      env: {},
      resolveWslDistro: () => null,
      resolvePid(input) {
        lifecycle = input.lifecycle;
        return mockResolve();
      },
      readCodexAutoStartGate() {
        gateReads += 1;
        return true;
      },
      postState(body, _options, callback) {
        posted.push(JSON.parse(body));
        callback(false, null);
      },
      async runAutoStart() {
        autoStarts += 1;
      },
    });

    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].state, "sleeping");
    assert.strictEqual(posted[0].event, "SessionEnd");
    assert.strictEqual(lifecycle, "end");
    assert.strictEqual(gateReads, 0);
    assert.strictEqual(autoStarts, 0);
    assert.strictEqual(result.posted, false);
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

  describe("issue #1073: internal memory consolidation worker", () => {
    const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];

    async function withMemoriesHome(fn) {
      const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-memories-"));
      try {
        return await fn(codexHome);
      } finally {
        fs.rmSync(codexHome, { recursive: true, force: true });
      }
    }

    function workerPayload(event, codexHome, extra = {}) {
      return {
        hook_event_name: event,
        session_id: "s1",
        cwd: path.join(codexHome, "memories"),
        ...extra,
      };
    }

    const WINDOWS_CODEX_HOME = "C:\\Users\\Tester\\.codex";

    async function expectDropped(event, options, extraPayload = {}) {
      const calls = {
        posts: 0,
        autoStarts: 0,
        gates: 0,
        resolves: 0,
        identities: 0,
        processChains: 0,
      };
      const probe = (name) => () => {
        calls[name] += 1;
        throw new Error(`${name} must not run for a worker event`);
      };
      const result = await runCodexHook({
        hook_event_name: event,
        session_id: "s1",
        ...extraPayload,
      }, {
        resolveWslDistro: () => null,
        readCodexAutoStartGate: probe("gates"),
        resolvePid: probe("resolves"),
        readRuntimeIdentity: probe("identities"),
        readWindowsProcessChainHookContext: probe("processChains"),
        postState() {
          calls.posts += 1;
        },
        postPermission() {
          throw new Error("permission path must not run for state events");
        },
        async runAutoStart() {
          calls.autoStarts += 1;
        },
        ...options,
      });

      assert.deepStrictEqual(result, { body: null, posted: false, stdout: "" });
      assert.deepStrictEqual(calls, {
        posts: 0,
        autoStarts: 0,
        gates: 0,
        resolves: 0,
        identities: 0,
        processChains: 0,
      });
    }

    for (const event of EVENTS) {
      it(`drops a ${event} win32 worker event without touching any downstream path`, async () => {
        await expectDropped(event, {
          env: { CODEX_HOME: WINDOWS_CODEX_HOME },
          platform: "win32",
        }, {
          cwd: `${WINDOWS_CODEX_HOME}\\memories`,
        });
      });
    }

    for (const event of EVENTS) {
      it(`drops a ${event} worker event on the host platform without touching any downstream path`, async () => {
        await withMemoriesHome(async (codexHome) => {
          await expectDropped(event, { env: { CODEX_HOME: codexHome } }, {
            cwd: path.join(codexHome, "memories"),
          });
        });
      });
    }

    it("passes the platform option through to the worker detector", async () => {
      await expectDropped("PreToolUse", {
        env: { CODEX_HOME: WINDOWS_CODEX_HOME },
        platform: "win32",
      }, {
        cwd: "c:/users/tester/.CODEX/memories",
      });
    });

    it("does not resolve a relative CODEX_HOME against the hook process cwd", async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-memories-cwd-"));
      const memoriesDir = path.join(base, "proj", "memories");
      fs.mkdirSync(memoriesDir, { recursive: true });
      const originalCwd = process.cwd();
      process.chdir(memoriesDir);
      try {
        let posts = 0;
        const result = await runCodexHook({
          hook_event_name: "PreToolUse",
          session_id: "s1",
          cwd: process.cwd(),
        }, {
          env: { CODEX_HOME: ".." },
          resolvePid: mockResolve,
          postState(_body, _options, callback) {
            posts += 1;
            callback(true, 23333);
          },
          async runAutoStart() { throw new Error("unexpected auto-start"); },
        });

        assert.strictEqual(posts, 1, "an ordinary project directory must still post");
        assert.strictEqual(result.posted, true);
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    it("still posts for a real session under a CODEX_HOME containing a parent segment", async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-memories-dotdot-"));
      const target = path.join(base, "target");
      const sub = path.join(target, "sub");
      const link = path.join(base, "link");
      const memoriesDir = path.join(base, "memories");
      fs.mkdirSync(sub, { recursive: true });
      fs.mkdirSync(memoriesDir, { recursive: true });
      fs.symlinkSync(sub, link, process.platform === "win32" ? "junction" : "dir");
      try {
        let posts = 0;
        const result = await runCodexHook({
          hook_event_name: "PreToolUse",
          session_id: "s1",
          cwd: memoriesDir,
        }, {
          env: { CODEX_HOME: `${link}${path.sep}..` },
          resolvePid: mockResolve,
          postState(_body, _options, callback) {
            posts += 1;
            callback(true, 23333);
          },
          async runAutoStart() { throw new Error("unexpected auto-start"); },
        });

        assert.strictEqual(posts, 1, "a real session must still post");
        assert.strictEqual(result.posted, true);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    it("still posts the same events when cwd is an ordinary project directory", async () => {
      await withMemoriesHome(async (codexHome) => {
        for (const event of EVENTS) {
          let posts = 0;
          const result = await runCodexHook({
            hook_event_name: event,
            session_id: "s1",
            cwd: path.join(codexHome, "project"),
          }, {
            env: { CODEX_HOME: codexHome },
            resolvePid: mockResolve,
            postState(_body, _options, callback) {
              posts += 1;
              callback(true, 23333);
            },
            async runAutoStart() { throw new Error("unexpected auto-start"); },
          });

          assert.strictEqual(posts, 1, `${event} must still post`);
          assert.strictEqual(result.posted, true);
        }
      });
    });

    it("still posts worker-cwd events when a transcript_path is present", async () => {
      await withMemoriesHome(async (codexHome) => {
        let posts = 0;
        const result = await runCodexHook(workerPayload("PreToolUse", codexHome, {
          transcript_path: "/tmp/rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl",
        }), {
          env: { CODEX_HOME: codexHome },
          resolvePid: mockResolve,
          postState(_body, _options, callback) {
            posts += 1;
            callback(true, 23333);
          },
          async runAutoStart() { throw new Error("unexpected auto-start"); },
        });

        assert.strictEqual(posts, 1);
        assert.strictEqual(result.posted, true);
      });
    });

    it("still routes a worker-directory PermissionRequest through the permission path", async () => {
      await withMemoriesHome(async (codexHome) => {
        let permissions = 0;
        const result = await runCodexHook({
          hook_event_name: "PermissionRequest",
          session_id: "s1",
          cwd: path.join(codexHome, "memories"),
          tool_name: "Bash",
          tool_input: { command: "npm test" },
        }, {
          env: { CODEX_HOME: codexHome },
          resolvePid: mockResolve,
          postPermission(_body, _requestOptions, callback) {
            permissions += 1;
            callback(true, 23333, JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PermissionRequest",
                decision: { behavior: "allow" },
              },
            }));
          },
        });

        assert.strictEqual(permissions, 1, "permission requests must not be silently dropped");
        assert.strictEqual(result.posted, true);
      });
    });
  });

  describe("issue #1073 follow-up: Codex desktop client ephemeral state events", () => {
    const CLIENT_ENV = { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex" };
    const AMBIENT_GENERATION_PROMPT = "# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project: /repo";
    const AMBIENT_SAFETY_PROMPT = "You are an expert at upholding safety and compliance standards for Codex ambient suggestions";

    async function runClientEphemeralSessionStart(options = {}) {
      const calls = {
        posts: 0,
        autoStarts: 0,
        gates: 0,
        identities: 0,
        processChains: 0,
      };
      const resolveInputs = [];
      const probe = (name) => () => {
        calls[name] += 1;
        throw new Error(`${name} must not run for a client ephemeral SessionStart`);
      };
      const result = await runCodexHook({
        hook_event_name: "SessionStart",
        session_id: "s1",
        cwd: "/repo",
      }, {
        env: CLIENT_ENV,
        platform: "linux",
        resolveWslDistro: () => null,
        readCodexAutoStartGate: probe("gates"),
        resolvePid(input) {
          resolveInputs.push(input);
          return mockResolve();
        },
        readRuntimeIdentity: probe("identities"),
        readWindowsProcessChainHookContext: probe("processChains"),
        postState() {
          calls.posts += 1;
        },
        postPermission() {
          throw new Error("permission path must not run for state events");
        },
        async runAutoStart() {
          calls.autoStarts += 1;
        },
        ...options,
      });
      return { result, calls, resolveInputs };
    }

    it("issue #1073 follow-up: prewarms the process cache for a dropped client SessionStart", async () => {
      const { result, calls, resolveInputs } = await runClientEphemeralSessionStart();

      assert.deepStrictEqual(result, { body: null, posted: false, stdout: "" });
      assert.strictEqual(resolveInputs.length, 1, "the dropped SessionStart must resolve the process once");
      assert.strictEqual(resolveInputs[0].lifecycle, "start");
      assert.strictEqual(resolveInputs[0].cacheable, true);
      assert.deepStrictEqual(calls, {
        posts: 0,
        autoStarts: 0,
        gates: 0,
        identities: 0,
        processChains: 0,
      });
    });

    it("issue #1073 follow-up: prewarms with the same resolver ctx as a normal SessionStart", async () => {
      const captureResolveCtx = async (env) => {
        const inputs = [];
        await runCodexHook({
          hook_event_name: "SessionStart",
          session_id: "s1",
          cwd: "/repo",
        }, {
          env,
          platform: "linux",
          resolveWslDistro: () => null,
          resolvePid(input) {
            inputs.push(input);
            return mockResolve();
          },
          postState(_body, _options, callback) {
            callback(true, 23333);
          },
          async runAutoStart() { throw new Error("unexpected auto-start"); },
        });
        return inputs;
      };

      const clientInputs = await captureResolveCtx(CLIENT_ENV);
      const normalInputs = await captureResolveCtx({});
      assert.strictEqual(clientInputs.length, 1);
      assert.strictEqual(normalInputs.length, 1);
      assert.deepStrictEqual(clientInputs[0], normalInputs[0]);
    });

    it("issue #1073 follow-up: a dropped SessionStart warms the cache the first UserPromptSubmit reads", async () => {
      // Models the Windows contract: `start` populates the pid cache, `prompt`
      // is cache-only. The real resolver cannot run its Windows path off win32,
      // so this pins the lifecycle sequence and shared key the hook must produce.
      const cache = new Map();
      const resolve = (ctx) => {
        const key = `${ctx.namespace}|${ctx.sessionId}|${ctx.cacheCwd}`;
        if (ctx.lifecycle === "start") {
          cache.set(key, { stablePid: 111, agentPid: 222 });
          return { stablePid: 111, agentPid: 222, pidChain: [111, 222] };
        }
        if (ctx.lifecycle === "prompt") {
          return cache.has(key)
            ? { ...cache.get(key), pidChain: [111, 222] }
            : { stablePid: null, agentPid: null, pidChain: [] };
        }
        return { stablePid: 111, agentPid: 222, pidChain: [111, 222] };
      };

      await runCodexHook({
        hook_event_name: "SessionStart",
        session_id: "s1",
        cwd: "/repo",
      }, {
        env: CLIENT_ENV,
        platform: "linux",
        resolveWslDistro: () => null,
        resolvePid: resolve,
        async runAutoStart() { throw new Error("unexpected auto-start"); },
      });

      const posted = [];
      await runCodexHook({
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        cwd: "/repo",
        prompt: "hello from the side chat",
      }, {
        env: CLIENT_ENV,
        platform: "linux",
        resolvePid: resolve,
        postState(body, _options, callback) {
          posted.push(JSON.parse(body));
          callback(true, 23333);
        },
        async runAutoStart() { throw new Error("unexpected auto-start"); },
      });

      assert.strictEqual(posted.length, 1);
      assert.strictEqual(posted[0].source_pid, 111);
      assert.strictEqual(posted[0].agent_pid, 222);
    });

    for (const [name, prompt] of [
      ["generation", "# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project: /repo"],
      ["safety-review", "You are an expert at upholding safety and compliance standards for Codex ambient suggestions"],
    ]) {
      it(`issue #1073 follow-up: tags a client ${name} ambient-suggestion UserPromptSubmit without the prompt text`, async () => {
        const posted = [];
        const result = await runCodexHook({
          hook_event_name: "UserPromptSubmit",
          session_id: "s1",
          prompt,
        }, {
          env: CLIENT_ENV,
          resolvePid: mockResolve,
          postState(body, _options, callback) {
            posted.push(JSON.parse(body));
            callback(true, 23333);
          },
          async runAutoStart() { throw new Error("unexpected auto-start"); },
        });

        assert.strictEqual(posted.length, 1);
        assert.strictEqual(posted[0].codex_internal_thread, CODEX_INTERNAL_THREAD_AMBIENT_SUGGESTIONS);
        const serialized = JSON.stringify(posted[0]);
        assert.strictEqual(serialized.includes("hyperpersonalized"), false);
        assert.strictEqual(serialized.includes("safety and compliance"), false);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(posted[0], "prompt"), false);
        assert.strictEqual(result.posted, true);
      });
    }

    it("issue #1073 follow-up: recognizes the ambient prompt after leading whitespace", async () => {
      const posted = [];
      await runCodexHook({
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        prompt: `\n\t  ${AMBIENT_GENERATION_PROMPT}`,
      }, {
        env: CLIENT_ENV,
        resolvePid: mockResolve,
        postState(body, _options, callback) {
          posted.push(JSON.parse(body));
          callback(true, 23333);
        },
        async runAutoStart() { throw new Error("unexpected auto-start"); },
      });

      assert.strictEqual(posted.length, 1);
      assert.strictEqual(posted[0].codex_internal_thread, CODEX_INTERNAL_THREAD_AMBIENT_SUGGESTIONS);
    });

    it("issue #1073 follow-up: leaves an ordinary client UserPromptSubmit untagged", async () => {
      const posted = [];
      await runCodexHook({
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        prompt: "refactor the parser and run the tests",
      }, {
        env: CLIENT_ENV,
        resolvePid: mockResolve,
        postState(body, _options, callback) {
          posted.push(JSON.parse(body));
          callback(true, 23333);
        },
        async runAutoStart() { throw new Error("unexpected auto-start"); },
      });

      assert.strictEqual(posted.length, 1);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(posted[0], "codex_internal_thread"), false);
    });

    it("issue #1073 follow-up: does not tag a prompt that only contains the ambient text", async () => {
      const posted = [];
      await runCodexHook({
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        prompt: `please explain this line: ${AMBIENT_SAFETY_PROMPT}`,
      }, {
        env: CLIENT_ENV,
        resolvePid: mockResolve,
        postState(body, _options, callback) {
          posted.push(JSON.parse(body));
          callback(true, 23333);
        },
        async runAutoStart() { throw new Error("unexpected auto-start"); },
      });

      assert.strictEqual(posted.length, 1);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(posted[0], "codex_internal_thread"), false);
    });

    it("issue #1073 follow-up: never tags a transcript-backed session that pastes the ambient prompt", async () => {
      const posted = [];
      await runCodexHook({
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        prompt: AMBIENT_GENERATION_PROMPT,
        transcript_path: "/tmp/rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl",
      }, {
        env: CLIENT_ENV,
        resolvePid: mockResolve,
        postState(body, _options, callback) {
          posted.push(JSON.parse(body));
          callback(true, 23333);
        },
        async runAutoStart() { throw new Error("unexpected auto-start"); },
      });

      assert.strictEqual(posted.length, 1);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(posted[0], "codex_internal_thread"), false);
    });

    for (const [event, promptState] of [
      ["PreToolUse", "working"],
      ["PostToolUse", "working"],
      ["PreCompact", "sweeping"],
      ["Stop", "idle"],
    ]) {
      it(`issue #1073 follow-up: still posts a no-transcript client ${event} (side chat)`, async () => {
        const posted = [];
        const result = await runCodexHook({
          hook_event_name: event,
          session_id: "s1",
          tool_name: event === "PreToolUse" || event === "PostToolUse" ? "Bash" : undefined,
        }, {
          env: CLIENT_ENV,
          resolvePid: mockResolve,
          postState(body, _options, callback) {
            posted.push(JSON.parse(body));
            callback(true, 23333);
          },
          async runAutoStart() { throw new Error("unexpected auto-start"); },
        });

        assert.strictEqual(posted.length, 1);
        assert.strictEqual(posted[0].event, event);
        assert.strictEqual(posted[0].state, promptState);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(posted[0], "codex_internal_thread"), false);
        assert.strictEqual(result.posted, true);
      });
    }

    it("issue #1073 follow-up: still posts a no-transcript client SessionStart that carries a transcript", async () => {
      let posts = 0;
      const result = await runCodexHook({
        hook_event_name: "SessionStart",
        session_id: "s1",
        transcript_path: "/tmp/rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl",
      }, {
        env: CLIENT_ENV,
        resolvePid: mockResolve,
        postState(_body, _options, callback) {
          posts += 1;
          callback(true, 23333);
        },
        async runAutoStart() { throw new Error("unexpected auto-start"); },
      });

      assert.strictEqual(posts, 1);
      assert.strictEqual(result.posted, true);
    });

    it("issue #1073 follow-up: still posts a no-transcript SessionStart without the client variable", async () => {
      let posts = 0;
      const result = await runCodexHook({
        hook_event_name: "SessionStart",
        session_id: "s1",
      }, {
        env: {},
        resolvePid: mockResolve,
        postState(_body, _options, callback) {
          posts += 1;
          callback(true, 23333);
        },
        async runAutoStart() { throw new Error("unexpected auto-start"); },
      });

      assert.strictEqual(posts, 1);
      assert.strictEqual(result.posted, true);
    });

    for (const originator of ["", "   "]) {
      it(`issue #1073 follow-up: still posts a no-transcript client UserPromptSubmit when the client variable is ${JSON.stringify(originator)}`, async () => {
        const posted = [];
        await runCodexHook({
          hook_event_name: "UserPromptSubmit",
          session_id: "s1",
          prompt: AMBIENT_GENERATION_PROMPT,
        }, {
          env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: originator },
          resolvePid: mockResolve,
          postState(body, _options, callback) {
            posted.push(JSON.parse(body));
            callback(true, 23333);
          },
          async runAutoStart() { throw new Error("unexpected auto-start"); },
        });

        assert.strictEqual(posted.length, 1);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(posted[0], "codex_internal_thread"), false);
      });
    }

    it("issue #1073 follow-up: still routes a no-transcript client PermissionRequest through permissions", async () => {
      let permissions = 0;
      const result = await runCodexHook({
        hook_event_name: "PermissionRequest",
        session_id: "s1",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      }, {
        env: CLIENT_ENV,
        resolvePid: mockResolve,
        postPermission(_body, _requestOptions, callback) {
          permissions += 1;
          callback(true, 23333, JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision: { behavior: "allow" },
            },
          }));
        },
      });

      assert.strictEqual(permissions, 1);
      assert.strictEqual(result.posted, true);
    });

    it("issue #1073 follow-up: still posts a no-transcript client SessionEnd", async () => {
      const posted = [];
      const result = await runCodexHook({
        hook_event_name: "SessionEnd",
        session_id: "s1",
        reason: "other",
      }, {
        env: CLIENT_ENV,
        resolvePid: mockResolve,
        postState(body, _options, callback) {
          posted.push(JSON.parse(body));
          callback(true, 23333);
        },
        async runAutoStart() { throw new Error("unexpected auto-start"); },
      });

      assert.strictEqual(posted.length, 1);
      assert.strictEqual(posted[0].event, "SessionEnd");
      assert.strictEqual(result.posted, true);
    });
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
