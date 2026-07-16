"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeDiscordPresence,
  validateDiscordPresence,
  readiness,
  DEFAULT_DISCORD_PRESENCE,
  DEFAULT_CLAWD_DISCORD_APP_ID,
} = require("../src/discord-presence-settings");

test("normalizeDiscordPresence coerces types and strips non-digits from the App ID", () => {
  assert.deepStrictEqual(normalizeDiscordPresence(null), { ...DEFAULT_DISCORD_PRESENCE });
  assert.deepStrictEqual(normalizeDiscordPresence("nonsense"), { ...DEFAULT_DISCORD_PRESENCE });

  const n = normalizeDiscordPresence({
    enabled: 1,                                 // only strict true enables
    applicationId: " 123-456-789-012-345-678 ", // digits only
    privacyShowProject: "yes",                  // only strict true
  });
  assert.strictEqual(n.enabled, false);
  assert.strictEqual(n.applicationId, "123456789012345678");
  assert.strictEqual(n.privacyShowProject, false);

  const on = normalizeDiscordPresence({ enabled: true, privacyShowProject: true });
  assert.strictEqual(on.enabled, true);
  assert.strictEqual(on.privacyShowProject, true);
});

test("validateDiscordPresence accepts empty or a 17-20 digit snowflake, rejects others", () => {
  assert.strictEqual(validateDiscordPresence({ applicationId: "" }).status, "ok");
  assert.strictEqual(validateDiscordPresence({ applicationId: "123456789012345678" }).status, "ok");
  assert.strictEqual(validateDiscordPresence({ applicationId: "12345" }).status, "error");
  // Over-length input is rejected rather than silently truncated to a wrong ID.
  assert.strictEqual(validateDiscordPresence({ applicationId: "123456789012345678901234" }).status, "error");
});

test("readiness gates on enabled + an effective App ID", () => {
  const off = readiness({ enabled: false, applicationId: "123456789012345678" });
  assert.strictEqual(off.ready, false);
  assert.strictEqual(off.reason, "disabled");

  // Inject an empty default: the shipped constant is non-empty now, and this
  // case guards the no-App-ID-at-all branch.
  const noId = readiness({ enabled: true, applicationId: "" }, "");
  assert.strictEqual(noId.ready, false);
  assert.strictEqual(noId.reason, "no-app-id");

  const ok = readiness({ enabled: true, applicationId: "123456789012345678" });
  assert.strictEqual(ok.ready, true);
  assert.strictEqual(ok.appId, "123456789012345678");
});

test("shipped default App ID makes an empty config ready out of the box (#215)", () => {
  assert.match(DEFAULT_CLAWD_DISCORD_APP_ID, /^[0-9]{17,20}$/, "shipped default must be a valid snowflake");
  const r = readiness({ enabled: true, applicationId: "" });
  assert.strictEqual(r.ready, true);
  assert.strictEqual(r.appId, DEFAULT_CLAWD_DISCORD_APP_ID);
  // A user-saved App ID still wins over the shipped default.
  const saved = readiness({ enabled: true, applicationId: "111111111111111111" });
  assert.strictEqual(saved.appId, "111111111111111111");
});

test("readiness honors an injected default App ID (the BYO handoff seam)", () => {
  // With a default shipped, enabling needs no user-saved App ID.
  const fromDefault = readiness({ enabled: true, applicationId: "" }, "999999999999999999");
  assert.strictEqual(fromDefault.ready, true);
  assert.strictEqual(fromDefault.appId, "999999999999999999");
  // A user-saved ID still wins over the default.
  const saved = readiness({ enabled: true, applicationId: "111111111111111111" }, "999999999999999999");
  assert.strictEqual(saved.appId, "111111111111111111");
});
