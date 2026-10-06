"use strict";

const { DEFAULT_INTEGRATION_INSTALLED_IDS } = require("./prefs");

// Pure bucketing for the onboarding tutorial's step 2. Crosses the agent
// installation detector's results with the persisted `agents` prefs to sort
// every installable agent into one of three buckets:
//
//   active  — integration installed AND the agent is detected on the machine
//   cleanup — integration installed but the detector explicitly reported the
//             agent as missing, AND the agent is not a default integration
//   install — integration NOT installed but the agent IS detected with high or
//             medium confidence (offer to connect it)
//
// Low-confidence detections are intentionally NOT offered for install — a bare
// parent directory isn't a strong enough signal to recommend writing a hook.
// The bucketer performs no I/O and has no side effects at call time; its only
// dependency is the pure-data default list from prefs.js.
// The icon resolver is injected by the main process so this module does not
// need to know how bundled assets are located.
//
// #895: cleanup carries two guards, because getting it wrong tells a user with
// a working agent to disconnect it.
//   1. Default integrations (claude-code, codex) are exempt. Their parent dirs
//      are unreliable evidence — Clawd's own Claude sync creates ~/.claude —
//      and `docs/plans/plan-agent-install-detection-prompts.md` already ruled
//      that cleanup prompts must skip them, referencing the prefs list rather
//      than hardcoding ids. Settings satisfied that rule only by accident (it
//      never detects them at all); the tutorial did not, so a user who had
//      installed Codex via npm without launching it once — leaving no ~/.codex
//      — was told their Codex hook was stale.
//   2. A missing detector entry means "not checked", never "checked and
//      absent". Only an explicit detectedInstalled === false can propose
//      cleanup, so a detector that threw (main.js falls back to {agents: []})
//      or that skipped an agent proposes nothing.
const CLEANUP_EXEMPT_AGENT_IDS = new Set(DEFAULT_INTEGRATION_INSTALLED_IDS);

function resolveIconUrl(iconUrlFor, agentId) {
  if (typeof iconUrlFor !== "function") return null;
  try {
    const value = iconUrlFor(agentId);
    return typeof value === "string" && value.length ? value : null;
  } catch (_) {
    return null;
  }
}

function bucketAgentsForTutorial({
  detectionAgents,
  agentsPref,
  installableIds,
  getAgentIconUrl: iconUrlFor,
} = {}) {
  const byId = new Map();
  for (const entry of detectionAgents || []) {
    if (entry && typeof entry.agentId === "string") byId.set(entry.agentId, entry);
  }
  const prefs = agentsPref && typeof agentsPref === "object" ? agentsPref : {};
  const buckets = { install: [], cleanup: [], active: [] };
  for (const agentId of installableIds || []) {
    const entry = byId.get(agentId);
    const item = {
      agentId,
      label: (entry && entry.agentName) || agentId,
      iconUrl: resolveIconUrl(iconUrlFor, agentId),
    };
    const integrationInstalled = !!(prefs[agentId] && prefs[agentId].integrationInstalled);
    const detected = !!(entry && entry.detectedInstalled);
    const confidence = entry && entry.confidence;
    // Strict false, not "falsy": an absent entry or an absent field is unknown.
    const explicitlyMissing = !!entry && entry.detectedInstalled === false;
    const cleanupExempt = CLEANUP_EXEMPT_AGENT_IDS.has(agentId);
    if (integrationInstalled && detected) {
      buckets.active.push(item);
    } else if (integrationInstalled && explicitlyMissing && !cleanupExempt) {
      buckets.cleanup.push(item);
    } else if (!integrationInstalled && detected && (confidence === "high" || confidence === "medium")) {
      buckets.install.push(item);
    }
  }
  return buckets;
}

module.exports = { bucketAgentsForTutorial };
