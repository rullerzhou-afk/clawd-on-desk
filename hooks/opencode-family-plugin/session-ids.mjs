// Session-id helpers for the opencode-family plugin core.
//
// Prefix classification (get this wrong and family child sessions break
// silently — see docs/project/agent-runtime-architecture.md):
//
//   prefix-INDEPENDENT — plain module exports below:
//     getEventSessionInfo, getEventSessionId, getEventParentSessionId,
//     shouldDropMappedEventWithoutSessionId
//
//   prefix-DEPENDENT — produced by createSessionIdHelpers(prefix):
//     DEFAULT_SESSION_ID, normalizeSessionId, resolveSessionId,
//     isChildSessionId
//
// The last two LOOK neutral but must normalize through the SAME prefix that
// wrote the parent-map keys: a mimocode child key "mimocode:ses_child" looked
// up via an opencode normalizer would miss forever — child never marked
// headless, child session.idle misroutes to Stop, and session.deleted deletes
// under the wrong prefix so the map leaks for the life of the process.

function normalizeSessionText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Bound + sanitize a session title before storage or transport. Mirrors the
// normalizeTitle in hooks/clawd-hook.js and src/state-session-snapshot.js:
// collapse control chars and whitespace, cap at 80 chars (with a trailing
// ellipsis). A 17k-char title would otherwise blow the 16 KiB /state body
// cap, trigger a headerless 413, and make the plugin distrust the response
// and rescan all five ports on every event (#841 review).
// Unicode bidi formatting marks can visually reorder otherwise-safe text even
// when the UI assigns it through textContent. Strip them at the plugin boundary
// together with ordinary controls so the stored/wire title is never ambiguous.
const SESSION_TITLE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u061C\u200E-\u200F\u202A-\u202E\u2066-\u2069]+/g;
const SESSION_TITLE_MAX = 80;

function replaceUnpairedSurrogates(value) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        result += value[index] + value[index + 1];
        index += 1;
      } else {
        result += "\uFFFD";
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      result += "\uFFFD";
    } else {
      result += value[index];
    }
  }
  return result;
}

function normalizeTitle(value) {
  if (typeof value !== "string") return null;
  const collapsed = replaceUnpairedSurrogates(value)
    .replace(SESSION_TITLE_CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return null;
  const characters = Array.from(collapsed);
  return characters.length > SESSION_TITLE_MAX
    ? `${characters.slice(0, SESSION_TITLE_MAX - 1).join("")}…`
    : collapsed;
}

export function getEventSessionInfo(event) {
  const empty = {
    eventSessionId: null,
    infoSessionId: null,
    directory: null,
    title: null,
  };
  if (!event || typeof event !== "object") return empty;
  const props = event.properties && typeof event.properties === "object"
    ? event.properties
    : {};
  const info = props.info && typeof props.info === "object" && !Array.isArray(props.info)
    ? props.info
    : {};
  // directory is intentionally left un-normalized: the upstream text is
  // authoritative and tests assert byte-identical passthrough.
  const directory = typeof info.directory === "string" && info.directory.trim()
    ? info.directory
    : null;
  const title = normalizeTitle(info.title);
  return {
    eventSessionId: normalizeSessionText(props.sessionID) || normalizeSessionText(event.sessionID),
    infoSessionId: normalizeSessionText(info.id),
    directory,
    title,
  };
}

export function getEventSessionId(event) {
  if (!event || typeof event !== "object") return null;
  const props = event.properties && typeof event.properties === "object"
    ? event.properties
    : {};
  const info = props.info && typeof props.info === "object" && !Array.isArray(props.info)
    ? props.info
    : {};
  // message.updated has two versioned shapes in the OpenCode SDK. In v1.1.25
  // the session identity is on the Message object as info.sessionID, while
  // info.id is the message identity. Keep this precedence local to the
  // message event so lifecycle events retain their existing info.id fallback.
  if (event.type === "message.updated") {
    return normalizeSessionText(props.sessionID)
      || normalizeSessionText(info.sessionID)
      || normalizeSessionText(event.sessionID);
  }
  return normalizeSessionText(props.sessionID)
    || normalizeSessionText(event.sessionID)
    || normalizeSessionText(info.id);
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

export function shouldDropMappedEventWithoutSessionId(event, mapped) {
  return mapped
    && mapped.event === "SessionEnd"
    && !getEventSessionId(event);
}

/**
 * Build the prefix-dependent helper set for one family member.
 *
 * @param {string} prefix  e.g. "opencode:" — must match the agent's registry
 *   entry (agents/opencode-family.js sessionIdPrefix)
 */
export function createSessionIdHelpers(prefix) {
  if (typeof prefix !== "string" || !prefix) {
    throw new Error("createSessionIdHelpers: prefix is required");
  }

  const DEFAULT_SESSION_ID = `${prefix}default`;

  function normalizeSessionId(value) {
    const raw = normalizeSessionText(value);
    if (!raw) return null;
    return raw.startsWith(prefix) ? raw : `${prefix}${raw}`;
  }

  function resolveSessionId(current, fallback) {
    return normalizeSessionId(current)
      || normalizeSessionId(fallback)
      || DEFAULT_SESSION_ID;
  }

  // Check whether a session ID is a child session by looking up the
  // session→parentId map. The map is maintained by the plugin's event handler
  // (populated on session.created, cleaned on session.deleted/disposed).
  // Both the map keys and the lookup sessionId are normalized via
  // normalizeSessionId() so raw ("ses_child") and prefixed
  // ("<prefix>ses_child") forms match consistently.
  function isChildSessionId(sessionId, sessionParentById) {
    if (!sessionId || !sessionParentById || typeof sessionParentById.has !== "function") {
      return false;
    }
    const normalized = normalizeSessionId(sessionId);
    if (!normalized) return false;
    return sessionParentById.has(normalized);
  }

  return {
    DEFAULT_SESSION_ID,
    normalizeSessionId,
    resolveSessionId,
    isChildSessionId,
  };
}
