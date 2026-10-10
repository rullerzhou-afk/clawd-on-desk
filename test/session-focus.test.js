"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  getCodexThreadId,
  getCodexThreadUrl,
  getDirectSendFocusTarget,
  getFocusableLocalHudSessionIds,
  getSessionFocusTarget,
  isFocusableLocalHudSession,
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

  it("keeps Codex CLI UUIDs on the terminal focus path", () => {
    const entry = {
      id: "codex:019e115a-4df2-7ed0-b90e-8e6345aca777",
      rawSessionId: "codex:019e115a-4df2-7ed0-b90e-8e6345aca777",
      agentId: "codex",
      codexOriginator: "codex-tui",
      sourcePid: 123,
    };

    assert.strictEqual(getCodexThreadId(entry), "019e115a-4df2-7ed0-b90e-8e6345aca777");
    assert.strictEqual(getCodexThreadUrl(entry), null);
    assert.deepStrictEqual(getSessionFocusTarget(entry, { osPlatform: "win32" }), {
      canFocus: true,
      type: "terminal",
      url: null,
    });
  });

  it("does not infer a Desktop deep link from a queue-only named thread selector", () => {
    const entry = {
      id: "codex:Build / release?week#1",
      rawSessionId: "codex:Build / release?week#1",
      agentId: "codex",
      codexOriginator: "Codex Desktop",
    };

    assert.strictEqual(getCodexThreadId(entry), "Build / release?week#1");
    assert.strictEqual(getCodexThreadUrl(entry), null);
    assert.deepStrictEqual(getSessionFocusTarget(entry, { osPlatform: "darwin" }), {
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

  it("opens the DSH desktop window only for local desktop-carrier sessions on supported hosts", () => {
    const desktop = {
      id: "deepseek-harness:s1",
      agentId: "deepseek-harness",
      dshCarrier: "desktop",
    };
    const dshDesktopTarget = { canFocus: true, type: "dsh-desktop", url: "dsh://open" };
    const unavailable = { canFocus: false, type: null, url: null };

    assert.deepStrictEqual(getSessionFocusTarget(desktop, { osPlatform: "darwin" }), dshDesktopTarget);
    assert.deepStrictEqual(getSessionFocusTarget(desktop, { osPlatform: "win32" }), dshDesktopTarget);
    assert.strictEqual(isFocusableLocalHudSession(desktop, { osPlatform: "darwin" }), true);
    assert.strictEqual(isFocusableLocalHudSession(desktop, { osPlatform: "linux" }), false);
    assert.deepStrictEqual(getSessionFocusTarget(desktop, { osPlatform: "linux" }), unavailable);

    // The carrier only counts for DSH, and only when it is exactly "desktop".
    assert.deepStrictEqual(getSessionFocusTarget({ ...desktop, agentId: "codex" }, { osPlatform: "darwin" }), unavailable);
    assert.deepStrictEqual(getSessionFocusTarget({ ...desktop, dshCarrier: "web" }, { osPlatform: "darwin" }), unavailable);
    assert.deepStrictEqual(getSessionFocusTarget({ ...desktop, platform: "webui" }, { osPlatform: "darwin" }), unavailable);
    assert.deepStrictEqual(getSessionFocusTarget({ ...desktop, host: "remote-box" }, { osPlatform: "darwin" }), unavailable);
    // A desktop carrier never grants terminal focus.
    assert.deepStrictEqual(getSessionFocusTarget({ ...desktop, sourcePid: 123 }, { osPlatform: "darwin" }), dshDesktopTarget);
  });

  it("keeps the DSH desktop window out of the Direct Send paste target", () => {
    const desktop = {
      id: "deepseek-harness:s1",
      agentId: "deepseek-harness",
      dshCarrier: "desktop",
      sourcePid: 123,
    };

    assert.deepStrictEqual(getDirectSendFocusTarget(desktop, { osPlatform: "darwin" }), {
      canFocus: false,
      type: "dsh-desktop",
      url: "dsh://open",
      reason: "dsh_desktop_requires_manual_paste",
    });
    assert.deepStrictEqual(getDirectSendFocusTarget({ ...desktop, dshCarrier: "web" }, { osPlatform: "darwin" }), {
      canFocus: true,
      type: "terminal",
      url: null,
    });
  });

  it("sends a herdr-hosted session to its pane ahead of the Codex Desktop deep link (#1139)", () => {
    // Real-machine report on #1164: a codex started inside a herdr pane whose
    // server was launched from a Codex Desktop shell records the Desktop
    // originator, so the Dashboard offered "open Codex session" and the click
    // never reached the herdr branch.
    const herdrDesktop = {
      id: "codex:019e115a-4df2-7ed0-b90e-8e6345aca777",
      agentId: "codex",
      codexOriginator: "codex_work_desktop",
      sourcePid: 900,
      herdrPaneId: "w1:p1",
    };
    const terminalTarget = { canFocus: true, type: "terminal", url: null };
    const desktopTarget = {
      canFocus: true,
      type: "codex-thread",
      url: "codex://threads/019e115a-4df2-7ed0-b90e-8e6345aca777",
    };

    assert.deepStrictEqual(getSessionFocusTarget(herdrDesktop, { osPlatform: "darwin" }), terminalTarget);
    assert.deepStrictEqual(getSessionFocusTarget(herdrDesktop, { osPlatform: "linux" }), terminalTarget);
    assert.strictEqual(isFocusableLocalHudSession(herdrDesktop, { osPlatform: "darwin" }), true);

    // Windows cannot run the herdr CLI, and a pane id alone cannot raise anything.
    assert.deepStrictEqual(getSessionFocusTarget(herdrDesktop, { osPlatform: "win32" }), desktopTarget);
    assert.deepStrictEqual(getSessionFocusTarget({ ...herdrDesktop, sourcePid: null }, { osPlatform: "darwin" }), desktopTarget);
    // A malformed or flag-like pane id is ignored rather than trusted.
    for (const herdrPaneId of ["bad", "--help:x", "w1:p1; rm -rf ~", ""]) {
      assert.deepStrictEqual(
        getSessionFocusTarget({ ...herdrDesktop, herdrPaneId }, { osPlatform: "darwin" }),
        desktopTarget,
        herdrPaneId
      );
    }
    // Remote sessions never become focusable through a herdr pane id.
    assert.deepStrictEqual(
      getSessionFocusTarget({ ...herdrDesktop, host: "remote-box" }, { osPlatform: "darwin" }),
      { canFocus: false, type: null, url: null }
    );
    // Direct Send still keeps the Desktop identity out of the paste path.
    assert.deepStrictEqual(getDirectSendFocusTarget(herdrDesktop, { osPlatform: "darwin" }), {
      ...desktopTarget,
      canFocus: false,
      reason: "codex_desktop_requires_manual_paste",
    });
    // A plain CLI session in herdr was already a terminal target and stays one.
    assert.deepStrictEqual(
      getSessionFocusTarget({ ...herdrDesktop, codexOriginator: "codex-tui" }, { osPlatform: "darwin" }),
      terminalTarget
    );
  });

  it("rejects malformed entries defensively", () => {
    assert.strictEqual(isFocusableLocalHudSession(null), false);
    assert.strictEqual(isFocusableLocalHudSession({ sourcePid: 1 }), false);
    assert.deepStrictEqual(getFocusableLocalHudSessionIds({ sessions: "bad" }), []);
    assert.deepStrictEqual(getFocusableLocalHudSessionIds(null), []);
  });
});
