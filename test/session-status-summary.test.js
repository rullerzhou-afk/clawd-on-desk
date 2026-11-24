"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  isHudSession,
  orderedHudSessions,
  statusForSession,
  summarizeSessions,
} = require("../src/session-status-summary");

function session(id, overrides = {}) {
  return {
    id,
    state: "working",
    badge: "running",
    headless: false,
    ...overrides,
  };
}

describe("persistent session status summary", () => {
  it("uses the Session HUD's visibility boundary", () => {
    assert.strictEqual(isHudSession(session("working")), true);
    assert.strictEqual(isHudSession(session("done", { state: "idle", badge: "done" })), true);
    assert.strictEqual(isHudSession(session("headless", { headless: true })), false);
    assert.strictEqual(isHudSession(session("sleeping", { state: "sleeping" })), false);
    assert.strictEqual(isHudSession(session("hidden", { hiddenFromHud: true })), false);
    assert.strictEqual(isHudSession(session("preference", { hudHiddenByPreference: true })), false);
  });

  it("preserves orderedIds and ignores malformed session entries", () => {
    assert.deepStrictEqual(
      orderedHudSessions({
        sessions: [session("old"), session("new"), null, 1, ""],
        orderedIds: ["new", "old"],
      }).map((entry) => entry.id),
      ["new", "old"]
    );
  });

  it("classifies working, done, and needs-input independently", () => {
    assert.strictEqual(statusForSession(session("working")), "working");
    assert.strictEqual(
      statusForSession(session("done", { state: "idle", badge: "done" })),
      "done"
    );
    assert.strictEqual(
      statusForSession(session("waiting", { pendingAttention: true })),
      "attention"
    );
    assert.strictEqual(
      statusForSession(session("notification", { lastEvent: { rawEvent: "Notification" } })),
      "attention"
    );
    assert.strictEqual(
      statusForSession(session("idle", { state: "idle", badge: "idle" })),
      "idle"
    );
  });

  it("counts an active subagent as working and attention as the stronger state", () => {
    assert.strictEqual(
      statusForSession(session("subagent", { badge: "done", activeSubagentCount: 2 })),
      "working"
    );
    assert.strictEqual(
      statusForSession(session("waiting-subagent", {
        pendingAttention: true,
        activeSubagentCount: 2,
      })),
      "attention"
    );
  });

  it("aggregates local and remote sessions into one persistent summary", () => {
    const summary = summarizeSessions({
      sessions: [
        session("a"),
        session("b", { host: "remote" }),
        session("c", { state: "idle", badge: "done" }),
        session("d", { pendingAttention: true }),
        session("idle", { state: "idle", badge: "idle" }),
      ],
    });
    assert.deepStrictEqual(summary.counts, {
      attention: 1,
      working: 2,
      done: 1,
      idle: 1,
    });
    assert.strictEqual(summary.total, 5);
  });
});
