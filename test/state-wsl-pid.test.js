"use strict";

// State-layer reproduction for WSL sessions carrying Linux PIDs. These tests
// call updateSession directly, so they never exercise the route's WSL entry
// stripping; they prove the cleanup-side guard in getStaleSessionDecision that
// keeps an already-stored WSL PID from being probed. Entry stripping is covered
// by the server-route-state / server-route-permission WSL cases.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
themeLoader.init(path.join(__dirname, "..", "src"));
const defaultTheme = themeLoader.loadTheme("clawd");
const { createTranslator } = require("../src/i18n");

function makeCtx(overrides = {}) {
  const ctx = {
    lang: "en",
    theme: defaultTheme,
    doNotDisturb: false,
    miniTransitioning: false,
    miniMode: false,
    pendingPermissions: [],
    playSound: () => {},
    sendToRenderer: () => {},
    syncHitWin: () => {},
    sendToHitWin: () => {},
    processKill: () => { const e = new Error("ESRCH"); e.code = "ESRCH"; throw e; },
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    ...overrides,
  };
  ctx.t = createTranslator(() => ctx.lang);
  return ctx;
}

function makePidKill(alivePids) {
  return (pid) => {
    if (alivePids.has(pid)) return true;
    const e = new Error("ESRCH");
    e.code = "ESRCH";
    throw e;
  };
}

function updateSession(api, overrides = {}) {
  api.updateSession(
    overrides.id || "s1",
    overrides.state || "working",
    overrides.event || "PreToolUse",
    {
      sourcePid: overrides.sourcePid ?? null,
      agentPid: overrides.agentPid ?? null,
      agentId: overrides.agentId || "claude-code",
      host: overrides.host ?? null,
      wslDistro: overrides.wslDistro ?? null,
      cwd: overrides.cwd || "/home/user/repo",
      profileId: "local",
      rawSessionId: overrides.rawSessionId,
      headless: false,
    }
  );
}

describe("WSL session PID cleanup", () => {
  let api;

  afterEach(() => { if (api) api.cleanup(); });

  it("keeps a just-updated WSL Claude session when the source PID aliases a live Windows process", () => {
    // sourcePid aliases a local process (probe alive), agentPid is a Linux PID
    // with no local match (probe dead). Before the fix the session was stored
    // with pidReachable=true and deleted as `agent-exit` on the next sweep.
    api = require("../src/state")(makeCtx({ processKill: makePidKill(new Set([2000])) }));
    updateSession(api, {
      id: "wsl-r1",
      state: "working",
      event: "PreToolUse",
      agentId: "claude-code",
      host: "wsl:Ubuntu",
      wslDistro: "Ubuntu",
      sourcePid: 2000,
      agentPid: 1000,
    });

    assert.strictEqual(api.sessions.has("wsl-r1"), true);
    // Intentional precondition: state.js still resolves reachability from the
    // PIDs it is handed directly, so the stored session stays pidReachable=true.
    // The assertion after the sweep proves the *cleanup decision* is what keeps
    // the session, not that the HTTP entry path behaved differently.
    assert.strictEqual(api.sessions.get("wsl-r1").pidReachable, true);

    api.cleanStaleSessions();

    assert.strictEqual(api.sessions.has("wsl-r1"), true, "WSL session must survive the sweep");
  });

  it("retires an idle WSL Kimi session by idle age even when the agent PID aliases a live Windows process", () => {
    // agentPid aliases a long-lived local process (probe alive), sourcePid has
    // no local match (probe dead). Before the fix the live alias kept the dead
    // WSL session forever; after the fix it deletes as `unreachable` once the
    // idle timeout elapses.
    api = require("../src/state")(makeCtx({ processKill: makePidKill(new Set([1000])) }));
    updateSession(api, {
      id: "wsl-r2",
      state: "idle",
      event: "UserPromptSubmit",
      agentId: "kimi-cli",
      host: "wsl:Ubuntu",
      wslDistro: "Ubuntu",
      sourcePid: 2000,
      agentPid: 1000,
    });

    const session = api.sessions.get("wsl-r2");
    assert.strictEqual(session.pidReachable, true);
    session.updatedAt = Date.now() - 700000;

    api.cleanStaleSessions();

    assert.strictEqual(api.sessions.has("wsl-r2"), false);
  });

  it("keeps the local control group unchanged: a dead agent PID still deletes the session", () => {
    api = require("../src/state")(makeCtx({ processKill: makePidKill(new Set([2000])) }));
    updateSession(api, {
      id: "local-control",
      state: "working",
      event: "PreToolUse",
      agentId: "claude-code",
      host: null,
      wslDistro: null,
      sourcePid: 2000,
      agentPid: 1000,
    });

    api.cleanStaleSessions();

    assert.strictEqual(api.sessions.has("local-control"), false);
  });
});
