const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { __test } = require("../hooks/traecode-hook");
const { runSpawnedHook } = require("./helpers/spawned-hook");

const HOOK_PATH = path.resolve(__dirname, "..", "hooks", "traecode-hook.js");
const tempDirs = [];

function makeMarkerDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-tmtitle-"));
  tempDirs.push(dir);
  return dir;
}

function runTraeHook(payload, options = {}) {
  const markerDir = options.markerDir || makeMarkerDir();
  return runSpawnedHook({
    script: HOOK_PATH,
    payload,
    httpContract: "expect-attempt",
    env: {
      CLAWD_POST_RECORDER_SUCCEED: "1",
      TRAECODE_TITLE_CACHE_DIR: markerDir,
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

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

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

describe("traecode hook end-to-end title forwarding", () => {
  it("POSTs session_title derived from the first user prompt", () => {
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
    assert.strictEqual(body.session_id, "sess-abc-1");
    assert.strictEqual(body.cwd, "/tmp/project");
    assert.strictEqual(body.session_title, "帮我写个倒计时组件");
  });

  it("keeps the first prompt as the title and ignores follow-up prompts", () => {
    const markerDir = makeMarkerDir();
    const payloadFor = (prompt) => ({
      session_id: "sess-abc-2",
      cwd: "/tmp/project",
      hook_event_name: "UserPromptSubmit",
      prompt,
    });

    const first = runTraeHook(payloadFor("第一个问题"), { markerDir });
    assert.strictEqual(postedBody(first).session_title, "第一个问题");

    const second = runTraeHook(payloadFor("第二个问题"), { markerDir });
    assert.strictEqual(second.status, 0);
    assert.strictEqual(postedBody(second).session_title, undefined);
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
});
