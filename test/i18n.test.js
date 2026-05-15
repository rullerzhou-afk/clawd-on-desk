"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { i18n, SUPPORTED_LANGS } = require("../src/i18n");

const ROOT = path.join(__dirname, "..");

function placeholders(value) {
  return Array.from(String(value).matchAll(/\{[^}]+\}/g), (m) => m[0]).sort();
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertLocaleObjectParity(locales, label) {
  const baseKeys = Object.keys(locales.en).sort();
  for (const lang of SUPPORTED_LANGS) {
    assert.ok(locales[lang], `missing ${label} locale: ${lang}`);
    assert.deepStrictEqual(Object.keys(locales[lang]).sort(), baseKeys, `${label} locale keys mismatch: ${lang}`);
    for (const key of baseKeys) {
      assert.strictEqual(typeof locales[lang][key], typeof locales.en[key], `${label}.${lang}.${key} type mismatch`);
      if (typeof locales.en[key] === "string") {
        assert.deepStrictEqual(
          placeholders(locales[lang][key]),
          placeholders(locales.en[key]),
          `${label}.${lang}.${key} placeholder mismatch`
        );
      }
    }
  }
}

function loadSettingsI18nStrings() {
  const source = fs.readFileSync(path.join(ROOT, "src", "settings-i18n.js"), "utf8");
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.ClawdSettingsI18n.STRINGS;
}

function loadBubbleStrings() {
  const source = fs.readFileSync(path.join(ROOT, "src", "bubble-renderer.js"), "utf8");
  const match = source.match(/const BUBBLE_STRINGS = (\{[\s\S]*?\n\});/);
  assert.ok(match, "bubble-renderer.js should define BUBBLE_STRINGS");
  const context = {};
  vm.runInNewContext(`result = ${match[1]};`, context);
  return context.result;
}

describe("i18n locales", () => {
  it("lists all selectable languages in supported languages", () => {
    assert.deepStrictEqual(SUPPORTED_LANGS, ["en", "zh", "zh-TW", "ko", "ja"]);
  });

  it("keeps all locale keysets aligned with English", () => {
    assertLocaleObjectParity(i18n, "runtime");
  });

  it("keeps Settings locale keysets aligned with English", () => {
    assertLocaleObjectParity(loadSettingsI18nStrings(), "settings");
  });

  it("keeps permission bubble locale keysets aligned with English", () => {
    assertLocaleObjectParity(loadBubbleStrings(), "bubble");
  });

  it("keeps main-process Settings dialog strings available for every supported language", () => {
    const settingsIpcSource = fs.readFileSync(path.join(ROOT, "src", "settings-ipc.js"), "utf8");
    const animationOverridesSource = fs.readFileSync(
      path.join(ROOT, "src", "settings-animation-overrides-main.js"),
      "utf8"
    );
    for (const [name, source] of [
      ["SOUND_OVERRIDE_DIALOG_STRINGS", settingsIpcSource],
      ["ANIMATION_OVERRIDES_EXPORT_DIALOG_STRINGS", animationOverridesSource],
      ["REMOVE_THEME_DIALOG_STRINGS", settingsIpcSource],
    ]) {
      const start = source.indexOf(`const ${name} = {`);
      assert.notStrictEqual(start, -1, `missing ${name}`);
      const end = source.indexOf("\n};", start);
      assert.notStrictEqual(end, -1, `unterminated ${name}`);
      const block = source.slice(start, end);
      for (const lang of SUPPORTED_LANGS) {
        const escapedLang = regexEscape(lang);
        assert.match(block, new RegExp(`\\n\\s*(?:"${escapedLang}"|${escapedLang}):`), `${name} missing ${lang}`);
      }
    }
  });

  it("keeps Codex Pet main dialog strings available for every supported language", () => {
    const source = fs.readFileSync(path.join(ROOT, "src", "codex-pet-main.js"), "utf8");
    for (const name of ["getImportDialogStrings", "getRemovalDialogStrings"]) {
      const start = source.indexOf(`function ${name}()`);
      assert.notStrictEqual(start, -1, `missing ${name}`);
      const end = source.indexOf("\n  async function", start);
      assert.notStrictEqual(end, -1, `unterminated ${name}`);
      const block = source.slice(start, end);
      for (const lang of SUPPORTED_LANGS) {
        const escapedLang = regexEscape(lang);
        assert.match(block, new RegExp(`\\n\\s*(?:"${escapedLang}"|${escapedLang}):`), `${name} missing ${lang}`);
      }
    }
  });
});
