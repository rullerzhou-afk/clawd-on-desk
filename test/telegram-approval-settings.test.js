"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const settings = require("../src/telegram-approval-settings");

const tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-tg-approval-"));
  tempDirs.push(dir);
  return dir;
}

test.afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

test("normalizeTelegramApproval trims ids and accepts numeric chat id shorthand", () => {
  assert.deepEqual(settings.normalizeTelegramApproval({
    enabled: true,
    allowedTgUserId: " 123456789 ",
    targetSessionKey: "987654321",
  }), {
    enabled: true,
    allowedTgUserId: "123456789",
    targetSessionKey: "telegram:987654321",
    nativeMode: true,
  });
});

test("validateTelegramApproval requires user and target only when enabled", () => {
  assert.equal(settings.validateTelegramApproval({
    enabled: false,
    allowedTgUserId: "",
    targetSessionKey: "",
  }).status, "ok");
  assert.equal(settings.validateTelegramApproval({
    enabled: true,
    allowedTgUserId: "",
    targetSessionKey: "telegram:987654321",
  }).status, "error");
  assert.equal(settings.validateTelegramApproval({
    enabled: true,
    allowedTgUserId: "123456789",
    targetSessionKey: "telegram:987654321",
  }).status, "ok");
  assert.equal(settings.validateTelegramApproval({
    enabled: true,
    allowedTgUserId: "123456789",
    targetSessionKey: "telegram:0",
  }).status, "error");
  assert.equal(settings.validateTelegramApproval({
    enabled: false,
    allowedTgUserId: "",
    targetSessionKey: "",
    botToken: "123:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
  }).status, "error");
});

test("buildBridgeConfigToml writes sidecar config without bot token fields", () => {
  const toml = settings.buildBridgeConfigToml({
    enabled: true,
    allowedTgUserId: "123456789",
    targetSessionKey: "telegram:987654321",
    botToken: "123:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
  });
  assert.match(toml, /enabled = true/);
  assert.match(toml, /allowed_tg_user_id = "123456789"/);
  assert.match(toml, /target_session_key = "telegram:987654321"/);
  assert.doesNotMatch(toml, /bot_token/i);
  assert.doesNotMatch(toml, /ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
});

test("writeTokenEnvFile validates and stores token outside prefs", () => {
  const filePath = path.join(tempDir(), "telegram-approval.env");
  const token = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi_jklmnop";
  const result = settings.writeTokenEnvFile({ fs, path, filePath, token, platform: "linux" });
  assert.equal(result.status, "ok");
  const text = fs.readFileSync(filePath, "utf8");
  assert.equal(text, `CLAWD_TG_BOT_TOKEN=${token}\n`);
});

test("tokenStatus checks file presence without reading the token file", () => {
  const calls = [];
  const fakeFs = {
    existsSync(filePath) {
      calls.push(["existsSync", filePath]);
      return true;
    },
    statSync(filePath) {
      calls.push(["statSync", filePath]);
      return { mtimeMs: 1234 };
    },
    readFileSync() {
      calls.push(["readFileSync"]);
      throw new Error("should not read token file");
    },
  };
  const status = settings.tokenStatus({
    fs: fakeFs,
    filePath: "C:\\Users\\me\\AppData\\Roaming\\Clawd on Desk\\telegram-approval.env",
  });
  assert.deepEqual(status, {
    tokenConfigured: true,
    tokenStored: true,
    tokenFileMtimeMs: 1234,
  });
  assert.deepEqual(calls, [
    ["existsSync", "C:\\Users\\me\\AppData\\Roaming\\Clawd on Desk\\telegram-approval.env"],
    ["statSync", "C:\\Users\\me\\AppData\\Roaming\\Clawd on Desk\\telegram-approval.env"],
  ]);
});

test("tokenStatus ignores process.env.CLAWD_TG_BOT_TOKEN — file is the only signal", () => {
  // Old behaviour: env-exported token would flip tokenConfigured=true without
  // any file on disk. New behaviour: the env value is ignored so the bot token
  // never has a route into Clawd's main process.
  const fakeFs = { existsSync: () => false, statSync: () => ({ mtimeMs: 0 }) };
  const status = settings.tokenStatus({
    fs: fakeFs,
    filePath: "/nonexistent/telegram-approval.env",
    env: { CLAWD_TG_BOT_TOKEN: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi" },
  });
  assert.equal(status.tokenConfigured, false);
  assert.equal(status.tokenStored, false);
  assert.equal(Object.prototype.hasOwnProperty.call(status, "envTokenConfigured"), false);
});

test("redactionSecretsForTelegramApproval includes whole session key and numeric parts", () => {
  assert.deepEqual(settings.redactionSecretsForTelegramApproval({
    enabled: true,
    allowedTgUserId: "123456789",
    targetSessionKey: "telegram:-100987654321:55",
  }), [
    "123456789",
    "telegram:-100987654321:55",
    "-100987654321",
    "55",
  ]);
});

test("invariant: Clawd source never reads process.env.CLAWD_TG_BOT_TOKEN", () => {
  // The bot token is only allowed to live at userData/telegram-approval.env on
  // disk. Any code that reads process.env.CLAWD_TG_BOT_TOKEN pulls the token
  // string into Clawd's main process, defeating that invariant. This grep
  // test fails loudly if a future refactor re-introduces the read.
  //
  // Note: the literal string "CLAWD_TG_BOT_TOKEN" is allowed to appear in
  // src/telegram-approval-settings.js (it writes that key into the env-file
  // content for the sidecar to read) and in src/telegram-approval-sidecar.js
  // (handshake constants and child env stripping). What's forbidden is
  // process.env access to that specific name in Clawd's own code.
  const sourceFiles = [
    path.join(__dirname, "..", "src", "main.js"),
    path.join(__dirname, "..", "src", "telegram-approval-sidecar.js"),
    path.join(__dirname, "..", "src", "telegram-approval-settings.js"),
  ];
  const offenders = [];
  const needle = "process.env.CLAWD_TG_BOT_TOKEN";
  for (const file of sourceFiles) {
    const text = fs.readFileSync(file, "utf8");
    if (text.includes(needle)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `forbidden read of ${needle} in: ${offenders.join(", ")}`);
});
