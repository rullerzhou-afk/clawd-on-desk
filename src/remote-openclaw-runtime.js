"use strict";

// ── Remote OpenClaw runtime ──
//
// Connects to a remote OpenClaw gateway over WebSocket, completes the
// challenge/connect handshake, and turns the gateway's broadcast events into
// the same `/state` POSTs the local OpenClaw plugin produces. From the pet's
// point of view a remote gateway and a local plugin are then indistinguishable.
//
// Design notes:
//
//   - READ-ONLY by design. A password/token authenticated connection is
//     granted `role: operator` with an EMPTY scope list, so scope-gated
//     methods (`sessions.subscribe`, `sessions.messages.subscribe`) answer
//     FORBIDDEN / MISSING_SCOPE. Scope upgrade goes through
//     `device.scopes.requestUpgrade`, which requires a *paired browser*
//     identity (DEVICE_IDENTITY_REQUIRED) and is therefore unavailable to a
//     native desktop client.
//
//   - Because of that empty scope list the gateway also withholds every
//     `session.*` broadcast (`session.tool`, `session.typing`, ...) — they all
//     require `operator.read`. The one activity-bearing broadcast an unscoped
//     client still receives is `health`, refreshed every 60s, which carries
//     per-session and per-agent recency. That snapshot is therefore the
//     PRIMARY state source here, not a fallback: see `deriveHealthActivity`.
//     Should the connection ever be granted `operator.read` (a paired device
//     or a trusted-proxy deployment), `session.*` events start arriving and
//     are translated on top of it, which simply sharpens the same states.
//
//   - Handshake errors are actionable. PROTOCOL_MISMATCH advertises
//     `expectedProtocol`, so we re-connect with that value rather than
//     hard-failing on a version bump.

const http = require("http");

const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
  SERVER_PORTS,
  STATE_PATH,
} = require("../hooks/server-config");
const {
  GATEWAY_PROTOCOL_VERSION,
  HEALTH_EVENT,
  buildConnectParams,
  deriveHealthActivity,
  mapGatewayEvent,
} = require("./remote-openclaw-protocol");

const CONNECT_TIMEOUT_MS = 10000;
// Matches hooks/openclaw-plugin: state delivery must never block the caller.
const STATE_POST_TIMEOUT_MS = 1000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const AGENT_ID = "openclaw";
const HOOK_SOURCE = "remote-openclaw";
const FALLBACK_SESSION_ID = "openclaw:remote";

function loadWebSocket() {
  // `ws` is a declared dependency. Required lazily so this module can be
  // required (and its pure helpers exercised) outside a full app runtime.
  return require("ws");
}

// Mirrors hooks/openclaw-plugin postJsonToPort: try the pinned range and treat
// a response carrying our server header as "this is the real Clawd server",
// so we never paint state into an unrelated service that grabbed the port.
function postStateToPort(port, payload, onDone) {
  let settled = false;
  const finish = (ok) => {
    if (settled) return;
    settled = true;
    onDone(ok);
  };
  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      path: STATE_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: STATE_POST_TIMEOUT_MS,
    },
    (res) => {
      const isClawd = res.headers[CLAWD_SERVER_HEADER] === CLAWD_SERVER_ID;
      res.resume();
      res.on("end", () => finish(isClawd));
    },
  );
  req.on("timeout", () => {
    req.destroy();
    finish(false);
  });
  req.on("error", () => finish(false));
  req.write(payload);
  req.end();
}

function deliverState(body, httpApi) {
  const payload = JSON.stringify(body);
  const ports = (httpApi && httpApi.ports) || SERVER_PORTS;
  let index = 0;
  const attempt = () => {
    if (index >= ports.length) return;
    const port = ports[index];
    index += 1;
    postStateToPort(port, payload, (ok) => {
      if (!ok) attempt();
    });
  };
  attempt();
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

// The remote path cannot know the agent's cwd or pid — those live on the
// machine running OpenClaw, not here. Everything we can fill comes from the
// event payload; the rest is omitted rather than invented.
function buildStateBody(state, event, nativeEvent, options) {
  const payload = nativeEvent && typeof nativeEvent === "object" ? nativeEvent : {};
  const body = {
    agent_id: AGENT_ID,
    hook_source: HOOK_SOURCE,
    state,
    event,
    session_id:
      firstString(payload.sessionId, payload.sessionKey, payload.agentId) || FALLBACK_SESSION_ID,
    session_title: firstString(payload.agentId, payload.displayName, payload.title),
    tool_name: firstString(payload.toolName, payload.name),
    openclaw_run_id: firstString(payload.runId),
    openclaw_call_id: firstString(payload.callId),
  };
  const label = options && typeof options.gatewayLabel === "string" ? options.gatewayLabel.trim() : "";
  if (label) body.session_title = body.session_title || label;
  for (const key of Object.keys(body)) {
    if (body[key] === undefined || body[key] === null || body[key] === "") delete body[key];
  }
  return body;
}

function createRemoteOpenclawRuntime(options = {}) {
  const emitStatus = typeof options.onStatus === "function" ? options.onStatus : () => {};
  const emitActivity = typeof options.onActivity === "function" ? options.onActivity : () => {};
  const now = typeof options.now === "function" ? options.now : Date.now;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  // Test-only injection point. Production main.js never overrides this.
  const deliver = typeof options.deliverState === "function" ? options.deliverState : deliverState;

  let socket = null;
  let stopped = true;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let connectRequestId = null;
  // Learned from PROTOCOL_MISMATCH and reused on reconnect.
  let protocolVersion = GATEWAY_PROTOCOL_VERSION;
  // Granted scopes from the last successful hello. Empty is the normal case
  // for password/token auth and is what makes the health path primary.
  let grantedScopes = [];
  let lastDeliveredState = "";

  function setStatus(phase, detail) {
    emitStatus({ phase, detail: detail || "", at: now(), scopes: grantedScopes.slice() });
  }

  // The pet holds whatever state it was last given, so repeating an unchanged
  // snapshot would be noise. Only a real transition is worth a POST.
  //
  // One exception: an approval (`attention`) is a blocking wait. A coarse
  // health snapshot saying "the session is still fresh" must not talk the pet
  // out of it — only a newer gateway event or a genuinely idle snapshot can.
  function deliverDerived(activity) {
    if (!activity) return;
    if (activity.state === lastDeliveredState) return;
    if (lastDeliveredState === "attention" && activity.state === "working") return;

    const synthetic = {
      sessionId: activity.sessionId,
      agentId: activity.sessionTitle,
    };
    const body = buildStateBody(activity.state, activity.event, synthetic, options);
    if (activity.errorPresent) body.error_present = true;
    lastDeliveredState = activity.state;
    deliver(body, options.http);
    emitActivity({
      state: activity.state,
      event: activity.event,
      gatewayEvent: HEALTH_EVENT,
      degraded: activity.degraded === true,
    });
  }

  function handleHealth(payload) {
    deliverDerived(
      deriveHealthActivity(payload, {
        agentFilter: agentFilterString(),
        nowMs: now(),
      }),
    );
  }

  function agentFilterString() {
    const filter = options.sessionFilter;
    if (!filter || typeof filter !== "object") return "";
    return typeof filter.agentId === "string" ? filter.agentId : "";
  }

  function scheduleReconnect(reason) {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
    reconnectAttempt += 1;
    setStatus("reconnecting", `${reason}; retry in ${Math.round(delay / 1000)}s`);
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null;
      open();
    }, delay);
    if (reconnectTimer && typeof reconnectTimer.unref === "function") reconnectTimer.unref();
  }

  function teardownSocket() {
    if (!socket) return;
    const current = socket;
    socket = null;
    try {
      current.removeAllListeners();
      current.close();
    } catch {}
  }

  function sendConnect() {
    if (!socket || socket.readyState !== 1) return;
    const params = buildConnectParams({
      password: options.password,
      token: options.token,
      protocolVersion,
      version: options.version,
      displayName: options.displayName,
    });
    connectRequestId = `connect-${now()}`;
    socket.send(JSON.stringify({ type: "req", id: connectRequestId, method: "connect", params }));
  }

  function handleFrame(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return; // Non-JSON keepalives are ignorable.
    }
    if (!frame || typeof frame !== "object") return;

    // 1) Challenge first — answer with a connect request.
    if (frame.type === "event" && frame.event === "connect.challenge") {
      sendConnect();
      return;
    }

    // 2) Our connect response.
    if (frame.type === "res" && frame.id === connectRequestId) {
      if (frame.ok) {
        reconnectAttempt = 0;
        const hello = frame.payload && typeof frame.payload === "object" ? frame.payload : {};
        const auth = hello.auth && typeof hello.auth === "object" ? hello.auth : {};
        grantedScopes = Array.isArray(auth.scopes) ? auth.scopes.filter((s) => typeof s === "string") : [];
        setStatus("connected", "");
        // The hello carries a full snapshot, so paint a state immediately
        // instead of waiting out the first health refresh period.
        const snapshot = hello.snapshot && typeof hello.snapshot === "object" ? hello.snapshot : null;
        if (snapshot) handleHealth(snapshot.health);
        return;
      }
      const error = frame.error || {};
      const details = error.details || {};
      const advertised = Number(details.expectedProtocol);
      if (Number.isInteger(advertised) && advertised !== protocolVersion) {
        // Gateway moved to a new protocol version — adopt it and retry.
        protocolVersion = advertised;
        setStatus("connecting", `protocol → ${advertised}`);
        sendConnect();
        return;
      }
      setStatus("error", String(error.message || error.code || "connect failed"));
      // Credential and protocol problems will not fix themselves on retry,
      // so surface them instead of spinning.
      if (error.code === "INVALID_REQUEST" || error.code === "FORBIDDEN") return;
      scheduleReconnect(String(error.code || "connect failed"));
      return;
    }

    // 3) Health snapshot. Delivered to every connection regardless of scope,
    // so this is what keeps the pet accurate on credential-only auth.
    if (frame.type === "event" && frame.event === HEALTH_EVENT) {
      handleHealth(frame.payload);
      return;
    }

    // 4) Broadcast activity. Only arrives once the connection holds
    // `operator.read`; see the scope note at the top of the protocol module.
    if (frame.type === "event") {
      const mapped = mapGatewayEvent(frame.event, frame.payload);
      if (!mapped) return;
      const payload = frame.payload && typeof frame.payload === "object" ? frame.payload : {};
      if (!acceptsPayload(payload)) return;
      const body = buildStateBody(mapped.state, mapped.event, payload, options);
      lastDeliveredState = mapped.state;
      deliver(body, options.http);
      emitActivity({ state: mapped.state, event: mapped.event, gatewayEvent: frame.event });
    }
  }

  // A gateway is a hub: several devices and agents share it. Without a filter
  // the pet would follow activity from every node at once.
  function acceptsPayload(payload) {
    const filter = options.sessionFilter;
    if (!filter || typeof filter !== "object") return true;
    const agentId = typeof filter.agentId === "string" && filter.agentId ? filter.agentId : "";
    const sessionId = typeof filter.sessionId === "string" && filter.sessionId ? filter.sessionId : "";
    if (!agentId && !sessionId) return true;
    if (agentId && firstString(payload.agentId) === agentId) return true;
    if (sessionId && firstString(payload.sessionId, payload.sessionKey) === sessionId) return true;
    return false;
  }

  function open() {
    if (stopped) return;
    teardownSocket();

    const url = options.url;
    if (!url) {
      setStatus("error", "missing gateway url");
      return;
    }

    setStatus("connecting", "");
    let WebSocketCtor;
    try {
      WebSocketCtor = options.WebSocket || loadWebSocket();
    } catch (error) {
      setStatus("error", "ws unavailable");
      return;
    }

    let created;
    try {
      created = new WebSocketCtor(url, { handshakeTimeout: CONNECT_TIMEOUT_MS });
    } catch (error) {
      setStatus("error", String((error && error.message) || "bad gateway url"));
      return;
    }
    socket = created;

    socket.on("open", () => {
      // The gateway speaks first (connect.challenge); we answer from handleFrame.
    });
    socket.on("message", (data) => {
      handleFrame(typeof data === "string" ? data : String(data));
    });
    socket.on("close", () => {
      if (stopped) return;
      setStatus("disconnected", "socket closed");
      scheduleReconnect("socket closed");
    });
    socket.on("error", (error) => {
      if (stopped) return;
      setStatus("error", String((error && error.message) || "socket error"));
    });

    // A gateway that accepts the socket but never challenges would leave us
    // hanging in "connecting" forever.
    setTimeoutFn(() => {
      if (socket === created && connectRequestId === null) {
        setStatus("error", "handshake timeout (no connect.challenge)");
        scheduleReconnect("handshake timeout");
      }
    }, CONNECT_TIMEOUT_MS);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      reconnectAttempt = 0;
      grantedScopes = [];
      lastDeliveredState = "";
      open();
    },
    stop() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeoutFn(reconnectTimer);
        reconnectTimer = null;
      }
      teardownSocket();
      grantedScopes = [];
      lastDeliveredState = "";
      setStatus("stopped", "");
    },
    isRunning() {
      return !stopped;
    },
    getProtocolVersion() {
      return protocolVersion;
    },
    getGrantedScopes() {
      return grantedScopes.slice();
    },
  };
}

module.exports = {
  AGENT_ID,
  HOOK_SOURCE,
  buildStateBody,
  createRemoteOpenclawRuntime,
  deliverState,
};
