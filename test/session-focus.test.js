"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  getCodexThreadId,
  getCodexThreadUrl,
  getFocusableLocalHudSessionIds,
  getSessionFocusTarget,
  isFocusableLocalHudSession,
} = require("../src/session-focus");

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
        { id: "webui", sourcePid: 1005, state: "working", platform: "webui" },
        {
          id: "codex:019e115a-4df2-7ed0-b90e-8e6345aca777",
          agentId: "codex",
          state: "working",
          codexOriginator: "Codex Desktop",
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
      codexOriginator: "Codex Desktop",
    };

    assert.strictEqual(getCodexThreadId(entry), "019e115a-4df2-7ed0-b90e-8e6345aca777");
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

  it("rejects malformed entries defensively", () => {
    assert.strictEqual(isFocusableLocalHudSession(null), false);
    assert.strictEqual(isFocusableLocalHudSession({ sourcePid: 1 }), false);
    assert.deepStrictEqual(getFocusableLocalHudSessionIds({ sessions: "bad" }), []);
    assert.deepStrictEqual(getFocusableLocalHudSessionIds(null), []);
  });
});
