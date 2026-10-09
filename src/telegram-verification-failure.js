"use strict";

const { ERROR_CLASSES } = require("./telegram-native-client");

const VERIFICATION_FAILURE_OUTCOMES = Object.freeze({
  FAILED: "failed",
  TIMEOUT: "timeout",
  NATIVE_START_FAILED: "native-start-failed",
});

const ALLOWED_VERIFICATION_FAILURE_OUTCOMES = new Set(
  Object.values(VERIFICATION_FAILURE_OUTCOMES),
);

const ALLOWED_TEST_ERROR_CLASSES = new Set([
  ...Object.values(ERROR_CLASSES),
  "no_chat",
  "native-start-failed",
  "apply-failed",
]);

function sanitizeErrorClass(value, fallback = ERROR_CLASSES.UNKNOWN) {
  const candidate = typeof value === "string" ? value.trim() : "";
  const safeFallback = ALLOWED_TEST_ERROR_CLASSES.has(fallback)
    ? fallback
    : ERROR_CLASSES.UNKNOWN;
  return ALLOWED_TEST_ERROR_CLASSES.has(candidate) ? candidate : safeFallback;
}

function normalizeTelegramVerificationFailure(lastTestResult) {
  if (!lastTestResult || typeof lastTestResult !== "object") return null;
  const outcome = typeof lastTestResult.outcome === "string"
    ? lastTestResult.outcome.trim()
    : "";
  if (!ALLOWED_VERIFICATION_FAILURE_OUTCOMES.has(outcome)) return null;

  return {
    outcome,
    errorCode: outcome === VERIFICATION_FAILURE_OUTCOMES.TIMEOUT
      ? ERROR_CLASSES.TIMEOUT
      : sanitizeErrorClass(lastTestResult.errorClass),
  };
}

module.exports = {
  VERIFICATION_FAILURE_OUTCOMES,
  ALLOWED_VERIFICATION_FAILURE_OUTCOMES,
  ALLOWED_TEST_ERROR_CLASSES,
  sanitizeErrorClass,
  normalizeTelegramVerificationFailure,
};
