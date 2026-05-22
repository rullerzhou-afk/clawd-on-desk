"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  SESSION_STALE_MS,
  WORKING_STALE_MS,
  DETACHED_IDLE_STALE_MS,
  isWorkingLikeState,
  getStaleSessionDecision,
} = require("../src/state-stale-cleanup");

function session(overrides = {}) {
  return {
    state: "idle",
    updatedAt: 1000000,
    pidReachable: true,
    sourcePid: null,
    agentPid: null,
    ...overrides,
  };
}

function decision(target, overrides = {}) {
  const calls = [];
  const alivePids = overrides.alivePids || new Set();
  const result = getStaleSessionDecision(target, {
    now: overrides.now || 1000000,
    isProcessAlive(pid) {
      calls.push(pid);
      return alivePids.has(pid);
    },
    deriveSessionBadge: overrides.deriveSessionBadge || (() => "idle"),
    shouldAutoClearDetachedSession: overrides.shouldAutoClearDetachedSession || (() => false),
    staleConfig: overrides.staleConfig,
    unackedMaxAgeMs: overrides.unackedMaxAgeMs,
  });
  return { result, calls };
}

describe("state stale cleanup decisions", () => {
  it("deletes immediately when a reachable agent pid is dead before badge checks", () => {
    let badgeCalls = 0;
    const { result, calls } = decision(session({ agentPid: 10, sourcePid: 20 }), {
      alivePids: new Set([20]),
      deriveSessionBadge: () => { badgeCalls += 1; return "done"; },
      shouldAutoClearDetachedSession: () => true,
    });

    assert.deepStrictEqual(result, { action: "delete", reason: "agent-exit" });
    assert.deepStrictEqual(calls, [10]);
    assert.strictEqual(badgeCalls, 0);
  });

  it("marks a detached ended session for HUD refresh before fast deletion threshold", () => {
    const { result, calls } = decision(session({
      updatedAt: 1000000 - DETACHED_IDLE_STALE_MS + 1,
      sourcePid: 20,
    }), {
      shouldAutoClearDetachedSession: (target, badge) => {
        assert.strictEqual(badge, "done");
        return true;
      },
      deriveSessionBadge: () => "done",
    });

    assert.deepStrictEqual(result, { action: null, snapshotRefreshNeeded: true });
    assert.deepStrictEqual(calls, []);
  });

  it("deletes a detached ended session after the fast deletion threshold", () => {
    const { result } = decision(session({
      updatedAt: 1000000 - DETACHED_IDLE_STALE_MS - 1,
      sourcePid: 20,
    }), {
      deriveSessionBadge: () => "interrupted",
      shouldAutoClearDetachedSession: () => true,
    });

    assert.deepStrictEqual(result, { action: "delete", reason: "detached-ended", badge: "interrupted" });
  });

  it("handles full stale timeout source and reachability branches", () => {
    assert.deepStrictEqual(decision(session({
      updatedAt: 1000000 - SESSION_STALE_MS - 1,
      sourcePid: 20,
    })).result, { action: "delete", reason: "source-exit" });

    assert.deepStrictEqual(decision(session({
      state: "working",
      updatedAt: 1000000 - SESSION_STALE_MS - 1,
      sourcePid: 20,
    }), {
      alivePids: new Set([20]),
    }).result, { action: "idle", reason: "session-timeout", updateTimestamp: false });

    assert.deepStrictEqual(decision(session({
      updatedAt: 1000000 - SESSION_STALE_MS - 1,
      pidReachable: false,
    })).result, { action: "delete", reason: "unreachable" });

    assert.deepStrictEqual(decision(session({
      updatedAt: 1000000 - SESSION_STALE_MS - 1,
      pidReachable: true,
      sourcePid: null,
    })).result, { action: "delete", reason: "no-source" });
  });

  it("handles working stale timeout source exit and idle downgrade", () => {
    assert.deepStrictEqual(decision(session({
      updatedAt: 1000000 - WORKING_STALE_MS - 1,
      sourcePid: 20,
    })).result, { action: "delete", reason: "working-source-exit" });

    assert.deepStrictEqual(decision(session({
      state: "thinking",
      updatedAt: 1000000 - WORKING_STALE_MS - 1,
      sourcePid: null,
    })).result, { action: "idle", reason: "working-timeout", updateTimestamp: true });

    assert.deepStrictEqual(decision(session({
      state: "idle",
      updatedAt: 1000000 - WORKING_STALE_MS - 1,
      sourcePid: null,
    })).result, { action: null });
  });

  it("keeps working-like state set explicit", () => {
    assert.strictEqual(isWorkingLikeState("working"), true);
    assert.strictEqual(isWorkingLikeState("thinking"), true);
    assert.strictEqual(isWorkingLikeState("juggling"), true);
    assert.strictEqual(isWorkingLikeState("idle"), false);
  });

  it("falls back to module defaults when no staleConfig provided", () => {
    // Regression: passing no staleConfig must behave identically to before.
    const { result } = decision(session({
      updatedAt: 1000000 - SESSION_STALE_MS - 1,
      pidReachable: false,
    }));
    assert.deepStrictEqual(result, { action: "delete", reason: "unreachable" });
  });

  it("honors a configured sessionStaleMs cutoff", () => {
    const { result } = decision(session({
      updatedAt: 1000000 - 65_000,
      pidReachable: false,
    }), {
      staleConfig: { sessionStaleMs: 60_000 },
    });
    assert.deepStrictEqual(result, { action: "delete", reason: "unreachable" });
  });

  it("treats sessionStaleMs=0 as disabled — does not delete by age", () => {
    // 10h-old idle remote session, sessionStaleMs disabled -> stays alive.
    const { result } = decision(session({
      state: "idle",
      updatedAt: 1000000 - 10 * 60 * 60 * 1000,
      pidReachable: false,
    }), {
      staleConfig: { sessionStaleMs: 0 },
    });
    assert.deepStrictEqual(result, { action: null });
  });

  it("honors a configured workingStaleMs floor", () => {
    // Bump the working timeout up so a 5-min-old working session stays
    // working instead of getting downgraded to idle.
    const { result } = decision(session({
      state: "working",
      updatedAt: 1000000 - 5 * 60 * 1000,
      sourcePid: null,
    }), {
      staleConfig: { workingStaleMs: 600_000 },
    });
    assert.deepStrictEqual(result, { action: null });
  });

  it("honors a configured detachedIdleStaleMs cutoff", () => {
    const { result } = decision(session({
      updatedAt: 1000000 - 6_000,
      sourcePid: 20,
    }), {
      staleConfig: { detachedIdleStaleMs: 5_000 },
      deriveSessionBadge: () => "done",
      shouldAutoClearDetachedSession: () => true,
    });
    assert.deepStrictEqual(result, { action: "delete", reason: "detached-ended", badge: "done" });
  });

  it("ignores non-finite staleConfig fields and falls back to defaults", () => {
    // Garbage values in any field must not break the decision.
    const { result } = decision(session({
      updatedAt: 1000000 - SESSION_STALE_MS - 1,
      pidReachable: false,
    }), {
      staleConfig: {
        sessionStaleMs: "not a number",
        workingStaleMs: null,
        detachedIdleStaleMs: NaN,
      },
    });
    assert.deepStrictEqual(result, { action: "delete", reason: "unreachable" });
  });

  // ── PR2 — requiresCompletionAck + ackedAt + global referenceTs ──

  it("un-acked remote session with old updatedAt still deletes (regression: referenceTs falls back to updatedAt)", () => {
    const { result } = decision(session({
      updatedAt: 1000000 - 11 * 60 * 1000,
      pidReachable: false,
    }), {
      staleConfig: { sessionStaleMs: 10 * 60 * 1000 },
    });
    assert.deepStrictEqual(result, { action: "delete", reason: "unreachable" });
  });

  it("acked session age uses Math.max(updatedAt, ackedAt) globally (not just inside ack-pending branch)", () => {
    // Flag already cleared post-ack; updatedAt is ancient, but ackedAt is
    // recent — referenceTs hoist must rescue the session in branch 3 too.
    const { result } = decision(session({
      updatedAt: 1000000 - 11 * 60 * 1000,
      ackedAt: 1000000 - 30 * 1000,
      pidReachable: false,
    }), {
      staleConfig: { sessionStaleMs: 10 * 60 * 1000 },
    });
    assert.deepStrictEqual(result, { action: null });
  });

  it("requiresCompletionAck=true holds an otherwise-deletable remote session", () => {
    const { result } = decision(session({
      updatedAt: 1000000 - 11 * 60 * 1000,
      pidReachable: false,
      requiresCompletionAck: true,
    }), {
      staleConfig: { sessionStaleMs: 10 * 60 * 1000 },
    });
    assert.deepStrictEqual(result, { action: null, reason: "ack-pending" });
  });

  it("requiresCompletionAck=true past 24h cap deletes with reason ack-expired", () => {
    // Use a realistic now baseline so updatedAt stays positive — the
    // global referenceTs hoist uses Math.max(updatedAt, ackedAt||0), so
    // a negative updatedAt would silently fall back to 0 and break the
    // age math.
    const now = 2_000_000_000_000;
    const { result } = decision(session({
      updatedAt: now - 86_400_000 - 1,
      pidReachable: false,
      requiresCompletionAck: true,
    }), { now });
    assert.deepStrictEqual(result, { action: "delete", reason: "ack-expired" });
  });

  it("ack-expired still fires with sessionStaleMs=0 (explicit delete, not fall-through)", () => {
    const now = 2_000_000_000_000;
    const { result } = decision(session({
      state: "idle",
      updatedAt: now - 86_400_000 - 1,
      pidReachable: false,
      requiresCompletionAck: true,
    }), {
      now,
      staleConfig: { sessionStaleMs: 0 },
    });
    assert.deepStrictEqual(result, { action: "delete", reason: "ack-expired" });
  });

  it("agent-exit wins over requiresCompletionAck", () => {
    const { result } = decision(session({
      agentPid: 99,
      pidReachable: true,
      requiresCompletionAck: true,
    }), {
      alivePids: new Set(),
    });
    assert.deepStrictEqual(result, { action: "delete", reason: "agent-exit" });
  });

  it("options.unackedMaxAgeMs overrides the 24h cap for tests", () => {
    const { result } = decision(session({
      updatedAt: 1000000 - 6 * 60 * 1000,
      pidReachable: false,
      requiresCompletionAck: true,
    }), {
      unackedMaxAgeMs: 5 * 60 * 1000,
    });
    assert.deepStrictEqual(result, { action: "delete", reason: "ack-expired" });
  });
});
