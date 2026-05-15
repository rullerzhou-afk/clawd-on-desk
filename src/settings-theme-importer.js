"use strict";

const defaultFs = require("fs");
const defaultPath = require("path");
const codexPetImporter = require("./codex-pet-importer");
const {
  collectRequiredAssetFiles,
  mergeDefaults,
  validateTheme,
} = require("./theme-schema");

const MAX_THEME_ZIP_BYTES = 80 * 1024 * 1024;
const MAX_THEME_ZIP_ENTRY_BYTES = 40 * 1024 * 1024;
const MAX_THEME_UNZIPPED_BYTES = 160 * 1024 * 1024;
const MAX_THEME_JSON_BYTES = 512 * 1024;
const RESERVED_THEME_IDS = new Set(["clawd", "calico", "cloudling", "template"]);

function isPathInsideDir(pathModule, rootDir, targetPath) {
  const root = pathModule.resolve(rootDir);
  const target = pathModule.resolve(targetPath);
  return target === root || target.startsWith(root + pathModule.sep);
}

function sanitizeThemeDirName(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 80);
  return cleaned || "";
}

function getZipNameParts(entryName) {
  return String(entryName || "").split("/").filter(Boolean);
}

function chooseThemeZipRoot(entries) {
  const themeEntries = (entries || []).filter((entry) => {
    if (!entry || entry.directory) return false;
    const parts = getZipNameParts(entry.name);
    return parts[parts.length - 1] === "theme.json" && (parts.length === 1 || parts.length === 2);
  });
  if (themeEntries.length !== 1) {
    throw new Error("theme zip must contain exactly one theme.json at the root or inside one top-level folder");
  }
  const parts = getZipNameParts(themeEntries[0].name);
  return {
    prefix: parts.length === 2 ? `${parts[0]}/` : "",
    folderName: parts.length === 2 ? parts[0] : "",
    themeJsonEntry: themeEntries[0],
  };
}

function isEntryInThemeRoot(entryName, prefix) {
  if (!prefix) return true;
  return entryName === prefix || entryName.startsWith(prefix);
}

function stripThemeRootPrefix(entryName, prefix) {
  return prefix ? entryName.slice(prefix.length) : entryName;
}

function assertSafeRelativePath(pathModule, rootDir, relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`unsafe theme zip entry path: ${relativePath}`);
  }
  const target = pathModule.resolve(pathModule.join(rootDir, ...parts));
  if (!isPathInsideDir(pathModule, rootDir, target)) {
    throw new Error(`theme zip entry escapes import directory: ${relativePath}`);
  }
  return { parts, target };
}

function validateExtractedTheme({ fs, path, stagingDir, themeId }) {
  const themeJsonPath = path.join(stagingDir, "theme.json");
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(themeJsonPath, "utf8"));
  } catch (err) {
    throw new Error(`invalid theme.json: ${(err && err.message) || String(err)}`);
  }
  const errors = validateTheme(raw);
  if (errors.length > 0) throw new Error(`theme.json validation failed: ${errors.join("; ")}`);

  const effective = mergeDefaults(raw, themeId, false);
  const missingAssets = collectRequiredAssetFiles(effective)
    .filter((filename) => !fs.existsSync(path.join(stagingDir, "assets", filename)));
  if (missingAssets.length > 0) {
    throw new Error(`theme zip is missing asset file${missingAssets.length === 1 ? "" : "s"}: ${missingAssets.join(", ")}`);
  }
  return raw;
}

function importUserThemeZip(zipPath, options = {}) {
  const fs = options.fs || defaultFs;
  const path = options.path || defaultPath;
  const userThemesDir = options.userThemesDir;
  if (!userThemesDir) throw new Error("user themes directory unavailable");
  if (typeof zipPath !== "string" || !zipPath) throw new Error("zip path is required");

  const stat = fs.statSync(zipPath);
  if (!stat.isFile()) throw new Error("selected theme package is not a file");
  if (stat.size > MAX_THEME_ZIP_BYTES) throw new Error(`theme zip exceeds ${MAX_THEME_ZIP_BYTES} bytes`);

  const buffer = fs.readFileSync(zipPath);
  const entries = codexPetImporter.readZipEntries(buffer);
  const { prefix, folderName, themeJsonEntry } = chooseThemeZipRoot(entries);
  if (themeJsonEntry.uncompressedSize > MAX_THEME_JSON_BYTES) {
    throw new Error(`theme.json exceeds ${MAX_THEME_JSON_BYTES} bytes`);
  }

  const fallbackName = path.basename(zipPath, path.extname(zipPath));
  const themeId = sanitizeThemeDirName(folderName || fallbackName);
  if (!themeId) throw new Error("could not derive a theme folder name from the package");
  if (RESERVED_THEME_IDS.has(themeId.toLowerCase())) {
    throw new Error(`theme id "${themeId}" is reserved`);
  }

  fs.mkdirSync(userThemesDir, { recursive: true });
  const targetDir = path.resolve(path.join(userThemesDir, themeId));
  if (!isPathInsideDir(path, userThemesDir, targetDir)) {
    throw new Error("theme package target escapes user themes directory");
  }
  if (fs.existsSync(targetDir)) throw new Error(`theme "${themeId}" already exists`);

  const stagingDir = path.resolve(path.join(userThemesDir, `${themeId}.importing-${process.pid}-${Date.now()}`));
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    let totalUnzipped = 0;
    const seenPaths = new Set();
    for (const entry of entries) {
      if (!entry || entry.directory || !isEntryInThemeRoot(entry.name, prefix)) continue;
      const relativePath = stripThemeRootPrefix(entry.name, prefix);
      if (!relativePath) continue;
      const { target } = assertSafeRelativePath(path, stagingDir, relativePath);
      const normalizedKey = path.relative(stagingDir, target).toLowerCase();
      if (seenPaths.has(normalizedKey)) throw new Error(`duplicate theme zip entry: ${relativePath}`);
      seenPaths.add(normalizedKey);
      totalUnzipped += entry.uncompressedSize || 0;
      if (totalUnzipped > MAX_THEME_UNZIPPED_BYTES) {
        throw new Error(`theme zip unpacks above ${MAX_THEME_UNZIPPED_BYTES} bytes`);
      }
      const contents = codexPetImporter.extractZipEntry(buffer, entry, MAX_THEME_ZIP_ENTRY_BYTES);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }

    const raw = validateExtractedTheme({ fs, path, stagingDir, themeId });
    if (fs.existsSync(targetDir)) throw new Error(`theme "${themeId}" already exists`);
    fs.renameSync(stagingDir, targetDir);
    return {
      status: "ok",
      themeId,
      name: raw && raw.name,
      path: targetDir,
    };
  } catch (err) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

module.exports = {
  MAX_THEME_ZIP_BYTES,
  importUserThemeZip,
  sanitizeThemeDirName,
};
