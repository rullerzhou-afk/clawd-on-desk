"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const { registerRemoteSshIpc: registerRemoteSshIpcReal } = require("../src/remote-ssh-ipc");
const { commandRegistry } = require("../src/settings-actions");
const { REMOTE_IDENTITY_STEP_NAMES } = require("../src/remote-ssh-profile");

const TEST_INSTALL_ID = "a".repeat(64);
function registerRemoteSshIpc(options) {
  return registerRemoteSshIpcReal({
    getInstallationIdentity: () => ({ installId: TEST_INSTALL_ID }),
    enableProfileIsolation: true,
    finalizeRetiredRemoteLayoutFn: async () => ({ ok: true }),
    ...options,
  });
}

// Build a fake child that emulates the new tryLaunch contract: it emits
// 'spawn' on the next tick by default; pass { error: <Error> } to make it
// emit 'error' instead. unref is a no-op.
function makeFakeSpawnChild({ error = null } = {}) {
  const child = new EventEmitter();
  child.unref = () => {};
  child.kill = () => {};
  queueMicrotask(() => {
    if (error) child.emit("error", error);
    else child.emit("spawn");
  });
  return child;
}

// Convenience: spawn function that always succeeds and records calls.
function makeSucceedingSpawn() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return makeFakeSpawnChild();
  };
  return { spawn, calls };
}

function mockIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, listener) => handlers.set(channel, listener),
    removeHandler: (channel) => handlers.delete(channel),
    invoke: async (channel, payload) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return await fn({}, payload);
    },
    handlers,
  };
}

function mockBrowserWindow() {
  const sentMessages = [];
  const fakeBw = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => sentMessages.push({ channel, payload }),
    },
  };
  return {
    BrowserWindow: { getAllWindows: () => [fakeBw] },
    sentMessages,
  };
}

function mockSettingsController(profiles = [], applyCommandImpl = null) {
  const commandCalls = [];
  let currentProfiles = profiles.map((profile) => ({ ...profile }));
  return {
    getSnapshot: () => ({ remoteSsh: { installId: TEST_INSTALL_ID, profiles: currentProfiles } }),
    applyCommand: async (action, args) => {
      commandCalls.push({ action, args });
      if (action === "remoteSsh.beginIdentityRotation") {
        currentProfiles = currentProfiles.map((profile) => profile.id === args.id
          ? {
              ...profile,
              runtimeMode: profile.runtimeMode || "account-default",
              runtimeKey: profile.runtimeKey || "account-default",
              layoutVersion: profile.layoutVersion || 1,
              identityTxn: {
                runtimeKey: profile.runtimeKey || "account-default",
                layoutVersion: profile.layoutVersion || 1,
                phase: "rotating",
                fromNonce: null,
                toNonce: "b".repeat(32),
                startedAt: 1,
                previousExpiresAt: 900001,
                steps: {},
              },
            }
          : profile);
        return { status: "ok" };
      }
      if (action === "remoteSsh.updateIdentityStep"
        || action === "remoteSsh.commitIdentityRotation") {
        return { status: "ok" };
      }
      if (action === "remoteSsh.beginRuntimeModeSwitch") {
        currentProfiles = currentProfiles.map((profile) => {
          if (profile.id !== args.id || profile.runtimeModeTxn) return profile;
          return {
            ...profile,
            runtimeModeTxn: {
              fromMode: profile.runtimeMode || "account-default",
              fromKey: profile.runtimeKey || "account-default",
              toMode: args.runtimeMode,
              toKey: args.runtimeKey,
              layoutVersion: 1,
              phase: "prepared",
              startedAt: 1,
            },
          };
        });
        return { status: "ok" };
      }
      if (action === "remoteSsh.advanceRuntimeModeSwitch") {
        currentProfiles = currentProfiles.map((profile) => profile.id === args.id
          ? {
              ...profile,
              runtimeModeTxn: {
                ...profile.runtimeModeTxn,
                phase: args.phase,
              },
            }
          : profile);
        return { status: "ok" };
      }
      if (action === "remoteSsh.switchRuntimeMode") {
        currentProfiles = currentProfiles.map((profile) => {
          if (profile.id !== args.id || !profile.runtimeModeTxn) return profile;
          const next = {
            ...profile,
            runtimeMode: profile.runtimeModeTxn.toMode,
            runtimeKey: profile.runtimeModeTxn.toKey,
            managedDeployTargets: [],
            isolatedActive: false,
          };
          delete next.runtimeModeTxn;
          return next;
        });
        return { status: "ok" };
      }
      if (applyCommandImpl) return applyCommandImpl(action, args);
      return { status: "ok" };
    },
    _commandCalls: commandCalls,
  };
}

function actionBackedSettingsController(profiles = [], { failOnce = null } = {}) {
  let snapshot = {
    remoteSsh: {
      installId: TEST_INSTALL_ID,
      profiles: profiles.map((profile) => ({ ...profile })),
    },
  };
  const commandCalls = [];
  let failed = false;
  return {
    getSnapshot: () => snapshot,
    applyCommand: async (action, args) => {
      commandCalls.push({ action, args });
      if (!failed && typeof failOnce === "function" && failOnce(action, args)) {
        failed = true;
        return { status: "error", message: "injected durable-write failure" };
      }
      const command = commandRegistry[action];
      if (typeof command !== "function") return { status: "ok" };
      const result = command(args, { snapshot });
      if (result && result.commit) {
        snapshot = { ...snapshot, ...result.commit };
      }
      return result;
    },
    _commandCalls: commandCalls,
  };
}

function mockRuntime() {
  const rt = new EventEmitter();
  rt.connect = () => null;
  rt.disconnect = (id) => ({ profileId: id, status: "idle" });
  rt.cleanup = () => {};
  rt.getProfileStatus = (id) => ({ profileId: id, status: "idle" });
  rt.listStatuses = () => [];
  return rt;
}

const baseProfile = {
  id: "p1",
  label: "My Pi",
  host: "user@pi",
  remoteForwardPort: 23333,
  autoStartCodexMonitor: false,
  connectOnLaunch: false,
};

function ownedTarget(overrides = {}) {
  return {
    host: "user@pi",
    remoteForwardPort: 23333,
    deployedAt: 12345,
    profileId: "p1",
    installId: TEST_INSTALL_ID,
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    layoutVersion: 1,
    remoteHome: "/home/user",
    ...overrides,
  };
}

// ── Required deps ──

test("registerRemoteSshIpc requires ipcMain", () => {
  assert.throws(() => registerRemoteSshIpc({}), /ipcMain/);
});

// ── status-changed → broadcast ──

test("runtime status-changed event broadcasts to all renderer windows", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow, sentMessages } = mockBrowserWindow();
  const rt = mockRuntime();
  const settingsController = mockSettingsController();

  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController,
    remoteSshRuntime: rt,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });
  rt.emit("status-changed", { profileId: "p1", status: "connected" });
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].channel, "remoteSsh:status-changed");
  assert.equal(sentMessages[0].payload.status, "connected");

  ipc.dispose();
});

test("runtime progress event broadcasts on remoteSsh:progress channel", () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow, sentMessages } = mockBrowserWindow();
  const rt = mockRuntime();
  const settingsController = mockSettingsController();
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController,
    remoteSshRuntime: rt,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });
  rt.emit("progress", { profileId: "p1", step: "scp", status: "ok" });
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].channel, "remoteSsh:progress");
  assert.equal(sentMessages[0].payload.step, "scp");
  ipc.dispose();
});

// ── status / list-statuses ──

test("remoteSsh:list-statuses returns runtime list", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const rt = mockRuntime();
  rt.listStatuses = () => [{ profileId: "p1", status: "connected" }];
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController(),
    remoteSshRuntime: rt,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });
  const r = await ipcMain.invoke("remoteSsh:list-statuses", null);
  assert.equal(r.status, "ok");
  assert.equal(r.statuses[0].status, "connected");
  assert.deepEqual(r.bindingSecurity, {
    strongStorage: false,
    storageBackend: "unknown",
  });
  ipc.dispose();
});

test("remoteSsh:status returns single profile state", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const rt = mockRuntime();
  rt.getProfileStatus = (id) => ({ profileId: id, status: "connecting" });
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController(),
    remoteSshRuntime: rt,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });
  const r = await ipcMain.invoke("remoteSsh:status", "p1");
  assert.equal(r.status, "ok");
  assert.equal(r.state.profileId, "p1");
  assert.equal(r.state.status, "connecting");
  ipc.dispose();
});

test("remoteSsh:status rejects missing profileId", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController(),
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });
  const r = await ipcMain.invoke("remoteSsh:status", null);
  assert.equal(r.status, "error");
  ipc.dispose();
});

// ── connect / disconnect ──

test("remoteSsh:connect calls runtime.connect with the resolved profile", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const rt = mockRuntime();
  let connectArg = null;
  rt.connect = (p) => { connectArg = p; };
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([baseProfile]),
    remoteSshRuntime: rt,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });
  const r = await ipcMain.invoke("remoteSsh:connect", "p1");
  assert.equal(r.status, "ok");
  assert.equal(connectArg.id, "p1");
  ipc.dispose();
});

test("remoteSsh:connect 404 when profile not in snapshot", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([]),
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });
  const r = await ipcMain.invoke("remoteSsh:connect", "ghost");
  assert.equal(r.status, "error");
  assert.match(r.message, /profile not found/);
  ipc.dispose();
});

// ── connect-on-launch sweep ──

test("connectOnLaunchProfiles connects only flagged profiles", () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const rt = mockRuntime();
  const connected = [];
  rt.connect = (p) => { connected.push(p.id); };
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([
      { ...baseProfile, id: "p1", connectOnLaunch: true },
      { ...baseProfile, id: "p2", connectOnLaunch: false },
      { ...baseProfile, id: "p3", connectOnLaunch: true },
    ]),
    remoteSshRuntime: rt,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });
  const started = ipc.connectOnLaunchProfiles();
  assert.deepEqual(started, ["p1", "p3"]);
  assert.deepEqual(connected, ["p1", "p3"]);
  ipc.dispose();
});

test("connectOnLaunchProfiles keeps going when one connect throws", () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const rt = mockRuntime();
  const connected = [];
  rt.connect = (p) => {
    if (p.id === "p1") throw new Error("boom");
    connected.push(p.id);
  };
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([
      { ...baseProfile, id: "p1", connectOnLaunch: true },
      { ...baseProfile, id: "p2", connectOnLaunch: true },
    ]),
    remoteSshRuntime: rt,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });
  const started = ipc.connectOnLaunchProfiles();
  assert.deepEqual(started, ["p2"]);
  assert.deepEqual(connected, ["p2"]);
  ipc.dispose();
});

test("remoteSsh:disconnect requires profileId", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController(),
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });
  const r = await ipcMain.invoke("remoteSsh:disconnect", null);
  assert.equal(r.status, "error");
  ipc.dispose();
});

test("remoteSsh:disconnect calls runtime.disconnect with id", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const rt = mockRuntime();
  let disconnectId = null;
  rt.disconnect = (id) => { disconnectId = id; return { profileId: id, status: "idle" }; };
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([baseProfile]),
    remoteSshRuntime: rt,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });
  await ipcMain.invoke("remoteSsh:disconnect", "p1");
  assert.equal(disconnectId, "p1");
  ipc.dispose();
});

// ── Cleanup (profile deletion) ──

test("remoteSsh:cleanup disconnects and runs one ownership-gated uninstall transaction", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const rt = mockRuntime();
  let disconnectId = null;
  rt.disconnect = (id) => { disconnectId = id; return { profileId: id, status: "idle" }; };
  const uninstalled = [];
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([{
      ...baseProfile,
      managedDeployTargets: [ownedTarget()],
    }]),
    remoteSshRuntime: rt,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    uninstallRemoteIntegrationsFn: async ({ profile }) => { uninstalled.push(profile.id); return { ok: true }; },
  });

  const r = await ipcMain.invoke("remoteSsh:cleanup", "p1");

  assert.equal(r.status, "ok");
  assert.equal(r.uninstalled, true);
  assert.equal(disconnectId, "p1");
  assert.deepEqual(uninstalled, ["p1"]);
  ipc.dispose();
});

test("remoteSsh:cleanup stays ok when the remote uninstall fails (best-effort)", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([{
      ...baseProfile,
      managedDeployTargets: [ownedTarget()],
    }]),
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    stopCodexMonitorFn: async () => ({ ok: true }),
    uninstallRemoteIntegrationsFn: async () => { throw new Error("host unreachable"); },
  });

  const r = await ipcMain.invoke("remoteSsh:cleanup", "p1");

  assert.equal(r.status, "ok");
  assert.equal(r.uninstalled, false);
  ipc.dispose();
});

test("remoteSsh:cleanup never mutates a never-deployed remote", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  let stopped = 0;
  let uninstalled = 0;
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([baseProfile]),
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    stopCodexMonitorFn: async () => { stopped += 1; return { ok: true }; },
    uninstallRemoteIntegrationsFn: async () => { uninstalled += 1; return { ok: true }; },
  });

  const r = await ipcMain.invoke("remoteSsh:cleanup", "p1");
  assert.equal(r.status, "ok");
  assert.equal(r.skipped, "not-owned");
  assert.equal(stopped, 0);
  assert.equal(uninstalled, 0);
  ipc.dispose();
});

test("remoteSsh:cleanup preserves a shared remote still owned by another profile", async () => {
  const target = ownedTarget();
  const sibling = {
    ...baseProfile,
    id: "p2",
    label: "Same Pi",
    managedDeployTargets: [{ ...target, deployedAt: 23456 }],
  };
  let uninstalled = 0;
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([
      { ...baseProfile, managedDeployTargets: [target] },
      sibling,
    ]),
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    uninstallRemoteIntegrationsFn: async () => { uninstalled += 1; return { ok: true }; },
  });

  const r = await ipcMain.invoke("remoteSsh:cleanup", "p1");
  assert.equal(r.status, "ok");
  assert.equal(r.skipped, "shared-owner");
  assert.equal(r.shared, 1);
  assert.equal(uninstalled, 0);
  ipc.dispose();
});

test("remoteSsh:cleanup treats different isolated runtime keys on one account as separate ownership domains", async () => {
  const targetA = ownedTarget({
    runtimeMode: "profile-isolated",
    runtimeKey: "runtime_a",
    remoteHome: "/home/shared",
  });
  const targetB = ownedTarget({
    profileId: "p2",
    runtimeMode: "profile-isolated",
    runtimeKey: "runtime_b",
    remoteHome: "/home/shared",
    deployedAt: 23456,
  });
  const cleaned = [];
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([
      {
        ...baseProfile,
        runtimeMode: "profile-isolated",
        runtimeKey: "runtime_a",
        layoutVersion: 1,
        managedDeployTargets: [targetA],
      },
      {
        ...baseProfile,
        id: "p2",
        label: "Same account, another isolated root",
        runtimeMode: "profile-isolated",
        runtimeKey: "runtime_b",
        layoutVersion: 1,
        managedDeployTargets: [targetB],
      },
    ]),
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    uninstallRemoteIntegrationsFn: async ({ profile }) => {
      cleaned.push(profile.runtimeKey);
      return { ok: true };
    },
  });

  const result = await ipcMain.invoke("remoteSsh:cleanup", "p1");
  assert.equal(result.status, "ok");
  assert.equal(result.attempted, 1);
  assert.equal(result.shared, 0);
  assert.deepEqual(cleaned, ["runtime_a"]);
  ipc.dispose();
});

test("remoteSsh:cleanup uses the deployed target after the profile was edited", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const cleanedHosts = [];
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([{
      ...baseProfile,
      host: "user@new-host",
      managedDeployTargets: [ownedTarget({ host: "user@old-host" })],
    }]),
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    stopCodexMonitorFn: async () => ({ ok: true }),
    uninstallRemoteIntegrationsFn: async ({ profile }) => {
      cleanedHosts.push(profile.host);
      return { ok: true };
    },
  });

  const r = await ipcMain.invoke("remoteSsh:cleanup", "p1");
  assert.equal(r.uninstalled, true);
  assert.deepEqual(cleanedHosts, ["user@old-host"]);
  ipc.dispose();
});

test("remoteSsh:cleanup errors on unknown profile", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController(),
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });
  const r = await ipcMain.invoke("remoteSsh:cleanup", "nope");
  assert.equal(r.status, "error");
  ipc.dispose();
});

test("remoteSsh:cleanup rejects an active identity transaction before remote mutation", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  let disconnected = false;
  const runtime = mockRuntime();
  runtime.disconnect = () => { disconnected = true; };
  const profile = {
    ...baseProfile,
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    layoutVersion: 1,
    managedDeployTargets: [ownedTarget()],
    identityTxn: {
      runtimeKey: "account-default",
      layoutVersion: 1,
      phase: "rotating",
      fromNonce: null,
      toNonce: "b".repeat(32),
      startedAt: 1,
      previousExpiresAt: 100,
      steps: {},
    },
  };
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([profile]),
    remoteSshRuntime: runtime,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });
  const result = await ipcMain.invoke("remoteSsh:cleanup", "p1");
  assert.equal(result.reason, "identity_transaction_in_progress");
  assert.equal(disconnected, false);
  ipc.dispose();
});

test("remoteSsh:cleanup never treats a copied deployment ledger as current-install authority", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  let uninstalled = 0;
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([{
      ...baseProfile,
      managedDeployTargets: [ownedTarget({ installId: "d".repeat(64) })],
    }]),
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    uninstallRemoteIntegrationsFn: async () => {
      uninstalled += 1;
      return { ok: true };
    },
  });

  const result = await ipcMain.invoke("remoteSsh:cleanup", "p1");
  assert.equal(result.status, "ok");
  assert.equal(result.uninstalled, false);
  assert.equal(result.attempted, 1);
  assert.equal(uninstalled, 0);
  ipc.dispose();
});

test("remoteSsh:force-revoke disconnects first, persists revocation, and refreshes runtime state", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const runtime = mockRuntime();
  const disconnected = [];
  const refreshed = [];
  runtime.disconnect = (id) => { disconnected.push(id); };
  runtime.refreshProfile = (profile) => { refreshed.push(profile); return true; };
  const controller = actionBackedSettingsController([{
    ...baseProfile,
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    layoutVersion: 1,
    routingNonce: "b".repeat(32),
    previousNonce: "a".repeat(32),
    previousExpiresAt: Date.now() + 60_000,
    identityTxn: {
      runtimeKey: "account-default",
      layoutVersion: 1,
      phase: "rotating",
      fromNonce: "a".repeat(32),
      toNonce: "b".repeat(32),
      startedAt: 1,
      previousExpiresAt: Date.now() + 60_000,
      steps: {},
    },
  }]);
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: controller,
    remoteSshRuntime: runtime,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });
  const denied = await ipcMain.invoke("remoteSsh:force-revoke", {
    profileId: "p1",
    mode: "old",
    confirmed: false,
  });
  assert.equal(denied.status, "error");
  const result = await ipcMain.invoke("remoteSsh:force-revoke", {
    profileId: "p1",
    mode: "old",
    confirmed: true,
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(disconnected, ["p1"]);
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].previousNonce, undefined);
  assert.equal(refreshed[0].identityTxn.fromNonce, null);
  ipc.dispose();
});

test("runtime mode switch cleans the owned old layout, bootstraps a fresh isolated root, then persists", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const settingsController = mockSettingsController([{
    ...baseProfile,
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    layoutVersion: 1,
    managedDeployTargets: [ownedTarget()],
  }]);
  const runtime = mockRuntime();
  const disconnected = [];
  runtime.disconnect = (id) => {
    disconnected.push(id);
    return { profileId: id, status: "idle" };
  };
  const cleanups = [];
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController,
    remoteSshRuntime: runtime,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    uninstallRemoteIntegrationsFn: async (options) => {
      cleanups.push(options.profile);
      return { ok: true };
    },
    bootstrapIsolatedRuntimeFn: async ({ runtimeKey }) => ({
      ok: true,
      layout: {
        runtimeRoot: `/home/user/.clawd/profiles/${runtimeKey}`,
      },
    }),
  });

  const result = await ipcMain.invoke("remoteSsh:set-runtime-mode", {
    profileId: "p1",
    runtimeMode: "profile-isolated",
    confirmed: true,
  });
  assert.equal(result.status, "ok");
  assert.match(result.runtimeKey, /^rt_[a-f0-9]{24}$/);
  assert.equal(result.runtimeRoot, `/home/user/.clawd/profiles/${result.runtimeKey}`);
  assert.deepEqual(disconnected, ["p1"]);
  assert.equal(cleanups.length, 1);
  assert.equal(cleanups[0].runtimeKey, "account-default");
  const switchCall = settingsController._commandCalls.find(
    (call) => call.action === "remoteSsh.switchRuntimeMode",
  );
  assert.deepEqual(switchCall.args, {
    id: "p1",
  });
  ipc.dispose();
});

test("runtime mode switch is confirmation-gated, transaction-gated, and single-flight", async () => {
  const profile = {
    ...baseProfile,
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    layoutVersion: 1,
    managedDeployTargets: [ownedTarget()],
  };
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const settingsController = mockSettingsController([profile]);
  let finishBootstrap;
  const bootstrapStarted = new Promise((resolve) => {
    finishBootstrap = resolve;
  });
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController,
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    uninstallRemoteIntegrationsFn: async () => ({ ok: true }),
    bootstrapIsolatedRuntimeFn: async ({ runtimeKey }) => {
      notifyStarted();
      await bootstrapStarted;
      return {
        ok: true,
        layout: { runtimeRoot: `/home/user/.clawd/profiles/${runtimeKey}` },
      };
    },
  });

  const unconfirmed = await ipcMain.invoke("remoteSsh:set-runtime-mode", {
    profileId: "p1",
    runtimeMode: "profile-isolated",
    confirmed: false,
  });
  assert.equal(unconfirmed.status, "error");

  const firstPromise = ipcMain.invoke("remoteSsh:set-runtime-mode", {
    profileId: "p1",
    runtimeMode: "profile-isolated",
    confirmed: true,
  });
  await started;
  const concurrent = await ipcMain.invoke("remoteSsh:set-runtime-mode", {
    profileId: "p1",
    runtimeMode: "profile-isolated",
    confirmed: true,
  });
  assert.equal(concurrent.reason, "runtime_mode_switch_in_progress");
  finishBootstrap();
  assert.equal((await firstPromise).status, "ok");
  ipc.dispose();

  const txnIpcMain = mockIpcMain();
  const txnController = mockSettingsController([{
    ...profile,
    identityTxn: { phase: "rotating" },
  }]);
  const txnIpc = registerRemoteSshIpc({
    ipcMain: txnIpcMain,
    settingsController: txnController,
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });
  const blocked = await txnIpcMain.invoke("remoteSsh:set-runtime-mode", {
    profileId: "p1",
    runtimeMode: "profile-isolated",
    confirmed: true,
  });
  assert.equal(blocked.status, "error");
  assert.match(blocked.message, /transaction/i);
  txnIpc.dispose();
});

test("runtime mode switch refuses to orphan an old layout without an ownership ledger", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  let bootstrapCalls = 0;
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([{
      ...baseProfile,
      runtimeMode: "account-default",
      runtimeKey: "account-default",
      layoutVersion: 1,
    }]),
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    bootstrapIsolatedRuntimeFn: async () => {
      bootstrapCalls += 1;
      return { ok: true };
    },
  });

  const result = await ipcMain.invoke("remoteSsh:set-runtime-mode", {
    profileId: "p1",
    runtimeMode: "profile-isolated",
    confirmed: true,
  });
  assert.equal(result.status, "error");
  assert.equal(result.reason, "old_layout_ownership_missing");
  assert.equal(bootstrapCalls, 0);
  ipc.dispose();
});

test("runtime mode switch resumes the same runtimeKey after bootstrap-to-prefs interruption", async () => {
  const target = ownedTarget();
  const profile = {
    ...baseProfile,
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    layoutVersion: 1,
    managedDeployTargets: [target],
  };
  const settingsController = actionBackedSettingsController([profile], {
    failOnce: (action, args) =>
      action === "remoteSsh.advanceRuntimeModeSwitch"
      && args.phase === "bootstrap-done",
  });
  let cleanupCalls = 0;
  const bootstrapKeys = [];
  const common = {
    settingsController,
    remoteSshRuntime: mockRuntime(),
    BrowserWindow: mockBrowserWindow().BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    uninstallRemoteIntegrationsFn: async ({ preserveIdentity }) => {
      cleanupCalls += 1;
      assert.equal(preserveIdentity, true);
      return { ok: true };
    },
    finalizeRetiredRemoteLayoutFn: async () => ({ ok: true }),
    bootstrapIsolatedRuntimeFn: async ({ runtimeKey }) => {
      bootstrapKeys.push(runtimeKey);
      return {
        ok: true,
        layout: { runtimeRoot: `/home/user/.clawd/profiles/${runtimeKey}` },
      };
    },
  };

  const firstIpcMain = mockIpcMain();
  const firstIpc = registerRemoteSshIpc({ ipcMain: firstIpcMain, ...common });
  const first = await firstIpcMain.invoke("remoteSsh:set-runtime-mode", {
    profileId: "p1",
    runtimeMode: "profile-isolated",
    confirmed: true,
  });
  assert.equal(first.status, "error");
  assert.match(first.message, /durable-write failure/i);
  const pending = settingsController.getSnapshot().remoteSsh.profiles[0].runtimeModeTxn;
  assert.equal(pending.phase, "cleanup-done");
  assert.match(pending.toKey, /^rt_[a-f0-9]{24}$/);
  firstIpc.dispose();

  const secondIpcMain = mockIpcMain();
  const secondIpc = registerRemoteSshIpc({ ipcMain: secondIpcMain, ...common });
  const second = await secondIpcMain.invoke("remoteSsh:set-runtime-mode", {
    profileId: "p1",
    runtimeMode: "profile-isolated",
    confirmed: true,
  });
  assert.equal(second.status, "ok");
  assert.deepEqual(bootstrapKeys, [pending.toKey, pending.toKey]);
  assert.equal(cleanupCalls, 1, "durably completed cleanup must not rerun");
  const switched = settingsController.getSnapshot().remoteSsh.profiles[0];
  assert.equal(switched.runtimeMode, "profile-isolated");
  assert.equal(switched.runtimeKey, pending.toKey);
  assert.equal(switched.runtimeModeTxn, undefined);
  assert.equal(
    settingsController._commandCalls.filter((call) =>
      call.action === "remoteSsh.beginRuntimeModeSwitch").length,
    1,
    "retry must resume instead of minting a second transaction",
  );
  secondIpc.dispose();
});

test("isolated to account-default cleanup never deletes the retained runtime root", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const target = ownedTarget({
    runtimeMode: "profile-isolated",
    runtimeKey: "rt_existing",
    remoteHome: "/home/user",
  });
  const settingsController = mockSettingsController([{
    ...baseProfile,
    runtimeMode: "profile-isolated",
    runtimeKey: "rt_existing",
    layoutVersion: 1,
    isolatedActive: true,
    managedDeployTargets: [target],
  }]);
  const seen = [];
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController,
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    uninstallRemoteIntegrationsFn: async ({ profile }) => {
      seen.push(profile);
      return { ok: true };
    },
    bootstrapIsolatedRuntimeFn: async () => {
      throw new Error("account-default switch must not bootstrap or delete an isolated root");
    },
  });
  const result = await ipcMain.invoke("remoteSsh:set-runtime-mode", {
    profileId: "p1",
    runtimeMode: "account-default",
    confirmed: true,
  });
  assert.equal(result.status, "ok");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].runtimeKey, "rt_existing");
  assert.equal(result.runtimeRoot, null);
  ipc.dispose();
});

test("profile isolation stays release-gated until the real SSH and CLI matrix is enabled", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const profile = {
    ...baseProfile,
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    layoutVersion: 1,
  };
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([profile]),
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    enableProfileIsolation: false,
  });
  const statuses = await ipcMain.invoke("remoteSsh:list-statuses");
  assert.equal(statuses.profileIsolationAvailable, false);
  const result = await ipcMain.invoke("remoteSsh:set-runtime-mode", {
    profileId: profile.id,
    runtimeMode: "profile-isolated",
    confirmed: true,
  });
  assert.equal(result.status, "error");
  assert.equal(result.reason, "profile_isolation_validation_pending");
  ipc.dispose();

  const isolatedIpcMain = mockIpcMain();
  const isolatedRuntime = mockRuntime();
  let connects = 0;
  let deploys = 0;
  isolatedRuntime.connect = () => { connects += 1; };
  const isolated = {
    ...profile,
    runtimeMode: "profile-isolated",
    runtimeKey: "runtime_a",
    isolatedActive: true,
    connectOnLaunch: true,
  };
  const isolatedIpc = registerRemoteSshIpc({
    ipcMain: isolatedIpcMain,
    settingsController: mockSettingsController([isolated]),
    remoteSshRuntime: isolatedRuntime,
    BrowserWindow,
    enableProfileIsolation: false,
    deployFn: async () => {
      deploys += 1;
      return { ok: true };
    },
  });
  const connect = await isolatedIpcMain.invoke("remoteSsh:connect", isolated.id);
  assert.equal(connect.status, "error");
  assert.match(connect.message, /validation matrix/i);
  isolatedIpc.connectOnLaunchProfiles();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connects, 0);
  const deploy = await isolatedIpcMain.invoke("remoteSsh:deploy", isolated.id);
  assert.equal(deploy.status, "error");
  assert.equal(deploy.reason, "profile_isolation_validation_pending");
  assert.equal(deploys, 0);
  isolatedIpc.dispose();
});

// ── Deploy stamp ──

test("remoteSsh:deploy stamps via markDeployed (not full update) on success", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const settingsController = mockSettingsController([baseProfile]);
  const before = Date.now();
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController,
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    // Inject a fake deploy that just resolves ok — we're testing the
    // post-success commit, not the deploy steps themselves.
    deployFn: async () => ({
      ok: true,
      remoteNode: {
        nodeBin: "/usr/local/bin/node",
        version: "v20.10.0",
        source: "path",
      },
    }),
  });
  const r = await ipcMain.invoke("remoteSsh:deploy", "p1");
  assert.equal(r.status, "ok");
  const markCall = settingsController._commandCalls.find((call) => call.action === "remoteSsh.markDeployed");
  assert.ok(markCall, "secure deploy must stamp with markDeployed before transaction commit");
  const markIndex = settingsController._commandCalls.findIndex(
    (call) => call.action === "remoteSsh.markDeployed"
  );
  const commitIndex = settingsController._commandCalls.findIndex(
    (call) => call.action === "remoteSsh.commitIdentityRotation"
  );
  assert.ok(markIndex >= 0 && commitIndex > markIndex,
    "deployment ownership must be durable before the identity transaction commits");
  assert.equal(settingsController._commandCalls.some((call) => call.action === "remoteSsh.update"), false);
  assert.equal(markCall.action, "remoteSsh.markDeployed",
    "deploy stamp must use markDeployed, not full-profile update");
  const args = markCall.args;
  assert.equal(args.id, "p1");
  assert.ok(Number.isFinite(args.deployedAt));
  assert.ok(args.deployedAt >= before);
  assert.ok(args.deployedAt <= Date.now());
  // expectedTarget fingerprint captured at deploy start.
  assert.ok(args.expectedTarget, "must pass expectedTarget for drift detection");
  assert.equal(args.expectedTarget.host, "user@pi");
  assert.equal(args.expectedTarget.remoteForwardPort, 23333);
  assert.equal(args.remoteNode.nodeBin, "/usr/local/bin/node");
  assert.equal(args.remoteNode.version, "v20.10.0");
  // The full profile snapshot must NOT be in the args — that would defeat
  // the lost-update fix.
  assert.equal(args.label, undefined,
    "markDeployed args must not carry full profile fields like label");
  ipc.dispose();
});

test("a real deploy reducer preserves installation binding so connect works without restart", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const settingsController = actionBackedSettingsController([{
    ...baseProfile,
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    layoutVersion: 1,
  }]);
  const runtime = mockRuntime();
  let connects = 0;
  runtime.connect = () => { connects += 1; };
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController,
    remoteSshRuntime: runtime,
    BrowserWindow,
    deployFn: async ({ deps }) => {
      for (const step of REMOTE_IDENTITY_STEP_NAMES) {
        await deps.onIdentityStep(step, { status: "done" });
      }
      return {
        ok: true,
        layout: { remoteHome: "/home/remote-user" },
      };
    },
  });

  const deployed = await ipcMain.invoke("remoteSsh:deploy", "p1");
  assert.equal(deployed.status, "ok");
  assert.equal(settingsController.getSnapshot().remoteSsh.installId, TEST_INSTALL_ID);
  const connected = await ipcMain.invoke("remoteSsh:connect", "p1");
  assert.equal(connected.status, "ok");
  assert.equal(connects, 1);
  ipc.dispose();
});

test("remoteSsh:deploy expectedTarget carries every deploy-target field (chainStatusline false-drift regression)", async () => {
  // Regression: expectedTarget is a hand-built field list. When
  // chainStatusline joined DEPLOY_TARGET_FIELDS but not this list, every
  // deploy of a chain-enabled profile false-positived as target drift
  // ("deployed with previous settings — redeploy" on each run).
  const { DEPLOY_TARGET_FIELDS, deployTargetFingerprint, deployTargetDrift } =
    require("../src/remote-ssh-profile");
  const profile = { ...baseProfile, chainStatusline: true };
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const settingsController = mockSettingsController([profile]);
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController,
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    deployFn: async () => ({ ok: true }),
  });

  const r = await ipcMain.invoke("remoteSsh:deploy", "p1");

  assert.equal(r.status, "ok");
  assert.equal(r.warning, undefined, "unchanged profile must not report drift");
  const args = settingsController._commandCalls.find(
    (call) => call.action === "remoteSsh.markDeployed"
  ).args;
  for (const f of DEPLOY_TARGET_FIELDS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(args.expectedTarget, f),
      `expectedTarget missing deploy-target field: ${f}`
    );
  }
  assert.equal(
    deployTargetDrift(deployTargetFingerprint(args.expectedTarget), deployTargetFingerprint(profile)),
    null,
    "expectedTarget must fingerprint identically to the unchanged profile"
  );
  ipc.dispose();
});

test("runtime remote-node-detected event stamps profile node metadata", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const rt = mockRuntime();
  const settingsController = mockSettingsController([baseProfile]);
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController,
    remoteSshRuntime: rt,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });

  rt.emit("remote-node-detected", {
    id: "p1",
    nodeBin: "/home/me/.nvm/versions/node/v22/bin/node",
    version: "v22.1.0",
    source: "shell:/bin/bash",
    detectedAt: 12345,
    expectedTarget: {
      host: "user@pi",
      remoteForwardPort: 23333,
    },
  });
  await new Promise((r) => setImmediate(r));

  assert.equal(settingsController._commandCalls.length, 1);
  assert.equal(settingsController._commandCalls[0].action, "remoteSsh.markRemoteNode");
  assert.equal(settingsController._commandCalls[0].args.nodeBin, "/home/me/.nvm/versions/node/v22/bin/node");
  ipc.dispose();
});

test("remoteSsh:deploy returns target_drift warning when markDeployed sees drift", async () => {
  // If the user edits host/port/identityFile/remoteForwardPort/hostPrefix
  // mid-deploy, markDeployed no-ops with reason=target_drift. The IPC layer
  // must surface this to the renderer as a warning so the UI can prompt the
  // user to redeploy — otherwise deploy silently "succeeds" against the old
  // config but the new config is left without hooks.
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const settingsController = mockSettingsController([baseProfile], async (action) => {
    if (action === "remoteSsh.markDeployed") {
      return {
        status: "ok",
        noop: true,
        reason: "target_drift",
        targetDrift: "host",
      };
    }
    return { status: "ok" };
  });
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController,
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    deployFn: async () => ({ ok: true }),
  });
  const r = await ipcMain.invoke("remoteSsh:deploy", "p1");
  assert.equal(r.status, "ok");
  assert.equal(r.warning, "target_drift",
    "drift must be surfaced as warning so UI can prompt redeploy");
  assert.equal(r.driftedField, "host");
  ipc.dispose();
});

test("remoteSsh:deploy keeps the identity transaction resumable when markDeployed returns error", async () => {
  // applyCommand returns { status:"error" } for validator/persist failures
  // WITHOUT throwing — easy to miss. If we don't surface this, the UI shows
  // "Deploy succeeded" but lastDeployedAt is silently never written, so the
  // profile card keeps saying "never deployed".
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const settingsController = mockSettingsController([baseProfile], async (action) => {
    if (action === "remoteSsh.markDeployed") {
      return { status: "error", message: "persist failed: ENOSPC" };
    }
    return { status: "ok" };
  });
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController,
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    deployFn: async () => ({ ok: true }),
  });
  const r = await ipcMain.invoke("remoteSsh:deploy", "p1");
  assert.equal(r.status, "error");
  assert.equal(r.step, "deployment-stamp");
  assert.match(r.message, /persist failed/);
  assert.equal(
    settingsController._commandCalls.some((call) => call.action === "remoteSsh.commitIdentityRotation"),
    false,
    "A→B must not commit until deployment ownership is durable"
  );
  ipc.dispose();
});

test("remoteSsh:deploy keeps the identity transaction resumable when markDeployed throws", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const settingsController = mockSettingsController([baseProfile], async () => {
    throw new Error("controller exploded");
  });
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController,
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    deployFn: async () => ({ ok: true }),
  });
  const r = await ipcMain.invoke("remoteSsh:deploy", "p1");
  assert.equal(r.status, "error");
  assert.equal(r.step, "deployment-stamp");
  assert.match(r.message, /controller exploded/);
  assert.equal(
    settingsController._commandCalls.some((call) => call.action === "remoteSsh.commitIdentityRotation"),
    false
  );
  ipc.dispose();
});

test("remoteSsh:deploy retries the same nonce after deployment ownership persistence fails", async () => {
  const { REMOTE_IDENTITY_STEP_NAMES } = require("../src/remote-ssh-profile");
  const profile = {
    ...baseProfile,
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    layoutVersion: 1,
    routingNonce: "a".repeat(32),
  };
  const settingsController = actionBackedSettingsController([profile], {
    failOnce: (action) => action === "remoteSsh.markDeployed",
  });
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const attemptedNonces = [];
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController,
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    deployFn: async (options) => {
      attemptedNonces.push(options.identityTxn.toNonce);
      for (const step of REMOTE_IDENTITY_STEP_NAMES) {
        await options.deps.onIdentityStep(step, {
          status: "done",
          evidence: `${step} verified`,
        });
      }
      return {
        ok: true,
        layout: { remoteHome: "/home/user" },
      };
    },
  });

  const first = await ipcMain.invoke("remoteSsh:deploy", "p1");
  assert.equal(first.status, "error");
  assert.equal(first.step, "deployment-stamp");
  let persisted = settingsController.getSnapshot().remoteSsh.profiles[0];
  assert.equal(persisted.identityTxn.phase, "verifying");
  assert.equal(persisted.routingNonce, "a".repeat(32));

  const second = await ipcMain.invoke("remoteSsh:deploy", "p1");
  assert.equal(second.status, "ok");
  assert.equal(attemptedNonces.length, 2);
  assert.equal(attemptedNonces[1], attemptedNonces[0], "retry must resume A→B instead of minting C");
  persisted = settingsController.getSnapshot().remoteSsh.profiles[0];
  assert.equal(persisted.routingNonce, attemptedNonces[0]);
  assert.equal(persisted.identityTxn.phase, "committed");
  assert.equal(persisted.remoteHome, "/home/user");
  assert.equal(persisted.managedDeployTargets.length, 1);
  ipc.dispose();
});

test("remoteSsh:deploy on failure does NOT stamp lastDeployedAt", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const settingsController = mockSettingsController([baseProfile]);
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController,
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    deployFn: async () => ({ ok: false, step: "scp", message: "scp failed" }),
  });
  const r = await ipcMain.invoke("remoteSsh:deploy", "p1");
  assert.equal(r.status, "error");
  assert.equal(r.step, "scp");
  // The persisted identity transaction remains resumable, but no deploy stamp
  // may be written until every component verifies.
  assert.equal(
    settingsController._commandCalls.some((call) => call.action === "remoteSsh.markDeployed"),
    false,
  );
  ipc.dispose();
});

test("remoteSsh:deploy forwards legacy migration confirmation only from the structured payload", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const settingsController = mockSettingsController([baseProfile]);
  const seen = [];
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController,
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    deployFn: async (options) => {
      seen.push(options.legacyMigrationConfirmed);
      return {
        ok: false,
        step: "preflight",
        reason: "legacy_deployment_confirmation_required",
        message: "confirmation required",
      };
    },
  });

  const first = await ipcMain.invoke("remoteSsh:deploy", "p1");
  const second = await ipcMain.invoke("remoteSsh:deploy", {
    profileId: "p1",
    legacyMigrationConfirmed: true,
  });
  assert.equal(first.reason, "legacy_deployment_confirmation_required");
  assert.equal(second.reason, "legacy_deployment_confirmation_required");
  assert.deepEqual(seen, [false, true]);
  ipc.dispose();
});

test("remoteSsh:deploy on unknown profile id → error, no stamp", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const settingsController = mockSettingsController([]);
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController,
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });
  const r = await ipcMain.invoke("remoteSsh:deploy", "ghost");
  assert.equal(r.status, "error");
  assert.equal(settingsController._commandCalls.length, 0);
  ipc.dispose();
});

// ── Authenticate / Open Terminal ──

test("remoteSsh:authenticate spawns interactive ssh args (no -T, only BatchMode=no, no ConnectTimeout)", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return makeFakeSpawnChild(); // emits 'spawn' on next tick
  };
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([baseProfile]),
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    platform: "win32",
    spawn,
  });
  const r = await ipcMain.invoke("remoteSsh:authenticate", "p1");
  assert.equal(r.status, "ok");
  // First (and only) call should be wt.exe (it succeeded).
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "wt.exe");
  assert.equal(calls[0].args[0], "--");
  assert.equal(calls[0].args[1], "ssh");
  // Interactive ssh args MUST NOT include -T (would break remote pty).
  assert.equal(calls[0].args.includes("-T"), false, "Authenticate must drop -T");
  // ssh -o is first-wins (see remote-ssh-runtime.js for the long comment).
  // Interactive base is empty, so BatchMode=no from extraOpts is the ONLY
  // BatchMode token AND the first one ssh sees → effective config allows
  // password / passphrase / host-key prompts. This is the #348 fix.
  const bmTokens = calls[0].args.filter((v) => typeof v === "string" && v.startsWith("BatchMode="));
  assert.equal(bmTokens.length, 1, "interactive must carry only the explicit BatchMode=no");
  assert.equal(bmTokens[0], "BatchMode=no");
  // ConnectTimeout must NOT be in the interactive base — user controls the
  // pace, and we don't want a 15s ssh-level timeout fighting their typing.
  assert.equal(
    calls[0].args.some((v) => typeof v === "string" && v.startsWith("ConnectTimeout=")),
    false,
    "interactive must not carry ConnectTimeout"
  );
  ipc.dispose();
});

test("remoteSsh:open-terminal uses the same interactive ssh args contract as Authenticate", async () => {
  // open-terminal and authenticate share spawnSystemTerminalWithSsh, but pin
  // the contract on the open-terminal IPC entry so a future split can't
  // silently regress one without the other.
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return makeFakeSpawnChild();
  };
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([baseProfile]),
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    platform: "win32",
    spawn,
  });
  const r = await ipcMain.invoke("remoteSsh:open-terminal", "p1");
  assert.equal(r.status, "ok");
  assert.equal(calls[0].cmd, "wt.exe");
  assert.equal(calls[0].args.includes("-T"), false);
  const bmTokens = calls[0].args.filter((v) => typeof v === "string" && v.startsWith("BatchMode="));
  assert.equal(bmTokens.length, 1);
  assert.equal(bmTokens[0], "BatchMode=no");
  assert.equal(
    calls[0].args.some((v) => typeof v === "string" && v.startsWith("ConnectTimeout=")),
    false
  );
  ipc.dispose();
});

test("Windows: wt.exe missing → fall back to cmd.exe (real fallback chain)", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === "wt.exe") {
      // Simulate ENOENT — emits async 'error' event.
      return makeFakeSpawnChild({
        error: Object.assign(new Error("spawn wt.exe ENOENT"), { code: "ENOENT" }),
      });
    }
    return makeFakeSpawnChild();
  };
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([baseProfile]),
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    platform: "win32",
    spawn,
  });
  const r = await ipcMain.invoke("remoteSsh:authenticate", "p1");
  assert.equal(r.status, "ok");
  assert.equal(r.terminal, "cmd");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cmd, "wt.exe");
  assert.equal(calls[1].cmd, "cmd.exe");
  ipc.dispose();
});

test("Windows: cmd.exe fallback disables delayed expansion and passes verbatim escaped args", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === "wt.exe") {
      return makeFakeSpawnChild({
        error: Object.assign(new Error("spawn wt.exe ENOENT"), { code: "ENOENT" }),
      });
    }
    return makeFakeSpawnChild();
  };
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([{
      ...baseProfile,
      identityFile: "C:\\Keys\\%CLAWD_QUOTE_TEST%\\id",
    }]),
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    platform: "win32",
    spawn,
  });
  const r = await ipcMain.invoke("remoteSsh:authenticate", "p1");
  assert.equal(r.status, "ok");
  assert.equal(calls[1].cmd, "cmd.exe");
  assert.deepEqual(calls[1].args.slice(0, 4), ["/d", "/v:off", "/s", "/k"]);
  assert.equal(calls[1].opts.windowsVerbatimArguments, true);
  assert.match(calls[1].args[4], /\^%CLAWD_QUOTE_TEST\^%/);
  assert.doesNotMatch(calls[1].args[4], /"%CLAWD_QUOTE_TEST%"/);
  ipc.dispose();
});

test("Windows: both wt and cmd missing → returns error (no crash)", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const spawn = () => makeFakeSpawnChild({
    error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
  });
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([baseProfile]),
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    platform: "win32",
    spawn,
  });
  const r = await ipcMain.invoke("remoteSsh:authenticate", "p1");
  assert.equal(r.status, "error");
  ipc.dispose();
});

test("Linux: first candidate ENOENT → tries next candidate (no silent success)", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    // gnome-terminal missing, konsole present.
    if (cmd === "gnome-terminal") {
      return makeFakeSpawnChild({
        error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      });
    }
    return makeFakeSpawnChild();
  };
  const origTerminal = process.env.TERMINAL;
  delete process.env.TERMINAL;
  try {
    const ipc = registerRemoteSshIpc({
      ipcMain,
      settingsController: mockSettingsController([baseProfile]),
      remoteSshRuntime: mockRuntime(),
      BrowserWindow,
      platform: "linux",
      spawn,
    });
    const r = await ipcMain.invoke("remoteSsh:open-terminal", "p1");
    assert.equal(r.status, "ok");
    assert.equal(r.terminal, "konsole");
    assert.equal(calls[0].cmd, "gnome-terminal");
    assert.equal(calls[1].cmd, "konsole");
    ipc.dispose();
  } finally {
    if (origTerminal != null) process.env.TERMINAL = origTerminal;
  }
});

test("post-spawn 'error' event does not become uncaughtException (defensive listener stays attached)", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  let spawnedChild = null;
  const spawn = () => {
    spawnedChild = makeFakeSpawnChild();
    return spawnedChild;
  };
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([baseProfile]),
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    platform: "win32",
    spawn,
  });
  await ipcMain.invoke("remoteSsh:authenticate", "p1");
  // A late 'error' must be swallowed by the post-spawn listener;
  // emit() would throw if there were no listener attached.
  assert.doesNotThrow(() => spawnedChild.emit("error", new Error("late ssh exit")));
  ipc.dispose();
});

test("remoteSsh:open-terminal on darwin uses osascript with two-layer quoting", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return makeFakeSpawnChild();
  };
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([{ ...baseProfile, identityFile: "/keys/my key" }]),
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    platform: "darwin",
    spawn,
  });
  const r = await ipcMain.invoke("remoteSsh:open-terminal", "p1");
  assert.equal(r.status, "ok");
  assert.equal(calls[0].cmd, "osascript");
  assert.equal(calls[0].args[0], "-e");
  // Inner script must contain do script and POSIX-quoted ssh / identityFile path.
  const script = calls[0].args[1];
  assert.match(script, /tell application "Terminal" to do script "/);
  // identityFile path with space is quoted in single-quotes (POSIX layer).
  assert.ok(script.includes("'/keys/my key'"));
  ipc.dispose();
});

test("remoteSsh:authenticate 404 on unknown profile id", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([]),
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });
  const r = await ipcMain.invoke("remoteSsh:authenticate", "ghost");
  assert.equal(r.status, "error");
  ipc.dispose();
});

// ── dispose ──

test("dispose unregisters all handlers and detaches event listeners", () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow, sentMessages } = mockBrowserWindow();
  const rt = mockRuntime();
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController(),
    remoteSshRuntime: rt,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });
  // Pre-dispose: runtime-mode switching has its own guarded channel.
  assert.equal(ipcMain.handlers.size, 10);
  ipc.dispose();
  assert.equal(ipcMain.handlers.size, 0);
  // After dispose, status-changed events should NOT broadcast.
  rt.emit("status-changed", { profileId: "p1", status: "idle" });
  assert.equal(sentMessages.length, 0);
});
