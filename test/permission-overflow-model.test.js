"use strict";

const assert = require("node:assert");
const { describe, it } = require("node:test");

const {
  getPermissionSessionKey,
  groupPermissionEntries,
  selectOverflowRepresentatives,
} = require("../src/permission-overflow-model");
const { computeQueueCommitDeadline } = require("../src/permission").__test;

function entry(id, ordinal, sessionId, agentId = "claude-code", extra = {}) {
  return {
    uiEntryId: id,
    uiOrdinal: ordinal,
    sessionId,
    agentId,
    ...extra,
  };
}

describe("permission overflow model", () => {
  it("groups by agent and session while keeping missing sessions separate", () => {
    const entries = [
      entry("a", 1, "same", "claude-code"),
      entry("b", 2, "same", "codex"),
      entry("c", 3, "", "claude-code"),
      entry("d", 4, "", "claude-code"),
    ];
    const groups = groupPermissionEntries(entries);
    assert.deepStrictEqual(groups.map((group) => group.entries.map((item) => item.uiEntryId)), [
      ["a"], ["b"], ["c"], ["d"],
    ]);
    assert.notStrictEqual(getPermissionSessionKey(entries[2]), getPermissionSessionKey(entries[3]));
  });

  it("keeps one FIFO representative per session and sends the rest to the queue", () => {
    const entries = [
      entry("a1", 1, "a"),
      entry("a2", 2, "a"),
      entry("b1", 3, "b"),
      entry("b2", 4, "b"),
    ];
    const result = selectOverflowRepresentatives(entries, {
      canFit: (candidate) => candidate.length <= 2,
    });
    assert.deepStrictEqual(result.visibleEntries.map((item) => item.uiEntryId), ["a1", "b1"]);
    assert.deepStrictEqual(result.hiddenEntries.map((item) => item.uiEntryId), ["a2", "b2"]);
  });

  it("preserves the expanded or explicitly selected owner before optional reps", () => {
    const entries = [
      entry("a1", 1, "a"),
      entry("a2", 2, "a", "claude-code", { expanded: true }),
      entry("b1", 3, "b"),
      entry("c1", 4, "c"),
    ];
    const selectedBySession = new Map([[getPermissionSessionKey(entries[3]), "c1"]]);
    const result = selectOverflowRepresentatives(entries, {
      selectedBySession,
      selectedGlobalEntryId: "c1",
      isProtected: (item) => item.expanded === true,
      canFit: (candidate) => candidate.length <= 2,
    });
    assert.deepStrictEqual(result.visibleEntries.map((item) => item.uiEntryId), ["a2", "c1"]);
  });

  it("keeps every protected request when one session also has a preferred representative", () => {
    const entries = [
      entry("a1", 1, "same"),
      entry("a2", 2, "same", "claude-code", { expanded: true }),
      entry("b1", 3, "other", "codex"),
    ];
    const result = selectOverflowRepresentatives(entries, {
      selectedBySession: new Map([[getPermissionSessionKey(entries[0]), "a1"]]),
      selectedGlobalEntryId: "a1",
      isProtected: (item) => item.expanded === true,
      canFit: (candidate) => candidate.length <= 2,
    });

    assert.deepStrictEqual(result.visibleEntries.map((item) => item.uiEntryId), ["a1", "a2"]);
    assert.deepStrictEqual(result.hiddenEntries.map((item) => item.uiEntryId), ["b1"]);
  });

  it("never renews an unacknowledged queue episode deadline", () => {
    const first = computeQueueCommitDeadline(0, 1000, 1500);
    assert.strictEqual(first, 2500);
    assert.strictEqual(computeQueueCommitDeadline(first, 1800, 1500), 2500);
    assert.strictEqual(computeQueueCommitDeadline(first, 3000, 1500), 2500,
      "an already-expired absolute deadline must fail, not be refreshed");
  });
});
