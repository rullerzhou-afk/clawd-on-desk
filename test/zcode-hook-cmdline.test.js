const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  getZcodePidResolverContext,
  getZcodePidResolverOptions,
  getZcodePlatformConfig,
  isZcodeAgentCommandLine,
} = require("../hooks/zcode-hook");

// The ZCode Windows runtime reuses the ZCode.exe desktop shell to run
// `resources/glm/zcode.cjs app-server --stdio` (ELECTRON_RUN_AS_NODE=1). The
// cmdline check must recognize that `zcode.cjs` token so the working process is
// credited as the agent — while a bare shell invocation (no zcode.cjs) must NOT
// match, or the always-running desktop app would be mis-attributed.
describe("isZcodeAgentCommandLine", () => {
  it("matches the macOS/Linux zcode-cli binary", () => {
    assert.ok(isZcodeAgentCommandLine("/Applications/ZCode.app/zcode-cli"));
    assert.ok(isZcodeAgentCommandLine("zcode-cli"));
    assert.ok(isZcodeAgentCommandLine("zcode-cli.exe"));
  });

  it("matches the Windows ZCode.exe + zcode.cjs working process", () => {
    assert.ok(isZcodeAgentCommandLine(
      "ZCode.exe resources/glm/zcode.cjs app-server --stdio"
    ));
    // Backslash Windows paths normalize too.
    assert.ok(isZcodeAgentCommandLine(
      "ZCode.exe resources\\glm\\zcode.cjs app-server --stdio"
    ));
    assert.ok(isZcodeAgentCommandLine("node zcode.cjs app-server"));
  });

  it("matches the current macOS Electron Node-mode runtime and gates the ambiguous name", () => {
    const command = [
      "/Applications/ZCode.app/Contents/MacOS/ZCode",
      "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
      "app-server",
      "--stdio",
    ].join(" ");
    assert.ok(isZcodeAgentCommandLine(command));

    const options = getZcodePidResolverOptions({});
    assert.ok(options.agentCmdlineNames.has("zcode"));
    assert.ok(!options.agentNames.mac.has("zcode"));
    assert.ok(options.agentCmdlineCheck(command));
    assert.ok(!options.agentCmdlineCheck("/Applications/ZCode.app/Contents/MacOS/ZCode"));
  });

  it("does NOT match the bare ZCode desktop shell without zcode.cjs", () => {
    // The always-running desktop app must not be credited as a live agent.
    assert.ok(!isZcodeAgentCommandLine("/Applications/ZCode.app/Contents/MacOS/ZCode"));
    assert.ok(!isZcodeAgentCommandLine("ZCode.exe"));
    assert.ok(!isZcodeAgentCommandLine("ZCode.exe --type=gpu-process"));
    assert.ok(!isZcodeAgentCommandLine("zcode-host-local-1"));
  });

  it("matches a node launcher referencing the zcode hook script", () => {
    assert.ok(isZcodeAgentCommandLine(
      '"/usr/local/bin/node" "/app/hooks/zcode-hook.js" SessionStart'
    ));
  });

  it("rejects unrelated commands", () => {
    assert.ok(!isZcodeAgentCommandLine("/usr/local/bin/node something-else.js"));
    assert.ok(!isZcodeAgentCommandLine("claude --print"));
    assert.ok(!isZcodeAgentCommandLine(""));
    assert.ok(!isZcodeAgentCommandLine(null));
    assert.ok(!isZcodeAgentCommandLine(undefined));
  });
});

describe("ZCode PID resolver integration", () => {
  it("adds zcode.exe as a Windows stable source boundary", () => {
    let received = null;
    const result = getZcodePlatformConfig((options) => {
      received = options;
      return { ok: true };
    });

    assert.deepStrictEqual(received, {
      extraTerminals: { win: ["zcode.exe"] },
    });
    assert.deepStrictEqual(result, { ok: true });
  });

  it("maps lifecycle events without ever treating Stop as end", () => {
    const base = { session_id: "sid-1", cwd: "D:/repo" };
    assert.strictEqual(getZcodePidResolverContext("SessionStart", base).lifecycle, "start");
    assert.strictEqual(getZcodePidResolverContext("UserPromptSubmit", base).lifecycle, "prompt");
    assert.strictEqual(getZcodePidResolverContext("PreToolUse", base).lifecycle, "event");
    assert.strictEqual(getZcodePidResolverContext("Stop", base).lifecycle, "event");
  });

  it("only caches a real raw session_id plus cwd", () => {
    assert.strictEqual(getZcodePidResolverContext("PreToolUse", {
      session_id: "sid-1",
      cwd: "D:/repo",
    }).cacheable, true);
    for (const sessionId of [undefined, "", "default", "zcode:default"]) {
      assert.strictEqual(getZcodePidResolverContext("PreToolUse", {
        session_id: sessionId,
        cwd: "D:/repo",
      }).cacheable, false);
    }
    assert.strictEqual(getZcodePidResolverContext("PreToolUse", {
      session_id: "sid-1",
    }).cacheable, false);
  });
});
