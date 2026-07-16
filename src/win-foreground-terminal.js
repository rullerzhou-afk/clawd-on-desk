"use strict";

// ── Windows: detect the foreground Windows Terminal window (if any) ──
//
// #627 residual: UserPromptSubmit needs to know which WT window is in the
// foreground at prompt-submit time (foregroundWtHwnd), but the only way the
// hook itself could answer that was a cold PowerShell + Add-Type +
// GetForegroundWindow spawn — and when Windows Terminal is the OS default
// terminal app, that spawn flashes a visible console window despite
// windowsHide:true (WT's console delegation doesn't always honor
// CREATE_NO_WINDOW). This probe answers the same question with a synchronous
// koffi FFI call from inside the already-running Electron main process: no
// subprocess is created, so the WT default-terminal delegation path never
// engages, so it cannot flash.
//
// Modeled on src/win-fullscreen-detect.js: best-effort, degrades to a
// constant-null probe off Windows or when the FFI cannot be loaded, and
// never throws at call time. Returns null (never a placeholder HWND)
// whenever any step of the read is uncertain, so callers fall back to the
// session's last-known wt_hwnd instead of shipping a wrong one.
//
// See docs/plans/plan-issue-627-residual-userprompt-flash.md §4.1.

const path = require("path");
const {
  WINDOWS_TERMINAL_WINDOW_CLASS,
  WINDOWS_TERMINAL_PROCESS_NAMES,
} = require("../hooks/shared-process");

// GetAncestor flag: root owner window (matches the PS snapshot script in
// hooks/shared-process.js, which passes gaFlags=2 / GA_ROOT).
const GA_ROOT = 2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
// Matches the PS script's StringBuilder(256) for GetClassName.
const CLASS_NAME_BUF_LEN = 256;
// Generous headroom for QueryFullProcessImageNameW; Windows extended-length
// paths cap at 32767 chars + NUL.
const IMAGE_NAME_BUF_LEN = 32768;

function utf16BufToString(buf, len) {
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(buf[i]);
  return out;
}

// Returns a function `() => string|null` that reports the DECIMAL HWND
// string (see normalizeHwndString in src/server-route-state.js /
// hooks/shared-process.js — both expect base-10) of the foreground window
// IFF it is a real Windows Terminal window, or null when: the foreground
// isn't WT, the FFI is unavailable, or any step along the way is uncertain
// (including expected misses like an elevated WT with a non-elevated
// Clawd). Never spawns a subprocess and never throws.
function createForegroundWindowsTerminalProbe(options = {}) {
  const isWin = options.isWin != null ? !!options.isWin : process.platform === "win32";
  const noop = () => null;
  if (!isWin) return noop;

  let koffi;
  let GetForegroundWindow, GetAncestor, GetClassNameW, GetWindowThreadProcessId,
    OpenProcess, QueryFullProcessImageNameW, CloseHandle;
  try {
    koffi = options.koffi || require("koffi");
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");
    GetForegroundWindow = user32.func("void* __stdcall GetForegroundWindow()");
    GetAncestor = user32.func("void* __stdcall GetAncestor(void* hWnd, uint32 gaFlags)");
    GetClassNameW = user32.func("int __stdcall GetClassNameW(void* hWnd, _Out_ uint16_t* lpClassName, int nMaxCount)");
    GetWindowThreadProcessId = user32.func("uint32 __stdcall GetWindowThreadProcessId(void* hWnd, _Out_ uint32* lpdwProcessId)");
    OpenProcess = kernel32.func("void* __stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)");
    QueryFullProcessImageNameW = kernel32.func("bool __stdcall QueryFullProcessImageNameW(void* hProcess, uint32 dwFlags, _Out_ uint16_t* lpExeName, _Inout_ uint32* lpdwSize)");
    CloseHandle = kernel32.func("bool __stdcall CloseHandle(void* hObject)");
  } catch (err) {
    // Init failure only: koffi require / DLL load / func declaration. Warn
    // once (the factory is called once at startup) and degrade to noop.
    if (typeof options.onError === "function") options.onError(err);
    return noop;
  }

  return function captureForegroundWindowsTerminal() {
    try {
      let hwnd = GetForegroundWindow();
      if (!hwnd) return null; // expected: no foreground window right now

      // GA_ROOT normalizes a child/owned window up to its root owner — same
      // as the PS snapshot script. A 0 result is NOT a failure (rare, e.g.
      // the desktop window itself); keep the original foreground hwnd.
      const root = GetAncestor(hwnd, GA_ROOT);
      if (root) hwnd = root;

      const classBuf = new Uint16Array(CLASS_NAME_BUF_LEN);
      const classLen = GetClassNameW(hwnd, classBuf, CLASS_NAME_BUF_LEN);
      if (!classLen) return null; // expected miss: invalid/gone window
      const className = utf16BufToString(classBuf, classLen);
      if (className.toLowerCase() !== WINDOWS_TERMINAL_WINDOW_CLASS.toLowerCase()) {
        return null; // expected miss: foreground isn't a WT window
      }

      const pidOut = [0];
      GetWindowThreadProcessId(hwnd, pidOut);
      const pid = pidOut[0];
      if (!pid) return null;

      let hProcess = null;
      try {
        hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (!hProcess) return null; // expected miss: e.g. elevated WT vs non-elevated Clawd

        const nameBuf = new Uint16Array(IMAGE_NAME_BUF_LEN);
        const sizeOut = [IMAGE_NAME_BUF_LEN];
        const ok = QueryFullProcessImageNameW(hProcess, 0, nameBuf, sizeOut);
        if (!ok) return null;

        const imagePath = utf16BufToString(nameBuf, sizeOut[0]);
        // path.win32.basename (not the host-platform path.basename): this
        // module can run under unit tests on a non-Windows dev host with a
        // backslash-separated fake path, and posix basename() would not
        // parse backslashes.
        const baseName = path.win32.basename(imagePath).toLowerCase();
        if (!WINDOWS_TERMINAL_PROCESS_NAMES.has(baseName)) return null; // expected miss
      } finally {
        // Must run even if QueryFullProcessImageNameW throws — never leak
        // the process handle.
        if (hProcess) {
          try { CloseHandle(hProcess); } catch { /* best-effort */ }
        }
      }

      // Lock HWND representation to decimal string: koffi.address() gives a
      // BigInt (lossless past Number.MAX_SAFE_INTEGER), .toString(10) gives
      // the base-10 string normalizeHwndString expects. Never round-trips
      // through a JS Number.
      const addr = koffi.address(hwnd);
      return addr.toString(10);
    } catch {
      // Any FFI hiccup at call time (not init) is an expected miss, not an
      // error — onError is init-only (see above).
      return null;
    }
  };
}

module.exports = {
  createForegroundWindowsTerminalProbe,
};
