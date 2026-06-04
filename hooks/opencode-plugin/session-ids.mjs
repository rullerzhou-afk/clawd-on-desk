const SESSION_ID_PREFIX = "opencode:";

export const DEFAULT_SESSION_ID = `${SESSION_ID_PREFIX}default`;

function normalizeSessionText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeOpencodeSessionId(value) {
  const raw = normalizeSessionText(value);
  if (!raw) return null;
  return raw.startsWith(SESSION_ID_PREFIX) ? raw : `${SESSION_ID_PREFIX}${raw}`;
}

export function getEventSessionId(event) {
  if (!event || typeof event !== "object") return null;
  const props = event.properties && typeof event.properties === "object"
    ? event.properties
    : {};
  return normalizeSessionText(props.sessionID) || normalizeSessionText(event.sessionID);
}

export function resolveOpencodeSessionId(current, fallback) {
  return normalizeOpencodeSessionId(current)
    || normalizeOpencodeSessionId(fallback)
    || DEFAULT_SESSION_ID;
}

export function shouldDropMappedEventWithoutSessionId(event, mapped) {
  return mapped
    && mapped.event === "SessionEnd"
    && !getEventSessionId(event);
}

// Extract the parent session ID from a session.created event.
// opencode SDK ≥1.15.13: event.properties.info.parentID (Session.parentID).
// Returns null if absent (root session or older SDK).
export function getEventParentSessionId(event) {
  if (!event || typeof event !== "object") return null;
  const props = event.properties && typeof event.properties === "object"
    ? event.properties
    : {};
  const info = props.info && typeof props.info === "object" ? props.info : {};
  const parentID = info.parentID;
  return typeof parentID === "string" && parentID.trim() ? parentID.trim() : null;
}

// Check whether a session ID is a child session by looking up the
// session→parentId map. The map is maintained by the plugin's event handler
// (populated on session.created, cleaned on session.deleted/disposed).
// Both the map keys and the lookup sessionId are normalized via
// normalizeOpencodeSessionId() so raw ("ses_child") and prefixed
// ("opencode:ses_child") forms match consistently.
export function isChildSessionId(sessionId, sessionParentById) {
  if (!sessionId || !sessionParentById || typeof sessionParentById.has !== "function") {
    return false;
  }
  const normalized = normalizeOpencodeSessionId(sessionId);
  if (!normalized) return false;
  return sessionParentById.has(normalized);
}

// Clean up _sessionParentById on session end events so the Map doesn't grow
// unboundedly across sessions. Must be called BEFORE shouldDropMappedEventWithoutSessionId()
// because server.instance.disposed may lack a sessionID (causing early return) but
// still needs to clear the entire map — all sessions are gone.
//   - session.deleted: removes the single entry for that session (if present).
//   - server.instance.disposed: clears the entire map.
export function cleanupSessionParentMap(event, map) {
  if (!event || typeof event.type !== "string") return;
  if (!map || typeof map.clear !== "function") return;

  if (event.type === "server.instance.disposed") {
    map.clear();
    return;
  }

  if (event.type === "session.deleted") {
    const rawSid = getEventSessionId(event);
    const normSid = normalizeOpencodeSessionId(rawSid);
    if (normSid && map.has(normSid)) {
      map.delete(normSid);
    }
  }
}
