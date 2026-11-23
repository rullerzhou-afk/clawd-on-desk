"use strict";

const os = require("os");

// #979 follow-up: on X11, tell the window manager that the pet's render window
// never takes keyboard input.
//
// The render window is output-only. Pointer input goes to the separate hit
// window, which Chromium creates override-redirect because it is constructed
// focusable:false. The render window stays managed (stacking, placement and
// the #979 sticky state all go through the WM), and Chromium gives it no
// WM_HINTS at all, which ICCCM tells the WM to read as "accepts keyboard
// focus". Once the window is sticky, that matters on mutter: when a window
// that asked to be on all workspaces gains focus, meta_window_make_most_recent()
// moves it to the front of EVERY workspace's MRU list, and a workspace switch
// focuses the first focusable MRU window of the new workspace. After one
// switch the pet kept the keyboard instead of the editor the user returned to.
//
// Electron cannot express "managed, but never focused": focusable:false makes
// Chromium create an override-redirect window instead (x11_window.cc: "An
// in-activatable window should not interact with the system wm"), which would
// also take the window out of WM stacking and placement. So write ICCCM
// WM_HINTS { flags: InputHint, input: False } directly. Replacing the whole
// property loses nothing: Chromium sets no WM_HINTS when it creates the
// window, and its only later write (the urgency bit in SetFlashFrameHint) is
// read-modify-write, so it keeps this flag.
//
// The render window is already mapped when this runs (show defaults to true),
// so mutter picks the hint up from PropertyNotify: it decides every later
// focus question, not the focus-on-map at creation.
//
// XCB rather than Xlib: a failed request comes back from xcb_request_check()
// as a value, instead of reaching Xlib's default error handler, which exits
// the process. The connection is private and closed right away; Chromium's
// own X connection is never touched.

const XCB_PROP_MODE_REPLACE = 0;
const XA_WM_HINTS = 35; // predefined atom; WM_HINTS is also its own type
const WM_HINTS_INPUT_HINT = 1; // ICCCM flags bit 0: the input field is set
const WM_HINTS_FIELD_COUNT = 9; // ICCCM WM_HINTS is nine CARD32 fields
const MAX_XID = 0x1fffffff; // X resource ids are 29 bits

// Electron returns the X11 Window (an unsigned long) as raw native-endian bytes.
function readXid(win) {
  if (!win || typeof win.getNativeWindowHandle !== "function") return null;
  if (typeof win.isDestroyed === "function" && win.isDestroyed()) return null;
  const handle = win.getNativeWindowHandle();
  if (!Buffer.isBuffer(handle) || handle.length < 4) return null;
  const littleEndian = os.endianness() === "LE";
  let xid;
  if (handle.length >= 8) {
    xid = littleEndian ? handle.readBigUInt64LE(0) : handle.readBigUInt64BE(0);
  } else {
    xid = BigInt(littleEndian ? handle.readUInt32LE(0) : handle.readUInt32BE(0));
  }
  if (xid <= 0n || xid > BigInt(MAX_XID)) return null;
  return Number(xid);
}

// Format-32 property data travels in the client's byte order, which XCB
// declares for the connection, so a native-endian Uint32Array is correct.
function encodeNoInputWmHints() {
  const fields = new Uint32Array(WM_HINTS_FIELD_COUNT);
  fields[0] = WM_HINTS_INPUT_HINT; // flags; fields[1] (input) stays 0 = False
  return Buffer.from(fields.buffer);
}

function loadXcbBindings(koffi) {
  const xcb = koffi.load("libxcb.so.1");
  // libxcb allocates replies and errors with the process's malloc, which in
  // Electron is Chromium's allocator shim, not glibc's. free() has to come from
  // the same global scope: koffi.load(null) is dlopen(NULL) and resolves to
  // the shim, while a libc.so.6 handle returns glibc's own free(), which
  // aborts on a PartitionAlloc pointer. Plain Node can't tell the two apart.
  const processScope = koffi.load(null);
  // Anonymous struct: nothing is registered by name in the Koffi registry.
  const VoidCookie = koffi.struct({ sequence: "unsigned int" });
  return {
    connect: xcb.func("xcb_connect", "void *", ["str", "int *"]),
    hasError: xcb.func("xcb_connection_has_error", "int", ["void *"]),
    changePropertyChecked: xcb.func("xcb_change_property_checked", VoidCookie, [
      "void *", "uint8_t", "uint32_t", "uint32_t", "uint32_t", "uint8_t", "uint32_t", "void *",
    ]),
    requestCheck: xcb.func("xcb_request_check", "void *", ["void *", VoidCookie]),
    // xcb_generic_error_t: response_type, error_code, ...
    errorCode: (error) => koffi.decode(error, "uint8_t", 2)[1],
    freeError: processScope.func("free", "void", ["void *"]),
    disconnect: xcb.func("xcb_disconnect", "void", ["void *"]),
  };
}

function createLinuxX11InputHint(options = {}) {
  const enabled = !!options.isLinuxX11;
  const displayName = typeof options.displayName === "string" && options.displayName
    ? options.displayName
    : null;
  const onError = typeof options.onError === "function" ? options.onError : () => {};
  const reportError = (error) => {
    try { onError(error); } catch {}
  };

  let bindings = options.bindings || null;
  if (enabled && !bindings) {
    try {
      bindings = loadXcbBindings(options.koffi || require("koffi"));
    } catch (error) {
      reportError(error);
      bindings = null;
    }
  }
  const available = !!(enabled && bindings);

  // Returns true once the hint is on the window; false when unavailable, when
  // the window has no usable X11 id, or when the X server refused the write.
  function applyNoInputHint(win) {
    if (!available) return false;
    let xid;
    try {
      xid = readXid(win);
    } catch (error) {
      reportError(error);
      return false;
    }
    if (!xid) return false;

    let connection = null;
    try {
      // xcb_connect() never returns NULL: a failure is an error connection,
      // which still has to be disconnected.
      connection = bindings.connect(displayName, null);
      if (!connection) {
        reportError(new Error("X11 connection failed"));
        return false;
      }
      const connectionError = bindings.hasError(connection);
      if (connectionError) {
        reportError(new Error(`X11 connection failed (xcb_connection_has_error ${connectionError})`));
        return false;
      }
      const cookie = bindings.changePropertyChecked(
        connection,
        XCB_PROP_MODE_REPLACE,
        xid,
        XA_WM_HINTS,
        XA_WM_HINTS,
        32,
        WM_HINTS_FIELD_COUNT,
        encodeNoInputWmHints(),
      );
      // Round trip, so a refused write is reported here instead of being
      // dropped along with the connection.
      const error = bindings.requestCheck(connection, cookie);
      if (error) {
        let code = null;
        try {
          code = bindings.errorCode(error);
        } finally {
          bindings.freeError(error);
        }
        reportError(new Error(`X11 WM_HINTS write failed (error code ${code})`));
        return false;
      }
      return true;
    } catch (error) {
      reportError(error);
      return false;
    } finally {
      if (connection) {
        try { bindings.disconnect(connection); } catch (error) { reportError(error); }
      }
    }
  }

  return { available, applyNoInputHint };
}

module.exports = {
  createLinuxX11InputHint,
  loadXcbBindings,
  readXid,
  encodeNoInputWmHints,
  XA_WM_HINTS,
  WM_HINTS_INPUT_HINT,
  WM_HINTS_FIELD_COUNT,
};
