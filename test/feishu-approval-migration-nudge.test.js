"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  LEGACY_PROVENANCE_SIGNATURE,
  decideFeishuApprovalMigrationNudge,
  createFeishuApprovalMigrationNudge,
} = require("../src/feishu-approval-migration-nudge");

function decisionFor(reason, previous = "") {
  return decideFeishuApprovalMigrationNudge(
    { enabled: true },
    {},
    previous,
    { readiness: () => ({ ready: false, reason }) },
  );
}

test("legacy credential and approver provenance share one upgrade signature", () => {
  for (const reason of ["credential-provenance-unknown", "approver-provenance-unknown"]) {
    const decision = decisionFor(reason);
    assert.strictEqual(decision.shouldNotify, true);
    assert.strictEqual(decision.nextSignature, LEGACY_PROVENANCE_SIGNATURE);
  }
  assert.strictEqual(
    decisionFor("approver-provenance-unknown", LEGACY_PROVENANCE_SIGNATURE).shouldNotify,
    false,
  );
});

test("disabled or repaired approval clears the persisted migration signature", () => {
  const disabled = decideFeishuApprovalMigrationNudge(
    { enabled: false },
    {},
    LEGACY_PROVENANCE_SIGNATURE,
    { readiness: () => ({ ready: false, reason: "disabled" }) },
  );
  const repaired = decideFeishuApprovalMigrationNudge(
    { enabled: true },
    {},
    LEGACY_PROVENANCE_SIGNATURE,
    { readiness: () => ({ ready: true }) },
  );
  assert.deepStrictEqual(
    [disabled.shouldPersist, disabled.nextSignature, repaired.shouldPersist, repaired.nextSignature],
    [true, "", true, ""],
  );
});

test("unrelated setup failures do not create an upgrade nudge", () => {
  const decision = decisionFor("missing-credentials");
  assert.strictEqual(decision.shouldNotify, false);
  assert.strictEqual(decision.shouldPersist, false);
});

test("startup nudge persists only after delivery and opens Settings", async () => {
  let signature = "";
  let opened = 0;
  const runtime = createFeishuApprovalMigrationNudge({
    getConfig: () => ({ enabled: true }),
    getSecrets: () => ({}),
    getLastSignature: () => signature,
    setLastSignature: async (value) => { signature = value; },
    readiness: () => ({ ready: false, reason: "credential-provenance-unknown" }),
    showNotification: ({ onClick }) => {
      onClick();
      return true;
    },
    openSettings: () => { opened += 1; },
  });

  assert.strictEqual((await runtime.sync({ allowNotify: true })).notified, true);
  assert.strictEqual(signature, LEGACY_PROVENANCE_SIGNATURE);
  assert.strictEqual((await runtime.sync({ allowNotify: true })).notified, false);
  assert.strictEqual(opened, 1);
});
