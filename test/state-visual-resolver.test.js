"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  buildStateBindings,
  pickStateFile,
  createStableVisualPicker,
  hasOwnVisualFiles,
  resolveVisualBinding,
  countActiveSessionsByStates,
  selectTieredStateFiles,
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

  it("never samples selectable-only idle files from states.idle", () => {
    const theme = {
      states: { idle: ["idle-a.svg", "idle-b.svg"] },
      idleVisualOptions: [{ file: "pool.apng" }],
    };
    const bindings = buildStateBindings(theme);
    for (const roll of [0, 0.49, 0.99]) {
      assert.ok(["idle-a.svg", "idle-b.svg"].includes(resolveVisualBinding("idle", bindings, {
        pickStateFile: (files) => pickStateFile(files, () => roll),
      })));
    }
    assert.deepStrictEqual(bindings.idle.files, ["idle-a.svg", "idle-b.svg"]);
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

    assert.strictEqual(countActiveSessionsByStates(sessions, new Set(["working", "thinking", "juggling"])), 3);
    assert.deepStrictEqual(selectTieredStateFiles([
      { minSessions: 3, file: "three.svg" },
      { minSessions: 2, file: "two.svg" },
    ], 3, ["one.svg"]), ["three.svg"]);
  });

  it("selects a tier's files pool, preferring files over file", () => {
    const tiers = [
      { minSessions: 3, file: "three.svg", files: ["three-a.svg", "three-b.svg"] },
      { minSessions: 2, files: ["two-a.svg", "two-b.svg"] },
      { minSessions: 1, file: "one.svg" },
    ];
    assert.deepStrictEqual(selectTieredStateFiles(tiers, 4, ["base.svg"]), ["three-a.svg", "three-b.svg"]);
    assert.deepStrictEqual(selectTieredStateFiles(tiers, 2, ["base.svg"]), ["two-a.svg", "two-b.svg"]);
    assert.deepStrictEqual(selectTieredStateFiles(tiers, 1, ["base.svg"]), ["one.svg"]);
    assert.deepStrictEqual(selectTieredStateFiles(tiers, 0, ["base-a.svg", "base-b.svg"]), ["base-a.svg", "base-b.svg"]);
    assert.deepStrictEqual(selectTieredStateFiles(null, 5, ["base.svg"]), ["base.svg"]);
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

  // #509: user-selected default idle visual
  it("idle prefers idleDefaultVisual over idleFollowSvg when provided", () => {
    const base = { idleFollowSvg: "idle-follow.svg" };
    assert.strictEqual(
      getSvgOverride("idle", { ...base, idleDefaultVisual: "idle-reading.svg" }),
      "idle-reading.svg"
    );
    assert.strictEqual(getSvgOverride("idle", { ...base, idleDefaultVisual: null }), "idle-follow.svg");
    assert.strictEqual(getSvgOverride("idle", base), "idle-follow.svg");
  });

  it("update visual override still wins over idleDefaultVisual for its state", () => {
    const options = {
      updateVisualState: "idle",
      updateVisualSvgOverride: "update-idle.svg",
      idleFollowSvg: "idle-follow.svg",
      idleDefaultVisual: "idle-reading.svg",
    };
    assert.strictEqual(getSvgOverride("idle", options), "update-idle.svg");
  });
});

describe("state-visual-resolver stable picks for long-running states", () => {
  function rolls(...values) {
    let index = 0;
    return () => values[Math.min(index++, values.length - 1)];
  }

  it("keeps one pick per state while the candidate list is unchanged", () => {
    const picker = createStableVisualPicker(rolls(0.5, 0, 0.9));
    const files = ["a.svg", "b.svg", "c.svg"];
    assert.strictEqual(picker.pick("thinking", files), "b.svg");
    assert.strictEqual(picker.pick("thinking", files), "b.svg");
    assert.strictEqual(picker.pick("thinking", [...files]), "b.svg");
  });

  it("draws again when the state is re-entered", () => {
    const picker = createStableVisualPicker(rolls(0, 0.9, 0.5));
    const files = ["a.svg", "b.svg", "c.svg"];
    assert.strictEqual(picker.pick("thinking", files), "a.svg");
    assert.strictEqual(picker.pick("working", ["w1.svg", "w2.svg"]), "w2.svg");
    picker.retainOnly("working");
    assert.strictEqual(picker.pick("working", ["w1.svg", "w2.svg"]), "w2.svg");
    assert.strictEqual(picker.pick("thinking", files), "b.svg");
  });

  it("draws again when the candidate list changes, such as a tier change", () => {
    const picker = createStableVisualPicker(rolls(0, 0.9, 0));
    assert.strictEqual(picker.pick("working", ["one-a.svg", "one-b.svg"]), "one-a.svg");
    assert.strictEqual(picker.pick("working", ["two-a.svg", "two-b.svg"]), "two-b.svg");
    assert.strictEqual(picker.pick("working", ["one-a.svg", "one-b.svg"]), "one-a.svg");
  });

  it("returns single files without drawing and forgets everything on clear", () => {
    let calls = 0;
    const picker = createStableVisualPicker(() => { calls += 1; return 0.9; });
    assert.strictEqual(picker.pick("thinking", ["only.svg"]), "only.svg");
    assert.strictEqual(picker.pick("thinking", []), null);
    assert.strictEqual(calls, 0);
    assert.strictEqual(picker.pick("thinking", ["a.svg", "b.svg"]), "b.svg");
    picker.clear();
    assert.strictEqual(picker.pick("thinking", ["a.svg", "b.svg"]), "b.svg");
    assert.strictEqual(calls, 2);
  });

  it("routes thinking, working tiers, and juggling tiers through pickVisualFile", () => {
    const sessions = new Map([
      ["w1", session("working", { updatedAt: 1000 })],
      ["w2", session("thinking", { updatedAt: 2000 })],
      ["j1", session("juggling", { updatedAt: 3000 })],
    ]);
    const calls = [];
    const options = {
      sessions,
      theme: {
        workingTiers: [
          { minSessions: 3, files: ["three-a.svg", "three-b.svg"] },
          { minSessions: 1, file: "one.svg" },
        ],
        jugglingTiers: [{ minSessions: 1, files: ["juggle-a.svg", "juggle-b.svg"] }],
      },
      stateSvgs: {
        working: ["working-one.svg"],
        juggling: ["juggling-one.svg"],
        thinking: ["think-a.svg", "think-b.svg"],
      },
      pickVisualFile: (state, files) => {
        calls.push([state, files]);
        return files[files.length - 1];
      },
    };

    assert.strictEqual(getSvgOverride("thinking", options), "think-b.svg");
    assert.strictEqual(getSvgOverride("working", options), "three-b.svg");
    assert.strictEqual(getSvgOverride("juggling", options), "juggle-b.svg");
    assert.deepStrictEqual(calls, [
      ["thinking", ["think-a.svg", "think-b.svg"]],
      ["working", ["three-a.svg", "three-b.svg"]],
      ["juggling", ["juggle-a.svg", "juggle-b.svg"]],
    ]);
  });

  it("keeps the first file when no picker is supplied", () => {
    const options = {
      sessions: new Map([["w1", session("working")]]),
      theme: { workingTiers: [{ minSessions: 1, files: ["tier-a.svg", "tier-b.svg"] }] },
      stateSvgs: {
        working: ["working-a.svg", "working-b.svg"],
        juggling: ["juggling.svg"],
        thinking: ["think-a.svg", "think-b.svg"],
      },
    };
    assert.strictEqual(getSvgOverride("thinking", options), "think-a.svg");
    assert.strictEqual(getSvgOverride("working", options), "tier-a.svg");
  });

  it("still lets a display hint win over a multi-file pool", () => {
    const options = {
      sessions: new Map([["t1", session("thinking", { displayHint: "plan" })]]),
      displayHintMap: { plan: "planning.svg" },
      theme: {},
      stateSvgs: { working: ["w.svg"], juggling: ["j.svg"], thinking: ["think-a.svg", "think-b.svg"] },
      pickVisualFile: () => assert.fail("hinted states must not draw from the pool"),
    };
    assert.strictEqual(getSvgOverride("thinking", options), "planning.svg");
  });
});
