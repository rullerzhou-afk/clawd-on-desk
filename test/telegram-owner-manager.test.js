"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  TelegramOwnerManager,
  InvariantError,
  DEFAULT_SETTLE_MS,
} = require("../src/telegram-owner-manager");
const {
  SIDE_EFFECTS,
  applyEvent,
  computeInitial,
  EVENTS,
  STATES,
} = require("../src/telegram-migration-state");
const { ALL_CASES } = require("./fakes/migration-transitions");

class FakeSidecar {
  constructor() {
    this.running = false;
    this.stopCalls = [];
    this.startDelayMs = 0;
  }
  isRunning() {
    return this.running;
  }
  async start() {
    if (this.startDelayMs) await new Promise((r) => setTimeout(r, this.startDelayMs));
    this.running = true;
  }
  async stop(opts = {}) {
    this.stopCalls.push(opts);
    this.running = false;
  }
}

class FakeNative {
  constructor() {
    this.polling = false;
    this.testCardCalls = [];
  }
  isPolling() {
    return this.polling;
  }
  async start() {
    this.polling = true;
  }
  async stop() {
    this.polling = false;
  }
  async sendTestCard(payload) {
    this.testCardCalls.push(payload);
  }
}

function makeManager(overrides = {}) {
  const sidecar = overrides.sidecar || new FakeSidecar();
  const native = overrides.native || new FakeNative();
  const slept = [];
  const sleep = overrides.sleep || ((ms) => {
    slept.push(ms);
    return Promise.resolve();
  });
  let clock = 1_000_000;
  const now = overrides.now || (() => clock);
  const advance = (ms) => {
    clock += ms;
  };
  const persistCalls = [];
  const onPersist = overrides.onPersist || ((patch) => {
    persistCalls.push(patch);
  });
  const mgr = new TelegramOwnerManager({
    sidecar,
    native,
    sleep,
    now,
    onPersist,
    ...overrides.opts,
  });
  return { mgr, sidecar, native, slept, advance, persistCalls };
}

test("constructor rejects handles missing required methods", () => {
  assert.throws(
    () => new TelegramOwnerManager({ sidecar: {}, native: new FakeNative() }),
    /sidecar handle must implement/,
  );
  assert.throws(
    () => new TelegramOwnerManager({ sidecar: new FakeSidecar(), native: {} }),
    /native handle must implement/,
  );
});

test("START_SIDECAR starts the sidecar; snapshot reflects state", async () => {
  const { mgr, sidecar } = makeManager();
  await mgr.apply([{ type: SIDE_EFFECTS.START_SIDECAR }]);
  assert.equal(sidecar.running, true);
  assert.deepEqual(mgr.snapshot(), { sidecarRunning: true, nativePolling: false });
});

test("START_SIDECAR treats explicit false return as startup failure", async () => {
  const sidecar = new FakeSidecar();
  sidecar.start = async () => false;
  const { mgr } = makeManager({ sidecar });
  await assert.rejects(
    () => mgr.apply([{ type: SIDE_EFFECTS.START_SIDECAR }]),
    (err) => {
      assert.ok(err instanceof InvariantError);
      assert.equal(err.code, "SIDECAR_START_FAILED");
      return true;
    },
  );
});

test("STOP_SIDECAR passes graceMs=2000 by default", async () => {
  const { mgr, sidecar } = makeManager();
  sidecar.running = true;
  await mgr.apply([{ type: SIDE_EFFECTS.STOP_SIDECAR }]);
  assert.deepEqual(sidecar.stopCalls, [{ graceMs: 2000 }]);
  assert.equal(sidecar.running, false);
});

test("START_NATIVE_POLLER waits settleMs after STOP_SIDECAR", async () => {
  const { mgr, sidecar, native, slept } = makeManager();
  sidecar.running = true;
  await mgr.apply([
    { type: SIDE_EFFECTS.STOP_SIDECAR },
    { type: SIDE_EFFECTS.START_NATIVE_POLLER },
  ]);
  assert.equal(native.polling, true);
  assert.equal(sidecar.running, false);
  assert.deepEqual(slept, [DEFAULT_SETTLE_MS], "expected one settle wait");
});

test("START_NATIVE_POLLER skips settle wait if enough time already elapsed", async () => {
  const { mgr, sidecar, native, slept, advance } = makeManager();
  sidecar.running = true;
  await mgr.apply([{ type: SIDE_EFFECTS.STOP_SIDECAR }]);
  advance(DEFAULT_SETTLE_MS + 50);
  await mgr.apply([{ type: SIDE_EFFECTS.START_NATIVE_POLLER }]);
  assert.equal(native.polling, true);
  assert.deepEqual(slept, [], "should not sleep when settle already satisfied");
});

test("Refuses START_NATIVE_POLLER while sidecar still running", async () => {
  const { mgr, sidecar, native } = makeManager();
  sidecar.running = true;
  await assert.rejects(
    () => mgr.apply([{ type: SIDE_EFFECTS.START_NATIVE_POLLER }]),
    (err) => {
      assert.ok(err instanceof InvariantError);
      assert.equal(err.code, "PRE_START_NATIVE_BUT_SIDECAR_RUNNING");
      return true;
    },
  );
  assert.equal(native.polling, false, "native must not have started");
});

test("Refuses START_SIDECAR while native still polling", async () => {
  const { mgr, sidecar, native } = makeManager();
  native.polling = true;
  await assert.rejects(
    () => mgr.apply([{ type: SIDE_EFFECTS.START_SIDECAR }]),
    (err) => {
      assert.ok(err instanceof InvariantError);
      assert.equal(err.code, "PRE_START_SIDECAR_BUT_NATIVE_POLLING");
      return true;
    },
  );
  assert.equal(sidecar.running, false);
});

test("Detects post-effect mutex violation (caller fake bug)", async () => {
  const { mgr, sidecar, native } = makeManager();
  sidecar.running = true;
  // Hand-craft an effect that does not enforce pre-check: STOP_NATIVE_POLLER
  // is fine, but the fake flips native.polling=true behind the manager's back
  // to simulate a faulty handle.
  native.polling = true;
  // Native polling but sidecar also still running → invariant must trip even
  // before any effects run.
  await assert.rejects(
    () => mgr.apply([{ type: SIDE_EFFECTS.STOP_NATIVE_POLLER }]),
    (err) => err.code === "MUTUAL_EXCLUSION_VIOLATED",
  );
});

test("apply() serializes concurrent calls", async () => {
  const { mgr, sidecar, native } = makeManager();
  sidecar.startDelayMs = 10;
  // Fire two applies back-to-back; second must observe first's completion.
  const p1 = mgr.apply([{ type: SIDE_EFFECTS.START_SIDECAR }]);
  const p2 = mgr.apply([{ type: SIDE_EFFECTS.STOP_SIDECAR }]);
  await Promise.all([p1, p2]);
  assert.equal(sidecar.running, false, "stop should run after start completes");
  assert.equal(native.polling, false);
});

test("apply() failure does not poison the queue", async () => {
  const { mgr, sidecar } = makeManager();
  sidecar.running = true;
  // First apply violates invariant.
  await assert.rejects(() => mgr.apply([{ type: SIDE_EFFECTS.START_NATIVE_POLLER }]));
  // Recover: stop sidecar, then start native should succeed.
  await mgr.apply([{ type: SIDE_EFFECTS.STOP_SIDECAR }]);
  // bypass settle delay by advancing clock-free via real sleep skipping
  await mgr.apply([{ type: SIDE_EFFECTS.START_NATIVE_POLLER }]);
  assert.equal(sidecar.running, false);
});

test("SEND_TEST_CARD forwards payload to native.sendTestCard", async () => {
  const { mgr, native } = makeManager();
  native.polling = true;
  await mgr.apply([{ type: SIDE_EFFECTS.SEND_TEST_CARD, payload: { nonce: "abc" } }]);
  assert.deepEqual(native.testCardCalls, [{ nonce: "abc" }]);
});

test("PERSIST_PREFS forwards patch to onPersist callback", async () => {
  const { mgr, persistCalls } = makeManager();
  await mgr.apply([{ type: SIDE_EFFECTS.PERSIST_PREFS, payload: { transport: "native" } }]);
  assert.deepEqual(persistCalls, [{ transport: "native" }]);
});

test("EMIT_RUNTIME_STATUS forwards payload to onRuntimeStatus callback", async () => {
  const statuses = [];
  const { mgr } = makeManager({
    opts: { onRuntimeStatus: (s) => { statuses.push(s); } },
  });
  await mgr.apply([
    { type: SIDE_EFFECTS.EMIT_RUNTIME_STATUS, payload: { transport: "legacy", status: "failed" } },
  ]);
  assert.deepEqual(statuses, [{ transport: "legacy", status: "failed" }]);
});

test("Unknown effect type is ignored", async () => {
  const { mgr } = makeManager();
  await mgr.apply([{ type: "MYSTERY_EFFECT" }]);
});

// ============================================================================
// Mutex invariant under every reducer-emitted side-effect sequence
// ============================================================================
test("Every transition-table case runs through the manager without violating mutex", async () => {
  // We start the manager in the same observable owner state implied by the
  // pre-condition state in each fixture case.
  for (const c of ALL_CASES) {
    const { mgr, sidecar, native } = makeManager();
    seedManager(sidecar, native, c.state);

    const result =
      c.event.type === EVENTS.INIT
        ? computeInitial({ prefs: c.prefs, files: c.files })
        : applyEvent({ state: c.state, prefs: c.prefs, files: c.files }, c.event);

    // Illegal transitions emit no side effects, so nothing to apply.
    if (!result.sideEffects || result.sideEffects.length === 0) continue;

    try {
      await mgr.apply(result.sideEffects);
    } catch (err) {
      if (err instanceof InvariantError) {
        assert.fail(`mutex violation while replaying "${c.name}": ${err.message}`);
      }
      throw err;
    }

    const snap = mgr.snapshot();
    assert.equal(
      snap.sidecarRunning && snap.nativePolling,
      false,
      `after ${c.name}: both running and polling`,
    );
  }
});

function seedManager(sidecar, native, state) {
  switch (state) {
    case STATES.LEGACY_ACTIVE:
    case STATES.SWITCHING_TO_LEGACY:
      sidecar.running = true;
      break;
    case STATES.NATIVE_ACTIVE:
    case STATES.TESTING_NATIVE:
      native.polling = true;
      break;
    default:
      // IDLE / NEEDS_SETUP — both off.
      break;
  }
}
