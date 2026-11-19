"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createAgentRuntimeMain = require("../src/agent-runtime-main");
const initState = require("../src/state");
const themeLoader = require("../src/theme-loader");
const { readCodexThreadSource, isInternalCodexThreadSource } = require("../src/codex-thread-source");
const { resolveSessionIdentity } = require("../src/session-key");

themeLoader.init(path.join(__dirname, "..", "src"));
const integrationTheme = themeLoader.loadTheme("clawd");

function withRollout(threadSource, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-thread-source-"));
  const file = path.join(dir, "rollout.jsonl");
  if (threadSource !== undefined) {
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { thread_source: threadSource } }) + "\n");
  }
  return Promise.resolve(run(file)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function createIntegration() {
  const state = initState({
    lang: "en",
    theme: integrationTheme,
    doNotDisturb: false,
    miniTransitioning: false,
    miniMode: false,
    mouseOverPet: false,
    idlePaused: false,
    forceEyeResend: false,
    eyePauseUntil: 0,
    mouseStillSince: Date.now(),
    playSound: () => {},
    sendToRenderer: () => {},
    syncHitWin: () => {},
    sendToHitWin: () => {},
    buildContextMenu: () => {},
    buildTrayMenu: () => {},
    pendingPermissions: [],
    processKill: () => { const error = new Error("dead"); error.code = "ESRCH"; throw error; },
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getSessionAliases: () => ({}),
  });
  const runtime = createAgentRuntimeMain({
    codexSubagentClassifier: {},
    updateSession: state.updateSession,
    getStateRuntime: () => state,
    isAgentEnabled: () => true,
  });
  const post = (raw, transcriptPath, event = "UserPromptSubmit") =>
    runtime.updateSessionFromServer(resolveSessionIdentity(raw, "local").sessionId, "thinking", event, {
      agentId: "codex", profileId: "local", hookSource: "codex-official",
      rawSessionId: raw, transcriptPath, turnId: "turn-1",
    });
  return { state, runtime, post, cleanup: () => { runtime.cleanup(); state.cleanup(); } };
}

describe("codex thread source", () => {
  it("reads thread_source from the rollout head and tolerates missing heads", async () => {
    await withRollout("guardian_review", (file) => {
      assert.strictEqual(readCodexThreadSource(file), "guardian_review");
      assert.strictEqual(isInternalCodexThreadSource("guardian_review"), true);
      assert.strictEqual(isInternalCodexThreadSource("subagent"), true);
      assert.strictEqual(isInternalCodexThreadSource("user"), false);
      assert.strictEqual(isInternalCodexThreadSource(null), false);
    });
    await withRollout(undefined, (file) => {
      assert.strictEqual(readCodexThreadSource(file), null);
      assert.strictEqual(readCodexThreadSource(path.join(path.dirname(file), "absent.jsonl")), null);
    });
  });

  it("background thread sources never open a HUD row; user threads do", async () => {
    for (const [source, expectRow] of [["guardian_review", false], ["subagent", false], ["user", true]]) {
      await withRollout(source, async (file) => {
        const integration = createIntegration();
        try {
          integration.post(`thread-${source}`, file);
          assert.strictEqual(
            integration.state.sessions.has(resolveSessionIdentity(`thread-${source}`, "local").sessionId),
            expectRow,
            `source=${source}`,
          );
        } finally { integration.cleanup(); }
      });
    }
    const integration = createIntegration();
    try {
      integration.post("thread-no-transcript", undefined);
      assert.strictEqual(
        integration.state.sessions.has(resolveSessionIdentity("thread-no-transcript", "local").sessionId),
        true,
      );
    } finally { integration.cleanup(); }
  });
});