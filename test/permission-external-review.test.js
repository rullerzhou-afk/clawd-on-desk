"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const initPermission = require("../src/permission");
const { handlePermissionPost } = require("../src/server-route-permission");
const {
  classifyPermissionInteraction,
  evaluatePermissionAutomation,
  AUTOMATION_ACTION,
} = require("../src/permission-automation-policy");
const {
  DEFAULT_TIMEOUT_MS,
  MAX_NOTE_LENGTH,
  normalizePermissionReviewCommand,
  normalizePermissionReviewTimeoutMs,
  runPermissionReviewCommand,
  stopActivePermissionReviews,
} = require("../src/permission-review-command");
const prefs = require("../src/prefs");

const NODE = process.execPath;

// A command that behaves like a gate script without depending on any
// external program: stdin is consumed, then the exit code decides.
function nodeCommand(source) {
  return [NODE, "-e", source];
}

function liveResponse() {
  return {
    writableEnded: false,
    destroyed: false,
    writableFinished: false,
    writeHead() {},
    end() {},
    destroy() { this.destroyed = true; },
    on() {},
    once() {},
    removeListener() {},
    emit() {},
  };
}

describe("external review command — process lifecycle", () => {
  it("normalizes only a bounded argv array of non-empty strings", () => {
    assert.deepStrictEqual(normalizePermissionReviewCommand(undefined), []);
    assert.deepStrictEqual(normalizePermissionReviewCommand(null), []);
    assert.deepStrictEqual(normalizePermissionReviewCommand([]), []);
    assert.deepStrictEqual(
      normalizePermissionReviewCommand(["python", "-u", "gate.py"]),
      ["python", "-u", "gate.py"]
    );
    for (const invalid of [
      "python gate.py",
      { command: ["python"] },
      ["python", ""],
      ["python", 3],
      ["python\0x"],
      Array.from({ length: 33 }, () => "x"),
      ["x".repeat(4097)],
    ]) {
      assert.deepStrictEqual(normalizePermissionReviewCommand(invalid), [], JSON.stringify(invalid));
    }
    const copy = ["python"];
    assert.notStrictEqual(normalizePermissionReviewCommand(copy), copy, "never share the stored array");
  });

  it("bounds the timeout to the documented range and defaults otherwise", () => {
    assert.strictEqual(normalizePermissionReviewTimeoutMs(undefined), DEFAULT_TIMEOUT_MS);
    assert.strictEqual(normalizePermissionReviewTimeoutMs(100), DEFAULT_TIMEOUT_MS);
    assert.strictEqual(normalizePermissionReviewTimeoutMs(250), 250);
    assert.strictEqual(normalizePermissionReviewTimeoutMs(60000), 60000);
    assert.strictEqual(normalizePermissionReviewTimeoutMs(60001), DEFAULT_TIMEOUT_MS);
    assert.strictEqual(normalizePermissionReviewTimeoutMs(1.5), DEFAULT_TIMEOUT_MS);
  });

  it("passes the request on stdin and allows only exit 0", async () => {
    const payload = {
      toolName: "Bash",
      toolInput: { command: "npm test" },
      agentId: "claude-code",
      sessionId: "claude:1",
      cwd: "C:\\work",
    };
    const command = nodeCommand(
      "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{process.stdout.write(s);process.exit(0);});"
    );
    const allowed = await runPermissionReviewCommand({ command, timeoutMs: 5000, payload });
    assert.strictEqual(allowed.hold, false);
    assert.strictEqual(allowed.exitCode, 0);
    assert.deepStrictEqual(JSON.parse(allowed.note), {
      tool: "Bash",
      toolInput: { command: "npm test" },
      agent: "claude-code",
      sessionId: "claude:1",
      cwd: "C:\\work",
    }, "stdin is the documented {tool, toolInput, agent, sessionId, cwd} object");
  });

  it("maps exit 1 to a human card and uses the last stdout line as the note", async () => {
    const result = await runPermissionReviewCommand({
      command: nodeCommand("process.stdout.write('first line\\n  blocked: production branch  \\n\\n');process.exit(1);"),
      timeoutMs: 5000,
      payload: { toolName: "Bash", toolInput: {}, agentId: "claude-code", sessionId: "s", cwd: "" },
    });
    assert.strictEqual(result.hold, true);
    assert.strictEqual(result.tag, "exit-1");
    assert.strictEqual(result.warning, false);
    assert.strictEqual(result.note, "blocked: production branch");
  });

  it("marks exit 2 as a warning", async () => {
    const result = await runPermissionReviewCommand({
      command: nodeCommand("process.stdout.write('needs a closer look');process.exit(2);"),
      timeoutMs: 5000,
      payload: {},
    });
    assert.strictEqual(result.hold, true);
    assert.strictEqual(result.tag, "exit-2");
    assert.strictEqual(result.warning, true);
    assert.strictEqual(result.note, "needs a closer look");
  });

  it("holds on every other exit code and on a signal", async () => {
    for (const [code, tag] of [[3, "exit-3"], [127, "exit-127"]]) {
      const result = await runPermissionReviewCommand({
        command: nodeCommand(`process.exit(${code});`),
        timeoutMs: 5000,
        payload: {},
      });
      assert.strictEqual(result.hold, true, String(code));
      assert.strictEqual(result.tag, tag);
    }
  });

  it("holds when the executable is missing or cannot be spawned", async () => {
    const missing = await runPermissionReviewCommand({
      command: ["clawd-review-command-that-does-not-exist-995"],
      timeoutMs: 5000,
      payload: {},
    });
    assert.strictEqual(missing.hold, true);
    assert.strictEqual(missing.tag, "unavailable");

    const throwing = await runPermissionReviewCommand({
      command: ["anything"],
      timeoutMs: 5000,
      payload: {},
      spawnImpl() { throw new Error("EACCES"); },
    });
    assert.strictEqual(throwing.hold, true);
    assert.strictEqual(throwing.tag, "unavailable");
  });

  it("kills the process and holds on timeout", async () => {
    const started = Date.now();
    const result = await runPermissionReviewCommand({
      command: nodeCommand("setTimeout(()=>{}, 10000);"),
      timeoutMs: 250,
      payload: {},
    });
    assert.strictEqual(result.hold, true);
    assert.strictEqual(result.tag, "timeout");
    assert.ok(Date.now() - started < 5000, "the timeout must settle the review promptly");
  });

  it("bounds the note and never lets output control the decision", async () => {
    const result = await runPermissionReviewCommand({
      command: nodeCommand(
        `process.stdout.write(${JSON.stringify("x".repeat(2000) + "\u001b[31m" + "\\n")});process.exit(1);`
      ),
      timeoutMs: 5000,
      payload: {},
    });
    assert.strictEqual(result.tag, "exit-1");
    assert.ok(result.note.length <= MAX_NOTE_LENGTH);
    assert.ok(!result.note.includes("\u001b"), "control characters are stripped");
  });

  it("does not run an oversized payload", async () => {
    let spawned = false;
    const result = await runPermissionReviewCommand({
      command: ["node"],
      timeoutMs: 5000,
      payload: { toolInput: { blob: "x".repeat(1024 * 1024 + 1) } },
      spawnImpl() { spawned = true; throw new Error("must not spawn"); },
    });
    assert.strictEqual(spawned, false);
    assert.strictEqual(result.hold, true);
    assert.strictEqual(result.tag, "payload-too-large");
  });

  it("bounds concurrency instead of forking one process per request", async () => {
    const command = nodeCommand("setTimeout(()=>{}, 700);");
    const runs = Array.from({ length: 5 }, () =>
      runPermissionReviewCommand({ command, timeoutMs: 5000, payload: {} }));
    const results = await Promise.all(runs);
    const busy = results.filter((result) => result.tag === "busy");
    assert.strictEqual(busy.length, 1, "only the over-limit request is refused");
    assert.ok(busy[0].hold === true);
  });

  it("stops in-flight reviews on demand (app quit)", async () => {
    const pending = runPermissionReviewCommand({
      command: nodeCommand("setTimeout(()=>{}, 10000);"),
      timeoutMs: 60000,
      payload: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    stopActivePermissionReviews();
    const result = await pending;
    assert.strictEqual(result.hold, true);
    assert.strictEqual(result.tag, "cancelled");
    assert.strictEqual(result.cancelled, true);
    assert.strictEqual(result.reason, "app-quitting");
  });
});

describe("external review — settings", () => {
  it("is opt-in and empty by default", () => {
    const defaults = prefs.getDefaults();
    assert.deepStrictEqual(defaults.permissionReviewCommand, []);
    assert.strictEqual(defaults.permissionReviewTimeoutMs, DEFAULT_TIMEOUT_MS);
  });

  it("keeps a valid hand-edited command and bounds the timeout", () => {
    const snapshot = prefs.validate({
      permissionReviewCommand: ["python", "-u", "gate.py"],
      permissionReviewTimeoutMs: 1000,
    });
    assert.deepStrictEqual(snapshot.permissionReviewCommand, ["python", "-u", "gate.py"]);
    assert.strictEqual(snapshot.permissionReviewTimeoutMs, 1000);
  });

  it("turns a malformed value back off instead of half-running it", () => {
    const snapshot = prefs.validate({
      permissionReviewCommand: "python gate.py",
      permissionReviewTimeoutMs: 10,
    });
    assert.deepStrictEqual(snapshot.permissionReviewCommand, []);
    assert.strictEqual(snapshot.permissionReviewTimeoutMs, DEFAULT_TIMEOUT_MS);
  });
});

describe("external review — policy", () => {
  const INTERACTION = classifyPermissionInteraction({ agentId: "claude-code", toolName: "Bash" });

  it("can only downgrade an automatic allow", () => {
    const withReview = evaluatePermissionAutomation({
      mode: "auto-tools",
      interaction: INTERACTION,
      reviewHold: true,
    });
    assert.strictEqual(withReview, AUTOMATION_ACTION.DEFER);
    const without = evaluatePermissionAutomation({
      mode: "auto-tools",
      interaction: INTERACTION,
      reviewHold: false,
    });
    assert.strictEqual(without, AUTOMATION_ACTION.AUTO_ALLOW);
  });

  it("leaves questions and plan review on their existing branches", () => {
    const question = classifyPermissionInteraction({ agentId: "claude-code", toolName: "AskUserQuestion" });
    const plan = classifyPermissionInteraction({ agentId: "claude-code", toolName: "ExitPlanMode" });
    assert.strictEqual(
      evaluatePermissionAutomation({ mode: "unattended", interaction: question, reviewHold: true }),
      AUTOMATION_ACTION.AUTO_ANSWER
    );
    assert.strictEqual(
      evaluatePermissionAutomation({ mode: "unattended", interaction: plan, reviewHold: true }),
      AUTOMATION_ACTION.AUTO_ALLOW
    );
    const reminderQuestion = evaluatePermissionAutomation({
      mode: "unattended",
      interaction: question,
      reminderHold: true,
    });
    assert.strictEqual(reminderQuestion, AUTOMATION_ACTION.AUTO_ANSWER, "reminder behavior unchanged");
  });

  it("is inert when no caller passes it", () => {
    assert.strictEqual(
      evaluatePermissionAutomation({ mode: "auto-tools", interaction: INTERACTION }),
      AUTOMATION_ACTION.AUTO_ALLOW
    );
  });
});

// ── Runtime (permission.js) ────────────────────────────────────────────────

function makeRuntime(ctxOverrides = {}, entryOverrides = {}) {
  const ctx = {
    doNotDisturb: false,
    lang: "en",
    sessions: new Map(),
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    isAgentSubagentPermissionsEnabled: () => true,
    isCodexPermissionInterceptEnabled: () => true,
    getPermissionAutomationMode: () => "auto-tools",
    getPermissionReviewConfig: () => ({ command: ["gate"], timeoutMs: 5000 }),
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    sendPermissionResponse: () => {},
    win: null,
    ...ctxOverrides,
  };
  const permission = initPermission(ctx);
  const entry = {
    res: liveResponse(),
    sessionId: "session-review",
    agentId: "claude-code",
    toolName: "Bash",
    toolInput: { command: "npm test" },
    interaction: classifyPermissionInteraction({ agentId: "claude-code", toolName: "Bash" }),
    sessionAutomationIdentity: Object.freeze({ eligible: true, reason: "eligible" }),
    permissionReview: {
      configured: true,
      hold: true,
      tag: "exit-1",
      note: "blocked by gate",
      warning: false,
      exitCode: 1,
    },
    ...entryOverrides,
  };
  permission.pendingPermissions.push(entry);
  return { ctx, permission, entry };
}

describe("external review — runtime", () => {
  it("allows when the command cleared the request", () => {
    const { permission, entry } = makeRuntime({}, {
      permissionReview: { configured: true, hold: false, tag: "allowed", note: null, warning: false, exitCode: 0 },
    });
    assert.doesNotThrow(() => permission.showPermissionBubble(entry));
    assert.strictEqual(permission.pendingPermissions.indexOf(entry), -1);
  });

  it("holds when the command paused the request", () => {
    const sent = [];
    const { permission, entry } = makeRuntime({
      sendPermissionResponse: (...args) => sent.push(args),
    });
    assert.throws(() => permission.showPermissionBubble(entry));
    assert.strictEqual(permission.pendingPermissions.indexOf(entry), 0);
    assert.deepStrictEqual(sent, []);
    assert.strictEqual(entry.res.writableEnded, false);
  });

  it("is inert when no command is configured", () => {
    const { permission, entry } = makeRuntime({
      getPermissionReviewConfig: () => ({ command: [], timeoutMs: 5000 }),
    });
    assert.doesNotThrow(() => permission.showPermissionBubble(entry));
    assert.strictEqual(permission.pendingPermissions.indexOf(entry), -1);
  });

  it("fails closed on an entry that was never reviewed", () => {
    const { permission, entry } = makeRuntime({}, { permissionReview: undefined });
    assert.throws(() => permission.showPermissionBubble(entry));
    assert.strictEqual(permission.pendingPermissions.indexOf(entry), 0);
  });

  it("fails closed when the setting cannot be read", () => {
    const { permission, entry } = makeRuntime({
      getPermissionReviewConfig: () => { throw new Error("settings unavailable"); },
    });
    assert.throws(() => permission.showPermissionBubble(entry));
    assert.strictEqual(permission.pendingPermissions.indexOf(entry), 0);
  });

  it("freezes the verdict per entry, even if the setting is turned off later", () => {
    let configured = true;
    const { permission, entry } = makeRuntime({
      getPermissionReviewConfig: () => ({
        command: configured ? ["gate"] : [],
        timeoutMs: 5000,
      }),
    });
    assert.strictEqual(
      permission.canAutoResolvePendingPermission(entry, { sessionOnly: true, mode: "auto-tools" }),
      false
    );
    configured = false;
    assert.strictEqual(
      permission.canAutoResolvePendingPermission(entry, { sessionOnly: true, mode: "auto-tools" }),
      false,
      "an already-held card must not become sweep-resolvable"
    );
  });

  it("blocks a session-grant sweep, while a cleared sibling still resolves", () => {
    const held = makeRuntime();
    assert.strictEqual(
      held.permission.canAutoResolvePendingPermission(held.entry, { sessionOnly: true, mode: "auto-tools" }),
      false
    );
    const cleared = makeRuntime({}, {
      permissionReview: { configured: true, hold: false, tag: "allowed", note: null, warning: false, exitCode: 0 },
    });
    assert.strictEqual(
      cleared.permission.canAutoResolvePendingPermission(cleared.entry, { sessionOnly: true, mode: "auto-tools" }),
      true
    );
  });

  it("never applies to a question card", () => {
    const { permission, entry } = makeRuntime(
      { getPermissionAutomationMode: () => "unattended" },
      { toolName: "AskUserQuestion", toolInput: { questions: [{ question: "Which?", options: [{ label: "A" }] }] } }
    );
    entry.interaction = classifyPermissionInteraction({
      agentId: "claude-code",
      toolName: "AskUserQuestion",
    });
    assert.doesNotThrow(() => permission.showPermissionBubble(entry));
    assert.strictEqual(permission.pendingPermissions.indexOf(entry), -1);
  });

  it("names the review as the reason, with the command's note", () => {
    const { permission, entry } = makeRuntime();
    const payload = permission.buildPermissionBubblePayload(entry);
    assert.strictEqual(payload.reviewTag, "external-review");
    assert.strictEqual(payload.reviewNote, "blocked by gate");
  });

  it("does not claim the review stopped a request that was reaching a human anyway", () => {
    const { permission, entry } = makeRuntime({ getPermissionAutomationMode: () => "off" });
    const payload = permission.buildPermissionBubblePayload(entry);
    assert.strictEqual(payload.reviewTag, null);
    assert.strictEqual(payload.reviewNote, null);
  });
});

// ── Route (server-route-permission.js) ─────────────────────────────────────

function makeReq(body) {
  const req = new EventEmitter();
  req.headers = {};
  setImmediate(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function makeRes() {
  const res = new EventEmitter();
  res.statusCode = null;
  res.body = "";
  res.headersSent = false;
  res.writableFinished = false;
  res.destroyed = false;
  res.writeHead = function writeHead(code) { this.statusCode = code; this.headersSent = true; };
  res.end = function end(data) { if (data) this.body += String(data); this.writableFinished = true; };
  res.destroy = function destroy() { this.destroyed = true; this.emit("close"); };
  return res;
}

function makeRouteCtx(overrides = {}) {
  return {
    doNotDisturb: false,
    lang: "en",
    sessions: new Map(),
    pendingPermissions: [],
    PASSTHROUGH_TOOLS: new Set(),
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    isAgentSubagentPermissionsEnabled: () => true,
    isCodexPermissionInterceptEnabled: () => true,
    isDestructiveReminderEnabled: () => false,
    getPermissionAutomationMode: () => "auto-tools",
    getPermissionReviewConfig: () => ({
      command: nodeCommand("process.exit(0);"),
      timeoutMs: 5000,
    }),
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    sendPermissionResponse: () => {},
    updateSession: () => {},
    maybeStartRemoteApproval: () => false,
    win: null,
    permLog: () => {},
    ...overrides,
  };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the route to settle");
}

async function postPermission(body, { ctxOverrides = {}, show } = {}) {
  const res = makeRes();
  const ctx = makeRouteCtx(ctxOverrides);
  const permission = initPermission(ctx);
  Object.assign(ctx, {
    pendingPermissions: permission.pendingPermissions,
    PASSTHROUGH_TOOLS: permission.PASSTHROUGH_TOOLS,
    addPendingPermission: permission.addPendingPermission,
    removePendingPermission: permission.removePendingPermission,
    // Tests that must not construct a BrowserWindow pass `show`; every other
    // lane uses the real chokepoint so "no card" really means automation
    // consumed the request.
    showPermissionBubble: show || permission.showPermissionBubble,
    resolvePermissionEntry: permission.resolvePermissionEntry,
    sendPermissionResponse: permission.sendPermissionResponse,
  });
  handlePermissionPost(makeReq(body), res, {
    ctx,
    createRequestHookRecorder: () => ({
      accepted() {},
      droppedByDisabled() {},
      droppedByDnd() {},
      droppedInvalidAgent() {},
      droppedUnsupported() {},
    }),
  });
  return { res, ctx, permission };
}

const CLAUDE_BODY = JSON.stringify({
  agent_id: "claude-code",
  session_id: "claude:external-review",
  tool_name: "Bash",
  tool_input: { command: "npm test" },
  tool_use_id: "tool-1",
});

describe("external review — route", () => {
  it("runs once at accept, freezes a non-zero verdict, and sends no allow", async () => {
    const shown = [];
    const { permission } = await postPermission(CLAUDE_BODY, {
      ctxOverrides: {
        getPermissionReviewConfig: () => ({
          command: nodeCommand("process.stdout.write('needs a human');process.exit(1);"),
          timeoutMs: 5000,
        }),
      },
      show: (entry) => shown.push(entry),
    });
    await waitFor(() => shown.length === 1);
    const entry = shown[0];
    assert.strictEqual(entry.permissionReview.hold, true);
    assert.strictEqual(entry.permissionReview.tag, "exit-1");
    assert.strictEqual(entry.permissionReview.note, "needs a human");
    assert.strictEqual(permission.pendingPermissions.length, 1, "the human card owns the request");
  });

  it("allows when the command exits 0", async () => {
    const { res, permission } = await postPermission(CLAUDE_BODY);
    await waitFor(() => res.writableFinished);
    assert.strictEqual(permission.pendingPermissions.length, 0);
    assert.strictEqual(
      JSON.parse(res.body).hookSpecificOutput.decision.behavior,
      "allow"
    );
  });

  it("does not run anything when the setting is empty, and keeps today's behavior", async () => {
    const { res, permission } = await postPermission(CLAUDE_BODY, {
      ctxOverrides: {
        getPermissionReviewConfig: () => ({ command: [], timeoutMs: 5000 }),
      },
    });
    await waitFor(() => res.writableFinished);
    assert.strictEqual(permission.pendingPermissions.length, 0);
    assert.strictEqual(JSON.parse(res.body).hookSpecificOutput.decision.behavior, "allow");
  });

  it("does not run on the destructive-hold path", async () => {
    const shown = [];
    const { permission } = await postPermission(
      JSON.stringify({
        agent_id: "claude-code",
        session_id: "claude:external-review-destructive",
        tool_name: "Bash",
        tool_input: { command: "git push --force origin main" },
        tool_use_id: "tool-2",
      }),
      {
        ctxOverrides: {
          isDestructiveReminderEnabled: () => true,
          getPermissionReviewConfig: () => ({
            // If this ran it would hold; the reminder hold must win without it.
            command: nodeCommand("process.exit(1);"),
            timeoutMs: 5000,
          }),
        },
        show: (entry) => shown.push(entry),
      }
    );
    await waitFor(() => shown.length === 1);
    const entry = shown[0];
    assert.strictEqual(entry.permissionReminder.hold, true);
    assert.strictEqual(entry.permissionReview.hold, false);
    assert.strictEqual(entry.permissionReview.tag, "destructive-hold");
    assert.strictEqual(permission.pendingPermissions.length, 1);
  });

  it("discards the review and creates no card when the client disconnects mid-review", async () => {
    const shown = [];
    const ctxOverrides = {
      getPermissionReviewConfig: () => ({
        // Long enough to be cancelled well before its timeout.
        command: nodeCommand("setTimeout(()=>{}, 8000);"),
        timeoutMs: 60000,
      }),
    };
    const started = Date.now();
    const res = makeRes();
    const ctx = makeRouteCtx(ctxOverrides);
    const permission = initPermission(ctx);
    Object.assign(ctx, {
      pendingPermissions: permission.pendingPermissions,
      PASSTHROUGH_TOOLS: permission.PASSTHROUGH_TOOLS,
      addPendingPermission: permission.addPendingPermission,
      removePendingPermission: permission.removePendingPermission,
      showPermissionBubble: (entry) => shown.push(entry),
      resolvePermissionEntry: permission.resolvePermissionEntry,
      sendPermissionResponse: permission.sendPermissionResponse,
    });
    handlePermissionPost(makeReq(CLAUDE_BODY), res, {
      ctx,
      createRequestHookRecorder: () => ({
        accepted() {},
        droppedByDisabled() {},
        droppedByDnd() {},
        droppedInvalidAgent() {},
        droppedUnsupported() {},
      }),
    });
    setTimeout(() => res.emit("close"), 100);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.deepStrictEqual(shown, [], "a disconnected request must not open a card");
    assert.strictEqual(permission.pendingPermissions.length, 0);
    assert.ok(Date.now() - started < 5000, "the review must not run to its 60 s timeout");
  });

  it("re-checks DND after the review and does not decide for a request that changed", async () => {
    const shown = [];
    let dnd = false;
    const ctxOverrides = {
      get doNotDisturb() { return dnd; },
      getPermissionReviewConfig: () => ({
        command: nodeCommand("setTimeout(()=>process.exit(0), 400);"),
        timeoutMs: 5000,
      }),
    };
    const res = makeRes();
    const ctx = makeRouteCtx(ctxOverrides);
    Object.defineProperty(ctx, "doNotDisturb", { get: () => dnd, configurable: true });
    const permission = initPermission(ctx);
    Object.assign(ctx, {
      pendingPermissions: permission.pendingPermissions,
      PASSTHROUGH_TOOLS: permission.PASSTHROUGH_TOOLS,
      addPendingPermission: permission.addPendingPermission,
      removePendingPermission: permission.removePendingPermission,
      showPermissionBubble: (entry) => shown.push(entry),
      resolvePermissionEntry: permission.resolvePermissionEntry,
      sendPermissionResponse: permission.sendPermissionResponse,
    });
    handlePermissionPost(makeReq(CLAUDE_BODY), res, {
      ctx,
      createRequestHookRecorder: () => ({
        accepted() {},
        droppedByDisabled() {},
        droppedByDnd() {},
        droppedInvalidAgent() {},
        droppedUnsupported() {},
      }),
    });
    // Flip DND while the gate is running: the exit-0 result was authorized
    // for the state at accept time and must not answer now.
    setTimeout(() => { dnd = true; }, 100);
    await waitFor(() => res.destroyed);
    assert.deepStrictEqual(shown, []);
    assert.strictEqual(permission.pendingPermissions.length, 0);
    assert.strictEqual(res.body, "", "no allow may be written after DND lands");
  });

  it("cancels an app-quit review through the native fallback without creating a card", async () => {
    const shown = [];
    const request = postPermission(CLAUDE_BODY, {
      ctxOverrides: {
        getPermissionReviewConfig: () => ({
          command: nodeCommand("setTimeout(()=>{}, 10000);"),
          timeoutMs: 60000,
        }),
      },
      show: (entry) => shown.push(entry),
    });
    setTimeout(() => stopActivePermissionReviews(), 100);
    const { res, permission } = await request;
    await waitFor(() => res.destroyed, 5000);
    assert.deepStrictEqual(shown, []);
    assert.strictEqual(permission.pendingPermissions.length, 0);
    assert.strictEqual(res.body, "");
  });
});

describe("external review — cancellation", () => {
  it("kills the child and settles as cancelled when the signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runPermissionReviewCommand({
      command: nodeCommand("setTimeout(()=>{}, 10000);"),
      timeoutMs: 60000,
      payload: {},
      signal: controller.signal,
    });
    setTimeout(() => controller.abort("client-disconnected"), 100);
    const result = await pending;
    assert.strictEqual(result.cancelled, true);
    assert.strictEqual(result.tag, "cancelled");
    assert.strictEqual(result.reason, "client-disconnected");
    assert.ok(Date.now() - started < 5000, "cancellation must not wait for the timeout");
  });

  it("does not spawn anything when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("gone");
    let spawned = false;
    const result = await runPermissionReviewCommand({
      command: ["node"],
      timeoutMs: 5000,
      payload: {},
      signal: controller.signal,
      spawnImpl() { spawned = true; throw new Error("must not spawn"); },
    });
    assert.strictEqual(spawned, false);
    assert.strictEqual(result.cancelled, true);
  });
});
