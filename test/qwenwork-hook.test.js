const { describe, it, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  HOOK_MAP,
  appendHookDebug,
  buildStateBody,
  hookDebugMode,
  sendHookEvent,
  summarizeHookPayload,
  normalizeSessionId,
  isQwenWorkAgentCommandLine,
  resolveHookName,
  shouldResolvePid,
} = require("../hooks/qwenwork-hook");
const { createSpawnedHookHarness } = require("./helpers/spawned-hook");

describe("QwenWork hook runtime (Phase 1 state-only)", () => {
  it("maps Stop to attention so the completion animation/sound plays", () => {
    assert.strictEqual(HOOK_MAP.Stop.state, "attention");
  });

  it("maps tool-boundary events to working / error", () => {
    assert.strictEqual(HOOK_MAP.PreToolUse.state, "working");
    assert.strictEqual(HOOK_MAP.PostToolUse.state, "working");
    assert.strictEqual(HOOK_MAP.PostToolUseFailure.state, "error");
  });

  it("maps permission events to working (not notification) to avoid animation spam", () => {
    // QwenWork fires 40+ permission events per task (file reads, commands, etc.).
    // Map to "working" so the pet stays in its working animation.
    assert.strictEqual(HOOK_MAP.PermissionRequest.state, "working");
    assert.strictEqual(HOOK_MAP.PermissionDenied.state, "working");
    // Ride the PreToolUse event so state.js treats them as tool activity.
    assert.strictEqual(HOOK_MAP.PermissionRequest.event, "PreToolUse");
    assert.strictEqual(HOOK_MAP.PermissionDenied.event, "PreToolUse");
  });

  it("maps Notification to notification state", () => {
    assert.strictEqual(HOOK_MAP.Notification.state, "notification");
    assert.strictEqual(HOOK_MAP.Notification.event, "Notification");
  });

  it("maps lifecycle events to idle / thinking / sleeping", () => {
    assert.strictEqual(HOOK_MAP.SessionStart.state, "idle");
    assert.strictEqual(HOOK_MAP.UserPromptSubmit.state, "thinking");
    assert.strictEqual(HOOK_MAP.SessionEnd.state, "sleeping");
  });

  it("namespaces session ids as qwenwork:<raw>, not local|agent|<raw>", () => {
    assert.strictEqual(normalizeSessionId("abc"), "qwenwork:abc");
    assert.strictEqual(normalizeSessionId(""), "qwenwork:default");
    assert.strictEqual(normalizeSessionId(null), "qwenwork:default");
    assert.strictEqual(normalizeSessionId("qwenwork:abc"), "qwenwork:abc");
  });

  it("builds a state body with agent_id=qwenwork, namespaced session, and safe metadata", () => {
    const body = buildStateBody("PreToolUse", {
      session_id: "s1",
      cwd: "/work",
      tool_name: "Edit",
      tool_use_id: "tu1",
      model: "qwenwork-model",
      permission_mode: "default",
      transcript_path: "/t.jsonl",
      tool_input: { file: "a.js" },
    }, { pidMeta: { stablePid: 123 } });

    assert.strictEqual(body.agent_id, "qwenwork");
    assert.strictEqual(body.state, "working");
    assert.strictEqual(body.event, "PreToolUse");
    assert.strictEqual(body.session_id, "qwenwork:s1");
    assert.strictEqual(body.cwd, "/work");
    assert.strictEqual(body.tool_name, "Edit");
    assert.strictEqual(body.tool_use_id, "tu1");
    assert.strictEqual(body.model, "qwenwork-model");
    assert.strictEqual(body.permission_mode, "default");
    assert.strictEqual(body.transcript_path, "/t.jsonl");
    assert.ok(typeof body.tool_input_fingerprint === "string" && body.tool_input_fingerprint.length > 0);
    assert.strictEqual(body.source_pid, 123);
  });

  it("returns null for events outside the Phase 1 map", () => {
    assert.strictEqual(buildStateBody("SubagentStart", {}, {}), null);
    assert.strictEqual(buildStateBody("", {}, {}), null);
  });

  it("marks folded permission events with closed recap provenance", () => {
    const permission = buildStateBody("PermissionRequest", { session_id: "s1" }, {});
    const tool = buildStateBody("PreToolUse", { session_id: "s1" }, {});
    assert.strictEqual(permission.event, "PreToolUse");
    assert.strictEqual(permission.recap_boundary, "permission");
    assert.strictEqual(tool.recap_boundary, undefined);
  });

  it("uses host instead of local pid fields in remote mode", () => {
    const body = buildStateBody("Stop", { session_id: "s1" }, { remote: true, host: "myhost" });
    assert.strictEqual(body.host, "myhost");
    assert.strictEqual(body.source_pid, undefined);
  });

  it("resolves session title from explicit session_title field", () => {
    const body = buildStateBody("PreToolUse", {
      session_id: "s1",
      session_title: "My Task",
    }, {});
    assert.strictEqual(body.session_title, "My Task");
  });

  it("resolves session title from prompt first line on UserPromptSubmit", () => {
    const body = buildStateBody("UserPromptSubmit", {
      session_id: "s1",
      prompt: "Fix the login bug\nMore details here",
    }, {});
    assert.strictEqual(body.session_title, "Fix the login bug");
  });

  it("truncates long prompt titles to 60 chars with ellipsis", () => {
    const longPrompt = "A".repeat(80);
    const body = buildStateBody("UserPromptSubmit", {
      session_id: "s1",
      prompt: longPrompt,
    }, {});
    assert.strictEqual(body.session_title.length, 60);
    assert.ok(body.session_title.endsWith("…"));
  });

  it("resolves session title from parent_business_info.name on Stop events", () => {
    const body = buildStateBody("Stop", {
      session_id: "s1",
      parent_business_info: { name: "Refactor auth module" },
    }, {});
    assert.strictEqual(body.session_title, "Refactor auth module");
  });

  it("does not set session_title from cwd", () => {
    const body = buildStateBody("PreToolUse", {
      session_id: "s1",
      cwd: "/work/project",
    }, {});
    assert.strictEqual(body.session_title, undefined);
  });

  it("sendHookEvent always writes {} and posts the mapped Stop body", async () => {
    const posted = [];
    const result = await sendHookEvent(
      { hook_event_name: "Stop", session_id: "s1" },
      undefined,
      {
        env: {},
        resolvePid: () => ({ stablePid: 7 }),
        postState: (bodyStr, _opts, cb) => { posted.push(JSON.parse(bodyStr)); cb(true, 23333); },
      }
    );
    assert.strictEqual(result.stdout, "{}");
    assert.strictEqual(result.posted, true);
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].state, "attention");
    assert.strictEqual(posted[0].agent_id, "qwenwork");
    assert.strictEqual(posted[0].session_id, "qwenwork:s1");
  });

  it("sendHookEvent returns {} and does not post for unmapped events", async () => {
    let postedCount = 0;
    const result = await sendHookEvent(
      { hook_event_name: "InstructionsLoaded" },
      undefined,
      { env: {}, postState: () => { postedCount++; } }
    );
    assert.strictEqual(result.stdout, "{}");
    assert.strictEqual(result.posted, false);
    assert.strictEqual(postedCount, 0);
  });

  it("permission events map to working state with {} stdout (state-only)", async () => {
    const posted = [];
    for (const ev of ["PermissionRequest", "PermissionDenied"]) {
      const result = await sendHookEvent(
        { hook_event_name: ev, session_id: "s1", tool_name: "Bash" },
        undefined,
        { env: {}, resolvePid: () => ({}), postState: (b, _o, cb) => { posted.push(JSON.parse(b)); cb(true); } }
      );
      assert.strictEqual(result.stdout, "{}");
    }
    // Permission events map to "working" (not "notification") to avoid animation spam.
    assert.deepStrictEqual(posted.map((b) => b.state), ["working", "working"]);
    assert.deepStrictEqual(posted.map((b) => b.event), ["PreToolUse", "PreToolUse"]);
  });

  it("narrows command-line detection to the QwenWorkCN executable token", () => {
    assert.strictEqual(isQwenWorkAgentCommandLine("/usr/local/bin/QwenWorkCN"), true);
    assert.strictEqual(isQwenWorkAgentCommandLine("QwenWorkCN.exe"), true);
    assert.strictEqual(isQwenWorkAgentCommandLine("C:\\tools\\QwenWorkCN.exe"), true);
    assert.strictEqual(isQwenWorkAgentCommandLine("node /x/QwenWorkCN/dist/app.js"), true);
    // Must NOT match other executables.
    assert.strictEqual(isQwenWorkAgentCommandLine("node /home/me/qwenworkcn-notes/index.js"), false);
    assert.strictEqual(isQwenWorkAgentCommandLine(""), false);
  });

  it("resolveHookName prefers payload hook_event_name over argv", () => {
    assert.strictEqual(resolveHookName({ hook_event_name: "Stop" }, "PreToolUse"), "Stop");
    assert.strictEqual(resolveHookName({}, "Stop"), "Stop");
    assert.strictEqual(resolveHookName(null, "Stop"), "Stop");
    assert.strictEqual(resolveHookName({}, ""), "");
    assert.strictEqual(resolveHookName(null, null), "");
  });

  it("shouldResolvePid returns true for mapped events and false when CLAWD_REMOTE is set", () => {
    assert.strictEqual(shouldResolvePid("Stop", {}), true);
    assert.strictEqual(shouldResolvePid("PreToolUse", {}), true);
    assert.strictEqual(shouldResolvePid("Stop", { CLAWD_REMOTE: "1" }), false);
    assert.strictEqual(shouldResolvePid("UnknownEvent", {}), false);
  });

  it("skips pid resolution for high-frequency permission events (QwenWork waits on hook stdout)", () => {
    assert.strictEqual(shouldResolvePid("PermissionRequest", {}), false);
    assert.strictEqual(shouldResolvePid("PermissionDenied", {}), false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// #843 — the debug log must not become a plaintext copy of the user's work.
//
// The original implementation wrote the COMPLETE rawPayload (prompt, tool
// input, cwd, business metadata) to ~/.clawd/qwenwork-hook-debug.jsonl behind a
// single env var, with no explicit file mode — 0644 under a permissive umask.
// ═════════════════════════════════════════════════════════════════════════════

describe("QwenWork hook debug logging (#843)", () => {
  const tempRoots = [];
  after(() => {
    for (const root of tempRoots) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
  });

  function makeRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-qwenwork-debug-"));
    tempRoots.push(root);
    return root;
  }

  // Distinctive strings: if any of these reaches the file in summary mode, the
  // hook is leaking payload content.
  const SECRET_PROMPT = "SECRET-PROMPT-migrate the payroll database";
  const SECRET_PATH = "D:/private/SECRET-CWD-acme-payroll";
  const SECRET_TOOL_ARG = "SECRET-TOOL-INPUT-rm -rf /var/acme";
  const PAYLOAD = Object.freeze({
    hook_event_name: "UserPromptSubmit",
    session_id: "s-843",
    cwd: SECRET_PATH,
    prompt: SECRET_PROMPT,
    tool_name: "Bash",
    tool_input: { command: SECRET_TOOL_ARG, timeout: 5 },
    parent_business_info: { name: "SECRET-BUSINESS-Acme Payroll Q3" },
  });
  const SECRETS = [SECRET_PROMPT, SECRET_PATH, SECRET_TOOL_ARG, "SECRET-BUSINESS", "acme"];

  function debugEnv(root, extra = {}) {
    return {
      CLAWD_QWENWORK_HOOK_DEBUG: "1",
      CLAWD_QWENWORK_HOOK_DEBUG_PATH: path.join(root, "logs", "qwenwork-hook-debug.jsonl"),
      ...extra,
    };
  }

  it("hookDebugMode requires both opt-ins for raw capture", () => {
    assert.strictEqual(hookDebugMode({}), "off");
    assert.strictEqual(hookDebugMode({ CLAWD_QWENWORK_HOOK_DEBUG_RAW: "1" }), "off",
      "raw alone must not enable logging");
    assert.strictEqual(hookDebugMode({ CLAWD_QWENWORK_HOOK_DEBUG: "1" }), "summary");
    assert.strictEqual(
      hookDebugMode({ CLAWD_QWENWORK_HOOK_DEBUG: "1", CLAWD_QWENWORK_HOOK_DEBUG_RAW: "1" }),
      "raw"
    );
  });

  it("writes nothing at all when debug is not enabled", () => {
    const root = makeRoot();
    const debugPath = path.join(root, "logs", "qwenwork-hook-debug.jsonl");
    appendHookDebug({ argvEvent: "Stop", payload: PAYLOAD }, { CLAWD_QWENWORK_HOOK_DEBUG_PATH: debugPath });
    appendHookDebug({ argvEvent: "Stop", payload: PAYLOAD }, {
      CLAWD_QWENWORK_HOOK_DEBUG: "0",
      CLAWD_QWENWORK_HOOK_DEBUG_RAW: "1",
      CLAWD_QWENWORK_HOOK_DEBUG_PATH: debugPath,
    });
    assert.strictEqual(fs.existsSync(debugPath), false);
    assert.strictEqual(fs.existsSync(path.dirname(debugPath)), false, "not even the directory");
  });

  it("summary mode records shape, not content", () => {
    const root = makeRoot();
    const env = debugEnv(root);
    appendHookDebug({
      argvEvent: "UserPromptSubmit",
      payload: PAYLOAD,
      resolvedHookName: "UserPromptSubmit",
      posted: true,
      port: 23333,
      bodyState: "thinking",
      bodyEvent: "UserPromptSubmit",
    }, env);

    const raw = fs.readFileSync(env.CLAWD_QWENWORK_HOOK_DEBUG_PATH, "utf8");
    for (const secret of SECRETS) {
      assert.ok(!raw.includes(secret), `summary debug leaked ${JSON.stringify(secret)}`);
    }

    const entry = JSON.parse(raw.trim());
    assert.strictEqual(entry.rawPayload, undefined, "raw capture needs the second opt-in");
    assert.strictEqual(entry.resolvedHookName, "UserPromptSubmit");
    assert.strictEqual(entry.posted, true);
    assert.strictEqual(entry.port, 23333);
    assert.strictEqual(entry.bodyState, "thinking");
    assert.strictEqual(entry.bodyEvent, "UserPromptSubmit");
    // Field-existence summary: names + type/size, which is what diagnosing an
    // undocumented payload shape actually needs.
    assert.strictEqual(entry.payloadSummary.present, true);
    assert.strictEqual(entry.payloadSummary.keyCount, Object.keys(PAYLOAD).length);
    assert.strictEqual(entry.payloadSummary.fields.prompt, `string(len=${SECRET_PROMPT.length})`);
    assert.strictEqual(entry.payloadSummary.fields.cwd, `string(len=${SECRET_PATH.length})`);
    assert.strictEqual(entry.payloadSummary.fields.tool_input, "object(keys=2)");
    assert.strictEqual(entry.payloadSummary.fields.tool_name, "string(len=4)");
  });

  it("raw mode captures the complete payload only after the second opt-in", () => {
    const root = makeRoot();
    const env = debugEnv(root, { CLAWD_QWENWORK_HOOK_DEBUG_RAW: "1" });
    appendHookDebug({ argvEvent: "UserPromptSubmit", payload: PAYLOAD }, env);

    const entry = JSON.parse(fs.readFileSync(env.CLAWD_QWENWORK_HOOK_DEBUG_PATH, "utf8").trim());
    assert.deepStrictEqual(entry.rawPayload, PAYLOAD);
    assert.strictEqual(entry.payloadSummary.present, true, "the summary stays alongside the raw copy");
  });

  it("keeps error diagnostics free of echoed payload bytes unless raw is on", () => {
    const root = makeRoot();
    // Node quotes the offending input in JSON.parse errors, so a bad payload
    // can smuggle content into err.message.
    let parseError;
    try { JSON.parse(`{"prompt": ${SECRET_PROMPT}}`); } catch (err) { parseError = err; }
    assert.ok(parseError, "sanity: that input does not parse");

    const summaryEnv = debugEnv(root);
    appendHookDebug({ argvEvent: "Stop", error: parseError }, summaryEnv);
    const summaryText = fs.readFileSync(summaryEnv.CLAWD_QWENWORK_HOOK_DEBUG_PATH, "utf8");
    assert.ok(!summaryText.includes("SECRET-PROMPT"), "summary debug leaked the parse error's input echo");
    assert.strictEqual(JSON.parse(summaryText.trim()).error.name, "SyntaxError");

    const rawRoot = makeRoot();
    const rawEnv = debugEnv(rawRoot, { CLAWD_QWENWORK_HOOK_DEBUG_RAW: "1" });
    appendHookDebug({ argvEvent: "Stop", error: parseError }, rawEnv);
    const rawEntry = JSON.parse(fs.readFileSync(rawEnv.CLAWD_QWENWORK_HOOK_DEBUG_PATH, "utf8").trim());
    assert.strictEqual(rawEntry.error.message, parseError.message);
  });

  it("carries fs error codes through so a broken debug path is diagnosable", () => {
    const root = makeRoot();
    const env = debugEnv(root);
    const err = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    appendHookDebug({ argvEvent: "Stop", error: err }, env);
    const entry = JSON.parse(fs.readFileSync(env.CLAWD_QWENWORK_HOOK_DEBUG_PATH, "utf8").trim());
    assert.deepStrictEqual(entry.error, { name: "Error", code: "EACCES" });
  });

  it("creates the debug directory 0700 and the file 0600 on POSIX", { skip: process.platform === "win32" }, () => {
    const root = makeRoot();
    const env = debugEnv(root);
    appendHookDebug({ argvEvent: "Stop", payload: PAYLOAD }, env);

    const debugPath = env.CLAWD_QWENWORK_HOOK_DEBUG_PATH;
    assert.strictEqual(fs.statSync(path.dirname(debugPath)).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(debugPath).mode & 0o777, 0o600);
  });

  it("tightens a pre-existing world-readable debug file on POSIX", { skip: process.platform === "win32" }, () => {
    const root = makeRoot();
    const env = debugEnv(root);
    const debugPath = env.CLAWD_QWENWORK_HOOK_DEBUG_PATH;
    fs.mkdirSync(path.dirname(debugPath), { recursive: true });
    fs.writeFileSync(debugPath, "{\"legacy\":true}\n", { mode: 0o644 });
    fs.chmodSync(debugPath, 0o644);

    appendHookDebug({ argvEvent: "Stop", payload: PAYLOAD }, env);
    assert.strictEqual(fs.statSync(debugPath).mode & 0o777, 0o600);
  });

  it("does not chmod or write through a directory debug target on POSIX", { skip: process.platform === "win32" }, () => {
    const root = makeRoot();
    const debugPath = path.join(root, "existing-directory");
    fs.mkdirSync(debugPath, { mode: 0o755 });
    fs.chmodSync(debugPath, 0o755);
    fs.writeFileSync(path.join(debugPath, "sentinel.txt"), "keep");

    appendHookDebug({ argvEvent: "Stop", payload: PAYLOAD }, debugEnv(root, {
      CLAWD_QWENWORK_HOOK_DEBUG_PATH: debugPath,
    }));

    assert.strictEqual(fs.statSync(debugPath).mode & 0o777, 0o755);
    assert.deepStrictEqual(fs.readdirSync(debugPath), ["sentinel.txt"]);
    assert.strictEqual(fs.readFileSync(path.join(debugPath, "sentinel.txt"), "utf8"), "keep");
  });

  it("does not follow or mutate a symlink debug target on POSIX", { skip: process.platform === "win32" }, () => {
    const root = makeRoot();
    const targetPath = path.join(root, "target.jsonl");
    const debugPath = path.join(root, "debug-link.jsonl");
    fs.writeFileSync(targetPath, "legacy\n", { mode: 0o644 });
    fs.chmodSync(targetPath, 0o644);
    fs.symlinkSync(targetPath, debugPath);

    appendHookDebug({ argvEvent: "Stop", payload: PAYLOAD }, debugEnv(root, {
      CLAWD_QWENWORK_HOOK_DEBUG_PATH: debugPath,
    }));

    assert.strictEqual(fs.readFileSync(targetPath, "utf8"), "legacy\n");
    assert.strictEqual(fs.statSync(targetPath).mode & 0o777, 0o644);
    assert.strictEqual(fs.lstatSync(debugPath).isSymbolicLink(), true);
  });

  it("stops appending once the max-bytes cap would be exceeded", () => {
    const root = makeRoot();
    const env = debugEnv(root);
    const debugPath = env.CLAWD_QWENWORK_HOOK_DEBUG_PATH;

    appendHookDebug({ argvEvent: "Stop", payload: PAYLOAD }, env);
    const sizeAfterFirst = fs.statSync(debugPath).size;
    assert.ok(sizeAfterFirst > 0);

    // A cap equal to the current size: any further line overflows it.
    const cappedEnv = debugEnv(root, { CLAWD_QWENWORK_HOOK_DEBUG_MAX_BYTES: String(sizeAfterFirst) });
    appendHookDebug({ argvEvent: "Stop", payload: PAYLOAD }, cappedEnv);
    assert.strictEqual(fs.statSync(debugPath).size, sizeAfterFirst);
    assert.strictEqual(fs.readFileSync(debugPath, "utf8").trim().split("\n").length, 1);

    // Raising the cap lets logging resume — the cap is a size guard, not a
    // one-shot latch.
    const raisedEnv = debugEnv(root, { CLAWD_QWENWORK_HOOK_DEBUG_MAX_BYTES: String(sizeAfterFirst * 4) });
    appendHookDebug({ argvEvent: "Stop", payload: PAYLOAD }, raisedEnv);
    assert.strictEqual(fs.readFileSync(debugPath, "utf8").trim().split("\n").length, 2);
  });

  it("summarizeHookPayload caps field count and never reads values", () => {
    const wide = {};
    for (let i = 0; i < 100; i++) wide[`field_${String(i).padStart(3, "0")}`] = `value-${i}`;
    const summary = summarizeHookPayload(wide);
    assert.strictEqual(summary.keyCount, 100);
    assert.strictEqual(Object.keys(summary.fields).length, 64);
    assert.strictEqual(summary.fieldsTruncated, true);
    assert.ok(!JSON.stringify(summary).includes("value-0"));

    assert.deepStrictEqual(summarizeHookPayload(null), { present: false });
    assert.deepStrictEqual(summarizeHookPayload(undefined), { present: false });
    assert.deepStrictEqual(summarizeHookPayload([1, 2, 3]), { present: true, shape: "array(len=3)" });
  });
});

describe("QwenWork hook debug logging — real script (#843)", () => {
  let harness;
  after(() => { if (harness) harness.cleanup(); });

  function runHook(env, payload) {
    if (!harness) harness = createSpawnedHookHarness({ prefix: "clawd-843-debug-home-" });
    return harness.run({
      script: path.join(__dirname, "..", "hooks", "qwenwork-hook.js"),
      payload,
      env,
      httpContract: "block",
    });
  }

  it("stays exit 0 with stdout {} when the debug write fails", () => {
    const blockerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-843-debug-blocked-"));
    const blocker = path.join(blockerRoot, "not-a-directory");
    fs.writeFileSync(blocker, "regular file");

    try {
      const r = runHook(
        {
          CLAWD_QWENWORK_HOOK_DEBUG: "1",
          // Parent is a regular file → mkdir/append both throw.
          CLAWD_QWENWORK_HOOK_DEBUG_PATH: path.join(blocker, "debug.jsonl"),
        },
        { hook_event_name: "Stop", session_id: "s-843", cwd: "D:/repo" }
      );

      assert.strictEqual(r.status, 0, `stderr=${r.stderr}`);
      assert.strictEqual(r.stdout, "{}\n", "a failed debug write must not change the hook's stdout");
      assert.strictEqual(r.stderr, "");
      assert.strictEqual(fs.statSync(blocker).isFile(), true, "and must not clobber the blocking path");
    } finally {
      fs.rmSync(blockerRoot, { recursive: true, force: true });
    }
  });

  it("leaves an existing directory debug target untouched and still returns {}", () => {
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-843-debug-dir-"));
    const debugPath = path.join(logRoot, "existing-directory");
    fs.mkdirSync(debugPath);
    fs.writeFileSync(path.join(debugPath, "sentinel.txt"), "keep");

    try {
      const r = runHook(
        { CLAWD_QWENWORK_HOOK_DEBUG: "1", CLAWD_QWENWORK_HOOK_DEBUG_PATH: debugPath },
        { hook_event_name: "Stop", session_id: "s-843", cwd: "D:/repo" }
      );

      assert.strictEqual(r.status, 0, `stderr=${r.stderr}`);
      assert.strictEqual(r.stdout, "{}\n");
      assert.strictEqual(r.stderr, "");
      assert.deepStrictEqual(fs.readdirSync(debugPath), ["sentinel.txt"]);
      assert.strictEqual(fs.readFileSync(path.join(debugPath, "sentinel.txt"), "utf8"), "keep");
    } finally {
      fs.rmSync(logRoot, { recursive: true, force: true });
    }
  });

  it("summary mode through the real script keeps the prompt out of the file", () => {
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-843-debug-real-"));
    const debugPath = path.join(logRoot, "logs", "debug.jsonl");

    try {
      const r = runHook(
        { CLAWD_QWENWORK_HOOK_DEBUG: "1", CLAWD_QWENWORK_HOOK_DEBUG_PATH: debugPath },
        {
          hook_event_name: "UserPromptSubmit",
          session_id: "s-843",
          cwd: "D:/private/SECRET-CWD",
          prompt: "SECRET-PROMPT rotate the production keys",
        }
      );

      assert.strictEqual(r.status, 0, `stderr=${r.stderr}`);
      assert.strictEqual(r.stdout, "{}\n");

      const text = fs.readFileSync(debugPath, "utf8");
      assert.ok(!text.includes("SECRET-PROMPT"), "the real script leaked the prompt");
      assert.ok(!text.includes("SECRET-CWD"), "the real script leaked the cwd");
      const entry = JSON.parse(text.trim());
      assert.strictEqual(entry.resolvedHookName, "UserPromptSubmit");
      assert.strictEqual(entry.bodyState, "thinking");
      assert.strictEqual(entry.payloadSummary.fields.prompt, "string(len=40)");
    } finally {
      fs.rmSync(logRoot, { recursive: true, force: true });
    }
  });

  it("raw mode through the real script captures the payload verbatim", () => {
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-843-debug-raw-"));
    const debugPath = path.join(logRoot, "logs", "debug.jsonl");
    const payload = {
      hook_event_name: "UserPromptSubmit",
      session_id: "s-843",
      cwd: "D:/private/SECRET-CWD",
      prompt: "SECRET-PROMPT rotate the production keys",
    };

    try {
      const r = runHook(
        {
          CLAWD_QWENWORK_HOOK_DEBUG: "1",
          CLAWD_QWENWORK_HOOK_DEBUG_RAW: "1",
          CLAWD_QWENWORK_HOOK_DEBUG_PATH: debugPath,
        },
        payload
      );

      assert.strictEqual(r.status, 0, `stderr=${r.stderr}`);
      assert.strictEqual(r.stdout, "{}\n");
      const entry = JSON.parse(fs.readFileSync(debugPath, "utf8").trim());
      assert.deepStrictEqual(entry.rawPayload, payload);
    } finally {
      fs.rmSync(logRoot, { recursive: true, force: true });
    }
  });
});
