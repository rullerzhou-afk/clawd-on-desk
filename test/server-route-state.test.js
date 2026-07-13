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
      setState: [],
      recorder: [],
      resolved: [],
    };
    const ctx = {
      STATE_SVGS: {
        idle: "x.svg",
        working: "x.svg",
        attention: "x.svg",
        "mini-idle": "x.svg",
      },
      pendingPermissions: [],
      sessions: new Map(),
      isAgentEnabled: () => true,
      setState: (...args) => calls.setState.push(args),
      updateSession: (...args) => calls.updateSession.push(args),
      resolvePermissionEntry: (perm, behavior, message) => calls.resolved.push({ perm, behavior, message }),
      ...overrides.ctx,
    };
    handleStatePost(makeReq(body), res, {
      ctx,
      createRequestHookRecorder: (data, route) => {
        calls.recorder.push({ data, route });
        return {
          acceptedUnlessDnd: (dropForDnd) => calls.recorder.push({ outcome: dropForDnd ? "dnd" : "accepted" }),
          droppedByDisabled: () => calls.recorder.push({ outcome: "disabled" }),
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
      codex_originator: "Codex Desktop",
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
      "sid",
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
        codexOriginator: "Codex Desktop",
        codexSource: "vscode",
        ghosttyTerminalId: "ghostty-term-7",
        displayHint: "display.svg",
        sessionTitle: "Work title",
        contextUsage: null,
        antigravityQuota: null,
        claudeQuota: null,
        assistantLastOutput: null,
        assistantLastOutputTruncated: false,
        toolName: "Read",
        transcriptPath: "/Users/tester/.claude/projects/repo/session.jsonl",
        permissionSuspect: true,
        permissionAction: null,
        permissionCommand: null,
        preserveState: true,
        hookSource: "codex-official",
        backgroundTasksCount: 0,
        sessionCronsCount: 0,
        stopHookActive: false,
        stdinDiag: null,
      },
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
    }), { ctx: { STATE_SVGS: { notification: "x.svg" } } });

    assert.strictEqual(res.statusCode, 200);
    const opts = res.calls.updateSession[0][3];
    assert.strictEqual(opts.toolName, "Bash");
    assert.strictEqual(opts.permissionAction, "Running: echo hi");
    assert.strictEqual(opts.permissionCommand, "echo hi");
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

  it("passes valid antigravity_quota to updateSession", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      session_id: "sid",
      antigravity_quota: {
        geminiFiveHour: { usedPercent: 100 },
        geminiWeekly: { usedPercent: 98, resetAt: 1738831180000 },
      },
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.calls.updateSession[0][3].antigravityQuota, {
      geminiFiveHour: { usedPercent: 100 },
      geminiWeekly: { usedPercent: 98, resetAt: 1738831180000 },
    });
  });

  it("drops invalid antigravity_quota without rejecting state", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      session_id: "sid",
      antigravity_quota: { geminiFiveHour: { usedPercent: "not-a-number" } },
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.updateSession[0][3].antigravityQuota, null);
  });

  it("passes valid claude_quota to updateSession", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      session_id: "sid",
      claude_quota: {
        claudeFiveHour: { usedPercent: 24, resetAt: 1738425600000 },
        claudeWeekly: { usedPercent: 41 },
      },
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.calls.updateSession[0][3].claudeQuota, {
      claudeFiveHour: { usedPercent: 24, resetAt: 1738425600000 },
      claudeWeekly: { usedPercent: 41 },
    });
  });

  it("drops invalid claude_quota without rejecting state", async () => {
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      session_id: "sid",
      claude_quota: { claudeFiveHour: { usedPercent: "not-a-number" } },
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.calls.updateSession[0][3].claudeQuota, null);
  });

  // #590 B2 — metadata_only POSTs (statusline refreshes) bypass the
  // updateSession lifecycle machine entirely and go through
  // updateSessionMetadata, which can only annotate an existing session.
  it("routes metadata_only POSTs to updateSessionMetadata, never updateSession", async () => {
    const metadataCalls = [];
    const res = await callStatePost(JSON.stringify({
      state: "idle",
      preserve_state: true,
      metadata_only: true,
      session_id: "sid",
      agent_id: "claude-code",
      claude_quota: { claudeWeekly: { usedPercent: 41, resetAt: 1738831180000 } },
    }), {
      ctx: { updateSessionMetadata: (...args) => metadataCalls.push(args) },
    });

    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.calls.updateSession.length, 0);
    assert.strictEqual(res.calls.setState.length, 0);
    assert.strictEqual(metadataCalls.length, 1);
    assert.strictEqual(metadataCalls[0][0], "sid");
    assert.deepStrictEqual(metadataCalls[0][1].claudeQuota, {
      claudeWeekly: { usedPercent: 41, resetAt: 1738831180000 },
    });
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
    const sessions = new Map([["sid", { headless: true, sourcePid: 111 }]]);
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
    const sessions = new Map([["sid", { host: "remote-host", sourcePid: 111 }]]);
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
    const sessions = new Map([["sid", { wslDistro: "Ubuntu", sourcePid: 111 }]]);
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
    const sessions = new Map([["sid", { platform: "webui", sourcePid: 111 }]]);
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
    const sessions = new Map([["sid", { sourcePid: 4242 }]]);
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
      ctx: { debugLog, sessions: new Map([["sid", { wtHwnd: "333", sourcePid: 111 }]]) },
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
      ctx: { debugLog, sessions: new Map([["sid", { wtHwnd: "333", sourcePid: 111 }]]) },
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
    const stalePerm = { res: {}, sessionId: "sid", toolName: "ExitPlanMode" };
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
    const stalePerm = { res: {}, sessionId: "other-sid", toolName: "ExitPlanMode" };
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
    const stalePerm = { res: {}, sessionId: "sid", toolName: "ExitPlanMode" };
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
    const stalePerm = { res: {}, sessionId: "sid", toolName: "ExitPlanMode" };
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
    const otherPerm = { res: {}, sessionId: "sid", toolName: "Bash" };
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
    const stalePerm = { res: null, sessionId: "sid", toolName: "ExitPlanMode" };
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
    const stalePerm = { res: {}, sessionId: "sid", toolName: "ExitPlanMode" };
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
});
