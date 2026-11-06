"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { __test: hook } = require("../hooks/kiro-desktop-hook");
// Run the actual hook with an isolated HOME and recorded HTTP transport.
const { runSpawnedHook } = require("./helpers/spawned-hook");
const script = path.resolve(__dirname, "../hooks/kiro-desktop-hook.js");

for (const [event, state] of Object.entries(hook.HOOK_MAP)) {
  test(`kiro-desktop: ${event} posts ${state} with zero stdout bytes`, () => {
    const result = runSpawnedHook({
      script,
      payload: {
        hook_event_name: event,
        session_id: "sess_one",
        cwd: "/repo",
        prompt: "Fix this\nsecret",
      },
      httpContract: "expect-attempt",
      env: { CLAWD_POST_RECORDER_SUCCEED: "1" },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    const post = result.attempts.find(attempt => attempt.kind === "request");
    const body = JSON.parse(post.body);
    assert.equal(body.agent_id, "kiro-desktop");
    assert.equal(body.state, state);
    assert.equal(body.session_id, "sess_one");
    assert.equal(body.event, event);
    assert.equal(body.session_title, event === "UserPromptSubmit" ? "Fix this" : undefined);
  });
}
for (const payload of [
  { hook_event_name: "unknown", session_id: "sess_one" },
  { hook_event_name: "PreToolUse" },
  {},
  null,
]) {
  test(`kiro-desktop: drops unattributable payload ${JSON.stringify(payload)} silently`, () => {
    const result = runSpawnedHook({ script, payload, httpContract: "expect-none" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });
}
test("kiro-desktop: offline and malformed stdin exits remain zero bytes", () => {
  const offline = runSpawnedHook({
    script,
    payload: { hook_event_name: "PreToolUse", session_id: "sess_one" },
    httpContract: "expect-attempt",
  });
  assert.equal(offline.status, 0);
  assert.equal(offline.stdout, "");
  const malformed = runSpawnedHook({ script, input: "{", httpContract: "expect-none" });
  assert.equal(malformed.status, 0);
  assert.equal(malformed.stdout, "");
});
test("kiro-desktop: source pid prefers IDE and non-Mac agent names stay empty", () => {
  assert.equal(hook.pickSourcePid({ agentPid: 42, stablePid: 10 }), 42);
  assert.equal(hook.pickSourcePid({ stablePid: 10 }), 10);
  assert.deepEqual([...hook.AGENT_NAMES.mac], ["kiro"]);
  assert.equal(hook.AGENT_NAMES.win.size, 0);
  assert.equal(hook.AGENT_NAMES.linux.size, 0);
  const body = hook.buildBody(
    { hook_event_name: "PreToolUse", session_id: "s" },
    { stablePid: 10, agentPid: 42, pidChain: [42] },
  );
  assert.deepEqual(body.pid_chain, [42]);
});
test("kiro-desktop: prompt titles use first nonempty line and filter secrets", () => {
  assert.equal(hook.extractPromptTitle("\n  修复界面\nnext"), "修复界面");
  assert.equal(hook.extractPromptTitle("secret = abc"), null);
  assert.equal(hook.extractPromptTitle("sk-abcdefghijklmnop"), null);
  assert.equal(hook.extractPromptTitle("x".repeat(31)), "x".repeat(31));
  assert.ok(hook.extractPromptTitle("修复".repeat(50)).length <= 40);
});

test("kiro-desktop: unexpected adapter exceptions still produce zero stdout bytes", t => {
  const fs = require("node:fs");
  const os = require("node:os");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-desktop-exception-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preload = path.join(directory, "throw.cjs");
  const configPath = JSON.stringify(require.resolve("../hooks/server-config"));
  fs.writeFileSync(preload, `
const config = require(${configPath});
config.postStateToRunningServer = () => {
  throw new Error("injected");
};
`);
  const result = runSpawnedHook({ script, preloads: [preload],
    payload: { hook_event_name: "PreToolUse", session_id: "sess_one" }, httpContract: "expect-none" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});


test("kiro-desktop: standalone hook states match the registered agent event map", () => {
  assert.deepEqual(hook.HOOK_MAP, require("../agents/kiro-desktop").eventMap);
});
