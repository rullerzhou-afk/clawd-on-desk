"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { i18n, SUPPORTED_LANGS } = require("../src/i18n");

describe("i18n locales", () => {
  it("lists Korean and Japanese in supported languages", () => {
    assert.deepStrictEqual(SUPPORTED_LANGS, ["en", "zh", "ko", "ja"]);
  });

  it("keeps all locale keysets aligned with English", () => {
    const baseKeys = Object.keys(i18n.en).sort();
    for (const lang of SUPPORTED_LANGS) {
      assert.ok(i18n[lang], `missing locale: ${lang}`);
      assert.deepStrictEqual(Object.keys(i18n[lang]).sort(), baseKeys, `locale keys mismatch: ${lang}`);
    }
  });
});
