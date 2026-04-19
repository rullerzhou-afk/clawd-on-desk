"use strict";

function createSettingsSizePreviewSession({
  beginProtection,
  endProtection,
  applyPreview,
  commitFinal,
}) {
  const startProtection = typeof beginProtection === "function" ? beginProtection : async () => {};
  const stopProtection = typeof endProtection === "function" ? endProtection : async () => {};
  const runPreview = typeof applyPreview === "function" ? applyPreview : async () => {};
  const runCommit = typeof commitFinal === "function" ? commitFinal : async () => ({ status: "ok" });

  let protectionActive = false;
  let beginPromise = null;
  let previewLoopPromise = null;
  let queuedPreview = null;
  let endPromise = null;

  async function begin() {
    if (protectionActive) return { status: "ok", noop: true };
    if (beginPromise) return beginPromise;
    beginPromise = Promise.resolve(startProtection()).then(() => {
      protectionActive = true;
      return { status: "ok" };
    }).finally(() => {
      beginPromise = null;
    });
    return beginPromise;
  }

  function runPreviewLoop() {
    if (previewLoopPromise) return previewLoopPromise;
    previewLoopPromise = (async () => {
      while (queuedPreview !== null) {
        const next = queuedPreview;
        queuedPreview = null;
        await runPreview(next);
      }
    })().finally(() => {
      previewLoopPromise = null;
    });
    return previewLoopPromise;
  }

  async function preview(sizeKey) {
    await begin();
    queuedPreview = sizeKey;
    return runPreviewLoop();
  }

  async function end(finalSizeKey = null) {
    if (endPromise) return endPromise;
    const hadProtection = protectionActive || !!beginPromise;
    if (!hadProtection && !previewLoopPromise && queuedPreview === null && !finalSizeKey) {
      return { status: "ok", noop: true };
    }
    endPromise = (async () => {
      if (previewLoopPromise || queuedPreview !== null) {
        await runPreviewLoop();
      }
      const commitResult = finalSizeKey ? await runCommit(finalSizeKey) : { status: "ok" };
      return commitResult || { status: "ok" };
    })().finally(async () => {
      queuedPreview = null;
      const shouldRestore = protectionActive || hadProtection;
      protectionActive = false;
      if (shouldRestore) {
        await stopProtection();
      }
      endPromise = null;
    });
    return endPromise;
  }

  return {
    begin,
    preview,
    end,
    cleanup() {
      return end(null);
    },
  };
}

module.exports = {
  createSettingsSizePreviewSession,
};
