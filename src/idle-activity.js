"use strict";

// src/idle-activity.js — opt-in idle activity mode (#1252)
//
// Most themes ship a dozen state animations, but users without an active agent
// usually see only idle, sleep and roam. This opt-in mode occasionally shows
// another state's visual for a few seconds.
//
// The logical state stays idle throughout. Duration starts at committed display;
// return to rest only while this beat still owns the visual, so reactions and
// real state changes always win.
// Starts are tick-driven and re-check canPlay. Each real idle entry gets the
// shorter first delay; automatic walks preserve the existing idle period.
// Picks come from the theme's states, excluding alerts and sleep/roam machinery.

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
  const restoreIdleVisual = options.restoreIdleVisual || (() => {});
  const isVisualGenerationCurrent = options.isVisualGenerationCurrent || (() => true);
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
    const attempt = playing;
    playing = null;
    if (getCurrentState() === "idle" && isVisualGenerationCurrent(attempt.visualGeneration)) {
      restoreIdleVisual();
    }
    if (enabled) schedule(false);
  }

  function abandon() {
    clearRestoreTimer();
    playing = null;
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
    const attempt = {
      state: state.state,
      svg,
      duration: pickDuration(theme, state.state, random),
      visualGeneration: null,
      committed: false,
    };
    playing = attempt;
    const onLogicalSettlement = (settlement) => {
      if (playing !== attempt) return;
      if (
        !settlement
        || settlement.status !== "committed"
        || !Number.isSafeInteger(settlement.visualGeneration)
        || getCurrentState() !== "idle"
        || !isVisualGenerationCurrent(settlement.visualGeneration)
      ) {
        abandon();
        return;
      }
      // Timeout recovery can commit a newer generation than the original send.
      attempt.visualGeneration = settlement.visualGeneration;
      attempt.committed = true;
      restoreTimer = setTimer(finish, attempt.duration);
    };
    const request = sendToRenderer("state-change", "idle", svg, { onLogicalSettlement });
    const visualGeneration = request && request.visualGeneration;
    if (!Number.isSafeInteger(visualGeneration)) {
      abandon();
      return;
    }
    attempt.visualGeneration = visualGeneration;
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
      const shouldRestore = isAnimating() && getCurrentState() === "idle";
      cancel();
      if (shouldRestore) restoreIdleVisual();
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
    return playing !== null
      && (!playing.committed || isVisualGenerationCurrent(playing.visualGeneration));
  }

  function noteIdleEntered() {
    nextAt = null;
  }

  return {
    setEnabled,
    setFrequency,
    tick,
    cancel,
    isAnimating,
    noteIdleEntered,
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
