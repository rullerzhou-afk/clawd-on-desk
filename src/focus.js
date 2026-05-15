// src/focus.js — Terminal focus system (PowerShell persistent process + macOS osascript)
// Extracted from main.js L1030-1335

const fs = require("fs");
const http = require("http");
const os = require("os");
const crypto = require("crypto");
const path = require("path");
const { execFile, spawn } = require("child_process");

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const isLinux = process.platform === "linux";

// ── Mac-only: Superset workspace deep-link helpers ──────────────────────────
// Superset.app is a multi-workspace Electron host. The generic
// `set frontmost of process whose unix id is N` script only activates the app
// — it can't switch the visible workspace to the worktree the request came
// from. Use the reverse-engineered `superset://workspace/<id>` URL scheme to
// navigate (observed 2026-05-08; internal scheme, no stability guarantee).
//
// `open` is given `-b com.superset.desktop` so a stale Superset DMG that
// LaunchServices still claims for the scheme cannot intercept the deep link.
//
// These helpers are at module scope so the unit tests can exercise them
// without standing up the full Electron context.

const SUPERSET_BUNDLE_ID = "com.superset.desktop";

function findSupersetDataDirs(homeDir) {
  // Superset by default lives in ~/.superset, but custom instances use
  // `~/.superset-<name>` and the matching URL scheme `superset-<name>://`.
  const home = homeDir || os.homedir();
  try {
    return fs.readdirSync(home, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(".superset"))
      .map((e) => path.join(home, e.name))
      .filter((dir) => {
        try { return fs.existsSync(path.join(dir, "local.db")); }
        catch { return false; }
      });
  } catch { return []; }
}

function supersetSchemeForDir(dir) {
  const base = path.basename(dir);
  if (base === ".superset") return "superset";
  if (base.startsWith(".superset-")) return `superset-${base.slice(".superset-".length)}`;
  return null;
}

function querySupersetWorkspaceId(dbPath, cwd, callback) {
  // Async callback form: invoke `callback(id|null)`. Spawning sqlite3 as a
  // child process with execFile keeps the Electron main event loop free
  // even on cold disks where the read can take a few hundred ms.
  if (!cwd) return callback(null);
  const candidates = [cwd];
  try {
    const real = fs.realpathSync(cwd);
    if (real && real !== cwd) candidates.push(real);
  } catch {}
  const tryNext = (idx) => {
    if (idx >= candidates.length) return callback(null);
    const escaped = candidates[idx].replace(/'/g, "''");
    const sql = `SELECT ws.id FROM workspaces ws JOIN worktrees w ON w.id = ws.worktree_id WHERE w.path = '${escaped}' ORDER BY COALESCE(ws.last_opened_at, 0) DESC LIMIT 1;`;
    execFile("sqlite3", ["-readonly", dbPath, sql], { encoding: "utf8", timeout: 1500 }, (err, stdout) => {
      if (err) return tryNext(idx + 1);
      const trimmed = (stdout || "").trim();
      if (trimmed) return callback(trimmed);
      tryNext(idx + 1);
    });
  };
  tryNext(0);
}

module.exports = function initFocus(ctx) {

const FOCUS_RESULT_PREFIX = "__CLAWD_FOCUS_RESULT__ ";

const PS_FOCUS_ADDTYPE = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public class WinFocus {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int maxCount);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    public static void Focus(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return;
        if (IsIconic(hWnd)) ShowWindow(hWnd, 9);
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        SetForegroundWindow(hWnd);
    }
    public static IntPtr FindConsoleWindowForPid(uint targetPid) {
        // Console shells such as powershell.exe / pwsh.exe can have
        // MainWindowHandle == 0 because the visible HWND belongs to the
        // console host. Attaching briefly lets us retrieve that HWND.
        // The helper uses stdin/stdout pipes, so detaching from a console does
        // not break the IPC channel back to Electron.
        FreeConsole();
        if (!AttachConsole(targetPid)) return IntPtr.Zero;
        IntPtr hWnd = GetConsoleWindow();
        FreeConsole();
        return hWnd;
    }
    public static IntPtr[] FindByPidTitles(uint targetPid, string[] subs) {
        var found = new List<IntPtr>();
        if (subs == null || subs.Length == 0) return found.ToArray();
        EnumWindows((hWnd, _) => {
            if (!IsWindowVisible(hWnd)) return true;
            uint pid; GetWindowThreadProcessId(hWnd, out pid);
            if (pid != targetPid) return true;
            int len = GetWindowTextLength(hWnd);
            if (len == 0) return true;
            var sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            var title = sb.ToString();
            foreach (string sub in subs) {
                if (!String.IsNullOrEmpty(sub) &&
                    title.IndexOf(sub, StringComparison.OrdinalIgnoreCase) >= 0) {
                    // Count each top-level window only once even if several
                    // cwd fragments match the same title.
                    found.Add(hWnd);
                    break;
                }
            }
            return true;
        }, IntPtr.Zero);
        return found.ToArray();
    }
}
"@

function Write-ClawdFocusResult([string]$reason) {
    if (-not $reason) { $reason = 'unknown' }
    Write-Output ('${FOCUS_RESULT_PREFIX}' + $reason)
}
`;

function makeFocusCmd(sourcePid, cwdCandidates) {
  // Walk up the process tree (same proven logic as before).
  // Windows Terminal needs title matching because one WT process can represent
  // multiple tabs/windows. Other parent windows keep direct PID focus.
  // Base64-encode cwd candidates so CJK/Unicode chars survive the Node→PowerShell
  // stdin pipe (PowerShell 5.1 reads stdin as system codepage, not UTF-8).
  const psNames = cwdCandidates.length
    ? cwdCandidates.map(c => {
        const b64 = Buffer.from(c, "utf8").toString("base64");
        return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`;
      }).join(",")
    : "";
  const titleNames = psNames ? `@(${psNames})` : "@()";
  const parentWindowBlock = psNames ? `
        if (@('WindowsTerminal', 'WindowsTerminalPreview') -contains $proc.ProcessName) {
            $matches = @([WinFocus]::FindByPidTitles([uint32]$curPid, [string[]]$titleNames))
            if ($matches.Count -eq 1) {
                [WinFocus]::Focus($matches[0])
                $focused = $true
                $reason = 'wt-parent-title-match'
            } elseif ($matches.Count -gt 1) {
                $reason = 'wt-parent-title-ambiguous'
            } else {
                [WinFocus]::Focus($proc.MainWindowHandle)
                $focused = $true
                $reason = 'wt-parent-direct-fallback'
            }
        } else {
            [WinFocus]::Focus($proc.MainWindowHandle)
            $focused = $true
            $reason = 'parent-direct'
        }
        break` : `
        if (@('WindowsTerminal', 'WindowsTerminalPreview') -notcontains $proc.ProcessName) {
            [WinFocus]::Focus($proc.MainWindowHandle)
            $focused = $true
            $reason = 'parent-direct-no-title'
        } else {
            $reason = 'windows-terminal-no-title'
        }
        break`;
  const wtTitleMatch = psNames ? `
    $wtProcs = Get-Process -Name 'WindowsTerminal' -ErrorAction SilentlyContinue
    $wtMatches = @()
    foreach ($wt in $wtProcs) {
        if ($wt.MainWindowHandle -eq 0) { continue }
        $matches = @([WinFocus]::FindByPidTitles([uint32]$wt.Id, [string[]]$titleNames))
        foreach ($hwnd in $matches) {
            $exists = $false
            foreach ($existing in $wtMatches) {
                if ($existing -eq $hwnd) { $exists = $true; break }
            }
            if (-not $exists) { $wtMatches += $hwnd }
        }
    }
    if ($wtMatches.Count -eq 1) {
        [WinFocus]::Focus($wtMatches[0])
        $focused = $true
        $reason = 'wt-title-match'
    } elseif ($wtMatches.Count -gt 1) {
        $reason = 'wt-title-ambiguous'
    } else {
        $reason = 'wt-title-mismatch'
    }` : `
    $reason = 'no-parent-window-no-title'`;

  return `
$titleNames = ${titleNames}
$curPid = ${sourcePid}
$focused = $false
$reason = 'no-parent-window'
for ($i = 0; $i -lt 8; $i++) {
    $proc = Get-Process -Id $curPid -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.ProcessName -eq 'explorer') { break }
    if ($proc.MainWindowHandle -ne 0) {${parentWindowBlock}
    }
    $consoleHwnd = [WinFocus]::FindConsoleWindowForPid([uint32]$curPid)
    if ($consoleHwnd -ne [IntPtr]::Zero -and [WinFocus]::IsWindowVisible($consoleHwnd)) {
        [WinFocus]::Focus($consoleHwnd)
        $focused = $true
        $reason = 'console-window'
        break
    }
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$curPid" -OperationTimeoutSec 2 -ErrorAction SilentlyContinue
    if (-not $cim -or $cim.ParentProcessId -eq 0 -or $cim.ParentProcessId -eq $curPid) { break }
    $curPid = $cim.ParentProcessId
}
if (-not $focused -and $reason -eq 'no-parent-window') {${wtTitleMatch}
}
Write-ClawdFocusResult $reason
`;
}

// Persistent PowerShell process — warm at startup, reused for all focus calls
let psProc = null;
// macOS Accessibility/System Events calls can pile up fast, so serialize focus attempts.
const MAC_FOCUS_THROTTLE_MS = 1500;
const MAC_FOCUS_TIMEOUT_MS = 1500;
let macFocusInFlight = false;
let macFocusLastRunAt = 0;
let macFocusLastRequestKey = null;
let macQueuedFocusRequest = null;
let macFocusCooldownTimer = null;
let psStdoutBuffer = "";

function normalizePid(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function normalizePidChain(value) {
  if (!Array.isArray(value)) return null;
  const out = value
    .map(normalizePid)
    .filter((pid, index, arr) => pid && arr.indexOf(pid) === index);
  return out.length ? out : null;
}

function normalizeFocusRequest(sourcePidOrRequest, cwd, editor, pidChain, meta = {}) {
  if (sourcePidOrRequest && typeof sourcePidOrRequest === "object" && !Array.isArray(sourcePidOrRequest)) {
    const request = sourcePidOrRequest;
    return {
      sourcePid: normalizePid(request.sourcePid ?? request.source_pid),
      cwd: typeof request.cwd === "string" ? request.cwd : "",
      editor: request.editor === "code" || request.editor === "cursor" ? request.editor : null,
      pidChain: normalizePidChain(request.pidChain ?? request.pid_chain),
      sessionId: typeof request.sessionId === "string" ? request.sessionId : null,
      agentId: typeof request.agentId === "string" ? request.agentId : null,
      requestSource: typeof request.requestSource === "string" ? request.requestSource : null,
    };
  }

  return {
    sourcePid: normalizePid(sourcePidOrRequest),
    cwd: typeof cwd === "string" ? cwd : "",
    editor: editor === "code" || editor === "cursor" ? editor : null,
    pidChain: normalizePidChain(pidChain),
    sessionId: meta && typeof meta.sessionId === "string" ? meta.sessionId : null,
    agentId: meta && typeof meta.agentId === "string" ? meta.agentId : null,
    requestSource: meta && typeof meta.requestSource === "string" ? meta.requestSource : null,
  };
}

function safeLogValue(value) {
  if (value === null || value === undefined || value === "") return "-";
  return String(value).replace(/[\r\n\t]+/g, " ").trim() || "-";
}

function summarizeCwd(cwd) {
  if (typeof cwd !== "string" || !cwd) return { tail: "-", hash: "-" };
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  const tail = parts.length ? `...\\${parts[parts.length - 1]}` : "-";
  const hash = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  return { tail, hash };
}

function formatPidChain(pidChain) {
  return Array.isArray(pidChain) && pidChain.length ? `[${pidChain.join(">")}]` : "[]";
}

function focusLog(msg) {
  if (!ctx || typeof ctx.focusLog !== "function") return;
  try { ctx.focusLog(msg); } catch {}
}

function logFocusRequest(request) {
  const cwd = summarizeCwd(request.cwd);
  focusLog([
    "focus request",
    `source=${safeLogValue(request.requestSource)}`,
    `sid=${safeLogValue(request.sessionId)}`,
    `agent=${safeLogValue(request.agentId)}`,
    `sourcePid=${request.sourcePid || "-"}`,
    `cwdTail=${safeLogValue(cwd.tail)}`,
    `cwdHash=${safeLogValue(cwd.hash)}`,
    `chain=${formatPidChain(request.pidChain)}`,
  ].join(" "));
}

function logFocusResult(reason) {
  focusLog(`focus result ${reason}`);
}

function handleFocusHelperLine(line) {
  const text = String(line || "").trim();
  if (!text.startsWith(FOCUS_RESULT_PREFIX)) return;
  const reason = safeLogValue(text.slice(FOCUS_RESULT_PREFIX.length));
  logFocusResult(`branch=windows-helper reason=${reason}`);
}

function handleFocusHelperOutput(chunk) {
  psStdoutBuffer += String(chunk || "");
  const lines = psStdoutBuffer.split(/\r?\n/);
  psStdoutBuffer = lines.pop() || "";
  for (const line of lines) handleFocusHelperLine(line);
  if (psStdoutBuffer.length > 8192) psStdoutBuffer = psStdoutBuffer.slice(-4096);
}

function handleFocusHelperCompleteOutput(output) {
  const lines = String(output || "").split(/\r?\n/);
  for (const line of lines) handleFocusHelperLine(line);
}

function initFocusHelper() {
  if (!isWin || psProc) return;
  psProc = spawn("powershell.exe", ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", "-"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  // Set UTF-8 input encoding so Chinese/CJK window titles match correctly,
  // then pre-compile the C# type (once, ~500ms, non-blocking)
  psProc.on("error", () => { psProc = null; }); // Spawn failure (powershell.exe not found, etc.)
  psProc.stdin.on("error", () => {}); // Suppress EPIPE if process exits unexpectedly
  if (psProc.stdout && typeof psProc.stdout.on === "function") {
    if (typeof psProc.stdout.setEncoding === "function") psProc.stdout.setEncoding("utf8");
    psProc.stdout.on("data", handleFocusHelperOutput);
    psProc.stdout.on("error", () => {});
    if (typeof psProc.stdout.unref === "function") psProc.stdout.unref();
  }
  psProc.stdin.write("[Console]::InputEncoding = [System.Text.Encoding]::UTF8\n");
  psProc.stdin.write(PS_FOCUS_ADDTYPE + "\n");
  psProc.on("exit", () => { psProc = null; psStdoutBuffer = ""; });
  psProc.unref(); // Don't keep the app alive for this
}

function killFocusHelper() {
  if (psProc) { psProc.kill(); psProc = null; }
}

function scheduleTerminalTabFocus(editor, pidChain) {
  if (!editor || !pidChain || !pidChain.length) return;
  setTimeout(() => {
    const body = JSON.stringify({ pids: pidChain });
    for (let port = 23456; port <= 23460; port++) {
      const tabReq = http.request({
        hostname: "127.0.0.1", port, path: "/focus-tab", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 300,
      }, () => {});
      tabReq.on("error", () => {});
      tabReq.on("timeout", () => tabReq.destroy());
      tabReq.end(body);
    }
  }, 800);
}

function findFirstValidTty(psOutput) {
  for (const line of psOutput.trim().split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      const tty = parts[parts.length - 1];
      if (tty !== "??" && tty !== "?") return tty;
    }
  }
  return null;
}

function buildCmuxBinPath(appPath) {
  // This path is macOS-only even when unit tests simulate darwin on Windows.
  return path.posix.join(String(appPath || "/Applications/cmux.app").replace(/\\/g, "/"), "Contents/Resources/bin/cmux");
}

function listCmuxSessionFiles(cmuxDir) {
  return fs.readdirSync(cmuxDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.startsWith("session-") && e.name.endsWith(".json") && !e.name.includes("-previous"))
    .map((e) => {
      const filePath = path.join(cmuxDir, e.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch {}
      return { filePath, mtimeMs, name: e.name };
    })
    .sort((a, b) => (b.mtimeMs - a.mtimeMs) || b.name.localeCompare(a.name))
    .map(e => e.filePath);
}

function findCmuxPanelMatch(sessionData, ttyName) {
  for (const win of sessionData?.windows ?? []) {
    const tm = win?.tabManager;
    if (!tm) continue;
    for (const ws of tm.workspaces ?? []) {
      const workspaceId = typeof ws?.id === "string" ? ws.id : null;
      if (!workspaceId) continue;
      for (const p of ws.panels ?? []) {
        if (p?.ttyName === ttyName && typeof p.id === "string" && p.id) {
          return { workspaceId, panelId: p.id, ttyName: p.ttyName };
        }
      }
    }
  }
  return null;
}

function findCmuxPanelMatchInSessionFiles(cmuxDir, ttyName) {
  const sessionFiles = listCmuxSessionFiles(cmuxDir);
  if (!sessionFiles.length) return { readAny: false, match: null };

  let readAny = false;
  for (const sessionFile of sessionFiles) {
    try {
      const sessionData = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      readAny = true;
      const match = findCmuxPanelMatch(sessionData, ttyName);
      if (match) return { readAny, match };
    } catch {}
  }
  return { readAny, match: null };
}

function scheduleITermTabFocus(sourcePid, pidChain) {
  if (!isMac || !sourcePid || !Array.isArray(pidChain) || !pidChain.length) return;
  execFile("ps", ["-o", "comm=", "-p", String(sourcePid)], { encoding: "utf8", timeout: 500 }, (err, stdout) => {
    if (err) return;
    const name = path.basename(stdout.trim()).toLowerCase();
    if (name !== "iterm2") return;

    // Walk pidChain from agent (index 0) upward — the first PID with a valid TTY
    // is typically the shell or login process that owns the iTerm2 session.
    const candidates = pidChain.filter(p => Number.isFinite(p) && p > 0 && p !== sourcePid);
    if (!candidates.length) return;

    const pidsArg = candidates.slice(0, 8).join(",");
    execFile("ps", ["-o", "pid=,tty=", "-p", pidsArg], { encoding: "utf8", timeout: 500 }, (psErr, psOut) => {
      if (psErr || !psOut) return;
      const ttyName = findFirstValidTty(psOut);
      if (!ttyName) return;

      const script = `
        tell application "iTerm2"
          repeat with w in windows
            repeat with t in tabs of w
              repeat with s in sessions of t
                if tty of s ends with "${ttyName}" then
                  select t
                  select w
                  return "ok"
                end if
              end repeat
            end repeat
          end repeat
        end tell`;
      setTimeout(() => {
        execFile("osascript", ["-e", script], { timeout: MAC_FOCUS_TIMEOUT_MS }, () => {});
      }, 400);
    });
  });
}

function scheduleCmuxWorkspaceSwitch(pidChain) {
  if (!isMac || !Array.isArray(pidChain) || !pidChain.length) return;
  const pids = pidChain.filter(p => Number.isFinite(p) && p > 0);
  if (!pids.length) return;

  const pidsArg = pids.slice(0, 8).join(",");
  execFile("ps", ["-o", "comm=", "-p", pidsArg], { encoding: "utf8", timeout: 500 }, (err, stdout) => {
    if (err || !stdout) return;
    let hasCmux = false;
    for (const line of stdout.trim().split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 1 && path.basename(parts[parts.length - 1]).toLowerCase() === "cmux") { hasCmux = true; break; }
    }
    if (!hasCmux) return;

    // Locate cmux app via Spotlight (mdfind), fall back to hardcoded path
    const cmuxAppPath = "/Applications/cmux.app";
    execFile("mdfind", ["kMDItemCFBundleIdentifier=com.cmuxterm.app"], { timeout: 2000 }, (mdfindErr, appPath) => {
      const resolvedAppPath = (!mdfindErr && appPath.trim()) ? appPath.trim().split("\n")[0] : cmuxAppPath;
      const cmuxBin = buildCmuxBinPath(resolvedAppPath);

      execFile("ps", ["-o", "pid=,tty=", "-p", pidsArg], { encoding: "utf8", timeout: 500 }, (psErr, psOut) => {
        if (psErr || !psOut) { logFocusResult("branch=cmux reason=cmux-no-tty"); return; }
        const ttyName = findFirstValidTty(psOut);
        if (!ttyName) { logFocusResult("branch=cmux reason=cmux-no-tty"); return; }

        // Read cmux session file, match TTY to workspace+panel, focus by panel id
        const cmuxDir = path.join(process.env.HOME || os.homedir(), "Library/Application Support/cmux");
        try {
          const { readAny, match } = findCmuxPanelMatchInSessionFiles(cmuxDir, ttyName);
          if (!readAny) { logFocusResult("branch=cmux reason=cmux-session-read-failed"); return; }
          if (!match) { logFocusResult("branch=cmux reason=cmux-workspace-not-found"); return; }

          const focusWithPanelId = (panelId) => {
            execFile(cmuxBin, ["focus-panel", "--workspace", match.workspaceId, "--panel", panelId], { timeout: 1500 }, (panelErr) => {
              if (panelErr) {
                // Fallback 1: select-workspace
                execFile(cmuxBin, ["select-workspace", "--workspace", match.workspaceId], { timeout: 1500 }, (wsErr) => {
                  if (wsErr) {
                    // Fallback 2: AppleScript
                    const escapedPanelId = String(panelId).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
                    const script = `tell application "cmux" to focus terminal id "${escapedPanelId}"`;
                    execFile("osascript", ["-e", script], { timeout: MAC_FOCUS_TIMEOUT_MS }, (osaErr) => {
                      if (osaErr) { logFocusResult("branch=cmux reason=cmux-all-fallbacks-failed"); return; }
                      logFocusResult("branch=cmux reason=cmux-workspace-selected");
                    });
                  } else {
                    logFocusResult("branch=cmux reason=cmux-workspace-selected");
                  }
                });
              } else {
                logFocusResult("branch=cmux reason=cmux-workspace-selected");
              }
            });
          };

          setTimeout(() => focusWithPanelId(match.panelId), 400);
        } catch (readErr) {
          logFocusResult("branch=cmux reason=cmux-session-read-failed");
        }
      });
    });
  });
}

function clearMacFocusCooldownTimer() {
  if (macFocusCooldownTimer) {
    clearTimeout(macFocusCooldownTimer);
    macFocusCooldownTimer = null;
  }
}

function scheduleQueuedMacFocus(delayMs) {
  clearMacFocusCooldownTimer();
  if (!macQueuedFocusRequest) return;
  macFocusCooldownTimer = setTimeout(() => {
    macFocusCooldownTimer = null;
    flushQueuedMacFocus();
  }, Math.max(0, delayMs));
}

function flushQueuedMacFocus() {
  if (!macQueuedFocusRequest || macFocusInFlight) return;
  const elapsed = Date.now() - macFocusLastRunAt;
  const remaining = Math.max(0, MAC_FOCUS_THROTTLE_MS - elapsed);
  if (remaining > 0) {
    scheduleQueuedMacFocus(remaining);
    return;
  }

  const nextRequest = macQueuedFocusRequest;
  macQueuedFocusRequest = null;
  executeMacFocusRequest(nextRequest);
}

function getMacFocusRequestKey(sourcePid, pidChain) {
  const chain = Array.isArray(pidChain)
    ? pidChain.filter(p => Number.isFinite(p) && p > 0).join(",")
    : "";
  return `${sourcePid || ""}|${chain}`;
}

function executeMacFocusRequest(request) {
  macFocusInFlight = true;
  macFocusLastRunAt = Date.now();
  macFocusLastRequestKey = request.key;

  const finalize = () => {
    macFocusInFlight = false;
    if (macQueuedFocusRequest) flushQueuedMacFocus();
  };

  focusTerminalWindowLegacy(request, finalize);
  scheduleTerminalTabFocus(request.editor, request.pidChain);
  scheduleITermTabFocus(request.sourcePid, request.pidChain);
  scheduleCmuxWorkspaceSwitch(request.pidChain);
  scheduleSupersetFocus(request.sourcePid, request.cwd);
  scheduleGhosttyFocus(request.sourcePid, request.cwd);
}

function scheduleSupersetFocus(sourcePid, cwd) {
  // Mirror scheduleITermTabFocus / scheduleGhosttyFocus: detect the host by
  // the source process command name *first*, then run the deep link. Without
  // the comm gate, any focus request whose cwd happens to be tracked by
  // Superset (e.g. a worktree opened in VS Code / Cursor / iTerm2) would
  // pull Superset to the front and steal focus from the real source.
  if (!isMac || !sourcePid || !cwd) return;
  execFile("ps", ["-o", "comm=", "-p", String(sourcePid)], { encoding: "utf8", timeout: 500 }, (err, stdout) => {
    if (err) return;
    // Superset bundles exec at /Applications/Superset.app/Contents/MacOS/Superset,
    // so path.basename of the comm is "Superset" for every Superset-hosted
    // shell (the boundary walk in shared-process.js ends at the bundle exec
    // because terminalNames does not list Superset).
    const name = path.basename(stdout.trim()).toLowerCase();
    if (name !== "superset") return;

    const dirs = findSupersetDataDirs();
    if (!dirs.length) return;
    const tryDir = (idx) => {
      if (idx >= dirs.length) return;
      const dir = dirs[idx];
      querySupersetWorkspaceId(path.join(dir, "local.db"), cwd, (id) => {
        if (!id) return tryDir(idx + 1);
        const scheme = supersetSchemeForDir(dir);
        if (!scheme) return tryDir(idx + 1);
        const url = `${scheme}://workspace/${id}`;
        execFile("/usr/bin/open", ["-b", SUPERSET_BUNDLE_ID, url], { timeout: 1500 }, (err2) => {
          if (err2) focusLog(`superset deep-link failed: ${err2.message}`);
        });
      });
    };
    tryDir(0);
  });
}

function scheduleGhosttyFocus(sourcePid, cwd) {
  // Mirror scheduleITermTabFocus: detect Ghostty by the source process
  // command name, then ask Ghostty's scripting dictionary to focus the
  // terminal whose `working directory` matches cwd. `focus` selects the
  // surface and raises its window, so no separate System Events activate is
  // needed.
  if (!isMac || !sourcePid || !cwd) return;
  execFile("ps", ["-o", "comm=", "-p", String(sourcePid)], { encoding: "utf8", timeout: 500 }, (err, stdout) => {
    if (err) return;
    const name = path.basename(stdout.trim()).toLowerCase();
    if (name !== "ghostty") return;

    const candidates = [cwd];
    try {
      const real = fs.realpathSync(cwd);
      if (real && real !== cwd) candidates.push(real);
    } catch {}
    const escapeAS = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const literalList = candidates.map((c) => `"${escapeAS(c)}"`).join(", ");
    const script = `
      tell application "Ghostty"
        set targetCwds to {${literalList}}
        repeat with cwdLiteral in targetCwds
          set matches to every terminal whose working directory is (contents of cwdLiteral)
          if (count of matches) > 0 then
            focus (item 1 of matches)
            return "ok"
          end if
        end repeat
        return "miss"
      end tell`;
    setTimeout(() => {
      execFile("osascript", ["-e", script], { timeout: MAC_FOCUS_TIMEOUT_MS }, () => {});
    }, 400);
  });
}

function requestMacFocus(request) {
  const elapsed = Date.now() - macFocusLastRunAt;
  const inCooldown = elapsed < MAC_FOCUS_THROTTLE_MS;
  const key = getMacFocusRequestKey(request.sourcePid, request.pidChain);
  if (inCooldown && macFocusLastRequestKey === key) return "dropped-duplicate";

  request = { ...request, key };
  if (macFocusInFlight) {
    macQueuedFocusRequest = request;
    return "queued";
  }

  if (inCooldown) {
    macQueuedFocusRequest = request;
    scheduleQueuedMacFocus(MAC_FOCUS_THROTTLE_MS - elapsed);
    return "queued";
  }

  macQueuedFocusRequest = null;
  clearMacFocusCooldownTimer();
  executeMacFocusRequest(request);
  return "submitted";
}

function focusTerminalWindow(sourcePidOrRequest, cwd, editor, pidChain, meta) {
  const request = normalizeFocusRequest(sourcePidOrRequest, cwd, editor, pidChain, meta);
  logFocusRequest(request);
  if (!request.sourcePid) {
    logFocusResult("branch=none reason=no-source-pid");
    return;
  }

  if (isMac) {
    const result = requestMacFocus(request);
    logFocusResult(`branch=mac reason=${result || "unknown"}`);
    return;
  }

  if (isLinux) {
    focusTerminalWindowLegacy(request);
    scheduleTerminalTabFocus(request.editor, request.pidChain);
    logFocusResult("branch=linux-command-submitted");
    return;
  }

  // Grant PowerShell helper permission to call SetForegroundWindow.
  // This must happen HERE — Electron just received user input (click/hotkey),
  // so it has foreground privilege to delegate.
  if (ctx._allowSetForeground && psProc && psProc.pid) {
    try { ctx._allowSetForeground(psProc.pid); } catch {}
  }

  // Legacy focus for reliable window activation (ALT key trick + SetForegroundWindow)
  focusTerminalWindowLegacy(request);
  logFocusResult("branch=windows-dispatched");

  // VS Code / Cursor: request precise terminal tab switch via extension's HTTP server.
  // Delayed so legacy PowerShell focus completes first (it's fire-and-forget via stdin).
  scheduleTerminalTabFocus(request.editor, request.pidChain);
}

function focusTerminalWindowLegacy(request, onDone) {
  const { sourcePid } = request;
  const cwd = request.cwd;
  const pidChain = request.pidChain;

  if (!sourcePid) {
    if (onDone) onDone();
    return false;
  }

  if (isMac) {
    const pidCandidates = [sourcePid];
    if (Array.isArray(pidChain)) {
      for (const pid of pidChain) {
        if (!Number.isFinite(pid) || pid <= 0 || pidCandidates.includes(pid)) continue;
        pidCandidates.push(pid);
        if (pidCandidates.length >= 3) break;
      }
    }
    const applePidList = pidCandidates.join(", ");
    const script = `
      tell application "System Events"
        repeat with targetPid in {${applePidList}}
          set pidValue to contents of targetPid
          set pList to every process whose unix id is pidValue
          if (count of pList) > 0 then
            set frontmost of item 1 of pList to true
            exit repeat
          end if
        end repeat
      end tell`;
    execFile("osascript", ["-e", script], { timeout: MAC_FOCUS_TIMEOUT_MS }, (err) => {
      if (err) console.warn("focusTerminal macOS failed:", err.message);
      if (onDone) onDone();
    });
    return true;
  }

  if (isLinux) {
    // Linux: try wmctrl (lookup by PID), then xdotool.
    // Missing tools fail quietly so hooks never block the app.
    const tryXdoTool = () => {
      execFile("xdotool", ["search", "--pid", String(sourcePid), "windowactivate", "--sync"], {
        timeout: 1200,
      }, () => {
        if (onDone) onDone();
      });
    };
    execFile("wmctrl", ["-lp"], { timeout: 1000 }, (err, stdout) => {
      if (err || !stdout) return tryXdoTool();
      const lines = String(stdout).split(/\r?\n/);
      const match = lines.find((line) => {
        const parts = line.trim().split(/\s+/);
        return parts.length >= 3 && Number(parts[2]) === Number(sourcePid);
      });
      if (!match) return tryXdoTool();
      const winId = match.trim().split(/\s+/)[0];
      if (!winId) return tryXdoTool();
      execFile("wmctrl", ["-i", "-a", winId], { timeout: 1000 }, (activateErr) => {
        if (activateErr) return tryXdoTool();
        if (onDone) onDone();
      });
    });
    return true;
  }

  // Build candidate folder names from cwd for title matching (deepest first).
  // e.g. "C:\Users\X\GPT_Test\redbook" → ['redbook', 'GPT_Test']
  // Cursor window title typically shows workspace root, which may not be the deepest folder.
  const cwdCandidates = [];
  if (cwd) {
    let dir = cwd;
    for (let i = 0; i < 3; i++) {
      const name = path.basename(dir);
      if (!name || name === dir || /^[A-Z]:$/i.test(name)) break;
      cwdCandidates.push(name);
      dir = path.dirname(dir);
    }
  }

  // Windows: send command to persistent PowerShell process (near-instant)
  const cmd = makeFocusCmd(sourcePid, cwdCandidates);
  if (psProc && psProc.stdin.writable) {
    psProc.stdin.write(cmd + "\n");
    return true;
  } else {
    // Fallback: one-shot PowerShell if persistent process died
    psProc = null;
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      PS_FOCUS_ADDTYPE + cmd],
      { windowsHide: true, timeout: 5000, encoding: "utf8" },
      (err, stdout) => {
        if (err) console.warn("focusTerminal failed:", err.message);
        handleFocusHelperCompleteOutput(stdout);
      }
    );
    // Re-init persistent process for next call
    initFocusHelper();
    return true;
  }
}

function cleanup() {
  killFocusHelper();
  clearMacFocusCooldownTimer();
  macQueuedFocusRequest = null;
  macFocusInFlight = false;
}

return {
  initFocusHelper,
  killFocusHelper,
  focusTerminalWindow,
  clearMacFocusCooldownTimer,
  cleanup,
  __test: {
    makeFocusCmd,
    normalizeFocusRequest,
    summarizeCwd,
    handleFocusHelperCompleteOutput,
    PS_FOCUS_ADDTYPE,
  },
};

};

// Top-level (no-ctx) helpers exposed so unit tests can exercise the
// Superset workspace lookup path without running the full Electron factory.
// The factory's instance-level `__test` namespace (returned above) covers
// closure-only helpers like makeFocusCmd; this attaches the module-scoped
// helpers separately.
module.exports.__test = {
  findSupersetDataDirs,
  supersetSchemeForDir,
  querySupersetWorkspaceId,
};
