"use strict";

const TEST_REACTION_RESULTS = new Set(["pass", "fail"]);

function normalizeTestResult(value) {
  return TEST_REACTION_RESULTS.has(value) ? value : null;
}

// Test reactions are decorative overlays, not state transitions. Keep their
// eligibility in one main-process gate so hook traffic cannot bypass the
// user's opt-in or the pet's current visibility/interaction policy.
function canPlayTestReaction(options = {}) {
  return options.enabled === true
    && options.doNotDisturb !== true
    && options.petHidden !== true
    && options.miniMode !== true
    && options.miniTransitioning !== true
    && options.dragging !== true
    && options.headless !== true
    && options.hasPetWindow === true;
}

function createTestReactionHandler(options = {}) {
  const getEnabled = options.getEnabled || (() => false);
  const getDoNotDisturb = options.getDoNotDisturb || (() => false);
  const isPetHidden = options.isPetHidden || (() => false);
  const getMiniMode = options.getMiniMode || (() => false);
  const getMiniTransitioning = options.getMiniTransitioning || (() => false);
  const isDragging = options.isDragging || (() => false);
  const hasPetWindow = options.hasPetWindow || (() => false);
  const sendToRenderer = options.sendToRenderer || (() => {});

  return function handleTestResult(result, context = {}) {
    const normalized = normalizeTestResult(result);
    if (!normalized) return false;
    if (!canPlayTestReaction({
      enabled: getEnabled(),
      doNotDisturb: getDoNotDisturb(),
      petHidden: isPetHidden(),
      miniMode: getMiniMode(),
      miniTransitioning: getMiniTransitioning(),
      dragging: isDragging(),
      headless: context.headless === true,
      hasPetWindow: hasPetWindow(),
    })) return false;

    sendToRenderer("play-test-reaction", normalized);
    return true;
  };
}

module.exports = {
  normalizeTestResult,
  canPlayTestReaction,
  createTestReactionHandler,
};
