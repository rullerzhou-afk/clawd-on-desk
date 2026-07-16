"use strict";

// Non-secret config: the Application ID is a public ID (not a token), stored in
// clawd-prefs.json. Privacy fields default off.

// Official "Clawd on Desk" Discord application (public ID, not a secret) —
// the zero-friction default from #215. Users can still bring their own App ID
// in Settings; a saved ID always wins over this default.
const DEFAULT_CLAWD_DISCORD_APP_ID = "1525141423328854179";

const DEFAULT_DISCORD_PRESENCE = Object.freeze({
  enabled: false,
  applicationId: "",
  // Only opt-in. Payload is a strict allowlist (see buildPresencePayload).
  privacyShowProject: false,
});

const APP_ID_RE = /^[0-9]{17,20}$/;

function cloneDefaultDiscordPresence() {
  return { ...DEFAULT_DISCORD_PRESENCE };
}

function normalizeDiscordPresence(value) {
  const base = cloneDefaultDiscordPresence();
  if (!value || typeof value !== "object") return base;
  base.enabled = value.enabled === true;
  base.applicationId =
    typeof value.applicationId === "string"
      ? value.applicationId.trim().replace(/[^0-9]/g, "").slice(0, 32)
      : "";
  base.privacyShowProject = value.privacyShowProject === true;
  return base;
}

function validateDiscordPresence(value) {
  const next = normalizeDiscordPresence(value);
  // Empty is allowed (not configured yet).
  if (next.applicationId && !APP_ID_RE.test(next.applicationId)) {
    return { status: "error", message: "Discord Application ID must be a 17-20 digit snowflake" };
  }
  return { status: "ok" };
}

// Mirrors telegram-approval-settings.readiness(). defaultAppId is injectable so
// the BYO handoff path can be tested while the shipped constant is still empty.
function readiness(config, defaultAppId = DEFAULT_CLAWD_DISCORD_APP_ID) {
  const cfg = normalizeDiscordPresence(config);
  const appId = cfg.applicationId || defaultAppId;
  if (!cfg.enabled) return { ready: false, reason: "disabled", config: cfg };
  if (!appId) return { ready: false, reason: "no-app-id", config: cfg };
  return { ready: true, appId, config: cfg };
}

module.exports = {
  DEFAULT_DISCORD_PRESENCE,
  DEFAULT_CLAWD_DISCORD_APP_ID,
  APP_ID_RE,
  cloneDefaultDiscordPresence,
  normalizeDiscordPresence,
  validateDiscordPresence,
  readiness,
};
