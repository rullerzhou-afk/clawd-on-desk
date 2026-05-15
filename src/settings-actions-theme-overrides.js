"use strict";

const { normalizeThemeOverrides } = require("./prefs");
const { requireString } = require("./settings-validators");
const { isPlainObject } = require("./theme-loader");

const ANIMATION_OVERRIDES_EXPORT_VERSION = 1;

const THEME_OVERRIDE_RESERVED_KEYS = new Set([
  "states",
  "tiers",
  "timings",
  "idleAnimations",
  "reactions",
  "hitbox",
  "sounds",
]);
const TIER_OVERRIDE_GROUPS = new Set(["workingTiers", "jugglingTiers"]);
const REACTION_KEYS = new Set(["drag", "clickLeft", "clickRight", "annoyed", "double"]);

const ONESHOT_OVERRIDE_STATES = new Set([
  "attention",
  "error",
  "sweeping",
  "notification",
  "carrying",
]);

function cloneStateOverrides(themeMap) {
  const out = {};
  if (!isPlainObject(themeMap)) return out;
  if (isPlainObject(themeMap.states)) {
    for (const [stateKey, entry] of Object.entries(themeMap.states)) {
      if (isPlainObject(entry)) out[stateKey] = { ...entry };
    }
  }
  for (const [key, entry] of Object.entries(themeMap)) {
    if (THEME_OVERRIDE_RESERVED_KEYS.has(key)) continue;
    if (!out[key] && isPlainObject(entry)) out[key] = { ...entry };
  }
  return out;
}

function cloneFileKeyedMap(map) {
  const out = {};
  if (!isPlainObject(map)) return out;
  for (const [originalFile, entry] of Object.entries(map)) {
    if (isPlainObject(entry)) out[originalFile] = { ...entry };
  }
  return out;
}

function cloneTierOverrides(themeMap, tierGroup) {
  if (!isPlainObject(themeMap) || !isPlainObject(themeMap.tiers)) return {};
  return cloneFileKeyedMap(themeMap.tiers[tierGroup]);
}

function cloneAutoReturnOverrides(themeMap) {
  const out = {};
  if (!isPlainObject(themeMap) || !isPlainObject(themeMap.timings)) return out;
  const autoReturn = themeMap.timings.autoReturn;
  if (!isPlainObject(autoReturn)) return out;
  for (const [stateKey, value] of Object.entries(autoReturn)) {
    if (typeof value === "number" && Number.isFinite(value)) out[stateKey] = value;
  }
  return out;
}

function cloneIdleAnimationOverrides(themeMap) {
  if (!isPlainObject(themeMap)) return {};
  return cloneFileKeyedMap(themeMap.idleAnimations);
}

function cloneReactionOverrides(themeMap) {
  const out = {};
  if (!isPlainObject(themeMap) || !isPlainObject(themeMap.reactions)) return out;
  for (const [reactionKey, entry] of Object.entries(themeMap.reactions)) {
    if (isPlainObject(entry)) out[reactionKey] = { ...entry };
  }
  return out;
}

function cloneHitboxOverrides(themeMap) {
  const out = {};
  if (!isPlainObject(themeMap) || !isPlainObject(themeMap.hitbox)) return out;
  for (const [groupKey, entry] of Object.entries(themeMap.hitbox)) {
    if (isPlainObject(entry)) out[groupKey] = { ...entry };
  }
  return out;
}

function cloneSoundOverrides(themeMap) {
  const out = {};
  if (!isPlainObject(themeMap) || !isPlainObject(themeMap.sounds)) return out;
  for (const [soundName, entry] of Object.entries(themeMap.sounds)) {
    if (isPlainObject(entry)) out[soundName] = { ...entry };
  }
  return out;
}

function buildThemeOverrideMap({
  states,
  workingTiers,
  jugglingTiers,
  autoReturn,
  idleAnimations,
  reactions,
  hitbox,
  sounds,
}) {
  const out = {};
  if (states && Object.keys(states).length > 0) out.states = states;
  const tiers = {};
  if (workingTiers && Object.keys(workingTiers).length > 0) tiers.workingTiers = workingTiers;
  if (jugglingTiers && Object.keys(jugglingTiers).length > 0) tiers.jugglingTiers = jugglingTiers;
  if (Object.keys(tiers).length > 0) out.tiers = tiers;
  if (autoReturn && Object.keys(autoReturn).length > 0) out.timings = { autoReturn };
  if (idleAnimations && Object.keys(idleAnimations).length > 0) out.idleAnimations = idleAnimations;
  if (reactions && Object.keys(reactions).length > 0) out.reactions = reactions;
  if (hitbox && Object.keys(hitbox).length > 0) out.hitbox = hitbox;
  if (sounds && Object.keys(sounds).length > 0) out.sounds = sounds;
  return out;
}

function normalizeTransitionPayload(transition) {
  if (!isPlainObject(transition)) return null;
  const out = {};
  if (typeof transition.in === "number" && Number.isFinite(transition.in) && transition.in >= 0) out.in = transition.in;
  if (typeof transition.out === "number" && Number.isFinite(transition.out) && transition.out >= 0) out.out = transition.out;
  return Object.keys(out).length > 0 ? out : null;
}

function transitionMatchesThemeDefault(transition, defaultTransition) {
  if (!transition || !defaultTransition) return false;
  return transition.in === defaultTransition.in && transition.out === defaultTransition.out;
}

const _validateThemeOverrideThemeId = requireString("setThemeOverrideDisabled.themeId");
function setThemeOverrideDisabled(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "setThemeOverrideDisabled: payload must be an object" };
  }
  const { themeId, stateKey, disabled } = payload;
  const idCheck = _validateThemeOverrideThemeId(themeId);
  if (idCheck.status !== "ok") return idCheck;
  if (typeof stateKey !== "string" || !ONESHOT_OVERRIDE_STATES.has(stateKey)) {
    return {
      status: "error",
      message: `setThemeOverrideDisabled.stateKey must be one of: ${[...ONESHOT_OVERRIDE_STATES].join(", ")}`,
    };
  }
  if (typeof disabled !== "boolean") {
    return { status: "error", message: "setThemeOverrideDisabled.disabled must be a boolean" };
  }

  const snapshot = (deps && deps.snapshot) || {};
  const currentOverrides = snapshot.themeOverrides || {};
  const currentThemeMap = currentOverrides[themeId] || {};
  const currentStates = cloneStateOverrides(currentThemeMap);
  const currentEntry = currentStates[stateKey];
  const currentDisabled = !!(currentEntry && currentEntry.disabled === true);
  if (currentDisabled === disabled) {
    return { status: "ok", noop: true };
  }

  const nextStates = { ...currentStates };
  if (disabled) {
    nextStates[stateKey] = { ...(currentEntry || {}), disabled: true };
  } else {
    const preserved = { ...(currentEntry || {}) };
    delete preserved.disabled;
    if (Object.keys(preserved).length > 0) nextStates[stateKey] = preserved;
    else delete nextStates[stateKey];
  }

  const nextThemeMap = buildThemeOverrideMap({
    states: nextStates,
    workingTiers: cloneTierOverrides(currentThemeMap, "workingTiers"),
    jugglingTiers: cloneTierOverrides(currentThemeMap, "jugglingTiers"),
    autoReturn: cloneAutoReturnOverrides(currentThemeMap),
    idleAnimations: cloneIdleAnimationOverrides(currentThemeMap),
    reactions: cloneReactionOverrides(currentThemeMap),
    hitbox: cloneHitboxOverrides(currentThemeMap),
    sounds: cloneSoundOverrides(currentThemeMap),
  });
  const nextOverrides = { ...currentOverrides };
  if (Object.keys(nextThemeMap).length > 0) {
    nextOverrides[themeId] = nextThemeMap;
  } else {
    delete nextOverrides[themeId];
  }
  return { status: "ok", commit: { themeOverrides: nextOverrides } };
}

const _validateAnimationOverrideThemeId = requireString("setAnimationOverride.themeId");
function setAnimationOverride(payload, deps) {
  if (!isPlainObject(payload)) {
    return { status: "error", message: "setAnimationOverride: payload must be an object" };
  }
  const { themeId, slotType } = payload;
  const idCheck = _validateAnimationOverrideThemeId(themeId);
  if (idCheck.status !== "ok") return idCheck;
  if (slotType !== "state" && slotType !== "tier" && slotType !== "idleAnimation" && slotType !== "reaction") {
    return { status: "error", message: "setAnimationOverride.slotType must be 'state', 'tier', 'idleAnimation', or 'reaction'" };
  }

  const touchesFile = Object.prototype.hasOwnProperty.call(payload, "file");
  const touchesTransition = Object.prototype.hasOwnProperty.call(payload, "transition");
  const touchesAutoReturn = Object.prototype.hasOwnProperty.call(payload, "autoReturnMs");
  const touchesDuration = Object.prototype.hasOwnProperty.call(payload, "durationMs");
  if (!touchesFile && !touchesTransition && !touchesAutoReturn && !touchesDuration) {
    return { status: "error", message: "setAnimationOverride must change file, transition, autoReturnMs, or durationMs" };
  }

  if (touchesFile && payload.file !== null && (typeof payload.file !== "string" || !payload.file)) {
    return { status: "error", message: "setAnimationOverride.file must be null or a non-empty string" };
  }
  if (touchesTransition && payload.transition !== null && !normalizeTransitionPayload(payload.transition)) {
    return { status: "error", message: "setAnimationOverride.transition must contain finite non-negative in/out values" };
  }
  const normalizedTransition = touchesTransition && payload.transition !== null
    ? normalizeTransitionPayload(payload.transition)
    : null;
  const normalizedTransitionDefault = normalizeTransitionPayload(payload.transitionThemeDefault);
  const transitionMatchesDefault = !!(touchesTransition
    && normalizedTransition
    && transitionMatchesThemeDefault(normalizedTransition, normalizedTransitionDefault));
  if (touchesAutoReturn && payload.autoReturnMs !== null) {
    if (typeof payload.autoReturnMs !== "number" || !Number.isFinite(payload.autoReturnMs)) {
      return { status: "error", message: "setAnimationOverride.autoReturnMs must be null or a finite number" };
    }
    if (payload.autoReturnMs < 500 || payload.autoReturnMs > 60000) {
      return { status: "error", message: "setAnimationOverride.autoReturnMs must be between 500 and 60000" };
    }
  }
  if (touchesDuration && payload.durationMs !== null) {
    if (typeof payload.durationMs !== "number" || !Number.isFinite(payload.durationMs)) {
      return { status: "error", message: "setAnimationOverride.durationMs must be null or a finite number" };
    }
    if (payload.durationMs < 500 || payload.durationMs > 60000) {
      return { status: "error", message: "setAnimationOverride.durationMs must be between 500 and 60000" };
    }
  }

  const snapshot = (deps && deps.snapshot) || {};
  const currentOverrides = snapshot.themeOverrides || {};
  const currentThemeMap = currentOverrides[themeId] || {};
  const nextStates = cloneStateOverrides(currentThemeMap);
  const nextWorkingTiers = cloneTierOverrides(currentThemeMap, "workingTiers");
  const nextJugglingTiers = cloneTierOverrides(currentThemeMap, "jugglingTiers");
  const nextAutoReturn = cloneAutoReturnOverrides(currentThemeMap);
  const nextIdleAnimations = cloneIdleAnimationOverrides(currentThemeMap);
  const nextReactions = cloneReactionOverrides(currentThemeMap);
  const nextHitbox = cloneHitboxOverrides(currentThemeMap);
  const nextSounds = cloneSoundOverrides(currentThemeMap);

  if (slotType === "state") {
    if (typeof payload.stateKey !== "string" || !payload.stateKey) {
      return { status: "error", message: "setAnimationOverride.stateKey must be a non-empty string for state slots" };
    }
    if (touchesDuration) {
      return { status: "error", message: "setAnimationOverride.durationMs is only supported for idleAnimation slots" };
    }
    const stateKey = payload.stateKey;
    const nextEntry = { ...(nextStates[stateKey] || {}) };
    if (touchesFile) {
      if (payload.file === null) {
        delete nextEntry.file;
        delete nextEntry.sourceThemeId;
      } else {
        nextEntry.file = payload.file;
      }
    }
    if (touchesTransition) {
      if (payload.transition === null || transitionMatchesDefault) delete nextEntry.transition;
      else nextEntry.transition = normalizedTransition;
    }
    if (Object.keys(nextEntry).length > 0) nextStates[stateKey] = nextEntry;
    else delete nextStates[stateKey];

    if (touchesAutoReturn) {
      if (payload.autoReturnMs === null) delete nextAutoReturn[stateKey];
      else nextAutoReturn[stateKey] = payload.autoReturnMs;
    }
  } else if (slotType === "tier") {
    const { tierGroup, originalFile } = payload;
    if (!TIER_OVERRIDE_GROUPS.has(tierGroup)) {
      return { status: "error", message: "setAnimationOverride.tierGroup must be workingTiers or jugglingTiers" };
    }
    if (typeof originalFile !== "string" || !originalFile) {
      return { status: "error", message: "setAnimationOverride.originalFile must be a non-empty string for tier slots" };
    }
    if (touchesAutoReturn) {
      return { status: "error", message: "setAnimationOverride.autoReturnMs is only supported for state slots" };
    }
    if (touchesDuration) {
      return { status: "error", message: "setAnimationOverride.durationMs is not supported for tier slots" };
    }
    const tierMap = tierGroup === "workingTiers" ? nextWorkingTiers : nextJugglingTiers;
    const nextEntry = { ...(tierMap[originalFile] || {}) };
    if (touchesFile) {
      if (payload.file === null) {
        delete nextEntry.file;
        delete nextEntry.sourceThemeId;
      } else {
        nextEntry.file = payload.file;
      }
    }
    if (touchesTransition) {
      if (payload.transition === null || transitionMatchesDefault) delete nextEntry.transition;
      else nextEntry.transition = normalizedTransition;
    }
    if (Object.keys(nextEntry).length > 0) tierMap[originalFile] = nextEntry;
    else delete tierMap[originalFile];
  } else if (slotType === "idleAnimation") {
    const { originalFile } = payload;
    if (typeof originalFile !== "string" || !originalFile) {
      return { status: "error", message: "setAnimationOverride.originalFile must be a non-empty string for idleAnimation slots" };
    }
    if (touchesAutoReturn) {
      return { status: "error", message: "setAnimationOverride.autoReturnMs is not supported for idleAnimation slots" };
    }
    const nextEntry = { ...(nextIdleAnimations[originalFile] || {}) };
    if (touchesFile) {
      if (payload.file === null) {
        delete nextEntry.file;
        delete nextEntry.sourceThemeId;
      } else {
        nextEntry.file = payload.file;
      }
    }
    if (touchesTransition) {
      if (payload.transition === null || transitionMatchesDefault) delete nextEntry.transition;
      else nextEntry.transition = normalizedTransition;
    }
    if (touchesDuration) {
      if (payload.durationMs === null) delete nextEntry.durationMs;
      else nextEntry.durationMs = payload.durationMs;
    }
    if (Object.keys(nextEntry).length > 0) nextIdleAnimations[originalFile] = nextEntry;
    else delete nextIdleAnimations[originalFile];
  } else {
    const { reactionKey } = payload;
    if (!REACTION_KEYS.has(reactionKey)) {
      return { status: "error", message: "setAnimationOverride.reactionKey must be one of: drag, clickLeft, clickRight, annoyed, double" };
    }
    if (touchesAutoReturn) {
      return { status: "error", message: "setAnimationOverride.autoReturnMs is not supported for reaction slots" };
    }
    if (touchesDuration && reactionKey === "drag") {
      return { status: "error", message: "setAnimationOverride.durationMs is not supported for reaction 'drag' (plays until pointer-up)" };
    }
    const nextEntry = { ...(nextReactions[reactionKey] || {}) };
    if (touchesFile) {
      if (payload.file === null) {
        delete nextEntry.file;
        delete nextEntry.sourceThemeId;
      } else {
        nextEntry.file = payload.file;
      }
    }
    if (touchesTransition) {
      if (payload.transition === null || transitionMatchesDefault) delete nextEntry.transition;
      else nextEntry.transition = normalizedTransition;
    }
    if (touchesDuration) {
      if (payload.durationMs === null) delete nextEntry.durationMs;
      else nextEntry.durationMs = payload.durationMs;
    }
    if (Object.keys(nextEntry).length > 0) nextReactions[reactionKey] = nextEntry;
    else delete nextReactions[reactionKey];
  }

  const nextThemeMap = buildThemeOverrideMap({
    states: nextStates,
    workingTiers: nextWorkingTiers,
    jugglingTiers: nextJugglingTiers,
    autoReturn: nextAutoReturn,
    idleAnimations: nextIdleAnimations,
    reactions: nextReactions,
    hitbox: nextHitbox,
    sounds: nextSounds,
  });
  const nextOverrides = { ...currentOverrides };
  if (Object.keys(nextThemeMap).length > 0) nextOverrides[themeId] = nextThemeMap;
  else delete nextOverrides[themeId];

  if (JSON.stringify(nextOverrides) === JSON.stringify(currentOverrides)) {
    return { status: "ok", noop: true };
  }

  const activeThemeId = snapshot.theme;
  if (themeId === activeThemeId) {
    if (!deps || typeof deps.activateTheme !== "function") {
      return { status: "error", message: "setAnimationOverride effect requires activateTheme dep for the active theme" };
    }
    try {
      deps.activateTheme(themeId, null, nextThemeMap);
    } catch (err) {
      return { status: "error", message: `setAnimationOverride: ${err && err.message}` };
    }
  }

  return { status: "ok", commit: { themeOverrides: nextOverrides } };
}

function setSoundOverride(payload, deps) {
  if (!isPlainObject(payload)) {
    return { status: "error", message: "setSoundOverride: payload must be an object" };
  }
  const { themeId, soundName, file, originalName } = payload;
  if (typeof themeId !== "string" || !themeId) {
    return { status: "error", message: "setSoundOverride.themeId must be a non-empty string" };
  }
  if (typeof soundName !== "string" || !soundName) {
    return { status: "error", message: "setSoundOverride.soundName must be a non-empty string" };
  }
  if (file !== null && (typeof file !== "string" || !file)) {
    return { status: "error", message: "setSoundOverride.file must be null or a non-empty string" };
  }

  const snapshot = (deps && deps.snapshot) || {};
  const currentOverrides = snapshot.themeOverrides || {};
  const currentThemeMap = currentOverrides[themeId] || {};
  const nextSounds = cloneSoundOverrides(currentThemeMap);

  if (file === null) {
    delete nextSounds[soundName];
  } else {
    const entry = { file };
    if (typeof originalName === "string" && originalName) entry.originalName = originalName;
    nextSounds[soundName] = entry;
  }

  const nextThemeMap = buildThemeOverrideMap({
    states: cloneStateOverrides(currentThemeMap),
    workingTiers: cloneTierOverrides(currentThemeMap, "workingTiers"),
    jugglingTiers: cloneTierOverrides(currentThemeMap, "jugglingTiers"),
    autoReturn: cloneAutoReturnOverrides(currentThemeMap),
    idleAnimations: cloneIdleAnimationOverrides(currentThemeMap),
    reactions: cloneReactionOverrides(currentThemeMap),
    hitbox: cloneHitboxOverrides(currentThemeMap),
    sounds: nextSounds,
  });
  const nextOverrides = { ...currentOverrides };
  if (Object.keys(nextThemeMap).length > 0) nextOverrides[themeId] = nextThemeMap;
  else delete nextOverrides[themeId];

  if (JSON.stringify(nextOverrides) === JSON.stringify(currentOverrides)) {
    return { status: "ok", noop: true };
  }

  const activeThemeId = snapshot.theme;
  if (themeId === activeThemeId) {
    if (!deps || typeof deps.activateTheme !== "function") {
      return { status: "error", message: "setSoundOverride effect requires activateTheme dep for the active theme" };
    }
    try {
      deps.activateTheme(themeId, null, nextThemeMap);
    } catch (err) {
      return { status: "error", message: `setSoundOverride: ${err && err.message}` };
    }
  }

  return { status: "ok", commit: { themeOverrides: nextOverrides } };
}

function setWideHitboxOverride(payload, deps) {
  if (!isPlainObject(payload)) {
    return { status: "error", message: "setWideHitboxOverride: payload must be an object" };
  }
  const { themeId, file, enabled } = payload;
  if (typeof themeId !== "string" || !themeId) {
    return { status: "error", message: "setWideHitboxOverride.themeId must be a non-empty string" };
  }
  if (typeof file !== "string" || !file) {
    return { status: "error", message: "setWideHitboxOverride.file must be a non-empty string" };
  }
  if (enabled !== null && typeof enabled !== "boolean") {
    return { status: "error", message: "setWideHitboxOverride.enabled must be boolean or null" };
  }

  const snapshot = (deps && deps.snapshot) || {};
  const currentOverrides = snapshot.themeOverrides || {};
  const currentThemeMap = currentOverrides[themeId] || {};
  const currentHitbox = isPlainObject(currentThemeMap.hitbox) ? currentThemeMap.hitbox : {};
  const currentWide = isPlainObject(currentHitbox.wide) ? { ...currentHitbox.wide } : {};

  if (enabled === null) {
    delete currentWide[file];
  } else {
    currentWide[file] = enabled;
  }

  const nextHitbox = { ...currentHitbox };
  if (Object.keys(currentWide).length > 0) {
    nextHitbox.wide = currentWide;
  } else {
    delete nextHitbox.wide;
  }

  const nextThemeMap = { ...currentThemeMap };
  if (Object.keys(nextHitbox).length > 0) {
    nextThemeMap.hitbox = nextHitbox;
  } else {
    delete nextThemeMap.hitbox;
  }

  const nextOverrides = { ...currentOverrides };
  if (Object.keys(nextThemeMap).length > 0) nextOverrides[themeId] = nextThemeMap;
  else delete nextOverrides[themeId];

  if (JSON.stringify(nextOverrides) === JSON.stringify(currentOverrides)) {
    return { status: "ok", noop: true };
  }

  const activeThemeId = snapshot.theme;
  if (themeId === activeThemeId) {
    if (!deps || (
      typeof deps.refreshActiveThemeHitboxOverrides !== "function"
      && typeof deps.activateTheme !== "function"
    )) {
      return {
        status: "error",
        message: "setWideHitboxOverride effect requires refreshActiveThemeHitboxOverrides or activateTheme dep",
      };
    }
    try {
      if (typeof deps.refreshActiveThemeHitboxOverrides === "function") {
        deps.refreshActiveThemeHitboxOverrides(themeId, nextThemeMap);
      } else {
        deps.activateTheme(themeId, null, nextThemeMap);
      }
    } catch (err) {
      return { status: "error", message: `setWideHitboxOverride: ${err && err.message}` };
    }
  }

  return { status: "ok", commit: { themeOverrides: nextOverrides } };
}

function importAnimationOverrides(payload, deps) {
  if (!payload || typeof payload !== "object") {
    return { status: "error", message: "importAnimationOverrides payload must be an object" };
  }
  const mode = payload.mode === "replace" ? "replace" : "merge";

  const incomingVersion = payload.version;
  if (typeof incomingVersion === "number" && incomingVersion > ANIMATION_OVERRIDES_EXPORT_VERSION) {
    return {
      status: "error",
      message: `importAnimationOverrides: file version ${incomingVersion} newer than supported (${ANIMATION_OVERRIDES_EXPORT_VERSION})`,
    };
  }

  const themesPayload = payload.themes;
  if (!themesPayload || typeof themesPayload !== "object" || Array.isArray(themesPayload)) {
    return { status: "error", message: "importAnimationOverrides: payload.themes must be an object" };
  }

  const normalizedIncoming = normalizeThemeOverrides(themesPayload, {});
  if (!normalizedIncoming || Object.keys(normalizedIncoming).length === 0) {
    return { status: "error", message: "importAnimationOverrides: no valid override entries found" };
  }

  const snapshot = (deps && deps.snapshot) || {};
  const currentOverrides = snapshot.themeOverrides || {};
  const nextOverrides = mode === "replace"
    ? normalizedIncoming
    : { ...currentOverrides, ...normalizedIncoming };

  const activeThemeId = snapshot.theme;
  const activeChanged = activeThemeId
    && JSON.stringify(nextOverrides[activeThemeId] || null)
       !== JSON.stringify(currentOverrides[activeThemeId] || null);

  if (activeChanged) {
    if (!deps || typeof deps.activateTheme !== "function") {
      return { status: "error", message: "importAnimationOverrides effect requires activateTheme dep" };
    }
    try {
      // This effect runs before controller._commit(), so activateTheme must
      // receive the newly imported override map explicitly.
      deps.activateTheme(activeThemeId, null, nextOverrides[activeThemeId] || null);
    } catch (err) {
      return { status: "error", message: `importAnimationOverrides: ${err && err.message}` };
    }
  }

  const importedThemeCount = Object.keys(normalizedIncoming).length;
  return {
    status: "ok",
    commit: { themeOverrides: nextOverrides },
    importedThemeCount,
    mode,
  };
}

const _validateResetOverridesThemeId = requireString("resetThemeOverrides.themeId");
function resetThemeOverrides(payload, deps) {
  const themeId = typeof payload === "string" ? payload : payload && payload.themeId;
  const idCheck = _validateResetOverridesThemeId(themeId);
  if (idCheck.status !== "ok") return idCheck;

  const snapshot = (deps && deps.snapshot) || {};
  const currentOverrides = snapshot.themeOverrides || {};
  if (!currentOverrides[themeId]) {
    return { status: "ok", noop: true };
  }

  const activeThemeId = snapshot.theme;
  if (themeId === activeThemeId) {
    if (!deps || typeof deps.activateTheme !== "function") {
      return { status: "error", message: "resetThemeOverrides effect requires activateTheme dep for the active theme" };
    }
    try {
      deps.activateTheme(themeId, null, null);
    } catch (err) {
      return { status: "error", message: `resetThemeOverrides: ${err && err.message}` };
    }
  }

  const nextOverrides = { ...currentOverrides };
  delete nextOverrides[themeId];
  return { status: "ok", commit: { themeOverrides: nextOverrides } };
}

module.exports = {
  ANIMATION_OVERRIDES_EXPORT_VERSION,
  ONESHOT_OVERRIDE_STATES,
  importAnimationOverrides,
  resetThemeOverrides,
  setAnimationOverride,
  setSoundOverride,
  setThemeOverrideDisabled,
  setWideHitboxOverride,
};
