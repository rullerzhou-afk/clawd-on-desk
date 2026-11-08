"use strict";

// Dark appearance support is optional and must never make a theme fail to
// load. This module only inspects the theme package on disk; callers decide
// whether an unavailable dark directory is worth a warning.

const fs = require("fs");
const path = require("path");

// Single path segment. The name is also used as a cache subdirectory, so keep
// it to characters that are safe on every platform.
const DARK_ASSETS_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function lstatOrNull(absPath) {
  try { return fs.lstatSync(absPath); } catch { return null; }
}

function realpathOrNull(absPath) {
  try { return fs.realpathSync(absPath); } catch { return null; }
}

function isInsideDir(rootDir, candidatePath) {
  const relative = path.relative(rootDir, candidatePath);
  return relative === ""
    || (!!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Symlinks are deliberately ignored: the completeness contract is about real
// files inside the theme package, and a link could point anywhere.
function collectRelativeFiles(rootDir) {
  const files = [];
  const walk = (dir, prefix) => {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const absPath = path.join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatOrNull(absPath);
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(absPath, relative);
      else if (stat.isFile()) files.push(relative);
    }
  };
  walk(rootDir, "");
  return files;
}

/**
 * Check whether a theme package can serve `appearance.dark.assetsDir`.
 *
 * Returns `{ ok, reason, dir }` and never logs. `reason` is null when the theme
 * simply does not declare a dark appearance; callers only warn about declared
 * appearances that turn out to be unusable.
 *
 * @param {string} themeDir absolute theme package directory
 * @param {unknown} appearance raw `theme.json` appearance field
 * @returns {{ ok: boolean, reason: string|null, dir: string|null }}
 */
function inspectDarkAppearance(themeDir, appearance) {
  if (appearance === undefined || appearance === null) {
    return { ok: false, reason: null, dir: null };
  }
  if (typeof appearance !== "object" || Array.isArray(appearance)) {
    return { ok: false, reason: "appearance must be an object", dir: null };
  }
  const dark = appearance.dark;
  if (!dark || typeof dark !== "object" || Array.isArray(dark)) {
    return { ok: false, reason: "appearance.dark must be an object", dir: null };
  }
  const assetsDir = dark.assetsDir;
  if (typeof assetsDir !== "string" || !DARK_ASSETS_DIR_RE.test(assetsDir)) {
    return { ok: false, reason: "appearance.dark.assetsDir must be a single directory name", dir: null };
  }
  if (assetsDir.toLowerCase() === "assets") {
    return { ok: false, reason: "appearance.dark.assetsDir must not reuse assets/", dir: null };
  }
  if (typeof themeDir !== "string" || !themeDir) {
    return { ok: false, reason: "theme directory is unknown", dir: null };
  }

  const lightDir = path.join(themeDir, "assets");
  const lightStat = lstatOrNull(lightDir);
  if (!lightStat || !lightStat.isDirectory() || lightStat.isSymbolicLink()) {
    return { ok: false, reason: "assets/ is not a real directory", dir: null };
  }
  const darkDir = path.join(themeDir, assetsDir);
  const darkStat = lstatOrNull(darkDir);
  if (!darkStat || !darkStat.isDirectory() || darkStat.isSymbolicLink()) {
    return { ok: false, reason: `${assetsDir}/ is not a real directory`, dir: null };
  }
  // Resolve the root once; every mirrored file must stay inside it even when
  // an intermediate directory is a symbolic link.
  const darkRealDir = realpathOrNull(darkDir);
  if (!darkRealDir) {
    return { ok: false, reason: `${assetsDir}/ cannot be resolved`, dir: null };
  }

  for (const relative of collectRelativeFiles(lightDir)) {
    const mirroredPath = path.join(darkDir, ...relative.split("/"));
    const mirrored = lstatOrNull(mirroredPath);
    if (!mirrored || !mirrored.isFile() || mirrored.isSymbolicLink()) {
      return { ok: false, reason: `${assetsDir}/ is missing ${relative}`, dir: null };
    }
    const mirroredRealPath = realpathOrNull(mirroredPath);
    if (!mirroredRealPath || !isInsideDir(darkRealDir, mirroredRealPath)) {
      return { ok: false, reason: `${assetsDir}/${relative} escapes the theme package`, dir: null };
    }
  }

  return { ok: true, reason: null, dir: darkDir };
}

module.exports = {
  inspectDarkAppearance,
  collectRelativeFiles,
  DARK_ASSETS_DIR_RE,
};
