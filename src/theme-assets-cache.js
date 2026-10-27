"use strict";

// NOTE: log lines keep the legacy "[theme-loader]" prefix so existing grep and
// alert rules that target the original module name continue to work.

const fs = require("fs");
const path = require("path");
const {
  sanitizeSvg,
  collectSafeRasterRefs,
} = require("./theme-sanitizer");

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPathInsideDir(baseDir, candidatePath) {
  if (!baseDir || !candidatePath) return false;
  const base = path.resolve(baseDir);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(base, candidate);
  const firstSegment = relative.split(/[\\/]/)[0];
  return relative === "" || (!!relative && firstSegment !== ".." && !path.isAbsolute(relative));
}

function externalAssetsSourceDir(themeDir) {
  return path.join(themeDir, "assets");
}

// Bump when sanitizeSvg's output changes so cached SVGs are written again.
// v3: the XML declaration keeps its closing "?" (v2 caches wrote `<?xml ...>`).
// v4: only a leading XML declaration survives; other processing instructions
// are removed from cached SVGs.
const CACHE_META_VERSION = 4;

function emptyCacheMeta() {
  return { version: CACHE_META_VERSION, svgs: {}, rasters: {} };
}

function normalizeCacheMeta(value) {
  if (value && (value.version === CACHE_META_VERSION || value.version === 3 || value.version === 2)) {
    const stale = value.version !== CACHE_META_VERSION;
    return {
      meta: {
        version: CACHE_META_VERSION,
        svgs: isPlainObject(value.svgs) ? value.svgs : {},
        rasters: isPlainObject(value.rasters) ? value.rasters : {},
      },
      changed: stale,
      invalidateSvgs: stale,
    };
  }
  if (isPlainObject(value)) {
    const svgs = {};
    for (const [file, entry] of Object.entries(value)) {
      if (file === "version" || file === "svgs" || file === "rasters") continue;
      if (!isPlainObject(entry)) continue;
      svgs[file] = entry;
    }
    return { meta: { version: CACHE_META_VERSION, svgs, rasters: {} }, changed: true, invalidateSvgs: true };
  }
  return { meta: emptyCacheMeta(), changed: true, invalidateSvgs: true };
}

function removeCachedRaster(cacheDir, relPath) {
  try {
    fs.rmSync(path.join(cacheDir, ...relPath.split("/")), { force: true });
  } catch {}
}

function copyRasterToCache(sourceAbs, destAbs, stat) {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  const tmp = `${destAbs}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.copyFileSync(sourceAbs, tmp);
    const tmpStat = fs.statSync(tmp);
    if (!tmpStat.isFile() || tmpStat.size !== stat.size) {
      throw new Error("copied raster size mismatch");
    }
    fs.renameSync(tmp, destAbs);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

function syncRasterCache(themeId, cacheDir, cacheMeta, rasterRefs) {
  let changed = false;
  const missing = [];
  const referenced = new Set(rasterRefs.keys());
  const sourceStats = new Map();

  for (const [destRel, ref] of rasterRefs.entries()) {
    let stat = sourceStats.get(ref.sourceKey);
    if (!stat) {
      try {
        stat = fs.statSync(ref.sourceAbs);
      } catch {
        console.warn(`[theme-loader] Missing raster dependency for theme "${themeId}": ${ref.sourceRel}`);
        missing.push(ref.sourceRel);
        removeCachedRaster(cacheDir, destRel);
        if (cacheMeta.rasters[destRel]) {
          delete cacheMeta.rasters[destRel];
          changed = true;
        }
        continue;
      }
      sourceStats.set(ref.sourceKey, stat);
    }
    if (!stat.isFile()) {
      console.warn(`[theme-loader] Raster dependency is not a file for theme "${themeId}": ${ref.sourceRel}`);
      missing.push(ref.sourceRel);
      removeCachedRaster(cacheDir, destRel);
      if (cacheMeta.rasters[destRel]) {
        delete cacheMeta.rasters[destRel];
        changed = true;
      }
      continue;
    }

    const destAbs = path.join(cacheDir, ...destRel.split("/"));
    const cached = cacheMeta.rasters[destRel];
    let destStat = null;
    try { destStat = fs.statSync(destAbs); } catch {}
    if (
      cached
      && cached.source === ref.sourceRel
      && cached.mtime === stat.mtimeMs
      && cached.size === stat.size
      && destStat
      && destStat.isFile()
      && destStat.size === stat.size
    ) {
      continue;
    }

    try {
      copyRasterToCache(ref.sourceAbs, destAbs, stat);
      cacheMeta.rasters[destRel] = {
        source: ref.sourceRel,
        mtime: stat.mtimeMs,
        size: stat.size,
      };
      changed = true;
    } catch (e) {
      console.error(`[theme-loader] Failed to cache raster ${ref.sourceRel} for theme "${themeId}":`, e.message);
      removeCachedRaster(cacheDir, destRel);
      if (cacheMeta.rasters[destRel]) {
        delete cacheMeta.rasters[destRel];
        changed = true;
      }
    }
  }

  for (const relPath of Object.keys(cacheMeta.rasters)) {
    if (referenced.has(relPath)) continue;
    removeCachedRaster(cacheDir, relPath);
    delete cacheMeta.rasters[relPath];
    changed = true;
  }

  return { changed, missing };
}

function resolveExternalAssetsDir(themeId, themeDir, opts = {}) {
  const strict = !!(opts && opts.strict);
  const themeCacheDir = opts && opts.themeCacheDir;
  const sourceAssetsDir = externalAssetsSourceDir(themeDir);
  if (!themeCacheDir) return sourceAssetsDir;

  const cacheDir = path.join(themeCacheDir, themeId, "assets");
  const cacheMetaPath = path.join(themeCacheDir, themeId, ".cache-meta.json");

  let cacheMeta = emptyCacheMeta();
  let metaChanged = false;
  let forceSvgRefresh = false;
  try {
    const rawMeta = JSON.parse(fs.readFileSync(cacheMetaPath, "utf8"));
    const normalized = normalizeCacheMeta(rawMeta);
    cacheMeta = normalized.meta;
    metaChanged = normalized.changed;
    forceSvgRefresh = normalized.invalidateSvgs;
  } catch { /* no cache yet */ }

  fs.mkdirSync(cacheDir, { recursive: true });

  const rasterRefs = new Map();
  try {
    const files = fs.readdirSync(sourceAssetsDir);
    for (const file of files) {
      const srcFile = path.join(sourceAssetsDir, file);

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
        const cachedSvgPath = path.join(cacheDir, file);
        const cached = cacheMeta.svgs[file];
        let sanitized = null;
        if (!forceSvgRefresh && cached && cached.mtime === stat.mtimeMs && cached.size === stat.size && fs.existsSync(cachedSvgPath)) {
          try {
            sanitized = fs.readFileSync(cachedSvgPath, "utf8");
          } catch {
            sanitized = null;
          }
        }

        try {
          if (sanitized == null) {
            const svgContent = fs.readFileSync(srcFile, "utf8");
            sanitized = sanitizeSvg(svgContent);
            fs.writeFileSync(cachedSvgPath, sanitized, "utf8");
            cacheMeta.svgs[file] = { mtime: stat.mtimeMs, size: stat.size };
            metaChanged = true;
          }
          for (const ref of collectSafeRasterRefs(sanitized, sourceAssetsDir).values()) {
            rasterRefs.set(ref.destRel, ref);
          }
        } catch (e) {
          console.error(`[theme-loader] Failed to sanitize ${file}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error(`[theme-loader] Failed to scan assets for theme "${themeId}":`, e.message);
  }

  const rasterCopyResult = syncRasterCache(themeId, cacheDir, cacheMeta, rasterRefs);
  if (rasterCopyResult.changed) metaChanged = true;

  if (metaChanged) {
    try {
      fs.writeFileSync(cacheMetaPath, JSON.stringify(cacheMeta, null, 2), "utf8");
    } catch {}
  }

  if (strict && rasterCopyResult.missing.length > 0) {
    throw new Error(
      `Theme "${themeId}" missing raster dependencies: ${rasterCopyResult.missing.join(", ")}`
    );
  }

  return cacheDir;
}

module.exports = {
  resolveExternalAssetsDir,
  externalAssetsSourceDir,
  isPathInsideDir,
  emptyCacheMeta,
  normalizeCacheMeta,
  syncRasterCache,
};
