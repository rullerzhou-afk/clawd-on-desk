"use strict";

// #406 integration: drive state.js's completion gate end-to-end into the
// Telegram companion via the real session-snapshot fanout. Locks the third
// completion surface (the Telegram push) so the held -> promote flow can't
// silently regress: a held Stop must not push, promote must push exactly once,
// hard live background work must never push, and bg-only Stops with final
// assistant text promote after a quiet window.

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

  it("bg-only Stop with final assistant text pushes exactly once after the quiet window", async () => {
    stop(api, "s1", { backgroundTasksCount: 1, assistantLastOutput: "All done." });
    await flush();
    assert.strictEqual(sent.length, 0, "no push while bg-only Stop is waiting");
    mock.timers.tick(1000);
    await flush();
    assert.strictEqual(sent.length, 1, "bg-only completion promotes exactly once");
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

// The gate above can withhold a Stop and replay it later via promoteCompletion.
// Any event arriving inside that window carries no assistant output, so before
// the state.js carry-forward the recorded answer was rewritten to null and the
// promoted completion shipped title-only — or, with plain pings disabled, was
// dropped entirely. The cases above drive this exact sequence but assert only
// sent.length, which is why the regression was invisible.
describe("#406 completion hold preserves the assistant output", () => {
  let api;
  let sent;
  let savedDebounceEnv;

  // Assert on the VISIBLE text, never on JSON.stringify of the message: the
  // message object carries a `truncated` field, so a serialized form contains
  // the word "truncated" whatever its value.
  function sentText(i) {
    const value = sent[i];
    return value && typeof value === "object" && typeof value.plainText === "string"
      ? value.plainText
      : String(value == null ? "" : value);
  }

  function setup({ notifyOnComplete = true } = {}) {
    sent = [];
    const companion = createTelegramCompanion({
      getClient: () => ({
        sendNotification: async (text) => { sent.push(text); return { ok: true }; },
      }),
      isEnabled: () => true,
      getNotifyOnComplete: () => notifyOnComplete,
      getCompletionOutputMode: () => "full",
    });
    companion.onSnapshot({ sessions: [] }); // prime dedupe (no backlog re-ping)
    api = require("../src/state")(makeCtx({
      broadcastSessionSnapshot: (snapshot) => companion.onSnapshot(snapshot),
    }));
  }

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    savedDebounceEnv = process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    process.env.CLAWD_COMPLETION_DEBOUNCE_MS = "1000";
  });
  afterEach(() => {
    if (api) api.cleanup();
    api = null;
    mock.timers.reset();
    if (savedDebounceEnv === undefined) delete process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    else process.env.CLAWD_COMPLETION_DEBOUNCE_MS = savedDebounceEnv;
  });

  it("keeps the answer when a Notification lands inside the hold", async () => {
    setup();
    stop(api, "s1", { assistantLastOutput: "HELD-TURN-ANSWER" });
    mock.timers.tick(400);
    api.updateSession("s1", "notification", "Notification", { agentId: "claude-code" });
    await flush();
    mock.timers.tick(1000);
    await flush();
    assert.strictEqual(sent.length, 1, "exactly one completion push");
    assert.ok(
      sentText(0).includes("HELD-TURN-ANSWER"),
      `promoted completion must still carry the assistant output, got: ${sentText(0)}`,
    );
  });

  it("still delivers the completion when plain pings are off and an event lands inside the hold", async () => {
    // With getNotifyOnComplete() false the push exists only to carry the
    // output, so losing the field drops the notification outright.
    setup({ notifyOnComplete: false });
    stop(api, "s1", { assistantLastOutput: "OUTPUT-ONLY-ANSWER" });
    mock.timers.tick(400);
    api.updateSession("s1", "notification", "Notification", { agentId: "claude-code" });
    await flush();
    mock.timers.tick(1000);
    await flush();
    assert.strictEqual(sent.length, 1, "output-only completion must not be dropped");
    assert.ok(
      sentText(0).includes("OUTPUT-ONLY-ANSWER"),
      `output-only completion must carry the assistant output, got: ${sentText(0)}`,
    );
  });

  // The truncated flag is inherited only when the text is inherited. If it were
  // taken from the incoming event instead, a carried-forward truncated answer
  // would ship without its "(truncated)" marker and read as complete.
  it("carries the truncation marker along with the answer", async () => {
    setup();
    stop(api, "s1", { assistantLastOutput: "CLIPPED-ANSWER", assistantLastOutputTruncated: true });
    mock.timers.tick(400);
    api.updateSession("s1", "notification", "Notification", { agentId: "claude-code" });
    await flush();
    mock.timers.tick(1000);
    await flush();

    assert.strictEqual(sent.length, 1, "exactly one completion push");
    assert.ok(sentText(0).includes("CLIPPED-ANSWER"), "the answer survives");
    assert.ok(
      sentText(0).includes("Assistant output (truncated):"),
      `a carried-forward truncated answer must still be marked truncated, got: ${sentText(0)}`,
    );
  });

  it("does not leak the previous turn's answer into the next completion", async () => {
    setup();
    stop(api, "s1", { assistantLastOutput: "TURN-ONE-ANSWER" });
    mock.timers.tick(1000);
    await flush();
    assert.strictEqual(sent.length, 1, "turn one pushes once");

    api.updateSession("s1", "working", "UserPromptSubmit", { agentId: "claude-code" });
    await flush();
    stop(api, "s1", { agentId: "claude-code" }); // turn two ends with no text
    mock.timers.tick(1000);
    await flush();
    assert.strictEqual(sent.length, 2, "turn two pushes once");
    assert.ok(
      !sentText(1).includes("TURN-ONE-ANSWER"),
      `turn two must not carry turn one's answer, got: ${sentText(1)}`,
    );
  });
});

// The carry-forward is bounded by the hold window, not by a guessed turn
// boundary. These pin the two ways a boundary-based version went wrong.
describe("#406 completion hold does not overreach", () => {
  let api;
  let sent;
  let savedDebounceEnv;

  function sentText(i) {
    const value = sent[i];
    return value && typeof value === "object" && typeof value.plainText === "string"
      ? value.plainText
      : String(value == null ? "" : value);
  }

  function setup() {
    sent = [];
    const companion = createTelegramCompanion({
      getClient: () => ({
        sendNotification: async (text) => { sent.push(text); return { ok: true }; },
      }),
      isEnabled: () => true,
      getNotifyOnComplete: () => true,
      getCompletionOutputMode: () => "full",
    });
    companion.onSnapshot({ sessions: [] });
    api = require("../src/state")(makeCtx({
      broadcastSessionSnapshot: (snapshot) => companion.onSnapshot(snapshot),
    }));
  }

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    savedDebounceEnv = process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    process.env.CLAWD_COMPLETION_DEBOUNCE_MS = "1000";
  });
  afterEach(() => {
    if (api) api.cleanup();
    api = null;
    mock.timers.reset();
    if (savedDebounceEnv === undefined) delete process.env.CLAWD_COMPLETION_DEBOUNCE_MS;
    else process.env.CLAWD_COMPLETION_DEBOUNCE_MS = savedDebounceEnv;
  });

  // The Codex JSONL monitor emits task_started / task_complete and never
  // UserPromptSubmit or SessionStart, so a boundary-based carry-forward could
  // never clear and shipped turn N's answer as turn N+1's completion. Only the
  // claude-code gate can withhold, so codex must never carry anything forward.
  it("never carries an answer between turns on an agent that cannot be withheld", async () => {
    setup();
    api.updateSession("cx1", "attention", "event_msg:task_complete", {
      agentId: "codex",
      assistantLastOutput: "TURN-ONE-SECRET-ANSWER",
    });
    await flush();
    assert.strictEqual(sent.length, 1, "turn one pushes once");
    assert.ok(sentText(0).includes("TURN-ONE-SECRET-ANSWER"), "turn one carries its own answer");

    mock.timers.tick(5000);
    api.updateSession("cx1", "working", "event_msg:task_started", { agentId: "codex" });
    await flush();
    api.updateSession("cx1", "attention", "event_msg:task_complete", { agentId: "codex" });
    await flush();

    assert.strictEqual(sent.length, 2, "turn two pushes once");
    assert.ok(
      !sentText(1).includes("TURN-ONE-SECRET-ANSWER"),
      `turn two must not carry turn one's answer, got: ${sentText(1)}`,
    );
  });

  // A held completion can end by being CANCELLED rather than promoted -- a new
  // prompt inside the quiet window means the turn never ended. The marker has to
  // be released there too, or the answer stays sticky into the next turn.
  it("releases the carry-forward when the hold is cancelled instead of promoted", async () => {
    setup();
    stop(api, "s2", { assistantLastOutput: "CANCELLED-TURN-ANSWER" });
    mock.timers.tick(400);
    api.updateSession("s2", "working", "UserPromptSubmit", { agentId: "claude-code" });
    await flush();
    assert.strictEqual(sent.length, 0, "a cancelled hold never pushes");

    mock.timers.tick(5000);
    stop(api, "s2", { agentId: "claude-code" }); // next turn ends with no text
    mock.timers.tick(1000);
    await flush();

    assert.strictEqual(sent.length, 1, "the next turn pushes once");
    assert.ok(
      !sentText(0).includes("CANCELLED-TURN-ANSWER"),
      `a cancelled hold must not leak its answer forward, got: ${sentText(0)}`,
    );
  });

  it("does not leak hard-held intermediate output into a later textless Stop", async () => {
    setup();
    stop(api, "s-hard", {
      stopHookActive: true,
      assistantLastOutput: "INTERMEDIATE-NOT-FINAL",
    });
    mock.timers.tick(5000);
    await flush();
    assert.strictEqual(sent.length, 0, "hard-held intermediate output must not push");

    stop(api, "s-hard");
    mock.timers.tick(1000);
    await flush();

    assert.strictEqual(sent.length, 1, "the later plain Stop still completes once");
    assert.ok(
      !sentText(0).includes("INTERMEDIATE-NOT-FINAL"),
      `later textless Stop must not reuse hard-held intermediate output, got: ${sentText(0)}`,
    );
  });

  it("uses only the later Stop output after a hard-held intermediate Stop", async () => {
    setup();
    stop(api, "s-hard-final", {
      stopHookActive: true,
      assistantLastOutput: "INTERMEDIATE-NOT-FINAL",
    });
    mock.timers.tick(5000);
    await flush();

    stop(api, "s-hard-final", { assistantLastOutput: "ACTUAL-FINAL-ANSWER" });
    mock.timers.tick(1000);
    await flush();

    assert.strictEqual(sent.length, 1, "the later final Stop completes once");
    assert.ok(sentText(0).includes("ACTUAL-FINAL-ANSWER"), "later Stop output survives");
    assert.ok(
      !sentText(0).includes("INTERMEDIATE-NOT-FINAL"),
      `later final Stop must not include hard-held intermediate output, got: ${sentText(0)}`,
    );
  });

  it("does not leak hard-held output through a Notification into a later textless Stop", async () => {
    setup();
    stop(api, "s-hard-notification", {
      stopHookActive: true,
      assistantLastOutput: "INTERMEDIATE-NOT-FINAL",
    });
    api.updateSession("s-hard-notification", "notification", "Notification", { agentId: "claude-code" });
    mock.timers.tick(5000);
    await flush();
    assert.strictEqual(sent.length, 0, "hard-held intermediate output must not push through notification");

    stop(api, "s-hard-notification");
    mock.timers.tick(1000);
    await flush();

    assert.strictEqual(sent.length, 1, "the later textless Stop completes once");
    assert.ok(
      !sentText(0).includes("INTERMEDIATE-NOT-FINAL"),
      `later textless Stop must not inherit hard-held output after Notification, got: ${sentText(0)}`,
    );
  });

  it("uses the superseding debounced Stop payload exactly once", async () => {
    setup();
    stop(api, "s-supersede", { assistantLastOutput: "FIRST-DEBOUNCED-ANSWER" });
    mock.timers.tick(500);
    stop(api, "s-supersede", { assistantLastOutput: "SECOND-DEBOUNCED-ANSWER" });
    mock.timers.tick(1000);
    await flush();

    assert.strictEqual(sent.length, 1, "the superseding Stop completes once");
    assert.ok(sentText(0).includes("SECOND-DEBOUNCED-ANSWER"), "latest debounced Stop output wins");
    assert.ok(
      !sentText(0).includes("FIRST-DEBOUNCED-ANSWER"),
      `superseded Stop output must not leak, got: ${sentText(0)}`,
    );
  });

  it("does not send a duplicate completion notification for the same Stop payload", async () => {
    setup();
    stop(api, "s-dup-payload", { assistantLastOutput: "FINAL-ONCE" });
    mock.timers.tick(1000);
    await flush();
    assert.strictEqual(sent.length, 1, "first completion pushes once");
    assert.ok(sentText(0).includes("FINAL-ONCE"), "first completion carries its output");

    stop(api, "s-dup-payload", { assistantLastOutput: "FINAL-ONCE" });
    mock.timers.tick(1000);
    await flush();

    assert.strictEqual(sent.length, 1, "duplicate Stop with the same payload must not push again");
  });

  // The gate asks whether THIS Stop ended the turn with text. A carried-forward
  // value made a text-less Stop look complete, releasing a hard hold while
  // background work was still live.
  it("does not let a carried answer release a hard hold", async () => {
    setup();
    stop(api, "s9", { stopHookActive: true, assistantLastOutput: "TURN-TEXT" });
    await flush();
    assert.strictEqual(sent.length, 0, "a stop-hook veto holds");

    mock.timers.tick(5000);
    stop(api, "s9", { backgroundTasksCount: 1 });
    await flush();
    mock.timers.tick(5000);
    await flush();

    assert.strictEqual(
      sent.length, 0,
      `live background work must still hold; pushed: ${sent.map((_, i) => sentText(i)).join(" | ")}`,
    );
  });
});
