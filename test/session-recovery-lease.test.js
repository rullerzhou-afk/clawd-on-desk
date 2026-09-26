"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  LEASE_FILE_PREFIX,
  MAX_LEASE_FILES,
  TOMBSTONE_RETENTION_MS,
  getLeaseFilePath,
  readLeaseFile,
  updateRecoveryLeaseFromStateBody,
  pruneRecoveryLeaseFiles,
  cleanupOrphanedLeaseLocks,
  loadActiveRecoveryLeases,
} = require("../hooks/session-recovery-lease");
const { restoreSessionsFromRecoveryLeases } = require("../src/session-recovery-loader");

describe("durable session recovery leases", () => {
  let recoveryDir;

  beforeEach(() => {
    recoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-recovery-lease-"));
  });

  afterEach(() => {
    fs.rmSync(recoveryDir, { recursive: true, force: true });
  });

  function body(overrides = {}) {
    return {
      agent_id: "claude-code",
      session_id: "real-session-1",
      event: "UserPromptSubmit",
      state: "thinking",
      agent_pid: process.pid,
      source_pid: process.pid,
      cwd: "C:/work/project",
      session_title: "Fix startup recovery",
      ...overrides,
    };
  }

  function winOptions(eventAt, extra = {}) {
    return {
      recoveryDir,
      eventAt,
      platform: "win32",
      getProcessStartIdentities: (pids) => new Map(
        pids.filter(Boolean).map((pid) => [pid, `win32:test-${pid}`]),
      ),
      ...extra,
    };
  }

  function writeLeaseRecord(sessionId, overrides = {}) {
    const record = {
      version: 1,
      agentId: "claude-code",
      sessionId,
      active: true,
      state: "thinking",
      eventAt: 1000,
      validUntil: null,
      pid: process.pid,
      sourcePid: process.pid,
      processStartIdentity: "linux:test-process",
      sourceProcessStartIdentity: "linux:test-process",
      cwd: "C:/work/project",
      title: "Recovery test",
      ...overrides,
    };
    const filePath = getLeaseFilePath("claude-code", sessionId, { recoveryDir });
    fs.writeFileSync(filePath, JSON.stringify(record));
    return filePath;
  }

  it("uses a hashed per-session filename and writes only the recovery schema", () => {
    const result = updateRecoveryLeaseFromStateBody(body({
      prompt: "secret prompt",
      tool_input: { command: "secret command" },
      assistant_last_output: "secret model output",
      permission_payload: { token: "secret" },
    }), winOptions(1000));
    assert.strictEqual(result.written, true);
    assert.ok(!path.basename(result.filePath).includes("real-session-1"));
    assert.deepStrictEqual(Object.keys(result.record).sort(), [
      "active", "agentId", "cwd", "eventAt", "pid", "processStartIdentity",
      "sessionId", "sourcePid", "sourceProcessStartIdentity", "state", "title",
      "validUntil", "version",
    ].sort());
    const serialized = fs.readFileSync(result.filePath, "utf8");
    assert.ok(!serialized.includes("secret prompt"));
    assert.ok(!serialized.includes("secret command"));
    assert.ok(!serialized.includes("secret model output"));
    assert.ok(!serialized.includes("permission_payload"));
  });

  it("keeps transient events from overwriting the last sustained state", () => {
    updateRecoveryLeaseFromStateBody(body(), winOptions(1000));
    const transient = updateRecoveryLeaseFromStateBody(body({
      event: "Notification",
      state: "notification",
    }), winOptions(2000));
    assert.strictEqual(transient.written, false);
    const lease = readLeaseFile(getLeaseFilePath("claude-code", "real-session-1", { recoveryDir }));
    assert.strictEqual(lease.state, "thinking");
    assert.strictEqual(lease.eventAt, 1000);
  });

  it("writes inactive tombstones for confirmed Stop and SessionEnd", () => {
    updateRecoveryLeaseFromStateBody(body(), winOptions(1000));
    updateRecoveryLeaseFromStateBody(body({ event: "Stop", state: "attention" }), winOptions(2000));
    let lease = readLeaseFile(getLeaseFilePath("claude-code", "real-session-1", { recoveryDir }));
    assert.strictEqual(lease.active, false);
    assert.strictEqual(lease.state, null);
    updateRecoveryLeaseFromStateBody(body({ event: "SessionEnd", state: "sleeping" }), winOptions(3000));
    lease = readLeaseFile(getLeaseFilePath("claude-code", "real-session-1", { recoveryDir }));
    assert.strictEqual(lease.active, false);
    assert.strictEqual(lease.eventAt, 3000.5);
  });

  it("shares the Claude Stop gate and distinguishes hold, debounce, and complete", () => {
    const held = updateRecoveryLeaseFromStateBody(body({
      event: "Stop", state: "attention", stop_hook_active: true,
    }), winOptions(1000));
    assert.strictEqual(held.record.active, true);
    assert.strictEqual(held.record.state, "working");
    assert.strictEqual(held.record.validUntil, null);

    const debounce = updateRecoveryLeaseFromStateBody(body({
      event: "Stop",
      state: "attention",
      background_tasks_count: 1,
      assistant_last_output: "finished",
    }), winOptions(2000));
    assert.strictEqual(debounce.record.active, true);
    assert.strictEqual(debounce.record.validUntil, 4000);

    const complete = updateRecoveryLeaseFromStateBody(body({
      event: "Stop", state: "attention",
    }), winOptions(5000));
    assert.strictEqual(complete.record.active, false);
    assert.strictEqual(complete.record.validUntil, null);
  });

  it("keeps a completed turn inactive when Claude sends a trailing SubagentStop (#1060)", () => {
    const filePath = getLeaseFilePath("claude-code", "real-session-1", { recoveryDir });
    updateRecoveryLeaseFromStateBody(body(), winOptions(1000));
    updateRecoveryLeaseFromStateBody(body({ event: "Stop", state: "attention" }), winOptions(2000));
    const bytesBefore = fs.readFileSync(filePath);

    const trailing = updateRecoveryLeaseFromStateBody(body({
      event: "SubagentStop",
      state: "working",
      subagent_lifecycle_source: "native",
    }), winOptions(4000));
    assert.deepStrictEqual(trailing, { written: false, reason: "no-active-evidence" });
    assert.deepStrictEqual(fs.readFileSync(filePath), bytesBefore);
    assert.strictEqual(readLeaseFile(filePath).active, false);
  });

  it("never creates a lease or recovery directory from a SubagentStop alone (#1060)", () => {
    const missingDir = path.join(recoveryDir, "must-not-be-created");
    const result = updateRecoveryLeaseFromStateBody(body({
      event: "SubagentStop",
      state: "working",
    }), winOptions(1000, { recoveryDir: missingDir }));
    assert.deepStrictEqual(result, { written: false, reason: "no-active-evidence" });
    assert.strictEqual(fs.existsSync(missingDir), false);
  });

  it("still settles juggling to working when a subagent stops mid-turn (#1060)", () => {
    updateRecoveryLeaseFromStateBody(body({ event: "SubagentStart", state: "juggling" }), winOptions(1000));
    const settled = updateRecoveryLeaseFromStateBody(body({
      event: "SubagentStop",
      state: "working",
    }), winOptions(2000));
    assert.strictEqual(settled.written, true);
    assert.strictEqual(settled.record.active, true);
    assert.strictEqual(settled.record.state, "working");
    assert.strictEqual(settled.record.eventAt, 2000);
    assert.strictEqual(settled.record.validUntil, null);
  });

  it("does not turn a provisional debounce lease into a durable one on SubagentStop (#1060)", () => {
    const provisional = updateRecoveryLeaseFromStateBody(body({
      event: "Stop",
      state: "attention",
      background_tasks_count: 1,
      assistant_last_output: "parent finished",
    }), winOptions(1000));
    assert.strictEqual(provisional.record.validUntil, 3000);
    const bytesBefore = fs.readFileSync(provisional.filePath);

    const trailing = updateRecoveryLeaseFromStateBody(body({
      event: "SubagentStop",
      state: "working",
    }), winOptions(1500));
    assert.deepStrictEqual(trailing, { written: false, reason: "no-active-evidence" });
    assert.deepStrictEqual(fs.readFileSync(provisional.filePath), bytesBefore);
  });

  it("does not create or refresh a durable lease when typed subagents alone upgrade Stop to hold (#952)", () => {
    const filePath = getLeaseFilePath("claude-code", "real-session-1", { recoveryDir });
    const withoutExisting = updateRecoveryLeaseFromStateBody(body({
      event: "Stop",
      state: "attention",
      background_tasks_count: 1,
      background_subagents_count: 1,
      assistant_last_output: "parent finished",
    }), winOptions(1000));
    assert.deepStrictEqual(withoutExisting, {
      written: false,
      reason: "no-existing-evidence",
    });
    assert.strictEqual(fs.existsSync(filePath), false);

    updateRecoveryLeaseFromStateBody(body({ state: "working" }), winOptions(2000));
    const bytesBefore = fs.readFileSync(filePath);
    const mtimeBefore = fs.statSync(filePath).mtimeMs;
    const preserved = updateRecoveryLeaseFromStateBody(body({
      event: "Stop",
      state: "attention",
      background_tasks_count: 1,
      background_subagents_count: 1,
      assistant_last_output: "parent finished",
    }), winOptions(3000));
    assert.strictEqual(preserved.written, false);
    assert.strictEqual(preserved.reason, "preserved-existing-evidence");
    assert.deepStrictEqual(fs.readFileSync(filePath), bytesBefore);
    assert.strictEqual(fs.statSync(filePath).mtimeMs, mtimeBefore);
    assert.strictEqual(readLeaseFile(filePath).eventAt, 2000);

    const completed = updateRecoveryLeaseFromStateBody(body({
      event: "Stop",
      state: "attention",
      background_tasks_count: 0,
      background_subagents_count: 0,
      assistant_last_output: "actually finished",
    }), winOptions(4000));
    assert.strictEqual(completed.written, true);
    assert.strictEqual(completed.record.active, false);
  });

  it("preserves a provisional lease byte-for-byte and never creates a recovery directory for typed-only evidence (#952)", () => {
    const provisional = updateRecoveryLeaseFromStateBody(body({
      event: "Stop",
      state: "attention",
      background_tasks_count: 1,
      assistant_last_output: "parent finished",
    }), winOptions(1000));
    assert.strictEqual(provisional.record.validUntil, 3000);
    const filePath = provisional.filePath;
    const bytesBefore = fs.readFileSync(filePath);

    const preserved = updateRecoveryLeaseFromStateBody(body({
      event: "Stop",
      state: "attention",
      background_tasks_count: 1,
      background_subagents_count: 1,
      assistant_last_output: "parent finished",
    }), winOptions(1500));
    assert.strictEqual(preserved.reason, "preserved-existing-evidence");
    assert.deepStrictEqual(fs.readFileSync(filePath), bytesBefore);
    assert.strictEqual(readLeaseFile(filePath).validUntil, 3000);

    const missingDir = path.join(recoveryDir, "must-not-be-created");
    const missing = updateRecoveryLeaseFromStateBody(body({
      session_id: "typed-without-directory",
      event: "Stop",
      state: "attention",
      background_subagents_count: 1,
      assistant_last_output: "parent finished",
    }), winOptions(2000, { recoveryDir: missingDir }));
    assert.strictEqual(missing.reason, "no-existing-evidence");
    assert.strictEqual(fs.existsSync(missingDir), false);
  });

  it("leaves an inactive tombstone untouched when typed-only evidence arrives late (#952)", () => {
    const completed = updateRecoveryLeaseFromStateBody(body({
      event: "Stop",
      state: "attention",
    }), winOptions(1000));
    const bytesBefore = fs.readFileSync(completed.filePath);
    const lateTyped = updateRecoveryLeaseFromStateBody(body({
      event: "Stop",
      state: "attention",
      background_subagents_count: 1,
      assistant_last_output: "late parent output",
    }), winOptions(2000));
    assert.strictEqual(lateTyped.reason, "no-active-evidence");
    assert.deepStrictEqual(fs.readFileSync(completed.filePath), bytesBefore);
  });

  it("keeps ordinary durable hold behavior when another Stop signal is independently hard-live (#952)", () => {
    const cases = [
      {
        background_tasks_count: 1,
        background_subagents_count: 1,
      },
      {
        background_subagents_count: 1,
        assistant_last_output: "parent finished",
        session_crons_count: 1,
      },
      {
        background_subagents_count: 1,
        assistant_last_output: "parent finished",
        stop_hook_active: true,
      },
    ];
    cases.forEach((fields, index) => {
      const held = updateRecoveryLeaseFromStateBody(body({
        session_id: `durable-hold-${index}`,
        event: "Stop",
        state: "attention",
        ...fields,
      }), winOptions(1000 + index));
      assert.strictEqual(held.written, true);
      assert.strictEqual(held.record.active, true);
      assert.strictEqual(held.record.state, "working");
      assert.strictEqual(held.record.validUntil, null);
    });
  });

  it("prevents a late older hook from resurrecting a terminal tombstone", () => {
    updateRecoveryLeaseFromStateBody(body({ event: "Stop", state: "attention" }), winOptions(2000));
    const late = updateRecoveryLeaseFromStateBody(body(), winOptions(1000));
    assert.strictEqual(late.written, false);
    assert.strictEqual(late.reason, "older-event");
    const lease = readLeaseFile(getLeaseFilePath("claude-code", "real-session-1", { recoveryDir }));
    assert.strictEqual(lease.active, false);
  });

  it("allows a same-millisecond SessionStart to transition to active", () => {
    const started = updateRecoveryLeaseFromStateBody(body({
      event: "SessionStart",
      state: "sleeping",
    }), winOptions(1000));
    assert.strictEqual(started.record.active, false);
    assert.strictEqual(started.record.eventAt, 1000);

    const active = updateRecoveryLeaseFromStateBody(body(), winOptions(1000));
    assert.strictEqual(active.written, true);
    assert.strictEqual(active.record.active, true);
    assert.strictEqual(active.record.state, "thinking");
    assert.strictEqual(active.record.eventAt, 1000);
  });

  it("does not resurrect an active session after a same-millisecond terminal event", () => {
    updateRecoveryLeaseFromStateBody(body(), winOptions(1000));
    const terminal = updateRecoveryLeaseFromStateBody(body({
      event: "Stop",
      state: "attention",
    }), winOptions(1000));
    assert.strictEqual(terminal.record.active, false);
    assert.strictEqual(terminal.record.eventAt, 1000.5);

    const lateActive = updateRecoveryLeaseFromStateBody(body({ state: "working" }), winOptions(1000));
    assert.strictEqual(lateActive.written, false);
    assert.strictEqual(lateActive.reason, "older-event");
    assert.strictEqual(
      readLeaseFile(getLeaseFilePath("claude-code", "real-session-1", { recoveryDir })).active,
      false,
    );
  });

  it("prunes more than 100 tombstones without deleting an active lease", () => {
    const activeSessionId = "active-session";
    updateRecoveryLeaseFromStateBody(body({ session_id: activeSessionId }), winOptions(1000));
    for (let index = 0; index < MAX_LEASE_FILES + 5; index++) {
      const result = updateRecoveryLeaseFromStateBody(body({
        session_id: `finished-session-${index}`,
        event: "Stop",
        state: "attention",
      }), winOptions(2000 + index));
      assert.strictEqual(result.written, true);
    }

    const activePath = getLeaseFilePath("claude-code", activeSessionId, { recoveryDir });
    const active = readLeaseFile(activePath);
    assert.ok(active);
    assert.strictEqual(active.active, true);
    const leaseNames = fs.readdirSync(recoveryDir).filter(
      (name) => name.startsWith(LEASE_FILE_PREFIX) && name.endsWith(".json"),
    );
    assert.strictEqual(leaseNames.length, MAX_LEASE_FILES);
  });

  it("cleans only orphan locks whose owner process is dead", () => {
    const now = Date.now();
    const deadLock = `${getLeaseFilePath("claude-code", "dead-lock", { recoveryDir })}.lock`;
    const liveLock = `${getLeaseFilePath("claude-code", "live-lock", { recoveryDir })}.lock`;
    fs.mkdirSync(deadLock);
    fs.writeFileSync(path.join(deadLock, "owner"), `111111-${now}-dead`);
    fs.mkdirSync(liveLock);
    fs.writeFileSync(path.join(liveLock, "owner"), `222222-${now}-1a2b`);

    cleanupOrphanedLeaseLocks(recoveryDir, {
      now,
      processKill: (pid) => {
        if (pid === 111111) {
          const error = new Error("dead");
          error.code = "ESRCH";
          throw error;
        }
        assert.strictEqual(pid, 222222);
      },
    });

    assert.strictEqual(fs.existsSync(deadLock), false);
    assert.strictEqual(fs.existsSync(liveLock), true);
  });

  it("cleans ownerless and malformed locks while preserving a live owner", () => {
    const now = Date.now();
    const ownerlessLock = `${getLeaseFilePath("claude-code", "ownerless-lock", { recoveryDir })}.lock`;
    const malformedLock = `${getLeaseFilePath("claude-code", "malformed-lock", { recoveryDir })}.lock`;
    const liveLock = `${getLeaseFilePath("claude-code", "current-owner-lock", { recoveryDir })}.lock`;
    fs.mkdirSync(ownerlessLock);
    fs.mkdirSync(malformedLock);
    fs.writeFileSync(path.join(malformedLock, "owner"), "not-a-valid-owner-token");
    fs.mkdirSync(liveLock);
    fs.writeFileSync(path.join(liveLock, "owner"), `${process.pid}-${now}-1a2b`);

    cleanupOrphanedLeaseLocks(recoveryDir, {
      now,
      processKill: (pid) => assert.strictEqual(pid, process.pid),
    });

    assert.strictEqual(fs.existsSync(ownerlessLock), false);
    assert.strictEqual(fs.existsSync(malformedLock), false);
    assert.strictEqual(fs.existsSync(liveLock), true);
  });

  it("preserves an aged lock while its owner process is still alive", () => {
    const agedLiveLock = `${getLeaseFilePath("claude-code", "aged-live-lock", { recoveryDir })}.lock`;
    fs.mkdirSync(agedLiveLock);
    fs.writeFileSync(path.join(agedLiveLock, "owner"), `${process.pid}-1-acde`);

    cleanupOrphanedLeaseLocks(recoveryDir, {
      now: Date.now(),
      processKill: (pid) => assert.strictEqual(pid, process.pid),
    });

    assert.strictEqual(fs.existsSync(agedLiveLock), true);
  });

  it("fails closed when a Windows writer has no process start identity", () => {
    const result = updateRecoveryLeaseFromStateBody(body(), {
      recoveryDir,
      eventAt: 1000,
      platform: "win32",
    });
    assert.strictEqual(result.written, false);
    assert.strictEqual(result.reason, "missing-start-identity");
    assert.strictEqual(
      fs.existsSync(getLeaseFilePath("claude-code", "real-session-1", { recoveryDir })),
      false,
    );
  });

  it("fails closed when a POSIX writer or loader has no process start identity", () => {
    const writeResult = updateRecoveryLeaseFromStateBody(body(), {
      recoveryDir,
      eventAt: 1000,
      platform: "linux",
      getProcessStartIdentities: () => new Map(),
    });
    assert.strictEqual(writeResult.written, false);
    assert.strictEqual(writeResult.reason, "missing-start-identity");

    writeLeaseRecord("posix-missing-identity", {
      processStartIdentity: null,
      sourceProcessStartIdentity: null,
    });
    const loaded = loadActiveRecoveryLeases({
      recoveryDir,
      now: 2000,
      platform: "linux",
      processKill: () => true,
      isAgentEnabled: () => true,
      getProcessStartIdentities: () => new Map(),
    });
    assert.deepStrictEqual(loaded, []);
  });

  it("replaces a stored process identity when a newer hook reports the same PID", () => {
    const first = body({
      _agentProcessStartIdentity: "win32:old",
      _sourceProcessStartIdentity: "win32:old",
    });
    const second = body({
      state: "working",
      _agentProcessStartIdentity: "win32:new",
      _sourceProcessStartIdentity: "win32:new",
    });
    assert.strictEqual(updateRecoveryLeaseFromStateBody(first, {
      recoveryDir,
      eventAt: 1000,
      platform: "win32",
    }).written, true);

    const updated = updateRecoveryLeaseFromStateBody(second, {
      recoveryDir,
      eventAt: 2000,
      platform: "win32",
    });
    assert.strictEqual(updated.written, true);
    assert.strictEqual(updated.record.processStartIdentity, "win32:new");
    assert.strictEqual(updated.record.sourceProcessStartIdentity, "win32:new");
  });

  it("matches Windows loader identities at the CIM writer's microsecond precision", () => {
    const writerTicks = "639203668532454670";
    const loaderTicks = "639203668532454671";
    writeLeaseRecord("windows-precision", {
      processStartIdentity: `win32:${writerTicks}`,
      sourceProcessStartIdentity: `win32:${writerTicks}`,
    });
    const common = {
      recoveryDir,
      now: 2000,
      platform: "win32",
      processKill: () => true,
      isAgentEnabled: () => true,
    };

    const loaded = loadActiveRecoveryLeases({
      ...common,
      execFileSync: () => JSON.stringify({ pid: process.pid, start: loaderTicks }),
    });
    assert.deepStrictEqual(loaded.map((lease) => lease.sessionId), ["windows-precision"]);

    const reused = loadActiveRecoveryLeases({
      ...common,
      execFileSync: () => JSON.stringify({ pid: process.pid, start: "639203668532454680" }),
    });
    assert.deepStrictEqual(reused, []);
  });

  it("does not let more than 100 invalid active leases hide one valid lease", () => {
    const now = 25 * 60 * 60 * 1000 + 2000;
    for (let index = 0; index < MAX_LEASE_FILES + 1; index++) {
      const deadPid = 900000 + index;
      writeLeaseRecord(`expired-dead-${index}`, {
        pid: deadPid,
        sourcePid: deadPid,
        processStartIdentity: `linux:dead-${deadPid}`,
        sourceProcessStartIdentity: `linux:dead-${deadPid}`,
      });
    }
    writeLeaseRecord("new-valid-session", {
      eventAt: now - 1000,
      processStartIdentity: "linux:live",
      sourceProcessStartIdentity: "linux:live",
    });

    const loaded = loadActiveRecoveryLeases({
      recoveryDir,
      now,
      platform: "linux",
      isAgentEnabled: () => true,
      processKill: (pid) => {
        if (pid === process.pid) return true;
        const error = new Error("dead");
        error.code = "ESRCH";
        throw error;
      },
      getProcessStartIdentities: (pids) => new Map(
        pids.filter((pid) => pid === process.pid).map((pid) => [pid, "linux:live"]),
      ),
    });
    assert.deepStrictEqual(loaded.map((lease) => lease.sessionId), ["new-valid-session"]);
  });

  it("does not re-enter its own lease lock while pruning from a writer", () => {
    for (let index = 0; index < MAX_LEASE_FILES; index++) {
      writeLeaseRecord(`active-capacity-${index}`, {
        eventAt: 2000 + index,
        pid: 800000 + index,
        sourcePid: 800000 + index,
        processStartIdentity: `linux:active-${index}`,
        sourceProcessStartIdentity: `linux:active-${index}`,
      });
    }
    const writerPath = getLeaseFilePath("claude-code", "writer-tombstone", { recoveryDir });
    const writerLockPath = `${writerPath}.lock`;
    const originalRenameSync = fs.renameSync;
    let writerLockPublishes = 0;
    fs.renameSync = function observedRenameSync(source, target) {
      if (target === writerLockPath) {
        assert.strictEqual(fs.existsSync(writerLockPath), false);
        assert.strictEqual(fs.existsSync(path.join(source, "owner")), true);
      }
      const renamed = originalRenameSync.call(fs, source, target);
      if (target === writerLockPath) {
        writerLockPublishes++;
        assert.strictEqual(fs.existsSync(path.join(writerLockPath, "owner")), true);
      }
      return renamed;
    };
    let result;
    try {
      result = updateRecoveryLeaseFromStateBody(body({
        session_id: "writer-tombstone",
        event: "Stop",
        state: "attention",
      }), winOptions(1000));
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.strictEqual(result.written, true);
    assert.strictEqual(writerLockPublishes, 1);
  });

  it("does not prune a lease concurrently updated from tombstone to active", () => {
    const filePath = getLeaseFilePath("claude-code", "real-session-1", { recoveryDir });
    updateRecoveryLeaseFromStateBody(body({
      event: "Stop",
      state: "attention",
    }), winOptions(1000));
    const tombstone = readLeaseFile(filePath);
    assert.strictEqual(tombstone.active, false);

    const originalRenameSync = fs.renameSync;
    let promoted = false;
    fs.renameSync = function patchedRenameSync(source, target) {
      if (!promoted && target === `${filePath}.lock`) {
        promoted = true;
        fs.writeFileSync(filePath, JSON.stringify({
          ...tombstone,
          active: true,
          state: "working",
          eventAt: 2000,
        }));
      }
      return originalRenameSync.call(fs, source, target);
    };
    try {
      pruneRecoveryLeaseFiles(recoveryDir, { now: 1000 + TOMBSTONE_RETENTION_MS + 1 });
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.strictEqual(promoted, true);
    const current = readLeaseFile(filePath);
    assert.ok(current);
    assert.strictEqual(current.active, true);
    assert.strictEqual(current.state, "working");
  });

  it("rejects default ids and remote or WSL filesystems", () => {
    assert.strictEqual(updateRecoveryLeaseFromStateBody(body({ session_id: "default" }), {
      recoveryDir,
    }).written, false);
    assert.strictEqual(updateRecoveryLeaseFromStateBody(body(), {
      recoveryDir, remote: true,
    }).reason, "remote-filesystem");
    assert.strictEqual(updateRecoveryLeaseFromStateBody(body({ wsl_distro: "Ubuntu" }), {
      recoveryDir,
    }).reason, "remote-filesystem");
  });

  it("fails closed for disabled, stale, dead, reused, malformed, and expired leases", () => {
    updateRecoveryLeaseFromStateBody(body(), {
      recoveryDir, eventAt: 1000, platform: "linux",
      getProcessStartIdentities: (pids) => new Map(
        pids.filter(Boolean).map((pid) => [pid, "linux:original"]),
      ),
    });
    const file = getLeaseFilePath("claude-code", "real-session-1", { recoveryDir });
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.processStartIdentity = "linux:original";
    raw.sourceProcessStartIdentity = "linux:original";
    fs.writeFileSync(file, JSON.stringify(raw));

    const common = { recoveryDir, now: 2000, processKill: () => true, platform: "linux" };
    assert.deepStrictEqual(loadActiveRecoveryLeases({
      ...common, isAgentEnabled: () => false, getProcessStartIdentities: (pids) => new Map(pids.filter(Boolean).map((pid) => [pid, "linux:original"])),
    }), []);
    assert.deepStrictEqual(loadActiveRecoveryLeases({
      ...common, processKill: () => { const err = new Error("dead"); err.code = "ESRCH"; throw err; },
      getProcessStartIdentities: (pids) => new Map(pids.filter(Boolean).map((pid) => [pid, "linux:original"])),
    }), []);
    assert.deepStrictEqual(loadActiveRecoveryLeases({
      ...common, getProcessStartIdentities: (pids) => new Map(pids.filter(Boolean).map((pid) => [pid, "linux:reused"])),
    }), []);
    assert.deepStrictEqual(loadActiveRecoveryLeases({
      ...common, now: 1000 + 25 * 60 * 60 * 1000,
      getProcessStartIdentities: (pids) => new Map(pids.filter(Boolean).map((pid) => [pid, "linux:original"])),
    }), []);

    raw.unexpected = "secret";
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.deepStrictEqual(loadActiveRecoveryLeases({
      ...common, getProcessStartIdentities: (pids) => new Map(pids.filter(Boolean).map((pid) => [pid, "linux:original"])),
    }), []);
  });

  it("loads multiple real sessions and restores each through the dedicated state API", () => {
    updateRecoveryLeaseFromStateBody(body(), winOptions(1000));
    updateRecoveryLeaseFromStateBody(body({ session_id: "real-session-2", state: "working" }), winOptions(2000));
    const seen = [];
    const restored = restoreSessionsFromRecoveryLeases({
      restoreSessionFromLease: (lease) => { seen.push(lease.sessionId); return true; },
    }, {
      recoveryDir,
      now: 3000,
      processKill: () => true,
      isAgentEnabled: () => true,
      platform: "win32",
      getProcessStartIdentities: (pids) => new Map(pids.filter(Boolean).map((pid) => [pid, `win32:test-${pid}`])),
    });
    assert.deepStrictEqual(restored, ["real-session-2", "real-session-1"]);
    assert.deepStrictEqual(seen, restored);
  });
});
