"use strict";

const fs = require("fs");
const path = require("path");

function isAbsoluteAnyPlatform(entry) {
  const normalized = String(entry || "").replace(/\\/g, "/");
  return path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized);
}

function validateOpenClawEntry(entry, options = {}) {
  const fsImpl = options.fs || fs;
  if (typeof entry !== "string" || !isAbsoluteAnyPlatform(entry)) {
    return { ok: false, reason: "not-absolute" };
  }

  let stat;
  try {
    stat = fsImpl.statSync(entry);
  } catch {
    return { ok: false, reason: "directory-missing" };
  }

  if (!stat || typeof stat.isDirectory !== "function" || !stat.isDirectory()) {
    return { ok: false, reason: "not-a-directory" };
  }

  if (!fsImpl.existsSync(path.join(entry, "index.js"))) {
    return { ok: false, reason: "index-js-missing" };
  }

  const manifestPath = path.join(entry, "openclaw.plugin.json");
  if (!fsImpl.existsSync(manifestPath)) {
    return { ok: false, reason: "manifest-missing" };
  }

  let manifest;
  try {
    manifest = JSON.parse(fsImpl.readFileSync(manifestPath, "utf8"));
  } catch {
    return { ok: false, reason: "manifest-corrupt" };
  }

  if (!manifest || manifest.id !== "clawd-on-desk") return { ok: false, reason: "manifest-id-mismatch" };
  if (!manifest.activation || manifest.activation.onStartup !== true) {
    return { ok: false, reason: "manifest-missing-on-startup" };
  }
  if (!manifest.configSchema || manifest.configSchema.type !== "object") {
    return { ok: false, reason: "manifest-missing-config-schema" };
  }
  return { ok: true };
}

module.exports = { validateOpenClawEntry };
