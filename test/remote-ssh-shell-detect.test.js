"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const {
  detectRemoteShell,
  PROBE_TIMEOUT_MS,
  MANAGED_PROBE_TIMEOUT_MS,
  POSIX_OS_RX,
} = require("../src/remote-ssh-shell-detect");

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  child.kill = () => {};
  return child;
}

function makeRecordingSpawn(responses) {
  const calls = [];
  let i = 0;
  const spawn = (command, args, opts) => {
    const child = makeFakeChild();
    calls.push({ command, args, opts, child });
    const resp = responses[i++] || { code: 0 };
    queueMicrotask(() => {
      if (resp.stdout) child.stdout.emit("data", Buffer.from(resp.stdout));
      if (resp.stderr) child.stderr.emit("data", Buffer.from(resp.stderr));
      const code = resp.code != null ? resp.code : 0;
      const signal = resp.signal || null;
      child.emit("exit", code, signal);
      child.emit("close", code, signal);
    });
    return child;
  };
  return { spawn, calls };
}

function buildSshArgs(profile) {
  return ["-T", profile.host];
}

test("POSIX_OS_RX accepts every kernel name we emit", () => {
  for (const os of ["Linux", "Darwin", "FreeBSD", "OpenBSD", "NetBSD", "SunOS", "AIX", "CYGWIN_NT-10.0", "MINGW64_NT-10.0", "MSYS_NT-10.0"]) {
    assert.ok(POSIX_OS_RX.test(os), `expected POSIX_OS_RX to match ${os}`);
  }
  for (const not of ["Windows", "windows", "Microsoft Windows", ""]) {
    assert.equal(POSIX_OS_RX.test(not), false, `did not expect POSIX_OS_RX to match ${JSON.stringify(not)}`);
  }
});

test("managed shell probes allow a longer Codespaces round-trip than ordinary probes", () => {
  assert.equal(PROBE_TIMEOUT_MS, 15000);
  assert.ok(MANAGED_PROBE_TIMEOUT_MS >= 30000);
  assert.ok(MANAGED_PROBE_TIMEOUT_MS > PROBE_TIMEOUT_MS);
});

test("detectRemoteShell: Linux remote → posix", async () => {
  const { spawn, calls } = makeRecordingSpawn([
    { code: 0, stdout: "Linux\n" },
  ]);
  const r = await detectRemoteShell({ profile: { host: "pi" }, spawn, buildSshArgs });
  assert.equal(r.ok, true);
  assert.equal(r.shell, "posix");
  assert.equal(r.os, "Linux");
  // Only one ssh call needed (uname succeeded).
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["-T", "pi", "uname -s"]);
});

test("detectRemoteShell: macOS remote → posix Darwin", async () => {
  const { spawn } = makeRecordingSpawn([
    { code: 0, stdout: "Darwin\n" },
  ]);
  const r = await detectRemoteShell({ profile: { host: "mac" }, spawn, buildSshArgs });
  assert.deepEqual(r, { ok: true, shell: "posix", os: "Darwin" });
});

test("detectRemoteShell: Windows cmd remote → windows-cmd", async () => {
  // uname fails (cmd doesn't have it), ver succeeds with the Microsoft banner.
  const { spawn, calls } = makeRecordingSpawn([
    { code: 1, stderr: "'uname' is not recognized as an internal or external command" },
    { code: 0, stdout: "\r\nMicrosoft Windows [Version 10.0.26200.2]\r\n" },
  ]);
  const r = await detectRemoteShell({ profile: { host: "win" }, spawn, buildSshArgs });
  assert.deepEqual(r, { ok: true, shell: "windows-cmd", os: "windows" });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, ["-T", "win", "ver"]);
});

test("detectRemoteShell: GBK-encoded cmd stderr still classifies as windows-cmd", async () => {
  // Chinese Windows cmd error bytes for "'uname' 不是内部或外部命令" don't
  // matter for classification — uname's non-zero exit + ver's success is
  // what makes the call. This test confirms we don't crash on weird bytes
  // and still reach the Windows branch.
  const garbled = Buffer.from([
    0x27, 0x75, 0x6e, 0x61, 0x6d, 0x65, 0x27, 0x20,
    0xb2, 0xbb, 0xca, 0xc7, 0xc4, 0xda, 0xb2, 0xbf, // 不是内部 in GBK
  ]);
  const { spawn } = makeRecordingSpawn([
    { code: 1, stderr: garbled },
    { code: 0, stdout: "Microsoft Windows [Version 10.0.22631]" },
  ]);
  const r = await detectRemoteShell({ profile: { host: "win" }, spawn, buildSshArgs });
  assert.equal(r.shell, "windows-cmd");
});

test("detectRemoteShell: unknown shell → ok:false, no classification", async () => {
  // Both probes fail — could be PowerShell-as-default, restricted shell,
  // or a network blip. Caller decides whether to keep going.
  const { spawn } = makeRecordingSpawn([
    { code: 1, stderr: "uname: not found" },
    { code: 1, stderr: "ver: not found" },
  ]);
  const r = await detectRemoteShell({ profile: { host: "weird" }, spawn, buildSshArgs });
  assert.equal(r.ok, false);
  assert.equal(r.shell, "unknown");
});

test("detectRemoteShell: uname success but unknown OS string falls through to Windows probe", async () => {
  // If `uname -s` exits 0 but the kernel name doesn't match POSIX_OS_RX
  // (e.g. some custom cygwin-like setup that reports "FooOS"), we must
  // NOT short-circuit to posix — fall through to the ver probe.
  const { spawn, calls } = makeRecordingSpawn([
    { code: 0, stdout: "FooOS\n" },
    { code: 0, stdout: "Microsoft Windows [Version 10.0.22631]" },
  ]);
  const r = await detectRemoteShell({ profile: { host: "host" }, spawn, buildSshArgs });
  assert.equal(r.shell, "windows-cmd");
  assert.equal(calls.length, 2);
});
