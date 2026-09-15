"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const {
  INITIAL_DISCOVER_TIMEOUT_MS,
  STARTUP_DISCOVER_TIMEOUT_MS,
  isGrokCompatibilityHookEnv,
  waitForClawdPort,
  resolveAppImageExecutable,
  resolveMacBundleExecutable,
  launchApp,
  main,
} = require("../hooks/auto-start");

test("auto-start does not launch Clawd when invoked from a Grok hook", async () => {
  const calls = [];

  await new Promise((resolve) => {
    main({
      env: { GROK_HOOK_EVENT: "session_start", GROK_SESSION_ID: "sess-1" },
      writeStdout(text) {
        calls.push(["stdout", text]);
      },
      discoverClawdPort() {
        calls.push(["discover"]);
      },
      launchApp() {
        calls.push(["launch"]);
      },
      exit(code) {
        calls.push(["exit", code]);
        resolve();
      },
    });
  });

  // Passive stdout, then exit — never a discovery probe or an app launch.
  assert.deepStrictEqual(calls, [["stdout", "{}\n"], ["exit", 0]]);
});

test("the packaged auto-start script emits passive stdout under GROK_HOOK_EVENT", () => {
  const { spawnSync } = require("node:child_process");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-auto-start-"));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, "..", "hooks", "auto-start.js")], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, HOME: home, USERPROFILE: home, GROK_HOOK_EVENT: "session_start" },
    });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "{}\n");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the Grok compatibility guard requires a non-empty official GROK_HOOK_EVENT", () => {
  assert.strictEqual(isGrokCompatibilityHookEnv({ GROK_HOOK_EVENT: "session_start" }), true);
  assert.strictEqual(isGrokCompatibilityHookEnv({ GROK_HOOK_EVENT: "  " }), false);
  assert.strictEqual(isGrokCompatibilityHookEnv({ GROK_SESSION_ID: "s1" }), false);
  assert.strictEqual(isGrokCompatibilityHookEnv({ GROK_HOME: "/custom" }), false);
  assert.strictEqual(isGrokCompatibilityHookEnv({ GROK_API_KEY: "x" }), false);
  assert.strictEqual(isGrokCompatibilityHookEnv({}), false);
});

test("auto-start exits without launching when Clawd is already listening", async () => {
  const calls = [];

  await new Promise((resolve) => {
    main({
      env: {},
      discoverClawdPort(options, callback) {
        calls.push(["discover", options.timeoutMs]);
        callback(23333);
      },
      launchApp() {
        calls.push(["launch"]);
      },
      exit(code) {
        calls.push(["exit", code]);
        resolve();
      },
    });
  });

  assert.deepStrictEqual(calls, [
    ["discover", INITIAL_DISCOVER_TIMEOUT_MS],
    ["exit", 0],
  ]);
});

test("auto-start waits for the cold-launched app before exiting", async () => {
  const calls = [];
  const ports = [null, null, 23333];

  await new Promise((resolve) => {
    main({
      env: {},
      discoverClawdPort(options, callback) {
        calls.push(["discover", options.timeoutMs]);
        callback(ports.shift() || null);
      },
      launchApp() {
        calls.push(["launch"]);
      },
      setTimeout(callback) {
        calls.push(["timer"]);
        callback();
        return 1;
      },
      exit(code) {
        calls.push(["exit", code]);
        resolve();
      },
    });
  });

  assert.deepStrictEqual(calls, [
    ["discover", INITIAL_DISCOVER_TIMEOUT_MS],
    ["launch"],
    ["discover", STARTUP_DISCOVER_TIMEOUT_MS],
    ["timer"],
    ["discover", STARTUP_DISCOVER_TIMEOUT_MS],
    ["exit", 0],
  ]);
});

test("waitForClawdPort gives up after the startup deadline", async () => {
  const calls = [];
  let now = 0;

  await new Promise((resolve) => {
    waitForClawdPort({
      timeoutMs: 250,
      intervalMs: 100,
      discoverTimeoutMs: 10,
      now: () => now,
      discoverClawdPort(options, callback) {
        calls.push(["discover", options.timeoutMs, now]);
        callback(null);
      },
      setTimeout(callback, delayMs) {
        calls.push(["timer", delayMs]);
        now += delayMs;
        callback();
        return 1;
      },
    }, (port) => {
      calls.push(["done", port, now]);
      resolve();
    });
  });

  assert.deepStrictEqual(calls, [
    ["discover", 10, 0],
    ["timer", 100],
    ["discover", 10, 100],
    ["timer", 100],
    ["discover", 10, 200],
    ["timer", 100],
    ["discover", 10, 300],
    ["done", null, 300],
  ]);
});

test("packaged macOS auto-start launches the exact bundle executable", () => {
  const calls = [];
  const hooksDir = "/tmp/Clawd on Desk.app/Contents/Resources/app.asar.unpacked/hooks";
  launchApp({
    platform: "darwin",
    hooksDir,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return {
        unref() {
          calls.push("unref");
        },
      };
    },
  });

  assert.deepStrictEqual(calls, [
    {
      command: "/tmp/Clawd on Desk.app/Contents/MacOS/Clawd on Desk",
      args: [],
      options: { detached: true, stdio: "ignore" },
    },
    "unref",
  ]);
});

test("packaged macOS auto-start survives a renamed outer app bundle", () => {
  const calls = [];
  const appBundle = "/Applications/Clawd on Desk 2.app";
  const hooksDir = `${appBundle}/Contents/Resources/app.asar.unpacked/hooks`;
  launchApp({
    platform: "darwin",
    hooksDir,
    fs: {
      readFileSync(filePath, encoding) {
        assert.strictEqual(filePath, `${appBundle}/Contents/Info.plist`);
        assert.strictEqual(encoding, "utf8");
        return [
          "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
          "<plist><dict>",
          "<key>CFBundleExecutable</key>",
          "<string>Clawd on Desk</string>",
          "</dict></plist>",
        ].join("");
      },
    },
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { unref() {} };
    },
  });

  assert.deepStrictEqual(calls, [{
    command: `${appBundle}/Contents/MacOS/Clawd on Desk`,
    args: [],
    options: { detached: true, stdio: "ignore" },
  }]);
});

test("macOS executable resolution fails closed to the stable product executable", () => {
  assert.strictEqual(resolveMacBundleExecutable("/tmp/Renamed.app", {
    fs: {
      readFileSync() {
        throw new Error("unreadable plist");
      },
    },
}), "/tmp/Renamed.app/Contents/MacOS/Clawd on Desk");
});

test("materialized AppImage hooks launch the persistent on-disk AppImage", () => {
  const hooksDir = "/home/user/.clawd/appimage-hooks/release";
  const appImagePath = "/home/user/Applications/Clawd-on-Desk.AppImage";
  const calls = [];
  const fsApi = {
    readFileSync(filePath, encoding) {
      assert.strictEqual(filePath, `${hooksDir}/.clawd-appimage-path`);
      assert.strictEqual(encoding, "utf8");
      return `${appImagePath}\n`;
    },
  };

  assert.strictEqual(resolveAppImageExecutable(hooksDir, {
    env: {},
    fs: fsApi,
  }), appImagePath);

  launchApp({
    platform: "linux",
    hooksDir,
    env: {},
    fs: fsApi,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { unref() {} };
    },
  });

  assert.deepStrictEqual(calls, [{
    command: appImagePath,
    args: [],
    options: { detached: true, stdio: "ignore" },
  }]);
});

test("detached app launch handles asynchronous spawn errors", () => {
  const child = new EventEmitter();
  let unrefs = 0;
  let reported = null;
  child.unref = () => {
    unrefs += 1;
  };

  launchApp({
    platform: "darwin",
    hooksDir: "/tmp/Clawd on Desk.app/Contents/Resources/app.asar.unpacked/hooks",
    spawn() {
      return child;
    },
    onSpawnError(err) {
      reported = err;
    },
  });

  assert.strictEqual(child.listenerCount("error"), 1);
  const failure = new Error("ENOENT");
  child.emit("error", failure);
  assert.strictEqual(reported, failure);
  assert.strictEqual(child.listenerCount("error"), 0);
  assert.strictEqual(unrefs, 1);
});
