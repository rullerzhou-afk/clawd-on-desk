"use strict";

// Two kinds of app activation live here.
//
// Codex Desktop: a PID is only a hint because it may have been reused. Activate
// only a verified desktop GUI ancestor of its live app-server, never an
// arbitrary GUI.
//
// CodeBuddy IDE: the session's own process chain must still contain a running
// CodeBuddy app (a macOS bundle or a Windows install directory), and that app's
// product.json must name CodeBuddy. We never guess a distribution by name or
// path. The app must be running when the click looks it up; macOS activation is
// app-level, and if it exits between the lookup and `open` the system may
// still relaunch it.
// This is app activation, not conversation selection or permission to paste.
const pid = value => Number.isSafeInteger(Number(value)) && Number(value) > 1 ? Number(value) : null;
const { posix, win32 } = require("node:path");
const fs = require("node:fs");

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

// Takes the outermost `.app` bundle with the same `.app/Contents/` rule as
// extractMacAppBundlePath in src/focus.js. This variant also rejects paths that
// are not absolute, change under posix.normalize, or contain control characters.
function codeBuddyBundlePathFromImage(image) {
  const text = typeof image === "string" ? image.trim() : "";
  if (!text.startsWith("/") || posix.normalize(text) !== text || /[\0\r\n]/.test(text)) return null;
  const marker = text.indexOf(".app/Contents/");
  return marker > 0 ? text.slice(0, marker + 4) : null;
}

function isCodeBuddyProduct(product) {
  if (!product || typeof product !== "object" || Array.isArray(product)) return false;
  return ["urlProtocol", "applicationName", "nameShort", "nameLong"].some((field) =>
    typeof product[field] === "string" && product[field].toLowerCase().includes("codebuddy"));
}

async function statOrNull(fsApi, filePath) {
  try {
    return await fsApi.promises.stat(filePath);
  } catch {
    return null;
  }
}

// The conversation route is a build capability. Keep one entry per app so an
// app update cannot leave stale keys behind; a hit requires both mtimes and the
// currently read urlProtocol to match, so a replaced or edited app is rechecked.
const codeBuddyRouteCache = new Map();
const CODEBUDDY_URL_SCHEME_RE = /^[a-z][a-z0-9+.-]{0,63}$/;

// `appPath` is the macOS bundle or the Windows install directory; it is the
// cache key and is returned as `bundlePath` for the click handler.
async function inspectCodeBuddyApp(appPath, appRoot, pathApi, fsApi) {
  const productPath = pathApi.join(appRoot, "product.json");
  const mainPath = pathApi.join(appRoot, "out", "main.js");
  // Stat before reading so an update between the two cannot pair a stale
  // protocol with fresh mtimes.
  const [productStat, mainStat] = await Promise.all([
    statOrNull(fsApi, productPath),
    statOrNull(fsApi, mainPath),
  ]);
  let product;
  try {
    product = JSON.parse(await fsApi.promises.readFile(productPath, "utf8"));
  } catch {
    return null;
  }
  if (!isCodeBuddyProduct(product)) return null;

  const urlProtocol = typeof product.urlProtocol === "string" ? product.urlProtocol.trim() : "";
  const productMtimeMs = productStat ? productStat.mtimeMs : null;
  const mainMtimeMs = mainStat ? mainStat.mtimeMs : null;
  const cached = codeBuddyRouteCache.get(appPath);
  if (cached
    && cached.productMtimeMs === productMtimeMs
    && cached.mainMtimeMs === mainMtimeMs
    && cached.urlProtocol === urlProtocol) {
    return { bundlePath: appPath, urlScheme: cached.urlScheme };
  }

  let urlScheme = null;
  try {
    const main = await fsApi.promises.readFile(mainPath, "utf8");
    if (CODEBUDDY_URL_SCHEME_RE.test(urlProtocol) && main.includes("/conversation/open")) {
      urlScheme = urlProtocol;
    }
  } catch {
    // A temporary failure only downgrades this click to app activation. Do not
    // cache it: the next click retries, and a late failure cannot replace the
    // result of a concurrent successful read.
    return { bundlePath: appPath, urlScheme: null };
  }
  codeBuddyRouteCache.set(appPath, { productMtimeMs, mainMtimeMs, urlProtocol, urlScheme });
  return { bundlePath: appPath, urlScheme };
}

function inspectCodeBuddyBundle(bundlePath, fsApi) {
  return inspectCodeBuddyApp(bundlePath, posix.join(bundlePath, "Contents", "Resources", "app"), posix, fsApi);
}

// Find the running CodeBuddy app that owns this session's process chain. The
// caller supplies PIDs in priority order (hook walk outward, then source and
// agent PIDs); the first image whose outer bundle is a verified CodeBuddy wins.
function findCodeBuddyMacApp(pids, { execFile, fs: fsApi = fs } = {}) {
  const candidates = Array.isArray(pids) ? pids : [];
  if (!candidates.length) return Promise.resolve(null);
  const output = new Promise((resolve) => {
    try {
      execFile("ps", ["-ww", "-o", "pid=,comm=", "-p", candidates.join(",")],
        { timeout: 1000, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
        (_error, stdout) => resolve(stdout));
    } catch {
      resolve(null);
    }
  });
  return output.then(async (stdout) => {
    // ps exits non-zero when one of the listed PIDs is already gone but still
    // prints the live rows, so parse stdout regardless of the error.
    const commByPid = new Map();
    for (const line of String(stdout || "").split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (match) commByPid.set(Number(match[1]), match[2]);
    }
    const seen = new Set();
    for (const candidatePid of candidates) {
      const bundlePath = codeBuddyBundlePathFromImage(commByPid.get(candidatePid));
      if (!bundlePath || seen.has(bundlePath)) continue;
      seen.add(bundlePath);
      const info = await inspectCodeBuddyBundle(bundlePath, fsApi);
      if (info) return info;
    }
    return null;
  });
}

// Windows images come from Get-Process. Accept only a normalized, drive-rooted
// path to an .exe; its directory is the install root that holds resources\app.
// Helpers such as agent-harness.exe live deeper and simply have no product.json
// next to them, so they are skipped by the same product check as macOS.
function codeBuddyWindowsAppDirFromImage(image) {
  const text = typeof image === "string" ? image.trim() : "";
  if (!/^[A-Za-z]:\\/.test(text) || win32.normalize(text) !== text || /[\0\r\n\t]/.test(text)) return null;
  if (!/\.exe$/i.test(text)) return null;
  const dir = win32.dirname(text);
  return dir && dir !== text ? dir : null;
}

function windowsCodeBuddyProcessScript(pids) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
    "foreach ($p in Get-Process -Id " + pids.join(",") + " -ErrorAction SilentlyContinue) {",
    "  if ($p.Path) { [Console]::Out.WriteLine(([string]$p.Id) + [char]9 + $p.Path) }",
    "}",
  ].join("\n");
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const WINDOWS_IMAGE_PATH_CHARS = 32768;

// Reads a live process's image path in-process through Win32, the same calls
// src/win-foreground-terminal.js already makes. A cold PowerShell spawn costs
// ~250ms per click on Windows; this costs well under a millisecond. Returns a
// `pid => string | null` reader, or null when the FFI cannot be loaded.
function createWindowsImagePathReader({ koffi } = {}) {
  let OpenProcess;
  let QueryFullProcessImageNameW;
  let CloseHandle;
  try {
    const ffi = koffi || require("koffi");
    const kernel32 = ffi.load("kernel32.dll");
    OpenProcess = kernel32.func("void * __stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)");
    QueryFullProcessImageNameW = kernel32.func("bool __stdcall QueryFullProcessImageNameW(void *hProcess, uint32 dwFlags, _Out_ uint16_t *lpExeName, _Inout_ uint32 *lpdwSize)");
    CloseHandle = kernel32.func("bool __stdcall CloseHandle(void *hObject)");
  } catch {
    return null;
  }
  return (rawPid) => {
    const processId = pid(rawPid);
    if (!processId) return null;
    let handle = null;
    try {
      handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
      if (!handle) return null;
      const buffer = new Uint16Array(WINDOWS_IMAGE_PATH_CHARS);
      const length = [WINDOWS_IMAGE_PATH_CHARS];
      if (!QueryFullProcessImageNameW(handle, 0, buffer, length)) return null;
      const count = Math.max(0, Math.min(Number(length[0]) || 0, buffer.length));
      let text = "";
      for (let i = 0; i < count; i++) text += String.fromCharCode(buffer[i]);
      return text || null;
    } catch {
      return null;
    } finally {
      if (handle) {
        try { CloseHandle(handle); } catch { /* best effort */ }
      }
    }
  };
}

let defaultWindowsImagePathReader;
// Built once on first use; null off Windows or when the FFI is unavailable,
// in which case the lookup falls back to one Get-Process call.
function getWindowsImagePathReader() {
  if (defaultWindowsImagePathReader === undefined) {
    defaultWindowsImagePathReader = process.platform === "win32" ? createWindowsImagePathReader() : null;
  }
  return defaultWindowsImagePathReader;
}

function queryWindowsImagesWithPowerShell(candidates, execFile) {
  return new Promise((resolve) => {
    try {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsCodeBuddyProcessScript(candidates)],
        { timeout: 3000, windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 },
        (_error, stdout) => resolve(stdout));
    } catch {
      resolve(null);
    }
  }).then((stdout) => {
    const imageByPid = new Map();
    for (const line of String(stdout || "").split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+)\t(.+)$/);
      if (match) imageByPid.set(Number(match[1]), match[2]);
    }
    return imageByPid;
  });
}

// Windows counterpart of findCodeBuddyMacApp: read the image of each of the
// session's recorded PIDs (priority order kept by the caller), then the first
// live image whose install directory carries a CodeBuddy product.json wins.
// The result's `bundlePath` is that install directory. `readImagePath` is
// the in-process reader; without one, a single Get-Process call is the fallback.
function findCodeBuddyWindowsApp(pids, { execFile, fs: fsApi = fs, readImagePath = null } = {}) {
  const candidates = (Array.isArray(pids) ? pids : []).map(pid).filter(Boolean);
  if (!candidates.length) return Promise.resolve(null);
  const images = typeof readImagePath === "function"
    ? Promise.resolve().then(() => {
      const imageByPid = new Map();
      for (const candidatePid of candidates) {
        let image = null;
        try { image = readImagePath(candidatePid); } catch { image = null; }
        if (typeof image === "string" && image) imageByPid.set(candidatePid, image);
      }
      return imageByPid;
    })
    : queryWindowsImagesWithPowerShell(candidates, execFile);
  return images.then(async (imageByPid) => {
    const seen = new Set();
    for (const candidatePid of candidates) {
      const appDir = codeBuddyWindowsAppDirFromImage(imageByPid.get(candidatePid));
      if (!appDir || seen.has(appDir.toLowerCase())) continue;
      seen.add(appDir.toLowerCase());
      const info = await inspectCodeBuddyApp(appDir, win32.join(appDir, "resources", "app"), win32, fsApi);
      if (info) return info;
    }
    return null;
  });
}

// Activate the verified bundle with one argv value, no shell. A successful
// submission is not a confirmed foreground change (same contract as Codex
// app activation), so callers must branch on `submitted`.
function openCodeBuddyMacApp(bundlePath, { execFile } = {}) {
  return new Promise((resolve) => {
    try {
      execFile("/usr/bin/open", [bundlePath], { timeout: 3000 }, (error) => {
        resolve(error
          ? { confirmed: false, submitted: false, reason: "codebuddy-app-activation-failed" }
          : { confirmed: false, submitted: true, reason: "codebuddy-app-activation-submitted" });
      });
    } catch {
      resolve({ confirmed: false, submitted: false, reason: "codebuddy-app-activation-failed" });
    }
  });
}

module.exports = {
  CODEBUDDY_URL_SCHEME_RE,
  createWindowsImagePathReader,
  focusProcessAppWindow,
  findCodeBuddyMacApp,
  findCodeBuddyWindowsApp,
  getWindowsImagePathReader,
  openCodeBuddyMacApp,
  windowsProcessAppScript,
  macCodexProcessTarget,
};
