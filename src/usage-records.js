"use strict";

// Persistence for the session-log usage feature:
//   ~/.clawd/usage-records.json  — { [requestId]: record }  (deduped, keyed)
//   ~/.clawd/usage-sync.json     — { files: { [path]: { mtime, offset } } }
// Keyed records give idempotent dedup (same message id -> same key, never
// double-counted); the sync file makes scans incremental (skip unchanged files,
// resume at the last line offset). Both are plain JSON with atomic writes.

const fsDefault = require("fs");
const os = require("os");
const path = require("path");

function recordsPath(homeDir) { return path.join(homeDir || os.homedir(), ".clawd", "usage-records.json"); }
function syncPath(homeDir) { return path.join(homeDir || os.homedir(), ".clawd", "usage-sync.json"); }

function loadJson(fs, p, fallback) {
  try {
    const v = JSON.parse(fs.readFileSync(p, "utf8"));
    return v && typeof v === "object" ? v : fallback;
  } catch { return fallback; }
}

function saveJson(fs, p, data) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
  fs.renameSync(tmp, p);
}

function loadRecords({ fs = fsDefault, homeDir = os.homedir() } = {}) {
  const v = loadJson(fs, recordsPath(homeDir), {});
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function saveRecords(records, { fs = fsDefault, homeDir = os.homedir() } = {}) {
  saveJson(fs, recordsPath(homeDir), records || {});
}

function loadSyncState({ fs = fsDefault, homeDir = os.homedir() } = {}) {
  const v = loadJson(fs, syncPath(homeDir), { files: {} });
  return v && v.files && typeof v.files === "object" && !Array.isArray(v.files) ? { files: v.files } : { files: {} };
}

function saveSyncState(state, { fs = fsDefault, homeDir = os.homedir() } = {}) {
  saveJson(fs, syncPath(homeDir), { files: (state && state.files) || {} });
}

module.exports = { loadRecords, saveRecords, loadSyncState, saveSyncState, recordsPath, syncPath };
