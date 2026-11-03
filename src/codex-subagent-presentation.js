"use strict";

const { normalizeDelegatedThread } = require("../agents/codex-delegated-child");
const { normalizeCodexTurnId } = require("./codex-turn-id");
const { CODEX_LOCAL_WORKING_STALE_FLOOR_MS: TTL } = require("./state-stale-cleanup");

// Only objects built from admitted child activity may bypass process dedupe in
// visual selection. This identity cannot arrive through JSON/session metadata
// and does not change the canonical session or its focus eligibility.
const verifiedChildProjections = new WeakSet();

function isLocalParent(session) {
  return session && session.agentId === "codex" && !session.headless
    && session.state !== "sleeping" && !session.host && !session.wslDistro
    && String(session.platform || "").trim().toLowerCase() !== "wsl"
    && (!session.profileId || session.profileId === "local");
}

// Presentation evidence lives outside sessions: child progress must not rewrite
// the parent's real phase, clock, plan, permissions, process identity or recap.
function createCodexSubagentPresentation(sessions, now = Date.now) {
  const parents = new Map();
  // Admission outlives an activity timeout but never the parent lifecycle. A
  // later fenced real event can recover a quiet child without reviving one
  // whose parent was dismissed/ended or whose own turn already completed.
  const admitted = new Map();
  const endedParents = new Set();
  let expirationChanged = false;
  function prune() {
    let changed = false;
    for (const [id, children] of parents) {
      for (const [childId, child] of children) {
        if (!isLocalParent(sessions.get(id)) || now() - child.at > TTL) {
          children.delete(childId); changed = true;
        }
      }
      if (!children.size) parents.delete(id);
    }
    for (const id of admitted.keys()) if (!isLocalParent(sessions.get(id))) admitted.delete(id);
    expirationChanged ||= changed;
    return changed;
  }
  function update(parentId, input = {}) {
    prune();
    const childId = normalizeDelegatedThread(input.childId);
    const turnId = normalizeCodexTurnId(input.turnId);
    if (endedParents.has(parentId) || !isLocalParent(sessions.get(parentId)) || !childId || !turnId || parentId === childId
      || !Number.isSafeInteger(input.occurredAt) || input.occurredAt > now() + 1500) return false;
    const children = parents.get(parentId);
    const previous = children && children.get(childId);
    const known = admitted.get(parentId);
    if (input.phase === "stop") {
      if (known?.get(childId) !== turnId) return false;
      known.delete(childId);
      if (!known.size) admitted.delete(parentId);
      if (!previous || previous.turnId !== turnId) return false;
      children.delete(childId);
      if (!children.size) parents.delete(parentId);
      return true;
    }
    if (!["start", "activity"].includes(input.phase) || now() - input.occurredAt > TTL) return false;
    // Progress may recover an admitted, timed-out child, never resurrect one
    // after parent dismissal or SessionEnd. A new fenced start admits a turn.
    if (input.phase === "activity" && known?.get(childId) !== turnId) return false;
    if (previous && input.occurredAt < previous.at) return false;
    if (!known && admitted.size >= 200) return false;
    if (!known?.has(childId) && known?.size >= 200) return false;
    const membership = known || new Map();
    membership.set(childId, turnId);
    admitted.set(parentId, membership);
    const target = children || new Map();
    if (!previous && target.size >= 200) return false;
    target.set(childId, { turnId, at: input.occurredAt });
    parents.set(parentId, target);
    return !previous || previous.turnId !== turnId || previous.at !== input.occurredAt;
  }
  function lastActivity(id) {
    const children = parents.get(id);
    if (!children) return null;
    let at = 0;
    for (const child of children.values()) at = Math.max(at, child.at);
    return at;
  }
  function project(pendingAttentionIds = new Set()) {
    prune();
    if (!parents.size && !pendingAttentionIds.size) return sessions;
    const projected = new Map(sessions);
    for (const id of new Set([...parents.keys(), ...pendingAttentionIds])) {
      const parent = sessions.get(id);
      if (!isLocalParent(parent)) continue;
      const children = parents.get(id);
      const preserveStrongState = ["notification", "sweeping", "error"].includes(parent.state);
      if (preserveStrongState && !children?.size) continue;
      const presentation = { ...parent,
        state: preserveStrongState ? parent.state : pendingAttentionIds.has(id) ? "notification" : "juggling",
        displayHint: preserveStrongState ? parent.displayHint : null,
        ...(children ? { subagentTracker: { confirmedIds: new Set(children.keys()), legacyFloor: false, recoveredFloor: false } } : {}) };
      if (children?.size) verifiedChildProjections.add(presentation);
      projected.set(id, presentation);
    }
    return projected;
  }
  return { update, prune, project, lastActivity,
    consumeExpirationChange: () => { const changed = expirationChanged; expirationChanged = false; return changed; },
    count: id => parents.get(id)?.size || 0,
    has: id => { prune(); return !!parents.get(id)?.size; },
    hasAny: () => { prune(); return parents.size > 0; },
    end: id => {
      const changed = parents.has(id);
      admitted.delete(id); parents.delete(id); endedParents.add(id);
      while (endedParents.size > 200) endedParents.delete(endedParents.values().next().value);
      return changed;
    },
    resume: id => endedParents.delete(id),
    endChild: rawId => {
      const childId = normalizeDelegatedThread(rawId);
      if (!childId) return false;
      let changed = false;
      for (const [parentId, membership] of admitted) {
        membership.delete(childId);
        if (!membership.size) admitted.delete(parentId);
        const children = parents.get(parentId);
        if (children?.delete(childId)) changed = true;
        if (children && !children.size) parents.delete(parentId);
      }
      return changed;
    },
    resetActivity: () => { admitted.clear(); parents.clear(); expirationChanged = false; },
    delete: id => { admitted.delete(id); return parents.delete(id); },
    clear: () => { admitted.clear(); parents.clear(); endedParents.clear(); expirationChanged = false; } };
}

module.exports = createCodexSubagentPresentation;
module.exports.isVerifiedChildProjection = session => verifiedChildProjections.has(session);
