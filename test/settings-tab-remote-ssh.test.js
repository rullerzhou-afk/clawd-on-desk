"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "..", "src");
const { SUPPORTED_LANGS } = require("../src/i18n");

// ── settings-tab-remote-ssh.js script integrity ──

test("settings-tab-remote-ssh.js loads in a sandbox via the same IIFE pattern as siblings", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-tab-remote-ssh.js"), "utf8");
  // IIFE registration check — must call ClawdSettingsTabRemoteSsh = { init }.
  assert.match(code, /root\.ClawdSettingsTabRemoteSsh\s*=\s*\{\s*init\s*\}/);
  // Must register itself in core.tabs["remote-ssh"].
  assert.match(code, /core\.tabs\["remote-ssh"\]\s*=\s*\{\s*render\s*\}/);
});

test("settings-tab-remote-ssh.js is registered in settings.html before settings-renderer.js", () => {
  const html = fs.readFileSync(path.join(SRC_DIR, "settings.html"), "utf8");
  const tabIdx = html.indexOf('settings-tab-remote-ssh.js');
  const rendererIdx = html.indexOf('settings-renderer.js');
  assert.ok(tabIdx > 0, "settings-tab-remote-ssh.js must appear in settings.html");
  assert.ok(rendererIdx > tabIdx, "settings-renderer.js must come after settings-tab-remote-ssh.js");
});

test("settings-renderer.js SIDEBAR_TABS includes remote-ssh entry", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-renderer.js"), "utf8");
  assert.match(code, /id:\s*"remote-ssh"/);
  assert.match(code, /labelKey:\s*"sidebarRemoteSsh"/);
});

// ── i18n: all language packs include the new keys ──

test("settings-i18n.js: all language packs include remote-ssh keys", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-i18n.js"), "utf8");
  const REQUIRED_KEYS = [
    "sidebarRemoteSsh",
    "remoteSshTitle",
    "remoteSshSubtitle",
    "remoteSshAddProfile",
    "remoteSshConnect",
    "remoteSshDisconnect",
    "remoteSshAuthenticate",
    "remoteSshOpenTerminal",
    "remoteSshDeploy",
    "remoteSshFieldHost",
    "remoteSshFieldRemoteForwardPort",
    "remoteSshStatus_idle",
    "remoteSshStatus_connecting",
    "remoteSshStatus_connected",
    "remoteSshStatus_failed",
    "remoteSshStep_install-copilot",
  ];
  // Each key should appear at least once per language pack.
  for (const key of REQUIRED_KEYS) {
    const matches = code.match(new RegExp(`\\b${key}\\b`, "g")) || [];
    assert.ok(
      matches.length >= SUPPORTED_LANGS.length,
      `key ${key} should appear ≥${SUPPORTED_LANGS.length} times (${SUPPORTED_LANGS.length} langs); found ${matches.length}`
    );
  }
});

// ── i18n strings sanity: every lang block defines sidebarRemoteSsh ──

test("settings-i18n.js: sidebarRemoteSsh defined in every supported language", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-i18n.js"), "utf8");
  const matches = code.match(/sidebarRemoteSsh:\s*"[^"]+"/g) || [];
  assert.equal(
    matches.length,
    SUPPORTED_LANGS.length,
    `expected ${SUPPORTED_LANGS.length} sidebarRemoteSsh defs; got ${matches.length}`
  );
  // No two should be the same (sanity: ensures actual translation, not copy-paste).
  const values = matches.map((m) => m.match(/"([^"]+)"/)[1]);
  const unique = new Set(values);
  assert.equal(unique.size, SUPPORTED_LANGS.length, `expected ${SUPPORTED_LANGS.length} distinct translations; got ${[...unique]}`);
});

// ── Smoke: the tab module exports a render that doesn't blow up at top-level eval ──

// ── CSS class wiring ──
//
// Earlier code used .btn / .btn-primary / .btn-danger which don't exist in
// settings.css. This regression-checks both directions: the tab JS only uses
// classes that settings.css actually defines, and settings.css contains
// dedicated rules for the layout classes the tab introduces.

test("settings-tab-remote-ssh.js uses only CSS classes that exist in settings.css", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-tab-remote-ssh.js"), "utf8");
  // Tokenize all `className = "..."` literals into the actual class names.
  const usedClasses = new Set();
  const re = /className\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    for (const tok of m[1].split(/\s+/)) {
      if (tok) usedClasses.add(tok);
    }
  }
  // The fictitious classes from the original commit must NOT appear.
  const FORBIDDEN = ["btn", "btn-primary", "btn-danger"];
  for (const bad of FORBIDDEN) {
    assert.equal(usedClasses.has(bad), false,
      `Remote SSH tab must not use bare .${bad} (does not exist in settings.css)`);
  }
  // Every shared class (not remote-ssh-* — those are scoped to this tab and
  // checked in the next test) must have a definition in settings.css.
  const css = fs.readFileSync(path.join(SRC_DIR, "settings.css"), "utf8");
  for (const cls of usedClasses) {
    if (cls.startsWith("remote-ssh-")) continue;
    assert.match(css, new RegExp(`\\.${cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
      `settings.css must define .${cls} (used by Remote SSH tab)`);
  }
});

test("settings.css defines remote-ssh-* layout rules used by the tab", () => {
  const css = fs.readFileSync(path.join(SRC_DIR, "settings.css"), "utf8");
  const required = [
    "remote-ssh-section-header",
    "remote-ssh-empty",
    "remote-ssh-card",
    "remote-ssh-card-meta",
    "remote-ssh-card-label",
    "remote-ssh-card-host",
    "remote-ssh-card-actions",
    "remote-ssh-status-row",
    "remote-ssh-status-message",
    "remote-ssh-status-badge",
    "remote-ssh-status-idle",
    "remote-ssh-status-connecting",
    "remote-ssh-status-connected",
    "remote-ssh-status-failed",
    "remote-ssh-actions",
    "remote-ssh-btn-danger",
    "remote-ssh-progress-log",
    "remote-ssh-progress-line",
    "remote-ssh-edit",
    "remote-ssh-field",
    "remote-ssh-field-label",
    "remote-ssh-field-hint",
    "remote-ssh-field-check",
    "remote-ssh-form-actions",
    "remote-ssh-hooks-row",
    "remote-ssh-hooks-label",
    "remote-ssh-hooks-value",
    "remote-ssh-hooks-never",
    "remote-ssh-hooks-deployed",
    "remote-ssh-deploy-warn",
  ];
  for (const cls of required) {
    assert.match(css, new RegExp(`\\.${cls}\\b`),
      `settings.css must define .${cls}`);
  }
});

test("settings-i18n.js: codexHookReviewReminder defined in every supported language (B2 followup)", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-i18n.js"), "utf8");
  const matches = code.match(/codexHookReviewReminder:\s*"[^"]+"/g) || [];
  assert.equal(matches.length, SUPPORTED_LANGS.length,
    `expected ${SUPPORTED_LANGS.length} codexHookReviewReminder defs; got ${matches.length}`);
  // Translations must differ — guards against copy-paste leaving English in 3 slots.
  const values = matches.map((m) => m.match(/"([^"]+)"/)[1]);
  assert.equal(new Set(values).size, SUPPORTED_LANGS.length,
    `expected ${SUPPORTED_LANGS.length} distinct translations; got ${[...new Set(values)]}`);
});

test("settings-i18n.js: hooks deploy status keys present in every supported language", () => {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-i18n.js"), "utf8");
  const REQUIRED_KEYS = [
    "remoteSshHooksLabel",
    "remoteSshHooksNever",
    "remoteSshHooksDeployedJustNow",
    "remoteSshHooksDeployedAgoMin",
    "remoteSshHooksDeployedAgoHr",
    "remoteSshHooksDeployedAgoDay",
    "remoteSshConnectWarnNoDeploy",
  ];
  for (const key of REQUIRED_KEYS) {
    const matches = code.match(new RegExp(`\\b${key}\\b`, "g")) || [];
    assert.ok(matches.length >= SUPPORTED_LANGS.length,
      `key ${key} should appear ≥${SUPPORTED_LANGS.length} times (one per lang); found ${matches.length}`);
  }
});

test("settings-tab-remote-ssh.js can be evaluated without DOM (no top-level DOM access)", () => {
  // Provide a minimal fake globalThis stand-in. The module only uses globalThis
  // to register `ClawdSettingsTabRemoteSsh`; render() is what actually touches
  // the DOM, and we don't call it here.
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-tab-remote-ssh.js"), "utf8");
  const sandbox = { globalThis: undefined };
  sandbox.globalThis = sandbox;
  // eslint-disable-next-line no-new-func
  const fn = new Function("globalThis", "crypto", "window", code);
  fn(sandbox.globalThis, undefined, undefined);
  assert.ok(sandbox.globalThis.ClawdSettingsTabRemoteSsh, "tab module must register on globalThis");
  assert.equal(typeof sandbox.globalThis.ClawdSettingsTabRemoteSsh.init, "function");
});
