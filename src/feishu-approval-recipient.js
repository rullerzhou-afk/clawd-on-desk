"use strict";

const FEISHU_APPROVER_ID_TYPES = new Set(["open_id", "user_id", "union_id"]);

function classifyFeishuApprovalRecipient(value, idType) {
  const normalizedValue = typeof value === "string" ? value.trim() : "";
  if (!normalizedValue) return { kind: "empty", value: "" };

  if (!/\s/.test(normalizedValue)) {
    const parts = normalizedValue.split("@");
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { kind: "email", email: normalizedValue };
    }
  }

  if (!FEISHU_APPROVER_ID_TYPES.has(idType)) {
    return { kind: "invalid", code: "invalid-id-type" };
  }
  if (/[\s\p{C}]/u.test(normalizedValue)) {
    return { kind: "invalid", code: "invalid-approver-id" };
  }
  if (idType === "open_id" && !normalizedValue.startsWith("ou_")) {
    return { kind: "invalid", code: "invalid-email" };
  }
  if (idType === "open_id" && normalizedValue === "ou_") {
    return { kind: "invalid", code: "invalid-approver-id" };
  }
  return { kind: "manual", idType, approverId: normalizedValue };
}

const feishuApprovalRecipientExports = { classifyFeishuApprovalRecipient };

if (typeof module !== "undefined" && module.exports) {
  module.exports = feishuApprovalRecipientExports;
}
if (typeof globalThis !== "undefined") {
  globalThis.ClawdFeishuApprovalRecipient = feishuApprovalRecipientExports;
}
