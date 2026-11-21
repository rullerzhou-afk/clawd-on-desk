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
const { inspectDarkAppearance: _inspectDarkAppearance } = require("./theme-appearance");
const {
  REQUIRED_STATES,
  FULL_SLEEP_REQUIRED_STATES,
  MINI_REQUIRED_STATES,
  MINI_OPTIONAL_PEEK_STATES,
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
  deriveAccessoryCapability: _deriveAccessoryCapability,
  deriveMouthAccessoryCapability: _deriveMouthAccessoryCapability,
  resolveEffectiveAccessoryAttachments: _resolveEffectiveAccessoryAttachments,
  resolveEffectiveMouthAccessoryAttachments: _resolveEffectiveMouthAccessoryAttachments,
  collectRequiredAssetFiles: _collectRequiredAssetFiles,
  filterIdleVisualOptionsByAsset: _filterIdleVisualOptionsByAsset,
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

// Any direct child whose name starts with "." is manager-owned scratch
// (staging, backups, lock files), never a real theme. Enforced symmetrically in
// _scanThemesDir, theme-metadata.scanMetadata and _readThemeJson so a dotted
// directory can be neither scanned, selected by id, nor read directly.
function isScannableThemeDirName(name) {
  return typeof name === "string" && name.length > 0 && !name.startsWith(".");
}

function _scanThemesDir(dir, builtin, themes, seen) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!isScannableThemeDirName(entry.name)) continue;
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
 * Reads once by default. The retry budget applies per theme read, so an
 * unreadable requested theme and fallback "clawd" can each use the budget.
 *
 * @param {string} themeId
 * @param {{ strict?: boolean, variant?: string, overrides?: object|null, readAttempts?: number, retryDelaysMs?: number[] }} [opts]
 * @returns {object} merged theme config
 */
function loadTheme(themeId, opts = {}) {
  // The retry budget carries over to either fallback read; variant/overrides
  // are keyed per theme and must not leak onto "clawd".
  const retryOpts = { readAttempts: opts.readAttempts, retryDelaysMs: opts.retryDelaysMs };
  const strict = !!opts.strict;
  const requestedVariant = typeof opts.variant === "string" && opts.variant ? opts.variant : "default";
  const userOverrides = _isPlainObject(opts.overrides) ? opts.overrides : null;
  const { raw, isBuiltin, themeDir, lastError } = _readThemeJson(themeId, retryOpts);

  if (!raw) {
    const diag = _formatReadDiagnostic(lastError);
    const msg = `Theme "${themeId}" not found${_isMissingFileError(lastError) ? "" : diag}`;
    if (strict) throw new Error(msg);
    console.error(`[theme-loader] ${msg}`);
    if (themeId !== "clawd") {
      return loadTheme("clawd", retryOpts);
    }
    // A missing default is fatal: retain diagnostics even for ENOENT/ENOTDIR.
    throw new Error(`Default theme 'clawd' not found${diag}`);
  }

  const errors = validateTheme(raw);
  if (errors.length > 0) {
    const msg = `Theme "${themeId}" validation errors: ${errors.join("; ")}`;
    if (strict) throw new Error(msg);
    console.error(`[theme-loader] ${msg}`);
    if (themeId !== "clawd") return loadTheme("clawd", retryOpts);
  }

  // Resolve variant + apply patch BEFORE mergeDefaults so that geometry
  // derivation (imgWidthRatio/imgOffsetX/imgBottom), tier sorting, and
  // basename sanitization all run on the patched raw.
  const { resolvedId, spec: variantSpec } = _resolveVariant(raw, requestedVariant);
  const afterVariant = variantSpec ? _applyVariantPatch(raw, variantSpec, themeId, resolvedId) : raw;
  // Wardrobe support belongs to the authored, selected variant. User animation
  // overrides may replace a described file, but must not disable the theme-wide
  // customization capability merely by making that authored descriptor stale
  // in the effective visual projection.
  const patchedRaw = userOverrides ? _applyUserOverridesPatch(afterVariant, userOverrides) : afterVariant;

  // Merge defaults for optional fields
  const theme = mergeDefaults(patchedRaw, themeId, isBuiltin);
  theme._themeDir = themeDir;
  // Appearance has to be resolved before idle-visual filtering: the filter
  // checks the same asset directory the renderer will later use. The cache
  // failure fallback re-enters this function with dark disabled, so no field
  // is patched after filtering.
  const darkAppearance = (isBuiltin || opts._darkAppearanceUnavailable === true)
    ? { ok: false, reason: null, dir: null }
    : _inspectDarkAppearance(themeDir, raw.appearance);
  theme._appearance = opts.appearance === "dark" && darkAppearance.ok ? "dark" : "light";
  theme._assetsSourceDir = isBuiltin
    ? null
    : (theme._appearance === "dark" ? darkAppearance.dir : _externalAssetsSourceDir(themeDir));
  _filterIdleVisualOptionsByAsset(theme, (file) => {
    try { return fs.statSync(_resolveAssetPath(theme, file)).isFile(); } catch { return false; }
  });
  const authoredVisuals = Object.prototype.hasOwnProperty.call(afterVariant, "idleVisualOptions")
    ? { ...afterVariant, idleVisualOptions: theme.idleVisualOptions }
    : afterVariant;
  const authoredAccessorySupported = _deriveAccessoryCapability(authoredVisuals);
  const authoredMouthAccessorySupported = _deriveMouthAccessoryCapability(authoredVisuals);
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
  theme._capabilities = _buildCapabilities(theme, { trustedRuntimeAllowed: !!theme._builtin });
  theme._capabilities.accessories = authoredAccessorySupported;
  theme._capabilities.mouthAccessories = authoredMouthAccessorySupported;
  theme._capabilities.darkAppearance = darkAppearance.ok;
  if (!isBuiltin && !darkAppearance.ok && darkAppearance.reason) {
    console.warn(
      `[theme-loader] Theme "${themeId}" dark appearance unavailable: ${darkAppearance.reason}`
    );
  }
  theme.customization.accessories = authoredAccessorySupported
    ? _resolveEffectiveAccessoryAttachments(authoredVisuals, theme)
    : null;
  theme.customization.mouthAccessories = authoredMouthAccessorySupported
    ? _resolveEffectiveMouthAccessoryAttachments(authoredVisuals, theme)
    : null;

  // For external themes: sanitize SVGs + resolve asset paths
  if (!isBuiltin) {
    let assetsDir;
    try {
      assetsDir = _resolveExternalAssetsDir(themeId, themeDir, {
        strict,
        themeCacheDir,
        sourceAssetsDir: theme._assetsSourceDir,
        cacheSubdir: theme._appearance === "dark" ? path.basename(theme._assetsSourceDir) : "assets",
        // The dark cache must expose missing rasters even when the caller is
        // lenient (startup), otherwise it would be used with broken images.
        requireRasterDependencies: theme._appearance === "dark",
      });
    } catch (err) {
      if (theme._appearance !== "dark" || err.code !== "MISSING_RASTER_DEPENDENCIES") throw err;
      console.warn(`[theme-loader] Theme "${themeId}" dark appearance unavailable: ${err.message}`);
      // Re-run the whole load against the light resources so idle-visual
      // filtering and every derived field match a normal light load.
      return loadTheme(themeId, {
        ...opts,
        appearance: "light",
        _darkAppearanceUnavailable: true,
      });
    }
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
 * Sync sleep that never throws. Atomics.wait parks the main thread without
 * spinning; the busy-wait fallback covers hosts without SharedArrayBuffer.
 * Only reached from the startup retry path (see _readThemeJson).
 */
function _sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy-wait */ }
  }
}

/**
 * Human-readable suffix for a "not found" error. Node fs error messages
 * already embed the failing path; parse errors get the path spelled out.
 */
function _formatReadDiagnostic(lastError) {
  if (!lastError) return "";
  if (lastError.stage === "parse") {
    return ` (last read error: theme.json failed to parse at ${lastError.path}: ${lastError.message})`;
  }
  return ` (last read error: ${lastError.message})`;
}

function _isMissingFileError(error) {
  return !!error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

// A real failure outranks "not in this root". Between equals the built-in
// probe ran first and stays, so a missing default theme names the built-in path.
function _preferReadError(current, next) {
  if (!current) return next;
  return _isMissingFileError(current) && !_isMissingFileError(next) ? next : current;
}

/**
 * Read theme.json from built-in or user themes directory.
 *
 * Pass `readAttempts` (>1) plus `retryDelaysMs` to re-probe when the read
 * comes back empty. Only the startup loader in main.js opts in: the theme
 * file can be briefly unreadable on the first launch after an update
 * (#1295, exact trigger unconfirmed). The most useful fs/parse error from
 * the last attempt is returned as `lastError` so the fatal "not found"
 * can carry a real OS diagnostic instead of a bare missing-file claim.
 */
function _readThemeJson(themeId, opts = {}) {
  // Manager-owned scratch directories (staging/backup) are dotted direct
  // children of the themes dir. They must never be readable as a theme by id,
  // even though they may contain a perfectly valid theme.json.
  if (!isScannableThemeDirName(themeId)) {
    return { raw: null, isBuiltin: false, themeDir: null, lastError: null };
  }
  const attempts = Number.isInteger(opts.readAttempts) && opts.readAttempts >= 1
    ? opts.readAttempts
    : 1;
  const delays = Array.isArray(opts.retryDelaysMs) ? opts.retryDelaysMs : [];
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = _readThemeJsonOnce(themeId);
    if (result.raw) return result;
    if (result.lastError) lastError = result.lastError;
    if (attempt < attempts) _sleepSync(delays[attempt - 1]);
  }
  return { raw: null, isBuiltin: false, themeDir: null, lastError };
}

/**
 * Single probe of built-in then user themes. Distinguishes a genuinely
 * absent theme.json (silent, same as the old existsSync probe) from real fs
 * errors (EBUSY/EPERM/... — logged) and parse failures — all surfaced via
 * `lastError` instead of collapsing into "not found".
 */
function _readThemeJsonOnce(themeId) {
  let lastError = null;
  // Built-in first
  if (builtinThemesDir) {
    const builtinPath = path.resolve(builtinThemesDir, themeId, "theme.json");
    if (!_isPathInsideDir(builtinThemesDir, builtinPath)) {
      console.error(`[theme-loader] Path traversal detected for built-in theme "${themeId}"`);
      return { raw: null, isBuiltin: false, themeDir: null, lastError: null };
    }
    let rawText;
    try {
      rawText = fs.readFileSync(builtinPath, "utf8");
    } catch (e) {
      if (!_isMissingFileError(e)) {
        console.error(`[theme-loader] Failed to read built-in theme "${themeId}":`, e.message);
      }
      lastError = { stage: "read", code: e.code || null, message: e.message, path: builtinPath };
    }
    if (rawText !== undefined) {
      try {
        const raw = JSON.parse(rawText);
        return { raw, isBuiltin: true, themeDir: path.dirname(builtinPath), lastError: null };
      } catch (e) {
        console.error(`[theme-loader] Failed to parse built-in theme "${themeId}":`, e.message);
        lastError = { stage: "parse", code: null, message: e.message, path: builtinPath };
      }
    }
  }

  // User themes
  if (userThemesDir) {
    const userPath = path.resolve(userThemesDir, themeId, "theme.json");
    // Path traversal check: resolved path must be within userThemesDir
    if (!_isPathInsideDir(userThemesDir, userPath)) {
      console.error(`[theme-loader] Path traversal detected for theme "${themeId}"`);
      return { raw: null, isBuiltin: false, themeDir: null, lastError: null };
    }
    let rawText;
    try {
      rawText = fs.readFileSync(userPath, "utf8");
    } catch (e) {
      if (!_isMissingFileError(e)) {
        console.error(`[theme-loader] Failed to read user theme "${themeId}":`, e.message);
      }
      lastError = _preferReadError(lastError, { stage: "read", code: e.code || null, message: e.message, path: userPath });
    }
    if (rawText !== undefined) {
      try {
        const raw = JSON.parse(rawText);
        return { raw, isBuiltin: false, themeDir: path.dirname(userPath), lastError: null };
      } catch (e) {
        console.error(`[theme-loader] Failed to parse user theme "${themeId}":`, e.message);
        lastError = _preferReadError(lastError, { stage: "parse", code: null, message: e.message, path: userPath });
      }
    }
  }

  return { raw: null, isBuiltin: false, themeDir: null, lastError };
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

// Delete the sanitized-asset caches (light and every dark directory) for a
// theme that is being removed. Without this the caches would outlive the
// theme and keep using disk space.
function removeThemeCacheDir(themeId) {
  if (!themeCacheDir || !isScannableThemeDirName(themeId)) return false;
  const cacheRoot = path.resolve(themeCacheDir);
  const target = path.resolve(themeCacheDir, themeId);
  // The id is used as a single directory name. Re-check the resolved shape so
  // an id such as "../x" or "a/b" can never address a cache outside the root.
  if (path.dirname(target) !== cacheRoot || path.basename(target) !== themeId) return false;
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ── Validation ──

/**
 * Read `theme.json` from an explicit external theme directory (used by the
 * official-theme installer to validate a staging directory that does not yet
 * live under `<userData>/themes/`).
 */
function _readThemeJsonFromDir(themeDir) {
  if (typeof themeDir !== "string" || !themeDir) return { raw: null, isBuiltin: false, themeDir: null };
  if (!isScannableThemeDirName(path.basename(themeDir))) {
    return { raw: null, isBuiltin: false, themeDir: null };
  }
  const jsonPath = path.join(themeDir, "theme.json");
  try {
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    return { raw, isBuiltin: false, themeDir };
  } catch (e) {
    return { raw: null, isBuiltin: false, themeDir: null };
  }
}

function validateThemeShape(themeId, opts = {}) {
  const variant = typeof opts.variant === "string" && opts.variant ? opts.variant : "default";
  const overrides = _isPlainObject(opts.overrides) ? opts.overrides : null;
  const explicitThemeDir = typeof opts.themeDir === "string" && opts.themeDir ? opts.themeDir : null;
  const { raw, isBuiltin, themeDir } = explicitThemeDir
    ? _readThemeJsonFromDir(explicitThemeDir)
    : _readThemeJson(themeId);
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
  _filterIdleVisualOptionsByAsset(effective, (file) => {
    try { return fs.statSync(_resolveAssetPath(effective, file)).isFile(); } catch { return false; }
  });

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
  removeThemeCacheDir,
  getSoundUrl,
  getPreviewSoundUrl,
  getSoundOverridesDir,
  createThemeContext: _createThemeContext,
  _resolveAssetPath,
  _externalAssetsSourceDir,
  _validateRequiredAssets,
  isScannableThemeDirName,
  // Schema constants + helpers are re-exported for backward compatibility with
  // scripts/validate-theme.js and tests. New direct callers should require
  // "./theme-schema".
  REQUIRED_STATES,
  FULL_SLEEP_REQUIRED_STATES,
  MINI_REQUIRED_STATES,
  MINI_OPTIONAL_PEEK_STATES,
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
