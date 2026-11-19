"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { STRINGS, resolveStrings } = require("../src/network/mobile-pwa-i18n");

const ROOT = path.join(__dirname, "..");
const APP_SOURCE = fs.readFileSync(path.join(ROOT, "pwa", "app.js"), "utf8");
const HTML_SOURCE = fs.readFileSync(path.join(ROOT, "pwa", "index.html"), "utf8");
const I18N_SOURCE = fs.readFileSync(path.join(ROOT, "src", "network", "mobile-pwa-i18n.js"), "utf8");

const SUPPORTED_LANGS = ["en", "zh", "zh-TW", "ko", "ja", "pt-BR", "es"];

describe("mobile PWA strings", () => {
  it("defines the same key set in every language pack", () => {
    const enKeys = Object.keys(STRINGS.en).sort();
    assert.ok(enKeys.length >= 60, "en pack should carry the full PWA string set");
    for (const lang of SUPPORTED_LANGS) {
      assert.ok(STRINGS[lang], `${lang} pack exists`);
      assert.deepEqual(Object.keys(STRINGS[lang]).sort(), enKeys, `${lang} defines exactly the en key set`);
      for (const key of enKeys) {
        assert.equal(typeof STRINGS[lang][key], "string", `${lang}.${key} is a string`);
        assert.ok(STRINGS[lang][key], `${lang}.${key} is non-empty`);
      }
    }
  });

  it("only supports the seven prefs lang enum values", () => {
    assert.deepEqual(Object.keys(STRINGS).sort(), SUPPORTED_LANGS.slice().sort());
  });

  it("resolveStrings merges en under the target language and falls back to en", () => {
    const zh = resolveStrings("zh");
    assert.equal(zh.pairSubmit, "配对");
    assert.equal(zh.stateError, "错误");
    assert.ok(Object.keys(zh).length >= Object.keys(STRINGS.en).length);

    const unknown = resolveStrings("fr");
    assert.deepEqual(unknown, STRINGS.en);
    assert.deepEqual(resolveStrings(undefined), STRINGS.en);
    assert.deepEqual(resolveStrings(null), STRINGS.en);
  });

  it("keeps placeholders consistent across languages", () => {
    for (const [lang, pack] of Object.entries(STRINGS)) {
      for (const [key, value] of Object.entries(pack)) {
        const vars = [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
        const enVars = [...STRINGS.en[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
        assert.equal(vars, enVars, `${lang}.${key} uses the same {placeholders} as en`);
      }
    }
  });

  it("uses only state/event key names that app.js references", () => {
    // Every non-html string key must appear in app.js either directly or as a
    // STATE/CONNECTION/EVENT lookup value, otherwise the pack carries dead text.
    const used = new Set(APP_SOURCE.match(/t\("(\w+)"/g).map((m) => m.slice(3, -1)));
    for (const match of APP_SOURCE.matchAll(/labelKey: "(\w+)"|textKey: "(\w+)"|"(event\w+)"/g)) {
      for (const group of match.slice(1)) if (group) used.add(group);
    }
    for (const key of Object.keys(STRINGS.en)) {
      if (key === "pairLabel" || key === "pairSubmit" || key.startsWith("nav")) continue; // html-side tokens
      assert.ok(used.has(key), `en.${key} is referenced by pwa/app.js`);
    }
  });

  it("leaves no hardcoded CJK in the PWA sources", () => {
    assert.ok(!/[一-鿿]/.test(APP_SOURCE), "pwa/app.js must not contain CJK literals");
    assert.ok(!/[一-鿿]/.test(HTML_SOURCE), "pwa/index.html must not contain CJK literals");
    assert.ok(/[一-鿿]/.test(I18N_SOURCE), "the zh packs live in mobile-pwa-i18n.js");
  });

  it("index.html carries the server-filled placeholders", () => {
    assert.ok(HTML_SOURCE.includes('<html lang="__CLAWD_LANG__">'));
    assert.ok(HTML_SOURCE.includes("window.__CLAWD_I18N__ = __CLAWD_STRINGS_JSON__;"));
    for (const token of ["__CLAWD_T_PAIR_LABEL__", "__CLAWD_T_PAIR_SUBMIT__", "__CLAWD_T_NAV_SESSIONS__", "__CLAWD_T_NAV_SETTINGS__"]) {
      assert.ok(HTML_SOURCE.includes(token), `${token} present`);
    }
    // Existing asset-versioning contract (pwa-device-credentials asserts it too).
    assert.equal((HTML_SOURCE.match(/__CLAWD_APP_VERSION__/g) || []).length, 3);
  });
});
