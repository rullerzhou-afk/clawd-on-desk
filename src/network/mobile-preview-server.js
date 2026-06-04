// src/network/mobile-preview-server.js — LAN WebSocket bridge for PWA mobile clients
// Protocol v1 — serves static PWA files + WebSocket on 0.0.0.0 for LAN access.
// M1: read-only snapshot/state push. No write or approval operations.

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

const PWA_DIR = path.resolve(__dirname, "../../pwa");
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

function loadOrCreateToken() {
  try {
    const raw = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    if (raw && typeof raw.token === "string" && /^[a-f0-9]{32,64}$/.test(raw.token)) return raw.token;
  } catch {}
  const token = crypto.randomBytes(16).toString("hex");
  try {
    const dir = path.dirname(TOKEN_PATH);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = TOKEN_PATH + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify({ token }, null, 2), "utf8");
    fs.renameSync(tmpPath, TOKEN_PATH);
  } catch {}
  return token;
}

function buildMessage(type, payload) {
  return JSON.stringify({ version: PROTOCOL_VERSION, type, timestamp: Date.now(), ...payload });
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function initMobilePreviewServer(ctx) {
  const token = loadOrCreateToken();
  const clients = new Set();
  const clientMeta = new Map();
  let sessionCache = new Map();
  let httpServer = null;
  let wss = null;
  let activePort = null;
  let heartbeatTimer = null;
  let closed = false;

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
    const filePath = path.join(PWA_DIR, rel);
    if (!isPathInside(PWA_DIR, filePath)) { res.writeHead(403); res.end(); return; }
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
    httpServer = http.createServer(serveStatic);
    wss = new WebSocket.Server({ server: httpServer, path: "/ws" });

    wss.on("connection", (ws, req) => {
      if (closed) { ws.close(1001, "Server shutting down"); return; }

      let url;
      try { url = new URL(req.url, "http://localhost"); } catch { ws.close(1008, "Bad request"); return; }
      if (url.searchParams.get("token") !== token) {
        ws.close(1008, "Invalid token");
        return;
      }
      if (clients.size >= MAX_CLIENTS) {
        ws.close(1013, "Server busy");
        return;
      }

      clients.add(ws);
      const clientId = crypto.randomBytes(8).toString("hex");
      const clientIp = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
      clientMeta.set(ws, { messageCount: 0, windowStart: Date.now(), clientId, ip: clientIp, lastPong: Date.now() });

      // Send snapshot on connect
      try {
        const snapshot = {};
        for (const [sid, data] of sessionCache) snapshot[sid] = data;
        ws.send(buildMessage("snapshot", { sessions: snapshot }));
      } catch {}

      startHeartbeat();
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
        const now = Date.now();
        if (now - meta.windowStart > RATE_WINDOW_MS) { meta.messageCount = 0; meta.windowStart = now; }
      if (++meta.messageCount > RATE_MAX) { ws.close(1008, "Rate limit"); return; }
      // M1: read-only — ignore all client messages (rate-limit still applies above)
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
      const now = Date.now();
      for (const c of clients) {
        const meta = clientMeta.get(c);
        if (c.isAlive === false || (meta && now - meta.lastPong > CLIENT_TIMEOUT_MS)) {
          c.terminate();
          clients.delete(c);
          clientMeta.delete(c);
          continue;
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
    return {
      sessionId: sid,
      title: session.sessionTitle || session.agentId || null,
      basename: session.cwd ? path.basename(session.cwd) : null,
      state: session.state || "idle",
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
    closed = false;
    createServers();
    const ports = [];
    for (let i = 0; i < PORT_RANGE; i++) ports.push(DEFAULT_PORT + i);
    let idx = 0;

    const ready = new Promise((resolve, reject) => {
      const onError = (err) => {
        if (err.code === "EADDRINUSE" && idx < ports.length - 1) {
          idx++;
          httpServer.listen(ports[idx], "0.0.0.0");
          return;
        }
        console.error("[lan-ws] Server error:", err.message);
        httpServer.removeListener("error", onError);
        httpServer.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        activePort = ports[idx];
        console.log(`[mobile-preview] started on 0.0.0.0:${activePort}`);
        httpServer.removeListener("error", onError);
        httpServer.removeListener("listening", onListening);
        resolve(activePort);
      };
      httpServer.on("error", onError);
      httpServer.on("listening", onListening);
    });

    httpServer.listen(ports[0], "0.0.0.0");
    pollSessions(); // Prime cache from current state
    return ready;
  }

  function cleanup() {
    closed = true;
    sessionCache.clear();
    stopHeartbeat();
    for (const c of clients) { try { c.close(1001, "Server shutting down"); } catch {} }
    clients.clear();
    clientMeta.clear();
    if (wss) { try { wss.close(); } catch {} }
    if (httpServer) { try { httpServer.close(); } catch {} }
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
    getToken: () => token,
    PROTOCOL_VERSION,
  };
}

module.exports = { initMobilePreviewServer, PROTOCOL_VERSION };
