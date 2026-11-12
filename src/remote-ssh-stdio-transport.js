"use strict";

const net = require("node:net");
const multiplex = require("multiplex");

const STDIO_READY_STREAM = "__clawd_stdio_ready__";
const STDIO_HEARTBEAT_STREAM = "__clawd_stdio_heartbeat__";
const STDIO_SHUTDOWN_STREAM = "__clawd_stdio_shutdown__";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 8000;

function normalizeChallenge(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) {
    throw new TypeError("Remote SSH stdio challenge must be 128-bit lowercase hex");
  }
  return value;
}

// The local side of a profile-bound TCP bridge. The remote bridge accepts
// ordinary HTTP hook connections and turns each one into a multiplex stream.
// This module only adapts those streams to the existing profile ingress; the
// framing, flow control, and half-close semantics belong to `multiplex`.
function createRemoteSshStdioTransport({
  child,
  localPort,
  challenge,
  onReady,
  onError,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  connect = net.connect,
  createMultiplex = multiplex,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!child || !child.stdin || !child.stdout) {
    throw new TypeError("createRemoteSshStdioTransport requires child stdin/stdout");
  }
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw new TypeError("createRemoteSshStdioTransport requires a local TCP port");
  }
  const readyChallenge = normalizeChallenge(challenge);
  if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs < 1000) {
    throw new TypeError("heartbeatIntervalMs must be at least 1000");
  }

  let closed = false;
  let ready = false;
  let readyBuffer = "";
  let heartbeatTimer = null;
  const sockets = new Set();

  const mux = createMultiplex({ chunked: true, halfOpen: true }, (stream, id) => {
    if (id === STDIO_READY_STREAM) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        readyBuffer += chunk;
        if (readyBuffer.length > 256 || ready) return;
        if (readyBuffer === readyChallenge) {
          ready = true;
          if (typeof onReady === "function") onReady();
        }
      });
      stream.on("error", () => {});
      return;
    }

    const socket = connect({ host: "127.0.0.1", port: localPort });
    sockets.add(socket);
    socket.setNoDelay?.(true);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {
      try { stream.destroy(); } catch {}
    });
    stream.on("error", () => {
      try { socket.destroy(); } catch {}
    });
    socket.pipe(stream).pipe(socket);
  });

  const fail = (err) => {
    if (closed) return;
    if (typeof onError === "function") onError(err);
  };
  mux.on("error", fail);
  child.stdin.on("error", fail);
  mux.pipe(child.stdin);
  child.stdout.pipe(mux);

  function sendControl(name) {
    if (!mux.destroyed) {
      try {
        const stream = mux.createStream(name);
        stream.end(readyChallenge);
      } catch {}
    }
  }

  heartbeatTimer = setIntervalFn(() => sendControl(STDIO_HEARTBEAT_STREAM), heartbeatIntervalMs);
  if (heartbeatTimer && typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();

  function close({ cooperative = true } = {}) {
    if (closed) return;
    closed = true;
    if (heartbeatTimer) {
      clearIntervalFn(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (cooperative) sendControl(STDIO_SHUTDOWN_STREAM);
    for (const socket of sockets) {
      try { socket.destroy(); } catch {}
    }
    sockets.clear();
    try { mux.end(); } catch {}
  }

  return {
    close,
    isReady: () => ready,
    getStatus: () => ({
      mode: "stdio",
      ready,
      localPort,
      streamCount: sockets.size,
      closed,
    }),
  };
}

module.exports = {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  STDIO_READY_STREAM,
  STDIO_HEARTBEAT_STREAM,
  STDIO_SHUTDOWN_STREAM,
  createRemoteSshStdioTransport,
};
