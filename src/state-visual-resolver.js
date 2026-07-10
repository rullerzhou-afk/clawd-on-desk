"use strict";

const { VISUAL_FALLBACK_STATES } = require("./theme-loader");

function buildStateBindings(nextTheme) {
  const bindings = {};
  const sourceBindings = nextTheme && nextTheme._stateBindings;
  if (sourceBindings && typeof sourceBindings === "object") {
    for (const [stateKey, entry] of Object.entries(sourceBindings)) {
      bindings[stateKey] = {
        files: Array.isArray(entry && entry.files) ? [...entry.files] : [],
        fallbackTo: typeof (entry && entry.fallbackTo) === "string" && entry.fallbackTo ? entry.fallbackTo : null,
      };
    }
  }
  if (nextTheme && nextTheme.states) {
    for (const [stateKey, files] of Object.entries(nextTheme.states)) {
      const normalizedFiles = Array.isArray(files) ? [...files] : [];
      if (!bindings[stateKey]) {
        bindings[stateKey] = { files: normalizedFiles, fallbackTo: null };
      } else if (bindings[stateKey].files.length === 0) {
        bindings[stateKey].files = normalizedFiles;
      }
    }
  }
  if (nextTheme && nextTheme.miniMode && nextTheme.miniMode.states) {
    for (const [stateKey, files] of Object.entries(nextTheme.miniMode.states)) {
      bindings[stateKey] = {
        files: Array.isArray(files) ? [...files] : [],
        fallbackTo: null,
      };
    }
  }
  // Ensure "roam" binding exists — free-roam mode switches to this visual
  // state while walking. Themes that provide roam SVGs get them; others
  // fall back to idle so the pet at least shows the idle animation instead
  // of being "dragged" with no visual change.
  //
  // Also inject a placeholder into nextTheme.states so that
  // theme-variants.applyUserOverridesPatch can resolve the target collection
  // for "roam" overrides (otherwise it skips states not present in raw.states).
  if (!bindings.roam) {
    bindings.roam = { files: [], fallbackTo: "idle" };
  }
  if (nextTheme && nextTheme.states && !Array.isArray(nextTheme.states.roam)) {
    const idleDefault = (nextTheme.states.idle && Array.isArray(nextTheme.states.idle)
      && nextTheme.states.idle.length > 0)
      ? nextTheme.states.idle[0]
      : "idle.svg";
    nextTheme.states.roam = [idleDefault];
  }
  return bindings;
}

function pickStateFile(files, randomFn = Math.random) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const random = typeof randomFn === "function" ? randomFn : Math.random;
  return files[Math.floor(random() * files.length)];
}

function hasOwnVisualFiles(stateBindings, state) {
  const entry = stateBindings && stateBindings[state];
  return !!(entry && Array.isArray(entry.files) && entry.files.length > 0);
}

function resolveVisualBinding(state, stateBindings, options = {}) {
  const pickFile = typeof options.pickStateFile === "function" ? options.pickStateFile : pickStateFile;
  let cursor = state;
  let visited = null;
  for (let hops = 0; hops <= 3; hops += 1) {
    const entry = stateBindings && stateBindings[cursor];
    if (entry && Array.isArray(entry.files) && entry.files.length > 0) {
      return pickFile(entry.files);
    }
    if (!entry || !entry.fallbackTo || !VISUAL_FALLBACK_STATES.has(cursor)) break;
    if (!visited) visited = new Set([cursor]);
    if (visited.has(entry.fallbackTo)) break;
    visited.add(entry.fallbackTo);
    cursor = entry.fallbackTo;
  }
  const idleEntry = stateBindings && stateBindings.idle;
  if (idleEntry && Array.isArray(idleEntry.files) && idleEntry.files.length > 0) {
    return pickFile(idleEntry.files);
  }
  return null;
}

function normalizeSessionsIterable(sessions) {
  if (!sessions) return [];
  if (sessions instanceof Map) return sessions.entries();
  if (typeof sessions[Symbol.iterator] === "function") return sessions;
  return [];
}

function countActiveSessionsByStates(sessions, states) {
  let count = 0;
  for (const [, session] of normalizeSessionsIterable(sessions)) {
    if (!session.headless && states.has(session.state)) count += 1;
  }
  return count;
}

function selectTieredStateFile(tiers, count, fallbackFile) {
  if (tiers) {
    for (const tier of tiers) {
      if (count >= tier.minSessions) return tier.file;
    }
  }
  return fallbackFile;
}

function getWorkingSvg(options = {}) {
  const count = countActiveSessionsByStates(
    options.sessions,
    new Set(["working", "thinking", "juggling"])
  );
  const stateSvgs = options.stateSvgs;
  return selectTieredStateFile(
    options.theme && options.theme.workingTiers,
    count,
    stateSvgs.working[0]
  );
}

function getJugglingSvg(options = {}) {
  const count = countActiveSessionsByStates(
    options.sessions,
    new Set(["juggling"])
  );
  const stateSvgs = options.stateSvgs;
  return selectTieredStateFile(
    options.theme && options.theme.jugglingTiers,
    count,
    stateSvgs.juggling[0]
  );
}

function getWinningSessionDisplayHint(sessions, targetState, displayHintMap = {}) {
  let best = null;
  let bestAt = -1;
  for (const [, session] of normalizeSessionsIterable(sessions)) {
    if (session.headless || session.state !== targetState) continue;
    if (session.updatedAt >= bestAt) {
      bestAt = session.updatedAt;
      best = session;
    }
  }
  if (!best || !best.displayHint) return null;
  const resolved = displayHintMap[best.displayHint];
  return resolved || null;
}

function getSvgOverride(state, options = {}) {
  if (options.updateVisualState && state === options.updateVisualState && options.updateVisualSvgOverride) {
    return options.updateVisualSvgOverride;
  }
  if (state === "idle") return options.idleFollowSvg;
  if (state === "working") {
    const hinted = getWinningSessionDisplayHint(options.sessions, "working", options.displayHintMap);
    if (hinted) return hinted;
    return getWorkingSvg(options);
  }
  if (state === "juggling") {
    const hinted = getWinningSessionDisplayHint(options.sessions, "juggling", options.displayHintMap);
    if (hinted) return hinted;
    return getJugglingSvg(options);
  }
  if (state === "thinking") {
    const hinted = getWinningSessionDisplayHint(options.sessions, "thinking", options.displayHintMap);
    if (hinted) return hinted;
    const stateSvgs = options.stateSvgs;
    return stateSvgs.thinking[0];
  }
  return null;
}

module.exports = {
  buildStateBindings,
  pickStateFile,
  hasOwnVisualFiles,
  resolveVisualBinding,
  countActiveSessionsByStates,
  selectTieredStateFile,
  getWorkingSvg,
  getJugglingSvg,
  getWinningSessionDisplayHint,
  getSvgOverride,
};
