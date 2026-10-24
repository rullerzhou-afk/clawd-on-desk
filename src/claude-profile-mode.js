"use strict";

// Claude profile instances.
//
// The primary Clawd manages the default Claude config directory. Each extra
// Claude profile (a different CLAUDE_CONFIG_DIR) runs as its own Clawd process
// with its own pet, prefs, port and runtime file. The primary launches those
// processes with the arguments built here; the child recognises them at the
// very top of main.js, before anything reads userData or CLAUDE_CONFIG_DIR.

const path = require("path");
const {
  claudeProfileRuntimeConfigPath,
  normalizeClaudeProfileDir,
} = require("../hooks/server-config");
const { getRecoveryDirForRuntimeConfig } = require("../hooks/session-recovery-lease");

const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_PROFILE_LABEL_LENGTH = 40;
// Five shared server ports: the primary plus up to three profiles leaves one
// port of headroom for a dev build running beside an installed one.
const MAX_CLAUDE_PROFILES = 3;
const PROFILE_MODE_THEME_ID = "clawd-work";

const ARG_ID = "--clawd-profile-id=";
const ARG_DIR = "--clawd-profile-dir=";
const ARG_LABEL = "--clawd-profile-label=";
const ARG_SLOT = "--clawd-profile-slot=";

function normalizeProfileId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return PROFILE_ID_RE.test(id) ? id : null;
}

function normalizeProfileLabel(value) {
  if (typeof value !== "string") return null;
  const label = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!label) return null;
  return label.length > MAX_PROFILE_LABEL_LENGTH ? label.slice(0, MAX_PROFILE_LABEL_LENGTH) : label;
}

function normalizeProfileSlot(value) {
  const slot = Number(value);
  return Number.isInteger(slot) && slot >= 1 && slot <= MAX_CLAUDE_PROFILES ? slot : 1;
}

// Derive a stable id from a label so Settings never asks for one.
function profileIdFromLabel(label, existingIds = []) {
  const taken = new Set(existingIds);
  const base = (typeof label === "string" ? label : "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "profile";
  const safeBase = PROFILE_ID_RE.test(base) ? base : "profile";
  if (!taken.has(safeBase)) return safeBase;
  for (let n = 2; n < 100; n++) {
    const candidate = `${safeBase}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

function defaultLabelForConfigDir(configDir) {
  const base = path.basename(configDir || "").replace(/^\.claude[-_.]?/i, "");
  return normalizeProfileLabel(base) || "Work";
}

// Persisted shape: [{ id, label, configDir, enabled }]. Invalid rows, duplicate
// ids and duplicate directories are dropped; the list is capped by the port pool.
function normalizeClaudeProfiles(value, options = {}) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const ids = new Set();
  const dirs = new Set();
  const platform = options.platform || process.platform;
  for (const entry of value) {
    if (out.length >= MAX_CLAUDE_PROFILES) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const id = normalizeProfileId(entry.id);
    const configDir = normalizeClaudeProfileDir(entry.configDir, options);
    if (!id || !configDir || ids.has(id)) continue;
    const dirKey = platform === "win32" ? configDir.toLowerCase() : configDir;
    if (dirs.has(dirKey)) continue;
    ids.add(id);
    dirs.add(dirKey);
    out.push({
      id,
      label: normalizeProfileLabel(entry.label) || id,
      configDir,
      enabled: entry.enabled !== false,
    });
  }
  return out;
}

// Returns { mode: null } when no profile arguments are present,
// { mode, error: null } for a valid child, or { mode: null, error } when the
// arguments are present but unusable. A broken child must not fall back to
// running as a second primary.
function parseProfileModeArgs(argv, options = {}) {
  const args = Array.isArray(argv) ? argv : [];
  const read = (prefix) => {
    const hit = args.find((arg) => typeof arg === "string" && arg.startsWith(prefix));
    return hit === undefined ? undefined : hit.slice(prefix.length);
  };
  const rawId = read(ARG_ID);
  const rawDir = read(ARG_DIR);
  if (rawId === undefined && rawDir === undefined) return { mode: null, error: null };
  const id = normalizeProfileId(rawId);
  if (!id) return { mode: null, error: "invalid profile id" };
  const configDir = normalizeClaudeProfileDir(rawDir, options);
  if (!configDir) return { mode: null, error: "invalid profile config dir" };
  const label = normalizeProfileLabel(read(ARG_LABEL)) || id;
  const slot = normalizeProfileSlot(read(ARG_SLOT));
  return { mode: Object.freeze({ id, configDir, label, slot }), error: null };
}

function buildProfileModeArgs(profile, slot = 1) {
  return [
    `${ARG_ID}${profile.id}`,
    `${ARG_DIR}${profile.configDir}`,
    `${ARG_LABEL}${profile.label}`,
    `${ARG_SLOT}${normalizeProfileSlot(slot)}`,
  ];
}

// Every per-instance location a profile child uses. userData sits under the
// primary's so uninstalling Clawd removes it; shared ~/.clawd state lives under
// the runtime file's directory, which is also where the hooks look.
function resolveProfilePaths(mode, options = {}) {
  const runtimeConfigPath = claudeProfileRuntimeConfigPath(mode.configDir, options);
  const stateDir = path.dirname(runtimeConfigPath);
  return Object.freeze({
    userDataDir: path.join(options.primaryUserDataDir, "profiles", mode.id),
    runtimeConfigPath,
    stateDir,
    recoveryDir: getRecoveryDirForRuntimeConfig(runtimeConfigPath),
    accountQuotaPersistPath: path.join(stateDir, "account-quota.json"),
    recapRoot: path.join(stateDir, "recap-v1"),
  });
}

// First-run prefs for a profile child: the work avatar, and only the Claude
// Code integration. Codex and every other agent stay with the primary pet.
function applyProfileModeDefaults(snapshot) {
  const out = { ...snapshot, theme: PROFILE_MODE_THEME_ID };
  const agents = {};
  for (const [agentId, entry] of Object.entries(snapshot.agents || {})) {
    agents[agentId] = agentId === "claude-code"
      ? { ...entry }
      : { ...entry, integrationInstalled: false, enabled: false };
  }
  out.agents = agents;
  out.autoStartWithClaude = false;
  out.autoStartWithCodex = false;
  // Login items belong to the app, not to one pet; the primary owns them.
  out.openAtLogin = false;
  out.openAtLoginHydrated = true;
  // The primary pet already showed the tutorial.
  out.tutorialSeen = true;
  return out;
}

module.exports = {
  MAX_CLAUDE_PROFILES,
  MAX_PROFILE_LABEL_LENGTH,
  PROFILE_MODE_THEME_ID,
  applyProfileModeDefaults,
  buildProfileModeArgs,
  defaultLabelForConfigDir,
  normalizeClaudeProfiles,
  normalizeProfileId,
  normalizeProfileLabel,
  parseProfileModeArgs,
  profileIdFromLabel,
  resolveProfilePaths,
};
