"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const path = require("node:path");

const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
  CLAWD_HOOK_PID_HEADER,
  CLAWD_PROCESS_INSTANCE_HEADER,
} = require("../hooks/server-config");
const {
  MAX_STATE_BODY_BYTES,
  CLAWD_METADATA_ACCEPTED_HEADER,
  sendStateHealthResponse,
  handleStatePost,
} = require("../src/server-route-state");
const { classifyPermissionInteraction } = require("../src/permission-automation-policy");
const { buildStateBody } = require("../hooks/clawd-hook");
const { makeSessionKey } = require("../src/session-key");
const createAgentRuntimeMain = require("../src/agent-runtime-main");
const { createDshStateSequenceFence } = require("../src/dsh-state-sequence");
const initState = require("../src/state");
const themeLoader = require("../src/theme-loader");
themeLoader.init(path.join(__dirname, "..", "src"));
const metadataContractTheme = themeLoader.loadTheme("clawd");
const localSessionKey = (rawSessionId) => makeSessionKey({
  profileId: "local",
  rawSessionId,
});

function makePlanPermission(rawSessionId) {
  return {
    res: {},
    sessionId: localSessionKey(rawSessionId),
    toolName: "ExitPlanMode",
    agentId: "claude-code",
    subagentId: null,
    interaction: classifyPermissionInteraction({
      agentId: "claude-code",
      toolName: "ExitPlanMode",
    }),
  };
}

function makeReq(body, headers = {}) {
  const req = new EventEmitter();
  req.headers = headers;
  setImmediate(() => {
    if (body != null) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function acceptedMetadataSpy(calls) {
  return (...args) => {
    calls.push(args);
    return true;
  };
}

function makeMetadataStateRuntime() {
  const ctx = {
    lang: "en",
    theme: metadataContractTheme,
    doNotDisturb: false,
    miniTransitioning: false,
    miniMode: false,
    mouseOverPet: false,
    idlePaused: false,
    forceEyeResend: false,
    eyePauseUntil: 0,
    mouseStillSince: Date.now(),
    playSound: () => {},
    sendToRenderer: () => {},
    syncHitWin: () => {},
    sendToHitWin: () => {},
    buildContextMenu: () => {},
    buildTrayMenu: () => {},
    pendingPermissions: [],
    processKill: () => { const err = new Error("dead"); err.code = "ESRCH"; throw err; },
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  };
  return initState(ctx);
}

function seedMetadataSession(api, sessionId) {
  api.updateSession(sessionId, "working", "PreToolUse", {
    cwd: "/tmp/opencode-contract",
    agentId: "opencode",
    profileId: "local",
    rawSessionId: sessionId,
  });
}

function makeRes() {
  return {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(code, headers) {
      this.statusCode = code;
      if (headers) this.headers = headers;
    },
    end(data) {
      if (data) this.body += String(data);
      if (this.resolve) this.resolve(this);
    },
  };
}

function callStatePost(body, overrides = {}) {
  return new Promise((resolve) => {
    const res = makeRes();
    res.resolve = resolve;
    const calls = {
      updateSession: [],
      updateAccountQuota: [],
      setState: [],
      recorder: [],
      resolved: [],
      logs: [],
      userInputShown: [],
      userInputCleared: [],
      testResults: [],
    };
    const ctx = {
      STATE_SVGS: {
        idle: "x.svg",
        thinking: "x.svg",
        working: "x.svg",
        juggling: "x.svg",
        error: "x.svg",
        attention: "x.svg",
        notification: "x.svg",
        sleeping: "x.svg",
        "mini-idle": "x.svg",
      },
      pendingPermissions: [],
      sessions: new Map(),
      isAgentEnabled: () => true,
      setState: (...args) => calls.setState.push(args),
      updateSession: (...args) => calls.updateSession.push(args),
      updateAccountQuota: (...args) => calls.updateAccountQuota.push(args),
      resolvePermissionEntry: (perm, behavior, message) => calls.resolved.push({ perm, behavior, message }),
      permLog: (message) => calls.logs.push(message),
      showCodexUserInputBubble: (input) => { calls.userInputShown.push(input); return true; },
      clearCodexUserInputBubbles: (...args) => calls.userInputCleared.push(args),
      handleTestResult: (...args) => calls.testResults.push(args),
      ...overrides.ctx,
    };
    handleStatePost(makeReq(body, overrides.headers), res, {
      ctx,
      createRequestHookRecorder: (identity, data, route) => {
        calls.recorder.push({ identity, data, route });
        return {
          acceptedUnlessDnd: (dropForDnd) => calls.recorder.push({ outcome: dropForDnd ? "dnd" : "accepted" }),
          droppedByDisabled: () => calls.recorder.push({ outcome: "disabled" }),
          droppedByDnd: () => calls.recorder.push({ outcome: "dnd" }),
          droppedInvalidAgent: () => calls.recorder.push({ outcome: "invalid-agent" }),
          droppedUnsupported: () => calls.recorder.push({ outcome: "unsupported" }),
        };
      },
      shouldDropForDnd: () => false,
      codexOfficialTurns: new Map(),
      ...overrides.options,
    });
    res.calls = calls;
  });
}

describe("server-route-state health", () => {
  it("returns the same /state health payload and header", () => {
    const res = makeRes();

    sendStateHealthResponse(res, { getHookServerPort: () => 23334 });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["Content-Type"], "application/json");
    assert.strictEqual(res.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    assert.deepStrictEqual(JSON.parse(res.body), {
      ok: true,
      app: CLAWD_SERVER_ID,
      port: 23334,
    });
  });
});

describe("server-route-state POST", () => {
  it("enforces DSH upstream sequence order across created, event, and disposed callbacks", async () => {
    const fence = createDshStateSequenceFence();
    const post = (event, state, sequence = {}) => callStatePost(JSON.stringify({
      agent_id: "deepseek-harness",
      hook_source: "dsh-plugin",
      session_id: "deepseek-harness:ordered",
      event,
      state,
      ...sequence,
    }), { options: { dshStateSequenceFence: fence } });

    const started = await post("SessionStart", "idle", { session_seq: 0 });
    const event = await post("UserPromptSubmit", "thinking", { event_seq: 0 });
    const duplicate = await post("PreToolUse", "working", { event_seq: 0 });
    const ended = await post("SessionEnd", "sleeping", { session_seq: 1 });
    const late = await post("Stop", "attention", { event_seq: 1 });

    assert.strictEqual(started.statusCode, 200);
    assert.strictEqual(event.statusCode, 200);
    assert.strictEqual(duplicate.statusCode, 204);
    assert.deepStrictEqual(duplicate.calls.updateSession, []);
    assert.deepStrictEqual(duplicate.calls.recorder.map((entry) => entry.outcome).filter(Boolean), ["unsupported"]);
    assert.strictEqual(ended.statusCode, 200);
    assert.strictEqual(late.statusCode, 204);
    assert.deepStrictEqual(late.calls.updateSession, []);
  });

  it("fails DSH state closed when its sequence fence or required watermark is unavailable", async () => {
    const body = {
      agent_id: "deepseek-harness",
      hook_source: "dsh-plugin",
      session_id: "deepseek-harness:missing-fence",
      event: "SessionStart",
      state: "idle",
      session_seq: 0,
    };
    const absent = await callStatePost(JSON.stringify(body));
    const missingWatermark = await callStatePost(JSON.stringify({ ...body, session_seq: undefined }), {
      options: { dshStateSequenceFence: createDshStateSequenceFence() },
    });
    assert.strictEqual(absent.statusCode, 204);
    assert.strictEqual(missingWatermark.statusCode, 204);
    assert.deepStrictEqual(absent.calls.updateSession, []);
    assert.deepStrictEqual(missingWatermark.calls.updateSession, []);
  });

  it("does not advance the DSH sequence fence for a disabled integration", async () => {
    const fence = createDshStateSequenceFence();
    const body = JSON.stringify({
      agent_id: "deepseek-harness",
      hook_source: "dsh-plugin",
      session_id: "deepseek-harness:gated",
      event: "SessionStart",
      state: "idle",
      session_seq: 3,
    });
    const disabled = await callStatePost(body, {
      ctx: { isAgentEnabled: () => false },
      options: { dshStateSequenceFence: fence },
    });
    const enabled = await callStatePost(body, {
      options: { dshStateSequenceFence: fence },
    });
    assert.strictEqual(disabled.statusCode, 204);
    assert.strictEqual(enabled.statusCode, 200);
  });

  it("relays a normalized test result after the lifecycle update", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "test-session",
      event: "PostToolUse",
      agent_id: "claude-code",
      tool_name: "Bash",
      test_result: "pass",
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.updateSession.length, 1);
    assert.deepStrictEqual(res.calls.testResults, [["pass", {
      sessionId: localSessionKey("test-session"),
      agentId: "claude-code",
      event: "PostToolUse",
      headless: false,
    }]]);
  });

  it("drops malformed or out-of-lifecycle test-result tags", async () => {
    for (const body of [
      {
        state: "working",
        session_id: "bad-value",
        event: "PostToolUse",
        agent_id: "claude-code",
        test_result: "PASS",
      },
      {
        state: "idle",
        session_id: "bad-event",
        event: "Stop",
        agent_id: "claude-code",
        test_result: "pass",
      },
      {
        state: "working",
        session_id: "unsupported-source",
        event: "PostToolUse",
        agent_id: "codex",
        test_result: "pass",
      },
    ]) {
      const res = await callStatePost(JSON.stringify(body));
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.calls.testResults, []);
    }
  });

  it("keeps a visual handler failure from failing the state POST", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "error",
      session_id: "visual-failure",
      event: "PostToolUseFailure",
      agent_id: "claude-code",
      test_result: "fail",
    }), {
      ctx: { handleTestResult: () => { throw new Error("renderer gone"); } },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.updateSession.length, 1);
  });

  it("settles only the matching Claude subagent decision from the real hook body", async () => {
    const matching = {
      ...makePlanPermission("subagent-session"),
      subagentId: "agent-child-a",
    };
    const sibling = {
      ...makePlanPermission("subagent-session"),
      subagentId: "agent-child-b",
    };
    const body = buildStateBody(
      "SessionEnd",
      {
        session_id: "subagent-session",
        agent_id: "agent-child-a",
        agent_type: "Explore",
      },
      () => ({
        stablePid: null,
        agentPid: null,
        detectedEditor: null,
        pidChain: [],
      })
    );

    const res = await callStatePost(JSON.stringify(body), {
      ctx: { pendingPermissions: [matching, sibling] },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(
      res.calls.resolved.map(({ perm, behavior }) => ({ perm, behavior })),
      [{ perm: matching, behavior: "no-decision" }]
    );
    const updateOptions = res.calls.updateSession[0][3];
    assert.strictEqual(updateOptions.subagentId, "agent-child-a");
    assert.strictEqual(updateOptions.subagentType, "Explore");
  });

  it("forwards validated subagent provenance and SessionStart source to state", async () => {
    const nativeBody = buildStateBody(
      "SubagentStart",
      { session_id: "sid-native", agent_id: "child-a", agent_type: "Explore" },
      () => ({ stablePid: null, agentPid: null, detectedEditor: null, pidChain: [] })
    );
    const native = await callStatePost(JSON.stringify(nativeBody));
    assert.strictEqual(native.statusCode, 200);
    assert.strictEqual(native.calls.updateSession[0][3].subagentLifecycleSource, "native");

    const syntheticBody = buildStateBody(
      "PreToolUse",
      { session_id: "sid-synthetic", tool_name: "Agent" },
      () => ({ stablePid: null, agentPid: null, detectedEditor: null, pidChain: [] })
    );
    const synthetic = await callStatePost(JSON.stringify(syntheticBody));
    assert.strictEqual(synthetic.statusCode, 200);
    assert.strictEqual(synthetic.calls.updateSession[0][3].subagentLifecycleSource, "synthetic-tool");

    const startBody = buildStateBody(
      "SessionStart",
      { session_id: "sid-start", source: "compact" },
      () => ({ stablePid: null, agentPid: null, detectedEditor: null, pidChain: [] })
    );
    const start = await callStatePost(JSON.stringify(startBody));
    assert.strictEqual(start.statusCode, 200);
    assert.strictEqual(start.calls.updateSession[0][3].sessionStartSource, "compact");

    const invalid = await callStatePost(JSON.stringify({
      state: "juggling",
      session_id: "sid-invalid",
      event: "SubagentStart",
      agent_id: "claude-code",
      subagent_lifecycle_source: "spoofed",
      session_start_source: "spoofed",
    }));
    assert.strictEqual(invalid.calls.updateSession[0][3].subagentLifecycleSource, undefined);
    assert.strictEqual(invalid.calls.updateSession[0][3].sessionStartSource, undefined);
  });

  it("clears main-thread and all subagent decisions on a main-session SessionEnd", async () => {
    const main = makePlanPermission("whole-session");
    const childPlan = {
      ...makePlanPermission("whole-session"),
      subagentId: "agent-child-a",
    };
    const childQuestion = {
      ...makePlanPermission("whole-session"),
      subagentId: "agent-child-b",
      toolName: "AskUserQuestion",
      interaction: classifyPermissionInteraction({
        agentId: "claude-code",
        toolName: "AskUserQuestion",
      }),
    };
    const otherSession = makePlanPermission("other-session");
    const otherAgent = {
      ...makePlanPermission("whole-session"),
      agentId: "codebuddy",
      interaction: classifyPermissionInteraction({
        agentId: "codebuddy",
        toolName: "ExitPlanMode",
      }),
    };

    const res = await callStatePost(JSON.stringify({
      state: "idle",
      session_id: "whole-session",
      event: "SessionEnd",
      agent_id: "claude-code",
    }), {
      ctx: {
        pendingPermissions: [main, childPlan, childQuestion, otherSession, otherAgent],
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(
      res.calls.resolved.map(({ perm, behavior }) => ({ perm, behavior })),
      [
        { perm: main, behavior: "no-decision" },
        { perm: childPlan, behavior: "no-decision" },
        { perm: childQuestion, behavior: "no-decision" },
      ]
    );
  });

  it("uses trusted profile scope for identical remote raw ids, host labels, quota, and user-input actions", async () => {
    const rawSessionId = "shared-raw-id";
    const postFor = (profileId) => callStatePost(JSON.stringify({
      state: "notification",
      session_id: rawSessionId,
      event: "CodexUserInputRequest",
      agent_id: "codex",
      host: "spoofed-by-hook",
      codex_quota: { codexWeekly: { usedPercent: 33 } },
      codex_user_input: {
        phase: "request",
        call_id: "same-call",
        questions: [{
          id: "scope",
          header: "Scope",
          question: "Which scope?",
          options: [{ label: "Focused", description: "One module" }],
        }],
      },
    }), {
      options: {
        remoteProfile: {
          profileId,
          displayHost: "same-display-host",
        },
      },
    });

    const [a, b] = await Promise.all([postFor("profile-a"), postFor("profile-b")]);
    const aId = makeSessionKey({ profileId: "profile-a", rawSessionId });
    const bId = makeSessionKey({ profileId: "profile-b", rawSessionId });
    assert.notStrictEqual(aId, bId);
    assert.strictEqual(a.calls.userInputShown[0].sessionId, aId);
    assert.strictEqual(b.calls.userInputShown[0].sessionId, bId);
    assert.deepStrictEqual(a.calls.updateSession[0].slice(0, 3), [
      aId, "notification", "CodexUserInputRequest",
    ]);
    assert.deepStrictEqual(b.calls.updateSession[0].slice(0, 3), [
      bId, "notification", "CodexUserInputRequest",
    ]);
    for (const [res, profileId] of [[a, "profile-a"], [b, "profile-b"]]) {
      const opts = res.calls.updateSession[0][3];
      assert.strictEqual(opts.profileId, profileId);
      assert.strictEqual(opts.rawSessionId, rawSessionId);
      assert.strictEqual(opts.host, "same-display-host");
      assert.deepStrictEqual(res.calls.updateAccountQuota[0][0], `remote:${profileId}`);
      assert.strictEqual(res.calls.updateAccountQuota[0][1].displayHost, "same-display-host");
    }

    const resolvedA = await callStatePost(JSON.stringify({
      state: "idle",
      session_id: rawSessionId,
      event: "CodexUserInputResolved",
      agent_id: "codex",
      codex_user_input: { phase: "resolved", call_id: "same-call" },
    }), {
      options: {
        remoteProfile: {
          profileId: "profile-a",
          displayHost: "same-display-host",
        },
      },
    });
    assert.deepStrictEqual(resolvedA.calls.userInputCleared, [[
      aId, "same-call", "codex-user-input-resolved",
    ]]);
    assert.notStrictEqual(resolvedA.calls.userInputCleared[0][0], bId);
  });

  it("keeps Codex official turns separate when two remote profiles reuse the same raw ids", async () => {
    const turns = new Map();
    const rawSessionId = "copied-codex-session";
    const base = {
      agent_id: "codex",
      hook_source: "codex-official",
      session_id: rawSessionId,
      turn_id: "same-turn",
    };
    const post = (profileId, event, state) => callStatePost(JSON.stringify({
      ...base,
      event,
      state,
      codex_session_role: "root",
    }), {
      options: {
        remoteProfile: { profileId, displayHost: "shared-host" },
        codexOfficialTurns: turns,
      },
    });

    await post("profile-a", "UserPromptSubmit", "thinking");
    await post("profile-a", "PreToolUse", "working");
    await post("profile-b", "UserPromptSubmit", "thinking");
    const bStop = await post("profile-b", "Stop", "idle");
    const aStop = await post("profile-a", "Stop", "idle");

    assert.strictEqual(bStop.calls.updateSession[0][1], "idle");
    assert.strictEqual(aStop.calls.updateSession[0][1], "attention");
    assert.strictEqual(turns.size, 0);
  });

  it("passes normalized metadata to updateSession", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "PreToolUse",
      display_svg: "/tmp/display.svg",
      source_pid: 123.9,
      wt_hwnd: "123456",
      cwd: "D:\\repo",
      editor: "cursor",
      pid_chain: [1, "bad", 3],
      tmux_socket: "/tmp/tmux-1000/work",
      tmux_client: "/dev/pts/7",
      orca_pane_key: "tab-9:leaf-3",
      agent_pid: 99.8,
      agent_id: "codex",
      host: "remote-host",
      headless: true,
      platform: "webui",
      model: "gpt-5.4",
      provider: "openai",
      codex_originator: "codex_work_desktop",
      codex_source: "vscode",
      ghostty_terminal_id: "ghostty-term-7",
      session_title: "  Work title  ",
      tool_name: "Read",
      transcript_path: "/Users/tester/.claude/projects/repo/session.jsonl",
      permission_suspect: true,
      preserve_state: true,
      hook_source: "codex-official",
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.calls.updateSession, [[
      localSessionKey("sid"),
      "working",
      "PreToolUse",
      {
        sourcePid: 123,
        wtHwnd: "123456",
        cwd: "D:\\repo",
        editor: "cursor",
        pidChain: [1, 3],
        tmuxSocket: "/tmp/tmux-1000/work",
        tmuxClient: "/dev/pts/7",
        orcaPaneKey: "tab-9:leaf-3",
        agentPid: 99,
        agentId: "codex",
        profileId: "local",
        rawSessionId: "sid",
        host: "remote-host",
        wslDistro: null,
        headless: true,
        platform: "webui",
        model: "gpt-5.4",
        provider: "openai",
        codexOriginator: "codex_work_desktop",
        codexSource: "vscode",
        ghosttyTerminalId: "ghostty-term-7",
        displayHint: "display.svg",
        sessionTitle: "Work title",
        contextUsage: null,
        contextUsageOrigin: null,
        assistantLastOutput: null,
        assistantLastOutputTruncated: false,
        toolName: "Read",
        transcriptPath: "/Users/tester/.claude/projects/repo/session.jsonl",
        permissionSuspect: true,
        permissionAction: null,
        permissionCommand: null,
        permissionToolInput: null,
        permissionGateOpen: false,
        permissionGated: false,
        permissionGateId: null,
        preserveState: true,
        hookSource: "codex-official",
        backgroundTasksCount: 0,
        sessionCronsCount: 0,
        stopHookActive: false,
        stdinDiag: null,
        sessionAutomationIdentity: {
          eligible: false,
          reason: "non-authoritative-codex-session-id",
        },
      },
    ]]);
  });

  it("shows and resolves a normalized remote Codex user-input request", async () => {
    const request = await callStatePost(JSON.stringify({
      state: "notification",
      session_id: "codex:remote",
      event: "CodexUserInputRequest",
      agent_id: "codex",
      cwd: "/repo",
      host: "remote-box",
      codex_user_input: {
        phase: "request",
        call_id: "call_remote",
        questions: [{
          id: "scope",
          header: "Scope",
          question: "Which scope?",
          options: [{ label: "Focused", description: "One module" }],
        }],
      },
      codex_quota: { codexWeekly: { usedPercent: 43 } },
    }));

    assert.strictEqual(request.statusCode, 200);
    assert.strictEqual(request.calls.userInputShown.length, 1);
    assert.deepStrictEqual(request.calls.userInputShown[0], {
      sessionId: localSessionKey("codex:remote"),
      callId: "call_remote",
      questions: [{
        id: "scope",
        header: "Scope",
        question: "Which scope?",
        options: [{ label: "Focused", description: "One module" }],
        isOther: false,
        isSecret: false,
      }],
      autoResolutionMs: null,
      sourcePid: null,
      agentPid: null,
      cwd: "/repo",
      host: "remote-box",
      codexOriginator: null,
      codexSource: null,
    });
    assert.strictEqual(request.calls.updateSession[0][1], "notification");
    assert.strictEqual(request.calls.updateSession[0][2], "CodexUserInputRequest");
    assert.strictEqual(request.calls.updateSession[0][3].transientPermissionEvent, true);
    assert.deepStrictEqual(request.calls.updateAccountQuota, [[
      "remote-box",
      { antigravityQuota: null, claudeQuota: null, codexQuota: { codexWeekly: { usedPercent: 43 } } },
    ]]);

    const resolved = await callStatePost(JSON.stringify({
      state: "idle",
      session_id: "codex:remote",
      event: "CodexUserInputResolved",
      agent_id: "codex",
      host: "remote-box",
      codex_quota: { codexFiveHour: { usedPercent: 12 } },
      codex_user_input: { phase: "resolved", call_id: "call_remote" },
    }));
    assert.strictEqual(resolved.statusCode, 200);
    assert.deepStrictEqual(resolved.calls.userInputCleared, [[
      localSessionKey("codex:remote"), "call_remote", "codex-user-input-resolved",
    ]]);
    assert.deepStrictEqual(resolved.calls.updateSession, []);
    assert.deepStrictEqual(resolved.calls.updateAccountQuota, [[
      "remote-box",
      { antigravityQuota: null, claudeQuota: null, codexQuota: { codexFiveHour: { usedPercent: 12 } } },
    ]]);
  });

  it("forwards Kimi Code permission context to updateSession (#563)", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "notification",
      session_id: "kimi-cli:session_abc",
      event: "PermissionRequest",
      agent_id: "kimi-cli",
      tool_name: "Bash",
      permission_action: "Running: echo hi",
      permission_command: "echo hi",
      permission_tool_input: { command: "echo hi" },
    }), { ctx: { STATE_SVGS: { notification: "x.svg" } } });

    assert.strictEqual(res.statusCode, 200);
    const opts = res.calls.updateSession[0][3];
    assert.strictEqual(opts.toolName, "Bash");
    assert.strictEqual(opts.permissionAction, "Running: echo hi");
    assert.strictEqual(opts.permissionCommand, "echo hi");
    assert.deepStrictEqual(opts.permissionToolInput, { command: "echo hi" });
  });

  it("forwards Kimi gate-ledger markers and re-validates their types", async () => {
    const post = (extra) => callStatePost(JSON.stringify({
      state: "working",
      session_id: "kimi-cli:session_abc",
      event: "PreToolUse",
      agent_id: "kimi-cli",
      ...extra,
    }));

    // Well-formed markers pass through; the id is trimmed and clamped.
    const open = await post({
      permission_suspect: true,
      permission_gate_open: true,
      permission_gate_id: `  ${"g".repeat(150)}  `,
    });
    const openOpts = open.calls.updateSession[0][3];
    assert.strictEqual(openOpts.permissionGateOpen, true);
    assert.strictEqual(openOpts.permissionGated, false);
    assert.strictEqual(openOpts.permissionGateId, "g".repeat(100));

    const gated = await post({
      event: "PostToolUse",
      permission_gated: true,
      permission_gate_id: "call_1",
    });
    const gatedOpts = gated.calls.updateSession[0][3];
    assert.strictEqual(gatedOpts.permissionGated, true);
    assert.strictEqual(gatedOpts.permissionGateOpen, false);
    assert.strictEqual(gatedOpts.permissionGateId, "call_1");

    // Wrong types are dropped at the trust boundary — truthiness is not enough.
    const junk = await post({
      permission_gate_open: "yes",
      permission_gated: 1,
      permission_gate_id: { id: "x" },
    });
    const junkOpts = junk.calls.updateSession[0][3];
    assert.strictEqual(junkOpts.permissionGateOpen, false);
    assert.strictEqual(junkOpts.permissionGated, false);
    assert.strictEqual(junkOpts.permissionGateId, null);

    // Whitespace-only id degrades to null, same as an absent field.
    const blank = await post({ permission_gate_id: "   " });
    assert.strictEqual(blank.calls.updateSession[0][3].permissionGateId, null);
  });

  it("re-validates permission_tool_input instead of trusting the hook", async () => {
    const post = (permissionToolInput) => callStatePost(JSON.stringify({
      state: "notification",
      session_id: "kimi-cli:session_abc",
      event: "PermissionRequest",
      agent_id: "kimi-cli",
      tool_name: "Write",
      permission_tool_input: permissionToolInput,
    }), { ctx: { STATE_SVGS: { notification: "x.svg" } } });

    // Non-whitelisted and non-string fields are dropped; strings re-clamped.
    const mixed = await post({
      file_path: ` ${"p".repeat(600)} `,
      content: "never forwarded",
      command: 42,
    });
    const forwarded = mixed.calls.updateSession[0][3].permissionToolInput;
    assert.deepStrictEqual(Object.keys(forwarded), ["file_path"]);
    assert.strictEqual(forwarded.file_path.length, 500);

    // description is deliberately outside the whitelist: formatDetail prefers
    // it over command, so a model-authored string could mask the real command.
    const masked = await post({ command: "rm -rf /tmp/x", description: "Tidy workspace" });
    assert.deepStrictEqual(
      masked.calls.updateSession[0][3].permissionToolInput,
      { command: "rm -rf /tmp/x" }
    );

    const pattern = await post({ pattern: "TODO(kimi)" });
    assert.deepStrictEqual(
      pattern.calls.updateSession[0][3].permissionToolInput,
      { pattern: "TODO(kimi)" }
    );

    // Nothing whitelisted survives -> null, same as an absent field.
    for (const garbage of [{ content: "x" }, "text", [1, 2], 7]) {
      const res = await post(garbage);
      assert.strictEqual(res.calls.updateSession[0][3].permissionToolInput, null);
    }
  });

  it("passes assistant last output metadata to updateSession", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "attention",
      session_id: "sid",
      event: "Stop",
      assistant_last_output: "  Done.\nsecret=abc123  ",
      assistant_last_output_truncated: true,
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.updateSession[0][3].assistantLastOutput, "Done.\nsecret=abc123");
    assert.strictEqual(res.calls.updateSession[0][3].assistantLastOutputTruncated, true);
  });

  it("celebrates Codex official no-tool Stop when assistant output is present", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      session_id: "codex:sid",
      event: "Stop",
      agent_id: "codex",
      hook_source: "codex-official",
      assistant_last_output: "Short answer.",
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.updateSession[0][1], "attention");
    assert.strictEqual(res.calls.updateSession[0][3].assistantLastOutput, "Short answer.");
  });

  it("passes only normalized official Codex turn identity to the runtime", async () => {
    const accepted = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "codex:sid",
      event: "UserPromptSubmit",
      agent_id: "codex",
      hook_source: "codex-official",
      turn_id: "  turn-A  ",
    }));
    assert.strictEqual(accepted.statusCode, 200);
    assert.strictEqual(accepted.calls.updateSession[0][3].turnId, "turn-A");

    const rejected = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "codex:sid",
      event: "UserPromptSubmit",
      agent_id: "codex",
      hook_source: "codex-official",
      turn_id: "x".repeat(257),
    }));
    assert.strictEqual(rejected.statusCode, 200);
    assert.strictEqual(rejected.calls.updateSession[0][3].turnId, undefined);
  });

  it("keeps server side effects and HTTP success when the runtime fences a stale official tail", async () => {
    const updates = [];
    const sessions = new Map();
    const runtime = createAgentRuntimeMain({
      codexSubagentClassifier: {},
      getStateRuntime: () => ({ sessions }),
      updateSession: (...args) => updates.push(args),
    });
    const turns = new Map();
    const rawSessionId = "codex:fence-composition";
    const sessionId = localSessionKey(rawSessionId);
    const base = {
      session_id: rawSessionId,
      agent_id: "codex",
      hook_source: "codex-official",
      turn_id: "turn-A",
    };
    const post = (body, pendingPermissions = []) => callStatePost(JSON.stringify({ ...base, ...body }), {
      ctx: {
        sessions,
        pendingPermissions,
        updateSession: (...args) => runtime.updateSessionFromServer(...args),
      },
      options: { codexOfficialTurns: turns },
    });

    assert.strictEqual((await post({ state: "working", event: "UserPromptSubmit" })).statusCode, 200);
    assert.strictEqual((await post({ state: "attention", event: "Stop" })).statusCode, 200);
    const pending = {
      res: {},
      sessionId,
      agentId: "codex",
      subagentId: null,
      toolName: "shell_command",
      toolUseId: "tool-1",
      interaction: classifyPermissionInteraction({ agentId: "codex", toolName: "shell_command" }),
    };
    const latePost = await post({
      state: "working",
      event: "PostToolUse",
      tool_name: "shell_command",
      tool_use_id: "tool-1",
    }, [pending]);

    assert.strictEqual(latePost.statusCode, 200);
    assert.strictEqual(latePost.calls.resolved.length, 1, "permission cleanup runs before the runtime fence");
    assert.deepStrictEqual(updates.map((call) => call[2]), ["UserPromptSubmit", "Stop"]);
    assert.strictEqual(turns.size, 1, "late Post may recreate the bounded server ledger entry");

    const duplicateStop = await post({ state: "attention", event: "Stop" });
    assert.strictEqual(duplicateStop.statusCode, 200);
    assert.deepStrictEqual(updates.map((call) => call[2]), ["UserPromptSubmit", "Stop"]);
    assert.strictEqual(turns.size, 0, "duplicate Stop still clears the upstream server ledger");

    const vetoed = await callStatePost(JSON.stringify({
      ...base,
      session_id: "codex:vetoed",
      event: "Stop",
      state: "idle",
      stop_hook_active: true,
    }), {
      ctx: { updateSession: (...args) => runtime.updateSessionFromServer(...args) },
      options: { codexOfficialTurns: turns },
    });
    assert.strictEqual(vetoed.statusCode, 204);
    assert.strictEqual(runtime.getCodexTurnFenceSnapshot(localSessionKey("codex:vetoed")), null);
  });

  it("normalizes and passes stdin_diag to updateSession (#583)", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      event: "SessionStart",
      stdin_diag: { bytes: 0, timed_out: true, duration_ms: 2001.7, parse_error: "Unexpected end of JSON input" },
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.calls.updateSession[0][3].stdinDiag, {
      bytes: 0,
      timedOut: true,
      durationMs: 2001,
      parseError: "Unexpected end of JSON input",
    });
  });

  it("passes stdinDiag=null when stdin_diag is absent or malformed", async () => {
    const absent = await callStatePost(JSON.stringify({
      state: "idle",
      session_id: "sid",
      event: "SessionStart",
    }));
    assert.strictEqual(absent.calls.updateSession[0][3].stdinDiag, null);

    const malformed = await callStatePost(JSON.stringify({
      state: "idle",
      session_id: "sid",
      event: "SessionStart",
      stdin_diag: "bytes:0",
    }));
    assert.strictEqual(malformed.calls.updateSession[0][3].stdinDiag, null);
  });

  it("passes valid context_usage to updateSession", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "PreToolUse",
      context_usage: { used: 1000, limit: 200000, percent: 1, source: "claude" },
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.calls.updateSession[0][3].contextUsage, {
      used: 1000,
      limit: 200000,
      percent: 1,
      source: "claude",
    });
    assert.strictEqual(res.calls.updateSession[0][3].contextUsageOrigin, "claude-transcript");
  });

  it("drops invalid context_usage without rejecting state", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "PreToolUse",
      context_usage: { used: -1, limit: 0 },
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.updateSession[0][3].contextUsage, null);
  });

  // Account quota is session-independent: any POST carrying it feeds the
  // per-source store (keyed by the reporting host, null = local), and it
  // never rides updateSession opts.
  it("routes valid antigravity_quota to updateAccountQuota, not updateSession", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      session_id: "sid",
      antigravity_quota: {
        geminiFiveHour: { usedPercent: 100 },
        geminiWeekly: { usedPercent: 98, resetAt: 1738831180000 },
      },
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.updateAccountQuota.length, 1);
    assert.strictEqual(res.calls.updateAccountQuota[0][0], null);
    assert.deepStrictEqual(res.calls.updateAccountQuota[0][1].antigravityQuota, {
      geminiFiveHour: { usedPercent: 100 },
      geminiWeekly: { usedPercent: 98, resetAt: 1738831180000 },
    });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(res.calls.updateSession[0][3], "antigravityQuota"), false);
  });

  it("does not call updateAccountQuota for invalid antigravity_quota", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      session_id: "sid",
      antigravity_quota: { geminiFiveHour: { usedPercent: "not-a-number" } },
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.updateAccountQuota.length, 0);
  });

  it("routes claude_quota to updateAccountQuota keyed by the reporting host", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      session_id: "sid",
      host: "raspberrypi",
      claude_quota: {
        claudeFiveHour: { usedPercent: 24, resetAt: 1738425600000 },
        claudeWeekly: { usedPercent: 41 },
      },
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.updateAccountQuota.length, 1);
    assert.strictEqual(res.calls.updateAccountQuota[0][0], "raspberrypi");
    assert.deepStrictEqual(res.calls.updateAccountQuota[0][1].claudeQuota, {
      claudeFiveHour: { usedPercent: 24, resetAt: 1738425600000 },
      claudeWeekly: { usedPercent: 41 },
    });
  });

  it("does not call updateAccountQuota for invalid claude_quota", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      session_id: "sid",
      claude_quota: { claudeFiveHour: { usedPercent: "not-a-number" } },
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.updateAccountQuota.length, 0);
  });

  // #590 B2 — metadata_only POSTs (statusline refreshes) bypass the
  // updateSession lifecycle machine entirely and go through
  // updateSessionMetadata, which can only annotate an existing session.
  it("routes metadata_only POSTs around updateSession: quota to the store, context to updateSessionMetadata", async () => {
    const metadataCalls = [];
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      preserve_state: true,
      metadata_only: true,
      session_id: "sid",
      agent_id: "claude-code",
      context_usage: { used: 50000, limit: 200000, percent: 25, source: "claude" },
      claude_quota: { claudeWeekly: { usedPercent: 41, resetAt: 1738831180000 } },
    }), {
      ctx: { updateSessionMetadata: acceptedMetadataSpy(metadataCalls) },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_METADATA_ACCEPTED_HEADER], "1");
    assert.strictEqual(res.calls.updateSession.length, 0);
    assert.strictEqual(res.calls.setState.length, 0);
    assert.strictEqual(res.calls.updateAccountQuota.length, 1);
    assert.strictEqual(res.calls.updateAccountQuota[0][0], null);
    assert.deepStrictEqual(res.calls.updateAccountQuota[0][1].claudeQuota, {
      claudeWeekly: { usedPercent: 41, resetAt: 1738831180000 },
    });
    assert.strictEqual(metadataCalls.length, 1);
    assert.strictEqual(metadataCalls[0][0], localSessionKey("sid"));
    assert.deepStrictEqual(metadataCalls[0][1], {
      contextUsage: { used: 50000, limit: 200000, percent: 25, source: "claude" },
      contextUsageOrigin: "claude-statusline",
    });
  });

  it("drops local Claude statusline context and quota while the telemetry gate is closed", async () => {
    const metadataCalls = [];
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      metadata_only: true,
      session_id: "sid",
      agent_id: "claude-code",
      host: "wsl:Ubuntu",
      context_usage: { used: 80000, limit: 1000000, percent: 8, source: "claude" },
      claude_quota: { claudeWeekly: { usedPercent: 12 } },
    }), {
      ctx: { updateSessionMetadata: acceptedMetadataSpy(metadataCalls) },
      options: { isClaudeStatuslineMetadataAllowed: () => false },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_METADATA_ACCEPTED_HEADER], undefined);
    assert.deepStrictEqual(metadataCalls, []);
    assert.deepStrictEqual(res.calls.updateAccountQuota, []);
  });

  it("keeps remote Claude statusline metadata outside the local telemetry gate", async () => {
    const metadataCalls = [];
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      metadata_only: true,
      session_id: "sid",
      agent_id: "claude-code",
      host: "spoofed-host",
      context_usage: { used: 80000, limit: 1000000, percent: 8, source: "claude" },
      claude_quota: { claudeWeekly: { usedPercent: 12 } },
    }), {
      ctx: { updateSessionMetadata: acceptedMetadataSpy(metadataCalls) },
      options: {
        isClaudeStatuslineMetadataAllowed: () => false,
        remoteProfile: { profileId: "ssh-work", displayHost: "workbox" },
      },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_METADATA_ACCEPTED_HEADER], "1");
    assert.strictEqual(res.calls.updateAccountQuota[0][0], "remote:ssh-work");
    assert.strictEqual(res.calls.updateAccountQuota[0][1].displayHost, "workbox");
    assert.deepStrictEqual(res.calls.updateAccountQuota[0][1].claudeQuota, {
      claudeWeekly: { usedPercent: 12 },
    });
    assert.strictEqual(metadataCalls[0][0], makeSessionKey({
      profileId: "ssh-work",
      rawSessionId: "sid",
    }));
    assert.strictEqual(metadataCalls[0][1].contextUsageOrigin, "claude-statusline");
  });

  it("keeps ordinary Claude lifecycle context when only statusline telemetry is gated", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "sid",
      agent_id: "claude-code",
      event: "PreToolUse",
      context_usage: { used: 90000, limit: 200000, percent: 45, source: "claude" },
    }), {
      options: { isClaudeStatuslineMetadataAllowed: () => false },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.updateSession.length, 1);
    assert.strictEqual(res.calls.updateSession[0][3].contextUsageOrigin, "claude-transcript");
  });

  it("does not label another agent's metadata-only context as Claude statusline authority", async () => {
    const metadataCalls = [];
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      metadata_only: true,
      session_id: "agy-session",
      agent_id: "antigravity-cli",
      context_usage: { used: 32000, limit: 128000, percent: 25, source: "antigravity" },
      contextUsageOrigin: "claude-statusline",
    }), {
      ctx: { updateSessionMetadata: acceptedMetadataSpy(metadataCalls) },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(metadataCalls.length, 1);
    assert.strictEqual(metadataCalls[0][1].contextUsageOrigin, null);
  });

  // #830 — opencode-family plugin posts metadata_only contextUsage with
  // source "opencode"; the route must label it with the opencode-statusline
  // origin (same authority contract as claude-statusline telemetry).
  it("labels opencode metadata-only context with the opencode-statusline origin", async () => {
    const metadataCalls = [];
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      metadata_only: true,
      session_id: "oc:abc",
      agent_id: "opencode",
      context_usage: { used: 32000, limit: 128000, percent: 25, source: "opencode" },
    }), {
      ctx: { updateSessionMetadata: acceptedMetadataSpy(metadataCalls) },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_METADATA_ACCEPTED_HEADER], "1");
    assert.strictEqual(metadataCalls.length, 1);
    assert.strictEqual(metadataCalls[0][0], localSessionKey("oc:abc"));
    assert.strictEqual(metadataCalls[0][1].contextUsageOrigin, "opencode-statusline");
    assert.deepStrictEqual(metadataCalls[0][1].contextUsage, {
      used: 32000,
      limit: 128000,
      percent: 25,
      source: "opencode",
    });
  });

  it("does not acknowledge metadata rejected by the state owner", async () => {
    const metadataCalls = [];
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      metadata_only: true,
      session_id: "opencode:missing",
      agent_id: "opencode",
      context_usage: { used: 100, limit: 1000, source: "opencode" },
    }), {
      ctx: {
        updateSessionMetadata: (...args) => {
          metadataCalls.push(args);
          return false;
        },
      },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    assert.strictEqual(res.headers[CLAWD_METADATA_ACCEPTED_HEADER], undefined);
    assert.strictEqual(metadataCalls.length, 1);
  });

  it("keeps OpenCode route forwarding inside the real state acceptance domain", async () => {
    const api = makeMetadataStateRuntime();
    const sessionId = localSessionKey("opencode:contract");
    seedMetadataSession(api, sessionId);
    const forwarded = [];
    const updateSessionMetadata = (...args) => {
      forwarded.push(args);
      return api.updateSessionMetadata(...args);
    };
    const post = (fields) => callStatePost(JSON.stringify({
      state: "idle",
      metadata_only: true,
      session_id: "opencode:contract",
      agent_id: "opencode",
      ...fields,
    }), { ctx: { updateSessionMetadata } });

    try {
      const changed = await post({
        context_usage: { used: 100, limit: 1000, source: "opencode" },
      });
      assert.strictEqual(changed.headers[CLAWD_METADATA_ACCEPTED_HEADER], "1");
      assert.strictEqual(Object.hasOwn(forwarded.at(-1)[1], "contextUsage"), true);
      assert.deepStrictEqual(forwarded.at(-1)[1].contextUsage, {
        used: 100,
        limit: 1000,
        percent: 10,
        source: "opencode",
      });

      const metadataStamp = api.sessions.get(sessionId).metadataUpdatedAt;
      const identical = await post({
        context_usage: { used: 100, limit: 1000, source: "opencode" },
      });
      assert.strictEqual(identical.headers[CLAWD_METADATA_ACCEPTED_HEADER], "1");
      assert.strictEqual(api.sessions.get(sessionId).metadataUpdatedAt, metadataStamp, "accepted no-op must not restamp freshness");

      const withoutLimit = await post({
        context_usage: { used: 120, source: "opencode" },
      });
      assert.strictEqual(withoutLimit.headers[CLAWD_METADATA_ACCEPTED_HEADER], "1");
      assert.deepStrictEqual(api.sessions.get(sessionId).contextUsage, {
        used: 120,
        source: "opencode",
      });

      const titleOnly = await post({ session_title: "\u0001\u0002" });
      assert.strictEqual(titleOnly.headers[CLAWD_METADATA_ACCEPTED_HEADER], undefined);

      const merged = await post({
        session_title: "\u0001\u0002",
        context_usage: { used: 150, limit: 1000, source: "opencode" },
      });
      assert.strictEqual(merged.headers[CLAWD_METADATA_ACCEPTED_HEADER], "1");
      assert.strictEqual(Object.hasOwn(forwarded.at(-1)[1], "contextUsage"), true);
      assert.strictEqual(api.sessions.get(sessionId).contextUsage.used, 150);
      assert.strictEqual(api.sessions.get(sessionId).sessionTitle, null, "invalid title must not block valid context");
    } finally {
      api.cleanup();
    }
  });

  it("does not acknowledge a fully invalid metadata payload", async () => {
    const metadataCalls = [];
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      metadata_only: true,
      session_id: "opencode:invalid",
      agent_id: "opencode",
      context_usage: { used: "not-a-number", source: "opencode" },
    }), {
      ctx: { updateSessionMetadata: acceptedMetadataSpy(metadataCalls) },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_METADATA_ACCEPTED_HEADER], undefined);
    assert.strictEqual(metadataCalls.length, 0);
  });

  it("labels opencode lifecycle context with the opencode-statusline origin (state POSTs)", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "oc:abc",
      agent_id: "opencode",
      event: "PreToolUse",
      context_usage: { used: 90000, limit: 200000, percent: 45, source: "opencode" },
    }), {});

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.updateSession.length, 1);
    assert.strictEqual(res.calls.updateSession[0][3].contextUsageOrigin, "opencode-statusline");
  });

  it("does not label mismatched opencode provenance as statusline authority", async () => {
    const metadataCalls = [];
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      metadata_only: true,
      session_id: "oc:abc",
      agent_id: "opencode",
      context_usage: { used: 90000, limit: 200000, percent: 45, source: "claude" },
    }), {
      ctx: { updateSessionMetadata: acceptedMetadataSpy(metadataCalls) },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(metadataCalls.length, 1);
    assert.strictEqual(
      metadataCalls[0][1].contextUsageOrigin,
      null,
      "opencode agent + claude source must not borrow the opencode-statusline origin"
    );
    assert.deepStrictEqual(metadataCalls[0][1].contextUsage, {
      used: 90000,
      limit: 200000,
      percent: 45,
      source: "claude",
    });
  });

  it("routes remote metadata_only codex_quota to the store keyed by host (remote monitor POSTs)", async () => {
    const metadataCalls = [];
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      preserve_state: true,
      metadata_only: true,
      session_id: "codex:abc",
      agent_id: "codex",
      host: "raspberrypi",
      codex_quota: {
        codexFiveHour: { usedPercent: 1, resetAt: 1783669570000 },
        codexWeekly: { usedPercent: 43, resetAt: 1784256370000 },
      },
    }), {
      ctx: { updateSessionMetadata: acceptedMetadataSpy(metadataCalls) },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_METADATA_ACCEPTED_HEADER], undefined);
    assert.strictEqual(res.calls.updateSession.length, 0);
    assert.strictEqual(res.calls.updateAccountQuota.length, 1);
    assert.strictEqual(res.calls.updateAccountQuota[0][0], "raspberrypi");
    assert.deepStrictEqual(res.calls.updateAccountQuota[0][1].codexQuota, {
      codexFiveHour: { usedPercent: 1, resetAt: 1783669570000 },
      codexWeekly: { usedPercent: 43, resetAt: 1784256370000 },
    });
    // No context payload → no session annotation call at all ("session
    // unknown" is not even reached; quota no longer depends on sessions).
    assert.strictEqual(metadataCalls.length, 0);
  });

  it("routes remote metadata_only Spark quota through its independent provider", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      preserve_state: true,
      metadata_only: true,
      session_id: "codex:abc",
      agent_id: "codex",
      host: "raspberrypi",
      codex_spark_quota: {
        codexWeekly: { usedPercent: 7, windowMinutes: 10080, resetAt: 1784256370000 },
      },
    }));

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.calls.updateSession.length, 0);
    assert.strictEqual(res.calls.updateAccountQuota.length, 1);
    assert.strictEqual(res.calls.updateAccountQuota[0][0], "raspberrypi");
    assert.deepStrictEqual(res.calls.updateAccountQuota[0][1].codexSparkQuota, {
      codexWeekly: { usedPercent: 7, windowMinutes: 10080, resetAt: 1784256370000 },
    });
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(res.calls.updateAccountQuota[0][1], "codexSparkQuota"),
      true
    );
  });

  it("keeps valid generic quota when a sibling Spark payload is invalid", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      metadata_only: true,
      session_id: "codex:abc",
      agent_id: "codex",
      codex_quota: {
        codexWeekly: { usedPercent: 12, windowMinutes: 10080 },
      },
      codex_spark_quota: {
        codexWeekly: { usedPercent: "not-a-number" },
      },
    }));

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.calls.updateAccountQuota.length, 1);
    assert.deepStrictEqual(res.calls.updateAccountQuota[0][1].codexQuota, {
      codexWeekly: { usedPercent: 12, windowMinutes: 10080 },
    });
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(res.calls.updateAccountQuota[0][1], "codexSparkQuota"),
      false
    );
  });

  it("does not update account quota for an invalid Spark-only payload", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      metadata_only: true,
      session_id: "codex:abc",
      agent_id: "codex",
      codex_spark_quota: {
        codexWeekly: { usedPercent: "not-a-number" },
      },
    }));

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.calls.updateAccountQuota.length, 0);
  });

  it("metadata_only still respects the disabled-agent gate", async () => {
    const metadataCalls = [];
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      metadata_only: true,
      session_id: "sid",
      agent_id: "claude-code",
      claude_quota: { claudeWeekly: { usedPercent: 41 } },
    }), {
      ctx: {
        isAgentEnabled: () => false,
        updateSessionMetadata: acceptedMetadataSpy(metadataCalls),
      },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_METADATA_ACCEPTED_HEADER], undefined);
    assert.strictEqual(metadataCalls.length, 0);
    assert.strictEqual(res.calls.updateAccountQuota.length, 0);
  });

  it("metadata_only does not record into the recent-hook-events ring", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      metadata_only: true,
      session_id: "sid",
      agent_id: "claude-code",
      claude_quota: { claudeWeekly: { usedPercent: 41 } },
    }), {
      ctx: { updateSessionMetadata: () => true },
    });

    assert.strictEqual(res.statusCode, 204);
    const outcomes = res.calls.recorder.filter((entry) => entry.outcome);
    assert.deepStrictEqual(outcomes, []);
  });

  it("metadata_only session_title routes to updateSessionMetadata, not updateSession", async () => {
    const metadataCalls = [];
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      metadata_only: true,
      session_id: "opencode:ses_x",
      agent_id: "opencode",
      session_title: "My Real Title",
    }), {
      ctx: { updateSessionMetadata: acceptedMetadataSpy(metadataCalls) },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_METADATA_ACCEPTED_HEADER], "1");
    assert.strictEqual(res.calls.updateSession.length, 0, "title-only metadata must not call updateSession");
    assert.strictEqual(res.calls.setState.length, 0);
    assert.strictEqual(metadataCalls.length, 1);
    assert.strictEqual(metadataCalls[0][0], localSessionKey("opencode:ses_x"));
    assert.deepStrictEqual(metadataCalls[0][1], { sessionTitle: "My Real Title" });
  });

  it("metadata_only session_title is allowed even when the Claude telemetry gate blocks context", async () => {
    const metadataCalls = [];
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      metadata_only: true,
      session_id: "sid",
      agent_id: "claude-code",
      session_title: "Title Despite Gate",
      context_usage: { used: 50000, limit: 200000, percent: 25, source: "claude" },
    }), {
      ctx: { updateSessionMetadata: acceptedMetadataSpy(metadataCalls) },
      options: { isClaudeStatuslineMetadataAllowed: () => false },
    });

    assert.strictEqual(res.statusCode, 204);
    // The gate drops the context data, but the title is not Claude statusline
    // data and must still flow through.
    assert.strictEqual(metadataCalls.length, 1);
    assert.deepStrictEqual(metadataCalls[0][1], { sessionTitle: "Title Despite Gate" });
  });

  it("metadata_only title+context in one POST becomes one metadata update", async () => {
    const metadataCalls = [];
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      metadata_only: true,
      session_id: "opencode:ses_z",
      agent_id: "opencode",
      session_title: "Titled + quota",
      context_usage: { used: 300, limit: 1000, percent: 30, source: "codex" },
    }), {
      ctx: { updateSessionMetadata: acceptedMetadataSpy(metadataCalls) },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_METADATA_ACCEPTED_HEADER], "1");
    assert.strictEqual(metadataCalls.length, 1, "title+context should coalesce into a single metadata update");
    assert.deepStrictEqual(metadataCalls[0][1], {
      contextUsage: { used: 300, limit: 1000, percent: 30, source: "codex" },
      contextUsageOrigin: null,
      sessionTitle: "Titled + quota",
    });
  });

  it("metadata_only with neither title nor context performs no metadata update", async () => {
    const metadataCalls = [];
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      metadata_only: true,
      session_id: "opencode:ses_w",
      agent_id: "opencode",
    }), {
      ctx: { updateSessionMetadata: acceptedMetadataSpy(metadataCalls) },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_METADATA_ACCEPTED_HEADER], undefined);
    assert.strictEqual(metadataCalls.length, 0, "empty metadata payload must not call updateSessionMetadata");
  });

  it("marks missing agent_id as a defaulted Claude Code attribution", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "legacy-sid",
      event: "PreToolUse",
    }));

    assert.strictEqual(res.statusCode, 200);
    const opts = res.calls.updateSession[0][3];
    assert.strictEqual(opts.agentId, "claude-code");
    assert.strictEqual(opts.agentIdDefaulted, true);
  });

  it("assesses the raw state session id before fallback and ignores sender eligibility", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "default",
      event: "PreToolUse",
      agent_id: "claude-code",
      sessionAutomationEligible: true,
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.updateSession[0][0], localSessionKey("default"));
    assert.deepStrictEqual(
      res.calls.updateSession[0][3].sessionAutomationIdentity,
      { eligible: false, reason: "placeholder-session-id" }
    );
  });

  it("marks only local process-bound Codex TUI state identities eligible", async () => {
    const sessionId = "codex:019f9c87-23a9-7d03-a7ac-c11e3270c3b8";
    const body = {
      state: "working",
      session_id: sessionId,
      event: "PreToolUse",
      agent_id: "codex",
      hook_source: "codex-official",
      agent_pid: 777,
      codex_originator: "codex-tui",
      codex_source: "cli",
    };

    const local = await callStatePost(JSON.stringify(body));
    assert.deepStrictEqual(
      local.calls.updateSession[0][3].sessionAutomationIdentity,
      { eligible: true, reason: "eligible" }
    );

    const remote = await callStatePost(JSON.stringify(body), {
      options: {
        remoteProfile: { profileId: "ssh-work", displayHost: "workbox" },
      },
    });
    assert.deepStrictEqual(
      remote.calls.updateSession[0][3].sessionAutomationIdentity,
      {
        eligible: false,
        reason: "remote-session-lifecycle-not-authoritative",
      }
    );
  });

  it("routes state events to a currently registered custom AI", async () => {
    const id = "custom-nova-ai-0123456789ab";
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "PreToolUse",
      agent_id: id,
    }), { ctx: { getCustomAgentIds: () => [id] } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.updateSession[0][0], localSessionKey(`${id}:sid`));
    assert.strictEqual(res.calls.updateSession[0][3].agentId, id);
  });

  it("namespaces identical custom and built-in session ids independently", async () => {
    const firstId = "custom-nova-ai-0123456789ab";
    const secondId = "custom-orbit-ai-0123456789ab";
    const customIds = [firstId, secondId];
    const post = (agent_id, session_id, event = "PreToolUse") => callStatePost(JSON.stringify({
      state: "working",
      session_id,
      event,
      agent_id,
    }), { ctx: { getCustomAgentIds: () => customIds } });

    const [first, second, customDefault, builtin] = await Promise.all([
      post(firstId, "shared"),
      post(secondId, "shared", "SessionEnd"),
      post(firstId, ""),
      post("claude-code", "shared"),
    ]);

    assert.strictEqual(first.calls.updateSession[0][0], localSessionKey(`${firstId}:shared`));
    assert.strictEqual(second.calls.updateSession[0][0], localSessionKey(`${secondId}:shared`));
    assert.strictEqual(customDefault.calls.updateSession[0][0], localSessionKey(`${firstId}:default`));
    assert.strictEqual(builtin.calls.updateSession[0][0], localSessionKey("shared"));
  });

  it("rejects stale custom ids before hook_source fallback", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "stale:sid",
      event: "PreToolUse",
      agent_id: "custom-stale-0123456789ab",
      hook_source: "copilot-hook",
    }));

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.calls.updateSession.length, 0);
    assert.deepStrictEqual(res.calls.recorder.map((item) => item.outcome).filter(Boolean), ["invalid-agent"]);
  });

  it("infers opencode from hook_source when agent_id is missing", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "opencode-sid",
      event: "PreToolUse",
      hook_source: "opencode-plugin",
    }));

    assert.strictEqual(res.statusCode, 200);
    const opts = res.calls.updateSession[0][3];
    assert.strictEqual(opts.agentId, "opencode");
    assert.strictEqual(opts.hookSource, "opencode-plugin");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(opts, "agentIdDefaulted"), false);
  });

  it("uses basename for explicit svg state overrides", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "working",
      svg: "/tmp/pet.svg",
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.calls.setState, [["working", "pet.svg"]]);
  });

  it("drops disabled agents with a 204 and records the disabled outcome", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "working",
      agent_id: "codex",
    }), {
      ctx: {
        isAgentEnabled: (agentId) => agentId !== "codex",
      },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    assert.deepStrictEqual(res.calls.recorder.map((entry) => entry.outcome).filter(Boolean), ["disabled"]);
    assert.deepStrictEqual(res.calls.updateSession, []);
  });

  it("returns 400 for mini states without an svg override", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "mini-idle",
    }));

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body, "mini states require svg override");
  });

  it("returns 413 when the body exceeds MAX_STATE_BODY_BYTES", async () => {
    const body = JSON.stringify({
      state: "working",
      session_title: "x".repeat(MAX_STATE_BODY_BYTES),
    });

    const res = await callStatePost(body);

    assert.strictEqual(res.statusCode, 413);
    assert.strictEqual(res.body, "state payload too large");
  });

  it("accepts a large CJK Stop body now that the cap is 16KB (happy-413 regression)", async () => {
    const body = JSON.stringify({
      state: "attention",
      session_id: "sid",
      event: "Stop",
      assistant_last_output: "字".repeat(2200), // ~6600 UTF-8 bytes
    });
    // Bigger than the OLD 4096 cap that silently 413'd CJK completions, yet
    // within the new 16KB cap — the completion must register, not be rejected.
    assert.ok(Buffer.byteLength(body, "utf8") > 4096);
    assert.ok(Buffer.byteLength(body, "utf8") <= MAX_STATE_BODY_BYTES);

    const res = await callStatePost(body);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);
    assert.strictEqual(res.calls.updateSession.length, 1);
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await callStatePost("{not json");

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body, "bad json");
  });
});

describe("server-route-state Windows B1a process metadata", () => {
  const generation = "state-route-generation";
  const headers = {
    [CLAWD_HOOK_PID_HEADER.toLowerCase()]: "4321",
    [CLAWD_PROCESS_INSTANCE_HEADER.toLowerCase()]: generation,
  };

  function runtime(agentId, mode) {
    return {
      version: 1,
      instanceGeneration: generation,
      agents: { [agentId]: mode },
    };
  }

  it("authoritative mode replaces sender process fields with a fresh per-request result", async () => {
    let calls = 0;
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "b1a-state",
      event: "PreToolUse",
      agent_id: "kiro-cli",
      source_pid: 11,
      agent_pid: 12,
      pid_chain: [11, 12],
      editor: "code",
    }), {
      headers,
      options: {
        isWinHost: true,
        windowsProcessChainRuntime: runtime("kiro-cli", "b1a-authoritative"),
        resolveWindowsProcessMetadata: ({ agentId, hookPid }) => {
          calls++;
          assert.strictEqual(agentId, "kiro-cli");
          assert.strictEqual(hookPid, 4321);
          return {
            status: "ok",
            sourcePid: 101,
            agentPid: 202,
            pidChain: [101, 202, 303],
            editor: null,
          };
        },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(res.calls.updateSession[0][3].sourcePid, 101);
    assert.deepStrictEqual(res.calls.updateSession[0][3].agentPid, 202);
    assert.deepStrictEqual(res.calls.updateSession[0][3].pidChain, [101, 202, 303]);
    assert.strictEqual(res.calls.updateSession[0][3].editor, null);
    assert.strictEqual(res.calls.updateSession[0][3].replaceProcessMetadata, true);
  });

  it("authoritative failure clears derived fields while preserving Cursor's constant editor", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "b1a-cursor",
      event: "PreToolUse",
      agent_id: "cursor-agent",
      source_pid: 11,
      cursor_pid: 12,
      pid_chain: [11, 12],
    }), {
      headers,
      options: {
        isWinHost: true,
        windowsProcessChainRuntime: runtime("cursor-agent", "b1a-authoritative"),
        resolveWindowsProcessMetadata: () => ({ status: "unavailable", reason: "access-denied" }),
      },
    });

    const opts = res.calls.updateSession[0][3];
    assert.strictEqual(opts.sourcePid, null);
    assert.strictEqual(opts.agentPid, null);
    assert.strictEqual(opts.pidChain, null);
    assert.strictEqual(opts.editor, "cursor");
    assert.strictEqual(opts.replaceProcessMetadata, true);
  });

  it("shadow mode records parity but keeps legacy metadata authoritative", async () => {
    const records = [];
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "b1a-shadow",
      event: "PreToolUse",
      agent_id: "reasonix",
      source_pid: 11,
      agent_pid: 12,
      pid_chain: [11, 12],
    }), {
      headers,
      options: {
        isWinHost: true,
        windowsProcessChainRuntime: runtime("reasonix", "shadow"),
        resolveWindowsProcessMetadata: () => ({
          status: "ok",
          sourcePid: 21,
          agentPid: 22,
          pidChain: [21, 22],
          editor: null,
          depth: 2,
          durationMs: 3,
        }),
        recordWindowsProcessChainShadow: (record) => records.push(record),
      },
    });

    const opts = res.calls.updateSession[0][3];
    assert.strictEqual(opts.sourcePid, 11);
    assert.strictEqual(opts.agentPid, 12);
    assert.deepStrictEqual(opts.pidChain, [11, 12]);
    assert.strictEqual(opts.replaceProcessMetadata, undefined);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].comparison.all, false);
    assert.deepStrictEqual(records[0].legacyMetadata, {
      sourcePid: 11, agentPid: 12, pidChain: [11, 12], editor: null,
    });
    assert.deepStrictEqual(records[0].candidateMetadata, {
      sourcePid: 21, agentPid: 22, pidChain: [21, 22], editor: null,
    });
  });

  it("missing generation leaves old-hook traffic on the legacy path", async () => {
    let resolverCalls = 0;
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "b1a-old-hook",
      event: "PreToolUse",
      agent_id: "codebuddy",
      source_pid: 88,
    }), {
      headers: { [CLAWD_HOOK_PID_HEADER.toLowerCase()]: "4321" },
      options: {
        isWinHost: true,
        windowsProcessChainRuntime: runtime("codebuddy", "b1a-authoritative"),
        resolveWindowsProcessMetadata: () => { resolverCalls++; return { status: "ok" }; },
      },
    });

    assert.strictEqual(resolverCalls, 0);
    assert.strictEqual(res.calls.updateSession[0][3].sourcePid, 88);
    assert.strictEqual(res.calls.updateSession[0][3].replaceProcessMetadata, undefined);
  });

  it("resolves every interleaved Kiro default event from its own hook PID", async () => {
    const resolverCalls = [];
    const resolver = ({ agentId, hookPid }) => {
      resolverCalls.push({ agentId, hookPid });
      return {
        status: "ok",
        sourcePid: hookPid + 100,
        agentPid: hookPid + 200,
        pidChain: [hookPid + 200, hookPid + 100],
        editor: null,
      };
    };
    const cases = [
      { hookPid: 7001, cwd: "D:\\repo-a" },
      { hookPid: 7002, cwd: "D:\\repo-b" },
      { hookPid: 7003, cwd: "D:\\repo-a" },
    ];
    for (const entry of cases) {
      const res = await callStatePost(JSON.stringify({
        state: "working",
        session_id: "default",
        event: "PreToolUse",
        agent_id: "kiro-cli",
        cwd: entry.cwd,
      }), {
        headers: {
          ...headers,
          [CLAWD_HOOK_PID_HEADER.toLowerCase()]: String(entry.hookPid),
        },
        options: {
          isWinHost: true,
          windowsProcessChainRuntime: runtime("kiro-cli", "b1a-authoritative"),
          resolveWindowsProcessMetadata: resolver,
        },
      });
      assert.strictEqual(res.calls.updateSession[0][3].sourcePid, entry.hookPid + 100);
    }
    assert.deepStrictEqual(resolverCalls, cases.map((entry) => ({
      agentId: "kiro-cli",
      hookPid: entry.hookPid,
    })));
  });

  it("authoritative Codex SessionStart samples HWND server-side and ignores sender HWND", async () => {
    let probeCalls = 0;
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      session_id: "b1a-codex-start",
      event: "SessionStart",
      agent_id: "codex",
      wt_hwnd: "111",
    }), {
      headers,
      options: {
        isWinHost: true,
        windowsProcessChainRuntime: runtime("codex", "b1a-authoritative"),
        resolveWindowsProcessMetadata: () => ({
          status: "ok",
          sourcePid: 500,
          agentPid: 500,
          pidChain: [500, 600],
          editor: null,
        }),
        captureForegroundWindowsTerminal: () => { probeCalls++; return "222"; },
      },
    });

    assert.strictEqual(probeCalls, 1);
    assert.strictEqual(res.calls.updateSession[0][3].wtHwnd, "222");
    assert.strictEqual(res.calls.updateSession[0][3].replaceProcessMetadata, true);
  });

  it("CodexUserInputRequest remains outside B1a even when process headers are present", async () => {
    let resolverCalls = 0;
    const res = await callStatePost(JSON.stringify({
      state: "notification",
      session_id: "b1a-user-input",
      event: "Notification",
      agent_id: "codex",
      codex_user_input: {
        phase: "request",
        call_id: "call-1",
        questions: [{
          id: "q1",
          header: "Pick",
          question: "Choose",
          options: [{ label: "A" }, { label: "B" }],
        }],
      },
    }), {
      headers,
      options: {
        isWinHost: true,
        windowsProcessChainRuntime: runtime("codex", "b1a-authoritative"),
        resolveWindowsProcessMetadata: () => { resolverCalls++; return { status: "ok" }; },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(resolverCalls, 0);
    assert.strictEqual(res.calls.updateSession[0][3].replaceProcessMetadata, undefined);
  });
});

// #627 residual: server-side wt_hwnd sampling on UserPromptSubmit. The probe
// is always injected here so these tests never load the real koffi FFI.
describe("server-route-state wt_hwnd sampling (#627 residual)", () => {
  function samplingBody(overrides = {}) {
    return JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "UserPromptSubmit",
      source_pid: 111,
      ...overrides,
    });
  }

  it("incoming hook wt_hwnd wins and the probe is never called", async () => {
    let probeCalls = 0;
    const res = await callStatePost(samplingBody({ wt_hwnd: "222333" }), {
      options: {
        isWinHost: true,
        captureForegroundWindowsTerminal: () => { probeCalls++; return "999999"; },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.updateSession[0][3].wtHwnd, "222333");
    assert.strictEqual(probeCalls, 0, "an incoming wt_hwnd must short-circuit sampling");
  });

  it("samples the foreground WT window when incoming wt_hwnd is missing and all preconditions hold", async () => {
    let probeCalls = 0;
    const res = await callStatePost(samplingBody(), {
      options: {
        isWinHost: true,
        captureForegroundWindowsTerminal: () => { probeCalls++; return "654321"; },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(probeCalls, 1);
    assert.strictEqual(res.calls.updateSession[0][3].wtHwnd, "654321");
  });

  it("a null sample passes null through (server MERGE in state.js keeps the old value)", async () => {
    const res = await callStatePost(samplingBody(), {
      options: {
        isWinHost: true,
        captureForegroundWindowsTerminal: () => null,
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.updateSession[0][3].wtHwnd, null);
  });

  it("does not sample on a non-UserPromptSubmit event", async () => {
    let probeCalls = 0;
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "PreToolUse",
      source_pid: 111,
    }), {
      options: {
        isWinHost: true,
        captureForegroundWindowsTerminal: () => { probeCalls++; return "1"; },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(probeCalls, 0);
  });

  it("does not sample when the server host is not Windows", async () => {
    let probeCalls = 0;
    const res = await callStatePost(samplingBody(), {
      options: {
        isWinHost: false,
        captureForegroundWindowsTerminal: () => { probeCalls++; return "1"; },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(probeCalls, 0);
  });

  it("effective metadata: an existing session's headless flag blocks sampling even though this body omits it", async () => {
    let probeCalls = 0;
    const sessions = new Map([[localSessionKey("sid"), { headless: true, sourcePid: 111 }]]);
    const res = await callStatePost(samplingBody(), {
      ctx: { sessions },
      options: {
        isWinHost: true,
        captureForegroundWindowsTerminal: () => { probeCalls++; return "1"; },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(probeCalls, 0, "an existing headless session must not be sampled just because this body is missing the flag");
  });

  it("effective metadata: an existing session's host (remote) blocks sampling", async () => {
    let probeCalls = 0;
    const sessions = new Map([[localSessionKey("sid"), { host: "remote-host", sourcePid: 111 }]]);
    const res = await callStatePost(samplingBody(), {
      ctx: { sessions },
      options: {
        isWinHost: true,
        captureForegroundWindowsTerminal: () => { probeCalls++; return "1"; },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(probeCalls, 0);
  });

  it("effective metadata: an existing session's wslDistro blocks sampling", async () => {
    let probeCalls = 0;
    const sessions = new Map([[localSessionKey("sid"), { wslDistro: "Ubuntu", sourcePid: 111 }]]);
    const res = await callStatePost(samplingBody(), {
      ctx: { sessions },
      options: {
        isWinHost: true,
        captureForegroundWindowsTerminal: () => { probeCalls++; return "1"; },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(probeCalls, 0);
  });

  it("effective metadata: an existing session's webui platform blocks sampling", async () => {
    let probeCalls = 0;
    const sessions = new Map([[localSessionKey("sid"), { platform: "webui", sourcePid: 111 }]]);
    const res = await callStatePost(samplingBody(), {
      ctx: { sessions },
      options: {
        isWinHost: true,
        captureForegroundWindowsTerminal: () => { probeCalls++; return "1"; },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(probeCalls, 0);
  });

  it("effectiveSourcePid gate: no incoming source_pid and no existing session skips sampling", async () => {
    let probeCalls = 0;
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "brand-new-sid",
      event: "UserPromptSubmit",
    }), {
      options: {
        isWinHost: true,
        captureForegroundWindowsTerminal: () => { probeCalls++; return "1"; },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(probeCalls, 0, "a completely unknown session must not be sampled");
  });

  it("effectiveSourcePid gate: a cache miss (no incoming source_pid) still samples when the existing session already has one", async () => {
    let probeCalls = 0;
    const sessions = new Map([[localSessionKey("sid"), { sourcePid: 4242 }]]);
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "UserPromptSubmit",
      // no source_pid in this body — simulates a prompt cache-miss
    }), {
      ctx: { sessions },
      options: {
        isWinHost: true,
        captureForegroundWindowsTerminal: () => { probeCalls++; return "777"; },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(probeCalls, 1, "a known session should still be sampled on a prompt cache-miss");
    assert.strictEqual(res.calls.updateSession[0][3].wtHwnd, "777");
  });

  it("provenance: hook | server | previous | none are each distinguishable via debugLog", async () => {
    const logs = [];
    const debugLog = (msg) => logs.push(msg);

    // hook: incoming wt_hwnd present.
    await callStatePost(samplingBody({ wt_hwnd: "111" }), {
      ctx: { debugLog },
      options: { isWinHost: true, captureForegroundWindowsTerminal: () => "999" },
    });
    // server: no incoming, probe returns a value.
    await callStatePost(samplingBody(), {
      ctx: { debugLog },
      options: { isWinHost: true, captureForegroundWindowsTerminal: () => "222" },
    });
    // previous: no incoming, probe null, but the existing session already has a wt_hwnd.
    await callStatePost(samplingBody(), {
      ctx: { debugLog, sessions: new Map([[localSessionKey("sid"), { wtHwnd: "333", sourcePid: 111 }]]) },
      options: { isWinHost: true, captureForegroundWindowsTerminal: () => null },
    });
    // none: no incoming, probe null, no existing session at all.
    await callStatePost(JSON.stringify({
      state: "working",
      session_id: "totally-new-sid",
      event: "UserPromptSubmit",
    }), {
      ctx: { debugLog },
      options: { isWinHost: true, captureForegroundWindowsTerminal: () => null },
    });

    assert.strictEqual(logs.length, 4);
    assert.match(logs[0], /source=hook/);
    assert.match(logs[1], /source=server/);
    assert.match(logs[2], /source=previous/);
    assert.match(logs[3], /source=none/);
  });

  it("codex subagent prompt (classified headless server-side) is never sampled, even without incoming wt_hwnd", async () => {
    // P3 (codex review): the sampling block sits AFTER
    // resolveCodexOfficialHookState so its subagent→headless verdict joins the
    // effective metadata. A first-seen subagent prompt has no existing session
    // and no incoming headless flag — the classifier verdict is the only thing
    // standing between it and sampling the user's foreground WT window.
    let probeCalls = 0;
    const res = await callStatePost(samplingBody({
      agent_id: "codex",
      hook_source: "codex-official",
    }), {
      ctx: { codexSubagentClassifier: { registerSession: () => "subagent" } },
      options: {
        isWinHost: true,
        captureForegroundWindowsTerminal: () => { probeCalls++; return "555"; },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(probeCalls, 0, "a codex subagent prompt must never sample the local foreground WT");
  });

  it("codex main-session prompt still samples normally after the reorder", async () => {
    let probeCalls = 0;
    const res = await callStatePost(samplingBody({
      agent_id: "codex",
      hook_source: "codex-official",
    }), {
      ctx: { codexSubagentClassifier: { registerSession: () => "primary" } },
      options: {
        isWinHost: true,
        captureForegroundWindowsTerminal: () => { probeCalls++; return "555"; },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(probeCalls, 1, "a non-subagent codex prompt keeps normal sampling eligibility");
    assert.strictEqual(res.calls.updateSession[0][3].wtHwnd, "555");
  });

  it("provenance log fires only on UserPromptSubmit — high-frequency events stay silent", async () => {
    const logs = [];
    const debugLog = (msg) => logs.push(msg);
    await callStatePost(samplingBody({ event: "PreToolUse" }), {
      ctx: { debugLog, sessions: new Map([[localSessionKey("sid"), { wtHwnd: "333", sourcePid: 111 }]]) },
      options: { isWinHost: true, captureForegroundWindowsTerminal: () => "999" },
    });
    assert.strictEqual(
      logs.filter((l) => l.includes("wt-hwnd")).length,
      0,
      "PreToolUse must not append a wt-hwnd provenance line to session-debug.log"
    );
  });
});

describe("server-route-state ExitPlanMode stale sweep", () => {
  it("clears stale ExitPlanMode on UserPromptSubmit for same session", async () => {
    const stalePerm = makePlanPermission("sid");
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "UserPromptSubmit",
    }), {
      ctx: { pendingPermissions: [stalePerm] },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.resolved.length, 1);
    assert.strictEqual(res.calls.resolved[0].perm, stalePerm);
    assert.strictEqual(res.calls.resolved[0].behavior, "deny");
    assert.strictEqual(res.calls.resolved[0].message, "Plan dialog dismissed in terminal");
  });

  it("does NOT clear ExitPlanMode for a different session", async () => {
    const stalePerm = makePlanPermission("other-sid");
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "UserPromptSubmit",
    }), {
      ctx: { pendingPermissions: [stalePerm] },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.resolved.length, 0);
  });

  it("does NOT trigger sweep on PreToolUse(ExitPlanMode)", async () => {
    const stalePerm = makePlanPermission("sid");
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "PreToolUse",
      tool_name: "ExitPlanMode",
    }), {
      ctx: { pendingPermissions: [stalePerm] },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.resolved.length, 0);
  });

  it("triggers sweep on PreToolUse with a different tool", async () => {
    const stalePerm = makePlanPermission("sid");
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "PreToolUse",
      tool_name: "Bash",
    }), {
      ctx: { pendingPermissions: [stalePerm] },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.resolved.length, 1);
    assert.strictEqual(res.calls.resolved[0].perm, stalePerm);
  });

  it("does NOT clear non-ExitPlanMode pending permissions", async () => {
    const otherPerm = {
      res: {},
      sessionId: localSessionKey("sid"),
      toolName: "Bash",
      agentId: "claude-code",
      subagentId: null,
      interaction: classifyPermissionInteraction({ agentId: "claude-code", toolName: "Bash" }),
    };
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "UserPromptSubmit",
    }), {
      ctx: { pendingPermissions: [otherPerm] },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.resolved.length, 0);
  });

  it("skips entries with no res (already cleaned up)", async () => {
    const stalePerm = { ...makePlanPermission("sid"), res: null };
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "Stop",
    }), {
      ctx: { pendingPermissions: [stalePerm] },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.resolved.length, 0);
  });

  it("clears stale ExitPlanMode on PostToolUse(ExitPlanMode) as fallback", async () => {
    const stalePerm = makePlanPermission("sid");
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "PostToolUse",
      tool_name: "ExitPlanMode",
    }), {
      ctx: { pendingPermissions: [stalePerm] },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.resolved.length, 1);
    assert.strictEqual(res.calls.resolved[0].perm, stalePerm);
    assert.strictEqual(res.calls.resolved[0].message, "User answered in terminal");
  });

  it("does not sweep a sibling decision after an exact decision match", async () => {
    const exact = makePlanPermission("sid");
    exact.toolUseId = "tool-exact";
    const sibling = {
      ...makePlanPermission("sid"),
      toolName: "AskUserQuestion",
      interaction: classifyPermissionInteraction({
        agentId: "claude-code",
        toolName: "AskUserQuestion",
      }),
    };
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "PostToolUse",
      tool_name: "ExitPlanMode",
      tool_use_id: "tool-exact",
    }), {
      ctx: { pendingPermissions: [exact, sibling] },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(
      res.calls.resolved.map(({ perm }) => perm),
      [exact]
    );
  });

  it("logs and preserves ambiguous decision sweeps instead of guessing", async () => {
    const first = makePlanPermission("sid");
    const second = makePlanPermission("sid");
    const res = await callStatePost(JSON.stringify({
      state: "working",
      session_id: "sid",
      event: "UserPromptSubmit",
      agent_id: "claude-code",
    }), {
      ctx: { pendingPermissions: [first, second] },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.calls.resolved, []);
    assert.match(res.calls.logs.join("\n"), /decision sweep ambiguous:.*candidates=2/);
  });
});
