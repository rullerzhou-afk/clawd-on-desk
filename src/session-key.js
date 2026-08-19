"use strict";

const LOCAL_SESSION_PROFILE_ID = "local";
const SESSION_KEY_VERSION = "s1";
const PROFILE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function normalizeRawSessionId(value, fallback = "default") {
  if (value === null || value === undefined) return fallback;
  const raw = String(value).trim();
  return raw || fallback;
}

function isValidSessionProfileId(value) {
  return value === LOCAL_SESSION_PROFILE_ID
    || (typeof value === "string" && PROFILE_ID_RE.test(value));
}

function encodePart(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function makeSessionKey({ profileId = LOCAL_SESSION_PROFILE_ID, rawSessionId } = {}) {
  if (!isValidSessionProfileId(profileId)) {
    throw new TypeError("profileId must be local or 1-64 chars [a-zA-Z0-9_-]");
  }
  const raw = normalizeRawSessionId(rawSessionId);
  // Encode local and remote identities through the same versioned envelope.
  // Leaving local IDs raw would let a local sender choose a value identical to
  // a remote canonical key (for example "s1.<profile>.<raw>").
  return `${SESSION_KEY_VERSION}.${encodePart(profileId)}.${encodePart(raw)}`;
}

function resolveSessionIdentity(rawSessionId, profileId = LOCAL_SESSION_PROFILE_ID, fallback = "default") {
  const raw = normalizeRawSessionId(rawSessionId, fallback);
  return Object.freeze({
    profileId,
    rawSessionId: raw,
    sessionId: makeSessionKey({ profileId, rawSessionId: raw }),
  });
}

// Display helpers can be handed the envelope instead of the raw id: a session
// created without an explicit rawSessionId falls back to its own key
// (state.js `(existing && existing.rawSessionId) || rawSessionId || sessionId`).
// Shortening the envelope renders the same few characters for every session on
// a profile, so recover the raw id first. The round-trip check keeps this from
// mangling a raw id that merely looks like a key.
function decodeSessionKey(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== SESSION_KEY_VERSION) return null;
  try {
    const profileId = Buffer.from(parts[1], "base64url").toString("utf8");
    const rawSessionId = Buffer.from(parts[2], "base64url").toString("utf8");
    if (!profileId || !rawSessionId) return null;
    if (makeSessionKey({ profileId, rawSessionId }) !== value) return null;
    return { profileId, rawSessionId };
  } catch {
    return null;
  }
}

module.exports = {
  decodeSessionKey,
  LOCAL_SESSION_PROFILE_ID,
  SESSION_KEY_VERSION,
  normalizeRawSessionId,
  isValidSessionProfileId,
  makeSessionKey,
  resolveSessionIdentity,
};
