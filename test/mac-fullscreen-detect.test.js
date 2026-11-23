"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createMacFullscreenProbe } = require("../src/mac-fullscreen-detect");

function createHarness() {
  const state = { active: 528, type: 4, loads: 0, callError: null };
  const calls = [];
  const probe = createMacFullscreenProbe({
    isMac: true,
    loadSkyLight: () => {
      state.loads++;
      return {
        SLSMainConnectionID: () => 17,
        SLSGetActiveSpace: (cid) => {
          assert.equal(cid, 17);
          if (state.callError) throw state.callError;
          return state.active;
        },
        SLSSpaceGetType: (cid, active) => {
          calls.push([cid, active]);
          return state.type;
        },
      };
    },
    onCallError: (err) => calls.push(err),
  });
  return { state, calls, probe };
}

const unknown = { reliable: false, foregroundId: null, fullscreenId: null };

describe("mac-fullscreen-detect", () => {
  it("#1275: loads on first call and reports type 4 with a Space identity and observation", () => {
    const { state, calls, probe } = createHarness();
    assert.equal(state.loads, 0);
    assert.deepEqual(probe.getLastObservation(), unknown);
    assert.equal(probe(), "mac-space:528");
    assert.deepEqual(probe.getLastObservation(), {
      reliable: true, foregroundId: "mac-space:528", fullscreenId: "mac-space:528",
    });
    const observation = probe.getLastObservation();
    observation.reliable = false;
    assert.equal(probe.getLastObservation().reliable, true);
    state.active = 533n;
    assert.equal(probe(), "mac-space:533");
    assert.equal(state.loads, 1);
    assert.deepEqual(calls, [[17, 528], [17, 533n]]);
    assert.equal(probe.isWindowIdAlive("mac-space:528"), null);
  });

  it("#1275: type 0 and other non-fullscreen Space types return false with reliable identity", () => {
    const { state, probe } = createHarness();
    for (const type of [0, 2, 3]) {
      state.type = type;
      assert.equal(probe(), false);
      assert.deepEqual(probe.getLastObservation(), {
        reliable: true, foregroundId: "mac-space:528", fullscreenId: null,
      });
    }
  });

  it("#1275: active Space zero is unknown and does not query its type", () => {
    const { state, calls, probe } = createHarness();
    probe();
    calls.length = 0;
    for (const active of [0, 0n]) {
      state.active = active;
      assert.equal(probe(), false);
      assert.deepEqual(probe.getLastObservation(), unknown);
    }
    assert.deepEqual(calls, []);
  });

  it("#1275: a native call error clears the observation and reaches onCallError", () => {
    const { state, calls, probe } = createHarness();
    probe();
    const error = new Error("native call failed");
    state.callError = error;
    assert.equal(probe(), false);
    assert.deepEqual(probe.getLastObservation(), unknown);
    assert.equal(calls.at(-1), error);
    state.callError = null;
    assert.equal(probe(), "mac-space:528");
    assert.equal(state.loads, 1);
  });

  it("#1275: a load failure is reported once and never retried", () => {
    const error = new Error("SkyLight unavailable");
    let loads = 0;
    const errors = [];
    const probe = createMacFullscreenProbe({
      isMac: true,
      loadSkyLight: () => { loads++; throw error; },
      onError: (err) => errors.push(err),
      onCallError: () => assert.fail("load failures use onError"),
    });
    assert.equal(loads, 0);
    assert.equal(probe(), false);
    assert.equal(probe(), false);
    assert.equal(loads, 1);
    assert.deepEqual(errors, [error]);
    assert.deepEqual(probe.getLastObservation(), unknown);
  });

  it("#1275: non-Mac probes never load native code", () => {
    const probe = createMacFullscreenProbe({
      isMac: false,
      loadSkyLight: () => assert.fail("must not load"),
    });
    assert.equal(probe(), false);
    assert.deepEqual(probe.getLastObservation(), unknown);
    assert.equal(probe.isWindowIdAlive("anything"), null);
  });
});
