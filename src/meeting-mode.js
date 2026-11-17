"use strict";

// ── Meeting mode (#1382) ──
// A timed "hide the pet and stay quiet" switch for screen sharing. It is not a
// new visibility layer: it drives the existing manual pet hide and Do Not
// Disturb, remembers what they were before, and puts them back when it ends.
//
// Content protection (setContentProtection) was rejected for this: since
// macOS 15, ScreenCaptureKit capture (Zoom, Teams, QuickTime, the system
// screenshot tools) ignores a window's sharing type (electron/electron#48258).
//
// Ends on its own when the time is up, or early through end(). The timer is
// a plain setTimeout, which does not advance while the machine sleeps on every
// platform, so checkExpiry() is also called on powerMonitor "resume". Nothing
// is persisted: neither the manual hide nor DND survives a restart either.

const MEETING_MODE_DURATIONS_MIN = Object.freeze([30, 60, 120]);

function createMeetingModeController(options = {}) {
  const hidePet = options.hidePet;
  const showPet = options.showPet;
  const isPetHidden = options.isPetHidden;
  const enableDnd = options.enableDnd;
  const disableDnd = options.disableDnd;
  const isDnd = options.isDnd;
  const onChange = typeof options.onChange === "function" ? options.onChange : () => {};
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const log = typeof options.log === "function" ? options.log : () => {};

  let active = false;
  let endsAt = 0;
  let timer = null;
  let ending = false;
  // What meeting mode turned on itself, so end() only undoes that.
  let hidPet = false;
  let enabledDnd = false;

  function clearPendingTimer() {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  }

  function armTimer() {
    clearPendingTimer();
    const remaining = Math.max(0, endsAt - now());
    timer = setTimer(() => {
      timer = null;
      checkExpiry();
    }, remaining);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function start(minutes) {
    const mins = Number(minutes);
    if (!Number.isFinite(mins) || mins <= 0) return false;
    endsAt = now() + Math.round(mins * 60 * 1000);
    if (!active) {
      active = true;
      // Snapshot first: enabling DND rebuilds menus, which read getState().
      hidPet = !isPetHidden();
      enabledDnd = !isDnd();
      if (enabledDnd) enableDnd();
      if (hidPet) hidePet();
      log(`meeting mode on: ${mins} min (hidPet=${hidPet} enabledDnd=${enabledDnd})`);
    } else {
      log(`meeting mode extended: ${mins} min`);
    }
    armTimer();
    onChange(getState());
    return true;
  }

  function end(reason = "manual") {
    if (!active || ending) return false;
    ending = true;
    try {
      clearPendingTimer();
      active = false;
      endsAt = 0;
      const restoreDnd = enabledDnd;
      const restorePet = hidPet;
      hidPet = false;
      enabledDnd = false;
      log(`meeting mode off: ${reason} (showPet=${restorePet} disableDnd=${restoreDnd})`);
      // DND first, so the wake animation starts while the pet comes back.
      if (restoreDnd && isDnd()) disableDnd();
      if (restorePet && isPetHidden()) showPet();
    } finally {
      ending = false;
    }
    onChange(getState());
    return true;
  }

  function checkExpiry() {
    if (!active) return false;
    if (now() >= endsAt) return end("timeout");
    armTimer();
    return false;
  }

  // The user showed the pet or woke Clawd themselves: that ends the meeting.
  // Called by main.js before it applies the user's own action, so the restore
  // never fights it. Returns true when meeting mode was active.
  function noteUserOverride(reason) {
    if (!active || ending) return false;
    return end(reason);
  }

  function isActive() {
    return active;
  }

  function isEnding() {
    return ending;
  }

  function getState() {
    return { active, endsAt: active ? endsAt : 0 };
  }

  function dispose() {
    clearPendingTimer();
  }

  return { start, end, checkExpiry, noteUserOverride, isActive, isEnding, getState, dispose };
}

function formatMeetingEndTime(endsAt, lang) {
  const date = new Date(endsAt);
  try {
    return date.toLocaleTimeString(lang || undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
}

module.exports = {
  MEETING_MODE_DURATIONS_MIN,
  createMeetingModeController,
  formatMeetingEndTime,
};
