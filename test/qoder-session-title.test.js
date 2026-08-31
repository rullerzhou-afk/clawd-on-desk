"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { performance } = require("node:perf_hooks");
const WebSocket = require("ws");
const { handleStatePost } = require("../src/server-route-state");
const createAgentRuntimeMain = require("../src/agent-runtime-main");
const initState = require("../src/state");
const themeLoader = require("../src/theme-loader");
const { initMobilePreviewServer } = require("../src/network/mobile-preview-server");
const { sessionAliasKey } = require("../src/session-alias");
const {
  createQoderSessionTitleTracker,
  normalizeQoderSessionId,
  normalizeQoderSessionTitle,
} = require("../src/qoder-session-title");

themeLoader.init(path.join(__dirname, "..", "src"));
const integrationTheme = themeLoader.loadTheme("clawd");

function withTempTranscript(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-qoder-title-"));
  const transcriptPath = path.join(dir, "session.jsonl");
  try {
    fs.writeFileSync(transcriptPath, "");
    return run(transcriptPath, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function appendJsonLine(filePath, value) {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function appendFiller(filePath, minimumBytes) {
  const payload = "x".repeat(64 * 1024 - 96);
  const line = Buffer.from(`${JSON.stringify({ type: "user", message: payload })}\n`);
  let written = 0;
  const fd = fs.openSync(filePath, "a");
  try {
    while (written < minimumBytes) written += fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
  return written;
}

function recordingFs(ranges) {
  return {
    openSync: (...args) => fs.openSync(...args),
    fstatSync: (...args) => fs.fstatSync(...args),
    closeSync: (...args) => fs.closeSync(...args),
    readSync(fd, buffer, offset, length, position) {
      const bytesRead = fs.readSync(fd, buffer, offset, length, position);
      ranges.push({ position, requested: length, bytesRead });
      return bytesRead;
    },
  };
}

function postState(ctx, payload) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.headers = {};
    const res = {
      statusCode: null,
      headers: {},
      body: "",
      writeHead(code, headers = {}) { this.statusCode = code; this.headers = headers; },
      end(data) { if (data) this.body += String(data); resolve(this); },
    };
    handleStatePost(req, res, {
      ctx,
      createRequestHookRecorder: () => ({
        acceptedUnlessDnd: () => {},
        droppedByDisabled: () => {},
        droppedByDnd: () => {},
        droppedInvalidAgent: () => {},
        droppedUnsupported: () => {},
      }),
      shouldDropForDnd: () => false,
      codexOfficialTurns: new Map(),
    });
    setImmediate(() => {
      req.emit("data", Buffer.from(JSON.stringify(payload)));
      req.emit("end");
    });
  });
}

function waitForOpen(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error("Timeout waiting for mobile socket")), timeoutMs);
    ws.once("open", () => { clearTimeout(timer); resolve(); });
  });
}

function waitForMessage(ws, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
    const handler = (data) => {
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (message.type !== type) return;
      clearTimeout(timer);
      ws.off("message", handler);
      resolve(message);
    };
    ws.on("message", handler);
  });
}

describe("Qoder session title tracker", () => {
  it("normalizes qoder-prefixed ids and safe Unicode titles", () => {
    assert.strictEqual(normalizeQoderSessionId("qoder:session-1"), "session-1");
    assert.strictEqual(normalizeQoderSessionId("session-1"), "session-1");
    assert.strictEqual(normalizeQoderSessionId(1), null);
    assert.strictEqual(normalizeQoderSessionTitle("  Fix\n\u202E auth  "), "Fix auth");
    assert.strictEqual(normalizeQoderSessionTitle(" \t "), null);
    assert.strictEqual(Array.from(normalizeQoderSessionTitle("修".repeat(90))).length, 80);
  });

  it("reads the sanitized @qoder-ai/qodercli 1.1.9 fixture with custom-title precedence", () => {
    const tracker = createQoderSessionTitleTracker({ chunkBytes: 37 });
    const fixture = path.join(__dirname, "fixtures", "qodercli-1.1.9-session-title.jsonl");
    assert.strictEqual(tracker.resolve({
      event: "SessionStart",
      sessionId: "qoder:fixture-session",
      transcriptPath: fixture,
    }), "Qoder native titles");
  });

  it("requires native string sessionId/title shapes and exact session isolation", () => {
    withTempTranscript((transcriptPath) => {
      const lines = [
        { type: "ai-title", aiTitle: "Missing session" },
        { type: "ai-title", session_id: "s1", aiTitle: "Aliased session" },
        { type: "ai-title", sessionId: 1, aiTitle: "Numeric session" },
        { type: "ai-title", sessionId: "other", aiTitle: "Wrong session" },
        { type: "ai-title", sessionId: "s1", aiTitle: 42 },
        { type: "custom-title", sessionId: "s1", customTitle: "" },
        { type: "ai-title", sessionId: "s1", aiTitle: "Right session" },
      ];
      fs.writeFileSync(transcriptPath, `${lines.map(JSON.stringify).join("\n")}\n{broken-json\n`);
      const tracker = createQoderSessionTitleTracker({ chunkBytes: 41 });
      assert.strictEqual(tracker.resolve({
        event: "UserPromptSubmit",
        sessionId: "qoder:s1",
        transcriptPath,
      }), "Right session");
    });
  });

  it("does not treat an empty custom title as a supported clear operation", () => {
    withTempTranscript((transcriptPath) => {
      appendJsonLine(transcriptPath, { type: "ai-title", sessionId: "s1", aiTitle: "Generated" });
      appendJsonLine(transcriptPath, { type: "custom-title", sessionId: "s1", customTitle: "" });
      const tracker = createQoderSessionTitleTracker();
      assert.strictEqual(tracker.resolve({
        event: "Stop",
        sessionId: "s1",
        transcriptPath,
      }), "Generated");
    });
  });

  it("keeps a middle rename monotonic after the transcript grows beyond 16 MiB", () => {
    withTempTranscript((transcriptPath) => {
      appendJsonLine(transcriptPath, { type: "ai-title", sessionId: "s1", aiTitle: "Old head title" });
      appendFiller(transcriptPath, 8.5 * 1024 * 1024);
      const tracker = createQoderSessionTitleTracker();
      assert.strictEqual(tracker.resolve({
        event: "Stop",
        sessionId: "s1",
        transcriptPath,
      }), "Old head title");

      appendJsonLine(transcriptPath, { type: "custom-title", sessionId: "s1", customTitle: "Middle rename" });
      appendFiller(transcriptPath, 8.5 * 1024 * 1024);
      assert.ok(fs.statSync(transcriptPath).size > 16 * 1024 * 1024);
      assert.strictEqual(tracker.resolve({
        event: "UserPromptSubmit",
        sessionId: "qoder:s1",
        transcriptPath,
      }), "Middle rename");

      appendJsonLine(transcriptPath, { type: "ai-title", sessionId: "s1", aiTitle: "Late AI title" });
      assert.strictEqual(tracker.resolve({
        event: "Stop",
        sessionId: "s1",
        transcriptPath,
      }), "Middle rename");
    });
  });

  it("tracks exact chunk ranges and carries a partial JSONL line across scans", () => {
    withTempTranscript((transcriptPath) => {
      const ranges = [];
      const scans = [];
      const record = JSON.stringify({
        type: "custom-title",
        sessionId: "s1",
        customTitle: "Split record",
      });
      fs.writeFileSync(transcriptPath, record);
      const initialSize = fs.statSync(transcriptPath).size;
      const tracker = createQoderSessionTitleTracker({
        fs: recordingFs(ranges),
        chunkBytes: 17,
        onScan: (scan) => scans.push(scan),
      });

      assert.strictEqual(tracker.resolve({
        event: "SessionStart",
        sessionId: "s1",
        transcriptPath,
      }), null);
      assert.strictEqual(scans[0].contentBytesRead, initialSize);
      assert.strictEqual(scans[0].startOffset, 0);
      assert.strictEqual(scans[0].endOffset, initialSize);
      assert.deepStrictEqual(
        ranges.filter((range) => range.position < initialSize).map((range) => range.position),
        Array.from({ length: Math.ceil(initialSize / 17) }, (_, index) => index * 17),
      );

      fs.appendFileSync(transcriptPath, "\n");
      const beforeSecondScan = ranges.length;
      assert.strictEqual(tracker.resolve({
        event: "UserPromptSubmit",
        sessionId: "s1",
        transcriptPath,
      }), "Split record");
      assert.strictEqual(scans[1].startOffset, initialSize);
      assert.strictEqual(scans[1].contentBytesRead, 1);
      assert.ok(ranges.slice(beforeSecondScan).some((range) => range.position === initialSize));
    });
  });

  it("rescans safely after truncation and inode replacement without AI rollback", () => {
    withTempTranscript((transcriptPath, dir) => {
      appendJsonLine(transcriptPath, { type: "ai-title", sessionId: "s1", aiTitle: "Generated" });
      const scans = [];
      const tracker = createQoderSessionTitleTracker({ onScan: (scan) => scans.push(scan) });
      assert.strictEqual(tracker.resolve({ event: "Stop", sessionId: "s1", transcriptPath }), "Generated");

      fs.writeFileSync(transcriptPath, `${JSON.stringify({
        type: "custom-title",
        sessionId: "s1",
        customTitle: "After truncation",
      })}\n`);
      assert.strictEqual(tracker.resolve({ event: "Stop", sessionId: "s1", transcriptPath }), "After truncation");
      assert.strictEqual(scans.at(-1).reset, true);

      const replacement = path.join(dir, "replacement.jsonl");
      fs.writeFileSync(replacement, `${JSON.stringify({
        type: "custom-title",
        sessionId: "s1",
        customTitle: "After replacement",
      })}\n`);
      fs.renameSync(replacement, transcriptPath);
      assert.strictEqual(tracker.resolve({ event: "Stop", sessionId: "s1", transcriptPath }), "After replacement");
      assert.strictEqual(scans.at(-1).reset, true);
    });
  });

  it("performs zero scans for high-frequency tool, permission, and notification events", () => {
    withTempTranscript((transcriptPath) => {
      appendJsonLine(transcriptPath, { type: "ai-title", sessionId: "s1", aiTitle: "Generated" });
      const scans = [];
      const tracker = createQoderSessionTitleTracker({ onScan: (scan) => scans.push(scan) });
      for (const event of [
        "PreToolUse",
        "PostToolUse",
        "PostToolUseFailure",
        "PermissionRequest",
        "PermissionDenied",
        "Notification",
      ]) {
        assert.strictEqual(tracker.resolve({ event, sessionId: "s1", transcriptPath }), null);
      }
      assert.strictEqual(scans.length, 0);
      assert.strictEqual(tracker.resolve({ event: "Stop", sessionId: "s1", transcriptPath }), "Generated");
      assert.strictEqual(scans.length, 1);
    });
  });

  it("bounds wall time, heap growth, and I/O count for a 32 MiB cold scan", () => {
    withTempTranscript((transcriptPath) => {
      appendJsonLine(transcriptPath, { type: "ai-title", sessionId: "s1", aiTitle: "Large transcript" });
      appendFiller(transcriptPath, 32 * 1024 * 1024);
      const scans = [];
      const tracker = createQoderSessionTitleTracker({ onScan: (scan) => scans.push(scan) });
      const heapBefore = process.memoryUsage().heapUsed;
      const startedAt = performance.now();
      const title = tracker.resolve({ event: "SessionStart", sessionId: "s1", transcriptPath });
      const elapsedMs = performance.now() - startedAt;
      const heapGrowth = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
      const fileSize = fs.statSync(transcriptPath).size;

      assert.strictEqual(title, "Large transcript");
      assert.ok(elapsedMs < 10_000, `cold scan took ${elapsedMs.toFixed(1)}ms`);
      assert.ok(heapGrowth < 96 * 1024 * 1024, `heap grew by ${heapGrowth} bytes`);
      assert.strictEqual(scans[0].contentBytesRead, fileSize);
      assert.ok(scans[0].readOps <= Math.ceil(fileSize / (64 * 1024)) + 1);
    });
  });

  it("propagates set and rename through route, state, snapshot, alias, and mobile output", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-qoder-e2e-"));
    const transcriptPath = path.join(dir, "session.jsonl");
    const tokenPath = path.join(dir, "mobile-token.json");
    const aliases = {};
    let mobile = null;
    let ws = null;
    let runtime = null;
    let state = null;
    try {
      appendJsonLine(transcriptPath, {
        type: "ai-title",
        sessionId: "fixture-session",
        aiTitle: "Generated fixture title",
      });
      state = initState({
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
        getSessionAliases: () => aliases,
      });
      runtime = createAgentRuntimeMain({
        codexSubagentClassifier: {},
        updateSession: state.updateSession,
        getStateRuntime: () => state,
        qoderSessionTitleTracker: createQoderSessionTitleTracker(),
      });
      const ctx = {
        STATE_SVGS: state.STATE_SVGS,
        pendingPermissions: [],
        sessions: state.sessions,
        isAgentEnabled: () => true,
        setState: state.setState,
        updateSession: runtime.updateSessionFromServer,
        resolveQoderSessionTitle: runtime.resolveQoderSessionTitle,
        updateAccountQuota: state.updateAccountQuota,
        resolvePermissionEntry: () => {},
      };
      const basePayload = {
        session_id: "qoder:fixture-session",
        agent_id: "qoder",
        cwd: "/fixture/project",
        transcript_path: transcriptPath,
      };

      const started = await postState(ctx, {
        ...basePayload,
        state: "idle",
        event: "SessionStart",
      });
      assert.strictEqual(started.statusCode, 200);
      let snapshot = state.buildSessionSnapshot();
      let entry = snapshot.sessions.find((session) => session.rawSessionId === "qoder:fixture-session");
      assert.strictEqual(entry.sessionTitle, "Generated fixture title");
      assert.strictEqual(entry.displayTitle, "Generated fixture title");

      appendJsonLine(transcriptPath, {
        type: "custom-title",
        sessionId: "fixture-session",
        customTitle: "Renamed fixture title",
      });
      const renamed = await postState(ctx, {
        ...basePayload,
        state: "thinking",
        event: "UserPromptSubmit",
      });
      assert.strictEqual(renamed.statusCode, 200);
      snapshot = state.buildSessionSnapshot();
      entry = snapshot.sessions.find((session) => session.rawSessionId === "qoder:fixture-session");
      assert.strictEqual(entry.sessionTitle, "Renamed fixture title");
      assert.strictEqual(entry.displayTitle, "Renamed fixture title");

      const unchanged = await postState(ctx, {
        ...basePayload,
        state: "working",
        event: "PostToolUse",
      });
      assert.strictEqual(unchanged.statusCode, 200);
      snapshot = state.buildSessionSnapshot();
      entry = snapshot.sessions.find((session) => session.rawSessionId === "qoder:fixture-session");
      assert.strictEqual(entry.sessionTitle, "Renamed fixture title");

      appendJsonLine(transcriptPath, {
        type: "custom-title",
        sessionId: "fixture-session",
        customTitle: "",
      });
      const unsupportedClear = await postState(ctx, {
        ...basePayload,
        state: "attention",
        event: "Stop",
      });
      assert.strictEqual(unsupportedClear.statusCode, 200);
      snapshot = state.buildSessionSnapshot();
      entry = snapshot.sessions.find((session) => session.rawSessionId === "qoder:fixture-session");
      assert.strictEqual(entry.sessionTitle, "Renamed fixture title");

      aliases[sessionAliasKey(null, "qoder", "qoder:fixture-session")] = {
        title: "Pinned alias",
        updatedAt: Date.now(),
      };
      snapshot = state.buildSessionSnapshot();
      entry = snapshot.sessions.find((session) => session.rawSessionId === "qoder:fixture-session");
      assert.strictEqual(entry.sessionTitle, "Renamed fixture title");
      assert.strictEqual(entry.displayTitle, "Pinned alias");

      mobile = initMobilePreviewServer({ sessions: state.sessions, tokenPath });
      const port = await mobile.start();
      mobile.onSnapshot();
      ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${mobile.getToken()}`);
      const messagePromise = waitForMessage(ws, "snapshot");
      await waitForOpen(ws);
      const mobileSnapshot = await messagePromise;
      assert.strictEqual(mobileSnapshot.sessions[entry.id].title, "Renamed fixture title");
    } finally {
      if (ws) ws.close();
      if (mobile) mobile.cleanup();
      if (runtime) runtime.cleanup();
      if (state) state.cleanup();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
