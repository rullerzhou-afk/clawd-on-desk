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

// A maximized normal window covers the work area but leaves the taskbar strip,
// so its rect stops short of the full monitor. A fullscreen app covers the
// whole monitor (rcMonitor). A couple of px of slack absorbs DPI rounding
// without mistaking a maximized window for fullscreen.
const FULLSCREEN_TOLERANCE_PX = 2;

const MONITOR_DEFAULTTONEAREST = 2;

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

// Returns a function `() => boolean` that reports whether the current
// foreground window covers its whole monitor. Never throws; degrades to a
// constant-false probe off Windows or when the FFI cannot be loaded.
function createForegroundFullscreenProbe(options = {}) {
  const isWin = options.isWin != null ? !!options.isWin : process.platform === "win32";
  const noop = () => false;
  if (!isWin) return noop;

  let GetForegroundWindow;
  let GetWindowRect;
  let MonitorFromWindow;
  let GetMonitorInfoW;
  let monitorInfoSize;
  try {
    const koffi = options.koffi || require("koffi");
    const user32 = koffi.load("user32.dll");
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
  } catch (err) {
    if (typeof options.onError === "function") options.onError(err);
    return noop;
  }

  return function isForegroundFullscreen() {
    try {
      const hwnd = GetForegroundWindow();
      if (!hwnd) return false;

      const winRect = {};
      if (!GetWindowRect(hwnd, winRect)) return false;

      const hMonitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
      if (!hMonitor) return false;

      const info = { cbSize: monitorInfoSize, rcMonitor: {}, rcWork: {}, dwFlags: 0 };
      if (!GetMonitorInfoW(hMonitor, info)) return false;

      return rectCoversMonitor(winRect, info.rcMonitor);
    } catch {
      // Any FFI hiccup at call time: behave as "not fullscreen" so the
      // watchdog keeps the pet visible rather than hiding it on an error.
      return false;
    }
  };
}

module.exports = {
  createForegroundFullscreenProbe,
  rectCoversMonitor,
  FULLSCREEN_TOLERANCE_PX,
};
