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

const {
  buildStateBody,
  normalizeTitle,
  parseWorkspaceYamlName,
  readCopilotSessionTitle,
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
