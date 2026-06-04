// test/focus-mac-extras.test.js — Tests for the Mac-only Superset / Ghostty
// focus paths added on top of the existing iTerm2 / generic frontmost chain.
//
// These exercise the actual scheduling path (comm gate → open / AppleScript)
// by mocking child_process. The pure helpers used by Superset are covered
// separately in test/focus-superset.test.js.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Hermetic home env so scheduleSupersetFocus's internal findSupersetDataDirs()
// (which scans os.homedir()/.superset*/local.db) sees a controlled fixture
// instead of the host's real Superset install (or its absence on CI). Must be
// paired with restoreHome() in the test's cleanup.
function setupHermeticSupersetHome({ withDb = true } = {}) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "focus-test-home-"));
  if (withDb) {
    fs.mkdirSync(path.join(tmpHome, ".superset"), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, ".superset", "local.db"), "");
  }
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  return {
    tmpHome,
    restoreHome() {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    },
  };
}

// focus.js destructures { execFile, spawn } at require-time, so we patch
// child_process and process.platform BEFORE requiring focus.js. This mirrors
// the helper in test/focus-iterm-tab.test.js.
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

function commLine(name) {
  return `${name}\n`;
}

describe("Superset deep-link focus (macOS)", () => {
  it("opens superset://workspace/<id> with -b bundle id when source is Superset", (t, done) => {
    const { restoreHome } = setupHermeticSupersetHome();
    const calls = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cmd === "ps" && args.join(" ").includes("comm=")) {
        // Superset bundle exec resolves to ".../MacOS/Superset" → basename "Superset".
        if (cb) cb(null, commLine("/Applications/Superset.app/Contents/MacOS/Superset"), "");
        return;
      }
      if (cmd === "sqlite3") {
        if (cb) cb(null, "ws-test-id\n", "");
        return;
      }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(11940, "/some/superset/cwd", null, [11940]);

    setTimeout(() => {
      cleanup();
      restoreHome();

      const openCall = calls.find((c) =>
        c.cmd === "/usr/bin/open" &&
        c.args.includes("-b") &&
        c.args.includes("com.superset.desktop") &&
        c.args.some((a) => typeof a === "string" && a.startsWith("superset://workspace/"))
      );
      assert.ok(openCall, "Should open superset://workspace/<id> with -b com.superset.desktop");

      const url = openCall.args.find((a) => typeof a === "string" && a.startsWith("superset://workspace/"));
      assert.ok(url.endsWith("ws-test-id"), `URL should carry the looked-up workspace id, got ${url}`);

      done();
    }, 1500);
  });

  it("does not open superset://… when source process is not Superset", (t, done) => {
    // Empty tmp HOME (no .superset/local.db) so even if the comm gate broke
    // the host's real Superset install would not be exercised.
    const { restoreHome } = setupHermeticSupersetHome({ withDb: false });
    const calls = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cmd === "ps" && args.join(" ").includes("comm=")) {
        if (cb) cb(null, commLine("Terminal"), "");
        return;
      }
      // Should not be called, but mock anyway.
      if (cmd === "sqlite3") {
        if (cb) cb(null, "ws-should-not-be-used\n", "");
        return;
      }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(11940, "/some/superset/cwd", null, [11940]);

    setTimeout(() => {
      cleanup();
      restoreHome();

      const openCall = calls.find((c) =>
        c.cmd === "/usr/bin/open" &&
        c.args.some((a) => typeof a === "string" && a.startsWith("superset://"))
      );
      assert.ok(!openCall, "Should not invoke /usr/bin/open with a superset:// URL when source is not Superset");

      const sqliteCall = calls.find((c) => c.cmd === "sqlite3");
      assert.ok(!sqliteCall, "Should not query Superset DB when source is not Superset");

      done();
    }, 1500);
  });

  it("does not run the Superset path when cwd is empty", (t, done) => {
    const { restoreHome } = setupHermeticSupersetHome({ withDb: false });
    const calls = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(11940, "", null, [11940]);

    setTimeout(() => {
      cleanup();
      restoreHome();
      const sqliteCall = calls.find((c) => c.cmd === "sqlite3");
      assert.ok(!sqliteCall, "Should not query Superset DB when cwd is empty");
      const openCall = calls.find((c) =>
        c.cmd === "/usr/bin/open" &&
        c.args.some((a) => typeof a === "string" && a.startsWith("superset://"))
      );
      assert.ok(!openCall, "Should not open a superset:// URL when cwd is empty");
      done();
    }, 1000);
  });
});

describe("Ghostty focus (macOS)", () => {
  it("dispatches Ghostty AppleScript with cwd literal when source is ghostty", (t, done) => {
    const calls = [];
    const logs = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cmd === "ps" && args.join(" ").includes("comm=")) {
        if (cb) cb(null, commLine("ghostty"), "");
        return;
      }
      if (cmd === "osascript") {
        if (cb) cb(null, "ok-cwd\n", "");
        return;
      }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({ focusLog: (msg) => logs.push(msg) });
    focusTerminalWindow(11940, "/some/cwd-for-ghostty", null, [11940]);

    setTimeout(() => {
      cleanup();
      const osaCalls = calls.filter((c) => c.cmd === "osascript");
      const ghosttyScript = osaCalls.find((c) =>
        c.args.some((a) =>
          typeof a === "string" &&
          a.includes('tell application "Ghostty"') &&
          a.includes("working directory") &&
          a.includes("/some/cwd-for-ghostty")
        )
      );
      assert.ok(ghosttyScript, "Should run Ghostty AppleScript carrying the cwd literal");
      assert.ok(
        logs.some((line) => line.includes("branch=ghostty reason=no-pid-candidates")),
        `Should log Ghostty no-pid-candidates before cwd fallback, got ${logs.join("\n")}`
      );
      assert.ok(
        logs.some((line) => line.includes("branch=ghostty reason=cwd-fallback")),
        `Should log Ghostty cwd fallback, got ${logs.join("\n")}`
      );
      done();
    }, 1500);
  });

  it("uses captured Ghostty terminal id before tty or cwd fallback", (t, done) => {
    const calls = [];
    const logs = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cmd === "ps") {
        const joined = args.join(" ");
        if (joined.includes("comm=")) {
          if (cb) cb(null, commLine("ghostty"), "");
          return;
        }
        if (joined.includes("tty=")) {
          if (cb) cb(null, "  200 ttys007\n", "");
          return;
        }
      }
      if (cmd === "osascript") {
        const script = args.find((a) => typeof a === "string" && a.includes('tell application "Ghostty"')) || "";
        if (script.includes("targetId") && script.includes("term-42")) {
          if (cb) cb(null, "ok-id\n", "");
          return;
        }
        if (cb) cb(null, "", "");
        return;
      }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({ focusLog: (msg) => logs.push(msg) });
    focusTerminalWindow({
      sourcePid: 11940,
      cwd: "/same/project",
      pidChain: [200, 11940],
      ghosttyTerminalId: "term-42",
    });

    setTimeout(() => {
      cleanup();
      const ghosttyScripts = calls
        .filter((c) => c.cmd === "osascript")
        .map((c) => c.args.find((a) => typeof a === "string" && a.includes('tell application "Ghostty"')) || "")
        .filter((script) => script.includes('tell application "Ghostty"'));
      assert.ok(
        ghosttyScripts.some((script) => script.includes("targetId") && script.includes("term-42")),
        "Should dispatch Ghostty id focus AppleScript"
      );
      assert.ok(
        !calls.some((c) => c.cmd === "ps" && c.args.join(" ").includes("tty=")),
        "Should not look up tty after captured id focus succeeds"
      );
      assert.ok(
        !ghosttyScripts.some((script) => script.includes("working directory")),
        "Should not run cwd fallback after captured id focus succeeds"
      );
      assert.ok(
        logs.some((line) => line.includes("branch=ghostty reason=ok-id")),
        `Should log Ghostty id success, got ${logs.join("\n")}`
      );
      done();
    }, 1500);
  });

  it("falls through to Ghostty tty precision when captured id is unsupported", (t, done) => {
    const calls = [];
    const logs = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cmd === "ps") {
        const joined = args.join(" ");
        if (joined.includes("comm=")) {
          if (cb) cb(null, commLine("ghostty"), "");
          return;
        }
        if (joined.includes("tty=")) {
          if (cb) cb(null, "  200 ttys007\n", "");
          return;
        }
      }
      if (cmd === "osascript") {
        const script = args.find((a) => typeof a === "string" && a.includes('tell application "Ghostty"')) || "";
        if (script.includes("targetId") && script.includes("term-42")) {
          if (cb) cb(null, "unsupported-id:-2753\n", "");
          return;
        }
        if (script.includes("whose tty ends with")) {
          if (cb) cb(null, "ok-tty\n", "");
          return;
        }
        if (cb) cb(null, "", "");
        return;
      }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({ focusLog: (msg) => logs.push(msg) });
    focusTerminalWindow({
      sourcePid: 11940,
      cwd: "/same/project",
      pidChain: [200, 11940],
      ghosttyTerminalId: "term-42",
    });

    setTimeout(() => {
      cleanup();
      assert.ok(
        calls.some((c) => c.cmd === "ps" && c.args.join(" ").includes("tty=")),
        "Should look up tty after captured id is unsupported"
      );
      assert.ok(
        logs.some((line) => line.includes("branch=ghostty reason=unsupported-id:-2753")),
        `Should log Ghostty id unsupported status, got ${logs.join("\n")}`
      );
      assert.ok(
        logs.some((line) => line.includes("branch=ghostty reason=ok-tty")),
        `Should continue to tty focus after id unsupported, got ${logs.join("\n")}`
      );
      assert.ok(
        !logs.some((line) => line.includes("branch=ghostty reason=cwd-fallback")),
        "Should not fall back to cwd after tty succeeds"
      );
      done();
    }, 2200);
  });

  it("captures the focused Ghostty terminal id for later session focus", (t, done) => {
    const calls = [];
    const logs = [];
    let captured = null;
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cmd === "ps" && args.join(" ").includes("comm=")) {
        if (cb) cb(null, commLine("ghostty"), "");
        return;
      }
      if (cmd === "osascript") {
        const script = args.find((a) => typeof a === "string" && a.includes('tell application "Ghostty"')) || "";
        if (script.includes("focused terminal of selected tab of front window")) {
          if (cb) cb(null, "term-42\n", "");
          return;
        }
      }
      if (cb) cb(null, "", "");
    });

    const { captureGhosttyTerminalId } = initFocus({ focusLog: (msg) => logs.push(msg) });
    assert.strictEqual(captureGhosttyTerminalId({ sourcePid: 11940, cwd: "/same/project" }, (id) => { captured = id; }), true);

    setTimeout(() => {
      cleanup();
      assert.strictEqual(captured, "term-42");
      assert.ok(
        calls.some((c) => c.cmd === "osascript" && c.args.some((a) => typeof a === "string" && a.includes("focused terminal"))),
        "Should query Ghostty focused terminal id"
      );
      assert.ok(
        calls.some((c) => c.cmd === "osascript" && c.args.some((a) => typeof a === "string" && a.includes("working directory of terminalRef") && a.includes("/same/project"))),
        "Should require captured Ghostty terminal cwd to match the session cwd"
      );
      assert.ok(
        logs.some((line) => line.includes("branch=ghostty-capture reason=ok-id")),
        `Should log Ghostty id capture success, got ${logs.join("\n")}`
      );
      done();
    }, 500);
  });

  it("does not capture Ghostty terminal id when frontmost/cwd checks miss", (t, done) => {
    const results = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      if (cmd === "ps" && args.join(" ").includes("comm=")) {
        if (cb) cb(null, commLine("ghostty"), "");
        return;
      }
      if (cmd === "osascript") {
        const script = args.find((a) => typeof a === "string" && a.includes('tell application "Ghostty"')) || "";
        if (script.includes("/frontmost")) {
          if (cb) cb(null, "missing-frontmost\n", "");
          return;
        }
        if (cb) cb(null, "miss-cwd\n", "");
        return;
      }
      if (cb) cb(null, "", "");
    });

    const { captureGhosttyTerminalId } = initFocus({});
    captureGhosttyTerminalId({ sourcePid: 11940, cwd: "/frontmost" }, (id) => results.push(id));
    captureGhosttyTerminalId({ sourcePid: 11940, cwd: "/other-cwd" }, (id) => results.push(id));

    setTimeout(() => {
      cleanup();
      assert.deepStrictEqual(results, [null, null]);
      done();
    }, 500);
  });

  it("tries Ghostty tty precision before cwd fallback when pidChain has a tty", (t, done) => {
    const calls = [];
    const logs = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cmd === "ps") {
        const joined = args.join(" ");
        if (joined.includes("comm=")) {
          if (cb) cb(null, commLine("ghostty"), "");
          return;
        }
        if (joined.includes("tty=")) {
          if (cb) cb(null, "  200 ttys007\n  201 ttys007\n", "");
          return;
        }
      }
      if (cmd === "osascript") {
        const script = args.find((a) => typeof a === "string" && a.includes('tell application "Ghostty"')) || "";
        if (script.includes('tell application "Ghostty"') && script.includes("whose tty ends with")) {
          if (cb) cb(null, "ok-tty\n", "");
          return;
        }
        if (cb) cb(null, "", "");
        return;
      }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({ focusLog: (msg) => logs.push(msg) });
    focusTerminalWindow(11940, "/same/project", null, [200, 201, 11940]);

    setTimeout(() => {
      cleanup();
      const ttyCall = calls.find((c) => c.cmd === "ps" && c.args.join(" ").includes("tty="));
      assert.ok(ttyCall, "Should look up tty from pidChain for Ghostty precision");
      assert.ok(
        ttyCall.args.includes("200,201"),
        `Should exclude sourcePid from tty lookup, got ${ttyCall.args.join(" ")}`
      );

      const ghosttyScripts = calls
        .filter((c) => c.cmd === "osascript")
        .map((c) => c.args.find((a) => typeof a === "string" && a.includes('tell application "Ghostty"')) || "")
        .filter((script) => script.includes('tell application "Ghostty"'));
      const precise = ghosttyScripts.find((script) =>
        script.includes("whose tty ends with") &&
        script.includes("ttys007")
      );
      assert.ok(precise, "Should dispatch Ghostty tty precise AppleScript");
      assert.ok(
        !ghosttyScripts.some((script) => script.includes("working directory")),
        "Should not run cwd fallback after precise Ghostty focus succeeds"
      );
      assert.ok(
        logs.some((line) => line.includes("branch=ghostty reason=ok-tty")),
        `Should log Ghostty tty success, got ${logs.join("\n")}`
      );
      assert.ok(
        !logs.some((line) => line.includes("branch=ghostty reason=cwd-fallback")),
        "Should not log cwd fallback after tty success"
      );
      done();
    }, 1800);
  });

  it("uses Ghostty pid precision when tty misses", (t, done) => {
    const calls = [];
    const logs = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cmd === "ps") {
        const joined = args.join(" ");
        if (joined.includes("comm=")) {
          if (cb) cb(null, commLine("ghostty"), "");
          return;
        }
        if (joined.includes("tty=")) {
          if (cb) cb(null, "  200 ttys009\n", "");
          return;
        }
      }
      if (cmd === "osascript") {
        const script = args.find((a) => typeof a === "string" && a.includes('tell application "Ghostty"')) || "";
        if (script.includes('tell application "Ghostty"') && script.includes("whose tty ends with")) {
          if (cb) cb(null, "miss\n", "");
          return;
        }
        if (script.includes('tell application "Ghostty"') && script.includes("whose pid is")) {
          if (cb) cb(null, "ok-pid\n", "");
          return;
        }
        if (cb) cb(null, "ok-cwd\n", "");
        return;
      }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({ focusLog: (msg) => logs.push(msg) });
    focusTerminalWindow(11940, "/same/project", null, [200, 11940]);

    setTimeout(() => {
      cleanup();
      const ghosttyScripts = calls
        .filter((c) => c.cmd === "osascript")
        .map((c) => c.args.find((a) => typeof a === "string" && a.includes('tell application "Ghostty"')) || "")
        .filter((script) => script.includes('tell application "Ghostty"'));
      assert.ok(
        ghosttyScripts.some((script) => script.includes("whose tty ends with")),
        "Should try Ghostty tty focus first"
      );
      assert.ok(
        ghosttyScripts.some((script) => script.includes("whose pid is") && script.includes("200")),
        "Should use Ghostty pid focus after tty misses"
      );
      assert.ok(
        !ghosttyScripts.some((script) => script.includes("working directory")),
        "Should not run cwd fallback after pid focus succeeds"
      );
      assert.ok(
        logs.some((line) => line.includes("branch=ghostty reason=miss-tty")),
        `Should log Ghostty tty miss, got ${logs.join("\n")}`
      );
      assert.ok(
        logs.some((line) => line.includes("branch=ghostty reason=ok-pid")),
        `Should log Ghostty pid success, got ${logs.join("\n")}`
      );
      assert.ok(
        !logs.some((line) => line.includes("branch=ghostty reason=cwd-fallback")),
        "Should not log cwd fallback after pid success"
      );
      done();
    }, 1800);
  });

  it("falls back to Ghostty cwd focus when tty precision is unavailable", (t, done) => {
    const calls = [];
    const logs = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cmd === "ps") {
        const joined = args.join(" ");
        if (joined.includes("comm=")) {
          if (cb) cb(null, commLine("ghostty"), "");
          return;
        }
        if (joined.includes("tty=")) {
          if (cb) cb(null, "  200 ttys008\n", "");
          return;
        }
      }
      if (cmd === "osascript") {
        const script = args.find((a) => typeof a === "string" && a.includes('tell application "Ghostty"')) || "";
        if (script.includes('tell application "Ghostty"') && script.includes("whose tty ends with")) {
          if (cb) cb(new Error("Ghostty dictionary does not expose tty"), "", "");
          return;
        }
        if (script.includes('tell application "Ghostty"') && script.includes("whose pid is")) {
          if (cb) cb(null, "miss\n", "");
          return;
        }
        if (cb) cb(null, "ok-cwd\n", "");
        return;
      }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({ focusLog: (msg) => logs.push(msg) });
    focusTerminalWindow(11940, "/same/project", null, [200, 11940]);

    setTimeout(() => {
      cleanup();
      const ghosttyScripts = calls
        .filter((c) => c.cmd === "osascript")
        .map((c) => c.args.find((a) => typeof a === "string" && a.includes('tell application "Ghostty"')) || "")
        .filter((script) => script.includes('tell application "Ghostty"'));
      assert.ok(
        ghosttyScripts.some((script) => script.includes("whose tty ends with")),
        "Should try Ghostty precise focus first"
      );
      assert.ok(
        ghosttyScripts.some((script) => script.includes("whose pid is")),
        "Should try Ghostty pid focus before cwd fallback"
      );
      assert.ok(
        ghosttyScripts.some((script) =>
          script.includes("working directory") &&
          script.includes("/same/project")
        ),
        "Should fall back to cwd focus when precise Ghostty focus fails"
      );
      assert.ok(
        logs.some((line) => line.includes("branch=ghostty reason=osascript-failed-tty:Error")),
        `Should log Ghostty tty osascript failure, got ${logs.join("\n")}`
      );
      assert.ok(
        logs.some((line) => line.includes("branch=ghostty reason=miss-pid")),
        `Should log Ghostty pid miss, got ${logs.join("\n")}`
      );
      assert.ok(
        logs.some((line) => line.includes("branch=ghostty reason=cwd-fallback")),
        `Should log Ghostty cwd fallback, got ${logs.join("\n")}`
      );
      assert.ok(
        logs.some((line) => line.includes("branch=ghostty reason=ok-cwd")),
        `Should log Ghostty cwd success, got ${logs.join("\n")}`
      );
      done();
    }, 2400);
  });

  it("logs best-effort Ghostty unsupported statuses when AppleScript returns them", (t, done) => {
    const calls = [];
    const logs = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cmd === "ps") {
        const joined = args.join(" ");
        if (joined.includes("comm=")) {
          if (cb) cb(null, commLine("ghostty"), "");
          return;
        }
        if (joined.includes("tty=")) {
          if (cb) cb(null, "  200 ttys010\n", "");
          return;
        }
      }
      if (cmd === "osascript") {
        const script = args.find((a) => typeof a === "string" && a.includes('tell application "Ghostty"')) || "";
        if (script.includes('tell application "Ghostty"') && script.includes("whose tty ends with")) {
          if (cb) cb(null, "unsupported-tty:-2753\n", "");
          return;
        }
        if (script.includes('tell application "Ghostty"') && script.includes("whose pid is")) {
          if (cb) cb(null, "unsupported-pid:-2753\n", "");
          return;
        }
        if (cb) cb(null, "miss-cwd\n", "");
        return;
      }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({ focusLog: (msg) => logs.push(msg) });
    focusTerminalWindow(11940, "/same/project", null, [200, 11940]);

    setTimeout(() => {
      cleanup();
      assert.ok(
        calls.some((c) => c.cmd === "osascript" && c.args.some((a) => typeof a === "string" && a.includes("on error errMsg number errNum"))),
        "Ghostty precise scripts should include AppleScript error capture"
      );
      assert.ok(
        logs.some((line) => line.includes("branch=ghostty reason=unsupported-tty:-2753")),
        `Should log best-effort tty unsupported status, got ${logs.join("\n")}`
      );
      assert.ok(
        logs.some((line) => line.includes("branch=ghostty reason=unsupported-pid:-2753")),
        `Should log best-effort pid unsupported status, got ${logs.join("\n")}`
      );
      assert.ok(
        logs.some((line) => line.includes("branch=ghostty reason=cwd-fallback")),
        `Should still fall back to cwd after unsupported precise paths, got ${logs.join("\n")}`
      );
      done();
    }, 2400);
  });

  it("does not dispatch Ghostty AppleScript when source process is not ghostty", (t, done) => {
    const calls = [];
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cmd === "ps" && args.join(" ").includes("comm=")) {
        if (cb) cb(null, commLine("iTerm2"), "");
        return;
      }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(11940, "/some/cwd", null, [11940]);

    setTimeout(() => {
      cleanup();
      const ghosttyScript = calls
        .filter((c) => c.cmd === "osascript")
        .find((c) => c.args.some((a) => typeof a === "string" && a.includes('tell application "Ghostty"')));
      assert.ok(!ghosttyScript, "Should not run Ghostty AppleScript when source is iTerm2");
      done();
    }, 1500);
  });
});
