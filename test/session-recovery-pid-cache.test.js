"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pidCache = require("../hooks/pid-cache");
const { buildStateBody } = require("../hooks/clawd-hook");
const { getAllAgents } = require("../agents/registry");
const {
  MAX_LEASE_AGE_MS,
  MAX_LEASE_FILES,
  TOMBSTONE_RETENTION_MS,
  getLeaseFilePath,
  readLeaseFile,
  updateRecoveryLeaseFromStateBody,
  pruneRecoveryLeaseFiles,
  loadActiveRecoveryLeases,
} = require("../hooks/session-recovery-lease");
const { loadSharedProcessWithMock } = require("./helpers/load-shared-process-with-mock");

describe("Windows recovery identity retention across PID cache hits", () => {
  const sessionId = "idle-recovery-cache-test";
  const cwd = "C:/recovery-cache-test";
  const startTicks = "639203668532454670";
  const identity = `win32:${startTicks}`;
  let fixtureDir;
  let recoveryDir;
  let sharedProcess;
  let cleanupMock;
  let snapshots;

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-pid-cache-test-"));
    recoveryDir = path.join(fixtureDir, "recovery");
    const cacheDir = path.join(fixtureDir, "cache");
    fs.mkdirSync(cacheDir);
    pidCache.__setCacheDirForTests(cacheDir);
    snapshots = 0;
    const loaded = loadSharedProcessWithMock({
      platform: "win32",
      env: { CLAWD_REMOTE: undefined, WSL_DISTRO_NAME: undefined },
      execFileSyncMock: () => {
        snapshots += 1;
        return JSON.stringify([{
          ProcessId: process.pid, ParentProcessId: 0, Name: "claude.exe",
          CommandLine: "claude.exe", StartIdentity: startTicks,
        }]);
      },
    });
    sharedProcess = loaded.mod;
    cleanupMock = loaded.cleanup;
  });

  afterEach(() => {
    cleanupMock();
    pidCache.__setCacheDirForTests(null);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  function body(event) {
    // A new resolver per event models the real hook's separate process.
    const resolve = sharedProcess.createPidResolver({
      startPid: process.pid,
      agentNames: { win: new Set(["claude.exe"]), mac: new Set(["claude"]) },
      platformConfig: sharedProcess.getPlatformConfig(),
      readRuntimeIdentity: () => ({ ok: true, ownerPid: process.pid, port: 23333 }),
      env: {},
    });
    return buildStateBody(event, { session_id: sessionId, cwd, tool_name: "Bash" }, resolve);
  }

  function seedIdle(event = "SessionStart") {
    const started = updateRecoveryLeaseFromStateBody(body("SessionStart"), {
      recoveryDir, eventAt: 1000,
    });
    assert.equal(started.written, true);
    assert.equal(started.record.processStartIdentity, identity);
    if (event === "Stop") {
      updateRecoveryLeaseFromStateBody(body("UserPromptSubmit"), { recoveryDir, eventAt: 1001 });
      updateRecoveryLeaseFromStateBody(body("Stop"), { recoveryDir, eventAt: 1002 });
    }
    const lease = readLeaseFile(getLeaseFilePath("claude-code", sessionId, { recoveryDir }));
    assert.equal(lease.active, false);
    return lease;
  }

  for (const event of ["SessionStart", "Stop"]) {
    for (const idleMs of [TOMBSTONE_RETENTION_MS + 1, MAX_LEASE_AGE_MS + 1]) {
      it(`restores the next task after ${event} remains idle for ${idleMs}ms`, () => {
        const idle = seedIdle(event);
        const now = idle.eventAt + idleMs;
        assert.deepEqual(loadActiveRecoveryLeases({ recoveryDir, now }), [],
          "retained inactive evidence must not create a live session");
        const retained = readLeaseFile(getLeaseFilePath("claude-code", sessionId, { recoveryDir }));
        assert.deepEqual(retained, idle, "keep identity evidence without refreshing or activating it");

        const prompt = body("UserPromptSubmit");
        assert.equal(prompt._agentProcessStartIdentity, undefined, "the v2 cache carries no private identity");
        assert.equal(updateRecoveryLeaseFromStateBody(prompt, { recoveryDir, eventAt: now + 1 }).written, true);
        assert.equal(updateRecoveryLeaseFromStateBody(body("PreToolUse"), {
          recoveryDir, eventAt: now + 2,
        }).written, true);

        const restored = loadActiveRecoveryLeases({
          recoveryDir, now: now + 3,
          getProcessStartIdentities: pids => new Map(pids.map(pid => [pid, identity])),
        });
        assert.equal(restored.length, 1);
        assert.equal(restored[0].sessionId, sessionId);
        assert.equal(restored[0].state, "working");
        assert.equal(snapshots, 1, "cache-hit hooks and retention must not spawn another snapshot");

        assert.deepEqual(loadActiveRecoveryLeases({
          recoveryDir, now: now + 4,
          getProcessStartIdentities: pids => new Map(pids.map(pid => [pid, "win32:639203668532454680"])),
        }), [], "a reused PID must still fail the startup identity check");
      });
    }
  }

  for (const cause of ["missing-cache", "different-agent-pid", "different-source-pid", "headless", "dead-pid", "missing-identity"]) {
    it(`prunes expired inactive evidence with ${cause}`, () => {
      const idle = seedIdle();
      const leasePath = getLeaseFilePath("claude-code", sessionId, { recoveryDir });
      const cache = pidCache.readPidCacheV2("claude-code", sessionId, cwd);
      const options = { now: idle.eventAt + TOMBSTONE_RETENTION_MS + 1 };
      if (cause === "missing-cache") pidCache.dropPidCacheV2("claude-code", sessionId, cwd);
      if (cause === "different-agent-pid") cache.agentPid += 1;
      if (cause === "different-source-pid") cache.stablePid += 1;
      if (cause === "headless") cache.headless = true;
      if (["different-agent-pid", "different-source-pid", "headless"].includes(cause)) {
        pidCache.writePidCacheV2("claude-code", sessionId, cwd, cache);
      }
      if (cause === "dead-pid") options.processKill = () => { const error = new Error("dead"); error.code = "ESRCH"; throw error; };
      if (cause === "missing-identity") fs.writeFileSync(leasePath, JSON.stringify({ ...idle, processStartIdentity: null }));
      pruneRecoveryLeaseFiles(recoveryDir, options);
      assert.equal(fs.existsSync(leasePath), false);
    });
  }

  it("rechecks cache lifetime while holding the record lock before deleting", t => {
    const idle = seedIdle();
    const leasePath = getLeaseFilePath("claude-code", sessionId, { recoveryDir });
    const cache = pidCache.readPidCacheV2("claude-code", sessionId, cwd);
    pidCache.dropPidCacheV2("claude-code", sessionId, cwd);
    const rename = fs.renameSync;
    let cacheReplaced = false;
    t.mock.method(fs, "renameSync", function(source, target) {
      if (target === `${leasePath}.lock`) {
        pidCache.writePidCacheV2("claude-code", sessionId, cwd, cache);
        cacheReplaced = true;
      }
      return rename.call(this, source, target);
    });
    pruneRecoveryLeaseFiles(recoveryDir, { now: idle.eventAt + TOMBSTONE_RETENTION_MS + 1 });
    assert.equal(cacheReplaced, true);
    assert.deepEqual(readLeaseFile(leasePath), idle);
  });

  it("evicts expendable tombstones before cached identity evidence while keeping the file budget", () => {
    const idle = seedIdle();
    const now = idle.eventAt + TOMBSTONE_RETENTION_MS + 1;
    for (let index = 0; index < MAX_LEASE_FILES; index++) {
      const id = `uncached-tombstone-${index}`;
      const file = getLeaseFilePath("claude-code", id, { recoveryDir });
      fs.writeFileSync(file, JSON.stringify({ ...idle, sessionId: id, eventAt: now + index }));
    }
    const remaining = pruneRecoveryLeaseFiles(recoveryDir, { now });
    assert.equal(remaining.length, MAX_LEASE_FILES);
    assert.deepEqual(readLeaseFile(getLeaseFilePath("claude-code", sessionId, { recoveryDir })), idle);
  });

  it("does not enable durable lease recovery for any other registered agent", () => {
    for (const agent of getAllAgents().filter(agent => agent.id !== "claude-code")) {
      const result = updateRecoveryLeaseFromStateBody({
        agent_id: agent.id, session_id: "other-agent", event: "UserPromptSubmit",
        state: "thinking", agent_pid: process.pid, source_pid: process.pid, cwd,
      }, { recoveryDir, eventAt: 1000 });
      assert.equal(result.reason, "unsupported", agent.id);
    }
  });
});
