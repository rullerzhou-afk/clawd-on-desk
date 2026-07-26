"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
} = require("../hooks/server-config");
const {
  MAX_STATE_BODY_BYTES,
  sendStateHealthResponse,
  handleStatePost,
} = require("../src/server-route-state");
const { classifyPermissionInteraction } = require("../src/permission-automation-policy");
const { buildStateBody } = require("../hooks/clawd-hook");
const { makeSessionKey } = require("../src/session-key");
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

function makeReq(body) {
  const req = new EventEmitter();
  setImmediate(() => {
    if (body != null) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
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
    };
    const ctx = {
      STATE_SVGS: {
        idle: "x.svg",
        working: "x.svg",
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
      ...overrides.ctx,
    };
    handleStatePost(makeReq(body), res, {
      ctx,
      createRequestHookRecorder: (identity, data, route) => {
        calls.recorder.push({ identity, data, route });
        return {
          acceptedUnlessDnd: (dropForDnd) => calls.recorder.push({ outcome: dropForDnd ? "dnd" : "accepted" }),
          droppedByDisabled: () => calls.recorder.push({ outcome: "disabled" }),
          droppedByDnd: () => calls.recorder.push({ outcome: "dnd" }),
          droppedInvalidAgent: () => calls.recorder.push({ outcome: "invalid-agent" }),
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
        agentPid: 99,
        agentId: "codex",
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
      ctx: { updateSessionMetadata: (...args) => metadataCalls.push(args) },
    });

    assert.strictEqual(res.statusCode, 204);
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
      ctx: { updateSessionMetadata: (...args) => metadataCalls.push(args) },
    });

    assert.strictEqual(res.statusCode, 204);
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
        updateSessionMetadata: (...args) => metadataCalls.push(args),
      },
    });

    assert.strictEqual(res.statusCode, 204);
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
