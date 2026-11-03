"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { describeLongFreeze, waitForPromotionAndClose } = require("../scripts/manual/mobile-freeze-e2e");

test("freeze classification uses the page's post-thaw 1006", () => {
  const closes = [{ code: 1000, at: 50 }, { code: 1006, at: 200 }];
  assert.match(describeLongFreeze(false, closes, 100), /disconnect recovery/);
  assert.match(describeLongFreeze(true, closes, 100), /not #663/);
});

test("default Chrome case fails without an observed post-thaw disconnect", () => {
  for (const closes of [[], [{ code: 1006, at: 50 }], [{ code: 1000, at: 200 }]]) {
    assert.throws(() => describeLongFreeze(false, closes, 100), /must expose a thaw disconnect/);
  }
  assert.equal(describeLongFreeze(true, [], 100), "preserved socket");
});


test("frozen X close is checked only after the same device's server generation is promoted", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let currentGen = 2;
  const closeChecks = [];
  const desktop = { state: () => ({ devices: [
    { id: "other", currentGen: 99 }, { id: "device", currentGen },
  ] }) };
  const record = { get sentCode() { closeChecks.push(currentGen); return 4002; } };
  const waiting = waitForPromotionAndClose(desktop, "device", 3, record);
  async function flush() { for (let n = 0; n < 5; n++) await Promise.resolve(); }
  await flush();
  t.mock.timers.tick(100);
  await flush();
  assert.deepEqual(closeChecks, []);
  currentGen = 3;
  t.mock.timers.tick(100);
  await waiting;
  assert.deepEqual(closeChecks, [3]);
});
