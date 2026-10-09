"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createTelegramMigrationController,
} = require("../src/telegram-migration-controller");
const {
  STATES,
  EVENTS,
  TEST_ORIGINS,
} = require("../src/telegram-migration-state");

class FakeNative {
  constructor() {
    this.polling = false;
    this.startCalls = 0;
    this.stopCalls = 0;
    this.cards = 0;
    this.failStart = null;
    this.failStop = null;
    this.failCard = null;
  }
  isPolling() { return this.polling; }
  async start() {
    this.startCalls += 1;
    if (this.failStart) throw this.failStart;
    this.polling = true;
  }
  async stop() {
    this.stopCalls += 1;
    if (this.failStop) throw this.failStop;
    this.polling = false;
  }
  async sendTestCard() {
    this.cards += 1;
    if (this.failCard) throw this.failCard;
  }
}

function makeController(overrides = {}) {
  const native = overrides.native || new FakeNative();
  let prefsState = { ...(overrides.initialPrefs || {}) };
  let filesState = {
    nativeConfigComplete: overrides.nativeConfigComplete === true,
  };
  const writes = [];
  const timers = [];
  const revisions = [];
  const logs = [];
  let clock = 1000;
  const ctrl = createTelegramMigrationController({
    native,
    readPrefs: () => ({ ...prefsState }),
    writePrefs: overrides.writePrefs || (async (patch) => {
      prefsState = { ...prefsState, ...patch };
      writes.push({ ...patch });
    }),
    readFiles: () => ({ ...filesState }),
    setTimer: (cb, ms) => {
      const timer = { cb, ms, cancelled: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { if (timer) timer.cancelled = true; },
    now: () => ++clock,
    onSnapshotChanged: ({ revision }) => revisions.push(revision),
    log: overrides.log || ((level, message, meta) => {
      logs.push({ level, message, meta });
    }),
  });
  return {
    ctrl,
    native,
    writes,
    revisions,
    logs,
    getPrefs: () => ({ ...prefsState }),
    setPrefs: (patch) => { prefsState = { ...prefsState, ...patch }; },
    setFiles: (patch) => { filesState = { ...filesState, ...patch }; },
    pendingTimer: () => timers.find((entry) => !entry.cancelled && !entry.fired) || null,
    fireTimer: async () => {
      const timer = timers.find((entry) => !entry.cancelled && !entry.fired);
      assert.ok(timer, "expected pending timer");
      timer.fired = true;
      timer.cb();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("controller requires only a native handle, never a sidecar", () => {
  const native = new FakeNative();
  const ctrl = createTelegramMigrationController({
    native,
    readPrefs: () => ({}),
    writePrefs: async () => {},
    readFiles: () => ({}),
  });
  assert.equal(typeof ctrl.init, "function");
});

test("legacy init lands at migration-required with no runtime", async () => {
  const env = makeController({
    initialPrefs: { transport: "legacy", legacyEnabled: true },
    nativeConfigComplete: true,
  });
  assert.equal(await env.ctrl.init(), STATES.NATIVE_MIGRATION_REQUIRED);
  assert.equal(env.native.startCalls, 0);
  assert.equal(env.native.polling, false);
});

test("verified native init starts polling", async () => {
  const env = makeController({
    initialPrefs: { transport: "native", nativeVerifiedAt: 1 },
    nativeConfigComplete: true,
  });
  assert.equal(await env.ctrl.init(), STATES.NATIVE_ACTIVE);
  assert.equal(env.native.startCalls, 1);
});

test("repaired setup can test without restarting the app", async () => {
  const env = makeController({
    initialPrefs: { transport: "legacy" },
    nativeConfigComplete: false,
  });
  assert.equal(await env.ctrl.init(), STATES.NEEDS_SETUP);
  env.setFiles({ nativeConfigComplete: true });
  await env.ctrl.reconcileConfiguration();
  assert.equal(env.ctrl.getSnapshot().state, STATES.NATIVE_MIGRATION_REQUIRED);
  const result = await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  assert.equal(result.ok, true);
  assert.equal(result.state, STATES.TESTING_NATIVE);
  assert.equal(env.native.cards, 1);
});

test("USER_TEST_NATIVE reads live config even before reconcile runs", async () => {
  const env = makeController({
    initialPrefs: { transport: "legacy" },
    nativeConfigComplete: false,
  });
  await env.ctrl.init();
  env.setFiles({ nativeConfigComplete: true });
  const result = await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  assert.equal(result.ok, true);
  assert.equal(result.state, STATES.TESTING_NATIVE);
});

test("successful callback persists native only after write resolves", async () => {
  let releaseWrite;
  let writeEntered;
  const entered = new Promise((resolve) => { writeEntered = resolve; });
  const gate = new Promise((resolve) => { releaseWrite = resolve; });
  let prefsState = { transport: "legacy" };
  const native = new FakeNative();
  const ctrl = createTelegramMigrationController({
    native,
    readPrefs: () => ({ ...prefsState }),
    writePrefs: async (patch) => {
      writeEntered();
      await gate;
      prefsState = { ...prefsState, ...patch };
    },
    readFiles: () => ({ nativeConfigComplete: true }),
    log: () => {},
  });
  await ctrl.init();
  await ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  const pending = ctrl.dispatch({ type: EVENTS.TEST_SUCCESS, at: 42 });
  await entered;
  assert.equal(ctrl.getSnapshot().state, STATES.TESTING_NATIVE);
  releaseWrite();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(ctrl.getSnapshot().state, STATES.NATIVE_ACTIVE);
  assert.equal(prefsState.transport, "native");
});

test("a failed native persistence never publishes NATIVE_ACTIVE in memory", async () => {
  const env = makeController({
    initialPrefs: { transport: "legacy" },
    nativeConfigComplete: true,
    writePrefs: async () => {
      const err = new Error("disk full");
      err.code = "PREFS_WRITE_FAILED";
      throw err;
    },
  });
  await env.ctrl.init();
  await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  const result = await env.ctrl.dispatch({ type: EVENTS.TEST_SUCCESS, at: 42 });
  const snap = env.ctrl.getSnapshot();

  assert.equal(result.ok, false);
  assert.equal(snap.state, STATES.NATIVE_MIGRATION_REQUIRED);
  assert.notEqual(snap.transport, "native");
  assert.equal(snap.lastTestResult.outcome, "native-start-failed");
  assert.equal(snap.lastError.code, "PREFS_WRITE_FAILED");
});

test("a failed disable persistence keeps the active runtime selected", async () => {
  const native = new FakeNative();
  const env = makeController({
    native,
    initialPrefs: { transport: "native", nativeVerifiedAt: 99 },
    nativeConfigComplete: true,
    writePrefs: async () => {
      const err = new Error("read only");
      err.code = "PREFS_WRITE_FAILED";
      throw err;
    },
  });
  await env.ctrl.init();
  const result = await env.ctrl.dispatch({ type: EVENTS.USER_DISABLE });

  assert.equal(result.ok, false);
  assert.equal(env.ctrl.getSnapshot().state, STATES.NATIVE_ACTIVE);
  assert.equal(native.polling, true);
  assert.equal(native.stopCalls, 0);
});

test("TEST_SUCCESS wins a queued timeout race", async () => {
  let releaseWrite;
  let writeEntered;
  const entered = new Promise((resolve) => { writeEntered = resolve; });
  const gate = new Promise((resolve) => { releaseWrite = resolve; });
  let prefsState = { transport: "legacy" };
  const timers = [];
  const ctrl = createTelegramMigrationController({
    native: new FakeNative(),
    readPrefs: () => ({ ...prefsState }),
    writePrefs: async (patch) => {
      writeEntered();
      await gate;
      prefsState = { ...prefsState, ...patch };
    },
    readFiles: () => ({ nativeConfigComplete: true }),
    setTimer: (cb) => {
      const timer = { cb, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { if (timer) timer.cancelled = true; },
    log: () => {},
  });
  await ctrl.init();
  await ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  const success = ctrl.dispatch({ type: EVENTS.TEST_SUCCESS, at: 42 });
  await entered;
  timers[0].cb();
  releaseWrite();
  await success;
  await new Promise((resolve) => setImmediate(resolve));
  const snap = ctrl.getSnapshot();
  assert.equal(snap.state, STATES.NATIVE_ACTIVE);
  assert.equal(snap.lastTestResult, null);
});

for (const origin of [TEST_ORIGINS.LEGACY, TEST_ORIGINS.NATIVE_UNVERIFIED]) {
  for (const eventType of [EVENTS.TEST_FAILED, EVENTS.TEST_TIMEOUT]) {
    test(`${origin} ${eventType} never starts a legacy fallback`, async () => {
      const env = makeController({
        initialPrefs: origin === TEST_ORIGINS.LEGACY
          ? { transport: "legacy" }
          : { transport: "native", nativeVerifiedAt: null },
        nativeConfigComplete: true,
      });
      await env.ctrl.init();
      await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
      const result = await env.ctrl.dispatch({
        type: eventType,
        errorClass: "401",
      });
      assert.equal(result.state, STATES.NATIVE_MIGRATION_REQUIRED);
      assert.equal(env.native.polling, false);
      assert.equal(env.ctrl.getSnapshot().testOrigin, origin);
    });
  }
}

for (const origin of [TEST_ORIGINS.LEGACY, TEST_ORIGINS.NATIVE_UNVERIFIED]) {
  test(`${origin} native start failure has a terminal required state`, async () => {
    const native = new FakeNative();
    const err = new Error("start exploded");
    err.code = "START_FAILED";
    native.failStart = err;
    const env = makeController({
      native,
      initialPrefs: origin === TEST_ORIGINS.LEGACY
        ? { transport: "legacy" }
        : { transport: "native", nativeVerifiedAt: null },
      nativeConfigComplete: true,
    });
    await env.ctrl.init();
    const result = await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
    assert.equal(result.ok, false);
    const snap = env.ctrl.getSnapshot();
    assert.equal(snap.state, STATES.NATIVE_MIGRATION_REQUIRED);
    assert.equal(snap.lastTestResult.outcome, "native-start-failed");
    assert.equal(env.native.polling, false);
  });
}

test("timer records timeout and clears pending timer", async () => {
  const env = makeController({
    initialPrefs: { transport: "legacy" },
    nativeConfigComplete: true,
  });
  await env.ctrl.init();
  await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  assert.ok(env.pendingTimer());
  await env.fireTimer();
  assert.equal(env.pendingTimer(), null);
  assert.equal(env.ctrl.getSnapshot().lastTestResult.outcome, "timeout");
  assert.deepEqual(env.logs.filter((entry) => entry.message === "native Telegram verification failed"), [{
    level: "warn",
    message: "native Telegram verification failed",
    meta: { outcome: "timeout", errorClass: "timeout" },
  }]);
});

test("a stop cleanup failure still reaches a deterministic terminal state", async () => {
  const native = new FakeNative();
  native.failStop = Object.assign(new Error("abort cleanup failed"), { code: "STOP_FAILED" });
  const env = makeController({
    native,
    initialPrefs: { transport: "legacy" },
    nativeConfigComplete: true,
  });
  await env.ctrl.init();
  await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  const result = await env.ctrl.dispatch({ type: EVENTS.TEST_FAILED, errorClass: "network" });

  assert.equal(result.ok, true);
  assert.equal(result.state, STATES.NATIVE_MIGRATION_REQUIRED);
  assert.equal(env.ctrl.getSnapshot().lastTestResult.outcome, "failed");
  assert.equal(env.pendingTimer(), null);
});

test("unknown error classes are sanitized", async () => {
  const env = makeController({
    initialPrefs: { transport: "legacy" },
    nativeConfigComplete: true,
  });
  await env.ctrl.init();
  await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  await env.ctrl.dispatch({
    type: EVENTS.TEST_FAILED,
    errorClass: "token=secret raw body",
  });
  assert.deepEqual(env.ctrl.getSnapshot().lastTestResult.errorClass, "unknown");
  assert.doesNotMatch(JSON.stringify(env.ctrl.getSnapshot()), /secret raw/);
  assert.doesNotMatch(JSON.stringify(env.logs), /secret raw/);
  assert.deepEqual(env.logs.at(-1).meta, { outcome: "failed", errorClass: "unknown" });
});

test("late terminal events do not overwrite a successful result", async () => {
  const env = makeController({
    initialPrefs: { transport: "legacy" },
    nativeConfigComplete: true,
  });
  await env.ctrl.init();
  await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  await env.ctrl.dispatch({ type: EVENTS.TEST_SUCCESS, at: 42 });
  const revision = env.ctrl.getSnapshot().revision;
  const result = await env.ctrl.dispatch({ type: EVENTS.TEST_FAILED, errorClass: "401" });
  assert.equal(result.ok, false);
  assert.equal(env.ctrl.getSnapshot().state, STATES.NATIVE_ACTIVE);
  assert.equal(env.ctrl.getSnapshot().lastTestResult, null);
  assert.equal(env.ctrl.getSnapshot().revision, revision);
  assert.equal(env.logs.length, 0);
});

test("every accepted terminal failure path logs exactly one safe result", async (t) => {
  await t.test("TEST_FAILED", async () => {
    const env = makeController({
      initialPrefs: { transport: "off" },
      nativeConfigComplete: true,
    });
    await env.ctrl.init();
    await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
    await env.ctrl.dispatch({ type: EVENTS.TEST_FAILED, errorClass: "401" });
    assert.deepEqual(env.logs, [{
      level: "warn",
      message: "native Telegram verification failed",
      meta: { outcome: "failed", errorClass: "401" },
    }]);
  });

  await t.test("native start/apply failure", async () => {
    const native = new FakeNative();
    native.failStart = Object.assign(new Error("do not log this raw error"), {
      code: "START_FAILED",
      errorClass: "network",
    });
    const env = makeController({
      native,
      initialPrefs: { transport: "off" },
      nativeConfigComplete: true,
    });
    await env.ctrl.init();
    await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
    assert.deepEqual(env.logs, [{
      level: "warn",
      message: "native Telegram verification failed",
      meta: { outcome: "native-start-failed", errorClass: "network" },
    }]);
  });

  await t.test("identity change interrupts an in-flight test", async () => {
    const env = makeController({
      initialPrefs: { transport: "off" },
      nativeConfigComplete: true,
    });
    await env.ctrl.init();
    await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
    await env.ctrl.reconcileConfiguration({ identityChanged: true });
    assert.deepEqual(env.logs, [{
      level: "warn",
      message: "native Telegram verification failed",
      meta: { outcome: "failed", errorClass: "apply-failed" },
    }]);
  });
});

test("a throwing or rejecting logger cannot change a terminal transition", async (t) => {
  for (const [name, log] of [
    ["throwing", () => { throw new Error("disk full"); }],
    ["rejecting", () => Promise.reject(new Error("disk full"))],
  ]) {
    await t.test(name, async () => {
      const env = makeController({
        initialPrefs: { transport: "off" },
        nativeConfigComplete: true,
        log,
      });
      await env.ctrl.init();
      await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
      const result = await env.ctrl.dispatch({ type: EVENTS.TEST_FAILED, errorClass: "403" });
      assert.equal(result.ok, true);
      assert.equal(env.ctrl.getSnapshot().state, STATES.IDLE);
      assert.deepEqual(env.ctrl.getSnapshot().lastTestResult, {
        outcome: "failed",
        errorClass: "403",
        at: 1001,
      });
    });
  }
});

test("identity edits clear an idle failure while non-identity edits preserve it", async () => {
  const env = makeController({
    initialPrefs: { transport: "off" },
    nativeConfigComplete: true,
  });
  await env.ctrl.init();
  await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  await env.ctrl.dispatch({ type: EVENTS.TEST_FAILED, errorClass: "400" });
  assert.equal(env.ctrl.getSnapshot().state, STATES.IDLE);

  await env.ctrl.reconcileConfiguration({ identityChanged: false });
  assert.equal(env.ctrl.getSnapshot().lastTestResult.errorClass, "400");

  await env.ctrl.reconcileConfiguration({ identityChanged: true });
  assert.equal(env.ctrl.getSnapshot().lastTestResult, null);
});

test("retry clears a prior failure before the next terminal result", async () => {
  const env = makeController({
    initialPrefs: { transport: "off" },
    nativeConfigComplete: true,
  });
  await env.ctrl.init();
  await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  await env.ctrl.dispatch({ type: EVENTS.TEST_FAILED, errorClass: "429" });
  assert.ok(env.ctrl.getSnapshot().lastTestResult);

  await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  assert.equal(env.ctrl.getSnapshot().state, STATES.TESTING_NATIVE);
  assert.equal(env.ctrl.getSnapshot().lastTestResult, null);
});

test("identity change clears verification and requires a new test", async () => {
  const env = makeController({
    initialPrefs: { transport: "native", nativeVerifiedAt: 99 },
    nativeConfigComplete: true,
  });
  await env.ctrl.init();
  await env.ctrl.reconcileConfiguration({ identityChanged: true });
  const snap = env.ctrl.getSnapshot();
  assert.equal(snap.state, STATES.NATIVE_MIGRATION_REQUIRED);
  assert.equal(snap.nativeVerifiedAt, null);
  assert.equal(env.getPrefs().nativeVerifiedAt, null);
  assert.equal(env.native.polling, false);
});

test("verified native repairs a temporarily missing config without re-verification", async () => {
  const env = makeController({
    initialPrefs: { transport: "native", nativeVerifiedAt: 99 },
    nativeConfigComplete: false,
  });
  await env.ctrl.init();
  assert.equal(env.ctrl.getSnapshot().state, STATES.NEEDS_SETUP);
  env.setFiles({ nativeConfigComplete: true });
  await env.ctrl.reconcileConfiguration();
  assert.equal(env.ctrl.getSnapshot().state, STATES.NATIVE_ACTIVE);
  assert.equal(env.native.polling, true);
});

test("non-identity reconcile does not restart an active native poller", async () => {
  const env = makeController({
    initialPrefs: { transport: "native", nativeVerifiedAt: 99 },
    nativeConfigComplete: true,
  });
  await env.ctrl.init();
  assert.equal(env.native.startCalls, 1);
  await env.ctrl.reconcileConfiguration({ identityChanged: false });
  assert.equal(env.native.startCalls, 1);
  assert.equal(env.ctrl.getSnapshot().state, STATES.NATIVE_ACTIVE);
});

test("non-identity reconcile cannot settle an in-flight legacy migration test", async () => {
  const env = makeController({
    initialPrefs: { transport: "legacy" },
    nativeConfigComplete: true,
  });
  await env.ctrl.init();
  await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE });
  const revision = env.ctrl.getSnapshot().revision;

  await env.ctrl.reconcileConfiguration({ identityChanged: false });

  assert.equal(env.ctrl.getSnapshot().state, STATES.TESTING_NATIVE);
  assert.equal(env.ctrl.getSnapshot().revision, revision);
  assert.equal(env.native.startCalls, 1);
  assert.equal(env.native.stopCalls, 0);
  assert.ok(env.pendingTimer());
});

test("revision notifications are strictly increasing and secret-free", async () => {
  const env = makeController({
    initialPrefs: { transport: "legacy" },
    nativeConfigComplete: true,
  });
  await env.ctrl.init();
  await env.ctrl.dispatch({ type: EVENTS.USER_TEST_NATIVE, token: "do-not-forward" });
  await env.ctrl.dispatch({ type: EVENTS.TEST_FAILED, errorClass: "network" });
  assert.deepEqual(env.revisions, [1, 2, 3]);
  assert.doesNotMatch(JSON.stringify(env.ctrl.getSnapshot()), /do-not-forward/);
});
