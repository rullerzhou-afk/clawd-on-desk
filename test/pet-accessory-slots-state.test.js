"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createPetAccessorySlotsCandidate,
  commitPetAccessorySlotsCandidate,
  finalizePetAccessorySlotsDelivery,
  getPetAccessorySlotsSnapshot,
  preparePetAccessorySlotsDelivery,
  resetPetAccessoryStateForTests,
} = require("../src/pet-accessory-state");

const NONE = { id: "none", assetFile: null, aspect: 1, widthScale: 1, offsetY: 0 };
const HAT = { id: "cowboy-hat", assetFile: "cowboy-hat.svg", aspect: 2, widthScale: 1, offsetY: 0 };
const CIGARETTE = { id: "cigarette", assetFile: "cigarette.svg", aspect: 0.5, widthScale: 1, offsetY: 0 };

test.afterEach(resetPetAccessoryStateForTests);

test("mints one immutable generation for the complete head+mouth candidate and commits that object", () => {
  const theme = { _id: "clawd" };
  const candidate = createPetAccessorySlotsCandidate({ head: HAT, mouth: CIGARETTE }, theme);

  assert.ok(Object.isFrozen(candidate));
  assert.ok(Object.isFrozen(candidate.payloads));
  assert.strictEqual(candidate.themeId, "clawd");
  assert.strictEqual(candidate.accessoryGeneration, 1);
  assert.strictEqual(commitPetAccessorySlotsCandidate(candidate), candidate);
  assert.strictEqual(getPetAccessorySlotsSnapshot(theme), candidate);
});

test("a delivery failure may leave a monotonic generation hole without changing canonical state", () => {
  const theme = { _id: "clawd" };
  const undelivered = createPetAccessorySlotsCandidate({ head: HAT, mouth: NONE }, theme);
  const delivered = createPetAccessorySlotsCandidate({ head: NONE, mouth: CIGARETTE }, theme);

  assert.strictEqual(undelivered.accessoryGeneration, 1);
  assert.strictEqual(delivered.accessoryGeneration, 2);
  assert.strictEqual(getPetAccessorySlotsSnapshot(theme), null);
  commitPetAccessorySlotsCandidate(delivered);
  assert.strictEqual(getPetAccessorySlotsSnapshot(theme), delivered);
});

test("rejects commits that were not minted by the canonical candidate builder", () => {
  assert.throws(
    () => commitPetAccessorySlotsCandidate({
      themeId: "clawd",
      payloads: { head: NONE, mouth: NONE },
      accessoryGeneration: 99,
    }),
    /issued candidate/
  );
});

test("first delivery commits exactly the snapshot renderer received and reload reuses it", () => {
  const theme = { _id: "clawd" };
  const first = preparePetAccessorySlotsDelivery({ head: HAT, mouth: CIGARETTE }, theme);

  assert.strictEqual(first.needsCommit, true);
  assert.strictEqual(getPetAccessorySlotsSnapshot(theme), null);
  const delivered = first.snapshot;
  assert.strictEqual(finalizePetAccessorySlotsDelivery(first, true), delivered);
  assert.strictEqual(getPetAccessorySlotsSnapshot(theme), delivered);

  const reload = preparePetAccessorySlotsDelivery({ head: HAT, mouth: CIGARETTE }, theme);
  assert.strictEqual(reload.needsCommit, false);
  assert.strictEqual(reload.snapshot, delivered);
  assert.strictEqual(finalizePetAccessorySlotsDelivery(reload, true), delivered);
  assert.strictEqual(getPetAccessorySlotsSnapshot(theme), delivered);
});

test("failed config delivery does not commit startup or hot-switch candidates", () => {
  const clawd = { _id: "clawd" };
  const cloudling = { _id: "cloudling" };
  const startup = preparePetAccessorySlotsDelivery({ head: HAT, mouth: CIGARETTE }, clawd);

  assert.strictEqual(finalizePetAccessorySlotsDelivery(startup, false), false);
  assert.strictEqual(getPetAccessorySlotsSnapshot(clawd), null);

  const retry = preparePetAccessorySlotsDelivery({ head: HAT, mouth: CIGARETTE }, clawd);
  finalizePetAccessorySlotsDelivery(retry, true);
  const committedClawd = getPetAccessorySlotsSnapshot(clawd);

  const hotSwitch = preparePetAccessorySlotsDelivery({ head: NONE, mouth: NONE }, cloudling);
  assert.ok(hotSwitch.snapshot.accessoryGeneration > committedClawd.accessoryGeneration);
  assert.strictEqual(finalizePetAccessorySlotsDelivery(hotSwitch, false), false);
  assert.strictEqual(getPetAccessorySlotsSnapshot(clawd), committedClawd);
  assert.strictEqual(getPetAccessorySlotsSnapshot(cloudling), null);

  assert.strictEqual(finalizePetAccessorySlotsDelivery(hotSwitch, true), hotSwitch.snapshot);
  assert.strictEqual(getPetAccessorySlotsSnapshot(cloudling), hotSwitch.snapshot);
});
