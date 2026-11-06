"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCopilotTerminalWait, MAX_PENDING_AGE_MS, MAX_UNCONSUMED_AGE_MS } = require("../src/copilot-terminal-wait");

function harness() {
  let now = 1000;
  const ledger = createCopilotTerminalWait({ now: () => now });
  const changes = [];
  ledger.onChange(id => changes.push(id));
  return {
    ledger, changes,
    at(value) { now = value; },
    pending(key = "a", ts = 100, id = "s") {
      ledger.onHook(id, "Notification", { copilotWaitKey: key, copilotEventTs: ts });
    },
    complete(keys = ["a"], ts = 200, id = "s", event = "postToolUse") {
      ledger.onHook(id, event, { copilotToolKeys: keys, copilotEventTs: ts });
    },
    has(id = "s") { return ledger.getPendingSessionIds().has(id); },
  };
}

test("copilot: ledger resolves only one matching request per tool key", () => {
  const h = harness();
  h.pending();
  h.pending("a", 300);
  h.complete(["other"]);
  assert.equal(h.has(), true);
  h.complete();
  assert.equal(h.has(), true);
  h.complete(["a"], 250);
  assert.equal(h.has(), true);
  h.complete(["a"], 400, "s", "postToolUseFailure");
  assert.equal(h.has(), false);
  assert.deepEqual(h.changes, ["s", "s", "s", "s"]);
});

test("copilot: completions before notifications are consumed once with timestamp ordering", () => {
  const h = harness();
  h.complete(["a"], 200);
  h.pending("a", 300);
  assert.equal(h.has(), true);
  h.pending("a", 100);
  assert.equal(h.has(), true);
  h.pending("a", 100);
  h.complete(["a"], 200);
  assert.equal(h.has(), true);
  h.complete(["a"], 400);
  assert.equal(h.has(), false);
});

for (const [noticeTs, completionTs] of [[null, 200], [100, null], [null, null]]) {
  test(`copilot: missing timestamps use one arrival-order match ${noticeTs} ${completionTs}`, () => {
    const h = harness();
    h.complete(["a"], completionTs);
    h.pending("a", noticeTs);
    assert.equal(h.has(), false);
    h.pending("a", noticeTs);
    h.pending("a", noticeTs);
    h.complete(["a"], completionTs);
    assert.equal(h.has(), true);
    h.complete(["a"], completionTs);
    assert.equal(h.has(), false);
  });
}

for (const event of ["userPromptSubmitted", "agentStop", "sessionEnd"]) {
  test(`copilot: ${event} clears all requests and fences old notifications`, () => {
    const h = harness();
    h.pending();
    h.pending("b");
    h.complete(["c"]);
    h.ledger.onHook("s", event, { copilotEventTs: 300 });
    assert.equal(h.has(), false);
    h.ledger.onHook("s", event, { copilotEventTs: 200 });
    h.pending("a", 300);
    assert.equal(h.has(), false);
    h.pending("c", 400);
    assert.equal(h.has(), true, "boundary clears unmatched completions too");
  });
}

test("copilot: recoverable errors, session initialization and unrelated hooks preserve waits", () => {
  const h = harness();
  h.pending();
  for (const event of ["errorOccurred", "sessionStart", "preToolUse", "Notification", "postToolUse"]) {
    h.ledger.onHook("s", event, {});
    assert.equal(h.has(), true);
  }
  assert.deepEqual(h.changes, ["s"]);
});

test("copilot: unmatched completions expire by arrival time after sixty seconds", () => {
  const h = harness();
  h.complete(["a", "b"], 1e12);
  h.at(1000 + MAX_UNCONSUMED_AGE_MS);
  h.pending("a");
  assert.equal(h.has(), false);
  h.at(1001 + MAX_UNCONSUMED_AGE_MS);
  h.pending("b");
  assert.equal(h.has(), true);
});

test("copilot: pending expires by admission time and not by the source timestamp", () => {
  const h = harness();
  h.pending("a", 1e12);
  h.at(1000 + MAX_PENDING_AGE_MS);
  assert.equal(h.has(), true);
  h.at(1001 + MAX_PENDING_AGE_MS);
  assert.equal(h.has(), false);
  assert.deepEqual(h.changes, ["s", "s"]);
});

test("copilot: expiration notifies reentrant readers after removing the complete batch", () => {
  const h = harness();
  h.pending("a", 100, "one");
  h.pending("a", 100, "two");
  const observed = [];
  h.ledger.onChange(id => observed.push([id, h.ledger.getPendingSessionIds().size]));
  h.at(1001 + MAX_PENDING_AGE_MS);
  assert.equal(h.ledger.getPendingSessionIds().size, 0);
  assert.deepEqual(observed, [["one", 0], ["two", 0]]);
});

test("copilot: expiration retains younger requests for the same key", () => {
  const h = harness();
  h.pending();
  h.at(1000 + MAX_PENDING_AGE_MS);
  h.pending("a", 300);
  h.at(1001 + MAX_PENDING_AGE_MS);
  assert.equal(h.has(), true);
  h.complete(["a"], 400);
  assert.equal(h.has(), false);
});

for (const repeatedKey of [false, true]) {
  test(`copilot: twenty-request limit counts queued entries across keys with repeated key ${repeatedKey}`, () => {
    const h = harness();
    for (let i = 0; i < 21; i++) {
      h.at(1000 + i);
      h.pending(repeatedKey ? "a" : String(i), 100 + i);
    }
    for (let i = 1; i < 21; i++) h.complete([repeatedKey ? "a" : String(i)], 200);
    assert.equal(h.has(), false);
  });
}

test("copilot: unmatched completions have a separate twenty-entry bound", () => {
  const h = harness();
  for (let i = 0; i < 21; i++) {
    h.at(1000 + i);
    h.complete([String(i)], 200);
  }
  for (let i = 1; i < 21; i++) h.pending(String(i));
  assert.equal(h.has(), false);
  h.pending("0");
  assert.equal(h.has(), true);
});

test("copilot: session capacity evicts the oldest session including boundary-only records", () => {
  const h = harness();
  h.pending();
  for (let i = 0; i < 200; i++) h.ledger.onHook(String(i), "agentStop", { copilotEventTs: 100 });
  assert.equal(h.has(), false);
  assert.deepEqual(h.changes, ["s", "s"]);
  h.pending("a", 50, "0");
  assert.equal(h.has("0"), false);
  h.pending("a", 150, "new");
  h.pending("a", 50, "0");
  assert.equal(h.has("0"), true, "oldest boundary was evicted at the capacity limit");
});

test("copilot: clearSession and cleanup discard pending, completions and boundaries", () => {
  const h = harness();
  h.complete();
  h.ledger.clearSession("s");
  h.pending();
  assert.equal(h.has(), true);
  h.ledger.onHook("boundary", "agentStop", { copilotEventTs: 300 });
  h.complete(["b"], 200, "other");
  h.ledger.clearAll();
  assert.equal(h.has(), false);
  h.pending("a", 100, "boundary");
  h.pending("b", 100, "other");
  assert.equal(h.has("boundary"), true);
  assert.equal(h.has("other"), true);
  const changes = h.changes.length;
  const unsubscribe = h.ledger.onChange(() => assert.fail("unsubscribed"));
  unsubscribe();
  h.ledger.clearAll();
  assert.equal(h.changes.length, changes + 2);
});

test("copilot: repeated unmatched completions each suppress only one late request within their bound", () => {
  const h = harness();
  for (let i = 0; i < 21; i++) h.complete();
  for (let i = 0; i < 20; i++) h.pending();
  assert.equal(h.has(), false);
  h.pending();
  assert.equal(h.has(), true);
});

test("copilot: two hundred pending sessions survive until the oldest is evicted", () => {
  const h = harness();
  for (let i = 0; i < 201; i++) h.pending("a", 100, String(i));
  assert.equal(h.ledger.getPendingSessionIds().size, 200);
  assert.equal(h.has("0"), false);
  assert.equal(h.has("200"), true);
});


for (const event of ["userPromptSubmitted", "agentStop", "sessionEnd"]) {
  test(`copilot: timestamped ${event} retains newer pending requests and unmatched completions`, () => {
    const h = harness();
    h.ledger.onHook("s", "userPromptSubmitted", { copilotEventTs: 300 });
    h.pending("old", 100);
    h.pending("new", 400);
    h.pending("unknown", null);
    h.complete(["late"], 500);
    h.complete(["unknown-completion"], null);
    h.ledger.onHook("s", event, { copilotEventTs: 200 });
    assert.equal(h.has(), true);
    h.pending("late", 450);
    h.complete(["new"], 500);
    assert.equal(h.has(), false, "newer unmatched completion consumed the late notification");
    h.pending("unknown-completion", 600);
    assert.equal(h.has(), true, "timestamp-less completion was cleared");
    h.ledger.onHook("s", event, {});
    assert.equal(h.has(), false, "timestamp-less boundary clears everything");
  });
}
