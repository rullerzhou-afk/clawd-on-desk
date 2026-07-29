"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSessionAutomationStore } = require("../src/session-automation-store");
const { createSessionAutomationCoordinator } = require("../src/session-automation-coordinator");

function eligible() {
  return Object.freeze({ eligible: true, reason: "verified" });
}

function toolEntry(overrides = {}) {
  return {
    agentId: "claude-code",
    sessionId: "local|claude-code|s1",
    sessionAutomationIdentity: eligible(),
    interaction: { intent: "tool-approval" },
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createHarness(options = {}) {
  let grantCounter = 0;
  const sessions = new Map([
    ["local|claude-code|s1", {
      agentId: "claude-code",
      cwd: "/tmp/project",
      sessionAutomationIdentity: eligible(),
    }],
  ]);
  const pending = [];
  const resolved = [];
  const restored = [];
  const store = createSessionAutomationStore({
    maxRecords: options.maxRecords,
    makeGrantId: () => `transition-${++grantCounter}`,
  });
  let coordinator;
  coordinator = createSessionAutomationCoordinator({
    store,
    getSession: (id) => sessions.get(id) || null,
    listPending: () => pending,
    getGlobalMode: () => options.globalMode || "off",
    canAutoResolvePendingPermission: (entry, config) =>
      pending.includes(entry)
      && entry.sessionAutomationIdentity
      && entry.sessionAutomationIdentity.eligible === true
      && entry.interaction
      && entry.interaction.intent === "tool-approval"
      && config.mode === "auto-tools",
    resolvePermissionEntry: (entry) => {
      if (entry.sessionTrustCandidate) {
        coordinator.cancelSessionTrustCandidate(entry, {
          reason: "permission-resolved",
        });
      }
      resolved.push(entry);
      const index = pending.indexOf(entry);
      if (index !== -1) pending.splice(index, 1);
    },
    beginConfirmation: (entry) => {
      if (!pending.includes(entry)) return false;
      entry.trustConfirming = true;
      return true;
    },
    endConfirmation: (entry) => { entry.trustConfirming = false; },
    restoreBubble: (entry) => restored.push(entry),
    isWarningDismissed: () => options.warningDismissed === true,
    showWarning: options.showWarning || (async () => ({ confirmed: true })),
    rememberWarning: options.rememberWarning || (() => {}),
    makeGrantId: () => `grant-${++grantCounter}`,
    translate: options.translate,
  });
  return { coordinator, store, sessions, pending, resolved, restored };
}

test("effective mode uses an eligible exact record and remote-only never falls back globally", () => {
  const h = createHarness({ globalMode: "auto-tools" });
  const entry = toolEntry();
  h.pending.push(entry);
  assert.equal(h.coordinator.getEffectiveMode(entry), "auto-tools");
  assert.equal(h.coordinator.getEffectiveMode(entry, { sessionOnly: true }), "off");
  h.store.compareAndSet(
    { agentId: entry.agentId, sessionId: entry.sessionId },
    "off",
    { expectedGrantId: null, nextGrantId: "off-1" }
  );
  assert.equal(h.coordinator.getEffectiveMode(entry), "off");
  assert.equal(h.coordinator.getEffectiveMode(entry, { sessionOnly: true }), "off");
});

test("desktop trust applies one grant and safe-sweeps only eligible tool siblings", async () => {
  const h = createHarness({ warningDismissed: true });
  const current = toolEntry();
  const sibling = toolEntry();
  const question = toolEntry({ interaction: { intent: "human-question" } });
  const confirming = toolEntry({ trustConfirming: true });
  const otherSession = toolEntry({ sessionId: "local|claude-code|s2" });
  h.pending.push(current, sibling, question, confirming, otherSession);

  const result = await h.coordinator.requestEntryTrust(current);
  assert.equal(result.status, "applied");
  assert.deepEqual(h.resolved, [current, sibling]);
  assert.deepEqual(h.pending, [question, confirming, otherSession]);
  assert.equal(h.store.list().length, 1);
  assert.equal(h.store.list()[0].mode, "auto-tools");
});

test("a confirming sibling resolves against the equivalent grant after either warning result", async () => {
  const firstWarning = deferred();
  const secondWarning = deferred();
  let warningCall = 0;
  const h = createHarness({
    showWarning: () => (++warningCall === 1 ? firstWarning.promise : secondWarning.promise),
  });
  const a = toolEntry();
  const b = toolEntry();
  h.pending.push(a, b);
  const aResult = h.coordinator.requestEntryTrust(a);
  const bResult = h.coordinator.requestEntryTrust(b);
  firstWarning.resolve({ confirmed: true });
  assert.equal((await aResult).status, "applied");
  assert.equal(h.pending.includes(b), true, "sweep must skip a confirming sibling");
  secondWarning.resolve({ confirmed: false });
  assert.equal((await bResult).status, "equivalent");
  assert.deepEqual(h.resolved, [a, b]);
  assert.equal(h.store.list().length, 1);
});

test("a confirming sibling also resolves equivalent after confirming its own warning", async () => {
  const firstWarning = deferred();
  const secondWarning = deferred();
  let warningCall = 0;
  const h = createHarness({
    showWarning: () => (++warningCall === 1 ? firstWarning.promise : secondWarning.promise),
  });
  const a = toolEntry();
  const b = toolEntry();
  h.pending.push(a, b);
  const aResult = h.coordinator.requestEntryTrust(a);
  const bResult = h.coordinator.requestEntryTrust(b);
  firstWarning.resolve({ confirmed: true });
  assert.equal((await aResult).status, "applied");
  secondWarning.resolve({ confirmed: true });
  assert.equal((await bResult).status, "equivalent");
  assert.deepEqual(h.resolved, [a, b]);
  assert.equal(h.store.list().length, 1);
});

test("when the first warning is cancelled, a confirming sibling can create the grant normally", async () => {
  const firstWarning = deferred();
  const secondWarning = deferred();
  let warningCall = 0;
  const h = createHarness({
    showWarning: () => (++warningCall === 1 ? firstWarning.promise : secondWarning.promise),
  });
  const a = toolEntry();
  const b = toolEntry();
  h.pending.push(a, b);
  const aResult = h.coordinator.requestEntryTrust(a);
  const bResult = h.coordinator.requestEntryTrust(b);
  firstWarning.resolve({ confirmed: false });
  assert.equal((await aResult).status, "cancelled");
  secondWarning.resolve({ confirmed: true });
  assert.equal((await bResult).status, "applied");
  assert.equal(h.store.list()[0].mode, "auto-tools");
  assert.deepEqual(h.resolved, [b, a]);
});

test("a confirming sibling cannot use a grant that changed to off before its warning returned", async () => {
  const firstWarning = deferred();
  const secondWarning = deferred();
  let warningCall = 0;
  const h = createHarness({
    showWarning: () => (++warningCall === 1 ? firstWarning.promise : secondWarning.promise),
  });
  const a = toolEntry();
  const b = toolEntry();
  h.pending.push(a, b);
  const aResult = h.coordinator.requestEntryTrust(a);
  const bResult = h.coordinator.requestEntryTrust(b);
  firstWarning.resolve({ confirmed: true });
  const first = await aResult;
  assert.equal(first.status, "applied");
  h.store.compareAndSet(
    { agentId: a.agentId, sessionId: a.sessionId },
    "off",
    {
      expectedGrantId: first.record.grantId,
      nextGrantId: "off-before-sibling-return",
    }
  );
  secondWarning.resolve({ confirmed: true });
  assert.equal((await bResult).status, "stale");
  assert.equal(h.pending.includes(b), true);
  assert.equal(h.resolved.includes(b), false);
  assert.equal(h.store.list()[0].mode, "off");
});

test("sweep hands a remote candidate to the active grant before resolving it elsewhere", async () => {
  const h = createHarness({ warningDismissed: true });
  const activeIds = [];
  const current = toolEntry();
  const remoteSibling = toolEntry({
    sessionTrustCandidate: {
      grantId: "candidate-remote",
      cancelled: false,
      cardWork: {},
      client: {
        cancelSessionTrustCandidate: (_work, options) => {
          activeIds.push(options.activeGrantId);
          return true;
        },
      },
    },
  });
  h.pending.push(current, remoteSibling);

  const result = await h.coordinator.requestEntryTrust(current);
  assert.equal(result.status, "applied");
  assert.deepEqual(activeIds, [result.record.grantId]);
  assert.equal(remoteSibling.sessionTrustCandidate, null);
  assert.deepEqual(h.resolved, [current, remoteSibling]);
});

test("a grant change while the warning is open restores with localized feedback instead of allowing stale confirmation", async () => {
  const warning = deferred();
  const h = createHarness({
    showWarning: () => warning.promise,
    translate: (key, fallback) =>
      key === "sessionAutomationChangedRetry" ? "会话设置已变化，请重试。" : fallback,
  });
  const entry = toolEntry();
  h.pending.push(entry);
  const resultPromise = h.coordinator.requestEntryTrust(entry);
  h.store.compareAndSet(
    { agentId: entry.agentId, sessionId: entry.sessionId },
    "off",
    { expectedGrantId: null, nextGrantId: "off-while-warning" }
  );
  warning.resolve({ confirmed: true });
  const result = await resultPromise;
  assert.equal(result.status, "stale");
  assert.deepEqual(h.resolved, []);
  assert.deepEqual(h.restored, [entry]);
  assert.equal(entry.sessionTrustError, "会话设置已变化，请重试。");
});

test("Dashboard derives identity from the current session and clear uses exact grantId", async () => {
  const h = createHarness({ warningDismissed: true });
  assert.equal((await h.coordinator.setSessionAutomationOverride({
    sessionId: "missing",
    mode: "auto-tools",
    agentId: "spoofed",
  })).status, "unavailable");
  const applied = await h.coordinator.setSessionAutomationOverride({
    sessionId: "local|claude-code|s1",
    mode: "auto-tools",
  });
  assert.equal(applied.status, "applied");
  assert.equal(h.store.list()[0].agentId, "claude-code");
  assert.equal(h.coordinator.clearSessionAutomationGrant({ grantId: "stale" }).status, "stale");
  assert.equal(h.coordinator.clearSessionAutomationGrant({
    grantId: applied.record.grantId,
  }).status, "applied");
  assert.equal(h.store.list().length, 0);
});

test("Dashboard forwards its warning parent without trusting renderer payload fields", async () => {
  const warningParent = { isDestroyed: () => false };
  const warnings = [];
  const h = createHarness({
    showWarning: async (entry) => {
      warnings.push(entry);
      return { confirmed: false };
    },
  });

  const result = await h.coordinator.setSessionAutomationOverride(
    {
      sessionId: "local|claude-code|s1",
      mode: "auto-tools",
      warningParent: { spoofed: true },
    },
    { warningParent }
  );

  assert.equal(result.status, "cancelled");
  assert.deepEqual(warnings, [{ warningParent }]);
});

test("session lifecycle and agent cleanup cancel candidates and clear memory records", async () => {
  const h = createHarness({ warningDismissed: true });
  const cancelled = [];
  const entry = toolEntry({
    sessionTrustCandidate: {
      cancelled: false,
      client: {
        cancelSessionTrustCandidate: (_work, options) => cancelled.push(options),
      },
      cardWork: {},
    },
  });
  await h.coordinator.setSessionAutomationOverride({
    sessionId: entry.sessionId,
    mode: "auto-tools",
  });
  h.pending.push(entry);
  h.coordinator.onSessionLifecycleEnd({
    agentId: entry.agentId,
    sessionId: entry.sessionId,
    reason: "session-end",
  });
  assert.equal(entry.sessionTrustCandidate, null);
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].activeGrantId, null);
  assert.equal(h.store.list().length, 0);

  await h.coordinator.setSessionAutomationOverride({
    sessionId: entry.sessionId,
    mode: "auto-tools",
  });
  h.coordinator.clearAgent("claude-code");
  assert.equal(h.store.list().length, 0);
  assert.equal(createSessionAutomationStore().list().length, 0, "restart creates an empty store");
});

test("remote trust prepares a revocable card before committing and resolving", async () => {
  const h = createHarness();
  const entry = toolEntry();
  h.pending.push(entry);
  const calls = [];
  const cardWork = {};
  const client = {
    beginSessionTrustCandidate(payload) {
      calls.push(["begin", payload.grantId]);
      return cardWork;
    },
    async prepareSessionTrustCandidate(work, payload) {
      calls.push(["prepare", work, payload.grantId, h.store.list().length]);
      return true;
    },
    activateSessionTrustCandidate(work, payload) {
      calls.push(["activate", work, payload.grantId, h.store.list().length]);
      return true;
    },
    cancelSessionTrustCandidate() {
      calls.push(["cancel"]);
    },
    renderActiveSessionTrust(work, payload) {
      calls.push(["render-active", work, payload.grantId]);
    },
  };

  const result = await h.coordinator.requestRemoteSessionTrust(entry, {
    clientName: "telegram",
    client,
    cardHandle: Object.freeze({}),
  });

  assert.equal(result.status, "applied");
  assert.equal(calls[0][0], "begin");
  assert.deepEqual(calls[1].slice(0, 2), ["prepare", cardWork]);
  assert.equal(calls[1][3], 0, "preparing edit must happen before the grant exists");
  assert.equal(calls[2][0], "activate");
  assert.equal(calls[2][3], 1, "card ownership transfers synchronously after CAS");
  assert.equal(calls[3][0], "render-active");
  assert.deepEqual(h.resolved, [entry]);
  assert.equal(h.store.list()[0].mode, "auto-tools");
  assert.equal(entry.sessionTrustCandidate, null);
});

test("remote trust never commits when the preparing edit fails", async () => {
  const h = createHarness();
  const entry = toolEntry();
  h.pending.push(entry);
  const cancelled = [];
  const client = {
    beginSessionTrustCandidate: () => ({}),
    prepareSessionTrustCandidate: async () => false,
    activateSessionTrustCandidate: () => {
      throw new Error("must not activate");
    },
    cancelSessionTrustCandidate: (_work, options) => cancelled.push(options.reason),
  };

  const result = await h.coordinator.requestRemoteSessionTrust(entry, {
    clientName: "telegram",
    client,
    cardHandle: Object.freeze({}),
  });
  assert.equal(result.status, "prepare-failed");
  assert.equal(h.store.list().length, 0);
  assert.deepEqual(h.resolved, []);
  assert.deepEqual(cancelled, ["pre-commit-cancelled"]);
  assert.equal(entry.sessionTrustCandidate, null);
});

test("remote trust never commits when the entry is resolved while the preparing edit is in flight", async () => {
  const prepared = deferred();
  const h = createHarness();
  const entry = toolEntry();
  h.pending.push(entry);
  const cancelled = [];
  const client = {
    beginSessionTrustCandidate: () => ({}),
    prepareSessionTrustCandidate: () => prepared.promise,
    activateSessionTrustCandidate: () => {
      throw new Error("must not activate");
    },
    cancelSessionTrustCandidate: (_work, options) => cancelled.push(options.reason),
  };
  const request = h.coordinator.requestRemoteSessionTrust(entry, {
    clientName: "telegram",
    client,
    cardHandle: Object.freeze({}),
  });
  await Promise.resolve();
  h.coordinator.cancelSessionTrustCandidate(entry, { reason: "permission-resolved" });
  h.pending.splice(h.pending.indexOf(entry), 1);
  prepared.resolve(true);

  assert.equal((await request).status, "unavailable");
  assert.equal(h.store.list().length, 0);
  assert.deepEqual(h.resolved, []);
  assert.deepEqual(cancelled, ["permission-resolved"]);
});

test("only one remote session-trust candidate may own an entry at a time", async () => {
  const firstPrepared = deferred();
  const h = createHarness();
  const entry = toolEntry();
  h.pending.push(entry);
  const firstClient = {
    beginSessionTrustCandidate: () => ({}),
    prepareSessionTrustCandidate: () => firstPrepared.promise,
    activateSessionTrustCandidate: () => true,
    cancelSessionTrustCandidate: () => true,
    renderActiveSessionTrust: () => true,
  };
  const firstRequest = h.coordinator.requestRemoteSessionTrust(entry, {
    clientName: "telegram",
    client: firstClient,
    cardHandle: Object.freeze({}),
  });
  await Promise.resolve();
  let secondBeginCalls = 0;
  const secondResult = await h.coordinator.requestRemoteSessionTrust(entry, {
    clientName: "feishu",
    client: {
      beginSessionTrustCandidate: () => {
        secondBeginCalls += 1;
        return {};
      },
      prepareSessionTrustCandidate: async () => true,
      activateSessionTrustCandidate: () => true,
      cancelSessionTrustCandidate: () => true,
    },
    cardHandle: Object.freeze({}),
  });

  assert.equal(secondResult.status, "unavailable");
  assert.equal(secondBeginCalls, 0);
  firstPrepared.resolve(true);
  assert.equal((await firstRequest).status, "applied");
  assert.deepEqual(h.resolved, [entry]);
});

test("remote trust never commits after session lifecycle cleanup during the preparing edit", async () => {
  const prepared = deferred();
  const h = createHarness();
  const entry = toolEntry();
  h.pending.push(entry);
  const cancelled = [];
  const client = {
    beginSessionTrustCandidate: () => ({}),
    prepareSessionTrustCandidate: () => prepared.promise,
    activateSessionTrustCandidate: () => {
      throw new Error("must not activate");
    },
    cancelSessionTrustCandidate: (_work, options) => cancelled.push(options.reason),
  };
  const request = h.coordinator.requestRemoteSessionTrust(entry, {
    clientName: "feishu",
    client,
    cardHandle: Object.freeze({}),
  });
  await Promise.resolve();
  h.coordinator.onSessionLifecycleEnd({
    agentId: entry.agentId,
    sessionId: entry.sessionId,
    reason: "stale-delete",
  });
  prepared.resolve(true);

  assert.equal((await request).status, "unavailable");
  assert.equal(h.store.list().length, 0);
  assert.deepEqual(h.resolved, []);
  assert.deepEqual(cancelled, ["stale-delete"]);
});

test("remote trust rechecks identity and current grant after the preparing edit", async () => {
  const preparedIdentity = deferred();
  const identityHarness = createHarness();
  const identityEntry = toolEntry();
  identityHarness.pending.push(identityEntry);
  const cancelledIdentity = [];
  const identityClient = {
    beginSessionTrustCandidate: () => ({}),
    prepareSessionTrustCandidate: () => preparedIdentity.promise,
    activateSessionTrustCandidate: () => {
      throw new Error("must not activate");
    },
    cancelSessionTrustCandidate: (_work, options) => cancelledIdentity.push(options.reason),
  };
  const identityRequest = identityHarness.coordinator.requestRemoteSessionTrust(identityEntry, {
    clientName: "telegram",
    client: identityClient,
    cardHandle: Object.freeze({}),
  });
  await Promise.resolve();
  identityEntry.sessionAutomationIdentity = { eligible: false, reason: "route-changed" };
  preparedIdentity.resolve(true);
  assert.equal((await identityRequest).status, "unavailable");
  assert.equal(identityHarness.store.list().length, 0);
  assert.deepEqual(cancelledIdentity, ["pre-commit-cancelled"]);

  const preparedGrant = deferred();
  const grantHarness = createHarness();
  const grantEntry = toolEntry();
  grantHarness.pending.push(grantEntry);
  const cancelledGrant = [];
  const grantClient = {
    beginSessionTrustCandidate: () => ({}),
    prepareSessionTrustCandidate: () => preparedGrant.promise,
    activateSessionTrustCandidate: () => {
      throw new Error("must not activate");
    },
    cancelSessionTrustCandidate: (_work, options) => cancelledGrant.push(options.reason),
  };
  const grantRequest = grantHarness.coordinator.requestRemoteSessionTrust(grantEntry, {
    clientName: "feishu",
    client: grantClient,
    cardHandle: Object.freeze({}),
  });
  await Promise.resolve();
  grantHarness.store.compareAndSet(
    { agentId: grantEntry.agentId, sessionId: grantEntry.sessionId },
    "off",
    { expectedGrantId: null, nextGrantId: "changed-during-prepare" }
  );
  preparedGrant.resolve(true);
  assert.equal((await grantRequest).status, "stale");
  assert.equal(grantHarness.store.list()[0].mode, "off");
  assert.deepEqual(cancelledGrant, ["stale"]);
});

test("remote trust rechecks the live permission gate after the preparing edit", async () => {
  const prepared = deferred();
  const h = createHarness();
  const entry = toolEntry();
  h.pending.push(entry);
  const cancelled = [];
  const client = {
    beginSessionTrustCandidate: () => ({}),
    prepareSessionTrustCandidate: () => prepared.promise,
    activateSessionTrustCandidate: () => {
      throw new Error("must not activate");
    },
    cancelSessionTrustCandidate: (_work, options) => cancelled.push(options.reason),
  };
  const request = h.coordinator.requestRemoteSessionTrust(entry, {
    clientName: "telegram",
    client,
    cardHandle: Object.freeze({}),
  });
  await Promise.resolve();
  entry.interaction = { intent: "human-question" };
  prepared.resolve(true);

  assert.equal((await request).status, "unavailable");
  assert.equal(h.store.list().length, 0);
  assert.deepEqual(h.resolved, []);
  assert.deepEqual(cancelled, ["pre-commit-cancelled"]);
});

test("remote trust leaves the permission pending when the runtime store is full", async () => {
  const h = createHarness({ maxRecords: 1 });
  h.store.compareAndSet(
    { agentId: "claude-code", sessionId: "another-session" },
    "off",
    { expectedGrantId: null, nextGrantId: "fills-store" }
  );
  const entry = toolEntry();
  h.pending.push(entry);
  const cancelled = [];
  const client = {
    beginSessionTrustCandidate: () => ({}),
    prepareSessionTrustCandidate: async () => true,
    activateSessionTrustCandidate: () => {
      throw new Error("must not activate");
    },
    cancelSessionTrustCandidate: (_work, options) => cancelled.push(options.reason),
  };

  const result = await h.coordinator.requestRemoteSessionTrust(entry, {
    clientName: "telegram",
    client,
    cardHandle: Object.freeze({}),
  });
  assert.equal(result.status, "full");
  assert.equal(h.pending.includes(entry), true);
  assert.deepEqual(h.resolved, []);
  assert.deepEqual(cancelled, ["full"]);
  assert.equal(h.store.list().length, 1);
});

test("a failed active-card handoff rolls back to explicit off instead of global fallback", async () => {
  const h = createHarness({ globalMode: "unattended" });
  const identity = {
    agentId: "claude-code",
    sessionId: "local|claude-code|s1",
  };
  const initial = h.store.compareAndSet(identity, "off", {
    expectedGrantId: null,
    nextGrantId: "explicit-off-before-handoff",
  });
  assert.equal(initial.status, "applied");
  const entry = toolEntry();
  h.pending.push(entry);
  const cancelled = [];
  const client = {
    beginSessionTrustCandidate: () => ({}),
    prepareSessionTrustCandidate: async () => true,
    activateSessionTrustCandidate: () => false,
    cancelSessionTrustCandidate: (_work, options) => cancelled.push(options.reason),
  };

  const result = await h.coordinator.requestRemoteSessionTrust(entry, {
    clientName: "telegram",
    client,
    cardHandle: Object.freeze({}),
  });

  assert.equal(result.status, "unavailable");
  assert.equal(h.pending.includes(entry), true);
  assert.deepEqual(h.resolved, []);
  assert.deepEqual(cancelled, ["handoff-failed"]);
  const rolledBack = h.store.get(identity);
  assert.equal(rolledBack.mode, "off");
  assert.notEqual(rolledBack.grantId, initial.record.grantId);
  assert.equal(
    h.coordinator.getEffectiveMode(entry),
    "off",
    "explicit off must continue to override a broader unattended global mode"
  );
});

test("an active-card handoff exception also fails closed to explicit off", async () => {
  const h = createHarness({ globalMode: "unattended" });
  const entry = toolEntry();
  h.pending.push(entry);
  const client = {
    beginSessionTrustCandidate: () => ({}),
    prepareSessionTrustCandidate: async () => true,
    activateSessionTrustCandidate: () => {
      throw new Error("broken local handoff");
    },
    cancelSessionTrustCandidate: () => true,
  };

  const result = await h.coordinator.requestRemoteSessionTrust(entry, {
    clientName: "feishu",
    client,
    cardHandle: Object.freeze({}),
  });

  assert.equal(result.status, "unavailable");
  assert.equal(h.store.get({
    agentId: entry.agentId,
    sessionId: entry.sessionId,
  }).mode, "off");
  assert.equal(h.coordinator.getEffectiveMode(entry), "off");
});

test("a failed best-effort active-card update does not roll back the committed grant", async () => {
  const h = createHarness();
  const entry = toolEntry();
  h.pending.push(entry);
  const cardWork = {};
  const client = {
    beginSessionTrustCandidate: () => cardWork,
    prepareSessionTrustCandidate: async () => true,
    activateSessionTrustCandidate: () => true,
    cancelSessionTrustCandidate: () => true,
    renderActiveSessionTrust: () => Promise.resolve(false),
  };

  const result = await h.coordinator.requestRemoteSessionTrust(entry, {
    clientName: "telegram",
    client,
    cardHandle: Object.freeze({}),
  });
  assert.equal(result.status, "applied");
  assert.deepEqual(h.resolved, [entry]);
  assert.equal(h.store.list()[0].mode, "auto-tools");
  assert.equal(h.store.list()[0].grantId, result.record.grantId);
});

test("persistent revoke cancels an exact in-flight candidate without creating a record", async () => {
  const prepared = deferred();
  const h = createHarness();
  const entry = toolEntry();
  h.pending.push(entry);
  const cancelled = [];
  const client = {
    beginSessionTrustCandidate: () => ({}),
    prepareSessionTrustCandidate: () => prepared.promise,
    activateSessionTrustCandidate: () => true,
    cancelSessionTrustCandidate: (_work, options) => cancelled.push(options.reason),
  };
  const request = h.coordinator.requestRemoteSessionTrust(entry, {
    clientName: "telegram",
    client,
    cardHandle: Object.freeze({}),
  });
  await Promise.resolve();
  const grantId = entry.sessionTrustCandidate.grantId;
  assert.equal(h.coordinator.revokeRemoteGrant({ grantId }).status, "candidate-cancelled");
  prepared.resolve(true);
  assert.equal((await request).status, "unavailable");
  assert.equal(h.store.list().length, 0);
  assert.deepEqual(h.resolved, []);
  assert.deepEqual(cancelled, ["remote-revoke"]);
});

test("remote route change tightens indexed active grants to off and cancels candidates", async () => {
  const h = createHarness({ warningDismissed: true });
  const applied = await h.coordinator.setSessionAutomationOverride({
    sessionId: "local|claude-code|s1",
    mode: "auto-tools",
  });
  const cancelled = [];
  const client = {
    listActiveSessionAutomationGrantIds: () => [applied.record.grantId, "stale-grant"],
    retireSessionAutomationGrant: (grantId) => cancelled.push(["retire", grantId]),
    cancelSessionTrustCandidate: (_work, options) => cancelled.push(["candidate", options.reason]),
  };
  const entry = toolEntry({
    sessionTrustCandidate: {
      cancelled: false,
      client,
      cardWork: {},
      grantId: "candidate-grant",
    },
  });
  h.pending.push(entry);

  h.coordinator.onRemoteClientRouteChange(client);

  assert.equal(h.store.list()[0].mode, "off");
  assert.notEqual(h.store.list()[0].grantId, applied.record.grantId);
  assert.equal(entry.sessionTrustCandidate, null);
  assert.deepEqual(cancelled, [
    ["candidate", "route-changed"],
    ["retire", "stale-grant"],
  ]);
});
