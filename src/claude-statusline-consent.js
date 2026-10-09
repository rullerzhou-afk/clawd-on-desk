"use strict";

// Waiting for UI consent must not occupy the server's settings-file queue.
// The retry carries only a digest, never the third-party command, to bind the
// decision to the exact slot that was inspected before the dialog appeared.
async function setClaudeCollectionWithConsent(enabled, { setEnabled, confirm }) {
  const result = await setEnabled({ enabled });
  if (!enabled || result.reason !== "statusline-occupied"
    || !/^[a-f0-9]{64}$/.test(result.statuslineFingerprint || "")) return result;
  let accepted = false;
  try { accepted = await confirm(); } catch {}
  if (accepted !== true) return { status: "error", cancelled: true, message: "Claude usage collection was not enabled" };
  return setEnabled({
    enabled: true, chainExisting: true,
    expectedStatuslineFingerprint: result.statuslineFingerprint,
  });
}

module.exports = { setClaudeCollectionWithConsent };
