"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  createHitWindowActivationController,
  createHitWindowActivationRuntime,
  createHitWindowFocusableSetter,
  WS_EX_NOACTIVATE,
  WM_MOUSEACTIVATE,
  MA_NOACTIVATE,
  STYLE_REFRESH_FLAGS,
} = require("../src/win-hit-window-activation");

function makeHarness({
  initialStyle = 0n,
  electronFocusable = false,
  refreshResult = true,
  armResult = true,
  onError,
} = {}) {
  let style = initialStyle;
  const nativeCalls = [];
  const electronCalls = [];
  const windowMessageCalls = [];
  const windowMessageHooks = new Map();
  const hwnd = { id: 42 };
  const win = {
    isDestroyed: () => false,
    isFocusable: () => electronFocusable,
    setFocusable(value) {
      electronFocusable = !!value;
      electronCalls.push(value);
    },
    hookWindowMessage(message, callback) {
      windowMessageCalls.push(["hookWindowMessage", message]);
      windowMessageHooks.set(message, callback);
    },
    unhookWindowMessage(message) {
      windowMessageCalls.push(["unhookWindowMessage", message]);
      windowMessageHooks.delete(message);
    },
  };
  const controller = createHitWindowActivationController({
    isWin: true,
    pointerBits: 64,
    hwndOf: (candidate) => candidate === win ? hwnd : null,
    bindings: {
      getStyle(candidate) {
        assert.strictEqual(candidate, hwnd);
        nativeCalls.push(["getStyle"]);
        return style;
      },
      setStyle(candidate, next) {
        assert.strictEqual(candidate, hwnd);
        nativeCalls.push(["setStyle", next]);
        style = BigInt.asUintN(64, BigInt(next));
        return 0n;
      },
      refreshStyle(candidate) {
        assert.strictEqual(candidate, hwnd);
        nativeCalls.push(["refreshStyle", STYLE_REFRESH_FLAGS]);
        return typeof refreshResult === "function" ? refreshResult() : refreshResult;
      },
      armMouseActivate(candidate) {
        assert.strictEqual(candidate, hwnd);
        nativeCalls.push(["armMouseActivate"]);
        return typeof armResult === "function" ? armResult() : armResult;
      },
      clearMouseActivate(candidate) {
        assert.strictEqual(candidate, hwnd);
        nativeCalls.push(["clearMouseActivate"]);
        return null;
      },
    },
    onError,
  });
  return {
    controller,
    win,
    nativeCalls,
    electronCalls,
    windowMessageCalls,
    dispatchWindowMessage(message) {
      return windowMessageHooks.get(message)?.(Buffer.alloc(8), Buffer.alloc(8));
    },
    getStyle: () => style,
  };
}

describe("Windows hit-window activation controller", () => {
  it("guards fullscreen mouse activation without calling Electron setFocusable(false)", () => {
    const h = makeHarness({ initialStyle: 0x00080088n });
    assert.equal(MA_NOACTIVATE, 3);

    assert.equal(h.controller.setFocusable(h.win, false), true);

    assert.equal((h.getStyle() & WS_EX_NOACTIVATE) !== 0n, true);
    assert.deepStrictEqual(h.electronCalls, []);
    assert.deepStrictEqual(h.windowMessageCalls, [["hookWindowMessage", WM_MOUSEACTIVATE]]);
    assert.deepStrictEqual(h.nativeCalls, [
      ["armMouseActivate"],
      ["getStyle"],
      ["setStyle", 0x08080088n],
      ["refreshStyle", STYLE_REFRESH_FLAGS],
      ["getStyle"],
    ]);

    assert.equal(h.dispatchWindowMessage(WM_MOUSEACTIVATE), undefined);
    assert.deepStrictEqual(h.nativeCalls.at(-1), ["armMouseActivate"]);
  });

  it("is idempotent while the hit window is already non-activating", () => {
    const h = makeHarness({ initialStyle: WS_EX_NOACTIVATE | 0x88n });

    assert.equal(h.controller.setFocusable(h.win, false), true);

    assert.deepStrictEqual(h.nativeCalls, [["armMouseActivate"], ["getStyle"]]);
    assert.deepStrictEqual(h.electronCalls, []);
    assert.deepStrictEqual(h.windowMessageCalls, [["hookWindowMessage", WM_MOUSEACTIVATE]]);
  });

  it("keeps the hook while restoring desktop activation semantics", () => {
    const h = makeHarness({ initialStyle: 0x00080088n });

    assert.equal(h.controller.setFocusable(h.win, false), true);

    assert.equal(h.controller.setFocusable(h.win, true), true);

    assert.equal(h.getStyle(), 0x00080088n);
    assert.deepStrictEqual(h.electronCalls, []);
    assert.deepStrictEqual(h.windowMessageCalls, [["hookWindowMessage", WM_MOUSEACTIVATE]]);
    assert.equal(h.dispatchWindowMessage(WM_MOUSEACTIVATE), undefined);
    assert.deepStrictEqual(h.nativeCalls.at(-1), ["armMouseActivate"]);

    assert.equal(h.controller.dispose(), true);
    assert.equal(h.controller.dispose(), true);
    assert.deepStrictEqual(h.windowMessageCalls, [
      ["hookWindowMessage", WM_MOUSEACTIVATE],
      ["unhookWindowMessage", WM_MOUSEACTIVATE],
    ]);
    assert.deepStrictEqual(h.nativeCalls.at(-1), ["clearMouseActivate"]);
  });

  it("clears native non-activation on desktop while retaining the delivery hook", () => {
    const h = makeHarness({
      initialStyle: WS_EX_NOACTIVATE | 0x88n,
      electronFocusable: false,
    });

    assert.equal(h.controller.setFocusable(h.win, true), true);

    assert.deepStrictEqual(h.electronCalls, []);
    assert.equal((h.getStyle() & WS_EX_NOACTIVATE) !== 0n, false);
    assert.deepStrictEqual(h.windowMessageCalls, [["hookWindowMessage", WM_MOUSEACTIVATE]]);
    assert.equal(h.dispatchWindowMessage(WM_MOUSEACTIVATE), undefined);
    assert.deepStrictEqual(h.nativeCalls.at(-1), ["armMouseActivate"]);
  });

  it("prepares only the delivery hook before first show", () => {
    const h = makeHarness({ initialStyle: WS_EX_NOACTIVATE | 0x88n });

    assert.equal(h.controller.prepare(h.win), true);

    assert.equal(h.getStyle(), WS_EX_NOACTIVATE | 0x88n);
    assert.deepStrictEqual(h.nativeCalls, [["armMouseActivate"]]);
    assert.deepStrictEqual(h.windowMessageCalls, [["hookWindowMessage", WM_MOUSEACTIVATE]]);
  });

  it("latches a failed pre-show guard into the legacy fallback", () => {
    let armAllowed = false;
    const h = makeHarness({ armResult: () => armAllowed });

    assert.equal(h.controller.prepare(h.win), false);
    armAllowed = true;
    assert.equal(h.controller.setFocusable(h.win, false), false);

    assert.deepStrictEqual(h.nativeCalls, [
      ["armMouseActivate"],
      ["clearMouseActivate"],
    ]);
    assert.deepStrictEqual(h.windowMessageCalls, [
      ["hookWindowMessage", WM_MOUSEACTIVATE],
      ["unhookWindowMessage", WM_MOUSEACTIVATE],
    ]);
  });

  it("never falls back to the focus-stealing Electron false call when native refresh fails", () => {
    const h = makeHarness({ refreshResult: false });

    assert.equal(h.controller.setFocusable(h.win, false), false);
    assert.deepStrictEqual(h.electronCalls, []);
  });

  it("deduplicates repeated arm failures until the same window recovers", () => {
    const errors = [];
    let armAllowed = false;
    const h = makeHarness({
      armResult: () => armAllowed,
      onError: (error) => errors.push(error.message),
    });

    assert.equal(h.controller.setFocusable(h.win, true), false);
    assert.equal(h.controller.setFocusable(h.win, true), false);
    assert.deepStrictEqual(h.windowMessageCalls, [
      ["hookWindowMessage", WM_MOUSEACTIVATE],
      ["unhookWindowMessage", WM_MOUSEACTIVATE],
      ["hookWindowMessage", WM_MOUSEACTIVATE],
      ["unhookWindowMessage", WM_MOUSEACTIVATE],
    ]);
    assert.deepStrictEqual(
      h.nativeCalls.filter((call) => call[0] === "armMouseActivate"),
      [["armMouseActivate"], ["armMouseActivate"]],
    );
    assert.deepStrictEqual(errors, ["Windows hit-window mouse activation guard failed"]);

    armAllowed = true;
    assert.equal(h.controller.setFocusable(h.win, true), true);
    armAllowed = false;
    h.dispatchWindowMessage(WM_MOUSEACTIVATE);
    assert.deepStrictEqual(errors, [
      "Windows hit-window mouse activation guard failed",
      "Windows hit-window mouse activation guard failed",
    ]);
  });

  it("retries an owed native style refresh even when the style bit already matches", () => {
    let refreshCalls = 0;
    const errors = [];
    const h = makeHarness({
      refreshResult: () => ++refreshCalls > 1,
      onError: (error) => errors.push(error.message),
    });

    assert.equal(h.controller.setFocusable(h.win, false), false);
    assert.equal((h.getStyle() & WS_EX_NOACTIVATE) !== 0n, true);
    assert.equal(h.controller.setFocusable(h.win, false), true);
    assert.equal(refreshCalls, 2);
    assert.deepStrictEqual(errors, ["Windows hit-window style refresh failed"]);
  });

  it("degrades without mutating Electron focusability when native bindings are unavailable", () => {
    const calls = [];
    const errors = [];
    const win = {
      isDestroyed: () => false,
      setFocusable: (value) => calls.push(value),
    };
    const unavailable = createHitWindowActivationController({
      isWin: true,
      koffi: { load() { throw new Error("user32 unavailable"); } },
      onError: (error) => errors.push(error.message),
    });

    assert.equal(unavailable.available, false);
    assert.equal(unavailable.setFocusable(win, false), false);
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(errors, ["user32 unavailable"]);
  });

  it("routes main's fullscreen focusability changes through the native controller", () => {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    const start = mainSource.indexOf(
      "const _hitWindowActivationRuntime = createHitWindowActivationRuntime({",
    );
    const end = mainSource.indexOf("\n});", start);
    assert.ok(start >= 0 && end > start);
    const compositionSource = mainSource.slice(start, end);

    assert.match(compositionSource, /isWin,/);
    assert.match(compositionSource, /getHitWindow:\s*\(\)\s*=>\s*hitWin/);
    assert.match(
      mainSource,
      /windowsHitWindowFocusable:\s*_hitWindowActivationRuntime\.windowsHitWindowFocusable/,
    );
    assert.match(
      mainSource,
      /const setHitWinFocusable = _hitWindowActivationRuntime\.setHitWinFocusable/,
    );
    assert.match(
      mainSource,
      /prepareActivation:\s*\(createdHitWin\)\s*=>[\s\S]*?_hitWindowActivationRuntime\.controller\.prepare\(createdHitWin\)/,
    );
    assert.doesNotMatch(mainSource, /hitWin\.setFocusable\(/);
    assert.match(mainSource, /setHitWinFocusable,\s*\n/);

    const disposeIndex = mainSource.indexOf("_hitWindowActivationRuntime.controller.dispose()");
    const destroyIndex = mainSource.indexOf("hitWin.destroy()", disposeIndex);
    assert.ok(disposeIndex >= 0 && destroyIndex > disposeIndex);
  });

  it("composes controller availability, fallback construction, and the live setter", () => {
    let style = WS_EX_NOACTIVATE;
    const hitWin = {
      isDestroyed: () => false,
      hookWindowMessage: () => {},
      unhookWindowMessage: () => {},
    };
    const runtime = createHitWindowActivationRuntime({
      isWin: true,
      pointerBits: 64,
      getHitWindow: () => hitWin,
      hwndOf: (candidate) => candidate === hitWin ? 42n : null,
      bindings: {
        getStyle: () => style,
        setStyle: (_hwnd, next) => { style = BigInt.asUintN(64, BigInt(next)); },
        refreshStyle: () => true,
        armMouseActivate: () => true,
        clearMouseActivate: () => null,
      },
    });

    assert.equal(runtime.controller.available, true);
    assert.equal(runtime.windowsHitWindowFocusable, false);
    assert.equal(runtime.setHitWinFocusable(true), true);
    assert.equal((style & WS_EX_NOACTIVATE) !== 0n, false);

    const fallback = createHitWindowActivationRuntime({
      isWin: true,
      getHitWindow: () => hitWin,
      koffi: { load() { throw new Error("synthetic unavailable"); } },
    });
    assert.equal(fallback.controller.available, false);
    assert.equal(fallback.windowsHitWindowFocusable, true);
    assert.equal(fallback.setHitWinFocusable(false), false);
  });

  it("the main-wiring setter delegates dynamically to the owned hit window", () => {
    const calls = [];
    let hitWin = { id: 1 };
    const setter = createHitWindowFocusableSetter({
      isWin: true,
      controller: {
        setFocusable: (win, focusable) => {
          calls.push([win.id, focusable]);
          return true;
        },
      },
      getHitWindow: () => hitWin,
    });

    assert.equal(setter(false), true);
    hitWin = { id: 2 };
    assert.equal(setter(true), true);
    assert.deepStrictEqual(calls, [[1, false], [2, true]]);
  });
});
