// Auto-pilot (autoApproveAllPermissions) chokepoint in showPermissionBubble.
//
// When the toggle is on, showPermissionBubble must resolve the entry as
// "allow" and return BEFORE constructing a BrowserWindow — that early return
// is also what lets this test run without a real Electron window.
// The DND / per-agent / headless gates live earlier in the route (server-
// route-permission.js), so they still win: by the time showPermissionBubble
// runs, a gated request never reaches it. Headless fallback is deliberately
// agent-specific: some agents get no-decision/native fallback, opencode gets
// silent TUI fallback, and Claude/CodeBuddy keep their existing auto-deny.
//
// Exclusions: passive codex/kimi notifications are not approvals and must
// NOT be auto-resolved.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const initPermission = require("../src/permission");

function makeCtx(overrides = {}) {
  return {
    focusTerminalForSession() {},
    getSettingsSnapshot: () => ({}),
    isAgentPermissionsEnabled: () => true,
    isAutoApproveAllEnabled: () => true,
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    getPetWindowBounds: () => null,
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
    ...overrides,
  };
}

function makePermEntry(overrides = {}) {
  return {
    res: null,
    abortHandler: () => {},
    suggestions: [],
    sessionId: "session-test",
    bubble: null,
    hideTimer: null,
    toolName: "Bash",
    toolInput: { command: "rm -rf /" },
    resolvedSuggestion: null,
    createdAt: Date.now() - 5000,
    ...overrides,
  };
}

describe("auto-pilot: showPermissionBubble auto-approve chokepoint", () => {
  it("resolves a real tool request as allow without building a bubble", () => {
    const resolved = [];
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    // Capture resolve calls by wrapping the factory's resolvePermissionEntry.
    const origResolve = perm.resolvePermissionEntry;
    const permEntry = makePermEntry();
    perm.pendingPermissions.push(permEntry);

    // Patch ctx is not enough — resolve is internal. Spy by observing the
    // pending list + bubble state, which is the externally visible contract.
    perm.showPermissionBubble(permEntry);

    assert.equal(permEntry.bubble, null, "no BrowserWindow should be created");
    assert.equal(
      perm.pendingPermissions.indexOf(permEntry),
      -1,
      "entry should be resolved out of the pending list"
    );
    void origResolve; void resolved;
  });

  it("sends an allow decision down the HTTP response (Claude Code branch)", () => {
    const captured = { statusCode: null, body: "", headers: {} };
    const res = {
      writableEnded: false,
      destroyed: false,
      headersSent: false,
      writeHead(status, headers) {
        captured.statusCode = status;
        if (headers) Object.assign(captured.headers, headers);
        this.headersSent = true;
      },
      end(chunk) {
        if (chunk !== undefined) captured.body += String(chunk);
        this.writableEnded = true;
      },
      on() {},
      removeListener() {},
    };
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const permEntry = makePermEntry({ res, agentId: "claude-code" });
    perm.pendingPermissions.push(permEntry);

    perm.showPermissionBubble(permEntry);

    assert.equal(captured.statusCode, 200);
    const parsed = JSON.parse(captured.body);
    assert.equal(parsed.hookSpecificOutput.decision.behavior, "allow");
  });

  it("does nothing special when the toggle is off (would build a bubble)", () => {
    // With auto-approve off and win=null, showPermissionBubble proceeds to
    // BrowserWindow construction. We only assert the early-return did NOT
    // fire by checking the entry stays pending up to the point of bubble
    // creation throwing (no Electron in tests).
    const ctx = makeCtx({ isAutoApproveAllEnabled: () => false });
    const perm = initPermission(ctx);
    const permEntry = makePermEntry();
    perm.pendingPermissions.push(permEntry);

    assert.throws(() => perm.showPermissionBubble(permEntry));
    assert.equal(
      perm.pendingPermissions.indexOf(permEntry),
      0,
      "entry should still be pending (auto-approve did not consume it)"
    );
  });

  it("does NOT auto-approve passive codex notifications", () => {
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const permEntry = makePermEntry({ isCodexNotify: true, res: null });
    perm.pendingPermissions.push(permEntry);

    // Passive notify entries route to dismissPassiveNotify on resolve, never
    // to an allow. Auto-approve must skip them: with win=null the subsequent
    // bubble build throws, proving the early-return did not consume it.
    assert.throws(() => perm.showPermissionBubble(permEntry));
    assert.equal(perm.pendingPermissions.indexOf(permEntry), 0);
  });

  it("answers elicitation questions with a deferral reply so allow is a real allow", () => {
    const captured = { body: "" };
    const res = {
      writableEnded: false,
      destroyed: false,
      headersSent: false,
      writeHead() { this.headersSent = true; },
      end(chunk) { if (chunk !== undefined) captured.body += String(chunk); this.writableEnded = true; },
      on() {},
      removeListener() {},
    };
    const ctx = makeCtx();
    const perm = initPermission(ctx);
    const permEntry = makePermEntry({
      res,
      agentId: "claude-code",
      isElicitation: true,
      toolName: "AskUserQuestion",
      toolInput: { questions: [{ question: "Pick one" }, { question: "And another?" }] },
    });
    perm.pendingPermissions.push(permEntry);

    perm.showPermissionBubble(permEntry);

    // Elicitation allow path emits updatedInput, not a bare deny, and every
    // question is answered with the neutral defer-to-agent reply (not blank).
    const parsed = JSON.parse(captured.body);
    assert.equal(parsed.hookSpecificOutput.decision.behavior, "allow");
    assert.ok(parsed.hookSpecificOutput.decision.updatedInput, "updatedInput present");
    assert.deepEqual(parsed.hookSpecificOutput.decision.updatedInput.answers, {
      "Pick one": "You choose whatever is best.",
      "And another?": "You choose whatever is best.",
    });
  });
});

// ── Per-agent coverage ──────────────────────────────────────────────────────
// Auto-pilot must emit each agent's own "allow" wire format, not just resolve
// the entry. resolvePermissionEntry(entry, "allow") branches on the is* flags,
// so this walks every agent that actually routes through showPermissionBubble
// (the "A class" agents that hand their permission decision to Clawd) and
// asserts the captured HTTP/bridge reply is a real allow in that agent's shape.

const http = require("node:http");

function makeCapturingRes() {
  const captured = { statusCode: null, headers: {}, body: "", destroyCalls: 0 };
  return {
    captured,
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    writeHead(status, headers) {
      captured.statusCode = status;
      if (headers) Object.assign(captured.headers, headers);
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk !== undefined) captured.body += String(chunk);
      this.writableEnded = true;
    },
    destroy() { captured.destroyCalls++; this.destroyed = true; },
    on() {},
    removeListener() {},
  };
}

describe("auto-pilot: per-agent allow wire formats", () => {
  // Each case: the is* flags that the route stamps + a verify() over the
  // captured HTTP response body. CC / CodeBuddy / Kimi share the generic
  // hookSpecificOutput path (no is* flag).
  const cases = [
    {
      name: "claude-code",
      entry: { agentId: "claude-code" },
      verify(captured) {
        assert.equal(captured.statusCode, 200);
        const d = JSON.parse(captured.body).hookSpecificOutput.decision;
        assert.equal(d.behavior, "allow");
      },
    },
    {
      name: "codebuddy (shares CC path)",
      entry: { agentId: "codebuddy" },
      verify(captured) {
        const d = JSON.parse(captured.body).hookSpecificOutput.decision;
        assert.equal(d.behavior, "allow");
      },
    },
    {
      name: "kimi-cli (interactive perm, shares CC path)",
      entry: { agentId: "kimi-cli" },
      verify(captured) {
        const d = JSON.parse(captured.body).hookSpecificOutput.decision;
        assert.equal(d.behavior, "allow");
      },
    },
    {
      name: "codex",
      entry: { agentId: "codex", isCodex: true },
      verify(captured) {
        assert.equal(captured.statusCode, 200);
        const d = JSON.parse(captured.body).hookSpecificOutput.decision;
        assert.equal(d.behavior, "allow");
      },
    },
    {
      name: "qwen-code",
      entry: { agentId: "qwen-code", isQwenCode: true },
      verify(captured) {
        const d = JSON.parse(captured.body).hookSpecificOutput.decision;
        assert.equal(d.behavior, "allow");
      },
    },
    {
      name: "copilot-cli (bare {behavior} format)",
      entry: { agentId: "copilot-cli", isCopilotCli: true },
      verify(captured) {
        assert.equal(captured.statusCode, 200);
        const body = JSON.parse(captured.body);
        // Copilot has no hookSpecificOutput envelope — bare {behavior}.
        assert.equal(body.behavior, "allow");
        assert.equal(body.hookSpecificOutput, undefined);
      },
    },
    {
      name: "hermes ({decision} format)",
      entry: { agentId: "hermes", isHermes: true },
      verify(captured) {
        const body = JSON.parse(captured.body);
        assert.equal(body.decision, "allow");
      },
    },
  ];

  for (const c of cases) {
    it(`auto-approves ${c.name} with the correct allow format`, () => {
      const res = makeCapturingRes();
      const ctx = makeCtx();
      const perm = initPermission(ctx);
      const permEntry = makePermEntry({ res, ...c.entry });
      perm.pendingPermissions.push(permEntry);

      perm.showPermissionBubble(permEntry);

      assert.equal(
        perm.pendingPermissions.indexOf(permEntry),
        -1,
        "entry resolved out of pending list"
      );
      assert.equal(permEntry.bubble, null, "no bubble created");
      c.verify(res.captured);
    });
  }

  it("auto-approves opencode by replying 'once' over the bridge", async () => {
    // opencode has no held HTTP response — the decision goes back via a POST
    // to the plugin's reverse bridge. Stand up a real listener to capture it.
    const received = await new Promise((resolve, reject) => {
      const server = http.createServer();
      server.on("request", (req, res) => {
        let body = "";
        req.on("data", (ch) => { body += ch; });
        req.on("end", () => {
          res.writeHead(200); res.end("{}");
          server.close();
          resolve({ body: JSON.parse(body || "{}"), auth: req.headers.authorization });
        });
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        const ctx = makeCtx();
        const perm = initPermission(ctx);
        const permEntry = makePermEntry({
          res: null,
          agentId: "opencode",
          isOpencode: true,
          opencodeRequestId: "per_test_123",
          opencodeBridgeUrl: `http://127.0.0.1:${port}`,
          opencodeBridgeToken: "tok_test",
        });
        perm.pendingPermissions.push(permEntry);
        perm.showPermissionBubble(permEntry);
        assert.equal(perm.pendingPermissions.indexOf(permEntry), -1, "opencode entry resolved");
      });
    });

    // Auto-pilot does not set opencodeAlwaysPicked, so the reply is "once"
    // (single-call allow), authenticated with the bridge token.
    assert.equal(received.body.request_id, "per_test_123");
    assert.equal(received.body.reply, "once");
    assert.equal(received.auth, "Bearer tok_test");
  });
});
