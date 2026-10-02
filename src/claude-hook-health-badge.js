"use strict";

// Render-safe badge verdict for "is the managed Claude hook actually healthy?".
//
// Unlike Codex (src/codex-hook-health.js), Claude already has a long-lived
// health supervisor: claude-settings-watcher.js maintains a live status
// (healthy / repairing / guarded / manual-fix-required / degraded) and the
// server exposes it as getClaudeHookHealthStatus(). Rather than re-run a
// separate probe — which would drift from the supervisor the Doctor reads —
// this module maps that one status into the same compact verdict shape the
// Agents-tab badge already consumes for Codex, so both surfaces agree.
//
// Only the states that mean "Clawd stopped keeping the hook healthy and the
// user must act" raise a warning (#898):
//   - manual-fix-required: automatic repair exhausted its attempts.
//   - guarded: a suspicious settings.json shrink paused auto-repair to avoid
//     clobbering third-party hooks; the hook may be broken until the user acts.
//   - degraded/source-script-missing: the source hook script is gone, so no
//     repair can succeed.
// Transient/benign states (healthy, stopped, repairing, and other degraded
// reasons that self-heal such as a temporarily unreadable file) stay silent —
// the badge keeps its base "Installed" text.

const CLAUDE_HOOK_BADGE_SIGNATURES = Object.freeze({
  "manual-fix-required": Object.freeze({
    signature: "manual-fix-required",
    reasonKey: "claudeHookHealthReasonManualFix",
  }),
  guarded: Object.freeze({
    signature: "guarded",
    reasonKey: "claudeHookHealthReasonGuarded",
  }),
});

// A stable token naming the KIND of breakage, or null when there is nothing to
// warn about. Callers treat a null signature as "healthy — leave the badge
// alone"; a non-null one flips the badge to its warning state.
function classifyClaudeHookHealthStatus(healthStatus) {
  if (!healthStatus || typeof healthStatus !== "object") {
    return makeVerdict({ available: false, status: "unknown" });
  }
  const status = typeof healthStatus.status === "string" ? healthStatus.status : "unknown";
  const degradedReason = typeof healthStatus.degradedReason === "string"
    ? healthStatus.degradedReason
    : null;

  const direct = CLAUDE_HOOK_BADGE_SIGNATURES[status];
  if (direct) {
    return makeVerdict({ available: true, status, signature: direct.signature, reasonKey: direct.reasonKey });
  }
  // The source hook script is gone, so no automatic repair can succeed — the
  // one degraded reason that is a real, user-actionable breakage rather than a
  // transient (unreadable file, resolver hiccup) that the next patrol clears.
  if (status === "degraded" && degradedReason === "source-script-missing") {
    return makeVerdict({
      available: true,
      status,
      signature: "source-missing",
      reasonKey: "claudeHookHealthReasonSourceMissing",
    });
  }
  return makeVerdict({ available: true, status });
}

function makeVerdict({ available, status, signature = null, reasonKey = null }) {
  return {
    available: available !== false,
    healthy: !signature,
    signature: signature || null,
    reasonKey: reasonKey || null,
    status: status || "unknown",
  };
}

module.exports = {
  classifyClaudeHookHealthStatus,
  CLAUDE_HOOK_BADGE_SIGNATURES,
};
