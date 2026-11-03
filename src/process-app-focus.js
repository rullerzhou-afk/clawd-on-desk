"use strict";

// A PID is only a hint: it may have been reused. Activate only a verified
// Codex Desktop GUI ancestor of its live app-server, never an arbitrary GUI.
// This is app activation, not conversation selection or permission to paste.
const pid = value => Number.isSafeInteger(Number(value)) && Number(value) > 1 ? Number(value) : null;
const posix = require("node:path").posix;

function windowsProcessAppScript(sourcePid) {
  const source = pid(sourcePid);
  if (!source) throw new TypeError("process focus needs a positive source PID");
  return String.raw`
$sourcePid = ${source}
$target = [IntPtr]::Zero
$reason = 'unverified-codex-process'
# Parse the existing command line without evaluating it or starting a shell.
# Keep this type separate from WinFocus: these APIs only split/free argv.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CodexFocusCommandLine {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr memory);
  public static string[] Parse(string commandLine) {
    if (String.IsNullOrWhiteSpace(commandLine) || commandLine.Length > 32767) return new string[0];
    int count;
    IntPtr memory = CommandLineToArgvW(commandLine, out count);
    if (memory == IntPtr.Zero) return new string[0];
    try {
      var result = new string[count];
      for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
      return result;
    } finally { LocalFree(memory); }
  }
}
'@
function Read-CodexProcess([int]$processId) {
  Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -OperationTimeoutSec 1 -ErrorAction SilentlyContinue
}
function Test-CommandImage($proc) {
  if (-not $proc.ExecutablePath -or -not $proc.CommandLine) { return $false }
  $commandArgs = [CodexFocusCommandLine]::Parse($proc.CommandLine)
  return $commandArgs.Count -gt 0 -and [string]::Equals($commandArgs[0], $proc.ExecutablePath, [StringComparison]::OrdinalIgnoreCase)
}
function Test-CodexServer($proc) {
  if (-not $env:LOCALAPPDATA -or -not (Test-CommandImage $proc)) { return $false }
  $root = [regex]::Escape((Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'))
  if ($proc.ExecutablePath -inotmatch ('^' + $root + '\\[0-9a-f]{16}\\codex\.exe$')) { return $false }
  $commandArgs = [CodexFocusCommandLine]::Parse($proc.CommandLine)
  $index = 1
  while ($index -lt $commandArgs.Count) {
    # Config values can themselves contain spaces, quotes, or "app-server".
    # Only consume explicit global config flags; never search for a substring.
    if ($commandArgs[$index] -ceq '-c' -or $commandArgs[$index] -ceq '--config') {
      if ($index + 1 -ge $commandArgs.Count -or [string]::IsNullOrEmpty($commandArgs[$index + 1])) { return $false }
      $index += 2
      continue
    }
    if ($commandArgs[$index].StartsWith('--config=', [StringComparison]::Ordinal)) {
      if ($commandArgs[$index].Length -eq 9) { return $false }
      $index++
      continue
    }
    return $commandArgs[$index] -ceq 'app-server'
  }
  return $false
}
function Test-CodexGuiImage($proc) {
  if (-not $env:ProgramFiles -or -not (Test-CommandImage $proc)) { return $false }
  $root = [regex]::Escape((Join-Path $env:ProgramFiles 'WindowsApps'))
  return $proc.ExecutablePath -imatch ('^' + $root + '\\OpenAI\.Codex_[0-9]+(?:\.[0-9]+){1,3}_(?:x64|arm64)__[a-z0-9]+\\app\\ChatGPT\.exe$')
}
function Test-CodexMainGui($proc) {
  return (Test-CodexGuiImage $proc) -and $proc.CommandLine -inotmatch '(?:^|[\s"])--type(?:[=\s"]|$)|(?:^|[\s"])app-server(?:[\s"]|$)'
}
$source = Read-CodexProcess $sourcePid
if ($source -and $source.CreationDate -and (Test-CodexServer $source)) {
  $child = $source
  for ($i = 0; $i -lt 8; $i++) {
    if ($child.ParentProcessId -le 1 -or $child.ParentProcessId -eq $child.ProcessId) { break }
    $parent = Read-CodexProcess $child.ParentProcessId
    if (-not $parent -or -not $parent.CreationDate -or $parent.CreationDate -gt $child.CreationDate) { break }
    # Never cross a shell, terminal, IDE, Explorer, or unknown process.
    if (-not (Test-CodexGuiImage $parent)) { break }
    if (Test-CodexMainGui $parent) {
      $freshSource = Read-CodexProcess $sourcePid
      $freshParent = Read-CodexProcess $parent.ProcessId
      if (-not $freshSource -or -not $freshParent -or
          $freshSource.CreationDate -ne $source.CreationDate -or
          $freshParent.CreationDate -ne $parent.CreationDate -or
          -not (Test-CodexServer $freshSource) -or -not (Test-CodexMainGui $freshParent)) { break }
      $gui = Get-Process -Id $parent.ProcessId -ErrorAction SilentlyContinue
      if (-not $gui) { break }
      $hwnd = $gui.MainWindowHandle
      [uint32]$owner = 0
      if ($hwnd -ne [IntPtr]::Zero -and [WinFocus]::IsWindowVisible($hwnd)) {
        [void][WinFocus]::GetWindowThreadProcessId($hwnd, [ref]$owner)
        if ($owner -eq $parent.ProcessId) { $target = $hwnd }
      }
      $reason = 'no-process-window'
      break
    }
    $child = $parent
  }
}
if ($target -ne [IntPtr]::Zero) { [WinFocus]::Focus($target); $reason = 'codex-process-window' }
$confirmed = $target -ne [IntPtr]::Zero -and [WinFocus]::GetForegroundWindow() -eq $target
@{confirmed=$confirmed;reason=$reason} | ConvertTo-Json -Compress
`;
}

function macCodexProcessTarget(sourcePid, text) {
  const processes = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+((\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+))$/);
    if (!match) continue;
    const started = Date.parse(match[4]);
    if (!Number.isFinite(started)) continue;
    processes.set(Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]), identity: match[3], started, image: match[5] });
  }
  const source = processes.get(pid(sourcePid));
  const target = source && processes.get(source.parent);
  if (!target || target.pid === source.pid || target.started > source.started) return null;
  // Use the GUI's outermost bundle, not the app-server's innermost helper.
  // The GUI must be a direct Contents/MacOS executable of that outer bundle;
  // a nested helper process cannot authorize activating a different ancestor.
  const validImage = image => image.startsWith("/") && posix.normalize(image) === image
    && !/[\0\r\n]/.test(image);
  if (!validImage(source.image) || !validImage(target.image)) return null;
  const bundleEnd = target.image.indexOf(".app/");
  if (bundleEnd < 1) return null;
  const bundlePath = target.image.slice(0, bundleEnd + 4);
  const guiPrefix = `${bundlePath}/Contents/MacOS/`;
  const guiExecutable = target.image.slice(guiPrefix.length);
  if (!target.image.startsWith(guiPrefix) || !guiExecutable || guiExecutable.includes("/")) return null;
  // Keep the bundled codex image requirement without hard-coding the app name
  // or helper layout. Both Resources/codex and Resources/.../CodexCLI.app/
  // Contents/MacOS/codex are valid; a CLI outside this bundle is not.
  if (!source.image.startsWith(`${bundlePath}/Contents/Resources/`)
      || posix.basename(source.image) !== "codex") return null;
  return { source, target, bundlePath };
}

function focusProcessAppWindow(request, { execFile, platform, windowsActivationCode = "" }) {
  const source = pid(request && request.sourcePid);
  if (!source) return Promise.resolve({ confirmed: false, reason: "no-source-pid" });
  const run = (bin, args, options = {}) => new Promise(resolve => {
    try { execFile(bin, args, { timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true, encoding: "utf8", ...options },
      (error, stdout) => resolve({ error, stdout: String(stdout || "") })); }
    catch (error) { resolve({ error, stdout: "" }); }
  });
  if (platform === "win32") {
    return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsActivationCode + windowsProcessAppScript(source)])
      .then(result => {
        if (result.error) return { confirmed: false, reason: "process-focus-failed" };
        try { const value = JSON.parse(result.stdout.trim()); return { confirmed: value.confirmed === true, reason: value.reason }; }
        catch { return { confirmed: false, reason: "process-focus-unconfirmed" }; }
      });
  }
  // No verified Linux Codex Desktop executable/bundle contract is available.
  if (platform !== "darwin") return Promise.resolve({ confirmed: false, reason: "unsupported-platform" });
  return run("ps", ["-ww", "-axo", "pid=,ppid=,lstart=,comm="], { timeout: 1000, env: { ...process.env, LC_ALL: "C" } }).then(async result => {
    if (result.error) return { confirmed: false, reason: "process-query-failed" };
    // Darwin's ordinary resolver anchors sourcePid at the GUI, while agentPid
    // identifies its app-server. Keep those metadata semantics unchanged and
    // verify both ends here. Older entries may carry the server as sourcePid.
    const server = pid(request && request.agentPid) || source;
    const proof = macCodexProcessTarget(server, result.stdout);
    if (!proof || (source !== server && source !== proof.target.pid)) {
      return { confirmed: false, reason: "unverified-codex-process" };
    }
    // Recheck birth identities, images and the direct parent relationship
    // immediately before activation. Never turn a changed PID into a launcher.
    const fresh = await run("ps", ["-ww", "-axo", "pid=,ppid=,lstart=,comm="], { timeout: 1000, env: { ...process.env, LC_ALL: "C" } });
    if (fresh.error) return { confirmed: false, reason: "process-query-failed" };
    const current = macCodexProcessTarget(server, fresh.stdout);
    const same = (a, b) => a.pid === b.pid && a.parent === b.parent && a.identity === b.identity;
    if (!current || !same(proof.source, current.source) || !same(proof.target, current.target)
        || current.bundlePath !== proof.bundlePath) return { confirmed: false, reason: "process-changed" };
    // LaunchServices restores minimized windows and avoids System Events'
    // Automation consent requirement. Pass the verified absolute bundle as
    // one argv value; no shell, application-name lookup, URI or paste fallback.
    const activated = await run("/usr/bin/open", [current.bundlePath]);
    return { confirmed: false, submitted: !activated.error,
      reason: activated.error ? "process-focus-failed" : "app-activation-submitted" };
  });
}

module.exports = { focusProcessAppWindow, windowsProcessAppScript, macCodexProcessTarget };
