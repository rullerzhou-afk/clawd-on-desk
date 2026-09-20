"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MAX_CUSTOM_APPLICATIONS = 32;
const CUSTOM_APPLICATION_ID_RE = /^custom-[a-z0-9-]+-[a-f0-9]{12}$/;
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([".exe", ".cmd", ".bat", ".com"]);
const AUXILIARY_EXECUTABLE_RE = /(?:unins|uninstall|update|updater|helper|crash|report|service|setup|install)/i;

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, maxLength) : "";
}

function applicationName(filePath, pathApi = path) {
  return pathApi.basename(filePath, pathApi.extname(filePath))
    .replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || "Custom application";
}

function applicationId(executablePath, name, platform = process.platform) {
  const key = platform === "win32" ? executablePath.toLowerCase() : executablePath;
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "app";
  return `custom-${slug}-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

function isCustomApplicationId(value) {
  return typeof value === "string" && CUSTOM_APPLICATION_ID_RE.test(value);
}

function isCustomApplicationNamespace(value) {
  return typeof value === "string" && value.toLowerCase().startsWith("custom-");
}

function isLaunchable(filePath, stat, platform, pathApi, fsApi = fs) {
  if (!stat || !stat.isFile()) return false;
  if (platform === "win32") return WINDOWS_EXECUTABLE_EXTENSIONS.has(pathApi.extname(filePath).toLowerCase());
  // Use the same effective X_OK check for discovery and registration. The
  // mode-bit fallback is only for injected filesystem doubles that do not
  // expose accessSync.
  try {
    if (typeof fsApi.accessSync === "function") {
      fsApi.accessSync(filePath, fs.constants.X_OK);
      return true;
    }
  } catch {
    return false;
  }
  return (stat.mode & 0o111) !== 0;
}

function findExecutable(directory, options) {
  const fsApi = options.fs || fs;
  const pathApi = options.path || path;
  const platform = options.platform || process.platform;
  if (platform === "darwin" && directory.toLowerCase().endsWith(".app")) {
    return findExecutable(pathApi.join(directory, "Contents", "MacOS"), {
      ...options,
      fs: fsApi,
      path: pathApi,
      platform,
    });
  }
  let entries;
  try { entries = fsApi.readdirSync(directory, { withFileTypes: true }).slice(0, 200); } catch { return null; }
  const dirName = pathApi.basename(directory).toLowerCase().replace(/\.app$/i, "");
  const candidates = [];
  for (const entry of entries) {
    if (!entry || !entry.isFile()) continue;
    const filePath = pathApi.join(directory, entry.name);
    let stat;
    try { stat = fsApi.statSync(filePath); } catch { continue; }
    if (!isLaunchable(filePath, stat, platform, pathApi, fsApi)) continue;
    const stem = pathApi.basename(filePath, pathApi.extname(filePath)).toLowerCase();
    let score = pathApi.extname(filePath).toLowerCase() === ".exe" ? 20 : 10;
    if (stem === dirName) score += 100;
    else if (stem.includes(dirName) || dirName.includes(stem)) score += 30;
    if (AUXILIARY_EXECUTABLE_RE.test(stem)) score -= 100;
    candidates.push({ filePath, score });
  }
  candidates.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));
  return candidates.length && candidates[0].score >= 0 ? candidates[0].filePath : null;
}

function identifyCustomApplication(sourcePath, options = {}) {
  const fsApi = options.fs || fs;
  const pathApi = options.path || path;
  const platform = options.platform || process.platform;
  const source = cleanText(sourcePath, 2048);
  if (!source) return null;
  let stat;
  try { stat = fsApi.statSync(source); } catch { return null; }
  let executablePath = null;
  if (stat.isFile() && isLaunchable(source, stat, platform, pathApi, fsApi)) executablePath = source;
  if (stat.isDirectory()) executablePath = findExecutable(source, { fs: fsApi, path: pathApi, platform });
  if (!executablePath) return null;
  const name = applicationName(executablePath, pathApi);
  return {
    id: applicationId(executablePath, name, platform),
    name,
    sourcePath: source,
    executablePath,
    processName: pathApi.basename(executablePath).replace(/\.app$/i, ""),
    category: "code",
  };
}

function normalizeCustomApplication(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = cleanText(value.id, 80);
  const name = cleanText(value.name, 80);
  const sourcePath = cleanText(value.sourcePath, 2048);
  const executablePath = cleanText(value.executablePath, 2048);
  const processName = cleanText(value.processName, 260);
  if (!isCustomApplicationId(id) || !name || !sourcePath || !executablePath || !processName) return null;
  return { id, name, sourcePath, executablePath, processName, category: value.category === "work" ? "work" : "code" };
}

function normalizeCustomApplications(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const ids = new Set();
  for (const valueEntry of value) {
    const entry = normalizeCustomApplication(valueEntry);
    if (!entry || ids.has(entry.id)) continue;
    ids.add(entry.id);
    out.push(entry);
    if (out.length >= MAX_CUSTOM_APPLICATIONS) break;
  }
  return out;
}

module.exports = {
  MAX_CUSTOM_APPLICATIONS,
  identifyCustomApplication,
  isLaunchable,
  isCustomApplicationId,
  isCustomApplicationNamespace,
  normalizeCustomApplications,
};
