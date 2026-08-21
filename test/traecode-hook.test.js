const { describe, it } = require("node:test");
const assert = require("node:assert");

const { __test } = require("../hooks/traecode-hook");
const { runSpawnedHook } = require("./helpers/spawned-hook");

const HOOK_PATH = require("node:path").resolve(__dirname, "..", "hooks", "traecode-hook.js");

function runTraeHook(payload, options = {}) {
  return runSpawnedHook({
    script: HOOK_PATH,
    payload,
    httpContract: options.httpContract || "expect-attempt",
    env: {
      CLAWD_POST_RECORDER_SUCCEED: "1",
      ...(options.env || {}),
    },
  });
}

function postedBody(result) {
  const post = result.attempts && result.attempts.find(
    (attempt) => attempt.kind === "request" && typeof attempt.body === "string"
  );
  assert.ok(post, `expected a recorded POST attempt; attempts=${JSON.stringify(result.attempts)}`);
  return JSON.parse(post.body);
}

describe("traecode hook title derivation", () => {
  const { resolveSessionTitle } = __test;

  it("derives the title from the first line of the prompt on UserPromptSubmit", () => {
    assert.strictEqual(
      resolveSessionTitle({ prompt: "你能做什么" }, "UserPromptSubmit"),
      "你能做什么"
    );
  });

  it("uses the first non-empty line of a multiline prompt", () => {
    assert.strictEqual(
      resolveSessionTitle({ prompt: "\n  修一下 bug  \n然后跑测试" }, "UserPromptSubmit"),
      "修一下 bug"
    );
  });

  it("returns null when the prompt is empty or missing", () => {
    assert.strictEqual(resolveSessionTitle({}, "UserPromptSubmit"), null);
    assert.strictEqual(resolveSessionTitle({ prompt: "   \n\n" }, "UserPromptSubmit"), null);
  });

  it("returns null when the payload is missing", () => {
    assert.strictEqual(resolveSessionTitle(null, "UserPromptSubmit"), null);
    assert.strictEqual(resolveSessionTitle(undefined, "UserPromptSubmit"), null);
  });

  it("truncates long prompt titles to PROMPT_TITLE_MAX with an ellipsis", () => {
    const long = "写一个超长的功能描述".repeat(20);
    const title = resolveSessionTitle({ prompt: long }, "UserPromptSubmit");
    assert.ok(title.length <= 41, `title too long: ${title.length}`);
    assert.ok(title.endsWith("…"));
  });

  it("refuses secret-looking prompts instead of leaking them as titles", () => {
    assert.strictEqual(
      resolveSessionTitle({ prompt: "我的 api_key 是 sk-abcdefghijklmnopqrstuvwxyz" }, "UserPromptSubmit"),
      null
    );
  });

  it("prefers a payload session_title over the prompt when present", () => {
    assert.strictEqual(
      resolveSessionTitle({ session_title: "会话标题", prompt: "第一行提示" }, "UserPromptSubmit"),
      "会话标题"
    );
  });

  it("does not derive a title from prompts on non-UserPromptSubmit events", () => {
    assert.strictEqual(
      resolveSessionTitle({ prompt: "你能做什么" }, "Stop"),
      null
    );
  });
});

describe("traecode hook lifecycle", () => {
  it("emits {} for every event including PreToolUse (state-only, no permission gating)", () => {
    const result = runTraeHook({
      session_id: "sess-pre",
      cwd: "/tmp/project",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
    });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim(), "{}");
    const body = postedBody(result);
    assert.strictEqual(body.state, "working");
    assert.strictEqual(body.agent_id, "traecode");
  });

  it("namespaces the session id with the traecode: prefix", () => {
    const result = runTraeHook({
      session_id: "sess-abc-1",
      cwd: "/tmp/project",
      hook_event_name: "UserPromptSubmit",
      prompt: "帮我写个倒计时组件",
    });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim(), "{}");
    const body = postedBody(result);
    assert.strictEqual(body.agent_id, "traecode");
    assert.strictEqual(body.session_id, "traecode:sess-abc-1");
    assert.strictEqual(body.cwd, "/tmp/project");
    assert.strictEqual(body.session_title, "帮我写个倒计时组件");
  });

  it("forwards the title candidate on every prompt (server keeps the first one)", () => {
    const payloadFor = (prompt) => ({
      session_id: "sess-abc-2",
      cwd: "/tmp/project",
      hook_event_name: "UserPromptSubmit",
      prompt,
    });

    const first = runTraeHook(payloadFor("第一个问题"));
    assert.strictEqual(postedBody(first).session_title, "第一个问题");

    const second = runTraeHook(payloadFor("第二个问题"));
    assert.strictEqual(second.status, 0);
    // The hook keeps forwarding each candidate; first-wins is enforced
    // server-side in state.js, not by the hook.
    assert.strictEqual(postedBody(second).session_title, "第二个问题");
  });

  it("omits session_title when there is no prompt to derive from", () => {
    const result = runTraeHook({
      session_id: "sess-abc-3",
      cwd: "/tmp/project",
      hook_event_name: "SessionStart",
    });

    assert.strictEqual(result.status, 0);
    const body = postedBody(result);
    assert.strictEqual(body.state, "idle");
    assert.strictEqual(body.session_title, undefined);
  });

  it("skips the POST entirely when the session id is missing or blank", () => {
    for (const missing of [undefined, "", "   ", "default"]) {
      const result = runTraeHook({
        session_id: missing,
        cwd: "/tmp/project",
        hook_event_name: "UserPromptSubmit",
        prompt: "没有 session 的事件",
      }, { httpContract: "expect-none" });

      assert.strictEqual(result.status, 0, `session_id=${JSON.stringify(missing)}`);
      assert.strictEqual(result.stdout.trim(), "{}", `session_id=${JSON.stringify(missing)}`);
    }
  });

  it("answers TraeCode immediately even when the POST is blocked (offline)", () => {
    const result = runTraeHook({
      session_id: "sess-abc-4",
      cwd: "/tmp/project",
      hook_event_name: "PreToolUse",
    }, { httpContract: "block" });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim(), "{}");
  });
});

describe("traecode hook import safety", () => {
  it("importing the module for __test does not read stdin, write stdout, or exit", () => {
    // The require at the top of this file already exercised this — module
    // import must not start the real lifecycle. Spawn a trivial probe to
    // confirm the file loads without emitting anything on stdout.
    const { spawnSync } = require("node:child_process");
    const probe = spawnSync(
      process.execPath,
      ["-e", `require(${JSON.stringify(HOOK_PATH)}); process.stdout.write("loaded")`],
      { encoding: "utf8", timeout: 5000 }
    );
    assert.strictEqual(probe.status, 0, `probe stderr=${probe.stderr}`);
    assert.strictEqual(probe.stdout, "loaded");
  });
});
