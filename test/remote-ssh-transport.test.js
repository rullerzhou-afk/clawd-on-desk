"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const {
  buildSshConfigArgs,
  parseSshConfig,
  tokenizeProxyCommand,
  parseCodespacesProxyCommand,
  localTargetFingerprint,
  redactTransportDiagnostic,
  inspectEffectiveTransport,
} = require("../src/remote-ssh-transport");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = 0;
  child.kill = () => { child.killCalls += 1; };
  return child;
}

function spawnWithConfig(config, { code = 0, signal = null } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = fakeChild();
    calls.push({ command, args, options, child });
    queueMicrotask(() => {
      if (config) child.stdout.write(config);
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", code, signal);
      child.emit("close", code, signal);
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

test("buildSshConfigArgs uses -G without opening an interactive shell", () => {
  assert.deepEqual(buildSshConfigArgs({
    host: "alice@space",
    port: 2222,
    identityFile: "C:\\keys\\id_ed25519",
  }), ["-G", "-i", "C:\\keys\\id_ed25519", "-p", "2222", "alice@space"]);
});

test("parseSshConfig is case-insensitive and first-value wins", () => {
  const config = parseSshConfig("HostName example.test\nPORT 2222\nport 22\nUser alice\n");
  assert.equal(config.hostname, "example.test");
  assert.equal(config.port, "2222");
  assert.equal(config.user, "alice");
});

test("ProxyCommand tokenizer preserves quoted Windows executable paths", () => {
  assert.deepEqual(
    tokenizeProxyCommand('"C:\\Program Files\\GitHub CLI\\gh.exe" cs ssh -c fuzzy-space --stdio'),
    ["C:\\Program Files\\GitHub CLI\\gh.exe", "cs", "ssh", "-c", "fuzzy-space", "--stdio"],
  );
});

test("Codespaces parser accepts official selector and subcommand forms", () => {
  for (const command of [
    '"C:\\Program Files\\GitHub CLI\\gh.exe" cs ssh -c Fuzzy-Space --stdio',
    "C:\\Program Files\\GitHub CLI\\gh.exe cs ssh -c Fuzzy-Space --stdio -- -i C:\\Users\\me\\.ssh\\codespaces.auto",
    "gh codespace ssh --codespace Fuzzy-Space --stdio",
    "/usr/local/bin/gh cs ssh --codespace Fuzzy-Space --stdio",
    "gh.exe cs ssh --stdio --codespace=Fuzzy-Space",
  ]) {
    assert.deepEqual(parseCodespacesProxyCommand(command), { codespace: "fuzzy-space" });
  }
});

test("Codespaces parser rejects lookalikes and missing --stdio", () => {
  assert.equal(parseCodespacesProxyCommand("helper codespace gh cs ssh -c fuzzy-space --stdio"), null);
  assert.equal(parseCodespacesProxyCommand("C:\\tools\\evilgh.exe cs ssh -c fuzzy-space --stdio"), null);
  assert.equal(parseCodespacesProxyCommand("gh cs ssh -c fuzzy-space"), null);
  assert.equal(parseCodespacesProxyCommand("gh cs ssh -c bad/name --stdio"), null);
});

test("inspectEffectiveTransport detects Codespaces from real-shaped ssh -G output", async () => {
  const spawn = spawnWithConfig([
    "host space",
    "user codespace",
    "hostname vscode.codespaces.githubusercontent.com",
    "port 22",
    "proxycommand C:\\Program Files\\GitHub CLI\\gh.exe cs ssh -c Fuzzy-Space --stdio -- -i C:\\Users\\me\\.ssh\\codespaces.auto",
    "",
  ].join("\n"));
  const result = await inspectEffectiveTransport({ host: "space", sshTransportMode: "auto" }, { spawn });
  assert.equal(result.mode, "serialized");
  assert.equal(result.kind, "codespaces-stdio");
  assert.equal(result.key, "codespace:fuzzy-space");
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].options.shell, false);
});

test("inspectEffectiveTransport keeps ordinary SSH parallel", async () => {
  const spawn = spawnWithConfig("host pi\nuser alice\nhostname pi.lan\nport 22\nproxycommand none\n");
  const result = await inspectEffectiveTransport({ host: "pi" }, { spawn });
  assert.equal(result.mode, "parallel");
  assert.equal(result.kind, "standard");
});

test("explicit serialized override fails safe when ssh -G fails", async () => {
  const spawn = spawnWithConfig("", { code: 255 });
  const profile = { host: "alice@proxy", port: 2222, sshTransportMode: "serialized" };
  const result = await inspectEffectiveTransport(profile, { spawn });
  assert.equal(result.mode, "serialized");
  assert.equal(result.kind, "explicit-serialized");
  assert.match(result.key, /^destination-sha256:[a-f0-9]{64}$/);
});

test("first-use inspection failure is unknown rather than parallel", async () => {
  const spawn = spawnWithConfig("", { code: 255 });
  const result = await inspectEffectiveTransport({ host: "space", sshTransportMode: "auto" }, { spawn });
  assert.equal(result.mode, "unknown");
  assert.equal(result.kind, "inspection-failed");
  assert.equal(result.key, null);
});

test("inspection waits for close rather than exit", async () => {
  const child = fakeChild();
  const resultPromise = inspectEffectiveTransport({ host: "space" }, {
    spawn: () => child,
    timeoutMs: 1000,
  });
  let settled = false;
  resultPromise.then(() => { settled = true; });
  child.stdout.end("host space\nhostname example.test\nport 22\n");
  child.stderr.end();
  child.emit("exit", 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  child.emit("close", 0, null);
  const result = await resultPromise;
  assert.equal(result.mode, "parallel");
});

test("local target fingerprint changes with transport-affecting fields", () => {
  const base = { host: "space", port: 22, sshTransportMode: "auto" };
  assert.notEqual(localTargetFingerprint(base), localTargetFingerprint({ ...base, port: 2222 }));
  assert.notEqual(localTargetFingerprint(base), localTargetFingerprint({ ...base, sshTransportMode: "serialized" }));
});

test("transport diagnostics redact identity paths, tokens, and ProxyCommand fragments", () => {
  const redacted = redactTransportDiagnostic(
    "C:\\keys\\private failed token=secret ghp_abcdefghijklmnopqrstuvwxyz ProxyCommand gh cs ssh --stdio",
    { identityFile: "C:\\keys\\private" },
  );
  assert.doesNotMatch(redacted, /C:\\keys\\private/);
  assert.doesNotMatch(redacted, /secret|ghp_abcdefghijklmnopqrstuvwxyz|gh cs ssh/);
  assert.match(redacted, /\[identity-file\]|\[token\]|\[redacted\]/);
});

test("transport diagnostics remove OpenSSH verbose command and path lines", () => {
  const redacted = redactTransportDiagnostic([
    "debug1: Reading configuration data C:\\\\private\\\\included.conf",
    "debug1: identity file C:\\\\private\\\\id_test type 0",
    "debug1: Executing proxy command: exec gh cs ssh --stdio --password sentinel-proxy-secret",
    "debug1: Sending command: node -e sentinel-remote-command",
    "Error: remote port forwarding failed for listen port 23333",
  ].join("\n"));
  assert.doesNotMatch(redacted, /private|sentinel|Executing proxy|Sending command/i);
  assert.match(redacted, /remote port forwarding failed/i);
});
