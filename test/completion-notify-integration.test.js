"use strict";

// #406 integration: drive state.js's completion gate end-to-end into the
// Telegram companion via the real session-snapshot fanout. Locks the third
// completion surface (the Telegram push) so the held -> promote flow can't
// silently regress: a held Stop must not push, promote must push exactly once,
// and live background work must never push.

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const themeLoader = require("../src/theme-loader");
const { createTelegramCompanion } = require("../src/telegram-companion");

themeLoader.init(path.join(__dirname, "..", "src"));
const theme = themeLoader.loadTheme("clawd");

// onSnapshot fires the send fire-and-forget on a microtask chain; flush it.
function flush() { return new Promise((resolve) => setImmediate(resolve)); }

function makeCtx(overrides = {}) {
  return {
    lang: "en",
    theme,
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
    processKill: () => true,
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    ...overrides,
  };
}

function stop(api, id, opts = {}) {
  api.updateSession(id, "attention", "Stop", { agentId: "claude-code", ...opts });
}

describe("#406 state -> Telegram completion integration", () => {
  let api;
  let sent;
  let savedDebounceEnv;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    // Debounce is opt-in (default 0); these end-to-end cases exercise the
    // held -> promote flow, so turn it on explicitly.
    savedDebounceEnv = process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    process.env.CLAWD_COMPLETION_DEBOUNCE_MS = "1000";
    sent = [];
    const companion = createTelegramCompanion({
      getClient: () => ({
        sendNotification: async (text) => { sent.push(text); return { ok: true }; },
      }),
      isEnabled: () => true,
      getNotifyOnComplete: () => true,
    });
    companion.onSnapshot({ sessions: [] }); // prime dedupe (no backlog re-ping)
    api = require("../src/state")(makeCtx({
      broadcastSessionSnapshot: (snapshot) => companion.onSnapshot(snapshot),
    }));
  });
  afterEach(() => {
    api.cleanup();
    mock.timers.reset();
    if (savedDebounceEnv === undefined) delete process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    else process.env.CLAWD_COMPLETION_DEBOUNCE_MS = savedDebounceEnv;
  });

  it("a debounced Claude Stop pushes exactly one completion — after the window, not during the hold", async () => {
    stop(api, "s1", { assistantLastOutput: "All done." });
    await flush();
    assert.strictEqual(sent.length, 0, "a held Stop must not push while debouncing");
    mock.timers.tick(1000); // window elapses -> promote replays the real Stop
    await flush();
    assert.strictEqual(sent.length, 1, "promote pushes exactly one completion");
  });

  it("live background_tasks suppress the completion push entirely", async () => {
    stop(api, "s1", { backgroundTasksCount: 1 });
    await flush();
    mock.timers.tick(5000);
    await flush();
    assert.strictEqual(sent.length, 0, "background work pending -> no premature completion push");
  });

  it("Stop then Notification within the window still pushes exactly one completion", async () => {
    stop(api, "s1", { assistantLastOutput: "Done." });
    mock.timers.tick(400);
    api.updateSession("s1", "notification", "Notification", { agentId: "claude-code" });
    await flush();
    assert.strictEqual(sent.length, 0, "no completion during the hold / notification");
    mock.timers.tick(1000);
    await flush();
    assert.strictEqual(sent.length, 1, "the Notification does not bury the completion; exactly one push");
  });
});
