"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const deploy = require("../src/remote-ssh-deploy");
const runtime = require("../src/remote-ssh-runtime");
const node = require("../src/remote-ssh-node");

async function snapshots() {
  const { resolveRemoteRuntimeLayout } = require("../src/remote-ssh-layout");
  const layout = resolveRemoteRuntimeLayout({ remoteHome: "/home/remote", runtimeMode: "account-default" });
  const isolated = resolveRemoteRuntimeLayout({
    remoteHome: "/home/remote", runtimeMode: "profile-isolated", runtimeKey: "runtime_a",
  });
  const profile = {
    id: "p1", host: "user@remote", remoteForwardPort: 23333,
    runtimeMode: "account-default", runtimeKey: "account-default", layoutVersion: 1,
    installId: "a".repeat(64), remoteHome: "/home/remote", remotePlatform: "posix",
  };
  const d = deploy.__test;
  const bin = "/usr/bin/node";
  const lease = "b".repeat(32);
  const out = {};
  function spawn(_command, args) {
    const command = args.at(-1);
    out[command.startsWith("umask") ? "lockAcquire" : "lockRelease"] = command;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  }
  await d.acquireDeployLock({ profile, layout, installId: profile.installId, leaseId: lease, spawn, now: () => 123 });
  await d.releaseDeployLock({ profile, layout, leaseId: lease, remoteNode: bin, spawn });
  out.fence = d.fencedCommand(layout, lease, bin, "mkdir -p /home/remote/.clawd");
  out.ownership = d.buildOwnershipPreflightScript({ profile, layout, installId: profile.installId });
  out.hermes = d.buildHermesPreflightLines(layout).join("");
  out.legacyMonitor = d.buildLegacyMonitorCleanupScript(layout);
  out.monitorVerification = d.buildMonitorVerificationCommand(layout, bin);
  out.installerEnvironment = d.buildRemoteInstallerEnv(layout);
  out.isolatedEnvironment = d.buildRemoteInstallerEnv(isolated);
  out.wrapper = d.buildIsolatedWrapper(isolated, "/usr/bin/claude", "CLAUDE_CONFIG_DIR", isolated.claudeConfigDir, isolated.claudeWrapperEvidenceFile);
  for (const step of ["installClaude", "installCodex", "installCopilot"]) {
    out[step] = d.buildInstallerVerificationCommand(step, layout, bin);
  }
  out.health = runtime.buildProbeCommand(23333, bin, { profile });
  out.healthPath = runtime.buildProbeCommand(23333, "node", { profile });
  out.readiness = runtime.buildPersistentReadinessCommand(23333, bin, { profile, challenge: "c".repeat(32) });
  out.nodeProbe = node.buildRemoteNodeProbeCommand();
  out.cachedNodeProbe = node.buildRemoteNodeProbeCommand(bin, "cache");
  out.nodeEval = node.buildRemoteNodeEvalCommand(bin, "console.log('中文 $HOME')");
  out.hook = node.buildRemoteHookNodeCommand(bin, "install.js", ["--remote"], { hooksDir: layout.claudeHooksDir });
  return out;
}

// SHA-256 snapshots of exact UTF-8 command bytes from the unchanged POSIX
// implementation at 41d40d22. A whitespace or quoting change changes the hash.
const EXPECTED = {
  "lockAcquire": "8fddc8f384d181bbf91358a7d4b5a8a8052934bf2730962343e2912dedfd5ab8",
  "lockRelease": "d1f99578917cc9adab5edde7f5baa0719060590833d2b7f1c39545417efd17bb",
  "fence": "5f265bd0af1d4ed344dc1ab5addc8cd18f5b406276e592630254c332008e5896",
  "ownership": "06b9742df5e23c153a55316cdb03b4ef5173795a2adddc1ce8e060c97eb6ebf8",
  "hermes": "d70dcb36e35aa29d7c21a88911eacdf98cf86363d6575f765ba1969577202196",
  "legacyMonitor": "9e9d278606a28384a9e5a5b672727c32ae69bfe345ed805b8b04c6855b4a6960",
  "monitorVerification": "bcedd815050926bca09622c439f0ed2d91e05e8e2dd8eca1733b3d422ab86490",
  "installerEnvironment": "5abe60be79aa56b53f43f74b48cde46181fe2a96ff92a5a826eadcb5db27d30c",
  "isolatedEnvironment": "9eb5473b0d9df9bf57435b79a390edb4c837a26e612c74f41bc3fd57982d7974",
  "wrapper": "bd2379bbb617395e7f995d3fc93ce8a44efece53df9da3bda5790474ddc20c4b",
  "installClaude": "869cfa22ee9fee7ea96e0de07cd99a5809978eb8c4bca2485c4a6e92bbda3319",
  "installCodex": "f4a75251efcb53bd0cd0ee5ac1ef8c2b8b1c5d0f604e07712ac9ac34dd1ae2e2",
  "installCopilot": "c2185581ee052423a6b3ef1dd5753051617a2ce9a3203acc76f4f626cb245bab",
  "health": "b7819e7a4a5b26286ac250f0986b62df36ec8fcf0903fa12ddd26e3011e70bab",
  "healthPath": "2ddc9a9368be10f07e8bfa8f6fd4ffa09ee5a629d40b6a1571876e693ec01065",
  "readiness": "9e4685081d9f047ea9a248d59b7f35cab769394d79c0f1669ef77783fb5e68f9",
  "nodeProbe": "59e3691c7ad8f3210f7f0835b7fb05840cc6940ba0927c2d5ee68d0693a83dde",
  "cachedNodeProbe": "2c7f380e99fb99086d7254024a29553beee0e8e8a772bc0a6be0736264e9439f",
  "nodeEval": "54a7ab54df3c15033f0c5e6441056f95b43caaaa7c3613f5b57a5b04f8eadf82",
  "hook": "c33fe7e0cd20ed5f32f1d71e2fb1cacd7531d346d2ccba2410dd31540e98244a"
};

test("issue #1316: POSIX command bytes match the pre-Windows baseline", async () => {
  const commands = await snapshots();
  assert.deepEqual(Object.keys(commands), Object.keys(EXPECTED));
  for (const [name, command] of Object.entries(commands)) {
    assert.equal(crypto.createHash("sha256").update(command).digest("hex"), EXPECTED[name], name);
  }
});

test("issue #1316: POSIX monitor stop, home resolution and CLI probe match the original command bytes", async () => {
  const { resolveRemoteRuntimeLayout } = require("../src/remote-ssh-layout");
  const profile = {
    id: "p1", host: "user@remote", remoteForwardPort: 23333,
    runtimeMode: "account-default", runtimeKey: "account-default", layoutVersion: 1,
    installId: "a".repeat(64), remoteHome: "/home/remote", remotePlatform: "posix",
  };
  const layout = resolveRemoteRuntimeLayout(profile);
  const isolated = resolveRemoteRuntimeLayout({ remoteHome: profile.remoteHome, runtimeMode: "profile-isolated", runtimeKey: "runtime_a" });
  const commands = { secureMonitorStop: deploy.__test.secureMonitorStopCommand(layout) };
  let operation;
  const spawn = (_tool, args) => {
    commands[operation] = args.at(-1);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(operation === "resolveHome" ? "CLAWD_REMOTE_HOME=/home/remote\n" : "{}\n"));
      child.emit("close", 0, null);
    });
    return child;
  };
  operation = "resolveHome";
  assert.equal((await deploy.__test.resolveRemoteHome({ profile, spawn })).ok, true);
  operation = "cliCapabilities";
  assert.equal((await deploy.__test.probeRemoteCliCapabilities({
    profile: { ...profile, runtimeMode: "profile-isolated", runtimeKey: "runtime_a" },
    layout: isolated, remoteNode: "/usr/bin/node", spawn,
  })).ok, true);
  // Extracted from git show 41d40d22 in an isolated temporary directory,
  // including that revision's remote helper dependencies.
  const expected = {
    secureMonitorStop: "f031ea6c626dce46a9f553c3c49d98bf7d16d836eea3501e60892d338e394cf0",
    resolveHome: "41328d7a59fb325f76e0b3d1fbd5afc0ed6d64701581b762c46fa6a1433e4b0a",
    cliCapabilities: "5b49bbc135308c02e0d0cceb4cd2c522704b45e6be1173c5961f6f768c11fc43",
  };
  assert.deepEqual(Object.keys(commands), Object.keys(expected));
  for (const [name, command] of Object.entries(commands)) {
    assert.equal(crypto.createHash("sha256").update(command).digest("hex"), expected[name], name);
  }
});
