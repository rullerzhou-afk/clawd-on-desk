"use strict";

// The CodeBuddy 5.x IDE runs hooks under agent-harness.exe on Windows. The
// resolver must treat it as the agent so SessionStart populates the Windows PID
// cache; otherwise every first UserPromptSubmit (cache-only) arrives without a
// source PID and a just-started conversation cannot be focused.
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createSpawnedHookHarness } = require("./helpers/spawned-hook");
const pc = require("../hooks/pid-cache");
const { CODEBUDDY_AGENT_NAMES } = require("../hooks/codebuddy-hook");
const { getB1aAgentConfig } = require("../src/server-windows-process-metadata");

describe("CodeBuddy IDE Windows PID cache", () => {
  let harness;
  let temp;
  let snapshotFile;
  const cwd = "D:/codebuddy-project";
  const sid = "10d303e2-2bc6-477d-9521-c45fc98b4945";

  beforeEach(() => {
    harness = createSpawnedHookHarness({ prefix: "clawd-codebuddy-cache-" });
    temp = path.join(harness.home, "tmp");
    fs.mkdirSync(temp);
    snapshotFile = path.join(harness.home, "snapshots.jsonl");
    pc.__setCacheDirForTests(temp);
  });
  afterEach(() => {
    pc.__setCacheDirForTests(null);
    harness.cleanup();
  });

  function run(event, env = {}) {
    fs.writeFileSync(snapshotFile, "");
    const result = harness.run({
      script: path.join(__dirname, "..", "hooks", "codebuddy-hook.js"),
      payload: { hook_event_name: event, session_id: sid, cwd, client: "CodeBuddyIDE", prompt: "list files" },
      runtimeJson: { app: "clawd-on-desk", port: 23333, ownerPid: process.pid },
      preloads: [path.join(__dirname, "helpers", "codebuddy-pid-cache-probe.js")],
      httpContract: "expect-attempt",
      env: {
        TEMP: temp,
        TMP: temp,
        CLAWD_CB_SNAPSHOTS: snapshotFile,
        CLAWD_CB_MAIN_PID: String(process.ppid),
        CLAWD_POST_RECORDER_SUCCEED: "1",
        ...env,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "{}\n");
    const snapshots = fs.readFileSync(snapshotFile, "utf8").trim().split("\n").filter(Boolean);
    const posts = result.attempts.filter((entry) => entry.kind === "request");
    assert.equal(posts.length, 1);
    return { snapshots, body: JSON.parse(posts[0].body) };
  }

  it("caches the agent-harness PID at SessionStart so the first prompt carries a source PID", () => {
    const started = run("SessionStart");
    assert.equal(started.snapshots.length, 1);
    assert.equal(started.body.agent_pid, process.pid, "agent-harness.exe is the session's agent");
    const cached = pc.readPidCacheV2("codebuddy", sid, cwd);
    assert.ok(cached, "SessionStart must write the v2 cache");
    assert.equal(cached.agentPid, process.pid);

    const prompt = run("UserPromptSubmit");
    assert.equal(prompt.snapshots.length, 0, "prompt stays cache-only");
    assert.equal(prompt.body.source_pid, process.ppid,
      "the first prompt must carry the CodeBuddy main process as its source PID");
    assert.equal(prompt.body.agent_pid, process.pid);
    assert.equal(prompt.body.codebuddy_client, "CodeBuddyIDE");

    const tool = run("PreToolUse");
    assert.equal(tool.snapshots.length, 0, "tool events reuse the cache");
    assert.equal(tool.body.source_pid, prompt.body.source_pid);
  });

  it("left a pre-fix tree (no recognized agent) without a cache, reproducing the bug", () => {
    const started = run("SessionStart", { CLAWD_CB_HARNESS_NAME: "unknown-runtime.exe" });
    assert.equal(started.body.agent_pid, undefined);
    assert.equal(pc.readPidCacheV2("codebuddy", sid, cwd), null);
    const prompt = run("UserPromptSubmit", { CLAWD_CB_HARNESS_NAME: "unknown-runtime.exe" });
    assert.equal(prompt.body.source_pid, null);
  });

  it("keeps the hook and the server-side Windows walk on the same agent names", () => {
    assert.ok(CODEBUDDY_AGENT_NAMES.win.has("agent-harness.exe"));
    assert.ok(CODEBUDDY_AGENT_NAMES.win.has("codebuddy.exe"));
    assert.deepEqual(
      [...getB1aAgentConfig("codebuddy").agentNames].sort(),
      [...CODEBUDDY_AGENT_NAMES.win].sort(),
    );
    assert.equal(CODEBUDDY_AGENT_NAMES.mac.has("agent-harness"), false, "POSIX resolution is unchanged");
  });
});

