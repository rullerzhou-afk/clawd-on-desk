"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "manual", "remote-ssh-codespaces-546.ps1");
const OBSERVER = path.join(ROOT, "scripts", "manual", "remote-ssh-codespaces-546-observe.ps1");
const PORT_HOLDER = path.join(ROOT, "scripts", "manual", "remote-ssh-codespaces-546-port-holder.js");
const READINESS = path.join(ROOT, "scripts", "manual", "remote-ssh-codespaces-546-readiness.js");
const README = path.join(ROOT, "scripts", "manual", "README.md");

test("#546 manual harness is tracked, isolated, and never uses broad process cleanup", () => {
  assert.equal(fs.existsSync(SCRIPT), true);
  assert.equal(fs.existsSync(README), true);
  const source = fs.readFileSync(SCRIPT, "utf8");
  assert.match(source, /gh auth status/);
  assert.match(source, /codespace create/);
  assert.match(source, /--retention-period 24h/);
  assert.doesNotMatch(source, /--retention-period 1d/);
  assert.match(source, /--json "name,displayName,state"/);
  assert.match(source, /\$script:CreatedDisplayName = \$displayName/);
  assert.match(source, /Expected one exact display-name match/);
  assert.match(source, /codespace delete --codespace \$deleteName/);
  assert.match(source, /\$env:USERPROFILE = \$harnessHome/);
  assert.match(source, /\$env:CLAWD_REMOTE_SSH_CONFIG_FILE = \$sshConfig/);
  assert.match(source, /inspectEffectiveTransport/);
  assert.doesNotMatch(source, /effective ProxyCommand is not a Codespaces stdio transport/);
  assert.match(source, /--user-data-dir=\$electronUserData/);
  assert.match(source, /New-Item -ItemType Directory -Path \$electronUserData/);
  assert.match(source, /Get-CimInstance Win32_Process/);
  assert.doesNotMatch(source, /\b(?:taskkill|Stop-Process)\b/i);
});

test("#546 observer records only bounded safe process metadata", () => {
  assert.equal(fs.existsSync(OBSERVER), true);
  const source = fs.readFileSync(OBSERVER, "utf8");
  assert.match(source, /Get-CimInstance Win32_Process/);
  assert.match(source, /commandHash = Get-Sha256Text \$process\.CommandLine/);
  assert.match(source, /peakSsh/);
  assert.match(source, /peakGh/);
  assert.doesNotMatch(source, /\b(?:taskkill|Stop-Process)\b/i);
  assert.doesNotMatch(source, /commandLine\s*=/i);
});

test("#546 V10 readiness harness uses a test-only identity and exact cleanup", () => {
  assert.equal(fs.existsSync(READINESS), true);
  const source = fs.readFileSync(READINESS, "utf8");
  assert.match(source, /buildPersistentReadinessCommand/);
  assert.match(source, /\/tmp\/clawd-546-v10-/);
  assert.match(source, /wrongNonceRejected/);
  assert.match(source, /isExpectedWrongNonce\(received, identityNonce, expectedNonce\)/);
  assert.match(source, /stderrHash/);
  assert.doesNotMatch(source, /\b(?:taskkill|Stop-Process)\b/i);
  assert.doesNotMatch(source, /routingNonce:\s*expectedNonce/);
});

test("#546 V9 port holder closes setup before the app attempt and cleans up afterward", () => {
  assert.equal(fs.existsSync(PORT_HOLDER), true);
  const source = fs.readFileSync(PORT_HOLDER, "utf8");
  assert.match(source, /await spawnToClose\(buildSshArgs\(profile\).*setupCommand/s);
  assert.match(source, /await waitForConnectAttemptToEnd\(\)/);
  assert.match(source, /await spawnToClose\(buildSshArgs\(profile\).*cleanupCommand/s);
  assert.match(source, /\/tmp\/clawd-546-v9-/);
  assert.match(source, /setupDrainVerified: true/);
  assert.doesNotMatch(source, /\b(?:taskkill|Stop-Process|killall|pkill)\b/i);
});

test("#546 V9 cleanup command is valid shell and removes only its exact test root", (t) => {
  const { buildCleanupCommand } = require(PORT_HOLDER);
  const token = `${process.pid.toString(16).padStart(8, "0")}${Date.now().toString(16).slice(-8)}`.slice(0, 16);
  const remoteRoot = `/tmp/clawd-546-v9-${token}`;
  const command = [
    "set -eu",
    `mkdir -p '${remoteRoot}'`,
    `printf '%s\\n' 2147483646 > '${remoteRoot}/pid'`,
    buildCleanupCommand(remoteRoot),
    `test ! -e '${remoteRoot}'`,
  ].join("\n");
  const windowsGitBash = path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe");
  if (process.platform === "win32" && !fs.existsSync(windowsGitBash)) {
    t.skip("Git Bash is unavailable");
    return;
  }
  const shell = process.platform === "win32" ? windowsGitBash : "sh";
  const result = childProcess.spawnSync(shell, ["-c", command], { encoding: "utf8" });
  if (result.error && result.error.code === "ENOENT") {
    t.skip(`${shell} is unavailable`);
    return;
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("#546 V9 cleanup starts only after a verified setup or explicit post-app confirmation", () => {
  const { shouldStartCleanup } = require(PORT_HOLDER);
  assert.equal(shouldStartCleanup({
    setupAttempted: true,
    holderReady: true,
    cleanupConfirmed: false,
    drainVerified: true,
  }), false, "SIGINT/non-TTY must not start a second SSH");
  assert.equal(shouldStartCleanup({
    setupAttempted: true,
    holderReady: true,
    cleanupConfirmed: true,
    drainVerified: true,
  }), true);
  assert.equal(shouldStartCleanup({
    setupAttempted: true,
    holderReady: false,
    cleanupConfirmed: false,
    drainVerified: true,
  }), true, "a verified-close partial setup is safe to clean before the app attempt");
  assert.equal(shouldStartCleanup({
    setupAttempted: true,
    holderReady: true,
    cleanupConfirmed: true,
    drainVerified: false,
  }), false);
});

test("#546 V10 SSH helper times out without treating an unclosed child as drained", async () => {
  const { spawnToClose } = require(READINESS);
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let unrefCalls = 0;
  child.unref = () => { unrefCalls += 1; };

  let failure = null;
  try {
    await spawnToClose(["test-host"], {
      keepStdinOpen: true,
      timeoutMs: 5,
      drainTimeoutMs: 5,
      spawnFn: () => child,
    });
  } catch (err) {
    failure = err;
  }
  assert.equal(failure && failure.code, "transport_drain_timeout");
  assert.equal(failure && failure.drainVerified, false);
  assert.equal(child.stdin.destroyed, true);
  assert.equal(unrefCalls, 1);
});

test("#546 V10 accepts only the identity nonce as the deliberate wrong-nonce request", () => {
  const { isExpectedWrongNonce } = require(READINESS);
  const identityNonce = "identity-nonce";
  const expectedNonce = "ingress-nonce";
  assert.equal(isExpectedWrongNonce("", identityNonce, expectedNonce), false);
  assert.equal(isExpectedWrongNonce("garbage", identityNonce, expectedNonce), false);
  assert.equal(isExpectedWrongNonce(expectedNonce, identityNonce, expectedNonce), false);
  assert.equal(isExpectedWrongNonce(identityNonce, identityNonce, expectedNonce), true);
});

test("production composition has no harness import or packaged failure-injection switch", () => {
  const production = [
    "main.js",
    "remote-ssh-ipc.js",
    "remote-ssh-runtime.js",
    "remote-ssh-transport-coordinator.js",
  ].map((name) => fs.readFileSync(path.join(ROOT, "src", name), "utf8")).join("\n");
  assert.doesNotMatch(production, /remote-ssh-codespaces-546|scripts[\\/]manual/i);
  assert.doesNotMatch(production, /CLAWD_.*(?:FAIL|INJECT).*SSH/i);
});
