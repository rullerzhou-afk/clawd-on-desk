"use strict";

const { loadActiveRecoveryLeases } = require("../hooks/session-recovery-lease");

function restoreSessionsFromRecoveryLeases(state, options = {}) {
  if (!state || typeof state.restoreSessionFromLease !== "function") return [];
  const leases = loadActiveRecoveryLeases(options);
  const restored = [];
  for (const lease of leases) {
    if (state.restoreSessionFromLease(lease)) restored.push(lease.sessionId);
  }
  return restored;
}

module.exports = {
  restoreSessionsFromRecoveryLeases,
};
