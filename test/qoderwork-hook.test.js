const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  HOOK_MAP,
  buildStateBody,
  sendHookEvent,
  normalizeSessionId,
  isQoderWorkAgentCommandLine,
  resolveHookName,
  shouldResolvePid,
} = require("../hooks/qoderwork-hook");

describe("QoderWork hook runtime (Phase 1 state-only)", () => {
  it("maps Stop to attention so the completion animation/sound plays", () => {
    assert.strictEqual(HOOK_MAP.Stop.state, "attention");
  });

  it("maps tool-boundary events to working / error", () => {
    assert.strictEqual(HOOK_MAP.PreToolUse.state, "working");
    assert.strictEqual(HOOK_MAP.PostToolUse.state, "working");
    assert.strictEqual(HOOK_MAP.PostToolUseFailure.state, "error");
  });

  it("maps permission events to working (not notification) to avoid animation spam", () => {
    // QoderWork fires 40+ permission events per task (file reads, commands, etc.).
    // Map to "working" so the pet stays in its working animation.
    assert.strictEqual(HOOK_MAP.PermissionRequest.state, "working");
    assert.strictEqual(HOOK_MAP.PermissionDenied.state, "working");
    // Ride the PreToolUse event so state.js treats them as tool activity.
    assert.strictEqual(HOOK_MAP.PermissionRequest.event, "PreToolUse");
    assert.strictEqual(HOOK_MAP.PermissionDenied.event, "PreToolUse");
  });

  it("maps Notification to notification state", () => {
    assert.strictEqual(HOOK_MAP.Notification.state, "notification");
    assert.strictEqual(HOOK_MAP.Notification.event, "Notification");
  });

  it("maps lifecycle events to idle / thinking / sleeping", () => {
    assert.strictEqual(HOOK_MAP.SessionStart.state, "idle");
    assert.strictEqual(HOOK_MAP.UserPromptSubmit.state, "thinking");
    assert.strictEqual(HOOK_MAP.SessionEnd.state, "sleeping");
  });

  it("namespaces session ids as qoderwork:<raw>, not local|agent|<raw>", () => {
    assert.strictEqual(normalizeSessionId("abc"), "qoderwork:abc");
    assert.strictEqual(normalizeSessionId(""), "qoderwork:default");
    assert.strictEqual(normalizeSessionId(null), "qoderwork:default");
    assert.strictEqual(normalizeSessionId("qoderwork:abc"), "qoderwork:abc");
  });

  it("builds a state body with agent_id=qoderwork, namespaced session, and safe metadata", () => {
    const body = buildStateBody("PreToolUse", {
      session_id: "s1",
      cwd: "/work",
      tool_name: "Edit",
      tool_use_id: "tu1",
      model: "qoderwork-model",
      permission_mode: "default",
      transcript_path: "/t.jsonl",
      tool_input: { file: "a.js" },
    }, { pidMeta: { stablePid: 123 } });

    assert.strictEqual(body.agent_id, "qoderwork");
    assert.strictEqual(body.state, "working");
    assert.strictEqual(body.event, "PreToolUse");
    assert.strictEqual(body.session_id, "qoderwork:s1");
    assert.strictEqual(body.cwd, "/work");
    assert.strictEqual(body.tool_name, "Edit");
    assert.strictEqual(body.tool_use_id, "tu1");
    assert.strictEqual(body.model, "qoderwork-model");
    assert.strictEqual(body.permission_mode, "default");
    assert.strictEqual(body.transcript_path, "/t.jsonl");
    assert.ok(typeof body.tool_input_fingerprint === "string" && body.tool_input_fingerprint.length > 0);
    assert.strictEqual(body.source_pid, 123);
  });

  it("returns null for events outside the Phase 1 map", () => {
    assert.strictEqual(buildStateBody("SubagentStart", {}, {}), null);
    assert.strictEqual(buildStateBody("", {}, {}), null);
  });

  it("uses host instead of local pid fields in remote mode", () => {
    const body = buildStateBody("Stop", { session_id: "s1" }, { remote: true, host: "myhost" });
    assert.strictEqual(body.host, "myhost");
    assert.strictEqual(body.source_pid, undefined);
  });

  it("resolves session title from explicit session_title field", () => {
    const body = buildStateBody("PreToolUse", {
      session_id: "s1",
      session_title: "My Task",
    }, {});
    assert.strictEqual(body.session_title, "My Task");
  });

  it("resolves session title from prompt first line on UserPromptSubmit", () => {
    const body = buildStateBody("UserPromptSubmit", {
      session_id: "s1",
      prompt: "Fix the login bug\nMore details here",
    }, {});
    assert.strictEqual(body.session_title, "Fix the login bug");
  });

  it("truncates long prompt titles to 60 chars with ellipsis", () => {
    const longPrompt = "A".repeat(80);
    const body = buildStateBody("UserPromptSubmit", {
      session_id: "s1",
      prompt: longPrompt,
    }, {});
    assert.strictEqual(body.session_title.length, 60);
    assert.ok(body.session_title.endsWith("…"));
  });

  it("resolves session title from parent_business_info.name on Stop events", () => {
    const body = buildStateBody("Stop", {
      session_id: "s1",
      parent_business_info: { name: "Refactor auth module" },
    }, {});
    assert.strictEqual(body.session_title, "Refactor auth module");
  });

  it("does not set session_title from cwd", () => {
    const body = buildStateBody("PreToolUse", {
      session_id: "s1",
      cwd: "/work/project",
    }, {});
    assert.strictEqual(body.session_title, undefined);
  });

  it("sendHookEvent always writes {} and posts the mapped Stop body", async () => {
    const posted = [];
    const result = await sendHookEvent(
      { hook_event_name: "Stop", session_id: "s1" },
      undefined,
      {
        env: {},
        resolvePid: () => ({ stablePid: 7 }),
        postState: (bodyStr, _opts, cb) => { posted.push(JSON.parse(bodyStr)); cb(true, 23333); },
      }
    );
    assert.strictEqual(result.stdout, "{}");
    assert.strictEqual(result.posted, true);
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].state, "attention");
    assert.strictEqual(posted[0].agent_id, "qoderwork");
    assert.strictEqual(posted[0].session_id, "qoderwork:s1");
  });

  it("sendHookEvent returns {} and does not post for unmapped events", async () => {
    let postedCount = 0;
    const result = await sendHookEvent(
      { hook_event_name: "InstructionsLoaded" },
      undefined,
      { env: {}, postState: () => { postedCount++; } }
    );
    assert.strictEqual(result.stdout, "{}");
    assert.strictEqual(result.posted, false);
    assert.strictEqual(postedCount, 0);
  });

  it("permission events map to working state with {} stdout (state-only)", async () => {
    const posted = [];
    for (const ev of ["PermissionRequest", "PermissionDenied"]) {
      const result = await sendHookEvent(
        { hook_event_name: ev, session_id: "s1", tool_name: "Bash" },
        undefined,
        { env: {}, resolvePid: () => ({}), postState: (b, _o, cb) => { posted.push(JSON.parse(b)); cb(true); } }
      );
      assert.strictEqual(result.stdout, "{}");
    }
    // Permission events map to "working" (not "notification") to avoid animation spam.
    assert.deepStrictEqual(posted.map((b) => b.state), ["working", "working"]);
    assert.deepStrictEqual(posted.map((b) => b.event), ["PreToolUse", "PreToolUse"]);
  });

  it("narrows command-line detection to the QoderWork executable token", () => {
    assert.strictEqual(isQoderWorkAgentCommandLine("/usr/local/bin/QoderWork"), true);
    assert.strictEqual(isQoderWorkAgentCommandLine("QoderWork.exe"), true);
    assert.strictEqual(isQoderWorkAgentCommandLine("C:\\tools\\QoderWork.exe"), true);
    assert.strictEqual(isQoderWorkAgentCommandLine("node /x/QoderWork/dist/app.js"), true);
    // Must NOT match qodercli (shared with Qoder IDE).
    assert.strictEqual(isQoderWorkAgentCommandLine("qodercli"), false);
    assert.strictEqual(isQoderWorkAgentCommandLine("/usr/local/bin/qodercli"), false);
    // Must NOT match other executables.
    assert.strictEqual(isQoderWorkAgentCommandLine("node /home/me/qoderwork-notes/index.js"), false);
    assert.strictEqual(isQoderWorkAgentCommandLine(""), false);
  });

  it("resolveHookName prefers payload hook_event_name over argv", () => {
    assert.strictEqual(resolveHookName({ hook_event_name: "Stop" }, "PreToolUse"), "Stop");
    assert.strictEqual(resolveHookName({}, "Stop"), "Stop");
    assert.strictEqual(resolveHookName(null, "Stop"), "Stop");
    assert.strictEqual(resolveHookName({}, ""), "");
    assert.strictEqual(resolveHookName(null, null), "");
  });

  it("shouldResolvePid returns true for mapped events and false when CLAWD_REMOTE is set", () => {
    assert.strictEqual(shouldResolvePid("Stop", {}), true);
    assert.strictEqual(shouldResolvePid("PreToolUse", {}), true);
    assert.strictEqual(shouldResolvePid("Stop", { CLAWD_REMOTE: "1" }), false);
    assert.strictEqual(shouldResolvePid("UnknownEvent", {}), false);
  });

  it("skips pid resolution for high-frequency permission events (QoderWork waits on hook stdout)", () => {
    assert.strictEqual(shouldResolvePid("PermissionRequest", {}), false);
    assert.strictEqual(shouldResolvePid("PermissionDenied", {}), false);
  });
});
