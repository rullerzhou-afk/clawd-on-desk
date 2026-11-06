"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const {
  deploy, uninstallRemoteIntegrations, finalizeRetiredRemoteLayout, bootstrapIsolatedRuntime,
  startCodexMonitor, stopCodexMonitor, HOOK_FILES, __test: deployTest,
} = require("../src/remote-ssh-deploy");
const { resolveRemoteNodeBin, runRemoteNodeFrame } = require("../src/remote-ssh-node");
const { REMOTE_NODE_LAUNCH_COMMAND } = require("../src/remote-ssh-node-launch");
const { REMOTE_IDENTITY_STEP_NAMES } = require("../src/remote-ssh-profile");

const node = { platform: "win32", homedir: "C:\\Users\\remote", execPath: "C:\\Node\\node.exe", version: "v22.0.0" };
const snapshot = { ok: true, remotePlatform: "win32", shell: { shell: "windows-cmd" }, node,
  remoteNode: { ok: true, nodeBin: node.execPath, version: node.version, source: "discovery" } };
const profile = {
  id: "windows", host: "remote.test", remotePlatform: "win32", remoteHome: node.homedir,
  runtimeMode: "account-default", runtimeKey: "account-default", layoutVersion: 1,
  installId: "a".repeat(64), routingNonce: "b".repeat(32), remoteForwardPort: 23334,
  detectedRemoteNodeBin: node.execPath, detectedRemoteNodeVersion: node.version,
  autoStartCodexMonitor: true, hostPrefix: "Win host", chainStatusline: true, remotePermissionTransport: "query",
};
const identityTxn = { runtimeKey: "account-default", layoutVersion: 1, toNonce: "c".repeat(32), startedAt: 100 };
const remoteIdentity = { version: 2, installId: profile.installId, profileId: profile.id,
  runtimeKey: profile.runtimeKey, layoutVersion: 1, routingNonce: "d".repeat(32), remotePort: 23334, deployedAt: 100 };

function recorder(respond = () => null) {
  const calls = [];
  function spawn(tool, args) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    const call = { tool, args };
    calls.push(call);
    child.stdin = { end(input) {
      if (input) call.frame = JSON.parse(input);
      call.operation = tool === "scp" ? "upload" : call.frame.args.operation || "discovery";
      assert.equal(tool === "scp" || args.at(-1) === REMOTE_NODE_LAUNCH_COMMAND, true, "no POSIX command may be sent");
      let detail = { ok: true };
      if (call.operation === "discovery") detail = node;
      if (call.operation === "preflight") detail = { ok: true, identity: true, claudePresent: true, copilotPresent: true,
        codexPresent: true, legacyMonitorPresent: true, hermesPresent: true, legacyTraces: 0, legacyConfigTraces: 0 };
      if (call.operation === "readIdentity") detail = { identity: remoteIdentity };
      if (call.operation === "runInstaller") detail = { ok: true, status: 0, verified: true };
      if (call.operation === "readClaudePermission") detail = { ok: true, mode: "managed" };
      if (call.operation === "uninstallCodexOwned") detail = { ok: true, removed: 1, conflicts: 0, changed: true };
      if (call.operation === "dshCleanupPreflight") detail = {
        ok: true, assetPresent: false, assetUnreadable: false,
        recordExists: false, recordReadable: true, recordInvalid: false, recordPhase: null,
        installerCapable: false, installerLoadFailed: false, dshHome: path.win32.join(node.homedir, ".dsh"),
        desktop: { state: "missing", referenced: false, linkState: "missing", linkReferenced: false, unreadable: false },
        web: { state: "missing", referenced: false, linkState: "missing", linkReferenced: false, unreadable: false },
      };
      const response = (respond && respond(call)) || { code: 0, stdout: `banner\n${JSON.stringify(detail)}\n` };
      queueMicrotask(() => {
        if (response.stdout) child.stdout.emit("data", Buffer.from(response.stdout));
        if (response.stderr) child.stderr.emit("data", Buffer.from(response.stderr));
        child.emit("exit", response.code, response.signal || null);
        child.emit("close", response.code, response.signal || null);
      });
    } };
    return child;
  }
  const flags = [];
  const deps = {
    spawn,
    transportWait(spawnFn, tool, args, options) {
      flags.push({ operation: JSON.parse(options.stdin).args.operation, mutation: options.mutation });
      return deployTest.spawnAndWait(spawnFn, tool, args, options);
    },
    runRemoteNodeFrame(options) {
      flags.push({ operation: "discovery", mutation: options.mutation });
      return runRemoteNodeFrame(options);
    },
  };
  return { spawn, calls, flags, deps };
}
function deployment(respond, extra = {}) {
  const recorded = recorder(respond);
  const steps = []; const stages = []; const events = [];
  const runtime = { emit: (_name, event) => events.push(event), setManagedLockStage: (stage) => stages.push(stage) };
  const options = { profile, installId: profile.installId, identityTxn, platformSnapshot: snapshot, runtime,
    deps: { ...recorded.deps, randomBytes: () => Buffer.alloc(16, 0xee), now: () => 200,
      onIdentityStep: async (name, value) => {
        assert.ok(REMOTE_IDENTITY_STEP_NAMES.includes(name), `unknown transaction step ${name}`);
        steps.push([name, value]);
      } }, ...extra };
  return { ...recorded, steps, stages, events, options };
}
const operations = (f) => f.calls.map((call) => call.operation);

test("issue #1316: Windows deployment completes eight identity steps using only framed operations", async () => {
  const f = deployment(undefined, { profile: { ...profile, detectedRemoteNodeBin: "D:\\OldNode\\node.exe" } });
  const result = await deploy(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.layout.platform, "win32");
  assert.deepEqual(result.remoteNode, { nodeBin: node.execPath, version: node.version, source: "discovery" });
  assert.equal(result.codexHooksInstalled, true);
  assert.deepEqual(operations(f), ["acquireLock", "preflight", "mkdir", "writeIdentity", "writeMarker", "upload", "promoteMany", "writeHostPrefix", "runInstaller", "runInstaller", "runInstaller", "readClaudePermission", "releaseLock"]);
  assert.deepEqual(f.stages, ["acquire-attempted", "lock-owned", "before-acquire"]);
  assert.equal(f.steps.length, 8);
  assert.deepEqual(Object.fromEntries(f.steps.map(([key, value]) => [key, value.status])), {
    identity: "done", secureMarker: "done", hookFiles: "done", installClaude: "done", installCodex: "done",
    installCopilot: "done", claudePermission: "done", codexMonitor: "not-applicable",
  });
  const step = Object.fromEntries(f.steps);
  assert.equal(step.installCodex.evidence, "codex-install.js settings readback verified secure managed command shape");
  assert.equal(step.codexMonitor.evidence, "Codex monitor is not supported on Windows remote hosts");
  assert.equal(step.identity.evidence, "identity read-back matched transaction");
  assert.equal(step.secureMarker.evidence, "marker atomically written and read back");
  assert.equal(step.hookFiles.evidence, "uploaded hook hashes matched local files");
  assert.equal(step.installClaude.evidence, "install.js settings readback verified secure managed command shape");
  assert.equal(step.installCopilot.evidence, "copilot-install.js settings readback verified secure managed command shape");
  assert.equal(step.claudePermission.evidence, "managed PermissionRequest URL contains transaction nonce");
  assert.ok(f.events.some((event) => event.step === "remote-shell" && event.message === "Windows"));
  assert.ok(f.events.some((event) => event.step === "install-hermes" && event.message === "not applicable"));
  const uploaded = f.calls.find((call) => call.operation === "upload");
  assert.equal(uploaded.args.at(-1), `remote.test:/C:/Users/remote/.clawd/remote-deploy-staging/${"ee".repeat(16)}/`);
  const promoted = f.calls.find((call) => call.operation === "promoteMany").frame.args;
  assert.deepEqual(Object.keys(promoted.hashes), HOOK_FILES);
  const mkdir = f.calls.find((call) => call.operation === "mkdir").frame.args;
  assert.ok(mkdir.directories.every((directory) => !directory.includes(".codex")));
  assert.ok(mkdir.directories.includes(path.win32.join(result.layout.deployStagingDir, result.leaseId)));
  const writtenIdentity = f.calls.find((call) => call.operation === "writeIdentity").frame.args.identity;
  assert.equal(writtenIdentity.routingNonce, identityTxn.toNonce);
  assert.equal(writtenIdentity.deployedAt, identityTxn.startedAt);
  for (const call of f.calls.filter((call) => call.frame)) assert.ok(call.frame.code.includes(JSON.stringify(node.execPath)));
  const installs = f.calls.filter((call) => call.operation === "runInstaller").map((call) => call.frame.args);
  assert.deepEqual(installs.map((args) => [args.script, args.argv, args.verify]), [["install.js", ["--remote"], "installClaude"], ["codex-install.js", ["--remote"], "installCodex"], ["copilot-install.js", ["--remote"], "installCopilot"]]);
  assert.deepEqual(installs[0].env, {
    CLAUDE_CONFIG_DIR: result.layout.claudeConfigDir, COPILOT_HOME: result.layout.copilotHome, CODEX_HOME: result.layout.codexHome,
    CLAWD_REMOTE: "1", CLAWD_SSH_REMOTE: "1", CLAWD_REMOTE_IDENTITY_PATH: result.layout.identityFile,
    CLAWD_SSH_SECURE_MARKER_PATH: result.layout.secureMarkerFile, CLAWD_HOST_PREFIX_PATH: result.layout.hostPrefixFile,
    CLAWD_REMOTE_LAST_LOG_PATH: result.layout.lastLogFile, CLAWD_STATUSLINE_SIDECAR_PATH: result.layout.statuslineSidecarFile,
    CLAWD_REMOTE_PERMISSION_TRANSPORT: "query",
  });
});

test("issue #1316: Windows busy lock does not run preflight or release another lease", async () => {
  const f = deployment(() => ({ code: 0, stdout: '{"ok":false,"reason":"lock_busy"}' }));
  assert.equal((await deploy(f.options)).reason, "lock_busy");
  assert.deepEqual(operations(f), ["acquireLock"]);
  assert.deepEqual(f.stages, ["acquire-attempted", "before-acquire"]);
});
for (const response of [{ code: 1, stderr: "path_unreadable: lock" }, { code: 0, stdout: "invalid" }, { code: 0, stdout: '{}' }]) {
  test(`issue #1316: Windows uncertain lock requires inspection (${JSON.stringify(response)})`, async () => {
    const f = deployment(() => response);
    await assert.rejects(deploy(f.options), { code: "lock_acquire_unknown", recoveryCode: "manual_lock_inspection_required" });
    assert.deepEqual(operations(f), ["acquireLock"]);
  });
}
for (const reason of ["local_clawd_conflict", "runtime_owner_unknown", "runtime_invalid", "identity_invalid", "ownership_conflict", "agent_root_invalid", "path_link", "path_unreadable", "file_unreadable", "path_not_directory", "path_outside_home", "path_invalid"]) {
  test(`issue #1316: Windows preflight preserves refusal reason ${reason}`, async () => {
    const f = deployment((call) => call.operation === "preflight" ? { code: 1, stderr: `${reason}: C:\\Users\\remote (detail)` } : null);
    const result = await deploy(f.options);
    assert.equal(result.ok, false); assert.equal(result.reason, reason);
    assert.deepEqual(operations(f), ["acquireLock", "preflight", "releaseLock"]);
  });
}
for (const operation of ["acquireLock", "mkdir", "writeIdentity", "writeMarker", "upload", "promoteMany", "writeHostPrefix", "runInstaller", "releaseLock"]) {
  test(`issue #1316: Windows ${operation} retains the lease after an unknown mutation result`, async () => {
    const f = deployment((call) => call.operation === operation ? { code: 255, stderr: "Connection reset" } : null);
    await assert.rejects(deploy(f.options), { name: "TransportUnknownResultError", recoveryCode: "manual_lock_inspection_required" });
    assert.equal(operations(f).at(-1), operation);
  });
}
test("issue #1316: Windows release failure requires manual inspection", async () => {
  const f = deployment((call) => call.operation === "releaseLock" ? { code: 1, stderr: "lease_lost: owner" } : null);
  await assert.rejects(deploy(f.options), { recoveryCode: "manual_lock_inspection_required" });
});
test("issue #1316: Windows migration confirmation is required before layout writes", async () => {
  const f = deployment((call) => call.operation === "preflight" ? { code: 0, stdout: '{"ok":true,"identity":false,"legacyTraces":1}' } : null);
  assert.equal((await deploy(f.options)).reason, "legacy_deployment_confirmation_required");
  assert.deepEqual(operations(f), ["acquireLock", "preflight", "releaseLock"]);
});
test("issue #1316: Windows missing agent roots and native permission produce explicit evidence", async () => {
  const f = deployment((call) => call.operation === "preflight" ? { code: 0, stdout: '{"ok":true,"identity":true,"claudePresent":false,"copilotPresent":false}' } : null);
  const result = await deploy(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.codexHooksInstalled, false);
  assert.equal(operations(f).includes("runInstaller"), false);
  const absentSteps = Object.fromEntries(f.steps);
  assert.equal(absentSteps.claudePermission.status, "not-applicable");
  assert.equal(absentSteps.installClaude.status, "not-applicable");
  assert.equal(absentSteps.installCodex.status, "not-applicable");
  assert.equal(absentSteps.installCodex.evidence, "codex-install.js target root absent before deploy");
  assert.equal(absentSteps.installCopilot.status, "not-applicable");
  const native = deployment((call) => call.operation === "readClaudePermission" ? { code: 0, stdout: '{"ok":true,"mode":"native"}' } : null);
  assert.equal((await deploy(native.options)).ok, true);
  assert.equal(Object.fromEntries(native.steps).claudePermission.status, "not-applicable");
  assert.equal(Object.fromEntries(native.steps).claudePermission.evidence, "no managed PermissionRequest; Claude native approval retained");
});
test("issue #1316: Windows invalid prefix and isolated runtime reject before SSH", async () => {
  for (const [changes, reason] of [[{ hostPrefix: "bad!" }, "host_prefix_invalid"], [{ runtimeMode: "profile-isolated" }, "windows_profile_isolated_unsupported"]]) {
    const f = deployment(null, { profile: { ...profile, ...changes } });
    assert.equal((await deploy(f.options)).reason, reason); assert.equal(f.calls.length, 0);
  }
  assert.equal((await bootstrapIsolatedRuntime({ profile, deps: { spawn: () => assert.fail("no SSH") } })).reason, "windows_profile_isolated_unsupported");
});
for (const preserveIdentity of [true, false]) {
  test(`issue #1316: Windows uninstall clears owned registrations before files preserveIdentity=${preserveIdentity}`, async () => {
    const f = recorder();
    const result = await uninstallRemoteIntegrations({ profile, preserveIdentity, deps: f.deps });
    assert.equal(result.ok, true);
    assert.deepEqual(operations(f), ["discovery", "readIdentity", "acquireLock", "preflight", "readIdentity", "runInstaller", "runInstaller", "uninstallCodexOwned", "dshCleanupPreflight", "removeFiles", "releaseLock"]);
    const installs = f.calls.filter((call) => call.operation === "runInstaller").map((call) => call.frame.args);
    assert.deepEqual(installs.map((args) => args.script), ["install.js", "copilot-install.js"]);
    for (const args of installs) assert.deepEqual(args.argv, ["--remote-uninstall-owned", "--hooks-dir", result.layout.claudeHooksDir, "--routing-nonce", remoteIdentity.routingNonce]);
    const files = f.calls.find((call) => call.operation === "removeFiles").frame.args.files;
    assert.deepEqual(files, [...HOOK_FILES.map((name) => path.win32.join(result.layout.claudeHooksDir, name)), result.layout.hostPrefixFile, result.layout.lastLogFile,
      ...(preserveIdentity ? [] : [result.layout.identityFile, result.layout.secureMarkerFile])]);
    assert.equal(files.includes(result.layout.statuslineSidecarFile), false);
  });
}
test("issue #1316: Windows monitor entry points skip stale auto-start options without SSH", async () => {
  for (const fn of [startCodexMonitor, stopCodexMonitor]) {
    assert.deepEqual(await fn({ profile, deps: { spawn: () => assert.fail("no SSH") } }), { ok: true, skipped: true, reason: "not-applicable" });
    assert.deepEqual(await fn({ profile: { ...profile, remotePlatform: "posix" }, platformSnapshot: snapshot }), { ok: true, skipped: true, reason: "not-applicable" });
  }
});
for (const fn of [uninstallRemoteIntegrations, finalizeRetiredRemoteLayout]) {
  for (const changedNode of [{ ...node, platform: "linux" }, { ...node, homedir: "C:\\Users\\other" }]) {
    test(`issue #1316: Windows historical ${fn.name} rejects changed target ${changedNode.platform}/${changedNode.homedir}`, async () => {
      const f = recorder(() => ({ code: 0, stdout: JSON.stringify(changedNode) }));
      const result = await fn({ profile, deps: f.deps });
      assert.equal(result.reason, "platform_changed"); assert.equal(result.skipped, true);
      assert.deepEqual(operations(f), ["discovery"]);
      assert.deepEqual(f.flags, [{ operation: "discovery", mutation: false }]);
    });
  }
}
test("issue #1316: Windows retired layout finalizes through one fenced identity operation", async () => {
  const f = recorder();
  assert.equal((await finalizeRetiredRemoteLayout({ profile, deps: f.deps })).ok, true);
  assert.deepEqual(operations(f), ["discovery", "acquireLock", "finalizeIdentity", "releaseLock"]);
});
for (const [label, discovered, expectedReason] of [
  ["success", { ...node, execPath: node.execPath.toUpperCase() }, null],
  ["changed execPath", { ...node, execPath: "D:\\Node\\node.exe" }, "windows_node_changed"],
  ["old version", { ...node, version: "v12.0.0" }, "node_unavailable"],
  ["different platform", { ...node, platform: "linux" }, "platform_changed"],
]) {
  test(`issue #1316: Windows Node resolution ${label} uses discovery instead of POSIX probes`, async () => {
    const f = recorder(() => ({ code: 0, stdout: JSON.stringify(discovered) }));
    const result = await resolveRemoteNodeBin({ profile, spawn: f.spawn, buildSshArgs: () => ["remote.test"], verifyCache: true });
    assert.equal(result.ok, !expectedReason);
    if (expectedReason) assert.equal(result.reason, expectedReason);
    else assert.equal(result.nodeBin, discovered.execPath);
    assert.deepEqual(operations(f), ["discovery"]);
  });
}

test("issue #1316: Windows Node resolution rejects a missing persisted execPath", async () => {
  const f = recorder();
  const result = await resolveRemoteNodeBin({ profile: { ...profile, detectedRemoteNodeBin: undefined }, spawn: f.spawn, buildSshArgs: () => ["remote.test"] });
  assert.equal(result.reason, "windows_node_changed"); assert.deepEqual(operations(f), ["discovery"]);
});
test("issue #1316: Windows direct deployment requires a platform snapshot before any SSH", async () => {
  for (const shell of ["windows-cmd", "unknown", "posix"]) {
    const f = deployment(null, { platformSnapshot: undefined });
    f.options.deps.detectRemoteShell = async () => ({ shell });
    const result = await deploy(f.options);
    assert.equal(result.reason, "windows_platform_snapshot_required");
    assert.match(result.message, /Probe the remote platform/); assert.equal(f.calls.length, 0);
  }
});
test("issue #1316: Windows deployment accepts an empty nullable host prefix", async () => {
  const f = deployment(null, { profile: { ...profile, hostPrefix: null } });
  assert.equal((await deploy(f.options)).ok, true); assert.equal(operations(f).includes("writeHostPrefix"), false);
});
test("issue #1316: Windows installer timeout requires inspection even with a known SSH exit", async () => {
  const f = deployment((call) => call.operation === "runInstaller" ? { code: 1, stderr: "installer_result_unknown: install.js" } : null);
  await assert.rejects(deploy(f.options), { code: "installer_result_unknown", recoveryCode: "manual_lock_inspection_required" });
  assert.equal(operations(f).at(-1), "runInstaller");
});

for (const script of ["install.js", "copilot-install.js"]) {
  for (const verified of [false, undefined]) {
    test(`issue #1316: Windows ${script} rejects installer verification ${String(verified)}`, async () => {
      const f = deployment((call) => call.operation === "runInstaller" && call.frame.args.script === script
        ? { code: 0, stdout: JSON.stringify({ ok: true, ...(verified === undefined ? {} : { verified }) }) } : null);
      const result = await deploy(f.options);
      assert.equal(result.ok, false);
      assert.equal(result.transactionReady, undefined);
      const steps = Object.fromEntries(f.steps);
      assert.equal(steps[script === "install.js" ? "installClaude" : "installCopilot"].status, "failed");
      const lastInstaller = f.calls.findLastIndex((call) => call.operation === "runInstaller");
      assert.equal(f.calls[lastInstaller].frame.args.script, script);
      assert.deepEqual(operations(f).slice(lastInstaller + 1), ["releaseLock"]);
      assert.equal(steps.claudePermission, undefined);
    });
  }
}
test("issue #1316: Windows scp failure stops before promotion and marks hook files failed", async () => {
  const f = deployment((call) => call.operation === "upload" ? { code: 1, stderr: "upload failed" } : null);
  const result = await deploy(f.options);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "hook_upload_failed");
  assert.equal(result.transactionReady, undefined);
  assert.equal(Object.fromEntries(f.steps).hookFiles.status, "failed");
  assert.deepEqual(operations(f).slice(-2), ["upload", "releaseLock"]);
  assert.equal(operations(f).includes("promoteMany"), false);
});
test("issue #1316: Windows promotion refusal marks hook files failed and skips all installers", async () => {
  const f = deployment((call) => call.operation === "promoteMany" ? { code: 0, stdout: '{"ok":false,"reason":"hash_mismatch"}' } : null);
  const result = await deploy(f.options);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "hash_mismatch");
  assert.equal(result.transactionReady, undefined);
  assert.equal(Object.fromEntries(f.steps).hookFiles.status, "failed");
  assert.deepEqual(operations(f).slice(-2), ["promoteMany", "releaseLock"]);
  assert.equal(operations(f).includes("runInstaller"), false);
});
test("issue #1316: Windows nonzero transport exit cannot be overridden by an ok stdout frame", async () => {
  const f = deployment((call) => call.operation === "mkdir" ? { code: 1, stdout: '{"ok":true}' } : null);
  const result = await deploy(f.options);
  assert.equal(result.ok, false);
  assert.equal(result.step, "mkdir");
  assert.equal(result.transactionReady, undefined);
  assert.deepEqual(operations(f), ["acquireLock", "preflight", "mkdir", "releaseLock"]);
  assert.deepEqual(f.steps, []);
});
test("issue #1316: Windows deployment reads carry false mutation flags", async () => {
  const f = deployment();
  assert.equal((await deploy(f.options)).ok, true);
  for (const operation of ["preflight", "readClaudePermission"]) {
    assert.deepEqual(f.flags.filter((flag) => flag.operation === operation), [{ operation, mutation: false }]);
  }
});
test("issue #1316: Windows uninstall flags classify discovery and identity reads separately from writes", async () => {
  const f = recorder();
  assert.equal((await uninstallRemoteIntegrations({ profile, deps: f.deps })).ok, true);
  assert.deepEqual(f.flags, [
    { operation: "discovery", mutation: false },
    { operation: "readIdentity", mutation: false },
    { operation: "acquireLock", mutation: true },
    { operation: "preflight", mutation: false },
    { operation: "readIdentity", mutation: false },
    { operation: "runInstaller", mutation: true },
    { operation: "runInstaller", mutation: true },
    { operation: "uninstallCodexOwned", mutation: true },
    { operation: "dshCleanupPreflight", mutation: false },
    { operation: "removeFiles", mutation: true },
    { operation: "releaseLock", mutation: true },
  ]);
});
test("issue #1316: Windows retirement flags require a read-only discovery and mutating finalization", async () => {
  const f = recorder();
  assert.equal((await finalizeRetiredRemoteLayout({ profile, deps: f.deps })).ok, true);
  assert.deepEqual(f.flags, [
    { operation: "discovery", mutation: false },
    { operation: "acquireLock", mutation: true },
    { operation: "finalizeIdentity", mutation: true },
    { operation: "releaseLock", mutation: true },
  ]);
});
for (const script of ["install.js", "copilot-install.js"]) {
  test(`issue #1316: Windows uninstall preserves payload when ${script} fails`, async () => {
    const f = recorder((call) => call.operation === "runInstaller" && call.frame.args.script === script
      ? { code: 0, stdout: '{"ok":false,"reason":"installer_failed","status":9}' } : null);
    const result = await uninstallRemoteIntegrations({ profile, deps: f.deps });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "installer_failed");
    assert.equal(operations(f).includes("removeFiles"), false);
    const index = f.calls.findIndex((call) => call.operation === "runInstaller" && call.frame.args.script === script);
    assert.deepEqual(operations(f).slice(index + 1), ["releaseLock"]);
  });
}
test("issue #1316: Windows uninstall without an identity stops before any write or lock", async () => {
  const f = recorder((call) => call.operation === "readIdentity" ? { code: 0, stdout: '{"identity":null}' } : null);
  const result = await uninstallRemoteIntegrations({ profile, deps: f.deps });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ownership_identity_missing");
  assert.deepEqual(operations(f), ["discovery", "readIdentity"]);
  assert.equal(f.flags.some((flag) => flag.mutation), false);
});
for (const response of [{ code: 1, stdout: JSON.stringify(node) }, { code: 0, stdout: "not JSON" }]) {
  for (const fn of [uninstallRemoteIntegrations, finalizeRetiredRemoteLayout]) {
    test(`issue #1316: Windows ${fn.name} discovery failure ${response.code}/${response.stdout} performs no write`, async () => {
      const f = recorder(() => response);
      const result = await fn({ profile, deps: f.deps });
      assert.equal(result.ok, false);
      assert.equal(result.skipped, true);
      assert.equal(result.reason, "platform_changed");
      assert.deepEqual(operations(f), ["discovery"]);
      assert.deepEqual(f.flags, [{ operation: "discovery", mutation: false }]);
    });
  }
}

test("issue #1316: Windows Copilot BOM refusal fails the identity step instead of committing", async () => {
  const f = deployment((call) => call.operation === "runInstaller" && call.frame.args.script === "copilot-install.js"
    ? { code: 1, stderr: "copilot_config_bom: C:\\Users\\remote\\.copilot\\hooks\\hooks.json" } : null);
  const result = await deploy(f.options);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "copilot_config_bom");
  assert.equal(result.transactionReady, undefined);
  assert.equal(Object.fromEntries(f.steps).installCopilot.status, "failed");
  assert.equal(Object.fromEntries(f.steps).claudePermission, undefined);
  assert.deepEqual(operations(f).slice(-2), ["runInstaller", "releaseLock"]);
});

for (const fn of [uninstallRemoteIntegrations, finalizeRetiredRemoteLayout]) {
  test(`issue #1316: Windows ${fn.name} accepts discovery home paths differing only in case`, async () => {
    const f = recorder((call) => call.operation === "discovery"
      ? { code: 0, stdout: JSON.stringify({ ...node, homedir: node.homedir.toUpperCase() }) } : null);
    const result = await fn({ profile, deps: f.deps });
    assert.equal(result.ok, true);
    assert.equal(result.layout.remoteHome, profile.remoteHome);
    assert.equal(operations(f).includes("acquireLock"), true);
    assert.equal(operations(f).at(-1), "releaseLock");
  });
}
test("issue #1316: Windows cleanup stops when its identity disappears after acquiring the lease", async () => {
  let reads = 0;
  const f = recorder((call) => call.operation === "readIdentity" && ++reads === 2
    ? { code: 0, stdout: '{"identity":null}' } : null);
  const result = await uninstallRemoteIntegrations({ profile, deps: f.deps });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ownership_identity_missing");
  assert.equal(reads, 2);
  assert.deepEqual(operations(f), ["discovery", "readIdentity", "acquireLock", "preflight", "readIdentity", "releaseLock"]);
  assert.deepEqual(f.flags.filter((flag) => flag.mutation), [
    { operation: "acquireLock", mutation: true },
    { operation: "releaseLock", mutation: true },
  ]);
});
test("issue #1316: Windows deployment rejects a POSIX snapshot home before any remote operation", async () => {
  const f = deployment(null, { platformSnapshot: { ...snapshot, node: { ...node, homedir: "/home/remote" } } });
  const result = await deploy(f.options);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "remote_home_invalid");
  assert.equal(result.transactionReady, undefined);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.flags, []);
  assert.deepEqual(f.stages, []);
  assert.deepEqual(f.steps, []);
});

test("issue #1316: Windows deploy progress localizes platform, skipped agents and quota exactly once", async () => {
  const f = deployment();
  assert.equal((await deploy(f.options)).ok, true);
  for (const [step, hint] of [
    ["remote-shell", "remoteSshWindowsPlatform"],
    ["install-hermes", "remoteSshWindowsHermesSkipped"], ["install-claude", "remoteSshWindowsQuotaUnsupported"],
  ]) assert.equal(f.events.filter((event) => event.step === step && event.status === "ok" && event.hint === hint).length, 1, hint);
  assert.equal(f.events.some((event) => event.step === "install-codex" && event.hint), false);
});

for (const [reason, hint] of [
  ["local_clawd_conflict", "remoteSshErrWindowsLocalClawdRunning"],
  ["runtime_owner_unknown", "remoteSshErrWindowsLocalClawdUnknown"],
  ["runtime_invalid", "remoteSshErrWindowsLocalClawdUnknown"],
  ["copilot_config_bom", "remoteSshErrCopilotConfigBom"],
]) {
  test(`issue #1316: Windows ${reason} reaches both failure result and progress hint`, async () => {
    const f = deployment((call) => call.operation === "preflight" ? { code: 1, stderr: `${reason}: C:\\config` } : null);
    const result = await deploy(f.options);
    assert.equal(result.reason, reason);
    assert.equal(result.hint, hint);
    assert.equal(f.events.find((event) => event.status === "fail").hint, hint);
  });
}

test("issue #1316: win-ops execPath exit 7 keeps ordinary refusal parsing and gets Node changed hint", async () => {
  const f = deployment((call) => call.operation === "preflight" ? { code: 7, stderr: "Remote Node execPath changed; redeploy required\n" } : null);
  const result = await deploy(f.options);
  assert.equal(result.reason, "windows_node_changed");
  assert.equal(result.hint, "remoteSshErrWindowsNodeChanged");
});

test("issue #1316: PowerShell installer path refusal gets a localized actionable hint", async () => {
  const f = deployment((call) => call.operation === "runInstaller" ? {
    code: 0, stdout: JSON.stringify({ ok: false, reason: "installer_failed",
      stderrTail: 'Windows remote PowerShell hooks cannot use paths containing $, backtick or double quotes: C:\\bad$path' }),
  } : null);
  const result = await deploy(f.options);
  assert.equal(result.reason, "windows_powershell_path_unsupported");
  assert.equal(result.hint, "remoteSshErrWindowsPowerShellPath");
  assert.equal(f.events.find((event) => event.status === "fail").hint, result.hint);
});

test("issue #1316: Windows isolated mode and unavailable Node failures include localized hints", async () => {
  for (const [extra, hint] of [
    [{ profile: { ...profile, runtimeMode: "profile-isolated" } }, "remoteSshErrWindowsProfileIsolatedUnsupported"],
    [{ platformSnapshot: { ...snapshot, remoteNode: { ok: false } } }, "remoteSshErrWindowsNodeMissing"],
  ]) {
    const f = deployment(undefined, extra);
    const result = await deploy(f.options);
    assert.equal(result.hint, hint);
    assert.equal(f.events.find((event) => event.status === "fail").hint, hint);
  }
});

test("issue #1316: acquireLock exit 7 returns Node changed before acquiring any lease", async () => {
  const f = deployment((call) => call.operation === "acquireLock" ? { code: 7, stderr: "Remote Node execPath changed; redeploy required" } : null);
  const result = await deploy(f.options);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "windows_node_changed");
  assert.equal(result.hint, "remoteSshErrWindowsNodeChanged");
  assert.equal(result.recoveryCode, undefined);
  assert.deepEqual(f.stages, ["acquire-attempted", "before-acquire"]);
  assert.deepEqual(operations(f), ["acquireLock"]);
  assert.equal(f.events.find((event) => event.step === "lock" && event.status === "fail").hint, result.hint);
});

test("issue #1316: releaseLock exit 7 still requires manual lock inspection", async () => {
  const f = deployment((call) => call.operation === "releaseLock" ? { code: 7, stderr: "Remote Node execPath changed; redeploy required" } : null);
  await assert.rejects(deploy(f.options), { recoveryCode: "manual_lock_inspection_required" });
  assert.deepEqual(f.stages, ["acquire-attempted", "lock-owned"]);
  assert.equal(f.events.some((event) => event.step === "lock-release" && event.status === "fail"), true);
});

test("issue #1316: Codex installer refusals map to their own reasons and hints", async () => {
  for (const [tail, reason, hint] of [
    ["codex-windows-remote-unsafe-path: node path contains $", "windows_codex_powershell_path_unsupported", "remoteSshErrWindowsCodexPowerShellPath"],
    ["codex-windows-remote-ownership-conflict: SessionStart has a conflict Codex hook", "windows_codex_ownership_conflict", "remoteSshErrWindowsCodexOwnershipConflict"],
  ]) {
    const f = deployment((call) => call.operation === "runInstaller" && call.frame.args.script === "codex-install.js"
      ? { code: 0, stdout: JSON.stringify({ ok: false, reason: "installer_failed", stderrTail: tail }) } : null);
    const result = await deploy(f.options);
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.equal(result.hint, hint);
    assert.equal(Object.fromEntries(f.steps).installCodex.status, "failed");
    assert.equal(f.events.find((event) => event.status === "fail").hint, hint);
  }
});

test("issue #1316: a disabled Codex hooks feature reports its dedicated reason and hint", async () => {
  for (const failure of [
    { code: 1, stderr: "windows_codex_hooks_disabled: C:\\Users\\remote\\.codex\\config.toml" },
    { code: 0, stdout: JSON.stringify({ ok: false, reason: "installer_failed",
      stderrTail: "codex-windows-remote-hooks-disabled: [features].hooks is false" }) },
  ]) {
    const f = deployment((call) => call.operation === "runInstaller" && call.frame.args.script === "codex-install.js"
      ? failure : null);
    const result = await deploy(f.options);
    assert.equal(result.reason, "windows_codex_hooks_disabled");
    assert.equal(result.hint, "remoteSshErrWindowsCodexHooksDisabled");
    assert.equal(Object.fromEntries(f.steps).installCodex.status, "failed");
  }
});

test("issue #1316: Windows uninstall surfaces the Codex cleanup reason and hint", async () => {
  const detail = "2 conflicting Codex hook entries remain in hooks.json";
  const f = recorder((call) => call.operation === "uninstallCodexOwned"
    ? { code: 0, stdout: JSON.stringify({ ok: false, reason: "windows_codex_cleanup_incomplete", conflicts: 2, message: detail }) } : null);
  const result = await uninstallRemoteIntegrations({ profile, deps: f.deps });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "windows_codex_cleanup_incomplete");
  assert.equal(result.hint, "remoteSshErrWindowsCodexCleanupIncomplete");
  assert.match(result.stderr, /2 conflicting Codex hook entries remain/);
  assert.match(result.message, /2 conflicting Codex hook entries remain/);
  assert.equal(operations(f).includes("removeFiles"), false);
  assert.equal(operations(f).at(-1), "releaseLock");
});

test("issue #1316: Windows uninstall skips Codex cleanup cleanly when hooks.json is absent", async () => {
  const f = recorder((call) => call.operation === "uninstallCodexOwned"
    ? { code: 0, stdout: JSON.stringify({ ok: true, skipped: true, removed: 0, conflicts: 0, changed: false }) } : null);
  const result = await uninstallRemoteIntegrations({ profile, deps: f.deps });
  assert.equal(result.ok, true);
  assert.equal(operations(f).includes("removeFiles"), true);
});

test("issue #1316: a successful Windows deployment reports the Codex hooks installer result", async () => {
  const f = deployment();
  assert.equal((await deploy(f.options)).codexHooksInstalled, true);
});

// ── DSH deployment wiring ──
function dshPreflightDetail(overrides = {}) {
  return {
    ok: true, identity: true, claudePresent: true, copilotPresent: true, codexPresent: true,
    legacyMonitorPresent: true, hermesPresent: false, legacyTraces: 0, legacyConfigTraces: 0,
    dsh: {
      status: "present", appRoot: "C:\\Users\\remote\\AppData\\Local\\Programs\\DeepSeek Harness",
      checkedPaths: [], reason: null, profileInitialized: true, profileReadable: true,
      localClawdLinked: false,
      remoteRoot: "C:\\Users\\remote\\.clawd\\remote-integrations\\deepseek-harness",
      remoteRootExists: false,
      ...overrides,
    },
  };
}

function dshInstallerDetail(argv, overrides = {}) {
  const inspect = argv.includes("--remote-inspect");
  if (inspect) {
    return {
      ok: true, status: 0,
      installerResult: {
        schemaVersion: 1, operation: "remote-inspect", status: "ok", phase: "installed",
        desktop: {
          kind: "ours", withinDeployment: true, hashMatches: true,
          manifestDeploymentMatches: true, incomplete: false, residuePresent: false,
        },
      },
      ...overrides,
    };
  }
  return {
    ok: true, status: 0,
    installerResult: { schemaVersion: 1, operation: "remote-install", status: "ok", restartRequired: true },
    ...overrides,
  };
}

test("DSH remote: deploy uploads assets, installs through the executor, reads back and reports restart", async () => {
  const f = deployment((call) => {
    if (call.operation === "preflight") return { code: 0, stdout: `banner\n${JSON.stringify(dshPreflightDetail())}\n` };
    if (call.operation === "runInstallerAsUser") {
      return { code: 0, stdout: `banner\n${JSON.stringify(dshInstallerDetail(call.frame.args.argv))}\n` };
    }
    return null;
  });
  const result = await deploy(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.dshBridgeInstalled, true);
  assert.equal(result.dshRestartRequired, true);
  const runs = f.calls.filter((call) => call.operation === "runInstallerAsUser").map((call) => call.frame.args);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((args) => args.script), ["dsh-install.js", "dsh-install.js"]);
  assert.equal(runs[0].argv.includes("--clawd-version"), true);
  assert.equal(runs[0].argv.includes("--allow-local-migration"), false);
  assert.equal(runs[0].argv.includes("--remote-inspect"), false);
  assert.equal(runs[1].argv.includes("--remote-inspect"), true);
  assert.equal(runs[0].dshHome, path.win32.join(node.homedir, ".dsh"));
  assert.ok(f.calls.some((call) => call.operation === "promoteMany" && call.frame.args.staging));
  assert.ok(f.calls.some((call) => call.operation === "mkdir" && call.frame.args.directories.some((dir) => dir.includes("dsh-clawd-bridge"))));
  const dshPromotion = f.calls.filter((call) => call.operation === "promoteMany").map((call) => call.frame.args).at(-1);
  assert.ok(Object.keys(dshPromotion.hashes).includes("dsh-clawd-bridge/lib/index.js"));
  assert.ok(Object.keys(dshPromotion.hashes).includes("dsh-remote-task.js"));
});

test("DSH remote: deployment install and readback use the preflight DSH_HOME", async () => {
  const customHome = "C:\\Users\\remote\\custom-dsh";
  const f = deployment((call) => {
    if (call.operation === "preflight") {
      return { code: 0, stdout: JSON.stringify(dshPreflightDetail({ dshHome: customHome })) };
    }
    if (call.operation === "runInstallerAsUser") {
      return { code: 0, stdout: JSON.stringify(dshInstallerDetail(call.frame.args.argv)) };
    }
    return null;
  });
  const result = await deploy(f.options);
  assert.equal(result.ok, true);
  const runs = f.calls.filter((call) => call.operation === "runInstallerAsUser").map((call) => call.frame.args);
  assert.equal(runs.length, 2);
  for (const args of runs) assert.equal(args.dshHome, customHome);
});

test("DSH remote: unreadable registry without any DSH trace continues with a warning", async () => {
  const f = deployment((call) => call.operation === "preflight"
    ? { code: 0, stdout: JSON.stringify(dshPreflightDetail({ status: "absent", profileInitialized: false, reason: "registry-unreadable" })) }
    : null);
  const result = await deploy(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.dshBridgeInstalled, false);
  assert.equal(result.dshDiscoveryWarning.hint, "remoteSshWarnDshDiscoveryIncomplete");
  assert.equal(operations(f).includes("runInstallerAsUser"), false);
});

test("DSH remote: deploy without DSH keeps the existing operation sequence", async () => {
  const f = deployment((call) => {
    if (call.operation === "preflight") {
      return { code: 0, stdout: `banner\n${JSON.stringify(dshPreflightDetail({ status: "absent", profileInitialized: false }))}\n` };
    }
    return null;
  });
  const result = await deploy(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.dshBridgeInstalled, false);
  assert.equal(operations(f).includes("runInstallerAsUser"), false);
  assert.deepEqual(operations(f), ["acquireLock", "preflight", "mkdir", "writeIdentity", "writeMarker", "upload", "promoteMany", "writeHostPrefix", "runInstaller", "runInstaller", "runInstaller", "readClaudePermission", "releaseLock"]);
});

test("DSH remote: a present desktop app with an uninitialized profile is not applicable", async () => {
  const f = deployment((call) => call.operation === "preflight"
    ? { code: 0, stdout: JSON.stringify(dshPreflightDetail({ profileInitialized: false, localClawdLinked: false })) }
    : null);
  const result = await deploy(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.dshBridgeInstalled, false);
  assert.equal(operations(f).includes("runInstallerAsUser"), false);
});

test("DSH remote: deploy rejects ambiguous or unreadable DSH discovery", async () => {
  for (const [overrides, reason] of [
    [{ status: "ambiguous" }, "dsh_desktop_ambiguous"],
    [{ status: "unknown" }, "dsh_desktop_unreadable"],
    [{ status: "present", profileReadable: false }, "dsh_profile_unreadable"],
  ]) {
    const f = deployment((call) => call.operation === "preflight"
      ? { code: 0, stdout: JSON.stringify(dshPreflightDetail(overrides)) }
      : null);
    assert.equal((await deploy(f.options)).reason, reason);
    assert.equal(operations(f).includes("runInstallerAsUser"), false);
  }
});

test("DSH remote: preflight link and DSH_HOME rejections happen before any DSH write", async () => {
  for (const [overrides, reason] of [
    [{ status: "unknown", reason: "dsh-home-ambiguous" }, "dsh_home_ambiguous"],
  ]) {
    const f = deployment((call) => call.operation === "preflight"
      ? { code: 0, stdout: JSON.stringify(dshPreflightDetail(overrides)) }
      : null);
    assert.equal((await deploy(f.options)).reason, reason);
    assert.equal(operations(f).includes("runInstallerAsUser"), false);
    assert.equal(operations(f).includes("promoteMany"), false);
  }
  const f = deployment((call) => call.operation === "preflight"
    ? { code: 1, stderr: "path_link: C:\\Users\\remote\\.clawd\\remote-integrations" }
    : null);
  assert.equal((await deploy(f.options)).reason, "path_link");
  assert.equal(operations(f).includes("runInstallerAsUser"), false);
});

test("DSH remote: a local DSH link requires confirmation and then passes the migration flag", async () => {
  const local = dshPreflightDetail({ localClawdLinked: true });
  const refused = deployment((call) => call.operation === "preflight"
    ? { code: 0, stdout: JSON.stringify(local) }
    : null);
  const refusedResult = await deploy(refused.options);
  assert.equal(refusedResult.reason, "dsh_local_migration_required");
  assert.equal(operations(refused).includes("runInstallerAsUser"), false);

  const accepted = deployment((call) => {
    if (call.operation === "preflight") return { code: 0, stdout: JSON.stringify(local) };
    if (call.operation === "runInstallerAsUser") {
      return { code: 0, stdout: JSON.stringify(dshInstallerDetail(call.frame.args.argv)) };
    }
    return null;
  });
  const acceptedResult = await deploy({ ...accepted.options, legacyMigrationConfirmed: true });
  assert.equal(acceptedResult.ok, true);
  const installArgs = accepted.calls.find((call) => call.operation === "runInstallerAsUser").frame.args.argv;
  assert.equal(installArgs.includes("--allow-local-migration"), true);
});

test("DSH remote: install or readback failure aborts the deployment before commit", async () => {
  const installFailed = deployment((call) => {
    if (call.operation === "preflight") return { code: 0, stdout: JSON.stringify(dshPreflightDetail()) };
    if (call.operation === "runInstallerAsUser") {
      return { code: 0, stdout: JSON.stringify({ ok: false, status: 1, reason: "bridge-ownership-conflict", installerResult: { schemaVersion: 1, operation: "remote-install", status: "error", reason: "bridge-ownership-conflict" } }) };
    }
    return null;
  });
  assert.equal((await deploy(installFailed.options)).reason, "bridge-ownership-conflict");

  const migrationFailed = deployment((call) => {
    if (call.operation === "preflight") return { code: 0, stdout: JSON.stringify(dshPreflightDetail()) };
    if (call.operation === "runInstallerAsUser") {
      return { code: 0, stdout: JSON.stringify({ ok: false, status: 1, installerResult: { schemaVersion: 1, operation: "remote-install", status: "error", reason: "local-migration-required" } }) };
    }
    return null;
  });
  assert.equal((await deploy(migrationFailed.options)).reason, "dsh_local_migration_required");

  const readbackFailed = deployment((call) => {
    if (call.operation === "preflight") return { code: 0, stdout: JSON.stringify(dshPreflightDetail()) };
    if (call.operation === "runInstallerAsUser") {
      const detail = dshInstallerDetail(call.frame.args.argv);
      if (call.frame.args.argv.includes("--remote-inspect")) detail.installerResult.desktop.kind = "foreign";
      return { code: 0, stdout: JSON.stringify(detail) };
    }
    return null;
  });
  assert.equal((await deploy(readbackFailed.options)).reason, "dsh_readback_failed");

  const unknown = deployment((call) => {
    if (call.operation === "preflight") return { code: 0, stdout: JSON.stringify(dshPreflightDetail()) };
    if (call.operation === "runInstallerAsUser") {
      return { code: 0, stdout: JSON.stringify({ ok: false, reason: "installer_result_unknown" }) };
    }
    return null;
  });
  await assert.rejects(deploy(unknown.options), (err) => err && err.code === "installer_result_unknown");
});

test("DSH remote: DSH asset upload failure aborts the deployment", async () => {
  const f = deployment((call) => {
    if (call.operation === "preflight") return { code: 0, stdout: JSON.stringify(dshPreflightDetail()) };
    if (call.tool === "scp" && String(call.args.at(-1)).includes("-dsh/")) {
      return { code: 1, stderr: "upload failed" };
    }
    return null;
  });
  const result = await deploy(f.options);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "dsh_asset_upload_failed");
  assert.equal(operations(f).includes("runInstallerAsUser"), false);
});

test("DSH remote: readback requires every ownership, integrity, phase and residue condition", async () => {
  for (const mutate of [
    (detail) => { delete detail.installerResult.desktop.hashMatches; },
    (detail) => { detail.installerResult.phase = "installing"; },
    (detail) => { detail.installerResult.desktop.withinDeployment = false; },
    (detail) => { detail.installerResult.desktop.manifestDeploymentMatches = false; },
    (detail) => { detail.installerResult.desktop.residuePresent = true; },
  ]) {
    const f = deployment((call) => {
      if (call.operation === "preflight") return { code: 0, stdout: JSON.stringify(dshPreflightDetail()) };
      if (call.operation === "runInstallerAsUser") {
        const detail = dshInstallerDetail(call.frame.args.argv);
        if (call.frame.args.argv.includes("--remote-inspect")) mutate(detail);
        return { code: 0, stdout: JSON.stringify(detail) };
      }
      return null;
    });
    assert.equal((await deploy(f.options)).reason, "dsh_readback_failed");
  }
});

test("DSH remote: cleanup removes assets after a successful owned uninstall", async () => {
  const f = recorder((call) => {
    if (call.operation === "dshCleanupPreflight") {
      return { code: 0, stdout: JSON.stringify({ ok: true, assetPresent: true, recordExists: true, recordReadable: true, recordPhase: "installed", installerCapable: true, installerLoadFailed: false, desktop: { state: "present", referenced: true }, web: { state: "present", referenced: false }, remoteRoot: "C:\\Users\\remote\\.clawd\\remote-integrations\\deepseek-harness", installRoot: "C:\\Users\\remote\\.clawd\\remote-integrations\\deepseek-harness\\" + profile.installId }) };
    }
    if (call.operation === "runInstallerAsUser") {
      return { code: 0, stdout: JSON.stringify({ ok: true, status: 0, installerResult: { schemaVersion: 1, operation: "remote-uninstall-owned", status: "ok", registrationRemoved: true, conflicts: [] } }) };
    }
    return null;
  });
  const result = await uninstallRemoteIntegrations({ profile: profile, deps: f.deps });
  assert.equal(result.ok, true);
  assert.equal(result.dshBridgeRemoved, true);
  assert.ok(operations(f).includes("dshCleanupPreflight"));
  assert.ok(operations(f).includes("runInstallerAsUser"));
  assert.ok(operations(f).includes("rmdirEmpty"));
  const preflightCall = f.calls.find((call) => call.operation === "dshCleanupPreflight");
  const { BRIDGE_SOURCE_FILES } = require("../hooks/dsh-install");
  const expectedAssets = [
    "dsh-install.js", "dsh-notices.js", "dsh-remote-task.js",
    ...BRIDGE_SOURCE_FILES.map((name) => `dsh-clawd-bridge/${name}`),
  ];
  assert.deepEqual(preflightCall.frame.args.assets, expectedAssets);
});

test("DSH remote: cleanup conflict, unreadable installer or unknown result does not remove hook files", async () => {
  const cases = [
    {
      name: "conflict",
      respond(call) {
        if (call.operation === "dshCleanupPreflight") {
          return { code: 0, stdout: JSON.stringify({ ok: true, assetPresent: true, recordExists: true, recordReadable: true, recordPhase: "installed", installerCapable: true, installerLoadFailed: false, desktop: { state: "present", referenced: true }, web: { state: "present", referenced: false } }) };
        }
        if (call.operation === "runInstallerAsUser") {
          return { code: 0, stdout: JSON.stringify({ ok: true, status: 0, installerResult: { schemaVersion: 1, operation: "remote-uninstall-owned", status: "ok", registrationRemoved: true, conflicts: [{ profile: "desktop" }] } }) };
        }
        return null;
      },
    },
    {
      name: "installer unreadable",
      respond(call) {
        if (call.operation === "dshCleanupPreflight") {
          return { code: 0, stdout: JSON.stringify({ ok: true, assetPresent: true, recordExists: true, recordReadable: true, recordPhase: "installed", installerCapable: false, installerLoadFailed: true, desktop: { state: "present", referenced: false }, web: { state: "missing", referenced: false } }) };
        }
        return null;
      },
    },
    {
      name: "unknown",
      respond(call) {
        if (call.operation === "dshCleanupPreflight") {
          return { code: 0, stdout: JSON.stringify({ ok: true, assetPresent: true, recordExists: true, recordReadable: true, recordPhase: "installed", installerCapable: true, installerLoadFailed: false, desktop: { state: "present", referenced: true }, web: { state: "present", referenced: false } }) };
        }
        if (call.operation === "runInstallerAsUser") {
          return { code: 0, stdout: JSON.stringify({ ok: false, reason: "installer_result_unknown" }) };
        }
        return null;
      },
    },
  ];
  for (const item of cases) {
    const f = recorder(item.respond);
    if (item.name === "unknown") {
      // An unknown installer result keeps the deployment lease and evidence.
      await assert.rejects(
        uninstallRemoteIntegrations({ profile: profile, deps: f.deps }),
        (err) => err && err.code === "installer_result_unknown",
      );
    } else {
      const result = await uninstallRemoteIntegrations({ profile: profile, deps: f.deps });
      assert.equal(result.ok, false, item.name);
      assert.equal(result.reason, "windows_dsh_cleanup_incomplete", item.name);
    }
    const hookRemoval = f.calls.filter((call) => call.operation === "removeFiles"
      && call.frame.args.files.some((file) => file.endsWith("clawd-hook.js")));
    assert.equal(hookRemoval.length, 0, item.name);
  }
});

test("DSH remote: historical cleanup uses read-only reference checks when the installer cannot uninstall", async () => {
  const clean = recorder((call) => call.operation === "dshCleanupPreflight"
    ? { code: 0, stdout: JSON.stringify({ ok: true, assetPresent: true, assetUnreadable: false, recordExists: false, recordReadable: true, recordInvalid: false, recordPhase: null, installerCapable: false, installerLoadFailed: false, desktop: { state: "missing", referenced: false, unreadable: false }, web: { state: "missing", referenced: false, unreadable: false } }) }
    : null);
  const ok = await uninstallRemoteIntegrations({ profile: profile, deps: clean.deps });
  assert.equal(ok.ok, true);
  assert.equal(ok.dshBridgeRemoved, true);
  assert.equal(operations(clean).includes("runInstallerAsUser"), false);

  for (const refs of [
    { desktop: { state: "present", referenced: true }, web: { state: "missing", referenced: false } },
    { desktop: { state: "missing", referenced: false }, web: { state: "unreadable", referenced: false } },
  ]) {
    const f = recorder((call) => call.operation === "dshCleanupPreflight"
      ? { code: 0, stdout: JSON.stringify({ ok: true, assetPresent: true, assetUnreadable: false, recordExists: false, recordReadable: true, recordInvalid: false, recordPhase: null, installerCapable: false, installerLoadFailed: false, ...refs }) }
      : null);
    const result = await uninstallRemoteIntegrations({ profile: profile, deps: f.deps });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "windows_dsh_cleanup_incomplete");
    assert.equal(f.calls.some((call) => call.operation === "removeFiles"
      && call.frame.args.files.some((file) => file.endsWith("clawd-hook.js"))), false);
  }
});

test("DSH remote: unreadable remote state blocks cleanup without deleting files", async () => {
  for (const state of [
    { recordReadable: false, recordExists: false },
    { recordInvalid: true, recordExists: true, installerCapable: true },
    { assetUnreadable: true, assetPresent: false },
  ]) {
    const f = recorder((call) => {
      if (call.operation === "dshCleanupPreflight") {
        return { code: 0, stdout: JSON.stringify({
          ok: true, assetPresent: false, assetUnreadable: false,
          recordExists: false, recordReadable: true, recordInvalid: false, recordPhase: null,
          installerCapable: false, installerLoadFailed: false,
          desktop: { state: "missing", referenced: false, unreadable: false },
          web: { state: "missing", referenced: false, unreadable: false },
          ...state,
        }) };
      }
      if (call.operation === "runInstallerAsUser") {
        return { code: 0, stdout: JSON.stringify({ ok: true, status: 0, installerResult: { schemaVersion: 1, operation: "remote-uninstall-owned", status: "ok", registrationRemoved: true, conflicts: [] } }) };
      }
      return null;
    });
    const result = await uninstallRemoteIntegrations({ profile, deps: f.deps });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "windows_dsh_cleanup_incomplete");
    assert.equal(f.calls.some((call) => call.operation === "removeFiles"
      && call.frame.args.files.some((file) => file.endsWith("clawd-hook.js"))), false);
  }
});

test("DSH remote: cleanup with assets but no deployment record uses read-only reference checks", async () => {
  const f = recorder((call) => call.operation === "dshCleanupPreflight"
    ? { code: 0, stdout: JSON.stringify({ ok: true, assetPresent: true, recordExists: false, recordReadable: true, recordPhase: null, installerCapable: false, installerLoadFailed: false, desktop: { state: "missing", referenced: false }, web: { state: "missing", referenced: false } }) }
    : null);
  const result = await uninstallRemoteIntegrations({ profile: profile, deps: f.deps });
  assert.equal(result.ok, true);
  assert.equal(result.dshBridgeRemoved, true);
  assert.equal(operations(f).includes("runInstallerAsUser"), false);
});

test("DSH remote: cleanup always performs one DSH read-only check", async () => {
  const f = recorder();
  const result = await uninstallRemoteIntegrations({ profile, deps: f.deps });
  assert.equal(result.ok, true);
  assert.equal(operations(f).filter((operation) => operation === "dshCleanupPreflight").length, 1);
  assert.equal(operations(f).includes("runInstallerAsUser"), false);
});


test("DSH remote: cleanup refuses an unloadable installer with assets but no deployment record", async () => {
  const f = recorder((call) => call.operation === "dshCleanupPreflight"
    ? { code: 0, stdout: JSON.stringify({
      ok: true, assetPresent: true, assetUnreadable: false,
      recordExists: false, recordReadable: true, recordInvalid: false,
      installerCapable: false, installerLoadFailed: true,
      desktop: { state: "missing", referenced: false, unreadable: false },
      web: { state: "missing", referenced: false, unreadable: false },
    }) }
    : null);
  const result = await uninstallRemoteIntegrations({ profile, deps: f.deps });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "windows_dsh_cleanup_incomplete");
  assert.equal(result.hint, "remoteSshErrWindowsDshCleanupIncomplete");
  assert.equal(operations(f).includes("runInstallerAsUser"), false);
  assert.equal(operations(f).includes("removeFiles"), false);
});
