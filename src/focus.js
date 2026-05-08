// src/focus.js — Terminal focus system (PowerShell persistent process + macOS osascript)
// Extracted from main.js L1030-1335

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFile, execFileSync, spawn } = require("child_process");

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const isLinux = process.platform === "linux";

module.exports = function initFocus(ctx) {

const PS_FOCUS_ADDTYPE = `
Add-Type @"
using System;
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
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    public static void Focus(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return;
        if (IsIconic(hWnd)) ShowWindow(hWnd, 9);
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        SetForegroundWindow(hWnd);
    }
    public static IntPtr FindByPidTitle(uint targetPid, string sub) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hWnd, _) => {
            if (!IsWindowVisible(hWnd)) return true;
            uint pid; GetWindowThreadProcessId(hWnd, out pid);
            if (pid != targetPid) return true;
            int len = GetWindowTextLength(hWnd);
            if (len == 0) return true;
            var sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            if (sb.ToString().IndexOf(sub, StringComparison.OrdinalIgnoreCase) >= 0) {
                found = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@
`;

function makeFocusCmd(sourcePid, cwdCandidates) {
  // Walk up the process tree (same proven logic as before).
  // When we find the process with MainWindowHandle, try title-matching first
  // to support multi-window editors (Cursor/VS Code). Fall back to MainWindowHandle.
  // Base64-encode cwd candidates so CJK/Unicode chars survive the Node→PowerShell
  // stdin pipe (PowerShell 5.1 reads stdin as system codepage, not UTF-8).
  const psNames = cwdCandidates.length
    ? cwdCandidates.map(c => {
        const b64 = Buffer.from(c, "utf8").toString("base64");
        return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`;
      }).join(",")
    : "";
  const titleMatchBlock = psNames ? `
        $matched = $false
        foreach ($name in @(${psNames})) {
            $hwnd = [WinFocus]::FindByPidTitle([uint32]$curPid, $name)
            if ($hwnd -ne [IntPtr]::Zero) {
                [WinFocus]::Focus($hwnd); $matched = $true; break
            }
        }
        if ($matched) { $focused = $true; break }` : "";
  // Windows Terminal fallback: same title matching but against WT windows
  const wtTitleMatch = psNames ? `
    $wtProcs = Get-Process -Name 'WindowsTerminal' -ErrorAction SilentlyContinue
    foreach ($wt in $wtProcs) {
        if ($wt.MainWindowHandle -eq 0) { continue }
        foreach ($name in @(${psNames})) {
            $hwnd = [WinFocus]::FindByPidTitle([uint32]$wt.Id, $name)
            if ($hwnd -ne [IntPtr]::Zero) {
                [WinFocus]::Focus($hwnd); $focused = $true; break
            }
        }
        if ($focused) { break }
    }` : "";

  return `
$curPid = ${sourcePid}
$focused = $false
for ($i = 0; $i -lt 8; $i++) {
    $proc = Get-Process -Id $curPid -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.ProcessName -eq 'explorer') { break }
    if ($proc.MainWindowHandle -ne 0) {${titleMatchBlock}
        [WinFocus]::Focus($proc.MainWindowHandle)
        $focused = $true
        break
    }
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$curPid" -ErrorAction SilentlyContinue
    if (-not $cim -or $cim.ParentProcessId -eq 0 -or $cim.ParentProcessId -eq $curPid) { break }
    $curPid = $cim.ParentProcessId
}
if (-not $focused) {${wtTitleMatch}
    if (-not $focused) {
        $wt = Get-Process -Name 'WindowsTerminal' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($wt -and $wt.MainWindowHandle -ne 0) { [WinFocus]::Focus($wt.MainWindowHandle) }
    }
}
`;
}

// Persistent PowerShell process — warm at startup, reused for all focus calls
let psProc = null;
// macOS Accessibility/System Events calls can pile up fast, so serialize focus attempts.
const MAC_FOCUS_THROTTLE_MS = 1500;
const MAC_FOCUS_TIMEOUT_MS = 1500;
let macFocusInFlight = false;
let macFocusLastRunAt = 0;
let macFocusLastPid = null;
let macQueuedFocusRequest = null;
let macFocusCooldownTimer = null;

function initFocusHelper() {
  if (!isWin || psProc) return;
  psProc = spawn("powershell.exe", ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", "-"], {
    windowsHide: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  // Set UTF-8 input encoding so Chinese/CJK window titles match correctly,
  // then pre-compile the C# type (once, ~500ms, non-blocking)
  psProc.on("error", () => { psProc = null; }); // Spawn failure (powershell.exe not found, etc.)
  psProc.stdin.on("error", () => {}); // Suppress EPIPE if process exits unexpectedly
  psProc.stdin.write("[Console]::InputEncoding = [System.Text.Encoding]::UTF8\n");
  psProc.stdin.write(PS_FOCUS_ADDTYPE + "\n");
  psProc.on("exit", () => { psProc = null; });
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

function executeMacFocusRequest(request) {
  macFocusInFlight = true;
  macFocusLastRunAt = Date.now();
  macFocusLastPid = request.sourcePid;

  const finalize = () => {
    macFocusInFlight = false;
    if (macQueuedFocusRequest) flushQueuedMacFocus();
  };

  focusTerminalWindowLegacy(request.sourcePid, request.cwd, finalize, request.pidChain);
  scheduleTerminalTabFocus(request.editor, request.pidChain);
}

function requestMacFocus(sourcePid, cwd, editor, pidChain) {
  const elapsed = Date.now() - macFocusLastRunAt;
  const inCooldown = elapsed < MAC_FOCUS_THROTTLE_MS;
  if (inCooldown && macFocusLastPid === sourcePid) return;

  const request = { sourcePid, cwd, editor, pidChain };
  if (macFocusInFlight) {
    macQueuedFocusRequest = request;
    return;
  }

  if (inCooldown) {
    macQueuedFocusRequest = request;
    scheduleQueuedMacFocus(MAC_FOCUS_THROTTLE_MS - elapsed);
    return;
  }

  macQueuedFocusRequest = null;
  clearMacFocusCooldownTimer();
  executeMacFocusRequest(request);
}

function focusTerminalWindow(sourcePid, cwd, editor, pidChain) {
  if (!sourcePid) return;

  if (isMac) {
    requestMacFocus(sourcePid, cwd, editor, pidChain);
    return;
  }

  if (isLinux) {
    focusTerminalWindowLegacy(sourcePid, cwd);
    scheduleTerminalTabFocus(editor, pidChain);
    return;
  }

  // Grant PowerShell helper permission to call SetForegroundWindow.
  // This must happen HERE — Electron just received user input (click/hotkey),
  // so it has foreground privilege to delegate.
  if (ctx._allowSetForeground && psProc && psProc.pid) {
    try { ctx._allowSetForeground(psProc.pid); } catch {}
  }

  // Legacy focus for reliable window activation (ALT key trick + SetForegroundWindow)
  focusTerminalWindowLegacy(sourcePid, cwd);

  // VS Code / Cursor: request precise terminal tab switch via extension's HTTP server.
  // Delayed so legacy PowerShell focus completes first (it's fire-and-forget via stdin).
  scheduleTerminalTabFocus(editor, pidChain);
}

// ── Mac-only: specialized focus paths ────────────────────────────────────────
// These cover terminal hosts the generic `set frontmost of process` script
// cannot reach correctly:
//   • Superset.app — multi-workspace Electron host. Generic frontmost only
//     activates the app, not the specific worktree workspace. Resolved via the
//     reverse-engineered `superset://workspace/<id>` URL scheme (observed
//     2026-05-08).
//   • iTerm2 — multiple sessions per window. Match by tty so the right tab
//     is selected even when many shells share one window.
//   • Ghostty — no public IPC; rely on window title containing the cwd
//     basename. Users need a shell prompt that updates the OSC 2 title.

function findSupersetDataDirs() {
  // Superset by default lives in ~/.superset, but custom instances use
  // `~/.superset-<name>` and the matching URL scheme `superset-<name>://`.
  try {
    const home = os.homedir();
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
  return base === ".superset" ? "superset" : `superset-${base.slice(".superset-".length)}`;
}

function querySupersetWorkspaceId(dbPath, cwd) {
  if (!cwd) return null;
  const candidates = [cwd];
  try {
    const real = fs.realpathSync(cwd);
    if (real && real !== cwd) candidates.push(real);
  } catch {}
  for (const candidate of candidates) {
    const escaped = candidate.replace(/'/g, "''");
    const sql = `SELECT ws.id FROM workspaces ws JOIN worktrees w ON w.id = ws.worktree_id WHERE w.path = '${escaped}' ORDER BY COALESCE(ws.last_opened_at, 0) DESC LIMIT 1;`;
    try {
      const out = execFileSync("sqlite3", ["-readonly", dbPath, sql], {
        encoding: "utf8",
        timeout: 1500,
      }).trim();
      if (out) return out;
    } catch {}
  }
  return null;
}

function tryFocusSuperset(cwd, callback) {
  if (!cwd) return callback(false);
  const dirs = findSupersetDataDirs();
  if (!dirs.length) return callback(false);
  for (const dir of dirs) {
    const id = querySupersetWorkspaceId(path.join(dir, "local.db"), cwd);
    if (!id) continue;
    const url = `${supersetSchemeForDir(dir)}://workspace/${id}`;
    execFile("/usr/bin/open", [url], { timeout: 1500 }, (err) => {
      if (err) console.warn("focusSuperset failed:", err.message);
      callback(!err);
    });
    return;
  }
  callback(false);
}

function getTtyFromPids(pids) {
  for (const pid of pids) {
    if (!Number.isFinite(pid) || pid <= 0) continue;
    try {
      const out = execFileSync("ps", ["-o", "tty=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 500,
      }).trim();
      if (out && out !== "??" && out !== "?" && out !== "-") return out;
    } catch {}
  }
  return null;
}

function isAppRunning(processName, callback) {
  const escaped = processName.replace(/"/g, '\\"');
  const script = `tell application "System Events" to return (name of processes) contains "${escaped}"`;
  execFile("osascript", ["-e", script], { timeout: 1000 }, (err, stdout) => {
    if (err) return callback(false);
    callback(/true/i.test(String(stdout).trim()));
  });
}

function tryFocusITerm(pidCandidates, callback) {
  isAppRunning("iTerm2", (running) => {
    if (!running) return callback(false);
    const tty = getTtyFromPids(pidCandidates);
    if (!tty) return callback(false);
    // tty from `ps` is "ttys001"; iTerm exposes "/dev/ttys001". Match by suffix.
    const ttyEsc = tty.replace(/"/g, '\\"');
    const script = `
      tell application "iTerm2"
        activate
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if tty of s ends with "${ttyEsc}" then
                select s
                return "ok"
              end if
            end repeat
          end repeat
        end repeat
        return "miss"
      end tell`;
    execFile("osascript", ["-e", script], { timeout: MAC_FOCUS_TIMEOUT_MS }, (err, stdout) => {
      if (err) return callback(false);
      callback(/^ok/.test(String(stdout).trim()));
    });
  });
}

function tryFocusGhostty(cwd, callback) {
  if (!cwd) return callback(false);
  isAppRunning("ghostty", (running) => {
    if (!running) return callback(false);
    const title = path.basename(cwd);
    if (!title) return callback(false);
    const titleEsc = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `
      tell application "ghostty" to activate
      tell application "System Events"
        tell process "ghostty"
          repeat with w in windows
            try
              if title of w contains "${titleEsc}" then
                perform action "AXRaise" of w
                return "ok"
              end if
            end try
          end repeat
        end tell
      end tell
      return "miss"`;
    execFile("osascript", ["-e", script], { timeout: MAC_FOCUS_TIMEOUT_MS }, (err, stdout) => {
      if (err) return callback(false);
      callback(/^ok/.test(String(stdout).trim()));
    });
  });
}

function trySpecialMacFocus(sourcePid, cwd, pidChain, callback) {
  const pidCandidates = [sourcePid];
  if (Array.isArray(pidChain)) {
    for (const pid of pidChain) {
      if (!Number.isFinite(pid) || pid <= 0 || pidCandidates.includes(pid)) continue;
      pidCandidates.push(pid);
    }
  }
  tryFocusSuperset(cwd, (ok) => {
    if (ok) return callback(true);
    tryFocusITerm(pidCandidates, (ok2) => {
      if (ok2) return callback(true);
      tryFocusGhostty(cwd, (ok3) => callback(!!ok3));
    });
  });
}

function runGenericMacFocus(pidCandidates, onDone) {
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
}

function focusTerminalWindowLegacy(sourcePid, cwd, onDone, pidChain) {
  if (isMac) {
    const pidCandidates = [sourcePid];
    if (Array.isArray(pidChain)) {
      for (const pid of pidChain) {
        if (!Number.isFinite(pid) || pid <= 0 || pidCandidates.includes(pid)) continue;
        pidCandidates.push(pid);
        if (pidCandidates.length >= 3) break;
      }
    }

    // Try Superset / iTerm2 / Ghostty in order; fall back to generic
    // osascript frontmost when no specialized path matches. Each step is
    // best-effort and short-circuits the chain on success.
    trySpecialMacFocus(sourcePid, cwd, pidChain, (focused) => {
      if (focused) { if (onDone) onDone(); return; }
      runGenericMacFocus(pidCandidates, onDone);
    });
    return;
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
    return;
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
  } else {
    // Fallback: one-shot PowerShell if persistent process died
    psProc = null;
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      PS_FOCUS_ADDTYPE + cmd],
      { windowsHide: true, timeout: 5000 },
      (err) => { if (err) console.warn("focusTerminal failed:", err.message); }
    );
    // Re-init persistent process for next call
    initFocusHelper();
  }
}

function cleanup() {
  killFocusHelper();
  clearMacFocusCooldownTimer();
  macQueuedFocusRequest = null;
  macFocusInFlight = false;
}

return { initFocusHelper, killFocusHelper, focusTerminalWindow, clearMacFocusCooldownTimer, cleanup };

};
