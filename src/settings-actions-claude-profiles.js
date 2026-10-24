"use strict";

// Settings commands for extra Claude Code profiles. Each profile is a
// CLAUDE_CONFIG_DIR shown by its own pet process; main.js starts and stops
// those processes after the `claudeProfiles` key commits.

const fs = require("fs");
const { normalizeClaudeProfileDir } = require("../hooks/server-config");
const {
  MAX_CLAUDE_PROFILES,
  defaultLabelForConfigDir,
  normalizeClaudeProfiles,
  normalizeProfileId,
  normalizeProfileLabel,
  profileIdFromLabel,
} = require("./claude-profile-mode");

function currentProfiles(deps) {
  const snapshot = (deps && deps.snapshot) || {};
  return normalizeClaudeProfiles(snapshot.claudeProfiles);
}

function sameDir(a, b, platform) {
  if (!a || !b) return false;
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function defaultIsDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

// Update validator: the stored list must already be in normalized form.
function validateClaudeProfiles(value) {
  if (!Array.isArray(value) || value.length > MAX_CLAUDE_PROFILES) {
    return {
      status: "error",
      message: `claudeProfiles must be an array with at most ${MAX_CLAUDE_PROFILES} entries`,
    };
  }
  const normalized = normalizeClaudeProfiles(value);
  const allowedKeys = new Set(["id", "label", "configDir", "enabled"]);
  const isNormalized = normalized.length === value.length && normalized.every((entry, index) => {
    const original = value[index];
    return original
      && typeof original === "object"
      && !Array.isArray(original)
      && Object.keys(original).every((key) => allowedKeys.has(key))
      && Object.keys(entry).every((key) => entry[key] === original[key]);
  });
  return isNormalized
    ? { status: "ok" }
    : { status: "error", message: "claudeProfiles must contain normalized unique profile entries" };
}

function addClaudeProfile(payload, deps = {}) {
  if (deps.isProfileInstance === true) {
    return { status: "error", message: "Claude profiles are managed by the main Clawd pet" };
  }
  const platform = deps.platform || process.platform;
  const configDir = normalizeClaudeProfileDir(payload && payload.configDir, { platform });
  if (!configDir) {
    return { status: "error", message: "Choose an absolute Claude config folder" };
  }
  const isDirectory = deps.isDirectory || defaultIsDirectory;
  if (!isDirectory(configDir)) {
    return { status: "error", message: "That Claude config folder does not exist" };
  }
  const primaryDir = typeof deps.getPrimaryClaudeConfigDir === "function"
    ? normalizeClaudeProfileDir(deps.getPrimaryClaudeConfigDir(), { platform })
    : null;
  if (sameDir(configDir, primaryDir, platform)) {
    return { status: "error", message: "This folder is already shown by the main pet" };
  }
  const profiles = currentProfiles(deps);
  if (profiles.some((profile) => sameDir(profile.configDir, configDir, platform))) {
    return { status: "error", message: "This Claude profile is already added" };
  }
  if (profiles.length >= MAX_CLAUDE_PROFILES) {
    return { status: "error", message: `Claude profile limit reached (${MAX_CLAUDE_PROFILES})` };
  }
  const label = normalizeProfileLabel(payload && payload.label) || defaultLabelForConfigDir(configDir);
  const id = profileIdFromLabel(label, profiles.map((profile) => profile.id));
  if (!id) return { status: "error", message: "Could not name this Claude profile" };
  const profile = { id, label, configDir, enabled: true };
  return { status: "ok", profile, commit: { claudeProfiles: [...profiles, profile] } };
}

function updateClaudeProfile(payload, deps = {}) {
  const id = normalizeProfileId(payload && payload.id);
  if (!id) return { status: "error", message: "updateClaudeProfile requires a profile id" };
  const profiles = currentProfiles(deps);
  const index = profiles.findIndex((profile) => profile.id === id);
  if (index < 0) return { status: "error", message: "Unknown Claude profile" };
  const next = { ...profiles[index] };
  if (payload.label !== undefined) {
    const label = normalizeProfileLabel(payload.label);
    if (!label) return { status: "error", message: "Profile name cannot be empty" };
    next.label = label;
  }
  if (payload.enabled !== undefined) {
    if (typeof payload.enabled !== "boolean") {
      return { status: "error", message: "enabled must be a boolean" };
    }
    next.enabled = payload.enabled;
  }
  if (next.label === profiles[index].label && next.enabled === profiles[index].enabled) {
    return { status: "ok", noop: true };
  }
  const updated = profiles.slice();
  updated[index] = next;
  return { status: "ok", commit: { claudeProfiles: updated } };
}

function removeClaudeProfile(payload, deps = {}) {
  const id = normalizeProfileId(payload && payload.id);
  if (!id) return { status: "error", message: "removeClaudeProfile requires a profile id" };
  const profiles = currentProfiles(deps);
  if (!profiles.some((profile) => profile.id === id)) return { status: "ok", noop: true };
  return { status: "ok", commit: { claudeProfiles: profiles.filter((profile) => profile.id !== id) } };
}

module.exports = {
  addClaudeProfile,
  removeClaudeProfile,
  updateClaudeProfile,
  validateClaudeProfiles,
};
