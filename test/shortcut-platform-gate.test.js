"use strict";

// The Dashboard keyboard mode ships on macOS/Windows only. One piece of action
// metadata is the single source of truth for every surface: the Settings row,
// the global registration, the settings command and conflict occupancy.
//
// A leftover binding from a preview build must be inert on Linux without ever
// being deleted from the user's prefs or blocking another action.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const {
  SHORTCUT_ACTIONS,
  isShortcutActionSupported,
  getSupportedShortcutActionIds,
  normalizeShortcuts,
} = require("../src/shortcut-actions");
const createShortcutRuntime = require("../src/shortcut-runtime");
const { registerShortcut, resetShortcut, resetAllShortcuts } =
  require("../src/settings-actions-shortcuts");

const LEFTOVER = "CommandOrControl+Shift+D";

// Load the real preload under a fake `electron` and a chosen platform, and
// report what it actually put on the bridge plus which channels it subscribed
// to. The renderer feature-detects on exactly this surface.
function loadPreload(platform) {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/preload-dashboard.js"),
    "utf8"
  );
  const subscribed = [];
  let exposed = null;
  const sandbox = {
    require: (name) => {
      if (name !== "electron") throw new Error(`unexpected require: ${name}`);
      return {
        contextBridge: {
          exposeInMainWorld: (key, api) => {
            assert.equal(key, "dashboardAPI");
            exposed = api;
          },
        },
        ipcRenderer: {
          on: (channel) => subscribed.push(channel),
          invoke: (channel) => Promise.resolve(channel),
          send: () => {},
        },
      };
    },
    process: { platform },
    console,
    module: { exports: {} },
  };
  vm.runInNewContext(source, sandbox);
  return { api: exposed, subscribed };
}

test("the preload exposes the keyboard mode only where main registers it", () => {
  const quickMethods = [
    "quickPending",
    "quickEnter",
    "quickReady",
    "quickActivate",
    "quickDismiss",
    "onQuickIntent",
    "onQuickEntries",
    "onQuickDismissed",
  ];

  for (const platform of ["darwin", "win32"]) {
    const { api, subscribed } = loadPreload(platform);
    for (const name of quickMethods) {
      assert.equal(typeof api[name], "function", `${platform}: ${name}`);
    }
    assert.ok(subscribed.includes("dashboard:quick-intent"), platform);
  }

  const { api, subscribed } = loadPreload("linux");
  for (const name of quickMethods) {
    // Absent, not a stub: calling an unregistered channel would throw.
    assert.equal(api[name], undefined, `linux exposes ${name}`);
  }
  assert.ok(
    !subscribed.some((channel) => channel.startsWith("dashboard:quick-")),
    "linux subscribes to no keyboard-mode channel"
  );
  // The ordinary Dashboard bridge is untouched.
  assert.equal(typeof api.getSnapshot, "function");
  assert.equal(typeof api.setSessionAlias, "function");
  assert.equal(typeof api.ackCompletion, "function");
});

test("quickSelectSession is declared macOS/Windows only", () => {
  assert.deepEqual(SHORTCUT_ACTIONS.quickSelectSession.supportedPlatforms, ["darwin", "win32"]);
  assert.equal(isShortcutActionSupported("quickSelectSession", "darwin"), true);
  assert.equal(isShortcutActionSupported("quickSelectSession", "win32"), true);
  assert.equal(isShortcutActionSupported("quickSelectSession", "linux"), false);
  // An unresolvable platform stays closed rather than leaking the feature.
  assert.equal(isShortcutActionSupported("quickSelectSession", ""), false);
});

test("ungated actions stay available everywhere", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    assert.equal(isShortcutActionSupported("togglePet", platform), true);
    assert.equal(isShortcutActionSupported("permissionAllow", platform), true);
  }
  assert.equal(getSupportedShortcutActionIds("linux").includes("quickSelectSession"), false);
  assert.equal(getSupportedShortcutActionIds("darwin").includes("quickSelectSession"), true);
});

test("a leftover Linux binding is preserved but occupies no accelerator", () => {
  const normalized = normalizeShortcuts(
    { quickSelectSession: LEFTOVER, togglePet: LEFTOVER },
    undefined,
    { platform: "linux", isMac: false }
  );

  // Kept verbatim: normalization never deletes the user's stored value...
  assert.equal(normalized.quickSelectSession, LEFTOVER);
  // ...and it does not push togglePet off the same combination.
  assert.equal(normalized.togglePet, LEFTOVER);
});

test("on a supported platform the same pair still resolves as a real conflict", () => {
  const normalized = normalizeShortcuts(
    { quickSelectSession: LEFTOVER, togglePet: LEFTOVER },
    undefined,
    { platform: "darwin", isMac: true }
  );
  assert.notEqual(normalized.quickSelectSession, normalized.togglePet);
});

function runtimeHarness(platform, shortcuts) {
  const registered = [];
  const unregistered = [];
  const globalShortcut = {
    register: (accelerator) => { registered.push(accelerator); return true; },
    unregister: (accelerator) => { unregistered.push(accelerator); },
    isRegistered: (accelerator) => registered.includes(accelerator)
      && !unregistered.includes(accelerator),
  };
  const runtime = createShortcutRuntime({
    globalShortcut,
    platform,
    settingsController: { getSnapshot: () => ({ shortcuts }) },
    getSettingsWindow: () => null,
    shortcutHandlers: {
      togglePet: () => {},
      quickSelectSession: () => {},
    },
  });
  return { runtime, registered, unregistered };
}

test("linux never registers the gated accelerator", () => {
  const { runtime, registered } = runtimeHarness("linux", {
    togglePet: "CommandOrControl+Shift+Alt+C",
    quickSelectSession: LEFTOVER,
  });
  runtime.registerPersistentShortcutsFromSettings();

  assert.deepEqual(registered, ["CommandOrControl+Shift+Alt+C"]);
  assert.equal(runtime.getFailure("quickSelectSession"), null, "not a failure, just absent");
});

test("darwin registers the gated accelerator", () => {
  const { registered, runtime } = runtimeHarness("darwin", {
    togglePet: "CommandOrControl+Shift+Alt+C",
    quickSelectSession: LEFTOVER,
  });
  runtime.registerPersistentShortcutsFromSettings();
  assert.deepEqual(registered.sort(), ["CommandOrControl+Shift+Alt+C", LEFTOVER].sort());
});

test("linux refuses to record the gated action", () => {
  const { runtime } = runtimeHarness("linux", { quickSelectSession: null });
  const result = runtime.startRecording("quickSelectSession");
  assert.equal(result.status, "error");
  assert.match(result.message, /unsupported on this platform/);
});

function commandDeps(platform, shortcuts, registered = []) {
  return {
    platform,
    snapshot: { shortcuts },
    globalShortcut: {
      register: (accelerator) => { registered.push(accelerator); return true; },
      unregister: () => {},
      isRegistered: (accelerator) => registered.includes(accelerator),
    },
    shortcutHandlers: {
      togglePet: () => {},
      quickSelectSession: () => {},
    },
  };
}

test("a UI-bypassing command is refused on linux and writes nothing", () => {
  const result = registerShortcut(
    { actionId: "quickSelectSession", accelerator: LEFTOVER },
    commandDeps("linux", { quickSelectSession: null, togglePet: null })
  );
  assert.equal(result.status, "error");
  assert.match(result.message, /unsupported on this platform/);
  assert.equal(result.commit, undefined);

  assert.equal(
    resetShortcut({ actionId: "quickSelectSession" }, commandDeps("linux", {})).status,
    "error"
  );
});

test("the same command succeeds on a supported platform", () => {
  const result = registerShortcut(
    { actionId: "quickSelectSession", accelerator: LEFTOVER },
    commandDeps("darwin", { quickSelectSession: null, togglePet: null })
  );
  assert.equal(result.status, "ok");
  assert.equal(result.commit.shortcuts.quickSelectSession, LEFTOVER);
});

test("a leftover linux binding does not block another action from that combo", () => {
  const result = registerShortcut(
    { actionId: "togglePet", accelerator: LEFTOVER },
    commandDeps("linux", { quickSelectSession: LEFTOVER, togglePet: null })
  );
  assert.equal(result.status, "ok");
  assert.equal(result.commit.shortcuts.togglePet, LEFTOVER);
  assert.equal(
    result.commit.shortcuts.quickSelectSession,
    LEFTOVER,
    "the user's stored value is left alone"
  );
});

test("the same combo is still a conflict on a supported platform", () => {
  const result = registerShortcut(
    { actionId: "togglePet", accelerator: LEFTOVER },
    commandDeps("darwin", { quickSelectSession: LEFTOVER, togglePet: null })
  );
  assert.equal(result.status, "error");
  assert.match(result.message, /conflict/);
});

test("reset all on linux leaves the gated binding untouched", () => {
  const result = resetAllShortcuts(
    null,
    commandDeps("linux", {
      quickSelectSession: LEFTOVER,
      togglePet: "CommandOrControl+Shift+K",
      permissionAllow: null,
      permissionDeny: null,
    })
  );
  assert.equal(result.status, "ok");
  assert.equal(
    result.commit.shortcuts.quickSelectSession,
    LEFTOVER,
    "reset never deletes prefs for an unsupported action"
  );
  assert.equal(result.commit.shortcuts.togglePet, "CommandOrControl+Shift+Alt+C");
});
