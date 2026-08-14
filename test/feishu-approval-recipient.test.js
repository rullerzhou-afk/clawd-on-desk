"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const recipientApi = require("../src/feishu-approval-recipient");
const { classifyFeishuApprovalRecipient } = recipientApi;

describe("Feishu approval recipient classifier", () => {
  it("exports one shared recipient classifier", () => {
    assert.equal(typeof classifyFeishuApprovalRecipient, "function");
    assert.deepStrictEqual(Object.keys(recipientApi), ["classifyFeishuApprovalRecipient"]);
  });

  it("classifies email before manual ID prefixes and selected ID type", () => {
    for (const idType of ["open_id", "user_id", "union_id"]) {
      assert.deepStrictEqual(
        classifyFeishuApprovalRecipient("  ou_admin@example.com  ", idType),
        { kind: "email", email: "ou_admin@example.com" },
      );
    }
  });

  it("preserves the existing manual and invalid open_id boundaries", () => {
    assert.deepStrictEqual(
      classifyFeishuApprovalRecipient("", "open_id"),
      { kind: "empty", value: "" },
    );
    assert.deepStrictEqual(
      classifyFeishuApprovalRecipient("ou_manual", "open_id"),
      { kind: "manual", idType: "open_id", approverId: "ou_manual" },
    );
    assert.deepStrictEqual(
      classifyFeishuApprovalRecipient("manual-user", "user_id"),
      { kind: "manual", idType: "user_id", approverId: "manual-user" },
    );
    assert.deepStrictEqual(
      classifyFeishuApprovalRecipient("manual-union", "union_id"),
      { kind: "manual", idType: "union_id", approverId: "manual-union" },
    );
    assert.deepStrictEqual(
      classifyFeishuApprovalRecipient("not-an-open-id", "open_id"),
      { kind: "invalid", code: "invalid-email" },
    );
    assert.deepStrictEqual(
      classifyFeishuApprovalRecipient("value", "unsupported"),
      { kind: "invalid", code: "invalid-id-type" },
    );
  });
});
