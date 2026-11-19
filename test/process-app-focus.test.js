"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { focusProcessAppWindow, windowsProcessAppScript, macCodexProcessTarget } = require("../src/process-app-focus");

it("Windows app focus only walks live PID ancestors and never executes generic fallback selectors", async () => {
  const calls = [];
  const result = await focusProcessAppWindow({ sourcePid: 731, cwd: "C:/decoy", wtHwnd: 123, pidChain: [999] }, {
    platform: "win32", windowsActivationCode: "// existing WinFocus interop\n",
    execFile: (bin, args, options, done) => { calls.push({ bin, args, options }); done(null, '{"confirmed":true,"reason":"process-window"}'); },
  });
  assert.equal(result.confirmed, true); assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, "powershell.exe"); assert.equal(calls[0].options.windowsHide, true);
  const script = calls[0].args.at(-1);
  assert.match(script, /GetWindowThreadProcessId/); assert.match(script, /ParentProcessId/);
  for (const forbidden of ["C:/decoy", "999", "GetWindowText", "Get-ClawdCachedWindow", "FindConsoleWindow", "Start-Process", "codex://", "launchClaude", "wtHwndFromHook"]) assert.equal(script.includes(forbidden), false, forbidden);
});

it("missing/dead app process returns failure without a launcher or a second attempt", async () => {
  let calls = 0;
  const options = { platform: "win32", execFile: (_bin, _args, _opts, done) => { calls++; done(null, '{"confirmed":false,"reason":"no-process-window"}'); } };
  assert.equal((await focusProcessAppWindow({}, options)).reason, "no-source-pid"); assert.equal(calls, 0);
  assert.equal((await focusProcessAppWindow({ sourcePid: 731 }, options)).confirmed, false); assert.equal(calls, 1);
  assert.throws(() => windowsProcessAppScript("731; injected"));
});

const macRows = (source = "/Applications/Codex.app/Contents/Resources/codex", target = "/Applications/Codex.app/Contents/MacOS/Codex") =>
  `731 732 Sat Oct 24 12:01:00 2026 ${source}\n732 1 Sat Oct 24 12:00:00 2026 ${target}\n`;

it("macOS activates the verified outer bundle through LaunchServices after rechecking both identities", async () => {
  const calls = [];
  const result = await focusProcessAppWindow({ sourcePid: 731, pidChain: [999], cwd: "/decoy" }, {
    platform: "darwin", execFile: (bin, args, options, done) => {
      calls.push([bin, args]); done(null, bin === "ps" ? macRows() : "activated\n");
    },
  });
  assert.equal(result.submitted, true); assert.equal(result.confirmed, false, "no claim of exact composer or foreground confirmation");
  assert.deepEqual(calls.map(x => x[0]), ["ps", "ps", "/usr/bin/open"]);
  assert.deepEqual(calls[0][1], ["-ww", "-axo", "pid=,ppid=,lstart=,comm="]);
  assert.deepEqual(calls[1][1], calls[0][1]);
  assert.deepEqual(calls[2][1], ["/Applications/Codex.app"]);
  assert.equal(result.reason, "app-activation-submitted");
});

it("macOS validates the real hook's GUI source and server agent pair without accepting unrelated PID hints", async () => {
  for (const request of [
    { sourcePid: 732, agentPid: 731 }, // Native hook's GUI anchor + app-server.
    { sourcePid: 731, agentPid: 731 }, // Explicit Desktop provenance.
    { sourcePid: 731 }, // Older entry with only the server anchor.
  ]) {
    const calls = [];
    const result = await focusProcessAppWindow(request, { platform: "darwin",
      execFile(bin, args, _options, done) { calls.push([bin, args]); done(null, bin === "ps" ? macRows() : "activated\n"); },
    });
    assert.equal(result.submitted, true);
    assert.deepEqual(calls.map(call => call[0]), ["ps", "ps", "/usr/bin/open"]);
  }
  for (const request of [
    { sourcePid: 999, agentPid: 731 }, // Valid server cannot authorize an unrelated source.
    { sourcePid: 731, agentPid: 999 }, // Wrong/dead agent cannot fall back to a different PID.
    { sourcePid: 732, agentPid: 732 }, // GUI is not an app-server.
    { sourcePid: 732 }, // Missing agent on a GUI anchor is not enough proof.
  ]) {
    const calls = [];
    const result = await focusProcessAppWindow(request, { platform: "darwin",
      execFile(bin, _args, _options, done) { calls.push(bin); done(null, macRows()); },
    });
    assert.equal(result.reason, "unverified-codex-process");
    assert.deepEqual(calls, ["ps"]);
  }
});

it("macOS birth/image/parent recheck cannot activate after the server or GUI identity changes", async () => {
  for (const changedRows of [
    macRows().replace("12:01:00", "12:03:00"),
    macRows().replace("12:00:00", "11:59:00"),
    macRows().replace("731 732", "731 999"),
    macRows().replace("732 1", "732 999"),
    macRows().replaceAll("Codex.app", "Changed.app"),
    macRows().split("\n")[0],
  ]) {
    const calls = [];
    const result = await focusProcessAppWindow({ sourcePid: 732, agentPid: 731 }, { platform: "darwin",
      execFile(bin, args, _options, done) {
        calls.push([bin, args]);
        assert.equal(bin, "ps", "a changed process must never reach open");
        done(null, calls.length === 1 ? macRows() : changedRows);
      },
    });
    assert.notEqual(result.submitted, true); assert.equal(result.confirmed, false);
    assert.equal(result.reason, "process-changed"); assert.equal(calls.length, 2);
  }
});

it("macOS reused PIDs, CLI binaries, other bundles, terminals, and younger parents cannot activate", async () => {
  for (const rows of [
    macRows("/usr/local/bin/codex"),
    macRows("/Applications/Other.app/Contents/Resources/codex"),
    macRows(undefined, "/Applications/Other/Codex.app/Contents/MacOS/Codex"),
    macRows(undefined, "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"),
    macRows(undefined, "/Applications/Visual Studio Code.app/Contents/MacOS/Electron"),
    macRows("/Applications/Codex.app.evil/Contents/Resources/codex"),
    macRows("/Applications/Codex.app/Contents/Resources/../../../../usr/local/bin/codex"),
    macRows("/Applications/Codex.app/Contents/Resources/../codex"),
    macRows(undefined, "/Applications/Codex.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper"),
    macRows(undefined, "/Applications/Codex.app/Contents/MacOS/helpers/GUI"),
    macRows().replace("12:00:00", "12:02:00"),
    "731 732\n732 1\n", "",
  ]) {
    assert.equal(macCodexProcessTarget(731, rows), null);
    const calls = [];
    const result = await focusProcessAppWindow({ sourcePid: 731 }, {
      platform: "darwin", execFile: (bin, _args, _options, done) => { calls.push(bin); done(null, rows); },
    });
    assert.equal(result.reason, "unverified-codex-process"); assert.deepEqual(calls, ["ps"]);
  }
});

it("macOS accepts nested helpers and renamed outer bundles without activating the inner app", async () => {
  for (const bundle of ["/Applications/ChatGPT.app", "/Users/fixture/Apps/Work Assistant.app", '/Applications/A "quoted" app.app']) {
    const rows = macRows(`${bundle}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`, `${bundle}/Contents/MacOS/ChatGPT`);
    assert.equal(macCodexProcessTarget(731, rows).bundlePath, bundle);
    const calls = [];
    const result = await focusProcessAppWindow({sourcePid:732,agentPid:731}, {platform:"darwin",
      execFile(bin,args,opts,done) { calls.push({bin,args,opts}); done(null,bin === "ps" ? rows : ""); },
    });
    assert.equal(result.submitted,true);assert.equal(result.confirmed,false);
    assert.deepEqual(calls.map(c=>c.bin),["ps","ps","/usr/bin/open"]);
    assert.deepEqual(calls[2].args,[bundle],"absolute path is a single argv, not a script or innermost helper");
    for (const call of calls.slice(0,2)) assert.equal(call.opts.env.LC_ALL,"C");
    assert.equal(calls.some(c=>/osascript|System Events/.test(c.bin)),false);
  }
});

it("macOS failed recheck or LaunchServices submission has no System Events, URI, CLI or other fallback", async () => {
  for (const failAt of [1,2,3]) {
    const calls = [];
    const result = await focusProcessAppWindow({sourcePid:732,agentPid:731}, {platform:"darwin",
      execFile(bin,args,_opts,done) {
        calls.push({bin,args});
        done(calls.length === failAt ? new Error("fixture failure") : null,bin === "ps" ? macRows() : "");
      },
    });
    assert.equal(result.confirmed,false);assert.notEqual(result.submitted,true);
    assert.equal(calls.length,failAt);
    assert.equal(result.reason,failAt === 3 ? "process-focus-failed" : "process-query-failed");
  }
});

it("Linux has no verified Desktop layout and fails without invoking any process/window tools", async () => {
  const result = await focusProcessAppWindow({ sourcePid: 731 }, {
    platform: "linux", execFile: () => { throw new Error("no Linux activation contract"); },
  });
  assert.equal(result.reason, "unsupported-platform");
});

// Execute the generated PowerShell against fixtures only. All CIM/process and
// WinFocus methods are replaced; this test cannot query or focus a real app.
const serverImage = "C:\\Users\\fixture\\AppData\\Local\\OpenAI\\Codex\\bin\\0123456789abcdef\\codex.exe";
const guiImage = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1023.1.0_x64__fixture123\\app\\ChatGPT.exe";
function windowsRows() {
  return [
    { ProcessId: 731, ParentProcessId: 732, ExecutablePath: serverImage, CommandLine: `"${serverImage}" app-server --stdio`, CreationDate: "2026-10-24T12:01:00Z" },
    { ProcessId: 732, ParentProcessId: 1, ExecutablePath: guiImage, CommandLine: `"${guiImage}"`, CreationDate: "2026-10-24T12:00:00Z" },
  ];
}
function runWindowsFixture(rows, replacement = null) {
  const fixtures = JSON.stringify({ rows, replacement }).replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = 'C:\\Users\\fixture\\AppData\\Local'
$env:ProgramFiles = 'C:\\Program Files'
$fixture = '${fixtures}' | ConvertFrom-Json
$script:queries = @{}
function Get-CimInstance($ClassName, $Filter, $OperationTimeoutSec, $ErrorAction) {
  $queryPid = [int]($Filter -replace '^ProcessId=', '')
  $script:queries[$queryPid] += 1
  $row = $fixture.rows | Where-Object { $_.ProcessId -eq $queryPid } | Select-Object -First 1
  if ($fixture.replacement -and $fixture.replacement.ProcessId -eq $queryPid -and $script:queries[$queryPid] -gt 1) { $row = $fixture.replacement }
  if ($row) { if ($row.CreationDate) { $row.CreationDate = [datetime]$row.CreationDate }; return $row }
}
function Get-Process($Id, $ErrorAction) { [pscustomobject]@{MainWindowHandle=[IntPtr]777} }
Add-Type @'
using System;
public class WinFocus {
  public static IntPtr focused = IntPtr.Zero;
  public static bool IsWindowVisible(IntPtr window) { return true; }
  public static uint GetWindowThreadProcessId(IntPtr window, out uint owner) { owner = 732; return 1; }
  public static void Focus(IntPtr window) { focused = window; }
  public static IntPtr GetForegroundWindow() { return focused; }
}
'@
${windowsProcessAppScript(731)}`;
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  return JSON.parse(output.trim());
}

it("Windows generated script accepts the observed Desktop install chain and rejects unknown/reused process identities", { skip: process.platform !== "win32" }, () => {
  assert.equal(runWindowsFixture(windowsRows()).confirmed, true);
  const helperChain = windowsRows();
  helperChain[0].ParentProcessId = 733;
  helperChain.push({ ...helperChain[1], ProcessId: 733, ParentProcessId: 732, CommandLine: `"${guiImage}" --type=utility`, CreationDate: "2026-10-24T12:00:30Z" });
  assert.equal(runWindowsFixture(helperChain).confirmed, true, "only the main GUI is eligible, even across a verified Codex helper");
  const cases = [
    rows => { rows[0].ExecutablePath = "C:\\Tools\\codex.exe"; rows[0].CommandLine = '"C:\\Tools\\codex.exe" app-server'; },
    rows => { rows[0].CommandLine = `"${serverImage}" exec review`; },
    rows => { rows[0].CommandLine = `"${serverImage}" app-server-decoy`; },
    rows => { rows[0].ExecutablePath = "C:\\Tools\\browser.exe"; rows[0].CommandLine = '"C:\\Tools\\browser.exe"'; },
    rows => { rows[0].ExecutablePath = null; },
    rows => { rows[1].ExecutablePath = "C:\\Tools\\ChatGPT.exe"; rows[1].CommandLine = '"C:\\Tools\\ChatGPT.exe"'; },
    rows => { rows[1].ExecutablePath = "C:\\Windows\\explorer.exe"; rows[1].CommandLine = '"C:\\Windows\\explorer.exe"'; },
    rows => { rows[1].ExecutablePath = "C:\\Tools\\Code.exe"; rows[1].CommandLine = '"C:\\Tools\\Code.exe"'; },
    rows => { rows[1].ExecutablePath = "C:\\Tools\\WindowsTerminal.exe"; rows[1].CommandLine = '"C:\\Tools\\WindowsTerminal.exe"'; },
    rows => { rows[1].CommandLine += " --type=renderer"; },
    rows => { rows[1].CreationDate = "2026-10-24T12:02:00Z"; },
    rows => { rows[1].CreationDate = null; },
    rows => { rows.splice(0, 1); },
  ];
  for (const mutate of cases) {
    const rows = windowsRows(); mutate(rows);
    assert.equal(runWindowsFixture(rows).confirmed, false, mutate.toString());
  }
  const replacement = { ...windowsRows()[0], CreationDate: "2026-10-24T12:03:00Z" };
  assert.equal(runWindowsFixture(windowsRows(), replacement).confirmed, false, "source instance changed during the walk");
});

// Fixture encoder only: production parsing delegates to CommandLineToArgvW.
const quoteWindowsArg = value => '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';

it("Windows Desktop app-server recognizes argv after global config flags without trusting prompt/config substrings", { skip: process.platform !== "win32" }, () => {
  const executable = quoteWindowsArg(serverImage);
  const quotedConfig = quoteWindowsArg('model="fixture model"');
  const escapedConfig = quoteWindowsArg('fixture="quoted \\"app-server\\" and C:\\fixture path\\"');
  const accepted = [
    `${executable} -c model=fixture app-server --stdio`,
    `${executable} -c ${quotedConfig} app-server --stdio`,
    `${executable} --config ${escapedConfig} app-server`,
    `${executable} -c ${quotedConfig} --config ${quoteWindowsArg('fixture="app-server"')} app-server`,
    `${executable} ${quoteWindowsArg('--config=model="fixture model"')} app-server`,
  ];
  for (const commandLine of accepted) {
    const rows = windowsRows(); rows[0].CommandLine = commandLine;
    assert.equal(runWindowsFixture(rows).confirmed, true, "valid global config prefix must preserve app-server routing");
  }
  const rejected = [
    `${executable} exec ${quoteWindowsArg('app-server')}`,
    `${executable} -c ${quotedConfig} exec ${quoteWindowsArg('pretend this is app-server')}`,
    `${executable} -c ${quoteWindowsArg('fixture="app-server"')}`,
    `${executable} -c app-server`,
    `${executable} --config=app-server`,
    `${executable} -c`,
    `${executable} --config= app-server`,
    `${executable} -c "" app-server`,
    `${executable} --unknown app-server`,
    `${executable} -c ${quotedConfig} app-server-decoy`,
    `${executable}suffix app-server`,
  ];
  for (const commandLine of rejected) {
    const rows = windowsRows(); rows[0].CommandLine = commandLine;
    assert.equal(runWindowsFixture(rows).confirmed, false, "only the first subcommand after complete known global config flags can authorize activation");
  }
});
