"use strict";

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const childProcess = require("child_process");
const { EventEmitter } = require("events");

const {
  HOOK_FILES,
  resolveHooksDir,
  deploy: secureDeploy,
  startCodexMonitor: secureStartCodexMonitor,
  stopCodexMonitor: secureStopCodexMonitor,
  uninstallRemoteIntegrations: secureUninstallRemoteIntegrations,
  __test,
} = require("../src/remote-ssh-deploy");
// Preserve focused coverage of the retired implementation as a test-only
// seam. The public exports below are exercised separately and never fall back.
const deploy = __test.legacyDeploy;
const startCodexMonitor = __test.legacyStartCodexMonitor;
const stopCodexMonitor = __test.legacyStopCodexMonitor;
const uninstallRemoteIntegrations = __test.legacyUninstallRemoteIntegrations;
const { clearRemoteNodeCache } = require("../src/remote-ssh-node");

const REPO_ROOT = path.join(__dirname, "..");

afterEach(() => {
  clearRemoteNodeCache();
});

test("scripts/remote-deploy.sh is a fail-fast tombstone with no legacy transport", () => {
  const sh = fs.readFileSync(
    path.join(REPO_ROOT, "scripts", "remote-deploy.sh"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  assert.match(sh, /^#!\/usr\/bin\/env bash\n(?:echo .+\n)exit 2\n$/);
  assert.match(sh, /Settings -> Remote SSH/);
  assert.doesNotMatch(sh, /\bssh\b|\bscp\b|RemoteForward|23333|FILES=\(/);
});

test("HOOK_FILES entries all exist in hooks/", () => {
  for (const name of HOOK_FILES) {
    const full = path.join(REPO_ROOT, "hooks", name);
    assert.ok(fs.existsSync(full), `missing on disk: hooks/${name}`);
  }
});

function secureFixture(overrides = {}) {
  const profile = {
    id: "profile-a",
    label: "Profile A",
    host: "user@example.test",
    remoteForwardPort: 23334,
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    layoutVersion: 1,
    routingNonce: "a".repeat(32),
    autoStartCodexMonitor: false,
    ...overrides.profile,
  };
  const identityTxn = {
    runtimeKey: profile.runtimeKey,
    layoutVersion: profile.layoutVersion,
    phase: "rotating",
    fromNonce: profile.routingNonce,
    toNonce: "b".repeat(32),
    startedAt: 1_000,
    previousExpiresAt: 901_000,
    steps: {},
    ...overrides.identityTxn,
  };
  return {
    profile,
    identityTxn,
    installId: "c".repeat(64),
  };
}

function secureHappySpawn(options = {}) {
  let index = 0;
  const preflight = options.preflight || {
    ok: true,
    identity: false,
    legacyTraces: 0,
    claudePresent: true,
    codexPresent: true,
    copilotPresent: true,
  };
  return makeRecordingSpawn((_child, meta) => {
    const child = _child;
    const current = index++;
    let response = { code: 0 };
    if (options.responses && Object.prototype.hasOwnProperty.call(options.responses, current)) {
      response = options.responses[current];
    } else if (current === 0) response = { code: 0, stdout: "CLAWD_REMOTE_HOME=/home/remote-user\n" };
    else if (current === 1) response = { code: 0, stdout: `${nodeProbeStdout()}\n` };
    else if (current === 2 && options.lockFailure) response = options.lockFailure;
    else if (current === 3) response = options.preflightFailure || {
      code: 0,
      stdout: `${JSON.stringify(preflight)}\n`,
    };
    else if (current === 14) response = {
      code: 0,
      stdout: `${options.permissionMode === "native" ? "native" : "managed"}\n`,
    };
    queueMicrotask(() => {
      if (response.stdout) child.stdout.emit("data", Buffer.from(response.stdout));
      if (response.stderr) child.stderr.emit("data", Buffer.from(response.stderr));
      const code = response.code == null ? 0 : response.code;
      child.emit("exit", code, null);
      child.emit("close", code, null);
    });
  });
}

function secureIsolatedHappySpawn(options = {}) {
  let index = 0;
  const cliCapabilities = options.cliCapabilities || {
    claude: { present: true, path: "/opt/tools/claude", version: "2.1.211" },
    codex: { present: true, path: "/opt/tools/codex", version: "0.100.0" },
    copilot: { present: true, path: "/opt/tools/copilot", version: "1.0.0" },
  };
  const artifacts = options.artifacts || {
    claude: { artifact: true, wrapper: true },
    codex: { artifact: true, wrapper: true },
    copilot: { artifact: true, wrapper: true },
  };
  const preflight = {
    ok: true,
    identity: false,
    legacyTraces: 0,
    claudePresent: false,
    codexPresent: false,
    copilotPresent: false,
  };
  return makeRecordingSpawn((child) => {
    const current = index++;
    let response = { code: 0 };
    if (options.responses && Object.prototype.hasOwnProperty.call(options.responses, current)) {
      response = options.responses[current];
    } else if (current === 0) {
      response = { code: 0, stdout: "CLAWD_REMOTE_HOME=/home/shared\n" };
    } else if (current === 1) {
      response = { code: 0, stdout: `${nodeProbeStdout()}\n` };
    } else if (current === 3) {
      response = { code: 0, stdout: `${JSON.stringify(preflight)}\n` };
    } else if (current === 4) {
      response = { code: 0, stdout: `${JSON.stringify(cliCapabilities)}\n` };
    } else if (current === 16) {
      response = { code: 0, stdout: "managed\n" };
    } else if (current === 17) {
      response = { code: 0, stdout: `${JSON.stringify(artifacts)}\n` };
    }
    queueMicrotask(() => {
      if (response.stdout) child.stdout.emit("data", Buffer.from(response.stdout));
      if (response.stderr) child.stderr.emit("data", Buffer.from(response.stderr));
      const code = response.code == null ? 0 : response.code;
      child.emit("exit", code, null);
      child.emit("close", code, null);
    });
  });
}

test("public deploy and cleanup APIs fail closed without secure ownership", async () => {
  const result = await secureDeploy({
    profile: { id: "legacy", host: "user@host", remoteForwardPort: 23333 },
  });
  assert.deepEqual(result, {
    ok: false,
    skipped: true,
    step: "identity",
    reason: "secure_identity_required",
    stderr: "A trusted installation binding and active identity transaction are required; no remote mutation was attempted.",
  });

  for (const operation of [
    secureStartCodexMonitor,
    secureStopCodexMonitor,
    secureUninstallRemoteIntegrations,
  ]) {
    const cleanup = await operation({
      profile: { id: "legacy", host: "user@host", remoteForwardPort: 23333 },
    });
    assert.equal(cleanup.ok, false);
    assert.equal(cleanup.skipped, true);
    assert.equal(cleanup.reason, "ownership_unverified");
  }
});

test("secure deploy holds a fenced lease, verifies every component, and never puts nonce in argv", async () => {
  const fixture = secureFixture();
  const recorder = secureHappySpawn();
  const runtime = makeRuntimeStub();
  const stepUpdates = [];
  const result = await secureDeploy({
    ...fixture,
    runtime,
    deps: {
      spawn: recorder.spawn,
      hooksDir: path.join(REPO_ROOT, "hooks"),
      detectRemoteShell: stubPosixShellProbe,
      randomBytes: () => Buffer.alloc(16, 0xab),
      onIdentityStep: async (name, update) => stepUpdates.push([name, update]),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.secure, true);
  assert.equal(result.transactionReady, true);
  assert.deepEqual(stepUpdates.map(([name]) => name), [
    "identity",
    "secureMarker",
    "hookFiles",
    "installClaude",
    "installCodex",
    "installCopilot",
    "claudePermission",
    "codexMonitor",
  ]);
  assert.equal(stepUpdates.at(-1)[1].status, "not-applicable");

  const allArgv = recorder.calls.flatMap((call) => call.args).join("\n");
  assert.equal(allArgv.includes(fixture.identityTxn.toNonce), false);
  const secretWrites = recorder.calls.filter((call) =>
    String(call.child._stdin || "").includes(fixture.identityTxn.toNonce));
  assert.equal(secretWrites.length, 2, "identity write and read-back verification use stdin");

  const scpIndex = recorder.calls.findIndex((call) => call.command === "scp");
  const identityIndex = recorder.calls.findIndex((call) =>
    String(call.child._stdin || "").includes('"routingNonce"'));
  const markerIndex = recorder.calls.findIndex((call) =>
    call.child._stdin === "clawd-ssh-secure-v1");
  assert.ok(identityIndex > 2);
  assert.ok(markerIndex > identityIndex);
  assert.ok(scpIndex > markerIndex);

  const liveSshCalls = recorder.calls.slice(4, -1).filter((call) => call.command === "ssh");
  for (const call of liveSshCalls) {
    const command = String(call.args.at(-1));
    assert.match(command, /leaseId/);
    assert.match(command, /runtimeKey/);
  }
});

test("secure deploy only stops a prior Codex monitor after matching its command line", async () => {
  const fixture = secureFixture({
    profile: { autoStartCodexMonitor: true },
  });
  const recorder = secureHappySpawn();
  const result = await secureDeploy({
    ...fixture,
    runtime: makeRuntimeStub(),
    deps: {
      spawn: recorder.spawn,
      hooksDir: path.join(REPO_ROOT, "hooks"),
      detectRemoteShell: stubPosixShellProbe,
      randomBytes: () => Buffer.alloc(16, 0xab),
      onIdentityStep: async () => {},
    },
  });

  assert.equal(result.ok, true);
  const monitorMutation = recorder.calls
    .map((call) => String(call.args.at(-1)))
    .find((command) => command.includes("nohup env") && command.includes("codex-remote-monitor.js"));
  assert.ok(monitorMutation);
  assert.match(monitorMutation, /ps -p "\$pid" -o command=/);
  assert.match(monitorMutation, /case "\$cmd" in/);
});

test("secure deploy lock contention exits before every live mutation", async () => {
  const fixture = secureFixture();
  const recorder = secureHappySpawn({
    lockFailure: {
      code: 73,
      stdout: '{"leaseId":"other","runtimeKey":"account-default"}\n',
    },
  });
  const result = await secureDeploy({
    ...fixture,
    runtime: makeRuntimeStub(),
    deps: {
      spawn: recorder.spawn,
      hooksDir: path.join(REPO_ROOT, "hooks"),
      detectRemoteShell: stubPosixShellProbe,
      randomBytes: () => Buffer.alloc(16, 0xab),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "lock_busy");
  assert.equal(recorder.calls.length, 3);
  assert.equal(recorder.calls.some((call) => call.command === "scp"), false);
});

test("known lock contention restores the managed stage, while an ambiguous acquire quarantines", async () => {
  const fixture = secureFixture();
  const layout = {
    deployLockDir: "/home/remote/.clawd/deploy.lock",
    runtimeKey: fixture.profile.runtimeKey,
    layoutVersion: fixture.profile.layoutVersion,
  };
  for (const code of [73, 74]) {
    const recorder = makeRecordingSpawn({ code, stdout: code === 73 ? "other-owner\n" : "" });
    const stages = [];
    const result = await __test.acquireDeployLock({
      profile: fixture.profile,
      layout,
      installId: fixture.installId,
      leaseId: "d".repeat(32),
      spawn: recorder.spawn,
      runtime: { setManagedLockStage: (stage) => stages.push(stage) },
      now: () => 123,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(stages, ["acquire-attempted", "before-acquire"]);
  }

  const recorder = makeRecordingSpawn({ code: 75 });
  const stages = [];
  let invalidated = null;
  await assert.rejects(__test.acquireDeployLock({
    profile: fixture.profile,
    layout,
    installId: fixture.installId,
    leaseId: "e".repeat(32),
    spawn: recorder.spawn,
    runtime: {
      setManagedLockStage: (stage) => stages.push(stage),
      invalidateManagedOperation: (err) => { invalidated = err; },
    },
    now: () => 123,
  }), (err) => err && err.code === "lock_acquire_unknown"
    && err.recoveryCode === "manual_lock_inspection_required");
  assert.deepEqual(stages, ["acquire-attempted"]);
  assert.ok(invalidated);
});

test("managed mutating close 255 is an unknown result that invalidates the operation", async () => {
  const child = makeFakeChild();
  let invalidated = null;
  const runtime = {
    spawnManagedTransportChild: () => child,
    assertTransportActive: () => {},
    invalidateManagedOperation: (err) => {
      invalidated = err;
      err.recoveryCode = "manual_lock_inspection_required";
    },
  };
  const pending = __test.spawnAndWait(null, "ssh", ["host", "mutate"], {
    runtime,
    role: "test-mutation",
    mutation: true,
  });
  queueMicrotask(() => {
    child.stderr.emit("data", Buffer.from(
      "Connection closed; ProxyCommand gh cs ssh --stdio ghp_12345678901234567890 Bearer secret-token /private/id_rsa",
    ));
    child.emit("exit", 255, null);
    child.emit("close", 255, null);
  });
  await assert.rejects(pending, (err) => {
    assert.equal(err.code, "transport_unknown_result");
    assert.equal(err.recoveryCode, "manual_lock_inspection_required");
    assert.equal(err.drainVerified, true);
    assert.equal(Object.hasOwn(err, "stderr"), false);
    const serialized = JSON.stringify(err);
    assert.doesNotMatch(serialized, /ghp_|secret-token|id_rsa|ProxyCommand/i);
    return true;
  });
  assert.ok(invalidated);
});

test("verified deploy-lock release resets the managed lock stage", async () => {
  const child = makeFakeChild();
  const stages = [];
  const runtime = {
    spawnManagedTransportChild: () => child,
    assertTransportActive: () => {},
    invalidateManagedOperation: () => assert.fail("successful release must not invalidate"),
    setManagedLockStage: (stage) => stages.push(stage),
  };
  const pending = __test.releaseDeployLock({
    profile: secureFixture().profile,
    layout: {
      deployLockDir: "/home/remote/.clawd/deploy.lock",
      runtimeKey: "account-default",
      layoutVersion: 1,
    },
    leaseId: "a".repeat(32),
    remoteNode: "/usr/bin/node",
    runtime,
  });
  queueMicrotask(() => {
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  const result = await pending;
  assert.equal(result.code, 0);
  assert.deepEqual(stages, ["before-acquire"]);
});

test("deploy-lock release close 255 is a recovery error, never success", async () => {
  const child = makeFakeChild();
  let invalidated = null;
  const runtime = {
    spawnManagedTransportChild: () => child,
    assertTransportActive: () => {},
    invalidateManagedOperation: (err) => {
      invalidated = err;
      err.recoveryCode = "manual_lock_inspection_required";
    },
    setManagedLockStage: () => assert.fail("unknown release must retain lock-owned stage"),
  };
  const pending = __test.releaseDeployLock({
    profile: secureFixture().profile,
    layout: {
      deployLockDir: "/home/remote/.clawd/deploy.lock",
      runtimeKey: "account-default",
      layoutVersion: 1,
    },
    leaseId: "a".repeat(32),
    remoteNode: "/usr/bin/node",
    runtime,
  });
  queueMicrotask(() => {
    child.emit("exit", 255, null);
    child.emit("close", 255, null);
  });
  await assert.rejects(pending, (err) => {
    assert.equal(err.code, "transport_unknown_result");
    assert.equal(err.recoveryCode, "manual_lock_inspection_required");
    return true;
  });
  assert.ok(invalidated);
});

test("a lock-release unknown result preserves the primary secure operation failure", async () => {
  const fixture = secureFixture();
  const recorder = secureHappySpawn({
    responses: {
      3: {
        code: 83,
        stdout: '{"ok":false,"reason":"ownership_conflict","field":"installId"}\n',
      },
      4: { code: 255, stderr: "Connection closed by remote host" },
    },
  });
  let active = true;
  const runtime = {
    emit: () => {},
    spawnManagedTransportChild: (spec) => recorder.spawn(spec.tool, spec.args, spec.options),
    assertTransportActive: () => {
      if (!active) throw new Error("inactive transport");
    },
    invalidateManagedOperation: (err) => {
      active = false;
      err.recoveryCode = "manual_lock_inspection_required";
    },
    setManagedLockStage: () => {},
  };
  const result = await secureDeploy({
    ...fixture,
    runtime,
    deps: {
      hooksDir: path.join(REPO_ROOT, "hooks"),
      detectRemoteShell: stubPosixShellProbe,
      randomBytes: () => Buffer.alloc(16, 0xab),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, "preflight");
  assert.equal(result.reason, "ownership_conflict");
  assert.equal(result.recoveryCode, "manual_lock_inspection_required");
  assert.match(result.recoveryError, /manual inspection/i);
});

test("owned monitor cleanup preserves its known failure when lock release is unknown", async () => {
  const fixture = secureFixture();
  const profile = {
    ...fixture.profile,
    installId: fixture.installId,
    remoteHome: "/home/remote",
  };
  const responses = [
    { code: 0 },
    { code: 0, stdout: '{"ok":true,"identity":true}\n' },
    { code: 42, stderr: "monitor stop failed" },
    { code: 255, stderr: "Connection closed by remote host" },
  ];
  let index = 0;
  let active = true;
  const runtime = {
    spawnManagedTransportChild: () => {
      const child = makeFakeChild();
      const response = responses[index++];
      queueMicrotask(() => {
        if (response.stdout) child.stdout.emit("data", Buffer.from(response.stdout));
        if (response.stderr) child.stderr.emit("data", Buffer.from(response.stderr));
        child.emit("exit", response.code, null);
        child.emit("close", response.code, null);
      });
      return child;
    },
    assertTransportActive: () => {
      if (!active) throw new Error("inactive transport");
    },
    invalidateManagedOperation: (err) => {
      active = false;
      err.recoveryCode = "manual_lock_inspection_required";
    },
    setManagedLockStage: () => {},
  };
  const result = await secureStopCodexMonitor({
    profile,
    runtime,
    deps: {
      nodeBin: "/usr/bin/node",
      randomBytes: () => Buffer.alloc(16, 0xab),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.stderr, "monitor stop failed");
  assert.equal(result.recoveryCode, "manual_lock_inspection_required");
  assert.match(result.recoveryError, /manual inspection/i);
});

test("secure deploy never releases its lock after an unknown-result mutation", async () => {
  const fixture = secureFixture();
  const roles = [];
  const stages = [];
  let active = true;
  let invalidated = null;
  let index = 0;
  const runtime = {
    emit: () => {},
    spawnManagedTransportChild: (spec) => {
      const child = makeFakeChild();
      roles.push(spec.role);
      const current = index++;
      queueMicrotask(() => {
        let response = { code: 0, stdout: "" };
        if (current === 0) response.stdout = "CLAWD_REMOTE_HOME=/home/remote-user\n";
        if (current === 1) response.stdout = `${nodeProbeStdout()}\n`;
        if (current === 3) {
          response.stdout = `${JSON.stringify({
            ok: true,
            identity: false,
            legacyTraces: 0,
            claudePresent: true,
            codexPresent: true,
            copilotPresent: true,
          })}\n`;
        }
        if (spec.role === "identity-write") {
          response = { code: 255, stdout: "", stderr: "Connection closed by remote host" };
        }
        if (response.stdout) child.stdout.emit("data", Buffer.from(response.stdout));
        if (response.stderr) child.stderr.emit("data", Buffer.from(response.stderr));
        child.emit("exit", response.code, null);
        child.emit("close", response.code, null);
      });
      return child;
    },
    assertTransportActive: () => {
      if (!active) throw new Error("inactive");
    },
    invalidateManagedOperation: (err) => {
      invalidated = err;
      active = false;
      err.recoveryCode = "manual_lock_inspection_required";
    },
    setManagedLockStage: (stage) => stages.push(stage),
  };

  await assert.rejects(secureDeploy({
    ...fixture,
    runtime,
    deps: {
      hooksDir: path.join(REPO_ROOT, "hooks"),
      detectRemoteShell: stubPosixShellProbe,
      randomBytes: () => Buffer.alloc(16, 0xab),
      onIdentityStep: async () => {},
    },
  }), (err) => err && err.code === "transport_unknown_result");
  assert.ok(invalidated);
  assert.deepEqual(stages.slice(0, 2), ["acquire-attempted", "lock-owned"]);
  assert.equal(roles.includes("identity-write"), true);
  assert.equal(roles.includes("deploy-lock-release"), false);
});

test("secure deploy ownership conflict is found inside the lease and writes no live files", async () => {
  const fixture = secureFixture();
  const recorder = secureHappySpawn({
    preflightFailure: {
      code: 83,
      stdout: '{"ok":false,"reason":"ownership_conflict","field":"installId"}\n',
    },
  });
  const result = await secureDeploy({
    ...fixture,
    runtime: makeRuntimeStub(),
    deps: {
      spawn: recorder.spawn,
      hooksDir: path.join(REPO_ROOT, "hooks"),
      detectRemoteShell: stubPosixShellProbe,
      randomBytes: () => Buffer.alloc(16, 0xab),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ownership_conflict");
  assert.equal(recorder.calls.length, 5, "home, node, lock, locked preflight, fenced release");
  assert.equal(recorder.calls.some((call) => call.command === "scp"), false);
});

test("account-default deploy hard-blocks a live remote Clawd with no override or mutation", async () => {
  const fixture = secureFixture();
  const recorder = secureHappySpawn({
    preflightFailure: {
      code: 84,
      stdout: '{"ok":false,"reason":"local_clawd_conflict"}\n',
    },
  });
  const result = await secureDeploy({
    ...fixture,
    runtime: makeRuntimeStub(),
    deps: {
      spawn: recorder.spawn,
      hooksDir: path.join(REPO_ROOT, "hooks"),
      detectRemoteShell: stubPosixShellProbe,
      randomBytes: () => Buffer.alloc(16, 0xab),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "local_clawd_conflict");
  assert.match(result.message, /live Clawd desktop/);
  assert.equal(recorder.calls.length, 5, "home, node, lock, locked preflight, release only");
  assert.equal(recorder.calls.some((call) => call.command === "scp"), false);
  assert.equal(Object.hasOwn(result, "canContinue"), false);
});

test("legacy traces always require explicit migration confirmation; local timestamps are not ownership", async () => {
  const legacyPreflight = {
    ok: true,
    identity: false,
    legacyTraces: 2,
    claudePresent: true,
    codexPresent: true,
    copilotPresent: true,
  };
  const fixture = secureFixture();
  const blockedRecorder = secureHappySpawn({ preflight: legacyPreflight });
  const blocked = await secureDeploy({
    ...fixture,
    runtime: makeRuntimeStub(),
    deps: {
      spawn: blockedRecorder.spawn,
      hooksDir: path.join(REPO_ROOT, "hooks"),
      detectRemoteShell: stubPosixShellProbe,
      randomBytes: () => Buffer.alloc(16, 0xab),
    },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "legacy_deployment_confirmation_required");
  assert.equal(blockedRecorder.calls.length, 5, "only home, node, lock, preflight, and conditional release run");
  assert.equal(blockedRecorder.calls.some((call) => call.command === "scp"), false);

  for (const [label, profile, confirmed, expectedOk] of [
    ["explicit confirmation", fixture.profile, true, true],
    ["known prior deployment without confirmation", { ...fixture.profile, lastDeployedAt: 12345 }, false, false],
  ]) {
    const recorder = secureHappySpawn({ preflight: legacyPreflight });
    const result = await secureDeploy({
      ...fixture,
      profile,
      legacyMigrationConfirmed: confirmed,
      runtime: makeRuntimeStub(),
      deps: {
        spawn: recorder.spawn,
        hooksDir: path.join(REPO_ROOT, "hooks"),
        detectRemoteShell: stubPosixShellProbe,
        randomBytes: () => Buffer.alloc(16, 0xab),
      },
    });
    assert.equal(result.ok, expectedOk, label);
    assert.equal(recorder.calls.some((call) => call.command === "scp"), expectedOk, label);
  }
});

test("losing the lease after staging prevents hook promotion and all installers", async () => {
  const fixture = secureFixture();
  const recorder = secureHappySpawn({
    responses: {
      9: { code: 92, stderr: "lease changed" },
    },
  });
  const updates = [];
  const result = await secureDeploy({
    ...fixture,
    runtime: makeRuntimeStub(),
    deps: {
      spawn: recorder.spawn,
      hooksDir: path.join(REPO_ROOT, "hooks"),
      detectRemoteShell: stubPosixShellProbe,
      randomBytes: () => Buffer.alloc(16, 0xab),
      onIdentityStep: async (name, update) => updates.push([name, update]),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, "hook-files");
  assert.equal(
    updates.some(([name, update]) => name === "hookFiles" && update.status === "failed"),
    true,
  );
  const commands = recorder.calls.map((call) => String(call.args.at(-1)));
  assert.equal(commands.some((command) => command.includes("install.js") && command.includes("--remote")), false);
  assert.equal(commands.some((command) =>
    command.includes("codex-install.js") && command.includes("--remote")), false);
});

test("every applicable identity component failure leaves the transaction uncommittable", async () => {
  const cases = [
    ["identity", 5, "identity"],
    ["secure-marker", 7, "secureMarker"],
    ["hook-files", 8, "hookFiles"],
    ["install-claude", 11, "installClaude"],
    ["install-codex", 12, "installCodex"],
    ["install-copilot", 13, "installCopilot"],
    ["claude-permission", 14, "claudePermission"],
    ["codex-monitor", 15, "codexMonitor"],
  ];
  for (const [expectedStep, failureIndex, txnStep] of cases) {
    const fixture = secureFixture({
      profile: { autoStartCodexMonitor: expectedStep === "codex-monitor" },
    });
    const recorder = secureHappySpawn({
      responses: {
        [failureIndex]: { code: 1, stderr: `forced ${expectedStep} failure` },
      },
    });
    const updates = [];
    const result = await secureDeploy({
      ...fixture,
      runtime: makeRuntimeStub(),
      deps: {
        spawn: recorder.spawn,
        hooksDir: path.join(REPO_ROOT, "hooks"),
        detectRemoteShell: stubPosixShellProbe,
        randomBytes: () => Buffer.alloc(16, 0xab),
        onIdentityStep: async (name, update) => updates.push([name, update]),
      },
    });
    assert.equal(result.ok, false, expectedStep);
    assert.equal(result.step, expectedStep, expectedStep);
    assert.equal(
      updates.some(([name, update]) => name === txnStep && update.status === "failed"),
      true,
      `${txnStep} must persist failed evidence`,
    );
    assert.equal(result.transactionReady, undefined, expectedStep);
  }
});

test("native permission fallback and absent optional agents persist evidence-backed N/A steps", async () => {
  const fixture = secureFixture();
  const nativeRecorder = secureHappySpawn({ permissionMode: "native" });
  const nativeUpdates = [];
  const native = await secureDeploy({
    ...fixture,
    runtime: makeRuntimeStub(),
    deps: {
      spawn: nativeRecorder.spawn,
      hooksDir: path.join(REPO_ROOT, "hooks"),
      detectRemoteShell: stubPosixShellProbe,
      randomBytes: () => Buffer.alloc(16, 0xab),
      onIdentityStep: async (name, update) => nativeUpdates.push([name, update]),
    },
  });
  assert.equal(native.ok, true);
  const permission = nativeUpdates.find(([name]) => name === "claudePermission")[1];
  assert.equal(permission.status, "not-applicable");
  assert.match(permission.evidence, /native approval/);
  const monitor = nativeUpdates.find(([name]) => name === "codexMonitor")[1];
  assert.equal(monitor.status, "not-applicable");
  assert.ok(monitor.evidence);
});

test("cleanup/start/stop all fail closed for missing or mismatched ownership identity", async () => {
  const base = secureFixture().profile;
  const ownedProfile = {
    ...base,
    installId: "c".repeat(64),
    remoteHome: "/home/remote-user",
  };
  const failures = [
    ["missing", { code: 0, stdout: '{"ok":true,"identity":false,"legacyTraces":0}\n' }, "ownership_identity_missing"],
    ["installId", { code: 83, stdout: '{"ok":false,"reason":"ownership_conflict","field":"installId"}\n' }, "ownership_conflict"],
    ["profileId", { code: 83, stdout: '{"ok":false,"reason":"ownership_conflict","field":"profileId"}\n' }, "ownership_conflict"],
    ["runtimeKey", { code: 83, stdout: '{"ok":false,"reason":"ownership_conflict","field":"runtimeKey"}\n' }, "ownership_conflict"],
    ["layoutVersion", { code: 83, stdout: '{"ok":false,"reason":"ownership_conflict","field":"layoutVersion"}\n' }, "ownership_conflict"],
  ];
  for (const operation of [
    secureStartCodexMonitor,
    secureStopCodexMonitor,
    secureUninstallRemoteIntegrations,
  ]) {
    for (const [label, preflight, reason] of failures) {
      let index = 0;
      const recorder = makeRecordingSpawn((child) => {
        const current = index++;
        const response = current === 1 ? preflight : { code: 0 };
        queueMicrotask(() => {
          if (response.stdout) child.stdout.emit("data", Buffer.from(response.stdout));
          child.emit("exit", response.code, null);
          child.emit("close", response.code, null);
        });
      });
      const result = await operation({
        profile: ownedProfile,
        runtime: makeRuntimeStub(),
        deps: {
          spawn: recorder.spawn,
          nodeBin: "/usr/bin/node",
          randomBytes: () => Buffer.alloc(16, 0xab),
        },
      });
      assert.equal(result.ok, false, `${operation.name}:${label}`);
      assert.equal(result.skipped, true, `${operation.name}:${label}`);
      assert.equal(result.reason, reason, `${operation.name}:${label}`);
      assert.equal(recorder.calls.length, 3, `${operation.name}:${label} must only lock, preflight, release`);
      const commands = recorder.calls.map((call) => String(call.args.at(-1)));
      assert.equal(commands.some((command) => /--uninstall|nohup env|kill "\$pid"/.test(command)), false);
    }
  }
});

test("isolated monitor and cleanup commands stay inside their layout and retain user data", async () => {
  const profile = {
    ...secureFixture().profile,
    runtimeMode: "profile-isolated",
    runtimeKey: "runtime_a",
    installId: "c".repeat(64),
    remoteHome: "/home/shared",
  };
  const makeOwnedRecorder = () => {
    let index = 0;
    return makeRecordingSpawn((child) => {
      const current = index++;
      let response = { code: 0 };
      if (current === 1) {
        response = {
          code: 0,
          stdout: `${JSON.stringify({
            ok: true,
            identity: true,
            legacyTraces: 4,
            legacyMonitorPresent: false,
            claudePresent: true,
            codexPresent: true,
            copilotPresent: true,
          })}\n`,
        };
      }
      queueMicrotask(() => {
        if (response.stdout) child.stdout.emit("data", Buffer.from(response.stdout));
        child.emit("exit", response.code, null);
        child.emit("close", response.code, null);
      });
    });
  };

  let recorder = makeOwnedRecorder();
  const started = await secureStartCodexMonitor({
    profile,
    runtime: makeRuntimeStub(),
    deps: {
      spawn: recorder.spawn,
      nodeBin: "/usr/bin/node",
      randomBytes: () => Buffer.alloc(16, 0xab),
    },
  });
  assert.equal(started.ok, true);
  const startMutation = String(recorder.calls[2].args.at(-1));
  assert.match(startMutation, /\/home\/shared\/\.clawd\/profiles\/runtime_a\/clawd\/codex-monitor\.pid/);
  assert.match(startMutation, /CODEX_HOME='\/home\/shared\/\.clawd\/profiles\/runtime_a\/codex'/);
  assert.match(startMutation, /ps -p "\$pid" -o command=/);
  assert.match(startMutation, /codex-remote-monitor\.js/);
  assert.doesNotMatch(startMutation, /\/home\/shared\/\.codex|\.clawd-codex-monitor\.pid/);

  recorder = makeOwnedRecorder();
  const cleaned = await secureUninstallRemoteIntegrations({
    profile,
    runtime: makeRuntimeStub(),
    deps: {
      spawn: recorder.spawn,
      nodeBin: "/usr/bin/node",
      randomBytes: () => Buffer.alloc(16, 0xcd),
    },
  });
  assert.equal(cleaned.ok, true);
  const cleanupMutations = recorder.calls.slice(2, -1)
    .map((call) => String(call.args.at(-1)))
    .join("\n");
  assert.match(cleanupMutations, /\/home\/shared\/\.clawd\/profiles\/runtime_a/);
  assert.doesNotMatch(cleanupMutations, /\/home\/shared\/\.claude|\/home\/shared\/\.codex|\/home\/shared\/\.copilot/);
  assert.doesNotMatch(cleanupMutations, /\.clawd-codex-monitor\.pid/);
  assert.doesNotMatch(cleanupMutations, /rm -rf '\/home\/shared\/\.clawd\/profiles\/runtime_a'/);
});

test("ownerless lock and stale release are diagnosed without takeover or broad deletion", async () => {
  const fixture = secureFixture();
  let recorder = makeRecordingSpawn([
    { code: 74 },
  ]);
  const layout = require("../src/remote-ssh-layout").resolveRemoteRuntimeLayout({
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    remoteHome: "/home/remote-user",
  });
  const acquired = await __test.acquireDeployLock({
    profile: fixture.profile,
    layout,
    installId: fixture.installId,
    leaseId: "a".repeat(32),
    spawn: recorder.spawn,
    runtime: makeRuntimeStub(),
  });
  assert.equal(acquired.ok, false);
  assert.equal(acquired.reason, "lock_owner_invalid");
  assert.match(acquired.message, new RegExp(layout.deployLockDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  recorder = makeRecordingSpawn([{ code: 91 }]);
  const released = await __test.releaseDeployLock({
    profile: fixture.profile,
    layout,
    leaseId: "a".repeat(32),
    remoteNode: "/usr/bin/node",
    spawn: recorder.spawn,
    runtime: makeRuntimeStub(),
  });
  assert.equal(released.code, 91);
  const releaseCommand = recorder.calls[0].args.at(-1);
  assert.match(releaseCommand, /leaseId/);
  assert.match(releaseCommand, /runtimeKey/);
  assert.match(releaseCommand, /&& rm -rf/);
});

test("lease fencing gates every command in a multiline mutation block", {
  skip: process.platform === "win32" ? "requires POSIX filesystem and shell semantics" : false,
}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-fence-exec-"));
  const layout = require("../src/remote-ssh-layout").resolveRemoteRuntimeLayout({
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    remoteHome: temp,
  });
  const firstWrite = path.join(temp, "first-write");
  const escapedWrite = path.join(temp, "escaped-write");
  try {
    fs.mkdirSync(layout.deployLockDir, { recursive: true });
    fs.writeFileSync(path.join(layout.deployLockDir, "owner"), JSON.stringify({
      leaseId: "b".repeat(32),
      runtimeKey: layout.runtimeKey,
      layoutVersion: layout.layoutVersion,
    }));
    const command = __test.fencedCommand(
      layout,
      "a".repeat(32),
      process.execPath,
      [
        `printf first > '${firstWrite}'`,
        `printf escaped > '${escapedWrite}'`,
      ].join("\n"),
    );
    const result = childProcess.spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(firstWrite), false);
    assert.equal(fs.existsSync(escapedWrite), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("ownership preflight detects managed config traces even when hook files are gone", {
  skip: process.platform === "win32" ? "requires POSIX filesystem and shell semantics" : false,
}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-config-trace-"));
  const layout = require("../src/remote-ssh-layout").resolveRemoteRuntimeLayout({
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    remoteHome: temp,
  });
  try {
    fs.mkdirSync(path.dirname(layout.claudeSettingsFile), { recursive: true });
    fs.writeFileSync(layout.claudeSettingsFile, JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "node /missing/clawd-hook.js Stop" }] }],
      },
    }));
    const script = __test.buildOwnershipPreflightScript({
      profile: { id: "profile-a" },
      layout,
      installId: "c".repeat(64),
    });
    const result = childProcess.spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const detail = JSON.parse(result.stdout.trim());
    assert.equal(detail.legacyTraces, 0);
    assert.equal(detail.legacyConfigTraces, 1);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("installer verification reads back the secure managed command shape", {
  skip: process.platform === "win32" ? "requires POSIX filesystem and shell semantics" : false,
}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-installer-readback-"));
  const layout = require("../src/remote-ssh-layout").resolveRemoteRuntimeLayout({
    runtimeMode: "profile-isolated",
    runtimeKey: "runtime_a",
    remoteHome: temp,
  });
  try {
    fs.mkdirSync(path.dirname(layout.claudeSettingsFile), { recursive: true });
    const writeSettings = (sshRemoteAssignment) => {
      fs.writeFileSync(layout.claudeSettingsFile, JSON.stringify({
        hooks: {
          Stop: [{
            hooks: [{
              type: "command",
              command: `CLAWD_REMOTE='1' ${sshRemoteAssignment} CLAWD_REMOTE_IDENTITY_PATH='${layout.identityFile}' node '${path.join(layout.claudeHooksDir, "clawd-hook.js")}' Stop`,
            }],
          }],
        },
      }));
    };
    writeSettings("CLAWD_SSH_REMOTE='1'");
    const command = __test.buildInstallerVerificationCommand(
      "installClaude",
      layout,
      process.execPath,
    );
    let result = childProcess.spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);

    writeSettings("CLAWD_SSH_REMOTE='0'");
    result = childProcess.spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
    assert.notEqual(result.status, 0);

    const copilotHooksFile = path.join(layout.copilotHome, "hooks", "hooks.json");
    fs.mkdirSync(path.dirname(copilotHooksFile), { recursive: true });
    fs.writeFileSync(copilotHooksFile, JSON.stringify({
      hooks: {
        sessionStart: [{
          type: "command",
          bash: `CLAWD_REMOTE=1 CLAWD_SSH_REMOTE=1 CLAWD_REMOTE_IDENTITY_PATH='${layout.identityFile}' COPILOT_HOME='${layout.copilotHome}' node '${path.join(layout.claudeHooksDir, "copilot-hook.js")}' sessionStart`,
          powershell: "$env:CLAWD_REMOTE='1'; exit 99",
        }],
      },
    }));
    const copilotCommand = __test.buildInstallerVerificationCommand(
      "installCopilot",
      layout,
      process.execPath,
    );
    result = childProcess.spawnSync("/bin/sh", ["-c", copilotCommand], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("secure scp target is one raw argv token without literal shell quotes", () => {
  assert.equal(
    __test.buildScpRemoteTarget(
      "user@example.test",
      "/home/user/.clawd/remote-deploy-staging/lease-a",
    ),
    "user@example.test:/home/user/.clawd/remote-deploy-staging/lease-a/",
  );
  assert.equal(
    __test.buildScpRemoteTarget("user@example.test", "/home/user/staging/"),
    "user@example.test:/home/user/staging/",
  );
});

test("monitor verification requires a live PID with the exact layout script path", {
  skip: process.platform === "win32" ? "requires POSIX filesystem and shell semantics" : false,
}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-monitor-readback-"));
  const layout = require("../src/remote-ssh-layout").resolveRemoteRuntimeLayout({
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    remoteHome: temp,
  });
  const scriptPath = path.join(layout.claudeHooksDir, "codex-remote-monitor.js");
  const fakeBin = path.join(temp, "test-bin");
  const fakePs = path.join(fakeBin, "ps");
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.mkdirSync(path.dirname(layout.monitorPidFile), { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(scriptPath, "setInterval(() => {}, 1000);\n");
  fs.writeFileSync(fakePs, "#!/bin/sh\nprintf '%s\\n' \"$CLAWD_TEST_PS_COMMAND\"\n", {
    mode: 0o700,
  });
  const child = childProcess.spawn(process.execPath, [scriptPath], { stdio: "ignore" });
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    fs.writeFileSync(layout.monitorPidFile, `${child.pid}\n`);
    const command = __test.buildMonitorVerificationCommand(layout, process.execPath);
    const verificationEnv = {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
      CLAWD_TEST_PS_COMMAND: `${process.execPath} ${scriptPath}`,
    };
    let result = childProcess.spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: verificationEnv,
    });
    assert.equal(result.status, 0, result.stderr);

    result = childProcess.spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: { ...verificationEnv, CLAWD_TEST_PS_COMMAND: `${process.execPath} unrelated.js` },
    });
    assert.notEqual(result.status, 0);
  } finally {
    try { child.kill(); } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("isolated CLI probe survives the real remote shell and discovers PATH executables", {
  skip: process.platform === "win32" ? "requires POSIX filesystem and shell semantics" : false,
}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-isolated-cli-probe-"));
  const fakeBin = path.join(temp, "fake-bin");
  const layout = require("../src/remote-ssh-layout").resolveRemoteRuntimeLayout({
    runtimeMode: "profile-isolated",
    runtimeKey: "runtime_a",
    remoteHome: temp,
  });
  try {
    fs.mkdirSync(fakeBin, { recursive: true });
    for (const [name, version] of [
      ["claude", "2.1.211"],
      ["codex", "0.100.0"],
      ["copilot", "1.0.0"],
    ]) {
      fs.writeFileSync(
        path.join(fakeBin, name),
        `#!/bin/sh\nprintf '%s\\n' '${version}'\n`,
        { mode: 0o700 },
      );
    }
    const spawn = (_command, args, options) => childProcess.spawn(
      "/bin/sh",
      ["-c", args.at(-1)],
      {
        ...options,
        env: {
          ...(options && options.env),
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        },
      },
    );
    const result = await __test.probeRemoteCliCapabilities({
      profile: { host: "user@example.test", remoteForwardPort: 23333 },
      layout,
      remoteNode: process.execPath,
      spawn,
      runtime: makeRuntimeStub(),
      minimums: {
        claude: { major: 2, minor: 1, patch: 211 },
        codex: { major: 0, minor: 100, patch: 0 },
        copilot: { major: 1, minor: 0, patch: 0 },
      },
    });
    assert.equal(result.ok, true);
    for (const name of ["claude", "codex", "copilot"]) {
      assert.equal(result.capabilities[name].present, true, name);
      assert.equal(result.capabilities[name].versionVerified, true, name);
      assert.equal(
        result.capabilities[name].executablePath,
        fs.realpathSync(path.join(fakeBin, name)),
      );
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("isolated wrapper records exact evidence only after the CLI exits successfully", {
  skip: process.platform === "win32" ? "requires POSIX filesystem and shell semantics" : false,
}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-wrapper-evidence-"));
  const layout = require("../src/remote-ssh-layout").resolveRemoteRuntimeLayout({
    runtimeMode: "profile-isolated",
    runtimeKey: "runtime_a",
    remoteHome: temp,
  });
  const cli = path.join(temp, "fake-claude");
  try {
    fs.mkdirSync(path.dirname(layout.claudeWrapperFile), { recursive: true });
    fs.writeFileSync(
      cli,
      [
        "#!/bin/sh",
        `[ "$CLAUDE_CONFIG_DIR" = '${layout.claudeConfigDir}' ] || exit 8`,
        '[ "$1" = "fail" ] && exit 7',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    fs.writeFileSync(
      layout.claudeWrapperFile,
      __test.buildIsolatedWrapper(
        layout,
        cli,
        "CLAUDE_CONFIG_DIR",
        layout.claudeConfigDir,
        layout.claudeWrapperEvidenceFile,
      ),
      { mode: 0o700 },
    );

    let result = childProcess.spawnSync(layout.claudeWrapperFile, ["fail"], { encoding: "utf8" });
    assert.equal(result.status, 7);
    assert.equal(fs.existsSync(layout.claudeWrapperEvidenceFile), false);

    result = childProcess.spawnSync(layout.claudeWrapperFile, [], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readFileSync(layout.claudeWrapperEvidenceFile, "utf8"),
      __test.buildWrapperEvidence(cli, "CLAUDE_CONFIG_DIR", layout.claudeConfigDir),
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("legacy monitor cleanup kills only the exact account-default monitor command", {
  skip: process.platform === "win32" ? "requires POSIX filesystem and shell semantics" : false,
}, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-legacy-monitor-"));
  const layout = require("../src/remote-ssh-layout").resolveRemoteRuntimeLayout({
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    remoteHome: tmpDir,
  });
  fs.mkdirSync(layout.claudeHooksDir, { recursive: true });
  const expectedScript = path.join(layout.claudeHooksDir, "codex-remote-monitor.js");
  const fakeBin = path.join(tmpDir, "test-bin");
  const fakePs = path.join(fakeBin, "ps");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(
    fakePs,
    "#!/bin/sh\n[ \"$CLAWD_TEST_PS_FAIL\" = 1 ] && exit 1\nprintf '%s\\n' \"$CLAWD_TEST_PS_OUTPUT\"\n",
    { mode: 0o700 },
  );
  const children = [];
  const spawnSleeper = async (scriptArg) => {
    fs.mkdirSync(path.dirname(scriptArg), { recursive: true });
    fs.writeFileSync(scriptArg, "setInterval(()=>{},1000);\n", { mode: 0o700 });
    const child = childProcess.spawn(
      process.execPath,
      [scriptArg],
      { stdio: "ignore" },
    );
    children.push(child);
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    return child;
  };
  const runCleanup = ({ psOutput = "", psFail = false } = {}) => childProcess.spawnSync(
    process.execPath,
    ["-e", __test.buildLegacyMonitorCleanupScript(layout)],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        CLAWD_TEST_PS_OUTPUT: psOutput,
        CLAWD_TEST_PS_FAIL: psFail ? "1" : "0",
      },
    },
  );
  try {
    let result = runCleanup();
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).status, "absent");

    fs.writeFileSync(layout.legacyMonitorPidFile, "99999999\n", { mode: 0o600 });
    result = runCleanup({ psFail: true });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).status, "pid-not-running");
    assert.equal(fs.existsSync(layout.legacyMonitorPidFile), true);

    const unrelated = await spawnSleeper(path.join(tmpDir, "not-the-monitor.js"));
    fs.writeFileSync(layout.legacyMonitorPidFile, `${unrelated.pid}\n`, { mode: 0o600 });
    result = runCleanup({ psOutput: `${process.execPath} ${path.join(tmpDir, "not-the-monitor.js")}` });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).status, "command-mismatch");
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
    assert.equal(fs.existsSync(layout.legacyMonitorPidFile), true);

    const owned = await spawnSleeper(expectedScript);
    fs.writeFileSync(layout.legacyMonitorPidFile, `${owned.pid}\n`, { mode: 0o600 });
    result = runCleanup({ psOutput: `${process.execPath} ${expectedScript}` });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "stopped");
    assert.equal(fs.existsSync(layout.legacyMonitorPidFile), false);
    await new Promise((resolve) => owned.once("exit", resolve));

    const isolated = require("../src/remote-ssh-layout").resolveRemoteRuntimeLayout({
      runtimeMode: "profile-isolated",
      runtimeKey: "profile-a",
      remoteHome: tmpDir,
    });
    let spawnCalls = 0;
    const skipped = await __test.cleanupLegacyMonitor({
      profile: { host: "user@example.test" },
      layout: isolated,
      leaseId: "a".repeat(32),
      remoteNode: process.execPath,
      spawn: () => { spawnCalls += 1; },
    });
    assert.deepEqual(skipped, { ok: true, status: "not-applicable" });
    assert.equal(spawnCalls, 0);
  } finally {
    for (const child of children) {
      try { child.kill(); } catch {}
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("isolated bootstrap validates the key first, creates a fresh root under the account lease, and never assumes ownership", async () => {
  const fixture = secureFixture();
  let recorder = makeRecordingSpawn([
    { code: 0, stdout: "CLAWD_REMOTE_HOME=/home/shared\n" },
    { code: 0, stdout: `${nodeProbeStdout()}\n` },
    { code: 0 },
    { code: 0 },
    { code: 0 },
  ]);
  const created = await require("../src/remote-ssh-deploy").bootstrapIsolatedRuntime({
    profile: fixture.profile,
    installId: fixture.installId,
    runtimeKey: "profile_a",
    runtime: makeRuntimeStub(),
    deps: {
      spawn: recorder.spawn,
      randomBytes: () => Buffer.alloc(16, 0xab),
    },
  });
  assert.equal(created.ok, true);
  assert.equal(created.layout.runtimeRoot, "/home/shared/.clawd/profiles/profile_a");
  assert.equal(recorder.calls.length, 5);
  const lockCommand = String(recorder.calls[2].args.at(-1));
  assert.match(lockCommand, /\.clawd-remote-deploy-account-default\.lock/);
  assert.doesNotMatch(lockCommand, /profiles\/profile_a\/clawd\/remote-deploy\.lock/);
  const createCommand = String(recorder.calls[3].args.at(-1));
  assert.match(createCommand, /bootstrap-owner\.json/);
  assert.match(createCommand, /profile_a/);
  assert.match(createCommand, /profile-a/);
  assert.match(createCommand, /installId/);
  assert.match(createCommand, /wrapper-evidence/);
  assert.match(createCommand, /0o700/);

  recorder = makeRecordingSpawn([]);
  const invalid = await require("../src/remote-ssh-deploy").bootstrapIsolatedRuntime({
    profile: fixture.profile,
    installId: fixture.installId,
    runtimeKey: "../escape",
    deps: { spawn: recorder.spawn },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "layout_invalid");
  assert.equal(recorder.calls.length, 0);

  recorder = makeRecordingSpawn([
    { code: 0, stdout: "CLAWD_REMOTE_HOME=/home/shared\n" },
    { code: 0, stdout: `${nodeProbeStdout()}\n` },
    { code: 0 },
    { code: 88 },
    { code: 0 },
  ]);
  const exists = await require("../src/remote-ssh-deploy").bootstrapIsolatedRuntime({
    profile: fixture.profile,
    installId: fixture.installId,
    runtimeKey: "profile_b",
    runtime: makeRuntimeStub(),
    deps: {
      spawn: recorder.spawn,
      randomBytes: () => Buffer.alloc(16, 0xcd),
    },
  });
  assert.equal(exists.ok, false);
  assert.equal(exists.reason, "isolated_root_exists");
  assert.equal(recorder.calls.length, 5, "conditional account lock release still runs");
});

test("profile-isolated deploy writes root-specific wrappers and activates only after real CLI artifacts exist", async () => {
  const fixture = secureFixture({
    profile: {
      runtimeMode: "profile-isolated",
      runtimeKey: "rt_profile_a",
    },
    identityTxn: {
      runtimeKey: "rt_profile_a",
    },
  });
  const recorder = secureIsolatedHappySpawn();
  const result = await secureDeploy({
    ...fixture,
    runtime: makeRuntimeStub(),
    deps: {
      spawn: recorder.spawn,
      hooksDir: path.join(REPO_ROOT, "hooks"),
      detectRemoteShell: stubPosixShellProbe,
      randomBytes: () => Buffer.alloc(16, 0xab),
      isolatedCliMinimums: {
        claude: { major: 2, minor: 1, patch: 211 },
        codex: { major: 0, minor: 100, patch: 0 },
        copilot: { major: 1, minor: 0, patch: 0 },
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.isolation.active, true);
  assert.equal(result.isolation.runtimeRoot, "/home/shared/.clawd/profiles/rt_profile_a");
  assert.equal(result.isolation.binDir, "/home/shared/.clawd/profiles/rt_profile_a/bin");
  assert.equal(
    result.isolation.capabilities.claude.wrapperPath,
    "/home/shared/.clawd/profiles/rt_profile_a/bin/claude",
  );
  const cliProbeCommand = String(recorder.calls[4].args.at(-1));
  assert.ok(cliProbeCommand.includes(
    'const wrapperBin="/home/shared/.clawd/profiles/rt_profile_a/bin"'
  ));
  assert.match(cliProbeCommand, /real\(x\)!==wrapperReal/);

  const wrapperCall = recorder.calls.find((call) => {
    const stdin = String(call.child._stdin || "");
    return stdin.includes("#!/bin/sh") && stdin.includes("CLAUDE_CONFIG_DIR");
  });
  assert.ok(wrapperCall, "wrapper bodies must travel over stdin");
  const wrapperPayload = JSON.parse(wrapperCall.child._stdin);
  assert.match(
    wrapperPayload["/home/shared/.clawd/profiles/rt_profile_a/bin/claude"],
    /export CLAUDE_CONFIG_DIR='\/home\/shared\/\.clawd\/profiles\/rt_profile_a\/claude'/,
  );
  assert.match(
    wrapperPayload["/home/shared/.clawd/profiles/rt_profile_a/bin/codex"],
    /export CODEX_HOME='\/home\/shared\/\.clawd\/profiles\/rt_profile_a\/codex'/,
  );
  assert.match(
    wrapperPayload["/home/shared/.clawd/profiles/rt_profile_a/bin/copilot"],
    /export COPILOT_HOME='\/home\/shared\/\.clawd\/profiles\/rt_profile_a\/copilot'/,
  );
  for (const body of Object.values(wrapperPayload)) {
    assert.doesNotMatch(body, /export HOME=/);
    assert.match(body, /wrapper-evidence/);
    assert.match(body, /'\/opt\/tools\//);
    assert.match(body, /status=\$\?/);
    assert.ok(
      body.indexOf("status=$?") < body.indexOf("clawd-wrapper-evidence-v1"),
      "evidence must be written only after the CLI exits successfully",
    );
  }

  const remoteArgv = recorder.calls.flatMap((call) => call.args).join("\n");
  assert.match(remoteArgv, /CLAWD_REMOTE=1/);
  assert.match(remoteArgv, /CLAWD_SSH_REMOTE=1/);
  assert.match(remoteArgv, /\/home\/shared\/\.clawd\/profiles\/rt_profile_a\/claude/);
  assert.doesNotMatch(remoteArgv, /\/home\/shared\/\.claude/);
  assert.doesNotMatch(remoteArgv, /\/home\/shared\/\.codex/);
  assert.doesNotMatch(remoteArgv, /\/home\/shared\/\.copilot/);
});

test("profile-isolated deploy stays prepared, not active, for absent artifacts or unverified Claude versions", async () => {
  const fixture = secureFixture({
    profile: {
      runtimeMode: "profile-isolated",
      runtimeKey: "rt_profile_a",
    },
    identityTxn: {
      runtimeKey: "rt_profile_a",
    },
  });
  for (const [label, spawn] of [
    ["missing artifacts", secureIsolatedHappySpawn({
      artifacts: {
        claude: { artifact: false, wrapper: true },
        codex: { artifact: true, wrapper: true },
        copilot: { artifact: true, wrapper: true },
      },
    })],
    ["old Claude", secureIsolatedHappySpawn({
      cliCapabilities: {
        claude: { present: true, path: "/opt/tools/claude", version: "2.1.210" },
        codex: { present: true, path: "/opt/tools/codex", version: "0.100.0" },
        copilot: { present: true, path: "/opt/tools/copilot", version: "1.0.0" },
      },
    })],
  ]) {
    const result = await secureDeploy({
      ...fixture,
      runtime: makeRuntimeStub(),
      deps: {
        spawn: spawn.spawn,
        hooksDir: path.join(REPO_ROOT, "hooks"),
        detectRemoteShell: stubPosixShellProbe,
        randomBytes: () => Buffer.alloc(16, 0xab),
      },
    });
    assert.equal(result.ok, true, label);
    assert.equal(result.isolation.active, false, label);
  }
});

// ── resolveHooksDir ──

test("resolveHooksDir dev path → ../hooks", () => {
  const dir = resolveHooksDir({ isPackaged: false });
  assert.ok(dir.endsWith(path.join("animation", "hooks")) || dir.endsWith("hooks"));
  assert.equal(fs.existsSync(dir), true);
});

test("resolveHooksDir packaged path → process.resourcesPath/app.asar.unpacked/hooks", () => {
  const original = process.resourcesPath;
  Object.defineProperty(process, "resourcesPath", {
    value: "/fake/resources",
    configurable: true,
    writable: true,
  });
  try {
    const dir = resolveHooksDir({ isPackaged: true });
    assert.equal(dir, path.join("/fake/resources", "app.asar.unpacked", "hooks"));
  } finally {
    Object.defineProperty(process, "resourcesPath", {
      value: original,
      configurable: true,
      writable: true,
    });
  }
});

// ── deploy: mocked spawn ──

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    end(data) { child._stdin = (child._stdin || "") + (data || ""); },
  };
  child.kill = () => {};
  return child;
}

function makeRecordingSpawn(handlers) {
  const calls = [];
  const spawn = (command, args, opts) => {
    const child = makeFakeChild();
    calls.push({ command, args, opts, child });
    // Look up handler by index (first call → handler[0], etc.)
    const idx = calls.length - 1;
    const handler = Array.isArray(handlers) ? handlers[idx] : handlers;
    if (typeof handler === "function") {
      queueMicrotask(() => handler(child, { command, args, opts }));
    } else if (handler && typeof handler === "object") {
      queueMicrotask(() => {
        if (handler.stdout) child.stdout.emit("data", Buffer.from(handler.stdout));
        if (handler.stderr) child.stderr.emit("data", Buffer.from(handler.stderr));
        const code = handler.code != null ? handler.code : 0;
        const signal = handler.signal || null;
        child.emit("exit", code, signal);
        child.emit("close", code, signal);
      });
    } else {
      queueMicrotask(() => {
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
    }
    return child;
  };
  return { spawn, calls };
}

function makeRuntimeStub() {
  const events = [];
  return {
    emit: (event, payload) => events.push({ event, payload }),
    events,
  };
}
// Existing happy-path tests pre-date the `remote-shell` step that now runs
// first inside deploy(). Pass this stub via deps.detectRemoteShell so the
// recorded spawn handlers still line up call-for-call with mkdir, check-node,
// scp, etc. — no extra entries needed. Tests that exercise the Windows-cmd
// block path override this with their own stub.
async function stubPosixShellProbe() {
  return { ok: true, shell: "posix", os: "Linux" };
}

function nodeProbeStdout(nodeBin = "/usr/bin/node", version = "v20.10.0", source = "path") {
  return [
    `CLAWD_REMOTE_NODE_BIN=${nodeBin}`,
    `CLAWD_REMOTE_NODE_VERSION=${version}`,
    `CLAWD_REMOTE_NODE_SOURCE=${source}`,
  ].join("\n");
}

test("deploy: full happy path emits expected progress sequence", async () => {
  // Use real hooks dir so file existence check passes.
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = {
    id: "p1",
    host: "user@pi",
    remoteForwardPort: 23333,
  };
  const { spawn } = makeRecordingSpawn([
    { code: 0 }, // mkdir
    { code: 0, stdout: nodeProbeStdout() }, // check-node
    { code: 0 }, // scp
    { code: 0 }, // install-claude
    { code: 0 }, // install-codex
    { code: 0 }, // install-copilot
  ]);
  const runtime = makeRuntimeStub();
  const result = await deploy({ profile, runtime, deps: { spawn, hooksDir, detectRemoteShell: stubPosixShellProbe } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.remoteNode, {
    nodeBin: "/usr/bin/node",
    version: "v20.10.0",
    source: "path",
  });

  const steps = runtime.events.map((e) => `${e.payload.step}:${e.payload.status}`);
  assert.deepEqual(steps, [
    "verify:ok",
    "remote-shell:start", "remote-shell:ok",
    "mkdir:start", "mkdir:ok",
    "check-node:start", "check-node:ok",
    "scp:start", "scp:ok",
    "install-claude:start", "install-claude:ok",
    "install-codex:start", "install-codex:ok",
    "install-copilot:start", "install-copilot:ok",
  ]);
});

test("deploy: reuses resolved absolute Node path for all remote installers", async () => {
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = {
    id: "p1",
    host: "user@pi",
    remoteForwardPort: 23333,
  };
  const nodeBin = "/home/me/.nvm/versions/node/v22.1.0/bin/node";
  const { spawn, calls } = makeRecordingSpawn([
    { code: 0 }, // mkdir
    { code: 0, stdout: nodeProbeStdout(nodeBin, "v22.1.0", "shell:/bin/bash") },
    { code: 0 }, // scp
    { code: 0 }, // install-claude
    { code: 0 }, // install-codex
    { code: 0 }, // install-copilot
  ]);
  const runtime = makeRuntimeStub();
  const result = await deploy({ profile, runtime, deps: { spawn, hooksDir, detectRemoteShell: stubPosixShellProbe } });
  assert.equal(result.ok, true);

  const installCommands = calls.slice(3, 6).map((c) => c.args[c.args.length - 1]);
  assert.deepEqual(installCommands, [
    `'${nodeBin}' "$HOME/.claude/hooks/install.js" '--remote'`,
    `'${nodeBin}' "$HOME/.claude/hooks/codex-install.js" '--remote'`,
    `'${nodeBin}' "$HOME/.claude/hooks/copilot-install.js" '--remote'`,
  ]);
  for (const command of installCommands) {
    assert.equal(command.includes(" node "), false);
    assert.equal(command.startsWith("node "), false);
  }
});

test("deploy: verifies stale persisted Node metadata before using it", async () => {
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = {
    id: "p1",
    host: "user@pi",
    remoteForwardPort: 23333,
    detectedRemoteNodeBin: "/stale/node",
    detectedRemoteNodeVersion: "v20.10.0",
    detectedRemoteNodeSource: "profile",
  };
  const nodeBin = "/home/me/.nvm/versions/node/v22.1.0/bin/node";
  const { spawn, calls } = makeRecordingSpawn([
    { code: 0 }, // mkdir
    { code: 127, stderr: "/stale/node: not found" }, // cached node verification
    { code: 0, stdout: nodeProbeStdout(nodeBin, "v22.1.0", "shell:/bin/bash") }, // full probe
    { code: 0 }, // scp
    { code: 0 }, // install-claude
    { code: 0 }, // install-codex
    { code: 0 }, // install-copilot
  ]);
  const runtime = makeRuntimeStub();
  const result = await deploy({ profile, runtime, deps: { spawn, hooksDir, detectRemoteShell: stubPosixShellProbe } });
  assert.equal(result.ok, true);
  assert.equal(result.remoteNode.nodeBin, nodeBin);
  assert.ok(calls[1].args[calls[1].args.length - 1].includes("/stale/node"));
  assert.ok(calls[4].args[calls[4].args.length - 1].startsWith(`'${nodeBin}'`));
});

test("deploy: with hostPrefix triggers host-prefix step via ssh stdin", async () => {
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = {
    id: "p1",
    host: "pi",
    remoteForwardPort: 23333,
    hostPrefix: "raspberry",
  };
  let capturedStdin = null;
  const { spawn, calls } = makeRecordingSpawn([
    { code: 0 }, // mkdir
    { code: 0, stdout: nodeProbeStdout("/usr/bin/node", "v20.0.0") },
    { code: 0 }, // scp
    (child) => {
      // host-prefix step: capture stdin
      queueMicrotask(() => {
        capturedStdin = child._stdin;
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
    },
    { code: 0 }, // install-claude
    { code: 0 }, // install-codex
    { code: 0 }, // install-copilot
  ]);
  const runtime = makeRuntimeStub();
  const result = await deploy({ profile, runtime, deps: { spawn, hooksDir, detectRemoteShell: stubPosixShellProbe } });
  assert.equal(result.ok, true);
  assert.equal(capturedStdin, "raspberry");
  // The 4th call (index 3) must be the host-prefix ssh: cat > ~/.claude/hooks/clawd-host-prefix
  const hpCall = calls[3];
  assert.equal(hpCall.command, "ssh");
  const remoteCmd = hpCall.args[hpCall.args.length - 1];
  assert.equal(remoteCmd, "cat > ~/.claude/hooks/clawd-host-prefix");
  // Must NOT contain printf / echo of the hostPrefix value (no shell interp).
  for (const arg of hpCall.args) {
    assert.equal(arg.includes("raspberry"), false, "hostPrefix value must NOT appear in ssh args");
  }
});

test("deploy: scp uses CAPITAL -P for non-default port", async () => {
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = {
    id: "p1",
    host: "pi",
    port: 2222,
    remoteForwardPort: 23333,
  };
  const { spawn, calls } = makeRecordingSpawn([
    { code: 0 },
    { code: 0, stdout: nodeProbeStdout("/usr/bin/node", "v20") },
    { code: 0 },
    { code: 0 },
    { code: 0 },
  ]);
  const runtime = makeRuntimeStub();
  await deploy({ profile, runtime, deps: { spawn, hooksDir, detectRemoteShell: stubPosixShellProbe } });
  const scpCall = calls[2];
  assert.equal(scpCall.command, "scp");
  assert.ok(scpCall.args.includes("-P"), "scp must use -P for port (not -p)");
  assert.equal(scpCall.args.includes("-p"), false);
});

test("deploy: ssh and scp inject -i identityFile when set", async () => {
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = {
    id: "p1",
    host: "pi",
    identityFile: "/home/me/.ssh/id_rsa",
    remoteForwardPort: 23333,
  };
  const { spawn, calls } = makeRecordingSpawn([
    { code: 0 },
    { code: 0, stdout: nodeProbeStdout("/usr/bin/node", "v20") },
    { code: 0 },
    { code: 0 },
    { code: 0 },
  ]);
  const runtime = makeRuntimeStub();
  await deploy({ profile, runtime, deps: { spawn, hooksDir, detectRemoteShell: stubPosixShellProbe } });
  for (const c of calls) {
    const i = c.args.indexOf("-i");
    assert.ok(i >= 0, `every ssh/scp call must have -i: ${c.command} ${c.args.join(" ")}`);
    assert.equal(c.args[i + 1], "/home/me/.ssh/id_rsa");
  }
});

test("deploy: aborts when local hook file is missing", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-ssh-deploy-"));
  try {
    // Write only one file — the rest are missing.
    fs.writeFileSync(path.join(tmpDir, HOOK_FILES[0]), "// stub");
    const profile = { id: "p1", host: "pi", remoteForwardPort: 23333 };
    const { spawn } = makeRecordingSpawn([]);
    const runtime = makeRuntimeStub();
    const result = await deploy({ profile, runtime, deps: { spawn, hooksDir: tmpDir, detectRemoteShell: stubPosixShellProbe } });
    assert.equal(result.ok, false);
    assert.equal(result.step, "verify");
    assert.match(result.message, /Missing files/);
    // No spawn calls — abort happened before networking.
    assert.equal(runtime.events[0].payload.status, "fail");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("deploy: aborts on mkdir failure", async () => {
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23333 };
  const { spawn } = makeRecordingSpawn([
    { code: 255, stderr: "ssh: Permission denied" },
  ]);
  const runtime = makeRuntimeStub();
  const result = await deploy({ profile, runtime, deps: { spawn, hooksDir, detectRemoteShell: stubPosixShellProbe } });
  assert.equal(result.ok, false);
  assert.equal(result.step, "mkdir");
  assert.match(result.message, /Permission denied/);
});

test("deploy: aborts on missing remote node", async () => {
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23333 };
  const { spawn } = makeRecordingSpawn([
    { code: 0 }, // mkdir ok
    { code: 1, stdout: "" }, // remote Node probe fails
  ]);
  const runtime = makeRuntimeStub();
  const result = await deploy({ profile, runtime, deps: { spawn, hooksDir, detectRemoteShell: stubPosixShellProbe } });
  assert.equal(result.ok, false);
  assert.equal(result.step, "check-node");
});

test("deploy: install-claude failure is non-fatal (best-effort)", async () => {
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23333 };
  const { spawn } = makeRecordingSpawn([
    { code: 0 },
    { code: 0, stdout: nodeProbeStdout("/usr/bin/node", "v20") },
    { code: 0 },
    { code: 1, stderr: "install.js failed" }, // install-claude
    { code: 0 }, // install-codex
    { code: 0 }, // install-copilot
  ]);
  const runtime = makeRuntimeStub();
  const result = await deploy({ profile, runtime, deps: { spawn, hooksDir, detectRemoteShell: stubPosixShellProbe } });
  // ok=true even though install-claude failed
  assert.equal(result.ok, true);
  const steps = runtime.events.map((e) => `${e.payload.step}:${e.payload.status}`);
  assert.ok(steps.includes("install-claude:fail"));
  assert.ok(steps.includes("install-codex:ok"));
  assert.ok(steps.includes("install-copilot:ok"));
});

// ── Codex monitor PID management ──

test("startCodexMonitor pre-cleans then launches new monitor", async () => {
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23335 };
  const { spawn, calls } = makeRecordingSpawn([
    { code: 0 }, // pre-clean
    { code: 0 }, // launch
  ]);
  const r = await startCodexMonitor({ profile, deps: { spawn, nodeBin: "/usr/bin/node" } });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  // First call: pre-clean (kill old PID + rm)
  const cleanCmd = calls[0].args[calls[0].args.length - 1];
  assert.match(cleanCmd, /\.clawd-codex-monitor\.pid/);
  assert.match(cleanCmd, /kill \$\(cat .*\.pid\) 2>\/dev\/null/);
  assert.match(cleanCmd, /rm -f .*\.pid/);
  assert.match(cleanCmd, /;\s*true\s*$/, "must terminate with `; true` so exit code is 0 even on missing pid");
  // Second call: launch with port + writes new PID file
  const startCmd = calls[1].args[calls[1].args.length - 1];
  assert.match(startCmd, /nohup '\/usr\/bin\/node' "\$HOME\/\.claude\/hooks\/codex-remote-monitor\.js" '--port' '23335'/);
  assert.match(startCmd, /echo \$! > ~\/\.clawd-codex-monitor\.pid/);
});

test("startCodexMonitor verifies stale persisted Node metadata before launch", async () => {
  const profile = {
    id: "p1",
    host: "pi",
    remoteForwardPort: 23335,
    detectedRemoteNodeBin: "/stale/node",
    detectedRemoteNodeVersion: "v20.10.0",
    detectedRemoteNodeSource: "profile",
  };
  const { spawn, calls } = makeRecordingSpawn([
    { code: 127, stderr: "/stale/node: not found" },
    { code: 0, stdout: nodeProbeStdout("/usr/local/bin/node", "v22.1.0", "path") },
    { code: 0 }, // pre-clean
    { code: 0 }, // launch
  ]);
  const r = await startCodexMonitor({ profile, deps: { spawn } });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 4);
  assert.ok(calls[0].args[calls[0].args.length - 1].includes("/stale/node"));
  const startCmd = calls[3].args[calls[3].args.length - 1];
  assert.match(startCmd, /nohup '\/usr\/local\/bin\/node'/);
});

test("stopCodexMonitor kills PID and removes pid file (best-effort)", async () => {
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23335 };
  const { spawn, calls } = makeRecordingSpawn([
    { code: 0 },
  ]);
  const r = await stopCodexMonitor({ profile, deps: { spawn } });
  assert.equal(r.ok, true);
  const cmd = calls[0].args[calls[0].args.length - 1];
  assert.match(cmd, /kill \$\(cat .*\.pid\)/);
  assert.match(cmd, /rm -f .*\.pid/);
});

test("uninstallRemoteIntegrations runs the Claude and Codex uninstallers over SSH", async () => {
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23335 };
  const { spawn, calls } = makeRecordingSpawn([
    { code: 0 },
    { code: 0 },
  ]);
  const r = await uninstallRemoteIntegrations({ profile, deps: { spawn, nodeBin: "/usr/bin/node" } });

  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  const first = calls[0].args[calls[0].args.length - 1];
  const second = calls[1].args[calls[1].args.length - 1];
  assert.match(first, /if \[ -f .*uninstall\.js/);
  assert.match(first, /uninstall\.js/);
  assert.match(first, /unregisterHooks/);
  assert.match(second, /codex-install\.js.*--uninstall/);
});

test("uninstallRemoteIntegrations verifies a stale cached Node path and re-probes", async () => {
  const profile = {
    id: "p1",
    host: "pi",
    remoteForwardPort: 23335,
    detectedRemoteNodeBin: "/stale/node",
    detectedRemoteNodeVersion: "v20.10.0",
    detectedRemoteNodeSource: "profile",
  };
  const { spawn, calls } = makeRecordingSpawn([
    { code: 127, stderr: "/stale/node: not found" },
    { code: 0, stdout: nodeProbeStdout("/usr/local/bin/node", "v22.1.0", "path") },
    { code: 0 },
    { code: 0 },
  ]);

  const r = await uninstallRemoteIntegrations({ profile, deps: { spawn } });

  assert.equal(r.ok, true);
  assert.equal(calls.length, 4);
  assert.ok(calls[0].args[calls[0].args.length - 1].includes("/stale/node"));
  assert.match(calls[2].args[calls[2].args.length - 1], /'\/usr\/local\/bin\/node'/);
});

test("uninstallRemoteIntegrations reports failure but never throws when a step exits non-zero", async () => {
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23335 };
  const { spawn } = makeRecordingSpawn([
    { code: 1, stderr: "no route to host" },
    { code: 0 },
  ]);
  const r = await uninstallRemoteIntegrations({ profile, deps: { spawn, nodeBin: "/usr/bin/node" } });

  assert.equal(r.ok, false);
  assert.match(r.stderr || "", /no route to host/);
});

test("deploy: registers each spawned child with runtime so cleanup can kill it", async () => {
  // Verifies the v7 follow-up: child processes spawned during Deploy must be
  // tracked by runtime.registerChild so before-quit cleanup() can kill them
  // if the user closes the app mid-Deploy.
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23333 };
  const registered = [];
  const unregistered = [];
  const runtime = {
    emit: () => {},
    registerChild: (c) => registered.push(c),
    unregisterChild: (c) => unregistered.push(c),
  };
  const { spawn, calls } = makeRecordingSpawn([
    { code: 0 },
    { code: 0, stdout: nodeProbeStdout("/usr/bin/node", "v20") },
    { code: 0 },
    { code: 0 },
    { code: 0 },
  ]);
  const result = await deploy({ profile, runtime, deps: { spawn, hooksDir, detectRemoteShell: stubPosixShellProbe } });
  assert.equal(result.ok, true);
  // Each spawned child is registered exactly once and unregistered exactly once.
  assert.equal(registered.length, calls.length);
  assert.equal(unregistered.length, calls.length);
  // Same child object each time (set semantics).
  for (let i = 0; i < calls.length; i++) {
    assert.strictEqual(registered[i], calls[i].child);
    assert.strictEqual(unregistered[i], calls[i].child);
  }
});

test("startCodexMonitor / stopCodexMonitor register children with runtime when provided", async () => {
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23335 };
  const registered = [];
  const unregistered = [];
  const runtime = {
    registerChild: (c) => registered.push(c),
    unregisterChild: (c) => unregistered.push(c),
  };
  const { spawn } = makeRecordingSpawn([{ code: 0 }, { code: 0 }]);
  await startCodexMonitor({ profile, runtime, deps: { spawn, nodeBin: "/usr/bin/node" } });
  assert.equal(registered.length, 2);
  assert.equal(unregistered.length, 2);

  const stopRecorder = makeRecordingSpawn([{ code: 0 }]);
  await stopCodexMonitor({ profile, runtime, deps: { spawn: stopRecorder.spawn } });
  assert.equal(registered.length, 3);
  assert.equal(unregistered.length, 3);
});

test("stopCodexMonitor swallows failures (best-effort cleanup)", async () => {
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23335 };
  const { spawn } = makeRecordingSpawn([
    { code: 1, stderr: "no such file" },
  ]);
  const r = await stopCodexMonitor({ profile, deps: { spawn } });
  // Even on failure, returns ok:true — caller doesn't surface this.
  assert.equal(r.ok, true);
});

// ── Remote shell probe gating ──
//
// When the remote shell is Windows cmd.exe, every later POSIX command
// (mkdir -p, ~/, sh -c, nohup &) would fail loudly with CP936 mojibake.
// deploy() must bail out at the shell probe step with a structured
// reason/hint pair so the renderer can localize and the user gets a
// single actionable error instead of half-a-deploy worth of garbage.
test("deploy: aborts at remote-shell step when remote is Windows cmd.exe", async () => {
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = { id: "p1", host: "user@win", remoteForwardPort: 23333 };
  const { spawn, calls } = makeRecordingSpawn([]); // no further spawns expected
  const runtime = makeRuntimeStub();
  const result = await deploy({
    profile,
    runtime,
    deps: {
      spawn,
      hooksDir,
      detectRemoteShell: async () => ({ ok: true, shell: "windows-cmd", os: "windows" }),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, "remote-shell");
  assert.equal(result.reason, "windows_cmd_shell");
  assert.equal(result.hint, "remoteSshErrWindowsCmdShell");
  // No mkdir / scp / check-node spawn calls — we short-circuited.
  assert.equal(calls.length, 0);
  // verify:ok, remote-shell:start, remote-shell:fail — and nothing else.
  const steps = runtime.events.map((e) => `${e.payload.step}:${e.payload.status}`);
  assert.deepEqual(steps, [
    "verify:ok",
    "remote-shell:start",
    "remote-shell:fail",
  ]);
  // The fail event carries the hint key so the renderer can localize.
  const failEv = runtime.events.find((e) =>
    e.payload.step === "remote-shell" && e.payload.status === "fail");
  assert.equal(failEv.payload.hint, "remoteSshErrWindowsCmdShell");
});

test("deploy: proceeds when remote-shell probe returns posix", async () => {
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23333 };
  const { spawn } = makeRecordingSpawn([
    { code: 0 }, // mkdir
    { code: 0, stdout: nodeProbeStdout() },
    { code: 0 }, // scp
    { code: 0 }, // install-claude
    { code: 0 }, // install-codex
    { code: 0 }, // install-copilot
  ]);
  const runtime = makeRuntimeStub();
  const result = await deploy({
    profile,
    runtime,
    deps: {
      spawn,
      hooksDir,
      detectRemoteShell: async () => ({ ok: true, shell: "posix", os: "Linux" }),
    },
  });
  assert.equal(result.ok, true);
  // remote-shell:ok lands between verify and mkdir.
  const steps = runtime.events.map((e) => `${e.payload.step}:${e.payload.status}`);
  assert.equal(steps[0], "verify:ok");
  assert.equal(steps[1], "remote-shell:start");
  assert.equal(steps[2], "remote-shell:ok");
  assert.equal(steps[3], "mkdir:start");
});

test("deploy: unknown remote shell does not block deploy", async () => {
  // Conservative: an unknown shell (PowerShell, fish, restricted shell)
  // could still happen to be POSIX-compatible. Let the existing steps
  // fail loudly if not — don't gate on a probe that lacked a verdict.
  const hooksDir = path.join(REPO_ROOT, "hooks");
  const profile = { id: "p1", host: "weird", remoteForwardPort: 23333 };
  const { spawn } = makeRecordingSpawn([
    { code: 0 }, // mkdir
    { code: 0, stdout: nodeProbeStdout() },
    { code: 0 }, // scp
    { code: 0 }, // install-claude
    { code: 0 }, // install-codex
    { code: 0 }, // install-copilot
  ]);
  const runtime = makeRuntimeStub();
  const result = await deploy({
    profile,
    runtime,
    deps: {
      spawn,
      hooksDir,
      detectRemoteShell: async () => ({ ok: false, shell: "unknown" }),
    },
  });
  assert.equal(result.ok, true);
});
