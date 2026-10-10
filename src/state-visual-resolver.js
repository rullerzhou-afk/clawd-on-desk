"use strict";

const { VISUAL_FALLBACK_STATES } = require("./theme-loader");
const { getTierFiles } = require("./theme-schema");
const { getSubagentVisualCount } = require("./subagent-lifecycle");

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

// #862: the juggling tier keys off how many subagents are live, not how many
// sessions sit in `juggling` — one session can host several at once, and
// counting sessions left that case stuck on the 1-subagent asset forever.
// A tracker distinguishes trusted child ids from bounded anonymous/recovery
// floors. Sessions created by older callers without a tracker retain the old
// one-session floor for backward compatibility.
function countLiveSubagents(sessions) {
  let count = 0;
  for (const [, session] of normalizeSessionsIterable(sessions)) {
    if (session.headless || session.state !== "juggling") continue;
    const live = session.subagentTracker
      ? getSubagentVisualCount(session)
      : 1;
    count += live;
  }
  return count;
}

// Candidate files of the first tier the count reaches, or the fallback list.
function selectTieredStateFiles(tiers, count, fallbackFiles) {
  if (tiers) {
    for (const tier of tiers) {
      if (count >= tier.minSessions) return getTierFiles(tier);
    }
  }
  return Array.isArray(fallbackFiles) ? fallbackFiles : [];
}

function pickFirstFile(state, files) {
  return Array.isArray(files) && files.length > 0 ? files[0] : null;
}

// thinking / working / juggling are resolved again on every hook event, so a
// fresh random pick per call would swap the clip on each tool call. Keep one
// pick per state while its candidate list stays the same: the pool is drawn
// again when the state is entered anew (callers drop the other states' picks
// when a state is applied, see retainOnly) or when the list itself changes,
// e.g. the working tier moves with the session count.
function createStableVisualPicker(randomFn) {
  const picks = new Map();
  return {
    pick(state, files) {
      if (!Array.isArray(files) || files.length === 0) return null;
      if (files.length === 1) return files[0];
      const signature = files.join("\n");
      const held = picks.get(state);
      if (held && held.signature === signature) return held.file;
      const file = pickStateFile(files, randomFn);
      picks.set(state, { signature, file });
      return file;
    },
    retainOnly(state) {
      for (const key of [...picks.keys()]) {
        if (key !== state) picks.delete(key);
      }
    },
    clear() {
      picks.clear();
    },
  };
}

function getPickVisualFile(options) {
  return typeof options.pickVisualFile === "function" ? options.pickVisualFile : pickFirstFile;
}

function getWorkingSvg(options = {}) {
  const count = countActiveSessionsByStates(
    options.sessions,
    new Set(["working", "thinking", "juggling"])
  );
  const stateSvgs = options.stateSvgs;
  return getPickVisualFile(options)("working", selectTieredStateFiles(
    options.theme && options.theme.workingTiers,
    count,
    stateSvgs.working
  ));
}

function getJugglingSvg(options = {}) {
  const count = countLiveSubagents(options.sessions);
  const stateSvgs = options.stateSvgs;
  return getPickVisualFile(options)("juggling", selectTieredStateFiles(
    options.theme && options.theme.jugglingTiers,
    count,
    stateSvgs.juggling
  ));
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
  // #509: a user-selected default idle visual wins over the follow sprite.
  if (state === "idle") return options.idleDefaultVisual || options.idleFollowSvg;
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
    return getPickVisualFile(options)("thinking", stateSvgs.thinking);
  }
  return null;
}

module.exports = {
  buildStateBindings,
  pickStateFile,
  createStableVisualPicker,
  hasOwnVisualFiles,
  resolveVisualBinding,
  countActiveSessionsByStates,
  countLiveSubagents,
  selectTieredStateFiles,
  getWorkingSvg,
  getJugglingSvg,
  getWinningSessionDisplayHint,
  getSvgOverride,
};
