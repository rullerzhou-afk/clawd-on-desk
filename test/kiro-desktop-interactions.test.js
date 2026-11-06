"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createKiroDesktopInteractions,
  MAX_PENDING_AGE_MS,
} = require("../src/kiro-desktop-interactions");
// Give ledger cases the same complete execution/tool/round identity shape.
const info = (executionId = "e", consentRound = 1, toolCallId = "t") => ({ executionId, consentRound, toolCallId });

test("kiro-desktop: ledger uses complete keys and resolves consent rounds independently", () => {
  const ledger = createKiroDesktopInteractions();
  const changes = [];
  const unsubscribe = ledger.onChange(id => changes.push(id));
  ledger.add("s", info("e", 2));
  ledger.add("s", info("e", 1));
  ledger.add("s", info("e", 1));
  ledger.resolve("s", info("old"));
  ledger.clearExecution("s", "old");
  assert.equal(changes.length, 2);
  ledger.resolve("s", info("e", 1));
  assert.equal(ledger.getLatest("s").consentRound, 2);
  ledger.add("s", info("next"));
  ledger.clearExecution("s", "e");
  assert.equal(ledger.getLatest("s").executionId, "next");
  ledger.resolve("s", info("next"));
  assert.deepEqual([...ledger.getPendingSessionIds()], []);
  unsubscribe();
  ledger.clearAll();
});
test("kiro-desktop: ledger bounds entries per session and total sessions with change notifications", () => {
  const ledger = createKiroDesktopInteractions();
  const changes = [];
  ledger.onChange(id => changes.push(id));
  for (let round = 0; round < 21; round++) ledger.add("s", info("e", round));
  for (let round = 20; round > 0; round--) ledger.resolve("s", info("e", round));
  assert.equal(ledger.getLatest("s"), null);
  for (let index = 0; index < 201; index++) ledger.add(String(index), info());
  assert.equal(ledger.getPendingSessionIds().size, 200);
  assert.equal(ledger.getLatest("0"), null);
  assert.equal(changes.filter(id => id === "0").length, 2);
  ledger.clearAll();
  assert.equal(ledger.getPendingSessionIds().size, 0);
});


test("kiro-desktop: pending age uses the injected admission clock and ignores replayed timestamps", () => {
  let now = 1000;
  const ledger = createKiroDesktopInteractions({ now: () => now });
  ledger.add("s", { ...info(), pendingSince: -MAX_PENDING_AGE_MS, timestamp: -MAX_PENDING_AGE_MS });
  assert.equal(ledger.getLatest("s").pendingSince, 1000);
  now += MAX_PENDING_AGE_MS;
  ledger.add("s", { ...info(), timestamp: now });
  assert.equal(ledger.getLatest("s").pendingSince, 1000);
  assert.equal(ledger.getPendingSessionIds().has("s"), true);
  now++;
  assert.equal(ledger.getLatest("s"), null);
});

for (const reader of ["getLatest", "getPendingSessionIds"]) {
  test(`kiro-desktop: ${reader} expires old entries once before notifying reentrant readers`, () => {
    let now = 0;
    const ledger = createKiroDesktopInteractions({ now: () => now });
    ledger.add("a", info());
    ledger.add("b", info());
    const changes = [];
    ledger.onChange(sessionId => {
      changes.push(sessionId);
      assert.equal(ledger.getLatest(sessionId), null);
      assert.equal(ledger.getPendingSessionIds().size, 0);
    });
    now = MAX_PENDING_AGE_MS + 1;
    ledger[reader]("a");
    assert.deepEqual(changes, ["a", "b"]);
    assert.equal(ledger.getLatest("a"), null);
    assert.equal(ledger.getLatest("b"), null);
    assert.equal(ledger.getPendingSessionIds().size, 0);
    assert.equal(changes.length, 2);
  });
}

test("kiro-desktop: expiring one consent round retains younger interactions in the same session", () => {
  let now = 0;
  const ledger = createKiroDesktopInteractions({ now: () => now });
  const changes = [];
  ledger.onChange(sessionId => changes.push(sessionId));
  ledger.add("s", info("e", 1));
  now = MAX_PENDING_AGE_MS - 1;
  ledger.add("s", info("e", 2));
  now = MAX_PENDING_AGE_MS + 1;
  assert.equal(ledger.getLatest("s").consentRound, 2);
  assert.equal(ledger.getPendingSessionIds().has("s"), true);
  ledger.resolve("s", info("e", 2));
  assert.equal(ledger.getLatest("s"), null);
  assert.deepEqual(changes, ["s", "s", "s", "s"]);
});
