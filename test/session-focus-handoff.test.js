"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  focusCodexThreadTarget,
  sanitizeFocusError,
} = require("../src/session-focus-handoff");

describe("session focus handoff", () => {
  it("opens Codex Desktop thread URLs and logs success", async () => {
    const opened = [];
    const logs = [];

    await focusCodexThreadTarget({
      shell: {
        openExternal: async (url) => opened.push(url),
      },
      focusEntry: { id: "codex:thread", agentId: "codex" },
      sessionId: "codex:thread",
      requestSource: "dashboard",
      url: "codex://threads/thread",
      focusLog: (line) => logs.push(line),
    });

    assert.deepStrictEqual(opened, ["codex://threads/thread"]);
    assert.ok(logs.some((line) => line.includes("target=codex-thread")));
    assert.ok(logs.some((line) => line.includes("reason=opened")));
  });

  it("falls back to terminal focus when Codex Desktop deep link fails", async () => {
    const logs = [];
    const terminalCalls = [];
    const focusEntry = { id: "codex:thread", agentId: "codex", sourcePid: 123 };

    await focusCodexThreadTarget({
      shell: {
        openExternal: async () => {
          throw new Error("protocol failed\nwith tab");
        },
      },
      focusEntry,
      sessionId: "codex:thread",
      requestSource: "hud",
      url: "codex://threads/thread",
      focusLog: (line) => logs.push(line),
      focusTerminalSession: (...args) => {
        terminalCalls.push(args);
        return true;
      },
    });

    assert.deepStrictEqual(terminalCalls, [[focusEntry, "codex:thread", "hud"]]);
    assert.ok(logs.some((line) =>
      line.includes("reason=open-failed") && line.includes("protocol failed with tab")
    ));
    assert.ok(!logs.some((line) => line.includes("codex-thread-fallback-no-source-pid")));
  });

  it("logs when Codex Desktop deep link fallback has no terminal source pid", async () => {
    const logs = [];

    await focusCodexThreadTarget({
      shell: {
        openExternal: async () => {
          throw new Error("no app");
        },
      },
      focusEntry: { id: "codex:thread", agentId: "codex" },
      sessionId: "codex:thread",
      url: "codex://threads/thread",
      focusLog: (line) => logs.push(line),
      focusTerminalSession: () => false,
    });

    assert.ok(logs.some((line) => line.includes("reason=open-failed")));
    assert.ok(logs.some((line) => line.includes("reason=codex-thread-fallback-no-source-pid")));
  });

  it("sanitizes focus errors for single-line logs", () => {
    assert.strictEqual(sanitizeFocusError(new Error("a\r\nb\tc")), "a b c");
    assert.strictEqual(sanitizeFocusError(null), "unknown");
  });
});
