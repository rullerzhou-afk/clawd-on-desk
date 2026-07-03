"use strict";

// Pure bucketing for the onboarding tutorial's step 2. Crosses the agent
// installation detector's results with the persisted `agents` prefs to sort
// every installable agent into one of three buckets:
//
//   active  — integration installed AND the agent is detected on the machine
//   cleanup — integration installed but the agent is NOT detected (stale hook;
//             covers the marquee "default Codex hook but no Codex" case)
//   install — integration NOT installed but the agent IS detected with high or
//             medium confidence (offer to connect it)
//
// Low-confidence detections are intentionally NOT offered for install — a bare
// parent directory isn't a strong enough signal to recommend writing a hook.
// Kept side-effect-free so it can be unit-tested without Electron or the fs.
function bucketAgentsForTutorial({ detectionAgents, agentsPref, installableIds } = {}) {
  const byId = new Map();
  for (const entry of detectionAgents || []) {
    if (entry && typeof entry.agentId === "string") byId.set(entry.agentId, entry);
  }
  const prefs = agentsPref && typeof agentsPref === "object" ? agentsPref : {};
  const buckets = { install: [], cleanup: [], active: [] };
  for (const agentId of installableIds || []) {
    const entry = byId.get(agentId);
    const item = { agentId, label: (entry && entry.agentName) || agentId };
    const integrationInstalled = !!(prefs[agentId] && prefs[agentId].integrationInstalled);
    const detected = !!(entry && entry.detectedInstalled);
    const confidence = entry && entry.confidence;
    if (integrationInstalled && detected) {
      buckets.active.push(item);
    } else if (integrationInstalled && !detected) {
      buckets.cleanup.push(item);
    } else if (!integrationInstalled && detected && (confidence === "high" || confidence === "medium")) {
      buckets.install.push(item);
    }
  }
  return buckets;
}

module.exports = { bucketAgentsForTutorial };
