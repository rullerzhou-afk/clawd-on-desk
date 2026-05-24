"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SIDECAR_ROOT = path.join("bin", "cc-connect-clawd");
const VERIFY_COMMAND = "node scripts/verify-sidecar-binaries.js";

const BUILD_REQUIREMENTS = Object.freeze({
  build: [
    ["windows", "x64"],
    ["windows", "arm64"],
  ],
  "build:win:x64": [
    ["windows", "x64"],
  ],
  "build:win:arm64": [
    ["windows", "arm64"],
  ],
  "build:win:all": [
    ["windows", "x64"],
    ["windows", "arm64"],
  ],
  "build:mac": [
    ["darwin", "x64"],
    ["darwin", "arm64"],
  ],
  "build:linux": [
    ["linux", "x64"],
  ],
  "build:all": [
    ["windows", "x64"],
    ["windows", "arm64"],
    ["darwin", "x64"],
    ["darwin", "arm64"],
    ["linux", "x64"],
  ],
});

function normalizeLifecycleEvent(value) {
  const event = String(value || "").trim();
  if (event.startsWith("prebuild")) return event.slice(3);
  return event;
}

function executableName(platform) {
  return platform === "windows" ? "cc-connect-clawd.exe" : "cc-connect-clawd";
}

function sidecarBinaryPath(rootDir, platform, arch) {
  return path.join(rootDir, SIDECAR_ROOT, `${platform}-${arch}`, executableName(platform));
}

function getRequiredSidecarsForLifecycle(event) {
  const normalized = normalizeLifecycleEvent(event);
  return (BUILD_REQUIREMENTS[normalized] || []).map(([platform, arch]) => ({ platform, arch }));
}

function isExistingFile(fsModule, filePath) {
  try {
    if (!fsModule.existsSync(filePath)) return false;
    if (typeof fsModule.statSync !== "function") return true;
    const stat = fsModule.statSync(filePath);
    return !stat || typeof stat.isFile !== "function" || stat.isFile();
  } catch {
    return false;
  }
}

function verifySidecarBinaries(options = {}) {
  const rootDir = options.rootDir || path.join(__dirname, "..");
  const lifecycleEvent = options.lifecycleEvent || process.env.npm_lifecycle_event || "";
  const fsModule = options.fs || fs;
  const required = getRequiredSidecarsForLifecycle(lifecycleEvent);
  const missing = [];
  for (const item of required) {
    const filePath = sidecarBinaryPath(rootDir, item.platform, item.arch);
    if (!isExistingFile(fsModule, filePath)) missing.push({ ...item, path: filePath });
  }
  return {
    ok: missing.length === 0,
    lifecycleEvent: normalizeLifecycleEvent(lifecycleEvent),
    required,
    missing,
  };
}

function main() {
  const lifecycleEvent = process.argv[2] || process.env.npm_lifecycle_event || "";
  const result = verifySidecarBinaries({ lifecycleEvent });
  if (result.required.length === 0) return;
  if (result.ok) {
    console.log(`Verified ${result.required.length} cc-connect-clawd sidecar binary/binaries.`);
    return;
  }
  console.error("Missing cc-connect-clawd sidecar binary/binaries for this build:");
  for (const item of result.missing) {
    console.error(`- ${item.platform}-${item.arch}: ${item.path}`);
  }
  console.error("");
  console.error("Build the Go sidecar first, or set CLAWD_CC_CONNECT_CLAWD_PATH for development runs.");
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  VERIFY_COMMAND,
  BUILD_REQUIREMENTS,
  normalizeLifecycleEvent,
  executableName,
  sidecarBinaryPath,
  getRequiredSidecarsForLifecycle,
  verifySidecarBinaries,
};
