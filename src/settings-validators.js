"use strict";

function requireBoolean(key) {
  return function (value) {
    if (typeof value !== "boolean") {
      return { status: "error", message: `${key} must be a boolean` };
    }
    return { status: "ok" };
  };
}

function requireFiniteNumber(key) {
  return function (value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { status: "error", message: `${key} must be a finite number` };
    }
    return { status: "ok" };
  };
}

function requireNonNegativeFiniteNumber(key) {
  return function (value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return { status: "error", message: `${key} must be a non-negative finite number` };
    }
    return { status: "ok" };
  };
}

function requireNumberInRange(key, min, max) {
  return function (value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      return { status: "error", message: `${key} must be a finite number between ${min} and ${max}` };
    }
    return { status: "ok" };
  };
}

function requireIntegerInRange(key, min, max) {
  return function (value) {
    if (!Number.isInteger(value) || value < min || value > max) {
      return { status: "error", message: `${key} must be an integer between ${min} and ${max}` };
    }
    return { status: "ok" };
  };
}

function requireEnum(key, allowed) {
  return function (value) {
    if (!allowed.includes(value)) {
      return {
        status: "error",
        message: `${key} must be one of: ${allowed.join(", ")}`,
      };
    }
    return { status: "ok" };
  };
}

function requireString(key, { allowEmpty = false } = {}) {
  return function (value) {
    if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
      return { status: "error", message: `${key} must be a non-empty string` };
    }
    return { status: "ok" };
  };
}

function requirePlainObject(key) {
  return function (value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { status: "error", message: `${key} must be a plain object` };
    }
    return { status: "ok" };
  };
}

function requireStringArray(key) {
  return function (value) {
    if (!Array.isArray(value) || !value.every((part) => typeof part === "string")) {
      return { status: "error", message: `${key} must be an array of strings` };
    }
    return { status: "ok" };
  };
}

module.exports = {
  requireBoolean,
  requireFiniteNumber,
  requireNonNegativeFiniteNumber,
  requireNumberInRange,
  requireIntegerInRange,
  requireEnum,
  requireString,
  requirePlainObject,
  requireStringArray,
};
