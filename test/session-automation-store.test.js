"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createSessionAutomationStore,
  sanitizeDisplayLabel,
} = require("../src/session-automation-store");

function identity(agentId = "claude-code", sessionId = "local|claude-code|s1") {
  return { agentId, sessionId };
}

test("session automation store uses exact identity CAS and immutable copies", () => {
  const batches = [];
  const store = createSessionAutomationStore({ onChange: (changes) => batches.push(changes) });
  const first = store.compareAndSet(identity(), "auto-tools", {
    expectedGrantId: null,
    nextGrantId: "grant-1",
    displayLabel: " project ",
    createdAt: 10,
  });
  assert.equal(first.status, "applied");
  assert.deepEqual(first.record, {
    agentId: "claude-code",
    sessionId: "local|claude-code|s1",
    mode: "auto-tools",
    grantId: "grant-1",
    displayLabel: "project",
    createdAt: 10,
  });
  assert.equal(Object.isFrozen(first.record), true);
  assert.equal(Object.isFrozen(batches[0]), true);
  assert.equal(Object.isFrozen(batches[0][0]), true);

  assert.equal(store.compareAndSet(identity(), "auto-tools", {
    expectedGrantId: "wrong",
    nextGrantId: "grant-2",
  }).status, "equivalent");
  assert.equal(store.get(identity()).grantId, "grant-1");

  assert.equal(store.compareAndSet(identity(), "off", {
    expectedGrantId: "wrong",
    nextGrantId: "grant-2",
  }).status, "stale");
  assert.equal(store.compareAndSet(identity(), "off", {
    expectedGrantId: "grant-1",
    nextGrantId: "grant-2",
  }).status, "applied");
  assert.equal(store.get(identity()).mode, "off");
  assert.equal(batches.length, 2);
});

test("store enforces capacity without eviction and batches clearAgent", () => {
  const batches = [];
  const store = createSessionAutomationStore({
    maxRecords: 2,
    onChange: (changes) => batches.push(changes),
  });
  store.compareAndSet(identity("a", "1"), "off", { expectedGrantId: null, nextGrantId: "g1" });
  store.compareAndSet(identity("a", "2"), "auto-tools", { expectedGrantId: null, nextGrantId: "g2" });
  assert.equal(store.compareAndSet(identity("b", "3"), "off", {
    expectedGrantId: null,
    nextGrantId: "g3",
  }).status, "full");
  const cleared = store.clearAgent("a");
  assert.equal(cleared.length, 2);
  assert.equal(store.list().length, 0);
  assert.equal(batches.length, 3);
  assert.equal(batches[2].length, 2);
});

test("store isolates identical raw-looking ids across agents and sessions", () => {
  const store = createSessionAutomationStore();
  const records = [
    ["claude-code", "same", "g-claude"],
    ["qwen-code", "same", "g-qwen"],
    ["claude-code", "other", "g-other"],
  ];
  for (const [agentId, sessionId, grantId] of records) {
    assert.equal(store.compareAndSet(
      identity(agentId, sessionId),
      "auto-tools",
      { expectedGrantId: null, nextGrantId: grantId }
    ).status, "applied");
  }
  assert.equal(store.get(identity("claude-code", "same")).grantId, "g-claude");
  assert.equal(store.get(identity("qwen-code", "same")).grantId, "g-qwen");
  assert.equal(store.get(identity("claude-code", "other")).grantId, "g-other");
});

test("transitionGrant supports exact clear and fixed remote revoke only", () => {
  const store = createSessionAutomationStore({ makeGrantId: () => "g2" });
  store.compareAndSet(identity(), "auto-tools", {
    expectedGrantId: null,
    nextGrantId: "g1",
  });
  assert.equal(store.transitionGrant("missing", "clear").status, "stale");
  assert.equal(store.transitionGrant("g1", "chosen-by-renderer").status, "invalid");
  const revoked = store.transitionGrant("g1", "remote-revoke");
  assert.equal(revoked.status, "applied");
  assert.equal(revoked.record.mode, "off");
  assert.equal(revoked.record.grantId, "g2");
  assert.equal(store.transitionGrant("g1", "clear").status, "stale");
  assert.equal(store.transitionGrant("g2", "clear").status, "applied");
});

test("an old remote card cannot revoke a newer grant for the same session", () => {
  let nextGrantId = "off-after-old-revoke";
  const store = createSessionAutomationStore({ makeGrantId: () => nextGrantId });
  store.compareAndSet(identity(), "auto-tools", {
    expectedGrantId: null,
    nextGrantId: "old-grant",
  });
  assert.equal(store.transitionGrant("old-grant", "clear").status, "applied");
  store.compareAndSet(identity(), "auto-tools", {
    expectedGrantId: null,
    nextGrantId: "new-grant",
  });

  nextGrantId = "must-not-be-used";
  assert.equal(store.transitionGrant("old-grant", "remote-revoke").status, "stale");
  assert.equal(store.get(identity()).mode, "auto-tools");
  assert.equal(store.get(identity()).grantId, "new-grant");
});

test("store rejects invalid inputs and sanitizes orphan labels", () => {
  const store = createSessionAutomationStore();
  assert.equal(store.compareAndSet({}, "off", {
    expectedGrantId: null,
    nextGrantId: "g",
  }).status, "invalid");
  assert.equal(store.compareAndSet(identity(), "always", {
    expectedGrantId: null,
    nextGrantId: "g",
  }).status, "invalid");
  assert.equal(sanitizeDisplayLabel(" a\u0000 \n b "), "a b");
  assert.equal(sanitizeDisplayLabel("x".repeat(200)).length, 80);
  assert.equal(sanitizeDisplayLabel("x".repeat(200)).endsWith("\u2026"), true);
});
