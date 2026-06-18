"use strict";

// Defaults used when theme.json omits optional fields.

const DEFAULT_SOUNDS = {
  complete: "complete.mp3",
  confirm: "confirm.mp3",
};

const DEFAULT_TIMINGS = {
  minDisplay: {
    attention: 4000, error: 5000, sweeping: 5500,
    notification: 2500, carrying: 3000, working: 1000, thinking: 1000,
  },
  autoReturn: {
    attention: 4000, error: 5000, sweeping: 300000,
    notification: 2500, carrying: 3000,
  },
  yawnDuration: 3000,
  wakeDuration: 1500,
  deepSleepTimeout: 600000,
  mouseIdleTimeout: 20000,
  mouseSleepTimeout: 60000,
};

const DEFAULT_HITBOXES = {
  default: { x: -1, y: 5, w: 17, h: 12 },
  sleeping: { x: -2, y: 9, w: 19, h: 7 },
  wide: { x: -3, y: 3, w: 21, h: 14 },
};

const DEFAULT_OBJECT_SCALE = {
  widthRatio: 1.9, heightRatio: 1.3,
  offsetX: -0.45, offsetY: -0.25,
};
const DEFAULT_LAYOUT = {
  centerXRatio: 0.5,
  baselineBottomRatio: 0.05,
  visibleHeightRatio: 0.58,
};

const DEFAULT_EYE_TRACKING = {
  enabled: false,
  states: [],
  eyeRatioX: 0.5,
  eyeRatioY: 0.5,
  maxOffset: 3,
  bodyScale: 0.33,
  shadowStretch: 0.15,
  shadowShift: 0.3,
  ids: { eyes: "eyes-js", body: "body-js", shadow: "shadow-js", dozeEyes: "eyes-doze" },
  shadowOrigin: "7.5px 15px",
};

const REQUIRED_STATES = ["idle", "working", "thinking"];
const FULL_SLEEP_REQUIRED_STATES = ["yawning", "dozing", "collapsing", "waking"];
const MINI_REQUIRED_STATES = [
  "mini-idle",
  "mini-enter",
  "mini-enter-sleep",
  "mini-crabwalk",
  "mini-peek",
  "mini-alert",
  "mini-happy",
  "mini-sleep",
];
const VISUAL_FALLBACK_STATES = new Set([
  "error",
  "attention",
  "notification",
  "sweeping",
  "carrying",
  "sleeping",
  "roam",
]);

function validateTheme(cfg) {
  const errors = [];
  const sleepMode = deriveSleepMode(cfg);
  const normalizedStates = normalizeStateBindings(cfg && cfg.states);

  if (cfg.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1, got ${cfg.schemaVersion}`);
  }
  if (!cfg.name) errors.push("missing required field: name");
  if (!cfg.version) errors.push("missing required field: version");

  if (!cfg.viewBox || cfg.viewBox.width == null || cfg.viewBox.height == null ||
      cfg.viewBox.x == null || cfg.viewBox.y == null) {
    errors.push("missing or incomplete viewBox (need x, y, width, height)");
  }

  if (!cfg.states) {
    errors.push("missing required field: states");
  } else {
    for (const s of REQUIRED_STATES) {
      if (!hasStateFiles(cfg.states[s])) {
        errors.push(`states.${s} must be a non-empty array`);
      }
    }
    if (!hasStateBinding(cfg.states.sleeping)) {
      errors.push("states.sleeping must define files or fallbackTo");
    }
    if (sleepMode === "full") {
      for (const s of FULL_SLEEP_REQUIRED_STATES) {
        if (!hasStateFiles(cfg.states[s])) {
          errors.push(`sleepSequence.mode=full requires states.${s} to be a non-empty array`);
        }
      }
    }
  }

  if (cfg.eyeTracking && cfg.eyeTracking.enabled) {
    if (!Array.isArray(cfg.eyeTracking.states) || cfg.eyeTracking.states.length === 0) {
      errors.push("eyeTracking.states must be a non-empty array when eyeTracking.enabled=true");
    }
  }

  // eyeTracking.states listed states must use .svg if enabled
  if (cfg.eyeTracking && cfg.eyeTracking.enabled && cfg.states) {
    for (const stateName of (cfg.eyeTracking.states || [])) {
      const files = getStateFiles(cfg.states[stateName]).length > 0
        ? getStateFiles(cfg.states[stateName])
        : (cfg.miniMode && cfg.miniMode.states && cfg.miniMode.states[stateName]);
      if (files) {
        for (const f of files) {
          if (!f.endsWith(".svg")) {
            errors.push(`eyeTracking state "${stateName}" file "${f}" must be .svg`);
          }
        }
      }
    }
  }

  if (cfg.sleepSequence !== undefined) {
    const rawMode = cfg.sleepSequence && cfg.sleepSequence.mode;
    if (rawMode !== "full" && rawMode !== "direct") {
      errors.push(`sleepSequence.mode must be "full" or "direct", got ${rawMode}`);
    }
  }

  if (cfg.updateVisuals !== undefined) {
    if (!isPlainObject(cfg.updateVisuals)) {
      errors.push("updateVisuals must be an object when present");
    } else if (
      cfg.updateVisuals.checking !== undefined
      && (typeof cfg.updateVisuals.checking !== "string" || !cfg.updateVisuals.checking)
    ) {
      errors.push("updateVisuals.checking must be a non-empty string when present");
    }
  }

  if (cfg.updateBubbleAnchorBox !== undefined) {
    const box = cfg.updateBubbleAnchorBox;
    if (
      !isPlainObject(box)
      || box.x == null
      || box.y == null
      || box.width == null
      || box.height == null
      || !Number.isFinite(box.x)
      || !Number.isFinite(box.y)
      || !Number.isFinite(box.width)
      || !Number.isFinite(box.height)
    ) {
      errors.push("updateBubbleAnchorBox must include finite x, y, width, height");
    }
  }

  if (cfg.rendering !== undefined) {
    if (!isPlainObject(cfg.rendering)) {
      errors.push("rendering must be an object when present");
    } else if (
      cfg.rendering.svgChannel !== undefined
      && cfg.rendering.svgChannel !== "auto"
      && cfg.rendering.svgChannel !== "object"
    ) {
      errors.push(`rendering.svgChannel must be "auto" or "object", got ${cfg.rendering.svgChannel}`);
    }
  }

  const fallbackStateKeys = Object.keys(normalizedStates);
  for (const stateKey of fallbackStateKeys) {
    const entry = normalizedStates[stateKey];
    if (!entry.fallbackTo) continue;
    if (!VISUAL_FALLBACK_STATES.has(stateKey)) {
      errors.push(`states.${stateKey}.fallbackTo is only allowed on error/attention/notification/sweeping/carrying/sleeping/roam`);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(normalizedStates, entry.fallbackTo)) {
      errors.push(`states.${stateKey}.fallbackTo target "${entry.fallbackTo}" does not exist`);
    }
  }

  for (const stateKey of fallbackStateKeys) {
    const visited = new Set([stateKey]);
    let hops = 0;
    let cursor = stateKey;
    while (true) {
      const entry = normalizedStates[cursor];
      if (!entry || !entry.fallbackTo) break;
      const target = entry.fallbackTo;
      hops++;
      if (hops > 3) {
        errors.push(`states.${stateKey}.fallbackTo exceeds 3 hop limit`);
        break;
      }
      if (visited.has(target)) {
        errors.push(`states.${stateKey}.fallbackTo forms a cycle`);
        break;
      }
      visited.add(target);
      if (!Object.prototype.hasOwnProperty.call(normalizedStates, target)) {
        break;
      }
      cursor = target;
    }
    const terminal = normalizedStates[cursor];
    if (!terminal || !hasStateFiles(terminal)) {
      errors.push(`states.${stateKey}.fallbackTo chain does not terminate in real files`);
    }
  }

  if (fallbackStateKeys.length > 0 && !fallbackStateKeys.some((stateKey) => hasStateFiles(normalizedStates[stateKey]))) {
    errors.push("theme must declare at least one state with real files");
  }

  if (isMiniSupported(cfg)) {
    for (const stateName of MINI_REQUIRED_STATES) {
      const files = cfg.miniMode.states && cfg.miniMode.states[stateName];
      if (!Array.isArray(files) || files.length === 0) {
        errors.push(`miniMode.supported=true requires miniMode.states.${stateName} to be a non-empty array`);
      }
    }
  }

  if (cfg.layout) {
    const cb = cfg.layout.contentBox;
    if (!cb || cb.x == null || cb.y == null || cb.width == null || cb.height == null) {
      errors.push("layout.contentBox must include x, y, width, height");
    }
  }

  return errors;
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function hasNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function getStateBindingEntry(entry) {
  if (Array.isArray(entry)) {
    return { files: [...entry], fallbackTo: null };
  }
  if (isPlainObject(entry)) {
    return {
      files: Array.isArray(entry.files) ? [...entry.files] : [],
      fallbackTo: (typeof entry.fallbackTo === "string" && entry.fallbackTo) ? entry.fallbackTo : null,
    };
  }
  return { files: [], fallbackTo: null };
}

function getStateFiles(entry) {
  return getStateBindingEntry(entry).files;
}

function hasStateFiles(entry) {
  return getStateFiles(entry).length > 0;
}

function hasStateBinding(entry) {
  const normalized = getStateBindingEntry(entry);
  return normalized.files.length > 0 || !!normalized.fallbackTo;
}

function normalizeStateBindings(states) {
  const normalized = {};
  if (!isPlainObject(states)) return normalized;
  for (const [stateKey, entry] of Object.entries(states)) {
    if (stateKey.startsWith("_")) continue;
    normalized[stateKey] = getStateBindingEntry(entry);
  }
  return normalized;
}

function hasReactionBindings(reactions) {
  if (!isPlainObject(reactions)) return false;
  return Object.values(reactions).some((entry) =>
    isPlainObject(entry)
    && (
      (typeof entry.file === "string" && entry.file.length > 0)
      || (typeof entry.fileLeft === "string" && entry.fileLeft.length > 0)
      || (typeof entry.fileRight === "string" && entry.fileRight.length > 0)
      || (Array.isArray(entry.files) && entry.files.some((file) => typeof file === "string" && file.length > 0))
    )
  );
}

function isMiniSupported(cfg) {
  return !!(isPlainObject(cfg && cfg.miniMode) && cfg.miniMode.supported !== false);
}

function supportsIdleTracking(cfg) {
  return !!(
    isPlainObject(cfg && cfg.eyeTracking)
    && cfg.eyeTracking.enabled
    && Array.isArray(cfg.eyeTracking.states)
    && cfg.eyeTracking.states.includes("idle")
  );
}

function deriveIdleMode(cfg) {
  if (supportsIdleTracking(cfg)) return "tracked";
  if (hasNonEmptyArray(cfg && cfg.idleAnimations)) return "animated";
  return "static";
}

function deriveSleepMode(cfg) {
  return (cfg && cfg.sleepSequence && cfg.sleepSequence.mode === "direct") ? "direct" : "full";
}

function buildCapabilities(cfg) {
  return {
    eyeTracking: !!(
      isPlainObject(cfg && cfg.eyeTracking)
      && cfg.eyeTracking.enabled
      && hasNonEmptyArray(cfg.eyeTracking.states)
    ),
    miniMode: isMiniSupported(cfg),
    idleAnimations: hasNonEmptyArray(cfg && cfg.idleAnimations),
    reactions: hasReactionBindings(cfg && cfg.reactions),
    workingTiers: hasNonEmptyArray(cfg && cfg.workingTiers),
    jugglingTiers: hasNonEmptyArray(cfg && cfg.jugglingTiers),
    idleMode: deriveIdleMode(cfg),
    sleepMode: deriveSleepMode(cfg),
  };
}

function addThemeAssetFile(out, filename) {
  const safe = basenameOnly(filename);
  if (safe) out.add(safe);
}

function collectRequiredAssetFiles(theme) {
  const files = new Set();
  if (theme && theme.states) {
    for (const stateFiles of Object.values(theme.states)) {
      if (!Array.isArray(stateFiles)) continue;
      for (const file of stateFiles) addThemeAssetFile(files, file);
    }
  }
  if (theme && theme.miniMode && theme.miniMode.states) {
    for (const stateFiles of Object.values(theme.miniMode.states)) {
      if (!Array.isArray(stateFiles)) continue;
      for (const file of stateFiles) addThemeAssetFile(files, file);
    }
  }
  for (const group of [theme && theme.workingTiers, theme && theme.jugglingTiers]) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      if (entry && typeof entry.file === "string") addThemeAssetFile(files, entry.file);
    }
  }
  if (Array.isArray(theme && theme.idleAnimations)) {
    for (const entry of theme.idleAnimations) {
      if (entry && typeof entry.file === "string") addThemeAssetFile(files, entry.file);
    }
  }
  if (isPlainObject(theme && theme.reactions)) {
    for (const entry of Object.values(theme.reactions)) {
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.file === "string") addThemeAssetFile(files, entry.file);
      if (typeof entry.fileLeft === "string") addThemeAssetFile(files, entry.fileLeft);
      if (typeof entry.fileRight === "string") addThemeAssetFile(files, entry.fileRight);
      if (Array.isArray(entry.files)) {
        for (const file of entry.files) addThemeAssetFile(files, file);
      }
    }
  }
  if (isPlainObject(theme && theme.displayHintMap)) {
    for (const file of Object.values(theme.displayHintMap)) {
      if (typeof file === "string") addThemeAssetFile(files, file);
    }
  }
  if (isPlainObject(theme && theme.updateVisuals) && typeof theme.updateVisuals.checking === "string") {
    addThemeAssetFile(files, theme.updateVisuals.checking);
  }
  return [...files];
}

function deepMergeObject(base, patch) {
  if (!isPlainObject(base)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMergeObject(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function basenameOnly(value) {
  return typeof value === "string" ? value.replace(/^.*[\/\\]/, "") : value;
}

function normalizeViewBox(value) {
  if (!isPlainObject(value)) return null;
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

function normalizeTrustedRuntime(value, isBuiltin, themeId) {
  const out = { scriptedSvgFiles: [] };
  if (!isBuiltin) {
    if (value !== undefined) {
      console.warn(`[theme-loader] trustedRuntime ignored for non-builtin theme "${themeId}"`);
    }
    return out;
  }
  if (!isPlainObject(value) || !Array.isArray(value.scriptedSvgFiles)) {
    return out;
  }
  const seen = new Set();
  for (const file of value.scriptedSvgFiles) {
    if (typeof file !== "string") continue;
    const safeFile = basenameOnly(file);
    if (!safeFile || !safeFile.toLowerCase().endsWith(".svg") || seen.has(safeFile)) continue;
    seen.add(safeFile);
    out.scriptedSvgFiles.push(safeFile);
  }
  if (isPlainObject(value.scriptedSvgCycleMs)) {
    const cycleMap = {};
    for (const [file, ms] of Object.entries(value.scriptedSvgCycleMs)) {
      const safeFile = basenameOnly(file);
      if (!safeFile || !safeFile.toLowerCase().endsWith(".svg") || !seen.has(safeFile)) continue;
      if (!Number.isFinite(ms) || ms <= 0) continue;
      cycleMap[safeFile] = Math.round(ms);
    }
    if (Object.keys(cycleMap).length > 0) out.scriptedSvgCycleMs = cycleMap;
  }
  return out;
}

function normalizeRendering(value) {
  if (!isPlainObject(value)) return { svgChannel: "auto" };
  return {
    svgChannel: value.svgChannel === "object" ? "object" : "auto",
  };
}

function warnFileViewBoxDropped(rawKey, reason) {
  console.warn(`[theme-loader] fileViewBoxes["${rawKey}"] dropped: ${reason}`);
}

function normalizeFileViewBoxes(value) {
  const out = {};
  if (value == null) return out;
  if (!isPlainObject(value)) {
    console.warn("[theme-loader] fileViewBoxes dropped: expected object map");
    return out;
  }

  for (const [rawKey, viewBox] of Object.entries(value)) {
    const key = basenameOnly(rawKey);
    if (!key) {
      warnFileViewBoxDropped(rawKey, "invalid filename key");
      continue;
    }
    const normalized = normalizeViewBox(viewBox);
    if (!normalized) {
      warnFileViewBoxDropped(rawKey, "expected finite x/y/width/height with positive width/height");
      continue;
    }
    out[key] = normalized;
  }
  return out;
}

function warnFileHitBoxDropped(rawKey, reason) {
  console.warn(`[theme-loader] fileHitBoxes["${rawKey}"] dropped: ${reason}`);
}

function normalizeFileHitBoxes(value) {
  const out = {};
  if (value == null) return out;
  if (!isPlainObject(value)) {
    console.warn("[theme-loader] fileHitBoxes dropped: expected object map");
    return out;
  }

  for (const [rawKey, box] of Object.entries(value)) {
    const key = basenameOnly(rawKey);
    if (!key) {
      warnFileHitBoxDropped(rawKey, "invalid filename key");
      continue;
    }
    if (!isPlainObject(box)) {
      warnFileHitBoxDropped(rawKey, "expected object with finite x/y/w/h");
      continue;
    }
    const { x, y, w, h } = box;
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
      warnFileHitBoxDropped(rawKey, "missing/invalid x/y/w/h");
      continue;
    }
    out[key] = { x, y, w, h };
  }
  return out;
}

function mergeFileHitBoxes(base, patch) {
  return {
    ...normalizeFileHitBoxes(base),
    ...normalizeFileHitBoxes(patch),
  };
}

function mergeDefaults(raw, themeId, isBuiltin) {
  const theme = { ...raw, _id: themeId, _builtin: !!isBuiltin };
  // NOTE: This preserves pre-A1 behavior: some nested values are shallow-copied
  // and basename normalization below can mutate caller-owned raw subobjects.
  // Clean this up separately after Round A2 stabilizes.

  // timings
  theme.timings = {
    ...DEFAULT_TIMINGS,
    ...(raw.timings || {}),
    minDisplay: { ...DEFAULT_TIMINGS.minDisplay, ...(raw.timings && raw.timings.minDisplay) },
    autoReturn: { ...DEFAULT_TIMINGS.autoReturn, ...(raw.timings && raw.timings.autoReturn) },
  };

  // hitBoxes
  theme.hitBoxes = { ...DEFAULT_HITBOXES, ...(raw.hitBoxes || {}) };
  theme.fileHitBoxes = normalizeFileHitBoxes(raw.fileHitBoxes);
  // fileViewBoxes / miniMode.viewBox are layout metadata only and safe for external themes.
  theme.fileViewBoxes = normalizeFileViewBoxes(raw.fileViewBoxes);
  theme.wideHitboxFiles = raw.wideHitboxFiles || [];
  theme.sleepingHitboxFiles = raw.sleepingHitboxFiles || [];

  // trustedRuntime grants script execution capability, so it requires loader-derived built-in trust.
  theme.trustedRuntime = normalizeTrustedRuntime(raw.trustedRuntime, isBuiltin, themeId);
  theme.rendering = normalizeRendering(raw.rendering);

  // objectScale
  theme.objectScale = { ...DEFAULT_OBJECT_SCALE, ...(raw.objectScale || {}) };
  {
    const vb = theme.viewBox || { width: 1, height: 1 };
    const aspect = (vb.width && vb.height) ? (vb.width / vb.height) : 1;
    const os = theme.objectScale;
    const derivedObjBottom = os.objBottom != null ? os.objBottom : (1 - os.offsetY - os.heightRatio);
    const rawOs = raw.objectScale || {};

    if (os.imgWidthRatio == null) {
      os.imgWidthRatio = Math.min(os.widthRatio, os.heightRatio * aspect);
    }
    if (rawOs.imgOffsetX == null) {
      os.imgOffsetX = os.offsetX + Math.max(0, (os.widthRatio - os.imgWidthRatio) / 2);
    }
    if (os.imgBottom == null) {
      const fittedHeightRatio = aspect > 0 ? (os.imgWidthRatio / aspect) : os.heightRatio;
      os.imgBottom = derivedObjBottom + Math.max(0, (os.heightRatio - fittedHeightRatio) / 2);
    }
  }

  // layout
  if (raw.layout && raw.layout.contentBox) {
    const cb = raw.layout.contentBox;
    theme.layout = {
      ...DEFAULT_LAYOUT,
      ...raw.layout,
      contentBox: { ...cb },
    };
    if (theme.layout.centerX == null) theme.layout.centerX = cb.x + cb.width / 2;
    if (theme.layout.baselineY == null) theme.layout.baselineY = cb.y + cb.height;
  } else {
    theme.layout = null;
  }

  // eyeTracking
  theme.eyeTracking = { ...DEFAULT_EYE_TRACKING, ...(raw.eyeTracking || {}) };
  theme.eyeTracking.ids = {
    ...DEFAULT_EYE_TRACKING.ids,
    ...(raw.eyeTracking && raw.eyeTracking.ids || {}),
  };

  theme.sleepSequence = { mode: deriveSleepMode(raw) };

  // miniMode
  if (raw.miniMode) {
    theme.miniMode = {
      supported: true,
      offsetRatio: 0.486,
      ...raw.miniMode,
      viewBox: normalizeViewBox(raw.miniMode.viewBox),
      timings: {
        minDisplay: {},
        autoReturn: {},
        ...(raw.miniMode.timings || {}),
      },
      glyphFlips: raw.miniMode.glyphFlips || {},
    };
  } else {
    theme.miniMode = { supported: false, states: {}, viewBox: null, timings: { minDisplay: {}, autoReturn: {} }, glyphFlips: {} };
  }

  // Merge mini timings into main timings for state.js convenience
  if (theme.miniMode.timings) {
    Object.assign(theme.timings.minDisplay, theme.miniMode.timings.minDisplay || {});
    Object.assign(theme.timings.autoReturn, theme.miniMode.timings.autoReturn || {});
  }

  // displayHintMap
  theme.displayHintMap = raw.displayHintMap || {};

  // sounds
  theme.sounds = { ...DEFAULT_SOUNDS, ...(raw.sounds || {}) };

  // reactions
  theme.reactions = raw.reactions || null;

  // workingTiers / jugglingTiers — auto sort descending by minSessions
  if (theme.workingTiers) {
    theme.workingTiers.sort((a, b) => b.minSessions - a.minSessions);
  }
  if (theme.jugglingTiers) {
    theme.jugglingTiers.sort((a, b) => b.minSessions - a.minSessions);
  }

  // idleAnimations
  theme.idleAnimations = raw.idleAnimations || [];

  // updater-specific visual bindings
  theme.updateVisuals = isPlainObject(raw.updateVisuals) ? { ...raw.updateVisuals } : {};
  theme.updateBubbleAnchorBox = isPlainObject(raw.updateBubbleAnchorBox)
    ? { ...raw.updateBubbleAnchorBox }
    : null;

  // Filename sanitization: basename all file references to prevent path traversal.
  const bn = basenameOnly;
  const normalizedStates = normalizeStateBindings(raw.states);
  theme.states = {};
  theme._stateBindings = {};
  for (const [stateKey, entry] of Object.entries(normalizedStates)) {
    const files = entry.files.map(bn);
    theme.states[stateKey] = files;
    theme._stateBindings[stateKey] = {
      files,
      fallbackTo: entry.fallbackTo || null,
    };
  }
  if (theme.miniMode && theme.miniMode.states) {
    for (const [s, files] of Object.entries(theme.miniMode.states)) {
      if (Array.isArray(files)) theme.miniMode.states[s] = files.map(bn);
    }
  }
  if (theme.reactions) {
    for (const r of Object.values(theme.reactions)) {
      if (r && r.file) r.file = bn(r.file);
      if (r && r.fileLeft) r.fileLeft = bn(r.fileLeft);
      if (r && r.fileRight) r.fileRight = bn(r.fileRight);
      if (r && Array.isArray(r.files)) r.files = r.files.map(bn);
    }
  }
  if (theme.sounds) {
    for (const [k, v] of Object.entries(theme.sounds)) theme.sounds[k] = bn(v);
  }
  if (theme.displayHintMap) {
    for (const [k, v] of Object.entries(theme.displayHintMap)) theme.displayHintMap[k] = bn(v);
  }
  if (theme.workingTiers) {
    for (const t of theme.workingTiers) { if (t.file) t.file = bn(t.file); }
  }
  if (theme.jugglingTiers) {
    for (const t of theme.jugglingTiers) { if (t.file) t.file = bn(t.file); }
  }
  if (Array.isArray(theme.idleAnimations)) {
    for (const a of theme.idleAnimations) { if (a && a.file) a.file = bn(a.file); }
  }
  if (theme.updateVisuals) {
    if (typeof theme.updateVisuals.checking === "string" && theme.updateVisuals.checking) {
      theme.updateVisuals.checking = bn(theme.updateVisuals.checking);
    } else {
      delete theme.updateVisuals.checking;
    }
  }
  if (Array.isArray(theme.wideHitboxFiles)) theme.wideHitboxFiles = theme.wideHitboxFiles.map(bn);
  if (Array.isArray(theme.sleepingHitboxFiles)) theme.sleepingHitboxFiles = theme.sleepingHitboxFiles.map(bn);

  return theme;
}

module.exports = {
  DEFAULT_SOUNDS,
  DEFAULT_TIMINGS,
  DEFAULT_HITBOXES,
  DEFAULT_OBJECT_SCALE,
  DEFAULT_LAYOUT,
  DEFAULT_EYE_TRACKING,
  REQUIRED_STATES,
  FULL_SLEEP_REQUIRED_STATES,
  MINI_REQUIRED_STATES,
  VISUAL_FALLBACK_STATES,
  validateTheme,
  mergeDefaults,
  isPlainObject,
  hasNonEmptyArray,
  getStateBindingEntry,
  getStateFiles,
  hasStateFiles,
  hasStateBinding,
  normalizeStateBindings,
  hasReactionBindings,
  supportsIdleTracking,
  deriveIdleMode,
  deriveSleepMode,
  buildCapabilities,
  collectRequiredAssetFiles,
  deepMergeObject,
  basenameOnly,
  normalizeViewBox,
  normalizeTrustedRuntime,
  normalizeRendering,
  normalizeFileViewBoxes,
  normalizeFileHitBoxes,
  mergeFileHitBoxes,
};
