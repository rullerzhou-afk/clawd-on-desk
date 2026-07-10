// hooks/shared-process.js — Shared process tree walk, stdin reader, platform config
// Used by hook scripts (clawd, copilot, cursor, gemini, kiro, codebuddy).
// Zero third-party dependencies — only Node built-ins.

// ── Base platform constants ──────────────────────────────────────────────────

const BASE_TERMINAL_NAMES_WIN = [
  "windowsterminal.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
  "conhost.exe", "openconsole.exe",
  "code.exe", "alacritty.exe", "wezterm-gui.exe", "mintty.exe",
  "conemu64.exe", "conemu.exe", "hyper.exe", "tabby.exe",
  "antigravity.exe", "warp.exe", "iterm.exe", "ghostty.exe",
];
const BASE_TERMINAL_NAMES_MAC = [
  "terminal", "iterm2", "alacritty", "wezterm-gui", "kitty",
  "hyper", "tabby", "warp", "ghostty",
];
const BASE_TERMINAL_NAMES_LINUX = [
  "gnome-terminal", "kgx", "konsole", "xfce4-terminal", "tilix",
  "alacritty", "wezterm", "wezterm-gui", "kitty", "ghostty",
  "xterm", "lxterminal", "terminator", "tabby", "hyper", "warp",
];

const SYSTEM_BOUNDARY_WIN = new Set(["explorer.exe", "services.exe", "winlogon.exe", "svchost.exe"]);
const SYSTEM_BOUNDARY_MAC = new Set(["launchd", "init", "systemd"]);
const SYSTEM_BOUNDARY_LINUX = new Set(["systemd", "init"]);

const BASE_EDITOR_MAP_WIN = { "code.exe": "code", "cursor.exe": "cursor" };
const BASE_EDITOR_MAP_MAC = { "code": "code", "cursor": "cursor" };
const BASE_EDITOR_MAP_LINUX = { "code": "code", "cursor": "cursor", "code-insiders": "code" };

const DEFAULT_EDITOR_PATH_CHECKS = [
  ["visual studio code", "code"],
  ["cursor.app", "cursor"],
];
const WINDOWS_TERMINAL_WINDOW_CLASS = "CASCADIA_HOSTING_WINDOW_CLASS";
const WINDOWS_TERMINAL_PROCESS_NAMES = new Set(["windowsterminal.exe", "windowsterminalpreview.exe"]);

function normalizeTmuxSocketPath(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 4096 || !text.startsWith("/")) return null;
  return /[\0\r\n]/.test(text) ? null : text;
}

function normalizeTmuxClientTarget(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 256 || text.startsWith("-")) return null;
  return /^[\w./:-]+$/.test(text) ? text : null;
}

// $TMUX is "<socket>,<serverPid>,<sessionN>"; the first field is the socket
// path used for `tmux -S <socket>` focus. Pure env parse, no subprocess — safe
// to call from a cache-hit path that skips the full resolve() walk.
function tmuxSocketFromEnv() {
  if (!process.env.TMUX) return null;
  return normalizeTmuxSocketPath(process.env.TMUX.split(",")[0]);
}

// Liveness probe with ZERO subprocess spawn: process.kill(pid, 0) is a syscall,
// not a spawn (so it never risks the WindowsTerminal console flash this whole
// change exists to avoid). ESRCH => process gone; EPERM => alive but not ours.
// Cannot detect PID reuse (same limitation as src/state.js isProcessAlive) —
// callers pair it with session-scoped cache invalidation. See
// docs/plans/plan-issue-627-hook-snapshot-flash-cache.md.
function processAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === "EPERM");
  }
}

// ── getPlatformConfig ────────────────────────────────────────────────────────
// Returns { terminalNames: Set, systemBoundary: Set, editorMap: Object, editorPathChecks: Array }
// Options:
//   extraTerminals: { win?: string[], mac?: string[], linux?: string[] }
//   extraEditors:   { win?: Object, mac?: Object, linux?: Object }
//   extraEditorPathChecks: [pattern, editor][]  — prepended before defaults (macOS/Linux full path)

function getPlatformConfig(options) {
  const opts = options || {};
  const isWin = process.platform === "win32";
  const isLinux = process.platform === "linux";

  const pick = (win, linux, mac) => isWin ? win : (isLinux ? linux : mac);

  // Terminal names
  const baseTerminals = pick(BASE_TERMINAL_NAMES_WIN, BASE_TERMINAL_NAMES_LINUX, BASE_TERMINAL_NAMES_MAC);
  const et = opts.extraTerminals;
  const extraT = et && pick(et.win, et.linux, et.mac);
  const terminalNames = extraT && extraT.length ? new Set([...baseTerminals, ...extraT]) : new Set(baseTerminals);

  // System boundary (no extras)
  const systemBoundary = pick(SYSTEM_BOUNDARY_WIN, SYSTEM_BOUNDARY_LINUX, SYSTEM_BOUNDARY_MAC);

  // Editor map
  const baseEditors = pick(BASE_EDITOR_MAP_WIN, BASE_EDITOR_MAP_LINUX, BASE_EDITOR_MAP_MAC);
  const ee = opts.extraEditors;
  const extraE = ee && pick(ee.win, ee.linux, ee.mac);
  const editorMap = extraE ? { ...baseEditors, ...extraE } : baseEditors;

  // Editor path checks (macOS/Linux full comm path matching)
  const editorPathChecks = opts.extraEditorPathChecks
    ? [...opts.extraEditorPathChecks, ...DEFAULT_EDITOR_PATH_CHECKS]
    : DEFAULT_EDITOR_PATH_CHECKS;

  return { terminalNames, systemBoundary, editorMap, editorPathChecks };
}

// ── createPidResolver ────────────────────────────────────────────────────────
// Factory that returns a resolve() function. First call walks the process tree;
// subsequent calls return the cached result.
//
// Options:
//   platformConfig       — result of getPlatformConfig()
//   agentNames           — { win: Set, mac: Set, linux?: Set }  (linux falls back to mac)
//   agentCmdlineCheck    — (cmdline: string) => boolean  (optional, for node.exe cmdline probes)
//   startPid             — number (default process.ppid)
//   maxDepth             — number (default 8)

function normalizeHwndString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!/^[1-9]\d{0,18}$/.test(text)) return null;
  try {
    return BigInt(text) <= 9223372036854775807n ? text : null;
  } catch {
    return null;
  }
}

const WINDOWS_PROCESS_SNAPSHOT_SCRIPT = `
$typeDef = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ClawdWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
Add-Type -TypeDefinition $typeDef
$fg = [ClawdWin32]::GetForegroundWindow()
if ($fg -ne [IntPtr]::Zero) {
  $root = [ClawdWin32]::GetAncestor($fg, 2)
  if ($root -ne [IntPtr]::Zero) { $fg = $root }
}
$fgPid = 0
$fgClass = ""
if ($fg -ne [IntPtr]::Zero) {
  [void][ClawdWin32]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $sb = New-Object System.Text.StringBuilder 256
  [void][ClawdWin32]::GetClassName($fg, $sb, $sb.Capacity)
  $fgClass = $sb.ToString()
}
$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
[pscustomobject]@{
  processes = $processes
  foreground = [pscustomobject]@{
    hwnd = if ($fg -eq [IntPtr]::Zero) { $null } else { $fg.ToInt64().ToString() }
    pid = $fgPid
    className = $fgClass
  }
} | ConvertTo-Json -Compress -Depth 4
`;

// One PS spawn per resolve, not per ancestor — PowerShell cold-start (~270 ms)
// would dominate the walk otherwise. Returns an empty process map on failure.
function getWindowsProcessSnapshot(execFileSync) {
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        // -WindowStyle Hidden is belt-and-suspenders alongside windowsHide:
        // when Windows Terminal is the OS default terminal app, its console
        // delegation does not always honor CREATE_NO_WINDOW (#627), and the
        // in-process flag shortens any window that still leaks through.
        "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
        WINDOWS_PROCESS_SNAPSHOT_SCRIPT,
      ],
      { encoding: "utf8", timeout: 3000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    );
    const trimmed = (out || "").trim();
    if (!trimmed) return { processes: new Map(), foregroundWtHwnd: null };
    const parsed = JSON.parse(trimmed);
    const foreground = parsed && !Array.isArray(parsed)
      ? (parsed.foreground || parsed.Foreground || null)
      : null;
    const rawList = parsed && !Array.isArray(parsed)
      ? (parsed.processes || parsed.Processes)
      : parsed;
    const list = Array.isArray(rawList) ? rawList : (rawList ? [rawList] : []);
    const map = new Map();
    for (const proc of list) {
      const pid = Number(proc && proc.ProcessId);
      if (!Number.isFinite(pid)) continue;
      map.set(pid, {
        name: typeof proc.Name === "string" ? proc.Name.toLowerCase() : "",
        ppid: Number(proc.ParentProcessId) || 0,
        commandLine: typeof proc.CommandLine === "string" ? proc.CommandLine : "",
      });
    }
    const foregroundPid = Number(foreground && (foreground.pid ?? foreground.Pid));
    const foregroundClass = String(
      (foreground && (foreground.className ?? foreground.ClassName)) || ""
    );
    const foregroundProc = Number.isFinite(foregroundPid) ? map.get(foregroundPid) : null;
    const foregroundHwnd = normalizeHwndString(foreground && (foreground.hwnd ?? foreground.Hwnd));
    const foregroundWtHwnd = foregroundHwnd
      && foregroundClass.toLowerCase() === WINDOWS_TERMINAL_WINDOW_CLASS.toLowerCase()
      && foregroundProc
      && WINDOWS_TERMINAL_PROCESS_NAMES.has(foregroundProc.name)
        ? foregroundHwnd
        : null;
    return { processes: map, foregroundWtHwnd };
  } catch {
    return { processes: new Map(), foregroundWtHwnd: null };
  }
}

function createPidResolver(options) {
  const { platformConfig } = options;
  const { terminalNames, systemBoundary, editorMap, editorPathChecks } = platformConfig;
  const startPid = options.startPid || process.ppid;
  const maxDepth = options.maxDepth || 8;

  const isWin = process.platform === "win32";
  const isLinux = process.platform === "linux";
  const pick = (win, linux, mac) => isWin ? win : (isLinux ? linux : mac);

  const an = options.agentNames;
  const agentNameSet = an ? (pick(an.win, an.linux || an.mac, an.mac) || null) : null;
  const agentCmdlineCheck = options.agentCmdlineCheck || null;

  let _cached = null;

  return function resolve() {
    if (_cached) return _cached;

    const { execFileSync } = require("child_process");
    const winSnapshotResult = isWin ? getWindowsProcessSnapshot(execFileSync) : null;
    const winSnapshot = winSnapshotResult ? winSnapshotResult.processes : null;
    const foregroundWtHwnd = winSnapshotResult ? winSnapshotResult.foregroundWtHwnd : null;

    let pid = startPid;
    let lastGoodPid = pid;
    let terminalPid = null;
    let detectedEditor = null;
    let agentPid = null;
    let agentCommandLine = "";
    const pidChain = [];

    for (let i = 0; i < maxDepth; i++) {
      let name, parentPid, commandLine = "";
      try {
        if (isWin) {
          const info = winSnapshot.get(pid);
          if (!info) break;
          name = info.name;
          parentPid = info.ppid;
          commandLine = info.commandLine;
        } else {
          const ppidOut = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 }).trim();
          const commOut = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 }).trim();
          name = require("path").basename(commOut).toLowerCase();
          if (!detectedEditor) {
            const fullLower = commOut.toLowerCase();
            for (const [pattern, editor] of editorPathChecks) {
              if (fullLower.includes(pattern)) { detectedEditor = editor; break; }
            }
          }
          parentPid = parseInt(ppidOut, 10);
        }
      } catch { break; }

      pidChain.push(pid);
      if (!detectedEditor && editorMap[name]) detectedEditor = editorMap[name];

      if (!agentPid) {
        if (agentNameSet && agentNameSet.has(name)) {
          agentPid = pid;
          if (isWin) {
            agentCommandLine = commandLine;
          } else {
            try {
              agentCommandLine = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 500 });
            } catch {}
          }
        } else if (agentCmdlineCheck && (name === "node.exe" || name === "node")) {
          try {
            const cmdOut = isWin
              ? commandLine
              : execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 500 });
            if (agentCmdlineCheck(cmdOut)) {
              agentPid = pid;
              agentCommandLine = cmdOut;
            }
          } catch {}
        }
      }

      if (systemBoundary.has(name)) break;
      if (terminalNames.has(name)) terminalPid = pid;
      lastGoodPid = pid;
      if (!parentPid || parentPid === pid || parentPid <= 1) break;
      pid = parentPid;
    }

    let tmuxClient = null;
    if (!isWin && !terminalPid && process.env.TMUX && process.env.TMUX_PANE) {
      const tmuxParts = process.env.TMUX.split(",");
      const tmuxServerPid = tmuxParts.length >= 2 ? parseInt(tmuxParts[1], 10) : 0;
      const walkReachedTmux = tmuxServerPid > 1 && pidChain.includes(tmuxServerPid);
      if (walkReachedTmux) {
        try {
          const raw = execFileSync(
            "tmux", ["list-clients", "-t", process.env.TMUX_PANE, "-F", "#{client_pid}\t#{client_tty}"],
            { encoding: "utf8", timeout: 500 }
          );
          const clients = raw.split("\n")
            .map((line) => {
              const parts = line.split("\t");
              const pid = parseInt((parts[0] || "").trim(), 10);
              return {
                pid,
                target: normalizeTmuxClientTarget(parts.slice(1).join("\t")),
              };
            })
            .filter(c => Number.isFinite(c.pid) && c.pid > 1);
          outer: for (const client of clients) {
            let walkPid = client.pid;
            const localAdds = [];
            for (let t = 0; t < 4; t++) {
              let tName, tParent;
              try {
                const tComm = execFileSync("ps", ["-o", "comm=", "-p", String(walkPid)],
                  { encoding: "utf8", timeout: 500 }).trim();
                tName = require("path").basename(tComm).toLowerCase();
                tParent = parseInt(
                  execFileSync("ps", ["-o", "ppid=", "-p", String(walkPid)],
                    { encoding: "utf8", timeout: 500 }).trim(), 10);
              } catch { break; }
              if (terminalNames.has(tName)) {
                terminalPid = walkPid;
                tmuxClient = client.target;
                pidChain.push(...localAdds, walkPid);
                break outer;
              }
              if (!tParent || tParent <= 1 || tParent === walkPid) break;
              localAdds.push(walkPid);
              walkPid = tParent;
            }
          }
        } catch {}
      }
    }

    const tmuxSocket = tmuxSocketFromEnv();

    // provenance for the cross-process pid cache (#627). snapshotOk = the
    // Windows Get-CimInstance snapshot actually returned processes; terminalPid
    // = the raw terminal match BEFORE the `|| lastGoodPid` fallback. Callers use
    // these to refuse caching a degraded walk (empty snapshot → stablePid
    // silently decays to process.ppid) instead of reverse-inferring from
    // stablePid. Non-Windows has no snapshot step, so snapshotOk is trivially true.
    const snapshotOk = isWin ? !!(winSnapshot && winSnapshot.size > 0) : true;
    _cached = { stablePid: terminalPid || lastGoodPid, terminalPid, snapshotOk, agentPid, agentCommandLine, detectedEditor, pidChain, foregroundWtHwnd, tmuxSocket, tmuxClient };
    return _cached;
  };
}

// ── readStdinJson ────────────────────────────────────────────────────────────
// Reads stdin until EOF, parses JSON. EOF-driven with a safety-net timer.
// The default stays at 400ms: several agent hooks (cursor, codebuddy, gemini,
// reasonix) run their own ~800ms stdout safety timers and non-async hot-path
// registrations, so a longer shared default would let those timers win the
// race and drop payloads that used to be parsed at 400ms. Callers whose agent
// registration tolerates a longer stall (claude-code: async + 5s hook timeout)
// opt in via options.timeoutMs. Returns {} on parse failure or timeout.
//
// readStdinJsonDetailed() additionally reports what the read saw (bytes
// received, timed out, parse/stream error, duration) so a missing session_id
// can be triaged from logs: "never arrived" (bytes:0, timeout) vs "arrived
// broken" (bytes>0, parse error) point at entirely different culprits (#583).

const DEFAULT_STDIN_READ_TIMEOUT_MS = 400;

function readStdinJsonDetailed(options = {}) {
  const stream = options.stream || process.stdin;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_STDIN_READ_TIMEOUT_MS;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const chunks = [];
    let done = false;
    let timer = null;
    let streamError = null;

    const onData = (c) => chunks.push(c);
    const onEnd = () => finish(false);
    // Without this, an emitted 'error' would crash the hook (unhandled stream
    // error) and the promise would never settle. Resolve with what we have.
    const onError = (err) => {
      streamError = String((err && err.message) || "stream error").slice(0, 120);
      finish(false);
    };
    function finish(timedOut) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      const raw = Buffer.concat(chunks);
      let payload = {};
      let parseError = null;
      try {
        let text = raw.toString();
        // A PowerShell/.NET intermediary can prefix the payload with a UTF-8
        // BOM (#638); trim() below would hide it but JSON.parse rejects it.
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        if (text.trim()) payload = JSON.parse(text);
      } catch (err) {
        parseError = String((err && err.message) || "parse error").slice(0, 120);
      }
      if (streamError) parseError = `stream error: ${streamError}`;
      resolve({
        payload,
        bytes: raw.length,
        timedOut: timedOut === true,
        parseError,
        durationMs: Date.now() - startedAt,
      });
    }

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    timer = setTimeout(() => finish(true), timeoutMs);
  });
}

function readStdinJson() {
  return readStdinJsonDetailed().then((result) => result.payload);
}

function buildElectronLaunchConfig(projectDir, options = {}) {
  const platform = options.platform || process.platform;
  const env = { ...(options.env || process.env) };
  delete env.ELECTRON_RUN_AS_NODE;

  const disableSandbox = platform === "linux" && env.CLAWD_DISABLE_SANDBOX === "1";
  if (disableSandbox) {
    env.ELECTRON_DISABLE_SANDBOX = "1";
    env.CHROME_DEVEL_SANDBOX = "";
  }

  const entry = typeof options.entry === "string" ? options.entry : ".";
  const forwardedArgs = Array.isArray(options.forwardedArgs) ? options.forwardedArgs : [];
  const args = disableSandbox
    ? [entry, "--no-sandbox", "--disable-setuid-sandbox", ...forwardedArgs]
    : [entry, ...forwardedArgs];

  return { args, env, cwd: projectDir };
}

module.exports = {
  getPlatformConfig,
  createPidResolver,
  readStdinJson,
  readStdinJsonDetailed,
  DEFAULT_STDIN_READ_TIMEOUT_MS,
  buildElectronLaunchConfig,
  tmuxSocketFromEnv,
  processAlive,
};
