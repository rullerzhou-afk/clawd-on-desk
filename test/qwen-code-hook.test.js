const { describe, it } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const path = require("path");
const {
  buildPermissionBody,
  buildQwenNoDecisionOutput,
  buildQwenPermissionOutput,
  buildStateBody,
  buildToolInputFingerprint,
  isQwenAgentCommandLine,
  normalizeQwenSessionId,
  run,
  sanitizeQwenPermissionOutput,
} = require("../hooks/qwen-code-hook");

const mockResolve = () => ({
  stablePid: 123,
  agentPid: 456,
  detectedEditor: "code",
  pidChain: [789, 456, 123],
});

describe("Qwen Code hook", () => {
  it("normalizes session ids with the qwen-code prefix", () => {
    assert.strictEqual(normalizeQwenSessionId("abc"), "qwen-code:abc");
    assert.strictEqual(normalizeQwenSessionId("qwen-code:abc"), "qwen-code:abc");
    assert.strictEqual(normalizeQwenSessionId(""), "qwen-code:default");
  });

  it("builds state payloads without leaking raw tool input", () => {
    const toolInput = { command: "npm test", ignored: "x".repeat(600) };
    const body = buildStateBody("PreToolUse", {
      session_id: "s1",
      cwd: "/repo",
      model: "qwen3-coder-plus",
      permission_mode: "default",
      tool_name: "Bash",
      tool_use_id: "tool-1",
      tool_input: toolInput,
    }, mockResolve);

    assert.strictEqual(body.state, "working");
    assert.strictEqual(body.session_id, "qwen-code:s1");
    assert.strictEqual(body.agent_id, "qwen-code");
    assert.strictEqual(body.cwd, "/repo");
    assert.strictEqual(body.model, "qwen3-coder-plus");
    assert.strictEqual(body.permission_mode, "default");
    assert.strictEqual(body.tool_name, "Bash");
    assert.strictEqual(body.tool_use_id, "tool-1");
    assert.strictEqual(body.tool_input_fingerprint, buildToolInputFingerprint(toolInput));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(body, "tool_input"), false);
    assert.strictEqual(body.source_pid, 123);
    assert.strictEqual(body.agent_pid, 456);
    assert.deepStrictEqual(body.pid_chain, [789, 456, 123]);
  });

  it("drops every Notification regardless of payload type", () => {
    // qwen 0.16.1 fires Notification shortly after Stop (measured ~250ms)
    // as a generic "task done" signal that would clobber attention on the
    // mascot. Hook must never emit a /state POST for Notification, no
    // matter the payload.
    for (const payload of [
      { session_id: "s1", notification_type: "permission_prompt" },
      { session_id: "s1", notification_type: "info" },
      { session_id: "s1", message: "ready" },
      { session_id: "s1" },
    ]) {
      assert.strictEqual(buildStateBody("Notification", payload, mockResolve), null);
    }
  });

  it("builds bounded PermissionRequest payloads", () => {
    const toolInput = {
      command: "npm test",
      nested: { value: "x".repeat(600) },
    };
    const body = buildPermissionBody("PermissionRequest", {
      session_id: "s1",
      cwd: "/repo",
      model: "qwen3-coder-plus",
      permission_mode: "default",
      transcript_path: "/tmp/qwen.jsonl",
      tool_name: "Bash",
      tool_use_id: "tool-1",
      tool_input: toolInput,
      permission_suggestions: [{ type: "addRules" }],
    }, mockResolve);

    assert.strictEqual(body.agent_id, "qwen-code");
    assert.strictEqual(body.session_id, "qwen-code:s1");
    assert.strictEqual(body.tool_name, "Bash");
    assert.strictEqual(body.tool_input.nested.value.length, 240);
    assert.deepStrictEqual(body.permission_suggestions, []);
    assert.strictEqual(body.tool_use_id, "tool-1");
    assert.strictEqual(body.tool_input_fingerprint, buildToolInputFingerprint(toolInput));
    assert.strictEqual(body.source_pid, 123);
    assert.strictEqual(body.agent_pid, 456);
  });

  it("uses host instead of local pid fields in remote mode", () => {
    const body = buildPermissionBody("PermissionRequest", {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    }, () => {
      throw new Error("resolve should not run");
    }, { remote: true, host: "remote:host" });

    assert.strictEqual(body.host, "remote:host");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(body, "source_pid"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(body, "agent_pid"), false);
  });

  it("sanitizes Qwen PermissionRequest output", () => {
    const allow = JSON.parse(buildQwenPermissionOutput({
      behavior: "allow",
      message: "ignored",
      updatedPermissions: [{ type: "setMode" }],
      interrupt: true,
    }));
    assert.deepStrictEqual(allow.hookSpecificOutput.decision, { behavior: "allow" });

    const deny = JSON.parse(buildQwenPermissionOutput({ behavior: "deny", message: "Blocked" }));
    assert.deepStrictEqual(deny.hookSpecificOutput.decision, { behavior: "deny", message: "Blocked" });
    assert.strictEqual(buildQwenPermissionOutput({ behavior: "ask" }), "{}");
    assert.strictEqual(sanitizeQwenPermissionOutput("not json"), buildQwenNoDecisionOutput());
  });

  it("posts state with timeoutMs=100 and returns exact no-decision stdout", async () => {
    const calls = [];
    const result = await run({
      hook_event_name: "Stop",
      session_id: "s1",
    }, undefined, {
      resolvePid: mockResolve,
      postState: (body, options, callback) => {
        calls.push({ body: JSON.parse(body), options });
        callback(true, 23333);
      },
    });

    assert.strictEqual(result.stdout, "{}");
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].options, { timeoutMs: 100 });
    assert.strictEqual(calls[0].body.event, "Stop");
    // qwen Stop plays the happy end-of-turn animation. The server-side
    // self-submit filter (src/state.js lastBoundaryAt) drops the synthetic
    // PostToolUse → UserPromptSubmit that used to interrupt it, so attention
    // is safe again.
    assert.strictEqual(calls[0].body.state, "attention");
  });

  it("returns exact no-decision stdout for failed permission posts", async () => {
    const result = await run({
      hook_event_name: "PermissionRequest",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    }, undefined, {
      resolvePid: mockResolve,
      postPermission: (_body, _options, callback) => callback(false, null, "", 0),
    });

    assert.strictEqual(result.stdout, "{}");
  });

  it("detects qwen npm-shim command lines", () => {
    assert.strictEqual(isQwenAgentCommandLine("node C:/Users/me/AppData/Roaming/npm/node_modules/@qwen-code/qwen-code/cli.js"), true);
    assert.strictEqual(isQwenAgentCommandLine("/repo/node_modules/.bin/qwen"), true);
    assert.strictEqual(isQwenAgentCommandLine("node D:/animation/hooks/qwen-code-hook.js Stop"), false);
  });

  it("prints exact no-decision stdout and empty stderr for unknown events", () => {
    const scriptPath = path.resolve(__dirname, "..", "hooks", "qwen-code-hook.js");
    const result = spawnSync(process.execPath, [scriptPath], {
      input: JSON.stringify({
        hook_event_name: "UnknownEvent",
        session_id: "s1",
      }),
      encoding: "utf8",
      windowsHide: true,
    });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "{}\n");
    assert.strictEqual(result.stderr, "");
  });
});
