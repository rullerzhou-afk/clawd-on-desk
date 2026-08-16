// Clawd on Desk — opencode-family plugin core
//
// Shared runtime for opencode-derived hosts (opencode, mimocode, …). Runs
// inside the host process (Bun runtime) and forwards session/tool events to
// the Clawd HTTP server (127.0.0.1:23333-23337).
//
// This module is IMPORTED by the thin per-agent entries
// (hooks/opencode-plugin/index.mjs, hooks/mimocode-plugin/index.mjs) and is
// never registered as a plugin directory itself, so — unlike the entries — it
// may freely use named exports (#413 only constrains the entry module, whose
// namespace the host's legacy loader iterates with Object.values()).
//
// Each entry calls createOpencodeFamilyPlugin() exactly ONCE at module
// evaluation ("one state instance per entry-module evaluation"). Re-creating
// per plugin invocation would wipe the dedup/parent maps, leak the previous
// Bun.serve bridge (it has no shutdown path by design — the server dies with
// the host process), and strand in-flight permission requests that hold the
// old bridge URL/token.
//
// Design invariants (unchanged from the original opencode plugin):
//   - Zero dependencies (Bun's built-in fetch + fs/os/path + Bun.serve + node:crypto)
//   - fire-and-forget: event hook never awaits the fetch, so slow/broken Clawd
//     cannot stall the host
//   - same-state dedup — consecutive identical states skip POST
//   - self-healing port discovery: cache hit skips I/O; on miss we read
//     runtime.json, then fall back to a full SERVER_PORTS scan
//
// Phase 2 bridge (permission replies):
//   The host TUI does NOT bind an external HTTP listener (verified via
//   Phase 2 Spike — ctx.serverUrl is a phantom URL, ctx.client.fetch is
//   bound to Server.Default().fetch() in-process). So Clawd cannot call
//   the host's REST API directly from outside the Bun process. Instead we
//   start a tiny Bun.serve() bridge here: Clawd POSTs decisions to the
//   bridge, and the bridge calls ctx.client._client.post() — the same
//   in-process Hono router that `opencode serve` would expose externally.
//   A random 32-byte hex token gates the bridge endpoint since localhost
//   TCP is visible to any process on the machine.

import { readFileSync, writeFileSync, mkdirSync, promises as fsp } from "fs";
import { homedir, platform } from "os";
import { join, posix, win32 } from "path";
import { randomBytes, timingSafeEqual } from "crypto";
import { execFileSync, execSync } from "child_process";
import {
  getEventSessionInfo,
  getEventSessionId,
  getEventParentSessionId,
  shouldDropMappedEventWithoutSessionId,
  createSessionIdHelpers,
} from "./session-ids.mjs";

const CLAWD_DIR = join(homedir(), ".clawd");
const RUNTIME_CONFIG_PATH = join(CLAWD_DIR, "runtime.json");
const SERVER_PORTS = [23333, 23334, 23335, 23336, 23337];
const STATE_PATH = "/state";
const CLAWD_SERVER_HEADER = "x-clawd-server";
const CLAWD_SERVER_ID = "clawd-on-desk";
const CLAWD_METADATA_ACCEPTED_HEADER = "x-clawd-metadata-accepted";
// Provider limit lookups are in-process HTTP roundtrips to the host's own
// server; cache positive model limits so the per-message.updated resolution
// never spams the host router (60s TTL matches antigravity-context-usage.js).
const CONTEXT_LIMIT_CACHE_MS = 60 * 1000;
// Purge context-usage dedup entries for dead sessions once this many are
// tracked, so long-lived hosts (days of sessions) stay bounded even though
// _lastStatePerSession itself is intentionally unbounded.
const MAX_CONTEXT_USAGE_ENTRIES = 1024;
// Fire-and-forget: the IIFE never blocks the event hook's return value, so a
// generous timeout is safe. 200ms was too tight when Clawd's IPC roundtrip
// (main → renderer → main) ran under load and silently timed out.
const POST_TIMEOUT_MS = 1000;
// Keep one in-flight request plus a bounded pending suffix for each session.
// A localhost process can accept fetches without answering, and OpenCode keeps
// emitting events while that request waits. Without a hard cap, even an
// explicitly serialized queue retains an unbounded chain of payloads/promises.
const STATE_POST_MAX_PENDING = 32;

// Orca hosts its terminals in a detached daemon that the process walk below can
// never reach, so the pane key from the environment is the only handle on the tab
// that has to come forward. Derived per POST rather than during the walk so it
// survives the events where the walk has not finished or failed. Duplicated
// rather than imported because this plugin ships standalone; NESTED_TERMINAL_ENV
// in hooks/shared-process.js carries the reasoning for each entry.
const NESTED_TERMINAL_ENV = ["WT_SESSION", "ALACRITTY_WINDOW_ID", "WEZTERM_PANE", "KITTY_WINDOW_ID",
  "KONSOLE_VERSION", "GNOME_TERMINAL_SCREEN", "ConEmuPID", "TMUX", "STY", "ZELLIJ"];

export function orcaPaneKeyFromEnv(env = process.env) {
  if (!env || env.TERM_PROGRAM !== "Orca") return null;
  if (NESTED_TERMINAL_ENV.some((key) => env[key])) return null;
  const paneKey = String(env.ORCA_PANE_KEY || "").trim();
  if (!paneKey || paneKey.length > 256 || !/^[\w-]+:[\w-]+$/.test(paneKey)) return null;
  return paneKey;
}

// Process tree walk config — mirrors hooks/clawd-hook.js exactly, minus the
// Claude-specific detection. See docs/plans/plan-opencode-integration.md Phase 4.
// Spike confirmed (2026-04-05): plugin runs in-process with the host, so walk
// starts at process.pid. Observed chains on Windows:
//   WT:         <host>.exe → node.exe → powershell.exe → windowsterminal.exe
//   Antigravity: <host>.exe → node.exe → pwsh.exe → antigravity.exe(×2) → explorer.exe
const TERMINAL_NAMES_WIN = new Set([
  "windowsterminal.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
  "code.exe", "alacritty.exe", "wezterm-gui.exe", "mintty.exe",
  "conemu64.exe", "conemu.exe", "hyper.exe", "tabby.exe",
  "antigravity.exe", "warp.exe", "iterm.exe", "ghostty.exe",
]);
// Desktop hosts embed/launch the opencode process but may themselves have been
// started from an editor terminal. Once the walk enters one of these Electron
// process groups, keep the outermost same-name host and stop before escaping to
// the PowerShell/Code process that launched the app.
const GUI_HOST_NAMES_WIN = new Set(["openchamber.exe"]);
const TERMINAL_NAMES_MAC = new Set([
  "terminal", "iterm2", "alacritty", "wezterm-gui", "kitty",
  "hyper", "tabby", "warp", "ghostty",
]);
const TERMINAL_NAMES_LINUX = new Set([
  "gnome-terminal", "kgx", "konsole", "xfce4-terminal", "tilix",
  "alacritty", "wezterm", "wezterm-gui", "kitty", "ghostty",
  "xterm", "lxterminal", "terminator", "tabby", "hyper", "warp",
]);
const SYSTEM_BOUNDARY_WIN = new Set(["explorer.exe", "services.exe", "winlogon.exe", "svchost.exe"]);
const SYSTEM_BOUNDARY_MAC = new Set(["launchd", "init", "systemd"]);
const SYSTEM_BOUNDARY_LINUX = new Set(["systemd", "init"]);
// Editor detection drives URI-scheme tab focus (code://, cursor://) in Clawd.
// Antigravity is NOT listed here — it's treated as a plain terminal window.
const EDITOR_MAP_WIN = { "code.exe": "code", "cursor.exe": "cursor" };
const EDITOR_MAP_MAC = { "code": "code", "cursor": "cursor" };
const EDITOR_MAP_LINUX = { "code": "code", "cursor": "cursor", "code-insiders": "code" };

export function resolveWindowsStableProcess(startPid, snapshot) {
  let pid = Number(startPid) || 0;
  let lastGoodPid = pid;
  let terminalPid = null;
  let guiHostPid = null;
  let detectedEditor = null;
  const pidChain = [];

  for (let i = 0; i < 10 && pid && pid > 1; i++) {
    const info = snapshot && snapshot.get(pid);
    if (!info) break;
    const name = String(info.name || "").toLowerCase();
    const parentPid = Number(info.ppid) || 0;

    // We have already reached the embedded app's outermost same-name process.
    // Do not let an editor/terminal used only to launch the GUI steal focus.
    if (guiHostPid && !GUI_HOST_NAMES_WIN.has(name)) break;

    pidChain.push(pid);
    if (!detectedEditor && EDITOR_MAP_WIN[name]) detectedEditor = EDITOR_MAP_WIN[name];
    if (SYSTEM_BOUNDARY_WIN.has(name)) break;
    if (GUI_HOST_NAMES_WIN.has(name)) guiHostPid = pid;
    else if (TERMINAL_NAMES_WIN.has(name)) terminalPid = pid;
    lastGoodPid = pid;
    if (!parentPid || parentPid === pid || parentPid <= 1) break;
    pid = parentPid;
  }

  return {
    stablePid: guiHostPid || terminalPid || lastGoodPid,
    pidChain,
    detectedEditor,
  };
}

// One PS spawn per resolve, not per ancestor — PowerShell cold-start (~270 ms)
// would dominate the walk otherwise. Returns empty Map on failure.
function getWindowsProcessSnapshot() {
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", timeout: 3000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    );
    const trimmed = (out || "").trim();
    if (!trimmed) return new Map();
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const map = new Map();
    for (const proc of list) {
      const pid = Number(proc && proc.ProcessId);
      if (!Number.isFinite(pid)) continue;
      map.set(pid, {
        name: typeof proc.Name === "string" ? proc.Name.toLowerCase() : "",
        ppid: Number(proc.ParentProcessId) || 0,
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

// Normalize ctx.serverUrl into a string with a trailing slash. The host passes
// a URL object in practice but we coerce defensively in case future versions
// hand us a plain string. Trailing slash lets Clawd concat cleanly:
//   `${server_url}permission/${request_id}/reply`
function normalizeServerUrl(raw) {
  if (!raw) return "";
  const s = String(raw);
  return s.endsWith("/") ? s : s + "/";
}

// #830 context usage: opencode's message.updated events carry the session
// message on event.properties.info (a Message object). Only assistant
// messages carry tokens, and only once the step finishes: { input, output,
// reasoning, cache: { read, write } }. The host's own "Context view" shows
// the component sum INCLUDING reasoning (cache read + write, no `total` —
// `total` is an internal SessionV1 aggregate, never a message-token field),
// and Clawd mirrors that exact figure. Values are coerced like
// hooks/antigravity-context-usage.js (hosts may deliver JSON numbers as
// strings). Returns null when the payload has no usable numbers.
export function extractContextUsageUsed(tokens) {
  if (!tokens || typeof tokens !== "object") return null;
  const parts = [tokens.input, tokens.output, tokens.reasoning]
    .filter((v) => v != null && Number.isFinite(Number(v)))
    .map(Number);
  const cache = tokens.cache;
  let cacheNum = 0;
  if (cache != null) {
    if (Number.isFinite(Number(cache))) {
      cacheNum = Number(cache);
    } else if (typeof cache === "object") {
      if (cache.read != null && Number.isFinite(Number(cache.read))) cacheNum += Number(cache.read);
      if (cache.write != null && Number.isFinite(Number(cache.write))) cacheNum += Number(cache.write);
    }
  }
  if (parts.length === 0 && cache == null) return null;
  return parts.reduce((a, b) => a + b, 0) + cacheNum;
}

/**
 * Create one family-plugin instance for a specific agent.
 *
 * The four identity params MUST match the agent's entry in
 * agents/opencode-family.js (a cross-check test asserts they cannot drift).
 * Everything else in this factory is agent-neutral within the opencode-family
 * wire contract.
 *
 * @param {object} config
 * @param {string} config.agentId          e.g. "opencode"
 * @param {string} config.hookSource       e.g. "opencode-plugin"
 * @param {string} config.logFileName      e.g. "opencode-plugin.log"
 * @param {string} config.sessionIdPrefix  e.g. "opencode:"
 * @returns {function} the plugin entrypoint (default-exported by the entry)
 */
export function createOpencodeFamilyPlugin(config) {
  const { agentId, hookSource, logFileName, sessionIdPrefix } = config || {};
  for (const [key, value] of Object.entries({ agentId, hookSource, logFileName, sessionIdPrefix })) {
    if (typeof value !== "string" || !value) {
      throw new Error(`createOpencodeFamilyPlugin: ${key} is required`);
    }
  }

  const AGENT_ID = agentId;
  const HOOK_SOURCE = hookSource;
  const DEBUG_LOG_PATH = join(CLAWD_DIR, logFileName);
  const {
    DEFAULT_SESSION_ID,
    normalizeSessionId,
    resolveSessionId,
    isChildSessionId,
  } = createSessionIdHelpers(sessionIdPrefix);

  // Per entry-module factory state (scoped to one host process). OpenCode may
  // invoke this same plugin function once per directory Instance, so every
  // handler returned by those invocations shares this closure.
  let _cachedPort = null;
  // Per-session last-state tracking. Keyed by sessionId so that subagent
  // sessions (spawned by the `task` tool) don't clobber the root session's
  // dedup state. Each value is the last Clawd state sent for that session.
  const _lastStatePerSession = new Map();
  // Per-session /state delivery tails. State bodies are serialized when they
  // are enqueued, then delivered in causal order for that canonical session.
  // Different sessions remain concurrent and /permission never enters this
  // queue.
  const _statePostTailBySession = new Map();
  // Explicit queue state keeps retained work inspectable and bounded. Promise
  // chaining alone looks bounded in the Map while every old closure/payload is
  // still retained by the tail.
  const _statePostQueueBySession = new Map();
  // Fallback session ID for legacy permission.asked events that omit sessionID.
  // Updated on every session.* / message.part.updated event so it stays fresh.
  // Not used for state dedup.
  let _lastSeenSessionId = null;
  let _reqCounter = 0;
  // Phase 3: host subtasks are full child sessions (not subtask parts). When
  // session.created carries event.properties.info.parentID, Clawd treats the
  // child as background/headless work owned by its parent: no HUD/focus/fanout,
  // and child session.idle maps to SessionEnd instead of the root happy path.
  // Root session fallback used for legacy idle/permission association.
  // Child/headless detection is explicit: _sessionParentById is populated
  // from event.properties.info.parentID on session.created.
  let _rootSessionId = null;
  // Phase 3 headless: maps child sessionID → parentID. Populated on
  // session.created (from event.properties.info.parentID), cleaned on
  // session.deleted / server.instance.disposed. Used by buildStateBody()
  // to set headless: true for child sessions and by translateEvent() to
  // map child session.idle → SessionEnd instead of Stop.
  const _sessionParentById = new Map();
  // Authoritative session directory learned from session lifecycle info.
  // Shared by every directory handler returned from this factory product.
  const _sessionDirectoryById = new Map();
  // Fallback ownership for events that omit info.directory. Disposal always
  // consumes this handler binding, including mixed modern/legacy payloads;
  // outbound cwd consumes it only until the host's info-directory latch proves
  // map misses must fail closed.
  const _sessionInstanceDirectoryById = new Map();
  // Authoritative session title learned from session lifecycle info.
  // Shared by every handler returned from this factory product.
  const _sessionTitleById = new Map();
  // Compatibility latch: old hosts that never emit info.directory keep the
  // latest-init fallback. Once this host proves it emits bindable session info,
  // a map miss omits cwd rather than forwarding a potentially stale directory.
  let _hostEmitsSessionInfo = false;
  // Process tree walk results — populated once by getStablePid() at init, then
  // read by every POST to /state and /permission. null until first resolution.
  let _stablePid = null;
  let _pidChain = [];
  let _detectedEditor = null;
  let _tmuxSocket = null;
  let _tmuxClient = null;
  // Most recently initialized directory across this shared factory closure.
  // This is only a legacy-host fallback, never authoritative session truth.
  let _lastInitDirectory = "";
  let _instanceTokenCounter = 0;
  const _activeInstanceDirectoryByToken = new Map();
  // #830 context state is scoped to the initialized SDK client/directory
  // instance. A factory product can serve multiple OpenCode Instances whose
  // provider/model IDs overlap but whose configured limits differ.
  const _contextStateByInstance = new Map();
  const _contextLimitCacheByClient = new WeakMap();
  let _contextGenerationCounter = 0;
  // Permission requests outlive the event callback: Clawd replies later over
  // the reverse bridge. OpenCode invokes this factory once per directory, so
  // bind each request to the exact SDK client + directory that emitted it.
  // Using the most recently initialized client here routes interleaved replies
  // into the wrong Instance and produces PermissionNotFound/502.
  const _permissionTargetByRequestId = new Map();
  // Reverse bridge state. Set by startBridge() at plugin init. Clawd receives
  // _bridgeUrl + _bridgeToken with every /permission forward and POSTs back.
  let _bridgeUrl = "";
  let _bridgeTokenHex = "";
  let _bridgeTokenBuf = null;
  let _bridgeServer = null;

  // Debug log is reset on plugin init so each host startup gets a clean
  // file. message.part.updated ignores are filtered out at the event-handler
  // level to keep volume low, but we still write via a batched async flush
  // (libuv threadpool) so even a burst of MAP/SEND/POST lines from a single
  // event tick never blocks the host TUI main thread.
  const _debugBuffer = [];
  let _debugFlushing = false;
  function debugLog(msg) {
    _debugBuffer.push(`[${new Date().toISOString()}] ${msg}\n`);
    scheduleDebugFlush();
  }
  function scheduleDebugFlush() {
    if (_debugFlushing || _debugBuffer.length === 0) return;
    _debugFlushing = true;
    setImmediate(async () => {
      const chunk = _debugBuffer.join("");
      _debugBuffer.length = 0;
      try {
        await fsp.appendFile(DEBUG_LOG_PATH, chunk, "utf8");
      } catch {}
      _debugFlushing = false;
      if (_debugBuffer.length > 0) scheduleDebugFlush();
    });
  }

  function resetDebugLog() {
    try {
      mkdirSync(CLAWD_DIR, { recursive: true });
      writeFileSync(DEBUG_LOG_PATH, "", "utf8");
    } catch {}
  }

  // Test-only observability for the already-asynchronous debug writer. The
  // flag is cleared after appendFile settles, so these two closure conditions
  // are sufficient; no second active-promise state is needed.
  function flushDebugLog() {
    return new Promise((resolve) => {
      const check = () => {
        if (!_debugFlushing && _debugBuffer.length === 0) {
          resolve();
          return;
        }
        setImmediate(check);
      };
      check();
    });
  }

  function readRuntimePort() {
    try {
      const raw = JSON.parse(readFileSync(RUNTIME_CONFIG_PATH, "utf8"));
      const port = Number(raw && raw.port);
      if (Number.isInteger(port) && SERVER_PORTS.includes(port)) return port;
    } catch {}
    return null;
  }

  // Ordered: cached → runtime.json → full scan. Only touches runtime.json when
  // the cache is empty (avoids a sync fs read on every successful POST).
  function getPortCandidates() {
    const ordered = [];
    const seen = new Set();
    const add = (p) => {
      if (p && !seen.has(p) && SERVER_PORTS.includes(p)) {
        seen.add(p);
        ordered.push(p);
      }
    };
    add(_cachedPort);
    if (_cachedPort == null) add(readRuntimePort());
    SERVER_PORTS.forEach(add);
    return ordered;
  }

  // Walks past the first terminal match to pick the OUTERMOST terminal —
  // matters for Electron terminals like Antigravity where the chain shows
  // renderer→main and we want the main process so Clawd activates the right
  // window. Cached after first call.
  function getStablePid() {
    if (_stablePid) return _stablePid;
    const isWin = platform() === "win32";
    const isMac = platform() === "darwin";
    const terminalNames = isWin ? TERMINAL_NAMES_WIN : (isMac ? TERMINAL_NAMES_MAC : TERMINAL_NAMES_LINUX);
    const systemBoundary = isWin ? SYSTEM_BOUNDARY_WIN : (isMac ? SYSTEM_BOUNDARY_MAC : SYSTEM_BOUNDARY_LINUX);
    const editorMap = isWin ? EDITOR_MAP_WIN : (isMac ? EDITOR_MAP_MAC : EDITOR_MAP_LINUX);

    _pidChain = [];
    _detectedEditor = null;

    const winSnapshot = isWin ? getWindowsProcessSnapshot() : null;
    if (isWin) {
      const identity = resolveWindowsStableProcess(process.pid, winSnapshot);
      _stablePid = identity.stablePid;
      _pidChain = identity.pidChain;
      _detectedEditor = identity.detectedEditor;
    } else {
      let pid = process.pid;
      let lastGoodPid = pid;
      let terminalPid = null;
      for (let i = 0; i < 10 && pid && pid > 1; i++) {
        let name = "";
        let parentPid = 0;
        try {
          const commOut = execSync(`ps -o comm= -p ${pid}`, { encoding: "utf8", timeout: 1000 }).trim();
          name = commOut.split("/").pop().toLowerCase();
          // macOS: VS Code binary is "Electron" — check full comm path for editor detection
          if (!_detectedEditor) {
            const fullLower = commOut.toLowerCase();
            if (fullLower.includes("visual studio code")) _detectedEditor = "code";
            else if (fullLower.includes("cursor.app")) _detectedEditor = "cursor";
          }
          const ppidOut = execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8", timeout: 1000 }).trim();
          parentPid = parseInt(ppidOut, 10) || 0;
        } catch {
          break;
        }
        _pidChain.push(pid);
        if (!_detectedEditor && editorMap[name]) _detectedEditor = editorMap[name];
        // Hit system process — stop before escaping the user's session boundary.
        if (systemBoundary.has(name)) break;
        // Record but don't break: outermost terminal wins (handles Electron
        // terminals like Antigravity where renderer→main share the same name).
        if (terminalNames.has(name)) terminalPid = pid;
        lastGoodPid = pid;
        if (!parentPid || parentPid === pid || parentPid <= 1) break;
        pid = parentPid;
      }
      _stablePid = terminalPid || lastGoodPid;
    }

    _tmuxSocket = null;
    _tmuxClient = null;
    if (process.env.TMUX) {
      const socketPath = process.env.TMUX.split(",")[0];
      if (typeof socketPath === "string" && socketPath.startsWith("/") && socketPath.length <= 4096 && !/[\0\r\n]/.test(socketPath)) {
        _tmuxSocket = socketPath;
      }
      if (process.env.TMUX_PANE) {
        try {
          const raw = execFileSync("tmux", ["list-clients", "-t", process.env.TMUX_PANE, "-F", "#{client_tty}"],
            { encoding: "utf8", timeout: 500 });
          const target = raw.split("\n").map(s => s.trim()).find(Boolean) || "";
          if (target && target.length <= 256 && !target.startsWith("-") && /^[\w./:-]+$/.test(target)) {
            _tmuxClient = target;
          }
        } catch {}
      }
    }

    debugLog(`PID resolved stable=${_stablePid} editor=${_detectedEditor || "none"} chain=[${_pidChain.join(",")}]`);
    return _stablePid;
  }

  function captureSessionDirectory(event) {
    if (!event) return null;
    switch (event.type) {
      case "session.created":
      case "session.updated":
      case "session.deleted":
        break;
      default:
        return null;
    }

    const metadata = getEventSessionInfo(event);
    const eventSessionId = normalizeSessionId(metadata.eventSessionId);
    const infoSessionId = normalizeSessionId(metadata.infoSessionId);
    if (eventSessionId && infoSessionId && eventSessionId !== infoSessionId) {
      debugLog(`SESSION_DIR skip session=${eventSessionId} reason=id-mismatch`);
      return null;
    }

    const sessionId = infoSessionId || eventSessionId;
    if (!sessionId) {
      debugLog("SESSION_DIR skip session=none reason=no-session-id");
      return null;
    }
    if (!metadata.directory) {
      debugLog(`SESSION_DIR skip session=${sessionId} reason=invalid-directory`);
      return null;
    }

    _sessionDirectoryById.set(sessionId, metadata.directory);
    _sessionInstanceDirectoryById.delete(sessionId);
    _hostEmitsSessionInfo = true;
    debugLog(`SESSION_DIR capture session=${sessionId} source=info`);
    return sessionId;
  }

  function resolveSessionDirectory(sessionId) {
    const normalized = normalizeSessionId(sessionId);
    if (normalized && _sessionDirectoryById.has(normalized)) {
      return {
        directory: _sessionDirectoryById.get(normalized),
        source: "session-info",
      };
    }
    if (!_hostEmitsSessionInfo && normalized && _sessionInstanceDirectoryById.has(normalized)) {
      return {
        directory: _sessionInstanceDirectoryById.get(normalized),
        source: "instance-handler",
      };
    }
    if (!_hostEmitsSessionInfo && _lastInitDirectory) {
      return {
        directory: _lastInitDirectory,
        source: "legacy-init-fallback",
      };
    }
    return { directory: null, source: "none" };
  }

  function captureSessionInstanceDirectory(event, instanceDirectory) {
    const sessionId = normalizeSessionId(getEventSessionId(event));
    if (!sessionId || typeof instanceDirectory !== "string" || !instanceDirectory.trim()) {
      return null;
    }
    if (_sessionDirectoryById.has(sessionId)) return sessionId;
    _sessionInstanceDirectoryById.set(sessionId, instanceDirectory);
    return sessionId;
  }

  function registerInstanceDirectory(instanceDirectory) {
    const token = ++_instanceTokenCounter;
    const directory = typeof instanceDirectory === "string" && instanceDirectory.trim()
      ? instanceDirectory
      : "";
    _activeInstanceDirectoryByToken.set(token, directory);
    if (directory) _lastInitDirectory = directory;
    return token;
  }

  function unregisterInstanceDirectory(token) {
    _activeInstanceDirectoryByToken.delete(token);
    _lastInitDirectory = "";
    for (const directory of _activeInstanceDirectoryByToken.values()) {
      if (directory) _lastInitDirectory = directory;
    }
  }

  // Directory text stays byte-identical in _sessionDirectoryById and outbound
  // cwd bodies. This derived key exists only for ownership comparisons during
  // server.instance.disposed cleanup.
  function normalizeDirectoryOwnershipKey(value, hostPlatform = platform()) {
    if (typeof value !== "string" || !value.trim()) return null;
    // Do not trim the actual path: spaces are valid path characters on POSIX.
    // trim() above is only the empty-value guard.
    const raw = value;
    const pathFlavor = hostPlatform === "win32" ? win32 : posix;
    if (!pathFlavor.isAbsolute(raw)) return null;

    let normalized = pathFlavor.normalize(raw);
    const root = pathFlavor.parse(normalized).root;
    const endsWithSeparator = hostPlatform === "win32"
      ? (text) => text.endsWith("\\") || text.endsWith("/")
      : (text) => text.endsWith("/");
    while (normalized.length > root.length && endsWithSeparator(normalized)) {
      normalized = normalized.slice(0, -1);
    }
    return hostPlatform === "win32" ? normalized.toLowerCase() : normalized;
  }

  function captureSessionTitle(event) {
    if (!event) return null;
    switch (event.type) {
      case "session.created":
      case "session.updated":
        break;
      default:
        return null;
    }

    const metadata = getEventSessionInfo(event);
    const eventSessionId = normalizeSessionId(metadata.eventSessionId);
    const infoSessionId = normalizeSessionId(metadata.infoSessionId);
    if (eventSessionId && infoSessionId && eventSessionId !== infoSessionId) {
      return null;
    }

    const sessionId = infoSessionId || eventSessionId;
    if (!sessionId) return null;
    if (!metadata.title) return null;

    const prevTitle = _sessionTitleById.get(sessionId);
    // OpenCode assigns a placeholder title ("New session") at creation and
    // later replaces it with the real summary-based title via session.updated.
    // That event maps to no Clawd state, so without an explicit push the HUD
    // keeps showing the placeholder forever. Forward a title change as a
    // metadata-only POST — the server updates sessionTitle without disturbing
    // the lifecycle state (mirrors how clawd-hook statusline refreshes work).
    // If no session exists yet the server drops the metadata POST safely
    // (metadata-only never creates a session), so the first redundant push is
    // harmless — and it covers the "created with no title, titled later" case.
    if (prevTitle !== metadata.title) {
      _sessionTitleById.set(sessionId, metadata.title);
      // Log only non-content metadata: the title is user/LLM-derived and
      // embedded control chars/newlines could forge diagnostic log lines.
      debugLog(`SESSION_TITLE session=${sessionId} changed=true len=${metadata.title.length}`);
      const body = {
        state: "idle",
        session_id: sessionId,
        event: "SessionUpdate",
        agent_id: AGENT_ID,
        hook_source: HOOK_SOURCE,
        metadata_only: true,
        session_title: metadata.title,
      };
      postStateToClawd(body);
    }
    return sessionId;
  }

  function contextInstanceToken(instanceToken) {
    return Number.isInteger(instanceToken) && instanceToken > 0 ? instanceToken : 0;
  }

  function getContextSessionMap(instanceToken, create = false) {
    const token = contextInstanceToken(instanceToken);
    let sessions = _contextStateByInstance.get(token);
    if (!sessions && create) {
      sessions = new Map();
      _contextStateByInstance.set(token, sessions);
    }
    return sessions || null;
  }

  function getContextState(instanceToken, sessionId, create = false) {
    const normalized = normalizeSessionId(sessionId);
    if (!normalized) return null;
    const sessions = getContextSessionMap(instanceToken, create);
    if (!sessions) return null;
    let state = sessions.get(normalized);
    if (!state && create) {
      state = {
        generation: ++_contextGenerationCounter,
        sequence: 0,
        latestSequence: 0,
        inFlight: new Map(),
        delivered: null,
      };
      sessions.set(normalized, state);
    }
    return state || null;
  }

  function resetContextSession(sessionId, instanceToken) {
    const normalized = normalizeSessionId(sessionId);
    if (!normalized) return;
    const sessions = getContextSessionMap(instanceToken);
    if (!sessions) return;
    sessions.delete(normalized);
    if (sessions.size === 0) _contextStateByInstance.delete(contextInstanceToken(instanceToken));
  }

  function collectContextSessionIds(instanceToken = null) {
    const ids = new Set();
    const maps = instanceToken == null
      ? _contextStateByInstance.values()
      : [getContextSessionMap(instanceToken)].filter(Boolean);
    for (const sessions of maps) {
      for (const sessionId of sessions.keys()) ids.add(sessionId);
    }
    return ids;
  }

  function cleanupContextState(sessionIds, options = {}) {
    if (options.clearAll === true) {
      _contextStateByInstance.clear();
      return;
    }
    if (options.clearInstance === true && options.instanceToken != null) {
      _contextStateByInstance.delete(contextInstanceToken(options.instanceToken));
      return;
    }

    const ids = sessionIds instanceof Set ? sessionIds : new Set(sessionIds || []);
    const maps = options.instanceToken == null
      ? _contextStateByInstance.values()
      : [getContextSessionMap(options.instanceToken)].filter(Boolean);
    for (const sessions of maps) {
      for (const sessionId of ids) sessions.delete(sessionId);
    }
    for (const [token, sessions] of _contextStateByInstance) {
      if (sessions.size === 0) _contextStateByInstance.delete(token);
    }
  }

  function collectKnownSessionIds() {
    const ids = new Set([
      ..._sessionDirectoryById.keys(),
      ..._sessionInstanceDirectoryById.keys(),
      ..._sessionTitleById.keys(),
      ..._lastStatePerSession.keys(),
      ..._sessionParentById.keys(),
      ..._sessionParentById.values(),
      ..._statePostTailBySession.keys(),
    ]);
    for (const sessionId of collectContextSessionIds()) ids.add(sessionId);
    const root = normalizeSessionId(_rootSessionId);
    const latest = normalizeSessionId(_lastSeenSessionId);
    if (root) ids.add(root);
    if (latest) ids.add(latest);
    for (const target of _permissionTargetByRequestId.values()) {
      const targetSessionId = normalizeSessionId(target && target.sessionId);
      if (targetSessionId) ids.add(targetSessionId);
    }
    return ids;
  }

  function cleanupSessionState(sessionIds, options = {}) {
    const ids = sessionIds instanceof Set ? sessionIds : new Set(sessionIds || []);
    const clearAll = options.clearAll === true;
    const directoryKey = options.directoryKey || null;

    for (const sessionId of ids) {
      _sessionDirectoryById.delete(sessionId);
      _sessionInstanceDirectoryById.delete(sessionId);
      _sessionTitleById.delete(sessionId);
      _lastStatePerSession.delete(sessionId);
    }

    for (const [childId, parentId] of _sessionParentById) {
      if (clearAll || ids.has(childId) || ids.has(parentId)) {
        _sessionParentById.delete(childId);
      }
    }

    if (clearAll || ids.has(normalizeSessionId(_rootSessionId))) {
      _rootSessionId = null;
    }
    if (clearAll || ids.has(normalizeSessionId(_lastSeenSessionId))) {
      _lastSeenSessionId = null;
    }

    for (const [requestId, target] of _permissionTargetByRequestId) {
      const targetSessionId = normalizeSessionId(target && target.sessionId);
      const targetDirectoryKey = normalizeDirectoryOwnershipKey(target && target.directory);
      if (clearAll || ids.has(targetSessionId) || (directoryKey && targetDirectoryKey === directoryKey)) {
        _permissionTargetByRequestId.delete(requestId);
      }
    }

    cleanupContextState(ids, {
      clearAll,
      clearInstance: options.clearInstanceContext === true,
      instanceToken: options.instanceToken,
    });

    // Never delete an active delivery tail here: Map.delete cannot cancel its
    // promise and would let a later body with the same id overtake it. Every
    // tail removes itself with an identity guard after it settles.
  }

  function enqueueDisposedSessionEnds(sessionIds) {
    for (const sessionId of sessionIds) {
      const body = buildStateBody("sleeping", "SessionEnd", sessionId);
      if (body) postStateToClawd(body);
    }
  }

  function disposedDirectoryScope(event, instanceDirectory) {
    const props = event && event.properties && typeof event.properties === "object"
      ? event.properties
      : {};
    const eventKey = normalizeDirectoryOwnershipKey(props.directory);
    if (eventKey) return { key: eventKey, source: "event" };
    const instanceKey = normalizeDirectoryOwnershipKey(instanceDirectory);
    if (instanceKey) return { key: instanceKey, source: "instance-fallback" };
    return null;
  }

  function cleanupSessionDirectory(event, phase, instanceDirectory = "", instanceToken = null) {
    if (!event || typeof event.type !== "string") return;

    if (event.type === "server.instance.disposed" && phase === "before-send") {
      const scope = disposedDirectoryScope(event, instanceDirectory);
      if (!scope) {
        const allIds = collectKnownSessionIds();
        enqueueDisposedSessionEnds(allIds);
        cleanupSessionState(allIds, { clearAll: true });
        debugLog(`SESSION_DISPOSE scope=global reason=no-usable-directory sessions=${allIds.size}`);
        return;
      }

      const disposedIds = new Set();
      for (const [sessionId, directory] of _sessionDirectoryById) {
        if (normalizeDirectoryOwnershipKey(directory) === scope.key) {
          disposedIds.add(sessionId);
        }
      }
      for (const [sessionId, directory] of _sessionInstanceDirectoryById) {
        if (normalizeDirectoryOwnershipKey(directory) === scope.key) {
          disposedIds.add(sessionId);
        }
      }
      // A message.updated event can arrive before lifecycle directory metadata
      // is observed. The handler token is still authoritative for that
      // instance, so include its context sessions in the final cleanup set.
      if (instanceToken != null) {
        for (const sessionId of collectContextSessionIds(instanceToken)) disposedIds.add(sessionId);
      }

      // A state request may already be in flight when the Instance disappears.
      // Queue a targeted final body behind that session's exact FIFO tail so a
      // late state cannot recreate a ghost session after local ownership is
      // cleared. This is never an anonymous or cross-directory SessionEnd.
      enqueueDisposedSessionEnds(disposedIds);
      cleanupSessionState(disposedIds, {
        directoryKey: scope.key,
        instanceToken,
        clearInstanceContext: instanceToken != null,
      });
      debugLog(`SESSION_DISPOSE scope=${scope.source} sessions=${disposedIds.size}`);
      return;
    }

    if (event.type === "session.deleted" && phase === "after-send") {
      const normalized = normalizeSessionId(getEventSessionId(event));
      if (normalized) cleanupSessionState(new Set([normalized]), { instanceToken });
    }
  }

  // Snapshot mutable request data synchronously. session.deleted cleanup runs
  // immediately after enqueue, so cwd/title/process fields must already be
  // frozen before a queued delivery waits behind an older request.
  function snapshotPost(body, logTag) {
    const outbound = { ...(body || {}) };
    // Enrich every outbound body with process-tree fields. Cached after first
    // call so this is just a few object assignments per POST.
    if (_stablePid) {
      outbound.source_pid = _stablePid;
      if (_pidChain.length) outbound.pid_chain = _pidChain.slice();
      if (_detectedEditor) outbound.editor = _detectedEditor;
      if (_tmuxSocket) outbound.tmux_socket = _tmuxSocket;
      if (_tmuxClient) outbound.tmux_client = _tmuxClient;
    }
    // Outside the _stablePid gate on purpose: the pane key owes nothing to the
    // process walk, and Orca's detached daemon is precisely the case where the
    // walk finds no terminal to report.
    const orcaPaneKey = orcaPaneKeyFromEnv();
    if (orcaPaneKey) outbound.orca_pane_key = orcaPaneKey;
    const cwd = resolveSessionDirectory(outbound.session_id);
    if (cwd.directory) outbound.cwd = cwd.directory;
    else delete outbound.cwd;
    outbound.agent_pid = process.pid;
    const payload = JSON.stringify(outbound);
    return {
      body: outbound,
      payload,
      logTag,
      cwdSource: cwd.source,
      reqId: ++_reqCounter,
    };
  }

  // Deliver one already-snapshotted body. Candidate discovery intentionally
  // happens when delivery begins so a previous queued request can repair the
  // shared cached port before the next request scans.
  async function deliverPost(urlPath, snapshot) {
    const candidates = getPortCandidates();
    debugLog(`POST[${snapshot.reqId}] ${snapshot.logTag} cwdSource=${snapshot.cwdSource} start candidates=[${candidates.join(",")}]`);

    for (const port of candidates) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
      const t0 = Date.now();
      try {
        const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: snapshot.payload,
          signal: controller.signal,
        });
        const elapsed = Date.now() - t0;
        const header = res.headers.get(CLAWD_SERVER_HEADER);
        const metadataAccepted = header === CLAWD_SERVER_ID
          && res.headers.get(CLAWD_METADATA_ACCEPTED_HEADER) === "1";
        debugLog(`POST[${snapshot.reqId}] ${snapshot.logTag} port=${port} status=${res.status} header=${header} metadataAccepted=${metadataAccepted} elapsed=${elapsed}ms`);
        // Port range is unprivileged so another app could answer — require the
        // Clawd identity header before trusting the response.
        if (header === CLAWD_SERVER_ID) {
          _cachedPort = port;
          try { await res.text(); } catch {}
          debugLog(`POST[${snapshot.reqId}] ${snapshot.logTag} OK port=${port} metadataAccepted=${metadataAccepted}`);
          return { recognized: true, metadataAccepted };
        }
      } catch (err) {
        const elapsed = Date.now() - t0;
        debugLog(`POST[${snapshot.reqId}] ${snapshot.logTag} port=${port} ERR ${err && err.name}/${err && err.message} elapsed=${elapsed}ms`);
      } finally {
        clearTimeout(timer);
      }
    }
    // All candidates failed — drop the cache so next call re-reads runtime.json.
    debugLog(`POST[${snapshot.reqId}] ${snapshot.logTag} EXHAUSTED all candidates failed`);
    _cachedPort = null;
    return { recognized: false, metadataAccepted: false };
  }

  // Fire-and-forget direct channel used by /permission. Returning the settled
  // promise is only for deterministic tests; production event hooks never await
  // it.
  function postToClawd(urlPath, body, logTag) {
    const snapshot = snapshotPost(body, logTag);
    return deliverPost(urlPath, snapshot)
      .then((result) => result.recognized)
      .catch((err) => {
        debugLog(`POST[${snapshot.reqId}] ${snapshot.logTag} UNCAUGHT ${err && err.message}`);
        return false;
      });
  }

  function isReplaceableStateSnapshot(snapshot) {
    const body = snapshot && snapshot.body;
    return !!body
      && body.metadata_only !== true
      && ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact"].includes(body.event);
  }

  function isMetadataStateSnapshot(snapshot) {
    return !!(snapshot && snapshot.body && snapshot.body.metadata_only === true);
  }

  function metadataFieldKinds(snapshot) {
    const body = snapshot && snapshot.body;
    if (!body || body.metadata_only !== true) return new Set();
    const kinds = new Set();
    if (Object.hasOwn(body, "session_title")) kinds.add("title");
    if (Object.hasOwn(body, "context_usage")) kinds.add("context");
    return kinds;
  }

  function refreshSnapshotPayload(snapshot) {
    snapshot.payload = JSON.stringify(snapshot.body);
    return snapshot;
  }

  function createStatePostSnapshot(body) {
    const snapshot = snapshotPost(body, `STATE state=${body && body.state}`);
    let resolve;
    snapshot.completion = new Promise((done) => { resolve = done; });
    snapshot.waiters = [{ resolve, kinds: metadataFieldKinds(snapshot) }];
    return snapshot;
  }

  function settleStatePostSnapshot(snapshot, delivered) {
    if (!snapshot || snapshot.settled) return;
    snapshot.settled = true;
    for (const waiter of snapshot.waiters || []) waiter.resolve(delivered);
    snapshot.waiters = [];
  }

  function mergeQueuedMetadataSnapshot(existing, incoming) {
    const incomingKinds = metadataFieldKinds(incoming);
    const mergedBody = { ...existing.body, ...incoming.body };
    incoming.body = mergedBody;
    refreshSnapshotPayload(incoming);

    // Title and context are independently replaceable fields. Preserve
    // waiters for an unchanged kind, supersede only waiters for an incoming
    // same-kind update, and let both compatible fields share one delivery.
    const retained = [];
    for (const waiter of existing.waiters || []) {
      const superseded = [...incomingKinds].some((kind) => waiter.kinds.has(kind));
      if (superseded) waiter.resolve(false);
      else retained.push(waiter);
    }
    incoming.waiters = [...retained, ...(incoming.waiters || [])];
    existing.waiters = [];
    return incoming;
  }

  async function drainStatePostQueue(sessionId, queue) {
    let allRecognized = true;
    while (queue.pending.length > 0) {
      const snapshot = queue.pending.shift();
      queue.active = snapshot;
      let snapshotSucceeded = false;
      try {
        const result = await deliverPost(STATE_PATH, snapshot);
        const transportSucceeded = result.recognized;
        snapshotSucceeded = isMetadataStateSnapshot(snapshot)
          ? result.recognized && result.metadataAccepted
          : result.recognized;
        if (!transportSucceeded) allRecognized = false;
      } catch (err) {
        allRecognized = false;
        debugLog(`POST[${snapshot.reqId}] ${snapshot.logTag} UNCAUGHT ${err && err.message}`);
      } finally {
        queue.active = null;
        settleStatePostSnapshot(snapshot, snapshotSucceeded);
      }
    }

    if (_statePostQueueBySession.get(sessionId) === queue) {
      _statePostQueueBySession.delete(sessionId);
    }
    if (_statePostTailBySession.get(sessionId) === queue.settled) {
      _statePostTailBySession.delete(sessionId);
    }
    queue.resolve(allRecognized);
  }

  function createStatePostQueue(sessionId) {
    let resolve;
    const settled = new Promise((done) => { resolve = done; });
    const queue = {
      active: null,
      pending: [],
      settled,
      resolve,
      draining: false,
    };
    _statePostQueueBySession.set(sessionId, queue);
    _statePostTailBySession.set(sessionId, settled);
    return queue;
  }

  function makeStatePostRoom(queue, incoming) {
    if (queue.pending.length < STATE_POST_MAX_PENDING) return;
    // A title-only update must never evict the latest lifecycle snapshot and
    // leave the server stuck in an older error/idle state. Coalesce old metadata
    // first; otherwise evict the oldest queued item. New lifecycle snapshots can
    // preferentially replace old state/metadata because the incoming lifecycle
    // itself preserves a fresh state at the tail.
    const incomingMetadata = isMetadataStateSnapshot(incoming);
    let index = incomingMetadata
      ? queue.pending.findIndex((snapshot) => isMetadataStateSnapshot(snapshot))
      : queue.pending.findIndex((snapshot) => (
        isReplaceableStateSnapshot(snapshot) || isMetadataStateSnapshot(snapshot)
      ));
    if (index < 0) index = 0;
    const [dropped] = queue.pending.splice(index, 1);
    settleStatePostSnapshot(dropped, false);
    debugLog(`POST[${incoming.reqId}] ${incoming.logTag} overflow=dropped-old req=${dropped.reqId}`);
  }

  function postStateToClawd(body) {
    const sessionId = normalizeSessionId(body && body.session_id) || DEFAULT_SESSION_ID;
    const snapshot = createStatePostSnapshot(body);
    const replaceable = isReplaceableStateSnapshot(snapshot);
    const metadata = isMetadataStateSnapshot(snapshot);
    const terminal = !!body && body.event === "SessionEnd";
    let queue = _statePostQueueBySession.get(sessionId);

    if (!queue) queue = createStatePostQueue(sessionId);

    const activeTerminal = !!(queue.active && queue.active.body && queue.active.body.event === "SessionEnd");
    const queuedTerminal = queue.pending.some((entry) => entry.body && entry.body.event === "SessionEnd");
    if (!terminal && (activeTerminal || queuedTerminal)) {
      settleStatePostSnapshot(snapshot, false);
      debugLog(`POST[${snapshot.reqId}] ${snapshot.logTag} dropped=after-terminal`);
      return snapshot.completion;
    }

    if (terminal) {
      for (const pending of queue.pending.splice(0)) settleStatePostSnapshot(pending, false);
      queue.pending.push(snapshot);
      debugLog(`POST[${snapshot.reqId}] ${snapshot.logTag} coalesced=terminal`);
    } else {
      const last = queue.pending.at(-1);
      if (replaceable && isReplaceableStateSnapshot(last)) {
        settleStatePostSnapshot(last, false);
        queue.pending[queue.pending.length - 1] = snapshot;
        debugLog(`POST[${snapshot.reqId}] ${snapshot.logTag} coalesced=latest-state`);
      } else if (metadata && isMetadataStateSnapshot(last)) {
        queue.pending[queue.pending.length - 1] = mergeQueuedMetadataSnapshot(last, snapshot);
        debugLog(`POST[${snapshot.reqId}] ${snapshot.logTag} coalesced=metadata-fields`);
      } else {
        makeStatePostRoom(queue, snapshot);
        queue.pending.push(snapshot);
      }
    }

    if (!queue.draining) {
      queue.draining = true;
      void drainStatePostQueue(sessionId, queue);
    }
    return snapshot.completion;
  }

  // Fire-and-forget permission forward. Clawd decides allow/deny/always in its
  // bubble UI and replies through the reverse bridge (POST /reply with the
  // request_id + decision). The plugin never waits.
  function postPermissionToClawd(body) {
    postToClawd("/permission", body, `PERM tool=${body.tool_name} req=${body.request_id}`);
  }

  function buildStateBody(state, eventName, sessionId) {
    if (!state || !eventName) return null;
    const clawdSessionId = normalizeSessionId(sessionId) || DEFAULT_SESSION_ID;
    const body = {
      state,
      session_id: clawdSessionId,
      event: eventName,
      agent_id: AGENT_ID,
      hook_source: HOOK_SOURCE,
    };
    // Phase 3 headless: child sessions (identified by parentID in
    // _sessionParentById) get headless: true so downstream session
    // handling can distinguish child sessions.
    if (isChildSessionId(clawdSessionId, _sessionParentById)) {
      body.headless = true;
    }
    // Session title from OpenCode's own session-info title field. Mirrors the
    // pattern used by other agents (clawd-hook, workbuddy-hook) that
    // include session_title in their state POST body. The server reads
    // this and stores it as sessionTitle, which sessionDisplayTitle()
    // then uses before falling back to path.basename(cwd).
    const sessionTitle = _sessionTitleById.get(clawdSessionId);
    if (sessionTitle) body.session_title = sessionTitle;
    return body;
  }

  // Clawd uses PascalCase event names matching Claude Code's hook vocabulary so
  // state.js transition rules (e.g. SubagentStop → working whitelist) are
  // reusable across agents.
  function sendState(state, eventName, sessionId) {
    const body = buildStateBody(state, eventName, sessionId);
    if (!body) return;

    const lastState = _lastStatePerSession.get(body.session_id) || null;

    // Per-session dedup: skip only if the SAME session repeats the SAME state.
    if (body.state === lastState) {
      return;
    }

    debugLog(`SEND ${lastState || "null"} → ${body.state} event=${body.event} session=${body.session_id}`);
    _lastStatePerSession.set(body.session_id, body.state);

    postStateToClawd(body);
  }

  // Translate a host event into a Clawd (state, eventName) pair, or null
  // if Clawd should ignore it. Event shape (from runtime dumps):
  //   { type: "session.status", properties: { sessionID, status: { type } } }
  //   { type: "message.part.updated", properties: { part: { type, tool, state: { status } } } }
  function translateEvent(event) {
    if (!event || typeof event.type !== "string") return null;
    const props = event.properties || {};
    const sessionId = getEventSessionId(event);

    switch (event.type) {
      case "session.created":
        return { state: "idle", event: "SessionStart" };

      case "session.status": {
        // Only busy drives thinking. Runtime observations show session.status
        // carries type=busy during activity; session-idle is delivered as a
        // separate "session.idle" event, not as status.type=idle (the latter
        // does appear occasionally but is redundant and safely ignored).
        const type = props.status && props.status.type;
        if (type === "busy") return { state: "thinking", event: "UserPromptSubmit" };
        return null;
      }

      case "message.part.updated": {
        const part = props.part;
        if (!part || typeof part !== "object") return null;

        if (part.type === "tool") {
          // pending → running → completed fires back-to-back; dedup absorbs the
          // repeat so only the first transition actually POSTs.
          const status = part.state && part.state.status;
          if (status === "running") return { state: "working", event: "PreToolUse" };
          if (status === "completed") return { state: "working", event: "PostToolUse" };
          if (status === "error") return { state: "error", event: "PostToolUseFailure" };
          return null;
        }

        if (part.type === "compaction") {
          return { state: "sweeping", event: "PreCompact" };
        }

        return null;
      }

      case "session.compacted":
        return { state: "sweeping", event: "PreCompact" };

      case "session.idle": {
        // Phase 3 headless: child sessions (identified by parentID in
        // _sessionParentById) end with SessionEnd so Clawd removes them
        // from its tracking map — no happy flash, no menu pollution.
        if (isChildSessionId(sessionId, _sessionParentById)) {
          return { state: "sleeping", event: "SessionEnd" };
        }
        return { state: "attention", event: "Stop" };
      }

      case "session.error":
        return { state: "error", event: "StopFailure" };

      case "session.deleted":
      case "server.instance.disposed":
        return { state: "sleeping", event: "SessionEnd" };

      default:
        return null;
    }
  }

  // Test-only internals. Attached to the default export at the bottom of this
  // factory — NOT a named export of the ENTRY module. The host's plugin loader
  // runs getLegacyPlugins() over Object.values(mod) and throws "Plugin export
  // is not a function" on ANY non-function module export, which silently kills
  // the whole plugin. The entry module must therefore expose exactly one
  // export: the default function. See #413.
  const __testInternals = {
    buildStateBody,
    translateEvent,
    captureSessionDirectory,
    captureSessionInstanceDirectory,
    captureSessionTitle,
    resolveSessionDirectory,
    cleanupSessionDirectory,
    normalizeDirectoryOwnershipKey,
    postStateToClawd,
    postPermissionToClawd,
    handleContextUsageEvent,
    buildContextUsageBody,
    resolveContextLimit,
    resetContextSession,
    cleanupContextState,
    get _sessionParentById() { return _sessionParentById; },
    get _sessionDirectoryById() { return _sessionDirectoryById; },
    get _sessionInstanceDirectoryById() { return _sessionInstanceDirectoryById; },
    get _sessionTitleById() { return _sessionTitleById; },
    get _hostEmitsSessionInfo() { return _hostEmitsSessionInfo; },
    get _rootSessionId() { return _rootSessionId; },
    set _rootSessionId(v) { _rootSessionId = v; },
    get _lastSeenSessionId() { return _lastSeenSessionId; },
    get _lastInitDirectory() { return _lastInitDirectory; },
    get _lastContextUsageBySession() { return getContextUsageDebugView(); },
    get _contextStateByInstance() { return _contextStateByInstance; },
    get _contextLimitCacheByClient() { return _contextLimitCacheByClient; },
    flushDebugLog,
    // Instance-isolation probes (family-core tests). Live views into the
    // closure — a hardcoded log path or accidentally-shared state bag must
    // fail the isolation suite, not pass silently.
    get _debugLogPath() { return DEBUG_LOG_PATH; },
    get _lastStatePerSession() { return _lastStatePerSession; },
    get _statePostTailBySession() { return _statePostTailBySession; },
    get _statePostQueueBySession() { return _statePostQueueBySession; },
    get _statePostMaxPending() { return STATE_POST_MAX_PENDING; },
    get _permissionTargetByRequestId() { return _permissionTargetByRequestId; },
    get _cachedPort() { return _cachedPort; },
    set _cachedPort(v) { _cachedPort = v; },
    get _bridgeUrl() { return _bridgeUrl; },
    get _bridgeTokenHex() { return _bridgeTokenHex; },
    get _pidChain() { return _pidChain; },
  };

  // #830 context usage — session-level token totals from message.updated
  // summary events. The state is scoped by initialized Instance and fenced by
  // session generation/event sequence so stale SDK lookups cannot publish.

  // Fire-and-forget metadata POST of { used, limit } — mirrors
  // antigravity-context-usage.js / claude-statusline.js quota reporting
  // (source stamped here so the route can attribute the telemetry stream).
  function buildContextUsageBody(sessionId, used, limit) {
    return {
      agent_id: AGENT_ID,
      hook_source: HOOK_SOURCE,
      session_id: sessionId,
      metadata_only: true,
      context_usage: {
        used,
        limit: Number.isFinite(limit) ? limit : null,
        source: "opencode",
      },
    };
  }

  function unwrapProviderListResult(result) {
    // The default SDK client returns { data, request, response }. A caller
    // using responseStyle:"data" receives the payload directly, so unwrap
    // only an object-valued data field before inspecting provider fields.
    if (result
      && typeof result === "object"
      && !Array.isArray(result)
      && result.data
      && typeof result.data === "object"
      && !Array.isArray(result.data)) {
      return result.data;
    }
    return result;
  }

  function normalizeProviderListResult(result) {
    const payload = unwrapProviderListResult(result);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    if (Array.isArray(payload.all)) return payload.all;
    if (Array.isArray(payload.providers)) return payload.providers;
    return null;
  }

  function getContextLimitCache(client) {
    if (!client || (typeof client !== "object" && typeof client !== "function")) return null;
    let cache = _contextLimitCacheByClient.get(client);
    if (!cache) {
      cache = new Map();
      _contextLimitCacheByClient.set(client, cache);
    }
    return cache;
  }

  // Resolve the host model's context limit via the in-process SDK client —
  // mirrors exactly what the host's "Context view" shows: provider.list()
  // returns Provider[] where each Provider has { id, models: { [modelID]:
  // { limit: { context } } } }. `models` is a MAP keyed by model id (not an
  // array), so the provider is matched by providerID and the model by modelID.
  // The upstream contract does not define provider.options.limit as a context
  // window, so unknown model limits fail closed to null.
  // Returns null (never throws) when the provider/model/limit is unknown.
  async function resolveContextLimit(providerID, modelID, client) {
    if (!modelID || !client || typeof client.provider !== "object" || typeof client.provider.list !== "function") {
      return null;
    }
    const cache = getContextLimitCache(client);
    if (!cache) return null;
    const cacheKey = `${providerID || ""}::${modelID}`;
    const cached = cache.get(cacheKey);
    if (
      cached
      && Number.isFinite(cached.limit)
      && cached.limit > 0
      && Date.now() - cached.at < CONTEXT_LIMIT_CACHE_MS
    ) {
      return cached.limit;
    }
    const lookupGeneration = Number.isSafeInteger(cached && cached.lookupGeneration)
      ? cached.lookupGeneration + 1
      : 1;
    // Record latest-started ownership before awaiting provider.list(). Keep an
    // expired positive value only as inert history; the `at` check above
    // prevents this pending entry from becoming a fresh cache hit.
    cache.set(cacheKey, {
      limit: Number.isFinite(cached && cached.limit) && cached.limit > 0 ? cached.limit : null,
      at: Number.isFinite(cached && cached.at) ? cached.at : 0,
      lookupGeneration,
    });
    let limit = null;
    try {
      const providers = normalizeProviderListResult(await client.provider.list());
      if (Array.isArray(providers)) {
        const provider = (providerID && providers.find((p) => p && p.id === providerID)) || null;
        const models = provider && provider.models;
        let model = null;
        if (Array.isArray(models)) {
          model = models.find((m) => m && m.id === modelID) || null;
        } else if (models && typeof models.get === "function") {
          model = models.get(modelID) || null;
        } else if (models) {
          model = models[modelID] || null;
        }
        if (model && model.limit && Number.isFinite(model.limit.context) && model.limit.context > 0) {
          limit = model.limit.context;
        }
      }
    } catch (err) {
      debugLog(`CTX limit THROW provider=${providerID} model=${modelID} msg=${err && err.message}`);
    }
    // Only successful positive limits are normal TTL cache entries. A null or
    // thrown lookup must be allowed to recover on the next sample.
    if (Number.isFinite(limit) && limit > 0) {
      const current = cache.get(cacheKey);
      if (current && current.lookupGeneration === lookupGeneration) {
        cache.set(cacheKey, { limit, at: Date.now(), lookupGeneration });
      }
    }
    return limit;
  }

  function isCurrentContextSample(instanceToken, sessionId, state, generation, sequence) {
    const current = getContextState(instanceToken, sessionId);
    return current === state
      && current && current.generation === generation
      && current.latestSequence === sequence;
  }

  function isSameDeliveredContextSample(previous, next) {
    // A null/unavailable limit is not a stable baseline. Repeated null samples
    // must retry lookup so a later provider refresh can recover the percentage.
    return !!previous
      && Number.isFinite(previous.limit)
      && previous.limit > 0
      && previous.used === next.used
      && previous.providerID === next.providerID
      && previous.modelID === next.modelID
      && previous.limit === next.limit;
  }

  function getContextUsageDebugView() {
    const view = new Map();
    for (const sessions of _contextStateByInstance.values()) {
      for (const [sessionId, state] of sessions) {
        if (state.delivered) view.set(sessionId, state.delivered.used);
      }
    }
    return view;
  }

  // message.updated handler: the session message rides on properties.info
  // (assistant role, tokens populated after the step finishes). The event hook
  // never awaits this path; its returned promise is intentionally detached.
  function handleContextUsageEvent(event, instance) {
    try {
      // MiMo uses this shared core but its SDK/event contract is not proven to
      // match OpenCode's message.updated/provider.list contract. Keep #830
      // explicitly scoped until a real MiMo compatibility fixture exists.
      if (AGENT_ID !== "opencode") return;

      const props = event && event.properties && typeof event.properties === "object"
        ? event.properties
        : {};
      const info = props.info;
      if (!info || typeof info !== "object" || Array.isArray(info)) {
        debugLog("CTX skip reason=invalid-info");
        return;
      }
      if (info.role !== "assistant") {
        debugLog("CTX skip reason=non-assistant-message");
        return;
      }

      const instanceToken = contextInstanceToken(instance && instance.instanceToken);
      const clawdSessionId = normalizeSessionId(getEventSessionId(event));
      if (!clawdSessionId) {
        debugLog("CTX skip reason=no-session-id");
        return;
      }
      const used = extractContextUsageUsed(info.tokens);
      if (!Number.isFinite(used) || used <= 0) {
        debugLog(`CTX skip reason=${Number.isFinite(used) ? "zero-tokens" : "no-tokens"}`);
        return;
      }
      const state = getContextState(instanceToken, clawdSessionId, true);
      const sessions = getContextSessionMap(instanceToken);
      if (sessions && sessions.size > MAX_CONTEXT_USAGE_ENTRIES) {
        const oldest = sessions.keys().next().value;
        if (oldest !== undefined && oldest !== clawdSessionId) sessions.delete(oldest);
      }

      const sequence = ++state.sequence;
      state.latestSequence = sequence;
      const generation = state.generation;
      state.inFlight.set(sequence, { used });
      const providerID = info.providerID || null;
      const modelID = info.modelID || null;
      return resolveContextLimit(providerID, modelID, instance && instance.client)
        .then((limit) => {
          if (!isCurrentContextSample(instanceToken, clawdSessionId, state, generation, sequence)) {
            debugLog(`CTX discard session=${clawdSessionId} seq=${sequence} reason=stale`);
            return null;
          }

          const sample = {
            used,
            providerID,
            modelID,
            limit: Number.isFinite(limit) && limit > 0 ? limit : null,
          };
          debugLog(`CTX resolved used=${used} limit=${sample.limit ?? "unknown"} session=${clawdSessionId} provider=${providerID || "?"} model=${modelID || "unknown"} seq=${sequence} gen=${generation}`);
          if (isSameDeliveredContextSample(state.delivered, sample)) {
            debugLog(`CTX skip session=${clawdSessionId} seq=${sequence} reason=delivered`);
            return null;
          }

          // Same serialized metadata delivery as the session-title push
          // (#841): state/event scaffolding is inert on the route side because
          // metadata_only short-circuits lifecycle handling.
          const body = buildContextUsageBody(clawdSessionId, used, sample.limit);
          body.state = "idle";
          body.event = "SessionUpdate";
          return postStateToClawd(body).then((delivered) => {
            if (delivered && isCurrentContextSample(instanceToken, clawdSessionId, state, generation, sequence)) {
              state.delivered = sample;
            }
          });
        })
        .catch((err) => {
          debugLog(`CTX handler ASYNC THROW msg=${err && err.message}`);
        })
        .finally(() => {
          state.inFlight.delete(sequence);
        });
    } catch (err) {
      debugLog(`CTX handler THROW msg=${err && err.message}`);
    }
  }

  // Handle v2 permission.asked event — see Phase 2 Spike in
  // docs/plans/plan-opencode-integration.md. Current wire payloads carry a
  // sessionID; legacy hosts may omit it, in which case we retain the existing
  // _lastSeenSessionId → _rootSessionId fallback.
  // Phase 1 dedup/state machine logic does not run for permission events — they
  // ride a parallel channel and never translate to a Clawd state transition.
  function handlePermissionAsked(event, instance) {
    const p = (event && event.properties) || {};
    const requestId = p.id;
    if (!requestId) {
      debugLog(`PERM skip: no request id in permission.asked`);
      return;
    }
    const sessionId = resolveSessionId(
      getEventSessionId(event),
      _lastSeenSessionId || _rootSessionId
    );
    const sessionDirectory = resolveSessionDirectory(sessionId).directory;
    _permissionTargetByRequestId.delete(requestId);
    _permissionTargetByRequestId.set(requestId, {
      client: instance.client,
      directory: sessionDirectory || instance.directory,
      sessionId,
    });
    // A permission can remain pending forever if the user closes its native
    // prompt. Keep the process-lifetime map bounded without deleting history.
    if (_permissionTargetByRequestId.size > 256) {
      const oldest = _permissionTargetByRequestId.keys().next().value;
      if (oldest) _permissionTargetByRequestId.delete(oldest);
    }
    postPermissionToClawd({
      agent_id: AGENT_ID,
      hook_source: HOOK_SOURCE,
      tool_name: p.permission || "unknown",
      tool_input: p.metadata || {},
      patterns: Array.isArray(p.patterns) ? p.patterns : [],
      always: Array.isArray(p.always) ? p.always : [],
      session_id: sessionId,
      request_id: requestId,
      server_url: instance.serverUrl, // debug only, not used for replies
      bridge_url: _bridgeUrl,         // ← Clawd POSTs decisions here
      bridge_token: _bridgeTokenHex,  // ← and authenticates with this
    });
  }

  // Constant-time token comparison to thwart timing oracle attacks on the
  // bridge auth. Any local process can see 127.0.0.1 binds so the token is
  // the only thing keeping untrusted code from rubber-stamping tool calls.
  function verifyBridgeToken(headerValue) {
    if (!headerValue || !_bridgeTokenBuf) return false;
    const m = /^Bearer\s+([a-f0-9]+)$/i.exec(headerValue);
    if (!m) return false;
    let candidate;
    try { candidate = Buffer.from(m[1], "hex"); } catch { return false; }
    if (candidate.length !== _bridgeTokenBuf.length) return false;
    try { return timingSafeEqual(candidate, _bridgeTokenBuf); } catch { return false; }
  }

  // Handle POST /reply from Clawd. Reads { request_id, reply } and forwards to
  // the host's in-process Hono router via ctx.client._client.post(). Return
  // 200 on success (the host's own route returned 2xx), 4xx on auth/shape
  // errors, 502 if the upstream call itself throws.
  async function handleBridgeRequest(req) {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/reply") {
      return new Response("not found", { status: 404 });
    }
    if (!verifyBridgeToken(req.headers.get("authorization"))) {
      debugLog(`BRIDGE auth fail from=${req.headers.get("x-forwarded-for") || "local"}`);
      return new Response("unauthorized", { status: 401 });
    }
    let body;
    try { body = await req.json(); } catch {
      return new Response("bad json", { status: 400 });
    }
    const requestId = body && typeof body.request_id === "string" ? body.request_id : "";
    const reply = body && typeof body.reply === "string" ? body.reply : "";
    if (!requestId || !["once", "always", "reject"].includes(reply)) {
      debugLog(`BRIDGE bad payload requestId=${requestId} reply=${reply}`);
      return new Response("bad payload", { status: 400 });
    }
    const target = _permissionTargetByRequestId.get(requestId);
    if (!target || !target.client || !target.client._client) {
      debugLog(`BRIDGE no request target requestId=${requestId}`);
      return new Response("permission request not found", { status: 404 });
    }

    debugLog(`BRIDGE → ${AGENT_ID} permission reply requestId=${requestId} reply=${reply}`);
    try {
      // HeyApi v1's raw client accepts the v2 route plus an explicit query.
      // The directory is intentionally explicit even though the originating
      // client also carries x-opencode-directory: this pins workspace routing
      // to the permission's owning Instance across multi-directory warmup.
      const result = await target.client._client.post({
        url: `/permission/${encodeURIComponent(requestId)}/reply`,
        query: target.directory ? { directory: target.directory } : undefined,
        body: { reply },
        headers: { "Content-Type": "application/json" },
      });
      // HeyApi returns { data, error, request, response } by default. `error`
      // is only set on non-2xx responses; successful reply just has `data`.
      const hasError = result && result.error != null;
      debugLog(`BRIDGE reply done requestId=${requestId} hasError=${hasError}`);
      if (hasError) {
        return new Response(JSON.stringify({ ok: false, error: String(result.error) }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
      _permissionTargetByRequestId.delete(requestId);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      debugLog(`BRIDGE reply THROW requestId=${requestId} msg=${err && err.message}`);
      return new Response(JSON.stringify({ ok: false, error: String(err && err.message) }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Start the Bun.serve reverse bridge on a random localhost port. Called once
  // at plugin init. Survives the plugin's lifetime; the host owns the process
  // so there's no explicit shutdown path — the server dies with the process.
  function startBridge() {
    if (_bridgeServer && _bridgeUrl && _bridgeTokenBuf) return;
    if (typeof Bun === "undefined" || !Bun.serve) {
      debugLog(`BRIDGE start FAILED: Bun.serve not available (not running under Bun?)`);
      return;
    }
    try {
      _bridgeTokenBuf = randomBytes(32);
      _bridgeTokenHex = _bridgeTokenBuf.toString("hex");
      _bridgeServer = Bun.serve({
        port: 0,              // ask the OS for an unused port
        hostname: "127.0.0.1",
        fetch: handleBridgeRequest,
      });
      const port = _bridgeServer.port;
      _bridgeUrl = `http://127.0.0.1:${port}`;
      debugLog(`BRIDGE listening on ${_bridgeUrl} (token ${_bridgeTokenHex.slice(0, 8)}…)`);
    } catch (err) {
      debugLog(`BRIDGE start THROW: ${err && err.message}`);
      _bridgeServer = null;
      _bridgeUrl = "";
      _bridgeTokenHex = "";
      _bridgeTokenBuf = null;
    }
  }

  // Plugin entrypoint (the host loads this via the entry's default export).
  const plugin = async (ctx) => {
    resetDebugLog();
    const instanceServerUrl = normalizeServerUrl(ctx && ctx.serverUrl);
    const instanceClient = ctx && ctx.client ? ctx.client : null;
    const instanceDirectory = ctx && typeof ctx.directory === "string" && ctx.directory.trim()
      ? ctx.directory
      : "";
    const instanceToken = registerInstanceDirectory(instanceDirectory);
    let instanceDisposed = false;
    debugLog(`INIT directory=${instanceDirectory} serverUrl=${instanceServerUrl} pid=${process.pid} hasClient=${!!instanceClient}`);
    // Sync init blocks the TUI boot path; later POSTs hit the cached result.
    getStablePid();
    startBridge();

    return {
      event: async ({ event }) => {
        try {
          if (!event || typeof event.type !== "string") return;
          if (instanceDisposed) return;

          // Phase 3: capture the root session on first sighting. Any later
          // sessionID is a subtask spawned by the parent's `task` tool, and
          // its session.idle will be downgraded to SessionEnd in translateEvent.
          // The session ID may be in event.properties.sessionID (most events)
          // or event.sessionID (session.created in some runtimes).
          const sid = getEventSessionId(event);

          // #796: lifecycle info is the only authoritative session-directory
          // source. Capture before translate/drop because session.updated does
          // not map to a Clawd state and info-only deleted events need its id.
          if (event.type === "server.instance.disposed") {
            cleanupSessionDirectory(event, "before-send", instanceDirectory, instanceToken);
            if (!instanceDisposed) {
              instanceDisposed = true;
              unregisterInstanceDirectory(instanceToken);
            }
            // Instance disposal is cleanup-only. Some host versions may attach
            // a session id, but it must never revive fallback pointers or
            // synthesize a SessionEnd for that (possibly unrelated) session.
            return;
          }
          captureSessionDirectory(event);
          captureSessionInstanceDirectory(event, instanceDirectory);
          captureSessionTitle(event);

          if (sid && !_rootSessionId) {
            _rootSessionId = sid;
            debugLog(`ROOT session captured id=${sid}`);
          }
          if (sid) _lastSeenSessionId = sid;

          // Phase 3 headless: on session.created, read parentID from
          // event.properties.info.parentID (opencode SDK ≥1.15.13) and store
          // in _sessionParentById. Child sessions get headless: true in
          // buildStateBody().
          if (event.type === "session.created" && sid) {
            // A reused session ID is a new context generation. Invalidate any
            // old provider lookup still completing for the prior incarnation.
            resetContextSession(sid, instanceToken);
            const parentID = getEventParentSessionId(event);
            if (parentID) {
              // Store with normalized keys so lookups from buildStateBody()
              // (which uses clawdSessionId = normalizeSessionId(sessionId))
              // match consistently regardless of raw vs prefixed form.
              const normChild = normalizeSessionId(sid);
              const normParent = normalizeSessionId(parentID);
              if (normChild && normParent) {
                _sessionParentById.set(normChild, normParent);
                debugLog(`CHILD session id=${normChild} parentId=${normParent}`);
              }
            }
          }

          // Phase 2: permission.asked rides a parallel channel — forward to Clawd
          // and skip state translation. Clawd replies through the reverse bridge,
          // so we don't need to watch permission.replied here.
          if (event.type === "permission.asked") {
            handlePermissionAsked(event, {
              client: instanceClient,
              directory: instanceDirectory,
              serverUrl: instanceServerUrl,
            });
            return;
          }

          // #830: message.updated (turn-finished summary update) carries the
          // session message on event.properties.info, whose assistant tokens
          // hold the session-level totals. Forward as a metadata-only
          // contextUsage POST (same dedup/no-decision semantics as the
          // agents/antigravity plugin path). The event itself never maps to a
          // Clawd state transition.
          if (event.type === "message.updated") {
            handleContextUsageEvent(event, { client: instanceClient, instanceToken });
            return;
          }

          const mapped = translateEvent(event);
          if (!mapped) {
            // Log ignored session.* events only — they are low-frequency and
            // occasionally useful for diagnosis. message.part.updated ignores
            // are skipped because they would trigger a sync fsync on every
            // text/reasoning/step streaming update (tens per session).
            if (event.type.startsWith("session.")) {
              const statusType = event.properties && event.properties.status && event.properties.status.type;
              debugLog(`IGNORE ${event.type}${statusType ? ` status=${statusType}` : ""}`);
            }
            return;
          }
          if (shouldDropMappedEventWithoutSessionId(event, mapped)) {
            debugLog(`DROP ${event.type} event=${mapped.event} reason=no-session-id`);
            return;
          }

          const sessionId = resolveSessionId(
            getEventSessionId(event),
            _lastSeenSessionId || _rootSessionId
          );

          debugLog(`MAP ${event.type} → state=${mapped.state} event=${mapped.event}`);
          sendState(mapped.state, mapped.event, sessionId);
          // Unified cleanup happens only after postStateToClawd synchronously
          // snapshots the final SessionEnd body. This preserves cwd, title and
          // child/headless ownership while the queued network delivery waits.
          cleanupSessionDirectory(event, "after-send", instanceDirectory, instanceToken);
        } catch (err) {
          debugLog(`ERROR in event hook: ${err && err.message}`);
        }
      },
    };
  };

  // Expose test internals on the returned function rather than anywhere the
  // ENTRY module's namespace could see — see the note on __testInternals and
  // issue #413. Non-enumerable as hygiene: it's a private test backdoor,
  // never part of the plugin surface.
  Object.defineProperty(plugin, "__test", { value: __testInternals });

  return plugin;
}
