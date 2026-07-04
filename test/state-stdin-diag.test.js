"use strict";

// #583: formatStdinDiag renders hook-reported stdin diagnostics on the
// session-debug event line so sid=default reports can be triaged from logs.

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const themeLoader = require("../src/theme-loader");
themeLoader.init(path.join(__dirname, "..", "src"));
const _defaultTheme = themeLoader.loadTheme("clawd");

function makeCtx() {
  return {
    theme: _defaultTheme,
    doNotDisturb: false,
    miniTransitioning: false,
    miniMode: false,
    mouseOverPet: false,
    idlePaused: false,
    forceEyeResend: false,
    mouseStillSince: Date.now(),
    playSound() {},
    sendToRenderer() {},
    syncHitWin() {},
    sendToHitWin() {},
    miniPeekIn() {},
    miniPeekOut() {},
    buildContextMenu() {},
    buildTrayMenu() {},
    pendingPermissions: [],
    resolvePermissionEntry() {},
    t: (k) => k,
    focusTerminalWindow() {},
  };
}

describe("formatStdinDiag", () => {
  let api;

  beforeEach(() => {
    api = require("../src/state")(makeCtx());
  });

  it("renders the never-arrived shape (bytes:0 + timeout)", () => {
    const out = api.formatStdinDiag({ bytes: 0, timedOut: true, durationMs: 2001, parseError: null });
    assert.strictEqual(out, " stdin=bytes:0,timeout:1,ms:2001");
  });

  it("renders the arrived-broken shape with a parse error", () => {
    const out = api.formatStdinDiag({
      bytes: 17,
      timedOut: false,
      durationMs: 3,
      parseError: "Unexpected end of\nJSON input",
    });
    assert.strictEqual(out, ' stdin=bytes:17,timeout:0,ms:3 stdinErr="Unexpected end of JSON input"');
  });

  it("strips quotes, backslashes, ANSI escapes, and control chars from parse errors (forged /state)", () => {
    const ESC = String.fromCharCode(27); // raw ESC kept out of this source file
    const out = api.formatStdinDiag({
      bytes: 5,
      timedOut: false,
      durationMs: 1,
      parseError: 'bad\" timeout:1 ' + ESC + '[2Kinject\\ed',
    });
    assert.strictEqual(out, ' stdin=bytes:5,timeout:0,ms:1 stdinErr=\"bad timeout:1 [2Kinject ed\"');
    assert.ok(!out.includes(ESC), "ANSI escape must be stripped");
    assert.strictEqual((out.match(/\"/g) || []).length, 2, "only the two delimiter quotes may remain");
  });

  it("caps the parse error at 80 chars and collapses whitespace", () => {
    const out = api.formatStdinDiag({
      bytes: 5,
      timedOut: false,
      durationMs: 1,
      parseError: "x".repeat(200),
    });
    assert.ok(out.includes(`stdinErr="${"x".repeat(80)}"`));
    assert.ok(!out.includes("x".repeat(81)));
  });

  it("returns empty string for null or non-object diag", () => {
    assert.strictEqual(api.formatStdinDiag(null), "");
    assert.strictEqual(api.formatStdinDiag(undefined), "");
    assert.strictEqual(api.formatStdinDiag("bytes:0"), "");
  });

  it("renders '-' for missing numeric fields", () => {
    const out = api.formatStdinDiag({ timedOut: true });
    assert.strictEqual(out, " stdin=bytes:-,timeout:1,ms:-");
  });
});
