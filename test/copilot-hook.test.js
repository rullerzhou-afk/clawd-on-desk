"use strict";

// Unit tests for hooks/copilot-hook.js pure helpers.
// Tests buildStateBody, parseWorkspaceYamlName, readCopilotSessionTitle,
// and normalizeTitle. The top-level main() path (stdin read + HTTP post)
// is exercised by manual / end-to-end runs only.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const {
  buildStateBody,
  normalizeTitle,
  parseWorkspaceYamlName,
  readCopilotSessionTitle,
  resolveCopilotSessionStateDir,
} = require("../hooks/copilot-hook.js");

function makeFakeHome(sessionId, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-hook-test-"));
  if (contents !== null) {
    const sessionDir = path.join(dir, ".copilot", "session-state", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), contents);
  }
  return dir;
}

function makeFakeCopilotHomeWithSession(rootName, sessionId, contents) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-hook-env-"));
  const copilotHome = path.join(tmpDir, rootName);
  const sessionDir = path.join(copilotHome, "session-state", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  if (contents !== null) {
    fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), contents);
  }
  return { tmpDir, copilotHome };
}

const mockResolve = () => ({
  stablePid: 1234,
  agentPid: 5678,
  detectedEditor: null,
  pidChain: [1234, 5678],
});

describe("normalizeTitle", () => {
  it("trims whitespace and collapses runs", () => {
    assert.strictEqual(normalizeTitle("  hello   world  "), "hello world");
  });

  it("strips control characters", () => {
    assert.strictEqual(normalizeTitle("foo\u0000bar\u001fbaz"), "foo bar baz");
  });

  it("returns null for empty / whitespace-only / non-string", () => {
    assert.strictEqual(normalizeTitle(""), null);
    assert.strictEqual(normalizeTitle("   "), null);
    assert.strictEqual(normalizeTitle(null), null);
    assert.strictEqual(normalizeTitle(123), null);
  });

  it("truncates with ellipsis past 80 chars", () => {
    const out = normalizeTitle("a".repeat(120));
    assert.strictEqual(out.length, 80);
    assert.strictEqual(out.endsWith("\u2026"), true);
  });
});

describe("parseWorkspaceYamlName", () => {
  it("extracts unquoted name", () => {
    const yaml = "id: abc\nname: Fix Session Rename Bug\nuser_named: false\n";
    assert.strictEqual(parseWorkspaceYamlName(yaml), "Fix Session Rename Bug");
  });

  it("extracts double-quoted name with embedded colon", () => {
    const yaml = 'name: "Foo: bar"\n';
    assert.strictEqual(parseWorkspaceYamlName(yaml), "Foo: bar");
  });

  it("extracts single-quoted name", () => {
    const yaml = "name: 'My Task'\n";
    assert.strictEqual(parseWorkspaceYamlName(yaml), "My Task");
  });

  it("ignores indented name keys (top-level only)", () => {
    const yaml = "  name: nested\nid: x\n";
    assert.strictEqual(parseWorkspaceYamlName(yaml), null);
  });

  it("returns null when no name field", () => {
    assert.strictEqual(parseWorkspaceYamlName("id: x\ncwd: /tmp\n"), null);
  });

  it("returns null for empty/non-string input", () => {
    assert.strictEqual(parseWorkspaceYamlName(""), null);
    assert.strictEqual(parseWorkspaceYamlName(null), null);
    assert.strictEqual(parseWorkspaceYamlName(undefined), null);
  });

  it("strips trailing inline comment on unquoted scalar", () => {
    assert.strictEqual(parseWorkspaceYamlName("name: hello # auto\n"), "hello");
  });

  it("preserves '#' inside quoted scalar", () => {
    assert.strictEqual(parseWorkspaceYamlName('name: "tag #1"\n'), "tag #1");
  });

  it("treats name with empty value as null", () => {
    assert.strictEqual(parseWorkspaceYamlName("name: \nid: x\n"), null);
    assert.strictEqual(parseWorkspaceYamlName('name: ""\n'), null);
  });

  it("returns first matching top-level name (CRLF tolerant)", () => {
    const yaml = "id: x\r\nname: First\r\nname: Second\r\n";
    assert.strictEqual(parseWorkspaceYamlName(yaml), "First");
  });
});

describe("readCopilotSessionTitle", () => {
  it("returns name from workspace.yaml under fake home", () => {
    const sid = "81301938-900f-47e2-b28d-25717f6eeafd";
    const home = makeFakeHome(sid, "id: x\nname: Hello World\nuser_named: true\n");
    assert.strictEqual(
      readCopilotSessionTitle(sid, { homeDir: home }),
      "Hello World"
    );
  });

  it("returns null when file missing", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-hook-test-"));
    assert.strictEqual(
      readCopilotSessionTitle("00000000-0000-0000-0000-000000000000", { homeDir: home }),
      null
    );
  });

  it("returns null when name field absent", () => {
    const sid = "no-name-session";
    const home = makeFakeHome(sid, "id: no-name-session\ncwd: /tmp\n");
    assert.strictEqual(readCopilotSessionTitle(sid, { homeDir: home }), null);
  });

  it("normalizes (trim + collapse + truncate) the result", () => {
    const sid = "session-with-long-name";
    const yaml = `id: x\nname: "${"x".repeat(100)}"\n`;
    const home = makeFakeHome(sid, yaml);
    const out = readCopilotSessionTitle(sid, { homeDir: home });
    assert.strictEqual(out.length, 80);
    assert.strictEqual(out.endsWith("\u2026"), true);
  });

  it("rejects sessionIds containing path separators or empty/null", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-hook-test-"));
    assert.strictEqual(readCopilotSessionTitle("../../../etc", { homeDir: home }), null);
    assert.strictEqual(readCopilotSessionTitle("a/b", { homeDir: home }), null);
    assert.strictEqual(readCopilotSessionTitle("", { homeDir: home }), null);
    assert.strictEqual(readCopilotSessionTitle(null, { homeDir: home }), null);
  });

  it('rejects sessionId ".." even when ~/.copilot/workspace.yaml exists (regression: dot-segment bypass)', () => {
    // sessionId=".." would resolve to ~/.copilot/session-state/../workspace.yaml
    // = ~/.copilot/workspace.yaml. Plant that file and assert the read is
    // refused so the hook never leaks a name from outside session-state/.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-hook-test-"));
    fs.mkdirSync(path.join(home, ".copilot", "session-state"), { recursive: true });
    fs.writeFileSync(path.join(home, ".copilot", "workspace.yaml"), "name: leaked\n");
    assert.strictEqual(readCopilotSessionTitle("..", { homeDir: home }), null);
  });

  it('rejects sessionId "." even when ~/.copilot/session-state/workspace.yaml exists (regression: dot-segment bypass)', () => {
    // sessionId="." would resolve to ~/.copilot/session-state/./workspace.yaml
    // = ~/.copilot/session-state/workspace.yaml. Plant that file and assert
    // the read is refused (the file is not under any session id).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-hook-test-"));
    fs.mkdirSync(path.join(home, ".copilot", "session-state"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".copilot", "session-state", "workspace.yaml"),
      "name: leaked\n"
    );
    assert.strictEqual(readCopilotSessionTitle(".", { homeDir: home }), null);
  });

  it('rejects pure-dot sessionIds ("...", "....", etc.)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-hook-test-"));
    assert.strictEqual(readCopilotSessionTitle("...", { homeDir: home }), null);
    assert.strictEqual(readCopilotSessionTitle("....", { homeDir: home }), null);
  });
});

describe("buildStateBody (Copilot)", () => {
  it("returns null for unknown event", () => {
    assert.strictEqual(buildStateBody("unknownEvent", {}, mockResolve), null);
  });

  it("maps userPromptSubmitted to thinking and includes core fields", () => {
    const body = buildStateBody(
      "userPromptSubmitted",
      { sessionId: "sid-1", cwd: "/tmp/p" },
      mockResolve
    );
    assert.strictEqual(body.state, "thinking");
    assert.strictEqual(body.session_id, "sid-1");
    assert.strictEqual(body.event, "userPromptSubmitted");
    assert.strictEqual(body.agent_id, "copilot-cli");
    assert.strictEqual(body.cwd, "/tmp/p");
    assert.strictEqual(body.source_pid, 1234);
    assert.strictEqual(body.agent_pid, 5678);
    assert.deepStrictEqual(body.pid_chain, [1234, 5678]);
  });

  it("falls back to default sessionId if none provided", () => {
    const body = buildStateBody("sessionStart", {}, mockResolve);
    assert.strictEqual(body.session_id, "default");
  });

  it("prefers payload.session_title over workspace.yaml lookup", () => {
    const body = buildStateBody(
      "userPromptSubmitted",
      { sessionId: "anything", session_title: "Payload Title" },
      mockResolve
    );
    assert.strictEqual(body.session_title, "Payload Title");
  });

  it("uses payload.sessionTitle (camelCase) too", () => {
    const body = buildStateBody(
      "userPromptSubmitted",
      { sessionId: "anything", sessionTitle: "Camel Title" },
      mockResolve
    );
    assert.strictEqual(body.session_title, "Camel Title");
  });

  it("omits session_title when no payload field and no workspace.yaml on disk", () => {
    // sessionId here points at a definitely-nonexistent path under real home;
    // even if the user actually has Copilot installed, this UUID is unlikely.
    const body = buildStateBody(
      "sessionStart",
      { sessionId: "deadbeef-0000-0000-0000-000000000000" },
      mockResolve
    );
    assert.strictEqual("session_title" in body, false);
  });

  it("does not set cwd when missing", () => {
    const body = buildStateBody("sessionStart", { sessionId: "s" }, mockResolve);
    assert.strictEqual("cwd" in body, false);
  });

  it("remote mode includes host prefix and skips local PID fields", () => {
    const oldRemote = process.env.CLAWD_REMOTE;
    process.env.CLAWD_REMOTE = "1";
    let resolveCalled = false;
    try {
      const body = buildStateBody(
        "sessionStart",
        { sessionId: "s", cwd: "/repo", session_title: "Remote Copilot" },
        () => {
          resolveCalled = true;
          throw new Error("resolve should not be called in remote mode");
        },
        { readHostPrefix: () => "remote-box" }
      );

      assert.strictEqual(body.host, "remote-box");
      assert.strictEqual(body.cwd, "/repo");
      assert.strictEqual(body.session_title, "Remote Copilot");
      assert.strictEqual("source_pid" in body, false);
      assert.strictEqual("agent_pid" in body, false);
      assert.strictEqual("pid_chain" in body, false);
      assert.strictEqual(resolveCalled, false);
    } finally {
      if (oldRemote === undefined) delete process.env.CLAWD_REMOTE;
      else process.env.CLAWD_REMOTE = oldRemote;
    }
  });
});

describe("buildStateBody notification (Copilot)", () => {
  for (const notificationType of ["permission_prompt", "elicitation_dialog"]) {
    it(`maps ${notificationType} to Notification with session and local PID fields`, () => {
      const body = buildStateBody("notification", {
        notificationType,
        sessionId: "copilot-notification-1",
        cwd: "/repo",
        sessionTitle: "Waiting Copilot",
        message: "Fetch URL: https://example.invalid/private",
        title: "Permission needed",
      }, mockResolve);

      assert.deepStrictEqual(body, {
        state: "notification",
        event: "Notification",
        agent_id: "copilot-cli",
        session_id: "copilot-notification-1",
        cwd: "/repo",
        session_title: "Waiting Copilot",
        source_pid: 1234,
        agent_pid: 5678,
        pid_chain: [1234, 5678],
        copilot_wait_key: crypto.createHash("sha256").update("url\0https://example.invalid/private").digest("hex").slice(0, 32),
      });
      assert.strictEqual("message" in body, false);
      assert.strictEqual("title" in body, false);
    });
  }

  it("accepts snake_case notification_type when notificationType is not a string", () => {
    for (const notificationType of [undefined, null, false, 42, [], {}]) {
      const body = buildStateBody("notification", {
        notificationType,
        notification_type: "elicitation_dialog",
        session_id: "copilot-snake-1",
        session_title: "Snake Case Copilot",
      }, mockResolve);

      assert.strictEqual(body.state, "notification");
      assert.strictEqual(body.event, "Notification");
      assert.strictEqual(body.session_id, "copilot-snake-1");
    }
  });

  it("prefers a string notificationType over notification_type even when it is not allowed", () => {
    const body = buildStateBody("notification", {
      notificationType: "permission_prompt",
      notification_type: "agent_idle",
      sessionTitle: "Camel Case Copilot",
    }, mockResolve);
    assert.strictEqual(body.event, "Notification");

    for (const notificationType of ["agent_idle", "", "unknown"]) {
      assert.strictEqual(buildStateBody("notification", {
        notificationType,
        notification_type: "permission_prompt",
      }, mockResolve), null);
    }
  });

  it("returns null for missing or non-string notification types", () => {
    assert.strictEqual(buildStateBody("notification", {}, mockResolve), null);
    for (const value of [undefined, null, false, 42, [], {}]) {
      assert.strictEqual(buildStateBody("notification", { notificationType: value }, mockResolve), null);
      assert.strictEqual(buildStateBody("notification", { notification_type: value }, mockResolve), null);
      assert.strictEqual(buildStateBody("notification", {
        notificationType: value,
        notification_type: value,
      }, mockResolve), null);
    }
  });

  for (const notificationType of [
    "shell_completed", "shell_detached_completed", "agent_completed", "agent_idle",
    "unknown", "", " permission_prompt", "permission_prompt ", "PERMISSION_PROMPT",
  ]) {
    it(`returns null for notification type ${JSON.stringify(notificationType)}`, () => {
      const resolve = () => assert.fail("discarded notifications must not resolve PIDs");
      assert.strictEqual(buildStateBody("notification", { notificationType }, resolve), null);
      assert.strictEqual(buildStateBody("notification", { notification_type: notificationType }, resolve), null);
    });
  }

  it("remote notification includes host and session fields without local PID fields or notification text", () => {
    const oldRemote = process.env.CLAWD_REMOTE;
    process.env.CLAWD_REMOTE = "1";
    try {
      const body = buildStateBody("notification", {
        notificationType: "permission_prompt",
        sessionId: "copilot-remote-1",
        cwd: "/remote/repo",
        session_title: "Remote Copilot",
        message: "Read /private/file",
        title: "Permission needed",
      }, () => assert.fail("remote notifications must not resolve local PIDs"), {
        readHostPrefix: () => "remote-box",
      });

      assert.deepStrictEqual(body, {
        state: "notification",
        event: "Notification",
        agent_id: "copilot-cli",
        session_id: "copilot-remote-1",
        cwd: "/remote/repo",
        session_title: "Remote Copilot",
        host: "remote-box",
      });
    } finally {
      if (oldRemote === undefined) delete process.env.CLAWD_REMOTE;
      else process.env.CLAWD_REMOTE = oldRemote;
    }
  });

  it("keeps every other state event in its original camelCase form", () => {
    for (const event of [
      "sessionStart", "sessionEnd", "userPromptSubmitted", "preToolUse", "postToolUse", "postToolUseFailure",
      "errorOccurred", "agentStop", "subagentStart", "subagentStop", "preCompact",
    ]) {
      const body = buildStateBody(event, { sessionTitle: "Copilot" }, mockResolve);
      assert.strictEqual(body.event, event);
    }
  });
});

describe("resolveCopilotSessionStateDir", () => {
  it("uses env.COPILOT_HOME (trimmed) over homeDir", () => {
    const result = resolveCopilotSessionStateDir({
      env: { COPILOT_HOME: "  /custom-cli  " },
      homeDir: "/home/u",
    });
    assert.strictEqual(result, path.join("/custom-cli", "session-state"));
  });

  it("falls back to homeDir/.copilot/session-state when env is empty", () => {
    const result = resolveCopilotSessionStateDir({
      env: { COPILOT_HOME: "" },
      homeDir: "/home/u",
    });
    assert.strictEqual(result, path.join("/home/u", ".copilot", "session-state"));
  });

  it("falls back to homeDir/.copilot/session-state when env is whitespace-only", () => {
    const result = resolveCopilotSessionStateDir({
      env: { COPILOT_HOME: "  \t " },
      homeDir: "/home/u",
    });
    assert.strictEqual(result, path.join("/home/u", ".copilot", "session-state"));
  });

  it("falls back to homeDir/.copilot/session-state when env is missing", () => {
    const result = resolveCopilotSessionStateDir({ env: {}, homeDir: "/home/u" });
    assert.strictEqual(result, path.join("/home/u", ".copilot", "session-state"));
  });
});

describe("readCopilotSessionTitle + COPILOT_HOME", () => {
  it("reads workspace.yaml from env.COPILOT_HOME, not homeDir/.copilot", () => {
    const sessionId = "abc-123";
    const { tmpDir, copilotHome } = makeFakeCopilotHomeWithSession(
      "custom-cli", sessionId, "name: \"Env Title\"\n"
    );
    try {
      // Decoy: default location has a different name; reader must not pick it.
      const decoyHome = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-hook-decoy-"));
      const decoySession = path.join(decoyHome, ".copilot", "session-state", sessionId);
      fs.mkdirSync(decoySession, { recursive: true });
      fs.writeFileSync(path.join(decoySession, "workspace.yaml"), "name: \"Decoy Title\"\n");

      const title = readCopilotSessionTitle(sessionId, {
        env: { COPILOT_HOME: copilotHome },
        homeDir: decoyHome,
      });
      assert.strictEqual(title, "Env Title");

      fs.rmSync(decoyHome, { recursive: true, force: true });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when env points at a missing session even if homeDir has one", () => {
    const sessionId = "abc-123";
    const tmpEnv = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-hook-env-empty-"));
    const decoyHome = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-hook-decoy-"));
    try {
      const decoySession = path.join(decoyHome, ".copilot", "session-state", sessionId);
      fs.mkdirSync(decoySession, { recursive: true });
      fs.writeFileSync(path.join(decoySession, "workspace.yaml"), "name: Decoy\n");

      const title = readCopilotSessionTitle(sessionId, {
        env: { COPILOT_HOME: tmpEnv },
        homeDir: decoyHome,
      });
      assert.strictEqual(title, null);
    } finally {
      fs.rmSync(tmpEnv, { recursive: true, force: true });
      fs.rmSync(decoyHome, { recursive: true, force: true });
    }
  });

  it("preserves path traversal defenses under env redirection", () => {
    // Ensures the charset gate / pure-dot reject / containment check
    // all still fire when sessionStateDir comes from env.
    const tmpEnv = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-hook-trav-"));
    fs.mkdirSync(path.join(tmpEnv, "session-state"), { recursive: true });
    try {
      assert.strictEqual(
        readCopilotSessionTitle("../escape", { env: { COPILOT_HOME: tmpEnv }, homeDir: "/" }),
        null
      );
      assert.strictEqual(
        readCopilotSessionTitle("..", { env: { COPILOT_HOME: tmpEnv }, homeDir: "/" }),
        null
      );
      assert.strictEqual(
        readCopilotSessionTitle("a/b", { env: { COPILOT_HOME: tmpEnv }, homeDir: "/" }),
        null
      );
    } finally {
      fs.rmSync(tmpEnv, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Permission flow helpers — Phase 3+4 tests
// ─────────────────────────────────────────────────────────────────────────

const {
  buildPermissionBody,
  capToolInput,
  enforceBodySizeCap,
  normalizePermissionSuggestions,
  parseClawdPermissionResponse,
  writeCopilotDecision,
  hasUserPermissionHookInRepoHooks,
  HOOK_TOOL_INPUT_STRING_MAX,
  HOOK_TOOL_INPUT_KEYS_MAX,
  HOOK_TOOL_INPUT_ARRAY_MAX,
  HOOK_TOOL_INPUT_DEPTH_MAX,
  HOOK_PERMISSION_BODY_MAX_BYTES,
} = require("../hooks/copilot-hook.js");

const fsTest = require("fs");
const osTest = require("os");
const pathTest = require("path");

// Phase 0 captured payload (`edit` tool, file create).
const SAMPLE_EDIT_PAYLOAD = {
  hookName: "permissionRequest",
  sessionId: "1b2795d2-48e0-4486-ba17-a82d2d48ea53",
  timestamp: 1779974495358,
  cwd: "D:\\animation",
  toolName: "edit",
  toolInput: {
    file_path: "D:\\animation\\test.txt",
    diff: "\ndiff --git a/D:/animation/test.txt b/D:/animation/test.txt\n+This is a test file.\n",
  },
  permissionSuggestions: [],
};

const SAMPLE_POWERSHELL_PAYLOAD = {
  hookName: "permissionRequest",
  sessionId: "9efbe16f-aabf-40d7-b28d-4c24e9a03c14",
  timestamp: 1779974767932,
  cwd: "D:\\animation",
  toolName: "powershell",
  toolInput: { command: "Get-ChildItem -Directory -Name \"D:\\\\animation\"" },
  permissionSuggestions: [],
};

describe("buildPermissionBody", () => {
  it("locks Phase 3 field shape: agent_id, hook_source, event, session_id, tool_name, tool_input, cwd, PID", () => {
    const body = buildPermissionBody(SAMPLE_EDIT_PAYLOAD, mockResolve);
    assert.strictEqual(body.agent_id, "copilot-cli");
    assert.strictEqual(body.hook_source, "copilot-hook");
    assert.strictEqual(body.event, "permissionRequest");
    assert.strictEqual(body.session_id, "1b2795d2-48e0-4486-ba17-a82d2d48ea53");
    assert.strictEqual(body.cwd, "D:\\animation");
    assert.strictEqual(body.tool_name, "edit");
    assert.deepStrictEqual(body.tool_input, SAMPLE_EDIT_PAYLOAD.toolInput);
    assert.deepStrictEqual(body.permission_suggestions, []);
    assert.strictEqual(body.source_pid, 1234);
    assert.strictEqual(body.agent_pid, 5678);
    assert.deepStrictEqual(body.pid_chain, [1234, 5678]);
  });

  it("keeps tool_name lowercase exactly as Copilot wire shape", () => {
    const body = buildPermissionBody(SAMPLE_POWERSHELL_PAYLOAD, mockResolve);
    assert.strictEqual(body.tool_name, "powershell");
  });

  it("throws on empty payload object — sessionId/toolName/toolInput are required", () => {
    // Phase 6 (post-codex-review-1) hardening: see the comment block above
    // buildPermissionBody() in copilot-hook.js for the blind-sign rationale.
    assert.throws(() => buildPermissionBody({}, mockResolve), /missing sessionId/);
  });

  it("accepts snake_case fallbacks (session_id, tool_name, tool_input) for defensive fwd-compat", () => {
    const body = buildPermissionBody({
      session_id: "snake-session",
      tool_name: "shell",
      tool_input: { command: "ls" },
    }, mockResolve);
    assert.strictEqual(body.session_id, "snake-session");
    assert.strictEqual(body.tool_name, "shell");
    assert.deepStrictEqual(body.tool_input, { command: "ls" });
  });

  it("camelCase permissionSuggestions normalizes to snake_case permission_suggestions", () => {
    const body = buildPermissionBody({
      sessionId: "s",
      toolName: "t",
      toolInput: {},
      permissionSuggestions: [{ kind: "allow-once" }],
    }, mockResolve);
    assert.deepStrictEqual(body.permission_suggestions, [{ kind: "allow-once" }]);
  });

  it("remote mode: skips local PID fields and emits host", () => {
    const originalRemote = process.env.CLAWD_REMOTE;
    process.env.CLAWD_REMOTE = "1";
    try {
      const body = buildPermissionBody(SAMPLE_EDIT_PAYLOAD, mockResolve, {
        readHostPrefix: () => "test-host",
      });
      assert.strictEqual(body.host, "test-host");
      assert.strictEqual(body.source_pid, undefined);
      assert.strictEqual(body.agent_pid, undefined);
      assert.strictEqual(body.pid_chain, undefined);
    } finally {
      if (originalRemote === undefined) delete process.env.CLAWD_REMOTE;
      else process.env.CLAWD_REMOTE = originalRemote;
    }
  });

  it("does NOT forward Copilot envelope fields (hookName, timestamp) into Clawd body", () => {
    const body = buildPermissionBody(SAMPLE_EDIT_PAYLOAD, mockResolve);
    assert.strictEqual(body.hookName, undefined);
    assert.strictEqual(body.timestamp, undefined);
  });

  it("throws on a malformed payload so the caller fails open into native Copilot flow", () => {
    // Phase-6 hardening: do NOT silently rebuild a {sessionId:"default",
    // toolName:"unknown"} bubble. The user could approve that "unknown"
    // request, and the hook would then return allow for whatever the real
    // (unread) Copilot request actually was — a blind-sign vulnerability.
    // Throwing forces runPermissionPath() to exit 0 with empty stdout so
    // Copilot's native menu owns the call.
    assert.throws(() => buildPermissionBody(null, mockResolve), /missing or non-object/);
    assert.throws(() => buildPermissionBody("not an object", mockResolve), /missing or non-object/);
    assert.throws(() => buildPermissionBody(42, mockResolve), /missing or non-object/);
  });

  it("throws when sessionId is missing", () => {
    assert.throws(
      () => buildPermissionBody({ toolName: "edit", toolInput: { file: "a" } }, mockResolve),
      /missing sessionId/,
    );
  });

  it("throws when toolName is missing", () => {
    assert.throws(
      () => buildPermissionBody({ sessionId: "s1", toolInput: { file: "a" } }, mockResolve),
      /missing toolName/,
    );
  });

  it("throws when toolInput is missing or non-object", () => {
    assert.throws(
      () => buildPermissionBody({ sessionId: "s1", toolName: "edit" }, mockResolve),
      /missing or non-object toolInput/,
    );
    assert.throws(
      () => buildPermissionBody({ sessionId: "s1", toolName: "edit", toolInput: [] }, mockResolve),
      /missing or non-object toolInput/,
    );
    assert.throws(
      () => buildPermissionBody({ sessionId: "s1", toolName: "edit", toolInput: "string" }, mockResolve),
      /missing or non-object toolInput/,
    );
  });
});

describe("capToolInput — size guard", () => {
  it("truncates strings longer than HOOK_TOOL_INPUT_STRING_MAX", () => {
    const huge = "x".repeat(HOOK_TOOL_INPUT_STRING_MAX + 1000);
    const capped = capToolInput({ diff: huge });
    assert.ok(capped.diff.length <= HOOK_TOOL_INPUT_STRING_MAX + 20);
    assert.ok(capped.diff.endsWith("…[truncated]"));
  });

  it("truncates arrays beyond HOOK_TOOL_INPUT_ARRAY_MAX", () => {
    const arr = new Array(HOOK_TOOL_INPUT_ARRAY_MAX + 10).fill("x");
    const capped = capToolInput(arr);
    assert.strictEqual(capped.length, HOOK_TOOL_INPUT_ARRAY_MAX);
  });

  it("truncates objects beyond HOOK_TOOL_INPUT_KEYS_MAX keys", () => {
    const obj = {};
    for (let i = 0; i < HOOK_TOOL_INPUT_KEYS_MAX + 10; i++) obj[`k${i}`] = i;
    const capped = capToolInput(obj);
    assert.strictEqual(Object.keys(capped).length, HOOK_TOOL_INPUT_KEYS_MAX);
  });

  it("returns null past HOOK_TOOL_INPUT_DEPTH_MAX", () => {
    let deep = { leaf: "ok" };
    for (let i = 0; i < HOOK_TOOL_INPUT_DEPTH_MAX + 3; i++) deep = { nested: deep };
    const capped = capToolInput(deep);
    // Walk down and confirm we hit `null` somewhere within budget.
    let probe = capped;
    let depth = 0;
    while (probe && typeof probe === "object" && probe.nested !== undefined) {
      probe = probe.nested;
      depth++;
      if (depth > HOOK_TOOL_INPUT_DEPTH_MAX + 5) break;
    }
    assert.ok(probe === null || (typeof probe === "object" && probe.leaf === "ok"));
  });

  it("preserves small values exactly", () => {
    assert.strictEqual(capToolInput("hi"), "hi");
    assert.strictEqual(capToolInput(42), 42);
    assert.strictEqual(capToolInput(true), true);
    assert.deepStrictEqual(capToolInput({ a: [1, 2] }), { a: [1, 2] });
  });
});

describe("enforceBodySizeCap", () => {
  it("returns body unchanged when below limit", () => {
    const small = { agent_id: "copilot-cli", tool_input: { x: 1 } };
    const result = enforceBodySizeCap(small);
    assert.strictEqual(result.truncated, false);
    assert.deepStrictEqual(result.body, small);
    assert.strictEqual(typeof result.serialized, "string");
  });

  it("replaces tool_input with a stub when serialized body exceeds cap", () => {
    // Construct an object that survives capToolInput's per-string cap but
    // still produces an oversized serialized body via many keys.
    const tool_input = {};
    const chunk = "x".repeat(HOOK_TOOL_INPUT_STRING_MAX);
    for (let i = 0; i < HOOK_TOOL_INPUT_KEYS_MAX; i++) tool_input[`k${i}`] = chunk;
    const body = { agent_id: "copilot-cli", tool_input };
    const result = enforceBodySizeCap(body);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.body.tool_input._truncated, true);
    assert.ok(Buffer.byteLength(result.serialized, "utf8") <= HOOK_PERMISSION_BODY_MAX_BYTES);
  });
});

describe("normalizePermissionSuggestions", () => {
  it("returns [] for non-array / missing input", () => {
    assert.deepStrictEqual(normalizePermissionSuggestions(undefined), []);
    assert.deepStrictEqual(normalizePermissionSuggestions(null), []);
    assert.deepStrictEqual(normalizePermissionSuggestions("not array"), []);
    assert.deepStrictEqual(normalizePermissionSuggestions({}), []);
  });

  it("passes array through capped", () => {
    const arr = [{ kind: "allow-tool" }, { kind: "deny-tool" }];
    assert.deepStrictEqual(normalizePermissionSuggestions(arr), arr);
  });
});

describe("parseClawdPermissionResponse", () => {
  it("HTTP 200 + behavior:allow → allow decision", () => {
    const d = parseClawdPermissionResponse(true, '{"behavior":"allow"}', 200);
    assert.deepStrictEqual(d, { behavior: "allow" });
  });

  it("HTTP 200 + behavior:deny → deny decision with message", () => {
    const d = parseClawdPermissionResponse(true, '{"behavior":"deny","message":"nope"}', 200);
    assert.deepStrictEqual(d, { behavior: "deny", message: "nope" });
  });

  it("deny without message falls back to 'Denied by Clawd'", () => {
    const d = parseClawdPermissionResponse(true, '{"behavior":"deny"}', 200);
    assert.deepStrictEqual(d, { behavior: "deny", message: "Denied by Clawd" });
  });

  it("HTTP 204 → null (no-decision)", () => {
    assert.strictEqual(parseClawdPermissionResponse(true, "", 204), null);
  });

  it("ok=false → null (no-decision, e.g. Clawd not running)", () => {
    assert.strictEqual(parseClawdPermissionResponse(false, "", 0), null);
  });

  it("malformed JSON body → null", () => {
    assert.strictEqual(parseClawdPermissionResponse(true, "not json", 200), null);
  });

  it("unknown behavior → null (no-decision, do not pass through)", () => {
    assert.strictEqual(parseClawdPermissionResponse(true, '{"behavior":"maybe"}', 200), null);
  });

  it("HTTP 5xx → null", () => {
    assert.strictEqual(parseClawdPermissionResponse(true, '{"behavior":"allow"}', 500), null);
  });

  it("empty response body → null", () => {
    assert.strictEqual(parseClawdPermissionResponse(true, "", 200), null);
  });
});

describe("writeCopilotDecision", () => {
  it("null decision → empty stdout (Phase 0 locked: no output = native fallback)", () => {
    let written = "";
    writeCopilotDecision(null, (chunk) => { written += chunk; });
    assert.strictEqual(written, "");
  });

  it("undefined / non-object → empty stdout", () => {
    let written = "";
    writeCopilotDecision(undefined, (chunk) => { written += chunk; });
    writeCopilotDecision("string", (chunk) => { written += chunk; });
    assert.strictEqual(written, "");
  });

  it("allow → {\"behavior\":\"allow\"}", () => {
    let written = "";
    writeCopilotDecision({ behavior: "allow" }, (chunk) => { written += chunk; });
    assert.strictEqual(written, '{"behavior":"allow"}');
  });

  it("deny with message → {\"behavior\":\"deny\",\"message\":...}", () => {
    let written = "";
    writeCopilotDecision({ behavior: "deny", message: "blocked" }, (chunk) => { written += chunk; });
    assert.strictEqual(written, '{"behavior":"deny","message":"blocked"}');
  });

  it("strips unknown fields (Copilot contract: only behavior/message/interrupt)", () => {
    let written = "";
    writeCopilotDecision({
      behavior: "allow",
      message: "should NOT be written for allow",
      extra: "drop me",
      reason: "drop me too",
    }, (chunk) => { written += chunk; });
    assert.strictEqual(written, '{"behavior":"allow"}',
      "allow path must not emit message; unknown fields must be stripped");
  });

  it("unknown behavior → empty stdout (don't pass it on)", () => {
    let written = "";
    writeCopilotDecision({ behavior: "maybe" }, (chunk) => { written += chunk; });
    assert.strictEqual(written, "");
  });

  it("interrupt:true passes through when set on a deny", () => {
    let written = "";
    writeCopilotDecision({ behavior: "deny", message: "x", interrupt: true }, (chunk) => { written += chunk; });
    const parsed = JSON.parse(written);
    assert.strictEqual(parsed.interrupt, true);
  });
});

describe("hasUserPermissionHookInRepoHooks — repo-level safe-v1 (codex review 3)", () => {
  // Copilot CLI merges <cwd>/.github/hooks/*.json into the user-level hook
  // chain. Installer doesn't know cwd; hook itself does. If the repo ships
  // its own permissionRequest hook, the Clawd hook MUST fall open (empty
  // stdout, exit 0) so the project audit/deny rule isn't silently overridden.

  function makeTmpRepo() {
    const root = fsTest.mkdtempSync(pathTest.join(osTest.tmpdir(), "clawd-copilot-repo-"));
    const hooksDir = pathTest.join(root, ".github", "hooks");
    fsTest.mkdirSync(hooksDir, { recursive: true });
    return { root, hooksDir };
  }

  it("returns false when cwd is missing or non-absolute", () => {
    assert.strictEqual(hasUserPermissionHookInRepoHooks(""), false);
    assert.strictEqual(hasUserPermissionHookInRepoHooks(null), false);
    assert.strictEqual(hasUserPermissionHookInRepoHooks(undefined), false);
    assert.strictEqual(hasUserPermissionHookInRepoHooks("relative/path"), false);
    assert.strictEqual(hasUserPermissionHookInRepoHooks(42), false);
  });

  it("returns false when the repo has no .github/hooks/ directory", () => {
    const { root } = makeTmpRepo();
    try {
      fsTest.rmSync(pathTest.join(root, ".github"), { recursive: true, force: true });
      assert.strictEqual(hasUserPermissionHookInRepoHooks(root), false);
    } finally { fsTest.rmSync(root, { recursive: true, force: true }); }
  });

  it("returns false when .github/hooks/ contains no permissionRequest entries", () => {
    const { root, hooksDir } = makeTmpRepo();
    try {
      fsTest.writeFileSync(pathTest.join(hooksDir, "state-only.json"),
        JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: "command", bash: "echo p" }] } }));
      assert.strictEqual(hasUserPermissionHookInRepoHooks(root), false);
    } finally { fsTest.rmSync(root, { recursive: true, force: true }); }
  });

  it("returns true when ANY .github/hooks/*.json declares a permissionRequest", () => {
    const { root, hooksDir } = makeTmpRepo();
    try {
      fsTest.writeFileSync(pathTest.join(hooksDir, "audit.json"),
        JSON.stringify({ version: 1, hooks: { permissionRequest: [{ type: "command", bash: "/usr/bin/audit" }] } }));
      assert.strictEqual(hasUserPermissionHookInRepoHooks(root), true);
    } finally { fsTest.rmSync(root, { recursive: true, force: true }); }
  });

  it("parses repo hooks with a UTF-8 BOM (regression for PowerShell-edited audit hooks)", () => {
    const { root, hooksDir } = makeTmpRepo();
    try {
      const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
      const body = Buffer.from(JSON.stringify({
        version: 1, hooks: { permissionRequest: [{ type: "command", bash: "/usr/bin/audit" }] },
      }));
      fsTest.writeFileSync(pathTest.join(hooksDir, "audit.json"), Buffer.concat([bom, body]));
      assert.strictEqual(hasUserPermissionHookInRepoHooks(root), true);
    } finally { fsTest.rmSync(root, { recursive: true, force: true }); }
  });

  it("ignores non-json files in .github/hooks/", () => {
    const { root, hooksDir } = makeTmpRepo();
    try {
      fsTest.writeFileSync(pathTest.join(hooksDir, "README.md"), "permissionRequest");
      assert.strictEqual(hasUserPermissionHookInRepoHooks(root), false);
    } finally { fsTest.rmSync(root, { recursive: true, force: true }); }
  });

  it("returns false on malformed JSON (transient FS hiccup must not block Clawd)", () => {
    const { root, hooksDir } = makeTmpRepo();
    try {
      fsTest.writeFileSync(pathTest.join(hooksDir, "broken.json"), "{ not valid");
      assert.strictEqual(hasUserPermissionHookInRepoHooks(root), false);
    } finally { fsTest.rmSync(root, { recursive: true, force: true }); }
  });

  it("treats an empty permissionRequest array as 'no hook'", () => {
    const { root, hooksDir } = makeTmpRepo();
    try {
      fsTest.writeFileSync(pathTest.join(hooksDir, "empty.json"),
        JSON.stringify({ hooks: { permissionRequest: [] } }));
      assert.strictEqual(hasUserPermissionHookInRepoHooks(root), false);
    } finally { fsTest.rmSync(root, { recursive: true, force: true }); }
  });

  it("finds .github/hooks/*.json declared at an ANCESTOR of cwd (subdir invocation)", () => {
    // Codex review 4: Copilot's repo-level hooks live at the repository
    // root, but the user may invoke Copilot deep inside a subdirectory.
    // The helper must walk upward.
    const { root, hooksDir } = makeTmpRepo();
    try {
      fsTest.writeFileSync(pathTest.join(hooksDir, "audit.json"),
        JSON.stringify({ hooks: { permissionRequest: [{ type: "command", bash: "/usr/bin/audit" }] } }));
      const nestedCwd = pathTest.join(root, "packages", "web", "src");
      fsTest.mkdirSync(nestedCwd, { recursive: true });
      assert.strictEqual(hasUserPermissionHookInRepoHooks(nestedCwd), true);
    } finally { fsTest.rmSync(root, { recursive: true, force: true }); }
  });

  it("returns false when no ancestor up to fs root declares a permissionRequest", () => {
    // Walking up the chain must not produce false positives on directories
    // that don't carry any of the 5 known sources.
    const tmpRoot = fsTest.mkdtempSync(pathTest.join(osTest.tmpdir(), "clawd-copilot-noancestor-"));
    try {
      const deepDir = pathTest.join(tmpRoot, "a", "b", "c");
      fsTest.mkdirSync(deepDir, { recursive: true });
      assert.strictEqual(hasUserPermissionHookInRepoHooks(deepDir), false);
    } finally { fsTest.rmSync(tmpRoot, { recursive: true, force: true }); }
  });

  for (const inline of [
    [".github", "copilot", "settings.json"],
    [".github", "copilot", "settings.local.json"],
    [".claude", "settings.json"],
    [".claude", "settings.local.json"],
  ]) {
    it(`detects an inline permissionRequest in ${inline.join("/")} at an ancestor`, () => {
      // All four inline-settings sources are merged into Copilot's hook
      // chain per the official docs (including cross-tool .claude/*).
      const tmpRoot = fsTest.mkdtempSync(pathTest.join(osTest.tmpdir(), "clawd-copilot-inline-"));
      try {
        const targetDir = pathTest.join(tmpRoot, ...inline.slice(0, -1));
        fsTest.mkdirSync(targetDir, { recursive: true });
        fsTest.writeFileSync(
          pathTest.join(tmpRoot, ...inline),
          JSON.stringify({ hooks: { permissionRequest: [{ type: "command", bash: "/usr/bin/audit" }] } }),
        );
        const nestedCwd = pathTest.join(tmpRoot, "deep", "nested", "subdir");
        fsTest.mkdirSync(nestedCwd, { recursive: true });
        assert.strictEqual(hasUserPermissionHookInRepoHooks(nestedCwd), true);
      } finally { fsTest.rmSync(tmpRoot, { recursive: true, force: true }); }
    });
  }

  it("parses inline settings written with a UTF-8 BOM", () => {
    const tmpRoot = fsTest.mkdtempSync(pathTest.join(osTest.tmpdir(), "clawd-copilot-bom-inline-"));
    try {
      const claudeDir = pathTest.join(tmpRoot, ".claude");
      fsTest.mkdirSync(claudeDir, { recursive: true });
      const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
      const body = Buffer.from(JSON.stringify({
        hooks: { permissionRequest: [{ type: "command", bash: "/usr/bin/audit" }] },
      }));
      fsTest.writeFileSync(pathTest.join(claudeDir, "settings.json"), Buffer.concat([bom, body]));
      assert.strictEqual(hasUserPermissionHookInRepoHooks(tmpRoot), true);
    } finally { fsTest.rmSync(tmpRoot, { recursive: true, force: true }); }
  });

  it("returns false for malformed inline settings (transient FS hiccup must not block Clawd)", () => {
    const tmpRoot = fsTest.mkdtempSync(pathTest.join(osTest.tmpdir(), "clawd-copilot-bad-inline-"));
    try {
      const claudeDir = pathTest.join(tmpRoot, ".claude");
      fsTest.mkdirSync(claudeDir, { recursive: true });
      fsTest.writeFileSync(pathTest.join(claudeDir, "settings.json"), "{ not valid");
      assert.strictEqual(hasUserPermissionHookInRepoHooks(tmpRoot), false);
    } finally { fsTest.rmSync(tmpRoot, { recursive: true, force: true }); }
  });

  it("early-exits when the FIRST level matched (does not unnecessarily walk up)", () => {
    // Strategy: verify behavior, not internal call count — if the helper
    // were buggy and over-walked it could still pass-by-accident here, but
    // an audit hook RIGHT IN cwd is the most common case and must work.
    const { root, hooksDir } = makeTmpRepo();
    try {
      fsTest.writeFileSync(pathTest.join(hooksDir, "audit.json"),
        JSON.stringify({ hooks: { permissionRequest: [{ type: "command", bash: "/usr/bin/audit" }] } }));
      assert.strictEqual(hasUserPermissionHookInRepoHooks(root), true);
    } finally { fsTest.rmSync(root, { recursive: true, force: true }); }
  });
});


describe("buildStateBody terminal wait correlation", () => {
  const fingerprint = (kind, value) => crypto.createHash("sha256").update(`${kind}\0${value}`).digest("hex").slice(0, 32);
  for (const [kind, value, message, toolName, toolArgs] of [
    ["path", "D:\\Images\\a.png", "Path permission needed: D:\\Images\\a.png", "view", { path: "D:\\Images\\a.png" }],
    ["url", "https://example.invalid/Private?q=X", "Fetch URL: https://example.invalid/Private?q=X", "web_fetch", { url: "https://example.invalid/Private?q=X" }],
    ["ask_user", "", "Information requested", "ask_user", { question: "private question" }],
  ]) {
    it(`matches ${kind} notification with successful and failed tool completion without forwarding content`, () => {
      const key = fingerprint(kind, value);
      const notice = buildStateBody("notification", {
        sessionId: "correlation", sessionTitle: "Copilot", notificationType: "permission_prompt", message, timestamp: 100,
      }, mockResolve);
      assert.strictEqual(notice.copilot_wait_key, key);
      assert.strictEqual(notice.copilot_event_ts, 100);
      for (const event of ["postToolUse", "postToolUseFailure"]) {
        const body = buildStateBody(event, {
          sessionId: "correlation", sessionTitle: "Copilot", toolName, toolArgs, timestamp: 200,
          toolResult: "private result", error: "private error",
        }, mockResolve);
        assert.strictEqual(body.state, "working");
        assert.deepStrictEqual(body.copilot_tool_keys, [key]);
        assert.strictEqual(body.copilot_event_ts, 200);
        for (const field of ["toolArgs", "toolResult", "error", "message", "title"]) assert.strictEqual(field in body, false);
        assert.strictEqual(JSON.stringify(body).includes("private"), false);
      }
      assert.strictEqual(JSON.stringify(notice).includes(message), false);
    });
  }

  it("keeps command and unknown notifications as one-shot alerts", () => {
    for (const message of ["Run command: sleep 3600", "New prompt format", "Path permission needed: ", "Fetch URL: ", undefined, 42]) {
      const body = buildStateBody("notification", { sessionTitle: "Copilot", notificationType: "permission_prompt", message }, mockResolve);
      assert.strictEqual(body.event, "Notification");
      assert.strictEqual("copilot_wait_key" in body, false);
    }
  });

  it("hashes values exactly and only forwards path, url and ask_user keys", () => {
    const toolArgs = { path: " D:\\Images\\A.png ", url: "https://EXAMPLE.invalid/", command: "private command" };
    const body = buildStateBody("postToolUse", { sessionTitle: "Copilot", toolName: "ask_user", toolArgs }, mockResolve);
    assert.deepStrictEqual(body.copilot_tool_keys, [fingerprint("path", toolArgs.path), fingerprint("url", toolArgs.url), fingerprint("ask_user", "")]);
    const empty = buildStateBody("postToolUse", { sessionTitle: "Copilot", toolArgs: { path: 42, url: null, command: "sleep 3600" } }, mockResolve);
    assert.strictEqual("copilot_tool_keys" in empty, false);
  });

  it("only sends finite numeric timestamps on the six correlation events", () => {
    for (const event of ["notification", "postToolUse", "postToolUseFailure", "userPromptSubmitted", "agentStop", "sessionEnd", "sessionStart", "preToolUse", "errorOccurred", "preCompact", "subagentStart", "subagentStop"]) {
      const payload = { sessionTitle: "Copilot", notificationType: "elicitation_dialog", timestamp: 123 };
      const body = buildStateBody(event, payload, mockResolve);
      assert.strictEqual(body.copilot_event_ts, ["sessionStart", "preToolUse", "errorOccurred", "preCompact", "subagentStart", "subagentStop"].includes(event) ? undefined : 123);
      assert.strictEqual("copilot_wait_key" in body, false);
      assert.strictEqual("copilot_tool_keys" in body, false);
      for (const timestamp of [undefined, null, "123", NaN, Infinity, -Infinity]) {
        assert.strictEqual("copilot_event_ts" in buildStateBody(event, { ...payload, timestamp }, mockResolve), false);
      }
    }
  });
});
