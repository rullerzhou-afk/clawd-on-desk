const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { __test } = require("../hooks/antigravity-hook");

function runAntigravityHook(argvEvent, payload = {}) {
  const scriptPath = path.resolve(__dirname, "..", "hooks", "antigravity-hook.js");
  const httpBlockerPath = path.resolve(__dirname, "hook-http-blocker.js");
  return spawnSync(process.execPath, ["--require", httpBlockerPath, scriptPath, argvEvent], {
    env: { ...process.env, CLAWD_REMOTE: "1" },
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
  });
}

describe("Antigravity hook script", () => {
  it("writes ask JSON for PreToolUse so agy keeps native permission handling", () => {
    const result = runAntigravityHook("PreToolUse", { conversationId: "c1" });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stderr, "");
    assert.deepStrictEqual(JSON.parse(result.stdout), { decision: "ask" });
  });

  it("posts Antigravity conversation ids and workspace cwd", async () => {
    const postedBodies = [];
    const result = await __test.sendHookEvent({
      conversationId: "c1",
      workspacePaths: [process.cwd()],
    }, "PreInvocation", {
      env: {},
      postState: (body, _options, callback) => {
        postedBodies.push(JSON.parse(body));
        callback(true, 23333);
      },
    });

    assert.deepStrictEqual(result.stdout, "{}");
    assert.strictEqual(postedBodies.length, 1);
    assert.strictEqual(postedBodies[0].agent_id, "antigravity-cli");
    assert.strictEqual(postedBodies[0].session_id, "antigravity:c1");
    assert.strictEqual(postedBodies[0].state, "thinking");
    assert.strictEqual(postedBodies[0].event, "UserPromptSubmit");
    assert.strictEqual(postedBodies[0].cwd, process.cwd());
  });

  it("uses tool Cwd before workspace paths", () => {
    assert.strictEqual(
      __test.resolveCwd({
        workspacePaths: ["/workspace"],
        toolCall: { args: { Cwd: "/tool-cwd" } },
      }),
      "/tool-cwd"
    );
  });

  it("builds a permission body from PreToolUse camelCase payloads", () => {
    const body = __test.buildPermissionBody("PreToolUse", {
      conversationId: "c1",
      workspacePaths: ["/workspace"],
      transcriptPath: "/workspace/.gemini/jetski/transcript.jsonl",
      artifactDirectoryPath: "/workspace/.gemini/jetski/artifacts",
      stepIdx: 19,
      toolCall: {
        name: "run_command",
        args: {
          CommandLine: "npm test",
          Cwd: "/workspace/project",
        },
      },
    }, {
      pidMeta: {
        stablePid: 123.9,
        agentPid: 456,
        detectedEditor: "WindowsTerminal",
        pidChain: [789, 456],
      },
    });

    assert.deepStrictEqual(body, {
      agent_id: "antigravity-cli",
      hook_source: "antigravity-hook",
      session_id: "antigravity:c1",
      tool_name: "run_command",
      tool_input: {
        CommandLine: "npm test",
        Cwd: "/workspace/project",
      },
      cwd: "/workspace/project",
      step_idx: 19,
      transcript_path: "/workspace/.gemini/jetski/transcript.jsonl",
      artifact_directory_path: "/workspace/.gemini/jetski/artifacts",
      source_pid: 123,
      editor: "WindowsTerminal",
      agent_pid: 456,
      pid_chain: [789, 456],
    });
  });

  it("falls back to ask when Clawd server returns 204 for a stray PreToolUse", async () => {
    // D2: server hard-blocks antigravity PreToolUse with 204. Hook script
    // should then emit decision:"ask" so agy's native menu takes over.
    // This mirrors the production state-only contract.
    const postedStates = [];
    const postedPermissions = [];
    const result = await __test.sendHookEvent({
      conversationId: "c1",
      workspacePaths: ["/workspace"],
      toolCall: {
        name: "run_command",
        args: { CommandLine: "npm test", Cwd: "/workspace" },
      },
    }, "PreToolUse", {
      env: {},
      postState: (body, _options, callback) => {
        postedStates.push(JSON.parse(body));
        callback(true, 23333);
      },
      postPermission: (body, _options, callback) => {
        postedPermissions.push(JSON.parse(body));
        callback(true, 23333, "", 204);
      },
    });

    assert.deepStrictEqual(JSON.parse(result.stdout), { decision: "ask" });
    assert.strictEqual(result.permissionStatusCode, 204);
    assert.strictEqual(postedStates[0].state, "working");
    assert.strictEqual(postedPermissions[0].agent_id, "antigravity-cli");
    assert.strictEqual(postedPermissions[0].tool_name, "run_command");
  });

  it("writes gated debug logs to a file without changing hook stdout", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-antigravity-hook-debug-"));
    const debugFile = path.join(tmpDir, "hook-debug.log");
    const result = await __test.sendHookEvent({
      conversationId: "c1",
      workspacePaths: ["/workspace"],
      toolCall: {
        name: "run_command",
        args: {
          CommandLine: "Remove-Item -Path secret.txt",
          Cwd: "/workspace",
          apiKey: "should-not-log",
        },
      },
    }, "PreToolUse", {
      env: {
        CLAWD_ANTIGRAVITY_HOOK_DEBUG: "1",
        CLAWD_ANTIGRAVITY_HOOK_DEBUG_FILE: debugFile,
      },
      postState: (_body, _options, callback) => callback(true, 23333),
      postPermission: (_body, _options, callback) => callback(true, 23333, JSON.stringify({
        decision: "allow",
      }), 200),
    });

    assert.deepStrictEqual(JSON.parse(result.stdout), {
      decision: "allow",
      allowTool: true,
    });

    const entries = fs.readFileSync(debugFile, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepStrictEqual(entries.map((entry) => entry.event), [
      "permission-request",
      "permission-response",
      "hook-result",
    ]);
    assert.strictEqual(entries[0].toolName, "run_command");
    assert.strictEqual(entries[0].toolInput.CommandLine, "Remove-Item -Path secret.txt");
    assert.strictEqual(entries[0].toolInput.apiKey, "[redacted]");
    assert.strictEqual(entries[1].stdout, result.stdout);
  });

  it("falls back to ask when Clawd returns no Antigravity decision", async () => {
    const result = await __test.sendHookEvent({
      conversationId: "c1",
      toolCall: { name: "write_to_file", args: { TargetFile: "/tmp/a.txt" } },
    }, "PreToolUse", {
      env: {},
      postState: (_body, _options, callback) => callback(false, null),
      postPermission: (_body, _options, callback) => callback(true, 23333, "", 204),
    });

    assert.deepStrictEqual(JSON.parse(result.stdout), { decision: "ask" });
    assert.strictEqual(result.permissionStatusCode, 204);
  });

  it("sanitizes deny decisions into Antigravity stdout shape", () => {
    assert.deepStrictEqual(
      JSON.parse(__test.sanitizeAntigravityPermissionOutput(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "deny", message: "Blocked by user" },
        },
      }), 200)),
      { decision: "deny", reason: "Blocked by user", denyReason: "Blocked by user" }
    );
    assert.deepStrictEqual(
      JSON.parse(__test.sanitizeAntigravityPermissionOutput(JSON.stringify({
        decision: "force_ask",
        reason: "Review natively",
        permissionOverrides: ["command(npm test)"],
      }), 200)),
      {
        decision: "force_ask",
        reason: "Review natively",
      }
    );
    assert.deepStrictEqual(
      JSON.parse(__test.sanitizeAntigravityPermissionOutput(JSON.stringify({
        decision: "allow",
        permissionOverrides: ["command(Remove-Item test.md)"],
      }), 200)),
      { decision: "allow", allowTool: true }
    );
    assert.deepStrictEqual(
      JSON.parse(__test.sanitizeAntigravityPermissionOutput(JSON.stringify({
        decision: "ask",
        permissionOverrides: ["read_file(/repo/package.json)"],
      }), 200)),
      { decision: "ask" }
    );
  });

  it("maps PostToolUse errors to PostToolUseFailure", async () => {
    const postedBodies = [];
    await __test.sendHookEvent({
      conversationId: "c1",
      workspacePaths: [process.cwd()],
      error: "tool failed",
    }, "PostToolUse", {
      env: {},
      postState: (body, _options, callback) => {
        postedBodies.push(JSON.parse(body));
        callback(true, 23333);
      },
    });

    assert.strictEqual(postedBodies.length, 1);
    assert.strictEqual(postedBodies[0].state, "error");
    assert.strictEqual(postedBodies[0].event, "PostToolUseFailure");
  });

  it("maps fully idle Stop to the shared done event", async () => {
    const postedBodies = [];
    const result = await __test.sendHookEvent({
      conversationId: "c1",
      fullyIdle: true,
    }, "Stop", {
      env: {},
      postState: (body, _options, callback) => {
        postedBodies.push(JSON.parse(body));
        callback(true, 23333);
      },
    });

    assert.deepStrictEqual(result.stdout, JSON.stringify({ decision: "allow" }));
    assert.strictEqual(postedBodies.length, 1);
    assert.strictEqual(postedBodies[0].state, "attention");
    assert.strictEqual(postedBodies[0].event, "Stop");
  });

  it("keeps non-idle Stop as working while background tasks remain", async () => {
    const postedBodies = [];
    await __test.sendHookEvent({
      conversationId: "c1",
      fullyIdle: false,
    }, "Stop", {
      env: {},
      postState: (body, _options, callback) => {
        postedBodies.push(JSON.parse(body));
        callback(true, 23333);
      },
    });

    assert.strictEqual(postedBodies.length, 1);
    assert.strictEqual(postedBodies[0].state, "working");
    assert.strictEqual(postedBodies[0].event, "PostToolUse");
  });

  it("recognizes agy command lines for agent PID tracking", () => {
    assert.strictEqual(__test.isAntigravityAgentCommandLine('"C:/Users/me/AppData/Local/agy/bin/agy.exe"'), true);
    assert.strictEqual(__test.isAntigravityAgentCommandLine('"node" "D:/animation/hooks/antigravity-hook.js" "Stop"'), false);
  });

  it("fails open when local hook setup throws", () => {
    const scriptPath = path.resolve(__dirname, "..", "hooks", "antigravity-hook.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-antigravity-hook-"));
    const preloadPath = path.join(tmpDir, "preload.js");
    const preload = `
      const Module = require("module");
      const original = Module._load;
      Module._load = function(request, parent, isMain) {
        if (request.endsWith("./shared-process") || request.endsWith("/shared-process")) {
          return {
            getPlatformConfig: () => ({}),
            readStdinJson: () => Promise.reject(new Error("stdin failed")),
            createPidResolver: () => () => { throw new Error("pid failed"); },
          };
        }
        return original.apply(this, arguments);
      };
    `;
    fs.writeFileSync(preloadPath, preload);
    const result = spawnSync(process.execPath, ["--require", preloadPath, scriptPath, "PreToolUse"], {
      input: JSON.stringify({ conversationId: "c1" }),
      encoding: "utf8",
      windowsHide: true,
    });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stderr, "");
    assert.deepStrictEqual(JSON.parse(result.stdout), { decision: "ask" });
  });
});
