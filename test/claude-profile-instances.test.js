"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const path = require("node:path");

const { buildChildLaunch, createClaudeProfileInstances } = require("../src/claude-profile-instances");

const ROOT = path.parse(process.cwd()).root;
const WORK = { id: "work", label: "Work", configDir: path.join(ROOT, "u", ".claude-work"), enabled: true };
const HOBBY = { id: "hobby", label: "Hobby", configDir: path.join(ROOT, "u", ".claude-hobby"), enabled: true };

function makeHarness() {
  const spawned = [];
  const killed = [];
  let nextPid = 1000;
  const instances = createClaudeProfileInstances({
    isPackaged: true,
    execPath: path.join(ROOT, "Applications", "Clawd"),
    settingsArg: "--open-settings-window",
    env: { ELECTRON_RUN_AS_NODE: "1", KEEP: "yes" },
    fs: { readFileSync: () => { throw new Error("no runtime file"); } },
    spawn: (command, args, options) => {
      const child = new EventEmitter();
      child.pid = nextPid++;
      child.unref = () => {};
      spawned.push({ command, args, options, child });
      return child;
    },
    kill: (pid, signal) => killed.push({ pid, signal }),
    log: () => {},
  });
  return { instances, spawned, killed };
}

test("packaged launches run the app binary with profile args and no ELECTRON_RUN_AS_NODE", () => {
  const launch = buildChildLaunch({
    isPackaged: true,
    execPath: "/Applications/Clawd.app/Contents/MacOS/Clawd",
    env: { ELECTRON_RUN_AS_NODE: "1" },
  }, ["--clawd-profile-id=work"]);
  assert.strictEqual(launch.command, "/Applications/Clawd.app/Contents/MacOS/Clawd");
  assert.deepStrictEqual(launch.args, ["--clawd-profile-id=work"]);
  assert.strictEqual(launch.env.ELECTRON_RUN_AS_NODE, undefined);
});

test("AppImage launches use the on-disk image", () => {
  const launch = buildChildLaunch({
    isPackaged: true,
    execPath: "/tmp/.mount_x/clawd",
    appImagePath: "/home/me/Clawd.AppImage",
    env: {},
  }, []);
  assert.strictEqual(launch.command, "/home/me/Clawd.AppImage");
});

test("dev launches pass the app directory to Electron", () => {
  const launch = buildChildLaunch({
    isPackaged: false,
    execPath: "/repo/node_modules/electron/dist/Electron",
    appPath: "/repo",
    platform: "darwin",
    env: {},
  }, ["--clawd-profile-id=work"]);
  assert.strictEqual(launch.command, "/repo/node_modules/electron/dist/Electron");
  assert.deepStrictEqual(launch.args, [".", "--clawd-profile-id=work"]);
  assert.strictEqual(launch.cwd, "/repo");
});

test("reconcile starts enabled profiles with distinct slots", () => {
  const { instances, spawned } = makeHarness();
  instances.reconcile([WORK, { ...HOBBY, enabled: false }]);
  assert.strictEqual(spawned.length, 1);
  assert.ok(spawned[0].args.includes("--clawd-profile-id=work"));
  assert.ok(spawned[0].args.includes(`--clawd-profile-dir=${WORK.configDir}`));
  assert.ok(spawned[0].args.includes("--clawd-profile-slot=1"));
  assert.strictEqual(spawned[0].options.detached, true);
  assert.strictEqual(spawned[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.strictEqual(instances.isRunning("work"), true);

  instances.reconcile([WORK, HOBBY]);
  assert.strictEqual(spawned.length, 2);
  assert.ok(spawned[1].args.includes("--clawd-profile-slot=2"));
});

test("reconcile is idempotent and restarts a profile whose launch args changed", () => {
  const { instances, spawned, killed } = makeHarness();
  instances.reconcile([WORK]);
  instances.reconcile([WORK]);
  assert.strictEqual(spawned.length, 1);
  instances.reconcile([{ ...WORK, label: "Office" }]);
  assert.deepStrictEqual(killed, [{ pid: spawned[0].child.pid, signal: "SIGTERM" }]);
  assert.strictEqual(spawned.length, 2);
  assert.ok(spawned[1].args.includes("--clawd-profile-label=Office"));
});

test("disabling or removing a profile stops its pet", () => {
  const { instances, spawned, killed } = makeHarness();
  instances.reconcile([WORK, HOBBY]);
  instances.reconcile([{ ...WORK, enabled: false }, HOBBY]);
  assert.deepStrictEqual(killed.map((entry) => entry.pid), [spawned[0].child.pid]);
  instances.reconcile([]);
  // Pausing one profile must not restart the other.
  assert.deepStrictEqual(killed.map((entry) => entry.pid), [spawned[0].child.pid, spawned[1].child.pid]);
  assert.strictEqual(spawned.length, 2);
  assert.strictEqual(instances.isRunning("hobby"), false);
});

test("children inherit the primary's --user-data-dir", () => {
  const spawned = [];
  const instances = createClaudeProfileInstances({
    isPackaged: true,
    execPath: "/app/Clawd",
    argv: ["/app/Clawd", "--user-data-dir=/tmp/ud", "--inspect"],
    spawn: (command, args) => {
      const child = new EventEmitter();
      child.pid = 1;
      child.unref = () => {};
      spawned.push(args);
      return child;
    },
  });
  instances.reconcile([WORK]);
  assert.strictEqual(spawned[0][0], "--user-data-dir=/tmp/ud");
  assert.ok(!spawned[0].includes("--inspect"));
});

test("openSettings re-launches with the settings flag for a running profile", () => {
  const { instances, spawned } = makeHarness();
  assert.strictEqual(instances.openSettings("work"), false);
  instances.reconcile([WORK]);
  assert.strictEqual(instances.openSettings("work"), true);
  assert.ok(spawned[1].args.includes("--open-settings-window"));
  assert.ok(spawned[1].args.includes("--clawd-profile-id=work"));
});

test("stopAll stops every running pet", () => {
  const { instances, spawned, killed } = makeHarness();
  instances.reconcile([WORK, HOBBY]);
  instances.stopAll();
  assert.deepStrictEqual(killed.map((entry) => entry.pid).sort(), spawned.map((entry) => entry.child.pid).sort());
});
