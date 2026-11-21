"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const createCodexRemoteFallbackNotice = require("../src/codex-remote-fallback-notice");
const { isCodexRemoteFallbackSuppressed } = createCodexRemoteFallbackNotice;
const { makeSessionKey } = require("../src/session-key");

const SESSION_A = makeSessionKey({ profileId: "host-a", rawSessionId: "codex:session-a" });
const SESSION_A2 = makeSessionKey({ profileId: "host-b", rawSessionId: "codex:session-a" });

function fakeClock(start = 1_000) {
  let now = start;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++nextId;
      timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    tick(ms) {
      now += ms;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        if (!timers.delete(id)) continue;
        timer.fn();
      }
    },
    callbacks() {
      return [...timers.values()].map((timer) => timer.fn);
    },
    get size() {
      return timers.size;
    },
  };
}

function createHarness({ isSuppressed: overrideSuppressed, refresh: overrideRefresh } = {}) {
  const clock = fakeClock();
  const shown = [];
  const refreshed = [];
  const dismissed = [];
  let suppressed = false;
  const manager = createCodexRemoteFallbackNotice({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    isSuppressed: typeof overrideSuppressed === "function"
      ? overrideSuppressed
      : () => suppressed,
    show: (payload) => {
      const entry = { ...payload };
      shown.push(entry);
      return entry;
    },
    refresh: (entry, payload) => {
      refreshed.push({ entry, payload });
      if (typeof overrideRefresh === "function") return overrideRefresh(entry, payload);
      Object.assign(entry, payload);
      return true;
    },
    dismiss: (entry, reason) => dismissed.push({ entry, reason }),
  });
  return {
    clock,
    shown,
    refreshed,
    dismissed,
    manager,
    setSuppressed(value) {
      suppressed = value;
    },
  };
}

function request(overrides = {}) {
  return {
    sessionId: SESSION_A,
    rawSessionId: "codex:session-a",
    profileId: "host-a",
    host: "host-a",
    toolName: "mcp__playwright__browser_navigate",
    toolInput: { url: "https://example.com" },
    toolUseId: "call-1",
    toolInputFingerprint: "fp-1",
    turnId: "turn-1",
    ...overrides,
  };
}

describe("Codex remote MCP: fallback notice scheduler", () => {
  it("waits 2.5 seconds before showing a queued notice", () => {
    const h = createHarness();
    assert.equal(h.manager.notify(request()), true);
    h.clock.tick(2_499);
    assert.equal(h.shown.length, 0);
    h.clock.tick(1);
    assert.equal(h.shown.length, 1);
    assert.equal(h.shown[0].sessionId, SESSION_A);
    assert.equal(h.shown[0].rawSessionId, "codex:session-a");
    assert.equal(h.shown[0].profileId, "host-a");
    assert.equal(h.shown[0].toolName, "mcp__playwright__browser_navigate");
  });

  it("does not show when a matching PostToolUse arrives first", () => {
    const h = createHarness();
    h.manager.notify(request());
    h.clock.tick(1_000);
    assert.equal(h.manager.handleStateEvent({
      sessionId: SESSION_A,
      event: "PostToolUse",
      toolName: "mcp__playwright__browser_navigate",
      toolUseId: "call-1",
      toolInputFingerprint: "fp-1",
      turnId: "turn-1",
    }), true);
    h.clock.tick(2_000);
    assert.equal(h.shown.length, 0);
  });

  it("Codex remote MCP: retires dismissed cards even when refresh would accept them", () => {
    const h = createHarness({ refresh: () => true });
    h.manager.notify(request({ toolName: "tool-old", toolUseId: "call-old" }));
    h.clock.tick(2_500);
    assert.equal(h.shown.length, 1);

    h.manager.noteCardDismissed(SESSION_A, h.shown[0]);
    h.manager.notify(request({ toolName: "tool-new", toolUseId: "call-new" }));
    assert.equal(h.refreshed.length, 0);
    assert.equal(h.shown.length, 1);
    h.clock.tick(2_499);
    assert.equal(h.shown.length, 1);
    h.clock.tick(1);
    assert.equal(h.shown.length, 2);
    assert.equal(h.shown[1].toolName, "tool-new");

    h.manager.handleStateEvent({
      sessionId: SESSION_A,
      event: "PostToolUse",
      toolUseId: "call-new",
    });
    assert.equal(h.dismissed.length, 1);
    assert.equal(h.dismissed[0].entry, h.shown[1]);
    assert.equal(h.manager.handleStateEvent({
      sessionId: SESSION_A,
      event: "PostToolUse",
      toolUseId: "call-old",
    }), false);
  });

  it("Codex remote MCP: drops stale requests when the card dismissal callback is missing", () => {
    const h = createHarness({ refresh: () => false });
    h.manager.notify(request({ toolName: "tool-old", toolUseId: "call-old" }));
    h.clock.tick(2_500);
    assert.equal(h.shown.length, 1);

    // No dismissal callback reaches the manager, so refresh must retire the
    // old requests before the new one starts its grace period.
    h.manager.notify(request({ toolName: "tool-new", toolUseId: "call-new" }));
    assert.equal(h.refreshed.length, 1);
    assert.equal(h.shown.length, 1);
    h.clock.tick(2_499);
    assert.equal(h.shown.length, 1);
    h.clock.tick(1);
    assert.equal(h.shown.length, 2);
    assert.equal(h.shown[1].toolName, "tool-new");

    h.manager.handleStateEvent({
      sessionId: SESSION_A,
      event: "PostToolUse",
      toolUseId: "call-new",
    });
    assert.equal(h.dismissed.length, 1);
    assert.equal(h.dismissed[0].entry, h.shown[1]);
    assert.equal(h.manager.handleStateEvent({
      sessionId: SESSION_A,
      event: "PostToolUse",
      toolUseId: "call-old",
    }), false);
  });

  it("keeps a parallel sibling when a different request finishes", () => {
    const h = createHarness();
    h.manager.notify(request({ toolUseId: "call-a", toolInputFingerprint: "fp-a" }));
    h.manager.notify(request({
      toolName: "mcp__github__get_issue",
      toolInput: { number: 2 },
      toolUseId: "call-b",
      toolInputFingerprint: "fp-b",
    }));
    h.clock.tick(2_500);
    assert.equal(h.shown.length, 1);
    assert.equal(h.shown[0].toolName, "mcp__github__get_issue");

    h.manager.handleStateEvent({
      sessionId: SESSION_A,
      event: "PostToolUse",
      toolName: "mcp__playwright__browser_navigate",
      toolUseId: "call-a",
      toolInputFingerprint: "fp-a",
      turnId: "turn-1",
    });
    assert.equal(h.dismissed.length, 0);
    assert.equal(h.manager.handleStateEvent({ sessionId: SESSION_A, event: "SessionEnd" }), true);
    assert.equal(h.dismissed.length, 1);
  });

  it("replaces a queued request with the same tool_use_id and retires it on PostToolUse", () => {
    const h = createHarness();
    h.manager.notify(request());
    h.manager.notify(request({ toolInput: { url: "https://latest.example" } }));
    h.clock.tick(2_500);
    assert.equal(h.shown.length, 1);
    assert.deepEqual(h.shown[0].toolInput, { url: "https://latest.example" });

    assert.equal(h.manager.handleStateEvent({
      sessionId: SESSION_A,
      event: "PostToolUse",
      toolUseId: "call-1",
    }), true);
    assert.equal(h.dismissed.length, 1);
    assert.equal(h.manager.handleStateEvent({
      sessionId: SESSION_A,
      event: "PostToolUse",
      toolUseId: "call-1",
    }), false);
  });

  it("replaces a visible request with the same tool_use_id without leaving a stale item", () => {
    const h = createHarness();
    h.manager.notify(request());
    h.clock.tick(2_500);
    h.manager.notify(request({ toolInput: { url: "https://latest.example" } }));
    assert.equal(h.shown.length, 1);
    assert.equal(h.refreshed.length, 1);
    assert.deepEqual(h.shown[0].toolInput, { url: "https://latest.example" });

    assert.equal(h.manager.handleStateEvent({
      sessionId: SESSION_A,
      event: "PostToolUse",
      toolUseId: "call-1",
    }), true);
    assert.equal(h.dismissed.length, 1);
  });

  it("keeps the notice when two concurrent requests are indistinguishable", () => {
    const h = createHarness();
    h.manager.notify(request({ toolUseId: null }));
    h.manager.notify(request({ toolUseId: null }));
    h.manager.handleStateEvent({
      sessionId: SESSION_A,
      event: "PostToolUse",
      toolName: "mcp__playwright__browser_navigate",
      toolInputFingerprint: "fp-1",
      turnId: "turn-1",
    });
    h.clock.tick(2_500);
    assert.equal(h.shown.length, 1);
  });

  it("does not remove a request when a different tool_use_id shares its name and fingerprint", () => {
    const h = createHarness();
    h.manager.notify(request({ toolUseId: "call-a" }));
    h.clock.tick(1_000);
    h.manager.handleStateEvent({
      sessionId: SESSION_A,
      event: "PostToolUse",
      toolName: "mcp__playwright__browser_navigate",
      toolUseId: "call-b",
      toolInputFingerprint: "fp-1",
      turnId: "turn-1",
    });
    h.clock.tick(2_000);
    assert.equal(h.shown.length, 1);
    assert.equal(h.dismissed.length, 0);
  });

  it("keeps both identical concurrent requests through ambiguous PostToolUse events", () => {
    const h = createHarness();
    h.manager.notify(request({ toolUseId: null }));
    h.manager.notify(request({ toolUseId: null }));
    h.clock.tick(2_500);
    assert.equal(h.shown.length, 1);

    const ambiguous = {
      sessionId: SESSION_A,
      event: "PostToolUse",
      toolName: "mcp__playwright__browser_navigate",
      toolInputFingerprint: "fp-1",
      turnId: "turn-1",
    };
    h.manager.handleStateEvent(ambiguous);
    assert.equal(h.dismissed.length, 0);
    h.manager.handleStateEvent(ambiguous);
    assert.equal(h.dismissed.length, 0);
  });

  it("retires older-turn requests when a new prompt starts a new turn", () => {
    const h = createHarness();
    h.manager.notify(request({ toolUseId: "call-old", turnId: "turn-old" }));
    h.manager.notify(request({
      toolUseId: "call-new",
      toolInputFingerprint: "fp-new",
      turnId: "turn-new",
    }));
    h.clock.tick(2_500);
    assert.equal(h.shown.length, 1);

    h.manager.handleStateEvent({
      sessionId: SESSION_A,
      event: "UserPromptSubmit",
      turnId: "turn-new",
    });
    assert.equal(h.dismissed.length, 0);
    h.manager.handleStateEvent({
      sessionId: SESSION_A,
      event: "PostToolUse",
      toolName: "mcp__playwright__browser_navigate",
      toolUseId: "call-new",
      toolInputFingerprint: "fp-new",
      turnId: "turn-new",
    });
    assert.equal(h.dismissed.length, 1);
  });

  it("keeps same-turn requests when UserPromptSubmit reuses that turn", () => {
    const h = createHarness();
    h.manager.notify(request({ turnId: "turn-1" }));
    h.clock.tick(2_500);
    assert.equal(h.shown.length, 1);

    h.manager.handleStateEvent({
      sessionId: SESSION_A,
      event: "UserPromptSubmit",
      turnId: "turn-1",
    });
    assert.equal(h.dismissed.length, 0);
    h.manager.handleStateEvent({
      sessionId: SESSION_A,
      event: "PostToolUse",
      toolName: "mcp__playwright__browser_navigate",
      toolUseId: "call-1",
      toolInputFingerprint: "fp-1",
      turnId: "turn-1",
    });
    assert.equal(h.dismissed.length, 1);
  });

  it("Codex remote MCP: a new prompt keeps requests without a turn id and removes old turns", () => {
    const h = createHarness();
    h.manager.notify(request({ toolName: "tool-no-turn", toolUseId: "call-no-turn", turnId: null }));
    h.manager.notify(request({ toolName: "tool-old", toolUseId: "call-old", turnId: "turn-old" }));
    h.clock.tick(2_500);
    assert.equal(h.shown.length, 1);
    assert.equal(h.shown[0].toolName, "tool-old");

    assert.equal(h.manager.handleStateEvent({
      sessionId: SESSION_A,
      event: "UserPromptSubmit",
      turnId: "turn-new",
    }), true);
    assert.equal(h.dismissed.length, 0);
    assert.equal(h.shown[0].toolName, "tool-no-turn");
    assert.equal(h.manager.handleStateEvent({
      sessionId: SESSION_A,
      event: "PostToolUse",
      toolUseId: "call-old",
    }), false);
    assert.equal(h.manager.handleStateEvent({
      sessionId: SESSION_A,
      event: "PostToolUse",
      toolUseId: "call-no-turn",
    }), true);
    assert.equal(h.dismissed.length, 1);
  });

  it("ignores Stop, Interrupt and UserPromptSubmit without a turn id", () => {
    for (const event of ["Stop", "Interrupt", "UserPromptSubmit"]) {
      const h = createHarness();
      h.manager.notify(request({ turnId: "turn-1" }));
      assert.equal(h.manager.handleStateEvent({ sessionId: SESSION_A, event }), false);
      h.clock.tick(2_500);
      assert.equal(h.shown.length, 1, event);
      assert.equal(h.dismissed.length, 0, event);
    }
  });

  it("separates profiles that reuse the same raw session id", () => {
    const h = createHarness();
    h.manager.notify(request());
    h.manager.notify(request({
      sessionId: SESSION_A2,
      rawSessionId: "codex:session-a",
      profileId: "host-b",
      host: "host-b",
      toolUseId: "call-2",
      toolInputFingerprint: "fp-2",
    }));
    h.manager.handleStateEvent({
      sessionId: SESSION_A,
      event: "PostToolUse",
      toolName: "mcp__playwright__browser_navigate",
      toolUseId: "call-1",
      toolInputFingerprint: "fp-1",
      turnId: "turn-1",
    });
    h.clock.tick(2_500);
    assert.equal(h.shown.length, 1);
    assert.equal(h.shown[0].sessionId, SESSION_A2);
    assert.equal(h.shown[0].host, "host-b");
  });

  it("ignores an old turn's late Stop and Interrupt", () => {
    const h = createHarness();
    h.manager.notify(request({ turnId: "turn-new" }));
    h.clock.tick(2_500);
    assert.equal(h.shown.length, 1);
    h.manager.handleStateEvent({ sessionId: SESSION_A, event: "Stop", turnId: "turn-old" });
    h.manager.handleStateEvent({ sessionId: SESSION_A, event: "Interrupt", turnId: "turn-old" });
    assert.equal(h.dismissed.length, 0);
    h.manager.handleStateEvent({ sessionId: SESSION_A, event: "Stop", turnId: "turn-new" });
    assert.equal(h.dismissed.length, 1);
  });

  it("does not resurrect a queued notice when notification is turned off and back on", () => {
    const h = createHarness();
    h.manager.notify(request());
    h.setSuppressed(true);
    h.manager.invalidateAll("notification-disabled");
    h.setSuppressed(false);
    h.clock.tick(2_500);
    assert.equal(h.shown.length, 0);
    assert.equal(h.clock.size, 0);
  });

  it("does not show when suppression turns on during the grace period without invalidation", () => {
    const h = createHarness();
    h.manager.notify(request());
    h.setSuppressed(true);
    h.clock.tick(2_500);
    assert.equal(h.shown.length, 0);
    assert.equal(h.clock.size, 0);
  });

  it("uses the global permission bubble switch in the shared suppression check", () => {
    const ctxFor = (policies) => ({
      doNotDisturb: false,
      isAgentEnabled: () => true,
      isAgentPermissionsEnabled: () => true,
      getBubblePolicy: (kind) => policies[kind] || { enabled: true, autoCloseMs: 0 },
    });
    assert.equal(isCodexRemoteFallbackSuppressed(ctxFor({
      notification: { enabled: true, autoCloseMs: 6_000 },
      permission: { enabled: false, autoCloseMs: 0 },
    })), true);
    assert.equal(isCodexRemoteFallbackSuppressed(ctxFor({
      notification: { enabled: false, autoCloseMs: 0 },
      permission: { enabled: true, autoCloseMs: 0 },
    })), true);
    assert.equal(isCodexRemoteFallbackSuppressed(ctxFor({
      notification: { enabled: true, autoCloseMs: 6_000 },
      permission: { enabled: true, autoCloseMs: 0 },
    })), false);
    assert.equal(isCodexRemoteFallbackSuppressed({ ...ctxFor({}), doNotDisturb: true }), true);
    assert.equal(isCodexRemoteFallbackSuppressed({ ...ctxFor({}), isAgentEnabled: () => false }), true);
    assert.equal(isCodexRemoteFallbackSuppressed({ ...ctxFor({}), isAgentPermissionsEnabled: () => false }), true);
  });

  it("does not queue when the global permission bubble switch is off", () => {
    const ctx = {
      doNotDisturb: false,
      isAgentEnabled: () => true,
      isAgentPermissionsEnabled: () => true,
      getBubblePolicy: (kind) => (
        kind === "permission"
          ? { enabled: false, autoCloseMs: 0 }
          : { enabled: true, autoCloseMs: 6_000 }
      ),
    };
    const h = createHarness({ isSuppressed: () => isCodexRemoteFallbackSuppressed(ctx) });
    assert.equal(h.manager.notify(request()), false);
    assert.equal(h.shown.length, 0);
    assert.equal(h.clock.size, 0);
  });

  it("stops a queued notice when the global permission bubble switch turns off", () => {
    let permissionEnabled = true;
    const ctx = {
      doNotDisturb: false,
      isAgentEnabled: () => true,
      isAgentPermissionsEnabled: () => true,
      getBubblePolicy: (kind) => (
        kind === "permission"
          ? { enabled: permissionEnabled, autoCloseMs: 0 }
          : { enabled: true, autoCloseMs: 6_000 }
      ),
    };
    const h = createHarness({ isSuppressed: () => isCodexRemoteFallbackSuppressed(ctx) });
    h.manager.notify(request());
    permissionEnabled = false;
    h.clock.tick(2_500);
    assert.equal(h.shown.length, 0);
    assert.equal(h.clock.size, 0);
  });

  it("does not queue while DND, Codex or notification bubbles are off", () => {
    const h = createHarness();
    h.setSuppressed(true);
    assert.equal(h.manager.notify(request()), false);
    assert.equal(h.clock.size, 0);
    assert.equal(h.shown.length, 0);
  });

  it("clears every request in a session on SessionEnd", () => {
    const h = createHarness();
    h.manager.notify(request({ toolUseId: "call-1" }));
    h.manager.notify(request({ toolUseId: "call-2", toolInputFingerprint: "fp-2" }));
    h.clock.tick(2_500);
    assert.equal(h.shown.length, 1);
    h.manager.handleStateEvent({ sessionId: SESSION_A, event: "SessionEnd" });
    assert.equal(h.dismissed.length, 1);
    assert.equal(h.clock.size, 0);
  });

  it("clears only the matching session on SessionEnd", () => {
    const h = createHarness();
    h.manager.notify(request());
    h.manager.notify(request({
      sessionId: SESSION_A2,
      profileId: "host-b",
      host: "host-b",
      toolUseId: "call-2",
    }));
    h.clock.tick(2_500);
    assert.equal(h.shown.length, 2);
    h.manager.handleStateEvent({ sessionId: SESSION_A, event: "SessionEnd" });
    assert.equal(h.dismissed.length, 1);
    assert.equal(h.dismissed[0].entry.sessionId, SESSION_A);
  });

  it("handles every refresh return shape without creating a card", () => {
    for (const value of [false, null, undefined, true, { replacement: true }]) {
      const clock = fakeClock();
      const shown = [];
      const dismissed = [];
      const manager = createCodexRemoteFallbackNotice({
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        isSuppressed: () => false,
        show: (payload) => {
          const entry = { ...payload };
          shown.push(entry);
          return entry;
        },
        refresh: () => value,
        dismiss: (entry, reason) => dismissed.push({ entry, reason }),
      });
      manager.notify(request({ toolName: "tool-A", toolUseId: null }));
      clock.tick(2_500);
      assert.equal(shown.length, 1, String(value));

      manager.notify(request({
        toolName: "tool-B",
        toolInput: { b: 1 },
        toolUseId: null,
        toolInputFingerprint: "fp-b",
      }));
      assert.equal(shown.length, 1, String(value));

      if (value === true) {
        assert.equal(clock.size, 0, String(value));
      } else if (value && typeof value === "object") {
        assert.equal(clock.size, 0, "replacement keeps the new entry");
        manager.handleStateEvent({ sessionId: SESSION_A, event: "SessionEnd" });
        assert.equal(dismissed.length, 1, "replacement is the live entry");
        assert.equal(dismissed[0].entry, value);
      } else {
        assert.equal(clock.size, 1, `${String(value)} re-arms the grace period`);
        clock.tick(2_500);
        assert.equal(shown.length, 2, String(value));
        assert.equal(shown[1].toolName, "tool-B", String(value));
      }
      manager.dispose();
    }
  });

  it("dispose clears a queued timer and ignores its captured callback", () => {
    const h = createHarness();
    h.manager.notify(request());
    h.clock.tick(2_500);
    assert.equal(h.shown.length, 1);

    h.manager.notify(request({
      sessionId: SESSION_A2,
      profileId: "host-b",
      host: "host-b",
      toolUseId: "call-2",
    }));
    const queuedCallbacks = h.clock.callbacks();
    assert.equal(queuedCallbacks.length, 1);
    h.manager.dispose();
    assert.equal(h.clock.size, 0);
    for (const callback of queuedCallbacks) callback();
    assert.equal(h.shown.length, 1);
    assert.equal(h.dismissed.length, 1);
  });

  it("dispose clears timers and shown cards", () => {
    const h = createHarness();
    h.manager.notify(request());
    h.manager.notify(request({
      sessionId: SESSION_A2,
      profileId: "host-b",
      host: "host-b",
      toolUseId: "call-2",
    }));
    h.clock.tick(2_500);
    assert.equal(h.shown.length, 2);
    h.manager.dispose();
    assert.equal(h.clock.size, 0);
    assert.equal(h.dismissed.length, 2);
    assert.equal(h.manager.notify(request()), false);
  });
});
