const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { runSpawnedHook } = require("./helpers/spawned-hook");
const { __test } = require("../hooks/codewhale-hook");

function cacheDeps(initial = null) {
  let cached = initial;
  return {
    readCachedSessionId: () => cached,
    writeCachedSessionId: (id) => {
      cached = id;
    },
    clearCachedSessionId: () => {
      cached = null;
    },
    getCached: () => cached,
  };
}

describe("CodeWhale hook script", () => {
  it("builds CodeWhale state payloads from environment variables", () => {
    const cache = cacheDeps();
    const payload = __test.buildPayload("session_start", {
      DEEPSEEK_SESSION_ID: "sess-1",
      DEEPSEEK_WORKSPACE: "/repo",
      DEEPSEEK_MODEL: "deepseek-v4",
    }, cache);

    assert.strictEqual(payload.agent_id, "codewhale");
    assert.strictEqual(payload.hook_source, "codewhale-hook");
    assert.strictEqual(payload.event, "SessionStart");
    assert.strictEqual(payload.state, "idle");
    assert.strictEqual(payload.session_id, "codewhale:sess-1");
    assert.strictEqual(payload.cwd, "/repo");
    assert.strictEqual(payload.session_title, "CodeWhale");
    assert.strictEqual(payload.model, "deepseek-v4");
    assert.strictEqual(cache.getCached(), "sess-1");
  });

  it("reuses the cached session id when CodeWhale omits it", () => {
    const cache = cacheDeps("sess-previous");
    const payload = __test.buildPayload("mode_change", {
      DEEPSEEK_MODE: "agent",
      DEEPSEEK_PREVIOUS_MODE: "plan",
    }, cache);

    assert.strictEqual(payload.session_id, "codewhale:sess-previous");
    assert.strictEqual(payload.event, "Notification");
    assert.strictEqual(payload.state, "attention");
  });

  it("maps tool failures to PostToolUseFailure", () => {
    const payload = __test.buildPayload("tool_call_after", {
      DEEPSEEK_SESSION_ID: "sess-1",
      DEEPSEEK_TOOL_NAME: "bash",
      DEEPSEEK_TOOL_SUCCESS: "false",
    }, cacheDeps());

    assert.strictEqual(payload.event, "PostToolUseFailure");
    assert.strictEqual(payload.state, "error");
    assert.strictEqual(payload.tool_name, "bash");
  });

  it("posts passive events with the short timeout", async () => {
    const posted = [];
    const result = await __test.run("message_submit", {
      env: {
        DEEPSEEK_SESSION_ID: "sess-1",
        DEEPSEEK_WORKSPACE: "/repo",
      },
      ...cacheDeps(),
      postState: (body, options, callback) => {
        posted.push({ body: JSON.parse(body), options });
        callback(true, 23333);
      },
    });

    assert.strictEqual(result.posted, true);
    assert.strictEqual(result.port, 23333);
    assert.deepStrictEqual(posted[0].options, { timeoutMs: 100 });
    assert.strictEqual(posted[0].body.event, "UserPromptSubmit");
    assert.strictEqual(posted[0].body.state, "thinking");
  });

  it("awaits session_end longer and clears the cache", async () => {
    const cache = cacheDeps("sess-previous");
    const posted = [];
    const result = await __test.run("session_end", {
      env: {},
      ...cache,
      postState: (body, options, callback) => {
        posted.push({ body: JSON.parse(body), options });
        callback(true, 23334);
      },
    });

    assert.strictEqual(result.posted, true);
    assert.strictEqual(cache.getCached(), null);
    assert.deepStrictEqual(posted[0].options, { timeoutMs: 2000 });
    assert.strictEqual(posted[0].body.event, "SessionEnd");
    assert.strictEqual(posted[0].body.state, "sleeping");
    assert.strictEqual(posted[0].body.session_id, "codewhale:sess-previous");
  });

  it("exits cleanly without stdout or stderr for unknown CLI events", () => {
    const scriptPath = path.resolve(__dirname, "..", "hooks", "codewhale-hook.js");
    const result = runSpawnedHook({
      script: scriptPath,
      args: ["shell_env"],
      httpContract: "expect-none",
    });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(result.stderr, "");
  });
});
