"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const initLedges = require("../src/ledges");
const { getFootRestInset } = require("../src/visible-margins");

const PET = { width: 120, height: 120 };

function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  return proc;
}

function makeCtx(overrides = {}) {
  const bounds = { x: 400, y: 699, width: PET.width, height: PET.height };
  const appliedBounds = [];
  const spawns = [];
  const procs = [];
  const ctx = {
    // start() gates on darwin; tests pin the platform so they pass on the
    // Windows-first upstream dev environment too.
    isMacPlatform: true,
    spawn(bin, args, opts) {
      spawns.push({ bin, args, opts });
      const proc = makeFakeProc();
      procs.push(proc);
      return proc;
    },
    // Any real file works for the existsSync gate.
    getSidecarPath: () => __filename,
    getPetWindowBounds() { return { ...bounds }; },
    applyPetWindowBounds(next) {
      appliedBounds.push({ ...next });
      bounds.x = next.x;
      bounds.y = next.y;
      bounds.width = next.width;
      bounds.height = next.height;
    },
    getEffectiveCurrentPixelSize: () => ({ ...PET }),
    isDragLocked: () => false,
    getMiniMode: () => false,
    syncHitWin() {},
    repositionAnchoredSurfaces() {},
    _bounds: bounds,
    _appliedBounds: appliedBounds,
    _spawns: spawns,
    _procs: procs,
  };
  Object.assign(ctx, overrides);
  return ctx;
}

function feed(proc, payload) {
  proc.stdout.emit("data", Buffer.from(`${JSON.stringify(payload)}\n`));
}

function makeFakeGravity() {
  const calls = [];
  return { calls, startFreeFall() { calls.push("startFreeFall"); return true; } };
}

describe("ledges module", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  });

  afterEach(() => {
    mock.timers.reset();
    mock.reset();
  });

  it("parses sidecar JSON lines (including split chunks) into a fresh ledge list", () => {
    const ctx = makeCtx();
    const ledges = initLedges(ctx);
    ledges.start();
    assert.strictEqual(ctx._spawns.length, 1);
    const proc = ctx._procs[0];

    const line = `${JSON.stringify({ ledges: [{ id: 1, pid: 2, x: 300, x2: 900, y: 800 }], t: 0 })}\n`;
    proc.stdout.emit("data", Buffer.from(line.slice(0, 10)));
    assert.deepStrictEqual(ledges.getLedges(), [], "partial line is not parsed yet");
    proc.stdout.emit("data", Buffer.from(line.slice(10)));
    assert.strictEqual(ledges.getLedges().length, 1);
    assert.strictEqual(ledges.getLedges()[0].id, 1);
  });

  it("treats a silent sidecar as having no data after STALE_MS", () => {
    const ctx = makeCtx();
    const ledges = initLedges(ctx);
    ledges.start();
    feed(ctx._procs[0], { ledges: [{ id: 1, pid: 2, x: 300, x2: 900, y: 800 }], t: 0 });
    assert.strictEqual(ledges.getLedges().length, 1);
    mock.timers.tick(6001);
    assert.deepStrictEqual(ledges.getLedges(), []);
  });

  it("does not spawn on non-darwin platforms", () => {
    const ctx = makeCtx({ isMacPlatform: false });
    const ledges = initLedges(ctx);
    ledges.start();
    assert.strictEqual(ctx._spawns.length, 0);
  });

  it("rides small moves of the supporting window", () => {
    const ctx = makeCtx();
    const ledges = initLedges(ctx);
    ledges.start();
    const ledge = { id: 1, pid: 2, x: 300, x2: 900, y: 800 };
    feed(ctx._procs[0], { ledges: [ledge], t: 0 });
    ledges.setStanding(ledge);

    // Feet start exactly on y=800; the window slides down 10px.
    assert.strictEqual(
      ctx._bounds.y + ctx._bounds.height - getFootRestInset(ctx._bounds.height),
      800
    );
    feed(ctx._procs[0], { ledges: [{ ...ledge, y: 810 }], t: 1 });
    mock.timers.tick(250);
    assert.strictEqual(ctx._bounds.y, 709, "pet followed the window down");
    assert.ok(ledges.getStanding(), "still perched");
  });

  it("drops the pet when the supporting window vanishes", () => {
    const gravity = makeFakeGravity();
    const ctx = makeCtx();
    const ledges = initLedges(ctx);
    ledges.bindGravity(gravity);
    ledges.start();
    const ledge = { id: 1, pid: 2, x: 300, x2: 900, y: 800 };
    feed(ctx._procs[0], { ledges: [ledge], t: 0 });
    ledges.setStanding(ledge);

    feed(ctx._procs[0], { ledges: [], t: 1 });
    mock.timers.tick(250);
    assert.strictEqual(ledges.getStanding(), null);
    assert.deepStrictEqual(gravity.calls, ["startFreeFall"]);
  });

  it("drops instead of teleporting when the window jumps beyond one ride step", () => {
    const gravity = makeFakeGravity();
    const ctx = makeCtx();
    const ledges = initLedges(ctx);
    ledges.bindGravity(gravity);
    ledges.start();
    const ledge = { id: 1, pid: 2, x: 300, x2: 900, y: 800 };
    feed(ctx._procs[0], { ledges: [ledge], t: 0 });
    ledges.setStanding(ledge);

    feed(ctx._procs[0], { ledges: [{ ...ledge, y: 950 }], t: 1 });
    mock.timers.tick(250);
    assert.strictEqual(ledges.getStanding(), null);
    assert.deepStrictEqual(gravity.calls, ["startFreeFall"]);
    assert.strictEqual(ctx._appliedBounds.length, 0, "no teleport write");
  });

  it("restarts a crashed sidecar with backoff, but not after stop()", () => {
    const ctx = makeCtx();
    const ledges = initLedges(ctx);
    ledges.start();
    assert.strictEqual(ctx._spawns.length, 1);

    ctx._procs[0].emit("exit");
    mock.timers.tick(2000);
    assert.strictEqual(ctx._spawns.length, 2, "respawned after backoff");

    ledges.stop();
    assert.strictEqual(ctx._procs[1].killed, true);
    ctx._procs[1].emit("exit");
    mock.timers.tick(60000);
    assert.strictEqual(ctx._spawns.length, 2, "no respawn after stop()");
  });
});
