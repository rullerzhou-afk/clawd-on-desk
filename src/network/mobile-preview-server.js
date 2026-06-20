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
const GRACE_PERIOD_MS = 5 * 60 * 1000;          // 5 minutes
const ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

const PWA_DIR = path.resolve(__dirname, "../../pwa");
const PET_SVG_DIR = path.resolve(__dirname, "../../assets/svg");
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
  const clients = new Set();
  const clientMeta = new Map();
  let sessionCache = new Map();
  let httpServer = null;
  let wss = null;
  let activePort = null;
  let heartbeatTimer = null;
  let rotationTimer = null;
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

    // Pet animation SVGs (from the active-theme asset set) so the phone can show
    // the same mascot. Strictly sanitized: a single .svg filename, no traversal.
    if (urlPath.startsWith("/mobile/pet/")) {
      const petFile = path.basename(urlPath);
      if (!/^[a-z0-9-]+\.svg$/i.test(petFile)) { res.writeHead(404); res.end(); return; }
      const petPath = path.join(PET_SVG_DIR, petFile);
      if (!isPathInside(PET_SVG_DIR, petPath)) { res.writeHead(403); res.end(); return; }
      fs.readFile(petPath, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=86400" });
        res.end(data);
      });
      return;
    }

    if (urlPath === "/mobile/" || urlPath === "/mobile") urlPath = "/mobile/index.html";
    if (!urlPath.startsWith("/mobile/")) { res.writeHead(404); res.end(); return; }
    const rel = urlPath.slice("/mobile/".length);
    const filePath = path.join(PWA_DIR, rel);
    if (!isPathInside(PWA_DIR, filePath)) { res.writeHead(403); res.end(); return; }
    const ext = path.extname(filePath).toLowerCase();
    // Inject the pairing params into the manifest <link> server-side so iOS reads
    // a manifest whose start_url already carries the token. A JS rewrite of the
    // <link> lands too late — iOS reads the manifest from the initial HTML when
    // you tap "Add to Home Screen". Only echoes params the caller already
    // presented in the query, so an unauthenticated GET /mobile/ gets a
    // token-less link and learns nothing.
    if (rel === "index.html") {
      fs.readFile(filePath, "utf8", (err, raw) => {
        if (err) { res.writeHead(404); res.end(); return; }
        let html = raw;
        try {
          // Make the PWA follow the desktop app's UI language.
          const SUPPORTED_LANGS = ["en", "zh", "zh-TW", "ko", "ja", "es"];
          let appLang = "en";
          try {
            const snap = ctx && typeof ctx.getSettingsSnapshot === "function" ? ctx.getSettingsSnapshot() : null;
            if (snap && SUPPORTED_LANGS.indexOf(snap.lang) !== -1) appLang = snap.lang;
          } catch {}
          html = html.replace(/<html lang="[^"]*">/, `<html lang="${appLang}">`);
          html = html.replace("</head>", `  <script>window.__CLAWD_LANG__=${JSON.stringify(appLang)};</script>\n</head>`);
          const q = new URL(req.url, "http://localhost").searchParams;
          const host = q.get("host");
          const port = q.get("port");
          const token = q.get("token");
          if (host && port && token) {
            const qs = `?host=${encodeURIComponent(host)}`
              + `&port=${encodeURIComponent(port)}&token=${encodeURIComponent(token)}`;
            html = html.replace('href="/mobile/manifest.json"', `href="/mobile/manifest.json${qs}"`);
          }
        } catch {}
        res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
        res.end(html);
      });
      return;
    }
    // iOS "Add to Home Screen" launches the manifest's start_url in storage that
    // is isolated from Safari, so the QR-scanned token never reaches it. To make
    // the home-screen icon connect, we let start_url carry the pairing params —
    // but ONLY by echoing back the host/port/token the requester already presented
    // in the query string. We never read the server's own token here, so an
    // unauthenticated GET /mobile/manifest.json (no query) gets a token-less
    // manifest and learns nothing. The PWA appends these params to the manifest
    // link (see pwa/app.js) so only a paired client triggers the echo.
    if (rel === "manifest.json") {
      fs.readFile(filePath, "utf8", (err, raw) => {
        if (err) { res.writeHead(404); res.end(); return; }
        let body = raw;
        try {
          const manifest = JSON.parse(raw);
          const q = new URL(req.url, "http://localhost").searchParams;
          const host = q.get("host");
          const port = q.get("port");
          const token = q.get("token");
          if (host && port && token) {
            manifest.start_url = `/mobile/?host=${encodeURIComponent(host)}`
              + `&port=${encodeURIComponent(port)}&token=${encodeURIComponent(token)}`;
          }
          body = JSON.stringify(manifest);
        } catch {}
        res.writeHead(200, { "Content-Type": MIME[".json"], "Cache-Control": "no-cache" });
        res.end(body);
      });
      return;
    }
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
    const recentEvents = Array.isArray(session.recentEvents) ? session.recentEvents.slice(-25) : [];
    return {
      sessionId: sid,
      agentId: session.agentId || null,
      title: session.sessionTitle || null,
      basename: session.cwd ? path.basename(session.cwd) : null,
      state: session.state || "idle",
      updatedAt: session.updatedAt || null,
      contextUsage: session.contextUsage || null,
      // Latest assistant text (what it just wrote) so phones can read along.
      assistantLastOutput: typeof session.assistantLastOutput === "string" ? session.assistantLastOutput : null,
      assistantLastOutputTruncated: session.assistantLastOutputTruncated === true,
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
    scheduleRotation(); // Start the 24h rotation timer
    return ready;
  }

  function cleanup() {
    closed = true;
    sessionCache.clear();
    stopHeartbeat();
    if (rotationTimer) { clearTimeout(rotationTimer); rotationTimer = null; }
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
    getToken: () => tokenState.token,
    regenerateToken,
    resetMobileAccess,
    PROTOCOL_VERSION,
  };
}

module.exports = { initMobilePreviewServer, PROTOCOL_VERSION };
