"use strict";

const crypto = require("crypto");
const path = require("path");
const { sanitizeDisplayLabel } = require("./session-automation-store");

const MODE_OFF = "off";
const MODE_AUTO_TOOLS = "auto-tools";
const RESOLVED_PERMISSION_OPTIONS = Object.freeze({
  disposition: Object.freeze({ reason: "resolved", decided: true }),
});

function trustedIdentityFromEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const assessment = entry.sessionAutomationIdentity;
  const agentId = typeof entry.agentId === "string" ? entry.agentId.trim() : "";
  const sessionId = typeof entry.sessionId === "string" ? entry.sessionId.trim() : "";
  if (!agentId || !sessionId || !assessment || assessment.eligible !== true) return null;
  return { agentId, sessionId };
}

function trustedIdentityFromSession(sessionId, session) {
  const assessment = session && session.sessionAutomationIdentity;
  const agentId = session && typeof session.agentId === "string" ? session.agentId.trim() : "";
  const canonicalSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!agentId || !canonicalSessionId || !assessment || assessment.eligible !== true) return null;
  return { agentId, sessionId: canonicalSessionId };
}

function displayLabelFor(identity, source) {
  const title = source && typeof source.displayTitle === "string"
    ? source.displayTitle
    : (source && typeof source.sessionTitle === "string" ? source.sessionTitle : "");
  const cwd = source && typeof source.cwd === "string" ? source.cwd : "";
  return sanitizeDisplayLabel(title || (cwd ? path.basename(cwd) : "") || identity.sessionId.slice(-24));
}

function createSessionAutomationCoordinator(options = {}) {
  const store = options.store;
  if (!store) throw new Error("createSessionAutomationCoordinator requires store");
  const getSession = typeof options.getSession === "function" ? options.getSession : () => null;
  const listPending = typeof options.listPending === "function" ? options.listPending : () => [];
  const getGlobalMode = typeof options.getGlobalMode === "function" ? options.getGlobalMode : () => MODE_OFF;
  const canAutoResolve = typeof options.canAutoResolvePendingPermission === "function"
    ? options.canAutoResolvePendingPermission
    : () => false;
  const resolvePermissionEntry = typeof options.resolvePermissionEntry === "function"
    ? options.resolvePermissionEntry
    : () => {};
  const beginConfirmation = typeof options.beginConfirmation === "function"
    ? options.beginConfirmation
    : () => false;
  const endConfirmation = typeof options.endConfirmation === "function"
    ? options.endConfirmation
    : () => {};
  const restoreBubble = typeof options.restoreBubble === "function" ? options.restoreBubble : () => {};
  const isWarningDismissed = typeof options.isWarningDismissed === "function"
    ? options.isWarningDismissed
    : () => false;
  const showWarning = typeof options.showWarning === "function"
    ? options.showWarning
    : async () => ({ confirmed: false, suppressFutureConfirmation: false });
  const rememberWarning = typeof options.rememberWarning === "function"
    ? options.rememberWarning
    : () => {};
  const makeGrantId = typeof options.makeGrantId === "function"
    ? options.makeGrantId
    : () => crypto.randomUUID();
  const translate = typeof options.translate === "function"
    ? options.translate
    : (_key, fallback) => fallback;

  function tr(key, fallback) {
    const translated = translate(key, fallback);
    return typeof translated === "string" && translated ? translated : fallback;
  }

  function getRecordForEntry(entry) {
    const identity = trustedIdentityFromEntry(entry);
    return identity ? store.get(identity) : null;
  }

  function getEffectiveMode(entry, config = {}) {
    const record = getRecordForEntry(entry);
    if (record) return record.mode;
    if (config.sessionOnly === true) return MODE_OFF;
    const globalMode = getGlobalMode();
    return globalMode === MODE_AUTO_TOOLS || globalMode === "unattended"
      ? globalMode
      : MODE_OFF;
  }

  function canResolve(entry, config = {}) {
    const mode = config.mode || getEffectiveMode(entry, config);
    return canAutoResolve(entry, {
      sessionOnly: config.sessionOnly === true,
      mode,
    }) === true;
  }

  function canOfferSessionTrust(entry) {
    return canResolve(entry, { sessionOnly: true, mode: MODE_AUTO_TOOLS });
  }

  function resolveIfAllowed(entry, config = {}) {
    if (!canResolve(entry, config)) return false;
    resolvePermissionEntry(
      entry,
      "allow",
      "Allowed by session automation",
      RESOLVED_PERMISSION_OPTIONS
    );
    return true;
  }

  function sweep(identity) {
    if (!identity) return 0;
    let resolved = 0;
    const snapshot = [...listPending()];
    for (const entry of snapshot) {
      if (!entry || entry.trustConfirming === true) continue;
      if (entry.agentId !== identity.agentId || entry.sessionId !== identity.sessionId) continue;
      const sessionOnly = entry.remoteOnly === true;
      if (resolveIfAllowed(entry, { sessionOnly })) resolved += 1;
    }
    return resolved;
  }

  function cancelSessionTrustCandidate(entry, options = {}) {
    const candidate = entry && entry.sessionTrustCandidate;
    if (!candidate) return false;
    candidate.cancelled = true;
    const identity = trustedIdentityFromEntry(entry);
    const current = identity ? store.get(identity) : null;
    const preserveActive = options.preserveActive !== false;
    try {
      candidate.client.cancelSessionTrustCandidate(candidate.cardWork, {
        reason: options.reason || "cancelled",
        activeGrantId: preserveActive && current && current.mode === MODE_AUTO_TOOLS
          ? current.grantId
          : null,
      });
    } catch {}
    if (entry.sessionTrustCandidate === candidate) entry.sessionTrustCandidate = null;
    return true;
  }

  function restoreEntry(entry, reason) {
    if (!entry) return;
    entry.sessionTrustError = reason || null;
    endConfirmation(entry, { rearm: true });
    restoreBubble(entry);
  }

  function persistWarningPreference() {
    try {
      const result = rememberWarning();
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {}
  }

  function applyEntryGrant(entry, identity, expectedGrantId, suppressFutureConfirmation) {
    if (!canOfferSessionTrust(entry)) {
      restoreEntry(
        entry,
        tr(
          "sessionAutomationRequestUnavailable",
          "Session automation is no longer available for this request."
        )
      );
      return Object.freeze({ status: "unavailable" });
    }
    const result = store.compareAndSet(identity, MODE_AUTO_TOOLS, {
      expectedGrantId,
      nextGrantId: makeGrantId(),
      displayLabel: displayLabelFor(identity, getSession(identity.sessionId) || entry),
    });
    if (result.status === "applied") {
      entry.sessionTrustError = null;
      resolvePermissionEntry(
        entry,
        "allow",
        "Allowed and trusted for this session",
        RESOLVED_PERMISSION_OPTIONS
      );
      sweep(identity);
      if (suppressFutureConfirmation) persistWarningPreference();
      return result;
    }
    if (result.status === "equivalent" && canResolve(entry, { sessionOnly: true })) {
      entry.sessionTrustError = null;
      resolvePermissionEntry(
        entry,
        "allow",
        "Allowed by existing session automation",
        RESOLVED_PERMISSION_OPTIONS
      );
      if (suppressFutureConfirmation) persistWarningPreference();
      return result;
    }
    restoreEntry(
      entry,
      result.status === "full"
        ? tr(
            "sessionAutomationLimitReached",
            "Session automation limit reached. Revoke an old session override in Dashboard."
          )
        : tr(
            "sessionAutomationChangedRetry",
            "The session automation setting changed. Please try again."
          )
    );
    return result;
  }

  async function requestEntryTrust(entry) {
    const identity = trustedIdentityFromEntry(entry);
    if (!identity || !canOfferSessionTrust(entry)) {
      restoreEntry(
        entry,
        tr(
          "sessionAutomationRequestUnavailable",
          "Session automation is unavailable for this request."
        )
      );
      return Object.freeze({ status: "unavailable" });
    }
    const current = store.get(identity);
    if (current && current.mode === MODE_AUTO_TOOLS && canResolve(entry, { sessionOnly: true })) {
      resolvePermissionEntry(
        entry,
        "allow",
        "Allowed by existing session automation",
        RESOLVED_PERMISSION_OPTIONS
      );
      return Object.freeze({ status: "equivalent", record: current });
    }
    const expectedGrantId = current ? current.grantId : null;
    if (isWarningDismissed()) {
      return applyEntryGrant(entry, identity, expectedGrantId, false);
    }
    if (!beginConfirmation(entry)) {
      return Object.freeze({ status: "unavailable" });
    }
    let warningResult;
    try {
      warningResult = await showWarning(entry);
    } catch {
      warningResult = { confirmed: false, suppressFutureConfirmation: false };
    }
    endConfirmation(entry, { rearm: false });

    if (entry._sessionTrustLifecycleCancelled === true || !canOfferSessionTrust(entry)) {
      restoreEntry(
        entry,
        tr(
          "sessionAutomationRequestExpired",
          "This permission request is no longer active."
        )
      );
      return Object.freeze({ status: "unavailable" });
    }
    const latest = store.get(identity);
    if (latest && latest.mode === MODE_AUTO_TOOLS && canResolve(entry, { sessionOnly: true })) {
      resolvePermissionEntry(
        entry,
        "allow",
        "Allowed by sibling session automation",
        RESOLVED_PERMISSION_OPTIONS
      );
      return Object.freeze({ status: "equivalent", record: latest });
    }
    if (!warningResult || warningResult.confirmed !== true) {
      restoreEntry(entry, null);
      return Object.freeze({ status: "cancelled" });
    }
    return applyEntryGrant(
      entry,
      identity,
      expectedGrantId,
      warningResult.suppressFutureConfirmation === true
    );
  }

  async function requestRemoteSessionTrust(entry, remote = {}) {
    const identity = trustedIdentityFromEntry(entry);
    const client = remote.client;
    if (
      !identity
      || !canOfferSessionTrust(entry)
      || entry.sessionTrustCandidate
      || !client
      || typeof client.beginSessionTrustCandidate !== "function"
      || typeof client.prepareSessionTrustCandidate !== "function"
      || typeof client.activateSessionTrustCandidate !== "function"
      || typeof client.cancelSessionTrustCandidate !== "function"
    ) {
      return Object.freeze({ status: "unavailable" });
    }
    const current = store.get(identity);
    const expectedGrantId = current ? current.grantId : null;
    const candidateGrantId = current && current.mode === MODE_AUTO_TOOLS
      ? current.grantId
      : makeGrantId();
    const cardWork = client.beginSessionTrustCandidate({
      grantId: candidateGrantId,
      cardHandle: remote.cardHandle,
    });
    if (!cardWork) return Object.freeze({ status: "full" });
    const candidate = {
      grantId: candidateGrantId,
      expectedGrantId,
      cancelled: false,
      clientName: remote.clientName || "remote",
      cardHandle: remote.cardHandle,
      cardWork,
      client,
    };
    entry.sessionTrustCandidate = candidate;

    let prepared = false;
    try {
      prepared = await client.prepareSessionTrustCandidate(cardWork, {
        grantId: candidateGrantId,
      });
    } catch {
      prepared = false;
    }
    const stillCurrent = entry.sessionTrustCandidate === candidate;
    if (
      !prepared
      || !stillCurrent
      || candidate.cancelled
      || !canOfferSessionTrust(entry)
    ) {
      candidate.cancelled = true;
      if (stillCurrent) {
        client.cancelSessionTrustCandidate(cardWork, { reason: "pre-commit-cancelled" });
        entry.sessionTrustCandidate = null;
      }
      return Object.freeze({ status: prepared ? "unavailable" : "prepare-failed" });
    }

    const latest = store.get(identity);
    if (latest && latest.mode === MODE_AUTO_TOOLS && canResolve(entry, { sessionOnly: true })) {
      if (!client.activateSessionTrustCandidate(cardWork, { grantId: latest.grantId })) {
        candidate.cancelled = true;
        client.cancelSessionTrustCandidate(cardWork, { reason: "handoff-failed" });
        entry.sessionTrustCandidate = null;
        return Object.freeze({ status: "unavailable" });
      }
      entry.sessionTrustCandidate = null;
      entry.remoteApprovalResolution = {
        decision: "allow",
        actionLabel: "Allowed by existing session automation",
        source: remote.clientName || "remote",
        activeGrantId: latest.grantId,
      };
      entry.remoteApprovalSkipClientName = remote.clientName || "";
      resolvePermissionEntry(
        entry,
        "allow",
        "Allowed by existing session automation",
        RESOLVED_PERMISSION_OPTIONS
      );
      if (typeof client.renderActiveSessionTrust === "function") {
        client.renderActiveSessionTrust(cardWork, {
          grantId: latest.grantId,
          outcome: "already-active",
        });
      }
      return Object.freeze({ status: "equivalent", record: latest });
    }

    const result = store.compareAndSet(identity, MODE_AUTO_TOOLS, {
      expectedGrantId,
      nextGrantId: candidateGrantId,
      displayLabel: displayLabelFor(identity, getSession(identity.sessionId) || entry),
    });
    if (result.status !== "applied" && result.status !== "equivalent") {
      candidate.cancelled = true;
      client.cancelSessionTrustCandidate(cardWork, { reason: result.status });
      entry.sessionTrustCandidate = null;
      return result;
    }
    const activeGrantId = result.record && result.record.grantId;
    let activated = false;
    if (activeGrantId) {
      try {
        activated = client.activateSessionTrustCandidate(cardWork, {
          grantId: activeGrantId,
        }) === true;
      } catch {}
    }
    if (!activated) {
      // Never clear here: the record before CAS may have been an explicit off.
      // Clearing it could fall back to a broader global mode. A fresh off record
      // is the smallest fail-closed rollback and keeps the store API unchanged.
      if (result.status === "applied") {
        store.transitionGrant(activeGrantId, "remote-revoke");
      }
      candidate.cancelled = true;
      try {
        client.cancelSessionTrustCandidate(cardWork, { reason: "handoff-failed" });
      } catch {}
      entry.sessionTrustCandidate = null;
      return Object.freeze({ status: "unavailable" });
    }
    entry.sessionTrustCandidate = null;
    entry.remoteApprovalResolution = {
      decision: "allow",
      actionLabel: "Session automation enabled",
      source: remote.clientName || "remote",
      activeGrantId,
    };
    entry.remoteApprovalSkipClientName = remote.clientName || "";
    resolvePermissionEntry(
      entry,
      "allow",
      "Allowed and trusted for this session",
      RESOLVED_PERMISSION_OPTIONS
    );
    if (result.status === "applied") sweep(identity);
    if (typeof client.renderActiveSessionTrust === "function") {
      client.renderActiveSessionTrust(cardWork, {
        grantId: activeGrantId,
        outcome: result.status === "applied" ? "activated" : "already-active",
      });
    }
    return result;
  }

  async function setSessionAutomationOverride(payload, context = {}) {
    const sessionId = payload && typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
    const mode = payload && payload.mode;
    if (!sessionId || (mode !== MODE_OFF && mode !== MODE_AUTO_TOOLS)) {
      return Object.freeze({ status: "invalid" });
    }
    const session = getSession(sessionId);
    const identity = trustedIdentityFromSession(sessionId, session);
    if (!identity) return Object.freeze({ status: "unavailable" });
    const before = store.get(identity);
    const expectedGrantId = before ? before.grantId : null;
    let suppressFutureConfirmation = false;
    if (mode === MODE_AUTO_TOOLS && !isWarningDismissed()) {
      let warningResult;
      try {
        warningResult = await showWarning({
          warningParent: context && context.warningParent,
        });
      } catch {
        warningResult = { confirmed: false };
      }
      if (!warningResult || warningResult.confirmed !== true) {
        return Object.freeze({ status: "cancelled" });
      }
      suppressFutureConfirmation = warningResult.suppressFutureConfirmation === true;
    }
    const currentSession = getSession(sessionId);
    const currentIdentity = trustedIdentityFromSession(sessionId, currentSession);
    if (!currentIdentity || currentIdentity.agentId !== identity.agentId) {
      return Object.freeze({ status: "unavailable" });
    }
    const result = store.compareAndSet(currentIdentity, mode, {
      expectedGrantId,
      nextGrantId: makeGrantId(),
      displayLabel: displayLabelFor(currentIdentity, currentSession),
    });
    if (result.status === "applied" && mode === MODE_AUTO_TOOLS) sweep(currentIdentity);
    if ((result.status === "applied" || result.status === "equivalent") && suppressFutureConfirmation) {
      persistWarningPreference();
    }
    return result;
  }

  function clearSessionAutomationGrant(payload) {
    const grantId = payload && typeof payload.grantId === "string" ? payload.grantId.trim() : "";
    if (!grantId) return Object.freeze({ status: "invalid" });
    return store.transitionGrant(grantId, "clear");
  }

  function revokeRemoteGrant(payload) {
    const grantId = payload && typeof payload.grantId === "string" ? payload.grantId.trim() : "";
    if (!grantId) return Object.freeze({ status: "invalid" });
    const active = store.transitionGrant(grantId, "remote-revoke");
    let cancelledCandidate = false;
    for (const entry of [...listPending()]) {
      const candidate = entry && entry.sessionTrustCandidate;
      if (!candidate || candidate.grantId !== grantId || candidate.cancelled) continue;
      cancelSessionTrustCandidate(entry, {
        reason: "remote-revoke",
        preserveActive: false,
      });
      if (entry.sessionTrustCandidate === candidate) entry.sessionTrustCandidate = null;
      cancelledCandidate = true;
    }
    if (active.status === "applied") return active;
    if (cancelledCandidate) return Object.freeze({ status: "candidate-cancelled" });
    return active;
  }

  function onRemoteClientRouteChange(client) {
    if (!client || typeof client !== "object") return Object.freeze([]);
    for (const entry of [...listPending()]) {
      const candidate = entry && entry.sessionTrustCandidate;
      if (!candidate || candidate.client !== client) continue;
      cancelSessionTrustCandidate(entry, {
        reason: "route-changed",
        preserveActive: false,
      });
      if (entry.sessionTrustCandidate === candidate) entry.sessionTrustCandidate = null;
    }
    const grantIds = typeof client.listActiveSessionAutomationGrantIds === "function"
      ? [...client.listActiveSessionAutomationGrantIds()]
      : [];
    const results = [];
    for (const grantId of grantIds) {
      const result = store.transitionGrant(grantId, "remote-revoke");
      results.push(result);
      if (
        result.status !== "applied"
        && typeof client.retireSessionAutomationGrant === "function"
      ) {
        client.retireSessionAutomationGrant(grantId, { reason: "stale" });
      }
    }
    return Object.freeze(results);
  }

  function clearIdentity(identity, reason = "session-ended") {
    for (const entry of [...listPending()]) {
      if (!entry || entry.agentId !== identity.agentId || entry.sessionId !== identity.sessionId) continue;
      entry._sessionTrustLifecycleCancelled = true;
      if (entry.sessionTrustCandidate) {
        cancelSessionTrustCandidate(entry, { reason, preserveActive: false });
        entry.sessionTrustCandidate = null;
      }
    }
    return store.clearIdentity(identity, reason);
  }

  function clearAgent(agentId) {
    for (const entry of [...listPending()]) {
      if (!entry || entry.agentId !== agentId) continue;
      entry._sessionTrustLifecycleCancelled = true;
      if (entry.sessionTrustCandidate) {
        cancelSessionTrustCandidate(entry, { reason: "agent-cleared", preserveActive: false });
        entry.sessionTrustCandidate = null;
      }
    }
    return store.clearAgent(agentId);
  }

  function onSessionLifecycleEnd(payload) {
    if (!payload || typeof payload !== "object") return;
    const agentId = typeof payload.agentId === "string" ? payload.agentId.trim() : "";
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
    if (agentId && sessionId) clearIdentity({ agentId, sessionId }, payload.reason);
  }

  return Object.freeze({
    getEffectiveMode,
    canOfferSessionTrust,
    resolveIfAllowed,
    requestEntryTrust,
    requestRemoteSessionTrust,
    cancelSessionTrustCandidate,
    sweep,
    setSessionAutomationOverride,
    clearSessionAutomationGrant,
    revokeRemoteGrant,
    onRemoteClientRouteChange,
    clearIdentity,
    clearAgent,
    onSessionLifecycleEnd,
    getRecordForEntry,
  });
}

module.exports = {
  createSessionAutomationCoordinator,
  trustedIdentityFromEntry,
  trustedIdentityFromSession,
};
