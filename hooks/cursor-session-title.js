// Resolve a human session title for Cursor Agent hooks.
// Cursor does not send session_title on stdin; the chat name lives in
// %APPDATA%/Cursor/User/globalStorage/state.vscdb → composerHeaders.name.
// Without this, Clawd falls back to path.basename(cwd) (e.g. "siga-horas").

const fs = require("fs");
const path = require("path");
const os = require("os");

const SESSION_TITLE_MAX = 60;
const PROMPT_TITLE_MAX = 48;
const PROMPT_TITLE_SECRET_RE =
  /(api[_-]?key|secret|token|password|passwd|bearer\s+[a-z0-9._\-]+)/i;

function normalizeTitle(value, maxLen = SESSION_TITLE_MAX) {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > maxLen
    ? `${collapsed.slice(0, maxLen - 1)}\u2026`
    : collapsed;
}

function extractPromptTitle(prompt) {
  if (typeof prompt !== "string") return null;
  for (const line of prompt.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate) continue;
    if (PROMPT_TITLE_SECRET_RE.test(candidate)) return null;
    return normalizeTitle(candidate, PROMPT_TITLE_MAX);
  }
  return null;
}

function composerHeadersDbPath(env = process.env) {
  const appData =
    env.APPDATA ||
    (env.HOME ? path.join(env.HOME, "AppData", "Roaming") : null) ||
    path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
}

/**
 * @param {string} composerId conversation_id / session_id from Cursor hooks
 * @param {{ dbPath?: string, openDatabase?: (dbPath: string) => { prepare: Function, close?: Function } }} [options]
 */
function readComposerSessionTitle(composerId, options = {}) {
  if (typeof composerId !== "string" || !composerId || composerId === "default") return null;
  const dbPath = options.dbPath || composerHeadersDbPath();
  try {
    if (!fs.existsSync(dbPath)) return null;
    const openDatabase =
      options.openDatabase ||
      ((filePath) => {
        const { DatabaseSync } = require("node:sqlite");
        return new DatabaseSync(filePath, { readOnly: true });
      });
    const db = openDatabase(dbPath);
    try {
      const row = db.prepare("SELECT value FROM composerHeaders WHERE composerId = ?").get(composerId);
      if (!row || typeof row.value !== "string") return null;
      const parsed = JSON.parse(row.value);
      return normalizeTitle(parsed && parsed.name);
    } finally {
      try {
        if (db && typeof db.close === "function") db.close();
      } catch {}
    }
  } catch {
    return null;
  }
}

function resolveSessionTitle(payload, hookName, options = {}) {
  const composerId =
    (payload && (payload.conversation_id || payload.session_id)) || "";
  return (
    readComposerSessionTitle(composerId, options) ||
    (hookName === "beforeSubmitPrompt" ? extractPromptTitle(payload && payload.prompt) : null)
  );
}

module.exports = {
  SESSION_TITLE_MAX,
  PROMPT_TITLE_MAX,
  normalizeTitle,
  extractPromptTitle,
  composerHeadersDbPath,
  readComposerSessionTitle,
  resolveSessionTitle,
};
