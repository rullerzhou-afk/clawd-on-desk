// src/network/mobile-preview-server.js — LAN WebSocket bridge for PWA mobile clients
// Protocol v1 — serves static PWA files + WebSocket on 0.0.0.0 for LAN access.
// M1: read-only snapshot/state push. No write or approval operations.
// Token rotation: 24h auto-rotation with 5-minute grace window.

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const WebSocket = require("ws");
const { sessionDisplayFolder } = require("../state-session-snapshot");

const PROTOCOL_VERSION = "v1";
const DEFAULT_PORT = 23334;
const PORT_RANGE = 5;
const HEARTBEAT_MS = 30000;
const CLIENT_TIMEOUT_MS = 90000;
const RATE_WINDOW_MS = 60000;
const RATE_MAX = 60;
const MAX_CLIENTS = 10;
const GRACE_PERIOD_MS = 5 * 60 * 1000;          // 5 minutes
const ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

const PWA_DIR = path.resolve(__dirname, "../../pwa");
const CANONICAL_ICON_DIR = path.resolve(__dirname, "../../assets/icons");
const PWA_ICON_ALIASES = new Map([
  ["icons/icon-256.png", path.join(CANONICAL_ICON_DIR, "256x256.png")],
  ["icons/icon-512.png", path.join(CANONICAL_ICON_DIR, "512x512.png")],
]);
const TOKEN_PATH = path.join(os.homedir(), ".clawd", "mobile-token.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function isRetryablePortError(err) {
  return !!(err && (err.code === "EADDRINUSE" || err.code === "EACCES"));
}

// ── Token persistence ──

function atomicWrite(tokenPath, state) {
  try {
    const dir = path.dirname(tokenPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = tokenPath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmpPath, tokenPath);
    return true;
  } catch (err) {
    console.error("[mobile-preview] atomicWrite failed:", err.message);
    return false;
  }
}

function loadOrCreateTokenState(tokenPath, nowFn, writeTokenState = atomicWrite) {
  try {
    const raw = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
    if (raw && typeof raw.token === "string" && /^[a-f0-9]{32,64}$/.test(raw.token)) {
      const state = {
        token: raw.token,
        previous: raw.previous || null,
        graceUntil: typeof raw.graceUntil === "number" ? raw.graceUntil : null,
        rotatedAt: typeof raw.rotatedAt === "number" ? raw.rotatedAt : nowFn(),
        rotationPending: typeof raw.rotationPending === "boolean" ? raw.rotationPending : false,
      };
      // Backward compat: rewrite file if it was in old { token } format
      if (raw.rotatedAt === undefined) writeTokenState(tokenPath, state);
      return state;
    }
  } catch {}
  const token = crypto.randomBytes(16).toString("hex");
  const state = { token, previous: null, graceUntil: null, rotatedAt: nowFn(), rotationPending: false };
  writeTokenState(tokenPath, state);
  return state;
}

function buildMessage(type, payload) {
  return JSON.stringify({ version: PROTOCOL_VERSION, type, timestamp: Date.now(), ...payload });
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function initMobilePreviewServer(ctx) {
  const tokenPath = (ctx && ctx.tokenPath) || TOKEN_PATH;
  const now = () => (ctx && ctx.now && ctx.now()) || Date.now();
  const writeTokenState = ctx && typeof ctx.writeTokenState === "function"
    ? ctx.writeTokenState
    : atomicWrite;
  const tokenState = loadOrCreateTokenState(tokenPath, now, writeTokenState);
  const clients = new Set();
  const clientMeta = new Map();
  let sessionCache = new Map();
  let httpServer = null;
  let wss = null;
  let activePort = null;
  let heartbeatTimer = null;
  let rotationTimer = null;
  let startPromise = null;
  let cancelPendingStart = null;
  let closed = false;

  // ── Token rotation ──

  function persistTokenState(nextState) {
    if (!writeTokenState(tokenPath, nextState)) return false;
    Object.assign(tokenState, nextState);
    return true;
  }

  function scheduleRotationRetry() {
    if (rotationTimer) clearTimeout(rotationTimer);
    rotationTimer = setTimeout(() => {
      rotationTimer = null;
      scheduleRotation();
    }, RATE_WINDOW_MS);
  }

  function rotateToken() {
    const newToken = crypto.randomBytes(16).toString("hex");
    const rotatedAt = now();
    const nextState = {
      ...tokenState,
      previous: tokenState.token,
      token: newToken,
      graceUntil: rotatedAt + GRACE_PERIOD_MS,
      rotatedAt,
      rotationPending: false,
    };
    if (!persistTokenState(nextState)) return null;
    return newToken;
  }

  function performRotation() {
    if (!rotateToken()) {
      console.error("[mobile-preview] token rotation skipped: failed to persist token state");
      return false;
    }
    // Track which clients need to ack this rotation
    for (const meta of clientMeta.values()) {
      meta.pendingRotationAcks = (meta.pendingRotationAcks || 0) + 1;
    }
    broadcast(buildMessage("token_rotate", {
      newToken: tokenState.token,
      expiresAt: tokenState.graceUntil,
    }));
    return true;
  }

  function scheduleRotation() {
    if (tokenState.rotationPending) return;
    if (rotationTimer) clearTimeout(rotationTimer);
    const msUntilRotate = Math.max(0, (tokenState.rotatedAt + ROTATION_INTERVAL_MS) - now());
    rotationTimer = setTimeout(() => {
      rotationTimer = null;
      if (clients.size > 0) {
        if (!performRotation()) {
          scheduleRotationRetry();
          return;
        }
      } else {
        const nextState = { ...tokenState, rotationPending: true };
        if (!persistTokenState(nextState)) {
          console.error("[mobile-preview] pending token rotation skipped: failed to persist token state");
          scheduleRotationRetry();
          return;
        }
      }
      scheduleRotation(); // schedule next (if rotationPending, early-exits)
    }, msUntilRotate);
  }

  function regenerateToken() {
    const newToken = crypto.randomBytes(16).toString("hex");
    const nextState = {
      ...tokenState,
      rotationPending: false,
      previous: null,      // no grace — old token dies now
      graceUntil: null,
      token: newToken,
      rotatedAt: now(),
    };
    if (!persistTokenState(nextState)) {
      throw new Error("Failed to persist mobile token state");
    }
    // Kick all connected clients (they have stale tokens)
    for (const c of clients) {
      try { c.close(1008, "Token regenerated"); } catch {}
    }
    clients.clear();
    clientMeta.clear();
    scheduleRotation(); // reset the 24h timer
    return newToken;
  }

  // Full reset: regenerates token AND will revoke all device registrations
  // in Slice 2+ (device-list semantics). regenerateToken() only rotates the
  // token and kicks connected clients, but does not clear the device roster.
  function resetMobileAccess() {
    return regenerateToken();
  }

  // ── HTTP server (serves PWA + WebSocket upgrade) ──

  function getLocalIP() {
    const interfaces = os.networkInterfaces();
    const wlanPattern = /WLAN|Wi-?Fi|Wireless|无线/i;
    // 1) 优先找 WLAN 接口
    for (const name of Object.keys(interfaces)) {
      if (wlanPattern.test(name)) {
        for (const iface of interfaces[name]) {
          if (iface.family === "IPv4" && !iface.internal) return iface.address;
        }
      }
    }
    // 2) fallback：第一个非 internal IPv4
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) return iface.address;
      }
    }
    return "127.0.0.1";
  }

  function serveStatic(req, res) {
    let urlPath;
    try { urlPath = new URL(req.url, "http://localhost").pathname; } catch { res.writeHead(400); res.end(); return; }

    // API endpoint for connection info (M1: no token — must come from Settings page or URL params)
    if (urlPath === "/api/connection-info") {
      const ready = Number.isInteger(activePort) && activePort > 0;
      const info = { status: ready ? "ok" : "starting", port: ready ? activePort : null, lanIp: getLocalIP() };
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify(info));
      return;
    }

    if (urlPath === "/mobile/" || urlPath === "/mobile") urlPath = "/mobile/index.html";
    if (!urlPath.startsWith("/mobile/")) { res.writeHead(404); res.end(); return; }
    const rel = urlPath.slice("/mobile/".length);
    const aliasedIcon = PWA_ICON_ALIASES.get(rel);
    const assetRoot = aliasedIcon ? CANONICAL_ICON_DIR : PWA_DIR;
    const filePath = aliasedIcon || path.join(PWA_DIR, rel);
    if (!isPathInside(assetRoot, filePath)) { res.writeHead(403); res.end(); return; }
    const ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
      });
      res.end(data);
    });
  }

  function createHttpServer() {
    if (ctx && typeof ctx.createHttpServer === "function") {
      return ctx.createHttpServer(serveStatic);
    }
    return http.createServer(serveStatic);
  }

  // Attach ws only after the HTTP server has successfully bound a port.
  // WebSocket.Server forwards the underlying HTTP server's pre-listen
  // EADDRINUSE as its own `error` event. When ws was attached before the port
  // retry loop, that forwarded event had no server-level listener and crashed
  // the process before start() could advance from 23334 to the next candidate.
  function attachWebSocketServer(server) {
    const WebSocketServer = ctx && ctx.WebSocketServer
      ? ctx.WebSocketServer
      : WebSocket.Server;
    const socketServer = new WebSocketServer({ server, path: "/ws" });
    wss = socketServer;
    // A post-listen server error is still surfaced by ws. Keep it observable
    // without letting an EventEmitter `error` event terminate the desktop app.
    socketServer.on("error", (err) => {
      try {
        if (ctx && typeof ctx.onWebSocketError === "function") {
          ctx.onWebSocketError(err);
        } else {
          console.error("[mobile-preview] WebSocket server error:", err && err.message ? err.message : err);
        }
      } catch {}
    });

    socketServer.on("connection", (ws, req) => {
      if (closed) { ws.close(1001, "Server shutting down"); return; }

      let url;
      try { url = new URL(req.url, "http://localhost"); } catch { ws.close(1008, "Bad request"); return; }

      // Token validation with grace-period support
      const clientToken = url.searchParams.get("token");
      let graceAccepted = false;
      if (clientToken !== tokenState.token) {
        // Check grace period for previous token
        if (tokenState.previous && clientToken === tokenState.previous
            && tokenState.graceUntil !== null && now() < tokenState.graceUntil) {
          // Accept via grace — client hasn't acked the rotation yet
          graceAccepted = true;
        } else {
          ws.close(1008, "Invalid token");
          return;
        }
      }

      if (clients.size >= MAX_CLIENTS) {
        ws.close(1013, "Server busy");
        return;
      }

      clients.add(ws);
      const clientId = crypto.randomBytes(8).toString("hex");
      const clientIp = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
      clientMeta.set(ws, { messageCount: 0, windowStart: Date.now(), clientId, ip: clientIp, lastPong: Date.now() });

      // If a rotation was pending and this client has the current token, rotate now
      if (tokenState.rotationPending && clientToken === tokenState.token) {
        if (performRotation()) {
          scheduleRotation(); // arm the next 24h timer
        }
      }

      // Send snapshot on connect
      try {
        const snapshot = {};
        for (const [sid, data] of sessionCache) snapshot[sid] = data;
        ws.send(buildMessage("snapshot", { sessions: snapshot }));
      } catch {}

      startHeartbeat();

      // If client connected via grace-period token, send the new token immediately
      // (after startHeartbeat so the first heartbeat tick doesn't duplicate the send)
      if (graceAccepted) {
        const meta = clientMeta.get(ws);
        if (meta) meta.pendingRotationAcks = 1;
        try {
          ws.send(buildMessage("token_rotate", {
            newToken: tokenState.token,
            expiresAt: tokenState.graceUntil,
          }));
        } catch {}
      }
      ws.isAlive = true;
      ws.on("pong", () => {
        ws.isAlive = true;
        const meta = clientMeta.get(ws);
        if (meta) meta.lastPong = Date.now();
      });

      ws.on("message", (data) => {
        if (closed) return;
        const meta = clientMeta.get(ws);
        if (!meta) return;
        const nowMs = Date.now();
        if (nowMs - meta.windowStart > RATE_WINDOW_MS) { meta.messageCount = 0; meta.windowStart = nowMs; }
        if (++meta.messageCount > RATE_MAX) { ws.close(1008, "Rate limit"); return; }
        // Handle token_rotate_ack — purely informational, no state change
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.type === "token_rotate_ack") {
            meta.pendingRotationAcks = 0;
            console.log(`[mobile-preview] token_rotate_ack from ${meta.ip}`);
            return;
          }
        } catch {}
        // M1: read-only — ignore all other client messages (rate-limit still applies above)
      });

      ws.on("close", () => {
        clients.delete(ws);
        clientMeta.delete(ws);
        if (clients.size === 0) stopHeartbeat();
      });
      ws.on("error", () => { clients.delete(ws); clientMeta.delete(ws); });
    });
    return socketServer;
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      const nowMs = Date.now();
      for (const c of clients) {
        const meta = clientMeta.get(c);
        if (c.isAlive === false || (meta && nowMs - meta.lastPong > CLIENT_TIMEOUT_MS)) {
          c.terminate();
          clients.delete(c);
          clientMeta.delete(c);
          continue;
        }
        // Retry token_rotate for unacked clients (up to 3 times)
        if (meta && meta.pendingRotationAcks > 0) {
          if (meta.pendingRotationAcks >= 3) {
            c.close(1008, "Token rotation not acknowledged");
            clients.delete(c);
            clientMeta.delete(c);
            continue;
          }
          try {
            c.send(buildMessage("token_rotate", {
              newToken: tokenState.token,
              expiresAt: tokenState.graceUntil,
            }));
          } catch {}
          meta.pendingRotationAcks++;
        }
        c.isAlive = false;
        try { c.ping(); } catch {}
      }
      if (clients.size === 0) stopHeartbeat();
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  function broadcast(message) {
    for (const c of clients) {
      if (c.readyState === WebSocket.OPEN) {
        try { c.send(message); } catch {}
      }
    }
  }

  // ── Session data ──

  function buildPayload(sid, session) {
    if (!session) return null;
    const recentEvents = Array.isArray(session.recentEvents) ? session.recentEvents.slice(-10) : [];
    // Explicit empty displayFolder is a privacy decision made by the shared
    // snapshot builder. Raw/legacy session maps do not carry the additive field,
    // so derive the same safe display value through the shared helper.
    const folderSource = Object.prototype.hasOwnProperty.call(session, "displayFolder")
      ? session.displayFolder
      : sessionDisplayFolder(sid, session);
    return {
      sessionId: sid,
      agentId: session.agentId || null,
      title: session.sessionTitle || null,
      basename: folderSource ? path.basename(String(folderSource)) : null,
      state: session.state || "idle",
      updatedAt: session.updatedAt || null,
      recentEvents,
    };
  }

  function broadcastState(sid, data) {
    broadcast(buildMessage("state", { sessionId: sid, data }));
  }

  // ── Session polling (detects state changes + deletions) ──

  function pollSessions() {
    if (closed) return;
    const upstream = ctx.sessions;
    if (!upstream) return;

    // First poll: populate cache and broadcast snapshot to all clients
    if (sessionCache.size === 0 && upstream.size > 0) {
      for (const [sid, session] of upstream) {
        const payload = buildPayload(sid, session);
        if (payload) sessionCache.set(sid, payload);
      }
      const snapshot = {};
      for (const [sid, data] of sessionCache) snapshot[sid] = data;
      broadcast(buildMessage("snapshot", { sessions: snapshot }));
      return;
    }

    // Detect new/changed sessions
    for (const [sid, session] of upstream) {
      const payload = buildPayload(sid, session);
      if (!payload) continue;
      const cached = sessionCache.get(sid);
      if (!cached || JSON.stringify(cached) !== JSON.stringify(payload)) {
        sessionCache.set(sid, payload);
        broadcastState(sid, payload);
      }
    }

    // Detect deleted sessions
    for (const sid of sessionCache.keys()) {
      if (!upstream.has(sid)) {
        sessionCache.delete(sid);
        broadcast(buildMessage("session_deleted", { sessionId: sid }));
      }
    }
  }

  // ── Public API ──

  function start() {
    if (Number.isInteger(activePort) && httpServer && httpServer.listening) {
      return Promise.resolve(activePort);
    }
    if (startPromise) return startPromise;

    closed = false;
    let server;
    try {
      server = createHttpServer();
      httpServer = server;
    } catch (err) {
      closed = true;
      return Promise.reject(err);
    }
    const ports = [];
    for (let i = 0; i < PORT_RANGE; i++) ports.push(DEFAULT_PORT + i);
    let idx = 0;
    let socketServer = null;
    let settled = false;
    let cancelThisStart = null;

    const ready = new Promise((resolve, reject) => {
      const detachStartListeners = () => {
        server.removeListener("error", onError);
        server.removeListener("listening", onListening);
      };
      const closeAttempt = () => {
        if (socketServer) { try { socketServer.close(); } catch {} }
        // A cancelled listen can still surface its queued error after close().
        // Keep that EventEmitter error observed while this discarded server is
        // collected; it is no longer part of the active lifecycle.
        server.on("error", () => {});
        try { server.close(); } catch {}
        if (wss === socketServer) wss = null;
        if (httpServer === server) httpServer = null;
        activePort = null;
      };
      const failStart = (err) => {
        if (settled) return;
        settled = true;
        detachStartListeners();
        closeAttempt();
        closed = true;
        reject(err);
      };
      const onError = (err) => {
        if (isRetryablePortError(err) && idx < ports.length - 1) {
          idx++;
          try {
            server.listen(ports[idx], "0.0.0.0");
          } catch (listenErr) {
            failStart(listenErr);
          }
          return;
        }
        console.error("[lan-ws] Server error:", err.message);
        failStart(err);
      };
      const onListening = () => {
        if (closed || httpServer !== server) {
          const err = new Error("Mobile preview server start cancelled");
          err.code = "ECANCELED";
          failStart(err);
          return;
        }
        try {
          socketServer = attachWebSocketServer(server);
        } catch (err) {
          failStart(err);
          return;
        }
        activePort = ports[idx];
        try {
          pollSessions(); // Prime cache only after the listener is usable.
          scheduleRotation(); // Failed starts must not mutate token state later.
        } catch (err) {
          failStart(err);
          return;
        }
        settled = true;
        console.log(`[mobile-preview] started on 0.0.0.0:${activePort}`);
        detachStartListeners();
        if (cancelPendingStart === cancelThisStart) cancelPendingStart = null;
        resolve(activePort);
      };
      cancelThisStart = () => {
        const err = new Error("Mobile preview server start cancelled");
        err.code = "ECANCELED";
        failStart(err);
      };
      cancelPendingStart = cancelThisStart;
      server.on("error", onError);
      server.on("listening", onListening);
      try {
        server.listen(ports[0], "0.0.0.0");
      } catch (err) {
        failStart(err);
      }
    });

    let trackedPromise;
    trackedPromise = ready.then(
      (port) => {
        if (startPromise === trackedPromise) startPromise = null;
        return port;
      },
      (err) => {
        if (startPromise === trackedPromise) startPromise = null;
        // cleanup() deliberately allows a same-tick replacement start. The
        // cancelled generation's rejection continuation must not clear the
        // replacement generation's cancel handle.
        if (cancelPendingStart === cancelThisStart) cancelPendingStart = null;
        throw err;
      },
    );
    startPromise = trackedPromise;
    return trackedPromise;
  }

  function cleanup() {
    closed = true;
    const cancel = cancelPendingStart;
    cancelPendingStart = null;
    if (cancel) cancel();
    // A same-tick disable → enable transition must create a fresh listener,
    // not inherit the cancelled promise until its rejection microtask runs.
    startPromise = null;
    sessionCache.clear();
    stopHeartbeat();
    if (rotationTimer) { clearTimeout(rotationTimer); rotationTimer = null; }
    for (const c of clients) { try { c.close(1001, "Server shutting down"); } catch {} }
    clients.clear();
    clientMeta.clear();
    if (wss) { try { wss.close(); } catch {} }
    if (httpServer) { try { httpServer.close(); } catch {} }
    wss = null;
    httpServer = null;
    activePort = null;
  }

  function onSnapshot() {
    if (closed) return;
    pollSessions();
  }

  return {
    start,
    cleanup,
    onSnapshot,
    getPort: () => activePort,
    getToken: () => tokenState.token,
    regenerateToken,
    resetMobileAccess,
    PROTOCOL_VERSION,
  };
}

module.exports = { initMobilePreviewServer, isRetryablePortError, PROTOCOL_VERSION };
