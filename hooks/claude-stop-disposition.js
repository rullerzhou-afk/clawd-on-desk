"use strict";

const HEADLESS_COMPLETION_DEBOUNCE_MS = 2000;
const BACKGROUND_TASKS_COMPLETION_DEBOUNCE_MS = 2000;

function getCompletionDebounceMs(headless, env = process.env) {
  const n = Number.parseInt(env && env.CLAWD_COMPLETION_DEBOUNCE_MS, 10);
  if (Number.isFinite(n) && n >= 0 && n <= 10000) return n;
  return headless ? HEADLESS_COMPLETION_DEBOUNCE_MS : 0;
}

function getBackgroundTasksCompletionDebounceMs(headless, env = process.env) {
  const n = Number.parseInt(env && env.CLAWD_COMPLETION_DEBOUNCE_MS, 10);
  if (Number.isFinite(n) && n >= 0 && n <= 10000) return n;
  return Math.max(getCompletionDebounceMs(headless, env), BACKGROUND_TASKS_COMPLETION_DEBOUNCE_MS);
}

function getClaudeStopDisposition(options = {}) {
  const backgroundTasksCount = Number(options.backgroundTasksCount) || 0;
  const backgroundSubagentsCount = Number.isSafeInteger(options.backgroundSubagentsCount)
    && options.backgroundSubagentsCount >= 0
    ? options.backgroundSubagentsCount
    : 0;
  const sessionCronsCount = Number(options.sessionCronsCount) || 0;
  const stopHookActive = options.stopHookActive === true;
  const hasFinalAssistantText = options.hasFinalAssistantText === true;
  const headless = options.headless === true;
  const hardLiveWork = backgroundSubagentsCount > 0
    || sessionCronsCount > 0
    || stopHookActive
    || (backgroundTasksCount > 0 && !hasFinalAssistantText);
  if (hardLiveWork) return { kind: "hold", debounceMs: 0 };
  const backgroundDebounceMs = backgroundTasksCount > 0 && hasFinalAssistantText
    ? getBackgroundTasksCompletionDebounceMs(headless, options.env)
    : 0;
  const debounceMs = Math.max(getCompletionDebounceMs(headless, options.env), backgroundDebounceMs);
  return debounceMs > 0
    ? { kind: "debounce", debounceMs }
    : { kind: "complete", debounceMs: 0 };
}

module.exports = {
  HEADLESS_COMPLETION_DEBOUNCE_MS,
  BACKGROUND_TASKS_COMPLETION_DEBOUNCE_MS,
  getCompletionDebounceMs,
  getBackgroundTasksCompletionDebounceMs,
  getClaudeStopDisposition,
};
