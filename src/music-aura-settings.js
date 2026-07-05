"use strict";

const DEFAULT_MUSIC_AURA_SETTINGS = Object.freeze({
  enabled: false,
  libraryDirs: [],
  volume: 0.55,
  shuffle: true,
  autoStart: false,
  visualEnabled: true,
  visualStyle: "galaxy",
  particlesAlwaysOn: true,
  backgroundAdaptation: "auto",
  particleOpacity: 1.18,
  glowStrength: 1.25,
  pointScale: 0.82,
  particleDensity: 1,
  particlePalette: "default",
  autoViewMode: "standard",
  auraOffsetX: 0,
  auraOffsetY: 0,
  auraScale: 1,
  auraPlacementByTheme: {},
  intensity: "vivid",
  performance: "auto",
  lowPerformanceProtection: true,
  stateReactive: true,
  miniModeEnabled: true,
  continueWhenHidden: true,
});

const MUSIC_AURA_VISUAL_STYLES = Object.freeze(["galaxy", "vinyl", "planet", "tunnel", "aurora"]);
const MUSIC_AURA_BACKGROUND_ADAPTATIONS = Object.freeze(["auto", "dark", "light", "contrast"]);
const MUSIC_AURA_PARTICLE_PALETTES = Object.freeze(["default", "contrast", "aurora", "neon", "warm"]);
const MUSIC_AURA_AUTO_VIEW_MODES = Object.freeze(["off", "subtle", "standard", "strong"]);
const MUSIC_AURA_INTENSITIES = Object.freeze(["subtle", "vivid", "stage"]);
const MUSIC_AURA_PERFORMANCE_MODES = Object.freeze(["eco", "auto", "high"]);

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeBoundedNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function normalizeVisualStyle(value, fallback = DEFAULT_MUSIC_AURA_SETTINGS.visualStyle) {
  if (value === "hologram") return "galaxy";
  if (MUSIC_AURA_VISUAL_STYLES.includes(value)) return value;
  if (fallback === "hologram") return "galaxy";
  if (MUSIC_AURA_VISUAL_STYLES.includes(fallback)) return fallback;
  return DEFAULT_MUSIC_AURA_SETTINGS.visualStyle;
}

function normalizeParticlePalette(value, fallback = DEFAULT_MUSIC_AURA_SETTINGS.particlePalette) {
  if (value === "mineradio") return "default";
  if (MUSIC_AURA_PARTICLE_PALETTES.includes(value)) return value;
  if (fallback === "mineradio") return "default";
  if (MUSIC_AURA_PARTICLE_PALETTES.includes(fallback)) return fallback;
  return DEFAULT_MUSIC_AURA_SETTINGS.particlePalette;
}

function normalizeLibraryDirs(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const dir = String(item || "").trim();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
    if (out.length >= 16) break;
  }
  return out;
}

function normalizeAuraOffset(value, fallback = 0) {
  return normalizeBoundedNumber(value, -0.35, 0.35, fallback);
}

function normalizeAuraScale(value, fallback = 1) {
  return normalizeBoundedNumber(value, 0.7, 1.35, fallback);
}

function normalizeAuraPlacementByTheme(value, defaultsValue) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const defaults = defaultsValue && typeof defaultsValue === "object" && !Array.isArray(defaultsValue)
    ? defaultsValue
    : {};
  const out = {};
  const keys = new Set([...Object.keys(defaults), ...Object.keys(source)]);
  for (const rawKey of keys) {
    const themeId = String(rawKey || "").trim();
    if (!themeId || themeId.length > 80) continue;
    const sourcePlacement = source[themeId] && typeof source[themeId] === "object" && !Array.isArray(source[themeId])
      ? source[themeId]
      : {};
    const defaultPlacement = defaults[themeId] && typeof defaults[themeId] === "object" && !Array.isArray(defaults[themeId])
      ? defaults[themeId]
      : {};
    out[themeId] = {
      offsetX: normalizeAuraOffset(sourcePlacement.offsetX, normalizeAuraOffset(defaultPlacement.offsetX, 0)),
      offsetY: normalizeAuraOffset(sourcePlacement.offsetY, normalizeAuraOffset(defaultPlacement.offsetY, 0)),
      scale: normalizeAuraScale(sourcePlacement.scale, normalizeAuraScale(defaultPlacement.scale, 1)),
    };
  }
  return out;
}

function normalizeMusicAuraSettings(value, defaultsValue = DEFAULT_MUSIC_AURA_SETTINGS) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const defaults = defaultsValue && typeof defaultsValue === "object"
    ? defaultsValue
    : DEFAULT_MUSIC_AURA_SETTINGS;
  const intensity = MUSIC_AURA_INTENSITIES.includes(source.intensity)
    ? source.intensity
    : (MUSIC_AURA_INTENSITIES.includes(defaults.intensity) ? defaults.intensity : DEFAULT_MUSIC_AURA_SETTINGS.intensity);
  const performance = MUSIC_AURA_PERFORMANCE_MODES.includes(source.performance)
    ? source.performance
    : (MUSIC_AURA_PERFORMANCE_MODES.includes(defaults.performance) ? defaults.performance : DEFAULT_MUSIC_AURA_SETTINGS.performance);
  const visualStyle = normalizeVisualStyle(source.visualStyle, defaults.visualStyle);
  const backgroundAdaptation = MUSIC_AURA_BACKGROUND_ADAPTATIONS.includes(source.backgroundAdaptation)
    ? source.backgroundAdaptation
    : (MUSIC_AURA_BACKGROUND_ADAPTATIONS.includes(defaults.backgroundAdaptation)
      ? defaults.backgroundAdaptation
      : DEFAULT_MUSIC_AURA_SETTINGS.backgroundAdaptation);
  const particlePalette = normalizeParticlePalette(source.particlePalette, defaults.particlePalette);
  const autoViewMode = MUSIC_AURA_AUTO_VIEW_MODES.includes(source.autoViewMode)
    ? source.autoViewMode
    : (MUSIC_AURA_AUTO_VIEW_MODES.includes(defaults.autoViewMode)
      ? defaults.autoViewMode
      : DEFAULT_MUSIC_AURA_SETTINGS.autoViewMode);
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : !!defaults.enabled,
    libraryDirs: normalizeLibraryDirs(source.libraryDirs),
    volume: clampNumber(source.volume, 0, 1, Number.isFinite(defaults.volume) ? defaults.volume : 0.55),
    shuffle: typeof source.shuffle === "boolean" ? source.shuffle : defaults.shuffle !== false,
    autoStart: typeof source.autoStart === "boolean" ? source.autoStart : !!defaults.autoStart,
    visualEnabled: typeof source.visualEnabled === "boolean" ? source.visualEnabled : defaults.visualEnabled !== false,
    visualStyle,
    particlesAlwaysOn: typeof source.particlesAlwaysOn === "boolean"
      ? source.particlesAlwaysOn
      : defaults.particlesAlwaysOn !== false,
    backgroundAdaptation,
    particleOpacity: normalizeBoundedNumber(
      source.particleOpacity,
      0.2,
      1.8,
      normalizeBoundedNumber(defaults.particleOpacity, 0.2, 1.8, DEFAULT_MUSIC_AURA_SETTINGS.particleOpacity),
    ),
    glowStrength: normalizeBoundedNumber(
      source.glowStrength,
      0,
      1.8,
      normalizeBoundedNumber(defaults.glowStrength, 0, 1.8, DEFAULT_MUSIC_AURA_SETTINGS.glowStrength),
    ),
    pointScale: normalizeBoundedNumber(
      source.pointScale,
      0.45,
      1.4,
      normalizeBoundedNumber(defaults.pointScale, 0.45, 1.4, DEFAULT_MUSIC_AURA_SETTINGS.pointScale),
    ),
    particleDensity: normalizeBoundedNumber(
      source.particleDensity,
      0.45,
      1.5,
      normalizeBoundedNumber(defaults.particleDensity, 0.45, 1.5, DEFAULT_MUSIC_AURA_SETTINGS.particleDensity),
    ),
    particlePalette,
    autoViewMode,
    auraOffsetX: normalizeAuraOffset(
      source.auraOffsetX,
      normalizeAuraOffset(defaults.auraOffsetX, DEFAULT_MUSIC_AURA_SETTINGS.auraOffsetX),
    ),
    auraOffsetY: normalizeAuraOffset(
      source.auraOffsetY,
      normalizeAuraOffset(defaults.auraOffsetY, DEFAULT_MUSIC_AURA_SETTINGS.auraOffsetY),
    ),
    auraScale: normalizeAuraScale(
      source.auraScale,
      normalizeAuraScale(defaults.auraScale, DEFAULT_MUSIC_AURA_SETTINGS.auraScale),
    ),
    auraPlacementByTheme: normalizeAuraPlacementByTheme(source.auraPlacementByTheme, defaults.auraPlacementByTheme),
    intensity,
    performance,
    lowPerformanceProtection: typeof source.lowPerformanceProtection === "boolean"
      ? source.lowPerformanceProtection
      : defaults.lowPerformanceProtection !== false,
    stateReactive: typeof source.stateReactive === "boolean" ? source.stateReactive : defaults.stateReactive !== false,
    miniModeEnabled: typeof source.miniModeEnabled === "boolean" ? source.miniModeEnabled : defaults.miniModeEnabled !== false,
    continueWhenHidden: typeof source.continueWhenHidden === "boolean"
      ? source.continueWhenHidden
      : defaults.continueWhenHidden !== false,
  };
}

function validateMusicAuraSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "error", message: "musicAura must be an object" };
  }
  const normalized = normalizeMusicAuraSettings(value);
  if (JSON.stringify(normalized) !== JSON.stringify(value)) {
    return { status: "error", message: "musicAura has invalid fields" };
  }
  return { status: "ok" };
}

module.exports = {
  DEFAULT_MUSIC_AURA_SETTINGS,
  MUSIC_AURA_VISUAL_STYLES,
  MUSIC_AURA_BACKGROUND_ADAPTATIONS,
  MUSIC_AURA_PARTICLE_PALETTES,
  MUSIC_AURA_AUTO_VIEW_MODES,
  MUSIC_AURA_INTENSITIES,
  MUSIC_AURA_PERFORMANCE_MODES,
  normalizeMusicAuraSettings,
  validateMusicAuraSettings,
};
