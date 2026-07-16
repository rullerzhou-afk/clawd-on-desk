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

// Renderers outside the settings window resolve t() against src/i18n.js, and t() falls
// back to returning the key itself, so a string filed under settings-i18n.js by mistake
// renders its own name into the UI instead of failing loudly.
function runtimeDictRenderers() {
  const dir = path.join(ROOT, "src");
  const renderers = new Set();
  for (const html of fs.readdirSync(dir).filter((f) => f.endsWith(".html"))) {
    const markup = fs.readFileSync(path.join(dir, html), "utf8");
    const scripts = Array.from(markup.matchAll(/<script[^>]+src="\.?\/?([^"]+\.js)"/g), (m) => m[1]);
    if (scripts.includes("settings-i18n.js")) continue;
    for (const script of scripts) {
      const file = path.join(dir, script);
      if (!fs.existsSync(file)) continue;
      const source = fs.readFileSync(file, "utf8");
      if (/function t\(key\)/.test(source) && /getI18n\(/.test(source)) renderers.add(script);
    }
  }
  return Array.from(renderers);
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

  it("keeps every renderer t(\"key\") literal resolvable in the runtime locale", () => {
    const renderers = runtimeDictRenderers();
    for (const known of ["session-hud-renderer.js", "dashboard-renderer.js"]) {
      assert.ok(renderers.includes(known), `renderer discovery missed ${known}`);
    }
    for (const file of renderers) {
      const source = fs.readFileSync(path.join(ROOT, "src", file), "utf8");
      // the lookbehind drops method calls like obj.t("x")
      const keys = new Set(
        Array.from(source.matchAll(/(?<![\w$.])t\(\s*"([A-Za-z0-9_]+)"\s*\)/g), (m) => m[1])
      );
      // a key picked by a ternary reaches t() as t(tipKey), never as a literal, so pull the
      // strings out of any *Key identifier that t() is actually called with
      for (const [, ident, rhs] of source.matchAll(/\b(\w+Key)\b\s*=\s*([^;]+);/g)) {
        if (!new RegExp(`(?<![\\w$.])t\\(\\s*${ident}\\s*\\)`).test(source)) continue;
        for (const [, key] of rhs.matchAll(/"([A-Za-z0-9_]+)"/g)) keys.add(key);
      }
      assert.ok(keys.size, `${file} should call t() with literal keys`);
      for (const key of keys) {
        assert.ok(key in i18n.en, `${file}: i18n key "${key}" is missing from src/i18n.js`);
      }
    }
  });

  // Keys reached through a lookup table (t(entry.key)) are invisible to the scan above, so
  // rather than trace dataflow, treat any Settings-only key name appearing in a runtime
  // renderer as misfiled. Keys resolved purely at runtime from main-process payloads never
  // appear as literals here, so they stay out of scope.
  it("keeps renderers clear of keys that only exist in the Settings locale", () => {
    const settings = loadSettingsI18nStrings();
    for (const file of runtimeDictRenderers()) {
      const source = fs.readFileSync(path.join(ROOT, "src", file), "utf8");
      const literals = new Set(Array.from(source.matchAll(/"([A-Za-z][A-Za-z0-9_]{2,})"/g), (m) => m[1]));
      for (const literal of literals) {
        if (literal in settings.en && !(literal in i18n.en)) {
          assert.fail(`${file}: "${literal}" resolves only in settings-i18n.js, which this window never loads`);
        }
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
