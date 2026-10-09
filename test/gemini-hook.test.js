const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { runSpawnedHook } = require("./helpers/spawned-hook");
const { __test } = require("../hooks/gemini-hook");

function runGeminiHook(argvEvent, payload = {}) {
  const scriptPath = path.resolve(__dirname, "..", "hooks", "gemini-hook.js");
  return runSpawnedHook({
    script: scriptPath,
    args: [argvEvent],
    payload,
    httpContract: "block",
    env: { CLAWD_REMOTE: "1" },
  });
}

describe("Gemini hook script", () => {
  it("writes only allow JSON for BeforeTool", () => {
    const result = runGeminiHook("BeforeTool", { session_id: "s1" });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stderr, "");
    assert.strictEqual(result.stdout.trim(), JSON.stringify({ decision: "allow" }));
  });

  it("uses argv event name when hook_event_name is absent", () => {
    const result = runGeminiHook("AfterTool", { session_id: "s1", cwd: process.cwd() });

    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { decision: "allow" });
  });

  it("writes empty JSON for passive lifecycle hooks", () => {
    const result = runGeminiHook("AfterAgent", { session_id: "s1" });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stderr, "");
    assert.strictEqual(result.stdout.trim(), "{}");
  });

  it("prefers payload hook_event_name over argv event name", () => {
    const result = runGeminiHook("BeforeTool", {
      hook_event_name: "AfterAgent",
      session_id: "s1",
    });

    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), {});
  });

  it("posts PID metadata on SessionStart", async () => {
    const postedBodies = [];
    let resolveCalls = 0;
    const result = await __test.sendHookEvent({
      session_id: "s1",
      cwd: process.cwd(),
    }, "SessionStart", {
      env: {},
      resolvePid: () => {
        resolveCalls++;
        return {
          stablePid: 4242,
          agentPid: 4343,
          detectedEditor: "code",
          pidChain: [4343, 4242],
        };
      },
      postState: (body, _options, callback) => {
        postedBodies.push(JSON.parse(body));
        callback(true, 23333);
      },
    });

    assert.strictEqual(resolveCalls, 1);
    assert.strictEqual(result.posted, true);
    assert.strictEqual(postedBodies.length, 1);
    assert.strictEqual(postedBodies[0].agent_id, "gemini-cli");
    assert.strictEqual(postedBodies[0].session_id, "gemini:s1");
    assert.strictEqual(postedBodies[0].event, "SessionStart");
    assert.strictEqual(postedBodies[0].cwd, process.cwd());
    assert.strictEqual(postedBodies[0].source_pid, 4242);
    assert.strictEqual(postedBodies[0].agent_pid, 4343);
    assert.strictEqual(postedBodies[0].editor, "code");
    assert.deepStrictEqual(postedBodies[0].pid_chain, [4343, 4242]);
  });

  it("posts PID metadata on non-SessionStart events", async () => {
    const postedBodies = [];
    let resolveCalls = 0;
    const result = await __test.sendHookEvent({
      session_id: "s1",
      cwd: process.cwd(),
    }, "BeforeTool", {
      env: {},
      resolvePid: () => {
        resolveCalls++;
        return {
          stablePid: 4242,
          agentPid: 4343,
          detectedEditor: "code",
          pidChain: [4343, 4242],
        };
      },
      postState: (body, _options, callback) => {
        postedBodies.push(JSON.parse(body));
        callback(true, 23333);
      },
    });

    assert.strictEqual(resolveCalls, 1);
    assert.deepStrictEqual(result.stdout, JSON.stringify({ decision: "allow" }));
    assert.strictEqual(postedBodies.length, 1);
    assert.strictEqual(postedBodies[0].agent_id, "gemini-cli");
    assert.strictEqual(postedBodies[0].session_id, "gemini:s1");
    assert.strictEqual(postedBodies[0].event, "PreToolUse");
    assert.strictEqual(postedBodies[0].cwd, process.cwd());
    assert.strictEqual(postedBodies[0].source_pid, 4242);
    assert.strictEqual(postedBodies[0].agent_pid, 4343);
    assert.deepStrictEqual(postedBodies[0].pid_chain, [4343, 4242]);
    assert.strictEqual(postedBodies[0].editor, "code");
  });

  it("recognizes node-hosted Gemini CLI command lines for agent PID tracking", () => {
    assert.strictEqual(
      __test.isGeminiAgentCommandLine('"C:/Program Files/nodejs/node.exe" "C:/Users/me/AppData/Roaming/npm/node_modules/@google/gemini-cli/dist/index.js"'),
      true
    );
    assert.strictEqual(
      __test.isGeminiAgentCommandLine('"node" "C:/Users/me/AppData/Roaming/npm/node_modules/.bin/gemini"'),
      true
    );
    assert.strictEqual(
      __test.isGeminiAgentCommandLine('"node" "D:/animation/hooks/gemini-hook.js" "BeforeTool"'),
      false
    );
  });

  it("posts host instead of local PID metadata in remote mode", async () => {
    const postedBodies = [];
    let resolveCalls = 0;
    const result = await __test.sendHookEvent({
      session_id: "s1",
      cwd: process.cwd(),
    }, "AfterAgent", {
      env: {
        CLAWD_REMOTE: "1",
        CLAWD_SSH_REMOTE: "1",
        ORCA_PANE_KEY: "8ce1fff7-tab:9813824b-leaf",
      },
      readHostPrefix: () => "remote-host",
      resolvePid: () => {
        resolveCalls++;
        return { stablePid: 4242, pidChain: [4242] };
      },
      postState: (body, _options, callback) => {
        postedBodies.push(JSON.parse(body));
        callback(true, 23333);
      },
    });

    assert.strictEqual(resolveCalls, 0);
    assert.deepStrictEqual(result.stdout, "{}");
    assert.strictEqual(postedBodies.length, 1);
    assert.strictEqual(postedBodies[0].agent_id, "gemini-cli");
    assert.strictEqual(postedBodies[0].session_id, "gemini:s1");
    assert.strictEqual(postedBodies[0].event, "AfterAgent");
    assert.strictEqual(postedBodies[0].host, "remote-host");
    assert.strictEqual(postedBodies[0].orca_pane_key, "8ce1fff7-tab:9813824b-leaf");
    assert.ok(!Object.prototype.hasOwnProperty.call(postedBodies[0], "source_pid"));
  });

  it("keeps Gemini AfterAgent as a neutral event instead of Stop/attention", async () => {
    const postedBodies = [];
    const result = await __test.sendHookEvent({
      session_id: "s1",
      cwd: process.cwd(),
    }, "AfterAgent", {
      env: {},
      postState: (body, _options, callback) => {
        postedBodies.push(JSON.parse(body));
        callback(true, 23333);
      },
    });

    assert.deepStrictEqual(result.stdout, "{}");
    assert.strictEqual(postedBodies.length, 1);
    assert.strictEqual(postedBodies[0].state, "idle");
    assert.strictEqual(postedBodies[0].event, "AfterAgent");
  });

  it("keeps already-prefixed Gemini session ids stable", async () => {
    const postedBodies = [];
    await __test.sendHookEvent({
      session_id: "gemini:s1",
      cwd: process.cwd(),
    }, "BeforeTool", {
      env: {},
      postState: (body, _options, callback) => {
        postedBodies.push(JSON.parse(body));
        callback(true, 23333);
      },
    });

    assert.strictEqual(postedBodies.length, 1);
    assert.strictEqual(postedBodies[0].session_id, "gemini:s1");
  });

  it("maps Gemini AfterTool error payloads to PostToolUseFailure", async () => {
    const postedBodies = [];
    const result = await __test.sendHookEvent({
      session_id: "s1",
      cwd: process.cwd(),
      tool_response: { error: "tool failed" },
    }, "AfterTool", {
      env: {},
      postState: (body, _options, callback) => {
        postedBodies.push(JSON.parse(body));
        callback(true, 23333);
      },
    });

    assert.deepStrictEqual(result.stdout, JSON.stringify({ decision: "allow" }));
    assert.strictEqual(postedBodies.length, 1);
    assert.strictEqual(postedBodies[0].state, "error");
    assert.strictEqual(postedBodies[0].event, "PostToolUseFailure");
  });

  it("maps Gemini SessionEnd reason=clear to sweeping", async () => {
    const postedBodies = [];
    const result = await __test.sendHookEvent({
      session_id: "s1",
      cwd: process.cwd(),
      reason: "clear",
    }, "SessionEnd", {
      env: {},
      postState: (body, _options, callback) => {
        postedBodies.push(JSON.parse(body));
        callback(true, 23333);
      },
    });

    assert.deepStrictEqual(result.stdout, "{}");
    assert.strictEqual(postedBodies.length, 1);
    assert.strictEqual(postedBodies[0].state, "sweeping");
    assert.strictEqual(postedBodies[0].event, "SessionEnd");
  });

  it("keeps Gemini PreCompress visible without remapping to PreCompact/sweeping", async () => {
    const postedBodies = [];
    const result = await __test.sendHookEvent({
      session_id: "s1",
      cwd: process.cwd(),
    }, "PreCompress", {
      env: {},
      postState: (body, _options, callback) => {
        postedBodies.push(JSON.parse(body));
        callback(true, 23333);
      },
    });

    assert.deepStrictEqual(result.stdout, "{}");
    assert.strictEqual(postedBodies.length, 1);
    assert.strictEqual(postedBodies[0].state, "idle");
    assert.strictEqual(postedBodies[0].event, "PreCompress");
  });
});
