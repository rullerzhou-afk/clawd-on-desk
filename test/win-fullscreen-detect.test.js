"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createForegroundFullscreenProbe,
  rectCoversMonitor,
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
});
