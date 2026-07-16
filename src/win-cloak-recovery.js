"use strict";

// ── Windows DWM cloak inspection + recovery primitives (#525) ──
//
// DWM can "cloak" a window: it stays logically visible (isVisible()=true,
// WS_VISIBLE set) but the compositor stops drawing it. Sources: app suspension,
// virtual-desktop membership, shell decisions, sleep/wake, RDP reconnects.
// Electron has no API for any of this, so the pet can vanish while every
// JS-visible signal stays green.
//
// This module is the production distillation of the three-round diagnostic
// probe (win-cloak-diagnostic.js, kept in history at d8d308a) whose FFI paths
// were verified on real machines during the #496/#525 investigation:
//   • DwmGetWindowAttribute(DWMWA_CLOAKED=14) reads the cloak flag
//     (0 none / 1 APP / 2 SHELL / 4 INHERITED).
//   • DwmSetWindowAttribute(DWMWA_CLOAK=13, FALSE) un-cloaks a window the
//     process cloaked itself — the direct primitive; hide()/show() cycling is
//     NOT a reliable un-cloak (plan §1.2-B).
//   • IVirtualDesktopManager::IsWindowOnCurrentVirtualDesktop distinguishes
//     "cloaked because the user parked it on another virtual desktop"
//     (legitimate — leave it alone) from "cloaked on the CURRENT desktop"
//     (broken — recover). SHELL=2 alone cannot make that call (plan §1.2-D):
//     the SDK guarantees flag values, not "SHELL ⇔ virtual desktop".
//
// Degradation ladder (every rung fail-open — a probe failure must never make
// the pet WORSE than the pre-#525 no-op behavior):
//   koffi/dwmapi unavailable        → available=false, callers skip entirely
//   COM manager unavailable         → isOnCurrentVirtualDesktop returns null;
//                                     callers must then only treat APP=1 as
//                                     abnormal and leave SHELL/INHERITED alone
//   any per-call throw / bad handle → "not cloaked" / no-op
//
// COM lifetime: CoInitializeEx may report S_OK, S_FALSE, or RPC_E_CHANGED_MODE
// depending on what Chromium already did on this thread — none of those block
// CoCreateInstance, so success is judged solely by CoCreateInstance. dispose()
// Releases the manager and then pays back OUR CoInitializeEx count (S_OK and
// S_FALSE both add one; RPC_E_CHANGED_MODE adds none) — balancing our own
// count is required by the CoInitializeEx contract and never disturbs
// Chromium's own counts on the thread.

const DWMWA_CLOAK = 13;
const DWMWA_CLOAKED = 14;

const CLOAK_NONE = 0;
const CLOAK_APP = 1;
const CLOAK_SHELL = 2;
const CLOAK_INHERITED = 4;

// Pure decision core, exported for tests: given a cloak flag and the
// virtual-desktop answer (true/false/null=unknown), should recovery act?
//   flag 0                → "clean"        (nothing to do)
//   on another desktop    → "other-desktop" (user choice — never touch)
//   on current desktop    → "recover"      (cloaked yet supposedly in view)
//   desktop unknown (COM down): only APP=1 is safely attributable to a broken
//   state; SHELL/INHERITED could be legitimate desktop parking → "skip".
function classifyCloakState(flag, onCurrentDesktop) {
  if (!Number.isInteger(flag) || flag === CLOAK_NONE) return "clean";
  if (onCurrentDesktop === false) return "other-desktop";
  if (onCurrentDesktop === true) return "recover";
  return (flag & CLOAK_APP) ? "recover" : "skip";
}

function createCloakInspector(options = {}) {
  const isWin = options.isWin != null ? !!options.isWin : process.platform === "win32";
  const log = typeof options.log === "function" ? options.log : () => {};

  const unavailable = {
    available: false,
    readCloakState: () => CLOAK_NONE,
    isOnCurrentVirtualDesktop: () => null,
    uncloak: () => false,
    dispose: () => {},
  };
  if (!isWin) return unavailable;

  let koffi;
  let dwmGet;
  let dwmSet;
  let ptrSize;
  try {
    koffi = require("koffi");
    const dwmapi = koffi.load("dwmapi.dll");
    dwmGet = dwmapi.func("int __stdcall DwmGetWindowAttribute(void *hwnd, uint dwAttribute, void *pvAttribute, uint cbAttribute)");
    dwmSet = dwmapi.func("int __stdcall DwmSetWindowAttribute(void *hwnd, uint dwAttribute, void *pvAttribute, uint cbAttribute)");
    ptrSize = koffi.sizeof("void *");
  } catch (err) {
    log(`cloak-recovery init failed (probe disabled): ${err && err.message}`);
    return unavailable;
  }

  // IVirtualDesktopManager via manual vtable dispatch (koffi has no COM layer):
  // *iface is the vtable; slots 0-2 are IUnknown, slot 3 is
  // IsWindowOnCurrentVirtualDesktop. Verified on real machines by the round-3
  // probe (reporter logs show "vdesk probe ready" + per-window vdesk=CURRENT).
  let vdeskQuery = null;
  let vdeskRelease = null;
  let coUninitialize = null;
  // COM init is reference-counted per thread: our CoInitializeEx adds exactly
  // one count that dispose() pays back with one CoUninitialize (same thread —
  // module load and before-quit both run on the main thread). Balancing our
  // own count never disturbs Chromium's. RPC_E_CHANGED_MODE adds no count, so
  // nothing is owed in that case.
  let owesCoUninitialize = false;
  try {
    const ole32 = koffi.load("ole32.dll");
    const CoInitializeEx = ole32.func("int __stdcall CoInitializeEx(void *pvReserved, uint dwCoInit)");
    coUninitialize = ole32.func("void __stdcall CoUninitialize()");
    const CoCreateInstance = ole32.func(
      "int __stdcall CoCreateInstance(void *rclsid, void *pUnkOuter, uint dwClsContext, void *riid, _Out_ void **ppv)"
    );
    // GUID memory layout: Data1(u32 LE) Data2(u16 LE) Data3(u16 LE) Data4(8 bytes)
    const guidBuf = (g) => {
      const [d1, d2, d3, d4, d5] = g.split("-");
      const b = Buffer.alloc(16);
      b.writeUInt32LE(parseInt(d1, 16), 0);
      b.writeUInt16LE(parseInt(d2, 16), 4);
      b.writeUInt16LE(parseInt(d3, 16), 6);
      Buffer.from(d4 + d5, "hex").copy(b, 8);
      return b;
    };
    const coInitHr = CoInitializeEx(null, 0x2 /* COINIT_APARTMENTTHREADED */);
    owesCoUninitialize = coInitHr === 0 || coInitHr === 1; // S_OK / S_FALSE
    const ppv = [null];
    const ccHr = CoCreateInstance(
      guidBuf("AA509086-5CA9-4C25-8F95-589D3C07B48A"), // CLSID_VirtualDesktopManager
      null,
      0x17 /* CLSCTX_ALL */,
      guidBuf("A5CD92FF-29BE-454C-8D04-D82879FB3F1B"), // IID_IVirtualDesktopManager
      ppv
    );
    if (ccHr === 0 && ppv[0]) {
      const mgr = ppv[0];
      const vtbl = koffi.decode(mgr, "void *");
      const fnIsOnCurrent = koffi.decode(vtbl, 3 * ptrSize, "void *");
      const IsOnCurrentProto = koffi.proto(
        "int __stdcall CloakIsWindowOnCurrentVirtualDesktop(void *self, void *hwnd, _Out_ int *onCurrent)"
      );
      vdeskQuery = (hwnd) => {
        const out = [0];
        const hr = koffi.call(fnIsOnCurrent, IsOnCurrentProto, mgr, hwnd, out);
        return hr === 0 ? !!out[0] : null;
      };
      const fnRelease = koffi.decode(vtbl, 2 * ptrSize, "void *");
      const ReleaseProto = koffi.proto("uint __stdcall CloakIUnknownRelease(void *self)");
      vdeskRelease = () => { try { koffi.call(fnRelease, ReleaseProto, mgr); } catch {} };
    } else {
      log(`cloak-recovery vdesk unavailable (CoCreateInstance=0x${(ccHr >>> 0).toString(16)}, CoInitializeEx=0x${(coInitHr >>> 0).toString(16)}) — degrading to APP-only recovery`);
    }
  } catch (err) {
    log(`cloak-recovery vdesk init failed — degrading to APP-only recovery: ${err && err.message}`);
  }

  function hwndOf(win) {
    try {
      if (!win || typeof win.isDestroyed !== "function" || win.isDestroyed()) return null;
      const buf = win.getNativeWindowHandle();
      if (!buf || buf.length < ptrSize) return null;
      return koffi.decode(buf, "void *");
    } catch {
      return null;
    }
  }

  return {
    available: true,

    // 0 when not cloaked OR when anything fails (fail-open).
    readCloakState(win) {
      const hwnd = hwndOf(win);
      if (!hwnd) return CLOAK_NONE;
      try {
        const out = Buffer.alloc(4);
        const hr = dwmGet(hwnd, DWMWA_CLOAKED, out, 4);
        return hr === 0 ? out.readUInt32LE(0) : CLOAK_NONE;
      } catch {
        return CLOAK_NONE;
      }
    },

    // true/false, or null when the COM manager is unavailable or the call fails.
    isOnCurrentVirtualDesktop(win) {
      if (!vdeskQuery) return null;
      const hwnd = hwndOf(win);
      if (!hwnd) return null;
      try {
        return vdeskQuery(hwnd);
      } catch {
        return null;
      }
    },

    // Clear a self-inflicted (APP) cloak. Returns whether the DWM call
    // reported success; the caller re-reads the flag to confirm.
    uncloak(win) {
      const hwnd = hwndOf(win);
      if (!hwnd) return false;
      try {
        const f = Buffer.alloc(4); // BOOL FALSE
        return dwmSet(hwnd, DWMWA_CLOAK, f, 4) === 0;
      } catch {
        return false;
      }
    },

    dispose() {
      // Order matters: release the COM object before paying back the COM
      // init count that keeps its apartment alive.
      if (vdeskRelease) vdeskRelease();
      vdeskQuery = null;
      vdeskRelease = null;
      if (owesCoUninitialize && coUninitialize) {
        try { coUninitialize(); } catch {}
        owesCoUninitialize = false;
      }
    },
  };
}

module.exports = {
  createCloakInspector,
  classifyCloakState,
  CLOAK_NONE,
  CLOAK_APP,
  CLOAK_SHELL,
  CLOAK_INHERITED,
};
