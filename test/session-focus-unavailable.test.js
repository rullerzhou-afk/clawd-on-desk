"use strict";

const assert = require("node:assert");
const test = require("node:test");

const {
  canOfferLocalFolder,
  focusUnavailableReasonKey,
} = require("../src/session-focus-unavailable");

test("focusUnavailableReasonKey distinguishes webui, remote, and missing terminal info", () => {
  assert.strictEqual(
    focusUnavailableReasonKey({ sourceType: "local", host: null, platform: "webui" }),
    "sessionFocusUnavailableWebui"
  );
  assert.strictEqual(
    focusUnavailableReasonKey({ sourceType: "ssh", host: "server", platform: null }),
    "sessionFocusUnavailableRemote"
  );
  assert.strictEqual(
    focusUnavailableReasonKey({ sourceType: "local", host: null, platform: null }),
    "sessionFocusUnavailableMissingTerminalInfo"
  );
  assert.strictEqual(
    focusUnavailableReasonKey({ host: null, platform: null }),
    "sessionFocusUnavailableMissingTerminalInfo"
  );
});

test("webui reason takes precedence when a web session also carries a remote host", () => {
  assert.strictEqual(
    focusUnavailableReasonKey({ sourceType: "ssh", host: "server", platform: "webui" }),
    "sessionFocusUnavailableWebui"
  );
});

test("canOfferLocalFolder allows only local non-webui sessions with cwd", () => {
  assert.strictEqual(canOfferLocalFolder({ sourceType: "local", host: null, platform: null, cwd: "/project" }), true);
  assert.strictEqual(canOfferLocalFolder({ sourceType: "ssh", host: "server", platform: null, cwd: "/project" }), false);
  assert.strictEqual(canOfferLocalFolder({ sourceType: "local", host: null, platform: "webui", cwd: "/project" }), false);
  assert.strictEqual(canOfferLocalFolder({ sourceType: "local", host: null, platform: null, cwd: "" }), false);
});
