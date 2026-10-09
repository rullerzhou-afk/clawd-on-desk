"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const settings = require("../src/slack-notify-settings");

const tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-slack-notify-"));
  tempDirs.push(dir);
  return dir;
}

test.afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

test("normalizeSlackNotify fills defaults and coerces types", () => {
  assert.deepEqual(settings.normalizeSlackNotify(undefined), {
    enabled: false,
    channelId: "",
    notifyOnDone: true,
    notifyOnError: true,
    notifyOnPermission: true,
    outputMode: "off",
  });
  assert.deepEqual(settings.normalizeSlackNotify({
    enabled: true,
    channelId: "  C123  ",
    notifyOnDone: false,
    outputMode: "tail", // legacy alias -> full
  }), {
    enabled: true,
    channelId: "C123",
    notifyOnDone: false,
    notifyOnError: true,
    notifyOnPermission: true,
    outputMode: "full",
  });
  assert.equal(settings.normalizeSlackNotify({ channelId: "\tC123\t" }).channelId, "");
  assert.equal(settings.normalizeSlackNotify({ channelId: "C123\u007f" }).channelId, "");
});

test("validateSlackNotify rejects unknown keys and bad types", () => {
  assert.equal(settings.validateSlackNotify({ enabled: false }).status, "ok");
  assert.equal(settings.validateSlackNotify({ enabled: "no" }).status, "error");
  assert.equal(settings.validateSlackNotify({ enabled: false, nope: 1 }).status, "error");
  assert.equal(settings.validateSlackNotify({ enabled: false, outputMode: "tail" }).status, "error");
  assert.equal(settings.validateSlackNotify("x").status, "error");
  assert.equal(settings.validateSlackNotify({ enabled: false, channelId: "C1\nC2" }).status, "error");
  assert.equal(settings.validateSlackNotify({ enabled: false, channelId: "C1\u007fC2" }).status, "error");
});

test("isValidWebhookUrl pins the Slack host over https", () => {
  assert.ok(settings.isValidWebhookUrl("https://hooks.slack.com/services/T/B/xxx"));
  assert.ok(!settings.isValidWebhookUrl("http://hooks.slack.com/services/T/B/xxx"));
  assert.ok(!settings.isValidWebhookUrl("https://evil.example.com/services/T/B/xxx"));
  assert.ok(!settings.isValidWebhookUrl("not a url"));
  assert.ok(!settings.isValidWebhookUrl(""));
  assert.ok(!settings.isValidWebhookUrl("https://hooks.slack.com/services/T/B/x\n"));
  assert.ok(!settings.isValidWebhookUrl("https://hooks.slack.com/services/T/\tB/x"));
  assert.ok(!settings.isValidWebhookUrl("https://hooks.slack.com/services/T/B/x\u007f"));
});

// The host check must be equality, never "contains"/"endsWith" — each of these
// would slip past a sloppier match and send the webhook body to someone else.
test("isValidWebhookUrl rejects hosts that merely look like the Slack host", () => {
  for (const url of [
    "https://hooks.slack.com.evil.com/x",       // real host as a prefix label
    "https://evil-slack.com/x",                 // suffix confusion: ...-slack.com
    "https://hooks-slack.com/x",                // dash instead of the dot
    "https://evil.com/hooks.slack.com/x",       // real host in the path
    "https://notthehooks.slack.com/x",          // different subdomain
    "https://hooks.slack.com.co/x",             // different TLD
    "https://hooks.slack.com@evil.com/x",       // userinfo trick: host is evil.com
    "https://evil.com#hooks.slack.com",         // real host in the fragment
    "https://evil.com?x=hooks.slack.com",       // real host in the query
  ]) {
    assert.ok(!settings.isValidWebhookUrl(url), `must reject ${url}`);
  }
});

// The settings field is labelled "Bot token", so only xoxb- is honored. User
// (xoxp-) and app-config (xoxe-) tokens carry broader authority than the
// chat:write scope this feature needs and are rejected outright.
test("isValidBotToken accepts xoxb- bot tokens only", () => {
  assert.equal(settings.BOT_TOKEN_PREFIX, "xoxb-");
  assert.ok(settings.isValidBotToken("xoxb-123456789-abcdefghij"));
  assert.ok(settings.isValidBotToken("  xoxb-123456789-abcdefghij  ")); // trimmed
  assert.ok(!settings.isValidBotToken("xoxp-123456789-abcdefghij"));
  assert.ok(!settings.isValidBotToken("xoxe-123456789-abcdefghij"));
  assert.ok(!settings.isValidBotToken("xoxr-123"));
  assert.ok(!settings.isValidBotToken("xoxb-short"));
  assert.ok(!settings.isValidBotToken("https://hooks.slack.com/services/T/B/x"));
  assert.ok(!settings.isValidBotToken(""));
  assert.ok(!settings.isValidBotToken("xoxb-123456789-abcdefghij\n"));
  assert.ok(!settings.isValidBotToken("xoxb-123456789-abc\tdefghij"));
  assert.ok(!settings.isValidBotToken("xoxb-123456789-abcdefghij\u007f"));
});

test("a user token in the bot-token field never resolves a transport", () => {
  const userToken = "xoxp-123456789-abcdefghij";
  assert.equal(settings.resolveSlackTransport({ channelId: "C1" }, { botToken: userToken }), null);
  const ready = settings.readiness({ enabled: true, channelId: "C1" }, { botToken: userToken });
  assert.equal(ready.ready, false);
  assert.equal(ready.reason, "invalid-secret");
  assert.match(ready.message, /xoxb-/);
});

test("resolveSlackTransport prefers webhook, falls back to bot+channel", () => {
  const webhook = "https://hooks.slack.com/services/T/B/xxx";
  const bot = "xoxb-123456789-abcdefghij";
  assert.equal(settings.resolveSlackTransport({ channelId: "C1" }, { webhookUrl: webhook, botToken: bot }), "webhook");
  assert.equal(settings.resolveSlackTransport({ channelId: "C1" }, { botToken: bot }), "bot");
  assert.equal(settings.resolveSlackTransport({ channelId: "" }, { botToken: bot }), null); // bot without channel
  assert.equal(settings.resolveSlackTransport({ channelId: "\tC1\t" }, { botToken: bot }), null);
  assert.equal(settings.resolveSlackTransport({ channelId: "C1\u007f" }, { botToken: bot }), null);
  assert.equal(settings.resolveSlackTransport({ channelId: "C1" }, {}), null);
});

test("readiness reports the right stable reason at each stage", () => {
  const webhook = "https://hooks.slack.com/services/T/B/xxx";
  assert.equal(settings.readiness({ enabled: false }, { webhookUrl: webhook }).reason, "disabled");
  assert.equal(settings.readiness({ enabled: true }, {}).reason, "missing-secret");
  // webhook present but malformed -> invalid-secret
  assert.equal(settings.readiness({ enabled: true }, { webhookUrl: "https://evil.com/x" }).reason, "invalid-secret");
  // bot token present but no channel -> invalid-config
  assert.equal(
    settings.readiness({ enabled: true, channelId: "" }, { botToken: "xoxb-1-abcdefghij" }).reason,
    "invalid-config",
  );
  const ok = settings.readiness({ enabled: true }, { webhookUrl: webhook });
  assert.equal(ok.ready, true);
  assert.equal(ok.transport, "webhook");
});

test("writeSecretsEnvFile round-trips, masks, and preserves untouched keys", () => {
  const dir = tempDir();
  const filePath = settings.defaultSecretsEnvFilePath(dir);
  assert.ok(filePath.endsWith("slack-notify.env"));

  const webhook = "https://hooks.slack.com/services/T/B/secretpath";
  const write1 = settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { webhookUrl: webhook } });
  assert.equal(write1.status, "ok");
  let read = settings.readSecretsEnvFile({ fs, filePath });
  assert.equal(read.webhookUrl, webhook);
  assert.equal(read.botToken, "");

  // Writing only the bot token must not wipe the stored webhook.
  const bot = "xoxb-123456789-abcdefghij";
  settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { botToken: bot } });
  read = settings.readSecretsEnvFile({ fs, filePath });
  assert.equal(read.webhookUrl, webhook);
  assert.equal(read.botToken, bot);

  const masked = settings.readMaskedSecrets({ fs, filePath });
  assert.equal(masked.configured, true);
  assert.ok(masked.webhookUrl.includes("......"));
  assert.ok(!masked.webhookUrl.includes("secretpath"));

  // Explicit empty string clears a field.
  settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { webhookUrl: "" } });
  read = settings.readSecretsEnvFile({ fs, filePath });
  assert.equal(read.webhookUrl, "");
  assert.equal(read.botToken, bot);
});

test("readSecretsEnvFile degrades gracefully when the file is missing", () => {
  const dir = tempDir();
  const filePath = settings.defaultSecretsEnvFilePath(dir); // never written
  assert.deepEqual(settings.readSecretsEnvFile({ fs, filePath }), { webhookUrl: "", botToken: "" });
  assert.equal(settings.readMaskedSecrets({ fs, filePath }).configured, false);
});

test("redactionSecretsForSlackNotify lists non-empty secrets", () => {
  assert.deepEqual(
    settings.redactionSecretsForSlackNotify({}, { webhookUrl: "w", botToken: "" }),
    ["w"],
  );
});

// ── Credential lifecycle and state separation (review item 3) ───────────────
// "Configured", "usable", and "switched on" were one flag, so a valid webhook
// reported itself as unusable purely because notifications were off — which is
// also why Send Test refused to run while you were still setting things up.

const WEBHOOK = "https://hooks.slack.com/services/T/B/xxx";
const BOT = "xoxb-123456789-abcdefghij";

test("transport state is reported independently of the enable switch", () => {
  const off = settings.describeTransport({ enabled: false }, { webhookUrl: WEBHOOK });
  assert.equal(off.credentialsPresent, true);
  assert.equal(off.transport, "webhook", "a stored webhook is usable whether or not sending is on");
  assert.equal(off.enabled, false);
  assert.equal(off.ready, false, "ready still means configured AND enabled");

  const on = settings.describeTransport({ enabled: true }, { webhookUrl: WEBHOOK });
  assert.equal(on.ready, true);
});

test("transport state distinguishes absent, malformed, and incomplete credentials", () => {
  const none = settings.describeTransport({ enabled: true }, {});
  assert.equal(none.credentialsPresent, false);
  assert.equal(none.transport, null);
  assert.equal(none.reason, "missing-secret");

  const bad = settings.describeTransport({ enabled: true }, { webhookUrl: "https://evil.example/x" });
  assert.equal(bad.credentialsPresent, true, "something is stored, it is just not valid");
  assert.equal(bad.transport, null);
  assert.equal(bad.reason, "invalid-secret");

  // A bot token with no channel id is stored and well-formed but unusable.
  const noChannel = settings.describeTransport({ enabled: true, channelId: "" }, { botToken: BOT });
  assert.equal(noChannel.credentialsPresent, true);
  assert.equal(noChannel.transport, null);
  assert.equal(noChannel.reason, "invalid-config");
});

test("both credentials are reported, not just the winning one", () => {
  const both = settings.describeTransport({ enabled: true, channelId: "C1" }, { webhookUrl: WEBHOOK, botToken: BOT });
  assert.equal(both.transport, "webhook", "webhook still wins");
  assert.deepEqual(both.stored, { webhookUrl: true, botToken: true },
    "the UI must be able to show a mask for a credential that is not currently in use");
});

test("secrets are validated before they are written, not after", () => {
  const dir = tempDir();
  const filePath = settings.defaultSecretsEnvFilePath(dir);

  const bad = settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { webhookUrl: "https://evil.example/x" } });
  assert.equal(bad.status, "error");
  assert.equal(bad.code, "invalid-webhook");
  assert.equal(fs.existsSync(filePath), false, "an invalid value must not reach disk at all");

  const badToken = settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { botToken: "xoxp-123456789-abcdefghij" } });
  assert.equal(badToken.status, "error");
  assert.equal(badToken.code, "invalid-bot-token");

  for (const webhookUrl of ["\n", `${WEBHOOK}\nSLACK_BOT_TOKEN=${BOT}`, `${WEBHOOK}\u007f`]) {
    const result = settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { webhookUrl } });
    assert.equal(result.code, "invalid-webhook", JSON.stringify(webhookUrl));
  }
  for (const botToken of ["\t", `${BOT}\nSLACK_WEBHOOK_URL=${WEBHOOK}`, `${BOT}\u007f`]) {
    const result = settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { botToken } });
    assert.equal(result.code, "invalid-bot-token", JSON.stringify(botToken));
  }
  assert.equal(fs.existsSync(filePath), false, "control-character credentials never touch disk");

  assert.equal(settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { webhookUrl: WEBHOOK } }).status, "ok");
});

test("the exact normalized secret bytes written are valid and round-trip unchanged", () => {
  const dir = tempDir();
  const filePath = settings.defaultSecretsEnvFilePath(dir);
  const webhook = "  https://hooks.slack.com/services/T/B/roundtrip  ";
  // Assemble the valid-shape fixture at runtime so GitHub push protection does
  // not mistake a committed high-entropy-looking test value for a real token.
  const botToken = `  ${["xoxb", "roundtrip", "fixture"].join("-")}  `;

  assert.equal(settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { webhookUrl: webhook, botToken } }).status, "ok");
  const stored = settings.readSecretsEnvFile({ fs, filePath });
  assert.deepEqual(stored, {
    webhookUrl: webhook.trim(),
    botToken: botToken.trim(),
  });
  assert.equal(settings.isValidWebhookUrl(stored.webhookUrl), true);
  assert.equal(settings.isValidBotToken(stored.botToken), true);
});

test("updating one credential does not copy a corrupt existing secret through", () => {
  const dir = tempDir();
  const filePath = settings.defaultSecretsEnvFilePath(dir);
  fs.writeFileSync(
    filePath,
    `SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T/\tB/corrupt\nSLACK_BOT_TOKEN=\n`,
    "utf8",
  );
  const before = fs.readFileSync(filePath, "utf8");

  const rejected = settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { botToken: BOT } });
  assert.equal(rejected.code, "invalid-webhook");
  assert.equal(fs.readFileSync(filePath, "utf8"), before);

  const repaired = settings.writeSecretsEnvFile({
    fs,
    path,
    filePath,
    secrets: { webhookUrl: "", botToken: BOT },
  });
  assert.equal(repaired.status, "ok", "explicitly clearing the corrupt field remains possible");
  assert.deepEqual(settings.readSecretsEnvFile({ fs, filePath }), { webhookUrl: "", botToken: BOT });
});

test("a rename failure removes its plaintext temp file and preserves the destination", () => {
  const dir = tempDir();
  const filePath = settings.defaultSecretsEnvFilePath(dir);
  assert.equal(settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { webhookUrl: WEBHOOK } }).status, "ok");
  const before = fs.readFileSync(filePath, "utf8");

  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync") return () => { throw new Error("rename denied"); };
      return Reflect.get(target, property);
    },
  });
  const result = settings.writeSecretsEnvFile({
    fs: failingFs,
    path,
    filePath,
    secrets: { webhookUrl: "https://hooks.slack.com/services/T/B/replacement" },
  });

  assert.equal(result.code, "write-failed");
  assert.equal(fs.readFileSync(filePath, "utf8"), before, "the old destination is never removed");
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")),
    [],
    "the complete plaintext temp file is cleaned"
  );
});

test("a partial write failure removes its plaintext temp file", () => {
  const dir = tempDir();
  const filePath = settings.defaultSecretsEnvFilePath(dir);
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property === "writeFileSync") {
        return (targetPath, data, options) => {
          fs.writeFileSync(targetPath, String(data).slice(0, 20), options);
          throw new Error("disk full");
        };
      }
      return Reflect.get(target, property);
    },
  });
  const result = settings.writeSecretsEnvFile({
    fs: failingFs,
    path,
    filePath,
    secrets: { webhookUrl: WEBHOOK },
  });

  assert.equal(result.code, "write-failed");
  assert.equal(fs.existsSync(filePath), false);
  assert.deepEqual(fs.readdirSync(dir), [], "the partial plaintext temp file is cleaned");
});

test("an explicit empty string clears one credential and leaves the other", () => {
  const dir = tempDir();
  const filePath = settings.defaultSecretsEnvFilePath(dir);
  settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { webhookUrl: WEBHOOK } });
  settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { botToken: BOT } });
  assert.deepEqual(settings.readSecretsEnvFile({ fs, filePath }), { webhookUrl: WEBHOOK, botToken: BOT });

  // Clearing the webhook must hand the transport over to the bot token, which
  // is the switch that was previously impossible without editing the file.
  settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { webhookUrl: "" } });
  const afterClear = settings.readSecretsEnvFile({ fs, filePath });
  assert.equal(afterClear.webhookUrl, "");
  assert.equal(afterClear.botToken, BOT);
  assert.equal(settings.describeTransport({ enabled: true, channelId: "C1" }, afterClear).transport, "bot");

  // Clearing everything is allowed too — that is how you disconnect.
  settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { webhookUrl: "", botToken: "" } });
  const cleared = settings.readSecretsEnvFile({ fs, filePath });
  assert.deepEqual(cleared, { webhookUrl: "", botToken: "" });
  assert.equal(settings.describeTransport({ enabled: true }, cleared).credentialsPresent, false);
});

test("switching transports works in both directions", () => {
  const dir = tempDir();
  const filePath = settings.defaultSecretsEnvFilePath(dir);
  const cfg = { enabled: true, channelId: "C1" };

  // bot -> webhook: adding a webhook takes over, because it outranks the token.
  settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { botToken: BOT } });
  assert.equal(settings.describeTransport(cfg, settings.readSecretsEnvFile({ fs, filePath })).transport, "bot");
  settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { webhookUrl: WEBHOOK } });
  assert.equal(settings.describeTransport(cfg, settings.readSecretsEnvFile({ fs, filePath })).transport, "webhook");

  // webhook -> bot: only reachable by clearing the webhook, which is the case
  // that was impossible from the UI before.
  settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { webhookUrl: "" } });
  assert.equal(settings.describeTransport(cfg, settings.readSecretsEnvFile({ fs, filePath })).transport, "bot");
});

test("credentials survive a restart, and a cleared one stays cleared", () => {
  const dir = tempDir();
  const filePath = settings.defaultSecretsEnvFilePath(dir);
  settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { webhookUrl: WEBHOOK, botToken: BOT } });

  // A "restart" is simply reading the file again with no in-memory state.
  const afterRestart = settings.readSecretsEnvFile({ fs, filePath });
  assert.equal(afterRestart.webhookUrl, WEBHOOK);
  assert.equal(afterRestart.botToken, BOT);

  settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { botToken: "" } });
  const afterClearRestart = settings.readSecretsEnvFile({ fs, filePath });
  assert.equal(afterClearRestart.botToken, "", "a removal must not come back on next launch");
  assert.equal(afterClearRestart.webhookUrl, WEBHOOK);
});

test("transport and transportConfigured never disagree", () => {
  // They came from two different functions once — readiness (which requires the
  // enable switch) and describeTransport (which does not) — so a disabled but
  // perfectly configured channel reported transportConfigured: true alongside
  // transport: null, and the card could not name what it would send through.
  for (const enabled of [true, false]) {
    const state = settings.describeTransport({ enabled, channelId: "C1" }, { botToken: BOT });
    assert.equal(!!state.transport, true, `transport should resolve when enabled=${enabled}`);
    assert.equal(state.enabled, enabled);
    assert.equal(state.ready, enabled, "only ready follows the switch");
  }
});
