"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Execute the generated production PowerShell, replacing only OS observations
// and focus side effects. No real windows or processes are touched.
const fixture = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Collections.Generic;
public class WinFocus {
    public static IntPtr[] TitleWindows = new IntPtr[0];
    public static IntPtr[] VisiblePidWindows = new IntPtr[0];
    public static uint[] ProbePids = new uint[0];
    public static long[] ProbeHandles = new long[0];
    public static long[] VisibleHandles = new long[0];
    public static long[] LegacyHandles = new long[0];
    public static List<long> Focused = new List<long>();
    public static List<uint> Probed = new List<uint>();
    public static bool FocusSucceeds = true;
    public static IntPtr GetForegroundWindow() {
        return FocusSucceeds && Focused.Count > 0
            ? new IntPtr(Focused[Focused.Count - 1]) : new IntPtr(999);
    }
    public static void Focus(IntPtr hwnd) { Focused.Add(hwnd.ToInt64()); }
    public static bool IsWindow(IntPtr hwnd) { return hwnd != IntPtr.Zero; }
    public static bool IsWindowVisible(IntPtr hwnd) {
        return hwnd != IntPtr.Zero && Array.IndexOf(VisibleHandles, hwnd.ToInt64()) >= 0;
    }
    public static bool IsLegacyConsoleWindow(IntPtr hwnd) {
        return hwnd != IntPtr.Zero && Array.IndexOf(LegacyHandles, hwnd.ToInt64()) >= 0;
    }
    public static IntPtr[] FindByPidTitles(uint pid, string[] names) { return TitleWindows; }
    public static IntPtr[] FindVisibleWindowsForPid(uint pid) { return VisiblePidWindows; }
    public static IntPtr FindConsoleWindowForPid(uint pid) {
        Probed.Add(pid);
        int idx = Array.IndexOf(ProbePids, pid);
        return idx >= 0 ? new IntPtr(ProbeHandles[idx]) : IntPtr.Zero;
    }
}
"@
function Get-Process {
    [CmdletBinding()]
    param([int]$Id, [string]$Name)
    if ($Name) { return @() }
    if (-not $script:ProcessNames.ContainsKey($Id)) { return $null }
    $handle = [IntPtr]::Zero
    if ($script:MainWindows.ContainsKey($Id)) { $handle = [IntPtr]$script:MainWindows[$Id] }
    return [pscustomobject]@{
        Id = $Id
        ProcessName = $script:ProcessNames[$Id]
        MainWindowHandle = $handle
    }
}
function Get-CimInstance {
    [CmdletBinding()]
    param($ClassName, $Filter, $OperationTimeoutSec)
    $match = [regex]::Match([string]$Filter, 'ProcessId=(\\d+)')
    if (-not $match.Success) { throw 'unexpected parent lookup' }
    $childPid = [int]$match.Groups[1].Value
    if (-not $script:Parents.ContainsKey($childPid)) { return $null }
    return [pscustomobject]@{ ParentProcessId = $script:Parents[$childPid] }
}
`;

// Each case drives the same generated script with a different process tree and
// console-window inventory, then reports which PIDs were probed.
const cases = [
  {
    name: "parent-direct never probes a console",
    cwd: ["repo"],
    processes: "@{ 1234 = 'node'; 4242 = 'node' }",
    mainWindows: "@{ 4242 = 303 }",
    parents: "@{ 1234 = 4242 }",
    probePids: "@([uint32]1234, [uint32]4242)",
    probeHandles: "@([long]5001, [long]5002)",
    visibleHandles: "@([long]5001, [long]5002)",
    legacyHandles: "@([long]5001, [long]5002)",
    reason: "parent-direct",
    target: 303,
    focused: [303],
    probed: [],
  },
  {
    name: "nearest legacy console wins when the whole tree has no window",
    cwd: ["repo"],
    processes: "@{ 1234 = 'node'; 2222 = 'node'; 1111 = 'explorer' }",
    mainWindows: "@{}",
    parents: "@{ 1234 = 2222; 2222 = 1111 }",
    probePids: "@([uint32]1234, [uint32]2222)",
    probeHandles: "@([long]5001, [long]5002)",
    visibleHandles: "@([long]5001, [long]5002)",
    legacyHandles: "@([long]5001, [long]5002)",
    reason: "legacy-conhost-window",
    target: 5001,
    focused: [5001],
    probed: [1234, 2222],
  },
  {
    name: "a visible shim console skips recovery without focusing",
    cwd: ["repo"],
    processes: "@{ 1234 = 'node'; 2222 = 'node'; 1111 = 'explorer' }",
    mainWindows: "@{}",
    parents: "@{ 1234 = 2222; 2222 = 1111 }",
    probePids: "@([uint32]1234, [uint32]2222)",
    probeHandles: "@([long]6001, [long]6002)",
    visibleHandles: "@([long]6001, [long]6002)",
    legacyHandles: "@()",
    reason: "console-window-shim-skip",
    target: null,
    focused: [],
    probed: [1234, 2222],
  },
  {
    name: "an ambiguous editor title is not a console recovery reason",
    cwd: ["repo"],
    processes: "@{ 1234 = 'node'; 4242 = 'Code' }",
    mainWindows: "@{ 4242 = 303 }",
    parents: "@{ 1234 = 4242 }",
    probePids: "@([uint32]1234, [uint32]4242)",
    probeHandles: "@([long]5001, [long]5002)",
    visibleHandles: "@([long]5001, [long]5002)",
    legacyHandles: "@([long]5001, [long]5002)",
    titleWindows: "@([IntPtr]101, [IntPtr]202)",
    reason: "editor-parent-title-ambiguous",
    target: null,
    focused: [],
    probed: [],
  },
  {
    name: "Windows Terminal without a title is not a console recovery reason",
    cwd: [],
    processes: "@{ 1234 = 'node'; 4242 = 'WindowsTerminal' }",
    mainWindows: "@{ 4242 = 303 }",
    parents: "@{ 1234 = 4242 }",
    probePids: "@([uint32]1234, [uint32]4242)",
    probeHandles: "@([long]5001, [long]5002)",
    visibleHandles: "@([long]5001, [long]5002)",
    legacyHandles: "@([long]5001, [long]5002)",
    reason: "windows-terminal-no-title",
    target: null,
    focused: [],
    probed: [],
  },
];

test("Windows console probe runs only on the recovery paths", {
  skip: process.platform !== "win32" && "requires Windows PowerShell",
}, async (t) => {
  const focus = require("../src/focus")({});
  const { makeFocusCmd, PS_FOCUS_ADDTYPE } = focus.__test;
  const resultWriter = PS_FOCUS_ADDTYPE.slice(PS_FOCUS_ADDTYPE.indexOf("function Write-ClawdFocusResult"));
  const scripts = cases.map((c, i) => `
[WinFocus]::Focused.Clear()
[WinFocus]::Probed.Clear()
[WinFocus]::TitleWindows = ${c.titleWindows || "@()"}
[WinFocus]::ProbePids = ${c.probePids}
[WinFocus]::ProbeHandles = ${c.probeHandles}
[WinFocus]::VisibleHandles = ${c.visibleHandles}
[WinFocus]::LegacyHandles = ${c.legacyHandles}
$script:ProcessNames = ${c.processes}
$script:MainWindows = ${c.mainWindows}
$script:Parents = ${c.parents}
$global:ClawdFocusWindowCache = @{}
${makeFocusCmd(1234, c.cwd, null, null, `case-${i}`)}
[ordered]@{
    focused = @([WinFocus]::Focused.ToArray())
    probed = @([WinFocus]::Probed.ToArray())
} | ConvertTo-Json -Compress
`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-console-probe-"));
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
    await t.test(c.name, () => {
      assert.ok(lines[i * 2].startsWith("__CLAWD_FOCUS_RESULT__ "));
      const raw = JSON.parse(lines[i * 2].slice("__CLAWD_FOCUS_RESULT__ ".length));
      const effects = JSON.parse(lines[i * 2 + 1]);
      assert.equal(raw.token, `case-${i}`);
      assert.equal(raw.reason, c.reason);
      assert.equal(raw.targetHwnd, c.target ? String(c.target) : null);
      assert.deepEqual(effects.focused, c.focused);
      assert.deepEqual(effects.probed, c.probed);
    });
  }
});
