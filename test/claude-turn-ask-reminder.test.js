"use strict";

// #1326 follow-up: opt-in reminder for an unanswered Claude Desktop wrap_up
// question.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DEFAULT_REMINDER_MINUTES,
  reminderDelayMsFromMinutes,
  createClaudeTurnAskReminder,
} = require("../src/claude-turn-ask-reminder");

function makeFakeTimers() {
  let now = 0;
  let nextId = 1;
  let unrefCalls = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = { id: nextId++, unref() { unrefCalls++; } };
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    get size() { return timers.size; },
    get unrefCount() { return unrefCalls; },
    pending() { return [...timers.entries()].map(([id, timer]) => ({ id, ...timer })); },
  };
}

function makeReminder({ enabled = true, delayMs = 60_000, canRemind = () => true } = {}) {
  const timers = makeFakeTimers();
  const reminded = [];
  const state = { enabled };
  const reminder = createClaudeTurnAskReminder({
    isEnabled: () => state.enabled,
    canRemind,
    getDelayMs: () => delayMs,
    onRemind: (payload) => reminded.push(payload),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  return { reminder, timers, reminded, state };
}

const QUESTION = { sessionId: "s1", ask: "Fix the parser now?", actions: [{ label: "Fix it" }] };

describe("createClaudeTurnAskReminder", () => {
  it("reminds once, with the question, after the configured delay", () => {
    const { reminder, timers, reminded } = makeReminder();
    assert.equal(reminder.track(QUESTION), true);
    timers.advance(59_999);
    assert.equal(reminded.length, 0);
    timers.advance(1);
    assert.deepStrictEqual(reminded, [QUESTION]);
    timers.advance(10 * 60_000);
    assert.equal(reminded.length, 1, "one reminder per question");
    assert.equal(reminder._size(), 0);
  });

  it("does not remind once the session moved on", () => {
    const { reminder, timers, reminded } = makeReminder();
    reminder.track(QUESTION);
    assert.equal(reminder.resolve("s1"), true);
    assert.equal(timers.size, 0, "the timer is cleared, not left to no-op");
    assert.equal(reminder._size(), 0, "the pending question is forgotten immediately");
    timers.advance(60_000);
    assert.equal(reminded.length, 0);
  });

  it("does not remind when canRemind rejects the payload at expiry", () => {
    const { reminder, timers, reminded } = makeReminder({ canRemind: () => false });
    reminder.track(QUESTION);
    timers.advance(60_000);
    assert.equal(reminded.length, 0, "a dead or disabled session is not re-shown");
    assert.equal(reminder._size(), 0, "the single attempt is consumed either way");
  });

  it("checks the setting when the timer fires", () => {
    const { reminder, timers, reminded, state } = makeReminder({ enabled: false });
    reminder.track(QUESTION);
    state.enabled = true;
    timers.advance(60_000);
    assert.equal(reminded.length, 1, "turning it on applies to a question already waiting");

    reminder.track({ ...QUESTION, ask: "Again?" });
    state.enabled = false;
    timers.advance(60_000);
    assert.equal(reminded.length, 1, "turning it off silences a question already waiting");
  });

  it("restarts the countdown when the same session asks again", () => {
    const { reminder, timers, reminded } = makeReminder();
    reminder.track(QUESTION);
    const staleCallback = timers.pending()[0].fn;
    timers.advance(40_000);
    reminder.track({ ...QUESTION, ask: "Push the fix?" });
    assert.equal(timers.size, 1, "the replacement leaves exactly one live timer");
    staleCallback();
    assert.equal(reminded.length, 0, "an already-queued old callback is a no-op");
    timers.advance(40_000);
    assert.equal(reminded.length, 0, "the first question's timer was replaced");
    timers.advance(20_000);
    assert.deepStrictEqual(reminded.map((payload) => payload.ask), ["Push the fix?"]);
  });

  it("unrefs every timer so a waiting reminder never holds the process open", () => {
    const { reminder, timers } = makeReminder();
    reminder.track(QUESTION);
    assert.equal(timers.unrefCount, 1);
    reminder.track({ ...QUESTION, sessionId: "s2" });
    assert.equal(timers.unrefCount, 2);
  });

  it("keeps sessions independent and ignores payloads without a session", () => {
    const { reminder, timers, reminded } = makeReminder();
    reminder.track(QUESTION);
    reminder.track({ ...QUESTION, sessionId: "s2" });
    reminder.resolve("s1");
    assert.equal(reminder.track({ ask: "no session" }), false);
    timers.advance(60_000);
    assert.deepStrictEqual(reminded.map((payload) => payload.sessionId), ["s2"]);
  });

  it("swallows a failing onRemind and clears everything on dispose", () => {
    const timers = makeFakeTimers();
    const reminder = createClaudeTurnAskReminder({
      isEnabled: () => true,
      getDelayMs: () => 1000,
      onRemind: () => { throw new Error("bubble unavailable"); },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    reminder.track(QUESTION);
    assert.doesNotThrow(() => timers.advance(1000));

    reminder.track(QUESTION);
    reminder.track({ ...QUESTION, sessionId: "s2" });
    reminder.dispose();
    assert.equal(reminder._size(), 0);
    assert.equal(timers.size, 0);
  });
});

describe("reminderDelayMsFromMinutes", () => {
  it("clamps to 1–120 minutes and falls back to the default for bad input", () => {
    assert.equal(reminderDelayMsFromMinutes(5), 5 * 60_000);
    assert.equal(reminderDelayMsFromMinutes(7), 7 * 60_000);
    assert.equal(reminderDelayMsFromMinutes(120), 120 * 60_000);
    assert.equal(reminderDelayMsFromMinutes(0), 60_000);
    assert.equal(reminderDelayMsFromMinutes(500), 120 * 60_000);
    assert.equal(reminderDelayMsFromMinutes(undefined), DEFAULT_REMINDER_MINUTES * 60_000);
    assert.equal(reminderDelayMsFromMinutes(2.5), DEFAULT_REMINDER_MINUTES * 60_000);
  });
});

describe("main wiring", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");

  it("creates the reminder before the state context and gates it on a live Claude session", () => {
    const reminderIndex = source.indexOf(
      "const claudeTurnAskReminder = createClaudeTurnAskReminder({"
    );
    const stateCtxIndex = source.indexOf("const _stateCtx = {");
    assert.ok(reminderIndex >= 0, "the reminder declaration must exist");
    assert.ok(stateCtxIndex >= 0, "the state context declaration must exist");
    assert.ok(
      reminderIndex < stateCtxIndex,
      "onSessionDeleted must not read the reminder before it is initialized"
    );
    assert.match(
      source,
      /canRemind: \(payload\) => _runtimeAgentGate\.isAgentEnabled\("claude-code"\)\s*&& sessions\.has\(payload\.sessionId\)/
    );
  });

  it("resolves on session deletion and disposes on both quit hooks", () => {
    assert.match(
      source,
      /onSessionDeleted: \(sessionId\) => \{[\s\S]*?claudeTurnAskReminder\.resolve\(sessionId\);/
    );
    assert.equal((source.match(/claudeTurnAskReminder\.dispose\(\)/g) || []).length, 2);
    assert.match(
      source,
      /app\.on\("before-quit"[\s\S]*?claudeTurnAskReminder\.dispose\(\);\s*_perm\.cleanup\(\);/
    );
  });
});
