// test/focus-linux-kde.test.js — Linux window raise (#1001): KWin scripting on
// KDE Plasma Wayland, Konsole tab selection over D-Bus, and outcome logging for
// the X11 wmctrl/xdotool path.
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const { spawn } = require("child_process");
const { loadFocusWithMock } = require("./helpers/load-focus-with-mock");

const KONSOLE_SERVICE = ":1.162";

// gdbus replies keyed by D-Bus method; anything else (tmux, ps, …) is missing.
function mockExecFile(replies = {}) {
  const calls = [];
  const scripts = [];
  const mock = function (cmd, args, options, cb) {
    if (typeof options === "function") { cb = options; options = {}; }
    calls.push({ cmd, args: [...args] });
    const method = cmd === "gdbus" ? args[args.indexOf("--method") + 1] : cmd;
    if (method === "org.kde.kwin.Scripting.loadScript") {
      scripts.push(fs.readFileSync(args[args.indexOf("--method") + 2], "utf8"));
    }
    const reply = replies[method];
    if (!reply) {
      const err = new Error(`spawn ${cmd} ENOENT`);
      err.code = "ENOENT";
      if (cb) cb(err, "", "");
      return;
    }
    if (cb) cb(reply.err || null, reply.stdout || "", "");
  };
  return { mock, calls, scripts };
}

function gdbusMethods(calls) {
  return calls.filter((call) => call.cmd === "gdbus").map((call) => call.args[call.args.indexOf("--method") + 1]);
}

function gdbusCall(calls, method) {
  return calls.find((call) => call.cmd === "gdbus" && call.args.includes(method));
}

// A real process whose /proc/<pid>/environ carries the given variables, standing
// in for the shell that runs inside a Konsole tab.
function spawnWithEnv(env) {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
}

async function waitForLog(logs, pattern) {
  for (let i = 0; i < 100; i++) {
    const line = logs.find((msg) => pattern.test(msg));
    if (line) return line;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`no log line matching ${pattern} in:\n${logs.join("\n")}`);
}

function withSessionEnv(sessionType, desktop) {
  const saved = { XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE, XDG_CURRENT_DESKTOP: process.env.XDG_CURRENT_DESKTOP };
  process.env.XDG_SESSION_TYPE = sessionType;
  process.env.XDG_CURRENT_DESKTOP = desktop;
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const KONSOLE_REPLIES = (ownerPid) => ({
  "org.freedesktop.DBus.GetConnectionUnixProcessID": { stdout: `(uint32 ${ownerPid},)\n` },
  "org.kde.konsole.Window.setCurrentSession": { stdout: "()\n" },
  "org.kde.konsole.Session.title": { stdout: "('~/project : claude',)\n" },
  "org.kde.kwin.Scripting.loadScript": { stdout: "(3,)\n" },
  "org.kde.kwin.Script.run": { stdout: "()\n" },
  "org.kde.kwin.Scripting.unloadScript": { stdout: "(true,)\n" },
});

describe("KDE Plasma Wayland focus", () => {
  let restoreEnv;
  let children;
  beforeEach(() => {
    restoreEnv = withSessionEnv("wayland", "KDE");
    children = [];
  });
  afterEach(() => {
    for (const child of children) child.kill();
    restoreEnv();
  });

  function konsoleShell(sessionPath = "/Sessions/24") {
    const child = spawnWithEnv({
      KONSOLE_DBUS_SERVICE: KONSOLE_SERVICE,
      KONSOLE_DBUS_WINDOW: "/Windows/2",
      KONSOLE_DBUS_SESSION: sessionPath,
    });
    children.push(child);
    return child;
  }

  it("selects the Konsole tab, then raises its window through a KWin script", async () => {
    const shell = konsoleShell();
    const konsolePid = process.pid;
    const { mock, calls, scripts } = mockExecFile(KONSOLE_REPLIES(konsolePid));
    const { initFocus, cleanup } = loadFocusWithMock(mock, { platform: "linux" });
    const logs = [];
    try {
      const focus = initFocus({ focusLog: (msg) => logs.push(msg) });
      const result = focus.focusTerminalWindow({ sourcePid: konsolePid, pidChain: [shell.pid, konsolePid] });
      assert.strictEqual(result.reason, "linux-command-submitted");

      const line = await waitForLog(logs, /branch=linux-kwin/);
      assert.match(line, /reason=kwin-activate-requested konsole=konsole-tab-selected/);
      assert.deepStrictEqual(gdbusMethods(calls), [
        "org.freedesktop.DBus.GetConnectionUnixProcessID",
        "org.kde.konsole.Window.setCurrentSession",
        "org.kde.konsole.Session.title",
        "org.kde.kwin.Scripting.loadScript",
        "org.kde.kwin.Script.run",
        "org.kde.kwin.Scripting.unloadScript",
      ]);
      const select = gdbusCall(calls, "org.kde.konsole.Window.setCurrentSession");
      assert.deepStrictEqual(select.args.slice(0, 7), [
        "call", "--session", "--dest", KONSOLE_SERVICE, "--object-path", "/Windows/2", "--method",
      ]);
      assert.strictEqual(select.args[8], "24");
      const run = gdbusCall(calls, "org.kde.kwin.Script.run");
      assert.strictEqual(run.args[run.args.indexOf("--object-path") + 1], "/Scripting/Script3");

      assert.strictEqual(scripts.length, 1);
      assert.match(scripts[0], new RegExp(`const pid = ${konsolePid};`));
      assert.match(scripts[0], /const captionPrefix = "~\/project : claude";/);
      const scriptPath = gdbusCall(calls, "org.kde.kwin.Scripting.loadScript").args[8];
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(fs.existsSync(scriptPath), false);
    } finally {
      cleanup();
    }
  });

  it("ignores Konsole variables leaked to a process Konsole does not own", async () => {
    // e.g. an IDE launched from a Konsole tab: its terminals inherit the variables.
    const shell = konsoleShell();
    const { mock, calls, scripts } = mockExecFile(KONSOLE_REPLIES(999999));
    const { initFocus, cleanup } = loadFocusWithMock(mock, { platform: "linux" });
    const logs = [];
    try {
      const focus = initFocus({ focusLog: (msg) => logs.push(msg) });
      focus.focusTerminalWindow({ sourcePid: 4321, pidChain: [shell.pid, 4321] });

      const line = await waitForLog(logs, /branch=linux-kwin/);
      assert.match(line, /konsole=konsole-not-in-pid-chain/);
      assert.ok(!gdbusMethods(calls).includes("org.kde.konsole.Window.setCurrentSession"));
      assert.match(scripts[0], /const pid = 4321;/);
      assert.match(scripts[0], /const captionPrefix = "";/);
    } finally {
      cleanup();
    }
  });

  it("raises other terminals by source PID", async () => {
    const { mock, calls, scripts } = mockExecFile(KONSOLE_REPLIES(1));
    const { initFocus, cleanup } = loadFocusWithMock(mock, { platform: "linux" });
    const logs = [];
    try {
      const focus = initFocus({ focusLog: (msg) => logs.push(msg) });
      focus.focusTerminalWindow({ sourcePid: 4321, pidChain: [999998, 4321] });

      const line = await waitForLog(logs, /branch=linux-kwin/);
      assert.match(line, /reason=kwin-activate-requested konsole=no-konsole-session/);
      assert.ok(!calls.some((call) => call.cmd === "wmctrl" || call.cmd === "xdotool"));
      assert.match(scripts[0], /const pid = 4321;/);
    } finally {
      cleanup();
    }
  });

  it("logs when KWin refuses the script", async () => {
    const replies = KONSOLE_REPLIES(1);
    replies["org.kde.kwin.Scripting.loadScript"] = { stdout: "(-1,)\n" };
    const { mock, calls } = mockExecFile(replies);
    const { initFocus, cleanup } = loadFocusWithMock(mock, { platform: "linux" });
    const logs = [];
    try {
      const focus = initFocus({ focusLog: (msg) => logs.push(msg) });
      focus.focusTerminalWindow({ sourcePid: 4321, pidChain: [4321] });

      const line = await waitForLog(logs, /branch=linux-kwin/);
      assert.match(line, /reason=kwin-script-load-failed/);
      assert.ok(!gdbusMethods(calls).includes("org.kde.kwin.Script.run"));
      const scriptPath = gdbusCall(calls, "org.kde.kwin.Scripting.loadScript").args[8];
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(fs.existsSync(scriptPath), false);
    } finally {
      cleanup();
    }
  });

  it("logs when gdbus is not installed", async () => {
    const { mock } = mockExecFile({});
    const { initFocus, cleanup } = loadFocusWithMock(mock, { platform: "linux" });
    const logs = [];
    try {
      const focus = initFocus({ focusLog: (msg) => logs.push(msg) });
      focus.focusTerminalWindow({ sourcePid: 4321, pidChain: [4321] });

      const line = await waitForLog(logs, /branch=linux-kwin/);
      assert.match(line, /reason=kwin-script-load-failed konsole=no-konsole-session/);
    } finally {
      cleanup();
    }
  });
});

describe("X11 focus", () => {
  let restoreEnv;
  beforeEach(() => { restoreEnv = withSessionEnv("x11", "KDE"); });
  afterEach(() => restoreEnv());

  async function runX11(replies) {
    const { mock, calls } = mockExecFile(replies);
    const { initFocus, cleanup } = loadFocusWithMock(mock, { platform: "linux" });
    const logs = [];
    try {
      const focus = initFocus({ focusLog: (msg) => logs.push(msg) });
      focus.focusTerminalWindow({ sourcePid: 4321, pidChain: [4321] });
      return { line: await waitForLog(logs, /branch=linux-x11/), calls };
    } finally {
      cleanup();
    }
  }

  it("activates the wmctrl window owned by the source PID", async () => {
    const { line, calls } = await runX11({
      wmctrl: { stdout: "0x01 0 1111 host other\n0x02 0 4321 host konsole\n" },
    });
    assert.match(line, /reason=wmctrl-activated/);
    assert.deepStrictEqual(calls.find((call) => call.args[0] === "-i").args, ["-i", "-a", "0x02"]);
    assert.ok(!calls.some((call) => call.cmd === "gdbus"));
  });

  it("falls back to xdotool when wmctrl is missing", async () => {
    const { line } = await runX11({ xdotool: { stdout: "" } });
    assert.match(line, /reason=xdotool-activated/);
  });

  it("reports when no window belongs to the source PID", async () => {
    const err = Object.assign(new Error("exit 1"), { code: 1 });
    const { line } = await runX11({ xdotool: { err } });
    assert.match(line, /reason=no-window-found/);
  });

  it("reports when neither tool is installed", async () => {
    const { line } = await runX11({});
    assert.match(line, /reason=no-window-tool/);
  });
});

describe("gdbus and KWin script helpers", () => {
  const { initFocus, cleanup } = loadFocusWithMock(() => {}, { platform: "linux" });
  const helpers = initFocus({ focusLog: () => {} }).__test;
  cleanup();

  it("parses gdbus replies", () => {
    assert.strictEqual(helpers.parseGdbusInteger("(uint32 10126,)\n"), 10126);
    assert.strictEqual(helpers.parseGdbusInteger("(0,)"), 0);
    assert.strictEqual(helpers.parseGdbusInteger("(-1,)"), -1);
    assert.strictEqual(helpers.parseGdbusInteger("(true,)"), null);
    assert.strictEqual(helpers.parseGdbusString("('~ : claude',)\n"), "~ : claude");
    assert.strictEqual(helpers.parseGdbusString(`("it's",)`), "it's");
    assert.strictEqual(helpers.parseGdbusString("()"), null);
  });

  it("embeds untrusted captions as string literals", () => {
    const script = helpers.buildKwinActivateScript(42, "\"; workspace.activeWindow = null; \"");
    assert.doesNotThrow(() => new Function("workspace", script));
    assert.match(script, /const captionPrefix = "\\"; workspace\.activeWindow = null; \\"";/);
  });
});
