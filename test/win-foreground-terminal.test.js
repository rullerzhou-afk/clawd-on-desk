// test/win-foreground-terminal.test.js — Unit tests for
// src/win-foreground-terminal.js (#627 residual §4.1/§7.1).
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createForegroundWindowsTerminalProbe } = require("../src/win-foreground-terminal");
const {
  WINDOWS_TERMINAL_WINDOW_CLASS,
  WINDOWS_TERMINAL_PROCESS_NAMES,
} = require("../hooks/shared-process");

// A koffi stand-in mirroring the real ABI shape this module declares:
// user32!GetForegroundWindow/GetAncestor/GetClassNameW/GetWindowThreadProcessId,
// kernel32!OpenProcess/QueryFullProcessImageNameW/CloseHandle, plus the
// top-level koffi.address(ptr) => BigInt used to render the HWND. `behavior`
// fields default to a "happy path, real Windows Terminal foreground" shape;
// override individual fields per test.
function fakeKoffi(behavior) {
  const b = {
    fgHwnd: {},
    ancestorHwnd: {},
    className: WINDOWS_TERMINAL_WINDOW_CLASS,
    pid: 4242,
    hProcess: {},
    imagePath: "C:\\Program Files\\WindowsTerminal\\WindowsTerminal.exe",
    address: 12345n,
    closeHandleCalls: 0,
    ...behavior,
  };
  return {
    __behavior: b,
    load(name) {
      const key = String(name).toLowerCase();
      if (key === "user32.dll") {
        return {
          func(signature) {
            if (signature.includes("GetForegroundWindow")) return () => b.fgHwnd;
            if (signature.includes("GetAncestor")) return (_hwnd, _flags) => b.ancestorHwnd;
            if (signature.includes("GetClassNameW")) {
              return (_hwnd, buf, maxCount) => {
                if (b.classNameThrows) throw new Error("GetClassNameW boom");
                const cls = b.className || "";
                for (let i = 0; i < cls.length && i < maxCount; i++) buf[i] = cls.charCodeAt(i);
                return b.classLenOverride !== undefined ? b.classLenOverride : Math.min(cls.length, maxCount);
              };
            }
            if (signature.includes("GetWindowThreadProcessId")) {
              return (_hwnd, pidOut) => {
                pidOut[0] = b.pid || 0;
                return b.pid || 0;
              };
            }
            throw new Error(`unexpected user32 func: ${signature}`);
          },
        };
      }
      if (key === "kernel32.dll") {
        return {
          func(signature) {
            if (signature.includes("OpenProcess")) {
              return (_access, _inherit, _pid) => (b.hProcess === undefined ? {} : b.hProcess);
            }
            if (signature.includes("QueryFullProcessImageNameW")) {
              return (_hProcess, _flags, buf, sizeOut) => {
                if (b.queryImageThrows) throw new Error("QueryFullProcessImageNameW boom");
                if (b.queryImageFails) return false;
                const img = b.imagePath || "";
                for (let i = 0; i < img.length; i++) buf[i] = img.charCodeAt(i);
                sizeOut[0] = img.length;
                return true;
              };
            }
            if (signature.includes("CloseHandle")) {
              return (_h) => {
                b.closeHandleCalls++;
                return true;
              };
            }
            throw new Error(`unexpected kernel32 func: ${signature}`);
          },
        };
      }
      throw new Error(`unexpected dll: ${name}`);
    },
    address(_ptr) {
      if (b.addressThrows) throw new Error("address failed");
      return b.address;
    },
  };
}

describe("createForegroundWindowsTerminalProbe — platform / init gating", () => {
  it("returns a constant-null probe off Windows and never touches koffi", () => {
    const koffi = { load() { throw new Error("must not be called off Windows"); } };
    const probe = createForegroundWindowsTerminalProbe({ isWin: false, koffi });
    assert.strictEqual(typeof probe, "function");
    assert.strictEqual(probe(), null);
  });

  it("degrades to null (and reports onError once) when koffi.load throws", () => {
    let calls = 0;
    let reported = null;
    const probe = createForegroundWindowsTerminalProbe({
      isWin: true,
      koffi: { load() { throw new Error("user32 unavailable"); } },
      onError: (err) => { calls++; reported = err; },
    });
    assert.strictEqual(probe(), null);
    assert.strictEqual(calls, 1, "onError must fire exactly once for an init failure");
    assert.ok(reported instanceof Error);
  });

  it("degrades to null when a func() declaration throws", () => {
    let calls = 0;
    const badKoffi = {
      load() {
        return {
          func(signature) {
            if (signature.includes("GetForegroundWindow")) throw new Error("bad signature");
            return () => null;
          },
        };
      },
    };
    const probe = createForegroundWindowsTerminalProbe({
      isWin: true,
      koffi: badKoffi,
      onError: () => { calls++; },
    });
    assert.strictEqual(probe(), null);
    assert.strictEqual(calls, 1);
  });

  it("calling the degraded probe repeatedly never calls onError again", () => {
    let calls = 0;
    const probe = createForegroundWindowsTerminalProbe({
      isWin: true,
      koffi: { load() { throw new Error("nope"); } },
      onError: () => { calls++; },
    });
    probe(); probe(); probe();
    assert.strictEqual(calls, 1);
  });
});

describe("createForegroundWindowsTerminalProbe — happy path", () => {
  it("returns the decimal HWND string when the foreground is a real Windows Terminal window", () => {
    let onErrorCalls = 0;
    const probe = createForegroundWindowsTerminalProbe({
      isWin: true,
      koffi: fakeKoffi({}),
      onError: () => { onErrorCalls++; },
    });
    const result = probe();
    assert.strictEqual(result, "12345");
    assert.strictEqual(typeof result, "string");
    assert.strictEqual(onErrorCalls, 0, "a successful call must never invoke onError");
  });

  it("accepts the WindowsTerminalPreview.exe process name case-insensitively", () => {
    const probe = createForegroundWindowsTerminalProbe({
      isWin: true,
      koffi: fakeKoffi({ imagePath: "C:\\Program Files\\WindowsTerminal\\WindowsTerminalPreview.EXE" }),
    });
    assert.strictEqual(probe(), "12345");
  });

  it("matches the WT window class case-insensitively", () => {
    const probe = createForegroundWindowsTerminalProbe({
      isWin: true,
      koffi: fakeKoffi({ className: WINDOWS_TERMINAL_WINDOW_CLASS.toLowerCase() }),
    });
    assert.strictEqual(probe(), "12345");
  });

  it("GetAncestor(GA_ROOT)=0 is not a failure — keeps using the original foreground hwnd", () => {
    const probe = createForegroundWindowsTerminalProbe({
      isWin: true,
      koffi: fakeKoffi({ ancestorHwnd: null, address: 777n }),
    });
    assert.strictEqual(probe(), "777");
  });

  it("closes the process handle exactly once on a successful read", () => {
    const koffi = fakeKoffi({});
    const probe = createForegroundWindowsTerminalProbe({ isWin: true, koffi });
    probe();
    assert.strictEqual(koffi.__behavior.closeHandleCalls, 1);
  });
});

describe("createForegroundWindowsTerminalProbe — expected misses (no onError)", () => {
  function assertExpectedMiss(behaviorOverrides) {
    let onErrorCalls = 0;
    const probe = createForegroundWindowsTerminalProbe({
      isWin: true,
      koffi: fakeKoffi(behaviorOverrides),
      onError: () => { onErrorCalls++; },
    });
    assert.strictEqual(probe(), null);
    assert.strictEqual(onErrorCalls, 0, "an expected miss must never call onError");
  }

  it("GetForegroundWindow() returning 0/null", () => {
    assertExpectedMiss({ fgHwnd: null });
  });

  it("foreground window class is not Windows Terminal's", () => {
    assertExpectedMiss({ className: "Chrome_WidgetWin_1" });
  });

  it("GetClassNameW returns 0 (invalid/gone window)", () => {
    assertExpectedMiss({ classLenOverride: 0 });
  });

  it("GetWindowThreadProcessId yields pid 0", () => {
    assertExpectedMiss({ pid: 0 });
  });

  it("OpenProcess fails (e.g. elevated WT vs non-elevated Clawd)", () => {
    assertExpectedMiss({ hProcess: null });
  });

  it("QueryFullProcessImageNameW fails", () => {
    assertExpectedMiss({ queryImageFails: true });
  });

  it("the resolved process image is not a Windows Terminal executable", () => {
    assertExpectedMiss({ imagePath: "C:\\Windows\\System32\\notepad.exe" });
  });

  it("a call-time throw anywhere in the chain degrades to null, not onError", () => {
    assertExpectedMiss({ classNameThrows: true });
  });

  it("still closes the handle when QueryFullProcessImageNameW throws (finally)", () => {
    const koffi = fakeKoffi({ queryImageThrows: true });
    const probe = createForegroundWindowsTerminalProbe({ isWin: true, koffi });
    assert.strictEqual(probe(), null);
    assert.strictEqual(koffi.__behavior.closeHandleCalls, 1, "CloseHandle must run even when the query throws");
  });
});

describe("createForegroundWindowsTerminalProbe — HWND representation", () => {
  it("renders a BigInt HWND past Number.MAX_SAFE_INTEGER losslessly as a decimal string", () => {
    const bigAddr = 9007199254740993n; // 2^53 + 1, beyond safe integer precision
    assert.ok(bigAddr > BigInt(Number.MAX_SAFE_INTEGER));
    const probe = createForegroundWindowsTerminalProbe({
      isWin: true,
      koffi: fakeKoffi({ address: bigAddr }),
    });
    assert.strictEqual(probe(), "9007199254740993");
  });

  it("never returns a JS number", () => {
    const probe = createForegroundWindowsTerminalProbe({
      isWin: true,
      koffi: fakeKoffi({ address: 555n }),
    });
    assert.strictEqual(typeof probe(), "string");
  });
});

describe("createForegroundWindowsTerminalProbe — path.win32.basename usage", () => {
  it("parses a backslash Windows path for the process basename regardless of host OS", () => {
    // Deliberately not gated on process.platform === "win32": the whole point
    // of using path.win32.basename (not path.basename) is that this parse
    // must succeed even when the unit test itself runs on a POSIX host.
    const probe = createForegroundWindowsTerminalProbe({
      isWin: true,
      koffi: fakeKoffi({ imagePath: "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\WindowsTerminal.exe" }),
    });
    assert.strictEqual(probe(), "12345");
  });

  it("rejects a backslash path whose basename is not a Windows Terminal executable", () => {
    const probe = createForegroundWindowsTerminalProbe({
      isWin: true,
      koffi: fakeKoffi({ imagePath: "C:\\Windows\\System32\\WindowsTerminal.exe.fake\\evil.exe" }),
    });
    assert.strictEqual(probe(), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Windows-only ABI smoke: real koffi 2.15.2, real user32/kernel32 calls.
// A fake-koffi unit test cannot catch calling-convention, pointer-width, or
// UTF-16 buffer declaration mistakes — only an actual FFI round trip can.
// Skips (does not fail) off Windows or when koffi cannot be required at all
// (e.g. a missing native binary for the host arch).
// ─────────────────────────────────────────────────────────────────────────
let koffiAvailable = false;
try {
  require("koffi");
  koffiAvailable = true;
} catch {
  koffiAvailable = false;
}

describe(
  "createForegroundWindowsTerminalProbe — Windows ABI smoke",
  { skip: process.platform !== "win32" || !koffiAvailable },
  () => {
    it("really calls GetForegroundWindow + GetClassNameW (+ the rest of the chain) without throwing", () => {
      let onErrorCalls = 0;
      const probe = createForegroundWindowsTerminalProbe({
        onError: () => { onErrorCalls++; },
      });
      let result;
      assert.doesNotThrow(() => { result = probe(); });
      // The foreground window during a test run is not guaranteed to be
      // Windows Terminal, so the only assertable invariant is the return
      // contract: null, or a positive base-10 HWND string.
      assert.ok(
        result === null || /^[1-9]\d*$/.test(result),
        `expected null or a decimal HWND string, got ${JSON.stringify(result)}`
      );
      assert.strictEqual(onErrorCalls, 0, "the real ABI must init cleanly on this machine (koffi 2.15.2 confirmed available)");
    });

    it("calling it repeatedly is stable and side-effect free (no handle leak crash)", () => {
      const probe = createForegroundWindowsTerminalProbe({});
      for (let i = 0; i < 20; i++) {
        assert.doesNotThrow(() => probe());
      }
    });
  }
);
