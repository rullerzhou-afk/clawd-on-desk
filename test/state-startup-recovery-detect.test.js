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

  it("includes kimi.exe and pi.exe in the Windows PowerShell process query", async () => {
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
    assert.match(seenScript, /'kimi\.exe'/);
    assert.match(seenScript, /'pi\.exe'/);
    assert.match(seenScript, /Get-CimInstance Win32_Process/);
  });

  it("includes kimi and Pi package markers in macOS/Linux pgrep query", async () => {
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
    assert.match(seenCommand, /claude-code\|codex\|copilot\|codebuddy\|kimi/);
    assert.match(seenCommand, /pi-coding-agent/);
    assert.doesNotMatch(seenCommand, /pgrep -x 'pi'/);
  });
});
