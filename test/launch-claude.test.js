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
  buildShellTerminalCandidates,
  openTerminalAt,
  buildCmdLaunchCommand,
  normalizeClaudeSessionId,
  quoteCmdExecutablePath,
  quoteForPowerShell,
  launchClaudeSession,
  findClaudeCmd,
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

describe("findClaudeCmd", () => {
  const NPM_DIR = "C:\\Users\\Tester\\AppData\\Roaming\\npm";
  // `where`/`which` stub: resolves with the given paths as newline stdout.
  const fakeWhere = (...paths) => ({
    execFileAsync: async () => ({ stdout: paths.join("\r\n") + "\r\n" }),
  });
  // filesystem stub: only the listed paths "exist" (case-insensitive on Windows).
  const fakeFs = (existing) => {
    const set = new Set(existing.map((p) => String(p).toLowerCase()));
    return { existsSync: (p) => set.has(String(p).toLowerCase()) };
  };

  it("Windows: prefers claude.cmd when `where` lists the extensionless script first", async () => {
    const ext = `${NPM_DIR}\\claude`;
    const cmd = `${NPM_DIR}\\claude.cmd`;
    const out = await findClaudeCmd("win32", { ...fakeWhere(ext, cmd), ...fakeFs([ext, cmd]) });
    assert.strictEqual(out, cmd, "must not return the 0x800700c1 POSIX shim");
  });

  it("Windows: never returns the extensionless POSIX shim, probing for a sibling", async () => {
    // `where` surfaced only the unrunnable script; its launchable sibling is
    // right next to it. Returning `ext` here is the exact #435 bug.
    const ext = `${NPM_DIR}\\claude`;
    const cmd = `${NPM_DIR}\\claude.cmd`;
    const out = await findClaudeCmd("win32", { ...fakeWhere(ext), ...fakeFs([ext, cmd]) });
    assert.strictEqual(out, cmd);
  });

  it("Windows: prefers a real claude.exe over the .cmd shim", async () => {
    const exe = `${NPM_DIR}\\claude.exe`;
    const cmd = `${NPM_DIR}\\claude.cmd`;
    const out = await findClaudeCmd("win32", { ...fakeWhere(exe, cmd), ...fakeFs([exe, cmd]) });
    assert.strictEqual(out, exe);
  });

  it("Windows: falls back to %APPDATA%\\npm\\claude.cmd when PATH lookup misses", async () => {
    const prev = process.env.APPDATA;
    process.env.APPDATA = "C:\\Users\\Tester\\AppData\\Roaming";
    try {
      const cmd = path.join(process.env.APPDATA, "npm", "claude.cmd");
      const out = await findClaudeCmd("win32", {
        execFileAsync: async () => { throw new Error("where: not found"); },
        ...fakeFs([cmd]),
      });
      assert.strictEqual(out, cmd);
    } finally {
      if (prev === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = prev;
    }
  });

  it("Windows: returns bare \"claude\" when nothing is found", async () => {
    const out = await findClaudeCmd("win32", {
      execFileAsync: async () => ({ stdout: "" }),
      existsSync: () => false,
    });
    assert.strictEqual(out, "claude");
  });

  it("Windows: passes through to stage 3 when only an extensionless shim exists (no sibling)", async () => {
    // No launchable variant anywhere — must NOT return the unrunnable script;
    // falls through to bare \"claude\" for cmd.exe/PATHEXT to resolve.
    const ext = `${NPM_DIR}\\claude`;
    const out = await findClaudeCmd("win32", { ...fakeWhere(ext), ...fakeFs([ext]) });
    assert.strictEqual(out, "claude");
  });

  it("Windows: matches launchable extensions case-insensitively", async () => {
    const cmd = `${NPM_DIR}\\CLAUDE.CMD`;
    const out = await findClaudeCmd("win32", { ...fakeWhere(cmd), ...fakeFs([cmd]) });
    assert.strictEqual(out, cmd);
  });

  it("POSIX: returns the first existing `which` result", async () => {
    const p = "/usr/local/bin/claude";
    const out = await findClaudeCmd("linux", { ...fakeWhere(p), ...fakeFs([p]) });
    assert.strictEqual(out, p);
  });

  it("does not block synchronously on the PATH probe (async findClaudeCmd)", async () => {
    // Regression for #8: a slow `where`/`which` must not freeze the caller.
    // The probe resolves on a later tick; findClaudeCmd must await it rather
    // than returning before the result is in.
    const cmd = `${NPM_DIR}\\claude.cmd`;
    let resolveProbe;
    const gate = new Promise((r) => { resolveProbe = r; });
    const pending = findClaudeCmd("win32", {
      execFileAsync: () => gate.then(() => ({ stdout: cmd + "\r\n" })),
      ...fakeFs([cmd]),
    });
    assert.ok(pending instanceof Promise, "findClaudeCmd must be async");
    resolveProbe();
    assert.strictEqual(await pending, cmd);
  });
});

describe("buildTerminalCandidates - Windows", () => {
  it("orders fallbacks wt -> cmd -> powershell", () => {
    const cands = buildTerminalCandidates("claude", [], "win32");
    assert.deepStrictEqual(cands.map((c) => c.bin), ["wt.exe", "cmd.exe", "powershell.exe"]);
  });

  it("wt.exe routes through cmd.exe so Windows Terminal never execs a .cmd shim directly", () => {
    const cands = buildTerminalCandidates(WIN_PATH, ["--resume", "sid"], "win32");
    const wt = cands.find((c) => c.bin === "wt.exe");
    assert.deepStrictEqual(wt.args, [
      "--", "cmd.exe", "/d", "/v:off", "/k", "call", `"${WIN_PATH}"`, "--resume", "sid",
    ]);
    // `call` keeps cmd's /K from stripping the leading quote; verbatim keeps the
    // Node->wt hop from re-quoting. WT's own re-tokenization needs real Windows.
    assert.deepStrictEqual(wt.extraOpts, { shell: false, windowsVerbatimArguments: true });
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

  it("round-trips a spaced + parenthesized .cmd shim through wt's cmd.exe layer", { skip: process.platform !== "win32" }, () => {
    // Dir name carries BOTH a space and cmd-special chars `()` — the exact shape
    // (`Program Files (x86)`) that strips quotes under plain `/k "..."`. The
    // `call` prefix is what keeps it intact.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "launch (x86) claude wt shim-"));
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
      const wt = cands.find((c) => c.bin === "wt.exe");
      // Covers the cmd.exe SIDE only: given the tokens delivered faithfully, does
      // `cmd /c call "<path>" <args>` run the shim and forward argv? It does NOT
      // exercise Windows Terminal's own commandline re-tokenization/re-quoting —
      // that layer needs a real wt.exe launch on Windows. Here we drop "--", swap
      // /k -> /c so cmd exits, and feed the tokens to cmd.exe verbatim.
      const inner = wt.args.slice(1).map((a) => (a === "/k" ? "/c" : a));
      const result = spawnSync(inner[0], inner.slice(1), {
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

  it("prefixes an explicit cd -- <workDir> when a working directory is given (#459)", () => {
    // Terminal.app `do script` shells start at $HOME and ignore spawn cwd, so
    // the folder must live inside the command itself.
    const cands = buildTerminalCandidates("/usr/local/bin/claude", [], "darwin", "/Users/me/proj dir");
    const script = cands[0].args[1];
    assert.ok(script.includes("cd -- '/Users/me/proj dir' && "), script);
  });

  it("omits the cd prefix when no working directory is given", () => {
    const cands = buildTerminalCandidates("/usr/local/bin/claude", [], "darwin");
    const script = cands[0].args[1];
    assert.ok(!script.includes("cd -- "), script);
  });
});

describe("buildShellTerminalCandidates (#459)", () => {
  it("win32: wt -d first, then cmd cd /d as one pre-quoted string, then PS -LiteralPath", () => {
    const dir = "C:\\My Projects\\app";
    const cands = buildShellTerminalCandidates(dir, "win32");
    assert.deepStrictEqual(cands.map((c) => c.bin), ["wt.exe", "cmd.exe", "powershell.exe"]);
    // wt -d relies on Node's default arg quoting; no verbatim args.
    assert.deepStrictEqual(cands[0].args, ["-d", dir]);
    assert.strictEqual(cands[0].extraOpts, undefined);
    // cmd: the /k payload is ONE pre-quoted string and must not start with a quote.
    const cmdPayload = cands[1].args[cands[1].args.length - 1];
    assert.strictEqual(cmdPayload, 'cd /d "C:\\My Projects\\app"');
    assert.strictEqual(cands[1].extraOpts.windowsVerbatimArguments, true);
    const psPayload = cands[2].args[cands[2].args.length - 1];
    assert.strictEqual(psPayload, "Set-Location -LiteralPath 'C:\\My Projects\\app'");
  });

  it("win32: -LiteralPath keeps glob characters literal", () => {
    const cands = buildShellTerminalCandidates("C:\\dir[1]", "win32");
    const psPayload = cands[2].args[cands[2].args.length - 1];
    assert.strictEqual(psPayload, "Set-Location -LiteralPath 'C:\\dir[1]'");
  });

  it("win32: rejects directories containing double quotes", () => {
    assert.throws(
      () => buildShellTerminalCandidates('C:\\evil" & calc & "', "win32"),
      /double quotes/,
    );
  });

  it("win32: a %-containing dir skips the cmd.exe candidate (no command-line escape exists)", () => {
    const cands = buildShellTerminalCandidates("C:\\100% done", "win32");
    assert.deepStrictEqual(cands.map((c) => c.bin), ["wt.exe", "powershell.exe"]);
    // The survivors both pass the path literally.
    assert.deepStrictEqual(cands[0].args, ["-d", "C:\\100% done"]);
    assert.strictEqual(
      cands[1].args[cands[1].args.length - 1],
      "Set-Location -LiteralPath 'C:\\100% done'",
    );
  });

  it("win32: `!` and `^ &` dirs keep the cmd.exe candidate (/v:off + quotes make them literal)", () => {
    const cands = buildShellTerminalCandidates("C:\\bang!dir & spec^ial", "win32");
    assert.deepStrictEqual(cands.map((c) => c.bin), ["wt.exe", "cmd.exe", "powershell.exe"]);
    const cmd = cands[1];
    assert.ok(cmd.args.includes("/v:off"), "delayed expansion must stay disabled");
    assert.strictEqual(cmd.args[cmd.args.length - 1], 'cd /d "C:\\bang!dir & spec^ial"');
  });

  it("round-trips a spaced/special dir through real cmd.exe cd", { skip: process.platform !== "win32" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd drop & test^ "));
    try {
      const cands = buildShellTerminalCandidates(dir, "win32");
      const cmd = cands.find((c) => c.bin === "cmd.exe");
      assert.ok(cmd, "non-% dir must keep the cmd candidate");
      const payload = cmd.args[cmd.args.length - 1];
      const result = spawnSync("cmd.exe", ["/d", "/v:off", "/s", "/c", `${payload} && cd`], {
        encoding: "utf8",
        windowsVerbatimArguments: true,
      });
      assert.strictEqual(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }));
      assert.strictEqual(result.stdout.trim(), dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("darwin: single osascript candidate with explicit cd -- and two-layer quoting", () => {
    const cands = buildShellTerminalCandidates("/Users/me/proj dir", "darwin");
    assert.strictEqual(cands.length, 1);
    assert.strictEqual(cands[0].bin, "osascript");
    const script = cands[0].args[1];
    assert.ok(script.startsWith('tell application "Terminal" to do script "'), script);
    assert.ok(script.includes("cd -- '/Users/me/proj dir' && clear"), script);
  });

  it("darwin: survives single quotes in the directory name", () => {
    const cands = buildShellTerminalCandidates("/tmp/it's here", "darwin");
    const script = cands[0].args[1];
    assert.ok(script.includes("cd -- "), script);
    assert.ok(!script.includes("'/tmp/it's here'"), "naive single-quoting must not survive");
  });

  it("linux: documented emulator chain, command only keeps a shell alive", () => {
    const cands = buildShellTerminalCandidates("/tmp/x", "linux");
    assert.deepStrictEqual(
      cands.map((c) => c.bin),
      ["x-terminal-emulator", "xterm", "gnome-terminal", "konsole", "alacritty", "kitty"],
    );
    for (const c of cands) assert.strictEqual(c.args[c.args.length - 1], "exec bash");
  });
});

describe("openTerminalAt (#459)", () => {
  it("walks the candidate chain and passes the directory as spawn cwd", async () => {
    const launches = [];
    const result = await openTerminalAt("/tmp/proj", {
      platform: () => "linux",
      tryLaunch: async (bin, args, opts) => {
        launches.push([bin, opts.cwd, opts.detached]);
        if (launches.length < 2) return { ok: false, error: new Error("not installed") };
        return { ok: true };
      },
    });
    assert.deepStrictEqual(result, { ok: true, terminal: "xterm" });
    assert.strictEqual(launches.length, 2);
    for (const [, cwd, detached] of launches) {
      assert.strictEqual(cwd, "/tmp/proj");
      assert.strictEqual(detached, true);
    }
  });

  it("reports the last error when every candidate fails", async () => {
    const result = await openTerminalAt("/tmp/proj", {
      platform: () => "darwin",
      tryLaunch: async () => ({ ok: false, error: new Error("osascript missing") }),
    });
    assert.deepStrictEqual(result, { ok: false, message: "osascript missing" });
  });

  it("rejects an empty directory without spawning", async () => {
    let launched = false;
    const result = await openTerminalAt("", {
      tryLaunch: async () => { launched = true; return { ok: true }; },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(launched, false);
  });

  it("turns a win32 double-quote rejection into a failed result, not a throw", async () => {
    const result = await openTerminalAt('C:\\evil" & calc', {
      platform: () => "win32",
      tryLaunch: async () => ({ ok: true }),
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /double quotes/);
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
    assert.deepStrictEqual(attempted[0].args, [
      "--", "cmd.exe", "/d", "/v:off", "/k", "call", `"${WIN_PATH}"`, "--resume", "sid_1",
    ]);
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
