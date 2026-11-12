"use strict";

// This file is bundled into hooks/remote-ssh-stdio-bridge.js so the remote
// host does not need npm/node_modules. Keep stdout reserved for multiplex
// frames: audited gateways can merge remote stderr into stdout.
process.noDeprecation = true;

const net = require("net");
const multiplex = require("multiplex");

const STREAM_READY = "__clawd_stdio_ready__";
const STREAM_HEARTBEAT = "__clawd_stdio_heartbeat__";
const STREAM_SHUTDOWN = "__clawd_stdio_shutdown__";
const HEARTBEAT_TIMEOUT_MS = 30000;
const HEARTBEAT_CHECK_INTERVAL_MS = 5000;

const port = Number(process.argv[2]);
const challenge = String(process.argv[3] || "");
if (!Number.isInteger(port) || port < 1 || port > 65535
  || !/^[a-f0-9]{32}$/.test(challenge)) {
  process.exit(64);
}

let stopping = false;
let lastHeartbeatAt = Date.now();
let heartbeatTimer = null;

const mux = multiplex({ chunked: true, halfOpen: true }, (stream, id) => {
  if (id === STREAM_HEARTBEAT) {
    lastHeartbeatAt = Date.now();
    stream.resume();
    return;
  }
  if (id === STREAM_SHUTDOWN) {
    stream.setEncoding("utf8");
    let value = "";
    stream.on("data", (chunk) => {
      value += chunk;
      if (value === challenge) shutdown(0);
    });
    stream.on("error", () => {});
    return;
  }
  stream.resume();
});

const server = net.createServer((socket) => {
  socket.setNoDelay?.(true);
  const stream = mux.createStream();
  socket.on("error", () => {
    try { stream.destroy(); } catch {}
  });
  stream.on("error", () => {
    try { socket.destroy(); } catch {}
  });
  socket.pipe(stream).pipe(socket);
});

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  try { server.close(); } catch {}
  try { mux.end(); } catch {}
  process.exitCode = code;
  setTimeout(() => process.exit(code), 50);
}

mux.on("error", () => shutdown(74));
server.on("error", () => shutdown(98));
process.stdin.on("end", () => shutdown(0));
process.stdin.on("error", () => shutdown(74));
mux.pipe(process.stdout);
process.stdin.pipe(mux);

server.listen(port, "127.0.0.1", () => {
  const ready = mux.createStream(STREAM_READY);
  ready.end(challenge);
  heartbeatTimer = setInterval(() => {
    if (Date.now() - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) shutdown(0);
  }, HEARTBEAT_CHECK_INTERVAL_MS);
});
