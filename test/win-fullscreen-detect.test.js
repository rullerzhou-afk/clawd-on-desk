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
    load(dll) {
      if (behavior.loadedDlls) behavior.loadedDlls.push(dll);
      return {
        func(signature) {
          if (behavior.processFuncUnavailable && signature.includes(behavior.processFuncUnavailable)) {
            throw new Error("process binding unavailable");
          }
          if (signature.includes("GetForegroundWindow")) {
            return () => {
              if (behavior.foregroundThrows) throw new Error("GetForegroundWindow exploded");
              return behavior.hwnd;
            };
          }
          if (signature.includes("GetWindowThreadProcessId")) {
            return (_hwnd, pidOut) => {
              pidOut[0] = behavior.pid === undefined ? 42 : behavior.pid;
              return 1;
            };
          }
          if (signature.includes("OpenProcess")) {
            return (...args) => {
              if (behavior.processCalls) behavior.processCalls.push(["OpenProcess", ...args]);
              if (behavior.openProcessThrows) throw new Error("OpenProcess exploded");
              return behavior.openProcess === false ? null : "process-handle";
            };
          }
          if (signature.includes("QueryFullProcessImageNameW")) {
            return (handle, flags, nameOut, sizeOut) => {
              if (behavior.processCalls) behavior.processCalls.push(["QueryFullProcessImageNameW", handle, flags]);
              if (behavior.queryImageThrows) throw new Error("QueryFullProcessImageNameW exploded");
              if (behavior.queryImage === false) return false;
              const name = behavior.imagePath || "C:\\Apps\\Other.exe";
              for (let i = 0; i < name.length; i++) nameOut[i] = name.charCodeAt(i);
              sizeOut[0] = name.length;
              return true;
            };
          }
          if (signature.includes("CloseHandle")) {
            return (handle) => {
              if (behavior.processCalls) behavior.processCalls.push(["CloseHandle", handle]);
              if (behavior.closeHandleThrows) throw new Error("CloseHandle exploded");
              return behavior.closeHandle !== false;
            };
          }
          if (signature.includes("IsWindow(")) {
            return (hwnd) => {
              if (behavior.isWindowThrows) throw new Error("IsWindow exploded");
              if (behavior.isWindowArgs) behavior.isWindowArgs.push(hwnd);
              return behavior.isWindowAlive !== false;
            };
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

describe("issue #1282: screen capture overlay observation", () => {
  function captureBehavior(overrides = {}) {
    return {
      hwnd: {}, hMonitor: {}, winRect: FULLSCREEN_RECT, monitorRect: MONITOR,
      className: "XamlWindow", imagePath: "C:\\WindowsApps\\SnippingTool.exe",
      processCalls: [],
      ...overrides,
    };
  }

  for (const className of ["XamlWindow", "xAMLwINDOW"]) {
    it(`issue #1282: marks fullscreen ${className} owned by Snipping Tool case-insensitively`, () => {
      const behavior = captureBehavior({ className, imagePath: "C:\\WindowsApps\\sNIPPINGtOOL.EXE" });
      const probe = createForegroundFullscreenProbe({ isWin: true, koffi: fakeKoffi(behavior) });

      assert.strictEqual(probe(), "4242");
      assert.deepStrictEqual(probe.getLastObservation(), {
        reliable: true, foregroundId: "4242", fullscreenId: "4242", captureOverlay: true,
      });
      assert.deepStrictEqual(behavior.processCalls, [
        ["OpenProcess", 0x1000, false, 42],
        ["QueryFullProcessImageNameW", "process-handle", 0],
        ["CloseHandle", "process-handle"],
      ]);
      behavior.imagePath = "C:\\WindowsApps\\Other.exe";
      assert.strictEqual(probe(), "4242");
      assert.deepStrictEqual(probe.getLastObservation(), {
        reliable: true, foregroundId: "4242", fullscreenId: "4242",
      }, "process identity must be queried again rather than cached");
    });
  }

  it("issue #1282: marks the fullscreen observation without a window address", () => {
    const koffi = fakeKoffi(captureBehavior());
    delete koffi.address;
    const probe = createForegroundFullscreenProbe({ isWin: true, koffi });
    assert.strictEqual(probe(), true);
    assert.deepStrictEqual(probe.getLastObservation(), {
      reliable: true, foregroundId: null, fullscreenId: true, captureOverlay: true,
    });
  });

  it("issue #1282: keeps other XamlWindow processes fullscreen without the marker", () => {
    const behavior = captureBehavior({ imagePath: "C:\\Apps\\Other.exe" });
    const probe = createForegroundFullscreenProbe({ isWin: true, koffi: fakeKoffi(behavior) });
    assert.strictEqual(probe(), "4242");
    assert.deepStrictEqual(probe.getLastObservation(), {
      reliable: true, foregroundId: "4242", fullscreenId: "4242",
    });
    assert.deepStrictEqual(behavior.processCalls.at(-1), ["CloseHandle", "process-handle"]);
  });

  for (const className of ["OtherWindow", null]) {
    it(`issue #1282: does not open a process for window class ${className}`, () => {
      const behavior = captureBehavior({ className });
      const probe = createForegroundFullscreenProbe({ isWin: true, koffi: fakeKoffi(behavior) });
      assert.strictEqual(probe(), "4242");
      assert.deepStrictEqual(probe.getLastObservation(), {
        reliable: true, foregroundId: "4242", fullscreenId: "4242",
      });
      assert.deepStrictEqual(behavior.processCalls, []);
    });
  }

  for (const [miss, value, closesHandle] of [
    ["pid", 0, false], ["openProcess", false, false], ["queryImage", false, true],
  ]) {
    it(`issue #1282: ${miss} miss preserves fullscreen without reporting a call error`, () => {
      const behavior = captureBehavior({ [miss]: value });
      const errors = [];
      const probe = createForegroundFullscreenProbe({
        isWin: true, koffi: fakeKoffi(behavior), onCallError: (err) => errors.push(err),
      });
      assert.strictEqual(probe(), "4242");
      assert.deepStrictEqual(probe.getLastObservation(), {
        reliable: true, foregroundId: "4242", fullscreenId: "4242",
      });
      assert.deepStrictEqual(errors, []);
      assert.deepStrictEqual(behavior.processCalls.filter(([name]) => name === "CloseHandle"),
        closesHandle ? [["CloseHandle", "process-handle"]] : []);
      if (miss === "pid") assert.deepStrictEqual(behavior.processCalls, []);
    });
  }

  for (const [failure, closesHandle] of [
    ["openProcessThrows", false], ["queryImageThrows", true],
  ]) {
    it(`issue #1282: ${failure} preserves fullscreen and reports a call error`, () => {
      const behavior = captureBehavior({ [failure]: true });
      const errors = [];
      const probe = createForegroundFullscreenProbe({
        isWin: true, koffi: fakeKoffi(behavior), onCallError: (err) => errors.push(err),
      });
      assert.strictEqual(probe(), "4242");
      assert.deepStrictEqual(probe.getLastObservation(), {
        reliable: true, foregroundId: "4242", fullscreenId: "4242",
      });
      assert.strictEqual(errors.length, 1);
      assert.ok(errors[0] instanceof Error);
      assert.deepStrictEqual(behavior.processCalls.filter(([name]) => name === "CloseHandle"),
        closesHandle ? [["CloseHandle", "process-handle"]] : []);
    });
  }

  for (const closeBehavior of [{ closeHandle: false }, { closeHandleThrows: true }]) {
    it(`issue #1282: ${Object.keys(closeBehavior)[0]} is best-effort and preserves capture detection`, () => {
      const behavior = captureBehavior(closeBehavior);
      const errors = [];
      const probe = createForegroundFullscreenProbe({
        isWin: true, koffi: fakeKoffi(behavior), onCallError: (err) => errors.push(err),
      });
      assert.strictEqual(probe(), "4242");
      assert.deepStrictEqual(probe.getLastObservation(), {
        reliable: true, foregroundId: "4242", fullscreenId: "4242", captureOverlay: true,
      });
      assert.deepStrictEqual(errors, []);
      assert.deepStrictEqual(behavior.processCalls.at(-1), ["CloseHandle", "process-handle"]);
    });
  }

  for (const binding of ["GetWindowThreadProcessId", "OpenProcess", "QueryFullProcessImageNameW", "CloseHandle"]) {
    it(`issue #1282: an unavailable ${binding} binding only disables the capture marker`, () => {
      const errors = [];
      const behavior = captureBehavior({ processFuncUnavailable: binding });
      const probe = createForegroundFullscreenProbe({
        isWin: true, koffi: fakeKoffi(behavior), onError: (err) => errors.push(err),
      });
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(probe(), "4242");
      assert.deepStrictEqual(probe.getLastObservation(), {
        reliable: true, foregroundId: "4242", fullscreenId: "4242",
      });
      assert.deepStrictEqual(behavior.processCalls, []);
    });
  }

  it("issue #1282: a captioned maximized Snipping Tool window is not fullscreen", () => {
    const behavior = captureBehavior({ style: MAXIMIZED_NORMAL_STYLE });
    const probe = createForegroundFullscreenProbe({ isWin: true, koffi: fakeKoffi(behavior) });
    assert.strictEqual(probe(), false);
    assert.deepStrictEqual(probe.getLastObservation(), {
      reliable: true, foregroundId: "4242", fullscreenId: null,
    });
    assert.deepStrictEqual(behavior.processCalls, []);
  });

  for (const [next, reliable, foregroundId] of [
    [{ winRect: MAXIMIZED_RECT }, true, "4242"],
    [{ hwnd: null }, false, null],
    [{ foregroundThrows: true }, false, null],
  ]) {
    it(`issue #1282: clears a previous capture marker after ${Object.keys(next)[0]}`, () => {
      const behavior = captureBehavior();
      const probe = createForegroundFullscreenProbe({ isWin: true, koffi: fakeKoffi(behavior) });
      assert.strictEqual(probe(), "4242");
      assert.strictEqual(probe.getLastObservation().captureOverlay, true);
      Object.assign(behavior, next);
      assert.strictEqual(probe(), false);
      assert.deepStrictEqual(probe.getLastObservation(), { reliable, foregroundId, fullscreenId: null });
    });
  }

  it("issue #1282: does not load kernel32 off Windows", () => {
    const behavior = captureBehavior({ loadedDlls: [] });
    const probe = createForegroundFullscreenProbe({ isWin: false, koffi: fakeKoffi(behavior) });
    assert.strictEqual(probe(), false);
    assert.deepStrictEqual(behavior.loadedDlls, []);
  });
});

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

  it("matches the Windows 11 shell hosts that flash foreground (#1017)", () => {
    assert.strictEqual(isDesktopShellWindowClass("XamlExplorerHostIslandWindow"), true);
    assert.strictEqual(isDesktopShellWindowClass("Windows.UI.Core.CoreWindow"), true);
  });

  it("keeps the UWP app frame host as an app class", () => {
    assert.strictEqual(isDesktopShellWindowClass("ApplicationFrameWindow"), false);
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

  // #1017: the Win11 shell hosts are borderless WS_POPUP windows with no
  // caption and no WS_MAXIMIZE, so the #871 style refinement cannot rescue
  // them — only the class exclusion can.
  const WIN11_SHELL_HOST_STYLE = 0x94000000; // WS_POPUP | WS_VISIBLE | WS_CLIPSIBLINGS

  it("does not treat the Win11 Alt-Tab / Task View host as a fullscreen app", () => {
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({
        hwnd: {}, hMonitor: {}, winRect: FULLSCREEN_RECT, monitorRect: MONITOR,
        className: "XamlExplorerHostIslandWindow", style: WIN11_SHELL_HOST_STYLE,
      }),
    });
    assert.strictEqual(probe(), false);
  });

  it("does not treat the text input host (IME CoreWindow) as a fullscreen app", () => {
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({
        hwnd: {}, hMonitor: {}, winRect: FULLSCREEN_RECT, monitorRect: MONITOR,
        className: "Windows.UI.Core.CoreWindow", style: WIN11_SHELL_HOST_STYLE,
      }),
    });
    assert.strictEqual(probe(), false);
  });

  it("keeps a reliable foreground id for an excluded shell host", () => {
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({
        hwnd: {}, hMonitor: {}, winRect: FULLSCREEN_RECT, monitorRect: MONITOR,
        className: "XamlExplorerHostIslandWindow", style: WIN11_SHELL_HOST_STYLE,
      }),
    });
    probe();
    assert.deepStrictEqual(probe.getLastObservation(), {
      reliable: true, foregroundId: "4242", fullscreenId: null,
    });
  });

  it("still reports fullscreen for a UWP app frame covering the monitor", () => {
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({
        hwnd: {}, hMonitor: {}, winRect: FULLSCREEN_RECT, monitorRect: MONITOR,
        className: "ApplicationFrameWindow", style: WIN11_SHELL_HOST_STYLE,
      }),
    });
    assert.strictEqual(probe(), "4242");
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

  it("retains a reliable foreground id when that HWND is not fullscreen", () => {
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({ hwnd: {}, hMonitor: {}, winRect: MAXIMIZED_RECT, monitorRect: MONITOR }),
    });
    assert.strictEqual(probe(), false);
    assert.deepStrictEqual(probe.getLastObservation(), {
      reliable: true,
      foregroundId: "4242",
      fullscreenId: null,
    });
  });

  it("marks native-call failures unreliable so they cannot end an override episode", () => {
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi({ hwnd: {}, getWindowRect: false }),
    });
    assert.strictEqual(probe(), false);
    assert.deepStrictEqual(probe.getLastObservation(), {
      reliable: false,
      foregroundId: "4242",
      fullscreenId: null,
    });
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

  it("checks a decimal window identity through IsWindow without losing pointer precision", () => {
    const behavior = { ...base, hwnd: {}, isWindowArgs: [] };
    const probe = createForegroundFullscreenProbe({ isWin: true, koffi: fakeKoffi(behavior) });

    assert.strictEqual(probe.isWindowIdAlive("184467"), true);
    assert.deepStrictEqual(behavior.isWindowArgs, [184467n]);
    behavior.isWindowAlive = false;
    assert.strictEqual(probe.isWindowIdAlive("184467"), false);
  });

  it("fails open when a window identity cannot be checked", () => {
    let callErrors = 0;
    const behavior = { ...base, hwnd: {}, isWindowThrows: true };
    const probe = createForegroundFullscreenProbe({
      isWin: true,
      koffi: fakeKoffi(behavior),
      onCallError: () => { callErrors += 1; },
    });

    assert.strictEqual(probe.isWindowIdAlive("not-an-address"), null);
    assert.strictEqual(probe.isWindowIdAlive("4242"), null);
    assert.strictEqual(callErrors, 1);
  });
});
