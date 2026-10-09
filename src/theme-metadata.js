"use strict";

// Design invariant: this module must not require theme-loader, hold active-theme
// state, or read directories owned by theme-loader.init(). Directory roots and
// single-theme reads are injected through options.

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const {
  isPlainObject,
  getStateFiles,
  buildCapabilities,
  basenameOnly,
  getCanonicalFileViewBoxes,
} = require("./theme-schema");

function fileUrl(absPath) {
  try { return pathToFileURL(absPath).href; } catch { return null; }
}

function getPreviewFile(raw) {
  return (typeof raw.preview === "string" && raw.preview)
    || getStateFiles(raw.states && raw.states.idle)[0]
    || null;
}

// basenameOnly, not path.basename: the loader keys fileViewBoxes that way, so a
// backslash-separated value has to resolve to the same file here as it does at
// runtime, on every platform.
function resolvePreviewAbsPath(previewFile, themeDir, isBuiltin, options = {}) {
  const filename = previewFile ? basenameOnly(previewFile) : null;
  if (!filename) return null;
  const themeLocal = path.join(themeDir, "assets", filename);
  if (fs.existsSync(themeLocal)) return themeLocal;
  const assetsSvgDir = options.assetsSvgDir || null;
  if (isBuiltin && assetsSvgDir) {
    const central = path.join(assetsSvgDir, filename);
    if (fs.existsSync(central)) return central;
  }
  return null;
}

function buildPreviewUrl(raw, themeDir, isBuiltin, options = {}) {
  const absPath = resolvePreviewAbsPath(getPreviewFile(raw), themeDir, isBuiltin, options);
  return absPath ? fileUrl(absPath) : null;
}

function getVariantPreviewFileCandidate(variantSpec) {
  if (!variantSpec) return null;
  if (typeof variantSpec.preview === "string" && variantSpec.preview) return variantSpec.preview;
  if (Array.isArray(variantSpec.idleAnimations)
      && variantSpec.idleAnimations[0]
      && typeof variantSpec.idleAnimations[0].file === "string") {
    return variantSpec.idleAnimations[0].file;
  }
  return null;
}

// The file a variant card actually shows: its own preview when that asset
// exists, otherwise the theme's. Framing has to follow the same choice, or a
// variant drawn on another canvas would be measured against the wrong box.
function resolveVariantPreviewFile(raw, variantSpec, themeDir, isBuiltin, options = {}) {
  const candidate = getVariantPreviewFileCandidate(variantSpec);
  if (candidate && resolvePreviewAbsPath(candidate, themeDir, isBuiltin, options)) return candidate;
  return getPreviewFile(raw);
}

function buildVariantPreviewUrl(raw, variantSpec, themeDir, isBuiltin, options = {}) {
  const previewFile = resolveVariantPreviewFile(raw, variantSpec, themeDir, isBuiltin, options);
  const absPath = resolvePreviewAbsPath(previewFile, themeDir, isBuiltin, options);
  return absPath ? fileUrl(absPath) : null;
}

function buildPreviewGeometry(raw, previewFile) {
  return {
    previewContentRatio: computePreviewContentRatio(raw, previewFile),
    previewContentOffsetPct: computePreviewContentOffsetPct(raw, previewFile),
  };
}

function buildVariantMetadata(raw, themeDir, isBuiltin, options = {}) {
  const rawVariants = isPlainObject(raw.variants) ? raw.variants : {};
  const hasExplicitDefault = isPlainObject(rawVariants.default);
  const out = [];

  if (!hasExplicitDefault) {
    out.push({
      id: "default",
      name: { en: "Standard", zh: "标准", "zh-TW": "標準" },
      description: null,
      previewFileUrl: buildPreviewUrl(raw, themeDir, isBuiltin, options),
      ...buildPreviewGeometry(raw, getPreviewFile(raw)),
    });
  }
  for (const [id, spec] of Object.entries(rawVariants)) {
    if (!isPlainObject(spec)) continue;
    out.push({
      id,
      name: (spec.name != null) ? spec.name : id,
      description: (spec.description != null) ? spec.description : null,
      previewFileUrl: buildVariantPreviewUrl(raw, spec, themeDir, isBuiltin, options),
      ...buildPreviewGeometry(raw, resolveVariantPreviewFile(raw, spec, themeDir, isBuiltin, options)),
    });
  }
  return out;
}

function boxContains(outer, inner) {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

// The thumbnail shows only the preview file's own canvas. A file placed through
// fileViewBoxes covers that box of the theme's coordinate space, not the root
// viewBox, so the content box must be framed against it — but only while the
// content box still fits inside that canvas. A file that does not contain the
// character is no frame for it, and the root viewBox stays the safer guess.
function getPreviewFrameViewBox(raw, previewFile) {
  if (!raw) return null;
  const file = previewFile === undefined ? getPreviewFile(raw) : previewFile;
  const fileViewBox = file && getCanonicalFileViewBoxes(raw)[basenameOnly(file)];
  if (!fileViewBox) return raw.viewBox;
  const cb = raw.layout && raw.layout.contentBox;
  if (cb && cb.width > 0 && cb.height > 0 && !boxContains(fileViewBox, cb)) return raw.viewBox;
  return fileViewBox;
}

function computePreviewContentRatio(raw, previewFile) {
  const vb = getPreviewFrameViewBox(raw, previewFile);
  const cb = raw && raw.layout && raw.layout.contentBox;
  if (!vb || !cb) return null;
  if (!(vb.width > 0) || !(vb.height > 0)) return null;
  if (!(cb.width > 0) || !(cb.height > 0)) return null;
  return Math.max(cb.width / vb.width, cb.height / vb.height);
}

function computePreviewContentOffsetPct(raw, previewFile) {
  const vb = getPreviewFrameViewBox(raw, previewFile);
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

function buildThemeMetadata(themeId, raw, isBuiltin, themeDir, options = {}) {
  if (!raw) return null;
  return {
    id: themeId,
    name: raw.name || themeId,
    builtin: !!isBuiltin,
    previewFileUrl: buildPreviewUrl(raw, themeDir, isBuiltin, options),
    previewContentRatio: computePreviewContentRatio(raw),
    previewContentOffsetPct: computePreviewContentOffsetPct(raw),
    variants: buildVariantMetadata(raw, themeDir, isBuiltin, options),
    capabilities: buildCapabilities(raw, { trustedRuntimeAllowed: !!isBuiltin }),
  };
}

function getThemeMetadata(themeId, options = {}) {
  const readThemeJson = options.readThemeJson;
  if (typeof readThemeJson !== "function") {
    throw new TypeError("getThemeMetadata requires options.readThemeJson");
  }
  const { raw, isBuiltin, themeDir } = readThemeJson(themeId);
  return buildThemeMetadata(themeId, raw, isBuiltin, themeDir, options);
}

function listThemesWithMetadata(options = {}) {
  const themes = [];
  const seen = new Set();
  if (options.builtinThemesDir) scanMetadata(options.builtinThemesDir, true, themes, seen, options);
  if (options.userThemesDir) scanMetadata(options.userThemesDir, false, themes, seen, options);
  return themes;
}

// Symmetric with theme-loader._scanThemesDir / _readThemeJson: a dotted direct
// child of the themes dir is manager-owned scratch, never a theme.
function isScannableThemeDirName(name) {
  return typeof name === "string" && name.length > 0 && !name.startsWith(".");
}

function scanMetadata(dir, builtin, themes, seen, options = {}) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      if (!isScannableThemeDirName(entry.name)) continue;
      const jsonPath = path.join(dir, entry.name, "theme.json");
      let raw;
      try { raw = JSON.parse(fs.readFileSync(jsonPath, "utf8")); } catch { continue; }
      if (builtin && raw && raw._scaffoldOnly === true) continue;
      const themeDir = path.join(dir, entry.name);
      themes.push(buildThemeMetadata(entry.name, raw, builtin, themeDir, options));
      seen.add(entry.name);
    }
  } catch { /* dir missing */ }
}

module.exports = {
  getThemeMetadata,
  listThemesWithMetadata,
  buildThemeMetadata,
  buildPreviewUrl,
  buildVariantPreviewUrl,
  buildVariantMetadata,
  computePreviewContentRatio,
  computePreviewContentOffsetPct,
  isScannableThemeDirName,
};
