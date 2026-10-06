const { describe, it } = require("node:test");
const assert = require("node:assert");

const { __test } = require("../hooks/minimax-hook");
const { runSpawnedHook } = require("./helpers/spawned-hook");

const HOOK_PATH = require("node:path").resolve(__dirname, "..", "hooks", "minimax-hook.js");

function runMinimaxHook(payload, options = {}) {
  return runSpawnedHook({
    script: options.script || HOOK_PATH,
    payload,
    httpContract: options.httpContract || "expect-attempt",
    env: {
      CLAWD_POST_RECORDER_SUCCEED: "1",
      ...(options.env || {}),
    },
  });
}

function postedBody(result) {
  const post = result.attempts && result.attempts.find(
    (attempt) => attempt.kind === "request" && typeof attempt.body === "string"
  );
  assert.ok(post, `expected a recorded POST attempt; attempts=${JSON.stringify(result.attempts)}`);
  return JSON.parse(post.body);
}

describe("minimax hook title derivation", () => {
  const { resolveSessionTitle } = __test;

  it("derives the title from the first line of the prompt on UserPromptSubmit", () => {
    assert.strictEqual(
      resolveSessionTitle({ prompt: "你能做什么" }, "UserPromptSubmit"),
      "你能做什么"
    );
  });

  it("uses the first non-empty line of a multiline prompt", () => {
    assert.strictEqual(
      resolveSessionTitle({ prompt: "\n  修一下 bug  \n然后跑测试" }, "UserPromptSubmit"),
      "修一下 bug"
    );
  });

  it("returns null when the prompt is empty or missing", () => {
    assert.strictEqual(resolveSessionTitle({}, "UserPromptSubmit"), null);
    assert.strictEqual(resolveSessionTitle({ prompt: "   \n\n" }, "UserPromptSubmit"), null);
  });

  it("returns null when the payload is missing", () => {
    assert.strictEqual(resolveSessionTitle(null, "UserPromptSubmit"), null);
  });

  it("truncates long prompt titles with an ellipsis", () => {
    const long = "写一个超长的功能描述".repeat(20);
    const title = resolveSessionTitle({ prompt: long }, "UserPromptSubmit");
    assert.ok(title.length <= 41, `title too long: ${title.length}`);
    assert.ok(title.endsWith("…"));
  });

  it("refuses secret-looking prompts instead of leaking them as titles", () => {
    assert.strictEqual(
      resolveSessionTitle({ prompt: "我的 api_key 是 sk-abcdefghijklmnopqrstuvwxyz" }, "UserPromptSubmit"),
      null
    );
  });

  it("does not derive a title from prompts on non-UserPromptSubmit events", () => {
    assert.strictEqual(resolveSessionTitle({ prompt: "你能做什么" }, "Stop"), null);
  });
});

describe("minimax hook lifecycle", () => {
  it("maps every registered event to the Clawd state machine and emits {}", () => {
    // One spawned run per representative event class; the full event set is
    // pinned by agents/minimax.js assertions in test/registry.test.js.
    const cases = [
      ["SessionStart", "idle"],
      ["SessionEnd", "sleeping"],
      ["UserPromptSubmit", "thinking"],
      ["PreToolUse", "working"],
      ["PostToolUse", "working"],
      ["Stop", "attention"],
      ["SubagentStart", "juggling"],
      ["SubagentStop", "working"],
      ["PreCompact", "sweeping"],
      // Compaction finishing is not turn completion (#406): never attention.
      ["PostCompact", "thinking"],
    ];
    for (const [event, state] of cases) {
      const result = runMinimaxHook({
        session_id: `sess-${event}`,
        cwd: "/tmp/project",
        hook_event_name: event,
        ...(event === "PreToolUse" ? { tool_name: "Bash", tool_input: { command: "ls" } } : {}),
      });
      assert.strictEqual(result.status, 0, `${event}: exit code`);
      assert.strictEqual(result.stdout.trim(), "{}", `${event}: stdout must stay {} (abstain)`);
      const body = postedBody(result);
      assert.strictEqual(body.state, state, `${event}: mapped state`);
      assert.strictEqual(body.event, event);
      assert.strictEqual(body.agent_id, "minimax");
    }
  });

  it("settles a manual compaction to idle and keeps an automatic one busy", () => {
    for (const [trigger, state] of [["manual", "idle"], ["auto", "thinking"], [undefined, "thinking"]]) {
      const result = runMinimaxHook({
        session_id: `sess-compact-${trigger}`,
        cwd: "/tmp/project",
        hook_event_name: "PostCompact",
        ...(trigger ? { trigger } : {}),
      });
      assert.strictEqual(result.status, 0, `trigger=${trigger}`);
      assert.strictEqual(postedBody(result).state, state, `trigger=${trigger}`);
      assert.strictEqual(postedBody(result).event, "PostCompact", `trigger=${trigger}`);
    }
  });

  it("never emits a permission decision for tool events (state-only)", () => {
    const result = runMinimaxHook({
      session_id: "sess-perm",
      cwd: "/tmp/project",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
    });
    assert.strictEqual(result.stdout.trim(), "{}");
    const body = postedBody(result);
    assert.strictEqual(body.decision, undefined);
    assert.strictEqual(body.permissionDecision, undefined);
    assert.strictEqual(body.hookSpecificOutput, undefined);
  });

  it("does not register PermissionRequest (unmapped events answer {} without a POST)", () => {
    const result = runMinimaxHook({
      session_id: "sess-permreq",
      cwd: "/tmp/project",
      hook_event_name: "PermissionRequest",
    }, { httpContract: "expect-none" });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim(), "{}");
    assert.ok(!result.attempts.some((attempt) => attempt.kind === "request"));
  });

  it("namespaces the session id with the minimax: prefix", () => {
    const result = runMinimaxHook({
      session_id: "sess-abc-1",
      cwd: "/tmp/project",
      hook_event_name: "UserPromptSubmit",
      prompt: "帮我写个倒计时组件",
    });

    assert.strictEqual(result.status, 0);
    const body = postedBody(result);
    assert.strictEqual(body.agent_id, "minimax");
    assert.strictEqual(body.session_id, "minimax:sess-abc-1");
    assert.strictEqual(body.cwd, "/tmp/project");
    assert.strictEqual(body.session_title, "帮我写个倒计时组件");
  });

  it("skips the POST entirely when the session id is missing or blank", () => {
    for (const missing of [undefined, "", "   ", "default"]) {
      const result = runMinimaxHook({
        session_id: missing,
        cwd: "/tmp/project",
        hook_event_name: "UserPromptSubmit",
        prompt: "没有 session 的事件",
      }, { httpContract: "expect-none" });

      assert.strictEqual(result.status, 0, `session_id=${JSON.stringify(missing)}`);
      assert.strictEqual(result.stdout.trim(), "{}", `session_id=${JSON.stringify(missing)}`);
    }
  });

  it("answers MiniMax immediately even when the POST is blocked (offline)", () => {
    const result = runMinimaxHook({
      session_id: "sess-abc-4",
      cwd: "/tmp/project",
      hook_event_name: "PreToolUse",
    }, { httpContract: "block" });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim(), "{}");
  });
});

describe("minimax hook agent process detection", () => {
  const { AGENT_NAMES, RESOLVER_OPTIONS, isMinimaxAgentCommandLine } = __test;

  it("checks the command line under the shared default process names", () => {
    // Passing no list keeps MiniMax on DEFAULT_AGENT_CMDLINE_NAMES, which
    // covers node / node.exe and, on Linux, the names newer Node gives its
    // main thread (MainThread / node-MainThread). A list of its own would
    // replace that default and go stale.
    assert.ok(!("agentCmdlineNames" in RESOLVER_OPTIONS), "MiniMax must use the shared default names");
    assert.strictEqual(RESOLVER_OPTIONS.agentCmdlineCheck, isMinimaxAgentCommandLine);
  });

  it("lists only lowercase process names (the resolver compares lowercased basenames)", () => {
    for (const [platform, names] of Object.entries(AGENT_NAMES)) {
      for (const name of names) {
        assert.strictEqual(name, name.toLowerCase(), `${platform}: ${name} can never match`);
      }
    }
    assert.ok(AGENT_NAMES.mac.includes("minimax code"), "the desktop app must be recognizable on macOS");
    assert.ok(AGENT_NAMES.win.includes("minimax code.exe"), "the desktop app must be recognizable on Windows");
    // The CLI sets process.title = "minimax-code" at startup (mcode 0.5.4).
    assert.ok(AGENT_NAMES.mac.includes("minimax-code"), "the retitled CLI must be recognizable on macOS");
    assert.ok(AGENT_NAMES.linux.includes("minimax-code"), "the retitled CLI must be recognizable on Linux");
    // The NodeService helper that spawns the hooks can restart while the app
    // keeps running; matching it would retire live desktop sessions. The walk
    // must reach the long-lived main app instead.
    for (const names of Object.values(AGENT_NAMES)) {
      assert.ok(!names.some((name) => name.includes("helper")), `helper process listed: ${names}`);
    }
  });

  it("recognizes the mcode CLI command lines and nothing merely similar", () => {
    const matches = [
      "node /Users/me/.nvm/versions/node/v24.18.0/bin/mcode exec hi",
      "/usr/local/bin/node /usr/local/lib/node_modules/@minimax-ai/code/cli.js",
      "node /Users/me/.minimax-code/releases/0.5.4/cli.js",
      String.raw`"C:\Program Files\nodejs\node.exe" "C:\Users\me\AppData\Roaming\npm\node_modules\@minimax-ai\code\cli.js"`,
      String.raw`C:\Users\me\AppData\Roaming\npm\mcode.cmd`,
      String.raw`"C:\Users\me\AppData\Roaming\npm\mcode.cmd" exec hi`,
      "minimax-code",
      // The script argument is what identifies the CLI, not a directory that
      // merely appears somewhere in the line.
      "node --max-old-space-size=4096 /usr/local/lib/node_modules/@minimax-ai/code/cli.js exec hi",
      String.raw`"C:\Program Files\nodejs\node.exe" --no-warnings "C:\Users\me\AppData\Roaming\npm\node_modules\@minimax-ai\code\cli.js" exec`,
      "node -- /Users/me/.minimax-code/releases/0.5.4/cli.js",
      "node /usr/local/lib/node_modules/@minimax-ai/code/cli.js\n",
      // Single quotes are literal on POSIX and on Windows, so a path with an
      // apostrophe must not be swallowed as if quoted.
      "/Users/o'brien/.nvm/versions/node/v24.18.0/bin/node /Users/o'brien/.nvm/versions/node/v24.18.0/lib/node_modules/@minimax-ai/code/cli.js exec",
      String.raw`C:\Users\O'Brien\AppData\Roaming\npm\node.exe C:\Users\O'Brien\AppData\Roaming\npm\node_modules\@minimax-ai\code\cli.js exec`,
    ];
    const misses = [
      "node server.js --label mcode",
      "node /work/@minimax-ai/code-review/index.js",
      "node /work/mcode/server.js",
      "node /tmp/minimax-code-clipboard-1234/paste.js",
      "node /usr/local/bin/mcode-tools convert",
      "node /Users/me/mcode-project/server.js",
      "node /Users/me/src/mcode.json.js",
      "node /Users/me/.nvm/versions/node/v24.18.0/bin/gemini",
      "node server.js --config=/work/@minimax-ai/code/config.json",
      "node server.js /work/.minimax-code/demo.js",
      "node -e \"require('/x/@minimax-ai/code/cli.js')\"",
      "node --require /x/@minimax-ai/code/preload.js server.js",
      "bash -c 'node /x/@minimax-ai/code/cli.js'",
      "",
      undefined,
    ];
    for (const cmd of matches) assert.strictEqual(isMinimaxAgentCommandLine(cmd), true, cmd);
    for (const cmd of misses) assert.strictEqual(isMinimaxAgentCommandLine(cmd), false, String(cmd));
  });

  // Stands in for the real CLI and spawns the hook the way MiniMax's plugin
  // runner does (exec-form, no shell), then returns the hook's POST body.
  // execArgv forwards the harness's HTTP recorder; that recorder is also
  // preloaded in the launcher and dumps its own empty recording on exit, so
  // the launcher hands the hook's recording back to it last.
  function postedBodyUnderLauncher({ retitle }) {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-minimax-launcher-"));
    const launcher = path.join(dir, "bin", "mcode");
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, [
      retitle ? `process.title = ${JSON.stringify(retitle)};` : "",
      "const fs = require(\"node:fs\");",
      "const { spawnSync } = require(\"node:child_process\");",
      "const out = process.env.CLAWD_POST_OUT;",
      "const hookOut = `${out}.hook.json`;",
      `const child = spawnSync(process.execPath, [...process.execArgv, ${JSON.stringify(HOOK_PATH)}], {`,
      "  input: fs.readFileSync(0),",
      "  stdio: [\"pipe\", \"inherit\", \"inherit\"],",
      "  env: { ...process.env, CLAWD_POST_OUT: hookOut },",
      "});",
      "process.on(\"exit\", () => { try { fs.copyFileSync(hookOut, out); } catch {} });",
      "process.exit(child.status == null ? 1 : child.status);",
    ].join("\n"), "utf8");
    try {
      const result = runMinimaxHook({
        session_id: `sess-agent-pid-${retitle || "cmdline"}`,
        cwd: "/tmp/project",
        hook_event_name: "UserPromptSubmit",
        prompt: "hi",
      }, { script: launcher });
      assert.strictEqual(result.status, 0, result.stderr);
      return postedBody(result);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Without an agent pid Clawd cannot retire the session when the CLI exits —
  // MiniMax sends no SessionEnd on exit.
  it("reports the real, retitled mcode CLI (minimax-code) as the agent pid", {
    skip: process.platform === "win32",
  }, () => {
    // mcode 0.5.4 sets process.title = "minimax-code" at startup; on macOS and
    // Linux that is the process name ps reports, so the name list must match.
    const body = postedBodyUnderLauncher({ retitle: "minimax-code" });
    assert.ok(Number.isInteger(body.agent_pid) && body.agent_pid > 1, `agent_pid missing: ${JSON.stringify(body)}`);
  });

  it("reports a node-named mcode process as the agent pid by its command line", {
    skip: process.platform === "win32",
  }, () => {
    // A node process whose command line is `node …/bin/mcode` (the shape the
    // CLI keeps on Windows) is only identifiable through the command line.
    const body = postedBodyUnderLauncher({ retitle: null });
    assert.ok(Number.isInteger(body.agent_pid) && body.agent_pid > 1, `agent_pid missing: ${JSON.stringify(body)}`);
  });
});

describe("minimax hook import safety", () => {
  it("importing the module for __test does not read stdin, write stdout, or exit", () => {
    // The require at the top of this file already exercised this — module
    // import must not start the real lifecycle. Spawn a trivial probe to
    // confirm the file loads without emitting anything on stdout.
    const { spawnSync } = require("node:child_process");
    const probe = spawnSync(
      process.execPath,
      ["-e", `require(${JSON.stringify(HOOK_PATH)}); process.stdout.write("loaded")`],
      { encoding: "utf8", timeout: 5000 }
    );
    assert.strictEqual(probe.status, 0, `probe stderr=${probe.stderr}`);
    assert.strictEqual(probe.stdout, "loaded");
  });
});
