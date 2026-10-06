"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { describe, it, afterEach, mock } = require("node:test");
const {
  classifyPermissionInteraction,
} = require("../src/permission-automation-policy");

const PERMISSION_MODULE_PATH = require.resolve("../src/permission");
const tempLogPaths = new Set();

function loadPermissionWithElectron(fakeElectron) {
  delete require.cache[PERMISSION_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/permission");
  } finally {
    Module._load = originalLoad;
  }
}

function createTempLogPath() {
  const logPath = path.join(
    os.tmpdir(),
    `clawd-permission-debug-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`
  );
  tempLogPaths.add(logPath);
  return logPath;
}

function createPermissionHarness({
  logPath = null,
  agentPermissionsEnabled = true,
  loadBehavior = "success",
} = {}) {
  const createdWindows = [];
  class FakeBrowserWindow {
    constructor() {
      if (loadBehavior === "constructor-throw") throw new Error("BrowserWindow unavailable");
      this.destroyed = false;
      this.bounds = null;
      this._closedHandler = null;
      this._didFinishLoad = null;
      this.webContents = {
        once: (event, cb) => {
          if (event === "did-finish-load") {
            // permission.js registers this after calling loadFile; fire
            // immediately in that case so bubbleReady is set and
            // syncPermissionBubbleContent really sends.
            if (this._loadFileCalled) { cb(); return; }
            this._didFinishLoad = cb;
          }
          if (event === "did-fail-load") this._didFailLoad = cb;
        },
        on: (event, cb) => {
          if (event === "render-process-gone") this._renderGoneHandler = cb;
        },
        send: (...args) => {
          this.sentEvents.push(args);
        },
      };
      this.sentEvents = [];
      createdWindows.push(this);
    }

    setAlwaysOnTop() {}
    setBounds(bounds) { this.bounds = bounds; }
    loadFile() {
      this._loadFileCalled = true;
      if (loadBehavior === "throw") throw new Error("bubble html missing");
      if (loadBehavior === "reject") {
        return Promise.reject(new Error("bubble html rejected"));
      }
      if (loadBehavior === "event") {
        if (typeof this._didFailLoad === "function") {
          this._didFailLoad({}, -6, "FILE_NOT_FOUND");
        }
        return;
      }
      if (typeof this._didFinishLoad === "function") this._didFinishLoad();
    }
    showInactive() {}
    setSkipTaskbar() {}
    on(event, cb) {
      if (event === "closed") this._closedHandler = cb;
    }
    isDestroyed() { return this.destroyed; }
    destroy() {
      this.destroyed = true;
      if (typeof this._closedHandler === "function") this._closedHandler();
    }
  }

  const fakeElectron = {
    BrowserWindow: Object.assign(FakeBrowserWindow, {
      // Same convention as the codex-response harness: an ipc event whose
      // sender carries __window resolves to that window, so handleDecide can
      // pair the event with its bubble entry. Events without it keep the old
      // null behavior.
      fromWebContents(sender) { return (sender && sender.__window) || null; },
    }),
    globalShortcut: {
      register() { return true; },
      unregister() {},
      isRegistered() { return false; },
    },
  };
  const permissionFactory = loadPermissionWithElectron(fakeElectron);
  let notificationAutoCloseMs = 10_000;
  const focused = [];
  const slackAnnouncements = [];
  const api = permissionFactory({
    win: { isDestroyed() { return false; } },
    permDebugLog: logPath,
    hideBubbles: false,
    doNotDisturb: false,
    bubbleFollowPet: false,
    sessions: new Map(),
    getBubblePolicy(kind) {
      if (kind === "notification") {
        return { enabled: notificationAutoCloseMs > 0, autoCloseMs: notificationAutoCloseMs };
      }
      return { enabled: true, autoCloseMs: null };
    },
    getSettingsSnapshot: () => ({ shortcuts: {} }),
    isAgentPermissionsEnabled: () => agentPermissionsEnabled,
    subscribeShortcuts: () => () => {},
    clearShortcutFailure: () => {},
    reportShortcutFailure: () => {},
    getPetWindowBounds: () => ({ x: 200, y: 200, width: 128, height: 128 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    repositionUpdateBubble: () => {},
    focusTerminalForSession: (...args) => focused.push(args),
    notifySlackPermission: (payload) => slackAnnouncements.push(payload),
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
  });

  return {
    api,
    focused,
    slackAnnouncements,
    createdWindows,
    setNotificationAutoCloseMs(value) {
      notificationAutoCloseMs = value;
    },
  };
}

describe("permission passive notify auto-close refresh", () => {
  afterEach(() => {
    mock.timers.reset();
    delete require.cache[PERMISSION_MODULE_PATH];
    for (const logPath of tempLogPaths) {
      try { fs.unlinkSync(logPath); } catch {}
    }
    tempLogPaths.clear();
  });

  it("recomputes the remaining lifetime for visible notify bubbles", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const harness = createPermissionHarness();
    const { api } = harness;

    const permEntry = {
      isCodexNotify: true,
      isKimiNotify: false,
      sessionId: "codex-a",
      bubble: null,
      hideTimer: null,
      autoExpireTimer: null,
      createdAt: Date.now() - 4_000,
    };
    api.pendingPermissions.push(permEntry);

    permEntry.autoExpireTimer = setTimeout(() => {}, 10_000);
    harness.setNotificationAutoCloseMs(3_000);

    api.refreshPassiveNotifyAutoClose();

    assert.strictEqual(api.pendingPermissions.length, 0);
  });

  it("uses the remaining lifetime instead of restarting the full countdown", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const harness = createPermissionHarness();
    const { api } = harness;

    const permEntry = {
      isCodexNotify: true,
      isKimiNotify: false,
      sessionId: "codex-a",
      bubble: null,
      hideTimer: null,
      autoExpireTimer: null,
      createdAt: Date.now() - 4_000,
    };
    api.pendingPermissions.push(permEntry);

    permEntry.autoExpireTimer = setTimeout(() => {}, 10_000);
    harness.setNotificationAutoCloseMs(7_000);

    api.refreshPassiveNotifyAutoClose();
    assert.strictEqual(api.pendingPermissions.length, 1);

    mock.timers.tick(2_999);
    assert.strictEqual(api.pendingPermissions.length, 1);

    mock.timers.tick(1);
    assert.strictEqual(api.pendingPermissions.length, 0);
  });

  it("ignores interactive permission bubbles when refreshing notify auto-close", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const harness = createPermissionHarness();
    const { api } = harness;

    const interactiveEntry = {
      isCodexNotify: false,
      isKimiNotify: false,
      sessionId: "claude-a",
      bubble: null,
      hideTimer: null,
      autoExpireTimer: null,
      createdAt: Date.now(),
    };
    api.pendingPermissions.push(interactiveEntry);
    harness.setNotificationAutoCloseMs(1_000);

    api.refreshPassiveNotifyAutoClose();
    mock.timers.tick(5_000);

    assert.deepStrictEqual(api.pendingPermissions, [interactiveEntry]);
  });

  it("logs an explicit reason when Codex passive notifications are actively cleared", () => {
    const logPath = createTempLogPath();
    const harness = createPermissionHarness({ logPath });
    const { api } = harness;

    api.pendingPermissions.push({
      isCodexNotify: true,
      isKimiNotify: false,
      sessionId: "codex-a",
      bubble: null,
      hideTimer: null,
      autoExpireTimer: null,
      createdAt: Date.now(),
    });

    api.clearCodexNotifyBubbles("codex-a", "codex-state-transition");
    const logContent = fs.readFileSync(logPath, "utf8");

    assert.ok(
      logContent.includes("passive notify dismiss: agent=codex session=codex-a reason=codex-state-transition"),
      "clearing a Codex passive notification should log the active-dismiss reason"
    );
  });

  it("keeps Codex user-input cards passive until resolution and focuses native Codex", () => {
    const harness = createPermissionHarness();
    const { api } = harness;
    const shown = api.showCodexUserInputBubble({
      sessionId: "codex-a",
      callId: "call_1",
      questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }],
      sourcePid: 42,
      cwd: "/repo",
    });

    assert.strictEqual(shown, true);
    assert.strictEqual(api.pendingPermissions.length, 1);
    const entry = api.pendingPermissions[0];
    assert.strictEqual(entry.isCodexUserInputNotify, true);
    assert.strictEqual(entry.autoExpireTimer, null, "blocking questions must not use notification auto-expiry");
    assert.strictEqual(api.buildPermissionBubblePayload(entry).isCodexUserInputNotify, true);
    assert.strictEqual(api.refreshPassiveNotifyAutoClose(), 0);
    assert.strictEqual(api.pendingPermissions.length, 1);

    api.handleDecide({ sender: { __window: entry.bubble } }, "codex-user-input-focus");
    assert.strictEqual(api.pendingPermissions.length, 0);
    assert.strictEqual(harness.focused.length, 1);
    assert.strictEqual(harness.focused[0][0], "codex-a");
  });

  it("turns a stale Codex question expansion request into native focus", () => {
    const harness = createPermissionHarness();
    const { api } = harness;
    api.showCodexUserInputBubble({
      sessionId: "codex-expand",
      callId: "call_expand",
      questions: [{ id: "q", question: "Pick one", options: [] }],
      sourcePid: 42,
      cwd: "/repo",
    });
    const entry = api.pendingPermissions[0];

    assert.strictEqual(
      api.handleBubbleExpanded({ sender: { __window: entry.bubble } }, true),
      false
    );
    assert.strictEqual(api.pendingPermissions.length, 0);
    assert.strictEqual(harness.focused.length, 1);
    assert.strictEqual(harness.focused[0][0], "codex-expand");
  });

  it("dismisses a stale remote Codex expansion without focusing a local terminal", () => {
    const harness = createPermissionHarness();
    const { api } = harness;
    api.showCodexUserInputBubble({
      sessionId: "codex-remote-expand",
      callId: "call_remote_expand",
      questions: [{ id: "q", question: "Pick one", options: [] }],
      host: "remote.example",
      cwd: "/repo",
    });
    const entry = api.pendingPermissions[0];

    assert.strictEqual(
      api.handleBubbleExpanded({ sender: { __window: entry.bubble } }, true),
      false
    );
    assert.strictEqual(api.pendingPermissions.length, 0);
    assert.deepStrictEqual(harness.focused, []);
  });

  it("clears only the matching Codex user-input call", () => {
    const { api } = createPermissionHarness();
    for (const callId of ["call_1", "call_2"]) {
      api.showCodexUserInputBubble({
        sessionId: "codex-a",
        callId,
        questions: [{ id: "q", header: "Choice", question: callId, options: [] }],
      });
    }
    assert.strictEqual(api.clearCodexUserInputBubbles("codex-a", "call_1"), 1);
    assert.deepStrictEqual(api.pendingPermissions.map((entry) => entry.codexUserInputCallId), ["call_2"]);
  });

  it("does not treat a Codex question as a permission-mode feature", () => {
    const { api } = createPermissionHarness({ agentPermissionsEnabled: false });
    assert.strictEqual(api.showCodexUserInputBubble({
      sessionId: "codex-a",
      callId: "call_question",
      questions: [{ id: "q", header: "Choice", question: "Pick one", options: [] }],
    }), true);
    assert.strictEqual(api.pendingPermissions.length, 1);

    api.showCodexNotifyBubble({ sessionId: "codex-legacy", command: "rm" });
    assert.strictEqual(api.pendingPermissions.length, 1, "legacy permission cue remains gated");
  });

  it("logs an explicit reason when Kimi passive notifications are actively cleared", () => {
    const logPath = createTempLogPath();
    const harness = createPermissionHarness({ logPath });
    const { api } = harness;

    api.pendingPermissions.push({
      isCodexNotify: false,
      isKimiNotify: true,
      sessionId: "kimi-a",
      bubble: null,
      hideTimer: null,
      autoExpireTimer: null,
      createdAt: Date.now(),
    });

    api.clearKimiNotifyBubbles("kimi-a", "kimi-stop-session");
    const logContent = fs.readFileSync(logPath, "utf8");

    assert.ok(
      logContent.includes("passive notify dismiss: agent=kimi-cli session=kimi-a reason=kimi-stop-session"),
      "clearing a Kimi passive notification should log the active-dismiss reason"
    );
  });

  it("logs when a passive notification expires immediately after policy shrink", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const logPath = createTempLogPath();
    const harness = createPermissionHarness({ logPath });
    const { api } = harness;

    const permEntry = {
      isCodexNotify: true,
      isKimiNotify: false,
      sessionId: "codex-a",
      bubble: null,
      hideTimer: null,
      autoExpireTimer: null,
      createdAt: Date.now() - 4_000,
    };
    api.pendingPermissions.push(permEntry);

    harness.setNotificationAutoCloseMs(3_000);
    api.refreshPassiveNotifyAutoClose();
    const logContent = fs.readFileSync(logPath, "utf8");

    assert.ok(
      logContent.includes("passive notify dismiss: agent=codex session=codex-a reason=auto-expire-immediate"),
      "refreshing a notify bubble past its new lifetime should log the immediate-expire reason"
    );
  });

  it("deduplicates Codex passive notifications by session and refreshes the existing entry", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const harness = createPermissionHarness();
    const { api } = harness;

    api.showCodexNotifyBubble({ sessionId: "codex-a", command: "first" });
    assert.strictEqual(api.pendingPermissions.length, 1);

    const existing = api.pendingPermissions[0];
    const originalBubble = existing.bubble;
    const firstCreatedAt = existing.createdAt;

    mock.timers.tick(500);
    api.showCodexNotifyBubble({ sessionId: "codex-a", command: "second" });

    assert.strictEqual(api.pendingPermissions.length, 1);
    assert.strictEqual(api.pendingPermissions[0], existing);
    assert.strictEqual(existing.bubble, originalBubble);
    assert.strictEqual(existing.toolInput.command, "second");
    assert.ok(existing.createdAt > firstCreatedAt);

    mock.timers.tick(9_999);
    assert.strictEqual(api.pendingPermissions.length, 1);

    mock.timers.tick(1);
    assert.strictEqual(api.pendingPermissions.length, 0);
  });

  it("Kimi passive entry carries the display-only tool cue fields", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const harness = createPermissionHarness();
    const { api } = harness;

    api.showKimiNotifyBubble({
      sessionId: "kimi-a",
      toolName: "Write",
      permissionAction: "Writing: cue-probe.txt",
      permissionToolInput: { file_path: "cue-probe.txt" },
    });
    assert.strictEqual(api.pendingPermissions.length, 1);
    const entry = api.pendingPermissions[0];
    // Passive identity untouched — the cue fields are display-only extras.
    assert.strictEqual(entry.toolName, "KimiPermission");
    assert.strictEqual(entry.isKimiNotify, true);
    assert.strictEqual(entry.kimiToolName, "Write");
    assert.deepStrictEqual(entry.kimiToolInput, { file_path: "cue-probe.txt" });

    // Legacy pulse: no structured input -> null cue fields, generic copy.
    api.clearKimiNotifyBubbles("kimi-a", "test-reset");
    assert.strictEqual(api.pendingPermissions.length, 0);
    api.showKimiNotifyBubble({ sessionId: "kimi-b", toolName: "shell" });
    const legacy = api.pendingPermissions[0];
    assert.strictEqual(legacy.kimiToolName, "shell");
    assert.strictEqual(legacy.kimiToolInput, null);
    assert.strictEqual(legacy.toolInput.command, "Approve or reject in Kimi terminal.");
  });

  it("deduplicates Kimi passive notifications by session and refreshes the cue in place", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const harness = createPermissionHarness();
    const { api } = harness;

    api.showKimiNotifyBubble({
      sessionId: "kimi-a",
      toolName: "Bash",
      permissionCommand: "ls -la",
      permissionToolInput: { command: "ls -la" },
    });
    assert.strictEqual(api.pendingPermissions.length, 1);
    const existing = api.pendingPermissions[0];
    const originalBubble = existing.bubble;
    const firstCreatedAt = existing.createdAt;

    // Request #2 for the same session: the stale cue must be replaced, not
    // kept (the terminal now blocks on the NEW command) and not stacked.
    mock.timers.tick(500);
    api.showKimiNotifyBubble({
      sessionId: "kimi-a",
      toolName: "Bash",
      permissionCommand: "rm -rf build",
      permissionToolInput: { command: "rm -rf build" },
    });

    assert.strictEqual(api.pendingPermissions.length, 1);
    assert.strictEqual(api.pendingPermissions[0], existing);
    assert.strictEqual(existing.bubble, originalBubble);
    assert.strictEqual(existing.toolInput.command, "rm -rf build");
    assert.strictEqual(existing.kimiToolName, "Bash");
    assert.deepStrictEqual(existing.kimiToolInput, { command: "rm -rf build" });
    assert.ok(existing.createdAt > firstCreatedAt);

    // The refresh reaches the renderer: the last permission-show payload
    // carries the new cue fields.
    const shows = originalBubble.sentEvents.filter(([channel]) => channel === "permission-show");
    assert.ok(shows.length >= 2, "refresh should re-send permission-show");
    const lastShow = shows[shows.length - 1];
    const payload = lastShow[1];
    assert.strictEqual(payload.toolName, "KimiPermission");
    assert.strictEqual(payload.kimiToolName, "Bash");
    assert.deepStrictEqual(payload.kimiToolInput, { command: "rm -rf build" });

    // A legacy-shaped refresh downgrades to the generic copy — the generic
    // line can't be wrong; a stale rich cue can.
    api.showKimiNotifyBubble({ sessionId: "kimi-a", toolName: "shell" });
    assert.strictEqual(api.pendingPermissions.length, 1);
    assert.strictEqual(existing.kimiToolInput, null);
    assert.strictEqual(existing.toolInput.command, "Approve or reject in Kimi terminal.");

    // The refresh re-arms auto-expire from the last request.
    mock.timers.tick(9_999);
    assert.strictEqual(api.pendingPermissions.length, 1);
    mock.timers.tick(1);
    assert.strictEqual(api.pendingPermissions.length, 0);
  });
});

// Gate-ledger joint lifecycle (batched approvals): after the FIRST cue is
// gone — dismissed via the real ipc-decide path or auto-expired — state.js
// re-arms a cue for the next queued approval by calling showKimiNotifyBubble
// again. The permission layer must build a brand-new working card each time;
// stale dedupe/bookkeeping from the dead entry must not swallow the re-show.
describe("Kimi passive cue rebuild after dismissal (gate-ledger joint lifecycle)", () => {
  afterEach(() => {
    mock.timers.reset();
    delete require.cache[PERMISSION_MODULE_PATH];
    for (const logPath of tempLogPaths) {
      try { fs.unlinkSync(logPath); } catch {}
    }
    tempLogPaths.clear();
  });

  it("rebuilds a fresh card after the previous cue was dismissed via Got it (ipc-decide)", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const harness = createPermissionHarness();
    const { api } = harness;

    api.showKimiNotifyBubble({
      sessionId: "kimi-a",
      toolName: "write_file",
      permissionToolInput: { file_path: "a.txt" },
    });
    assert.strictEqual(api.pendingPermissions.length, 1);
    const first = api.pendingPermissions[0];
    assert.ok(first.bubble, "first cue should own a bubble window");

    // "Got it" travels the production ipc-decide path.
    api.handleDecide({ sender: { __window: first.bubble } }, "allow");
    assert.strictEqual(api.pendingPermissions.length, 0);

    // state.js re-arms ~800ms later with the next gate's detail.
    mock.timers.tick(800);
    api.showKimiNotifyBubble({
      sessionId: "kimi-a",
      toolName: "shell",
      permissionToolInput: { command: "Remove-Item a.txt" },
    });
    assert.strictEqual(api.pendingPermissions.length, 1);
    const second = api.pendingPermissions[0];
    assert.notStrictEqual(second, first, "re-armed cue must be a fresh entry, not the dismissed one");
    assert.strictEqual(second.isKimiNotify, true);
    assert.strictEqual(second.kimiToolName, "shell");
    assert.deepStrictEqual(second.kimiToolInput, { command: "Remove-Item a.txt" });
    assert.ok(second.bubble && !second.bubble.destroyed, "re-armed cue should own a live bubble window");
  });

  it("rebuilds a fresh card after the previous cue auto-expired", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const harness = createPermissionHarness();
    const { api } = harness;

    api.showKimiNotifyBubble({
      sessionId: "kimi-a",
      toolName: "write_file",
      permissionToolInput: { file_path: "a.txt" },
    });
    assert.strictEqual(api.pendingPermissions.length, 1);
    const first = api.pendingPermissions[0];

    // Default notification auto-close is 10s in this harness — let it expire.
    mock.timers.tick(10_000);
    assert.strictEqual(api.pendingPermissions.length, 0);

    api.showKimiNotifyBubble({
      sessionId: "kimi-a",
      toolName: "shell",
      permissionToolInput: { command: "Remove-Item a.txt" },
    });
    assert.strictEqual(api.pendingPermissions.length, 1);
    const second = api.pendingPermissions[0];
    assert.notStrictEqual(second, first);
    assert.strictEqual(second.kimiToolName, "shell");
    assert.ok(second.bubble && !second.bubble.destroyed);
  });
});

describe("interactive permission bubble lifecycle", () => {
  afterEach(() => {
    mock.timers.reset();
    delete require.cache[PERMISSION_MODULE_PATH];
    for (const logPath of tempLogPaths) {
      try { fs.unlinkSync(logPath); } catch {}
    }
    tempLogPaths.clear();
  });

  function makeBlockingEntry({ agentId = "claude-code", ...overrides } = {}) {
    const response = {
      writableEnded: false,
      writableFinished: false,
      destroyed: false,
      destroyCalls: 0,
      statusCode: null,
      body: "",
      replyCount: 0,
      on() {},
      removeListener() {},
      writeHead(statusCode) { this.statusCode = statusCode; },
      end(body) {
        this.body += body || "";
        this.replyCount += 1;
        this.writableEnded = true;
        this.writableFinished = true;
      },
      destroy() {
        this.destroyCalls += 1;
        this.destroyed = true;
      },
    };
    return {
      response,
      entry: {
        res: response,
        abortHandler() {},
        suggestions: [],
        sessionId: `${agentId}-lifecycle-bubble`,
        bubble: null,
        hideTimer: null,
        toolName: "Bash",
        toolInput: { command: "npm test" },
        createdAt: Date.now(),
        agentId,
        isCodex: agentId === "codex",
        interaction: classifyPermissionInteraction({
          agentId,
          eventKind: "permission",
          toolName: "Bash",
        }),
        ...overrides,
      },
    };
  }

  // opencode-family v1 / MiMo reply through the plugin's reverse bridge, not
  // through an HTTP response on the entry. Swap http.request so a regression
  // that forwards a synthetic reject on user-close turns the test red instead
  // of hitting a real socket.
  function withBridgeRequestRecorder(run) {
    const requests = [];
    const originalRequest = http.request;
    http.request = function recordBridgeRequest(...args) {
      requests.push(args);
      return { on() {}, write() {}, end() {}, destroy() {}, setTimeout() {} };
    };
    try {
      return run(requests);
    } finally {
      http.request = originalRequest;
    }
  }

  it("closing a Codex window returns no-decision once and cancels its mirrored approval", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const harness = createPermissionHarness();
    const { entry, response } = makeBlockingEntry({ agentId: "codex" });
    const sibling = makeBlockingEntry({ agentId: "codex" });
    const controller = new AbortController();
    const outcomes = [];
    entry.remoteApprovalAbortControllers = [controller];
    entry.remoteApprovalRequests = [{
      name: "test-remote",
      signal: controller.signal,
      client: {
        resolveApprovalExternally(signal, outcome) {
          assert.strictEqual(signal, controller.signal);
          outcomes.push(outcome.decision);
          return true;
        },
      },
    }];
    harness.api.pendingPermissions.push(entry, sibling.entry);
    harness.api.showPermissionBubble(entry);
    harness.api.showPermissionBubble(sibling.entry);

    const bubble = entry.bubble;
    bubble.destroy();

    assert.strictEqual(response.statusCode, 204);
    assert.strictEqual(response.body, "");
    assert.strictEqual(response.replyCount, 1);
    assert.deepStrictEqual(harness.api.pendingPermissions, [sibling.entry]);
    assert.strictEqual(sibling.response.writableEnded, false);
    assert.strictEqual(sibling.entry.bubble.destroyed, false);
    assert.strictEqual(controller.signal.aborted, true);
    assert.deepStrictEqual(outcomes, ["no-decision"]);

    bubble._closedHandler();
    harness.api.resolvePermissionEntry(entry, "allow");
    harness.api.resolvePermissionEntry(entry, "deny");
    assert.strictEqual(response.replyCount, 1);
    assert.deepStrictEqual(outcomes, ["no-decision"]);
    harness.api.cleanup();
  });

  for (const behavior of ["allow", "deny"]) {
    it(`closing an already ${behavior}-resolved Codex window sends no second decision`, () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      const harness = createPermissionHarness();
      const { entry, response } = makeBlockingEntry({ agentId: "codex" });
      harness.api.pendingPermissions.push(entry);
      harness.api.showPermissionBubble(entry);
      const bubble = entry.bubble;

      harness.api.resolvePermissionEntry(entry, behavior);
      bubble.destroy();
      bubble._closedHandler();

      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(JSON.parse(response.body).hookSpecificOutput.decision.behavior, behavior);
      assert.strictEqual(response.replyCount, 1);
      assert.strictEqual(harness.api.pendingPermissions.length, 0);
    });
  }

  it("application cleanup releases a Codex approval without a second decision on window close", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const harness = createPermissionHarness();
    const { entry, response } = makeBlockingEntry({ agentId: "codex" });
    harness.api.pendingPermissions.push(entry);
    harness.api.showPermissionBubble(entry);
    const bubble = entry.bubble;

    harness.api.cleanup();
    bubble._closedHandler();

    assert.strictEqual(response.statusCode, 204);
    assert.strictEqual(response.body, "");
    assert.strictEqual(response.replyCount, 1);
    assert.strictEqual(harness.api.pendingPermissions.length, 0);
  });

  it("closing a pending Claude window retains its explicit user-close deny", () => {
    const harness = createPermissionHarness();
    const { entry, response } = makeBlockingEntry();
    harness.api.pendingPermissions.push(entry);
    harness.api.showPermissionBubble(entry);

    entry.bubble.destroy();

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(JSON.parse(response.body).hookSpecificOutput.decision.behavior, "deny");
    assert.strictEqual(response.replyCount, 1);
    assert.strictEqual(harness.api.pendingPermissions.length, 0);
  });

  for (const { agentId, bridgeToken, label, article } of [
    { agentId: "opencode", bridgeToken: "token_opencode_v1", label: "OpenCode v1", article: "an" },
    { agentId: "mimocode", bridgeToken: "token_mimocode", label: "MiMo Code", article: "a" },
  ]) {
    it(`closing ${article} ${label} window falls back to the native prompt without a bridge reply`, () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      const harness = createPermissionHarness();
      withBridgeRequestRecorder((bridgeRequests) => {
        const { entry } = makeBlockingEntry({
          agentId,
          res: null,
          familyRequestId: `per-${agentId}`,
          familyBridgeUrl: "http://127.0.0.1:43210",
          familyBridgeToken: bridgeToken,
        });
        harness.api.pendingPermissions.push(entry);
        harness.api.showPermissionBubble(entry);
        const bubble = entry.bubble;

        bubble.destroy();
        bubble._closedHandler();

        // no-decision is a silent drop: the host keeps waiting on its native
        // prompt, so the bridge must never see a fabricated once/reject.
        assert.strictEqual(bridgeRequests.length, 0, "user close must not send a bridge reply");
        assert.strictEqual(harness.api.pendingPermissions.length, 0);

        // A stale follow-up decision must not produce a second outcome either.
        harness.api.resolvePermissionEntry(entry, "deny");
        assert.strictEqual(bridgeRequests.length, 0);
      });
      harness.api.cleanup();
    });

    for (const behavior of ["allow", "deny"]) {
      it(`closing an already ${behavior}-resolved ${label} window sends no second bridge reply`, () => {
        mock.timers.enable({ apis: ["setTimeout"] });
        const harness = createPermissionHarness();
        withBridgeRequestRecorder((bridgeRequests) => {
          const { entry } = makeBlockingEntry({
            agentId,
            res: null,
            familyRequestId: `per-${agentId}-${behavior}`,
            familyBridgeUrl: "http://127.0.0.1:43210",
            familyBridgeToken: bridgeToken,
          });
          harness.api.pendingPermissions.push(entry);
          harness.api.showPermissionBubble(entry);
          const bubble = entry.bubble;

          harness.api.resolvePermissionEntry(entry, behavior);
          assert.strictEqual(bridgeRequests.length, 1, "the explicit decision reaches the bridge");

          bubble.destroy();
          bubble._closedHandler();

          assert.strictEqual(bridgeRequests.length, 1, "close after resolution must not send a second reply");
          assert.strictEqual(harness.api.pendingPermissions.length, 0);
        });
        harness.api.cleanup();
      });
    }
  }

  it("closing an OpenCode v2 window answers 204 no-decision instead of deny", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const harness = createPermissionHarness();
    const { entry, response } = makeBlockingEntry({
      agentId: "opencode",
      isOpencodeV2: true,
      familyRequestId: "per-opencode-v2",
    });
    harness.api.pendingPermissions.push(entry);
    harness.api.showPermissionBubble(entry);
    const bubble = entry.bubble;

    bubble.destroy();

    assert.strictEqual(response.statusCode, 204);
    assert.strictEqual(response.body, "");
    assert.strictEqual(response.replyCount, 1);
    assert.strictEqual(harness.api.pendingPermissions.length, 0);

    // A late deny must not replace the native fallback with an explicit reject.
    bubble._closedHandler();
    harness.api.resolvePermissionEntry(entry, "deny");
    assert.strictEqual(response.statusCode, 204);
    assert.strictEqual(response.replyCount, 1);
    harness.api.cleanup();
  });

  for (const behavior of ["allow", "deny"]) {
    it(`closing an already ${behavior}-resolved OpenCode v2 window sends no second decision`, () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      const harness = createPermissionHarness();
      const { entry, response } = makeBlockingEntry({
        agentId: "opencode",
        isOpencodeV2: true,
        familyRequestId: `per-opencode-v2-${behavior}`,
      });
      harness.api.pendingPermissions.push(entry);
      harness.api.showPermissionBubble(entry);
      const bubble = entry.bubble;

      harness.api.resolvePermissionEntry(entry, behavior);
      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(
        JSON.parse(response.body).decision,
        behavior === "deny" ? "deny" : "allow"
      );
      assert.strictEqual(response.replyCount, 1);

      bubble.destroy();
      bubble._closedHandler();

      assert.strictEqual(response.replyCount, 1);
      assert.strictEqual(harness.api.pendingPermissions.length, 0);
      harness.api.cleanup();
    });
  }

  it("does not announce when BrowserWindow construction fails", () => {
    const harness = createPermissionHarness({ loadBehavior: "constructor-throw" });
    const { entry } = makeBlockingEntry();
    harness.api.pendingPermissions.push(entry);

    assert.throws(() => harness.api.showPermissionBubble(entry), /BrowserWindow unavailable/);
    assert.deepStrictEqual(harness.slackAnnouncements, []);
  });

  it("returns no-decision immediately when bubble.html cannot be loaded", () => {
    const harness = createPermissionHarness({ loadBehavior: "throw" });
    const { entry, response } = makeBlockingEntry();
    harness.api.pendingPermissions.push(entry);

    assert.doesNotThrow(() => harness.api.showPermissionBubble(entry));
    assert.strictEqual(harness.api.pendingPermissions.length, 0);
    assert.strictEqual(response.destroyed, true);
    assert.deepStrictEqual(harness.slackAnnouncements, []);
  });

  it("returns no-decision when loadFile rejects asynchronously", async () => {
    const harness = createPermissionHarness({ loadBehavior: "reject" });
    const { entry, response } = makeBlockingEntry();
    harness.api.pendingPermissions.push(entry);

    harness.api.showPermissionBubble(entry);
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(harness.api.pendingPermissions.length, 0);
    assert.strictEqual(response.destroyed, true);
    assert.strictEqual(response.destroyCalls, 1);
    assert.deepStrictEqual(harness.slackAnnouncements, []);
  });

  it("returns no-decision when the main frame emits did-fail-load", () => {
    const harness = createPermissionHarness({ loadBehavior: "event" });
    const { entry, response } = makeBlockingEntry();
    harness.api.pendingPermissions.push(entry);

    assert.doesNotThrow(() => harness.api.showPermissionBubble(entry));

    assert.strictEqual(harness.api.pendingPermissions.length, 0);
    assert.strictEqual(response.destroyed, true);
    assert.strictEqual(response.destroyCalls, 1);
    assert.deepStrictEqual(harness.slackAnnouncements, []);
  });

  it("does not turn a fatal no-decision into a second deny when closed fires", () => {
    const harness = createPermissionHarness({ loadBehavior: "throw" });
    const { entry, response } = makeBlockingEntry();
    harness.api.pendingPermissions.push(entry);

    harness.api.showPermissionBubble(entry);
    const bubble = harness.createdWindows[0];
    bubble._closedHandler();

    assert.strictEqual(harness.api.pendingPermissions.length, 0);
    assert.strictEqual(response.destroyCalls, 1);
  });

  it("skips permission-hide cleanly when a live bubble has no webContents", () => {
    const logPath = createTempLogPath();
    const harness = createPermissionHarness({ logPath });
    const { entry, response } = makeBlockingEntry();
    entry.createdAt = Date.now() - 5000;
    harness.api.pendingPermissions.push(entry);
    harness.api.showPermissionBubble(entry);
    entry.bubble.webContents = null;

    assert.doesNotThrow(() => {
      harness.api.resolvePermissionEntry(entry, "no-decision", "test cleanup");
    });

    assert.strictEqual(response.destroyCalls, 1);
    const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    assert.doesNotMatch(logText, /permission bubble hide failed/);
  });

  it("returns no-decision exactly once when the renderer process exits", () => {
    const harness = createPermissionHarness();
    const { entry, response } = makeBlockingEntry();
    harness.api.pendingPermissions.push(entry);
    harness.api.showPermissionBubble(entry);
    assert.strictEqual(harness.api.pendingPermissions.length, 1);

    const bubble = harness.createdWindows[0];
    bubble._renderGoneHandler({}, { reason: "crashed" });
    bubble._renderGoneHandler({}, { reason: "crashed" });

    assert.strictEqual(harness.api.pendingPermissions.length, 0);
    assert.strictEqual(response.destroyed, true);
    assert.deepStrictEqual(harness.slackAnnouncements, []);
  });

  it("dismisses a passive notification safely when its renderer process exits", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    mock.timers.setTime(100_000);
    const logPath = createTempLogPath();
    const harness = createPermissionHarness({ logPath });
    harness.api.showKimiNotifyBubble({
      sessionId: "kimi-renderer-gone",
      toolName: "shell",
      permissionAction: "execute",
    });
    assert.strictEqual(harness.api.pendingPermissions.length, 1);

    const entry = harness.api.pendingPermissions[0];
    const bubble = entry.bubble;
    bubble.webContents.isDestroyed = () => true;
    bubble.webContents.send = () => {
      throw new Error("send must not target destroyed webContents");
    };

    assert.doesNotThrow(() => {
      bubble._renderGoneHandler({}, { reason: "crashed" });
      bubble._renderGoneHandler({}, { reason: "crashed" });
    });
    assert.strictEqual(harness.api.pendingPermissions.length, 0);
    const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    assert.doesNotMatch(logText, /permission bubble hide failed/);

    mock.timers.tick(250);
    assert.strictEqual(bubble.destroyed, true);
  });
});

// Joint state ↔ permission coverage (codex review request): drive the REAL
// state-machine scheduling into the REAL permission bubble layer and assert
// what the user actually sees. Batched synthesized PermissionRequests must
// keep the visible card on the queue head (t1) until Post(t1) settles it,
// and only then advance to t2.
describe("state ↔ permission joint: batched immediate cues stay on the queue head", () => {
  afterEach(() => {
    mock.timers.reset();
    delete require.cache[PERMISSION_MODULE_PATH];
    for (const logPath of tempLogPaths) {
      try { fs.unlinkSync(logPath); } catch {}
    }
    tempLogPaths.clear();
  });

  it("visible card stays on t1 until Post(t1), then advances to t2", () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    mock.timers.setTime(100_000);
    const harness = createPermissionHarness();
    const permApi = harness.api;

    const themeLoader = require("../src/theme-loader");
    themeLoader.init(path.join(__dirname, "..", "src"));
    const { createTranslator } = require("../src/i18n");
    const stateCtx = {
      lang: "en",
      theme: themeLoader.loadTheme("clawd"),
      doNotDisturb: false,
      miniTransitioning: false,
      miniMode: false,
      mouseOverPet: false,
      idlePaused: false,
      forceEyeResend: false,
      eyePauseUntil: 0,
      mouseStillSince: Date.now(),
      miniSleepPeeked: false,
      playSound: () => {},
      sendToRenderer: () => {},
      syncHitWin: () => {},
      sendToHitWin: () => {},
      miniPeekIn: () => {},
      miniPeekOut: () => {},
      buildContextMenu: () => {},
      buildTrayMenu: () => {},
      processKill: () => { const e = new Error("ESRCH"); e.code = "ESRCH"; throw e; },
      getCursorScreenPoint: () => ({ x: 100, y: 100 }),
      // The wiring under test: state's cue scheduling drives the real
      // permission layer instead of a recording stub.
      showKimiNotifyBubble: (entry) => permApi.showKimiNotifyBubble(entry),
      clearKimiNotifyBubbles: (sessionId, reason) => permApi.clearKimiNotifyBubbles(sessionId, reason),
    };
    stateCtx.t = createTranslator(() => stateCtx.lang);
    const stateApi = require("../src/state")(stateCtx);

    try {
      // Batched immediate mode: t1 and t2 land back-to-back while the
      // terminal blocks on t1.
      stateApi.updateSession("kimi-cli:s1", "notification", "PermissionRequest", {
        agentId: "kimi-cli",
        permissionGateOpen: true,
        permissionGateId: "t1",
        toolName: "shell",
        permissionToolInput: { command: "npm install" },
      });
      stateApi.updateSession("kimi-cli:s1", "notification", "PermissionRequest", {
        agentId: "kimi-cli",
        permissionGateOpen: true,
        permissionGateId: "t2",
        toolName: "write_file",
        permissionToolInput: { file_path: "b.txt" },
      });
      assert.strictEqual(permApi.pendingPermissions.length, 1);
      assert.strictEqual(permApi.pendingPermissions[0].kimiToolName, "shell");
      assert.deepStrictEqual(permApi.pendingPermissions[0].kimiToolInput, { command: "npm install" });

      // User approves t1: the card drops with the settled gate...
      stateApi.updateSession("kimi-cli:s1", "working", "PostToolUse", {
        agentId: "kimi-cli",
        permissionGated: true,
        permissionGateId: "t1",
      });
      assert.strictEqual(permApi.pendingPermissions.length, 0);

      // ...and the re-armed cue advances to t2.
      mock.timers.tick(800);
      assert.strictEqual(permApi.pendingPermissions.length, 1);
      assert.strictEqual(permApi.pendingPermissions[0].isKimiNotify, true);
      assert.strictEqual(permApi.pendingPermissions[0].kimiToolName, "write_file");
      assert.deepStrictEqual(permApi.pendingPermissions[0].kimiToolInput, { file_path: "b.txt" });

      // t2 answered: everything settles, nothing re-arms.
      stateApi.updateSession("kimi-cli:s1", "working", "PostToolUse", {
        agentId: "kimi-cli",
        permissionGated: true,
        permissionGateId: "t2",
      });
      mock.timers.tick(5000);
      assert.strictEqual(permApi.pendingPermissions.length, 0);
    } finally {
      stateApi.cleanup();
    }
  });
});
