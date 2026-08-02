const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const childProcess = require("child_process");
const themeLoader = require("../src/theme-loader");
const { createTranslator } = require("../src/i18n");

themeLoader.init(path.join(__dirname, "..", "src"));
const defaultTheme = themeLoader.loadTheme("clawd");

function makeCtx(overrides = {}) {
  const ctx = {
    lang: "en",
    theme: defaultTheme,
    doNotDisturb: false,
    miniTransitioning: false,
    miniMode: false,
    mouseOverPet: false,
    idlePaused: false,
    forceEyeResend: false,
    eyePauseUntil: 0,
    mouseStillSince: Date.now(),
    miniSleepPeeked: false,
    playSound: () => {},
    sendToRenderer: () => {},
    syncHitWin: () => {},
    sendToHitWin: () => {},
    miniPeekIn: () => {},
    miniPeekOut: () => {},
    buildContextMenu: () => {},
    buildTrayMenu: () => {},
    pendingPermissions: [],
    resolvePermissionEntry: () => {},
    focusTerminalWindow: () => {},
    processKill: () => { const e = new Error("ESRCH"); e.code = "ESRCH"; throw e; },
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    ...overrides,
  };
  ctx.t = createTranslator(() => ctx.lang);
  return ctx;
}

describe("detectRunningAgentProcesses() agent coverage", () => {
  let api;
  let originalExec;
  let originalExecFile;
  let originalPlatform;

  beforeEach(() => {
    originalExec = childProcess.exec;
    originalExecFile = childProcess.execFile;
    originalPlatform = process.platform;
    api = require("../src/state")(makeCtx());
  });

  afterEach(() => {
    childProcess.exec = originalExec;
    childProcess.execFile = originalExecFile;
    Object.defineProperty(process, "platform", { value: originalPlatform });
    api.cleanup();
  });

  it("builds the Windows query from the explicit conservative roster", async () => {
    let seenFile = "";
    let seenScript = "";
    childProcess.execFile = (file, args, opts, cb) => {
      seenFile = file;
      seenScript = args[args.length - 1];
      cb(null, "12345");
    };
    Object.defineProperty(process, "platform", { value: "win32" });

    const found = await new Promise((resolve) => {
      api.detectRunningAgentProcesses((result) => resolve(result));
    });

    assert.strictEqual(found, true);
    assert.strictEqual(seenFile, "powershell.exe");
    assert.match(seenScript, /'agy\.exe'/);
    assert.match(seenScript, /'kimi\.exe'/);
    assert.match(seenScript, /'codewhale\.exe'/);
    assert.match(seenScript, /'qwen\.exe'/);
    assert.match(seenScript, /'mimo\.exe'/);
    assert.match(seenScript, /'pi\.exe'/);
    assert.match(seenScript, /'qodercli\.exe'/);
    assert.match(seenScript, /'qoder-cli\.exe'/);
    // Conservative: only the Qoder CLI counts as active agent work. The IDE
    // process (qoder.exe) must NOT trigger startup recovery.
    assert.doesNotMatch(seenScript, /'qoder\.exe'/);
    assert.doesNotMatch(seenScript, /'cursor\.exe'/);
    assert.doesNotMatch(seenScript, /'qoderwork\.exe'/);
    assert.doesNotMatch(seenScript, /'workbuddy\.exe'/);
    assert.match(seenScript, /Get-CimInstance Win32_Process/);
    assert.match(seenScript, /-Filter/);
    assert.doesNotMatch(seenScript, /Win32_Process \| Where-Object/);
    assert.match(
      seenScript,
      /\$nodeNeedles = @\('claude-code','codex','copilot','codebuddy','kimi-code','zcode\.cjs'\)/
    );
    // zcode.cjs is matched against the ZCode.exe desktop shell (not node.exe),
    // so the per-needle host-name array carries zcode.exe in the same position.
    assert.match(
      seenScript,
      /\$nodeNeedleNames = @\('node\.exe','node\.exe','node\.exe','node\.exe','node\.exe','zcode\.exe'\)/
    );
  });

  it("emits a name+cmdline joint filter for the ZCode Windows shell", async () => {
    // ZCode's Windows runtime is the desktop shell ZCode.exe running zcode.cjs;
    // only the cmdline token disambiguates it. The WQL must pair the two, not
    // match the bare shell (which would mis-credit the always-running app).
    api.cleanup();
    api = require("../src/state")(makeCtx({
      hasAnyEnabledAgent: () => true,
      isAgentEnabled: (agentId) => agentId === "zcode",
    }));
    let seenScript = "";
    childProcess.execFile = (file, args, opts, cb) => {
      seenScript = args[args.length - 1];
      cb(null, "12345");
    };
    Object.defineProperty(process, "platform", { value: "win32" });

    const found = await new Promise((resolve) => {
      api.detectRunningAgentProcesses((result) => resolve(result));
    });

    assert.strictEqual(found, true);
    // No pure-name entry (startupRecoveryProcessNames.win is []), so $names is
    // empty and the only filter is the joint clause built from these arrays.
    assert.match(seenScript, /\$names = @\(\)/);
    assert.match(seenScript, /\$nodeNeedles = @\('zcode\.cjs'\)/);
    assert.match(seenScript, /\$nodeNeedleNames = @\('zcode\.exe'\)/);
    // The filter generator pairs each needle with its host name (here zcode.exe,
    // NOT the default node.exe) via a per-index loop.
    assert.match(
      seenScript,
      /\$nodeFilters = for \(\$i = 0; \$i -lt \$nodeNeedles\.Length; \$i\+\+\) \{ "\(Name='\$\(\$nodeNeedleNames\[\$i\]\)' AND CommandLine LIKE '%\$\(\$nodeNeedles\[\$i\]\)%'\)" \}/
    );
  });

  it("builds the POSIX query from exact names plus known package markers", async () => {
    let seenCommand = "";
    childProcess.exec = (cmd, opts, cb) => {
      seenCommand = cmd;
      cb(null);
    };
    Object.defineProperty(process, "platform", { value: "darwin" });

    const found = await new Promise((resolve) => {
      api.detectRunningAgentProcesses((result) => resolve(result));
    });

    assert.strictEqual(found, true);
    assert.match(seenCommand, /claude-code\|codex\|copilot\|codebuddy\|kimi-code\|zcode\\\.cjs/);
    assert.match(seenCommand, /pgrep -x 'agy'/);
    assert.match(seenCommand, /pgrep -x 'codewhale'/);
    assert.match(seenCommand, /pgrep -x 'qwen'/);
    assert.match(seenCommand, /pgrep -x 'mimo'/);
    assert.match(seenCommand, /pi-coding-agent/);
    assert.match(seenCommand, /pgrep -x 'qodercli'/);
    assert.match(seenCommand, /pgrep -x 'qoder-cli'/);
    assert.doesNotMatch(seenCommand, /pgrep -x 'pi'/);
    assert.doesNotMatch(seenCommand, /pgrep -x '[Cc]ursor'/);
    assert.doesNotMatch(seenCommand, /pgrep -x 'QoderWork'/);
    assert.doesNotMatch(seenCommand, /WorkBuddy/);
  });

  it("filters the process query to enabled agents", async () => {
    api.cleanup();
    api = require("../src/state")(makeCtx({
      hasAnyEnabledAgent: () => true,
      isAgentEnabled: (agentId) => agentId === "qoder",
    }));
    let seenScript = "";
    childProcess.execFile = (file, args, opts, cb) => {
      seenScript = args[args.length - 1];
      cb(null, "12345");
    };
    Object.defineProperty(process, "platform", { value: "win32" });

    const found = await new Promise((resolve) => {
      api.detectRunningAgentProcesses((result) => resolve(result));
    });

    assert.strictEqual(found, true);
    assert.match(seenScript, /'qodercli\.exe'/);
    assert.match(seenScript, /'qoder-cli\.exe'/);
    assert.doesNotMatch(seenScript, /'qoder\.exe'/);
    assert.doesNotMatch(seenScript, /'claude\.exe'/);
    assert.match(seenScript, /\$nodeNeedles = @\(\)/);
  });

  for (const [agentId, processName, commandLineNeedle] of [
    ["claude-code", "claude.exe", "claude-code"],
    ["codex", "codex.exe", "codex"],
  ]) {
    it(`keeps exact-name and node filters separate when only ${agentId} is enabled`, async () => {
      api.cleanup();
      api = require("../src/state")(makeCtx({
        hasAnyEnabledAgent: () => true,
        isAgentEnabled: (enabledAgentId) => enabledAgentId === agentId,
      }));
      let seenScript = "";
      childProcess.execFile = (file, args, opts, cb) => {
        seenScript = args[args.length - 1];
        cb(null, "12345");
      };
      Object.defineProperty(process, "platform", { value: "win32" });

      const found = await new Promise((resolve) => {
        api.detectRunningAgentProcesses((result) => resolve(result));
      });

      assert.strictEqual(found, true);
      assert.ok(seenScript.includes(`$names = @('${processName}')`));
      assert.ok(seenScript.includes(`$nodeNeedles = @('${commandLineNeedle}')`));
      assert.match(
        seenScript,
        /\$filter = \(@\(\$nameFilters\) \+ @\(\$nodeFilters\)\) -join ' OR '/
      );
    });
  }

  it("does not scan when the only enabled agent has an empty process surface", async () => {
    api.cleanup();
    api = require("../src/state")(makeCtx({
      hasAnyEnabledAgent: () => true,
      isAgentEnabled: (agentId) => agentId === "cursor-agent",
    }));
    let calls = 0;
    childProcess.execFile = () => { calls++; };
    Object.defineProperty(process, "platform", { value: "win32" });

    const found = await new Promise((resolve) => {
      api.detectRunningAgentProcesses((result) => resolve(result));
    });

    assert.strictEqual(found, false);
    assert.strictEqual(calls, 0);
  });
});
