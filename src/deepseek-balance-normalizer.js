"use strict";

const DEEPSEEK_QUOTA_FIELDS = Object.freeze(["deepseekBalance"]);

function normalizeDeepseekBalanceResponse(value) {
  if (!value || typeof value.is_available !== "boolean" || !Array.isArray(value.balance_infos)) {
    throw new TypeError("Invalid DeepSeek balance response");
  }
  const entries = value.balance_infos.filter((entry) => entry
    && ["CNY", "USD"].includes(entry.currency)
    && typeof entry.total_balance === "string"
    && /^\d+(?:\.\d+)?$/.test(entry.total_balance)
    && Number.isFinite(Number(entry.total_balance)));
  const selected = entries.find((entry) => entry.currency === "CNY") || entries[0];
  if (!selected) throw new TypeError("Invalid DeepSeek balance response");
  return { amount: Number(Number(selected.total_balance).toFixed(2)), currency: selected.currency };
}

function buildBalanceQuota(balance, previous, credentialId, capturedAt) {
  const { amount, currency } = balance;
  const sameAccount = previous && previous.credentialId === credentialId && previous.currency === currency;
  // Compare cents rather than binary fractions: 60.01 - 60 can be slightly
  // below 0.01 even though it is exactly one cent of new prepaid credit.
  const toppedUp = sameAccount && Math.round(amount * 100) - Math.round(previous.lastAmount * 100) >= 1;
  const baseline = sameAccount && !toppedUp ? previous.baseline : amount;
  const usedPercent = amount <= 0 || baseline <= 0
    ? 100
    : Math.max(0, Math.min(100, Math.round((1 - amount / baseline) * 100)));
  return {
    quota: { deepseekBalance: { amount, baseline, currency, usedPercent, capturedAt } },
    record: { version: 1, credentialId, currency, baseline, lastAmount: amount, capturedAt },
  };
}

module.exports = { DEEPSEEK_QUOTA_FIELDS, normalizeDeepseekBalanceResponse, buildBalanceQuota };
