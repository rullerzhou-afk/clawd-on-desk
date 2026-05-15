"use strict";

// This file mocks process.platform while loading src/focus; keep those mocks contained here.
const { describe, it } = require("node:test");
const assert = require("node:assert");

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

      assert.match(cmd, /Get-Process -Name 'WindowsTerminal'/);
      assert.doesNotMatch(cmd, /Select-Object -First 1/);
    } finally {
      cleanup();
    }
  });

  it("keeps direct parent-window focus for non-WindowsTerminal processes with cwd", () => {
    const { initFocus, cleanup } = loadFocusWithMock();
    try {
      const focus = initFocus({});
      const cmd = focus.__test.makeFocusCmd(1234, ["repo"]);

      assert.match(cmd, /FindByPidTitles/);
      assert.match(cmd, /\[WinFocus\]::Focus\(\$proc\.MainWindowHandle\)/);
      assert.match(cmd, /parent-direct/);
      assert.match(cmd, /WindowsTerminal/);
    } finally {
      cleanup();
    }
  });

  it("requires unique title matches for Windows Terminal parent and fallback windows", () => {
    const { initFocus, cleanup } = loadFocusWithMock();
    try {
      const focus = initFocus({});
      const cmd = focus.__test.makeFocusCmd(1234, ["repo"]);

      assert.match(cmd, /wt-parent-title-match/);
      assert.match(cmd, /wt-parent-title-ambiguous/);
      assert.doesNotMatch(cmd, /wt-parent-title-mismatch/);
      assert.match(cmd, /wt-parent-direct-fallback/);
      assert.match(cmd, /\$wtMatches = @\(\)/);
      assert.match(cmd, /\$wtMatches\.Count -eq 1/);
      assert.match(cmd, /wt-title-match/);
      assert.match(cmd, /wt-title-ambiguous/);
      assert.match(cmd, /wt-title-mismatch/);
    } finally {
      cleanup();
    }
  });

  it("reports Windows helper results through stdout instead of writing logs directly", () => {
    const { initFocus, cleanup } = loadFocusWithMock();
    try {
      const focus = initFocus({});
      const cmd = focus.__test.makeFocusCmd(1234, ["repo"]);
      const helperScript = focus.__test.PS_FOCUS_ADDTYPE;

      assert.match(cmd, /Write-ClawdFocusResult/);
      assert.match(helperScript, /__CLAWD_FOCUS_RESULT__/);
      assert.doesNotMatch(cmd, /Add-Content/);
      assert.doesNotMatch(helperScript, /Add-Content/);
      assert.doesNotMatch(cmd, /focus-debug\.log/);
      assert.doesNotMatch(helperScript, /focus-debug\.log/);
    } finally {
      cleanup();
    }
  });

  it("tries the attached console HWND when a PowerShell process has no main window", () => {
    const { initFocus, cleanup } = loadFocusWithMock();
    try {
      const focus = initFocus({});
      const cmd = focus.__test.makeFocusCmd(1234, ["repo"]);
      const helperScript = focus.__test.PS_FOCUS_ADDTYPE;

      assert.match(helperScript, /AttachConsole/);
      assert.match(helperScript, /GetConsoleWindow/);
      assert.match(helperScript, /FindConsoleWindowForPid/);
      assert.match(cmd, /FindConsoleWindowForPid\(\[uint32\]\$curPid\)/);
      assert.match(cmd, /reason = 'console-window'/);
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
      assert.match(joined, /focus result branch=windows-dispatched/);
      assert.match(joined, /focus result branch=windows-helper reason=parent-direct/);
      assert.ok(!joined.includes("C:\\Users\\SecretUser"), "full cwd must not be logged");
      assert.ok(!joined.includes("SecretUser"), "username must not be logged through cwd tail");
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
