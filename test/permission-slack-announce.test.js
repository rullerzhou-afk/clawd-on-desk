// Slack "approval needed" announcements must describe reality.
//
// Slack is notification-only in this build: the message tells the user to go
// approve something in the desktop app, and there is no follow-up "resolved"
// message to correct it. So the announce point matters more than it would for
// an interactive channel — a ping for a request Clawd auto-approved a
// microsecond later sends the user to an app with nothing to approve.
//
// The announce therefore happens where a human decision is known to be pending:
//   - handleBubbleHeight, after the renderer has loaded the exact interaction,
//     revealed the card, and acknowledged it through height IPC; and
//   - a remote client's explicit delivery acknowledgement, for bubble-less
//     remote-only entries.
// Never from addPendingPermission, which only means "the route queued it".

const { describe, it } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

const {
  classifyPermissionInteraction,
} = require("../src/permission-automation-policy");

const PERMISSION_MODULE_PATH = require.resolve("../src/permission");

class FakeBrowserWindow {
  constructor() {
    this.destroyed = false;
    this.bounds = null;
    this.sentEvents = [];
    this.listeners = new Map();
    this.webContents = {
      once: (event, callback) => this.listeners.set(event, callback),
      on: (event, callback) => this.listeners.set(event, callback),
      send: (...args) => this.sentEvents.push(args),
    };
  }

  setAlwaysOnTop() {}
  setBounds(bounds) { this.bounds = bounds; }
  setSkipTaskbar() {}
  showInactive() {}
  focus() {}
  on(event, callback) { this.listeners.set(event, callback); }
  isDestroyed() { return this.destroyed; }
  destroy() {
    this.destroyed = true;
    const closed = this.listeners.get("closed");
    if (closed) closed();
  }
  loadFile() {
    const finished = this.listeners.get("did-finish-load");
    if (finished) finished();
  }
}

FakeBrowserWindow.fromWebContents = (sender) => sender && sender.__window || null;

function loadPermissionWithFakeElectron() {
  delete require.cache[PERMISSION_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return {
        BrowserWindow: FakeBrowserWindow,
        globalShortcut: {
          register: () => true,
          unregister() {},
          isRegistered: () => false,
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

const initPermission = loadPermissionWithFakeElectron();

function makeCapturingRes() {
  const captured = { statusCode: null, body: "", destroyCalls: 0 };
  return {
    captured,
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    writeHead(status) { captured.statusCode = status; this.headersSent = true; },
    end(chunk) { if (chunk !== undefined) captured.body += String(chunk); this.writableEnded = true; },
    destroy() { captured.destroyCalls++; this.destroyed = true; },
    on() {},
    removeListener() {},
  };
}

function makeCtx(overrides = {}) {
  const announced = [];
  const announceOptions = [];
  const ctx = {
    lang: "en",
    focusTerminalForSession() {},
    getSettingsSnapshot: () => ({}),
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    isAgentSubagentPermissionsEnabled: () => true,
    getPermissionAutomationMode: () => "off",
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    getPetWindowBounds: () => ({ x: 200, y: 200, width: 128, height: 128 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getHitRectScreen: () => null,
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
    permDebugLog: null,
    repositionUpdateBubble: () => {},
    win: null,
    bubbleFollowPet: false,
    petHidden: false,
    doNotDisturb: false,
    hideBubbles: false,
    pendingPermissions: [],
    sessions: new Map(),
    sendPermissionResponse: () => {},
    subscribeShortcuts: () => {},
    reportShortcutFailure: () => {},
    clearShortcutFailure: () => {},
    STATE_SVGS: {},
    setState: () => {},
    updateSession: () => {},
    notifySlackPermission: (payload, options) => {
      announced.push(payload);
      announceOptions.push(options);
    },
    ...overrides,
  };
  ctx.announced = announced;
  ctx.announceOptions = announceOptions;
  return ctx;
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makePermEntry(overrides = {}) {
  const entry = {
    res: makeCapturingRes(),
    abortHandler: () => {},
    suggestions: [],
    sessionId: "session-test",
    bubble: null,
    hideTimer: null,
    toolName: "Bash",
    toolInput: { command: "rm -rf /", description: "clean the tree" },
    resolvedSuggestion: null,
    createdAt: Date.now() - 5000,
    agentId: "claude-code",
    ...overrides,
  };
  entry.interaction = overrides.interaction || classifyPermissionInteraction({
    agentId: entry.agentId,
    eventKind: entry.isCodexNotify || entry.isKimiNotify ? "passive-notification" : "permission",
    toolName: entry.toolName,
  });
  return entry;
}

function renderAndAcknowledge(perm, entry, height = 180) {
  perm.showPermissionBubble(entry);
  assert.ok(entry.bubble, "precondition: a desktop bubble was constructed");
  perm.handleBubbleHeight({ sender: { __window: entry.bubble } }, height);
}

describe("slack permission announce: only for requests a human must answer", () => {
  it("does not announce when the entry is merely queued", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    perm.addPendingPermission(makePermEntry(), "added");
    assert.deepEqual(ctx.announced, []);
  });

  it("announces once when the request survives to a bubble", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");

    perm.showPermissionBubble(entry);
    assert.deepEqual(ctx.announced, [], "loading a BrowserWindow is not yet a rendered card");

    perm.handleBubbleHeight({ sender: { __window: entry.bubble } }, 180);
    assert.equal(ctx.announced.length, 1);
    assert.equal(typeof ctx.announceOptions[0].isStillRelevant, "function");
    assert.equal(ctx.announceOptions[0].isStillRelevant(), true);
    assert.match(ctx.announced[0].title, /Bash/);
    assert.equal(ctx.announced[0].toolName, "Bash");
    assert.equal(ctx.announced[0].agentId, "claude-code");

    // Renderer reflows (stepper/feedback/text-size) must not ping Slack twice.
    perm.handleBubbleHeight({ sender: { __window: entry.bubble } }, 220);
    assert.equal(ctx.announced.length, 1);
  });

  it("announces a rendered card even if the following bubble reflow throws", () => {
    const ctx = makeCtx({
      win: { isDestroyed: () => false },
    });
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");
    perm.showPermissionBubble(entry);
    ctx.getNearestWorkArea = () => { throw new Error("display disappeared"); };

    assert.throws(
      () => perm.handleBubbleHeight({ sender: { __window: entry.bubble } }, 180),
      /display disappeared/
    );
    assert.equal(ctx.announced.length, 1,
      "renderer delivery ACK must precede fallible geometry work");
  });

  it("stays silent when global automation auto-approves the request", () => {
    const ctx = makeCtx({ getPermissionAutomationMode: () => "unattended" });
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");

    perm.showPermissionBubble(entry);

    assert.equal(perm.pendingPermissions.includes(entry), false, "entry was auto-approved");
    assert.equal(JSON.parse(entry.res.captured.body).hookSpecificOutput.decision.behavior, "allow");
    assert.deepEqual(ctx.announced, [], "no Slack ping for a request nobody had to answer");
  });

  it("stays silent when auto-tools auto-approves an ordinary tool", () => {
    const ctx = makeCtx({ getPermissionAutomationMode: () => "auto-tools" });
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");

    perm.showPermissionBubble(entry);

    assert.equal(perm.pendingPermissions.includes(entry), false);
    assert.deepEqual(ctx.announced, []);
  });

  it("still announces the questions auto-tools defers to a human", () => {
    // The mirror image of the two cases above: same mode, same chokepoint, but
    // auto-tools refuses to answer a question on the user's behalf — so this
    // one really is waiting on them and Slack should say so.
    const ctx = makeCtx({ getPermissionAutomationMode: () => "auto-tools" });
    const perm = initPermission(ctx);
    const entry = makePermEntry({
      toolName: "AskUserQuestion",
      isElicitation: true,
      toolInput: { questions: [{ question: "Which one?" }] },
    });
    perm.addPendingPermission(entry, "added");

    renderAndAcknowledge(perm, entry);
    assert.equal(perm.pendingPermissions.includes(entry), true);
    assert.equal(ctx.announced.length, 1);
  });

  it("does not expand plan reviews into Slack permission notifications", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const entry = makePermEntry({ toolName: "ExitPlanMode", toolInput: { plan: "ship it" } });
    perm.addPendingPermission(entry, "added");

    renderAndAcknowledge(perm, entry);
    assert.equal(perm.pendingPermissions.includes(entry), true);
    assert.deepEqual(ctx.announced, []);
  });

  it("announces rendered opencode, MiMo, and Copilot Allow/Deny bubbles", () => {
    for (const agentId of ["opencode", "mimocode", "copilot-cli"]) {
      const ctx = makeCtx();
      const perm = initPermission(ctx);
      const entry = makePermEntry({
        agentId,
        res: agentId === "copilot-cli" ? makeCapturingRes() : null,
        toolInput: { description: `review ${agentId}` },
      });
      perm.addPendingPermission(entry, "added");

      renderAndAcknowledge(perm, entry);

      assert.equal(ctx.announced.length, 1, agentId);
      assert.equal(ctx.announced[0].kind, "approval", agentId);
      assert.equal(ctx.announced[0].actionTarget, "desktop", agentId);
    }
  });

  it("does not tell opencode-family questions to answer in an incapable desktop bubble", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const entry = makePermEntry({
      agentId: "opencode",
      res: null,
      toolName: "AskUserQuestion",
      toolInput: { questions: [{ question: "Which environment?" }] },
    });
    perm.addPendingPermission(entry, "added");

    renderAndAcknowledge(perm, entry);

    assert.equal(entry.interaction.capabilities.answerQuestions, false);
    assert.deepEqual(ctx.announced, []);
  });

  it("does not announce passthrough or invalid interactions", () => {
    for (const entry of [
      makePermEntry({ toolName: "TaskList" }),
      makePermEntry({ interaction: { intent: "tool-approval" } }),
    ]) {
      const ctx = makeCtx();
      const perm = initPermission(ctx);
      perm.addPendingPermission(entry, "added");
      renderAndAcknowledge(perm, entry);
      assert.deepEqual(ctx.announced, []);
    }
  });

  it("does not announce if the request resolves or DND starts before render acknowledgement", () => {
    const resolvedCtx = makeCtx();
    const resolvedPerm = initPermission(resolvedCtx);
    const resolvedEntry = makePermEntry();
    resolvedPerm.addPendingPermission(resolvedEntry, "added");
    resolvedPerm.showPermissionBubble(resolvedEntry);
    resolvedPerm.removePendingPermission(resolvedEntry, "resolved-before-render");
    resolvedPerm.handleBubbleHeight({ sender: { __window: resolvedEntry.bubble } }, 180);
    assert.deepEqual(resolvedCtx.announced, []);

    const dndCtx = makeCtx();
    const dndPerm = initPermission(dndCtx);
    const dndEntry = makePermEntry();
    dndPerm.addPendingPermission(dndEntry, "added");
    dndPerm.showPermissionBubble(dndEntry);
    dndCtx.doNotDisturb = true;
    dndPerm.handleBubbleHeight({ sender: { __window: dndEntry.bubble } }, 180);
    assert.deepEqual(dndCtx.announced, []);
  });

  it("stays silent when a session automation override auto-approves", () => {
    const ctx = makeCtx({
      getEffectivePermissionAutomationMode: () => "auto-tools",
      hasSessionAutomationOverride: () => true,
    });
    const perm = initPermission(ctx);
    const entry = makePermEntry({
      sessionAutomationIdentity: { eligible: true, reason: "verified" },
    });
    perm.addPendingPermission(entry, "added");

    perm.showPermissionBubble(entry);

    assert.equal(perm.pendingPermissions.includes(entry), false);
    assert.deepEqual(ctx.announced, []);
  });

  it("announces when a session override fails the live gate and a human must decide", () => {
    const ctx = makeCtx({
      getEffectivePermissionAutomationMode: () => "auto-tools",
      hasSessionAutomationOverride: () => true,
      isAgentPermissionsEnabled: () => false,
    });
    const perm = initPermission(ctx);
    const entry = makePermEntry({
      sessionAutomationIdentity: { eligible: true, reason: "verified" },
    });
    perm.addPendingPermission(entry, "added");

    renderAndAcknowledge(perm, entry);
    assert.equal(perm.pendingPermissions.includes(entry), true);
    assert.equal(ctx.announced.length, 1);
  });

  it("stays silent under Do Not Disturb", () => {
    // DND drops the request before it surfaces anywhere locally; a Slack ping
    // would be the one channel that still reached the user.
    const ctx = makeCtx({ doNotDisturb: true });
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");

    renderAndAcknowledge(perm, entry);
    assert.deepEqual(ctx.announced, []);
  });

  it("stays silent for passive notifications, which are not approvals", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const entry = makePermEntry({ isCodexNotify: true, agentId: "codex", res: null });
    perm.addPendingPermission(entry, "added");

    renderAndAcknowledge(perm, entry);
    assert.deepEqual(ctx.announced, []);
  });

  it("stays silent for headless sessions, which have no desktop app to go to", () => {
    const ctx = makeCtx({
      sessions: new Map([["session-test", { agentId: "claude-code", headless: true }]]),
    });
    const perm = initPermission(ctx);
    const entry = makePermEntry({ headless: true });
    perm.addPendingPermission(entry, "added");

    renderAndAcknowledge(perm, entry);
    assert.deepEqual(ctx.announced, []);
  });

  it("survives a throwing Slack notifier without breaking the bubble path", () => {
    const ctx = makeCtx({
      notifySlackPermission: () => { throw new Error("slack exploded"); },
    });
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");

    assert.doesNotThrow(() => renderAndAcknowledge(perm, entry));
    assert.equal(perm.pendingPermissions.includes(entry), true);
  });
});

describe("slack permission announce: remote-only entries", () => {
  function makeRemoteCtx(overrides = {}) {
    return makeCtx({
      getTelegramApprovalClient: () => null,
      ...overrides,
    });
  }

  it("waits for explicit card delivery before announcing a bubble-less entry", () => {
    const requested = [];
    let onDelivered;
    const client = {
      requestApproval: (payload, options) => {
        requested.push(payload);
        onDelivered = options.onDelivered;
        return new Promise(() => {});
      },
    };
    const ctx = makeRemoteCtx({ getRemoteApprovalClients: () => [{ name: "telegram", client }] });
    const perm = initPermission(ctx);
    const entry = makePermEntry({ bubble: null, remoteOnly: true });
    perm.addPendingPermission(entry, "added");

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(requested.length, 1);
    assert.deepEqual(ctx.announced, [], "starting the async send is not a delivery ACK");

    onDelivered({ messageId: 42 });
    assert.equal(ctx.announced.length, 1);
    assert.equal(ctx.announced[0].actionTarget, "remote");
    assert.equal(ctx.announceOptions[0].isStillRelevant(), true);

    onDelivered({ messageId: 42 });
    assert.equal(ctx.announced.length, 1, "duplicate client ACKs are once-guarded");
    perm.removePendingPermission(entry, "resolved-after-announcement");
    assert.equal(ctx.announceOptions[0].isStillRelevant(), false);
  });

  it("never sends a Grep search pattern as remote fallback detail", () => {
    const requested = [];
    const callbacks = [];
    const client = {
      requestApproval: (payload, options) => {
        requested.push(payload);
        callbacks.push(options.onDelivered);
        return new Promise(() => {});
      },
    };
    const ctx = makeRemoteCtx({ getRemoteApprovalClients: () => [{ name: "telegram", client }] });
    const perm = initPermission(ctx);
    const sensitivePattern = "(?i)john.doe@acme-holdings.example";
    const grep = makePermEntry({
      bubble: null,
      remoteOnly: true,
      toolName: "Grep",
      toolInput: { pattern: sensitivePattern },
    });
    const glob = makePermEntry({
      bubble: null,
      remoteOnly: true,
      sessionId: "session-glob",
      toolName: "Glob",
      toolInput: { pattern: "src/**/*.js" },
    });
    perm.addPendingPermission(grep, "added");
    perm.addPendingPermission(glob, "added");

    assert.equal(perm.maybeStartRemoteApproval(grep), true);
    assert.equal(perm.maybeStartRemoteApproval(glob), true);
    assert.equal(requested.length, 2);
    assert.ok(!JSON.stringify(requested[0]).includes(sensitivePattern),
      "Grep's raw search expression must stay on the desktop");
    assert.match(JSON.stringify(requested[0]), /No description available/i);
    assert.match(JSON.stringify(requested[1]), /src\/\*\*\/\*\.js/,
      "Glob file-selection patterns remain useful low-risk fallback context");

    callbacks[0]({ messageId: 1 });
    assert.ok(!JSON.stringify(ctx.announced[0]).includes(sensitivePattern),
      "the Slack announcement payload must remain free of the Grep expression");
  });

  it("does not announce when a remote attempt immediately resolves null or rejects", async () => {
    for (const requestApproval of [
      () => Promise.resolve(null),
      () => Promise.reject(new Error("send failed")),
    ]) {
      const client = { requestApproval };
      const ctx = makeRemoteCtx({ getRemoteApprovalClients: () => [{ name: "telegram", client }] });
      const perm = initPermission(ctx);
      const entry = makePermEntry({ bubble: null, remoteOnly: true });
      perm.addPendingPermission(entry, "added");

      assert.equal(perm.maybeStartRemoteApproval(entry), true);
      await flushPromises();
      assert.deepEqual(ctx.announced, []);
    }
  });

  it("re-checks pending and DND state when a remote delivery ACK arrives", () => {
    const callbacks = [];
    const client = {
      requestApproval: (_payload, options) => {
        callbacks.push(options.onDelivered);
        return new Promise(() => {});
      },
    };
    const ctx = makeRemoteCtx({ getRemoteApprovalClients: () => [{ name: "telegram", client }] });
    const perm = initPermission(ctx);

    const resolvedEntry = makePermEntry({ bubble: null, remoteOnly: true });
    perm.addPendingPermission(resolvedEntry, "added");
    perm.maybeStartRemoteApproval(resolvedEntry);
    perm.removePendingPermission(resolvedEntry, "resolved-before-delivery");
    callbacks[0]({ messageId: 1 });

    const dndEntry = makePermEntry({ bubble: null, remoteOnly: true, sessionId: "session-dnd" });
    perm.addPendingPermission(dndEntry, "added");
    perm.maybeStartRemoteApproval(dndEntry);
    ctx.doNotDisturb = true;
    callbacks[1]({ messageId: 2 });

    assert.deepEqual(ctx.announced, []);
  });

  it("announces only once when two remote clients both confirm delivery", () => {
    const callbacks = [];
    const clients = ["telegram", "feishu"].map((name) => ({
      name,
      client: {
        requestApproval: (_payload, options) => {
          callbacks.push(options.onDelivered);
          return new Promise(() => {});
        },
      },
    }));
    const ctx = makeRemoteCtx({ getRemoteApprovalClients: () => clients });
    const perm = initPermission(ctx);
    const entry = makePermEntry({ bubble: null, remoteOnly: true });
    perm.addPendingPermission(entry, "added");

    perm.maybeStartRemoteApproval(entry);
    callbacks[0]({ messageId: 1 });
    callbacks[1]({ messageId: "om_2" });
    assert.equal(ctx.announced.length, 1);
  });

  it("does not announce when no remote client picks the entry up", () => {
    const ctx = makeRemoteCtx({ getRemoteApprovalClients: () => [] });
    const perm = initPermission(ctx);
    const entry = makePermEntry({ bubble: null, remoteOnly: true });
    perm.addPendingPermission(entry, "added");

    assert.equal(perm.maybeStartRemoteApproval(entry), false);
    assert.deepEqual(ctx.announced, []);
  });

  it("does not announce an entry that automation already resolved out of the queue", () => {
    const client = {
      requestApproval: () => new Promise(() => {}),
    };
    const ctx = makeRemoteCtx({ getRemoteApprovalClients: () => [{ name: "telegram", client }] });
    const perm = initPermission(ctx);
    const entry = makePermEntry({ bubble: null, remoteOnly: true });
    // Never queued (or already resolved out) — maybeStartRemoteApproval bails.
    assert.equal(perm.maybeStartRemoteApproval(entry), false);
    assert.deepEqual(ctx.announced, []);
  });
});

// ── Interaction kind and action target (review item 4) ──────────────────────
// The announce ran every entry through the approval summary builder. For an
// AskUserQuestion that builder can never find a description, so Slack received
// "No description available" and told the reader to approve something that is
// actually a question — one that capabilities.allowDeny says cannot be approved.

function makeQuestionEntry(overrides = {}) {
  return makePermEntry({
    toolName: "AskUserQuestion",
    toolInput: {
      questions: [
        { header: "Rollout", question: "Which environment?",
          options: [{ label: "staging" }, { label: "production" }] },
      ],
    },
    interaction: classifyPermissionInteraction({
      agentId: "claude-code",
      eventKind: "permission",
      toolName: "AskUserQuestion",
    }),
    ...overrides,
  });
}

describe("slack announce: interaction kind and action target", () => {
  it("sends the questions themselves for an AskUserQuestion", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const entry = makeQuestionEntry();
    perm.addPendingPermission(entry, "added");
    renderAndAcknowledge(perm, entry);

    assert.equal(ctx.announced.length, 1);
    const payload = ctx.announced[0];
    assert.equal(payload.kind, "question");
    assert.ok(Array.isArray(payload.questions), "the questions must reach the renderer");
    assert.equal(payload.questions[0].question, "Which environment?");
    // The generic approval fallback must not be what describes it.
    assert.ok(!/No description available/i.test(payload.summary || ""),
      "the question content replaces the approval summary, not sits beside it");
  });

  it("marks an ordinary tool request as an approval decided on the desktop", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const entry = makePermEntry();
    perm.addPendingPermission(entry, "added");
    renderAndAcknowledge(perm, entry);

    assert.equal(ctx.announced[0].kind, "approval");
    assert.equal(ctx.announced[0].actionTarget, "desktop");
  });

  it("marks a remote-only entry as decided in the remote channel", () => {
    // Bubbles are disabled for this agent, so there is no desktop bubble to
    // point at — the usable action is in Telegram/Feishu.
    let onDelivered;
    const client = {
      requestApproval: (_payload, options) => {
        onDelivered = options.onDelivered;
        return new Promise(() => {});
      },
    };
    const ctx = makeCtx({
      getTelegramApprovalClient: () => null,
      getRemoteApprovalClients: () => [{ name: "telegram", client }],
    });
    const perm = initPermission(ctx);
    const entry = makePermEntry({ remoteOnly: true, bubble: null });
    perm.addPendingPermission(entry, "added");

    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.equal(ctx.announced.length, 0);
    onDelivered({ messageId: 42 });
    assert.equal(ctx.announced.length, 1);
    assert.equal(ctx.announced[0].actionTarget, "remote");
  });

  it("waits for the remote elicitation card delivery before announcing a question", () => {
    let onDelivered;
    const client = {
      requestElicitation: (_payload, options) => {
        onDelivered = options.onDelivered;
        return new Promise(() => {});
      },
      requestApproval: () => { throw new Error("question incorrectly routed as approval"); },
    };
    const ctx = makeCtx({
      getTelegramApprovalClient: () => null,
      getRemoteApprovalClients: () => [{ name: "telegram", client }],
    });
    const perm = initPermission(ctx);
    const entry = makeQuestionEntry({ remoteOnly: true, bubble: null });
    perm.addPendingPermission(entry, "added");

    assert.equal(entry.interaction.capabilities.answerQuestions, true);
    assert.equal(entry.interaction.intent, "human-question");
    assert.equal(entry.toolInput.questions.length, 1);
    assert.equal(perm.maybeStartRemoteApproval(entry), true);
    assert.deepEqual(ctx.announced, []);
    onDelivered({ messageId: 43 });
    assert.equal(ctx.announced.length, 1);
    assert.equal(ctx.announced[0].kind, "question");
    assert.equal(ctx.announced[0].actionTarget, "remote");
  });

  it("does not announce from the remote path for an entry that has a bubble", () => {
    // maybeStartRemoteApproval runs for ordinary bubbled entries too (codex,
    // qwen, CC elicitation all call it). Only remote-only entries should be
    // labelled "decide remotely" from there.
    let onDelivered;
    const client = {
      requestApproval: (_payload, options) => {
        onDelivered = options.onDelivered;
        return new Promise(() => {});
      },
    };
    const ctx = makeCtx({
      getTelegramApprovalClient: () => null,
      getRemoteApprovalClients: () => [{ name: "telegram", client }],
    });
    const perm = initPermission(ctx);
    const entry = makePermEntry(); // remoteOnly is falsy
    perm.addPendingPermission(entry, "added");

    perm.maybeStartRemoteApproval(entry);
    onDelivered({ messageId: 42 });
    assert.deepEqual(ctx.announced, [],
      "a remote delivery ACK cannot announce an entry that has a bubble");

    renderAndAcknowledge(perm, entry);
    assert.equal(ctx.announced.length, 1);
    assert.equal(ctx.announced[0].actionTarget, "desktop",
      "the renderer acknowledgement remains the sole announce path");
  });
});

describe("slack announce: main.js wiring", () => {
  it("the Slack permission ctx hook is actually provided by the main process", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    assert.match(source, /notifySlackPermission:\s*\(payload,\s*options\s*=\s*\{\}\)\s*=>/,
      "main.js must provide notifySlackPermission");
  });
});
