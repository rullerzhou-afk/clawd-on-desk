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

module.exports = {
  LOCAL_SESSION_PROFILE_ID,
  SESSION_KEY_VERSION,
  normalizeRawSessionId,
  isValidSessionProfileId,
  makeSessionKey,
  resolveSessionIdentity,
};
