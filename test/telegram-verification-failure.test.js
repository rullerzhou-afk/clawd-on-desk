"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ALLOWED_TEST_ERROR_CLASSES,
  normalizeTelegramVerificationFailure,
  sanitizeErrorClass,
} = require("../src/telegram-verification-failure");

test("normalizes every allowlisted Telegram verification error class", () => {
  for (const errorClass of ALLOWED_TEST_ERROR_CLASSES) {
    assert.deepEqual(
      normalizeTelegramVerificationFailure({ outcome: "failed", errorClass }),
      { outcome: "failed", errorCode: errorClass },
    );
  }
});

test("timeout has a stable error code without storing a duplicate error class", () => {
  assert.deepEqual(
    normalizeTelegramVerificationFailure({ outcome: "timeout", at: 123 }),
    { outcome: "timeout", errorCode: "timeout" },
  );
});

test("native start failures retain only an allowlisted class", () => {
  assert.deepEqual(
    normalizeTelegramVerificationFailure({
      outcome: "native-start-failed",
      errorClass: "apply-failed",
      message: "token=secret raw body",
    }),
    { outcome: "native-start-failed", errorCode: "apply-failed" },
  );
});

test("malformed classes become unknown and malformed outcomes are rejected", () => {
  assert.deepEqual(
    normalizeTelegramVerificationFailure({
      outcome: "failed",
      errorClass: "token=secret raw body",
    }),
    { outcome: "failed", errorCode: "unknown" },
  );
  assert.equal(
    normalizeTelegramVerificationFailure({ outcome: "surprise", errorClass: "401" }),
    null,
  );
  assert.equal(normalizeTelegramVerificationFailure(null), null);
});

test("sanitizeErrorClass never accepts an unsafe fallback", () => {
  assert.equal(sanitizeErrorClass("", "token=secret"), "unknown");
  assert.equal(sanitizeErrorClass("", "apply-failed"), "apply-failed");
});
