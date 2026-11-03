"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("child_process");
const { EventEmitter } = require("events");

const {
  buildRemoteNodeProbeCommand,
  parseRemoteNodeProbeOutput,
  isValidRemoteNodeBin,
  isSupportedRemoteNodeVersion,
  clearRemoteNodeCache,
  getProfileRemoteNodeBin,
  getCachedRemoteNodeBin,
  resolveRemoteNodeBin,
  buildRemoteHookNodeCommand,
  buildRemoteNodeEvalCommand,
} = require("../src/remote-ssh-node");
const { buildSshArgs } = require("../src/remote-ssh-runtime");

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  child.kill = () => {};
  return child;
}

function makeRecordingSpawn(handlers) {
  const calls = [];
  const spawn = (command, args, opts) => {
    const child = makeFakeChild();
    calls.push({ command, args, opts, child });
    const idx = calls.length - 1;
    const handler = Array.isArray(handlers) ? handlers[idx] : handlers;
    queueMicrotask(() => {
      if (handler && handler.stdout) child.stdout.emit("data", Buffer.from(handler.stdout));
      if (handler && handler.stderr) child.stderr.emit("data", Buffer.from(handler.stderr));
      const code = handler && handler.code != null ? handler.code : 0;
      const signal = handler && handler.signal || null;
      child.emit("exit", code, signal);
      child.emit("close", code, signal);
    });
    return child;
  };
  return { spawn, calls };
}

test("buildRemoteNodeProbeCommand uses a POSIX shell probe with manager fallbacks", () => {
  const command = buildRemoteNodeProbeCommand();
  assert.ok(command.startsWith("sh -c "));
  assert.ok(command.includes(".nvm"));
  assert.ok(command.includes(".fnm"));
  assert.ok(command.includes(".asdf"));
  assert.ok(command.includes(".mise"));
  assert.ok(command.includes("-lic"));
  assert.ok(command.indexOf("-lic") < command.indexOf(".nvm/versions"),
    "login shell should be preferred before raw node-manager glob candidates");
});

test("parseRemoteNodeProbeOutput extracts markers while ignoring shell noise", () => {
  const parsed = parseRemoteNodeProbeOutput([
    "oh-my-zsh banner",
    "CLAWD_REMOTE_NODE_BIN=/Users/u/.nvm/versions/node/v20.10.0/bin/node",
    "CLAWD_REMOTE_NODE_VERSION=v20.10.0",
    "CLAWD_REMOTE_NODE_SOURCE=shell:/bin/zsh",
  ].join("\n"));
  assert.deepEqual(parsed, {
    nodeBin: "/Users/u/.nvm/versions/node/v20.10.0/bin/node",
    version: "v20.10.0",
    source: "shell:/bin/zsh",
  });
});

test("parseRemoteNodeProbeOutput rejects bare node and invalid versions", () => {
  assert.equal(parseRemoteNodeProbeOutput("CLAWD_REMOTE_NODE_BIN=node\nCLAWD_REMOTE_NODE_VERSION=v20\n"), null);
  assert.equal(parseRemoteNodeProbeOutput("CLAWD_REMOTE_NODE_BIN=/usr/bin/node\nCLAWD_REMOTE_NODE_VERSION=20\n"), null);
  assert.equal(parseRemoteNodeProbeOutput("CLAWD_REMOTE_NODE_BIN=/usr/bin/node\nCLAWD_REMOTE_NODE_VERSION=v12.22.12\n"), null);
});

test("isSupportedRemoteNodeVersion enforces the hook syntax floor", () => {
  assert.equal(isSupportedRemoteNodeVersion("v14.0.0"), true);
  assert.equal(isSupportedRemoteNodeVersion("v22.1.0"), true);
  assert.equal(isSupportedRemoteNodeVersion("v12.22.12"), false);
  assert.equal(isSupportedRemoteNodeVersion("20.10.0"), false);
});

test("isValidRemoteNodeBin accepts absolute POSIX paths including spaces", () => {
  assert.equal(isValidRemoteNodeBin("/Users/me/My Tools/node"), true);
  assert.equal(isValidRemoteNodeBin("node"), false);
  assert.equal(isValidRemoteNodeBin("/tmp/no\nnode"), false);
});

test("resolveRemoteNodeBin records ssh command and caches successful result", async () => {
  clearRemoteNodeCache();
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23333 };
  const { spawn, calls } = makeRecordingSpawn([{
    stdout: [
      "CLAWD_REMOTE_NODE_BIN=/home/me/.nvm/versions/node/v22.1.0/bin/node",
      "CLAWD_REMOTE_NODE_VERSION=v22.1.0",
      "CLAWD_REMOTE_NODE_SOURCE=shell:/bin/bash",
    ].join("\n"),
  }]);
  const resolved = await resolveRemoteNodeBin({ profile, spawn, buildSshArgs });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.nodeBin, "/home/me/.nvm/versions/node/v22.1.0/bin/node");
  assert.equal(resolved.version, "v22.1.0");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "ssh");
  assert.ok(calls[0].args[calls[0].args.length - 1].startsWith("sh -c "));

  const cached = await resolveRemoteNodeBin({
    profile,
    spawn: () => { throw new Error("cache should avoid spawn"); },
    buildSshArgs,
  });
  assert.equal(cached.ok, true);
  assert.equal(cached.source, "shell:/bin/bash");
  assert.deepEqual(getCachedRemoteNodeBin(profile).nodeBin, resolved.nodeBin);
});

test("resolveRemoteNodeBin reuses persisted profile Node metadata without spawning ssh", async () => {
  clearRemoteNodeCache();
  const profile = {
    id: "p1",
    host: "pi",
    remoteForwardPort: 23333,
    detectedRemoteNodeBin: "/opt/homebrew/bin/node",
    detectedRemoteNodeVersion: "v22.1.0",
    detectedRemoteNodeSource: "profile",
    detectedRemoteNodeAt: 12345,
  };
  const persisted = getProfileRemoteNodeBin(profile);
  assert.equal(persisted.nodeBin, "/opt/homebrew/bin/node");
  assert.equal(persisted.version, "v22.1.0");

  const resolved = await resolveRemoteNodeBin({
    profile,
    spawn: () => { throw new Error("profile cache should avoid spawn"); },
    buildSshArgs,
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.nodeBin, "/opt/homebrew/bin/node");
  assert.equal(resolved.source, "profile");
});

test("resolveRemoteNodeBin can verify a cached path and fall back when stale", async () => {
  clearRemoteNodeCache();
  const profile = {
    id: "p1",
    host: "pi",
    remoteForwardPort: 23333,
    detectedRemoteNodeBin: "/stale/node",
    detectedRemoteNodeVersion: "v20.10.0",
    detectedRemoteNodeSource: "profile",
  };
  const { spawn, calls } = makeRecordingSpawn([
    { code: 127, stderr: "/stale/node: not found" },
    {
      stdout: [
        "CLAWD_REMOTE_NODE_BIN=/usr/local/bin/node",
        "CLAWD_REMOTE_NODE_VERSION=v22.1.0",
        "CLAWD_REMOTE_NODE_SOURCE=path",
      ].join("\n"),
    },
  ]);

  const resolved = await resolveRemoteNodeBin({ profile, spawn, buildSshArgs, verifyCache: true });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.nodeBin, "/usr/local/bin/node");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args[calls[0].args.length - 1].includes("/stale/node"));
  assert.equal(getCachedRemoteNodeBin(profile).nodeBin, "/usr/local/bin/node");
});

test("resolveRemoteNodeBin reports a helpful failure when probe exits non-zero", async () => {
  clearRemoteNodeCache();
  const profile = { id: "p1", host: "pi", remoteForwardPort: 23333 };
  const { spawn } = makeRecordingSpawn([{ code: 127, stderr: "sh: node: command not found" }]);
  const resolved = await resolveRemoteNodeBin({ profile, spawn, buildSshArgs });
  assert.equal(resolved.ok, false);
  assert.match(resolved.message, /Remote Node\.js not found/);
  assert.match(resolved.message, /command not found/);
});

test("buildRemoteHookNodeCommand quotes node path and keeps remote HOME expansion", () => {
  const command = buildRemoteHookNodeCommand("/Users/me/My Tools/node", "install.js", ["--remote"]);
  assert.equal(command, "'/Users/me/My Tools/node' \"$HOME/.claude/hooks/install.js\" '--remote'");
});

test("buildRemoteNodeEvalCommand embeds absolute node path for health probe", () => {
  const command = buildRemoteNodeEvalCommand("/opt/homebrew/bin/node", "process.exit(0)");
  assert.ok(command.startsWith("'/opt/homebrew/bin/node' -e "));
  assert.ok(command.includes("process.exit(0)"));
});

test("buildRemoteNodeEvalCommand keeps JavaScript opaque to a real POSIX shell", {
  skip: process.platform === "win32",
}, () => {
  const literal = "literal:$HOME:${BROKEN}:$(printf substituted):`printf substituted`:don't";
  const js = `process.stdout.write(${JSON.stringify(literal)})`;
  const command = buildRemoteNodeEvalCommand(process.execPath, js);
  const result = childProcess.spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, literal);
});

const windowsProfile = { id: "win", host: "win-cache", remotePlatform: "win32",
  detectedRemoteNodeBin: "C:\\Node\\node.exe", detectedRemoteNodeVersion: "v22.0.0" };
const windowsDiscovery = { platform: "win32", execPath: windowsProfile.detectedRemoteNodeBin,
  homedir: "C:\\Users\\remote", version: "v22.0.0" };

test("issue #1316: Windows resolver uses trusted cache without SSH and verifies it on request", async () => {
  clearRemoteNodeCache();
  const cached = await resolveRemoteNodeBin({ profile: windowsProfile, buildSshArgs,
    spawn: () => assert.fail("trusted cache must avoid SSH") });
  assert.equal(cached.nodeBin, windowsProfile.detectedRemoteNodeBin);
  const { spawn, calls } = makeRecordingSpawn([{ stdout: JSON.stringify(windowsDiscovery) }]);
  const verified = await resolveRemoteNodeBin({ profile: windowsProfile, buildSshArgs, spawn, verifyCache: true });
  assert.equal(verified.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.at(-1), require("../src/remote-ssh-node-launch").REMOTE_NODE_LAUNCH_COMMAND);
});

test("issue #1316: Windows resolver bypasses cache explicitly and reports changed execPath at check-node", async () => {
  clearRemoteNodeCache();
  const { spawn, calls } = makeRecordingSpawn([{ stdout: JSON.stringify({ ...windowsDiscovery, execPath: "D:\\Node\\node.exe" }) }]);
  const result = await resolveRemoteNodeBin({ profile: windowsProfile, buildSshArgs, spawn, useCache: false });
  assert.equal(calls.length, 1);
  assert.equal(result.reason, "windows_node_changed");
  assert.equal(result.hint, "remoteSshErrWindowsNodeChanged");
  assert.equal(result.step, "check-node");
  assert.equal(getCachedRemoteNodeBin(windowsProfile), null);
});

for (const response of [{ code: 127 }, { stdout: JSON.stringify({ ...windowsDiscovery, version: "v12.0.0" }) }]) {
  test(`issue #1316: Windows resolver discovery failure includes check-node (${response.code || "old version"})`, async () => {
    clearRemoteNodeCache();
    const { spawn } = makeRecordingSpawn([response]);
    const result = await resolveRemoteNodeBin({ profile: windowsProfile, buildSshArgs, spawn, verifyCache: true });
    assert.equal(result.ok, false);
    assert.equal(result.step, "check-node");
  });
}

test("issue #1316: Windows resolver cache comparison folds executable path case", async () => {
  clearRemoteNodeCache();
  require("../src/remote-ssh-node").setCachedRemoteNodeBin(windowsProfile, {
    nodeBin: windowsProfile.detectedRemoteNodeBin.toUpperCase(), version: "v22.0.0", source: "cache",
  });
  const result = await resolveRemoteNodeBin({ profile: windowsProfile, buildSshArgs,
    spawn: () => assert.fail("case-equivalent cache must not spawn SSH") });
  assert.equal(result.ok, true);
  assert.equal(result.nodeBin, windowsProfile.detectedRemoteNodeBin.toUpperCase());
});

test("issue #1316: Windows resolver rejects a non-string expected path even with a cached executable", async () => {
  clearRemoteNodeCache();
  require("../src/remote-ssh-node").setCachedRemoteNodeBin(windowsProfile, {
    nodeBin: windowsProfile.detectedRemoteNodeBin, version: "v22.0.0", source: "cache",
  });
  const { spawn, calls } = makeRecordingSpawn([{ stdout: JSON.stringify(windowsDiscovery) }]);
  const result = await resolveRemoteNodeBin({ profile: { ...windowsProfile, detectedRemoteNodeBin: 123 }, buildSshArgs, spawn });
  assert.equal(calls.length, 1);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "windows_node_changed");
  assert.equal(result.hint, "remoteSshErrWindowsNodeChanged");
});

for (const mode of ["error event", "synchronous throw"]) {
  test(`issue #1316: Node discovery stdin ${mode} cannot escape the probe transport`, async () => {
    const { Writable } = require("node:stream");
    const { EventEmitter } = require("node:events");
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = new Writable({ write(_data, _encoding, callback) {
      callback(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    } });
    if (mode === "synchronous throw") child.stdin.end = () => { throw Object.assign(new Error("stream destroyed"), { code: "ERR_STREAM_DESTROYED" }); };
    let killed = 0;
    child.kill = () => { killed++; queueMicrotask(() => child.emit("close", 0, null)); };
    const result = await require("../src/remote-ssh-node").runRemoteNodeFrame({ profile: windowsProfile,
      buildSshArgs, spawn: () => child, frame: "program\n" });
    assert.equal(result.code, -1);
    assert.equal(result.stdinError, true);
    assert.match(result.stderr, /EPIPE|ERR_STREAM_DESTROYED/);
    assert.equal(killed, 1);
  });
}
