"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

// ── Defaults (used when theme.json omits optional fields) ──

const DEFAULT_SOUNDS = {
  complete: "complete.mp3",
  confirm:  "confirm.mp3",
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
  default:  { x: -1, y: 5, w: 17, h: 12 },
  sleeping: { x: -2, y: 9, w: 19, h: 7 },
  wide:     { x: -3, y: 3, w: 21, h: 14 },
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
]);

// ── Variant support (Phase 3b-swap) ──
// Allow-list of fields a variant may override. Anything else → ignored + warned
// (see docs/plans/plan-settings-panel-3b-swap.md §6.4 Validator Spec rule 1).
const VARIANT_ALLOWED_KEYS = new Set([
  // Metadata (not merged into runtime theme)
  "name", "description", "preview",
  // Runtime fields (see §6.1 allow-list table)
  "workingTiers", "jugglingTiers", "idleAnimations",
  "wideHitboxFiles", "sleepingHitboxFiles",
  "hitBoxes", "timings", "transitions",
  "objectScale", "displayHintMap",
]);
// Fields that replace wholesale instead of deep-merge.
// Arrays always replace; `displayHintMap` is explicitly replace per §6.1
// (deep-merge can't express "remove a hint").
const VARIANT_REPLACE_FIELDS = new Set([
  "workingTiers", "jugglingTiers", "idleAnimations",
  "wideHitboxFiles", "sleepingHitboxFiles",
  "displayHintMap",
]);

// ── SVG sanitization config ──
const DANGEROUS_TAGS = new Set([
  "script", "foreignobject", "iframe", "embed", "object", "applet",
  "meta", "link", "base", "form", "input", "textarea", "button",
]);
const DANGEROUS_ATTR_RE = /^on/i;
const DANGEROUS_HREF_RE = /^\s*javascript\s*:/i;
const EXTERNAL_RESOURCE_RE = /^\s*(?:\/\/|(https?|data|file|ftp)\s*:)/i;
const PATH_TRAVERSAL_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const HREF_ATTRS = new Set(["href", "xlink:href", "src", "action", "formaction"]);
const SVG_URL_ATTRS = new Set([
  "style",
  "fill",
  "stroke",
  "filter",
  "clip-path",
  "mask",
  "marker-start",
  "marker-mid",
  "marker-end",
  "cursor",
]);
const WINDOWS_ABSOLUTE_PATH_RE = /^[a-zA-Z]:[\\/]/;
const ROOT_ABSOLUTE_PATH_RE = /^[\\/](?![\\/])/;

// ── State ──

let activeTheme = null;
let builtinThemesDir = null;   // set by init()
let assetsSvgDir = null;       // assets/svg/ for built-in theme
let assetsSoundsDir = null;    // assets/sounds/ for built-in theme
let userDataDir = null;        // app.getPath("userData") — set by init()
let userThemesDir = null;      // {userData}/themes/
let themeCacheDir = null;      // {userData}/theme-cache/

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
  }
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
 * Load and activate a theme by ID.
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
  theme._capabilities = _buildCapabilities(theme);

  // For external themes: sanitize SVGs + resolve asset paths
  if (!isBuiltin) {
    const assetsDir = _resolveExternalAssetsDir(themeId, themeDir);
    theme._assetsDir = assetsDir;
    theme._assetsFileUrl = pathToFileURL(assetsDir).href;
  } else {
    theme._assetsDir = assetsSvgDir;
    theme._assetsFileUrl = null; // built-in uses relative path
  }

  activeTheme = theme;
  return theme;
}

/**
 * Read theme.json from built-in or user themes directory.
 */
function _readThemeJson(themeId) {
  // Built-in first
  const builtinPath = path.join(builtinThemesDir, themeId, "theme.json");
  if (fs.existsSync(builtinPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(builtinPath, "utf8"));
      return { raw, isBuiltin: true, themeDir: path.join(builtinThemesDir, themeId) };
    } catch (e) {
      console.error(`[theme-loader] Failed to parse built-in theme "${themeId}":`, e.message);
    }
  }

  // User themes
  if (userThemesDir) {
    const userPath = path.join(userThemesDir, themeId, "theme.json");
    if (fs.existsSync(userPath)) {
      // Path traversal check: resolved path must be within userThemesDir
      const resolved = path.resolve(userPath);
      if (!resolved.startsWith(path.resolve(userThemesDir) + path.sep)) {
        console.error(`[theme-loader] Path traversal detected for theme "${themeId}"`);
        return { raw: null, isBuiltin: false, themeDir: null };
      }
      try {
        const raw = JSON.parse(fs.readFileSync(userPath, "utf8"));
        return { raw, isBuiltin: false, themeDir: path.join(userThemesDir, themeId) };
      } catch (e) {
        console.error(`[theme-loader] Failed to parse user theme "${themeId}":`, e.message);
      }
    }
  }

  return { raw: null, isBuiltin: false, themeDir: null };
}

/**
 * Resolve external theme assets: sanitize SVGs → cache dir, return cache path.
 * Non-SVG files (GIF/APNG/WebP) are used directly from theme dir (no sanitization needed).
 */
function _resolveExternalAssetsDir(themeId, themeDir) {
  const sourceAssetsDir = path.join(themeDir, "assets");
  if (!themeCacheDir) return sourceAssetsDir;

  const cacheDir = path.join(themeCacheDir, themeId, "assets");
  const cacheMetaPath = path.join(themeCacheDir, themeId, ".cache-meta.json");

  // Load existing cache meta
  let cacheMeta = {};
  try {
    cacheMeta = JSON.parse(fs.readFileSync(cacheMetaPath, "utf8"));
  } catch { /* no cache yet */ }

  // Ensure cache directory exists
  fs.mkdirSync(cacheDir, { recursive: true });

  // Scan source assets and sanitize SVGs
  let metaChanged = false;
  try {
    const files = fs.readdirSync(sourceAssetsDir);
    for (const file of files) {
      const srcFile = path.join(sourceAssetsDir, file);

      // Path traversal check
      const resolvedSrc = path.resolve(srcFile);
      if (!resolvedSrc.startsWith(path.resolve(sourceAssetsDir) + path.sep) &&
          resolvedSrc !== path.resolve(sourceAssetsDir)) {
        console.warn(`[theme-loader] Skipping suspicious path: ${file}`);
        continue;
      }

      let stat;
      try { stat = fs.statSync(srcFile); } catch { continue; }
      if (!stat.isFile()) continue;

      if (file.endsWith(".svg")) {
        // Check cache freshness
        const cached = cacheMeta[file];
        if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
          // Cache is fresh
          continue;
        }

        // Sanitize and cache
        try {
          const svgContent = fs.readFileSync(srcFile, "utf8");
          const sanitized = sanitizeSvg(svgContent);
          fs.writeFileSync(path.join(cacheDir, file), sanitized, "utf8");
          cacheMeta[file] = { mtime: stat.mtimeMs, size: stat.size };
          metaChanged = true;
        } catch (e) {
          console.error(`[theme-loader] Failed to sanitize ${file}:`, e.message);
        }
      }
      // Non-SVG files are NOT copied — we serve them directly from source
    }
  } catch (e) {
    console.error(`[theme-loader] Failed to scan assets for theme "${themeId}":`, e.message);
  }

  if (metaChanged) {
    try {
      fs.writeFileSync(cacheMetaPath, JSON.stringify(cacheMeta, null, 2), "utf8");
    } catch {}
  }

  return cacheDir; // SVGs from cache, non-SVGs resolved at getAssetPath() time
}

// ── SVG Sanitization ──

/**
 * Sanitize SVG content by removing dangerous elements and attributes.
 * Uses htmlparser2 for robust parsing.
 * @param {string} svgContent - raw SVG string
 * @returns {string} sanitized SVG string
 */
function sanitizeSvg(svgContent) {
  const { parseDocument } = require("htmlparser2");
  const render = require("dom-serializer");

  const doc = parseDocument(svgContent, { xmlMode: true });
  _sanitizeNode(doc);
  return render.default(doc, { xmlMode: true });
}

function _unwrapCssUrlTarget(rawValue) {
  if (typeof rawValue !== "string") return "";
  const trimmed = rawValue.trim();
  const singleQuoted = trimmed.startsWith("'") && trimmed.endsWith("'");
  const doubleQuoted = trimmed.startsWith("\"") && trimmed.endsWith("\"");
  if ((singleQuoted || doubleQuoted) && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function _decodeResourceTarget(target) {
  if (typeof target !== "string" || !target) return target || "";
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function _hasUnsafeResourcePattern(target) {
  if (!target) return false;
  return DANGEROUS_HREF_RE.test(target)
    || EXTERNAL_RESOURCE_RE.test(target)
    || PATH_TRAVERSAL_RE.test(target)
    || WINDOWS_ABSOLUTE_PATH_RE.test(target)
    || ROOT_ABSOLUTE_PATH_RE.test(target);
}

function _isUnsafeHrefTarget(rawValue) {
  const target = _unwrapCssUrlTarget(rawValue);
  if (!target || target.startsWith("#")) return false;
  const decoded = _decodeResourceTarget(target);
  return _hasUnsafeResourcePattern(target) || _hasUnsafeResourcePattern(decoded);
}

function _isUnsafeCssUrlTarget(rawValue) {
  const target = _unwrapCssUrlTarget(rawValue);
  if (!target || target.startsWith("#")) return false;
  return _isUnsafeHrefTarget(target);
}

function _sanitizeCssUrls(cssText) {
  if (typeof cssText !== "string" || !cssText) return cssText;
  return cssText
    .replace(/@import\b[^;]*/gi, "/* sanitized */")
    .replace(/url\s*\(\s*([^)]*?)\s*\)/gi, (match, rawTarget) => (
      _isUnsafeCssUrlTarget(rawTarget) ? "url()" : match
    ));
}

function _containsUnsafeCssUrl(cssText) {
  if (typeof cssText !== "string" || !cssText) return false;
  const matches = cssText.matchAll(/url\s*\(\s*([^)]*?)\s*\)/gi);
  for (const match of matches) {
    if (_isUnsafeCssUrlTarget(match[1])) return true;
  }
  return false;
}

/**
 * Recursively walk DOM tree and remove dangerous nodes/attributes.
 */
function _sanitizeNode(node) {
  if (!node.children) return;

  // Walk backwards so removal doesn't skip siblings
  for (let i = node.children.length - 1; i >= 0; i--) {
    const child = node.children[i];

    // Remove dangerous elements entirely
    if (child.type === "tag" || child.type === "script" || child.type === "style") {
      const tagName = (child.name || "").toLowerCase();
      if (DANGEROUS_TAGS.has(tagName)) {
        node.children.splice(i, 1);
        continue;
      }
    }

    // Sanitize <style> CSS content: strip @import and url() to block external loads
    // while preserving @keyframes and other animation CSS that themes need
    if (child.type === "style" || (child.type === "tag" && (child.name || "").toLowerCase() === "style")) {
      if (child.children) {
        for (const textNode of child.children) {
          if (textNode.type === "text" && textNode.data) {
            textNode.data = _sanitizeCssUrls(textNode.data);
          }
        }
      }
    }

    // Clean attributes on element nodes
    if (child.attribs) {
      const keys = Object.keys(child.attribs);
      for (const key of keys) {
        // Remove on* event handlers
        if (DANGEROUS_ATTR_RE.test(key)) {
          delete child.attribs[key];
          continue;
        }
        // Remove javascript: URLs, external protocols, and path traversal
        if (HREF_ATTRS.has(key.toLowerCase())) {
          const val = child.attribs[key];
          if (_isUnsafeHrefTarget(val)) {
            delete child.attribs[key];
            continue;
          }
        }
        if (SVG_URL_ATTRS.has(key.toLowerCase())) {
          const val = child.attribs[key];
          if (key.toLowerCase() === "style") {
            const sanitized = _sanitizeCssUrls(val);
            if (!sanitized || !sanitized.trim()) delete child.attribs[key];
            else child.attribs[key] = sanitized;
          } else if (_containsUnsafeCssUrl(val)) {
            delete child.attribs[key];
          }
        }
      }
    }

    // Recurse into children
    _sanitizeNode(child);
  }
}

/**
 * @returns {object|null} current active theme config
 */
function getActiveTheme() {
  return activeTheme;
}

/**
 * Resolve a display hint filename to current theme's file.
 * @param {string} hookFilename - original filename from hook/server
 * @returns {string|null} theme-local filename, or null if not mapped
 */
function resolveHint(hookFilename) {
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
  filename = path.basename(filename);
  if (!activeTheme) return path.join(assetsSvgDir, filename);

  if (activeTheme._builtin) {
    // Built-in theme with own assets dir (e.g., calico with APNGs + SVGs)
    const themeAsset = path.join(activeTheme._themeDir, "assets", filename);
    if (fs.existsSync(themeAsset)) return themeAsset;
    return path.join(assetsSvgDir, filename);
  }

  // External theme: SVGs from cache, everything else from source
  if (filename.endsWith(".svg")) {
    return path.join(activeTheme._assetsDir, filename);
  }
  // Non-SVG: direct from theme's assets dir (no sanitization needed)
  return path.join(activeTheme._themeDir, "assets", filename);
}

/**
 * Get asset path prefix for renderer (used in <object data="..."> and <img src="...">).
 * Built-in: relative path. External: file:// URL.
 * @returns {string} path prefix
 */
function getRendererAssetsPath() {
  if (!activeTheme) return "../assets/svg";
  if (activeTheme._builtin) {
    // Built-in theme with own assets dir (e.g., calico with SVG + APNGs)
    const themeAssetsDir = path.join(activeTheme._themeDir, "assets");
    if (fs.existsSync(themeAssetsDir)) {
      // Use relative path (not file:// URL) so SVG internal <style> works
      // file:// absolute URLs may cause browser to restrict inline CSS in SVG
      return "../themes/" + activeTheme._id + "/assets";
    }
    return "../assets/svg";
  }
  // External theme: return file:// URL to the cache dir for SVGs
  return activeTheme._assetsFileUrl || "../assets/svg";
}

/**
 * Get the base file:// URL for non-SVG assets of external themes.
 * For <img> loading of GIF/APNG/WebP files that live in the source theme dir.
 * @returns {string|null} file:// URL or null for built-in
 */
function getRendererSourceAssetsPath() {
  if (!activeTheme) return null;
  if (activeTheme._builtin) {
    // Built-in theme with own assets dir (e.g., calico with APNGs)
    const themeAssetsDir = path.join(activeTheme._themeDir, "assets");
    if (fs.existsSync(themeAssetsDir)) {
      return "../themes/" + activeTheme._id + "/assets";
    }
    return null;
  }
  return pathToFileURL(path.join(activeTheme._themeDir, "assets")).href;
}

/**
 * Build config object to inject into renderer process (via additionalArguments or IPC).
 * Contains only the subset renderer.js needs.
 */
function getRendererConfig() {
  if (!activeTheme) return null;
  const t = activeTheme;
  return {
    viewBox: t.viewBox,
    layout: t.layout,
    assetsPath: getRendererAssetsPath(),
    // For external themes: non-SVG assets served from source dir (not cache)
    sourceAssetsPath: getRendererSourceAssetsPath(),
    eyeTracking: t.eyeTracking,
    glyphFlips: t.miniMode ? t.miniMode.glyphFlips : {},
    miniFlipAssets: t.miniMode ? !!t.miniMode.flipAssets : false,
    dragSvg: t.reactions && t.reactions.drag ? t.reactions.drag.file : null,
    idleFollowSvg: t.states.idle[0],
    // renderer needs to know which states need eye tracking (for <object> vs <img> decision)
    eyeTrackingStates: t.eyeTracking.enabled ? t.eyeTracking.states : [],
    objectScale: t.objectScale,
    transitions: t.transitions || {},
  };
}

/**
 * Build config object to inject into hit-renderer process.
 */
function getHitRendererConfig() {
  if (!activeTheme) return null;
  const t = activeTheme;
  return {
    reactions: t.reactions || {},
    idleFollowSvg: t.states.idle[0],
  };
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

function validateTheme(cfg) {
  const errors = [];
  const sleepMode = _deriveSleepMode(cfg);
  const normalizedStates = _normalizeStateBindings(cfg && cfg.states);

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
      if (!_hasStateFiles(cfg.states[s])) {
        errors.push(`states.${s} must be a non-empty array`);
      }
    }
    if (!_hasStateBinding(cfg.states.sleeping)) {
      errors.push("states.sleeping must define files or fallbackTo");
    }
    if (sleepMode === "full") {
      for (const s of FULL_SLEEP_REQUIRED_STATES) {
        if (!_hasStateFiles(cfg.states[s])) {
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
      const files = _getStateFiles(cfg.states[stateName]).length > 0
        ? _getStateFiles(cfg.states[stateName])
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

  const fallbackStateKeys = Object.keys(normalizedStates);
  for (const stateKey of fallbackStateKeys) {
    const entry = normalizedStates[stateKey];
    if (!entry.fallbackTo) continue;
    if (!VISUAL_FALLBACK_STATES.has(stateKey)) {
      errors.push(`states.${stateKey}.fallbackTo is only allowed on error/attention/notification/sweeping/carrying/sleeping`);
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
    if (!terminal || !_hasStateFiles(terminal)) {
      errors.push(`states.${stateKey}.fallbackTo chain does not terminate in real files`);
    }
  }

  if (fallbackStateKeys.length > 0 && !fallbackStateKeys.some((stateKey) => _hasStateFiles(normalizedStates[stateKey]))) {
    errors.push("theme must declare at least one state with real files");
  }

  if (_isMiniSupported(cfg)) {
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

// ── Internal helpers ──

function _isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function _hasNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function _getStateBindingEntry(entry) {
  if (Array.isArray(entry)) {
    return { files: [...entry], fallbackTo: null };
  }
  if (_isPlainObject(entry)) {
    return {
      files: Array.isArray(entry.files) ? [...entry.files] : [],
      fallbackTo: (typeof entry.fallbackTo === "string" && entry.fallbackTo) ? entry.fallbackTo : null,
    };
  }
  return { files: [], fallbackTo: null };
}

function _getStateFiles(entry) {
  return _getStateBindingEntry(entry).files;
}

function _hasStateFiles(entry) {
  return _getStateFiles(entry).length > 0;
}

function _hasStateBinding(entry) {
  const normalized = _getStateBindingEntry(entry);
  return normalized.files.length > 0 || !!normalized.fallbackTo;
}

function _normalizeStateBindings(states) {
  const normalized = {};
  if (!_isPlainObject(states)) return normalized;
  for (const [stateKey, entry] of Object.entries(states)) {
    if (stateKey.startsWith("_")) continue;
    normalized[stateKey] = _getStateBindingEntry(entry);
  }
  return normalized;
}

function _hasReactionBindings(reactions) {
  if (!_isPlainObject(reactions)) return false;
  return Object.values(reactions).some((entry) =>
    _isPlainObject(entry)
    && (
      (typeof entry.file === "string" && entry.file.length > 0)
      || (Array.isArray(entry.files) && entry.files.some((file) => typeof file === "string" && file.length > 0))
    )
  );
}

function _isMiniSupported(cfg) {
  return !!(_isPlainObject(cfg && cfg.miniMode) && cfg.miniMode.supported !== false);
}

function _supportsIdleTracking(cfg) {
  return !!(
    _isPlainObject(cfg && cfg.eyeTracking)
    && cfg.eyeTracking.enabled
    && Array.isArray(cfg.eyeTracking.states)
    && cfg.eyeTracking.states.includes("idle")
  );
}

function _deriveIdleMode(cfg) {
  if (_supportsIdleTracking(cfg)) return "tracked";
  if (_hasNonEmptyArray(cfg && cfg.idleAnimations)) return "animated";
  return "static";
}

function _deriveSleepMode(cfg) {
  return (cfg && cfg.sleepSequence && cfg.sleepSequence.mode === "direct") ? "direct" : "full";
}

function _buildCapabilities(cfg) {
  return {
    eyeTracking: !!(
      _isPlainObject(cfg && cfg.eyeTracking)
      && cfg.eyeTracking.enabled
      && _hasNonEmptyArray(cfg.eyeTracking.states)
    ),
    miniMode: _isMiniSupported(cfg),
    idleAnimations: _hasNonEmptyArray(cfg && cfg.idleAnimations),
    reactions: _hasReactionBindings(cfg && cfg.reactions),
    workingTiers: _hasNonEmptyArray(cfg && cfg.workingTiers),
    jugglingTiers: _hasNonEmptyArray(cfg && cfg.jugglingTiers),
    idleMode: _deriveIdleMode(cfg),
    sleepMode: _deriveSleepMode(cfg),
  };
}

/**
 * Deep-merge two plain objects. Arrays on the patch side replace wholesale
 * (Clawd's array fields have positional semantics — tier order, random pool —
 * where deep-merge would be ill-defined). Scalars on the patch side win.
 */
function _deepMergeObject(base, patch) {
  if (!_isPlainObject(base)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (_isPlainObject(v) && _isPlainObject(out[k])) {
      out[k] = _deepMergeObject(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function _basenameOnly(value) {
  return typeof value === "string" ? value.replace(/^.*[\/\\]/, "") : value;
}

/**
 * Resolve a requested variant id against the theme's declared variants.
 * Synthesises a `default` variant when the author didn't declare one so the
 * UI can always show at least one option.
 * Unknown variant ids lenient-fallback to `default`.
 *
 * @returns {{ resolvedId: string, spec: object|null }}
 *   `spec` is null when the resolved variant is a synthetic default (no patch needed).
 */
function _resolveVariant(raw, requestedVariant) {
  const rawVariants = _isPlainObject(raw.variants) ? raw.variants : {};
  const hasExplicitDefault = _isPlainObject(rawVariants.default);
  const targetId = requestedVariant || "default";

  if (rawVariants[targetId] && _isPlainObject(rawVariants[targetId])) {
    return { resolvedId: targetId, spec: rawVariants[targetId] };
  }
  // Unknown variant → lenient fallback to default (synthetic or explicit)
  if (hasExplicitDefault) {
    return { resolvedId: "default", spec: rawVariants.default };
  }
  return { resolvedId: "default", spec: null };
}

/**
 * Apply a variant spec on top of raw theme config.
 * - allow-list fields are patched per `VARIANT_REPLACE_FIELDS` (replace vs deep-merge)
 * - out-of-list fields are ignored with a warning (author typos surface clearly)
 * - metadata fields (name/description/preview) are stripped — they belong to the
 *   variant metadata layer, not runtime theme config
 *
 * Runs on raw before mergeDefaults so downstream geometry derivation sees
 * the patched values (see §6.1 rationale in plan-settings-panel-3b-swap.md).
 */
function _applyVariantPatch(raw, variantSpec, themeId, variantId) {
  const patched = { ...raw };
  for (const [key, value] of Object.entries(variantSpec)) {
    // Metadata-only fields — don't copy into runtime config
    if (key === "name" || key === "description" || key === "preview") continue;
    if (!VARIANT_ALLOWED_KEYS.has(key)) {
      console.warn(`[theme-loader] variant "${themeId}:${variantId}" declares ignored field "${key}" (not in allow-list)`);
      continue;
    }
    if (VARIANT_REPLACE_FIELDS.has(key) || Array.isArray(value)) {
      patched[key] = value;
    } else if (_isPlainObject(value)) {
      patched[key] = _isPlainObject(patched[key]) ? _deepMergeObject(patched[key], value) : value;
    } else {
      patched[key] = value;
    }
  }
  return patched;
}

function _normalizeTransitionOverride(transition) {
  if (!_isPlainObject(transition)) return null;
  const out = {};
  if (Number.isFinite(transition.in)) out.in = transition.in;
  if (Number.isFinite(transition.out)) out.out = transition.out;
  return Object.keys(out).length > 0 ? out : null;
}

function _buildBaseBindingMetadata(raw) {
  const states = {};
  if (_isPlainObject(raw.states)) {
    for (const [stateKey, entry] of Object.entries(raw.states)) {
      if (stateKey.startsWith("_")) continue;
      const files = _getStateFiles(entry);
      if (files[0]) states[stateKey] = _basenameOnly(files[0]);
    }
  }
  const miniStates = {};
  if (_isPlainObject(raw.miniMode) && _isPlainObject(raw.miniMode.states)) {
    for (const [stateKey, entry] of Object.entries(raw.miniMode.states)) {
      if (stateKey.startsWith("_")) continue;
      if (Array.isArray(entry) && entry[0]) miniStates[stateKey] = _basenameOnly(entry[0]);
    }
  }
  const mapTierGroup = (tiers) =>
    Array.isArray(tiers)
      ? tiers
        .filter((tier) => _isPlainObject(tier))
        .map((tier) => ({
          minSessions: Number.isFinite(tier.minSessions) ? tier.minSessions : 0,
          originalFile: _basenameOnly(tier.file),
        }))
        .sort((a, b) => b.minSessions - a.minSessions)
      : [];
  const idleAnimations = Array.isArray(raw.idleAnimations)
    ? raw.idleAnimations
      .filter((entry) => _isPlainObject(entry) && typeof entry.file === "string" && entry.file)
      .map((entry, index) => ({
        index,
        originalFile: _basenameOnly(entry.file),
        duration: Number.isFinite(entry.duration) ? entry.duration : null,
      }))
    : [];
  const displayHintMap = {};
  if (_isPlainObject(raw.displayHintMap)) {
    for (const [key, value] of Object.entries(raw.displayHintMap)) {
      displayHintMap[_basenameOnly(key)] = _basenameOnly(value);
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

function _ensureTransitionsPatch(patched) {
  if (!_isPlainObject(patched.transitions)) patched.transitions = {};
  return patched.transitions;
}

function _applyTransitionOverride(patched, targetFile, transition) {
  const cleanTarget = _basenameOnly(targetFile);
  const cleanTransition = _normalizeTransitionOverride(transition);
  if (!cleanTarget || !cleanTransition) return;
  const nextTransitions = _ensureTransitionsPatch(patched);
  const prev = _isPlainObject(nextTransitions[cleanTarget]) ? nextTransitions[cleanTarget] : {};
  nextTransitions[cleanTarget] = { ...prev, ...cleanTransition };
}

function _applyUserOverridesPatch(raw, overrides) {
  if (!_isPlainObject(overrides)) return raw;
  const patched = { ...raw };

  const stateOverrides = _isPlainObject(overrides.states) ? overrides.states : {};
  if (Object.keys(stateOverrides).length > 0) {
    const nextStates = { ...raw.states };
    const nextMiniMode = _isPlainObject(raw.miniMode) ? { ...raw.miniMode } : null;
    const nextMiniStates = nextMiniMode && _isPlainObject(raw.miniMode.states)
      ? { ...raw.miniMode.states }
      : null;
    for (const [stateKey, entry] of Object.entries(stateOverrides)) {
      if (!_isPlainObject(entry)) continue;
      const rawStateEntry = nextStates[stateKey];
      const rawMiniEntry = nextMiniStates ? nextMiniStates[stateKey] : undefined;
      const targetCollection = rawStateEntry !== undefined
        ? nextStates
        : (rawMiniEntry !== undefined ? nextMiniStates : null);
      if (!targetCollection) continue;
      const currentState = _getStateBindingEntry(targetCollection[stateKey]);
      const currentFiles = currentState.files;
      if (currentFiles.length === 0 && !(typeof entry.file === "string" && entry.file)) continue;
      const nextFiles = [...currentFiles];
      if (typeof entry.file === "string" && entry.file) {
        if (nextFiles.length > 0) nextFiles[0] = entry.file;
        else nextFiles.push(entry.file);
      }
      if (Array.isArray(targetCollection[stateKey])) {
        targetCollection[stateKey] = nextFiles;
      } else if (_isPlainObject(targetCollection[stateKey])) {
        targetCollection[stateKey] = { ...targetCollection[stateKey], files: nextFiles };
      } else {
        targetCollection[stateKey] = nextFiles;
      }
      const transitionTarget = (typeof entry.file === "string" && entry.file) ? entry.file : nextFiles[0];
      _applyTransitionOverride(patched, transitionTarget, entry.transition);
    }
    patched.states = nextStates;
    if (nextMiniMode && nextMiniStates) {
      nextMiniMode.states = nextMiniStates;
      patched.miniMode = nextMiniMode;
    }
  }

  const tierGroups = _isPlainObject(overrides.tiers) ? overrides.tiers : {};
  for (const tierGroup of ["workingTiers", "jugglingTiers"]) {
    const tierOverrides = _isPlainObject(tierGroups[tierGroup]) ? tierGroups[tierGroup] : null;
    const rawTiers = Array.isArray(raw[tierGroup]) ? raw[tierGroup] : null;
    if (!tierOverrides || !rawTiers) continue;
    const nextTiers = rawTiers.map((tier) => (_isPlainObject(tier) ? { ...tier } : tier));
    for (const [originalFile, entry] of Object.entries(tierOverrides)) {
      if (!_isPlainObject(entry)) continue;
      const cleanOriginal = _basenameOnly(originalFile);
      const tier = nextTiers.find((candidate) =>
        _isPlainObject(candidate) && _basenameOnly(candidate.file) === cleanOriginal
      );
      if (!tier) continue;
      if (typeof entry.file === "string" && entry.file) {
        tier.file = entry.file;
      }
      const transitionTarget = (typeof entry.file === "string" && entry.file) ? entry.file : tier.file;
      _applyTransitionOverride(patched, transitionTarget, entry.transition);
    }
    patched[tierGroup] = nextTiers;
  }

  const timings = _isPlainObject(overrides.timings) ? overrides.timings : null;
  const autoReturn = timings && _isPlainObject(timings.autoReturn) ? timings.autoReturn : null;
  if (autoReturn) {
    const nextTimings = _isPlainObject(raw.timings) ? _deepMergeObject(raw.timings, {}) : {};
    nextTimings.autoReturn = _isPlainObject(nextTimings.autoReturn) ? { ...nextTimings.autoReturn } : {};
    for (const [stateKey, value] of Object.entries(autoReturn)) {
      if (!Number.isFinite(value)) continue;
      nextTimings.autoReturn[stateKey] = value;
    }
    patched.timings = nextTimings;
  }

  // Per-file wide-hitbox opt-in/opt-out. Only touches the file list the theme
  // publishes — doesn't regenerate HIT_BOXES. state.js rebuilds WIDE_SVGS from
  // theme.wideHitboxFiles on refreshTheme, so the merged list flows through.
  const hitboxOverrides = _isPlainObject(overrides.hitbox) ? overrides.hitbox : null;
  const wideOverrides = hitboxOverrides && _isPlainObject(hitboxOverrides.wide) ? hitboxOverrides.wide : null;
  if (wideOverrides && Object.keys(wideOverrides).length > 0) {
    const currentSet = new Set(
      (Array.isArray(patched.wideHitboxFiles) ? patched.wideHitboxFiles : []).map(_basenameOnly)
    );
    for (const [file, enabled] of Object.entries(wideOverrides)) {
      const bn = _basenameOnly(file);
      if (!bn) continue;
      if (enabled) currentSet.add(bn);
      else currentSet.delete(bn);
    }
    patched.wideHitboxFiles = [...currentSet];
  }

  const reactionOverrides = _isPlainObject(overrides.reactions) ? overrides.reactions : null;
  if (reactionOverrides && _isPlainObject(raw.reactions)) {
    const nextReactions = { ...raw.reactions };
    for (const [reactionKey, entry] of Object.entries(reactionOverrides)) {
      if (!_isPlainObject(entry)) continue;
      const rawReaction = nextReactions[reactionKey];
      if (!_isPlainObject(rawReaction)) continue;
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
      if (transitionTarget) _applyTransitionOverride(patched, transitionTarget, entry.transition);
    }
    patched.reactions = nextReactions;
  }

  const idleAnimationOverrides = _isPlainObject(overrides.idleAnimations) ? overrides.idleAnimations : null;
  if (idleAnimationOverrides && Array.isArray(raw.idleAnimations)) {
    const nextIdleAnimations = raw.idleAnimations.map((entry) => (_isPlainObject(entry) ? { ...entry } : entry));
    for (const [originalFile, entry] of Object.entries(idleAnimationOverrides)) {
      if (!_isPlainObject(entry)) continue;
      const cleanOriginal = _basenameOnly(originalFile);
      const idleAnimation = nextIdleAnimations.find((candidate) =>
        _isPlainObject(candidate) && _basenameOnly(candidate.file) === cleanOriginal
      );
      if (!idleAnimation) continue;
      if (typeof entry.file === "string" && entry.file) {
        idleAnimation.file = entry.file;
      }
      if (Number.isFinite(entry.durationMs)) {
        idleAnimation.duration = entry.durationMs;
      }
      const transitionTarget = (typeof entry.file === "string" && entry.file) ? entry.file : idleAnimation.file;
      _applyTransitionOverride(patched, transitionTarget, entry.transition);
    }
    patched.idleAnimations = nextIdleAnimations;
  }

  return patched;
}

/**
 * Build preview URL for a single variant. Fallback chain:
 *   variant.preview → variant.idleAnimations[0].file → root theme preview
 *
 * Avoids "all variant cards show the same preview" when variants only differ
 * in tiers/timings but not in any visible asset.
 */
function _buildVariantPreviewUrl(raw, variantSpec, themeDir, isBuiltin) {
  let previewFile = null;
  if (variantSpec) {
    if (typeof variantSpec.preview === "string" && variantSpec.preview) {
      previewFile = variantSpec.preview;
    } else if (Array.isArray(variantSpec.idleAnimations)
               && variantSpec.idleAnimations[0]
               && typeof variantSpec.idleAnimations[0].file === "string") {
      previewFile = variantSpec.idleAnimations[0].file;
    }
  }
  if (previewFile) {
    const filename = path.basename(previewFile);
    const themeLocal = path.join(themeDir, "assets", filename);
    if (fs.existsSync(themeLocal)) {
      try { return pathToFileURL(themeLocal).href; } catch {}
    }
    if (isBuiltin && assetsSvgDir) {
      const central = path.join(assetsSvgDir, filename);
      if (fs.existsSync(central)) {
        try { return pathToFileURL(central).href; } catch {}
      }
    }
  }
  return _buildPreviewUrl(raw, themeDir, isBuiltin);
}

/**
 * Normalize a theme's variants for metadata consumers (settings panel).
 * - Always includes a `default` entry (synthetic if author didn't declare one)
 * - Each entry: { id, name, description, previewFileUrl }
 * - `name` / `description` preserved as-is (string or {en,zh} — UI handles i18n)
 */
function _buildVariantMetadata(raw, themeDir, isBuiltin) {
  const rawVariants = _isPlainObject(raw.variants) ? raw.variants : {};
  const hasExplicitDefault = _isPlainObject(rawVariants.default);
  const out = [];

  if (!hasExplicitDefault) {
    // i18n object — settings-renderer's localizeField() picks the right key.
    // Don't reuse raw.name here: that would label the synthetic default with
    // the theme's own name (e.g. "Clawd"), creating a confusing duplicate of
    // the theme card's title inside its own variant strip.
    out.push({
      id: "default",
      name: { en: "Standard", zh: "标准" },
      description: null,
      previewFileUrl: _buildPreviewUrl(raw, themeDir, isBuiltin),
    });
  }
  for (const [id, spec] of Object.entries(rawVariants)) {
    if (!_isPlainObject(spec)) continue;
    out.push({
      id,
      name: (spec.name != null) ? spec.name : id,
      description: (spec.description != null) ? spec.description : null,
      previewFileUrl: _buildVariantPreviewUrl(raw, spec, themeDir, isBuiltin),
    });
  }
  return out;
}

function mergeDefaults(raw, themeId, isBuiltin) {
  const theme = { ...raw, _id: themeId, _builtin: !!isBuiltin };

  // timings
  theme.timings = {
    ...DEFAULT_TIMINGS,
    ...(raw.timings || {}),
    minDisplay: { ...DEFAULT_TIMINGS.minDisplay, ...(raw.timings && raw.timings.minDisplay) },
    autoReturn: { ...DEFAULT_TIMINGS.autoReturn, ...(raw.timings && raw.timings.autoReturn) },
  };

  // hitBoxes
  theme.hitBoxes = { ...DEFAULT_HITBOXES, ...(raw.hitBoxes || {}) };
  theme.wideHitboxFiles = raw.wideHitboxFiles || [];
  theme.sleepingHitboxFiles = raw.sleepingHitboxFiles || [];

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

  theme.sleepSequence = { mode: _deriveSleepMode(raw) };

  // miniMode
  if (raw.miniMode) {
    theme.miniMode = {
      supported: true,
      offsetRatio: 0.486,
      ...raw.miniMode,
      timings: {
        minDisplay: {},
        autoReturn: {},
        ...(raw.miniMode.timings || {}),
      },
      glyphFlips: raw.miniMode.glyphFlips || {},
    };
  } else {
    theme.miniMode = { supported: false, states: {}, timings: { minDisplay: {}, autoReturn: {} }, glyphFlips: {} };
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

  // ── Filename sanitization: basename all file references to prevent path traversal ──
  const bn = _basenameOnly;
  const normalizedStates = _normalizeStateBindings(raw.states);
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
  if (Array.isArray(theme.wideHitboxFiles)) theme.wideHitboxFiles = theme.wideHitboxFiles.map(bn);
  if (Array.isArray(theme.sleepingHitboxFiles)) theme.sleepingHitboxFiles = theme.sleepingHitboxFiles.map(bn);

  return theme;
}

/**
 * Resolve a logical sound name to an absolute file:// URL.
 * Built-in themes: assets/sounds/. External themes: {themeDir}/sounds/.
 * @param {string} soundName - logical name (e.g. "complete")
 * @returns {string|null} file:// URL, or null if sound not defined
 */
function getSoundUrl(soundName) {
  if (!activeTheme || !activeTheme.sounds) return null;
  const filename = activeTheme.sounds[soundName];
  if (!filename) return null;

  const absPath = activeTheme._builtin
    ? path.join(assetsSoundsDir, filename)
    : path.join(activeTheme._themeDir, "sounds", filename);

  if (fs.existsSync(absPath)) return pathToFileURL(absPath).href;

  // Fallback to built-in sounds for external themes that inherit defaults
  if (!activeTheme._builtin) {
    const fallback = path.join(assetsSoundsDir, filename);
    if (fs.existsSync(fallback)) return pathToFileURL(fallback).href;
  }

  return null;
}

function getPreviewSoundUrl() {
  return getSoundUrl("confirm") || getSoundUrl("complete") || null;
}

// basename() strips any path segments in theme.json so a malicious
// `preview: "../../foo"` can't escape the theme dir.
function _buildPreviewUrl(raw, themeDir, isBuiltin) {
  const previewFile = (typeof raw.preview === "string" && raw.preview)
    || _getStateFiles(raw.states && raw.states.idle)[0]
    || null;
  if (!previewFile) return null;
  const filename = path.basename(previewFile);
  // clawd reuses assets/svg/ at repo root; calico + user themes have their own.
  let absPath = null;
  const themeLocal = path.join(themeDir, "assets", filename);
  if (fs.existsSync(themeLocal)) {
    absPath = themeLocal;
  } else if (isBuiltin && assetsSvgDir) {
    const central = path.join(assetsSvgDir, filename);
    if (fs.existsSync(central)) absPath = central;
  }
  if (!absPath) return null;
  try { return pathToFileURL(absPath).href; } catch { return null; }
}

/**
 * Read metadata for a single theme WITHOUT activating it.
 * Returns null for missing/malformed themes.
 */
function getThemeMetadata(themeId) {
  const { raw, isBuiltin, themeDir } = _readThemeJson(themeId);
  if (!raw) return null;
  return {
    id: themeId,
    name: raw.name || themeId,
    builtin: !!isBuiltin,
    previewFileUrl: _buildPreviewUrl(raw, themeDir, isBuiltin),
    previewContentRatio: _computePreviewContentRatio(raw),
    previewContentOffsetPct: _computePreviewContentOffsetPct(raw),
    variants: _buildVariantMetadata(raw, themeDir, isBuiltin),
    capabilities: _buildCapabilities(raw),
  };
}

// Ratio of the theme's actual pet content vs the full viewBox. Lets the
// settings panel normalize preview sizes across themes whose assets have
// wildly different canvas utilization (pixel pets with lots of transparent
// margin vs APNG cats that fill the whole frame).
function _computePreviewContentRatio(raw) {
  const vb = raw && raw.viewBox;
  const cb = raw && raw.layout && raw.layout.contentBox;
  if (!vb || !cb) return null;
  if (!(vb.width > 0) || !(vb.height > 0)) return null;
  if (!(cb.width > 0) || !(cb.height > 0)) return null;
  return Math.max(cb.width / vb.width, cb.height / vb.height);
}

// How far the contentBox center sits away from the viewBox center, as a
// percentage of viewBox size. Themes like clawd place the pet near the bottom
// of the viewBox (baseline-anchored) so the preview thumbnail looks bottom-
// heavy — the renderer applies a matching transform to recenter it visually.
function _computePreviewContentOffsetPct(raw) {
  const vb = raw && raw.viewBox;
  const cb = raw && raw.layout && raw.layout.contentBox;
  if (!vb || !cb) return null;
  if (!(vb.width > 0) || !(vb.height > 0)) return null;
  const cbCenterX = cb.x + cb.width / 2;
  const cbCenterY = cb.y + cb.height / 2;
  const vbCenterX = vb.x + vb.width / 2;
  const vbCenterY = vb.y + vb.height / 2;
  return {
    x: -((cbCenterX - vbCenterX) / vb.width) * 100,
    y: -((cbCenterY - vbCenterY) / vb.height) * 100,
  };
}

/**
 * Single-pass scan + metadata build — used by the settings panel.
 * Avoids the O(2N) read that `discoverThemes() + getThemeMetadata() per id`
 * would incur since this path fires on every theme-tab open and on every
 * `theme` / `themeOverrides` broadcast.
 */
function listThemesWithMetadata() {
  const themes = [];
  const seen = new Set();
  if (builtinThemesDir) _scanMetadata(builtinThemesDir, true, themes, seen);
  if (userThemesDir) _scanMetadata(userThemesDir, false, themes, seen);
  return themes;
}

function _scanMetadata(dir, builtin, themes, seen) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      const jsonPath = path.join(dir, entry.name, "theme.json");
      let raw;
      try { raw = JSON.parse(fs.readFileSync(jsonPath, "utf8")); } catch { continue; }
      if (builtin && raw && raw._scaffoldOnly === true) continue;
      const themeDir = path.join(dir, entry.name);
      themes.push({
        id: entry.name,
        name: raw.name || entry.name,
        builtin,
        previewFileUrl: _buildPreviewUrl(raw, themeDir, builtin),
        previewContentRatio: _computePreviewContentRatio(raw),
        previewContentOffsetPct: _computePreviewContentOffsetPct(raw),
        variants: _buildVariantMetadata(raw, themeDir, builtin),
        capabilities: _buildCapabilities(raw),
      });
      seen.add(entry.name);
    }
  } catch { /* dir missing */ }
}

module.exports = {
  init,
  discoverThemes,
  loadTheme,
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
  // Schema constants + helpers — shared with scripts/validate-theme.js to
  // keep validator and runtime loader from drifting on the same invariants.
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
