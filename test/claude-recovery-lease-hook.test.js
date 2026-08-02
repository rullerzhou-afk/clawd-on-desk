"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSpawnedHookHarness } = require("./helpers/spawned-hook");
const {
  getLeaseFilePath,
  readLeaseFile,
  updateRecoveryLeaseFromStateBody,
} = require("../hooks/session-recovery-lease");

const HOOK = path.join(__dirname, "..", "hooks", "clawd-hook.js");

describe("Claude hook recovery lease ordering", () => {
  let home;
  let recoveryDir;
  let hookHarness;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-hook-recovery-"));
    hookHarness = createSpawnedHookHarness({ home });
    recoveryDir = path.join(home, ".clawd", "session-recovery-v1");
    updateRecoveryLeaseFromStateBody({
      agent_id: "claude-code",
      session_id: "offline-session",
      event: "SessionStart",
      state: "idle",
      agent_pid: process.pid,
      source_pid: process.pid,
      cwd: "C:/work/project",
    }, {
      recoveryDir,
      eventAt: 1000,
      platform: "win32",
      getProcessStartIdentities: (pids) => new Map(
        pids.filter(Boolean).map((pid) => [pid, `win32:test-${pid}`]),
      ),
    });
  });

  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function run(event, payload = {}) {
    return hookHarness.run({
      script: HOOK,
      args: [event],
      payload: { session_id: "offline-session", cwd: "C:/work/project", ...payload },
      httpContract: "expect-attempt",
    });
  }

  it("updates the lease even when the Clawd HTTP receiver is offline", () => {
    const result = run("PreToolUse", { tool_name: "Bash" });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(result.stderr, "");
    const lease = readLeaseFile(getLeaseFilePath("claude-code", "offline-session", { recoveryDir }));
    assert.strictEqual(lease.active, true);
    assert.strictEqual(lease.state, "working");
  });

  it("writes the terminal tombstone before an offline Stop POST fails", () => {
    run("PreToolUse", { tool_name: "Bash" });
    const result = run("Stop");
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(result.stderr, "");
    const lease = readLeaseFile(getLeaseFilePath("claude-code", "offline-session", { recoveryDir }));
    assert.strictEqual(lease.active, false);
    assert.strictEqual(lease.state, null);
  });
});
