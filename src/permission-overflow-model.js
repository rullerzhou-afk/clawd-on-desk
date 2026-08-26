"use strict";

function entryOrdinal(entry) {
  return Number.isFinite(entry && entry.uiOrdinal) ? entry.uiOrdinal : Number.MAX_SAFE_INTEGER;
}

function sortByOrdinal(entries) {
  return [...entries].sort((a, b) => entryOrdinal(a) - entryOrdinal(b));
}

function getPermissionSessionKey(entry) {
  const agentId = String((entry && entry.agentId) || "claude-code");
  const sessionId = String((entry && entry.sessionId) || "");
  if (sessionId) return `${agentId}|${sessionId}`;
  return `${agentId}|entry:${String((entry && entry.uiEntryId) || entryOrdinal(entry))}`;
}

function groupPermissionEntries(entries) {
  const groups = new Map();
  for (const entry of sortByOrdinal(entries || [])) {
    const sessionKey = getPermissionSessionKey(entry);
    if (!groups.has(sessionKey)) groups.set(sessionKey, []);
    groups.get(sessionKey).push(entry);
  }
  return [...groups.entries()].map(([sessionKey, groupedEntries]) => ({
    sessionKey,
    entries: groupedEntries,
    firstOrdinal: entryOrdinal(groupedEntries[0]),
  }));
}

function selectOverflowRepresentatives(entries, options = {}) {
  const selectedBySession = options.selectedBySession instanceof Map
    ? options.selectedBySession
    : new Map();
  const selectedGlobalEntryId = options.selectedGlobalEntryId || null;
  const isProtected = typeof options.isProtected === "function"
    ? options.isProtected
    : (() => false);
  const canFit = typeof options.canFit === "function"
    ? options.canFit
    : (() => true);
  const groups = groupPermissionEntries(entries);

  const representatives = groups.map((group) => {
    const selectedId = selectedBySession.get(group.sessionKey);
    const selected = selectedId
      ? group.entries.find((entry) => entry.uiEntryId === selectedId)
      : null;
    return selected || group.entries[0];
  });

  // Protection is entry-level, not session-level. A session can temporarily
  // have more than one protected card (for example, an old explicit selection
  // plus a different request expanded after overflow exited). Never let the
  // preferred one-per-session representative hide either one.
  const protectedEntries = sortByOrdinal((entries || []).filter((entry) => (
    entry.uiEntryId === selectedGlobalEntryId || isProtected(entry)
  )));
  const chosen = [];
  const chosenIds = new Set();
  for (const entry of protectedEntries) {
    if (chosenIds.has(entry.uiEntryId)) continue;
    chosen.push(entry);
    chosenIds.add(entry.uiEntryId);
  }

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (group.entries.some((entry) => chosenIds.has(entry.uiEntryId))) continue;
    const entry = representatives[index];
    if (chosenIds.has(entry.uiEntryId)) continue;
    const candidate = [...chosen, entry];
    if (!canFit(candidate)) continue;
    chosen.push(entry);
    chosenIds.add(entry.uiEntryId);
  }

  // Entering overflow must actually hide something. If every session
  // representative fitted only because the normal stack was unsafe for a
  // different reason (for example an avoid rect), remove the newest
  // non-protected representative and let the launcher represent it.
  if (chosen.length === entries.length && chosen.length > 0) {
    for (let index = chosen.length - 1; index >= 0; index -= 1) {
      const entry = chosen[index];
      if (entry.uiEntryId === selectedGlobalEntryId || isProtected(entry)) continue;
      chosen.splice(index, 1);
      chosenIds.delete(entry.uiEntryId);
      break;
    }
  }

  const visibleEntries = sortByOrdinal(chosen);
  const hiddenEntries = sortByOrdinal((entries || []).filter((entry) => !chosenIds.has(entry.uiEntryId)));
  return { groups, visibleEntries, hiddenEntries };
}

module.exports = {
  getPermissionSessionKey,
  groupPermissionEntries,
  selectOverflowRepresentatives,
};
