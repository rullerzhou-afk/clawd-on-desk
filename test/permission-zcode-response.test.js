"use strict";

const assert = require("node:assert");
const Module = require("node:module");
const { describe, it } = require("node:test");

const PERMISSION_MODULE_PATH = require.resolve("../src/permission");

function loadPermissionWithElectron(fakeElectron = null) {
  delete require.cache[PERMISSION_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return fakeElectron || {
        BrowserWindow: Object.assign(class {}, { fromWebContents() { return null; } }),
        globalShortcut: {
          register() { return true; },
          unregister() {},
          isRegistered() { return false; },
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/permission");
  } finally {
    Module._load = originalLoad;
  }
}

function createDecisionHarness() {
  const focusCalls = [];
  const fakeElectron = {
    BrowserWindow: Object.assign(class {}, {
      fromWebContents(sender) { return sender && sender.__window ? sender.__window : null; },
    }),
    globalShortcut: {
      register() { return true; },
      unregister() {},
      isRegistered() { return false; },
    },
  };
  const api = loadPermissionWithElectron(fakeElectron)({
    sessions: new Map(),
    hideBubbles: false,
    petHidden: false,
    win: null,
    lang: "en",
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    focusTerminalForSession: (sessionId, options) => focusCalls.push([sessionId, options]),
    permDebugLog: null,
  });
  return { api, focusCalls };
}

function createFakeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: "",
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    _listeners: new Map(),
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers || {};
    },
    end(data) {
      if (data) this.body += String(data);
      this.writableEnded = true;
      this.writableFinished = true;
    },
    on(event, handler) {
      this._listeners.set(event, handler);
      return this;
    },
    removeListener(event, handler) {
      if (this._listeners.get(event) === handler) this._listeners.delete(event);
      return this;
    },
    destroy() {
      this.destroyed = true;
      this.writableEnded = true;
      this.writableFinished = true;
      const handler = this._listeners.get("close");
      if (handler) handler();
    },
  };
  return res;
}

function createFakeBubble() {
  const bubble = {
    hidden: false,
    destroyed: false,
    webContents: {
      send(event) {
        if (event === "permission-hide") bubble.hidden = true;
      },
    },
    isDestroyed() { return this.destroyed; },
    destroy() { this.destroyed = true; },
  };
  return bubble;
}

function makeZcodeEntry(overrides = {}) {
  const res = createFakeRes();
  return {
    res,
    abortHandler: () => {},
    suggestions: [],
    sessionId: "zcode:s1",
    bubble: null,
    hideTimer: null,
    toolName: "Bash",
    toolInput: { command: "npm test" },
    createdAt: Date.now(),
    agentId: "zcode",
    isZcode: true,
    interaction: {
      intent: "tool-approval",
      automationEligibility: { autoTools: false, unattended: false },
      capabilities: { allowDeny: true, answerQuestions: false, planFeedback: false, nativeFallback: true },
    },
    ...overrides,
    res,
  };
}

function makeZcodeQuestionEntry(overrides = {}) {
  const wireInput = {
    questions: [
      {
        question: "Ship now?",
        header: "Ship",
        multiSelect: false,
        options: [
          { label: "Ship", description: "yes" },
          { label: "Hold", description: "no" },
        ],
      },
    ],
  };
  return makeZcodeEntry({
    toolName: "AskUserQuestion",
    toolInput: { questions: wireInput.questions },
    elicitationWireInput: wireInput,
    isElicitation: true,
    interaction: {
      intent: "human-question",
      automationEligibility: { autoTools: false, unattended: false },
      capabilities: { allowDeny: false, answerQuestions: true, planFeedback: false, nativeFallback: true },
    },
    ...overrides,
  });
}

describe("ZCode question decision contract (#1264 review)", () => {
  it("maps a question card's deny-and-focus to a 204 no-decision, never a wire deny", () => {
    const { api, focusCalls } = createDecisionHarness();
    const entry = makeZcodeQuestionEntry({ bubble: createFakeBubble() });
    api.pendingPermissions.push(entry);

    api.handleDecide({ sender: { __window: entry.bubble } }, "deny-and-focus");

    // "Go to terminal" on a question must hand it back to ZCode's native
    // prompt (204), not reject the question with {behavior:"deny"}.
    assert.strictEqual(entry.res.statusCode, 204);
    assert.strictEqual(entry.res.writableEnded, true);
    assert.strictEqual(entry.res.body, "");
    assert.strictEqual(focusCalls.length, 1);
    assert.strictEqual(api.pendingPermissions.length, 0);
  });

  it("degrades an elicitation allow without a wire-shaped answer to no-decision", () => {
    const { api } = createDecisionHarness();
    const entry = makeZcodeQuestionEntry({
      // An over-budget wire input passes the route ingress budgets but its
      // rebuilt answer object exceeds the 64 KiB wire answer cap, so the
      // shape guard rejects it — the bare allow would run the question with
      // no answers.
      elicitationWireInput: {
        questions: [{ question: "Big?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }],
        blob: "x".repeat(70000),
      },
      resolvedUpdatedInput: {
        questions: [{ question: "Big?" }],
        answers: { "Big?": "A" },
        blob: "x".repeat(70000),
      },
    });
    api.pendingPermissions.push(entry);

    api.resolvePermissionEntry(entry, "allow");

    assert.strictEqual(entry.res.statusCode, 204);
    assert.strictEqual(entry.res.body, "");
    assert.strictEqual(api.pendingPermissions.length, 0);
  });

  it("keeps an elicitation allow that carries the exact answer object", () => {
    const { api } = createDecisionHarness();
    const entry = makeZcodeQuestionEntry({
      resolvedUpdatedInput: {
        questions: [{ question: "Ship now?" }],
        answers: { "Ship now?": "Ship" },
      },
    });
    api.pendingPermissions.push(entry);

    api.resolvePermissionEntry(entry, "allow");

    assert.strictEqual(entry.res.statusCode, 200);
    const decision = JSON.parse(entry.res.body).hookSpecificOutput.decision;
    assert.deepStrictEqual(decision, {
      behavior: "allow",
      updatedInput: {
        questions: [{ question: "Ship now?" }],
        answers: { "Ship now?": "Ship" },
      },
    });
    assert.strictEqual(api.pendingPermissions.length, 0);
  });

  it("forwards isZcode in the bubble payload so the renderer can remap Go to terminal", () => {
    const { api } = createDecisionHarness();
    const payload = api.buildPermissionBubblePayload(makeZcodeEntry());
    assert.strictEqual(payload.isZcode, true);
  });
});
