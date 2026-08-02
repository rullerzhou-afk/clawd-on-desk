"use strict";

const { STATES, TEST_ORIGINS } = require("./telegram-migration-state");

const SIGNATURES = Object.freeze({
  LEGACY: "legacy-migration",
  NATIVE: "native-reverify",
});

function classifyRequiredNudge(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  if (![STATES.NATIVE_MIGRATION_REQUIRED, STATES.NEEDS_SETUP].includes(snapshot.state)) {
    return null;
  }
  const legacy = snapshot.testOrigin === TEST_ORIGINS.LEGACY
    || snapshot.transport === "legacy";
  return legacy
    ? { kind: "legacy", signature: SIGNATURES.LEGACY }
    : { kind: "native", signature: SIGNATURES.NATIVE };
}

function decideTelegramMigrationNudge(snapshot, previousSignature = "") {
  const previous = typeof previousSignature === "string" ? previousSignature : "";
  if (snapshot && [STATES.IDLE, STATES.NATIVE_ACTIVE].includes(snapshot.state)) {
    return {
      shouldNotify: false,
      shouldPersist: previous !== "",
      nextSignature: "",
      kind: null,
    };
  }
  if (snapshot && snapshot.state === STATES.TESTING_NATIVE) {
    return {
      shouldNotify: false,
      shouldPersist: false,
      nextSignature: previous,
      kind: null,
    };
  }
  const required = classifyRequiredNudge(snapshot);
  if (!required) {
    return {
      shouldNotify: false,
      shouldPersist: false,
      nextSignature: previous,
      kind: null,
    };
  }
  return {
    shouldNotify: previous !== required.signature,
    shouldPersist: false,
    nextSignature: required.signature,
    kind: required.kind,
  };
}

function createTelegramMigrationNudge(options = {}) {
  const getSnapshot = options.getSnapshot || (() => null);
  const getLastSignature = options.getLastSignature || (() => "");
  const setLastSignature = options.setLastSignature || (() => undefined);
  const showNotification = options.showNotification || (() => false);
  const openSettings = options.openSettings || (() => undefined);

  async function sync({ allowNotify = false } = {}) {
    const previous = getLastSignature() || "";
    const decision = decideTelegramMigrationNudge(getSnapshot(), previous);
    if (decision.shouldPersist) {
      await setLastSignature(decision.nextSignature);
      return { ...decision, notified: false };
    }
    if (!allowNotify || !decision.shouldNotify) {
      return { ...decision, notified: false };
    }
    const delivered = showNotification({
      kind: decision.kind,
      onClick: openSettings,
    }) !== false;
    if (delivered) await setLastSignature(decision.nextSignature);
    return { ...decision, notified: delivered };
  }

  return { sync };
}

module.exports = {
  SIGNATURES,
  classifyRequiredNudge,
  decideTelegramMigrationNudge,
  createTelegramMigrationNudge,
};
