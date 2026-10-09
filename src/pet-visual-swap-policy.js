(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.petVisualSwapPolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SWAP_LOAD_FALLBACK_MS = 3000;
  const ACCESSORY_SETTLE_TIMEOUT_MS = 3000;
  const SWAP_VISIBILITY_RESCUE_BUFFER_MS = 750;
  const VISUAL_SETTLEMENT_DEADLINE_MS = (
    2 * SWAP_LOAD_FALLBACK_MS
    + ACCESSORY_SETTLE_TIMEOUT_MS
    + SWAP_VISIBILITY_RESCUE_BUFFER_MS
  );

  return Object.freeze({
    SWAP_LOAD_FALLBACK_MS,
    ACCESSORY_SETTLE_TIMEOUT_MS,
    SWAP_VISIBILITY_RESCUE_BUFFER_MS,
    VISUAL_SETTLEMENT_DEADLINE_MS,
  });
});
