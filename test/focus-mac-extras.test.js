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
    const { initFocus, cleanup } = loadFocusWithMock(function mockExecFile(cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cmd === "ps" && args.join(" ").includes("comm=")) {
        if (cb) cb(null, commLine("ghostty"), "");
        return;
      }
      if (cmd === "osascript") {
        if (cb) cb(null, "", "");
        return;
      }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({});
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
      done();
    }, 1500);
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
