"use strict";

const test = require("node:test");
const assert = require("node:assert");

const validators = require("../src/settings-validators");

test("settings validators expose the shared helper surface", () => {
  assert.deepStrictEqual(Object.keys(validators).sort(), [
    "requireBoolean",
    "requireEnum",
    "requireFiniteNumber",
    "requireIntegerInRange",
    "requireNonNegativeFiniteNumber",
    "requireNumberInRange",
    "requirePlainObject",
    "requireString",
    "requireStringArray",
  ]);
});

test("settings validators preserve primitive validation behavior", () => {
  assert.deepStrictEqual(validators.requireBoolean("flag")(true), { status: "ok" });
  assert.strictEqual(validators.requireBoolean("flag")("true").status, "error");

  assert.deepStrictEqual(validators.requireFiniteNumber("x")(0), { status: "ok" });
  assert.strictEqual(validators.requireFiniteNumber("x")(Infinity).status, "error");

  assert.deepStrictEqual(validators.requireNonNegativeFiniteNumber("width")(0), { status: "ok" });
  assert.strictEqual(validators.requireNonNegativeFiniteNumber("width")(-1).status, "error");

  assert.deepStrictEqual(validators.requireNumberInRange("volume", 0, 1)(0.5), { status: "ok" });
  assert.strictEqual(validators.requireNumberInRange("volume", 0, 1)(1.5).status, "error");

  assert.deepStrictEqual(validators.requireIntegerInRange("seconds", 0, 60)(30), { status: "ok" });
  assert.strictEqual(validators.requireIntegerInRange("seconds", 0, 60)(30.5).status, "error");

  assert.deepStrictEqual(validators.requireEnum("lang", ["en", "zh"])("en"), { status: "ok" });
  assert.strictEqual(validators.requireEnum("lang", ["en", "zh"])("ja").status, "error");
});

test("settings validators preserve string and object validation behavior", () => {
  assert.deepStrictEqual(validators.requireString("name")("Clawd"), { status: "ok" });
  assert.strictEqual(validators.requireString("name")("").status, "error");
  assert.deepStrictEqual(validators.requireString("name", { allowEmpty: true })(""), { status: "ok" });

  assert.deepStrictEqual(validators.requirePlainObject("payload")({}), { status: "ok" });
  assert.strictEqual(validators.requirePlainObject("payload")([]).status, "error");
  assert.strictEqual(validators.requirePlainObject("payload")(null).status, "error");
});
