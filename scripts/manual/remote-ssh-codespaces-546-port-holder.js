#!/usr/bin/env node
"use strict";

// Reproducible V9 helper for #546. It creates an exact test-owned listener in
// one sequential SSH operation, waits until that outer child has closed, then
// pauses locally while the Settings Connect attempt runs. Cleanup starts only
// after the operator confirms that the app attempt has ended.

const crypto = require("node:crypto");
const path = require("node:path");
const readline = require("node:readline");
const { buildSshArgs } = require("../../src/remote-ssh-runtime");
const { quoteForPosixShellArg } = require("../../src/remote-ssh-quote");
const { spawnToClose } = require("./remote-ssh-codespaces-546-readiness");

function parseArgs(argv) {
  const out = { remotePort: 23333 };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--ssh-config" || value === "--host") {
      out[value.slice(2)] = argv[++i];
    } else if (value === "--remote-port") {
      out.remotePort = Number.parseInt(argv[++i], 10);
    } else if (value === "--cleanup-id") {
      out.cleanupId = argv[++i];
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
  if (!Number.isInteger(out.remotePort) || out.remotePort < 1024 || out.remotePort > 65535) {
    throw new Error("--remote-port must be an integer from 1024 through 65535");
  }
  if (out.cleanupId && !/^[a-f0-9]{16}$/.test(out.cleanupId)) {
    throw new Error("--cleanup-id must be the exact 16-character V9 holder id");
  }
  return out;
}

function buildCleanupCommand(remoteRoot) {
  return [
    `d=${quoteForPosixShellArg(remoteRoot)}`,
    'case "$d" in',
    '  /tmp/clawd-546-v9-*) ;;',
    '  *) exit 90 ;;',
    'esac',
    '[ -f "$d/pid" ] || exit 93',
    'p=$(cat "$d/pid")',
    'case "$p" in',
    '  ""|*[!0-9]*) exit 93 ;;',
    'esac',
    'if kill -0 "$p" 2>/dev/null; then',
    '  cmd=$(tr "\\000" " " < "/proc/$p/cmdline" 2>/dev/null || true)',
    '  case "$cmd" in',
    '    *"$d/holder.js"*) kill "$p" ;;',
    '    *) exit 91 ;;',
    '  esac',
    '  i=0',
    '  while kill -0 "$p" 2>/dev/null && [ "$i" -lt 50 ]; do i=$((i+1)); sleep 0.1; done',
    '  kill -0 "$p" 2>/dev/null && exit 92',
    'fi',
    'rm -rf -- "$d"',
  ].join("\n");
}

function shouldStartCleanup({ setupAttempted, holderReady, cleanupConfirmed, drainVerified }) {
  return setupAttempted === true
    && drainVerified === true
    && (holderReady !== true || cleanupConfirmed === true);
}

function waitForConnectAttemptToEnd() {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error("V9 requires an interactive terminal for the cleanup barrier"));
  }
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.once("SIGINT", () => {
      rl.close();
      reject(new Error("V9 interrupted before cleanup confirmation"));
    });
    rl.question(
      "Run the app Connect attempt now. After it has fully ended, press Enter to remove the exact V9 holder... ",
      () => {
        rl.close();
        resolve(true);
      },
    );
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  process.env.CLAWD_REMOTE_SSH_CONFIG_FILE = options["ssh-config"];
  const token = options.cleanupId || crypto.randomBytes(8).toString("hex");
  const remoteRoot = `/tmp/clawd-546-v9-${token}`;
  const holderFile = `${remoteRoot}/holder.js`;
  const readyFile = `${remoteRoot}/ready`;
  const pidFile = `${remoteRoot}/pid`;
  const logFile = `${remoteRoot}/holder.log`;
  const readyMarker = `__CLAWD_V9_HOLDER_READY__:${token}`;
  const profile = { host: options.host };

  const holderSource = Buffer.from([
    '"use strict";',
    'const fs = require("node:fs");',
    'const net = require("node:net");',
    'const port = Number.parseInt(process.argv[2], 10);',
    'const ready = process.argv[3];',
    'const server = net.createServer((socket) => socket.destroy());',
    'server.once("error", () => process.exit(2));',
    'server.listen(port, "127.0.0.1", () => fs.writeFileSync(ready, "ready\\n", { mode: 0o600 }));',
    'for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));',
  ].join("\n"), "utf8").toString("base64");

  const cleanupCommand = buildCleanupCommand(remoteRoot);

  if (options.cleanupId) {
    const cleanup = await spawnToClose(buildSshArgs(profile).concat([cleanupCommand]));
    if (cleanup.code !== 0) throw new Error(`V9 cleanup SSH exited ${String(cleanup.code)}`);
    process.stdout.write(`${JSON.stringify({
      version: 1,
      scenario: "V9",
      holderId: token,
      exactCleanupComplete: true,
    })}\n`);
    return;
  }

  let setupAttempted = false;
  let drainVerified = true;
  let holderReady = false;
  let cleanupConfirmed = false;
  let primaryError = null;
  let cleanupWarning = null;
  try {
    const nodeResult = await spawnToClose(buildSshArgs(profile).concat(["command -v node"]));
    const nodeBin = nodeResult.stdout.toString("utf8").trim();
    if (nodeResult.code !== 0 || !nodeBin.startsWith("/") || /[\r\n\x00]/.test(nodeBin)) {
      throw new Error("could not resolve an absolute remote Node path");
    }
    const setupCommand = [
      "umask 077",
      `mkdir -p ${quoteForPosixShellArg(remoteRoot)}`,
      `base64 -d > ${quoteForPosixShellArg(holderFile)}`,
      `nohup ${quoteForPosixShellArg(nodeBin)} ${quoteForPosixShellArg(holderFile)} ${options.remotePort} ${quoteForPosixShellArg(readyFile)} > ${quoteForPosixShellArg(logFile)} 2>&1 < /dev/null & p=$!`,
      `printf '%s\\n' "$p" > ${quoteForPosixShellArg(pidFile)}`,
      `i=0; while [ "$i" -lt 100 ]; do if [ -f ${quoteForPosixShellArg(readyFile)} ]; then printf '%s\\n' ${quoteForPosixShellArg(readyMarker)}; exit 0; fi; kill -0 "$p" 2>/dev/null || exit 82; i=$((i+1)); sleep 0.1; done; exit 83`,
    ].join("; ");
    setupAttempted = true;
    const setup = await spawnToClose(buildSshArgs(profile).concat([setupCommand]), {
      input: holderSource,
    });
    if (setup.code !== 0 || !setup.stdout.includes(Buffer.from(readyMarker))) {
      throw new Error(`V9 holder setup SSH exited ${String(setup.code)} without readiness`);
    }
    holderReady = true;
    process.stdout.write(`${JSON.stringify({
      version: 1,
      scenario: "V9",
      holderId: token,
      holderReady: true,
      remotePort: options.remotePort,
      setupDrainVerified: true,
    })}\n`);
    cleanupConfirmed = await waitForConnectAttemptToEnd();
  } catch (err) {
    primaryError = err;
    if (err && err.drainVerified === false) drainVerified = false;
  } finally {
    if (shouldStartCleanup({ setupAttempted, holderReady, cleanupConfirmed, drainVerified })) {
      try {
        const cleanup = await spawnToClose(buildSshArgs(profile).concat([cleanupCommand]));
        if (cleanup.code !== 0) throw new Error(`V9 cleanup SSH exited ${String(cleanup.code)}`);
      } catch (err) {
        cleanupWarning = "exact V9 holder cleanup did not complete";
        if (!primaryError) primaryError = err;
      }
    } else if (setupAttempted) {
      cleanupWarning = drainVerified
        ? `V9 holder ${token} was preserved; after the app Connect attempt ends, rerun with --cleanup-id ${token}`
        : `V9 holder ${token} was preserved because transport drain was not verified; inspect it before cleanup`;
    }
  }
  if (primaryError) {
    if (cleanupWarning) primaryError.cleanupWarning = cleanupWarning;
    throw primaryError;
  }
  process.stdout.write(`${JSON.stringify({
    version: 1,
    scenario: "V9",
    holderReady: false,
    exactCleanupComplete: true,
  })}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    const warning = err && err.cleanupWarning ? `; ${err.cleanupWarning}` : "";
    process.stderr.write(`V9 port-holder harness failed: ${String(err && err.message || err).slice(0, 240)}${warning}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildCleanupCommand, parseArgs, shouldStartCleanup };
