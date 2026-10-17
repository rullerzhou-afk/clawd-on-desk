"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createSpawnedHookHarness } = require("./helpers/spawned-hook");
const pc = require("../hooks/pid-cache");

describe("#634 WorkBuddy cross-process PID cache", () => {
  let harness;
  let temp;
  let snapshotFile;
  const cwd = "D:/workbuddy-project";
  const sid = "workbuddy-session";

  beforeEach(() => {
    harness = createSpawnedHookHarness({ prefix: "clawd-workbuddy-cache-" });
    temp = path.join(harness.home, "tmp");
    fs.mkdirSync(temp);
    snapshotFile = path.join(harness.home, "snapshots.jsonl");
    pc.__setCacheDirForTests(temp);
  });
  afterEach(() => {
    pc.__setCacheDirForTests(null);
    harness.cleanup();
  });

  function seed(sessionId = sid, cacheCwd = cwd, namespace = "workbuddy", editor = "seeded") {
    assert.equal(pc.writePidCacheV2(namespace, sessionId, cacheCwd, {
      stablePid: process.pid, agentPid: process.pid, headless: false, detectedEditor: editor,
    }), true);
    return pc.cacheFilePathV2(namespace, sessionId, cacheCwd);
  }

  function run(event, payload = {}, env = {}, httpContract = "expect-attempt") {
    fs.writeFileSync(snapshotFile, "");
    const result = harness.run({
      script: path.join(__dirname, "..", "hooks", "workbuddy-hook.js"),
      payload: { hook_event_name: event, session_id: sid, cwd, ...payload },
      runtimeJson: { app: "clawd-on-desk", port: 23333, ownerPid: process.pid },
      preloads: [path.join(__dirname, "helpers", "workbuddy-pid-cache-probe.js")],
      httpContract,
      env: { TEMP: temp, TMP: temp, CLAWD_WB_SNAPSHOTS: snapshotFile, CLAWD_POST_RECORDER_SUCCEED: "1", ...env },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "{}\n", "state-only stdout stays exactly one empty object");
    assert.equal(result.stderr, "");
    const snapshots = fs.readFileSync(snapshotFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const posts = result.attempts.filter((entry) => entry.kind === "request");
    assert.equal(posts.length, httpContract === "expect-none" ? 0 : 1);
    return { snapshots, body: posts.length ? JSON.parse(posts[0].body) : null };
  }

  it("refreshes once at start, reuses the cache across fresh hook processes, and keeps Stop until end", () => {
    seed();
    const started = run("SessionStart");
    assert.deepEqual(started.snapshots, [{ timeout: 5000 }]);
    assert.equal(started.body.preserve_state, true);
    assert.equal(started.body.agent_pid, process.pid);
    const cacheFile = pc.cacheFilePathV2("workbuddy", sid, cwd);
    assert.equal(pc.readPidCacheV2("workbuddy", sid, cwd).detectedEditor, "workbuddy");

    for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "PreCompact", "Stop"]) {
      const result = run(event);
      assert.deepEqual(result.snapshots, [], event);
      assert.equal(result.body.source_pid, process.pid, event);
      assert.equal(result.body.agent_pid, process.pid, event);
      assert.equal(result.body.editor, "workbuddy", event);
      assert.equal(result.body.agent_id, "workbuddy");
      assert.equal(result.body.session_id, sid);
      assert.ok(fs.existsSync(cacheFile), `${event} must retain the session cache`);
    }
    const other = seed("another-session");
    const ended = run("SessionEnd");
    assert.deepEqual(ended.snapshots, []);
    assert.equal(ended.body.agent_pid, process.pid);
    assert.equal(fs.existsSync(cacheFile), false);
    assert.equal(fs.existsSync(other), true, "only the ending session is removed");
    assert.deepEqual(run("SessionEnd").snapshots, [], "end misses never spawn");
  });

  it("allows WorkBuddy's prompt-before-start order without spawning on the first prompt", () => {
    const prompt = run("UserPromptSubmit");
    assert.deepEqual(prompt.snapshots, []);
    assert.equal(prompt.body.source_pid, null);
    assert.equal(prompt.body.agent_pid, undefined);
    assert.equal(run("SessionStart").snapshots.length, 1);
    assert.deepEqual(run("PreToolUse").snapshots, []);
  });

  for (const [label, otherSid, otherCwd, namespace] of [
    ["session", "another-session", cwd, "workbuddy"],
    ["cwd", sid, "D:/another-project", "workbuddy"],
    ["agent namespace", sid, cwd, "codebuddy"],
  ]) {
    it(`never reuses another ${label}'s entry; a tool-event miss populates its own cache`, () => {
      const other = seed(otherSid, otherCwd, namespace);
      const before = fs.readFileSync(other, "utf8");
      const result = run("PreToolUse");
      assert.equal(result.snapshots.length, 1);
      assert.equal(result.body.editor, "workbuddy");
      assert.equal(fs.readFileSync(other, "utf8"), before);
      assert.deepEqual(run("PostToolUse").snapshots, []);
    });
  }

  for (const payload of [{ session_id: "default" }, { session_id: " default " }, { cwd: "" }, { cwd: "  " }, { cwd: null }, { cwd: { path: cwd } }]) {
    it(`does not cache ambiguous identity ${JSON.stringify(payload)}`, () => {
      const defaultFile = seed("default");
      const before = fs.readFileSync(defaultFile, "utf8");
      assert.deepEqual(run("UserPromptSubmit", payload).snapshots, []);
      assert.equal(run("PreToolUse", payload).snapshots.length, 1);
      assert.equal(run("PostToolUse", payload).snapshots.length, 1, "non-cacheable events keep fresh fallback");
      assert.deepEqual(run("SessionEnd", payload).snapshots, []);
      assert.equal(fs.readFileSync(defaultFile, "utf8"), before);
      assert.equal(pc.readPidCacheV2("workbuddy", sid, cwd), null);
    });
  }

  it("uses the same trimmed session identity for the body and cache key", () => {
    seed();
    const result = run("PreToolUse", { session_id: ` ${sid} ` });
    assert.deepEqual(result.snapshots, []);
    assert.equal(result.body.session_id, sid);
    assert.equal(result.body.editor, "seeded");
  });

  it("rejects either dead cached PID and repairs it on the next ordinary event", () => {
    for (const field of ["stablePid", "agentPid"]) {
      assert.equal(pc.writePidCacheV2("workbuddy", sid, cwd, {
        stablePid: process.pid, agentPid: process.pid, headless: false, detectedEditor: "stale",
        [field]: 2147483647,
      }), true);
      const prompt = run("UserPromptSubmit");
      assert.deepEqual(prompt.snapshots, []);
      assert.equal(prompt.body.agent_pid, undefined, `${field} must be live`);
      const event = run("PreToolUse");
      assert.equal(event.snapshots.length, 1);
      assert.equal(event.body.editor, "workbuddy");
      assert.equal(pc.readPidCacheV2("workbuddy", sid, cwd)[field], process.pid);
    }
  });

  it("recovers a corrupt cache on an event without making prompt/end perform snapshots", () => {
    const cacheFile = seed();
    fs.writeFileSync(cacheFile, "{broken");
    assert.deepEqual(run("UserPromptSubmit").snapshots, []);
    assert.equal(run("PostToolUse").snapshots.length, 1);
    assert.equal(pc.readPidCacheV2("workbuddy", sid, cwd).detectedEditor, "workbuddy");
    fs.writeFileSync(cacheFile, "{broken");
    assert.deepEqual(run("SessionEnd").snapshots, []);
    assert.equal(fs.existsSync(cacheFile), false);
  });

  it("rejects missing IDs and lifecycle chatter before either cache resolution or POST", () => {
    for (const session_id of [null, "", "   "]) {
      assert.deepEqual(run("PreToolUse", { session_id }, {}, "expect-none").snapshots, []);
    }
    for (const notification_type of ["idle_prompt", "auth_success"]) {
      assert.deepEqual(run("Notification", { notification_type }, {}, "expect-none").snapshots, []);
    }
  });

  it("does not consult or remove local cache entries in remote mode", () => {
    const cacheFile = seed();
    const before = fs.readFileSync(cacheFile, "utf8");
    for (const event of ["SessionStart", "PreToolUse", "SessionEnd"]) {
      const result = run(event, {}, { CLAWD_REMOTE: "1" });
      assert.deepEqual(result.snapshots, []);
      assert.equal(result.body.source_pid, undefined);
      assert.equal(result.body.agent_pid, undefined);
      assert.equal(fs.readFileSync(cacheFile, "utf8"), before);
    }
  });
});
