"use strict";

// src/idle-activity.js — opt-in idle activity mode (#1252)
//
// While the pet is idle (no agent session in progress), occasionally play one
// of the theme's other state visuals (thinking / working / juggling / happy /
// sweeping / carrying / …) for a few seconds, then hand the resting idle
// visual back. The point is purely cosmetic: most themes ship a dozen state
// animations, but a user who only runs Claude Desktop (or simply isn't running
// an agent) never sees anything except idle, sleep and roam.
//
// Design notes:
//   • The logical state stays "idle" the whole time. The controller sends
//     state-change straight to the renderer with an explicit SVG, exactly like
//     tick.js's existing idle-animation playback, so no session, priority,
//     roam or sleep state is touched. A real agent event replaces the visual
//     through the normal applyState() path and immediately wins.
//   • Scheduling is tick-driven, not timer-driven: tick.js calls tick() while
//     the pet is idle, and a paused idle period simply stops calling it. Only
//     the restore is timer-based, so the visual comes back on time even when a
//     tick is slow.
//   • Every start re-checks the environment (canPlay) — Do Not Disturb, low
//     power idle, sleep, mini mode, drag, menus, permission bubbles, settings
//     previews and hidden windows all hold the activity.
//   • The pickable set is derived from the active theme's states, so custom
//     themes with their own state names (happy, typing, building, …) work
//     without a schema change. Alert-semantics states (error, notification)
//     and the sleep/roam machinery are excluded.
//   • Frequency only changes the gap between activities; the first activity
//     after idle begins uses a shorter delay so the mode is actually visible
//     before the mouse-idle sleep sequence ends.

const IDLE_ACTIVITY_FREQUENCIES = Object.freeze({
  low: { first: [30_000, 45_000], repeat: [120_000, 180_000] },
  medium: { first: [20_000, 30_000], repeat: [60_000, 100_000] },
  high: { first: [12_000, 18_000], repeat: [30_000, 50_000] },
});

const DEFAULT_FREQUENCY = "medium";
const DEFAULT_DURATION_MS = 3000;
const MIN_DURATION_MS = 2000;
const MAX_DURATION_MS = 8000;
const RETRY_MS = 4000;

// States that must never be picked as an idle activity:
//   • idle / roam / sleep-sequence states are the resting machinery itself;
//   • error and notification carry alert semantics — replaying them at random
//     would look like a failure or a pending permission request;
//   • dizzy is an interaction reaction;
//   • mini-* belong to the mini window and are filtered by prefix.
// attention (the "happy" completion animation) stays eligible: it is the
// celebration the feature exists to surface.
const EXCLUDED_STATES = new Set([
  "idle",
  "roam",
  "sleeping",
  "waking",
  "yawning",
  "dozing",
  "collapsing",
  "error",
  "notification",
  "dizzy",
]);

function normalizeFrequency(value) {
  return typeof value === "string"
    && Object.prototype.hasOwnProperty.call(IDLE_ACTIVITY_FREQUENCIES, value)
    ? value
    : DEFAULT_FREQUENCY;
}

function listIdleActivityStates(theme) {
  const states = theme && theme.states;
  if (!states || typeof states !== "object") return [];
  const result = [];
  for (const [state, files] of Object.entries(states)) {
    if (EXCLUDED_STATES.has(state) || state.startsWith("mini-")) continue;
    if (!Array.isArray(files)) continue;
    const usable = files.filter((file) => typeof file === "string" && file);
    if (usable.length > 0) result.push({ state, files: usable });
  }
  return result;
}

function pickDuration(theme, state, random) {
  const autoReturn = theme && theme.timings && theme.timings.autoReturn;
  const configured = autoReturn && Number(autoReturn[state]);
  const base = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DURATION_MS;
  // ±15% jitter keeps repeated activities from feeling metronomic. Clamp after
  // the jitter: sweeping's autoReturn is the 5-minute compaction hold, which is
  // far longer than a decorative beat should last.
  const jittered = Math.round(base * (0.85 + random() * 0.3));
  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, jittered));
}

function pickFrom(list, random) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const index = Math.floor(random() * list.length);
  return list[Math.min(list.length - 1, Math.max(0, index))];
}

function createIdleActivityController(options = {}) {
  const getTheme = options.getTheme || (() => null);
  const getCurrentState = options.getCurrentState || (() => "idle");
  const canPlay = options.canPlay || (() => true);
  const getIdleRestSvg = options.getIdleRestSvg || (() => null);
  const sendToRenderer = options.sendToRenderer || (() => {});
  const random = typeof options.random === "function" ? options.random : Math.random;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const setTimer = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;

  let enabled = false;
  let frequency = DEFAULT_FREQUENCY;
  let nextAt = null;
  let playing = null;
  let restoreTimer = null;

  function clearRestoreTimer() {
    if (restoreTimer) {
      clearTimer(restoreTimer);
      restoreTimer = null;
    }
  }

  function schedule(first) {
    const ranges = IDLE_ACTIVITY_FREQUENCIES[frequency];
    const [min, max] = first ? ranges.first : ranges.repeat;
    nextAt = now() + min + Math.floor(random() * Math.max(1, max - min));
  }

  function finish() {
    clearRestoreTimer();
    if (!playing) return;
    playing = null;
    // A real state change (agent event, reaction, sleep) has already taken the
    // visual; only hand the resting idle sprite back when the pet is still
    // logically idle.
    if (getCurrentState() === "idle") {
      const rest = getIdleRestSvg();
      if (rest) sendToRenderer("state-change", "idle", rest);
    }
    if (enabled) schedule(false);
  }

  function play() {
    const theme = getTheme();
    const states = listIdleActivityStates(theme);
    if (states.length === 0) {
      nextAt = now() + RETRY_MS;
      return;
    }
    const state = pickFrom(states, random);
    const svg = pickFrom(state.files, random);
    if (!state || !svg) {
      nextAt = now() + RETRY_MS;
      return;
    }
    playing = { state: state.state, svg, duration: pickDuration(theme, state.state, random) };
    sendToRenderer("state-change", "idle", svg);
    restoreTimer = setTimer(finish, playing.duration);
  }

  // Called by tick.js while the pet is idle. Scheduling is deliberately
  // tick-driven so a working/sleeping pet never even arms a wake-up.
  function tick() {
    if (!enabled || playing) return;
    if (getCurrentState() !== "idle") return;
    // Arm the first-delay clock even while a gate is closed, so the beat is
    // ready the moment the pet becomes eligible again instead of starting a
    // fresh full delay.
    if (nextAt == null) {
      schedule(true);
      return;
    }
    if (!canPlay()) {
      if (now() >= nextAt) nextAt = now() + RETRY_MS;
      return;
    }
    if (now() < nextAt) return;
    play();
  }

  function setEnabled(value) {
    const next = !!value;
    if (next === enabled) return;
    enabled = next;
    if (!enabled) {
      cancel();
      return;
    }
    // Start the first-delay clock on the next idle tick.
    nextAt = null;
  }

  function setFrequency(value) {
    const next = normalizeFrequency(value);
    if (next === frequency) return;
    frequency = next;
    // Re-time the next activity, but never cut a beat that is already playing.
    if (enabled && !playing) nextAt = null;
  }

  function cancel() {
    clearRestoreTimer();
    playing = null;
    nextAt = null;
  }

  function isAnimating() {
    return playing !== null;
  }

  return {
    setEnabled,
    setFrequency,
    tick,
    cancel,
    isAnimating,
    get enabled() {
      return enabled;
    },
    get frequency() {
      return frequency;
    },
  };
}

module.exports = {
  IDLE_ACTIVITY_FREQUENCIES,
  DEFAULT_FREQUENCY,
  EXCLUDED_STATES,
  createIdleActivityController,
  listIdleActivityStates,
  normalizeFrequency,
  pickDuration,
};
