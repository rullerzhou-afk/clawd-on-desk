"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { probeRemotePlatform } = require("../src/remote-ssh-platform");
const { REMOTE_NODE_LAUNCH_COMMAND } = require("../src/remote-ssh-node-launch");

const profile = { id: "p1", host: "remote" };
const buildSshArgs = () => ["remote"];
const windowsNode = { platform: "win32", execPath: "C:\\Node\\node.exe", homedir: "C:\\Users\\remote", version: "v14.21.3" };

function recordingSpawn(responses) {
  const calls = [];
  return {
    calls,
    spawn(command, args) {
      const response = responses[calls.length];
      assert.ok(response, `unexpected command: ${args.at(-1)}`);
      const call = { command, args, input: "" };
      calls.push(call);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: (data = "") => { call.input += data; } };
      child.kill = () => {};
      queueMicrotask(() => {
        if (response.stdout) child.stdout.emit("data", Buffer.from(response.stdout));
        child.emit("close", response.code || 0, null);
      });
      return child;
    },
  };
}

for (const os of ["Linux", "Darwin", "FreeBSD", "OpenBSD", "NetBSD", "SunOS", "AIX"]) {
  test(`issue #1316: known POSIX ${os} skips the Node platform probe`, async () => {
    const recorder = recordingSpawn([{ stdout: `${os}\n` }]);
    const result = await probeRemotePlatform({ profile, buildSshArgs, spawn: recorder.spawn });
    assert.equal(result.remotePlatform, "posix");
    assert.deepEqual(recorder.calls.map((call) => call.args.at(-1)), ["uname -s"]);
  });
}

for (const shell of [
  { shell: "windows-cmd", os: "windows" },
  { shell: "posix", os: "MINGW64_NT-10.0" },
  { shell: "posix", os: "MSYS_NT-10.0" },
  { shell: "posix", os: "CYGWIN_NT-10.0" },
  { shell: "unknown" },
]) {
  test(`issue #1316: ${shell.os || shell.shell} probes native Node through a single stdin frame`, async () => {
    const recorder = recordingSpawn([{ stdout: JSON.stringify(windowsNode) }]);
    const result = await probeRemotePlatform({ profile, buildSshArgs, spawn: recorder.spawn, deps: { detectRemoteShell: async () => shell } });
    assert.equal(result.remotePlatform, "win32");
    assert.deepEqual(result.node, windowsNode);
    assert.equal(recorder.calls[0].args.at(-1), REMOTE_NODE_LAUNCH_COMMAND);
    assert.match(JSON.parse(recorder.calls[0].input).code, /process\.execPath/);
  });
  if (shell.shell !== "unknown") {
    test(`issue #1316: ${shell.os} with no PATH Node never falls back to POSIX`, async () => {
      const recorder = recordingSpawn([{ code: 127 }]);
      const result = await probeRemotePlatform({ profile, buildSshArgs, spawn: recorder.spawn, deps: {
        detectRemoteShell: async () => shell,
        resolveRemoteNodeBin: () => assert.fail("Windows must not discover POSIX Node"),
      } });
      assert.equal(result.ok, false);
      assert.equal(result.hint, "remoteSshErrWindowsNodeMissing");
      assert.equal(recorder.calls.length, 1);
    });
  }
}

for (const [label, node] of [
  ["old version", { ...windowsNode, version: "v12.22.0" }],
  ["missing execPath", { ...windowsNode, execPath: undefined }],
  ["wrong home platform", { ...windowsNode, homedir: "/home/remote" }],
  ["malformed response", null],
]) {
  test(`issue #1316: Windows rejects a ${label} platform probe`, async () => {
    const recorder = recordingSpawn([{ stdout: JSON.stringify(node) }]);
    const result = await probeRemotePlatform({ profile, buildSshArgs, spawn: recorder.spawn, deps: { detectRemoteShell: async () => ({ shell: "windows-cmd" }) } });
    assert.equal(result.ok, false);
    assert.equal(result.hint, "remoteSshErrWindowsNodeMissing");
  });
}

for (const platform of ["linux", "win32"]) {
  test(`issue #1316: unknown fallback verifies discovery Node reports ${platform} before any mutation`, async () => {
    const recorder = recordingSpawn([{ code: 127 }, { stdout: `${platform}\n` }]);
    const result = await probeRemotePlatform({ profile, buildSshArgs, spawn: recorder.spawn, deps: {
      detectRemoteShell: async () => ({ shell: "unknown" }),
      resolveRemoteNodeBin: async () => ({ ok: true, nodeBin: "/usr/local/bin/node", version: "v20.0.0" }),
    } });
    assert.equal(result.ok, platform !== "win32");
    if (platform === "win32") assert.equal(result.hint, "remoteSshErrWindowsNodeMissing");
    else assert.equal(result.remotePlatform, "posix");
    assert.match(recorder.calls[1].args.at(-1), /console\.log\(process\.platform\)/);
    assert.equal(recorder.calls.some((call) => /mkdir|mv |rm /.test(call.args.at(-1))), false);
  });
}

test("issue #1316: an unverifiable unknown fallback fails before taking a lock", async () => {
  const recorder = recordingSpawn([{ code: 127 }, { code: 1 }]);
  const result = await probeRemotePlatform({ profile, buildSshArgs, spawn: recorder.spawn, deps: {
    detectRemoteShell: async () => ({ shell: "unknown" }),
    resolveRemoteNodeBin: async () => ({ ok: true, nodeBin: "/usr/bin/node", version: "v20.0.0" }),
  } });
  assert.equal(result.ok, false);
  assert.equal(recorder.calls.length, 2);
});

test("issue #1316: non-win32 Node in a Windows shell environment preserves POSIX behavior", async () => {
  for (const os of ["MINGW64_NT-10.0", "MSYS_NT-10.0", "CYGWIN_NT-10.0"]) {
    const detected = { platform: "cygwin", execPath: "/usr/bin/node", homedir: "/home/remote", version: "v20.0.0" };
    const recorder = recordingSpawn([{ stdout: JSON.stringify(detected) }]);
    const result = await probeRemotePlatform({ profile, buildSshArgs, spawn: recorder.spawn,
      deps: { detectRemoteShell: async () => ({ shell: "posix", os }) },
    });
    assert.equal(result.ok, true);
    assert.equal(result.remotePlatform, "posix");
    assert.equal(result.remoteNode.nodeBin, detected.execPath);
    assert.equal(recorder.calls.length, 1);
  }
});

test("issue #1316: unknown shell rediscovers login-shell POSIX Node after a Windows host migration", async () => {
  require("../src/remote-ssh-node").clearRemoteNodeCache();
  const old = { ...profile, remotePlatform: "win32", detectedRemoteNodeBin: windowsNode.execPath,
    detectedRemoteNodeVersion: windowsNode.version };
  const recorder = recordingSpawn([{ code: 127 }, { stdout: "CLAWD_REMOTE_NODE_BIN=/home/remote/.nvm/node\nCLAWD_REMOTE_NODE_VERSION=v22.0.0\nCLAWD_REMOTE_NODE_SOURCE=shell:/bin/bash\n" }, { stdout: "linux\n" }]);
  const result = await probeRemotePlatform({ profile: old, buildSshArgs, spawn: recorder.spawn,
    deps: { detectRemoteShell: async () => ({ shell: "unknown" }) } });
  assert.equal(result.ok, true);
  assert.equal(result.remotePlatform, "posix");
  assert.equal(recorder.calls.length, 3);
  assert.match(recorder.calls[1].args.at(-1), /^sh -c /);
  assert.equal(result.remoteNode.nodeBin, "/home/remote/.nvm/node");
});
