"use strict";

const test = require("node:test");
const assert = require("node:assert");

const prefs = require("../src/prefs");
const shortcutCommands = require("../src/settings-actions-shortcuts");

function makeDeps(overrides = {}) {
  const snapshot = overrides.snapshot || prefs.getDefaults();
  const registered = new Set(overrides.registered || []);
  const calls = { register: [], unregister: [] };
  const globalShortcut = {
    register(accelerator, handler) {
      calls.register.push({ accelerator, handler });
      if (overrides.failRegister && overrides.failRegister.has(accelerator)) return false;
      registered.add(accelerator);
      return true;
    },
    unregister(accelerator) {
      calls.unregister.push(accelerator);
      if (overrides.failUnregister && overrides.failUnregister.has(accelerator)) return;
      registered.delete(accelerator);
    },
    isRegistered(accelerator) {
      return registered.has(accelerator);
    },
  };
  return {
    deps: {
      snapshot,
      globalShortcut,
      platform: overrides.platform,
      shortcutHandlers: {
        togglePet: () => {},
        quickSelectSession: () => {},
      },
    },
    calls,
    registered,
  };
}

test("settings shortcut actions expose the command surface", () => {
  assert.deepStrictEqual(Object.keys(shortcutCommands).sort(), [
    "registerShortcut",
    "resetAllShortcuts",
    "resetShortcut",
  ]);
});

test("settings shortcut actions register persistent shortcuts with rollback-safe ordering", () => {
  const snapshot = prefs.validate({
    shortcuts: {
      togglePet: "Ctrl+J",
    },
  });
  const { deps, calls, registered } = makeDeps({
    snapshot,
    registered: [snapshot.shortcuts.togglePet],
  });

  const result = shortcutCommands.registerShortcut({
    actionId: "togglePet",
    accelerator: "Ctrl+K",
  }, deps);

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(result.commit.shortcuts.togglePet, "CommandOrControl+K");
  assert.deepStrictEqual(calls.register.map((call) => call.accelerator), ["CommandOrControl+K"]);
  assert.deepStrictEqual(calls.unregister, ["CommandOrControl+J"]);
  assert.deepStrictEqual([...registered].sort(), ["CommandOrControl+K"]);
});

test("settings shortcut actions register an explicit macOS Control accelerator", () => {
  const snapshot = prefs.validate({
    shortcuts: {
      togglePet: "CommandOrControl+J",
    },
  });
  const { deps, calls, registered } = makeDeps({
    snapshot,
    platform: "darwin",
    registered: [snapshot.shortcuts.togglePet],
  });

  const result = shortcutCommands.registerShortcut({
    actionId: "togglePet",
    accelerator: "Control+Shift+1",
  }, deps);

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.commit.shortcuts.togglePet, "Control+Shift+1");
  assert.deepStrictEqual(calls.register.map((call) => call.accelerator), ["Control+Shift+1"]);
  assert.deepStrictEqual(calls.unregister, ["CommandOrControl+J"]);
  assert.deepStrictEqual([...registered].sort(), ["Control+Shift+1"]);
});

test("settings shortcut actions reject contextual conflicts before touching globalShortcut", () => {
  const snapshot = prefs.getDefaults();
  const { deps, calls } = makeDeps({ snapshot });

  const result = shortcutCommands.registerShortcut({
    actionId: "permissionAllow",
    accelerator: snapshot.shortcuts.permissionDeny,
  }, deps);

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /already bound to permissionDeny/);
  assert.deepStrictEqual(calls.register, []);
  assert.deepStrictEqual(calls.unregister, []);
});

test("settings shortcut actions treat Control and CommandOrControl as equivalent off macOS", () => {
  const snapshot = prefs.validate({
    shortcuts: {
      permissionDeny: "Control+Shift+K",
    },
  });
  const { deps, calls } = makeDeps({ snapshot, platform: "win32" });

  const result = shortcutCommands.registerShortcut({
    actionId: "permissionAllow",
    accelerator: "CommandOrControl+Shift+K",
  }, deps);

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /already bound to permissionDeny/);
  assert.deepStrictEqual(calls.register, []);
  assert.deepStrictEqual(calls.unregister, []);
});

test("settings shortcut actions reject dangerous accelerators after non-macOS folding", () => {
  const { deps, calls } = makeDeps({ platform: "linux" });

  const result = shortcutCommands.registerShortcut({
    actionId: "togglePet",
    accelerator: "CommandOrControl+Control+C",
  }, deps);

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /reserved accelerator/);
  assert.deepStrictEqual(calls.register, []);
  assert.deepStrictEqual(calls.unregister, []);
});

test("settings shortcut actions preserve combined Command and Control on macOS", () => {
  const snapshot = prefs.validate({
    shortcuts: {
      permissionAllow: null,
    },
  });
  const { deps } = makeDeps({ snapshot, platform: "darwin" });

  const result = shortcutCommands.registerShortcut({
    actionId: "permissionAllow",
    accelerator: "CommandOrControl+Control+C",
  }, deps);

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(
    result.commit.shortcuts.permissionAllow,
    "CommandOrControl+Control+C"
  );
});

test("settings shortcut actions treat an alias-only non-macOS rebind as a no-op", () => {
  const snapshot = prefs.getDefaults();
  snapshot.shortcuts.togglePet = "Control+Shift+K";
  const { deps, calls, registered } = makeDeps({
    snapshot,
    platform: "win32",
    registered: [snapshot.shortcuts.togglePet],
  });

  const result = shortcutCommands.registerShortcut({
    actionId: "togglePet",
    accelerator: "CommandOrControl+Shift+K",
  }, deps);

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.noop, true);
  assert.deepStrictEqual(calls.register, []);
  assert.deepStrictEqual(calls.unregister, []);
  assert.deepStrictEqual([...registered], ["Control+Shift+K"]);
});

test("reset all rolls back an earlier persistent shortcut when a later one fails", () => {
  const snapshot = prefs.validate({
    shortcuts: {
      togglePet: "CommandOrControl+J",
      quickSelectSession: "CommandOrControl+Shift+J",
    },
  });
  const { deps, calls, registered } = makeDeps({
    snapshot,
    registered: [snapshot.shortcuts.togglePet, snapshot.shortcuts.quickSelectSession],
    failUnregister: new Set([snapshot.shortcuts.quickSelectSession]),
  });

  const result = shortcutCommands.resetAllShortcuts(null, deps);

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /quickSelectSession/);
  assert.deepStrictEqual([...registered].sort(), [
    "CommandOrControl+J",
    "CommandOrControl+Shift+J",
  ]);
  assert.deepStrictEqual(calls.register.map((call) => call.accelerator), [
    "CommandOrControl+Shift+Alt+C",
    "CommandOrControl+J",
  ]);
  assert.deepStrictEqual(calls.unregister, [
    "CommandOrControl+J",
    "CommandOrControl+Shift+J",
    "CommandOrControl+Shift+Alt+C",
  ]);
});
