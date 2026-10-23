"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { EventEmitter } = require("node:events"),
  { PassThrough } = require("node:stream");
const {
  review,
  backend,
  hash,
  normalizeRequest,
} = require("../hooks/examples/permission-ai-review.cjs");
const { buildReviewPayload } = require("../src/permission-review-command");
const cwd = fs.mkdtempSync(path.join(__dirname, "reviewer-sandbox-"));
test.after(() => fs.rmdirSync(cwd));
const request = {
  agentId: "codex",
  sessionId: "fixture-session",
  toolName: "Read",
  toolInput: { file_path: "README.md" },
  cwd,
};
test("actual host serializer is normalized before policy and backend evaluation", async () => {
  const payload = JSON.parse(JSON.stringify(buildReviewPayload(request)));
  assert.equal(payload.tool, "Read");
  assert.equal(payload.agent, "codex");
  assert.deepEqual(normalizeRequest(payload), request);
  let received;
  const result = await review(payload, {
    enabled: () => true,
    backend: async (value) => {
      received = value;
      return { decision: "allow" };
    },
  });
  assert.equal(result.decision, "allow", result.reason);
  assert.equal(received.toolName, "Read");
  assert.equal(received.agentId, "codex");
  assert.equal(result.decision, "allow");
});
test("questions, plans, secrets, dangerous shell and out-of-project paths do not reach the model", async () => {
  for (const change of [
    { toolName: "AskUserQuestion" },
    { toolName: "ExitPlanMode" },
    { agentId: "workbuddy" },
    { toolInput: { file_path: "../outside.md" } },
    { toolInput: { file_path: ".env" } },
    { toolInput: { file_path: "readme.md", password: "fixture" } },
    { toolName: "Bash", toolInput: { command: "git status; rm ." } },
    { cwd: "" },
  ]) {
    assert.equal(
      (
        await review(
          { ...request, ...change },
          {
            enabled: () => true,
            backend: () => assert.fail("must remain local"),
          },
        )
      ).decision,
      "hold",
    );
  }
});
test("revoked settings while the model runs prevent automatic allowance", async () => {
  let enabled = true;
  const result = await review(request, {
    enabled: () => enabled,
    backend: async () => {
      enabled = false;
      return { decision: "allow" };
    },
  });
  assert.equal(result.decision, "hold");
});
function fakeProcess(onStart) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => {};
  if (onStart) process.nextTick(() => onStart(child));
  return child;
}
test("backend accepts only a matching hash, complete turn and no tool events", async () => {
  const previous = process.env.CLAWD_REVIEW_CODEX;
  process.env.CLAWD_REVIEW_CODEX = process.execPath;
  try {
    for (const mode of ["valid", "wrong-hash", "tool", "unfinished"]) {
      const result = await backend(request, {
        spawnProcess: (exe, args, options) => {
          assert.equal(exe, process.execPath);
          assert.equal(options.shell, false);
          assert.ok(args.includes("read-only"));
          assert.ok(args.includes("shell_tool"));
          return fakeProcess((child) => {
            const events = [
              {
                type: "item.completed",
                item: {
                  type: mode === "tool" ? "command_execution" : "agent_message",
                  text: JSON.stringify({
                    decision: "allow",
                    reason: "fixture",
                    requestHash:
                      mode === "wrong-hash" ? "other" : hash(request),
                  }),
                },
              },
            ];
            if (mode !== "unfinished") events.push({ type: "turn.completed" });
            child.stdout.write(events.map((e) => JSON.stringify(e)).join("\n"));
            child.emit("exit", 0);
          });
        },
      });
      assert.equal(result.decision, mode === "valid" ? "allow" : "hold");
    }
    assert.equal(
      (
        await backend(request, {
          timeoutMs: 10,
          spawnProcess: () => fakeProcess(),
        })
      ).decision,
      "hold",
    );
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      (
        await backend(request, {
          signal: controller.signal,
          spawnProcess: () => assert.fail("aborted"),
        })
      ).decision,
      "hold",
    );
  } finally {
    if (previous === undefined) delete process.env.CLAWD_REVIEW_CODEX;
    else process.env.CLAWD_REVIEW_CODEX = previous;
  }
});
