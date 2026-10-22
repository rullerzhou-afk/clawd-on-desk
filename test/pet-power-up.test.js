"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolvePowerUp, selectPowerUpSession, appearance, normalizeEffort } = require("../src/pet-power-up");
const session = (patch = {}) => ({ id: "one", state: "thinking", model: "claude-opus-4-6", updatedAt: 10, ...patch });

test("power-up is opt-in and clears when no visible agent is working", () => {
  const snapshot = { sessions: [session({ effort: "max" })] };
  assert.deepEqual(resolvePowerUp(snapshot, false), { family: null, tier: 0 });
  assert.deepEqual(resolvePowerUp(snapshot, true, "notification"), { family: null, tier: 0 });
  for (const patch of [{ state: "idle" }, { state: "notification" }, { state: "sleeping" }, { headless: true }, { hiddenFromHud: true }]) {
    assert.deepEqual(resolvePowerUp({ sessions: [session(patch)] }, true), { family: null, tier: 0 });
  }
});

test("a change in effort is included in the shared UI snapshot signature", () => {
  const { buildSessionSnapshot, sessionSnapshotSignature } = require("../src/state-session-snapshot");
  const sessions = new Map([["one", session({ effort: "low" })]]);
  const first = buildSessionSnapshot(sessions);
  sessions.get("one").effort = "high";
  const second = buildSessionSnapshot(sessions);
  assert.equal(second.sessions[0].effort, "high");
  assert.notEqual(sessionSnapshotSignature(first), sessionSnapshotSignature(second));
});

test("model color and reported effort are independent, with no invented effort", () => {
  assert.deepEqual(resolvePowerUp({ sessions: [session()] }, true), { family: "opus", tier: 0 });
  for (const [effort, tier] of [["low", 1], ["medium", 2], ["high", 3], ["xhigh", 4], ["max", 4], ["ultra", 4], ["unknown", 0]]) {
    assert.equal(resolvePowerUp({ sessions: [session({ effort })] }, true).tier, tier);
  }
  assert.deepEqual(resolvePowerUp({ sessions: [session({ model: "gpt-6.1-sol", effort: "high" })] }, true), { family: "gpt", tier: 3 });
  assert.deepEqual(resolvePowerUp({ sessions: [session({ model: "custom", effort: "high" })] }, true), { family: null, tier: 3 });
});

test("parallel sessions select the latest active session deterministically", () => {
  const sessions = [session({ id: "z", model: "claude-sonnet-4-6" }), session({ id: "a", effort: "high" })];
  assert.deepEqual(resolvePowerUp({ sessions }, true), resolvePowerUp({ sessions: sessions.slice().reverse() }, true));
  assert.equal(resolvePowerUp({ sessions: [session(), session({ updatedAt: 20, model: "claude-haiku-4-5" })] }, true).family, "haiku");
});

test("preferred active session keeps its model during parallel updates", () => {
  const sessions = [session({ id: "claude", updatedAt: 10 }), session({ id: "codex", model: "gpt-6.1-sol", updatedAt: 20 })];
  assert.equal(selectPowerUpSession({ sessions }, "thinking", "claude").id, "claude");
  assert.equal(resolvePowerUp({ sessions }, true, "thinking", "claude").family, "opus");
  assert.equal(selectPowerUpSession({ sessions: [sessions[1]] }, "thinking", "claude").id, "codex");
});

test("untrusted telemetry cannot inject CSS or animation tiers", () => {
  assert.equal(normalizeEffort({ toString: () => "max" }), null);
  assert.deepEqual(appearance({ family: "url(https://example.com)", tier: 999 }), { family: null, tier: 0, color: "#ffd66b", tint: "" });
  assert.equal(appearance({ family: "__proto__", tier: -1 }).tier, 0);
});
