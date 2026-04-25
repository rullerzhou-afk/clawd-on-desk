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

describe("detectRunningAgentProcesses() Kimi coverage", () => {
  let api;
  let originalExec;
  let originalPlatform;

  beforeEach(() => {
    originalExec = childProcess.exec;
    originalPlatform = process.platform;
    api = require("../src/state")(makeCtx());
  });

  afterEach(() => {
    childProcess.exec = originalExec;
    Object.defineProperty(process, "platform", { value: originalPlatform });
    api.cleanup();
  });

  it("includes kimi.exe in Windows process query", async () => {
    let seenCommand = "";
    childProcess.exec = (cmd, opts, cb) => {
      seenCommand = cmd;
      cb(null, "12345");
    };
    Object.defineProperty(process, "platform", { value: "win32" });

    const found = await new Promise((resolve) => {
      api.detectRunningAgentProcesses((result) => resolve(result));
    });

    assert.strictEqual(found, true);
    assert.match(seenCommand, /Name='kimi\.exe'/);
  });

  it("includes kimi in macOS/Linux pgrep query", async () => {
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
  });
});
