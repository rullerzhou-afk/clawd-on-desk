"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const {
  toCoarseState,
  buildPresencePayload,
  pickDominantSession,
  encodeFrame,
  decodeFrames,
  createDiscordPresenceBridge,
  OP,
} = require("../src/discord-presence-rpc");

// Stand-in for a Discord IPC pipe socket: captures writes, driven by emit().
class FakeIpcSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.destroyed = false;
  }
  write(buf) { this.writes.push(buf); return true; }
  destroy() { this.destroyed = true; }
}

function firstFrame(socket) {
  return decodeFrames(socket.writes[0]).frames[0];
}

const READY_FRAME = encodeFrame(OP.FRAME, { cmd: "DISPATCH", evt: "READY" });

test("toCoarseState collapses canonical session states into 4 coarse buckets", () => {
  assert.strictEqual(toCoarseState("working"), "working");
  assert.strictEqual(toCoarseState("juggling"), "working");
  assert.strictEqual(toCoarseState("carrying"), "working");
  assert.strictEqual(toCoarseState("thinking"), "thinking");
  assert.strictEqual(toCoarseState("notification"), "waiting"); // permission pending => waiting on user
  assert.strictEqual(toCoarseState("attention"), "waiting");
  assert.strictEqual(toCoarseState("error"), "waiting");        // highest-priority state; it dominates the display
  assert.strictEqual(toCoarseState("idle"), "idle");
  assert.strictEqual(toCoarseState("sleeping"), "idle");
  assert.strictEqual(toCoarseState("mini-working"), "working"); // tolerate a leaked mini-* just in case
});

test("buildPresencePayload exposes ONLY agent + coarse state + icon by default", () => {
  const session = {
    agentId: "claude-code",
    state: "working",
    cwd: "D:\\Repos\\Apps\\secret-project",
    sessionTitle: "fix the thing",
  };
  const out = buildPresencePayload(session, { privacyShowProject: false });
  const blob = JSON.stringify(out);
  assert.strictEqual(blob.includes("secret-project"), false); // cwd / project never leaks by default
  assert.strictEqual(blob.includes("fix the thing"), false);  // session title never leaks
  assert.match(out.state, /working/i);            // coarse state present
  assert.ok(out.details);                         // agent label present
  assert.ok(out.assets && out.assets.large_image); // icon present
});

test("buildPresencePayload adds the project name ONLY when privacyShowProject is on", () => {
  const session = { agentId: "claude-code", state: "working", cwd: "D:\\Repos\\Apps\\demo" };
  const off = buildPresencePayload(session, { privacyShowProject: false });
  assert.strictEqual(JSON.stringify(off).includes("demo"), false);
  const on = buildPresencePayload(session, { privacyShowProject: true });
  assert.strictEqual(JSON.stringify(on).includes("demo"), true);
});

test("buildPresencePayload publishes ONLY the folder name, never a full path, on any OS", () => {
  // POSIX path.basename can't split a Windows cwd, leaking the whole path; the
  // payload must surface just the folder name regardless of host platform.
  const session = { agentId: "claude-code", state: "working", cwd: "C:\\Users\\alice\\Projects\\secret" };
  const out = buildPresencePayload(session, { privacyShowProject: true });
  assert.match(out.state, /secret/);
  assert.strictEqual(out.state.includes("alice"), false);
  assert.strictEqual(out.state.includes("Projects"), false);
  assert.strictEqual(out.state.includes("C:"), false);
  assert.strictEqual(out.state.includes("\\"), false);
  assert.strictEqual(out.state.includes("/"), false);
});

test("buildPresencePayload truncates state to Discord's 128-char activity limit", () => {
  // Discord rejects the whole SET_ACTIVITY frame when state exceeds 128 chars,
  // so an extra-long folder name must not silently kill presence updates.
  const session = { agentId: "claude-code", state: "working", cwd: `D:\\repos\\${"x".repeat(300)}` };
  const out = buildPresencePayload(session, { privacyShowProject: true });
  assert.ok(Array.from(out.state).length <= 128, `state too long: ${out.state.length}`);
  assert.match(out.state, /^Working · x/); // prefix intact, tail truncated
});

test("pickDominantSession skips headless, sleeping, and hiddenFromHud sessions (HUD-aligned)", () => {
  const snapshot = { sessions: [
    { id: "a", agentId: "codex", state: "working", hiddenFromHud: true },  // superseded -> skip despite high priority
    { id: "b", agentId: "claude-code", state: "sleeping" },                // ended -> skip
    { id: "c", agentId: "claude-code", state: "error", headless: true },   // headless -> skip
    { id: "d", agentId: "claude-code", state: "thinking" },                // visible -> picked
  ] };
  const picked = pickDominantSession(snapshot);
  assert.strictEqual(picked && picked.id, "d");

  const allHidden = { sessions: [
    { id: "x", state: "working", hiddenFromHud: true },
    { id: "y", state: "sleeping" },
    { id: "z", state: "error", headless: true },
  ] };
  assert.strictEqual(pickDominantSession(allHidden), null);
});

test("bridge reconnects with the new client_id when the App ID changes while connected", () => {
  const cfg = { enabled: true, applicationId: "111111111111111111", privacyShowProject: false };
  const sockets = [];
  const bridge = createDiscordPresenceBridge({
    getConfig: () => cfg,
    ipcPaths: () => ["fake-pipe"],
    createConnection: () => { const s = new FakeIpcSocket(); sockets.push(s); return s; },
  });

  bridge.start();
  assert.strictEqual(sockets.length, 1);
  sockets[0].emit("connect");                       // pipe up -> HANDSHAKE sent
  const hs1 = firstFrame(sockets[0]);
  assert.strictEqual(hs1.op, OP.HANDSHAKE);
  assert.strictEqual(hs1.data.client_id, "111111111111111111");
  sockets[0].emit("data", READY_FRAME);             // READY -> connected

  cfg.applicationId = "222222222222222222";
  bridge.start();                                   // App ID changed while live
  assert.strictEqual(sockets.length, 2);            // forced a fresh dial
  assert.strictEqual(sockets[0].destroyed, true);   // old socket torn down, not leaked
  sockets[1].emit("connect");
  assert.strictEqual(firstFrame(sockets[1]).data.client_id, "222222222222222222");

  bridge.stop();
});

test("bridge does NOT reconnect when start() runs with an unchanged App ID", () => {
  const cfg = { enabled: true, applicationId: "111111111111111111" };
  const sockets = [];
  const bridge = createDiscordPresenceBridge({
    getConfig: () => cfg,
    ipcPaths: () => ["fake-pipe"],
    createConnection: () => { const s = new FakeIpcSocket(); sockets.push(s); return s; },
  });

  bridge.start();
  sockets[0].emit("connect");
  sockets[0].emit("data", READY_FRAME);
  bridge.start();                                   // same config -> no-op
  assert.strictEqual(sockets.length, 1);

  bridge.stop();
});

test("bridge supersedes an in-flight dial when the App ID changes mid-connect (no orphan)", () => {
  const cfg = { enabled: true, applicationId: "111111111111111111" };
  const sockets = [];
  const bridge = createDiscordPresenceBridge({
    getConfig: () => cfg,
    ipcPaths: () => ["fake-pipe"],
    createConnection: () => { const s = new FakeIpcSocket(); sockets.push(s); return s; },
  });

  bridge.start();                       // dial #1 in flight, not yet connected
  assert.strictEqual(sockets.length, 1);

  cfg.applicationId = "222222222222222222";
  bridge.start();                       // App ID changed mid-dial -> supersede
  assert.strictEqual(sockets.length, 2);
  assert.strictEqual(sockets[0].destroyed, true);  // in-flight dial torn down

  // The superseded socket connecting late must NOT adopt or send a handshake.
  sockets[0].emit("connect");
  assert.strictEqual(sockets[0].writes.length, 0);

  sockets[1].emit("connect");
  assert.strictEqual(firstFrame(sockets[1]).data.client_id, "222222222222222222");

  bridge.stop();
});

test("bridge recovers when the dial throws synchronously (e.g. fd exhaustion)", () => {
  const cfg = { enabled: true, applicationId: "111111111111111111" };
  let dials = 0;
  const bridge = createDiscordPresenceBridge({
    getConfig: () => cfg,
    ipcPaths: () => ["fake-pipe"],
    createConnection: () => { dials += 1; throw new Error("EMFILE"); },
  });

  // Must not throw, and must not wedge `connecting=true` — a later start() can re-dial.
  assert.doesNotThrow(() => bridge.start());
  assert.strictEqual(dials, 1);

  bridge.stop();
});

test("encodeFrame/decodeFrames round-trips opcode + JSON across split chunks", () => {
  const payload = { v: 1, client_id: "123456789012345678" };
  const frame = encodeFrame(OP.HANDSHAKE, payload);
  // header is 8 bytes: int32-LE opcode + int32-LE length
  assert.strictEqual(frame.readInt32LE(0), OP.HANDSHAKE);
  assert.strictEqual(frame.readInt32LE(4), Buffer.byteLength(JSON.stringify(payload)));
  // feed it in two pieces to prove the accumulator reassembles split pipe reads
  const dec = decodeFrames(Buffer.concat([frame.subarray(0, 3), frame.subarray(3)]));
  assert.strictEqual(dec.frames.length, 1);
  assert.strictEqual(dec.frames[0].op, OP.HANDSHAKE);
  assert.deepStrictEqual(dec.frames[0].data, payload);
  assert.strictEqual(dec.rest.length, 0);
});

test("before-quit stops the Discord presence bridge before tearing down session state", () => {
  // Source-text guard mirroring hardware-buddy-adapter.test.js: a refactor that
  // drops this cleanup would otherwise silently strand presence on quit again.
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const start = source.indexOf('app.on("before-quit"');
  const end = source.indexOf('app.on("window-all-closed"', start);
  const block = source.slice(start, end);
  const bridgeStop = block.indexOf("discordPresenceBridge.stop()");
  const stateCleanup = block.indexOf("_state.cleanup()");
  assert.ok(bridgeStop !== -1, "before-quit should stop the Discord presence bridge");
  assert.ok(stateCleanup !== -1, "before-quit should clean up session state");
  // The bridge consumes the session-snapshot subscription, so stop it before _state.
  assert.ok(bridgeStop < stateCleanup, "presence bridge must stop before _state.cleanup()");
});

test("stop() resets the reconnect backoff so a later start() dials at the base delay", () => {
  // reconnectAttempts is a closure private; the only observable is the delay
  // scheduleReconnect() hands setTimeout, so capture it instead of firing it.
  const cfg = { enabled: true, applicationId: "111111111111111111" };
  const sockets = [];
  const realSetTimeout = global.setTimeout;
  const scheduled = [];
  global.setTimeout = (fn, delay) => {
    scheduled.push({ fn, delay });
    return { unref() {} };
  };
  try {
    const bridge = createDiscordPresenceBridge({
      getConfig: () => cfg,
      ipcPaths: () => ["fake-pipe"], // single candidate -> one error exhausts the list -> backoff
      createConnection: () => { const s = new FakeIpcSocket(); sockets.push(s); return s; },
    });
    // Pre-connect error exhausts the candidate list and schedules a backoff dial.
    const dialAndFail = () => sockets[sockets.length - 1].emit("error");

    bridge.start();
    dialAndFail();
    assert.strictEqual(scheduled.at(-1).delay, 2000, "attempt 1 -> 2s");

    scheduled.at(-1).fn();   // fire reconnect -> re-dial
    dialAndFail();
    assert.strictEqual(scheduled.at(-1).delay, 4000, "attempt 2 -> 4s");

    scheduled.at(-1).fn();
    dialAndFail();
    assert.strictEqual(scheduled.at(-1).delay, 8000, "attempt 3 -> 8s");

    bridge.stop();           // must reset reconnectAttempts to 0
    const before = scheduled.length;
    bridge.start();
    dialAndFail();
    assert.ok(scheduled.length > before, "restart should schedule a fresh reconnect");
    assert.strictEqual(scheduled.at(-1).delay, 2000, "stop() must reset backoff to the base delay (not 16s)");

    bridge.stop();
  } finally {
    global.setTimeout = realSetTimeout;
  }
});
