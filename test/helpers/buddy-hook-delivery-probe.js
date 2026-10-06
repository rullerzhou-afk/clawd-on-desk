"use strict";

// Run the real CodeBuddy / WorkBuddy hook with isolated identity and a
// controllable synchronous process-tree walk. Every socket goes to the test's
// receiver; neither a live Clawd nor the user's CodeBuddy / WorkBuddy data is
// touched.
//
// The hook files answer stdout before the (synchronous) process-tree walk so a
// slow Windows walk cannot get killed by the 800ms safety timeout before the
// fire-and-forget POST leaves the process. To prove the ORDER and the re-armed
// exit backstop without depending on parent-process scheduling, this probe
// records every event into one timeline file from inside the child:
//   - `stdout_write` on the first process.stdout.write;
//   - `walk_start` / `walk_end` around a fake createPidResolver walk that blocks
//     for CLAWD_BUDDY_WALK_MS;
//   - `send_start` when the stalled sender is invoked;
//   - `exit` from process.on("exit").
// All lines are written with synchronous appendFileSync in one process, so
// their order is the true event order and perf_hooks times are monotonic.
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

os.homedir = () => process.env.CLAWD_BUDDY_HOME;
os.tmpdir = () => process.env.CLAWD_BUDDY_HOME;

const receiverPort = Number(process.env.CLAWD_BUDDY_PORT);
if (!Number.isInteger(receiverPort) || receiverPort <= 0 || receiverPort > 65535) {
  throw new Error("missing test-owned receiver port");
}

const timelinePath = process.env.CLAWD_BUDDY_TIMELINE || "";
function appendTimeline(line) {
  if (!timelinePath) return;
  try {
    fs.appendFileSync(timelinePath, `${line}\n`);
  } catch {
    // The parent asserts on the file; a write failure must not also crash the
    // hook under test.
  }
}

let stdoutRecorded = false;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, callback) => {
  if (!stdoutRecorded) {
    stdoutRecorded = true;
    appendTimeline("stdout_write");
  }
  return originalStdoutWrite(chunk, encoding, callback);
};
process.on("exit", () => appendTimeline(`exit ${performance.now()}`));

for (const method of ["get", "request"]) {
  const original = http[method];
  http[method] = (options, callback) => original({
    ...options,
    hostname: "127.0.0.1",
    port: receiverPort,
    // The production 100ms budget is not under test here. A slow CI receiver
    // must not look like a lost POST.
    timeout: Math.max(Number(options.timeout) || 0, 1000),
    // Node's default globalAgent can honor an environment proxy
    // (NODE_USE_ENV_PROXY / HTTP_PROXY) and bypass the test receiver.
    agent: false,
  }, callback);
}

const hooksDir = path.resolve(__dirname, "..", "..", "hooks");
const serverConfigPath = path.join(hooksDir, "server-config");

if (process.env.CLAWD_BUDDY_STALL === "1") {
  // Verify the hook's own exit backstop independently of the HTTP helper's
  // timeouts: the sender never calls back.
  require(serverConfigPath).postStateToRunningServer = () => {
    appendTimeline(`send_start ${performance.now()}`);
  };
}
if (process.env.CLAWD_BUDDY_THROW === "1") {
  require(serverConfigPath).postStateToRunningServer = () => {
    throw new Error("test transport failure");
  };
}

const shared = require(path.join(hooksDir, "shared-process"));
// The hook destructures readStdinJson at load time, so replacing the export
// here (before the hook is required) is what the hook actually calls.
const originalReadStdinJson = shared.readStdinJson;
shared.readStdinJson = (...args) => {
  appendTimeline(`stdin_start ${performance.now()}`);
  return originalReadStdinJson(...args);
};
shared.createPidResolver = () => {
  let walked = false;
  return () => {
    // Match the real resolver: only the first call performs the (expensive)
    // walk; later calls reuse the prewarm.
    if (!walked) {
      walked = true;
      appendTimeline(`walk_start ${performance.now()}`);
      const delay = Number(process.env.CLAWD_BUDDY_WALK_MS) || 0;
      if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      appendTimeline(`walk_end ${performance.now()}`);
    }
    return {
      stablePid: process.pid,
      agentPid: null,
      detectedEditor: "codebuddy",
      pidChain: [],
      tmuxSocket: null,
      tmuxClient: null,
    };
  };
};
