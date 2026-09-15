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
const SAFE_THEME_ASSET_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const SAFE_ACCESSORY_ITEM_ID = /^[a-z][a-z0-9-]{0,31}$/;
const IDLE_EASTER_EGG_MAX_DURATION_MS = 60000;
const IDLE_EASTER_EGG_MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;

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
    } else {
      if (
        cfg.rendering.svgChannel !== undefined
        && cfg.rendering.svgChannel !== "auto"
        && cfg.rendering.svgChannel !== "object"
      ) {
        errors.push(`rendering.svgChannel must be "auto" or "object", got ${cfg.rendering.svgChannel}`);
      }
      if (
        cfg.rendering.objectChannelFiles !== undefined
        && (!Array.isArray(cfg.rendering.objectChannelFiles)
          || cfg.rendering.objectChannelFiles.some((file) => (
            typeof file !== "string"
            || basenameOnly(file) !== file
            || !file.endsWith(".svg")
          )))
      ) {
        errors.push("rendering.objectChannelFiles must contain SVG basenames only");
      }
    }
  }

  const idleEasterEggResult = normalizeIdleEasterEggs(cfg.idleEasterEggs);
  errors.push(...idleEasterEggResult.errors);

  if (cfg.customization !== undefined) {
    if (!isPlainObject(cfg.customization)) {
      errors.push("customization must be an object when present");
    } else {
      if (
        cfg.customization.petTint !== undefined
        && typeof cfg.customization.petTint !== "boolean"
      ) {
        errors.push(`customization.petTint must be a boolean, got ${JSON.stringify(cfg.customization.petTint)}`);
      }
      const accessoryResult = normalizeAccessoryAttachments(
        cfg.customization.accessories,
        cfg
      );
      errors.push(...accessoryResult.errors);
      const mouthAccessoryResult = normalizeMouthAccessoryAttachments(
        cfg.customization.mouthAccessories,
        cfg
      );
      errors.push(...mouthAccessoryResult.errors);
    }
  }

  if (cfg.roamFlipAssets !== undefined && typeof cfg.roamFlipAssets !== "boolean") {
    errors.push(`roamFlipAssets must be a boolean, got ${JSON.stringify(cfg.roamFlipAssets)}`);
  }

  if (cfg.mirroredFiles !== undefined) {
    errors.push(...validateMirroredFiles(cfg.mirroredFiles));
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

function normalizeIdleEasterEggs(value) {
  const errors = [];
  if (value === undefined || value === null) return { value: [], errors };
  if (!Array.isArray(value)) {
    return { value: [], errors: ["idleEasterEggs must be an array when present"] };
  }

  const normalized = [];
  let totalChance = 0;
  for (let index = 0; index < value.length; index++) {
    const entry = value[index];
    const pathName = `idleEasterEggs[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${pathName} must be an object`);
      continue;
    }
    hasOnlyKeys(
      entry,
      new Set(["file", "duration", "chance", "cooldownMs", "requiresAccessories"]),
      pathName,
      errors
    );
    const file = basenameOnly(entry.file);
    const safeFile = typeof entry.file === "string"
      && entry.file === file
      && SAFE_THEME_ASSET_BASENAME.test(file);
    if (!safeFile) errors.push(`${pathName}.file must be a safe basename`);

    const safeDuration = Number.isFinite(entry.duration)
      && entry.duration >= 100
      && entry.duration <= IDLE_EASTER_EGG_MAX_DURATION_MS;
    if (!safeDuration) {
      errors.push(`${pathName}.duration must be between 100 and ${IDLE_EASTER_EGG_MAX_DURATION_MS}`);
    }
    const safeChance = Number.isFinite(entry.chance)
      && entry.chance > 0
      && entry.chance <= 1;
    if (!safeChance) errors.push(`${pathName}.chance must be greater than 0 and at most 1`);
    const safeCooldown = Number.isFinite(entry.cooldownMs)
      && entry.cooldownMs >= 0
      && entry.cooldownMs <= IDLE_EASTER_EGG_MAX_COOLDOWN_MS;
    if (!safeCooldown) {
      errors.push(`${pathName}.cooldownMs must be between 0 and ${IDLE_EASTER_EGG_MAX_COOLDOWN_MS}`);
    }

    const requires = entry.requiresAccessories;
    let safeRequires = isPlainObject(requires);
    if (!safeRequires) {
      errors.push(`${pathName}.requiresAccessories must be an object`);
    } else {
      const keys = Object.keys(requires);
      const unknownKeys = keys.filter((key) => key !== "head" && key !== "mouth");
      for (const key of unknownKeys) {
        errors.push(`${pathName}.requiresAccessories.${key} is not supported`);
      }
      for (const slot of ["head", "mouth"]) {
        if (!SAFE_ACCESSORY_ITEM_ID.test(requires[slot] || "")) {
          errors.push(`${pathName}.requiresAccessories.${slot} must be a safe accessory item id`);
          safeRequires = false;
        }
      }
      if (unknownKeys.length > 0) safeRequires = false;
    }

    if (safeFile && safeDuration && safeChance && safeCooldown && safeRequires) {
      totalChance += entry.chance;
      normalized.push({
        file,
        duration: entry.duration,
        chance: entry.chance,
        cooldownMs: entry.cooldownMs,
        requiresAccessories: { head: requires.head, mouth: requires.mouth },
      });
    }
  }
  if (totalChance > 1 + Number.EPSILON) {
    errors.push("idleEasterEggs total chance must be at most 1");
  }
  return { value: errors.length === 0 ? normalized : [], errors };
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

function isSvgFilename(value) {
  return typeof value === "string" && value.toLowerCase().endsWith(".svg");
}

function hasScriptedSvgRuntime(cfg, options = {}) {
  const trustedRuntimeAllowed = !!options.trustedRuntimeAllowed;
  const scriptedFiles = cfg
    && cfg.trustedRuntime
    && Array.isArray(cfg.trustedRuntime.scriptedSvgFiles)
    ? cfg.trustedRuntime.scriptedSvgFiles
    : [];
  if (trustedRuntimeAllowed && scriptedFiles.some((file) => isSvgFilename(file))) return true;
  return !!(
    isPlainObject(cfg && cfg.rendering)
    && (
      cfg.rendering.svgChannel === "object"
      || (Array.isArray(cfg.rendering.objectChannelFiles)
        && cfg.rendering.objectChannelFiles.some((file) => isSvgFilename(file)))
    )
  );
}

function derivePowerProfile(cfg, options = {}) {
  return hasScriptedSvgRuntime(cfg, options) ? "scripted" : "standard";
}

function addVisualUsage(out, stateFamily, file, source) {
  const safe = basenameOnly(file);
  if (!safe) return;
  out.push({ stateFamily, file: safe, source });
}

function addVisualBinding(out, stateFamily, binding, source) {
  for (const file of getStateFiles(binding)) {
    addVisualUsage(out, stateFamily, file, source);
  }
}

function getCanonicalFileViewBoxes(cfg) {
  const out = {};
  if (!isPlainObject(cfg && cfg.fileViewBoxes)) return out;
  for (const [rawFile, rawViewBox] of Object.entries(cfg.fileViewBoxes)) {
    const file = basenameOnly(rawFile);
    const viewBox = normalizeViewBox(rawViewBox);
    if (file && viewBox) out[file] = viewBox;
  }
  return out;
}

/**
 * Canonical projection of every runtime-reachable visual usage. Unlike the
 * historical filename Set this retains the state family and effective
 * viewBox, so accessory coverage cannot accidentally apply root coordinates
 * to mini art. This is intentionally pure and works on raw or normalized
 * theme objects.
 */
function projectThemeVisualUsages(cfg) {
  const usages = [];
  for (const [state, binding] of Object.entries((cfg && cfg.states) || {})) {
    addVisualBinding(usages, `normal:${state}`, binding, `states.${state}`);
  }
  if (isMiniSupported(cfg)) {
    for (const [state, binding] of Object.entries(
      (cfg && cfg.miniMode && cfg.miniMode.states) || {}
    )) {
      addVisualBinding(usages, `mini:${state}`, binding, `miniMode.states.${state}`);
    }
  }
  for (const [groupName, group] of [
    ["workingTiers", cfg && cfg.workingTiers],
    ["jugglingTiers", cfg && cfg.jugglingTiers],
    ["idleAnimations", cfg && cfg.idleAnimations],
    ["idleEasterEggs", cfg && cfg.idleEasterEggs],
  ]) {
    for (const entry of Array.isArray(group) ? group : []) {
      if (entry && typeof entry.file === "string") {
        addVisualUsage(usages, `normal:${groupName}`, entry.file, groupName);
      }
    }
  }
  for (const [name, entry] of Object.entries((cfg && cfg.reactions) || {})) {
    if (!isPlainObject(entry)) continue;
    for (const key of ["file", "fileLeft", "fileRight"]) {
      if (typeof entry[key] === "string") {
        addVisualUsage(usages, `reaction:${name}`, entry[key], `reactions.${name}.${key}`);
      }
    }
    for (const file of Array.isArray(entry.files) ? entry.files : []) {
      addVisualUsage(usages, `reaction:${name}`, file, `reactions.${name}.files`);
    }
  }
  for (const [hint, file] of Object.entries((cfg && cfg.displayHintMap) || {})) {
    if (typeof file === "string") {
      addVisualUsage(usages, `display-hint:${hint}`, file, `displayHintMap.${hint}`);
    }
  }
  if (
    isPlainObject(cfg && cfg.updateVisuals)
    && typeof cfg.updateVisuals.checking === "string"
  ) {
    addVisualUsage(
      usages,
      "normal:update-checking",
      cfg.updateVisuals.checking,
      "updateVisuals.checking"
    );
  }
  if (
    isPlainObject(cfg && cfg.timings)
    && typeof cfg.timings.dndSleepTransitionSvg === "string"
  ) {
    addVisualUsage(
      usages,
      "dnd:sleep-transition",
      cfg.timings.dndSleepTransitionSvg,
      "timings.dndSleepTransitionSvg"
    );
  }
  const lowPower = cfg
    && cfg.rendering
    && cfg.rendering.lowPowerStaticImageOverrides;
  for (const [state, override] of Object.entries(lowPower || {})) {
    if (!isPlainObject(override)) continue;
    const isMiniState = state.startsWith("mini-");
    if (isMiniState && !isMiniSupported(cfg)) continue;
    const usageFamily = isMiniState ? "mini:" : "";
    if (typeof override.from === "string") {
      addVisualUsage(
        usages,
        `${usageFamily}low-power-source:${state}`,
        override.from,
        `rendering.lowPowerStaticImageOverrides.${state}.from`
      );
    }
    if (typeof override.to === "string") {
      addVisualUsage(
        usages,
        `${usageFamily}low-power-static:${state}`,
        override.to,
        `rendering.lowPowerStaticImageOverrides.${state}.to`
      );
    }
  }
  const rootViewBox = normalizeViewBox(cfg && cfg.viewBox);
  const miniViewBox = normalizeViewBox(cfg && cfg.miniMode && cfg.miniMode.viewBox);
  const fileViewBoxes = getCanonicalFileViewBoxes(cfg);
  return usages.map((usage) => {
    const fileViewBox = fileViewBoxes[usage.file];
    const isMini = usage.stateFamily.startsWith("mini:");
    const effectiveViewBox = fileViewBox || (isMini && miniViewBox) || rootViewBox;
    return {
      ...usage,
      effectiveViewBox: effectiveViewBox ? { ...effectiveViewBox } : null,
      viewBoxSource: fileViewBox ? "file" : (isMini && miniViewBox ? "mini" : "root"),
    };
  });
}

function hasOnlyKeys(value, allowed, pathName, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${pathName}.${key} is not supported`);
  }
}

function normalizeAccessoryFrame(value, viewBox, pathName, errors, targetLocal = false) {
  if (!isPlainObject(value)) {
    errors.push(`${pathName} must be an object`);
    return null;
  }
  hasOnlyKeys(value, new Set(["cx", "baseY", "width"]), pathName, errors);
  const { cx, baseY, width } = value;
  if (![cx, baseY, width].every(Number.isFinite) || width <= 0) {
    errors.push(`${pathName} must contain finite cx/baseY and positive width`);
    return null;
  }
  if (targetLocal) {
    if (Math.abs(cx) > 1_000_000 || Math.abs(baseY) > 1_000_000 || width > 1_000_000) {
      errors.push(`${pathName} exceeds target-local numeric limits`);
      return null;
    }
  } else {
    if (!viewBox) {
      errors.push(`${pathName} cannot be validated without an effective viewBox`);
      return null;
    }
    if (
      width > 4 * viewBox.width
      || cx < viewBox.x - viewBox.width
      || cx > viewBox.x + 2 * viewBox.width
      || baseY < viewBox.y - viewBox.height
      || baseY > viewBox.y + 2 * viewBox.height
    ) {
      errors.push(`${pathName} exceeds effective viewBox bounds`);
      return null;
    }
  }
  return { cx, baseY, width };
}

function normalizeAccessoryFollowTarget(value, pathName, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${pathName} must be an object`);
    return null;
  }
  hasOnlyKeys(value, new Set(["id", "frame", "normalizeReflection"]), pathName, errors);
  if (
    typeof value.id !== "string"
    || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(value.id)
  ) {
    errors.push(`${pathName}.id must be a safe exact SVG id`);
  }
  const frame = normalizeAccessoryFrame(
    value.frame,
    null,
    `${pathName}.frame`,
    errors,
    true
  );
  if (
    value.normalizeReflection !== undefined
    && value.normalizeReflection !== "x"
  ) {
    errors.push(`${pathName}.normalizeReflection must be "x" when present`);
  }
  if (
    typeof value.id !== "string"
    || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(value.id)
    || !frame
    || (value.normalizeReflection !== undefined && value.normalizeReflection !== "x")
  ) {
    return null;
  }
  return {
    id: value.id,
    frame,
    ...(value.normalizeReflection === "x" ? { normalizeReflection: "x" } : {}),
  };
}

function normalizeAccessoryHitBoxPadding(value, viewBox, pathName, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${pathName} must be an object`);
    return null;
  }
  hasOnlyKeys(value, new Set(["left", "top", "right", "bottom"]), pathName, errors);
  if (!viewBox) {
    errors.push(`${pathName} cannot be validated without an effective viewBox`);
    return null;
  }

  const normalized = {};
  for (const [key, limit] of [
    ["left", viewBox.width],
    ["top", viewBox.height],
    ["right", viewBox.width],
    ["bottom", viewBox.height],
  ]) {
    if (value[key] === undefined) continue;
    if (!Number.isFinite(value[key]) || value[key] < 0 || value[key] > limit) {
      errors.push(`${pathName}.${key} must be a finite non-negative value within viewBox limits`);
      continue;
    }
    normalized[key] = value[key];
  }
  return normalized;
}

function normalizeAccessoryStaticSection(value, viewBox, pathName, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${pathName} must be an object`);
    return null;
  }
  hasOnlyKeys(value, new Set(["staticFrame", "hitBoxPadding"]), pathName, errors);
  const staticFrame = normalizeAccessoryFrame(
    value.staticFrame,
    viewBox,
    `${pathName}.staticFrame`,
    errors
  );
  const hitBoxPadding = value.hitBoxPadding === undefined
    ? null
    : normalizeAccessoryHitBoxPadding(
      value.hitBoxPadding,
      viewBox,
      `${pathName}.hitBoxPadding`,
      errors
    );
  if (!staticFrame || (value.hitBoxPadding !== undefined && !hitBoxPadding)) return null;
  return hitBoxPadding ? { staticFrame, hitBoxPadding } : { staticFrame };
}

function viewBoxKey(viewBox) {
  if (!viewBox) return "missing";
  return [viewBox.x, viewBox.y, viewBox.width, viewBox.height].join(",");
}

function normalizeAccessoryFileDescriptor(value, viewBox, pathName, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${pathName} must be an object`);
    return null;
  }
  hasOnlyKeys(
    value,
    new Set(["visibility", "staticFrame", "followTarget", "hitBoxPadding"]),
    pathName,
    errors
  );
  if (value.visibility !== undefined) {
    if (value.visibility !== "hidden") {
      errors.push(`${pathName}.visibility must be "hidden"`);
      return null;
    }
    if (
      value.staticFrame !== undefined
      || value.followTarget !== undefined
      || value.hitBoxPadding !== undefined
    ) {
      errors.push(`${pathName} hidden descriptors cannot define placement`);
      return null;
    }
    return { visibility: "hidden" };
  }
  const staticFrame = normalizeAccessoryFrame(
    value.staticFrame,
    viewBox,
    `${pathName}.staticFrame`,
    errors
  );
  const followTarget = value.followTarget === undefined
    ? null
    : normalizeAccessoryFollowTarget(
      value.followTarget,
      `${pathName}.followTarget`,
      errors
    );
  const hitBoxPadding = value.hitBoxPadding === undefined
    ? null
    : normalizeAccessoryHitBoxPadding(
      value.hitBoxPadding,
      viewBox,
      `${pathName}.hitBoxPadding`,
      errors
    );
  if (
    !staticFrame
    || (value.followTarget !== undefined && !followTarget)
    || (value.hitBoxPadding !== undefined && !hitBoxPadding)
  ) return null;
  return {
    staticFrame,
    ...(followTarget ? { followTarget } : {}),
    ...(hitBoxPadding ? { hitBoxPadding } : {}),
  };
}

function normalizeAttachmentCollection(value, cfg, options) {
  const pathName = options.pathName;
  const allowItemOverrides = options.allowItemOverrides === true;
  const errors = [];
  if (value === undefined || value === false || value === null) {
    return { value: null, errors };
  }
  if (!isPlainObject(value)) {
    return {
      value: null,
      errors: [`${pathName} must be an object or false`],
    };
  }
  hasOnlyKeys(
    value,
    new Set(["default", "mini", "files", ...(allowItemOverrides ? ["itemOverrides"] : [])]),
    pathName,
    errors
  );

  const rootViewBox = normalizeViewBox(cfg && cfg.viewBox);
  const miniViewBox = normalizeViewBox(cfg && cfg.miniMode && cfg.miniMode.viewBox);
  const usages = projectThemeVisualUsages(cfg);
  const usagesByFile = new Map();
  for (const usage of usages) {
    const existing = usagesByFile.get(usage.file) || [];
    existing.push(usage);
    usagesByFile.set(usage.file, existing);
  }

  const normalized = { files: {} };
  if (value.default !== undefined) {
    const defaultSection = normalizeAccessoryStaticSection(
      value.default,
      rootViewBox,
      `${pathName}.default`,
      errors
    );
    if (defaultSection) normalized.default = defaultSection;
  }
  if (value.mini !== undefined) {
    const miniSection = normalizeAccessoryStaticSection(
      value.mini,
      miniViewBox,
      `${pathName}.mini`,
      errors
    );
    if (miniSection) normalized.mini = miniSection;
  }
  if (value.files !== undefined) {
    if (!isPlainObject(value.files)) {
      errors.push(`${pathName}.files must be an object map`);
    } else {
      for (const [rawFile, descriptor] of Object.entries(value.files)) {
        const file = basenameOnly(rawFile);
        if (
          typeof rawFile !== "string"
          || rawFile !== file
          || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(file)
        ) {
          errors.push(`${pathName}.files["${rawFile}"] must be a safe basename`);
          continue;
        }
        const fileUsages = usagesByFile.get(file) || [];
        const uniqueViewBoxes = new Map();
        for (const usage of fileUsages) {
          uniqueViewBoxes.set(viewBoxKey(usage.effectiveViewBox), usage.effectiveViewBox);
        }
        if (uniqueViewBoxes.size > 1) {
          errors.push(`${pathName}.files["${file}"] has multiple effective viewBoxes`);
          continue;
        }
        const effectiveViewBox = uniqueViewBoxes.size === 1
          ? [...uniqueViewBoxes.values()][0]
          : (getCanonicalFileViewBoxes(cfg)[file] || rootViewBox);
        const normalizedDescriptor = normalizeAccessoryFileDescriptor(
          descriptor,
          effectiveViewBox,
          `${pathName}.files["${file}"]`,
          errors
        );
        if (normalizedDescriptor) normalized.files[file] = normalizedDescriptor;
      }
    }
  }

  if (allowItemOverrides && value.itemOverrides !== undefined) {
    normalized.itemOverrides = {};
    if (!isPlainObject(value.itemOverrides)) {
      errors.push(`${pathName}.itemOverrides must be an object map`);
    } else {
      for (const [itemId, itemOverride] of Object.entries(value.itemOverrides)) {
        const itemPath = `${pathName}.itemOverrides["${itemId}"]`;
        if (!/^[a-z][a-z0-9-]{0,31}$/.test(itemId)) {
          errors.push(`${itemPath} must use a safe accessory item id`);
          continue;
        }
        if (!isPlainObject(itemOverride)) {
          errors.push(`${itemPath} must be an object`);
          continue;
        }
        hasOnlyKeys(itemOverride, new Set(["files"]), itemPath, errors);
        if (!isPlainObject(itemOverride.files)) {
          errors.push(`${itemPath}.files must be an object map`);
          continue;
        }
        const normalizedItem = { files: {} };
        for (const [rawFile, descriptor] of Object.entries(itemOverride.files)) {
          const file = basenameOnly(rawFile);
          const descriptorPath = `${itemPath}.files["${rawFile}"]`;
          if (
            rawFile !== file
            || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(file)
          ) {
            errors.push(`${descriptorPath} must use a safe basename`);
            continue;
          }
          const fileUsages = usagesByFile.get(file) || [];
          if (fileUsages.length === 0) {
            errors.push(`${descriptorPath} must reference a reachable theme visual`);
            continue;
          }
          const uniqueViewBoxes = new Map();
          for (const usage of fileUsages) {
            uniqueViewBoxes.set(viewBoxKey(usage.effectiveViewBox), usage.effectiveViewBox);
          }
          if (uniqueViewBoxes.size !== 1) {
            errors.push(`${descriptorPath} has multiple effective viewBoxes`);
            continue;
          }
          const effectiveViewBox = [...uniqueViewBoxes.values()][0];
          const normalizedDescriptor = normalizeAccessoryFileDescriptor(
            descriptor,
            effectiveViewBox,
            descriptorPath,
            errors
          );
          if (normalizedDescriptor) normalizedItem.files[file] = normalizedDescriptor;
        }
        normalized.itemOverrides[itemId] = normalizedItem;
      }
    }
  }
  return {
    value: errors.length === 0 ? normalized : null,
    errors,
  };
}

/**
 * Strictly normalize head attachments. Structural errors are returned to
 * validateTheme; ordinary coverage gaps only disable the capability.
 */
function normalizeAccessoryAttachments(value, cfg) {
  return normalizeAttachmentCollection(value, cfg, {
    pathName: "customization.accessories",
    allowItemOverrides: true,
  });
}

function normalizeMouthAccessoryAttachments(value, cfg) {
  return normalizeAttachmentCollection(value, cfg, {
    pathName: "customization.mouthAccessories",
    allowItemOverrides: false,
  });
}

function deriveAttachmentCapability(cfg, fieldName, normalize) {
  const parsed = normalize(
    cfg && cfg.customization && cfg.customization[fieldName],
    cfg
  );
  if (parsed.errors.length > 0 || !parsed.value) return false;
  const attachments = parsed.value;
  const usages = projectThemeVisualUsages(cfg);
  if (usages.length === 0) return false;

  const viewBoxesByFile = new Map();
  for (const usage of usages) {
    const keys = viewBoxesByFile.get(usage.file) || new Set();
    keys.add(viewBoxKey(usage.effectiveViewBox));
    viewBoxesByFile.set(usage.file, keys);
  }
  if ([...viewBoxesByFile.values()].some((keys) => keys.size !== 1)) return false;

  for (const usage of usages) {
    if (!usage.effectiveViewBox) return false;
    const fileDescriptor = attachments.files[usage.file];
    if (fileDescriptor) {
      if (fileDescriptor.visibility === "hidden") continue;
      if (!fileDescriptor.staticFrame) return false;
      continue;
    }
    if (usage.viewBoxSource === "file") return false;
    if (usage.viewBoxSource === "mini") {
      if (!attachments.mini || !attachments.mini.staticFrame) return false;
      continue;
    }
    if (!attachments.default || !attachments.default.staticFrame) return false;
  }
  return true;
}

function deriveAccessoryCapability(cfg) {
  return deriveAttachmentCapability(cfg, "accessories", normalizeAccessoryAttachments);
}

function deriveMouthAccessoryCapability(cfg) {
  return deriveAttachmentCapability(
    cfg,
    "mouthAccessories",
    normalizeMouthAccessoryAttachments
  );
}

/**
 * Resolve an already-authorized accessory wardrobe against the effective
 * runtime visuals. The authored theme owns the capability decision; user
 * animation overrides only choose the descriptor for each reachable file.
 *
 * Runtime descriptors are materialized per file instead of retaining the
 * authored default/mini fallbacks. That makes an unknown or geometrically
 * unsafe frame fail closed locally without disabling the whole wardrobe, and
 * prevents mini artwork from ever falling through to root coordinates.
 */
function resolveEffectiveAttachmentCollection(authoredCfg, effectiveCfg, options) {
  const fieldName = options.fieldName;
  const pathName = options.pathName;
  const normalize = options.normalize;
  const derive = options.derive;
  if (!derive(authoredCfg)) return null;

  const parsed = normalize(
    authoredCfg && authoredCfg.customization && authoredCfg.customization[fieldName],
    authoredCfg
  );
  if (parsed.errors.length > 0 || !parsed.value) return null;

  const authored = parsed.value;
  const usagesByFile = new Map();
  for (const usage of projectThemeVisualUsages(effectiveCfg)) {
    const entries = usagesByFile.get(usage.file) || [];
    entries.push(usage);
    usagesByFile.set(usage.file, entries);
  }

  // Preserve exact descriptors for optional animation-library assets even
  // when no current binding selects them. The Settings picker can make one of
  // these files reachable later; retaining the descriptor also keeps direct
  // preview and geometry audits on the same policy as the eventual override.
  const resolved = { files: { ...authored.files } };
  for (const [file, usages] of usagesByFile) {
    const viewBoxes = new Map();
    for (const usage of usages) {
      viewBoxes.set(viewBoxKey(usage.effectiveViewBox), usage.effectiveViewBox);
    }
    if (viewBoxes.size !== 1 || ![...viewBoxes.values()][0]) {
      resolved.files[file] = { visibility: "hidden" };
      continue;
    }
    const effectiveViewBox = [...viewBoxes.values()][0];

    const exact = authored.files[file];
    if (exact) {
      const errors = [];
      const descriptor = normalizeAccessoryFileDescriptor(
        exact,
        effectiveViewBox,
        `effective ${pathName}.files["${file}"]`,
        errors
      );
      resolved.files[file] = errors.length === 0 && descriptor
        ? descriptor
        : { visibility: "hidden" };
      continue;
    }

    const miniFlags = new Set(
      usages.map((usage) => usage.stateFamily.startsWith("mini:"))
    );
    if (miniFlags.size !== 1) {
      resolved.files[file] = { visibility: "hidden" };
      continue;
    }

    const isMini = [...miniFlags][0];
    const expectedViewBoxSource = isMini ? "mini" : "root";
    const fallback = isMini ? authored.mini : authored.default;
    if (
      !fallback
      || usages.some((usage) => usage.viewBoxSource !== expectedViewBoxSource)
    ) {
      resolved.files[file] = { visibility: "hidden" };
      continue;
    }

    const errors = [];
    const descriptor = normalizeAccessoryStaticSection(
      fallback,
      effectiveViewBox,
      `effective ${pathName}.files["${file}"]`,
      errors
    );
    resolved.files[file] = errors.length === 0 && descriptor
      ? descriptor
      : { visibility: "hidden" };
  }

  if (authored.itemOverrides) {
    resolved.itemOverrides = {};
    for (const [itemId, itemOverride] of Object.entries(authored.itemOverrides)) {
      const resolvedItem = { files: {} };
      for (const [file, descriptor] of Object.entries(itemOverride.files || {})) {
        const usages = usagesByFile.get(file);
        if (!usages || usages.length === 0) continue;
        const viewBoxes = new Map();
        for (const usage of usages) {
          viewBoxes.set(viewBoxKey(usage.effectiveViewBox), usage.effectiveViewBox);
        }
        if (viewBoxes.size !== 1 || ![...viewBoxes.values()][0]) {
          resolvedItem.files[file] = { visibility: "hidden" };
          continue;
        }
        const errors = [];
        const normalized = normalizeAccessoryFileDescriptor(
          descriptor,
          [...viewBoxes.values()][0],
          `effective ${pathName}.itemOverrides["${itemId}"].files["${file}"]`,
          errors
        );
        resolvedItem.files[file] = errors.length === 0 && normalized
          ? normalized
          : { visibility: "hidden" };
      }
      if (Object.keys(resolvedItem.files).length > 0) {
        resolved.itemOverrides[itemId] = resolvedItem;
      }
    }
  }

  return resolved;
}


function resolveEffectiveAccessoryAttachments(authoredCfg, effectiveCfg) {
  return resolveEffectiveAttachmentCollection(authoredCfg, effectiveCfg, {
    fieldName: "accessories",
    pathName: "customization.accessories",
    normalize: normalizeAccessoryAttachments,
    derive: deriveAccessoryCapability,
  });
}

function resolveEffectiveMouthAccessoryAttachments(authoredCfg, effectiveCfg) {
  return resolveEffectiveAttachmentCollection(authoredCfg, effectiveCfg, {
    fieldName: "mouthAccessories",
    pathName: "customization.mouthAccessories",
    normalize: normalizeMouthAccessoryAttachments,
    derive: deriveMouthAccessoryCapability,
  });
}

function buildCapabilities(cfg, options = {}) {
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
    powerProfile: derivePowerProfile(cfg, options),
    petTint: !!(
      isPlainObject(cfg && cfg.customization)
      && cfg.customization.petTint === true
    ),
    accessories: deriveAccessoryCapability(cfg),
    mouthAccessories: deriveMouthAccessoryCapability(cfg),
  };
}

// mirroredFiles: { "<file>": "<variant>" }. Whenever the runtime draws a file
// mirrored (left mini edge, leftward roam) it shows the variant, whose glyphs
// are pre-mirrored so text reads the right way round (src/mirrored-files.js).
function validateMirroredFiles(value) {
  if (!isPlainObject(value)) {
    return [`mirroredFiles must be an object mapping a file to its mirrored-display variant, got ${JSON.stringify(value)}`];
  }
  const errors = [];
  for (const [from, to] of Object.entries(value)) {
    if (typeof to !== "string" || !basenameOnly(to)) {
      errors.push(`mirroredFiles["${from}"] must be a file name, got ${JSON.stringify(to)}`);
    } else if (basenameOnly(to) === basenameOnly(from)) {
      errors.push(`mirroredFiles["${from}"] must name a different file`);
    }
  }
  return errors;
}

function normalizeMirroredFiles(value) {
  const out = {};
  if (!isPlainObject(value)) return out;
  for (const [from, to] of Object.entries(value)) {
    const source = basenameOnly(from);
    const target = typeof to === "string" ? basenameOnly(to) : "";
    if (source && target && source !== target) out[source] = target;
  }
  return out;
}

function addThemeAssetFile(out, filename) {
  if (typeof filename !== "string") return;
  const safe = basenameOnly(filename);
  if (safe) out.add(safe);
}

function collectRequiredAssetFiles(theme) {
  const files = new Set();
  for (const usage of projectThemeVisualUsages(theme)) {
    addThemeAssetFile(files, usage.file);
  }
  // Exact attachment descriptors may also prepare an otherwise optional file
  // for the animation-override picker. Treat those library assets as required
  // so typos fail asset validation and external SVGs still pass sanitization.
  for (const field of ["accessories", "mouthAccessories"]) {
    const attachments = theme && theme.customization && theme.customization[field];
    for (const file of Object.keys((attachments && attachments.files) || {})) {
      addThemeAssetFile(files, file);
    }
  }
  const objectChannelFiles = theme && theme.rendering && theme.rendering.objectChannelFiles;
  for (const file of Array.isArray(objectChannelFiles) ? objectChannelFiles : []) {
    addThemeAssetFile(files, file);
  }
  const mirroredFiles = theme && theme.mirroredFiles;
  for (const file of Object.values(isPlainObject(mirroredFiles) ? mirroredFiles : {})) {
    addThemeAssetFile(files, file);
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
  const lowPowerStaticImageOverrides = {};
  const objectChannelFiles = [];
  const seenObjectChannelFiles = new Set();
  for (const file of Array.isArray(value.objectChannelFiles) ? value.objectChannelFiles : []) {
    if (typeof file !== "string") continue;
    const safeFile = basenameOnly(file);
    if (!safeFile || !safeFile.endsWith(".svg") || seenObjectChannelFiles.has(safeFile)) continue;
    seenObjectChannelFiles.add(safeFile);
    objectChannelFiles.push(safeFile);
  }
  if (isPlainObject(value.lowPowerStaticImageOverrides)) {
    for (const [state, override] of Object.entries(value.lowPowerStaticImageOverrides)) {
      if (!isPlainObject(override)) continue;
      const from = basenameOnly(override.from);
      const to = basenameOnly(override.to);
      if (!state || !from || !to) continue;
      lowPowerStaticImageOverrides[state] = { from, to };
    }
  }
  const rendering = {
    svgChannel: value.svgChannel === "object" ? "object" : "auto",
  };
  if (Object.keys(lowPowerStaticImageOverrides).length > 0) {
    rendering.lowPowerStaticImageOverrides = lowPowerStaticImageOverrides;
  }
  if (objectChannelFiles.length > 0) rendering.objectChannelFiles = objectChannelFiles;
  return {
    ...rendering,
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
  theme.customization = {
    petTint: !!(
      isPlainObject(raw.customization)
      && raw.customization.petTint === true
    ),
    accessories: null,
    mouthAccessories: null,
  };

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

  // Roam visuals are mirrored while walking left, assuming right-facing
  // artwork; themes whose roam asset is drawn facing left set this to invert
  // the mirror. Pure rendering flag — safe for external themes.
  theme.roamFlipAssets = !!raw.roamFlipAssets;
  // Pre-mirrored-glyph variants shown whenever a file is drawn mirrored.
  theme.mirroredFiles = normalizeMirroredFiles(raw.mirroredFiles);

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

  theme.customization.accessories = normalizeAccessoryAttachments(
    isPlainObject(raw.customization) ? raw.customization.accessories : undefined,
    theme
  ).value;
  theme.customization.mouthAccessories = normalizeMouthAccessoryAttachments(
    isPlainObject(raw.customization) ? raw.customization.mouthAccessories : undefined,
    theme
  ).value;

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
  theme.idleEasterEggs = normalizeIdleEasterEggs(raw.idleEasterEggs).value;

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
  if (
    theme.timings
    && typeof theme.timings.dndSleepTransitionSvg === "string"
    && theme.timings.dndSleepTransitionSvg
  ) {
    theme.timings.dndSleepTransitionSvg = bn(theme.timings.dndSleepTransitionSvg);
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
  normalizeIdleEasterEggs,
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
  projectThemeVisualUsages,
  normalizeAccessoryAttachments,
  normalizeMouthAccessoryAttachments,
  deriveAccessoryCapability,
  deriveMouthAccessoryCapability,
  resolveEffectiveAccessoryAttachments,
  resolveEffectiveMouthAccessoryAttachments,
  collectRequiredAssetFiles,
  deepMergeObject,
  basenameOnly,
  normalizeViewBox,
  normalizeTrustedRuntime,
  normalizeRendering,
  normalizeFileViewBoxes,
  getCanonicalFileViewBoxes,
  normalizeFileHitBoxes,
  mergeFileHitBoxes,
};
