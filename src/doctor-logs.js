"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_LOG_BASENAMES = Object.freeze([
  "permission-debug.log",
  "session-debug.log",
  "focus-debug.log",
  "update-debug.log",
  "gemini-debug.log",
  "opencode-plugin.log",
  "mimocode-plugin.log",
]);

function isAllowedLogBasename(name, pathApi = path) {
  if (typeof name !== "string" || !name) return false;
  if (pathApi.basename(name) !== name) return false;
  return name.toLowerCase().endsWith(".log");
}

function uniqueDirs(dirs, pathApi = path) {
  const out = [];
  const seen = new Set();
  for (const dir of dirs) {
    if (typeof dir !== "string" || !dir) continue;
    const resolved = pathApi.resolve(dir);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

function getAllowedLogDirs(options = {}) {
  const pathApi = options.path || path;
  const homeDir = options.homeDir || os.homedir();
  return uniqueDirs([
    pathApi.join(homeDir, ".clawd"),
    options.userDataDir,
  ], pathApi);
}

function getLogMtime(fsApi, filePath) {
  try {
    const stat = fsApi.statSync(filePath);
    if (!stat || (stat.isFile && !stat.isFile())) return null;
    return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
  } catch {
    return null;
  }
}

function resolveClawdLogTarget(options = {}) {
  const fsApi = options.fs || fs;
  const pathApi = options.path || path;
  const dirs = getAllowedLogDirs(options);
  const requested = typeof options.requested === "string" ? options.requested : "";
  const names = requested ? [requested] : DEFAULT_LOG_BASENAMES;
  const candidates = [];

  for (const name of names) {
    if (!isAllowedLogBasename(name, pathApi)) {
      return { status: "error", reason: "invalid-log-name" };
    }
    for (const dir of dirs) {
      const filePath = pathApi.resolve(pathApi.join(dir, name));
      const dirWithSep = dir.endsWith(pathApi.sep) ? dir : `${dir}${pathApi.sep}`;
      if (filePath !== dir && !filePath.startsWith(dirWithSep)) continue;
      const mtimeMs = getLogMtime(fsApi, filePath);
      if (Number.isFinite(mtimeMs)) candidates.push({ path: filePath, mtimeMs });
    }
  }

  if (candidates.length) {
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { status: "file", path: candidates[0].path };
  }

  const fallbackDir = dirs[0] || pathApi.join(os.homedir(), ".clawd");
  return { status: "directory", path: fallbackDir, reason: "no-log-found" };
}

async function openClawdLog(options = {}) {
  const fsApi = options.fs || fs;
  const shell = options.shell;
  if (!shell || typeof shell.openPath !== "function") {
    return { status: "error", reason: "shell-unavailable" };
  }
  const target = resolveClawdLogTarget(options);
  if (target.status === "error") return target;
  if (target.status === "directory") {
    try {
      fsApi.mkdirSync(target.path, { recursive: true });
    } catch {}
  }
  const message = await shell.openPath(target.path);
  if (message) return { status: "error", reason: "open-failed", message };
  return { status: "ok", opened: target.status, path: target.path };
}

module.exports = {
  DEFAULT_LOG_BASENAMES,
  getAllowedLogDirs,
  isAllowedLogBasename,
  openClawdLog,
  resolveClawdLogTarget,
};
