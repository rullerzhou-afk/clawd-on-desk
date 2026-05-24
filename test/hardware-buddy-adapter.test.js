"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  createHardwareBuddyAdapter,
  isEnabledFromEnv,
} = require("../src/hardware-buddy-adapter");

class FakeSidecarClient {
  constructor(options) {
    this.options = options;
    this.started = false;
    this.stopped = false;
    this.connects = [];
    this.scans = 0;
    this.sent = [];
    this.commandListeners = [];
    this.transport = {
      connected: false,
      secure: false,
      send: (snapshot, meta) => this.sent.push({ snapshot, meta }),
      onCommand: (listener) => {
        this.commandListeners.push(listener);
        return () => {
          const idx = this.commandListeners.indexOf(listener);
          if (idx !== -1) this.commandListeners.splice(idx, 1);
        };
      },
      isSecure: () => this.transport.secure === true,
    };
    FakeSidecarClient.instances.push(this);
  }

  start() {
    this.started = true;
  }

  stop() {
    this.stopped = true;
  }

  connect(address) {
    this.connects.push(address);
    return true;
  }

  scan() {
    this.scans += 1;
    return true;
  }

  emitDevices(items) {
    if (typeof this.options.onDevices === "function") this.options.onDevices(items);
  }

  injectCommand(command) {
    return this.commandListeners.map((listener) => listener(command));
  }

  lastSent() {
    return this.sent[this.sent.length - 1] || null;
  }

  setSecure(secure) {
    const previous = {
      connected: this.transport.connected === true,
      secure: this.transport.secure === true,
    };
    this.transport.secure = secure === true;
    if (typeof this.options.onTransportStateChanged === "function") {
      this.options.onTransportStateChanged({
        connected: this.transport.connected === true,
        secure: this.transport.secure === true,
        previous,
      });
    }
  }

  setConnected(connected) {
    const previous = {
      connected: this.transport.connected === true,
      secure: this.transport.secure === true,
    };
    this.transport.connected = connected === true;
    if (typeof this.options.onTransportStateChanged === "function") {
      this.options.onTransportStateChanged({
        connected: this.transport.connected === true,
        secure: this.transport.secure === true,
        previous,
      });
    }
  }

  emitError(error) {
    if (typeof this.options.onError === "function") this.options.onError(error);
  }
}
FakeSidecarClient.instances = [];

class ThrowingSidecarClient extends FakeSidecarClient {
  start() {
    this.started = true;
    throw new Error("spawn failed");
  }
}

class ThrowsOnRestartSidecarClient extends FakeSidecarClient {
  start() {
    this.started = true;
    ThrowsOnRestartSidecarClient.starts += 1;
    if (ThrowsOnRestartSidecarClient.starts > 1) {
      throw new Error("restart spawn failed");
    }
  }
}
ThrowsOnRestartSidecarClient.starts = 0;

class FakeHardwareBuddyController {
  constructor(options) {
    this.options = options;
    this.started = false;
    this.stopped = false;
    this.stateChanges = 0;
    this.permissionChanges = 0;
    FakeHardwareBuddyController.instances.push(this);
  }

  start() {
    this.started = true;
    return this.options.getSessionSnapshot();
  }

  stop() {
    this.stopped = true;
  }

  notifyStateChanged() {
    this.stateChanges += 1;
    return this.options.getSessionSnapshot();
  }

  notifyPermissionsChanged() {
    this.permissionChanges += 1;
    return this.options.getPendingPermissions();
  }
}
FakeHardwareBuddyController.instances = [];

class PromptingHardwareBuddyController {
  constructor(options) {
    this.options = options;
    this.started = false;
    this.stopped = false;
    this.unsubscribe = null;
    PromptingHardwareBuddyController.instances.push(this);
  }

  start() {
    this.started = true;
    if (this.options.transport && typeof this.options.transport.onCommand === "function") {
      this.unsubscribe = this.options.transport.onCommand((command) => this.handleCommand(command));
    }
    return this.emitSnapshot("start");
  }

  stop() {
    this.stopped = true;
    if (typeof this.unsubscribe === "function") this.unsubscribe();
    this.unsubscribe = null;
  }

  notifyStateChanged() {
    return this.emitSnapshot("state-change");
  }

  notifyPermissionsChanged() {
    return this.emitSnapshot("permission-change");
  }

  isSecure() {
    const transport = this.options.transport;
    if (transport && typeof transport.isSecure === "function") return transport.isSecure() === true;
    return !!(transport && transport.secure === true);
  }

  pending() {
    return typeof this.options.getPendingPermissions === "function"
      ? this.options.getPendingPermissions()
      : [];
  }

  buildSnapshot() {
    const entries = this.pending();
    const first = entries[0] || null;
    const snapshot = {
      total: 0,
      running: 0,
      waiting: this.isSecure() ? entries.length : 0,
      msg: "",
      entries: [],
      tokens: 0,
      tokens_today: 0,
    };
    if (this.isSecure() && first) {
      snapshot.prompt = {
        id: "hb_1",
        tool: first.toolName || "Unknown",
        hint: "",
      };
      snapshot.msg = `approve: ${snapshot.prompt.tool}`;
    }
    return snapshot;
  }

  emitSnapshot(reason) {
    const snapshot = this.buildSnapshot();
    if (this.options.transport && typeof this.options.transport.send === "function") {
      this.options.transport.send(snapshot, { reason });
    }
    return snapshot;
  }

  handleCommand(command) {
    if (!command || command.cmd !== "permission") return false;
    if (!this.isSecure()) return false;
    if (command.id !== "hb_1") return false;
    const behavior = command.decision === "once" ? "allow" : (command.decision === "deny" ? "deny" : null);
    if (!behavior) return false;
    const entry = this.pending()[0] || null;
    if (!entry || typeof this.options.resolvePermissionEntry !== "function") return false;
    this.options.resolvePermissionEntry(entry, behavior);
    this.emitSnapshot("permission-reply");
    return true;
  }
}
PromptingHardwareBuddyController.instances = [];

function resetFakes() {
  FakeSidecarClient.instances.length = 0;
  FakeHardwareBuddyController.instances.length = 0;
  PromptingHardwareBuddyController.instances.length = 0;
  ThrowsOnRestartSidecarClient.starts = 0;
}

function createFakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout(fn, ms) {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
  };
}

describe("hardware buddy adapter", () => {
  it("is disabled unless explicitly requested by env", () => {
    assert.strictEqual(isEnabledFromEnv({}), false);
    assert.strictEqual(isEnabledFromEnv({ CLAWD_HARDWARE_BUDDY: "1" }), true);
    assert.strictEqual(isEnabledFromEnv({ CLAWD_HARDWARE_BUDDY_BACKEND: "bleak" }), true);
    assert.strictEqual(isEnabledFromEnv({ CLAWD_HARDWARE_BUDDY_ADDRESS: "AA:BB" }), true);
    assert.strictEqual(isEnabledFromEnv({
      CLAWD_HARDWARE_BUDDY: "1",
      CLAWD_HARDWARE_BUDDY_DISABLED: "true",
    }), false);
  });

  it("does not load or start core modules when disabled", () => {
    resetFakes();
    const adapter = createHardwareBuddyAdapter({
      env: {},
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
    });

    assert.strictEqual(adapter.start(), false);
    assert.strictEqual(FakeSidecarClient.instances.length, 0);
    assert.strictEqual(FakeHardwareBuddyController.instances.length, 0);
  });

  it("starts state-only controller and suppresses pending permissions by default", () => {
    resetFakes();
    const perm = { toolName: "Bash" };
    const adapter = createHardwareBuddyAdapter({
      env: { CLAWD_HARDWARE_BUDDY: "1", CLAWD_HARDWARE_BUDDY_BACKEND: "fake" },
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
      notifyDebounceMs: 0,
      getSessionSnapshot: () => ({ sessions: [{ id: "s1", state: "working" }] }),
      getPendingPermissions: () => [perm],
      getDoNotDisturb: () => false,
    });

    assert.strictEqual(adapter.start(), true);
    const sidecar = FakeSidecarClient.instances[0];
    const controller = FakeHardwareBuddyController.instances[0];

    assert.strictEqual(sidecar.started, true);
    assert.strictEqual(controller.started, true);
    assert.deepStrictEqual(controller.options.getPendingPermissions(), []);
    assert.deepStrictEqual(adapter.notifyStateChanged(), {
      sessions: [{ id: "s1", state: "working" }],
    });

    adapter.stop();
    assert.strictEqual(controller.stopped, true);
    assert.strictEqual(sidecar.stopped, true);
  });

  it("can opt into permission entries for a later secure phase", () => {
    resetFakes();
    const perm = { toolName: "Bash" };
    const resolvePermissionEntry = () => {};
    const statePriority = { working: 3 };
    const adapter = createHardwareBuddyAdapter({
      env: { CLAWD_HARDWARE_BUDDY: "1" },
      permissionsEnabled: true,
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
      getPendingPermissions: () => [perm],
      resolvePermissionEntry,
      statePriority,
    });

    adapter.start();
    const controller = FakeHardwareBuddyController.instances[0];
    assert.deepStrictEqual(controller.options.getPendingPermissions(), [perm]);
    assert.strictEqual(controller.options.resolvePermissionEntry, resolvePermissionEntry);
    assert.strictEqual(controller.options.statePriority, statePriority);
  });

  it("does not invoke the resolver when transport is insecure even with permissions on", () => {
    resetFakes();
    const perm = { toolName: "Bash" };
    const resolved = [];
    const adapter = createHardwareBuddyAdapter({
      env: { CLAWD_HARDWARE_BUDDY: "1" },
      permissionsEnabled: true,
      coreModules: {
        HardwareBuddyController: PromptingHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
      getPendingPermissions: () => [perm],
      resolvePermissionEntry: (entry, behavior) => resolved.push({ entry, behavior }),
    });

    adapter.start();
    const sidecar = FakeSidecarClient.instances[0];
    assert.ok(!Object.prototype.hasOwnProperty.call(sidecar.lastSent().snapshot, "prompt"));

    sidecar.injectCommand({ cmd: "permission", id: "hb_1", decision: "once" });

    assert.deepStrictEqual(resolved, []);
    adapter.stop();
  });

  it("emits prompts only after the transport becomes secure", () => {
    resetFakes();
    const perm = { toolName: "Bash" };
    const adapter = createHardwareBuddyAdapter({
      env: { CLAWD_HARDWARE_BUDDY: "1" },
      permissionsEnabled: true,
      coreModules: {
        HardwareBuddyController: PromptingHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
      getPendingPermissions: () => [perm],
      resolvePermissionEntry: () => {},
    });

    adapter.start();
    const sidecar = FakeSidecarClient.instances[0];
    assert.ok(!Object.prototype.hasOwnProperty.call(sidecar.lastSent().snapshot, "prompt"));

    sidecar.setSecure(true);
    assert.deepStrictEqual(sidecar.lastSent().snapshot.prompt, {
      id: "hb_1",
      tool: "Bash",
      hint: "",
    });

    sidecar.setSecure(false);
    assert.ok(!Object.prototype.hasOwnProperty.call(sidecar.lastSent().snapshot, "prompt"));
    adapter.stop();
  });

  it("logs when permission mode is enabled without a resolver", () => {
    resetFakes();
    const logs = [];
    const adapter = createHardwareBuddyAdapter({
      env: { CLAWD_HARDWARE_BUDDY: "1" },
      permissionsEnabled: true,
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
      log: (message) => logs.push(message),
    });

    adapter.start();
    assert.match(logs.join("\n"), /resolvePermissionEntry is unavailable/);
    assert.strictEqual(FakeHardwareBuddyController.instances[0].options.resolvePermissionEntry, null);
  });

  it("debounces repeated state-change notifications", () => {
    resetFakes();
    const fakeTimers = createFakeTimers();
    const adapter = createHardwareBuddyAdapter({
      env: { CLAWD_HARDWARE_BUDDY: "1" },
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
      setTimeout: fakeTimers.setTimeout,
      clearTimeout: fakeTimers.clearTimeout,
      getSessionSnapshot: () => ({ sessions: [{ id: "s1", state: "working" }] }),
    });

    adapter.start();
    const controller = FakeHardwareBuddyController.instances[0];
    assert.strictEqual(adapter.notifyStateChanged(), true);
    assert.strictEqual(adapter.notifyStateChanged(), true);
    assert.strictEqual(controller.stateChanges, 0);
    assert.strictEqual(fakeTimers.timers.length, 1);
    assert.strictEqual(fakeTimers.timers[0].ms, 50);

    fakeTimers.timers[0].fn();
    assert.strictEqual(controller.stateChanges, 1);
  });

  it("clears pending state notifications on stop", () => {
    resetFakes();
    const fakeTimers = createFakeTimers();
    const adapter = createHardwareBuddyAdapter({
      env: { CLAWD_HARDWARE_BUDDY: "1" },
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
      setTimeout: fakeTimers.setTimeout,
      clearTimeout: fakeTimers.clearTimeout,
    });

    adapter.start();
    adapter.notifyStateChanged();
    adapter.stop();

    assert.strictEqual(fakeTimers.timers[0].cleared, true);
    assert.strictEqual(adapter.notifyStateChanged(), null);
  });

  it("keeps start idempotent", () => {
    resetFakes();
    const adapter = createHardwareBuddyAdapter({
      env: { CLAWD_HARDWARE_BUDDY: "1" },
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
    });

    assert.strictEqual(adapter.start(), true);
    assert.strictEqual(adapter.start(), true);
    assert.strictEqual(FakeSidecarClient.instances.length, 1);
    assert.strictEqual(FakeHardwareBuddyController.instances.length, 1);
  });

  it("cleans up partial startup state when sidecar start throws", () => {
    resetFakes();
    const fakeTimers = createFakeTimers();
    const adapter = createHardwareBuddyAdapter({
      env: {
        CLAWD_HARDWARE_BUDDY: "1",
        CLAWD_HARDWARE_BUDDY_CONNECT_RETRY_MS: "25",
      },
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: ThrowingSidecarClient,
      },
      setTimeout: fakeTimers.setTimeout,
      clearTimeout: fakeTimers.clearTimeout,
    });

    assert.throws(() => adapter.start(), /spawn failed/);
    assert.strictEqual(adapter.isStarted(), false);
    assert.strictEqual(adapter.getSidecar(), null);
    assert.strictEqual(adapter.getController(), null);
    assert.strictEqual(FakeSidecarClient.instances[0].stopped, true);
    assert.strictEqual(FakeHardwareBuddyController.instances[0].stopped, true);
    assert.strictEqual(adapter.getStatus().lastError.category, "sidecar_error");
    assert.ok(fakeTimers.timers.find((timer) => !timer.cleared && timer.ms === 25));
  });

  it("auto-connects when an address is configured", async () => {
    resetFakes();
    const adapter = createHardwareBuddyAdapter({
      env: {
        CLAWD_HARDWARE_BUDDY: "1",
        CLAWD_HARDWARE_BUDDY_BACKEND: "fake",
        CLAWD_HARDWARE_BUDDY_ADDRESS: "FAKE:CLAWSTICK",
        CLAWD_HARDWARE_BUDDY_CONNECT_DELAY_MS: "0",
      },
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
    });

    adapter.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepStrictEqual(FakeSidecarClient.instances[0].connects, ["FAKE:CLAWSTICK"]);
  });

  it("uses product settings to enable prefix scan without env flags", () => {
    resetFakes();
    const fakeTimers = createFakeTimers();
    const adapter = createHardwareBuddyAdapter({
      settings: {
        enabled: true,
        backend: "fake",
        address: "",
        namePrefix: "Claude",
        permissionsEnabled: false,
      },
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
      setTimeout: fakeTimers.setTimeout,
      clearTimeout: fakeTimers.clearTimeout,
    });

    assert.strictEqual(adapter.start(), true);
    assert.strictEqual(fakeTimers.timers.length, 1);
    fakeTimers.timers[0].fn();

    const sidecar = FakeSidecarClient.instances[0];
    assert.strictEqual(sidecar.scans, 1);
    sidecar.emitDevices([{ name: "Claude-9EA6", address: "00:4B:12:A1:9E:A6" }]);
    assert.deepStrictEqual(sidecar.connects, [{ address: "00:4B:12:A1:9E:A6" }]);
  });

  it("keeps Quick Commands disabled by default", () => {
    resetFakes();
    const adapter = createHardwareBuddyAdapter({ env: {} });

    assert.deepStrictEqual(adapter.getQuickCommandPresets(), {
      enabled: false,
      presets: adapter.getQuickCommandPresets().presets,
    });
    assert.equal(
      adapter.getQuickCommandPresets().presets.some((preset) => preset.id === "stop" || preset.label === "停"),
      false
    );
    assert.deepStrictEqual(adapter.createQuickCommand({
      id: "plan_first",
      clientRequestId: "qc-disabled-1",
    }), {
      status: "error",
      code: "quick_commands_disabled",
      message: "Quick Commands are disabled.",
    });
  });

  it("buffers validated Quick Commands when explicitly enabled without starting BLE", () => {
    resetFakes();
    const settings = {
      enabled: false,
      backend: "fake",
      address: "",
      namePrefix: "Claude",
      permissionsEnabled: false,
      quickCommandsEnabled: true,
    };
    const adapter = createHardwareBuddyAdapter({
      settings,
      env: {},
      now: () => 1234,
    });

    assert.strictEqual(adapter.start(), false);
    assert.strictEqual(FakeSidecarClient.instances.length, 0);
    assert.strictEqual(adapter.getQuickCommandPresets().enabled, true);

    const result = adapter.createQuickCommand({
      id: "plan_first",
      clientRequestId: "qc-plan-1",
    });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.duplicate, false);
    assert.strictEqual(result.quickCommand.id, "plan_first");
    assert.strictEqual(result.quickCommand.target.resolution, "defer_to_adapter");
    assert.strictEqual(result.quickCommand.createdAt, 1234);

    const duplicate = adapter.createQuickCommand({
      id: "plan_first",
      clientRequestId: "qc-plan-1",
    });
    assert.strictEqual(duplicate.status, "ok");
    assert.strictEqual(duplicate.duplicate, true);
    assert.strictEqual(duplicate.quickCommand.seq, result.quickCommand.seq);

    assert.deepStrictEqual(adapter.listQuickCommands({ after: 0 }).items.map((item) => item.id), ["plan_first"]);
    assert.strictEqual(adapter.getStatus().quickCommands.enabled, true);
    assert.strictEqual(adapter.getStatus().quickCommands.sink.size, 1);
  });

  it("rebuilds the controller without reconnecting when permission opt-in changes", () => {
    resetFakes();
    const fakeTimers = createFakeTimers();
    const pending = [{ toolName: "Bash" }];
    const resolved = [];
    const baseSettings = {
      enabled: true,
      backend: "fake",
      address: "",
      namePrefix: "Claude",
      permissionsEnabled: false,
    };
    const adapter = createHardwareBuddyAdapter({
      settings: baseSettings,
      coreModules: {
        HardwareBuddyController: PromptingHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
      getPendingPermissions: () => pending,
      resolvePermissionEntry: (entry, behavior) => resolved.push({ entry, behavior }),
      setTimeout: fakeTimers.setTimeout,
      clearTimeout: fakeTimers.clearTimeout,
    });

    assert.strictEqual(adapter.start(), true);
    const firstController = PromptingHardwareBuddyController.instances[0];
    const firstSidecar = FakeSidecarClient.instances[0];
    assert.strictEqual(firstController.options.resolvePermissionEntry, null);

    firstSidecar.setConnected(true);
    firstSidecar.setSecure(true);
    adapter.notifyPermissionsChanged();
    assert.strictEqual(firstSidecar.lastSent().snapshot.prompt, undefined);

    assert.strictEqual(adapter.applySettingsChange({
      ...baseSettings,
      permissionsEnabled: true,
    }), true);

    assert.strictEqual(firstController.stopped, true);
    assert.strictEqual(firstSidecar.stopped, false);
    assert.strictEqual(PromptingHardwareBuddyController.instances.length, 2);
    assert.strictEqual(FakeSidecarClient.instances.length, 1);

    const secondController = PromptingHardwareBuddyController.instances[1];
    assert.strictEqual(typeof secondController.options.resolvePermissionEntry, "function");
    assert.strictEqual(secondController.options.transport, firstSidecar.transport);
    assert.deepStrictEqual(
      {
        permissionsEnabled: adapter.getStatus().permissionsEnabled,
        connected: adapter.getStatus().connected,
        secure: adapter.getStatus().secure,
      },
      { permissionsEnabled: true, connected: true, secure: true }
    );

    adapter.notifyPermissionsChanged();
    assert.strictEqual(firstSidecar.lastSent().snapshot.prompt.tool, "Bash");

    firstSidecar.injectCommand({ cmd: "permission", id: "hb_1", decision: "once" });
    assert.deepStrictEqual(resolved, [{ entry: pending[0], behavior: "allow" }]);
  });

  it("retries auto-connect after a connection error", () => {
    resetFakes();
    const fakeTimers = createFakeTimers();
    const adapter = createHardwareBuddyAdapter({
      env: {
        CLAWD_HARDWARE_BUDDY: "1",
        CLAWD_HARDWARE_BUDDY_BACKEND: "fake",
        CLAWD_HARDWARE_BUDDY_ADDRESS: "FAKE:CLAWSTICK",
        CLAWD_HARDWARE_BUDDY_CONNECT_DELAY_MS: "10",
        CLAWD_HARDWARE_BUDDY_CONNECT_RETRY_MS: "25",
      },
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
      setTimeout: fakeTimers.setTimeout,
      clearTimeout: fakeTimers.clearTimeout,
    });

    adapter.start();
    assert.strictEqual(fakeTimers.timers.length, 1);
    assert.strictEqual(fakeTimers.timers[0].ms, 10);

    fakeTimers.timers[0].fn();
    const sidecar = FakeSidecarClient.instances[0];
    assert.deepStrictEqual(sidecar.connects, ["FAKE:CLAWSTICK"]);

    sidecar.emitError({ message: "device not found", code: "NO_DEVICE" });
    const retryTimer = fakeTimers.timers.find((timer) => !timer.cleared && timer.ms === 25);
    assert.ok(retryTimer);

    retryTimer.fn();
    assert.deepStrictEqual(sidecar.connects, ["FAKE:CLAWSTICK", "FAKE:CLAWSTICK"]);

    sidecar.emitError({ message: "device not found", code: "NO_DEVICE" });
    const secondRetry = fakeTimers.timers.find((timer) => !timer.cleared && timer.ms === 50 && timer !== retryTimer);
    assert.ok(secondRetry);
    sidecar.setConnected(true);
    assert.strictEqual(secondRetry.cleared, true);
  });

  it("does not inflate retry attempts for repeated non-matching scan results while retry is pending", () => {
    resetFakes();
    const fakeTimers = createFakeTimers();
    const adapter = createHardwareBuddyAdapter({
      settings: {
        enabled: true,
        backend: "fake",
        address: "",
        namePrefix: "Claude",
        permissionsEnabled: false,
      },
      env: {
        CLAWD_HARDWARE_BUDDY_CONNECT_DELAY_MS: "10",
        CLAWD_HARDWARE_BUDDY_CONNECT_RETRY_MS: "25",
      },
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
      setTimeout: fakeTimers.setTimeout,
      clearTimeout: fakeTimers.clearTimeout,
    });

    adapter.start();
    fakeTimers.timers[0].fn();

    const sidecar = FakeSidecarClient.instances[0];
    sidecar.emitDevices([{ name: "Other-1", address: "11" }]);
    const firstStatus = adapter.getStatus();
    assert.strictEqual(firstStatus.lastError.category, "device_not_found");
    assert.strictEqual(firstStatus.retryAttempt, 1);
    const retryTimer = fakeTimers.timers.find((timer) => !timer.cleared && timer.ms === 25);
    assert.ok(retryTimer);

    sidecar.emitDevices([{ name: "Other-2", address: "22" }]);
    const secondStatus = adapter.getStatus();
    assert.strictEqual(secondStatus.retryAttempt, 1);
    assert.strictEqual(
      fakeTimers.timers.filter((timer) => !timer.cleared && timer.ms === 25).length,
      1
    );

    sidecar.emitDevices([{ name: "Claude-9EA6", address: "00:4B:12:A1:9E:A6" }]);
    assert.deepStrictEqual(sidecar.connects, [{ address: "00:4B:12:A1:9E:A6" }]);
    assert.strictEqual(retryTimer.cleared, true);
    assert.strictEqual(adapter.getStatus().retryAttempt, 0);
    assert.strictEqual(adapter.getStatus().lastError, null);
  });

  it("records transport disconnects as retryable status and backs off reconnects", () => {
    resetFakes();
    const fakeTimers = createFakeTimers();
    const adapter = createHardwareBuddyAdapter({
      env: {
        CLAWD_HARDWARE_BUDDY: "1",
        CLAWD_HARDWARE_BUDDY_BACKEND: "fake",
        CLAWD_HARDWARE_BUDDY_ADDRESS: "FAKE:CLAWSTICK",
        CLAWD_HARDWARE_BUDDY_CONNECT_RETRY_MS: "25",
      },
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
      setTimeout: fakeTimers.setTimeout,
      clearTimeout: fakeTimers.clearTimeout,
    });

    adapter.start();
    const sidecar = FakeSidecarClient.instances[0];
    sidecar.setConnected(true);
    sidecar.setConnected(false);

    const status = adapter.getStatus();
    assert.strictEqual(status.lastError.category, "transport_disconnected");
    assert.strictEqual(status.retryAttempt, 1);
    const retryTimer = fakeTimers.timers.find((timer) => !timer.cleared && timer.ms === 25);
    assert.ok(retryTimer);

    retryTimer.fn();
    assert.deepStrictEqual(sidecar.connects, ["FAKE:CLAWSTICK"]);
  });

  it("catches restart timer failures and schedules another restart", () => {
    resetFakes();
    const fakeTimers = createFakeTimers();
    const adapter = createHardwareBuddyAdapter({
      env: {
        CLAWD_HARDWARE_BUDDY: "1",
        CLAWD_HARDWARE_BUDDY_CONNECT_RETRY_MS: "25",
      },
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: ThrowsOnRestartSidecarClient,
      },
      setTimeout: fakeTimers.setTimeout,
      clearTimeout: fakeTimers.clearTimeout,
    });

    adapter.start();
    const sidecar = FakeSidecarClient.instances[0];
    sidecar.options.log("warn", "sidecar exited: code=1 signal=");
    const restartTimer = fakeTimers.timers.find((timer) => !timer.cleared && timer.ms === 25);
    assert.ok(restartTimer);

    assert.doesNotThrow(() => restartTimer.fn());

    const status = adapter.getStatus();
    assert.strictEqual(status.lastError.category, "sidecar_error");
    assert.strictEqual(status.retryAttempt, 2);
    const nextRestart = fakeTimers.timers.find((timer) => !timer.cleared && timer.ms === 50);
    assert.ok(nextRestart);
  });

  it("classifies missing bleak as non-retryable", () => {
    resetFakes();
    const fakeTimers = createFakeTimers();
    const adapter = createHardwareBuddyAdapter({
      settings: {
        enabled: true,
        backend: "bleak",
        address: "00:4B:12:A1:9E:A6",
        namePrefix: "Claude",
        permissionsEnabled: false,
      },
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
      setTimeout: fakeTimers.setTimeout,
      clearTimeout: fakeTimers.clearTimeout,
    });

    adapter.start();
    const sidecar = FakeSidecarClient.instances[0];
    sidecar.emitError({ message: "No module named bleak", code: "MISSING_BLEAK" });

    const status = adapter.getStatus();
    assert.strictEqual(status.lastError.category, "missing_bleak");
    assert.strictEqual(status.lastError.retryable, false);
    assert.strictEqual(fakeTimers.timers.filter((timer) => !timer.cleared).length, 1);
  });

  it("passes the fake secure setting through to the sidecar", () => {
    resetFakes();
    const adapter = createHardwareBuddyAdapter({
      env: {
        CLAWD_HARDWARE_BUDDY: "1",
        CLAWD_HARDWARE_BUDDY_BACKEND: "fake",
        CLAWD_HARDWARE_BUDDY_FAKE_SECURE: "false",
      },
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
    });

    adapter.start();
    assert.deepStrictEqual(
      FakeSidecarClient.instances[0].options.args.slice(-2),
      ["--fake-secure", "false"]
    );
  });

  it("ignores the fake secure setting for non-fake backends", () => {
    resetFakes();
    const adapter = createHardwareBuddyAdapter({
      env: {
        CLAWD_HARDWARE_BUDDY: "1",
        CLAWD_HARDWARE_BUDDY_BACKEND: "bleak",
        CLAWD_HARDWARE_BUDDY_FAKE_SECURE: "false",
      },
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
    });

    adapter.start();
    assert.equal(FakeSidecarClient.instances[0].options.args.includes("--fake-secure"), false);
  });

  it("stops the hardware adapter before permission cleanup during app quit", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    const start = source.indexOf('app.on("before-quit"');
    const end = source.indexOf('app.on("window-all-closed"', start);
    const block = source.slice(start, end);
    const hardwareStop = block.indexOf("hardwareBuddyAdapter.stop()");
    const permissionCleanup = block.indexOf("_perm.cleanup()");

    assert.ok(hardwareStop !== -1, "before-quit should stop hardware buddy");
    assert.ok(permissionCleanup !== -1, "before-quit should clean permission runtime");
    assert.ok(hardwareStop < permissionCleanup, "hardware buddy must stop before permission cleanup");
  });
});
