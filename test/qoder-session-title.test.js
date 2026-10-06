"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
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

async function withTempTranscript(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-qoder-title-"));
  const transcriptPath = path.join(dir, "session.jsonl");
  try {
    fs.writeFileSync(transcriptPath, "");
    return await run(transcriptPath, dir);
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

function recordingFs(ranges, beforeRead = async () => {}) {
  return {
    async open(...args) {
      const fd = await fs.promises.open(...args);
      return {
        stat: () => fd.stat(),
        close: () => fd.close(),
        async read(buffer, offset, length, position) {
          await beforeRead({ position, length });
          const result = await fd.read(buffer, offset, length, position);
          ranges.push({ position, requested: length, bytesRead: result.bytesRead });
          return result;
        },
      };
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

async function waitForTitle(state, title, rawSessionId = "qoder:fixture-session") {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const entry = state.buildSessionSnapshot().sessions.find((session) => session.rawSessionId === rawSessionId);
    if (entry && entry.sessionTitle === title) return entry;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Title did not arrive: ${title}`);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function createIntegration({ beforeRead, isEnabled = () => true, aliases = {} } = {}) {
  const scans = [];
  const readers = [];
  const tracker = createQoderSessionTitleTracker({
    fs: recordingFs([], beforeRead),
    onScan: (scan) => { scans.push(scan); readers.shift()?.(scan); },
  });
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
    getSessionAliases: () => aliases,
  });
  const runtime = createAgentRuntimeMain({
    codexSubagentClassifier: {},
    updateSession: state.updateSession,
    getStateRuntime: () => state,
    qoderSessionTitleTracker: tracker,
    isAgentEnabled: isEnabled,
  });
  const ctx = {
    STATE_SVGS: state.STATE_SVGS,
    pendingPermissions: [],
    sessions: state.sessions,
    isAgentEnabled: isEnabled,
    setState: state.setState,
    updateSession: runtime.updateSessionFromServer,
    updateSessionMetadata: runtime.updateSessionMetadataFromServer,
    updateAccountQuota: state.updateAccountQuota,
    resolvePermissionEntry: () => {},
  };

  return {
    state, runtime, ctx, tracker, scans,
    nextScan: () => new Promise((resolve) => readers.push(resolve)),
    post: (payload) => postState(ctx, payload),
    cleanup: () => { runtime.cleanup(); state.cleanup(); },
  };
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
  it("normalizes qoder-prefixed ids and safe Unicode titles", async () => {
    assert.strictEqual(normalizeQoderSessionId("qoder:session-1"), "session-1");
    assert.strictEqual(normalizeQoderSessionId("session-1"), "session-1");
    assert.strictEqual(normalizeQoderSessionId(1), null);
    assert.strictEqual(normalizeQoderSessionTitle("  Fix\n\u202E auth  "), "Fix auth");
    assert.strictEqual(normalizeQoderSessionTitle(" \t "), null);
    assert.strictEqual(Array.from(normalizeQoderSessionTitle("修".repeat(90))).length, 80);
  });

  it("reads the sanitized @qoder-ai/qodercli 1.1.9 fixture with custom-title precedence", async () => {
    const tracker = createQoderSessionTitleTracker({ chunkBytes: 37 });
    const fixture = path.join(__dirname, "fixtures", "qodercli-1.1.9-session-title.jsonl");
    assert.strictEqual(await tracker.resolve({
      event: "SessionStart",
      sessionId: "qoder:fixture-session",
      transcriptPath: fixture,
    }), "Qoder native titles");
  });

  it("requires native string sessionId/title shapes and exact session isolation", async () => {
    await withTempTranscript(async (transcriptPath) => {
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
      assert.strictEqual(await tracker.resolve({
        event: "UserPromptSubmit",
        sessionId: "qoder:s1",
        transcriptPath,
      }), "Right session");
    });
  });

  it("does not treat an empty custom title as a supported clear operation", async () => {
    await withTempTranscript(async (transcriptPath) => {
      appendJsonLine(transcriptPath, { type: "ai-title", sessionId: "s1", aiTitle: "Generated" });
      appendJsonLine(transcriptPath, { type: "custom-title", sessionId: "s1", customTitle: "" });
      const tracker = createQoderSessionTitleTracker();
      assert.strictEqual(await tracker.resolve({
        event: "Stop",
        sessionId: "s1",
        transcriptPath,
      }), "Generated");
    });
  });

  it("keeps a middle rename monotonic after the transcript grows beyond 16 MiB", async () => {
    await withTempTranscript(async (transcriptPath) => {
      appendJsonLine(transcriptPath, { type: "ai-title", sessionId: "s1", aiTitle: "Old head title" });
      appendFiller(transcriptPath, 8.5 * 1024 * 1024);
      const tracker = createQoderSessionTitleTracker();
      assert.strictEqual(await tracker.resolve({
        event: "Stop",
        sessionId: "s1",
        transcriptPath,
      }), "Old head title");

      appendJsonLine(transcriptPath, { type: "custom-title", sessionId: "s1", customTitle: "Middle rename" });
      appendFiller(transcriptPath, 8.5 * 1024 * 1024);
      assert.ok(fs.statSync(transcriptPath).size > 16 * 1024 * 1024);
      assert.strictEqual(await tracker.resolve({
        event: "UserPromptSubmit",
        sessionId: "qoder:s1",
        transcriptPath,
      }), "Middle rename");

      appendJsonLine(transcriptPath, { type: "ai-title", sessionId: "s1", aiTitle: "Late AI title" });
      assert.strictEqual(await tracker.resolve({
        event: "Stop",
        sessionId: "s1",
        transcriptPath,
      }), "Middle rename");
    });
  });

  it("tracks exact chunk ranges and carries a partial JSONL line across scans", async () => {
    await withTempTranscript(async (transcriptPath) => {
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

      assert.strictEqual(await tracker.resolve({
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
      assert.strictEqual(await tracker.resolve({
        event: "UserPromptSubmit",
        sessionId: "s1",
        transcriptPath,
      }), "Split record");
      assert.strictEqual(scans[1].startOffset, initialSize);
      assert.strictEqual(scans[1].contentBytesRead, 1);
      assert.ok(ranges.slice(beforeSecondScan).some((range) => range.position === initialSize));
    });
  });

  it("resumes a split title after a transient read failure without losing the line", async () => {
    await withTempTranscript(async (transcriptPath) => {
      appendJsonLine(transcriptPath, {
        type: "custom-title", sessionId: "s1", customTitle: "Recovered title",
      });
      let reads = 0;
      const fsApi = recordingFs([], async () => {
        if (++reads === 2) throw Object.assign(new Error("Transient read failure"), { code: "EIO" });
      });
      const tracker = createQoderSessionTitleTracker({ fs: fsApi, chunkBytes: 32 });
      const input = { event: "SessionStart", sessionId: "s1", transcriptPath };
      assert.strictEqual(await tracker.resolve(input), null);
      assert.strictEqual(await tracker.resolve({ ...input, event: "Stop" }), "Recovered title");
    });
  });

  it("rescans safely after truncation and inode replacement without AI rollback", async () => {
    await withTempTranscript(async (transcriptPath, dir) => {
      appendJsonLine(transcriptPath, { type: "ai-title", sessionId: "s1", aiTitle: "Generated" });
      const scans = [];
      const tracker = createQoderSessionTitleTracker({ onScan: (scan) => scans.push(scan) });
      assert.strictEqual(await tracker.resolve({ event: "Stop", sessionId: "s1", transcriptPath }), "Generated");

      fs.writeFileSync(transcriptPath, `${JSON.stringify({
        type: "custom-title",
        sessionId: "s1",
        customTitle: "After truncation",
      })}\n`);
      assert.strictEqual(await tracker.resolve({ event: "Stop", sessionId: "s1", transcriptPath }), "After truncation");
      assert.strictEqual(scans.at(-1).reset, true);

      const replacement = path.join(dir, "replacement.jsonl");
      fs.writeFileSync(replacement, `${JSON.stringify({
        type: "custom-title",
        sessionId: "s1",
        customTitle: "After replacement",
      })}\n`);
      fs.renameSync(replacement, transcriptPath);
      assert.strictEqual(await tracker.resolve({ event: "Stop", sessionId: "s1", transcriptPath }), "After replacement");
      assert.strictEqual(scans.at(-1).reset, true);
    });
  });

  it("performs zero scans for high-frequency tool, permission, and notification events", async () => {
    await withTempTranscript(async (transcriptPath) => {
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
        assert.strictEqual(await tracker.resolve({ event, sessionId: "s1", transcriptPath }), null);
      }
      assert.strictEqual(scans.length, 0);
      assert.strictEqual(await tracker.resolve({ event: "Stop", sessionId: "s1", transcriptPath }), "Generated");
      assert.strictEqual(scans.length, 1);
    });
  });

  it("reads a complete 32 MiB transcript while yielding to the main event loop", async () => {
    await withTempTranscript(async (transcriptPath) => {
      appendJsonLine(transcriptPath, { type: "ai-title", sessionId: "s1", aiTitle: "Large transcript" });
      appendFiller(transcriptPath, 32 * 1024 * 1024);
      const scans = [];
      const tracker = createQoderSessionTitleTracker({ onScan: (scan) => scans.push(scan) });
      const heapBefore = process.memoryUsage().heapUsed;
      let completed = false;
      const pending = tracker.resolve({ event: "SessionStart", sessionId: "s1", transcriptPath });
      pending.then(() => { completed = true; });
      await nextTurn();
      assert.strictEqual(completed, false, "a cold scan must yield before completing");
      const title = await pending;
      const heapGrowth = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
      const fileSize = fs.statSync(transcriptPath).size;

      assert.strictEqual(title, "Large transcript");
      assert.ok(heapGrowth < 96 * 1024 * 1024, `heap grew by ${heapGrowth} bytes`);
      assert.strictEqual(scans[0].contentBytesRead, fileSize);
      assert.ok(scans[0].readOps <= Math.ceil(fileSize / (64 * 1024)) + 1);
    });
  });

  it("keeps external titles over cold and unchanged baselines, then accepts fresh native records", async () => {
    await withTempTranscript(async (transcriptPath) => {
      appendJsonLine(transcriptPath, { type: "custom-title", sessionId: "s1", customTitle: "A" });
      const ranges = [];
      const tracker = createQoderSessionTitleTracker({ fs: recordingFs(ranges) });
      assert.strictEqual(tracker.noteExternalTitle("qoder:s1", "  B\n "), "B");
      assert.deepStrictEqual(ranges, []);
      const input = { event: "Stop", sessionId: "s1", transcriptPath };
      assert.strictEqual(await tracker.resolve(input), "B");
      assert.strictEqual(await tracker.resolve(input), "B");
      appendJsonLine(transcriptPath, { type: "custom-title", sessionId: "s1", customTitle: "C" });
      assert.strictEqual(await tracker.resolve(input), "C");
      tracker.noteExternalTitle("s1", "D");
      appendJsonLine(transcriptPath, { type: "ai-title", sessionId: "s1", aiTitle: "Late AI" });
      assert.strictEqual(await tracker.resolve(input), "D");
      // A fresh rename back to an earlier value is still a new native record.
      appendJsonLine(transcriptPath, { type: "custom-title", sessionId: "s1", customTitle: "C" });
      assert.strictEqual(await tracker.resolve(input), "C");
    });
  });

  it("cancels an old reader when the same id is cleared and recreated", async () => {
    await withTempTranscript(async (transcriptPath) => {
      appendJsonLine(transcriptPath, { type: "custom-title", sessionId: "s1", customTitle: "Old" });
      const entered = deferred();
      const release = deferred();
      const tracker = createQoderSessionTitleTracker({ fs: recordingFs([], async () => {
        entered.resolve(); await release.promise;
      }) });
      const pending = tracker.resolve({ event: "Stop", sessionId: "s1", transcriptPath });
      await entered.promise;
      tracker.noteExternalTitle("s1", "Title before restart");
      tracker.clear("s1", { preserveExternalTitle: true });
      assert.strictEqual(tracker.getTitle("s1"), "Title before restart");
      tracker.noteExternalTitle("s1", "New lifecycle");
      release.resolve();
      assert.strictEqual(await pending, null);
      assert.strictEqual(tracker.getTitle("s1"), "New lifecycle");
      const end = await tracker.resolve({ event: "SessionEnd", sessionId: "s1", transcriptPath });
      assert.strictEqual(end, null);
      assert.strictEqual(tracker.size(), 0);
    });
  });

  it("serializes concurrent requests and shields explicit titles from already queued scans", async () => {
    await withTempTranscript(async (transcriptPath) => {
      appendJsonLine(transcriptPath, { type: "custom-title", sessionId: "s1", customTitle: "A" });
      const entered = deferred();
      const release = deferred();
      let held = false;
      let active = 0;
      let peak = 0;
      const fsApi = recordingFs([], async () => {
        if (held) { entered.resolve(); await release.promise; }
      });
      const open = fsApi.open;
      fsApi.open = async (...args) => {
        const fd = await open(...args);
        peak = Math.max(peak, ++active);
        const close = fd.close;
        fd.close = async () => { try { await close(); } finally { active--; } };
        return fd;
      };
      const tracker = createQoderSessionTitleTracker({ fs: fsApi });
      const input = { event: "Stop", sessionId: "s1", transcriptPath };
      assert.strictEqual(await tracker.resolve(input), "A");
      held = true;
      const first = tracker.resolve(input);
      await entered.promise;
      const second = tracker.resolve(input);
      tracker.noteExternalTitle("s1", "B");
      appendJsonLine(transcriptPath, { type: "custom-title", sessionId: "s1", customTitle: "Older queued record" });
      release.resolve();
      assert.deepStrictEqual(await Promise.all([first, second]), ["B", "B"]);
      assert.strictEqual(peak, 1);
      assert.strictEqual(active, 0);
    });
  });

  it("accepts lifecycle and other-agent traffic before a slow title read, then updates metadata only", async () => {
    await withTempTranscript(async (transcriptPath) => {
      appendJsonLine(transcriptPath, { type: "custom-title", sessionId: "fixture-session", customTitle: "Background title" });
      const entered = deferred();
      const release = deferred();
      const integration = createIntegration({ beforeRead: async () => { entered.resolve(); await release.promise; } });
      const finished = integration.nextScan();
      try {
        const response = await integration.post({ agent_id: "qoder", session_id: "qoder:fixture-session",
          event: "UserPromptSubmit", state: "thinking", transcript_path: transcriptPath });
        assert.strictEqual(response.statusCode, 200);
        await entered.promise;
        const [key, session] = [...integration.state.sessions.entries()][0];
        assert.strictEqual(session.state, "thinking");
        const activity = { updatedAt: session.updatedAt, recentEvents: session.recentEvents,
          metadataUpdatedAt: session.metadataUpdatedAt };
        const other = await integration.post({ agent_id: "claude-code", session_id: "other",
          event: "PreToolUse", state: "working" });
        assert.strictEqual(other.statusCode, 200);
        assert.strictEqual(integration.scans.length, 0);
        release.resolve();
        await finished;
        await nextTurn();
        const live = integration.state.sessions.get(key);
        assert.strictEqual(live.sessionTitle, "Background title");
        assert.strictEqual(live.state, "thinking");
        assert.deepStrictEqual({ updatedAt: live.updatedAt, recentEvents: live.recentEvents,
          metadataUpdatedAt: live.metadataUpdatedAt }, activity);
      } finally { release.resolve(); await finished; integration.cleanup(); }
    });
  });

  it("preserves explicit lifecycle and metadata-only titles across later cache reads", async () => {
    await withTempTranscript(async (transcriptPath) => {
      appendJsonLine(transcriptPath, { type: "custom-title", sessionId: "fixture-session", customTitle: "A" });
      const integration = createIntegration();
      const base = { agent_id: "qoder", session_id: "qoder:fixture-session", transcript_path: transcriptPath };
      const scanPost = async (extra) => {
        const finished = integration.nextScan();
        const response = await integration.post({ ...base, ...extra });
        await finished; await nextTurn(); return response;
      };
      try {
        await scanPost({ state: "idle", event: "SessionStart" });
        await waitForTitle(integration.state, "A");
        for (const extra of [
          { state: "thinking", event: "UserPromptSubmit", session_title: "B" },
          { metadata_only: true, session_title: "Metadata title" },
        ]) {
          const before = integration.scans.length;
          const response = await integration.post({ ...base, ...extra });
          assert.ok(response.statusCode === 200 || response.statusCode === 204);
          assert.strictEqual(integration.scans.length, before);
          await scanPost({ state: "attention", event: "Stop" });
          await waitForTitle(integration.state, extra.session_title);
        }
        appendJsonLine(transcriptPath, { type: "custom-title", sessionId: "fixture-session", customTitle: "C" });
        await scanPost({ state: "thinking", event: "UserPromptSubmit" });
        await waitForTitle(integration.state, "C");
      } finally { integration.cleanup(); }
    });
  });

  it("preserves an explicit title across a same-id start but clears it on session end", async () => {
    await withTempTranscript(async (transcriptPath) => {
      appendJsonLine(transcriptPath, { type: "custom-title", sessionId: "fixture-session", customTitle: "A" });
      const integration = createIntegration();
      const base = { agent_id: "qoder", session_id: "qoder:fixture-session", transcript_path: transcriptPath };
      const scanPost = async (event) => {
        const finished = integration.nextScan();
        await integration.post({ ...base, state: "idle", event });
        await finished; await nextTurn();
      };
      try {
        await scanPost("SessionStart");
        await integration.post({ ...base, state: "thinking", event: "UserPromptSubmit", session_title: "B" });
        await scanPost("SessionStart");
        assert.strictEqual(integration.tracker.getTitle(base.session_id), "B");
        await waitForTitle(integration.state, "B");
        appendJsonLine(transcriptPath, { type: "custom-title", sessionId: "fixture-session", customTitle: "C" });
        await scanPost("Stop");
        await waitForTitle(integration.state, "C");
        await integration.post({ ...base, metadata_only: true, session_title: "D" });
        await integration.post({ ...base, state: "sleeping", event: "SessionEnd" });
        assert.strictEqual(integration.tracker.getTitle(base.session_id), null);
        await scanPost("SessionStart");
        await waitForTitle(integration.state, "C");
      } finally { integration.cleanup(); }
    });
  });

  for (const boundary of ["end", "disable", "cleanup", "restart", "path-change", "explicit"]) {
    it(`drops a pending title across ${boundary}`, async () => {
      await withTempTranscript(async (transcriptPath, dir) => {
        appendJsonLine(transcriptPath, { type: "custom-title", sessionId: "fixture-session", customTitle: "Stale result" });
        const entered = deferred();
        const release = deferred();
        let enabled = true;
        const integration = createIntegration({ isEnabled: () => enabled,
          beforeRead: async () => { entered.resolve(); await release.promise; } });
        const base = { agent_id: "qoder", session_id: "qoder:fixture-session", transcript_path: transcriptPath };
        const finished = integration.nextScan();
        try {
          await integration.post({ ...base, state: "thinking", event: "UserPromptSubmit" });
          await entered.promise;
          if (boundary === "end") await integration.post({ ...base, state: "sleeping", event: "SessionEnd" });
          if (boundary === "disable") { enabled = false; integration.runtime.clearSessionsByAgent("qoder"); }
          if (boundary === "cleanup") integration.runtime.cleanup();
          if (boundary === "restart") {
            await integration.post({ ...base, state: "sleeping", event: "SessionEnd" });
            await integration.post({ ...base, state: "thinking", event: "SessionStart", session_title: "Fresh lifecycle" });
          }
          if (boundary === "path-change") {
            await integration.post({ ...base, transcript_path: path.join(dir, "new.jsonl"),
              state: "working", event: "PreToolUse" });
          }
          if (boundary === "explicit") {
            await integration.post({ ...base, state: "working", event: "PreToolUse", session_title: "Fresh explicit" });
          }
          release.resolve(); await finished; await nextTurn();
          const sessions = integration.state.buildSessionSnapshot().sessions;
          assert.ok(sessions.every((session) => session.sessionTitle !== "Stale result"));
          if (boundary === "restart") await waitForTitle(integration.state, "Fresh lifecycle");
          if (boundary === "explicit") await waitForTitle(integration.state, "Fresh explicit");
        } finally { release.resolve(); await finished; integration.cleanup(); }
      });
    });
  }

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
      const integration = createIntegration({ aliases });
      state = integration.state;
      runtime = integration.runtime;
      const { ctx } = integration;
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
      await waitForTitle(state, "Generated fixture title");
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
      await waitForTitle(state, "Renamed fixture title");
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
