"use strict";

const { randomUUID } = require("node:crypto");

function createFeishuApprovalLookupCoordinator(options = {}) {
  const createLookupId = typeof options.createLookupId === "function"
    ? options.createLookupId
    : randomUUID;
  let generation = 0;
  let current = null;
  let tombstone = null;

  function terminalCode(phase) {
    if (phase === "cancelled") return "lookup-cancelled";
    if (phase === "consumed") return "lookup-result-consumed";
    if (phase === "superseded") return "lookup-superseded";
    return "lookup-stale";
  }

  function clearApprover(record) {
    if (record) record.approverId = "";
  }

  function rememberCurrent(phase) {
    if (!current) return;
    clearApprover(current);
    tombstone = {
      lookupId: current.lookupId,
      platform: current.platform,
      appId: current.appId,
      secretsRevision: current.secretsRevision,
      phase,
    };
  }

  function matchesIdentity(record, identity, secretsRevision) {
    return !!record
      && record.platform === identity.platform
      && record.appId === identity.appId
      && record.secretsRevision === secretsRevision;
  }

  function begin({ requestId, identity, secretsRevision }) {
    if (current) {
      if (!current.abortController.signal.aborted) current.abortController.abort();
      rememberCurrent("superseded");
    }
    const abortController = new AbortController();
    current = {
      abortController,
      appId: identity.appId,
      approverId: "",
      generation: ++generation,
      lookupId: createLookupId(),
      phase: "pending",
      platform: identity.platform,
      requestId,
      secretsRevision,
    };
    return { status: "ok", lookupId: current.lookupId, signal: abortController.signal };
  }

  function succeed({ lookupId, approverId }) {
    if (current && current.lookupId === lookupId) {
      if (current.phase !== "pending") {
        return { status: "error", code: terminalCode(current.phase) };
      }
      current.approverId = typeof approverId === "string" ? approverId.trim() : "";
      if (!current.approverId) {
        rememberCurrent("stale");
        current = null;
        return { status: "error", code: "lookup-stale" };
      }
      current.phase = "ready";
      return { status: "ok", lookupId };
    }
    if (tombstone && tombstone.lookupId === lookupId) {
      return { status: "error", code: terminalCode(tombstone.phase) };
    }
    return { status: "error", code: "lookup-stale" };
  }

  function fail({ lookupId } = {}) {
    if (current && current.lookupId === lookupId) {
      if (current.phase !== "pending") {
        return { status: "error", code: terminalCode(current.phase) };
      }
      rememberCurrent("stale");
      current = null;
      return { status: "ok", code: "lookup-failed" };
    }
    if (tombstone && tombstone.lookupId === lookupId) {
      return { status: "error", code: terminalCode(tombstone.phase) };
    }
    return { status: "error", code: "lookup-stale" };
  }

  function cancel({ requestId }) {
    if (current && current.requestId === requestId) {
      if (current.phase === "consumed") {
        return { status: "ok", code: "lookup-result-consumed" };
      }
      if (current.phase === "cancelled") {
        return { status: "ok", code: "lookup-cancelled" };
      }
      if (!current.abortController.signal.aborted) current.abortController.abort();
      clearApprover(current);
      current.phase = "cancelled";
      return { status: "ok", code: "lookup-cancelled" };
    }
    return { status: "error", code: "lookup-stale" };
  }

  function consume({ lookupId, identity, secretsRevision }) {
    const record = current && current.lookupId === lookupId
      ? current
      : tombstone && tombstone.lookupId === lookupId
        ? tombstone
        : null;
    if (!record) return { status: "error", code: "lookup-stale" };
    if (!matchesIdentity(record, identity, secretsRevision)) {
      return { status: "error", code: "lookup-credentials-changed" };
    }
    if (record !== current || current.phase !== "ready") {
      return { status: "error", code: terminalCode(record.phase) };
    }
    const approverId = current.approverId;
    clearApprover(current);
    current.phase = "consumed";
    return { status: "ok", approverId };
  }

  function inspect() {
    return {
      current: current
        ? { keys: Object.keys(current), hasApproverId: !!current.approverId }
        : null,
      tombstone: tombstone
        ? { phase: tombstone.phase, generationRetained: true }
        : null,
    };
  }

  return { begin, succeed, fail, cancel, consume, inspect };
}

module.exports = { createFeishuApprovalLookupCoordinator };
