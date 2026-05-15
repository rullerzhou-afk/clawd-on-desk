"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
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
      child.emit("exit", handler && handler.code != null ? handler.code : 0, handler && handler.signal || null);
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
