#!/usr/bin/env node
"use strict";

// Standalone V10 contract check for #546. This deliberately uses a temporary
// remoteHome under /tmp so the production readiness builder reads a test-only
// identity. It never edits a deployed Clawd identity or exposes nonce/argv
// contents in its result.

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const {
  buildPersistentReadinessCommand,
  buildSshArgs,
} = require("../../src/remote-ssh-runtime");
const { resolveRemoteRuntimeLayout } = require("../../src/remote-ssh-layout");
const { quoteForPosixShellArg } = require("../../src/remote-ssh-quote");

const MAX_CAPTURE_BYTES = 64 * 1024;
const SSH_OPERATION_TIMEOUT_MS = 45 * 1000;
const SSH_DRAIN_TIMEOUT_MS = 10 * 1000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--ssh-config" || value === "--host") {
      out[value.slice(2)] = argv[++i];
    } else {
      throw new Error(`unknown argument: ${value}`);
    }
  }
  if (!out["ssh-config"] || !path.isAbsolute(out["ssh-config"])) {
    throw new Error("--ssh-config must be an absolute path");
  }
  if (!out.host || /[\x00-\x1f\x7f]/.test(out.host)) {
    throw new Error("--host is required");
  }
  return out;
}

function appendBounded(current, chunk) {
  const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (current.length >= MAX_CAPTURE_BYTES) return current;
  return Buffer.concat([current, next.subarray(0, MAX_CAPTURE_BYTES - current.length)]);
}

function isExpectedWrongNonce(received, identityNonce, expectedNonce) {
  return received === identityNonce && received !== expectedNonce;
}

function spawnToClose(args, {
  input,
  keepStdinOpen = false,
  timeoutMs = SSH_OPERATION_TIMEOUT_MS,
  drainTimeoutMs = SSH_DRAIN_TIMEOUT_MS,
  spawnFn = childProcess.spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn("ssh", args, {
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let exitCode = null;
    let exitSignal = null;
    let settled = false;
    let timedOut = false;
    let operationTimer = null;
    let drainTimer = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(operationTimer);
      if (drainTimer) clearTimeout(drainTimer);
      fn(value);
    };
    const timeoutError = (drainVerified) => {
      const err = new Error(drainVerified
        ? "SSH operation exceeded its deadline"
        : "SSH operation exceeded its deadline and did not reach close");
      err.code = drainVerified ? "operation_timeout" : "transport_drain_timeout";
      err.drainVerified = drainVerified;
      return err;
    };
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.once("error", (err) => {
      err.drainVerified = true;
      settle(reject, err);
    });
    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    child.once("close", (code, signal) => {
      if (timedOut) {
        settle(reject, timeoutError(true));
        return;
      }
      settle(resolve, {
        code: exitCode === null ? code : exitCode,
        signal: exitSignal === null ? signal : exitSignal,
        stdout,
        stderr,
      });
    });
    operationTimer = setTimeout(() => {
      timedOut = true;
      if (child.stdin && !child.stdin.writableEnded && !child.stdin.destroyed) {
        try { child.stdin.end(); } catch {}
      }
      drainTimer = setTimeout(() => {
        // A killed outer ssh.exe would not prove that its nested gh stdio
        // proxy drained. Detach local handles, report the unverified drain,
        // and never start cleanup or other SSH work from this helper run.
        try { child.stdin.destroy(); } catch {}
        try { child.stdout.destroy(); } catch {}
        try { child.stderr.destroy(); } catch {}
        try { child.unref(); } catch {}
        settle(reject, timeoutError(false));
      }, drainTimeoutMs);
    }, timeoutMs);
    if (input !== undefined) child.stdin.end(input);
    else if (!keepStdinOpen) child.stdin.end();
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  process.env.CLAWD_REMOTE_SSH_CONFIG_FILE = options["ssh-config"];
  const token = crypto.randomBytes(8).toString("hex");
  const challenge = crypto.randomBytes(16).toString("hex");
  const identityNonce = crypto.randomBytes(16).toString("hex");
  const expectedNonce = crypto.randomBytes(16).toString("hex");
  const remoteHome = `/tmp/clawd-546-v10-${token}`;
  const remotePort = 24000 + crypto.randomInt(1000);
  const profile = {
    id: `v10-${token}`,
    host: options.host,
    installId: `v10-install-${token}`,
    remoteHome,
    remoteForwardPort: remotePort,
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    layoutVersion: 1,
  };
  const layout = resolveRemoteRuntimeLayout(profile);
  const identity = Buffer.from(JSON.stringify({
    version: 2,
    installId: profile.installId,
    profileId: profile.id,
    runtimeKey: profile.runtimeKey,
    layoutVersion: profile.layoutVersion,
    remotePort,
    deployedAt: Date.now(),
    routingNonce: identityNonce,
  }), "utf8").toString("base64");
  const identityDir = path.posix.dirname(layout.identityFile);
  const setupCommand = [
    "umask 077",
    `mkdir -p ${quoteForPosixShellArg(identityDir)}`,
    `base64 -d > ${quoteForPosixShellArg(layout.identityFile)}`,
  ].join("; ");
  const cleanupCommand = [
    `d=${quoteForPosixShellArg(remoteHome)}`,
    'case "$d" in /tmp/clawd-546-v10-*) rm -rf -- "$d" ;; *) exit 90 ;; esac',
  ].join("; ");

  let requestCount = 0;
  let wrongNonceRejected = false;
  const server = http.createServer((req, res) => {
    requestCount += 1;
    const received = String(req.headers["x-clawd-routing-nonce"] || "");
    wrongNonceRejected ||= isExpectedWrongNonce(received, identityNonce, expectedNonce);
    req.resume();
    res.statusCode = 404;
    res.end("not found");
  });

  let setupAttempted = false;
  let cleanupAllowed = true;
  let cleanupWarning = null;
  let primaryError = null;
  let resultPayload = null;
  try {
    setupAttempted = true;
    const setup = await spawnToClose(
      buildSshArgs(profile).concat([setupCommand]),
      { input: identity },
    );
    if (setup.code !== 0) throw new Error(`setup SSH exited ${String(setup.code)}`);

    const nodeResult = await spawnToClose(
      buildSshArgs(profile).concat(["command -v node"]),
    );
    const nodeBin = nodeResult.stdout.toString("utf8").trim();
    if (nodeResult.code !== 0 || !nodeBin.startsWith("/") || /[\r\n\x00]/.test(nodeBin)) {
      throw new Error("could not resolve an absolute remote Node path");
    }

    const localPort = await listen(server);
    const command = buildPersistentReadinessCommand(remotePort, nodeBin, {
      profile,
      challenge,
      probeWindowMs: 12000,
    });
    const forward = `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`;
    const result = await spawnToClose(buildSshArgs(profile, {
      extraOpts: [
        "-v",
        "-R", forward,
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=5",
        "-o", "ServerAliveCountMax=2",
      ],
    }).concat([command]), { keepStdinOpen: true });
    const markerSeen = result.stdout.includes(Buffer.from(`__CLAWD_REMOTE_READY__:${challenge}`));
    const ok = result.code === 3
      && markerSeen === false
      && requestCount === 1
      && wrongNonceRejected;
    resultPayload = {
      version: 1,
      scenario: "V10",
      ok,
      exitCode: result.code,
      markerSeen,
      requestCount,
      wrongNonceRejected,
      stderrHash: crypto.createHash("sha256").update(result.stderr).digest("hex"),
    };
    if (!ok) throw new Error("readiness contract did not fail closed as expected");
  } catch (err) {
    primaryError = err;
    if (err && err.drainVerified === false) cleanupAllowed = false;
  } finally {
    await closeServer(server);
    if (setupAttempted && cleanupAllowed) {
      try {
        const cleanup = await spawnToClose(buildSshArgs(profile).concat([cleanupCommand]));
        if (cleanup.code !== 0) throw new Error(`cleanup SSH exited ${String(cleanup.code)}`);
      } catch (err) {
        cleanupWarning = "exact test-root cleanup did not complete";
        if (!primaryError) primaryError = err;
      }
    } else if (setupAttempted) {
      cleanupWarning = "exact test-root cleanup was skipped because transport drain was not verified";
    }
  }
  if (resultPayload) process.stdout.write(`${JSON.stringify(resultPayload)}\n`);
  if (primaryError) {
    if (cleanupWarning) primaryError.cleanupWarning = cleanupWarning;
    throw primaryError;
  }
}

if (require.main === module) {
  main().catch((err) => {
    const warning = err && err.cleanupWarning ? `; ${err.cleanupWarning}` : "";
    process.stderr.write(`V10 readiness harness failed: ${String(err && err.message || err).slice(0, 240)}${warning}\n`);
    process.exitCode = 1;
  });
}

module.exports = { isExpectedWrongNonce, spawnToClose };
