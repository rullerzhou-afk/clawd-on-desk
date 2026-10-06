// Optional, read-only Cursor desktop chat titles. Older Node versions and
// absent/locked/unknown Cursor databases fall back to a safe prompt title.
const fs = require("fs");
const path = require("path");
const os = require("os");

const SESSION_TITLE_MAX = 80;
const PROMPT_TITLE_MAX = 40;
const MAX_DB_VALUE_LENGTH = 1024 * 1024;
// Same prompt-title policy as clawd-hook.js / traecode-hook.js. Inspect the
// full first line before truncating, so a secret after the cut is not hidden.
const PROMPT_TITLE_SECRET_RE =
  /\b(api[_-]?key|authorization|bearer|password|passwd|private[_-]?key|secret|token)\b|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|[A-Za-z0-9+/=_-]{32,}/i;

function normalizeTitle(value, maxLen = SESSION_TITLE_MAX) {
  if (typeof value !== "string") return null;
  const title = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (!title) return null;
  return title.length > maxLen ? `${title.slice(0, maxLen - 1)}…` : title;
}

function extractPromptTitle(prompt) {
  if (typeof prompt !== "string") return null;
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim());
  if (!firstLine || PROMPT_TITLE_SECRET_RE.test(firstLine)) return null;
  return normalizeTitle(firstLine, PROMPT_TITLE_MAX);
}

function composerHeadersDbPath(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.homeDir || os.homedir();
  const p = platform === "win32" ? path.win32 : path.posix;
  let configDir;
  if (platform === "win32") {
    configDir = (env.APPDATA || "").trim() || p.join(home, "AppData", "Roaming");
  } else if (platform === "darwin") {
    configDir = p.join(home, "Library", "Application Support");
  } else if (platform === "linux") {
    const xdg = (env.XDG_CONFIG_HOME || "").trim();
    configDir = p.isAbsolute(xdg) ? xdg : p.join(home, ".config");
  } else {
    return null;
  }
  return p.join(configDir, "Cursor", "User", "globalStorage", "state.vscdb");
}

function readJsonRow(db, sql, key) {
  try {
    const row = db.prepare(sql).get(key, MAX_DB_VALUE_LENGTH);
    if (!row) return null;
    const value = typeof row.value === "string" ? row.value
      : ArrayBuffer.isView(row.value) ? Buffer.from(row.value.buffer, row.value.byteOffset, row.value.byteLength).toString("utf8")
      : null;
    return value ? JSON.parse(value) : null;
  } catch {
    // Each supported layout is independent; a missing table or malformed row
    // must not hide a usable title in a different layout.
    return null;
  }
}

function loadSqlite() {
  // Cursor treats any stderr as a hook error, even with exit 0 and valid
  // stdout. Silence only Node's known SQLite notice during this synchronous
  // optional import; preserve every other warning and restore the handler.
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning, type, ...args) {
    if (type === "ExperimentalWarning"
      && warning === "SQLite is an experimental feature and might change at any time") return;
    return emitWarning.call(this, warning, type, ...args);
  };
  try {
    return require("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
}

function readComposerSessionTitle(composerId, options = {}) {
  if (typeof composerId !== "string" || !composerId || composerId === "default") return null;
  const dbPath = options.dbPath || composerHeadersDbPath(options);
  let db;
  try {
    if (!dbPath || !fs.existsSync(dbPath)) return null;
    const openDatabase = options.openDatabase || ((filePath) => {
      // Optional: unflagged since Node 22.13 / 23.4. On the project's Node
      // 22.12 floor this throws and prompt fallback remains available.
      const { DatabaseSync } = loadSqlite();
      return new DatabaseSync(filePath, { readOnly: true });
    });
    db = openDatabase(dbPath);
    const header = readJsonRow(db,
      "SELECT value FROM composerHeaders WHERE composerId = ? AND length(CAST(value AS BLOB)) <= ?", composerId);
    const title = normalizeTitle(header && header.name);
    if (title) return title;

    // Before Cursor migrated headers to their own table they lived in one
    // ItemTable value. Some older installs only have composerData records.
    const headers = readJsonRow(db,
      "SELECT value FROM ItemTable WHERE key = ? AND length(CAST(value AS BLOB)) <= ?", "composer.composerHeaders");
    const legacyHeader = Array.isArray(headers && headers.allComposers)
      ? headers.allComposers.find((entry) => entry && entry.composerId === composerId)
      : null;
    const legacyTitle = normalizeTitle(legacyHeader && legacyHeader.name);
    if (legacyTitle) return legacyTitle;
    const composer = readJsonRow(db,
      "SELECT value FROM cursorDiskKV WHERE key = ? AND length(CAST(value AS BLOB)) <= ?", `composerData:${composerId}`);
    return normalizeTitle(composer && composer.name);
  } catch {
    return null;
  } finally {
    try { if (db) db.close(); } catch { /* optional metadata must not break a hook */ }
  }
}

function resolveSessionTitle(payload, hookName, options = {}) {
  const composerId = payload && (payload.conversation_id || payload.session_id);
  const title = options.readDatabase === false ? null : readComposerSessionTitle(composerId, options);
  return title || (hookName === "beforeSubmitPrompt" ? extractPromptTitle(payload && payload.prompt) : null);
}

module.exports = {
  SESSION_TITLE_MAX,
  PROMPT_TITLE_MAX,
  MAX_DB_VALUE_LENGTH,
  normalizeTitle,
  extractPromptTitle,
  composerHeadersDbPath,
  readComposerSessionTitle,
  resolveSessionTitle,
};
