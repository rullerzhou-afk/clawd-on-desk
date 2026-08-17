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
