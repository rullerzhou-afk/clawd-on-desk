// test/focus-cmux.test.js — Tests for cmux panel-level focus switching
const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { loadFocusWithMock } = require("./helpers/load-focus-with-mock");

const CMUX_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";

function writeMockSessionFile(workspaces, bundleId = "com.cmuxterm.app") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-test-"));
  const cmuxDir = path.join(tmpDir, "Library/Application Support/cmux");
  fs.mkdirSync(cmuxDir, { recursive: true });
  const sessionPath = path.join(cmuxDir, `session-${bundleId}.json`);
  const sessionData = {
    windows: [{
      tabManager: { selectedWorkspaceIndex: 0, workspaces }
    }]
  };
  fs.writeFileSync(sessionPath, JSON.stringify(sessionData));
  return { tmpDir, cmuxDir, sessionPath, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

function mockExecFileForCmux(opts = {}) {
  const { ttyOutput, commOutput, osascriptSucceeds = true } = opts;
  const calls = [];
  const mock = function (cmd, args, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = {}; }
    calls.push({ cmd, args: [...args] });
    if (cmd === "osascript") {
      if (osascriptSucceeds) { if (cb) cb(null, "", ""); }
      else { if (cb) cb(new Error("osascript failed"), "", ""); }
      return;
    }
    if (cmd === "ps") {
      const a = args.join(" ");
      if (a.includes("comm=")) {
        if (cb) cb(null, commOutput || "501 /bin/zsh\n502 /Applications/cmux.app/Contents/MacOS/cmux\n", "");
        return;
      }
      if (a.includes("tty=")) {
        if (cb) cb(null, ttyOutput || "501 ttys007\n", "");
        return;
      }
    }
    if (cb) cb(null, "", "");
  };
  return { calls, mock };
}

describe("cmux panel focus (macOS)", () => {

  // TDD Red 1: the core requirement — focus by panel UUID, not tab index
  it("should call cmux focus-panel with matched panel UUID", (t, done) => {
    const panelId = "18AA1EB5-3055-445C-B780-60C88B21341B";
    const { tmpDir, cleanup: cleanupFile } = writeMockSessionFile([{
      id: "ws-uuid-1",
      panels: [{ id: panelId, ttyName: "ttys007", type: "terminal" }]
    }]);
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;

    const calls = [];
    const mock = function (cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cmd === "osascript") { if (cb) cb(null, "", ""); return; }
      if (cmd === "ps") {
        const a = args.join(" ");
        if (a.includes("comm=")) {
          if (cb) cb(null, "501 /bin/zsh\n502 /Applications/cmux.app/Contents/MacOS/cmux\n", "");
          return;
        }
        if (a.includes("tty=")) {
          if (cb) cb(null, "501 ttys007\n", "");
          return;
        }
      }
      if (cb) cb(null, "", "");
    };

    const { initFocus, cleanup } = loadFocusWithMock(mock);
    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(501, "/test/cwd", null, [501, 502]);

    setTimeout(() => {
      cleanup();
      cleanupFile();
      process.env.HOME = origHome;

      const panelCall = calls.find(c =>
        c.cmd === CMUX_BIN &&
        c.args.includes("focus-panel")
      );
      assert.ok(panelCall, `Should call cmux focus-panel --panel <UUID>, got: ${JSON.stringify(calls.map(c => c.cmd))}`);

      const panelArgIdx = panelCall.args.indexOf("--panel");
      assert.ok(panelArgIdx >= 0, "Should have --panel flag");
      assert.strictEqual(panelCall.args[panelArgIdx + 1], panelId, "Should focus exact panel UUID");
      const workspaceArgIdx = panelCall.args.indexOf("--workspace");
      assert.ok(workspaceArgIdx >= 0, "Should pass --workspace so cmux does not rely on Clawd's environment");
      assert.strictEqual(panelCall.args[workspaceArgIdx + 1], "ws-uuid-1", "Should focus inside the matched workspace");

      done();
    }, 2500);
  });

  // TDD Red 2: fallback to select-workspace when focus-panel fails
  it("should call cmux select-workspace when focus-panel fails", (t, done) => {
    const panelId = "18AA1EB5-3055-445C-B780-60C88B21341B";
    const workspaceId = "ws-uuid-1";
    const { tmpDir, cleanup: cleanupFile } = writeMockSessionFile([{
      id: workspaceId,
      panels: [{ id: panelId, ttyName: "ttys007", type: "terminal" }]
    }]);
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;

    const calls = [];
    const mock = function (cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cmd === "osascript") { if (cb) cb(null, "", ""); return; }
      if (cmd === "ps") {
        const a = args.join(" ");
        if (a.includes("comm=")) {
          if (cb) cb(null, "501 /bin/zsh\n502 /Applications/cmux.app/Contents/MacOS/cmux\n", "");
          return;
        }
        if (a.includes("tty=")) {
          if (cb) cb(null, "501 ttys007\n", "");
          return;
        }
      }
      if (cmd === CMUX_BIN && args.join(" ").includes("focus-panel")) {
        if (cb) cb(new Error("focus-panel failed"), "", "");
        return;
      }
      if (cb) cb(null, "", "");
    };

    const { initFocus, cleanup } = loadFocusWithMock(mock);
    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(501, "/test/cwd", null, [501, 502]);

    setTimeout(() => {
      cleanup();
      cleanupFile();
      process.env.HOME = origHome;

      const wsCall = calls.find(c => c.cmd === CMUX_BIN && c.args.includes("select-workspace"));
      assert.ok(wsCall, "Should fallback to select-workspace when focus-panel fails");
      const wsArgIdx = wsCall.args.indexOf("--workspace");
      assert.strictEqual(wsCall.args[wsArgIdx + 1], workspaceId);

      done();
    }, 2500);
  });

  // TDD Red 3: multi-panel split workspace — must focus correct panel
  it("should handle multi-panel workspace (split) — focus correct panel", (t, done) => {
    const panel1Id = "panel-id-1";
    const panel2Id = "panel-id-2";
    const matchedTty = "ttys003";
    const { tmpDir, cleanup: cleanupFile } = writeMockSessionFile([{
      id: "ws-split",
      panels: [
        { id: panel1Id, ttyName: "ttys001", type: "terminal" },
        { id: panel2Id, ttyName: matchedTty, type: "terminal" }
      ]
    }]);
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;

    const calls = [];
    const mock = function (cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cmd === "osascript") { if (cb) cb(null, "", ""); return; }
      if (cmd === "ps") {
        const a = args.join(" ");
        if (a.includes("comm=")) {
          if (cb) cb(null, "501 /bin/zsh\n502 /Applications/cmux.app/Contents/MacOS/cmux\n", "");
          return;
        }
        if (a.includes("tty=")) {
          if (cb) cb(null, "501 ttys003\n", "");
          return;
        }
      }
      if (cb) cb(null, "", "");
    };

    const { initFocus, cleanup } = loadFocusWithMock(mock);
    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(501, "/test/cwd", null, [501, 502]);

    setTimeout(() => {
      cleanup();
      cleanupFile();
      process.env.HOME = origHome;

      const panelCall = calls.find(c => c.cmd === CMUX_BIN && c.args.includes("focus-panel"));
      assert.ok(panelCall, "Should call focus-panel for split workspace");

      const panelArgIdx = panelCall.args.indexOf("--panel");
      assert.strictEqual(panelCall.args[panelArgIdx + 1], panel2Id, "Should focus the matched panel (ttys003), not the first one");
      const workspaceArgIdx = panelCall.args.indexOf("--workspace");
      assert.strictEqual(panelCall.args[workspaceArgIdx + 1], "ws-split", "Should pass the matched workspace for split panel focus");

      done();
    }, 2500);
  });

  it("should search later cmux session files when the newest file has no matching TTY", (t, done) => {
    const panelId = "panel-in-older-session";
    const { tmpDir, cmuxDir, cleanup: cleanupFile } = writeMockSessionFile([{
      id: "newer-wrong-workspace",
      panels: [{ id: "wrong-panel", ttyName: "ttys001", type: "terminal" }]
    }], "newer");
    const olderSessionPath = path.join(cmuxDir, "session-older.json");
    fs.writeFileSync(olderSessionPath, JSON.stringify({
      windows: [{
        tabManager: {
          selectedWorkspaceIndex: 0,
          workspaces: [{
            id: "older-matched-workspace",
            panels: [{ id: panelId, ttyName: "ttys007", type: "terminal" }]
          }]
        }
      }]
    }));
    const now = Date.now() / 1000;
    fs.utimesSync(path.join(cmuxDir, "session-newer.json"), now, now);
    fs.utimesSync(olderSessionPath, now - 60, now - 60);

    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;

    const { calls, mock } = mockExecFileForCmux({ ttyOutput: "501 ttys007\n" });
    const { initFocus, cleanup } = loadFocusWithMock(mock);

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(501, "/test/cwd", null, [501, 502]);

    setTimeout(() => {
      cleanup();
      cleanupFile();
      process.env.HOME = origHome;

      const panelCall = calls.find(c => c.cmd === CMUX_BIN && c.args.includes("focus-panel"));
      assert.ok(panelCall, "Should call focus-panel after checking more than one session file");
      assert.strictEqual(panelCall.args[panelCall.args.indexOf("--panel") + 1], panelId);
      assert.strictEqual(panelCall.args[panelCall.args.indexOf("--workspace") + 1], "older-matched-workspace");

      done();
    }, 2500);
  });

  it("should NOT call cmux when no cmux process found in pidChain", (t, done) => {
    const { calls, mock } = mockExecFileForCmux({
      commOutput: "100 /bin/zsh\n200 /Applications/Terminal.app/Contents/MacOS/Terminal\n",
    });
    const { initFocus, cleanup } = loadFocusWithMock(mock);

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(100, "/test/cwd", null, [100, 200]);

    setTimeout(() => {
      cleanup();

      const osaCalls = calls.filter(c => c.cmd === "osascript");
      const cmuxOsa = osaCalls.find(c => c.args.some(a => a.includes("cmux")));
      assert.ok(!cmuxOsa, "Should NOT run cmux AppleScript when no cmux process found");

      done();
    }, 2000);
  });

  it("should not focus cmux when TTY not found in session file", (t, done) => {
    const { tmpDir, cleanup: cleanupFile } = writeMockSessionFile([
      { panels: [{ ttyName: "ttys001" }] },
    ]);
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;

    const { calls, mock } = mockExecFileForCmux({ ttyOutput: "501 ttys099\n" });
    const { initFocus, cleanup } = loadFocusWithMock(mock);

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(501, "/test/cwd", null, [501, 502]);

    setTimeout(() => {
      cleanup();
      cleanupFile();
      process.env.HOME = origHome;

      const osaCalls = calls.filter(c => c.cmd === "osascript");
      const cmuxOsa = osaCalls.find(c => c.args.some(a => a.includes("cmux")));
      assert.ok(!cmuxOsa, "Should NOT run cmux AppleScript when TTY not matched");

      done();
    }, 2000);
  });

  it("should skip cmux detection on non-macOS platforms", (t, done) => {
    const calls = [];
    const { initFocus, cleanup } = loadFocusWithMock(function (cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cb) cb(null, "", "");
    }, { platform: "linux" });

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(501, "/test/cwd", null, [501, 502]);

    setTimeout(() => {
      cleanup();

      const psCommCalls = calls.filter(c => c.cmd === "ps" && c.args.join(" ").includes("comm="));
      assert.strictEqual(psCommCalls.length, 0, "Should not call ps -o comm= on non-macOS");

      done();
    }, 1000);
  });

  it("should skip cmux detection when pidChain is empty", (t, done) => {
    const calls = [];
    const { initFocus, cleanup } = loadFocusWithMock(function (cmd, args, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      calls.push({ cmd, args: [...args] });
      if (cmd === "ps" && args.join(" ").includes("comm=")) {
        if (cb) cb(null, "cmux\n", "");
        return;
      }
      if (cb) cb(null, "", "");
    });

    const { focusTerminalWindow } = initFocus({});
    focusTerminalWindow(501, "/test/cwd", null, []);

    setTimeout(() => {
      cleanup();

      const cmuxScripts = calls
        .filter(c => c.cmd === "osascript")
        .filter(c => c.args.some(a => typeof a === "string" && a.includes("cmux")));
      assert.strictEqual(cmuxScripts.length, 0, "Should not dispatch cmux AppleScript with empty pidChain");

      done();
    }, 1000);
  });
});
