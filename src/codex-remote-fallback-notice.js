"use strict";

const DEFAULT_DELAY_MS = 2_500;
const MAX_SESSIONS = 200;
const MAX_ITEMS_PER_SESSION = 20;
const MAX_ID_LENGTH = 256;

function normalizeText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= MAX_ID_LENGTH ? text : null;
}

function isUsableRawSessionId(rawSessionId) {
  const normalized = normalizeText(rawSessionId);
  if (!normalized) return false;
  const lowered = normalized.toLowerCase();
  return lowered !== "default" && !lowered.endsWith(":default");
}

function bubblePolicyEnabled(ctx, kind) {
  if (typeof ctx.getBubblePolicy === "function") {
    try {
      const policy = ctx.getBubblePolicy(kind);
      if (policy && typeof policy.enabled === "boolean") return policy.enabled;
    } catch {}
  }
  // Match permission.js's own getPolicy fallback when no reader is injected.
  return ctx.hideBubbles !== true;
}

// One decision point for the live manager, the card creation path and the
// refresh path. Unlike the legacy Codex/Kimi notify gate this also honors the
// global permission-bubble switch, because a remote fallback card is a
// permission cue even though it carries no decision channel.
function isCodexRemoteFallbackSuppressed(ctx) {
  if (!ctx || typeof ctx !== "object") return true;
  if (ctx.doNotDisturb === true) return true;
  if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled("codex")) return true;
  if (typeof ctx.isAgentPermissionsEnabled === "function"
    && !ctx.isAgentPermissionsEnabled("codex")) return true;
  return !bubblePolicyEnabled(ctx, "notification")
    || !bubblePolicyEnabled(ctx, "permission");
}

function normalizeRequest(payload) {
  if (!payload || typeof payload !== "object") return null;
  const sessionId = normalizeText(payload.sessionId);
  if (!sessionId || !isUsableRawSessionId(payload.rawSessionId)) return null;
  return {
    sessionId,
    rawSessionId: normalizeText(payload.rawSessionId),
    profileId: normalizeText(payload.profileId) || "local",
    host: normalizeText(payload.host),
    toolName: normalizeText(payload.toolName) || "Unknown",
    toolInput: payload.toolInput && typeof payload.toolInput === "object" ? payload.toolInput : {},
    turnId: normalizeText(payload.turnId),
    toolUseId: normalizeText(payload.toolUseId),
    toolInputFingerprint: normalizeText(payload.toolInputFingerprint),
  };
}

function displayPayload(item) {
  return {
    sessionId: item.sessionId,
    rawSessionId: item.rawSessionId,
    profileId: item.profileId,
    host: item.host,
    toolName: item.toolName,
    toolInput: item.toolInput,
  };
}

// Remote Codex requests that end up in Codex's native flow produce no Clawd
// surface. This owner waits a short grace period (the native approver often
// answers within it), then shows one dismiss-only card per session and removes
// the exact request that a later state event proves finished. It owns its
// timers so settings changes, DND and app shutdown can invalidate both queued
// and visible notices instead of leaving stale callbacks behind.
function createCodexRemoteFallbackNotice(options = {}) {
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const delayMs = Number.isFinite(options.delayMs) && options.delayMs >= 0
    ? options.delayMs
    : DEFAULT_DELAY_MS;
  const isSuppressed = options.isSuppressed || (() => false);
  const show = options.show || (() => null);
  const refresh = options.refresh || (() => true);
  const dismiss = options.dismiss || (() => {});
  const log = options.log || (() => {});

  const sessions = new Map();
  let nextItemId = 0;
  let disposed = false;

  function startState(item) {
    const state = {
      sessionId: item.sessionId,
      rawSessionId: item.rawSessionId,
      profileId: item.profileId,
      host: item.host,
      items: [item],
      timer: null,
      entry: null,
      displayItemId: null,
      retired: false,
    };
    sessions.set(item.sessionId, state);
    evictIfNeeded();
    return state;
  }

  function schedule(state) {
    if (!state.timer && !state.retired) {
      state.timer = setTimer(() => flush(state), delayMs);
    }
  }

  function retireState(state, reason, { cardAlreadyGone = false } = {}) {
    if (!state || state.retired) return false;
    state.retired = true;
    sessions.delete(state.sessionId);
    if (state.timer) {
      clearTimer(state.timer);
      state.timer = null;
    }
    const card = state.entry;
    const hadWork = !!card || state.items.length > 0;
    state.entry = null;
    state.displayItemId = null;
    state.items = [];
    // The card removal callback may fire during dismiss(); state.retired makes
    // that re-entry a no-op.
    if (!cardAlreadyGone && card) dismiss(card, reason);
    return hadWork;
  }

  function evictIfNeeded() {
    while (sessions.size > MAX_SESSIONS) {
      const oldestKey = sessions.keys().next().value;
      if (oldestKey === undefined) return;
      retireState(sessions.get(oldestKey), "capacity");
    }
  }

  // Returns true only when the original card accepted the update. A false
  // result means the card is gone; callers decide whether to retire old items
  // or start a fresh grace period. Never creates a card here.
  function refreshVisible(state, reason) {
    if (!state.entry) return false;
    if (isSuppressed()) {
      retireState(state, `${reason}:suppressed`);
      return false;
    }
    const latest = state.items[state.items.length - 1];
    if (!latest) {
      retireState(state, reason);
      return false;
    }
    let nextEntry;
    try {
      nextEntry = refresh(state.entry, displayPayload(latest));
    } catch (err) {
      log(`codex remote fallback refresh failed: ${err && err.message ? err.message : err}`);
      nextEntry = false;
    }
    if (nextEntry === false || nextEntry === null || nextEntry === undefined) {
      // Refresh returning false means the card is already gone. Forget the
      // references without asking the permission runtime to dismiss it again.
      state.entry = null;
      state.displayItemId = null;
      return false;
    }
    if (nextEntry !== true) state.entry = nextEntry;
    state.displayItemId = latest.itemId;
    return true;
  }

  function flush(state) {
    state.timer = null;
    if (disposed || sessions.get(state.sessionId) !== state) return;
    if (isSuppressed()) {
      retireState(state, "suppressed-before-show");
      return;
    }
    const latest = state.items[state.items.length - 1];
    if (!latest) {
      retireState(state, "empty");
      return;
    }
    let entry = null;
    try {
      entry = show(displayPayload(latest));
    } catch (err) {
      log(`codex remote fallback show failed: ${err && err.message ? err.message : err}`);
    }
    if (!entry) {
      retireState(state, "show-unavailable");
      return;
    }
    state.entry = entry;
    state.displayItemId = latest.itemId;
    log(`codex remote fallback shown: session=${state.sessionId} tool=${latest.toolName}`);
  }

  function notify(payload) {
    if (disposed) return false;
    const item = normalizeRequest(payload);
    if (!item) return false;
    if (isSuppressed()) {
      log("codex remote fallback suppressed at queue time");
      return false;
    }
    // Add the queue item id only after validation and suppression checks pass.
    const stored = { ...item, itemId: ++nextItemId };
    let state = sessions.get(stored.sessionId);
    if (state) {
      state.rawSessionId = stored.rawSessionId;
      state.profileId = stored.profileId;
      state.host = stored.host || state.host;
      if (stored.toolUseId) {
        state.items = state.items.filter((queued) => queued.toolUseId !== stored.toolUseId);
      }
      state.items.push(stored);
      while (state.items.length > MAX_ITEMS_PER_SESSION) state.items.shift();
    } else {
      state = startState(stored);
    }

    if (state.entry) {
      if (refreshVisible(state, "notify-refresh")) return true;
      // The old card was removed without its retirement callback reaching us.
      // Drop those stale requests, keep only this new one, and give it the
      // normal grace period instead of showing immediately.
      if (isSuppressed()) {
        retireState(state, "notify-refresh:suppressed", { cardAlreadyGone: true });
        return false;
      }
      retireState(state, "notify-refresh:retired", { cardAlreadyGone: true });
      state = startState(stored);
    }
    schedule(state);
    return true;
  }

  function removeItem(state, item) {
    const index = state.items.indexOf(item);
    if (index === -1) return false;
    state.items.splice(index, 1);
    return true;
  }

  function matchPostToolUse(state, payload) {
    const toolUseId = normalizeText(payload.toolUseId);
    if (toolUseId) {
      const exact = state.items.filter((item) => item.toolUseId === toolUseId);
      if (exact.length === 1) return exact[0];
      if (exact.length > 1) return null;
    }
    const toolName = normalizeText(payload.toolName);
    const fingerprint = normalizeText(payload.toolInputFingerprint);
    if (!toolName || !fingerprint) return null;
    const candidates = state.items.filter((item) => (
      item.toolName === toolName
      && item.toolInputFingerprint === fingerprint
      && (!toolUseId || !item.toolUseId)
    ));
    return candidates.length === 1 ? candidates[0] : null;
  }

  function handleStateEvent(payload) {
    if (disposed || !payload || typeof payload !== "object") return false;
    const sessionId = normalizeText(payload.sessionId);
    if (!sessionId) return false;
    const state = sessions.get(sessionId);
    if (!state) return false;
    const event = normalizeText(payload.event);

    if (event === "SessionEnd") {
      retireState(state, "session-end");
      return true;
    }

    let removed = null;
    if (event === "PostToolUse") {
      removed = matchPostToolUse(state, payload);
      if (!removed) return false;
      removeItem(state, removed);
    } else if (event === "Stop" || event === "Interrupt") {
      const turnId = normalizeText(payload.turnId);
      if (!turnId) return false;
      const before = state.items.length;
      state.items = state.items.filter((item) => item.turnId !== turnId);
      if (state.items.length === before) return false;
    } else if (event === "UserPromptSubmit") {
      // A new prompt starts a new turn; anything left from an older turn is
      // no longer awaiting a native decision. Requests without a turn id stay
      // until an exact event or the auto-close timer retires them.
      const turnId = normalizeText(payload.turnId);
      if (!turnId) return false;
      const before = state.items.length;
      state.items = state.items.filter((item) => !item.turnId || item.turnId === turnId);
      if (state.items.length === before) return false;
    } else {
      return false;
    }

    if (state.items.length === 0) {
      retireState(state, `${event.toLowerCase()}-complete`);
      return true;
    }
    if (state.entry && (removed === null || removed.itemId === state.displayItemId)) {
      if (!refreshVisible(state, `${event.toLowerCase()}-refresh`)) {
        retireState(state, `${event.toLowerCase()}-card-gone`, { cardAlreadyGone: true });
      }
    }
    return true;
  }

  // The permission runtime owns card dismissal (Got it, auto-close, window
  // failure, legacy clear). Once the card is gone this session must not keep
  // stale items; a new request starts a fresh 2.5-second grace period.
  function noteCardDismissed(sessionId, entry) {
    const state = sessions.get(normalizeText(sessionId) || "");
    if (!state || !state.entry) return false;
    if (entry && state.entry !== entry) return false;
    return retireState(state, "card-dismissed", { cardAlreadyGone: true });
  }

  function clearAll(reason = "clear-all") {
    let cleared = 0;
    for (const state of [...sessions.values()]) {
      if (retireState(state, reason)) cleared += 1;
    }
    return cleared;
  }

  function invalidateAll(reason = "invalidated") {
    // Settings invalidation and explicit clears both retire timers and cards.
    // Their callers have different intent, so the implementations may diverge later.
    return clearAll(reason);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearAll("dispose");
  }

  return {
    notify,
    handleStateEvent,
    noteCardDismissed,
    clearAll,
    invalidateAll,
    dispose,
  };
}

module.exports = createCodexRemoteFallbackNotice;
module.exports.DEFAULT_DELAY_MS = DEFAULT_DELAY_MS;
module.exports.isCodexRemoteFallbackSuppressed = isCodexRemoteFallbackSuppressed;
