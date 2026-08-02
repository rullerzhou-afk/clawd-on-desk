"use strict";

// This file mocks process.platform while loading src/focus; keep those mocks contained here.
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

function loadFocusWithMock(options = {}) {
  const cpKey = require.resolve("child_process");
  const focusKey = require.resolve("../src/focus");
  const origCp = require.cache[cpKey];
  const origFocus = require.cache[focusKey];
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const realCp = require("child_process");
  const execFile = options.execFile || ((_cmd, _args, opts, cb) => {
    if (typeof opts === "function") cb = opts;
    if (cb) cb(null, "", "");
  });
  const spawn = options.spawn || (() => ({
    pid: 4242,
    stdin: {
      writable: true,
      write() {},
      on() {},
    },
    on() {},
    unref() {},
    kill() {},
  }));

  require.cache[cpKey] = {
    id: cpKey,
    filename: cpKey,
    loaded: true,
    exports: { ...realCp, execFile, spawn },
  };
  Object.defineProperty(process, "platform", {
    ...origPlatform,
    value: options.platform || "win32",
  });
  delete require.cache[focusKey];

  let initFocus;
  try {
    initFocus = require("../src/focus");
  } finally {
    Object.defineProperty(process, "platform", origPlatform);
  }

  if (origCp) require.cache[cpKey] = origCp;
  else delete require.cache[cpKey];

  return {
    initFocus,
    cleanup: () => {
      if (origFocus) require.cache[focusKey] = origFocus;
      else delete require.cache[focusKey];
    },
  };
}

describe("Windows terminal focus", () => {
  it("does not generate the blind first-WindowsTerminal fallback", () => {
    const { initFocus, cleanup } = loadFocusWithMock();
    try {
      const focus = initFocus({});
      const cmd = focus.__test.makeFocusCmd(1234, ["repo"]);

      assert.match(cmd, /Get-Process -Name \$wtName/);
      assert.doesNotMatch(cmd, /Select-Object -First 1/);
    } finally {
      cleanup();
    }
  });

  it("keeps direct parent-window focus for single-window processes with cwd", () => {
    const { initFocus, cleanup } = loadFocusWithMock();
    try {
      const focus = initFocus({});
      const cmd = focus.__test.makeFocusCmd(1234, ["repo"]);

      assert.match(cmd, /FindByPidTitles/);
      assert.match(cmd, /\[WinFocus\]::Focus\(\$proc\.MainWindowHandle\)/);
      assert.match(cmd, /parent-direct/);
      assert.match(cmd, /WindowsTerminal/);
      assert.match(cmd, /\$editorProcessNames = @\('Code', 'Cursor'\)/);
      assert.match(cmd, /editor-parent-title-match/);
      assert.match(cmd, /editor-parent-title-ambiguous/);
      assert.match(cmd, /editor-parent-no-title-match/);
      assert.match(cmd, /editor-parent-no-title/);
    } finally {
      cleanup();
    }
  });

  it("requires unique title matches for Windows Terminal parent and fallback windows", () => {
    const { initFocus, cleanup } = loadFocusWithMock();
    try {
      const focus = initFocus({});
      const cmd = focus.__test.makeFocusCmd(1234, ["repo"]);
      const helperScript = focus.__test.PS_FOCUS_ADDTYPE;

      assert.match(helperScript, /FindVisibleWindowsForPid/);
      assert.match(helperScript, /GetClassName/);
      assert.match(helperScript, /CASCADIA_HOSTING_WINDOW_CLASS/);
      assert.match(helperScript, /GetWindow\(hWnd, 4\)/);
      assert.match(helperScript, /terminalHostTitled\.Count > 0/);
      assert.match(helperScript, /unownedTitled\.Count > 0/);
      assert.match(helperScript, /titled\.Count > 0/);
      assert.doesNotMatch(helperScript, /skip owned helper\/pop-up windows/);
      assert.match(cmd, /Get-ClawdVisiblePidWindows/);
      assert.match(cmd, /Get-ClawdWindowsTerminalWindows/);
      assert.match(cmd, /\$chainWindowsTerminalPids/);
      assert.match(cmd, /wt-parent-title-match/);
      assert.match(cmd, /wt-parent-title-ambiguous/);
      assert.doesNotMatch(cmd, /wt-parent-title-mismatch/);
      assert.doesNotMatch(cmd, /wt-parent-direct-fallback/);
      assert.match(cmd, /wt-parent-pid-window/);
      assert.match(cmd, /wt-parent-pid-window-ambiguous/);
      assert.match(cmd, /wt-parent-no-pid-window/);
      assert.match(cmd, /\$wtMatches = @\(\)/);
      assert.match(cmd, /\$wtMatches\.Count -eq 1/);
      assert.match(cmd, /wt-title-match/);
      assert.match(cmd, /wt-title-ambiguous/);
      assert.match(cmd, /wt-title-mismatch-pid-window/);
      assert.match(cmd, /wt-title-mismatch-pid-window-ambiguous/);
      assert.match(cmd, /wt-title-mismatch-single-wt-window/);
      assert.match(cmd, /wt-title-mismatch-single-wt-window-ambiguous/);
      assert.match(cmd, /wt-title-mismatch-no-pid-window/);
    } finally {
      cleanup();
    }
  });

  it("reports Windows helper results through stdout instead of writing logs directly", () => {
    const { initFocus, cleanup } = loadFocusWithMock();
    try {
      const focus = initFocus({});
      const cmd = focus.__test.makeFocusCmd(1234, ["repo"], null, null, "tok-1");
      const helperScript = focus.__test.PS_FOCUS_ADDTYPE;

      assert.match(cmd, /Write-ClawdFocusResult/);
      assert.match(cmd, /\$focusToken = 'tok-1'/);
      assert.match(cmd, /\$selectedTargetHwnd = \[IntPtr\]::Zero/);
      assert.match(cmd, /GetForegroundWindow\(\)/);
      assert.match(cmd, /Start-Sleep -Milliseconds 25/);
      assert.match(helperScript, /__CLAWD_FOCUS_RESULT__/);
      assert.match(helperScript, /targetHwnd/);
      assert.match(helperScript, /foregroundHwnd/);
      assert.match(helperScript, /confirmed/);
      assert.doesNotMatch(cmd, /Add-Content/);
      assert.doesNotMatch(helperScript, /Add-Content/);
      assert.doesNotMatch(cmd, /focus-debug\.log/);
      assert.doesNotMatch(helperScript, /focus-debug\.log/);
    } finally {
      cleanup();
    }
  });

  it("caches successful Windows focus HWNDs by session key only with matching titles", () => {
    const { initFocus, cleanup } = loadFocusWithMock();
    try {
      const focus = initFocus({});
      const cmd = focus.__test.makeFocusCmd(1234, ["repo"], "claude-code|session-1");
      const helperScript = focus.__test.PS_FOCUS_ADDTYPE;

      assert.match(helperScript, /IsUsableWindow/);
      assert.match(cmd, /\$focusCacheKey = \(\[Text\.Encoding\]::UTF8\.GetString/);
      assert.match(cmd, /\$global:ClawdFocusWindowCache/);
      assert.match(cmd, /\$cacheTitleNames = @\(/);
      assert.match(cmd, /Test-ClawdWindowTitleMatch/);
      assert.match(cmd, /sourcePid = \$focusCacheSourcePid/);
      assert.match(cmd, /titleNames = @\(\$cacheTitleNames\)/);
      assert.match(cmd, /Get-ClawdCachedWindow/);
      assert.match(cmd, /reason = 'cached-window'/);
      assert.match(cmd, /Remove\(\$focusCacheKey\)/);
      assert.match(cmd, /Save-ClawdFocusCache \$matches\[0\]/);
      assert.match(cmd, /Save-ClawdFocusCache \$wtMatches\[0\]/);
      assert.match(cmd, /Save-ClawdFocusCache \$wtHwndFromHook/);
      assert.doesNotMatch(cmd, /Save-ClawdFocusCache \$pidWindows\[0\]/);
      assert.doesNotMatch(cmd, /Save-ClawdFocusCache \$singleWtWindows\[0\]/);
      assert.doesNotMatch(cmd, /Save-ClawdFocusCache \$pendingConsoleHwnd/);
    } finally {
      cleanup();
    }
  });

  it("focuses a hook-captured Windows Terminal HWND before guessing by title", () => {
    const { initFocus, cleanup } = loadFocusWithMock();
    try {
      const focus = initFocus({});
      const cmd = focus.__test.makeFocusCmd(1234, ["repo"], "claude-code|session-1", "123456");
      const helperScript = focus.__test.PS_FOCUS_ADDTYPE;

      assert.match(helperScript, /IsUsableWindowsTerminalWindow/);
      assert.match(cmd, /\$wtHwndFromHook = \[IntPtr\]\(\[int64\]123456\)/);
      assert.match(cmd, /IsUsableWindowsTerminalWindow\(\$wtHwndFromHook\)/);
      assert.match(cmd, /Save-ClawdFocusCache \$wtHwndFromHook/);
      assert.match(cmd, /reason = 'wt-hwnd-from-hook'/);
      assert.ok(cmd.indexOf("reason = 'wt-hwnd-from-hook'") < cmd.indexOf("for ($i = 0; $i -lt 8; $i++)"));
    } finally {
      cleanup();
    }
  });

  it("adds agent title candidates for Windows Terminal matching", () => {
    const { initFocus, cleanup } = loadFocusWithMock();
    try {
      const focus = initFocus({});

      assert.deepStrictEqual(
        focus.__test.buildWindowsTitleCandidates({ agentId: "claude-code" }, ["repo"]),
        ["repo", "Claude Code", "Claude"]
      );
      assert.deepStrictEqual(
        focus.__test.buildWindowsTitleCandidates({ agentId: "codex" }, ["cc-connect-codex"]),
        ["cc-connect-codex", "codex"]
      );
      assert.deepStrictEqual(
        focus.__test.buildWindowsTitleCandidates({ agentId: "claude-code" }, ["Claude"]),
        ["Claude", "Claude Code"]
      );
    } finally {
      cleanup();
    }
  });

  it("only focuses attached legacy conhost windows, not ConPTY shim windows", () => {
    const { initFocus, cleanup } = loadFocusWithMock();
    try {
      const focus = initFocus({});
      const cmd = focus.__test.makeFocusCmd(1234, ["repo"]);
      const helperScript = focus.__test.PS_FOCUS_ADDTYPE;

      assert.match(helperScript, /AttachConsole/);
      assert.match(helperScript, /GetConsoleWindow/);
      assert.match(helperScript, /FindConsoleWindowForPid/);
      assert.match(helperScript, /IsLegacyConsoleWindow/);
      assert.match(cmd, /FindConsoleWindowForPid\(\[uint32\]\$curPid\)/);
      assert.match(cmd, /\$pendingConsoleHwnd = \[IntPtr\]::Zero/);
      assert.match(cmd, /\$consoleShimSkipped = \$false/);
      assert.match(cmd, /IsLegacyConsoleWindow\(\$consoleHwnd\)/);
      assert.match(cmd, /\$pendingConsoleHwnd = \$consoleHwnd/);
      assert.match(cmd, /wt-title-mismatch-single-wt-window-ambiguous/);
      assert.match(cmd, /wt-title-mismatch-pid-window-ambiguous/);
      assert.match(cmd, /wt-title-mismatch-no-pid-window/);
      assert.match(cmd, /wt-parent-title-ambiguous/);
      assert.match(cmd, /reason = 'legacy-conhost-window'/);
      assert.match(cmd, /reason = 'console-window-shim-skip'/);
      assert.doesNotMatch(cmd, /reason = 'console-window'/);
    } finally {
      cleanup();
    }
  });

  it("caps CIM parent-process lookup time in the Windows focus helper", () => {
    const { initFocus, cleanup } = loadFocusWithMock();
    try {
      const focus = initFocus({});
      const cmd = focus.__test.makeFocusCmd(1234, ["repo"]);

      assert.match(cmd, /Get-CimInstance Win32_Process -Filter "ProcessId=\$curPid" -OperationTimeoutSec 2/);
    } finally {
      cleanup();
    }
  });

  it("logs Windows helper stdout through Node focus logging", () => {
    const logs = [];
    const { initFocus, cleanup } = loadFocusWithMock();
    try {
      const focus = initFocus({ focusLog: (msg) => logs.push(msg) });
      focus.__test.handleFocusHelperCompleteOutput("noise\n__CLAWD_FOCUS_RESULT__ parent-direct\n");

      assert.match(logs.join("\n"), /focus result branch=windows-helper reason=parent-direct/);
    } finally {
      cleanup();
    }
  });

  it("confirms foreground only for positive reasons with matching HWNDs", () => {
    const { initFocus, cleanup } = loadFocusWithMock();
    try {
      const focus = initFocus({});
      const { confirmForeground } = focus.__test;

      assert.equal(confirmForeground(
        { reason: "parent-direct", targetHwnd: "1001", foregroundHwnd: "1001" },
        { hwnd: "1001" }
      ), true);
      assert.equal(confirmForeground(
        { reason: "editor-parent-title-match", targetHwnd: "1002", foregroundHwnd: "1002" },
        { hwnd: "1002" }
      ), true);
      assert.equal(confirmForeground(
        { reason: "parent-direct", targetHwnd: "1001", foregroundHwnd: "2002" },
        { hwnd: "1001" }
      ), false);
      assert.equal(confirmForeground(
        { reason: "wt-title-ambiguous", targetHwnd: "1001", foregroundHwnd: "1001" },
        { hwnd: "1001" }
      ), false);
      assert.equal(confirmForeground(
        { reason: "wt-hwnd-from-hook", targetHwnd: "3003", foregroundHwnd: "3003" },
        { type: "windows-terminal", hwnd: "3003" }
      ), false);
      assert.equal(confirmForeground(
        { reason: "wt-parent-pid-window", targetHwnd: "4004", foregroundHwnd: "4004" },
        { type: "pid-window", hwnd: "4004" }
      ), false);
      assert.equal(confirmForeground(
        { reason: "wt-title-match", targetHwnd: "5005", foregroundHwnd: "5005" },
        { type: "windows-terminal", hwnd: "5005" }
      ), true);
      assert.equal(confirmForeground(
        { reason: "wt-parent-title-match", targetHwnd: "6006", foregroundHwnd: "6006" },
        { type: "windows-terminal", hwnd: "6006" }
      ), true);
      assert.equal(confirmForeground(
        { reason: "parent-direct", targetHwnd: "7007", foregroundHwnd: null },
        { hwnd: "7007" }
      ), false);
      assert.equal(confirmForeground(
        { reason: "parent-direct", targetHwnd: null, foregroundHwnd: "8008" },
        { hwnd: null }
      ), false);
    } finally {
      cleanup();
    }
  });

  it("enables the Orca gate in the generated script when the request carries a pane key", () => {
    const writes = [];
    const stdout = new EventEmitter();
    stdout.setEncoding = () => {};
    stdout.unref = () => {};
    const { initFocus, cleanup } = loadFocusWithMock({
      spawn: () => ({
        pid: 9998,
        stdin: {
          writable: true,
          write: (chunk) => writes.push(String(chunk)),
          on() {},
        },
        stdout,
        on() {},
        unref() {},
        kill() {},
      }),
    });

    try {
      const focus = initFocus({ focusLog: () => {} });
      focus.initFocusHelper();
      writes.length = 0;

      focus.focusTerminalWindow({
        sourcePid: 1111,
        cwd: "D:\\repo-a",
        sessionId: "session-orca",
        agentId: "claude-code",
        orcaPaneKey: "8ce1fff7-tab:9813824b-leaf",
      });
      // orcaHosted is makeFocusCmd's 7th positional argument, and both array
      // arguments are in scope at the call site — drop one and the gate silently
      // becomes $false, re-opening the window cache and the incidental wt_hwnd
      // that this branch exists to outrank, with the wrong window reported as a
      // confirmed focus.
      assert.match(writes.join(""), /\$orcaHosted = \$true/);

      writes.length = 0;
      focus.focusTerminalWindow({
        sourcePid: 2222,
        cwd: "D:\\repo-b",
        sessionId: "session-plain",
        agentId: "claude-code",
      });
      assert.match(writes.join(""), /\$orcaHosted = \$false/);
    } finally {
      cleanup();
    }
  });

  it("raises and switches an Orca-managed SSH pane without a local source PID", async () => {
    const calls = [];
    const writes = [];
    const stdout = new EventEmitter();
    stdout.setEncoding = () => {};
    stdout.unref = () => {};
    const { initFocus, cleanup } = loadFocusWithMock({
      execFile: (cmd, args, opts, cb) => {
        if (typeof opts === "function") cb = opts;
        calls.push({ cmd, args: [...(args || [])] });
        const joined = (args || []).join(" ");
        if (joined.startsWith("terminal list")) {
          return cb(null, JSON.stringify({
            ok: true,
            result: { terminals: [{ handle: "term_remote", tabId: "tab-remote", leafId: "leaf-remote" }] },
          }), "");
        }
        if (joined.startsWith("terminal switch")) return cb(null, JSON.stringify({ ok: true }), "");
        return cb(null, "", "");
      },
      spawn: () => ({
        pid: 9996,
        stdin: { writable: true, write: (chunk) => writes.push(String(chunk)), on() {} },
        stdout,
        on() {},
        unref() {},
        kill() {},
      }),
    });

    try {
      const focus = initFocus({ focusLog: () => {} });
      focus.initFocusHelper();
      writes.length = 0;
      focus.focusTerminalWindow({
        cwd: "/remote/worktree",
        sessionId: "remote:session-orca-win",
        agentId: "codex",
        orcaPaneKey: "tab-remote:leaf-remote",
      });
      await new Promise((resolve) => setTimeout(resolve, focus.__test.ORCA_PANE_FOCUS_DELAY_MS + 250));

      assert.match(writes.join(""), /\$orcaHosted = \$true/);
      assert.match(writes.join(""), /\$focusCacheSourcePid = \[int64\]0/);
      assert.equal(calls.filter((c) => c.args.join(" ").startsWith("terminal switch")).length, 1);
    } finally {
      cleanup();
    }
  });

  it("reaches the Orca pane switch from the Windows focus dispatch", async () => {
    const calls = [];
    const stdout = new EventEmitter();
    stdout.setEncoding = () => {};
    stdout.unref = () => {};
    const { initFocus, cleanup } = loadFocusWithMock({
      execFile: (cmd, args, opts, cb) => {
        if (typeof opts === "function") cb = opts;
        calls.push({ cmd, args: [...(args || [])] });
        const joined = (args || []).join(" ");
        if (joined.startsWith("terminal list")) {
          return cb(null, JSON.stringify({
            ok: true,
            result: { terminals: [{ handle: "term_live", tabId: "8ce1fff7-tab", leafId: "9813824b-leaf" }] },
          }), "");
        }
        if (joined.startsWith("terminal switch")) return cb(null, JSON.stringify({ ok: true }), "");
        return cb(null, "", "");
      },
      spawn: () => ({
        pid: 9997,
        stdin: { writable: true, write() {}, on() {} },
        stdout,
        on() {},
        unref() {},
        kill() {},
      }),
    });

    try {
      const focus = initFocus({ focusLog: () => {} });
      focus.initFocusHelper();
      focus.focusTerminalWindow({
        sourcePid: 3333,
        cwd: "D:\\Repos\\Apps\\clawd-on-desk",
        sessionId: "session-orca-switch",
        agentId: "claude-code",
        orcaPaneKey: "8ce1fff7-tab:9813824b-leaf",
      });
      // The switch sits behind a timer, so this has to wait it out. Asserting only
      // the generated script text leaves the Windows dispatch line free to be
      // deleted with the whole suite still green: the window would rise and the tab
      // would never change.
      await new Promise((r) => setTimeout(r, focus.__test.ORCA_PANE_FOCUS_DELAY_MS + 250));

      const switches = calls.filter((c) => c.args.join(" ").startsWith("terminal switch"));
      assert.equal(switches.length, 1);
      assert.deepEqual(switches[0].args, ["terminal", "switch", "--terminal", "term_live", "--json"]);
      // Windows raises inside the generated script, so Node must spawn no raise.
      assert.deepEqual(
        calls.filter((c) => ["/usr/bin/open", "wmctrl", "xdotool"].includes(c.cmd)),
        []
      );
    } finally {
      cleanup();
    }
  });

  it("holds the focus result until the Orca pane switch has answered", async () => {
    // Telegram Direct Send acts on this promise. Resolving it on the raise alone
    // let it press Ctrl+V while the switch was still in flight, so the reply landed
    // in whichever pane was previously active and was still reported as delivered.
    const stdout = new EventEmitter();
    stdout.setEncoding = () => {};
    stdout.unref = () => {};
    let releaseSwitch = null;
    const writes = [];
    const { initFocus, cleanup } = loadFocusWithMock({
      execFile: (cmd, args, opts, cb) => {
        if (typeof opts === "function") cb = opts;
        const joined = (args || []).join(" ");
        if (joined.startsWith("terminal list")) {
          return cb(null, JSON.stringify({
            ok: true,
            result: { terminals: [{ handle: "term_live", tabId: "8ce1fff7-tab", leafId: "9813824b-leaf" }] },
          }), "");
        }
        // Held open so the raise can be confirmed first — the exact ordering the
        // race depends on.
        if (joined.startsWith("terminal switch")) {
          releaseSwitch = () => cb(null, JSON.stringify({ ok: true }), "");
          return;
        }
        return cb(null, "", "");
      },
      spawn: () => ({
        pid: 9996,
        stdin: { writable: true, write: (chunk) => writes.push(String(chunk)), on() {} },
        stdout,
        on() {},
        unref() {},
        kill() {},
      }),
    });

    try {
      const focus = initFocus({ focusLog: () => {} });
      focus.initFocusHelper();
      writes.length = 0;

      const pending = focus.focusTerminalWindow({
        sourcePid: 3333,
        cwd: "D:\\Repos\\Apps\\clawd-on-desk",
        sessionId: "session-orca-gate",
        agentId: "claude-code",
        orcaPaneKey: "8ce1fff7-tab:9813824b-leaf",
        requestSource: "telegram-direct-send",
      });
      const token = writes[0].match(/\$focusToken = '([^']+)'/)[1];
      stdout.emit("data", `__CLAWD_FOCUS_RESULT__ {"token":"${token}","reason":"orca-window","targetHwnd":"787468","foregroundHwnd":"787468","confirmed":true,"status":"confirmed"}\n`);

      let settledEarly = false;
      pending.then(() => { settledEarly = true; });
      await new Promise((r) => setTimeout(r, focus.__test.ORCA_PANE_FOCUS_DELAY_MS + 150));
      assert.equal(settledEarly, false, "the raise alone must not settle the focus result");

      assert.ok(releaseSwitch, "the pane switch should have been dispatched");
      releaseSwitch();
      const result = await pending;
      assert.equal(result.confirmed, true);
      assert.deepEqual(result.orcaPane, { ok: true, match: "exact", reason: "orca-pane-switched" });
    } finally {
      cleanup();
    }
  });

  it("does not make non-Orca sessions wait on a pane switch", async () => {
    const stdout = new EventEmitter();
    stdout.setEncoding = () => {};
    stdout.unref = () => {};
    const writes = [];
    const { initFocus, cleanup } = loadFocusWithMock({
      spawn: () => ({
        pid: 9995,
        stdin: { writable: true, write: (chunk) => writes.push(String(chunk)), on() {} },
        stdout,
        on() {},
        unref() {},
        kill() {},
      }),
    });

    try {
      const focus = initFocus({ focusLog: () => {} });
      focus.initFocusHelper();
      writes.length = 0;

      const pending = focus.focusTerminalWindow({
        sourcePid: 4444,
        cwd: "D:\\Repos\\Apps\\clawd-on-desk",
        sessionId: "session-plain",
        agentId: "claude-code",
        requestSource: "telegram-direct-send",
      });
      const token = writes[0].match(/\$focusToken = '([^']+)'/)[1];
      stdout.emit("data", `__CLAWD_FOCUS_RESULT__ {"token":"${token}","reason":"parent-direct","targetHwnd":"111","foregroundHwnd":"111","confirmed":true,"status":"confirmed"}\n`);

      const result = await pending;
      assert.equal(result.confirmed, true);
      assert.equal(result.orcaPane, undefined);
    } finally {
      cleanup();
    }
  });

  it("correlates concurrent Windows helper results by token", async () => {
    const writes = [];
    const logs = [];
    const stdout = new EventEmitter();
    stdout.setEncoding = () => {};
    stdout.unref = () => {};
    const { initFocus, cleanup } = loadFocusWithMock({
      spawn: () => ({
        pid: 9999,
        stdin: {
          writable: true,
          write: (chunk) => writes.push(String(chunk)),
          on() {},
        },
        stdout,
        on() {},
        unref() {},
        kill() {},
      }),
    });

    try {
      const focus = initFocus({ focusLog: (msg) => logs.push(msg) });
      focus.initFocusHelper();
      writes.length = 0;

      const first = focus.focusTerminalWindow({
        sourcePid: 1111,
        cwd: "D:\\repo-a",
        sessionId: "session-a",
        agentId: "claude-code",
        requestSource: "telegram-direct-send",
      });
      const second = focus.focusTerminalWindow({
        sourcePid: 2222,
        cwd: "D:\\repo-b",
        sessionId: "session-b",
        agentId: "claude-code",
        requestSource: "telegram-direct-send",
      });

      assert.equal(writes.length, 2);
      const tokenA = writes[0].match(/\$focusToken = '([^']+)'/)[1];
      const tokenB = writes[1].match(/\$focusToken = '([^']+)'/)[1];
      assert.notEqual(tokenA, tokenB);

      stdout.emit("data", `__CLAWD_FOCUS_RESULT__ {"token":"${tokenB}","reason":"parent-direct","targetHwnd":"222","foregroundHwnd":"222","confirmed":true,"status":"confirmed"}\n`);
      const secondResult = await second;
      assert.equal(secondResult.token, tokenB);
      assert.equal(secondResult.confirmed, true);
      assert.equal(secondResult.targetHwnd, "222");

      stdout.emit("data", `__CLAWD_FOCUS_RESULT__ {"token":"${tokenA}","reason":"wt-title-ambiguous","targetHwnd":"111","foregroundHwnd":"111","confirmed":true,"status":"confirmed"}\n`);
      const firstResult = await first;
      assert.equal(firstResult.token, tokenA);
      assert.equal(firstResult.confirmed, false);
      assert.equal(firstResult.reason, "wt-title-ambiguous");
      assert.match(logs.join("\n"), new RegExp(`token=${tokenB}`));
      assert.match(logs.join("\n"), new RegExp(`token=${tokenA}`));
    } finally {
      cleanup();
    }
  });

  it("accepts options-object requests and redacts full cwd in focus logs", () => {
    const execCalls = [];
    const writes = [];
    const logs = [];
    const { initFocus, cleanup } = loadFocusWithMock({
      execFile: (cmd, args, opts, cb) => {
        if (typeof opts === "function") cb = opts;
        execCalls.push({ cmd, args: [...args] });
        if (cb) cb(null, "__CLAWD_FOCUS_RESULT__ parent-direct\n", "");
      },
      spawn: () => ({
        pid: 9999,
        stdin: {
          writable: true,
          write: (chunk) => writes.push(String(chunk)),
          on() {},
        },
        on() {},
        unref() {},
        kill() {},
      }),
    });

    try {
      const focus = initFocus({ focusLog: (msg) => logs.push(msg) });
      focus.focusTerminalWindow({
        sourcePid: 1234,
        cwd: "C:\\Users\\SecretUser\\project-a",
        editor: null,
        pidChain: [1234, 5678],
        wtHwnd: "98765",
        sessionId: "session-1",
        agentId: "claude-code",
        requestSource: "hud",
      });

      assert.strictEqual(execCalls[0].cmd, "powershell.exe");
      assert.ok(writes.length > 0, "fallback should reinitialize the persistent helper");
      const joined = logs.join("\n");
      assert.match(joined, /focus request/);
      assert.match(joined, /source=hud/);
      assert.match(joined, /sid=session-1/);
      assert.match(joined, /agent=claude-code/);
      assert.match(joined, /sourcePid=1234/);
      assert.match(joined, /cwdTail=\.\.\.\\project-a/);
      assert.match(joined, /cwdHash=[0-9a-f]{8}/);
      assert.match(joined, /chain=\[1234>5678\]/);
      assert.match(joined, /wtHwnd=1/);
      assert.match(joined, /focus result branch=windows-dispatched/);
      assert.match(joined, /focus result branch=windows-helper reason=parent-direct/);
      assert.ok(!joined.includes("C:\\Users\\SecretUser"), "full cwd must not be logged");
      assert.ok(!joined.includes("SecretUser"), "username must not be logged through cwd tail");
    } finally {
      cleanup();
    }
  });

  it("drops rapid duplicate Windows focus requests for the same session", () => {
    const writes = [];
    const logs = [];
    const { initFocus, cleanup } = loadFocusWithMock({
      spawn: () => ({
        pid: 9999,
        stdin: {
          writable: true,
          write: (chunk) => writes.push(String(chunk)),
          on() {},
        },
        stdout: {
          setEncoding() {},
          on() {},
          unref() {},
        },
        on() {},
        unref() {},
        kill() {},
      }),
    });

    try {
      const focus = initFocus({ focusLog: (msg) => logs.push(msg) });
      focus.initFocusHelper();
      writes.length = 0;
      focus.focusTerminalWindow({
        sourcePid: 1234,
        cwd: "D:\\repo",
        sessionId: "session-1",
        agentId: "claude-code",
        requestSource: "hud",
      });
      focus.focusTerminalWindow({
        sourcePid: 1234,
        cwd: "D:\\repo",
        sessionId: "session-1",
        agentId: "claude-code",
        requestSource: "hud",
      });

      assert.strictEqual(writes.length, 1);
      assert.match(logs.join("\n"), /focus result branch=windows reason=dropped-duplicate/);
    } finally {
      cleanup();
    }
  });

  it("keeps old positional focus requests compatible", () => {
    const execCalls = [];
    const { initFocus, cleanup } = loadFocusWithMock({
      execFile: (cmd, args, opts, cb) => {
        if (typeof opts === "function") cb = opts;
        execCalls.push({ cmd, args: [...args] });
        if (cb) cb(null, "", "");
      },
    });

    try {
      const focus = initFocus({});
      focus.focusTerminalWindow(2345, "D:\\work\\repo-b", null, [2345]);

      assert.strictEqual(execCalls.length, 1);
      assert.strictEqual(execCalls[0].cmd, "powershell.exe");
      assert.ok(execCalls[0].args.some((arg) => typeof arg === "string" && arg.includes("$curPid = 2345")));
    } finally {
      cleanup();
    }
  });

  it("logs non-Windows focus dispatch results without implying success", () => {
    const macLogs = [];
    const mac = loadFocusWithMock({ platform: "darwin" });
    try {
      const focus = mac.initFocus({ focusLog: (msg) => macLogs.push(msg) });
      focus.focusTerminalWindow({ sourcePid: 3456, requestSource: "hud" });

      assert.match(macLogs.join("\n"), /focus result branch=mac reason=submitted/);
    } finally {
      mac.cleanup();
    }

    const linuxLogs = [];
    const linux = loadFocusWithMock({ platform: "linux" });
    try {
      const focus = linux.initFocus({ focusLog: (msg) => linuxLogs.push(msg) });
      focus.focusTerminalWindow({ sourcePid: 4567, requestSource: "hud" });

      assert.match(linuxLogs.join("\n"), /focus result branch=linux-command-submitted/);
    } finally {
      linux.cleanup();
    }
  });
});
