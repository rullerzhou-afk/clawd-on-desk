"use strict";

const crypto = require("crypto");
const http = require("http");

const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
} = require("../hooks/server-config");
const { isValidRoutingNonce } = require("./remote-ssh-profile");

const ROUTING_NONCE_HEADER = "x-clawd-routing-nonce";

function timingSafeNonceMatch(candidate, acceptedNonces) {
  const candidateBuffer = Buffer.from(
    isValidRoutingNonce(candidate) ? candidate : "0".repeat(32),
    "utf8",
  );
  let matched = false;
  for (const accepted of acceptedNonces) {
    if (!isValidRoutingNonce(accepted)) continue;
    const acceptedBuffer = Buffer.from(accepted, "utf8");
    const equal = acceptedBuffer.length === candidateBuffer.length
      && crypto.timingSafeEqual(acceptedBuffer, candidateBuffer);
    matched = matched || equal;
  }
  return matched && isValidRoutingNonce(candidate);
}

function extractPermissionPathNonce(url) {
  if (typeof url !== "string") return null;
  const match = /^\/permission\/([a-f0-9]{32})$/.exec(url);
  return match ? match[1] : null;
}

function extractPermissionQueryNonce(url) {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url, "http://127.0.0.1");
    if (parsed.pathname !== "/permission") return null;
    const nonce = parsed.searchParams.get("nonce");
    return isValidRoutingNonce(nonce) && [...parsed.searchParams.keys()].length === 1
      ? nonce
      : null;
  } catch {
    return null;
  }
}

function createIngressRequestHandler(options = {}, counters = { acceptedCount: 0, rejectedCount: 0 }) {
  const routeRequest = options.routeRequest;
  const getAcceptedNonces = options.getAcceptedNonces;
  const remoteProfile = options.remoteProfile;
  if (typeof routeRequest !== "function") {
    throw new TypeError("createRemoteSshIngress requires routeRequest");
  }
  if (typeof getAcceptedNonces !== "function") {
    throw new TypeError("createRemoteSshIngress requires getAcceptedNonces");
  }
  if (!remoteProfile || typeof remoteProfile.profileId !== "string") {
    throw new TypeError("createRemoteSshIngress requires remoteProfile.profileId");
  }

  return (req, res) => {
    const acceptedNonces = getAcceptedNonces();
    const headerValue = typeof req.headers[ROUTING_NONCE_HEADER] === "string"
      ? req.headers[ROUTING_NONCE_HEADER]
      : "";
    const pathValue = extractPermissionPathNonce(req.url);
    const queryValue = extractPermissionQueryNonce(req.url);
    const nonce = pathValue || queryValue || headerValue;
    const allowedPath = (req.method === "GET" && req.url === "/state")
      || (req.method === "POST" && req.url === "/state")
      || (req.method === "POST" && (req.url === "/permission" || !!pathValue || !!queryValue));

    if (!allowedPath || !timingSafeNonceMatch(nonce, acceptedNonces)) {
      counters.rejectedCount += 1;
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }

    counters.acceptedCount += 1;
    if (pathValue || queryValue) req.url = "/permission";
    routeRequest(req, res, remoteProfile);
  };
}

function createRemoteSshIngress(options = {}) {
  const createServer = options.createServer || http.createServer.bind(http);
  const remoteProfile = options.remoteProfile;
  const counters = { rejectedCount: 0, acceptedCount: 0 };
  const requestHandler = createIngressRequestHandler(options, counters);
  let listeningPort = null;
  let closed = false;

  const server = createServer(requestHandler);
  let startPromise = null;

  function start() {
    if (closed) return Promise.reject(new Error("remote SSH ingress is closed"));
    if (listeningPort) return Promise.resolve(listeningPort);
    if (startPromise) return startPromise;
    startPromise = new Promise((resolve, reject) => {
      const cleanupListeners = () => {
        server.removeListener("error", onError);
        server.removeListener("listening", onListening);
        server.removeListener("close", onClose);
      };
      const onError = (err) => {
        cleanupListeners();
        startPromise = null;
        reject(err);
      };
      const onClose = () => {
        cleanupListeners();
        startPromise = null;
        reject(new Error("remote SSH ingress closed before listening"));
      };
      const onListening = () => {
        cleanupListeners();
        if (closed) {
          startPromise = null;
          try {
            if (typeof server.closeAllConnections === "function") server.closeAllConnections();
          } catch {}
          try { server.close(); } catch {}
          reject(new Error("remote SSH ingress closed before listening"));
          return;
        }
        const address = server.address();
        listeningPort = address && typeof address === "object" ? address.port : null;
        resolve(listeningPort);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.once("close", onClose);
      try {
        server.listen(0, "127.0.0.1");
      } catch (err) {
        onError(err);
      }
    });
    return startPromise;
  }

  function close() {
    if (closed) return;
    closed = true;
    try {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    } catch {}
    try { server.close(); } catch {}
    listeningPort = null;
  }

  function getStatus() {
    return {
      profileId: remoteProfile.profileId,
      port: listeningPort,
      listening: !!listeningPort && server.listening !== false,
      acceptedCount: counters.acceptedCount,
      rejectedCount: counters.rejectedCount,
      closed,
    };
  }

  return {
    start,
    close,
    getStatus,
    server,
  };
}

module.exports = {
  ROUTING_NONCE_HEADER,
  timingSafeNonceMatch,
  extractPermissionPathNonce,
  extractPermissionQueryNonce,
  createIngressRequestHandler,
  createRemoteSshIngress,
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
};
