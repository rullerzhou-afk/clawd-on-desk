"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const { registerRemoteSshIpc: registerRemoteSshIpcReal } = require("../src/remote-ssh-ipc");
const { createRemoteSshTransportCoordinator } = require("../src/remote-ssh-transport-coordinator");
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function serializedCoordinator() {
  return createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async () => ({
      mode: "serialized",
      kind: "codespaces-stdio",
      key: "codespace:test-space",
      fingerprint: "test-fingerprint",
    }),
  });
}

function managedMockRuntime(events = []) {
  const rt = mockRuntime();
  rt.connect = (profile, options) => {
    events.push({ type: "connect", profile, options });
    return { profileId: profile.id, status: "connecting" };
  };
  rt.suspendForOperation = async (profileId, context, options) => {
    events.push({ type: "suspend", profileId, options });
    context.assertActive();
    return { ok: true, drainVerified: true };
  };
  rt.finalizeSerializedDisconnect = (profileId, context) => {
    events.push({ type: "finalize", profileId });
    const coordinator = rt._coordinator;
    if (coordinator) coordinator.release(context);
    return { profileId, status: "idle" };
  };
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

const readyProfile = {
  ...baseProfile,
  runtimeMode: "account-default",
  runtimeKey: "account-default",
  layoutVersion: 1,
  routingNonce: "b".repeat(32),
  remoteHome: "/home/user",
  lastDeployedAt: 1_700_000_000_000,
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

test("remoteSsh:list-statuses primes safe cross-profile serialized conflicts", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const first = { ...readyProfile, id: "p1", host: "alias-one" };
  const second = { ...readyProfile, id: "p2", host: "alias-two", remoteForwardPort: 23334 };
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async (profile) => ({
      mode: "serialized",
      kind: "codespaces-stdio",
      key: "codespace:shared-list",
      fingerprint: `fp:${profile.host}`,
    }),
  });
  const owner = await coordinator.acquireConnection(first);
  const rt = mockRuntime();
  rt.listStatuses = () => coordinator.listSnapshots();
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([first, second]),
    remoteSshRuntime: rt,
    transportCoordinator: coordinator,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });

  const result = await ipcMain.invoke("remoteSsh:list-statuses");
  const conflict = result.statuses.find((status) => status.profileId === second.id);
  assert.ok(conflict);
  assert.equal(conflict.transportOwnerProfileId, first.id);
  assert.deepEqual(conflict.conflictingProfileIds, [first.id]);
  assert.equal(Object.hasOwn(conflict, "transportKey"), false);
  assert.equal(Object.hasOwn(conflict, "inspection"), false);
  coordinator.release(owner.context);
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
    settingsController: mockSettingsController([readyProfile]),
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

test("serialized Deploy suspends the owned tunnel before mutation and resumes only the latest desired connection", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const settingsController = mockSettingsController([{ ...readyProfile, sshTransportMode: "auto" }]);
  const coordinator = serializedCoordinator();
  const events = [];
  const rt = managedMockRuntime(events);
  rt._coordinator = coordinator;
  registerRemoteSshIpc({
    ipcMain,
    settingsController,
    remoteSshRuntime: rt,
    transportCoordinator: coordinator,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    deployFn: async () => {
      events.push({ type: "deploy" });
      return {
        ok: true,
        remoteNode: { nodeBin: "/usr/bin/node", version: "20.1.0", source: "path" },
        layout: { remoteHome: "/home/user" },
      };
    },
  });

  assert.equal((await ipcMain.invoke("remoteSsh:connect", { profileId: "p1" })).status, "ok");
  const result = await ipcMain.invoke("remoteSsh:deploy", { profileId: "p1" });
  assert.equal(result.status, "ok");
  assert.deepEqual(events.map((event) => event.type), ["connect", "suspend", "deploy", "connect"]);
  assert.equal(events.find((event) => event.type === "suspend").options.closeIngress, false);
  assert.equal(coordinator.getIntent("p1").desiredConnected, true);

  const repairedAgain = await ipcMain.invoke("remoteSsh:deploy", { profileId: "p1" });
  assert.equal(repairedAgain.status, "ok", JSON.stringify(repairedAgain));
  assert.deepEqual(events.map((event) => event.type), [
    "connect", "suspend", "deploy", "connect",
    "suspend", "deploy", "connect",
  ]);
});

test("ordinary Deploy is per-profile single-flight before remote lock acquisition", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async () => ({
      mode: "parallel",
      kind: "standard",
      key: "parallel:ordinary",
      fingerprint: "fp:ordinary",
      effectiveHost: "ordinary",
      effectiveUser: "user",
      effectivePort: 22,
    }),
  });
  let finishDeploy;
  const pendingDeploy = new Promise((resolve) => { finishDeploy = resolve; });
  let deployCalls = 0;
  registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([readyProfile]),
    remoteSshRuntime: mockRuntime(),
    transportCoordinator: coordinator,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    deployFn: async () => {
      deployCalls += 1;
      return pendingDeploy;
    },
  });

  const first = ipcMain.invoke("remoteSsh:deploy", { profileId: readyProfile.id });
  for (let i = 0; i < 8 && deployCalls === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const second = await ipcMain.invoke("remoteSsh:deploy", { profileId: readyProfile.id });
  assert.equal(second.status, "error");
  assert.equal(second.reason, "transport_operation_busy");
  assert.equal(second.operation, "deploy");
  assert.equal(deployCalls, 1);

  finishDeploy({
    ok: true,
    remoteNode: { nodeBin: "/usr/bin/node", version: "20.1.0", source: "path" },
    layout: { remoteHome: "/home/user" },
  });
  assert.equal((await first).status, "ok");
});

test("Disconnect during serialized Deploy records intent without invalidating the active mutation", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow, sentMessages } = mockBrowserWindow();
  const settingsController = mockSettingsController([readyProfile]);
  const coordinator = serializedCoordinator();
  const events = [];
  const rt = managedMockRuntime(events);
  rt._coordinator = coordinator;
  let finishDeploy;
  const deployResult = new Promise((resolve) => { finishDeploy = resolve; });
  registerRemoteSshIpc({
    ipcMain,
    settingsController,
    remoteSshRuntime: rt,
    transportCoordinator: coordinator,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    deployFn: async () => {
      events.push({ type: "deploy" });
      return deployResult;
    },
  });

  await ipcMain.invoke("remoteSsh:connect", { profileId: "p1" });
  const deploying = ipcMain.invoke("remoteSsh:deploy", { profileId: "p1" });
  for (let i = 0; i < 8 && !events.some((event) => event.type === "deploy"); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const disconnect = await ipcMain.invoke("remoteSsh:disconnect", { profileId: "p1" });
  assert.equal(disconnect.status, "ok");
  assert.equal(disconnect.disconnectPending, true);
  assert.equal(disconnect.state.transportDesiredConnected, false);
  assert.equal(coordinator.getIntent("p1").desiredConnected, false);
  assert.ok(sentMessages.some(({ channel, payload }) => (
    channel === "remoteSsh:status-changed"
      && payload.profileId === "p1"
      && payload.transportDesiredConnected === false
  )));
  finishDeploy({
    ok: true,
    remoteNode: { nodeBin: "/usr/bin/node", version: "20.1.0", source: "path" },
    layout: { remoteHome: "/home/user" },
  });
  assert.equal((await deploying).status, "ok");
  assert.deepEqual(events.map((event) => event.type), ["connect", "suspend", "deploy", "finalize"]);
});

test("Disconnect during Deploy stops the configured remote Codex monitor before finalizing", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const profile = { ...readyProfile, autoStartCodexMonitor: true };
  const coordinator = serializedCoordinator();
  const events = [];
  const rt = managedMockRuntime(events);
  rt._coordinator = coordinator;
  let finishDeploy;
  const deployResult = new Promise((resolve) => { finishDeploy = resolve; });
  registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([profile]),
    remoteSshRuntime: rt,
    transportCoordinator: coordinator,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    deployFn: async () => {
      events.push({ type: "deploy" });
      return deployResult;
    },
    stopCodexMonitorFn: async () => {
      events.push({ type: "monitor-stop" });
      return { ok: true };
    },
  });

  await ipcMain.invoke("remoteSsh:connect", { profileId: profile.id });
  const deploying = ipcMain.invoke("remoteSsh:deploy", { profileId: profile.id });
  for (let i = 0; i < 8 && !events.some((event) => event.type === "deploy"); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const disconnect = await ipcMain.invoke("remoteSsh:disconnect", { profileId: profile.id });
  assert.equal(disconnect.disconnectPending, true);
  finishDeploy({
    ok: true,
    remoteNode: { nodeBin: "/usr/bin/node", version: "20.1.0", source: "path" },
    layout: { remoteHome: "/home/user" },
  });
  assert.equal((await deploying).status, "ok");
  assert.deepEqual(events.map((event) => event.type), [
    "connect", "suspend", "deploy", "monitor-stop", "finalize",
  ]);
});

test("Disconnect during Deploy never stops a monitor after the effective transport drifts", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const profile = { ...readyProfile, autoStartCodexMonitor: true };
  let inspections = 0;
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async () => {
      inspections += 1;
      return {
        mode: "serialized",
        kind: "codespaces-stdio",
        key: inspections >= 4 ? "codespace:changed" : "codespace:original",
        fingerprint: `fp:${inspections}`,
      };
    },
  });
  const events = [];
  const rt = managedMockRuntime(events);
  rt._coordinator = coordinator;
  let finishDeploy;
  const deployResult = new Promise((resolve) => { finishDeploy = resolve; });
  let monitorStops = 0;
  registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([profile]),
    remoteSshRuntime: rt,
    transportCoordinator: coordinator,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    deployFn: async () => {
      events.push({ type: "deploy" });
      return deployResult;
    },
    stopCodexMonitorFn: async () => {
      monitorStops += 1;
      return { ok: true };
    },
  });

  await ipcMain.invoke("remoteSsh:connect", { profileId: profile.id });
  const deploying = ipcMain.invoke("remoteSsh:deploy", { profileId: profile.id });
  for (let i = 0; i < 8 && !events.some((event) => event.type === "deploy"); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await ipcMain.invoke("remoteSsh:disconnect", { profileId: profile.id });
  finishDeploy({
    ok: true,
    remoteNode: { nodeBin: "/usr/bin/node", version: "20.1.0", source: "path" },
    layout: { remoteHome: "/home/user" },
  });
  const result = await deploying;

  assert.equal(result.status, "ok");
  assert.equal(monitorStops, 0, "the original reservation must not mutate the newly resolved target");
  assert.equal(result.disconnectWarning.reason, "profile_changed");
  assert.deepEqual(events.map((event) => event.type), ["connect", "suspend", "deploy", "finalize"]);
});

test("post-drain effective transport drift aborts before identity rotation or remote mutation", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  let inspections = 0;
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async () => {
      inspections += 1;
      return {
        mode: "serialized",
        kind: "codespaces-stdio",
        key: inspections < 3 ? "codespace:a" : "codespace:b",
        fingerprint: `fp:${inspections}`,
      };
    },
  });
  const settingsController = mockSettingsController([readyProfile]);
  const events = [];
  const rt = managedMockRuntime(events);
  rt._coordinator = coordinator;
  await coordinator.acquireConnection(readyProfile);
  let deployCalls = 0;
  registerRemoteSshIpc({
    ipcMain,
    settingsController,
    remoteSshRuntime: rt,
    transportCoordinator: coordinator,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    deployFn: async () => {
      deployCalls += 1;
      return { ok: true };
    },
  });

  const result = await ipcMain.invoke("remoteSsh:deploy", { profileId: readyProfile.id });
  assert.equal(result.status, "error");
  assert.equal(result.reason, "profile_changed");
  assert.equal(deployCalls, 0);
  assert.equal(
    settingsController._commandCalls.some(({ action }) => action === "remoteSsh.beginIdentityRotation"),
    false,
  );
  assert.equal(events.some((event) => event.type === "connect"), false);
});

test("a live ordinary runtime blocks serialized Deploy and Connect admission after config drift", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const coordinator = serializedCoordinator();
  const rt = managedMockRuntime();
  rt._coordinator = coordinator;
  rt.getProfileTransportMode = () => "parallel";
  rt.getProfileStatus = (id) => ({ profileId: id, status: "connected" });
  let deployCalls = 0;
  let connectCalls = 0;
  rt.connect = () => { connectCalls += 1; };
  registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([readyProfile]),
    remoteSshRuntime: rt,
    transportCoordinator: coordinator,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    deployFn: async () => {
      deployCalls += 1;
      return { ok: true };
    },
  });

  const deploy = await ipcMain.invoke("remoteSsh:deploy", { profileId: readyProfile.id });
  assert.equal(deploy.status, "error");
  assert.equal(deploy.reason, "profile_changed");
  assert.equal(deployCalls, 0);
  assert.equal(coordinator.snapshotForProfile(readyProfile.id).transportPhase, "idle");

  const connect = await ipcMain.invoke("remoteSsh:connect", { profileId: readyProfile.id });
  assert.equal(connect.status, "error");
  assert.equal(connect.reason, "profile_changed");
  assert.equal(connectCalls, 0);
  assert.equal(coordinator.snapshotForProfile(readyProfile.id).transportPhase, "idle");
});

test("same Codespaces transport rejects a second profile Connect without storing connection intent", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const second = { ...readyProfile, id: "p2", label: "Other", host: "alias-two" };
  const settingsController = mockSettingsController([readyProfile, second]);
  const coordinator = serializedCoordinator();
  const rt = managedMockRuntime();
  rt._coordinator = coordinator;
  registerRemoteSshIpc({
    ipcMain,
    settingsController,
    remoteSshRuntime: rt,
    transportCoordinator: coordinator,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });

  assert.equal((await ipcMain.invoke("remoteSsh:connect", { profileId: "p1" })).status, "ok");
  const busy = await ipcMain.invoke("remoteSsh:connect", { profileId: "p2" });
  assert.equal(busy.status, "error");
  assert.equal(busy.reason, "serialized_transport_busy");
  assert.equal(busy.ownerProfileId, "p1");
  assert.equal(busy.operation, "connect");
  assert.deepEqual(coordinator.getIntent("p2"), { desiredConnected: false, intentGeneration: 0 });
});

test("interactive terminal is blocked while a serialized Codespaces transport is owned", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const settingsController = mockSettingsController([readyProfile]);
  const coordinator = serializedCoordinator();
  const rt = managedMockRuntime();
  rt._coordinator = coordinator;
  const terminal = makeSucceedingSpawn();
  registerRemoteSshIpc({
    ipcMain,
    settingsController,
    remoteSshRuntime: rt,
    transportCoordinator: coordinator,
    BrowserWindow,
    spawn: terminal.spawn,
  });

  await ipcMain.invoke("remoteSsh:connect", { profileId: "p1" });
  const result = await ipcMain.invoke("remoteSsh:open-terminal", { profileId: "p1" });
  assert.equal(result.status, "error");
  assert.equal(result.reason, "serialized_transport_busy");
  assert.equal(terminal.calls.length, 0);
});

test("interactive terminal stays blocked after a live serialized target drifts to parallel", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  let inspections = 0;
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async () => {
      inspections += 1;
      return inspections === 1
        ? {
            mode: "serialized",
            kind: "codespaces-stdio",
            key: "codespace:interactive-drift-ipc",
            fingerprint: "same-interactive-ipc-target",
          }
        : {
            mode: "parallel",
            kind: "standard",
            key: "parallel:interactive-drift-ipc",
            fingerprint: "same-interactive-ipc-target",
          };
    },
  });
  const rt = managedMockRuntime();
  rt._coordinator = coordinator;
  const terminal = makeSucceedingSpawn();
  registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([readyProfile]),
    remoteSshRuntime: rt,
    transportCoordinator: coordinator,
    BrowserWindow,
    spawn: terminal.spawn,
  });

  assert.equal((await ipcMain.invoke("remoteSsh:connect", { profileId: readyProfile.id })).status, "ok");
  const result = await ipcMain.invoke("remoteSsh:open-terminal", { profileId: readyProfile.id });
  assert.equal(result.status, "error");
  assert.equal(result.reason, "profile_changed");
  assert.equal(terminal.calls.length, 0);
});

test("remoteSsh:connect returns a structured deployment_required error before runtime.connect", async () => {
  const cases = [
    ["deployment_stamp_missing", { ...baseProfile }],
    ["secure_layout_missing", { ...readyProfile, remoteHome: undefined }],
    ["secure_identity_missing", { ...readyProfile, routingNonce: undefined }],
  ];
  for (const [expectedDetail, profile] of cases) {
    const ipcMain = mockIpcMain();
    const { BrowserWindow } = mockBrowserWindow();
    const rt = mockRuntime();
    let connects = 0;
    let monitors = 0;
    rt.connect = () => { connects += 1; };
    const ipc = registerRemoteSshIpc({
      ipcMain,
      settingsController: mockSettingsController([{ ...profile, autoStartCodexMonitor: true }]),
      remoteSshRuntime: rt,
      BrowserWindow,
      spawn: makeSucceedingSpawn().spawn,
      startCodexMonitorFn: async () => { monitors += 1; },
    });

    const r = await ipcMain.invoke("remoteSsh:connect", "p1");
    assert.equal(r.status, "error");
    assert.equal(r.reason, "deployment_required");
    assert.equal(r.hint, "remoteSshErrDeploymentRequired");
    assert.equal(r.detail, expectedDetail);
    assert.equal(connects, 0);
    assert.equal(monitors, 0);
    ipc.dispose();
  }
});

test("settings remoteSsh updates refresh cached runtime profiles and stop removed states", async () => {
  const { createSettingsController } = require("../src/settings-controller");
  const prefs = require("../src/prefs");
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const refreshed = [];
  const disconnected = [];
  const rt = mockRuntime();
  rt.listStatuses = () => [{ profileId: "p1", status: "reconnecting" }];
  rt.refreshProfile = (profile) => {
    refreshed.push(profile);
    return true;
  };
  rt.disconnect = (profileId) => {
    disconnected.push(profileId);
    return { profileId, status: "idle" };
  };
  const controller = createSettingsController({
    loadResult: {
      snapshot: {
        ...prefs.getDefaults(),
        remoteSsh: {
          installId: TEST_INSTALL_ID,
          profiles: [{ ...readyProfile }],
        },
      },
      locked: false,
    },
  });
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: controller,
    remoteSshRuntime: rt,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });

  const updated = await controller.applyCommand("remoteSsh.update", {
    ...baseProfile,
    remoteForwardPort: 23334,
  });
  assert.equal(updated.status, "ok");
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].remoteForwardPort, 23334);
  assert.equal(refreshed[0].lastDeployedAt, undefined,
    "the queued runtime must see that the edited target requires deployment");
  assert.deepEqual(disconnected, []);

  const deleted = await controller.applyCommand("remoteSsh.delete", "p1");
  assert.equal(deleted.status, "ok");
  assert.deepEqual(disconnected, ["p1"]);

  ipc.dispose();
  controller.dispose();
});

// ── connect-on-launch sweep ──

test("connectOnLaunchProfiles connects only flagged profiles", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const rt = mockRuntime();
  const connected = [];
  rt.connect = (p) => { connected.push(p.id); };
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([
      { ...readyProfile, id: "p1", connectOnLaunch: true },
      { ...readyProfile, id: "p2", connectOnLaunch: false },
      { ...readyProfile, id: "p3", connectOnLaunch: true },
    ]),
    remoteSshRuntime: rt,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });
  const started = await ipc.connectOnLaunchProfiles();
  assert.deepEqual(started, ["p1", "p3"]);
  assert.deepEqual(connected, ["p1", "p3"]);
  ipc.dispose();
});

test("connectOnLaunchProfiles keeps going when one connect throws", async () => {
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
      { ...readyProfile, id: "p1", connectOnLaunch: true },
      { ...readyProfile, id: "p2", connectOnLaunch: true },
    ]),
    remoteSshRuntime: rt,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });
  const started = await ipc.connectOnLaunchProfiles();
  assert.deepEqual(started, ["p2"]);
  assert.deepEqual(connected, ["p2"]);
  ipc.dispose();
});

test("connectOnLaunchProfiles skips profiles that require deployment", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const rt = mockRuntime();
  let connects = 0;
  let monitors = 0;
  rt.connect = () => { connects += 1; };
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([{
      ...baseProfile,
      connectOnLaunch: true,
      autoStartCodexMonitor: true,
    }]),
    remoteSshRuntime: rt,
    BrowserWindow,
    startCodexMonitorFn: async () => { monitors += 1; },
  });

  assert.deepEqual(await ipc.connectOnLaunchProfiles(), []);
  assert.equal(connects, 0);
  assert.equal(monitors, 0);
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

test("ordinary connected Disconnect bypasses fresh transport inspection", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const rt = mockRuntime();
  let disconnectId = null;
  rt.getProfileTransportMode = () => "parallel";
  rt.disconnect = (id) => { disconnectId = id; return { profileId: id, status: "idle" }; };
  let inspections = 0;
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async () => {
      inspections += 1;
      return { mode: "unknown", kind: "inspection-failed", key: null, message: "bad config" };
    },
  });
  registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([baseProfile]),
    remoteSshRuntime: rt,
    transportCoordinator: coordinator,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });

  const result = await ipcMain.invoke("remoteSsh:disconnect", { profileId: "p1" });
  assert.equal(result.status, "ok");
  assert.equal(disconnectId, "p1");
  assert.equal(inspections, 0);
  assert.equal(coordinator._slots.size, 0);
});

test("ordinary Disconnect remains a local safety valve when installation binding is unavailable", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const rt = mockRuntime();
  let disconnectId = null;
  let monitorStops = 0;
  rt.getProfileTransportMode = () => "parallel";
  rt.disconnect = (id) => { disconnectId = id; return { profileId: id, status: "idle" }; };
  registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([{
      ...readyProfile,
      autoStartCodexMonitor: true,
    }]),
    remoteSshRuntime: rt,
    transportCoordinator: serializedCoordinator(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    getInstallationIdentity: () => null,
    stopCodexMonitorFn: async () => {
      monitorStops += 1;
      return { ok: true };
    },
  });

  const result = await ipcMain.invoke("remoteSsh:disconnect", { profileId: "p1" });
  assert.equal(result.status, "ok");
  assert.equal(disconnectId, "p1");
  assert.equal(monitorStops, 0, "best-effort monitor cleanup must not gate local disconnect");
});

test("ordinary Disconnect never bypasses a serialized target owner for monitor cleanup", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const effective = {
    effectiveHost: "ssh.codespaces.example",
    effectiveUser: "codespace",
    effectivePort: 22,
  };
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async () => ({
      mode: "serialized",
      kind: "codespaces-stdio",
      key: "codespace:occupied",
      fingerprint: "fp:occupied",
      ...effective,
    }),
  });
  const owner = { ...readyProfile, id: "p2", host: "occupied-alias" };
  const ownerConnection = await coordinator.acquireConnection(owner);
  assert.equal(ownerConnection.ok, true);

  const rt = mockRuntime();
  let disconnectId = null;
  let monitorStops = 0;
  rt.getProfileTransportMode = () => "parallel";
  rt.getProfileTransportInspection = () => ({
    mode: "parallel",
    kind: "standard",
    key: "parallel:previous",
    ...effective,
  });
  rt.disconnect = (id) => { disconnectId = id; return { profileId: id, status: "idle" }; };
  registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([{
      ...readyProfile,
      autoStartCodexMonitor: true,
    }]),
    remoteSshRuntime: rt,
    transportCoordinator: coordinator,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    stopCodexMonitorFn: async () => {
      monitorStops += 1;
      return { ok: true };
    },
  });

  const result = await ipcMain.invoke("remoteSsh:disconnect", { profileId: "p1" });
  assert.equal(result.status, "ok");
  assert.equal(result.warning.reason, "profile_changed");
  assert.equal(disconnectId, "p1");
  assert.equal(monitorStops, 0);
  assert.equal(coordinator.snapshotForProfile("p2").transportOwnerProfileId, "p2");
});

test("a new Connect supersedes deferred ordinary Disconnect monitor cleanup", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const oldInspection = deferred();
  let inspectionCalls = 0;
  const effective = {
    mode: "parallel",
    kind: "standard",
    key: "parallel:same",
    fingerprint: "effective:same",
    effectiveHost: "pi",
    effectiveUser: "user",
    effectivePort: 22,
  };
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async () => {
      inspectionCalls += 1;
      return inspectionCalls === 1 ? oldInspection.promise : effective;
    },
  });
  const rt = mockRuntime();
  let disconnects = 0;
  let connects = 0;
  let monitorStarts = 0;
  let monitorStops = 0;
  rt.getProfileTransportMode = () => "parallel";
  rt.getProfileTransportInspection = () => effective;
  rt.disconnect = (id) => {
    disconnects += 1;
    return { profileId: id, status: "idle" };
  };
  rt.connect = () => { connects += 1; };
  registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([{ ...readyProfile, autoStartCodexMonitor: true }]),
    remoteSshRuntime: rt,
    transportCoordinator: coordinator,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    startCodexMonitorFn: async () => { monitorStarts += 1; return { ok: true }; },
    stopCodexMonitorFn: async () => { monitorStops += 1; return { ok: true }; },
  });

  const disconnecting = ipcMain.invoke("remoteSsh:disconnect", { profileId: readyProfile.id });
  await Promise.resolve();
  assert.equal(disconnects, 1, "the local tunnel closes before optional monitor cleanup");
  const connecting = ipcMain.invoke("remoteSsh:connect", { profileId: readyProfile.id });
  oldInspection.resolve(effective);
  const [disconnectResult, connectResult] = await Promise.all([disconnecting, connecting]);

  assert.equal(disconnectResult.status, "ok");
  assert.equal(connectResult.status, "ok");
  assert.equal(connects, 1);
  assert.equal(monitorStarts, 1);
  assert.equal(monitorStops, 0, "the superseded Disconnect must not stop the new monitor");
});

test("a quick new Connect waits for an already-started ordinary monitor stop", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const stopDeferred = deferred();
  const effective = {
    mode: "parallel",
    kind: "standard",
    key: "parallel:ordered-monitor",
    fingerprint: "effective:ordered-monitor",
    effectiveHost: "pi",
    effectiveUser: "user",
    effectivePort: 22,
  };
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async () => effective,
  });
  const rt = mockRuntime();
  let connects = 0;
  let monitorStarts = 0;
  let monitorStops = 0;
  rt.getProfileTransportMode = () => "parallel";
  rt.getProfileTransportInspection = () => effective;
  rt.connect = () => { connects += 1; };
  registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([{ ...readyProfile, autoStartCodexMonitor: true }]),
    remoteSshRuntime: rt,
    transportCoordinator: coordinator,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    startCodexMonitorFn: async () => { monitorStarts += 1; return { ok: true }; },
    stopCodexMonitorFn: async () => {
      monitorStops += 1;
      return stopDeferred.promise;
    },
  });

  const disconnecting = ipcMain.invoke("remoteSsh:disconnect", { profileId: readyProfile.id });
  for (let i = 0; i < 4 && monitorStops === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(monitorStops, 1);

  const connecting = ipcMain.invoke("remoteSsh:connect", { profileId: readyProfile.id });
  await Promise.resolve();
  assert.equal(connects, 0);
  assert.equal(monitorStarts, 0, "monitor start must not overlap the older stop");

  stopDeferred.resolve({ ok: true });
  const [disconnectResult, connectResult] = await Promise.all([disconnecting, connecting]);
  assert.equal(disconnectResult.status, "ok");
  assert.equal(connectResult.status, "ok");
  assert.equal(connects, 1);
  assert.equal(monitorStarts, 1);
});

test("ordinary Disconnect waits for an in-flight monitor start before stopping it", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const startDeferred = deferred();
  const order = [];
  const effective = {
    mode: "parallel",
    kind: "standard",
    key: "parallel:start-stop",
    fingerprint: "effective:start-stop",
    effectiveHost: "pi",
    effectiveUser: "user",
    effectivePort: 22,
  };
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async () => effective,
  });
  const rt = mockRuntime();
  rt.getProfileTransportMode = () => "parallel";
  rt.getProfileTransportInspection = () => effective;
  registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([{ ...readyProfile, autoStartCodexMonitor: true }]),
    remoteSshRuntime: rt,
    transportCoordinator: coordinator,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    startCodexMonitorFn: async () => {
      order.push("start-begin");
      await startDeferred.promise;
      order.push("start-end");
      return { ok: true };
    },
    stopCodexMonitorFn: async () => {
      order.push("stop");
      return { ok: true };
    },
  });

  const connected = await ipcMain.invoke("remoteSsh:connect", { profileId: readyProfile.id });
  assert.equal(connected.status, "ok");
  for (let i = 0; i < 4 && order.length === 0; i += 1) await Promise.resolve();
  assert.deepEqual(order, ["start-begin"]);

  const disconnecting = ipcMain.invoke("remoteSsh:disconnect", { profileId: readyProfile.id });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start-begin"], "stop cannot overlap an unfinished start");
  startDeferred.resolve();
  const disconnected = await disconnecting;
  assert.equal(disconnected.status, "ok");
  assert.deepEqual(order, ["start-begin", "start-end", "stop"]);
});

test("a deferred ordinary Connect cannot restore intent after a newer Disconnect", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const inspectionDeferred = deferred();
  const effective = {
    mode: "parallel",
    kind: "standard",
    key: "parallel:slow-connect",
    fingerprint: "effective:slow-connect",
    effectiveHost: "pi",
    effectiveUser: "user",
    effectivePort: 22,
  };
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: () => inspectionDeferred.promise,
  });
  const rt = mockRuntime();
  let connects = 0;
  let disconnects = 0;
  rt.getProfileTransportMode = () => "parallel";
  rt.connect = () => { connects += 1; };
  rt.disconnect = () => { disconnects += 1; return { profileId: readyProfile.id, status: "idle" }; };
  registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([readyProfile]),
    remoteSshRuntime: rt,
    transportCoordinator: coordinator,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });

  const connecting = ipcMain.invoke("remoteSsh:connect", { profileId: readyProfile.id });
  await Promise.resolve();
  const disconnected = await ipcMain.invoke("remoteSsh:disconnect", { profileId: readyProfile.id });
  assert.equal(disconnected.status, "ok");
  inspectionDeferred.resolve(effective);
  const connectResult = await connecting;

  assert.equal(connectResult.status, "error");
  assert.equal(connectResult.reason, "transport_operation_busy");
  assert.equal(connects, 0);
  assert.equal(disconnects, 1);
  assert.equal(coordinator.getIntent(readyProfile.id).desiredConnected, false);
});

test("rejected ordinary monitor queue tasks are handled and do not leave the queue stuck", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const effective = {
    mode: "parallel",
    kind: "standard",
    key: "parallel:rejected-monitor-task",
    fingerprint: "effective:rejected-monitor-task",
    effectiveHost: "pi",
    effectiveUser: "user",
    effectivePort: 22,
  };
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async () => effective,
  });
  const rt = mockRuntime();
  rt.getProfileTransportMode = () => "parallel";
  rt.getProfileTransportInspection = () => effective;
  let startCalls = 0;
  let stopCalls = 0;
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    registerRemoteSshIpc({
      ipcMain,
      settingsController: mockSettingsController([{ ...readyProfile, autoStartCodexMonitor: true }]),
      remoteSshRuntime: rt,
      transportCoordinator: coordinator,
      BrowserWindow,
      spawn: makeSucceedingSpawn().spawn,
      startCodexMonitorFn: async () => {
        startCalls += 1;
        throw new Error("start rejected");
      },
      stopCodexMonitorFn: async () => {
        stopCalls += 1;
        throw new Error("stop rejected");
      },
    });
    assert.equal((await ipcMain.invoke("remoteSsh:connect", { profileId: readyProfile.id })).status, "ok");
    await new Promise((resolve) => setImmediate(resolve));
    const disconnected = await ipcMain.invoke("remoteSsh:disconnect", { profileId: readyProfile.id });
    assert.equal(disconnected.status, "ok");
    assert.equal(disconnected.warning.reason, "monitor_stop_skipped");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await ipcMain.invoke("remoteSsh:connect", { profileId: readyProfile.id })).status, "ok");
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.equal(startCalls, 2, "a rejected start must not leave the queue occupied");
  assert.equal(stopCalls, 1);
  assert.deepEqual(unhandled, []);
});

test("serialized Disconnect drains the owned target but skips monitor mutation after config drift", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const profile = { ...readyProfile, autoStartCodexMonitor: true };
  let inspections = 0;
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async () => ({
      mode: "serialized",
      kind: "codespaces-stdio",
      key: inspections++ === 0 ? "codespace:a" : "codespace:b",
      fingerprint: `fp:${inspections}`,
    }),
  });
  await coordinator.acquireConnection(profile);
  const events = [];
  const rt = managedMockRuntime(events);
  rt._coordinator = coordinator;
  let stopCalls = 0;
  registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([profile]),
    remoteSshRuntime: rt,
    transportCoordinator: coordinator,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    stopCodexMonitorFn: async () => {
      stopCalls += 1;
      return { ok: true };
    },
  });

  const result = await ipcMain.invoke("remoteSsh:disconnect", { profileId: profile.id });
  assert.equal(result.status, "ok");
  assert.equal(result.warning.reason, "profile_changed");
  assert.equal(stopCalls, 0);
  assert.deepEqual(events.map((event) => event.type), ["suspend", "finalize"]);
  assert.equal(coordinator.snapshotForProfile(profile.id).transportPhase, "idle");
});

test("Disconnect reports pre-lock quarantine as drain timeout, not manual lock recovery", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const timers = [];
  let child;
  const coordinator = createRemoteSshTransportCoordinator({
    inspectEffectiveTransport: async () => ({
      mode: "serialized",
      kind: "codespaces-stdio",
      key: "codespace:prelock-quarantine",
      fingerprint: "fp-prelock-quarantine",
    }),
    spawn: () => {
      child = new EventEmitter();
      child.stdin = { end() {} };
      child.kill = () => {};
      return child;
    },
    setTimeout: (fn) => { timers.push(fn); return fn; },
    clearTimeout: () => {},
  });
  const operation = await coordinator.acquireOperation(readyProfile, "deploy");
  operation.context.spawn({
    attemptToken: operation.context.attemptToken,
    role: "node-resolve",
    tool: "ssh",
    args: [],
  });
  const draining = coordinator.waitForDrain(operation.context, () => {});
  timers.shift()();
  await assert.rejects(draining, (err) => err && err.code === "transport_drain_timeout");
  registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([readyProfile]),
    remoteSshRuntime: mockRuntime(),
    transportCoordinator: coordinator,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });

  const result = await ipcMain.invoke("remoteSsh:disconnect", { profileId: readyProfile.id });
  assert.equal(result.status, "error");
  assert.equal(result.reason, "transport_drain_timeout");
  assert.equal(result.recoveryCode, undefined);
  child.emit("close", 0, null);
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

test("remoteSsh:force-revoke all commits through the real controller and drops both old generations", async () => {
  const { createSettingsController } = require("../src/settings-controller");
  const prefs = require("../src/prefs");
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  const disconnected = [];
  const refreshed = [];
  const runtime = mockRuntime();
  runtime.disconnect = (id) => { disconnected.push(id); };
  runtime.refreshProfile = (profile) => { refreshed.push(profile); return true; };
  const controller = createSettingsController({
    loadResult: {
      snapshot: {
        ...prefs.getDefaults(),
        remoteSsh: {
          installId: TEST_INSTALL_ID,
          profiles: [{
            ...baseProfile,
            runtimeMode: "account-default",
            runtimeKey: "account-default",
            layoutVersion: 1,
            routingNonce: "b".repeat(32),
            previousNonce: "a".repeat(32),
            previousExpiresAt: Date.now() + 60_000,
          }],
        },
      },
      locked: false,
    },
  });
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: controller,
    remoteSshRuntime: runtime,
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
  });

  const result = await ipcMain.invoke("remoteSsh:force-revoke", {
    profileId: "p1",
    mode: "all",
    confirmed: true,
  });
  const updated = controller.getSnapshot().remoteSsh.profiles[0];

  assert.equal(result.status, "ok");
  assert.deepEqual(disconnected, ["p1"]);
  assert.equal(refreshed.length, 1);
  assert.equal(updated.routingNonce, undefined);
  assert.equal(updated.previousNonce, undefined);
  assert.ok(updated.identityTxn.previousExpiresAt > updated.identityTxn.startedAt);
  assert.equal(refreshed[0].identityTxn.toNonce, updated.identityTxn.toNonce);
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

test("remoteSsh:cleanup stops after an unknown result and preserves recovery guidance", async () => {
  const ipcMain = mockIpcMain();
  const { BrowserWindow } = mockBrowserWindow();
  let attempts = 0;
  const first = ownedTarget({ host: "user@a-host" });
  const second = ownedTarget({ host: "user@z-host", runtimeKey: "second-runtime" });
  const ipc = registerRemoteSshIpc({
    ipcMain,
    settingsController: mockSettingsController([{
      ...baseProfile,
      managedDeployTargets: [second, first],
    }]),
    remoteSshRuntime: mockRuntime(),
    BrowserWindow,
    spawn: makeSucceedingSpawn().spawn,
    uninstallRemoteIntegrationsFn: async () => {
      attempts += 1;
      const err = new Error("remote mutation result is unknown");
      err.code = "transport_unknown_result";
      err.recoveryCode = "manual_lock_inspection_required";
      throw err;
    },
  });

  const result = await ipcMain.invoke("remoteSsh:cleanup", "p1");
  assert.equal(result.status, "error");
  assert.equal(result.reason, "transport_unknown_result");
  assert.equal(result.recoveryCode, "manual_lock_inspection_required");
  assert.equal(attempts, 1, "unknown cleanup must not continue to another target");
  ipc.dispose();
});

test("runtime-mode cleanup, finalize, and bootstrap errors redact transport diagnostics", async () => {
  const secretPath = "C:\\keys\\private-key";
  const diagnostic = `${secretPath} ghp_abcdefghijklmnopqrstuvwxyz Bearer supersecrettoken ProxyCommand gh cs ssh --stdio`;
  const target = ownedTarget({ identityFile: secretPath });
  const base = {
    ...baseProfile,
    identityFile: secretPath,
    runtimeMode: "account-default",
    runtimeKey: "account-default",
    layoutVersion: 1,
    managedDeployTargets: [target],
  };
  const cases = [
    {
      name: "cleanup",
      profile: base,
      overrides: {
        uninstallRemoteIntegrationsFn: async () => ({ ok: false, stderr: diagnostic }),
      },
    },
    {
      name: "finalize",
      profile: {
        ...base,
        runtimeModeTxn: {
          fromMode: "account-default",
          fromKey: "account-default",
          toMode: "profile-isolated",
          toKey: "rt_redaction",
          layoutVersion: 1,
          phase: "cleanup-done",
          startedAt: 1,
        },
      },
      overrides: {
        finalizeRetiredRemoteLayoutFn: async () => ({ ok: false, stderr: diagnostic }),
      },
    },
    {
      name: "bootstrap",
      profile: {
        ...base,
        runtimeModeTxn: {
          fromMode: "account-default",
          fromKey: "account-default",
          toMode: "profile-isolated",
          toKey: "rt_redaction",
          layoutVersion: 1,
          phase: "cleanup-done",
          startedAt: 1,
        },
      },
      overrides: {
        finalizeRetiredRemoteLayoutFn: async () => ({ ok: true }),
        bootstrapIsolatedRuntimeFn: async () => ({ ok: false, stderr: diagnostic }),
      },
    },
  ];

  for (const entry of cases) {
    const ipcMain = mockIpcMain();
    registerRemoteSshIpc({
      ipcMain,
      settingsController: mockSettingsController([entry.profile]),
      remoteSshRuntime: mockRuntime(),
      BrowserWindow: mockBrowserWindow().BrowserWindow,
      spawn: makeSucceedingSpawn().spawn,
      uninstallRemoteIntegrationsFn: async () => ({ ok: true }),
      finalizeRetiredRemoteLayoutFn: async () => ({ ok: true }),
      bootstrapIsolatedRuntimeFn: async () => ({ ok: true }),
      ...entry.overrides,
    });
    const result = await ipcMain.invoke("remoteSsh:set-runtime-mode", {
      profileId: "p1",
      runtimeMode: "profile-isolated",
      confirmed: true,
    });
    assert.equal(result.status, "error", entry.name);
    assert.doesNotMatch(result.message, /private-key|ghp_|supersecrettoken|gh cs ssh/i, entry.name);
  }
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
