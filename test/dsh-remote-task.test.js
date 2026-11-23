"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  parseIntegrityLevel,
  parseUserSid,
  validateLease,
  runRemoteTask,
  PENDING_SUFFIX,
  CONSUMED_SUFFIX,
  RESULT_FILE,
} = require("../hooks/dsh-remote-task");

const LEASE_ID = "a".repeat(32);
const OPERATION_ID = "b".repeat(32);
const SENTINEL = "CLAWD_DSH_RESULT_V1=";

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-dsh-remote-task-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const leaseDir = path.join(root, "lease");
  fs.mkdirSync(leaseDir, { recursive: true });
  const installScript = path.join(root, "dsh-install.js");
  fs.writeFileSync(installScript, "// installer stub\n", "utf8");
  const dshHome = path.join(root, "dsh-home");
  const now = () => 1000;
  const lease = {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    taskName: "ClawdDsh-test",
    leaseId: LEASE_ID,
    createdAt: 1000,
    startDeadline: 61000,
    expectedUserSid: "S-1-5-21-1-2-3-1001",
    dshHome,
    installScript,
    installArgv: ["--remote"],
    installEnv: { DSH_HOME: dshHome, DSH_EXTRA: "1" },
    installerTimeoutMs: 300000,
    ...overrides,
  };
  fs.writeFileSync(path.join(leaseDir, "lease.json"), JSON.stringify(lease), "utf8");
  fs.writeFileSync(path.join(leaseDir, `${OPERATION_ID}${PENDING_SUFFIX}`), OPERATION_ID, "utf8");
  return { root, leaseDir, installScript, dshHome, lease, now };
}

function sentinelLine(result) {
  return `${SENTINEL}${JSON.stringify({ schemaVersion: 1, status: "ok", ...result })}\n`;
}

function depsFor(f, overrides = {}) {
  return {
    now: f.now,
    env: { DSH_HOME: f.dshHome },
    currentUserSid: () => "S-1-5-21-1-2-3-1001",
    currentIntegrity: () => "medium",
    spawnSync: () => ({ status: 0, stdout: sentinelLine({ operation: "remote-install" }), stderr: "" }),
    ...overrides,
  };
}

function readResult(f) {
  return JSON.parse(fs.readFileSync(path.join(f.leaseDir, RESULT_FILE), "utf8"));
}

test("DSH remote: task consumes one operation token and publishes a bound result", (t) => {
  const f = fixture(t);
  const calls = [];
  const result = runRemoteTask([f.leaseDir, OPERATION_ID], depsFor(f, {
    spawnSync: (executable, argv, options) => {
      calls.push({ executable, argv, options });
      return { status: 0, stdout: sentinelLine({ operation: "remote-install", generationId: "f".repeat(64) }), stderr: "" };
    },
  }));
  assert.strictEqual(result.status, "completed");
  assert.strictEqual(result.operationId, OPERATION_ID);
  assert.strictEqual(result.taskName, "ClawdDsh-test");
  assert.strictEqual(result.leaseId, LEASE_ID);
  assert.strictEqual(result.installerExitCode, 0);
  assert.strictEqual(result.installerResult.status, "ok");
  assert.strictEqual(result.installerResult.operation, "remote-install");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].executable, process.execPath);
  assert.deepStrictEqual(calls[0].argv, [f.installScript, "--remote"]);
  assert.strictEqual(calls[0].options.timeout, 300000);
  assert.strictEqual(calls[0].options.env.DSH_HOME, f.dshHome);
  assert.strictEqual(calls[0].options.env.DSH_EXTRA, "1");
  assert.ok(fs.existsSync(path.join(f.leaseDir, `${OPERATION_ID}${CONSUMED_SUFFIX}`)));
  assert.ok(!fs.existsSync(path.join(f.leaseDir, `${OPERATION_ID}${PENDING_SUFFIX}`)));
  assert.deepStrictEqual(readResult(f), result);
});

test("DSH remote: task refuses a replay because the one-shot token is already consumed", (t) => {
  const f = fixture(t);
  fs.renameSync(
    path.join(f.leaseDir, `${OPERATION_ID}${PENDING_SUFFIX}`),
    path.join(f.leaseDir, `${OPERATION_ID}${CONSUMED_SUFFIX}`),
  );
  const result = runRemoteTask([f.leaseDir, OPERATION_ID], depsFor(f));
  assert.strictEqual(result.status, "refused");
  assert.strictEqual(result.reason, "operation-already-consumed");
  assert.strictEqual(readResult(f).reason, "operation-already-consumed");
});

test("DSH remote: task refuses every environment check before the installer runs", (t) => {
  const cases = [
    { name: "expired", now: () => 70000, deps: {}, reason: "operation-expired" },
    { name: "wrong sid", now: () => 1000, deps: { currentUserSid: () => "S-1-5-21-9-9-9-1001" }, reason: "user_sid_mismatch" },
    { name: "sid unknown", now: () => 1000, deps: { currentUserSid: () => null }, reason: "user_sid_unverifiable" },
    { name: "high token", now: () => 1000, deps: { currentIntegrity: () => "high" }, reason: "integrity_not_medium" },
    { name: "unknown token", now: () => 1000, deps: { currentIntegrity: () => null }, reason: "integrity_unverifiable" },
    { name: "other home", now: () => 1000, deps: { env: { DSH_HOME: "/tmp/other" } }, reason: "dsh_home_mismatch" },
  ];
  for (const item of cases) {
    const f = fixture(t);
    let spawned = false;
    const result = runRemoteTask([f.leaseDir, OPERATION_ID], depsFor(f, {
      now: item.now,
      spawnSync: () => { spawned = true; return { status: 0, stdout: "" }; },
      ...item.deps,
    }));
    assert.strictEqual(result.status, "refused", item.name);
    assert.strictEqual(result.reason, item.reason, item.name);
    assert.strictEqual(spawned, false, item.name);
    const written = readResult(f);
    assert.strictEqual(written.reason, item.reason, item.name);
    assert.strictEqual(written.operationId, OPERATION_ID, item.name);
    assert.strictEqual(written.taskName, "ClawdDsh-test", item.name);
    assert.strictEqual(written.leaseId, LEASE_ID, item.name);
  }
});

test("DSH remote: task reports an unknown installer result without inventing a decision", (t) => {
  const f = fixture(t);
  const result = runRemoteTask([f.leaseDir, OPERATION_ID], depsFor(f, {
    spawnSync: () => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "", error: { code: "ETIMEDOUT" } }),
  }));
  assert.strictEqual(result.status, "unknown");
  assert.strictEqual(result.reason, "installer_result_unknown");
  assert.strictEqual(result.installerResult, null);
  assert.strictEqual(readResult(f).status, "unknown");
});

test("DSH remote: task keeps a completed exit but records a missing sentinel", (t) => {
  const f = fixture(t);
  const result = runRemoteTask([f.leaseDir, OPERATION_ID], depsFor(f, {
    spawnSync: () => ({ status: 0, stdout: "no sentinel here\n", stderr: "" }),
  }));
  assert.strictEqual(result.status, "completed");
  assert.strictEqual(result.installerResult, null);
  assert.match(result.installerResultError, /sentinel/);
});

test("DSH remote: task rejects malformed leases and mismatched operation ids before consuming", (t) => {
  const f = fixture(t);
  const mismatch = runRemoteTask([f.leaseDir, "e".repeat(32)], depsFor(f));
  assert.strictEqual(mismatch.reason, "operation-id-mismatch");
  assert.ok(fs.existsSync(path.join(f.leaseDir, `${OPERATION_ID}${PENDING_SUFFIX}`)), "a mismatch must not consume the token");

  assert.strictEqual(validateLease({ ...f.lease, installArgv: [1] }), false);
  assert.strictEqual(validateLease({ ...f.lease, installScript: "relative.js" }), false);
  assert.strictEqual(validateLease({ ...f.lease, installerTimeoutMs: 0 }), false);
});

test("DSH remote: task parses mandatory-label SIDs and user SIDs without localized text", () => {
  assert.strictEqual(parseIntegrityLevel('"Mandatory Label\\Medium Mandatory Level","S-1-16-8192"'), "medium");
  assert.strictEqual(parseIntegrityLevel('x,"S-1-16-12288"'), "high");
  assert.strictEqual(parseIntegrityLevel('x,"S-1-16-4096"'), "low");
  assert.strictEqual(parseIntegrityLevel("no label"), null);
  assert.strictEqual(parseUserSid('"ruller-pc\\ruller","S-1-5-21-1-2-3-1001"'), "S-1-5-21-1-2-3-1001");
  assert.strictEqual(parseUserSid("nothing"), null);
});
