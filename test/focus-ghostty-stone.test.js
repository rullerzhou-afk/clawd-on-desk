// test/focus-ghostty-stone.test.js — Behavioural tests for runWithSteppingStone.
//
// Verifies the sequencing (stone before final), all fallback branches
// (probe miss/error, stone error, final non-ok), and the target-id binding
// that prevents shared-cwd ambiguity. Drives through scheduleGhosttyFocus via
// focusTerminalWindow so the mock execFile is wired correctly at require-time.
//
// focusTerminalWindow also fires System Events / iTerm / tmux / Superset osa
// calls — the helpers below filter to Ghostty-only scripts.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { loadFocusWithMock } = require("./helpers/load-focus-with-mock");

function readGhosttyStepSettleMs() {
  const { initFocus, cleanup } = loadFocusWithMock((cmd, args, opts, cb) => {
    if (typeof opts === "function") cb = opts;
    if (cb) cb(null, "", "");
  });
  try {
    return initFocus({}).__test.GHOSTTY_STEP_SETTLE_MS;
  } finally {
    cleanup();
  }
}

const GHOSTTY_STEP_SETTLE_MS = readGhosttyStepSettleMs();
const VIA_WAIT = GHOSTTY_STEP_SETTLE_MS + 250; // via path waits for Space settle, then fires target
const MISS_WAIT = 400 + 300; // thenFn path: runGhosttyScript 400ms delay + buffer

function isGhosttyOsa(args) {
  const script = args[1] || "";
  return script.includes('tell application "Ghostty"');
}

function isProbeOsa(args) {
  // Probe+stone scripts: contain "direct:" return AND may contain a focus call
  return isGhosttyOsa(args) && (args[1] || "").includes('"direct:"') && (args[1] || "").includes("stoneTerminal");
}

function makeMock(handlers) {
  const calls = [];
  function mock(cmd, args, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = {}; }
    calls.push({ cmd, args: [...args] });
    const key = cmd === "osascript" ? "osascript" : cmd;
    const handler = handlers[key];
    if (handler) { handler(args, cb); return; }
    if (cb) cb(null, "", "");
  }
  return { calls, mock };
}

// Returns only Ghostty-targeted osascript calls.
function ghosttyCalls(calls) {
  return calls.filter(c => c.cmd === "osascript" && isGhosttyOsa(c.args));
}

function callGhosttyFocus(focusTerminalWindow, { ghosttyTerminalId = "term-42", cwd = "/work" } = {}) {
  focusTerminalWindow(101, cwd, "ghostty", [101], { ghosttyTerminalId });
}

describe("runWithSteppingStone — via path: probe+stone then final", () => {
  it("fires one probe+stone script then one final script", (t, done) => {
    const osaOrder = [];
    const { calls, mock } = makeMock({
      ps: (args, cb) => cb(null, "ghostty\n", ""),
      osascript: (args, cb) => {
        if (!isGhosttyOsa(args)) { cb(null, "", ""); return; }
        if (isProbeOsa(args)) {
          osaOrder.push("probe+stone");
          cb(null, "via:stone-1|term-42\n", "");
          return;
        }
        osaOrder.push("final"); cb(null, "ok-id\n", "");
      },
    });
    const { initFocus, cleanup } = loadFocusWithMock(mock);
    const { focusTerminalWindow } = initFocus({});
    callGhosttyFocus(focusTerminalWindow);

    setTimeout(() => {
      cleanup();
      assert.deepStrictEqual(osaOrder, ["probe+stone", "final"],
        "probe+stone (with stone embedded) then final");
      done();
    }, VIA_WAIT);
  });

  it("does not fire the final focus inside the settle window", (t, done) => {
    const osaOrder = [];
    let finished = false;
    const { mock } = makeMock({
      ps: (args, cb) => cb(null, "ghostty\n", ""),
      osascript: (args, cb) => {
        if (!isGhosttyOsa(args)) { cb(null, "", ""); return; }
        if (isProbeOsa(args)) {
          osaOrder.push("probe+stone");
          cb(null, "via:stone-1|term-42\n", "");
          return;
        }
        osaOrder.push("final");
        cb(null, "ok-id\n", "");
      },
    });
    const { initFocus, cleanup } = loadFocusWithMock(mock);
    const { focusTerminalWindow } = initFocus({});
    const finish = (err) => {
      if (finished) return;
      finished = true;
      cleanup();
      done(err);
    };

    callGhosttyFocus(focusTerminalWindow);

    setTimeout(() => {
      if (finished) return;
      try {
        assert.deepStrictEqual(osaOrder, ["probe+stone"], "final must not run before Space settle");
      } catch (err) {
        finish(err);
      }
    }, Math.floor(GHOSTTY_STEP_SETTLE_MS / 2));

    setTimeout(() => {
      try {
        assert.deepStrictEqual(osaOrder, ["probe+stone", "final"], "final runs after Space settle");
        finish();
      } catch (err) {
        finish(err);
      }
    }, VIA_WAIT);
  });
});

describe("runWithSteppingStone — probe miss falls through to thenFn", () => {
  it("triggers the legacy fallback path when probe returns miss", (t, done) => {
    const osaOrder = [];
    const { calls, mock } = makeMock({
      ps: (args, cb) => {
        if (args.join(" ").includes("comm=")) cb(null, "ghostty\n", "");
        else cb(null, "101 s001\n", "");
      },
      osascript: (args, cb) => {
        if (!isGhosttyOsa(args)) { cb(null, "", ""); return; }
        if (isProbeOsa(args)) {
          osaOrder.push("probe");
          cb(null, "miss\n", "");
          return;
        }
        osaOrder.push("fallback-osa");
        cb(null, "ok-id\n", "");
      },
    });
    const { initFocus, cleanup } = loadFocusWithMock(mock);
    const { focusTerminalWindow } = initFocus({});
    callGhosttyFocus(focusTerminalWindow);

    setTimeout(() => {
      cleanup();
      assert.ok(osaOrder[0] === "probe", "probe ran first");
      assert.ok(osaOrder.length >= 2, "thenFn → legacy path ran after miss");
      done();
    }, MISS_WAIT);
  });
});

describe("runWithSteppingStone — probe error falls through to thenFn", () => {
  it("falls through when probe osascript errors", (t, done) => {
    const osaOrder = [];
    const { calls, mock } = makeMock({
      ps: (args, cb) => {
        if (args.join(" ").includes("comm=")) cb(null, "ghostty\n", "");
        else cb(null, "101 s001\n", "");
      },
      osascript: (args, cb) => {
        if (!isGhosttyOsa(args)) { cb(null, "", ""); return; }
        if (isProbeOsa(args)) {
          osaOrder.push("probe");
          cb(new Error("osascript: execution error"), "", "");
          return;
        }
        osaOrder.push("fallback-osa");
        cb(null, "ok-id\n", "");
      },
    });
    const { initFocus, cleanup } = loadFocusWithMock(mock);
    const { focusTerminalWindow } = initFocus({});
    callGhosttyFocus(focusTerminalWindow);

    setTimeout(() => {
      cleanup();
      assert.ok(osaOrder[0] === "probe", "probe ran first");
      assert.ok(osaOrder.length >= 2, "thenFn → legacy path ran after error");
      done();
    }, MISS_WAIT);
  });
});

describe("runWithSteppingStone — probe+stone error falls through to thenFn", () => {
  it("calls thenFn when the probe+stone script errors", (t, done) => {
    const osaOrder = [];
    const { calls, mock } = makeMock({
      ps: (args, cb) => {
        if (args.join(" ").includes("comm=")) cb(null, "ghostty\n", "");
        else cb(null, "101 s001\n", "");
      },
      osascript: (args, cb) => {
        if (!isGhosttyOsa(args)) { cb(null, "", ""); return; }
        if (isProbeOsa(args)) {
          osaOrder.push("probe+stone");
          cb(new Error("focus denied"), "", "");
          return;
        }
        osaOrder.push("fallback-osa");
        cb(null, "ok-id\n", "");
      },
    });
    const { initFocus, cleanup } = loadFocusWithMock(mock);
    const { focusTerminalWindow } = initFocus({});
    callGhosttyFocus(focusTerminalWindow);

    setTimeout(() => {
      cleanup();
      assert.ok(osaOrder.indexOf("probe+stone") === 0, "probe+stone ran first");
      assert.ok(osaOrder.slice(1).every(s => s === "fallback-osa"), "only fallback follows error");
      done();
    }, MISS_WAIT);
  });
});

describe("runWithSteppingStone — final non-ok falls through to thenFn", () => {
  it("calls thenFn when final osascript returns a non-ok status", (t, done) => {
    let finalRan = false;
    let fallbackRan = false;
    const { mock } = makeMock({
      ps: (args, cb) => {
        if (args.join(" ").includes("comm=")) cb(null, "ghostty\n", "");
        else cb(null, "101 s001\n", "");
      },
      osascript: (args, cb) => {
        if (!isGhosttyOsa(args)) { cb(null, "", ""); return; }
        const script = args[1] || "";
        if (isProbeOsa(args)) { cb(null, "via:stone-ok|term-42\n", ""); return; }
        if (script.includes('"stone-ok"') && !script.includes('"term-42"')) { cb(null, "ok-id\n", ""); return; }
        if (!finalRan) { finalRan = true; cb(null, "miss-id\n", ""); return; }
        fallbackRan = true;
        cb(null, "ok-id\n", "");
      },
    });
    const { initFocus, cleanup } = loadFocusWithMock(mock);
    const { focusTerminalWindow } = initFocus({});
    callGhosttyFocus(focusTerminalWindow);

    setTimeout(() => {
      cleanup();
      assert.ok(finalRan, "final ran");
      assert.ok(fallbackRan, "thenFn fallback ran after final non-ok");
      done();
    }, VIA_WAIT + MISS_WAIT);
  });
});

describe("runWithSteppingStone — target-id binding (suggestion 2)", () => {
  it("combined script references both stone-id and target-id, not the flat cwd query", (t, done) => {
    const combinedScripts = [];
    const finalScripts = [];
    const { mock } = makeMock({
      ps: (args, cb) => cb(null, "ghostty\n", ""),
      osascript: (args, cb) => {
        if (!isGhosttyOsa(args)) { cb(null, "", ""); return; }
        const script = args[1] || "";
        if (isProbeOsa(args)) { cb(null, "via:stone-99|exact-term-id\n", ""); return; }
        if (script.includes('"stone-99"') && !script.includes('"exact-term-id"')) { cb(null, "ok-id\n", ""); return; }
        finalScripts.push(script);
        cb(null, "ok-id\n", "");
      },
    });
    const { initFocus, cleanup } = loadFocusWithMock(mock);
    const { focusTerminalWindow } = initFocus({});
    callGhosttyFocus(focusTerminalWindow, { ghosttyTerminalId: "term-42" });

    setTimeout(() => {
      cleanup();
      assert.ok(finalScripts.length > 0, "final script ran");
      assert.ok(
        finalScripts[0].includes("exact-term-id"),
        "final must reference probe-returned target id"
      );
      assert.ok(
        !finalScripts[0].includes("every terminal whose working directory"),
        "final must not use the flat cwd whose-query"
      );
      done();
    }, VIA_WAIT);
  });
});
