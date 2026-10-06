"use strict";

// Electron's BrowserWindow.setFocusable(false) calls Focus(false) on Windows.
// That deactivates whichever application currently owns the foreground, so
// using it when a fullscreen game/video is detected makes Clawd itself take
// foreground. Keep Electron non-focusability fixed for the window's lifetime,
// toggle only WS_EX_NOACTIVATE, and intercept WM_MOUSEACTIVATE so Chromium uses
// MA_NOACTIVATE instead of eating the click with MA_NOACTIVATEANDEAT.

const GWL_EXSTYLE = -20;
const WS_EX_NOACTIVATE = 0x08000000n;
const WM_MOUSEACTIVATE = 0x0021;
const MA_NOACTIVATE = 3;
const MOUSE_ACTIVATE_PROP = "Chrome.IgnoreMouseActivate";
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const STYLE_REFRESH_FLAGS = SWP_NOSIZE
  | SWP_NOMOVE
  | SWP_NOZORDER
  | SWP_NOACTIVATE
  | SWP_FRAMECHANGED;

function asUnsignedStyle(value, pointerBits) {
  const raw = typeof value === "bigint" ? value : BigInt(value);
  return BigInt.asUintN(pointerBits, raw);
}

function createHitWindowActivationController(options = {}) {
  const isWin = options.isWin != null ? !!options.isWin : process.platform === "win32";
  const onError = typeof options.onError === "function" ? options.onError : () => {};
  const reportError = (error) => {
    try { onError(error); } catch {}
  };

  let bindings = options.bindings || null;
  let hwndOf = options.hwndOf || null;
  let pointerBits = Number(options.pointerBits) || 0;
  let styleRefreshPending = false;
  let refreshFailureReported = false;
  let hookedWindow = null;
  let hookArmFailureWindow = null;
  let legacyFallbackWindow = null;

  if (isWin && !bindings) {
    try {
      const koffi = options.koffi || require("koffi");
      const user32 = koffi.load("user32.dll");
      const ptrSize = koffi.sizeof("void *");
      pointerBits = ptrSize * 8;
      const GetWindowLongPtrW = user32.func(
        "intptr_t __stdcall GetWindowLongPtrW(void* hWnd, int nIndex)",
      );
      const SetWindowLongPtrW = user32.func(
        "intptr_t __stdcall SetWindowLongPtrW(void* hWnd, int nIndex, intptr_t dwNewLong)",
      );
      const SetWindowPos = user32.func(
        "bool __stdcall SetWindowPos(void* hWnd, void* hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)",
      );
      const SetPropW = user32.func(
        "bool __stdcall SetPropW(void* hWnd, str16 lpString, void* hData)",
      );
      const RemovePropW = user32.func(
        "void* __stdcall RemovePropW(void* hWnd, str16 lpString)",
      );
      bindings = {
        getStyle: (hwnd) => GetWindowLongPtrW(hwnd, GWL_EXSTYLE),
        setStyle: (hwnd, value) => SetWindowLongPtrW(hwnd, GWL_EXSTYLE, value),
        refreshStyle: (hwnd) => SetWindowPos(hwnd, null, 0, 0, 0, 0, STYLE_REFRESH_FLAGS),
        armMouseActivate: (hwnd) => SetPropW(hwnd, MOUSE_ACTIVATE_PROP, hwnd),
        clearMouseActivate: (hwnd) => RemovePropW(hwnd, MOUSE_ACTIVATE_PROP),
      };
      hwndOf = (win) => {
        if (!win || typeof win.getNativeWindowHandle !== "function") return null;
        const handle = win.getNativeWindowHandle();
        if (!handle || handle.length < ptrSize) return null;
        return koffi.decode(handle, "void *");
      };
    } catch (error) {
      reportError(error);
      bindings = null;
      hwndOf = null;
    }
  }

  if (!pointerBits) pointerBits = 64;
  const available = !!(
    isWin
    && bindings
    && typeof bindings.getStyle === "function"
    && typeof bindings.setStyle === "function"
    && typeof bindings.refreshStyle === "function"
    && typeof bindings.armMouseActivate === "function"
    && typeof bindings.clearMouseActivate === "function"
    && typeof hwndOf === "function"
  );

  function liveHwnd(win) {
    if (!available || !win) return null;
    if (typeof win.isDestroyed === "function" && win.isDestroyed()) return null;
    try {
      return hwndOf(win);
    } catch (error) {
      reportError(error);
      return null;
    }
  }

  function readNoActivate(win) {
    const hwnd = liveHwnd(win);
    if (!hwnd) return null;
    try {
      const style = asUnsignedStyle(bindings.getStyle(hwnd), pointerBits);
      return (style & WS_EX_NOACTIVATE) !== 0n;
    } catch (error) {
      reportError(error);
      return null;
    }
  }

  function setNoActivate(win, enabled) {
    const hwnd = liveHwnd(win);
    if (!hwnd) return false;
    try {
      const current = asUnsignedStyle(bindings.getStyle(hwnd), pointerBits);
      const next = enabled
        ? current | WS_EX_NOACTIVATE
        : current & ~WS_EX_NOACTIVATE;
      if (next === current && !styleRefreshPending) return true;

      if (next !== current) {
        const nativeNext = pointerBits > 32
          ? BigInt.asIntN(pointerBits, next)
          : Number(BigInt.asIntN(32, next));
        bindings.setStyle(hwnd, nativeNext);
      }
      // If SetWindowPos fails after the style write, remember that the frame
      // refresh is still owed. A later poll must retry it even though reading
      // the style bit now reports the desired value.
      styleRefreshPending = true;
      if (!bindings.refreshStyle(hwnd)) {
        if (!refreshFailureReported) {
          refreshFailureReported = true;
          reportError(new Error("Windows hit-window style refresh failed"));
        }
        return false;
      }
      styleRefreshPending = false;
      refreshFailureReported = false;
      const observed = asUnsignedStyle(bindings.getStyle(hwnd), pointerBits);
      return ((observed & WS_EX_NOACTIVATE) !== 0n) === !!enabled;
    } catch (error) {
      reportError(error);
      return false;
    }
  }

  function removeMouseActivateHook(win = hookedWindow) {
    if (!hookedWindow) return true;
    if (win && hookedWindow !== win) return false;
    const current = hookedWindow;
    if (typeof current.isDestroyed === "function" && current.isDestroyed()) {
      hookedWindow = null;
      return true;
    }
    if (typeof current.unhookWindowMessage !== "function") return false;
    try {
      const hwnd = liveHwnd(current);
      current.unhookWindowMessage(WM_MOUSEACTIVATE);
      hookedWindow = null;
      if (hwnd) bindings.clearMouseActivate(hwnd);
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  }

  function armMouseActivate(hwnd, win) {
    try {
      if (bindings.armMouseActivate(hwnd)) {
        hookArmFailureWindow = null;
        return true;
      }
      if (hookArmFailureWindow !== win) {
        hookArmFailureWindow = win;
        reportError(new Error("Windows hit-window mouse activation guard failed"));
      }
    } catch (error) {
      if (hookArmFailureWindow !== win) {
        hookArmFailureWindow = win;
        reportError(error);
      }
    }
    return false;
  }

  function ensureMouseActivateHook(win) {
    if (hookedWindow === win) return true;
    if (hookedWindow && !removeMouseActivateHook()) return false;
    const hwnd = liveHwnd(win);
    if (!hwnd || typeof win.hookWindowMessage !== "function") return false;
    try {
      win.hookWindowMessage(WM_MOUSEACTIVATE, () => { armMouseActivate(hwnd, win); });
      hookedWindow = win;
      if (!armMouseActivate(hwnd, win)) {
        removeMouseActivateHook(win);
        return false;
      }
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  }

  function prepare(win) {
    if (!isWin || !win) return false;
    if (typeof win.isDestroyed === "function" && win.isDestroyed()) return false;
    if (legacyFallbackWindow === win) return false;
    const prepared = ensureMouseActivateHook(win);
    legacyFallbackWindow = prepared ? null : win;
    return prepared;
  }

  function setFocusable(win, focusable) {
    if (!isWin || !win) return false;
    if (typeof win.isDestroyed === "function" && win.isDestroyed()) return false;
    // A failed pre-show guard falls back to Electron focusability and must not
    // later drift into a mixed Electron-focusable/native-controlled state.
    if (legacyFallbackWindow === win) return false;

    const hookReady = ensureMouseActivateHook(win);
    // Do not short-circuit: fullscreen style safety still matters if the
    // delivery guard cannot be re-armed on an already visible window.
    const next = !!focusable;
    const styleReady = next
      ? available && setNoActivate(win, false)
      : setNoActivate(win, true);
    return hookReady && styleReady;
  }

  function dispose() {
    const removed = removeMouseActivateHook();
    hookArmFailureWindow = null;
    legacyFallbackWindow = null;
    return removed;
  }

  return {
    available,
    dispose,
    isNonActivating: readNoActivate,
    prepare,
    setFocusable,
  };
}

function createHitWindowFocusableSetter(options = {}) {
  const isWin = !!options.isWin;
  const controller = options.controller;
  const getHitWindow = typeof options.getHitWindow === "function"
    ? options.getHitWindow
    : () => null;
  return function setHitWinFocusable(focusable) {
    if (!isWin || !controller || typeof controller.setFocusable !== "function") return false;
    return controller.setFocusable(getHitWindow(), focusable);
  };
}

function createHitWindowActivationRuntime(options = {}) {
  const isWin = options.isWin != null ? !!options.isWin : process.platform === "win32";
  const controller = createHitWindowActivationController({ ...options, isWin });
  const setHitWinFocusable = createHitWindowFocusableSetter({
    isWin,
    controller,
    getHitWindow: options.getHitWindow,
  });
  return {
    controller,
    windowsHitWindowFocusable: isWin && !controller.available,
    setHitWinFocusable,
  };
}

module.exports = {
  createHitWindowActivationController,
  createHitWindowActivationRuntime,
  createHitWindowFocusableSetter,
  GWL_EXSTYLE,
  WS_EX_NOACTIVATE,
  WM_MOUSEACTIVATE,
  MA_NOACTIVATE,
  MOUSE_ACTIVATE_PROP,
  STYLE_REFRESH_FLAGS,
};
