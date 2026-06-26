"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const { registerRemoteSshIpc } = require("../src/remote-ssh-ipc");

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
  return {
    getSnapshot: () => ({ remoteSsh: { profiles } }),
    applyCommand: async (action, args) => {
      commandCalls.push({ action, args });
      if (applyCommandImpl) return applyCommandImpl(action, args);
      return { status: "ok" };
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
  // Exactly one command fired, and it must be markDeployed (NOT update,
  // which would be the lost-update bug we just fixed).
  assert.equal(settingsController._commandCalls.length, 1);
  assert.equal(settingsController._commandCalls[0].action, "remoteSsh.markDeployed",
    "deploy stamp must use markDeployed, not full-profile update");
  const args = settingsController._commandCalls[0].args;
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

test("remoteSsh:deploy returns stamp_failed warning when markDeployed returns error", async () => {
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
  assert.equal(r.status, "ok", "deploy itself ran");
  assert.equal(r.warning, "stamp_failed",
    "non-throw stamp errors must surface as warning, not silent success");
  assert.match(r.message, /persist failed/);
  ipc.dispose();
});

test("remoteSsh:deploy returns stamp_failed warning when markDeployed throws", async () => {
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
  assert.equal(r.status, "ok");
  assert.equal(r.warning, "stamp_failed");
  assert.match(r.message, /controller exploded/);
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
  // No update command was fired — failed deploys must not stamp.
  assert.equal(settingsController._commandCalls.length, 0);
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
  // Pre-dispose: 7 channels are registered.
  assert.equal(ipcMain.handlers.size, 7);
  ipc.dispose();
  assert.equal(ipcMain.handlers.size, 0);
  // After dispose, status-changed events should NOT broadcast.
  rt.emit("status-changed", { profileId: "p1", status: "idle" });
  assert.equal(sentMessages.length, 0);
});
