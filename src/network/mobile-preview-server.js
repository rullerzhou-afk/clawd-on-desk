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

const PROTOCOL_VERSION = "v1";
const DEFAULT_PORT = 23334;
const PORT_RANGE = 5;
const HEARTBEAT_MS = 30000;
const CLIENT_TIMEOUT_MS = 90000;
const RATE_WINDOW_MS = 60000;
const RATE_MAX = 60;
const MAX_CLIENTS = 10;
const SHUTDOWN_FORCE_CLOSE_MS = 250;
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
  const permissionObservation = ctx && ctx.permissionObservation;
  const log = ctx && typeof ctx.log === "function" ? ctx.log : console.log;
  const createHttpServer = ctx && typeof ctx.createHttpServer === "function"
    ? ctx.createHttpServer
    : (handler) => http.createServer(handler);
  const createWebSocketServer = ctx && typeof ctx.createWebSocketServer === "function"
    ? ctx.createWebSocketServer
    : (options) => new WebSocket.Server(options);
  const clients = new Set();
  const clientMeta = new Map();
  let sessionCache = new Map();
  let httpServer = null;
  let wss = null;
  let activePort = null;
  let heartbeatTimer = null;
  let rotationTimer = null;
  let observationUnsubscribe = null;
  let startPromise = null;
  let rejectPendingStart = null;
  let stopPromise = null;
  let runtimeRevision = 0;
  let closed = true;

  function readPermissionObservationSnapshot() {
    if (!permissionObservation || typeof permissionObservation.snapshot !== "function") {
      return Object.freeze({
        feature: Object.freeze({ supported: false, enabled: false }),
        records: Object.freeze([]),
      });
    }
    try {
      const snapshot = permissionObservation.snapshot() || {};
      const feature = snapshot.feature || {};
      return {
        feature: {
          supported: feature.supported === true,
          enabled: feature.enabled === true,
        },
        records: Array.isArray(snapshot.records) ? snapshot.records : [],
      };
    } catch (err) {
      console.warn("[mobile-preview] permission observation snapshot failed:", err && err.message);
      return { feature: { supported: true, enabled: false }, records: [] };
    }
  }

  function buildPermissionFeature(snapshot = readPermissionObservationSnapshot()) {
    return {
      supported: snapshot.feature.supported === true,
      enabled: snapshot.feature.enabled === true,
    };
  }

  function buildPermissionSnapshotPayload(snapshot = readPermissionObservationSnapshot()) {
    return {
      feature: buildPermissionFeature(snapshot),
      permissions: snapshot.records,
    };
  }

  function logPermissionFanout(type, delivered, details = {}) {
    try {
      log(`[mobile-preview] permission fanout type=${type}`
        + `${details.requestId ? ` requestId=${details.requestId}` : ""}`
        + `${details.source ? ` source=${details.source}` : ""}`
        + `${details.reason ? ` reason=${details.reason}` : ""}`
        + `${typeof details.decided === "boolean" ? ` decided=${details.decided}` : ""}`
        + ` clients=${delivered}`);
    } catch {}
  }

  function onPermissionObservationEvent(event) {
    if (closed || !event || typeof event !== "object") return;
    if (event.type === "replace") {
      const delivered = broadcast(buildMessage("permission_snapshot", {
        feature: {
          supported: event.feature && event.feature.supported === true,
          enabled: event.feature && event.feature.enabled === true,
        },
        permissions: Array.isArray(event.records) ? event.records : [],
      }));
      logPermissionFanout("permission_snapshot", delivered, { source: "replace" });
      return;
    }
    if (event.type === "upsert" && event.record) {
      const delivered = broadcast(buildMessage("permission_request", { permission: event.record }));
      logPermissionFanout("permission_request", delivered, { requestId: event.record.requestId });
      return;
    }
    if (event.type === "retract" && typeof event.requestId === "string") {
      const delivered = broadcast(buildMessage("permission_dismissed", {
        requestId: event.requestId,
        reason: event.reason,
        decided: event.decided === true,
      }));
      logPermissionFanout("permission_dismissed", delivered, {
        requestId: event.requestId,
        reason: event.reason,
        decided: event.decided === true,
      });
    }
  }

  function attachPermissionObservation() {
    if (observationUnsubscribe || !permissionObservation
        || typeof permissionObservation.subscribe !== "function") return;
    observationUnsubscribe = permissionObservation.subscribe(onPermissionObservationEvent);
  }

  function detachPermissionObservation() {
    if (typeof observationUnsubscribe === "function") {
      try { observationUnsubscribe(); } catch {}
    }
    observationUnsubscribe = null;
  }

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

  function regenerateToken(closeReason = "Token regenerated") {
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
      try { c.close(1008, closeReason); } catch {}
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
    return regenerateToken("access-reset");
  }

  function disconnectClients({ code = 1001, reason = "Reconnecting" } = {}) {
    for (const client of clients) {
      try { client.close(code, reason); } catch {}
    }
    clients.clear();
    clientMeta.clear();
    stopHeartbeat();
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

  function createServers() {
    httpServer = createHttpServer(serveStatic);
    wss = createWebSocketServer({ server: httpServer, path: "/ws" });

    wss.on("connection", (ws, req) => {
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

      // Add the client, then synchronously send both authoritative snapshots.
      // Do not introduce an await here: this single event-loop turn preserves
      // snapshot-before-delta ordering for the observation subscriber.
      let permissionSnapshotSent = false;
      try {
        const snapshot = {};
        for (const [sid, data] of sessionCache) snapshot[sid] = data;
        const permissionSnapshot = readPermissionObservationSnapshot();
        const permissionFeature = buildPermissionFeature(permissionSnapshot);
        ws.send(buildMessage("snapshot", {
          features: { permissionPreview: permissionFeature },
          sessions: snapshot,
        }));
        ws.send(buildMessage(
          "permission_snapshot",
          buildPermissionSnapshotPayload(permissionSnapshot)
        ));
        permissionSnapshotSent = true;
      } catch {}
      if (permissionSnapshotSent) {
        logPermissionFanout("permission_snapshot", 1, { source: "connect" });
      }

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
    let delivered = 0;
    for (const c of clients) {
      if (c.readyState === WebSocket.OPEN) {
        try {
          c.send(message);
          delivered++;
        } catch {}
      }
    }
    return delivered;
  }

  // ── Session data ──

  function buildPayload(sid, session) {
    if (!session) return null;
    const recentEvents = Array.isArray(session.recentEvents) ? session.recentEvents.slice(-10) : [];
    return {
      sessionId: sid,
      agentId: session.agentId || null,
      title: session.sessionTitle || null,
      basename: session.cwd ? path.basename(session.cwd) : null,
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
      const permissionSnapshot = readPermissionObservationSnapshot();
      broadcast(buildMessage("snapshot", {
        features: { permissionPreview: buildPermissionFeature(permissionSnapshot) },
        sessions: snapshot,
      }));
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
    if (stopPromise) return stopPromise.then(() => start());
    if (!closed && activePort && httpServer && wss) return Promise.resolve(activePort);
    if (startPromise) return startPromise;
    const revision = ++runtimeRevision;
    closed = false;
    attachPermissionObservation();
    try {
      createServers();
    } catch (err) {
      closed = true;
      detachPermissionObservation();
      sessionCache.clear();
      stopHeartbeat();
      if (rotationTimer) { clearTimeout(rotationTimer); rotationTimer = null; }
      httpServer = null;
      wss = null;
      return Promise.reject(err);
    }
    const startingHttpServer = httpServer;
    const startingWss = wss;
    const ports = [];
    for (let i = 0; i < PORT_RANGE; i++) ports.push(DEFAULT_PORT + i);
    let idx = 0;

    startPromise = new Promise((resolve, reject) => {
      rejectPendingStart = reject;
      const onError = (err) => {
        if (err.code === "EADDRINUSE" && idx < ports.length - 1) {
          idx++;
          startingHttpServer.listen(ports[idx], "0.0.0.0");
          return;
        }
        console.error("[lan-ws] Server error:", err.message);
        startingHttpServer.removeListener("error", onError);
        startingHttpServer.removeListener("listening", onListening);
        closed = true;
        detachPermissionObservation();
        sessionCache.clear();
        stopHeartbeat();
        if (rotationTimer) { clearTimeout(rotationTimer); rotationTimer = null; }
        try { startingWss.close(); } catch {}
        try { startingHttpServer.close(); } catch {}
        if (wss === startingWss) wss = null;
        if (httpServer === startingHttpServer) httpServer = null;
        activePort = null;
        reject(err);
      };
      const onListening = () => {
        if (closed || revision !== runtimeRevision) {
          startingHttpServer.removeListener("error", onError);
          startingHttpServer.removeListener("listening", onListening);
          try { startingWss.close(); } catch {}
          try { startingHttpServer.close(); } catch {}
          reject(new Error("mobile preview start superseded"));
          return;
        }
        activePort = ports[idx];
        console.log(`[mobile-preview] started on 0.0.0.0:${activePort}`);
        startingHttpServer.removeListener("error", onError);
        startingHttpServer.removeListener("listening", onListening);
        pollSessions(); // Prime only after the server is actually listening.
        scheduleRotation(); // A failed start must not leave a token timer alive.
        resolve(activePort);
      };
      startingHttpServer.on("error", onError);
      startingHttpServer.on("listening", onListening);
    });

    startingHttpServer.listen(ports[0], "0.0.0.0");
    startPromise = startPromise.finally(() => {
      startPromise = null;
      rejectPendingStart = null;
    });
    return startPromise;
  }

  function cleanup() {
    if (stopPromise) return stopPromise;
    closed = true;
    runtimeRevision++;
    if (typeof rejectPendingStart === "function") {
      rejectPendingStart(new Error("mobile preview start stopped"));
    }
    detachPermissionObservation();
    sessionCache.clear();
    stopHeartbeat();
    if (rotationTimer) { clearTimeout(rotationTimer); rotationTimer = null; }
    const closingClients = Array.from(clients);
    for (const c of closingClients) { try { c.close(1001, "Server shutting down"); } catch {} }
    clients.clear();
    clientMeta.clear();
    const closingWss = wss;
    const closingHttpServer = httpServer;
    wss = null;
    httpServer = null;
    activePort = null;
    const waits = [];
    if (closingWss) {
      waits.push(new Promise((resolve) => {
        try { closingWss.close(() => resolve()); } catch { resolve(); }
      }));
    }
    if (closingHttpServer) {
      waits.push(new Promise((resolve) => {
        try { closingHttpServer.close(() => resolve()); } catch { resolve(); }
      }));
    }
    let forceCloseTimer = null;
    const forceClose = new Promise((resolve) => {
      forceCloseTimer = setTimeout(() => {
        for (const client of closingClients) {
          try { client.terminate(); } catch {}
        }
        try { closingHttpServer?.closeAllConnections?.(); } catch {}
        resolve();
      }, SHUTDOWN_FORCE_CLOSE_MS);
    });
    stopPromise = Promise.race([Promise.all(waits), forceClose])
      .then(() => undefined)
      .finally(() => {
        if (forceCloseTimer) clearTimeout(forceCloseTimer);
        stopPromise = null;
      });
    return stopPromise;
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
    disconnectClients,
    isStarted: () => !closed && Number.isInteger(activePort) && activePort > 0,
    PROTOCOL_VERSION,
  };
}

module.exports = { initMobilePreviewServer, PROTOCOL_VERSION };
