"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createTelegramMigrationController,
} = require("../src/telegram-migration-controller");
const { STATES, EVENTS } = require("../src/telegram-migration-state");

class FakeSidecar {
  constructor() { this.running = false; this.stopCalls = []; }
  isRunning() { return this.running; }
  async start() { this.running = true; }
  async stop() { this.stopCalls.push(true); this.running = false; }
}

class FakeNative {
  constructor() { this.polling = false; this.cards = []; }
  isPolling() { return this.polling; }
  async start() { this.polling = true; }
  async stop() { this.polling = false; }
  async sendTestCard(payload) { this.cards.push(payload); }
}

function makeController(overrides = {}) {
  const sidecar = new FakeSidecar();
  const native = new FakeNative();
  let prefsState = { ...overrides.initialPrefs };
  let filesState = { ...overrides.initialFiles };
  const persisted = [];
  const timers = [];
  const ctrl = createTelegramMigrationController({
    sidecar,
    native,
    readPrefs: () => prefsState,
    writePrefs: async (patch) => { prefsState = { ...prefsState, ...patch }; persisted.push(patch); },
    readFiles: () => filesState,
    settleMs: 0,
    stopGraceMs: 0,
    setTimer: (cb, ms) => { const t = { cb, ms, cancelled: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cancelled = true; },
    log: () => {},
    ...overrides.opts,
  });
  return { ctrl, sidecar, native, persisted,
    setFiles(f) { filesState = { ...filesState, ...f }; },
    setPrefs(p) { prefsState = { ...prefsState, ...p }; },
    getPrefs: () => prefsState,
    fireTimer: async () => {
      const t = timers.find((x) => !x.cancelled && !x.fired);
      if (!t) throw new Error("no pending timer");
      t.fired = true;
      t.cb();
      // Let async dispatch + manager.apply chain settle.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    pendingTimer: () => timers.find((x) => !x.cancelled && !x.fired) || null,
  };
}

test("init: legacy user with full env → LEGACY_ACTIVE + starts sidecar", async () => {
  const env = makeController({
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true },
  });
  const state = await env.ctrl.init();
  assert.equal(state, STATES.LEGACY_ACTIVE);
  assert.equal(env.sidecar.running, true);
});

test("init: fresh user → IDLE, nothing started", async () => {
  const env = makeController({ initialFiles: {} });
  const state = await env.ctrl.init();
  assert.equal(state, STATES.IDLE);
  assert.equal(env.sidecar.running, false);
  assert.equal(env.native.polling, false);
});

test("init: v0.8 opt-out user (legacyEnabled=false) → IDLE NOT re-activated", async () => {
  const env = makeController({
    initialPrefs: { legacyEnabled: false },
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true },
  });
  const state = await env.ctrl.init();
  assert.equal(state, STATES.IDLE);
  assert.equal(env.sidecar.running, false);
});

test("dispatch USER_TEST_NATIVE from LEGACY_ACTIVE: stops sidecar, starts native, sends test card", async () => {
  const env = makeController({
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true, nativeConfigComplete: true },
  });
  await env.ctrl.init();
  assert.equal(env.sidecar.running, true);

  const res = await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  assert.equal(res.ok, true);
  assert.equal(res.state, STATES.TESTING_NATIVE);
  assert.equal(env.sidecar.running, false);
  assert.equal(env.native.polling, true);
  assert.equal(env.native.cards.length, 1);
});

test("dispatch TEST_SUCCESS from TESTING_NATIVE: persists transport=native + clears test timer", async () => {
  const env = makeController({
    initialFiles: { nativeConfigComplete: true },
  });
  await env.ctrl.init();
  await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  const res = await env.ctrl.dispatch({ type: EVENTS.TEST_SUCCESS, at: 12345 });
  assert.equal(res.ok, true);
  assert.equal(res.state, STATES.NATIVE_ACTIVE);
  const persistedPatches = env.persisted;
  const lastPatch = persistedPatches[persistedPatches.length - 1];
  assert.equal(lastPatch.transport, "native");
  assert.equal(lastPatch.nativeVerifiedAt, 12345);
});

test("dispatch USER_ROLLBACK_TO_LEGACY auto-finalizes after sidecar start", async () => {
  const env = makeController({
    initialPrefs: { transport: "native", nativeVerifiedAt: 1 },
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true, nativeConfigComplete: true },
  });
  await env.ctrl.init();
  assert.equal(env.native.polling, true);

  const res = await env.ctrl.dispatch({ type: EVENTS.USER_ROLLBACK_TO_LEGACY });
  assert.equal(res.ok, true);
  assert.equal(res.state, STATES.LEGACY_ACTIVE);
  assert.equal(env.native.polling, false);
  assert.equal(env.sidecar.running, true);
  assert.equal(env.persisted.at(-1).transport, "legacy");
});

test("dispatch USER_ROLLBACK_TO_LEGACY records failed legacy runtime when sidecar start returns false", async () => {
  const env = makeController({
    initialPrefs: { transport: "native", nativeVerifiedAt: 1 },
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true, nativeConfigComplete: true },
  });
  env.sidecar.start = async () => false;
  await env.ctrl.init();

  const res = await env.ctrl.dispatch({ type: EVENTS.USER_ROLLBACK_TO_LEGACY });
  assert.equal(res.ok, false);
  assert.equal(res.state, STATES.LEGACY_ACTIVE);
  assert.equal(env.native.polling, false);
  const snap = env.ctrl.getSnapshot();
  assert.equal(snap.runtimeStatus.status, "failed");
  assert.equal(env.persisted.at(-1).transport, "legacy");
});

test("dispatch: illegal event returns ok:false + errorCode + state unchanged", async () => {
  const env = makeController({
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true },
  });
  await env.ctrl.init();
  const res = await env.ctrl.dispatch({ type: EVENTS.TEST_SUCCESS });
  assert.equal(res.ok, false);
  assert.equal(res.errorCode, "ILLEGAL_TRANSITION");
  assert.equal(res.state, STATES.LEGACY_ACTIVE);
});

test("test timer is armed on entering TESTING_NATIVE and cancelled on success", async () => {
  const env = makeController({
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true, nativeConfigComplete: true },
  });
  await env.ctrl.init();
  await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  assert.ok(env.pendingTimer(), "timer should be armed in TESTING_NATIVE");

  await env.ctrl.dispatch({ type: EVENTS.TEST_SUCCESS, at: 1 });
  assert.equal(env.pendingTimer(), null, "successful test should cancel timer");
});

test("test timer firing dispatches TEST_TIMEOUT → falls back to LEGACY_ACTIVE", async () => {
  const env = makeController({
    initialFiles: { hasLegacyEnvFile: true, legacyConfigComplete: true, nativeConfigComplete: true },
  });
  await env.ctrl.init();
  await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  await env.fireTimer();
  const snap = env.ctrl.getSnapshot();
  assert.equal(snap.state, STATES.LEGACY_ACTIVE);
  assert.equal(env.sidecar.running, true);
});

test("getSnapshot exposes state + runtime status + owner snapshot", async () => {
  const env = makeController({});
  await env.ctrl.init();
  const snap = env.ctrl.getSnapshot();
  assert.equal(snap.state, STATES.IDLE);
  assert.equal(typeof snap.ownerSnapshot.sidecarRunning, "boolean");
  assert.equal(typeof snap.ownerSnapshot.nativePolling, "boolean");
  // Undecided prefs surface as transport=undefined, not "off" (we distinguish
  // "user explicitly disabled" from "v0.8 user with no transport key yet").
  assert.equal(snap.transport, undefined);
});
