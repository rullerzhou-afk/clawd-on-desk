"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const MAIN_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "main.js"),
  "utf8",
);

test("Telegram identity is seeded before controller init can yield", () => {
  const start = MAIN_SOURCE.indexOf("async function initTelegramMigrationController()");
  const end = MAIN_SOURCE.indexOf("\n// In-process IPC bridge", start);
  assert.ok(start >= 0 && end > start, "initTelegramMigrationController should exist");
  const source = MAIN_SOURCE.slice(start, end);

  const seedText = "telegramApprovalIdentitySignature = buildTelegramApprovalIdentitySignature(";
  const firstSeed = source.indexOf(seedText);
  const controllerPublish = source.indexOf(
    "_telegramMigrationController = createTelegramMigrationController({",
  );
  const initAwait = source.indexOf("await _telegramMigrationController.init();");
  const finalSeed = source.lastIndexOf(seedText);

  assert.ok(firstSeed >= 0, "identity should be seeded before controller publication");
  assert.ok(firstSeed < controllerPublish, "the first Settings edit must not hit an empty identity baseline");
  assert.ok(controllerPublish < initAwait, "controller init should run after publication");
  assert.ok(initAwait < finalSeed, "identity should be re-read after async initialization");
});

test("Telegram recipient identity includes both approval and delivery targets", () => {
  const start = MAIN_SOURCE.indexOf("function buildTelegramApprovalIdentitySignature(config)");
  const end = MAIN_SOURCE.indexOf("\nasync function applySettingsUpdateOrThrow", start);
  assert.ok(start >= 0 && end > start, "identity signature helper should exist");
  const source = MAIN_SOURCE.slice(start, end);

  assert.match(source, /allowedTgUserId:\s*normalized\.allowedTgUserId/);
  assert.match(source, /targetSessionKey:\s*normalized\.targetSessionKey/);
});

test("Telegram reply mappings rotate with token and recipient identity", () => {
  assert.match(MAIN_SOURCE, /invalidateTelegramDirectSendMappings\("token_changed"\)/);
  assert.match(MAIN_SOURCE, /invalidateTelegramDirectSendMappings\("recipient_changed"\)/);
  assert.match(
    MAIN_SOURCE,
    /invalidateTelegramDirectSendMappings\("direct_send_toggle_changed",\s*\{\s*notificationRouteChanged:\s*false,?\s*\}\)/,
  );
  assert.match(MAIN_SOURCE, /getNotificationContext:\s*\(entry\)[\s\S]*createCompletionNotificationContext\(entry\)/);
  assert.match(
    MAIN_SOURCE,
    /isNotificationRouteCurrent:\s*\(context\)[\s\S]*isCompletionNotificationRouteCurrent\(context\)/,
  );
  assert.match(MAIN_SOURCE, /notificationContext,\s*\n\s*\}\);/);
});

test("Telegram completion sends use route-only validation while mapping registration stays strict", () => {
  const companionStart = MAIN_SOURCE.indexOf("telegramCompanion = createTelegramCompanion({");
  const companionEnd = MAIN_SOURCE.indexOf("\n  // Seed before publishing the controller", companionStart);
  assert.ok(companionStart >= 0 && companionEnd > companionStart, "Telegram companion wiring should exist");
  const companionSource = MAIN_SOURCE.slice(companionStart, companionEnd);
  assert.match(companionSource, /isCompletionNotificationRouteCurrent\(context\)/);
  assert.doesNotMatch(companionSource, /isCompletionNotificationContextCurrent\(context\)/);
  assert.match(companionSource, /registerCompletionNotification\(\{/);
});

test("Telegram completion mappings capture the live agent PID outside the snapshot contract", () => {
  const start = MAIN_SOURCE.indexOf("onNotificationSent: ({ entry, messageId, chatId, notificationContext })");
  const end = MAIN_SOURCE.indexOf("\n    log: telegramApprovalLog", start);
  assert.ok(start >= 0 && end > start, "Telegram notification callback should exist");
  const source = MAIN_SOURCE.slice(start, end);
  assert.match(source, /sessions\.get\(String\(entry\.id\)\)/);
  assert.match(source, /agentPid:\s*runtimeEntry\s*&&\s*runtimeEntry\.agentPid/);
});

test("Telegram polling offset resets only when the bot token identity changes", () => {
  const tokenWriteStart = MAIN_SOURCE.indexOf("function writeTelegramApprovalToken(token)");
  const tokenWriteEnd = MAIN_SOURCE.indexOf("\nasync function initTelegramMigrationController()", tokenWriteStart);
  const tokenWriteSource = MAIN_SOURCE.slice(tokenWriteStart, tokenWriteEnd);
  assert.match(tokenWriteSource, /if \(identityChanged\)[\s\S]*telegramNativeRunner\.resetOffset\(\)/);

  const recipientStart = MAIN_SOURCE.indexOf('_settingsController.subscribeKey("tgApproval"');
  const recipientEnd = MAIN_SOURCE.indexOf('_settingsController.subscribeKey("discordPresence"', recipientStart);
  const recipientSource = MAIN_SOURCE.slice(recipientStart, recipientEnd);
  assert.doesNotMatch(recipientSource, /resetOffset/);
});
