"use strict";

const {
  isPlainObject,
  getStateBindingEntry,
  getStateFiles,
  deepMergeObject,
  basenameOnly,
  mergeFileHitBoxes,
  VISUAL_FALLBACK_STATES,
} = require("./theme-schema");

// Allow-list of fields a variant may override. Anything else is ignored with a
// warning so author typos are visible without breaking theme load.
const VARIANT_ALLOWED_KEYS = new Set([
  // Metadata (not merged into runtime theme)
  "name", "description", "preview",
  // Runtime fields
  "workingTiers", "jugglingTiers", "idleAnimations",
  "wideHitboxFiles", "sleepingHitboxFiles",
  "hitBoxes", "fileHitBoxes", "timings", "transitions",
  "objectScale", "displayHintMap",
]);

// Fields that replace wholesale instead of deep-merge. Arrays always replace;
// displayHintMap explicitly replaces because deep-merge cannot express removals.
const VARIANT_REPLACE_FIELDS = new Set([
  "workingTiers", "jugglingTiers", "idleAnimations",
  "wideHitboxFiles", "sleepingHitboxFiles",
  "displayHintMap",
]);

function resolveVariant(raw, requestedVariant) {
  const rawVariants = isPlainObject(raw.variants) ? raw.variants : {};
  const hasExplicitDefault = isPlainObject(rawVariants.default);
  const targetId = requestedVariant || "default";

  if (rawVariants[targetId] && isPlainObject(rawVariants[targetId])) {
    return { resolvedId: targetId, spec: rawVariants[targetId] };
  }
  if (hasExplicitDefault) {
    return { resolvedId: "default", spec: rawVariants.default };
  }
  return { resolvedId: "default", spec: null };
}

function applyVariantPatch(raw, variantSpec, themeId, variantId) {
  const patched = { ...raw };
  for (const [key, value] of Object.entries(variantSpec)) {
    // Metadata-only fields belong to the variant metadata layer, not runtime config.
    if (key === "name" || key === "description" || key === "preview") continue;
    if (!VARIANT_ALLOWED_KEYS.has(key)) {
      console.warn(`[theme-loader] variant "${themeId}:${variantId}" declares ignored field "${key}" (not in allow-list)`);
      continue;
    }
    if (key === "fileHitBoxes") {
      patched.fileHitBoxes = mergeFileHitBoxes(patched.fileHitBoxes, value);
      continue;
    }
    if (VARIANT_REPLACE_FIELDS.has(key) || Array.isArray(value)) {
      patched[key] = value;
    } else if (isPlainObject(value)) {
      patched[key] = isPlainObject(patched[key]) ? deepMergeObject(patched[key], value) : value;
    } else {
      patched[key] = value;
    }
  }
  return patched;
}

function normalizeTransitionOverride(transition) {
  if (!isPlainObject(transition)) return null;
  const out = {};
  if (Number.isFinite(transition.in)) out.in = transition.in;
  if (Number.isFinite(transition.out)) out.out = transition.out;
  return Object.keys(out).length > 0 ? out : null;
}

function buildBaseBindingMetadata(raw) {
  const states = {};
  if (isPlainObject(raw.states)) {
    for (const [stateKey, entry] of Object.entries(raw.states)) {
      if (stateKey.startsWith("_")) continue;
      const files = getStateFiles(entry);
      if (files[0]) states[stateKey] = basenameOnly(files[0]);
    }
  }
  const miniStates = {};
  if (isPlainObject(raw.miniMode) && isPlainObject(raw.miniMode.states)) {
    for (const [stateKey, entry] of Object.entries(raw.miniMode.states)) {
      if (stateKey.startsWith("_")) continue;
      if (Array.isArray(entry) && entry[0]) miniStates[stateKey] = basenameOnly(entry[0]);
    }
  }
  const mapTierGroup = (tiers) =>
    Array.isArray(tiers)
      ? tiers
        .filter((tier) => isPlainObject(tier))
        .map((tier) => ({
          minSessions: Number.isFinite(tier.minSessions) ? tier.minSessions : 0,
          originalFile: basenameOnly(tier.file),
        }))
        .sort((a, b) => b.minSessions - a.minSessions)
      : [];
  const idleAnimations = Array.isArray(raw.idleAnimations)
    ? raw.idleAnimations
      .filter((entry) => isPlainObject(entry) && typeof entry.file === "string" && entry.file)
      .map((entry, index) => ({
        index,
        originalFile: basenameOnly(entry.file),
        duration: Number.isFinite(entry.duration) ? entry.duration : null,
      }))
    : [];
  const displayHintMap = {};
  if (isPlainObject(raw.displayHintMap)) {
    for (const [key, value] of Object.entries(raw.displayHintMap)) {
      displayHintMap[basenameOnly(key)] = basenameOnly(value);
    }
  }
  return {
    states,
    miniStates,
    workingTiers: mapTierGroup(raw.workingTiers),
    jugglingTiers: mapTierGroup(raw.jugglingTiers),
    idleAnimations,
    displayHintMap,
  };
}

function ensureTransitionsPatch(patched) {
  if (!isPlainObject(patched.transitions)) patched.transitions = {};
  return patched.transitions;
}

function applyTransitionOverride(patched, targetFile, transition) {
  const cleanTarget = basenameOnly(targetFile);
  const cleanTransition = normalizeTransitionOverride(transition);
  if (!cleanTarget || !cleanTransition) return;
  const nextTransitions = ensureTransitionsPatch(patched);
  const prev = isPlainObject(nextTransitions[cleanTarget]) ? nextTransitions[cleanTarget] : {};
  nextTransitions[cleanTarget] = { ...prev, ...cleanTransition };
}

function applyUserOverridesPatch(raw, overrides) {
  if (!isPlainObject(overrides)) return raw;
  const patched = { ...raw };

  const stateOverrides = isPlainObject(overrides.states) ? overrides.states : {};
  if (Object.keys(stateOverrides).length > 0) {
    const nextStates = { ...raw.states };
    const nextMiniMode = isPlainObject(raw.miniMode) ? { ...raw.miniMode } : null;
    const nextMiniStates = nextMiniMode && isPlainObject(raw.miniMode.states)
      ? { ...raw.miniMode.states }
      : null;
    for (const [stateKey, entry] of Object.entries(stateOverrides)) {
      if (!isPlainObject(entry)) continue;
      const rawStateEntry = nextStates[stateKey];
      const rawMiniEntry = nextMiniStates ? nextMiniStates[stateKey] : undefined;
      // Normally we only patch states that already exist in the raw theme.
      // But synthetic states like "roam" are injected by buildStateBindings()
      // at runtime — they don't exist in the raw JSON. Allow creating them
      // here so user overrides can still apply (the state is validated
      // against VISUAL_FALLBACK_STATES to guard against typos).
      let targetCollection;
      if (rawStateEntry !== undefined) {
        targetCollection = nextStates;
      } else if (rawMiniEntry !== undefined) {
        targetCollection = nextMiniStates;
      } else if (VISUAL_FALLBACK_STATES && VISUAL_FALLBACK_STATES.has(stateKey)) {
        // Synthetic fallback state (e.g. "roam") — create in nextStates
        targetCollection = nextStates;
      } else {
        continue;
      }
      const currentState = getStateBindingEntry(targetCollection[stateKey] || []);
      const currentFiles = currentState.files;
      if (currentFiles.length === 0 && !(typeof entry.file === "string" && entry.file)) continue;
      const nextFiles = [...currentFiles];
      if (typeof entry.file === "string" && entry.file) {
        if (nextFiles.length > 0) nextFiles[0] = entry.file;
        else nextFiles.push(entry.file);
      }
      if (Array.isArray(targetCollection[stateKey])) {
        targetCollection[stateKey] = nextFiles;
      } else if (isPlainObject(targetCollection[stateKey])) {
        targetCollection[stateKey] = { ...targetCollection[stateKey], files: nextFiles };
      } else {
        targetCollection[stateKey] = nextFiles;
      }
      const transitionTarget = (typeof entry.file === "string" && entry.file) ? entry.file : nextFiles[0];
      applyTransitionOverride(patched, transitionTarget, entry.transition);
    }
    patched.states = nextStates;
    if (nextMiniMode && nextMiniStates) {
      nextMiniMode.states = nextMiniStates;
      patched.miniMode = nextMiniMode;
    }
  }

  const tierGroups = isPlainObject(overrides.tiers) ? overrides.tiers : {};
  for (const tierGroup of ["workingTiers", "jugglingTiers"]) {
    const tierOverrides = isPlainObject(tierGroups[tierGroup]) ? tierGroups[tierGroup] : null;
    const rawTiers = Array.isArray(raw[tierGroup]) ? raw[tierGroup] : null;
    if (!tierOverrides || !rawTiers) continue;
    const nextTiers = rawTiers.map((tier) => (isPlainObject(tier) ? { ...tier } : tier));
    for (const [originalFile, entry] of Object.entries(tierOverrides)) {
      if (!isPlainObject(entry)) continue;
      const cleanOriginal = basenameOnly(originalFile);
      const tier = nextTiers.find((candidate) =>
        isPlainObject(candidate) && basenameOnly(candidate.file) === cleanOriginal
      );
      if (!tier) continue;
      if (typeof entry.file === "string" && entry.file) {
        tier.file = entry.file;
      }
      const transitionTarget = (typeof entry.file === "string" && entry.file) ? entry.file : tier.file;
      applyTransitionOverride(patched, transitionTarget, entry.transition);
    }
    patched[tierGroup] = nextTiers;
  }

  const timings = isPlainObject(overrides.timings) ? overrides.timings : null;
  const autoReturn = timings && isPlainObject(timings.autoReturn) ? timings.autoReturn : null;
  if (autoReturn) {
    const nextTimings = isPlainObject(raw.timings) ? deepMergeObject(raw.timings, {}) : {};
    nextTimings.autoReturn = isPlainObject(nextTimings.autoReturn) ? { ...nextTimings.autoReturn } : {};
    for (const [stateKey, value] of Object.entries(autoReturn)) {
      if (!Number.isFinite(value)) continue;
      nextTimings.autoReturn[stateKey] = value;
    }
    patched.timings = nextTimings;
  }

  // Per-file wide-hitbox opt-in/opt-out. Only touches the file list the theme
  // publishes; state.js rebuilds WIDE_SVGS from theme.wideHitboxFiles on refresh.
  const hitboxOverrides = isPlainObject(overrides.hitbox) ? overrides.hitbox : null;
  const wideOverrides = hitboxOverrides && isPlainObject(hitboxOverrides.wide) ? hitboxOverrides.wide : null;
  if (wideOverrides && Object.keys(wideOverrides).length > 0) {
    const currentSet = new Set(
      (Array.isArray(patched.wideHitboxFiles) ? patched.wideHitboxFiles : []).map(basenameOnly)
    );
    for (const [file, enabled] of Object.entries(wideOverrides)) {
      const bn = basenameOnly(file);
      if (!bn) continue;
      if (enabled) currentSet.add(bn);
      else currentSet.delete(bn);
    }
    patched.wideHitboxFiles = [...currentSet];
  }

  const reactionOverrides = isPlainObject(overrides.reactions) ? overrides.reactions : null;
  if (reactionOverrides && isPlainObject(raw.reactions)) {
    const nextReactions = { ...raw.reactions };
    for (const [reactionKey, entry] of Object.entries(reactionOverrides)) {
      if (!isPlainObject(entry)) continue;
      const rawReaction = nextReactions[reactionKey];
      if (!isPlainObject(rawReaction)) continue;
      const nextReaction = { ...rawReaction };
      const hasNewFile = typeof entry.file === "string" && entry.file;
      if (hasNewFile) {
        // `double` reaction stores a files array (random pool). The MVP exposes
        // only files[0] to users, so overriding replaces the first entry while
        // keeping the rest of the pool intact.
        if (Array.isArray(nextReaction.files) && nextReaction.files.length > 0) {
          nextReaction.files = [entry.file, ...nextReaction.files.slice(1)];
        } else {
          nextReaction.file = entry.file;
        }
      }
      if (Number.isFinite(entry.durationMs)) {
        nextReaction.duration = entry.durationMs;
      }
      nextReactions[reactionKey] = nextReaction;
      const transitionTarget = hasNewFile
        ? entry.file
        : (nextReaction.file || (Array.isArray(nextReaction.files) ? nextReaction.files[0] : null));
      if (transitionTarget) applyTransitionOverride(patched, transitionTarget, entry.transition);
    }
    patched.reactions = nextReactions;
  }

  const idleAnimationOverrides = isPlainObject(overrides.idleAnimations) ? overrides.idleAnimations : null;
  if (idleAnimationOverrides && Array.isArray(raw.idleAnimations)) {
    const nextIdleAnimations = raw.idleAnimations.map((entry) => (isPlainObject(entry) ? { ...entry } : entry));
    for (const [originalFile, entry] of Object.entries(idleAnimationOverrides)) {
      if (!isPlainObject(entry)) continue;
      const cleanOriginal = basenameOnly(originalFile);
      const idleAnimation = nextIdleAnimations.find((candidate) =>
        isPlainObject(candidate) && basenameOnly(candidate.file) === cleanOriginal
      );
      if (!idleAnimation) continue;
      if (typeof entry.file === "string" && entry.file) {
        idleAnimation.file = entry.file;
      }
      if (Number.isFinite(entry.durationMs)) {
        idleAnimation.duration = entry.durationMs;
      }
      const transitionTarget = (typeof entry.file === "string" && entry.file) ? entry.file : idleAnimation.file;
      applyTransitionOverride(patched, transitionTarget, entry.transition);
    }
    patched.idleAnimations = nextIdleAnimations;
  }

  return patched;
}

module.exports = {
  VARIANT_ALLOWED_KEYS,
  VARIANT_REPLACE_FIELDS,
  resolveVariant,
  applyVariantPatch,
  normalizeTransitionOverride,
  buildBaseBindingMetadata,
  applyUserOverridesPatch,
};
