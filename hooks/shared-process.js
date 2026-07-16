// hooks/shared-process.js — Shared process tree walk, stdin reader, platform config
// Used by hook scripts (clawd, copilot, cursor, gemini, kiro, codebuddy).
// Zero third-party dependencies — Node built-ins plus the sibling hook helpers
// registered in both deployment manifests (./server-config, lazily ./pid-cache).
// server-config.js does NOT require this module, so there is no cycle.

const { isRemoteHookMode, readRuntimeIdentity } = require("./server-config");

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

// ── #681 offline gate + no-degraded contract ─────────────────────────────────
// Two ways the Windows walk can produce no usable metadata, both of which used
// to end in a WRONG-but-plausible PID:
//
//   1. Clawd is not running. The hook still ran the snapshot PowerShell before
//      discovering that nobody would receive the POST — so a normal Quit left
//      every CLI's leftover hook reading the whole machine's process list on
//      every event (#681). The gate below is checked BEFORE
//      require("child_process"), so a clean offline is structurally zero-spawn,
//      not merely fast.
//   2. The snapshot ran but came back empty (spawn blocked, timeout, security
//      software). The walk then broke on the first missing entry, leaving
//      lastGoodPid === startPid, and `terminalPid || lastGoodPid` shipped
//      process.ppid — the per-event ephemeral hook wrapper, not the terminal.
//      Focus would target a dead PID. Omitting beats guessing (plan §4.2).
//
// Both now return UNAVAILABLE_SHAPE. `attempted` distinguishes them: false = we
// never tried (gate), true = we tried and it failed. POSIX never reaches either
// branch — no runtime read, no shape change, ps/tmux untouched.

const SKIP_REASON_OFFLINE = "clawd-offline";
const SKIP_REASON_REMOTE = "clawd-remote";
const SKIP_REASON_SNAPSHOT_FAILED = "snapshot-failed";
// Kept distinct from snapshot-failed on purpose: these two look identical from
// the outside (no metadata) but have opposite causes and opposite fixes. A
// snapshot-failed means the PowerShell never produced rows — security software,
// a timeout, a blocked spawn. A self-not-found means the snapshot worked fine
// and our own process simply was not in it — a stale/racy tree, not a blocked
// one. Collapsing them would send anyone diagnosing "focus stopped working" down
// the wrong path.
const SKIP_REASON_SELF_NOT_FOUND = "snapshot-self-not-found";

// pidChain MUST be [] and never null: six adapters (codex, copilot, cursor,
// kimi, kiro, codebuddy) do a bare `pidChain.length` with no Array.isArray
// guard, and in cursor/codebuddy that TypeError would unwind past
// writeStdoutOnce and silently downgrade their gating stdout ({"continue":true}
// / {"decision":"allow"}) to {}. [] is falsy-length everywhere, so all 13
// adapters skip the field cleanly. stablePid:null is safe to ship: the six
// adapters that assign source_pid unconditionally emit an explicit null, which
// src/server-route-state.js normalizes identically to an absent field
// (Number.isFinite(null) === false), and src/state.js merges it as
// `sourcePid || existing.sourcePid || null` — an already-known PID survives.
function unavailableMetadata(skipReason, attempted) {
  return {
    stablePid: null,
    terminalPid: null,
    snapshotOk: false,
    attempted: attempted === true,
    skipReason,
    agentPid: null,
    agentCommandLine: "",
    detectedEditor: null,
    pidChain: [],
    foregroundWtHwnd: null,
    tmuxSocket: null,
    tmuxClient: null,
  };
}

// ── PR2 (#634) lifecycle-context helpers ──────────────────────────────────────
// These service the resolve({ namespace, sessionId, cacheCwd, lifecycle,
// cacheable }) overload. They are module-level (they need neither the walk nor
// the per-resolver closure state) and are NEVER reached by the compatibility
// no-arg resolve() path, so the 12 not-yet-migrated adapters are untouched.
//
// A cache-HIT / promotion / empty-MISS result must never carry pidChain,
// foregroundWtHwnd, or tmuxClient — none are cached, and faking them would ship
// a dead per-event PID or a stale window handle (plan §6.1). tmuxSocket is a
// pure-env value recomputed on a hit. `cacheSource` (fresh|v2|v1|none) is
// observability only; the compatibility no-arg shape never gains it.

// #681: the context path carries a derived `headless` boolean, and a cache hit's
// agentCommandLine is ALWAYS "" — never the cached raw line, because v2 does not
// store one. Adapters must read `headless` rather than re-deriving from
// agentCommandLine, or a cache hit would silently report every headless session
// as interactive.
function emptyMetadata() {
  return {
    stablePid: null, terminalPid: null, snapshotOk: false, agentPid: null,
    agentCommandLine: "", headless: false, detectedEditor: null, pidChain: [],
    foregroundWtHwnd: null, tmuxSocket: null, tmuxClient: null, cacheSource: "none",
  };
}

function cacheHitMetadata(cached, source) {
  return {
    stablePid: cached.stablePid, terminalPid: null, snapshotOk: true,
    agentPid: cached.agentPid,
    // Deliberately empty: the raw command line is not cached (#681), and
    // reconstructing something plausible here would be worse than nothing.
    agentCommandLine: "",
    headless: cached.headless === true,
    detectedEditor: cached.detectedEditor || null, pidChain: [], foregroundWtHwnd: null,
    tmuxSocket: tmuxSocketFromEnv(), tmuxClient: null, cacheSource: source,
  };
}

// A cached v2 entry is a HIT only when BOTH cached PIDs are still alive: the
// stablePid that becomes source_pid AND the agentPid that tracks session
// liveness. This double check is the ONLY defense against a dead session's
// cache lingering — no clock participates.
function readLiveV2(pidCache, namespace, sessionId, cacheCwd) {
  const c = pidCache.readPidCacheV2(namespace, sessionId, cacheCwd);
  if (c && processAlive(c.stablePid) && processAlive(c.agentPid)) return c;
  return null;
}

// v1 was Claude-only, so only the claude-code namespace ever reads it. The v1
// key uses Claude's RAW session id + RAW payload cwd — which for Claude ARE the
// sessionId + cacheCwd passed here, so we reuse them directly (never a prefixed
// or renormalized value). Returns the SINGLE-observation entry ({ subset,
// identity }) so a caller that conditionally deletes the file binds its
// delete-guard to exactly the bytes it consumed — never a version a concurrent
// writer swapped in between two reads (plan §5.5). null when absent/dead/shape-
// invalid or not the Claude namespace.
function claudeReadLiveV1Entry(pidCache, namespace, sessionId, cacheCwd) {
  if (namespace !== "claude-code") return null;
  const entry = pidCache.readPidCacheEntry(sessionId, cacheCwd);
  if (!entry) return null;
  const v1 = entry.subset;
  if (!processAlive(v1.stablePid) || !processAlive(v1.agentPid)) return null;
  return entry;
}

function claudeDropV1SameKey(pidCache, namespace, sessionId, cacheCwd) {
  if (namespace !== "claude-code") return;
  pidCache.dropPidCache(sessionId, cacheCwd);
}

// Convert a legacy v1 subset into the sanitized v2 subset (#681). This is the
// ONLY place a cached agentCommandLine is read, and the boolean it produces is
// the only thing that survives the call. Everything downstream — the v2 write,
// the returned metadata, the HTTP body, any log — sees the boolean.
function sanitizeV1Subset(v1, deriveHeadless) {
  return {
    stablePid: v1.stablePid,
    agentPid: v1.agentPid,
    headless: deriveHeadless(v1.agentCommandLine),
    detectedEditor: v1.detectedEditor || null,
  };
}

// Delete a v1 file ONLY if its mtimeMs + size + raw content are all unchanged
// since `identity` was taken (plan §5.5). Any change means a concurrent
// SessionStart replaced it; leave it for the sweep rather than strand a live
// cache. No identity recorded → never delete.
function deleteV1IfUnchanged(v1File, identity) {
  if (!identity) return;
  const fs = require("fs");
  try {
    const st = fs.statSync(v1File);
    if (st.mtimeMs !== identity.mtimeMs || st.size !== identity.size) return;
    if (fs.readFileSync(v1File, "utf8") !== identity.raw) return;
    fs.unlinkSync(v1File);
  } catch {
    /* gone / raced — fine */
  }
}

// v1→v2 in-place promotion on a v2 miss (Claude only). Returns cache-hit
// metadata (ZERO spawn) on success, or null to fall through to the lifecycle's
// normal miss handling.
//
// #681 changed the failure ordering that #634 shipped. #634 kept v1 whenever the
// v2 write did not land ("keep it for a later attempt / the sweep"), which is
// the right call when v1 and v2 hold the same data. They no longer do: v1 is the
// only file with the agent's raw command line, and v2 is the sanitized
// replacement. Keeping v1 to save a possible future re-resolve would mean the
// raw line survives in %TEMP% for the rest of the session — precisely what this
// slice removes. So v1 is deleted in EVERY branch (created / raced / failed);
// the current event is unaffected because its sanitized metadata is already in
// memory, and the worst case is one fresh re-resolve on some later event. That
// re-resolve is still gated: a clean offline stays zero-spawn (plan §4.4.6).
//
// Unchanged from #634, and load-bearing:
//   - the promoted content and the delete-guard come from ONE observation, so a
//     v1 a concurrent writer swaps in after we read is never deleted;
//   - recheck v2 first, then write no-clobber, so a concurrent fresh
//     SessionStart v2 is preferred and never overwritten (plan §6.10).
function claudePromote(pidCache, namespace, sessionId, cacheCwd, deriveHeadless) {
  // The subset we promote AND the identity we later delete-guard on both come
  // from this ONE read, so a v1 a concurrent writer swaps in after we read is
  // never promoted-over and deleted (High: identity must bind the read).
  const entry = claudeReadLiveV1Entry(pidCache, namespace, sessionId, cacheCwd);
  if (!entry) return null;
  const v1File = pidCache.cacheFilePath(sessionId, cacheCwd);
  // Derived HERE, in memory, from the legacy line — the only place a v1's
  // agentCommandLine is ever touched, and it does not outlive this expression.
  const sanitized = sanitizeV1Subset(entry.subset, deriveHeadless);

  // A concurrent SessionStart may already have written a fresher (already
  // sanitized) v2. Prefer it — but still drop our legacy v1.
  const existing = readLiveV2(pidCache, namespace, sessionId, cacheCwd);
  if (existing) {
    deleteV1IfUnchanged(v1File, entry.identity);
    return cacheHitMetadata(existing, "v2");
  }

  const writeResult = pidCache.writePidCacheV2IfAbsent(namespace, sessionId, cacheCwd, sanitized);
  // Privacy-first, in all three outcomes. Identity-bound, so a concurrently
  // replaced v1 still survives to be promoted by whoever wrote it.
  deleteV1IfUnchanged(v1File, entry.identity);

  if (writeResult === "exists") {
    // A concurrent writer won the create: prefer their live v2, else fall back
    // to our own in-memory sanitized subset. Still zero spawn either way.
    const raced = readLiveV2(pidCache, namespace, sessionId, cacheCwd);
    return raced ? cacheHitMetadata(raced, "v2") : cacheHitMetadata(sanitized, "v1");
  }
  // "created", or false (write failed) → serve this event from memory.
  return cacheHitMetadata(sanitized, "v1");
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

  // #681 seams. Injected so tests never read the real ~/.clawd/runtime.json and
  // never depend on whether the developer's Clawd happens to be running.
  const readRuntimeIdentityFn = options.readRuntimeIdentity || readRuntimeIdentity;
  const gateEnv = options.env || process.env;

  // #681: the ONE thing anything derived from the agent's command line. Owned by
  // the resolver now (rather than the adapter) because the resolver is what
  // writes the cache, and the cache must store the boolean instead of the line.
  // Adapters that pass no headlessCheck simply never report headless — same as
  // today, since only Claude ever did.
  const headlessCheck = typeof options.headlessCheck === "function" ? options.headlessCheck : null;
  const deriveHeadless = (cmdline) => (headlessCheck ? headlessCheck(cmdline || "") === true : false);

  let _cached = null;

  // Why the Windows walk may not run at all (#681). Returns a skipReason, or
  // null to proceed. ZERO spawn on every path: isRemoteHookMode is an env read,
  // readRuntimeIdentity is one readFileSync + JSON.parse, and processAlive is
  // kill(pid, 0) — a syscall, not a process creation.
  //
  // ownerPid liveness is a LIVENESS hint, not an ownership proof. processAlive
  // maps EPERM to "alive" (a PID we may not signal still exists), which says
  // nothing about whether that PID is still Clawd. PID reuse, and an Electron
  // owner that outlives its HTTP server, stay explicit residuals — see plan
  // §14.1. Do not describe this as authentication.
  function windowsSkipReason() {
    if (isRemoteHookMode({ env: gateEnv })) return SKIP_REASON_REMOTE;
    const identity = readRuntimeIdentityFn();
    if (!identity || !identity.ok) return SKIP_REASON_OFFLINE;
    if (!processAlive(identity.ownerPid)) return SKIP_REASON_OFFLINE;
    return null;
  }

  // The platform process-tree snapshot. Extracted so the compatibility no-arg
  // resolve() and the PR2 lifecycle context share ONE implementation and ONE
  // spawn. On success it returns the exact 5c2b1f0 10-field shape (NO
  // cacheSource): the no-arg path stays byte-for-byte for the 12 not-yet-migrated
  // adapters. The two #681 failure paths return the 12-field unavailable shape
  // instead of a degraded PID.
  function computeFreshSnapshot() {
    // MUST precede require("child_process") — this line is the whole point of
    // the gate. Moving it below the require re-introduces #681: the module load
    // itself is harmless, but every edit that follows tends to drift the
    // execFileSync call up with it.
    if (isWin) {
      const skipReason = windowsSkipReason();
      if (skipReason) return unavailableMetadata(skipReason, false);
    }

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
    // these to refuse caching a degraded walk instead of reverse-inferring from
    // stablePid. Non-Windows has no snapshot step, so snapshotOk is trivially true.
    const snapshotOk = isWin ? !!(winSnapshot && winSnapshot.size > 0) : true;

    // #681 no-degraded. `terminalPid || lastGoodPid` falls back to the untouched
    // startPid — the ephemeral per-event hook wrapper, dead by the time anyone
    // clicks it — whenever the walk read nothing. TWO different ways to get
    // there, and checking only the first is not enough:
    //
    //   (a) the snapshot came back empty (spawn blocked, timeout, no rows), or
    //   (b) the snapshot came back FULL of other processes but WITHOUT our own
    //       startPid, so the very first winSnapshot.get() missed and the loop
    //       broke at i=0. snapshotOk is true here, which is exactly what makes
    //       (b) the sharper trap.
    //
    // A wrong pid is worse than no pid: src/state.js merges
    // `sourcePid || existing.sourcePid`, so a truthy-but-wrong value does not
    // merely fail to help — it OVERWRITES a correct pid the server already knew,
    // and click-to-focus starts targeting a dead process for the rest of the
    // session. pidChain is appended only after a row is genuinely read, so a
    // non-empty chain is the proof that the walk verified at least itself.
    //
    // Case (b) also discards a possibly-real foregroundWtHwnd, which the empty
    // map of case (a) could never have produced. That is deliberate: if we
    // cannot locate our own process, we have no session to attach a foreground
    // window to, and guessing would mis-attribute whatever window the user
    // happens to have in front.
    if (isWin && !snapshotOk) return unavailableMetadata(SKIP_REASON_SNAPSHOT_FAILED, true);
    if (isWin && pidChain.length === 0) return unavailableMetadata(SKIP_REASON_SELF_NOT_FOUND, true);

    return { stablePid: terminalPid || lastGoodPid, terminalPid, snapshotOk, agentPid, agentCommandLine, detectedEditor, pidChain, foregroundWtHwnd, tmuxSocket, tmuxClient };
  }

  // Compatibility no-arg path (SessionStart prewarm + the 12 not-yet-migrated
  // adapters): byte-for-byte with 5c2b1f0 — first call snapshots, later calls
  // return the SAME cached object. It performs ZERO cache
  // read/write/touch/drop/promotion/sweep and never produces a clawd-pidcache2-*
  // file; all disk-cache orchestration lives behind the context overload below.
  function freshResolve() {
    if (_cached) return _cached;
    _cached = computeFreshSnapshot();
    return _cached;
  }

  // ── PR2 (#634) lifecycle context ──
  // Reuses the prewarmed in-process _cached (SessionStart) so a `start` context
  // after a no-arg prewarm never spawns a second time. Spreads into a NEW object
  // (never mutates _cached) so the no-arg shape stays pristine.
  function freshMetadata() {
    const meta = freshResolve();
    return {
      ...meta,
      // #681: derived in memory from the LIVE walk. meta.agentCommandLine stays
      // on the fresh shape (the no-arg red line pins those 10 fields, and it
      // never leaves this process) — but only this boolean is ever written to
      // disk or put on the wire.
      headless: deriveHeadless(meta.agentCommandLine),
      // A gated or failed resolve carries no data — labelling it "fresh" would
      // make the offline path indistinguishable from a real walk in logs.
      cacheSource: meta.snapshotOk ? "fresh" : "none",
    };
  }

  // The sanitized subset persisted to v2. Deliberately built from `meta.headless`
  // rather than meta.agentCommandLine, so there is exactly one derivation point.
  function v2SubsetFrom(meta) {
    return {
      stablePid: meta.stablePid,
      agentPid: meta.agentPid,
      headless: meta.headless === true,
      detectedEditor: meta.detectedEditor,
    };
  }

  // Low-frequency orphan sweep, AT MOST ONCE per resolver instance = per hook
  // process (plan §5.4). Triggered by `start`, or — for adapters that have no
  // start (Antigravity etc., later slices) — by the first successful `event`
  // fresh→v2 population, so every adapter has a cleanup entry point. Zero spawn
  // (kill(pid,0) liveness).
  let _swept = false;
  function maybeSweep(pidCache) {
    if (_swept) return;
    _swept = true;
    pidCache.sweepStalePidCaches({ isProcessAlive: processAlive });
  }

  // start: fresh snapshot (reusing the prewarm), write v2 only when the walk is
  // non-degraded (snapshotOk && agentPid). Low-frequency orphan sweep first,
  // gated on cacheability (matching PR1: SessionStart only swept a cacheable
  // session). The same-key v1 is dropped whether or not the v2 write landed —
  // the same "privacy-first, in all three outcomes" trade claudePromote makes.
  // This REVERSES an earlier baseline that kept v1 on a failed write so the
  // next prompt/event could still promote it: a DEAD v1 (crashed session,
  // resumed sid/cwd) can never be promoted — readLiveV1 wants both PIDs alive —
  // and the sweep has a 24h age floor, so a failed-write start was the only
  // collector its raw command line had. A LIVE v1's promote would have deleted
  // it on the very next event anyway (all three outcomes), so the most this
  // costs the session is one re-fresh — the bounded cost §3 already accepts.
  // The walk-usable condition stays: a degraded walk writes nothing and keeps
  // v1, since promotion is then the session's only remaining cache path. No
  // extra fresh for the cleanup.
  function startLifecycle(pidCache, namespace, sessionId, cacheCwd, canDisk) {
    if (canDisk) maybeSweep(pidCache);
    const meta = freshMetadata();
    if (canDisk && meta.snapshotOk && meta.agentPid) {
      pidCache.writePidCacheV2(namespace, sessionId, cacheCwd, v2SubsetFrom(meta));
      claudeDropV1SameKey(pidCache, namespace, sessionId, cacheCwd);
    }
    return meta;
  }

  // prompt: cache-only, NO fallback. A hit (or a v1→v2 promotion) returns the
  // stable subset; a miss/corrupt/dead/non-cacheable prompt returns empty
  // metadata and NEVER spawns — even when caching is disabled. The foreground WT
  // handle it used to fresh-resolve for is sampled server-side now.
  function promptLifecycle(pidCache, namespace, sessionId, cacheCwd, canDisk) {
    if (canDisk) {
      const hit = readLiveV2(pidCache, namespace, sessionId, cacheCwd);
      if (hit) {
        pidCache.touchPidCacheV2(namespace, sessionId, cacheCwd);
        // #681: a live v2 makes any same-key v1 pure residue — and the only copy
        // of the raw command line left on disk. It normally goes during
        // promotion, but if that delete ever loses its race or fails, nothing
        // else collects it: the sweep needs a DEAD pid, and a long-lived
        // session's v1 holds live ones, so it would sit in %TEMP% for the whole
        // session. An unconditional drop is safe here precisely because v2 is
        // already serving this session — nothing is stranded, and the cost is
        // one ENOENT unlink on the events where there is nothing to delete.
        claudeDropV1SameKey(pidCache, namespace, sessionId, cacheCwd);
        return cacheHitMetadata(hit, "v2");
      }
      const promoted = claudePromote(pidCache, namespace, sessionId, cacheCwd, deriveHeadless);
      if (promoted) return promoted;
    }
    return emptyMetadata();
  }

  // event: a hit (or promotion) is zero spawn; a miss is at most ONE fresh, then
  // repopulate v2 if the walk was usable. Non-cacheable events may fresh (the
  // no-fallback contract is prompt/end only).
  function eventLifecycle(pidCache, namespace, sessionId, cacheCwd, canDisk) {
    if (canDisk) {
      const hit = readLiveV2(pidCache, namespace, sessionId, cacheCwd);
      if (hit) {
        pidCache.touchPidCacheV2(namespace, sessionId, cacheCwd);
        // #681: a live v2 makes any same-key v1 pure residue — and the only copy
        // of the raw command line left on disk. It normally goes during
        // promotion, but if that delete ever loses its race or fails, nothing
        // else collects it: the sweep needs a DEAD pid, and a long-lived
        // session's v1 holds live ones, so it would sit in %TEMP% for the whole
        // session. An unconditional drop is safe here precisely because v2 is
        // already serving this session — nothing is stranded, and the cost is
        // one ENOENT unlink on the events where there is nothing to delete.
        claudeDropV1SameKey(pidCache, namespace, sessionId, cacheCwd);
        return cacheHitMetadata(hit, "v2");
      }
      const promoted = claudePromote(pidCache, namespace, sessionId, cacheCwd, deriveHeadless);
      if (promoted) return promoted;
    }
    const meta = freshMetadata();
    if (canDisk && meta.snapshotOk && meta.agentPid) {
      // v1 drop mirrors start: unconditional once a usable fresh walk is in
      // hand (privacy-first even when the v2 write fails — see startLifecycle).
      const wrote = pidCache.writePidCacheV2(namespace, sessionId, cacheCwd, v2SubsetFrom(meta)) === true;
      claudeDropV1SameKey(pidCache, namespace, sessionId, cacheCwd);
      if (wrote) {
        // First successful population is a sweep entry point for no-start
        // adapters (§5.4); the once-per-process guard makes it a no-op when
        // `start` already swept.
        maybeSweep(pidCache);
      }
    }
    return meta;
  }

  // end: cache-only. Fill the final body from a live v2 (or a valid v1 — used to
  // construct the body but NOT re-promoted into a short-lived v2), then drop the
  // cache for this ending session. v2 is dropped defensively (Claude's own key);
  // a VALID v1 is deleted ONLY via its own read-identity so a v1 a concurrent
  // writer swapped in after we read is not blindly deleted (Medium). An
  // absent/dead/corrupt v1 is defensively cleaned. NEVER fresh, NEVER write back.
  function endLifecycle(pidCache, namespace, sessionId, cacheCwd, canDisk) {
    let meta = emptyMetadata();
    if (canDisk) {
      const hit = readLiveV2(pidCache, namespace, sessionId, cacheCwd);
      const v1Entry = claudeReadLiveV1Entry(pidCache, namespace, sessionId, cacheCwd);
      if (hit) meta = cacheHitMetadata(hit, "v2");
      // #681: sanitize on the way out — the final body gets the derived boolean,
      // never the legacy raw line, even on the very last event of the session.
      else if (v1Entry) meta = cacheHitMetadata(sanitizeV1Subset(v1Entry.subset, deriveHeadless), "v1");

      pidCache.dropPidCacheV2(namespace, sessionId, cacheCwd);
      if (v1Entry) {
        // Delete only the exact v1 we read; a concurrently-replaced one survives.
        deleteV1IfUnchanged(pidCache.cacheFilePath(sessionId, cacheCwd), v1Entry.identity);
      } else {
        // No valid v1 (absent/dead/corrupt) → defensive cleanup of any garbage.
        claudeDropV1SameKey(pidCache, namespace, sessionId, cacheCwd);
      }
    }
    return meta;
  }

  function resolveWithContext(ctx) {
    const namespace = ctx.namespace;
    const sessionId = ctx.sessionId;
    const cacheCwd = ctx.cacheCwd;
    const lifecycle = ctx.lifecycle;
    const cacheable = ctx.cacheable === true;

    // Non-Windows: runtime behavior unchanged — every lifecycle does a fresh
    // (in-process cached) snapshot and no disk cache is ever consulted. Keeps
    // the ps-based path identical to 5c2b1f0 for mac/linux.
    //
    // MUST go through freshMetadata(), not freshResolve(): the raw walk has no
    // `headless`, and clawd-hook.js trusts that field alone now (it no longer
    // re-parses agentCommandLine, because a cache hit has no command line to
    // parse). Returning the raw shape here silently reported every `claude -p`
    // on macOS/Linux as an interactive session, which then also showed up in the
    // Session HUD — the HUD lists exactly the non-headless live sessions.
    if (!isWin) return freshMetadata();

    // Lazy require: the no-arg path never loads pid-cache. pid-cache never
    // requires shared-process, so there is no cycle.
    const pidCache = require("./pid-cache");
    // canDisk gates every disk read/write/touch/drop/promotion/sweep. cacheable
    // is the adapter's declaration; the path check guards a stray empty
    // ingredient. It never relaxes the prompt/end no-fallback contract below.
    const canDisk = cacheable && !!pidCache.cacheFilePathV2(namespace, sessionId, cacheCwd);

    switch (lifecycle) {
      case "start":  return startLifecycle(pidCache, namespace, sessionId, cacheCwd, canDisk);
      case "prompt": return promptLifecycle(pidCache, namespace, sessionId, cacheCwd, canDisk);
      case "end":    return endLifecycle(pidCache, namespace, sessionId, cacheCwd, canDisk);
      case "event":
      default:       return eventLifecycle(pidCache, namespace, sessionId, cacheCwd, canDisk);
    }
  }

  // Single entry point. No argument → the strict compatibility path. A context
  // object → the PR2 lifecycle path. Nothing else changes for existing callers.
  return function resolve(ctx) {
    if (ctx === undefined || ctx === null) return freshResolve();
    return resolveWithContext(ctx);
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
  WINDOWS_TERMINAL_WINDOW_CLASS,
  WINDOWS_TERMINAL_PROCESS_NAMES,
};
