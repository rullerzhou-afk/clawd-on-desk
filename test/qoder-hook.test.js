const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  HOOK_MAP,
  buildStateBody,
  sendHookEvent,
  normalizeSessionId,
  isQoderAgentCommandLine,
} = require("../hooks/qoder-hook");

describe("Qoder hook runtime (Phase 1 state-only)", () => {
  it("maps Stop to attention so the completion animation/sound plays", () => {
    assert.strictEqual(HOOK_MAP.Stop.state, "attention");
  });

  it("maps tool-boundary events to working / error", () => {
    assert.strictEqual(HOOK_MAP.PreToolUse.state, "working");
    assert.strictEqual(HOOK_MAP.PostToolUse.state, "working");
    assert.strictEqual(HOOK_MAP.PostToolUseFailure.state, "error");
  });

  it("observes permission events as passive notifications, never a decision", () => {
    assert.strictEqual(HOOK_MAP.PermissionRequest.state, "notification");
    assert.strictEqual(HOOK_MAP.PermissionDenied.state, "notification");
    assert.strictEqual(HOOK_MAP.Notification.state, "notification");
    // P1-b: permission events ride the Clawd Notification event so state.js's
    // per-agent notification mute gate applies and bookkeeping is consistent.
    assert.strictEqual(HOOK_MAP.PermissionRequest.event, "Notification");
    assert.strictEqual(HOOK_MAP.PermissionDenied.event, "Notification");
  });

  it("maps lifecycle events to idle / thinking / sleeping", () => {
    assert.strictEqual(HOOK_MAP.SessionStart.state, "idle");
    assert.strictEqual(HOOK_MAP.UserPromptSubmit.state, "thinking");
    assert.strictEqual(HOOK_MAP.SessionEnd.state, "sleeping");
  });

  it("namespaces session ids as qoder:<raw>, not local|qoder|<raw>", () => {
    assert.strictEqual(normalizeSessionId("abc"), "qoder:abc");
    assert.strictEqual(normalizeSessionId(""), "qoder:default");
    assert.strictEqual(normalizeSessionId(null), "qoder:default");
    assert.strictEqual(normalizeSessionId("qoder:abc"), "qoder:abc");
  });

  it("builds a state body with agent_id, namespaced session, and safe metadata", () => {
    const body = buildStateBody("PreToolUse", {
      session_id: "s1",
      cwd: "/work",
      tool_name: "Edit",
      tool_use_id: "tu1",
      model: "qoder-model",
      permission_mode: "default",
      transcript_path: "/t.jsonl",
      tool_input: { file: "a.js" },
    }, { pidMeta: { stablePid: 123 } });

    assert.strictEqual(body.agent_id, "qoder");
    assert.strictEqual(body.state, "working");
    assert.strictEqual(body.event, "PreToolUse");
    assert.strictEqual(body.session_id, "qoder:s1");
    assert.strictEqual(body.cwd, "/work");
    assert.strictEqual(body.tool_name, "Edit");
    assert.strictEqual(body.tool_use_id, "tu1");
    assert.strictEqual(body.model, "qoder-model");
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
    assert.strictEqual(posted[0].agent_id, "qoder");
    assert.strictEqual(posted[0].session_id, "qoder:s1");
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

  it("permission events stay state-only: notification state with {} stdout", async () => {
    const posted = [];
    for (const ev of ["PermissionRequest", "PermissionDenied"]) {
      const result = await sendHookEvent(
        { hook_event_name: ev, session_id: "s1", tool_name: "Bash" },
        undefined,
        { env: {}, resolvePid: () => ({}), postState: (b, _o, cb) => { posted.push(JSON.parse(b)); cb(true); } }
      );
      assert.strictEqual(result.stdout, "{}");
    }
    assert.deepStrictEqual(posted.map((b) => b.state), ["notification", "notification"]);
    // P1-b: posted as Clawd Notification events (not PermissionRequest/Denied)
    // so the wait-for-input mute toggle and notification gate take effect.
    assert.deepStrictEqual(posted.map((b) => b.event), ["Notification", "Notification"]);
  });

  it("narrows command-line detection to the qoder executable token", () => {
    assert.strictEqual(isQoderAgentCommandLine("/usr/local/bin/qoder"), true);
    // Official CLI binary is `qodercli` (npm @qoder-ai/qodercli).
    assert.strictEqual(isQoderAgentCommandLine("qodercli"), true);
    assert.strictEqual(isQoderAgentCommandLine("/usr/local/bin/qodercli"), true);
    assert.strictEqual(isQoderAgentCommandLine("node /x/@qoder-ai/qodercli/dist/cli.js"), true);
    assert.strictEqual(isQoderAgentCommandLine("node /opt/qoder-cli/dist/cli.js"), true);
    assert.strictEqual(isQoderAgentCommandLine("C:\\tools\\node_modules\\.bin\\qoder"), true);
    // Must NOT match a node process that merely runs inside a repo whose path
    // happens to contain "qoder".
    assert.strictEqual(isQoderAgentCommandLine("node /home/me/qoder-notes/index.js"), false);
    assert.strictEqual(isQoderAgentCommandLine("node /home/me/myqoder/app.js"), false);
    assert.strictEqual(isQoderAgentCommandLine(""), false);
  });
});
