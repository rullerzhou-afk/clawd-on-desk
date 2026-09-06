"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createFocusSessionShortcutHandlers,
  getCodexThreadId,
  getCodexThreadUrl,
  getDirectSendFocusTarget,
  getFocusableLocalHudSessionIds,
  getShortcutFocusableHudSessionIds,
  getSessionFocusTarget,
  isFocusableLocalHudSession,
  isShortcutFocusableHudSession,
} = require("../src/session-focus");
const { makeSessionKey } = require("../src/session-key");

describe("session focus helpers", () => {
  it("selects local HUD-visible terminal and Codex Desktop thread sessions", () => {
    const snapshot = {
      sessions: [
        { id: "local", sourcePid: 1000, state: "working" },
        { id: "no-pid", sourcePid: null, state: "working" },
        { id: "headless", sourcePid: 1001, headless: true, state: "working" },
        { id: "sleeping", sourcePid: 1002, state: "sleeping" },
        { id: "hidden", sourcePid: 1003, state: "idle", hiddenFromHud: true },
        { id: "remote", sourcePid: 1004, state: "working", host: "remote-box" },
        {
          id: "remote-orca",
          sourcePid: null,
          state: "working",
          host: "remote-box",
          orcaPaneKey: "tab-remote:leaf-remote",
        },
        { id: "webui", sourcePid: 1005, state: "working", platform: "webui" },
        {
          id: "codex:019e115a-4df2-7ed0-b90e-8e6345aca777",
          agentId: "codex",
          state: "working",
          codexOriginator: "codex_work_desktop",
        },
      ],
    };

    assert.deepStrictEqual(getFocusableLocalHudSessionIds(snapshot), [
      "local",
      "codex:019e115a-4df2-7ed0-b90e-8e6345aca777",
    ]);
  });

  it("derives Codex Desktop thread focus targets", () => {
    const entry = {
      id: "codex:019e115a-4df2-7ed0-b90e-8e6345aca777",
      agentId: "codex",
      codexOriginator: "codex_work_desktop",
    };

    assert.strictEqual(getCodexThreadId(entry), "019e115a-4df2-7ed0-b90e-8e6345aca777");
    assert.strictEqual(getCodexThreadId({
      id: entry.id,
      agentId: "codex",
      originator: "Codex Desktop",
    }), "019e115a-4df2-7ed0-b90e-8e6345aca777");
    assert.strictEqual(getCodexThreadUrl(entry), "codex://threads/019e115a-4df2-7ed0-b90e-8e6345aca777");
    assert.deepStrictEqual(getSessionFocusTarget(entry), {
      canFocus: true,
      type: "codex-thread",
      url: "codex://threads/019e115a-4df2-7ed0-b90e-8e6345aca777",
    });
    assert.deepStrictEqual(getSessionFocusTarget({ id: "local", sourcePid: 10 }), {
      canFocus: true,
      type: "terminal",
      url: null,
    });
    assert.deepStrictEqual(getSessionFocusTarget({ id: "web", sourcePid: 10, platform: "webui" }), {
      canFocus: false,
      type: null,
      url: null,
    });
    assert.deepStrictEqual(getSessionFocusTarget({ ...entry, platform: "webui" }), {
      canFocus: false,
      type: null,
      url: null,
    });
  });

  it("derives Codex Desktop thread focus targets from profile-scoped session entries", () => {
    const rawSessionId = "codex:019e115a-4df2-7ed0-b90e-8e6345aca777";
    const entry = {
      id: makeSessionKey({ profileId: "local", rawSessionId }),
      rawSessionId,
      agentId: "codex",
      codexOriginator: "Codex Desktop",
    };

    assert.strictEqual(getCodexThreadId(entry), "019e115a-4df2-7ed0-b90e-8e6345aca777");
    assert.strictEqual(getCodexThreadUrl(entry), "codex://threads/019e115a-4df2-7ed0-b90e-8e6345aca777");
    assert.deepStrictEqual(getSessionFocusTarget(entry, { osPlatform: "darwin" }), {
      canFocus: true,
      type: "codex-thread",
      url: "codex://threads/019e115a-4df2-7ed0-b90e-8e6345aca777",
    });
  });

  it("uses Codex Desktop thread focus targets on Windows", () => {
    const entry = {
      id: "codex:019e115a-4df2-7ed0-b90e-8e6345aca777",
      agentId: "codex",
      codexOriginator: "codex_work_desktop",
      sourcePid: 123,
      state: "working",
    };
    const noTerminalEntry = {
      id: "codex:019e115b-4df2-7ed0-b90e-8e6345aca777",
      agentId: "codex",
      codexOriginator: "codex_work_desktop",
      state: "working",
    };

    assert.deepStrictEqual(getSessionFocusTarget(entry, { osPlatform: "win32" }), {
      canFocus: true,
      type: "codex-thread",
      url: "codex://threads/019e115a-4df2-7ed0-b90e-8e6345aca777",
    });
    assert.deepStrictEqual(getSessionFocusTarget(noTerminalEntry, { osPlatform: "win32" }), {
      canFocus: true,
      type: "codex-thread",
      url: "codex://threads/019e115b-4df2-7ed0-b90e-8e6345aca777",
    });
    assert.deepStrictEqual(getSessionFocusTarget(noTerminalEntry, { osPlatform: "darwin" }), {
      canFocus: true,
      type: "codex-thread",
      url: "codex://threads/019e115b-4df2-7ed0-b90e-8e6345aca777",
    });
    assert.deepStrictEqual(getFocusableLocalHudSessionIds({
      sessions: [entry, noTerminalEntry],
    }, { osPlatform: "win32" }), [
      "codex:019e115a-4df2-7ed0-b90e-8e6345aca777",
      "codex:019e115b-4df2-7ed0-b90e-8e6345aca777",
    ]);
    assert.strictEqual(isFocusableLocalHudSession(noTerminalEntry, { osPlatform: "win32" }), true);
  });

  it("keeps Codex Desktop out of the Direct Send paste target", () => {
    const entry = {
      id: "codex:019e115a-4df2-7ed0-b90e-8e6345aca777",
      agentId: "codex",
      codexOriginator: "codex_work_desktop",
      sourcePid: 123,
    };

    assert.deepStrictEqual(getSessionFocusTarget(entry, { osPlatform: "win32" }), {
      canFocus: true,
      type: "codex-thread",
      url: "codex://threads/019e115a-4df2-7ed0-b90e-8e6345aca777",
    });
    assert.deepStrictEqual(getDirectSendFocusTarget(entry, { osPlatform: "win32" }), {
      canFocus: false,
      type: "codex-thread",
      url: "codex://threads/019e115a-4df2-7ed0-b90e-8e6345aca777",
      reason: "codex_desktop_requires_manual_paste",
    });
    assert.deepStrictEqual(getDirectSendFocusTarget({
      id: "cli-session",
      agentId: "codex",
      sourcePid: 123,
    }, { osPlatform: "win32" }), {
      canFocus: true,
      type: "terminal",
      url: null,
    });
  });

  it("uses Desktop identity rather than the parsed navigation target for Direct Send", () => {
    const malformedDesktop = {
      id: "codex:not-a-uuid",
      agentId: "codex",
      originator: "Codex Desktop",
      sourcePid: 123,
    };
    const desktopWithOrcaPane = {
      id: "codex:019e115a-4df2-7ed0-b90e-8e6345aca777",
      agentId: "codex",
      codexOriginator: "codex_work_desktop",
      sourcePid: null,
      orcaPaneKey: "tab-local:leaf-local",
    };

    assert.deepStrictEqual(getSessionFocusTarget(malformedDesktop, { osPlatform: "win32" }), {
      canFocus: true,
      type: "terminal",
      url: null,
    });
    assert.deepStrictEqual(getDirectSendFocusTarget(malformedDesktop, { osPlatform: "win32" }), {
      canFocus: false,
      type: "codex-thread",
      url: null,
      reason: "codex_desktop_requires_manual_paste",
    });
    assert.deepStrictEqual(getSessionFocusTarget(desktopWithOrcaPane, { osPlatform: "win32" }), {
      canFocus: true,
      type: "terminal",
      url: null,
    });
    assert.deepStrictEqual(getDirectSendFocusTarget(desktopWithOrcaPane, { osPlatform: "win32" }), {
      canFocus: false,
      type: "codex-thread",
      url: "codex://threads/019e115a-4df2-7ed0-b90e-8e6345aca777",
      reason: "codex_desktop_requires_manual_paste",
    });
  });

  it("allows only supported Orca pane targets to cross the remote boundary", () => {
    const remoteOrca = {
      id: "remote-orca",
      host: "remote-box",
      orcaPaneKey: "tab-remote:leaf-remote",
    };
    const terminalTarget = { canFocus: true, type: "terminal", url: null };
    const unavailable = { canFocus: false, type: null, url: null };

    assert.deepStrictEqual(getSessionFocusTarget(remoteOrca, { osPlatform: "darwin" }), terminalTarget);
    assert.deepStrictEqual(getSessionFocusTarget(remoteOrca, { osPlatform: "win32" }), terminalTarget);
    assert.deepStrictEqual(getSessionFocusTarget(remoteOrca, { osPlatform: "linux" }), unavailable);
    assert.deepStrictEqual(getSessionFocusTarget({ ...remoteOrca, orcaPaneKey: "bad" }, { osPlatform: "darwin" }), unavailable);
    assert.deepStrictEqual(getSessionFocusTarget({ ...remoteOrca, platform: "webui" }, { osPlatform: "darwin" }), unavailable);

    // The HUD/Dashboard click target is enabled, but local-only consumers such
    // as pet-body focus and Telegram Direct Send must not absorb remote sessions.
    assert.strictEqual(isFocusableLocalHudSession(remoteOrca, { osPlatform: "darwin" }), false);
  });

  it("selects up to nine focusable HUD sessions in snapshot order", () => {
    const sessions = [
      { id: "old", canFocus: true, state: "idle" },
      { id: "unfocusable", canFocus: false, state: "working" },
      { id: "newest", canFocus: true, state: "working" },
      { id: "hidden", canFocus: true, state: "working", hiddenFromHud: true },
      { id: "sleeping", canFocus: true, state: "sleeping" },
      { id: "headless", canFocus: true, state: "working", headless: true },
      { id: "missing-from-order", canFocus: true, state: "working" },
    ];
    const snapshot = {
      sessions,
      orderedIds: ["unfocusable", "newest", "hidden", "sleeping", "headless", "old"],
    };

    assert.deepStrictEqual(getShortcutFocusableHudSessionIds(snapshot), [
      "newest",
      "old",
      "missing-from-order",
    ]);
    assert.strictEqual(isShortcutFocusableHudSession(sessions[0]), true);
    assert.strictEqual(isShortcutFocusableHudSession(sessions[1]), false);

    const many = Array.from({ length: 11 }, (_unused, index) => ({
      id: `session-${index + 1}`,
      canFocus: true,
      state: "working",
    }));
    assert.deepStrictEqual(
      getShortcutFocusableHudSessionIds({
        sessions: many,
        orderedIds: many.map((entry) => entry.id),
      }),
      many.slice(0, 9).map((entry) => entry.id)
    );
  });

  it("builds dynamic Focus session 1-9 handlers", () => {
    let snapshot = {
      sessions: [
        { id: "first", canFocus: true, state: "working" },
        { id: "second", canFocus: true, state: "working" },
      ],
      orderedIds: ["second", "first"],
    };
    const calls = [];
    const handlers = createFocusSessionShortcutHandlers({
      getSnapshot: () => snapshot,
      focusSession: (sessionId, options) => {
        calls.push([sessionId, options]);
        return true;
      },
    });

    assert.deepStrictEqual(Object.keys(handlers), Array.from(
      { length: 9 },
      (_unused, index) => `focusSession${index + 1}`
    ));
    assert.strictEqual(handlers.focusSession1(), true);
    assert.deepStrictEqual(calls, [["second", { requestSource: "shortcut" }]]);
    assert.strictEqual(handlers.focusSession9(), false);
    assert.strictEqual(calls.length, 1);

    snapshot = { ...snapshot, orderedIds: ["first", "second"] };
    assert.strictEqual(handlers.focusSession1(), true);
    assert.deepStrictEqual(calls[1], ["first", { requestSource: "shortcut" }]);
  });

  it("rejects malformed entries defensively", () => {
    assert.strictEqual(isFocusableLocalHudSession(null), false);
    assert.strictEqual(isFocusableLocalHudSession({ sourcePid: 1 }), false);
    assert.deepStrictEqual(getFocusableLocalHudSessionIds({ sessions: "bad" }), []);
    assert.deepStrictEqual(getFocusableLocalHudSessionIds(null), []);
    assert.deepStrictEqual(getShortcutFocusableHudSessionIds({ sessions: "bad" }), []);
    assert.deepStrictEqual(getShortcutFocusableHudSessionIds(null), []);
  });
});
