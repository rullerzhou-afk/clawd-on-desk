"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSessionGrantRevokeAction,
  parseSessionGrantRevokeAction,
  createRemoteCardWorkRegistry,
} = require("../src/session-automation-remote");

test("persistent revoke action has a separate exact namespace", () => {
  const action = buildSessionGrantRevokeAction("grant-1");
  assert.equal(action, "session-grant:revoke:grant-1");
  assert.equal(parseSessionGrantRevokeAction(action), "grant-1");
  assert.equal(parseSessionGrantRevokeAction("allow"), null);
  assert.equal(parseSessionGrantRevokeAction("session-grant:revoke:"), null);
});

test("card work slots transfer candidate to active and release after terminal work", async () => {
  const edits = [];
  const registry = createRemoteCardWorkRegistry({ limit: 1, deadlineMs: 100 });
  const handle = registry.reserve("candidate-grant", { messageId: "m1" });
  assert.ok(handle);
  assert.equal(registry.reserve("other", { messageId: "m2" }), null);
  assert.equal(await registry.enqueue(handle, (ref) => edits.push(["prepare", ref.messageId])), true);
  assert.equal(registry.activate(handle, "active-grant"), true);
  assert.equal(registry.hasActiveCard("active-grant", (ref) => ref.messageId === "m1"), true);
  assert.equal(registry.deactivateGrant("active-grant", (ref) => edits.push(["revoke", ref.messageId])), 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(edits, [["prepare", "m1"], ["revoke", "m1"]]);
  assert.equal(registry.size(), 0);
});

test("a client-reserved candidate can be bound to the main-generated grant exactly once", () => {
  const registry = createRemoteCardWorkRegistry({ limit: 1 });
  const handle = registry.reserve("pending:req-1", { messageId: "m1" });
  assert.ok(handle);
  assert.equal(registry.bindCandidateGrant(handle, "grant-main-1"), true);
  assert.equal(registry.hasCard("grant-main-1"), true);
  assert.equal(registry.activate(handle, "grant-main-1"), true);
  assert.equal(
    registry.bindCandidateGrant(handle, "grant-main-2"),
    false,
    "an active card cannot be rebound as a new candidate"
  );
});

test("terminal card work releases its slot after a bounded timeout", async () => {
  const registry = createRemoteCardWorkRegistry({ limit: 1, deadlineMs: 5 });
  const handle = registry.reserve("g1", { messageId: "m1" });
  let aborted = false;
  registry.activate(handle, "g1");
  registry.deactivateGrant("g1", (_ref, _grantId, { signal }) => new Promise(() => {
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
  }));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(aborted, true, "deadline must abort the adapter request itself");
  assert.equal(registry.size(), 0);
  assert.ok(registry.reserve("g2", { messageId: "m2" }));
});

test("inactive terminal work keeps its slot until finally and never exceeds the cap", async () => {
  const registry = createRemoteCardWorkRegistry({ limit: 2, deadlineMs: 10 });
  const first = registry.reserve("g1", { messageId: "m1" });
  const second = registry.reserve("g2", { messageId: "m2" });
  assert.ok(first);
  assert.ok(second);
  registry.activate(first, "g1");
  registry.activate(second, "g2");

  registry.deactivateGrant("g1", (_ref, _grantId, { signal }) => new Promise(() => {
    signal.addEventListener("abort", () => {}, { once: true });
  }));
  assert.equal(registry.size(), 2);
  assert.equal(
    registry.reserve("g3", { messageId: "m3" }),
    null,
    "inactive work must still consume its original slot"
  );

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(registry.size(), 1);
  assert.ok(registry.reserve("g3", { messageId: "m3" }));
  assert.equal(registry.size(), 2);
});

test("per-card work keeps only one merged next outcome and terminal cannot be downgraded", async () => {
  const registry = createRemoteCardWorkRegistry({ limit: 1, deadlineMs: 100 });
  const handle = registry.reserve("g1", { messageId: "m1" });
  const first = deferred();
  const seen = [];
  const p1 = registry.enqueue(handle, async (_ref, { signal }) => {
    seen.push("first");
    await Promise.race([
      first.promise,
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(
        Object.assign(new Error("aborted"), { name: "AbortError" })
      ), { once: true })),
    ]);
  }, { outcome: "preparing" });
  const p2 = registry.enqueue(handle, () => { seen.push("superseded"); }, { outcome: "active" });
  const p3 = registry.enqueue(handle, () => { seen.push("latest"); }, { outcome: "active" });
  assert.equal(await p2, false);
  first.resolve();
  assert.equal(await p1, true);
  assert.equal(await p3, true);
  assert.deepEqual(seen, ["first", "latest"]);

  const terminal = registry.enqueue(handle, () => { seen.push("terminal"); }, {
    terminal: true,
    outcome: "terminal",
  });
  assert.equal(await registry.enqueue(handle, () => { seen.push("late"); }, {
    outcome: "active",
  }), false);
  assert.equal(await terminal, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["first", "latest", "terminal"]);
  assert.equal(registry.size(), 0);
});

test("terminal work aborts an older non-terminal edit before writing the terminal outcome", async () => {
  const registry = createRemoteCardWorkRegistry({ limit: 1, deadlineMs: 100 });
  const handle = registry.reserve("g1", { messageId: "m1" });
  registry.activate(handle, "g1");
  const seen = [];
  let aborted = false;
  const older = registry.enqueue(handle, (_ref, { signal }) => new Promise((resolve, reject) => {
    seen.push("older-start");
    const onAbort = () => {
      aborted = true;
      seen.push("older-abort");
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }), { outcome: "active" });

  const terminal = registry.deactivateGrant("g1", () => {
    seen.push("terminal");
  });
  assert.equal(terminal, 1);
  assert.equal(await older, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborted, true);
  assert.deepEqual(seen, ["older-start", "older-abort", "terminal"]);
  assert.equal(registry.size(), 0);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
