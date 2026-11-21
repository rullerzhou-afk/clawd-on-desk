"use strict";

(function exposeQuotaBalance(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ClawdQuotaBalance = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildQuotaBalance() {
  // Money is optional in the generic bucket normalizer. Persisted or older
  // buckets must satisfy this shared rule before any surface formats them.
  function isDrawableBalanceBucket(bucket) {
    return !!bucket
      && Number.isFinite(bucket.amount)
      && bucket.amount >= 0
      && Number.isFinite(bucket.baseline)
      && bucket.baseline >= 0
      && (bucket.currency === "CNY" || bucket.currency === "USD");
  }

  return { isDrawableBalanceBucket };
});
