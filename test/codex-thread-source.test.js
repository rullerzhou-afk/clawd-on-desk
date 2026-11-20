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
const threadId = "abcdef12-0000-4000-8000-000000000001";
const otherThreadId = "abcdef12-0000-4000-8000-000000000002";

function rolloutPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-thread-source-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "rollout.jsonl");
}

function writeRollout(file, payload) {
  fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload }) + "\n");
}

function createIntegration(t, id = threadId) {
  const rawSessionId = `codex:${id}`;
  const { sessionId } = resolveSessionIdentity(rawSessionId, "local");
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
  t.after(() => { runtime.cleanup(); state.cleanup(); });
  const post = (transcriptPath, event = "UserPromptSubmit", extra = {}) =>
    runtime.updateSessionFromServer(sessionId, "thinking", event, {
      agentId: "codex", profileId: "local", hookSource: "codex-official",
      rawSessionId, transcriptPath, turnId: "turn-1", ...extra,
    });
  return { state, post, sessionId };
}

describe("codex thread source", () => {
  for (const [description, source, expectedSource] of [
    ["guardian_review", "guardian_review", "guardian_review"],
    ["user", "user", "user"],
    ["a missing thread_source", undefined, null],
    ["a non-string thread_source", 42, null],
  ]) {
    it(`PR #1395 follow-up: settles a matching rollout head with ${description}`, (t) => {
      const file = rolloutPath(t);
      writeRollout(file, { id: threadId, thread_source: source });
      assert.deepStrictEqual(readCodexThreadSource(file, threadId), { settled: true, source: expectedSource });
    });
  }

  it("PR #1395 follow-up: leaves a rollout with a mismatched thread id unsettled", (t) => {
    const file = rolloutPath(t);
    writeRollout(file, { id: otherThreadId, thread_source: "guardian_review" });
    assert.deepStrictEqual(readCodexThreadSource(file, threadId), { settled: false, source: null });
  });

  it("PR #1395 follow-up: leaves a rollout without an expected thread id unsettled", (t) => {
    const file = rolloutPath(t);
    writeRollout(file, { id: threadId, thread_source: "guardian_review" });
    assert.deepStrictEqual(readCodexThreadSource(file), { settled: false, source: null });
  });

  it("PR #1395 follow-up: leaves a rollout without a recorded thread id unsettled", (t) => {
    const file = rolloutPath(t);
    writeRollout(file, { thread_source: "guardian_review" });
    assert.deepStrictEqual(readCodexThreadSource(file, threadId), { settled: false, source: null });
  });

  it("PR #1395 follow-up: leaves a missing rollout unsettled", (t) => {
    assert.deepStrictEqual(readCodexThreadSource(rolloutPath(t), threadId), { settled: false, source: null });
  });

  it("PR #1395 follow-up: leaves an empty rollout path unsettled", () => {
    assert.deepStrictEqual(readCodexThreadSource("", threadId), { settled: false, source: null });
  });

  it("PR #1395 follow-up: leaves a partially written rollout head unsettled", (t) => {
    const file = rolloutPath(t);
    fs.writeFileSync(file, '{"type":"session_meta","payload":');
    assert.deepStrictEqual(readCodexThreadSource(file, threadId), { settled: false, source: null });
  });

  it("PR #1395 follow-up: leaves a short rollout head with invalid JSON unsettled", (t) => {
    const file = rolloutPath(t);
    fs.writeFileSync(file, '{"type":"session_meta","payload":\n');
    assert.deepStrictEqual(readCodexThreadSource(file, threadId), { settled: false, source: null });
  });

  it("PR #1395 follow-up: settles an oversized rollout head without a source", (t) => {
    const file = rolloutPath(t);
    fs.writeFileSync(file, "x".repeat(64 * 1024 + 1));
    assert.deepStrictEqual(readCodexThreadSource(file, threadId), { settled: true, source: null });
  });

  it("PR #1395 follow-up: settles a non-session_meta rollout head without a source", (t) => {
    const file = rolloutPath(t);
    fs.writeFileSync(file, JSON.stringify({ type: "event_msg" }) + "\n");
    assert.deepStrictEqual(readCodexThreadSource(file, threadId), { settled: true, source: null });
  });

  it("PR #1395 follow-up: matches a prefixed thread id across UUID casing", (t) => {
    const file = rolloutPath(t);
    writeRollout(file, { id: threadId, thread_source: "guardian_review" });
    assert.deepStrictEqual(readCodexThreadSource(file, `codex:${threadId.toUpperCase()}`), {
      settled: true, source: "guardian_review",
    });
  });

  it("PR #1395 follow-up: only classifies guardian_review as internal", () => {
    assert.strictEqual(isInternalCodexThreadSource("guardian_review"), true);
    assert.strictEqual(isInternalCodexThreadSource("subagent"), false);
    assert.strictEqual(isInternalCodexThreadSource("user"), false);
    assert.strictEqual(isInternalCodexThreadSource(null), false);
  });

  for (const [source, expectRow] of [["guardian_review", false], ["subagent", true], ["user", true]]) {
    it(`PR #1395 follow-up: ${source} rollout ${expectRow ? "opens" : "does not open"} a session row`, (t) => {
      const { state, post, sessionId } = createIntegration(t);
      const file = rolloutPath(t);
      writeRollout(file, { id: threadId, thread_source: source });
      post(file);
      assert.strictEqual(state.sessions.has(sessionId), expectRow);
    });
  }

  it("PR #1395 follow-up: opens a session row without a transcript path", (t) => {
    const { state, post, sessionId } = createIntegration(t);
    post();
    assert.strictEqual(state.sessions.has(sessionId), true);
  });

  it("PR #1395 follow-up: late Guardian recognition removes the row and keeps later prompts hidden", (t) => {
    const { state, post, sessionId } = createIntegration(t);
    post();
    assert.strictEqual(state.sessions.has(sessionId), true);
    const file = rolloutPath(t);
    writeRollout(file, { id: threadId, thread_source: "guardian_review" });
    post(file, "PreToolUse", { rawSessionId: undefined });
    assert.strictEqual(state.sessions.has(sessionId), false);
    post();
    assert.strictEqual(state.sessions.has(sessionId), false);
  });

  it("PR #1395 follow-up: keeps the row when a Guardian rollout belongs to another thread", (t) => {
    const { state, post, sessionId } = createIntegration(t);
    const file = rolloutPath(t);
    writeRollout(file, { id: otherThreadId, thread_source: "guardian_review" });
    post(file);
    assert.strictEqual(state.sessions.has(sessionId), true);
  });

  it("PR #1395 follow-up: caches a settled rollout head with no thread_source", (t) => {
    const { state, post, sessionId } = createIntegration(t);
    const file = rolloutPath(t);
    writeRollout(file, { id: threadId });
    post(file);
    assert.strictEqual(state.sessions.has(sessionId), true);
    writeRollout(file, { id: threadId, thread_source: "guardian_review" });
    post(file, "PreToolUse");
    assert.strictEqual(state.sessions.has(sessionId), true);
  });

  it("PR #1395 follow-up: retries an unsettled rollout after the file appears", (t) => {
    const { state, post, sessionId } = createIntegration(t, otherThreadId);
    const file = rolloutPath(t);
    post(file);
    assert.strictEqual(state.sessions.has(sessionId), true);
    writeRollout(file, { id: otherThreadId, thread_source: "guardian_review" });
    post(file, "PreToolUse");
    assert.strictEqual(state.sessions.has(sessionId), false);
  });
});
