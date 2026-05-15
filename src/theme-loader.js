"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const createThemeContext = require("./theme-context");
const {
  resolveExternalAssetsDir: _resolveExternalAssetsDir,
  externalAssetsSourceDir: _externalAssetsSourceDir,
  isPathInsideDir: _isPathInsideDir,
} = require("./theme-assets-cache");
const {
  getThemeMetadata: _getThemeMetadata,
  listThemesWithMetadata: _listThemesWithMetadata,
} = require("./theme-metadata");
const {
  REQUIRED_STATES,
  FULL_SLEEP_REQUIRED_STATES,
  MINI_REQUIRED_STATES,
  VISUAL_FALLBACK_STATES,
  validateTheme,
  mergeDefaults,
  isPlainObject: _isPlainObject,
  hasNonEmptyArray: _hasNonEmptyArray,
  getStateBindingEntry: _getStateBindingEntry,
  getStateFiles: _getStateFiles,
  hasStateFiles: _hasStateFiles,
  hasStateBinding: _hasStateBinding,
  normalizeStateBindings: _normalizeStateBindings,
  hasReactionBindings: _hasReactionBindings,
  supportsIdleTracking: _supportsIdleTracking,
  deriveIdleMode: _deriveIdleMode,
  deriveSleepMode: _deriveSleepMode,
  buildCapabilities: _buildCapabilities,
  collectRequiredAssetFiles: _collectRequiredAssetFiles,
  basenameOnly: _basenameOnly,
} = require("./theme-schema");
const {
  resolveVariant: _resolveVariant,
  applyVariantPatch: _applyVariantPatch,
  buildBaseBindingMetadata: _buildBaseBindingMetadata,
  applyUserOverridesPatch: _applyUserOverridesPatch,
} = require("./theme-variants");

// ── State ──

let runtimeOwner = null;
let builtinThemesDir = null;   // set by init()
let assetsSvgDir = null;       // assets/svg/ for built-in theme
let assetsSoundsDir = null;    // assets/sounds/ for built-in theme
let userDataDir = null;        // app.getPath("userData") — set by init()
let userThemesDir = null;      // {userData}/themes/
let themeCacheDir = null;      // {userData}/theme-cache/
let soundOverridesRoot = null; // {userData}/sound-overrides/ — per-theme copied audio

// ── Public API ──

/**
 * Initialize the loader. Call once at startup from main.js.
 * @param {string} appDir - __dirname of the calling module (src/)
 * @param {string} userData - app.getPath("userData")
 */
function init(appDir, userData) {
  builtinThemesDir = path.join(appDir, "..", "themes");
  assetsSvgDir = path.join(appDir, "..", "assets", "svg");
  assetsSoundsDir = path.join(appDir, "..", "assets", "sounds");
  if (userData) {
    userDataDir = userData;
    userThemesDir = path.join(userData, "themes");
    themeCacheDir = path.join(userData, "theme-cache");
    soundOverridesRoot = path.join(userData, "sound-overrides");
  }
}

// Directory where sound-override files for `themeId` live. main.js creates /
// reads files here when the user picks a custom audio file. Returns null when
// userData hasn't been wired up yet (test harnesses that call init() without it).
function getSoundOverridesDir(themeId) {
  if (!soundOverridesRoot || typeof themeId !== "string" || !themeId) return null;
  return path.join(soundOverridesRoot, themeId);
}

function _createThemeContext(theme) {
  return createThemeContext(theme, {
    assetsSvgDir,
    assetsSoundsDir,
  });
}

function bindActiveThemeRuntime(owner) {
  runtimeOwner = owner || null;
}

function _getActiveThemeContext() {
  if (!runtimeOwner) return null;
  if (typeof runtimeOwner.getActiveThemeContext === "function") {
    return runtimeOwner.getActiveThemeContext();
  }
  throw new Error("theme-loader active facade requires runtimeOwner.getActiveThemeContext()");
}

/**
 * Discover all available themes.
 * Scans built-in themes dir + {userData}/themes/
 * @returns {{ id: string, name: string, path: string, builtin: boolean }[]}
 */
function discoverThemes() {
  const themes = [];
  const seen = new Set();

  // Built-in themes
  if (builtinThemesDir) {
    _scanThemesDir(builtinThemesDir, true, themes, seen);
  }

  // User-installed themes (same id as built-in is skipped — built-in takes priority)
  if (userThemesDir) {
    _scanThemesDir(userThemesDir, false, themes, seen);
  }

  return themes;
}

function _scanThemesDir(dir, builtin, themes, seen) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (seen.has(entry.name)) continue;
      const jsonPath = path.join(dir, entry.name, "theme.json");
      let cfg;
      try {
        cfg = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      } catch { continue; }
      if (builtin && cfg && cfg._scaffoldOnly === true) continue;
      themes.push({ id: entry.name, name: cfg.name || entry.name, path: jsonPath, builtin });
      seen.add(entry.name);
    }
  } catch { /* dir not found */ }
}

/**
 * Load a theme by ID without activating it.
 *
 * Strict mode throws on missing/invalid; lenient falls back to "clawd".
 * Callers detect fallback by comparing the requested id against
 * `returnedTheme._id` / `returnedTheme._variantId` — no synthetic flag needed.
 *
 * Unknown variant ids always fall back to "default" (even in strict mode) —
 * a missing variant is a UX concern, not a theme-breaking condition.
 *
 * @param {string} themeId
 * @param {{ strict?: boolean, variant?: string, overrides?: object|null }} [opts]
 * @returns {object} merged theme config
 */
function loadTheme(themeId, opts = {}) {
  const strict = !!opts.strict;
  const requestedVariant = typeof opts.variant === "string" && opts.variant ? opts.variant : "default";
  const userOverrides = _isPlainObject(opts.overrides) ? opts.overrides : null;
  const { raw, isBuiltin, themeDir } = _readThemeJson(themeId);

  if (!raw) {
    const msg = `Theme "${themeId}" not found`;
    if (strict) throw new Error(msg);
    console.error(`[theme-loader] ${msg}`);
    if (themeId !== "clawd") return loadTheme("clawd");
    throw new Error("Default theme 'clawd' not found");
  }

  const errors = validateTheme(raw);
  if (errors.length > 0) {
    const msg = `Theme "${themeId}" validation errors: ${errors.join("; ")}`;
    if (strict) throw new Error(msg);
    console.error(`[theme-loader] ${msg}`);
    if (themeId !== "clawd") return loadTheme("clawd");
  }

  // Resolve variant + apply patch BEFORE mergeDefaults so that geometry
  // derivation (imgWidthRatio/imgOffsetX/imgBottom), tier sorting, and
  // basename sanitization all run on the patched raw.
  const { resolvedId, spec: variantSpec } = _resolveVariant(raw, requestedVariant);
  const afterVariant = variantSpec ? _applyVariantPatch(raw, variantSpec, themeId, resolvedId) : raw;
  const patchedRaw = userOverrides ? _applyUserOverridesPatch(afterVariant, userOverrides) : afterVariant;

  // Merge defaults for optional fields
  const theme = mergeDefaults(patchedRaw, themeId, isBuiltin);
  theme._themeDir = themeDir;
  theme._variantId = resolvedId;
  theme._userOverrides = userOverrides;
  theme._bindingBase = _buildBaseBindingMetadata(afterVariant);
  theme._baseTransitions = {};
  if (afterVariant.transitions && typeof afterVariant.transitions === "object") {
    for (const [file, transition] of Object.entries(afterVariant.transitions)) {
      const name = _basenameOnly(file);
      if (!name || !transition || typeof transition !== "object") continue;
      const clean = {};
      if (Number.isFinite(transition.in)) clean.in = transition.in;
      if (Number.isFinite(transition.out)) clean.out = transition.out;
      if (Object.keys(clean).length > 0) theme._baseTransitions[name] = clean;
    }
  }
  theme._baseWideHitboxFiles = Array.isArray(afterVariant.wideHitboxFiles)
    ? [...new Set(afterVariant.wideHitboxFiles.map((file) => _basenameOnly(file)).filter(Boolean))]
    : [];
  theme._capabilities = _buildCapabilities(theme);

  // For external themes: sanitize SVGs + resolve asset paths
  if (!isBuiltin) {
    const assetsDir = _resolveExternalAssetsDir(themeId, themeDir, { strict, themeCacheDir });
    theme._assetsDir = assetsDir;
    theme._assetsFileUrl = pathToFileURL(assetsDir).href;
  } else {
    theme._assetsDir = assetsSvgDir;
    theme._assetsFileUrl = null; // built-in uses relative path
  }

  theme._soundOverrideFiles = _resolveSoundOverrideFiles(themeId, userOverrides);

  return theme;
}

// Turn prefs.themeOverrides[themeId].sounds into an absolute-path map. Missing
// files are dropped silently so playback falls back to the theme's default
// without spamming the console every time a user deletes an override file by
// hand. main.js is responsible for copying picked audio into this directory.
function _resolveSoundOverrideFiles(themeId, userOverrides) {
  if (!_isPlainObject(userOverrides)) return null;
  const soundMap = _isPlainObject(userOverrides.sounds) ? userOverrides.sounds : null;
  if (!soundMap) return null;
  const dir = getSoundOverridesDir(themeId);
  if (!dir) return null;
  const out = {};
  for (const [soundName, entry] of Object.entries(soundMap)) {
    if (!_isPlainObject(entry)) continue;
    const filename = typeof entry.file === "string" ? _basenameOnly(entry.file) : null;
    if (!filename) continue;
    const absPath = path.join(dir, filename);
    if (!fs.existsSync(absPath)) continue;
    out[soundName] = absPath;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Read theme.json from built-in or user themes directory.
 */
function _readThemeJson(themeId) {
  // Built-in first
  if (builtinThemesDir) {
    const builtinPath = path.resolve(builtinThemesDir, themeId, "theme.json");
    if (!_isPathInsideDir(builtinThemesDir, builtinPath)) {
      console.error(`[theme-loader] Path traversal detected for built-in theme "${themeId}"`);
      return { raw: null, isBuiltin: false, themeDir: null };
    }
    if (fs.existsSync(builtinPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(builtinPath, "utf8"));
        return { raw, isBuiltin: true, themeDir: path.dirname(builtinPath) };
      } catch (e) {
        console.error(`[theme-loader] Failed to parse built-in theme "${themeId}":`, e.message);
      }
    }
  }

  // User themes
  if (userThemesDir) {
    const userPath = path.resolve(userThemesDir, themeId, "theme.json");
    if (fs.existsSync(userPath)) {
      // Path traversal check: resolved path must be within userThemesDir
      if (!_isPathInsideDir(userThemesDir, userPath)) {
        console.error(`[theme-loader] Path traversal detected for theme "${themeId}"`);
        return { raw: null, isBuiltin: false, themeDir: null };
      }
      try {
        const raw = JSON.parse(fs.readFileSync(userPath, "utf8"));
        return { raw, isBuiltin: false, themeDir: path.dirname(userPath) };
      } catch (e) {
        console.error(`[theme-loader] Failed to parse user theme "${themeId}":`, e.message);
      }
    }
  }

  return { raw: null, isBuiltin: false, themeDir: null };
}

/**
 * Compatibility shim for legacy callers. Active theme ownership lives in
 * theme-runtime; this module only delegates when a runtime has been bound.
 * @returns {object|null} current active theme config
 */
function getActiveTheme() {
  return runtimeOwner && typeof runtimeOwner.getActiveTheme === "function"
    ? runtimeOwner.getActiveTheme()
    : null;
}

/**
 * Resolve a display hint filename to current theme's file.
 * @param {string} hookFilename - original filename from hook/server
 * @returns {string|null} theme-local filename, or null if not mapped
 */
function resolveHint(hookFilename) {
  const activeTheme = getActiveTheme();
  if (!activeTheme || !activeTheme.displayHintMap) return null;
  return activeTheme.displayHintMap[hookFilename] || null;
}

/**
 * Get the absolute directory path for assets of the active theme.
 * Built-in: assets/svg/. External: theme-cache for SVGs, theme dir for non-SVGs.
 * @returns {string} absolute directory path
 */
/**
 * Get asset path for a specific file.
 * For external themes: SVGs come from cache, non-SVGs from source theme dir.
 * @param {string} filename
 * @returns {string} absolute file path
 */
function getAssetPath(filename) {
  const context = _getActiveThemeContext();
  return context ? context.resolveAssetPath(filename) : null;
}

function _resolveAssetPath(theme, filename) {
  if (!theme) return null;
  return _createThemeContext(theme).resolveAssetPath(filename);
}

/**
 * Get asset path prefix for renderer (used in <object data="..."> and <img src="...">).
 * Built-in: relative path. External: file:// URL.
 * @returns {string} path prefix
 */
function getRendererAssetsPath() {
  const context = _getActiveThemeContext();
  return context ? context.getRendererAssetsPath() : "../assets/svg";
}

/**
 * Get the base file:// URL for non-SVG assets of external themes.
 * For <img> loading of GIF/APNG/WebP files that live in the source theme dir.
 * @returns {string|null} file:// URL or null for built-in
 */
function getRendererSourceAssetsPath() {
  const context = _getActiveThemeContext();
  return context ? context.getRendererSourceAssetsPath() : null;
}

/**
 * Build config object to inject into renderer process (via additionalArguments or IPC).
 * Contains only the subset renderer.js needs.
 */
function getRendererConfig() {
  const context = _getActiveThemeContext();
  return context ? context.getRendererConfig() : null;
}

/**
 * Build config object to inject into hit-renderer process.
 */
function getHitRendererConfig() {
  const context = _getActiveThemeContext();
  return context ? context.getHitRendererConfig() : null;
}

/**
 * Ensure the user themes directory exists.
 * @returns {string} absolute path to user themes dir
 */
function ensureUserThemesDir() {
  if (!userThemesDir) return null;
  try {
    fs.mkdirSync(userThemesDir, { recursive: true });
  } catch {}
  return userThemesDir;
}

// ── Validation ──

function validateThemeShape(themeId, opts = {}) {
  const variant = typeof opts.variant === "string" && opts.variant ? opts.variant : "default";
  const overrides = _isPlainObject(opts.overrides) ? opts.overrides : null;
  const { raw, isBuiltin, themeDir } = _readThemeJson(themeId);
  if (!raw) {
    return {
      ok: false,
      errors: [`Theme "${themeId}" not found`],
      themeId,
      variant,
      resolvedVariant: null,
    };
  }

  const rawErrors = validateTheme(raw);
  const { resolvedId, spec } = _resolveVariant(raw, variant);
  const afterVariant = spec ? _applyVariantPatch(raw, spec, themeId, resolvedId) : raw;
  const patched = overrides ? _applyUserOverridesPatch(afterVariant, overrides) : afterVariant;
  const effective = mergeDefaults(patched, themeId, isBuiltin);

  effective._builtin = isBuiltin;
  effective._themeDir = themeDir;
  effective._variantId = resolvedId;
  effective._assetsDir = isBuiltin ? assetsSvgDir : _externalAssetsSourceDir(themeDir);

  const effectiveErrors = validateTheme(patched);
  const resourceErrors = _validateRequiredAssets(effective);
  const errors = [...rawErrors, ...effectiveErrors, ...resourceErrors];

  return {
    ok: errors.length === 0,
    errors,
    themeId,
    variant,
    resolvedVariant: resolvedId,
  };
}

function _validateRequiredAssets(theme) {
  const errors = [];
  for (const filename of _collectRequiredAssetFiles(theme)) {
    const absPath = _resolveAssetPath(theme, filename);
    if (!fs.existsSync(absPath)) {
      errors.push(`missing asset: ${filename} (${absPath})`);
    }
  }
  return errors;
}

/**
 * Resolve a logical sound name to an absolute file:// URL.
 * Built-in themes: assets/sounds/. External themes: {themeDir}/sounds/.
 * @param {string} soundName - logical name (e.g. "complete")
 * @returns {string|null} file:// URL, or null if sound not defined
 */
function getSoundUrl(soundName) {
  const context = _getActiveThemeContext();
  return context ? context.getSoundUrl(soundName) : null;
}

function getPreviewSoundUrl() {
  return getSoundUrl("confirm") || getSoundUrl("complete") || null;
}

/**
 * Read metadata for a single theme WITHOUT activating it.
 * Returns null for missing/malformed themes.
 */
function getThemeMetadata(themeId) {
  return _getThemeMetadata(themeId, {
    readThemeJson: _readThemeJson,
    assetsSvgDir,
  });
}

/**
 * Single-pass scan + metadata build — used by the settings panel.
 * Avoids the O(2N) read that `discoverThemes() + getThemeMetadata() per id`
 * would incur since this path fires on every theme-tab open and on every
 * `theme` / `themeOverrides` broadcast.
 */
function listThemesWithMetadata() {
  return _listThemesWithMetadata({ builtinThemesDir, userThemesDir, assetsSvgDir });
}

module.exports = {
  init,
  bindActiveThemeRuntime,
  discoverThemes,
  loadTheme,
  validateThemeShape,
  getActiveTheme,
  getThemeMetadata,
  listThemesWithMetadata,
  resolveHint,
  getAssetPath,
  getRendererAssetsPath,
  getRendererSourceAssetsPath,
  getRendererConfig,
  getHitRendererConfig,
  ensureUserThemesDir,
  getSoundUrl,
  getPreviewSoundUrl,
  getSoundOverridesDir,
  createThemeContext: _createThemeContext,
  _resolveAssetPath,
  _externalAssetsSourceDir,
  _validateRequiredAssets,
  // Schema constants + helpers are re-exported for backward compatibility with
  // scripts/validate-theme.js and tests. New direct callers should require
  // "./theme-schema".
  REQUIRED_STATES,
  FULL_SLEEP_REQUIRED_STATES,
  MINI_REQUIRED_STATES,
  VISUAL_FALLBACK_STATES,
  isPlainObject: _isPlainObject,
  hasNonEmptyArray: _hasNonEmptyArray,
  getStateBindingEntry: _getStateBindingEntry,
  getStateFiles: _getStateFiles,
  hasStateFiles: _hasStateFiles,
  hasStateBinding: _hasStateBinding,
  normalizeStateBindings: _normalizeStateBindings,
  hasReactionBindings: _hasReactionBindings,
  supportsIdleTracking: _supportsIdleTracking,
  deriveIdleMode: _deriveIdleMode,
  deriveSleepMode: _deriveSleepMode,
};
