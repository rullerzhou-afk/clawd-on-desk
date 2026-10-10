"use strict";

// ── Remote OpenClaw gateway protocol ──
//
// Talks to an OpenClaw gateway over WebSocket (the same endpoint the Control
// UI uses) and translates its broadcast events into the pet's state
// vocabulary.
//
// Wire protocol, verified against gateway 2026.10.1-beta.2 (protocol 4):
//
//   1. server → client  { type:"event", event:"connect.challenge",
//                         payload:{ nonce, ts, capabilities } }
//   2. client → server  { type:"req", id, method:"connect", params:{...} }
//   3. server → client  { type:"res", id, ok:true,
//                         payload:{ type:"hello-ok", protocol, server,
//                                   features, snapshot, auth, policy } }
//
// Two details that are easy to get wrong and cost a round trip each:
//
//   - `minProtocol` / `maxProtocol` are REQUIRED. A mismatch is answered with
//     PROTOCOL_MISMATCH carrying `expectedProtocol` and `minimumProbeProtocol`
//     in `error.details`, so the caller can retry with the advertised value
//     instead of guessing.
//   - Credentials belong inside `auth`. Putting `password` at the root is
//     rejected outright ("unexpected property 'password'").
//
// IMPORTANT: the gateway broadcasts *semantic* events (`session.tool`,
// `session.typing`, `session.approval`, ...) — NOT the plugin hook names that
// hooks/openclaw-plugin consumes (`before_tool_call`, `model_call_started`,
// ...). Those hook names are process-internal to the plugin and never appear
// on the wire, so the mapping below cannot reuse the plugin's table.
//
// IMPORTANT: most of those semantic events are SCOPE-GATED. The gateway's
// broadcaster (src/gateway/server-broadcast.ts) maps every event name to a
// required operator scope, and `session.typing` / `session.tool` /
// `session.message` / `sessions.changed` / ... all require `operator.read`.
// A password- or token-authenticated connection is granted `role: "operator"`
// with an EMPTY scope list — `connect-auth.ts` clears self-declared scopes for
// exactly these auth methods unless the client also presents a paired device
// identity, which a native desktop client cannot do. So a credential-only
// client receives NO `session.*` traffic at all, and relying on it would leave
// the pet frozen on a stale state.
//
// What a credential-only client DOES receive is the scope-free broadcast set,
// and one member of that set is enough: `health`. It carries
// `sessions.recent[]` (each with `updatedAt` / `age` in ms) plus a per-agent
// breakdown, refreshed every 60s by default. See deriveHealthActivity below.

const os = require("os");

const GATEWAY_DEFAULT_PORT = 18789;
// Advertised by gateway 2026.10.1-beta.2. Kept as a starting value only —
// see PROTOCOL_MISMATCH handling above.
const GATEWAY_PROTOCOL_VERSION = 4;

// `client.id` is an enum on the gateway side; `gateway-client` is the generic
// non-browser entry. `openclaw-control-ui` is reserved for the web UI.
const GATEWAY_CLIENT_ID = "gateway-client";
const GATEWAY_CLIENT_MODE = "ui";
const GATEWAY_CLIENT_DISPLAY_NAME = "Clawd on Desk";

const AUTH_MODES = new Set(["password", "token"]);

// Broadcasts that carry no user-visible activity. Forwarding these would keep
// the pet twitching on an otherwise idle gateway (tick fires every 30s by
// default — see `policy.tickIntervalMs` in the hello payload).
//
// `health` is listed here because it is NOT mapped to a single event — it is
// read as a snapshot by `deriveHealthActivity` instead. It is the one member
// of this set that actually moves the pet.
const HEARTBEAT_EVENTS = new Set([
  "connect.challenge",
  "tick",
  "health",
  "heartbeat",
  "presence",
  "models.snapshot",
]);

// The events the gateway will actually deliver to a connection with an empty
// scope list (see the scope-gating note at the top of this file). Kept as
// documentation for the status line: anything outside this set only arrives
// once the connection has been granted `operator.read`.
const SCOPE_FREE_EVENTS = new Set([
  "tick",
  "health",
  "heartbeat",
  "shutdown",
  "gateway.suspension",
  "update.available",
]);

// The gateway refreshes its health broadcast every 60s
// (HEALTH_REFRESH_INTERVAL_MS). A session touched within this window is
// treated as live; one refresh period of slack keeps a slow-but-alive session
// from flickering back to idle between two snapshots.
const HEALTH_ACTIVE_WINDOW_MS = 120000;

// The `health` snapshot also arrives inside the hello payload as
// `snapshot.health`, so a fresh connection can paint a state without waiting
// a full refresh period.
const HEALTH_EVENT = "health";

// gateway event → pet activity.
// `state` must be one of the states the renderer knows; `event` reuses the
// vocabulary of agents/openclaw.js `eventMap` keys so the remote path and the
// local plugin path produce the same shape downstream.
const GATEWAY_EVENT_MAP = new Map([
  // Model is producing output / a turn is being submitted.
  ["session.typing", { state: "thinking", event: "UserPromptSubmit" }],
  ["session.narration", { state: "thinking", event: "UserPromptSubmit" }],
  // A tool is being invoked, or an operation is in flight.
  ["session.tool", { state: "working", event: "PreToolUse" }],
  ["session.operation", { state: "working", event: "PreToolUse" }],
  // Output landed.
  ["session.message", { state: "working", event: "PostToolUse" }],
  ["session.observer", { state: "working", event: "PostToolUse" }],
  // The agent needs a human — this is what the pet's `attention` state is for.
  ["session.approval", { state: "attention", event: "Stop" }],
  ["exec.approval.requested", { state: "attention", event: "Stop" }],
  ["plugin.approval.requested", { state: "attention", event: "Stop" }],
  ["openclaw.approval.requested", { state: "attention", event: "Stop" }],
  ["question.requested", { state: "attention", event: "Stop" }],
  // Waiting is over, work resumed.
  ["exec.approval.resolved", { state: "working", event: "PostToolUse" }],
  ["question.resolved", { state: "working", event: "PostToolUse" }],
  // Session list changed: something woke up.
  ["sessions.changed", { state: "idle", event: "SessionStart" }],
  ["shutdown", { state: "sleeping", event: "SessionEnd" }],
]);

function normalizeGatewayUrl(input) {
  if (typeof input !== "string") return "";
  const raw = input.trim();
  if (!raw) return "";

  // Accept a bare host (`openclaw.example.com`) by assuming TLS, which is how
  // these gateways are normally exposed through a reverse proxy.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;

  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return "";
  }

  const secure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const scheme = secure ? "wss:" : "ws:";
  // Only ws:// falls back to the gateway port; wss:// is 443 (or whatever the
  // proxy terminates on), so leave it implicit.
  const port = parsed.port || (secure ? "" : String(GATEWAY_DEFAULT_PORT));
  const host = parsed.hostname;
  if (!host) return "";

  // The gateway serves its WebSocket on the root path.
  const pathname = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/";

  return `${scheme}//${host}${port ? `:${port}` : ""}${pathname}`;
}

function buildConnectParams(options = {}) {
  const protocolVersion = Number.isInteger(options.protocolVersion)
    ? options.protocolVersion
    : GATEWAY_PROTOCOL_VERSION;

  // Both modes may be present; the gateway picks what it accepts. Sending a
  // password is what a password-mode gateway expects — token-mode gateways
  // ignore it in favour of `auth.token`.
  const auth = {};
  if (typeof options.password === "string" && options.password) auth.password = options.password;
  if (typeof options.token === "string" && options.token) auth.token = options.token;

  return {
    minProtocol: protocolVersion,
    maxProtocol: protocolVersion,
    client: {
      id: options.clientId || GATEWAY_CLIENT_ID,
      displayName: options.displayName || GATEWAY_CLIENT_DISPLAY_NAME,
      version: typeof options.version === "string" && options.version ? options.version : "0.0.0",
      platform: options.platform || os.platform(),
      mode: options.mode || GATEWAY_CLIENT_MODE,
    },
    auth,
  };
}

function isHeartbeatGatewayEvent(eventName) {
  return typeof eventName === "string" && HEARTBEAT_EVENTS.has(eventName);
}

// Returns { state, event } for an activity-bearing broadcast, or null when the
// event should not move the pet.
//
// TODO(payload refinement): several gateway events carry a phase/error field
// in their payload (a tool call reporting completion vs. start, a message
// marked final, an approval that was denied). Once those payloads are captured
// from a live session, refine here so `session.tool` can distinguish
// PreToolUse from PostToolUseFailure instead of always reporting PreToolUse.
function mapGatewayEvent(eventName, payload = {}) {
  if (typeof eventName !== "string" || !eventName) return null;
  if (HEARTBEAT_EVENTS.has(eventName)) return null;

  const mapped = GATEWAY_EVENT_MAP.get(eventName);
  if (mapped) return { state: mapped.state, event: mapped.event };

  // Unknown `session.*` activity still means "the gateway is doing something",
  // so surface it as working rather than letting the pet sit on a stale state.
  // Unknown non-session events (device pairing, terminal, updates, ...) are
  // ignored — they are not agent activity.
  if (eventName.startsWith("session.")) {
    return { state: "working", event: "PreToolUse" };
  }
  return null;
}

// ── Health snapshot → pet state ──
//
// This is the path that actually works with a password/token credential, so it
// is the primary source of truth rather than a fallback.
//
// Payload shape (gateway `HealthSummary`, mirrored by
// packages/gateway-protocol/src/schema/snapshot.ts):
//
//   {
//     ok, ts, durationMs,
//     eventLoop?: { degraded, ... },
//     sessions?:  { path, count, recent: [{ key, updatedAt, age }] },
//     agents?:    [{ agentId, name, isDefault, heartbeat, sessions: {...} }],
//     heartbeatSeconds, defaultAgentId, ...
//   }
//
// `age` is `Date.now() - updatedAt` in milliseconds and may be null for a
// session that was never written to.

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function freshestSession(entries, nowMs) {
  let best = null;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isPlainObject(entry)) continue;
    const key = typeof entry.key === "string" ? entry.key : "";
    const age = readFiniteNumber(entry.age);
    const updatedAt = readFiniteNumber(entry.updatedAt);
    const ageMs =
      age !== null && age >= 0 ? age : updatedAt !== null ? Math.max(0, nowMs - updatedAt) : null;
    if (ageMs === null) continue;
    if (!best || ageMs < best.ageMs) best = { ageMs, key };
  }
  return best;
}

// The agentFilter is free text (an agent id or a display name). Deliberately
// exact-match: a substring match would silently follow the wrong agent on a
// gateway that hosts several.
function matchHealthAgent(agents, filter) {
  const needle = typeof filter === "string" ? filter.trim().toLowerCase() : "";
  if (!needle) return null;
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (!isPlainObject(agent)) continue;
    const id = typeof agent.agentId === "string" ? agent.agentId : "";
    const name = typeof agent.name === "string" ? agent.name : "";
    if (id.toLowerCase() === needle || name.toLowerCase() === needle) return agent;
  }
  return null;
}

// Returns { state, event, errorPresent, sessionId, sessionTitle, ageMs,
// degraded, agentMatched } for a `health` payload, or null when the payload is
// not a health snapshot at all (e.g. the empty `{}` the gateway sends in the
// hello before its health cache is warm).
function deriveHealthActivity(payload, options = {}) {
  if (!isPlainObject(payload)) return null;

  const nowMs = readFiniteNumber(options.nowMs);
  const resolvedNow = nowMs === null ? Date.now() : nowMs;
  const windowMs = readFiniteNumber(options.activeWindowMs);
  const activeWindow = windowMs === null || windowMs < 0 ? HEALTH_ACTIVE_WINDOW_MS : windowMs;
  const filter = typeof options.agentFilter === "string" ? options.agentFilter.trim() : "";

  const agents = Array.isArray(payload.agents) ? payload.agents : [];
  const scoped = matchHealthAgent(agents, filter);
  // A filter that names an agent the gateway does not host must not fall back
  // to "follow everything" — that is exactly the mix-up the filter exists to
  // prevent.
  if (filter && !scoped) {
    return {
      state: "idle",
      event: "SessionStart",
      errorPresent: false,
      sessionId: "",
      sessionTitle: "",
      ageMs: null,
      degraded: false,
      agentMatched: false,
    };
  }

  const summary = scoped && isPlainObject(scoped.sessions) ? scoped.sessions : payload.sessions;
  const freshest = isPlainObject(summary) ? freshestSession(summary.recent, resolvedNow) : null;
  const degraded = isPlainObject(payload.eventLoop) && payload.eventLoop.degraded === true;

  const result = {
    state: "idle",
    event: "SessionStart",
    errorPresent: false,
    sessionId: freshest && freshest.key ? freshest.key : "",
    sessionTitle: scoped ? firstNonEmpty(scoped.name, scoped.agentId) : "",
    ageMs: freshest ? freshest.ageMs : null,
    degraded,
    agentMatched: true,
  };

  // A degraded event loop outranks everything else: the gateway is unhealthy
  // regardless of what its sessions last did.
  if (degraded) {
    result.state = "error";
    result.event = "StopFailure";
    result.errorPresent = true;
    return result;
  }
  if (freshest && freshest.ageMs <= activeWindow) {
    result.state = "working";
    result.event = "PreToolUse";
  }
  return result;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

module.exports = {
  AUTH_MODES,
  GATEWAY_CLIENT_DISPLAY_NAME,
  GATEWAY_CLIENT_ID,
  GATEWAY_CLIENT_MODE,
  GATEWAY_DEFAULT_PORT,
  GATEWAY_EVENT_MAP,
  GATEWAY_PROTOCOL_VERSION,
  HEALTH_ACTIVE_WINDOW_MS,
  HEALTH_EVENT,
  HEARTBEAT_EVENTS,
  SCOPE_FREE_EVENTS,
  buildConnectParams,
  deriveHealthActivity,
  isHeartbeatGatewayEvent,
  mapGatewayEvent,
  normalizeGatewayUrl,
};
