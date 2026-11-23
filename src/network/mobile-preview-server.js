// src/network/mobile-preview-server.js — LAN WebSocket bridge for PWA mobile clients
// Protocol v1 — serves static PWA files + WebSocket on 0.0.0.0 for LAN access.
// M1: read-only snapshot/state push. No write or approval operations.
// Device tokens rotate only after the next token has been saved and used.

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const WebSocket = require("ws");
const { createMobileDeviceStore, hash, CID_RE, MAX_DEVICES, newPairing } = require("./mobile-device-store");
const { sessionDisplayFolder } = require("../state-session-snapshot");
const { buildPairQrSvg } = require("../mobile-pair-qr");
const { resolveStrings } = require("./mobile-pwa-i18n");

const APP_VERSION = require("../../package.json").version;
const PROTOCOL_VERSION = "v1";
const DEFAULT_PORT = 23334;
const PORT_RANGE = 5;
const HEARTBEAT_MS = 30000;
const CLIENT_TIMEOUT_MS = 90000;
const RATE_WINDOW_MS = 60000;
const RATE_MAX = 60;
const MAX_CLIENTS = 10;
const SHUTDOWN_FORCE_CLOSE_MS = 250;
const ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
// The PWA only ever sends `token_rotate_ack`; ws would otherwise accept 100 MiB
// frames from any LAN client.
const WS_MAX_PAYLOAD_BYTES = 4096;

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

function buildMessage(type, payload) {
  return JSON.stringify({ version: PROTOCOL_VERSION, type, timestamp: Date.now(), ...payload });
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function initMobilePreviewServer(ctx) {
  const tokenPath = (ctx && ctx.tokenPath) || TOKEN_PATH;
  const now = ctx && typeof ctx.now === "function" ? ctx.now : Date.now;
  const permissionObservation = ctx && ctx.permissionObservation;
  const log = ctx && typeof ctx.log === "function" ? ctx.log : console.log;
  const store = createMobileDeviceStore({ ...ctx, tokenPath, now, log });
  const rotationMs = ctx && Number.isFinite(ctx.rotationMs) && ctx.rotationMs > 0 ? ctx.rotationMs : ROTATION_INTERVAL_MS;
  const pairClients = new Map();
  const pairFailures = new Map();
  const clients = new Set();
  const clientMeta = new Map();
  let sessionCache = new Map();
  let httpServer = null;
  let wss = null;
  let activePort = null;
  let heartbeatTimer = null;
  let persistenceTimer = null;
  let observationUnsubscribe = null;
  let startPromise = null;
  let cancelPendingStart = null;
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

  // ── Device credentials ──

  function closeMatching(predicate, code, reason) {
    for (const [client, meta] of clientMeta) {
      if (!predicate(meta)) continue;
      try { client.close(code, reason); } catch {}
      clients.delete(client);
      clientMeta.delete(client);
    }
    for (const [client, meta] of pairClients) {
      if (!predicate(meta)) continue;
      clearTimeout(meta.timer);
      try { client.close(code, reason); } catch {}
      pairClients.delete(client);
    }
  }

  function revokeDevice(id) {
    const device = store.getState().devices.find((d) => d.id === id);
    try {
      store.commit((next) => {
        next.devices = next.devices.filter((d) => d.id !== id);
      });
    } catch {
      throw Object.assign(new Error("Failed to revoke mobile device"), { legacyRevoked: false });
    }
    closeMatching((meta) => meta.deviceId === id, 1008, "device-revoked");
    return { mayHoldLegacy: !!device && device.origin === "legacy" };
  }

  function revokeLegacy(reset = false) {
    const deadTokenHash = store.invalidateLegacy();
    // A migrating socket is still authenticated by the shared token.
    closeMatching((meta) => meta.kind === "legacy", 1008, "legacy-revoked");
    try {
      store.commit((next) => {
        next.legacy = { deadTokenHash, graceHashes: [] };
        if (reset) {
          next.devices = [];
          next.pairing = newPairing(now());
        }
      });
    } catch {
      throw Object.assign(new Error("Failed to persist mobile device reset"), { legacyRevoked: true });
    }
    if (reset) closeMatching(() => true, 1008, "access-reset");
  }

  function resetMobileAccess() {
    revokeLegacy(true);
  }

  function disconnectClients({ code = 1001, reason = "Reconnecting" } = {}) {
    closeMatching(() => true, code, reason);
    stopHeartbeat();
  }

  function sendRotation(ws, device, meta) {
    if (!meta.proto2 || !device) return;
    if (!device.staged && device.currentIssuedAt + rotationMs <= now()) {
      try {
        store.commit((next) => {
          const d = next.devices.find((entry) => entry.id === device.id);
          d.staged = crypto.randomBytes(16).toString("hex");
          d.stagedGen = d.currentGen + 1;
        });
      } catch {
        log("[mobile-preview] device rotation persistence deferred");
        return;
      }
      device = store.getState().devices.find((d) => d.id === device.id);
    }
    if (!device.staged || meta.sentGen === device.stagedGen) return;
    try {
      ws.send(buildMessage("token_rotate", {
        deviceId: device.id,
        gen: device.stagedGen,
        newToken: device.staged,
      }));
      meta.sentGen = device.stagedGen;
    } catch {}
  }

  function promoteDevice(device, tokenHash) {
    store.commit((next) => {
      const d = next.devices.find((entry) => entry.id === device.id);
      d.currentHash = tokenHash;
      d.currentGen = d.stagedGen;
      d.currentIssuedAt = now();
      d.staged = null;
      d.stagedGen = null;
      d.state = "active";
      d.pairCodeHash = null;
    });
    closeMatching((meta) => meta.kind === "device" && meta.deviceId === device.id
      && meta.proto2 && meta.tokenHash !== tokenHash, 4002, "token-rotated");
    return store.getState().devices.find((d) => d.id === device.id);
  }

  function authenticateClient(ws, url) {
    const token = url.searchParams.get("token");
    const tokenHash = token ? hash(token) : null;
    let device = token ? store.getState().devices.find((d) =>
      d.currentHash === tokenHash || (d.staged && d.staged === token)) : null;
    if (!device && !store.acceptsLegacy(token)) {
      ws.close(1008, "invalid-token");
      return null;
    }
    if (device && device.staged === token) {
      try {
        device = promoteDevice(device, tokenHash);
      } catch {
        ws.close(4003, "retry-later");
        return null;
      }
    }
    return {
      kind: device ? "device" : "legacy",
      device,
      tokenHash,
      proto2: url.searchParams.get("proto") === "2",
    };
  }

  function migrateLegacy(cid, userAgent, mode = null) {
    let device = store.getState().devices.find((d) => d.cid === cid && d.state === "pending")
      || store.getState().devices.find((d) => d.cid === cid && d.state === "active");
    if (device) return device;
    if (store.getState().devices.length >= MAX_DEVICES) {
      log("[mobile-preview] legacy migration deferred: device limit");
      return null;
    }
    try {
      device = store.commit((next) => store.createDevice(next, cid, "legacy", userAgent, null, mode));
    } catch {
      log("[mobile-preview] legacy migration persistence deferred");
    }
    return device;
  }

  function attachClientMessages(ws, meta) {
    ws.on("message", (data) => {
      if (closed || (!clientMeta.has(ws) && !pairClients.has(ws))) return;
      const nowMs = Date.now();
      if (nowMs - meta.windowStart > RATE_WINDOW_MS) {
        meta.messageCount = 0;
        meta.windowStart = nowMs;
      }
      if (++meta.messageCount > RATE_MAX) {
        ws.close(4003, "rate-limit");
        return;
      }
      // ACK does not prove durable storage or a successful new-token authentication.
      try {
        const parsed = JSON.parse(data);
        if (parsed && parsed.type === "token_rotate_ack") {
          log(`[mobile-preview] token_rotate_ack from ${meta.ip}`);
          return;
        }
      } catch {}
      // M1: read-only — ignore all other client messages (rate-limit still applies above)
    });
  }

  function isPairRateLimited(ip) {
    // Keep only this window's failures, including IPs that no longer connect.
    for (const [key, times] of pairFailures) {
      const recent = times.filter((time) => time > now() - 10 * 60 * 1000);
      if (recent.length) pairFailures.set(key, recent);
      else pairFailures.delete(key);
    }
    return (pairFailures.get(ip) || []).length >= 20;
  }

  function claimDeviceForPairing(ws, code, cid, userAgent, ip, mode = null) {
    const codeHash = hash(code);
    const boundDevice = store.getState().devices.find((d) => d.pairCodeHash === codeHash);
    if (boundDevice && boundDevice.cid === cid && boundDevice.state === "pending") return boundDevice;
    const pairing = store.getState().pairing;
    if (boundDevice || code !== pairing.code || pairing.expiresAt <= now()) {
      const times = pairFailures.get(ip) || [];
      times.push(now());
      pairFailures.set(ip, times);
      ws.close(4004, "pair-rejected");
      return null;
    }
    if (store.getState().devices.length >= MAX_DEVICES) {
      ws.close(4005, "device-limit");
      return null;
    }
    try {
      return store.commit((next) => {
        const device = store.createDevice(next, cid, "pair", userAgent, codeHash, mode);
        next.pairing = newPairing(now());
        return device;
      });
    } catch {
      ws.close(4003, "retry-later");
      return null;
    }
  }

  function handlePairConnection(ws, url, req) {
    const cid = url.searchParams.get("cid");
    if (url.searchParams.get("proto") !== "2" || !CID_RE.test(cid || "")) {
      ws.close(4004, "pair-rejected");
      return;
    }
    if (store.isPaused() || pairClients.size >= 4) {
      ws.close(4003, "retry-later");
      return;
    }
    const ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    if (isPairRateLimited(ip)) {
      ws.close(4003, "retry-later");
      return;
    }
    const code = url.searchParams.get("pair").toUpperCase().replace(/-/g, "");
    const mode = url.searchParams.get("mode") === "pwa" ? "pwa" : null;
    const device = claimDeviceForPairing(ws, code, cid, req.headers["user-agent"] || "", ip, mode);
    if (!device) return;
    const meta = {
      kind: "pair",
      deviceId: device.id,
      proto2: true,
      ip,
      messageCount: 0,
      windowStart: Date.now(),
    };
    meta.timer = setTimeout(() => {
      pairClients.delete(ws);
      ws.close(1000);
    }, (ctx && ctx.pairTimeoutMs) || 60000);
    pairClients.set(ws, meta);
    attachClientMessages(ws, meta);
    const removePairClient = () => {
      clearTimeout(meta.timer);
      pairClients.delete(ws);
    };
    ws.on("close", removePairClient);
    ws.on("error", removePairClient);
    sendRotation(ws, device, meta);
  }

  function getConnectionInfo() {
    const { code, expiresAt } = store.getPairing();
    const lanIp = getLocalIP();
    const pairUrl = activePort ? `http://${lanIp}:${activePort}/mobile/?pair=${code}` : null;
    return {
      status: activePort ? "ok" : "starting",
      port: activePort,
      lanIp,
      pairUrl,
      pairQrSvg: pairUrl ? buildPairQrSvg(pairUrl) : null,
      pairCode: code,
      pairExpiresAt: expiresAt,
    };
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

  function currentLang() {
    const lang = ctx && typeof ctx.getLang === "function" ? ctx.getLang() : null;
    return typeof lang === "string" && lang ? lang : "en";
  }

  function renderIndexHtml(source) {
    const lang = currentLang();
    const strings = resolveStrings(lang);
    // Escape `<` so a translated string can never close the injected script tag.
    const stringsJson = JSON.stringify(strings).replaceAll("<", "\\u003c");
    return source
      .replaceAll("__CLAWD_APP_VERSION__", APP_VERSION)
      .replaceAll("__CLAWD_LANG__", lang)
      .replaceAll("__CLAWD_STRINGS_JSON__", stringsJson)
      .replaceAll("__CLAWD_T_PAIR_LABEL__", strings.pairLabel)
      .replaceAll("__CLAWD_T_PAIR_SUBMIT__", strings.pairSubmit)
      .replaceAll("__CLAWD_T_NAV_SESSIONS__", strings.navSessions)
      .replaceAll("__CLAWD_T_NAV_SETTINGS__", strings.navSettings);
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

    // Typing host:port without the /mobile/ path used to yield a blank 404 (#1299).
    if (urlPath === "/") {
      res.writeHead(302, { Location: "/mobile/" });
      res.end();
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
      const body = rel === "index.html"
        ? renderIndexHtml(data.toString("utf8"))
        : data;
      res.end(body);
    });
  }

  function createHttpServer() {
    if (ctx && typeof ctx.createHttpServer === "function") {
      return ctx.createHttpServer(serveStatic);
    }
    return http.createServer(serveStatic);
  }

  function sendInitialSnapshots(ws) {
    // Keep both authoritative snapshots in this synchronous event-loop turn
    // to preserve snapshot-before-delta ordering for the observation subscriber.
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
  }

  function attachDataClientEvents(ws, meta) {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
      const meta = clientMeta.get(ws);
      if (meta) {
        meta.lastPong = Date.now();
        if (meta.kind === "device") store.recordSeen(meta.deviceId);
      }
    });

    attachClientMessages(ws, meta);

    ws.on("close", () => {
      clients.delete(ws);
      clientMeta.delete(ws);
      if (clients.size === 0) stopHeartbeat();
    });
    ws.on("error", () => {
      clients.delete(ws);
      clientMeta.delete(ws);
    });
  }

  function handleDataConnection(ws, url, req) {
    const auth = authenticateClient(ws, url);
    if (!auth) return;
    if (clients.size >= MAX_CLIENTS) {
      ws.close(1013, "server-busy");
      return;
    }
    const meta = {
      kind: auth.kind,
      deviceId: auth.device ? auth.device.id : null,
      tokenHash: auth.tokenHash,
      proto2: auth.proto2,
      messageCount: 0,
      windowStart: Date.now(),
      ip: (req.socket.remoteAddress || "").replace(/^::ffff:/, ""),
      lastPong: Date.now(),
    };
    clients.add(ws);
    clientMeta.set(ws, meta);
    let rotationDevice = auth.device;
    if (auth.device) store.recordSeen(auth.device.id);
    const cid = url.searchParams.get("cid");
    if (auth.kind === "legacy" && auth.proto2 && CID_RE.test(cid || "")) {
      const mode = url.searchParams.get("mode") === "pwa" ? "pwa" : null;
      rotationDevice = migrateLegacy(cid, req.headers["user-agent"] || "", mode);
    }
    // Devices paired before the mode param existed keep an unsuffixed name;
    // the first standalone reconnect renames them in place so revoke + re-pair
    // is not required (#1299).
    if (auth.kind === "device" && auth.device
        && url.searchParams.get("mode") === "pwa"
        && !auth.device.name.endsWith(" · PWA")) {
      store.renameDevice(auth.device.id, auth.device.name + " · PWA");
    }

    sendInitialSnapshots(ws);
    startHeartbeat();

    if (rotationDevice && (auth.kind === "device" || rotationDevice.state === "pending")) {
      sendRotation(ws, rotationDevice, meta);
    }
    attachDataClientEvents(ws, meta);
  }

  // Attach ws only after the HTTP server has successfully bound a port.
  // WebSocket.Server forwards the underlying HTTP server's pre-listen
  // EADDRINUSE as its own `error` event. When ws was attached before the port
  // retry loop, that forwarded event had no server-level listener and crashed
  // the process before start() could advance from 23334 to the next candidate.
  function attachWebSocketServer(server) {
    let socketServer;
    const options = { server, path: "/ws", maxPayload: WS_MAX_PAYLOAD_BYTES };
    if (ctx && typeof ctx.createWebSocketServer === "function") {
      socketServer = ctx.createWebSocketServer(options);
    } else {
      const WebSocketServer = ctx && ctx.WebSocketServer
        ? ctx.WebSocketServer
        : WebSocket.Server;
      socketServer = new WebSocketServer(options);
    }
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
      // ws can still emit "error" (bad or oversized frame) on a socket we reject; with no listener that is uncaught.
      ws.on("error", () => {});
      if (closed) {
        ws.close(1001, "Server shutting down");
        return;
      }
      let url;
      try {
        url = new URL(req.url, "http://localhost");
      } catch {
        ws.close(1008, "invalid-token");
        return;
      }
      if (url.searchParams.has("pair")) {
        handlePairConnection(ws, url, req);
      } else {
        handleDataConnection(ws, url, req);
      }
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
        if (meta && meta.kind === "device") {
          sendRotation(c, store.getState().devices.find((d) => d.id === meta.deviceId), meta);
        }
        c.isAlive = false;
        try { c.ping(); } catch {}
      }
      if (clients.size === 0) stopHeartbeat();
    }, (ctx && ctx.heartbeatMs) || HEARTBEAT_MS);
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
    if (Number.isInteger(activePort) && httpServer && httpServer.listening) {
      return Promise.resolve(activePort);
    }
    if (startPromise) return startPromise;

    closed = false;
    attachPermissionObservation();
    let server;
    try {
      server = createHttpServer();
      httpServer = server;
    } catch (err) {
      closed = true;
      detachPermissionObservation();
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
        // Only the generation that still owns the runtime tears down shared
        // state; a cancelled one was already torn down by cleanup().
        const ownsRuntime = httpServer === server;
        detachStartListeners();
        closeAttempt();
        closed = true;
        if (ownsRuntime) {
          detachPermissionObservation();
          sessionCache.clear();
          stopHeartbeat();
          if (persistenceTimer) { clearInterval(persistenceTimer); persistenceTimer = null; }
        }
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
          persistenceTimer = setInterval(store.retryPersistence, 60000);
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
    detachPermissionObservation();
    sessionCache.clear();
    stopHeartbeat();
    if (persistenceTimer) { clearInterval(persistenceTimer); persistenceTimer = null; }
    const closingClients = [...clients, ...pairClients.keys()];
    for (const meta of pairClients.values()) clearTimeout(meta.timer);
    pairClients.clear();
    for (const c of closingClients) { try { c.close(1001, "Server shutting down"); } catch {} }
    clients.clear();
    clientMeta.clear();
    const closingWss = wss;
    const closingHttpServer = httpServer;
    wss = null;
    httpServer = null;
    activePort = null;

    // Teardown above is synchronous so a same-tick re-enable starts fresh.
    // The returned promise additionally lets callers (the settings reconcile
    // queue) wait until the old listener is actually gone, force-closing
    // clients that ignore the close handshake.
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
    return Promise.race([Promise.all(waits), forceClose])
      .then(() => undefined)
      .finally(() => {
        if (forceCloseTimer) clearTimeout(forceCloseTimer);
      });
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
    getConnectionInfo,
    listDevices: store.listDevices,
    isLegacyActive: store.isLegacyActive,
    refreshPairCode: store.refreshPairCode,
    revokeDevice,
    revokeLegacy: () => revokeLegacy(),
    resetMobileAccess,
    disconnectClients,
    isStarted: () => !closed && Number.isInteger(activePort) && activePort > 0,
    PROTOCOL_VERSION,
  };
}

module.exports = { initMobilePreviewServer, isRetryablePortError, PROTOCOL_VERSION };
