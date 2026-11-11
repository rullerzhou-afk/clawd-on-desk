"use strict";

// Native OS toasts for agent lifecycle events.
//
// Two layers are covered here:
//   - the presenter in isolation (fake Electron Notification), for platform
//     gating, switches, dedupe, privacy and click routing; and
//   - the real state.js snapshot fanout feeding it, so "task finished" keeps
//     meaning what the session state machine says it means.
// Neither layer proves that Windows actually draws a toast. That is checked
// by hand on a real desktop.

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { EventEmitter } = require("events");
const themeLoader = require("../src/theme-loader");
const {
  createSystemNotifications,
  isSystemNotificationPlatform,
  formatCompletionMessage,
  formatAttentionMessage,
  safeLabel,
  DUPLICATE_COMPLETION_WINDOW_MS,
  ATTENTION_COALESCE_MS,
  ATTENTION_SWEEP_MS,
  RETENTION_MS,
} = require("../src/system-notifications");

themeLoader.init(path.join(__dirname, "..", "src"));
const theme = themeLoader.loadTheme("clawd");

function makeHarness(overrides = {}) {
  const instances = [];
  class FakeNotification extends EventEmitter {
    static isSupported() { return FakeNotification.supported; }
    constructor(options) {
      super();
      this.options = options;
      this.closed = false;
      this.shown = false;
      instances.push(this);
    }
    show() {
      this.shown = true;
      if (FakeNotification.autoShow) this.emit("show");
    }
    close() { this.closed = true; }
  }
  FakeNotification.supported = true;
  FakeNotification.autoShow = true;

  const settings = { enabled: true, onDone: true, onError: true, onPermission: true };
  const state = { suppressed: false, time: 1_000_000, lang: "en" };
  const focusCalls = [];
  const dashboardCalls = [];
  const balloons = [];
  const logs = [];
  const timers = [];
  const options = {
    Notification: FakeNotification,
    platform: "win32",
    trayBalloonOwner: { show: (tray, payload) => { balloons.push({ tray, payload }); return true; } },
    getTray: () => "tray",
    getSettings: () => settings,
    isSuppressed: () => state.suppressed,
    getLang: () => state.lang,
    focusSession: (sessionId, opts) => { focusCalls.push({ sessionId, opts }); return true; },
    openDashboard: () => { dashboardCalls.push(true); },
    log: (message) => logs.push(message),
    now: () => state.time,
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
    ...overrides,
  };
  const notifier = createSystemNotifications(options);
  return {
    notifier, FakeNotification, instances, settings, state,
    focusCalls, dashboardCalls, balloons, logs, timers,
  };
}

let eventClock = 5000;
function entry(id, overrides = {}) {
  eventClock += 1;
  return {
    id,
    agentId: "claude-code",
    agentName: "Claude Code",
    state: "idle",
    badge: "done",
    cwd: `C:\\work\\${id}-project`,
    headless: false,
    lastEvent: { rawEvent: "Stop", at: eventClock },
    ...overrides,
  };
}
function working(id, overrides = {}) {
  return entry(id, {
    state: "working",
    badge: "running",
    lastEvent: { rawEvent: "PreToolUse", at: ++eventClock },
    ...overrides,
  });
}
function failed(id, rawEvent = "StopFailure", overrides = {}) {
  return entry(id, { badge: "interrupted", lastEvent: { rawEvent, at: ++eventClock }, ...overrides });
}
function snap(...sessions) { return { sessions }; }
function flush() { return new Promise((resolve) => setImmediate(resolve)); }

describe("system notifications: platform gate", () => {
  it("is a Windows feature and inert everywhere else", async () => {
    assert.equal(isSystemNotificationPlatform("win32"), true);
    for (const platform of ["darwin", "linux", "freebsd"]) {
      assert.equal(isSystemNotificationPlatform(platform), false, platform);
      const h = makeHarness({ platform });
      assert.equal(h.notifier.isSupported(), false);
      h.notifier.prime(snap());
      h.notifier.onSnapshot(snap(entry("a")));
      assert.equal(h.notifier.notifyAttention({ kind: "approval", sessionId: "a" }), false);
      assert.equal(await h.notifier.test(), false);
      assert.equal(h.instances.length, 0, `${platform} must never construct a Notification`);
      assert.equal(h.balloons.length, 0);
      h.notifier.dispose();
    }
  });

  it("does not throw when Electron's Notification is missing entirely", async () => {
    const h = makeHarness({ Notification: undefined, trayBalloonOwner: null });
    h.notifier.prime(snap());
    assert.doesNotThrow(() => h.notifier.onSnapshot(snap(entry("a"))));
    assert.equal(await h.notifier.test(), false);
  });

  it("falls back to the tray balloon when toasts are unsupported", async () => {
    const h = makeHarness();
    h.FakeNotification.supported = false;
    assert.equal(await h.notifier.test(), true);
    assert.equal(h.instances.length, 0);
    assert.equal(h.balloons.length, 1);
    assert.equal(h.balloons[0].payload.title, "Clawd on Desk");
    h.balloons[0].payload.onClick();
    assert.equal(h.dashboardCalls.length, 1);
  });
});

describe("system notifications: completion toasts off the snapshot fanout", () => {
  it("notifies a finished task with agent, project and status only", () => {
    const h = makeHarness();
    h.notifier.prime(snap());
    h.notifier.onSnapshot(snap(working("s1")));
    assert.equal(h.instances.length, 0);

    h.notifier.onSnapshot(snap(entry("s1", {
      displayTitle: "please deploy with token sk-ant-abcdefghijklmnop",
      assistantLastOutput: "Here is the full answer the model wrote.",
    })));
    assert.equal(h.instances.length, 1);
    const { options } = h.instances[0];
    assert.equal(options.title, "Claude Code · s1-project");
    assert.equal(options.body, "Task completed");
    assert.equal(options.silent, true, "Clawd plays its own sounds; the OS chime would double up");
    assert.deepEqual(Object.keys(options).sort(), ["body", "silent", "title"]);
    const rendered = JSON.stringify(options);
    assert.doesNotMatch(rendered, /deploy|sk-ant|full answer|C:\\\\work/);
  });

  it("marks failed and interrupted tasks as such, with the error class only", () => {
    const h = makeHarness();
    h.notifier.prime(snap());
    h.notifier.onSnapshot(snap(failed("s1", "StopFailure"), failed("s2", "ApiError")));
    assert.equal(h.instances.length, 2);
    assert.equal(h.instances[0].options.body, "Task failed or was interrupted");
    assert.equal(h.instances[1].options.body, "Stopped by an API error");
  });

  it("uses the active language", () => {
    const h = makeHarness();
    h.state.lang = "zh";
    h.notifier.prime(snap());
    h.notifier.onSnapshot(snap(entry("s1")));
    assert.equal(h.instances[0].options.body, "任务已完成");
    assert.equal(formatCompletionMessage(failed("s1"), "zh").body, "任务失败或异常中断");
    assert.equal(formatCompletionMessage(entry("s1"), "xx").body, "Task completed", "unknown language falls back to en");
  });

  it("does not repeat the same completion across later snapshots", () => {
    const h = makeHarness();
    h.notifier.prime(snap());
    const done = entry("s1");
    h.notifier.onSnapshot(snap(done));
    h.notifier.onSnapshot(snap(done));
    h.notifier.onSnapshot(snap({ ...done, hiddenFromHud: true }));
    assert.equal(h.instances.length, 1);
  });

  it("treats a repeated Stop from a session that never resumed work as a duplicate hook", () => {
    const h = makeHarness();
    h.notifier.prime(snap());
    h.notifier.onSnapshot(snap(entry("s1")));
    h.state.time += 500;
    h.notifier.onSnapshot(snap(entry("s1"))); // new lastEvent.at, same turn
    assert.equal(h.instances.length, 1, "duplicate Stop delivery must not toast twice");

    // A real second turn: the session works again, then finishes again.
    h.notifier.onSnapshot(snap(working("s1")));
    h.notifier.onSnapshot(snap(entry("s1")));
    assert.equal(h.instances.length, 2);

    // Far outside the duplicate window a repeated terminal event is reported.
    h.state.time += DUPLICATE_COMPLETION_WINDOW_MS + 1;
    h.notifier.onSnapshot(snap(entry("s1")));
    assert.equal(h.instances.length, 3);
  });

  it("still reports a failure that follows a completion", () => {
    const h = makeHarness();
    h.notifier.prime(snap());
    h.notifier.onSnapshot(snap(entry("s1")));
    h.notifier.onSnapshot(snap(failed("s1", "ApiError")));
    assert.equal(h.instances.length, 2);
    assert.equal(h.instances[0].closed, true, "the superseded toast for the session is withdrawn");
  });

  it("keeps parallel sessions independent", () => {
    const h = makeHarness();
    h.notifier.prime(snap());
    h.notifier.onSnapshot(snap(working("a"), working("b", { agentId: "codex", agentName: "Codex" }), working("c")));
    h.notifier.onSnapshot(snap(entry("a"), working("b", { agentId: "codex", agentName: "Codex" }), working("c")));
    assert.deepEqual(h.instances.map((n) => n.options.title), ["Claude Code · a-project"]);

    const doneA = entry("a");
    h.notifier.onSnapshot(snap(
      doneA,
      entry("b", { agentId: "codex", agentName: "Codex", lastEvent: { rawEvent: "event_msg:task_complete", at: ++eventClock } }),
      working("c"),
    ));
    assert.deepEqual(h.instances.map((n) => n.options.title), ["Claude Code · a-project", "Codex · b-project"]);
    assert.equal(h.instances[0].closed, false, "another session finishing must not touch this session's toast");

    h.instances[1].emit("click");
    h.instances[0].emit("click");
    assert.deepEqual(h.focusCalls.map((call) => call.sessionId), ["b", "a"]);
  });

  it("honors the master switch and each event switch, without backfilling later", () => {
    const h = makeHarness();
    h.notifier.prime(snap());

    h.settings.enabled = false;
    h.notifier.onSnapshot(snap(entry("a"), failed("b")));
    assert.equal(h.instances.length, 0, "master switch off");

    h.settings.enabled = true;
    h.notifier.onSnapshot(snap(entry("a", { lastEvent: { rawEvent: "Stop", at: 1 } })));
    assert.equal(h.instances.length, 1, "a new event after re-enabling is delivered");
    const before = h.instances.length;

    h.settings.onDone = false;
    h.notifier.onSnapshot(snap(working("a"), working("b")));
    h.notifier.onSnapshot(snap(entry("a"), failed("b")));
    assert.deepEqual(h.instances.slice(before).map((n) => n.options.body), ["Task failed or was interrupted"]);

    h.settings.onDone = true;
    h.settings.onError = false;
    h.notifier.onSnapshot(snap(working("a"), working("b")));
    h.notifier.onSnapshot(snap(entry("a"), failed("b")));
    assert.deepEqual(h.instances.slice(before + 1).map((n) => n.options.body), ["Task completed"]);
  });

  it("does not replay completions that happened while disabled", () => {
    const h = makeHarness();
    h.notifier.prime(snap());
    h.settings.enabled = false;
    const done = entry("a");
    h.notifier.onSnapshot(snap(done));
    h.settings.enabled = true;
    h.notifier.onSnapshot(snap(done));
    assert.equal(h.instances.length, 0);
  });

  it("stays quiet during Clawd's Do Not Disturb and does not catch up afterwards", () => {
    const h = makeHarness();
    h.notifier.prime(snap());
    h.state.suppressed = true;
    const done = entry("a");
    h.notifier.onSnapshot(snap(done));
    assert.equal(h.notifier.notifyAttention({ kind: "approval", sessionId: "a" }), false);
    h.state.suppressed = false;
    h.notifier.onSnapshot(snap(done));
    assert.equal(h.instances.length, 0);
  });

  it("primes on the first snapshot so enabling the app mid-flight has no backlog", () => {
    const h = makeHarness();
    h.notifier.onSnapshot(snap(entry("old")));
    assert.equal(h.instances.length, 0, "first snapshot is history");
    h.notifier.onSnapshot(snap(entry("old", { lastEvent: { rawEvent: "Stop", at: 2 } }), working("new")));
    assert.equal(h.instances.length, 1);
  });

  it("after a restart, recovered completions are history but the next one is delivered", () => {
    const h = makeHarness();
    const recovered = entry("s1", { startupRecovered: true });
    h.notifier.prime(snap(recovered));
    h.notifier.onSnapshot(snap(recovered));
    assert.equal(h.instances.length, 0, "a completion from before the restart is not replayed");
    h.notifier.onSnapshot(snap(working("s1")));
    h.notifier.onSnapshot(snap(entry("s1")));
    assert.equal(h.instances.length, 1, "the first completion after the restart is not swallowed");
  });

  it("ignores headless sessions (subagents and background runs)", () => {
    const h = makeHarness();
    h.notifier.prime(snap());
    h.notifier.onSnapshot(snap(entry("child", { headless: true })));
    assert.equal(h.instances.length, 0);
  });

  it("waits for running subagents before calling the main task finished", () => {
    const h = makeHarness();
    h.notifier.prime(snap());
    const parentStop = entry("parent", { agentId: "codex", agentName: "Codex", activeSubagentCount: 2 });
    h.notifier.onSnapshot(snap(parentStop));
    h.notifier.onSnapshot(snap({ ...parentStop, activeSubagentCount: 1 }));
    assert.equal(h.instances.length, 0, "children still running: the main task is not done");
    h.notifier.onSnapshot(snap({ ...parentStop, activeSubagentCount: 0 }));
    assert.equal(h.instances.length, 1, "released once, when the last child ends");
    h.notifier.onSnapshot(snap({ ...parentStop, activeSubagentCount: 0 }));
    assert.equal(h.instances.length, 1);
  });

  it("drops a held completion when the parent goes back to work", () => {
    const h = makeHarness();
    h.notifier.prime(snap());
    h.notifier.onSnapshot(snap(entry("parent", { activeSubagentCount: 1 })));
    h.notifier.onSnapshot(snap(working("parent")));
    assert.equal(h.instances.length, 0);
  });

  it("only counts terminal events as completion", () => {
    const h = makeHarness();
    h.notifier.prime(snap());
    h.notifier.onSnapshot(snap(
      entry("a", { badge: "done", lastEvent: { rawEvent: "SubagentStop", at: ++eventClock } }),
      entry("b", { badge: "interrupted", lastEvent: { rawEvent: "PostToolUseFailure", at: ++eventClock } }),
      entry("c", { badge: "idle", lastEvent: { rawEvent: "Stop", at: ++eventClock } }),
    ));
    assert.equal(h.instances.length, 0);
  });

  it("never throws into the snapshot broadcast", () => {
    const h = makeHarness({
      getSettings: () => { throw new Error("settings exploded"); },
      getLang: () => { throw new Error("lang exploded"); },
    });
    assert.doesNotThrow(() => {
      h.notifier.onSnapshot(null);
      h.notifier.onSnapshot({ sessions: [null, {}, { id: "x" }] });
      h.notifier.prime(undefined);
    });
    assert.equal(h.instances.length, 0, "unreadable settings mean off");
  });
});

describe("system notifications: content safety", () => {
  it("redacts and bounds every externally sourced label", () => {
    assert.equal(safeLabel("line one\nline\ttwo\u0007"), "line one line two");
    assert.match(safeLabel("ghp_abcdefghijklmnopqrstuvwxyz0123"), /redacted/);
    assert.equal(safeLabel("x".repeat(200)).length, 48);
    assert.equal(safeLabel(null), "");
    assert.equal(safeLabel({ toString: () => "object" }), "");
  });

  it("shows the folder name only, and respects an explicitly hidden folder", () => {
    assert.equal(formatCompletionMessage(entry("s", { cwd: "/home/me/secret-path/app" }), "en").title, "Claude Code · app");
    assert.equal(formatCompletionMessage(entry("s", { displayFolder: "" }), "en").title, "Claude Code");
    assert.equal(formatCompletionMessage(entry("s", { displayFolder: "shown" }), "en").title, "Claude Code · shown");
    assert.equal(formatCompletionMessage({ id: "s", badge: "done" }, "en").title, "Clawd");
  });

  it("attention toasts carry the tool name but never its input", () => {
    const message = formatAttentionMessage({
      kind: "approval",
      agentName: "Claude Code",
      folder: "C:\\work\\repo",
      toolName: "Bash",
      toolInput: { command: "curl -H 'Authorization: Bearer abc' https://example.com" },
      summary: "rm -rf /",
      questions: [{ question: "What is the prod password?" }],
    }, "en");
    assert.deepEqual(message, { title: "Claude Code · repo", body: "Waiting for your approval: Bash" });
    assert.equal(formatAttentionMessage({ kind: "approval", agentName: "Codex" }, "en").body, "Waiting for your approval");
    assert.equal(formatAttentionMessage({ kind: "question", agentName: "Codex", toolName: "AskUserQuestion" }, "zh").body, "等待你回答问题");
  });
});

describe("system notifications: requests that wait on a human", () => {
  it("notifies an approval and routes the click to that session", () => {
    const h = makeHarness();
    const focusEntry = { id: "s1", sourcePid: 4242 };
    assert.equal(h.notifier.notifyAttention({
      kind: "approval", sessionId: "s1", agentName: "Claude Code", folder: "repo", toolName: "Edit", focusEntry,
    }, { isStillRelevant: () => true }), true);
    assert.equal(h.instances.length, 1);
    assert.equal(h.instances[0].options.body, "Waiting for your approval: Edit");
    h.instances[0].emit("click");
    assert.deepEqual(h.focusCalls, [{ sessionId: "s1", opts: { fallbackEntry: focusEntry } }]);
    assert.equal(h.dashboardCalls.length, 0);
  });

  it("stays silent for a request that is already resolved", () => {
    const h = makeHarness();
    assert.equal(h.notifier.notifyAttention({ kind: "approval", sessionId: "s1" }, { isStillRelevant: () => false }), false);
    assert.equal(h.notifier.notifyAttention({ kind: "approval", sessionId: "s1" }, {
      isStillRelevant: () => { throw new Error("gone"); },
    }), false);
    assert.equal(h.instances.length, 0);
  });

  it("honors the waiting-for-you switch and the master switch", () => {
    const h = makeHarness();
    h.settings.onPermission = false;
    assert.equal(h.notifier.notifyAttention({ kind: "approval", sessionId: "s1" }), false);
    h.settings.onPermission = true;
    h.settings.enabled = false;
    assert.equal(h.notifier.notifyAttention({ kind: "question", sessionId: "s1" }), false);
    assert.equal(h.instances.length, 0);
  });

  it("rejects unknown kinds", () => {
    const h = makeHarness();
    assert.equal(h.notifier.notifyAttention({ kind: "completion", sessionId: "s1" }), false);
    assert.equal(h.notifier.notifyAttention(null), false);
    assert.equal(h.instances.length, 0);
  });

  it("coalesces a burst of requests from one session into one toast", () => {
    const h = makeHarness();
    let firstPending = true;
    let secondPending = true;
    h.notifier.notifyAttention({ kind: "approval", sessionId: "s1", toolName: "Bash" }, { isStillRelevant: () => firstPending });
    h.state.time += 200;
    h.notifier.notifyAttention({ kind: "approval", sessionId: "s1", toolName: "Edit" }, { isStillRelevant: () => secondPending });
    h.notifier.notifyAttention({ kind: "approval", sessionId: "other", toolName: "Edit" }, { isStillRelevant: () => true });
    assert.equal(h.instances.length, 2, "one for s1, one for the other session");

    firstPending = false;
    h.notifier.onSnapshot(snap(working("s1"), working("other")));
    assert.equal(h.instances[0].closed, false, "another request of the burst is still waiting");
    secondPending = false;
    h.notifier.onSnapshot(snap(working("s1"), working("other")));
    assert.equal(h.instances[0].closed, true, "withdrawn once nothing is waiting any more");
    assert.equal(h.instances[1].closed, false);
  });

  it("replaces an older waiting toast for the same session after the burst window", () => {
    const h = makeHarness();
    h.notifier.notifyAttention({ kind: "approval", sessionId: "s1" }, { isStillRelevant: () => true });
    h.state.time += ATTENTION_COALESCE_MS + 1;
    h.notifier.notifyAttention({ kind: "question", sessionId: "s1" }, { isStillRelevant: () => true });
    assert.equal(h.instances.length, 2);
    assert.equal(h.instances[0].closed, true);
    assert.equal(h.instances[1].options.body, "Waiting for your answer");
  });

  it("still withdraws a waiting toast after its banner timed out into the notification center", () => {
    const h = makeHarness();
    let pending = true;
    h.notifier.notifyAttention({ kind: "approval", sessionId: "s1" }, { isStillRelevant: () => pending });
    // Windows reports "close" when the banner times out; the toast is still
    // listed in the notification center and only close() takes it out.
    h.instances[0].emit("close");
    h.notifier.onSnapshot(snap(working("s1")));
    assert.equal(h.instances[0].closed, false, "the request is still waiting");
    assert.ok(
      h.timers.filter((timer) => timer.ms !== ATTENTION_SWEEP_MS).every((timer) => timer.cleared),
      "no timeout may take a still-waiting request out"
    );

    pending = false;
    h.notifier.onSnapshot(snap(working("s1")));
    assert.equal(h.instances[0].closed, true);
    assert.ok(h.logs.some((line) => /toast withdrawn #1 kind=approval/.test(line)));
  });

  it("withdraws a waiting toast on its own when the request ends without any session event", () => {
    const h = makeHarness();
    let pending = true;
    h.notifier.notifyAttention({ kind: "approval", sessionId: "s1" }, { isStillRelevant: () => pending });
    const sweeps = () => h.timers.filter((timer) => timer.ms === ATTENTION_SWEEP_MS);
    assert.equal(sweeps().length, 1, "one watcher while a waiting toast is held");
    sweeps()[0].fn();
    assert.equal(h.instances[0].closed, false);
    assert.equal(sweeps().length, 2, "keeps watching while the request is pending");

    // e.g. the terminal was closed: the request is gone, no snapshot follows.
    pending = false;
    sweeps()[1].fn();
    assert.equal(h.instances[0].closed, true);
    assert.equal(sweeps().length, 2, "stops watching once nothing is held");
  });

  it("does not run a watcher for finished-task or test toasts", async () => {
    const h = makeHarness();
    h.notifier.prime(snap());
    h.notifier.onSnapshot(snap(entry("s1")));
    await h.notifier.test();
    assert.equal(h.timers.filter((timer) => timer.ms === ATTENTION_SWEEP_MS).length, 0);
  });

  it("stops the watcher on dispose", () => {
    const h = makeHarness();
    h.notifier.notifyAttention({ kind: "approval", sessionId: "s1" }, { isStillRelevant: () => true });
    const sweep = h.timers.find((timer) => timer.ms === ATTENTION_SWEEP_MS);
    h.notifier.dispose();
    assert.equal(sweep.cleared, true);
    sweep.fn();
    assert.equal(h.timers.filter((timer) => timer.ms === ATTENTION_SWEEP_MS).length, 1);
  });

  it("still routes a click on a waiting toast whose banner already timed out", () => {
    const h = makeHarness();
    h.notifier.notifyAttention({ kind: "question", sessionId: "s1" }, { isStillRelevant: () => true });
    h.instances[0].emit("close");
    h.instances[0].emit("click");
    assert.deepEqual(h.focusCalls.map((call) => call.sessionId), ["s1"]);
  });

  it("lets go of a finished-task toast once its banner is gone, leaving it as history", () => {
    const h = makeHarness();
    h.notifier.prime(snap());
    h.notifier.onSnapshot(snap(entry("s1")));
    h.instances[0].emit("close");
    assert.equal(h.instances[0].closed, false, "never removed from the notification center by Clawd");
    assert.equal(h.instances[0].listenerCount("click"), 0);
    // A later turn of the same session does not reach back for it either.
    h.notifier.onSnapshot(snap(working("s1")));
    h.state.time += 5_000;
    h.notifier.onSnapshot(snap(entry("s1")));
    assert.equal(h.instances.length, 2);
    assert.equal(h.instances[0].closed, false);
  });

  it("withdraws a waiting toast when the turn completes", () => {
    const h = makeHarness();
    h.notifier.prime(snap());
    h.notifier.notifyAttention({ kind: "approval", sessionId: "s1" }, { isStillRelevant: () => true });
    h.notifier.onSnapshot(snap(entry("s1")));
    assert.equal(h.instances[0].closed, true);
    assert.equal(h.instances[1].options.body, "Task completed");
  });
});

describe("system notifications: click routing", () => {
  it("opens the session list when the session cannot be located", () => {
    for (const result of [false, null, undefined, { reason: "no-source-pid" }]) {
      const h = makeHarness({ focusSession: () => result });
      h.notifier.prime(snap());
      h.notifier.onSnapshot(snap(entry("gone")));
      h.instances[0].emit("click");
      assert.equal(h.dashboardCalls.length, 1, JSON.stringify(result));
    }
  });

  it("opens the session list when focusing throws or rejects", async () => {
    const thrower = makeHarness({ focusSession: () => { throw new Error("focus helper missing"); } });
    thrower.notifier.prime(snap());
    thrower.notifier.onSnapshot(snap(entry("s1")));
    assert.doesNotThrow(() => thrower.instances[0].emit("click"));
    assert.equal(thrower.dashboardCalls.length, 1);

    const rejecter = makeHarness({ focusSession: () => Promise.reject(new Error("nope")) });
    rejecter.notifier.prime(snap());
    rejecter.notifier.onSnapshot(snap(entry("s1")));
    rejecter.instances[0].emit("click");
    await flush();
    assert.equal(rejecter.dashboardCalls.length, 1);
  });

  it("trusts a focus request that located a window, confirmed or not", async () => {
    for (const result of [
      { reason: "focused", status: "unconfirmed" },
      { reason: "wt-title-match", targetHwnd: "0x1a2b", foregroundHwnd: "0x9999", confirmed: false, status: "unconfirmed" },
      { reason: "cached-window", targetHwnd: "0x1a2b", foregroundHwnd: "0x1a2b", confirmed: true, status: "confirmed" },
    ]) {
      const h = makeHarness({ focusSession: () => Promise.resolve(result) });
      h.notifier.prime(snap());
      h.notifier.onSnapshot(snap(entry("s1")));
      h.instances[0].emit("click");
      await flush();
      assert.equal(h.dashboardCalls.length, 0, JSON.stringify(result));
    }
  });

  it("opens the session list when the focus helper found no window to raise", async () => {
    // e.g. the terminal that hosted the session has been closed.
    const h = makeHarness({
      focusSession: () => Promise.resolve({
        token: "t", reason: "no-parent-window", targetHwnd: null, foregroundHwnd: "0x9999",
        confirmed: false, status: "unconfirmed",
      }),
    });
    h.notifier.prime(snap());
    h.notifier.onSnapshot(snap(entry("s1")));
    h.instances[0].emit("click");
    assert.equal(h.dashboardCalls.length, 0, "decided only once the helper answers");
    await flush();
    assert.equal(h.dashboardCalls.length, 1);
  });

  it("the test toast opens the session list and never focuses a session", async () => {
    const h = makeHarness();
    h.settings.enabled = false; // the test button works before the feature is switched on
    h.state.suppressed = true;
    assert.equal(await h.notifier.test(), true);
    assert.equal(h.instances[0].options.title, "Clawd on Desk");
    h.instances[0].emit("click");
    assert.equal(h.focusCalls.length, 0);
    assert.equal(h.dashboardCalls.length, 1);
  });
});

describe("system notifications: OS delivery outcomes", () => {
  it("reports a toast the OS refused as not shown", async () => {
    const h = makeHarness();
    h.FakeNotification.autoShow = false;
    const pending = h.notifier.test();
    h.instances[0].emit("failed", {}, "notifications are disabled for this app");
    assert.equal(await pending, false);
    assert.equal(h.instances[0].closed, true);
    assert.ok(h.logs.some((line) => /toast failed/.test(line)));
  });

  it("gives up on a toast the OS never acknowledges", async () => {
    const h = makeHarness();
    h.FakeNotification.autoShow = false;
    const pending = h.notifier.test();
    const timeout = h.timers.find((timer) => !timer.cleared);
    assert.equal(timeout.ms, 10_000);
    timeout.fn();
    assert.equal(await pending, false);
    assert.equal(h.instances[0].closed, true);
  });

  it("holds a shown toast for a bounded time, then lets it go", async () => {
    const h = makeHarness();
    assert.equal(await h.notifier.test(), true);
    const retention = h.timers.find((timer) => !timer.cleared);
    assert.equal(retention.ms, RETENTION_MS);
    assert.equal(h.instances[0].closed, false);
    retention.fn();
    assert.equal(h.instances[0].closed, true);
  });

  it("survives a Notification constructor that throws", async () => {
    class Exploding {
      static isSupported() { return true; }
      constructor() { throw new Error("no toast for you"); }
    }
    const h = makeHarness({ Notification: Exploding });
    assert.equal(await h.notifier.test(), false);
    h.notifier.prime(snap());
    assert.doesNotThrow(() => h.notifier.onSnapshot(snap(entry("s1"))));
  });

  it("bounds how many toasts it holds at once", () => {
    const h = makeHarness();
    h.notifier.prime(snap());
    const ids = Array.from({ length: 20 }, (_, index) => `s${index}`);
    h.notifier.onSnapshot(snap(...ids.map((id) => entry(id))));
    assert.equal(h.instances.length, 20);
    assert.equal(h.instances.filter((n) => !n.closed).length, 16);
    assert.equal(h.instances[0].closed, true, "oldest goes first");
  });

  it("closes everything and goes quiet on dispose", async () => {
    const h = makeHarness();
    h.notifier.prime(snap());
    h.notifier.onSnapshot(snap(entry("s1")));
    h.notifier.dispose();
    assert.equal(h.instances[0].closed, true);
    h.notifier.onSnapshot(snap(entry("s2")));
    assert.equal(h.notifier.notifyAttention({ kind: "approval", sessionId: "s2" }), false);
    assert.equal(await h.notifier.test(), false);
    assert.equal(h.instances.length, 1);
  });
});

// The real session state machine drives the notifier through the same
// broadcastSessionSnapshot seam main.js uses.
describe("system notifications: driven by the real session state machine", () => {
  let api;
  let h;

  function makeStateCtx(overrides = {}) {
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

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    h = makeHarness({ now: () => Date.now() });
    h.notifier.prime(snap());
    api = require("../src/state")(makeStateCtx({
      broadcastSessionSnapshot: (snapshot) => h.notifier.onSnapshot(snapshot),
    }));
  });
  afterEach(() => {
    api.cleanup();
    mock.timers.reset();
  });

  function bodies() { return h.instances.map((n) => n.options.body); }

  it("a turn that runs and stops produces exactly one completion toast", () => {
    const opts = { agentId: "claude-code", cwd: "C:\\repos\\alpha" };
    api.updateSession("s1", "thinking", "UserPromptSubmit", opts);
    api.updateSession("s1", "working", "PreToolUse", opts);
    assert.deepEqual(bodies(), []);
    api.updateSession("s1", "attention", "Stop", opts);
    mock.timers.tick(50);
    assert.deepEqual(bodies(), ["Task completed"]);
    assert.match(h.instances[0].options.title, /alpha$/);

    // Later unrelated broadcasts (another session moving) must not repeat it.
    api.updateSession("s2", "working", "PreToolUse", { agentId: "claude-code", cwd: "C:\\repos\\beta" });
    mock.timers.tick(5000);
    assert.deepEqual(bodies(), ["Task completed"]);
  });

  it("a failed turn produces a failure toast, not a completion toast", () => {
    const opts = { agentId: "claude-code", cwd: "C:\\repos\\alpha" };
    api.updateSession("s1", "working", "PreToolUse", opts);
    api.updateSession("s1", "error", "StopFailure", opts);
    mock.timers.tick(50);
    assert.deepEqual(bodies(), ["Task failed or was interrupted"]);
  });

  it("a tool failure in the middle of a turn is not a finished task", () => {
    const opts = { agentId: "claude-code", cwd: "C:\\repos\\alpha" };
    api.updateSession("s1", "working", "PreToolUse", opts);
    api.updateSession("s1", "error", "PostToolUseFailure", opts);
    api.updateSession("s1", "working", "PreToolUse", opts);
    mock.timers.tick(50);
    assert.deepEqual(bodies(), []);
  });

  it("a Stop delivered twice by duplicate hooks toasts once", () => {
    const opts = { agentId: "claude-code", cwd: "C:\\repos\\alpha" };
    api.updateSession("s1", "working", "PreToolUse", opts);
    api.updateSession("s1", "attention", "Stop", opts);
    mock.timers.tick(20);
    api.updateSession("s1", "attention", "Stop", opts);
    mock.timers.tick(20);
    assert.deepEqual(bodies(), ["Task completed"]);
  });

  it("a subagent stopping does not announce the main task", () => {
    const opts = { agentId: "claude-code", cwd: "C:\\repos\\alpha" };
    api.updateSession("s1", "working", "PreToolUse", opts);
    api.updateSession("s1", "juggling", "SubagentStart", opts);
    api.updateSession("s1", "working", "SubagentStop", opts);
    mock.timers.tick(50);
    assert.deepEqual(bodies(), []);
    api.updateSession("s1", "attention", "Stop", opts);
    mock.timers.tick(50);
    assert.deepEqual(bodies(), ["Task completed"]);
  });

  it("live background work holds the completion toast back", () => {
    const opts = { agentId: "claude-code", cwd: "C:\\repos\\alpha" };
    api.updateSession("s1", "working", "PreToolUse", opts);
    api.updateSession("s1", "attention", "Stop", { ...opts, backgroundTasksCount: 1 });
    mock.timers.tick(5000);
    assert.deepEqual(bodies(), [], "background work pending: the main task has not finished");
  });

  it("two agents finishing in parallel each get their own toast and their own click target", () => {
    const claude = { agentId: "claude-code", cwd: "C:\\repos\\alpha" };
    const codex = { agentId: "codex", cwd: "C:\\repos\\beta" };
    api.updateSession("claude-1", "working", "PreToolUse", claude);
    api.updateSession("codex-1", "working", "PreToolUse", codex);
    api.updateSession("claude-1", "attention", "Stop", claude);
    mock.timers.tick(50);
    api.updateSession("codex-1", "attention", "Stop", codex);
    mock.timers.tick(50);
    assert.equal(h.instances.length, 2);
    assert.match(h.instances[0].options.title, /alpha$/);
    assert.match(h.instances[1].options.title, /beta$/);
    h.instances[1].emit("click");
    assert.equal(h.focusCalls.length, 1);
    assert.match(h.focusCalls[0].sessionId, /codex-1/);
  });

  it("the master switch silences real completions", () => {
    h.settings.enabled = false;
    const opts = { agentId: "claude-code", cwd: "C:\\repos\\alpha" };
    api.updateSession("s1", "working", "PreToolUse", opts);
    api.updateSession("s1", "attention", "Stop", opts);
    mock.timers.tick(50);
    assert.deepEqual(bodies(), []);
  });
});
