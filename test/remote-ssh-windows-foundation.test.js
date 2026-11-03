"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveRemoteRuntimeLayout, toRemoteSftpPath, remoteLayoutDirectories } = require("../src/remote-ssh-layout");
const schema = require("../src/remote-ssh-profile");
const node = require("../src/remote-ssh-node");
const identity = require("../src/remote-ssh-identity");
const { commandRegistry } = require("../src/settings-actions");
const { __test: deploy } = require("../src/remote-ssh-deploy");
const runtime = require("../src/remote-ssh-runtime");

const profile = { id: "p1", label: "Remote", host: "user@remote", remoteForwardPort: 23333,
  runtimeMode: "account-default", runtimeKey: "account-default", layoutVersion: 1,
  autoStartCodexMonitor: false, connectOnLaunch: false };
const windows = { ...profile, remotePlatform: "win32", remoteHome: "C:\\Users\\remote", detectedRemoteNodeBin: "C:\\Program Files\\nodejs\\node.exe", detectedRemoteNodeVersion: "v20.0.0" };
const posix = { ...profile, remotePlatform: "posix", remoteHome: "/home/remote", detectedRemoteNodeBin: "/usr/bin/node", detectedRemoteNodeVersion: "v20.0.0" };

// Reducers return commits in memory; no settings writer or installer is called.
function settings(initial) {
  let snapshot = { remoteSsh: { profiles: [initial] } };
  return {
    get profile() { return snapshot.remoteSsh.profiles[0]; },
    apply(action, payload) {
      const result = commandRegistry[action](payload, { snapshot });
      if (result.commit) snapshot = { ...snapshot, ...result.commit };
      return result;
    },
  };
}

test("issue #1316: native Windows layout, SFTP paths and mkdirs share one path model", () => {
  const layout = resolveRemoteRuntimeLayout(windows);
  assert.equal(layout.platform, "win32");
  assert.equal(layout.claudeHooksDir, "C:\\Users\\remote\\.claude\\hooks");
  assert.equal(toRemoteSftpPath(layout.claudeHooksDir), "/C:/Users/remote/.claude/hooks");
  assert.equal(toRemoteSftpPath("/home/remote/.claude/hooks"), "/home/remote/.claude/hooks");
  assert.equal(remoteLayoutDirectories(layout).includes(layout.codexHome), false);
  assert.equal(remoteLayoutDirectories(resolveRemoteRuntimeLayout(posix)).includes("/home/remote/.codex"), true);
  for (const remoteHome of ["C:relative", "\\\\server\\share", "C:\\", "C:\\Users\\..\\remote", "C:\\Users\\bad\nname"]) {
    assert.throws(() => resolveRemoteRuntimeLayout({ remoteHome }), /remoteHome/);
  }
});

test("issue #1316: platform-aware schema preserves Windows paths and the old POSIX default", () => {
  const clean = schema.sanitizeProfile(windows);
  assert.equal(clean.remotePlatform, "win32");
  assert.equal(clean.remoteHome, windows.remoteHome);
  assert.equal(clean.detectedRemoteNodeBin, windows.detectedRemoteNodeBin);
  assert.equal(schema.validateProfile(windows).status, "ok");
  assert.equal(schema.validateProfile({ ...windows, remotePlatform: "posix" }).status, "error");
  assert.equal(schema.validateProfile({ ...posix, remotePlatform: "win32" }).status, "error");
  assert.equal(schema.sanitizeProfile({ ...windows, remotePlatform: "other" }), null);
  const legacy = schema.sanitizeProfile({ ...profile, remoteHome: posix.remoteHome, detectedRemoteNodeBin: posix.detectedRemoteNodeBin });
  assert.equal(Object.hasOwn(legacy, "remotePlatform"), false);
  assert.equal(legacy.remoteHome, posix.remoteHome);
  assert.equal(schema.DEPLOY_TARGET_FIELDS.includes("remotePlatform"), false);
  assert.equal(schema.deployTargetDrift(schema.deployTargetFingerprint(windows), schema.deployTargetFingerprint(posix)), null);
});

test("issue #1316: mixed historical targets validate paths by each record's platform", () => {
  const common = { ...profile, profileId: "p1", installId: "a".repeat(64), deployedAt: 1 };
  const win = { ...common, ...windows, deployedAt: 2 };
  const unix = { ...common, ...posix };
  assert.equal(schema.sanitizeManagedDeployTarget(win).detectedRemoteNodeBin, windows.detectedRemoteNodeBin);
  assert.equal(schema.sanitizeManagedDeployTarget({ ...win, remoteHome: posix.remoteHome }), null);
  const targets = schema.normalizeManagedDeployTargets([unix, win]);
  assert.equal(targets.length, 2);
  assert.deepEqual(targets.map((target) => target.remotePlatform), ["posix", "win32"]);
  assert.notEqual(schema.remoteOwnershipDomainKey(win), schema.remoteOwnershipDomainKey(unix));
  const { remotePlatform, ...legacy } = unix;
  assert.equal(Object.hasOwn(schema.sanitizeManagedDeployTarget(legacy), "remotePlatform"), false);
});

test("issue #1316: Node validation and cache separate explicit Windows and POSIX records", () => {
  node.clearRemoteNodeCache();
  assert.equal(node.isValidRemoteNodeBin(windows.detectedRemoteNodeBin, "win32"), true);
  assert.equal(node.isValidRemoteNodeBin(windows.detectedRemoteNodeBin, "posix"), false);
  assert.equal(node.isValidRemoteNodeBin(posix.detectedRemoteNodeBin, "win32"), false);
  assert.equal(node.getProfileRemoteNodeBin(windows).nodeBin, windows.detectedRemoteNodeBin);
  const win = { ...profile, remotePlatform: "win32" };
  const unix = { ...profile, remotePlatform: "posix" };
  node.setCachedRemoteNodeBin(win, { nodeBin: windows.detectedRemoteNodeBin, version: "v20.0.0" });
  assert.equal(node.getCachedRemoteNodeBin(unix), null);
  node.setCachedRemoteNodeBin(unix, { nodeBin: posix.detectedRemoteNodeBin, version: "v20.0.0" });
  assert.equal(node.getCachedRemoteNodeBin(win).nodeBin, windows.detectedRemoteNodeBin);
  node.clearRemoteNodeCache();
  assert.equal(deploy.hasSecureRemoteOwnership({ ...windows, installId: "a".repeat(64) }), true);
  assert.equal(deploy.hasSecureRemoteOwnership({ ...windows, remotePlatform: "posix", installId: "a".repeat(64) }), false);
});

test("issue #1316: same-platform pending identity transactions reuse the original nonce and steps", () => {
  const store = settings(profile);
  const begin = (remotePlatform) => store.apply("remoteSsh.beginIdentityRotation", { id: "p1", remotePlatform });
  assert.equal(begin("win32").status, "ok");
  const winNonce = store.profile.identityTxn.toNonce;
  assert.equal(store.profile.remotePlatform, undefined);
  const originalTxn = JSON.parse(JSON.stringify(store.profile.identityTxn));
  const retry = begin("win32");
  assert.equal(retry.noop, true);
  assert.equal(retry.commit, undefined);
  assert.equal(store.profile.identityTxn.toNonce, winNonce);
  assert.equal(schema.sanitizeProfile(store.profile).identityTxn.remotePlatform, "win32");
  assert.deepEqual(store.profile.identityTxn, originalTxn);
  const { remotePlatform, ...oldTxn } = originalTxn;
  const oldStore = settings({ ...profile, identityTxn: oldTxn });
  assert.equal(oldStore.apply("remoteSsh.beginIdentityRotation", { id: "p1", remotePlatform: "posix" }).noop, true);
});

test("issue #1316: a platform mismatch without done steps rebuilds the pending identity transaction", () => {
  const txn = identity.createIdentityTxn(profile, { remotePlatform: "win32", now: () => 100, randomBytes: () => Buffer.alloc(16, 1) });
  const originalTxn = JSON.parse(JSON.stringify(txn));
  const store = settings({ ...profile, identityTxn: txn });
  const result = store.apply("remoteSsh.beginIdentityRotation", { id: "p1", remotePlatform: "posix" });
  assert.equal(result.status, "ok");
  assert.equal(result.noop, undefined);
  assert.ok(result.commit);
  assert.equal(result.identityTxn.remotePlatform, "posix");
  assert.equal(store.profile.identityTxn.remotePlatform, "posix");
  assert.notEqual(store.profile.identityTxn.toNonce, txn.toNonce);
  assert.match(store.profile.identityTxn.toNonce, /^[a-f0-9]{32}$/);
  assert.equal(store.profile.identityTxn.fromNonce, null);
  assert.equal(store.profile.identityTxn.runtimeKey, txn.runtimeKey);
  assert.equal(store.profile.identityTxn.layoutVersion, txn.layoutVersion);
  assert.equal(store.profile.identityTxn.startedAt, txn.startedAt);
  assert.equal(store.profile.identityTxn.previousExpiresAt, txn.startedAt + 1);
  assert.ok(Object.values(store.profile.identityTxn.steps).every((step) => step.status === "pending"));
  assert.equal(store.profile.remotePlatform, undefined);
  assert.deepEqual(txn, originalTxn);
});

test("issue #1316: emergency identity recovery mints an unbound transaction and revokes previous nonces", () => {
  const txn = identity.createIdentityTxn(profile, { remotePlatform: "win32", now: () => 100, randomBytes: () => Buffer.alloc(16, 1) });
  assert.equal(txn.remotePlatform, "win32");
  assert.equal(txn.toNonce, "01".repeat(16));
  const emergency = identity.abortIdentityTxnToEmergencyNonce({
    ...profile, remotePlatform: "posix", identityTxn: txn, routingNonce: "a".repeat(32),
    previousNonce: "b".repeat(32), previousExpiresAt: 500, lastDeployedAt: 50, isolatedActive: true,
  }, { now: () => 200, randomBytes: () => Buffer.alloc(16, 2) });
  assert.equal(Object.hasOwn(emergency.identityTxn, "remotePlatform"), false);
  assert.equal(emergency.remotePlatform, "posix");
  assert.equal(emergency.identityTxn.toNonce, "02".repeat(16));
  assert.equal(emergency.identityTxn.fromNonce, null);
  assert.equal(emergency.identityTxn.runtimeKey, profile.runtimeKey);
  assert.equal(emergency.identityTxn.layoutVersion, profile.layoutVersion);
  assert.equal(emergency.identityTxn.phase, "rotating");
  assert.equal(emergency.identityTxn.startedAt, 200);
  assert.equal(emergency.identityTxn.previousExpiresAt, 201);
  assert.ok(Object.values(emergency.identityTxn.steps).every((step) => step.status === "pending"));
  assert.equal(emergency.routingNonce, undefined);
  assert.equal(emergency.previousNonce, undefined);
  assert.equal(emergency.previousExpiresAt, undefined);
  assert.equal(emergency.lastDeployedAt, undefined);
  assert.equal(emergency.isolatedActive, false);
  assert.equal(txn.remotePlatform, "win32");
  assert.equal(txn.toNonce, "01".repeat(16));
});

test("issue #1316: platform mismatch preserves an unfinished identity transaction and its steps", () => {
  for (const remotePlatform of ["posix", "win32"]) {
    const txn = identity.createIdentityTxn(profile, { remotePlatform, now: () => 100, randomBytes: () => Buffer.alloc(16, 1) });
    txn.steps.identity = { status: "done", evidence: "identity verified" };
    const original = JSON.parse(JSON.stringify(txn));
    const store = settings({ ...profile, identityTxn: txn });
    const result = store.apply("remoteSsh.beginIdentityRotation", { id: "p1", remotePlatform: remotePlatform === "posix" ? "win32" : "posix" });
    assert.equal(result.status, "error");
    assert.equal(result.reason, "identity_txn_platform_mismatch");
    assert.equal(result.commit, undefined);
    assert.deepEqual(store.profile.identityTxn, original);
  }
});

test("issue #1316: POSIX assertions reject layouts after spread or a JSON round trip", () => {
  const layout = resolveRemoteRuntimeLayout(posix);
  for (const copy of [{ ...layout }, JSON.parse(JSON.stringify(layout))]) {
    assert.equal(copy.platform, undefined);
    assert.throws(() => deploy.fencedCommand(copy, "a".repeat(32), "/usr/bin/node", "true"), /POSIX remote layout required/);
  }
});

test("issue #1316: the identity reducer rejects a queued target edit before persisting", () => {
  for (const changed of [{ host: "user@new" }, { port: 2200 }, { identityFile: "/tmp/key" }, { sshTransportMode: "serialized" }]) {
    const store = settings({ ...profile, ...changed });
    const result = store.apply("remoteSsh.beginIdentityRotation", { id: "p1", remotePlatform: "posix", expectedTarget: profile });
    assert.equal(result.status, "error");
    assert.equal(result.reason, "profile_changed");
    assert.equal(store.profile.identityTxn, undefined);
  }
});

test("issue #1316: markDeployed persists Windows platform, native Node and historical ownership", () => {
  const store = settings(profile);
  const stamp = (target, deployedAt) => store.apply("remoteSsh.markDeployed", {
    id: "p1", deployedAt, expectedTarget: profile, installId: "a".repeat(64),
    remotePlatform: target.remotePlatform, remoteHome: target.remoteHome,
    remoteNode: { nodeBin: target.detectedRemoteNodeBin, version: target.detectedRemoteNodeVersion },
  });
  assert.equal(stamp(posix, 1).status, "ok");
  assert.equal(stamp(windows, 2).status, "ok");
  assert.equal(store.profile.remotePlatform, "win32");
  assert.equal(store.profile.remoteHome, windows.remoteHome);
  assert.equal(store.profile.detectedRemoteNodeBin, windows.detectedRemoteNodeBin);
  assert.equal(store.profile.managedDeployTargets.length, 2);
  assert.equal(store.profile.managedDeployTargets[1].remotePlatform, "win32");
  assert.equal(store.profile.managedDeployTargets[1].detectedRemoteNodeBin, windows.detectedRemoteNodeBin);
});

test("issue #1316: renderer edits cannot forge platform metadata and cosmetic edits preserve it", () => {
  const store = settings({ ...windows, createdAt: 1 });
  const edited = { ...profile, label: "New label", remotePlatform: "posix" };
  assert.equal(store.apply("remoteSsh.update", edited).status, "ok");
  assert.equal(store.profile.remotePlatform, "win32");
  assert.equal(store.profile.detectedRemoteNodeBin, windows.detectedRemoteNodeBin);
  assert.equal(store.apply("remoteSsh.update", { ...edited, host: "user@new" }).status, "ok");
  assert.equal(store.profile.remotePlatform, undefined);
  const added = commandRegistry["remoteSsh.add"](windows, { snapshot: { remoteSsh: { profiles: [] } } });
  assert.equal(added.commit.remoteSsh.profiles[0].remotePlatform, undefined);
});

test("issue #1316: saved Windows Node detection accepts a native executable path", () => {
  const store = settings(windows);
  assert.equal(store.apply("remoteSsh.markRemoteNode", {
    id: "p1", nodeBin: "D:\\Node\\node.exe", version: "v22.0.0", expectedTarget: windows,
  }).status, "ok");
  assert.equal(store.profile.detectedRemoteNodeBin, "D:\\Node\\node.exe");
});

test("issue #1316: Windows deployment hints have text in all seven Settings languages", () => {
  require("../src/settings-i18n");
  const strings = globalThis.ClawdSettingsI18n.STRINGS;
  assert.deepEqual(Object.keys(strings), ["en", "zh", "zh-TW", "ko", "ja", "pt-BR", "es"]);
  for (const language of Object.values(strings)) {
    for (const key of [
      "remoteSshWindowsPlatform", "remoteSshErrWindowsLocalClawdRunning", "remoteSshErrWindowsLocalClawdUnknown",
      "remoteSshWindowsCodexSkipped", "remoteSshWindowsHermesSkipped", "remoteSshWindowsQuotaUnsupported",
      "remoteSshErrWindowsProfileIsolatedUnsupported", "remoteSshErrRemoteHooksTakenOver", "remoteSshErrRemoteHooksUnverified",
      "remoteSshErrWindowsNodeChanged", "remoteSshErrIdentityTxnPlatformMismatch", "remoteSshErrCopilotConfigBom",
      "remoteSshErrWindowsPowerShellPath",
    ]) assert.ok(typeof language[key] === "string" && language[key].trim(), key);
    assert.equal(Object.hasOwn(language, "remoteSshErrWindowsRemotePending"), false);
    assert.doesNotMatch(language.remoteSshErrWindowsCmdShell, /Git Bash/);
    assert.ok(language.remoteSshErrWindowsNodeMissing);
    assert.match(language.remoteSshErrWindowsNodeMissing, /14/);
  }
});

const winLayout = resolveRemoteRuntimeLayout(windows);
for (const [name, build] of Object.entries({
  fence: () => deploy.fencedCommand(winLayout, "a".repeat(32), "/usr/bin/node", "true"),
  ownership: () => deploy.buildOwnershipPreflightScript({ profile, layout: winLayout, installId: "a".repeat(64) }),
  hermes: () => deploy.buildHermesPreflightLines(winLayout),
  hermesHome: () => deploy.resolveRemoteHermesHome(winLayout),
  legacyMonitor: () => deploy.buildLegacyMonitorCleanupScript(winLayout),
  environment: () => deploy.buildRemoteInstallerEnv(winLayout),
  installerVerification: () => deploy.buildInstallerVerificationCommand("installClaude", winLayout, "/usr/bin/node"),
  monitorVerification: () => deploy.buildMonitorVerificationCommand(winLayout, "/usr/bin/node"),
  monitorStop: () => deploy.secureMonitorStopCommand(winLayout),
  wrapper: () => deploy.buildIsolatedWrapper(winLayout, "/usr/bin/claude", "CLAUDE_CONFIG_DIR", "C:\\Users\\remote\\.claude"),
})) {
  test(`issue #1316: POSIX ${name} builder rejects a Windows layout`, () => assert.throws(build, /POSIX remote layout required/));
}

test("issue #1316: POSIX lock and CLI probe reject Windows before spawning", async () => {
  const options = { profile, layout: winLayout, installId: "a".repeat(64), leaseId: "b".repeat(32), remoteNode: "/usr/bin/node", spawn: () => assert.fail("no POSIX command may run") };
  for (const fn of [deploy.acquireDeployLock, deploy.releaseDeployLock, deploy.probeRemoteCliCapabilities]) {
    await assert.rejects(fn(options), /POSIX remote layout required/);
  }
  await assert.rejects(deploy.resolveRemoteHome({ profile: windows, spawn: options.spawn }), /POSIX remote layout required/);
  assert.throws(() => node.buildRemoteNodeEvalCommand(windows.detectedRemoteNodeBin, ""), /POSIX/);
  assert.throws(() => node.buildRemoteHookNodeCommand(windows.detectedRemoteNodeBin, "install.js"), /POSIX/);
  assert.throws(() => node.buildRemoteHookNodeCommand("/usr/bin/node", "install.js", [], { hooksDir: winLayout.claudeHooksDir }), /POSIX/);
});
