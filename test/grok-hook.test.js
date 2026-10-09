"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const {
  AGENT_ID,
  HOOK_MAP,
  normalizeHookName,
  pickSessionId,
  buildSessionId,
  isValidSessionId,
  resolveStopDisposition,
  notificationIsIdlePrompt,
  buildHookDecision,
} = require("../hooks/grok-hook");

const HOOK_PATH = path.join(__dirname, "..", "hooks", "grok-hook.js");

describe("Grok hook adapter", () => {
  it("maps the Phase 1 main-session events", () => {
    assert.strictEqual(HOOK_MAP.SessionStart.state, "idle");
    assert.strictEqual(HOOK_MAP.UserPromptSubmit.state, "thinking");
    assert.strictEqual(HOOK_MAP.PreToolUse.state, "working");
    assert.strictEqual(HOOK_MAP.PostToolUse.state, "working");
    assert.strictEqual(HOOK_MAP.PostToolUseFailure.state, "error");
    assert.strictEqual(HOOK_MAP.StopFailure.state, "error");
    assert.strictEqual(HOOK_MAP.StopCancelled.state, "idle");
    assert.strictEqual(HOOK_MAP.PreCompact.state, "sweeping");
    assert.strictEqual(HOOK_MAP.PermissionDenied.event, "Notification");
    assert.strictEqual(HOOK_MAP.SubagentStart, undefined);
    assert.strictEqual(HOOK_MAP.SubagentStop, undefined);
  });

  it("recognizes only the documented event wire pairs", () => {
    assert.strictEqual(normalizeHookName({ hook_event_name: "PreToolUse" }), "PreToolUse");
    assert.strictEqual(normalizeHookName({ hookEventName: "pre_tool_use" }), "PreToolUse");
    assert.strictEqual(normalizeHookName({}, { GROK_HOOK_EVENT: "stop" }), "Stop");
    assert.strictEqual(normalizeHookName({ hookEventName: "not_an_event" }, {}), "");
    assert.strictEqual(normalizeHookName({ hook_event_name: "pre_tool_use" }, {}), "");
    assert.strictEqual(normalizeHookName({ hookEventName: "preToolUse" }, {}), "");
  });

  it("rejects speculative casing instead of treating it as an alias", () => {
    // `hookEventName` must carry the snake_case value, never PascalCase.
    assert.strictEqual(normalizeHookName({ hookEventName: "PreToolUse" }, {}), "");
    // `hook_event_name` must carry the PascalCase value, never snake_case.
    assert.strictEqual(normalizeHookName({ hook_event_name: "pre_tool_use" }, {}), "");
    assert.strictEqual(normalizeHookName({ hookEventName: "Stop" }, {}), "");
  });

  it("rejects conflicting valid identities rather than picking one", () => {
    assert.strictEqual(
      normalizeHookName({ hook_event_name: "PreToolUse", hookEventName: "post_tool_use" }, {}),
      ""
    );
    assert.strictEqual(
      normalizeHookName({ hook_event_name: "PreToolUse", hookEventName: "pre_tool_use" }, {}),
      "PreToolUse"
    );
    assert.strictEqual(
      normalizeHookName({ hook_event_name: "Stop" }, { GROK_HOOK_EVENT: "notification" }),
      ""
    );
    assert.strictEqual(
      normalizeHookName({ hook_event_name: "Stop" }, { GROK_HOOK_EVENT: "stop" }),
      "Stop"
    );
    // A present-but-invalid identity is not ignored in favor of another.
    assert.strictEqual(
      normalizeHookName({ hook_event_name: "Stop", hookEventName: "not_an_event" }, {}),
      ""
    );
  });

  it("rejects Object.prototype keys as event identities", () => {
    for (const key of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
      assert.strictEqual(normalizeHookName({ hook_event_name: key }, {}), "", key);
      assert.strictEqual(normalizeHookName({ hookEventName: key }, {}), "", key);
      assert.strictEqual(normalizeHookName({}, { GROK_HOOK_EVENT: key }), "", key);
      const decision = buildHookDecision({ hookEventName: key, sessionId: "s1", promptId: "p" }, {});
      assert.strictEqual(decision.post, false, key);
      assert.strictEqual(decision.reason, "unsupported-event", key);
    }
  });

  it("validates and namespaces the raw session id", () => {
    assert.strictEqual(pickSessionId({ sessionId: "abc" }), "abc");
    assert.strictEqual(pickSessionId({ session_id: "def" }), "def");
    assert.strictEqual(pickSessionId({}, { GROK_SESSION_ID: "ghi" }), "ghi");
    assert.strictEqual(pickSessionId({ sessionId: "bad\nid" }), "");
    assert.strictEqual(isValidSessionId("x".repeat(201)), false);
    assert.strictEqual(buildSessionId("abc"), "grok-build:abc");
  });

  it("resolves the Stop matrix locally", () => {
    assert.deepStrictEqual(resolveStopDisposition({ reason: "end_turn" }), { action: "terminal" });
    assert.strictEqual(resolveStopDisposition({ reason: "shutdown" }).action, "drop");
    assert.strictEqual(resolveStopDisposition({ reason: "channel_closed" }).action, "drop");
    assert.strictEqual(resolveStopDisposition({}).action, "drop");
    assert.strictEqual(resolveStopDisposition({ reason: "weird" }).action, "drop");
    assert.strictEqual(
      resolveStopDisposition({ reason: "end_turn", stopHookActive: true }).action,
      "continuation"
    );
    assert.strictEqual(
      resolveStopDisposition({ reason: "end_turn", backgroundTasks: [{}] }).action,
      "continuation"
    );
    assert.strictEqual(
      resolveStopDisposition({ reason: "end_turn", sessionCrons: [{}] }).action,
      "continuation"
    );
  });

  it("only treats idle_prompt as a fence settle notification", () => {
    assert.strictEqual(notificationIsIdlePrompt({ notificationType: "idle_prompt" }), true);
    assert.strictEqual(notificationIsIdlePrompt({ notification_type: "idle_prompt" }), true);
    assert.strictEqual(notificationIsIdlePrompt({ notificationType: "permission_prompt" }), false);
  });

  it("posts the exact grok-build namespace and mapped state", () => {
    const decision = buildHookDecision({
      hookEventName: "user_prompt_submit",
      sessionId: "s1",
      promptId: "turn-1",
      cwd: "/tmp/project",
    }, {});
    assert.strictEqual(decision.post, true);
    assert.deepStrictEqual(decision.body, {
      agent_id: "grok-build",
      session_id: "grok-build:s1",
      state: "thinking",
      event: "UserPromptSubmit",
      cwd: "/tmp/project",
      prompt_id: "turn-1",
    });
  });

  it("emits event=null and working for a continuation Stop", () => {
    const decision = buildHookDecision({
      hookEventName: "stop",
      sessionId: "s1",
      promptId: "turn-1",
      reason: "end_turn",
      stopHookActive: true,
    }, {});
    assert.strictEqual(decision.post, true);
    assert.deepStrictEqual(decision.body, {
      agent_id: "grok-build",
      session_id: "grok-build:s1",
      state: "working",
      event: null,
      prompt_id: "turn-1",
    });
  });

  it("fails closed on a missing or invalid prompt id for turn start/terminal events", () => {
    const turnScoped = [
      { hookEventName: "user_prompt_submit" },
      { hookEventName: "stop", reason: "end_turn" },
      { hookEventName: "stop_failure" },
      { hookEventName: "stop_cancelled" },
    ];
    for (const payload of turnScoped) {
      for (const extra of [{}, { promptId: "" }, { promptId: "x".repeat(200) }, { promptId: "bad\nid" }]) {
        const decision = buildHookDecision({ ...payload, sessionId: "s1", ...extra }, {});
        assert.strictEqual(decision.post, false, `${payload.hookEventName} ${JSON.stringify(extra)}`);
      }
    }
    // A session-end-shaped Stop (the extra prompt-less Stop Grok emits after
    // SessionEnd) must also stay dropped.
    for (const reason of ["shutdown", "channel_closed"]) {
      const decision = buildHookDecision({ hookEventName: "stop", sessionId: "s1", reason }, {});
      assert.strictEqual(decision.post, false, reason);
    }
  });

  it("reports prompt-less tool events from Grok 1.0.30 with session and tool state", () => {
    const sessionId = "01a09fae-c530-7602-a3b6-89232cd0feae";
    const cases = [
      { hookEventName: "pre_tool_use", state: "working", event: "PreToolUse" },
      { hookEventName: "post_tool_use", state: "working", event: "PostToolUse" },
      { hookEventName: "post_tool_use_failure", state: "error", event: "PostToolUseFailure" },
    ];
    for (const { hookEventName, state, event } of cases) {
      const decision = buildHookDecision({
        hookEventName,
        sessionId,
        toolName: "run_terminal_command",
        promptId: "",
      }, {});
      assert.strictEqual(decision.post, true, hookEventName);
      assert.deepStrictEqual(decision.body, {
        agent_id: "grok-build",
        session_id: `grok-build:${sessionId}`,
        state,
        event,
        tool_name: "run_terminal_command",
      });
    }
  });

  it("accepts session-scoped presentation events without a prompt id", () => {
    for (const event of [
      { hookEventName: "session_start" },
      { hookEventName: "notification", notificationType: "permission_prompt" },
      { hook_event_name: "PreCompact" },
      { hook_event_name: "PostCompact", source: "auto" },
      { hook_event_name: "PermissionDenied" },
    ]) {
      const decision = buildHookDecision({ ...event, sessionId: "s1" }, {});
      assert.strictEqual(decision.post, true, JSON.stringify(event));
      assert.strictEqual(decision.body.prompt_id, undefined);
    }
  });

  it("emits attention/Stop only for a genuine end_turn", () => {
    const decision = buildHookDecision({
      hook_event_name: "Stop",
      sessionId: "s1",
      promptId: "turn-1",
      reason: "end_turn",
    }, {});
    assert.strictEqual(decision.post, true);
    assert.strictEqual(decision.body.state, "attention");
    assert.strictEqual(decision.body.event, "Stop");
  });

  it("drops session-end-shaped Stops before any POST", () => {
    for (const reason of ["channel_closed", "shutdown", "abort", "session_end"]) {
      const decision = buildHookDecision({ hook_event_name: "Stop", sessionId: "s1", reason }, {});
      assert.strictEqual(decision.post, false, reason);
    }
    const missing = buildHookDecision({ hook_event_name: "Stop", sessionId: "s1" }, {});
    assert.strictEqual(missing.post, false);
  });

  it("maps manual and auto PostCompact without a completion event", () => {
    const manual = buildHookDecision({ hook_event_name: "PostCompact", sessionId: "s1", source: "manual" }, {});
    assert.strictEqual(manual.body.state, "idle");
    const auto = buildHookDecision({ hook_event_name: "PostCompact", sessionId: "s1", source: "auto" }, {});
    assert.strictEqual(auto.body.state, "thinking");
  });

  it("marks only idle_prompt notifications for the fence settle", () => {
    const idle = buildHookDecision({
      hook_event_name: "Notification",
      sessionId: "s1",
      notificationType: "idle_prompt",
    }, {});
    assert.strictEqual(idle.body.notification_type, "idle_prompt");
    const other = buildHookDecision({
      hook_event_name: "Notification",
      sessionId: "s1",
      notificationType: "permission_prompt",
    }, {});
    assert.strictEqual(other.body.notification_type, undefined);
  });

  it("drops subagent events before any POST", () => {
    const decision = buildHookDecision({
      hook_event_name: "PreToolUse",
      sessionId: "s1",
      subagentType: "explore",
    }, {});
    assert.strictEqual(decision.post, false);
    assert.strictEqual(decision.reason, "subagent");
  });

  it("drops missing session, malformed payloads, and unsupported events", () => {
    assert.strictEqual(buildHookDecision({ hook_event_name: "Stop" }, {}).post, false);
    assert.strictEqual(buildHookDecision([], {}).post, false);
    assert.strictEqual(buildHookDecision({ hook_event_name: "WorktreeCreate", sessionId: "s1" }, {}).post, false);
  });

  it("forwards no content-bearing fields", () => {
    const decision = buildHookDecision({
      hook_event_name: "PreToolUse",
      sessionId: "s1",
      cwd: "/tmp/project",
      prompt: "SECRET PROMPT",
      toolInput: { secret: "INPUT" },
      toolInputSecret: "NOPE",
      toolResult: "RESULT",
      errorDetails: "ERROR DETAIL",
      session_title: "SECRET TITLE",
      transcript_path: "/tmp/secret.jsonl",
      backgroundTasks: [{ description: "SECRET TASK" }],
      sessionCrons: [{ prompt: "SECRET CRON" }],
      notificationMessage: "SECRET MESSAGE",
      stopHookActive: false,
      reason: "end_turn",
      toolName: "Bash",
      promptId: "turn-1",
    }, {});
    assert.strictEqual(decision.post, true);
    const serialized = JSON.stringify(decision.body);
    for (const forbidden of [
      "SECRET PROMPT", "INPUT", "NOPE", "RESULT", "ERROR DETAIL", "SECRET TITLE",
      "secret.jsonl", "SECRET TASK", "SECRET CRON", "SECRET MESSAGE",
    ]) {
      assert.ok(!serialized.includes(forbidden), `body leaked ${forbidden}`);
    }
    assert.deepStrictEqual(Object.keys(decision.body).sort(), [
      "agent_id", "cwd", "event", "prompt_id", "session_id", "state", "tool_name",
    ]);
  });

  it("contains no literal hook-server port and resolves through server-config", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf8");
    assert.ok(!/\b2333[3-7]\b/.test(source), "adapter must not hardcode a hook-server port");
    assert.ok(source.includes("postStateToRunningServer"), "adapter must use the shared runtime helper");
    assert.ok(!/require\("http"\)/.test(source), "adapter must not hand-roll HTTP");
    assert.ok(
      source.includes('const { postStateToRunningServer } = require("./server-config");'),
      "adapter must import only the state helper from server-config"
    );
    assert.ok(!/postPermission|buildPermissionUrl|permissionUrl/.test(source), "adapter must not post a permission request");
  });

  it("always writes passive {} stdout and exits 0 for dropped inputs", () => {
    // Deliberately only dropped/unsupported inputs: a postable event would hit
    // the shared port fallback and could reach a real running Clawd.
    const home = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "clawd-grok-hook-"));
    try {
      const cases = [
        JSON.stringify({ hookEventName: "worktree_create", sessionId: "s1" }),
        JSON.stringify({ hookEventName: "pre_tool_use", sessionId: "s1", subagentType: "x" }),
        JSON.stringify({ hookEventName: "pre_tool_use" }),
        JSON.stringify({ hookEventName: "constructor", sessionId: "s1" }),
        JSON.stringify({ hookEventName: "toString", sessionId: "s1" }),
        JSON.stringify({ hook_event_name: "__proto__", sessionId: "s1" }),
        JSON.stringify({ hookEventName: "hasOwnProperty", sessionId: "s1", promptId: "p" }),
        "not json",
        "",
      ];
      for (const input of cases) {
        const result = spawnSync(process.execPath, [HOOK_PATH], {
          input,
          encoding: "utf8",
          timeout: 5000,
          env: { ...process.env, HOME: home, USERPROFILE: home, CLAWD_REMOTE: "" },
        });
        assert.strictEqual(result.status, 0, `exit for ${input}`);
        assert.strictEqual(result.stdout, "{}\n", `stdout for ${input}`);
        assert.ok(!/permission/i.test(result.stdout));
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
