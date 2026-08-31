"use strict";

// ── Windows: detect whether the foreground window is fullscreen ──
//
// The topmost watchdog (topmost-runtime.js) re-asserts the pet/hit windows to
// the "pop-up-menu" level every few seconds, and guardAlwaysOnTop fights back
// whenever something else grabs topmost. On Windows that means a fullscreen
// game/video keeps getting interrupted: the pet claws its way back on top
// roughly every watchdog tick (#538).
//
// This probe lets the watchdog ask "is a real fullscreen app the foreground
// right now?" and, if so, stand down for that cycle — the pet naturally falls
// behind the fullscreen content and pops back once the user exits fullscreen.
//
// Everything here is best-effort: if koffi/user32 is unavailable the factory
// returns a probe that always answers false, so the watchdog keeps its current
// behavior rather than ever hiding the pet because the FFI broke.

// A maximized normal window covers the work area, so on a monitor that reserves
// a taskbar strip its rect stops short of the full monitor while a fullscreen
// app covers the whole monitor (rcMonitor). A couple of px of slack absorbs DPI
// rounding. Geometry alone is NOT sufficient though — see isMaximizedNormalWindow
// for the monitors where rcWork == rcMonitor and this test stops separating them.
const FULLSCREEN_TOLERANCE_PX = 2;

const MONITOR_DEFAULTTONEAREST = 2;

// #719: the desktop itself passes the geometry test. Clicking the desktop
// makes the shell window the foreground window — Progman, or one of
// explorer's WorkerW siblings when a wallpaper host re-parents the icon view —
// and its rect covers the whole monitor, so geometry alone classifies the
// bare desktop as a fullscreen app. That made the hit window go non-activating
// ~1s after any desktop click (startFocusablePoll), and Electron's
// setFocusable(false) on Windows ends in Focus(false), which deactivates —
// cancelling e.g. an in-place file rename on the desktop. Excluding the shell
// window classes keeps "fullscreen" meaning an actual app.
const DESKTOP_SHELL_WINDOW_CLASSES = new Set(["progman", "workerw"]);
// Ample for real class names; matches win-foreground-terminal.js.
const CLASS_NAME_BUF_LEN = 256;

// #871: the geometry test above silently assumes the monitor reserves a taskbar
// strip. A secondary display usually shows no taskbar, and an auto-hidden
// taskbar reserves a 1px sliver that fits inside FULLSCREEN_TOLERANCE_PX — in
// both cases rcWork == rcMonitor, so an ordinary MAXIMIZED window covers
// rcMonitor and geometry calls it a fullscreen app. The pet then flipped its hit
// window non-activating, and setFocusable(false) deactivates whatever had focus
// (same mechanism as #719), so clicking an input box in a maximized browser on
// that monitor lost focus.
//
// A window that is maximized AND still owns its caption is a normal window, not
// a fullscreen presentation. Deliberately narrower than "has a caption": it only
// overrides the verdict for maximized windows, so exclusive fullscreen, a
// borderless WS_POPUP, and F11 (which drops the caption) all keep the answer
// they got before — #538 / #562 stand-down behavior is untouched.
const GWL_STYLE = -16;
const WS_CAPTION = 0x00c00000; // WS_BORDER | WS_DLGFRAME — check the whole mask
const WS_MAXIMIZE = 0x01000000;

// Win32 class-name comparison is case-insensitive.
function isDesktopShellWindowClass(className) {
  return typeof className === "string"
    && DESKTOP_SHELL_WINDOW_CLASSES.has(className.toLowerCase());
}

// Pure style decision, exported for the same reason as rectCoversMonitor.
function isMaximizedNormalWindow(style) {
  if (!Number.isFinite(style)) return false;
  return (style & WS_MAXIMIZE) !== 0 && (style & WS_CAPTION) === WS_CAPTION;
}

// Pure geometry: does the window rect cover the entire monitor rect (not just
// the work area)? Exported so the decision logic is unit-testable without FFI.
function rectCoversMonitor(winRect, monitorRect, tolerance = FULLSCREEN_TOLERANCE_PX) {
  if (!winRect || !monitorRect) return false;
  return (
    winRect.left <= monitorRect.left + tolerance &&
    winRect.top <= monitorRect.top + tolerance &&
    winRect.right >= monitorRect.right - tolerance &&
    winRect.bottom >= monitorRect.bottom - tolerance
  );
}

// Returns a probe function reporting whether the current foreground window
// covers its whole monitor. `false` when it does not; when it DOES, an opaque
// per-window id string (#935 — the fullscreen auto-hide override binds to it
// so it can tell "the same app again" from "the next fullscreen app"), or
// plain `true` if koffi cannot supply an address. Every verdict-only consumer
// keeps working on truthiness. Never throws; degrades to a constant-false
// probe off Windows or when the FFI cannot be loaded.
function createForegroundFullscreenProbe(options = {}) {
  const isWin = options.isWin != null ? !!options.isWin : process.platform === "win32";
  const noop = () => false;
  noop.getLastObservation = () => ({ reliable: false, foregroundId: null, fullscreenId: null });
  noop.isWindowIdAlive = () => null;
  if (!isWin) return noop;

  let GetForegroundWindow;
  let GetWindowRect;
  let MonitorFromWindow;
  let GetMonitorInfoW;
  let GetClassNameW;
  let monitorInfoSize;
  let user32;
  let addressOf = null;
  try {
    const koffi = options.koffi || require("koffi");
    // #935: HWND -> stable numeric address for the identity above. Optional —
    // its absence only costs identity (probe answers plain true), never the
    // fullscreen verdict itself.
    if (typeof koffi.address === "function") addressOf = koffi.address;
    user32 = koffi.load("user32.dll");
    // LONG is 32-bit even on Win64 (LLP64); use int32 to be unambiguous.
    koffi.struct("ClawdRECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });
    koffi.struct("ClawdMONITORINFO", {
      cbSize: "uint32",
      rcMonitor: "ClawdRECT",
      rcWork: "ClawdRECT",
      dwFlags: "uint32",
    });
    monitorInfoSize = koffi.sizeof("ClawdMONITORINFO");
    GetForegroundWindow = user32.func("void* __stdcall GetForegroundWindow()");
    GetWindowRect = user32.func("bool __stdcall GetWindowRect(void* hWnd, _Out_ ClawdRECT* lpRect)");
    MonitorFromWindow = user32.func("void* __stdcall MonitorFromWindow(void* hWnd, uint32 dwFlags)");
    GetMonitorInfoW = user32.func("bool __stdcall GetMonitorInfoW(void* hMonitor, _Inout_ ClawdMONITORINFO* lpmi)");
    GetClassNameW = user32.func("int __stdcall GetClassNameW(void* hWnd, _Out_ uint16_t* lpClassName, int nMaxCount)");
  } catch (err) {
    if (typeof options.onError === "function") options.onError(err);
    return noop;
  }

  // Optional lifetime check for a remembered fullscreen HWND. Keeping this
  // separate from the core bindings preserves the detector if an unusual
  // user32 surface cannot expose IsWindow: unknown lifetime must fail open,
  // never disable fullscreen detection.
  let IsWindow = null;
  try {
    IsWindow = user32.func("bool __stdcall IsWindow(void* hWnd)");
  } catch (err) {
    if (typeof options.onError === "function") options.onError(err);
  }

  // Bound separately (#871): GetWindowLongPtrW is a macro over GetWindowLongW on
  // 32-bit Windows, so the export can be missing. Losing it must only cost the
  // style refinement — folding it into the block above would turn a missing
  // symbol into a constant-false probe and silently undo the #538 stand-down.
  // Return type int32 for the same reason the RECT fields are: only the low 32
  // bits carry style flags, LONG_PTR's high half is padding here.
  let GetWindowLongPtrW = null;
  try {
    GetWindowLongPtrW = user32.func("int32 __stdcall GetWindowLongPtrW(void* hWnd, int nIndex)");
  } catch (err) {
    if (typeof options.onError === "function") options.onError(err);
  }

  let lastObservation = { reliable: false, foregroundId: null, fullscreenId: null };

  function getWindowId(hwnd) {
    if (!addressOf) return null;
    try {
      return String(addressOf(hwnd));
    } catch {
      return null;
    }
  }

  function isWindowIdAlive(windowId) {
    if (!IsWindow || typeof windowId !== "string" || !/^\d+$/.test(windowId)) return null;
    try {
      // Koffi accepts BigInt values for pointer arguments. The opaque id is
      // the decimal form of koffi.address(HWND), so this reverses that losslessly.
      return !!IsWindow(BigInt(windowId));
    } catch (err) {
      if (typeof options.onCallError === "function") options.onCallError(err);
      return null;
    }
  }

  function recordNotFullscreen(foregroundId, reliable = true) {
    lastObservation = { reliable, foregroundId, fullscreenId: null };
    return false;
  }

  function isForegroundFullscreen() {
    try {
      const hwnd = GetForegroundWindow();
      if (!hwnd) return recordNotFullscreen(null, false);
      const foregroundId = getWindowId(hwnd);

      const winRect = {};
      if (!GetWindowRect(hwnd, winRect)) return recordNotFullscreen(foregroundId, false);

      const hMonitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
      if (!hMonitor) return recordNotFullscreen(foregroundId, false);

      const info = { cbSize: monitorInfoSize, rcMonitor: {}, rcWork: {}, dwFlags: 0 };
      if (!GetMonitorInfoW(hMonitor, info)) return recordNotFullscreen(foregroundId, false);

      if (!rectCoversMonitor(winRect, info.rcMonitor)) return recordNotFullscreen(foregroundId);

      // Geometry matched — rule out the desktop shell (#719). Only reached in
      // the rare covers-monitor case, so the extra FFI call is off the common
      // path. A failed class read (0 length) keeps the geometric answer: the
      // pre-#719 behavior, erring toward "fullscreen" for a covering window.
      const classBuf = new Uint16Array(CLASS_NAME_BUF_LEN);
      const classLen = GetClassNameW(hwnd, classBuf, CLASS_NAME_BUF_LEN);
      if (classLen > 0) {
        let className = "";
        for (let i = 0; i < classLen; i++) className += String.fromCharCode(classBuf[i]);
        if (isDesktopShellWindowClass(className)) return recordNotFullscreen(foregroundId);
      }

      // #871: last, separate a merely maximized window from a real fullscreen
      // presentation. Unavailable binding or a 0 read (GetWindowLongPtrW's
      // failure return) keeps the geometric answer, matching the class-read
      // fallback above.
      if (GetWindowLongPtrW) {
        const style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        if (isMaximizedNormalWindow(style)) return recordNotFullscreen(foregroundId);
      }
      // Fullscreen: report the window's identity, not just the verdict (#935).
      if (foregroundId != null) {
        lastObservation = { reliable: true, foregroundId, fullscreenId: foregroundId };
        return foregroundId;
      }
      lastObservation = { reliable: true, foregroundId: null, fullscreenId: true };
      return true;
    } catch (err) {
      // Any FFI hiccup at call time: behave as "not fullscreen" so the
      // watchdog keeps the pet visible rather than hiding it on an error.
      lastObservation = { reliable: false, foregroundId: null, fullscreenId: null };
      if (typeof options.onCallError === "function") options.onCallError(err);
      return false;
    }
  }

  // A false fullscreen verdict used to lose the foreground HWND entirely.
  // Keep the last reliable identity alongside the boolean-compatible return so
  // the auto-hide override can distinguish "same HWND exited F11" from an
  // Alt-Tab/tray foreground excursion to a different window.
  isForegroundFullscreen.getLastObservation = () => ({ ...lastObservation });
  isForegroundFullscreen.isWindowIdAlive = isWindowIdAlive;
  return isForegroundFullscreen;
}

module.exports = {
  createForegroundFullscreenProbe,
  rectCoversMonitor,
  isDesktopShellWindowClass,
  isMaximizedNormalWindow,
  FULLSCREEN_TOLERANCE_PX,
};
