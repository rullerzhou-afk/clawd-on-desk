"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const path = require("node:path");

const {
  focusCodexThreadTarget,
  focusDshDesktopTarget,
  launchDshDesktopApp,
  sanitizeFocusError,
  stripElectronLaunchEnv,
} = require("../src/session-focus-handoff");
const { discoverDshDesktopSync } = require("../hooks/dsh-install");

const DSH_PLIST = [
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
  "<plist version=\"1.0\"><dict>",
  "<key>CFBundleIdentifier</key><string>com.deepseek.dsh</string>",
  "<key>CFBundleShortVersionString</key><string>0.2.0-rc.2</string>",
  "</dict></plist>",
].join("");

// A macOS-only fake fs: each appRoot is a directory with a valid Info.plist and
// the bundled launcher, matching what discoverDshDesktopSync verifies.
function macFs(appRoots) {
  const dirs = new Set(appRoots.map((root) => path.resolve(root)));
  const files = new Map();
  for (const root of appRoots) {
    files.set(path.resolve(path.join(root, "Contents", "Info.plist")), DSH_PLIST);
    files.set(
      path.resolve(path.join(root, "Contents", "Resources", "runtime", "cli", "bin", "dsh")),
      "launcher"
    );
  }
  const missing = () => {
    const err = new Error("ENOENT");
    err.code = "ENOENT";
    return err;
  };
  return {
    statSync(filePath) {
      const key = path.resolve(String(filePath));
      if (dirs.has(key)) return { isDirectory: () => true, isFile: () => false };
      if (files.has(key)) return { isDirectory: () => false, isFile: () => true };
      throw missing();
    },
    readFileSync(filePath) {
      const key = path.resolve(String(filePath));
      if (files.has(key)) return files.get(key);
      throw missing();
    },
  };
}

function eventedChild() {
  const child = new EventEmitter();
  child.unref = () => {};
  return child;
}

describe("session focus handoff", () => {
  it("opens Codex Desktop thread URLs and logs success", async () => {
    const opened = [];
    const logs = [];

    await focusCodexThreadTarget({
      shell: {
        openExternal: async (url) => opened.push(url),
      },
      focusEntry: { id: "codex:thread", agentId: "codex" },
      sessionId: "codex:thread",
      requestSource: "dashboard",
      url: "codex://threads/thread",
      focusLog: (line) => logs.push(line),
    });

    assert.deepStrictEqual(opened, ["codex://threads/thread"]);
    assert.ok(logs.some((line) => line.includes("target=codex-thread")));
    assert.ok(logs.some((line) => line.includes("reason=opened")));
  });

  it("falls back to terminal focus when Codex Desktop deep link fails", async () => {
    const logs = [];
    const terminalCalls = [];
    const focusEntry = { id: "codex:thread", agentId: "codex", sourcePid: 123 };

    await focusCodexThreadTarget({
      shell: {
        openExternal: async () => {
          throw new Error("protocol failed\nwith tab");
        },
      },
      focusEntry,
      sessionId: "codex:thread",
      requestSource: "hud",
      url: "codex://threads/thread",
      focusLog: (line) => logs.push(line),
      focusTerminalSession: (...args) => {
        terminalCalls.push(args);
        return true;
      },
    });

    assert.deepStrictEqual(terminalCalls, [[focusEntry, "codex:thread", "hud"]]);
    assert.ok(logs.some((line) =>
      line.includes("reason=open-failed") && line.includes("protocol failed with tab")
    ));
    assert.ok(!logs.some((line) => line.includes("codex-thread-fallback-no-source-pid")));
  });

  it("falls back to terminal focus when opening the deep link throws synchronously", async () => {
    const terminalCalls = [];
    const focusEntry = { id: "codex:thread", agentId: "codex", sourcePid: 123 };

    await focusCodexThreadTarget({
      shell: {
        openExternal: () => {
          throw new Error("protocol unavailable");
        },
      },
      focusEntry,
      sessionId: "codex:thread",
      url: "codex://threads/thread",
      focusTerminalSession: (...args) => {
        terminalCalls.push(args);
        return true;
      },
    });

    assert.deepStrictEqual(terminalCalls, [[focusEntry, "codex:thread", "dashboard"]]);
  });

  it("does not reject when terminal fallback fails", async () => {
    for (const fail of [
      () => { throw new Error("sync fallback failure"); },
      () => Promise.reject(new Error("async fallback failure")),
    ]) {
      const logs = [];
      await assert.doesNotReject(() => focusCodexThreadTarget({
        shell: {
          openExternal: () => Promise.reject(new Error("protocol unavailable")),
        },
        focusEntry: { id: "codex:thread", agentId: "codex", sourcePid: 123 },
        sessionId: "codex:thread",
        url: "codex://threads/thread",
        focusLog: (line) => logs.push(line),
        focusTerminalSession: fail,
      }));
      assert.ok(logs.some((line) => line.includes("reason=codex-thread-fallback-failed")));
    }
  });

  it("logs when Codex Desktop deep link fallback has no terminal source pid", async () => {
    const logs = [];

    await focusCodexThreadTarget({
      shell: {
        openExternal: async () => {
          throw new Error("no app");
        },
      },
      focusEntry: { id: "codex:thread", agentId: "codex" },
      sessionId: "codex:thread",
      url: "codex://threads/thread",
      focusLog: (line) => logs.push(line),
      focusTerminalSession: () => false,
    });

    assert.ok(logs.some((line) => line.includes("reason=open-failed")));
    assert.ok(logs.some((line) => line.includes("reason=codex-thread-fallback-no-source-pid")));
  });

  it("sanitizes focus errors for single-line logs", () => {
    assert.strictEqual(sanitizeFocusError(new Error("a\r\nb\tc")), "a b c");
    assert.strictEqual(sanitizeFocusError(null), "unknown");
  });

  it("opens the DSH desktop URL and logs success", async () => {
    const opened = [];
    const logs = [];

    await focusDshDesktopTarget({
      shell: { openExternal: async (url) => opened.push(url) },
      focusEntry: { id: "deepseek-harness:s1", agentId: "deepseek-harness" },
      sessionId: "deepseek-harness:s1",
      requestSource: "dashboard",
      url: "dsh://open",
      focusLog: (line) => logs.push(line),
    });

    assert.deepStrictEqual(opened, ["dsh://open"]);
    assert.ok(logs.some((line) => line.includes("target=dsh-desktop")));
    assert.ok(logs.some((line) => line.includes("reason=opened")));
  });

  it("does not launch the desktop app when the URL handler succeeds", async () => {
    const logs = [];
    let discoveries = 0;
    const spawns = [];

    await focusDshDesktopTarget({
      shell: { openExternal: async () => {} },
      focusEntry: { id: "deepseek-harness:s1", agentId: "deepseek-harness" },
      sessionId: "deepseek-harness:s1",
      url: "dsh://open",
      focusLog: (line) => logs.push(line),
      discoverDesktop: () => {
        discoveries += 1;
        return { status: "found", appRoot: "/Applications/DeepSeek Harness.app" };
      },
      osPlatform: "darwin",
      spawnImpl: (...args) => {
        spawns.push(args);
        return { unref() {} };
      },
    });

    assert.strictEqual(discoveries, 0);
    assert.deepStrictEqual(spawns, []);
    assert.ok(logs.some((line) => line.includes("reason=opened")));
    assert.ok(!logs.some((line) => line.includes("reason=launched")));
  });

  it("launches the macOS app bundle with open after the URL handler rejects", async () => {
    const spawned = [];
    const logs = [];
    const spawnImpl = (command, args, options) => {
      const child = eventedChild();
      const unref = child.unref;
      child.unref = () => { child.unrefed = true; unref(); };
      spawned.push({ command, args, options, child });
      setImmediate(() => child.emit("exit", 0));
      return child;
    };

    await focusDshDesktopTarget({
      shell: { openExternal: async () => { throw new Error("no protocol handler"); } },
      focusEntry: { id: "deepseek-harness:s1", agentId: "deepseek-harness" },
      sessionId: "deepseek-harness:s1",
      requestSource: "hud",
      url: "dsh://open",
      focusLog: (line) => logs.push(line),
      discoverDesktop: () => ({ status: "found", appRoot: "/Applications/DeepSeek Harness.app" }),
      osPlatform: "darwin",
      spawnImpl,
      env: { PATH: "/usr/bin" },
    });

    assert.strictEqual(spawned.length, 1);
    assert.strictEqual(spawned[0].command, "/usr/bin/open");
    assert.deepStrictEqual(spawned[0].args, ["/Applications/DeepSeek Harness.app"]);
    assert.strictEqual(spawned[0].options.detached, true);
    assert.strictEqual(spawned[0].child.unrefed, true);
    assert.ok(logs.some((line) => line.includes("reason=open-failed")));
    assert.ok(logs.some((line) => line.includes("reason=launched")));
  });

  it("launches the Windows executable as a GUI without Electron/Node environment", async () => {
    const spawned = [];
    const child = eventedChild();
    setImmediate(() => child.emit("spawn"));
    const result = await launchDshDesktopApp({
      osPlatform: "win32",
      discoverDesktop: () => ({ status: "found", appRoot: "C:\\Users\\me\\AppData\\Local\\Programs\\DeepSeek Harness" }),
      spawnImpl: (command, args, options) => {
        spawned.push({ command, args, options });
        return child;
      },
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        electron_renderer: "x",
        NODE_OPTIONS: "--require ./trace.js",
        PATH: "C:\\Windows",
      },
    });

    assert.strictEqual(result.reason, "launched");
    assert.strictEqual(
      spawned[0].command,
      "C:\\Users\\me\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe"
    );
    assert.deepStrictEqual(spawned[0].args, []);
    assert.strictEqual(spawned[0].options.detached, true);
    assert.strictEqual(Object.hasOwn(spawned[0].options.env, "ELECTRON_RUN_AS_NODE"), false);
    assert.strictEqual(Object.hasOwn(spawned[0].options.env, "electron_renderer"), false);
    assert.strictEqual(Object.hasOwn(spawned[0].options.env, "NODE_OPTIONS"), false);
    assert.strictEqual(spawned[0].options.env.PATH, "C:\\Windows");
  });

  it("reports an asynchronous child error without leaking it", async () => {
    const child = eventedChild();
    setImmediate(() => child.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" })));

    const result = await launchDshDesktopApp({
      osPlatform: "darwin",
      discoverDesktop: () => ({ status: "found", appRoot: "/Applications/DeepSeek Harness.app" }),
      spawnImpl: () => child,
      env: {},
    });

    assert.deepStrictEqual(result, {
      launched: false,
      reason: "launch-failed",
      error: "spawn EACCES",
      errorCode: "EACCES",
    });
  });

  for (const [code, reason] of [[0, "launched"], [1, "launch-failed"]]) {
    it(`settles macOS open exit code ${code} as ${reason}`, async () => {
      const child = eventedChild();
      setImmediate(() => child.emit("exit", code));

      const result = await launchDshDesktopApp({
        osPlatform: "darwin",
        discoverDesktop: () => ({ status: "found", appRoot: "/Applications/DeepSeek Harness.app" }),
        spawnImpl: () => child,
        env: {},
      });

      assert.strictEqual(result.reason, reason);
      if (code === 0) assert.strictEqual(result.launched, true);
      else assert.strictEqual(result.exitCode, code);
    });
  }

  it("settles a child that errors then exits only once", async () => {
    const child = eventedChild();
    setImmediate(() => {
      child.emit("error", Object.assign(new Error("boom"), { code: "ENOENT" }));
      child.emit("exit", 0);
    });

    const result = await launchDshDesktopApp({
      osPlatform: "darwin",
      discoverDesktop: () => ({ status: "found", appRoot: "/Applications/DeepSeek Harness.app" }),
      spawnImpl: () => child,
      env: {},
    });

    assert.strictEqual(result.reason, "launch-failed");
    assert.strictEqual(result.errorCode, "ENOENT");
  });

  it("settles a silent child as launch-unconfirmed after the safety timeout", async () => {
    const child = eventedChild();

    const result = await launchDshDesktopApp({
      osPlatform: "darwin",
      discoverDesktop: () => ({ status: "found", appRoot: "/Applications/DeepSeek Harness.app" }),
      spawnImpl: () => child,
      env: {},
      launchTimeoutMs: 5,
    });

    assert.strictEqual(result.reason, "launch-unconfirmed");
  });

  it("does not launch anything when no single desktop install is verified", async () => {
    const spawned = [];
    const spawnImpl = () => { spawned.push(1); return eventedChild(); };

    assert.strictEqual(
      (await launchDshDesktopApp({ osPlatform: "darwin", discoverDesktop: () => ({ status: "not-found" }), spawnImpl })).reason,
      "desktop-not-found"
    );
    assert.strictEqual(
      (await launchDshDesktopApp({ osPlatform: "darwin", discoverDesktop: () => ({ status: "ambiguous" }), spawnImpl })).reason,
      "desktop-ambiguous"
    );
    assert.strictEqual(
      (await launchDshDesktopApp({
        osPlatform: "darwin",
        discoverDesktop: () => { throw new Error("registry read failed"); },
        spawnImpl,
      })).reason,
      "desktop-not-found"
    );
    assert.strictEqual(
      (await launchDshDesktopApp({ osPlatform: "linux", discoverDesktop: () => ({ status: "found", appRoot: "/opt/dsh" }), spawnImpl })).reason,
      "desktop-not-found"
    );
    assert.strictEqual(
      (await launchDshDesktopApp({
        osPlatform: "darwin",
        discoverDesktop: () => ({ status: "found", appRoot: "/Applications/DeepSeek Harness.app" }),
        spawnImpl: () => { throw new Error("spawn refused"); },
      })).reason,
      "launch-failed"
    );
    assert.deepStrictEqual(spawned, []);
  });

  it("does not start anything when real discovery reports two valid macOS installs", async () => {
    const first = "/Applications/DeepSeek Harness.app";
    const second = "/Users/me/Applications/DeepSeek Harness.app";
    const spawned = [];
    const logs = [];

    await focusDshDesktopTarget({
      shell: { openExternal: async () => { throw new Error("no protocol handler"); } },
      focusEntry: { id: "deepseek-harness:s1", agentId: "deepseek-harness" },
      sessionId: "deepseek-harness:s1",
      url: "dsh://open",
      focusLog: (line) => logs.push(line),
      // The real discovery function, not a pre-built ambiguous result.
      discoverDesktop: (options) => discoverDshDesktopSync({
        ...options,
        fs: macFs([first, second]),
        desktopAppPaths: [first, second],
      }),
      osPlatform: "darwin",
      spawnImpl: () => { spawned.push(1); return eventedChild(); },
      env: {},
    });

    assert.deepStrictEqual(spawned, []);
    assert.ok(logs.some((line) => line.includes("reason=desktop-ambiguous")));
    assert.ok(!logs.some((line) => line.includes("reason=launched")));
  });

  it("does not start when real discovery leaves a second candidate unconfirmed", async () => {
    const first = "/Applications/DeepSeek Harness.app";
    const second = "/Users/me/Applications/DeepSeek Harness.app";
    const plistFirst = path.join(first, "Contents", "Info.plist");
    const launcherFirst = path.join(first, "Contents", "Resources", "runtime", "cli", "bin", "dsh");
    const plistSecond = path.resolve(path.join(second, "Contents", "Info.plist"));
    const dirs = new Set([first, second].map((root) => path.resolve(root)));
    const files = new Map([
      [path.resolve(plistFirst), DSH_PLIST],
      [path.resolve(launcherFirst), "launcher"],
    ]);
    const missing = (code) => {
      const err = new Error(code);
      err.code = code;
      return err;
    };
    const fs = {
      statSync(filePath) {
        const key = path.resolve(String(filePath));
        if (dirs.has(key)) return { isDirectory: () => true, isFile: () => false };
        if (files.has(key)) return { isDirectory: () => false, isFile: () => true };
        throw missing("ENOENT");
      },
      readFileSync(filePath) {
        const key = path.resolve(String(filePath));
        if (key === plistSecond) throw missing("EACCES");
        if (files.has(key)) return files.get(key);
        throw missing("ENOENT");
      },
    };

    const spawned = [];
    const logs = [];
    await focusDshDesktopTarget({
      shell: { openExternal: async () => { throw new Error("no protocol handler"); } },
      focusEntry: { id: "deepseek-harness:s1", agentId: "deepseek-harness" },
      sessionId: "deepseek-harness:s1",
      url: "dsh://open",
      focusLog: (line) => logs.push(line),
      discoverDesktop: (options) => discoverDshDesktopSync({
        ...options,
        fs,
        desktopAppPaths: [first, second],
      }),
      osPlatform: "darwin",
      spawnImpl: () => { spawned.push(1); return eventedChild(); },
      env: {},
    });

    assert.deepStrictEqual(spawned, []);
    assert.ok(logs.some((line) => line.includes("reason=desktop-unconfirmed")));
    assert.ok(!logs.some((line) => line.includes("reason=launched")));
  });

  it("logs a launch failure with the child error code", async () => {
    const child = eventedChild();
    setImmediate(() => child.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" })));
    const logs = [];

    await focusDshDesktopTarget({
      shell: { openExternal: async () => { throw new Error("no protocol handler"); } },
      focusEntry: { id: "deepseek-harness:s1", agentId: "deepseek-harness" },
      sessionId: "deepseek-harness:s1",
      url: "dsh://open",
      focusLog: (line) => logs.push(line),
      discoverDesktop: () => ({ status: "found", appRoot: "/Applications/DeepSeek Harness.app" }),
      osPlatform: "darwin",
      spawnImpl: () => child,
      env: {},
    });

    assert.ok(logs.some((line) => line.includes("reason=launch-failed") && line.includes("code=EACCES")));
    assert.ok(!logs.some((line) => line.includes("reason=opened")));
  });

  it("logs the fallback reason when the URL handler and the app launch both fail", async () => {
    const logs = [];
    await focusDshDesktopTarget({
      shell: { openExternal: async () => { throw new Error("no handler"); } },
      focusEntry: { id: "deepseek-harness:s1", agentId: "deepseek-harness" },
      sessionId: "deepseek-harness:s1",
      url: "dsh://open",
      focusLog: (line) => logs.push(line),
      discoverDesktop: () => ({ status: "ambiguous" }),
      osPlatform: "darwin",
      spawnImpl: () => { throw new Error("must not spawn"); },
    });
    assert.ok(logs.some((line) => line.includes("reason=desktop-ambiguous")));
  });

  it("strips Electron and Node environment keys case-insensitively", () => {
    assert.deepStrictEqual(stripElectronLaunchEnv({
      Electron_Run_As_Node: "1",
      NODE_OPTIONS: "x",
      node_options: "y",
      HOME: "/home/me",
    }), { HOME: "/home/me" });
  });
});
