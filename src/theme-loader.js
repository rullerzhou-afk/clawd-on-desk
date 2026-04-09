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

const REQUIRED_STATES = ["idle", "working", "thinking", "sleeping", "waking"];

// ── SVG sanitization config ──
const DANGEROUS_TAGS = new Set([
  "script", "foreignobject", "iframe", "embed", "object", "applet",
  "meta", "link", "base", "form", "input", "textarea", "button",
]);
const DANGEROUS_ATTR_RE = /^on/i;
const DANGEROUS_HREF_RE = /^\s*javascript\s*:/i;
const EXTERNAL_RESOURCE_RE = /^\s*(https?|data|file|ftp)\s*:/i;
const PATH_TRAVERSAL_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const HREF_ATTRS = new Set(["href", "xlink:href", "src", "action", "formaction"]);

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
      if (!fs.existsSync(jsonPath)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        themes.push({ id: entry.name, name: cfg.name || entry.name, path: jsonPath, builtin });
        seen.add(entry.name);
      } catch { /* skip malformed */ }
    }
  } catch { /* dir not found */ }
}

/**
 * Load and activate a theme by ID.
 * @param {string} themeId
 * @returns {object} merged theme config
 */
function loadTheme(themeId) {
  // Try built-in first, then user themes dir
  const { raw, isBuiltin, themeDir } = _readThemeJson(themeId);

  if (!raw) {
    console.error(`[theme-loader] Theme "${themeId}" not found`);
    if (themeId !== "clawd") return loadTheme("clawd");
    throw new Error("Default theme 'clawd' not found");
  }

  const errors = validateTheme(raw);
  if (errors.length > 0) {
    console.error(`[theme-loader] Theme "${themeId}" validation errors:`, errors);
    if (themeId !== "clawd") return loadTheme("clawd");
  }

  // Merge defaults for optional fields
  const theme = mergeDefaults(raw, themeId, isBuiltin);
  theme._themeDir = themeDir;

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
            textNode.data = textNode.data
              .replace(/@import\b[^;]*/gi, "/* sanitized */")
              .replace(/url\s*\(\s*(?!['"]?#)[^)]*\)/gi, "url()");
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
          if (DANGEROUS_HREF_RE.test(val) || EXTERNAL_RESOURCE_RE.test(val) || PATH_TRAVERSAL_RE.test(val)) {
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
    // Built-in theme with own assets dir (e.g., calico with APNGs)
    if (!filename.endsWith(".svg")) {
      const themeAsset = path.join(activeTheme._themeDir, "assets", filename);
      if (fs.existsSync(themeAsset)) return themeAsset;
    }
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
      if (!cfg.states[s] || !Array.isArray(cfg.states[s]) || cfg.states[s].length === 0) {
        errors.push(`states.${s} must be a non-empty array`);
      }
    }
  }

  // eyeTracking.states listed states must use .svg if enabled
  if (cfg.eyeTracking && cfg.eyeTracking.enabled && cfg.states) {
    for (const stateName of (cfg.eyeTracking.states || [])) {
      const files = cfg.states[stateName] ||
                    (cfg.miniMode && cfg.miniMode.states && cfg.miniMode.states[stateName]);
      if (files) {
        for (const f of files) {
          if (!f.endsWith(".svg")) {
            errors.push(`eyeTracking state "${stateName}" file "${f}" must be .svg`);
          }
        }
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
  const bn = (f) => typeof f === "string" ? f.replace(/^.*[\/\\]/, "") : f;
  for (const [s, files] of Object.entries(theme.states || {})) {
    if (Array.isArray(files)) theme.states[s] = files.map(bn);
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

module.exports = {
  init,
  discoverThemes,
  loadTheme,
  getActiveTheme,
  resolveHint,
  getAssetPath,
  getRendererAssetsPath,
  getRendererSourceAssetsPath,
  getRendererConfig,
  getHitRendererConfig,
  ensureUserThemesDir,
  getSoundUrl,
};
