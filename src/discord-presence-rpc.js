"use strict";

const net = require("node:net");
const path = require("node:path");
const crypto = require("node:crypto");
const { getAgent } = require("../agents/registry");
const { STATE_PRIORITY, getStatePriority } = require("./state-priority");
const { normalizeDiscordPresence, DEFAULT_CLAWD_DISCORD_APP_ID } = require("./discord-presence-settings");

const OP = Object.freeze({ HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 });

// External URL works for large_image, so BYO users needn't upload an asset.
const CLAWD_ICON_URL = "https://raw.githubusercontent.com/rullerzhou-afk/clawd-on-desk/main/assets/icon.png";

const COARSE_LABEL = Object.freeze({
  idle: "Idle",
  thinking: "Thinking",
  working: "Working",
  waiting: "Waiting for input",
});

const READY_TIMEOUT_MS = 5000;
const RECONNECT_MAX_MS = 30000;
// Discord rejects SET_ACTIVITY outright when state/details exceed 128 chars.
const ACTIVITY_FIELD_MAX = 128;
// Discord rate-limits SET_ACTIVITY (~5/20s); coalesce rapid flips.
const MIN_SEND_INTERVAL_MS = 4000;

// Canonical session.state, never currentState (mini-mode remaps it).
function toCoarseState(state) {
  const s = String(state || "").replace(/^mini-/, "");
  if (s === "thinking") return "thinking";
  if (s === "working" || s === "juggling" || s === "carrying" || s === "sweeping") return "working";
  if (s === "notification" || s === "attention" || s === "error") return "waiting";
  return "idle";
}

function agentLabel(agentId) {
  const agent = agentId ? getAgent(agentId) : null;
  return (agent && agent.name) || "Clawd";
}

function buildPresencePayload(session, privacy = {}) {
  const coarse = toCoarseState(session && session.state);
  const activity = {
    details: agentLabel(session && session.agentId),
    state: COARSE_LABEL[coarse],
    assets: { large_image: CLAWD_ICON_URL, large_text: "Clawd on Desk" },
  };
  if (privacy.privacyShowProject && session && session.cwd) {
    // win32.basename splits on both \ and /, so a Windows cwd seen on a POSIX
    // host yields just the folder name instead of leaking the whole path.
    const state = `${COARSE_LABEL[coarse]} · ${path.win32.basename(session.cwd)}`;
    // Truncate by code point: a long folder name would otherwise make Discord
    // silently drop the whole activity update.
    activity.state = Array.from(state).slice(0, ACTIVITY_FIELD_MAX).join("");
  }
  // Allowlist by design: the snapshot also carries sensitive fields
  // (sessionTitle, assistantLastOutput, ...) we deliberately never read.
  return activity;
}

function encodeFrame(op, dataObj) {
  const json = Buffer.from(JSON.stringify(dataObj), "utf8");
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

// `rest` carries the partial trailing frame — pipe reads split arbitrarily.
function decodeFrames(buf) {
  const frames = [];
  let offset = 0;
  while (buf.length - offset >= 8) {
    const op = buf.readInt32LE(offset);
    const len = buf.readInt32LE(offset + 4);
    if (buf.length - offset - 8 < len) break;
    const data = JSON.parse(buf.toString("utf8", offset + 8, offset + 8 + len));
    frames.push({ op, data });
    offset += 8 + len;
  }
  return { frames, rest: buf.subarray(offset) };
}

function ipcCandidatePaths() {
  if (process.platform === "win32") {
    return Array.from({ length: 10 }, (_, n) => `\\\\?\\pipe\\discord-ipc-${n}`);
  }
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp";
  const roots = [base, path.join(base, "app", "com.discordapp.Discord"), path.join(base, "snap.discord")];
  const out = [];
  for (const r of roots) for (let n = 0; n < 10; n++) out.push(path.join(r, `discord-ipc-${n}`));
  return out;
}

function randomNonce() {
  try { return crypto.randomUUID(); } catch { return `${process.pid}.${Date.now()}`; }
}

function pickDominantSession(snapshot) {
  const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  let best = null;
  let bestPriority = -1;
  for (const s of sessions) {
    // Mirror session-hud.js isHudSession() so Discord and the HUD agree on which
    // session is "active" (this also drops superseded Codex sessions, which the
    // snapshot builder folds into hiddenFromHud).
    if (!s || s.headless || s.state === "sleeping" || s.hiddenFromHud) continue;
    const p = getStatePriority(s.state, STATE_PRIORITY);
    if (p > bestPriority) { bestPriority = p; best = s; }
  }
  return best;
}

// Presence bridge over Discord's local IPC pipe. Offline is non-fatal.
function createDiscordPresenceBridge({ getConfig, log, createConnection, ipcPaths } = {}) {
  const logFn = typeof log === "function" ? log : () => {};
  // Injectable for tests; defaults dial the real Discord IPC pipe.
  const dialSocket = typeof createConnection === "function" ? createConnection : (p) => net.connect({ path: p });
  const listCandidates = typeof ipcPaths === "function" ? ipcPaths : ipcCandidatePaths;

  let socket = null;
  let pendingSocket = null; // in-flight candidate, not yet adopted as `socket`
  let connecting = false;
  let connected = false; // handshake READY received
  let stopped = true;
  let buf = Buffer.alloc(0);
  let presenceStartEpoch = 0; // minted once, reused across updates + reconnects
  let lastPayloadSig = ""; // publish-on-change gate
  let lastActivity = null; // latest activity, replayed after reconnect
  let appId = "";
  let reconnectAttempts = 0;
  let lastSendAt = 0;
  let flushTimer = null;
  let reconnectTimer = null;
  let readyTimer = null;

  function readConfig() {
    try { return normalizeDiscordPresence(getConfig ? getConfig() : null); } catch { return normalizeDiscordPresence(null); }
  }

  function resolveAppId() {
    const cfg = readConfig();
    return cfg.applicationId || DEFAULT_CLAWD_DISCORD_APP_ID;
  }

  function clearFlush() { if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } }
  function clearReconnect() { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } }
  function clearReady() { if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; } }

  function teardownSocket() {
    // Tear down both the live socket and any in-flight candidate, so a re-dial
    // mid-connect can't orphan a socket (listeners attached, never destroyed).
    for (const sk of [socket, pendingSocket]) {
      if (!sk) continue;
      try { sk.removeAllListeners(); } catch {}
      try { sk.destroy(); } catch {}
    }
    socket = null;
    pendingSocket = null;
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectAttempts += 1;
    const delay = Math.min(RECONNECT_MAX_MS, 1000 * 2 ** Math.min(reconnectAttempts, 5));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  function handleDisconnect() {
    connected = false;
    connecting = false;
    buf = Buffer.alloc(0);
    clearFlush();
    clearReady();
    teardownSocket();
    if (stopped) return;
    scheduleReconnect();
  }

  // Drop the live socket and re-dial immediately (no backoff). Used when the
  // App ID changed: connect() re-resolves it, and lastActivity replays on READY.
  function forceReconnect() {
    connected = false;
    connecting = false;
    buf = Buffer.alloc(0);
    clearFlush();
    clearReady();
    teardownSocket();
    reconnectAttempts = 0;
    connect();
  }

  function send(op, dataObj) {
    if (!socket || socket.destroyed) return false;
    try { socket.write(encodeFrame(op, dataObj)); return true; }
    catch { handleDisconnect(); return false; }
  }

  function sendActivity(activity) {
    if (!connected) return;
    if (activity && !presenceStartEpoch) presenceStartEpoch = Date.now();
    const withTs = activity ? { ...activity, timestamps: { start: presenceStartEpoch } } : null;
    send(OP.FRAME, { cmd: "SET_ACTIVITY", args: { pid: process.pid, activity: withTs }, nonce: randomNonce() });
  }

  function publish(activity) {
    const sig = JSON.stringify(activity);
    if (sig === lastPayloadSig) return;
    lastPayloadSig = sig;
    lastActivity = activity;
    scheduleSend();
  }

  function flushSend() {
    if (!connected || !lastActivity) return;
    lastSendAt = Date.now();
    sendActivity(lastActivity);
  }

  // Leading-edge if the window elapsed, else one trailing send.
  function scheduleSend() {
    if (!connected || flushTimer) return;
    const elapsed = Date.now() - lastSendAt;
    if (elapsed >= MIN_SEND_INTERVAL_MS) {
      flushSend();
    } else {
      flushTimer = setTimeout(() => { flushTimer = null; flushSend(); }, MIN_SEND_INTERVAL_MS - elapsed);
      if (flushTimer.unref) flushTimer.unref();
    }
  }

  function handleFrame(frame) {
    if (frame.op === OP.PING) { send(OP.PONG, frame.data); return; }
    if (frame.op === OP.CLOSE) { handleDisconnect(); return; }
    if (frame.op !== OP.FRAME) return;
    const data = frame.data || {};
    if (data.cmd === "DISPATCH" && data.evt === "READY") {
      connected = true;
      connecting = false;
      reconnectAttempts = 0;
      clearReady();
      logFn("info", "discord presence connected");
      // fresh connection: replay now, reset the window
      clearFlush();
      lastSendAt = 0;
      if (lastActivity) flushSend();
    }
  }

  function onData(chunk) {
    buf = Buffer.concat([buf, chunk]);
    let decoded;
    try { decoded = decodeFrames(buf); }
    catch { handleDisconnect(); return; }
    buf = decoded.rest;
    for (const f of decoded.frames) handleFrame(f);
  }

  function attachSocket(s) {
    s.on("data", onData);
    s.on("close", handleDisconnect);
    s.on("error", handleDisconnect);
  }

  function tryCandidate(candidates, idx) {
    if (stopped) { connecting = false; return; }
    if (idx >= candidates.length) {
      // no pipe => Discord not running; back off
      connecting = false;
      logFn("info", "discord not reachable (no IPC pipe); will retry");
      scheduleReconnect();
      return;
    }
    let s;
    try {
      s = dialSocket(candidates[idx]);
    } catch (err) {
      // net.connect can throw synchronously (EMFILE/ENFILE, bad path). Recover
      // instead of wedging with connecting=true forever.
      connecting = false;
      logFn("warn", `discord dial failed: ${(err && err.message) || err}`);
      scheduleReconnect();
      return;
    }
    pendingSocket = s;
    let settled = false;
    s.once("connect", () => {
      settled = true;
      // A newer dial (App ID change / restart) may have superseded this one.
      if (stopped || socket || s !== pendingSocket) { try { s.destroy(); } catch {} return; }
      pendingSocket = null;
      s.removeAllListeners("error");
      socket = s;
      attachSocket(s);
      send(OP.HANDSHAKE, { v: 1, client_id: appId });
      clearReady();
      readyTimer = setTimeout(() => {
        if (!connected) { logFn("warn", "discord handshake timed out (check Application ID)"); handleDisconnect(); }
      }, READY_TIMEOUT_MS);
      if (readyTimer.unref) readyTimer.unref();
    });
    s.once("error", () => {
      if (settled) return;
      try { s.destroy(); } catch {}
      if (s === pendingSocket) pendingSocket = null;
      tryCandidate(candidates, idx + 1);
    });
  }

  function connect() {
    if (stopped || connecting || socket) return;
    appId = resolveAppId();
    if (!appId) { scheduleReconnect(); return; }
    connecting = true;
    tryCandidate(listCandidates(), 0);
  }

  return {
    start() {
      stopped = false;
      clearReconnect();
      // Re-dial with the new client_id if the App ID changed while connected or mid-connect.
      if ((connected || connecting) && resolveAppId() !== appId) { forceReconnect(); return; }
      connect();
    },
    stop() {
      stopped = true;
      clearFlush();
      clearReconnect();
      clearReady();
      if (connected) sendActivity(null); // clear presence
      teardownSocket();
      connected = false;
      connecting = false;
      reconnectAttempts = 0; // don't inherit stale backoff on a later re-enable
      buf = Buffer.alloc(0);
      lastPayloadSig = "";
      lastActivity = null;
      lastSendAt = 0;
      presenceStartEpoch = 0;
    },
    onSnapshot(snapshot) {
      if (stopped) return;
      try {
        const cfg = readConfig();
        const session = pickDominantSession(snapshot);
        publish(buildPresencePayload(session, cfg));
      } catch {
        // Never throw into the snapshot fan-out.
      }
    },
  };
}

module.exports = {
  OP,
  CLAWD_ICON_URL,
  toCoarseState,
  buildPresencePayload,
  encodeFrame,
  decodeFrames,
  ipcCandidatePaths,
  pickDominantSession,
  createDiscordPresenceBridge,
};
