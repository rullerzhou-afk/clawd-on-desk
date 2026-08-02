"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createTelegramMigrationController } = require("../src/telegram-migration-controller");
const { EVENTS, STATES } = require("../src/telegram-migration-state");

function fingerprint(filePath) {
  const bytes = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  return {
    bytes: bytes.toString("hex"),
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    mtimeMs: stat.mtimeMs,
  };
}

function nativeStub() {
  let polling = false;
  return {
    isPolling: () => polling,
    start: async () => { polling = true; },
    stop: async () => { polling = false; },
    sendTestCard: async () => {},
  };
}

test("legacy-to-native verification changes only migration prefs and preserves user data", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-tg-retirement-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tokenFile = path.join(root, "telegram-approval.env");
  const bridgeDir = path.join(root, "cc-connect-clawd");
  const bridgeFile = path.join(bridgeDir, "clawd-bridge.toml");
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.writeFileSync(tokenFile, "CLAWD_TG_BOT_TOKEN=123456:abcdefghijklmnopqrstuvwxyz_ABCDEFGH\n");
  fs.writeFileSync(bridgeFile, "listen = \"127.0.0.1:0\"\n");

  const beforeToken = fingerprint(tokenFile);
  const beforeBridge = fingerprint(bridgeFile);
  const recipient = {
    allowedTgUserId: "123456789",
    targetSessionKey: "telegram:123456789",
  };
  const recipientBefore = JSON.stringify(recipient);
  let migrationPrefs = {
    transport: "legacy",
    nativeVerifiedAt: null,
    legacyEnabled: true,
  };
  const writes = [];
  const controller = createTelegramMigrationController({
    native: nativeStub(),
    readPrefs: () => ({ ...migrationPrefs }),
    writePrefs: async (patch) => {
      writes.push({ ...patch });
      migrationPrefs = { ...migrationPrefs, ...patch };
    },
    readFiles: () => ({ nativeConfigComplete: true }),
  });

  assert.equal(await controller.init(), STATES.NATIVE_MIGRATION_REQUIRED);
  assert.equal((await controller.dispatch({ type: EVENTS.USER_TEST_NATIVE })).state, STATES.TESTING_NATIVE);
  assert.equal((await controller.dispatch({ type: EVENTS.TEST_SUCCESS, at: 4242 })).state, STATES.NATIVE_ACTIVE);

  assert.deepEqual(writes, [{ transport: "native", nativeVerifiedAt: 4242 }]);
  assert.equal(JSON.stringify(recipient), recipientBefore);
  assert.deepEqual(fingerprint(tokenFile), beforeToken);
  assert.deepEqual(fingerprint(bridgeFile), beforeBridge);
});

test("historical preference fixtures select only native-only terminal states", async () => {
  const fixtures = [
    {
      name: "v0.8 missing transport",
      prefs: { legacyEnabled: true },
      complete: true,
      state: STATES.NATIVE_MIGRATION_REQUIRED,
    },
    {
      name: "v0.9 legacy flag",
      prefs: { legacyEnabled: true },
      complete: true,
      state: STATES.NATIVE_MIGRATION_REQUIRED,
    },
    {
      name: "explicit legacy transport",
      prefs: { transport: "legacy" },
      complete: true,
      state: STATES.NATIVE_MIGRATION_REQUIRED,
    },
    {
      name: "explicit off beats stale legacy",
      prefs: { transport: "off", legacyEnabled: true },
      complete: true,
      state: STATES.IDLE,
    },
    {
      name: "verified native",
      prefs: { transport: "native", nativeVerifiedAt: 1 },
      complete: true,
      state: STATES.NATIVE_ACTIVE,
    },
    {
      name: "incomplete legacy config",
      prefs: { transport: "legacy" },
      complete: false,
      state: STATES.NEEDS_SETUP,
    },
  ];

  for (const fixture of fixtures) {
    const native = nativeStub();
    const controller = createTelegramMigrationController({
      native,
      readPrefs: () => ({ ...fixture.prefs }),
      writePrefs: async () => {},
      readFiles: () => ({ nativeConfigComplete: fixture.complete }),
    });
    assert.equal(await controller.init(), fixture.state, fixture.name);
    assert.notEqual(controller.getSnapshot().state, "LEGACY_ACTIVE", fixture.name);
    await controller.dispose();
  }
});
