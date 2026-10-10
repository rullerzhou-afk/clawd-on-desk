"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  GATEWAY_DEFAULT_PORT,
  GATEWAY_PROTOCOL_VERSION,
  HEALTH_ACTIVE_WINDOW_MS,
  SCOPE_FREE_EVENTS,
  buildConnectParams,
  deriveHealthActivity,
  isHeartbeatGatewayEvent,
  mapGatewayEvent,
  normalizeGatewayUrl,
} = require("../src/remote-openclaw-protocol");

test("gateway url normalization accepts a bare host and assumes TLS", () => {
  assert.equal(normalizeGatewayUrl("openclaw.example.com"), "wss://openclaw.example.com/");
  assert.equal(normalizeGatewayUrl("  openclaw.example.com  "), "wss://openclaw.example.com/");
});

test("gateway url normalization maps schemes and defaults the gateway port", () => {
  assert.equal(normalizeGatewayUrl("https://gw.example.com"), "wss://gw.example.com/");
  assert.equal(normalizeGatewayUrl("http://gw.example.com"), `ws://gw.example.com:${GATEWAY_DEFAULT_PORT}/`);
  assert.equal(normalizeGatewayUrl("ws://gw.example.com"), `ws://gw.example.com:${GATEWAY_DEFAULT_PORT}/`);
  // An explicit port must survive — including a non-default one on wss://.
  assert.equal(normalizeGatewayUrl("wss://gw.example.com:8443"), "wss://gw.example.com:8443/");
  assert.equal(normalizeGatewayUrl("http://gw.example.com:19001"), "ws://gw.example.com:19001/");
});

test("gateway url normalization keeps a non-root path and rejects junk", () => {
  assert.equal(normalizeGatewayUrl("https://gw.example.com/openclaw"), "wss://gw.example.com/openclaw");
  for (const bad of ["", "   ", null, undefined, 42, "http://", "::::"]) {
    assert.equal(normalizeGatewayUrl(bad), "", `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("connect params carry minProtocol/maxProtocol and nest credentials under auth", () => {
  const params = buildConnectParams({ password: "pw", version: "1.2.0" });
  assert.equal(params.minProtocol, GATEWAY_PROTOCOL_VERSION);
  assert.equal(params.maxProtocol, GATEWAY_PROTOCOL_VERSION);
  assert.deepEqual(params.auth, { password: "pw" });
  assert.equal(params.client.version, "1.2.0");
  // The two mistakes that cost a round trip each on the real gateway:
  assert.equal(params.password, undefined, "password must not sit at the root");
  assert.equal(typeof params.client.id, "string");
});

test("connect params honour an advertised protocol version and token auth", () => {
  const params = buildConnectParams({ protocolVersion: 5, token: "tok" });
  assert.equal(params.minProtocol, 5);
  assert.equal(params.maxProtocol, 5);
  assert.deepEqual(params.auth, { token: "tok" });
});

test("connect params omit absent credentials rather than sending blanks", () => {
  assert.deepEqual(buildConnectParams({}).auth, {});
});

test("heartbeat broadcasts never move the pet", () => {
  for (const event of ["tick", "health", "presence", "connect.challenge"]) {
    assert.equal(isHeartbeatGatewayEvent(event), true, `${event} should be a heartbeat`);
    assert.equal(mapGatewayEvent(event, {}), null, `${event} must not map to a state`);
  }
});

test("gateway activity maps onto the pet state vocabulary", () => {
  assert.deepEqual(mapGatewayEvent("session.typing", {}), { state: "thinking", event: "UserPromptSubmit" });
  assert.deepEqual(mapGatewayEvent("session.tool", {}), { state: "working", event: "PreToolUse" });
  assert.deepEqual(mapGatewayEvent("session.approval", {}), { state: "attention", event: "Stop" });
  assert.deepEqual(mapGatewayEvent("exec.approval.requested", {}), { state: "attention", event: "Stop" });
  assert.deepEqual(mapGatewayEvent("sessions.changed", {}), { state: "idle", event: "SessionStart" });
  assert.deepEqual(mapGatewayEvent("shutdown", {}), { state: "sleeping", event: "SessionEnd" });
});

test("unknown session activity still shows as working, other unknown events are ignored", () => {
  assert.deepEqual(mapGatewayEvent("session.something-new", {}), { state: "working", event: "PreToolUse" });
  assert.equal(mapGatewayEvent("device.pair.requested", {}), null);
  assert.equal(mapGatewayEvent("", {}), null);
  assert.equal(mapGatewayEvent(undefined, {}), null);
});

// ── health snapshot → pet state ──
//
// This is the only activity source available to a credential-only connection
// (password/token auth is granted `role: operator` with an empty scope list,
// which withholds every `session.*` broadcast), so these cases are the ones
// that decide whether the feature works at all.

const NOW = 1_700_000_000_000;

function health(overrides = {}) {
  return {
    ok: true,
    ts: NOW,
    sessions: {
      path: "/state/sessions.json",
      count: 3,
      recent: [{ key: "agent:main:discord", updatedAt: NOW - 5000, age: 5000 }],
    },
    agents: [
      {
        agentId: "main",
        name: "Lobster",
        isDefault: true,
        sessions: {
          path: "/state/agents/main/sessions.json",
          count: 1,
          recent: [{ key: "agent:main:discord", updatedAt: NOW - 5000, age: 5000 }],
        },
      },
    ],
    ...overrides,
  };
}

test("a recently touched session means the gateway is working", () => {
  const activity = deriveHealthActivity(health(), { nowMs: NOW });
  assert.equal(activity.state, "working");
  assert.equal(activity.event, "PreToolUse");
  assert.equal(activity.sessionId, "agent:main:discord");
  assert.equal(activity.ageMs, 5000);
  assert.equal(activity.degraded, false);
  assert.equal(activity.errorPresent, false);
});

test("a session older than the active window is idle", () => {
  const stale = health({
    sessions: { count: 3, recent: [{ key: "k", updatedAt: NOW - 900_000, age: 900_000 }] },
    agents: [],
  });
  const activity = deriveHealthActivity(stale, { nowMs: NOW });
  assert.equal(activity.state, "idle");
  assert.equal(activity.event, "SessionStart");
});

test("the active window is configurable and inclusive at its edge", () => {
  const atEdge = health({
    sessions: {
      count: 1,
      recent: [{ key: "k", updatedAt: NOW - HEALTH_ACTIVE_WINDOW_MS, age: HEALTH_ACTIVE_WINDOW_MS }],
    },
    agents: [],
  });
  assert.equal(deriveHealthActivity(atEdge, { nowMs: NOW }).state, "working");
  const justPast = health({
    sessions: {
      count: 1,
      recent: [{ key: "k", updatedAt: NOW - HEALTH_ACTIVE_WINDOW_MS - 1, age: HEALTH_ACTIVE_WINDOW_MS + 1 }],
    },
    agents: [],
  });
  assert.equal(deriveHealthActivity(justPast, { nowMs: NOW }).state, "idle");
  assert.equal(
    deriveHealthActivity(justPast, { nowMs: NOW, activeWindowMs: 300_000 }).state,
    "working",
  );
});

test("a null age falls back to updatedAt", () => {
  const payload = health({
    sessions: { count: 1, recent: [{ key: "k", updatedAt: NOW - 1000, age: null }] },
    agents: [],
  });
  const activity = deriveHealthActivity(payload, { nowMs: NOW });
  assert.equal(activity.ageMs, 1000);
  assert.equal(activity.state, "working");
});

test("an entry with neither age nor updatedAt is not evidence of activity", () => {
  const payload = health({
    sessions: { count: 1, recent: [{ key: "k", updatedAt: null, age: null }] },
    agents: [],
  });
  assert.equal(deriveHealthActivity(payload, { nowMs: NOW }).ageMs, null);
  assert.equal(deriveHealthActivity(payload, { nowMs: NOW }).state, "idle");
});

test("the freshest session wins regardless of list order", () => {
  const payload = health({
    sessions: {
      count: 2,
      recent: [
        { key: "old", updatedAt: NOW - 900_000, age: 900_000 },
        { key: "fresh", updatedAt: NOW - 2000, age: 2000 },
      ],
    },
    agents: [],
  });
  const activity = deriveHealthActivity(payload, { nowMs: NOW });
  assert.equal(activity.state, "working");
  assert.equal(activity.sessionId, "fresh");
});

test("an agent filter narrows the snapshot to that agent", () => {
  const payload = health({
    sessions: {
      count: 9,
      recent: [{ key: "agent:other:web", updatedAt: NOW - 1000, age: 1000 }],
    },
    agents: [
      {
        agentId: "main",
        name: "Lobster",
        sessions: {
          count: 1,
          recent: [{ key: "agent:main:discord", updatedAt: NOW - 900_000, age: 900_000 }],
        },
      },
      {
        agentId: "other",
        name: "Sidekick",
        sessions: {
          count: 8,
          recent: [{ key: "agent:other:web", updatedAt: NOW - 1000, age: 1000 }],
        },
      },
    ],
  });
  // The gateway overall is busy, but the filtered agent is not.
  const quiet = deriveHealthActivity(payload, { nowMs: NOW, agentFilter: "main" });
  assert.equal(quiet.state, "idle");
  assert.equal(quiet.sessionTitle, "Lobster");
  assert.equal(quiet.agentMatched, true);

  const busy = deriveHealthActivity(payload, { nowMs: NOW, agentFilter: "other" });
  assert.equal(busy.state, "working");
  assert.equal(busy.sessionId, "agent:other:web");

  // Matching on the display name works too.
  assert.equal(deriveHealthActivity(payload, { nowMs: NOW, agentFilter: "Sidekick" }).state, "working");
});

test("an agent filter that matches nothing must not fall back to everything", () => {
  const payload = health({
    sessions: { count: 9, recent: [{ key: "busy", updatedAt: NOW - 1000, age: 1000 }] },
    agents: [{ agentId: "main", name: "Lobster", sessions: { count: 1, recent: [] } }],
  });
  const activity = deriveHealthActivity(payload, { nowMs: NOW, agentFilter: "ghost" });
  assert.equal(activity.state, "idle");
  assert.equal(activity.agentMatched, false);
  assert.equal(activity.sessionId, "");
});

test("a degraded event loop outranks session activity", () => {
  const payload = health({ eventLoop: { degraded: true, reasons: ["cpu"] } });
  const activity = deriveHealthActivity(payload, { nowMs: NOW });
  assert.equal(activity.state, "error");
  assert.equal(activity.event, "StopFailure");
  assert.equal(activity.errorPresent, true);
  assert.equal(activity.degraded, true);
});

test("not-a-health payloads are rejected rather than guessed at", () => {
  for (const bad of [null, undefined, "", 42, [], "health"]) {
    assert.equal(deriveHealthActivity(bad, { nowMs: NOW }), null);
  }
  // The pre-warm snapshot the gateway ships inside hello.
  const empty = deriveHealthActivity({}, { nowMs: NOW });
  assert.equal(empty.state, "idle");
  assert.equal(empty.ageMs, null);
});

test("the scope-free event set documents what an unscoped connection can see", () => {
  // Everything a password/token client receives that is not session activity.
  assert.ok(SCOPE_FREE_EVENTS.has("tick"));
  assert.ok(SCOPE_FREE_EVENTS.has("health"));
  // ...and the scope-gated events must NOT be in it, or the health path would
  // look like a redundant fallback instead of the primary source.
  for (const gated of ["session.tool", "session.typing", "session.message", "sessions.changed"]) {
    assert.equal(SCOPE_FREE_EVENTS.has(gated), false, `${gated} is scope-gated`);
  }
});

test("gateway event mapping reuses the local plugin's event vocabulary", () => {
  // agents/openclaw.js eventMap keys — the remote path must speak the same
  // language so downstream state handling is identical either way.
  const known = new Set([
    "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
    "PostToolUseFailure", "Stop", "StopFailure", "PreCompact", "PostCompact", "SessionEnd",
  ]);
  for (const event of [
    "session.typing", "session.tool", "session.message", "session.approval",
    "sessions.changed", "shutdown", "session.whatever",
  ]) {
    const mapped = mapGatewayEvent(event, {});
    assert.ok(known.has(mapped.event), `${event} produced an unknown event ${mapped.event}`);
  }
});
