"use strict";

const DEFAULT_HARDWARE_BUDDY_SETTINGS = Object.freeze({
  enabled: false,
  backend: "bleak",
  address: "",
  namePrefix: "Clawstick",
  permissionsEnabled: false,
  quickCommandsEnabled: false,
});

const HARDWARE_BUDDY_BACKENDS = Object.freeze(["bleak", "fake"]);

function isPlainObject(value) {
  return !!(value && typeof value === "object" && !Array.isArray(value));
}

function cleanString(value, maxLength = 120) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength);
}

function normalizeHardwareBuddySettings(value, defaults = DEFAULT_HARDWARE_BUDDY_SETTINGS) {
  const input = isPlainObject(value) ? value : {};
  const backend = HARDWARE_BUDDY_BACKENDS.includes(input.backend) ? input.backend : defaults.backend;
  return {
    enabled: input.enabled === true,
    backend,
    address: cleanString(input.address, 120),
    namePrefix: cleanString(input.namePrefix, 40) || defaults.namePrefix,
    permissionsEnabled: input.permissionsEnabled === true,
    quickCommandsEnabled: input.quickCommandsEnabled === true,
  };
}

function validateHardwareBuddySettings(value) {
  if (!isPlainObject(value)) {
    return { status: "error", message: "hardwareBuddy must be an object" };
  }
  if (typeof value.enabled !== "boolean") {
    return { status: "error", message: "hardwareBuddy.enabled must be a boolean" };
  }
  if (!HARDWARE_BUDDY_BACKENDS.includes(value.backend)) {
    return { status: "error", message: "hardwareBuddy.backend must be bleak or fake" };
  }
  if (typeof value.address !== "string" || value.address.length > 120 || /[\u0000-\u001f\u007f]/.test(value.address)) {
    return { status: "error", message: "hardwareBuddy.address must be a short string without control characters" };
  }
  if (typeof value.namePrefix !== "string" || value.namePrefix.length > 40 || !value.namePrefix.trim()
    || /[\u0000-\u001f\u007f]/.test(value.namePrefix)) {
    return { status: "error", message: "hardwareBuddy.namePrefix must be a non-empty short string" };
  }
  if (typeof value.permissionsEnabled !== "boolean") {
    return { status: "error", message: "hardwareBuddy.permissionsEnabled must be a boolean" };
  }
  if (typeof value.quickCommandsEnabled !== "boolean") {
    return { status: "error", message: "hardwareBuddy.quickCommandsEnabled must be a boolean" };
  }
  return { status: "ok" };
}

function hardwareBuddySettingsEqual(a, b) {
  const left = normalizeHardwareBuddySettings(a);
  const right = normalizeHardwareBuddySettings(b);
  return left.enabled === right.enabled
    && left.backend === right.backend
    && left.address === right.address
    && left.namePrefix === right.namePrefix
    && left.permissionsEnabled === right.permissionsEnabled
    && left.quickCommandsEnabled === right.quickCommandsEnabled;
}

module.exports = {
  DEFAULT_HARDWARE_BUDDY_SETTINGS,
  HARDWARE_BUDDY_BACKENDS,
  normalizeHardwareBuddySettings,
  validateHardwareBuddySettings,
  hardwareBuddySettingsEqual,
};
