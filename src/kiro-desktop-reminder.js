"use strict";
const { getBubblePolicy } = require("./bubble-policy");

function isKiroDesktopReminderSuppressed(ctx) {
  return ctx.doNotDisturb === true
    || !(ctx.getBubblePolicy?.("notification") || getBubblePolicy(ctx, "notification")).enabled
    || !(ctx.getBubblePolicy?.("permission") || getBubblePolicy(ctx, "permission")).enabled
    || ctx.isAgentEnabled?.("kiro-desktop") !== true
    || ctx.isAgentPermissionsEnabled?.("kiro-desktop") !== true;
}

function createKiroDesktopReminder({ interactions, getContext, getPermissionRuntime }) {
  const dismissed = new Map();
  const visible = new Set();
  function remove(sessionId, reason) {
    visible.delete(sessionId);
    getPermissionRuntime()?.removeKiroDesktopReminder?.(sessionId, reason);
  }
  // Resolving the latest interaction can reveal an older pending one. Show
  // it again if the user has not dismissed that particular key.
  function sync(sessionId) {
    const latest = interactions.getLatest(sessionId);
    if (!latest) {
      dismissed.delete(sessionId);
      remove(sessionId, "resolved");
      return;
    }
    if (isKiroDesktopReminderSuppressed(getContext()) || dismissed.get(sessionId)?.has(latest.interactionKey)) {
      remove(sessionId, "suppressed");
      return;
    }
    const shown = getPermissionRuntime()?.showKiroDesktopReminder?.({
      sessionId, ...latest,
      onDismiss(entry, reason) {
        visible.delete(sessionId);
        // Both Go to Kiro and Got it dismiss this key across policy resyncs.
        if (reason !== "ipc-decide") return;
        const keys = dismissed.get(sessionId) || new Set();
        keys.add(entry.kiroInteractionKey);
        if (keys.size > 20) keys.delete(keys.values().next().value);
        dismissed.set(sessionId, keys);
      },
    });
    if (shown) visible.add(sessionId);
  }
  return {
    sync,
    clearCards(reason = "settings") { for (const id of [...visible]) remove(id, reason); },
  };
}
module.exports = { createKiroDesktopReminder, isKiroDesktopReminderSuppressed };
