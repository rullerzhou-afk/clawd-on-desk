"use strict";

// Windows can leave a hidden tool window as GetForegroundWindow() after Esc.
// Remember only this invocation's native source; restoring it is allowed only
// while the palette itself still owns foreground. Never use ALT injection,
// z-order changes, or this path after a real target/user-driven focus change.
module.exports = function createQuickSelectOriginFocus(options = {}) {
  const noop = { capture: () => null, restore: () => false };
  if ((options.platform || process.platform) !== "win32") return noop;
  let bindings = options.bindings;
  try {
    if (!bindings) {
      const koffi = require("koffi");
      const user32 = koffi.load("user32.dll");
      const foreground = user32.func("void* __stdcall GetForegroundWindow()");
      const ownerPid = user32.func("uint32_t __stdcall GetWindowThreadProcessId(void*, _Out_ uint32_t*)");
      const visible = user32.func("bool __stdcall IsWindowVisible(void*)");
      const minimized = user32.func("bool __stdcall IsIconic(void*)");
      const setForeground = user32.func("bool __stdcall SetForegroundWindow(void*)");
      bindings = {
        foreground,
        visible,
        minimized,
        setForeground,
        pid: (hwnd) => { const pid = [0]; ownerPid(hwnd, pid); return pid[0]; },
        hwndOf: (win) => koffi.decode(win.getNativeWindowHandle(), "void *"),
        same: (a, b) => !!a && !!b && koffi.address(a) === koffi.address(b),
      };
    }
  } catch {
    return noop;
  }
  return {
    capture(win, previous = null) {
      try {
        const hwnd = bindings.foreground();
        if (!hwnd) return null;
        if (win && !win.isDestroyed() && bindings.same(hwnd, bindings.hwndOf(win))) return previous;
        const pid = bindings.pid(hwnd);
        return pid && bindings.visible(hwnd) && !bindings.minimized(hwnd) ? { hwnd, pid } : null;
      } catch { return null; }
    },
    restore(origin, win) {
      try {
        if (!origin || !win || win.isDestroyed()) return false;
        if (!bindings.same(bindings.foreground(), bindings.hwndOf(win))) return false;
        if (!bindings.visible(origin.hwnd) || bindings.minimized(origin.hwnd)) return false;
        if (bindings.pid(origin.hwnd) !== origin.pid) return false;
        return bindings.setForeground(origin.hwnd);
      } catch { return false; }
    },
  };
};
