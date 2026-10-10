"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC_DIR = path.join(__dirname, "..", "src");
const { SUPPORTED_LANGS } = require("../src/i18n");

// ── settings-tab-remote-openclaw.js script integrity ──

test("settings-tab-remote-openclaw.js registers itself through the sibling IIFE pattern", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-tab-remote-openclaw.js"), "utf8");
  assert.match(code, /root\.ClawdSettingsTabRemoteOpenclaw\s*=\s*\{\s*init\s*\}/);
  assert.match(code, /core\.tabs\["remote-openclaw"\]\s*=\s*\{\s*render\s*\}/);
});

test("settings-tab-remote-openclaw.js is registered in settings.html before settings-renderer.js", () => {
  const html = fs.readFileSync(path.join(SRC_DIR, "settings.html"), "utf8");
  const tabIdx = html.indexOf("settings-tab-remote-openclaw.js");
  const rendererIdx = html.indexOf("settings-renderer.js");
  assert.ok(tabIdx > 0, "settings-tab-remote-openclaw.js must appear in settings.html");
  assert.ok(rendererIdx > tabIdx, "settings-renderer.js must come after settings-tab-remote-openclaw.js");
});

test("settings-renderer.js SIDEBAR_TABS includes the remote-openclaw entry", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-renderer.js"), "utf8");
  assert.match(code, /id:\s*"remote-openclaw"/);
  assert.match(code, /labelKey:\s*"sidebarRemoteOpenclaw"/);
  assert.match(code, /ClawdSettingsTabRemoteOpenclaw/);
});

test("settings-tab-remote-openclaw.js can be evaluated without a DOM at import time", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-tab-remote-openclaw.js"), "utf8");
  const context = { console };
  context.globalThis = context;
  const script = new (require("node:vm").Script)(code, { filename: "settings-tab-remote-openclaw.js" });
  assert.doesNotThrow(() => script.runInNewContext(context));
  assert.equal(typeof context.ClawdSettingsTabRemoteOpenclaw.init, "function");
});

// ── i18n: every language pack carries the new keys ──

test("settings-i18n.js: all language packs include remote-openclaw keys", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-i18n.js"), "utf8");
  const REQUIRED_KEYS = [
    "sidebarRemoteOpenclaw",
    "remoteOpenclawTitle",
    "remoteOpenclawSubtitle",
    "remoteOpenclawConnectionTitle",
    "remoteOpenclawEnableLabel",
    "remoteOpenclawEnableDesc",
    "remoteOpenclawUrlLabel",
    "remoteOpenclawUrlDesc",
    "remoteOpenclawUrlInvalid",
    "remoteOpenclawAuthModeLabel",
    "remoteOpenclawAuthModeDesc",
    "remoteOpenclawAuthModePassword",
    "remoteOpenclawAuthModeToken",
    "remoteOpenclawPasswordLabel",
    "remoteOpenclawTokenLabel",
    "remoteOpenclawCredentialDesc",
    "remoteOpenclawCredentialSaved",
    "remoteOpenclawCredentialStored",
    "remoteOpenclawCredentialFailed",
    "remoteOpenclawFilterTitle",
    "remoteOpenclawFilterLabel",
    "remoteOpenclawFilterDesc",
    "remoteOpenclawSave",
    "remoteOpenclawSaving",
    "remoteOpenclawSaved",
    "remoteOpenclawStatusLabel",
    "remoteOpenclawStatusIdle",
    "remoteOpenclawReadOnlyNote",
  ];
  for (const key of REQUIRED_KEYS) {
    const matches = code.match(new RegExp(`\\b${key}\\b`, "g")) || [];
    assert.ok(
      matches.length >= SUPPORTED_LANGS.length,
      `key ${key} should appear ≥${SUPPORTED_LANGS.length} times; found ${matches.length}`,
    );
  }
});

test("settings-i18n.js: sidebarRemoteOpenclaw defined in every supported language", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-i18n.js"), "utf8");
  const matches = code.match(/sidebarRemoteOpenclaw:\s*"[^"]+"/g) || [];
  assert.equal(
    matches.length,
    SUPPORTED_LANGS.length,
    `expected ${SUPPORTED_LANGS.length} sidebarRemoteOpenclaw defs; got ${matches.length}`,
  );
});

// ── CSS class wiring ──
//
// The tab reuses the shared settings row vocabulary rather than inventing its
// own, so every class it sets must already exist in settings.css.

test("settings-tab-remote-openclaw.js uses only CSS classes that exist in settings.css", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-tab-remote-openclaw.js"), "utf8");
  const usedClasses = new Set();
  const re = /className\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    for (const tok of m[1].split(/\s+/)) {
      if (tok) usedClasses.add(tok);
    }
  }
  assert.ok(usedClasses.size > 0, "expected the tab to set at least one className");
  const css = fs.readFileSync(path.join(SRC_DIR, "settings.css"), "utf8");
  for (const cls of usedClasses) {
    assert.match(
      css,
      new RegExp(`\\.${cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
      `settings.css must define .${cls} (used by Remote OpenClaw tab)`,
    );
  }
});

// ── Scope safety ──
//
// The gateway handshake yields role=operator with an empty scope list, so the
// client must never try to subscribe or request an upgrade — both are refused
// (FORBIDDEN / DEVICE_IDENTITY_REQUIRED). See remote-openclaw-runtime.js.

test("settings-tab-remote-openclaw.js offers no subscription or scope-upgrade affordance", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-tab-remote-openclaw.js"), "utf8");
  for (const forbidden of ["sessions.subscribe", "requestUpgrade", "waitUpgrade"]) {
    assert.equal(code.includes(forbidden), false, `tab must not reference ${forbidden}`);
  }
});

test("the tab tolerates a runtime that never pushes status", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-tab-remote-openclaw.js"), "utf8");
  // window.remoteOpenclaw is only present once main.js wires the IPC; the tab
  // must guard rather than assume.
  assert.match(code, /typeof api\.onStatusChanged !== "function"/);
});

// ── Credential isolation ──
//
// Settings snapshots are broadcast to every renderer window, so the gateway
// credential must never be a prefs field and must never be written through
// settingsAPI.update — that path would put it in the snapshot.

test("settings-tab-remote-openclaw.js never reads a credential out of the snapshot", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-tab-remote-openclaw.js"), "utf8");
  assert.equal(/cfg\.(password|token)/.test(code), false, "the snapshot has no credential field");
  assert.equal(/\.password\b|\.token\b/.test(code), false);
});

test("settings-tab-remote-openclaw.js writes the credential on its own IPC channel", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-tab-remote-openclaw.js"), "utf8");
  assert.match(code, /api\.setCredential\(/);
  assert.match(code, /api\.credentialStatus\(/);
  assert.match(code, /window\.remoteOpenclaw/);
  // The generic settings writer must only ever carry the non-secret fields.
  assert.match(code, /settingsAPI\.update\("remoteOpenclaw", next\)/);
});

test("prefs.js exposes remoteOpenclaw without a credential field", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "prefs.js"), "utf8");
  assert.match(code, /remoteOpenclaw:/);
  assert.match(code, /normalizeRemoteOpenclaw/);
});
