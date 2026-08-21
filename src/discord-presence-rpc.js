"use strict";

const net = require("node:net");
const path = require("node:path");
const crypto = require("node:crypto");
const { getAgent } = require("../agents/registry");
const { isCustomApplicationNamespace } = require("./custom-applications");
const { STATE_PRIORITY, getStatePriority } = require("./state-priority");
const { normalizeDiscordPresence, DEFAULT_CLAWD_DISCORD_APP_ID } = require("./discord-presence-settings");

const OP = Object.freeze({ HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 });

// Legacy image used by the original coarse Presence opt-in. Keep this path
// byte-for-byte stable unless the separate animation-mirror opt-in is enabled.
const CLAWD_ICON_URL = "https://raw.githubusercontent.com/rullerzhou-afk/clawd-on-desk/main/assets/icon.png";

// External GIF URLs animate in large_image (uploaded portal assets can't), so the
// presence mirrors the live clawd sprite without anyone uploading art. These are the
// enlarged variants (assets/discord-presence, built by tools/build-discord-presence-gifs.py)
// that fill the card instead of floating tiny in the source canvas. Served from a branch
// ref like CLAWD_ICON_URL so the link outlives any fork or feature branch; Discord's
// media proxy may cache stale bytes for a while after a sprite is regenerated.
const GIF_BASE_URL = "https://raw.githubusercontent.com/rullerzhou-afk/clawd-on-desk/main/assets/discord-presence";

// Clawd sprite per resolved image fallback state (see resolvePresenceState).
// Mirror fallback path: used when no on-screen visual is known yet (bridge just
// started), or the current theme/svg cannot use the exact Clawd mapping.
const STATE_GIF = Object.freeze({
  idle: "clawd-idle.gif",
  sleeping: "clawd-sleeping.gif",
  thinking: "clawd-thinking.gif",
  working: "clawd-typing.gif",
  juggling: "clawd-juggling.gif",
  attention: "clawd-happy.gif",
  error: "clawd-error.gif",
});

const COARSE_LABEL = Object.freeze({
  idle: "Idle",
  thinking: "Thinking",
  working: "Working",
  waiting: "Waiting for input",
});

function sessionFolderName(session) {
  if (!session || typeof session !== "object") return "";
  const source = Object.prototype.hasOwnProperty.call(session, "displayFolder")
    ? session.displayFolder
    : session.cwd;
  return source ? path.win32.basename(String(source)) : "";
}

// State-animation mirror, keyed by the svg file main.js pushes on "state-change"
// (see bridge.onVisual). Covers the clawd theme's state animations: idle
// variants, session-count working tiers, displayHint overrides, one-shots, sleep
// chain, roam and mini mode. Animations that don't travel through state-change
// (click/drag reactions, low-power pauses, tint/accessories) are out of scope;
// svgs with no gif counterpart (look/yawn/wake/dizzy, mini-typing, the sleep
// transitions) map to the nearest sprite.
const SVG_GIF = Object.freeze({
  "clawd-idle-follow.svg": "clawd-idle.gif",
  "clawd-idle-look.svg": "clawd-idle.gif",
  "clawd-idle-bubble.svg": "clawd-bubble.gif",
  "clawd-idle-reading.svg": "clawd-idle-reading.gif",
  "clawd-idle-yawn.svg": "clawd-idle.gif",
  "clawd-idle-doze.svg": "clawd-sleeping.gif",
  "clawd-collapse-sleep.svg": "clawd-sleeping.gif",
  "clawd-sleeping.svg": "clawd-sleeping.gif",
  "clawd-wake.svg": "clawd-idle.gif",
  "clawd-dizzy.svg": "clawd-idle.gif",
  "clawd-working-thinking.svg": "clawd-thinking.gif",
  "clawd-working-typing.svg": "clawd-typing.gif",
  "clawd-working-building.svg": "clawd-building.gif",
  "clawd-headphones-groove.svg": "clawd-headphones-groove.gif",
  "clawd-working-juggling.svg": "clawd-juggling.gif",
  "clawd-working-debugger.svg": "clawd-debugger.gif",
  "clawd-working-sweeping.svg": "clawd-sweeping.gif",
  "clawd-working-carrying.svg": "clawd-carrying.gif",
  "clawd-error.svg": "clawd-error.gif",
  "clawd-happy.svg": "clawd-happy.gif",
  "clawd-notification.svg": "clawd-notification.gif",
  "clawd-mini-idle.svg": "clawd-mini-idle.gif",
  "clawd-mini-alert.svg": "clawd-mini-alert.gif",
  "clawd-mini-happy.svg": "clawd-mini-happy.gif",
  "clawd-mini-enter.svg": "clawd-mini-enter.gif",
  "clawd-mini-peek.svg": "clawd-mini-peek.gif",
  "clawd-mini-typing.svg": "clawd-typing.gif",
  "clawd-mini-crabwalk.svg": "clawd-mini-crabwalk.gif",
  "clawd-mini-sleep.svg": "clawd-sleeping.gif",
  "clawd-mini-enter-sleep.svg": "clawd-sleeping.gif",
});

const READY_TIMEOUT_MS = 5000;
const RECONNECT_MAX_MS = 30000;
// Discord rejects SET_ACTIVITY outright when state/details exceed 128 chars.
const ACTIVITY_FIELD_MAX = 128;
// Coalesce rapid flips and keep headroom below Discord's IPC throttling.
const MIN_SEND_INTERVAL_MS = 5000;

// Original Presence privacy contract. In particular, juggling/carrying/
// sweeping remain the single coarse "working" bucket, while transient or
// badge-only detail never expands what an existing user opted into.
function toCoarseState(state) {
  const s = String(state || "").replace(/^mini-/, "");
  if (s === "thinking") return "thinking";
  if (s === "working" || s === "juggling" || s === "carrying" || s === "sweeping") return "working";
  if (s === "notification" || s === "attention" || s === "error") return "waiting";
  return "idle";
}

// The snapshot only persists active states (idle/thinking/working/juggling);
// finished + failed turns collapse to idle, so the badge recovers "done" /
// "interrupted" for the image fallback. In the normal Clawd bridge path,
// sleeping and one-shots are represented by the exact visual mapping instead.
// mini-* shares its base sprite.
function resolvePresenceState(session) {
  if (!session) return "idle";
  const s = String(session.state || "").replace(/^mini-/, "");
  if (s === "thinking") return "thinking";
  if (s === "juggling") return "juggling";
  if (s === "working" || s === "carrying" || s === "sweeping") return "working";
  if (session.badge === "interrupted") return "error";
  if (session.badge === "done" || session.requiresCompletionAck === true) return "attention";
  if (s === "sleeping") return "sleeping";
  return "idle";
}

function normalizeGifBaseUrl(value) {
  const raw = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  if (!raw) return GIF_BASE_URL;
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) return GIF_BASE_URL;
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return GIF_BASE_URL;
  }
}

function presenceImageUrl(presenceState, gifBaseUrl = GIF_BASE_URL) {
  return `${normalizeGifBaseUrl(gifBaseUrl)}/${STATE_GIF[presenceState] || STATE_GIF.idle}`;
}

function agentLabel(agentId) {
  const agent = agentId ? getAgent(agentId) : null;
  return (agent && agent.name) || "Clawd";
}

function buildPresencePayload(session, cfg = {}, visual = null, runtime = {}) {
  // The mirror changes only the image. Text retains the exact pre-mirror coarse
  // contract even after the separate opt-in, so a sticky completion/error badge
  // never turns into a long-lived public status string.
  const mirrorEnabled = cfg.mirrorPetAnimation === true;
  const coarseState = toCoarseState(session && session.state);
  const presenceState = resolvePresenceState(session);
  const label = COARSE_LABEL[coarseState];
  const gifBaseUrl = normalizeGifBaseUrl(runtime.gifBaseUrl);
  const mirroredGif = mirrorEnabled
    && visual
    && visual.themeId === "clawd"
    && Object.prototype.hasOwnProperty.call(SVG_GIF, visual.svg)
    ? SVG_GIF[visual.svg]
    : "";
  const imageUrl = !mirrorEnabled
    ? CLAWD_ICON_URL
    : (mirroredGif
      ? `${gifBaseUrl}/${mirroredGif}`
      : presenceImageUrl(presenceState, gifBaseUrl));
  const agentId = session && session.agentId;
  const activity = {
    details: isCustomApplicationNamespace(agentId)
      ? "Custom agent"
      : ((session && session.agentName) || agentLabel(agentId)),
    state: label,
    assets: { large_image: imageUrl, large_text: "Clawd on Desk" },
  };
  const folder = sessionFolderName(session);
  if (cfg.privacyShowProject && folder) {
    // win32.basename splits on both \ and /, so a Windows cwd seen on a POSIX
    // host yields just the folder name instead of leaking the whole path.
    const state = `${label} · ${folder}`;
    // Truncate by code point: a long folder name would otherwise make Discord
    // silently drop the whole activity update.
    activity.state = Array.from(state).slice(0, ACTIVITY_FIELD_MAX).join("");
  }
  // Allowlist by design: only status fields (state, badge, completion flag) are
  // read; sensitive snapshot fields (sessionTitle, assistantLastOutput, ...) never are.
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
function createDiscordPresenceBridge({ getConfig, log, createConnection, ipcPaths, gifBaseUrl } = {}) {
  const logFn = typeof log === "function" ? log : () => {};
  // Injectable for tests; defaults dial the real Discord IPC pipe.
  const dialSocket = typeof createConnection === "function" ? createConnection : (p) => net.connect({ path: p });
  const listCandidates = typeof ipcPaths === "function" ? ipcPaths : ipcCandidatePaths;
  const runtime = { gifBaseUrl: normalizeGifBaseUrl(gifBaseUrl) };

  let socket = null;
  let pendingSocket = null; // in-flight candidate, not yet adopted as `socket`
  let connecting = false;
  let connected = false; // handshake READY received
  let stopped = true;
  let buf = Buffer.alloc(0);
  let presenceStartEpoch = 0; // minted once, reused across updates + reconnects
  let lastPayloadSig = ""; // publish-on-change gate
  let lastActivity = null; // latest activity, replayed after reconnect
  let lastVisual = null; // pet's state animation, pushed by main on state-change
  let lastSnapshot = null; // latest session snapshot, reused when only the visual changes
  let reconcileQueued = false; // one same-turn snapshot/visual reconcile at a time
  let reconcileGeneration = 0; // invalidates a queued reconcile across stop/start
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

  function queueReconcile() {
    if (stopped || reconcileQueued) return;
    reconcileQueued = true;
    const generation = ++reconcileGeneration;
    queueMicrotask(() => {
      if (generation !== reconcileGeneration) return;
      reconcileQueued = false;
      if (stopped) return;
      try {
        const cfg = readConfig();
        publish(buildPresencePayload(pickDominantSession(lastSnapshot), cfg, lastVisual, runtime));
      } catch {
        // Never throw into either the snapshot fan-out or renderer state path.
      }
    });
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
      lastVisual = null;
      lastSnapshot = null;
      reconcileGeneration += 1;
      reconcileQueued = false;
      lastSendAt = 0;
      presenceStartEpoch = 0;
    },
    onSnapshot(snapshot) {
      if (stopped) return;
      lastSnapshot = snapshot;
      queueReconcile();
    },
    // Pet visual changed (any "state-change" send to the renderer). Keeps the
    // presence image in lockstep with the pet's state animation.
    // Both inputs reconcile in one microtask. Most updates are visual→snapshot,
    // while completion promotion is snapshot→visual; batching both orders avoids
    // a leading-edge send that combines one new half with one stale half.
    // Standalone snapshot or idle-rotation visual changes still publish.
    onVisual(state, svg, themeId) {
      if (stopped) return;
      lastVisual = {
        state: String(state || ""),
        svg: String(svg || ""),
        themeId: String(themeId || ""),
      };
      queueReconcile();
    },
  };
}

module.exports = {
  OP,
  CLAWD_ICON_URL,
  GIF_BASE_URL,
  STATE_GIF,
  SVG_GIF,
  toCoarseState,
  resolvePresenceState,
  normalizeGifBaseUrl,
  presenceImageUrl,
  buildPresencePayload,
  encodeFrame,
  decodeFrames,
  ipcCandidatePaths,
  pickDominantSession,
  createDiscordPresenceBridge,
};
