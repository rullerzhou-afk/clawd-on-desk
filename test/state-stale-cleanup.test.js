"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  SESSION_STALE_MS,
  WORKING_STALE_MS,
  DETACHED_IDLE_STALE_MS,
  CODEX_LOCAL_WORKING_STALE_FLOOR_MS,
  isWorkingLikeState,
  isLocalCodexWorkingLikeSession,
  isLocalZcodeDesktopIdleSession,
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

function desktopSession(overrides = {}) {
  return session({
    agentId: "codex",
    codexOriginator: "codex_work_desktop",
    agentPid: 10,
    sourcePid: 10,
    ...overrides,
  });
}

function zcodeDesktopSession(overrides = {}) {
  return session({
    agentId: "zcode",
    agentPid: 30,
    sourcePid: 31,
    ...overrides,
  });
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
    assert.strictEqual(isLocalCodexWorkingLikeSession(session({
      state: "working",
      agentId: "codex",
    })), true);
    assert.strictEqual(isLocalCodexWorkingLikeSession(session({
      state: "working",
      agentId: "codex",
      host: "ssh:example.com",
    })), false);
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

  it("keeps an idle Codex Desktop thread before its configured timeout", () => {
    const { result } = decision(desktopSession({
      updatedAt: 1000000 - 59_999,
    }), {
      alivePids: new Set([10]),
      staleConfig: { sessionStaleMs: 60_000 },
    });

    assert.deepStrictEqual(result, { action: null });
  });

  it("deletes an idle Codex Desktop thread after timeout even while its shared pid is alive", () => {
    const { result, calls } = decision(desktopSession({
      updatedAt: 1000000 - 60_001,
    }), {
      alivePids: new Set([10]),
      staleConfig: { sessionStaleMs: 60_000 },
    });

    assert.deepStrictEqual(result, { action: "delete", reason: "codex-desktop-idle-timeout" });
    assert.deepStrictEqual(calls, [10]);
  });

  it("keeps idle Codex Desktop threads forever when sessionStaleMs=0", () => {
    const { result } = decision(desktopSession({
      updatedAt: 1000000 - 24 * 60 * 60 * 1000,
    }), {
      alivePids: new Set([10]),
      staleConfig: { sessionStaleMs: 0 },
    });

    assert.deepStrictEqual(result, { action: null });
  });

  it("restarts the Codex Desktop idle timeout from ackedAt", () => {
    const { result } = decision(desktopSession({
      updatedAt: 1000000 - 120_000,
      ackedAt: 1000000 - 30_000,
    }), {
      alivePids: new Set([10]),
      staleConfig: { sessionStaleMs: 60_000 },
    });

    assert.deepStrictEqual(result, { action: null });
  });

  it("does not apply the Desktop idle timeout to guardian, remote, or unknown Codex sessions", () => {
    const staleConfig = { sessionStaleMs: 60_000 };
    const alivePids = new Set([10]);
    const updatedAt = 1000000 - 60_001;
    const cases = [
      desktopSession({ headless: true, updatedAt }),
      desktopSession({ host: "remote-box", updatedAt }),
      desktopSession({ codexOriginator: "codex_exec", updatedAt }),
      desktopSession({ codexOriginator: null, updatedAt }),
    ];

    for (const target of cases) {
      assert.deepStrictEqual(decision(target, { alivePids, staleConfig }).result, { action: null });
    }
  });

  it("deletes an idle local ZCode conversation after timeout even while shared pids are alive", () => {
    const { result, calls } = decision(zcodeDesktopSession({
      updatedAt: 1000000 - 60_001,
    }), {
      alivePids: new Set([30, 31]),
      staleConfig: { sessionStaleMs: 60_000 },
    });

    assert.strictEqual(isLocalZcodeDesktopIdleSession(zcodeDesktopSession()), true);
    assert.deepStrictEqual(result, { action: "delete", reason: "zcode-desktop-idle-timeout" });
    assert.deepStrictEqual(calls, [30]);
  });

  it("keeps ZCode conversations before the cutoff or when the cutoff is disabled", () => {
    const alivePids = new Set([30, 31]);
    assert.deepStrictEqual(decision(zcodeDesktopSession({
      updatedAt: 1000000 - 59_999,
    }), {
      alivePids,
      staleConfig: { sessionStaleMs: 60_000 },
    }).result, { action: null });
    assert.deepStrictEqual(decision(zcodeDesktopSession({
      updatedAt: 1000000 - 24 * 60 * 60 * 1000,
    }), {
      alivePids,
      staleConfig: { sessionStaleMs: 0 },
    }).result, { action: null });
  });

  it("does not apply the ZCode idle timeout to remote, headless, or working sessions", () => {
    const updatedAt = 1000000 - 60_001;
    const alivePids = new Set([30, 31]);
    const staleConfig = { sessionStaleMs: 60_000 };
    const cases = [
      zcodeDesktopSession({ host: "remote-box", updatedAt }),
      zcodeDesktopSession({ headless: true, updatedAt }),
      zcodeDesktopSession({ state: "working", updatedAt }),
    ];
    for (const target of cases) {
      const result = decision(target, { alivePids, staleConfig }).result;
      assert.notStrictEqual(result.reason, "zcode-desktop-idle-timeout");
    }
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

  it("keeps local Codex working through the default short stale windows", () => {
    const { result } = decision(desktopSession({
      state: "working",
      updatedAt: 1000000 - 11 * 60 * 1000,
    }), {
      alivePids: new Set([10]),
      staleConfig: { sessionStaleMs: 60_000, workingStaleMs: 60_000 },
    });
    assert.deepStrictEqual(result, { action: null });
  });

  it("keeps a local OpenCode tool active at the captured 305-second failure point", () => {
    const now = 2_000_000;
    const { result } = decision(session({
      state: "working",
      agentId: "opencode",
      agentPid: 10,
      sourcePid: 20,
      pidReachable: true,
      updatedAt: now - 305_656,
    }), {
      now,
      alivePids: new Set([10, 20]),
      staleConfig: { sessionStaleMs: 600_000, workingStaleMs: 300_000 },
    });

    assert.deepStrictEqual(result, { action: null });
  });

  it("keeps local OpenCode thinking active at the captured 305-second failure point", () => {
    const now = 2_000_000;
    const { result } = decision(session({
      state: "thinking",
      agentId: "opencode",
      agentPid: 10,
      sourcePid: 20,
      pidReachable: true,
      updatedAt: now - 305_656,
    }), {
      now,
      alivePids: new Set([10, 20]),
      staleConfig: { sessionStaleMs: 600_000, workingStaleMs: 300_000 },
    });

    assert.deepStrictEqual(result, { action: null });
  });

  it("preserves a longer configured stale timeout for local OpenCode work", () => {
    const now = 2_000_000;
    const configuredStaleMs = 30 * 60 * 1000;
    const { result } = decision(session({
      state: "working",
      agentId: "opencode",
      agentPid: 10,
      sourcePid: 20,
      pidReachable: true,
      updatedAt: now - 20 * 60 * 1000 - 1,
    }), {
      now,
      alivePids: new Set([10, 20]),
      staleConfig: {
        sessionStaleMs: configuredStaleMs,
        workingStaleMs: configuredStaleMs,
      },
    });

    assert.deepStrictEqual(result, { action: null });
  });

  it("keeps local OpenCode work active immediately before the fixed 20-minute stale floor", () => {
    const now = 2_000_000;
    const { result } = decision(session({
      state: "working",
      agentId: "opencode",
      agentPid: 10,
      sourcePid: 20,
      pidReachable: true,
      updatedAt: now - (20 * 60 * 1000 - 1),
    }), {
      now,
      alivePids: new Set([10, 20]),
    });

    assert.deepStrictEqual(result, { action: null });
  });

  it("retires local OpenCode work after the default 20-minute stale floor", () => {
    const now = 2_000_000;
    const { result } = decision(session({
      state: "working",
      agentId: "opencode",
      agentPid: 10,
      sourcePid: 20,
      pidReachable: true,
      updatedAt: now - 20 * 60 * 1000 - 1,
    }), {
      now,
      alivePids: new Set([10, 20]),
    });

    assert.deepStrictEqual(result, { action: "idle", reason: "session-timeout", updateTimestamp: false });
  });

  it("deletes local OpenCode work immediately when the agent process dies", () => {
    const now = 2_000_000;
    assert.deepStrictEqual(
      decision(session({
        state: "working",
        agentId: "opencode",
        agentPid: 10,
        sourcePid: 20,
        pidReachable: true,
        updatedAt: now - 305_656,
      }), {
        now,
        alivePids: new Set([20]),
      }).result,
      { action: "delete", reason: "agent-exit" },
    );
  });

  it("deletes local OpenCode work after the stale floor when the source process dies", () => {
    const now = 2_000_000;
    assert.deepStrictEqual(
      decision(session({
        state: "working",
        agentId: "opencode",
        agentPid: 10,
        sourcePid: 20,
        pidReachable: true,
        updatedAt: now - 20 * 60 * 1000 - 1,
      }), {
        now,
        alivePids: new Set([10]),
      }).result,
      { action: "delete", reason: "source-exit" },
    );
  });

  it("does not extend remote OpenCode or Claude working sessions", () => {
    const now = 2_000_000;
    for (const agentId of ["opencode", "claude-code"]) {
      const { result } = decision(session({
        state: "working",
        agentId,
        host: agentId === "opencode" ? "ssh:example.com" : null,
        updatedAt: now - WORKING_STALE_MS - 1,
      }), { now });
      assert.deepStrictEqual(result, { action: "idle", reason: "working-timeout", updateTimestamp: true });
    }

    const { result: headlessResult } = decision(session({
      state: "working",
      agentId: "opencode",
      headless: true,
      updatedAt: now - WORKING_STALE_MS - 1,
    }), { now });
    assert.deepStrictEqual(headlessResult, { action: "idle", reason: "working-timeout", updateTimestamp: true });
  });

  it("does not extend local MiMo Code working sessions", () => {
    const now = 2_000_000;
    const { result } = decision(session({
      state: "working",
      agentId: "mimocode",
      updatedAt: now - WORKING_STALE_MS - 1,
    }), { now });

    assert.deepStrictEqual(result, { action: "idle", reason: "working-timeout", updateTimestamp: true });
  });

  it("still downgrades local Codex working after the Codex floor expires", () => {
    const { result } = decision(session({
      state: "thinking",
      agentId: "codex",
      updatedAt: 2000000 - CODEX_LOCAL_WORKING_STALE_FLOOR_MS - 1,
      agentPid: 10,
      sourcePid: 20,
    }), {
      now: 2000000,
      alivePids: new Set([10, 20]),
    });
    assert.deepStrictEqual(result, { action: "idle", reason: "session-timeout", updateTimestamp: false });
  });

  it("ignores fresh metadataUpdatedAt when lifecycle updatedAt crossed the Codex floor", () => {
    const now = 2000000;
    const lifecycleAt = now - CODEX_LOCAL_WORKING_STALE_FLOOR_MS - 1;
    const { result } = decision(session({
      state: "working",
      agentId: "codex",
      updatedAt: lifecycleAt,
      metadataUpdatedAt: now,
      agentPid: 10,
      sourcePid: 20,
    }), {
      now,
      alivePids: new Set([10, 20]),
    });

    assert.deepStrictEqual(result, { action: "idle", reason: "session-timeout", updateTimestamp: false });
  });

  it("does not extend remote Codex working sessions", () => {
    const { result } = decision(session({
      state: "working",
      agentId: "codex",
      host: "ssh:example.com",
      updatedAt: 1000000 - WORKING_STALE_MS - 1,
      sourcePid: null,
    }));
    assert.deepStrictEqual(result, { action: "idle", reason: "working-timeout", updateTimestamp: true });
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

  it("requiresCompletionAck within the session timeout is kept (done badge stays visible)", () => {
    // Completion already pushed a notification; the session lingers only long
    // enough for the user to spot the `done` badge — bounded by sessionStaleMs.
    const { result } = decision(session({
      updatedAt: 1000000 - 3 * 60 * 1000,
      pidReachable: false,
      requiresCompletionAck: true,
    }), {
      staleConfig: { sessionStaleMs: 10 * 60 * 1000 },
    });
    assert.deepStrictEqual(result, { action: null });
  });

  it("requiresCompletionAck no longer holds a remote session past the session timeout", () => {
    // The completion notification already fired once, so an unacknowledged
    // remote session deletes at the user-configured timeout like any other
    // idle one — it does not get the old 24h hold.
    const { result } = decision(session({
      updatedAt: 1000000 - 11 * 60 * 1000,
      pidReachable: false,
      requiresCompletionAck: true,
    }), {
      staleConfig: { sessionStaleMs: 10 * 60 * 1000 },
    });
    assert.deepStrictEqual(result, { action: "delete", reason: "unreachable" });
  });

  it("requiresCompletionAck with sessionStaleMs=0 is kept forever, like a normal idle session", () => {
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
    assert.deepStrictEqual(result, { action: null });
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
});
