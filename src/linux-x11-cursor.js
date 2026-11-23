"use strict";

// ── Linux / X11: live global cursor position ──
//
// Under the X11 Ozone backend, Electron's screen.getCursorScreenPoint() returns
// the root location of the last pointer event Chromium itself received, not a
// fresh query. Once the cursor leaves our own windows the value freezes at the
// last point seen, so idle eye tracking looks at a stale spot (measured on
// Electron 41 / Xorg: ~80% of samples wrong while the cursor roamed a
// dual-head desktop, correct only near the pet window).
//
// Fix: on the X11 backend, ask the X server directly with xcb_query_pointer on
// the root window and convert the physical root coordinates to DIP through the
// display that contains them (see physicalToDipPoint). The caller
// decides "X11 backend" the same way as linux-x11-input-hint (Chromium's
// resolved --ozone-platform), so this also covers the #441 XWayland relaunch.
// Any failure falls back to Electron's own value.
//
// XCB rather than Xlib, as in linux-x11-input-hint: a failed request comes
// back as a value instead of reaching Xlib's default error handler, which
// exits the process. The private connection stays open for the life of the
// process (one round trip per poll); Chromium's own X connection is never
// touched.

function loadXcbPointerBindings(koffi) {
  const xcb = koffi.load("libxcb.so.1");
  // free() from the process's global symbol scope, not libc.so.6: Chromium
  // interposes malloc/free (PartitionAlloc), so libxcb's replies come from the
  // shim and glibc's own free() on them crashes Electron (measured: SIGSEGV on
  // the first reply). In plain Node both resolve to glibc.
  const self = koffi.load(null);
  // Anonymous structs: nothing is registered by name in the Koffi registry.
  const ScreenIterator = koffi.struct({ data: "void *", rem: "int", index: "int" });
  const QueryPointerCookie = koffi.struct({ sequence: "unsigned int" });
  const QueryPointerReply = koffi.struct({
    response_type: "uint8_t",
    same_screen: "uint8_t",
    sequence: "uint16_t",
    length: "uint32_t",
    root: "uint32_t",
    child: "uint32_t",
    root_x: "int16_t",
    root_y: "int16_t",
    win_x: "int16_t",
    win_y: "int16_t",
    mask: "uint16_t",
    pad0: koffi.array("uint8_t", 2),
  });

  const connect = xcb.func("xcb_connect", "void *", ["str", koffi.out(koffi.pointer("int"))]);
  const getSetup = xcb.func("xcb_get_setup", "void *", ["void *"]);
  const rootsIterator = xcb.func("xcb_setup_roots_iterator", ScreenIterator, ["void *"]);
  const screenNext = xcb.func("xcb_screen_next", "void", [koffi.inout(koffi.pointer(ScreenIterator))]);
  const queryPointer = xcb.func("xcb_query_pointer", QueryPointerCookie, ["void *", "uint32_t"]);
  const queryPointerReply = xcb.func("xcb_query_pointer_reply", "void *", [
    "void *", QueryPointerCookie, koffi.out(koffi.pointer("void *")),
  ]);
  const free = self.func("free", "void", ["void *"]);

  return {
    // xcb_connect() never returns NULL: a failure is an error connection,
    // which still has to be disconnected.
    connect(displayName) {
      const screen = [0];
      const connection = connect(displayName, screen);
      return { connection, screen: screen[0] };
    },
    hasError: xcb.func("xcb_connection_has_error", "int", ["void *"]),
    rootWindow(connection, screenNumber) {
      const iterator = rootsIterator(getSetup(connection));
      for (let i = 0; i < screenNumber && iterator.rem > 0; i++) screenNext(iterator);
      if (!iterator.data || iterator.rem <= 0) return null;
      // xcb_screen_t starts with its root window id.
      return koffi.decode(iterator.data, "uint32_t");
    },
    queryPointer(connection, root) {
      const error = [null];
      const reply = queryPointerReply(connection, queryPointer(connection, root), error);
      if (error[0]) free(error[0]);
      if (!reply) return null;
      try {
        const fields = koffi.decode(reply, QueryPointerReply);
        return { sameScreen: fields.same_screen !== 0, x: fields.root_x, y: fields.root_y };
      } finally {
        free(reply);
      }
    },
    disconnect: xcb.func("xcb_disconnect", "void", ["void *"]),
  };
}

// Returns a function that yields the pointer's physical root coordinates, or
// null when unavailable (no libxcb, connection failed or lost, pointer on
// another X screen). A failed connection is not retried.
function createX11PointerQuery(options = {}) {
  const displayName = typeof options.displayName === "string" && options.displayName
    ? options.displayName
    : null;
  const onError = typeof options.onError === "function" ? options.onError : () => {};
  const reportError = (error) => {
    try { onError(error); } catch {}
  };

  let state = null; // null = not opened yet, false = unavailable

  function open() {
    const bindings = options.bindings || loadXcbPointerBindings(options.koffi || require("koffi"));
    const { connection, screen } = bindings.connect(displayName);
    if (!connection) throw new Error("X11 connection failed");
    try {
      const connectionError = bindings.hasError(connection);
      if (connectionError) {
        throw new Error(`X11 connection failed (xcb_connection_has_error ${connectionError})`);
      }
      const root = bindings.rootWindow(connection, screen);
      if (!root) throw new Error(`X11 root window not found for screen ${screen}`);
      return { bindings, connection, root };
    } catch (error) {
      try { bindings.disconnect(connection); } catch {}
      throw error;
    }
  }

  function shutdown(error) {
    const current = state;
    state = false;
    reportError(error);
    try { current.bindings.disconnect(current.connection); } catch (err) { reportError(err); }
  }

  return function queryPointer() {
    if (state === false) return null;
    if (state === null) {
      try {
        state = open();
      } catch (error) {
        state = false;
        reportError(error);
        return null;
      }
    }
    try {
      const pointer = state.bindings.queryPointer(state.connection, state.root);
      if (pointer) return pointer.sameScreen ? { x: pointer.x, y: pointer.y } : null;
      const connectionError = state.bindings.hasError(state.connection);
      if (connectionError) {
        shutdown(new Error(`X11 connection lost (xcb_connection_has_error ${connectionError})`));
      }
      return null;
    } catch (error) {
      shutdown(error);
      return null;
    }
  };
}

// Convert physical root coordinates to DIP through the display whose physical
// rect contains the point; null when none does (a gap between displays, or no
// nativeOrigin). Not screen.screenToDipPoint(): on X11, Electron 41 picks the
// display with GetDisplayNearestPoint(physical point), a lookup that expects
// DIP, so with mixed scale factors it can pick the wrong display.
function physicalToDipPoint(displays, point) {
  if (!Array.isArray(displays) || !point) return null;
  for (const display of displays) {
    const origin = display && display.nativeOrigin;
    const bounds = display && display.bounds;
    const scale = display && display.scaleFactor;
    if (!origin || !bounds || !(scale > 0)) continue;
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    if (dx < 0 || dy < 0) continue;
    if (dx >= Math.round(bounds.width * scale) || dy >= Math.round(bounds.height * scale)) continue;
    // Floor, not round: at scale 2 the last physical column 1919 maps to
    // 959.5, and rounding would put it outside a 960-DIP-wide display.
    return {
      x: Math.floor(bounds.x + dx / scale),
      y: Math.floor(bounds.y + dy / scale),
    };
  }
  return null;
}

// Replace screen.getCursorScreenPoint with the live X11 query on the X11
// backend. Must run after app ready (the screen module throws before it).
// Returns true if installed.
function installLinuxX11CursorFallback(screen, options = {}) {
  if (!options.isLinuxX11) return false;
  if (!screen || typeof screen.getCursorScreenPoint !== "function") return false;
  // Without the display list the physical point cannot be converted to DIP.
  if (typeof screen.getAllDisplays !== "function") return false;
  const query = options.queryPointer || createX11PointerQuery(options);
  const original = screen.getCursorScreenPoint.bind(screen);
  screen.getCursorScreenPoint = function getCursorScreenPoint() {
    const physical = query();
    if (!physical) return original();
    let dip = null;
    try {
      dip = physicalToDipPoint(screen.getAllDisplays(), physical);
    } catch {}
    return dip || original();
  };
  return true;
}

module.exports = {
  loadXcbPointerBindings,
  createX11PointerQuery,
  physicalToDipPoint,
  installLinuxX11CursorFallback,
};
