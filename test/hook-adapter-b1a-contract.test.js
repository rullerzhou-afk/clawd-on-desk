"use strict";

const { after, describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { createSpawnedHookHarness } = require("./helpers/spawned-hook");
const {
  CLAWD_HOOK_PID_HEADER,
  CLAWD_PROCESS_INSTANCE_HEADER,
} = require("../hooks/server-config");

const HOOKS_DIR = path.resolve(__dirname, "..", "hooks");
const harness = createSpawnedHookHarness({ prefix: "clawd-b1a-hook-" });

after(() => harness.cleanup());

const GENERATION = "b1a-spawn-recorder-generation";
const RUNTIME = () => ({
  app: "clawd-on-desk",
  port: 23335,
  ownerPid: process.pid,
  windowsProcessChain: {
    version: 1,
    instanceGeneration: GENERATION,
    agents: {
      codex: "b1a-authoritative",
      "cursor-agent": "b1a-authoritative",
      "kiro-cli": "b1a-authoritative",
      codebuddy: "b1a-authoritative",
      reasonix: "b1a-authoritative",
    },
  },
});

const CASES = [
  {
    name: "codex state",
    script: "codex-hook.js",
    payload: {
      hook_event_name: "PreToolUse",
      session_id: "codex-b1a",
      cwd: "D:\\repo",
      tool_name: "Shell",
      tool_input: { command: "echo ok" },
    },
    agentId: "codex",
    path: "/state",
  },
  {
    name: "codex permission",
    script: "codex-hook.js",
    payload: {
      hook_event_name: "PermissionRequest",
      session_id: "codex-b1a-permission",
      cwd: "D:\\repo",
      tool_name: "Shell",
      tool_input: { command: "echo ok" },
    },
    agentId: "codex",
    path: "/permission",
  },
  {
    name: "Cursor",
    script: "cursor-hook.js",
    payload: { hook_event_name: "preToolUse", conversation_id: "cursor-b1a", cwd: "D:\\repo" },
    agentId: "cursor-agent",
    path: "/state",
  },
  {
    name: "Kiro",
    script: "kiro-hook.js",
    payload: { hook_event_name: "preToolUse", cwd: "D:\\repo" },
    agentId: "kiro-cli",
    path: "/state",
  },
  {
    name: "CodeBuddy",
    script: "codebuddy-hook.js",
    payload: { hook_event_name: "PreToolUse", session_id: "codebuddy-b1a", cwd: "D:\\repo" },
    agentId: "codebuddy",
    path: "/state",
  },
  {
    name: "Reasonix",
    script: "reasonix-hook.js",
    payload: { event: "PreToolUse", sessionId: "reasonix-b1a", cwd: "D:\\repo" },
    agentId: "reasonix",
    path: "/state",
  },
];

describe("#694 B1a authoritative hook transport", { skip: process.platform !== "win32" }, () => {
  for (const entry of CASES) {
    it(`${entry.name}: reaches fake Clawd with headers and zero child processes`, () => {
      const result = harness.run({
        script: path.join(HOOKS_DIR, entry.script),
        payload: entry.payload,
        runtimeJson: RUNTIME(),
        httpContract: "expect-attempt",
        probeProcessSpawns: true,
        env: {
          CLAWD_POST_RECORDER_SUCCEED: "1",
          CLAWD_RECORD_RUNTIME_READS: "1",
        },
        timeout: 10000,
      });

      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stderr, "");
      assert.deepStrictEqual(result.spawns, []);
      const post = result.attempts.find((attempt) => attempt.kind === "request" && attempt.path === entry.path);
      assert.ok(post, `missing ${entry.path} attempt: ${JSON.stringify(result.attempts)}`);
      assert.strictEqual(post.port, 23335);
      assert.match(post.headers[CLAWD_HOOK_PID_HEADER], /^[1-9]\d*$/);
      assert.strictEqual(post.headers[CLAWD_PROCESS_INSTANCE_HEADER], GENERATION);
      assert.strictEqual(
        result.attempts.filter((attempt) => attempt.kind === "runtime-read").length,
        1,
        "the immutable runtime observation must be reused by routing instead of rereading runtime.json",
      );

      const body = JSON.parse(post.body);
      assert.strictEqual(body.agent_id, entry.agentId);
      for (const key of ["source_pid", "agent_pid", "cursor_pid", "pid_chain", "editor", "wt_hwnd"]) {
        assert.strictEqual(Object.prototype.hasOwnProperty.call(body, key), false, `${key} must be server-owned`);
      }
    });
  }
});
