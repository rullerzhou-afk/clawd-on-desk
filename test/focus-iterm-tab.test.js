// test/focus-iterm-tab.test.js — Tests for iTerm2 tab-level focus switching
const { describe, it } = require("node:test");
const assert = require("node:assert");

// focus.js destructures { execFile, spawn } at require-time, so we must
// patch child_process and process.platform BEFORE requiring focus.js.

function loadFocusWithMock(execFileMock, options = {}) {
  const cpKey = require.resolve("child_process");
  const focusKey = require.resolve("../src/focus");
  const platform = options.platform || "darwin";

  // Save originals
  const origCp = require.cache[cpKey];
  const origFocus = require.cache[focusKey];
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  // Build a patched child_process module
  const realCp = require("child_process");
  const patchedCp = { ...realCp, execFile: execFileMock, spawn: realCp.spawn };
  require.cache[cpKey] = { id: cpKey, filename: cpKey, loaded: true, exports: patchedCp };
  Object.defineProperty(process, "platform", {
    ...origPlatform,
    value: platform,
  });

  // Clear focus.js cache so it picks up patched child_process
  delete require.cache[focusKey];
  let initFocus;
  try {
    initFocus = require("../src/focus");
  } finally {
    Object.defineProperty(process, "platform", origPlatform);
  }

  // Restore child_process cache immediately (focus.js already captured the reference)
  if (origCp) require.cache[cpKey] = origCp;
  else delete require.cache[cpKey];

  const cleanup = () => {
    if (origFocus) require.cache[focusKey] = origFocus;
    else delete require.cache[focusKey];
  };

  return { initFocus, cleanup };
}

describe("iTerm2 tab focus (macOS)", () => {

  it("should call iTerm2 AppleScript when sourcePid belongs to iterm2 process", (t, done) => {
    const calls = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cmd === "osascript") {
        if (cb) cb(null, "", "");
        return;
      }
      if (cmd === "ps") {
        const a = args.join(" ");
        if (a.includes("comm=")) {
          if (cb) cb(null, "/Applications/iTerm.app/Contents/MacOS/iTerm2\n", "");
          return;
        }
        if (a.includes("tty=")) {
          if (cb) cb(null, "  16199 ttys003\n  16197 ttys003\n", "");
          return;
        }
      }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(11940, "/test/cwd", null, [16199, 16197, 16196, 12235, 12225, 12174, 11940]);

    setTimeout(() => {
      cleanup();

      const psCalls = calls.filter(c => c.cmd === "ps");
      assert.ok(psCalls.length >= 2, `Expected >= 2 ps calls, got ${psCalls.length}`);

      const commCall = psCalls.find(c => c.args.some(a => a.includes("comm=")));
      assert.ok(commCall, "Should call ps -o comm= to detect terminal type");

      const ttyCall = psCalls.find(c => c.args.some(a => a.includes("tty=")));
      assert.ok(ttyCall, "Should call ps -o tty= to find shell TTY");

      const osaCalls = calls.filter(c => c.cmd === "osascript");
      const itermScript = osaCalls.find(c =>
        c.args.some(a => typeof a === "string" && a.includes("iTerm2") && a.includes("tty of s"))
      );
      assert.ok(itermScript, "Should run iTerm2 AppleScript for tab switching");
      assert.ok(
        itermScript.args.some(a => a.includes("ttys003")),
        "Should use the resolved TTY name"
      );

      done();
    }, 2500);
  });

  it("should NOT call iTerm2 AppleScript for non-iTerm2 terminals", (t, done) => {
    const calls = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cmd === "ps" && args.join(" ").includes("comm=")) {
        if (cb) cb(null, "Terminal\n", "");
        return;
      }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(44444, "/test/cwd", null, [100, 200, 300, 44444]);

    setTimeout(() => {
      cleanup();

      const osaCalls = calls.filter(c => c.cmd === "osascript");
      const itermScript = osaCalls.find(c =>
        c.args.some(a => typeof a === "string" && a.includes("iTerm2"))
      );
      assert.ok(!itermScript, "Should NOT run iTerm2 AppleScript for Terminal.app");

      done();
    }, 2000);
  });

  it("should skip iTerm2 tab focus when pidChain is empty", (t, done) => {
    const calls = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(11940, "/test/cwd", null, []);

    setTimeout(() => {
      cleanup();

      const commCalls = calls.filter(c => c.cmd === "ps" && c.args.join(" ").includes("comm="));
      assert.strictEqual(commCalls.length, 0, "Should not attempt iTerm detection with empty pidChain");

      done();
    }, 1000);
  });

  it("should skip iTerm2 tab focus when no valid TTY found", (t, done) => {
    const calls = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cmd === "ps") {
        const a = args.join(" ");
        if (a.includes("comm=")) {
          if (cb) cb(null, "iTerm2\n", "");
          return;
        }
        if (a.includes("tty=")) {
          // All PIDs have no TTY
          if (cb) cb(null, "  100 ??\n  200 ??\n", "");
          return;
        }
      }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(11940, "/test/cwd", null, [100, 200, 11940]);

    setTimeout(() => {
      cleanup();

      const osaCalls = calls.filter(c => c.cmd === "osascript");
      const itermScript = osaCalls.find(c =>
        c.args.some(a => typeof a === "string" && a.includes("iTerm2"))
      );
      assert.ok(!itermScript, "Should NOT run iTerm2 AppleScript when no valid TTY");

      done();
    }, 2000);
  });

  it("should not drop same-iTerm2-PID focus requests with different pid chains", (t, done) => {
    const calls = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cmd === "osascript") {
        if (cb) cb(null, "", "");
        return;
      }
      if (cmd === "ps") {
        const a = args.join(" ");
        if (a.includes("comm=")) {
          if (cb) cb(null, "iTerm2\n", "");
          return;
        }
        if (a.includes("tty=")) {
          const pids = args[args.indexOf("-p") + 1] || "";
          const tty = pids.includes("301") ? "ttys002" : "ttys001";
          if (cb) cb(null, `  ${pids.split(",")[0]} ${tty}\n`, "");
          return;
        }
      }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(11940, "/test/cwd-a", null, [201, 11940]);
    setTimeout(() => {
      focusTerminalWindow(11940, "/test/cwd-b", null, [301, 11940]);
    }, 10);

    setTimeout(() => {
      cleanup();

      const itermScripts = calls
        .filter(c => c.cmd === "osascript")
        .filter(c => c.args.some(a => typeof a === "string" && a.includes("iTerm2")));
      assert.strictEqual(itermScripts.length, 2, "Should run tab switch for both pid chains");
      assert.ok(
        itermScripts.some(c => c.args.some(a => a.includes("ttys001"))),
        "Should switch to first TTY"
      );
      assert.ok(
        itermScripts.some(c => c.args.some(a => a.includes("ttys002"))),
        "Should switch to second TTY"
      );

      done();
    }, 2600);
  });
});
