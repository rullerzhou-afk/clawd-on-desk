"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Execute the generated production PowerShell, replacing only OS observations
// and focus side effects. No real windows, processes, clipboard or keys are used.
const fixture = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Collections.Generic;
public class WinFocus {
    public static IntPtr[] TitleWindows = new IntPtr[0];
    public static IntPtr[] PidWindows = new IntPtr[0];
    public static List<long> Focused = new List<long>();
    public static List<uint> EnumeratedPids = new List<uint>();
    public static bool FocusSucceeds = true;
    public static IntPtr GetForegroundWindow() {
        return FocusSucceeds && Focused.Count > 0
            ? new IntPtr(Focused[Focused.Count - 1]) : new IntPtr(999);
    }
    public static void Focus(IntPtr hwnd) { Focused.Add(hwnd.ToInt64()); }
    public static IntPtr[] FindByPidTitles(uint pid, string[] names) {
        if (pid != 4242) throw new Exception("unexpected title lookup PID");
        return names.Length > 0 ? TitleWindows : new IntPtr[0];
    }
    public static IntPtr[] FindVisibleWindowsForPid(uint pid) {
        EnumeratedPids.Add(pid);
        if (pid != 4242) throw new Exception("unrelated PID enumeration");
        return PidWindows;
    }
    public static IntPtr FindConsoleWindowForPid(uint pid) { return IntPtr.Zero; }
}
"@
function Get-Process {
    [CmdletBinding()]
    param([int]$Id, [string]$Name)
    if ($Name) { throw 'must not search unrelated applications' }
    if ($Id -eq 1234) {
        return [pscustomobject]@{ Id = 1234; ProcessName = 'node'; MainWindowHandle = [IntPtr]::Zero }
    }
    if ($Id -ne 4242) { throw 'unexpected process tree lookup' }
    # Deliberately differs from the enumerated window: this must not become
    # an arbitrary fallback when no visible window or several windows exist.
    return [pscustomobject]@{ Id = 4242; ProcessName = $script:editorName; MainWindowHandle = [IntPtr]303 }
}
function Get-CimInstance {
    [CmdletBinding()]
    param($ClassName, $Filter, $OperationTimeoutSec)
    if ($Filter -ne 'ProcessId=1234') { throw 'unexpected parent lookup' }
    return [pscustomobject]@{ ParentProcessId = 4242 }
}
`;

test("Windows editor fallback executes unique-window, ambiguity and cache boundaries", {
  skip: process.platform !== "win32" && "requires Windows PowerShell",
}, async (t) => {
  const focus = require("../src/focus")({});
  const { makeFocusCmd, PS_FOCUS_ADDTYPE, normalizeFocusResultPayload } = focus.__test;
  const resultWriter = PS_FOCUS_ADDTYPE.slice(PS_FOCUS_ADDTYPE.indexOf("function Write-ClawdFocusResult"));
  const cases = [];
  for (const editor of ["Cursor", "Code"]) {
    cases.push(
      { editor, name: "unique project title wins", cwd: ["repo"], titles: [101], windows: [101, 202], reason: "editor-parent-title-match", target: 101, cache: true, confirmed: true },
      { editor, name: "ambiguous project title stays blocked", cwd: ["repo"], titles: [101, 202], windows: [101], reason: "editor-parent-title-ambiguous" },
      { editor, name: "mismatched title raises unique PID window", cwd: ["repo"], windows: [101], reason: "editor-parent-pid-window", target: 101, enumerates: true },
      { editor, name: "failed foreground activation stays unconfirmed", cwd: ["repo"], windows: [101], reason: "editor-parent-pid-window", target: 101, enumerates: true, focusSucceeds: false },
      { editor, name: "mismatched title with multiple windows stays blocked", cwd: ["repo"], windows: [101, 202], reason: "editor-parent-pid-window-ambiguous", enumerates: true },
      { editor, name: "mismatched title with no visible window ignores main handle", cwd: ["repo"], windows: [], reason: "editor-parent-no-title-match", enumerates: true },
      { editor, name: "missing cwd raises unique PID window", cwd: [], windows: [101], reason: "editor-parent-pid-window-no-title", target: 101, enumerates: true },
      { editor, name: "missing cwd with multiple windows stays blocked", cwd: [], windows: [101, 202], reason: "editor-parent-pid-window-ambiguous-no-title", enumerates: true },
      { editor, name: "missing cwd with no visible window ignores main handle", cwd: [], windows: [], reason: "editor-parent-no-title", enumerates: true },
    );
  }
  const handles = (values = []) => `@(${values.map((n) => `[IntPtr]${n}`).join(",")})`;
  const scripts = cases.map((c, i) => `
[WinFocus]::Focused.Clear()
[WinFocus]::EnumeratedPids.Clear()
[WinFocus]::TitleWindows = ${handles(c.titles)}
[WinFocus]::PidWindows = ${handles(c.windows)}
[WinFocus]::FocusSucceeds = $${c.focusSucceeds !== false}
$script:editorName = '${c.editor}'
$global:ClawdFocusWindowCache = @{}
${makeFocusCmd(1234, c.cwd, "fixture-session", null, `case-${i}`)}
[ordered]@{
    focused = @([WinFocus]::Focused.ToArray())
    enumeratedPids = @([WinFocus]::EnumeratedPids.ToArray())
    cached = $global:ClawdFocusWindowCache.ContainsKey('fixture-session')
} | ConvertTo-Json -Compress
`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-editor-focus-"));
  const scriptPath = path.join(dir, "fixture.ps1");
  let output;
  try {
    fs.writeFileSync(scriptPath, `\uFEFF${fixture}\n${resultWriter}\n${scripts.join("\n")}`, "utf8");
    output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
      encoding: "utf8", windowsHide: true, timeout: 30000,
    });
  } finally {
    fs.unlinkSync(scriptPath);
    fs.rmdirSync(dir);
  }
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, cases.length * 2, output);
  for (const [i, c] of cases.entries()) {
    await t.test(`${c.editor}: ${c.name}`, () => {
      assert.ok(lines[i * 2].startsWith("__CLAWD_FOCUS_RESULT__ "));
      const raw = JSON.parse(lines[i * 2].slice("__CLAWD_FOCUS_RESULT__ ".length));
      const effects = JSON.parse(lines[i * 2 + 1]);
      assert.equal(raw.token, `case-${i}`);
      assert.equal(raw.reason, c.reason);
      assert.equal(raw.targetHwnd, c.target ? String(c.target) : null);
      assert.deepEqual(effects.focused, c.target ? [c.target] : []);
      assert.deepEqual(effects.enumeratedPids, c.enumerates ? [4242] : []);
      assert.equal(effects.cached, !!c.cache);
      assert.equal(normalizeFocusResultPayload(raw).confirmed, !!c.confirmed);
    });
  }
});
