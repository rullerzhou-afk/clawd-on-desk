// test/focus-mac-open.test.js — Tests for the macOS generic window-focus path
// (#465): LaunchServices activation (`open <bundle>`) first — it restores
// minimized windows and needs no Automation consent — with the System Events
// `set frontmost` script demoted to a fallback for non-bundle processes.

const { describe, it } = require("node:test");
const assert = require("node:assert");

// focus.js destructures { execFile, spawn } at require-time, so we patch
// child_process and process.platform BEFORE requiring focus.js. This mirrors
// the helper in test/focus-mac-extras.test.js.
function loadFocusWithMock(execFileMock, options = {}) {
  const cpKey = require.resolve("child_process");
  const focusKey = require.resolve("../src/focus");
  const platform = options.platform || "darwin";

  const origCp = require.cache[cpKey];
  const origFocus = require.cache[focusKey];
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  const realCp = require("child_process");
  const patchedCp = { ...realCp, execFile: execFileMock, spawn: realCp.spawn };
  require.cache[cpKey] = { id: cpKey, filename: cpKey, loaded: true, exports: patchedCp };
  Object.defineProperty(process, "platform", { ...origPlatform, value: platform });

  delete require.cache[focusKey];
  let initFocus;
  try {
    initFocus = require("../src/focus");
  } finally {
    Object.defineProperty(process, "platform", origPlatform);
  }
  if (origCp) require.cache[cpKey] = origCp;
  else delete require.cache[cpKey];

  const cleanup = () => {
    if (origFocus) require.cache[focusKey] = origFocus;
    else delete require.cache[focusKey];
  };
  return { initFocus, cleanup };
}

const VSCODE_HELPER_COMM =
  "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper";

function isPidCommPs(cmd, args) {
  return cmd === "ps" && args.includes("pid=,comm=");
}

function isSystemEventsFrontmost(cmd, args) {
  return cmd === "osascript"
    && args.some((a) => typeof a === "string" && a.includes("System Events") && a.includes("unix id"));
}

function isOpenAppBundle(call) {
  return call.cmd === "/usr/bin/open"
    && call.args.some((a) => typeof a === "string" && a.endsWith(".app"));
}

describe("macOS generic focus via open <bundle> (#465)", () => {
  it("extractMacAppBundlePath picks the outermost bundle and rejects non-bundles", () => {
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; }
      if (cb) cb(null, "", "");
    });
    const { __test } = initFocus({});
    cleanup();

    assert.strictEqual(
      __test.extractMacAppBundlePath(VSCODE_HELPER_COMM),
      "/Applications/Visual Studio Code.app"
    );
    assert.strictEqual(
      __test.extractMacAppBundlePath("/Applications/Claude.app/Contents/MacOS/Claude"),
      "/Applications/Claude.app"
    );
    assert.strictEqual(__test.extractMacAppBundlePath("/bin/zsh"), null);
    assert.strictEqual(__test.extractMacAppBundlePath("claude"), null);
    // A directory merely named *.app (no Contents/) is not a bundle.
    assert.strictEqual(__test.extractMacAppBundlePath("/Users/x/my.app/bin/tool"), null);
    assert.strictEqual(__test.extractMacAppBundlePath(null), null);
  });

  it("opens the app bundle resolved from the pid candidates and skips System Events", (t, done) => {
    const calls = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args], opts });
      if (isPidCommPs(cmd, args)) {
        if (cb) cb(null, [
          "31413 claude",
          "30713 /bin/zsh",
          `28428 ${VSCODE_HELPER_COMM}`,
        ].join("\n") + "\n", "");
        return;
      }
      if (cmd === "ps") { if (cb) cb(null, "/bin/zsh\n", ""); return; }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(28428, null, null, [31413, 30713, 29515, 28428]);

    setTimeout(() => {
      cleanup();
      const openCall = calls.find((c) =>
        c.cmd === "/usr/bin/open" && c.args.includes("/Applications/Visual Studio Code.app"));
      assert.ok(openCall, "Should activate via /usr/bin/open with the outer .app bundle");
      const frontmostCall = calls.find((c) => isSystemEventsFrontmost(c.cmd, c.args));
      assert.ok(!frontmostCall, "Should not run the System Events frontmost script when open succeeds");
      done();
    }, 100);
  });

  it("falls back to System Events with the consent timeout when no candidate is in a bundle", (t, done) => {
    const calls = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args], opts });
      if (isPidCommPs(cmd, args)) {
        if (cb) cb(null, "4242 /opt/homebrew/bin/wezterm-gui\n", "");
        return;
      }
      if (cmd === "ps") { if (cb) cb(null, "/opt/homebrew/bin/wezterm-gui\n", ""); return; }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(4242, null, null, [4242]);

    setTimeout(() => {
      cleanup();
      const frontmostCall = calls.find((c) => isSystemEventsFrontmost(c.cmd, c.args));
      assert.ok(frontmostCall, "Should fall back to the System Events frontmost script");
      assert.strictEqual(frontmostCall.opts.timeout, 15000,
        "Fallback script must outlive the Automation consent dialog");
      assert.ok(!calls.some(isOpenAppBundle), "Should not open any .app bundle");
      done();
    }, 100);
  });

  it("falls back to System Events when open fails", (t, done) => {
    const calls = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args], opts });
      if (isPidCommPs(cmd, args)) {
        if (cb) cb(null, `28428 ${VSCODE_HELPER_COMM}\n`, "");
        return;
      }
      if (cmd === "/usr/bin/open") {
        if (cb) cb(Object.assign(new Error("open failed"), { code: 1 }), "", "");
        return;
      }
      if (cmd === "ps") { if (cb) cb(null, "/bin/zsh\n", ""); return; }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(28428, null, null, [28428]);

    setTimeout(() => {
      cleanup();
      assert.ok(calls.some(isOpenAppBundle), "Should attempt /usr/bin/open first");
      const frontmostCall = calls.find((c) => isSystemEventsFrontmost(c.cmd, c.args));
      assert.ok(frontmostCall, "Should fall back to the System Events frontmost script after open fails");
      done();
    }, 100);
  });

  it("runs the iTerm tab script alongside open when the source is iTerm2", (t, done) => {
    const calls = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args], opts });
      if (isPidCommPs(cmd, args)) {
        if (cb) cb(null, "4242 /Applications/iTerm.app/Contents/MacOS/iTerm2\n", "");
        return;
      }
      if (cmd === "ps" && args.join(" ").includes("tty=")) {
        if (cb) cb(null, "  30713 ttys003\n", "");
        return;
      }
      if (cmd === "ps") {
        // Single-column comm gate used by the specialized handlers.
        if (cb) cb(null, "/Applications/iTerm.app/Contents/MacOS/iTerm2\n", "");
        return;
      }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(4242, null, null, [30713, 4242]);

    // The iTerm tab script fires on a 400ms delay — wait past it.
    setTimeout(() => {
      cleanup();
      const openCall = calls.find((c) =>
        c.cmd === "/usr/bin/open" && c.args.includes("/Applications/iTerm.app"));
      assert.ok(openCall, "Should activate iTerm via /usr/bin/open (restores minimized windows)");
      const itermTabCall = calls.find((c) =>
        c.cmd === "osascript"
        && c.args.some((a) => typeof a === "string" && a.includes('tell application "iTerm2"') && a.includes("select t")));
      assert.ok(itermTabCall, "Specialized iTerm tab selection should still run alongside open");
      const frontmostCall = calls.find((c) => isSystemEventsFrontmost(c.cmd, c.args));
      assert.ok(!frontmostCall, "Should not run the System Events frontmost script when open succeeds");
      done();
    }, 700);
  });

  it("logs automation-denied when the System Events fallback hits TCC -1743", (t, done) => {
    const logs = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      if (isPidCommPs(cmd, args)) {
        if (cb) cb(null, "4242 /opt/homebrew/bin/wezterm-gui\n", "");
        return;
      }
      if (cmd === "ps") { if (cb) cb(null, "/opt/homebrew/bin/wezterm-gui\n", ""); return; }
      if (isSystemEventsFrontmost(cmd, args)) {
        if (cb) cb(
          Object.assign(new Error("osascript exited 1"), { code: 1 }),
          "",
          "execution error: Not authorized to send Apple events to System Events. (-1743)"
        );
        return;
      }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({ focusLog: (msg) => logs.push(String(msg)) });
    focusTerminalWindow(4242, null, null, [4242]);

    setTimeout(() => {
      cleanup();
      const denied = logs.find((l) => l.includes("branch=mac-frontmost") && l.includes("reason=automation-denied"));
      assert.ok(denied, `focus log should record automation-denied, got: ${JSON.stringify(logs)}`);
      done();
    }, 100);
  });

  it("logs no-gui-process instead of ok when no candidate is a System Events process (#1139)", (t, done) => {
    const logs = [];
    let frontmostScript = null;
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      // A herdr server re-parented to launchd and the shells under it: no bundle.
      if (isPidCommPs(cmd, args)) {
        if (cb) cb(null, "1316 herdr\n36493 claude\n21588 -zsh\n", "");
        return;
      }
      if (cmd === "ps") { if (cb) cb(null, "herdr\n", ""); return; }
      if (isSystemEventsFrontmost(cmd, args)) {
        frontmostScript = args.find((a) => typeof a === "string" && a.includes("System Events"));
        if (cb) cb(null, "no-gui-process\n", "");
        return;
      }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({ focusLog: (msg) => logs.push(String(msg)) });
    focusTerminalWindow(1316, null, null, [36493, 21588, 1316]);

    setTimeout(() => {
      cleanup();
      assert.ok(frontmostScript && frontmostScript.includes('return "no-gui-process"'),
        "the System Events script must report a miss instead of falling through silently");
      const miss = logs.find((l) => l.includes("branch=mac-frontmost") && l.includes("reason=no-gui-process"));
      assert.ok(miss, `focus log should record no-gui-process, got: ${JSON.stringify(logs)}`);
      assert.ok(miss.includes("pids=1316,36493,21588"), miss);
      assert.ok(!logs.some((l) => l.includes("branch=mac-frontmost reason=ok")),
        "a miss must not also be logged as ok");
      done();
    }, 100);
  });

  it("ignores the ps exit code and parses surviving rows (dead pid in the list)", (t, done) => {
    const calls = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args], opts });
      if (isPidCommPs(cmd, args)) {
        // BSD ps exits 1 when any requested pid is gone but still prints live rows.
        if (cb) cb(Object.assign(new Error("exit 1"), { code: 1 }),
          `28428 ${VSCODE_HELPER_COMM}\n`, "");
        return;
      }
      if (cmd === "ps") { if (cb) cb(null, "/bin/zsh\n", ""); return; }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(28428, null, null, [31413, 28428]);

    setTimeout(() => {
      cleanup();
      const openCall = calls.find((c) =>
        c.cmd === "/usr/bin/open" && c.args.includes("/Applications/Visual Studio Code.app"));
      assert.ok(openCall, "Should still resolve the bundle from partial ps output");
      done();
    }, 100);
  });
});
