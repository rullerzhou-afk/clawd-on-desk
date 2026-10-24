"use strict";
const path = require("node:path");
const DEFAULTS = Object.freeze({
  qqmusicEnabled: false,
  qqmusicExecutable: "",
  qqmusicPanelSize: null,
  cockpitCheckinEnabled: false,
  cockpitDataRoot: "",
  questionsEnabled: false,
  gatewayEnabled: false,
  gatewayExecutable: "",
  gatewayPort: 7863,
  apps: [],
});
const PATH_KEYS = ["qqmusicExecutable", "cockpitDataRoot", "gatewayExecutable"];
const FLAGS = [
  "qqmusicEnabled",
  "cockpitCheckinEnabled",
  "questionsEnabled",
  "gatewayEnabled",
];
const plain = (value) =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function validPath(value) {
  return (
    typeof value === "string" &&
    value.length <= 4096 &&
    !/[\x00-\x1f]/.test(value) &&
    (value === "" || path.isAbsolute(value))
  );
}
function validateDesktopIntegrations(value) {
  const error = (message) => ({ status: "error", message });
  if (
    !plain(value) ||
    Object.keys(value).some((key) => !Object.hasOwn(DEFAULTS, key))
  )
    return error("Invalid desktop integration settings");
  for (const key of FLAGS)
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      return error(`${key} must be boolean`);
  for (const key of PATH_KEYS)
    if (value[key] !== undefined && !validPath(value[key]))
      return error(`${key} must be empty or an absolute path`);
  if (
    value.qqmusicPanelSize != null &&
    (!plain(value.qqmusicPanelSize) ||
      Object.keys(value.qqmusicPanelSize).some(
        (key) => !["width", "height"].includes(key),
      ) ||
      !Number.isInteger(value.qqmusicPanelSize.width) ||
      value.qqmusicPanelSize.width < 320 ||
      value.qqmusicPanelSize.width > 10000 ||
      !Number.isInteger(value.qqmusicPanelSize.height) ||
      value.qqmusicPanelSize.height < 380 ||
      value.qqmusicPanelSize.height > 10000)
  )
    return error("Invalid QQ Music panel size");
  if (
    value.gatewayPort !== undefined &&
    (!Number.isInteger(value.gatewayPort) ||
      value.gatewayPort < 1 ||
      value.gatewayPort > 65535)
  )
    return error("Invalid gateway port");
  if (value.apps !== undefined) {
    if (!Array.isArray(value.apps) || value.apps.length > 20)
      return error("At most 20 desktop applications are supported");
    const ids = new Set();
    for (const item of value.apps) {
      if (
        !plain(item) ||
        Object.keys(item).some(
          (key) => !["id", "name", "executable"].includes(key),
        ) ||
        !/^[a-z][a-z0-9-]{0,39}$/.test(item.id) ||
        ids.has(item.id) ||
        typeof item.name !== "string" ||
        !item.name.trim() ||
        item.name.length > 60 ||
        /[\x00-\x1f]/.test(item.name) ||
        !validPath(item.executable) ||
        !item.executable
      )
        return error("Invalid desktop application");
      ids.add(item.id);
    }
  }
  return { status: "ok" };
}
function normalizeDesktopIntegrations(value) {
  if (validateDesktopIntegrations(value).status !== "ok")
    return { ...DEFAULTS, apps: [] };
  return {
    ...DEFAULTS,
    ...value,
    apps: (value.apps || []).map((item) => ({ ...item })),
  };
}
module.exports = {
  DEFAULTS,
  validateDesktopIntegrations,
  normalizeDesktopIntegrations,
};
