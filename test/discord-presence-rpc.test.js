"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const {
  CLAWD_ICON_URL,
  GIF_BASE_URL,
  toCoarseState,
  resolvePresenceState,
  normalizeGifBaseUrl,
  presenceImageUrl,
  buildPresencePayload,
  pickDominantSession,
  encodeFrame,
  decodeFrames,
  createDiscordPresenceBridge,
  OP,
  STATE_GIF,
  SVG_GIF,
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
const MIRROR_ON = { mirrorPetAnimation: true };
const clawdVisual = (state, svg) => ({ state, svg, themeId: "clawd" });

test("toCoarseState preserves the original four-state privacy contract", () => {
  assert.strictEqual(toCoarseState("idle"), "idle");
  assert.strictEqual(toCoarseState("thinking"), "thinking");
  assert.strictEqual(toCoarseState("working"), "working");
  assert.strictEqual(toCoarseState("juggling"), "working");
  assert.strictEqual(toCoarseState("carrying"), "working");
  assert.strictEqual(toCoarseState("notification"), "waiting");
  assert.strictEqual(toCoarseState("error"), "waiting");
  assert.strictEqual(toCoarseState("mini-working"), "working");
});

test("resolvePresenceState maps active states and recovers done/error from the badge", () => {
  assert.strictEqual(resolvePresenceState({ state: "thinking" }), "thinking");
  assert.strictEqual(resolvePresenceState({ state: "working" }), "working");
  assert.strictEqual(resolvePresenceState({ state: "juggling" }), "juggling");
  assert.strictEqual(resolvePresenceState({ state: "mini-working" }), "working"); // mini-* shares its base
  // one-shot states (error/attention/notification/...) collapse to idle in the
  // snapshot; the badge is how we recover them
  assert.strictEqual(resolvePresenceState({ state: "idle", badge: "interrupted" }), "error");
  assert.strictEqual(resolvePresenceState({ state: "idle", badge: "done" }), "attention");
  assert.strictEqual(resolvePresenceState({ state: "idle", requiresCompletionAck: true }), "attention");
  assert.strictEqual(resolvePresenceState({ state: "working", requiresCompletionAck: true }), "working"); // busy now wins
  assert.strictEqual(resolvePresenceState({ state: "idle" }), "idle");
  assert.strictEqual(resolvePresenceState(null), "idle");
});

test("buildPresencePayload exposes ONLY agent + coarse state + legacy icon by default", () => {
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
  assert.strictEqual(out.assets && out.assets.large_image, CLAWD_ICON_URL);
});

test("mirror-on fallback image follows detail while text remains on the legacy coarse contract", () => {
  const img = (s) => buildPresencePayload(s, MIRROR_ON).assets.large_image;
  const label = (s) => buildPresencePayload(s, MIRROR_ON).state;
  assert.match(img({ state: "thinking" }), /clawd-thinking\.gif$/);
  assert.match(img({ state: "working" }), /clawd-typing\.gif$/);
  assert.match(img({ state: "juggling" }), /clawd-juggling\.gif$/);
  assert.match(img({ state: "idle", badge: "interrupted" }), /clawd-error\.gif$/);
  assert.match(img({ state: "idle", requiresCompletionAck: true }), /clawd-happy\.gif$/);
  assert.match(img({ state: "idle" }), /clawd-idle\.gif$/);
  assert.strictEqual(label({ state: "idle", requiresCompletionAck: true }), "Idle");
  assert.strictEqual(label({ state: "idle", badge: "interrupted" }), "Idle");
  assert.match(presenceImageUrl("totally-unknown"), /clawd-idle\.gif$/); // unknown falls back to idle
});

test("GIF base URL accepts an HTTPS dev host and rejects unsafe overrides", () => {
  const devBase = "https://example.test/pr-738/assets/discord-presence/";
  assert.strictEqual(normalizeGifBaseUrl(devBase), devBase.slice(0, -1));
  assert.strictEqual(
    presenceImageUrl("working", devBase),
    "https://example.test/pr-738/assets/discord-presence/clawd-typing.gif"
  );
  assert.strictEqual(normalizeGifBaseUrl("http://127.0.0.1:9999/assets"), GIF_BASE_URL);
  assert.strictEqual(normalizeGifBaseUrl("https://user:secret@example.test/assets"), GIF_BASE_URL);
  assert.strictEqual(normalizeGifBaseUrl("https://example.test/assets?ref=test"), GIF_BASE_URL);
  assert.strictEqual(normalizeGifBaseUrl("https://example.test/assets#fragment"), GIF_BASE_URL);
  assert.strictEqual(normalizeGifBaseUrl("not a URL"), GIF_BASE_URL);
});

test("buildPresencePayload keeps custom executable names out of public presence", () => {
  const out = buildPresencePayload({
    agentId: "custom-nova-0123456789ab",
    agentName: "Nova AI",
    state: "working",
  });

  assert.strictEqual(out.details, "Custom agent");
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

test("buildPresencePayload respects an explicitly hidden snapshot displayFolder", () => {
  const opaque = "mqgw60jiigjsjcid";
  const session = {
    agentId: "qwenwork",
    state: "working",
    cwd: `/Users/me/.QwenWorkCN/workspace/${opaque}`,
    displayFolder: "",
  };
  const out = buildPresencePayload(session, { privacyShowProject: true });
  assert.equal(out.state, "Working");
  assert.ok(!JSON.stringify(out).includes(opaque));
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
  // Source-text guard: a refactor that
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

test("main caches only ACK-committed visuals, filters reactions, and keeps the GIF override dev-only", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const projectionStart = source.indexOf("displayedVisualProjection = createDisplayedVisualProjection({");
  const projectionEnd = source.indexOf("const _kimiQuotaCredentialStore", projectionStart);
  const commitBlock = source.slice(projectionStart, projectionEnd);
  const cacheWrite = commitBlock.indexOf("lastDiscordPresenceVisual = {");
  const bridgeFeed = commitBlock.indexOf("discordPresenceBridge.onVisual(");
  assert.ok(cacheWrite !== -1 && bridgeFeed !== -1 && cacheWrite < bridgeFeed,
    "a committed visual must be cached even before a bridge exists");
  assert.ok(commitBlock.includes('if (visual.source === "reaction") return;'),
    "reaction visuals must stay out of Presence");
  assert.ok(commitBlock.includes("themeId: visual.themeId"),
    "visual cache must carry the committed theme identity");

  const start = source.indexOf("function startDiscordPresence()");
  const end = source.indexOf("function syncDiscordPresence", start);
  const startBlock = source.slice(start, end);
  assert.ok(startBlock.includes("const visual = lastDiscordPresenceVisual"),
    "first enable must prefer the renderer-visible cache over state.currentSvg");
  assert.ok(startBlock.includes("visual.state, visual.svg, visual.themeId"));
  assert.ok(startBlock.includes('gifBaseUrl: app.isPackaged ? "" : process.env.CLAWD_DISCORD_GIF_BASE_URL'),
    "packaged builds must ignore the pre-merge QA override");
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

// ── Animation mirror: presence image follows the pet's state animation ──

test("mirror missing/false preserves the complete pre-mirror payload contract", () => {
  const cases = [
    [{ agentId: "claude-code", state: "working" }, "Working"],
    [{ agentId: "claude-code", state: "juggling" }, "Working"],
    [{ agentId: "claude-code", state: "idle", badge: "done", requiresCompletionAck: true }, "Idle"],
    [{ agentId: "claude-code", state: "idle", badge: "interrupted" }, "Idle"],
  ];
  const visual = clawdVisual("working", "clawd-working-building.svg");
  for (const [session, expectedState] of cases) {
    const missing = buildPresencePayload(session, {}, visual);
    const explicitOff = buildPresencePayload(session, { mirrorPetAnimation: false }, visual);
    for (const out of [missing, explicitOff]) {
      assert.strictEqual(out.state, expectedState);
      assert.strictEqual(out.assets.large_image, CLAWD_ICON_URL);
    }
    assert.deepStrictEqual(explicitOff, missing);
  }
  const withProject = buildPresencePayload(
    { agentId: "claude-code", state: "juggling", cwd: "D:\\repos\\demo" },
    { mirrorPetAnimation: false, privacyShowProject: true },
    visual
  );
  assert.strictEqual(withProject.state, "Working · demo");
  assert.strictEqual(withProject.assets.large_image, CLAWD_ICON_URL);
});

test("the animation mirror swaps a known Clawd visual only after the opt-in", () => {
  const session = { agentId: "claude-code", state: "working" };
  const visual = clawdVisual("working", "clawd-working-building.svg");
  const off = buildPresencePayload(session, {}, visual);
  assert.strictEqual(off.assets.large_image, CLAWD_ICON_URL);
  const on = buildPresencePayload(session, MIRROR_ON, visual);
  assert.match(on.assets.large_image, /clawd-building\.gif$/);
});

test("buildPresencePayload mirrors a known visual's sprite when the opt-in is on", () => {
  const img = (visual, session = null) => buildPresencePayload(session, MIRROR_ON, visual).assets.large_image;
  // idle variants keep state "idle" but swap the svg (tick.js idle rotation)
  assert.match(img(clawdVisual("idle", "clawd-idle-bubble.svg")), /clawd-bubble\.gif$/);
  assert.match(img(clawdVisual("idle", "clawd-idle-reading.svg")), /clawd-idle-reading\.gif$/);
  // session-count working tiers
  assert.match(img(clawdVisual("working", "clawd-working-building.svg")), /clawd-building\.gif$/);
  // sleep chain: dozing shows the sleeping sprite
  assert.match(img(clawdVisual("dozing", "clawd-idle-doze.svg")), /clawd-sleeping\.gif$/);
  // one-shots
  assert.match(img(clawdVisual("notification", "clawd-notification.svg")), /clawd-notification\.gif$/);
  // svgs with no gif of their own fall back to the nearest sprite
  assert.match(img(clawdVisual("dizzy", "clawd-dizzy.svg")), /clawd-idle\.gif$/);
  assert.match(img(clawdVisual("waking", "clawd-wake.svg")), /clawd-idle\.gif$/);
  // mini mode
  assert.match(img(clawdVisual("mini-working", "clawd-mini-typing.svg")), /clawd-typing\.gif$/);
  assert.match(img(clawdVisual("roam", "clawd-mini-crabwalk.svg")), /clawd-mini-crabwalk\.gif$/);
});

test("activity text stays on the legacy coarse contract while the image mirrors", () => {
  // A transient pet visual must not caption an active working session as Idle.
  const session = { agentId: "claude-code", state: "working" };
  const out = buildPresencePayload(session, MIRROR_ON, clawdVisual("mini-enter", "clawd-mini-enter.svg"));
  assert.strictEqual(out.state, "Working");
  assert.match(out.assets.large_image, /clawd-mini-enter\.gif$/);
  // Sticky done/interrupted badges may affect the fallback image but must not
  // turn into long-lived public text after the one-shot visual has returned.
  const done = buildPresencePayload({ state: "idle", badge: "done" }, MIRROR_ON, clawdVisual("idle", "clawd-idle-bubble.svg"));
  assert.strictEqual(done.state, "Idle");
  const interrupted = buildPresencePayload({ state: "idle", badge: "interrupted" }, MIRROR_ON, clawdVisual("idle", "clawd-idle-bubble.svg"));
  assert.strictEqual(interrupted.state, "Idle");
});

test("other themes and unsupported visuals fall back to the session-derived sprite", () => {
  const session = { agentId: "claude-code", state: "working" };
  const otherTheme = buildPresencePayload(session, MIRROR_ON, {
    state: "working",
    svg: "clawd-working-building.svg", // deliberate filename collision
    themeId: "custom-clawd-clone",
  });
  assert.match(otherTheme.assets.large_image, /clawd-typing\.gif$/);
  const unsupported = buildPresencePayload(session, MIRROR_ON, clawdVisual("working", "clawd-working-wizard.svg"));
  assert.match(unsupported.assets.large_image, /clawd-typing\.gif$/);
  const prototypeKey = buildPresencePayload(session, MIRROR_ON, clawdVisual("working", "constructor"));
  assert.match(prototypeKey.assets.large_image, /clawd-typing\.gif$/);
  assert.strictEqual(prototypeKey.assets.large_image.includes("function"), false);
  assert.strictEqual(otherTheme.state, "Working");
});

test("a mirrored visual renders even with no active session", () => {
  const out = buildPresencePayload(null, MIRROR_ON, clawdVisual("idle", "clawd-idle-bubble.svg"));
  assert.match(out.assets.large_image, /clawd-bubble\.gif$/);
  assert.strictEqual(out.state, "Idle");
  assert.ok(out.details); // generic agent label still present
});

test("project-name opt-in composes with the mirrored image", () => {
  const session = { agentId: "claude-code", state: "idle", cwd: "D:\\Repos\\Apps\\demo" };
  const out = buildPresencePayload(session, { privacyShowProject: true, ...MIRROR_ON }, clawdVisual("idle", "clawd-idle-reading.svg"));
  assert.strictEqual(out.state, "Idle · demo");
  assert.match(out.assets.large_image, /clawd-idle-reading\.gif$/);
});

test("onVisual publishes the mirrored sprite over the live IPC socket", async () => {
  const cfg = { enabled: true, applicationId: "111111111111111111", mirrorPetAnimation: true };
  const devGifBaseUrl = "https://example.test/pr-738/assets/discord-presence";
  const sockets = [];
  const bridge = createDiscordPresenceBridge({
    getConfig: () => cfg,
    gifBaseUrl: devGifBaseUrl,
    ipcPaths: () => ["fake-pipe"],
    createConnection: () => { const s = new FakeIpcSocket(); sockets.push(s); return s; },
  });
  bridge.start();
  sockets[0].emit("connect");
  sockets[0].emit("data", READY_FRAME);

  bridge.onVisual("idle", "clawd-idle-bubble.svg", "clawd");
  await Promise.resolve(); // the reconcile is deferred one microtask
  const activities = sockets[0].writes
    .map((b) => decodeFrames(b).frames[0])
    .filter((f) => f.op === OP.FRAME && f.data.cmd === "SET_ACTIVITY");
  assert.ok(activities.length >= 1, "onVisual should publish an activity");
  const last = activities.at(-1).data.args.activity;
  assert.strictEqual(last.assets.large_image, `${devGifBaseUrl}/clawd-bubble.gif`);
  assert.strictEqual(last.state, "Idle");

  bridge.stop();
});

test("a same-tick visual+snapshot update never pairs the new visual with the previous session", async () => {
  // Session updates fire state-change (-> onVisual) BEFORE emitSessionSnapshot
  // (-> onSnapshot). A leading-edge send from onVisual used to publish the new
  // animation with the PREVIOUS agent/project; the deferred reconcile must let
  // the same-tick snapshot land first.
  const cfg = { enabled: true, applicationId: "111111111111111111", privacyShowProject: true, mirrorPetAnimation: true };
  const sockets = [];
  const bridge = createDiscordPresenceBridge({
    getConfig: () => cfg,
    ipcPaths: () => ["fake-pipe"],
    createConnection: () => { const s = new FakeIpcSocket(); sockets.push(s); return s; },
  });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    bridge.start();
    sockets[0].emit("connect");
    sockets[0].emit("data", READY_FRAME);
    bridge.onSnapshot({ sessions: [
      { id: "a", agentId: "codex", agentName: "Codex", state: "working", cwd: "D:\\Repos\\old-project" },
    ] });
    await Promise.resolve();

    now += 5000; // past MIN_SEND_INTERVAL_MS: the next publish sends leading-edge
    // The new visual's sprite must differ from the already-published payload,
    // or the wrong pairing dedupes into a no-op and the race is invisible.
    bridge.onVisual("thinking", "clawd-working-thinking.svg", "clawd");
    bridge.onSnapshot({ sessions: [
      { id: "b", agentId: "claude-code", agentName: "Claude Code", state: "thinking", cwd: "D:\\Repos\\new-project" },
    ] });
    await Promise.resolve();

    const activities = sockets[0].writes
      .map((b) => decodeFrames(b).frames[0])
      .filter((f) => f.op === OP.FRAME && f.data.cmd === "SET_ACTIVITY")
      .map((f) => f.data.args.activity);
    for (const a of activities.slice(1)) {
      assert.strictEqual(a.details, "Claude Code", "new visual must never ride with the old session");
      assert.match(a.state, /new-project/);
    }
    const last = activities.at(-1);
    assert.match(last.assets.large_image, /clawd-thinking\.gif$/);
  } finally {
    Date.now = realNow;
    bridge.stop();
  }
});

test("a same-tick snapshot+visual completion never sends the new badge with the old sprite", async () => {
  // promoteCompletion() intentionally broadcasts the done snapshot BEFORE its
  // attention visual. Snapshot reconciliation must therefore be deferred by
  // the same microtask barrier as visual reconciliation.
  const cfg = { enabled: true, applicationId: "111111111111111111", mirrorPetAnimation: true };
  const sockets = [];
  const bridge = createDiscordPresenceBridge({
    getConfig: () => cfg,
    ipcPaths: () => ["fake-pipe"],
    createConnection: () => { const s = new FakeIpcSocket(); sockets.push(s); return s; },
  });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    bridge.start();
    sockets[0].emit("connect");
    sockets[0].emit("data", READY_FRAME);
    bridge.onVisual("working", "clawd-working-typing.svg", "clawd");
    bridge.onSnapshot({ sessions: [{ id: "a", agentId: "codex", state: "working" }] });
    await Promise.resolve();

    now += 5000; // make a stale leading-edge pairing observable
    bridge.onSnapshot({ sessions: [{
      id: "a",
      agentId: "codex",
      state: "idle",
      badge: "done",
      requiresCompletionAck: true,
    }] });
    bridge.onVisual("attention", "clawd-happy.svg", "clawd");
    await Promise.resolve();

    const activities = sockets[0].writes
      .map((b) => decodeFrames(b).frames[0])
      .filter((f) => f.op === OP.FRAME && f.data.cmd === "SET_ACTIVITY")
      .map((f) => f.data.args.activity);
    for (const activity of activities.slice(1)) {
      assert.strictEqual(activity.state, "Idle");
      assert.match(activity.assets.large_image, /clawd-happy\.gif$/);
    }
  } finally {
    Date.now = realNow;
    bridge.stop();
  }
});

test("a standalone visual change (idle rotation, no trailing snapshot) still publishes", async () => {
  const cfg = { enabled: true, applicationId: "111111111111111111", mirrorPetAnimation: true };
  const sockets = [];
  const bridge = createDiscordPresenceBridge({
    getConfig: () => cfg,
    ipcPaths: () => ["fake-pipe"],
    createConnection: () => { const s = new FakeIpcSocket(); sockets.push(s); return s; },
  });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    bridge.start();
    sockets[0].emit("connect");
    sockets[0].emit("data", READY_FRAME);
    bridge.onSnapshot({ sessions: [] });
    await Promise.resolve();

    now += 5000;
    bridge.onVisual("idle", "clawd-idle-reading.svg", "clawd"); // tick.js rotation: no snapshot follows
    await Promise.resolve();

    const activities = sockets[0].writes
      .map((b) => decodeFrames(b).frames[0])
      .filter((f) => f.op === OP.FRAME && f.data.cmd === "SET_ACTIVITY");
    const last = activities.at(-1).data.args.activity;
    assert.match(last.assets.large_image, /clawd-idle-reading\.gif$/);
  } finally {
    Date.now = realNow;
    bridge.stop();
  }
});

test("rapid mirror updates leave headroom instead of sending again at four seconds", async () => {
  const cfg = { enabled: true, applicationId: "111111111111111111", mirrorPetAnimation: true };
  const sockets = [];
  const bridge = createDiscordPresenceBridge({
    getConfig: () => cfg,
    ipcPaths: () => ["fake-pipe"],
    createConnection: () => { const s = new FakeIpcSocket(); sockets.push(s); return s; },
  });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    bridge.start();
    sockets[0].emit("connect");
    sockets[0].emit("data", READY_FRAME);
    bridge.onVisual("working", "clawd-working-typing.svg", "clawd");
    bridge.onSnapshot({ sessions: [{ id: "a", agentId: "codex", state: "working" }] });
    await Promise.resolve();

    const countActivities = () => sockets[0].writes
      .map((b) => decodeFrames(b).frames[0])
      .filter((f) => f.op === OP.FRAME && f.data.cmd === "SET_ACTIVITY").length;
    assert.strictEqual(countActivities(), 1);

    now += 4000;
    bridge.onVisual("thinking", "clawd-working-thinking.svg", "clawd");
    bridge.onSnapshot({ sessions: [{ id: "a", agentId: "codex", state: "thinking" }] });
    await Promise.resolve();
    assert.strictEqual(countActivities(), 1, "four seconds must remain inside the coalescing window");
  } finally {
    Date.now = realNow;
    bridge.stop();
  }
});

// ── Manifest consistency: runtime targets, generator FILES, committed assets ──

test("runtime GIF targets, the generator manifest, and committed assets stay in sync", () => {
  const runtime = new Set([...Object.values(STATE_GIF), ...Object.values(SVG_GIF)]);

  const generatorSource = fs.readFileSync(
    path.join(__dirname, "..", "tools", "build-discord-presence-gifs.py"), "utf8");
  const filesBlock = generatorSource.match(/FILES = \[([\s\S]*?)\]/);
  assert.ok(filesBlock, "generator should declare a FILES manifest");
  const generated = new Set(Array.from(filesBlock[1].matchAll(/"([^"]+\.gif)"/g), (m) => m[1]));

  const committed = new Set(
    fs.readdirSync(path.join(__dirname, "..", "assets", "discord-presence"))
      .filter((f) => f.endsWith(".gif")));

  assert.deepStrictEqual([...runtime].sort(), [...generated].sort(),
    "every runtime GIF must be produced by the generator, and the generator must not build dead sprites");
  assert.deepStrictEqual([...generated].sort(), [...committed].sort(),
    "committed assets must match the generator manifest exactly (no missing or orphaned GIFs)");
});
