"use strict";

// #1326 follow-up: an opt-in reminder for a Claude Desktop wrap_up question
// (see claude-turn-ask.js) that is still unanswered after N minutes.
//
// "Answered" means the session moved on: the next prompt (a box button sends
// one), SessionEnd, or another tool call — exactly what makes the /state route
// clear the card. Clicking the pet's card only dismisses the card, so it does
// NOT stop the countdown. One reminder per question; a newer question in the
// same session replaces the old one and restarts the countdown.

const DEFAULT_REMINDER_MINUTES = 5;
const MIN_REMINDER_MINUTES = 1;
const MAX_REMINDER_MINUTES = 120;

function reminderDelayMsFromMinutes(minutes) {
  const value = Number(minutes);
  const clamped = Number.isInteger(value)
    ? Math.max(MIN_REMINDER_MINUTES, Math.min(MAX_REMINDER_MINUTES, value))
    : DEFAULT_REMINDER_MINUTES;
  return clamped * 60_000;
}

function createClaudeTurnAskReminder({
  isEnabled = () => false,
  canRemind = () => true,
  getDelayMs = () => DEFAULT_REMINDER_MINUTES * 60_000,
  onRemind = () => {},
  setTimeout: setTimeoutFn = setTimeout,
  clearTimeout: clearTimeoutFn = clearTimeout,
} = {}) {
  const pending = new Map();

  function resolve(sessionId) {
    const entry = pending.get(sessionId);
    if (!entry) return false;
    clearTimeoutFn(entry.timer);
    pending.delete(sessionId);
    return true;
  }

  // True while a question can still produce a reminder. The switch is read
  // live, so a disabled reminder does not need to hold its session alive.
  function isPending(sessionId) {
    if (typeof sessionId !== "string" || !sessionId) return false;
    return pending.has(sessionId) && isEnabled();
  }

  function track(payload) {
    const sessionId = payload && payload.sessionId;
    if (typeof sessionId !== "string" || !sessionId) return false;
    resolve(sessionId);
    const delayMs = Number(getDelayMs());
    if (!Number.isFinite(delayMs) || delayMs <= 0) return false;
    const entry = { timer: null, payload: { ...payload } };
    entry.timer = setTimeoutFn(() => {
      if (pending.get(sessionId) !== entry) return;
      pending.delete(sessionId);
      // The switch is read when the timer fires, so toggling it also applies to
      // questions that are already waiting; the minutes are read at track time.
      // A refused attempt (setting off, session gone, or showing blocked by DND
      // or the notification policy) is consumed and never retried.
      if (!isEnabled()) return;
      if (!canRemind(entry.payload)) return;
      try {
        onRemind(entry.payload);
      } catch {
        // Keep a failing reminder from breaking the timer callback.
      }
    }, delayMs);
    if (entry.timer && typeof entry.timer.unref === "function") entry.timer.unref();
    pending.set(sessionId, entry);
    return true;
  }

  function dispose() {
    for (const entry of pending.values()) clearTimeoutFn(entry.timer);
    pending.clear();
  }

  return {
    track,
    resolve,
    isPending,
    dispose,
    // test-only introspection
    _size: () => pending.size,
  };
}

module.exports = {
  DEFAULT_REMINDER_MINUTES,
  MIN_REMINDER_MINUTES,
  MAX_REMINDER_MINUTES,
  reminderDelayMsFromMinutes,
  createClaudeTurnAskReminder,
};
