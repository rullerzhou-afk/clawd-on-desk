"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getDefaults,
  normalizeRemoteOpenclaw,
  validateRemoteOpenclaw,
} = require("../src/remote-openclaw-profile");

test("defaults are disabled and blank", () => {
  const defaults = getDefaults();
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.url, "");
  assert.equal(defaults.authMode, "password");
  assert.equal(defaults.agentFilter, "");
});

// Settings snapshots are broadcast to every renderer window, so the gateway
// credential must never become a prefs field. See
// remote-openclaw-credential-store.js.
test("the profile block has no credential field", () => {
  assert.deepEqual(Object.keys(getDefaults()).sort(), ["agentFilter", "authMode", "enabled", "url"]);
  const normalized = normalizeRemoteOpenclaw({ password: "pw", token: "tok", enabled: true });
  assert.equal(normalized.password, undefined);
  assert.equal(normalized.token, undefined);
});

test("normalizeRemoteOpenclaw never throws, so a corrupt prefs entry cannot brick settings", () => {
  for (const bad of [null, undefined, "", 42, "text", [], true]) {
    assert.deepEqual(normalizeRemoteOpenclaw(bad), getDefaults(), `input ${JSON.stringify(bad)}`);
  }
});

test("normalizeRemoteOpenclaw coerces and trims fields", () => {
  const result = normalizeRemoteOpenclaw({
    enabled: "yes",
    url: "  openclaw.example.com  ",
    authMode: "nonsense",
    password: 123,
    token: {},
    agentFilter: "  agent-7  ",
  });
  assert.deepEqual(result, {
    enabled: false,
    url: "openclaw.example.com",
    authMode: "password",
    agentFilter: "agent-7",
  });
});

test("normalizeRemoteOpenclaw keeps the token mode", () => {
  assert.equal(normalizeRemoteOpenclaw({ authMode: "token" }).authMode, "token");
});

test("a disabled profile may stay incomplete so fields can be filled in any order", () => {
  assert.deepEqual(validateRemoteOpenclaw({ enabled: false }), { status: "ok" });
  assert.deepEqual(validateRemoteOpenclaw(getDefaults()), { status: "ok" });
});

test("an enabled profile needs a url; the credential is checked by the runtime", () => {
  // The credential lives outside prefs, so this validator cannot see it —
  // remote-openclaw-ipc.js reports "missing password"/"missing token" as a
  // connection status instead.
  assert.deepEqual(
    validateRemoteOpenclaw({ enabled: true, url: "openclaw.example.com", authMode: "password" }),
    { status: "ok" },
  );
  assert.deepEqual(
    validateRemoteOpenclaw({ enabled: true, url: "gw.example.com", authMode: "token" }),
    { status: "ok" },
  );

  const noUrl = validateRemoteOpenclaw({ enabled: true, authMode: "password" });
  assert.equal(noUrl.status, "error");
  assert.match(noUrl.message, /remoteOpenclaw\.url/);
});

test("an unknown authMode is rejected even when disabled", () => {
  const result = validateRemoteOpenclaw({ enabled: false, authMode: "magic-link" });
  assert.equal(result.status, "error");
  assert.match(result.message, /authMode/);
});

test("a non-object block is rejected", () => {
  for (const bad of [null, "x", 7, []]) {
    assert.equal(validateRemoteOpenclaw(bad).status, "error");
  }
});
