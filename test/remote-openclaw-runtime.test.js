"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createRemoteOpenclawRuntime } = require("../src/remote-openclaw-runtime");
const { GATEWAY_PROTOCOL_VERSION } = require("../src/remote-openclaw-protocol");

const NOW = 1000;

function createFakeSocket(url) {
  const handlers = new Map();
  return {
    url,
    readyState: 1,
    sent: [],
    closed: false,
    send(raw) {
      this.sent.push(JSON.parse(raw));
    },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return this;
    },
    removeAllListeners() {
      handlers.clear();
    },
    close() {
      this.closed = true;
    },
    emit(name, ...args) {
      for (const fn of handlers.get(name) || []) fn(...args);
    },
  };
}

function createHarness(options = {}) {
  const sockets = [];
  const timers = { scheduled: [], nextId: 1 };
  const delivered = [];
  const statuses = [];
  const activities = [];
  function FakeWebSocket(url) {
    const socket = createFakeSocket(url);
    sockets.push(socket);
    return socket;
  }
  const runtime = createRemoteOpenclawRuntime({
    url: options.url === undefined ? "wss://gw.example.com/" : options.url,
    password: options.password,
    token: options.token,
    sessionFilter: options.sessionFilter || null,
    WebSocket: FakeWebSocket,
    deliverState: (body) => delivered.push(body),
    onStatus: (s) => statuses.push(s),
    onActivity: (a) => activities.push(a),
    now: () => NOW,
    setTimeout(fn, ms) {
      const id = timers.nextId;
      timers.nextId += 1;
      timers.scheduled.push({ fn, ms, id });
      return id;
    },
    clearTimeout(id) {
      const index = timers.scheduled.findIndex((entry) => entry.id === id);
      if (index >= 0) timers.scheduled.splice(index, 1);
    },
  });
  return { runtime, sockets, timers, delivered, statuses, activities };
}

function connectFrame() {
  return JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n1" } });
}

test("runtime answers the gateway challenge with a connect request", () => {
  const { runtime, sockets } = createHarness({ password: "pw" });
  runtime.start();
  const socket = sockets[0];
  assert.equal(sockets.length, 1);

  socket.emit("message", connectFrame());
  assert.equal(socket.sent.length, 1);
  const req = socket.sent[0];
  assert.equal(req.type, "req");
  assert.equal(req.method, "connect");
  assert.deepEqual(req.params.auth, { password: "pw" });
  runtime.stop();
});

test("a successful handshake reports connected and clears the retry counter", () => {
  const { runtime, sockets, statuses } = createHarness({ password: "pw" });
  runtime.start();
  const socket = sockets[0];
  socket.emit("message", connectFrame());
  socket.emit("message", JSON.stringify({
    type: "res",
    id: `connect-${NOW}`,
    ok: true,
    payload: { type: "hello-ok", protocol: GATEWAY_PROTOCOL_VERSION },
  }));
  // An absent `auth` block means an empty scope list: the normal case for
  // password/token auth, and the reason the health snapshot drives the state.
  assert.deepEqual(statuses[statuses.length - 1], {
    phase: "connected",
    detail: "",
    at: NOW,
    scopes: [],
  });
  assert.deepEqual(runtime.getGrantedScopes(), []);
  runtime.stop();
});

test("PROTOCOL_MISMATCH adopts the advertised version instead of hard-failing", () => {
  const { runtime, sockets, statuses } = createHarness({ password: "pw" });
  runtime.start();
  const socket = sockets[0];
  socket.emit("message", connectFrame());
  assert.equal(socket.sent[0].params.minProtocol, GATEWAY_PROTOCOL_VERSION);

  socket.emit("message", JSON.stringify({
    type: "res",
    id: `connect-${NOW}`,
    ok: false,
    error: { code: "PROTOCOL_MISMATCH", message: "protocol mismatch", details: { expectedProtocol: 5 } },
  }));

  assert.equal(socket.sent.length, 2, "must retry the handshake on the same socket");
  assert.equal(socket.sent[1].params.minProtocol, 5);
  assert.equal(socket.sent[1].params.maxProtocol, 5);
  assert.equal(runtime.getProtocolVersion(), 5);
  assert.equal(statuses[statuses.length - 1].phase, "connecting");
  runtime.stop();
});

test("a non-retryable connect failure surfaces an error and does not spin", () => {
  const { runtime, sockets, statuses, timers } = createHarness({ password: "wrong" });
  runtime.start();
  const socket = sockets[0];
  socket.emit("message", connectFrame());
  socket.emit("message", JSON.stringify({
    type: "res",
    id: `connect-${NOW}`,
    ok: false,
    error: { code: "FORBIDDEN", message: "bad credentials" },
  }));
  assert.equal(statuses[statuses.length - 1].phase, "error");
  assert.equal(statuses[statuses.length - 1].detail, "bad credentials");
  // Only the handshake-timeout guard remains scheduled; no reconnect was queued.
  assert.equal(timers.scheduled.filter((entry) => entry.ms !== 10000).length, 0);
  runtime.stop();
});

test("gateway activity is translated into a /state body", () => {
  const { runtime, sockets, delivered, activities } = createHarness({ password: "pw" });
  runtime.start();
  const socket = sockets[0];
  socket.emit("message", connectFrame());
  socket.emit("message", JSON.stringify({
    type: "event",
    event: "session.tool",
    payload: { sessionId: "s1", agentId: "agent-7", toolName: "Bash" },
  }));

  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0], {
    agent_id: "openclaw",
    hook_source: "remote-openclaw",
    state: "working",
    event: "PreToolUse",
    session_id: "s1",
    session_title: "agent-7",
    tool_name: "Bash",
  });
  assert.deepEqual(activities[activities.length - 1], {
    state: "working",
    event: "PreToolUse",
    gatewayEvent: "session.tool",
  });
  runtime.stop();
});

test("heartbeat broadcasts are dropped instead of nudging the pet", () => {
  const { runtime, sockets, delivered } = createHarness({ password: "pw" });
  runtime.start();
  const socket = sockets[0];
  socket.emit("message", connectFrame());
  // `health` is deliberately absent: it is the one broadcast that DOES move
  // the pet, and has its own cases below.
  for (const event of ["tick", "presence", "models.snapshot"]) {
    socket.emit("message", JSON.stringify({ type: "event", event, payload: {} }));
  }
  assert.equal(delivered.length, 0);
  runtime.stop();
});

// ── health snapshot → /state ──
//
// A credential-only connection never receives `session.*` (they are gated on
// `operator.read`), so this is the path that actually drives the pet.

function healthPayload(overrides = {}) {
  return {
    ok: true,
    ts: NOW,
    sessions: {
      path: "/state/sessions.json",
      count: 3,
      recent: [{ key: "agent:main:discord", updatedAt: NOW - 4000, age: 4000 }],
    },
    agents: [],
    ...overrides,
  };
}

function healthFrame(payload) {
  return JSON.stringify({ type: "event", event: "health", payload });
}

function connectedHarness(options = {}) {
  const harness = createHarness(options);
  harness.runtime.start();
  const socket = harness.sockets[0];
  socket.emit("message", connectFrame());
  socket.emit("message", JSON.stringify({
    type: "res",
    id: `connect-${NOW}`,
    ok: true,
    payload: { type: "hello-ok", protocol: GATEWAY_PROTOCOL_VERSION, auth: options.auth },
  }));
  return { ...harness, socket };
}

test("a health snapshot showing a fresh session paints working", () => {
  const { runtime, socket, delivered, activities } = connectedHarness({ password: "pw" });
  socket.emit("message", healthFrame(healthPayload()));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].state, "working");
  assert.equal(delivered[0].event, "PreToolUse");
  assert.equal(delivered[0].session_id, "agent:main:discord");
  assert.equal(delivered[0].hook_source, "remote-openclaw");
  assert.equal(activities[activities.length - 1].gatewayEvent, "health");
  runtime.stop();
});

test("an unchanged health snapshot is not re-posted", () => {
  const { runtime, socket, delivered } = connectedHarness({ password: "pw" });
  socket.emit("message", healthFrame(healthPayload()));
  socket.emit("message", healthFrame(healthPayload()));
  // The pet holds the last state it was given, so repeating it is noise.
  assert.equal(delivered.length, 1);
  runtime.stop();
});

test("a session going quiet moves the pet back to idle", () => {
  const { runtime, socket, delivered } = connectedHarness({ password: "pw" });
  socket.emit("message", healthFrame(healthPayload()));
  socket.emit("message", healthFrame(healthPayload({
    sessions: { count: 3, recent: [{ key: "agent:main:discord", updatedAt: NOW - 900_000, age: 900_000 }] },
  })));
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].state, "idle");
  runtime.stop();
});

test("a degraded event loop posts an error with error_present", () => {
  const { runtime, socket, delivered } = connectedHarness({ password: "pw" });
  socket.emit("message", healthFrame(healthPayload({ eventLoop: { degraded: true, reasons: ["cpu"] } })));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].state, "error");
  assert.equal(delivered[0].event, "StopFailure");
  assert.equal(delivered[0].error_present, true);
  runtime.stop();
});

test("the hello snapshot paints a state without waiting a full refresh period", () => {
  const { runtime, sockets, delivered } = createHarness({ password: "pw" });
  runtime.start();
  const socket = sockets[0];
  socket.emit("message", connectFrame());
  socket.emit("message", JSON.stringify({
    type: "res",
    id: `connect-${NOW}`,
    ok: true,
    payload: {
      type: "hello-ok",
      protocol: GATEWAY_PROTOCOL_VERSION,
      auth: { method: "password", role: "operator", scopes: [] },
      snapshot: { health: healthPayload(), uptimeMs: 10 },
    },
  }));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].state, "working");
  assert.deepEqual(runtime.getGrantedScopes(), []);
  runtime.stop();
});

test("granted scopes are reported so the UI can explain the read-only path", () => {
  const { runtime, sockets } = createHarness({ password: "pw" });
  runtime.start();
  const socket = sockets[0];
  socket.emit("message", connectFrame());
  socket.emit("message", JSON.stringify({
    type: "res",
    id: `connect-${NOW}`,
    ok: true,
    payload: {
      type: "hello-ok",
      protocol: GATEWAY_PROTOCOL_VERSION,
      auth: { method: "password", role: "operator", scopes: ["operator.read"] },
    },
  }));
  assert.deepEqual(runtime.getGrantedScopes(), ["operator.read"]);
  runtime.stop();
});

test("the agent filter applies to the health snapshot too", () => {
  const { runtime, socket, delivered } = connectedHarness({
    password: "pw",
    sessionFilter: { agentId: "main", sessionId: "main" },
  });
  socket.emit("message", healthFrame(healthPayload({
    agents: [
      { agentId: "main", name: "Lobster", sessions: { count: 1, recent: [] } },
    ],
  })));
  // The gateway-wide snapshot is fresh, but the filtered agent has no recent
  // sessions — following the gateway here would defeat the filter.
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].state, "idle");
  runtime.stop();
});

test("an approval is not talked out of by a coarse health snapshot", () => {
  const { runtime, socket, delivered } = connectedHarness({ password: "pw" });
  socket.emit("message", JSON.stringify({ type: "event", event: "session.approval", payload: {} }));
  assert.equal(delivered[0].state, "attention");
  socket.emit("message", healthFrame(healthPayload()));
  // Still waiting on a human: the health snapshot must not say "working".
  assert.equal(delivered.length, 1);
  runtime.stop();
});

test("a payload with no session id falls back to a stable remote session key", () => {
  const { runtime, sockets, delivered } = createHarness({ password: "pw" });
  runtime.start();
  const socket = sockets[0];
  socket.emit("message", connectFrame());
  socket.emit("message", JSON.stringify({ type: "event", event: "session.message", payload: {} }));
  assert.equal(delivered[0].session_id, "openclaw:remote");
  runtime.stop();
});

test("the agent filter keeps one gateway's other nodes out of the pet", () => {
  const { runtime, sockets, delivered } = createHarness({
    password: "pw",
    sessionFilter: { agentId: "agent-7", sessionId: "agent-7" },
  });
  runtime.start();
  const socket = sockets[0];
  socket.emit("message", connectFrame());
  socket.emit("message", JSON.stringify({
    type: "event", event: "session.tool", payload: { agentId: "someone-else" },
  }));
  assert.equal(delivered.length, 0, "another node's activity must be ignored");
  socket.emit("message", JSON.stringify({
    type: "event", event: "session.tool", payload: { sessionId: "agent-7" },
  }));
  assert.equal(delivered.length, 1, "the filtered node's activity must pass");
  runtime.stop();
});

test("a closed socket schedules a capped backoff reconnect and stop cancels it", () => {
  const { runtime, sockets, timers, statuses } = createHarness({ password: "pw" });
  runtime.start();
  const socket = sockets[0];
  socket.emit("close");
  assert.equal(statuses[statuses.length - 1].phase, "reconnecting");
  const pending = timers.scheduled.filter((entry) => entry.ms !== 10000);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].ms, 2000);

  runtime.stop();
  assert.equal(timers.scheduled.filter((entry) => entry.ms !== 10000).length, 0, "stop must cancel the retry");
  assert.equal(socket.closed, true);
});

test("reconnect backoff grows and is capped", () => {
  const { runtime, sockets, timers } = createHarness({ password: "pw" });
  runtime.start();
  const delays = [];
  for (let i = 0; i < 8; i += 1) {
    const socket = sockets[sockets.length - 1];
    socket.emit("close");
    const pending = timers.scheduled.filter((entry) => entry.ms !== 10000);
    delays.push(pending[pending.length - 1].ms);
    // Fire the queued retry so the next close schedules the following step.
    pending[pending.length - 1].fn();
    timers.scheduled.length = 0;
  }
  assert.deepEqual(delays.slice(0, 3), [2000, 4000, 8000]);
  assert.equal(delays[delays.length - 1], 60000, "backoff must be capped at 60s");
  runtime.stop();
});

test("a missing url is an error, not a crash", () => {
  const { runtime, sockets, statuses } = createHarness({ url: "", password: "pw" });
  runtime.start();
  assert.equal(sockets.length, 0);
  assert.equal(statuses[statuses.length - 1].phase, "error");
  assert.match(statuses[statuses.length - 1].detail, /missing gateway url/);
});

test("an unparseable frame and a non-object frame are ignored", () => {
  const { runtime, sockets, delivered } = createHarness({ password: "pw" });
  runtime.start();
  const socket = sockets[0];
  socket.emit("message", "not json at all");
  socket.emit("message", JSON.stringify("a string"));
  socket.emit("message", JSON.stringify(null));
  assert.equal(delivered.length, 0);
  runtime.stop();
});
