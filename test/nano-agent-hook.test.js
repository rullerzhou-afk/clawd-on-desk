// test/nano-agent-hook.test.js — Verifies state-body construction and event
// normalization for the nano-agent hook script. Hook script consumes the
// envelope from NANO_HOOK_INPUT (env var), not stdin, so we exercise the
// pure helpers directly.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  EVENT_TO_STATE,
  buildStateBody,
  readNanoHookEnvelope,
  resolveEvent,
  snakeToPascal,
} = require("../hooks/nano-agent-hook");

const fakeResolve = () => ({
  stablePid: 4242,
  agentPid: 9999,
  agentCommandLine: "/usr/local/bin/nano chat",
  detectedEditor: null,
  pidChain: [4242, 9999],
});

describe("snakeToPascal", () => {
  it("converts snake_case to PascalCase", () => {
    assert.strictEqual(snakeToPascal("pre_tool_use"), "PreToolUse");
    assert.strictEqual(snakeToPascal("session_start"), "SessionStart");
  });
  it("returns null for empty / non-string input", () => {
    assert.strictEqual(snakeToPascal(""), null);
    assert.strictEqual(snakeToPascal(undefined), null);
  });
  it("preserves single-word PascalCase tokens", () => {
    assert.strictEqual(snakeToPascal("stop"), "Stop");
    assert.strictEqual(snakeToPascal("Stop"), "Stop"); // already PascalCase
  });
});

describe("readNanoHookEnvelope", () => {
  it("parses NANO_HOOK_INPUT JSON envelope", () => {
    const env = {
      NANO_HOOK_INPUT: JSON.stringify({
        event: "pre_tool_use",
        session_id: "sess-1",
        tool_name: "shell",
        params: { tool_input: { command: "ls" } },
      }),
    };
    const envelope = readNanoHookEnvelope(env);
    assert.strictEqual(envelope.event, "pre_tool_use");
    assert.strictEqual(envelope.session_id, "sess-1");
    assert.strictEqual(envelope.tool_name, "shell");
    assert.deepStrictEqual(envelope.params.tool_input, { command: "ls" });
  });

  it("falls back to legacy NANO_TOOL_INPUT / NANO_TOOL_NAME when envelope is missing", () => {
    const env = {
      NANO_TOOL_NAME: "write_file",
      NANO_TOOL_INPUT: JSON.stringify({ path: "/tmp/x" }),
    };
    const envelope = readNanoHookEnvelope(env);
    assert.strictEqual(envelope.tool_name, "write_file");
    assert.deepStrictEqual(envelope.params, { path: "/tmp/x" });
  });

  it("ignores malformed JSON gracefully", () => {
    const envelope = readNanoHookEnvelope({ NANO_HOOK_INPUT: "{not json" });
    assert.deepStrictEqual(envelope, {});
  });
});

describe("resolveEvent", () => {
  it("prefers argv over env / envelope", () => {
    const env = { NANO_HOOK_EVENT: "session_start" };
    const envelope = { event: "stop" };
    const event = resolveEvent(["node", "hook.js", "PreToolUse"], env, envelope);
    assert.strictEqual(event, "PreToolUse");
  });

  it("normalizes snake_case event from env", () => {
    const event = resolveEvent(["node", "hook.js"], { NANO_HOOK_EVENT: "pre_tool_use" }, {});
    assert.strictEqual(event, "PreToolUse");
  });

  it("falls back to envelope.hook_event_name", () => {
    const event = resolveEvent(["node", "hook.js"], {}, { hook_event_name: "PostCompact" });
    assert.strictEqual(event, "PostCompact");
  });

  it("returns null for unknown events", () => {
    const event = resolveEvent(["node", "hook.js", "BogusEvent"], {}, {});
    assert.strictEqual(event, null);
  });
});

describe("buildStateBody", () => {
  it("emits expected shape for pre_tool_use", () => {
    const envelope = {
      session_id: "abc",
      cwd: "/work",
      tool_name: "shell",
      params: { tool_input: { command: "ls" }, tool_use_id: "use-1" },
    };
    const body = buildStateBody("PreToolUse", envelope, fakeResolve);
    assert.strictEqual(body.state, "working");
    assert.strictEqual(body.event, "PreToolUse");
    assert.strictEqual(body.agent_id, "nano-agent");
    assert.strictEqual(body.session_id, "abc");
    assert.strictEqual(body.cwd, "/work");
    assert.strictEqual(body.tool_name, "shell");
    assert.strictEqual(body.tool_use_id, "use-1");
    assert.ok(body.tool_input_fingerprint, "expected sha1 fingerprint");
    assert.strictEqual(body.source_pid, 4242);
    assert.strictEqual(body.agent_pid, 9999);
    assert.strictEqual(body.nano_pid, 9999);
  });

  it("treats Task delegations as juggling", () => {
    const envelope = { session_id: "x", tool_name: "Task", params: {} };
    const body = buildStateBody("PreToolUse", envelope, fakeResolve);
    assert.strictEqual(body.state, "juggling");
    assert.strictEqual(body.event, "SubagentStart");
  });

  it("uses default session id when missing", () => {
    const body = buildStateBody("SessionStart", {}, fakeResolve);
    assert.strictEqual(body.session_id, "default");
    assert.strictEqual(body.state, "idle");
  });

  it("returns null for unknown events", () => {
    assert.strictEqual(buildStateBody("Bogus", {}, fakeResolve), null);
  });

  it("emits remote host instead of pids when CLAWD_REMOTE is set", () => {
    const original = process.env.CLAWD_REMOTE;
    process.env.CLAWD_REMOTE = "1";
    try {
      const body = buildStateBody("Stop", { session_id: "s" }, fakeResolve);
      assert.strictEqual(body.state, "attention");
      assert.ok(typeof body.host === "string");
      assert.strictEqual(body.source_pid, undefined);
      assert.strictEqual(body.agent_pid, undefined);
    } finally {
      if (original === undefined) delete process.env.CLAWD_REMOTE;
      else process.env.CLAWD_REMOTE = original;
    }
  });
});

describe("EVENT_TO_STATE coverage", () => {
  it("includes all snake_case events emitted by the installer", () => {
    const installerEvents = require("../hooks/nano-agent-install").NANO_COMMAND_HOOK_EVENTS;
    for (const ev of installerEvents) {
      const pascal = snakeToPascal(ev);
      assert.ok(EVENT_TO_STATE[pascal], `missing EVENT_TO_STATE entry for ${ev} → ${pascal}`);
    }
  });
});
