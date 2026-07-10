"use strict";

// Single source of truth for "is the official Codex hook actually live?".
//
// As of the JSONL-approval-heuristic removal, Codex approval awareness flows
// ONLY through the official PermissionRequest hook. If that hook silently fails
// to register (or [features].hooks=false, or it needs Codex /hooks review), the
// user gets NO approval signal at all. This module surfaces that health so the
// Agents-tab badge and the startup nudge agree with the Doctor modal — they all
// reuse the same per-agent integration check (checkAgentIntegrations on just the
// Codex descriptor), so there is one verdict, not three drifting ones.

const { checkAgentIntegrations } = require("./doctor-detectors/agent-integrations");
const { getAgentDescriptors } = require("./doctor-detectors/agent-descriptors");

// Map a doctor integration `detail` to a compact, render-safe verdict.
//
// `signature` is a stable token naming the KIND of breakage. It is the dedup
// key for the startup nudge (edge-triggered: notify only when the signature
// changes, reset when healthy). `null` means "no warning" — healthy, or Codex
// itself is not installed so there is nothing to nag about.
function classifyCodexHookDetail(detail) {
  if (!detail || typeof detail !== "object") {
    return { signature: null, reasonKey: null, status: "unknown" };
  }
  const status = detail.status;

  // Codex (or its config dir) is absent / host-managed — not a fault we own.
  if (
    status === "not-installed"
    || status === "not-managed"
    || status === "disabled"
    || status === "manual-only"
    || status === "manual-managed"
  ) {
    return { signature: null, reasonKey: null, status };
  }
  if (status === "ok") {
    return { signature: null, reasonKey: null, status };
  }

  const supplementary = detail.supplementary && typeof detail.supplementary === "object"
    ? detail.supplementary
    : null;
  // Hook is registered in hooks.json but [features].hooks=false, so Codex will
  // never run it. applyCodexSupplementary maps this to not-connected + a
  // supplementary {key:"hooks", value:"disabled"} — check it before the bare
  // not-connected case so we can tell "feature off" from "not registered".
  if (supplementary && supplementary.key === "hooks" && supplementary.value === "disabled") {
    return { signature: "feature-disabled", reasonKey: "codexHookHealthReasonDisabled", status };
  }

  const trust = detail.codexHookTrust && typeof detail.codexHookTrust === "object"
    ? detail.codexHookTrust
    : null;
  if (status === "needs-review" || (trust && trust.value === "needs-review")) {
    return { signature: "needs-review", reasonKey: "codexHookHealthReasonNeedsReview", status };
  }
  // Remaining breakages (not registered / broken script path / any other non-ok
  // status) share one user-facing message — "the hook isn't active, repair it" —
  // but keep distinct signatures so a transition between them re-nudges.
  if (status === "not-connected") {
    return { signature: "not-registered", reasonKey: "codexHookHealthReasonInactive", status };
  }
  if (status === "broken-path") {
    return { signature: "broken-path", reasonKey: "codexHookHealthReasonInactive", status };
  }
  return { signature: String(status || "unknown"), reasonKey: "codexHookHealthReasonInactive", status };
}

// Probe the Codex hook health. Pure-ish: fs/platform/prefs/descriptors are all
// injectable for tests. Never throws — a health probe must not crash startup or
// a settings render, so any failure degrades to a "healthy/unknown" verdict.
function getCodexHookHealth(options = {}) {
  const descriptors = options.descriptors || getAgentDescriptors();
  const codexDescriptor = Array.isArray(descriptors)
    ? descriptors.find((d) => d && d.agentId === "codex")
    : null;
  if (!codexDescriptor) {
    return makeVerdict({ available: false, status: "no-descriptor" });
  }
  let detail;
  try {
    const result = checkAgentIntegrations({
      descriptors: [codexDescriptor],
      fs: options.fs,
      platform: options.platform,
      prefs: options.prefs,
    });
    detail = result && Array.isArray(result.details) ? result.details[0] : null;
  } catch (err) {
    return makeVerdict({ available: false, status: "probe-error", error: err && err.message });
  }
  const classified = classifyCodexHookDetail(detail);
  return makeVerdict({
    available: true,
    status: classified.status,
    signature: classified.signature,
    reasonKey: classified.reasonKey,
    detailText: detail && typeof detail.detail === "string" ? detail.detail : "",
    fixAction: detail && detail.fixAction ? detail.fixAction : null,
  });
}

function makeVerdict({ available, status, signature = null, reasonKey = null, detailText = "", fixAction = null, error = null }) {
  return {
    available: available !== false,
    healthy: !signature,
    signature: signature || null,
    reasonKey: reasonKey || null,
    status: status || "unknown",
    detailText: detailText || "",
    fixAction: fixAction || null,
    error: error || null,
  };
}

// Edge-triggered dedup for the startup nudge. Pure — no Electron, no fs.
//   healthy / not-applicable → clear the remembered signature so a future break
//                              is treated as a fresh edge and notifies again
//   new break (signature changed) → notify once, remember it
//   same break already notified  → stay silent (no per-launch nagging)
//   Codex disabled / notify off  → never notify AND keep the prior signature,
//                                  so re-enabling later still fires exactly once
function decideCodexHookNotification(verdict, prevSignature, opts = {}) {
  const codexEnabled = opts.codexEnabled !== false;
  const notifyEnabled = opts.notifyEnabled !== false;
  const prev = typeof prevSignature === "string" ? prevSignature : "";
  const current = verdict && verdict.signature ? String(verdict.signature) : "";

  if (!current) {
    // Healthy / not-applicable: always re-arm for the next genuine breakage.
    return { shouldNotify: false, nextSignature: "", changed: prev !== "" };
  }
  if (!codexEnabled || !notifyEnabled) {
    return { shouldNotify: false, nextSignature: prev, changed: false };
  }
  if (current === prev) {
    return { shouldNotify: false, nextSignature: prev, changed: false };
  }
  return { shouldNotify: true, nextSignature: current, changed: true };
}

module.exports = {
  getCodexHookHealth,
  classifyCodexHookDetail,
  decideCodexHookNotification,
};
