"use strict";


// ── Linux / native Wayland: Hyprland compositor backend ──
//
// Original work by xingguangcuican6666.
//
// Native Wayland clients cannot position their own windows and cannot query
// the global cursor — the two primitives the whole pet runtime is built on.
// Compositor-specific privileged channels fill the gap. This module is the
// Hyprland backend (needs the Lua scripting API; developed and measured
// against Hyprland 0.57.0):
//
//   • Global cursor position — `cursorpos` over the Hyprland IPC socket.
//     Hyprland reports logical (DIP-equivalent) coordinates, 1:1 with
//     Electron's screen coordinate space.
//   • Window placement — window rules created at runtime through
//     `eval hl.window_rule{…}`. Static effects (move/size/pin/
//     no_initial_focus) apply at map time only, so the rule is re-created
//     immediately before every show. Runtime moves of a mapped window go
//     through `hl.dispatch(hl.dsp.window.move{…})` — dispatchers MUST be
//     wrapped in hl.dispatch(): constructing hl.dsp.* alone returns a
//     closure that never runs (measured).
//   • Click-through — `no_focus` removes the window from hit-testing
//     (ViewHitTester skips noFocus windows, so clicks land on windows
//     below). Electron's setIgnoreMouseEvents() is a complete NO-OP on
//     native Wayland (native_window_views.cc guards it with
//     x11_util::IsX11()), and setShape() has no Wayland implementation
//     either — the rule is the only mechanism.
//   • Focus — `hl.dispatch(hl.dsp.focus{window="address:0x…"})`. Electron's
//     own focus() cannot activate a native Wayland toplevel.
//   • All-workspaces — `pin=true` rule effect (setVisibleOnAllWorkspaces()
//     is X11/_NET_WM_STATE_STICKY-only).
//
// Rule-update semantics this module relies on (Hyprland source, verified by
// probe): a same-name hl.window_rule{…} call REPLACES the match engine but
// APPENDS effects; at apply time effects are iterated in order and the LAST
// value for a scalar property wins. Boolean effects must therefore be
// emitted explicitly as true AND false — omitting a false leaves a stale
// appended true in effect.
//
// IPC transport: $XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/
// .socket.sock (commands, one connection per command like hyprctl) and
// .socket2.sock (events). We talk to it with raw libc socket syscalls
// through koffi (already a dependency) because everything here must be
// SYNCHRONOUS: screen.getCursorScreenPoint() is a sync API patched in place,
// and window show/move hooks run inline.
//
// `eval` always answers "ok" — Lua return values are not retrievable over
// IPC, so success is verified through j/clients state instead.
//
// Degradation: if the compositor is not Hyprland (no
// HYPRLAND_INSTANCE_SIGNATURE) or the socket is unreachable, every operation
// becomes a no-op and `available` is false. The app still runs as an
// ordinary native-Wayland client (centered windows, no cursor tracking) —
// no worse than the pre-#441 status quo.

const MARKER_ZWSP = "​"; // zero-width space      → bit 0
const MARKER_ZWNJ = "‌"; // zero-width non-joiner → bit 1
const MARKER_PREFIX = "Clawd";
const RULE_PREFIX = "clawd-wayland-";

function isNativeWaylandSession(env) {
  const e = env || process.env;
  const sessionType = String(e.XDG_SESSION_TYPE || "").trim().toLowerCase();
  return sessionType === "wayland" || !!String(e.WAYLAND_DISPLAY || "").trim();
}

// The app runs the native Wayland Ozone backend when Chromium resolved
// --ozone-platform to "wayland". `ozonePlatform` is
// app.commandLine.getSwitchValue("ozone-platform") — since Chromium 140 the
// browser materializes its OWN resolved default onto the command line, so an
// empty value means "older Chromium": fall back to session sniffing.
function isWaylandBackendActive(options = {}) {
  const env = options.env || process.env;
  if ((options.platform || process.platform) !== "linux") return false;
  const resolved = String(options.ozonePlatform || "").trim().toLowerCase();
  if (resolved === "wayland") return true;
  if (resolved) return false; // x11 or anything else explicit
  return isNativeWaylandSession(env);
}

function isHyprlandSession(env) {
  const e = env || process.env;
  return !!String(e.HYPRLAND_INSTANCE_SIGNATURE || "").trim()
    && !!String(e.XDG_RUNTIME_DIR || "").trim();
}

function hyprlandSocketPath(env) {
  const e = env || process.env;
  const sig = String(e.HYPRLAND_INSTANCE_SIGNATURE || "").trim();
  const runtime = String(e.XDG_RUNTIME_DIR || "").trim();
  if (!sig || !runtime) return null;
  return `${runtime}/hypr/${sig}/.socket.sock`;
}

// Unique invisible window-title marker. Encodes (pid, id) as zero-width bits
// so concurrent app instances can never collide — Hyprland window rules match
// initialTitle across ALL processes, and initialTitle re-freezes at every map
// (initializeOnFirstMap), so the marker must be unique process-wide AND stay
// the title prefix for the window's whole life. Rules match "^<marker>.*"
// (RE2 FullMatch semantics) so any visible tail — a page title, a manual
// setTitle — is tolerated as long as the marker prefix survives.
function encodeMarker(pid, id) {
  let n = Math.max(0, Math.floor(pid)) * 4096 + Math.max(0, Math.floor(id));
  let suffix = "";
  do {
    suffix += (n & 1) ? MARKER_ZWNJ : MARKER_ZWSP;
    n = Math.floor(n / 2);
  } while (n > 0);
  return MARKER_PREFIX + suffix;
}

function markerRegex(marker) {
  // Markers are alphanumeric + zero-width chars — all RE2-inert, no escaping
  // needed. Anchored; ".*" covers the visible tail.
  return `^${marker}.*`;
}

// ── koffi libc bindings ──
//
// Minimal BSD socket client: socket/connect/write/shutdown/read/close.
// sockaddr_un is 110 bytes on Linux (2-byte sun_family + 108-byte sun_path).
function loadSocketBindings(koffi) {
  const libc = koffi.load("libc.so.6");
  return {
    socket: libc.func("socket", "int", ["int", "int", "int"]),
    connect: libc.func("connect", "int", ["int", "void *", "uint32_t"]),
    write: libc.func("write", "int64", ["int", "void *", "uint64_t"]),
    read: libc.func("read", "int64", ["int", "void *", "uint64_t"]),
    shutdown: libc.func("shutdown", "int", ["int", "int"]),
    close: libc.func("close", "int", ["int"]),
  };
}

const AF_UNIX = 1;
const SOCK_STREAM = 1;
const SHUT_WR = 1;
const READ_CHUNK = 65536;
const SOCKADDR_LEN = 110;

function buildSockAddr(path) {
  const addr = Buffer.alloc(SOCKADDR_LEN);
  addr.writeUInt16LE(AF_UNIX, 0);
  Buffer.from(String(path), "utf8").copy(addr, 2, 0, SOCKADDR_LEN - 2);
  return addr;
}

// One command per connection (hyprctl protocol). Returns the full response;
// throws on transport failure. `bindings` injectable for tests.
function ipcCommand(socketPath, command, bindings) {
  const fd = bindings.socket(AF_UNIX, SOCK_STREAM, 0);
  if (!(fd >= 0)) throw new Error(`socket() failed (fd=${fd})`);
  try {
    if (bindings.connect(fd, buildSockAddr(socketPath), SOCKADDR_LEN) !== 0) {
      throw new Error(`connect(${socketPath}) failed`);
    }
    const payload = Buffer.from(String(command), "utf8");
    bindings.write(fd, payload, payload.length);
    bindings.shutdown(fd, SHUT_WR);
    const chunks = [];
    const out = Buffer.alloc(READ_CHUNK);
    // Drain until EOF, never until a short read: a reply that spans several
    // chunks can be followed by MORE data after a short one.
    for (;;) {
      const n = Number(bindings.read(fd, out, out.length));
      if (!(n > 0)) break;
      chunks.push(Buffer.from(out.subarray(0, n)));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    try { bindings.close(fd); } catch {}
  }
}

// `cursorpos` replies "<x>, <y>" (older versions append monitor info; take
// the first coordinate pair). Hyprland coords are logical ⇒ DIP 1:1.
function parseCursorPos(reply) {
  const m = /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(String(reply == null ? "" : reply));
  if (!m) return null;
  const x = parseFloat(m[1]);
  const y = parseFloat(m[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

// Escape for a Lua double-quoted string literal.
function luaQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ── eval payload builders (pure; unit-tested) ──
//
// Dispatchers run ONLY inside hl.dispatch(...). eval always answers "ok" —
// callers verify through j/clients.

function luaDispatchMove(address, x, y) {
  return `eval return tostring(hl.dispatch(hl.dsp.window.move({x=${Math.round(x)}, y=${Math.round(y)}, window="address:${address}"})))`;
}

function luaDispatchFocus(address) {
  return `eval return tostring(hl.dispatch(hl.dsp.focus({window="address:${address}"})))`;
}

function luaDispatchFocusLast() {
  return "eval return tostring(hl.dispatch(hl.dsp.focus({last=true})))";
}

function luaDispatchPin(address, pin) {
  const action = pin ? "pin" : "unpin";
  return `eval return tostring(hl.dispatch(hl.dsp.window.pin({action="${action}", window="address:${address}"})))`;
}

function luaDispatchRaise(address) {
  return `eval return tostring(hl.dispatch(hl.dsp.window.alter_zorder({mode="top", window="address:${address}"})))`;
}

function luaDispatchMoveCursor(x, y) {
  return `eval return tostring(hl.dispatch(hl.dsp.cursor.move({x=${Math.round(x)}, y=${Math.round(y)}})))`;
}

// hl.window_rule({name=…, match={initial_title=…}, …effects}).
// effects values: boolean → emitted EXPLICITLY as true/false (same-name
// re-calls append effects and the last one wins — omitting a false would
// leave a previously appended true active); 2-number array → {x, y}
// expression vec2 (move/size); number/string → literal.
function luaWindowRule(name, matchPattern, effects) {
  const parts = [`name=${luaQuote(name)}`, `match={initial_title=${luaQuote(matchPattern)}}`];
  for (const [key, value] of Object.entries(effects || {})) {
    if (typeof value === "boolean") parts.push(`${key}=${value ? "true" : "false"}`);
    else if (typeof value === "number" && Number.isFinite(value)) parts.push(`${key}=${Math.round(value)}`);
    else if (typeof value === "string") parts.push(`${key}=${luaQuote(value)}`);
    else if (Array.isArray(value) && value.length === 2
      && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
      parts.push(`${key}={${Math.round(value[0])}, ${Math.round(value[1])}}`);
    }
  }
  return `eval hl.window_rule({${parts.join(", ")}}); return "ok"`;
}

function luaRuleSetEnabled(name, enabled) {
  return `eval hl.window_rule({name=${luaQuote(name)}, enabled=${enabled ? "true" : "false"}}); return "ok"`;
}

// ── The backend ──
//
// createHyprlandBackend({ env, koffi, bindings, loadBindings, socketPath,
//                         onError }) →
//   { available, query, cursorPoint, clients, activeWindow,
//     findClientByMarker, moveWindow, focusWindow, focusLastWindow,
//     setWindowPin, raiseWindow, moveCursor, defineWindowRule,
//     setWindowRuleEnabled }
// Every method is synchronous; transport errors latch `broken` (reported
// once through onError) and degrade all further calls to no-ops.
function createHyprlandBackend(options = {}) {
  const env = options.env || process.env;
  const onError = options.onError || (() => {});
  const socketPath = options.socketPath || hyprlandSocketPath(env);
  let bindings = options.bindings || null;
  let broken = !socketPath;
  let errorReported = false;

  const report = (error) => {
    if (errorReported) return;
    errorReported = true;
    try { onError(error); } catch {}
  };

  function ensureBindings() {
    if (bindings) return bindings;
    const koffi = options.koffi || require("koffi");
    bindings = options.loadBindings ? options.loadBindings(koffi) : loadSocketBindings(koffi);
    return bindings;
  }

  function query(command) {
    if (broken) return null;
    try {
      return ipcCommand(socketPath, command, ensureBindings());
    } catch (error) {
      broken = true;
      report(error);
      return null;
    }
  }

  // The socket may hand us another client's reply, so a JSON query retries a
  // few times and accepts the first answer that parses to the expected shape.
  // `x y z` replies are JSON arrays or objects, never bare text, so a stray
  // "ok" or "480, 620" from someone else's command can never be accepted.
  function queryJson(command, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
      const reply = query(command);
      if (reply == null) return null;
      try {
        const parsed = JSON.parse(reply);
        if (parsed && typeof parsed === "object") return parsed;
      } catch { /* not ours or truncated — ask again */ }
      if (i < attempts - 1) sleepSyncRetry();
    }
    return null;
  }

  function sleepSyncRetry() {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); } catch {}
  }

  // One-way command: run it and ignore the reply text.
  function send(command) {
    if (broken) return false;
    try {
      // Same transport as query(): the read drains the reply, so the
      // compositor has handled the command before we return.
      ipcCommand(socketPath, command, ensureBindings());
      return true;
    } catch (error) {
      broken = true;
      report(error);
      return false;
    }
  }

  function normalizeAddress(address) {
    const s = String(address == null ? "" : address).trim();
    if (!s) return null;
    return s.startsWith("0x") ? s : `0x${s}`;
  }

  return {
    get available() { return !broken; },
    query,
    send,
    cursorPoint() { return parseCursorPos(query("cursorpos")); },
    clients() {
      const list = queryJson("j/clients");
      return Array.isArray(list) ? list : null;
    },
    activeWindow() {
      const info = queryJson("j/activewindow");
      return info && typeof info === "object" && info.address ? info : null;
    },
    // Our own windows carry the invisible marker in initialTitle (frozen at
    // map) and/or the live title. Match by pid first — markers are unique
    // per process, and j/clients spans every client on the desktop.
    findClientByMarker(marker, pid) {
      if (!marker) return null;
      const list = this.clients();
      if (!list) return null;
      const ownPid = Number.isFinite(pid) ? pid : process.pid;
      for (const c of list) {
        if (c.pid !== ownPid) continue;
        if (String(c.initialTitle || "").startsWith(marker)
          || String(c.title || "").startsWith(marker)) return c;
      }
      return null;
    },
    moveWindow(address, x, y) {
      const addr = normalizeAddress(address);
      return !!addr && send(luaDispatchMove(addr, x, y));
    },
    focusWindow(address) {
      const addr = normalizeAddress(address);
      return !!addr && send(luaDispatchFocus(addr));
    },
    focusLastWindow() { return send(luaDispatchFocusLast()); },
    setWindowPin(address, pin) {
      const addr = normalizeAddress(address);
      return !!addr && send(luaDispatchPin(addr, pin));
    },
    raiseWindow(address) {
      const addr = normalizeAddress(address);
      return !!addr && send(luaDispatchRaise(addr));
    },
    moveCursor(x, y) { return send(luaDispatchMoveCursor(x, y)); },
    defineWindowRule(name, matchPattern, effects) {
      return send(luaWindowRule(name, matchPattern, effects));
    },
    setWindowRuleEnabled(name, enabled) {
      return send(luaRuleSetEnabled(name, enabled));
    },
  };
}

// Replace screen.getCursorScreenPoint with the live Hyprland query on the
// native Wayland backend — Electron's own implementation returns {0,0}
// there (measured; Chromium has no global cursor query on Wayland).
// Must run after app ready. Mirrors installLinuxX11CursorFallback's shape.
function installHyprlandCursorProvider(screen, backend, options = {}) {
  if (!screen || typeof screen.getCursorScreenPoint !== "function") return false;
  if (!backend || typeof backend.cursorPoint !== "function") return false;
  if (options.force !== true && !backend.available) return false;
  const original = screen.getCursorScreenPoint.bind(screen);
  screen.getCursorScreenPoint = function getCursorScreenPoint() {
    const point = backend.cursorPoint();
    return point || original();
  };
  return true;
}

module.exports = {
  MARKER_PREFIX,
  RULE_PREFIX,
  isNativeWaylandSession,
  isWaylandBackendActive,
  isHyprlandSession,
  hyprlandSocketPath,
  encodeMarker,
  markerRegex,
  loadSocketBindings,
  buildSockAddr,
  ipcCommand,
  parseCursorPos,
  luaQuote,
  luaDispatchMove,
  luaDispatchFocus,
  luaDispatchFocusLast,
  luaDispatchPin,
  luaDispatchRaise,
  luaDispatchMoveCursor,
  luaWindowRule,
  luaRuleSetEnabled,
  createHyprlandBackend,
  installHyprlandCursorProvider,
};
