"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createForegroundFullscreenProbe,
  rectCoversMonitor,
  isDesktopShellWindowClass,
  FULLSCREEN_TOLERANCE_PX,
} = require("../src/win-fullscreen-detect");

// A koffi stand-in: load().func(signature) returns a stub keyed off the API
// name, mimicking koffi's _Out_/_Inout_ marshalling by writing into the passed
// struct objects. Lets us drive the probe's decision chain without real FFI.
function fakeKoffi(behavior) {
  return {
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
    assert.strictEqual(probe(), true);
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
    assert.strictEqual(probe(), true);
  });

  it("falls back to geometry when GetClassNameW fails", () => {
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({
        hwnd: {}, hMonitor: {}, winRect: FULLSCREEN_RECT, monitorRect: MONITOR,
        className: null,
      }),
    });
    assert.strictEqual(probe(), true);
  });
});
