"use strict";

// Permission add/remove/resolve may finish without another lifecycle event.
// Coalesce the current facts after the permission owner's synchronous mutation.
module.exports = function createPermissionPresentationRefresh(options = {}) {
  const schedule = options.schedule || queueMicrotask;
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    schedule(() => {
      queued = false;
      if (options.isDisposed?.()) return;
      try {
        const state = options.getStateRuntime?.();
        if (typeof state?.refreshCodexPendingAttention === "function") state.refreshCodexPendingAttention();
        else state?.emitSessionSnapshot?.();
      } catch (error) {
        if (typeof options.onError === "function") options.onError(error);
        else console.warn("Clawd: permission presentation refresh failed:", error);
      }
    });
  };
};
