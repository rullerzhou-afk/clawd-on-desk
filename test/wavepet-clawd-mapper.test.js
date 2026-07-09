"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { mapWavePetToClawd } = require("../src/wavepet/clawd-mapper");

function wave(state, extra = {}) {
  return {
    state,
    intensity: 0.8,
    confidence: 0.9,
    presentation: { min_visible_ms: 12000 },
    smoothing: { remaining_hold_ms: 10000 },
    ...extra,
  };
}

test("maps reading to thinking visual", () => {
  const out = mapWavePetToClawd(wave("reading_understanding"));
  assert.equal(out.state, "thinking");
  assert.equal(out.displayHint, "clawd-working-thinking.svg");
});

test("maps deep output to active ultrathink visual", () => {
  const out = mapWavePetToClawd(wave("deep_output"));
  assert.equal(out.state, "working");
  assert.equal(out.displayHint, "clawd-working-ultrathink.svg");
});

test("maps overheat to debugger unless hard failure requested", () => {
  assert.deepEqual(mapWavePetToClawd(wave("overheat_debugging"), { hardFailure: false }).state, "working");
  assert.equal(mapWavePetToClawd(wave("overheat_debugging"), { hardFailure: false }).displayHint, "clawd-working-debugger.svg");
  assert.equal(mapWavePetToClawd(wave("overheat_debugging"), { hardFailure: true }).state, "error");
});

test("maps completed closing to attention and active closing to thinking", () => {
  assert.equal(mapWavePetToClawd(wave("closing"), { completed: true }).state, "attention");
  assert.equal(mapWavePetToClawd(wave("closing"), { completed: false }).state, "thinking");
});
