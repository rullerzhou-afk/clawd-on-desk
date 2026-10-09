// test/state-source-pid-merge.test.js — #681 Slice A1, server-side contract.
//
// #681 lets the shared resolver report "nothing" when Clawd is offline or the
// snapshot failed. Six adapters assign `body.source_pid = stablePid`
// unconditionally, so they now put a literal `null` on the wire rather than
// omitting the field. Deliberately NOT fixed in those adapters — reordering all
// 13 is out of scope, and it only stays safe because of the two properties
// asserted here:
//
//   1. src/server-route-state.js normalizes an explicit null identically to an
//      absent field (Number.isFinite(null) === false).
//   2. src/state.js MERGES rather than clobbers: a session that already knows
//      its terminal PID keeps it when a later event carries none.
//
// If either regressed, a single offline hook event would erase a live session's
// terminal PID and silently break click-to-focus for the rest of that session.
// Both are exercised against the real modules, not a copy of the expression.

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const { handleStatePost } = require("../src/server-route-state");

// ═══════════════════════════════════════════════════════════════════════════
// 1. Route normalization: null ≡ absent
// ═══════════════════════════════════════════════════════════════════════════

function makeReq(body) {
  const req = new EventEmitter();
  setImmediate(() => {
    if (body != null) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function makeRes() {
  return {
    statusCode: null, headers: {}, body: "",
    writeHead(code, headers) { this.statusCode = code; if (headers) this.headers = headers; },
    end(data) { if (data) this.body += String(data); if (this.resolve) this.resolve(this); },
  };
}

function postState(body) {
  return new Promise((resolve) => {
    const res = makeRes();
    res.resolve = resolve;
    const updates = [];
    handleStatePost(makeReq(JSON.stringify(body)), res, {
      ctx: {
        STATE_SVGS: { idle: "x.svg", working: "x.svg", attention: "x.svg", "mini-idle": "x.svg" },
        pendingPermissions: [],
        sessions: new Map(),
        isAgentEnabled: () => true,
        setState: () => {},
        updateSession: (...args) => updates.push(args),
        resolvePermissionEntry: () => {},
      },
      createRequestHookRecorder: () => ({ acceptedUnlessDnd: () => {}, droppedByDisabled: () => {} }),
      shouldDropForDnd: () => false,
      codexOfficialTurns: new Map(),
    });
    res.updates = updates;
  });
}

describe("#681 — /state normalizes an explicit source_pid:null exactly like an absent field", () => {
  const base = { state: "working", session_id: "s-681", event: "PreToolUse", agent_id: "claude-code" };

  it("source_pid: null ⇒ updateSession receives sourcePid null", async () => {
    const res = await postState({ ...base, source_pid: null });
    assert.strictEqual(res.updates.length, 1);
    assert.strictEqual(res.updates[0][3].sourcePid, null);
  });

  it("omitted source_pid ⇒ the same null — this equivalence is what lets the 6 unguarded adapters stay unguarded", async () => {
    const withNull = await postState({ ...base, source_pid: null });
    const omitted = await postState({ ...base });
    assert.strictEqual(omitted.updates[0][3].sourcePid, withNull.updates[0][3].sourcePid);
    assert.strictEqual(omitted.updates[0][3].sourcePid, null);
  });

  it("a real pid still arrives intact", async () => {
    const res = await postState({ ...base, source_pid: 1234 });
    assert.strictEqual(res.updates[0][3].sourcePid, 1234);
  });

  it("junk source_pid is rejected rather than forwarded", async () => {
    for (const junk of [0, -5, "1234", true, {}, [], NaN, Infinity]) {
      const res = await postState({ ...base, source_pid: junk });
      assert.strictEqual(res.updates[0][3].sourcePid, null, `${JSON.stringify(junk)} must not become a pid`);
    }
  });

  it("a fractional pid is floored, not rejected (documenting existing behavior)", async () => {
    // Number.isFinite(1.5) is true, so the route floors it. Not a #681 concern —
    // no resolver can produce a fractional pid — but pinned so a future reader
    // does not mistake this for the null-handling above.
    const res = await postState({ ...base, source_pid: 1234.7 });
    assert.strictEqual(res.updates[0][3].sourcePid, 1234);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. State merge: a known sourcePid survives a metadata-less event
// ═══════════════════════════════════════════════════════════════════════════

const path = require("node:path");
const themeLoader = require("../src/theme-loader");
themeLoader.init(path.join(__dirname, "..", "src"));
const _defaultTheme = themeLoader.loadTheme("clawd");

function makeCtx() {
  return {
    lang: "en",
    theme: _defaultTheme,
    doNotDisturb: false,
    miniTransitioning: false,
    miniMode: false,
    mouseOverPet: false,
    idlePaused: false,
    forceEyeResend: false,
    eyePauseUntil: 0,
    mouseStillSince: Date.now(),
    miniSleepPeeked: false,
    playSound: () => {},
    sendToRenderer: () => {},
    syncHitWin: () => {},
    sendToHitWin: () => {},
    miniPeekIn: () => {},
    miniPeekOut: () => {},
    buildContextMenu: () => {},
    buildTrayMenu: () => {},
    pendingPermissions: [],
    resolvePermissionEntry: () => {},
    dismissPermissionsForDnd: () => {},
    focusTerminalWindow: () => {},
    focusHostPlatform: "darwin",
    // The merge under test must hold regardless of liveness, so keep every pid
    // "alive" here — a dead-pid sweep would confound what this file is asserting.
    processKill: () => {},
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    isAgentEnabled: () => true,
  };
}

describe("#681 — an already-known sourcePid survives a later source_pid:null", () => {
  let api;
  beforeEach(() => { api = require("../src/state")(makeCtx()); });
  afterEach(() => { api.cleanup(); });

  const sessionFor = (sid) => api.sessions.get(sid);

  it("SessionStart establishes 1234; an offline PreToolUse must NOT erase it", () => {
    // The exact #681 sequence: Clawd is up when the session starts, the user
    // quits Clawd (or a snapshot fails), and the next hook event ships nothing.
    api.updateSession("s-681", "idle", "SessionStart", { sourcePid: 1234, agentId: "claude-code", cwd: "D:/repo" });
    assert.strictEqual(sessionFor("s-681").sourcePid, 1234, "precondition");

    api.updateSession("s-681", "working", "PreToolUse", { sourcePid: null, agentId: "claude-code", cwd: "D:/repo" });
    assert.strictEqual(sessionFor("s-681").sourcePid, 1234,
      "a metadata-less event must MERGE, not clobber — otherwise click-to-focus dies for the rest of the session");
  });

  it("an omitted sourcePid behaves identically to an explicit null", () => {
    api.updateSession("s-681-b", "idle", "SessionStart", { sourcePid: 1234, agentId: "claude-code" });
    api.updateSession("s-681-b", "working", "PreToolUse", { agentId: "claude-code" });
    assert.strictEqual(sessionFor("s-681-b").sourcePid, 1234);
  });

  it("repeated metadata-less events never erode it", () => {
    api.updateSession("s-681-c", "idle", "SessionStart", { sourcePid: 1234, agentId: "claude-code" });
    for (let i = 0; i < 20; i++) {
      api.updateSession("s-681-c", "working", "PostToolUse", { sourcePid: null, agentId: "claude-code" });
    }
    assert.strictEqual(sessionFor("s-681-c").sourcePid, 1234);
  });

  it("a REAL later pid still wins — merge must not freeze the first value forever", () => {
    // Guard against over-correcting: a session that legitimately moves terminals
    // (or whose first walk was wrong) must still be updatable.
    api.updateSession("s-681-d", "idle", "SessionStart", { sourcePid: 1234, agentId: "claude-code" });
    api.updateSession("s-681-d", "working", "PreToolUse", { sourcePid: 5678, agentId: "claude-code" });
    assert.strictEqual(sessionFor("s-681-d").sourcePid, 5678);
  });

  it("a session that never had one stays null rather than inventing a pid", () => {
    api.updateSession("s-681-e", "working", "PreToolUse", { sourcePid: null, agentId: "claude-code" });
    assert.strictEqual(sessionFor("s-681-e").sourcePid, null);
  });
});
