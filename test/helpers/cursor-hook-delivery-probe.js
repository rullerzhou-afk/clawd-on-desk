"use strict";

// Run the real Cursor hook/reader/HTTP sender with isolated identity and a
// controllable synchronous metadata delay. Every socket goes to the test's
// receiver; neither a live Clawd nor the user's Cursor database is touched.
const os = require("node:os");
const http = require("node:http");
const path = require("node:path");

os.homedir = () => process.env.CLAWD_DELIVERY_HOME;
os.tmpdir = () => process.env.CLAWD_DELIVERY_HOME;
const receiverPort = Number(process.env.CLAWD_DELIVERY_PORT);
if (!Number.isInteger(receiverPort) || receiverPort <= 0 || receiverPort > 65535) {
  throw new Error("missing test-owned receiver port");
}
for (const method of ["get", "request"]) {
  const original = http[method];
  http[method] = (options, callback) => original({
    ...options,
    hostname: "127.0.0.1",
    port: receiverPort,
  }, callback);
}

const hooks = path.resolve(__dirname, "..", "..", "hooks");
if (process.env.CLAWD_DELIVERY_STALL === "1") {
  // Verify the final watchdog independently of the HTTP helper's own timeouts.
  require(path.join(hooks, "server-config")).postStateToRunningServer = () => {};
}
if (process.env.CLAWD_DELIVERY_THROW === "1") {
  require(path.join(hooks, "server-config")).postStateToRunningServer = () => {
    throw new Error("test transport failure");
  };
}
const shared = require(path.join(hooks, "shared-process"));
shared.createPidResolver = () => {
  let resolved = false;
  return () => {
    // Match the real resolver's reuse of the SessionStart prewarm.
    if (!resolved) {
      resolved = true;
      const delay = Number(process.env.CLAWD_DELIVERY_METADATA_DELAY) || 0;
      if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
    return { stablePid: process.pid, detectedEditor: "cursor", pidChain: [] };
  };
};
require(path.join(hooks, "cursor-session-title")).resolveSessionTitle = () => null;
