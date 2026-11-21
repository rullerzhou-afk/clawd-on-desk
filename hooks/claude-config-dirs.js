"use strict";

// Claude Code picks its config folder (settings, sessions, login) from
// CLAUDE_CONFIG_DIR, and people often run two side by side, for example
// ~/.claude and ~/.claude-work. Clawd always manages the folder it resolves
// itself (the "primary" one) and can also manage extra folders listed in
// prefs.agents["claude-code"].configDirs. Each entry is { dir, label }; an
// entry whose dir is the primary folder only carries that folder's label.
//
// Pure helpers only: no fs, no Electron, so hooks and the standalone cleanup
// can load it too. The hook side validates the env value
// with hooks/session-history.js normalizeClaudeProfile; the rules here match.

const os = require("os");
const path = require("path");

const MAX_CLAUDE_CONFIG_DIRS = 8;
const MAX_CLAUDE_CONFIG_DIR_LENGTH = 1024;
const MAX_CLAUDE_CONFIG_DIR_LABEL_LENGTH = 24;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function pathApiFor(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function currentPlatform(options) {
  return options && typeof options.platform === "string" ? options.platform : process.platform;
}

function normalizeClaudeConfigDir(value, options = {}) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CLAUDE_CONFIG_DIR_LENGTH || CONTROL_CHARS.test(trimmed)) return null;
  const pathApi = pathApiFor(currentPlatform(options));
  if (!pathApi.isAbsolute(trimmed)) return null;
  let normalized = pathApi.normalize(trimmed);
  const root = pathApi.parse(normalized).root;
  while (normalized.length > root.length && /[\\/]$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

// Folder comparison key. macOS and Windows default to case-insensitive file
// systems, so ~/.Claude-Work and ~/.claude-work are the same profile there.
function claudeConfigDirKey(dir, options = {}) {
  const normalized = normalizeClaudeConfigDir(dir, options);
  if (!normalized) return null;
  const platform = currentPlatform(options);
  return platform === "win32" || platform === "darwin" ? normalized.toLowerCase() : normalized;
}

function sameClaudeConfigDir(a, b, options = {}) {
  const left = claudeConfigDirKey(a, options);
  return !!left && left === claudeConfigDirKey(b, options);
}

function normalizeClaudeConfigDirLabel(value) {
  if (typeof value !== "string") return "";
  const collapsed = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(collapsed).slice(0, MAX_CLAUDE_CONFIG_DIR_LABEL_LENGTH).join("").trim();
}

function normalizeClaudeConfigDirEntries(value, options = {}) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const entry = typeof raw === "string" ? { dir: raw } : raw;
    if (!entry || typeof entry !== "object") continue;
    const dir = normalizeClaudeConfigDir(entry.dir, options);
    if (!dir) continue;
    const key = claudeConfigDirKey(dir, options);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ dir, label: normalizeClaudeConfigDirLabel(entry.label) });
    if (out.length >= MAX_CLAUDE_CONFIG_DIRS) break;
  }
  return out;
}

function defaultClaudeConfigDir(options = {}) {
  const homeDir = typeof options.homeDir === "string" && options.homeDir ? options.homeDir : os.homedir();
  return pathApiFor(currentPlatform(options)).join(homeDir, ".claude");
}

// The folder Clawd's own process would use: CLAUDE_CONFIG_DIR, else ~/.claude.
// Mirrors hooks/install.js resolveClaudeHome().
function resolvePrimaryClaudeConfigDir(options = {}) {
  const env = options.env || process.env;
  const fromEnv = env && typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
  return normalizeClaudeConfigDir(fromEnv, options)
    || normalizeClaudeConfigDir(defaultClaudeConfigDir(options), options)
    || defaultClaudeConfigDir(options);
}

// "~/.claude" -> "default", "~/.claude-work" -> "work", "~/.claude_personal"
// -> "personal", "/srv/claude/acme" -> "acme".
function deriveClaudeProfileLabel(dir, options = {}) {
  const normalized = normalizeClaudeConfigDir(dir, options);
  if (!normalized) return "";
  if (sameClaudeConfigDir(normalized, defaultClaudeConfigDir(options), options)) return "default";
  const base = pathApiFor(currentPlatform(options)).basename(normalized);
  const stripped = base.replace(/^\.?claude[-_.\s]+(?=\S)/i, "").replace(/^\./, "");
  return normalizeClaudeConfigDirLabel(stripped || base) || "default";
}

// Primary folder first, then the extra folders, each with its display label.
function effectiveClaudeConfigDirs(entries, options = {}) {
  const normalizedEntries = normalizeClaudeConfigDirEntries(entries, options);
  const primaryDir = normalizeClaudeConfigDir(options.primaryDir, options) || resolvePrimaryClaudeConfigDir(options);
  const primaryEntry = normalizedEntries.find((entry) => sameClaudeConfigDir(entry.dir, primaryDir, options));
  const out = [{
    dir: primaryDir,
    label: (primaryEntry && primaryEntry.label) || deriveClaudeProfileLabel(primaryDir, options),
    primary: true,
  }];
  for (const entry of normalizedEntries) {
    if (entry === primaryEntry) continue;
    out.push({ dir: entry.dir, label: entry.label || deriveClaudeProfileLabel(entry.dir, options), primary: false });
  }
  return out;
}

function extraClaudeConfigDirs(entries, options = {}) {
  return effectiveClaudeConfigDirs(entries, options).filter((entry) => !entry.primary).map((entry) => entry.dir);
}

// Label for a session's folder. A null/empty dir means the session ran
// without CLAUDE_CONFIG_DIR, i.e. in ~/.claude. Labels are only worth showing
// when Clawd manages more than one folder; otherwise "" (no chip).
function claudeProfileLabelFor(dir, effective, options = {}) {
  if (!Array.isArray(effective) || effective.length < 2) return "";
  const target = normalizeClaudeConfigDir(dir, options) || defaultClaudeConfigDir(options);
  const match = effective.find((entry) => sameClaudeConfigDir(entry.dir, target, options));
  return match ? match.label : deriveClaudeProfileLabel(target, options);
}

module.exports = {
  MAX_CLAUDE_CONFIG_DIRS,
  MAX_CLAUDE_CONFIG_DIR_LABEL_LENGTH,
  normalizeClaudeConfigDir,
  normalizeClaudeConfigDirLabel,
  normalizeClaudeConfigDirEntries,
  claudeConfigDirKey,
  sameClaudeConfigDir,
  defaultClaudeConfigDir,
  resolvePrimaryClaudeConfigDir,
  deriveClaudeProfileLabel,
  effectiveClaudeConfigDirs,
  extraClaudeConfigDirs,
  claudeProfileLabelFor,
};
