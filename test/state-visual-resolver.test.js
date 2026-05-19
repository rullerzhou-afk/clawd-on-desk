"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  buildStateBindings,
  pickStateFile,
  hasOwnVisualFiles,
  resolveVisualBinding,
  countActiveSessionsByStates,
  selectTieredStateFile,
  getWinningSessionDisplayHint,
  getSvgOverride,
} = require("../src/state-visual-resolver");

function session(state, overrides = {}) {
  return { state, updatedAt: 1000, headless: false, ...overrides };
}

describe("state-visual-resolver bindings", () => {
  it("builds bindings from state bindings, theme states, and mini mode states", () => {
    const bindings = buildStateBindings({
      _stateBindings: {
        error: { files: [], fallbackTo: "attention" },
        working: { files: ["from-binding.svg"], fallbackTo: "idle" },
      },
      states: {
        idle: ["idle.svg"],
        error: ["error.svg"],
        working: ["from-theme.svg"],
      },
      miniMode: {
        states: {
          "mini-working": ["mini-working.svg"],
          idle: ["mini-idle.svg"],
        },
      },
    });

    assert.deepStrictEqual(bindings.error, { files: ["error.svg"], fallbackTo: "attention" });
    assert.deepStrictEqual(bindings.working, { files: ["from-binding.svg"], fallbackTo: "idle" });
    assert.deepStrictEqual(bindings.idle, { files: ["mini-idle.svg"], fallbackTo: null });
    assert.deepStrictEqual(bindings["mini-working"], { files: ["mini-working.svg"], fallbackTo: null });
  });

  it("resolves direct files, fallback chains, cycles, and idle fallback", () => {
    const bindings = {
      idle: { files: ["idle.svg"], fallbackTo: null },
      error: { files: [], fallbackTo: "attention" },
      attention: { files: ["attention.svg"], fallbackTo: null },
      sweeping: { files: [], fallbackTo: "error" },
      working: { files: [], fallbackTo: "thinking" },
      thinking: { files: [], fallbackTo: "working" },
    };

    assert.strictEqual(resolveVisualBinding("attention", bindings), "attention.svg");
    assert.strictEqual(resolveVisualBinding("error", bindings), "attention.svg");
    assert.strictEqual(resolveVisualBinding("sweeping", bindings), "attention.svg");
    assert.strictEqual(resolveVisualBinding("working", bindings), "idle.svg");
  });

  it("keeps pickStateFile random selection injectable", () => {
    assert.strictEqual(pickStateFile(["a.svg", "b.svg"], () => 0.75), "b.svg");
    assert.strictEqual(pickStateFile([], () => 0.75), null);
    assert.strictEqual(hasOwnVisualFiles({ working: { files: ["a.svg"] } }, "working"), true);
    assert.strictEqual(hasOwnVisualFiles({ working: { files: [] } }, "working"), false);
  });
});

describe("state-visual-resolver SVG overrides", () => {
  it("counts active working sessions and selects tiered files", () => {
    const sessions = new Map([
      ["a", session("working")],
      ["b", session("thinking")],
      ["c", session("juggling")],
      ["d", session("working", { headless: true })],
    ]);

    assert.strictEqual(countActiveSessionsByStates(sessions, new Set(["working", "thinking", "juggling"])), 4);
    assert.strictEqual(selectTieredStateFile([
      { minSessions: 4, file: "four.svg" },
      { minSessions: 3, file: "three.svg" },
      { minSessions: 2, file: "two.svg" },
    ], 4, "one.svg"), "four.svg");
  });

  it("uses the most recently updated display hint and ignores headless sessions", () => {
    const sessions = new Map([
      ["old", session("working", { updatedAt: 1000, displayHint: "build" })],
      ["headless", session("working", { updatedAt: 3000, displayHint: "secret", headless: true })],
      ["new", session("working", { updatedAt: 2000, displayHint: "read" })],
    ]);

    assert.strictEqual(getWinningSessionDisplayHint(sessions, "working", {
      build: "building.svg",
      read: "reading.svg",
      secret: "secret.svg",
    }), "reading.svg");
  });

  it("resolves update, idle, working, juggling, thinking, and null overrides", () => {
    const sessions = new Map([
      ["w1", session("working", { updatedAt: 1000 })],
      ["w2", session("thinking", { updatedAt: 2000 })],
      ["j1", session("juggling", { updatedAt: 3000, displayHint: "conduct" })],
    ]);
    const options = {
      updateVisualState: "thinking",
      updateVisualSvgOverride: "update-thinking.svg",
      idleFollowSvg: "idle-follow.svg",
      sessions,
      displayHintMap: { conduct: "conducting.svg" },
      theme: {
        workingTiers: [
          { minSessions: 3, file: "working-three.svg" },
          { minSessions: 2, file: "working-two.svg" },
        ],
        jugglingTiers: [{ minSessions: 2, file: "juggling-two.svg" }],
      },
      stateSvgs: {
        working: ["working-one.svg"],
        juggling: ["juggling-one.svg"],
        thinking: ["thinking.svg"],
      },
    };

    assert.strictEqual(getSvgOverride("thinking", options), "update-thinking.svg");
    assert.strictEqual(getSvgOverride("idle", options), "idle-follow.svg");
    assert.strictEqual(getSvgOverride("working", options), "working-three.svg");
    assert.strictEqual(getSvgOverride("juggling", options), "conducting.svg");
    assert.strictEqual(getSvgOverride("error", options), null);
  });
});
