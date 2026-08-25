"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createForegroundFullscreenProbe,
  rectCoversMonitor,
  isDesktopShellWindowClass,
  isMaximizedNormalWindow,
  FULLSCREEN_TOLERANCE_PX,
} = require("../src/win-fullscreen-detect");

// A koffi stand-in: load().func(signature) returns a stub keyed off the API
// name, mimicking koffi's _Out_/_Inout_ marshalling by writing into the passed
// struct objects. Lets us drive the probe's decision chain without real FFI.
function fakeKoffi(behavior) {
  return {
    // #935: per-window identity. Defaults to a fixed address so positive
    // verdicts read as the id string "4242"; addressOf overrides for tests
    // that need per-window values.
    address(ptr) {
      return behavior.addressOf ? behavior.addressOf(ptr) : 4242n;
    },
    load() {
      return {
        func(signature) {
          if (signature.includes("GetForegroundWindow")) {
            return () => behavior.hwnd;
          }
          if (signature.includes("GetWindowRect")) {
            return (_hwnd, rectOut) => {
              if (behavior.getWindowRectThrows) throw new Error("GetWindowRect exploded");
              if (behavior.winRect) Object.assign(rectOut, behavior.winRect);
              return behavior.getWindowRect !== false;
            };
          }
          if (signature.includes("MonitorFromWindow")) {
            return () => behavior.hMonitor;
          }
          if (signature.includes("GetMonitorInfoW")) {
            return (_h, infoOut) => {
              if (behavior.monitorRect) infoOut.rcMonitor = behavior.monitorRect;
              return behavior.getMonitorInfo !== false;
            };
          }
          if (signature.includes("GetClassNameW")) {
            return (_hwnd, bufOut, _maxLen) => {
              const name = behavior.className === undefined ? "FakeApp" : behavior.className;
              if (name === null) return 0;
              for (let i = 0; i < name.length; i++) bufOut[i] = name.charCodeAt(i);
              return name.length;
            };
          }
          if (signature.includes("GetWindowLongPtrW")) {
            // The style binding is resolved in its own try/catch so a missing
            // export degrades to the geometric answer; this simulates that.
            if (behavior.styleFuncUnavailable) throw new Error("GetWindowLongPtrW unavailable");
            return () => {
              if (behavior.styleThrows) throw new Error("GetWindowLongPtrW exploded");
              return behavior.style === undefined ? 0 : behavior.style;
            };
          }
          throw new Error(`unexpected func: ${signature}`);
        },
      };
    },
    struct() {},
    sizeof() {
      return 40;
    },
  };
}

const MONITOR = { left: 0, top: 0, right: 1920, bottom: 1080 };
const FULLSCREEN_RECT = { left: 0, top: 0, right: 1920, bottom: 1080 };
// Maximized normal window: covers work area but leaves the 40px taskbar strip.
const MAXIMIZED_RECT = { left: 0, top: 0, right: 1920, bottom: 1040 };

const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;
const WS_MAXIMIZE = 0x01000000;
// A maximized ordinary window (title bar + sizing border), e.g. a maximized browser.
const MAXIMIZED_NORMAL_STYLE = WS_MAXIMIZE | WS_CAPTION | WS_THICKFRAME;
// Borderless fullscreen: the caption is dropped, which is what distinguishes it.
const BORDERLESS_STYLE = 0;

describe("rectCoversMonitor", () => {
  it("treats an exact monitor-covering window as fullscreen", () => {
    assert.strictEqual(rectCoversMonitor(FULLSCREEN_RECT, MONITOR), true);
  });

  it("does not treat a maximized (work-area) window as fullscreen", () => {
    assert.strictEqual(rectCoversMonitor(MAXIMIZED_RECT, MONITOR), false);
  });

  it("absorbs sub-tolerance DPI rounding", () => {
    const rect = {
      left: FULLSCREEN_TOLERANCE_PX,
      top: FULLSCREEN_TOLERANCE_PX,
      right: 1920 - FULLSCREEN_TOLERANCE_PX,
      bottom: 1080 - FULLSCREEN_TOLERANCE_PX,
    };
    assert.strictEqual(rectCoversMonitor(rect, MONITOR), true);
  });

  it("returns false for missing rects", () => {
    assert.strictEqual(rectCoversMonitor(null, MONITOR), false);
    assert.strictEqual(rectCoversMonitor(FULLSCREEN_RECT, null), false);
  });
});

describe("isDesktopShellWindowClass", () => {
  it("matches the desktop shell window classes", () => {
    assert.strictEqual(isDesktopShellWindowClass("Progman"), true);
    assert.strictEqual(isDesktopShellWindowClass("WorkerW"), true);
  });

  it("compares case-insensitively (Win32 class names are case-insensitive)", () => {
    assert.strictEqual(isDesktopShellWindowClass("progman"), true);
    assert.strictEqual(isDesktopShellWindowClass("WORKERW"), true);
  });

  it("rejects normal app classes and empty input", () => {
    assert.strictEqual(isDesktopShellWindowClass("Chrome_WidgetWin_1"), false);
    assert.strictEqual(isDesktopShellWindowClass(""), false);
    assert.strictEqual(isDesktopShellWindowClass(null), false);
  });
});

describe("isMaximizedNormalWindow", () => {
  it("matches a maximized window that still has its caption", () => {
    assert.strictEqual(isMaximizedNormalWindow(MAXIMIZED_NORMAL_STYLE), true);
  });

  it("rejects a maximized window with no caption (borderless fullscreen)", () => {
    assert.strictEqual(isMaximizedNormalWindow(WS_MAXIMIZE), false);
  });

  it("rejects a captioned window that is not maximized", () => {
    assert.strictEqual(isMaximizedNormalWindow(WS_CAPTION | WS_THICKFRAME), false);
  });

  it("requires the full WS_CAPTION mask, not either half", () => {
    assert.strictEqual(isMaximizedNormalWindow(WS_MAXIMIZE | 0x00800000), false);
    assert.strictEqual(isMaximizedNormalWindow(WS_MAXIMIZE | 0x00400000), false);
  });

  it("rejects unusable style values", () => {
    assert.strictEqual(isMaximizedNormalWindow(0), false);
    assert.strictEqual(isMaximizedNormalWindow(NaN), false);
    assert.strictEqual(isMaximizedNormalWindow(null), false);
  });
});

describe("createForegroundFullscreenProbe", () => {
  it("returns a constant-false probe off Windows", () => {
    const probe = createForegroundFullscreenProbe({ isWin: false });
    assert.strictEqual(typeof probe, "function");
    assert.strictEqual(probe(), false);
  });

  it("degrades to constant-false (and reports) when the FFI fails to load", () => {
    let reported = null;
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: { load() { throw new Error("user32 unavailable"); } },
      onError: (err) => { reported = err; },
    });
    assert.strictEqual(probe(), false);
    assert.ok(reported instanceof Error);
  });

  it("reports fullscreen when the foreground window covers the monitor", () => {
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({ hwnd: {}, hMonitor: {}, winRect: FULLSCREEN_RECT, monitorRect: MONITOR }),
    });
    assert.strictEqual(probe(), "4242");
  });

  it("reports not-fullscreen for a merely maximized foreground window", () => {
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({ hwnd: {}, hMonitor: {}, winRect: MAXIMIZED_RECT, monitorRect: MONITOR }),
    });
    assert.strictEqual(probe(), false);
  });

  it("reports not-fullscreen when there is no foreground window", () => {
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({ hwnd: null }),
    });
    assert.strictEqual(probe(), false);
  });

  it("reports not-fullscreen when a native call fails", () => {
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({ hwnd: {}, getWindowRect: false }),
    });
    assert.strictEqual(probe(), false);
  });

  it("reports thrown call-time failures through the opt-in diagnostic callback", () => {
    let initErrors = 0;
    let callErrors = 0;
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({ hwnd: {}, getWindowRectThrows: true }),
      onError: () => { initErrors++; },
      onCallError: () => { callErrors++; },
    });
    assert.strictEqual(probe(), false);
    assert.strictEqual(initErrors, 0);
    assert.strictEqual(callErrors, 1);
  });

  // #719: clicking the desktop makes the shell window (Progman, or a WorkerW
  // when a wallpaper host re-parents the icon view) the foreground window, and
  // its rect covers the whole monitor — geometry alone says "fullscreen app".
  it("does not treat the desktop shell (Progman) as a fullscreen app", () => {
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({
        hwnd: {}, hMonitor: {}, winRect: FULLSCREEN_RECT, monitorRect: MONITOR,
        className: "Progman",
      }),
    });
    assert.strictEqual(probe(), false);
  });

  it("does not treat a monitor-covering WorkerW as a fullscreen app", () => {
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({
        hwnd: {}, hMonitor: {}, winRect: FULLSCREEN_RECT, monitorRect: MONITOR,
        className: "WorkerW",
      }),
    });
    assert.strictEqual(probe(), false);
  });

  it("still reports fullscreen for a normal app class covering the monitor", () => {
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({
        hwnd: {}, hMonitor: {}, winRect: FULLSCREEN_RECT, monitorRect: MONITOR,
        className: "Chrome_WidgetWin_1",
      }),
    });
    assert.strictEqual(probe(), "4242");
  });

  it("falls back to geometry when GetClassNameW fails", () => {
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({
        hwnd: {}, hMonitor: {}, winRect: FULLSCREEN_RECT, monitorRect: MONITOR,
        className: null,
      }),
    });
    assert.strictEqual(probe(), "4242");
  });

  // #871: a monitor with no reserved taskbar strip (a secondary display, or an
  // auto-hidden taskbar whose 1px sliver fits inside FULLSCREEN_TOLERANCE_PX)
  // has rcWork == rcMonitor, so an ordinary MAXIMIZED window covers the monitor
  // and geometry alone calls it fullscreen. That flipped the hit window
  // non-activating, and setFocusable(false) deactivates whatever had focus.
  it("does not treat a maximized window on a taskbar-less monitor as fullscreen", () => {
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({
        hwnd: {}, hMonitor: {}, winRect: FULLSCREEN_RECT, monitorRect: MONITOR,
        className: "Chrome_WidgetWin_1", style: MAXIMIZED_NORMAL_STYLE,
      }),
    });
    assert.strictEqual(probe(), false);
  });

  it("still reports fullscreen for a monitor-covering window with no caption", () => {
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({
        hwnd: {}, hMonitor: {}, winRect: FULLSCREEN_RECT, monitorRect: MONITOR,
        className: "UnrealWindow", style: BORDERLESS_STYLE,
      }),
    });
    assert.strictEqual(probe(), "4242");
  });

  // Borderless-fullscreen games often maximize a caption-less window; only the
  // caption separates them from a maximized browser (#538 must not regress).
  it("still reports fullscreen for a maximized borderless window", () => {
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({
        hwnd: {}, hMonitor: {}, winRect: FULLSCREEN_RECT, monitorRect: MONITOR,
        className: "UnrealWindow", style: WS_MAXIMIZE,
      }),
    });
    assert.strictEqual(probe(), "4242");
  });

  it("keeps the geometric answer when the style binding is unavailable", () => {
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({
        hwnd: {}, hMonitor: {}, winRect: FULLSCREEN_RECT, monitorRect: MONITOR,
        className: "Chrome_WidgetWin_1", styleFuncUnavailable: true,
      }),
    });
    assert.strictEqual(probe(), "4242");
  });

  // 0 is GetWindowLongPtrW's documented failure return, not an exception, so it
  // degrades like a 0-length class read: keep the geometric answer.
  it("keeps the geometric answer when the style read returns its failure value", () => {
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({
        hwnd: {}, hMonitor: {}, winRect: FULLSCREEN_RECT, monitorRect: MONITOR,
        className: "Chrome_WidgetWin_1", style: 0,
      }),
    });
    assert.strictEqual(probe(), "4242");
  });

  // A THROWN style read is different: it takes the probe's existing call-time
  // catch, which answers "not fullscreen" for every FFI call in this function.
  it("reports a thrown style read through the call-time diagnostic", () => {
    let callErrors = 0;
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({
        hwnd: {}, hMonitor: {}, winRect: FULLSCREEN_RECT, monitorRect: MONITOR,
        className: "Chrome_WidgetWin_1", styleThrows: true,
      }),
      onCallError: () => { callErrors++; },
    });
    assert.strictEqual(probe(), false);
    assert.strictEqual(callErrors, 1);
  });
});

// #935: positive verdicts carry an opaque per-window id (still truthy for
// every boolean consumer) so the auto-hide override can bind to the app.
describe("fullscreen probe identity (#935)", () => {
  const base = { hMonitor: {}, winRect: { left: 0, top: 0, right: 1920, bottom: 1080 }, monitorRect: { left: 0, top: 0, right: 1920, bottom: 1080 } };

  it("keeps the id stable per window and distinct across windows", () => {
    const behavior = { ...base, hwnd: { addr: 7 }, addressOf: (ptr) => BigInt(ptr.addr) };
    const probe = createForegroundFullscreenProbe({ isWin: true, koffi: fakeKoffi(behavior) });
    assert.strictEqual(probe(), "7");
    assert.strictEqual(probe(), "7");
    behavior.hwnd = { addr: 9 };
    assert.strictEqual(probe(), "9");
  });

  it("degrades to plain true when koffi.address is unavailable", () => {
    const koffi = fakeKoffi({ ...base, hwnd: {} });
    delete koffi.address;
    const probe = createForegroundFullscreenProbe({ isWin: true, koffi });
    assert.strictEqual(probe(), true);
  });

  it("degrades to plain true when koffi.address throws", () => {
    const koffi = fakeKoffi({ ...base, hwnd: {} });
    koffi.address = () => { throw new Error("address exploded"); };
    const probe = createForegroundFullscreenProbe({ isWin: true, koffi });
    assert.strictEqual(probe(), true);
  });
});
