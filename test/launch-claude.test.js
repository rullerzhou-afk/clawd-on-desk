"use strict";

const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

const {
  buildClaudeArgs,
  buildTerminalCandidates,
  buildCmdLaunchCommand,
  normalizeClaudeSessionId,
  quoteCmdExecutablePath,
  quoteForPowerShell,
  launchClaudeSession,
} = require("../src/launch-claude");

const WIN_PATH = "C:\\Program Files\\nodejs\\node_modules\\@anthropic\\claude.cmd";

describe("buildClaudeArgs", () => {
  it("normal mode passes no flags", () => {
    assert.deepStrictEqual(buildClaudeArgs("normal"), []);
  });

  it("dangerous mode passes --dangerously-skip-permissions", () => {
    assert.deepStrictEqual(buildClaudeArgs("dangerous"), ["--dangerously-skip-permissions"]);
  });

  it("continue mode passes -c", () => {
    assert.deepStrictEqual(buildClaudeArgs("continue"), ["-c"]);
  });

  it("resume mode passes --resume <sessionId>", () => {
    assert.deepStrictEqual(buildClaudeArgs("resume", "abc123"), ["--resume", "abc123"]);
  });

  it("trims valid resume session IDs", () => {
    assert.deepStrictEqual(buildClaudeArgs("resume", "  019d23d4-f1a9-7633-b9c7-758327137228  "), [
      "--resume",
      "019d23d4-f1a9-7633-b9c7-758327137228",
    ]);
  });

  it("resume-dangerous combines skip-permissions and --resume", () => {
    assert.deepStrictEqual(
      buildClaudeArgs("resume-dangerous", "abc123"),
      ["--dangerously-skip-permissions", "--resume", "abc123"],
    );
  });

  it("resume without a sessionId omits --resume", () => {
    assert.deepStrictEqual(buildClaudeArgs("resume"), []);
    assert.deepStrictEqual(buildClaudeArgs("resume", ""), []);
  });

  it("rejects unsafe resume session IDs before terminal command construction", () => {
    assert.throws(() => buildClaudeArgs("resume", "a b"), /Invalid Claude session ID/);
    assert.throws(() => buildClaudeArgs("resume", 'a" & calc & "b'), /Invalid Claude session ID/);
    assert.throws(() => buildClaudeArgs("resume", "   "), /Invalid Claude session ID/);
  });
});

describe("normalizeClaudeSessionId", () => {
  it("accepts alphanumeric, hyphen, and underscore", () => {
    assert.strictEqual(normalizeClaudeSessionId("abc_DEF-123"), "abc_DEF-123");
  });

  it("rejects non-string session IDs", () => {
    assert.throws(() => normalizeClaudeSessionId(123), TypeError);
  });
});

describe("quoteForPowerShell", () => {
  it("wraps plain strings in single quotes", () => {
    assert.strictEqual(quoteForPowerShell("abc"), "'abc'");
  });

  it("doubles embedded single quotes", () => {
    assert.strictEqual(quoteForPowerShell("a'b"), "'a''b'");
  });

  it("leaves shell metacharacters literal inside single quotes", () => {
    assert.strictEqual(quoteForPowerShell("$(rm); & x"), "'$(rm); & x'");
  });

  it("throws on non-string input", () => {
    assert.throws(() => quoteForPowerShell(123), TypeError);
  });
});

describe("cmd executable quoting", () => {
  it("wraps executable paths in real cmd quotes", () => {
    assert.strictEqual(quoteCmdExecutablePath(WIN_PATH), `"${WIN_PATH}"`);
  });

  it("rejects executable paths containing double quotes", () => {
    assert.throws(() => quoteCmdExecutablePath('bad"path'), TypeError);
  });

  it("builds cmd's outer-quoted command form for paths with spaces", () => {
    const cmdLine = buildCmdLaunchCommand(WIN_PATH, ["--resume", 'x" & calc & "y']);
    assert.ok(cmdLine.startsWith(`""${WIN_PATH}" `));
    assert.ok(cmdLine.endsWith('"'));
    assert.ok(!cmdLine.includes(' & calc & '), "bare & command-chaining must be escaped");
    assert.ok(cmdLine.includes("^&"), "ampersands must be caret-escaped");
  });
});

describe("buildTerminalCandidates - Windows", () => {
  it("orders fallbacks wt -> cmd -> powershell", () => {
    const cands = buildTerminalCandidates("claude", [], "win32");
    assert.deepStrictEqual(cands.map((c) => c.bin), ["wt.exe", "cmd.exe", "powershell.exe"]);
  });

  it("wt.exe uses an argv array, no shell quoting needed", () => {
    const cands = buildTerminalCandidates(WIN_PATH, ["--resume", "sid"], "win32");
    const wt = cands.find((c) => c.bin === "wt.exe");
    assert.deepStrictEqual(wt.args, ["--", WIN_PATH, "--resume", "sid"]);
  });

  it("cmd.exe quotes a claude path with spaces", () => {
    const cands = buildTerminalCandidates(WIN_PATH, [], "win32");
    const cmd = cands.find((c) => c.bin === "cmd.exe");
    const cmdLine = cmd.args[cmd.args.length - 1];
    assert.strictEqual(cmdLine, `""${WIN_PATH}""`);
    assert.deepStrictEqual(cmd.args.slice(0, 4), ["/d", "/v:off", "/s", "/k"]);
    assert.deepStrictEqual(cmd.extraOpts, { shell: false, windowsVerbatimArguments: true });
  });

  it("cmd.exe caret-escapes shell metacharacters in the command string", () => {
    const cands = buildTerminalCandidates("claude", ["--resume", 'x" & calc & "y'], "win32");
    const cmd = cands.find((c) => c.bin === "cmd.exe");
    const cmdLine = cmd.args[cmd.args.length - 1];
    // The raw sequence `" & calc & "` must not survive verbatim. Production
    // resume IDs are also allow-listed before buildTerminalCandidates runs,
    // which avoids npm .cmd shim second-parse hazards.
    assert.ok(!cmdLine.includes(' & calc & '), "bare & command-chaining must be escaped");
    assert.ok(cmdLine.includes("^&"), "ampersands must be caret-escaped");
  });

  it("round-trips a spaced executable path through real cmd.exe", { skip: process.platform !== "win32" }, () => {
    const values = [
      "a&b",
      "%CLAWD_QUOTE_TEST%",
      "!CLAWD_QUOTE_TEST!",
      'x" & echo injected & "y',
    ];
    const cands = buildTerminalCandidates(
      process.execPath,
      ["-p", "JSON.stringify(process.argv.slice(1))", ...values],
      "win32",
    );
    const cmd = cands.find((c) => c.bin === "cmd.exe");
    const cmdLine = cmd.args[cmd.args.length - 1];
    const result = spawnSync("cmd.exe", ["/d", "/v:off", "/s", "/c", cmdLine], {
      encoding: "utf8",
      env: { ...process.env, CLAWD_QUOTE_TEST: 'bad"&echo injected' },
      windowsVerbatimArguments: true,
    });
    const detail = JSON.stringify({
      status: result.status,
      error: result.error && result.error.message,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    assert.strictEqual(result.status, 0, detail);
    assert.deepStrictEqual(JSON.parse(result.stdout.trim()), values, detail);
  });

  it("round-trips a spaced npm-style .cmd shim through real cmd.exe", { skip: process.platform !== "win32" }, () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "launch claude cmd shim-"));
    try {
      const shimPath = path.join(tmpDir, "claude.cmd");
      const echoPath = path.join(tmpDir, "echo-argv.js");
      fs.writeFileSync(echoPath, 'console.log(JSON.stringify(process.argv.slice(2)));\n', "utf8");
      fs.writeFileSync(
        shimPath,
        [
          "@ECHO off",
          "GOTO start",
          ":find_dp0",
          "SET dp0=%~dp0",
          "EXIT /b",
          ":start",
          "SETLOCAL",
          "CALL :find_dp0",
          'SET "_prog=node"',
          'endLocal & goto #_undefined_# 2>NUL || "%_prog%"  "%dp0%echo-argv.js" %*',
          "",
        ].join("\r\n"),
        "utf8",
      );

      const claudeArgs = buildClaudeArgs("resume", "safe_sid-123");
      const cands = buildTerminalCandidates(shimPath, claudeArgs, "win32");
      const cmd = cands.find((c) => c.bin === "cmd.exe");
      const cmdLine = cmd.args[cmd.args.length - 1];
      const result = spawnSync("cmd.exe", ["/d", "/v:off", "/s", "/c", cmdLine], {
        encoding: "utf8",
        windowsVerbatimArguments: true,
      });
      const detail = JSON.stringify({
        status: result.status,
        error: result.error && result.error.message,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      assert.strictEqual(result.status, 0, detail);
      assert.deepStrictEqual(JSON.parse(result.stdout.trim()), claudeArgs, detail);
      assert.throws(() => buildClaudeArgs("resume", 'a" & echo injected & "b'), /Invalid Claude session ID/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("powershell.exe single-quotes path and args, neutralizing injection", () => {
    const cands = buildTerminalCandidates(WIN_PATH, ["--resume", "a'; calc; '"], "win32");
    const ps = cands.find((c) => c.bin === "powershell.exe");
    assert.deepStrictEqual(ps.args.slice(0, 2), ["-NoExit", "-Command"]);
    const psCmd = ps.args[2];
    assert.ok(psCmd.startsWith("& "), "must invoke via the call operator");
    assert.ok(psCmd.includes(`'${WIN_PATH}'`), "path must be single-quoted");
    // The injected `'; calc; '` must have its quotes doubled, not survive raw.
    assert.ok(psCmd.includes("'a''; calc; '''"), "single quotes in sessionId must be doubled");
  });
});

describe("buildTerminalCandidates - macOS", () => {
  it("returns a single osascript candidate with two-layer quoting", () => {
    const cands = buildTerminalCandidates("/usr/local/bin/claude", ["--resume", "s i d"], "darwin");
    assert.strictEqual(cands.length, 1);
    assert.strictEqual(cands[0].bin, "osascript");
    assert.strictEqual(cands[0].args[0], "-e");
    const script = cands[0].args[1];
    assert.ok(script.startsWith('tell application "Terminal" to do script "'));
    // POSIX single-quoting wraps each token; sessionId with spaces stays one arg.
    assert.ok(script.includes("'--resume'"));
    assert.ok(script.includes("'s i d'"));
  });

  it("escapes AppleScript-breaking quotes in the sessionId", () => {
    const cands = buildTerminalCandidates("/usr/local/bin/claude", ["--resume", 'a"b'], "darwin");
    const script = cands[0].args[1];
    // Any double quote from user input must be backslash-escaped for AppleScript.
    assert.ok(script.includes('\\"'), "AppleScript double quotes must be escaped");
  });
});

describe("buildTerminalCandidates - Linux", () => {
  it("offers the documented emulator fallback chain", () => {
    const cands = buildTerminalCandidates("/usr/bin/claude", [], "linux");
    assert.deepStrictEqual(
      cands.map((c) => c.bin),
      ["x-terminal-emulator", "xterm", "gnome-terminal", "konsole", "alacritty", "kitty"],
    );
  });

  it("POSIX-quotes path and args inside the bash -c payload", () => {
    const cands = buildTerminalCandidates("/usr/bin/claude", ["--resume", "s i d"], "linux");
    const first = cands[0];
    const payload = first.args[first.args.length - 1];
    assert.ok(payload.endsWith("; exec bash"), "terminal stays open after claude exits");
    assert.ok(payload.includes("'/usr/bin/claude'"));
    assert.ok(payload.includes("'s i d'"));
  });

  it("neutralizes command injection in the sessionId", () => {
    const cands = buildTerminalCandidates("/usr/bin/claude", ["--resume", "x'; rm -rf ~; '"], "linux");
    const payload = cands[0].args[cands[0].args.length - 1];
    // The sessionId is emitted as exactly one POSIX-quoted token: every `'`
    // becomes the close-escape-reopen idiom `'\''`, so the embedded `; rm`
    // stays literal text inside quotes and can't chain commands.
    assert.ok(payload.includes("'x'\\''; rm -rf ~; '\\'''"), "sessionId must be a single quoted token");
    // The only unquoted `;` in the whole payload is the trailing keep-open one.
    assert.ok(payload.endsWith("; exec bash"));
  });
});

describe("launchClaudeSession - terminal fallback", () => {
  function makeDeps({ plat, okBins, findResult }) {
    const attempted = [];
    return {
      attempted,
      deps: {
        platform: () => plat,
        findClaudeCmd: () => findResult,
        tryLaunch: async (bin, args) => {
          attempted.push({ bin, args });
          if (okBins.includes(bin)) return { ok: true, child: {} };
          return { ok: false, error: new Error(`spawn ${bin} ENOENT`) };
        },
      },
    };
  }

  it("returns the first terminal that spawns (wt)", async () => {
    const { attempted, deps } = makeDeps({ plat: "win32", okBins: ["wt.exe"], findResult: "claude" });
    const res = await launchClaudeSession("normal", undefined, undefined, deps);
    assert.deepStrictEqual(res, { ok: true, terminal: "wt.exe" });
    assert.strictEqual(attempted.length, 1, "should stop after wt succeeds");
  });

  it("falls through wt -> cmd when wt is missing", async () => {
    const { attempted, deps } = makeDeps({ plat: "win32", okBins: ["cmd.exe"], findResult: WIN_PATH });
    const res = await launchClaudeSession("normal", undefined, undefined, deps);
    assert.deepStrictEqual(res, { ok: true, terminal: "cmd.exe" });
    assert.deepStrictEqual(attempted.map((a) => a.bin), ["wt.exe", "cmd.exe"]);
  });

  it("falls all the way through to powershell", async () => {
    const { attempted, deps } = makeDeps({ plat: "win32", okBins: ["powershell.exe"], findResult: "claude" });
    const res = await launchClaudeSession("normal", undefined, undefined, deps);
    assert.deepStrictEqual(res, { ok: true, terminal: "powershell.exe" });
    assert.deepStrictEqual(attempted.map((a) => a.bin), ["wt.exe", "cmd.exe", "powershell.exe"]);
  });

  it("returns ok:false with a message when every terminal fails", async () => {
    const { attempted, deps } = makeDeps({ plat: "win32", okBins: [], findResult: "claude" });
    const res = await launchClaudeSession("normal", undefined, undefined, deps);
    assert.strictEqual(res.ok, false);
    assert.match(res.message, /ENOENT/);
    assert.strictEqual(attempted.length, 3, "should have tried all Windows candidates");
  });

  it("passes the resolved claude path and quoted args through to the terminal", async () => {
    const { attempted, deps } = makeDeps({ plat: "win32", okBins: ["wt.exe"], findResult: WIN_PATH });
    await launchClaudeSession("resume", undefined, "sid_1", deps);
    assert.deepStrictEqual(attempted[0].args, ["--", WIN_PATH, "--resume", "sid_1"]);
  });

  it("rejects unsafe resume IDs before trying any terminal", async () => {
    const { attempted, deps } = makeDeps({ plat: "win32", okBins: ["wt.exe"], findResult: WIN_PATH });
    await assert.rejects(
      launchClaudeSession("resume", undefined, 'sid" & calc & "x', deps),
      /Invalid Claude session ID/,
    );
    assert.deepStrictEqual(attempted, []);
  });
});
