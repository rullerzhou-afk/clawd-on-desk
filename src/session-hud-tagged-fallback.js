"use strict";

(function exposeSessionHudTaggedFallback(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ClawdSessionHudTaggedFallback = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildSessionHudTaggedFallback() {
  // Same predicate the renderer uses for the "<label> · <tag>" fallback row:
  // only an untitled local Codex Desktop chat renders the distinguishing tag.
  // A generic per-session displaySessionTag (the Telegram/Slack-style #tag
  // every session carries) must NOT widen every HUD window, so the width
  // bump and the rendered row must agree on this one predicate.
  function taggedFallbackTag(session) {
    const tag = session && session.displaySessionTag;
    if (!session || session.agentId !== "codex" || session.hasAlias || session.sessionTitle
      || typeof tag !== "string" || !/^[0-9a-f]{10}$/.test(tag)) return "";
    return typeof session.displayTitle === "string"
      && session.displayTitle !== session.displayFolder
      && session.displayTitle.endsWith(` · ${tag}`) ? tag : "";
  }

  function hasTaggedFallbackRow(sessions) {
    return (Array.isArray(sessions) ? sessions : []).some((session) => !!taggedFallbackTag(session));
  }

  return { taggedFallbackTag, hasTaggedFallbackRow };
});
